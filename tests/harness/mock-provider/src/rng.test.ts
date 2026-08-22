import { describe, expect, it } from 'vitest';

import { createRng, fnv1a32, hex32, pick } from './rng.ts';

describe('determinism primitives', () => {
  it('produces the same sequence for the same seed, every time', () => {
    const a = createRng(12345);
    const b = createRng(12345);
    const first = Array.from({ length: 8 }, () => a());
    const second = Array.from({ length: 8 }, () => b());
    expect(first).toEqual(second);
  });

  it('produces a different sequence for a different seed', () => {
    const a = createRng(1);
    const b = createRng(2);
    expect(a()).not.toEqual(b());
  });

  it('stays inside [0, 1)', () => {
    const rng = createRng(99);
    for (let i = 0; i < 500; i += 1) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('hashes strings stably and differently', () => {
    expect(fnv1a32('vela')).toBe(fnv1a32('vela'));
    expect(fnv1a32('vela')).not.toBe(fnv1a32('velb'));
    expect(hex32(fnv1a32('vela'))).toMatch(/^[0-9a-f]{8}$/u);
  });

  it('never returns undefined from pick, and refuses an empty list', () => {
    const rng = createRng(7);
    for (let i = 0; i < 100; i += 1) {
      expect(pick(rng, ['a', 'b', 'c'])).toMatch(/^[abc]$/u);
    }
    expect(() => pick(rng, [])).toThrow(/empty list/u);
  });
});
