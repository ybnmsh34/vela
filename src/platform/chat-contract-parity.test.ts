/**
 * The guard `contract.ts` has claimed since the chat types were written.
 *
 * The chat block of `src/platform/contract.ts` is transcribed from `serde`
 * shapes in `src-tauri/crates/vela-providers/src/`. Nothing checked that. The
 * doc comment above that block named *this file* and this file did not exist,
 * which is worse than no guard at all: a comment asserting an enforcement is
 * load-bearing documentation, and every later builder read it and believed the
 * two sides could not drift.
 *
 * ## How the two directions are caught
 *
 * A **Rust** variant or field added without its TypeScript twin fails here, at
 * `pnpm test`: this file reads the Rust sources off disk, applies the enum's
 * own `#[serde(rename_all = …)]`, and compares the resulting wire names against
 * the lists below.
 *
 * A **TypeScript** variant or field added without its Rust twin fails at
 * `pnpm typecheck`: every list below is passed through {@link everyVariantOf},
 * which is only assignable when the list covers its union exactly. Add a member
 * to `ContentPart` and the `CONTENT_PART` list stops compiling; add it to the
 * list and this file's Rust comparison goes red. There is no order in which a
 * one-sided change is green.
 *
 * Both halves are in `pnpm verify` and in CI (`verify-covers-ci.test.ts` keeps
 * that true).
 *
 * ## The third half: the list itself
 *
 * Both claims above are of the form *for each pairing this file lists*, and for
 * a long time nothing said how many pairings there were. Deleting an entry from
 * the array deleted its runtime assertion and its compile-time one together —
 * `everyVariantOf` can only close a union for a list that still exists — and
 * the whole visible trace was the vitest count moving by one, which no
 * assertion read. So the pairing list is no longer the inventory: the Rust
 * files are. `accounts for every serialisable type in the files it reads`
 * scans them for everything deriving `Serialize` and requires each to be
 * paired or on {@link NOT_ON_THIS_BOUNDARY} with a reason. A deleted pairing
 * and a type nobody remembered to list fail the same assertion, and its diff
 * names them.
 *
 * ## What this compares, and what it refuses to
 *
 * Wire keys, as far as they can be read out of source text: member names after
 * the container's `rename_all`, the internal tag key, and the fields inside
 * struct-bodied variants after `rename_all_fields`. Where an attribute severs
 * the identifier from the key — a per-field `rename`, a `flatten` — the parser
 * **throws** rather than compare an identifier it knows is not the key, and it
 * throws for **any** attribute whose effect on the wire it has not written
 * down, including one reached through a `cfg_attr` wrapper or written above the
 * derive. Refusing is the posture: a guard that reports agreement it never
 * checked is worse than an absent one, because the absent one does not get
 * believed.
 *
 * The payload fields of struct variants used to be outside this comparison, and
 * that sentence sat in this header describing it as a stated limitation. It was
 * a hole, not a limitation: `rename_all_fields` is a second rename rule under a
 * second attribute name, and flipping it changed every payload key on the wire
 * with every assertion here still green. {@link Pairing.payload} closes it — and
 * closes it **arm by arm**, which is the second half of the same lesson. The
 * first version of that field was one flat list of every key of every arm, and
 * a probe put `#[serde(skip)]` on `ContentPart::Reasoning`'s `text`: `Text`
 * declares `text` too, so the pooled union did not move, and
 * `src/features/conversation/stored-entries.ts` went on building
 * `{ kind: 'reasoning', text: … }` out of a key that had stopped crossing. A
 * perfectly read attribute fed into a comparison that discarded the reading.
 *
 * One surface remains outside, stated rather than implied: nothing in
 * TypeScript observes actual bytes. Only the Rust side does, in `model.rs`'s
 * `provenance_crosses_the_bridge_under_the_keys_the_renderer_reads`, which
 * serialises a `ChatResponse` and therefore speaks for `answeredBy` and
 * `AnswerProvenance` and for nothing else.
 *
 * ## What this does not claim
 *
 * Name parity, not semantic parity: that `ContentPart` has an `image` arm on
 * both sides, not that both encode the bytes the same way. Where the shapes
 * deliberately differ — `ContentPartInput.image.data` is base64 where the
 * provider model is a byte array, `CapabilityFinding` drops the adapter's
 * free-text `note` — the difference lives in `src-tauri/src/ipc/`, and those
 * types are not listed here.
 *
 * That used to end *"which is a different boundary with its own tests"*, and a
 * probe measured the sentence rather than believing it. For the two conversions
 * this header names, it holds: `src-tauri/src/ipc/content.rs` asserts
 * `json["kind"] == "image"`, `json["mimeType"]`, `json["kind"] == "toolResult"`,
 * `json["callId"]` and `json["isError"]` on serialised bytes, and
 * `src-tauri/src/ipc/models.rs` asserts `json["contextWindowTokens"]`,
 * `json["capabilities"]["toolCalls"]` and `json["findings"][1]["capability"]`.
 * For `src-tauri/src/ipc/skills.rs` it did **not** hold — that file contains no
 * `serde_json` at all and nothing anywhere pinned its tag key, so the sentence
 * was covering a gap it had not checked. That file is now read by
 * `src/platform/skill-store-parity.test.ts`, which pairs `SkillsListRes` and
 * `SkillsReadRes` against `contract.ts`. The lesson is narrower than the fix: a
 * header saying another boundary is covered is prose, and prose is not the
 * cover.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type {
  AnswerProvenance,
  CapabilityEvidence,
  CapabilityName,
  CapabilitySupport,
  ChatError,
  ChatResponseBody,
  ChatStreamEvent,
  ContentPart,
  ContextStrategy,
  Degradation,
  Diagnosis,
  EndpointIdentity,
  FilterKind,
  FilterStage,
  FilterVerdict,
  KnownCause,
  MalformedToolCallReason,
  MessageRole,
  SchemaMismatch,
  StopReason,
  TokenUsage,
  ToolCallDelta,
  ToolCallOutcome,
  ToolChoiceInput,
  TransportFailure,
} from './contract';
import {
  parseRustItem,
  payloadRecord,
  payloadWireKeys,
  qualified,
  RENAME_RULES,
  rustPathsNamedIn,
  scanSerialisable,
  wireName,
  wireNames,
} from './serde-wire';
import type { RenameRule, RustItem, SerialisableItem } from './serde-wire';

/* -------------------------------------------------------------------------- */
/* the TypeScript half — closed by the compiler                               */
/* -------------------------------------------------------------------------- */

/**
 * Accepts a list only when it names every member of `U` exactly once.
 *
 * A missing member makes the argument fail the second half of the intersection
 * (the error prints the missing name); an extra one fails `readonly U[]`. This
 * is what makes a TypeScript-only addition a build failure rather than a
 * silently narrower comparison.
 */
function everyVariantOf<U extends string>() {
  return <L extends readonly U[]>(
    list: L &
      ([Exclude<U, L[number]>] extends [never]
        ? unknown
        : ['this list is missing a variant', Exclude<U, L[number]>]),
  ): readonly string[] => list as readonly string[];
}

/** The discriminant values of a tagged union, as the wire spells them. */
type TagsOf<U, T extends PropertyKey> =
  U extends Record<T, infer V> ? (V extends string ? V : never) : never;

const MESSAGE_ROLE = everyVariantOf<MessageRole>()(['system', 'user', 'assistant', 'tool']);

const STOP_REASON = everyVariantOf<StopReason>()([
  'endTurn',
  'maxTokens',
  'cancelled',
  'toolUse',
  'unspecified',
]);

/**
 * The keys the discriminants ride on, declared once and read twice: by
 * `TagsOf` just below, where the compiler checks the TypeScript union really
 * carries that key, and by the matching {@link Pairing}, where the assertion
 * checks serde's `tag = …` spells it the same. Before both readers existed the
 * tag key was in no comparison at all — it is not a member of anything, so
 * `tag = "kind"` could become `tag = "type"` and every arm of the union become
 * unroutable with the suite still green.
 */
const CONTENT_PART_TAG = 'kind';
const TOOL_CALL_OUTCOME_TAG = 'status';
const DEGRADATION_TAG = 'kind';
const TOOL_CHOICE_TAG = 'type';
const STREAM_EVENT_TAG = 'type';
const PROVIDER_ERROR_TAG = 'kind';

const CONTENT_PART = everyVariantOf<TagsOf<ContentPart, typeof CONTENT_PART_TAG>>()([
  'text',
  'reasoning',
  'image',
  'toolCall',
  'toolResult',
]);

const MALFORMED_TOOL_CALL = everyVariantOf<MalformedToolCallReason>()([
  'missingName',
  'unparseableArguments',
  'argumentsNotAnObject',
  'unknownDiscriminator',
  'recoveredFromUnterminatedReasoning',
]);

const TOOL_CALL_OUTCOME = everyVariantOf<TagsOf<ToolCallOutcome, typeof TOOL_CALL_OUTCOME_TAG>>()([
  'ok',
  'malformed',
]);

const DEGRADATION = everyVariantOf<TagsOf<Degradation, typeof DEGRADATION_TAG>>()([
  'toolCallingEmulated',
  'toolCatalogueWithheld',
  'contextReduced',
  'structuredOutputUnsupported',
  'structuredOutputMismatch',
  'malformedFramesSkipped',
  'unterminatedReasoning',
  'noTerminationSentinel',
  'usageNotReported',
  'malformedToolCalls',
  'failedOver',
]);

const CONTEXT_STRATEGY = everyVariantOf<ContextStrategy>()(['elideOldest', 'summarise']);

const TOOL_CHOICE = everyVariantOf<TagsOf<ToolChoiceInput, typeof TOOL_CHOICE_TAG>>()([
  'auto',
  'none',
  'required',
  'named',
]);

const STREAM_EVENT = everyVariantOf<TagsOf<ChatStreamEvent, typeof STREAM_EVENT_TAG>>()([
  'textDelta',
  'reasoningDelta',
  'toolCallDelta',
  'usage',
  'done',
  'error',
]);

const CAPABILITY = everyVariantOf<CapabilityName>()([
  'streaming',
  'vision',
  'toolCalling',
  'structuredOutput',
  'reasoning',
  'modelListing',
  'usageReporting',
  'promptCaching',
]);

/**
 * `TransportFailure` is externally tagged, so its unit arms are bare strings and
 * its payload arms are single-key objects. Both spellings are one Rust variant,
 * so both are collected here.
 */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;

type TransportFailureVariant =
  | Extract<TransportFailure, string>
  | (KeysOfUnion<Exclude<TransportFailure, string>> & string);

const TRANSPORT_FAILURE = everyVariantOf<TransportFailureVariant>()([
  'connect',
  'timeout',
  'stalled',
  'reset',
  'server',
  'request',
]);

const PROVIDER_ERROR = everyVariantOf<TagsOf<ChatError, typeof PROVIDER_ERROR_TAG>>()([
  'contextLengthExceeded',
  'authFailed',
  'rateLimited',
  'modelNotFound',
  'capabilityUnsupported',
  'transport',
  'malformedResponse',
  'cancelled',
]);

const SUPPORT = everyVariantOf<CapabilitySupport>()([
  'unknown',
  'unsupported',
  'supported',
  'degraded',
]);

const EVIDENCE = everyVariantOf<CapabilityEvidence>()(['probed', 'declared', 'cached', 'unprobed']);

/**
 * `Cause` is `#[non_exhaustive]` in Rust and open in TypeScript
 * (`Cause = KnownCause | (string & {})`) so a newer host can still be rendered.
 * `KnownCause` is nonetheless closed against the Rust enum: openness exists so
 * an unknown cause gets a fallback sentence, not so this list may lag.
 */
const CAUSE = everyVariantOf<KnownCause>()([
  'credential_rejected',
  'credential_missing',
  'credential_store_unreadable',
  'credential_store_failed',
  'model_not_served',
  'model_list_malformed',
  'context_window_exceeded',
  'pinned_turns_exceed_window',
  'request_too_large',
  'too_many_requests',
  'endpoint_overloaded',
  'endpoint_failed_to_answer',
  'endpoint_rejected_request',
  'endpoint_timed_out',
  'endpoint_cancelled_request',
  'endpoint_reported_an_error',
  'content_filter_refused_the_turn',
  'capability_refused_by_endpoint',
  'capability_absent_on_this_model',
  'capability_not_offered_by_backend',
  'connection_failed',
  'request_timed_out',
  'stream_stalled',
  'connection_reset',
  'redirect_refused_cross_authority',
  'redirect_loop',
  'no_endpoint_answered',
  'response_was_not_json',
  'response_shape_unrecognised',
  'stream_ended_without_answer',
  'request_could_not_be_encoded',
  'no_provider_configured',
  'no_candidate_answered',
  'caller_cancelled',
  'synthetic_test_failure',
]);

const FILTER_STAGE = everyVariantOf<FilterStage>()(['prompt', 'answer']);

const FILTER_KIND = everyVariantOf<FilterKind>()([
  'safety',
  'prohibited_content',
  'blocklist',
  'personal_information',
  'recitation',
  'image_safety',
  'unsupported_language',
  'other',
]);

/* -- struct fields ------------------------------------------------------- */

const TOKEN_USAGE_FIELDS = everyVariantOf<keyof TokenUsage & string>()([
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cachedInputTokens',
]);

const CHAT_RESPONSE_FIELDS = everyVariantOf<keyof ChatResponseBody & string>()([
  'parts',
  'toolCalls',
  'stopReason',
  'usage',
  'structured',
  'degradations',
  'answeredBy',
]);

const ANSWER_PROVENANCE_FIELDS = everyVariantOf<keyof AnswerProvenance & string>()([
  'providerId',
  'modelId',
]);

const SCHEMA_MISMATCH_FIELDS = everyVariantOf<keyof SchemaMismatch & string>()(['path', 'detail']);

const TOOL_CALL_DELTA_FIELDS = everyVariantOf<keyof ToolCallDelta & string>()([
  'slot',
  'callId',
  'name',
  'argumentsFragment',
]);

const ENDPOINT_IDENTITY_FIELDS = everyVariantOf<keyof EndpointIdentity & string>()([
  'authority',
  'path',
]);

const DIAGNOSIS_FIELDS = everyVariantOf<keyof Diagnosis & string>()([
  'cause',
  'status',
  'endpoint',
  'filter',
  'correlation',
]);

const FILTER_VERDICT_FIELDS = everyVariantOf<keyof FilterVerdict & string>()([
  'stage',
  'kind',
  'categories',
  'generatedChars',
]);

/* -- the fields inside struct-bodied variants ---------------------------- */

/**
 * **Keys that are members of nothing, and were therefore in no comparison.**
 *
 * `ContentPart::Image { mime_type, data }` puts `mimeType` and `data` on the
 * wire. Neither is a variant of `ContentPart` and neither is a field of a
 * struct this file pairs, so every assertion above walks past them — the same
 * shape of blindness the discriminant key had before {@link Pairing.tag}
 * existed, and the same consequence: `src/runtime/content-part-codec.ts`'s
 * `toInput` reads `part.mimeType` off an image part on its way into the next
 * request, and nothing here could tell it had stopped arriving.
 *
 * That is not hypothetical. Serde renames these under `rename_all_fields`,
 * which is a *different* attribute from the `rename_all` that renames the
 * variants, and six of the enums below carry it. Flipping one of those from
 * `camelCase` to `PascalCase` is a one-token edit to an attribute already
 * spelled fourteen times in this repository's Rust; it changes no identifier and
 * no variant name, and before these lists existed every assertion in this file
 * stayed green while `mimeType`, `callId` and `isError` crossed as `MimeType`,
 * `CallId` and `IsError`.
 *
 * Each list is closed by the compiler against the TypeScript union — every key
 * of every arm, minus the tag — and compared against what the crate really
 * spells, so a field added on one side alone fails one of the two.
 */
/** The keys of one arm of an internally tagged union, without the tag itself. */
type ArmFieldsOf<U, T extends PropertyKey, V> = Exclude<
  keyof Extract<U, Record<T, V>> & string,
  T
>;

/**
 * Accepts a record only when it names every arm of `U` and, for each, every
 * field of that arm exactly once.
 *
 * A flat list of *every key of every arm* is not a weaker version of this; it
 * is a different question, and a probe walked through the difference.
 * `ContentPart::Text` and `::Reasoning` both declare `text`, so `#[serde(skip)]`
 * on `Reasoning`'s left the pooled union unchanged — the parser read the
 * attribute perfectly, the field really did leave the read, and the comparison
 * could not see it because the comparison was over a union.
 * `src/features/conversation/stored-entries.ts` goes on building
 * `{ kind: 'reasoning', text: … }` out of a key that has stopped crossing.
 * Keyed by arm, the diff names the arm that lost it.
 *
 * Same device as {@link everyVariantOf}, restated for the same reason: a
 * type-level check with an identity function under it is the same check in
 * every copy of it.
 */
function everyFieldOfEveryArm<U, T extends PropertyKey>() {
  return <R extends { readonly [V in TagsOf<U, T> & string]: readonly ArmFieldsOf<U, T, V>[] }>(
    record: R & {
      readonly [V in TagsOf<U, T> & string]: [
        Exclude<ArmFieldsOf<U, T, V>, R[V & keyof R][number]>,
      ] extends [never]
        ? unknown
        : ['this arm is missing a field', Exclude<ArmFieldsOf<U, T, V>, R[V & keyof R][number]>];
    },
  ): Readonly<Record<string, readonly string[]>> =>
    // Every arm must be *written*, so a new one cannot be forgotten; only the
    // ones that carry fields are *compared*, because a unit arm puts no key on
    // the wire and the Rust side has no entry for it.
    payloadRecord(record as Record<string, readonly string[]>);
}

const CONTENT_PART_PAYLOAD = everyFieldOfEveryArm<ContentPart, typeof CONTENT_PART_TAG>()({
  text: ['text'],
  reasoning: ['text', 'signature', 'redacted'],
  image: ['mimeType', 'data'],
  toolCall: ['callId', 'name', 'arguments'],
  toolResult: ['callId', 'content', 'isError'],
});

const TOOL_CALL_OUTCOME_PAYLOAD = everyFieldOfEveryArm<
  ToolCallOutcome,
  typeof TOOL_CALL_OUTCOME_TAG
>()({
  ok: ['callId', 'name', 'arguments', 'emulated'],
  malformed: ['index', 'callId', 'name', 'rawArguments', 'reason'],
});

const DEGRADATION_PAYLOAD = everyFieldOfEveryArm<Degradation, typeof DEGRADATION_TAG>()({
  toolCallingEmulated: ['toolCount'],
  toolCatalogueWithheld: [],
  contextReduced: ['droppedMessages', 'approxDroppedTokens', 'strategy'],
  structuredOutputUnsupported: [],
  structuredOutputMismatch: ['detail'],
  malformedFramesSkipped: ['count'],
  unterminatedReasoning: ['recoveredAnswerChars'],
  noTerminationSentinel: [],
  usageNotReported: [],
  malformedToolCalls: ['count'],
  failedOver: ['attempts'],
});

const TOOL_CHOICE_PAYLOAD = everyFieldOfEveryArm<ToolChoiceInput, typeof TOOL_CHOICE_TAG>()({
  auto: [],
  none: [],
  required: [],
  named: ['name'],
});

const STREAM_EVENT_PAYLOAD = everyFieldOfEveryArm<ChatStreamEvent, typeof STREAM_EVENT_TAG>()({
  textDelta: ['text'],
  reasoningDelta: ['text'],
  toolCallDelta: ['delta'],
  usage: ['usage'],
  done: ['response'],
  error: ['error'],
});

const PROVIDER_ERROR_PAYLOAD = everyFieldOfEveryArm<ChatError, typeof PROVIDER_ERROR_TAG>()({
  contextLengthExceeded: ['limitTokens', 'requestedTokens', 'diagnosis'],
  authFailed: ['diagnosis'],
  rateLimited: ['retryAfterMs', 'diagnosis'],
  modelNotFound: ['modelId', 'diagnosis'],
  capabilityUnsupported: ['capability', 'diagnosis'],
  transport: ['failure', 'diagnosis'],
  malformedResponse: ['diagnosis'],
  cancelled: [],
});

/**
 * `TransportFailure` is externally tagged, so there is no tag key to exclude
 * and its struct arms cross as single-key objects with the fields one level
 * *inside* — `{ server: { status } }` — while its unit arms are bare strings.
 * Both shapes differ from every union above, so the arm reader does too.
 */
type ExternalArmOf<U, V extends PropertyKey> = Extract<U, Record<V, unknown>>;
type ExternalArmFieldsOf<U, V extends PropertyKey> = [ExternalArmOf<U, V>] extends [never]
  ? never
  : keyof ExternalArmOf<U, V>[V & keyof ExternalArmOf<U, V>] & string;
type ExternalArmsOf<U> = U extends string ? U : keyof U & string;

function everyFieldOfEveryExternalArm<U>() {
  return <R extends { readonly [V in ExternalArmsOf<U>]: readonly ExternalArmFieldsOf<U, V>[] }>(
    record: R & {
      readonly [V in ExternalArmsOf<U>]: [
        Exclude<ExternalArmFieldsOf<U, V>, R[V & keyof R][number]>,
      ] extends [never]
        ? unknown
        : [
            'this arm is missing a field',
            Exclude<ExternalArmFieldsOf<U, V>, R[V & keyof R][number]>,
          ];
    },
  ): Readonly<Record<string, readonly string[]>> =>
    payloadRecord(record as Record<string, readonly string[]>);
}

const TRANSPORT_FAILURE_PAYLOAD = everyFieldOfEveryExternalArm<TransportFailure>()({
  connect: [],
  timeout: [],
  stalled: [],
  reset: [],
  server: ['status'],
  request: ['status'],
});

/* -------------------------------------------------------------------------- */
/* the Rust half — read off disk                                              */
/* -------------------------------------------------------------------------- */

const CRATE = join(process.cwd(), 'src-tauri', 'crates', 'vela-providers', 'src');

/**
 * The five files of the crate this boundary is about, named once.
 *
 * A literal, and deliberately so: the renderer's chat vocabulary lives in these
 * five, and the rest of `vela-providers/src` is adapter machinery that speaks
 * to endpoints rather than to this contract. `covers every Rust file the
 * contract says it reads` pins the list against the sentence in `contract.ts`
 * that names them, so the two cannot drift apart in silence, and the inventory
 * equality below is scoped to these files in its own name.
 */
const FILES: readonly string[] = [
  'capability.rs',
  'diagnostic.rs',
  'error.rs',
  'event.rs',
  'model.rs',
];

const SOURCES: Readonly<Record<string, string>> = Object.fromEntries(
  FILES.map((file) => [file, readFileSync(join(CRATE, file), 'utf8')]),
);

/**
 * Reads one `pub enum` / `pub struct` body.
 *
 * Line-oriented rather than a token parser, which is sound here and nowhere
 * else: `cargo fmt --check` runs in `pnpm verify`, so every item is rustfmt's
 * shape — one member per line, the closing brace in column 0. `readRustItem`
 * throws when it cannot find the item, and {@link expectMembers} rejects an
 * empty read, so a formatting change that defeated this parser would fail the
 * suite rather than silently compare nothing against nothing.
 */
function readRustItem(file: string, keyword: 'enum' | 'struct', name: string): RustItem {
  const source = SOURCES[file];
  if (source === undefined) throw new Error(`chat-contract-parity: ${file} is not loaded`);
  return parseRustItem(source, keyword, name, file);
}


/* -------------------------------------------------------------------------- */
/* the comparison                                                             */
/* -------------------------------------------------------------------------- */

interface Pairing {
  readonly rust: string;
  readonly file: string;
  readonly keyword: 'enum' | 'struct';
  readonly ts: string;
  readonly listed: readonly string[];
  /**
   * The key serde puts the discriminant under, or `null` for an item that is
   * not internally tagged.
   *
   * Required, not optional, and that is the enforcement: a new tagged enum
   * added to the list without a decision about its tag does not compile. An
   * optional field would have let the tag go unstated, which is the state this
   * file was in — `tag = "kind"` could become `tag = "type"`, every arm of
   * `ContentPart` become unroutable in the renderer, and all thirty-five
   * assertions stay green, because the tag key is a member of nothing.
   */
  readonly tag: string | null;
  /**
   * The wire keys of the fields inside each struct-bodied variant, keyed by
   * that variant's own wire name — `{}` for an item that has none.
   *
   * Required for the same reason {@link tag} is, and against the same class of
   * failure. These keys are members of nothing, so a comparison over members
   * cannot reach them; an enum that grows a struct-bodied variant, or whose
   * `rename_all_fields` changes, fails here instead of passing silently.
   *
   * Keyed rather than pooled, and that is a probe's doing rather than a
   * preference. `ContentPart::Text` and `::Reasoning` both declare `text`, so
   * `#[serde(skip)]` on `Reasoning`'s left the pooled union of every arm's
   * fields exactly as it was — while `src/features/conversation/stored-entries.ts`
   * went on building `{ kind: 'reasoning', text: … }` out of a key that had
   * stopped crossing.
   */
  readonly payload: Readonly<Record<string, readonly string[]>>;
}

const ENUMS: readonly Pairing[] = [
  {
    rust: 'MessageRole',
    file: 'model.rs',
    keyword: 'enum',
    ts: 'MessageRole',
    payload: {},
    tag: null,
    listed: MESSAGE_ROLE,
  },
  {
    rust: 'StopReason',
    file: 'model.rs',
    keyword: 'enum',
    ts: 'StopReason',
    payload: {},
    tag: null,
    listed: STOP_REASON,
  },
  {
    rust: 'ContentPart',
    file: 'model.rs',
    keyword: 'enum',
    ts: 'ContentPart',
    payload: CONTENT_PART_PAYLOAD,
    tag: CONTENT_PART_TAG,
    listed: CONTENT_PART,
  },
  {
    rust: 'MalformedToolCall',
    file: 'model.rs',
    keyword: 'enum',
    ts: 'MalformedToolCallReason',
    payload: {},
    tag: null,
    listed: MALFORMED_TOOL_CALL,
  },
  {
    rust: 'ToolCallOutcome',
    file: 'model.rs',
    keyword: 'enum',
    ts: 'ToolCallOutcome',
    payload: TOOL_CALL_OUTCOME_PAYLOAD,
    tag: TOOL_CALL_OUTCOME_TAG,
    listed: TOOL_CALL_OUTCOME,
  },
  {
    rust: 'Degradation',
    file: 'model.rs',
    keyword: 'enum',
    ts: 'Degradation',
    payload: DEGRADATION_PAYLOAD,
    tag: DEGRADATION_TAG,
    listed: DEGRADATION,
  },
  {
    rust: 'ContextStrategy',
    file: 'model.rs',
    keyword: 'enum',
    ts: 'ContextStrategy',
    payload: {},
    tag: null,
    listed: CONTEXT_STRATEGY,
  },
  {
    rust: 'ToolChoice',
    file: 'model.rs',
    keyword: 'enum',
    ts: 'ToolChoiceInput',
    payload: TOOL_CHOICE_PAYLOAD,
    tag: TOOL_CHOICE_TAG,
    listed: TOOL_CHOICE,
  },
  {
    rust: 'StreamEvent',
    file: 'event.rs',
    keyword: 'enum',
    ts: 'ChatStreamEvent',
    payload: STREAM_EVENT_PAYLOAD,
    tag: STREAM_EVENT_TAG,
    listed: STREAM_EVENT,
  },
  {
    rust: 'Capability',
    file: 'error.rs',
    keyword: 'enum',
    ts: 'CapabilityName',
    payload: {},
    tag: null,
    listed: CAPABILITY,
  },
  {
    rust: 'TransportFailure',
    file: 'error.rs',
    keyword: 'enum',
    ts: 'TransportFailure',
    payload: TRANSPORT_FAILURE_PAYLOAD,
    tag: null,
    listed: TRANSPORT_FAILURE,
  },
  {
    rust: 'ProviderError',
    file: 'error.rs',
    keyword: 'enum',
    ts: 'ChatError',
    payload: PROVIDER_ERROR_PAYLOAD,
    tag: PROVIDER_ERROR_TAG,
    listed: PROVIDER_ERROR,
  },
  {
    rust: 'Support',
    file: 'capability.rs',
    keyword: 'enum',
    ts: 'CapabilitySupport',
    payload: {},
    tag: null,
    listed: SUPPORT,
  },
  {
    rust: 'Evidence',
    file: 'capability.rs',
    keyword: 'enum',
    ts: 'CapabilityEvidence',
    payload: {},
    tag: null,
    listed: EVIDENCE,
  },
  {
    rust: 'Cause',
    file: 'diagnostic.rs',
    keyword: 'enum',
    ts: 'KnownCause',
    payload: {},
    tag: null,
    listed: CAUSE,
  },
  {
    rust: 'FilterStage',
    file: 'diagnostic.rs',
    keyword: 'enum',
    ts: 'FilterStage',
    payload: {},
    tag: null,
    listed: FILTER_STAGE,
  },
  {
    rust: 'FilterKind',
    file: 'diagnostic.rs',
    keyword: 'enum',
    ts: 'FilterKind',
    payload: {},
    tag: null,
    listed: FILTER_KIND,
  },
];

const STRUCTS: readonly Pairing[] = [
  {
    rust: 'TokenUsage',
    file: 'model.rs',
    keyword: 'struct',
    ts: 'TokenUsage',
    payload: {},
    tag: null,
    listed: TOKEN_USAGE_FIELDS,
  },
  {
    rust: 'ChatResponse',
    file: 'model.rs',
    keyword: 'struct',
    ts: 'ChatResponseBody',
    payload: {},
    tag: null,
    listed: CHAT_RESPONSE_FIELDS,
  },
  {
    rust: 'AnswerProvenance',
    file: 'model.rs',
    keyword: 'struct',
    ts: 'AnswerProvenance',
    payload: {},
    tag: null,
    listed: ANSWER_PROVENANCE_FIELDS,
  },
  {
    rust: 'SchemaMismatch',
    file: 'model.rs',
    keyword: 'struct',
    ts: 'SchemaMismatch',
    payload: {},
    tag: null,
    listed: SCHEMA_MISMATCH_FIELDS,
  },
  {
    rust: 'ToolCallDelta',
    file: 'event.rs',
    keyword: 'struct',
    ts: 'ToolCallDelta',
    payload: {},
    tag: null,
    listed: TOOL_CALL_DELTA_FIELDS,
  },
  {
    rust: 'EndpointIdentity',
    file: 'diagnostic.rs',
    keyword: 'struct',
    ts: 'EndpointIdentity',
    payload: {},
    tag: null,
    listed: ENDPOINT_IDENTITY_FIELDS,
  },
  {
    rust: 'Diagnosis',
    file: 'diagnostic.rs',
    keyword: 'struct',
    ts: 'Diagnosis',
    payload: {},
    tag: null,
    listed: DIAGNOSIS_FIELDS,
  },
  {
    rust: 'FilterVerdict',
    file: 'diagnostic.rs',
    keyword: 'struct',
    ts: 'FilterVerdict',
    payload: {},
    tag: null,
    listed: FILTER_VERDICT_FIELDS,
  },
];

/* -------------------------------------------------------------------------- */
/* the inventory — what the pairings above are measured against               */
/* -------------------------------------------------------------------------- */

/**
 * Every braced `pub enum` / `pub struct` in one file that derives `Serialize`
 * — that is, everything in it that can put keys on the wire.
 *
 * Tuple and unit structs are out of scope on purpose: they have no member
 * names for `parseRustItem` to read, so they cannot be paired by this file at
 * all. `#[serde(transparent)]` newtypes such as `CorrelationId(u64)` and
 * `HarmCategories(u8)` are all of that shape here.
 */
function serialisableItems(file: string): readonly SerialisableItem[] {
  const source = SOURCES[file];
  if (source === undefined) throw new Error(`chat-contract-parity: ${file} is not loaded`);
  return scanSerialisable(source, file);
}

/**
 * The serialisable types in those five files that this boundary deliberately
 * does not pair, each with the reason.
 *
 * A register, not a suppression list. Its purpose is to make the count of
 * *unaccounted* types exactly zero, so that the assertion below can be an
 * equality rather than a threshold.
 */
interface Registered extends SerialisableItem {
  readonly because: string;
  /**
   * The type this one's contract is discharged by, qualified as
   * `file.rs::Type`, or `null` when nothing here takes it over.
   *
   * **Not one entry below can fill this in, and that is the honest answer**
   * rather than a decorative one. Every entry here is discharged by a type in
   * `src-tauri/src/ipc/`, which this guard does not read — so `null`, and the
   * reasons stay what they are: statements about the direction these types
   * travel, not hand-offs this file can prove. The field exists because the
   * sibling guard's register wrote a hand-off in prose, pointed it at a Rust
   * file no inventory read, and a probe changed the tag key at the far end with
   * the whole suite green. `every hand-off on the register lands on a type this
   * guard pairs` is what makes the difference between a hand-off and a
   * statement checkable instead of a matter of reading.
   */
  readonly handedTo: string | null;
}

const NOT_ON_THIS_BOUNDARY: readonly Registered[] = [
  // The request direction. The renderer never sends these shapes; it sends the
  // DTOs in `src-tauri/src/ipc/`, which convert. The header of this file says
  // so, and this is that sentence made checkable.
  {
    file: 'model.rs',
    keyword: 'struct',
    rust: 'ChatRequest',
    handedTo: null,
    because: 'request DTO boundary',
  },
  {
    file: 'model.rs',
    keyword: 'struct',
    rust: 'ChatMessage',
    handedTo: null,
    because: 'request DTO boundary',
  },
  {
    file: 'model.rs',
    keyword: 'struct',
    rust: 'ToolDefinition',
    handedTo: null,
    because: 'request DTO boundary',
  },
  {
    file: 'model.rs',
    keyword: 'enum',
    rust: 'ResponseFormat',
    handedTo: null,
    because: 'request DTO boundary',
  },
  {
    file: 'model.rs',
    keyword: 'enum',
    rust: 'ReasoningRequest',
    handedTo: null,
    because: 'request DTO boundary',
  },
  {
    file: 'model.rs',
    keyword: 'struct',
    rust: 'CacheHints',
    handedTo: null,
    because: 'request DTO boundary',
  },
  {
    file: 'model.rs',
    keyword: 'struct',
    rust: 'Sampling',
    handedTo: null,
    because: 'request DTO boundary',
  },
  // Capability reporting crosses as an ipc DTO that drops the adapter's
  // free-text `note`; the header names that difference too.
  {
    file: 'capability.rs',
    keyword: 'struct',
    rust: 'CapabilityFinding',
    handedTo: null,
    because: 'capability DTO boundary',
  },
  {
    file: 'capability.rs',
    keyword: 'struct',
    rust: 'ModelCapabilities',
    handedTo: null,
    because: 'capability DTO boundary',
  },
  // Never reaches the renderer by name. `FilterVerdict::categories` is
  // `HarmCategories`, a `#[serde(transparent)]` bitset over `u8`, and the
  // TypeScript mirror types `categories` as `number`. The variant spellings
  // are not on the wire at all.
  {
    file: 'diagnostic.rs',
    keyword: 'enum',
    rust: 'HarmCategory',
    handedTo: null,
    because: 'crosses as a bitset, not as names',
  },
];

/** Sets, not sequences: declaration order is not part of the wire contract. */
function expectMembers(pairing: Pairing): void {
  const item = readRustItem(pairing.file, pairing.keyword, pairing.rust);
  const rust = wireNames(item);
  expect([...rust].sort(), `${pairing.file}::${pairing.rust} vs ${pairing.ts}`).toEqual(
    [...pairing.listed].sort(),
  );
  // The discriminant key. Not a member of anything, so it needs its own
  // comparison or it has none: the TypeScript side is closed by `TagsOf<…,
  // typeof X_TAG>`, which stops compiling if the union does not carry that
  // key, and this is the other half.
  expect(item.tag, `${pairing.file}::${pairing.rust} discriminant key`).toBe(pairing.tag);
  // The fields inside struct-bodied variants, arm by arm. Members of nothing,
  // so the comparison above cannot reach them; serde renames them under
  // `rename_all_fields` — a different attribute from the one that renames the
  // variants, and one that was recorded as tolerated here until a probe flipped
  // it and nothing went red; and pooling them across arms hides a key that
  // leaves one arm while a sibling still declares it, which is the probe after
  // that one.
  expect(
    payloadWireKeys(item),
    `${pairing.file}::${pairing.rust} struct-variant payload keys, by variant`,
  ).toEqual(pairing.payload);
}

describe('chat contract parity with vela-providers', () => {
  for (const pairing of ENUMS) {
    it(`${pairing.ts} carries every ${pairing.rust} variant, and no other`, () => {
      expectMembers(pairing);
    });
  }

  for (const pairing of STRUCTS) {
    it(`${pairing.ts} carries every ${pairing.rust} field, and no other`, () => {
      expectMembers(pairing);
    });
  }

  it('covers every Rust file the contract says it reads', () => {
    // The doc comment on contract.ts's chat block names these files. If one is
    // dropped from the pairings the claim goes stale silently, so it is asserted.
    const covered = new Set([...ENUMS, ...STRUCTS].map((pairing) => pairing.file));
    expect([...covered].sort()).toEqual([...FILES].sort());
  });

  /**
   * **The floor on the guard's own subject.**
   *
   * Everything above is of the form *for each pairing I happen to list, do the
   * two sides agree* — and nothing asserted how many pairings there are. So
   * deleting a pairing deleted its assertion, and deleted with it the
   * compile-time half that the header calls load-bearing (`everyVariantOf` only
   * closes a union for a list that still exists). Both halves of "there is no
   * order in which a one-sided change is green" lived in one array literal, and
   * removing an entry from that literal was green at `pnpm typecheck` and green
   * at `pnpm test`. The entire visible trace was the vitest count moving by
   * one, and no assertion read that number.
   *
   * This is an **equality**, not a threshold, and the distinction is the whole
   * point. `expect(STRUCTS.length).toBeGreaterThan(7)` would be a measurement
   * wearing a bound: it passes for any list long enough, and it cannot name
   * which pairing vanished. An equality against what is actually in the Rust
   * files fails on a deleted pairing *and* on a type nobody remembered to
   * list, and its diff names both. It also needs no anti-vacuity floor of its
   * own: a scanner that read nothing would produce an empty left-hand side
   * against thirty-five accounted names, which is the loudest failure in the
   * file.
   */
  it('accounts for every serialisable type in the files it reads', () => {
    const scanned = FILES.flatMap((file) => serialisableItems(file))
      .map(qualified)
      .sort();
    const accounted = [
      ...[...ENUMS, ...STRUCTS].map(qualified),
      ...NOT_ON_THIS_BOUNDARY.map(qualified),
    ].sort();
    expect(scanned, 'a serialisable type is neither paired nor on the register').toEqual(
      accounted,
    );
  });

  /**
   * **RULE T, made checkable: the register may not discharge a type into prose.**
   *
   * Either an entry hands the type to another type this guard pairs — and then
   * the hand-off is an edge, because the target carries its own assertions — or
   * it names no `.rs` file at all and is a statement about this type alone.
   * What it may not do is name a Rust file this guard does not open, because a
   * sentence about a file nobody reads is a sentence and nothing else. Every
   * entry here takes the second form, and the assertion is what keeps it that
   * way when the next one is written.
   */
  it('every hand-off on the register lands on a type this guard pairs', () => {
    const paired = new Set([...ENUMS, ...STRUCTS].map(qualified));
    const SCAN = (): readonly SerialisableItem[] => FILES.flatMap((file) => serialisableItems(file));
    for (const entry of NOT_ON_THIS_BOUNDARY) {
      const name = qualified(entry);
      // Reads the entry's own `keyword`, which nothing else does: a register
      // row that says `struct` for what the crate declares as an `enum` is a
      // row that was written about a different type from the one it now names.
      const scanned = SCAN().find((item) => qualified(item) === name);
      expect(scanned?.keyword, `${name} is registered as a ${entry.keyword}`).toBe(entry.keyword);
      if (entry.handedTo !== null) {
        expect(paired, `${name} is handed to ${entry.handedTo}, which is not paired`).toContain(
          entry.handedTo,
        );
      }
      for (const path of rustPathsNamedIn(entry.because)) {
        expect(FILES, `${name}'s reason names ${path}, which this guard does not read`).toContain(
          path,
        );
      }
    }
    // The control: the loop is able to fail, on both counts.
    expect(paired.has('model.rs::ContentPart')).toBe(true);
    expect(paired.has('ipc/content.rs::ContentPartInput')).toBe(false);
    expect(rustPathsNamedIn('converted by `src-tauri/src/ipc/content.rs`')).toEqual([
      'src-tauri/src/ipc/content.rs',
    ]);
    expect(FILES).not.toContain('src-tauri/src/ipc/content.rs');
    expect(rustPathsNamedIn('request DTO boundary')).toEqual([]);
  });

  it('pairs each type at most once, and none vacuously', () => {
    const pairings = [...ENUMS, ...STRUCTS];
    expect(new Set(pairings.map((p) => `${p.file}::${p.rust}`)).size).toBe(pairings.length);
    expect(new Set(pairings.map((p) => p.ts)).size).toBe(pairings.length);
    // The anti-vacuity floor, at the table rather than per read. A pairing with
    // an empty list would compare nothing against nothing however good the
    // parser is; with a non-empty list, an empty read fails the equality inside
    // `expectMembers` on its own.
    expect(pairings.filter((pairing) => pairing.listed.length === 0)).toEqual([]);
  });
});

describe('the parity parser itself', () => {
  // Controls. Every assertion above is only as good as the reader underneath
  // it, and a reader that returns [] for everything would make the whole suite
  // pass vacuously.

  it('fails loudly when an item it was told to read is gone', () => {
    expect(() => readRustItem('model.rs', 'enum', 'NoSuchEnum')).toThrow(
      /no `pub enum NoSuchEnum`/,
    );
  });

  // The line-ending controls. These are not hypothetical: for as long as this
  // file has existed it threw on every Windows checkout, so the parity it
  // asserts was enforced only on CI's LF tree. A guard that cannot run where the
  // product is built is a claim, not a guard — the exact shape this file was
  // written to end. Both endings are pinned so neither can regress into the
  // other's blind spot.

  it('reads an item whose lines end CRLF, which is every Windows checkout', () => {
    const fixture = [
      '#[derive(Debug, Serialize)]',
      '#[serde(rename_all = "camelCase")]',
      'pub enum FixtureEnum {',
      '    OneThing,',
      '    TwoThings { detail: String },',
      '}',
      '',
    ].join('\r\n');
    const item = parseRustItem(fixture, 'enum', 'FixtureEnum');
    expect(item.members).toEqual(['OneThing', 'TwoThings']);
    expect(item.renameAll).toBe('camelCase');
    expect(wireNames(item)).toEqual(['oneThing', 'twoThings']);
  });

  it('reads the same members from a source and its opposite-ending twin', () => {
    // Stronger than the fixture: the real files, converted both ways, so a
    // parser that happened to suit one checkout cannot pass this.
    const lf = (SOURCES['model.rs'] ?? '').replace(/\r\n/g, '\n');
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(lf.includes('\r')).toBe(false);
    expect(crlf.split('\r\n').length).toBeGreaterThan(400);

    for (const [keyword, name] of [
      ['enum', 'ContentPart'],
      ['enum', 'Degradation'],
      ['struct', 'TokenUsage'],
    ] as const) {
      const fromLf = parseRustItem(lf, keyword, name);
      const fromCrlf = parseRustItem(crlf, keyword, name);
      expect(fromLf.members.length, `${name} read as nothing`).toBeGreaterThan(1);
      expect(fromCrlf.members, `${name} differs across line endings`).toEqual(fromLf.members);
      expect(fromCrlf.renameAll).toBe(fromLf.renameAll);
    }
  });

  it('reads the variant names, not the doc comments or attributes around them', () => {
    const providerError = readRustItem('error.rs', 'enum', 'ProviderError');
    // `#[error("…")]` sits above most of these arms; `Cancelled` is the one
    // with no payload, so a parser that only saw `Name {` would miss it.
    expect(providerError.members).toContain('Cancelled');
    expect(providerError.members).toContain('ContextLengthExceeded');
    expect(providerError.members).not.toContain('error');
    expect(providerError.renameAll).toBe('camelCase');
  });

  it('reads snake_case items as snake_case', () => {
    expect(readRustItem('diagnostic.rs', 'enum', 'Cause').renameAll).toBe('snake_case');
    expect(wireName('CredentialStoreUnreadable', 'snake_case', 'variant')).toBe(
      'credential_store_unreadable',
    );
    expect(wireName('CredentialStoreUnreadable', 'camelCase', 'variant')).toBe(
      'credentialStoreUnreadable',
    );
    expect(wireName('authority', 'none', 'field')).toBe('authority');
  });

  it('applies serde\u2019s two different rules under the one attribute name', () => {
    // A variant is read as PascalCase, a field as snake_case. One
    // `rename_all = "camelCase"`, two transformations.
    expect(wireName('ToolCall', 'camelCase', 'variant')).toBe('toolCall');
    expect(wireName('provider_id', 'camelCase', 'field')).toBe('providerId');
    expect(wireName('generated_chars', 'snake_case', 'field')).toBe('generated_chars');
    expect(wireName('ElideOldest', 'snake_case', 'variant')).toBe('elide_oldest');

    // Where the single implementation this file used to carry is wrong. The
    // word split on the lowercase-to-uppercase boundary answers `httperror`
    // for both of these; serde answers neither. No member in the tree has a
    // second capital run today, which is exactly why the bug was invisible.
    expect(wireName('HTTPError', 'camelCase', 'variant')).toBe('hTTPError');
    expect(wireName('HTTPError', 'snake_case', 'variant')).toBe('h_t_t_p_error');
  });

  it('implements every rule it claims to recognise', () => {
    // `RENAME_RULES` is closed against `RenameRule` by the compiler, so this
    // walks the same list and proves each spelling produces its own answer
    // rather than falling through to something's default.
    const variants = RENAME_RULES.map((rule) => wireName('ToolCall', rule as RenameRule, 'variant'));
    const fields = RENAME_RULES.map((rule) => wireName('call_id', rule as RenameRule, 'field'));
    expect(variants).toEqual([
      'toolcall',
      'TOOLCALL',
      'ToolCall',
      'toolCall',
      'tool_call',
      'TOOL_CALL',
      'tool-call',
      'TOOL-CALL',
    ]);
    expect(fields).toEqual([
      'call_id',
      'CALL_ID',
      'CallId',
      'callId',
      'call_id',
      'CALL_ID',
      'call-id',
      'CALL-ID',
    ]);
  });

  it('drops fields serde is told to skip, and keeps the ones it is not', () => {
    // `ChatResponse::salvaged_answer` is `#[serde(skip)]` and never crosses the
    // bridge; `Diagnosis::status` is `skip_serializing_if` and does.
    expect(readRustItem('model.rs', 'struct', 'ChatResponse').members).not.toContain(
      'salvaged_answer',
    );
    expect(readRustItem('diagnostic.rs', 'struct', 'Diagnosis').members).toContain('status');
  });

  /**
   * **The blind spot, now a refusal instead of a silence.**
   *
   * This file applies a container's `rename_all`. It still does not *apply* a
   * per-field `#[serde(rename = "…")]` — a fix there would be a second serde
   * implementation, and a wrong one is worse than a known gap — but it no
   * longer reports agreement it did not check. It throws, and the pairing goes
   * red, because the identifier has stopped being evidence about the key.
   *
   * The previous version of this test asserted the opposite and called it "the
   * whole point": the parser compared `answeredBy` against a field whose wire
   * key was `totally_different` and was satisfied. That is a guard certifying
   * a claim it cannot see, which is worse than an absent guard, because the
   * absent one does not get believed.
   *
   * Actual bytes are still verified only on the Rust side, by serialising a
   * value and reading the keys off the JSON: `model.rs`'s
   * `provenance_crosses_the_bridge_under_the_keys_the_renderer_reads`. Note
   * what that test does and does not cover — it serialises a `ChatResponse`,
   * so it speaks for `answeredBy` and `AnswerProvenance` and for nothing else.
   * `Diagnosis` is never serialised there.
   */
  it('refuses to compare a field carrying a per-field serde rename', () => {
    const fixture = [
      '#[derive(Serialize)]',
      '#[serde(rename_all = "camelCase")]',
      'pub struct FixtureStruct {',
      '    #[serde(rename = "totally_different")]',
      '    pub answered_by: Option<String>,',
      '}',
      '',
    ].join('\n');
    expect(() => parseRustItem(fixture, 'struct', 'FixtureStruct')).toThrow(
      /carries `#\[serde\(rename\)\]`/,
    );
  });

  it('refuses to compare a field whose key it cannot predict', () => {
    // `flatten` deletes the key the identifier names and hoists the inner
    // struct's keys into its place. A parser that reads the identifier and
    // skips the attribute reports a key that is provably absent from the wire.
    // Live in this tree at `src-tauri/src/ipc/secrets.rs`.
    const fixture = [
      '#[derive(Serialize)]',
      '#[serde(rename_all = "camelCase")]',
      'pub struct FixtureStruct {',
      '    #[serde(flatten)]',
      '    pub inner: Inner,',
      '}',
      '',
    ].join('\n');
    expect(() => parseRustItem(fixture, 'struct', 'FixtureStruct')).toThrow(/serde\(flatten\)/);
  });

  it('keeps a field whose attribute leaves the key alone', () => {
    const fixture = [
      '#[derive(Serialize)]',
      '#[serde(rename_all = "camelCase")]',
      'pub struct FixtureStruct {',
      '    #[serde(skip_serializing_if = "Option::is_none", default)]',
      '    pub answered_by: Option<String>,',
      '    #[serde(skip)]',
      '    pub not_on_the_wire: String,',
      '}',
      '',
    ].join('\n');
    const item = parseRustItem(fixture, 'struct', 'FixtureStruct');
    expect(item.members).toEqual(['answered_by']);
    expect(wireNames(item)).toEqual(['answeredBy']);
  });

  it('reads private struct fields, which are still on the wire', () => {
    // `FilterVerdict`'s fields have no `pub`. A parser keyed on `pub ` would
    // read nothing and compare an empty set against an empty set.
    expect(readRustItem('diagnostic.rs', 'struct', 'FilterVerdict').members).toEqual([
      'stage',
      'kind',
      'categories',
      'generated_chars',
    ]);
  });

  /** A `Diagnosis`-shaped fixture, so the rule can be varied and nothing else. */
  function fiveSingleWordFields(rule: string): string {
    return [
      '#[derive(Debug, Serialize, Deserialize)]',
      `#[serde(rename_all = "${rule}")]`,
      'pub struct FixtureStruct {',
      '    cause: Cause,',
      '    status: Option<u16>,',
      '    endpoint: Option<EndpointIdentity>,',
      '    filter: Option<FilterVerdict>,',
      '    correlation: CorrelationId,',
      '}',
      '',
    ].join('\n');
  }

  it('reads a rename rule it does not implement as an error, not as no rule', () => {
    // The two answers are different answers. `none` is "serde applied no
    // rule"; an unspellable value is "serde applied a rule I did not read",
    // and the old `camelCase|snake_case` regex collapsed the second into the
    // first — which is the guard certifying a comparison it never made.
    for (const rule of ['PascalCase', 'SCREAMING_SNAKE_CASE', 'kebab-case']) {
      expect(parseRustItem(fiveSingleWordFields(rule), 'struct', 'FixtureStruct').renameAll).toBe(
        rule,
      );
    }
    expect(() =>
      parseRustItem(fiveSingleWordFields('SpongeBobCase'), 'struct', 'FixtureStruct'),
    ).toThrow(/does not implement/);
  });

  it('sees a rule that changes every wire key while changing no identifier', () => {
    // `Diagnosis`'s five fields are single lowercase words, so `camelCase` is
    // a no-op on them and `PascalCase` is not. Flipping the container between
    // those two edits one token, moves nothing the old parser compared, and
    // sends `Cause`/`Status`/… where the renderer reads `cause`/`status`/… —
    // `src/features/conversation/notices.ts` and
    // `src/features/models/CapabilitySummary.tsx` both go `undefined`, not red.
    const camel = parseRustItem(fiveSingleWordFields('camelCase'), 'struct', 'FixtureStruct');
    const pascal = parseRustItem(fiveSingleWordFields('PascalCase'), 'struct', 'FixtureStruct');
    expect(camel.members).toEqual(pascal.members);
    expect(wireNames(camel)).toEqual(['cause', 'status', 'endpoint', 'filter', 'correlation']);
    expect(wireNames(pascal)).toEqual(['Cause', 'Status', 'Endpoint', 'Filter', 'Correlation']);
  });

  it('reads the discriminant key, including out of a multi-line attribute block', () => {
    // rustfmt breaks `ContentPart`'s serde attribute across five lines
    // (`#[serde(`, three arguments, `)]`), so a line-oriented read sees
    // `#[serde(` and no arguments at all.
    expect(readRustItem('model.rs', 'enum', 'ContentPart').tag).toBe('kind');
    expect(readRustItem('model.rs', 'enum', 'ToolCallOutcome').tag).toBe('status');
    expect(readRustItem('event.rs', 'enum', 'StreamEvent').tag).toBe('type');
    expect(readRustItem('error.rs', 'enum', 'ProviderError').tag).toBe('kind');
    // Externally tagged and plain items have no tag key, and `null` is the
    // answer the pairings assert — not `undefined`, which would also equal a
    // key that was never looked for.
    expect(readRustItem('error.rs', 'enum', 'TransportFailure').tag).toBeNull();
    expect(readRustItem('diagnostic.rs', 'struct', 'Diagnosis').tag).toBeNull();
  });

  /**
   * **The refusal, asked as the right question.**
   *
   * The first version of the refusal searched the attribute text for the
   * literal `#[serde(` and refused what it found inside — which answers *"is
   * there a `#[serde(` here I cannot model?"* when the question is *"can this
   * identifier still be trusted as the wire key?"*. A probe against this tree
   * walked around it three ways, each legal Rust that `cargo build` accepts,
   * and each left the guard green while a key changed. They are fixtures now.
   */
  it('refuses a serde attribute smuggled through a cfg_attr wrapper', () => {
    // `all()` is the empty conjunction, so it is always true and the attribute
    // expands unconditionally. Nothing in the text spells `#[serde(`.
    const fixture = [
      '#[derive(Serialize)]',
      '#[serde(rename_all = "camelCase")]',
      'pub struct FixtureStruct {',
      '    #[cfg_attr(all(), serde(rename = "Scripts"))]',
      '    pub scripts: Vec<String>,',
      '}',
      '',
    ].join('\n');
    expect(() => parseRustItem(fixture, 'struct', 'FixtureStruct')).toThrow(
      /carries `#\[serde\(rename\)\]`/,
    );
    // The wrapper is unwrapped rather than skipped, in both directions: a
    // container rule inside one is read, not lost.
    const wrapped = [
      '#[derive(Serialize)]',
      '#[cfg_attr(all(), serde(rename_all = "PascalCase"))]',
      'pub struct FixtureStruct {',
      '    pub answered_by: String,',
      '}',
      '',
    ].join('\n');
    expect(parseRustItem(wrapped, 'struct', 'FixtureStruct').renameAll).toBe('PascalCase');
  });

  it('reads an attribute written above the derive', () => {
    // Legal Rust, and serde reads it. The old slice started at the last
    // `#[derive`, so everything above it was outside the parse and outside the
    // refusal with it.
    const above = [
      '#[serde(rename_all = "PascalCase")]',
      '#[derive(Serialize)]',
      'pub struct FixtureStruct {',
      '    pub answered_by: String,',
      '}',
      '',
    ].join('\n');
    expect(parseRustItem(above, 'struct', 'FixtureStruct').renameAll).toBe('PascalCase');
    expect(wireNames(parseRustItem(above, 'struct', 'FixtureStruct'))).toEqual(['AnsweredBy']);

    const refusedAbove = [
      '#[serde(untagged)]',
      '#[derive(Serialize)]',
      'pub struct FixtureStruct {',
      '    pub answered_by: String,',
      '}',
      '',
    ].join('\n');
    expect(() => parseRustItem(refusedAbove, 'struct', 'FixtureStruct')).toThrow(
      /does not model/,
    );
  });

  it('refuses an attribute whose effect on the wire is not written down', () => {
    // Not a serde attribute at all, and that is the point: `rustfmt::skip`
    // unmakes the one-member-per-line layout the body reader depends on, and
    // `cfg` decides whether a field is on the wire at all. A parser that only
    // inspected `#[serde(` would have shrugged at both.
    for (const attribute of ['rustfmt::skip', 'cfg(feature = "extra")', 'serde_as']) {
      const fixture = [
        `#[${attribute}]`,
        '#[derive(Serialize)]',
        '#[serde(rename_all = "camelCase")]',
        'pub struct FixtureStruct {',
        '    pub answered_by: String,',
        '}',
        '',
      ].join('\n');
      expect(() => parseRustItem(fixture, 'struct', 'FixtureStruct'), attribute).toThrow(
        /does not model/,
      );
    }
    // The inert ones are still read without complaint, or the refusal would be
    // a refusal of everything and would have to be turned off.
    const inert = [
      '/// A doc comment.',
      '#[allow(dead_code)]',
      '#[non_exhaustive]',
      '#[derive(Debug, Serialize)]',
      '#[serde(rename_all = "camelCase")]',
      'pub struct FixtureStruct {',
      '    pub answered_by: String,',
      '}',
      '',
    ].join('\n');
    expect(wireNames(parseRustItem(inert, 'struct', 'FixtureStruct'))).toEqual(['answeredBy']);
  });

  it('reads the fields inside struct-bodied variants, however they are laid out', () => {
    // `ContentPart::Image` is one line and `ContentPart::Reasoning` is five.
    // Reading only the multi-line spelling would have made this comparison a
    // measurement of how long a variant happened to be.
    const part = readRustItem('model.rs', 'enum', 'ContentPart');
    expect(part.renameAllFields).toBe('camelCase');
    expect(part.payloadFields.get('Image')).toEqual(['data', 'mime_type']);
    expect(part.payloadFields.get('Reasoning')).toEqual(['redacted', 'signature', 'text']);
    expect(payloadWireKeys(part).image).toEqual(['data', 'mimeType']);
    expect(payloadWireKeys(part).toolResult).toEqual(['callId', 'content', 'isError']);
    // A struct has no variants, so it has no payload at all — not an empty
    // read of something that was there.
    expect(readRustItem('model.rs', 'struct', 'TokenUsage').payloadFields.size).toBe(0);
  });

  it('keeps each variant’s payload keys apart from its siblings’', () => {
    // The flat-union hole, as a fixture. `Text` and `Reasoning` both declare
    // `text`, so `#[serde(skip)]` on one of them leaves the *union* of every
    // arm's fields exactly as it was — a probe used that against this file and
    // every assertion stayed green. Keyed by arm, the arm that lost the key is
    // the one the diff names.
    const fixture = (skip: string): string =>
      [
        '#[derive(Serialize)]',
        '#[serde(tag = "kind", rename_all = "camelCase")]',
        'pub enum FixtureEnum {',
        '    Text { text: String },',
        '    Reasoning {',
        `${skip}`,
        '        text: String,',
        '        signature: Option<String>,',
        '    },',
        '}',
        '',
      ].join('\n');
    const whole = parseRustItem(fixture('        // nothing skipped'), 'enum', 'FixtureEnum');
    const skipped = parseRustItem(fixture('        #[serde(skip)]'), 'enum', 'FixtureEnum');
    // The union across arms is `text`+`signature` either way: it cannot see it.
    const union = (item: RustItem): readonly string[] =>
      [...new Set([...item.payloadFields.values()].flat())].sort();
    expect(union(whole)).toEqual(union(skipped));
    // Keyed by arm, it is the whole difference.
    expect(payloadWireKeys(whole)).toEqual({
      text: ['text'],
      reasoning: ['signature', 'text'],
    });
    expect(payloadWireKeys(skipped)).toEqual({ text: ['text'], reasoning: ['signature'] });
  });

  it('sees rename_all_fields change every payload key while changing no identifier', () => {
    const fixture = (rule: string): string =>
      [
        '#[derive(Serialize)]',
        `#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "${rule}")]`,
        'pub enum FixtureEnum {',
        '    Image { mime_type: String, data: Vec<u8> },',
        '    ToolResult {',
        '        call_id: String,',
        '        is_error: bool,',
        '    },',
        '}',
        '',
      ].join('\n');
    const camel = parseRustItem(fixture('camelCase'), 'enum', 'FixtureEnum');
    const pascal = parseRustItem(fixture('PascalCase'), 'enum', 'FixtureEnum');
    expect(camel.members).toEqual(pascal.members);
    expect(wireNames(camel)).toEqual(wireNames(pascal));
    expect(payloadWireKeys(camel)).toEqual({
      image: ['data', 'mimeType'],
      toolResult: ['callId', 'isError'],
    });
    expect(payloadWireKeys(pascal)).toEqual({
      image: ['Data', 'MimeType'],
      toolResult: ['CallId', 'IsError'],
    });
  });

  it('scans an item whose declaration does not end in a brace', () => {
    // A `where` clause puts the opening brace on a line of its own. The scan
    // used to match `pub struct X … {` at the end of one line, so an item like
    // this was absent from the inventory — and an inventory that silently
    // misses an item is the one failure an inventory exists to prevent.
    const fixture = [
      '#[derive(Serialize)]',
      '#[serde(rename_all = "camelCase")]',
      'pub struct WhereClaused<T>',
      'where',
      '    T: Serialize,',
      '{',
      '    pub answered_by: T,',
      '}',
      '',
      '#[derive(Serialize)]',
      '#[serde(transparent)]',
      'pub struct ATupleStruct(u64);',
      '',
    ].join('\n');
    expect(scanSerialisable(fixture, 'fixture.rs').map(qualified)).toEqual([
      'fixture.rs::WhereClaused',
    ]);
    expect(wireNames(parseRustItem(fixture, 'struct', 'WhereClaused'))).toEqual(['answeredBy']);
  });

  it('refuses an item carrying a container attribute it does not model', () => {
    for (const attribute of ['untagged', 'transparent', 'deny_unknown_keys']) {
      const fixture = [
        '#[derive(Serialize)]',
        `#[serde(${attribute})]`,
        'pub struct FixtureStruct {',
        '    pub provider_id: String,',
        '}',
        '',
      ].join('\n');
      expect(() => parseRustItem(fixture, 'struct', 'FixtureStruct')).toThrow(
        /does not model/,
      );
    }
  });

  /* -- the inventory scanner --------------------------------------------- */

  it('finds the serialisable braced items, and only those', () => {
    const fixture = [
      '#[derive(Debug, Clone, Serialize, Deserialize)]',
      '#[serde(rename_all = "camelCase")]',
      'pub struct OnTheWire {',
      '    pub provider_id: String,',
      '}',
      '',
      '#[derive(Debug, Clone)]',
      'pub struct NotSerialised {',
      '    pub provider_id: String,',
      '}',
      '',
      '#[derive(Serialize)]',
      '#[serde(transparent)]',
      'pub struct ANewtype(u64);',
      '',
      '#[derive(',
      '    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,',
      ')]',
      '#[serde(rename_all = "snake_case")]',
      'pub enum SpelledAcrossLines {',
      '    OneThing,',
      '}',
      '',
    ].join('\n');
    expect(scanSerialisable(fixture, 'fixture.rs').map(qualified)).toEqual([
      'fixture.rs::OnTheWire',
      'fixture.rs::SpelledAcrossLines',
    ]);
  });

  it('does not credit an item with the derive belonging to the item above it', () => {
    // The scan slices back to the nearest preceding `#[derive`. Without the
    // check that everything between is attribute text, a plain item following
    // a serialisable one inherits its `Serialize` and joins the inventory as a
    // phantom — which would make the equality below fail for the wrong reason,
    // or worse, absorb a real omission.
    const fixture = [
      '#[derive(Serialize)]',
      'pub struct OnTheWire {',
      '    pub provider_id: String,',
      '}',
      '',
      'pub struct NoDeriveAtAll {',
      '    pub provider_id: String,',
      '}',
      '',
    ].join('\n');
    expect(scanSerialisable(fixture, 'fixture.rs').map(qualified)).toEqual([
      'fixture.rs::OnTheWire',
    ]);
  });

  /* -- the attribute region, bounded by the item ------------------------- */

  it('reads an attribute above the derive with a comment between them', () => {
    // The probe that got past the previous version. The backward walk kept the
    // longest run of lines that read as attribute text and stopped at `*\/`,
    // which is neither attribute text nor a bracket-closer — so the serde
    // attribute above the comment was outside the block the refusal inspects,
    // `renameAll` read as `none`, and raw identifiers were compared against the
    // TypeScript list as though serde had renamed nothing.
    const commented = [
      '#[serde(rename_all = "PascalCase")]',
      '/* the store answers in the spec\'s own',
      '   spelling for these three */',
      '#[derive(Debug, Serialize)]',
      'pub struct FixtureStruct {',
      '    pub answered_by: String,',
      '}',
      '',
    ].join('\n');
    expect(parseRustItem(commented, 'struct', 'FixtureStruct').renameAll).toBe('PascalCase');
    expect(scanSerialisable(commented, 'fixture.rs').map(qualified)).toEqual([
      'fixture.rs::FixtureStruct',
    ]);
  });

  it('stops the attribute region at the item before it, not at what it recognises', () => {
    // The boundary is a position — the nearest `;`, `{` or `}` outside a
    // bracket group — so nothing written inside the region can move it, and
    // nothing outside it can be mistaken for part of it. Both halves matter:
    // the derive above `HasOne` must not be credited to `HasNone`, and the
    // refusal must fire on text in the region rather than silently ending it.
    const fixture = [
      'pub const SOMETHING: u8 = 1;',
      '',
      '#[derive(Serialize)]',
      'pub struct HasOne {',
      '    pub answered_by: String,',
      '}',
      '',
      'pub struct HasNone {',
      '    pub answered_by: String,',
      '}',
      '',
    ].join('\n');
    expect(scanSerialisable(fixture, 'fixture.rs').map(qualified)).toEqual(['fixture.rs::HasOne']);

    const smuggled = [
      'pub const SOMETHING: u8 = 1;',
      '#[serde_as]',
      '#[derive(Serialize)]',
      '#[serde(rename_all = "camelCase")]',
      'pub struct FixtureStruct {',
      '    pub answered_by: String,',
      '}',
      '',
    ].join('\n');
    expect(() => parseRustItem(smuggled, 'struct', 'FixtureStruct')).toThrow(/does not model/);
  });

  /* -- what counts as a declaration -------------------------------------- */

  it('scans a declaration whatever its visibility and indentation', () => {
    // `^pub ` is a spelling standing in for the question. A `pub(crate)` type
    // deriving `Serialize` was invisible to it, and so was anything indented
    // inside a `mod` — both of which put keys on the wire exactly as a `pub`
    // one does the moment a public type holds them.
    const fixture = [
      '#[derive(Serialize)]',
      'pub(crate) struct RestrictedButOnTheWire {',
      '    pub answered_by: String,',
      '}',
      '',
      'pub mod inner {',
      '    #[derive(Serialize)]',
      '    pub struct IndentedButOnTheWire {',
      '        pub answered_by: String,',
      '    }',
      '}',
      '',
      '#[derive(Serialize)]',
      'struct PrivateButOnTheWire {',
      '    pub answered_by: String,',
      '}',
      '',
    ].join('\n');
    expect(scanSerialisable(fixture, 'fixture.rs').map(qualified)).toEqual([
      'fixture.rs::RestrictedButOnTheWire',
      'fixture.rs::IndentedButOnTheWire',
      'fixture.rs::PrivateButOnTheWire',
    ]);
    expect(
      wireNames(parseRustItem(fixture, 'struct', 'RestrictedButOnTheWire')),
    ).toEqual(['answered_by']);
  });

  it('does not read a declaration written inside a comment or a string', () => {
    // The other half of widening the pattern to any indentation: the scan runs
    // on the source with comments and string literals blanked, or a `pub struct`
    // in a doc example would join the inventory as a type that does not exist.
    const fixture = [
      '/// ```',
      '/// #[derive(Serialize)]',
      '/// pub struct FromADocExample { pub x: String }',
      '/// ```',
      '#[derive(Serialize)]',
      'pub struct Real {',
      '    pub answered_by: String,',
      '}',
      '',
      'pub const SNIPPET: &str = "#[derive(Serialize)]\\npub struct FromAString { }";',
      '',
    ].join('\n');
    expect(scanSerialisable(fixture, 'fixture.rs').map(qualified)).toEqual(['fixture.rs::Real']);
  });

  it('finds a type whose Serialize is hand-written rather than derived', () => {
    // `Serialize` is a trait; `#[derive(Serialize)]` is one way to satisfy it.
    // A scan that looks for the derive answers "did someone write the word
    // `derive` here?" when the question is "can this put keys on the wire?" —
    // and a `serialize_struct` body answers the second yes and the first no.
    const fixture = [
      'pub struct StoreAuditRow {',
      '    pub directory: String,',
      '}',
      '',
      'impl serde::Serialize for StoreAuditRow {',
      '    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>',
      '    where',
      '        S: serde::Serializer,',
      '    {',
      '        let mut row = serializer.serialize_struct("StoreAuditRow", 1)?;',
      '        row.serialize_field("Directory", &self.directory)?;',
      '        row.end()',
      '    }',
      '}',
      '',
    ].join('\n');
    expect(scanSerialisable(fixture, 'fixture.rs').map(qualified)).toEqual([
      'fixture.rs::StoreAuditRow',
    ]);
  });

  it('does not mistake a neighbouring trait or a bound for an impl of Serialize', () => {
    // The trait path is matched immediately before `for`, so `Deserialize`,
    // `Serializer` and a `Serialize` bound in a generic parameter list are not
    // it. Over-inclusion here would cost a register entry for a type that puts
    // nothing on the wire, which is a register that churns and gets weakened.
    const fixture = [
      'pub struct NotOnTheWire {',
      '    pub answered_by: String,',
      '}',
      '',
      "impl<'de> serde::Deserialize<'de> for NotOnTheWire {",
      '    fn deserialize<D>(_: D) -> Result<Self, D::Error> {',
      '        todo!()',
      '    }',
      '}',
      '',
      'impl NotSerialize for NotOnTheWire {}',
      '',
    ].join('\n');
    expect(scanSerialisable(fixture, 'fixture.rs')).toEqual([]);
  });

  it('refuses an impl of Serialize for a type it cannot find', () => {
    const fixture = ['impl serde::Serialize for SomewhereElse {', '    // …', '}', ''].join('\n');
    expect(() => scanSerialisable(fixture, 'fixture.rs')).toThrow(/which it does not declare/);
  });

  /* -- what counts as a member ------------------------------------------- */

  it('reads a raw identifier under the key serde really emits for it', () => {
    // `r#type` is not an exotic spelling. It is the only legal way to name a
    // field whose wire key is `type`, which is exactly the situation a
    // serde-facing struct runs into — and an alphabet of `[a-z_][a-z0-9_]*`
    // captures `r`, then wants a `:` where the `#` is, and drops the field with
    // no error at all while the assertion named `…, and no other` goes on
    // passing over a live extra key.
    const fixture = [
      '#[derive(Serialize)]',
      '#[serde(rename_all = "camelCase")]',
      'pub struct FixtureStruct {',
      '    pub r#type: String,',
      '    pub answered_by: String,',
      '}',
      '',
    ].join('\n');
    const item = parseRustItem(fixture, 'struct', 'FixtureStruct');
    expect(item.members).toEqual(['type', 'answered_by']);
    expect(wireNames(item)).toEqual(['type', 'answeredBy']);
  });

  it('refuses a body line where a member should be and it cannot read one', () => {
    // A `continue` answers "I did not recognise that, so there was nothing
    // there", and those are two different answers. Every shape the reader does
    // know is listed above this refusal; anything else is named out loud
    // instead of quietly shrinking the set it reports.
    const fixture = [
      '#[derive(Serialize)]',
      'pub struct FixtureStruct {',
      '    pub answered_by: String,',
      '    pub unreadable_by_this_parser!(),',
      '}',
      '',
    ].join('\n');
    expect(() => parseRustItem(fixture, 'struct', 'FixtureStruct')).toThrow(
      /is where a field should be and this parser cannot read it/,
    );
  });

  it('does not invent a variant out of a tuple variant spread over lines', () => {
    // Parenthesised continuation lines are continuations, not members. Read as
    // members they add variants the contract has never heard of, and the
    // comparison then fails for a reason that has nothing to do with drift.
    const fixture = [
      '#[derive(Serialize)]',
      '#[serde(rename_all = "snake_case")]',
      'pub enum FixtureEnum {',
      '    OneThing,',
      '    Wrapped(',
      '        SomeLongTypeName,',
      '    ),',
      '}',
      '',
    ].join('\n');
    expect(parseRustItem(fixture, 'enum', 'FixtureEnum').members).toEqual(['OneThing', 'Wrapped']);
  });

  it('blanks a raw string whose contents end in a backslash', () => {
    // `r"\\?\"` is real in this tree — `vela-projects/src/workdir.rs` holds four
    // such literals and `link.rs` two. A raw string has no escapes, so that
    // trailing backslash is content; read with escape rules the `\"` is taken
    // as an escaped quote, the literal never closes, and every brace after it
    // is invisible to the reader.
    const fixture = [
      'pub fn strip(path: &str) -> Option<&str> {',
      '    path.strip_prefix(r"\\\\?\\")',
      '}',
      '',
      '#[derive(Serialize)]',
      'pub struct AfterTheRawString {',
      '    pub answered_by: String,',
      '}',
      '',
    ].join('\n');
    expect(scanSerialisable(fixture, 'fixture.rs').map(qualified)).toEqual([
      'fixture.rs::AfterTheRawString',
    ]);
    expect(wireNames(parseRustItem(fixture, 'struct', 'AfterTheRawString'))).toEqual([
      'answered_by',
    ]);
  });

  it('scans the same items out of a source and its opposite-ending twin', () => {
    const lf = (SOURCES['diagnostic.rs'] ?? '').replace(/\r\n/g, '\n');
    const crlf = lf.replace(/\n/g, '\r\n');
    const fromLf = scanSerialisable(lf, 'diagnostic.rs').map(qualified);
    expect(fromLf.length, 'scanned nothing out of diagnostic.rs').toBeGreaterThan(1);
    expect(scanSerialisable(crlf, 'diagnostic.rs').map(qualified)).toEqual(fromLf);
  });
});
