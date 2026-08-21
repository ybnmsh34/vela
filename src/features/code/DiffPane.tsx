/**
 * DIFF REVIEW — the file list on the left, the changes on the right, a comment
 * box on any line, and one message when you submit.
 *
 * ## The stat is qualified, always
 *
 * `+12 -1` is the indicator the spec describes, and it is a claim about how many
 * lines changed. `src/lib/text-diff.ts` can decline to align a pair that is too
 * large, and when it does, those two numbers stop counting changes and start
 * counting lines. So this reads {@link TextDiff.aligned} and says "not aligned"
 * rather than printing a number that means something else. The version of this
 * indicator that did not exist yet was already going to be wrong, because the
 * module it would have read from had no way to tell it.
 *
 * The words matter as much as the flag. An earlier draft of this pane said the
 * file was "not compared" and "shown as a whole-file replacement"; neither is
 * true, because `diffText` trims the common prefix and suffix *before* it
 * decides, and emits both as `same` rows either way. The test that now says so
 * (`does not call the fallback a whole-file replacement, because it is not one`)
 * uses one shared line at each end and gets 2004 rows back, two of them `same`:
 * the old wording announced a whole-file replacement directly above lines the
 * module had just compared. A longer shared head and tail makes it worse, not
 * different.
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
 *
 * ## Why the diffs are cached per file
 *
 * `work.files` is a fresh array on every keystroke — `editFile` rebuilds it —
 * so a `useMemo` keyed on it re-diffs *every* file in the session each time a
 * character is typed in the editor pane, which is the pane that is open beside
 * this one in the default layout. The cache is keyed on the two strings a diff
 * is actually a function of, so an untouched file is never diffed twice.
 * `re-diffs only the file that changed, not every file in the session` is what
 * measures it: it seeds three files, types into one, and expects one call.
 * Reverting the cache makes it see three — one per file in the session.
 *
 * It has no eviction, and that is a statement about this build rather than a
 * general one: nothing removes a file from a session, so the cache is bounded
 * by the number of files the user has opened. A close-file action would need to
 * drop the entry with it.
 *
 * ## And where a comment goes when the file moves under it
 *
 * A comment is stored against the line it was written on and quotes that line
 * verbatim, so an edit *above* it silently renumbers what it points at. This
 * pane therefore never reads `comment.line` to decide which row a card belongs
 * under: `anchorComments` re-finds the quoted line in the diff as it reads now,
 * and every card, every Remove button and the submitted message are placed from
 * that answer. A comment the rows cannot show is shown apart instead, saying
 * which of the two reasons applies to it — see `drifted` below, which states
 * the qualifier on each arm, and the early return above it, which states the
 * one arrangement still not covered.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { diffText, type DiffRow, type TextDiff } from '@/lib/text-diff';
import { useCodeWorkspaceStore, workOf, type SessionFile } from '@/state/code-workspace-store';

import {
  anchorComments,
  anchorOf,
  composeReviewMessage,
  type AnchoredComment,
} from './review-comments';
import styles from './CodeWorkspace.module.css';

const GUTTER: Record<DiffRow['kind'], string> = { same: ' ', added: '+', removed: '-' };

/**
 * Every Remove button in the round, named for the comment it removes — and
 * named so that no two of them are the same.
 *
 * ## Why this is one pass over the round rather than one call per button
 *
 * Twice now this file has fixed a colliding accessible name by naming the field
 * that happened to differ in the arrangement the last reviewer described, and
 * both times the next arrangement collided. At `13e8cc7` the Remove buttons had
 * no `aria-label` at all, so N cards were N controls named "Remove" with N
 * different consequences. `b0a9efd` added line, side and body, which fixed the
 * round where the bodies differed. `687c189` added the path, which fixed the
 * round where the paths differed. Neither reaches two comments that agree on
 * every field a name can be derived from — same file, same line, same side,
 * same quoted text, same body — which is an ordinary reviewer writing "nit"
 * twice; and neither reaches two comments whose only difference is a quoted
 * line the name does not carry. Both of those are measured, on `687c189`'s own
 * naming, in the mutation list below.
 *
 * So the guard here is the invariant, not the arrangement: build every name,
 * then make the names distinct. What the fields cannot separate, the round
 * order separates — a shared name is suffixed `(1 of 2)`, `(2 of 2)` in the
 * order the reviewer wrote them. That is also the order the cards sharing it
 * are drawn in: {@link anchorComments} maps over the store's array without
 * reordering it, and both call sites reach their cards by filtering that array.
 * `(1 of 2)` is not a fact about the comment. It is the last discriminator left
 * once the comment is a copy of another one, and a position in the round is
 * what a reader has instead.
 *
 * The count is over the **round** rather than over what is on screen, and that
 * is not a hole the suffix falls into. Two entries cannot share a name without
 * sharing a path — an empty file clause on both means both paths are the file
 * on screen, a non-empty one means the two paths are equal — and cannot share a
 * name without agreeing on whether their line is `null`. Those are exactly the
 * two things the render conditions read: `drifted` tests the path against
 * `listed` and against the file on screen, and `DiffRows` draws a card when the
 * path is the file on screen and the line is a number. So a set that shares a
 * name is drawn all together or not at all, and no reader meets `(2 of 2)` with
 * nothing else to compare it to. That is derived from those two conditions, not
 * measured: there is no round to seed in which a suffixed name is alone on
 * screen. Counting only the rendered buttons instead would rename a button when
 * the reviewer selects a different file, which is the worse failure — the name
 * a screen reader has just read out would stop matching the control.
 *
 * ## What each clause is for, and what happens without it
 *
 * `onScreen` is the path of the file whose rows are drawn below. Every card in
 * `DiffRows` is on that file by construction, but a `drifted` card need not be —
 * the `!listed` arm shows a comment from a file that has left the changed-file
 * list, wherever the reviewer happens to be. So the path is said only when it
 * differs from the file on screen, and the quoted line is said on exactly the
 * arm that has no line number to say instead. Both are already printed by
 * `.driftedQuote` directly above the button, so neither clause invents a
 * discriminator: it gives the accessible name the one the screen already had.
 *
 * Each clause is bitten on its own. Every figure below is this file's own
 * `npx vitest run src/features/code/DiffPane.test.tsx`, one mutation applied at
 * a time and restored from a byte snapshot before the next, run twice with both
 * runs agreeing:
 *
 * - the naming dropped altogether, every id mapped to a bare `'Remove comment'`
 *   → `6 failed | 20 passed (26)`, which is every test in that file asserting a
 *   Remove button's name or the distinctness of the round's names. The two that
 *   only ever *click* one, by the shared `/^Remove comment/` prefix, stay green:
 *   a query that matches every button in the round cannot tell that they have
 *   stopped being different, which is why the guards assert names rather than
 *   only clicking;
 * - the path clause replaced with `''` → `3 failed | 23 passed (26)`, on
 *   `keeps a comment removable when its file leaves the changed list with the
 *   quoted line intact`, `tells two Remove buttons apart when the comments are
 *   on different files` and `gives every Remove button in a round a name of its
 *   own, whatever collides`. Note *what* reddens: the names stay distinct,
 *   because the suffix below takes over the moment the path stops separating
 *   them, and it is the assertions on the literal name that fail
 *   (`Unable to find an accessible element with the role "button" and name
 *   "Remove comment on src/a.ts, line 1 after: this line worries me"`, and
 *   twice `expected [ …(2) ] to include 'Remove comment on src/a.ts, line 1
 *   af…'`). Distinctness alone would not have caught this, which is why the
 *   tests assert the name as well as the property;
 * - the quoted-line clause dropped, so the `line === null` arm reads only
 *   `a line no longer in the diff` again → `1 failed | 25 passed (26)`, on
 *   `tells two Remove buttons apart when both comments have lost the line they
 *   quote`;
 * - the suffix dropped, so a shared name is handed to every id that shares it →
 *   `2 failed | 24 passed (26)`, on `tells two identical comments apart by
 *   where they sit in the round` (`expected 1 to be 2`) and `gives every Remove
 *   button in a round a name of its own, whatever collides` (`expected 4 to be
 *   5`) — both of them the distinct-count assertion in `distinctRemoveNames`.
 *
 * The last two together are `687c189`'s naming exactly: with both applied, the
 * three statements that build `where`, `file` and `name` read the same as that
 * commit's `removeLabel` body, and every id is then handed its base name
 * unchanged. That is how the collisions this round closes were measured rather
 * than argued. Applied together → `3 failed | 23 passed (26)` twice, and with a
 * probe that prints the colliding names instead of counting them, the three
 * failures return, twice each:
 *
 *     ["Remove comment on a line no longer in the diff: nit",
 *      "Remove comment on a line no longer in the diff: nit"]
 *     ["Remove comment on line 2 after: nit",
 *      "Remove comment on line 2 after: nit"]
 *     ["Remove comment on src/a.ts, line 1 after: nit",
 *      "Remove comment on line 1 before: nit",
 *      "Remove comment on line 1 after: nit",
 *      "Remove comment on line 1 after: nit",
 *      "Remove comment on line 2 after: nit"]
 *
 * The first is the round-4 critic's case. The other two are collisions they did
 * not name, and their suggested remedy — carry the quoted line on the
 * `line === null` arm — reaches neither: every comment in both has a line
 * number, so that arm never runs for any of them.
 *
 * The returned map is keyed by comment id and is read at the pane's two card
 * sites and nowhere else: the `drifted` group's button and `DiffRows`'s
 * `attached` button. Both draw their entries out of the same `anchored` array
 * this is built from, so every button they render has a name here.
 */
function removeLabels(
  entries: readonly AnchoredComment[],
  onScreen: string,
): ReadonlyMap<string, string> {
  const byName = new Map<string, string[]>();
  for (const entry of entries) {
    const where =
      entry.line === null
        ? `a line no longer in the diff (it read "${entry.comment.text}")`
        : `line ${entry.line} ${entry.comment.side === 'left' ? 'before' : 'after'}`;
    const file = entry.comment.path === onScreen ? '' : `${entry.comment.path}, `;
    const name = `Remove comment on ${file}${where}: ${entry.comment.body}`;
    const sharing = byName.get(name);
    if (sharing === undefined) byName.set(name, [entry.comment.id]);
    else sharing.push(entry.comment.id);
  }

  const labels = new Map<string, string>();
  for (const [name, ids] of byName) {
    ids.forEach((id, index) => {
      labels.set(id, ids.length === 1 ? name : `${name} (${index + 1} of ${ids.length})`);
    });
  }
  return labels;
}

export function DiffPane({ sessionId }: { readonly sessionId: string }) {
  const work = useCodeWorkspaceStore((state) => workOf(state, sessionId));
  const addComment = useCodeWorkspaceStore((state) => state.addComment);
  const removeComment = useCodeWorkspaceStore((state) => state.removeComment);
  const submitComments = useCodeWorkspaceStore((state) => state.submitComments);

  const cached = useRef(new Map<string, { readonly key: string; readonly diff: TextDiff }>());
  const diffs = useMemo(
    () =>
      work.files.map((file) => {
        // Length-prefixed, not merely joined. A plain `baseline + working`
        // makes `('ab', 'c')` and `('a', 'bc')` the same key, and a separator
        // alone does not fix it because a separator can occur in the text. The
        // leading length says where the first string ends, whatever is in it.
        const key = `${file.baseline.length}\u0000${file.baseline}\u0000${file.working}`;
        const seen = cached.current.get(file.path);
        if (seen !== undefined && seen.key === key) return { file, diff: seen.diff };
        const diff = diffText(file.baseline, file.working);
        cached.current.set(file.path, { key, diff });
        return { file, diff };
      }),
    [work.files],
  );
  const changed = diffs.filter((entry) => entry.diff.added + entry.diff.removed > 0);

  // Every pending comment, re-asked against the diff as it reads now. Built over
  // *all* the session's files rather than the selected one, because a submit
  // sends the whole round and a file the reviewer has navigated away from is
  // still in it.
  const anchored = useMemo(
    () =>
      anchorComments(
        work.comments,
        new Map(diffs.map((entry) => [entry.file.path, entry.diff.rows])),
      ),
    [work.comments, diffs],
  );

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const current =
    changed.find((entry) => entry.file.path === selectedPath) ?? changed[0] ?? null;

  const [commentingRow, setCommentingRow] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  // KNOWN HOLE, undisclosed until now and not closed here. `drifted` is computed
  // below this return, so when the LAST changed file is reverted there is no
  // changed file left, this branch renders, and a pending comment on that file
  // is invisible and un-removable again — the state round 3 fixed for every
  // other arrangement. It is bounded: with no changed file there is no review
  // bar, no Submit control and no Ctrl+Enter handler on screen, so nothing is
  // sent while it is hidden, and the card returns the moment any file differs
  // again. Closing it means hoisting `drifted` above this return and rendering
  // the group inside the empty state, which is a second layout for this pane
  // rather than a clause; it predates this track's diff work and is on the
  // lead's list, not disguised as done.
  if (changed.length === 0 || current === null) {
    return (
      <p className={styles.empty}>
        No changes in this session yet. Open a file in the Editor pane and type — the diff is
        between what was last saved and what the editor holds now.
      </p>
    );
  }

  // Every pending comment the rows below cannot show. Both arms submit, so both
  // have to stay in front of the reviewer who can still delete them — and the
  // two arms are NOT the same condition, which is the defect this shape exists
  // to close.
  //
  //   `!listed` — the file left the changed-file list, so it has no row here
  //   whatever its anchor says. Editing a file back to its baseline does *not*
  //   take its rows with it: `diffText` on two identical texts returns every
  //   line as a `same` row (measured: `diffText('alpha', 'alpha')` gives
  //   `{added: 0, removed: 0, rows: 1}`, that one row `same`). So a comment on
  //   a context line still anchors to a real number while its file is gone from
  //   the list. Round 2 required `line === null` on this arm as well, and that
  //   comment was invisible, un-removable, and still submitted as
  //   `src/a.ts:1 (after)`. `keeps a comment removable when its file leaves the
  //   changed list with the quoted line intact` is what measures it now.
  //
  //   `line === null && path === current` — the file is still listed, but the
  //   quoted line is gone from it. `path === current` because the comment's own
  //   file DOES have a row in the list to select, so this arm can wait for the
  //   reviewer to go there rather than following them onto every other file's
  //   diff. The `!listed` arm has no such file to wait for, which is why it
  //   shows wherever the reviewer is and prefixes its quote with the path.
  const listed = new Set(changed.map((entry) => entry.file.path));
  const drifted = anchored.filter(
    (entry) =>
      !listed.has(entry.comment.path) ||
      (entry.line === null && entry.comment.path === current.file.path),
  );

  // Built once for the whole round rather than per card, because distinctness
  // is a property of the set and no per-card call can see the set. Not a hook:
  // it is cheap, and hoisting it above the early return would mean handing it a
  // file-on-screen that does not exist there.
  const removeNames = removeLabels(anchored, current.file.path);

  function submit(): void {
    const message = composeReviewMessage(anchored);
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
            : 'too large to compare line by line — the changed part is shown as a wholesale replacement'}
        </p>

        {drifted.length === 0 ? null : (
          <div
            className={styles.drifted}
            role="group"
            aria-label="Comments with no row to sit under"
          >
            <p className={styles.driftedLead}>
              {drifted.length === 1
                ? 'One comment has no row in the diff below to sit under. Submitting sends it anyway.'
                : `${drifted.length} comments have no row in the diff below to sit under. Submitting sends them anyway.`}
            </p>
            {drifted.map((entry) => (
              <div key={entry.comment.id} className={styles.commentCard}>
                <p className={styles.driftedQuote}>
                  {entry.comment.path === current.file.path
                    ? entry.comment.text
                    : `${entry.comment.path} · ${entry.comment.text}`}
                </p>
                {/* The reason is per card, not in the lead, because the two
                    arms of `drifted` have different consequences and one
                    sentence covering both would be wrong about one of them. */}
                <p className={styles.driftedReason}>
                  {entry.line === null
                    ? 'The line it quotes is no longer in the diff, so it is sent without a line number.'
                    : `Its file is no longer in the changed-file list, so it is sent as line ${entry.line} ${
                        entry.comment.side === 'left' ? 'before' : 'after'
                      }.`}
                </p>
                <p className={styles.commentBody}>{entry.comment.body}</p>
                <button
                  type="button"
                  className={styles.paneButton}
                  aria-label={removeNames.get(entry.comment.id)}
                  onClick={() => removeComment(sessionId, entry.comment.id)}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        <DiffRows
          rows={current.diff.rows}
          path={current.file.path}
          anchored={anchored}
          removeNames={removeNames}
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
          {aligned ? `+${added} -${removed}` : 'not aligned'}
        </span>
        {comments > 0 ? <span className={styles.fileComments}>{comments}</span> : null}
      </button>
    </div>
  );
}

function DiffRows({
  rows,
  path,
  anchored,
  removeNames,
  commentingRow,
  draft,
  onDraft,
  onCommentRow,
  onAdd,
  onRemove,
}: {
  readonly rows: readonly DiffRow[];
  readonly path: string;
  /** Every pending comment of the session, with the line it points at *now*. */
  readonly anchored: readonly AnchoredComment[];
  /** {@link removeLabels} over the whole round, keyed by comment id. */
  readonly removeNames: ReadonlyMap<string, string>;
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
        // `entry.line`, never `comment.line`: the stored line is where the
        // comment was written, and an edit above it moves the row without moving
        // the number.
        const attached = anchored.filter(
          (entry) =>
            entry.comment.path === path &&
            entry.comment.side === anchor.side &&
            entry.line === anchor.line,
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

            {attached.map((entry) => (
              <div key={entry.comment.id} className={styles.commentCard}>
                <p className={styles.commentBody}>{entry.comment.body}</p>
                <button
                  type="button"
                  className={styles.paneButton}
                  aria-label={removeNames.get(entry.comment.id)}
                  onClick={() => onRemove(entry.comment.id)}
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
