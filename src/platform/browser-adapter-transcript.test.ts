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
