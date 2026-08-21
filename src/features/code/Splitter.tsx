/**
 * The draggable edge between two panes.
 *
 * ## Why it is a control and not a decoration
 *
 * A 4px line you can only drag with a mouse is a feature no keyboard user has.
 * ARIA has a name for this exact thing — the *window splitter*: `role="separator"`
 * that is focusable, reports its position through `aria-valuenow`, and moves on
 * the arrow keys. Building it any other way means the layout is mouse-only, and
 * "the panes are resizable" stops being true for anyone driving by keyboard.
 *
 * `aria-orientation` is the orientation of the **separator**, not of the split:
 * the edge between two side-by-side panes is a vertical line, so it is
 * `vertical`, and its keys are Left and Right. Getting this backwards is the
 * usual mistake and it is silent — a screen reader simply announces the wrong
 * axis.
 *
 * ## Incremental deltas, not absolute positions
 *
 * A pointer drag reports where the pointer is; this reports how far it moved
 * since the last report. That is deliberate: the layout clamps at a floor, so
 * once a drag runs into one, an absolute mapping keeps computing positions the
 * layout will not grant and the pane snaps back the moment the pointer turns
 * around by a pixel. Incremental deltas mean the drag and the layout agree about
 * where the edge is, because the layout is the only one holding a position.
 *
 * ## The range it announces is the range it can reach
 *
 * `aria-valuemin` and `aria-valuemax` are a promise about where this control can
 * be put, and the first version computed them from the per-member floor as
 * `floor` and `100 - floor`. That is right for the minimum and wrong for the
 * maximum, because everything the member before the edge gains comes out of the
 * member after it and stops at *that* one's floor: the default three columns
 * announced a maximum of 92 and stopped at 58. So the range arrives as a value
 * from `src/lib/pane-layout.ts`, which is the only module that knows, rather
 * than being re-derived here from a number that cannot answer.
 *
 * ## What is *not* proven about the pointer path
 *
 * `getBoundingClientRect` is all zeros in jsdom, so the container width a drag
 * divides by has to be substituted for the pointer test to mean anything. The
 * test does substitute it, which makes the arithmetic real; what no test here
 * can show is that a real WebView2 pointer produces the events this expects.
 * The keyboard path needs no such substitution and is proven outright.
 */

import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

import type { EdgeRange } from '@/lib/pane-layout';

import styles from './CodeWorkspace.module.css';

/** One arrow press. Fine enough to aim with, coarse enough to be worth pressing. */
export const SPLITTER_STEP = 0.02;

export interface SplitterProps {
  readonly orientation: 'vertical' | 'horizontal';
  /** Named for the pair it divides, because that is what the user is aiming at. */
  readonly label: string;
  /** The share held by the member before this edge, 0–1. */
  readonly before: number;
  /**
   * How far this edge can actually travel, as shares of the whole. Produced by
   * `columnEdgeRange`/`slotEdgeRange`; see the header for why it is not a floor.
   */
  readonly range: EdgeRange;
  /** Positive moves the edge toward the *end* — right, or down. */
  readonly onResize: (delta: number) => void;
}

export function Splitter({ orientation, label, before, range, onResize }: SplitterProps) {
  // Where the pointer was at the last report, and how big the box it moves
  // inside is. Both live in a ref because neither is rendered and a re-render
  // per pointermove is exactly the cost a drag cannot pay.
  const drag = useRef<{ readonly at: number; readonly size: number } | null>(null);

  const vertical = orientation === 'vertical';

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const back = vertical ? 'ArrowLeft' : 'ArrowUp';
    const forward = vertical ? 'ArrowRight' : 'ArrowDown';

    if (event.key === back) onResize(-SPLITTER_STEP);
    else if (event.key === forward) onResize(SPLITTER_STEP);
    // Home and End ask for the extremes. `-1` and `1` are more than any layout
    // can grant, which is the point: the clamp in `src/lib/pane-layout.ts` is
    // what decides where "as far as it goes" is, and it is the only thing that
    // knows.
    else if (event.key === 'Home') onResize(-1);
    else if (event.key === 'End') onResize(1);
    else return;

    // Only after a key we handled. Preventing the default on every key would
    // eat Tab, which is how a splitter becomes a keyboard trap.
    event.preventDefault();
    event.stopPropagation();
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    const box = event.currentTarget.parentElement?.getBoundingClientRect();
    const size = vertical ? (box?.width ?? 0) : (box?.height ?? 0);
    if (size <= 0) return;
    drag.current = { at: vertical ? event.clientX : event.clientY, size };
    // Absent in jsdom, so it is asked for rather than assumed. Without it a drag
    // that leaves the 4px line stops receiving events mid-gesture.
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const started = drag.current;
    if (started === null) return;
    const now = vertical ? event.clientX : event.clientY;
    drag.current = { at: now, size: started.size };
    onResize((now - started.at) / started.size);
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current === null) return;
    drag.current = null;
    if (typeof event.currentTarget.releasePointerCapture === 'function') {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const percent = Math.round(before * 100);

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={percent}
      aria-valuemin={Math.round(range.min * 100)}
      aria-valuemax={Math.round(range.max * 100)}
      aria-valuetext={`${percent}%`}
      className={vertical ? styles.splitterVertical : styles.splitterHorizontal}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );
}
