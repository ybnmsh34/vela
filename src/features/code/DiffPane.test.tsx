/**
 * The diff review.
 *
 * Mounted on its own rather than through the whole workspace, because the
 * session and the file it reads are cheaper to seed through the store than to
 * type — and because the case this file exists for, a change larger than
 * `MAXIMUM_ALIGNED_LINES`, is four thousand lines that no test should be pasting
 * a character at a time. The workspace's own wiring is proven in
 * `CodeWorkspace.test.tsx`, which drives the same pane by hand.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { MAXIMUM_ALIGNED_LINES } from '@/lib/text-diff';
import { resetCodeWorkspaceStore, useCodeWorkspaceStore } from '@/state/code-workspace-store';

import { DiffPane } from './DiffPane';

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

    it('says the file was not compared, rather than printing a line count as a change count', () => {
      seed([{ path: 'src/huge.ts', baseline: before, working: after }]);
      render(<DiffPane sessionId={SESSION} />);

      const list = within(screen.getByRole('list', { name: 'Changed files' }));
      expect(list.getByRole('button', { name: /huge/ })).toHaveTextContent('not compared');
      expect(list.getByRole('button', { name: /huge/ })).not.toHaveTextContent('+2001');
      expect(screen.getByText(/too large to compare line by line/)).toBeInTheDocument();
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

    await user.click(screen.getByRole('button', { name: 'Remove' }));

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
