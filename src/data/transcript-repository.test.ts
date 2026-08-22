/**
 * The transcript repository against the fake host — conventions §6: pass a
 * `BrowserAdapter` and the whole repository is under test with no DOM.
 */

import { describe, expect, it } from 'vitest';

import { BrowserAdapter } from '@/platform/browser-adapter';
import { PlatformError } from '@/platform/errors';

import { createTranscriptRepository } from './transcript-repository';

async function fixture() {
  const adapter = new BrowserAdapter({ now: () => 1_700_000_000_000 });
  const { conversation } = await adapter.invoke('store_create_conversation', {});
  return { adapter, repo: createTranscriptRepository(adapter), conversationId: conversation.id };
}

describe('transcript repository', () => {
  it('appends, lists and removes a message', async () => {
    const { repo, conversationId } = await fixture();

    const written = await repo.append({
      conversationId,
      role: 'user',
      parts: [{ kind: 'text', text: 'the first thing said' }],
    });
    expect(await repo.list(conversationId)).toHaveLength(1);

    await repo.remove(written.id);
    expect(await repo.list(conversationId)).toHaveLength(0);
  });

  it('carries reasoning back as its own part, never folded into the answer', async () => {
    // The store models reasoning separately so the UI can collapse it and the
    // prompt-rebuilding path can leave it out. A repository that flattened the
    // two on the way through would destroy both affordances for every reader.
    const { repo, conversationId } = await fixture();

    await repo.append({
      conversationId,
      role: 'assistant',
      parts: [
        { kind: 'reasoning', text: 'weighing it up' },
        { kind: 'text', text: 'the answer' },
      ],
    });

    const [message] = await repo.list(conversationId);
    expect(message?.parts).toEqual([
      { kind: 'reasoning', text: 'weighing it up' },
      { kind: 'text', text: 'the answer' },
    ]);
  });

  it('closes out a message it opened as streaming', async () => {
    const { repo, conversationId } = await fixture();

    // A message needs at least one part — both hosts reject an empty one — so
    // even an "opening" row has to carry something. That is the reason
    // `use-conversation.ts` writes a turn when it settles rather than opening a
    // `streaming` row it would then have to remember to replace.
    const opened = await repo.append({
      conversationId,
      role: 'assistant',
      parts: [{ kind: 'text', text: '' }],
      status: 'streaming',
    });
    expect(opened.status).toBe('streaming');

    const closed = await repo.update({
      messageId: opened.id,
      parts: [{ kind: 'text', text: 'done' }],
      status: 'complete',
    });
    expect(closed.status).toBe('complete');
  });

  it('propagates a host failure instead of swallowing it into an empty result', async () => {
    const { repo } = await fixture();

    // Conventions §6, and the reason `use-conversation.ts` blocks sending on a
    // failed read: an unreadable transcript and an empty one must not look the
    // same to the caller.
    await expect(repo.list('conv_ghost')).rejects.toBeInstanceOf(PlatformError);
    await expect(repo.remove('msg_ghost')).rejects.toBeInstanceOf(PlatformError);
  });
});
