/**
 * Wording for the three things a user must be able to read: what the endpoint
 * had to give up, what an **agent run** had to give up, and what went wrong.
 *
 * Pure functions over the contract's enums, so the wording is unit-tested and
 * the components stay dumb. All three mappings are **total** — a new variant on
 * any of the unions fails the type check here rather than rendering as a blank.
 *
 * "The host reports" is what the first sentence used to say, and the second
 * mapping is why it changed: `describeRunDegradation` words `RunDegradation`,
 * which is **Vela's own** runtime reporting on itself, not the host reporting on
 * a backend. The distinction matters at the one place the sentences meet a
 * screen — `TurnNotices.tsx` draws the two lists separately, because the unions
 * are separate and merging them would break the parity test that holds
 * `Degradation` against its Rust twin.
 *
 * "so the wording is unit-tested" was briefly false, and that is worth leaving
 * written down: `describeRunDegradation` shipped in the same change as the first
 * component that could render it, and four of its five arms had no assertion
 * anywhere. `notices.test.ts` now enumerates that union too, in
 * `ALL_RUN_DEGRADATIONS`.
 *
 * "There is no provider name in any string, and there is nowhere to put one:
 * these functions receive enums, not ids." That was true of the two mappings
 * above and is no longer true of the file, and the difference is the point.
 * `describeSubstitution` receives **ids**, because the fact it reports is which
 * endpoint answered — and that fact could not be stated by anything that only
 * ever saw enums, which is exactly why a turn answered by a substitute endpoint
 * went undisclosed. Naming an endpoint the user configured is not the thing
 * §0.3 forbids; branching on one is, and nothing here does.
 */

import type {
  AnswerProvenance,
  ChatError,
  Degradation,
  Diagnosis,
  FilterKind,
  KnownCause,
  MalformedToolCallReason,
  TransportFailure,
} from '@/platform/contract';
import type { RunDegradation } from '@/platform/contract-harness';

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
        // Says only what it knows: how many attempts. Whether one of those
        // attempts went to a *different* endpoint is not in this variant and
        // never was — see {@link describeSubstitution}, which is what actually
        // discloses that, and the note on `AnswerProvenance` for why the two
        // are separate.
        detail: `This answer took ${String(degradation.attempts)} attempt${degradation.attempts === 1 ? '' : 's'}.`,
      };
  }
}

/**
 * How a turn's answer relates to the endpoint it was addressed to — **already
 * decided**, never decided here.
 *
 * The decision is a comparison of two provider ids, and by
 * `no-provider-leak.test.ts` exactly one file in this feature is allowed to
 * inspect one: `use-conversation.ts`, which is where the user's selection
 * already lives. So {@link attributionOf} does the comparing there and this
 * union is what comes out — the same shape as every other mapping in this file,
 * a closed set of cases the wording is total over.
 *
 * That split is not a workaround for the guard, it is the guard's own
 * arrangement: this module receives facts and writes sentences. Deciding
 * "different endpoint or not" from raw ids here would have been a second place
 * in the feature that reads a backend id, which is the thing §0.3 is about even
 * when the comparison is against a variable rather than a literal.
 */
export type AnswerAttribution =
  /** The host did not say who answered. Nothing may be shown. */
  | { readonly kind: 'unattributed' }
  /** The endpoint that answered is the one the turn was addressed to. */
  | { readonly kind: 'asAddressed' }
  /** A different endpoint answered than the one addressed. */
  | {
      readonly kind: 'substituted';
      /** The endpoint the user chose, as they configured it. */
      readonly addressed: string;
      readonly answered: AnswerProvenance;
    }
  /** Attributed, but there was no selection to compare it against. */
  | { readonly kind: 'attributedOnly'; readonly answered: AnswerProvenance };

/**
 * **"You asked X. Y answered."**
 *
 * The disclosure the transcript was missing. A turn addressed to one endpoint
 * can be answered by another — the host tries the endpoint the user chose, then
 * every other usable one behind it — and until this existed nothing on screen
 * said so. `failedOver` reported an attempt *count*, which is compatible with
 * having stayed put, so a user running a local model for privacy could read
 * "this answer took 2 attempts" while a hosted endpoint had answered.
 *
 * `null` for the two cases with nothing honest to say:
 *
 *  - `unattributed` — the host did not attribute this turn. **Not** an
 *    invitation to assume the selection; saying nothing is the only truthful
 *    option, and it is what a transcript row written before provenance existed
 *    will always be.
 *  - `asAddressed` — announcing the ordinary case on every turn would bury the
 *    turns where it is not true, and a disclosure nobody reads is not one.
 *
 * Total, like its neighbours: a new case fails the type check here rather than
 * rendering as a blank where a disclosure belongs.
 *
 * Ids are interpolated, never matched. Adding a provider changes nothing here.
 */
export function describeAttribution(attribution: AnswerAttribution): Notice | null {
  switch (attribution.kind) {
    case 'unattributed':
    case 'asAddressed':
      return null;
    case 'attributedOnly':
      return {
        tone: 'info',
        title: 'Answered by',
        detail: `${attribution.answered.providerId} answered this, using ${attribution.answered.modelId}.`,
      };
    case 'substituted':
      return {
        // `warning`, by the tone rule this file already states: tone is about
        // consequence. An answer from an endpoint the user did not choose may
        // have sent their prompt somewhere they were deliberately keeping it
        // away from, and that outranks how routine a failover is.
        tone: 'warning',
        title: 'A different endpoint answered',
        detail: `This turn was sent to ${attribution.addressed}, which did not answer. ${attribution.answered.providerId} answered instead, using ${attribution.answered.modelId}.`,
      };
  }
}

/**
 * What an **agent run** had to give up, as opposed to what the endpoint did.
 *
 * A second function rather than a second arm on {@link describeDegradation},
 * because `RunDegradation` is a separate union from `Degradation` and the
 * contract is explicit about why: the latter mirrors a Rust enum, and merging
 * them would break the parity test that keeps the two honest. They are rendered
 * side by side and never merged.
 *
 * Total, like its neighbour: a new variant fails the type check here rather than
 * rendering as a blank.
 *
 * `contextUnavailable` is the one this file was extended for, and it is a
 * `warning` for the reason the tone rule gives — tone is about consequence. A
 * reply written without the instructions the user typed into their project is a
 * reply that looks right and is not the one they asked for, and until this
 * existed the run reported that fact to nobody: `use-conversation.ts` dropped
 * every `degraded` event on the floor.
 */
export function describeRunDegradation(degradation: RunDegradation): Notice {
  switch (degradation.kind) {
    case 'auxiliaryModelUnavailable':
      return {
        tone: 'info',
        title: 'One model did all of it',
        detail:
          'No second model was assigned for Vela’s own internal steps, so the model answering you ran those too.',
      };
    case 'stepLimitReached':
      return {
        tone: 'warning',
        title: 'The run stopped at its step limit',
        detail: `This run was allowed ${String(degradation.steps)} step${degradation.steps === 1 ? '' : 's'} and used all of them, so it stopped where it was rather than finishing.`,
      };
    case 'toolCallLimitReached':
      return {
        tone: 'warning',
        title: 'The run stopped at its tool-call limit',
        detail: `This run was allowed ${String(degradation.calls)} tool call${degradation.calls === 1 ? '' : 's'} and used all of them, so it stopped where it was rather than finishing.`,
      };
    case 'wallClockLimitReached':
      return {
        tone: 'warning',
        title: 'The run ran out of time',
        detail: `This run passed its ${String(Math.round(degradation.elapsedMs / 1000))}-second budget and stopped where it was rather than finishing.`,
      };
    case 'contextUnavailable':
      return {
        tone: 'warning',
        // `ContextRef.title` is documented as the user's own text — the name of
        // their file, or a fixed label for material that has no name of its own.
        // Quoting it is how a user tells which of several sources went missing.
        title: 'Something this run was given could not be read',
        detail: `Vela could not read “${degradation.ref.title}”, so this reply was written without it.`,
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
