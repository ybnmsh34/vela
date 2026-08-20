/**
 * Turning a set of line comments into the one message that is actually sent.
 *
 * The spec (`docs/spec-parts/claude-code-desktop.md` §6) is specific about the
 * shape of this interaction and it is worth restating, because the obvious
 * implementation gets it wrong: comments are **collected**, and submitted
 * together as a single structured message. Not one message per comment. A
 * reviewer marking six lines is making one argument about one change, and six
 * separate turns is six chances for the model to act on the first before it has
 * read the sixth.
 *
 * ## Order
 *
 * By file, then by line, then by the order the reviewer wrote them. The last
 * clause is what `Array.prototype.sort`'s stability gives for free and it is not
 * incidental: two comments on the same line are a thought and its qualification,
 * and reversing them reverses the argument. Sorting on the comment **id** would
 * have been the easy way to break the tie and it is wrong twice — the ids are
 * strings, so `comment-10` sorts before `comment-2`, and the id is an
 * implementation detail of the store rather than a fact about the review.
 *
 * ## Why the line is quoted back
 *
 * The recipient is a model reading a message, not a UI with the diff open beside
 * it. `path:line` alone is a coordinate into a file that is about to change; the
 * quoted line is what makes the comment survive the file moving under it. The
 * text comes from the comment (see `LineComment.text` in
 * `src/state/code-workspace-store.ts`), which recorded it when the reviewer
 * wrote it, not from the diff as it reads at submit time.
 */

import type { LineComment } from '@/state/code-workspace-store';

/**
 * A side, said the way a reviewer says it.
 *
 * `left`/`right` is where the line is on screen. "before"/"after" is what it
 * means, and it is the only one of the two that survives being read out of
 * context in a message.
 */
function sideWord(side: LineComment['side']): string {
  return side === 'left' ? 'before' : 'after';
}

function ordered(comments: readonly LineComment[]): readonly LineComment[] {
  return [...comments].sort(
    (left, right) =>
      (left.path < right.path ? -1 : left.path > right.path ? 1 : 0) || left.line - right.line,
  );
}

/**
 * The message a submit sends, or `null` when there is nothing to send.
 *
 * `null` rather than an empty string, so a caller cannot queue a blank turn by
 * forgetting to check — the same reason `contextBudget` takes `null` for
 * "nothing reported" rather than `[]`.
 */
export function composeReviewMessage(comments: readonly LineComment[]): string | null {
  if (comments.length === 0) return null;

  const files = new Set(comments.map((comment) => comment.path));
  const heading =
    comments.length === 1
      ? 'One comment on the diff:'
      : `${comments.length} comments on the diff, across ${files.size} ${
          files.size === 1 ? 'file' : 'files'
        }:`;

  const blocks = ordered(comments).map(
    (comment) =>
      `${comment.path}:${comment.line} (${sideWord(comment.side)})\n` +
      `> ${comment.text}\n` +
      comment.body,
  );

  return `${heading}\n\n${blocks.join('\n\n')}`;
}
