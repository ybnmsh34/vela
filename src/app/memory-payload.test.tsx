/**
 * **Does a remembered fact actually reach the wire?**
 *
 * ## Why this file exists, separately from every other memory test
 *
 * Because it is the only question that matters, and it is the one a
 * component-level test cannot ask. `memory_add` can be implemented, the store
 * can hold the row, the pane can list it, `buildMemoryBlock` can render it, and
 * every one of those can pass while nothing puts the block in a `chat_send`
 * payload. That is not hypothetical: it is the shape of the defect
 * `src/app/staged-attachment-payload.test.tsx` was written for — a staged image
 * with a hook, a tray, a picker and an encoder, all tested, all correct, and
 * nobody reading the tray at send time.
 *
 * So this renders the real `<App/>`, writes a memory through the shipping
 * affordance in the sidebar, sends a message, and reads the argument the
 * renderer handed the host. The assertion is on the outgoing request and
 * nothing else. A component's internal state is not evidence.
 *
 * **Honesty (conventions §10): VERIFIED-BY-FAKE.** The host is
 * `BrowserAdapter`, whose memory commands mirror `src-tauri/src/ipc/memory.rs`
 * and whose validation is the same validation. What is proved is that the
 * renderer's parts are joined and that the payload has the shape the Rust host
 * accepts. Nothing here proves anything about a real endpoint or a real disk.
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
import { resetMemoryStore } from '@/state/memory-store';
import { resetModelStore } from '@/state/model-store';
import { resetNavigationStore } from '@/state/navigation-store';

/**
 * The real fake host, with one addition: it keeps the requests it was given.
 * A subclass rather than a mock — every command still runs the fake's own
 * validation, so a payload this test calls "sent" is one the host accepted.
 */
class RecordingHost extends BrowserAdapter {
  readonly sent: ChatSendReq[] = [];

  override async invoke<C extends CommandName>(
    command: C,
    payload: CommandReq<C>,
  ): Promise<CommandRes<C>> {
    if (command === 'chat_send') this.sent.push(payload as ChatSendReq);
    return super.invoke(command, payload);
  }
}

function report(contextWindowTokens: number | null): ModelCapabilityReport {
  return {
    providerId: 'workstation',
    modelId: 'local-model',
    capabilities: { ...NO_CAPABILITIES, streaming: true },
    structuredOutput: false,
    toolCallsEmulated: false,
    contextWindowTokens,
    maxOutputTokens: null,
    probed: true,
    findings: [],
  };
}

async function host(contextWindowTokens: number | null = 200_000): Promise<RecordingHost> {
  const adapter = new RecordingHost();
  await adapter.invoke('settings_put_provider', {
    id: 'workstation',
    displayName: 'The workstation',
    kind: 'local',
    baseUrl: 'http://127.0.0.1:8080/v1',
    modelId: 'local-model',
  });
  adapter.seedCapabilities(report(contextWindowTokens));
  return adapter;
}

type User = ReturnType<typeof userEvent.setup>;

/**
 * The pane, scoped. The title bar has a Close of its own, so every query
 * inside the dialog is asked of the dialog.
 */
function pane(): HTMLElement {
  return screen.getByRole('dialog');
}

/** Write one memory through the pane the user actually has. */
async function remember(user: User, text: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Memory' }));
  const box = await screen.findByRole('textbox', { name: 'Remember something' });
  await user.click(box);
  await user.paste(text);
  await user.click(within(pane()).getByRole('button', { name: 'Remember this' }));
  await screen.findByRole('textbox', { name: `Memory: ${text}` });
  await user.click(within(pane()).getByRole('button', { name: 'Close' }));
}

async function openConversation(user: User): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Start a conversation' }));
  await screen.findByRole('region', { name: 'Conversation' });
}

async function say(user: User, text: string): Promise<void> {
  await user.click(screen.getByRole('textbox', { name: 'Message' }));
  await user.paste(text);
  await user.click(screen.getByRole('button', { name: 'Send' }));
}

beforeEach(() => {
  resetMemoryStore();
  resetModelStore();
  resetNavigationStore();
});

describe('a remembered fact reaches the payload', () => {
  it('puts it in the outgoing chat_send request, as the first message and as a system message', async () => {
    // ── THE LOAD-BEARING TEST ──────────────────────────────────────────────
    // Written through the shipping pane, read off the request the host was
    // handed. Nothing about the pane's state, the store's rows or the block
    // builder's output is asserted here: all of those can pass while the turn
    // goes out without a word of it.
    const user = userEvent.setup();
    const adapter = await host();
    render(<App adapter={adapter} />);

    await remember(user, 'uses pnpm, never npm');
    await openConversation(user);
    await say(user, 'how do I install this?');

    await waitFor(() => {
      expect(adapter.sent).toHaveLength(1);
    });

    const messages = adapter.sent[0]?.messages ?? [];
    const first = messages[0];
    // First, because a system message that follows the transcript reads as a
    // late instruction and some endpoints refuse the role anywhere else.
    expect(first?.role).toBe('system');
    expect(first?.text).toContain('uses pnpm, never npm');
    // And the user's own question is still there, unaltered — memory is added
    // beside it, never folded into it.
    expect(messages[messages.length - 1]).toEqual({
      role: 'user',
      text: 'how do I install this?',
    });
  });

  it('sends no system message at all when nothing is remembered', async () => {
    // The default state of a fresh install. An empty memory must produce an
    // absent message, not an empty one — a message with no content is a
    // payload some endpoints reject and all of them are confused by.
    const user = userEvent.setup();
    const adapter = await host();
    render(<App adapter={adapter} />);

    await openConversation(user);
    await say(user, 'hello');

    await waitFor(() => {
      expect(adapter.sent).toHaveLength(1);
    });
    expect(adapter.sent[0]?.messages.some((message) => message.role === 'system')).toBe(false);
  });

  it('stops sending a fact the user forgot', async () => {
    // The whole point of a user-editable memory: a wrong remembered fact is
    // worse than a forgotten one, because it silently steers every later
    // answer. Deleting it in the pane has to stop it reaching the model.
    const user = userEvent.setup();
    const adapter = await host();
    render(<App adapter={adapter} />);

    await remember(user, 'uses pnpm, never npm');

    await user.click(screen.getByRole('button', { name: 'Memory' }));
    await user.click(await screen.findByRole('button', { name: 'Forget: uses pnpm, never npm' }));
    await screen.findByText('Nothing is remembered yet.');
    await user.click(within(pane()).getByRole('button', { name: 'Close' }));

    await openConversation(user);
    await say(user, 'how do I install this?');

    await waitFor(() => {
      expect(adapter.sent).toHaveLength(1);
    });
    expect(adapter.sent[0]?.messages.some((message) => message.role === 'system')).toBe(false);
  });

  it('counts the memory block in the context meter, not only in the payload', async () => {
    // A meter with its own opinion of what gets sent is a meter that drifts
    // from the sender, and the user finds out by losing a message. The block
    // is rendered before a single key is pressed, so the meter must already
    // know about it on an empty composer.
    const user = userEvent.setup();
    const adapter = await host(4_096);
    render(<App adapter={adapter} />);

    await openConversation(user);
    const before = (await screen.findByTestId('context-meter')).textContent ?? '';

    await remember(user, 'uses pnpm, never npm');

    await waitFor(() => {
      expect(screen.getByTestId('context-meter').textContent).not.toBe(before);
    });
  });
});
