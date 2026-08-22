/**
 * Client state for projects: which one the window is in, and whether the pane
 * that changes it is up.
 *
 * Rules from conventions §5, followed here: state and actions only, **no IPC**.
 * The projects themselves are not held here — they are read from the host by
 * whoever needs them, for the reason `src/state/memory-store.ts` gives: a cached
 * copy in a store is a cache with no invalidation story and two readers who
 * disagree.
 *
 * ## Why the selection lives here and not in the composition root
 *
 * Because three things need it and none of them may import another
 * (`src/features/README.md`): the sidebar opens the pane, the pane switches the
 * project, and the composition root hands the id to the conversation surface so
 * a run carries the right project's instructions. Shared state is the only seam
 * those three are allowed to meet at.
 *
 * ## `null` is "not known yet", and it is never "the default one"
 *
 * There is no seed value, and that is the whole point of this file existing.
 * `src/app/App.tsx` used to pass `DEFAULT_PROJECT_ID` literally, so every
 * conversation in every project ran as though it were in the default one — a
 * defect that is invisible while a user has one project and silent once they
 * have two. The id now comes from the host (`project_list`, the summary flagged
 * `isDefault`) and `null` is the state before that read has landed.
 * `contract-project.ts` is explicit that nothing under `src/` should decide for
 * itself what the default project is, and a seeded initial value here would be
 * exactly that decision wearing a different hat.
 */

import { create } from 'zustand';

import type { ProjectId } from '@/platform/contract-project';

interface ProjectUiState {
  /** Whether the projects pane is up. */
  readonly open: boolean;
  /**
   * The project every run in this window belongs to, or `null` before the host
   * has been asked which projects exist.
   */
  readonly selectedProjectId: ProjectId | null;
  setOpen: (open: boolean) => void;
  select: (projectId: ProjectId) => void;
}

export const useProjectStore = create<ProjectUiState>((set) => ({
  open: false,
  selectedProjectId: null,
  setOpen: (open) => set({ open }),
  select: (projectId) => set({ selectedProjectId: projectId }),
}));

/** Test helper: put the store back to its initial values between renders. */
export function resetProjectStore(): void {
  useProjectStore.setState({ open: false, selectedProjectId: null });
}
