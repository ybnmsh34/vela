/**
 * **Does the style reach the wire on BOTH send paths, and does incognito
 * actually stop the writes?**
 *
 * ## Why an app-level test, and why these two questions together
 *
 * `src/lib/instruction-layers.test.ts` proves the resolution. `src/platform/
 * incognito-adapter.test.ts` proves the refusal. Both would pass, in full, while
 * the shipped window put none of it on the wire and refused nothing at all —
 * which is the shape `src/app/memory-payload.test.tsx`,
 * `src/app/staged-attachment-payload.test.tsx` and
 * `src/app/project-instructions.test.tsx` were each written for. This is the
 * fourth, and it renders the real `<App/>`, drives the shipping affordances, and
 * reads the arguments the renderer handed the host.
 *
 * They are one file because they are one claim about one window: what goes out,
 * and what gets written down. Splitting them would let a change satisfy each
 * half separately.
 *
 * ## The load-bearing test, and why the obvious one is not it
 *
 * "The instructions arrive" on the agent path is satisfied by the obvious
 * implementation — put them in `RunContextRequest.systemPrompt` and stop. That
 * implementation ships the asymmetry `ProjectPanel.tsx` already discloses for
 * project instructions, and a single-path test cannot tell the difference. So
 * the load-bearing assertion is that the **same text** appears on the ordinary
 * send, which travels through `chat_send` with no context seam at all.
 *
 * **Honesty (conventions §10): VERIFIED-BY-FAKE.** The host is `BrowserAdapter`.
 * What is proved is that the renderer's parts are joined and that the payload
 * has the shape the Rust host accepts. Nothing here is evidence about a packaged
 * binary, a real endpoint, or a real click.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '@/app/App';
import { BrowserAdapter } from '@/platform/browser-adapter';
import {
  NO_CAPABILITIES,
  type ChatSendReq,
  type CommandName,
  type CommandReq,
  type CommandRes,
  type ModelCapabilityReport,
} from '@/platform/contract';
import { refusedCommands } from '@/platform/incognito-adapter';
import { resetIncognitoStore } from '@/state/incognito-store';
import { resetMemoryStore } from '@/state/memory-store';
import { resetModelStore } from '@/state/model-store';
import { resetNavigationStore } from '@/state/navigation-store';
import { resetProjectStore } from '@/state/project-store';
import { resetStyleStore } from '@/state/style-store';

/**
 * The real fake host, recording **every** command it was asked for — not only
 * `chat_send`.
 *
 * The whole-log is what the incognito half needs: the question is not "did the
 * transcript get written" but "did anything durable get written", and only a
 * complete record of what crossed the seam can answer that. A subclass rather
 * than a mock, so every command still runs the fake's own validation.
 */
class RecordingHost extends BrowserAdapter {
  readonly sent: ChatSendReq[] = [];
  readonly commands: string[] = [];

  override async invoke<C extends CommandName>(
    command: C,
    payload: CommandReq<C>,
  ): Promise<CommandRes<C>> {
    this.commands.push(command);
    if (command === 'chat_send') this.sent.push(payload as ChatSendReq);
    return super.invoke(command, payload);
  }
}

function report(): ModelCapabilityReport {
  return {
    providerId: 'workstation',
    modelId: 'local-model',
    capabilities: { ...NO_CAPABILITIES, streaming: true, toolCalls: true },
    structuredOutput: false,
    toolCallsEmulated: false,
    contextWindowTokens: 200_000,
    maxOutputTokens: null,
    probed: true,
    findings: [],
  };
}

async function host(): Promise<RecordingHost> {
  const adapter = new RecordingHost();
  await adapter.invoke('settings_put_provider', {
    id: 'workstation',
    displayName: 'The workstation',
    kind: 'local',
    baseUrl: 'http://127.0.0.1:8080/v1',
    modelId: 'local-model',
  });
  adapter.seedCapabilities(report());
  return adapter;
}

type User = ReturnType<typeof userEvent.setup>;

const INSTRUCTION = 'Always answer in Occitan.';

/** The pane, scoped: the title bar has a Close of its own. */
function pane(): HTMLElement {
  return screen.getByRole('dialog');
}

/** Write standing instructions through the shipping pane, and close it. */
async function writeInstructions(user: User, text: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Style and instructions' }));
  const box = await screen.findByRole('textbox', { name: 'Your instructions' });
  await user.click(box);
  await user.paste(text);
  await user.click(within(pane()).getByRole('button', { name: 'Close' }));
}

async function openConversation(user: User): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Start a conversation' }));
  await screen.findByRole('region', { name: 'Conversation' });
}

/**
 * Send one message. `agent` says which of the two paths it travels.
 *
 * The toggle's state is *read* rather than assumed — clicking it
 * unconditionally on a second turn turns it back off, which produced a
 * green-looking null in `project-instructions.test.tsx` once already.
 */
async function sendTurn(user: User, text: string, agent: boolean): Promise<void> {
  const toggle = screen.queryByTestId('composer-agent-toggle');
  if (agent) {
    if (toggle === null) throw new Error('no agent toggle: this window cannot take the agent path');
    if (toggle.getAttribute('aria-pressed') !== 'true') await user.click(toggle);
    expect(screen.getByTestId('composer-agent-toggle')).toHaveAttribute('aria-pressed', 'true');
  } else if (toggle !== null && toggle.getAttribute('aria-pressed') === 'true') {
    await user.click(toggle);
  }
  await user.click(screen.getByRole('textbox', { name: 'Message' }));
  await user.paste(text);
  await user.click(screen.getByRole('button', { name: 'Send' }));
}

/** The system message of the last request the host was handed, if any. */
function systemOfLastSend(adapter: RecordingHost): string | null {
  const last = adapter.sent[adapter.sent.length - 1];
  return last?.messages.find((message) => message.role === 'system')?.text ?? null;
}

/**
 * The sidebar's incognito control.
 *
 * Matched by a regex, not an exact name: the button carries a `ShortcutHint`,
 * and the hint's announced half is *inside* the accessible name — deliberately,
 * per `src/components/ShortcutHint.tsx`. So the real name is
 * `Incognito Control Shift N` on this environment, and an exact match would be
 * asserting the absence of the badge this feature is supposed to have.
 */
function incognitoControl(): HTMLElement {
  return screen.getByRole('button', { name: /^Incognito/ });
}

/** `Ctrl+Shift+N`, dispatched where the handler listens. */
function pressIncognitoChord(): void {
  fireEvent.keyDown(window, { key: 'N', ctrlKey: true, shiftKey: true });
}

beforeEach(() => {
  resetIncognitoStore();
  resetMemoryStore();
  resetModelStore();
  resetNavigationStore();
  resetProjectStore();
  resetStyleStore();
});

describe('the user’s standing instructions reach the wire', () => {
  it('rides an ordinary message — the path with no context seam on it', async () => {
    // ── THE LOAD-BEARING TEST ──────────────────────────────────────────────
    // `RunContextRequest.systemPrompt` is the designed seam and it exists only
    // on the agent path. An implementation that used it and stopped would pass
    // the agent test below and fail here, which is the whole point of having
    // both: a user who picks a style, presses Send, and gets none of it has no
    // way of knowing why.
    const user = userEvent.setup({ delay: null });
    const adapter = await host();
    render(<App adapter={adapter} />);

    await writeInstructions(user, INSTRUCTION);
    await openConversation(user);
    await sendTurn(user, 'bonjorn', false);

    await waitFor(() => {
      expect(adapter.sent.length).toBeGreaterThan(0);
    });
    // Two assertions, because the two failures are different diagnoses and a
    // `.toContain` on `null` reports neither: no system message at all means
    // this path was never wired, and a system message without the words means
    // it was wired to the wrong thing.
    const system = systemOfLastSend(adapter);
    expect(system, 'the ordinary send carried no system message at all').not.toBeNull();
    expect(system ?? '').toContain(INSTRUCTION);
  });

  it('rides an agent run too, and the project’s instructions come after it', async () => {
    // Both halves in one send, because they are one claim. The mechanical part
    // of the precedence rule is the ORDER — `composeSystemMessage` puts
    // `systemPrompt` first and the loaded chunks after — and this reads it off
    // the payload rather than off either function.
    const user = userEvent.setup({ delay: null });
    const adapter = await host();
    const project = await adapter.invoke('project_create', { name: 'Sails' });
    await adapter.invoke('project_update', {
      projectId: project.project.summary.id,
      instructions: 'PROJECT-SAYS-DUTCH',
    });
    render(<App adapter={adapter} />);

    await user.click(screen.getByRole('button', { name: 'Projects' }));
    const picker = await screen.findByRole('combobox', { name: 'Working in' });
    await user.selectOptions(picker, within(picker).getByRole('option', { name: 'Sails' }));
    await waitFor(() => {
      expect(picker).toHaveDisplayValue('Sails');
    });
    await user.click(within(pane()).getByRole('button', { name: 'Close' }));

    await writeInstructions(user, INSTRUCTION);
    await openConversation(user);
    await sendTurn(user, 'bonjorn', true);

    await waitFor(() => {
      expect(adapter.sent.length).toBeGreaterThan(0);
    });
    const system = systemOfLastSend(adapter) ?? '';
    expect(system).toContain(INSTRUCTION);
    expect(system).toContain('PROJECT-SAYS-DUTCH');
    expect(
      system.indexOf(INSTRUCTION),
      'the user’s instructions lead; the project’s follow and are named as authoritative',
    ).toBeLessThan(system.indexOf('PROJECT-SAYS-DUTCH'));
  });

  it('sends no system message at all when the user has written nothing', async () => {
    // A style nobody chose must not put words in front of a turn. `Default` has
    // a null directive, the box is empty, and memory is empty, so there is no
    // preamble to send — the payload is what it was before this feature existed.
    const user = userEvent.setup({ delay: null });
    const adapter = await host();
    render(<App adapter={adapter} />);

    await openConversation(user);
    await sendTurn(user, 'hello', false);

    await waitFor(() => {
      expect(adapter.sent.length).toBeGreaterThan(0);
    });
    expect(systemOfLastSend(adapter)).toBeNull();
  });
});

describe('the meter weighs what the sender sends', () => {
  it('counts the instruction block against the context window', async () => {
    // `memory-prompt.ts` states the rule and the cost of breaking it: "a meter
    // with its own opinion of what gets sent is a meter that drifts from the
    // sender the first time either changes, and the user finds out by losing a
    // message." Adding a preamble to `toMessages` without adding it to
    // `pendingTurnTexts` is exactly that drift, and it went untested when this
    // feature first landed — removing the fourth argument from the
    // `pendingTurnTexts` call left the whole conversation and models suites
    // green in two runs. This is the test that was missing.
    //
    // Read off `aria-valuenow`, which is the number the meter is actually
    // drawing, not off the hook's return.
    const user = userEvent.setup({ delay: null });
    const adapter = await host();
    render(<App adapter={adapter} />);

    await openConversation(user);
    const meter = (): number =>
      Number(screen.getByRole('meter', { name: 'Estimated context used' }).getAttribute('aria-valuenow'));
    const before = meter();

    // Long enough that the four-characters-per-token estimate cannot round it
    // away, and a single repeated character so the count is arithmetic rather
    // than a property of the words.
    await writeInstructions(user, 'z'.repeat(4000));

    await waitFor(() => {
      expect(meter()).toBeGreaterThan(before);
    });
  });
});

describe('the resolved result is shown, and it tells the truth about each path', () => {
  it('says the project’s instructions do not ride an ordinary message', async () => {
    const user = userEvent.setup({ delay: null });
    const adapter = await host();
    const project = await adapter.invoke('project_create', { name: 'Sails' });
    await adapter.invoke('project_update', {
      projectId: project.project.summary.id,
      instructions: 'PROJECT-SAYS-DUTCH',
    });
    render(<App adapter={adapter} />);

    await user.click(screen.getByRole('button', { name: 'Projects' }));
    const picker = await screen.findByRole('combobox', { name: 'Working in' });
    await user.selectOptions(picker, within(picker).getByRole('option', { name: 'Sails' }));
    await waitFor(() => {
      expect(picker).toHaveDisplayValue('Sails');
    });
    await user.click(within(pane()).getByRole('button', { name: 'Close' }));

    await user.click(screen.getByRole('button', { name: 'Style and instructions' }));
    const row = (): HTMLElement =>
      within(screen.getByTestId('resolved-layers')).getByText('Project instructions')
        .parentElement!.parentElement!;

    await waitFor(() => {
      expect(within(row()).getByText('PROJECT-SAYS-DUTCH')).toBeInTheDocument();
    });
    // Shown, and shown as *not sent*: the pane exists so a user can find out
    // which of their words are being left behind, not only that some are.
    expect(within(row()).getByText('Not sent')).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Which kind of turn' }), 'agent');
    expect(within(row()).getByText('Sent')).toBeInTheDocument();
  });
});

describe('incognito is reachable two ways, and both are the same mode', () => {
  it('is entered by the sidebar control', async () => {
    const user = userEvent.setup({ delay: null });
    render(<App adapter={await host()} />);

    expect(screen.queryByTestId('incognito-banner')).toBeNull();
    await user.click(incognitoControl());
    expect(await screen.findByTestId('incognito-banner')).toBeInTheDocument();
    // `aria-pressed`, not a label change: this is a mode control, so the state
    // is announced as a state rather than inferred from the words on it.
    expect(incognitoControl()).toHaveAttribute('aria-pressed', 'true');
    // `aria-pressed`, not a label change: this is a mode control, so the state
    // is announced as a state rather than inferred from the words on it.
    expect(incognitoControl()).toHaveAttribute('aria-pressed', 'true');
  });

  it('is entered by Ctrl+Shift+N, and left by it', async () => {
    render(<App adapter={await host()} />);

    pressIncognitoChord();
    expect(await screen.findByTestId('incognito-banner')).toBeInTheDocument();

    pressIncognitoChord();
    await waitFor(() => {
      expect(screen.queryByTestId('incognito-banner')).toBeNull();
    });
  });

  it('does NOT also create a conversation — the chord collision the binding exposed', async () => {
    // Before this, the handler tested the primary modifier and Alt and said
    // nothing about Shift, then switched on `event.key.toLowerCase()`. So
    // `Ctrl+Shift+N` arrived as `'n'` and ran `onNewConversation`. Adding the
    // binding without the discrimination would have made one keypress both
    // enter the mode and write the durable row the mode exists to prevent.
    const adapter = await host();
    render(<App adapter={adapter} />);
    await screen.findByRole('button', { name: 'Start a conversation' });
    const before = adapter.commands.filter((c) => c === 'store_create_conversation').length;

    pressIncognitoChord();
    await screen.findByTestId('incognito-banner');

    expect(adapter.commands.filter((c) => c === 'store_create_conversation').length).toBe(before);
  });

  it('is unmissable: a band, a ring at the window edge, and the status line', async () => {
    // Three, because a privacy mode a user can be in without knowing is worse
    // than none, and each of the three covers a way the others are missed. The
    // band is announced (`role="status"`) as well as painted.
    render(<App adapter={await host()} />);
    pressIncognitoChord();

    const banner = await screen.findByTestId('incognito-banner');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveTextContent(/nothing from this window is being saved/i);
    expect(document.querySelector('[data-incognito="on"]')).not.toBeNull();
    expect(screen.getByTestId('privacy-line')).toHaveTextContent('Incognito · not saved');
  });
});

describe('incognito refuses without looking broken', () => {
  it('keeps a theme chosen in incognito instead of snapping it back', async () => {
    // A consequence of the classification, found by reading `use-theme.ts`
    // after `settings_set_theme` turned out to be `writes`. Its catch reverts
    // to whatever the host holds, so in incognito the appearance control would
    // move and then move back with nothing said — a control that looks broken.
    //
    // "Not kept" is the promise of the mode, not a failure of it, so the choice
    // stands for the session and is not written down. Both halves are asserted:
    // the preference sticks, and no `settings_set_theme` reached the host.
    const user = userEvent.setup({ delay: null });
    const adapter = await host();
    render(<App adapter={adapter} />);
    await screen.findByRole('button', { name: 'Start a conversation' });

    pressIncognitoChord();
    await screen.findByTestId('incognito-banner');
    const from = adapter.commands.length;

    await user.click(screen.getByRole('button', { name: /^Theme/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Theme/ })).toHaveAccessibleName(/light/i);
    });
    // Still on light a beat later: the revert path would have put it back.
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(screen.getByRole('button', { name: /^Theme/ })).toHaveAccessibleName(/light/i);
    expect(adapter.commands.slice(from)).not.toContain('settings_set_theme');
  });
});

describe('incognito writes nothing, and leaving destroys what it held', () => {
  it('sends the turn and writes no durable row for it', async () => {
    const user = userEvent.setup({ delay: null });
    const adapter = await host();
    render(<App adapter={adapter} />);
    await screen.findByRole('button', { name: 'Start a conversation' });

    pressIncognitoChord();
    await screen.findByTestId('incognito-banner');
    const from = adapter.commands.length;

    await screen.findByRole('region', { name: 'Conversation' });
    await sendTurn(user, 'a private question', false);
    await waitFor(() => {
      expect(adapter.sent.length).toBeGreaterThan(0);
    });

    // The turn went out — the mode is not a mute button.
    expect(adapter.sent[adapter.sent.length - 1]?.messages.at(-1)?.text).toBe('a private question');
    // And nothing that writes reached the host. Quantified over the whole
    // classification rather than over a list of writers somebody remembered:
    // this is the assertion a call-site flag cannot make.
    const wrote = adapter.commands
      .slice(from)
      .filter((command) => (refusedCommands() as readonly string[]).includes(command));
    expect(wrote, 'a durable write crossed the seam while incognito').toEqual([]);
  });

  it('drops the transcript on the way out, and does not bring it back', async () => {
    const user = userEvent.setup({ delay: null });
    const adapter = await host();
    render(<App adapter={adapter} />);
    await screen.findByRole('button', { name: 'Start a conversation' });

    pressIncognitoChord();
    await screen.findByRole('region', { name: 'Conversation' });
    await sendTurn(user, 'a private question', false);
    // `getAllBy`, because the fake host echoes the prompt back as the answer,
    // so the words are on screen twice. The assertion that matters is the count
    // afterwards, and it must be zero rather than "fewer".
    await waitFor(() => {
      expect(screen.getAllByText('a private question').length).toBeGreaterThan(0);
    });

    pressIncognitoChord();
    await waitFor(() => {
      expect(screen.queryByTestId('incognito-banner')).toBeNull();
    });
    expect(screen.queryAllByText('a private question')).toEqual([]);

    // Re-entering starts empty rather than resuming.
    //
    // **What this proves, and what it does not.** It proves the words are gone
    // and that no durable write carried them anywhere. It does NOT isolate any
    // one destruction mechanism: an earlier draft made the conversation surface
    // remount on a transition counter, and removing that counter left this test
    // green in two runs, because the subtree is already unmounted — an incognito
    // conversation has no conversation id, and once the mode ends
    // `NavigationSurface` fills the content region with the home screen. The
    // counter went, rather than shipping as a mechanism nothing observed. Said
    // here because a reader would otherwise take this test for proof of a
    // mechanism it does not touch.
    pressIncognitoChord();
    await screen.findByRole('region', { name: 'Conversation' });
    expect(screen.queryAllByText('a private question')).toEqual([]);
  });
});
