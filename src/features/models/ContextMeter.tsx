/**
 * How much of the model's context window this turn will take.
 *
 * Two different kinds of number meet here and the component keeps them apart in
 * the wording, because conflating them would be a lie:
 *
 *  - the **window** is the endpoint's own figure, carried through the core. When
 *    the endpoint reports none, this says so and draws no bar. There is no
 *    default window.
 *  - the **usage** is Vela's estimate, and every sentence says "about". Nothing
 *    in a renderer can tokenise the way an arbitrary endpoint does.
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
  /** Everything that will be sent: the transcript so far, plus the draft. */
  readonly texts: readonly string[];
}

export function ContextMeter({ windowTokens, texts }: ContextMeterProps) {
  const budget = contextBudget(windowTokens, texts);

  if (budget.verdict === 'unknown') {
    return (
      <p className={styles.unknown} data-testid="context-meter">
        Context window not reported by this endpoint · about{' '}
        {formatTokens(budget.approxUsedTokens)} tokens in this turn
      </p>
    );
  }

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
        aria-valuenow={budget.approxUsedTokens}
        aria-valuetext={`about ${formatTokens(budget.approxUsedTokens)} of ${formatTokens(
          budget.windowTokens ?? 0,
        )} tokens`}
      >
        <span className={styles.fill} style={{ width: `${String(percent)}%` }} />
      </div>
      <p className={styles.readout}>
        About {formatTokens(budget.approxUsedTokens)} of{' '}
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
