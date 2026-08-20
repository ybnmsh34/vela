/**
 * The schedules pane: standing instructions, and everything Vela will do
 * without being asked again.
 *
 * ## Why the pane says so much about what it cannot do
 *
 * Because everything it says is true of this build and none of it is obvious
 * from the screen. Three facts a user would otherwise have to discover by
 * waiting:
 *
 *  - **Nothing fires while Vela is closed.** The poll thread is in the host
 *    process, so a laptop that was shut through a slot owes a run it will not
 *    get; the slot is counted as missed and the schedule moves on. That is
 *    `vela_store::Cadence::advance`, and the count is on the row.
 *  - **A cadence is a fixed offset from the first run, not a wall-clock rule.**
 *    `Cadence::interval_ms` is 24h for daily, so a daily schedule set for 09:00
 *    fires at 08:00 or 10:00 after the clocks change. The pane says this next to
 *    the picker rather than letting the user find it in March.
 *  - **A run does not reach a model, and it never closes.** Firing opens a
 *    conversation holding the prompt and records a `running` run, and then
 *    nothing drives it: no code in this tree reads a fired run, and the store's
 *    completion call has no caller outside its own crate's tests. The due query
 *    treats an open run as "still working", so the consequence — re-derived, not
 *    assumed — is that a schedule fires **at most once per launch**, until the
 *    boot-time reap in `src-tauri/src/scheduler_host.rs` turns the open run into
 *    a failure and makes the schedule due again. The intro says this out loud
 *    because a user would otherwise discover it by waiting a day.
 *
 * ## Why the length limits are not repeated here
 *
 * `src/features/memory/MemoryPanel.tsx` refuses an over-long entry itself so the
 * sentence names the limit. This does not, and the difference is that the limit
 * it would name is already a number written twice — in
 * `src-tauri/src/ipc/schedules.rs` and again in `src/platform/browser-adapter.ts`
 * — and a third copy is a third thing to keep in step. The host's refusal
 * already carries the ceiling in its own words, so it is rendered. Blankness is
 * refused here, because that one needs no number.
 *
 * ## What is deliberately absent
 *
 * No project picker. A schedule may be filed under a project and there is no
 * project surface in the renderer, so filing one here would put it somewhere the
 * user cannot look. No edit-in-place of a title, prompt or cadence either: the
 * host's patch type is reachable from `schedules_set_enabled` and nothing else,
 * so an edit form would be a control with no command behind it.
 */

import { useRef, useState } from 'react';

import { ModalSurface } from '@/components/ModalSurface';
import type { Cadence, ScheduleView } from '@/platform/contract';

import { RunHistory } from './RunHistory';
import { formatInstant, fromLocalDateTimeValue, nextWholeHour, toLocalDateTimeValue } from './schedule-times';
import { useSchedules, type SchedulesController } from './use-schedules';

import styles from './SchedulesPanel.module.css';

/**
 * The words a user reads for each cadence, owned here.
 *
 * The wire type is a closed set of four precisely so the renderer writes every
 * sentence and never parses one — the argument `src/platform/contract.ts` makes
 * for four labels instead of a cron expression.
 */
const CADENCE_LABELS: readonly (readonly [Cadence, string])[] = [
  ['once', 'Once'],
  ['hourly', 'Hourly'],
  ['daily', 'Daily'],
  ['weekly', 'Weekly'],
];

function cadenceLabel(cadence: Cadence): string {
  return CADENCE_LABELS.find(([value]) => value === cadence)?.[1] ?? cadence;
}

interface SchedulesPanelProps {
  readonly onClose: () => void;
  /** Substituted in tests; defaults to one built over the platform adapter. */
  readonly controller?: SchedulesController;
  /** Injectable clock, so the default first run is testable without waiting. */
  readonly now?: () => number;
}

export function SchedulesPanel({ onClose, controller, now = () => Date.now() }: SchedulesPanelProps) {
  // Called unconditionally — hooks may not be skipped — and its result is
  // discarded when the caller supplied one. The alternative is two components.
  const own = useSchedules();
  const schedules = controller ?? own;

  const closeRef = useRef<HTMLButtonElement>(null);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [cadence, setCadence] = useState<Cadence>('daily');
  // Read once, on first render: a default that moved while the user was filling
  // the form in would silently change the slot they thought they had picked.
  const [firstRun, setFirstRun] = useState(() => toLocalDateTimeValue(nextWholeHour(now())));

  const firstRunAtMs = fromLocalDateTimeValue(firstRun);
  const canSave = title.trim() !== '' && prompt.trim() !== '' && firstRunAtMs !== null;

  return (
    <ModalSurface
      labelledBy="schedules-title"
      describedBy="schedules-intro"
      scrimClassName={styles.scrim}
      className={styles.dialog}
      initialFocus={closeRef}
      onDismiss={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className={styles.head}>
        <h2 id="schedules-title" className={styles.title}>
          Schedules
        </h2>
        {/* Named for what it closes, not for the verb alone: a bare "Close"
            answered to the same name as the caption control that quits Vela.
            `src/app/close-collision.test.tsx`. */}
        <button
          type="button"
          ref={closeRef}
          className={styles.close}
          onClick={onClose}
          aria-label="Close the schedules panel"
        >
          Close
        </button>
      </div>

      <p id="schedules-intro" className={styles.intro}>
        When a slot comes round, Vela opens a conversation holding the prompt. Slots only come round
        while Vela is running. A run is not sent to a model yet, and it stays open until Vela
        restarts — so for now a schedule fires at most once per launch.
      </p>

      <form
        className={styles.composer}
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSave || firstRunAtMs === null) return;
          const request = { title, prompt, cadence, firstRunAtMs };
          setTitle('');
          setPrompt('');
          void schedules.add(request);
        }}
      >
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Title</span>
          <input
            className={styles.input}
            type="text"
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Prompt</span>
          <textarea
            className={styles.textarea}
            value={prompt}
            rows={2}
            onChange={(event) => {
              setPrompt(event.target.value);
            }}
          />
        </label>

        <div className={styles.composerRow}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Cadence</span>
            <select
              className={styles.select}
              value={cadence}
              onChange={(event) => {
                setCadence(event.target.value as Cadence);
              }}
            >
              {CADENCE_LABELS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>First run</span>
            <input
              className={styles.input}
              type="datetime-local"
              value={firstRun}
              onChange={(event) => {
                setFirstRun(event.target.value);
              }}
            />
          </label>

          <button type="submit" className={styles.save} disabled={!canSave}>
            Create schedule
          </button>
        </div>

        <p className={styles.note}>
          After the first run, slots are a fixed offset apart — a day is exactly 24 hours, so a daily
          schedule shifts by an hour when the clocks change.
        </p>
      </form>

      {schedules.problem !== null && (
        <p className={styles.error} role="status">
          That did not save · {schedules.problem}
        </p>
      )}

      {schedules.state.status === 'loading' && (
        <p className={styles.note} data-testid="schedules-loading">
          Reading schedules…
        </p>
      )}

      {schedules.state.status === 'error' && (
        <p className={styles.error} role="status">
          Schedules unavailable · {schedules.state.code}
        </p>
      )}

      {schedules.state.status === 'ready' && schedules.state.schedules.length === 0 && (
        <p className={styles.note}>Nothing is scheduled yet.</p>
      )}

      {schedules.state.status === 'ready' && schedules.state.schedules.length > 0 && (
        <ul className={styles.list}>
          {schedules.state.schedules.map((schedule) => (
            <ScheduleRow key={schedule.id} schedule={schedule} schedules={schedules} />
          ))}
        </ul>
      )}
    </ModalSurface>
  );
}

/**
 * One schedule.
 *
 * The next-run time is written twice on purpose: as words for the reader, and as
 * a machine-readable instant in the `<time>` element's own attribute. The words
 * are the reader's locale and zone, which is exactly what a test must not pin;
 * the attribute is UTC and is what a test reads instead.
 *
 * A disabled schedule stays in the list rather than disappearing. The host hides
 * them by default and this pane asks for them anyway, because this is the only
 * place one can be switched back on — see `src/features/schedules/use-schedules.ts`.
 */
function ScheduleRow({
  schedule,
  schedules,
}: {
  readonly schedule: ScheduleView;
  readonly schedules: SchedulesController;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);

  return (
    <li className={schedule.enabled ? styles.row : `${styles.row} ${styles.rowOff}`}>
      <div className={styles.rowHead}>
        <h3 className={styles.rowTitle}>{schedule.title}</h3>
        <button
          type="button"
          role="switch"
          aria-checked={schedule.enabled}
          aria-label={`Enabled: ${schedule.title}`}
          className={schedule.enabled ? `${styles.switch} ${styles.switchOn}` : styles.switch}
          onClick={() => {
            void schedules.setEnabled(schedule.id, !schedule.enabled);
          }}
        >
          {schedule.enabled ? 'On' : 'Off'}
        </button>
      </div>

      <p className={styles.rowMeta}>
        {cadenceLabel(schedule.cadence)} · next{' '}
        <time dateTime={new Date(schedule.nextRunAtMs).toISOString()}>
          {formatInstant(schedule.nextRunAtMs)}
        </time>
        {schedule.missedRuns > 0 && (
          // The count, and not a cause. A slot is missed while Vela is closed,
          // and also while a previous run is still open — `due_schedules` reads
          // an open run as "still working" — and the row cannot tell the two
          // apart from what the host sends.
          <span className={styles.missed}>
            {' '}
            · {schedule.missedRuns} slot{schedule.missedRuns === 1 ? '' : 's'} missed
          </span>
        )}
      </p>

      <p className={styles.rowPrompt}>{schedule.prompt}</p>

      <div className={styles.rowActions}>
        <button
          type="button"
          className={styles.action}
          aria-expanded={historyOpen}
          // The visible word plus the schedule it belongs to. Two rows both
          // offering a button called "Runs" is two controls a screen reader
          // cannot tell apart, and the discriminator is the same one the memory
          // pane's Forget button uses.
          aria-label={`${historyOpen ? 'Hide runs' : 'Runs'}: ${schedule.title}`}
          onClick={() => {
            setHistoryOpen((open) => !open);
          }}
        >
          {historyOpen ? 'Hide runs' : 'Runs'}
        </button>
        <button
          type="button"
          className={styles.delete}
          aria-label={`Delete: ${schedule.title}`}
          onClick={() => {
            void schedules.remove(schedule.id);
          }}
        >
          Delete
        </button>
      </div>

      {historyOpen && <RunHistory scheduleId={schedule.id} title={schedule.title} />}
    </li>
  );
}
