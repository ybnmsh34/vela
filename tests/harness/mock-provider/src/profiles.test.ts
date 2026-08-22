import { describe, expect, it } from 'vitest';

import { PROFILES, PROFILE_NAMES, isProfileName, resolveProfile } from './profiles.ts';

describe('the capability matrix', () => {
  it('has exactly the four columns GATE M Part 1 names', () => {
    expect([...PROFILE_NAMES]).toEqual(['frontier', 'mid-local', 'small-local', 'hostile']);
    expect(Object.keys(PROFILES).sort()).toEqual(
      ['frontier', 'hostile', 'mid-local', 'small-local'],
    );
  });

  it('matches the published matrix row for row', () => {
    // If this table and docs/vela-progress.md ever disagree, one of them is
    // lying to a critic. The table is duplicated here on purpose.
    const asRow = (name: (typeof PROFILE_NAMES)[number]): Record<string, unknown> => {
      const p = PROFILES[name];
      return {
        toolCalling: p.toolCalling,
        vision: p.vision,
        contextWindow: p.contextWindow,
        structuredOutput: p.structuredOutput,
        reasoning: p.reasoning,
      };
    };

    expect(asRow('frontier')).toEqual({
      toolCalling: 'native',
      vision: true,
      contextWindow: 200_000,
      structuredOutput: 'honoured',
      reasoning: 'reasoning-content-field',
    });
    expect(asRow('mid-local')).toEqual({
      toolCalling: 'native',
      vision: false,
      contextWindow: 32_768,
      structuredOutput: 'ignored',
      reasoning: 'think-tags',
    });
    expect(asRow('small-local')).toEqual({
      toolCalling: 'none',
      vision: false,
      contextWindow: 8_192,
      structuredOutput: 'ignored',
      reasoning: 'none',
    });
    expect(asRow('hostile')).toEqual({
      toolCalling: 'malformed',
      vision: false,
      contextWindow: 4_096,
      structuredOutput: 'ignored',
      reasoning: 'unterminated-think-junk',
    });
  });

  it('gives every profile a distinct model id', () => {
    const ids = PROFILE_NAMES.map((name) => PROFILES[name].modelId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rejects names that are not columns of the matrix', () => {
    expect(isProfileName('frontier')).toBe(true);
    expect(isProfileName('gpt-4')).toBe(false);
  });

  it('lets a consumer vary one axis without inventing a fifth profile', () => {
    const noListing = resolveProfile('frontier', { modelListing: false });
    expect(noListing.modelListing).toBe(false);
    expect(noListing.contextWindow).toBe(200_000);
    // The name still identifies the column it came from.
    expect(noListing.name).toBe('frontier');
    // …and the base profile is untouched.
    expect(PROFILES.frontier.modelListing).toBe(true);
  });
});
