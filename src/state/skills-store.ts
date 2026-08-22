/**
 * Client state for the skills pane: whether it is up. That is the whole store.
 *
 * Rules from conventions §5, followed here: state and actions only, **no IPC**.
 * The skills themselves are not held here — they are read from the host by the
 * pane that shows them. A cached copy would be a second opinion about a set of
 * directories the user edits with their own editor, outside this application
 * and without telling it, and the host is the side that has actually read them.
 *
 * ## Why a store for one boolean
 *
 * Because the control that opens the pane and the pane itself are two different
 * features, and `src/features/README.md` forbids one feature importing another.
 * The sidebar sets this; the composition root mounts the pane, which reads it.
 * That boolean is the entire coupling between the two — the same seam
 * `src/state/memory-store.ts` documents, for the same reason.
 *
 * There is no `revision` counter here, and nothing that could bump one: the
 * renderer cannot change a skill. `src-tauri/src/ipc/skills.rs` exposes two
 * commands and both of them read. The memory store needs its counter because
 * the memory pane writes; this pane has no write to announce.
 */

import { create } from 'zustand';

interface SkillsUiState {
  readonly open: boolean;
  setOpen: (open: boolean) => void;
}

export const useSkillsStore = create<SkillsUiState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/** Test helper: put the store back to its initial values between renders. */
export function resetSkillsStore(): void {
  useSkillsStore.setState({ open: false });
}
