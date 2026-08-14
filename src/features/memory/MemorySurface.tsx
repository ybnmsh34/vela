/**
 * The mounted memory feature: nothing at all until the user opens it.
 *
 * Mounted by the composition root rather than by the sidebar that opens it,
 * because `src/features/README.md` forbids one feature importing another. The
 * sidebar sets a boolean in `src/state/memory-store.ts`; this reads it.
 * That boolean is the entire coupling between the two.
 *
 * Rendering `null` while closed is not an optimisation. `useMemory` reads the
 * host on mount, and a pane that mounted at startup would issue that read on
 * every launch whether or not the user ever looked at their memory.
 */

import { useMemoryStore } from '@/state/memory-store';

import { MemoryPanel } from './MemoryPanel';

export function MemorySurface() {
  const open = useMemoryStore((state) => state.open);
  const setOpen = useMemoryStore((state) => state.setOpen);

  if (!open) return null;
  return (
    <MemoryPanel
      onClose={() => {
        setOpen(false);
      }}
    />
  );
}
