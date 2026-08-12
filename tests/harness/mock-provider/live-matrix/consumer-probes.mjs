/**
 * GATE M Part 1 — naive-consumer probes, run against a LIVE mock-provider
 * process over real HTTP.
 *
 * WHAT THIS IS
 * ------------
 * A set of *deliberately naive* OpenAI-compatible consumers. Each one is the
 * implementation a developer reaches for first. They are run against every
 * capability profile so the ways they break are recorded as evidence rather
 * than discovered later, in Phase B, inside Vela.
 *
 * WHAT THIS IS NOT
 * ----------------
 * These are NOT Vela code. Phase A ships no HTTP client at all — not in the
 * Rust core, not in the renderer — so there is no Vela consumer to point at an
 * endpoint yet. These probes stand in for the consumer Phase B must write, and
 * every failure they record is a requirement on that consumer.
 *
 * Nothing here is evidence about any real model. The server on the other end
 * is a deterministic fake.
 *
 * DEPENDENCIES: node builtins only, and deliberately NOT the harness's own
 * `src/client.ts` — a probe that shares code with the server it is testing
 * proves less. Every byte here is parsed from the wire.
 *
 *   node consumer-probes.mjs --url http://127.0.0.1:8104 --probe wait-for-done
 */

import { request as httpRequest } from 'node:http';

const PROBE_TIMEOUT_MS = 5000;

const ASK = { messages: [{ role: 'user', content: 'what is the weather in Berlin' }] };

const WEATHER_TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Look up the weather.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' }, unit: { enum: ['celsius', 'fahrenheit'] } },
      required: ['city'],
    },
  },
};

const JSON_SCHEMA_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'weather_answer',
    schema: {
      type: 'object',
      properties: { city: { type: 'string' }, celsius: { type: 'integer' } },
      required: ['city', 'celsius'],
    },
  },
};

/** POST a chat completion. Resolves with { status, headers, body } on end-of-body. */
function post(url, payload) {
  const target = new URL('/v1/chat/completions', url);
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, body: raw });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Streams a completion and hands each SSE frame to `onFrame`.
 *
 * `onFrame` may call `finish(value)` to settle early — that is how the
 * "wait for [DONE]" and "wait for usage" probes express their termination
 * condition. `onEndOfBody` decides what happens when the body ends without the
 * condition ever being met: a consumer that treats end-of-body as terminal
 * completes, one that does not simply never settles, and the timeout fires.
 */
function stream(url, payload, { onFrame, onEndOfBody, timeoutMs = PROBE_TIMEOUT_MS }) {
  const target = new URL('/v1/chat/completions', url);
  const body = JSON.stringify({ ...payload, stream: true });
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve({ ...outcome, elapsedMs: Date.now() - startedAt });
    };
    const timer = setTimeout(() => {
      finish({ outcome: 'TIMED-OUT', timedOut: true });
    }, timeoutMs);

    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          let cut;
          while ((cut = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            for (const line of block.split('\n')) {
              if (!line.startsWith('data:')) continue;
              try {
                onFrame(line.slice(5).replace(/^ /u, ''), finish);
              } catch (error) {
                finish({ outcome: 'THREW', threw: String(error?.message ?? error) });
                return;
              }
            }
          }
        });
        res.on('end', () => {
          if (onEndOfBody) onEndOfBody(finish);
          // No onEndOfBody, or an onEndOfBody that does not settle, means this
          // consumer does not treat end-of-body as terminal. It hangs until the
          // timeout — which is the finding, not a bug in the probe.
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function json(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

function deltaOf(frameJson) {
  const choices = frameJson?.choices;
  if (!Array.isArray(choices)) return null;
  return choices[0]?.delta ?? null;
}

/* -------------------------------------------------------------------------- */
/* the probes                                                                 */
/* -------------------------------------------------------------------------- */

const probes = {
  /**
   * Consumer A: finalises only when it sees `data: [DONE]`.
   * The single most common shape of streaming client, and the one the hostile
   * profile exists to break.
   */
  'wait-for-done': async (url) => {
    const lines = [];
    let frames = 0;
    const result = await stream(url, ASK, {
      onFrame: (data, finish) => {
        frames += 1;
        if (data === '[DONE]') finish({ outcome: 'SAW-[DONE]', sawDone: true });
      },
      // Deliberately absent: this consumer does not treat end-of-body as
      // terminal. That is the whole point of the probe.
      onEndOfBody: null,
    });
    lines.push(`frames seen                 ${frames}`);
    lines.push(`outcome                     ${result.outcome}`);
    lines.push(`elapsed                     ${result.elapsedMs} ms`);
    lines.push(
      result.timedOut
        ? `VERDICT                     HANG. No [DONE] arrived; a consumer that waits for it never finalises.`
        : `VERDICT                     terminated on the [DONE] sentinel.`,
    );
    return lines;
  },

  /**
   * Consumer B: asks for usage and finalises only when the usage frame lands.
   * `small-local` accepts `include_usage` and never sends one.
   */
  'wait-for-usage': async (url) => {
    const lines = [];
    let frames = 0;
    const result = await stream(
      url,
      { ...ASK, stream_options: { include_usage: true } },
      {
        onFrame: (data, finish) => {
          frames += 1;
          if (data === '[DONE]') return;
          const parsed = json(data);
          if (parsed.ok && parsed.value?.usage !== undefined) {
            finish({ outcome: 'SAW-USAGE', usage: parsed.value.usage });
          }
        },
        onEndOfBody: null,
      },
    );
    lines.push(`frames seen                 ${frames}`);
    lines.push(`outcome                     ${result.outcome}`);
    lines.push(`usage                       ${result.usage ? JSON.stringify(result.usage) : '(never sent)'}`);
    lines.push(`elapsed                     ${result.elapsedMs} ms`);
    lines.push(
      result.timedOut
        ? `VERDICT                     HANG. include_usage was accepted and no usage frame ever arrived.`
        : `VERDICT                     usage frame arrived as requested.`,
    );
    return lines;
  },

  /**
   * Consumer C: assumes every `data:` payload is JSON and throws otherwise.
   * Records how much of the answer is lost when it dies mid-stream.
   */
  'strict-json-frames': async (url) => {
    const lines = [];
    let frames = 0;
    let text = '';
    const result = await stream(url, ASK, {
      onFrame: (data, finish) => {
        frames += 1;
        if (data === '[DONE]') {
          finish({ outcome: 'COMPLETED' });
          return;
        }
        // Throws on the first unparseable frame; `stream` reports it as THREW.
        const value = JSON.parse(data);
        const delta = deltaOf(value);
        if (typeof delta?.content === 'string') text += delta.content;
      },
      onEndOfBody: (finish) => finish({ outcome: 'COMPLETED' }),
    });
    const full = await post(url, ASK);
    const parsedFull = json(full.body);
    const expected = parsedFull.ok ? (parsedFull.value?.choices?.[0]?.message?.content ?? '') : '';
    lines.push(`frames consumed before stop ${frames}`);
    lines.push(`outcome                     ${result.outcome}`);
    if (result.threw) lines.push(`exception                   ${result.threw}`);
    lines.push(`chars accumulated           ${text.length}`);
    lines.push(`chars in non-streamed body  ${expected.length}`);
    lines.push(
      result.outcome === 'THREW'
        ? `VERDICT                     DATA LOSS. Died on an unparseable frame with ${expected.length - text.length} of ${expected.length} chars never delivered.`
        : `VERDICT                     every frame parsed; nothing lost.`,
    );
    return lines;
  },

  /**
   * Consumer D: the obvious tool-call accumulator — key by `index`, append
   * `arguments`. Reports what it ends up holding.
   */
  'index-keyed-tool-accumulator': async (url) => {
    const lines = [];
    const byIndex = new Map();
    let httpStatus = null;
    let frames = 0;
    let unparseable = 0;

    const result = await stream(url, { ...ASK, tools: [WEATHER_TOOL] }, {
      onFrame: (data, finish) => {
        frames += 1;
        if (data === '[DONE]') {
          finish({ outcome: 'COMPLETED' });
          return;
        }
        const parsed = json(data);
        if (!parsed.ok) {
          unparseable += 1;
          return; // tolerant on purpose: the naivety under test is the keying
        }
        const delta = deltaOf(parsed.value);
        for (const call of delta?.tool_calls ?? []) {
          const index = call.index;
          if (index === undefined) continue; // <- the naive drop
          const entry = byIndex.get(index) ?? { index, id: null, type: null, name: null, args: '' };
          if (call.id !== undefined) entry.id = call.id;
          if (call.type !== undefined) entry.type = call.type;
          if (call.function?.name !== undefined) entry.name = call.function.name;
          if (typeof call.function?.arguments === 'string') entry.args += call.function.arguments;
          byIndex.set(index, entry);
        }
      },
      onEndOfBody: (finish) => finish({ outcome: 'COMPLETED' }),
    });

    // Also record what the non-streaming path gives, since they can disagree.
    const nonStreaming = await post(url, { ...ASK, tools: [WEATHER_TOOL] });
    httpStatus = nonStreaming.status;

    lines.push(`streamed frames             ${frames} (${unparseable} unparseable, skipped)`);
    lines.push(`stream outcome              ${result.outcome}`);
    lines.push(`accumulated calls           ${byIndex.size}`);
    for (const entry of [...byIndex.values()].sort((a, b) => a.index - b.index)) {
      const argsOk = json(entry.args);
      lines.push(
        `  index=${entry.index} id=${entry.id ?? 'MISSING'} type=${entry.type ?? 'MISSING'} ` +
          `name=${entry.name ?? 'MISSING'} argumentsParse=${argsOk.ok ? 'ok' : 'FAILED'} args=${JSON.stringify(entry.args)}`,
      );
    }
    lines.push(`non-streaming HTTP status   ${httpStatus}`);
    if (httpStatus !== 200) {
      const err = json(nonStreaming.body);
      lines.push(`non-streaming error code    ${err.ok ? err.value?.error?.code : '(unparseable)'}`);
    }
    return lines;
  },

  /**
   * Consumer E: strips `<think>…</think>` inside each frame as it arrives —
   * the cheapest possible reasoning filter, and one that cannot see a tag that
   * straddles a frame boundary.
   */
  'frame-local-think-stripper': async (url) => {
    const lines = [];
    let shown = '';
    let frames = 0;
    const result = await stream(url, ASK, {
      onFrame: (data, finish) => {
        frames += 1;
        if (data === '[DONE]') {
          finish({ outcome: 'COMPLETED' });
          return;
        }
        const parsed = json(data);
        if (!parsed.ok) return;
        const delta = deltaOf(parsed.value);
        if (typeof delta?.content === 'string') {
          shown += delta.content.replace(/<think>[\s\S]*?<\/think>/gu, '');
        }
      },
      onEndOfBody: (finish) => finish({ outcome: 'COMPLETED' }),
    });
    const leakedOpen = (shown.match(/<think>/gu) ?? []).length;
    const leakedClose = (shown.match(/<\/think>/gu) ?? []).length;
    lines.push(`frames                      ${frames}`);
    lines.push(`outcome                     ${result.outcome}`);
    lines.push(`text shown to the user      ${JSON.stringify(shown)}`);
    lines.push(`<think> markers still shown ${leakedOpen} open, ${leakedClose} close`);
    lines.push(
      leakedOpen + leakedClose > 0
        ? `VERDICT                     LEAK. Reasoning markup reached the user; per-frame stripping is not enough.`
        : `VERDICT                     nothing leaked (this profile emits no inline reasoning markup).`,
    );
    return lines;
  },

  /**
   * Consumer F: asks for `response_format: json_schema` and trusts the answer.
   */
  'structured-output-trust': async (url) => {
    const lines = [];
    const response = await post(url, { ...ASK, response_format: JSON_SCHEMA_FORMAT });
    lines.push(`HTTP status                 ${response.status}`);
    const parsed = json(response.body);
    if (!parsed.ok) {
      lines.push(`VERDICT                     response body was not JSON at all: ${parsed.error}`);
      return lines;
    }
    if (response.status !== 200) {
      lines.push(`error code                  ${parsed.value?.error?.code}`);
      lines.push(`VERDICT                     refused explicitly — the caller can react.`);
      return lines;
    }
    const content = parsed.value?.choices?.[0]?.message?.content ?? '';
    const asJson = json(content);
    lines.push(`content                     ${JSON.stringify(content)}`);
    lines.push(`JSON.parse(content)         ${asJson.ok ? 'ok' : `FAILED — ${asJson.error}`}`);
    if (asJson.ok) {
      lines.push(`parsed keys                 ${JSON.stringify(Object.keys(asJson.value).sort())}`);
      lines.push(`VERDICT                     schema honoured.`);
    } else {
      lines.push(
        `VERDICT                     SILENT WRONG ANSWER. 200 OK, response_format accepted, prose returned. ` +
          `Nothing in the response says the schema was ignored.`,
      );
    }
    return lines;
  },
};

/* -------------------------------------------------------------------------- */

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const url = arg('url', 'http://127.0.0.1:8101');
const only = arg('probe', null);
const names = only ? [only] : Object.keys(probes);

const out = [];
for (const name of names) {
  const probe = probes[name];
  if (!probe) {
    process.stderr.write(`unknown probe: ${name}\n`);
    process.exit(2);
  }
  out.push(`--- probe: ${name} ---`);
  try {
    out.push(...(await probe(url)).map((line) => `    ${line}`));
  } catch (error) {
    out.push(`    PROBE CRASHED: ${String(error?.stack ?? error)}`);
  }
}
process.stdout.write(`${out.join('\n')}\n`);
