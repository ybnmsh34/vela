import { describe, expect, it } from 'vitest';

import { approxTokens, approxTurnTokens, contextBudget } from './context-budget';

describe('approxTokens', () => {
  it('counts nothing for an empty string', () => {
    expect(approxTokens('')).toBe(0);
  });

  it('counts ASCII at roughly four characters per token', () => {
    expect(approxTokens('a'.repeat(400))).toBe(100);
  });

  it('never under-counts non-ASCII text, which a length/4 rule would', () => {
    // The failure this guards: a Japanese user told they have four times the
    // room they have, then losing a message to a refused turn.
    const japanese = 'こんにちは世界';
    expect(approxTokens(japanese)).toBe(japanese.length);
    expect(approxTokens(japanese)).toBeGreaterThan(Math.ceil(japanese.length / 4));
  });

  it('counts an astral character once rather than per UTF-16 unit', () => {
    // '👋' is two UTF-16 units and one code point. Iterating the string, not
    // indexing it, is what keeps this from double-counting every emoji.
    expect('👋'.length).toBe(2);
    expect(approxTokens('👋')).toBe(1);
  });
});

describe('approxTurnTokens', () => {
  it('charges every message for the role wrapper the user cannot see', () => {
    const one = approxTurnTokens(['']);
    expect(one).toBeGreaterThan(0);
    expect(approxTurnTokens(['', ''])).toBe(one * 2);
  });
});

describe('contextBudget', () => {
  it('reports unknown rather than drawing a bar against a guessed window', () => {
    const budget = contextBudget(null, ['hello']);
    expect(budget.verdict).toBe('unknown');
    expect(budget.windowTokens).toBeNull();
    expect(budget.fraction).toBeNull();
    expect(budget.approxRemainingTokens).toBeNull();
    // The estimate is still produced: "about 5 tokens, window unknown" is more
    // useful than nothing at all.
    expect(budget.approxUsedTokens).toBeGreaterThan(0);
  });

  it('is comfortable well inside the window', () => {
    const budget = contextBudget(4096, ['a'.repeat(400)]);
    expect(budget.verdict).toBe('comfortable');
    expect(budget.approxRemainingTokens).toBe(4096 - budget.approxUsedTokens);
  });

  it('turns tight before it turns over, so the warning arrives in time to act', () => {
    const window = 1000;
    // ~800 tokens: exactly the threshold.
    const tight = contextBudget(window, ['a'.repeat(4 * 796)]);
    expect(tight.verdict).toBe('tight');
    expect(tight.fraction).toBeGreaterThanOrEqual(0.8);
    expect(tight.fraction).toBeLessThan(1);
  });

  it('says over — and keeps a fraction above one rather than clamping it', () => {
    const budget = contextBudget(100, ['a'.repeat(4 * 400)]);
    expect(budget.verdict).toBe('over');
    expect(budget.fraction).toBeGreaterThan(1);
    // Remaining is floored at zero: "-300 left" is not a sentence.
    expect(budget.approxRemainingTokens).toBe(0);
  });

  it('treats a zero or negative window as no window at all', () => {
    expect(contextBudget(0, ['x']).verdict).toBe('unknown');
    expect(contextBudget(-1, ['x']).windowTokens).toBeNull();
  });
});
