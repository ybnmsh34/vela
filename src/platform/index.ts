/**
 * Adapter selection.
 *
 * Detection is a single check for Tauri's injected internals object. It is not
 * user-agent sniffing and it is not a build-time flag, so the same bundle runs
 * in both places — which is what makes headless rendering honest: the code that
 * gets screenshotted is the code that ships.
 */

import type { PlatformAdapter } from './adapter';
import { BrowserAdapter } from './browser-adapter';
import { TauriAdapter } from './tauri-adapter';

export type { AdapterKind, EventContract, EventName, PlatformAdapter, Unsubscribe } from './adapter';
export * from './contract';
export { BrowserAdapter } from './browser-adapter';
export { TauriAdapter } from './tauri-adapter';
export { IPC_ERROR_CODES, PlatformError, toPlatformError } from './errors';
export type { IpcErrorCode, IpcErrorShape } from './errors';

/** True when running inside a Tauri webview. */
export function isTauriRuntime(scope: unknown = globalThis): boolean {
  return typeof scope === 'object' && scope !== null && '__TAURI_INTERNALS__' in scope;
}

/**
 * Build the adapter for the current runtime. Call once, at the app root, and
 * pass the result down through `PlatformProvider`. Do not call this from
 * components — they must be injectable for tests.
 */
export function createPlatformAdapter(scope: unknown = globalThis): PlatformAdapter {
  return isTauriRuntime(scope) ? new TauriAdapter() : new BrowserAdapter();
}
