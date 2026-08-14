/**
 * The fake host's `schedules_*` commands, tested the way the Rust ones are.
 *
 * Conventions §8: "Every `BrowserAdapter` command gets a vitest test mirroring
 * the Rust one. When they disagree, the fake is wrong." Each test here has a
 * counterpart in `src-tauri/src/ipc/schedules.rs` asserting the same rule.
 *
 * ## The one place the two halves deliberately differ, and why it is stated
 *
 * The host fires schedules from a background thread; a browser tab has none,
 * and there is no command that could stand in for one, because the renderer is
 * not allowed to fire a schedule. So `schedules_list_runs` against this fake
 * always answers an empty list for a schedule that exists. That is asserted
 * below rather than left to be discovered, and the Rust counterpart asserts the
 * opposite for the same command — that a real poll produces a real run — so the
 * difference is written down on both sides instead of being a silent hole.
 *
 * **VERIFIED-BY-FAKE.** Nothing here is evidence about SQLite, about the poll
 * thread, or about a schedule ever firing on a real clock. The Rust tests in
 * `src-tauri/crates/vela-store/src/scheduler.rs` are what say that.
 */

import { describe, expect, it } from 'vitest';

import { BrowserAdapter } from './browser-adapter';
import { PlatformError } from './errors';
import type { SchedulesCreateReq } from './contract';

const NOON = 1_700_000_000_000;
const HOUR = 60 * 60 * 1_000;

function adapter(): BrowserAdapter {
  return new BrowserAdapter({ now: () => NOON });
}

function daily(title: string, firstRunAtMs = NOON + HOUR): SchedulesCreateReq {
  return { title, prompt: 'summarise the day', cadence: 'daily', firstRunAtMs };
}

describe('schedules_create', () => {
  it('stores a schedule enabled, unfired, and owed its first slot', async () => {
    const host = adapter();
    const { schedule } = await host.invoke('schedules_create', daily('standup'));

    expect(schedule.title).toBe('standup');
    expect(schedule.cadence).toBe('daily');
    expect(schedule.enabled).toBe(true);
    expect(schedule.nextRunAtMs).toBe(NOON + HOUR);
    expect(schedule.missedRuns).toBe(0);
    expect(schedule.projectId).toBeNull();
  });

  it('refuses a blank title or prompt rather than storing one', async () => {
    const host = adapter();
    await expect(host.invoke('schedules_create', { ...daily('x'), title: '   ' })).rejects.toThrow(
      PlatformError,
    );
    await expect(
      host.invoke('schedules_create', { ...daily('fine'), prompt: '\n\t ' }),
    ).rejects.toThrow(PlatformError);

    const { schedules } = await host.invoke('schedules_list', { includeDisabled: true });
    expect(schedules).toEqual([]);
  });

  it('carries no backend identity', async () => {
    const host = adapter();
    const { schedule } = await host.invoke('schedules_create', daily('quiet'));
    // A field the renderer can read is a field the renderer will eventually
    // switch on. Conventions §0 rule 3.
    const row = schedule as unknown as Record<string, unknown>;
    expect(row['providerId']).toBeUndefined();
    expect(row['modelId']).toBeUndefined();
  });
});

describe('schedules_list', () => {
  it('orders soonest-due first, so the list reads as a queue', async () => {
    const host = adapter();
    await host.invoke('schedules_create', daily('later', NOON + 4 * HOUR));
    await host.invoke('schedules_create', daily('sooner', NOON + HOUR));

    const { schedules } = await host.invoke('schedules_list', {});
    expect(schedules.map((s) => s.title)).toEqual(['sooner', 'later']);
  });

  it('hides disabled schedules unless asked, because disabling means "not now"', async () => {
    const host = adapter();
    const { schedule } = await host.invoke('schedules_create', daily('paused'));

    const disabled = await host.invoke('schedules_set_enabled', {
      scheduleId: schedule.id,
      enabled: false,
    });
    expect(disabled.schedule.enabled).toBe(false);

    expect((await host.invoke('schedules_list', {})).schedules).toEqual([]);
    expect(
      (await host.invoke('schedules_list', { includeDisabled: true })).schedules,
    ).toHaveLength(1);

    // Re-enabling restores it whole: disabling is not a delete.
    await host.invoke('schedules_set_enabled', { scheduleId: schedule.id, enabled: true });
    const [restored] = (await host.invoke('schedules_list', {})).schedules;
    expect(restored?.title).toBe('paused');
    expect(restored?.prompt).toBe('summarise the day');
  });
});

describe('schedules_delete', () => {
  it('reports a schedule that was already gone rather than succeeding quietly', async () => {
    const host = adapter();
    const { schedule } = await host.invoke('schedules_create', daily('temporary'));

    await expect(host.invoke('schedules_delete', { scheduleId: schedule.id })).resolves.toEqual({
      ok: true,
    });
    await expect(host.invoke('schedules_delete', { scheduleId: schedule.id })).rejects.toThrow(
      PlatformError,
    );
  });
});

describe('schedules_list_runs', () => {
  it('answers an empty history for a schedule this runtime cannot fire', async () => {
    const host = adapter();
    const { schedule } = await host.invoke('schedules_create', daily('never fires here'));

    // Empty, not an error: the schedule exists and simply has no runs, because
    // a browser tab has no poll thread. See this file's header.
    const { runs } = await host.invoke('schedules_list_runs', { scheduleId: schedule.id });
    expect(runs).toEqual([]);
  });

  it('distinguishes "has not run" from "does not exist"', async () => {
    const host = adapter();
    await expect(
      host.invoke('schedules_list_runs', { scheduleId: 'sched_nonexistent' }),
    ).rejects.toThrow(PlatformError);
  });
});
