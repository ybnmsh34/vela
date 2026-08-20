/**
 * The one message a review round sends.
 *
 * Two of these are about ordering and they are the ones worth having: a review
 * read out of order is a different review, and the two ways to get the order
 * wrong here — sorting by the comment id, and an unstable tie-break — both
 * produce output that looks plausible.
 */

import { describe, expect, it } from 'vitest';

import type { LineComment } from '@/state/code-workspace-store';

import { composeReviewMessage } from './review-comments';

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

describe('composing a review round', () => {
  it('refuses to make a message out of no comments', () => {
    expect(composeReviewMessage([])).toBeNull();
  });

  it('names the file, the line, the side and quotes the line back', () => {
    const message = composeReviewMessage([
      comment({ id: 'comment-1', path: 'src/app.ts', line: 12, text: 'let total = 0;', body: 'const?' }),
    ]);

    expect(message).toBe('One comment on the diff:\n\nsrc/app.ts:12 (after)\n> let total = 0;\nconst?');
  });

  it('says "before" for a removed line, which is what the side means', () => {
    const message = composeReviewMessage([
      comment({ id: 'comment-1', side: 'left', line: 4, text: 'old();', body: 'why did this go?' }),
    ]);

    expect(message).toContain('src/a.ts:4 (before)');
  });

  it('sends every comment in one message rather than one message each', () => {
    const message = composeReviewMessage([
      comment({ id: 'comment-1', line: 1 }),
      comment({ id: 'comment-2', line: 2 }),
      comment({ id: 'comment-3', path: 'src/b.ts', line: 3 }),
    ]);

    expect(message).toContain('3 comments on the diff, across 2 files:');
    expect(message?.split('src/').length).toBe(4);
  });

  it('orders by file and then by line, not by the order they were written', () => {
    const message = composeReviewMessage([
      comment({ id: 'comment-1', path: 'src/z.ts', line: 9, body: 'third' }),
      comment({ id: 'comment-2', path: 'src/a.ts', line: 40, body: 'second' }),
      comment({ id: 'comment-3', path: 'src/a.ts', line: 2, body: 'first' }),
    ]);

    expect(message?.indexOf('first')).toBeLessThan(message?.indexOf('second') ?? -1);
    expect(message?.indexOf('second')).toBeLessThan(message?.indexOf('third') ?? -1);
  });

  it('keeps two comments on one line in the order the reviewer wrote them', () => {
    // Sorting on the id would put `comment-10` before `comment-2`; an unstable
    // tie-break would put either first. Both read as the reviewer contradicting
    // themselves.
    const message = composeReviewMessage([
      comment({ id: 'comment-2', line: 5, body: 'the thought' }),
      comment({ id: 'comment-10', line: 5, body: 'and its qualification' }),
    ]);

    expect(message?.indexOf('the thought')).toBeLessThan(
      message?.indexOf('and its qualification') ?? -1,
    );
  });

  it('counts one file as a file rather than as files', () => {
    const message = composeReviewMessage([
      comment({ id: 'comment-1', line: 1 }),
      comment({ id: 'comment-2', line: 2 }),
    ]);

    expect(message).toContain('across 1 file:');
  });
});
