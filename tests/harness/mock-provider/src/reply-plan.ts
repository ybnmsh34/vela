/**
 * The response planner: (profile, validated request, seed) → a complete,
 * deterministic description of the reply.
 *
 * Streaming and non-streaming are two *renderings of the same plan*, which is
 * what makes "the concatenated stream equals the non-streaming body" a real
 * invariant rather than a coincidence. The hostile profile breaks that
 * deliberately — and only at the transport layer, in `render-sse.ts`, so the
 * breakage is visible in one place instead of smeared across the harness.
 */

import { readFileSync } from 'node:fs';

import type { CapabilityProfile } from './profiles.ts';
import type { ValidatedChatRequest } from './parse-request.ts';
import { createRng, fnv1a32, hex32, pick, type Rng } from './rng.ts';
import { CHARS_PER_TOKEN, estimateTextTokens, textOfContent } from './tokens.ts';
import type { FinishReason, JsonSchemaNode, ToolDefinition } from './wire-types.ts';

export interface PlannedToolCall {
  readonly id: string;
  readonly name: string;
  /** Raw `arguments` string. Valid JSON on native profiles, broken on hostile. */
  readonly argumentsText: string;
  /** Wire `index`. Hostile skips and reorders these on purpose. */
  readonly index: number;
  /** Hostile omits the id entirely on at least one call. */
  readonly omitId: boolean;
  /** Normally `"function"`. Hostile sends an invalid discriminator. */
  readonly typeField: string;
}

export interface ReplyPlan {
  readonly id: string;
  readonly created: number;
  readonly model: string;
  /** Non-empty only when the profile carries reasoning in a separate field. */
  readonly reasoningText: string;
  readonly reasoningFragments: readonly string[];
  /** The full assistant content. Always equals `contentFragments.join('')`. */
  readonly content: string;
  readonly contentFragments: readonly string[];
  readonly toolCalls: readonly PlannedToolCall[];
  /**
   * The turn answers several tools at once — the commonest tool-calling shape
   * in the wild, and the one the transports disagree about. Renderers use it to
   * choose the parallel wire shape; nothing else in the plan depends on it.
   */
  readonly parallelToolCalls: boolean;
  readonly finishReason: FinishReason;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly truncated: boolean;
}

const FILLER_WORDS: readonly string[] = [
  'alpha', 'beacon', 'careful', 'delta', 'ember', 'fathom', 'gauge', 'harbor',
  'ivory', 'jetty', 'keel', 'lantern', 'meridian', 'north', 'orbit', 'pennant',
  'quartz', 'rudder', 'sextant', 'tiller', 'umber', 'windward', 'yardarm', 'zenith',
];

const STRING_SAMPLES: readonly string[] = [
  'alpha', 'berlin', 'celsius', 'delta-four', 'eastward', 'fixture',
];

/**
 * Visibly wrong tokens. Chosen to look like the leakage real broken servers
 * produce — chat-template markers, replacement characters, stray stop tokens —
 * while staying printable so a transcript can be read in a terminal.
 */
const JUNK_TOKENS: readonly string[] = [
  '▒▒', '<|im_start|>', '</s>', 'ЖЖЖ', '�',
  '<|channel|>analysis', '[UNK]',
];

const DEFAULT_CREATED = 1_700_000_000;

/**
 * Prompt directive: answer with a long, structurally rich markdown document
 * instead of filler prose.
 *
 * ## Why the harness needs one at all
 *
 * The rendered markdown answer is Vela's primary reading surface and **no
 * screenshot in the Phase C evidence set exercised it**. Every profile answers
 * with one paragraph of filler, which is the right default for measuring
 * streaming and reasoning separation and is useless for judging whether a
 * six-level document can be read. A gate that never renders a heading cannot
 * report that all six heading levels were the same size — which is exactly what
 * happened.
 *
 * Like `#tools`, it fires only when asked for, so every recorded transcript and
 * every existing case is byte-identical.
 *
 * The document itself is a file rather than a string literal because
 * `src/features/conversation/Markdown.test.tsx` reads the same bytes: the
 * screenshot and the unit assertion are then about one artifact instead of two
 * that resemble each other. It lives in `tests/fixtures/` — neither the app nor
 * this harness — for the same reason `tests/parity/` does: two sides read it,
 * so it may belong to neither, and `no-app-import.test.ts` stays as strict as
 * it was. Read lazily so importing the planner still costs nothing.
 */
const MARKDOWN_SENTINEL = '#markdown';

let richMarkdown: string | null = null;

function richMarkdownAnswer(): string {
  richMarkdown ??= readFileSync(
    new URL('../../../fixtures/rich-markdown-answer.md', import.meta.url),
    'utf8',
  ).trimEnd();
  return richMarkdown;
}

function firstWords(text: string, count: number): string {
  const words = text.trim().split(/\s+/u).filter((word) => word.length > 0);
  const head = words.slice(0, count).join(' ');
  // Strip quotes and control characters so the generated sentence stays a
  // single clean line no matter what the caller sent.
  return head.replace(/["\u0000-\u001f]/gu, '').slice(0, 120);
}

function lastUserText(request: ValidatedChatRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const message = request.messages[i];
    if (message !== undefined && message.role === 'user') {
      return textOfContent(message.content);
    }
  }
  return '';
}

/** Splits into fixed-size chunks. Cuts words and tags mid-character on purpose. */
export function fragmentText(text: string, size: number): readonly string[] {
  if (text.length === 0) {
    return [];
  }
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size));
  }
  return out;
}

/** Deterministic value conforming to a JSON-Schema subset. */
export function sampleFromSchema(schema: JsonSchemaNode, rng: Rng, depth = 0): unknown {
  if (depth > 5) {
    return null;
  }
  if (schema.enum !== undefined && schema.enum.length > 0) {
    return schema.enum[0];
  }
  const type = schema.type ?? (schema.properties !== undefined ? 'object' : 'string');
  switch (type) {
    case 'object': {
      const properties = schema.properties ?? {};
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(properties).sort()) {
        const child = properties[key];
        if (child !== undefined) {
          out[key] = sampleFromSchema(child, rng, depth + 1);
        }
      }
      return out;
    }
    case 'array': {
      const items = schema.items;
      return items === undefined ? [] : [sampleFromSchema(items, rng, depth + 1)];
    }
    case 'number':
      return Math.round(rng() * 1000) / 10;
    case 'integer':
      return Math.floor(rng() * 100);
    case 'boolean':
      return rng() > 0.5;
    case 'null':
      return null;
    default:
      return pick(rng, STRING_SAMPLES);
  }
}

function proseReply(profile: CapabilityProfile, rng: Rng, prompt: string): string {
  const echo = firstWords(prompt, 8);
  const opening =
    echo.length > 0
      ? `Mock ${profile.name} reply to: ${echo}.`
      : `Mock ${profile.name} reply.`;
  const words: string[] = [];
  for (let i = 0; i < profile.replyWordCount; i += 1) {
    words.push(pick(rng, FILLER_WORDS));
  }
  return `${opening} ${words.join(' ')}.`;
}

function reasoningNarration(profile: CapabilityProfile, prompt: string): string {
  const echo = firstWords(prompt, 6);
  return (
    `Considering the request${echo.length > 0 ? ` about ${echo}` : ''}. ` +
    `Profile ${profile.name} has a ${String(profile.contextWindow)}-token window. ` +
    `Answering directly.`
  );
}

function structuredReply(
  request: ValidatedChatRequest,
  rng: Rng,
  profile: CapabilityProfile,
): string | null {
  const format = request.responseFormat;
  if (format === null || format.type === 'text' || profile.structuredOutput !== 'honoured') {
    return null;
  }
  if (format.type === 'json_object') {
    return JSON.stringify({ answer: proseReply(profile, rng, lastUserText(request)) });
  }
  return JSON.stringify(sampleFromSchema(format.json_schema.schema, rng));
}

/**
 * Which tools the turn answers.
 *
 * One offered tool means one call, exactly as before. **Several offered tools
 * mean several calls** — parallel tool calling, which is what a real frontier
 * endpoint does when a question needs two lookups, and the shape GATE M Part 1
 * (Phase B) found the harness could not express. `tool_choice` naming a
 * function still pins the answer to that one tool.
 */
function resolveRequestedTools(request: ValidatedChatRequest): readonly ToolDefinition[] {
  if (request.tools.length === 0 || request.toolChoice === 'none') {
    return [];
  }
  if (typeof request.toolChoice === 'object') {
    const wanted = request.toolChoice.function.name;
    const named = request.tools.find((tool) => tool.function.name === wanted);
    return named === undefined ? [] : [named];
  }
  return request.tools;
}

/**
 * Call ids. The first keeps the bare `call_<seed>` form the committed
 * single-call transcripts already carry; later calls get a suffix. Ids are
 * opaque strings on the wire, so any distinct value is legal — and keeping the
 * first one stable means adding the parallel shape rewrites no existing byte.
 */
function callId(seedHex: string, position: number): string {
  return position === 0 ? `call_${seedHex}` : `call_${seedHex}_${String(position)}`;
}

function planToolCalls(
  profile: CapabilityProfile,
  request: ValidatedChatRequest,
  rng: Rng,
  seedHex: string,
): { calls: readonly PlannedToolCall[]; parallel: boolean } {
  const tools = resolveRequestedTools(request);
  const none = { calls: [] as readonly PlannedToolCall[], parallel: false };
  if (tools.length === 0 || profile.toolCalling === 'none') {
    return none;
  }
  const validArgumentsFor = (tool: ToolDefinition): string =>
    JSON.stringify(sampleFromSchema(tool.function.parameters ?? { type: 'object' }, rng));

  if (profile.toolCalling === 'native') {
    // One well-formed call per tool. Streamed they are joined by `index`;
    // non-streamed each is a whole entry and `index` does not exist — see
    // `render-json.ts` and `render-sse.ts`.
    const calls = tools.map((tool, position) => ({
      id: callId(seedHex, position),
      name: tool.function.name,
      argumentsText: validArgumentsFor(tool),
      index: position,
      omitId: false,
      typeField: 'function',
    }));
    return { calls, parallel: calls.length > 1 };
  }

  const truncate = (text: string): string =>
    text.slice(0, Math.max(1, Math.floor(text.length * 0.6)));

  if (tools.length > 1) {
    // hostile, parallel: three calls of which only the middle one is broken.
    // "Only some are broken" is what makes lost calls detectable — a consumer
    // that merges the batch reports a single malformed call, and the two
    // well-formed ones have visibly vanished instead of never having existed.
    const first = tools[0] as ToolDefinition;
    const second = tools[1] as ToolDefinition;
    const third = tools[2] ?? second;
    return {
      calls: [
        {
          id: callId(seedHex, 0),
          name: first.function.name,
          argumentsText: validArgumentsFor(first),
          index: 0,
          omitId: false,
          typeField: 'function',
        },
        {
          id: '',
          name: second.function.name,
          argumentsText: truncate(validArgumentsFor(second)),
          index: 1,
          omitId: true,
          typeField: 'funktion',
        },
        {
          // The index jumps: a real broken runtime does not promise contiguity,
          // and anything treating `index` as an array offset breaks here.
          id: callId(seedHex, 2),
          name: third.function.name,
          argumentsText: validArgumentsFor(third),
          index: 4,
          omitId: false,
          typeField: 'function',
        },
      ],
      parallel: true,
    };
  }

  // hostile, one tool: one call whose arguments are truncated mid-JSON, and a
  // second whose id is missing, whose discriminator is misspelled, and whose
  // index jumps — every one of these has been seen from a real broken runtime.
  const tool = tools[0] as ToolDefinition;
  return {
    calls: [
      {
        id: callId(seedHex, 0),
        name: tool.function.name,
        argumentsText: truncate(validArgumentsFor(tool)),
        index: 0,
        omitId: false,
        typeField: 'function',
      },
      {
        id: '',
        name: tool.function.name,
        argumentsText: 'not-json-at-all',
        index: 7,
        omitId: true,
        typeField: 'funktion',
      },
    ],
    parallel: false,
  };
}

function junkRun(rng: Rng, count: number): string {
  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    parts.push(pick(rng, JUNK_TOKENS));
  }
  return parts.join(' ');
}

/**
 * Builds the content fragments. Fragment boundaries are chosen adversarially:
 * on `think-tags` profiles the closing `</think>` is deliberately split across
 * two frames, because an incremental parser that only looks inside one frame
 * will miss it and leak reasoning into the answer.
 */
function planContentFragments(
  profile: CapabilityProfile,
  rng: Rng,
  body: string,
  reasoning: string,
): readonly string[] {
  switch (profile.reasoning) {
    case 'think-tags':
      return [
        '<thi',
        'nk>',
        ...fragmentText(reasoning, 24),
        '</thi',
        'nk>',
        '\n',
        ...fragmentText(body, 16),
      ];
    case 'unterminated-think-junk':
      return [
        '<think>',
        ` ${junkRun(rng, 2)} `,
        ...fragmentText(reasoning, 19),
        ` ${junkRun(rng, 1)} `,
        // A second opening tag inside the first, and neither is ever closed.
        '<think>',
        ' nested ',
        ...fragmentText(body, 11),
        ` ${junkRun(rng, 2)}`,
      ];
    case 'none':
    case 'reasoning-content-field':
    default:
      return fragmentText(body, 16);
  }
}

function applyBudget(
  fragments: readonly string[],
  maxChars: number | null,
): { fragments: readonly string[]; truncated: boolean } {
  if (maxChars === null) {
    return { fragments, truncated: false };
  }
  const kept: string[] = [];
  let used = 0;
  for (const fragment of fragments) {
    if (used >= maxChars) {
      return { fragments: kept, truncated: true };
    }
    if (used + fragment.length > maxChars) {
      kept.push(fragment.slice(0, maxChars - used));
      return { fragments: kept, truncated: true };
    }
    kept.push(fragment);
    used += fragment.length;
  }
  return { fragments: kept, truncated: false };
}

export interface PlanOptions {
  readonly seed: number;
  readonly now: () => number;
}

export function buildReplyPlan(
  profile: CapabilityProfile,
  request: ValidatedChatRequest,
  options: PlanOptions,
): ReplyPlan {
  // Seeded from the canonical semantic request: identical questions get
  // byte-identical replies, forever, in any order, on any machine — and
  // streaming does not change a single word of the answer.
  const seedValue = fnv1a32(`${String(options.seed)}::${profile.name}::${request.seedMaterial}`);
  const seedHex = hex32(seedValue);
  const rng = createRng(seedValue);

  const prompt = lastUserText(request);
  const structured = structuredReply(request, rng, profile);
  // A schema still wins: a caller that asked for JSON gets JSON, whatever else
  // the prompt says. The directive replaces *prose*, which is what it is for.
  const body =
    structured ??
    (prompt.includes(MARKDOWN_SENTINEL) ? richMarkdownAnswer() : proseReply(profile, rng, prompt));

  const narration = reasoningNarration(profile, prompt);
  const reasoningText = profile.reasoning === 'reasoning-content-field' ? narration : '';
  const inlineReasoning = profile.reasoning === 'none' ? '' : narration;

  const { calls: toolCalls, parallel: parallelToolCalls } = planToolCalls(
    profile,
    request,
    rng,
    seedHex,
  );
  // A tool-calling turn carries no prose on native profiles, exactly like the
  // real APIs. Hostile ignores that rule too — it sends both.
  const wantsProse = toolCalls.length === 0 || profile.toolCalling === 'malformed';

  const rawFragments = wantsProse
    ? planContentFragments(profile, rng, body, inlineReasoning)
    : [];

  const maxChars = request.maxTokens === null ? null : request.maxTokens * CHARS_PER_TOKEN;
  const budgeted = applyBudget(rawFragments, maxChars);
  const content = budgeted.fragments.join('');

  const toolTokens = toolCalls.reduce(
    (sum, call) => sum + estimateTextTokens(call.name + call.argumentsText),
    0,
  );
  const completionTokens =
    estimateTextTokens(content) + estimateTextTokens(reasoningText) + toolTokens;

  const finishReason: FinishReason =
    toolCalls.length > 0 ? 'tool_calls' : budgeted.truncated ? 'length' : 'stop';

  return {
    id: `chatcmpl-mock-${seedHex}`,
    created: options.now(),
    model: profile.modelId,
    reasoningText,
    reasoningFragments: fragmentText(reasoningText, 20),
    content,
    contentFragments: budgeted.fragments,
    toolCalls,
    parallelToolCalls,
    finishReason,
    promptTokens: request.promptTokens,
    completionTokens,
    truncated: budgeted.truncated,
  };
}

export { DEFAULT_CREATED };
