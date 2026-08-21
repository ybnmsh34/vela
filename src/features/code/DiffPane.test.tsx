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

import { DiffPane } from './DiffPane';

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
 * idle or loaded. Nothing here asserts how long a click took — and this file
 * drives enough of them that its default-delay form took thirty seconds of the
 * suite's wall clock, which is enough parallel load to push the source-scanning
 * guards in `src/platform/` past their five-second per-test budget.
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
      // on the file row, and the lead beside the rows is asserted below. It ran
      // to 5776ms solo before this change, which is the ceiling-versus-cost
      // argument `src/features/models/EndpointsPanel.test.tsx` makes at length:
      // a budget raised to cover a cost that scales with load gets raised
      // again.
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
      // role-and-name query on purpose: this diff renders 2004 row buttons
      // (1 prefix + 2001 removed + 1 added + 1 suffix), and computing an
      // accessible name for each of them ran past the 5s per-test budget when
      // this test was first written that way. Only the left side is over the
      // cap — that is enough to refuse the alignment, and it halves the rows
      // against a version where both sides were.
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
      stranded.getByRole('button', { name: 'Remove comment on line 1 after: this line worries me' }),
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

    const names = screen
      .getAllByRole('button', { name: /^Remove comment/ })
      .map((button) => button.getAttribute('aria-label'));
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });
});

describe('reaching a line by keyboard', () => {
  beforeEach(() => {
    seed([{ path: 'src/a.ts', baseline: 'one\ntwo\nthree', working: 'one\nTWO\nthree' }]);
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
