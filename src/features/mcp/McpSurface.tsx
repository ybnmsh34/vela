/**
 * The mounted MCP feature: nothing at all until the user opens it.
 *
 * Mounted by the composition root rather than by the sidebar that opens it,
 * because `src/features/README.md` forbids one feature importing another. The
 * sidebar sets a boolean in `src/state/mcp-store.ts`; this reads it. That
 * boolean is the entire coupling between the two.
 *
 * Rendering `null` while closed is not an optimisation, and here it has more
 * teeth than it does for the memory or skills panes. `useMcp` calls
 * `mcp_list_tools` on mount, and that command **spawns the user's child
 * processes** — `src-tauri/src/lib.rs` says a server is started on the first
 * `mcp_list_tools` rather than at startup. A pane that mounted at launch would
 * start every configured MCP server on every launch, whether or not the user
 * ever looked at them.
 *
 * The unmount is load-bearing in the other direction too: it is what makes
 * closing and reopening the pane a re-read, which is the only refresh this
 * surface has and the reason `src/state/mcp-store.ts` carries no revision
 * counter.
 *
 * **What that re-read does and does not pick up**, because the difference is on
 * screen. `McpPool` in `src-tauri/crates/vela-mcp/src/pool.rs` reads the
 * configuration once, when the pool is built, and holds it for the life of the
 * process — nothing watches the file and there is no reload command. So
 * reopening re-runs `mcp_list_tools`, which respawns a server that died and
 * re-asks every live one for its tools, and it does **not** notice a server the
 * user added to their file since launch. The pane says so rather than implying
 * a refresh it does not have.
 */

import { useMcpStore } from '@/state/mcp-store';

import { McpPanel } from './McpPanel';

export function McpSurface() {
  const open = useMcpStore((state) => state.open);
  const setOpen = useMcpStore((state) => state.setOpen);

  if (!open) return null;
  return (
    <McpPanel
      onClose={() => {
        setOpen(false);
      }}
    />
  );
}
