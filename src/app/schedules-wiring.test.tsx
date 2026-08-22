/**
 * **Can a user reach the schedules commands at all?**
 *
 * ## Why this file exists, separately from every other schedules test
 *
 * Because it is the only question that matters here, and no component-level test
 * can ask it. `src-tauri/src/ipc/schedules.rs` was implemented and unit-tested,
 * the five commands were registered and allowlisted, `src/platform/contract.ts`
 * declared every shape, and `src/platform/browser-adapter.ts` faked the lot —
 * and `git grep` for any of those names under `src/` found only the contract,
 * its own tests and the fake. Nothing under `src/data/` or `src/features/` named
 * one. The host's poll thread ran every thirty seconds over a table no user
 * could put a row in, behind a fully green suite.
 *
 * So this renders the real `<App/>` and drives the shipping affordance: the
 * sidebar button, the pane it opens, the form in it, and the switch on the row
 * that comes back. The assertion is on the commands the renderer handed the
 * host. A pane rendering correctly in isolation is not evidence that anything
 * reaches it — that is the lesson `src/app/composition-root.test.tsx` was
 * written for and this is the same lesson on a different feature.
 *
 * **Honesty (conventions §10): VERIFIED-BY-FAKE.** The host is
 * `BrowserAdapter`, whose schedules commands mirror the Rust ones and whose
 * validation is the same validation. What is proved is that the renderer's parts
 * are joined and that the payloads have the shape the Rust host accepts. Nothing
 * here proves a slot ever comes round, that a row survives a restart, or that a
 * real window draws any of it.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '@/app/App';
import { BrowserAdapter } from '@/platform/browser-adapter';
import type { CommandName, CommandReq, CommandRes } from '@/platform/contract';
import { resetMemoryStore } from '@/state/memory-store';
import { resetModelStore } from '@/state/model-store';
import { resetNavigationStore } from '@/state/navigation-store';
import { resetSchedulesStore } from '@/state/schedules-store';

/**
 * The real fake host, with one addition: it keeps the commands it was given.
 * A subclass rather than a mock — every command still runs the fake's own
 * validation, so a payload this test calls "sent" is one the host accepted.
 */
class RecordingHost extends BrowserAdapter {
  readonly sent: Array<{ readonly command: string; readonly payload: unknown }> = [];

  override async invoke<C extends CommandName>(
    command: C,
    payload: CommandReq<C>,
  ): Promise<CommandRes<C>> {
    this.sent.push({ command, payload });
    return super.invoke(command, payload);
  }

  commands(): readonly string[] {
    return this.sent.map((entry) => entry.command);
  }
}

beforeEach(() => {
  resetMemoryStore();
  resetModelStore();
  resetNavigationStore();
  resetSchedulesStore();
});

describe('the schedules surface is reachable from the assembled application', () => {
  it('is not read at all until the user asks for it', async () => {
    // The pane mounts nothing while closed, which is why the sidebar's boolean
    // is the whole coupling. A surface that read the host at startup would cost
    // that read on every launch whether or not anyone opened it.
    const host = new RecordingHost();
    render(<App adapter={host} />);
    await screen.findByRole('button', { name: 'Schedules' });

    expect(host.commands()).not.toContain('schedules_list');
  });

  it('opens from the sidebar and reads the list', async () => {
    const user = userEvent.setup();
    const host = new RecordingHost();
    render(<App adapter={host} />);

    await user.click(await screen.findByRole('button', { name: 'Schedules' }));

    expect(await screen.findByRole('heading', { name: 'Schedules' })).toBeInTheDocument();
    await waitFor(() => {
      expect(host.commands()).toContain('schedules_list');
    });
  });

  it('carries a schedule the user typed all the way to the host', async () => {
    const user = userEvent.setup();
    const host = new RecordingHost();
    render(<App adapter={host} />);

    await user.click(await screen.findByRole('button', { name: 'Schedules' }));
    await user.click(await screen.findByRole('textbox', { name: 'Title' }));
    await user.paste('morning digest');
    await user.click(screen.getByRole('textbox', { name: 'Prompt' }));
    await user.paste('summarise what changed overnight');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Cadence' }), 'daily');
    await user.click(screen.getByRole('button', { name: 'Create schedule' }));

    await screen.findByRole('switch', { name: 'Enabled: morning digest' });

    const created = host.sent.find((entry) => entry.command === 'schedules_create');
    expect(created, 'nothing reached schedules_create').toBeDefined();
    expect(created?.payload).toMatchObject({
      title: 'morning digest',
      prompt: 'summarise what changed overnight',
      cadence: 'daily',
    });
    // The host takes an absolute instant and refuses to work out what "nine
    // tomorrow" means, so the renderer owes it one. A missing or non-numeric
    // value here is the whole feature failing at the boundary.
    expect(typeof (created?.payload as { firstRunAtMs?: unknown }).firstRunAtMs).toBe('number');
  });

  it('carries a switch on the row through to the host and back to the screen', async () => {
    const user = userEvent.setup();
    const host = new RecordingHost();
    render(<App adapter={host} />);

    await user.click(await screen.findByRole('button', { name: 'Schedules' }));
    await user.click(await screen.findByRole('textbox', { name: 'Title' }));
    await user.paste('morning digest');
    await user.click(screen.getByRole('textbox', { name: 'Prompt' }));
    await user.paste('summarise');
    await user.click(screen.getByRole('button', { name: 'Create schedule' }));

    await user.click(await screen.findByRole('switch', { name: 'Enabled: morning digest' }));

    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Enabled: morning digest' })).toHaveAttribute(
        'aria-checked',
        'false',
      );
    });
    expect(host.sent).toContainEqual({
      command: 'schedules_set_enabled',
      payload: { scheduleId: 'sched_1', enabled: false },
    });
    // Re-read after the write, so the row draws what the host holds rather than
    // what the click hoped for.
    expect(host.commands().lastIndexOf('schedules_list')).toBeGreaterThan(
      host.commands().indexOf('schedules_set_enabled'),
    );
  });

  it('closes on Escape and gives the keyboard back to the button that opened it', async () => {
    const user = userEvent.setup();
    render(<App adapter={new BrowserAdapter()} />);

    const opener = await screen.findByRole('button', { name: 'Schedules' });
    await user.click(opener);
    await screen.findByRole('heading', { name: 'Schedules' });

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Schedules' })).not.toBeInTheDocument();
    });
    expect(document.activeElement).toBe(opener);
  });
});
