import { describe, expect, it } from 'vitest';

import type { ChatError, Degradation, Diagnosis, KnownCause } from '@/platform/contract';
import type { ContextRef, RunDegradation } from '@/platform/contract-harness';

import {
  describeChatError,
  describeDegradation,
  describeMalformedReason,
  describeRunDegradation,
} from './notices';

/** A diagnosis, as the host builds one: a closed cause plus integers. */
function diagnosis(cause: KnownCause, extras: Partial<Diagnosis> = {}): Diagnosis {
  return { cause, correlation: 7, ...extras };
}

/** Every degradation the contract can carry. Keep in step with the union. */
const ALL_DEGRADATIONS: readonly Degradation[] = [
  { kind: 'toolCallingEmulated', toolCount: 2 },
  { kind: 'toolCatalogueWithheld' },
  { kind: 'contextReduced', droppedMessages: 3, approxDroppedTokens: 900, strategy: 'elideOldest' },
  { kind: 'contextReduced', droppedMessages: 1, approxDroppedTokens: 40, strategy: 'summarise' },
  { kind: 'structuredOutputUnsupported' },
  { kind: 'structuredOutputMismatch', detail: 'expected an object at /items' },
  { kind: 'malformedFramesSkipped', count: 2 },
  { kind: 'unterminatedReasoning', recoveredAnswerChars: 0 },
  { kind: 'unterminatedReasoning', recoveredAnswerChars: 12 },
  { kind: 'noTerminationSentinel' },
  { kind: 'usageNotReported' },
  { kind: 'malformedToolCalls', count: 1 },
  { kind: 'failedOver', attempts: 2 },
];

/** A ref as `project-context.ts` mints one: a fixed label, nothing counted. */
const INSTRUCTIONS_REF: ContextRef = {
  source: 'projectInstructions',
  id: 'project:p1:instructions',
  title: 'Project instructions',
  estimatedTokens: null,
};

/**
 * Every degradation an **agent run** can carry. Keep in step with the union.
 *
 * A second list rather than entries in {@link ALL_DEGRADATIONS}, because
 * `RunDegradation` is a separate union from `Degradation` — that one mirrors a
 * Rust enum and merging them would break the parity test holding the two
 * honest.
 *
 * Four of these five had no assertion anywhere when they were written, which is
 * how they nearly shipped: `use-conversation.ts` had always dropped `degraded`
 * events, so adding the wording and adding the first reader happened in one
 * change and only the arm that change was *about* got exercised. Three of the
 * four are emitted by the shipping loop (`agent-loop-harness.ts` emits
 * `wallClockLimitReached`, `toolCallLimitReached` and `stepLimitReached`), so
 * they are sentences a user can reach today.
 *
 * `auxiliaryModelUnavailable` is the exception and is listed anyway. That loop
 * documents that it **never emits** it — it has no internal steps to fall back
 * — so nothing renders it yet. It is on the union, this mapping must stay total,
 * and a harness that adds an internal step owes the degradation and will find
 * the wording already written.
 */
const ALL_RUN_DEGRADATIONS: readonly RunDegradation[] = [
  { kind: 'auxiliaryModelUnavailable' },
  { kind: 'stepLimitReached', steps: 1 },
  { kind: 'stepLimitReached', steps: 4 },
  { kind: 'toolCallLimitReached', calls: 1 },
  { kind: 'toolCallLimitReached', calls: 6 },
  { kind: 'wallClockLimitReached', elapsedMs: 30_000 },
  { kind: 'contextUnavailable', ref: INSTRUCTIONS_REF },
];

const ALL_ERRORS: readonly ChatError[] = [
  {
    kind: 'contextLengthExceeded',
    limitTokens: 4096,
    requestedTokens: 5000,
    diagnosis: diagnosis('context_window_exceeded'),
  },
  {
    kind: 'contextLengthExceeded',
    limitTokens: null,
    requestedTokens: null,
    diagnosis: diagnosis('context_window_exceeded'),
  },
  { kind: 'authFailed', diagnosis: diagnosis('credential_rejected', { status: 401 }) },
  { kind: 'rateLimited', retryAfterMs: 2500, diagnosis: diagnosis('too_many_requests') },
  { kind: 'rateLimited', retryAfterMs: null, diagnosis: diagnosis('too_many_requests') },
  { kind: 'modelNotFound', modelId: 'q4-small', diagnosis: diagnosis('model_not_served') },
  {
    kind: 'capabilityUnsupported',
    capability: 'vision',
    diagnosis: diagnosis('capability_absent_on_this_model'),
  },
  { kind: 'transport', failure: 'connect', diagnosis: diagnosis('connection_failed') },
  { kind: 'transport', failure: 'timeout', diagnosis: diagnosis('request_timed_out') },
  { kind: 'transport', failure: 'stalled', diagnosis: diagnosis('stream_stalled') },
  { kind: 'transport', failure: 'reset', diagnosis: diagnosis('connection_reset') },
  {
    kind: 'transport',
    failure: { server: { status: 503 } },
    diagnosis: diagnosis('endpoint_failed_to_answer', { status: 503 }),
  },
  {
    kind: 'transport',
    failure: { request: { status: 413 } },
    diagnosis: diagnosis('request_too_large', { status: 413 }),
  },
  { kind: 'malformedResponse', diagnosis: diagnosis('response_was_not_json') },
  { kind: 'cancelled' },
];

/**
 * Everything the host can say about a backend has to be sayable *without*
 * naming one. This is the same rule `no-provider-leak.test.ts` enforces on the
 * source; here it is enforced on the strings a user actually reads.
 */
const PROVIDER_NAMES =
  /ollama|llama|lm ?studio|vllm|openai|anthropic|gemini|claude|gpt-|mistral|cohere/i;

describe('degradation wording', () => {
  it('produces a title and a detail for every variant', () => {
    for (const degradation of ALL_DEGRADATIONS) {
      const notice = describeDegradation(degradation);
      expect(notice.title, degradation.kind).not.toBe('');
      expect(notice.detail, degradation.kind).not.toBe('');
    }
  });

  it('never names a backend', () => {
    for (const degradation of ALL_DEGRADATIONS) {
      const notice = describeDegradation(degradation);
      expect(`${notice.title} ${notice.detail}`).not.toMatch(PROVIDER_NAMES);
    }
  });

  it('warns about the ones that change how the answer should be read', () => {
    expect(describeDegradation({ kind: 'usageNotReported' }).tone).toBe('info');
    expect(
      describeDegradation({ kind: 'structuredOutputMismatch', detail: 'x' }).tone,
    ).toBe('warning');
    expect(describeDegradation({ kind: 'malformedToolCalls', count: 1 }).tone).toBe('warning');
  });

  it('says plainly when an unterminated block left no answer at all', () => {
    expect(
      describeDegradation({ kind: 'unterminatedReasoning', recoveredAnswerChars: 0 }).detail,
    ).toMatch(/no answer text/);
  });

  it('agrees with itself on singular and plural', () => {
    expect(describeDegradation({ kind: 'malformedFramesSkipped', count: 1 }).detail).toContain(
      '1 frame could not be parsed',
    );
    expect(describeDegradation({ kind: 'malformedFramesSkipped', count: 3 }).detail).toContain(
      '3 frames could not be parsed',
    );
  });
});

describe('run degradation wording', () => {
  it('produces a title and a detail for every variant', () => {
    for (const degradation of ALL_RUN_DEGRADATIONS) {
      const notice = describeRunDegradation(degradation);
      expect(notice.title, degradation.kind).not.toBe('');
      expect(notice.detail, degradation.kind).not.toBe('');
    }
  });

  it('never names a backend', () => {
    for (const degradation of ALL_RUN_DEGRADATIONS) {
      const notice = describeRunDegradation(degradation);
      expect(`${notice.title} ${notice.detail}`).not.toMatch(PROVIDER_NAMES);
    }
  });

  it('never renders a raw enum name or an undefined at the user', () => {
    // The failure mode a total switch does not catch: an arm that compiles,
    // returns strings, and interpolates something the user cannot read. Every
    // one of these arms carries a field, and a typo in the template shows up
    // here rather than on somebody's screen.
    for (const degradation of ALL_RUN_DEGRADATIONS) {
      const notice = describeRunDegradation(degradation);
      const sentence = `${notice.title} ${notice.detail}`;
      expect(sentence, degradation.kind).not.toContain(degradation.kind);
      expect(sentence, degradation.kind).not.toMatch(/undefined|NaN|\[object/);
    }
  });

  it('says which material went missing, in the words the ref carries', () => {
    // `ContextRef.title` is documented as the user's own text. Quoting it is how
    // somebody tells which of several sources was the one that could not be
    // read, so the wording has to actually use it.
    const notice = describeRunDegradation({ kind: 'contextUnavailable', ref: INSTRUCTIONS_REF });
    expect(notice.detail).toContain('Project instructions');
    expect(notice.tone).toBe('warning');
  });

  it('reports the figure each limit actually stopped at', () => {
    // A limit notice whose number is wrong is worse than none: it sends the user
    // to change a setting that was not the one that bit.
    expect(describeRunDegradation({ kind: 'stepLimitReached', steps: 4 }).detail).toContain(
      '4 steps',
    );
    expect(describeRunDegradation({ kind: 'toolCallLimitReached', calls: 6 }).detail).toContain(
      '6 tool calls',
    );
    // Milliseconds are the wire unit and seconds are the readable one; a user
    // told their run passed a "30000-second budget" would not believe the notice.
    expect(
      describeRunDegradation({ kind: 'wallClockLimitReached', elapsedMs: 30_000 }).detail,
    ).toContain('30-second');
  });

  it('agrees with itself on singular and plural', () => {
    expect(describeRunDegradation({ kind: 'stepLimitReached', steps: 1 }).detail).toContain(
      '1 step ',
    );
    expect(describeRunDegradation({ kind: 'toolCallLimitReached', calls: 1 }).detail).toContain(
      '1 tool call ',
    );
  });

  it('warns about the ones that changed the answer, and only informs about the rest', () => {
    // Tone is about consequence. A run that stopped early, or that ran without
    // material the user wrote, produced an answer that looks complete and is
    // not — the reader has to be told. One model doing the internal steps as
    // well changes nothing about what they are reading.
    expect(describeRunDegradation({ kind: 'auxiliaryModelUnavailable' }).tone).toBe('info');
    for (const degradation of ALL_RUN_DEGRADATIONS) {
      if (degradation.kind === 'auxiliaryModelUnavailable') continue;
      expect(describeRunDegradation(degradation).tone, degradation.kind).toBe('warning');
    }
  });
});

describe('error wording', () => {
  it('produces a title and a detail for every variant', () => {
    for (const error of ALL_ERRORS) {
      const notice = describeChatError(error);
      expect(notice.title, error.kind).not.toBe('');
      expect(notice.detail, error.kind).not.toBe('');
      expect(`${notice.title} ${notice.detail}`).not.toMatch(PROVIDER_NAMES);
    }
  });

  it('offers a retry only where trying again could plausibly work', () => {
    expect(
      describeChatError({
        kind: 'transport',
        failure: 'connect',
        diagnosis: diagnosis('connection_failed'),
      }).retryable,
    ).toBe(true);
    expect(
      describeChatError({
        kind: 'transport',
        failure: { server: { status: 503 } },
        diagnosis: diagnosis('endpoint_failed_to_answer'),
      }).retryable,
    ).toBe(true);
    // A 4xx is a statement about this request; the same request earns it again.
    expect(
      describeChatError({
        kind: 'transport',
        failure: { request: { status: 413 } },
        diagnosis: diagnosis('request_too_large'),
      }).retryable,
    ).toBe(false);
    expect(
      describeChatError({ kind: 'authFailed', diagnosis: diagnosis('credential_rejected') })
        .retryable,
    ).toBe(false);
  });

  it('reads cancellation as something the user did', () => {
    const notice = describeChatError({ kind: 'cancelled' });
    expect(notice.title).toBe('Stopped');
    expect(notice.detail).toMatch(/you stopped/i);
  });

  /**
   * The renderer's half of `diagnostic.rs`'s bargain. The endpoint chooses
   * which cause is reported; every word a user reads is written in Vela's own
   * source. There is no field on the wire this could be read from, and this
   * test is what keeps it that way if one is ever added.
   */
  it('writes every sentence itself, from the cause alone', () => {
    const notice = describeChatError({
      kind: 'transport',
      failure: 'connect',
      diagnosis: {
        cause: 'connection_failed',
        status: 502,
        endpoint: { authority: 'http://127.0.0.1:8080', path: '/v1' },
        correlation: 42,
      },
    });
    expect(notice.detail).toBe('Vela could not open a connection. The endpoint answered 502.');
    expect(notice.endpoint).toBe('http://127.0.0.1:8080/v1');
    expect(notice.correlation).toBe('000000000000002a');
  });

  it('falls back to the error kind when the host reports a cause it does not know', () => {
    // `Cause` is `#[non_exhaustive]`: a newer host is a normal state, not a bug.
    const notice = describeChatError({
      kind: 'malformedResponse',
      diagnosis: { cause: 'something_invented_later', correlation: 0 },
    });
    expect(notice.detail).toBe('Vela could not read the reply');
    expect(notice.detail).not.toContain('something_invented_later');
    expect(notice.correlation).toBeNull();
  });

  it('reports a content-filter refusal from the closed filter vocabulary', () => {
    const notice = describeChatError({
      kind: 'malformedResponse',
      diagnosis: {
        cause: 'content_filter_refused_the_turn',
        filter: { stage: 'answer', kind: 'recitation', categories: 0, generatedChars: 120 },
        correlation: 9,
      },
    });
    expect(notice.detail).toContain('A content filter refused this turn.');
    expect(notice.detail).toContain('as it was answering by the recitation filter');
    expect(notice.detail).toContain('120 characters had already been written');
  });

  it('turns a retry-after into seconds a person can act on', () => {
    expect(
      describeChatError({
        kind: 'rateLimited',
        retryAfterMs: 2500,
        diagnosis: diagnosis('too_many_requests'),
      }).detail,
    ).toContain('3 seconds');
  });
});

describe('malformed tool-call wording', () => {
  it('explains each refusal without inventing a fault the host did not report', () => {
    expect(describeMalformedReason('missingName')).toMatch(/name/);
    expect(describeMalformedReason('unparseableArguments')).toMatch(/JSON/);
    expect(describeMalformedReason('argumentsNotAnObject')).toMatch(/object/);
    expect(describeMalformedReason('unknownDiscriminator')).toMatch(/function/);
    expect(describeMalformedReason('recoveredFromUnterminatedReasoning')).toMatch(/never committed/);
  });
});
