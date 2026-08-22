import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { BrowserAdapter } from '@/platform/browser-adapter';
import { PlatformProvider } from '@/platform/PlatformProvider';
import { resetNavigationStore, useNavigationStore } from '@/state/navigation-store';

import { ConversationsProvider } from './ConversationsProvider';
import { HomeSurface } from './HomeSurface';
import { KeyboardProvider } from '@/platform/KeyboardProvider';

function mount(adapter: BrowserAdapter, secretBackend: string | null = 'memory-fake') {
  return render(
    <KeyboardProvider>
      <PlatformProvider adapter={adapter}>
        <ConversationsProvider>
          <HomeSurface secretBackend={secretBackend} />
        </ConversationsProvider>
      </PlatformProvider>
    </KeyboardProvider>,
  );
}

beforeEach(() => {
  resetNavigationStore();
});

describe('HomeSurface', () => {
  it('states the proposition in the user’s terms, not in marketing', () => {
    mount(new BrowserAdapter());

    expect(screen.getByRole('heading', { level: 1, name: 'Vela' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'You bring the model' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Vela brings the rest' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Nothing leaves except what you point it at' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/ships no model/)).toBeInTheDocument();
  });

  it('states plainly that the credential store is not a real keychain', () => {
    // Conventions §10. The Phase A placeholder carried this readout; whatever
    // replaces it has to carry it too, or a screenshot becomes a false claim.
    mount(new BrowserAdapter(), 'memory-fake');

    expect(screen.getByTestId('adapter-kind')).toHaveTextContent('browser');
    expect(screen.getByTestId('secret-backend')).toHaveTextContent(
      'memory-fake (not a real keychain)',
    );
  });

  it('does not disclaim a real keychain when the host reports one', () => {
    mount(new BrowserAdapter(), 'os-keychain');
    expect(screen.getByTestId('secret-backend')).toHaveTextContent('os-keychain');
    expect(screen.getByTestId('secret-backend')).not.toHaveTextContent('not a real keychain');
  });

  it('says the backend is still unknown rather than guessing one', () => {
    mount(new BrowserAdapter(), null);
    expect(screen.getByTestId('secret-backend')).toHaveTextContent('checking…');
  });

  it('starts a conversation and opens it', async () => {
    const user = userEvent.setup();
    mount(new BrowserAdapter());

    await user.click(screen.getByRole('button', { name: 'Start a conversation' }));
    await waitFor(() => {
      expect(useNavigationStore.getState().selectedConversationId).not.toBeNull();
    });
  });

  it('offers recent conversations to resume, and opens the one picked', async () => {
    const user = userEvent.setup();
    const adapter = new BrowserAdapter();
    const seeded = adapter.seedConversation({
      title: 'Star charts',
      messages: [{ text: 'hello' }],
    });
    mount(adapter);

    await user.click(await screen.findByRole('button', { name: /Star charts/ }));
    expect(useNavigationStore.getState().selectedConversationId).toBe(seeded.id);
  });

  it('shows no "pick up where you left off" section when there is nothing to pick up', async () => {
    mount(new BrowserAdapter());
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Recent conversations' })).not.toBeInTheDocument();
    });
  });

  it('opens search from the home screen', async () => {
    const user = userEvent.setup();
    mount(new BrowserAdapter());

    await user.click(screen.getByRole('button', { name: /Search everything/ }));
    expect(useNavigationStore.getState().paletteMode).toBe('search');
  });
});
