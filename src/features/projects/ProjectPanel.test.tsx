/**
 * The projects pane: what it shows, and what it must never imply.
 *
 * The pane's job is small and its two honesty obligations are not. It must not
 * let the user believe an instruction was stored when the host refused it, and
 * it must not let them believe instructions apply to a message that is not
 * carrying any. Both have a sentence on screen and both are asserted here.
 *
 * The pane's *happy* path is tested where it matters, through the assembled
 * application in `src/app/project-instructions.test.tsx`: a box the user typed
 * into is worth nothing until the words come out the other end, and only a test
 * that reads the outgoing request can say that they did.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { BrowserAdapter } from '@/platform/browser-adapter';
import { PlatformProvider } from '@/platform/PlatformProvider';
import type { CommandName, CommandReq, CommandRes } from '@/platform/contract';
import { PROJECT_INSTRUCTIONS_MAX_CHARS } from '@/platform/contract-project';
import { PlatformError } from '@/platform/errors';
import { resetProjectStore } from '@/state/project-store';

import { ProjectPanel } from './ProjectPanel';

/** A host whose named command refuses, and whose others do not. */
class RefusingHost extends BrowserAdapter {
  constructor(private readonly broken: CommandName) {
    super();
  }

  override async invoke<C extends CommandName>(
    command: C,
    payload: CommandReq<C>,
  ): Promise<CommandRes<C>> {
    if (command === this.broken) throw new PlatformError('INTERNAL', 'the project store is on fire');
    return super.invoke(command, payload);
  }
}

function mount(adapter: BrowserAdapter) {
  return render(
    <PlatformProvider adapter={adapter}>
      <ProjectPanel onClose={() => undefined} />
    </PlatformProvider>,
  );
}

beforeEach(() => {
  resetProjectStore();
});

describe('the projects pane', () => {
  it('names the project the window is in, taken from the host rather than assumed', async () => {
    // ── THIS TEST WAS VACUOUS, AND THE FIX IS THE POINT ───────────────────────
    // Its only assertion was `expect(picker).not.toHaveDisplayValue('')`, under
    // a comment reading "a picker showing nothing is a window whose project
    // nobody can see". `toHaveDisplayValue` reads the selected option's **text**,
    // and the placeholder this pane renders when nothing is selected says
    // "No project" — a non-empty string. So the assertion passed *precisely* in
    // the state the title denies: neutering the selection in `use-projects.ts`
    // left it green while three siblings in this file went red.
    //
    // What the title actually claims is that the picker landed on the project
    // **the host flagged**, so that is what is asserted: by id, by name, and by
    // the absence of the placeholder that used to hold the test up.
    //
    // `DEFAULT_PROJECT_NAME` and `DEFAULT_PROJECT_ID` are still not written down
    // here. The seeded row is found through `isDefault`, which is the flag the
    // contract carries so that nothing has to know the constant.
    const adapter = new BrowserAdapter();
    const { projects } = await adapter.invoke('project_list', {});
    const seeded = projects.find((summary) => summary.isDefault);
    expect(seeded, 'the host seeded no default project').toBeDefined();
    if (seeded === undefined) return;

    mount(adapter);
    const picker = await screen.findByRole('combobox', { name: 'Working in' });
    await waitFor(() => {
      expect(picker).toHaveValue(seeded.id);
    });
    expect(picker).toHaveDisplayValue(seeded.name);
    expect(
      screen.queryByRole('option', { name: 'No project' }),
      'the picker is offering "no project", which is the state this test denies',
    ).toBeNull();
  });

  it('says which path the instructions actually travel on', async () => {
    // The pane's second honesty obligation. Instructions ride
    // `RunContextRequest.preload`, which only an agent run has, so a user who
    // writes a rule and sends an ordinary message gets no rule applied. The
    // sentence saying so is load-bearing and is pinned here.
    mount(new BrowserAdapter());
    expect(
      await screen.findByText(/Instructions reach the model on an agent run/),
    ).toBeInTheDocument();
  });

  it('acknowledges a save that worked, and stops as soon as the box says something else', async () => {
    // "Saved" means *this text* is what the host has, so it survives the
    // re-read that follows the write and goes the moment the box diverges. An
    // earlier version tracked a boolean the re-read then cleared, so the word
    // appeared and vanished inside a single commit: invisible to a user and a
    // race for the test looking for it.
    const user = userEvent.setup({ delay: null });
    mount(new BrowserAdapter());

    const box = await screen.findByRole('textbox', { name: 'Instructions for this project' });
    await waitFor(() => {
      expect(box).toBeEnabled();
    });
    await user.click(box);
    await user.paste('always answer in French');
    await user.click(screen.getByRole('button', { name: 'Save instructions' }));

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    // Still there after everything the write set off has settled.
    await waitFor(() => {
      expect(box).toHaveValue('always answer in French');
    });
    expect(screen.getByText('Saved')).toBeInTheDocument();

    await user.type(box, ' and be brief');
    await waitFor(() => {
      expect(screen.queryByText('Saved')).toBeNull();
    });
  });

  it('reports a refused save instead of leaving the words looking stored', async () => {
    const user = userEvent.setup();
    mount(new RefusingHost('project_update'));

    const box = await screen.findByRole('textbox', { name: 'Instructions for this project' });
    await waitFor(() => {
      expect(box).toBeEnabled();
    });
    await user.click(box);
    await user.paste('always answer in French');
    await user.click(screen.getByRole('button', { name: 'Save instructions' }));

    expect(await screen.findByText(/That did not save/)).toBeInTheDocument();
    // …and it must not also be claiming success beside the failure.
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('says the projects could not be read rather than showing an empty picker', async () => {
    mount(new RefusingHost('project_list'));

    expect(await screen.findByText(/Projects unavailable/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Working in' })).toBeNull();
    // With no project there is nothing to write instructions for, and a box that
    // took text it could never save is worse than a disabled one.
    expect(screen.getByRole('textbox', { name: 'Instructions for this project' })).toBeDisabled();
  });

  it('refuses to send more than the contract allows rather than letting the host refuse it', async () => {
    const user = userEvent.setup({ delay: null });
    mount(new BrowserAdapter());

    const box = await screen.findByRole('textbox', { name: 'Instructions for this project' });
    await waitFor(() => {
      expect(box).toBeEnabled();
    });
    await user.click(box);
    await user.paste('x'.repeat(PROJECT_INSTRUCTIONS_MAX_CHARS + 1));

    expect(await screen.findByText(/Too long/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save instructions' })).toBeDisabled();
  });
});
