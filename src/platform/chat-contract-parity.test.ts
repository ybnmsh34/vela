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

const CONTENT_PART = everyVariantOf<TagsOf<ContentPart, 'kind'>>()([
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

const TOOL_CALL_OUTCOME = everyVariantOf<TagsOf<ToolCallOutcome, 'status'>>()(['ok', 'malformed']);

const DEGRADATION = everyVariantOf<TagsOf<Degradation, 'kind'>>()([
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

const TOOL_CHOICE = everyVariantOf<TagsOf<ToolChoiceInput, 'type'>>()([
  'auto',
  'none',
  'required',
  'named',
]);

const STREAM_EVENT = everyVariantOf<TagsOf<ChatStreamEvent, 'type'>>()([
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

const PROVIDER_ERROR = everyVariantOf<TagsOf<ChatError, 'kind'>>()([
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

type RenameRule = 'camelCase' | 'snake_case' | 'none';

interface RustItem {
  /** Variant names for an enum, field names for a struct — Rust spelling. */
  readonly members: readonly string[];
  readonly renameAll: RenameRule;
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
  const rename = /rename_all\s*=\s*"(camelCase|snake_case)"/.exec(attributes);
  const renameAll: RenameRule = rename ? (rename[1] as RenameRule) : 'none';

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
      // field, merely optional, so it must not match here.
      if (/\bskip\s*[,)]/.test(text)) skipNext = true;
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
  return { members, renameAll };
}

/** Applies the item's own `rename_all`, exactly as serde does. */
function wireName(rustName: string, rule: RenameRule): string {
  if (rule === 'none') return rustName;
  const words = rustName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  if (rule === 'snake_case') return words.join('_');
  return words
    .map((word, index) => (index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join('');
}

function wireNames(item: RustItem): readonly string[] {
  return item.members.map((member) => wireName(member, item.renameAll));
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
}

const ENUMS: readonly Pairing[] = [
  {
    rust: 'MessageRole',
    file: 'model.rs',
    keyword: 'enum',
    ts: 'MessageRole',
    listed: MESSAGE_ROLE,
  },
  {
    rust: 'StopReason',
    file: 'model.rs',
    keyword: 'enum',
    ts: 'StopReason',
    listed: STOP_REASON,
  },
  {
    rust: 'ContentPart',
    file: 'model.rs',
    keyword: 'enum',
    ts: 'ContentPart',
    listed: CONTENT_PART,
  },
  {
    rust: 'MalformedToolCall',
    file: 'model.rs',
    keyword: 'enum',
    ts: 'MalformedToolCallReason',
    listed: MALFORMED_TOOL_CALL,
  },
  {
    rust: 'ToolCallOutcome',
    file: 'model.rs',
    keyword: 'enum',
    ts: 'ToolCallOutcome',
    listed: TOOL_CALL_OUTCOME,
  },
  {
    rust: 'Degradation',
    file: 'model.rs',
    keyword: 'enum',
    ts: 'Degradation',
    listed: DEGRADATION,
  },
  {
    rust: 'ContextStrategy',
    file: 'model.rs',
    keyword: 'enum',
    ts: 'ContextStrategy',
    listed: CONTEXT_STRATEGY,
  },
  {
    rust: 'ToolChoice',
    file: 'model.rs',
    keyword: 'enum',
    ts: 'ToolChoiceInput',
    listed: TOOL_CHOICE,
  },
  {
    rust: 'StreamEvent',
    file: 'event.rs',
    keyword: 'enum',
    ts: 'ChatStreamEvent',
    listed: STREAM_EVENT,
  },
  {
    rust: 'Capability',
    file: 'error.rs',
    keyword: 'enum',
    ts: 'CapabilityName',
    listed: CAPABILITY,
  },
  {
    rust: 'TransportFailure',
    file: 'error.rs',
    keyword: 'enum',
    ts: 'TransportFailure',
    listed: TRANSPORT_FAILURE,
  },
  {
    rust: 'ProviderError',
    file: 'error.rs',
    keyword: 'enum',
    ts: 'ChatError',
    listed: PROVIDER_ERROR,
  },
  {
    rust: 'Support',
    file: 'capability.rs',
    keyword: 'enum',
    ts: 'CapabilitySupport',
    listed: SUPPORT,
  },
  {
    rust: 'Evidence',
    file: 'capability.rs',
    keyword: 'enum',
    ts: 'CapabilityEvidence',
    listed: EVIDENCE,
  },
  {
    rust: 'Cause',
    file: 'diagnostic.rs',
    keyword: 'enum',
    ts: 'KnownCause',
    listed: CAUSE,
  },
  {
    rust: 'FilterStage',
    file: 'diagnostic.rs',
    keyword: 'enum',
    ts: 'FilterStage',
    listed: FILTER_STAGE,
  },
  {
    rust: 'FilterKind',
    file: 'diagnostic.rs',
    keyword: 'enum',
    ts: 'FilterKind',
    listed: FILTER_KIND,
  },
];

const STRUCTS: readonly Pairing[] = [
  {
    rust: 'TokenUsage',
    file: 'model.rs',
    keyword: 'struct',
    ts: 'TokenUsage',
    listed: TOKEN_USAGE_FIELDS,
  },
  {
    rust: 'ChatResponse',
    file: 'model.rs',
    keyword: 'struct',
    ts: 'ChatResponseBody',
    listed: CHAT_RESPONSE_FIELDS,
  },
  {
    rust: 'AnswerProvenance',
    file: 'model.rs',
    keyword: 'struct',
    ts: 'AnswerProvenance',
    listed: ANSWER_PROVENANCE_FIELDS,
  },
  {
    rust: 'SchemaMismatch',
    file: 'model.rs',
    keyword: 'struct',
    ts: 'SchemaMismatch',
    listed: SCHEMA_MISMATCH_FIELDS,
  },
  {
    rust: 'ToolCallDelta',
    file: 'event.rs',
    keyword: 'struct',
    ts: 'ToolCallDelta',
    listed: TOOL_CALL_DELTA_FIELDS,
  },
  {
    rust: 'EndpointIdentity',
    file: 'diagnostic.rs',
    keyword: 'struct',
    ts: 'EndpointIdentity',
    listed: ENDPOINT_IDENTITY_FIELDS,
  },
  {
    rust: 'Diagnosis',
    file: 'diagnostic.rs',
    keyword: 'struct',
    ts: 'Diagnosis',
    listed: DIAGNOSIS_FIELDS,
  },
  {
    rust: 'FilterVerdict',
    file: 'diagnostic.rs',
    keyword: 'struct',
    ts: 'FilterVerdict',
    listed: FILTER_VERDICT_FIELDS,
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
    expect(wireName('CredentialStoreUnreadable', 'snake_case')).toBe('credential_store_unreadable');
    expect(wireName('CredentialStoreUnreadable', 'camelCase')).toBe('credentialStoreUnreadable');
    expect(wireName('authority', 'none')).toBe('authority');
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
   * **The blind spot, asserted so nobody has to discover it.**
   *
   * This file applies a container's `rename_all`. It does **not** read a
   * per-field `#[serde(rename = "…")]`, so a field can pass every comparison
   * above by identifier and still cross the bridge under a key the renderer
   * never reads — which lands as a permanently `null` value rather than as a
   * failure, i.e. the quiet kind.
   *
   * Asserted rather than fixed because a fix here would be a second serde
   * implementation, and a wrong one is worse than a known gap. The gap is
   * closed on the Rust side by serialising a real value and reading the keys
   * off the JSON: `model.rs`'s
   * `provenance_crosses_the_bridge_under_the_keys_the_renderer_reads`. If this
   * control ever fails, the parser learned to read renames and that test's
   * "do not rely on the guard" framing can be revisited.
   */
  it('does NOT see a per-field serde rename — the gap the Rust wire test covers', () => {
    const fixture = [
      '#[derive(Serialize)]',
      '#[serde(rename_all = "camelCase")]',
      'pub struct FixtureStruct {',
      '    #[serde(rename = "totally_different")]',
      '    pub answered_by: Option<String>,',
      '}',
      '',
    ].join('\n');
    const item = parseRustItem(fixture, 'struct', 'FixtureStruct');
    expect(item.members).toEqual(['answered_by']);
    // The wire key is `totally_different`; this file would compare `answeredBy`
    // and be satisfied. That is the whole point of the assertion.
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
});
