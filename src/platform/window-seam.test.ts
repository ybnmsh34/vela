/**
 * The window seam, on both sides of it.
 *
 * `capabilities/main.json` has granted `core:window:allow-minimize`,
 * `allow-toggle-maximize`, `allow-is-maximized`, `allow-close` and
 * `allow-start-dragging` since Phase A, and `TitleBar.tsx` carried a comment
 * saying the controls were "deferred pending usePlatform()-mediated window
 * commands". Nothing under `src/` imported `@tauri-apps/api/window` and no
 * window command existed on the seam, so the app — which draws its own title
 * bar, `decorations: false` — had no way to minimise, maximise or close itself.
 * The permission was granted and the wire was never run: the composition-root
 * defect class again.
 *
 * This file asserts the wire. The half that matters is `TauriAdapter`: a
 * `WindowControls` whose methods resolve without touching the real window would
 * satisfy every DOM test in `src/app/shell/window-controls.test.tsx` and ship
 * three buttons that do nothing. So each method is checked to reach the object
 * `@tauri-apps/api/window` hands back, by the name Tauri's own permission
 * grants.
 */

import { describe, expect, it, vi } from 'vitest';

import { NO_WINDOW_CONTROLS } from './adapter';
import { BrowserAdapter } from './browser-adapter';
import { TauriAdapter } from './tauri-adapter';

/**
 * Hoisted so the `vi.mock` factory below — which vitest lifts to the top of the
 * file — can reach it without a temporal-dead-zone crash.
 */
const host = vi.hoisted(() => {
  const calls: string[] = [];
  const resized = new Set<() => void>();
  const win = {
    maximized: false,
    minimize: async (): Promise<void> => {
      calls.push('minimize');
    },
    toggleMaximize: async (): Promise<void> => {
      calls.push('toggleMaximize');
      win.maximized = !win.maximized;
    },
    isMaximized: async (): Promise<boolean> => {
      calls.push('isMaximized');
      return win.maximized;
    },
    close: async (): Promise<void> => {
      calls.push('close');
    },
    onResized: async (handler: () => void): Promise<() => void> => {
      calls.push('onResized');
      resized.add(handler);
      return () => {
        calls.push('unlisten');
        resized.delete(handler);
      };
    },
  };
  return { calls, resized, win };
});

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => host.win,
}));

describe('TauriAdapter.window reaches the real window', () => {
  it('routes every control to the window @tauri-apps/api hands back', async () => {
    host.calls.length = 0;
    host.win.maximized = false;
    const adapter = new TauriAdapter();

    await adapter.window.minimize();
    expect(host.calls).toEqual(['minimize']);

    await adapter.window.toggleMaximize();
    // The state the *window* holds moved. An adapter that resolved without
    // calling through would leave this false and every screen in the app would
    // still claim the window was restored.
    expect(host.win.maximized).toBe(true);

    expect(await adapter.window.isMaximized()).toBe(true);
    host.win.maximized = false;
    expect(await adapter.window.isMaximized()).toBe(false);

    await adapter.window.close();
    expect(host.calls).toEqual([
      'minimize',
      'toggleMaximize',
      'isMaximized',
      'isMaximized',
      'close',
    ]);
  });

  it('subscribes to the window resizing, and unsubscribes', async () => {
    host.calls.length = 0;
    const adapter = new TauriAdapter();
    let seen = 0;

    const stop = await adapter.window.onResized(() => {
      seen += 1;
    });
    expect(host.resized.size).toBe(1);

    for (const handler of host.resized) handler();
    expect(seen).toBe(1);

    stop();
    expect(host.resized.size).toBe(0);
    expect(host.calls).toEqual(['onResized', 'unlisten']);
  });
});

describe('BrowserAdapter.window is inert', () => {
  it('answers every control without a window to control', async () => {
    const adapter = new BrowserAdapter();

    // A browser tab has no window in this sense. These must resolve rather
    // than throw: the title bar is one component in both runtimes, and a
    // rejection here would surface as a broken control in `pnpm dev`.
    await expect(adapter.window.minimize()).resolves.toBeUndefined();
    await expect(adapter.window.toggleMaximize()).resolves.toBeUndefined();
    await expect(adapter.window.close()).resolves.toBeUndefined();

    // Never "maximised": claiming a state a browser cannot have would put the
    // restore icon on screen in every headless screenshot this project takes.
    expect(await adapter.window.isMaximized()).toBe(false);
    // ...and it stays false however many times the window is "toggled".
    await adapter.window.toggleMaximize();
    expect(await adapter.window.isMaximized()).toBe(false);

    const stop = await adapter.window.onResized(() => {
      throw new Error('a browser window never reports a resize through this seam');
    });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('shares the one inert implementation rather than reimplementing it', () => {
    // Three no-op methods copied into a test fake drift from the three in the
    // adapter. There is one, it is exported, and the fakes use it.
    //
    // The first line is not decoration: `undefined === undefined` is true, so
    // without it this assertion passes on a seam that has no window controls at
    // all — which is exactly the state this commit was written to end.
    expect(typeof NO_WINDOW_CONTROLS).toBe('object');
    expect(new BrowserAdapter().window).toBe(NO_WINDOW_CONTROLS);
  });
});
