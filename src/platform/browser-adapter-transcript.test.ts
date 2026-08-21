/**
 * The fake host's transcript surface.
 *
 * Its Rust twin is `src-tauri/src/ipc/transcript.rs`'s test module, and the
 * assertions are deliberately the same shape: write a turn, read it back,
 * project the reasoning out, close out a streaming row. **The Rust host is the
 * specification** (`docs/architecture/conventions.md` §8) — when the two
 * disagree, the fake is wrong.
 *
 * **VERIFIED-BY-FAKE.** An in-memory map, not SQLite. What this proves is that
 * the UI can be developed and tested headlessly against the same contract.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { BrowserAdapter } from './browser-adapter';
import type { ContentPartInput } from './contract';

let host: BrowserAdapter;

async function conversation(): Promise<string> {
  const { conversation: created } = await host.invoke('store_create_conversation', {});
  return created.id;
}

beforeEach(() => {
  host = new BrowserAdapter({ now: () => 1_000 });
});

describe('the fake host: the transcript', () => {
  it('a message written through the adapter is readable through the adapter', async () => {
    const id = await conversation();
    await host.invoke('store_append_message', {
      conversationId: id,
      role: 'user',
      parts: [{ kind: 'text', text: 'hello' }],
    });

    const { messages } = await host.invoke('store_list_messages', { conversationId: id });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.parts).toEqual([{ kind: 'text', text: 'hello' }]);
    expect(messages[0]?.seq).toBe(0);
    expect(messages[0]?.status).toBe('complete');
  });

  it('an empty transcript reads as empty', async () => {
    // The control: the assertion above found something that was written.
    const id = await conversation();
    const { messages } = await host.invoke('store_list_messages', { conversationId: id });
    expect(messages).toEqual([]);
  });

  it('keeps reasoning as its own part and can project it out', async () => {
    const id = await conversation();
    const parts: ContentPartInput[] = [
      { kind: 'reasoning', text: 'the user wants a number', signature: 'sig', redacted: false },
      { kind: 'text', text: '391' },
    ];
    await host.invoke('store_append_message', {
      conversationId: id,
      role: 'assistant',
      parts,
      providerId: 'my-box',
      modelId: 'some-model',
    });

    const withThinking = await host.invoke('store_list_messages', { conversationId: id });
    expect(withThinking.messages[0]?.parts).toEqual(parts);
    expect(withThinking.messages[0]?.modelId).toBe('some-model');

    const replayable = await host.invoke('store_list_messages', {
      conversationId: id,
      includeReasoning: false,
    });
    expect(
      replayable.messages[0]?.parts,
      'replaying another model’s thinking back at a model is usually wrong',
    ).toEqual([{ kind: 'text', text: '391' }]);
  });

  it('opens a streaming turn and closes it out on the same row', async () => {
    const id = await conversation();
    const opened = await host.invoke('store_append_message', {
      conversationId: id,
      role: 'assistant',
      parts: [{ kind: 'text', text: '' }],
      status: 'streaming',
    });
    expect(opened.message.status).toBe('streaming');

    const closed = await host.invoke('store_update_message', {
      messageId: opened.message.id,
      parts: [{ kind: 'text', text: 'the whole answer' }],
      status: 'complete',
      stopReason: 'endTurn',
    });
    expect(closed.message.id).toBe(opened.message.id);
    expect(closed.message.status).toBe('complete');
    expect(closed.message.stopReason).toBe('endTurn');
  });

  it('an omitted field on an update leaves the value alone', async () => {
    const id = await conversation();
    const opened = await host.invoke('store_append_message', {
      conversationId: id,
      role: 'assistant',
      parts: [{ kind: 'text', text: 'half an ans' }],
      status: 'streaming',
    });
    const stopped = await host.invoke('store_update_message', {
      messageId: opened.message.id,
      status: 'cancelled',
    });
    expect(stopped.message.parts).toEqual([{ kind: 'text', text: 'half an ans' }]);
    expect(stopped.message.status).toBe('cancelled');
  });

  it('loads a transcript incrementally, with afterSeq exclusive', async () => {
    const id = await conversation();
    for (const text of ['one', 'two', 'three']) {
      await host.invoke('store_append_message', {
        conversationId: id,
        role: 'user',
        parts: [{ kind: 'text', text }],
      });
    }
    const tail = await host.invoke('store_list_messages', { conversationId: id, afterSeq: 0 });
    expect(tail.messages).toHaveLength(2);
    expect(tail.messages[0]?.seq).toBe(1);

    const capped = await host.invoke('store_list_messages', { conversationId: id, limit: 1 });
    expect(capped.messages).toHaveLength(1);
  });

  it('a written message is findable by the search that already existed', async () => {
    const id = await conversation();
    await host.invoke('store_append_message', {
      conversationId: id,
      role: 'user',
      parts: [{ kind: 'text', text: 'the rendering pipeline' }],
    });
    const hits = await host.invoke('store_search', { query: 'rendering' });
    expect(hits.messages).toHaveLength(1);
    expect(hits.messages[0]?.kind).toBe('answer');
  });

  it('a reasoning match is labelled as reasoning, not quoted as an answer', async () => {
    const id = await conversation();
    await host.invoke('store_append_message', {
      conversationId: id,
      role: 'assistant',
      parts: [
        { kind: 'reasoning', text: 'privately considering rasterisation' },
        { kind: 'text', text: 'done' },
      ],
    });
    const hits = await host.invoke('store_search', { query: 'rasterisation' });
    expect(hits.messages[0]?.kind).toBe('reasoning');
  });

  it('a message can be taken back out of the record', async () => {
    const id = await conversation();
    const written = await host.invoke('store_append_message', {
      conversationId: id,
      role: 'user',
      parts: [{ kind: 'text', text: 'oops' }],
    });
    await host.invoke('store_delete_message', { messageId: written.message.id });
    const { messages } = await host.invoke('store_list_messages', { conversationId: id });
    expect(messages).toEqual([]);
  });

  it('refuses a message with no parts rather than writing an empty one', async () => {
    const id = await conversation();
    await expect(
      host.invoke('store_append_message', { conversationId: id, role: 'user', parts: [] }),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
  });

  it('a message for a conversation that does not exist is NOT_FOUND', async () => {
    await expect(
      host.invoke('store_append_message', {
        conversationId: 'conv_nope',
        role: 'user',
        parts: [{ kind: 'text', text: 'hi' }],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a blank message id is an invalid payload, not a lookup', async () => {
    await expect(host.invoke('store_delete_message', { messageId: '  ' })).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
  });

  it('carries an image as base64 rather than a byte array', async () => {
    const id = await conversation();
    const image: ContentPartInput = { kind: 'image', mimeType: 'image/png', data: 'iVBORw==' };
    await host.invoke('store_append_message', {
      conversationId: id,
      role: 'user',
      parts: [image],
    });
    const { messages } = await host.invoke('store_list_messages', { conversationId: id });
    expect(messages[0]?.parts[0]).toEqual(image);
  });

  /**
   * The fake's twin of
   * `ipc::transcript::tests::a_streaming_turn_learns_who_answered_when_it_is_closed_out`.
   *
   * A row opened while a turn streams cannot carry an attribution, so the
   * closing update has to. The fixture disagrees on purpose — addressed to
   * `local-llamacpp`, answered by `hosted-openai` — because an implementation
   * that echoed the selection into the answering columns would satisfy every
   * "is it set" assertion and fail the last two.
   */
  it('an attribution learned at the end of a streaming turn is recorded by the update', async () => {
    const id = await conversation();
    const { message: opened } = await host.invoke('store_append_message', {
      conversationId: id,
      role: 'assistant',
      parts: [{ kind: 'text', text: '' }],
      status: 'streaming',
      providerId: 'local-llamacpp',
      modelId: 'qwen3-8b',
    });
    expect(opened.answeredByProviderId).toBeNull();

    await host.invoke('store_update_message', {
      messageId: opened.id,
      parts: [{ kind: 'text', text: 'the whole answer' }],
      status: 'complete',
      answeredBy: { providerId: 'hosted-openai', modelId: 'gpt-4o-mini' },
    });

    const { messages } = await host.invoke('store_list_messages', { conversationId: id });
    expect(messages[0]?.status).toBe('complete');
    expect(messages[0]?.answeredByProviderId).toBe('hosted-openai');
    expect(messages[0]?.answeredByModelId).toBe('gpt-4o-mini');
    expect(messages[0]?.providerId).toBe('local-llamacpp');
    expect(messages[0]?.answeredByProviderId).not.toBe(messages[0]?.providerId);
    expect(messages[0]?.answeredByModelId).not.toBe(messages[0]?.modelId);
  });

  /**
   * The fake's twin of
   * `sqlite::tests::a_later_update_that_says_nothing_about_the_attribution_does_not_erase_it`.
   *
   * `MessagePatch::answered_by` is set-only, so an omission must leave the
   * recorded value standing. The mistake this catches is not a caller asking to
   * clear — it is a writer that assigns unconditionally and lands `undefined`
   * on the row. It is invisible on the happy path, where the closing update
   * carries the attribution anyway, and shows up only on a *second* update.
   */
  it('a later update that says nothing about the attribution does not erase it', async () => {
    const id = await conversation();
    const { message: written } = await host.invoke('store_append_message', {
      conversationId: id,
      role: 'assistant',
      parts: [{ kind: 'text', text: 'hi' }],
      providerId: 'local-llamacpp',
      modelId: 'qwen3-8b',
      answeredByProviderId: 'hosted-openai',
      answeredByModelId: 'gpt-4o-mini',
    });

    await host.invoke('store_update_message', {
      messageId: written.id,
      status: 'failed',
      errorMessage: 'the socket went away',
    });

    const { messages } = await host.invoke('store_list_messages', { conversationId: id });
    expect(messages[0]?.status).toBe('failed');
    expect(messages[0]?.answeredByProviderId).toBe('hosted-openai');
    expect(messages[0]?.answeredByModelId).toBe('gpt-4o-mini');
  });

  /**
   * Blank folds to "not learned" on both commands, as `ipc::transcript.rs`
   * folds it — `.filter(|id| !id.trim().is_empty())` per id on
   * `append_message`, `learned_attribution` over the whole pair on
   * `update_message`.
   *
   * The append half of this was a real divergence: the fake used to store `''`
   * verbatim, which every reader downstream treats as an attribution to an
   * endpoint with no name. The host has never stored it.
   */
  it('a blank attribution means not recorded, on the append and on the update alike', async () => {
    const id = await conversation();
    const { message: written } = await host.invoke('store_append_message', {
      conversationId: id,
      role: 'assistant',
      parts: [{ kind: 'text', text: 'hi' }],
      answeredByProviderId: '   ',
      answeredByModelId: '',
    });
    expect(written.answeredByProviderId).toBeNull();
    expect(written.answeredByModelId).toBeNull();

    await host.invoke('store_update_message', {
      messageId: written.id,
      answeredBy: { providerId: 'hosted-openai', modelId: 'gpt-4o-mini' },
    });
    await host.invoke('store_update_message', {
      messageId: written.id,
      status: 'complete',
      answeredBy: { providerId: ' ', modelId: '' },
    });

    const { messages } = await host.invoke('store_list_messages', { conversationId: id });
    expect(messages[0]?.answeredByProviderId).toBe('hosted-openai');
    expect(messages[0]?.answeredByModelId).toBe('gpt-4o-mini');
  });

  /**
   * **A half-blank pair is refused, and the row is left as it was.**
   *
   * The fake's twin of
   * `sqlite::tests::an_update_cannot_replace_one_half_of_a_recorded_attribution`,
   * and the reason `answeredBy` is one object rather than two ids: an update
   * merges. A patch that could carry `providerId` alone would pair a fresh
   * provider with the model already recorded and produce an attribution no
   * endpoint returned — which `answeredByOf` in
   * `src/features/conversation/stored-entries.ts` cannot distinguish from a
   * real one, because both columns are non-null. The type removes the shape;
   * what a caller can still spell is a blank half, and the host answers that
   * with an invalid payload rather than a partial write.
   */
  it('refuses an attribution with one blank half instead of merging it', async () => {
    const id = await conversation();
    const { message: written } = await host.invoke('store_append_message', {
      conversationId: id,
      role: 'assistant',
      parts: [{ kind: 'text', text: 'hi' }],
      status: 'streaming',
      answeredByProviderId: 'hosted-openai',
      answeredByModelId: 'gpt-4o-mini',
    });

    await expect(
      host.invoke('store_update_message', {
        messageId: written.id,
        status: 'complete',
        answeredBy: { providerId: 'anthropic', modelId: '   ' },
      }),
    ).rejects.toThrow(/answeredBy/);

    const { messages } = await host.invoke('store_list_messages', { conversationId: id });
    expect(messages[0]?.answeredByProviderId).toBe('hosted-openai');
    expect(messages[0]?.answeredByModelId).toBe('gpt-4o-mini');
    expect(messages[0]?.status, 'a refused statement writes none of itself').not.toBe('complete');
  });

  it('appending a message moves the conversation up the sidebar', async () => {
    const id = await conversation();
    await host.invoke('store_append_message', {
      conversationId: id,
      role: 'user',
      parts: [{ kind: 'text', text: 'hello' }],
    });
    const { conversations } = await host.invoke('store_list_conversations', {});
    expect(conversations[0]?.messageCount).toBe(1);
    expect(conversations[0]?.lastMessageAtMs).not.toBeNull();
  });
});
