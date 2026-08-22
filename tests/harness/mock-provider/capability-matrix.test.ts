/**
 * GATE M Part 1 — the capability matrix, exercised over real HTTP.
 *
 * This file is the evidence. Every claim Vela makes about graceful degradation
 * traces back to an assertion here, because the real local model endpoint is
 * unreachable from this container. Nothing in it proves anything about a real
 * model; it proves what Vela's counterpart *does* when an endpoint cannot do
 * what was asked.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { accumulateToolCallDeltas, getJson, postChat, streamChat } from './src/client.ts';
import { PROFILE_NAMES, type ProfileName } from './src/profiles.ts';
import { startMockProvider, type MockProviderHandle, type MockProviderOptions } from './src/server.ts';

const running: MockProviderHandle[] = [];

async function start(options: MockProviderOptions): Promise<MockProviderHandle> {
  const handle = await startMockProvider(options);
  running.push(handle);
  return handle;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((handle) => handle.close()));
});

const ask = { messages: [{ role: 'user', content: 'what is the weather in Berlin' }] };

const weatherTool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Look up the weather.',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string' },
        unit: { enum: ['celsius', 'fahrenheit'] },
      },
      required: ['city'],
    },
  },
};

const imageTurn = {
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is in this image' },
        {
          type: 'image_url',
          image_url: {
            url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
          },
        },
      ],
    },
  ],
};

const jsonSchemaFormat = {
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

interface ChatBody {
  readonly choices: {
    readonly message: {
      readonly content: string | null;
      readonly reasoning_content?: string;
      readonly tool_calls?: readonly Record<string, unknown>[];
    };
    readonly finish_reason: string;
  }[];
  readonly usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function chat(json: unknown): ChatBody {
  return json as ChatBody;
}

function errorCode(json: unknown): string {
  return (json as { error: { code: string } }).error.code;
}

/** A prompt guaranteed to blow past `contextWindow` tokens on that profile. */
function oversizedPrompt(contextWindow: number): Record<string, unknown> {
  return { messages: [{ role: 'user', content: 'x'.repeat(contextWindow * 4 + 64) }] };
}

/* -------------------------------------------------------------------------- */
/* frontier                                                                   */
/* -------------------------------------------------------------------------- */

describe('profile: frontier — native tools, vision, 200k, JSON schema, reasoning', () => {
  it('answers plainly with reasoning carried in its own field', async () => {
    const mock = await start({ profile: 'frontier' });
    const response = await postChat(mock.url, ask);
    expect(response.status).toBe(200);

    const body = chat(response.json);
    const message = body.choices[0]?.message;
    expect(typeof message?.content).toBe('string');
    expect(message?.reasoning_content).toBeTypeOf('string');
    expect(message?.content).not.toContain('<think>');
    expect(body.choices[0]?.finish_reason).toBe('stop');
    expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens);
  });

  it('returns a clean native tool call whose arguments are valid JSON', async () => {
    const mock = await start({ profile: 'frontier' });
    const body = chat((await postChat(mock.url, { ...ask, tools: [weatherTool] })).json);

    expect(body.choices[0]?.finish_reason).toBe('tool_calls');
    const calls = body.choices[0]?.message.tool_calls ?? [];
    expect(calls).toHaveLength(1);
    const call = calls[0] as { id: string; type: string; function: { name: string; arguments: string } };
    expect(call.id).toMatch(/^call_/u);
    expect(call.type).toBe('function');
    expect(call.function.name).toBe('get_weather');
    const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
    expect(args['city']).toBeTypeOf('string');
    expect(args['unit']).toBe('celsius');
    // A pure tool-calling turn has no prose, exactly like the real APIs.
    expect(body.choices[0]?.message.content).toBeNull();
  });

  it('accepts image_url content parts', async () => {
    const mock = await start({ profile: 'frontier' });
    const response = await postChat(mock.url, imageTurn);
    expect(response.status).toBe(200);
    expect(chat(response.json).usage.prompt_tokens).toBeGreaterThan(85);
  });

  it('honours a json_schema response_format', async () => {
    const mock = await start({ profile: 'frontier' });
    const body = chat(
      (await postChat(mock.url, { ...ask, response_format: jsonSchemaFormat })).json,
    );
    const content = body.choices[0]?.message.content ?? '';
    const parsed = JSON.parse(content) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['celsius', 'city']);
    expect(typeof parsed['city']).toBe('string');
    expect(Number.isInteger(parsed['celsius'])).toBe(true);
  });

  it('accepts a prompt far larger than any small model would take', async () => {
    const mock = await start({ profile: 'frontier' });
    const response = await postChat(mock.url, {
      messages: [{ role: 'user', content: 'x'.repeat(400_000) }],
    });
    expect(response.status).toBe(200); // 100k tokens against a 200k window
  });

  it('streams cleanly: same text as non-streaming, usage on request, [DONE] at the end', async () => {
    const mock = await start({ profile: 'frontier' });
    const nonStreaming = chat((await postChat(mock.url, ask)).json);
    const stream = await streamChat(mock.url, { ...ask, stream_options: { include_usage: true } });

    expect(stream.contentType).toContain('text/event-stream');
    expect(stream.unparseableFrames).toEqual([]);
    expect(stream.sawDone).toBe(true);
    expect(stream.textContent).toBe(nonStreaming.choices[0]?.message.content);
    expect(stream.reasoningContent).toBe(nonStreaming.choices[0]?.message.reasoning_content);
    expect(stream.finishReasons).toEqual(['stop']);

    const usageFrames = stream.events.filter(
      (event) => (event.json as { usage?: unknown } | null)?.usage !== undefined,
    );
    expect(usageFrames).toHaveLength(1);
  });

  it('streams tool-call arguments in fragments that reassemble into valid JSON', async () => {
    const mock = await start({ profile: 'frontier' });
    const stream = await streamChat(mock.url, { ...ask, tools: [weatherTool] });
    const calls = accumulateToolCallDeltas(stream.events);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('get_weather');
    expect(calls[0]?.id).toMatch(/^call_/u);
    expect(calls[0]?.argumentsAreValidJson).toBe(true);
    expect(stream.finishReasons).toEqual(['tool_calls']);
  });
});

/* -------------------------------------------------------------------------- */
/* mid-local                                                                  */
/* -------------------------------------------------------------------------- */

describe('profile: mid-local — native tools, no vision, 32k, no JSON mode, <think>', () => {
  it('returns a native tool call, the same shape as frontier', async () => {
    const mock = await start({ profile: 'mid-local' });
    const body = chat((await postChat(mock.url, { ...ask, tools: [weatherTool] })).json);
    const call = (body.choices[0]?.message.tool_calls ?? [])[0] as {
      function: { arguments: string };
    };
    expect(() => JSON.parse(call.function.arguments)).not.toThrow();
    expect(body.choices[0]?.finish_reason).toBe('tool_calls');
  });

  it('rejects image input with a proper error, not a crash and not silence', async () => {
    const mock = await start({ profile: 'mid-local' });
    const response = await postChat(mock.url, imageTurn);
    expect(response.status).toBe(400);
    expect(errorCode(response.json)).toBe('vision_not_supported');
    expect((response.json as { error: { message: string } }).error.message).toContain(
      'does not support image input',
    );
  });

  it('enforces its 32k context window', async () => {
    const mock = await start({ profile: 'mid-local' });
    const ok = await postChat(mock.url, {
      messages: [{ role: 'user', content: 'x'.repeat(100_000) }],
    });
    expect(ok.status).toBe(200); // 25k tokens fits

    const tooBig = await postChat(mock.url, oversizedPrompt(32_768));
    expect(tooBig.status).toBe(400);
    expect(errorCode(tooBig.json)).toBe('context_length_exceeded');
    expect((tooBig.json as { error: { message: string } }).error.message).toContain('32768');
  });

  it('accepts response_format and then silently ignores it', async () => {
    // The dangerous case, deliberately chosen over a clean 400: a caller that
    // trusts response_format gets prose back and must notice on its own.
    const mock = await start({ profile: 'mid-local' });
    const response = await postChat(mock.url, { ...ask, response_format: jsonSchemaFormat });
    expect(response.status).toBe(200);
    const content = chat(response.json).choices[0]?.message.content ?? '';
    expect(() => JSON.parse(content)).toThrow();
    expect(content).toContain('<think>');
  });

  it('carries reasoning inline as <think> blocks, with no reasoning_content field', async () => {
    const mock = await start({ profile: 'mid-local' });
    const message = chat((await postChat(mock.url, ask)).json).choices[0]?.message;
    expect(message?.reasoning_content).toBeUndefined();
    expect(message?.content).toContain('<think>');
    expect(message?.content).toContain('</think>');
  });

  it('splits the closing </think> across SSE frames, so a per-frame parser misses it', async () => {
    const mock = await start({ profile: 'mid-local' });
    const stream = await streamChat(mock.url, ask);

    const contentFrames = stream.events
      .map((event) => {
        const choices = (event.json as { choices?: { delta?: { content?: unknown } }[] } | null)
          ?.choices;
        return choices?.[0]?.delta?.content;
      })
      .filter((value): value is string => typeof value === 'string');

    expect(contentFrames.some((frame) => frame.includes('</think>'))).toBe(false);
    expect(stream.textContent).toContain('</think>');
    expect(stream.reasoningContent).toBe('');
    expect(stream.sawDone).toBe(true);
    expect(stream.unparseableFrames).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* small-local                                                                */
/* -------------------------------------------------------------------------- */

describe('profile: small-local — no tools at all, no vision, 8k, plain text', () => {
  it('rejects tools outright by default', async () => {
    const mock = await start({ profile: 'small-local' });
    const response = await postChat(mock.url, { ...ask, tools: [weatherTool] });
    expect(response.status).toBe(400);
    expect(errorCode(response.json)).toBe('tools_not_supported');
  });

  it('can instead ignore tools entirely, the other real-world failure', async () => {
    const mock = await start({
      profile: 'small-local',
      overrides: { unsupportedToolsBehaviour: 'ignore' },
    });
    const response = await postChat(mock.url, { ...ask, tools: [weatherTool] });
    expect(response.status).toBe(200);
    const choice = chat(response.json).choices[0];
    expect(choice?.message.tool_calls).toBeUndefined();
    expect(choice?.finish_reason).toBe('stop');
    // The caller asked for a tool and got prose. Nothing warned it.
    expect(typeof choice?.message.content).toBe('string');
  });

  it('still refuses tools when tool_choice is "required"', async () => {
    const mock = await start({ profile: 'small-local' });
    const response = await postChat(mock.url, {
      ...ask,
      tools: [weatherTool],
      tool_choice: 'required',
    });
    expect(response.status).toBe(400);
    expect(errorCode(response.json)).toBe('tools_not_supported');
  });

  it('enforces its 8k context window', async () => {
    const mock = await start({ profile: 'small-local' });
    const response = await postChat(mock.url, oversizedPrompt(8_192));
    expect(response.status).toBe(400);
    expect(errorCode(response.json)).toBe('context_length_exceeded');
  });

  it('emits plain text only — no reasoning field, no think tags', async () => {
    const mock = await start({ profile: 'small-local' });
    const message = chat((await postChat(mock.url, ask)).json).choices[0]?.message;
    expect(message?.reasoning_content).toBeUndefined();
    expect(message?.content).not.toContain('<think>');
  });

  it('accepts stream_options.include_usage and never sends usage', async () => {
    // A consumer that waits for a usage frame before finalising will wait
    // forever. The [DONE] sentinel is the only reliable terminator here.
    const mock = await start({ profile: 'small-local' });
    const stream = await streamChat(mock.url, { ...ask, stream_options: { include_usage: true } });

    const usageFrames = stream.events.filter(
      (event) => (event.json as { usage?: unknown } | null)?.usage !== undefined,
    );
    expect(usageFrames).toEqual([]);
    expect(stream.sawDone).toBe(true);
    expect(stream.unparseableFrames).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* hostile                                                                    */
/* -------------------------------------------------------------------------- */

describe('profile: hostile — malformed tools, junk reasoning, broken SSE, 4k', () => {
  it('enforces a tiny 4k context window', async () => {
    const mock = await start({ profile: 'hostile' });
    const response = await postChat(mock.url, oversizedPrompt(4_096));
    expect(response.status).toBe(400);
    expect(errorCode(response.json)).toBe('context_length_exceeded');
    expect((response.json as { error: { message: string } }).error.message).toContain('4096');
  });

  it('ignores tools rather than rejecting them, then answers with broken ones anyway', async () => {
    const mock = await start({ profile: 'hostile' });
    const response = await postChat(mock.url, { ...ask, tools: [weatherTool] });
    expect(response.status).toBe(200);

    const calls = chat(response.json).choices[0]?.message.tool_calls ?? [];
    expect(calls).toHaveLength(2);

    const first = calls[0] as { id?: string; type: string; function: { arguments: string } };
    expect(first.type).toBe('function');
    expect(() => JSON.parse(first.function.arguments)).toThrow();

    const second = calls[1] as { id?: string; type: string; function: { arguments: string } };
    expect(second.id).toBeUndefined(); // no id at all
    expect(second.type).toBe('funktion'); // misspelled discriminator
    expect(() => JSON.parse(second.function.arguments)).toThrow();

    expect(chat(response.json).choices[0]?.finish_reason).toBe('tool_calls');
  });

  it('opens <think> and never closes it, with junk interleaved', async () => {
    const mock = await start({ profile: 'hostile' });
    const content = chat((await postChat(mock.url, ask)).json).choices[0]?.message.content ?? '';
    expect(content).toContain('<think>');
    expect(content).not.toContain('</think>');
    expect(content.split('<think>').length - 1).toBeGreaterThanOrEqual(2);
    expect(content).toMatch(/▒▒|<\|im_start\|>|<\/s>|ЖЖЖ|\[UNK\]/u);
  });

  it('sends SSE frames that are not valid JSON', async () => {
    const mock = await start({ profile: 'hostile' });
    const stream = await streamChat(mock.url, ask);
    expect(stream.unparseableFrames.length).toBeGreaterThanOrEqual(2);
    expect(stream.unparseableFrames).toContain('not-json-at-all');
    expect(stream.unparseableFrames.some((frame) => frame.includes('"delta"'))).toBe(true);
  });

  it('never sends [DONE] — the stream simply stops', async () => {
    const mock = await start({ profile: 'hostile' });
    const stream = await streamChat(mock.url, ask);
    expect(stream.sawDone).toBe(false);
    // It does terminate, though: the response completes. A consumer that waits
    // for [DONE] before finalising hangs; one that treats end-of-body as
    // terminal does not.
    expect(stream.raw.length).toBeGreaterThan(0);
    expect(stream.finishReasons).toEqual(['stop']);
  });

  it('sends a frame whose JSON is valid but whose shape is wrong', async () => {
    const mock = await start({ profile: 'hostile' });
    const stream = await streamChat(mock.url, ask);
    const wrongShape = stream.events.filter(
      (event) => (event.json as { choices?: unknown } | null)?.choices === 'not-an-array',
    );
    expect(wrongShape).toHaveLength(1);
  });

  it('splits tool calls across deltas so the obvious accumulator loses the name', async () => {
    const mock = await start({ profile: 'hostile' });
    const stream = await streamChat(mock.url, { ...ask, tools: [weatherTool] });
    const calls = accumulateToolCallDeltas(stream.events);

    // The delta carrying `function.name` had no `index`, so a naive
    // index-keyed accumulator drops it and the call ends up nameless.
    const first = calls.find((call) => call.index === 0);
    expect(first).toBeDefined();
    expect(first?.name).toBeNull();
    expect(first?.argumentsAreValidJson).toBe(false);

    // …and the second call jumps to index 7 with no id.
    const second = calls.find((call) => call.index === 7);
    expect(second).toBeDefined();
    expect(second?.id).toBeNull();
    expect(second?.argumentsAreValidJson).toBe(false);

    // The indices are not contiguous. Anything that treats them as an array
    // offset writes into the wrong slot or allocates seven empty calls.
    expect(calls.map((call) => call.index)).toEqual([0, 7]);
  });

  it('keeps serving after a malformed exchange — it degrades, it does not die', async () => {
    const mock = await start({ profile: 'hostile' });
    await streamChat(mock.url, { ...ask, tools: [weatherTool] });
    await postChat(mock.url, oversizedPrompt(4_096));
    expect((await getJson(mock.url, '/health')).status).toBe(200);
    expect((await postChat(mock.url, ask)).status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/* invariants that hold across the whole matrix                               */
/* -------------------------------------------------------------------------- */

describe('matrix-wide invariants', () => {
  it('every profile answers a plain question with a 200 and a finish reason', async () => {
    for (const name of PROFILE_NAMES) {
      const mock = await start({ profile: name });
      const response = await postChat(mock.url, ask);
      expect(response.status, name).toBe(200);
      expect(['stop', 'length', 'tool_calls']).toContain(
        chat(response.json).choices[0]?.finish_reason,
      );
    }
  });

  it('every non-vision profile rejects images with the same code', async () => {
    const nonVision: ProfileName[] = ['mid-local', 'small-local', 'hostile'];
    for (const name of nonVision) {
      const mock = await start({ profile: name });
      const response = await postChat(mock.url, imageTurn);
      expect(response.status, name).toBe(400);
      expect(errorCode(response.json), name).toBe('vision_not_supported');
    }
  });

  it('every profile enforces exactly the context window it advertises in /props', async () => {
    for (const name of PROFILE_NAMES) {
      const mock = await start({ profile: name });
      const props = await getJson(mock.url, '/props');
      const advertised = (
        props.json as { default_generation_settings: { n_ctx: number } }
      ).default_generation_settings.n_ctx;
      expect(advertised, name).toBe(mock.profile.contextWindow);

      const response = await postChat(mock.url, oversizedPrompt(advertised));
      expect(response.status, name).toBe(400);
      expect(errorCode(response.json), name).toBe('context_length_exceeded');
    }
  });

  it('every profile streams with the SSE content type and terminates', async () => {
    for (const name of PROFILE_NAMES) {
      const mock = await start({ profile: name });
      const stream = await streamChat(mock.url, ask);
      expect(stream.contentType, name).toContain('text/event-stream');
      expect(stream.events.length, name).toBeGreaterThan(0);
      // Whether or not [DONE] arrives, the body ends. Nothing hangs.
      expect(stream.raw.endsWith('\n\n'), name).toBe(true);
    }
  });

  it('the streamed text equals the non-streamed content on every profile', async () => {
    // True even for hostile — but only for a consumer that tolerates frames it
    // cannot parse. One that throws on the first bad frame loses the rest.
    for (const name of PROFILE_NAMES) {
      const mock = await start({ profile: name });
      const nonStreaming = chat((await postChat(mock.url, ask)).json);
      const stream = await streamChat(mock.url, ask);
      expect(stream.textContent, name).toBe(nonStreaming.choices[0]?.message.content ?? '');
    }
  });

  it('every profile truncates to max_tokens and reports finish_reason "length"', async () => {
    for (const name of PROFILE_NAMES) {
      const mock = await start({ profile: name });
      const response = await postChat(mock.url, { ...ask, max_tokens: 2 });
      expect(response.status, name).toBe(200);
      const choice = chat(response.json).choices[0];
      expect(choice?.finish_reason, name).toBe('length');
      expect((choice?.message.content ?? '').length, name).toBeLessThanOrEqual(8);
    }
  });
});
