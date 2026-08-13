/**
 * How much of the model's context window this turn will take.
 *
 * Three different kinds of number meet here and the component keeps them apart
 * in the wording, because conflating any two would be a lie:
 *
 *  - the **window** is the endpoint's own figure, carried through the core. When
 *    the endpoint reports none, this says so and draws no bar. There is no
 *    default window.
 *  - the **usage** is Vela's estimate, and every sentence says "about". Nothing
 *    in a renderer can tokenise the way an arbitrary endpoint does.
 *  - **not knowing the usage at all** is its own state with its own sentence.
 *    A caller with nothing to measure passes `null` and gets "Context use
 *    unknown", never "about 0". This component was mounted for a whole phase
 *    with an input nothing ever filled, and it printed "About 0 of 200,000
 *    tokens" while the composer held 880,000 characters — a figure computed
 *    from an empty input and presented as fact. That is not silence; it is
 *    confidently wrong, and it told the user they had room they did not have.
 *
 * The warning arrives *before* the turn, which is the whole point: a context
 * overflow discovered by sending is a lost message.
 */

import { contextBudget, type ContextBudget } from '@/lib/context-budget';

import { formatTokens } from './capability-rows';
import styles from './ContextMeter.module.css';

interface ContextMeterProps {
  /** Exactly what the endpoint reported. `null` means it reported nothing. */
  readonly windowTokens: number | null;
  /**
   * Everything that will be sent: the transcript Vela replays, the draft, and
   * anything staged. `null` means nothing reported what this turn holds — which
   * is not the same as an empty turn and is not drawn as one.
   */
  readonly texts: readonly string[] | null;
}

export function ContextMeter({ windowTokens, texts }: ContextMeterProps) {
  const budget = contextBudget(windowTokens, texts);

  if (budget.unknownReason === 'nothingMeasured') {
    return (
      <p className={styles.unknown} data-testid="context-meter" data-verdict="unknown">
        Context use unknown
        {budget.windowTokens === null
          ? ''
          : ` · this endpoint reports a ${formatTokens(budget.windowTokens)} token window`}
      </p>
    );
  }

  if (budget.verdict === 'unknown') {
    return (
      <p className={styles.unknown} data-testid="context-meter" data-verdict="unknown">
        Context window not reported by this endpoint · about{' '}
        {formatTokens(budget.approxUsedTokens ?? 0)} tokens in this turn
      </p>
    );
  }

  const used = budget.approxUsedTokens ?? 0;
  const percent = Math.min(100, Math.round((budget.fraction ?? 0) * 100));

  return (
    <div
      className={`${styles.meter} ${toneClass(budget)}`}
      data-testid="context-meter"
      data-verdict={budget.verdict}
    >
      <div
        className={styles.track}
        role="meter"
        aria-label="Estimated context used"
        aria-valuemin={0}
        aria-valuemax={budget.windowTokens ?? 0}
        aria-valuenow={used}
        aria-valuetext={`about ${formatTokens(used)} of ${formatTokens(
          budget.windowTokens ?? 0,
        )} tokens`}
      >
        <span className={styles.fill} style={{ width: `${String(percent)}%` }} />
      </div>
      <p className={styles.readout}>
        About {formatTokens(used)} of{' '}
        {formatTokens(budget.windowTokens ?? 0)} tokens
        {budget.verdict === 'over' ? (
          <span className={styles.warning}>
            {' '}
            — this turn is larger than the window. Sending it will drop the oldest messages, or the
            endpoint will refuse it. Shorten the message or switch to a model with more room.
          </span>
        ) : budget.verdict === 'tight' ? (
          <span className={styles.warning}>
            {' '}
            — close to the limit. Vela&apos;s count is an estimate, so leave some room.
          </span>
        ) : null}
      </p>
    </div>
  );
}

function toneClass(budget: ContextBudget): string {
  if (budget.verdict === 'over') return styles.over ?? '';
  if (budget.verdict === 'tight') return styles.tight ?? '';
  return styles.comfortable ?? '';
}
