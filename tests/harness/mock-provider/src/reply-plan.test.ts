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

describe('the #markdown directive', () => {
  const rich = { messages: [{ role: 'user', content: '#markdown which model should I run?' }] };

  it('answers with the rich document instead of filler prose', () => {
    // The reading-surface case exists because every profile otherwise answers
    // with one paragraph, and a gate that never renders a heading cannot see
    // that all six heading levels were set at the same size.
    const built = plan('frontier', rich);
    expect(built.content).toContain('# Choosing a local model');
    expect(built.content).toContain('| `Q4_K_M` |');
    expect(built.content).toContain('```bash');
    expect(built.content).not.toContain('Mock frontier reply to:');
  });

  it('serves the same document on every profile, through that profile’s defects', () => {
    for (const name of PROFILE_NAMES) {
      const built = plan(name, rich);
      expect(built.content, name).toContain('## What decides the answer');
      expect(built.contentFragments.join(''), name).toBe(built.content);
    }
    // The hostile profile still never closes its thinking block, so the
    // document arrives through the salvage path rather than around it.
    expect(plan('hostile', rich).content).not.toContain('</think>');
  });

  it('changes nothing for a prompt that did not ask for it', () => {
    // The guarantee that makes this safe to add: every recorded transcript and
    // every existing matrix case is byte-identical.
    const built = plan('frontier', ask);
    expect(built.content).toContain('Mock frontier reply to:');
    expect(built.content).not.toContain('# Choosing a local model');
  });

  it('still yields to a requested schema, because JSON was asked for explicitly', () => {
    const built = plan('frontier', {
      ...rich,
      response_format: { type: 'json_object' },
    });
    expect(() => JSON.parse(built.content) as unknown).not.toThrow();
  });

  it('is deterministic, like every other reply', () => {
    expect(plan('mid-local', rich)).toEqual(plan('mid-local', rich));
  });
});

describe('the #headings directive', () => {
  const ladder = { messages: [{ role: 'user', content: '#headings show me the type scale' }] };

  it('emits all six heading levels, which #markdown does not', () => {
    // The evidence gap this closes: no artifact in the set rendered h1, h3, h4,
    // h5 or h6, so "the scale collapses below h3" was a source reading rather
    // than an observation — the same gap that let the raw-markdown thinking
    // block survive a full cloud review.
    const built = plan('frontier', ladder);
    for (const hashes of ['# ', '## ', '### ', '#### ', '##### ', '###### ']) {
      expect(built.content.split('\n').some((line) => line.startsWith(hashes)), hashes).toBe(true);
    }
    expect(plan('frontier', { messages: [{ role: 'user', content: '#markdown x' }] }).content).not.toContain('\n##### ');
  });

  it('puts a bold run beside the deepest levels, which is the comparison', () => {
    const lines = plan('frontier', ladder).content.split('\n');
    for (const marker of ['##### ', '###### ']) {
      const at = lines.findIndex((line) => line.startsWith(marker));
      expect(at, marker).toBeGreaterThan(-1);
      expect(lines.slice(at + 1, at + 8).join(' '), marker).toContain('**');
    }
  });

  it('changes nothing for a prompt that did not ask for it', () => {
    expect(plan('frontier', ask).content).toContain('Mock frontier reply to:');
  });
});

describe('the #thinkmd directive', () => {
  const thinking = { messages: [{ role: 'user', content: '#thinkmd weigh the options' }] };

  it('puts markdown in the reasoning channel, where real models put it', () => {
    // Narration was plain prose, so no run here had ever rendered a thinking
    // block containing a bold lead-in or a bullet — which is exactly why the
    // block printing `**Deconstruct the requirements:**` at the user could not
    // be seen from this matrix and had to be found on a real machine.
    // `frontier` carries reasoning in its own field, so the markdown lands
    // there and never touches the answer channel.
    const built = plan('frontier', thinking);
    expect(built.reasoningText).toContain('**Deconstruct the requirements:**');
    expect(built.reasoningText).toContain('*   The user wants');
    expect(built.content).not.toContain('**Deconstruct');
  });

  it('reaches the inline-tag profiles through their own markup', () => {
    // `mid-local` narrates inside <think>…</think> rather than in a field, so
    // the same markdown has to survive the core's tag-stripping salvage path
    // before it can reach the block. Reaching the block by a second route is
    // the point: that is where the renderer used to print it as source.
    const built = plan('mid-local', thinking);
    expect(built.reasoningText).toBe('');
    expect(built.content).toContain('**Deconstruct the requirements:**');
  });

  it('changes nothing for a prompt that did not ask for it', () => {
    expect(plan('frontier', ask).reasoningText).toContain('Considering the request');
  });
});
