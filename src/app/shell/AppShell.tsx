/**
 * The application shell: title bar, navigation rail, content region, status bar.
 *
 * The shell is layout only. It must never import a feature, hold feature state,
 * or know which provider is configured — features are mounted into the content
 * region by the router when that lands.
 */

import { useHostStatus } from './use-host-status';
import { PlaceholderRegion } from './PlaceholderRegion';
import { TitleBar } from './TitleBar';
import styles from './AppShell.module.css';

const RAIL_SLOTS = 4;

export function AppShell() {
  const status = useHostStatus();

  const dotClass =
    status.state === 'ready'
      ? `${styles.dot} ${styles.dotOk}`
      : status.state === 'error'
        ? `${styles.dot} ${styles.dotWarn}`
        : styles.dot;

  return (
    <div className={styles.shell}>
      <TitleBar context="Untitled workspace" />

      <div className={styles.body}>
        <nav className={styles.rail} aria-label="Primary">
          {Array.from({ length: RAIL_SLOTS }, (_, index) => (
            <span key={index} className={styles.railSlot} aria-hidden="true" />
          ))}
        </nav>

        <main className={styles.main}>
          <PlaceholderRegion status={status} />
        </main>
      </div>

      <footer className={styles.statusBar}>
        <span className={dotClass} aria-hidden="true" />
        <span data-testid="status-line">
          {status.state === 'ready'
            ? `Bridge ready · ${status.info.secretBackend}`
            : status.state === 'error'
              ? `Bridge unavailable · ${status.code}`
              : 'Connecting to host…'}
        </span>
        <span className={styles.spacer} />
        <span>Offline · no telemetry</span>
      </footer>
    </div>
  );
}
