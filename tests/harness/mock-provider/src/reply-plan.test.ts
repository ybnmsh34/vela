import { describe, expect, it } from 'vitest';

import { parseChatRequest } from './parse-request.ts';
import { PROFILE_NAMES, resolveProfile, type ProfileName } from './profiles.ts';
import { buildReplyPlan, fragmentText, sampleFromSchema, DEFAULT_CREATED } from './reply-plan.ts';
import { createRng } from './rng.ts';

function plan(name: ProfileName, body: Record<string, unknown>): ReturnType<typeof buildReplyPlan> {
  const request = parseChatRequest(JSON.stringify(body));
  return buildReplyPlan(resolveProfile(name), request, {
    seed: 1,
    now: () => DEFAULT_CREATED,
  });
}

const ask = { messages: [{ role: 'user', content: 'what is the weather in Berlin' }] };

describe('the reply plan', () => {
  it('keeps fragments and content in lockstep on every profile', () => {
    for (const name of PROFILE_NAMES) {
      const built = plan(name, ask);
      expect(built.contentFragments.join('')).toBe(built.content);
    }
  });

  it('is a pure function of the request bytes', () => {
    const a = plan('hostile', ask);
    const b = plan('hostile', ask);
    expect(a).toEqual(b);
    expect(a.id).toBe(b.id);
  });

  it('gives different requests different ids', () => {
    const a = plan('frontier', ask);
    const b = plan('frontier', { messages: [{ role: 'user', content: 'something else' }] });
    expect(a.id).not.toBe(b.id);
  });

  it('splits the closing </think> tag across two fragments on think-tag profiles', () => {
    const built = plan('mid-local', ask);
    expect(built.content).toContain('<think>');
    expect(built.content).toContain('</think>');
    // No single fragment carries the whole closing tag: an incremental parser
    // that only looks inside one frame will miss it.
    expect(built.contentFragments.some((f) => f.includes('</think>'))).toBe(false);
  });

  it('never closes the think block on the hostile profile', () => {
    const built = plan('hostile', ask);
    expect(built.content).toContain('<think>');
    expect(built.content).not.toContain('</think>');
    // …and opens a second one inside the first.
    expect(built.content.split('<think>').length - 1).toBeGreaterThanOrEqual(2);
  });

  it('emits no reasoning at all on the small-local profile', () => {
    const built = plan('small-local', ask);
    expect(built.reasoningText).toBe('');
    expect(built.content).not.toContain('<think>');
  });

  it('carries reasoning in a separate field on the frontier profile', () => {
    const built = plan('frontier', ask);
    expect(built.reasoningText.length).toBeGreaterThan(0);
    expect(built.content).not.toContain('<think>');
  });

  it('truncates to max_tokens and says so with finish_reason length', () => {
    const built = plan('frontier', { ...ask, max_tokens: 3 });
    expect(built.truncated).toBe(true);
    expect(built.finishReason).toBe('length');
    expect(built.content.length).toBeLessThanOrEqual(3 * 4);
  });

  it('produces valid JSON tool arguments on native profiles', () => {
    const built = plan('mid-local', {
      ...ask,
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' }, days: { type: 'integer' } },
            },
          },
        },
      ],
    });
    expect(built.toolCalls).toHaveLength(1);
    const call = built.toolCalls[0];
    expect(call?.name).toBe('get_weather');
    expect(() => JSON.parse(call?.argumentsText ?? '')).not.toThrow();
    expect(built.finishReason).toBe('tool_calls');
    // A native tool-calling turn carries no prose, like the real APIs.
    expect(built.content).toBe('');
  });

  it('produces broken tool arguments and a bad discriminator on hostile', () => {
    const built = plan('hostile', {
      ...ask,
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ],
    });
    expect(built.toolCalls).toHaveLength(2);
    const [first, second] = built.toolCalls;
    expect(() => JSON.parse(first?.argumentsText ?? '')).toThrow();
    expect(second?.omitId).toBe(true);
    expect(second?.typeField).toBe('funktion');
    expect(second?.index).toBe(7);
    // …and unlike the native profiles it sends prose in the same turn.
    expect(built.content.length).toBeGreaterThan(0);
  });

  it('answers every offered tool at once on native profiles — the parallel shape', () => {
    // Parallel tool calling is the commonest tool-calling shape in the wild and
    // was, until GATE M Part 1 (Phase B), impossible to express here.
    for (const name of ['frontier', 'mid-local'] as const) {
      const built = plan(name, {
        ...ask,
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              parameters: { type: 'object', properties: { city: { type: 'string' } } },
            },
          },
          {
            type: 'function',
            function: {
              name: 'get_local_time',
              parameters: { type: 'object', properties: { timezone: { type: 'string' } } },
            },
          },
        ],
      });
      expect(built.parallelToolCalls, name).toBe(true);
      expect(built.toolCalls.map((call) => call.name), name).toEqual([
        'get_weather',
        'get_local_time',
      ]);
      expect(built.toolCalls.map((call) => call.index), name).toEqual([0, 1]);
      // Distinct ids: a batch that collapsed into one slot is detectable.
      expect(new Set(built.toolCalls.map((call) => call.id)).size, name).toBe(2);
      for (const call of built.toolCalls) {
        expect(() => JSON.parse(call.argumentsText), name).not.toThrow();
        expect(call.omitId, name).toBe(false);
        expect(call.typeField, name).toBe('function');
      }
    }
  });

  it('does not call one offered tool a parallel batch', () => {
    const built = plan('frontier', {
      ...ask,
      tools: [{ type: 'function', function: { name: 'get_weather' } }],
    });
    expect(built.toolCalls).toHaveLength(1);
    expect(built.parallelToolCalls).toBe(false);
    // The id of a single call is unsuffixed — the committed transcripts carry
    // this exact form and adding the parallel shape must not rewrite them.
    expect(built.toolCalls[0]?.id).toMatch(/^call_[0-9a-f]{8}$/u);
  });

  it('breaks only the middle call of a parallel batch on hostile', () => {
    const built = plan('hostile', {
      ...ask,
      tools: [
        { type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } },
        { type: 'function', function: { name: 'get_local_time', parameters: { type: 'object', properties: { timezone: { type: 'string' } } } } },
      ],
    });
    expect(built.parallelToolCalls).toBe(true);
    expect(built.toolCalls).toHaveLength(3);
    const [first, broken, third] = built.toolCalls;

    expect(() => JSON.parse(first?.argumentsText ?? '')).not.toThrow();
    expect(() => JSON.parse(broken?.argumentsText ?? '')).toThrow();
    expect(broken?.omitId).toBe(true);
    expect(broken?.typeField).toBe('funktion');
    expect(() => JSON.parse(third?.argumentsText ?? '')).not.toThrow();

    // Two of three survive intact, so "N-1 calls vanished" is a countable
    // failure rather than an invisible one — and the indices are not contiguous.
    expect(built.toolCalls.map((call) => call.index)).toEqual([0, 1, 4]);
  });

  it('emits no tool calls at all when the profile has no tool support', () => {
    const built = plan('small-local', {
      ...ask,
      tools: [{ type: 'function', function: { name: 'get_weather' } }],
    });
    expect(built.toolCalls).toEqual([]);
    expect(built.finishReason).toBe('stop');
  });

  it('honours tool_choice: none even where tools are supported', () => {
    const built = plan('frontier', {
      ...ask,
      tools: [{ type: 'function', function: { name: 'get_weather' } }],
      tool_choice: 'none',
    });
    expect(built.toolCalls).toEqual([]);
  });
});

describe('schema sampling', () => {
  it('produces a value for every declared property, sorted for stability', () => {
    const value = sampleFromSchema(
      {
        type: 'object',
        properties: {
          zeta: { type: 'boolean' },
          alpha: { type: 'string' },
          count: { type: 'integer' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
      createRng(5),
    ) as Record<string, unknown>;

    expect(Object.keys(value)).toEqual(['alpha', 'count', 'tags', 'zeta']);
    expect(typeof value['alpha']).toBe('string');
    expect(Number.isInteger(value['count'])).toBe(true);
    expect(Array.isArray(value['tags'])).toBe(true);
    expect(typeof value['zeta']).toBe('boolean');
  });

  it('prefers the first enum member so output is stable', () => {
    expect(sampleFromSchema({ enum: ['celsius', 'fahrenheit'] }, createRng(1))).toBe('celsius');
  });

  it('stops recursing on a self-referential schema instead of hanging', () => {
    const recursive: Record<string, unknown> = { type: 'object' };
    recursive['properties'] = { child: recursive };
    expect(() => sampleFromSchema(recursive, createRng(1))).not.toThrow();
  });
});

describe('fragmentation', () => {
  it('splits into fixed-size pieces that rejoin exactly', () => {
    expect(fragmentText('abcdefg', 3)).toEqual(['abc', 'def', 'g']);
    expect(fragmentText('', 3)).toEqual([]);
  });
});
