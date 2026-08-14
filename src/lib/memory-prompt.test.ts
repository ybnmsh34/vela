import { describe, expect, it } from 'vitest';

import { approxTokens } from './context-budget';
import {
  ASSUMED_WINDOW_TOKENS,
  MEMORY_BUDGET_FRACTION,
  MEMORY_BUDGET_MAX_TOKENS,
  buildMemoryBlock,
  memoryBudgetTokens,
  memorySystemMessage,
} from './memory-prompt';
import type { MemoryCategory, MemoryEntry } from '@/platform/contract';

function entry(
  id: string,
  content: string,
  category: MemoryCategory = 'techPrefs',
  pinned = false,
): MemoryEntry {
  return {
    id,
    scope: { kind: 'global' },
    category,
    content,
    pinned,
    sourceConversationId: null,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

describe('the memory budget', () => {
  it('is a fraction of the window, so a small model is not swamped', () => {
    // The failure MEM-1's rule exists to prevent: a fixed 25 KB block is a
    // quarter of a 4k window. At 5% it is 204 tokens.
    expect(memoryBudgetTokens(4_096)).toBe(Math.floor(4_096 * MEMORY_BUDGET_FRACTION));
    expect(memoryBudgetTokens(4_096)).toBeLessThan(300);
  });

  it('stops growing at the absolute cap, so a huge window is not a licence', () => {
    expect(memoryBudgetTokens(200_000)).toBe(MEMORY_BUDGET_MAX_TOKENS);
    expect(memoryBudgetTokens(10_000_000)).toBe(MEMORY_BUDGET_MAX_TOKENS);
  });

  it('assumes the smallest window worth supporting when the endpoint reported none', () => {
    // Guessing small costs a few remembered facts; guessing large costs the
    // turn. `null` and a nonsense window take the same conservative branch.
    const assumed = Math.floor(ASSUMED_WINDOW_TOKENS * MEMORY_BUDGET_FRACTION);
    expect(memoryBudgetTokens(null)).toBe(assumed);
    expect(memoryBudgetTokens(0)).toBe(assumed);
    expect(memoryBudgetTokens(-5)).toBe(assumed);
  });
});

describe('the memory block', () => {
  it('is null when there is nothing remembered, so no empty system message is sent', () => {
    expect(buildMemoryBlock([], 1_000)).toBeNull();
    expect(memorySystemMessage([], 200_000)).toBeNull();
  });

  it('groups entries under the headings the renderer owns', () => {
    const block = buildMemoryBlock(
      [
        entry('a', 'uses pnpm', 'techPrefs'),
        entry('b', 'answer tersely', 'commsPrefs'),
        entry('c', 'prefers TypeScript', 'techPrefs'),
      ],
      1_000,
    );

    expect(block?.text).toContain('## Communication preferences');
    expect(block?.text).toContain('## Technical preferences');
    expect(block?.text).toContain('- uses pnpm');
    expect(block?.text).toContain('- prefers TypeScript');
    // One heading per category, not one per entry.
    expect(block?.text.match(/## Technical preferences/gu)).toHaveLength(1);
  });

  it('says the block is background rather than instructions', () => {
    // A model that reads remembered facts as a fresh set of orders answers the
    // memory instead of the question.
    const block = buildMemoryBlock([entry('a', 'uses pnpm')], 1_000);
    expect(block?.text).toMatch(/not as instructions/iu);
  });

  it('collapses a multi-line memory onto one line so it stays one bullet', () => {
    const block = buildMemoryBlock([entry('a', 'first line\nsecond line')], 1_000);
    expect(block?.text).toContain('- first line second line');
    expect(block?.text.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(1);
  });

  it('takes the longest prefix that fits and reports what it left out', () => {
    // Entries arrive ranked (pinned, then recency). Taking a prefix keeps that
    // ranking; picking the best-fitting subset would quietly reorder it.
    const entries = [
      entry('a', 'a'.repeat(400)),
      entry('b', 'b'.repeat(400)),
      entry('c', 'c'.repeat(400)),
    ];
    const block = buildMemoryBlock(entries, approxTokens('x'.repeat(600)));

    expect(block).not.toBeNull();
    expect(block?.included.map((item) => item.id)).toEqual(['a']);
    expect(block?.omitted.map((item) => item.id)).toEqual(['b', 'c']);
    expect(block?.text).not.toContain('b'.repeat(400));
  });

  it('sends nothing at all rather than a block too big for the budget', () => {
    // Not a truncated block, and not one entry over budget: a system message
    // that eats the window is the failure the budget exists to prevent.
    expect(buildMemoryBlock([entry('a', 'x'.repeat(10_000))], 10)).toBeNull();
  });

  it('never exceeds the budget it was given', () => {
    const entries = Array.from({ length: 40 }, (_, index) =>
      entry(`e${String(index)}`, `remembered fact number ${String(index)}`),
    );
    const budget = memoryBudgetTokens(4_096);
    const block = buildMemoryBlock(entries, budget);

    expect(block).not.toBeNull();
    expect(block?.approxTokens).toBeLessThanOrEqual(budget);
    expect(approxTokens(block?.text ?? '')).toBeLessThanOrEqual(budget);
    // The point of the cap: not everything fitted, and what did not is named.
    expect(block?.omitted.length).toBeGreaterThan(0);
  });

  it('becomes a system message, never a user one', () => {
    // Folding memory into the user's own text would make it indistinguishable
    // from something they typed — in the transcript, on retry, and on disk.
    const message = memorySystemMessage([entry('a', 'uses pnpm')], 200_000);
    expect(message?.role).toBe('system');
    expect(message?.text).toContain('- uses pnpm');
  });
});
