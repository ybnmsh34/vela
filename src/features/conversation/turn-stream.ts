/**
 * The streaming state machine for one assistant turn.
 *
 * A pure reducer over the six normalised host events. Everything the
 * conversation renders is derived from here, which is what makes the surface
 * testable without a DOM, a timer, or a fake component tree.
 *
 * ## The invariants it holds
 *
 * * **The answer never contains reasoning markup.** Every `textDelta` goes
 *   through {@link guardDelta} first (see `reasoning-guard.ts` for why the
 *   renderer re-checks something the host already did).
 * * **The stream always ends.** `done` and `error` are the only terminal
 *   events, and both leave a phase the UI can draw. There is no path that
 *   leaves a spinner running forever, because there is no path that leaves the
 *   phase `streaming`.
 * * **Cancelling is not failing.** A `cancelled` error and a `cancelled` stop
 *   reason both land in {@link TurnPhase} `stopped`, which reads as "you
 *   stopped this", not "something went wrong".
 * * **Nothing is silently dropped.** Malformed tool calls, degradations and
 *   unreported usage all survive into the state so the view can show them. The
 *   host refuses to execute a bad reconstruction precisely so the UI can
 *   display it; dropping it here would waste that.
 */

import type {
  ChatError,
  ChatStreamEvent,
  ContentPart,
  Degradation,
  StopReason,
  TokenUsage,
  ToolCallOutcome,
} from '@/platform/contract';

import { flushGuard, guardDelta, GUARD_START, type GuardState } from './reasoning-guard';

/**
 * `awaiting` is the gap between "sent" and "first token" — the only place a
 * spinner belongs. `streaming` means text is arriving and the spinner is gone.
 */
export type TurnPhase = 'awaiting' | 'streaming' | 'complete' | 'stopped' | 'failed';

/** How much of the reasoning channel has arrived. */
export type ReasoningPhase = 'none' | 'streaming' | 'complete' | 'unterminated';

/** A tool call being assembled, for progress only. Never executable. */
export interface ToolCallProgress {
  readonly slot: number;
  readonly callId: string | null;
  readonly name: string | null;
  readonly argumentsText: string;
}

export interface TurnState {
  readonly phase: TurnPhase;
  /** The model's answer. Guaranteed free of reasoning markup. */
  readonly answer: string;
  /** The model's deliberation. Subordinate to the answer; never merged into it. */
  readonly reasoning: string;
  readonly reasoningPhase: ReasoningPhase;
  readonly toolProgress: readonly ToolCallProgress[];
  /** Settled tool calls, including the malformed ones the host refused to run. */
  readonly outcomes: readonly ToolCallOutcome[];
  readonly degradations: readonly Degradation[];
  /** `null` until the endpoint reports usage — many never do. */
  readonly usage: TokenUsage | null;
  readonly stopReason: StopReason | null;
  readonly error: ChatError | null;
  /**
   * The host refused the turn before any stream existed — an unconfigured
   * provider, a payload the bridge rejected. Kept separate from {@link error}
   * because it is a fault in Vela's own wiring, not a report about the model,
   * and telling a user "the endpoint failed" when Vela never called one would
   * send them debugging the wrong thing.
   */
  readonly refusal: { readonly code: string; readonly message: string } | null;
  /** Scanner state for the markup guard. Internal; not for rendering. */
  readonly guard: GuardState;
}

export const EMPTY_TURN: TurnState = {
  phase: 'awaiting',
  answer: '',
  reasoning: '',
  reasoningPhase: 'none',
  toolProgress: [],
  outcomes: [],
  degradations: [],
  usage: null,
  stopReason: null,
  error: null,
  refusal: null,
  guard: GUARD_START,
};

export function isTerminalEvent(event: ChatStreamEvent): boolean {
  return event.type === 'done' || event.type === 'error';
}

export function isSettled(turn: TurnState): boolean {
  return turn.phase === 'complete' || turn.phase === 'stopped' || turn.phase === 'failed';
}

/** Whether usage carries any figure at all. All-`null` means "not reported". */
export function hasReportedUsage(usage: TokenUsage | null): usage is TokenUsage {
  return (
    usage !== null &&
    (usage.inputTokens !== null ||
      usage.outputTokens !== null ||
      usage.reasoningTokens !== null ||
      usage.cachedInputTokens !== null)
  );
}

export function reduceTurn(state: TurnState, event: ChatStreamEvent): TurnState {
  switch (event.type) {
    case 'textDelta': {
      const guarded = guardDelta(state.guard, event.text);
      return {
        ...state,
        phase: 'streaming',
        guard: guarded.state,
        answer: state.answer + guarded.answer,
        reasoning: state.reasoning + guarded.reasoning,
        reasoningPhase:
          guarded.reasoning === '' ? state.reasoningPhase : reasoningStreaming(state.reasoningPhase),
      };
    }

    case 'reasoningDelta':
      return {
        ...state,
        phase: 'streaming',
        reasoning: state.reasoning + event.text,
        reasoningPhase: reasoningStreaming(state.reasoningPhase),
      };

    case 'toolCallDelta':
      return {
        ...state,
        phase: 'streaming',
        toolProgress: mergeProgress(state.toolProgress, event.delta),
      };

    case 'usage':
      return { ...state, usage: event.usage };

    case 'done': {
      const flushed = flushGuard(state.guard);
      const answer = state.answer + flushed.answer;
      const reasoning = state.reasoning + flushed.reasoning;
      const adopted = partsToText(event.response.parts);

      // A backend with no streaming at all sends its whole turn in `done`.
      // Adopting the response's parts only when the deltas produced nothing
      // keeps that case working without ever double-printing a streamed answer.
      const finalAnswer = answer === '' ? adopted.answer : answer;
      const finalReasoning = reasoning === '' ? adopted.reasoning : reasoning;

      const unterminated =
        flushed.unterminated ||
        event.response.degradations.some((d) => d.kind === 'unterminatedReasoning');

      return {
        ...state,
        phase: event.response.stopReason === 'cancelled' ? 'stopped' : 'complete',
        guard: GUARD_START,
        answer: finalAnswer,
        reasoning: finalReasoning,
        reasoningPhase: settledReasoningPhase(finalReasoning, unterminated),
        outcomes: event.response.toolCalls,
        degradations: event.response.degradations,
        usage: hasReportedUsage(event.response.usage) ? event.response.usage : state.usage,
        stopReason: event.response.stopReason,
        error: null,
      };
    }

    case 'error': {
      const flushed = flushGuard(state.guard);
      const reasoning = state.reasoning + flushed.reasoning;
      return {
        ...state,
        // Cancelling is a thing the user did, not a thing that went wrong.
        phase: event.error.kind === 'cancelled' ? 'stopped' : 'failed',
        guard: GUARD_START,
        answer: state.answer + flushed.answer,
        reasoning,
        reasoningPhase: settledReasoningPhase(reasoning, flushed.unterminated),
        stopReason: event.error.kind === 'cancelled' ? 'cancelled' : state.stopReason,
        error: event.error,
      };
    }
  }
}

/**
 * Rebuilds a settled turn from stored content parts.
 *
 * Resume-safe rendering: a conversation reloaded from the store renders through
 * exactly the same view as one that streamed, because it arrives in exactly the
 * same shape. Reasoning stays in its own channel, as the store keeps it.
 */
export function turnFromParts(
  parts: readonly ContentPart[],
  overrides: Partial<TurnState> = {},
): TurnState {
  const { answer, reasoning } = partsToText(parts);
  return {
    ...EMPTY_TURN,
    phase: 'complete',
    answer,
    reasoning,
    reasoningPhase: reasoning === '' ? 'none' : 'complete',
    stopReason: 'endTurn',
    ...overrides,
  };
}

function partsToText(parts: readonly ContentPart[]): { answer: string; reasoning: string } {
  let answer = '';
  let reasoning = '';
  for (const part of parts) {
    if (part.kind === 'text') answer += part.text;
    else if (part.kind === 'reasoning') reasoning += part.text;
  }
  return { answer, reasoning };
}

function reasoningStreaming(current: ReasoningPhase): ReasoningPhase {
  return current === 'unterminated' ? current : 'streaming';
}

function settledReasoningPhase(reasoning: string, unterminated: boolean): ReasoningPhase {
  if (unterminated) return 'unterminated';
  return reasoning === '' ? 'none' : 'complete';
}

/**
 * Upserts a fragment by slot.
 *
 * Keyed on the host's `slot`, never on array position: the host assigns slots
 * precisely because endpoints reuse, skip and re-order the wire `index`.
 */
function mergeProgress(
  progress: readonly ToolCallProgress[],
  delta: { slot: number; callId: string | null; name: string | null; argumentsFragment: string },
): readonly ToolCallProgress[] {
  const existing = progress.find((call) => call.slot === delta.slot);
  if (existing === undefined) {
    return [
      ...progress,
      {
        slot: delta.slot,
        callId: delta.callId,
        name: delta.name,
        argumentsText: delta.argumentsFragment,
      },
    ];
  }
  return progress.map((call) =>
    call.slot === delta.slot
      ? {
          slot: call.slot,
          callId: delta.callId ?? call.callId,
          name: delta.name ?? call.name,
          argumentsText: call.argumentsText + delta.argumentsFragment,
        }
      : call,
  );
}
