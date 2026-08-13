/**
 * The GATE M Part 1 (Phase C) UI relay.
 *
 * Owns two child processes and joins them to the browser:
 *
 *   1. `tests/harness/mock-provider` on a loopback port — one of the four
 *      capability profiles, unmodified.
 *   2. `src-tauri/examples/ui_matrix_bridge` — the real `vela_lib::ipc`
 *      functions over the real provider core, speaking JSON lines on stdio.
 *
 * and serves the renderer:
 *
 *   POST /invoke   {command, payload} -> {ok} | {err:{code,message}}
 *   GET  /events   SSE; every `chat:event` the core emitted, verbatim
 *   GET  /health   readiness + the ports in play
 *
 * ## Why CORS is wide open here and nowhere else
 *
 * This relay is the stand-in for the Tauri IPC channel, not for a model
 * endpoint. It answers `OPTIONS` and sends `access-control-allow-origin` so a
 * page on the Vite dev server can reach it. The **model** endpoint keeps its
 * recorded behaviour — no CORS headers, `OPTIONS` -> 405 — which is exactly why
 * the browser cannot reach it and why every byte of provider HTTP originates in
 * the Rust core. The driver asserts that separately by watching the network.
 *
 * Usage:
 *   node tests/harness/ui-bridge/server.mjs --profile hostile --port 8420
 *        [--chunk-delay 40] [--no-register] [--endpoint-api-key K]
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The one model id each profile serves. Mirrors `mock-provider/src/profiles.ts`. */
const MODEL_IDS = {
  frontier: 'mock-frontier',
  'mid-local': 'mock-mid-local',
  'small-local': 'mock-small-local',
  hostile: 'mock-hostile',
};

function parseArgs(argv) {
  const args = {
    profile: 'frontier',
    port: 8420,
    chunkDelay: 0,
    register: true,
    endpointApiKey: undefined,
    requireKey: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--profile') (args.profile = value), (i += 1);
    else if (flag === '--port') (args.port = Number(value)), (i += 1);
    else if (flag === '--chunk-delay') (args.chunkDelay = Number(value)), (i += 1);
    else if (flag === '--no-register') args.register = false;
    // What the *bridge* sends. Omitted by default: no credential at all.
    else if (flag === '--endpoint-api-key') (args.endpointApiKey = value), (i += 1);
    // What the *endpoint* demands. Used by the no-credential controls.
    else if (flag === '--require-key') (args.requireKey = value), (i += 1);
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!(args.profile in MODEL_IDS)) throw new Error(`unknown profile ${args.profile}`);
  return args;
}

const options = parseArgs(process.argv.slice(2));

/* -------------------------------------------------------------------------- */
/* 1. the mock endpoint                                                       */
/* -------------------------------------------------------------------------- */

const mockArgs = [
  join(repoRoot, 'tests/harness/mock-provider/src/cli.ts'),
  '--profile',
  options.profile,
  '--port',
  '0',
  '--chunk-delay',
  String(options.chunkDelay),
];
if (options.requireKey !== undefined) mockArgs.push('--api-key', options.requireKey);

const mock = spawn('node', mockArgs, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] });

const mockUrl = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    reject(new Error('the mock provider did not report a URL within 30 s'));
  }, 30_000);
  createInterface({ input: mock.stdout }).on('line', (line) => {
    const at = line.indexOf('listening on ');
    if (at !== -1) {
      clearTimeout(timer);
      resolve(line.slice(at + 'listening on '.length).trim());
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 2. the Rust host bridge                                                    */
/* -------------------------------------------------------------------------- */

const bridgeArgs = [
  '--endpoint',
  `${mockUrl}/v1`,
  '--provider-id',
  'matrix',
  '--model-id',
  MODEL_IDS[options.profile],
];
if (!options.register) bridgeArgs.push('--no-register');
if (options.endpointApiKey !== undefined) bridgeArgs.push('--api-key', options.endpointApiKey);

const bridgeBinary = join(repoRoot, 'src-tauri/target/debug/examples/ui_matrix_bridge');
const bridge = spawn(bridgeBinary, bridgeArgs, { stdio: ['pipe', 'pipe', 'inherit'] });

/** Pending `invoke` calls, by id. */
const pending = new Map();
/** Connected SSE clients. */
const listeners = new Set();
/** Every event the core emitted, kept for the driver's post-run assertions. */
const eventLog = [];
let nextId = 1;
let bridgeReady = false;

createInterface({ input: bridge.stdout }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    // The bridge writes nothing but JSON lines. Anything else is a panic
    // message on the way out, and swallowing it would hide a crash.
    process.stderr.write(`[bridge] ${line}\n`);
    return;
  }
  if (message.ready === true) {
    bridgeReady = true;
    return;
  }
  if (message.event !== undefined) {
    eventLog.push(message);
    const framed = `data: ${JSON.stringify({ name: message.event, payload: message.payload })}\n\n`;
    for (const client of listeners) client.write(framed);
    return;
  }
  const settle = pending.get(message.id);
  if (settle !== undefined) {
    pending.delete(message.id);
    settle(message);
  }
});

bridge.on('exit', (code) => {
  process.stderr.write(`[bridge] exited with ${code}\n`);
});

function callBridge(command, payload) {
  const id = nextId;
  nextId += 1;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    bridge.stdin.write(`${JSON.stringify({ id, command, payload })}\n`);
  });
}

/* -------------------------------------------------------------------------- */
/* 3. the relay                                                               */
/* -------------------------------------------------------------------------- */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};

const server = createServer((request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, CORS).end();
    return;
  }
  const url = new URL(request.url, 'http://127.0.0.1');

  if (url.pathname === '/health') {
    response.writeHead(200, { ...CORS, 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        ready: bridgeReady,
        profile: options.profile,
        modelId: MODEL_IDS[options.profile],
        endpoint: mockUrl,
        events: eventLog.length,
      }),
    );
    return;
  }

  // The driver's own read-back channel: every StreamEvent the core produced,
  // so an assertion about the UI can be compared against what it was given.
  if (url.pathname === '/events.json') {
    response.writeHead(200, { ...CORS, 'content-type': 'application/json' });
    response.end(JSON.stringify(eventLog));
    return;
  }

  // Takes the endpoint away, the way a user's local runtime does when they
  // close the terminal it was running in. The next turn meets a real refused
  // connection — no stubbed error, no injected failure.
  if (url.pathname === '/control/stop-endpoint') {
    mock.kill('SIGKILL');
    response.writeHead(200, { ...CORS, 'content-type': 'application/json' });
    response.end(JSON.stringify({ stopped: true }));
    return;
  }

  if (url.pathname === '/events') {
    response.writeHead(200, {
      ...CORS,
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write(': open\n\n');
    listeners.add(response);
    request.on('close', () => listeners.delete(response));
    return;
  }

  if (url.pathname === '/invoke' && request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        response.writeHead(400, { ...CORS, 'content-type': 'application/json' });
        response.end(JSON.stringify({ err: { code: 'INVALID_PAYLOAD', message: 'bad json' } }));
        return;
      }
      void callBridge(parsed.command, parsed.payload ?? {}).then((message) => {
        response.writeHead(200, { ...CORS, 'content-type': 'application/json' });
        response.end(JSON.stringify(message.err !== undefined ? { err: message.err } : { ok: message.ok }));
      });
    });
    return;
  }

  response.writeHead(404, CORS).end();
});

server.listen(options.port, '127.0.0.1', () => {
  process.stdout.write(
    `ui-bridge listening on http://127.0.0.1:${options.port} (profile ${options.profile}, endpoint ${mockUrl})\n`,
  );
});

function shutdown() {
  mock.kill();
  bridge.kill();
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
