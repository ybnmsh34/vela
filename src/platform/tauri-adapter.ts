/**
 * TauriAdapter — the real IPC bridge.
 *
 * **This is the only file in the entire frontend permitted to import
 * `@tauri-apps/api`.** `adapter.test.ts` enforces that with a source scan.
 *
 * The `@tauri-apps/api` modules are loaded with a dynamic `import()` so that a
 * browser build never pulls them into the bundle and never evaluates them.
 */

import type {
  EventContract,
  EventName,
  PlatformAdapter,
  Unsubscribe,
  WindowControls,
} from './adapter';
import { isAllowedCommand, type CommandName, type CommandReq, type CommandRes } from './contract';
import { PlatformError, toPlatformError } from './errors';

/**
 * The window this webview is drawn in.
 *
 * Resolved per call rather than held: the module is imported dynamically, so
 * caching the handle would mean holding a promise for a module a browser build
 * must never evaluate.
 */
async function currentWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

export class TauriAdapter implements PlatformAdapter {
  readonly kind = 'tauri' as const;

  /**
   * Tauri's own window commands, reached by the exact names
   * `src-tauri/capabilities/main.json` grants. Every one is wrapped so this
   * seam keeps its single promise: it rejects with a `PlatformError` or it
   * succeeds.
   */
  readonly window: WindowControls = {
    minimize: async () => {
      try {
        await (await currentWindow()).minimize();
      } catch (thrown) {
        throw toPlatformError(thrown, 'window:minimize');
      }
    },
    toggleMaximize: async () => {
      try {
        await (await currentWindow()).toggleMaximize();
      } catch (thrown) {
        throw toPlatformError(thrown, 'window:toggleMaximize');
      }
    },
    isMaximized: async () => {
      try {
        return await (await currentWindow()).isMaximized();
      } catch (thrown) {
        throw toPlatformError(thrown, 'window:isMaximized');
      }
    },
    close: async () => {
      try {
        await (await currentWindow()).close();
      } catch (thrown) {
        throw toPlatformError(thrown, 'window:close');
      }
    },
    onResized: async (handler) => {
      try {
        // The payload is a size. It is dropped deliberately: a size cannot say
        // whether the window is maximised, and inferring it from one would be
        // the same guess this seam exists to refuse.
        const unlisten = await (await currentWindow()).onResized(() => {
          handler();
        });
        return () => {
          unlisten();
        };
      } catch (thrown) {
        throw toPlatformError(thrown, 'window:onResized');
      }
    },
  };

  async invoke<C extends CommandName>(command: C, payload: CommandReq<C>): Promise<CommandRes<C>> {
    // Defence in depth: the host's `generate_handler!` list is the real
    // boundary, but failing here keeps a typo from ever reaching the host.
    if (!isAllowedCommand(command)) {
      throw new PlatformError('UNKNOWN_COMMAND', `command \`${command}\` is not allowlisted`, command);
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      // EVERY command is invoked with a single argument named `payload`.
      // The Rust commands declare exactly one parameter with that name; a
      // different key silently arrives as `undefined`. Do not "improve" this.
      return await invoke<CommandRes<C>>(command, { payload });
    } catch (thrown) {
      throw toPlatformError(thrown, command);
    }
  }

  async listen<E extends EventName>(
    event: E,
    handler: (payload: EventContract[E]) => void,
  ): Promise<Unsubscribe> {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen<EventContract[E]>(event, (received) => {
        handler(received.payload);
      });
      return () => {
        unlisten();
      };
    } catch (thrown) {
      throw toPlatformError(thrown, `listen:${event}`);
    }
  }
}
