/**
 * The schedules pane: the surface that was missing.
 *
 * The five `schedules_*` commands were registered in `generate_handler!`,
 * allowlisted in `src-tauri/src/ipc/mod.rs`, declared in
 * `src/platform/contract.ts`, implemented in `src-tauri/src/ipc/schedules.rs`
 * and faked in `src/platform/browser-adapter.ts` — and no file under `src/data/`
 * or `src/features/` named any of them. The poll thread ran every thirty seconds
 * over a table with no way in. So these tests are about what a *user* can do:
 * type a schedule, see it listed with the slot it will take, switch it off,
 * switch it back on, and look at what it has run.
 *
 * **Honesty (conventions §10):** VERIFIED-BY-FAKE. `BrowserAdapter` is an
 * in-memory host with no poll thread, so nothing here proves a slot ever comes
 * round or that a real SQLite row survives a restart. What is proved is that the
 * renderer reaches the commands and renders what they answer.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { BrowserAdapter } from '@/platform/browser-adapter';
import { PlatformProvider } from '@/platform/PlatformProvider';
import { resetSchedulesStore } from '@/state/schedules-store';

import { SchedulesPanel } from './SchedulesPanel';

/** A local wall clock reading, as an instant, without using the module. */
function local(year: number, month: number, day: number, hour: number, minute: number): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

function mount(adapter: BrowserAdapter) {
  return render(
    <PlatformProvider adapter={adapter}>
      <SchedulesPanel onClose={() => undefined} />
    </PlatformProvider>,
  );
}

type User = ReturnType<typeof userEvent.setup>;

/** Fill the form the way a user does and press the button. */
async function createSchedule(
  user: User,
  options: { readonly title: string; readonly prompt: string; readonly firstRun?: string },
): Promise<void> {
  await user.click(await screen.findByRole('textbox', { name: 'Title' }));
  await user.paste(options.title);
  await user.click(screen.getByRole('textbox', { name: 'Prompt' }));
  await user.paste(options.prompt);
  if (options.firstRun !== undefined) {
    // `fireEvent` rather than `user.type`: a `datetime-local` field is filled by
    // a picker, not by keystrokes, and typing into one is a simulation of an
    // interaction no user performs.
    fireEvent.change(screen.getByLabelText('First run'), {
      target: { value: options.firstRun },
    });
  }
  await user.click(screen.getByRole('button', { name: 'Create schedule' }));
}

beforeEach(() => {
  resetSchedulesStore();
});

describe('the schedules pane', () => {
  it('says nothing is scheduled rather than showing an empty box', async () => {
    mount(new BrowserAdapter());
    expect(await screen.findByText('Nothing is scheduled yet.')).toBeInTheDocument();
  });

  it('creates what the user typed and lists it with the slot it will take', async () => {
    const user = userEvent.setup();
    mount(new BrowserAdapter());

    await createSchedule(user, {
      title: 'morning digest',
      prompt: 'summarise what changed overnight',
      firstRun: '2027-03-05T09:00',
    });

    const row = await screen.findByRole('listitem');
    expect(row).toHaveTextContent('morning digest');
    expect(row).toHaveTextContent('summarise what changed overnight');
    // Daily is the form's starting cadence and the row must say so in words,
    // because the wire value is not something a user should have to know.
    expect(row).toHaveTextContent('Daily');

    // The machine-readable half of the next-run time. The words beside it are
    // the reader's own locale and zone, which is exactly what a test must not
    // pin; this attribute is UTC and says the same thing.
    const when = row.querySelector('time');
    expect(when).not.toBeNull();
    expect(when?.getAttribute('dateTime')).toBe(new Date(local(2027, 3, 5, 9, 0)).toISOString());
  });

  it('empties the form after a save, so the next schedule is not a copy', async () => {
    const user = userEvent.setup();
    mount(new BrowserAdapter());

    await createSchedule(user, { title: 'first', prompt: 'do a thing' });
    await screen.findByRole('listitem');

    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('');
  });

  it('switches a schedule off and back on, and the row says which it is', async () => {
    const user = userEvent.setup();
    mount(new BrowserAdapter());

    await createSchedule(user, { title: 'morning digest', prompt: 'summarise' });
    const toggle = await screen.findByRole('switch', { name: 'Enabled: morning digest' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toHaveTextContent('On');

    await user.click(toggle);
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Enabled: morning digest' })).toHaveAttribute(
        'aria-checked',
        'false',
      );
    });
    // Still listed. The host hides a disabled schedule by default and this pane
    // asks for it anyway, because this row holds the only control that can
    // switch it back on.
    expect(screen.getByRole('switch', { name: 'Enabled: morning digest' })).toHaveTextContent('Off');

    await user.click(screen.getByRole('switch', { name: 'Enabled: morning digest' }));
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Enabled: morning digest' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });
  });

  it('deletes a schedule when asked, and says the list is empty again', async () => {
    const user = userEvent.setup();
    mount(new BrowserAdapter());

    await createSchedule(user, { title: 'temporary', prompt: 'do a thing' });
    await screen.findByRole('switch', { name: 'Enabled: temporary' });

    await user.click(screen.getByRole('button', { name: 'Delete: temporary' }));
    expect(await screen.findByText('Nothing is scheduled yet.')).toBeInTheDocument();
  });

  it('opens the run history on request and does not read it before', async () => {
    const user = userEvent.setup();
    const asked: string[] = [];
    class Counting extends BrowserAdapter {
      override async invoke(command: never, payload: never): Promise<never> {
        asked.push(command as string);
        return super.invoke(command, payload);
      }
    }
    mount(new Counting() as BrowserAdapter);

    await createSchedule(user, { title: 'morning digest', prompt: 'summarise' });
    await screen.findByRole('switch', { name: 'Enabled: morning digest' });
    // The read is per-schedule and would be a read per row if the list did it.
    expect(asked).not.toContain('schedules_list_runs');

    await user.click(screen.getByRole('button', { name: 'Runs: morning digest' }));
    expect(
      await screen.findByText(/No runs yet\. Vela starts a run when the slot comes round/u),
    ).toBeInTheDocument();
    expect(asked).toContain('schedules_list_runs');
  });

  it('reports a list it could not read instead of drawing it as empty', async () => {
    // An empty list and an unreadable one look identical on screen, and one of
    // them is a lie.
    class BrokenHost extends BrowserAdapter {
      override async invoke(command: never, payload: never): Promise<never> {
        if ((command as string) === 'schedules_list') throw new Error('database is locked');
        return super.invoke(command, payload);
      }
    }
    mount(new BrokenHost() as BrowserAdapter);

    expect(await screen.findByRole('status')).toHaveTextContent(/Schedules unavailable/u);
    expect(screen.queryByText('Nothing is scheduled yet.')).not.toBeInTheDocument();
  });

  it('renders the host’s refusal rather than pre-empting it with its own copy', async () => {
    // The ceiling is written in `src-tauri/src/ipc/schedules.rs` and mirrored in
    // the fake. The pane holds no third copy, so the number the user reads comes
    // from the side that enforces it.
    const user = userEvent.setup();
    mount(new BrowserAdapter());

    await createSchedule(user, { title: 'x'.repeat(201), prompt: 'summarise' });
    expect(await screen.findByText(/must be at most 200 characters/u)).toBeInTheDocument();
    expect(screen.getByText('Nothing is scheduled yet.')).toBeInTheDocument();
  });

  it('will not save without a title, a prompt and a first run', async () => {
    const user = userEvent.setup();
    mount(new BrowserAdapter());

    const save = await screen.findByRole('button', { name: 'Create schedule' });
    expect(save).toBeDisabled();

    await user.click(screen.getByRole('textbox', { name: 'Title' }));
    await user.paste('morning digest');
    expect(save).toBeDisabled();

    await user.click(screen.getByRole('textbox', { name: 'Prompt' }));
    await user.paste('summarise');
    expect(save).toBeEnabled();

    // A cleared date field is the one that is easy to miss: the two text fields
    // are full, so the form looks complete, and the instant it would send is
    // `null`.
    fireEvent.change(screen.getByLabelText('First run'), { target: { value: '' } });
    expect(save).toBeDisabled();
  });

  it('says out loud that a schedule fires at most once per launch', async () => {
    // True of this build and invisible from the screen. A fired run is never
    // closed — nothing in the tree calls the store's completion — and the due
    // query treats an open run as "still working", so the schedule is not due
    // again until the boot-time reap. If that changes, this sentence and this
    // test change with it.
    mount(new BrowserAdapter());
    expect(await screen.findByText(/fires at most once per launch/u)).toBeInTheDocument();
  });

  it('starts the first run on a whole hour in the future', async () => {
    // Not "now": a first run already in the past fires at the very next poll and
    // books every slot it skipped as a missed run.
    const now = local(2026, 8, 16, 9, 37);
    render(
      <PlatformProvider adapter={new BrowserAdapter()}>
        <SchedulesPanel onClose={() => undefined} now={() => now} />
      </PlatformProvider>,
    );

    expect(await screen.findByLabelText('First run')).toHaveValue('2026-08-16T10:00');
  });
});
