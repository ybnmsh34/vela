/**
 * The mounted projects feature: nothing at all until the user opens it.
 *
 * The same shape as `src/features/memory/MemorySurface.tsx`, and for the same
 * two reasons. Mounted by the composition root rather than by the sidebar that
 * opens it, because `src/features/README.md` forbids one feature importing
 * another — the sidebar sets a boolean in `src/state/project-store.ts` and this
 * reads it. And rendering `null` while closed keeps `useProjects`'s reads off
 * every launch in which the user never looks at their projects.
 *
 * What is *not* here is the read that establishes which project the window is
 * in. That one runs whether or not the pane is ever opened, because every agent
 * run depends on it, so it lives in `useActiveProjectId` and is called by the
 * composition root.
 */

import { useProjectStore } from '@/state/project-store';

import { ProjectPanel } from './ProjectPanel';

export function ProjectsSurface() {
  const open = useProjectStore((state) => state.open);
  const setOpen = useProjectStore((state) => state.setOpen);

  if (!open) return null;
  return (
    <ProjectPanel
      onClose={() => {
        setOpen(false);
      }}
    />
  );
}
