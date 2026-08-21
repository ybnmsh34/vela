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
import { useIncognitoStore, type DebugLogOutcome } from '@/state/incognito-store';

import { useHostStatus } from './use-host-status';
import { TitleBar } from './TitleBar';
import styles from './AppShell.module.css';

interface AppShellProps {
  /** The transcript surface, mounted into the content region when one is open. */
  readonly children?: ReactNode;
  /** Injectable clock, passed to recency grouping so tests are deterministic. */
  readonly now?: () => number;
}

/**
 * WHAT THE BAND AND THE STATUS LINE ARE ALLOWED TO SAY, PER DEBUG-LOG STATE.
 *
 * The mode's headline sentence used to be unconditional, and it was false in a
 * state a user can reach. `disarmDebugLogForIncognito` answers `'failed'` when
 * the host will not turn the provider debug log off — deliberately, so that a
 * failure does not abort entering the mode — and in that state
 * `vela_providers::debuglog` goes on writing the raw upstream request and
 * response bodies, the user's prompt and the model's answer, to a file under
 * the application-data directory. A window asserting `nothing from this window
 * is being saved on this machine` over that is the exact failure
 * `incognito-adapter.ts`'s header names: a mode a user can be wrong about is
 * worse than none.
 *
 * `null` is not the same as `'failed'` and is not treated as one. It is the
 * round trip still being in flight, which is the sub-second window the
 * `IncognitoGate` header already documents. It gets its own sentence rather
 * than borrowing either of the other two, because the honest answer for that
 * moment is that the question has not been answered yet.
 *
 * The corrective sentence used to exist only in `StylePanel.tsx`, behind a pane
 * the user has to open. It is here now because this is the surface a user
 * cannot miss, and the pane's fuller wording — what to do about it — stays
 * there.
 */
const BAND: Readonly<Record<'checking' | 'clear' | 'failed', string>> = Object.freeze({
  checking: 'Incognito · checking whether the provider debug log is on',
  clear: 'Incognito · nothing from this window is being saved on this machine',
  failed:
    'Incognito · the provider debug log could not be switched off, so your prompts and answers may still be written to this machine',
});

const PRIVACY_LINE: Readonly<Record<'checking' | 'clear' | 'failed', string>> = Object.freeze({
  checking: 'Incognito · checking',
  clear: 'Incognito · not saved',
  failed: 'Incognito · debug log still on',
});

/** Which of the three sentences this window has earned the right to show. */
export function bandState(debugLog: DebugLogOutcome): 'checking' | 'clear' | 'failed' {
  if (debugLog === null) return 'checking';
  return debugLog === 'failed' ? 'failed' : 'clear';
}

export function AppShell({ children, now }: AppShellProps) {
  const status = useHostStatus();
  const incognito = useIncognitoStore((state) => state.active);
  const debugLog = useIncognitoStore((state) => state.debugLog);
  const band = bandState(debugLog);

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

        Two of the three carry the debug-log state as well, because an
        indication that says the wrong thing is worse than one that is missed.
        See `BAND` above.
      */}
      {incognito && (
        <div
          className={styles.incognitoBanner}
          role="status"
          data-testid="incognito-banner"
          data-debug-log={band}
        >
          {BAND[band]}
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
          {incognito ? PRIVACY_LINE[band] : 'Offline · no telemetry'}
        </span>
      </footer>
    </div>
  );
}
