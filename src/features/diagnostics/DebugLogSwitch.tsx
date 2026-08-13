/**
 * The switch for the local debug log.
 *
 * ## Why this exists at all
 *
 * Vela deliberately stops carrying endpoint-supplied text in the errors it
 * renders — that is a security property, and the raw bytes go to a local,
 * opt-in file instead, joined to the error by a correlation id. Every failed
 * turn shows that id as `trace <id>`.
 *
 * The file had no way to be switched on. `debuglog::enable` was called nowhere
 * in the application, so the id pointed into nothing, and a user following it
 * found no file and no setting — which reads as their failure, not as an
 * absence. This is the missing half.
 *
 * ## What it says out loud
 *
 * That the log records what the endpoint sent back; that it is on this machine
 * and goes nowhere; that it goes off again when Vela restarts; and where the
 * file is, so the `trace` id has somewhere to be searched. All four are things
 * a user must know *before* turning it on, not after.
 */

import { isDebugLogRecording } from '@/state/debug-log-store';

import styles from './DebugLogSwitch.module.css';
import { useDebugLog } from './use-debug-log';

export function DebugLogSwitch() {
  const { state, path, failure, setEnabled } = useDebugLog();
  const recording = isDebugLogRecording(state);

  return (
    <section className={styles.section} aria-label="Diagnostics">
      <h3 className={styles.heading}>Diagnostics</h3>

      <div className={styles.row}>
        <input
          id="vela-debug-log"
          type="checkbox"
          checked={recording}
          // `unknown` means the host has not answered yet. Offering the switch
          // then would let a click race the answer and set a state neither side
          // agrees on.
          disabled={state === 'unknown'}
          onChange={(event) => {
            void setEnabled(event.target.checked);
          }}
        />
        <label className={styles.label} htmlFor="vela-debug-log">
          Record what endpoints send back, to a file on this machine
        </label>
      </div>

      <p className={styles.explanation}>
        Off by default, and off again every time Vela starts. Vela keeps endpoint
        error text out of what it shows you and writes it here instead; the{' '}
        <strong>trace</strong> id on a failed reply is what you search this file for. Nothing is
        sent anywhere — this is a local file, and your API keys are removed from the bytes before
        they reach it.
      </p>

      {path === null ? null : (
        <p className={styles.path} data-testid="debug-log-path">
          {recording ? 'Writing to' : 'Would write to'}: {path}
        </p>
      )}

      {failure === null ? null : (
        <p className={styles.error} role="alert">
          Vela could not change this setting ({failure}). Nothing is being recorded.
        </p>
      )}
    </section>
  );
}
