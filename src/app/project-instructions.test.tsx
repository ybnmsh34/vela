/**
 * **Do a project's instructions reach the wire, and do two projects differ?**
 *
 * ## Why this file exists, separately from every project test there is
 *
 * `src/platform/browser-adapter-projects.test.ts` proves the project commands
 * work. `src/runtime/project-context.test.ts` proves the resolver. `src/runtime/
 * app-runtime.test.ts` proves the runtime reads `project_get`. Every one of
 * those passed, or would have, while the shipped application put none of it on
 * the wire: `app-runtime.ts` answered `null` for every project and `App.tsx`
 * passed `DEFAULT_PROJECT_ID` literally to a surface that never asked for it.
 * That is the shape `src/app/memory-payload.test.tsx` and
 * `src/app/staged-attachment-payload.test.tsx` were each written for, twice
 * over, and this is the third.
 *
 * So this renders the real `<App/>`, writes instructions through the shipping
 * pane, sends an agent turn, and reads the argument the renderer handed the
 * host. Nothing about a store row, a hook's state or a resolver's return is
 * evidence here.
 *
 * ## Two projects, because one cannot tell the difference
 *
 * With one project in the store, "the instructions arrived" is satisfied by any
 * implementation that reaches for *some* project — including the constant this
 * work removed. So the load-bearing assertion is a **difference**: a run in
 * project A carries A's words, a run in project B carries B's, and the two are
 * not the same string. That is the ambient-truth trap closed by construction
 * rather than by care.
 *
 * **Honesty (conventions §10): VERIFIED-BY-FAKE.** The host is `BrowserAdapter`,
 * whose project commands mirror `src-tauri/src/ipc/project.rs`. What is proved
 * is that the renderer's parts are joined and that the payload has the shape the
 * Rust host accepts. Nothing here is evidence about a packaged binary, a real
 * endpoint, or a real click — the last of those needs a driven window, which
 * this tree does not have.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
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
import { PlatformError } from '@/platform/errors';
import { resetMemoryStore } from '@/state/memory-store';
import { resetModelStore } from '@/state/model-store';
import { resetNavigationStore } from '@/state/navigation-store';
import { resetProjectStore } from '@/state/project-store';

/**
 * The real fake host, with two additions: it keeps the `chat_send` requests it
 * was given, and `project_get` can be made to fail on demand.
 *
 * A subclass rather than a mock — every command still runs the fake's own
 * validation — following `src/app/memory-payload.test.tsx`. The failure switch
 * is the only way to ask the question the failure direction is about, and it is
 * scoped to one command so that the project *list* still works and the window
 * still knows which project it is in.
 */
class RecordingHost extends BrowserAdapter {
  readonly sent: ChatSendReq[] = [];
  breakProjectGet = false;
  breakProjectList = false;

  override async invoke<C extends CommandName>(
    command: C,
    payload: CommandReq<C>,
  ): Promise<CommandRes<C>> {
    if (command === 'chat_send') this.sent.push(payload as ChatSendReq);
    if (command === 'project_get' && this.breakProjectGet) {
      throw new PlatformError('INTERNAL', 'the project store is on fire');
    }
    if (command === 'project_list' && this.breakProjectList) {
      throw new PlatformError('INTERNAL', 'the project store is on fire');
    }
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

/** The pane, scoped: the title bar has a Close of its own. */
function pane(): HTMLElement {
  return screen.getByRole('dialog');
}

/** Open the projects pane, make a project, give it instructions, close. */
async function writeInstructions(user: User, name: string, text: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Projects' }));
  const nameBox = await screen.findByRole('textbox', { name: 'New project' });
  await user.click(nameBox);
  await user.paste(name);
  await user.click(within(pane()).getByRole('button', { name: 'Create' }));

  // Waits for the pane to be showing *this* project: `create` selects what it
  // made, and the instructions box follows the selection.
  await waitFor(() => {
    expect(within(pane()).getByRole('combobox', { name: 'Working in' })).toHaveDisplayValue(name);
  });
  const box = within(pane()).getByRole('textbox', { name: 'Instructions for this project' });
  await waitFor(() => {
    expect(box).toBeEnabled();
  });
  await user.click(box);
  await user.paste(text);
  await user.click(within(pane()).getByRole('button', { name: 'Save instructions' }));
  await within(pane()).findByText('Saved');
  await user.click(within(pane()).getByRole('button', { name: 'Close the projects panel' }));
}

/** Switch the window to an existing project by name. */
async function switchTo(user: User, name: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Projects' }));
  const picker = await screen.findByRole('combobox', { name: 'Working in' });
  await user.selectOptions(picker, within(picker).getByRole('option', { name }));
  await waitFor(() => {
    expect(picker).toHaveDisplayValue(name);
  });
  await user.click(within(pane()).getByRole('button', { name: 'Close the projects panel' }));
}

async function openConversation(user: User): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Start a conversation' }));
  await screen.findByRole('region', { name: 'Conversation' });
}

/**
 * Send one message with the agent toggle on — the path project context is on.
 *
 * The toggle's state is *read* rather than assumed, because it survives a send:
 * clicking it unconditionally on the second turn of a test turns it back off,
 * and the send that follows is an ordinary one carrying no project context at
 * all. That mistake produced a green-looking `null` here once already.
 */
async function runAgentTurn(user: User, text: string): Promise<void> {
  const toggle = screen.getByTestId('composer-agent-toggle');
  if (toggle.getAttribute('aria-pressed') !== 'true') await user.click(toggle);
  expect(screen.getByTestId('composer-agent-toggle')).toHaveAttribute('aria-pressed', 'true');
  await user.click(screen.getByRole('textbox', { name: 'Message' }));
  await user.paste(text);
  await user.click(screen.getByRole('button', { name: 'Send' }));
}

/** The system message of the last request the host was handed, if any. */
function systemOfLastSend(adapter: RecordingHost): string | null {
  const last = adapter.sent[adapter.sent.length - 1];
  const system = last?.messages.find((message) => message.role === 'system');
  return system?.text ?? null;
}

beforeEach(() => {
  resetMemoryStore();
  resetModelStore();
  resetNavigationStore();
  resetProjectStore();
});

describe('a project’s instructions reach the payload', () => {
  it('sends what the user typed into the pane', async () => {
    // Written through the shipping affordance and read off the request the host
    // was handed. Nothing about the pane's state or the store's row is asserted:
    // all of those can be right while the words never leave the window.
    const user = userEvent.setup({ delay: null });
    const adapter = await host();
    render(<App adapter={adapter} />);

    await writeInstructions(user, 'Sails', 'always answer in French');
    await openConversation(user);
    await runAgentTurn(user, 'bonjour');

    await waitFor(() => {
      expect(adapter.sent.length).toBeGreaterThan(0);
    });
    expect(systemOfLastSend(adapter)).toBe('always answer in French');
  });

  it('sends a second project’s instructions, not the first project’s, after switching', async () => {
    // ── THE LOAD-BEARING TEST ──────────────────────────────────────────────
    // Two projects, two different sentences, one window, and the only thing
    // that changes between the two runs is which project is selected.
    //
    // This is what a single-project test cannot ask. Before this work `App.tsx`
    // passed `DEFAULT_PROJECT_ID` and `use-conversation.ts` fell through to it,
    // so *every* run in *every* project used one project's context — and with
    // one project on screen that is indistinguishable from correct behaviour.
    //
    // Both projects are seeded through the adapter rather than typed into the
    // pane, and that is a deliberate split rather than a shortcut: the pane's
    // own write is proved by the test above, and doing it twice more here made
    // this the longest test in the suite — 4.2s idle against a 5s default, which
    // is a flake waiting for a loaded machine. `fix/endpoints-timeout` measured
    // that mechanism and its conclusion was to shorten the work rather than
    // raise the timeout, since a raised timeout does not prevent the failure and
    // doubles the time a real hang takes to surface.
    const user = userEvent.setup({ delay: null });
    const adapter = await host();
    const sails = await adapter.invoke('project_create', { name: 'Sails' });
    await adapter.invoke('project_update', {
      projectId: sails.project.summary.id,
      instructions: 'always answer in French',
    });
    const rigging = await adapter.invoke('project_create', { name: 'Rigging' });
    await adapter.invoke('project_update', {
      projectId: rigging.project.summary.id,
      instructions: 'always answer in Dutch',
    });
    render(<App adapter={adapter} />);

    await openConversation(user);
    await switchTo(user, 'Sails');
    await runAgentTurn(user, 'bonjour');

    await waitFor(() => {
      expect(adapter.sent.length).toBeGreaterThan(0);
    });
    expect(systemOfLastSend(adapter)).toBe('always answer in French');

    await waitFor(() => {
      expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'false');
    });
    const afterFirst = adapter.sent.length;

    await switchTo(user, 'Rigging');
    await runAgentTurn(user, 'goedendag');

    await waitFor(() => {
      expect(adapter.sent.length).toBeGreaterThan(afterFirst);
    });
    expect(systemOfLastSend(adapter)).toBe('always answer in Dutch');
    expect(
      systemOfLastSend(adapter),
      'the window sent the first project’s instructions from inside the second',
    ).not.toBe('always answer in French');
  });

  it('sends no system message for a project whose instructions box is empty', async () => {
    // The state of a fresh install, and the reason the assertion above is about
    // a *difference*: an empty project must produce an absent message rather
    // than an empty one. `composeSystemMessage` builds nothing from nothing, and
    // the resolver indexes nothing for an empty column, so neither end invents
    // a blank instruction for the model to obey.
    const user = userEvent.setup({ delay: null });
    const adapter = await host();
    render(<App adapter={adapter} />);

    await openConversation(user);
    await runAgentTurn(user, 'hello');

    await waitFor(() => {
      expect(adapter.sent.length).toBeGreaterThan(0);
    });
    expect(systemOfLastSend(adapter)).toBeNull();
  });

  it('leaves an ordinary send without them, which is what the pane says', async () => {
    // Pinning a limitation rather than a feature. Project instructions travel on
    // `RunContextRequest.preload`, which only an agent run has; `chat_send` has
    // no context seam. `ProjectPanel.tsx`'s footnote says exactly this to the
    // user, and this test is what stops that sentence from going stale in
    // either direction.
    const user = userEvent.setup({ delay: null });
    const adapter = await host();
    render(<App adapter={adapter} />);

    await writeInstructions(user, 'Sails', 'always answer in French');
    await openConversation(user);
    await user.click(screen.getByRole('textbox', { name: 'Message' }));
    await user.paste('bonjour');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(adapter.sent.length).toBeGreaterThan(0);
    });
    expect(systemOfLastSend(adapter)).toBeNull();
  });
});

describe('a window that does not know which project it is in', () => {
  it('refuses the agent run rather than falling back to a project nobody chose', async () => {
    // The fall-through, asked at the window. `project_list` fails, so nothing
    // establishes the active project — the exact state in which the old code
    // reached for `DEFAULT_PROJECT_ID` and ran anyway, against the wrong
    // project's context, with no way for anyone to tell.
    //
    // Asserted as a refusal on screen and as an *absent* `chat_send`: a run that
    // guessed would look identical to a correct one from the outside, so the
    // evidence has to be that no turn went out at all.
    const user = userEvent.setup({ delay: null });
    const adapter = await host();
    adapter.breakProjectList = true;
    render(<App adapter={adapter} />);

    await openConversation(user);
    await runAgentTurn(user, 'go');

    const log = await screen.findByRole('log');
    await within(log).findByText('Vela could not start this turn');
    expect(within(log).getByText(/does not know which project/)).toBeInTheDocument();
    expect(adapter.sent, 'a turn went out for a project nobody chose').toHaveLength(0);
  });

  it('still sends an ordinary message, because that one does not belong to a project', async () => {
    // The other half, so the refusal above is scoped rather than a wall. An
    // ordinary send carries no project context — see the pane's own footnote —
    // so there is nothing for it to be missing, and blocking it would be a
    // reduction the user never asked for.
    const user = userEvent.setup({ delay: null });
    const adapter = await host();
    adapter.breakProjectList = true;
    render(<App adapter={adapter} />);

    await openConversation(user);
    await user.click(screen.getByRole('textbox', { name: 'Message' }));
    await user.paste('hello');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(adapter.sent).toHaveLength(1);
    });
  });
});

describe('a project the host cannot read', () => {
  it('says so in the transcript instead of answering as though nothing was missing', async () => {
    // ── THE FAILURE DIRECTION, IN THE WINDOW ───────────────────────────────
    // `project_get` throws. The user must be able to see that the reply they
    // are reading was written without the instructions they wrote — which is
    // the *worse* defect of the two available, because a silently degraded
    // answer looks exactly like a correct one.
    //
    // Every hop is exercised: the reader rejects, the resolver names the
    // material anyway, the loop loads it and gets `null`, it emits
    // `contextUnavailable`, this surface records it against the run's entry, and
    // `RunDegradationNotes` draws it. Before this work the last two hops did not
    // exist — `use-conversation.ts` dropped every `degraded` event.
    const user = userEvent.setup({ delay: null });
    const adapter = await host();
    render(<App adapter={adapter} />);

    await writeInstructions(user, 'Sails', 'always answer in French');
    await openConversation(user);
    adapter.breakProjectGet = true;
    await runAgentTurn(user, 'bonjour');

    const log = await screen.findByRole('log');
    await within(log).findByText(/could not be read/);
    expect(within(log).getByText(/Project instructions/)).toBeInTheDocument();

    // …and it answered anyway. A chat refused because an auxiliary source could
    // not be read would be a chat the user cannot have for a reason they cannot
    // see, which is the other way to get this wrong.
    await waitFor(() => {
      expect(log).toHaveAttribute('aria-busy', 'false');
    });
    expect(log).toHaveTextContent('bonjour');
    expect(
      systemOfLastSend(adapter),
      'nothing may be invented to fill the gap the failure left',
    ).toBeNull();
  });
});
