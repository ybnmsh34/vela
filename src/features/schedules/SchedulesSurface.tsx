/**
 * The mounted schedules feature: nothing at all until the user opens it.
 *
 * Mounted by the composition root rather than by the sidebar that opens it,
 * because `src/features/README.md` forbids one feature importing another. The
 * sidebar sets a boolean in `src/state/schedules-store.ts`; this reads it. That
 * boolean is the entire coupling between the two.
 *
 * Rendering `null` while closed is not an optimisation. `useSchedules` reads the
 * host on mount, and a pane that mounted at startup would issue that read on
 * every launch whether or not the user ever opened it — the same rule
 * `src/features/memory/MemorySurface.tsx` keeps, for the same reason.
 */

import { useSchedulesStore } from '@/state/schedules-store';

import { SchedulesPanel } from './SchedulesPanel';

export function SchedulesSurface() {
  const open = useSchedulesStore((state) => state.open);
  const setOpen = useSchedulesStore((state) => state.setOpen);

  if (!open) return null;
  return (
    <SchedulesPanel
      onClose={() => {
        setOpen(false);
      }}
    />
  );
}
