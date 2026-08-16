/**
 * The schedules pane's state: what is scheduled, and the three things a user can
 * do about it.
 *
 * Shaped after `src/features/memory/use-memory.ts`, and for the same reasons.
 * Every mutation re-reads the list rather than patching a local array: the host
 * owns the order — soonest due first — and enabling a schedule moves its row, so
 * reproducing that sort here would be a second opinion that drifts the first
 * time either side changes it.
 *
 * ## Disabled schedules are listed, and that is a choice
 *
 * The host hides them by default. This pane asks for them anyway, because it is
 * the only place a disabled schedule can be turned back on: a list that omitted
 * them would offer no way to reach the row it was hiding. The row draws its own
 * state, so nothing is concealed by including it.
 *
 * ## Failure is a state, not a swallow
 *
 * `problem` is set whenever the host refuses and the pane renders it. An empty
 * schedule list and a list that could not be read look identical on screen and
 * one of them is a lie.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createSchedulesRepository,
  type SchedulesRepository,
} from '@/data/schedules-repository';
import { usePlatform } from '@/platform/PlatformProvider';
import type { ScheduleRunView, ScheduleView, SchedulesCreateReq } from '@/platform/contract';
import { toPlatformError } from '@/platform/errors';

export type SchedulesState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly schedules: readonly ScheduleView[] }
  | { readonly status: 'error'; readonly code: string; readonly message: string };

export interface SchedulesController {
  readonly state: SchedulesState;
  /** Set by the last failed mutation, cleared by the next successful one. */
  readonly problem: string | null;
  add: (request: SchedulesCreateReq) => Promise<void>;
  setEnabled: (scheduleId: string, enabled: boolean) => Promise<void>;
  remove: (scheduleId: string) => Promise<void>;
}

export function useSchedules(repository?: SchedulesRepository): SchedulesController {
  const adapter = usePlatform();
  const schedules = useMemo(
    () => repository ?? createSchedulesRepository(adapter),
    [repository, adapter],
  );

  const [state, setState] = useState<SchedulesState>({ status: 'loading' });
  const [problem, setProblem] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const listed = await schedules.list(true);
      if (mounted.current) setState({ status: 'ready', schedules: listed });
    } catch (error: unknown) {
      const failure = toPlatformError(error);
      if (mounted.current) {
        setState({ status: 'error', code: failure.code, message: failure.message });
      }
    }
  }, [schedules]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * Run a mutation, then re-read. A refusal is kept as `problem` and the list is
   * still re-read, because the row the user acted on may have moved for another
   * reason — the poll thread fires schedules while this pane is open — and
   * leaving the stale copy on screen would be the second lie.
   */
  const mutate = useCallback(
    async (work: () => Promise<unknown>): Promise<void> => {
      try {
        await work();
        if (mounted.current) setProblem(null);
      } catch (error: unknown) {
        if (mounted.current) setProblem(toPlatformError(error).message);
      }
      await reload();
    },
    [reload],
  );

  return {
    state,
    problem,
    add: useCallback(
      (request: SchedulesCreateReq) => mutate(() => schedules.create(request)),
      [schedules, mutate],
    ),
    setEnabled: useCallback(
      (scheduleId: string, enabled: boolean) =>
        mutate(() => schedules.setEnabled(scheduleId, enabled)),
      [schedules, mutate],
    ),
    remove: useCallback(
      (scheduleId: string) => mutate(() => schedules.remove(scheduleId)),
      [schedules, mutate],
    ),
  };
}

export type RunsState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly runs: readonly ScheduleRunView[] }
  | { readonly status: 'error'; readonly code: string; readonly message: string };

/**
 * One schedule's run history, read on demand.
 *
 * Separate from {@link useSchedules} rather than a field on it, because the two
 * reads have different costs and different lifetimes: the list is read when the
 * pane opens, and a history is read only for the schedule whose history the user
 * asked to see. Folding them together would mean reading every schedule's
 * history to draw a list that shows none of them.
 *
 * There is no refresh and no poll. Nothing in the renderer can start a run, so
 * a history that changed while it was on screen changed because the *host's*
 * poll fired — and inventing a timer here to chase that would be this pane
 * guessing at the schedule the host already owns. Closing and reopening the
 * history re-reads it.
 */
export function useScheduleRuns(
  scheduleId: string,
  repository?: SchedulesRepository,
): RunsState {
  const adapter = usePlatform();
  const schedules = useMemo(
    () => repository ?? createSchedulesRepository(adapter),
    [repository, adapter],
  );

  const [state, setState] = useState<RunsState>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const runs = await schedules.listRuns(scheduleId);
        if (live) setState({ status: 'ready', runs });
      } catch (error: unknown) {
        const failure = toPlatformError(error);
        if (live) setState({ status: 'error', code: failure.code, message: failure.message });
      }
    })();
    return () => {
      live = false;
    };
  }, [schedules, scheduleId]);

  return state;
}
