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
 *
 * ## AND WHY THE COORDINATE IS RE-ASKED
 *
 * Quoting the line verbatim makes the comment *readable* after the file moves.
 * It does not make `path:line` **true** after the file moves, and the first
 * version of this module sent both in one message as though it did. A comment
 * written on `BETA` at line 2, with one line then inserted above it, was still
 * submitted as `src/a.ts:2 (after)` — quoting `BETA` against a line that by then
 * said `INSERTED`. The store's guard was one notch narrower than the question:
 * `saveFile` clears a file's comments because a save erases the diff wholesale,
 * which answers "was the diff erased?" and not "does this comment still point at
 * the line it quotes?".
 *
 * So {@link composeReviewMessage} does not take comments. It takes
 * {@link AnchoredComment}s, and the only sensible way to obtain one is
 * {@link anchorComments}, which re-finds the quoted line in the diff as it reads
 * *now*. A comment whose line is gone says so instead of naming a coordinate.
 * That is the same move `src/lib/text-diff.ts` made when it deleted
 * `summariseDiff(rows)`: an input that cannot answer the question is not made
 * safe by being used carefully.
 */

import type { DiffRow } from '@/lib/text-diff';

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

/**
 * The side a row is commented against, and the line number on that side.
 *
 * An unchanged line exists on both sides and is anchored to the *after* side,
 * because that is the text the change is being asked about. One consequence of
 * that is load-bearing for {@link anchorComments}: `added` and `same` rows carry
 * the right-hand number and `removed` rows the left-hand one, so a (side, line)
 * pair names exactly one row of a diff.
 */
export function anchorOf(row: DiffRow): {
  readonly side: LineComment['side'];
  readonly line: number;
} {
  if (row.kind === 'removed') return { side: 'left', line: row.leftLine };
  if (row.kind === 'added') return { side: 'right', line: row.rightLine };
  return { side: 'right', line: row.rightLine };
}

/**
 * A comment, and the line its quoted text is on **now**.
 *
 * `line` is `null` when the quoted line is not in the diff any more — deleted,
 * or edited into something else. `comment.line` is where it was written; the two
 * differ exactly when the file moved under the comment, which is the case this
 * type exists to make unignorable.
 */
export interface AnchoredComment {
  readonly comment: LineComment;
  readonly line: number | null;
}

/**
 * Re-find every comment's quoted line in the diff as it reads now.
 *
 * `rowsByPath` is the current diff of every file the session holds, keyed by
 * path — a file absent from the map has no diff, so its comments have no line.
 *
 * The match is on the **side and the text**, not on the stored line: the stored
 * line is the thing that goes stale. When one file has several rows quoting the
 * same text — a repeated `}` is the ordinary case — the one nearest to where the
 * comment was written wins, and ties go to the row found first. That is a
 * heuristic and it is worth naming as one: it cannot tell two identical lines
 * apart, and on a large enough edit it will pick the wrong one of a pair. What
 * it does not do is invent a coordinate for a line that is gone.
 */
export function anchorComments(
  comments: readonly LineComment[],
  rowsByPath: ReadonlyMap<string, readonly DiffRow[]>,
): readonly AnchoredComment[] {
  return comments.map((comment) => {
    const rows = rowsByPath.get(comment.path) ?? [];
    let best: number | null = null;
    for (const row of rows) {
      if (row.text !== comment.text) continue;
      const anchor = anchorOf(row);
      if (anchor.side !== comment.side) continue;
      if (best === null || Math.abs(anchor.line - comment.line) < Math.abs(best - comment.line)) {
        best = anchor.line;
      }
    }
    return { comment, line: best };
  });
}

/**
 * By file, then by line, then by the order the reviewer wrote them — on the line
 * the comment points at **now**, since that is the line the message prints.
 * Comments whose line is gone sort last within their file: they are the part of
 * the round a reader can do least with.
 */
function ordered(entries: readonly AnchoredComment[]): readonly AnchoredComment[] {
  return [...entries].sort((left, right) => {
    const byPath =
      left.comment.path < right.comment.path
        ? -1
        : left.comment.path > right.comment.path
          ? 1
          : 0;
    if (byPath !== 0) return byPath;
    if (left.line === null || right.line === null) {
      return (left.line === null ? 1 : 0) - (right.line === null ? 1 : 0);
    }
    return left.line - right.line;
  });
}

/**
 * The message a submit sends, or `null` when there is nothing to send.
 *
 * `null` rather than an empty string, so a caller cannot queue a blank turn by
 * forgetting to check — the same reason `contextBudget` takes `null` for
 * "nothing reported" rather than `[]`.
 */
export function composeReviewMessage(entries: readonly AnchoredComment[]): string | null {
  if (entries.length === 0) return null;

  const files = new Set(entries.map((entry) => entry.comment.path));
  const heading =
    entries.length === 1
      ? 'One comment on the diff:'
      : `${entries.length} comments on the diff, across ${files.size} ${
          files.size === 1 ? 'file' : 'files'
        }:`;

  const blocks = ordered(entries).map((entry) => {
    const where =
      entry.line === null
        ? `${entry.comment.path} — the line this quotes is no longer in the diff`
        : `${entry.comment.path}:${entry.line} (${sideWord(entry.comment.side)})`;
    return `${where}\n> ${entry.comment.text}\n${entry.comment.body}`;
  });

  return `${heading}\n\n${blocks.join('\n\n')}`;
}
