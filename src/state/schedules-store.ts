/**
 * Client state for schedules: whether the pane is up. Nothing else.
 *
 * Conventions §5, followed the way `src/state/memory-store.ts` follows it: state
 * and actions only, **no IPC**, and none of the schedules themselves. They are
 * read from the host by whoever needs them, because a cached copy in a store is
 * a cache with no invalidation story — and here it would be a worse one than
 * usual, since the host's poll thread moves a schedule's next slot without the
 * renderer being told.
 *
 * The boolean is here rather than inside either feature because the sidebar sets
 * it and the pane reads it, and `src/features/README.md` forbids one feature
 * importing another. It is the entire coupling between those two.
 *
 * There is deliberately no revision counter beside it. `memory-store.ts` carries
 * one because an open conversation has to re-read memory when it changes;
 * nothing outside this pane reads a schedule, so a counter here would be a
 * signal with no listener, which is the defect class this wave exists to remove
 * rather than one to add.
 */

import { create } from 'zustand';

interface SchedulesUiState {
  readonly open: boolean;
  setOpen: (open: boolean) => void;
}

export const useSchedulesStore = create<SchedulesUiState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/** Test helper: put the store back to its initial value between renders. */
export function resetSchedulesStore(): void {
  useSchedulesStore.setState({ open: false });
}
