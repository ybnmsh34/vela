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
  type AuthMode,
  type CommandName,
  type CommandReq,
  type CommandRes,
  type Concern,
  type EchoReq,
  type EchoRes,
  type NetworkScope,
  type ProviderAuth,
  type ProviderView,
  type RiskLevel,
  type SecretsRefReq,
  type SecretsSetReq,
  type SecretsStatusRes,
  type SecurityPosture,
  type SettingsProviderRefReq,
  type SettingsPutProviderReq,
  type SettingsSetThemeReq,
  type SettingsSetThemeRes,
  type SettingsSnapshot,
  type ThemePreference,
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

/* -------------------------------------------------------------------------- */
/* settings — mirrors `src-tauri/crates/vela-settings`                        */
/* -------------------------------------------------------------------------- */

/** Mirrors `vela_settings::endpoint::EndpointUrl::parse`. */
function parseEndpoint(raw: string, command: CommandName): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new PlatformError('INVALID_PAYLOAD', `invalid baseUrl: \`${raw}\``, command);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PlatformError(
      'INVALID_PAYLOAD',
      `invalid baseUrl: unsupported scheme \`${url.protocol.replace(':', '')}\`: expected http or https`,
      command,
    );
  }
  if (url.hostname === '') {
    throw new PlatformError('INVALID_PAYLOAD', 'invalid baseUrl: must include a host', command);
  }
  return url;
}

/** Mirrors `vela_settings::endpoint::EndpointUrl::scope`. */
function networkScope(url: URL): NetworkScope {
  // `URL` keeps IPv6 literals in brackets; strip them before comparing.
  const host = url.hostname.replace(/^\[|]$/g, '').toLowerCase().replace(/\.$/, '');

  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  if (host === '::1' || /^127\./.test(host)) return 'loopback';
  if (host.endsWith('.local') || host.endsWith('.internal')) return 'privateNetwork';
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return 'privateNetwork';
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return 'privateNetwork';
  if (/^169\.254\./.test(host) || host === '0.0.0.0') return 'privateNetwork';
  if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return 'privateNetwork';
  return 'publicNetwork';
}

/** Mirrors `vela_settings::security::SecurityPosture::assess`. */
function assessSecurity(
  url: URL,
  auth: ProviderAuth,
  credentialPresent: boolean,
  credentialRequired: boolean,
): SecurityPosture {
  const scope = networkScope(url);
  const leavesDevice = scope !== 'loopback';
  const trafficIsPlaintext = url.protocol === 'http:';
  const endpointIsUnauthenticated = auth.type === 'none';
  const credentialSentInPlaintext =
    trafficIsPlaintext && leavesDevice && !endpointIsUnauthenticated && credentialPresent;

  const concerns: Concern[] = [];
  if (trafficIsPlaintext && leavesDevice) concerns.push('plaintextTrafficLeavesDevice');
  if (credentialSentInPlaintext) concerns.push('credentialSentInPlaintext');
  if (leavesDevice && endpointIsUnauthenticated) concerns.push('remoteEndpointIsUnauthenticated');
  if (credentialRequired && !credentialPresent) concerns.push('requiredCredentialMissing');
  concerns.sort();

  let level: RiskLevel = 'none';
  if (concerns.includes('credentialSentInPlaintext')) level = 'high';
  else if (concerns.includes('plaintextTrafficLeavesDevice')) level = 'elevated';
  else if (concerns.length > 0) level = 'notice';

  return {
    level,
    scope,
    leavesDevice,
    trafficIsPlaintext,
    credentialSentInPlaintext,
    endpointIsUnauthenticated,
    concerns,
  };
}

/** Mirrors `vela_core::credential::Auth::for_provider`. */
function bindAuth(providerId: string, mode: AuthMode): ProviderAuth {
  const secret = { providerId, field: 'primary' } as const;
  switch (mode.type) {
    case 'none':
      return { type: 'none' };
    case 'bearerToken':
      return { type: 'bearer', secret };
    case 'apiKeyHeader': {
      const header = mode.header.trim().toLowerCase();
      if (header === '') {
        throw new PlatformError(
          'INVALID_PAYLOAD',
          'invalid header: an API-key header must be named',
          'settings_put_provider',
        );
      }
      return { type: 'apiKeyHeader', header, secret };
    }
    case 'apiKeyQuery': {
      const param = mode.param.trim();
      if (param === '') {
        throw new PlatformError(
          'INVALID_PAYLOAD',
          'invalid param: an API-key query parameter must be named',
          'settings_put_provider',
        );
      }
      return { type: 'apiKeyQuery', param, secret };
    }
  }
}

/** Mirrors `vela_core::auth::AuthMode::field_label`. */
function credentialFieldLabel(mode: AuthMode): string | null {
  switch (mode.type) {
    case 'none':
      return null;
    case 'bearerToken':
      return 'Access token';
    case 'apiKeyHeader':
    case 'apiKeyQuery':
      return 'API key';
  }
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
  /** Stands in for the SQLite settings rows. Never holds a credential. */
  readonly #providers = new Map<string, SettingsPutProviderReq>();
  #theme: ThemePreference = 'system';
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
      case 'settings_get':
        return this.#settingsGet();
      case 'settings_set_theme':
        return this.#settingsSetTheme(payload as SettingsSetThemeReq);
      case 'settings_put_provider':
        return this.#settingsPutProvider(payload as SettingsPutProviderReq);
      case 'settings_delete_provider':
        return this.#settingsDeleteProvider(payload as SettingsProviderRefReq);
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

  /* ---------------------------------------------------------------------- */
  /* settings                                                               */
  /* ---------------------------------------------------------------------- */

  #settingsGet(): SettingsSnapshot {
    return {
      theme: this.#theme,
      // No command can change this, exactly as in the host.
      telemetryEnabled: false,
      credentialBackend: 'memory-fake',
      providers: [...this.#providers.keys()]
        .sort()
        .map((id) => this.#viewOf(this.#providers.get(id) as SettingsPutProviderReq)),
    };
  }

  #settingsSetTheme(request: SettingsSetThemeReq): SettingsSetThemeRes {
    this.#theme = request.theme;
    return { theme: request.theme };
  }

  #settingsPutProvider(request: SettingsPutProviderReq): ProviderView {
    const id = request.id.trim();
    if (id === '') {
      throw new PlatformError('INVALID_PAYLOAD', 'invalid id: must not be blank', 'settings_put_provider');
    }
    if (id.includes('/') || /\s/.test(id)) {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        'invalid id: must not contain whitespace or `/`',
        'settings_put_provider',
      );
    }
    if (request.displayName.trim() === '') {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        'invalid displayName: must not be blank',
        'settings_put_provider',
      );
    }
    if (request.modelId !== undefined && request.modelId.trim() === '') {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        'invalid modelId: must be omitted rather than blank',
        'settings_put_provider',
      );
    }
    // Parsed and bound for their validation side effects, before anything is
    // stored — the host writes nothing when a payload is rejected either.
    parseEndpoint(request.baseUrl, 'settings_put_provider');
    bindAuth(id, request.auth ?? { type: 'none' });

    const stored: SettingsPutProviderReq = { ...request, id };
    this.#providers.set(id, stored);
    return this.#viewOf(stored);
  }

  #settingsDeleteProvider(request: SettingsProviderRefReq): Ack {
    const stored = this.#providers.get(request.providerId);
    if (stored === undefined) {
      throw new PlatformError(
        'NOT_FOUND',
        `no provider configured with id \`${request.providerId}\``,
        'settings_delete_provider',
      );
    }
    // The credential goes with it, as in the host: no orphaned keychain entries.
    const auth = bindAuth(stored.id, stored.auth ?? { type: 'none' });
    if (auth.type !== 'none') {
      this.#secrets.delete(storageKey(auth.secret));
    }
    this.#providers.delete(request.providerId);
    return { ok: true };
  }

  #viewOf(stored: SettingsPutProviderReq): ProviderView {
    const mode: AuthMode = stored.auth ?? { type: 'none' };
    const requirement = stored.authRequirement ?? 'notRequired';
    const auth = bindAuth(stored.id, mode);
    const url = parseEndpoint(stored.baseUrl, 'settings_put_provider');

    const credentialPresent =
      auth.type !== 'none' && this.#secrets.has(storageKey(auth.secret));
    const credentialCheck =
      credentialPresent && mode.type !== 'none'
        ? 'satisfied'
        : requirement === 'required'
          ? 'missingRequired'
          : 'satisfiedWithoutCredential';

    return {
      id: stored.id,
      displayName: stored.displayName,
      kind: stored.kind,
      baseUrl: url.href,
      modelId: stored.modelId ?? null,
      auth,
      authRequirement: requirement,
      credentialPresent,
      usable: credentialCheck !== 'missingRequired',
      credentialCheck,
      authMode: mode,
      credentialFieldLabel: credentialFieldLabel(mode),
      security: assessSecurity(url, auth, credentialPresent, requirement === 'required'),
    };
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
