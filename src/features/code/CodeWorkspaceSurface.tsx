/**
 * The mounted code workspace: nothing at all until the user opens it.
 *
 * Mounted by the composition root rather than by the sidebar that opens it,
 * because `src/features/README.md` forbids one feature importing another. The
 * sidebar sets a boolean in `src/state/code-workspace-store.ts`; this reads it.
 * That boolean is the entire coupling between the two — the same seam the
 * memory, skills, schedules and projects surfaces use, for the same reason.
 *
 * Rendering `null` while closed is not an optimisation. The setup form reads the
 * configured endpoints from the host on mount, and a workspace that mounted at
 * start-up would run `settings_get` on every launch whether or not the user ever
 * opened it.
 */

import { useCodeWorkspaceStore } from '@/state/code-workspace-store';

import { CodeWorkspace } from './CodeWorkspace';

export function CodeWorkspaceSurface() {
  const open = useCodeWorkspaceStore((state) => state.open);
  const setOpen = useCodeWorkspaceStore((state) => state.setOpen);

  if (!open) return null;
  return (
    <CodeWorkspace
      onClose={() => {
        setOpen(false);
      }}
    />
  );
}
