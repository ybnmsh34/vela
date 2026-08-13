/**
 * Whether the host's local debug log is recording.
 *
 * ## Why this is a store and not a prop
 *
 * Two places in the UI need the same answer, and they are nowhere near each
 * other in the tree: the switch that sets it (in the endpoints panel) and every
 * failed turn in every transcript, which shows a `trace` id whose only use is
 * to be searched for in that log. Drilling a boolean from the composition root
 * into `MessageTurn` would thread it through five components that have no
 * business knowing about diagnostics.
 *
 * ## The rule it enforces
 *
 * **The pointer is shown only when it points at something.** Before the switch
 * existed, `debuglog::enable` had no caller in the application at all, and the
 * transcript printed `trace 0000000000000002` on every failure regardless — a
 * reference into a file that was never written, which reads to a user like
 * something they failed to find rather than something that does not exist.
 *
 * Per conventions §5 this holds state and actions only; the IPC lives in
 * `src/data/host-repository.ts` and is driven by `use-debug-log.ts`.
 */

import { create } from 'zustand';

/**
 * `unknown` until the host has answered. It is the honest start: the renderer
 * does not know, and a `trace` id must not be drawn on a guess in either
 * direction.
 */
export type DebugLogState = 'unknown' | 'off' | 'on';

interface DebugLogStore {
  readonly state: DebugLogState;
  /** Where the host says it writes. `null` until the host has answered. */
  readonly path: string | null;
  /** The last failure to read or move the switch, for the panel to render. */
  readonly failure: string | null;
  report: (input: { readonly enabled: boolean; readonly path: string }) => void;
  reportFailure: (message: string) => void;
}

export const useDebugLogStore = create<DebugLogStore>((set) => ({
  state: 'unknown',
  path: null,
  failure: null,
  report: ({ enabled, path }) => {
    set({ state: enabled ? 'on' : 'off', path, failure: null });
  },
  reportFailure: (message) => {
    set({ failure: message });
  },
}));

/**
 * Is the local debug log recording *right now*?
 *
 * Deliberately false while the state is `unknown`: anything gated on this is
 * pointing the user at a file, and "we have not asked yet" is not a reason to
 * promise one exists.
 */
export function isDebugLogRecording(state: DebugLogState): boolean {
  return state === 'on';
}

/** Test helper: put the store back to its initial values between renders. */
export function resetDebugLogStore(): void {
  useDebugLogStore.setState({ state: 'unknown', path: null, failure: null });
}
