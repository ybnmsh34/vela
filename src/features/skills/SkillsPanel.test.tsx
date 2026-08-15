/**
 * The skills pane: what it shows, and the one row it must never hide.
 *
 * Two levels of disclosure and one refusal to filter, driven the way a user
 * drives them: open the pane, read the list, click a skill, read its body.
 *
 * **Honesty (conventions §10):** VERIFIED-BY-FAKE. `BrowserAdapter` is an
 * in-memory host with canned skill records and deliberately no second copy of
 * the SKILL.md parser. What is proven here is the pane's own behaviour against
 * the wire shape. The parser and the real store on real directories are proven
 * in `src-tauri/crates/vela-skills/`, whose
 * `a_broken_skill_is_listed_with_its_problem_rather_than_dropped` is the host
 * half of the assertion this file makes about the renderer half.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { BrowserAdapter } from '@/platform/browser-adapter';
import { PlatformProvider } from '@/platform/PlatformProvider';
import { resetSkillsStore } from '@/state/skills-store';

import { SkillsPanel } from './SkillsPanel';

function mount(adapter: BrowserAdapter) {
  return render(
    <PlatformProvider adapter={adapter}>
      <SkillsPanel onClose={() => undefined} />
    </PlatformProvider>,
  );
}

beforeEach(() => {
  resetSkillsStore();
});

describe('the skills pane', () => {
  it('lists each installed skill by name, with the description that says when to use it', async () => {
    mount(new BrowserAdapter());

    expect(
      await screen.findByRole('button', { name: /commit-messages/u }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Writes commit messages in this repository’s house style/u),
    ).toBeInTheDocument();
  });

  it('keeps a skill it cannot parse in the list, carrying its problem', async () => {
    // ── THE LOAD-BEARING TEST ──────────────────────────────────────────────
    // The host lists a broken directory with a `SkillProblem` where the
    // description would be, and the tidy thing for a renderer to do is drop it.
    // Dropping it means a user who mistyped one frontmatter key watches their
    // skill vanish from the only surface that would have told them why.
    mount(new BrowserAdapter());

    const row = await screen.findByRole('button', { name: /half-written/u });
    expect(row).toHaveTextContent('Its frontmatter has no description.');
    // The problem is worded, not printed: `missingDescription` is a wire token
    // and this is the only place that turns it into a sentence.
    expect(row).not.toHaveTextContent('missingDescription');
  });

  it('draws no instruction body until a skill is asked for', async () => {
    // The budget, asserted where it could be lost. The listing carries no body
    // — `SkillListing` has no field one could arrive in — so a pane that showed
    // instructions before a click could only have fetched them, which is the
    // progressive-disclosure model undone from the top.
    mount(new BrowserAdapter());
    await screen.findByRole('button', { name: /commit-messages/u });

    expect(screen.queryByText('Instructions')).not.toBeInTheDocument();
    expect(screen.queryByText(/Say what changed and why/u)).not.toBeInTheDocument();
  });

  it('shows the instruction body and the resource file names when a skill is clicked', async () => {
    const user = userEvent.setup();
    mount(new BrowserAdapter());

    await user.click(await screen.findByRole('button', { name: /commit-messages/u }));

    expect(await screen.findByText(/Say what changed and why/u)).toBeInTheDocument();
    expect(screen.getByText('Instructions')).toBeInTheDocument();
    // The fake's skill bundles nothing, and the pane says so rather than
    // drawing three empty headings.
    expect(screen.getByText('This skill bundles no other files.')).toBeInTheDocument();
  });

  it('names a skill’s bundled files, and only their names', async () => {
    // The third level of disclosure: `SkillResources` carries filenames and no
    // contents, and no command crosses the bridge with a file's bytes.
    class BundledHost extends BrowserAdapter {
      override async invoke(command: never, payload: never): Promise<never> {
        if ((command as string) === 'skills_read') {
          return {
            kind: 'skill',
            name: 'commit-messages',
            description: 'Writes commit messages.',
            body: '# Commit messages\n',
            resources: {
              scripts: ['lint-subject.py'],
              references: ['house-style.md'],
              assets: [],
            },
          } as never;
        }
        return super.invoke(command, payload);
      }
    }
    const user = userEvent.setup();
    mount(new BundledHost() as BrowserAdapter);

    await user.click(await screen.findByRole('button', { name: /commit-messages/u }));

    expect(within(await screen.findByRole('list', { name: 'Scripts' })).getByText(
      'lint-subject.py',
    )).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'References' })).getByText('house-style.md'),
    ).toBeInTheDocument();
    // Empty groups are absent rather than drawn empty.
    expect(screen.queryByRole('list', { name: 'Assets' })).toBeNull();
  });

  it('answers a broken skill when it is clicked rather than failing on it', async () => {
    // `invalid` is a response, not a rejection: the request was well formed and
    // the host answered it. A user who clicked to find out more gets the same
    // sentence the row carried, not an error code.
    const user = userEvent.setup();
    mount(new BrowserAdapter());

    await user.click(await screen.findByRole('button', { name: /half-written/u }));

    expect(await screen.findByText(/There are no instructions to show/u)).toBeInTheDocument();
    expect(screen.getAllByText(/Its frontmatter has no description\./u).length).toBeGreaterThan(0);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('goes back to the list without re-reading the skill', async () => {
    // The half this test was named for and did not assert. Leaving the detail
    // view is a pure state change — the list is already in hand — and a pane
    // that spent `skills_read` on the way out would look **identical** on
    // screen. Only the call count can see it, which is why the DOM assertions
    // below are not enough on their own: they passed against a `clearSelection`
    // that re-read every time, twice.
    const reads: string[] = [];
    class CountingHost extends BrowserAdapter {
      override async invoke(command: never, payload: never): Promise<never> {
        if ((command as string) === 'skills_read') {
          reads.push((payload as { name: string }).name);
        }
        return super.invoke(command, payload);
      }
    }
    const user = userEvent.setup();
    mount(new CountingHost() as BrowserAdapter);

    await user.click(await screen.findByRole('button', { name: /commit-messages/u }));
    await screen.findByText('Instructions');
    // The control. A recorder that recorded nothing would make the assertion
    // after the back-navigation true by construction, which is the shape of
    // vacuity this file already carries two other guards against.
    expect(reads).toEqual(['commit-messages']);

    await user.click(screen.getByRole('button', { name: '← All skills' }));

    expect(await screen.findByRole('button', { name: /half-written/u })).toBeInTheDocument();
    expect(screen.queryByText('Instructions')).not.toBeInTheDocument();
    expect(reads, 'going back to the list spent a second read').toEqual(['commit-messages']);
  });

  it('reports a store it could not read instead of drawing it as empty', async () => {
    // An empty store is the normal state for a new installation. An unreadable
    // one drawn the same way is a lie about what the user has installed.
    class BrokenHost extends BrowserAdapter {
      override async invoke(command: never, payload: never): Promise<never> {
        if ((command as string) === 'skills_list') throw new Error('store unavailable');
        return super.invoke(command, payload);
      }
    }
    mount(new BrokenHost() as BrowserAdapter);

    expect(await screen.findByRole('status')).toHaveTextContent(/Skills unavailable/u);
    expect(screen.queryByText('No skills are installed yet.')).not.toBeInTheDocument();
  });

  it('says the store is empty rather than showing nothing at all', async () => {
    class EmptyHost extends BrowserAdapter {
      override async invoke(command: never, payload: never): Promise<never> {
        if ((command as string) === 'skills_list') return { skills: [] } as never;
        return super.invoke(command, payload);
      }
    }
    mount(new EmptyHost() as BrowserAdapter);

    expect(await screen.findByText('No skills are installed yet.')).toBeInTheDocument();
  });

  it('says out loud that Vela does not write to the skill store', async () => {
    // There is no write command to put a control in front of, so the pane must
    // not leave a user hunting for one — or assuming Vela edits their files.
    mount(new BrowserAdapter());
    expect(
      await screen.findByText(/Vela reads this folder and never writes to it/u),
    ).toBeInTheDocument();
  });

  it('words every problem the host can report, with no wire token left showing', async () => {
    // The vocabulary is closed and fourteen wide. A variant with no sentence
    // would render as `undefined`, and only a pass over all of them can say
    // that none does — one fake skill would prove one label.
    const problems = [
      'noSkillFile',
      'unreadable',
      'noFrontmatter',
      'unterminatedFrontmatter',
      'unsupportedFrontmatterSyntax',
      'duplicateFrontmatterKey',
      'missingName',
      'missingDescription',
      'nameIsNotWellFormed',
      'nameTooLong',
      'nameDoesNotMatchDirectory',
      'descriptionIsEmpty',
      'descriptionTooLong',
      'nameIsNotASinglePathSegment',
    ] as const;

    class EveryProblemHost extends BrowserAdapter {
      override async invoke(command: never, payload: never): Promise<never> {
        if ((command as string) === 'skills_list') {
          return {
            skills: problems.map((problem) => ({
              kind: 'invalid',
              directory: `broken-${problem}`,
              problem,
            })),
          } as never;
        }
        return super.invoke(command, payload);
      }
    }
    mount(new EveryProblemHost() as BrowserAdapter);

    await screen.findByRole('button', { name: /broken-noSkillFile/u });
    for (const problem of problems) {
      const row = screen.getByRole('button', { name: new RegExp(`broken-${problem}`, 'u') });
      const sentence = row.textContent?.split('Not readable as a skill · ')[1] ?? '';
      expect(sentence, problem).not.toBe('');
      expect(sentence, problem).not.toContain('undefined');
      // The sentence must not be the wire token wearing a full stop.
      expect(sentence, problem).not.toContain(problem);
    }
  });

  it('keeps the keyboard inside the dialog it says it holds', async () => {
    // `ModalSurface` owns the trap; this is the check that this pane goes
    // through it rather than declaring `aria-modal` by hand.
    const user = userEvent.setup({ delay: null });
    mount(new BrowserAdapter());

    const dialog = await screen.findByRole('dialog');
    await screen.findByRole('button', { name: /commit-messages/u });

    for (let press = 0; press < 5; press += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('does not leave a stale body under the wrong heading when two are clicked', async () => {
    // Two reads in flight resolve in whatever order the host answers. Without
    // the ticket in `use-skills.ts` the slower answer wins, and the pane draws
    // one skill's instructions under another skill's name.
    const answers = new Map<string, () => void>();
    class SlowHost extends BrowserAdapter {
      override async invoke(command: never, payload: never): Promise<never> {
        if ((command as string) === 'skills_read') {
          const name = (payload as { name: string }).name;
          const real = await super.invoke(command, payload);
          await new Promise<void>((resolve) => answers.set(name, resolve));
          return real;
        }
        return super.invoke(command, payload);
      }
    }
    const user = userEvent.setup();
    mount(new SlowHost() as BrowserAdapter);

    await user.click(await screen.findByRole('button', { name: /commit-messages/u }));
    await waitFor(() => {
      expect(answers.has('commit-messages')).toBe(true);
    });

    // Back to the list and into the other row, while the first read is parked.
    await user.click(screen.getByRole('button', { name: '← All skills' }));
    await user.click(screen.getByRole('button', { name: /half-written/u }));
    await waitFor(() => {
      expect(answers.has('half-written')).toBe(true);
    });

    // Now let the *first* read finish. It is stale and must land nowhere.
    answers.get('commit-messages')?.();
    answers.get('half-written')?.();

    expect(await screen.findByText(/There are no instructions to show/u)).toBeInTheDocument();
    expect(screen.queryByText(/Say what changed and why/u)).not.toBeInTheDocument();
  });
});
