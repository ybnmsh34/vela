/**
 * Client state for the MCP servers pane: whether it is up. That is the whole
 * store.
 *
 * Conventions §5, kept the way `src/state/skills-store.ts` and
 * `src/state/schedules-store.ts` keep it: state and actions only, **no IPC**,
 * and none of the servers themselves. The tool lists are read from the host by
 * the pane that shows them. A cached copy here would be a second opinion about
 * a set of child processes that start, answer, die and get replaced without the
 * renderer being told — `src-tauri/src/ipc/mcp.rs` says the push half (a server
 * announcing that its tools changed) is handled inside `vela-mcp` by
 * invalidating a cache, so the truth is whatever the next call answers.
 *
 * ## Why a store for one boolean
 *
 * Because the control that opens the pane lives in `src/features/navigation/`
 * and the pane lives in `src/features/mcp/`, and `src/features/README.md`
 * forbids one feature importing another. The sidebar sets this; the composition
 * root mounts the pane, which reads it. That boolean is the entire coupling
 * between the two.
 *
 * There is deliberately no revision counter beside it, for the reason
 * `schedules-store.ts` states: nothing outside this pane reads an MCP server,
 * so a counter here would be a signal with no listener — the defect class this
 * wave exists to remove rather than one to add. Re-reading is what closing and
 * reopening the pane does, because `McpSurface` unmounts it.
 */

import { create } from 'zustand';

interface McpUiState {
  readonly open: boolean;
  setOpen: (open: boolean) => void;
}

export const useMcpStore = create<McpUiState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/** Test helper: put the store back to its initial value between renders. */
export function resetMcpStore(): void {
  useMcpStore.setState({ open: false });
}
