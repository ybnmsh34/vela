/**
 * The fake host's navigation commands, tested the way the Rust ones are.
 *
 * Conventions §8: "Every `BrowserAdapter` command gets a vitest test mirroring
 * the Rust one. When they disagree, the fake is wrong." Each test here has a
 * counterpart in `src-tauri/src/ipc/store.rs` or `src-tauri/src/ipc/ui.rs`
 * asserting the same rule, and the two text rules they share are pinned by
 * `tests/parity/navigation.json`.
 *
 * **VERIFIED-BY-FAKE.** Nothing here is evidence about SQLite, FTS5 or a real
 * database file.
 */

import { describe, expect, it } from 'vitest';

import { UNTITLED_TITLE } from '@/lib/navigation-text';

import { BrowserAdapter } from './browser-adapter';
import { PlatformError } from './errors';

function adapter(): BrowserAdapter {
  return new BrowserAdapter({ now: () => 1_700_000_000_000 });
}

describe('store_create_conversation', () => {
  it('opens an untitled conversation the UI can recognise as one', async () => {
    const host = adapter();
    const { conversation } = await host.invoke('store_create_conversation', {});

    expect(conversation.title).toBe(UNTITLED_TITLE);
    expect(conversation.titleIsPlaceholder).toBe(true);
    expect(conversation.messageCount).toBe(0);
    expect(conversation.lastMessageAtMs).toBeNull();
  });

  it('refuses a blank title rather than storing one', async () => {
    const host = adapter();
    await expect(host.invoke('store_create_conversation', { title: '   ' })).rejects.toThrow(
      PlatformError,
    );
  });

  it('collapses whitespace in a supplied title', async () => {
    const host = adapter();
    const { conversation } = await host.invoke('store_create_conversation', {
      title: '  Star   charts  ',
    });
    expect(conversation.title).toBe('Star charts');
    expect(conversation.titleIsPlaceholder).toBe(false);
  });
});

describe('store_list_conversations', () => {
  it('carries no backend identity', async () => {
    const host = adapter();
    await host.invoke('store_create_conversation', { title: 'One' });

    const { conversations } = await host.invoke('store_list_conversations', {});
    const row = conversations[0] as unknown as Record<string, unknown>;
    // A field the renderer can read is a field the renderer will eventually
    // branch on. Conventions §0 rule 3.
    expect(row).not.toHaveProperty('providerId');
    expect(row).not.toHaveProperty('modelId');
  });

  it('lists most recently touched first', async () => {
    const host = new BrowserAdapter({ now: () => 1000 });
    const first = await host.invoke('store_create_conversation', { title: 'First' });
    const second = await host.invoke('store_create_conversation', { title: 'Second' });

    const { conversations } = await host.invoke('store_list_conversations', {});
    // Same millisecond: the host's tiebreak is `id DESC`, so the newer id wins.
    expect(conversations.map((c) => c.id)).toEqual([
      second.conversation.id,
      first.conversation.id,
    ]);
  });

  it('honours a limit', async () => {
    const host = adapter();
    for (const title of ['a', 'b', 'c']) {
      await host.invoke('store_create_conversation', { title });
    }
    const { conversations } = await host.invoke('store_list_conversations', { limit: 2 });
    expect(conversations).toHaveLength(2);
  });
});

describe('store_rename_conversation', () => {
  it('renames, and stops reporting the title as a placeholder', async () => {
    const host = adapter();
    const created = await host.invoke('store_create_conversation', {});

    const { conversation } = await host.invoke('store_rename_conversation', {
      conversationId: created.conversation.id,
      title: 'Star charts',
    });
    expect(conversation.title).toBe('Star charts');
    expect(conversation.titleIsPlaceholder).toBe(false);
  });

  it('is NOT_FOUND for a conversation that does not exist', async () => {
    const host = adapter();
    await expect(
      host.invoke('store_rename_conversation', { conversationId: 'conv_ghost', title: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('store_delete_conversation', () => {
  it('removes the conversation from the list', async () => {
    const host = adapter();
    const created = await host.invoke('store_create_conversation', {});
    await host.invoke('store_delete_conversation', {
      conversationId: created.conversation.id,
    });

    const { conversations } = await host.invoke('store_list_conversations', {});
    expect(conversations).toHaveLength(0);
  });

  it('is NOT_FOUND, not a silent success, for a conversation that is already gone', async () => {
    const host = adapter();
    await expect(
      host.invoke('store_delete_conversation', { conversationId: 'conv_ghost' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('store_autotitle_conversation', () => {
  it('names a placeholder after the first thing said in it', async () => {
    const host = adapter();
    const seeded = host.seedConversation({
      title: UNTITLED_TITLE,
      messages: [{ text: '## Why is the night sky dark?\n\nOlbers’ paradox, please.' }],
    });

    const { conversation } = await host.invoke('store_autotitle_conversation', {
      conversationId: seeded.id,
    });
    expect(conversation.title).toBe('Why is the night sky dark?');
    expect(conversation.titleIsPlaceholder).toBe(false);
  });

  it('never names a conversation after the model’s private thinking', async () => {
    const host = adapter();
    const seeded = host.seedConversation({
      title: UNTITLED_TITLE,
      messages: [
        {
          text: 'Vela is a southern constellation.',
          reasoning: 'the user probably means Vega, not Vela',
        },
      ],
    });

    const { conversation } = await host.invoke('store_autotitle_conversation', {
      conversationId: seeded.id,
    });
    expect(conversation.title).toBe('Vela is a southern constellation.');
    expect(conversation.title).not.toContain('probably');
  });

  it('leaves a user-chosen title and an empty conversation alone', async () => {
    const host = adapter();
    const named = host.seedConversation({
      title: 'Mine',
      messages: [{ text: 'something else entirely' }],
    });
    const empty = host.seedConversation({ title: UNTITLED_TITLE });

    await expect(
      host.invoke('store_autotitle_conversation', { conversationId: named.id }),
    ).resolves.toMatchObject({ conversation: { title: 'Mine' } });
    await expect(
      host.invoke('store_autotitle_conversation', { conversationId: empty.id }),
    ).resolves.toMatchObject({ conversation: { title: UNTITLED_TITLE, titleIsPlaceholder: true } });
  });
});

describe('store_search', () => {
  it('finds a title the content index cannot, and labels the halves', async () => {
    const host = adapter();
    host.seedConversation({ title: 'Rendering notes', messages: [{ text: 'how do sails work' }] });
    host.seedConversation({ title: 'Other', messages: [{ text: 'how does rendering work' }] });

    const found = await host.invoke('store_search', { query: 'rendering' });
    expect(found.conversations.map((c) => c.title)).toEqual(['Rendering notes']);
    expect(found.messages).toHaveLength(1);
    expect(found.messages[0]?.kind).toBe('answer');
    expect(found.messages[0]?.snippet).toContain('[rendering]');
  });

  it('labels a hit inside a reasoning block as one', async () => {
    const host = adapter();
    host.seedConversation({
      title: 'Distances',
      messages: [
        { text: 'About 310 light years.', reasoning: 'parallax puts it at 310 light years' },
      ],
    });

    const found = await host.invoke('store_search', { query: 'parallax' });
    expect(found.messages.map((hit) => hit.kind)).toEqual(['reasoning']);
  });

  it('searches with text the FTS grammar would reject', async () => {
    const host = adapter();
    host.seedConversation({ title: 'Deals', messages: [{ text: 'the deal with sails' }] });

    // Raw, `"the deal` is an unbalanced quote and an FTS5 syntax error. The
    // user typed it into a search box, so it must simply search.
    const found = await host.invoke('store_search', { query: '"the deal' });
    expect(found.messages).toHaveLength(1);
  });

  it('matches a prefix while the user is still typing', async () => {
    const host = adapter();
    host.seedConversation({ title: 'Nav', messages: [{ text: 'constellation navigation' }] });

    for (const typed of ['const', 'constell', 'constellation nav']) {
      const found = await host.invoke('store_search', { query: typed });
      expect(found.messages, `\`${typed}\` found nothing`).toHaveLength(1);
    }
  });

  it('treats punctuation alone as a title search and asks nothing of the index', async () => {
    const host = adapter();
    host.seedConversation({ title: '100% context', messages: [{ text: 'nothing relevant' }] });

    const found = await host.invoke('store_search', { query: '%' });
    expect(found.conversations).toHaveLength(1);
    expect(found.messages).toHaveLength(0);
  });

  it('returns an empty result for an empty query rather than failing', async () => {
    const host = adapter();
    host.seedConversation({ title: 'Anything' });

    const found = await host.invoke('store_search', { query: '   ' });
    expect(found.conversations).toHaveLength(0);
    expect(found.messages).toHaveLength(0);
  });
});

describe('ui_get_layout / ui_set_layout', () => {
  it('starts at a usable default', async () => {
    const host = adapter();
    await expect(host.invoke('ui_get_layout', {})).resolves.toEqual({
      sidebarWidth: 280,
      sidebarCollapsed: false,
    });
  });

  it('remembers a width, and keeps it while collapsed so expanding restores it', async () => {
    const host = adapter();
    await host.invoke('ui_set_layout', { sidebarWidth: 400, sidebarCollapsed: true });

    await expect(host.invoke('ui_get_layout', {})).resolves.toEqual({
      sidebarWidth: 400,
      sidebarCollapsed: true,
    });
  });

  it('clamps an out-of-range width rather than refusing it', async () => {
    const host = adapter();
    await expect(
      host.invoke('ui_set_layout', { sidebarWidth: 9999, sidebarCollapsed: false }),
    ).resolves.toMatchObject({ sidebarWidth: 480 });
    await expect(
      host.invoke('ui_set_layout', { sidebarWidth: 0, sidebarCollapsed: false }),
    ).resolves.toMatchObject({ sidebarWidth: 200 });
  });
});
