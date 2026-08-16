/**
 * The store↔transcript translation, as pure data. No DOM, no adapter, no clock.
 *
 * The assertions worth having here are the ones about what is *not* rebuilt:
 * a restore that quietly invents a diagnosis or a tool call is a restore that
 * tells the user something the store never recorded.
 */

import { describe, expect, it } from 'vitest';

import type { StoredMessage, StoredMessageStatus } from '@/platform/contract';

import { entriesFromStored, errorMessageOfTurn, partsOfTurn, statusOfTurn } from './stored-entries';
import { EMPTY_TURN, type TurnState } from './turn-stream';

const NO_USAGE = {
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  cachedInputTokens: null,
} as const;

function stored(overrides: Partial<StoredMessage> & Pick<StoredMessage, 'id' | 'role'>): StoredMessage {
  return {
    conversationId: 'conv_1',
    seq: 0,
    status: 'complete' as StoredMessageStatus,
    parts: [],
    providerId: 'workstation',
    modelId: 'local-model',
    // Unattributed by default: a stored row from before provenance existed, and
    // the shape a fixture must not silently improve on.
    answeredByProviderId: null,
    answeredByModelId: null,
    usage: NO_USAGE,
    stopReason: null,
    errorMessage: null,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function settled(overrides: Partial<TurnState>): TurnState {
  return { ...EMPTY_TURN, phase: 'complete', ...overrides };
}

describe('restoring a transcript from the store', () => {
  it('keeps the answer and the reasoning in their own channels', () => {
    const entries = entriesFromStored([
      stored({ id: 'm1', role: 'user', parts: [{ kind: 'text', text: 'why is the sky blue' }] }),
      stored({
        id: 'm2',
        role: 'assistant',
        parts: [
          { kind: 'reasoning', text: 'Rayleigh scattering, probably.' },
          { kind: 'text', text: 'Shorter wavelengths scatter more.' },
        ],
        stopReason: 'endTurn',
      }),
    ]);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ kind: 'user', id: 'm1', text: 'why is the sky blue' });

    const reply = entries[1];
    expect(reply?.kind).toBe('assistant');
    if (reply?.kind !== 'assistant') return;
    expect(reply.turn.answer).toBe('Shorter wavelengths scatter more.');
    expect(reply.turn.reasoning).toBe('Rayleigh scattering, probably.');
    // The invariant the whole reasoning channel exists for: it never leaks into
    // the answer, on the way out of the store any more than on the way in.
    expect(reply.turn.answer).not.toContain('Rayleigh');
    expect(reply.turn.reasoningPhase).toBe('complete');
    expect(reply.turn.stopReason).toBe('endTurn');
  });

  it('never comes back with a spinner that cannot resolve', () => {
    // A message still marked `streaming` is a turn the app never finished. It
    // must restore into a phase the UI can draw as settled — restoring the
    // phase literally would leave "Waiting for the first token…" on screen for
    // a turn whose stream ended when the window closed.
    const [entry] = entriesFromStored([
      stored({ id: 'm1', role: 'assistant', status: 'streaming', parts: [{ kind: 'text', text: 'half an ans' }] }),
    ]);

    expect(entry?.kind).toBe('assistant');
    if (entry?.kind !== 'assistant') return;
    expect(entry.turn.phase).toBe('stopped');
    expect(entry.turn.answer).toBe('half an ans');
  });

  it('records that a turn failed without inventing why', () => {
    // `errorMessage` is a sentence; `ChatError` is a closed union carrying a
    // diagnosis. Widening one back into the other would put a specific claim
    // about the failure in front of the user on the strength of a string.
    const [entry] = entriesFromStored([
      stored({
        id: 'm1',
        role: 'assistant',
        status: 'failed',
        errorMessage: 'the endpoint refused',
        parts: [],
      }),
    ]);

    expect(entry?.kind).toBe('assistant');
    if (entry?.kind !== 'assistant') return;
    expect(entry.turn.phase).toBe('failed');
    expect(entry.turn.error).toBeNull();
    expect(entry.turn.refusal).toBeNull();
  });

  it('does not restore tool calls it cannot restore honestly', () => {
    // `emulated` is not a stored field, and it is the flag that decides whether
    // the UI says "this model has no native tool calling, so Vela recovered
    // these from its text". A restored call claiming `emulated: false` would be
    // a false statement about provenance on every emulated call.
    const [entry] = entriesFromStored([
      stored({
        id: 'm1',
        role: 'assistant',
        parts: [{ kind: 'toolCall', callId: 'c1', name: 'get_weather', arguments: { city: 'Oslo' } }],
      }),
    ]);

    expect(entry?.kind).toBe('assistant');
    if (entry?.kind !== 'assistant') return;
    expect(entry.turn.outcomes).toEqual([]);
  });

  it('leaves system and tool messages out of the transcript', () => {
    const entries = entriesFromStored([
      stored({ id: 'm1', role: 'system', parts: [{ kind: 'text', text: 'you are helpful' }] }),
      stored({ id: 'm2', role: 'user', parts: [{ kind: 'text', text: 'hello' }] }),
      stored({ id: 'm3', role: 'tool', parts: [{ kind: 'toolResult', callId: 'c1', content: '21C' }] }),
    ]);

    expect(entries.map((entry) => entry.id)).toEqual(['m2']);
  });

  it('reports no usage as no usage rather than as four zeroes', () => {
    const [entry] = entriesFromStored([stored({ id: 'm1', role: 'assistant' })]);
    expect(entry?.kind).toBe('assistant');
    if (entry?.kind !== 'assistant') return;
    expect(entry.turn.usage).toBeNull();
  });
});

describe('writing a settled turn to the store', () => {
  it('writes reasoning as its own part, ahead of the answer', () => {
    expect(partsOfTurn(settled({ answer: 'the answer', reasoning: 'the working' }))).toEqual([
      { kind: 'reasoning', text: 'the working' },
      { kind: 'text', text: 'the answer' },
    ]);
  });

  it('writes nothing for a channel that produced nothing', () => {
    expect(partsOfTurn(settled({ answer: 'just this' }))).toEqual([{ kind: 'text', text: 'just this' }]);
    expect(partsOfTurn(settled({ answer: '', reasoning: '' }))).toEqual([]);
  });

  it('uses the store word for how the turn ended', () => {
    expect(statusOfTurn(settled({ phase: 'complete' }))).toBe('complete');
    // "Stopped" is the user cancelling, which the store calls `cancelled` — and
    // which is emphatically not `failed`.
    expect(statusOfTurn(settled({ phase: 'stopped' }))).toBe('cancelled');
    expect(statusOfTurn(settled({ phase: 'failed' }))).toBe('failed');
  });

  it('keeps the sentence the user was shown for a refusal', () => {
    expect(
      errorMessageOfTurn(settled({ phase: 'failed', refusal: { code: 'NOT_FOUND', message: 'no such provider' } })),
    ).toBe('no such provider');
    expect(errorMessageOfTurn(settled({}))).toBeNull();
  });
});

describe('who answered survives the reload', () => {
  /**
   * **The disclosure has to still be there tomorrow.**
   *
   * The answering endpoint is written to its own column, carried through the
   * contract and the adapters — and was then read by nothing. `turnFromStored`
   * never set `answeredBy`, so every restored turn came back `null`, which the
   * wording layer treats as "unattributed" and renders as silence. Reopening a
   * conversation therefore erased a substitution the store had recorded
   * correctly: host-complete, renderer-absent, inside the fix for the defect
   * that pattern was found in.
   *
   * The two ids differ on purpose. A restore that copied `providerId` into both
   * would satisfy "answeredBy is not null" and still be the original lie.
   */
  it('restores the endpoint that answered, distinct from the one addressed', () => {
    const [entry] = entriesFromStored([
      stored({
        id: 'msg_1',
        role: 'assistant',
        parts: [{ kind: 'text', text: 'the answer' }],
        providerId: 'home-workstation',
        modelId: 'local-model',
        answeredByProviderId: 'rented-gpu-box',
        answeredByModelId: 'big-model',
      }),
    ]);

    expect(entry?.kind).toBe('assistant');
    const turn = entry?.kind === 'assistant' ? entry.turn : null;
    expect(turn?.answeredBy).toEqual({ providerId: 'rented-gpu-box', modelId: 'big-model' });
  });

  /**
   * The silence that must survive the reload too.
   *
   * Every row written before the answering columns existed looks like this, and
   * `providerId` is sitting right there in the same object. Reading it would
   * make the transcript claim, of every historical turn, that the selected
   * endpoint answered it.
   */
  it('leaves a row that recorded no attribution unattributed, and does not read the selection', () => {
    const [entry] = entriesFromStored([
      stored({
        id: 'msg_1',
        role: 'assistant',
        parts: [{ kind: 'text', text: 'the answer' }],
        providerId: 'home-workstation',
        modelId: 'local-model',
      }),
    ]);

    const turn = entry?.kind === 'assistant' ? entry.turn : null;
    expect(turn?.answeredBy).toBeNull();
  });

  /**
   * A half-written row is no record.
   *
   * `AnswerProvenance` has no shape for "an endpoint whose model is unknown",
   * and the only value lying around to fill the gap with is `modelId` — the
   * model the user *selected*. Splicing the two together would manufacture a
   * provenance that names an endpoint and a model that never met.
   */
  it('treats a half-recorded attribution as no attribution rather than borrowing the other half', () => {
    const providerOnly = entriesFromStored([
      stored({
        id: 'msg_1',
        role: 'assistant',
        parts: [{ kind: 'text', text: 'a' }],
        answeredByProviderId: 'rented-gpu-box',
      }),
    ])[0];
    const modelOnly = entriesFromStored([
      stored({
        id: 'msg_2',
        role: 'assistant',
        parts: [{ kind: 'text', text: 'b' }],
        answeredByModelId: 'big-model',
      }),
    ])[0];

    expect(providerOnly?.kind === 'assistant' ? providerOnly.turn.answeredBy : 'not an assistant').toBeNull();
    expect(modelOnly?.kind === 'assistant' ? modelOnly.turn.answeredBy : 'not an assistant').toBeNull();
  });
});
