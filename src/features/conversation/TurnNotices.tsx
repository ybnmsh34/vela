/**
 * The two things a turn reports besides its answer: what Vela had to give up,
 * and how a tool call turned out.
 *
 * Both are rendered *below* the answer and *above* the fold of the next turn,
 * because both change how the answer above them should be read.
 */

import type { AnswerProvenance, Degradation, ToolCallOutcome } from '@/platform/contract';
import type { RunDegradation } from '@/platform/contract-harness';

import { describeAttribution, describeDegradation, describeRunDegradation } from './notices';
import { attributionOf } from './use-conversation';
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
 * Which endpoint answered, when it is not the one the turn was addressed to.
 *
 * Drawn as its own note above the degradation list rather than inside it,
 * because it is not a degradation: nothing was reduced, the answer is whole.
 * What changed is *where it came from*, which a user may care about more than
 * anything in that list and for reasons that have nothing to do with quality.
 *
 * Renders nothing on the ordinary path — see {@link describeAttribution} for
 * the two silences and why neither may be filled in with a guess.
 *
 * This component reads neither id. It hands both to {@link attributionOf},
 * which is the one place in this feature allowed to compare them, and words
 * whatever closed case comes back.
 */
export function AnsweredByNote({
  answeredBy,
  selected,
}: {
  readonly answeredBy: AnswerProvenance | null;
  readonly selected: string | null;
}) {
  const notice = describeAttribution(attributionOf(answeredBy, selected));
  if (notice === null) return null;
  return (
    <ul className={styles.notes} aria-label="Which endpoint answered">
      <li className={styles.note} data-tone={notice.tone}>
        <span className={styles.noteTitle}>{notice.title}</span>
        <span className={styles.noteDetail}>{notice.detail}</span>
      </li>
    </ul>
  );
}

/**
 * What the **run** had to give up, drawn in the same place and the same shape as
 * what the endpoint did.
 *
 * A separate list rather than a merged one, because the two unions are separate
 * on purpose (`describeRunDegradation` says why). Same label, because the user's
 * question — "what did Vela change for this reply?" — does not distinguish them,
 * and two headings that read identically would be worse than one list.
 */
export function RunDegradationNotes({ items }: { readonly items: readonly RunDegradation[] }) {
  if (items.length === 0) return null;
  return (
    <ul className={styles.notes} aria-label="What Vela had to change for this run">
      {items.map((degradation, index) => {
        const notice = describeRunDegradation(degradation);
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
