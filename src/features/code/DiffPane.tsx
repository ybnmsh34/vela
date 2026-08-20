/**
 * DIFF REVIEW — the file list on the left, the changes on the right, a comment
 * box on any line, and one message when you submit.
 *
 * ## The stat is qualified, always
 *
 * `+12 -1` is the indicator the spec describes, and it is a claim about how many
 * lines changed. `src/lib/text-diff.ts` can decline to align a pair that is too
 * large, and when it does, those two numbers stop counting changes and start
 * counting lines. So this reads {@link TextDiff.aligned} and says "not
 * compared line by line" rather than printing a number that means something
 * else. The version of this indicator that did not exist yet was already going
 * to be wrong, because the module it would have read from had no way to tell it.
 *
 * ## Why the rows are buttons, and why only one of them is a Tab stop
 *
 * "Click a line to comment" has to mean "reach a line and comment" for a
 * keyboard too, so every row is a real button. A four-hundred-line diff is then
 * four hundred Tab stops, which is the defect `src/state/focus-store.ts`
 * describes in the conversation list — "a roving tabindex is what stops forty
 * conversations costing forty Tab presses". Same answer here: one stop into the
 * diff, then Up and Down.
 *
 * ## Where a comment goes
 *
 * Into a pending set, not into a message. Submitting collects the whole set into
 * one structured message (`review-comments.ts`) and queues it for the session —
 * which the chat pane reads. Six comments are one argument about one change; six
 * messages are six chances to act on the first before reading the sixth.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { diffText, type DiffRow } from '@/lib/text-diff';
import {
  useCodeWorkspaceStore,
  workOf,
  type LineComment,
  type SessionFile,
} from '@/state/code-workspace-store';

import { composeReviewMessage } from './review-comments';
import styles from './CodeWorkspace.module.css';

/** The side and the line number a row is commented against. */
function anchorOf(row: DiffRow): { readonly side: LineComment['side']; readonly line: number } {
  if (row.kind === 'removed') return { side: 'left', line: row.leftLine };
  if (row.kind === 'added') return { side: 'right', line: row.rightLine };
  // An unchanged line is legitimately worth commenting on, and it exists on both
  // sides. It is anchored to the *after* side because that is the text the
  // change is being asked about.
  return { side: 'right', line: row.rightLine };
}

const GUTTER: Record<DiffRow['kind'], string> = { same: ' ', added: '+', removed: '-' };

export function DiffPane({ sessionId }: { readonly sessionId: string }) {
  const work = useCodeWorkspaceStore((state) => workOf(state, sessionId));
  const addComment = useCodeWorkspaceStore((state) => state.addComment);
  const removeComment = useCodeWorkspaceStore((state) => state.removeComment);
  const submitComments = useCodeWorkspaceStore((state) => state.submitComments);

  const diffs = useMemo(
    () => work.files.map((file) => ({ file, diff: diffText(file.baseline, file.working) })),
    [work.files],
  );
  const changed = diffs.filter((entry) => entry.diff.added + entry.diff.removed > 0);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const current =
    changed.find((entry) => entry.file.path === selectedPath) ?? changed[0] ?? null;

  const [commentingRow, setCommentingRow] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  if (changed.length === 0 || current === null) {
    return (
      <p className={styles.empty}>
        No changes in this session yet. Open a file in the Editor pane and type — the diff is
        between what was last saved and what the editor holds now.
      </p>
    );
  }

  function submit(): void {
    const message = composeReviewMessage(work.comments);
    if (message === null) return;
    submitComments(sessionId, message);
    setCommentingRow(null);
    setDraft('');
  }

  return (
    <div
      className={styles.diffPane}
      onKeyDown={(event) => {
        // Ctrl/Cmd+Enter submits the whole round from anywhere in the pane,
        // including from inside the comment box, which is where a reviewer's
        // hands are when they finish.
        if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
        event.preventDefault();
        event.stopPropagation();
        submit();
      }}
    >
      <div className={styles.fileList} role="list" aria-label="Changed files">
        {changed.map((entry) => (
          <FileRow
            key={entry.file.path}
            file={entry.file}
            added={entry.diff.added}
            removed={entry.diff.removed}
            aligned={entry.diff.aligned}
            comments={work.comments.filter((comment) => comment.path === entry.file.path).length}
            selected={entry.file.path === current.file.path}
            onSelect={() => {
              setSelectedPath(entry.file.path);
              setCommentingRow(null);
            }}
          />
        ))}
      </div>

      <div className={styles.changes}>
        <p className={styles.changesLead}>
          {current.file.path} ·{' '}
          {current.diff.aligned
            ? `+${current.diff.added} -${current.diff.removed}`
            : 'too large to compare line by line — shown as a whole-file replacement'}
        </p>

        <DiffRows
          rows={current.diff.rows}
          path={current.file.path}
          comments={work.comments}
          commentingRow={commentingRow}
          draft={draft}
          onDraft={setDraft}
          onCommentRow={(index) => {
            setCommentingRow((was) => (was === index ? null : index));
            setDraft('');
          }}
          onAdd={(row) => {
            addComment(sessionId, { path: current.file.path, text: row.text, ...anchorOf(row) }, draft);
            setCommentingRow(null);
            setDraft('');
          }}
          onRemove={(id) => removeComment(sessionId, id)}
        />

        <div className={styles.reviewBar}>
          <span className={styles.reviewCount}>
            {work.comments.length === 0
              ? 'No comments yet — choose a line to add one.'
              : `${work.comments.length} comment${work.comments.length === 1 ? '' : 's'} pending`}
          </span>
          <button
            type="button"
            className={styles.primary}
            disabled={work.comments.length === 0}
            onClick={submit}
          >
            Submit review
          </button>
        </div>
      </div>
    </div>
  );
}

function FileRow({
  file,
  added,
  removed,
  aligned,
  comments,
  selected,
  onSelect,
}: {
  readonly file: SessionFile;
  readonly added: number;
  readonly removed: number;
  readonly aligned: boolean;
  readonly comments: number;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <div role="listitem">
      <button
        type="button"
        className={styles.fileRow}
        aria-current={selected ? 'true' : undefined}
        onClick={onSelect}
      >
        <span className={styles.filePath}>{file.path}</span>
        <span className={styles.fileStat}>
          {aligned ? `+${added} -${removed}` : 'not compared'}
        </span>
        {comments > 0 ? <span className={styles.fileComments}>{comments}</span> : null}
      </button>
    </div>
  );
}

function DiffRows({
  rows,
  path,
  comments,
  commentingRow,
  draft,
  onDraft,
  onCommentRow,
  onAdd,
  onRemove,
}: {
  readonly rows: readonly DiffRow[];
  readonly path: string;
  readonly comments: readonly LineComment[];
  readonly commentingRow: number | null;
  readonly draft: string;
  readonly onDraft: (value: string) => void;
  readonly onCommentRow: (index: number) => void;
  readonly onAdd: (row: DiffRow) => void;
  readonly onRemove: (id: string) => void;
}) {
  // The roving stop. Index into `rows`, clamped when the diff shrinks under it —
  // a row that no longer exists cannot hold the keyboard, and leaving the index
  // past the end is how Down stops working entirely.
  const [active, setActive] = useState(0);
  const bounded = Math.min(active, Math.max(rows.length - 1, 0));
  const activeRef = useRef<HTMLButtonElement>(null);
  const moved = useRef(false);

  useEffect(() => {
    // Only after a key we handled. Focusing on every render would steal the
    // keyboard from the comment box the moment a character is typed into it.
    if (!moved.current) return;
    moved.current = false;
    activeRef.current?.focus();
  }, [bounded]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const last = rows.length - 1;
    let next = bounded;
    if (event.key === 'ArrowDown') next = Math.min(bounded + 1, last);
    else if (event.key === 'ArrowUp') next = Math.max(bounded - 1, 0);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    else return;

    event.preventDefault();
    event.stopPropagation();
    moved.current = true;
    setActive(next);
  }

  return (
    <div
      className={styles.diffRows}
      role="group"
      aria-label={`Changes in ${path}`}
      onKeyDown={handleKeyDown}
    >
      {rows.map((row, index) => {
        const anchor = anchorOf(row);
        const attached = comments.filter(
          (comment) =>
            comment.path === path && comment.side === anchor.side && comment.line === anchor.line,
        );
        return (
          <div key={`${row.kind}-${index}`}>
            <button
              type="button"
              ref={index === bounded ? activeRef : null}
              tabIndex={index === bounded ? 0 : -1}
              className={styles.diffLine}
              data-kind={row.kind}
              aria-expanded={commentingRow === index}
              // Distinct from the comment box's own label below. They were both
              // "Comment on line 2", which is ambiguous to a screen reader for
              // exactly the reason it was ambiguous to the test that found it:
              // two controls, one name, and no way to say which you mean.
              aria-label={`Comment on line ${anchor.line} ${anchor.side === 'left' ? 'before' : 'after'}`}
              onClick={() => onCommentRow(index)}
            >
              <span className={styles.lineNumber}>
                {row.kind === 'added' ? '' : row.leftLine}
              </span>
              <span className={styles.lineNumber}>
                {row.kind === 'removed' ? '' : row.rightLine}
              </span>
              <span className={styles.lineGutter}>{GUTTER[row.kind]}</span>
              <span className={styles.lineText}>{row.text}</span>
            </button>

            {attached.map((comment) => (
              <div key={comment.id} className={styles.commentCard}>
                <p className={styles.commentBody}>{comment.body}</p>
                <button
                  type="button"
                  className={styles.paneButton}
                  onClick={() => onRemove(comment.id)}
                >
                  Remove
                </button>
              </div>
            ))}

            {commentingRow === index ? (
              <div className={styles.commentBox}>
                <label className={styles.fieldLabel} htmlFor={`comment-${index}`}>
                  Your comment on line {anchor.line}
                </label>
                <textarea
                  id={`comment-${index}`}
                  className={styles.textarea}
                  rows={2}
                  value={draft}
                  autoFocus
                  onChange={(event) => onDraft(event.target.value)}
                  onKeyDown={(event) => {
                    // Enter adds the comment, matching the spec. Shift+Enter is
                    // a newline, and Ctrl/Cmd+Enter is left alone so it reaches
                    // the pane's submit handler.
                    if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey) {
                      return;
                    }
                    event.preventDefault();
                    onAdd(row);
                  }}
                />
                <button type="button" className={styles.paneButton} onClick={() => onAdd(row)}>
                  Add comment
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
