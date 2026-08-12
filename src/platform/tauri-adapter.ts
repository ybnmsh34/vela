/**
 * TauriAdapter — the real IPC bridge.
 *
 * **This is the only file in the entire frontend permitted to import
 * `@tauri-apps/api`.** `adapter.test.ts` enforces that with a source scan.
 *
 * The `@tauri-apps/api` modules are loaded with a dynamic `import()` so that a
 * browser build never pulls them into the bundle and never evaluates them.
 */

import type { EventContract, EventName, PlatformAdapter, Unsubscribe } from './adapter';
import { isAllowedCommand, type CommandName, type CommandReq, type CommandRes } from './contract';
import { PlatformError, toPlatformError } from './errors';

export class TauriAdapter implements PlatformAdapter {
  readonly kind = 'tauri' as const;

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
