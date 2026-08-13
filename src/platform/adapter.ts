/**
 * THE PLATFORM ADAPTER SEAM.
 *
 * ## Why this exists
 *
 * UI code must never `import { invoke } from '@tauri-apps/api/core'`. It calls
 * this interface instead. That single rule is what lets the whole frontend run
 * in a plain browser (`pnpm dev`) against {@link BrowserAdapter}, which is how
 * it gets rendered, screenshotted and tested on a headless machine — and, in
 * Tauri, against `TauriAdapter` with the identical types.
 *
 * ## The rule for builders
 *
 * Nothing under `src/` may import `@tauri-apps/api` except
 * `src/platform/tauri-adapter.ts`. There is a vitest guard
 * (`src/platform/adapter.test.ts`) that scans the source tree and fails if a
 * second importer appears.
 *
 * ## Getting hold of one
 *
 * React code uses `usePlatform()` from `src/platform/PlatformProvider.tsx`.
 * Non-React code takes an adapter as an argument — do not reach for a module
 * singleton, because tests need to substitute one.
 */

import type { ChatEventEnvelope, CommandName, CommandReq, CommandRes } from './contract';

/** Which implementation is live. Shown in diagnostics; never branched on for behaviour. */
export type AdapterKind = 'tauri' | 'browser';

export type Unsubscribe = () => void;

/**
 * Host-pushed events. Empty for Phase A; add entries here rather than inventing
 * an untyped channel.
 */
export interface EventContract {
  /**
   * One normalised stream event for one in-flight turn. Emitted by the host
   * from `chat_send`'s spawned task; the renderer must already be subscribed
   * when it calls `chat_send`, because the first token can arrive before the
   * invoke promise settles.
   */
  'chat:event': ChatEventEnvelope;
  [key: string]: unknown;
}

export type EventName = keyof EventContract & string;

export interface PlatformAdapter {
  readonly kind: AdapterKind;

  /**
   * Call a host command. Rejects with a `PlatformError` — always, for every
   * failure mode, including a command that is not on the allowlist.
   */
  invoke<C extends CommandName>(command: C, payload: CommandReq<C>): Promise<CommandRes<C>>;

  /** Subscribe to a host event. Resolves to an unsubscribe function. */
  listen<E extends EventName>(
    event: E,
    handler: (payload: EventContract[E]) => void,
  ): Promise<Unsubscribe>;
}
