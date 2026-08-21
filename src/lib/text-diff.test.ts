/**
 * The line diff.
 *
 * The property worth testing is the one a greedy scan loses: a line nothing
 * touched is reported unchanged even when the lines around it moved. Most of the
 * rest is about the gutter numbers, which are what a reader navigates by.
 *
 * The last three cases are the ones this file exists for. They are about the
 * *cap*, and specifically about the difference between "too big to align" and
 * "everything changed" — a difference the module this replaced could not
 * express, and got wrong in the only direction that reaches a user.
 *
 * This file replaces the canvas feature's own diff test, which had seven cases.
 * Six carried over by name; the seventh — `falls back to a whole-file
 * replacement rather than freezing the panel` — did not, because the behaviour
 * it pinned was the defect. The assertions themselves did not move verbatim:
 * of that file's twelve `expect(` lines exactly two are byte-identical here
 * (the two `same[0]` / `same[1]` row assertions), and the rest were rewritten
 * against the new shape — bare `rows` became `diff.rows`, and each
 * `expect(summariseDiff(rows)).toEqual({ added, removed })` split into separate
 * `diff.added`, `diff.removed` and `diff.aligned` assertions, which is the whole
 * point of the replacement.
 */

import { describe, expect, it } from 'vitest';

import { MAXIMUM_ALIGNED_LINES, diffText } from './text-diff';

function numbered(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`).join('\n');
}

describe('a line diff between two texts', () => {
  it('reports nothing changed when nothing changed', () => {
    const diff = diffText('a\nb\nc', 'a\nb\nc');
    expect(diff.rows.every((row) => row.kind === 'same')).toBe(true);
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
    expect(diff.aligned).toBe(true);
  });

  it('keeps the untouched lines untouched when a line is inserted between them', () => {
    const diff = diffText('a\nc', 'a\nb\nc');
    expect(diff.rows.map((row) => `${row.kind}:${row.text}`)).toEqual([
      'same:a',
      'added:b',
      'same:c',
    ]);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(0);
  });

  it('reads a replaced line as the old one leaving and the new one arriving', () => {
    const diff = diffText('a\nb\nc', 'a\nB\nc');
    expect(diff.rows.map((row) => `${row.kind}:${row.text}`)).toEqual([
      'same:a',
      'removed:b',
      'added:B',
      'same:c',
    ]);
  });

  it('numbers each row on the side it exists in, and never numbers it zero', () => {
    const diff = diffText('a\nb', 'a\nx\nb');
    const same = diff.rows.filter((row) => row.kind === 'same');
    expect(same[0]).toEqual({ kind: 'same', text: 'a', leftLine: 1, rightLine: 1 });
    expect(same[1]).toEqual({ kind: 'same', text: 'b', leftLine: 2, rightLine: 3 });
    expect(diff.rows[1]).toEqual({ kind: 'added', text: 'x', rightLine: 2 });
  });

  it('reads CRLF as the same document as LF', () => {
    expect(diffText('a\r\nb', 'a\nb').rows.every((row) => row.kind === 'same')).toBe(true);
  });

  it('finds a common line the naive scan would lose', () => {
    // A line-by-line comparison reports every one of these as changed. The
    // longest common subsequence keeps `keep` aligned, which is the whole point.
    const diff = diffText('one\nkeep\ntwo', 'first\nsecond\nkeep\nthird');
    expect(diff.rows.filter((row) => row.kind === 'same').map((row) => row.text)).toEqual(['keep']);
  });

  describe('the common prefix and suffix, which the cap is measured after', () => {
    it('numbers a change in the middle of a long file from the top of the file', () => {
      const before = `${numbered('line', 30)}`;
      const after = before.replace('line15', 'CHANGED');
      const diff = diffText(before, after);

      expect(diff.aligned).toBe(true);
      expect(diff.added).toBe(1);
      expect(diff.removed).toBe(1);
      const removed = diff.rows.find((row) => row.kind === 'removed');
      const added = diff.rows.find((row) => row.kind === 'added');
      expect(removed).toEqual({ kind: 'removed', text: 'line15', leftLine: 16 });
      expect(added).toEqual({ kind: 'added', text: 'CHANGED', rightLine: 16 });
    });

    it('does not let the prefix and the suffix claim the same line twice', () => {
      // `a` against `a\na`: the prefix scan takes the only left-hand line, and a
      // suffix scan bounded by the *shorter file* rather than by what the prefix
      // left would take it a second time — producing a negative slice and
      // reporting an inserted line as no change at all.
      const diff = diffText('a', 'a\na');
      expect(diff.rows.map((row) => `${row.kind}:${row.text}`)).toEqual(['same:a', 'added:a']);
      expect(diff.added).toBe(1);
      expect(diff.removed).toBe(0);
    });

    it('reports two identical long texts as unchanged rather than as a rewrite', () => {
      // This is the case the module this replaced got wrong: both sides are over
      // the cap, nothing differs, and it answered "every line removed, every line
      // added" with no way for a caller to tell.
      const big = numbered('same', MAXIMUM_ALIGNED_LINES + 1);
      const diff = diffText(big, big);

      expect(diff.aligned).toBe(true);
      expect(diff.added).toBe(0);
      expect(diff.removed).toBe(0);
      expect(diff.rows.every((row) => row.kind === 'same')).toBe(true);
    });

    it('still aligns when the changed core is exactly at the cap', () => {
      const before = `head\n${numbered('L', MAXIMUM_ALIGNED_LINES)}\ntail`;
      const after = `head\nR0\nR1\nR2\ntail`;
      const diff = diffText(before, after);

      expect(diff.aligned).toBe(true);
      expect(diff.rows[0]).toEqual({ kind: 'same', text: 'head', leftLine: 1, rightLine: 1 });
      expect(diff.rows.at(-1)).toEqual({
        kind: 'same',
        text: 'tail',
        leftLine: MAXIMUM_ALIGNED_LINES + 2,
        rightLine: 5,
      });
    });
  });

  describe('when the changed core is past the cap', () => {
    const before = numbered('L', MAXIMUM_ALIGNED_LINES + 1);
    const after = numbered('R', MAXIMUM_ALIGNED_LINES + 1);

    it('says so, rather than passing the fallback off as an alignment', () => {
      expect(diffText(before, after).aligned).toBe(false);
    });

    it('still shows both texts, so what is lost is the alignment and not the content', () => {
      const diff = diffText(before, after);
      expect(diff.rows.filter((row) => row.kind === 'removed')).toHaveLength(
        MAXIMUM_ALIGNED_LINES + 1,
      );
      expect(diff.rows.filter((row) => row.kind === 'added')).toHaveLength(
        MAXIMUM_ALIGNED_LINES + 1,
      );
      expect(diff.rows.some((row) => row.kind === 'same')).toBe(false);
    });
  });
});
