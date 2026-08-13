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

import { CopyButton } from './CopyButton';
import { Markdown } from './Markdown';
import { ThinkingBlock } from './ThinkingBlock';
import { DegradationNotes, ToolCalls } from './TurnNotices';
import { describeChatError } from './notices';
import { hasReportedUsage, type TurnState } from './turn-stream';
import styles from './MessageTurn.module.css';

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
}

export function AssistantTurn({ turn, id, onRetry }: AssistantTurnProps) {
  const streaming = turn.phase === 'streaming' || turn.phase === 'awaiting';
  const error = turn.error === null ? null : describeChatError(turn.error);
  const showThinkingOnly = turn.answer === '' && turn.reasoning !== '';

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
      <DegradationNotes items={turn.degradations} />

      {turn.refusal === null ? null : (
        <div className={styles.error} data-kind="failed" role="alert">
          <p className={styles.errorTitle}>Vela could not start this turn</p>
          <p className={styles.errorDetail}>
            {turn.refusal.code === 'NOT_FOUND'
              ? 'The model this conversation points at is no longer configured. Choose one in settings.'
              : turn.refusal.message}
          </p>
          {onRetry === undefined ? null : (
            <button type="button" className={styles.retry} onClick={onRetry}>
              Try again
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
            <button type="button" className={styles.retry} onClick={onRetry}>
              Try again
            </button>
          ) : null}
        </div>
      )}

      <footer className={styles.footer}>
        {turn.answer === '' ? null : (
          <CopyButton getText={() => turn.answer} label="Copy this reply" />
        )}
        {hasReportedUsage(turn.usage) ? (
          <span className={styles.usage}>{formatUsage(turn.usage)}</span>
        ) : null}
        {turn.phase === 'stopped' && turn.error === null ? (
          <span className={styles.usage}>Stopped</span>
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
