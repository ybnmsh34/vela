import { describe, expect, it } from 'vitest';

import type {
  ChatError,
  ChatResponseBody,
  ChatStreamEvent,
  Diagnosis,
  TokenUsage,
} from '@/platform/contract';

import {
  EMPTY_TURN,
  hasReportedUsage,
  isSettled,
  reduceTurn,
  turnFromParts,
  type TurnState,
} from './turn-stream';

const NO_USAGE: TokenUsage = {
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  cachedInputTokens: null,
};

function response(overrides: Partial<ChatResponseBody> = {}): ChatResponseBody {
  return {
    parts: [],
    toolCalls: [],
    stopReason: 'endTurn',
    usage: NO_USAGE,
    structured: null,
    degradations: [],
    ...overrides,
  };
}

/**
 * A diagnosis in the shape the host now sends: a closed cause plus integers,
 * and nowhere at all to put text the endpoint chose.
 */
const DIAGNOSIS: Diagnosis = { cause: 'stream_stalled', correlation: 3 };

const STALLED: ChatError = { kind: 'transport', failure: 'stalled', diagnosis: DIAGNOSIS };

function play(events: readonly ChatStreamEvent[], from: TurnState = EMPTY_TURN): TurnState {
  return events.reduce(reduceTurn, from);
}

describe('the turn reducer', () => {
  it('starts awaiting and becomes streaming on the first delta', () => {
    expect(EMPTY_TURN.phase).toBe('awaiting');
    expect(play([{ type: 'textDelta', text: 'hi' }]).phase).toBe('streaming');
  });

  it('accumulates answer deltas in order', () => {
    const turn = play([
      { type: 'textDelta', text: 'The ' },
      { type: 'textDelta', text: 'quick ' },
      { type: 'textDelta', text: 'fox.' },
    ]);
    expect(turn.answer).toBe('The quick fox.');
  });

  it('keeps reasoning in its own channel, never in the answer', () => {
    const turn = play([
      { type: 'reasoningDelta', text: 'let me check' },
      { type: 'textDelta', text: 'Yes.' },
    ]);
    expect(turn.answer).toBe('Yes.');
    expect(turn.reasoning).toBe('let me check');
    expect(turn.reasoningPhase).toBe('streaming');
  });

  /**
   * The host separates reasoning already. This asserts the renderer survives a
   * host that did not — a hostile endpoint, a future adapter with a bug — with
   * the markup still never reaching the answer.
   */
  it('strips reasoning markup that reaches the answer channel anyway', () => {
    const turn = play([
      { type: 'textDelta', text: 'Answer: <thi' },
      { type: 'textDelta', text: 'nk>secretly deliberating</think>42' },
      { type: 'done', response: response() },
    ]);
    expect(turn.answer).toBe('Answer: 42');
    expect(turn.answer).not.toContain('think');
    expect(turn.reasoning).toBe('secretly deliberating');
  });

  it('marks an unterminated block and keeps its text visible', () => {
    const turn = play([
      { type: 'textDelta', text: 'lead <think>never closed' },
      { type: 'done', response: response({ stopReason: 'unspecified' }) },
    ]);
    expect(turn.reasoningPhase).toBe('unterminated');
    expect(turn.reasoning).toBe('never closed');
    expect(turn.answer).toBe('lead ');
  });

  it('trusts the host degradation for an unterminated block even without local markup', () => {
    const turn = play([
      { type: 'reasoningDelta', text: 'thinking' },
      {
        type: 'done',
        response: response({ degradations: [{ kind: 'unterminatedReasoning', recoveredAnswerChars: 0 }] }),
      },
    ]);
    expect(turn.reasoningPhase).toBe('unterminated');
  });

  it('assembles tool-call fragments by slot, not by arrival order', () => {
    const turn = play([
      { type: 'toolCallDelta', delta: { slot: 0, callId: 'a', name: 'search', argumentsFragment: '{"q":' } },
      { type: 'toolCallDelta', delta: { slot: 7, callId: 'b', name: 'clock', argumentsFragment: '{}' } },
      { type: 'toolCallDelta', delta: { slot: 0, callId: null, name: null, argumentsFragment: '"cats"}' } },
    ]);
    expect(turn.toolProgress).toEqual([
      { slot: 0, callId: 'a', name: 'search', argumentsText: '{"q":"cats"}' },
      { slot: 7, callId: 'b', name: 'clock', argumentsText: '{}' },
    ]);
  });

  it('keeps a malformed tool call rather than dropping it', () => {
    const turn = play([
      {
        type: 'done',
        response: response({
          toolCalls: [
            {
              status: 'malformed',
              index: 7,
              callId: null,
              name: null,
              rawArguments: '{"broken":',
              reason: 'unparseableArguments',
            },
          ],
          degradations: [{ kind: 'malformedToolCalls', count: 1 }],
        }),
      },
    ]);
    expect(turn.outcomes).toHaveLength(1);
    expect(turn.degradations).toEqual([{ kind: 'malformedToolCalls', count: 1 }]);
  });

  it('adopts the response body when the backend could not stream at all', () => {
    // One `done` and nothing else: the non-streaming path.
    const turn = play([
      {
        type: 'done',
        response: response({
          parts: [
            { kind: 'reasoning', text: 'quietly', signature: null, redacted: false },
            { kind: 'text', text: 'All at once.' },
          ],
        }),
      },
    ]);
    expect(turn.answer).toBe('All at once.');
    expect(turn.reasoning).toBe('quietly');
    expect(turn.phase).toBe('complete');
  });

  it('does not double-print an answer that both streamed and arrived in `done`', () => {
    const turn = play([
      { type: 'textDelta', text: 'Streamed.' },
      { type: 'done', response: response({ parts: [{ kind: 'text', text: 'Streamed.' }] }) },
    ]);
    expect(turn.answer).toBe('Streamed.');
  });

  it('treats cancellation as stopped, not failed, from either signal', () => {
    const viaError = play([{ type: 'error', error: { kind: 'cancelled' } }]);
    expect(viaError.phase).toBe('stopped');

    const viaStopReason = play([{ type: 'done', response: response({ stopReason: 'cancelled' }) }]);
    expect(viaStopReason.phase).toBe('stopped');
  });

  it('keeps the partial answer when a stream fails mid-flight', () => {
    const turn = play([
      { type: 'textDelta', text: 'As far as I got' },
      { type: 'error', error: STALLED },
    ]);
    expect(turn.phase).toBe('failed');
    expect(turn.answer).toBe('As far as I got');
    expect(turn.error).toEqual(STALLED);
  });

  it('always leaves a settled phase after a terminal event', () => {
    const terminals: ChatStreamEvent[] = [
      { type: 'done', response: response() },
      { type: 'error', error: { kind: 'malformedResponse', diagnosis: DIAGNOSIS } },
      { type: 'error', error: { kind: 'cancelled' } },
    ];
    for (const terminal of terminals) {
      expect(isSettled(play([{ type: 'textDelta', text: 'x' }, terminal]))).toBe(true);
    }
  });

  it('reports usage only when the endpoint sent a figure', () => {
    expect(hasReportedUsage(NO_USAGE)).toBe(false);
    expect(hasReportedUsage(null)).toBe(false);
    expect(hasReportedUsage({ ...NO_USAGE, outputTokens: 0 })).toBe(true);

    const turn = play([{ type: 'usage', usage: { ...NO_USAGE, outputTokens: 12 } }]);
    expect(turn.usage?.outputTokens).toBe(12);
  });

  it('does not let an empty usage block in `done` erase a reported one', () => {
    const turn = play([
      { type: 'usage', usage: { ...NO_USAGE, outputTokens: 12 } },
      { type: 'done', response: response() },
    ]);
    expect(turn.usage?.outputTokens).toBe(12);
  });

  it('rebuilds a stored turn into the same shape a stream produces', () => {
    const restored = turnFromParts([
      { kind: 'reasoning', text: 'earlier thought', signature: null, redacted: false },
      { kind: 'text', text: 'earlier answer' },
    ]);
    expect(restored.answer).toBe('earlier answer');
    expect(restored.reasoning).toBe('earlier thought');
    expect(restored.reasoningPhase).toBe('complete');
    expect(isSettled(restored)).toBe(true);
  });
});
