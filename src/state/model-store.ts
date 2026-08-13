/**
 * Which endpoint and model the next turn goes to.
 *
 * Cross-component by necessity: the switcher sets it, the composer's affordances
 * are gated on it, the context meter measures against it, and the attachment
 * tray decides whether images are even offerable from it. A `useState` in one of
 * them would leave the other three guessing.
 *
 * Conventions §5: state and actions only, **no IPC**. Capability reports are
 * fetched by `use-model-selection.ts` and set here; nothing in this file calls
 * an adapter.
 *
 * ## Why `switchedMidConversation` exists
 *
 * Changing model between turns is not a neutral act. The new endpoint has not
 * seen the conversation — it will be re-sent the transcript, it may have a
 * smaller window than the transcript already fills, and it may not support what
 * the previous one did. So a switch that happens while a conversation has
 * history is *recorded*, and the UI states the consequences once rather than
 * letting the user discover them from a refused turn.
 */

import { create } from 'zustand';

import { NO_CAPABILITIES, type ChatCapabilities, type ModelCapabilityReport } from '@/platform/contract';

/** A chosen endpoint-and-model pair. Both ids are the user's own, never a vendor's. */
export interface ModelSelection {
  readonly providerId: string;
  readonly modelId: string;
  /** How the user named the endpoint. Display only. */
  readonly providerLabel: string;
  /** How the endpoint (or the user) names the model. Display only. */
  readonly modelLabel: string;
}

interface ModelState {
  readonly selection: ModelSelection | null;
  /**
   * What the chosen model demonstrated. `null` until a report has been
   * fetched — and until then the UI must use {@link NO_CAPABILITIES}, because
   * "we have not asked yet" and "it supports nothing" must produce the same
   * affordances: none.
   */
  readonly report: ModelCapabilityReport | null;
  /**
   * The previous selection, kept only while its consequences are unacknowledged.
   * `null` at rest.
   */
  readonly switchedFrom: ModelSelection | null;

  select: (selection: ModelSelection, options?: { readonly hasHistory?: boolean }) => void;
  setReport: (report: ModelCapabilityReport | null) => void;
  acknowledgeSwitch: () => void;
  clear: () => void;
}

export const useModelStore = create<ModelState>((set, get) => ({
  selection: null,
  report: null,
  switchedFrom: null,

  select: (selection, options) => {
    const previous = get().selection;
    const isSame =
      previous !== null &&
      previous.providerId === selection.providerId &&
      previous.modelId === selection.modelId;
    if (isSame) return;

    set({
      selection,
      // Dropped, not kept: a report belongs to one model. Carrying the old one
      // for even a frame would offer the new model affordances it never
      // demonstrated, which is exactly the failure the capability system exists
      // to prevent.
      report: null,
      switchedFrom:
        previous !== null && options?.hasHistory === true ? previous : null,
    });
  },

  setReport: (report) => {
    // A report that arrived for a selection the user has already moved on from
    // is stale and must not be applied — otherwise a slow probe can hand the
    // new model the old one's flags.
    const selection = get().selection;
    if (
      report !== null &&
      (selection === null ||
        selection.providerId !== report.providerId ||
        selection.modelId !== report.modelId)
    ) {
      return;
    }
    set({ report });
  },

  acknowledgeSwitch: () => set({ switchedFrom: null }),
  clear: () => set({ selection: null, report: null, switchedFrom: null }),
}));

/**
 * Test helper. Zustand stores are module singletons, so one test's selection
 * would otherwise become the next test's starting state.
 */
export function resetModelStore(): void {
  useModelStore.setState({ selection: null, report: null, switchedFrom: null });
}

/**
 * The capability struct the UI branches on.
 *
 * The one place the "no report yet means offer nothing" rule is written down.
 * Every affordance reads this, so there is no path by which a component can
 * accidentally treat an absent report as permission.
 */
export function capabilitiesOf(report: ModelCapabilityReport | null): ChatCapabilities {
  return report?.capabilities ?? NO_CAPABILITIES;
}
