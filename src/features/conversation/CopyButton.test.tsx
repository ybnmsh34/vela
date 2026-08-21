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

  /**
   * RULE V, ON THE ONE `.tsx` LINE THIS BRANCH ADDED.
   *
   * `aria-live="polite"` was added with a comment above it that names
   * `CopyButton.test.tsx` as the file addressing this button by name.
   * Deleting the attribute reddened nothing: `grep -rn aria-live src
   * --include="*.test.tsx" --include="*.test.ts"` returned no hit anywhere in
   * the repository, this file included. The property the change establishes was
   * asserted only by the comment describing it.
   *
   * WHAT THIS PROVES AND WHAT IT DOES NOT. It proves the two halves that live in
   * the DOM: the live region is on the element whose contents change, and the
   * accessible name does not move when they do — which is the whole reason the
   * outcome was put in the contents rather than in `aria-label`. It does **not**
   * prove that any screen reader speaks the change. That needs a real AT and a
   * real window, neither of which this track may open, and it is a
   * known-unreliable path besides: this live region is also the focused element
   * and carries an `aria-label`, and implementations differ on whether they
   * announce the author name or the changed contents in that situation. WCAG
   * 4.1.3 is therefore not closed by this test and is not claimed to be; WCAG
   * 2.5.3 (Label in Name) is separately still open, because `aria-label` stays
   * `label` and the visible text becomes "Copied".
   */
  it('announces the outcome without moving the name the app addresses it by', async () => {
    const user = userEvent.setup();
    withClipboard(async () => undefined);
    render(<CopyButton getText={() => 'x'} label="Copy this reply" />);

    const before = screen.getByRole('button', { name: 'Copy this reply' });
    expect(before).toHaveAttribute('aria-live', 'polite');
    expect(before).toHaveTextContent('Copy');

    await user.click(before);

    // The name is what every other call site addresses this button by — five
    // more assertions in this file spell it `{ name: 'Copy' }`, and
    // `ConversationSurface.test.tsx` spells it `{ name: 'Copy ts code' }` — and
    // it is unchanged. The contents are what the live region announces, and
    // they are not.
    const after = await screen.findByRole('button', { name: 'Copy this reply' });
    expect(after).toHaveTextContent('Copied');
    expect(after).toHaveAttribute('aria-live', 'polite');
    // The live region and the changed node are ONE element. A polite region on
    // a wrapper, with the text swapped inside a child, is a different thing and
    // would pass a looser assertion than this one.
    expect(after.textContent).toBe('Copied');
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
