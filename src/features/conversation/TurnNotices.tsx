/**
 * The two things a turn reports besides its answer: what Vela had to give up,
 * and how a tool call turned out.
 *
 * Both are rendered *below* the answer and *above* the fold of the next turn,
 * because both change how the answer above them should be read.
 */

import type { Degradation, ToolCallOutcome } from '@/platform/contract';

import { describeDegradation } from './notices';
import { ToolCallList } from './ToolCallList';
import type { ToolResultView } from './tool-calls';
import type { ToolCallProgress } from './turn-stream';
import styles from './TurnNotices.module.css';

export function DegradationNotes({ items }: { readonly items: readonly Degradation[] }) {
  if (items.length === 0) return null;
  return (
    <ul className={styles.notes} aria-label="What Vela had to change for this model">
      {items.map((degradation, index) => {
        const notice = describeDegradation(degradation);
        return (
          <li key={index} className={styles.note} data-tone={notice.tone}>
            <span className={styles.noteTitle}>{notice.title}</span>
            <span className={styles.noteDetail}>{notice.detail}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Tool calls, settled and in flight.
 *
 * The presentation itself lives in `ToolCallList.tsx` — collapsible cards, the
 * malformed state, emulation disclosure, parallel batches. This stays as the
 * transcript's entry point so the turn keeps one import for "everything a turn
 * reports besides its answer".
 */
export function ToolCalls({
  outcomes,
  progress,
  results,
  running,
}: {
  readonly outcomes: readonly ToolCallOutcome[];
  readonly progress: readonly ToolCallProgress[];
  /** Results that have come back, when the transcript carries any. */
  readonly results?: readonly ToolResultView[];
  /** Correlation ids currently executing. Empty until Vela runs tools. */
  readonly running?: readonly string[];
}) {
  return (
    <ToolCallList
      outcomes={outcomes}
      progress={progress}
      {...(results === undefined ? {} : { results })}
      {...(running === undefined ? {} : { running })}
    />
  );
}
