/**
 * The one message a review round sends.
 *
 * Two of these are about ordering and they are the ones worth having: a review
 * read out of order is a different review, and the two ways to get the order
 * wrong here — sorting by the comment id, and an unstable tie-break — both
 * produce output that looks plausible.
 *
 * The rest are about the coordinate. `path:line` is the one part of the message
 * that goes stale the moment the file is edited above it, and the version that
 * printed `comment.line` printed a coordinate it had never re-checked.
 */

import { describe, expect, it } from 'vitest';

import { diffText } from '@/lib/text-diff';
import type { LineComment } from '@/state/code-workspace-store';

import { anchorComments, composeReviewMessage } from './review-comments';

function comment(partial: Partial<LineComment> & { readonly id: string }): LineComment {
  return {
    path: 'src/a.ts',
    side: 'right',
    line: 1,
    text: 'const x = 1;',
    body: 'why',
    ...partial,
  };
}

/**
 * A comment that still points where it was written. Most of these tests are
 * about the message rather than about the anchoring, and this is what "the file
 * has not moved" looks like as an input.
 */
function put(comment: LineComment) {
  return { comment, line: comment.line };
}

/** The one file's diff, keyed the way the pane keys it. */
function diffOf(before: string, after: string, path = 'src/a.ts') {
  return new Map([[path, diffText(before, after).rows]]);
}

describe('composing a review round', () => {
  it('refuses to make a message out of no comments', () => {
    expect(composeReviewMessage([])).toBeNull();
  });

  it('names the file, the line, the side and quotes the line back', () => {
    const message = composeReviewMessage([
      put(
        comment({
          id: 'comment-1',
          path: 'src/app.ts',
          line: 12,
          text: 'let total = 0;',
          body: 'const?',
        }),
      ),
    ]);

    expect(message).toBe('One comment on the diff:\n\nsrc/app.ts:12 (after)\n> let total = 0;\nconst?');
  });

  it('says "before" for a removed line, which is what the side means', () => {
    const message = composeReviewMessage([
      put(comment({ id: 'comment-1', side: 'left', line: 4, text: 'old();', body: 'why did this go?' })),
    ]);

    expect(message).toContain('src/a.ts:4 (before)');
  });

  it('sends every comment in one message rather than one message each', () => {
    const message = composeReviewMessage([
      put(comment({ id: 'comment-1', line: 1 })),
      put(comment({ id: 'comment-2', line: 2 })),
      put(comment({ id: 'comment-3', path: 'src/b.ts', line: 3 })),
    ]);

    expect(message).toContain('3 comments on the diff, across 2 files:');
    expect(message?.split('src/').length).toBe(4);
  });

  it('orders by file and then by line, not by the order they were written', () => {
    const message = composeReviewMessage([
      put(comment({ id: 'comment-1', path: 'src/z.ts', line: 9, body: 'third' })),
      put(comment({ id: 'comment-2', path: 'src/a.ts', line: 40, body: 'second' })),
      put(comment({ id: 'comment-3', path: 'src/a.ts', line: 2, body: 'first' })),
    ]);

    expect(message?.indexOf('first')).toBeLessThan(message?.indexOf('second') ?? -1);
    expect(message?.indexOf('second')).toBeLessThan(message?.indexOf('third') ?? -1);
  });

  it('keeps two comments on one line in the order the reviewer wrote them', () => {
    // Sorting on the id would put `comment-10` before `comment-2`; an unstable
    // tie-break would put either first. Both read as the reviewer contradicting
    // themselves.
    const message = composeReviewMessage([
      put(comment({ id: 'comment-2', line: 5, body: 'the thought' })),
      put(comment({ id: 'comment-10', line: 5, body: 'and its qualification' })),
    ]);

    expect(message?.indexOf('the thought')).toBeLessThan(
      message?.indexOf('and its qualification') ?? -1,
    );
  });

  it('counts one file as a file rather than as files', () => {
    const message = composeReviewMessage([
      put(comment({ id: 'comment-1', line: 1 })),
      put(comment({ id: 'comment-2', line: 2 })),
    ]);

    expect(message).toContain('across 1 file:');
  });
});

describe('re-finding the line a comment quotes', () => {
  /**
   * The defect this exists for: a comment written on `BETA` at right-hand line
   * 2, one line inserted above it, and the message still said
   * `src/a.ts:2 (after)` — quoting `BETA` against a line that by then said
   * `INSERTED`. `saveFile` clearing a file's comments does not reach this,
   * because an edit does not erase the diff; it renumbers it.
   */
  const written = comment({ id: 'comment-1', line: 2, text: 'BETA', body: 'name it' });

  it('follows the quoted line when a line is inserted above it', () => {
    const anchored = anchorComments([written], diffOf('alpha', 'alpha\nINSERTED\nBETA'));

    expect(anchored[0]?.line).toBe(3);
    expect(composeReviewMessage(anchored)).toContain('src/a.ts:3 (after)');
  });

  it('leaves it where it is when nothing moved', () => {
    const [entry] = anchorComments([written], diffOf('alpha', 'alpha\nBETA'));

    expect(entry?.line).toBe(2);
  });

  it('says the line is gone rather than naming one that now says something else', () => {
    const anchored = anchorComments([written], diffOf('alpha', 'alpha\nGAMMA'));

    expect(anchored[0]?.line).toBeNull();
    const message = composeReviewMessage(anchored);
    expect(message).toContain('the line this quotes is no longer in the diff');
    expect(message).not.toContain('src/a.ts:2');
    expect(message).toContain('BETA');
  });

  it('has no line for a file the session no longer has a diff for', () => {
    const [entry] = anchorComments([written], new Map());

    expect(entry?.line).toBeNull();
  });

  it('takes the nearest of several rows quoting the same text', () => {
    // A repeated line is the ordinary case, not a contrived one. The heuristic
    // is named in the module header; this is what it does.
    const rows = diffOf('x', 'x\n}\nkeep\n}');
    const near = comment({ id: 'comment-1', line: 4, text: '}', body: 'this one' });

    expect(anchorComments([near], rows)[0]?.line).toBe(4);
    expect(anchorComments([{ ...near, line: 2 }], rows)[0]?.line).toBe(2);
  });

  it('does not match a removed line against an added one that reads the same', () => {
    // Side is part of the anchor. A line deleted from the left and an identical
    // line added on the right are two different things to comment on.
    const removed = comment({ id: 'comment-1', side: 'left', line: 1, text: 'one', body: 'why' });

    expect(anchorComments([removed], diffOf('zero', 'one'))[0]?.line).toBeNull();
  });

  it('sorts a comment whose line is gone after the ones that still have one', () => {
    const message = composeReviewMessage([
      { comment: comment({ id: 'comment-1', line: 9, body: 'orphan' }), line: null },
      { comment: comment({ id: 'comment-2', line: 2, body: 'still here' }), line: 2 },
    ]);

    expect(message?.indexOf('still here')).toBeLessThan(message?.indexOf('orphan') ?? -1);
  });
});
