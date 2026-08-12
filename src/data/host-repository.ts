/**
 * DATA LAYER — repositories.
 *
 * A repository is a plain factory that closes over a {@link PlatformAdapter}
 * and exposes domain-shaped methods. Rules:
 *
 *   - No React. No hooks, no context, no component imports.
 *   - The adapter arrives as an argument. Never import a singleton.
 *   - Repositories may reshape host responses into domain types, but must not
 *     invent data the host did not send.
 *   - Errors propagate as `PlatformError`; do not swallow them into `null`.
 *
 * This is the seam that makes features testable: pass a `BrowserAdapter` (or a
 * hand-written stub adapter) and the whole repository is under test with no
 * network, no Tauri and no DOM.
 */

import type { PlatformAdapter } from '@/platform/adapter';
import { IPC_CONTRACT_VERSION, type AppInfo, type EchoRes } from '@/platform/contract';
import { PlatformError } from '@/platform/errors';

export interface HostRepository {
  /** Identity of the host process, including which secret backend is really in use. */
  getAppInfo(): Promise<AppInfo>;
  /** Round-trips a message through the bridge. Used as a liveness probe. */
  probeBridge(message: string): Promise<EchoRes>;
}

export function createHostRepository(adapter: PlatformAdapter): HostRepository {
  return {
    async getAppInfo(): Promise<AppInfo> {
      const info = await adapter.invoke('app_info', {});
      if (info.contractVersion !== IPC_CONTRACT_VERSION) {
        throw new PlatformError(
          'CONTRACT_MISMATCH',
          `host speaks IPC contract v${info.contractVersion}, this build speaks v${IPC_CONTRACT_VERSION}`,
          'app_info',
        );
      }
      return info;
    },

    probeBridge(message: string): Promise<EchoRes> {
      return adapter.invoke('diagnostics_echo', { message });
    },
  };
}
