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

import {
  deriveTitle,
  isPlaceholderTitle,
  searchTerms,
  UNTITLED_TITLE,
} from '@/lib/navigation-text';

import type { EventContract, EventName, PlatformAdapter, Unsubscribe } from './adapter';
import {
  IPC_CONTRACT_VERSION,
  isAllowedCommand,
  type Ack,
  type AppInfo,
  type AuthMode,
  type ChatCancelReq,
  type ChatCancelRes,
  type ChatSendReq,
  type ChatSendRes,
  type ChatStreamEvent,
  type CommandName,
  type CommandReq,
  type CommandRes,
  type Concern,
  type ConversationListRes,
  type ConversationRes,
  type ConversationSummary,
  type EchoReq,
  type EchoRes,
  type MessageHit,
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
  type StoreConversationRefReq,
  type StoreCreateConversationReq,
  type StoreListConversationsReq,
  type StoreRenameConversationReq,
  type StoreSearchReq,
  type StoreSearchRes,
  type ThemePreference,
  type UiLayout,
} from './contract';
import { PlatformError } from './errors';

/** Mirrors `MAX_ECHO_BYTES` in `src-tauri/src/ipc/diagnostics.rs`. */
const MAX_ECHO_BYTES = 4096;
/** Mirrors `MAX_SECRET_BYTES` in `src-tauri/src/ipc/secrets.rs`. */
const MAX_SECRET_BYTES = 8192;
/** Mirrors `MAX_LABEL_LEN` in `vela-settings/src/provider_config.rs`. */
const MAX_LABEL_LEN = 200;
/** Mirrors `MAX_MESSAGE_BYTES` in `src-tauri/src/ipc/chat.rs`. */
const MAX_MESSAGE_BYTES = 1_048_576;
/** Mirrors `MAX_MESSAGES` in `src-tauri/src/ipc/chat.rs`. */
const MAX_MESSAGES = 4_096;
/** Mirrors `MAX_SUPPLIED_TITLE` in `src-tauri/src/ipc/store.rs`. */
const MAX_SUPPLIED_TITLE = 200;
/** Mirrors `DEFAULT_LIST_LIMIT` in `src-tauri/src/ipc/store.rs`. */
const DEFAULT_LIST_LIMIT = 500;
/** Mirrors `DEFAULT_SEARCH_LIMIT` / `MAX_SEARCH_LIMIT` in the same module. */
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 200;
/** Mirrors the sidebar bounds in `src-tauri/src/ipc/ui.rs`. */
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 480;
const DEFAULT_SIDEBAR_WIDTH = 280;
/** Mirrors the `snippet(…, 12)` token budget the host asks FTS5 for. */
const SNIPPET_TOKENS = 12;

export interface BrowserAdapterOptions {
  /** Injectable clock so tests are deterministic. */
  readonly now?: () => number;
  /** Artificial latency in ms, to eyeball loading states. Default 0. */
  readonly latencyMs?: number;
  /**
   * How the fake spaces out stream frames. Defaults to `queueMicrotask`, which
   * keeps tests deterministic and fast while still making the deltas *arrive*
   * asynchronously — a synchronous fake would let a renderer that never
   * subscribes appear to work.
   */
  readonly scheduleFrame?: (run: () => void) => void;
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

/**
 * Mirrors `vela_settings::endpoint::EndpointUrl::scope`.
 *
 * The host classifies a **parsed host** — `url::Host::{Ipv4, Ipv6, Domain}` —
 * and never a prefix of the raw string. This side has to do the same, because
 * a string test is wrong in both directions: `127.evil.example` is a domain
 * anybody can register (a `startsWith('127.')` test reports it as loopback and
 * silences every warning), and `fdn.example.test` is not a ULA address. The
 * whole family is pinned in `tests/parity/adapter-parity.json`.
 *
 * `URL` gives us the parse for free: WHATWG serialises an IPv4 host as a
 * canonical dotted quad, an IPv6 host in brackets, and anything whose last
 * label is numeric either becomes an IPv4 host or fails to parse at all.
 */
function networkScope(url: URL): NetworkScope {
  const hostname = url.hostname;
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return ipv6Scope(hostname.slice(1, -1).toLowerCase());
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    return ipv4Scope(hostname.split('.').map(Number) as [number, number, number, number]);
  }
  // `trim_end_matches('.')` in the host removes *every* trailing dot, so
  // `gpu-box.local..` is still a LAN name.
  return domainScope(hostname.toLowerCase().replace(/\.+$/, ''));
}

/** Mirrors the `IpAddr::V4` arm of `vela_settings::endpoint::scope_of_ip`. */
function ipv4Scope([a, b, c, d]: [number, number, number, number]): NetworkScope {
  if (a === 127) return 'loopback'; // the whole 127.0.0.0/8, as `is_loopback`
  if (a === 10) return 'privateNetwork';
  if (a === 172 && b >= 16 && b <= 31) return 'privateNetwork';
  if (a === 192 && b === 168) return 'privateNetwork';
  if (a === 169 && b === 254) return 'privateNetwork'; // link-local
  // Exactly `Ipv4Addr::UNSPECIFIED`, not the 0.0.0.0/8 block: the host compares
  // against the one address, and 0.1.2.3 is public on both sides.
  if (a === 0 && b === 0 && c === 0 && d === 0) return 'privateNetwork';
  return 'publicNetwork';
}

/**
 * Mirrors the `IpAddr::V6` arm of `vela_settings::endpoint::scope_of_ip`.
 *
 * `text` is the canonical compressed form, so the first group is the text
 * before the first `:` — unless the address *starts* with the compression, in
 * which case that group is zero. Only `::1` is loopback: a v4-mapped
 * `::ffff:127.0.0.1` is not, on either side.
 */
function ipv6Scope(text: string): NetworkScope {
  if (text === '::1') return 'loopback';
  if (text === '::') return 'privateNetwork'; // `is_unspecified`
  const first = text.startsWith(':') ? 0 : Number.parseInt(text.split(':')[0] ?? '', 16);
  if ((first & 0xfe00) === 0xfc00) return 'privateNetwork'; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return 'privateNetwork'; // fe80::/10 link-local
  return 'publicNetwork';
}

/** Mirrors the `Host::Domain` arm of `EndpointUrl::scope`. Suffixes, never prefixes. */
function domainScope(name: string): NetworkScope {
  if (name === 'localhost' || name.endsWith('.localhost')) return 'loopback';
  if (name.endsWith('.local') || name.endsWith('.internal')) return 'privateNetwork';
  return 'publicNetwork';
}

/** Mirrors `vela_settings::RiskLevel`, quietest first. */
const RISK_LADDER: readonly RiskLevel[] = ['none', 'notice', 'elevated', 'high'];

/**
 * Mirrors `vela_settings::security::Concern::severity`. The posture's `level`
 * is the loudest severity among the concerns raised, so a new concern cannot be
 * added without being given a place on the ladder — the `Record` is total.
 */
const CONCERN_SEVERITY: Record<Concern, RiskLevel> = {
  credentialSentInPlaintext: 'high',
  plaintextTrafficLeavesDevice: 'elevated',
  queryParamCredentialIsLogged: 'elevated',
  remoteEndpointIsUnauthenticated: 'notice',
  requiredCredentialMissing: 'notice',
};

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
  // Mirrors `credential_in_query_string`: gated on the endpoint being remote,
  // and on nothing else. Not on `trafficIsPlaintext` — https does not stop an
  // access log — and not on `credentialPresent`, because the user needs to be
  // told before they paste the key in.
  const credentialInQueryString = leavesDevice && auth.type === 'apiKeyQuery';

  const concerns: Concern[] = [];
  if (trafficIsPlaintext && leavesDevice) concerns.push('plaintextTrafficLeavesDevice');
  if (credentialSentInPlaintext) concerns.push('credentialSentInPlaintext');
  if (credentialInQueryString) concerns.push('queryParamCredentialIsLogged');
  if (leavesDevice && endpointIsUnauthenticated) concerns.push('remoteEndpointIsUnauthenticated');
  if (credentialRequired && !credentialPresent) concerns.push('requiredCredentialMissing');
  concerns.sort();

  const level = concerns.reduce<RiskLevel>(
    (loudest, concern) =>
      RISK_LADDER.indexOf(CONCERN_SEVERITY[concern]) > RISK_LADDER.indexOf(loudest)
        ? CONCERN_SEVERITY[concern]
        : loudest,
    'none',
  );

  return {
    level,
    scope,
    leavesDevice,
    trafficIsPlaintext,
    credentialSentInPlaintext,
    credentialInQueryString,
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

/**
 * Chops text into stream frames on word boundaries.
 *
 * Deliberately *not* on character boundaries: a frame splitter that never cuts
 * mid-token would let a renderer with a broken accumulator look correct, and
 * one that cuts inside a UTF-16 surrogate pair would test the fake rather than
 * the UI.
 */
function splitIntoFrames(text: string): string[] {
  if (text === '') return [];
  return text.match(/\S+\s*/g) ?? [text];
}

function storageKey(reference: SecretsRefReq): string {
  const providerId = reference.providerId;
  if (providerId.trim() === '') {
    throw new PlatformError('INVALID_PAYLOAD', 'invalid providerId: must not be empty');
  }
  const field = reference.field === undefined || reference.field === '' ? 'primary' : reference.field;
  return `${providerId}/${field}`;
}

/* -------------------------------------------------------------------------- */
/* store — the fake's stand-in for the SQLite tables                          */
/* -------------------------------------------------------------------------- */

interface FakeMessage {
  readonly id: string;
  /** The answer text. Never contains reasoning — the same separation the store keeps. */
  readonly text: string;
  /** Reasoning, stored beside the answer rather than inside it. */
  readonly reasoning?: string;
  readonly createdAtMs: number;
}

interface FakeConversation {
  readonly id: string;
  title: string;
  readonly createdAtMs: number;
  updatedAtMs: number;
  readonly messages: FakeMessage[];
}

/**
 * Stands in for FTS5's `MATCH`: every term but the last must appear as a whole
 * token, and the last as a token prefix, which is what the host's rewrite asks
 * the index for.
 */
function matchesTerms(text: string, terms: readonly string[]): boolean {
  const tokens = searchTerms(text);
  return terms.every((term, index) =>
    index === terms.length - 1
      ? tokens.some((token) => token.startsWith(term))
      : tokens.includes(term),
  );
}

/**
 * Stands in for `snippet(message_search, 0, '[', ']', '…', 12)`: the matched
 * token in brackets, with a bounded window of context either side.
 */
function snippetOf(text: string, terms: readonly string[]): string {
  const last = terms[terms.length - 1] ?? '';
  const words = text.split(/(\s+)/u).filter((part) => part !== '');
  const hit = words.findIndex((word) => searchTerms(word).some((token) => token.startsWith(last)));
  if (hit === -1) return text;

  const before = Math.max(0, hit - SNIPPET_TOKENS);
  const after = Math.min(words.length, hit + SNIPPET_TOKENS + 1);
  const window = words.slice(before, after).map((word, index) => {
    return before + index === hit ? `[${word}]` : word;
  });
  return `${before > 0 ? '…' : ''}${window.join('')}${after < words.length ? '…' : ''}`;
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
  /** Mirrors `ChatTurns` in the host: id -> "has been cancelled". */
  readonly #turns = new Map<string, { cancelled: boolean }>();
  /** Stands in for the SQLite `conversations` and `messages` tables. */
  readonly #conversations = new Map<string, FakeConversation>();
  #conversationSeq = 0;
  #layout: UiLayout = {
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    sidebarCollapsed: false,
  };
  readonly #now: () => number;
  readonly #latencyMs: number;
  readonly #scheduleFrame: (run: () => void) => void;

  constructor(options: BrowserAdapterOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#latencyMs = options.latencyMs ?? 0;
    this.#scheduleFrame = options.scheduleFrame ?? ((run) => queueMicrotask(run));
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
      case 'chat_send':
        return this.#chatSend(payload as ChatSendReq);
      case 'chat_cancel':
        return this.#chatCancel(payload as ChatCancelReq);
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
      case 'store_list_conversations':
        return this.#storeListConversations(payload as StoreListConversationsReq);
      case 'store_create_conversation':
        return this.#storeCreateConversation(payload as StoreCreateConversationReq);
      case 'store_rename_conversation':
        return this.#storeRenameConversation(payload as StoreRenameConversationReq);
      case 'store_delete_conversation':
        return this.#storeDeleteConversation(payload as StoreConversationRefReq);
      case 'store_autotitle_conversation':
        return this.#storeAutotitleConversation(payload as StoreConversationRefReq);
      case 'store_search':
        return this.#storeSearch(payload as StoreSearchReq);
      case 'ui_get_layout':
        return this.#layout;
      case 'ui_set_layout':
        return this.#uiSetLayout(payload as UiLayout);
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
    // The ORDER of these checks is part of the contract, not an accident. It
    // mirrors the host: `TryFrom<SettingsPutProviderReq> for ProviderConfig`
    // binds the auth mode first and parses the endpoint second, and only then
    // does `ProviderConfig::validated` look at the id, the display name and the
    // model id. A payload with two faults must name the same field on both
    // sides, or the UI learns to highlight the wrong input. Pinned by the
    // `reject-order-*` rows in `tests/parity/adapter-parity.json`.
    //
    // Everything here runs before anything is stored, because the host writes
    // nothing when a payload is rejected either.
    bindAuth(id, request.auth ?? { type: 'none' });
    parseEndpoint(request.baseUrl, 'settings_put_provider');

    if (id === '') {
      throw new PlatformError('INVALID_PAYLOAD', 'invalid id: must not be blank', 'settings_put_provider');
    }
    if (id.length > MAX_LABEL_LEN) {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        `invalid id: must be at most ${MAX_LABEL_LEN} characters`,
        'settings_put_provider',
      );
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
    if (request.displayName.length > MAX_LABEL_LEN) {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        `invalid displayName: must be at most ${MAX_LABEL_LEN} characters`,
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

  /* ---------------------------------------------------------------------- */
  /* chat — mirrors `src-tauri/src/ipc/chat.rs`                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Accepts a turn and streams it back, exactly as the host does: the invoke
   * resolves immediately and the tokens arrive on `chat:event` afterwards.
   *
   * The reply mirrors the host's in-process fake (`EchoProvider`) — it echoes
   * the last user message. The *framing* is not part of the contract, so this
   * one splits the echo across several frames where the host's emits one: a
   * renderer that can only draw a whole answer at once must not be able to look
   * correct here.
   */
  #chatSend(request: ChatSendReq): ChatSendRes {
    if (request.turnId.trim() === '') {
      throw new PlatformError('INVALID_PAYLOAD', 'invalid turnId: must not be blank', 'chat_send');
    }
    if (request.providerId.trim() === '') {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        'invalid providerId: must not be blank',
        'chat_send',
      );
    }
    if (request.modelId.trim() === '') {
      throw new PlatformError('INVALID_PAYLOAD', 'invalid modelId: must not be blank', 'chat_send');
    }
    if (request.messages.length === 0) {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        'invalid messages: a turn needs at least one message',
        'chat_send',
      );
    }
    if (request.messages.length > MAX_MESSAGES) {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        `invalid messages: at most ${MAX_MESSAGES} messages per turn`,
        'chat_send',
      );
    }
    const oversized = request.messages.findIndex((m) => m.text.length > MAX_MESSAGE_BYTES);
    if (oversized !== -1) {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        `invalid messages[${oversized}]: exceeds ${MAX_MESSAGE_BYTES} bytes`,
        'chat_send',
      );
    }
    // Mirrors `resolve_provider`: an id that is not configured is NOT_FOUND,
    // never a quiet fallback to whatever else happens to be set up.
    if (!this.#providers.has(request.providerId)) {
      throw new PlatformError(
        'NOT_FOUND',
        `no provider configured with id \`${request.providerId}\``,
        'chat_send',
      );
    }
    if (this.#turns.has(request.turnId)) {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        `invalid turnId: \`${request.turnId}\` is already streaming`,
        'chat_send',
      );
    }

    const turn = { cancelled: false };
    this.#turns.set(request.turnId, turn);

    const echoed = [...request.messages].reverse().find((m) => m.role === 'user')?.text ?? '';
    const frames = splitIntoFrames(echoed);
    let index = 0;

    const step = () => {
      if (turn.cancelled) {
        // What a real backend produces when the caller cancels: a terminal
        // `Error` of kind `cancelled`, not a `Done` pretending the turn ran.
        this.#turns.delete(request.turnId);
        this.#emitChat(request.turnId, { type: 'error', error: { kind: 'cancelled' } });
        return;
      }
      if (index < frames.length) {
        this.#emitChat(request.turnId, { type: 'textDelta', text: frames[index] ?? '' });
        index += 1;
        this.#scheduleFrame(step);
        return;
      }
      this.#turns.delete(request.turnId);
      this.#emitChat(request.turnId, {
        type: 'done',
        response: {
          parts: echoed === '' ? [] : [{ kind: 'text', text: echoed }],
          toolCalls: [],
          stopReason: 'endTurn',
          usage: {
            inputTokens: null,
            outputTokens: null,
            reasoningTokens: null,
            cachedInputTokens: null,
          },
          structured: null,
          // Honest: this fake reports no usage, so it says so, exactly as a
          // local runtime that never sends a usage block does.
          degradations: [{ kind: 'usageNotReported' }],
        },
      });
    };

    this.#scheduleFrame(step);
    return { turnId: request.turnId, accepted: true };
  }

  #chatCancel(request: ChatCancelReq): ChatCancelRes {
    if (request.turnId.trim() === '') {
      throw new PlatformError('INVALID_PAYLOAD', 'invalid turnId: must not be blank', 'chat_cancel');
    }
    const turn = this.#turns.get(request.turnId);
    if (turn === undefined) {
      // A race, not an error: the user pressed stop as the last token landed.
      return { cancelled: false };
    }
    turn.cancelled = true;
    return { cancelled: true };
  }

  #emitChat(turnId: string, event: ChatStreamEvent): void {
    this.emit('chat:event', { turnId, event });
  }

  /* ---------------------------------------------------------------------- */
  /* store — mirrors `src-tauri/src/ipc/store.rs`                           */
  /*                                                                        */
  /* The title rules (`deriveTitle`) and the query rewrite are shared code,  */
  /* pinned against the host by `tests/parity/navigation.json`. The content  */
  /* MATCH is not: the host asks SQLite's FTS5 index, and this fake matches  */
  /* the same tokens against the same text in JavaScript. It agrees on the   */
  /* cases a sidebar exercises and is an approximation elsewhere — which is  */
  /* what a fake is. VERIFIED-BY-FAKE.                                       */
  /* ---------------------------------------------------------------------- */

  /** Mirrors `validate_title`: collapse, refuse blank, cap the length. */
  #validTitle(raw: string, command: CommandName): string {
    const title = raw.split(/\s+/u).filter((part) => part !== '').join(' ');
    if (title === '') {
      throw new PlatformError('INVALID_PAYLOAD', 'invalid title: must not be blank', command);
    }
    if ([...title].length > MAX_SUPPLIED_TITLE) {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        `invalid title: must be at most ${MAX_SUPPLIED_TITLE} characters`,
        command,
      );
    }
    return title;
  }

  #requireConversation(id: string, command: CommandName): FakeConversation {
    const found = this.#conversations.get(id.trim());
    if (found === undefined) {
      throw new PlatformError('NOT_FOUND', `no conversation with id \`${id}\``, command);
    }
    return found;
  }

  #summarise(conversation: FakeConversation): ConversationSummary {
    const last = conversation.messages.at(-1);
    return {
      id: conversation.id,
      title: conversation.title,
      createdAtMs: conversation.createdAtMs,
      updatedAtMs: conversation.updatedAtMs,
      lastMessageAtMs: last === undefined ? null : last.createdAtMs,
      messageCount: conversation.messages.length,
      titleIsPlaceholder: isPlaceholderTitle(conversation.title),
    };
  }

  #storeListConversations(request: StoreListConversationsReq): ConversationListRes {
    const limit = request.limit ?? DEFAULT_LIST_LIMIT;
    const conversations = [...this.#conversations.values()]
      // Mirrors `ORDER BY c.updated_at DESC, c.id DESC`.
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs || (a.id < b.id ? 1 : -1))
      .slice(0, limit)
      .map((conversation) => this.#summarise(conversation));
    return { conversations };
  }

  #storeCreateConversation(request: StoreCreateConversationReq): ConversationRes {
    const title =
      request.title === undefined
        ? UNTITLED_TITLE
        : this.#validTitle(request.title, 'store_create_conversation');

    this.#conversationSeq += 1;
    const now = this.#now();
    const conversation: FakeConversation = {
      id: `conv_${this.#conversationSeq}`,
      title,
      createdAtMs: now,
      updatedAtMs: now,
      messages: [],
    };
    this.#conversations.set(conversation.id, conversation);
    return { conversation: this.#summarise(conversation) };
  }

  #storeRenameConversation(request: StoreRenameConversationReq): ConversationRes {
    const conversation = this.#requireConversation(
      request.conversationId,
      'store_rename_conversation',
    );
    conversation.title = this.#validTitle(request.title, 'store_rename_conversation');
    conversation.updatedAtMs = this.#now();
    return { conversation: this.#summarise(conversation) };
  }

  #storeDeleteConversation(request: StoreConversationRefReq): Ack {
    // NOT_FOUND rather than a silent success, exactly as the host: the sidebar
    // just asked to destroy something, and "it was already gone" is information.
    const conversation = this.#requireConversation(
      request.conversationId,
      'store_delete_conversation',
    );
    this.#conversations.delete(conversation.id);
    return { ok: true };
  }

  #storeAutotitleConversation(request: StoreConversationRefReq): ConversationRes {
    const conversation = this.#requireConversation(
      request.conversationId,
      'store_autotitle_conversation',
    );
    if (!isPlaceholderTitle(conversation.title)) {
      return { conversation: this.#summarise(conversation) };
    }
    // Reasoning is excluded, as in the host: naming a conversation after the
    // model's private thinking would put words in the sidebar the user never saw.
    for (const message of conversation.messages.slice(0, 8)) {
      const derived = deriveTitle(message.text);
      if (derived !== null) {
        conversation.title = derived;
        conversation.updatedAtMs = this.#now();
        break;
      }
    }
    return { conversation: this.#summarise(conversation) };
  }

  #storeSearch(request: StoreSearchReq): StoreSearchRes {
    const raw = request.query.trim();
    const limit = Math.min(request.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    if (raw === '') {
      // An empty box is not a failed search, and never an error.
      return { conversations: [], messages: [] };
    }

    const needle = raw.toLowerCase();
    const conversations = [...this.#conversations.values()]
      .filter((conversation) => conversation.title.toLowerCase().includes(needle))
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs || (a.id < b.id ? 1 : -1))
      .slice(0, limit)
      .map((conversation) => this.#summarise(conversation));

    const terms = searchTerms(raw);
    const messages: MessageHit[] = [];
    if (terms.length > 0) {
      for (const conversation of this.#conversations.values()) {
        for (const message of conversation.messages) {
          for (const field of ['reasoning', 'text'] as const) {
            const text = message[field];
            if (text === undefined || !matchesTerms(text, terms)) continue;
            messages.push({
              messageId: message.id,
              conversationId: conversation.id,
              conversationTitle: conversation.title,
              kind: field === 'reasoning' ? 'reasoning' : 'answer',
              snippet: snippetOf(text, terms),
              createdAtMs: message.createdAtMs,
            });
          }
        }
      }
    }

    return { conversations, messages: messages.slice(0, limit) };
  }

  #uiSetLayout(request: UiLayout): UiLayout {
    // Clamped, never rejected — mirrors `UiLayout::clamped`.
    this.#layout = {
      sidebarWidth: Math.min(
        MAX_SIDEBAR_WIDTH,
        Math.max(MIN_SIDEBAR_WIDTH, Math.round(request.sidebarWidth)),
      ),
      sidebarCollapsed: request.sidebarCollapsed,
    };
    return this.#layout;
  }

  /**
   * Test hook: put a conversation and its transcript into the fake.
   *
   * The navigation commands can create and rename conversations but cannot
   * append messages — that is the transcript surface's boundary, not this one.
   * Without this hook there would be no way to exercise content search against
   * the fake at all, and a search box tested only against an empty index proves
   * nothing. Like `emit`, it is a hook on the fake, not a command: it is
   * unreachable from `invoke`, so no renderer code can call it.
   */
  seedConversation(input: {
    readonly title: string;
    readonly messages?: readonly { readonly text: string; readonly reasoning?: string }[];
    readonly createdAtMs?: number;
    readonly updatedAtMs?: number;
  }): ConversationSummary {
    this.#conversationSeq += 1;
    const now = this.#now();
    const id = `conv_${this.#conversationSeq}`;
    const conversation: FakeConversation = {
      id,
      title: input.title,
      createdAtMs: input.createdAtMs ?? now,
      updatedAtMs: input.updatedAtMs ?? input.createdAtMs ?? now,
      messages: (input.messages ?? []).map((message, index) => ({
        id: `${id}_msg_${index + 1}`,
        text: message.text,
        ...(message.reasoning === undefined ? {} : { reasoning: message.reasoning }),
        createdAtMs: input.createdAtMs ?? now,
      })),
    };
    this.#conversations.set(id, conversation);
    return this.#summarise(conversation);
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
