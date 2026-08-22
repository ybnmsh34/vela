/**
 * PARALLEL TOOL CALLS — the shape this harness could not previously see.
 *
 * The GATE M Part 1 (Phase B) executor found a defect that no profile could
 * express: "no matrix profile ever emits two WELL-FORMED calls, so the
 * commonest tool-calling shape in the wild — parallel tool calls — is invisible
 * to the live harness." It had to script the shape by hand to demonstrate the
 * bug. This file makes the shape permanent, so that class of defect can never
 * hide in an untested wire shape again.
 *
 * Everything asserted here is the OpenAI-compatible **wire specification**, not
 * Vela's current behaviour:
 *
 * | | streamed `delta.tool_calls[]` | non-streamed `message.tool_calls[]` |
 * |---|---|---|
 * | an element is | a *fragment* of a call | a *whole* call |
 * | `index` | present on every fragment; the join key | **absent — the field does not exist here** |
 *
 * The pairing is the point. A response that is correct in one transport and
 * wrong in the other is exactly the failure the gate measured, and it is only
 * visible if both transports carry the same logical answer.
 *
 * VERIFIED-BY-FAKE: these are mock endpoints. Nothing here is evidence about a
 * real model — see `docs/architecture/conventions.md` §10.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { accumulateToolCallDeltas, postChat, streamChat } from './src/client.ts';
import type { ProfileName } from './src/profiles.ts';
import { startMockProvider, type MockProviderHandle } from './src/server.ts';

const running: MockProviderHandle[] = [];

async function start(profile: ProfileName): Promise<MockProviderHandle> {
  const handle = await startMockProvider({ profile });
  running.push(handle);
  return handle;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((handle) => handle.close()));
});

/**
 * Two tools, deliberately with different names and different parameter shapes:
 * if N calls collapse into one, the survivor is missing a name a test can point
 * at. Two calls to one tool would collapse into something that still looks
 * plausible, which is how the original defect stayed hidden.
 */
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

const askBoth = {
  messages: [{ role: 'user', content: 'what is the weather in Berlin and what time is it there' }],
  tools: [weatherTool, timeTool],
};

interface WireToolCall {
  readonly id?: unknown;
  readonly index?: unknown;
  readonly type?: unknown;
  readonly function?: { readonly name?: unknown; readonly arguments?: unknown };
}

function messageToolCalls(json: unknown): readonly WireToolCall[] {
  const body = json as {
    choices?: { message?: { tool_calls?: readonly WireToolCall[] }; finish_reason?: string }[];
  };
  return body.choices?.[0]?.message?.tool_calls ?? [];
}

function finishReason(json: unknown): string | undefined {
  return (json as { choices?: { finish_reason?: string }[] }).choices?.[0]?.finish_reason;
}

/** Every `tool_calls` element seen in the stream, in frame order. */
function streamedToolCallFragments(
  events: readonly { readonly json: unknown }[],
): readonly WireToolCall[] {
  const out: WireToolCall[] = [];
  for (const event of events) {
    const choices = (event.json as { choices?: unknown } | null)?.choices;
    if (!Array.isArray(choices)) {
      continue;
    }
    const delta = (choices[0] as { delta?: { tool_calls?: unknown } } | undefined)?.delta;
    if (Array.isArray(delta?.tool_calls)) {
      out.push(...(delta.tool_calls as WireToolCall[]));
    }
  }
  return out;
}

const NATIVE_PROFILES: readonly ProfileName[] = ['frontier', 'mid-local'];

/* -------------------------------------------------------------------------- */
/* well-formed parallel calls — frontier and mid-local                        */
/* -------------------------------------------------------------------------- */

describe('parallel tool calls, well formed', () => {
  it('returns one complete call per offered tool, non-streamed', async () => {
    for (const name of NATIVE_PROFILES) {
      const mock = await start(name);
      const response = await postChat(mock.url, askBoth);
      expect(response.status, name).toBe(200);
      expect(finishReason(response.json), name).toBe('tool_calls');

      const calls = messageToolCalls(response.json);
      expect(calls.length, name).toBe(2);
      expect(
        calls.map((call) => call.function?.name),
        name,
      ).toEqual(['get_weather', 'get_local_time']);

      for (const call of calls) {
        expect(call.type, name).toBe('function');
        expect(String(call.id), name).toMatch(/^call_/u);
        expect(() => JSON.parse(String(call.function?.arguments)), name).not.toThrow();
      }
      // Distinct ids and distinct argument strings: a collapse into one slot is
      // detectable rather than plausible-looking.
      expect(new Set(calls.map((call) => String(call.id))).size, name).toBe(2);
      expect(
        new Set(calls.map((call) => String(call.function?.arguments))).size,
        name,
      ).toBe(2);
    }
  });

  it('carries NO index field on any non-streamed call — that field is not in this shape', async () => {
    // The heart of GATE M FINDING 1. `message.tool_calls[]` elements are whole
    // calls and carry no `index`; a consumer that treats a missing index as
    // "continue the previous call" concatenates them into one. If this
    // assertion ever needs relaxing, the wire spec changed, not the harness.
    for (const name of NATIVE_PROFILES) {
      const mock = await start(name);
      const calls = messageToolCalls((await postChat(mock.url, askBoth)).json);
      expect(calls.length, name).toBeGreaterThan(1);
      for (const call of calls) {
        expect(Object.keys(call), `${name}: ${JSON.stringify(call)}`).not.toContain('index');
      }
    }
  });

  it('keys every streamed fragment by index and splits arguments across frames', async () => {
    for (const name of NATIVE_PROFILES) {
      const mock = await start(name);
      const stream = await streamChat(mock.url, askBoth);
      expect(stream.unparseableFrames, name).toEqual([]);
      expect(stream.finishReasons, name).toEqual(['tool_calls']);

      const fragments = streamedToolCallFragments(stream.events);
      for (const fragment of fragments) {
        expect(typeof fragment.index, `${name}: ${JSON.stringify(fragment)}`).toBe('number');
      }
      expect(new Set(fragments.map((fragment) => fragment.index)), name).toEqual(new Set([0, 1]));

      // Arguments genuinely straddle frame boundaries: no single frame carries
      // a whole `arguments` string, so a per-frame parser sees only pieces.
      for (const index of [0, 1]) {
        const argumentFrames = fragments.filter(
          (fragment) =>
            fragment.index === index && typeof fragment.function?.arguments === 'string',
        );
        expect(argumentFrames.length, `${name} index ${String(index)}`).toBeGreaterThan(1);
      }
    }
  });

  it('describes the same two calls streamed and non-streamed', async () => {
    // The pairing that makes the defect visible: one logical answer, two
    // transports. A stack that is right on one and wrong on the other has to
    // disagree with itself here.
    for (const name of NATIVE_PROFILES) {
      const mock = await start(name);
      const whole = messageToolCalls((await postChat(mock.url, askBoth)).json).map((call) => ({
        id: String(call.id),
        name: String(call.function?.name),
        arguments: String(call.function?.arguments),
      }));
      const stream = await streamChat(mock.url, askBoth);
      const reassembled = accumulateToolCallDeltas(stream.events).map((call) => ({
        id: String(call.id),
        name: String(call.name),
        arguments: call.arguments,
      }));

      expect(reassembled, name).toEqual(whole);
      expect(reassembled.length, name).toBe(2);
    }
  });

  it('still emits exactly one call when only one tool is offered', async () => {
    // Guards the committed single-call transcripts: the parallel shape is
    // additional, never a change to what one offered tool produces.
    for (const name of NATIVE_PROFILES) {
      const mock = await start(name);
      const calls = messageToolCalls(
        (
          await postChat(mock.url, {
            messages: askBoth.messages,
            tools: [weatherTool],
          })
        ).json,
      );
      expect(calls.length, name).toBe(1);
    }
  });

  it('honours tool_choice by naming one tool even when several are offered', async () => {
    const mock = await start('frontier');
    const calls = messageToolCalls(
      (
        await postChat(mock.url, {
          ...askBoth,
          tool_choice: { type: 'function', function: { name: 'get_local_time' } },
        })
      ).json,
    );
    expect(calls.length).toBe(1);
    expect(calls[0]?.function?.name).toBe('get_local_time');
  });
});

/* -------------------------------------------------------------------------- */
/* malformed parallel calls — hostile                                         */
/* -------------------------------------------------------------------------- */

describe('parallel tool calls, partly malformed (hostile)', () => {
  it('sends three calls of which only the middle one is broken', async () => {
    // "Some of them are broken" is the case that makes lost calls detectable:
    // if a consumer reports one malformed call and nothing else, two
    // well-formed calls vanished — and with three calls, that cannot be
    // mistaken for "the endpoint only sent one".
    const mock = await start('hostile');
    const response = await postChat(mock.url, askBoth);
    expect(response.status).toBe(200);
    expect(finishReason(response.json)).toBe('tool_calls');

    const calls = messageToolCalls(response.json);
    expect(calls.length).toBe(3);

    const [first, broken, third] = calls as [WireToolCall, WireToolCall, WireToolCall];

    expect(first.type).toBe('function');
    expect(String(first.id)).toMatch(/^call_/u);
    expect(() => JSON.parse(String(first.function?.arguments))).not.toThrow();

    expect(broken.id).toBeUndefined(); // no id at all
    expect(broken.type).toBe('funktion'); // misspelled discriminator
    expect(() => JSON.parse(String(broken.function?.arguments))).toThrow();

    expect(third.type).toBe('function');
    expect(String(third.id)).toMatch(/^call_/u);
    expect(() => JSON.parse(String(third.function?.arguments))).not.toThrow();

    expect(String(first.id)).not.toBe(String(third.id));
  });

  it('omits index on the non-streamed calls here too, broken ones included', async () => {
    const mock = await start('hostile');
    for (const call of messageToolCalls((await postChat(mock.url, askBoth)).json)) {
      expect(Object.keys(call), JSON.stringify(call)).not.toContain('index');
    }
  });

  it('interleaves streamed fragments across indices, and jumps one index', async () => {
    const mock = await start('hostile');
    const stream = await streamChat(mock.url, askBoth);
    const fragments = streamedToolCallFragments(stream.events);
    const indices = fragments.map((fragment) => fragment.index as number);

    // Non-contiguous on purpose: anything using `index` as an array offset
    // breaks, and anything ignoring it merges three calls into one.
    expect(new Set(indices)).toEqual(new Set([0, 1, 4]));

    // The fragments do not arrive call-by-call: at least one index is revisited
    // after another index was seen, so "keep appending to the last call I
    // touched" produces a string that never existed on the wire.
    const blocked = [...indices].sort((a, b) => a - b);
    expect(indices).not.toEqual(blocked);

    // Still an unterminated, sentinel-less hostile stream: the parallel case
    // does not quietly make this profile well behaved.
    expect(stream.sawDone).toBe(false);
    expect(stream.unparseableFrames.length).toBeGreaterThanOrEqual(2);
  });

  it('agrees with itself across transports: same three calls, same arguments', async () => {
    const mock = await start('hostile');
    const whole = messageToolCalls((await postChat(mock.url, askBoth)).json).map((call) => ({
      name: String(call.function?.name),
      arguments: String(call.function?.arguments),
    }));
    const stream = await streamChat(mock.url, askBoth);
    const reassembled = accumulateToolCallDeltas(stream.events).map((call) => ({
      name: String(call.name),
      arguments: call.arguments,
    }));

    expect(reassembled).toEqual(whole);
    expect(reassembled.filter((call) => {
      try {
        JSON.parse(call.arguments);
        return true;
      } catch {
        return false;
      }
    })).toHaveLength(2);
  });

  it('leaves the single-tool hostile case exactly as it was', async () => {
    const mock = await start('hostile');
    const calls = messageToolCalls(
      (await postChat(mock.url, { messages: askBoth.messages, tools: [weatherTool] })).json,
    );
    expect(calls.length).toBe(2);
    expect(calls[1]?.type).toBe('funktion');
  });
});

/* -------------------------------------------------------------------------- */
/* small-local                                                                */
/* -------------------------------------------------------------------------- */

describe('parallel tool calls against an endpoint with no tools', () => {
  it('is refused, exactly like a single tool is', async () => {
    const mock = await start('small-local');
    const response = await postChat(mock.url, askBoth);
    expect(response.status).toBe(400);
    expect((response.json as { error: { code: string } }).error.code).toBe('tools_not_supported');
  });
});
