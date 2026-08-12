/**
 * The mock provider server.
 *
 * A real HTTP listener on a real (by default ephemeral) port, speaking the
 * OpenAI-compatible surface that llama.cpp, Ollama, LM Studio and vLLM all
 * expose. Nothing here is Vela-specific: point any OpenAI client at it.
 *
 * AUTH IS OFF BY DEFAULT, and that is a load-bearing decision. Most local
 * runtimes have no auth at all; "no API key" is a first-class valid state in
 * Vela, so the default configuration of the harness must be the no-auth one.
 * Passing `apiKey` opts into a credentialled endpoint.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { ERROR_CODES, MockHttpError, type OpenAiErrorBody } from './errors.ts';
import { enforceProfile, parseChatRequest } from './parse-request.ts';
import {
  isProfileName,
  resolveProfile,
  type CapabilityProfile,
  type ProfileName,
  type ProfileOverrides,
} from './profiles.ts';
import { buildReplyPlan, DEFAULT_CREATED } from './reply-plan.ts';
import { renderChatCompletion } from './render-json.ts';
import { renderSseStream } from './render-sse.ts';

export interface MockProviderOptions {
  readonly profile: ProfileName;
  /** `0` (the default) asks the OS for an ephemeral port. */
  readonly port?: number;
  readonly host?: string;
  /** Base seed. Combined with the request bytes, so replies stay reproducible. */
  readonly seed?: number;
  /**
   * When set, the endpoint requires `Authorization: Bearer <apiKey>`.
   * When omitted, the endpoint has NO auth — the common local case.
   */
  readonly apiKey?: string;
  readonly overrides?: ProfileOverrides;
  /** Delay between SSE frames. Default 0: tests must never sleep. */
  readonly chunkDelayMs?: number;
  /** Clock for `created`. Default is a fixed constant, for byte-stable output. */
  readonly now?: () => number;
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /**
   * The raw `Authorization` header, or `undefined` when the client sent none.
   * Exposed so a consumer can assert the "no credential ⇒ no header" rule
   * rather than assuming it.
   */
  readonly authorization: string | undefined;
}

export interface MockProviderHandle {
  /** e.g. `http://127.0.0.1:41235` — no trailing slash. */
  readonly url: string;
  readonly port: number;
  readonly profile: CapabilityProfile;
  /** Every request the server saw, in order. */
  readonly requests: readonly RecordedRequest[];
  clearRequests(): void;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
  });
  response.end(payload);
}

function sendError(response: ServerResponse, error: MockHttpError): void {
  sendJson(response, error.status, error.body satisfies OpenAiErrorBody);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(
          new MockHttpError({
            status: 413,
            message: 'request body too large',
            code: ERROR_CODES.invalidJson,
          }),
        );
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

/**
 * An `Authorization` header that is present but empty is always an error, even
 * on a no-auth endpoint. Vela must send no header at all when it holds no
 * credential; a bare `Bearer` is a bug, and this turns it into a 401 rather
 * than letting it pass unnoticed.
 */
function checkAuthorization(header: string | undefined, apiKey: string | undefined): void {
  if (header !== undefined) {
    const value = header.trim();
    if (value === '' || /^Bearer\s*$/iu.test(value)) {
      throw new MockHttpError({
        status: 401,
        message: 'an Authorization header was sent with no credential in it',
        code: ERROR_CODES.emptyAuthorizationHeader,
        type: 'authentication_error',
      });
    }
  }
  if (apiKey === undefined) {
    return;
  }
  if (header === undefined || header.trim() !== `Bearer ${apiKey}`) {
    throw new MockHttpError({
      status: 401,
      message: 'incorrect API key provided',
      code: ERROR_CODES.invalidApiKey,
      type: 'authentication_error',
    });
  }
}

function healthBody(profile: CapabilityProfile): unknown {
  return {
    status: 'ok',
    slots_idle: 4,
    slots_processing: 0,
    // Namespaced mock metadata. Real endpoints have nothing like it; app code
    // must never read it. It exists so a captured transcript can never be
    // mistaken for one taken from a real model server.
    vela_mock: { profile: profile.name, model: profile.modelId },
  };
}

function propsBody(profile: CapabilityProfile): unknown {
  return {
    default_generation_settings: {
      n_ctx: profile.contextWindow,
      model: profile.modelId,
      seed: 4294967295,
    },
    total_slots: 4,
    model_path: `/models/${profile.modelId}.gguf`,
    chat_template: "{%- for message in messages -%}{{ message['content'] }}{%- endfor -%}",
    build_info: 'vela-mock-provider',
    vela_mock: {
      profile: profile.name,
      context_window: profile.contextWindow,
      tool_calling: profile.toolCalling,
      vision: profile.vision,
      structured_output: profile.structuredOutput,
      reasoning: profile.reasoning,
      emits_done_sentinel: profile.emitDoneSentinel,
      emits_malformed_sse_frames: profile.emitMalformedSseFrames,
    },
  };
}

function modelsBody(profile: CapabilityProfile, created: number): unknown {
  if (!profile.modelListing) {
    throw new MockHttpError({
      status: 404,
      message: 'this endpoint does not enumerate models',
      code: ERROR_CODES.modelListingNotSupported,
    });
  }
  return {
    object: 'list',
    data: [
      { id: profile.modelId, object: 'model', created, owned_by: 'vela-mock-provider' },
    ],
  };
}

async function writeStream(
  response: ServerResponse,
  frames: readonly string[],
  chunkDelayMs: number,
): Promise<void> {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const frame of frames) {
    if (response.writableEnded || response.destroyed) {
      return;
    }
    response.write(frame);
    if (chunkDelayMs > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, chunkDelayMs);
      });
    }
  }
  response.end();
}

export async function startMockProvider(
  options: MockProviderOptions,
): Promise<MockProviderHandle> {
  if (!isProfileName(options.profile)) {
    throw new Error(`unknown profile: ${String(options.profile)}`);
  }
  const profile = resolveProfile(options.profile, options.overrides ?? {});
  const host = options.host ?? '127.0.0.1';
  const seed = options.seed ?? 0x5645_4c41;
  const chunkDelayMs = options.chunkDelayMs ?? 0;
  const now = options.now ?? ((): number => DEFAULT_CREATED);
  const apiKey = options.apiKey;
  const requests: RecordedRequest[] = [];

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const rawPath = request.url ?? '/';
    const path = rawPath.split('?')[0] ?? '/';
    const body = await readBody(request);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      headers[key] = Array.isArray(value) ? value.join(', ') : (value ?? '');
    }
    requests.push({
      method: request.method ?? 'GET',
      path,
      headers,
      body,
      authorization: request.headers.authorization,
    });

    checkAuthorization(request.headers.authorization, apiKey);

    // `/v1` is optional: llama.cpp serves both, and so do we.
    const route = path.startsWith('/v1/') ? path.slice('/v1'.length) : path;
    const method = request.method ?? 'GET';

    if (route === '/health' || route === '/props' || route === '/models') {
      if (method !== 'GET') {
        throw new MockHttpError({
          status: 405,
          message: `${method} is not allowed on ${path}`,
          code: ERROR_CODES.methodNotAllowed,
        });
      }
      if (route === '/health') {
        sendJson(response, 200, healthBody(profile));
        return;
      }
      if (route === '/props') {
        sendJson(response, 200, propsBody(profile));
        return;
      }
      sendJson(response, 200, modelsBody(profile, now()));
      return;
    }

    if (route === '/chat/completions') {
      if (method !== 'POST') {
        throw new MockHttpError({
          status: 405,
          message: `${method} is not allowed on ${path}`,
          code: ERROR_CODES.methodNotAllowed,
        });
      }
      const parsed = parseChatRequest(body);
      enforceProfile(profile, parsed);
      const plan = buildReplyPlan(profile, parsed, { seed, now });

      if (parsed.stream) {
        await writeStream(
          response,
          renderSseStream(profile, plan, parsed.streamIncludeUsage),
          chunkDelayMs,
        );
        return;
      }
      sendJson(response, 200, renderChatCompletion(profile, plan));
      return;
    }

    throw new MockHttpError({
      status: 404,
      message: `unknown route ${path}`,
      code: ERROR_CODES.unknownRoute,
    });
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (response.writableEnded) {
        return;
      }
      if (error instanceof MockHttpError) {
        sendError(response, error);
        return;
      }
      sendJson(response, 500, {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: 'internal_error',
          param: null,
          code: null,
        },
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('mock provider did not bind a TCP port');
  }
  const port = address.port;

  return {
    url: `http://${host}:${String(port)}`,
    port,
    profile,
    requests,
    clearRequests(): void {
      requests.length = 0;
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error === undefined || error === null) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    },
  };
}
