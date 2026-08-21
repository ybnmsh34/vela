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
 * One surface remains outside, stated rather than implied: **this guard never
 * serialises anything.** It compares an identifier and the attributes above it
 * against a spelling in `contract.ts`, and an identifier is evidence about a
 * key only for as long as the attributes say it is — which is why every
 * attribute it cannot model is a refusal rather than a shrug.
 *
 * Bytes are observed on the Rust side, and an earlier version of this
 * paragraph named one test as the only place it happens. That was wrong and it
 * was wrong in the direction that understates the tree: inside these five
 * files, four tests serialise a value and assert keys off the JSON —
 * `error.rs`'s `errors_serialise_camel_case_for_the_ipc_layer` (`kind`,
 * `limitTokens`, and `diagnosis.cause`, so a `Diagnosis` **is** serialised and
 * key-pinned here), `event.rs`'s `events_serialise_camel_case_and_tagged`
 * (`type`, `delta.argumentsFragment`), and `model.rs`'s
 * `provenance_crosses_the_bridge_under_the_keys_the_renderer_reads`
 * (a `ChatResponse`, pinning `answeredBy` and the whole `AnswerProvenance`
 * sub-object) and `content_parts_serialise_with_the_stores_tags` (`kind`,
 * `callId`). The other two files serialise too, and neither pins a key:
 * `capability.rs` twice, to assert an *absence* — that no adapter free text and
 * no backend model id reach the flag set the UI branches on — and
 * `diagnostic.rs` several times over unit variants, whose serialised form is a
 * string rather than an object, asserted against each variant's own `code()`.
 *
 * Each of those speaks for the value it serialises and for nothing further, and
 * that is the gap this guard fills: they are a handful of types deep, and this
 * is every paired type wide.
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
  conditionalWireKeys,
  parseRustItem,
  payloadRecord,
  payloadWireKeys,
  qualified,
  RENAME_RULES,
  filePathsNamedIn,
  scanSerialisable,
  wireName,
  wireNames,
  withoutCommentsOrStrings,
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

/**
 * The keys of `T` the renderer's own type says may be absent — the ones spelled
 * with a `?`.
 *
 * Derived from the interface rather than listed, so the list below is closed by
 * the compiler in the same way every other list in this file is: making a field
 * required in `contract.ts` and leaving the list alone does not compile.
 *
 * **It distributes**, and the version that did not could not see an optional
 * key on a single arm of a union: the mapped type is indexed by `[keyof T]`,
 * and for a union `keyof T` is only the keys common to every arm. This file
 * points it at one object type today, so the defect was latent here and live
 * in the two sibling guards, where six of eleven entries named unions and
 * could not fail for any edit. Fixed in the same shape in all three, because
 * the next type this is pointed at is as likely to be a union as not.
 * `object` rather than `unknown` because a distributed `keyof` over a *string
 * literal* arm asks about `String`'s own members, several of which the
 * TypeScript lib declares optional.
 */
type OptionalKeysOf<T> = T extends object
  ? {
      [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never;
    }[keyof T]
  : never;

/**
 * The `Diagnosis` keys serde is allowed to omit.
 *
 * `#[serde(skip_serializing_if = "Option::is_none")]` does not drop a key and
 * does not leave it alone; it makes the key **conditional**, and the parser's
 * own allow-list used to record it as leaving the key alone. That was a wrong
 * answer written inside an allow-list, which is the one thing a
 * *have-I-written-this-down* posture cannot detect — it asks whether the key is
 * listed, never whether the listed answer is true. The fix that makes it stay
 * true is a reader: this list is closed by the compiler against the `?` keys of
 * `Diagnosis`, and the assertion below closes it against the Rust attribute, so
 * the two sentences *serde may omit this key* and *the renderer's type says
 * this key may be missing* are held together in both directions.
 *
 * The shape of the bug this prevents is one line of
 * `src/features/skills/SkillsPanel.tsx`:
 * `RESOURCE_GROUPS.filter(([key]) => resources[key].length > 0)` throws on
 * `undefined.length` the moment a key it reads stops being unconditional.
 */
const DIAGNOSIS_OPTIONAL = everyVariantOf<OptionalKeysOf<Diagnosis> & string>()([
  'status',
  'endpoint',
  'filter',
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
 * applied fourteen times in this repository's Rust; it changes no identifier and
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
 * to endpoints rather than to this contract. The inventory equality below is
 * scoped to these files in its own name.
 *
 * `covers every Rust file the contract says it reads` **opens `contract.ts` and
 * reads the brace list out of it**. The previous version of that test compared
 * this constant against the files the pairings name — two values local to this
 * module — while the doc above it claimed the list was pinned against
 * `contract.ts`'s own sentence. It was not: editing that sentence from five
 * files to two left the guard 66/66 green and the whole platform directory
 * 1365/1365 green. A header saying another boundary is covered is prose, and
 * prose is not the cover — which is this file's own sentence, and it was true
 * about this file.
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
   * Nine of the thirteen entries below are `null`, and that is the honest
   * answer rather than a decorative one: the seven `request DTO boundary` rows
   * and the two `capability DTO boundary` rows are each discharged by a type in
   * `src-tauri/src/ipc/`, which this guard does not read, so their reasons
   * stay what they are — statements about the direction those types travel,
   * not hand-offs this file can prove.
   *
   * The other four are not like them and an earlier version of this sentence
   * said there was only one. `HarmCategory` is discharged inside this guard's
   * own reach:
   * `diagnostic.rs`'s `FilterVerdict` holds it as `categories: HarmCategories`,
   * a `#[serde(transparent)]` newtype over `u8`, and `FilterVerdict` is paired
   * here. Nothing under `src-tauri/src/ipc/` mentions `HarmCategory` at all.
   * So that row names its hand-off and the assertion below checks it, which is
   * the whole difference this field was added to make. The three newtype rows
   * added this round are the same shape: each names the paired type that holds
   * it as a field — `ProviderError::ModelNotFound::model_id` for
   * `ConfiguredModelId`, `Diagnosis::correlation` for `CorrelationId`,
   * `FilterVerdict::categories` for `HarmCategories` — and the assertion below
   * makes each of those three a checked edge rather than a sentence.
   *
   * The field exists because the
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
    form: 'braced',
    rust: 'ChatRequest',
    handedTo: null,
    because: 'request DTO boundary',
  },
  {
    file: 'model.rs',
    keyword: 'struct',
    form: 'braced',
    rust: 'ChatMessage',
    handedTo: null,
    because: 'request DTO boundary',
  },
  {
    file: 'model.rs',
    keyword: 'struct',
    form: 'braced',
    rust: 'ToolDefinition',
    handedTo: null,
    because: 'request DTO boundary',
  },
  {
    file: 'model.rs',
    keyword: 'enum',
    form: 'braced',
    rust: 'ResponseFormat',
    handedTo: null,
    because: 'request DTO boundary',
  },
  {
    file: 'model.rs',
    keyword: 'enum',
    form: 'braced',
    rust: 'ReasoningRequest',
    handedTo: null,
    because: 'request DTO boundary',
  },
  {
    file: 'model.rs',
    keyword: 'struct',
    form: 'braced',
    rust: 'CacheHints',
    handedTo: null,
    because: 'request DTO boundary',
  },
  {
    file: 'model.rs',
    keyword: 'struct',
    form: 'braced',
    rust: 'Sampling',
    handedTo: null,
    because: 'request DTO boundary',
  },
  // Capability reporting crosses as an ipc DTO that drops the adapter's
  // free-text `note`; the header names that difference too.
  {
    file: 'capability.rs',
    keyword: 'struct',
    form: 'braced',
    rust: 'CapabilityFinding',
    handedTo: null,
    because: 'capability DTO boundary',
  },
  {
    file: 'capability.rs',
    keyword: 'struct',
    form: 'braced',
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
    form: 'braced',
    rust: 'HarmCategory',
    handedTo: 'diagnostic.rs::FilterVerdict',
    because: 'crosses as a bitset, not as names',
  },
  // The three newtypes. Each derives `Serialize` and each is a tuple struct,
  // so none of them has a member name to pair — but "cannot be paired" is not
  // "cannot put keys on the wire", and until this round the scan answered the
  // second question by testing the first and left all three off an inventory
  // that called itself complete. `form: 'tuple'` is the load-bearing part of
  // each row: a newtype that grows a braced body starts putting keys of its
  // own on the wire, and that is the change these rows are here to catch.
  //
  // `#[serde(transparent)]` is what makes them harmless today — each crosses
  // as its inner value and adds no key. That attribute is not read here and
  // this comment does not pretend it is; what is asserted is the form.
  {
    file: 'diagnostic.rs',
    keyword: 'struct',
    form: 'tuple',
    rust: 'ConfiguredModelId',
    handedTo: 'error.rs::ProviderError',
    because: 'a transparent newtype: crosses as its inner value, with no key of its own',
  },
  {
    file: 'diagnostic.rs',
    keyword: 'struct',
    form: 'tuple',
    rust: 'CorrelationId',
    handedTo: 'diagnostic.rs::Diagnosis',
    because: 'a transparent newtype: crosses as its inner value, with no key of its own',
  },
  {
    file: 'diagnostic.rs',
    keyword: 'struct',
    form: 'tuple',
    rust: 'HarmCategories',
    handedTo: 'diagnostic.rs::FilterVerdict',
    because: 'a transparent newtype: crosses as its inner value, with no key of its own',
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
    // `contract.ts` opens its chat block by saying every type there mirrors a
    // serde shape in a brace-expanded list of five files. That sentence is the
    // claim; this reads it out of the file and holds all three lists together —
    // the sentence, the constant this guard walks, and the files the pairings
    // name. The previous version compared the last two and nothing else, and the
    // doc above `FILES` said it compared the first: editing contract.ts's
    // sentence from five files to two was green here, twice.
    const prose = readFileSync(join(process.cwd(), 'src', 'platform', 'contract.ts'), 'utf8');
    const named = /src-tauri\/crates\/vela-providers\/src\/\{([^}]+)\}\.rs/.exec(prose);
    expect(named, 'contract.ts no longer names the crate files it mirrors').not.toBeNull();
    const claimed = (named?.[1] ?? '').split(',').map((stem) => `${stem.trim()}.rs`);
    expect([...claimed].sort()).toEqual([...FILES].sort());
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
   * against every accounted name in the file, which is the loudest failure in
   * it.
   *
   * The count that used to stand where "every accounted name" now does was
   * thirty-five, and it was **false when it was measured**: `accounted` is
   * `ENUMS` + `STRUCTS` + `NOT_ON_THIS_BOUNDARY`, which is thirty-eight, and
   * the assertion itself proves it by comparing that list for equality against
   * a scan that returns thirty-eight. Thirty-five was right on the commit that
   * wrote the sentence and wrong on the very next one, which added three names
   * to the register and did not move the number — the same commit whose
   * subject is that non-braced items must join the inventory. A number in
   * prose describing a list the code already counts is a second copy of the
   * list, and it is the copy that goes stale, so there is one copy now.
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
   * An entry may point at exactly one thing, and only through a field a reader
   * checks: `handedTo`, whose target has to be a type this guard really pairs
   * and therefore carries its own assertions. Everything else on the row is a
   * statement about this type alone, and `because` is prose — read by people,
   * asserted by nothing, and forbidden from naming a file so that it cannot
   * look like the edge it is not.
   *
   * That prohibition replaces a check that was a spelling test and failed in
   * both directions: it collected `\S+\.rs` out of the sentence and demanded
   * each hit be a file this guard opened, so writing the path the way the
   * repository writes it turned the guard **red**, while writing "the
   * ipc/skills module" made the check vanish entirely and let a row discharge
   * a type into a module nothing here opens.
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
      // And its form. A register row is written about a type as it stood, and
      // the change worth catching is a newtype growing a braced body: it stops
      // crossing as its inner value and starts putting keys of its own on the
      // wire, under a name this guard has already agreed not to pair.
      expect(scanned?.form, `${name} is registered as a ${entry.form} item`).toBe(entry.form);
      if (entry.handedTo !== null) {
        expect(paired, `${name} is handed to ${entry.handedTo}, which is not paired`).toContain(
          entry.handedTo,
        );
      }
      // RULE T, and the whole of it: a register row may point at something
      // only through a field a reader checks. Prose that names a file is
      // prose that looks like an edge and is not one, and the previous
      // version of this check — collect the `.rs` paths out of the sentence
      // and require each to be a file this guard opened — was wrong in both
      // directions at once. Spelling the path the way the repository spells
      // it turned this red; writing "the ipc/skills module" made the check
      // disappear and left a row that could discharge a type into a file
      // nobody opens. So the sentence explains, `handedTo` points, and this
      // asserts the division.
      expect(
        filePathsNamedIn(entry.because),
        `${name}'s reason names a file; a register row points through \`handedTo\`, not prose`,
      ).toEqual([]);
    }
    // The control: the loop is able to fail, on both counts.
    expect(paired.has('model.rs::ContentPart')).toBe(true);
    expect(paired.has('ipc/content.rs::ContentPartInput')).toBe(false);
    expect(filePathsNamedIn('converted by `src-tauri/src/ipc/content.rs`')).toEqual([
      'content.rs',
      'src-tauri/src/ipc/content.rs',
    ]);
    // The spelling that used to slip through: a module named without its
    // extension. Both are refused now, because neither is an edge.
    expect(filePathsNamedIn('taken apart by the ipc/content module')).toEqual(['ipc/content']);
    expect(filePathsNamedIn('request DTO boundary')).toEqual([]);
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
    // for both of these; serde answers neither.
    expect(wireName('HTTPError', 'camelCase', 'variant')).toBe('hTTPError');
    expect(wireName('HTTPError', 'snake_case', 'variant')).toBe('h_t_t_p_error');

    // An earlier version of this comment said no member in the tree had a
    // second capital run, and offered that as the reason the bug was
    // invisible. Both halves were wrong. Three live members have one —
    // `SkillMountProblem::NameIsNotASinglePathSegment` in
    // `src-tauri/crates/vela-projects/src/mount.rs` (the run `AS`),
    // `SkillProblem::NameIsNotASinglePathSegment` in
    // `src-tauri/crates/vela-skills/src/document.rs`, and
    // `WorkingDirectoryProblem::NotADirectory` in
    // `src-tauri/crates/vela-projects/src/workdir.rs` (the run `AD`) — and on
    // all three the word split disagrees with serde: `nameIsNotAsinglePathSegment`
    // against `nameIsNotASinglePathSegment`, `notAdirectory` against
    // `notADirectory`. The contract spells them serde's way, so the word split
    // would have reported both sides wrong about a name the host really sends.
    //
    // The real reason it was invisible is narrower and is about which file
    // carried it: the word-split `wireName` lived in *this* file, which reads
    // only the five `vela-providers` sources, and none of those five holds such
    // a member. The two guards that do read those three members already had the
    // correct implementation. That is the shape of the whole defect — a reader
    // asserting about a tree it does not open.
    expect(wireName('NameIsNotASinglePathSegment', 'camelCase', 'variant')).toBe(
      'nameIsNotASinglePathSegment',
    );
    expect(wireName('NotADirectory', 'camelCase', 'variant')).toBe('notADirectory');
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

  it('names every key serde may leave off the wire, and the contract spells each optional', () => {
    // `Diagnosis` is the only paired type in these five files carrying
    // `skip_serializing_if`, and the loop is what keeps that a measurement
    // rather than a memory: a new one anywhere on this boundary is red here
    // until somebody decides whether the TypeScript field gains a `?`.
    expect(conditionalWireKeys(readRustItem('diagnostic.rs', 'struct', 'Diagnosis'))).toEqual(
      [...DIAGNOSIS_OPTIONAL].sort(),
    );
    for (const pairing of [...ENUMS, ...STRUCTS]) {
      if (pairing.rust === 'Diagnosis') continue;
      expect(
        conditionalWireKeys(readRustItem(pairing.file, pairing.keyword, pairing.rust)),
        `${qualified(pairing)} gained a conditional key and nothing decided what it means`,
      ).toEqual([]);
    }
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
   * Actual bytes are verified on the Rust side, by serialising a value and
   * reading the keys off the JSON. An earlier version of this paragraph named
   * `model.rs`'s `provenance_crosses_the_bridge_under_the_keys_the_renderer_reads`
   * as *the* place that happens and added that `Diagnosis` is never serialised
   * there. The first half was too narrow — the header lists the four tests in
   * these five files that do it — and the second half was false about the very
   * type it named: `error.rs`'s `errors_serialise_camel_case_for_the_ipc_layer`
   * serialises a `ProviderError::ContextLengthExceeded`, which carries a
   * `Diagnosis`, and asserts `json["diagnosis"]["cause"]`.
   *
   * What survives is the sentence that was doing the work: a test that
   * serialises one value speaks for that value's keys and no others, so
   * `answeredBy` and `AnswerProvenance` are pinned in bytes and the field this
   * test is about — a per-field `rename` on any other type — is not.
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
      'fixture.rs::ATupleStruct',
    ]);
    expect(wireNames(parseRustItem(fixture, 'struct', 'WhereClaused'))).toEqual(['answeredBy']);
    // The tuple struct is on the inventory and is still a tuple struct: the
    // scan reports the form rather than using it to drop the item, and
    // `parseRustItem` is the thing that refuses to pair one.
    expect(scanSerialisable(fixture, 'fixture.rs').map((item) => item.form)).toEqual([
      'braced',
      'tuple',
    ]);
    expect(() => parseRustItem(fixture, 'struct', 'ATupleStruct')).toThrow(/is a tuple item/);
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

  it('finds the serialisable items, and only those', () => {
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
      'fixture.rs::ANewtype',
      'fixture.rs::SpelledAcrossLines',
    ]);
    // `NotSerialised` is the "only those" half and it is the one that matters:
    // a derive list without `Serialize` keeps a type off the inventory however
    // it is spelled. `ANewtype` is on it because it derives `Serialize` — the
    // inventory's question is what can put keys on the wire, not what this
    // parser can pair.
    expect(scanSerialisable(fixture, 'fixture.rs').map((item) => item.form)).toEqual([
      'braced',
      'tuple',
      'braced',
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
    // `r"\\?\"` is real in this repository — though not in the five files
    // *this* guard opens, and the distinction is the point rather than a hedge.
    // `vela-projects/src/workdir.rs` holds four raw string literals and
    // `link.rs` two, which is every one in either of the two crates whose whole
    // `src` a sibling guard scans; none of this guard's five files holds one.
    // The blanker is shared, so the fixture belongs wherever the blanker is
    // exercised — what would not be honest is calling the construct live in the
    // files read here. A raw string has no escapes, so that
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

  it('blanks a char literal, so a quote inside one opens no string', () => {
    // Live in this repository, in a file a sibling guard scans rather than in
    // one of this guard's five: `vela-skills/src/document.rs` spells the char
    // literal holding a double quote inside `is_single_path_segment`, and its
    // byte form inside `unquote`. Handed to the ordinary string scanner,
    // the first bare quote opens a
    // literal that closes on the next one and everything between is blanked —
    // here a whole `#[derive(Serialize)]` declaration, which then leaves the
    // inventory whose entire purpose is to make the count of unaccounted
    // serialisable types zero.
    const fixture = [
      String.raw`pub const FORBIDDEN: [char; 2] = ['"', '|'];`,
      '',
      '#[derive(Debug, Clone, Serialize)]',
      'pub struct BetweenTwoCharLiterals {',
      '    pub answered_by: String,',
      '}',
      '',
      String.raw`pub const QUOTE: char = '"';`,
      '',
    ].join('\n');
    expect(scanSerialisable(fixture, 'fixture.rs').map(qualified)).toEqual([
      'fixture.rs::BetweenTwoCharLiterals',
    ]);
    expect(wireNames(parseRustItem(fixture, 'struct', 'BetweenTwoCharLiterals'))).toEqual([
      'answered_by',
    ]);
  });

  it('leaves a lifetime alone, which is the other thing a quote can be', () => {
    // The half of the char-literal case that has to stay wrong-way-safe. The
    // `'a` in `Line<'a>` is not a literal, and blanking from it would erase the
    // declaration it is part of — the same silence reached from the opposite
    // direction. `vela-skills/src/document.rs` declares `struct Line<'a>` today.
    const fixture = [
      '#[derive(Serialize)]',
      String.raw`pub struct Borrowed<'a> {`,
      String.raw`    pub answered_by: &'a str,`,
      '}',
      '',
    ].join('\n');
    expect(scanSerialisable(fixture, 'fixture.rs').map(qualified)).toEqual([
      'fixture.rs::Borrowed',
    ]);
  });

  it('closes a nested block comment on its own terminator, not the first one', () => {
    // Rust block comments nest. Stopping at the first terminator leaves the
    // outer comment's tail as live text — here a declaration that does not
    // exist, and a brace that would close the next item early.
    const fixture = [
      '/* outer /* inner */ pub struct NotDeclared { } */',
      '#[derive(Serialize)]',
      'pub struct AfterTheComment {',
      '    pub answered_by: String,',
      '}',
      '',
    ].join('\n');
    expect(scanSerialisable(fixture, 'fixture.rs').map(qualified)).toEqual([
      'fixture.rs::AfterTheComment',
    ]);
  });

  it('refuses a line that spells two members, attribute and all', () => {
    // The refusal used to be as line-oriented as the reader: the first match on
    // the line was kept, the rest was never looked at, and the line was not
    // *unreadable* — it was mis-answered, so nothing fired. The second field's
    // `#[serde(rename)]` was read by nothing while its key crossed the bridge.
    const fixture = [
      '#[derive(Serialize)]',
      'pub struct TwoOnOneLine {',
      '    pub answered_by: String, #[serde(rename = "Extra")] pub extra: String,',
      '}',
      '',
    ].join('\n');
    expect(() => parseRustItem(fixture, 'struct', 'TwoOnOneLine')).toThrow(
      /puts more than one member on one line/,
    );
  });

  it('reads a generic field type whose commas are not member separators', () => {
    // The control for the line above: `HashMap<String, u32>` puts a comma on a
    // member line and is one member. A separator scan that did not track angle
    // brackets would refuse most of the generic fields in the crate.
    const fixture = [
      '#[derive(Serialize)]',
      'pub struct OneGenericField {',
      '    pub counts: HashMap<String, u32>,',
      '    pub callback: fn(&str) -> bool,',
      '}',
      '',
    ].join('\n');
    expect(parseRustItem(fixture, 'struct', 'OneGenericField').members).toEqual([
      'counts',
      'callback',
    ]);
  });

  it('refuses a member line whose angle brackets do not pair up', () => {
    // `topLevelParts` tracks `<` as a bracket, and the doc above it used to say
    // that was safe because "a struct or enum body holds no expressions — every
    // `<` on one of these lines is type syntax, never a comparison". A const
    // array length is an expression. Under the old reading the `<` left depth
    // at 1 across the separating comma, the line read as one member, and the
    // second field's rename was read by nothing while its key crossed.
    const fixture = [
      '#[derive(Serialize)]',
      'pub struct ComparisonInALength {',
      '    pub flags: [bool; { 1 < 2 } as usize], #[serde(rename = "Sneak")] pub b: String,',
      '}',
      '',
    ].join('\n');
    expect(() => parseRustItem(fixture, 'struct', 'ComparisonInALength')).toThrow(
      /does not pair its `<` with a `>`/,
    );
  });

  it('refuses a one-line struct variant whose angle brackets do not pair up', () => {
    // The same under-split, one construct in, where it was **silent** rather
    // than mis-answered: this path iterated whatever it was handed and had no
    // accounting of its own, so the swallowed comma dropped a field and the
    // payload comparison reported the same keys it always had.
    //
    // The control below is the identical bytes with `Vec<u8>` in place of the
    // shifted array length: there the comma is a separator, all three fields
    // are read, and the payload comparison sees `secretPath`. So the refusal
    // is what stands between "this parser cannot tell" and "this parser said
    // two keys when three crossed".
    const shifted = [
      '#[derive(Serialize)]',
      '#[serde(tag = "kind", rename_all = "camelCase")]',
      '#[serde(rename_all_fields = "camelCase")]',
      'pub enum OneLineVariant {',
      '    Image { mime_type: String, data: [u8; 1 << 5], secret_path: String },',
      '}',
      '',
    ].join('\n');
    expect(() => parseRustItem(shifted, 'enum', 'OneLineVariant')).toThrow(
      /does not pair its `<` with a `>`/,
    );
    const control = shifted.replace('[u8; 1 << 5]', 'Vec<u8>');
    expect(payloadWireKeys(parseRustItem(control, 'enum', 'OneLineVariant'))).toEqual({
      image: ['data', 'mimeType', 'secretPath'],
    });
  });

  it('spells every name Rust spells, in all three readers that read one', () => {
    // The layer under five rounds of spelling fixes: not how a declaration is
    // written, but which sequences of characters this reader agrees to call a
    // name. Three refusals were written across three rounds and each brought
    // its own character class. `declarationsIn`'s was `[A-Za-z][A-Za-z0-9_]*`,
    // so a leading underscore produced no declaration at all — the type was on
    // no inventory in the repository, and one character was the whole
    // difference between caught and blind. The impl reader's class *did* admit
    // the underscore, so `impl Serialize for _Row` was a loud refusal while
    // `#[derive(Serialize)] pub struct _Row` was silence: one name, two doors,
    // two answers. There is one alphabet now, and this is the assertion that
    // says all three doors use it.
    for (const name of ['_StoreAuditRow', 'Café', 'Ω_row']) {
      const derived = `#[derive(Debug, Clone, Serialize)]\npub struct ${name} {\n    pub a: String,\n}\n`;
      expect(scanSerialisable(derived, 'fixture.rs').map(qualified), name).toEqual([
        `fixture.rs::${name}`,
      ]);
      // The second door: a hand-written impl for the same name, which used to
      // be the one that answered differently.
      const manual = `pub struct ${name} {\n    pub a: String,\n}\n\nimpl Serialize for ${name} {\n    fn serialize() {}\n}\n`;
      expect(scanSerialisable(manual, 'fixture.rs').map(qualified), name).toEqual([
        `fixture.rs::${name}`,
      ]);
    }
    // A raw identifier is a name whose spelling carries a prefix that is not
    // part of it. Under the old class the `r` matched and the `#` did not, so
    // this joined the inventory under the name `r` — an entry for a type that
    // does not exist, next to a missing entry for one that does.
    const raw = '#[derive(Serialize)]\npub struct r#Row {\n    pub a: String,\n}\n';
    expect(scanSerialisable(raw, 'fixture.rs').map(qualified)).toEqual(['fixture.rs::Row']);
  });

  it('finds a hand-written Serialize impl whose bounds carry generics of their own', () => {
    // `IMPL_SERIALIZE`'s generic parameter list was `<[^>]*>`, and a character
    // class cannot cross a nested `>`. `impl<T: AsRef<[u8]>> Serialize for Row`
    // stopped at the `>` closing `AsRef<[u8]`, matched nothing, and the type
    // was neither derived nor manual — dropped off every inventory in the
    // repository, in silence, by the one function written because a
    // hand-written impl puts whatever keys its body writes on the wire. Six
    // characters were the whole difference. The tree already spells this bound
    // shape one nesting level short in `impl<'a, S: SettingsRepository + ?Sized>`
    // and in `pub fn recognise<S: AsRef<str>>`.
    const declaration = 'pub struct Row {\n    pub a: String,\n}\n';
    const found = [
      'impl<T: Clone> serde::Serialize for Row',
      'impl<T: AsRef<[u8]>> serde::Serialize for Row',
      'impl<T: IntoIterator<Item = u8>> Serialize for Row',
      'impl<F: Fn() -> u8> Serialize for Row',
      "impl<'a, T: Into<Cow<'a, str>>> Serialize for Row",
      'impl ::serde::Serialize for Row',
      "impl<'a> Serialize for &'a Row",
      'impl<T> serde::ser::Serialize for Row\nwhere\n    T: Clone,',
    ];
    for (const header of found) {
      const fixture = `${declaration}\n${header} {\n    fn serialize() {}\n}\n`;
      expect(scanSerialisable(fixture, 'fixture.rs').map(qualified), header).toEqual([
        'fixture.rs::Row',
      ]);
    }
    // And the other half, or the widening would cost a register entry for
    // every type in the crate: the segment compared is the one immediately
    // before `for`, so a bound, a neighbouring trait and a trait whose name
    // merely ends in `Serialize` are all still not it.
    const ignored = [
      "impl<'de> serde::Deserialize<'de> for Row",
      'impl serde::Serializer for Row',
      'impl<T: Serialize> Debug for Row',
      'impl NotSerialize for Row',
      'impl my::MySerialize for Row',
      'impl Row',
    ];
    for (const header of ignored) {
      const fixture = `${declaration}\n${header} {\n    fn serialize() {}\n}\n`;
      expect(scanSerialisable(fixture, 'fixture.rs'), header).toEqual([]);
    }
  });

  it('refuses a macro at item position however its path is written', () => {
    // Round 5 decided item position structurally and then read the structure
    // from the character before the macro's **last** path segment. For
    // `crate::id_newtype!(Foo);` that character is `:`, which is none of `;`
    // `{` `}` or the start of the file, so the refusal returned null and the
    // file was accepted — seven characters between caught and blind, on a
    // spelling this repository already writes sixty-four times. Both
    // adversaries landed exactly this, in two different files.
    const known = '\n#[derive(Debug, Clone, Serialize)]\npub struct Known {\n    pub a: String,\n}\n';
    const refused = [
      'id_newtype!(Row);',
      'crate::id_newtype!(Row);',
      'self::id_newtype!(Row);',
      'super::id_newtype!(Row);',
      '::vela_store::id_newtype!(Row);',
      'bitflags::bitflags! { pub struct F: u8 { const A = 1; } }',
      'std::include!("wire.rs");',
      // Legal Rust that rustfmt would reflow, and a second door through the
      // same refusal: the previous version decided the macro's identity by
      // whether the `!` was adjacent to the word, so a space flushed the word
      // and the `!` arrived with nothing to attach to.
      'id_newtype !(Row);',
      'crate::id_newtype !(Row);',
      // An invocation under its own attributes. This is the case the walk back
      // over `[…]` and `(…)` groups inside `atItemStart` exists for, and it had
      // no fixture: with that branch deleted the line below scans clean.
      '#[cfg(feature = "audit")]\ncrate::id_newtype!(Row);',
    ];
    for (const line of refused) {
      expect(() => scanSerialisable(line + known, 'fixture.rs'), line).toThrow(
        /where an item can be declared/,
      );
    }
    // The negative control, which is what keeps the refusal from being a
    // refusal of every file: an invocation in expression position is not one at
    // item position, and all four of these are live in the scanned files.
    const expressions = [
      'let mut v = vec![1, 2];',
      'if matches!(x, Some(_)) { }',
      'if cfg!(windows) { }',
      'let j = serde_json::json!({ "a": 1 });',
      'if a != b { }',
      'let _ = !(A && B);',
    ];
    for (const body of expressions) {
      const fixture = `pub fn f() {\n    ${body}\n}\n${known}`;
      expect(scanSerialisable(fixture, 'fixture.rs').map(qualified), body).toEqual([
        'fixture.rs::Known',
      ]);
    }
    // And a negation at item position, where there is no `mod` frame to hide
    // behind: still not a macro, because nothing but a `::`-joined path may
    // precede the `!`.
    const negated = `pub const X: bool = !(true && false);\n${known}`;
    expect(scanSerialisable(negated, 'fixture.rs').map(qualified)).toEqual(['fixture.rs::Known']);
  });

  it('refuses a body line whose angle brackets pair up without being brackets', () => {
    // The mirror image of the unpaired case, and the one the arithmetic could
    // not see: two comparisons on one line **cancel**. `topLevelParts` set
    // `angleBalanced` false only when the counts failed to cancel, so
    // `data: [u8; A < B as usize], secret_path: String, tail: [u8; C > D as
    // usize]` balanced its counts while the commas between them sat at a depth
    // that never returned to zero — the fields between them dropped without a
    // word, on the live paired `ContentPart`. An angle group may not straddle a
    // bracket group, and that is what is checked now.
    const member = [
      '#[derive(Serialize)]',
      'pub struct CancellingComparisons {',
      '    pub a: [u8; A < B as usize], pub secret: String, pub c: [u8; C > D as usize],',
      '}',
      '',
    ].join('\n');
    expect(() => parseRustItem(member, 'struct', 'CancellingComparisons')).toThrow(
      /does not pair its `<` with a `>`/,
    );
    // The same shape with the operators written tight against their operands,
    // which is the fixture the **straddle** test alone catches: `N<M` puts the
    // `<` against an identifier, so the type-position test below is satisfied
    // and only the bracket boundary can say the `<` was not a bracket.
    // Measured rather than assumed — with the straddle test removed and the
    // other two left in place, the fixture above stays red and this one goes
    // green, which is how a second test in one place turns out to be guarding
    // nothing.
    const tight = member.replace(
      '    pub a: [u8; A < B as usize], pub secret: String, pub c: [u8; C > D as usize],',
      '    pub a: [u8; N<M as usize], pub secret: String, pub c: [u8; P>Q as usize],',
    );
    expect(() => parseRustItem(tight, 'struct', 'CancellingComparisons')).toThrow(
      /does not pair its `<` with a `>`/,
    );
    const variant = [
      '#[derive(Serialize)]',
      '#[serde(tag = "kind", rename_all = "camelCase")]',
      '#[serde(rename_all_fields = "camelCase")]',
      'pub enum CancellingVariant {',
      '    Image { mime_type: String, data: [u8; A < B as usize], secret_path: String, tail: [u8; C > D as usize] },',
      '}',
      '',
    ].join('\n');
    expect(() => parseRustItem(variant, 'enum', 'CancellingVariant')).toThrow(
      /does not pair its `<` with a `>`/,
    );
    // The control, and it is the part that decides whether this refusal is
    // usable: real type syntax nests brackets inside angle groups and angle
    // groups inside brackets all the time, and none of it may be refused.
    const ordinary = [
      '#[derive(Serialize)]',
      'pub struct OrdinaryNesting {',
      '    pub a: [Vec<u8>; 4],',
      '    pub b: Vec<[u8; 4]>,',
      '    pub c: HashMap<String, Vec<Option<u8>>>,',
      '    pub d: fn(&str) -> bool,',
      '}',
      '',
    ].join('\n');
    expect(parseRustItem(ordinary, 'struct', 'OrdinaryNesting').members).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    // The shape the straddle test alone still missed, because it only inspects
    // brackets: no bracket at all, counts that cancel, and both separator
    // commas sitting at a depth that never returns to zero. A `<` that opens a
    // generic list is written against what it qualifies; one that is not is a
    // comparison or a qualified path, and this reader can place neither.
    const bare = [
      '#[derive(Serialize)]',
      'pub struct NoBracketAtAll {',
      '    pub a: A < B, pub secret: String, pub c: D > E,',
      '}',
      '',
    ].join('\n');
    expect(() => parseRustItem(bare, 'struct', 'NoBracketAtAll')).toThrow(
      /does not pair its `<` with a `>`/,
    );
    // What that costs, asserted rather than left to be discovered: a qualified
    // path type is refused too. It is legal Rust, it is in none of the fifteen
    // files these guards read, and a refusal is the direction that cannot
    // report a key as absent.
    const qualifiedPath = [
      '#[derive(Serialize)]',
      'pub struct QualifiedPath {',
      '    pub a: <T as Trait>::Output,',
      '}',
      '',
    ].join('\n');
    expect(() => parseRustItem(qualifiedPath, 'struct', 'QualifiedPath')).toThrow(
      /does not pair its `<` with a `>`/,
    );
  });

  it('reads a one-line struct variant through its comments, not around them', () => {
    // The single structural read in the parser that ran on the raw line rather
    // than the blanked one, which made the sentence the file states about
    // itself — *every structural read runs on the output, so that a brace
    // inside a doc comment cannot move it* — false about exactly the reader
    // the round before this one was about. A seven-character block comment
    // closed the variant early and dropped a live field in silence.
    const hidden = [
      '#[derive(Serialize)]',
      '#[serde(tag = "kind", rename_all = "camelCase")]',
      '#[serde(rename_all_fields = "camelCase")]',
      'pub enum CommentedVariant {',
      '    Image { mime_type: String, data: Vec<u8> /* } */, secret_path: String },',
      '}',
      '',
    ].join('\n');
    expect(payloadWireKeys(parseRustItem(hidden, 'enum', 'CommentedVariant'))).toEqual({
      image: ['data', 'mimeType', 'secretPath'],
    });
    // The other direction, which is the reachable half: an ordinary trailing
    // comment that happens to mention a shape in braces used to be read as
    // code, and invented a payload key on a variant with no body at all — or,
    // one word different, raised a refusal out of nothing but prose.
    const commented = hidden.replace(
      '    Image { mime_type: String, data: Vec<u8> /* } */, secret_path: String },',
      ['    Text, // { ghost: String }', '    Blob, // shaped like { blob }'].join('\n'),
    );
    const item = parseRustItem(commented, 'enum', 'CommentedVariant');
    expect(item.members).toEqual(['Text', 'Blob']);
    expect(payloadWireKeys(item)).toEqual({});
  });

  it('blanks the longest char literal Rust can spell', () => {
    // `CHAR_LITERAL_WINDOW` is the length of `'\u{10FFFF}'` and the lexer only
    // tries the char-literal case inside it, falling through to treating `'` as
    // a lifetime. That bound was the number 12 with a comment saying where 12
    // came from, and nothing else: narrowing it to 11 — one byte short of the
    // literal the comment names — moved no assertion in the repository, and
    // neither did 4, and neither did 3, at which point every escaped form stops
    // being lexed as a literal at all. `document.rs`, which the skills guard
    // scans, carries six distinct escaped char literals, and at a window of 3
    // none of the six is lexed as one.
    //
    // The bound is derived from the literal now, and this is what holds the
    // pair together. It asserts the blanking directly because the value is not
    // observable through the rest of the module: the only twelve-byte literal
    // is `'\u{HHHHHH}'`, whose bytes are brace-balanced and quote-free, so
    // leaving it unblanked shifts no index any caller reads. Said plainly
    // rather than left as a bound with a comment for a guard.
    const longest = "pub const MAX: char = '\\u{10FFFF}';";
    expect(withoutCommentsOrStrings(longest)).toBe('pub const MAX: char =             ;');
    // Every shorter escaped form, and the bare one, blanked to spaces of the
    // same width; and a lifetime left alone, which is the other thing a quote
    // can be.
    for (const literal of ["'a'", "'\\t'", "'\\\\'", "'\\x22'", "'\\u{7B}'", "'\\u{feff}'"]) {
      const line = `pub const C: char = ${literal};`;
      expect(withoutCommentsOrStrings(line), literal).toBe(
        `pub const C: char = ${' '.repeat(literal.length)};`,
      );
    }
    expect(withoutCommentsOrStrings("pub fn f<'a>(x: &'a str) {}")).toBe(
      "pub fn f<'a>(x: &'a str) {}",
    );
  });

  it('keeps the keys its deserialisation-only classifications say it keeps', () => {
    // `FIELD_KEYS` and `CONTAINER_KEYS` are classifications, and the docblock
    // over `FIELD_KEYS` says in as many words that "a classification with no
    // reader is a classification that can be wrong without anything failing,
    // which is how this one stayed wrong". Three of the five field entries and
    // one of the five container entries had no reader when that sentence was
    // written: `alias`, `borrow` and `deny_unknown_fields` appear nowhere in
    // the three crates these guards read, so mis-valuing any of them —
    // `['alias', 'drops-the-key']` — failed nothing anywhere. Here they have
    // one.
    const field = (attribute: string): string =>
      [
        '#[derive(Serialize)]',
        '#[serde(rename_all = "camelCase")]',
        'pub struct FixtureStruct {',
        `    #[serde(${attribute})]`,
        '    pub answered_by: String,',
        '    pub other_one: String,',
        '}',
        '',
      ].join('\n');
    for (const attribute of ['alias = "answeredby"', 'borrow', 'default']) {
      const item = parseRustItem(field(attribute), 'struct', 'FixtureStruct');
      expect(wireNames(item), attribute).toEqual(['answeredBy', 'otherOne']);
      expect(item.conditionalFields, attribute).toEqual([]);
    }
    // The two that are not deserialisation-only, as the controls: one removes
    // the member and one makes it conditional, so the three above are asserted
    // against something rather than against nothing.
    expect(
      parseRustItem(field('skip'), 'struct', 'FixtureStruct').members,
    ).toEqual(['other_one']);
    expect(
      parseRustItem(field('skip_serializing_if = "String::is_empty"'), 'struct', 'FixtureStruct')
        .conditionalFields,
    ).toEqual(['answered_by']);
    // The container half. Both of these emit no key, and neither had a fixture.
    const container = (attribute: string): string =>
      [
        '#[derive(Serialize)]',
        `#[serde(rename_all = "camelCase", ${attribute})]`,
        'pub struct FixtureStruct {',
        '    pub answered_by: String,',
        '}',
        '',
      ].join('\n');
    for (const attribute of ['deny_unknown_fields', 'default']) {
      expect(wireNames(parseRustItem(container(attribute), 'struct', 'FixtureStruct')), attribute)
        .toEqual(['answeredBy']);
    }
    // And one inert non-serde attribute per shape, including `must_use`, which
    // is on `INERT_ATTRIBUTES` and was likewise pinned by nothing.
    for (const attribute of ['must_use', 'deprecated', 'repr(u8)', 'inline']) {
      const fixture = [
        `#[${attribute}]`,
        '#[derive(Serialize)]',
        '#[serde(rename_all = "camelCase")]',
        'pub struct FixtureStruct {',
        '    pub answered_by: String,',
        '}',
        '',
      ].join('\n');
      expect(wireNames(parseRustItem(fixture, 'struct', 'FixtureStruct')), attribute).toEqual([
        'answeredBy',
      ]);
    }
  });

  it('finds a declaration that shares its line with its own attributes', () => {
    // `DECLARATION` was anchored `^[ \t]*`, which said *a declaration begins
    // its own line* — rustfmt's habit, not Rust's rule. The one-line spelling
    // was invisible to `declarationsIn`, therefore to `scanSerialisable`,
    // therefore to every inventory equality and every register, with the whole
    // suite green. Two newlines were the whole difference between caught and
    // blind.
    const oneLine =
      '#[derive(Debug, Clone, Serialize)] #[serde(rename_all = "camelCase")] ' +
      'pub struct StoreAuditRow { pub taken_at: String, pub secret_path: String }\n';
    expect(scanSerialisable(oneLine, 'fixture.rs').map(qualified)).toEqual([
      'fixture.rs::StoreAuditRow',
    ]);
    // And the attributes on that line are inside the region, not outside it:
    // `attributeRegionBefore` now runs from the declaration's own position.
    // Reading the wire keys is what proves the `rename_all` was seen: the two
    // members are spelled snake_case in the fixture, and only a `rename_all`
    // that was actually read turns them into the camelCase keys asserted below.
    expect(() => parseRustItem(oneLine, 'struct', 'StoreAuditRow')).toThrow(
      /puts more than one member on one line/,
    );
    const spaced = oneLine.replace('String, pub secret_path', 'String,\n    pub secret_path');
    expect(wireNames(parseRustItem(spaced, 'struct', 'StoreAuditRow'))).toEqual([
      'takenAt',
      'secretPath',
    ]);
  });

  it('reads a declaration broken between its keyword and its name', () => {
    // The other member of the same family: `(enum|struct)[ \t]+` could not span
    // a newline, so a declaration wrapped there scanned to nothing at all.
    const fixture = ['#[derive(Serialize)]', 'pub struct', 'Wrapped {', '    pub a: String,', '}', ''].join(
      '\n',
    );
    expect(scanSerialisable(fixture, 'fixture.rs').map(qualified)).toEqual(['fixture.rs::Wrapped']);
  });

  it('reaches the rustfmt::skip refusal on a one-line declaration', () => {
    // `rustfmt::skip` is deliberately absent from `INERT_ATTRIBUTES`, because
    // an item exempted from the formatter is an item whose layout this parser
    // may no longer assume. That refusal lives in `parseRustItem` and fires
    // only once the declaration has been found, so under the line anchor it was
    // unreachable in exactly the case it was written for: the attribute and the
    // item on one line were found by nothing, so nothing refused them either.
    const fixture =
      '#[rustfmt::skip] #[derive(Serialize)] pub struct Skipped { pub a: String }\n';
    expect(scanSerialisable(fixture, 'fixture.rs').map(qualified)).toEqual([
      'fixture.rs::Skipped',
    ]);
    expect(() => parseRustItem(fixture, 'struct', 'Skipped')).toThrow(/rustfmt::skip/);
  });

  it('refuses a file that declares its types through a macro', () => {
    // `declarationsIn` reads the file as written; rustc reads it expanded. A
    // `macro_rules!` body can carry the whole declaration — this repository
    // does exactly that in `src-tauri/crates/vela-store/src/model.rs`, whose
    // `id_newtype!` emits a `#[derive(…, Serialize, Deserialize)]
    // #[serde(transparent)] pub struct $name(String);` and is invoked six
    // times. The name alphabet here is `[A-Za-z][A-Za-z0-9_]*`, so `pub struct
    // $name` matches nothing and the invocation's argument is not a declaration
    // either: the type is in the crate and on no inventory.
    const fixture = [
      'macro_rules! audit_row {',
      '    ($name:ident) => {',
      '        #[derive(Debug, Clone, Serialize)]',
      '        #[serde(rename_all = "camelCase")]',
      '        pub struct $name {',
      '            pub taken_at: String,',
      '        }',
      '    };',
      '}',
      '',
      'audit_row!(StoreAuditRow);',
      '',
    ].join('\n');
    // Named out loud: without the refusal this fixture scans to nothing, which
    // is the failure, not a pass.
    expect(() => scanSerialisable(fixture, 'fixture.rs')).toThrow(
      /where an item can be declared/,
    );
    expect(() => scanSerialisable(fixture, 'fixture.rs')).toThrow(/macro_rules! audit_row/);
  });

  it('refuses a file that splices another file in with include!', () => {
    // `#[path = "…"]` is refused because the set of files a walk finds is not
    // the set of modules a crate has. `include!` does the same thing without
    // being an attribute, so the `#[path]` refusal never sees it. The spelling
    // below is the build-script codegen one, and it is the reachable form here
    // because `src-tauri/build.rs` already exists — it emits cargo directives
    // today and generates no Rust, so this is a plausible next commit rather
    // than a present miss.
    const fixture = [
      'include!(concat!(env!("OUT_DIR"), "/wire.rs"));',
      '',
      '#[derive(Serialize)]',
      'pub struct Kept {',
      '    pub a: String,',
      '}',
      '',
    ].join('\n');
    expect(() => scanSerialisable(fixture, 'lib.rs')).toThrow(/where an item can be declared/);
  });

  it('does not call an expression-position macro an item-position one', () => {
    // The control, and it is the one that decides whether the refusal above is
    // usable: `vec!`, `matches!` and `cfg!` are all live in the files these
    // guards scan. Each sits in expression position, in a function body, or
    // both, and none of them may turn a real file into a refusal.
    const fixture = [
      'pub const MAX: usize = if cfg!(windows) { 260 } else { 4096 };',
      '',
      '#[derive(Serialize)]',
      'pub struct Kept {',
      '    pub a: String,',
      '}',
      '',
      'impl Kept {',
      '    fn check(&self) -> bool {',
      '        let vocabulary = vec![1, 2, 3];',
      '        println!("{}", vocabulary.len());',
      '        matches!(self.a.as_str(), "x")',
      '    }',
      '}',
      '',
      '#[cfg(test)]',
      'mod tests {',
      '    #[test]',
      '    fn works() {',
      '        assert!(true);',
      '    }',
      '}',
      '',
    ].join('\n');
    expect(scanSerialisable(fixture, 'fixture.rs').map(qualified)).toEqual(['fixture.rs::Kept']);
    // And a macro invocation inside an inline `mod` is still item position.
    const inModule = [
      'pub mod generated {',
      '    id_newtype!(ProjectId, "prj", "project");',
      '}',
      '',
    ].join('\n');
    expect(() => scanSerialisable(inModule, 'fixture.rs')).toThrow(
      /where an item can be declared/,
    );
  });

  it('blanks a raw C string literal, which is a prefix the lexer did not have', () => {
    // The raw-literal prefix test read `b?r` only. `cr"…"` — a C string
    // literal, stable since Rust 1.77 — fell through to escape rules, so a
    // literal whose contents end in a backslash never closed. This is the same
    // failure as the `r"\\?\UNC\"` case one prefix along, and it lands on the
    // throw rather than on a silent erase, which is the direction the blanker
    // promises.
    const fixture = [
      'pub const UNC: &core::ffi::CStr = cr"\\\\?\\UNC\\";',
      '',
      '#[derive(Serialize)]',
      'pub struct AfterTheLiteral {',
      '    pub a: String,',
      '}',
      '',
    ].join('\n');
    expect(scanSerialisable(fixture, 'fixture.rs').map(qualified)).toEqual([
      'fixture.rs::AfterTheLiteral',
    ]);
    // The plain `c"…"` form was already handled — its `c` is an ordinary
    // identifier byte and the `"` case takes it from there — and the fenced
    // form is the same case as `r#"…"#`.
    const fenced = fixture.replace('cr"\\\\?\\UNC\\"', 'cr#"a "quoted" thing"#');
    expect(scanSerialisable(fenced, 'fixture.rs').map(qualified)).toEqual([
      'fixture.rs::AfterTheLiteral',
    ]);
  });

  it('keeps a braced item whose where clause hides a semicolon', () => {
    // `itemForm` tracked only `<` and `>`, so the `;` inside the const-generic
    // bound `[T; N]` read at depth zero, the item came back a unit, and a unit
    // item leaves the inventory silently — which is the one failure an inventory
    // exists to prevent. Its own doc comment said exactly that, about a `where`
    // clause, one bound earlier.
    const fixture = [
      '#[derive(Serialize)]',
      '#[serde(rename_all = "camelCase")]',
      'pub struct FixedPage<T, const N: usize>',
      'where',
      '    [T; N]: Serialize,',
      '{',
      '    pub answered_by: String,',
      '}',
      '',
    ].join('\n');
    expect(scanSerialisable(fixture, 'fixture.rs').map(qualified)).toEqual([
      'fixture.rs::FixedPage',
    ]);
    expect(wireNames(parseRustItem(fixture, 'struct', 'FixedPage'))).toEqual(['answeredBy']);
  });

  it('keeps a braced item whose where clause hides a parenthesis', () => {
    const fixture = [
      '#[derive(Serialize)]',
      'pub struct Filtered<F>',
      'where',
      '    F: Fn(&str) -> bool,',
      '{',
      '    pub answered_by: String,',
      '}',
      '',
    ].join('\n');
    expect(scanSerialisable(fixture, 'fixture.rs').map(qualified)).toEqual([
      'fixture.rs::Filtered',
    ]);
  });

  it('still calls a tuple struct a tuple struct', () => {
    // The control for the two above. Widening the form scan must not turn every
    // item into a braced one, or the pairing reader is handed items it cannot
    // read as members.
    const fixture = [
      '#[derive(Serialize)]',
      'pub struct CorrelationId(u64);',
      '',
      '#[derive(Serialize)]',
      'pub struct Braced {',
      '    pub answered_by: String,',
      '}',
      '',
    ].join('\n');
    expect(scanSerialisable(fixture, 'fixture.rs')).toEqual([
      { file: 'fixture.rs', keyword: 'struct', rust: 'CorrelationId', form: 'tuple' },
      { file: 'fixture.rs', keyword: 'struct', rust: 'Braced', form: 'braced' },
    ]);
  });

  it('puts a Serialize-deriving tuple struct on the inventory rather than out of sight', () => {
    // The round-4 disclosure, closed. `scanSerialisable` used to `continue`
    // past a non-braced item **before** it asked whether the item derived or
    // implemented `Serialize`, so a tuple struct on the wire was not on any
    // inventory and no register entry was owed for it. Three of them are live
    // in `diagnostic.rs`, which this guard reads, and the assertion named
    // `accounts for every serialisable type in the files it reads` listed none
    // of the three while calling itself complete.
    const scanned = serialisableItems('diagnostic.rs');
    expect(scanned.filter((item) => item.form === 'tuple').map(qualified)).toEqual([
      'diagnostic.rs::ConfiguredModelId',
      'diagnostic.rs::CorrelationId',
      'diagnostic.rs::HarmCategories',
    ]);
  });

  it('reaches a hand-written Serialize impl on a tuple struct', () => {
    // The half of the same defect that made `IMPL_SERIALIZE` unreachable. The
    // `continue` on form sat above the `manual` test, so the one item shape
    // most likely to carry a hand-written impl — a newtype whose whole reason
    // to exist is a wire form other than its inner value's — was the one shape
    // the manual-impl scan could never see. Two keys crossed under a type on
    // no inventory.
    const fixture = [
      'pub struct StoreAudit(String, String);',
      '',
      'impl Serialize for StoreAudit {',
      '    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {',
      '        use serde::ser::SerializeStruct;',
      '        let mut row = s.serialize_struct("StoreAudit", 2)?;',
      '        row.serialize_field("takenAt", &self.0)?;',
      '        row.serialize_field("secretPath", &self.1)?;',
      '        row.end()',
      '    }',
      '}',
      '',
    ].join('\n');
    expect(scanSerialisable(fixture, 'fixture.rs')).toEqual([
      { file: 'fixture.rs', keyword: 'struct', rust: 'StoreAudit', form: 'tuple' },
    ]);
  });

  it('refuses a file that imports Serialize under another name', () => {
    // `scanSerialisable` asks whether a derive list contains the token
    // `Serialize`, which is a question about text. `use serde::Serialize as
    // Wire;` is ordinary Rust, answers no, and leaves a live serialisable type
    // outside the equality that exists to make the unaccounted count zero.
    // Following the alias would be an import resolver; refusing is not.
    const fixture = [
      'use serde::Serialize as Wire;',
      '',
      '#[derive(Debug, Clone, Wire)]',
      'pub struct RenamedDerive {',
      '    pub answered_by: String,',
      '}',
      '',
    ].join('\n');
    expect(() => scanSerialisable(fixture, 'fixture.rs')).toThrow(
      /imports `Serialize` under another name/,
    );
  });

  it('refuses a file that attaches a module from outside the directory walked', () => {
    // Every guard here finds its files by walking a directory. `#[path]` says
    // where a module's source is without that source having to be under it, so a
    // live serialisable type can sit one directory up and outside every
    // inventory in the repository while `reads the whole crate` stays green —
    // that assertion compares two values the walk moves together.
    const fixture = ['#[path = "../audit.rs"]', 'pub mod audit;', ''].join('\n');
    expect(() => scanSerialisable(fixture, 'lib.rs')).toThrow(/A `#\[path\]` attribute/);
  });

  it('refuses to read a type name that is declared twice in one file', () => {
    // The parser resolves a *name*; Rust resolves a *path*. Handed a file and a
    // spelling it used to return the first textual match, with no module path
    // and no check that the thing it read was the thing the inventory counted —
    // so an ordinary migration module could stand in for the type on the wire,
    // and the pairing reported agreement about a type nobody serialises. Every
    // other assertion here is downstream of this resolution.
    const fixture = [
      'pub mod legacy {',
      '    #[derive(Debug, Clone, Default)]',
      '    pub struct Resources {',
      '        pub scripts: Vec<String>,',
      '    }',
      '}',
      '',
      '#[derive(Serialize)]',
      '#[serde(rename_all = "PascalCase")]',
      'pub struct Resources {',
      '    pub scripts: Vec<String>,',
      '}',
      '',
    ].join('\n');
    expect(() => parseRustItem(fixture, 'struct', 'Resources', 'fixture.rs')).toThrow(
      /declares `Resources` 2 times/,
    );
  });

  it('reports a skip_serializing_if field as conditional, not as unconditional', () => {
    // The allow-list recorded this attribute as leaving the key alone. It does
    // not: the key crosses when the predicate is false and is absent when it is
    // true. A wrong entry inside an allow-list is the one thing the
    // have-I-written-this-down posture cannot find, because it only ever asks
    // whether the key is listed.
    const fixture = [
      '#[derive(Serialize)]',
      '#[serde(rename_all = "camelCase")]',
      'pub struct Conditional {',
      '    pub always_here: String,',
      '    #[serde(skip_serializing_if = "Option::is_none", default)]',
      '    pub sometimes_here: Option<u16>,',
      '}',
      '',
    ].join('\n');
    const item = parseRustItem(fixture, 'struct', 'Conditional');
    expect(item.members).toEqual(['always_here', 'sometimes_here']);
    expect(item.conditionalFields).toEqual(['sometimes_here']);
    expect(conditionalWireKeys(item)).toEqual(['sometimesHere']);
  });

  it('scans the same items out of a source and its opposite-ending twin', () => {
    const lf = (SOURCES['diagnostic.rs'] ?? '').replace(/\r\n/g, '\n');
    const crlf = lf.replace(/\n/g, '\r\n');
    const fromLf = scanSerialisable(lf, 'diagnostic.rs').map(qualified);
    expect(fromLf.length, 'scanned nothing out of diagnostic.rs').toBeGreaterThan(1);
    expect(scanSerialisable(crlf, 'diagnostic.rs').map(qualified)).toEqual(fromLf);
  });
});
