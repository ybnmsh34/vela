/**
 * The model's reasoning — a distinct content type, rendered as a distinct thing.
 *
 * ## The rules this component encodes
 *
 * * **Subordinate to the answer, never mixed into it.** Smaller, quieter, and
 *   in its own container. It is deliberation, not output.
 * * **Live while it streams, collapsed once it is done.** Watching a model
 *   think is useful in the moment and clutter afterwards, so the default flips
 *   when the block completes — but only the *default*. Once the user has
 *   opened or closed it themselves, their choice sticks for that turn; a panel
 *   that snaps shut under your cursor is worse than one that never moves.
 * * **An unterminated block stays open and says so.** The host reports
 *   `unterminatedReasoning` when a stream ends mid-thought (hostile endpoints
 *   open the block twice and never close it). Collapsing that by default would
 *   hide the only text the turn produced.
 */

import { useState } from 'react';

import type { ReasoningPhase } from './turn-stream';
import styles from './ThinkingBlock.module.css';

interface ThinkingBlockProps {
  readonly text: string;
  readonly phase: ReasoningPhase;
  /** Distinguishes this turn's block from every other one for aria wiring. */
  readonly id: string;
}

export function ThinkingBlock({ text, phase, id }: ThinkingBlockProps) {
  const [choice, setChoice] = useState<boolean | null>(null);
  if (phase === 'none' || text === '') return null;

  const live = phase === 'streaming';
  const open = choice ?? (live || phase === 'unterminated');
  const summary = live ? 'Thinking…' : phase === 'unterminated' ? 'Thinking (never closed)' : 'Thought process';

  return (
    <section className={styles.block} data-live={live ? 'true' : undefined}>
      <h3 className={styles.headingReset}>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          aria-controls={`${id}-reasoning`}
          onClick={() => {
            setChoice(!open);
          }}
        >
          <span className={styles.chevron} data-open={open ? 'true' : undefined} aria-hidden="true" />
          <span className={styles.summary}>{summary}</span>
          {live ? <span className={styles.pulse} aria-hidden="true" /> : null}
        </button>
      </h3>

      <div id={`${id}-reasoning`} className={styles.body} hidden={!open}>
        {phase === 'unterminated' ? (
          <p className={styles.notice}>
            The stream ended while this block was still open. It is shown in full so nothing is
            lost — but the model never marked where its answer was meant to begin.
          </p>
        ) : null}
        <p className={styles.text}>{text}</p>
      </div>
    </section>
  );
}
