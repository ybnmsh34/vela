/**
 * **The skill store is reachable from the window.**
 *
 * `src/data/skills-repository.ts` was written, documented, correct and tested,
 * and its only importer in the whole tree was its own test file. `skills_list`
 * and `skills_read` were registered, allowlisted and served by a finished host
 * crate, and nothing a user could press reached either of them. That is this
 * project's central defect — the module everybody believed was connected — and
 * the fix for it is not a better repository. It is this file.
 *
 * ## Why these tests are here and not beside the pane
 *
 * `src/features/skills/SkillsPanel.test.tsx` mounts the pane directly, so it
 * passes whether or not anything in the application mounts it. Every assertion
 * below goes through `<App />`: the real composition root, the real sidebar, the
 * real store seam. Delete `<SkillsSurface />` from `src/app/App.tsx`, delete the
 * repository, or delete its `listSkills` arm, and these fail — which is the
 * whole point, and the property no test of the repository can have.
 *
 * **Honesty (conventions §10):** VERIFIED-BY-FAKE, and only that.
 * `BrowserAdapter` is an in-memory host holding canned skill records; nothing
 * here reads a SKILL.md file, a real store or a real application-data
 * directory. What is proven is that the renderer's parts are joined to each
 * other. Whether a human clicking the real window sees this is not established
 * by this file and is not claimed anywhere in it.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '@/app/App';
import { BrowserAdapter } from '@/platform/browser-adapter';
import { resetMemoryStore } from '@/state/memory-store';
import { resetModelStore } from '@/state/model-store';
import { resetNavigationStore } from '@/state/navigation-store';
import { resetSkillsStore } from '@/state/skills-store';

type User = ReturnType<typeof userEvent.setup>;

/**
 * `delay: null` for the reason `src/app/modal-containment.test.tsx` records:
 * `userEvent`'s default yields once per simulated input step and a
 * `setTimeout(0)` turn costs a full Windows scheduler tick whether the box is
 * idle or loaded. Nothing here asserts how long a click took.
 */
function driver(): User {
  return userEvent.setup({ delay: null });
}

/** Open the skills pane the way a user does: the control in the sidebar. */
async function openSkills(user: User): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: 'Skills' }));
  return screen.findByRole('dialog');
}

beforeEach(() => {
  resetMemoryStore();
  resetModelStore();
  resetNavigationStore();
  resetSkillsStore();
});

describe('a user can see the skills they have installed', () => {
  it('opens a skills list from the sidebar of the assembled application', async () => {
    // ── THE LOAD-BEARING TEST ──────────────────────────────────────────────
    // Everything below the adapter seam already worked. This asserts the one
    // thing that did not exist: a path from a control in the window to
    // `skills_list`.
    const user = driver();
    render(<App adapter={new BrowserAdapter()} />);

    const dialog = await openSkills(user);

    expect(await screen.findByRole('button', { name: /commit-messages/u })).toBeInTheDocument();
    expect(dialog).toHaveTextContent(
      /Writes commit messages in this repository’s house style/u,
    );
  });

  it('does not read the skill store until the user asks for it', async () => {
    // The pane is mounted at the composition root on every launch and must
    // render nothing — and call nothing — until it is opened. A surface that
    // enumerated the store at startup would be a filesystem walk nobody asked
    // for on a directory that can be arbitrarily large.
    const commands: string[] = [];
    class RecordingHost extends BrowserAdapter {
      override async invoke(command: never, payload: never): Promise<never> {
        commands.push(command as string);
        return super.invoke(command, payload);
      }
    }
    const user = driver();
    render(<App adapter={new RecordingHost() as BrowserAdapter} />);

    await screen.findByRole('button', { name: 'Skills' });
    expect(commands).not.toContain('skills_list');

    await openSkills(user);
    await screen.findByRole('button', { name: /commit-messages/u });
    expect(commands).toContain('skills_list');
  });

  it('shows a skill it could not parse, in the window, carrying its problem', async () => {
    // ── THE LOAD-BEARING TEST ──────────────────────────────────────────────
    // The acceptance clause that is not about plumbing: corrupt a skill's
    // frontmatter and it must still be *on screen*, saying what is wrong with
    // it. A surface that silently drops malformed entries is how a user loses
    // work without being told, and it is invisible from every other angle —
    // the list still renders, the healthy skills are all there, nothing throws.
    const user = driver();
    render(<App adapter={new BrowserAdapter()} />);

    const dialog = await openSkills(user);
    const broken = await screen.findByRole('button', { name: /half-written/u });

    expect(broken).toHaveTextContent('Its frontmatter has no description.');
    // Both rows, not one: the assertion is that the broken skill is listed
    // *alongside* the good one, which is what "rather than vanishing" means.
    expect(
      within(dialog).getAllByRole('button', { name: /commit-messages|half-written/u }),
    ).toHaveLength(2);
  });

  it('reads one skill’s instructions when the user clicks it, and not before', async () => {
    // ── THE LOAD-BEARING TEST ──────────────────────────────────────────────
    // The second level of disclosure, driven through the real tree: the body
    // is on screen only after a click, and `skills_read` is called only then.
    const commands: string[] = [];
    class RecordingHost extends BrowserAdapter {
      override async invoke(command: never, payload: never): Promise<never> {
        commands.push(command as string);
        return super.invoke(command, payload);
      }
    }
    const user = driver();
    render(<App adapter={new RecordingHost() as BrowserAdapter} />);

    await openSkills(user);
    await screen.findByRole('button', { name: /commit-messages/u });
    expect(commands).not.toContain('skills_read');

    await user.click(screen.getByRole('button', { name: /commit-messages/u }));

    expect(await screen.findByText(/Say what changed and why/u)).toBeInTheDocument();
    expect(screen.getByText('This skill bundles no other files.')).toBeInTheDocument();
    expect(commands).toContain('skills_read');
  });

  it('closes the pane and gives the keyboard back to the control that opened it', async () => {
    const user = driver();
    render(<App adapter={new BrowserAdapter()} />);

    const dialog = await openSkills(user);
    // Scoped to the dialog: the title bar carries a window Close button too,
    // and an unscoped query would be ambiguous rather than wrong.
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement, 'focus was dropped to <body>').not.toBe(document.body);
    expect(screen.getByRole('button', { name: 'Skills' })).toHaveFocus();
  });
});
