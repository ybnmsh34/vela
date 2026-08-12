/**
 * BrowserAdapter — the in-memory fake host.
 *
 * Used when the frontend runs outside Tauri: `pnpm dev` in a browser, vitest,
 * and any headless screenshot harness. It reimplements the semantics of
 * `src-tauri/src/ipc/` closely enough that the UI cannot tell the difference,
 * including the failure modes:
 *
 *  - unknown command      -> UNKNOWN_COMMAND
 *  - empty/oversized text -> INVALID_PAYLOAD
 *  - absent credential    -> `{ present: false }`, never an error
 *
 * **Honesty rule:** everything this adapter reports is VERIFIED-BY-FAKE. It
 * proves protocol shape and UI behaviour. It proves nothing about the OS
 * keychain, about a real model endpoint, or about a packaged binary.
 */

import type { EventContract, EventName, PlatformAdapter, Unsubscribe } from './adapter';
import {
  IPC_CONTRACT_VERSION,
  isAllowedCommand,
  type Ack,
  type AppInfo,
  type CommandName,
  type CommandReq,
  type CommandRes,
  type EchoReq,
  type EchoRes,
  type SecretsRefReq,
  type SecretsSetReq,
  type SecretsStatusRes,
} from './contract';
import { PlatformError } from './errors';

/** Mirrors `MAX_ECHO_BYTES` in `src-tauri/src/ipc/diagnostics.rs`. */
const MAX_ECHO_BYTES = 4096;
/** Mirrors `MAX_SECRET_BYTES` in `src-tauri/src/ipc/secrets.rs`. */
const MAX_SECRET_BYTES = 8192;

export interface BrowserAdapterOptions {
  /** Injectable clock so tests are deterministic. */
  readonly now?: () => number;
  /** Artificial latency in ms, to eyeball loading states. Default 0. */
  readonly latencyMs?: number;
}

function storageKey(reference: SecretsRefReq): string {
  const providerId = reference.providerId;
  if (providerId.trim() === '') {
    throw new PlatformError('INVALID_PAYLOAD', 'invalid providerId: must not be empty');
  }
  const field = reference.field === undefined || reference.field === '' ? 'primary' : reference.field;
  return `${providerId}/${field}`;
}

export class BrowserAdapter implements PlatformAdapter {
  readonly kind = 'browser' as const;

  /**
   * Values are held here only so `secrets_status` can answer truthfully. They
   * are never returned by any command — the fake honours the one-way rule that
   * the real host enforces.
   */
  readonly #secrets = new Map<string, string>();
  readonly #listeners = new Map<string, Set<(payload: unknown) => void>>();
  readonly #now: () => number;
  readonly #latencyMs: number;

  constructor(options: BrowserAdapterOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#latencyMs = options.latencyMs ?? 0;
  }

  async invoke<C extends CommandName>(command: C, payload: CommandReq<C>): Promise<CommandRes<C>> {
    if (!isAllowedCommand(command)) {
      throw new PlatformError('UNKNOWN_COMMAND', `command \`${command}\` is not allowlisted`, command);
    }
    if (this.#latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.#latencyMs));
    }
    // The cast is confined to this one dispatch point: `handle` is checked
    // against the contract per-command below.
    return this.#handle(command, payload) as CommandRes<C>;
  }

  #handle(command: CommandName, payload: unknown): unknown {
    switch (command) {
      case 'app_info':
        return this.#appInfo();
      case 'diagnostics_echo':
        return this.#echo(payload as EchoReq);
      case 'secrets_set':
        return this.#secretsSet(payload as SecretsSetReq);
      case 'secrets_delete':
        return this.#secretsDelete(payload as SecretsRefReq);
      case 'secrets_status':
        return this.#secretsStatus(payload as SecretsRefReq);
      default: {
        const exhaustive: never = command;
        throw new PlatformError('UNKNOWN_COMMAND', `unhandled command \`${String(exhaustive)}\``);
      }
    }
  }

  #appInfo(): AppInfo {
    return {
      name: 'Vela',
      version: '0.1.0',
      contractVersion: IPC_CONTRACT_VERSION,
      os: 'browser',
      arch: 'wasm-none',
      // Honest: no keychain exists in a browser tab.
      secretBackend: 'memory-fake',
    };
  }

  #echo(request: EchoReq): EchoRes {
    if (request.message === '') {
      throw new PlatformError('INVALID_PAYLOAD', 'message must not be empty', 'diagnostics_echo');
    }
    if (request.message.length > MAX_ECHO_BYTES) {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        `message exceeds ${MAX_ECHO_BYTES} bytes`,
        'diagnostics_echo',
      );
    }
    return { message: request.message, receivedAtMs: this.#now() };
  }

  #secretsSet(request: SecretsSetReq): Ack {
    const key = storageKey(request);
    if (request.value === '') {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        `refusing to store an empty credential for \`${key}\``,
        'secrets_set',
      );
    }
    if (request.value.length > MAX_SECRET_BYTES) {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        `credential exceeds ${MAX_SECRET_BYTES} bytes`,
        'secrets_set',
      );
    }
    this.#secrets.set(key, request.value);
    return { ok: true };
  }

  /** Idempotent, exactly like the host: deleting an absent credential succeeds. */
  #secretsDelete(request: SecretsRefReq): Ack {
    this.#secrets.delete(storageKey(request));
    return { ok: true };
  }

  #secretsStatus(request: SecretsRefReq): SecretsStatusRes {
    return { present: this.#secrets.has(storageKey(request)) };
  }

  async listen<E extends EventName>(
    event: E,
    handler: (payload: EventContract[E]) => void,
  ): Promise<Unsubscribe> {
    const typedHandler = handler as (payload: unknown) => void;
    const existing = this.#listeners.get(event) ?? new Set<(payload: unknown) => void>();
    existing.add(typedHandler);
    this.#listeners.set(event, existing);
    return () => {
      existing.delete(typedHandler);
    };
  }

  /** Test hook: push an event as if the host had emitted it. */
  emit<E extends EventName>(event: E, payload: EventContract[E]): void {
    for (const handler of this.#listeners.get(event) ?? []) {
      handler(payload);
    }
  }
}
