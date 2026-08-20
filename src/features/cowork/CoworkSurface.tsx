/**
 * The mounted cowork feature: nothing at all until the user opens it.
 *
 * The same shape as `src/features/memory/MemorySurface.tsx` and the three panes
 * beside it, and for the same two reasons. Mounted by the composition root
 * rather than by the sidebar that opens it, because `src/features/README.md`
 * forbids one feature importing another — the sidebar sets a boolean in
 * `src/state/cowork-store.ts` and this reads it. And rendering `null` while
 * closed keeps `project_layout` and `mcp_list_tools` off every launch in which
 * the user never opens the dock. That second half matters more here than in the
 * other four panes: **reading a project layout repairs**, so a dock that read on
 * mount would be a write on every launch.
 */

import type { HarnessRuntime } from '@/platform/contract-harness';
import type { ProjectId } from '@/platform/contract-project';
import { useCoworkStore } from '@/state/cowork-store';

import { CoworkDock } from './CoworkPanel';

interface CoworkSurfaceProps {
  /**
   * Built once at the composition root and handed down, per
   * `HarnessRuntime` in `src/platform/contract-harness.ts`. Nullable so the
   * surface can be rendered without one; a dock with no runtime shows a plan
   * that nothing advances, which is what a user sees before starting a task.
   */
  readonly runtime: HarnessRuntime | null;
  readonly projectId: ProjectId | null;
}

export function CoworkSurface({ runtime, projectId }: CoworkSurfaceProps) {
  const open = useCoworkStore((state) => state.open);
  const setOpen = useCoworkStore((state) => state.setOpen);

  if (!open) return null;
  return (
    <CoworkDock
      runtime={runtime}
      projectId={projectId}
      onClose={() => {
        setOpen(false);
      }}
    />
  );
}
