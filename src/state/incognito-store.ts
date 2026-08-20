/**
 * Whether this window is in incognito, and the counter that makes leaving it
 * destroy what it held.
 *
 * Conventions §5: state and actions only, no IPC. The one host call the mode
 * needs — turning the debug log off on the way in — is
 * `disarmDebugLogForIncognito` in `src/platform/incognito-adapter.ts`, called by
 * the hook that owns the transition, exactly as `use-theme.ts` owns the theme's.
 *
 * ## The epoch, and what it is for
 *
 * A privacy mode has to answer "does leaving destroy what it held?" with
 * something better than an intention. {@link IncognitoState.epoch} increments on
 * **every** transition, in and out. `src/app/App.tsx` puts it in the `key` of
 * the conversation surface, so entering and leaving both remount it, and a
 * remount discards the component state the transcript lives in — the same
 * mechanism the composition root already relies on to stop one conversation's
 * streaming state attaching to the next.
 *
 * It increments on the way *in* as well, which is deliberate: whatever was on
 * screen before the user asked for privacy must not be carried into the private
 * session either. Entering with a half-written exchange still visible would make
 * the first thing in the incognito window a thing from the ordinary one.
 *
 * **The limit of that proof.** A remount removes the entries from the React
 * tree and drops the last reference to them. It does not zero the JavaScript
 * heap, and nothing in a renderer can: the strings live until the collector runs
 * and this process cannot force it. So the claim is "unreachable from the
 * application, and never written down", not "erased from memory". The panel
 * says that in the same terms.
 *
 * ## RULE U — what reads what is written here
 *
 * `active` is read by `App.tsx` (which wraps the adapter with
 * `createIncognitoAdapter` and keys the surface), by `AppShell.tsx` (the banner
 * and the `data-incognito` attribute), by `Sidebar.tsx` (the control's pressed
 * state), by `use-navigation-shortcuts.ts` (the shortcut toggles it) and by
 * `StylePanel.tsx` (the switch and the explanation). `epoch` is read by
 * `App.tsx` and by nothing else. `debugLog` is read by `StylePanel.tsx`, which
 * is where the sentence about the debug log is shown. Nothing here is persisted,
 * so there is nothing else to name.
 */

import { create } from 'zustand';

import type { DebugLogDisarm } from '@/platform/incognito-adapter';

/**
 * What happened to the host's debug log when the mode was entered, or `null`
 * for "not entered, or nothing to say".
 *
 * Carried in the store rather than in the component that made the call because
 * the sentence outlives the click: a user who enters incognito from the
 * keyboard and opens the pane a minute later still needs to be told that their
 * provider-traffic log was switched off.
 */
export type DebugLogOutcome = DebugLogDisarm | null;

interface IncognitoState {
  readonly active: boolean;
  /** Increments on every transition, in and out. Never decreases. */
  readonly epoch: number;
  readonly debugLog: DebugLogOutcome;
  /**
   * Enter or leave. Idempotent: setting the value it already has changes
   * nothing, including the epoch, so a re-render or a duplicated key event
   * cannot destroy a session the user is still in.
   */
  setActive: (active: boolean) => void;
  /**
   * Record what happened to the host's debug log on the way in.
   *
   * Separate from {@link setActive} because the two happen at different times
   * and in different places: the flag flips synchronously wherever the user
   * pressed, and the disarm is an `invoke` that `IncognitoGate` runs afterwards
   * with the *unwrapped* adapter. Folding the outcome into `setActive` would
   * mean either making the toggle async — so a keypress could not flip a
   * boolean without awaiting the host — or having the caller of the toggle hold
   * an adapter the wrapper is supposed to have taken away from it.
   *
   * Ignored while not incognito, so a disarm that resolves after the user has
   * already left cannot post a sentence about a mode they are out of.
   */
  noteDebugLog: (outcome: DebugLogOutcome) => void;
}

export const useIncognitoStore = create<IncognitoState>((set, get) => ({
  active: false,
  epoch: 0,
  debugLog: null,
  setActive: (active) => {
    if (get().active === active) return;
    set({
      active,
      epoch: get().epoch + 1,
      // Cleared on both transitions. Leaving, because the sentence is about the
      // session being left; entering, because the answer for *this* session has
      // not arrived yet and showing the previous one would be a stale claim
      // about a log that may since have been re-armed.
      debugLog: null,
    });
  },
  noteDebugLog: (outcome) => {
    if (!get().active) return;
    set({ debugLog: outcome });
  },
}));

/** Test helper: put the store back to its initial values between renders. */
export function resetIncognitoStore(): void {
  useIncognitoStore.setState({ active: false, epoch: 0, debugLog: null });
}
