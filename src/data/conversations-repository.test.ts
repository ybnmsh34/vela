/**
 * The repository against the fake host — conventions §6: "this is where
 * features get their cheapest tests: pass a `BrowserAdapter` and the whole
 * repository is under test with no DOM."
 */

import { describe, expect, it } from 'vitest';

import { BrowserAdapter } from '@/platform/browser-adapter';
import { PlatformError } from '@/platform/errors';

import { createConversationsRepository } from './conversations-repository';

function repository() {
  const adapter = new BrowserAdapter({ now: () => 1_700_000_000_000 });
  return { adapter, repo: createConversationsRepository(adapter) };
}

describe('conversations repository', () => {
  it('creates, lists, renames and deletes', async () => {
    const { repo } = repository();

    const created = await repo.create();
    expect(await repo.list()).toHaveLength(1);

    const renamed = await repo.rename(created.id, 'Star charts');
    expect(renamed.title).toBe('Star charts');
    expect((await repo.list())[0]?.title).toBe('Star charts');

    await repo.remove(created.id);
    expect(await repo.list()).toHaveLength(0);
  });

  it('propagates a host failure instead of swallowing it into an empty result', async () => {
    const { repo } = repository();

    // Conventions §6: errors propagate as PlatformError; do not swallow them
    // into `null`. A sidebar that renders "no conversations" when the store is
    // unreachable is telling the user their work is gone.
    await expect(repo.remove('conv_ghost')).rejects.toBeInstanceOf(PlatformError);
    await expect(repo.remove('conv_ghost')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(repo.rename('conv_ghost', 'x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(repo.create('   ')).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
  });

  it('omits an absent limit rather than sending undefined over the wire', async () => {
    const { adapter, repo } = repository();
    const seen: unknown[] = [];
    const original = adapter.invoke.bind(adapter);
    // The host deserialises `limit: Option<u32>`; an explicit `undefined` is
    // fine over JSON, but sending the key at all when the caller gave no limit
    // makes the payloads harder to read in a trace for no benefit.
    adapter.invoke = ((command: never, payload: never) => {
      seen.push({ command, payload });
      return original(command, payload);
    }) as typeof adapter.invoke;

    await repo.list();
    await repo.search('anything');
    expect(seen).toEqual([
      { command: 'store_list_conversations', payload: {} },
      { command: 'store_search', payload: { query: 'anything' } },
    ]);
  });

  it('returns search results in their two labelled halves', async () => {
    const { adapter, repo } = repository();
    adapter.seedConversation({
      title: 'Rendering notes',
      messages: [{ text: 'how do sails work' }],
    });
    adapter.seedConversation({ title: 'Other', messages: [{ text: 'how does rendering work' }] });

    const found = await repo.search('rendering');
    expect(found.conversations.map((c) => c.title)).toEqual(['Rendering notes']);
    expect(found.messages.map((hit) => hit.conversationTitle)).toEqual(['Other']);
  });

  it('asks the host to name an untitled conversation, and is safe to ask twice', async () => {
    const { adapter, repo } = repository();
    const seeded = adapter.seedConversation({
      title: 'New conversation',
      messages: [{ text: 'Why is the night sky dark?' }],
    });

    const first = await repo.autotitle(seeded.id);
    const second = await repo.autotitle(seeded.id);
    expect(first.title).toBe('Why is the night sky dark?');
    expect(second.title).toBe(first.title);
  });
});
