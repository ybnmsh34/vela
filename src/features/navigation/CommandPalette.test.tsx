import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { BrowserAdapter } from '@/platform/browser-adapter';
import { PlatformProvider } from '@/platform/PlatformProvider';
import { resetNavigationStore, useNavigationStore } from '@/state/navigation-store';

import { CommandPalette } from './CommandPalette';
import { ConversationsProvider } from './ConversationsProvider';
import { useNavigationShortcuts } from './use-navigation-shortcuts';

/** Mounts the palette with the shortcuts that open it, as the app does. */
function Harness() {
  useNavigationShortcuts({ onNewConversation: () => undefined });
  return <CommandPalette debounceMs={0} />;
}

function mount(adapter: BrowserAdapter) {
  return render(
    <PlatformProvider adapter={adapter}>
      <ConversationsProvider>
        <Harness />
      </ConversationsProvider>
    </PlatformProvider>,
  );
}

function host(): BrowserAdapter {
  return new BrowserAdapter({ now: () => 1_700_000_000_000 });
}

beforeEach(() => {
  resetNavigationStore();
});

describe('CommandPalette', () => {
  it('is closed until asked for, and Ctrl+K opens the switcher', async () => {
    const user = userEvent.setup();
    mount(host());

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('combobox', { name: 'Go to conversation' })).toHaveFocus();
  });

  it('opens in search mode on Ctrl+F, with a label that says so', async () => {
    const user = userEvent.setup();
    mount(host());

    await user.keyboard('{Control>}f{/Control}');
    expect(await screen.findByRole('combobox', { name: 'Search conversations' })).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    mount(host());

    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('filters conversations as you type and opens the one you pick', async () => {
    const user = userEvent.setup();
    const adapter = host();
    adapter.seedConversation({ title: 'Star charts' });
    const other = adapter.seedConversation({ title: 'Rendering notes' });
    mount(adapter);

    await user.keyboard('{Control>}k{/Control}');
    const field = await screen.findByRole('combobox');
    await user.type(field, 'render');

    await waitFor(() => {
      expect(screen.queryByRole('option', { name: /Star charts/ })).not.toBeInTheDocument();
    });
    await user.keyboard('{ArrowDown}{Enter}');

    expect(useNavigationStore.getState().selectedConversationId).toBe(other.id);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('moves a highlight with the arrows while focus stays in the text field', async () => {
    const user = userEvent.setup();
    const adapter = host();
    adapter.seedConversation({ title: 'Alpha' });
    adapter.seedConversation({ title: 'Beta' });
    mount(adapter);

    await user.keyboard('{Control>}k{/Control}');
    const field = await screen.findByRole('combobox');
    await waitFor(() => {
      expect(screen.getAllByRole('option').length).toBeGreaterThan(1);
    });

    // The first row is the action, so one press lands on the first conversation.
    await user.keyboard('{ArrowDown}');
    expect(field).toHaveFocus();
    const active = document.getElementById(field.getAttribute('aria-activedescendant') ?? '');
    expect(active).toHaveAttribute('aria-selected', 'true');
    expect(active?.textContent).toContain('Beta');
  });

  it('searches message content and says which conversation the hit is in', async () => {
    const user = userEvent.setup();
    const adapter = host();
    adapter.seedConversation({
      title: 'Distances',
      messages: [{ text: 'Canopus is 310 light years away.' }],
    });
    mount(adapter);

    await user.keyboard('{Control>}f{/Control}');
    await user.type(await screen.findByRole('combobox'), 'canopus');

    const hit = await screen.findByRole('option', { name: /In message/ });
    expect(hit.textContent).toContain('Distances');
    expect(hit.querySelector('mark')?.textContent).toBe('Canopus');
  });

  it('says a match came from thinking rather than quoting it as an answer', async () => {
    const user = userEvent.setup();
    const adapter = host();
    adapter.seedConversation({
      title: 'Distances',
      messages: [
        { text: 'About 310 light years.', reasoning: 'parallax puts it at 310 light years' },
      ],
    });
    mount(adapter);

    await user.keyboard('{Control>}f{/Control}');
    await user.type(await screen.findByRole('combobox'), 'parallax');

    expect(await screen.findByRole('option', { name: /In thinking/ })).toBeInTheDocument();
  });

  it('reports a failed search instead of claiming there are no results', async () => {
    const user = userEvent.setup();
    class HalfBrokenAdapter extends BrowserAdapter {
      override async invoke(command: never, payload: never): Promise<never> {
        if (command === 'store_search') throw new Error('index unavailable');
        return super.invoke(command, payload) as Promise<never>;
      }
    }
    mount(new HalfBrokenAdapter());

    await user.keyboard('{Control>}f{/Control}');
    await user.type(await screen.findByRole('combobox'), 'anything');

    // "No results" is a claim about the user's data. "Search unavailable" is a
    // claim about Vela. They must never be confused.
    expect(await screen.findByText(/Search unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/No conversation or message matches/)).not.toBeInTheDocument();
  });

  it('says plainly when nothing matches', async () => {
    const user = userEvent.setup();
    const adapter = host();
    adapter.seedConversation({ title: 'Star charts' });
    mount(adapter);

    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox'), 'zzzz');

    expect(await screen.findByText(/No conversation or message matches/)).toBeInTheDocument();
  });

  it('offers a new conversation as the first row', async () => {
    const user = userEvent.setup();
    mount(host());

    await user.keyboard('{Control>}k{/Control}');
    const options = await screen.findAllByRole('option');
    expect(options[0]?.textContent).toContain('New conversation');

    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(useNavigationStore.getState().selectedConversationId).not.toBeNull();
    });
  });
});
