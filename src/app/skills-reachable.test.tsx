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

import { act, render, screen, within } from '@testing-library/react';
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
 * Let everything the last render scheduled actually run, before asking what the
 * host was handed.
 *
 * This exists because of a measurement, not a precaution. `useSkills.select`
 * finishes by setting state from an awaited promise, so the commit that mounts
 * the bundle rows happens outside the `act` window `await user.click` closed,
 * and the effects that commit schedules have not run when the next line of the
 * test executes. Measured, not reasoned: a refactor that fetched each bundle
 * member from an effect in `BundleContents` printed all three member names from
 * inside that effect, in this file's own stdout, while the assertion below it
 * still saw one `skills_read` — every assertion in the file passed. With this
 * flush in front of them the same refactor fails. What `act` is doing is
 * flushing the pending effects; the `setTimeout` turn inside it gives the
 * promise chains those effects start somewhere to land.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

/** Every string anywhere inside a value: through objects and through arrays. */
function stringsIn(value: unknown, seen: Set<object>): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);
  return Object.values(value).flatMap((entry) => stringsIn(entry, seen));
}

/**
 * Records what was asked of the host: **every command, and every string in
 * every payload**.
 *
 * The bundle tests below turn on which text reached the host, not on how many
 * calls there were, so the command list the other `RecordingHost` keeps is not
 * enough — and, it turned out, neither is a list of the names passed to one
 * field of one command.
 *
 * The first version of this class exposed only `namesRead()`: the `name` field
 * of every `skills_read` payload. That answers "was a member fetched *through
 * `skills_read`, in the `name` field*", and the comment above the security test
 * told the reader it answered "can manifest text become a host argument at
 * all". Three refactors were written against that version and all three stayed
 * green — 8 passed, exit 0, twice each — with a console probe in every one of
 * them printing three manifest-supplied names crossing the bridge:
 *
 * 1. each member echoed to `diagnostics_echo` from an effect in
 *    `BundleContents`, which `namesRead()` cannot see at all;
 * 2. each member fetched with `skills_read` from that same effect, which
 *    `namesRead()` could see and did not, for the timing reason
 *    {@link settle} exists for;
 * 3. an echo to `diagnostics_echo` moved into `useSkills.select` and awaited
 *    before the detail is set, so the calls are recorded before any assertion
 *    runs and timing is not the explanation.
 *
 * A guard that watches one field of one command is not a guard on a seam with
 * fifty-eight commands on it — the count in `COMMAND_ALLOWLIST` in
 * `src/platform/contract.ts` in this tree.
 *
 * {@link callsMentioning} asks the question the boundary is about instead: did
 * this text reach the host **anywhere** — as a command name, as a field value,
 * nested inside an object or an array, whole or as part of a longer argument.
 * Substring rather than equality, because a payload built as a path with the
 * member name concatenated into it crosses the boundary exactly as far as the
 * bare name does.
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

  /**
   * Every `command <- argument` whose argument text contains one of `needles`.
   *
   * Empty is the property. A non-empty answer names the command and prints the
   * argument, so a failure says which refactor leaked and what it leaked.
   */
  callsMentioning(needles: readonly string[]): string[] {
    const hits: string[] = [];
    for (const call of this.calls) {
      for (const text of [call.command, ...stringsIn(call.payload, new Set())]) {
        for (const needle of needles) {
          if (needle.length > 0 && text.includes(needle)) {
            hits.push(`${call.command} <- ${text}`);
          }
        }
      }
    }
    return hits;
  }

  /**
   * Every name passed to `skills_read`, in order.
   *
   * Kept, but for the **cost** question only — how many bodies were fetched to
   * put a bundle on screen — which is a different question from the boundary
   * one and is the only one this method can answer. See the class header.
   */
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

/**
 * The members the fake's own `bundle-release` manifest names.
 *
 * Restated here rather than imported, because `browser-adapter.ts` writes them
 * inside a body string. The restatement cannot rot unnoticed: the test below
 * asserts all three are **on screen** before it asserts none of them reached
 * the host, so a fake that stopped naming one of them fails on the first
 * assertion rather than quietly leaving the second one hunting for a string no
 * manifest contains.
 */
const FAKE_BUNDLE_MEMBERS = ['commit-messages', 'half-written', 'changelog'] as const;

/**
 * Manifest text that would be a traversal if a member name were ever joined to
 * a path or handed to the host.
 *
 * Each is refused by the parser, and that is deliberately **not** what the
 * tests assert: rejection is a string check and the next encoding beats it.
 * Each case carries the whole string and one distinctive segment of it, and the
 * assertion is that neither reaches the host — which stays true whatever the
 * parser is later changed to accept.
 */
const HOSTILE: readonly (readonly [written: string, needles: readonly string[]])[] = [
  ['../../secrets', ['../../secrets', 'secrets']],
  ['..%2f..%2fsecrets', ['..%2f..%2fsecrets', '%2fsecrets']],
  ['C:\\Windows\\System32\\config', ['C:\\Windows\\System32\\config', 'System32']],
  ['/etc/shadow', ['/etc/shadow', 'shadow']],
  ['commit-messages/../../elsewhere', ['commit-messages/../../elsewhere', 'elsewhere']],
];

describe('a bundle is a skill, and shows what it carries', () => {
  it('shows every member and asks the host for none of them', async () => {
    // ── THE LOAD-BEARING TEST ──────────────────────────────────────────────
    // Two claims, and the second is the one that could rot quietly.
    //
    // A bundle's contents are on screen: the installed member with its
    // description, the member that is installed and unreadable, and the member
    // that is not installed — three different sentences, because they are three
    // different things to do about it.
    //
    // And resolving them cost nothing. That is asserted twice because it is two
    // facts, and the first is the weaker of them. `namesRead()` says no extra
    // *body* was fetched: the cost question. `callsMentioning` says no member
    // name reached the host in any argument of any command: the boundary
    // question. Three refactors satisfy the first and violate the second — the
    // `ManifestHost` header names them.
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
    for (const member of FAKE_BUNDLE_MEMBERS) {
      expect(dialog, 'the fake’s manifest no longer names this member').toHaveTextContent(member);
    }

    await settle();
    expect(
      host.namesRead(),
      'an extra body was fetched; a bundle costs the two calls the store already makes',
    ).toEqual(['bundle-release']);
    expect(
      host.callsMentioning(FAKE_BUNDLE_MEMBERS),
      'a member name out of the manifest reached the host',
    ).toEqual([]);
  });

  it.each(HOSTILE)(
    'never lets the manifest text %s reach the host in any argument',
    async (written, needles) => {
      // ── THE LOAD-BEARING TEST ────────────────────────────────────────────
      // The security clause, driven through the assembled window rather than
      // asserted on a pure function.
      //
      // A manifest is author-supplied text that arrives from whatever the user
      // unzipped into their skill store. The question worth asking is not "does
      // the parser reject `..`" — that is a string check, and the next encoding
      // beats it. It is whether manifest text reaches a host argument at all,
      // and the previous version of this test did not ask it: it compared the
      // `name` fields of `skills_read` against one expected value, which a leak
      // through any other command or any other field satisfies.
      //
      // `callsMentioning` scans every command name and every string in every
      // payload of every call this render made. What is asserted is absence
      // from the whole seam, not rejection by the parser — so the property
      // survives a parser that is later changed to accept more.
      const host = new ManifestHost(manifest(`skills: ${written}`));
      const user = driver();
      render(<App adapter={host as BrowserAdapter} />);

      await openSkills(user);
      await user.click(await screen.findByRole('button', { name: /bundle-release/u }));

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent('Not readable as a bundle ·');
      expect(dialog).toHaveTextContent(/is not a skill name/u);

      await settle();
      expect(host.callsMentioning(needles), 'manifest text reached the host').toEqual([]);
      expect(host.namesRead()).toEqual(['bundle-release']);
    },
  );

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
