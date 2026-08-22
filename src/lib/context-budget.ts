/**
 * The context budget — how much of the model's window a turn is about to use.
 *
 * ## The honesty problem this file exists to solve
 *
 * The **window** is a fact: the endpoint reports it, the core carries it as
 * `contextWindowTokens`, and when it reports nothing the value is `null` and
 * stays `null`. Vela never invents one, because a meter drawn against a made-up
 * ceiling is worse than no meter.
 *
 * The **usage** is not a fact. Nothing in the renderer can tokenise the way an
 * arbitrary endpoint's tokeniser does — that is the endpoint's private business
 * and differs per model. So everything this file produces about usage is an
 * *estimate*, it is named `approx…` at every level so a caller cannot forget,
 * and the UI is expected to say "about" out loud.
 *
 * ## Which way the estimate errs, and why
 *
 * Deliberately **high**. Under-estimating produces "you have room" followed by a
 * refused turn; over-estimating produces a warning slightly too early. The first
 * costs the user their message, the second costs them nothing. So:
 *
 *  - ASCII-ish text is counted at 4 characters per token, the usual English
 *    ratio rounded against us.
 *  - Every non-ASCII character counts as a whole token. CJK sits near one token
 *    per character on most tokenisers and emoji are frequently worse, and a
 *    `length / 4` rule would tell a Japanese user they have four times the room
 *    they actually have.
 *  - A per-message overhead is added, because every chat format wraps each turn
 *    in role markers that the user cannot see and does not think about.
 */

/** What every chat format spends wrapping one message in role markers. */
const PER_MESSAGE_OVERHEAD_TOKENS = 4;

/** Warn from here. Early enough to shorten a message, late enough to be quiet. */
const TIGHT_FRACTION = 0.8;

/**
 * Estimated tokens for one string. See the module docs: this is an estimate
 * that errs high, never a measurement.
 */
export function approxTokens(text: string): number {
  let ascii = 0;
  let wide = 0;
  for (const character of text) {
    // `codePointAt(0)` is defined for every iteration of a string iterator.
    if ((character.codePointAt(0) ?? 0) < 128) ascii += 1;
    else wide += 1;
  }
  return Math.ceil(ascii / 4) + wide;
}

/** Estimated tokens for a whole turn, role wrappers included. */
export function approxTurnTokens(texts: readonly string[]): number {
  return texts.reduce(
    (total, text) => total + approxTokens(text) + PER_MESSAGE_OVERHEAD_TOKENS,
    0,
  );
}

/**
 * How a turn sits against the window.
 *
 * `unknown` is a first-class outcome, not a failure: an endpoint that does not
 * report its window is normal, and the UI's job then is to say the window is
 * unknown rather than to draw a bar against a guess.
 */
export type BudgetVerdict = 'unknown' | 'comfortable' | 'tight' | 'over';

/**
 * Which half of the sum is missing. Two very different absences, and a surface
 * that conflates them tells the user the wrong thing about their own machine.
 *
 * `noWindow` — the endpoint did not report a context window. The usage figure
 * is real; there is simply no ceiling to draw it against.
 *
 * `nothingMeasured` — **no caller supplied anything to count.** This is not
 * "the turn is empty". It is "the wiring that would tell me what the turn holds
 * is not attached", and the two are indistinguishable from in here, which is
 * exactly why the caller passes `null` rather than `[]`. Printing "about 0
 * tokens" for it is the defect this distinction exists to prevent: the meter
 * that measured nothing read *"About 0 of 200,000 tokens"* while the composer
 * held 880,000 characters, which does not merely fail to inform — it tells the
 * user they have room they do not have.
 */
export type BudgetUnknownReason = 'noWindow' | 'nothingMeasured';

export interface ContextBudget {
  /** Exactly what the endpoint reported. `null` means it reported nothing. */
  readonly windowTokens: number | null;
  /** `null` when there was nothing to measure — never a stand-in zero. */
  readonly approxUsedTokens: number | null;
  /** `null` when either half of the subtraction is missing. Never negative. */
  readonly approxRemainingTokens: number | null;
  /** `0`–`1`+, or `null` when either half is missing. May exceed 1. */
  readonly fraction: number | null;
  readonly verdict: BudgetVerdict;
  /** Set exactly when `verdict` is `unknown`. */
  readonly unknownReason: BudgetUnknownReason | null;
}

/**
 * @param texts everything the turn will send, or `null` for "nothing reported
 * what this turn holds". `[]` means the turn is genuinely empty and is counted
 * as zero; `null` refuses to answer. A caller that cannot tell the difference
 * must pass `null`.
 */
export function contextBudget(
  windowTokens: number | null,
  texts: readonly string[] | null,
): ContextBudget {
  const window = windowTokens === null || windowTokens <= 0 ? null : windowTokens;

  if (texts === null) {
    return {
      windowTokens: window,
      approxUsedTokens: null,
      approxRemainingTokens: null,
      fraction: null,
      verdict: 'unknown',
      unknownReason: 'nothingMeasured',
    };
  }

  const approxUsedTokens = approxTurnTokens(texts);

  if (window === null) {
    return {
      windowTokens: null,
      approxUsedTokens,
      approxRemainingTokens: null,
      fraction: null,
      verdict: 'unknown',
      unknownReason: 'noWindow',
    };
  }

  const fraction = approxUsedTokens / window;
  return {
    windowTokens: window,
    approxUsedTokens,
    approxRemainingTokens: Math.max(0, window - approxUsedTokens),
    fraction,
    verdict: fraction >= 1 ? 'over' : fraction >= TIGHT_FRACTION ? 'tight' : 'comfortable',
    unknownReason: null,
  };
}
