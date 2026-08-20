/**
 * Whether this window is in incognito.
 *
 * Conventions §5: state and actions only, no IPC. The one host call the mode
 * needs — turning the debug log off on the way in — is
 * `disarmDebugLogForIncognito` in `src/platform/incognito-adapter.ts`, called by
 * the hook that owns the transition, exactly as `use-theme.ts` owns the theme's.
 *
 * ## What is NOT here: a transition counter
 *
 * An earlier draft of this file carried an `epoch` that incremented on every
 * transition, so that `App.tsx` could put it in the conversation surface's
 * `key` and make leaving the mode remount - an explicit, local destruction
 * mechanism. It is gone, and the reason is worth keeping: **nothing observed
 * it.** Weakening the key to a boolean, and then removing the epoch from it
 * altogether, each left `src/app/instructions-and-incognito.test.tsx` green in
 * two runs.
 *
 * The destruction is real but it is caused elsewhere. An incognito conversation
 * is an unsaved one - `store_create_conversation` is refused, so there is no row
 * to hang it on and `conversationId` is `null` - and `NavigationSurface` shows
 * the home screen rather than the transcript once the mode ends. The subtree
 * unmounts and the component state the entries live in goes with it. A counter
 * whose only job was to cause an unmount that already happens is a mechanism
 * with no reader, which is the thing RULE U is about.
 *
 * **The limit of the claim, either way.** An unmount removes the entries from
 * the React tree and drops the last reference to them. It does not zero the
 * JavaScript heap, and nothing in a renderer can: the strings live until the
 * collector runs and this process cannot force it. So the claim is "unreachable
 * from the application, and never written down", not "erased from memory". The
 * panel says that in the same terms.
 *
 * ## RULE U - what reads what is written here
 *
 * `active` is read by `App.tsx` (which wraps the adapter with
 * `createIncognitoAdapter`), by `AppShell.tsx` (the banner and the
 * `data-incognito` attribute), by `NavigationSurface.tsx` (which clears the
 * selection on a transition and fills the content region), by `Sidebar.tsx`
 * (the control's pressed state), by `use-navigation-shortcuts.ts` (the shortcut
 * toggles it) and by `StylePanel.tsx` (the switch and the explanation).
 * `debugLog` is read by `StylePanel.tsx`, which is where the sentence about the
 * debug log is shown. Nothing here is persisted, so there is nothing else to
 * name.
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
  readonly debugLog: DebugLogOutcome;
  /**
   * Enter or leave. Idempotent: setting the value it already has changes
   * nothing, so a re-render or a repeating held key cannot clear the
   * debug-log sentence out from under a session the user is still in.
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
  debugLog: null,
  setActive: (active) => {
    if (get().active === active) return;
    // `debugLog` is cleared on both transitions. Leaving, because the sentence
    // is about the session being left; entering, because the answer for *this*
    // session has not arrived yet and showing the previous one would be a stale
    // claim about a log that may since have been re-armed.
    set({ active, debugLog: null });
  },
  noteDebugLog: (outcome) => {
    if (!get().active) return;
    set({ debugLog: outcome });
  },
}));

/** Test helper: put the store back to its initial values between renders. */
export function resetIncognitoStore(): void {
  useIncognitoStore.setState({ active: false, debugLog: null });
}
