/**
 * The two things a turn reports besides its answer: what Vela had to give up,
 * and how a tool call turned out.
 *
 * Both are rendered *below* the answer and *above* the fold of the next turn,
 * because both change how the answer above them should be read.
 */

import type { Degradation, ToolCallOutcome } from '@/platform/contract';

import { describeDegradation, describeMalformedReason } from './notices';
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
 * A malformed call is shown with the arguments exactly as they arrived. The
 * host refused to reconstruct and run them; showing the evidence is the whole
 * reason it bothered to keep them.
 */
export function ToolCalls({
  outcomes,
  progress,
}: {
  readonly outcomes: readonly ToolCallOutcome[];
  readonly progress: readonly ToolCallProgress[];
}) {
  // Once the turn settles, `outcomes` is the truth; the in-flight fragments are
  // the same calls half-assembled and would read as duplicates.
  const inFlight = outcomes.length === 0 ? progress : [];
  if (outcomes.length === 0 && inFlight.length === 0) return null;

  return (
    <ul className={styles.calls} aria-label="Tool calls">
      {outcomes.map((outcome, index) =>
        outcome.status === 'ok' ? (
          <li key={index} className={styles.call} data-state="ok">
            <span className={styles.callName}>{outcome.name}</span>
            {outcome.emulated ? <span className={styles.tag}>read from the reply</span> : null}
            <pre className={styles.args}>{JSON.stringify(outcome.arguments, null, 2)}</pre>
          </li>
        ) : (
          <li key={index} className={styles.call} data-state="malformed">
            <span className={styles.callName}>{outcome.name ?? 'Unnamed tool call'}</span>
            <span className={styles.tag} data-state="malformed">
              not run
            </span>
            <p className={styles.reason}>
              Vela did not run this call because {describeMalformedReason(outcome.reason)}. What
              arrived is shown below, unmodified.
            </p>
            <pre className={styles.args}>{outcome.rawArguments}</pre>
          </li>
        ),
      )}

      {inFlight.map((call) => (
        <li key={call.slot} className={styles.call} data-state="pending">
          <span className={styles.callName}>{call.name ?? 'Tool call…'}</span>
          <span className={styles.tag}>arriving</span>
          {call.argumentsText === '' ? null : <pre className={styles.args}>{call.argumentsText}</pre>}
        </li>
      ))}
    </ul>
  );
}
