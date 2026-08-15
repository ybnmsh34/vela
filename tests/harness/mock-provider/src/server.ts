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
  /**
   * Called with every request as it arrives, before it is answered.
   *
   * `requests` on the handle already holds them, which is enough for an
   * in-process consumer. This exists for the out-of-process one: the GATE M UI
   * matrix runs this endpoint as a **child process**, and the only way for the
   * driver to read the bytes the Rust core put on the wire is for the endpoint
   * to write them somewhere the driver can see. Purely observational — it
   * cannot change the response, so a recorded run and an unrecorded one answer
   * identically and `check-transcripts.sh` stays byte-identical.
   */
  readonly onRequest?: (request: RecordedRequest) => void;
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

/**
 * How much of an over-cap body we will still read — and immediately throw away
 * — so that the 413 is something the client can actually read.
 *
 * WHY THIS EXISTS: the first version of this guard rejected and called
 * `request.destroy()` in the same turn. The socket went down while the client
 * was still uploading, so the client observed `ECONNRESET` and zero response
 * bytes; the 413 branch was unreachable dead code (GATE M Part 1, EDGE-PROBES
 * probe 1). Letting the client finish sending is what makes the answer readable
 * on an ordinary keep-alive connection. This constant bounds that generosity:
 * an endless upload is still an endless upload.
 *
 * It is NOT the only way to hand the client a readable answer — this comment
 * used to say it was, and a body past the cap was still answered with a reset
 * because of it. Past the cap the connection is closed rather than reused, and
 * closing it politely is a half-close, not a destroy. See
 * {@link sendBodyTooLarge}.
 */
const OVERSIZE_DRAIN_BYTES = 8 * 1024 * 1024;

/**
 * How long a socket may sit half-closed after the over-cap 413 has been written,
 * before we give up and destroy it. See {@link sendBodyTooLarge}: the polite
 * close is a FIN, and a FIN only completes when the peer stops writing. A client
 * that never stops is the case this bounds.
 */
const OVERSIZE_LINGER_MS = 5_000;

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

/**
 * The outcome of reading a request body.
 *
 * `oversized` is not thrown from {@link readBody}, because the caller has to
 * know *how* it ended: a body we drained to completion can be answered on a
 * healthy keep-alive connection, whereas one we gave up draining leaves the
 * client mid-upload and the connection has to be closed after the answer.
 */
type BodyRead =
  | { readonly kind: 'complete'; readonly body: string }
  | { readonly kind: 'oversized'; readonly clientFinished: boolean };

function readBody(request: IncomingMessage): Promise<BodyRead> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    let discarded = 0;

    const onData = (chunk: Buffer): void => {
      if (oversized) {
        discarded += chunk.length;
        if (discarded > OVERSIZE_DRAIN_BYTES) {
          request.off('data', onData);
          request.pause();
          resolve({ kind: 'oversized', clientFinished: false });
        }
        return;
      }
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Nothing will ever parse these bytes; drop them rather than hold
        // multiple megabytes alive for the duration of the drain.
        oversized = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    };

    request.on('data', onData);
    request.on('end', () => {
      // A second `resolve` after the drain cap fired is a no-op, by design.
      resolve(
        oversized
          ? { kind: 'oversized', clientFinished: true }
          : { kind: 'complete', body: Buffer.concat(chunks).toString('utf8') },
      );
    });
    request.on('error', reject);
  });
}

/**
 * Answers an over-cap request with the documented 413, then ends the
 * connection cleanly — response first, close second, never the other way
 * round. See {@link OVERSIZE_DRAIN_BYTES}.
 */
function sendBodyTooLarge(
  request: IncomingMessage,
  response: ServerResponse,
  clientFinished: boolean,
): void {
  const error = new MockHttpError({
    status: 413,
    message: 'request body too large',
    code: ERROR_CODES.invalidJson,
  });

  if (clientFinished) {
    // The whole body arrived and was discarded; this is an ordinary response
    // on an ordinary connection.
    sendError(response, error);
    return;
  }

  // We stopped reading while the client was still writing. Say so in the
  // response so the client does not reuse the connection, flush the body, and
  // only then take the socket down.
  //
  // HOW THE SOCKET GOES DOWN IS THE WHOLE PROBLEM, and it took a Windows run to
  // see it. This used to end with `request.destroy()`. `destroy()` is an
  // ABORTIVE close: it calls `closesocket()` on a socket whose receive queue
  // still holds the upload we refused, and TCP answers unread data with RST.
  // A peer that receives RST discards whatever is sitting unread in its own
  // receive buffer — including a response that is already on the wire. So the
  // client got `ECONNRESET` and *zero* bytes, which is the identical defect the
  // comment on OVERSIZE_DRAIN_BYTES says was fixed. It was only half fixed: the
  // 413 became reachable for a body that ends before the drain cap, and stayed
  // unreachable for one that does not. That half was never exercised where it
  // breaks: the test below is green on the Linux runners and red here, and only
  // the Windows result was measured — whether Linux is reliably safe or merely
  // wins the race is not established, and does not change the fix.
  // RFC 9112 §9.6 describes this exactly and prescribes the fix: half-close.
  //
  // Measured on Windows 11 with a raw `net` client (no HTTP layer), server
  // writes 480 bytes then closes while the client is still uploading 24 MiB:
  //
  //   socket.destroy()  -> client received    0 / 480 bytes, ECONNRESET
  //   socket.end()      -> client received  480 / 480 bytes, clean FIN
  //
  // `end()` is a half-close: it shuts down our write direction only, so the
  // bytes we already queued are delivered and acknowledged. Nothing about the
  // drain cap changes — we still stop reading, and the client still stalls
  // against a closed window. We just stop erasing our own answer on the way out.
  //
  // The socket has to be detached from Node's HTTP layer first. Node reacts to a
  // `Connection: close` response by calling `socket.destroySoon()` when the
  // response finishes, and `destroySoon()` is `end()` followed immediately by
  // `destroy()` — the abortive close again, from inside http rather than from
  // here. Detaching hands us the socket, and the response is written verbatim.
  const payload = JSON.stringify(error.body satisfies OpenAiErrorBody, null, 2);
  const socket = request.socket;
  response.detachSocket(socket);

  socket.write(
    'HTTP/1.1 413 Payload Too Large\r\n' +
      'content-type: application/json; charset=utf-8\r\n' +
      `content-length: ${String(Buffer.byteLength(payload))}\r\n` +
      'connection: close\r\n' +
      '\r\n' +
      payload,
    () => {
      socket.end();
    },
  );

  // The FIN completes when the client stops writing and closes its side. One
  // that never does would leave this socket half-open forever, so it is bounded.
  // Unref'd: a lingering socket must never be the reason a process stays up.
  const linger = setTimeout(() => {
    socket.destroy();
  }, OVERSIZE_LINGER_MS);
  linger.unref();
  socket.once('close', () => {
    clearTimeout(linger);
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
    const read = await readBody(request);
    if (read.kind === 'oversized') {
      sendBodyTooLarge(request, response, read.clientFinished);
      return;
    }
    const body = read.body;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      headers[key] = Array.isArray(value) ? value.join(', ') : (value ?? '');
    }
    const recorded: RecordedRequest = {
      method: request.method ?? 'GET',
      path,
      headers,
      body,
      authorization: request.headers.authorization,
    };
    requests.push(recorded);
    options.onRequest?.(recorded);

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
