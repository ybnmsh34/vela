/**
 * Determinism, not randomness.
 *
 * Every byte this harness emits is a pure function of (seed, profile, exact
 * request body). The same request always produces a byte-identical response,
 * including ids and timestamps, so a transcript can be diffed as a regression
 * baseline and a flaky test can never be blamed on "the mock".
 *
 * mulberry32 — 32-bit, no dependencies, well-distributed enough for choosing
 * filler words. It is not a CSPRNG and must never be used as one.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a over UTF-16 code units. Stable across runs and platforms. */
export function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
    hash ^= input.charCodeAt(i) >>> 8;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

export type Rng = () => number;

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Never returns `undefined`: callers pass non-empty banks and we assert it. */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) {
    throw new Error('pick() called with an empty list');
  }
  const index = Math.floor(rng() * items.length) % items.length;
  const chosen = items[index];
  if (chosen === undefined) {
    throw new Error(`pick() produced an out-of-range index ${String(index)}`);
  }
  return chosen;
}

/** Lowercase hex of a 32-bit value, zero-padded — used for stable ids. */
export function hex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}
