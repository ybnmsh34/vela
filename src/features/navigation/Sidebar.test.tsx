import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { BrowserAdapter } from '@/platform/browser-adapter';
import { PlatformProvider } from '@/platform/PlatformProvider';
import { resetNavigationStore, useNavigationStore } from '@/state/navigation-store';

import { ConversationsProvider } from './ConversationsProvider';
import { Sidebar } from './Sidebar';
import { KeyboardProvider } from '@/platform/KeyboardProvider';

/** 2026-08-13, 14:00 local, so "Yesterday" is reachable in one test run. */
const NOW = new Date(2026, 7, 13, 14, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

function mount(adapter: BrowserAdapter) {
  return render(
    <KeyboardProvider>
      <PlatformProvider adapter={adapter}>
        <ConversationsProvider>
          <Sidebar now={() => NOW} />
        </ConversationsProvider>
      </PlatformProvider>
    </KeyboardProvider>,
  );
}

function host(): BrowserAdapter {
  return new BrowserAdapter({ now: () => NOW });
}

beforeEach(() => {
  resetNavigationStore();
});

describe('Sidebar', () => {
  it('groups conversations by recency, newest group first', async () => {
    const adapter = host();
    adapter.seedConversation({ title: 'From today', updatedAtMs: NOW - 60_000 });
    adapter.seedConversation({ title: 'From yesterday', updatedAtMs: NOW - DAY });
    adapter.seedConversation({ title: 'From last week', updatedAtMs: NOW - 5 * DAY });
    mount(adapter);

    await screen.findByText('From today');
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Today',
      'Yesterday',
      'Previous 7 days',
    ]);
  });

  it('creates a conversation and selects it', async () => {
    const user = userEvent.setup();
    const adapter = host();
    mount(adapter);

    await screen.findByText('No conversations yet.');
    await user.click(screen.getByRole('button', { name: /New conversation/ }));

    await screen.findByRole('button', { name: 'Open New conversation' });
    await waitFor(() => {
      expect(useNavigationStore.getState().selectedConversationId).not.toBeNull();
    });
  });

  it('marks the open conversation as the current one', async () => {
    const user = userEvent.setup();
    const adapter = host();
    adapter.seedConversation({ title: 'Star charts' });
    mount(adapter);

    const row = await screen.findByRole('button', { name: 'Open Star charts' });
    await user.click(row);
    expect(row).toHaveAttribute('aria-current', 'page');
  });

  it('renames in place, and sends the new title to the host', async () => {
    const user = userEvent.setup();
    const adapter = host();
    adapter.seedConversation({ title: 'Star charts' });
    mount(adapter);

    await user.click(await screen.findByRole('button', { name: 'Rename Star charts' }));
    const field = screen.getByRole('textbox', { name: 'Rename Star charts' });
    await user.clear(field);
    await user.type(field, 'Southern sky{Enter}');

    expect(await screen.findByText('Southern sky')).toBeInTheDocument();
    // Reloaded from the host, not just repainted locally.
    const { conversations } = await adapter.invoke('store_list_conversations', {});
    expect(conversations.map((c) => c.title)).toEqual(['Southern sky']);
  });

  it('abandons a rename on Escape without touching the host', async () => {
    const user = userEvent.setup();
    const adapter = host();
    adapter.seedConversation({ title: 'Star charts' });
    mount(adapter);

    await user.click(await screen.findByRole('button', { name: 'Rename Star charts' }));
    const field = screen.getByRole('textbox', { name: 'Rename Star charts' });
    await user.clear(field);
    await user.type(field, 'Discarded{Escape}');

    expect(await screen.findByText('Star charts')).toBeInTheDocument();
    const { conversations } = await adapter.invoke('store_list_conversations', {});
    expect(conversations.map((c) => c.title)).toEqual(['Star charts']);
  });

  it('will not delete without a confirmation, and cancelling keeps the conversation', async () => {
    const user = userEvent.setup();
    const adapter = host();
    adapter.seedConversation({ title: 'Star charts' });
    mount(adapter);

    await user.click(await screen.findByRole('button', { name: 'Delete Star charts' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/cannot be undone/)).toBeInTheDocument();
    // The safe choice holds focus, never the destructive one.
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Star charts')).toBeInTheDocument();
    const { conversations } = await adapter.invoke('store_list_conversations', {});
    expect(conversations).toHaveLength(1);
  });

  it('deletes once confirmed, and clears the selection if it was the open one', async () => {
    const user = userEvent.setup();
    const adapter = host();
    adapter.seedConversation({ title: 'Star charts' });
    mount(adapter);

    await user.click(await screen.findByRole('button', { name: 'Open Star charts' }));
    await user.click(screen.getByRole('button', { name: 'Delete Star charts' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('No conversations yet.')).toBeInTheDocument();
    await waitFor(() => {
      expect(useNavigationStore.getState().selectedConversationId).toBeNull();
    });
  });

  it('moves between rows with the arrow keys, one Tab to enter the list', async () => {
    const user = userEvent.setup();
    const adapter = host();
    adapter.seedConversation({ title: 'First', updatedAtMs: NOW - 1000 });
    adapter.seedConversation({ title: 'Second', updatedAtMs: NOW - 2000 });
    adapter.seedConversation({ title: 'Third', updatedAtMs: NOW - 3000 });
    mount(adapter);

    const first = await screen.findByRole('button', { name: 'Open First' });
    first.focus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: 'Open Second' })).toHaveFocus();
    await user.keyboard('{ArrowDown}{ArrowUp}');
    expect(screen.getByRole('button', { name: 'Open Second' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('button', { name: 'Open Third' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(first).toHaveFocus();

    // Roving tabindex: exactly one row is tabbable, so Tab steps past the list
    // rather than through forty conversations.
    const tabbable = screen
      .getAllByRole('button')
      .filter((element) => element.getAttribute('aria-current') !== null || element.tabIndex === 0);
    expect(tabbable.filter((element) => element.closest('li') !== null)).toHaveLength(1);
  });

  it('asks to delete the focused row on Delete', async () => {
    const user = userEvent.setup();
    const adapter = host();
    adapter.seedConversation({ title: 'Star charts' });
    mount(adapter);

    (await screen.findByRole('button', { name: 'Open Star charts' })).focus();
    await user.keyboard('{Delete}');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('renames the focused row on F2', async () => {
    const user = userEvent.setup();
    const adapter = host();
    adapter.seedConversation({ title: 'Star charts' });
    mount(adapter);

    (await screen.findByRole('button', { name: 'Open Star charts' })).focus();
    await user.keyboard('{F2}');
    expect(screen.getByRole('textbox', { name: 'Rename Star charts' })).toHaveFocus();
  });

  it('says the store is unreachable instead of showing an empty list', async () => {
    class FailingAdapter extends BrowserAdapter {
      override async invoke(): Promise<never> {
        throw new Error('host is down');
      }
    }
    mount(new FailingAdapter());

    // An empty list and a broken bridge look identical otherwise, and one of
    // them is a lie about the user's data.
    expect(await screen.findByText(/Conversations unavailable/)).toBeInTheDocument();
    expect(screen.queryByText('No conversations yet.')).not.toBeInTheDocument();
  });

  it('resizes by keyboard through the separator, and reports the width', async () => {
    const user = userEvent.setup();
    mount(host());

    const handle = await screen.findByRole('separator', { name: 'Resize sidebar' });
    expect(handle).toHaveAttribute('aria-valuenow', '280');

    handle.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(handle).toHaveAttribute('aria-valuenow', '312');

    // Clamped at the host's own bounds rather than growing without limit.
    for (let index = 0; index < 20; index += 1) await user.keyboard('{ArrowRight}');
    expect(handle).toHaveAttribute('aria-valuenow', '480');
  });

  it('collapses to a rail and expands again', async () => {
    const user = userEvent.setup();
    mount(host());

    await user.click(await screen.findByRole('button', { name: 'Collapse sidebar' }));
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
    expect(screen.queryByRole('separator', { name: 'Resize sidebar' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(screen.getByRole('separator', { name: 'Resize sidebar' })).toBeInTheDocument();
  });

  it('names an untitled conversation once there is something to name it after', async () => {
    const adapter = host();
    adapter.seedConversation({
      title: 'New conversation',
      messages: [{ text: 'Why is the night sky dark?' }],
    });
    mount(adapter);

    expect(await screen.findByText('Why is the night sky dark?')).toBeInTheDocument();
  });

  it('leaves an empty untitled conversation showing its placeholder', async () => {
    const adapter = host();
    adapter.seedConversation({ title: 'New conversation' });
    mount(adapter);

    expect(await screen.findByText('New conversation')).toBeInTheDocument();
    expect(screen.getByText('Nothing said yet')).toBeInTheDocument();
  });
});
