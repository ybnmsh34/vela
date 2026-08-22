import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CopyButton } from './CopyButton';

/**
 * Installs a clipboard stub **after** `userEvent.setup()`, which installs one of
 * its own. Setting it first is the trap: user-event silently replaces it, and
 * the test then asserts against a stub it does not own.
 */
function withClipboard(writeText: (value: string) => Promise<void>): void {
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis.navigator, 'clipboard');
});

describe('the copy affordance', () => {
  it('copies the text the getter returns at click time, not at render time', async () => {
    const user = userEvent.setup();
    const written: string[] = [];
    withClipboard(async (value) => {
      written.push(value);
    });
    let live = 'partial';
    render(<CopyButton getText={() => live} label="Copy this reply" />);

    live = 'the whole answer';
    await user.click(screen.getByRole('button', { name: 'Copy this reply' }));

    expect(written).toEqual(['the whole answer']);
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  /**
   * A refused clipboard write with a checkmark on top is worse than no button:
   * the user walks away believing they have the text.
   */
  it('says so when the clipboard refuses', async () => {
    const user = userEvent.setup();
    withClipboard(() => Promise.reject(new Error('denied')));
    render(<CopyButton getText={() => 'x'} label="Copy" />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByText('Copy failed')).toBeInTheDocument();
  });

  it('says so when there is no clipboard API at all', async () => {
    const user = userEvent.setup();
    Reflect.deleteProperty(globalThis.navigator, 'clipboard');
    render(<CopyButton getText={() => 'x'} label="Copy" />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByText('Copy failed')).toBeInTheDocument();
  });

  it('returns to idle after the confirmation', async () => {
    vi.useFakeTimers();
    try {
      withClipboard(async () => undefined);
      render(<CopyButton getText={() => 'x'} label="Copy" />);

      // `fireEvent` rather than `userEvent`, and `act` rather than `findBy*`:
      // Testing Library's async helpers poll on a real timer, which a fake
      // clock stops dead.
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      });
      expect(screen.getByRole('button', { name: 'Copy' })).toHaveTextContent('Copied');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(screen.getByRole('button', { name: 'Copy' })).toHaveTextContent('Copy');
    } finally {
      vi.useRealTimers();
    }
  });
});
