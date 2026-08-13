/**
 * The application shell: title bar, navigation surface, status bar.
 *
 * The shell is layout only. It holds no feature state and knows nothing about
 * which provider is configured; it mounts exactly one feature component —
 * `NavigationSurface` — which owns the sidebar, the content region and the
 * command bar, and takes the transcript surface as a slot.
 *
 * The Phase A `PlaceholderRegion` used to fill the content region. The honesty
 * readout it carried (conventions §10 — which adapter, which credential store)
 * moved to the home screen with it, so a screenshot still cannot be mistaken
 * for evidence about a real keychain.
 */

import type { ReactNode } from 'react';

import { NavigationSurface } from '@/features/navigation/NavigationSurface';

import { useHostStatus } from './use-host-status';
import { TitleBar } from './TitleBar';
import styles from './AppShell.module.css';

interface AppShellProps {
  /** The transcript surface, mounted into the content region when one is open. */
  readonly children?: ReactNode;
  /** Injectable clock, passed to recency grouping so tests are deterministic. */
  readonly now?: () => number;
}

export function AppShell({ children, now }: AppShellProps) {
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
        <NavigationSurface
          secretBackend={status.state === 'ready' ? status.info.secretBackend : null}
          {...(now === undefined ? {} : { now })}
        >
          {children}
        </NavigationSurface>
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
