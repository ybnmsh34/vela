/**
 * One turn in the transcript.
 *
 * The user's turn and the model's turn are deliberately *not* symmetrical. The
 * user's is a short, contained block — you wrote it, you know what it says. The
 * model's is full-width prose with its own subordinate channels: reasoning,
 * tool calls, what had to be degraded, and how it ended. Two bubbles facing
 * each other would waste half the width on the half nobody re-reads.
 */

import { isDebugLogRecording, useDebugLogStore } from '@/state/debug-log-store';

import type { RunDegradation } from '@/platform/contract-harness';

import { CopyButton } from './CopyButton';
import { Markdown } from './Markdown';
import { ThinkingBlock } from './ThinkingBlock';
import { AnsweredByNote, DegradationNotes, RunDegradationNotes, ToolCalls } from './TurnNotices';
import { describeChatError } from './notices';
import { describeTurnEnding } from './turn-ending';
import { hasReportedUsage, type TurnState } from './turn-stream';
import styles from './MessageTurn.module.css';

/** Shared empty, so a turn that was an ordinary send allocates nothing. */
const NO_RUN_DEGRADATIONS: readonly RunDegradation[] = [];

export function UserTurn({ text }: { readonly text: string }) {
  return (
    <article className={styles.turn} data-role="user" aria-label="Your message">
      <div className={styles.userBody}>
        <p className={styles.userText}>{text}</p>
      </div>
    </article>
  );
}

interface AssistantTurnProps {
  readonly turn: TurnState;
  /** Stable per turn; used to wire the reasoning block's aria attributes. */
  readonly id: string;
  readonly onRetry?: (() => void) | undefined;
  /**
   * What an agent run had to give up, when this turn was produced by one.
   *
   * Separate from {@link TurnState.degradations} because the two are separate
   * unions on the contract, and outside `TurnState` because that is a pure
   * reduction over the six chat events and a run degradation is not one of
   * them — it arrives on the run's own stream. Empty, or absent, for a turn that
   * was an ordinary send.
   */
  readonly runDegradations?: readonly RunDegradation[] | undefined;
  /**
   * The endpoint this turn was **addressed to**, as the user selected it.
   *
   * Passed in rather than read off {@link TurnState}, because `TurnState` is a
   * pure reduction over the six host events and the user's selection is not one
   * of them. It is here for one comparison — against what the host says actually
   * answered — and nothing branches on its value.
   */
  readonly selectedProviderId?: string | null | undefined;
  /**
   * Whether the transcript continues past this turn.
   *
   * Only the retry control's **wording** depends on it. Retrying a turn that
   * something follows replaces this turn *and everything after it* — see
   * `use-conversation.ts`'s `retry` — and a button labelled "Try again" is not a
   * truthful name for a control that discards four later turns. The default is
   * `false`, which is the last turn, which is the case every existing caller and
   * test is in.
   */
  readonly laterTurnsFollow?: boolean | undefined;
  /**
   * **Which reply this turn's retry control would discard**, for that control's
   * accessible name and for nothing else.
   *
   * Every retryable turn in a transcript draws a button reading "Try again from
   * here", and each one discards from a different anchor: an earlier one throws
   * away every reply after it, a later one throws away fewer. Read out of
   * context by a screen reader they were the same control repeated, and the
   * visible wording could not fix that — it is the same on every one of them
   * because it is true of every one of them.
   *
   * So the *name* carries the target while the *label* stays short. Undefined
   * for a caller that does not know the transcript — `MessageTurn.test.tsx`
   * mounts turns on their own — and then the name falls back to the label,
   * which is where it was.
   */
  readonly retryTarget?: RetryTarget | undefined;
}

/**
 * What a retry control's name says about the reply it would discard.
 *
 * ## Why the question is not enough on its own
 *
 * The first version of this named a turn by the question it answers and nothing
 * else, which merges two names into one in two shapes that are both reachable:
 *
 *  - **Several replies under one question.** `AgentLoopHarness`'s step loop
 *    calls its `runTurn` once per step and `runTurn` opens the step with one
 *    `transcript.append({ role: 'assistant', … })`, so an agent run writes one
 *    assistant row per step; `entriesFromStored` pushes one entry per assistant
 *    row. Reopen a three-step run and the transcript holds three consecutive
 *    assistant turns under a single user message — three buttons discarding
 *    three different tails, named by the one question all three answer.
 *  - **Two questions that agree for {@link QUESTION_IN_NAME} characters.** The
 *    quote is cut so a screen reader does not read a paragraph before the verb,
 *    and the cut is exactly what re-merges two long questions with a shared
 *    opening.
 *
 * ## What makes the names distinct instead
 *
 * {@link replyIndex} — the turn's position among the assistant turns of the
 * transcript it is drawn in. Two assistant turns cannot share one, so two names
 * built from one cannot collide, whatever the questions say. That is a property
 * of the counting rather than of the text, which is the whole point: the
 * previous fix was one questions could defeat.
 *
 * `ConversationSurface.test.tsx` walks every retry control in a mounted
 * transcript and asserts the names are distinct, in both shapes above.
 */
interface RetryTarget {
  /**
   * The question this turn answers, or `undefined` when no user message
   * precedes it. Quoted in the name; never the only thing in it.
   */
  readonly question: string | undefined;
  /** This turn's 1-based position among the transcript's assistant turns. */
  readonly replyIndex: number;
  /** How many assistant turns the transcript holds. */
  readonly replyCount: number;
}

/** How much of the question the retry control's name quotes. */
const QUESTION_IN_NAME = 60;

/**
 * "Try again from here" → "Try again from here — reply 2 of 3, to “…”".
 *
 * The visible label is unchanged, so nothing about the button's appearance or
 * its wording depends on this, and the name still *begins* with the visible
 * label so voice control keeps matching what the user can read (WCAG 2.5.3).
 *
 * The position is stated only when there is more than one reply to be among:
 * a transcript with a single assistant turn has a single retry control, so
 * "reply 1 of 1" would be noise attached to a name nothing can collide with.
 * With the position present the names are distinct by construction — see
 * {@link RetryTarget} — so the truncated quote is free to stay short.
 */
function retryName(label: string, target: RetryTarget | undefined): string {
  if (target === undefined) return label;
  const trimmed = target.question?.trim() ?? '';
  const quoted =
    trimmed.length > QUESTION_IN_NAME ? `${trimmed.slice(0, QUESTION_IN_NAME)}…` : trimmed;
  const where =
    target.replyCount > 1 ? `reply ${String(target.replyIndex)} of ${String(target.replyCount)}` : '';
  if (quoted === '') return where === '' ? label : `${label} — ${where}`;
  if (where === '') return `${label} — the reply to “${quoted}”`;
  return `${label} — ${where}, to “${quoted}”`;
}

export function AssistantTurn({
  turn,
  id,
  onRetry,
  runDegradations,
  selectedProviderId,
  laterTurnsFollow = false,
  retryTarget,
}: AssistantTurnProps) {
  const streaming = turn.phase === 'streaming' || turn.phase === 'awaiting';
  const error = turn.error === null ? null : describeChatError(turn.error);
  const showThinkingOnly = turn.answer === '' && turn.reasoning !== '';
  const retryLabel = laterTurnsFollow ? 'Try again from here' : 'Try again';
  // ONE NAME PER TURN, AND WHAT IS STILL OPEN ABOUT THAT.
  //
  // Three blocks below can each carry a retry control, and they share this one
  // name — which is right exactly as long as no more than one of them draws a
  // button. The ending block cannot draw one beside either of the others:
  // `describeTurnEnding` returns `null` on `hasError || hasRefusal` before it
  // looks at anything else. The refusal block and the error block are a
  // different question, and it is **open**: a `TurnState` with both `refusal`
  // and `error` non-null would draw two identically-named controls, and this
  // does not prevent it. I did not find a path that produces one — all six
  // `refuseTurn` call sites in `use-conversation.ts` run before or instead of a
  // stream (an attachment that would not load, `streamTurn` rejecting, no
  // project, no harness, a rejected run), `settleRun`'s failed branch returns
  // early on `isSettled` and a turn carrying an `error` is `failed` and so
  // settled, and `turnFromStored` restores neither field — but "I did not find
  // one" is not "there is none", and the ordering inside `streamTurn`'s catch
  // is not something this file can see.
  const retryAccessibleName = retryName(retryLabel, retryTarget);

  /**
   * How this turn ended, when the text above does not say — the empty reply, the
   * answer cut off at the output cap, the turn stopped part-way, and the failure
   * a reopened conversation restores without its reason.
   *
   * `describeTurnEnding` is total over both `TurnPhase` and `StopReason`, and it
   * returns `null` whenever the error or refusal block below is already stating
   * the ending, so exactly one of the two ever speaks and there is never a
   * second **Try again** beside the first.
   */
  const ending = describeTurnEnding({
    phase: turn.phase,
    stopReason: turn.stopReason,
    hasAnswer: turn.answer !== '',
    hasReasoning: turn.reasoning !== '',
    hasToolCalls: turn.outcomes.length > 0 || turn.toolProgress.length > 0,
    hasError: turn.error !== null,
    hasRefusal: turn.refusal !== null,
    recordedFailure: turn.recordedFailure,
  });

  // The `trace` id is a reference into the local debug log, and it is shown
  // only while that log is recording. It used to be shown unconditionally —
  // pointing into a file nothing in the application could create, since
  // `debuglog::enable` had no caller outside tests. A pointer to nothing is
  // worse than no pointer: it reads as something the user failed to find.
  const traceIsUseful = useDebugLogStore((store) => isDebugLogRecording(store.state));
  const correlation = traceIsUseful ? error?.correlation ?? null : null;

  return (
    <article className={styles.turn} data-role="assistant" aria-label="Model reply">
      <ThinkingBlock id={id} text={turn.reasoning} phase={turn.reasoningPhase} />

      {turn.phase === 'awaiting' ? (
        <p className={styles.awaiting} role="status">
          <span className={styles.dots} aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          Waiting for the first token…
        </p>
      ) : null}

      {turn.answer === '' ? null : <Markdown source={turn.answer} streaming={streaming} />}

      {showThinkingOnly && !streaming && turn.error === null ? (
        <p className={styles.noAnswer}>
          This turn produced reasoning but no answer text.
        </p>
      ) : null}

      <ToolCalls outcomes={turn.outcomes} progress={turn.toolProgress} />
      <AnsweredByNote answeredBy={turn.answeredBy} selected={selectedProviderId ?? null} />
      <DegradationNotes items={turn.degradations} />
      <RunDegradationNotes items={runDegradations ?? NO_RUN_DEGRADATIONS} />

      {/* BELOW THE NOTES, WHERE ITS SIBLING ALREADY IS.

          This block used to render above `ToolCalls`, which was chosen for the
          empty ending — the case where nothing else is on the turn at all — and
          not re-examined for the others. On a truncated turn that made tool
          calls it put "Cut off at the model's output limit" above the cards for
          the calls that happened before the cut, and it put the ending block on
          the opposite side of the notes from the `.error` block underneath,
          which states the same class of fact. Both are now last, in the order
          the turn happened. */}
      {ending === null ? null : (
        <div className={styles.ending} data-kind={ending.kind} data-tone={ending.tone}>
          <p className={styles.errorTitle}>{ending.title}</p>
          <p className={styles.errorDetail}>{ending.detail}</p>
          {ending.offerRetry && onRetry !== undefined ? (
            <button
              type="button"
              className={styles.retry}
              onClick={onRetry}
              aria-label={retryAccessibleName}
            >
              {retryLabel}
            </button>
          ) : null}
        </div>
      )}

      {turn.refusal === null ? null : (
        <div className={styles.error} data-kind="failed" role="alert">
          <p className={styles.errorTitle}>Vela could not start this turn</p>
          <p className={styles.errorDetail}>
            {turn.refusal.code === 'NOT_FOUND'
              ? 'The model this conversation points at is no longer configured. Choose one in settings.'
              : turn.refusal.message}
          </p>
          {onRetry === undefined ? null : (
            <button
              type="button"
              className={styles.retry}
              onClick={onRetry}
              aria-label={retryAccessibleName}
            >
              {retryLabel}
            </button>
          )}
        </div>
      )}

      {error === null ? null : (
        <div
          className={styles.error}
          data-kind={turn.phase === 'stopped' ? 'stopped' : 'failed'}
          role={turn.phase === 'stopped' ? undefined : 'alert'}
        >
          <p className={styles.errorTitle}>{error.title}</p>
          <p className={styles.errorDetail}>{error.detail}</p>
          {error.endpoint === null && correlation === null ? null : (
            <p className={styles.errorTrace}>
              {/* The endpoint the *user* configured, so somebody with three
                  candidates set up can tell which one failed — and, when the
                  local debug log is on, the id that joins this error to the raw
                  exchange sitting in it. */}
              {error.endpoint === null ? null : <span>{error.endpoint}</span>}
              {correlation === null ? null : <span>trace {correlation}</span>}
            </p>
          )}
          {error.retryable && onRetry !== undefined ? (
            <button
              type="button"
              className={styles.retry}
              onClick={onRetry}
              aria-label={retryAccessibleName}
            >
              {retryLabel}
            </button>
          ) : null}
        </div>
      )}

      {/* THE FOOTER NO LONGER SAYS "STOPPED".

          It used to, under `turn.phase === 'stopped' && turn.error === null` —
          which is now exactly the condition under which `describeTurnEnding`
          returns `cutShort` and the ending block above states the same fact in
          a sentence, with the retry control on it. Two statements of one ending
          on one turn is the thing the ending rule exists to prevent, and the
          weaker of the two was this one: a muted word in a footer that is
          `opacity: 0` until the turn is hovered or focused.

          The other half of the old condition still holds: a `stopped` turn that
          *does* carry an error renders the error block, whose title for
          `ChatError` `cancelled` is "Stopped" and whose detail is "You stopped
          this reply." `describeTurnEnding` returns `null` there for that reason,
          so that turn still says it exactly once. */}
      <footer className={styles.footer}>
        {turn.answer === '' ? null : (
          <CopyButton getText={() => turn.answer} label="Copy this reply" />
        )}
        {hasReportedUsage(turn.usage) ? (
          <span className={styles.usage}>{formatUsage(turn.usage)}</span>
        ) : null}
      </footer>
    </article>
  );
}

/** Only the figures the endpoint actually reported. A `null` is never a zero. */
function formatUsage(usage: {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly cachedInputTokens: number | null;
}): string {
  const parts: string[] = [];
  if (usage.inputTokens !== null) parts.push(`${String(usage.inputTokens)} in`);
  if (usage.outputTokens !== null) parts.push(`${String(usage.outputTokens)} out`);
  if (usage.reasoningTokens !== null) parts.push(`${String(usage.reasoningTokens)} thinking`);
  if (usage.cachedInputTokens !== null) parts.push(`${String(usage.cachedInputTokens)} cached`);
  return `${parts.join(' · ')} tokens`;
}
