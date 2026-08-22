/**
 * Client state for memory: whether the pane is up, and a revision counter.
 *
 * Rules from conventions §5, followed here: state and actions only, **no IPC**.
 * The entries themselves are not held here — they are read from the host by
 * whoever needs them, because a cached copy in a store is a cache with no
 * invalidation story and two readers who disagree about what is remembered.
 *
 * ## Why both fields are here rather than in the features that use them
 *
 * Because two different features need each, and `src/features/README.md`
 * forbids one feature importing another.
 *
 * `open` is set by the sidebar (a navigation control) and read by the memory
 * pane (mounted by the composition root). A boolean in shared state is the only
 * seam those two are allowed to meet at.
 *
 * `revision` exists for a defect this store was added to fix. The conversation
 * surface reads memory **once, on mount**, and a user who writes a memory while
 * a conversation is open would otherwise not see it applied until they switched
 * conversations and back — the write appearing to work while changing nothing
 * about the next answer. Every successful memory mutation bumps this, and the
 * conversation's read depends on it, so "I told it to remember that" and "it
 * knows that" cannot come apart.
 */

import { create } from 'zustand';

interface MemoryUiState {
  readonly open: boolean;
  /**
   * Increments on every successful write. Nothing may read it as a count of
   * anything — it is a change signal, and its only correct use is as a
   * dependency.
   */
  readonly revision: number;
  setOpen: (open: boolean) => void;
  noteChanged: () => void;
}

export const useMemoryStore = create<MemoryUiState>((set, get) => ({
  open: false,
  revision: 0,
  setOpen: (open) => set({ open }),
  noteChanged: () => set({ revision: get().revision + 1 }),
}));

/** Test helper: put the store back to its initial values between renders. */
export function resetMemoryStore(): void {
  useMemoryStore.setState({ open: false, revision: 0 });
}
