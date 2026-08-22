/**
 * THE CAPABILITY MATRIX.
 *
 * Four profiles, one per column of GATE M Part 1. A profile is a *description
 * of a deficiency*, not a description of a product: the point of this harness
 * is to make Vela meet endpoints that cannot do what it wants, and prove it
 * degrades explicitly instead of crashing, hanging, or lying.
 *
 * | profile     | tool-calling       | vision | context | structured output | reasoning         |
 * |-------------|--------------------|--------|---------|-------------------|-------------------|
 * | frontier    | native             | yes    | 200k    | yes               | yes               |
 * | mid-local   | native             | no     | 32k     | no                | yes (<think>)     |
 * | small-local | NONE               | no     | 8k      | no                | no                |
 * | hostile     | malformed/partial  | no     | 4k      | no                | interleaved junk  |
 *
 * Every field is overridable per server instance (`overrides` in
 * {@link resolveProfile}) so a consumer can isolate one axis at a time — e.g.
 * "frontier, but the model listing 404s" — without inventing a fifth profile.
 */

/** The four columns of the matrix. Do not add a fifth without updating the gate docs. */
export type ProfileName = 'frontier' | 'mid-local' | 'small-local' | 'hostile';

/**
 * `native` — well-formed OpenAI `tool_calls`.
 * `none` — the endpoint has no concept of tools; see {@link CapabilityProfile.unsupportedToolsBehaviour}.
 * `malformed` — tool_calls arrive, but broken: unparseable arguments, missing
 *   ids, indices out of order, fields split across deltas at hostile boundaries.
 */
export type ToolCallingMode = 'native' | 'none' | 'malformed';

/**
 * What a no-tools endpoint does when asked for tools anyway. Both are real
 * behaviours in the wild and both are dangerous in different ways: `reject` is
 * loud and easy to handle, `ignore` silently returns prose where the caller
 * expected a tool call.
 */
export type UnsupportedToolsBehaviour = 'reject' | 'ignore';

/**
 * `honoured` — `response_format` produces conforming JSON.
 * `ignored` — the field is accepted and then silently disregarded (prose comes
 *   back). This is the realistic and more dangerous failure, so it is the
 *   default for every profile that lacks structured output.
 * `rejected` — 400.
 */
export type StructuredOutputMode = 'honoured' | 'ignored' | 'rejected';

/**
 * How reasoning reaches the client. Two real transports exist in the wild and
 * they are not interchangeable, so the matrix covers both:
 * `reasoning-content-field` — a separate `reasoning_content` delta/message field.
 * `think-tags` — `<think>…</think>` inline in `content` (llama.cpp default).
 * `unterminated-think-junk` — an opened `<think>` that never closes, with junk
 *   interleaved into it.
 */
export type ReasoningMode =
  | 'none'
  | 'reasoning-content-field'
  | 'think-tags'
  | 'unterminated-think-junk';

export interface CapabilityProfile {
  readonly name: ProfileName;
  /** The single model id this endpoint serves. `/v1/models` lists exactly this. */
  readonly modelId: string;
  readonly displayName: string;
  /** Hard limit enforced on prompt + requested completion. */
  readonly contextWindow: number;
  readonly toolCalling: ToolCallingMode;
  readonly unsupportedToolsBehaviour: UnsupportedToolsBehaviour;
  /** `false` → any `image_url` content part is a 400. */
  readonly vision: boolean;
  readonly structuredOutput: StructuredOutputMode;
  readonly reasoning: ReasoningMode;
  /** `false` → `/v1/models` 404s and the UI must fall back to free-text entry. */
  readonly modelListing: boolean;
  /** `false` → the stream simply ends; there is no `data: [DONE]` sentinel. */
  readonly emitDoneSentinel: boolean;
  /** `true` → some SSE frames are deliberately not valid JSON. */
  readonly emitMalformedSseFrames: boolean;
  /** `false` → `stream_options.include_usage` is accepted and then ignored. */
  readonly streamUsage: boolean;
  /** Length of the generated answer, in words. Deterministic. */
  readonly replyWordCount: number;
}

const FRONTIER: CapabilityProfile = {
  name: 'frontier',
  modelId: 'mock-frontier',
  displayName: 'Mock Frontier (200k, tools, vision, JSON, reasoning)',
  contextWindow: 200_000,
  toolCalling: 'native',
  unsupportedToolsBehaviour: 'reject',
  vision: true,
  structuredOutput: 'honoured',
  reasoning: 'reasoning-content-field',
  modelListing: true,
  emitDoneSentinel: true,
  emitMalformedSseFrames: false,
  streamUsage: true,
  replyWordCount: 24,
};

const MID_LOCAL: CapabilityProfile = {
  name: 'mid-local',
  modelId: 'mock-mid-local',
  displayName: 'Mock Mid Local (32k, tools, <think>, no vision)',
  contextWindow: 32_768,
  toolCalling: 'native',
  unsupportedToolsBehaviour: 'reject',
  vision: false,
  // Not "rejected": this endpoint accepts response_format and then ignores it.
  // Silently returning prose is the harder case for the caller, so it is the
  // one the matrix exercises.
  structuredOutput: 'ignored',
  reasoning: 'think-tags',
  modelListing: true,
  emitDoneSentinel: true,
  emitMalformedSseFrames: false,
  streamUsage: true,
  replyWordCount: 16,
};

const SMALL_LOCAL: CapabilityProfile = {
  name: 'small-local',
  modelId: 'mock-small-local',
  displayName: 'Mock Small Local (8k, plain text only)',
  contextWindow: 8_192,
  toolCalling: 'none',
  unsupportedToolsBehaviour: 'reject',
  vision: false,
  structuredOutput: 'ignored',
  reasoning: 'none',
  modelListing: true,
  emitDoneSentinel: true,
  emitMalformedSseFrames: false,
  // Accepts stream_options.include_usage and never sends usage. A caller that
  // waits for a usage frame before finishing will hang — which is the point.
  streamUsage: false,
  replyWordCount: 10,
};

const HOSTILE: CapabilityProfile = {
  name: 'hostile',
  modelId: 'mock-hostile',
  displayName: 'Mock Hostile (4k, broken everything)',
  contextWindow: 4_096,
  toolCalling: 'malformed',
  unsupportedToolsBehaviour: 'ignore',
  vision: false,
  structuredOutput: 'ignored',
  reasoning: 'unterminated-think-junk',
  modelListing: true,
  emitDoneSentinel: false,
  emitMalformedSseFrames: true,
  streamUsage: false,
  replyWordCount: 12,
};

export const PROFILES: Readonly<Record<ProfileName, CapabilityProfile>> = {
  frontier: FRONTIER,
  'mid-local': MID_LOCAL,
  'small-local': SMALL_LOCAL,
  hostile: HOSTILE,
};

/** Matrix order — the order the gate documents use. Keep it stable. */
export const PROFILE_NAMES: readonly ProfileName[] = [
  'frontier',
  'mid-local',
  'small-local',
  'hostile',
];

export function isProfileName(value: string): value is ProfileName {
  return (PROFILE_NAMES as readonly string[]).includes(value);
}

/** Profile overrides. `name` is not overridable — it identifies the column. */
export type ProfileOverrides = Partial<Omit<CapabilityProfile, 'name'>>;

export function resolveProfile(
  name: ProfileName,
  overrides: ProfileOverrides = {},
): CapabilityProfile {
  return { ...PROFILES[name], ...overrides, name };
}
