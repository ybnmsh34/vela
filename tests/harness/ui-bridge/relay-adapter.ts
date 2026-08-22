/**
 * RelayAdapter — a `PlatformAdapter` that forwards to the real Rust core.
 *
 * `TauriAdapter` reaches the host over Tauri IPC, which needs a webview this
 * container cannot start. `BrowserAdapter` needs nothing, and answers
 * everything itself — which is why it can never produce a capability report, a
 * degradation, or a malformed tool call. This third implementation exists for
 * the GATE M Part 1 UI matrix only: same typed contract, same allowlist
 * refusal, but `invoke` goes over HTTP to `tests/harness/ui-bridge/server.mjs`,
 * which pipes it into `src-tauri/examples/ui_matrix_bridge.rs` — the real
 * `vela_lib::ipc::*` functions over the real provider core against a real mock
 * endpoint.
 *
 * It is **test infrastructure and lives outside `src/`** on purpose: the
 * shipping adapter selection (`createPlatformAdapter`) does not know it exists
 * and cannot ever select it.
 *
 * ## What it is allowed to do
 *
 * Nothing but transport. It does not synthesise a response, does not retry,
 * does not reshape an event. If the host says `NOT_FOUND`, this throws
 * `NOT_FOUND`. The one piece of behaviour it reimplements is the allowlist
 * check, because both shipping adapters do it and a harness that skipped it
 * would let the UI reach a command the real bridge would refuse.
 */

import {
  NO_WINDOW_CONTROLS,
  type EventContract,
  type EventName,
  type PlatformAdapter,
  type Unsubscribe,
} from '@/platform/adapter';
import { isAllowedCommand, type CommandName, type CommandReq, type CommandRes } from '@/platform/contract';
import { PlatformError, toPlatformError } from '@/platform/errors';

interface RelayFailure {
  readonly code: string;
  readonly message: string;
}

interface RelayEnvelope {
  readonly ok?: unknown;
  readonly err?: RelayFailure;
}

export class RelayAdapter implements PlatformAdapter {
  /**
   * The renderer really is in a browser, and `HomeSurface` prints this in its
   * diagnostics list. Saying `tauri` here would put a false claim in a
   * screenshot; the host behind the relay is real, the webview is not.
   */
  readonly kind = 'browser' as const;

  /**
   * The relay carries Vela's own IPC commands, not Tauri's window commands:
   * there is no window behind it to minimise or close. The title bar draws its
   * caption buttons either way, and here they do nothing.
   */
  readonly window = NO_WINDOW_CONTROLS;

  readonly #base: string;
  readonly #handlers = new Map<string, Set<(payload: never) => void>>();
  /**
   * Settles when the stream is receiving. Doubles as the once-only guard: the
   * stream is opened by whoever creates this promise and by nobody else.
   */
  #open: Promise<void> | null = null;

  constructor(base = '') {
    this.#base = base;
  }

  async invoke<C extends CommandName>(command: C, payload: CommandReq<C>): Promise<CommandRes<C>> {
    if (!isAllowedCommand(command)) {
      throw new PlatformError('UNKNOWN_COMMAND', `command \`${command}\` is not allowlisted`, command);
    }
    let envelope: RelayEnvelope;
    try {
      const response = await fetch(`${this.#base}/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command, payload }),
      });
      envelope = (await response.json()) as RelayEnvelope;
    } catch (thrown) {
      throw toPlatformError(thrown, command);
    }
    if (envelope.err !== undefined) {
      throw toPlatformError(envelope.err, command);
    }
    return envelope.ok as CommandRes<C>;
  }

  /**
   * Resolves once this adapter is **actually receiving** events, not merely
   * once it has asked to.
   *
   * `PlatformAdapter.listen`'s contract is that the listener is registered by
   * the time the promise settles, and `chat-repository.ts` leans on it
   * directly: it `await`s `ensureSubscribed()` and only then invokes
   * `chat_send`, precisely so a turn cannot start before anything is listening.
   * `TauriAdapter` honours that — Tauri's own `listen` resolves after
   * registration.
   *
   * This adapter used to resolve synchronously while `new EventSource(…)` was
   * still opening its connection, and `server.mjs` fans `/events` out live with
   * no replay. Every `textDelta` the core emitted during that handshake was
   * therefore dropped **in the harness**, and the transcript began mid-word:
   * `small-local` recorded `"rise what this endpoint can do.."` for an answer
   * the core's own `core-events.json` shows in full as `"Mock small-local reply
   * to: Summarise what this endpoint can do.."`. The gap was 31 characters that
   * run, 95 in `a936bad`, 112 in `4647556`'s `mid-local` — it moved with the
   * connection, which is what made it look like an app defect rather than a
   * transport one.
   *
   * It was in the committed evidence, screenshotted, through four gate runs.
   * No assertion compares the rendered answer to the events the core produced,
   * so nothing objected — and a picture of a truncated answer was being read as
   * a picture of a working one. The bug was always here, in test
   * infrastructure; Vela's own ordering was correct throughout.
   */
  async listen<E extends EventName>(
    event: E,
    handler: (payload: EventContract[E]) => void,
  ): Promise<Unsubscribe> {
    const handlers = this.#handlers.get(event) ?? new Set();
    handlers.add(handler as (payload: never) => void);
    this.#handlers.set(event, handlers);
    await this.#ensureStream();
    return () => {
      handlers.delete(handler as (payload: never) => void);
    };
  }

  #ensureStream(): Promise<void> {
    this.#open ??= new Promise<void>((resolve, reject) => {
      const stream = new EventSource(`${this.#base}/events`);
      stream.addEventListener('message', (message: MessageEvent<string>) => {
        const framed = JSON.parse(message.data) as { name: string; payload: unknown };
        for (const handler of this.#handlers.get(framed.name) ?? []) {
          (handler as (payload: unknown) => void)(framed.payload);
        }
      });
      // `open` fires when the response headers have arrived, which is after
      // `server.mjs` has added this response to its listener set — so from
      // here on nothing the core emits can be missed.
      stream.addEventListener('open', () => {
        resolve();
      });
      stream.addEventListener('error', () => {
        // Only fatal before the first open; afterwards EventSource reconnects
        // on its own and the promise is long settled.
        reject(new Error('the ui-bridge event stream could not be opened'));
      });
    });
    return this.#open;
  }
}
