import { describe, expect, it } from 'vitest';

import { NO_WINDOW_CONTROLS, type PlatformAdapter } from '@/platform/adapter';
import { BrowserAdapter } from '@/platform/browser-adapter';
import { isAllowedCommand } from '@/platform/contract';
import { PlatformError } from '@/platform/errors';

import { createSchedulesRepository } from './schedules-repository';

/**
 * **VERIFIED-BY-FAKE.** Driven against `BrowserAdapter`, so what is proved here
 * is the protocol shape and the repository's own behaviour: which key each
 * envelope is unwrapped from, which refusals reject rather than resolve, and
 * that a missing schedule and a schedule with no runs are two different answers.
 * Nothing here writes a SQLite row; the store and the poll are tested in
 * `src-tauri/crates/vela-store/` against a real database, and the command layer
 * in `src-tauri/src/ipc/schedules.rs` against the same.
 */

const NINE_AM = 1_797_066_000_000;

function daily(title: string) {
  return {
    title,
    prompt: 'summarise what changed overnight',
    cadence: 'daily',
    firstRunAtMs: NINE_AM,
  } as const;
}

describe('createSchedulesRepository', () => {
  it('creates a schedule and hands back the row, not the envelope', async () => {
    const created = await createSchedulesRepository(new BrowserAdapter()).create(
      daily('morning digest'),
    );

    expect(created.title).toBe('morning digest');
    expect(created.cadence).toBe('daily');
    expect(created.nextRunAtMs).toBe(NINE_AM);
    // The host decides these, and a repository that supplied them would be
    // inventing data. Asserted so a future default here would be caught.
    expect(created.enabled).toBe(true);
    expect(created.missedRuns).toBe(0);
  });

  it('hides disabled schedules by default and includes them when asked', async () => {
    // The distinction this repository's one non-passthrough argument exists for:
    // a pane offering a re-enable control has to ask for the row it wants to
    // re-enable, or it is drawing a list the control cannot appear in.
    const repository = createSchedulesRepository(new BrowserAdapter());
    const created = await repository.create(daily('paused digest'));
    await repository.setEnabled(created.id, false);

    expect(await repository.list()).toEqual([]);
    expect((await repository.list(true)).map((schedule) => schedule.id)).toEqual([created.id]);
  });

  it('answers a toggle with the state the host reached, not the state asked for', async () => {
    const repository = createSchedulesRepository(new BrowserAdapter());
    const created = await repository.create(daily('nightly report'));

    const off = await repository.setEnabled(created.id, false);
    expect(off.enabled).toBe(false);
    const on = await repository.setEnabled(created.id, true);
    expect(on.enabled).toBe(true);
  });

  it('separates a schedule with no runs from a schedule that is not there', async () => {
    // Flattening these two into one empty list is the defect the host refuses
    // to commit, and it would be undone here by a `catch` that returned `[]`.
    const repository = createSchedulesRepository(new BrowserAdapter());
    const created = await repository.create(daily('quiet one'));

    expect(await repository.listRuns(created.id)).toEqual([]);

    const failure = await repository.listRuns('sched_never').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PlatformError);
    expect(failure).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects a delete of something already gone rather than resolving quietly', async () => {
    const repository = createSchedulesRepository(new BrowserAdapter());
    const created = await repository.create(daily('temporary'));

    await repository.remove(created.id);
    const failure = await repository.remove(created.id).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PlatformError);
    expect(failure).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('passes a blank title to the host and lets its refusal through', async () => {
    // Not validated here. The host's message names the ceiling it enforces, and
    // a second copy of that rule in the renderer is a second thing to keep in
    // step — see the pane, which renders the refusal instead of pre-empting it.
    const failure = await createSchedulesRepository(new BrowserAdapter())
      .create({ ...daily('unused'), title: '   ' })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PlatformError);
    expect(failure).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect((failure as PlatformError).message).toContain('must not be blank');
  });

  it('sends each command with the payload the contract declares', async () => {
    const sent: Array<{ command: string; payload: unknown }> = [];
    const recording: PlatformAdapter = {
      kind: 'browser',
      window: NO_WINDOW_CONTROLS,
      invoke: async (command, payload) => {
        sent.push({ command, payload });
        return (
          command === 'schedules_list'
            ? { schedules: [] }
            : command === 'schedules_list_runs'
              ? { runs: [] }
              : command === 'schedules_delete'
                ? { ok: true }
                : { schedule: null }
        ) as never;
      },
      listen: async () => () => {},
    };

    const repository = createSchedulesRepository(recording);
    await repository.list();
    await repository.list(true);
    await repository.create(daily('wire'));
    await repository.setEnabled('sched_1', false);
    await repository.remove('sched_1');
    await repository.listRuns('sched_1');
    await repository.listRuns('sched_1', 5);

    // `toStrictEqual`, not `toEqual`: the latter reads a missing key and a key
    // set to `undefined` as the same thing, which is exactly the difference
    // between passing the host a limit and not passing one.
    expect(sent).toStrictEqual([
      { command: 'schedules_list', payload: { includeDisabled: false } },
      { command: 'schedules_list', payload: { includeDisabled: true } },
      { command: 'schedules_create', payload: daily('wire') },
      { command: 'schedules_set_enabled', payload: { scheduleId: 'sched_1', enabled: false } },
      { command: 'schedules_delete', payload: { scheduleId: 'sched_1' } },
      { command: 'schedules_list_runs', payload: { scheduleId: 'sched_1', limit: undefined } },
      { command: 'schedules_list_runs', payload: { scheduleId: 'sched_1', limit: 5 } },
    ]);
  });

  it('calls commands that are really on the allowlist', () => {
    // Cheap insurance that the five names above are the declared ones. A typo
    // would otherwise show up as `UNKNOWN_COMMAND` at runtime in the packaged
    // app and nowhere else.
    for (const command of [
      'schedules_create',
      'schedules_delete',
      'schedules_list',
      'schedules_list_runs',
      'schedules_set_enabled',
    ]) {
      expect(isAllowedCommand(command), command).toBe(true);
    }
  });
});
