/**
 * The mounted skills feature: nothing at all until the user opens it.
 *
 * Mounted by the composition root rather than by the sidebar that opens it,
 * because `src/features/README.md` forbids one feature importing another. The
 * sidebar sets a boolean in `src/state/skills-store.ts`; this reads it. That
 * boolean is the entire coupling between the two.
 *
 * Rendering `null` while closed is not an optimisation. `useSkills` reads the
 * host on mount, and a pane that mounted at startup would enumerate the skill
 * store on every launch whether or not the user ever looked at it.
 */

import { useSkillsStore } from '@/state/skills-store';

import { SkillsPanel } from './SkillsPanel';

export function SkillsSurface() {
  const open = useSkillsStore((state) => state.open);
  const setOpen = useSkillsStore((state) => state.setOpen);

  if (!open) return null;
  return (
    <SkillsPanel
      onClose={() => {
        setOpen(false);
      }}
    />
  );
}
