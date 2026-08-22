/**
 * Validation of an untrusted request body against the OpenAI chat schema, and
 * then against the profile's declared capabilities.
 *
 * The order matters and is deliberate: shape errors first (a real server would
 * not get far enough to notice a capability problem), then capability
 * rejections in a fixed order — model, vision, tools, structured output,
 * context. Fixed order means an error transcript is reproducible.
 */

import { ERROR_CODES, MockHttpError } from './errors.ts';
import type { CapabilityProfile } from './profiles.ts';
import { countImageParts, estimatePromptTokens } from './tokens.ts';
import type {
  ChatMessage,
  ContentPart,
  ResponseFormat,
  ToolChoice,
  ToolDefinition,
} from './wire-types.ts';

export interface ValidatedChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly stream: boolean;
  readonly streamIncludeUsage: boolean;
  readonly tools: readonly ToolDefinition[];
  readonly toolChoice: ToolChoice;
  readonly responseFormat: ResponseFormat | null;
  readonly maxTokens: number | null;
  readonly promptTokens: number;
  readonly imageParts: number;
  /** The exact bytes received. Recorded verbatim so transcripts show reality. */
  readonly rawBody: string;
  /**
   * Canonical form of the *semantic* request — everything that should affect
   * the answer, and nothing that should not. Transport-only fields (`stream`,
   * `stream_options`) are excluded on purpose: the same question streamed and
   * unstreamed must produce the same words, and a test asserts exactly that.
   */
  readonly seedMaterial: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bad(message: string, code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES], param: string | null = null): MockHttpError {
  return new MockHttpError({ status: 400, message, code, param });
}

function parseContentPart(raw: unknown, index: number): ContentPart {
  if (!isRecord(raw)) {
    throw bad(`messages[].content[${String(index)}] must be an object`, ERROR_CODES.missingField, 'messages');
  }
  if (raw['type'] === 'text') {
    const text = raw['text'];
    if (typeof text !== 'string') {
      throw bad(`messages[].content[${String(index)}].text must be a string`, ERROR_CODES.missingField, 'messages');
    }
    return { type: 'text', text };
  }
  if (raw['type'] === 'image_url') {
    const holder = raw['image_url'];
    if (!isRecord(holder) || typeof holder['url'] !== 'string') {
      throw bad(
        `messages[].content[${String(index)}].image_url.url must be a string`,
        ERROR_CODES.missingField,
        'messages',
      );
    }
    const detail = holder['detail'];
    return typeof detail === 'string'
      ? { type: 'image_url', image_url: { url: holder['url'], detail } }
      : { type: 'image_url', image_url: { url: holder['url'] } };
  }
  throw bad(
    `messages[].content[${String(index)}].type must be "text" or "image_url"`,
    ERROR_CODES.missingField,
    'messages',
  );
}

function parseMessage(raw: unknown, index: number): ChatMessage {
  if (!isRecord(raw)) {
    throw bad(`messages[${String(index)}] must be an object`, ERROR_CODES.missingField, 'messages');
  }
  const role = raw['role'];
  if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') {
    throw bad(
      `messages[${String(index)}].role must be one of system|user|assistant|tool`,
      ERROR_CODES.missingField,
      'messages',
    );
  }
  const content = raw['content'];
  if (typeof content === 'string' || content === null || content === undefined) {
    return { role, content: content ?? null };
  }
  if (Array.isArray(content)) {
    return { role, content: content.map((part, i) => parseContentPart(part, i)) };
  }
  throw bad(
    `messages[${String(index)}].content must be a string, null, or an array of parts`,
    ERROR_CODES.missingField,
    'messages',
  );
}

function parseTool(raw: unknown, index: number): ToolDefinition {
  if (!isRecord(raw) || raw['type'] !== 'function' || !isRecord(raw['function'])) {
    throw bad(`tools[${String(index)}] must be { type: "function", function: {…} }`, ERROR_CODES.missingField, 'tools');
  }
  const fn = raw['function'];
  const name = fn['name'];
  if (typeof name !== 'string' || name.length === 0) {
    throw bad(`tools[${String(index)}].function.name is required`, ERROR_CODES.missingField, 'tools');
  }
  const parameters = fn['parameters'];
  const description = fn['description'];
  return {
    type: 'function',
    function: {
      name,
      ...(typeof description === 'string' ? { description } : {}),
      ...(isRecord(parameters) ? { parameters } : {}),
    },
  };
}

function parseToolChoice(raw: unknown): ToolChoice {
  if (raw === undefined || raw === null) {
    return 'auto';
  }
  if (raw === 'none' || raw === 'auto' || raw === 'required') {
    return raw;
  }
  if (isRecord(raw) && raw['type'] === 'function' && isRecord(raw['function'])) {
    const name = raw['function']['name'];
    if (typeof name === 'string') {
      return { type: 'function', function: { name } };
    }
  }
  throw bad('tool_choice must be "none" | "auto" | "required" | { type: "function", … }', ERROR_CODES.missingField, 'tool_choice');
}

function parseResponseFormat(raw: unknown): ResponseFormat | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (!isRecord(raw)) {
    throw bad('response_format must be an object', ERROR_CODES.missingField, 'response_format');
  }
  if (raw['type'] === 'text') {
    return { type: 'text' };
  }
  if (raw['type'] === 'json_object') {
    return { type: 'json_object' };
  }
  if (raw['type'] === 'json_schema') {
    const holder = raw['json_schema'];
    if (!isRecord(holder) || typeof holder['name'] !== 'string' || !isRecord(holder['schema'])) {
      throw bad(
        'response_format.json_schema requires { name, schema }',
        ERROR_CODES.missingField,
        'response_format',
      );
    }
    return {
      type: 'json_schema',
      json_schema: { name: holder['name'], schema: holder['schema'] },
    };
  }
  throw bad(
    'response_format.type must be "text" | "json_object" | "json_schema"',
    ERROR_CODES.missingField,
    'response_format',
  );
}

/** Shape validation only. Capability checks happen in {@link enforceProfile}. */
export function parseChatRequest(rawBody: string): ValidatedChatRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    throw bad('request body is not valid JSON', ERROR_CODES.invalidJson);
  }
  if (!isRecord(parsed)) {
    throw bad('request body must be a JSON object', ERROR_CODES.invalidJson);
  }

  const rawMessages = parsed['messages'];
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw bad('messages is required and must be a non-empty array', ERROR_CODES.missingField, 'messages');
  }
  const messages = rawMessages.map((message, index) => parseMessage(message, index));

  const model = parsed['model'];
  if (model !== undefined && typeof model !== 'string') {
    throw bad('model must be a string', ERROR_CODES.missingField, 'model');
  }

  const stream = parsed['stream'];
  if (stream !== undefined && typeof stream !== 'boolean') {
    throw bad('stream must be a boolean', ERROR_CODES.missingField, 'stream');
  }

  const rawMaxTokens = parsed['max_tokens'] ?? parsed['max_completion_tokens'];
  if (rawMaxTokens !== undefined && (typeof rawMaxTokens !== 'number' || !Number.isInteger(rawMaxTokens) || rawMaxTokens <= 0)) {
    throw bad('max_tokens must be a positive integer', ERROR_CODES.missingField, 'max_tokens');
  }

  const rawTools = parsed['tools'];
  if (rawTools !== undefined && !Array.isArray(rawTools)) {
    throw bad('tools must be an array', ERROR_CODES.missingField, 'tools');
  }
  const tools = (rawTools ?? []).map((tool, index) => parseTool(tool, index));

  const streamOptions = parsed['stream_options'];
  const streamIncludeUsage = isRecord(streamOptions) && streamOptions['include_usage'] === true;

  const toolChoice = parseToolChoice(parsed['tool_choice']);
  if (
    typeof toolChoice === 'object' &&
    !tools.some((tool) => tool.function.name === toolChoice.function.name)
  ) {
    throw bad(
      `tool_choice names \`${toolChoice.function.name}\`, which is not in tools`,
      ERROR_CODES.missingField,
      'tool_choice',
    );
  }

  const responseFormat = parseResponseFormat(parsed['response_format']);
  const maxTokens = typeof rawMaxTokens === 'number' ? rawMaxTokens : null;

  return {
    model: typeof model === 'string' ? model : '',
    messages,
    stream: stream === true,
    streamIncludeUsage,
    tools,
    toolChoice,
    responseFormat,
    maxTokens,
    promptTokens: estimatePromptTokens(messages),
    imageParts: countImageParts(messages),
    rawBody,
    seedMaterial: JSON.stringify({
      model: typeof model === 'string' ? model : '',
      messages,
      tools,
      toolChoice,
      responseFormat,
      maxTokens,
    }),
  };
}

/**
 * Capability enforcement, in a fixed order so transcripts are reproducible:
 * model id → vision → tools → structured output → context window.
 */
export function enforceProfile(profile: CapabilityProfile, request: ValidatedChatRequest): void {
  if (request.model !== '' && request.model !== profile.modelId) {
    throw new MockHttpError({
      status: 404,
      message: `the model \`${request.model}\` does not exist; this endpoint serves \`${profile.modelId}\``,
      code: ERROR_CODES.modelNotFound,
      param: 'model',
    });
  }

  if (request.imageParts > 0 && !profile.vision) {
    throw bad(
      `\`${profile.modelId}\` does not support image input`,
      ERROR_CODES.visionNotSupported,
      'messages',
    );
  }

  if (
    request.tools.length > 0 &&
    profile.toolCalling === 'none' &&
    profile.unsupportedToolsBehaviour === 'reject'
  ) {
    throw bad(
      `\`${profile.modelId}\` does not support tools`,
      ERROR_CODES.toolsNotSupported,
      'tools',
    );
  }

  if (
    request.responseFormat !== null &&
    request.responseFormat.type !== 'text' &&
    profile.structuredOutput === 'rejected'
  ) {
    throw bad(
      `\`${profile.modelId}\` does not support response_format`,
      ERROR_CODES.responseFormatNotSupported,
      'response_format',
    );
  }

  const requested = request.promptTokens + (request.maxTokens ?? 0);
  if (request.promptTokens >= profile.contextWindow || requested > profile.contextWindow) {
    throw bad(
      `this model's maximum context length is ${String(profile.contextWindow)} tokens, ` +
        `however you requested ${String(requested)} tokens ` +
        `(${String(request.promptTokens)} in the messages, ` +
        `${String(request.maxTokens ?? 0)} in the completion)`,
      ERROR_CODES.contextLengthExceeded,
      'messages',
    );
  }
}
