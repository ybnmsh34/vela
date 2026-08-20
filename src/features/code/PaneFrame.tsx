/**
 * One pane: its header, its controls, and the box its content lives in.
 *
 * ## The header is the handle, and it is not the only way to move a pane
 *
 * Dragging a header is the gesture the spec describes, and it is a *pointer*
 * gesture. Shipping only that would mean the layout is arrangeable by mouse and
 * frozen by keyboard, which is the same class of omission as a splitter you
 * cannot focus. So every move the drag can make is also an item in the header's
 * move disclosure, and the drag calls the same store action the menu items call.
 *
 * ## Why a disclosure and not `role="menu"`
 *
 * A `role="menu"` promises a keyboard model — arrow keys move between items,
 * Home and End jump, typing a letter jumps — in the same way `aria-modal`
 * promises containment. `src/components/ModalSurface.tsx` spends its header on
 * what happens when a promise like that ships without its enforcement. This is a
 * button that shows a list of buttons: Tab moves between them, Escape closes it,
 * and that is exactly what a disclosure claims.
 *
 * ## Why the region takes focus at `tabIndex={-1}`
 *
 * Pane focus has to be reachable without walking every control inside every
 * pane, which is what F6 is for (`use-workspace-shortcuts.ts`). A destination
 * that is not also a Tab stop is precisely the `tabindex="-1"` case
 * `src/state/focus-store.ts` documents for the `ground` landmark — and the
 * reason `tabStopsWithin` exists separately from `canTakeFocus`.
 */

import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';

import type { PaneKind } from '@/state/code-workspace-store';

import styles from './CodeWorkspace.module.css';

/**
 * What each pane is called, everywhere it is named: its header, its move menu,
 * the Views menu, and the accessible name of its region.
 *
 * A total map over {@link PaneKind}, so a pane added to the union with no name
 * here fails `pnpm typecheck` naming this file rather than rendering a blank
 * header. The same discipline `PROBLEM_LABELS` uses in the skills pane.
 */
export const PANE_TITLES: Record<PaneKind, string> = {
  chat: 'Chat',
  diff: 'Diff',
  editor: 'Editor',
};

export interface PaneMove {
  readonly label: string;
  readonly run: () => void;
}

interface PaneFrameProps {
  readonly pane: PaneKind;
  readonly focused: boolean;
  /** Fraction of the column's height. Written as `flex-grow`. */
  readonly share: number;
  readonly moves: readonly PaneMove[];
  readonly onFocusPane: () => void;
  readonly onClose: () => void;
  readonly onDragStart: () => void;
  readonly onDragEnd: () => void;
  /** `null` when nothing is being dragged; the pane being dragged otherwise. */
  readonly dragging: PaneKind | null;
  readonly onDropOn: () => void;
  readonly children: ReactNode;
}

export function PaneFrame({
  pane,
  focused,
  share,
  moves,
  onFocusPane,
  onClose,
  onDragStart,
  onDragEnd,
  dragging,
  onDropOn,
  children,
}: PaneFrameProps) {
  const region = useRef<HTMLElement>(null);
  const [movesOpen, setMovesOpen] = useState(false);

  useEffect(() => {
    if (!focused) return;
    const box = region.current;
    if (box === null) return;
    // Only when nothing inside already has it. Re-focusing the region every time
    // the store says this pane is focused would yank the keyboard out of a
    // textarea the user is typing in — the pane is focused *because* they are.
    if (box.contains(document.activeElement)) return;
    box.focus();
  }, [focused]);

  const accepting = dragging !== null && dragging !== pane;

  return (
    <section
      ref={region}
      tabIndex={-1}
      aria-label={`${PANE_TITLES[pane]} pane`}
      data-pane={pane}
      data-focused={focused ? 'true' : undefined}
      className={styles.pane}
      style={{ flexGrow: share }}
      onFocusCapture={onFocusPane}
    >
      <header
        className={styles.paneHead}
        draggable
        // No `dataTransfer` is read or written. Drag and drop here are two ends
        // of one gesture inside one document, so the dragged pane is state the
        // grid already holds — and jsdom implements no `DataTransfer`, so a
        // version that round-tripped through it would be untestable for no gain.
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={(event: DragEvent<HTMLElement>) => {
          // Preventing the default is what makes an element a drop target at
          // all. Not doing it is the reason most hand-written drops silently do
          // nothing.
          if (accepting) event.preventDefault();
        }}
        onDrop={(event: DragEvent<HTMLElement>) => {
          if (!accepting) return;
          event.preventDefault();
          onDropOn();
        }}
        data-drop-target={accepting ? 'true' : undefined}
      >
        <h3 className={styles.paneTitle}>{PANE_TITLES[pane]}</h3>

        <div className={styles.paneActions}>
          <button
            type="button"
            className={styles.paneButton}
            aria-expanded={movesOpen}
            aria-label={`Move ${PANE_TITLES[pane]} pane`}
            onClick={() => setMovesOpen((was) => !was)}
          >
            Move
          </button>
          <button
            type="button"
            className={styles.paneButton}
            aria-label={`Close ${PANE_TITLES[pane]} pane`}
            onClick={onClose}
          >
            Close
          </button>
        </div>

        {movesOpen ? (
          <div
            className={styles.moveList}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.stopPropagation();
              setMovesOpen(false);
            }}
          >
            {moves.length === 0 ? (
              <p className={styles.moveEmpty}>This is the only pane open.</p>
            ) : (
              moves.map((move) => (
                <button
                  key={move.label}
                  type="button"
                  className={styles.moveItem}
                  onClick={() => {
                    setMovesOpen(false);
                    move.run();
                  }}
                >
                  {move.label}
                </button>
              ))
            )}
          </div>
        ) : null}
      </header>

      <div className={styles.paneBody}>{children}</div>
    </section>
  );
}
