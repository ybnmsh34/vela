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

/**
 * Records what was asked of the host, **with payloads**.
 *
 * The two tests below turn on which *names* were read, not how many calls there
 * were, so the command list the other `RecordingHost` keeps is not enough: a
 * bundle that reached for a member would issue a `skills_read` that looks
 * exactly like the legitimate one until you read its argument.
 *
 * `bundleBody` replaces the body the fake serves for `bundle-release`, which is
 * how a manifest gets written for one test without a second fixture in
 * `browser-adapter.ts` for every shape a manifest can be wrong in.
 */
class ManifestHost extends BrowserAdapter {
  readonly calls: { command: string; payload: unknown }[] = [];
  readonly #bundleBody: string | null;

  constructor(bundleBody: string | null = null) {
    super();
    this.#bundleBody = bundleBody;
  }

  override async invoke(command: never, payload: never): Promise<never> {
    this.calls.push({ command: command as string, payload });
    const answer = await super.invoke(command, payload);
    if (
      this.#bundleBody !== null &&
      (command as string) === 'skills_read' &&
      (payload as { readonly name?: string }).name === 'bundle-release'
    ) {
      return { ...(answer as object), body: this.#bundleBody } as never;
    }
    return answer;
  }

  /** Every name passed to `skills_read`, in order. */
  namesRead(): string[] {
    return this.calls
      .filter((call) => call.command === 'skills_read')
      .map((call) => (call.payload as { readonly name?: string }).name ?? '');
  }
}

/** A manifest block, assembled so this file contains no stray fence. */
function manifest(...lines: readonly string[]): string {
  return ['# Release', '', '```vela-bundle', ...lines, '```', ''].join('\n');
}

describe('a bundle is a skill, and shows what it carries', () => {
  it('shows every member and asks the host for none of them', async () => {
    // ── THE LOAD-BEARING TEST ──────────────────────────────────────────────
    // Two claims at once, and the second is the one that could rot quietly.
    //
    // A bundle's contents are on screen: the installed member with its
    // description, the member that is installed and unreadable, and the member
    // that is not installed — three different sentences, because they are three
    // different things to do about it.
    //
    // And resolving them cost **nothing**. `readBundle` is handed the listing
    // the pane already fetched, so the only name the host is asked for is the
    // bundle root the user clicked. A later refactor that resolved members by
    // reading each one would look tidier, would pass every assertion about what
    // is on screen, and would put a host call behind text out of a manifest —
    // which is the boundary `src/data/skill-bundles.ts` exists to hold.
    const host = new ManifestHost();
    const user = driver();
    render(<App adapter={host as BrowserAdapter} />);

    await openSkills(user);
    await user.click(await screen.findByRole('button', { name: /bundle-release/u }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Bundle · 3 skills');
    expect(dialog).toHaveTextContent(/Writes commit messages in this repository’s house style/u);
    expect(dialog).toHaveTextContent(
      'Installed and not readable as a skill · Its frontmatter has no description.',
    );
    expect(dialog).toHaveTextContent('Named by this bundle and not in the skill store.');

    expect(
      host.namesRead(),
      'a member was fetched; resolving a bundle must cost no host call',
    ).toEqual(['bundle-release']);
  });

  it('never turns a member name into a host call, whatever the manifest says', async () => {
    // ── THE LOAD-BEARING TEST ──────────────────────────────────────────────
    // The security clause, driven through the assembled window rather than
    // asserted on a pure function. A manifest is author-supplied text that
    // arrives from whatever the user unzipped into their skill store, and the
    // question worth asking is not "does the parser reject `..`" — that is a
    // string check, and the next encoding beats it. It is whether manifest text
    // can become a host argument **at all**. It cannot: the only name that
    // reaches `skills_read` is the directory the user clicked.
    const host = new ManifestHost(manifest('skills: ../../secrets'));
    const user = driver();
    render(<App adapter={host as BrowserAdapter} />);

    await openSkills(user);
    await user.click(await screen.findByRole('button', { name: /bundle-release/u }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Not readable as a bundle ·');
    expect(dialog).toHaveTextContent(/is not a skill name/u);
    expect(host.namesRead()).toEqual(['bundle-release']);
  });

  it('says a bundle root with no manifest is one, rather than passing it over', async () => {
    // The precedent the skill store set, one level up: a directory that claims
    // to be a bundle and carries no manifest is told so, in the window, beside
    // the skill it still is. Rendering nothing here is the silent drop — and it
    // is the failure an author hits by mistyping the fence, which is the most
    // likely way to get this wrong and the hardest to see.
    const host = new ManifestHost('# Release\n\nNo manifest block at all.\n');
    const user = driver();
    render(<App adapter={host as BrowserAdapter} />);

    await openSkills(user);
    await user.click(await screen.findByRole('button', { name: /bundle-release/u }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(/Not readable as a bundle · Its SKILL.md has no/u);
    // Still a skill: the instruction body it does have is on screen underneath.
    expect(dialog).toHaveTextContent('No manifest block at all.');
  });
});
