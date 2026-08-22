/**
 * GATE M Part 1 — the mock capability-matrix harness.
 *
 * TEST INFRASTRUCTURE. Nothing under `src/` or `src-tauri/` may import this,
 * and `no-app-import.test.ts` fails the suite if anything tries. The harness
 * exists to give Vela hostile endpoints to meet; it is never shipped and never
 * linked into the product.
 *
 * ```ts
 * const mock = await startMockProvider({ profile: 'hostile' });
 * const stream = await streamChat(mock.url, { messages: [{ role: 'user', content: 'hi' }] });
 * expect(stream.sawDone).toBe(false);   // hostile never sends [DONE]
 * await mock.close();
 * ```
 */

export {
  PROFILES,
  PROFILE_NAMES,
  isProfileName,
  resolveProfile,
  type CapabilityProfile,
  type ProfileName,
  type ProfileOverrides,
  type ReasoningMode,
  type StructuredOutputMode,
  type ToolCallingMode,
  type UnsupportedToolsBehaviour,
} from './profiles.ts';

export {
  startMockProvider,
  type MockProviderHandle,
  type MockProviderOptions,
  type RecordedRequest,
} from './server.ts';

export {
  accumulateToolCallDeltas,
  getJson,
  postChat,
  streamChat,
  type AccumulatedToolCall,
  type JsonResult,
  type RequestInitLike,
  type StreamResult,
} from './client.ts';

export {
  parseSseFrames,
  encodeSseData,
  encodeSseRaw,
  encodeSseComment,
  SSE_DONE_FRAME,
  type SseEvent,
} from './sse.ts';

export { ERROR_CODES, MockHttpError, type ErrorCode, type OpenAiErrorBody } from './errors.ts';

export {
  CHARS_PER_TOKEN,
  TOKENS_PER_IMAGE,
  TOKENS_PER_MESSAGE,
  estimatePromptTokens,
  estimateTextTokens,
} from './tokens.ts';

export type {
  ChatCompletionResponse,
  ChatMessage,
  ContentPart,
  ResponseFormat,
  ToolChoice,
  ToolDefinition,
} from './wire-types.ts';
