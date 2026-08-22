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
import {
  IPC_CONTRACT_VERSION,
  type AppInfo,
  type DebugLogStatus,
  type EchoRes,
} from '@/platform/contract';
import { PlatformError } from '@/platform/errors';

export interface HostRepository {
  /** Identity of the host process, including which secret backend is really in use. */
  getAppInfo(): Promise<AppInfo>;
  /** Round-trips a message through the bridge. Used as a liveness probe. */
  probeBridge(message: string): Promise<EchoRes>;
  /** Whether the local debug log is recording, and where it writes. */
  getDebugLog(): Promise<DebugLogStatus>;
  /**
   * Turn the local debug log on or off.
   *
   * The host answers with the state it actually reached, not with what was
   * asked for — enabling has to create a directory and can fail, and a switch
   * that draws itself from its own optimism is a switch that lies.
   */
  setDebugLog(enabled: boolean): Promise<DebugLogStatus>;
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

    getDebugLog(): Promise<DebugLogStatus> {
      return adapter.invoke('diagnostics_debug_log_get', {});
    },

    setDebugLog(enabled: boolean): Promise<DebugLogStatus> {
      return adapter.invoke('diagnostics_debug_log_set', { enabled });
    },
  };
}
