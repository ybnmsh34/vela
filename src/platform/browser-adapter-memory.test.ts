/**
 * The fake host's memory commands, against the rules the real one keeps.
 *
 * `BrowserAdapter` is what every headless test and `pnpm dev` in a browser
 * talks to, so a rule it does not reproduce is a rule the UI is never exercised
 * against. The three that matter here are the three
 * `src-tauri/src/ipc/memory.rs` and `vela-store` are tested for: scope
 * isolation, the pinned-then-recency order, and refusing a blank entry rather
 * than storing an empty line.
 *
 * **Honesty (conventions §10): VERIFIED-BY-FAKE.** Nothing here says anything
 * about SQLite. It says the fake and the host agree about behaviour the UI
 * depends on.
 */

import { describe, expect, it } from 'vitest';

import { BrowserAdapter } from './browser-adapter';
import { MEMORY_CONTENT_MAX_CHARS, type MemoryScope } from './contract';
import { PlatformError } from './errors';

const GLOBAL: MemoryScope = { kind: 'global' };
const ALPHA: MemoryScope = { kind: 'project', projectId: 'proj_alpha' };
const BETA: MemoryScope = { kind: 'project', projectId: 'proj_beta' };

async function add(adapter: BrowserAdapter, scope: MemoryScope, content: string): Promise<string> {
  const result = await adapter.invoke('memory_add', {
    scope,
    category: 'techPrefs',
    content,
  });
  return result.entry.id;
}

describe('memory in the fake host', () => {
  it('lists back what was written, trimmed, and unpinned by default', async () => {
    const adapter = new BrowserAdapter();
    await add(adapter, GLOBAL, '  uses pnpm, never npm  ');

    const { entries } = await adapter.invoke('memory_list', { scope: GLOBAL });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.content).toBe('uses pnpm, never npm');
    expect(entries[0]?.pinned).toBe(false);
    expect(entries[0]?.sourceConversationId).toBeNull();
  });

  it('never lets one scope see another', async () => {
    // MEM-2's only claim. The fake keeps it by bucketing on read; the host
    // keeps it with a WHERE clause and a test of its own.
    const adapter = new BrowserAdapter();
    await add(adapter, GLOBAL, 'global fact');
    await add(adapter, ALPHA, 'alpha fact');
    await add(adapter, BETA, 'beta fact');

    const global = await adapter.invoke('memory_list', { scope: GLOBAL });
    const alpha = await adapter.invoke('memory_list', { scope: ALPHA });
    expect(global.entries.map((entry) => entry.content)).toEqual(['global fact']);
    expect(alpha.entries.map((entry) => entry.content)).toEqual(['alpha fact']);
  });

  it('puts pinned entries first, then the most recently updated', async () => {
    // The injection order. A consumer that takes the first N under a budget
    // must take the same N against either host.
    let clock = 1_000;
    const adapter = new BrowserAdapter({
      now: () => {
        clock += 1_000;
        return clock;
      },
    });
    const oldest = await add(adapter, GLOBAL, 'oldest');
    const middle = await add(adapter, GLOBAL, 'middle');
    const newest = await add(adapter, GLOBAL, 'newest');

    await adapter.invoke('memory_update', { entryId: oldest, pinned: true });

    const { entries } = await adapter.invoke('memory_list', { scope: GLOBAL });
    expect(entries.map((entry) => entry.id)).toEqual([oldest, newest, middle]);
  });

  it('refuses a blank entry rather than storing an empty line', async () => {
    const adapter = new BrowserAdapter();
    await expect(
      adapter.invoke('memory_add', { scope: GLOBAL, category: 'other', content: '   ' }),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
  });

  it('refuses an entry longer than the host accepts, at the same limit', async () => {
    const adapter = new BrowserAdapter();
    await expect(
      adapter.invoke('memory_add', {
        scope: GLOBAL,
        category: 'other',
        content: 'x'.repeat(MEMORY_CONTENT_MAX_CHARS + 1),
      }),
    ).rejects.toBeInstanceOf(PlatformError);
    // One under is fine — the bound is inclusive on both sides.
    await expect(
      adapter.invoke('memory_add', {
        scope: GLOBAL,
        category: 'other',
        content: 'x'.repeat(MEMORY_CONTENT_MAX_CHARS),
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a project scope with a blank id instead of writing a bucket nothing lists', async () => {
    const adapter = new BrowserAdapter();
    await expect(
      adapter.invoke('memory_add', {
        scope: { kind: 'project', projectId: '  ' },
        category: 'other',
        content: 'orphan',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
  });

  it('amends only the fields supplied, and cannot move an entry between scopes', async () => {
    const adapter = new BrowserAdapter();
    const id = await add(adapter, GLOBAL, 'prefers tabs');

    const { entry } = await adapter.invoke('memory_update', { entryId: id, content: 'prefers spaces' });
    expect(entry.content).toBe('prefers spaces');
    expect(entry.category).toBe('techPrefs');
    expect(entry.scope).toEqual(GLOBAL);
  });

  it('reports a missing entry rather than succeeding quietly', async () => {
    const adapter = new BrowserAdapter();
    await expect(adapter.invoke('memory_delete', { entryId: 'mem_nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('empties one scope and says how many entries went', async () => {
    const adapter = new BrowserAdapter();
    await add(adapter, GLOBAL, 'one');
    await add(adapter, GLOBAL, 'two');
    await add(adapter, ALPHA, 'kept');

    const cleared = await adapter.invoke('memory_clear_scope', { scope: GLOBAL });
    expect(cleared.removed).toBe(2);
    expect((await adapter.invoke('memory_list', { scope: GLOBAL })).entries).toEqual([]);
    expect((await adapter.invoke('memory_list', { scope: ALPHA })).entries).toHaveLength(1);
  });
});
