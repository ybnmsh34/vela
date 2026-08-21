/**
 * The project panel, driven state by state.
 *
 * `CoworkPanel.test.tsx` proves this panel reaches the host — it drives the dock
 * through `BrowserAdapter`, watches `project_layout` cross the seam, and reads
 * the one layout that fake answers with. Every other layout is unreachable from
 * there. Against the seeded project those tests use, `#projectLayout` in
 * `browser-adapter.ts` answers `workingDirectory: { kind: 'none' }`, no mounts
 * and an empty `repaired`; and it can never answer `bound` for any project,
 * because, as its own comment says, "nothing here can stat a directory". So the
 * states a user with a real project actually meets — a folder on an unplugged
 * drive, a read-only reference folder, a skill that is enabled and not installed
 * — had never been rendered by anything.
 *
 * The panel takes a `ProjectLayoutController`, so each of them is a value.
 *
 * ## WHY THIS FILE EXISTS AT ALL: the writes had no reader
 *
 * Round 4's critic counted the `data-testid`s in this panel that nothing read —
 * `cowork-project-none`, `cowork-project-loading`, `cowork-project-error`,
 * `cowork-skills-mount`, `cowork-repaired`, and every `cowork-mount-…` — and
 * noted that `data-kind` writes three values with one test reading one of them.
 * `CoworkPanel.module.css` keys no rule on any `data-*` — its only attribute
 * selectors are `[aria-selected='true']` and `[aria-current='page']` — so an
 * attribute here is read by a test or by nothing at all. All three `data-kind`
 * values are read now: `none` by `CoworkPanel.test.tsx` against the browser
 * fake, `bound` and `unavailable` here.
 *
 * Every one of them is read below, and by an assertion about the sentence the
 * user gets rather than about the attribute alone: `toBeVisible()` on a testid
 * proves only that a `div` exists.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type {
  ProjectLayout,
  SkillMount,
  WorkingDirectory,
} from '@/platform/contract-project';

import { ProjectFilesPanel } from './ProjectFilesPanel';
import type { ProjectLayoutController, ProjectLayoutState } from './use-project-layout';

const ROOT = 'C:/Users/sam/AppData/Roaming/Vela/projects/p-1';

function layoutOf(
  workingDirectory: WorkingDirectory,
  mounts: readonly SkillMount[] = [],
  repaired: ProjectLayout['repaired'] = [],
): ProjectLayout {
  return {
    projectId: 'p-1',
    paths: {
      root: ROOT,
      workspace: `${ROOT}/workspace`,
      skillsMount: `${ROOT}/skills`,
      skillStore: 'C:/Users/sam/AppData/Roaming/Vela/skills',
    },
    linkStrategy: { kind: 'junction' },
    workingDirectory,
    mounts,
    repaired,
  };
}

function show(state: ProjectLayoutState, reload: () => void = () => undefined) {
  const controller: ProjectLayoutController = { state, reload };
  return render(<ProjectFilesPanel layout={controller} />);
}

describe('the project panel before it has a layout', () => {
  it('distinguishes no project at all from a project still being read', () => {
    const { unmount } = show({ status: 'noProject' });
    expect(screen.getByTestId('cowork-project-none')).toHaveTextContent('No project yet');
    unmount();

    show({ status: 'loading' });
    expect(screen.getByTestId('cowork-project-loading')).toHaveTextContent(
      'Reading this project’s folders…',
    );
    // Two different sentences, because "you have no project" and "I have not
    // finished asking" are two different things to be told.
    expect(screen.queryByTestId('cowork-project-none')).toBeNull();
  });

  it('says the folders could not be read, and does not draw a project with none', () => {
    show({ status: 'error', code: 'NOT_FOUND', message: 'no project p-1' });

    const error = screen.getByTestId('cowork-project-error');
    expect(error).toHaveTextContent('This project’s folders could not be read');
    expect(error).toHaveTextContent('NOT_FOUND');
    expect(error).toHaveTextContent('no project p-1');
    // The failure this panel's hook exists to keep separate: an unreadable
    // layout must not be rendered as a project with no working directory.
    expect(screen.queryByTestId('cowork-working-directory')).toBeNull();
  });
});

describe('the working directory row', () => {
  it('shows a bound folder as its path, and says whether Vela can write there', () => {
    show({
      status: 'ready',
      layout: layoutOf({ kind: 'bound', path: 'D:/work/vela', writable: true }),
    });

    const row = screen.getByTestId('cowork-working-directory');
    expect(row).toHaveAttribute('data-kind', 'bound');
    expect(row).toHaveTextContent('D:/work/vela');
    expect(within(row).getByText('Readable & writable')).toBeVisible();
  });

  it('calls a read-only folder read-only rather than broken', () => {
    show({
      status: 'ready',
      layout: layoutOf({ kind: 'bound', path: 'D:/reference', writable: false }),
    });

    const row = screen.getByTestId('cowork-working-directory');
    expect(row).toHaveAttribute('data-kind', 'bound');
    expect(within(row).getByText('Read-only')).toBeVisible();
    expect(row).toHaveTextContent('A read-only reference folder is a legitimate thing');
  });

  it('does not offer to re-pick a folder whose drive is merely unplugged', () => {
    show({
      status: 'ready',
      layout: layoutOf({
        kind: 'unavailable',
        path: 'X:/archive/2019',
        problem: 'volumeUnavailable',
      }),
    });

    const row = screen.getByTestId('cowork-working-directory');
    expect(row).toHaveAttribute('data-kind', 'unavailable');
    // The whole reason the contract carries this apart from `notFound`. The
    // sentence must not send the user looking for a folder that is asleep.
    expect(row).toHaveTextContent('The drive or share it lives on is not connected right now.');
    expect(row).not.toHaveTextContent('deleted or renamed');
    // And the path is still shown: it is what tells them which drive to plug in.
    expect(row).toHaveTextContent('X:/archive/2019');
  });

  it('says a folder that is gone is gone', () => {
    show({
      status: 'ready',
      layout: layoutOf({ kind: 'unavailable', path: 'D:/old', problem: 'notFound' }),
    });

    expect(screen.getByTestId('cowork-working-directory')).toHaveTextContent(
      'Nothing is at that path — it was deleted or renamed.',
    );
  });
});

describe('the rows Vela owns', () => {
  it('names the workspace disposable and the mount by the strategy in force', () => {
    show({ status: 'ready', layout: layoutOf({ kind: 'none' }) });

    const workspace = screen.getByTestId('cowork-workspace');
    expect(workspace).toHaveTextContent(`${ROOT}/workspace`);
    expect(workspace).toHaveTextContent('Disposable by design');

    const mount = screen.getByTestId('cowork-skills-mount');
    expect(mount).toHaveTextContent(`${ROOT}/skills`);
    expect(within(mount).getByText('junction')).toBeVisible();
  });

  it('says why the host is copying when it could not link', () => {
    const layout = layoutOf({ kind: 'none' });
    show({
      status: 'ready',
      layout: { ...layout, linkStrategy: { kind: 'copy', reason: 'junctionRefused' } },
    });

    // A copy is not a link and the contract refuses to let it be drawn as one,
    // so the badge carries the reason rather than the word `copy` alone.
    expect(screen.getByTestId('cowork-skills-mount')).toHaveTextContent(
      'Copies · junctionRefused',
    );
  });

  it('mentions a repair once, and not as an error', () => {
    show({
      status: 'ready',
      layout: layoutOf({ kind: 'none' }, [], ['workspace']),
    });

    const repaired = screen.getByTestId('cowork-repaired');
    expect(repaired).toHaveTextContent('Vela recreated workspace — it was missing when this was read.');
    // `role="status"` and not `role="alert"`: nothing is wrong, and the
    // contract says this must not be rendered as a failure.
    expect(repaired).toHaveAttribute('role', 'status');
  });

  it('agrees with itself about how many directories were recreated', () => {
    show({
      status: 'ready',
      layout: layoutOf({ kind: 'none' }, [], ['workspace', 'skillsMount']),
    });

    expect(screen.getByTestId('cowork-repaired')).toHaveTextContent(
      'Vela recreated workspace, skillsMount — they were missing when this was read.',
    );
  });

  it('draws no repair line for the ordinary read that fixed nothing', () => {
    show({ status: 'ready', layout: layoutOf({ kind: 'none' }) });

    expect(screen.queryByTestId('cowork-repaired')).toBeNull();
  });
});

describe('the skill mounts', () => {
  const linked: SkillMount = {
    name: 'pdf',
    source: 'C:/Users/sam/AppData/Roaming/Vela/skills/pdf',
    status: { kind: 'linked', link: 'junction', path: `${ROOT}/skills/pdf` },
  };
  const staleCopy: SkillMount = {
    name: 'xlsx',
    source: 'C:/Users/sam/AppData/Roaming/Vela/skills/xlsx',
    status: { kind: 'copied', path: `${ROOT}/skills/xlsx`, copiedAtMs: 1_700_000_000_000, stale: true },
  };
  const missing: SkillMount = {
    name: 'docx',
    source: 'C:/Users/sam/AppData/Roaming/Vela/skills/docx',
    status: { kind: 'unavailable', problem: 'skillNotFound' },
  };

  it('keeps a skill that is enabled and not installed, rather than dropping it', () => {
    show({ status: 'ready', layout: layoutOf({ kind: 'none' }, [linked, missing]) });

    // Dropping it is the silent reduction the contract forbids: the user
    // switched it on and would be told nothing.
    const row = screen.getByTestId('cowork-mount-docx');
    expect(within(row).getByText('Not mounted')).toBeVisible();
    expect(row).toHaveTextContent('Enabled for this project, but not in the skill store.');

    expect(screen.getByText('Enabled skills · 2')).toBeVisible();
    expect(within(screen.getByTestId('cowork-mount-pdf')).getByText('junction')).toBeVisible();
  });

  it('marks a copy that has fallen behind the skill it was taken from', () => {
    show({ status: 'ready', layout: layoutOf({ kind: 'none' }, [staleCopy]) });

    const row = screen.getByTestId('cowork-mount-xlsx');
    expect(within(row).getByText('Copy — out of date')).toBeVisible();
    // The canonical path, which is the thing a copy can be out of date with
    // respect to.
    expect(row).toHaveTextContent('C:/Users/sam/AppData/Roaming/Vela/skills/xlsx');
  });

  it('draws no path for the one mount whose source the contract withholds', () => {
    const traversal: SkillMount = {
      name: '../evil',
      source: null,
      status: { kind: 'unavailable', problem: 'nameIsNotASinglePathSegment' },
    };
    show({ status: 'ready', layout: layoutOf({ kind: 'none' }, [traversal]) });

    const row = screen.getByTestId('cowork-mount-../evil');
    // The name and the problem, and no resolved path — because producing one
    // would perform the join the rule exists to prevent. This is why the panel
    // guards the print instead of assuming every mount has a source.
    expect(row).toHaveTextContent('../evil');
    expect(row).toHaveTextContent('That name is not a single folder name');
    expect(row.querySelectorAll('p').length).toBe(1);
    expect(row).not.toHaveTextContent('Vela/skills/../evil');
  });

  it('draws no skills section for a project with none enabled', () => {
    show({ status: 'ready', layout: layoutOf({ kind: 'none' }) });

    expect(screen.queryByText(/^Enabled skills/)).toBeNull();
  });
});

describe('the project panel’s only control', () => {
  it('reads the layout again when the user presses it', async () => {
    const user = userEvent.setup({ delay: null });
    const reload = vi.fn();
    show({ status: 'ready', layout: layoutOf({ kind: 'none' }) }, reload);

    await user.click(screen.getByRole('button', { name: 'Read again' }));

    // The only repeat there is. Reading a layout repairs, so a poll would be a
    // write loop wearing a refresh button — `use-project-layout.ts` says so and
    // this is the button that says it instead.
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
