/**
 * Wording for the two things the host reports that a user must be able to read:
 * what Vela had to give up, and what went wrong.
 *
 * Pure functions over the contract's enums, so the wording is unit-tested and
 * the components stay dumb. Both mappings are **total** — a new variant on
 * either union fails the type check here rather than rendering as a blank.
 *
 * There is no provider name in any string, and there is nowhere to put one:
 * these functions receive enums, not ids.
 */

import type {
  ChatError,
  Degradation,
  Diagnosis,
  FilterKind,
  KnownCause,
  MalformedToolCallReason,
  TransportFailure,
} from '@/platform/contract';

export type NoticeTone = 'info' | 'warning';

export interface Notice {
  readonly tone: NoticeTone;
  readonly title: string;
  readonly detail: string;
}

/**
 * What was reduced, and what it means for the answer on screen.
 *
 * Tone is about consequence, not about how unusual the event is: a local
 * runtime not reporting token usage is normal and harmless (`info`), while an
 * answer that did not match the requested schema is a wrong answer that looks
 * right (`warning`).
 */
export function describeDegradation(degradation: Degradation): Notice {
  switch (degradation.kind) {
    case 'toolCallingEmulated':
      return {
        tone: 'info',
        title: 'Tools were described in the prompt',
        detail: `This model has no built-in tool calling, so ${String(degradation.toolCount)} tool${degradation.toolCount === 1 ? ' was' : 's were'} described in the prompt and the reply was read back for a call.`,
      };
    case 'toolCatalogueWithheld':
      return {
        tone: 'info',
        title: 'Tools were not offered',
        detail: 'This turn asked for no tool use, so the tool list was left out of the request.',
      };
    case 'contextReduced':
      return {
        tone: 'warning',
        title: 'The conversation was shortened',
        detail:
          degradation.strategy === 'summarise'
            ? `${String(degradation.droppedMessages)} earlier message${degradation.droppedMessages === 1 ? '' : 's'} (about ${String(degradation.approxDroppedTokens)} tokens) were replaced with a summary to fit the model's context window.`
            : `${String(degradation.droppedMessages)} of the oldest message${degradation.droppedMessages === 1 ? '' : 's'} (about ${String(degradation.approxDroppedTokens)} tokens) were left out to fit the model's context window.`,
      };
    case 'structuredOutputUnsupported':
      return {
        tone: 'warning',
        title: 'Structured output is not supported here',
        detail: 'This model does not honour a response schema, so the reply is plain text.',
      };
    case 'structuredOutputMismatch':
      return {
        tone: 'warning',
        title: 'The reply did not match the requested shape',
        detail: degradation.detail,
      };
    case 'malformedFramesSkipped':
      return {
        tone: 'warning',
        title: 'Part of the stream was unreadable',
        detail: `${String(degradation.count)} frame${degradation.count === 1 ? '' : 's'} could not be parsed and ${degradation.count === 1 ? 'was' : 'were'} skipped. Everything either side of ${degradation.count === 1 ? 'it' : 'them'} was kept.`,
      };
    case 'unterminatedReasoning':
      return {
        tone: 'warning',
        title: 'The thinking block was never closed',
        detail:
          degradation.recoveredAnswerChars === 0
            ? 'The stream ended mid-thought, so this turn has no answer text — only the reasoning above.'
            : `The stream ended mid-thought. ${String(degradation.recoveredAnswerChars)} characters of answer were recovered from inside the block.`,
      };
    case 'noTerminationSentinel':
      return {
        tone: 'info',
        title: 'The stream ended without a sentinel',
        detail: 'The endpoint closed the connection instead of marking the end. The reply is complete.',
      };
    case 'usageNotReported':
      return {
        tone: 'info',
        title: 'No token counts',
        detail: 'This endpoint does not report token usage.',
      };
    case 'malformedToolCalls':
      return {
        tone: 'warning',
        title: 'A tool call could not be read',
        // "Above", not "below": the transcript draws the calls first and the
        // degradation notes under them, and a pointer in the wrong direction
        // sends a user looking for evidence that is already on screen.
        detail: `${String(degradation.count)} tool call${degradation.count === 1 ? '' : 's'} arrived in a shape Vela could not reconstruct. ${degradation.count === 1 ? 'It was' : 'They were'} not run — ${degradation.count === 1 ? 'it is' : 'they are'} shown above.`,
      };
    case 'failedOver':
      return {
        tone: 'info',
        title: 'Retried before it worked',
        detail: `This answer took ${String(degradation.attempts)} attempt${degradation.attempts === 1 ? '' : 's'}.`,
      };
  }
}

export interface ErrorNotice {
  readonly title: string;
  readonly detail: string;
  /** Whether re-sending the same turn is worth offering. */
  readonly retryable: boolean;
  /**
   * The endpoint this error is about, as the user configured it — `null` when
   * the host never got as far as naming one. Shown because a user with three
   * candidates set up has to be able to tell which one failed.
   */
  readonly endpoint: string | null;
  /**
   * The join key into the user's own local debug log, or `null` for a failure
   * Vela raised without an exchange to correlate with. Never shown as an
   * apology — shown so a user who turned the log on can find the raw bytes.
   */
  readonly correlation: string | null;
}

/**
 * The sentence for each cause, **written here**.
 *
 * This is the renderer's half of `diagnostic.rs`'s bargain: the endpoint
 * decides which arm is taken and has no say in what the arm says. The map is
 * open because `Cause` is `#[non_exhaustive]` — a host newer than this renderer
 * falls back to the error kind's own title rather than rendering a blank or,
 * worse, the raw code.
 */
const CAUSE_SENTENCE: Readonly<Partial<Record<KnownCause, string>>> = {
  credential_rejected: 'The endpoint rejected the credential.',
  credential_missing: 'This model is set up to send a credential and none is stored.',
  credential_store_unreadable: 'Vela could not read the credential store.',
  credential_store_failed: 'The credential could not be resolved.',
  model_not_served: 'The endpoint does not serve this model.',
  model_list_malformed: 'The endpoint listed its models in a shape Vela could not read.',
  context_window_exceeded: 'The conversation does not fit this model’s context window.',
  pinned_turns_exceed_window:
    'Your message alone exceeds this model’s context window — there is nothing safe to drop.',
  request_too_large: 'The endpoint refused the request as too large.',
  too_many_requests: 'The endpoint is rate limiting Vela.',
  endpoint_overloaded: 'The endpoint says it is overloaded.',
  endpoint_failed_to_answer: 'The endpoint failed while answering.',
  endpoint_rejected_request: 'The endpoint rejected the request.',
  endpoint_timed_out: 'The endpoint timed out on its own side.',
  endpoint_cancelled_request: 'The endpoint cancelled the exchange.',
  endpoint_reported_an_error: 'The endpoint reported an error Vela could classify no further.',
  content_filter_refused_the_turn: 'A content filter refused this turn.',
  capability_refused_by_endpoint: 'The endpoint refused this capability.',
  capability_absent_on_this_model: 'This model was probed and does not offer this capability.',
  capability_not_offered_by_backend: 'This kind of endpoint does not offer this capability.',
  connection_failed: 'Vela could not open a connection.',
  request_timed_out: 'The request passed its deadline before an answer arrived.',
  stream_stalled: 'The reply stopped arriving and did not resume.',
  connection_reset: 'The connection was lost mid-reply.',
  redirect_refused_cross_authority:
    'The endpoint redirected to a different host. Vela refused to follow it, because your credential would have gone with it.',
  redirect_loop: 'The endpoint redirected in a loop.',
  no_endpoint_answered: 'None of the configured endpoints answered.',
  response_was_not_json: 'The reply was not JSON.',
  response_shape_unrecognised: 'The reply was not in a shape Vela could read.',
  stream_ended_without_answer: 'The stream ended without producing an answer.',
  request_could_not_be_encoded: 'Vela could not encode the request. This one is Vela’s fault.',
  no_provider_configured: 'No model is configured.',
  no_candidate_answered: 'Every configured model was tried and none answered.',
  caller_cancelled: 'You stopped this reply.',
  synthetic_test_failure: 'A synthetic failure from Vela’s own test harness.',
};

/** Filter wording, likewise Vela's own. */
const FILTER_KIND_LABEL: Readonly<Record<FilterKind, string>> = {
  safety: 'safety filter',
  prohibited_content: 'prohibited-content filter',
  blocklist: 'blocked-terms list',
  personal_information: 'personal-information filter',
  recitation: 'recitation filter',
  image_safety: 'image safety filter',
  unsupported_language: 'unsupported-language filter',
  other: 'content filter',
};

function causeSentence(diagnosis: Diagnosis, fallback: string): string {
  const sentence = CAUSE_SENTENCE[diagnosis.cause as KnownCause];
  return sentence ?? fallback;
}

/** `scheme://host[:port]/path` — the endpoint the user configured, nothing else. */
function endpointOf(diagnosis: Diagnosis): string | null {
  const endpoint = diagnosis.endpoint;
  if (endpoint === undefined) return null;
  return `${endpoint.authority}${endpoint.path === '' ? '/' : endpoint.path}`;
}

function correlationOf(diagnosis: Diagnosis): string | null {
  return diagnosis.correlation === 0 ? null : diagnosis.correlation.toString(16).padStart(16, '0');
}

/** Extra sentences a diagnosis can add beyond its cause. */
function embellish(diagnosis: Diagnosis): string {
  const parts: string[] = [];
  if (diagnosis.status !== undefined) parts.push(`The endpoint answered ${String(diagnosis.status)}.`);
  const filter = diagnosis.filter;
  if (filter !== undefined) {
    const where = filter.stage === 'prompt' ? 'before the model saw it' : 'as it was answering';
    parts.push(`Refused ${where} by the ${FILTER_KIND_LABEL[filter.kind]}.`);
    if (filter.generatedChars > 0) {
      parts.push(`${String(filter.generatedChars)} characters had already been written.`);
    }
  }
  return parts.join(' ');
}

function notice(
  title: string,
  diagnosis: Diagnosis,
  retryable: boolean,
  extra = '',
): ErrorNotice {
  const sentence = causeSentence(diagnosis, title);
  const detail = [sentence, embellish(diagnosis), extra].filter((part) => part !== '').join(' ');
  return { title, detail, retryable, endpoint: endpointOf(diagnosis), correlation: correlationOf(diagnosis) };
}

export function describeChatError(error: ChatError): ErrorNotice {
  switch (error.kind) {
    case 'contextLengthExceeded': {
      const limit = error.limitTokens;
      const requested = error.requestedTokens;
      return notice(
        'This conversation is too long for the model',
        error.diagnosis,
        false,
        limit !== null && requested !== null
          ? `It needs about ${String(requested)} tokens and the window is ${String(limit)}. Start a new conversation, or shorten the earlier turns.`
          : 'Start a new conversation, or shorten the earlier turns.',
      );
    }
    case 'authFailed':
      return notice(
        'The endpoint rejected the credential',
        error.diagnosis,
        false,
        'Check the credential for this model in settings.',
      );
    case 'rateLimited':
      return notice(
        'The endpoint is rate limiting Vela',
        error.diagnosis,
        true,
        error.retryAfterMs === null
          ? ''
          : `Try again in about ${String(Math.ceil(error.retryAfterMs / 1000))} seconds.`,
      );
    case 'modelNotFound':
      return notice(
        'That model is not served here',
        error.diagnosis,
        false,
        `Vela asked for \`${error.modelId}\`.`,
      );
    case 'capabilityUnsupported':
      return notice('This model cannot do that', error.diagnosis, false);
    case 'transport':
      return notice(
        transportTitle(error.failure),
        error.diagnosis,
        // A refused connection or a stalled read may work on a second attempt;
        // a 4xx is a statement about this request and will not.
        isTransientTransport(error.failure),
      );
    case 'malformedResponse':
      return notice('Vela could not read the reply', error.diagnosis, true);
    case 'cancelled':
      // The one variant with no diagnosis: nothing failed.
      return {
        title: 'Stopped',
        detail: 'You stopped this reply.',
        retryable: true,
        endpoint: null,
        correlation: null,
      };
  }
}

function transportTitle(failure: TransportFailure): string {
  if (failure === 'connect') return 'Could not reach the endpoint';
  if (failure === 'timeout') return 'The endpoint took too long';
  if (failure === 'stalled') return 'The reply stopped arriving';
  if (failure === 'reset') return 'The connection dropped mid-reply';
  if ('server' in failure) return `The endpoint failed (${String(failure.server.status)})`;
  return `The endpoint refused the request (${String(failure.request.status)})`;
}

function isTransientTransport(failure: TransportFailure): boolean {
  if (typeof failure === 'string') return true;
  return 'server' in failure;
}

/**
 * Human wording for why a tool call was not run.
 *
 * Typed against the contract's own union rather than an inline copy, so a new
 * reason on the host side fails this switch at compile time instead of
 * rendering as a blank line where a refusal should be.
 */
export function describeMalformedReason(reason: MalformedToolCallReason): string {
  switch (reason) {
    case 'missingName':
      return 'no tool name ever arrived';
    case 'unparseableArguments':
      return 'the arguments were not valid JSON';
    case 'argumentsNotAnObject':
      return 'the arguments parsed, but not into an object';
    case 'unknownDiscriminator':
      return 'the call was tagged as something other than a function';
    case 'recoveredFromUnterminatedReasoning':
      // Not malformed at all: well-formed, and refused because the model was
      // still thinking about it when the stream ended.
      return 'it was found inside a thinking block the model never closed, so the model never committed to it';
  }
}
