/**
 * Standing instructions, as the renderer asks for them.
 *
 * A plain factory over a {@link PlatformAdapter}, following the rules in
 * `src/data/host-repository.ts`: no React, the adapter arrives as an argument,
 * and nothing here invents data the host did not send. Every method is one
 * command and one unwrap of its single-key envelope, the same shape
 * `src/data/memory-repository.ts` keeps.
 *
 * ## There is no `runNow`, and that is the point
 *
 * `src-tauri/src/ipc/schedules.rs` exposes five commands and none of them fires
 * a schedule. Deciding that a slot has arrived belongs to the host's poll
 * thread, which runs whether or not a window is open, and a renderer that could
 * fire would be a second answer to "has this slot come round". So this
 * repository can read the state and change the state, and cannot start a run.
 *
 * A consequence worth stating plainly rather than discovering: because nothing
 * in a browser tab polls, a schedule created against `BrowserAdapter` never
 * produces a run, and {@link SchedulesRepository.listRuns} against the fake
 * answers an empty list forever. The fake says so in its own words at the
 * `#schedules` field. Tests that need rows in a run history have to supply them.
 *
 * ## Why `create` takes the request whole
 *
 * `firstRunAtMs` is an absolute instant the *renderer* computes, because "nine
 * tomorrow" is a question about the user's timezone and the host deliberately
 * does not answer it (see `src/platform/contract.ts`'s note on
 * {@link SchedulesCreateReq}). Widening that into positional arguments here
 * would put a second opinion about the argument order between the caller and
 * the wire, so the request crosses this layer unchanged and the arithmetic lives
 * in `src/features/schedules/schedule-times.ts` where it can be tested on its
 * own.
 */

import type { PlatformAdapter } from '@/platform/adapter';
import type {
  ScheduleRunView,
  ScheduleView,
  SchedulesCreateReq,
} from '@/platform/contract';

export interface SchedulesRepository {
  /**
   * Every schedule, soonest-due first.
   *
   * Disabled ones are omitted unless asked for: disabling is the user saying
   * "not now", and the host hides them by default for that reason. A surface
   * that offers a re-enable control has to pass `true`, or the row it wants to
   * re-enable is not in the list it drew.
   */
  list(includeDisabled?: boolean): Promise<readonly ScheduleView[]>;
  create(request: SchedulesCreateReq): Promise<ScheduleView>;
  /** Answers with the schedule as it now stands, not with what was asked for. */
  setEnabled(scheduleId: string, enabled: boolean): Promise<ScheduleView>;
  /**
   * Delete a schedule and, with it, its whole run history.
   *
   * Rejects with `NOT_FOUND` on a schedule that is already gone rather than
   * resolving quietly — the host's choice, passed through, because the user just
   * asked to destroy something and "it was already gone" is information.
   */
  remove(scheduleId: string): Promise<void>;
  /**
   * One schedule's attempts, newest first.
   *
   * Rejects with `NOT_FOUND` for a schedule that does not exist. That is not the
   * same answer as an empty list, and the difference is the whole reason it is
   * not flattened here: an empty list means "it has not run yet".
   */
  listRuns(scheduleId: string, limit?: number): Promise<readonly ScheduleRunView[]>;
}

export function createSchedulesRepository(adapter: PlatformAdapter): SchedulesRepository {
  return {
    async list(includeDisabled = false): Promise<readonly ScheduleView[]> {
      const response = await adapter.invoke('schedules_list', { includeDisabled });
      return response.schedules;
    },

    async create(request: SchedulesCreateReq): Promise<ScheduleView> {
      const response = await adapter.invoke('schedules_create', request);
      return response.schedule;
    },

    async setEnabled(scheduleId: string, enabled: boolean): Promise<ScheduleView> {
      const response = await adapter.invoke('schedules_set_enabled', { scheduleId, enabled });
      return response.schedule;
    },

    async remove(scheduleId: string): Promise<void> {
      await adapter.invoke('schedules_delete', { scheduleId });
    },

    async listRuns(scheduleId: string, limit?: number): Promise<readonly ScheduleRunView[]> {
      const response = await adapter.invoke('schedules_list_runs', { scheduleId, limit });
      return response.runs;
    },
  };
}
