/**
 * The conversation-as-record behaviour of {@link useConversation}, against the
 * real transcript repository over the fake host.
 *
 * The paths here are the ones the assembled-app tests in
 * `src/app/composition-root.test.tsx` cannot reach cheaply: a turn that fails,
 * a retry, and a store that refuses to be read. The chat side is a stub so a
 * failure is a scripted event rather than a race.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import type { ChatRepository, StreamTurnRequest, TurnHandle } from '@/data/chat-repository';
import { createTranscriptRepository } from '@/data/transcript-repository';
import { PlatformProvider } from '@/platform/PlatformProvider';
import { BrowserAdapter } from '@/platform/browser-adapter';
import type { ChatStreamEvent } from '@/platform/contract';

import { useConversation } from './use-conversation';

const NO_USAGE = {
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  cachedInputTokens: null,
} as const;

function answered(text: string): readonly ChatStreamEvent[] {
  return [
    { type: 'textDelta', text },
    {
      type: 'done',
      response: {
        parts: [{ kind: 'text', text }],
        toolCalls: [],
        stopReason: 'endTurn',
        usage: NO_USAGE,
        structured: null,
        degradations: [],
      },
    },
  ];
}

/**
 * A chat repository that replays a scripted turn, one script per call.
 *
 * Built **once per test**, never inside the render closure `renderHook` re-runs
 * on every commit: a repository rebuilt each render replays script 0 forever,
 * so the second turn of a retry would silently be the first turn again — which
 * is exactly the shape of bug this file exists to catch, and it would have hid
 * it instead.
 */
function scripted(scripts: readonly (readonly ChatStreamEvent[])[]): ChatRepository {
  let call = 0;
  return {
    streamTurn(request: StreamTurnRequest): Promise<TurnHandle> {
      const script = scripts[call] ?? [];
      call += 1;
      for (const event of script) request.onEvent(event);
      const handle: TurnHandle = {
        turnId: request.turnId,
        cancel: () => Promise.resolve(false),
        release: () => undefined,
      };
      return Promise.resolve(handle);
    },
  };
}

async function fixture() {
  const adapter = new BrowserAdapter({ now: () => 1_700_000_000_000 });
  const { conversation } = await adapter.invoke('store_create_conversation', {});
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(PlatformProvider, { adapter, children });
  return { adapter, wrapper, conversationId: conversation.id };
}

async function messagesIn(adapter: BrowserAdapter, conversationId: string) {
  const { messages } = await adapter.invoke('store_list_messages', { conversationId });
  return messages;
}

describe('a conversation is written as it happens', () => {
  it('records the question and the answer, in that order', async () => {
    const { adapter, wrapper, conversationId } = await fixture();
    const chat = scripted([answered('the answer')]);
    const { result } = renderHook(
      () =>
        useConversation({
          conversationId,
          providerId: 'workstation',
          modelId: 'local-model',
          repository: chat,
          scheduleCommit: (run) => {
            run();
          },
        }),
      { wrapper },
    );

    act(() => {
      result.current.send('the question');
    });

    await waitFor(async () => {
      expect(await messagesIn(adapter, conversationId)).toHaveLength(2);
    });
    const messages = await messagesIn(adapter, conversationId);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages[1]?.parts).toEqual([{ kind: 'text', text: 'the answer' }]);
    expect(messages[1]?.status).toBe('complete');
  });

  it('keeps the question when the turn produced no reply to keep', async () => {
    // Both hosts reject a message with no parts, so a turn that failed before a
    // single token has nothing to write as the reply. What must not happen is
    // the question going missing with it — the user said that, and the record
    // is of what happened, which includes being answered by nothing.
    const { adapter, wrapper, conversationId } = await fixture();
    const chat = scripted([[{ type: 'error', error: { kind: 'cancelled' } }]]);
    const { result } = renderHook(
      () =>
        useConversation({
          conversationId,
          providerId: 'workstation',
          modelId: 'local-model',
          repository: chat,
          scheduleCommit: (run) => {
            run();
          },
        }),
      { wrapper },
    );

    act(() => {
      result.current.send('into the void');
    });

    await waitFor(async () => {
      expect(await messagesIn(adapter, conversationId)).toHaveLength(1);
    });
    const [only] = await messagesIn(adapter, conversationId);
    expect(only?.role).toBe('user');
    expect(only?.parts).toEqual([{ kind: 'text', text: 'into the void' }]);
  });

  it('replaces what retry replaces, instead of recording it twice', async () => {
    // Retry drops the last user message and its failed reply and re-sends. If
    // the store only ever grew, the transcript that came back after a retry
    // would hold both attempts — which is not the transcript the user was
    // looking at when they pressed the button.
    const { adapter, wrapper, conversationId } = await fixture();
    const chat = scripted([
      [{ type: 'error', error: { kind: 'cancelled' } }],
      answered('second time lucky'),
    ]);
    const { result } = renderHook(
      () =>
        useConversation({
          conversationId,
          providerId: 'workstation',
          modelId: 'local-model',
          repository: chat,
          scheduleCommit: (run) => {
            run();
          },
        }),
      { wrapper },
    );

    act(() => {
      result.current.send('ask once');
    });
    await waitFor(async () => {
      expect(await messagesIn(adapter, conversationId)).toHaveLength(1);
    });

    act(() => {
      result.current.retry();
    });

    await waitFor(async () => {
      expect(await messagesIn(adapter, conversationId)).toHaveLength(2);
    });
    const messages = await messagesIn(adapter, conversationId);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages[0]?.parts).toEqual([{ kind: 'text', text: 'ask once' }]);
    expect(messages[1]?.parts).toEqual([{ kind: 'text', text: 'second time lucky' }]);
  });

  it('says the transcript is unreadable rather than showing it as empty', async () => {
    // An empty conversation and one whose store read failed look identical on
    // screen, and one of them is a lie. Sending is blocked too: appending a
    // turn to a history that failed to load would write a reply with the
    // conversation missing from behind it.
    const { wrapper } = await fixture();
    const chat = scripted([]);
    const { result } = renderHook(
      () =>
        useConversation({
          conversationId: 'conv_ghost',
          providerId: 'workstation',
          modelId: 'local-model',
          repository: chat,
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.blockedReason).toBe('This conversation could not be read from the store');
    });
    expect(result.current.entries).toEqual([]);
  });

  it('does not write the transcript it just read back to the store', async () => {
    // The write-on-settle effect fires for whatever settled turn is last in the
    // transcript — and a restored turn is already settled. Without the restore
    // claiming its own entries, opening a conversation would append its last
    // turn to it again, every time it was opened.
    const { adapter, wrapper, conversationId } = await fixture();
    const transcript = createTranscriptRepository(adapter);
    await transcript.append({
      conversationId,
      role: 'user',
      parts: [{ kind: 'text', text: 'said earlier' }],
    });
    await transcript.append({
      conversationId,
      role: 'assistant',
      parts: [{ kind: 'text', text: 'answered earlier' }],
    });

    const chat = scripted([]);
    const { result } = renderHook(
      () =>
        useConversation({
          conversationId,
          providerId: 'workstation',
          modelId: 'local-model',
          repository: chat,
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(2);
    });
    expect(await messagesIn(adapter, conversationId)).toHaveLength(2);
  });
});
