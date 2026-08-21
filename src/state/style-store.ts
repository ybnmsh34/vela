/**
 * Client state for the style and instructions the user has chosen for this
 * window: which built-in style, what they typed, and whether the pane is up.
 *
 * Conventions §5, followed here: state and actions only, **no IPC**. That rule
 * is not a formality in this file — it is the reason the values below are
 * honest about their lifetime. `src/state/theme-store.ts` records what happened
 * the last time a store held a persisted setting it could not persist: the
 * title bar called `cyclePreference`, the choice went no further than the
 * object, and `settings_set_theme` sat there with no caller in the renderer.
 *
 * ## THESE VALUES DO NOT SURVIVE A RESTART, AND NOTHING HERE PRETENDS THEY DO
 *
 * There is no host command that can store them. `SettingsSnapshot` in
 * `src/platform/contract.ts` carries `theme`, `telemetryEnabled`,
 * `credentialBackend`, `providers` and `protocols`; `settings_set_theme` is the
 * only setter besides the provider ones, and `COMMAND_ALLOWLIST` has no generic
 * key-value command. Storing them therefore needs a new command on **both**
 * sides of `invoke` — `src-tauri/src/ipc/mod.rs`'s
 * `rust_and_typescript_allowlists_are_identical` fails a build where only one
 * side has it — which is Rust this track was told not to build.
 *
 * The two alternatives were rejected on the merits rather than for want of time:
 *
 * - **`localStorage`.** `src/data/layout-repository.ts` states the standing rule
 *   — "Vela's system of record is the user's own database, and a sidebar width
 *   kept in webview storage lives somewhere the user cannot back up and the
 *   browser profile can clear". The user's own standing instructions are a
 *   stronger case for that rule, not a weaker one. It would also put a durable
 *   write outside `PlatformAdapter.invoke`, which is the one seam
 *   `src/platform/incognito-adapter.ts` can police — so the same commit that
 *   added it would have punched the hole through incognito.
 * - **Filing them as the default project's `instructions`.** They would then be
 *   *the* project instructions, so the precedence this feature exists to
 *   resolve would have nothing on either side of it.
 *
 * So: session-scoped, and `StylePanel` says so where the user types, in the same
 * words.
 *
 * ## RULE U — what reads each of these
 *
 * `styleId` and `customInstructions` are read in exactly two places.
 * `src/features/conversation/use-conversation.ts` selects both and turns them
 * into the text a turn carries — through `composeInstructionText` for the
 * ordinary send, and through the same function again for
 * `RunContextRequest.systemPrompt` on an agent run. `StylePanel.tsx` selects
 * both to draw the picker and the box and to resolve the layer view. `open` is
 * read by `StylesSurface.tsx`, which mounts the pane, and written by
 * `Sidebar.tsx`. Nothing else selects from this store, and nothing persists any
 * of it — so there is no stored column here whose reader could go missing.
 */

import { create } from 'zustand';

import { DEFAULT_STYLE_ID, type StyleId } from '@/lib/instruction-layers';

/**
 * The length at which `StylePanel` tells the user their instructions are too
 * long.
 *
 * **It is not a ceiling and nothing clamps to it**, which is what this comment
 * used to claim. The textarea carries no `maxLength`, this store keeps whatever
 * it is handed, and `composeInstructionText` sends the whole of it: over-length
 * text raises a `role="status"` line in the pane and then goes out in full. The
 * previous wording — "the ceiling on what the box accepts" — described a
 * mechanism that is not in this tree.
 *
 * Left as a warning rather than made into a real limit on purpose. There is no
 * host validation behind these instructions to fail against — they are
 * session-only, and `COMMAND_ALLOWLIST` has no command that could store them —
 * so the only thing a hard limit could do is silently drop words the user typed,
 * which is worse than sending them and saying the block is large. The context
 * meter is the other half of that answer: `use-conversation.ts` counts this
 * text against the window, so a user who ignores the warning watches the cost.
 *
 * The number is not arbitrary and not picked here: it is
 * `PROJECT_INSTRUCTIONS_MAX_CHARS` from `src/platform/contract-project.ts`, the
 * bound the host already imposes on the other body of instructions a turn can
 * carry. A second, different number would mean two answers to "how much may a
 * user write" in one prompt.
 */
export { PROJECT_INSTRUCTIONS_MAX_CHARS as INSTRUCTIONS_MAX_CHARS } from '@/platform/contract-project';

interface StyleState {
  readonly styleId: StyleId;
  /** Exactly what the user typed, untrimmed. Trimming happens at resolution. */
  readonly customInstructions: string;
  /** Whether the styles pane is up. */
  readonly open: boolean;
  setStyleId: (styleId: StyleId) => void;
  setCustomInstructions: (text: string) => void;
  setOpen: (open: boolean) => void;
}

export const useStyleStore = create<StyleState>((set) => ({
  styleId: DEFAULT_STYLE_ID,
  customInstructions: '',
  open: false,
  setStyleId: (styleId) => set({ styleId }),
  setCustomInstructions: (customInstructions) => set({ customInstructions }),
  setOpen: (open) => set({ open }),
}));

/** Test helper: put the store back to its initial values between renders. */
export function resetStyleStore(): void {
  useStyleStore.setState({ styleId: DEFAULT_STYLE_ID, customInstructions: '', open: false });
}
