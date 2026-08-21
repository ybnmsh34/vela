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

import { entriesFromStored } from './stored-entries';
import { useConversation } from './use-conversation';

const NO_USAGE = {
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  cachedInputTokens: null,
} as const;

function answered(
  text: string,
  answeredBy: { providerId: string; modelId: string } | null = null,
): readonly ChatStreamEvent[] {
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
        answeredBy,
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
function scripted(
  scripts: readonly (readonly ChatStreamEvent[])[],
  /**
   * Every request the hook sent, in order, appended as it is sent. Passed in
   * rather than returned so the repository keeps its single-value shape; the
   * caller owns the array and reads it after the send it is about.
   */
  sent: StreamTurnRequest[] = [],
): ChatRepository {
  let call = 0;
  return {
    streamTurn(request: StreamTurnRequest): Promise<TurnHandle> {
      sent.push(request);
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

  it('keeps a reply that produced nothing, instead of losing it at the window', async () => {
    // THE END-TO-END HALF OF THE EMPTY-REPLY FIX, and the half that was missing.
    // The transcript stated the ending and offered the control; the write was
    // skipped whenever `partsOfTurn` came back empty, so reopening the
    // conversation put the question back with nothing after it and no
    // explanation — the state the fix exists to remove, restored by a reload.
    //
    // Both hosts reject a message with no `parts` at all. An *empty text part*
    // is a different thing and both accept it: `vela_store`'s
    // `ContentPart::validate` allows it in as many words, because a streaming
    // row opens as an empty buffer. So the reply is written as one.
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
      expect(await messagesIn(adapter, conversationId)).toHaveLength(2);
    });
    const messages = await messagesIn(adapter, conversationId);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    // The question the user asked is still first, which was already true.
    expect(messages[0]?.parts).toEqual([{ kind: 'text', text: 'into the void' }]);
    // And the reply that produced nothing is a row now, in the shape the store
    // takes one: a single empty text part, carrying the status and the reason.
    expect(messages[1]?.parts).toEqual([{ kind: 'text', text: '' }]);
    expect(messages[1]?.status).toBe('cancelled');

    // Read back, it is the same turn the user was looking at — `turnFromParts`
    // reads an empty text part as an empty answer, so `describeTurnEnding`
    // reaches the same arm it reached live.
    const restored = entriesFromStored(messages);
    expect(restored).toHaveLength(2);
    const reply = restored[1];
    expect(reply?.kind).toBe('assistant');
    const turn = reply?.kind === 'assistant' ? reply.turn : null;
    expect(turn?.answer).toBe('');
    expect(turn?.phase).toBe('stopped');
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
    // Two rows, not one: the cancelled reply is kept as an empty text part
    // rather than skipped — see the empty-reply test above for why.
    await waitFor(async () => {
      expect(await messagesIn(adapter, conversationId)).toHaveLength(2);
    });
    const before = await messagesIn(adapter, conversationId);
    expect(before[1]?.parts).toEqual([{ kind: 'text', text: '' }]);

    act(() => {
      // Retry is bound to a turn now, so the test says which one: the last
      // entry, which is where the button a user would press is drawn.
      result.current.retry(result.current.entries[result.current.entries.length - 1]?.id ?? '');
    });

    // Waited on the *content*, not on the count: the count was already two
    // before the retry, so a length assertion alone would pass before the
    // replacement had happened at all.
    await waitFor(async () => {
      const written = await messagesIn(adapter, conversationId);
      expect(written).toHaveLength(2);
      expect(written[1]?.parts).toEqual([{ kind: 'text', text: 'second time lucky' }]);
    });
    const messages = await messagesIn(adapter, conversationId);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages[0]?.parts).toEqual([{ kind: 'text', text: 'ask once' }]);
  });

  it('shows a restored empty reply and does not send it to the model', async () => {
    // WHAT THE EMPTY-REPLY ROW COSTS ON THE NEXT TURN, AND WHO PAYS IT.
    //
    // Writing a reply that produced nothing is the fix above. It creates a
    // transcript state that could not exist before it — a settled assistant
    // entry whose answer is `''` — and `ENDED_WITH_NOTHING`'s docblock says in
    // as many words what keeps that state off the wire: `historyMessages` skips
    // it, so the next request does not carry an empty assistant message that
    // some endpoints reject.
    //
    // Nothing asserted it. The round-6 measurer deleted the `answer !== ''`
    // arm, so a restored empty reply was sent as `{ role: 'assistant', text:
    // '' }`, and both the conversation suite and the whole renderer suite
    // stayed green — 121 files / 2443 tests, exit 0. The pre-existing docblock
    // on `historyMessages` states the same property, so the guarantee the new
    // persistence path leans on was a comment in two places and an assertion in
    // none. Re-measured with this test in place: deleting that arm now fails the
    // whole suite here and nowhere else — 1 failed | 2450 passed at this
    // commit.
    //
    // Restored rather than live, because restored is what the docblock claims:
    // the rows are written first and the hook reads them back the way reopening
    // the conversation does.
    const { adapter, wrapper, conversationId } = await fixture();
    const transcript = createTranscriptRepository(adapter);
    await transcript.append({
      conversationId,
      role: 'user',
      parts: [{ kind: 'text', text: 'into the void' }],
    });
    await transcript.append({
      conversationId,
      role: 'assistant',
      parts: [{ kind: 'text', text: '' }],
      status: 'cancelled',
    });

    const sent: StreamTurnRequest[] = [];
    const chat = scripted([answered('this one says something')], sent);
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

    // The transcript shows it: two entries, the second an assistant turn with
    // nothing in it. That half is what the row was written for.
    await waitFor(() => {
      expect(result.current.entries).toHaveLength(2);
    });
    const restored = result.current.entries[1];
    expect(restored?.kind).toBe('assistant');
    expect(restored?.kind === 'assistant' ? restored.turn.answer : null).toBe('');

    act(() => {
      result.current.send('ask again');
    });
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });

    // And the request does not: the question, then the new question. No
    // assistant message at all, empty or otherwise.
    expect(sent[0]?.messages.map((message) => [message.role, message.text])).toEqual([
      ['user', 'into the void'],
      ['user', 'ask again'],
    ]);
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

  /**
   * **The row that used to lie.**
   *
   * The user selected `workstation`; the host reports that `rented-gpu-box`
   * answered. Before this change the transcript recorded `workstation` in the
   * only endpoint column it had — the value this hook was *handed as an option*,
   * never a report of what happened — so the record asserted that an endpoint
   * which never saw the prompt had produced the reply. Written to SQLite, that
   * cannot be corrected afterwards, because a stored guess is indistinguishable
   * from a stored fact.
   *
   * The load-bearing assertions are the two inequalities. Checking only that
   * `answeredByProviderId` is `rented-gpu-box` would also pass on a hook that
   * wrote the attribution into *both* columns and lost the user's selection —
   * which is a different wrong record, not a right one.
   */
  it('records the endpoint that answered, not the one that was selected', async () => {
    const { adapter, wrapper, conversationId } = await fixture();
    const chat = scripted([
      answered('the answer', { providerId: 'rented-gpu-box', modelId: 'big-model' }),
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
      result.current.send('the question');
    });

    await waitFor(async () => {
      expect(await messagesIn(adapter, conversationId)).toHaveLength(2);
    });
    const reply = (await messagesIn(adapter, conversationId))[1];

    expect(reply?.answeredByProviderId).toBe('rented-gpu-box');
    expect(reply?.answeredByModelId).toBe('big-model');
    expect(reply?.providerId).toBe('workstation');
    expect(reply?.modelId).toBe('local-model');
    expect(reply?.answeredByProviderId).not.toBe(reply?.providerId);
    expect(reply?.answeredByModelId).not.toBe(reply?.modelId);
  });

  /**
   * A turn the host did not attribute is stored unattributed.
   *
   * The selection is still recorded — it is a true fact about the turn — but
   * nothing is written into the answering columns, because nothing is known.
   * A hook that filled them in from `providerId` would produce rows that look
   * exactly like verified ones.
   */
  it('leaves the answering endpoint empty when the host did not say', async () => {
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
    const reply = (await messagesIn(adapter, conversationId))[1];

    expect(reply?.providerId).toBe('workstation');
    expect(reply?.answeredByProviderId).toBeNull();
    expect(reply?.answeredByModelId).toBeNull();
  });
});
