import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { App } from '@/app/App';
import { BrowserAdapter } from '@/platform/browser-adapter';

/**
 * Proves the shell renders against the injected fake adapter with no Tauri
 * runtime present — the property that makes the UI screenshot-able on a
 * headless machine.
 */
describe('AppShell', () => {
  it('renders the Vela identity and the reserved regions', async () => {
    render(<App adapter={new BrowserAdapter()} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Vela' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByText('src/features/chat')).toBeInTheDocument();

    expect(await screen.findByText(/Bridge ready/)).toBeInTheDocument();
  });

  it('reports the live adapter and states plainly that the store is not a real keychain', async () => {
    render(<App adapter={new BrowserAdapter()} />);

    expect(screen.getByTestId('adapter-kind')).toHaveTextContent('browser');
    // Honesty requirement: a screenshot of this screen must never be mistakable
    // for evidence that a real OS keychain was exercised.
    expect(await screen.findByTestId('secret-backend')).toHaveTextContent(
      'memory-fake (not a real keychain)',
    );
  });

  it('surfaces a host failure instead of rendering a broken empty state', async () => {
    class FailingAdapter extends BrowserAdapter {
      override async invoke(): Promise<never> {
        throw new Error('host is down');
      }
    }

    render(<App adapter={new FailingAdapter()} />);
    expect(await screen.findByText(/Bridge unavailable · INTERNAL/)).toBeInTheDocument();
  });

  it('cycles the theme preference from the title bar', async () => {
    const user = userEvent.setup();
    render(<App adapter={new BrowserAdapter()} />);

    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);

    await user.click(screen.getByRole('button', { name: /^Theme:/ }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    await user.click(screen.getByRole('button', { name: /^Theme:/ }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
