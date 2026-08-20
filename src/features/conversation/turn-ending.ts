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
export type TurnEndingKind = 'silent' | 'truncated' | 'cutShort' | 'failedUnrecorded';

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
 * A turn the **record** says failed, whose reason the record does not keep.
 *
 * Reached only from the store. `stored-entries.ts` restores `status: 'failed'`
 * as {@link TurnPhase} `failed` and deliberately restores neither the typed
 * error nor the tool outcomes — its own header says why — so a failed turn read
 * back out of SQLite arrives with `error === null` and `refusal === null` and,
 * before this, rendered as an ordinary finished reply. Reopening a conversation
 * turned every failure in it into a success.
 *
 * The sentence claims only what the row proves: that it failed, and that the
 * reason is not there to state. `errorMessage` **is** a column on the row and is
 * written by `use-conversation.ts`, but `entriesFromStored` does not read it
 * back, so this cannot quote it — see the note in the final report.
 */
const FAILED_UNRECORDED: TurnEnding = {
  kind: 'failedUnrecorded',
  tone: 'warning',
  title: 'This reply failed',
  detail:
    'The record says this turn failed. What went wrong was not kept with it, so Vela cannot say what it was.',
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
      // restored from the store, which keeps the status and drops the reason.
      return FAILED_UNRECORDED;
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
      // `reduceTurn` maps a `cancelled` stop reason to the `stopped` phase, so
      // this arm is not on the streaming path. It is on the **stored** one:
      // `stored-entries.ts` rebuilds a turn from the record with whatever stop
      // reason was written, and a cancelled turn read back from the store must
      // read as cancelled rather than as an ordinary finish.
      return CUT_SHORT;
    case 'toolUse':
    case 'endTurn':
    case 'unspecified':
    case null:
      return empty ? SILENT : null;
  }
}
