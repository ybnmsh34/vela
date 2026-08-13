/**
 * Loads the persisted sidebar layout on mount and writes it back when it
 * settles.
 *
 * The write is deliberately **not** per-frame. Dragging a resize handle
 * produces a command per pointer move, and every one of them is a SQLite write
 * on the user's disk; the value that matters is where the user let go. So the
 * store is updated live (the sidebar animates) and the host is told once the
 * value has stopped changing.
 */

import { useEffect, useMemo, useRef } from 'react';

import { createLayoutRepository } from '@/data/layout-repository';
import { usePlatform } from '@/platform/PlatformProvider';
import { useNavigationStore } from '@/state/navigation-store';

/** How long the width must hold still before it is worth a disk write. */
export const LAYOUT_SETTLE_MS = 250;

export function useSidebarLayout(settleMs: number = LAYOUT_SETTLE_MS): void {
  const adapter = usePlatform();
  const repository = useMemo(() => createLayoutRepository(adapter), [adapter]);
  const width = useNavigationStore((state) => state.sidebarWidth);
  const collapsed = useNavigationStore((state) => state.sidebarCollapsed);
  const setSidebarWidth = useNavigationStore((state) => state.setSidebarWidth);
  const setSidebarCollapsed = useNavigationStore((state) => state.setSidebarCollapsed);

  /**
   * Until the stored layout has arrived, the local values are defaults rather
   * than choices — writing them back would overwrite the user's real setting
   * with a default on every start.
   */
  const loaded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const layout = await repository.get();
        if (cancelled) return;
        setSidebarWidth(layout.sidebarWidth);
        setSidebarCollapsed(layout.sidebarCollapsed);
      } catch {
        // A layout we cannot read is not a reason to fail to draw a window.
        // The defaults already in the store are a usable answer.
      } finally {
        if (!cancelled) loaded.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repository, setSidebarWidth, setSidebarCollapsed]);

  useEffect(() => {
    if (!loaded.current) return;
    const timer = setTimeout(() => {
      void repository
        .set({ sidebarWidth: width, sidebarCollapsed: collapsed })
        .catch(() => {
          // Losing a width is a cosmetic failure. It must never surface as an
          // error dialog over the user's work.
        });
    }, settleMs);
    return () => {
      clearTimeout(timer);
    };
  }, [repository, width, collapsed, settleMs]);
}
