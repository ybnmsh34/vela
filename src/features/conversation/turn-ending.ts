/**
 * **How a turn ended**, when the answer above it does not say.
 *
 * ## The defect this exists for
 *
 * `MessageTurn.tsx` asked one question about a settled turn — *"is there
 * reasoning and no answer?"* (`showThinkingOnly`) — and drew a sentence when the
 * answer was yes. That question is one notch narrower than the real one, which
 * is *"is there anything on this screen at all, and does it stop where the model
 * meant it to?"*. Two endings fell through the gap:
 *
 *  - **Nothing came back.** `answer === '' && reasoning === ''` with no tool
 *    calls and no error renders an `<article>` containing a footer. A model that
 *    returns an empty completion produced a blank turn with no text, no
 *    explanation and no control — the user cannot tell it apart from a turn that
 *    has not started.
 *  - **The answer was cut off.** `TurnState.stopReason` carries `'maxTokens'`
 *    from `reduceTurn`'s `done` arm and is persisted by `use-conversation.ts`,
 *    and **nothing in the renderer read it** — an answer that stopped mid-word
 *    against the model's output cap was drawn exactly like one that finished.
 *
 * Both are the same defect: the *ending* of a turn was never a thing the view
 * had a name for, so only the one ending somebody happened to look at was drawn.
 *
 * ## Why a total switch, twice
 *
 * The fix has to be the shape the defect was not. {@link describeTurnEnding}
 * switches exhaustively over {@link TurnPhase} and then, for a completed turn,
 * exhaustively over {@link StopReason}. Both unions are closed and neither
 * switch has a `default`, so a sixth phase or a sixth stop reason **fails the
 * type check here** rather than falling into a silent `null` — which is the
 * mechanism, not the care, that keeps the next ending from going undrawn.
 *
 * ## Why it goes quiet when something else is already speaking
 *
 * A turn that failed, or that Vela refused to start, already renders a block
 * that states the ending and carries the retry control. A second sentence
 * underneath it would be a duplicate, and a second **Try again** button beside
 * the first is worse than a duplicate. So the single rule is: *this speaks only
 * when nothing else does.* That is why `hasError` and `hasRefusal` are inputs.
 */

import type { StopReason } from '@/platform/contract';

import type { NoticeTone } from './notices';
import type { TurnPhase } from './turn-stream';

/**
 * Which ending this is. Rendered as a `data-kind` attribute and asserted by
 * name, so the wording can be rewritten without rewriting the tests that prove
 * the ending is reached at all.
 */
export type TurnEndingKind =
  | 'silent'
  | 'truncated'
  | 'cutShort'
  | 'failedRecorded'
  | 'failedUnrecorded';

export interface TurnEnding {
  readonly kind: TurnEndingKind;
  readonly tone: NoticeTone;
  readonly title: string;
  readonly detail: string;
  /**
   * Whether **this** block carries the retry control.
   *
   * `false` for a truncated answer on purpose: re-running the turn regenerates
   * the same reply against the same cap. The action that helps is asking the
   * model to continue, which is a thing the user types, so the sentence says so
   * instead of offering a button that would do the wrong thing twice.
   */
  readonly offerRetry: boolean;
}

/**
 * Everything about a settled turn that decides its ending — and nothing else.
 *
 * Plain booleans rather than `TurnState`, so this stays a pure function over
 * facts the caller has already established and the test table can enumerate the
 * whole input space without building a reducer state for each row.
 */
export interface TurnEndingInput {
  readonly phase: TurnPhase;
  readonly stopReason: StopReason | null;
  /** The model's answer text is non-empty. */
  readonly hasAnswer: boolean;
  /** The model's reasoning channel is non-empty. */
  readonly hasReasoning: boolean;
  /** The turn carries at least one tool call, settled or in flight. */
  readonly hasToolCalls: boolean;
  /** An endpoint-level failure is already being rendered. */
  readonly hasError: boolean;
  /** A Vela-side refusal is already being rendered. */
  readonly hasRefusal: boolean;
  /**
   * The line the **record** kept about this turn's failure, or `null`.
   *
   * `TurnState.recordedFailure`, which is the store's `errorMessage` column read
   * back. Only the `failed` phase consults it, and it is never parsed — see
   * {@link FAILED_RECORDED}.
   */
  readonly recordedFailure: string | null;
}

const SILENT: TurnEnding = {
  kind: 'silent',
  tone: 'warning',
  title: 'The model returned nothing',
  detail:
    'This turn ended without any answer, any reasoning and any tool call. Nothing failed — the endpoint reported a finished reply with no content in it.',
  offerRetry: true,
};

const TRUNCATED: TurnEnding = {
  kind: 'truncated',
  tone: 'warning',
  title: 'Cut off at the model’s output limit',
  detail:
    'The model reached the most tokens it was allowed to write in one reply, so this answer stops where the limit fell rather than where the model was going to end. Ask it to carry on, or raise the limit for this model.',
  offerRetry: false,
};

const CUT_SHORT: TurnEnding = {
  kind: 'cutShort',
  tone: 'info',
  title: 'Stopped before it finished',
  detail: 'This reply was stopped part-way. What is above is as far as it got.',
  offerRetry: true,
};

/**
 * A turn the **record** says failed, whose reason the record also kept.
 *
 * Reached only from the store. `stored-entries.ts` restores `status: 'failed'`
 * as {@link TurnPhase} `failed` and deliberately restores neither the typed
 * error nor the tool outcomes — its own header says why — so a failed turn read
 * back out of SQLite arrives with `error === null` and `refusal === null` and,
 * before this, rendered as an ordinary finished reply. Reopening a conversation
 * turned every failure in it into a success.
 *
 * **Quoted, never narrated.** The `errorMessage` column holds whatever
 * `errorMessageOfTurn` put there — a refusal's own sentence for one kind of
 * failure, a bare `ChatError.kind` for the other — and this module cannot tell
 * which. So the line is set in the record's voice inside quotation marks rather
 * than in Vela's, the same rule `DocumentPreview` states for an artifact's
 * diagnostics: program-supplied text is never parsed for meaning and never
 * spoken as Vela's own.
 */
function failedRecorded(reason: string): TurnEnding {
  return {
    kind: 'failedRecorded',
    tone: 'warning',
    title: 'This reply failed',
    detail: `The record says this turn failed, and kept one line about it: “${reason}”.`,
    offerRetry: true,
  };
}

/**
 * The same turn, from a row that kept no line about the failure.
 *
 * Live now that the column is read back: `StoredMessage.errorMessage` is
 * `string | null`, and a row written before it carried anything — or by any path
 * that settled a `failed` status without a reason — restores as `null` here.
 *
 * The sentence claims only what the row proves. It does **not** say the reason
 * was never kept, which is the sentence this used to carry and which was false:
 * `use-conversation.ts` writes `errorMessage` on every failure it records, and
 * what had gone wrong was that nothing read it back.
 */
const FAILED_UNRECORDED: TurnEnding = {
  kind: 'failedUnrecorded',
  tone: 'warning',
  title: 'This reply failed',
  detail: 'The record says this turn failed. It kept no line about why.',
  offerRetry: true,
};

/**
 * The ending to draw under a turn, or `null` when the turn ended the way the
 * text above it already implies.
 */
export function describeTurnEnding(input: TurnEndingInput): TurnEnding | null {
  // Something else on this turn already states the ending and owns the control.
  if (input.hasError || input.hasRefusal) return null;

  switch (input.phase) {
    case 'awaiting':
    case 'streaming':
      // Not settled. There is no ending yet, and guessing at one mid-stream is
      // how a turn that is still arriving gets labelled empty.
      return null;
    case 'failed':
      // A *live* failure never reaches here: the reducer sets `failed` only
      // alongside an `error` and `use-conversation.ts` only alongside a
      // `refusal`, and both returned above. What reaches here is a turn
      // restored from the store, which keeps the status and the recorded line
      // and drops the typed error.
      return input.recordedFailure === null
        ? FAILED_UNRECORDED
        : failedRecorded(input.recordedFailure);
    case 'stopped':
      return CUT_SHORT;
    case 'complete':
      return endingOfCompleted(input);
  }
}

/**
 * A completed turn's ending, decided by the reason the endpoint gave.
 *
 * The stop reason is consulted **before** emptiness, and that order is the
 * point: a turn cut off at the output cap with nothing written yet is still a
 * truncation, and calling it "the model returned nothing" would send the user
 * to retry a request that will hit the same cap again.
 */
function endingOfCompleted(input: TurnEndingInput): TurnEnding | null {
  const empty = !input.hasAnswer && !input.hasReasoning && !input.hasToolCalls;

  switch (input.stopReason) {
    case 'maxTokens':
      return TRUNCATED;
    case 'cancelled':
      // Not the streaming path and not the stored one. `reduceTurn`'s `done`
      // arm maps a `cancelled` stop reason to the `stopped` phase, and a stored
      // row is worse than that: `statusOfTurn` writes the `stopped` phase as
      // status `cancelled` and `phaseOf` reads status `cancelled` back as phase
      // `stopped`, so a cancelled row never arrives here as `complete` either.
      //
      // The producer is `settleRun` in `use-conversation.ts`. Its `completed`
      // branch sets `phase: 'complete'` and copies `outcome.stopReason`
      // verbatim, and `RunOutcome`'s completed variant is typed
      // `stopReason: StopReason` — the whole union, `cancelled` included. So an
      // agent run whose last turn stopped short settles complete-and-cancelled,
      // and this arm is what keeps that from reading as an ordinary finish.
      return CUT_SHORT;
    case 'toolUse':
    case 'endTurn':
    case 'unspecified':
    case null:
      return empty ? SILENT : null;
  }
}
