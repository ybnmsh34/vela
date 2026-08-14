/**
 * The version diff.
 *
 * The property worth testing is the one a greedy scan loses: a line the model
 * did not touch is reported unchanged even when the lines around it moved. Every
 * other assertion here is about the gutter numbers, which are what a reader
 * actually navigates by.
 */

import { describe, expect, it } from 'vitest';

import { MAXIMUM_DIFF_LINES, diffLines, summariseDiff } from './diff';

describe('a diff between two revisions', () => {
  it('reports nothing changed when nothing changed', () => {
    const rows = diffLines('a\nb\nc', 'a\nb\nc');
    expect(rows.every((row) => row.kind === 'same')).toBe(true);
    expect(summariseDiff(rows)).toEqual({ added: 0, removed: 0 });
  });

  it('keeps the untouched lines untouched when a line is inserted between them', () => {
    const rows = diffLines('a\nc', 'a\nb\nc');
    expect(rows.map((row) => `${row.kind}:${row.text}`)).toEqual(['same:a', 'added:b', 'same:c']);
    expect(summariseDiff(rows)).toEqual({ added: 1, removed: 0 });
  });

  it('reads a replaced line as the old one leaving and the new one arriving', () => {
    const rows = diffLines('a\nb\nc', 'a\nB\nc');
    expect(rows.map((row) => `${row.kind}:${row.text}`)).toEqual([
      'same:a',
      'removed:b',
      'added:B',
      'same:c',
    ]);
  });

  it('numbers each row on the side it exists in, and never numbers it zero', () => {
    const rows = diffLines('a\nb', 'a\nx\nb');
    const same = rows.filter((row) => row.kind === 'same');
    expect(same[0]).toEqual({ kind: 'same', text: 'a', leftLine: 1, rightLine: 1 });
    expect(same[1]).toEqual({ kind: 'same', text: 'b', leftLine: 2, rightLine: 3 });
    expect(rows[1]).toEqual({ kind: 'added', text: 'x', rightLine: 2 });
  });

  it('reads CRLF as the same document as LF', () => {
    expect(diffLines('a\r\nb', 'a\nb').every((row) => row.kind === 'same')).toBe(true);
  });

  it('finds a common line the naive scan would lose', () => {
    // A line-by-line comparison reports every one of these as changed. The
    // longest common subsequence keeps `keep` aligned, which is the whole point.
    const rows = diffLines('one\nkeep\ntwo', 'first\nsecond\nkeep\nthird');
    expect(rows.filter((row) => row.kind === 'same').map((row) => row.text)).toEqual(['keep']);
  });

  it('falls back to a whole-file replacement rather than freezing the panel', () => {
    const big = Array.from({ length: MAXIMUM_DIFF_LINES + 1 }, (_, index) => String(index)).join(
      '\n',
    );
    const rows = diffLines(big, big);
    expect(rows.some((row) => row.kind === 'same')).toBe(false);
    expect(summariseDiff(rows)).toEqual({
      added: MAXIMUM_DIFF_LINES + 1,
      removed: MAXIMUM_DIFF_LINES + 1,
    });
  });
});
