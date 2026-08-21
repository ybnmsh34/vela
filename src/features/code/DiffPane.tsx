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
 * Reverting the cache makes it see three — one per file in the session. What
 * makes the key a key rather than a concatenation is {@link diffCacheKey}, and
 * that is asserted separately, because the collision it prevents cannot be
 * staged through this pane — see the note there.
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
import { canTakeFocus } from '@/state/focus-store';

import {
  anchorComments,
  anchorOf,
  composeReviewMessage,
  type AnchoredComment,
} from './review-comments';
import styles from './CodeWorkspace.module.css';

const GUTTER: Record<DiffRow['kind'], string> = { same: ' ', added: '+', removed: '-' };

/**
 * One pending comment and the two strings this pane says about removing it.
 *
 * The pair travels with the entry rather than in a map keyed by comment id,
 * which is what it was until this round. A map hands back `string | undefined`
 * at every card, so "every rendered button has a name" was prose — true, because
 * both card sites filter the same array the map was built from, but not a thing
 * the compiler was checking, and the `?? ''` that would have papered over a real
 * gap had somewhere to be written. Carried on the entry it is checked: deleting
 * the `name` line from what {@link removeLabels} returns exits `npx tsc --build
 * --force` with 2 and `error TS2322: Type '{ entry: AnchoredComment; subject:
 * string; }[]' is not assignable to type 'readonly LabelledComment[]'` (plus a
 * TS6133 for the `index` that then goes unused). Measured twice; the file and
 * position tsc prefixes are cut here, because a line number in prose is wrong
 * the first time anything above it moves.
 */
interface LabelledComment {
  readonly entry: AnchoredComment;
  /** The Remove button's accessible name, distinct across the whole round. */
  readonly name: string;
  /**
   * The same clauses without the verb and **without** the positional suffix, for
   * the sentence spoken after the button is gone — see the live region in
   * {@link DiffPane}, which is the reason this is a second field rather than
   * `name.slice(7)`.
   */
  readonly subject: string;
}

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
 * ## The suffix renumbers, and that is chosen rather than overlooked
 *
 * The paragraph above rejects a render-scoped count because it would rename a
 * control the reviewer is not touching. A round-scoped count has a narrower
 * version of the same property and it would be dishonest to argue the one
 * without stating the other: **removing one of a sharing set renumbers the
 * rest.** Three "nit"s are `(1 of 3)`, `(2 of 3)`, `(3 of 3)`; remove the first
 * and the button that was `(3 of 3)` is `(2 of 2)`. `renumbers the siblings a
 * removal leaves behind, which is what a position in the round means` is what
 * asserts it — the behaviour is guarded, not merely described.
 *
 * It is the better of the two available answers. The alternative is a
 * discriminator that never renumbers — a creation ordinal carried on the comment
 * — and it buys stability by making the name false: the surviving button would
 * be `(3 of 3)` with two buttons on screen, and a number that does not match
 * what is there is worse than a number that changes when the thing it counts
 * changes. The rename also happens under the reviewer's own hand, on the control
 * they just activated, rather than under a selection change somewhere else; and
 * the live region below says which comment went, using {@link
 * LabelledComment.subject} — the name **without** the suffix — precisely because
 * the positions have just moved and speaking one would name a slot that no
 * longer means what it did.
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
 * - the naming dropped altogether, every entry handed the bare name
 *   `'Remove comment'` → `13 failed | 25 passed (38)`, which is every test in
 *   that file that asserts a Remove button's name, asserts the distinctness of
 *   the round's names, or reaches a Remove button *by* its name. The three that
 *   only ever reach one through the shared `/^Remove comment/` prefix stay green
 *   — `takes a comment back off the pending set`, `keeps a comment visible when
 *   its whole file stops differing`, `goes to the file on screen when the group
 *   it was in is gone with it`: a query that matches every button in the round
 *   cannot tell that they have stopped being different, which is why the guards
 *   assert names rather than only clicking;
 * - the path clause replaced with `''` → `3 failed | 35 passed (38)`, on
 *   `keeps a comment removable when its file leaves the changed list with the
 *   quoted line intact`, `tells two Remove buttons apart when the comments are
 *   on different files` and `gives every Remove button in a round a name of its
 *   own, whatever collides`. Note *what* reddens: the names stay distinct,
 *   because the suffix below takes over the moment the path stops separating
 *   them, and it is the assertions on the literal name that fail. The three
 *   messages are one `Unable to find an accessible element with the role
 *   "button" and name "Remove comment on src/a.ts, line 1 after: this line
 *   worries me"` and two array-inclusion failures that are **not** the same
 *   message: `expected [ …(2) ] to include 'Remove comment on src/a.ts, line 1
 *   af…'` from the round with two Remove buttons, and `expected [ …(5) ] to
 *   include` the same elided string from the round with five — the elided
 *   length is the size of that test's round. (Until this round the bullet said
 *   that message occurred "twice". It occurs once; a measurer caught it, and
 *   the correction is re-measured here.) Distinctness alone would not have
 *   caught any of it, which is why the tests assert the name as well as the
 *   property;
 * - the quoted-line clause dropped, so the `line === null` arm reads only
 *   `a line no longer in the diff` again → `1 failed | 37 passed (38)`, on
 *   `tells two Remove buttons apart when both comments have lost the line they
 *   quote`;
 * - the suffix dropped, so a shared name is handed to every entry that shares
 *   it → `4 failed | 34 passed (38)`, on `tells two identical comments apart by
 *   where they sit in the round` (`expected 1 to be 2`), `renumbers the
 *   siblings a removal leaves behind, which is what a position in the round
 *   means` (`expected 1 to be 3`) and `gives every Remove button in a round a
 *   name of its own, whatever collides` (`expected 4 to be 5`) — those three
 *   the distinct-count assertion in `distinctRemoveNames` — plus `names the
 *   comment without the position it no longer occupies`, which can no longer
 *   find the button it clicks.
 *
 * The last two together are `687c189`'s naming exactly: with both applied, the
 * three statements that build `where`, `file` and `subject` read the same as
 * that commit's `removeLabel` body, and every entry is then handed its base
 * name unchanged. That is how the collisions this round closes were measured
 * rather than argued. Applied together → `5 failed | 33 passed (38)` twice, and
 * with a probe that prints the colliding names instead of counting them (a
 * `console.log` in `distinctRemoveNames`: added, run twice, deleted, both files
 * restored from byte snapshots and re-hashed), the collisions come back
 * character for character, identical in both runs:
 *
 *     ["Remove comment on a line no longer in the diff: nit",
 *      "Remove comment on a line no longer in the diff: nit"]
 *     ["Remove comment on line 2 after: nit",
 *      "Remove comment on line 2 after: nit"]
 *     ["Remove comment on line 2 after: nit",
 *      "Remove comment on line 2 after: nit",
 *      "Remove comment on line 2 after: nit"]
 *     ["Remove comment on src/a.ts, line 1 after: nit",
 *      "Remove comment on line 1 before: nit",
 *      "Remove comment on line 1 after: nit",
 *      "Remove comment on line 1 after: nit",
 *      "Remove comment on line 2 after: nit"]
 *
 * The first is the round-4 critic's case. The rest are collisions they did not
 * name, and their suggested remedy — carry the quoted line on the
 * `line === null` arm — reaches none of them: every comment in the last three
 * has a line number, so that arm never runs for any of them.
 *
 * The returned array is in the order it was given — {@link anchorComments} maps
 * over the store's array without reordering it — and it is what the pane's two
 * card sites filter: the `drifted` group and `DiffRows`'s `attached`. Neither
 * has an {@link AnchoredComment} that did not come through here, so neither can
 * draw a button that has no name.
 */
function removeLabels(
  entries: readonly AnchoredComment[],
  onScreen: string,
): readonly LabelledComment[] {
  const bases = entries.map((entry) => {
    const where =
      entry.line === null
        ? `a line no longer in the diff (it read "${entry.comment.text}")`
        : `line ${entry.line} ${entry.comment.side === 'left' ? 'before' : 'after'}`;
    const file = entry.comment.path === onScreen ? '' : `${entry.comment.path}, `;
    const subject = `comment on ${file}${where}: ${entry.comment.body}`;
    return { entry, subject, base: `Remove ${subject}` };
  });

  const sharing = new Map<string, number[]>();
  bases.forEach((item, index) => {
    const seen = sharing.get(item.base);
    if (seen === undefined) sharing.set(item.base, [index]);
    else seen.push(index);
  });

  const suffixed = new Map<number, string>();
  for (const [base, indices] of sharing) {
    if (indices.length === 1) continue;
    indices.forEach((index, position) => {
      suffixed.set(index, `${base} (${position + 1} of ${indices.length})`);
    });
  }

  return bases.map((item, index) => ({
    entry: item.entry,
    subject: item.subject,
    name: suffixed.get(index) ?? item.base,
  }));
}

/**
 * Where the keyboard goes when the card holding it is destroyed, in the order
 * the rungs are tried.
 *
 * Remove unmounts the button that was just activated. A browser answers that by
 * focusing `<body>`, which announces nothing and puts the reviewer at the top of
 * the document — the defect `src/features/navigation/DeleteConversationDialog.tsx`
 * writes down ("restored focus to a detached node, which the browser answers by
 * focusing `<body>` and saying nothing") and answers with `returnFocusTo`. This
 * is that pattern with this pane's own rungs, and it is `focus()`-then-**verify**
 * for the same reason `returnFocusTo` is: `focus()` is a request, not a result.
 *
 * `returnFocusTo` itself is not reused because its fallback is the application's
 * global ladder, which would be reached *before* the rungs below — the next
 * Remove button, then the row the comment sat under, then the file the reviewer
 * is on — every one of which is nearer to what they were doing than any anchor.
 *
 * The rungs, and the case each one is the answer to:
 *
 *  1. the next Remove button in the same card stack, then the previous one — a
 *     reviewer clearing several comments off one line, or several cards out of
 *     the drifted group, keeps going without moving their hands;
 *  2. the diff row the card sat under, which is where that comment was about.
 *     Only the row-attached cards have one: the drifted group is a stack of
 *     comments that have no row, which is what it is for;
 *  3. the row of the file the reviewer is looking at, in the changed-file list.
 *     This is the last rung because it is the one that cannot be missing: the
 *     pane returns early when there is no changed file, so every Remove button
 *     on screen is on screen beside a selected file row. `aria-current="true"`
 *     is how that row is found — the same attribute a screen reader reads to say
 *     which file is open — so this ladder is one of its two readers.
 *
 * There is no rung below 3 and deliberately so: a fourth that could not be
 * reached would be a claim about this pane that no test could ever check.
 *
 * ## Why the ladder is built before the removal and walked after it
 *
 * Every rung is read off the button that was clicked — its stack, its row, its
 * pane — and by the time the removal has rendered that button is detached, so
 * `closest` walks a fragment that no longer contains any of them and answers
 * `null` for all three. So {@link removalLadder} is called from the click, while
 * the button is still in the document, and {@link focusAfterRemoval} is called
 * from an effect once the card is gone. The nodes it holds are the ones React
 * keeps: both card sites key on the comment id, so removing one comment leaves
 * every other card's DOM node exactly where it was. A rung that did not survive
 * is skipped by `canTakeFocus`, which asks `isConnected` first.
 */
function removalLadder(button: HTMLElement): readonly (Element | null | undefined)[] {
  const scope = button.closest('[data-remove-scope]');
  const siblings =
    scope === null ? [] : Array.from(scope.querySelectorAll<HTMLElement>('[data-remove-button]'));
  const at = siblings.indexOf(button);
  return [
    siblings[at + 1],
    siblings[at - 1],
    scope?.querySelector('[data-row-button]'),
    button.closest('[data-diff-pane]')?.querySelector('[data-file-row][aria-current="true"]'),
  ];
}

/**
 * Walk {@link removalLadder}'s rungs, and stop at the first that takes focus.
 *
 * NOT GUARDED, and said here rather than left to be discovered: replacing
 * `canTakeFocus` with a bare `instanceof HTMLElement` **and** deleting the
 * `document.activeElement === rung` check together reddens nothing — measured,
 * `npx vitest run` twice, `123 passed (123)` / `2540 passed (2540)` both times.
 * Every rung these tests reach is connected and takes focus on the first ask, so
 * jsdom cannot tell a verified `focus()` from a hopeful one. The pair is kept
 * because `returnFocusTo` in `src/state/focus-store.ts` documents four real
 * defects that were exactly this ("`focus()` is a request, not a result"), and
 * because a rung *can* be a corpse in principle — but no round this pane can be
 * put in makes one, since a removal unmounts only its own card. A test that
 * detached a rung by hand would be asserting jsdom's behaviour, not this pane's.
 */
function focusAfterRemoval(ladder: readonly (Element | null | undefined)[]): void {
  for (const rung of ladder) {
    if (!canTakeFocus(rung)) continue;
    rung.focus();
    if (document.activeElement === rung) return;
  }
}

/**
 * The cache key for one file's diff: the two strings the diff is a function of,
 * in a form where two different pairs cannot come out the same.
 *
 * Length-prefixed, not merely joined. A plain `baseline + working` makes
 * `('ab', 'c')` and `('a', 'bc')` the same key, and a separator alone does not
 * fix it, because a separator can occur in the text — `('a b', 'c')` and
 * `('a', 'b c')` join to the same string. The leading length says where the
 * first string ends, whatever is in it.
 *
 * Exported for the guard, and the guard is a unit test, because the collision
 * cannot be staged through the pane. The cache holds one entry per path and
 * compares it only against that path's next key, so a collision would have to be
 * between two **consecutive** states of one file — and the store has exactly
 * three writes to a file (`code-workspace-store.ts`): `addFile` makes both
 * strings empty, `editFile` changes `working` alone, and `saveFile` sets
 * `baseline` to `working`. The first two leave `baseline` where it was, so a
 * plain join changes with `working`; the third makes the pair `(w, w)`, which
 * joins the same as `(b, w)` only when `b === w`, i.e. when the file had no
 * diff and there was nothing to go stale. So `keys the diff cache on where the
 * baseline ends, not just on the two texts run together` asserts the property
 * here, on the function, and says plainly that today it is defence rather than a
 * bug that was reached: a fourth writer — a revert, a checkout, a reload that
 * sets `baseline` and `working` in one step — is what it is waiting for.
 */
export function diffCacheKey(baseline: string, working: string): string {
  return `${baseline.length}\u0000${baseline}\u0000${working}`;
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
        const key = diffCacheKey(file.baseline, file.working);
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

  // What a removal leaves behind, held from the click until the card is gone:
  // the rungs to try (see `removalLadder`, which must read them while the button
  // is still attached) and the sentence to speak. Both are refs rather than
  // state — writing them must not itself draw anything, and the render that
  // matters is the one the store's removal causes.
  const pending = useRef<{
    readonly ladder: readonly (Element | null | undefined)[];
    readonly subject: string;
  } | null>(null);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    const removal = pending.current;
    if (removal === null) return;
    pending.current = null;
    focusAfterRemoval(removal.ladder);
    // The count comes from this render rather than from the click, so it is the
    // number of comments there now, not one less than there were.
    const left = work.comments.length;
    setAnnouncement(
      `Removed ${removal.subject}. ${
        left === 0
          ? 'No comments left in this round.'
          : `${left} comment${left === 1 ? '' : 's'} pending.`
      }`,
    );
  }, [work.comments]);

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
  //   `a lost line waits on its own file rather than following the reviewer
  //   onto every other diff` is what measures that qualifier; dropping it puts
  //   the card on every file's diff, which is the state the sentence rejects.
  //
  // Built once for the whole round rather than per card, because distinctness
  // is a property of the set and no per-card call can see the set. Not a hook:
  // it is cheap, and hoisting it above the early return would mean handing it a
  // file-on-screen that does not exist there.
  const labelled = removeLabels(anchored, current.file.path);
  const listed = new Set(changed.map((entry) => entry.file.path));
  const drifted = labelled.filter(
    ({ entry }) =>
      !listed.has(entry.comment.path) ||
      (entry.line === null && entry.comment.path === current.file.path),
  );

  /**
   * The click, before the store hears about it: the ladder has to be read while
   * the button is still in the document, and the subject while the comment is
   * still in the round.
   */
  function remove(button: HTMLElement, id: string, subject: string): void {
    pending.current = { ladder: removalLadder(button), subject };
    removeComment(sessionId, id);
  }

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
      data-diff-pane
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
            // One stack, so the ladder's first rung is the next card in this
            // group. There is no `data-row-button` in here by construction:
            // having no row is what puts a comment in this group.
            data-remove-scope
          >
            <p className={styles.driftedLead}>
              {drifted.length === 1
                ? 'One comment has no row in the diff below to sit under. Submitting sends it anyway.'
                : `${drifted.length} comments have no row in the diff below to sit under. Submitting sends them anyway.`}
            </p>
            {drifted.map(({ entry, name, subject }) => (
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
                  aria-label={name}
                  data-remove-button
                  onClick={(event) => remove(event.currentTarget, entry.comment.id, subject)}
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
          labelled={labelled}
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
          onRemove={remove}
        />

        {/* Remove destroys the card the reviewer was standing on, and the
            keyboard is put somewhere by `focusAfterRemoval` — but landing
            somewhere is not the same as being told what happened. Rendered
            always, empty at first: a live region added to the tree at the moment
            it has something to say is a region the screen reader was not
            watching. `role="status"` is polite, because a removal the reviewer
            asked for should not interrupt what they are reading. */}
        <p className={styles.srOnly} role="status">
          {announcement}
        </p>

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
        // Which file's diff is on screen, said in the markup and not only in a
        // class name — the highlight is CSS and a screen reader cannot see it.
        // Two things read it: a reviewer's assistive technology, and
        // `removalLadder`'s last rung, which lands the keyboard here when the
        // card it was on was the last one in its stack. `names the file whose
        // diff is on screen, and moves the mark when the reviewer changes file`
        // asserts the attribute itself.
        aria-current={selected ? 'true' : undefined}
        data-file-row
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
  labelled,
  commentingRow,
  draft,
  onDraft,
  onCommentRow,
  onAdd,
  onRemove,
}: {
  readonly rows: readonly DiffRow[];
  readonly path: string;
  /**
   * Every pending comment of the session, with the line it points at *now* and
   * the name of the button that removes it — {@link removeLabels} over the whole
   * round, in the round's own order.
   */
  readonly labelled: readonly LabelledComment[];
  readonly commentingRow: number | null;
  readonly draft: string;
  readonly onDraft: (value: string) => void;
  readonly onCommentRow: (index: number) => void;
  readonly onAdd: (row: DiffRow) => void;
  readonly onRemove: (button: HTMLElement, id: string, subject: string) => void;
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
    // keyboard from the comment box the moment a character is typed into it —
    // and would take it on the very first render, before the reviewer has asked
    // this pane for anything. `does not take the keyboard just by being drawn`
    // is what asserts the first render; deleting the line below reddens it.
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
        const attached = labelled.filter(
          ({ entry }) =>
            entry.comment.path === path &&
            entry.comment.side === anchor.side &&
            entry.line === anchor.line,
        );
        return (
          // The row and the cards under it are one stack for `removalLadder`:
          // the next card on the same line first, then the row itself.
          <div key={`${row.kind}-${index}`} data-remove-scope>
            <button
              type="button"
              ref={index === bounded ? activeRef : null}
              tabIndex={index === bounded ? 0 : -1}
              className={styles.diffLine}
              data-kind={row.kind}
              data-row-button
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

            {attached.map(({ entry, name, subject }) => (
              <div key={entry.comment.id} className={styles.commentCard}>
                <p className={styles.commentBody}>{entry.comment.body}</p>
                <button
                  type="button"
                  className={styles.paneButton}
                  aria-label={name}
                  data-remove-button
                  onClick={(event) => {
                    // The roving stop moves to this row before the ladder lands
                    // the keyboard on it, so the row that ends up focused is the
                    // row Up and Down then continue from. Without it the
                    // keyboard would sit on a `tabIndex={-1}` row and the next
                    // arrow key would jump back to wherever the stop was left.
                    setActive(index);
                    onRemove(event.currentTarget, entry.comment.id, subject);
                  }}
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
