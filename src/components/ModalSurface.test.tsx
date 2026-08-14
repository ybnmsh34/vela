/**
 * The containment itself, below the level `src/app/modal-containment.test.tsx`
 * reaches.
 *
 * That file drives the real dialogs inside the real application, which is what
 * makes it evidence. What it cannot stage are the two shapes no dialog in Vela
 * currently has and the next one might: a dialog holding exactly **one**
 * focusable child, and one holding **none**. Both are the cases a naive
 * next-index wrap gets wrong — the first by wrapping past itself into nothing,
 * the second by having nothing to wrap onto and either throwing or looping.
 *
 * The background here is real markup rendered beside the surface, not a mock:
 * the question being asked is whether Tab can reach it, and a stub cannot answer
 * that question about itself.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetFocusStore } from '@/state/focus-store';

import { ModalSurface } from './ModalSurface';

/** Controls outside the dialog, which `aria-modal` says cannot be reached. */
function Background() {
  return (
    <div>
      <button type="button">behind one</button>
      <button type="button">behind two</button>
      <input aria-label="behind three" />
      <a href="https://example.invalid">behind four</a>
    </div>
  );
}

function background(): readonly HTMLElement[] {
  return [
    screen.getByRole('button', { name: 'behind one' }),
    screen.getByRole('button', { name: 'behind two' }),
    screen.getByRole('textbox', { name: 'behind three' }),
    screen.getByRole('link', { name: 'behind four' }),
  ];
}

beforeEach(() => {
  resetFocusStore();
});

describe('ModalSurface contains Tab', () => {
  it('wraps forward off the last stop onto the first', async () => {
    const user = userEvent.setup();
    render(
      <ModalSurface label="Three" onDismiss={() => undefined}>
        <button type="button">one</button>
        <button type="button">two</button>
        <button type="button">three</button>
      </ModalSurface>,
    );

    // No initialFocus given: the first stop inside, never anything outside.
    expect(screen.getByRole('button', { name: 'one' })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole('button', { name: 'two' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'three' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'one' })).toHaveFocus();
  });

  it('wraps backward off the first stop onto the last', async () => {
    const user = userEvent.setup();
    render(
      <ModalSurface label="Three" onDismiss={() => undefined}>
        <button type="button">one</button>
        <button type="button">two</button>
        <button type="button">three</button>
      </ModalSurface>,
    );

    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'three' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'two' })).toHaveFocus();
  });

  it('leaves nothing outside the dialog reachable in either direction', async () => {
    const user = userEvent.setup();
    const dialogLabel = 'Contained';
    render(
      <>
        <Background />
        <ModalSurface label={dialogLabel} onDismiss={() => undefined}>
          <button type="button">inside one</button>
          <button type="button">inside two</button>
        </ModalSurface>
      </>,
    );

    const dialog = screen.getByRole('dialog', { name: dialogLabel });
    // The control: four real, enabled, tabbable controls are sitting there.
    expect(background().every((element) => element.tabIndex >= 0)).toBe(true);

    for (let press = 0; press < 6; press += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    for (let press = 0; press < 6; press += 1) {
      await user.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    expect(background()).not.toContain(document.activeElement);
  });

  it('holds a dialog with exactly one focusable child on that child', async () => {
    // "The next stop" has to mean itself here. A wrap that indexes past the end
    // and trusts the result lands on `undefined`, and the press escapes.
    const user = userEvent.setup();
    render(
      <>
        <Background />
        <ModalSurface label="Only one" onDismiss={() => undefined}>
          <button type="button">the only one</button>
        </ModalSurface>
      </>,
    );

    const only = screen.getByRole('button', { name: 'the only one' });
    expect(only).toHaveFocus();

    await user.tab();
    expect(only).toHaveFocus();
    await user.tab({ shift: true });
    expect(only).toHaveFocus();
  });

  it('does not throw or wander when the dialog has nothing focusable in it', async () => {
    // The degenerate case: a dialog that is only a sentence. Focus has to land
    // somewhere or the key handler never runs, so it lands on the panel — which
    // is exactly what `tabIndex={-1}` on the box is for.
    const user = userEvent.setup();
    render(
      <>
        <Background />
        <ModalSurface label="Nothing to do" onDismiss={() => undefined}>
          <p>Working…</p>
        </ModalSurface>
      </>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Nothing to do' });
    expect(dialog).toHaveFocus();

    await user.tab();
    expect(dialog).toHaveFocus();
    await user.tab({ shift: true });
    expect(dialog).toHaveFocus();
    expect(background()).not.toContain(document.activeElement);
  });

  it('does not count a disabled control as somewhere the keyboard can go', async () => {
    const user = userEvent.setup();
    render(
      <ModalSurface label="One live control" onDismiss={() => undefined}>
        <button type="button" disabled>
          unavailable
        </button>
        <button type="button">live</button>
      </ModalSurface>,
    );

    // Not the disabled first child: the stop set is what a browser would stop
    // on, not the child list.
    expect(screen.getByRole('button', { name: 'live' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'live' })).toHaveFocus();
  });
});

describe('ModalSurface gives the keyboard back', () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button
          type="button"
          onClick={() => {
            setOpen(true);
          }}
        >
          open it
        </button>
        {open ? (
          <ModalSurface
            label="Closable"
            onDismiss={() => {
              setOpen(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setOpen(false);
            }}
          >
            <button type="button">inside</button>
          </ModalSurface>
        ) : null}
      </>
    );
  }

  it('returns focus to whatever opened it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'open it' });

    await user.click(opener);
    expect(screen.getByRole('button', { name: 'inside' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('asks to be dismissed by a press on the scrim but not inside the box', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <ModalSurface label="Scrim" scrimClassName="scrim" onDismiss={onDismiss}>
        <button type="button">inside</button>
      </ModalSurface>,
    );

    await user.click(screen.getByRole('button', { name: 'inside' }));
    expect(onDismiss).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog', { name: 'Scrim' });
    await user.click(dialog.parentElement as HTMLElement);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
