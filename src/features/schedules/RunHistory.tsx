/**
 * One schedule's attempts, as a table.
 *
 * ## Why an empty table is the expected sight, and says so
 *
 * A run is opened by the host's poll thread and by nothing else — there is no
 * command the renderer could call to fire one, which
 * `src-tauri/src/ipc/schedules.rs` argues at length. So a schedule created a
 * moment ago has no runs, and will have none until its first slot comes round
 * with the application open. "No runs yet" is therefore the honest empty state
 * and it names the condition rather than leaving a blank rectangle that could
 * equally mean the read failed.
 *
 * ## Why `running` is not drawn as progress
 *
 * A run stays `running` until something finishes it, and **nothing in the
 * shipping tree finishes one.** Re-derived rather than repeated: the store has a
 * `finish_schedule_run`, its only callers are that crate's own tests and
 * `src-tauri/crates/vela-store/tests/durability.rs`, and no command exposes it —
 * so the only thing that ever moves a run off `running` is the boot-time reap in
 * `src-tauri/src/scheduler_host.rs`, which turns it into a failure. A spinner
 * would be this pane promising an outcome nothing is working towards. The status
 * is rendered as the word the host sent, and the caption says what that word
 * currently means.
 *
 * ## Why the trigger is not drawn
 *
 * A run carries whether the poll started it or a person did, and there is no
 * column for it here. The only producer of a `manual` run is
 * `vela_store::run_now`, and re-reading its callers finds none outside that
 * crate's own tests — no command exposes it. A column that could only ever hold
 * one value is a column that teaches the reader something untrue about what this
 * build can do. When a run-now command exists, the column arrives with it.
 */

import type { ScheduleRunStatus, ScheduleRunView } from '@/platform/contract';

import type { SchedulesRepository } from '@/data/schedules-repository';
import { formatDuration, formatInstant } from './schedule-times';
import { useScheduleRuns } from './use-schedules';

import styles from './RunHistory.module.css';

/**
 * The words a user reads for each status, owned here.
 *
 * The wire type is a closed set of three precisely so the renderer writes every
 * sentence and the host never invents one — the same discipline the memory
 * pane's category labels keep.
 */
const STATUS_LABELS: Readonly<Record<ScheduleRunStatus, string>> = {
  running: 'Running',
  success: 'Succeeded',
  failed: 'Failed',
};

interface RunHistoryProps {
  readonly scheduleId: string;
  readonly title: string;
  /** Substituted in tests; defaults to one built over the platform adapter. */
  readonly repository?: SchedulesRepository;
}

export function RunHistory({ scheduleId, title, repository }: RunHistoryProps) {
  const state = useScheduleRuns(scheduleId, repository);

  return (
    <section className={styles.history} aria-label={`Run history: ${title}`}>
      {state.status === 'loading' && (
        <p className={styles.note} data-testid="runs-loading">
          Reading run history…
        </p>
      )}

      {state.status === 'error' && (
        <p className={styles.error} role="status">
          Run history unavailable · {state.code}
        </p>
      )}

      {state.status === 'ready' && state.runs.length === 0 && (
        <p className={styles.note}>
          No runs yet. Vela starts a run when the slot comes round and the app is open.
        </p>
      )}

      {state.status === 'ready' && state.runs.length > 0 && (
        <table className={styles.table}>
          <caption className={styles.caption}>
            A run stays “Running” until it finishes; nothing sends it to a model yet.
          </caption>
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">Status</th>
              <th scope="col">Took</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {state.runs.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * One attempt.
 *
 * `error` is rendered, never matched: it is free text from whatever failed, and
 * the contract says so. `durationMs` is absent on a run still in flight, and an
 * em dash is the honest cell for a number that does not exist yet — a `0` there
 * would read as "finished instantly".
 */
function RunRow({ run }: { readonly run: ScheduleRunView }) {
  return (
    <tr>
      <td>
        <time dateTime={new Date(run.startedAtMs).toISOString()}>
          {formatInstant(run.startedAtMs)}
        </time>
      </td>
      <td>
        <span className={run.status === 'failed' ? styles.failed : styles.status}>
          {STATUS_LABELS[run.status]}
        </span>
      </td>
      <td>{run.durationMs === null ? '—' : formatDuration(run.durationMs)}</td>
      <td>{run.error ?? '—'}</td>
    </tr>
  );
}
