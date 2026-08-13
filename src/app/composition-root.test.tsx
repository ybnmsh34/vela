/**
 * Tests that drive **the assembled application**, not a component.
 *
 * ## Why this file exists
 *
 * Every gate this project had run drove a bridge, an example, or a component in
 * isolation. Each one passed. The application they compose into did not work,
 * and could not have been observed to: the defects were all in the joints.
 *
 * The rule this file encodes: *a component being correct and separately tested
 * is not evidence that anything reaches it.* So everything here renders
 * `<App />` — the real composition root, the real feature tree — against the
 * fake host, and drives it the way a user does: click, type, send. Nothing is
 * mocked below the adapter seam.
 *
 * **Honesty (conventions §10):** VERIFIED-BY-FAKE. `BrowserAdapter` is an
 * in-memory host. These tests prove that the parts of the *renderer* are
 * connected to each other. They prove nothing about a real endpoint, a real
 * keychain, or a packaged binary.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '@/app/App';
import { BrowserAdapter } from '@/platform/browser-adapter';
import { NO_CAPABILITIES, type ModelCapabilityReport } from '@/platform/contract';
import { resetModelStore } from '@/state/model-store';
import { resetNavigationStore } from '@/state/navigation-store';

/**
 * `hostile` from the Phase C matrix: a 4,096-token window. Chosen because it is
 * the profile where the consequence bites — the gate's own words were that on
 * `hostile` an over-long turn "is easy to hit by accident".
 */
const WINDOW_TOKENS = 4_096;

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

async function host(contextWindowTokens: number | null = WINDOW_TOKENS): Promise<BrowserAdapter> {
  const adapter = new BrowserAdapter();
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

/** Open a conversation the way a user does, and wait for the transcript. */
async function openConversation(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Start a conversation' }));
  await screen.findByRole('region', { name: 'Conversation' });
}

/** The transcript's turns, or `[]` when the surface is showing its empty state. */
function turns(): readonly HTMLElement[] {
  const log = screen.queryByRole('log');
  return log === null ? [] : within(log).getAllByRole('article');
}

/** Send a message and wait for the fake to echo it back and settle. */
async function say(
  user: ReturnType<typeof userEvent.setup>,
  text: string,
): Promise<void> {
  await user.click(composer());
  await user.paste(text);
  await user.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => {
    expect(turns()).toHaveLength(2);
  });
  await waitFor(() => {
    expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'false');
  });
}

/** The sidebar rows, newest first — the order the store lists them in. */
function rows(): readonly HTMLElement[] {
  return screen.getAllByRole('button', { name: /^Open / });
}

function composer(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: 'Message' });
}

function meter(): HTMLElement {
  return screen.getByTestId('context-meter');
}

/**
 * `userEvent.type` replays one keystroke at a time, which is the right thing
 * for a keyboard contract and hopeless for 40,000 characters. A paste is what a
 * user does with a wall of text anyway, and it is the same `change` event.
 */
function paste(text: string): void {
  fireEvent.change(composer(), { target: { value: text } });
}

beforeEach(() => {
  resetModelStore();
  resetNavigationStore();
});

describe('the context meter measures the turn that will actually be sent', () => {
  it('counts the composer draft, and warns before the message is lost', async () => {
    // ── THE LOAD-BEARING TEST ──────────────────────────────────────────────
    // Phase C FINDING 2, at the composition root. The meter was mounted with
    // nothing feeding it, so it reported "About 0 of 200,000 tokens" while the
    // composer held 880,000 characters — telling the user they had room they
    // did not have, which is worse than showing nothing at all.
    const user = userEvent.setup();
    render(<App adapter={await host()} />);
    await openConversation(user);

    // 40,000 ASCII characters is ~10,000 tokens against a 4,096-token window.
    paste('x'.repeat(40_000));

    await waitFor(() => {
      expect(meter()).toHaveAttribute('data-verdict', 'over');
    });
    expect(meter()).toHaveTextContent(/larger than the window/);
    expect(meter()).not.toHaveTextContent(/About 0 of/);
  });

  it('counts the transcript already on screen, not just the draft', async () => {
    // The other half of the same finding. Vela replays the whole conversation
    // on every turn — the model-switch notice says so in as many words — so a
    // meter that only weighs the draft is wrong by the entire conversation, and
    // wrong in the direction that loses messages.
    const user = userEvent.setup();
    render(<App adapter={await host()} />);
    await openConversation(user);

    // Inside the window on its own: ~3,504 tokens of 4,096. Sendable.
    paste('y'.repeat(14_000));
    await waitFor(() => {
      expect(meter()).toHaveAttribute('data-verdict', 'tight');
    });

    await user.click(screen.getByRole('button', { name: 'Send' }));

    // The fake echoes the user's message back, so the settled transcript is
    // ~7,008 tokens: the same text twice, over a 4,096-token window. The
    // composer is now empty — and the meter must still be reading the
    // conversation, not the empty box.
    await waitFor(() => {
      expect(within(screen.getByRole('log')).getAllByRole('article')).toHaveLength(2);
    });
    expect(composer()).toHaveValue('');

    await waitFor(() => {
      expect(meter()).toHaveAttribute('data-verdict', 'over');
    });
  });

  it('drops back down when the draft is cleared', async () => {
    // Not a one-way ratchet: the reading tracks the box in both directions, so
    // shortening the message is visibly the fix the warning asks for.
    const user = userEvent.setup();
    render(<App adapter={await host()} />);
    await openConversation(user);

    paste('z'.repeat(40_000));
    await waitFor(() => {
      expect(meter()).toHaveAttribute('data-verdict', 'over');
    });

    paste('hello');
    await waitFor(() => {
      expect(meter()).toHaveAttribute('data-verdict', 'comfortable');
    });
    // 5 ASCII characters at 4 per token, plus the per-message role wrapper.
    expect(meter()).toHaveTextContent(/About 6 of 4K tokens/);
  });

  it('says the window is unknown rather than inventing one', async () => {
    // An endpoint that reports no window is the *common* local case, not an
    // error. The estimate is still real; there is simply nothing to draw it
    // against, and no default window is ever assumed.
    const user = userEvent.setup();
    render(<App adapter={await host(null)} />);
    await openConversation(user);

    paste('w'.repeat(400));
    await waitFor(() => {
      expect(meter()).toHaveTextContent(/Context window not reported by this endpoint/);
    });
    expect(meter()).toHaveTextContent(/about 104 tokens in this turn/);
  });
});

describe('a conversation is a record, not a session', () => {
  it('keeps a message when the user leaves the conversation and comes back', async () => {
    // ── THE LOAD-BEARING TEST ──────────────────────────────────────────────
    // The same composition-root defect, one layer down. `transcript.rs`,
    // `store_append_message` / `store_list_messages`, their contract types and
    // their fake are all written and separately tested; `ConversationSurface`
    // even takes an `initialEntries` prop documented as "a transcript restored
    // from the store". Nothing in `src/` called any of it, so the transcript
    // lived in React state that `App.tsx` destroys by design — it remounts the
    // surface on `key={conversationId}` so a switch cannot leave the previous
    // conversation's stream attached to the new one.
    //
    // The consequence is not subtle: clicking another conversation and
    // clicking back is enough to lose everything that was said.
    const user = userEvent.setup();
    render(<App adapter={await host()} />);
    await openConversation(user);

    await say(user, 'remember this');

    // Somewhere else, and back. Two rows now; the store lists the newest first,
    // so the conversation just left is the second one.
    await user.click(screen.getByRole('button', { name: /^New conversation/ }));
    await waitFor(() => {
      expect(rows()).toHaveLength(2);
    });
    await waitFor(() => {
      expect(turns()).toHaveLength(0);
    });

    const previous = rows()[1];
    expect(previous).toBeDefined();
    await user.click(previous as HTMLElement);

    await waitFor(() => {
      expect(turns()).toHaveLength(2);
    });
    expect(screen.getByRole('log')).toHaveTextContent('remember this');
  });

  it('writes the turn to the store, where the rest of the app can see it', async () => {
    // The other half, asserted at the seam rather than through the DOM: the
    // host must actually hold the messages. `messageCount` is not decoration —
    // `use-conversations.ts` will only ask the host to derive a title for a
    // conversation whose `messageCount > 0`, so an unwritten transcript also
    // means every conversation keeps its placeholder name forever.
    const user = userEvent.setup();
    const adapter = await host();
    render(<App adapter={adapter} />);
    await openConversation(user);

    await say(user, 'a message worth keeping');

    await waitFor(async () => {
      const { conversations } = await adapter.invoke('store_list_conversations', {});
      expect(conversations[0]?.messageCount).toBe(2);
    });

    const conversationId = (await adapter.invoke('store_list_conversations', {}))
      .conversations[0]?.id;
    expect(conversationId).toBeDefined();
    const { messages } = await adapter.invoke('store_list_messages', {
      conversationId: conversationId as string,
    });
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages[0]?.parts).toEqual([{ kind: 'text', text: 'a message worth keeping' }]);
    expect(messages[1]?.status).toBe('complete');
  });
});
