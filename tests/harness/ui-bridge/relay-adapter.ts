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

import type { EventContract, EventName, PlatformAdapter, Unsubscribe } from '@/platform/adapter';
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

  readonly #base: string;
  readonly #handlers = new Map<string, Set<(payload: never) => void>>();
  #stream: EventSource | null = null;

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

  listen<E extends EventName>(
    event: E,
    handler: (payload: EventContract[E]) => void,
  ): Promise<Unsubscribe> {
    const handlers = this.#handlers.get(event) ?? new Set();
    handlers.add(handler as (payload: never) => void);
    this.#handlers.set(event, handlers);
    this.#ensureStream();
    return Promise.resolve(() => {
      handlers.delete(handler as (payload: never) => void);
    });
  }

  #ensureStream(): void {
    if (this.#stream !== null) return;
    const stream = new EventSource(`${this.#base}/events`);
    stream.addEventListener('message', (message: MessageEvent<string>) => {
      const framed = JSON.parse(message.data) as { name: string; payload: unknown };
      for (const handler of this.#handlers.get(framed.name) ?? []) {
        (handler as (payload: unknown) => void)(framed.payload);
      }
    });
    this.#stream = stream;
  }
}
