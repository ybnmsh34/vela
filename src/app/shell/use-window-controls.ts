/**
 * The window's own controls, joined to the window.
 *
 * ## The defect this closes
 *
 * `tauri.conf.json` sets `decorations: false`, so the title bar this app draws
 * *is* the window's title bar. `capabilities/main.json` had granted
 * `core:window:allow-minimize`, `allow-toggle-maximize`, `allow-is-maximized`,
 * `allow-close` and `allow-start-dragging` since Phase A, and `TitleBar.tsx`
 * carried a comment saying the buttons were deferred "pending usePlatform()-
 * mediated window commands". Nothing under `src/` ever imported
 * `@tauri-apps/api/window` and no window command existed on the seam, so a
 * shipping desktop app had no way to minimise, maximise or close itself. Alt+F4
 * and the taskbar still worked, which is why it survived this long.
 *
 * Same shape as the theme button, the context meter and the debug log: correct
 * parts, no joint. The joint belongs in the shell, which is what mounts the bar.
 *
 * ## The one rule here
 *
 * **`maximized` is read from the window; it is never inferred from a click.**
 * A `toggleMaximize()` that resolves has not promised the window moved — a size
 * constraint or the window manager can refuse it, and the same call is how the
 * window gets *restored*, so "the user clicked, therefore it is maximised now"
 * is wrong in both directions. Every path here ends in `isMaximized()`:
 *
 *  - at mount, before anything is clicked, because the app can be launched onto
 *    a window the session manager already maximised;
 *  - after every toggle, whether it resolved or threw;
 *  - on every resize the window reports, which is how Win+Up, a snap, a drag to
 *    the top of the screen and a monitor change get onto the icon.
 *
 * A failed read keeps the last state that was actually read. Falling back to
 * `false` would put a *maximise* icon on a maximised window the first time the
 * host hiccuped.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { Unsubscribe } from '@/platform/adapter';
import { usePlatform } from '@/platform/PlatformProvider';

export interface WindowController {
  /** What the window last said. Never what a click implied. */
  readonly maximized: boolean;
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
}

export function useWindowControls(): WindowController {
  const controls = usePlatform().window;
  const [maximized, setMaximized] = useState(false);
  const mounted = useRef(true);

  const reread = useCallback(async () => {
    try {
      const actual = await controls.isMaximized();
      if (mounted.current) setMaximized(actual);
    } catch {
      // Keep the last answer the window gave. A guess here is the whole defect.
    }
  }, [controls]);

  useEffect(() => {
    mounted.current = true;
    let stop: Unsubscribe | null = null;
    let dropped = false;

    void reread();
    void controls
      .onResized(() => {
        void reread();
      })
      .then((unsubscribe) => {
        // The effect can be torn down before this resolves — StrictMode does it
        // on every mount — and an unsubscribe that arrives after that must not
        // be dropped on the floor, or the handler outlives the component.
        if (dropped) unsubscribe();
        else stop = unsubscribe;
      })
      .catch(() => {
        // No resize channel: the icon still tracks mount and every toggle.
      });

    return () => {
      mounted.current = false;
      dropped = true;
      stop?.();
    };
  }, [controls, reread]);

  const minimize = useCallback(() => {
    void controls.minimize().catch(() => {
      // Nothing to say: the window is either minimised or it is not, and the
      // user can see which. There is no state here to put back.
    });
  }, [controls]);

  const toggleMaximize = useCallback(() => {
    void (async () => {
      try {
        await controls.toggleMaximize();
      } catch {
        // Fall through: the re-read below is what decides the icon either way.
      }
      await reread();
    })();
  }, [controls, reread]);

  const close = useCallback(() => {
    void controls.close().catch(() => {
      // A refused close leaves the window open, which is visible on its own.
    });
  }, [controls]);

  return { maximized, minimize, toggleMaximize, close };
}
