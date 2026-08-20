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
import { useIncognitoStore } from '@/state/incognito-store';

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
  const incognito = useIncognitoStore((state) => state.active);

  const dotClass =
    status.state === 'ready'
      ? `${styles.dot} ${styles.dotOk}`
      : status.state === 'error'
        ? `${styles.dot} ${styles.dotWarn}`
        : styles.dot;

  return (
    <div className={styles.shell} data-incognito={incognito ? 'on' : 'off'}>
      {/*
        THE INDICATION, and why there are three of it.

        A privacy mode a user can be in without knowing is worse than no privacy
        mode, so "is it visible" is not the question — "can a person be in this
        mode and not know" is. Three answers, each covering a way the others are
        missed:

        1. This band. Painted, and `role="status"` so a screen reader announces
           the change when it appears rather than only when something happens to
           read it.
        2. `data-incognito` on the shell, which draws a ring at every edge of the
           window. A band at the top leaves peripheral vision when the eye is on
           a pane; an edge does not.
        3. The status line below, which is the one thing on screen that is
           always about the state of the application rather than the content.

        None of the three is a colour value this commit introduced. The band
        paints `--vela-warning` on `--vela-warning-bg`, the pair `AttachmentTray`
        already uses and `src/styles/contrast.test.ts` already measures in both
        themes.
      */}
      {incognito && (
        <div className={styles.incognitoBanner} role="status" data-testid="incognito-banner">
          Incognito · nothing from this window is being saved on this machine
        </div>
      )}
      <TitleBar context={incognito ? 'Incognito window' : 'Untitled workspace'} />

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
        <span data-testid="privacy-line">
          {incognito ? 'Incognito · not saved' : 'Offline · no telemetry'}
        </span>
      </footer>
    </div>
  );
}
