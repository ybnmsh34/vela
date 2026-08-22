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
import type { SandboxEventEnvelope } from './contract-sandbox';

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
  /**
   * One event for one sandbox run, from `sandbox_submit`'s supervisor thread.
   * The name is `SANDBOX_EVENT_NAME` in `src/platform/contract-sandbox.ts`;
   * that file says this entry is part of wiring the contract up rather than a
   * separate nicety, because the index signature below would otherwise hand a
   * subscriber an `unknown` and compile.
   *
   * Subscribe before submitting: the first line of output can arrive before the
   * invoke promise settles, which is the whole reason the caller mints the id.
   */
  'sandbox:event': SandboxEventEnvelope;
  [key: string]: unknown;
}

export type EventName = keyof EventContract & string;

/* -------------------------------------------------------------------------- */
/* the window itself                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The window the app is drawn in.
 *
 * ## Why this is not on {@link IpcContract}
 *
 * Everything else the renderer asks the host for is a Vela command, declared in
 * `contract.ts` and implemented in `src-tauri/src/ipc/`. These five are not:
 * they are Tauri's own window commands, and `src-tauri/capabilities/main.json`
 * has granted exactly them — `core:window:allow-minimize`,
 * `allow-toggle-maximize`, `allow-is-maximized`, `allow-close` and
 * `allow-start-dragging` — since Phase A. Reimplementing them as Vela commands
 * would put a second, weaker copy of a permission boundary that already exists
 * in front of the one that ships.
 *
 * So they come through the seam instead of through the IPC contract. The rule
 * that matters is unchanged and is the reason this interface exists at all: no
 * component imports `@tauri-apps/api`, so the whole frontend still runs, and is
 * still tested, in a plain browser.
 *
 * ## `isMaximized` is a question, never a memory
 *
 * The renderer must not track "maximised" as a local boolean it flips when the
 * user clicks. `toggleMaximize()` can be refused — by a size constraint, by the
 * window manager, by a host that failed — and a control that flipped its own
 * icon would then show *restore* over a window that is not maximised. Ask the
 * window. Ask it again after every toggle, and whenever {@link onResized} says
 * something moved.
 */
export interface WindowControls {
  minimize(): Promise<void>;
  /** Maximise if restored, restore if maximised. Re-read the state afterwards. */
  toggleMaximize(): Promise<void>;
  isMaximized(): Promise<boolean>;
  /** Requests closure, exactly as the OS close button does. */
  close(): Promise<void>;
  /**
   * The window's size changed — by a drag, a snap, Win+Up, a monitor change.
   * Carries no payload on purpose: the only honest response is to ask
   * {@link isMaximized} again.
   */
  onResized(handler: () => void): Promise<Unsubscribe>;
}

/**
 * The window controls for a runtime that has no window to control: a browser
 * tab, and every test fake.
 *
 * `isMaximized()` answers `false` rather than throwing. A browser cannot be
 * maximised in this sense, and `false` is the state whose icon — *maximise* —
 * is the honest one to draw when there is nothing to restore.
 *
 * Exported so there is exactly one of these. A no-op copied into each fake is
 * three no-ops that drift.
 */
export const NO_WINDOW_CONTROLS: WindowControls = {
  minimize: async () => {},
  toggleMaximize: async () => {},
  isMaximized: async () => false,
  close: async () => {},
  onResized: async () => () => {},
};

export interface PlatformAdapter {
  readonly kind: AdapterKind;

  /**
   * The window this renderer is drawn in. Required, not optional: the app draws
   * its own title bar (`decorations: false`), so every adapter has to answer
   * for the window — with {@link NO_WINDOW_CONTROLS} when it has none.
   */
  readonly window: WindowControls;

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
