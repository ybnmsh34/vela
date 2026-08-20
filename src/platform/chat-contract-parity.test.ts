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
 * the container's `rename_all`, and the internal tag key. Where an attribute
 * severs the identifier from the key — a per-field `rename`, a `flatten` — the
 * parser **throws** rather than compare an identifier it knows is not the key.
 * Refusing is the posture: a guard that reports agreement it never checked is
 * worse than an absent one, because the absent one does not get believed.
 *
 * Two surfaces remain outside the comparison, stated rather than implied. The
 * payload fields of struct variants (`rename_all_fields`, `ContentPart::Image`
 * carrying `mimeType`) are not members of the enum and are not read here. And
 * nothing in TypeScript observes actual bytes; only the Rust side does, in
 * `model.rs`'s `provenance_crosses_the_bridge_under_the_keys_the_renderer_reads`,
 * which serialises a `ChatResponse` and therefore speaks for `answeredBy` and
 * `AnswerProvenance` and for nothing else.
 *
 * ## What this does not claim
 *
 * Name parity, not semantic parity: that `ContentPart` has an `image` arm on
 * both sides, not that both encode the bytes the same way. Where the shapes
 * deliberately differ — `ContentPartInput.image.data` is base64 where the
 * provider model is a byte array, `CapabilityFinding` drops the adapter's
 * free-text `note` — the difference lives in `src-tauri/src/ipc/`, which is a
 * different boundary with its own tests, and those types are not listed here.
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

/* -------------------------------------------------------------------------- */
/* the Rust half — read off disk                                              */
/* -------------------------------------------------------------------------- */

const CRATE = join(process.cwd(), 'src-tauri', 'crates', 'vela-providers', 'src');

const SOURCES: Readonly<Record<string, string>> = Object.fromEntries(
  ['model.rs', 'event.rs', 'error.rs', 'capability.rs', 'diagnostic.rs'].map((file) => [
    file,
    readFileSync(join(CRATE, file), 'utf8'),
  ]),
);

/**
 * Every `rename_all` spelling serde implements, plus the absence of one.
 *
 * The list is closed deliberately, and {@link parseRustItem} **throws** on a
 * value outside it rather than falling through to `none`. Those are not the
 * same answer. `none` says *serde applied no rule*; an unrecognised value says
 * *serde applied a rule I did not read*, and reporting the second as the first
 * is the guard asserting something it never checked.
 *
 * It is not hypothetical and it is not exotic. `Diagnosis`'s five fields are
 * all single lowercase words, so `rename_all = "camelCase"` is a no-op on it
 * and `rename_all = "PascalCase"` changes every key it puts on the wire while
 * changing no identifier in the file. Under the old two-literal regex
 * (`camelCase|snake_case`, anything else falls to `none`) that edit was green.
 * This tree already spells a third rule on a live IPC type —
 * `src-tauri/src/ipc/error.rs` carries `rename_all = "SCREAMING_SNAKE_CASE"` —
 * so the vocabulary being wider than two is demonstrated, not suspected.
 */
type RenameRule =
  | 'lowercase'
  | 'UPPERCASE'
  | 'PascalCase'
  | 'camelCase'
  | 'snake_case'
  | 'SCREAMING_SNAKE_CASE'
  | 'kebab-case'
  | 'SCREAMING-KEBAB-CASE'
  | 'none';

/**
 * Closed by the compiler against {@link RenameRule}: a rule added to the type
 * and not to this list stops the file compiling, which is the same device
 * `everyVariantOf` performs for the wire lists above.
 */
const RENAME_RULES = everyVariantOf<Exclude<RenameRule, 'none'>>()([
  'lowercase',
  'UPPERCASE',
  'PascalCase',
  'camelCase',
  'snake_case',
  'SCREAMING_SNAKE_CASE',
  'kebab-case',
  'SCREAMING-KEBAB-CASE',
]);

interface RustItem {
  /** Variant names for an enum, field names for a struct — Rust spelling. */
  readonly members: readonly string[];
  readonly renameAll: RenameRule;
  /**
   * Which of serde's two `rename_all` transformations applies. One attribute
   * name, two different functions: serde reads a variant as PascalCase and a
   * field as snake_case. A single implementation is wrong for one of them,
   * silently, and this file carried the single implementation.
   */
  readonly kind: 'variant' | 'field';
  /**
   * The internal tag key — serde's `tag = "…"` — or `null` when the item is
   * not internally tagged. A wire key that is a member of nothing, which is
   * exactly why nothing used to compare it.
   */
  readonly tag: string | null;
}

/**
 * Serde container keys this parser has read and can account for, with what
 * each does to the keys that cross the bridge.
 *
 * Anything outside this map makes {@link parseRustItem} throw. That posture —
 * *refuse to compare what I do not model* — is the point of the rewrite. The
 * failure being fixed is not "the parser got an answer wrong", it is "the
 * parser had no opinion and reported agreement anyway".
 */
const CONTAINER_KEYS: ReadonlyMap<string, string> = new Map([
  ['rename_all', 'read, and applied by wireName'],
  ['tag', 'read, and compared against the pairing'],
  [
    'rename_all_fields',
    // Renames the *payload* fields of struct variants (`mime_type` becomes
    // `mimeType` inside `ContentPart::Image`). Those names are not members of
    // the enum, so this parser never reads them and this guard never compares
    // them. Recorded here rather than silently tolerated: the gap is real, and
    // it is reported rather than papered over.
    'no effect on the member names this parser reads',
  ],
  ['deny_unknown_fields', 'deserialisation strictness only, emits no key'],
  ['default', 'deserialisation only, emits no key'],
]);

/**
 * Field keys this parser can account for. `skip` removes the member; the rest
 * leave the key on the wire under its own name. Anything else throws — most
 * pointedly `rename` and `flatten`, each of which makes the identifier a lie
 * about the key.
 */
const FIELD_KEYS: ReadonlyMap<string, 'drops-the-key' | 'keeps-the-key'> = new Map([
  ['skip', 'drops-the-key'],
  ['skip_serializing_if', 'keeps-the-key'],
  ['default', 'keeps-the-key'],
  ['alias', 'keeps-the-key'],
  ['borrow', 'keeps-the-key'],
]);

/**
 * Splits the body of one attribute argument list on its top-level commas,
 * leaving quoted values and nested parens alone. `skip_serializing_if =
 * "Option::is_none", default` is two arguments; a comma inside a string
 * literal is none of them.
 */
function splitArguments(body: string): readonly string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;
  for (const character of body) {
    if (inString) {
      current += character;
      if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * Every `#[serde(…)]` argument in a block of attribute text, as `key` to
 * `value` (`null` for a bare word such as `skip` or `transparent`).
 *
 * Reads by balanced parentheses rather than by line, because rustfmt breaks a
 * long attribute across lines — `ContentPart`'s is four — and a line-oriented
 * reader sees the first line only.
 */
function serdeArguments(attributes: string): ReadonlyMap<string, string | null> {
  const found = new Map<string, string | null>();
  const opener = '#[serde(';
  let index = attributes.indexOf(opener);
  while (index >= 0) {
    const start = index + opener.length;
    let depth = 1;
    let inString = false;
    let cursor = start;
    for (; cursor < attributes.length && depth > 0; cursor += 1) {
      const character = attributes[cursor];
      if (inString) {
        if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '(') depth += 1;
      else if (character === ')') depth -= 1;
    }
    if (depth !== 0) throw new Error('chat-contract-parity: unterminated `#[serde(`');
    for (const argument of splitArguments(attributes.slice(start, cursor - 1))) {
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(argument);
      if (assignment) {
        const key = assignment[1] as string;
        const value = (assignment[2] as string).trim();
        found.set(key, value.startsWith('"') ? value.slice(1, -1) : value);
      } else {
        found.set(argument, null);
      }
    }
    index = attributes.indexOf(opener, cursor);
  }
  return found;
}

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

/**
 * The same read, against source text rather than a filename, so the line-ending
 * cases below can be exercised on a fixture instead of on whatever `git` happens
 * to have checked out.
 */
function parseRustItem(
  source: string,
  keyword: 'enum' | 'struct',
  name: string,
  file = '<fixture>',
): RustItem {
  const declaration = new RegExp(`^pub ${keyword} ${name}\\b[^{\\r\\n]*\\{$`, 'm');
  const at = source.search(declaration);
  if (at < 0) {
    throw new Error(`chat-contract-parity: no \`pub ${keyword} ${name}\` in ${file}`);
  }

  // The attribute block sits between this item's `#[derive(…)]` and its
  // declaration, so slicing back to the last `#[derive` cannot pick up the
  // previous item's serde attribute.
  const head = source.slice(0, at);
  const derive = head.lastIndexOf('#[derive');
  const attributes = derive < 0 ? '' : head.slice(derive);
  const container = serdeArguments(attributes);
  for (const [key] of container) {
    if (!CONTAINER_KEYS.has(key)) {
      throw new Error(
        `chat-contract-parity: ${name} in ${file} carries \`#[serde(${key})]\`, which this ` +
          `parser does not model. Refusing to compare identifiers against wire keys it cannot ` +
          `predict — teach ${'CONTAINER_KEYS'} what it does to the wire, or exclude the type.`,
      );
    }
  }
  const spelled = container.get('rename_all') ?? null;
  if (spelled !== null && !(RENAME_RULES as readonly string[]).includes(spelled)) {
    throw new Error(
      `chat-contract-parity: ${name} in ${file} carries \`rename_all = "${spelled}"\`, a rule ` +
        `this parser does not implement. Reading it as "no rename" would compare the Rust ` +
        `identifiers against the TypeScript list and report agreement serde never produced.`,
    );
  }
  const renameAll: RenameRule = (spelled ?? 'none') as RenameRule;
  const kind: 'variant' | 'field' = keyword === 'enum' ? 'variant' : 'field';
  const tag = container.get('tag') ?? null;

  // Split on either terminator. `git config core.autocrlf` is `true` on Windows
  // and there is no `.gitattributes`, so every line of these files ends `\r\n`
  // in a Windows checkout — `model.rs` measures 798 CRLF and 0 bare LF. Splitting
  // on `'\n'` alone left a `'\r'` on the end of every line, so the column-0 `}`
  // was never found and 28 of this file's 31 cases threw `unterminated`. The
  // declaration regex above matched anyway, which is why the symptom pointed
  // here rather than at the search: JavaScript counts `\r` as a line terminator
  // for `$` under `m`, so `\{$` was satisfied by `{\r`. The guarantee
  // `contract.ts` advertises therefore did not execute on the only machine that
  // builds the product. `the parity parser itself` now pins both endings.
  const lines = source.slice(at).split(/\r?\n/).slice(1);
  const end = lines.indexOf('}');
  if (end < 0) throw new Error(`chat-contract-parity: unterminated ${name} in ${file}`);

  const members: string[] = [];
  let skipNext = false;
  for (const line of lines.slice(0, end)) {
    const text = line.trim();
    if (text.startsWith('//')) continue;
    if (text.startsWith('#[')) {
      // `#[serde(skip)]` — off the wire entirely, so the renderer must not
      // carry it. `skip_serializing_if` is a different attribute: still a
      // field, merely optional, so it must not drop anything.
      //
      // Anything outside `FIELD_KEYS` throws. `rename` and `flatten` are the
      // reason: both sever the identifier from the key, so a parser that reads
      // the identifier and skips the attribute reports a key that provably is
      // not on the wire. Refusing is not a second serde implementation — it is
      // this file declining to answer a question it cannot answer.
      for (const [key] of serdeArguments(text)) {
        const known = FIELD_KEYS.get(key);
        if (known === undefined) {
          throw new Error(
            `chat-contract-parity: a field of ${name} in ${file} carries ` +
              `\`#[serde(${key})]\`, which this parser does not model. The identifier is no ` +
              `longer evidence of the wire key; assert the bytes on the Rust side instead.`,
          );
        }
        if (known === 'drops-the-key') skipNext = true;
      }
      continue;
    }
    const member =
      keyword === 'enum'
        ? /^([A-Z][A-Za-z0-9]*)\s*(?:[,{(]|$)/.exec(text)
        : /^(?:pub(?:\([a-z]+\))?\s+)?([a-z_][a-z0-9_]*)\s*:/.exec(text);
    const captured = member?.[1];
    if (captured === undefined) continue;
    if (skipNext) {
      skipNext = false;
      continue;
    }
    members.push(captured);
  }
  return { members, renameAll, kind, tag };
}

/**
 * Applies the item's own `rename_all`, exactly as serde does — **which is two
 * different transformations under one attribute name**, and that is the trap.
 *
 * Serde reads a variant as PascalCase and a field as snake_case, so a single
 * `rename_all = "camelCase"` means *lowercase the first character* on an enum
 * and *fold each underscore into the letter after it* on a struct. This file
 * carried one implementation for both — a word split on the lowercase-to-
 * uppercase boundary — and got away with it because the two answers agree on
 * every member currently in the tree. They stop agreeing the moment two
 * capitals meet: serde renames `HTTPError` to `hTTPError` under camelCase and
 * to `h_t_t_p_error` under snake_case, where the word split answers
 * `httperror` for both and reports this contract wrong about a name the host
 * really sends. `src/platform/skill-store-parity.test.ts` and
 * `src/platform/project-host-parity.test.ts` already carry the two-rule
 * version — their own first drafts failed on exactly this — and this file was
 * the one left behind.
 *
 * Ported arm for arm from serde_derive's own case conversion, which is where
 * that split lives: one function for a variant, a different one for a field.
 */
function wireName(rustName: string, rule: RenameRule, kind: 'variant' | 'field'): string {
  if (rule === 'none') return rustName;
  if (kind === 'variant') {
    // Input is PascalCase.
    const snake = rustName
      .split('')
      .map((character, index) =>
        character >= 'A' && character <= 'Z'
          ? `${index === 0 ? '' : '_'}${character.toLowerCase()}`
          : character,
      )
      .join('');
    switch (rule) {
      case 'lowercase':
        return rustName.toLowerCase();
      case 'UPPERCASE':
        return rustName.toUpperCase();
      case 'PascalCase':
        return rustName;
      case 'camelCase':
        return rustName.charAt(0).toLowerCase() + rustName.slice(1);
      case 'snake_case':
        return snake;
      case 'SCREAMING_SNAKE_CASE':
        return snake.toUpperCase();
      case 'kebab-case':
        return snake.replace(/_/g, '-');
      case 'SCREAMING-KEBAB-CASE':
        return snake.toUpperCase().replace(/_/g, '-');
    }
  }
  // Input is snake_case.
  const pascal = rustName.replace(/(^|_)([a-z0-9])/g, (_, __, after: string) =>
    after.toUpperCase(),
  );
  switch (rule) {
    case 'lowercase':
    case 'snake_case':
      return rustName;
    case 'UPPERCASE':
    case 'SCREAMING_SNAKE_CASE':
      return rustName.toUpperCase();
    case 'PascalCase':
      return pascal;
    case 'camelCase':
      return pascal.charAt(0).toLowerCase() + pascal.slice(1);
    case 'kebab-case':
      return rustName.replace(/_/g, '-');
    case 'SCREAMING-KEBAB-CASE':
      return rustName.toUpperCase().replace(/_/g, '-');
  }
}

function wireNames(item: RustItem): readonly string[] {
  return item.members.map((member) => wireName(member, item.renameAll, item.kind));
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
}

const ENUMS: readonly Pairing[] = [
  {
    rust: 'MessageRole',
    file: 'model.rs',
    keyword: 'enum',
    ts: 'MessageRole',
    tag: null,
    listed: MESSAGE_ROLE,
  },
  {
    rust: 'StopReason',
    file: 'model.rs',
    keyword: 'enum',
    ts: 'StopReason',
    tag: null,
    listed: STOP_REASON,
  },
  {
    rust: 'ContentPart',
    file: 'model.rs',
    keyword: 'enum',
    ts: 'ContentPart',
    tag: CONTENT_PART_TAG,
    listed: CONTENT_PART,
  },
  {
    rust: 'MalformedToolCall',
    file: 'model.rs',
    keyword: 'enum',
    ts: 'MalformedToolCallReason',
    tag: null,
    listed: MALFORMED_TOOL_CALL,
  },
  {
    rust: 'ToolCallOutcome',
    file: 'model.rs',
    keyword: 'enum',
    ts: 'ToolCallOutcome',
    tag: TOOL_CALL_OUTCOME_TAG,
    listed: TOOL_CALL_OUTCOME,
  },
  {
    rust: 'Degradation',
    file: 'model.rs',
    keyword: 'enum',
    ts: 'Degradation',
    tag: DEGRADATION_TAG,
    listed: DEGRADATION,
  },
  {
    rust: 'ContextStrategy',
    file: 'model.rs',
    keyword: 'enum',
    ts: 'ContextStrategy',
    tag: null,
    listed: CONTEXT_STRATEGY,
  },
  {
    rust: 'ToolChoice',
    file: 'model.rs',
    keyword: 'enum',
    ts: 'ToolChoiceInput',
    tag: TOOL_CHOICE_TAG,
    listed: TOOL_CHOICE,
  },
  {
    rust: 'StreamEvent',
    file: 'event.rs',
    keyword: 'enum',
    ts: 'ChatStreamEvent',
    tag: STREAM_EVENT_TAG,
    listed: STREAM_EVENT,
  },
  {
    rust: 'Capability',
    file: 'error.rs',
    keyword: 'enum',
    ts: 'CapabilityName',
    tag: null,
    listed: CAPABILITY,
  },
  {
    rust: 'TransportFailure',
    file: 'error.rs',
    keyword: 'enum',
    ts: 'TransportFailure',
    tag: null,
    listed: TRANSPORT_FAILURE,
  },
  {
    rust: 'ProviderError',
    file: 'error.rs',
    keyword: 'enum',
    ts: 'ChatError',
    tag: PROVIDER_ERROR_TAG,
    listed: PROVIDER_ERROR,
  },
  {
    rust: 'Support',
    file: 'capability.rs',
    keyword: 'enum',
    ts: 'CapabilitySupport',
    tag: null,
    listed: SUPPORT,
  },
  {
    rust: 'Evidence',
    file: 'capability.rs',
    keyword: 'enum',
    ts: 'CapabilityEvidence',
    tag: null,
    listed: EVIDENCE,
  },
  {
    rust: 'Cause',
    file: 'diagnostic.rs',
    keyword: 'enum',
    ts: 'KnownCause',
    tag: null,
    listed: CAUSE,
  },
  {
    rust: 'FilterStage',
    file: 'diagnostic.rs',
    keyword: 'enum',
    ts: 'FilterStage',
    tag: null,
    listed: FILTER_STAGE,
  },
  {
    rust: 'FilterKind',
    file: 'diagnostic.rs',
    keyword: 'enum',
    ts: 'FilterKind',
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
    tag: null,
    listed: TOKEN_USAGE_FIELDS,
  },
  {
    rust: 'ChatResponse',
    file: 'model.rs',
    keyword: 'struct',
    ts: 'ChatResponseBody',
    tag: null,
    listed: CHAT_RESPONSE_FIELDS,
  },
  {
    rust: 'AnswerProvenance',
    file: 'model.rs',
    keyword: 'struct',
    ts: 'AnswerProvenance',
    tag: null,
    listed: ANSWER_PROVENANCE_FIELDS,
  },
  {
    rust: 'SchemaMismatch',
    file: 'model.rs',
    keyword: 'struct',
    ts: 'SchemaMismatch',
    tag: null,
    listed: SCHEMA_MISMATCH_FIELDS,
  },
  {
    rust: 'ToolCallDelta',
    file: 'event.rs',
    keyword: 'struct',
    ts: 'ToolCallDelta',
    tag: null,
    listed: TOOL_CALL_DELTA_FIELDS,
  },
  {
    rust: 'EndpointIdentity',
    file: 'diagnostic.rs',
    keyword: 'struct',
    ts: 'EndpointIdentity',
    tag: null,
    listed: ENDPOINT_IDENTITY_FIELDS,
  },
  {
    rust: 'Diagnosis',
    file: 'diagnostic.rs',
    keyword: 'struct',
    ts: 'Diagnosis',
    tag: null,
    listed: DIAGNOSIS_FIELDS,
  },
  {
    rust: 'FilterVerdict',
    file: 'diagnostic.rs',
    keyword: 'struct',
    ts: 'FilterVerdict',
    tag: null,
    listed: FILTER_VERDICT_FIELDS,
  },
];

/* -------------------------------------------------------------------------- */
/* the inventory — what the pairings above are measured against               */
/* -------------------------------------------------------------------------- */

interface SerialisableItem {
  readonly file: string;
  readonly keyword: 'enum' | 'struct';
  readonly rust: string;
}

function qualified(item: { readonly file: string; readonly rust: string }): string {
  return `${item.file}::${item.rust}`;
}

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

function scanSerialisable(source: string, file: string): readonly SerialisableItem[] {
  const found: SerialisableItem[] = [];
  for (const match of source.matchAll(/^pub (enum|struct) ([A-Za-z][A-Za-z0-9_]*)\b[^{\r\n]*\{$/gm)) {
    const at = match.index;
    if (at === undefined) continue;
    const head = source.slice(0, at);
    const derive = head.lastIndexOf('#[derive');
    if (derive < 0) continue;
    const attributes = head.slice(derive);
    // The slice reaches back to the *nearest preceding* `#[derive`, which
    // belongs to the previous item when this one has none. Everything between
    // a derive and its own declaration is attribute text, so a line that is
    // neither an attribute, an attribute continuation nor a comment proves the
    // derive belongs to something else.
    const own = attributes
      .split(/\r?\n/)
      .slice(0, -1)
      .every((line) => line.trim() === '' || /^(#\[|\)\]|\s|\/\/)/.test(line));
    if (!own) continue;
    if (!/\bSerialize\b/.test(attributes)) continue;
    found.push({ file, keyword: match[1] as 'enum' | 'struct', rust: match[2] as string });
  }
  return found;
}

/**
 * The serialisable types in those five files that this boundary deliberately
 * does not pair, each with the reason.
 *
 * A register, not a suppression list. Its purpose is to make the count of
 * *unaccounted* types exactly zero, so that the assertion below can be an
 * equality rather than a threshold.
 */
const NOT_ON_THIS_BOUNDARY: readonly (SerialisableItem & { readonly because: string })[] = [
  // The request direction. The renderer never sends these shapes; it sends the
  // DTOs in `src-tauri/src/ipc/`, which convert. The header of this file says
  // so, and this is that sentence made checkable.
  { file: 'model.rs', keyword: 'struct', rust: 'ChatRequest', because: 'request DTO boundary' },
  { file: 'model.rs', keyword: 'struct', rust: 'ChatMessage', because: 'request DTO boundary' },
  { file: 'model.rs', keyword: 'struct', rust: 'ToolDefinition', because: 'request DTO boundary' },
  { file: 'model.rs', keyword: 'enum', rust: 'ResponseFormat', because: 'request DTO boundary' },
  { file: 'model.rs', keyword: 'enum', rust: 'ReasoningRequest', because: 'request DTO boundary' },
  { file: 'model.rs', keyword: 'struct', rust: 'CacheHints', because: 'request DTO boundary' },
  { file: 'model.rs', keyword: 'struct', rust: 'Sampling', because: 'request DTO boundary' },
  // Capability reporting crosses as an ipc DTO that drops the adapter's
  // free-text `note`; the header names that difference too.
  {
    file: 'capability.rs',
    keyword: 'struct',
    rust: 'CapabilityFinding',
    because: 'capability DTO boundary',
  },
  {
    file: 'capability.rs',
    keyword: 'struct',
    rust: 'ModelCapabilities',
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
    because: 'crosses as a bitset, not as names',
  },
];

/** Sets, not sequences: declaration order is not part of the wire contract. */
function expectMembers(pairing: Pairing): void {
  const item = readRustItem(pairing.file, pairing.keyword, pairing.rust);
  const rust = wireNames(item);
  expect(rust.length, `parser read nothing out of ${pairing.rust}`).toBeGreaterThan(1);
  expect([...rust].sort(), `${pairing.file}::${pairing.rust} vs ${pairing.ts}`).toEqual(
    [...pairing.listed].sort(),
  );
  // The discriminant key. Not a member of anything, so it needs its own
  // comparison or it has none: the TypeScript side is closed by `TagsOf<…,
  // typeof X_TAG>`, which stops compiling if the union does not carry that
  // key, and this is the other half.
  expect(item.tag, `${pairing.file}::${pairing.rust} discriminant key`).toBe(pairing.tag);
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
    expect([...covered].sort()).toEqual([
      'capability.rs',
      'diagnostic.rs',
      'error.rs',
      'event.rs',
      'model.rs',
    ]);
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
    const scanned = ['capability.rs', 'diagnostic.rs', 'error.rs', 'event.rs', 'model.rs']
      .flatMap((file) => serialisableItems(file))
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

  it('pairs each type at most once', () => {
    const pairings = [...ENUMS, ...STRUCTS];
    expect(new Set(pairings.map((p) => `${p.file}::${p.rust}`)).size).toBe(pairings.length);
    expect(new Set(pairings.map((p) => p.ts)).size).toBe(pairings.length);
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
    // rustfmt breaks `ContentPart`'s serde attribute across four lines, so a
    // line-oriented read sees `#[serde(` and no arguments at all.
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

  it('scans the same items out of a source and its opposite-ending twin', () => {
    const lf = (SOURCES['diagnostic.rs'] ?? '').replace(/\r\n/g, '\n');
    const crlf = lf.replace(/\n/g, '\r\n');
    const fromLf = scanSerialisable(lf, 'diagnostic.rs').map(qualified);
    expect(fromLf.length, 'scanned nothing out of diagnostic.rs').toBeGreaterThan(1);
    expect(scanSerialisable(crlf, 'diagnostic.rs').map(qualified)).toEqual(fromLf);
  });
});
