/**
 * Captures raw GATE M Part 1 transcripts to `docs/regression-baseline/mock-matrix/`.
 *
 *   node tests/harness/mock-provider/src/record-transcripts.ts
 *
 * Critics asked for real bytes rather than summaries, so the captured files are
 * exactly what came off the socket — no pretty-printing, no normalisation, no
 * commentary mixed into the payload. Status codes and the requests that
 * produced each file live beside them in `manifest.json`.
 *
 * Because the harness is deterministic, re-running this is a no-op unless
 * behaviour actually changed: `git diff` over this directory is a regression
 * test in its own right.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROFILE_NAMES, type ProfileName } from './profiles.ts';
import { startMockProvider } from './server.ts';

export const outputRoot = fileURLToPath(new URL('../../../../docs/regression-baseline/mock-matrix/', import.meta.url));

export interface Capture {
  readonly file: string;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly what: string;
  readonly body?: Record<string, unknown>;
}

const weatherTool = {
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

const timeTool = {
  type: 'function',
  function: {
    name: 'get_local_time',
    description: 'Look up the local time.',
    parameters: {
      type: 'object',
      properties: { timezone: { type: 'string' } },
      required: ['timezone'],
    },
  },
};

const ask = { messages: [{ role: 'user', content: 'what is the weather in Berlin' }] };

/**
 * A question that needs two lookups, so the answer is a *parallel* tool call —
 * two or more complete calls in one turn. Deliberately a separate prompt from
 * `ask`: the single-tool captures above are committed evidence and their bytes
 * must not move.
 */
const askBoth = {
  messages: [{ role: 'user', content: 'what is the weather in Berlin and what time is it there' }],
  tools: [weatherTool, timeTool],
};

export function captures(contextWindow: number): readonly Capture[] {
  return [
    { file: '01-health.json', method: 'GET', path: '/health', what: 'liveness probe' },
    { file: '02-props.json', method: 'GET', path: '/props', what: 'server properties, including n_ctx' },
    { file: '03-models.json', method: 'GET', path: '/v1/models', what: 'model listing' },
    {
      file: '04-plain.json',
      method: 'POST',
      path: '/v1/chat/completions',
      what: 'plain question, non-streaming',
      body: ask,
    },
    {
      file: '05-plain.sse',
      method: 'POST',
      path: '/v1/chat/completions',
      what: 'the same question, streamed, with usage requested',
      body: { ...ask, stream: true, stream_options: { include_usage: true } },
    },
    {
      file: '06-tools.json',
      method: 'POST',
      path: '/v1/chat/completions',
      what: 'one tool offered, non-streaming',
      body: { ...ask, tools: [weatherTool] },
    },
    {
      file: '07-tools.sse',
      method: 'POST',
      path: '/v1/chat/completions',
      what: 'one tool offered, streamed',
      body: { ...ask, tools: [weatherTool], stream: true },
    },
    {
      file: '08-vision.json',
      method: 'POST',
      path: '/v1/chat/completions',
      what: 'an image input part',
      body: {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is in this image' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' } },
            ],
          },
        ],
      },
    },
    {
      file: '09-structured-output.json',
      method: 'POST',
      path: '/v1/chat/completions',
      what: 'response_format: json_schema',
      body: {
        ...ask,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'weather_answer',
            schema: {
              type: 'object',
              properties: { city: { type: 'string' }, celsius: { type: 'integer' } },
              required: ['city', 'celsius'],
            },
          },
        },
      },
    },
    {
      file: '10-context-overflow.json',
      method: 'POST',
      path: '/v1/chat/completions',
      what: `a prompt just over the ${String(contextWindow)}-token window`,
      body: { messages: [{ role: 'user', content: `x`.repeat(contextWindow * 4 + 64) }] },
    },
    {
      file: '11-max-tokens.json',
      method: 'POST',
      path: '/v1/chat/completions',
      what: 'max_tokens: 2, forcing truncation',
      body: { ...ask, max_tokens: 2 },
    },
    {
      file: '12-unknown-model.json',
      method: 'POST',
      path: '/v1/chat/completions',
      what: 'a model id this endpoint does not serve',
      body: { ...ask, model: 'gpt-4o' },
    },
    // 13 and 14 are one logical answer in two transports, and must be read
    // together: the non-streamed body carries whole calls with NO `index`, the
    // stream carries fragments that only `index` joins. A stack that is right
    // about one and wrong about the other — GATE M Part 1 (Phase B) FINDING 1 —
    // shows up as a disagreement between these two files.
    {
      file: '13-tools-parallel.json',
      method: 'POST',
      path: '/v1/chat/completions',
      what: 'two tools offered, parallel calls, non-streaming (no index field anywhere)',
      body: askBoth,
    },
    {
      file: '14-tools-parallel.sse',
      method: 'POST',
      path: '/v1/chat/completions',
      what: 'the same parallel answer, streamed as index-keyed fragments',
      body: { ...askBoth, stream: true },
    },
  ];
}

const MAX_MANIFEST_STRING = 200;

/**
 * Long strings in the manifest are elided with their exact length. The
 * context-overflow probe sends 800 KB of `x`; recording it verbatim would bury
 * the evidence under padding nobody can read.
 */
function summariseBody(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_MANIFEST_STRING
      ? `${value.slice(0, 32)}… <${String(value.length)} chars total, elided>`
      : value;
  }
  if (Array.isArray(value)) {
    return value.map(summariseBody);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, summariseBody(child)]),
    );
  }
  return value;
}

interface ManifestEntry extends Omit<Capture, 'body'> {
  readonly status: number;
  readonly contentType: string;
  readonly bytes: number;
  readonly requestBody: unknown;
}

async function recordProfile(name: ProfileName): Promise<void> {
  const mock = await startMockProvider({ profile: name });
  const dir = join(outputRoot, name);
  mkdirSync(dir, { recursive: true });

  const manifest: ManifestEntry[] = [];
  try {
    for (const capture of captures(mock.profile.contextWindow)) {
      const response = await fetch(`${mock.url}${capture.path}`, {
        method: capture.method,
        ...(capture.body === undefined
          ? {}
          : {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(capture.body),
            }),
      });
      const raw = await response.text();
      writeFileSync(join(dir, capture.file), raw, 'utf8');
      manifest.push({
        file: capture.file,
        method: capture.method,
        path: capture.path,
        what: capture.what,
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        bytes: Buffer.byteLength(raw),
        requestBody: capture.body === undefined ? null : summariseBody(capture.body),
      });
    }
    writeFileSync(
      join(dir, 'manifest.json'),
      `${JSON.stringify({ profile: mock.profile, captures: manifest }, null, 2)}\n`,
      'utf8',
    );
  } finally {
    await mock.close();
  }
}

const README = `# GATE M Part 1 — raw mock-matrix transcripts

Generated by \`node tests/harness/mock-provider/src/record-transcripts.ts\`.
Do not edit by hand. Re-running regenerates these files byte for byte; the
harness is deterministic, so \`git diff\` over this directory is itself a
regression test.

One directory per capability profile. Each holds the raw response bodies —
exactly the bytes that came off the socket — plus \`manifest.json\`, which
records the request, HTTP status and content type behind every file.

| profile | tool-calling | vision | context | structured output | reasoning |
|---|---|---|---|---|---|
| frontier | native | yes | 200k | yes | separate \`reasoning_content\` field |
| mid-local | native | no | 32k | accepted then ignored | inline \`<think>\` blocks |
| small-local | none (400) | no | 8k | accepted then ignored | none |
| hostile | malformed / partial | no | 4k | accepted then ignored | unterminated \`<think>\` with junk |

## Parallel tool calls — read 13 and 14 together

\`13-tools-parallel.json\` and \`14-tools-parallel.sse\` are **one logical answer
in two transports**, and they are the pair that matters:

| | \`13-…json\` — \`message.tool_calls[]\` | \`14-…sse\` — \`delta.tool_calls[]\` |
|---|---|---|
| an element is | a **whole** call | a **fragment** of a call |
| \`index\` | **absent — the field does not exist in this shape** | present on every fragment; the only join key |

Two or more complete, valid calls in one turn is the commonest tool-calling
shape in the wild, and until GATE M Part 1 (Phase B) no profile here could emit
it — which is precisely why a defect that collapsed a non-streamed batch into a
single spliced call survived a green suite. On \`hostile\` the batch is three
calls of which only the middle one is broken, so a consumer that loses calls
reports one where the socket carried three.

## What these files are

Evidence about how an OpenAI-compatible **mock** behaves when it cannot do what
was asked. They exist because the real local model endpoint is unreachable from
the build container, and because a strong real model would only ever prove the
happy path.

## What these files are NOT

**They are not evidence about any real model, and never will be.** Nothing here
was produced by a language model. Every byte is a deterministic function of the
request, computed by \`tests/harness/mock-provider\`. Any claim about Vela's
behaviour that cites this directory is a claim about Vela meeting a **fake**
endpoint — VERIFIED-BY-FAKE, in the language of
\`docs/architecture/conventions.md\` §10.

The \`vela_mock\` block in \`/health\` and \`/props\` exists so that a transcript
lifted out of this directory can never be mistaken for a capture from a real
model server. No real endpoint emits it, and no app code may read it.
`;

async function main(): Promise<void> {
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(join(outputRoot, 'README.md'), README, 'utf8');
  for (const name of PROFILE_NAMES) {
    await recordProfile(name);
    process.stdout.write(`recorded ${name}\n`);
  }
  process.stdout.write(`transcripts written to ${outputRoot}\n`);
}

// Run only when invoked directly; `record-transcripts.test.ts` imports the capture
// list to check the committed evidence is still current.
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/gu, '/'))) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  });
}
