/**
 * The diff review.
 *
 * Mounted on its own rather than through the whole workspace, because the
 * session and the file it reads are cheaper to seed through the store than to
 * type — and because the case this file exists for, a change larger than
 * `MAXIMUM_ALIGNED_LINES`, is two texts of 2001 lines each that no test should
 * be pasting a character at a time. The workspace's own wiring is proven in
 * `CodeWorkspace.test.tsx`, which drives the same pane by hand.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MAXIMUM_ALIGNED_LINES } from '@/lib/text-diff';
import { resetCodeWorkspaceStore, useCodeWorkspaceStore } from '@/state/code-workspace-store';

import { diffCacheKey, DiffPane } from './DiffPane';

/**
 * How many times the pane actually diffed something.
 *
 * `vi.hoisted` because `vi.mock` is lifted above the imports, so a plain
 * module-level binding is not initialised yet when the factory runs. The real
 * `diffText` still does the work — this only counts the calls.
 */
const diffCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock('@/lib/text-diff', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/text-diff')>();
  return {
    ...actual,
    diffText: (before: string, after: string) => {
      diffCalls.count += 1;
      return actual.diffText(before, after);
    },
  };
});

const SESSION = 'fix-a';

/**
 * `delay: null` for the reason `src/app/modal-containment.test.tsx` records:
 * `userEvent`'s default yields once per simulated input step and a
 * `setTimeout(0)` turn costs a full Windows scheduler tick whether the box is
 * idle or loaded. Nothing here asserts how long a click took, and this file and
 * its sibling drive enough of them for the default to show up in the clock. Run
 * as a pair, their `tests` time measures 31.10s, 14.89s and 18.46s with
 * `delay: null` (three runs, the first cold) against 82.64s and 49.56s with a
 * plain `userEvent.setup()` (two runs), same machine, same session.
 *
 * What that costs any *other* file is not measured. Every test in this repo has
 * a five-second per-test budget and a contended full run does cross it — one
 * run here went `4 failed | 2518 passed (2522)`, all four `Test timed out in
 * 5000ms`, and the next run of the same tree was clean — but no measurement
 * here attributes a specific crossing to this file's delay setting.
 */
function driver(): ReturnType<typeof userEvent.setup> {
  return userEvent.setup({ delay: null });
}

/** A session with one file, saved as `baseline` and now holding `working`. */
function seed(files: readonly { path: string; baseline: string; working: string }[]): void {
  act(() => {
    const store = useCodeWorkspaceStore.getState();
    store.startSession({
      worktree: SESSION,
      folder: 'C:/code/vela',
      environment: 'local',
      providerId: 'workstation',
      modelId: 'local-model',
      permissionMode: 'default',
    });
    for (const file of files) {
      store.addFile(SESSION, file.path);
      // The baseline is what Save last wrote, so it is reached by typing the
      // baseline and saving, then typing the working copy. Doing it any other
      // way would be seeding a state the product cannot produce.
      store.editFile(SESSION, file.path, file.baseline);
      store.saveFile(SESSION, file.path);
      store.editFile(SESSION, file.path, file.working);
    }
  });
}

/**
 * The line buttons, by name rather than by position.
 *
 * `getAllByRole('button')` inside the group also matches the Remove button on
 * every comment card, so adding a comment silently shifts every index after it —
 * which is how the second comment in a round lands on a different line than the
 * one the test says.
 */
function rows(): readonly HTMLElement[] {
  return within(screen.getByRole('group', { name: /^Changes in/ })).getAllByRole('button', {
    name: /^Comment on line/,
  });
}

function queue(): readonly string[] {
  return useCodeWorkspaceStore.getState().work[SESSION]?.queue ?? [];
}

/**
 * The invariant, in one expression: `expected` Remove buttons on screen and no
 * two of them named the same.
 *
 * Twice before, this file asserted distinctness for the one arrangement the
 * last reviewer had named — different bodies, then different files — and both
 * times the next arrangement collided. The property is what the tests below
 * assert instead, over every axis a name is built from: the file, the line, the
 * side, the quoted line and the body, plus the case where a reviewer writes the
 * same comment twice and none of those differ at all.
 *
 * `expected` is passed rather than read off the store because a pending comment
 * on a changed file the reviewer has not selected renders no button at all, so
 * the number of buttons is a fact about the arrangement rather than about the
 * round.
 */
function distinctRemoveNames(expected: number): readonly string[] {
  const names = screen
    .getAllByRole('button', { name: /^Remove comment/ })
    .map((button) => button.getAttribute('aria-label') ?? '');
  expect(names).toHaveLength(expected);
  expect(new Set(names).size).toBe(expected);
  return names;
}

beforeEach(() => {
  resetCodeWorkspaceStore();
});

describe('what the diff pane shows', () => {
  it('says there is nothing to review rather than drawing an empty frame', () => {
    seed([]);
    render(<DiffPane sessionId={SESSION} />);

    expect(screen.getByText(/No changes in this session yet/)).toBeInTheDocument();
  });

  it('lists only the files that actually changed, with the stat the spec describes', () => {
    seed([
      { path: 'src/a.ts', baseline: 'one\ntwo\nthree', working: 'one\nTWO\nthree\nfour' },
      { path: 'src/untouched.ts', baseline: 'same', working: 'same' },
    ]);
    render(<DiffPane sessionId={SESSION} />);

    const list = within(screen.getByRole('list', { name: 'Changed files' }));
    expect(list.getByRole('button', { name: /src\/a\.ts/ })).toHaveTextContent('+2 -1');
    expect(list.queryByRole('button', { name: /untouched/ })).not.toBeInTheDocument();
  });

  it('names the file whose diff is on screen, and moves the mark when the reviewer changes file', async () => {
    // The highlight on the selected row is a CSS class, which a screen reader
    // cannot see, so `aria-current` is the only programmatic answer to "which
    // file am I looking at". It is also the last rung of the ladder that catches
    // the keyboard after a removal (`removalLadder`), so this asserts an
    // attribute two different readers depend on and neither of them is prose.
    const user = driver();
    seed([
      { path: 'src/a.ts', baseline: 'one', working: 'ONE' },
      { path: 'src/b.ts', baseline: 'two', working: 'TWO' },
    ]);
    render(<DiffPane sessionId={SESSION} />);

    const list = within(screen.getByRole('list', { name: 'Changed files' }));
    const first = list.getByRole('button', { name: /src\/a\.ts/ });
    const second = list.getByRole('button', { name: /src\/b\.ts/ });
    expect(first).toHaveAttribute('aria-current', 'true');
    expect(second).not.toHaveAttribute('aria-current');

    await user.click(second);
    expect(screen.getByRole('group', { name: 'Changes in src/b.ts' })).toBeInTheDocument();
    expect(second).toHaveAttribute('aria-current', 'true');
    expect(first).not.toHaveAttribute('aria-current');
  });

  it('numbers each row on the side it exists in', () => {
    seed([{ path: 'src/a.ts', baseline: 'one\ntwo', working: 'one\nTWO' }]);
    render(<DiffPane sessionId={SESSION} />);

    expect(rows()[1]).toHaveAccessibleName('Comment on line 2 before');
    expect(rows()[2]).toHaveAccessibleName('Comment on line 2 after');
  });

  describe('a change too large to align', () => {
    // The reason this pane reads `aligned` at all. Both texts are over the cap
    // and share no prefix or suffix, so `diffText` declines to align them — and
    // its `added`/`removed` then count lines rather than changes. Printing them
    // as `+2001 -2001` would be a number that means something else.
    const before = Array.from({ length: MAXIMUM_ALIGNED_LINES + 1 }, (_, i) => `L${i}`).join('\n');
    const after = Array.from({ length: MAXIMUM_ALIGNED_LINES + 1 }, (_, i) => `R${i}`).join('\n');

    it('says the change was not aligned, rather than printing a line count as a change count', () => {
      // The huge file is listed *second*, so the pane selects the first and
      // never renders four thousand row buttons — this test is about the stat
      // on the file row, and the lead beside the rows is asserted below.
      // Measured by swapping the two seeds and running this test alone, twice
      // each: 518ms and 422ms as written, 2796ms and 2530ms with the huge file
      // first. Six times the cost for nothing this test asserts, and while
      // neither figure crosses the 5s per-test budget on a quiet machine, a
      // contended full run of this repo does cross it — which is the
      // ceiling-versus-cost argument `src/features/models/EndpointsPanel.test.tsx`
      // makes at length: a budget raised to cover a cost that scales with load
      // gets raised again.
      seed([
        { path: 'src/small.ts', baseline: 'one', working: 'ONE' },
        { path: 'src/huge.ts', baseline: before, working: after },
      ]);
      render(<DiffPane sessionId={SESSION} />);

      const list = within(screen.getByRole('list', { name: 'Changed files' }));
      expect(list.getByRole('button', { name: /huge/ })).toHaveTextContent('not aligned');
      expect(list.getByRole('button', { name: /huge/ })).not.toHaveTextContent('+2001');
      expect(list.getByRole('button', { name: /huge/ })).not.toHaveTextContent('-2001');
    });

    it('does not call the fallback a whole-file replacement, because it is not one', () => {
      // The common prefix and suffix are trimmed *before* the cap is applied and
      // are emitted as `same` rows either way, so a pair with identical ends is
      // partly compared. The first draft announced a whole-file replacement
      // directly above the lines it had just compared.
      const shared = 'shared header';
      seed([
        {
          path: 'src/ends.ts',
          baseline: `${shared}\n${before}\n${shared}`,
          working: `${shared}\nrewritten\n${shared}`,
        },
      ]);
      render(<DiffPane sessionId={SESSION} />);

      const lead = screen.getByText(/too large to compare line by line/);
      expect(lead).toHaveTextContent('the changed part is shown as a wholesale replacement');
      expect(lead).not.toHaveTextContent('whole-file');

      // Two rows still read `shared header` — the prefix and the suffix. A
      // whole-file replacement would have neither. `getAllByText` rather than a
      // role-and-name query for two reasons, both measured by swapping this one
      // line for `getAllByRole('button', { name: new RegExp(shared) })` and
      // running this test alone, twice. It does not work: a row button's
      // accessible name is its `aria-label`, `Comment on line N after`, never
      // its text, so the query reports `Unable to find an accessible element
      // with the role "button" and name `/shared header/`` both times. And it
      // is expensive, because this diff renders 2004 row buttons (1 prefix +
      // 2001 removed + 1 added + 1 suffix) and the query computes a name for
      // every one: `tests` time went 4.75s and 2.83s as written against 28.06s
      // and 32.97s that way. Only the left side is over the cap — that is
      // enough to refuse the alignment, and it halves the rows against a
      // version where both sides were.
      const group = within(screen.getByRole('group', { name: /^Changes in/ }));
      expect(group.getAllByText(shared)).toHaveLength(2);
    });

    it('does not reach the cap merely because the file is long', () => {
      // The same two thousand lines with one changed in the middle: the prefix
      // and suffix are trimmed first, so what is aligned is one line against one.
      const edited = before.replace('L1000', 'CHANGED');
      seed([{ path: 'src/long.ts', baseline: before, working: edited }]);
      render(<DiffPane sessionId={SESSION} />);

      const list = within(screen.getByRole('list', { name: 'Changed files' }));
      expect(list.getByRole('button', { name: /long/ })).toHaveTextContent('+1 -1');
    });
  });
});

describe('commenting on a line', () => {
  beforeEach(() => {
    seed([{ path: 'src/a.ts', baseline: 'one\ntwo', working: 'one\nTWO' }]);
  });

  it('opens a box on the line the reviewer chose and keeps what they wrote', async () => {
    const user = driver();
    render(<DiffPane sessionId={SESSION} />);

    await user.click(rows()[2] as HTMLElement);
    await user.click(screen.getByLabelText('Your comment on line 2'));
    await user.paste('this should be a constant');
    await user.click(screen.getByRole('button', { name: 'Add comment' }));

    expect(screen.getByText('this should be a constant')).toBeInTheDocument();
    expect(useCodeWorkspaceStore.getState().work[SESSION]?.comments).toHaveLength(1);
  });

  it('counts pending comments on the file row', async () => {
    const user = driver();
    render(<DiffPane sessionId={SESSION} />);

    await user.click(rows()[2] as HTMLElement);
    await user.click(screen.getByLabelText('Your comment on line 2'));
    await user.paste('first');
    await user.keyboard('{Enter}');

    const list = within(screen.getByRole('list', { name: 'Changed files' }));
    expect(list.getByRole('button', { name: /src\/a\.ts/ })).toHaveTextContent('1');
  });

  it('takes a comment back off the pending set', async () => {
    const user = driver();
    render(<DiffPane sessionId={SESSION} />);

    await user.click(rows()[2] as HTMLElement);
    await user.click(screen.getByLabelText('Your comment on line 2'));
    await user.paste('on reflection, no');
    await user.keyboard('{Enter}');
    expect(useCodeWorkspaceStore.getState().work[SESSION]?.comments).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /^Remove comment/ }));

    expect(useCodeWorkspaceStore.getState().work[SESSION]?.comments).toHaveLength(0);
    expect(screen.queryByText('on reflection, no')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit review' })).toBeDisabled();
  });

  it('sends every comment as one message, not one message each', async () => {
    const user = driver();
    render(<DiffPane sessionId={SESSION} />);

    await user.click(rows()[1] as HTMLElement);
    await user.click(screen.getByLabelText('Your comment on line 2'));
    await user.paste('why did this go?');
    await user.keyboard('{Enter}');

    await user.click(rows()[2] as HTMLElement);
    await user.click(screen.getByLabelText('Your comment on line 2'));
    await user.paste('and this arrived');
    await user.keyboard('{Enter}');

    await user.click(screen.getByRole('button', { name: 'Submit review' }));

    expect(queue()).toHaveLength(1);
    expect(queue()[0]).toContain('2 comments on the diff');
    expect(queue()[0]).toContain('why did this go?');
    expect(queue()[0]).toContain('and this arrived');
    expect(useCodeWorkspaceStore.getState().work[SESSION]?.comments).toHaveLength(0);
  });

  it('submits the round on Ctrl+Enter, from inside the comment box', async () => {
    const user = driver();
    render(<DiffPane sessionId={SESSION} />);

    await user.click(rows()[2] as HTMLElement);
    const box = screen.getByLabelText('Your comment on line 2');
    await user.click(box);
    await user.paste('one thought');
    await user.keyboard('{Enter}');

    await user.click(rows()[2] as HTMLElement);
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(queue()).toHaveLength(1);
  });

  it('will not queue a blank round', async () => {
    const user = driver();
    render(<DiffPane sessionId={SESSION} />);

    expect(screen.getByRole('button', { name: 'Submit review' })).toBeDisabled();
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(queue()).toHaveLength(0);
  });

  it('drops a file’s comments when a save empties the diff they point into', async () => {
    const user = driver();
    render(<DiffPane sessionId={SESSION} />);

    await user.click(rows()[2] as HTMLElement);
    await user.click(screen.getByLabelText('Your comment on line 2'));
    await user.paste('a comment about a line');
    await user.keyboard('{Enter}');
    expect(useCodeWorkspaceStore.getState().work[SESSION]?.comments).toHaveLength(1);

    act(() => {
      useCodeWorkspaceStore.getState().saveFile(SESSION, 'src/a.ts');
    });

    expect(useCodeWorkspaceStore.getState().work[SESSION]?.comments).toHaveLength(0);
    expect(screen.getByText(/No changes in this session yet/)).toBeInTheDocument();
  });
});

describe('a comment when the file moves under it', () => {
  /**
   * The class this track's diff work was about, one level down. A comment is
   * anchored by (path, side, line) and quotes the line verbatim; `saveFile`
   * clears a file's comments because a save erases the diff wholesale. Editing
   * does not erase the diff — it *renumbers* it, and nothing re-asked whether
   * the anchor still pointed at the line it quotes. A comment written on `BETA`
   * rendered under `INSERTED` and would have been submitted as `src/a.ts:2
   * (after)` quoting `BETA`.
   */
  beforeEach(() => {
    seed([{ path: 'src/a.ts', baseline: 'alpha', working: 'alpha\nBETA' }]);
  });

  async function commentOnBeta(user: ReturnType<typeof driver>): Promise<void> {
    await user.click(screen.getByRole('button', { name: 'Comment on line 2 after' }));
    await user.click(screen.getByLabelText('Your comment on line 2'));
    await user.paste('this should be a constant');
    await user.keyboard('{Enter}');
  }

  /**
   * The same thing on any row of the file on screen, by the row's own name.
   *
   * `side` is the word the row button uses, not the stored `'left'`/`'right'` —
   * a removed row and an added row can share a line number, and the pair of
   * them is the only way to reach two comments that differ by side alone.
   */
  async function commentOn(
    user: ReturnType<typeof driver>,
    row: { readonly line: number; readonly side: 'before' | 'after' },
    body: string,
  ): Promise<void> {
    await user.click(
      screen.getByRole('button', { name: `Comment on line ${row.line} ${row.side}` }),
    );
    await user.click(screen.getByLabelText(`Your comment on line ${row.line}`));
    await user.paste(body);
    await user.keyboard('{Enter}');
  }

  it('follows the line it quotes when a line is inserted above it', async () => {
    const user = driver();
    render(<DiffPane sessionId={SESSION} />);
    await commentOnBeta(user);

    act(() => {
      useCodeWorkspaceStore.getState().editFile(SESSION, 'src/a.ts', 'alpha\nINSERTED\nBETA');
    });

    const card = screen.getByText('this should be a constant').closest('div');
    expect(card?.previousElementSibling).toHaveTextContent('BETA');
    expect(card?.previousElementSibling).not.toHaveTextContent('INSERTED');

    await user.click(screen.getByRole('button', { name: 'Submit review' }));
    expect(queue()[0]).toContain('src/a.ts:3 (after)');
    expect(queue()[0]).not.toContain('src/a.ts:2 (after)');
  });

  it('says the line is gone rather than naming one that now says something else', async () => {
    const user = driver();
    render(<DiffPane sessionId={SESSION} />);
    await commentOnBeta(user);

    act(() => {
      useCodeWorkspaceStore.getState().editFile(SESSION, 'src/a.ts', 'alpha\nGAMMA');
    });

    const stranded = within(
      screen.getByRole('group', { name: 'Comments with no row to sit under' }),
    );
    expect(stranded.getByText(/The line it quotes is no longer in the diff/)).toBeInTheDocument();
    expect(stranded.getByText(/sent without a line number/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Submit review' }));
    expect(queue()[0]).toContain('no longer in the diff');
    expect(queue()[0]).not.toContain('src/a.ts:2 (after)');
    expect(queue()[0]).toContain('BETA');
  });

  it('a lost line waits on its own file rather than following the reviewer onto every other diff', async () => {
    // The qualifier on `drifted`'s second arm, on its own. A comment whose
    // quoted line is gone from a file that is STILL in the changed list has a
    // row to be shown beside — its own file's — so it waits there. Without the
    // `path === current` half it is drawn on every other file's diff as well,
    // under a group whose lead says "no row in the diff below to sit under"
    // while the diff below is a file the comment has nothing to do with.
    //
    // The other arm is deliberately not exercised here: a comment whose file
    // has LEFT the list does follow the reviewer everywhere, and that is
    // `keeps a comment removable when its file leaves the changed list…`.
    const user = driver();
    seed([
      { path: 'src/a.ts', baseline: 'x', working: 'x\nfoo' },
      { path: 'src/b.ts', baseline: 'one', working: 'ONE' },
    ]);
    render(<DiffPane sessionId={SESSION} />);

    await commentOn(user, { line: 2, side: 'after' }, 'about foo');
    act(() => {
      // `foo` goes; the file it was on still differs, so it keeps its row.
      useCodeWorkspaceStore.getState().editFile(SESSION, 'src/a.ts', 'x\nqux');
    });

    const list = within(screen.getByRole('list', { name: 'Changed files' }));
    expect(list.getByRole('button', { name: /src\/a\.ts/ })).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'Comments with no row to sit under' }),
    ).toBeInTheDocument();

    await user.click(list.getByRole('button', { name: /src\/b\.ts/ }));
    expect(screen.getByRole('group', { name: 'Changes in src/b.ts' })).toBeInTheDocument();
    expect(
      screen.queryByRole('group', { name: 'Comments with no row to sit under' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('about foo')).not.toBeInTheDocument();

    // And it is still there when the reviewer goes back to the file it is about,
    // so what is being asserted is where it waits rather than that it is gone.
    await user.click(list.getByRole('button', { name: /src\/a\.ts/ }));
    expect(screen.getByText('about foo')).toBeInTheDocument();
  });

  it('keeps a comment visible when its whole file stops differing', async () => {
    // The other way to lose a row to sit under, and the one with nowhere
    // obvious to show the result: editing the file back to its baseline takes
    // it out of the changed-file list, so it has no row to select and the
    // comment would be sent from a place the reviewer cannot see or delete.
    // A save is different and is handled in the store — it clears the file's
    // comments outright.
    //
    // Here the QUOTED line goes with the file: `BETA` is an added line, so
    // reverting the edit deletes it and the anchor resolves to null. The test
    // below is the other half — the quoted line survives the revert — and it is
    // the half round 2 shipped broken.
    const user = driver();
    seed([
      { path: 'src/a.ts', baseline: 'alpha', working: 'alpha\nBETA' },
      { path: 'src/other.ts', baseline: 'one', working: 'ONE' },
    ]);
    render(<DiffPane sessionId={SESSION} />);
    await commentOnBeta(user);

    act(() => {
      useCodeWorkspaceStore.getState().editFile(SESSION, 'src/a.ts', 'alpha');
    });

    const list = within(screen.getByRole('list', { name: 'Changed files' }));
    expect(list.queryByRole('button', { name: /src\/a\.ts/ })).not.toBeInTheDocument();
    const stranded = within(
      screen.getByRole('group', { name: 'Comments with no row to sit under' }),
    );
    expect(stranded.getByText(/src\/a\.ts · BETA/)).toBeInTheDocument();
    expect(stranded.getByText('this should be a constant')).toBeInTheDocument();
    // The `line === null` arm, said on the card: `BETA` went with the revert.
    expect(stranded.getByText(/The line it quotes is no longer in the diff/)).toBeInTheDocument();

    await user.click(stranded.getByRole('button', { name: /^Remove comment/ }));
    expect(useCodeWorkspaceStore.getState().work[SESSION]?.comments).toHaveLength(0);
  });

  it('keeps a comment removable when its file leaves the changed list with the quoted line intact', async () => {
    // Round 2's `drifted` filter required `line === null`, which is a claim
    // that a file leaving the changed-file list takes its rows with it. It does
    // not: `diffText('alpha', 'alpha')` returns one `same` row. So a comment on
    // a CONTEXT line survives the revert with a real anchor, has no file row to
    // be rendered under, and was neither shown nor removable — while the review
    // bar still counted it and Submit still sent it as `src/a.ts:1 (after)`.
    const user = driver();
    seed([
      { path: 'src/a.ts', baseline: 'alpha', working: 'alpha\nBETA' },
      { path: 'src/other.ts', baseline: 'one', working: 'ONE' },
    ]);
    render(<DiffPane sessionId={SESSION} />);

    await user.click(screen.getByRole('button', { name: 'Comment on line 1 after' }));
    await user.click(screen.getByLabelText('Your comment on line 1'));
    await user.paste('this line worries me');
    await user.keyboard('{Enter}');

    act(() => {
      useCodeWorkspaceStore.getState().editFile(SESSION, 'src/a.ts', 'alpha');
    });

    // The file is gone from the list, so there is no row anywhere that could
    // hold this card — and its anchor is a number, not null.
    const list = within(screen.getByRole('list', { name: 'Changed files' }));
    expect(list.queryByRole('button', { name: /src\/a\.ts/ })).not.toBeInTheDocument();

    const stranded = within(
      screen.getByRole('group', { name: 'Comments with no row to sit under' }),
    );
    expect(stranded.getByText(/src\/a\.ts · alpha/)).toBeInTheDocument();
    expect(stranded.getByText('this line worries me')).toBeInTheDocument();
    // The reason names the arm it came in on, and says it still carries a line.
    expect(stranded.getByText(/no longer in the changed-file list/)).toBeInTheDocument();
    expect(stranded.getByText(/sent as line 1 after/)).toBeInTheDocument();
    expect(
      stranded.getByRole('button', {
        name: 'Remove comment on src/a.ts, line 1 after: this line worries me',
      }),
    ).toBeInTheDocument();

    await user.click(stranded.getByRole('button', { name: /^Remove comment/ }));
    expect(useCodeWorkspaceStore.getState().work[SESSION]?.comments).toHaveLength(0);
    expect(screen.getByText(/No comments yet/)).toBeInTheDocument();
  });

  it('names each Remove button for the comment it removes', async () => {
    const user = driver();
    render(<DiffPane sessionId={SESSION} />);
    await commentOnBeta(user);

    await user.click(screen.getByRole('button', { name: 'Comment on line 2 after' }));
    await user.click(screen.getByLabelText('Your comment on line 2'));
    await user.paste('and name the file too');
    await user.keyboard('{Enter}');

    distinctRemoveNames(2);
  });

  it('tells two Remove buttons apart when the comments are on different files', async () => {
    // The uniqueness above is measured inside one file, so it is blind to the
    // case `drifted` opened: a card whose file has left the changed-file list
    // sits beside a row-attached card of the file that is on screen. Same line,
    // same side, same body is then one accessible name for two buttons that
    // remove different comments — while the reviewer looking at the screen has
    // the path, printed by `.driftedQuote` directly above the button that
    // withheld it.
    const user = driver();
    seed([
      { path: 'src/a.ts', baseline: 'alpha', working: 'alpha\nBETA' },
      { path: 'src/other.ts', baseline: 'alpha', working: 'alpha\nGAMMA' },
    ]);
    render(<DiffPane sessionId={SESSION} />);

    // On src/a.ts, on the CONTEXT line, so the anchor survives the revert below.
    await user.click(screen.getByRole('button', { name: 'Comment on line 1 after' }));
    await user.click(screen.getByLabelText('Your comment on line 1'));
    await user.paste('fix this');
    await user.keyboard('{Enter}');

    act(() => {
      useCodeWorkspaceStore.getState().editFile(SESSION, 'src/a.ts', 'alpha');
    });

    // src/other.ts is now the file on screen, and this is the collision: the
    // same body on the same line and side of a different file.
    await user.click(screen.getByRole('button', { name: 'Comment on line 1 after' }));
    await user.click(screen.getByLabelText('Your comment on line 1'));
    await user.paste('fix this');
    await user.keyboard('{Enter}');

    const names = distinctRemoveNames(2);
    expect(names).toContain('Remove comment on src/a.ts, line 1 after: fix this');
    expect(names).toContain('Remove comment on line 1 after: fix this');

    // Distinct is not enough on its own: the name has to be the name of the
    // comment that button actually removes.
    await user.click(
      screen.getByRole('button', { name: 'Remove comment on src/a.ts, line 1 after: fix this' }),
    );
    const left = useCodeWorkspaceStore.getState().work[SESSION]?.comments ?? [];
    expect(left.map((comment) => comment.path)).toEqual(['src/other.ts']);
  });

  it('tells two Remove buttons apart when both comments have lost the line they quote', async () => {
    // Same file, same arm, same body — the case a path prefix cannot separate,
    // and the one the previous round's fix left behind. Two comments on two
    // different added lines, then an edit that takes both of those lines away
    // while the file itself keeps differing: both land on
    // `line === null && path === current`, where the name has no line number to
    // carry and the path is the file on screen, so on 687c189's naming both
    // come back `Remove comment on a line no longer in the diff: nit` —
    // measured with a probe that prints the names, not inferred.
    //
    // The quoted line is the discriminator and it is already on screen —
    // `.driftedQuote` prints `foo` above one button and `bar` above the other.
    const user = driver();
    seed([{ path: 'src/a.ts', baseline: 'x', working: 'x\nfoo\nbar' }]);
    render(<DiffPane sessionId={SESSION} />);

    await commentOn(user, { line: 2, side: 'after' }, 'nit');
    await commentOn(user, { line: 3, side: 'after' }, 'nit');

    act(() => {
      useCodeWorkspaceStore.getState().editFile(SESSION, 'src/a.ts', 'x\nqux');
    });

    const stranded = within(
      screen.getByRole('group', { name: 'Comments with no row to sit under' }),
    );
    expect(stranded.getByText('foo')).toBeInTheDocument();
    expect(stranded.getByText('bar')).toBeInTheDocument();

    const names = distinctRemoveNames(2);
    expect(names).toContain('Remove comment on a line no longer in the diff (it read "foo"): nit');
    expect(names).toContain('Remove comment on a line no longer in the diff (it read "bar"): nit');

    // Distinct is not enough on its own: the button named for `foo` has to be
    // the one that removes the comment on `foo`.
    await user.click(
      screen.getByRole('button', {
        name: 'Remove comment on a line no longer in the diff (it read "foo"): nit',
      }),
    );
    const left = useCodeWorkspaceStore.getState().work[SESSION]?.comments ?? [];
    expect(left.map((comment) => comment.text)).toEqual(['bar']);
  });

  it('tells two identical comments apart by where they sit in the round', async () => {
    // The floor of the problem: a reviewer writes "nit" twice on the same line.
    // Every field a name can be built from agrees — file, line, side, quoted
    // text, body — so no clause added to the name separates them, and every
    // clause the previous rounds added still leaves one name on two buttons.
    // Measured on 687c189's naming rather than argued: both buttons come back
    // `Remove comment on line 2 after: nit`. What is left is the order they
    // were written in, which is the order they are drawn in, and that is what
    // the name falls back to.
    const user = driver();
    render(<DiffPane sessionId={SESSION} />);

    await commentOn(user, { line: 2, side: 'after' }, 'nit');
    await commentOn(user, { line: 2, side: 'after' }, 'nit');

    const names = distinctRemoveNames(2);
    expect(names).toContain('Remove comment on line 2 after: nit (1 of 2)');
    expect(names).toContain('Remove comment on line 2 after: nit (2 of 2)');

    const ids = (useCodeWorkspaceStore.getState().work[SESSION]?.comments ?? []).map(
      (comment) => comment.id,
    );
    expect(ids).toHaveLength(2);

    // `(1 of 2)` is the first one written, so it is the first one in the store.
    await user.click(
      screen.getByRole('button', { name: 'Remove comment on line 2 after: nit (1 of 2)' }),
    );
    const left = useCodeWorkspaceStore.getState().work[SESSION]?.comments ?? [];
    expect(left.map((comment) => comment.id)).toEqual([ids[1]]);

    // And the suffix goes away with the collision it exists for, rather than
    // being a permanent decoration on a comment that no longer shares a name.
    expect(distinctRemoveNames(1)).toEqual(['Remove comment on line 2 after: nit']);
  });

  it('renumbers the siblings a removal leaves behind, which is what a position in the round means', async () => {
    // The cost of the suffix, asserted rather than argued about. `(1 of 3)` is
    // a position in the round, so removing one of the three moves the others —
    // the button a reader was just told was `(3 of 3)` is `(2 of 2)` a moment
    // later, and it is the same button, not a redrawn one.
    //
    // This is the property `removeLabels` says it accepts, and it is here so
    // that a later round cannot quietly swap the discriminator for a stable
    // creation ordinal while the docblock still claims this behaviour. The
    // alternative was measured against the same round: a stable ordinal leaves
    // `(3 of 3)` on screen with two buttons in the group.
    const user = driver();
    render(<DiffPane sessionId={SESSION} />);

    await commentOn(user, { line: 2, side: 'after' }, 'nit');
    await commentOn(user, { line: 2, side: 'after' }, 'nit');
    await commentOn(user, { line: 2, side: 'after' }, 'nit');

    const names = distinctRemoveNames(3);
    expect(names).toEqual([
      'Remove comment on line 2 after: nit (1 of 3)',
      'Remove comment on line 2 after: nit (2 of 3)',
      'Remove comment on line 2 after: nit (3 of 3)',
    ]);

    // Held across the removal on purpose: this is the node a screen reader was
    // sitting on, not a fresh query afterwards.
    const last = screen.getByRole('button', {
      name: 'Remove comment on line 2 after: nit (3 of 3)',
    });
    await user.click(
      screen.getByRole('button', { name: 'Remove comment on line 2 after: nit (1 of 3)' }),
    );

    expect(last.isConnected).toBe(true);
    expect(last).toHaveAttribute('aria-label', 'Remove comment on line 2 after: nit (2 of 2)');
    expect(distinctRemoveNames(2)).toEqual([
      'Remove comment on line 2 after: nit (1 of 2)',
      'Remove comment on line 2 after: nit (2 of 2)',
    ]);
  });

  it('gives every Remove button in a round a name of its own, whatever collides', async () => {
    // One round, three collisions at once, and the assertion is the property
    // rather than any one of them: the same body on two files, the same body on
    // the two sides of one line number, and the same comment written twice. A
    // fifth comment differing only by line number is in the round as the
    // control — it collides with nothing and needs no suffix, which is what
    // makes the two suffixes that ARE present a consequence of the collision
    // rather than a decoration on every button. The tests above measure two of
    // these arms in isolation; this one measures that they do not have to be
    // reached one at a time to be told apart.
    const user = driver();
    seed([
      { path: 'src/a.ts', baseline: 'alpha', working: 'alpha\nBETA' },
      { path: 'src/b.ts', baseline: 'one\ntwo', working: 'ONE\ntwo' },
    ]);
    render(<DiffPane sessionId={SESSION} />);

    // On src/a.ts, on its context line, so the anchor survives the revert.
    await commentOn(user, { line: 1, side: 'after' }, 'nit');
    act(() => {
      useCodeWorkspaceStore.getState().editFile(SESSION, 'src/a.ts', 'alpha');
    });

    // src/b.ts is now the file on screen, and it has a removed row and an added
    // row on the same line number — the side axis. No other test in this file
    // puts two comments on it; `numbers each row on the side it exists in`
    // asserts the two ROW buttons, which is a different pair of names.
    await commentOn(user, { line: 1, side: 'before' }, 'nit');
    await commentOn(user, { line: 1, side: 'after' }, 'nit');
    await commentOn(user, { line: 1, side: 'after' }, 'nit');
    await commentOn(user, { line: 2, side: 'after' }, 'nit');

    const ids = (useCodeWorkspaceStore.getState().work[SESSION]?.comments ?? []).map(
      (comment) => comment.id,
    );
    expect(ids).toHaveLength(5);

    const names = distinctRemoveNames(5);
    expect(names).toContain('Remove comment on src/a.ts, line 1 after: nit');
    expect(names).toContain('Remove comment on line 1 before: nit');
    expect(names).toContain('Remove comment on line 1 after: nit (1 of 2)');
    expect(names).toContain('Remove comment on line 1 after: nit (2 of 2)');
    expect(names).toContain('Remove comment on line 2 after: nit');

    await user.click(
      screen.getByRole('button', { name: 'Remove comment on line 1 after: nit (2 of 2)' }),
    );
    const left = useCodeWorkspaceStore.getState().work[SESSION]?.comments ?? [];
    expect(left.map((comment) => comment.id)).toEqual([ids[0], ids[1], ids[2], ids[4]]);
  });
});

describe('after Remove, the keyboard is somewhere and the removal is spoken', () => {
  /**
   * Remove is the pane's only destructive control and it unmounts the button
   * that was just pressed. A browser answers that by focusing `<body>`: the
   * keyboard is at the top of the document, nothing is announced, and a reader
   * who cannot see the card vanish has no way to know it did. That is the
   * defect `src/features/navigation/DeleteConversationDialog.tsx` names in its
   * own prose and answers with a ladder; these are this pane's rungs, one test
   * each, plus what the live region says.
   *
   * Each one asserts the *element*, not merely "not body" — a rung that fires
   * and lands somewhere unhelpful would pass the weaker assertion.
   */
  beforeEach(() => {
    seed([{ path: 'src/a.ts', baseline: 'alpha', working: 'alpha\nBETA' }]);
  });

  async function commentOnBeta(user: ReturnType<typeof driver>, body: string): Promise<void> {
    await user.click(screen.getByRole('button', { name: 'Comment on line 2 after' }));
    await user.click(screen.getByLabelText('Your comment on line 2'));
    await user.paste(body);
    await user.keyboard('{Enter}');
  }

  it('goes to the next comment on the same line', async () => {
    const user = driver();
    render(<DiffPane sessionId={SESSION} />);
    await commentOnBeta(user, 'first');
    await commentOnBeta(user, 'second');

    const survivor = screen.getByRole('button', {
      name: 'Remove comment on line 2 after: second',
    });
    await user.click(
      screen.getByRole('button', { name: 'Remove comment on line 2 after: first' }),
    );

    expect(document.activeElement).toBe(survivor);
  });

  it('goes to the one before it when the comment removed was the last on its line', async () => {
    const user = driver();
    render(<DiffPane sessionId={SESSION} />);
    await commentOnBeta(user, 'first');
    await commentOnBeta(user, 'second');

    const survivor = screen.getByRole('button', {
      name: 'Remove comment on line 2 after: first',
    });
    await user.click(
      screen.getByRole('button', { name: 'Remove comment on line 2 after: second' }),
    );

    expect(document.activeElement).toBe(survivor);
  });

  it('goes to the row the comment sat under, and leaves the arrow keys there', async () => {
    const user = driver();
    render(<DiffPane sessionId={SESSION} />);
    await commentOnBeta(user, 'only');

    await user.click(
      screen.getByRole('button', { name: 'Remove comment on line 2 after: only' }),
    );

    const row = screen.getByRole('button', { name: 'Comment on line 2 after' });
    expect(document.activeElement).toBe(row);
    // The roving stop came with it. Without that, the keyboard would be on a
    // row the next Down key does not start from.
    expect(row).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(row, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Comment on line 1 after' }));
  });

  it('goes to the next card in the drifted group, which is a stack of its own', async () => {
    // The group is the other scope a Remove button can be in, and it is not a
    // diff row: a reviewer clearing two stranded comments should not be sent
    // back to the file list between them.
    const user = driver();
    seed([
      { path: 'src/a.ts', baseline: 'alpha', working: 'alpha\nBETA' },
      { path: 'src/other.ts', baseline: 'one', working: 'ONE' },
    ]);
    render(<DiffPane sessionId={SESSION} />);
    await commentOnBeta(user, 'first');
    await commentOnBeta(user, 'second');

    act(() => {
      useCodeWorkspaceStore.getState().editFile(SESSION, 'src/a.ts', 'alpha');
    });
    const group = within(screen.getByRole('group', { name: 'Comments with no row to sit under' }));
    const survivor = group.getByRole('button', { name: /second$/ });
    await user.click(group.getByRole('button', { name: /first$/ }));

    expect(document.activeElement).toBe(survivor);
  });

  it('goes to the file on screen when the group it was in is gone with it', async () => {
    // The drifted group has no row to fall back to — having no row is what put
    // the comment in it — so the last rung is the changed-file list, found by
    // the `aria-current` mark on the row of the file being read.
    const user = driver();
    seed([
      { path: 'src/a.ts', baseline: 'alpha', working: 'alpha\nBETA' },
      { path: 'src/other.ts', baseline: 'one', working: 'ONE' },
    ]);
    render(<DiffPane sessionId={SESSION} />);
    await commentOnBeta(user, 'stranded');

    act(() => {
      // src/a.ts stops differing, so it leaves the list and takes its rows with
      // it; the comment moves into the drifted group and src/other.ts is on
      // screen.
      useCodeWorkspaceStore.getState().editFile(SESSION, 'src/a.ts', 'alpha');
    });
    const group = screen.getByRole('group', { name: 'Comments with no row to sit under' });
    await user.click(within(group).getByRole('button', { name: /^Remove comment/ }));

    expect(
      screen.queryByRole('group', { name: 'Comments with no row to sit under' }),
    ).not.toBeInTheDocument();
    const fileRow = within(screen.getByRole('list', { name: 'Changed files' })).getByRole(
      'button',
      { name: /src\/other\.ts/ },
    );
    expect(fileRow).toHaveAttribute('aria-current', 'true');
    expect(document.activeElement).toBe(fileRow);
  });

  it('says which comment went and how much of the round is left', async () => {
    const user = driver();
    render(<DiffPane sessionId={SESSION} />);
    await commentOnBeta(user, 'first');
    await commentOnBeta(user, 'second');

    // Empty before anything is removed: a live region that arrives with its
    // text has not been announced, it has been inserted.
    expect(screen.getByRole('status')).toHaveTextContent('');

    await user.click(
      screen.getByRole('button', { name: 'Remove comment on line 2 after: first' }),
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Removed comment on line 2 after: first. 1 comment pending.',
    );

    await user.click(
      screen.getByRole('button', { name: 'Remove comment on line 2 after: second' }),
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Removed comment on line 2 after: second. No comments left in this round.',
    );
  });

  it('names the comment without the position it no longer occupies', async () => {
    // Two identical comments are `(1 of 2)` and `(2 of 2)`; removing one
    // renumbers the other, so the sentence spoken about the one that went says
    // the comment and not the slot. `subject` is that name minus the suffix,
    // which is why it is a field rather than a substring of the label.
    const user = driver();
    render(<DiffPane sessionId={SESSION} />);
    await commentOnBeta(user, 'nit');
    await commentOnBeta(user, 'nit');

    await user.click(
      screen.getByRole('button', { name: 'Remove comment on line 2 after: nit (1 of 2)' }),
    );

    expect(screen.getByRole('status')).toHaveTextContent(
      'Removed comment on line 2 after: nit. 1 comment pending.',
    );
    expect(screen.getByRole('status')).not.toHaveTextContent('of 2');
  });
});

describe('reaching a line by keyboard', () => {
  beforeEach(() => {
    seed([{ path: 'src/a.ts', baseline: 'one\ntwo\nthree', working: 'one\nTWO\nthree' }]);
  });

  it('does not take the keyboard just by being drawn', () => {
    // The roving stop focuses its row only after an arrow key this pane
    // handled. The same effect without that guard runs on the first render too,
    // so opening the pane beside an editor would pull the keyboard out of
    // whatever the user was typing into.
    render(<DiffPane sessionId={SESSION} />);

    expect(rows().length).toBeGreaterThan(1);
    expect(document.activeElement).toBe(document.body);
  });

  it('costs one Tab stop for the whole diff, not one per line', () => {
    render(<DiffPane sessionId={SESSION} />);

    const tabbable = rows().filter((row) => row.tabIndex === 0);
    expect(rows().length).toBeGreaterThan(1);
    expect(tabbable).toHaveLength(1);
  });

  it('moves the stop with the arrow keys and takes the focus with it', () => {
    render(<DiffPane sessionId={SESSION} />);

    (rows()[0] as HTMLElement).focus();
    fireEvent.keyDown(rows()[0] as HTMLElement, { key: 'ArrowDown' });

    expect(rows()[1]).toHaveAttribute('tabindex', '0');
    expect(document.activeElement).toBe(rows()[1]);

    fireEvent.keyDown(rows()[1] as HTMLElement, { key: 'End' });
    expect(rows().at(-1)).toHaveAttribute('tabindex', '0');
  });
});

describe('what typing in the editor costs the diff pane', () => {
  /**
   * `editFile` rebuilds `work.files`, so a `useMemo` keyed on that array re-runs
   * on every keystroke — and the version that did so re-diffed every file the
   * session held, not the one being typed into. Both panes are open in the
   * default layout, so that is the ordinary loop rather than an edge case.
   */
  it('re-diffs only the file that changed, not every file in the session', () => {
    seed([
      { path: 'src/a.ts', baseline: 'a', working: 'A' },
      { path: 'src/b.ts', baseline: 'b', working: 'B' },
      { path: 'src/c.ts', baseline: 'c', working: 'C' },
    ]);
    render(<DiffPane sessionId={SESSION} />);

    diffCalls.count = 0;
    act(() => {
      useCodeWorkspaceStore.getState().editFile(SESSION, 'src/a.ts', 'AB');
    });

    expect(diffCalls.count).toBe(1);
  });

  it('keys the diff cache on where the baseline ends, not just on the two texts run together', () => {
    // What the cache compares is a string, so two different (baseline, working)
    // pairs coming out the same is a stale diff on screen: the pane would hand
    // back the diff it computed for the other pair. Concatenation alone does
    // exactly that, and a separator does not save it, because a separator can
    // occur in the text.
    //
    // This is a unit test rather than a round driven through the pane, and the
    // reason is stated at `diffCacheKey`: the cache holds one entry per path and
    // only ever compares it with that path's next key, and no two CONSECUTIVE
    // states of one file can collide under today's three store writes. So the
    // clash is unreachable through the product and the key is defence against a
    // fourth writer. Defence with a test on it, rather than a comment.
    expect(diffCacheKey('ab', 'c')).not.toBe(diffCacheKey('a', 'bc'));
    expect(diffCacheKey('a b', 'c')).not.toBe(diffCacheKey('a', 'b c'));
    expect(diffCacheKey('ab', 'c')).toBe(diffCacheKey('ab', 'c'));
  });

  it('does not diff again when something else in the session changes', () => {
    seed([{ path: 'src/a.ts', baseline: 'a', working: 'A' }]);
    render(<DiffPane sessionId={SESSION} />);

    diffCalls.count = 0;
    act(() => {
      useCodeWorkspaceStore.getState().queueMessage(SESSION, 'unrelated');
    });

    expect(diffCalls.count).toBe(0);
  });
});
