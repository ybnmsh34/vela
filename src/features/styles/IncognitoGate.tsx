/**
 * THE SEAM THAT MAKES INCOGNITO REAL.
 *
 * Everything below this component reaches the host through `usePlatform()`.
 * While the mode is on, what `usePlatform()` answers is
 * `createIncognitoAdapter(real)` — the wrapper in
 * `src/platform/incognito-adapter.ts` that refuses every command classified
 * `writes`. A `PlatformProvider` nested inside another overrides it for its own
 * subtree, which is the whole mechanism: no feature has to know this exists, and
 * no feature can go around it, because there is no other way to `invoke`.
 *
 * ## Why the disarm is an effect here and not part of the toggle
 *
 * `disarmDebugLogForIncognito` has to run on the **unwrapped** adapter: arming
 * and disarming the log are the same command, `diagnostics_debug_log_set`, and
 * the wrapper refuses it. This component sits above its own provider, so the
 * adapter it holds is the real one; the sidebar button and the keyboard handler
 * sit below and hold the wrapped one. That is the correct arrangement and not a
 * workaround — the code that suspends the guard should be outside the guard.
 *
 * **The window this leaves open, stated rather than glossed.** The flag flips
 * synchronously; the disarm is a round trip. For those few milliseconds the log
 * is still armed. What can be recorded in them is a turn that was *already
 * streaming when the user entered*, which was already being recorded a moment
 * earlier — incognito does not retract what happened before it. Nothing new can
 * start in that window, because starting one takes a user action.
 *
 * ## Why the runtime below this is rebuilt
 *
 * `App.tsx` builds the agent runtime with `useMemo(..., [adapter])`. Toggling
 * the mode changes the adapter's identity, so the runtime — and with it the live
 * run directory — is rebuilt. That is wanted in both directions: a run started
 * in the ordinary window must not continue writing its transcript into an
 * incognito one, and a run started in incognito must not survive the exit.
 */

import { useEffect, useMemo, type ReactNode } from 'react';

import { PlatformProvider, usePlatform } from '@/platform/PlatformProvider';
import { createIncognitoAdapter, disarmDebugLogForIncognito } from '@/platform/incognito-adapter';
import { useIncognitoStore } from '@/state/incognito-store';

export function IncognitoGate({ children }: { readonly children: ReactNode }): ReactNode {
  const real = usePlatform();
  const active = useIncognitoStore((state) => state.active);
  const epoch = useIncognitoStore((state) => state.epoch);
  const noteDebugLog = useIncognitoStore((state) => state.noteDebugLog);

  useEffect(() => {
    if (!active) return;
    let live = true;
    void disarmDebugLogForIncognito(real).then((outcome) => {
      if (live) noteDebugLog(outcome);
    });
    return () => {
      live = false;
    };
    // `epoch` is a dependency so that re-entering the mode asks again. Without
    // it, leave-then-enter would keep the answer from the first entry, and the
    // log may have been re-armed in between.
  }, [active, epoch, real, noteDebugLog]);

  const adapter = useMemo(
    () => (active ? createIncognitoAdapter(real) : real),
    [active, real],
  );

  return <PlatformProvider adapter={adapter}>{children}</PlatformProvider>;
}
