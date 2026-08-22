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

import {
  DEFAULT_AUTO_APPROVAL_PROFILE,
  isolationMeets,
  type Isolation,
  type PermissionLevel,
  type RefusalReason,
  type SandboxApproveReq,
  type SandboxBackendReport,
  type SandboxCancelReq,
  type SandboxCancelRes,
  type SandboxOutcome,
  type SandboxPolicySnapshot,
  type SandboxReleaseReq,
  type SandboxSubmitReq,
  type SandboxSubmitRes,
} from './contract-sandbox';
import {
  NO_WINDOW_CONTROLS,
  type EventContract,
  type EventName,
  type PlatformAdapter,
  type Unsubscribe,
} from './adapter';
import {
  IPC_CONTRACT_VERSION,
  isAllowedCommand,
  MEMORY_CONTENT_MAX_CHARS,
  NO_CAPABILITIES,
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
  type DebugLogSetReq,
  type DebugLogStatus,
  type EchoReq,
  type EchoRes,
  type EndpointEnableReq,
  type EndpointStatus,
  type EndpointToolPolicy,
  type EndpointToolsRequest,
  type ContentPartInput,
  type McpListToolsRes,
  type MemoryAddReq,
  type MemoryClearRes,
  type MemoryEntry,
  type MemoryListRes,
  type MemoryRefReq,
  type MemoryRes,
  type MemoryScope,
  type MemoryScopeReq,
  type MemoryUpdateReq,
  type MessageHit,
  type MessageHitKind,
  type MessageListRes,
  type MessageRes,
  type MessageRole,
  type ModelCapabilityReport,
  type ModelsListRes,
  type ModelsProbeRes,
  type ModelsProviderRefReq,
  type ModelOption,
  type ModelsRefReq,
  type NetworkScope,
  type ProviderAuth,
  type ProviderView,
  type RiskLevel,
  type ScheduleListRes,
  type ScheduleRes,
  type ScheduleRunListRes,
  type SchedulesCreateReq,
  type SchedulesListReq,
  type SchedulesListRunsReq,
  type SchedulesRefReq,
  type SchedulesSetEnabledReq,
  type ScheduleView,
  type SecretsRefReq,
  type SecretsSetReq,
  type SecretsStatusRes,
  type SecurityPosture,
  type SettingsProviderRefReq,
  type SettingsPutProviderReq,
  type SettingsSetThemeReq,
  type SettingsSetThemeRes,
  type SettingsSnapshot,
  type SkillListing,
  type SkillsListRes,
  type SkillsReadReq,
  type SkillsReadRes,
  type StoreAppendMessageReq,
  type StoreConversationRefReq,
  type StoreCreateConversationReq,
  type StoredMessage,
  type StoredMessageStatus,
  type StoredStopReason,
  type StoreListConversationsReq,
  type StoreListMessagesReq,
  type StoreMessageRefReq,
  type StoreRenameConversationReq,
  type StoreSearchReq,
  type StoreSearchRes,
  type StoreUpdateMessageReq,
  type TokenUsage,
  type ThemePreference,
  type UiLayout,
  type WireProtocolId,
  type WireProtocolOption,
} from './contract';
import {
  DEFAULT_PROJECT_ID,
  DEFAULT_PROJECT_NAME,
  PROJECT_INSTRUCTIONS_MAX_CHARS,
  PROJECT_NAME_MAX_CHARS,
  type ProjectCreateReq,
  type ProjectLayoutRes,
  type ProjectListReq,
  type ProjectListRes,
  type ProjectMoveConversationReq,
  type ProjectRefReq,
  type ProjectRes,
  type ProjectSummary,
  type ProjectUpdateReq,
  type ProjectView,
  type WorkingDirectoryBinding,
} from './contract-project';
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
/** Mirrors `MAX_MODEL_ID_LEN` in `src-tauri/src/ipc/models.rs`. */
const MAX_MODEL_ID_LEN = 200;
/** Mirrors `MAX_SUPPLIED_TITLE` in `src-tauri/src/ipc/store.rs`. */
const MAX_SUPPLIED_TITLE = 200;
/** Mirrors `MAX_TITLE_CHARS` in `src-tauri/src/ipc/schedules.rs`. */
const MAX_SCHEDULE_TITLE = 200;
/** Mirrors `MAX_PROMPT_CHARS` in `src-tauri/src/ipc/schedules.rs`. */
const MAX_SCHEDULE_PROMPT = 8_000;
/** Mirrors `DEFAULT_LIST_LIMIT` in `src-tauri/src/ipc/store.rs`. */
const DEFAULT_LIST_LIMIT = 500;
/** Mirrors `DEFAULT_SEARCH_LIMIT` / `MAX_SEARCH_LIMIT` in the same module. */
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 200;
/** Mirrors `MAX_TOOLS` in `src-tauri/src/ipc/chat.rs`. */
const MAX_TOOLS = 128;
/** Mirrors `MAX_PARTS` in `src-tauri/src/ipc/content.rs`. */
const MAX_PARTS = 256;
/** Mirrors `MAX_TEXT_BYTES` in `src-tauri/src/ipc/content.rs`. */
const MAX_PART_TEXT_BYTES = 1_048_576;
/** Mirrors `MAX_IMAGE_BYTES` in `src-tauri/src/ipc/content.rs`. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Mirrors `DEFAULT_MESSAGE_LIMIT` / `MAX_MESSAGE_LIMIT` in `transcript.rs`. */
const DEFAULT_MESSAGE_LIMIT = 1000;
const MAX_MESSAGE_LIMIT = 5000;
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
  /**
   * What `mcp_list_tools` answers.
   *
   * A browser tab cannot spawn a child process, so this fake cannot connect to
   * an MCP server and must not pretend to. What it can do is stand in for the
   * *answer*, which is what the UI consumes — and it has to, because the
   * interesting states of that command are the ones a developer cannot reach on
   * demand from the real host: a server that will not spawn, a remote entry this
   * build cannot speak to, an unreadable configuration file.
   *
   * Defaults to a machine with no MCP configuration, which is where every user
   * starts and is the only state the real host produces without a file on disk.
   */
  readonly mcp?: McpListToolsRes;
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

/**
 * The protocols this fake can actually speak, which is one: its own.
 *
 * Deliberately **not** a transcription of `vela_core::protocol::catalogue()`,
 * and the reason is the rule this file lives under rather than an oversight.
 * `browser-adapter.ts` is renderer source, and conventions §0.3 says renderer
 * source may not name a backend — `src/platform/no-provider-leak.test.ts`
 * enforces exactly that, over this file among others.
 *
 * It is also the honest answer. This fake has no HTTP client and no adapters;
 * there is nothing behind a protocol choice here, so advertising three would be
 * a claim about capabilities it does not have. It advertises the one dialect it
 * really implements, says so in the label, and echoes back whatever id it was
 * handed — so a component driven against the fake exercises the round trip
 * without either side pretending the fake can reach a model.
 */
const PROTOCOLS: readonly WireProtocolOption[] = [
  {
    id: 'browserFake',
    label: 'In-memory fake',
    summary: 'The browser fake answers everything itself. No endpoint is contacted.',
  },
];

/** What an omitted `protocol` means here. Mirrors the host's `#[serde(default)]`. */
const DEFAULT_PROTOCOL: WireProtocolId = PROTOCOLS[0]?.id ?? '';

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

/**
 * How many bytes this base64 decodes to, or `null` if it is not base64 at all.
 *
 * Mirrors `vela_providers::base64_decode`, character class for character class:
 * the standard and URL-safe alphabets are both accepted, whitespace is skipped
 * because transport encodings wrap lines, `=` ends the payload, and anything
 * else is a rejection rather than a silently different picture.
 *
 * Its own function because the *length* is what the bound is about, and
 * decoding eight megabytes to measure it is the allocation the bound exists to
 * prevent.
 */
function decodedBase64Bytes(data: string): number | null {
  let symbols = 0;
  for (const character of data) {
    if (character === '=') break;
    if (/[A-Za-z0-9+/\-_]/.test(character)) {
      symbols += 1;
      continue;
    }
    if (character === '\n' || character === '\r' || character === ' ' || character === '\t') continue;
    return null;
  }
  return Math.floor((symbols * 6) / 8);
}

/**
 * Mirrors `ContentPartDto::to_provider_part` / `to_store_part` and
 * `check_count` in `src-tauri/src/ipc/content.rs`.
 *
 * **This is why the fake is worth testing against.** An image is base64 at this
 * boundary and raw bytes on either side of it, and the renderer had a helper
 * producing the wrong one of those two nearly identical shapes. Without these
 * checks the fake would cheerfully accept `data: [137, 80, 78, ...]` — a
 * payload the Rust host cannot even deserialise — and every renderer test
 * would pass while the packaged application dropped the picture. A fake that
 * accepts more than the host is not a fake, it is a second implementation with
 * different rules.
 */
function validateContentParts(
  parts: readonly ContentPartInput[],
  whose: string,
  command: CommandName,
): void {
  const invalid = (detail: string): never => {
    throw new PlatformError('INVALID_PAYLOAD', detail, command);
  };
  if (parts.length > MAX_PARTS) {
    invalid(`invalid ${whose}: at most ${MAX_PARTS} parts per message`);
  }
  parts.forEach((part, index) => {
    const where = `${whose}[${index}]`;
    switch (part.kind) {
      case 'text':
      case 'reasoning':
        if (part.text.length > MAX_PART_TEXT_BYTES) {
          invalid(`invalid ${where}.text: exceeds ${MAX_PART_TEXT_BYTES} bytes`);
        }
        return;
      case 'image': {
        if (part.mimeType.trim() === '') {
          invalid(`invalid ${where}.mimeType: must not be blank`);
        }
        // The type says `string`. The host says `String` too, and a renderer
        // that hands it anything else gets a deserialisation failure, not a
        // lenient coercion — so this refuses it here for the same reason.
        if (typeof part.data !== 'string') {
          invalid(`invalid ${where}.data: must be standard base64, not a byte array`);
        }
        const bytes = decodedBase64Bytes(part.data);
        if (bytes === null) invalid(`invalid ${where}.data: not standard base64`);
        if (bytes === 0) invalid(`invalid ${where}.data: must not be empty`);
        if ((bytes ?? 0) > MAX_IMAGE_BYTES) {
          invalid(`invalid ${where}.data: exceeds ${MAX_IMAGE_BYTES} bytes`);
        }
        return;
      }
      case 'toolCall':
        if (part.callId.trim() === '') invalid(`invalid ${where}.callId: must not be blank`);
        if (part.name.trim() === '') invalid(`invalid ${where}.name: must not be blank`);
        return;
      case 'toolResult':
        if (part.callId.trim() === '') invalid(`invalid ${where}.callId: must not be blank`);
        if (part.content.length > MAX_PART_TEXT_BYTES) {
          invalid(`invalid ${where}.content: exceeds ${MAX_PART_TEXT_BYTES} bytes`);
        }
        return;
    }
  });
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
/* the local endpoint — the fake's stand-in for `EndpointControl`             */
/* -------------------------------------------------------------------------- */

/** The state every launch starts in, and the one `disable` returns to. */
const ENDPOINT_OFF: EndpointStatus = {
  state: 'off',
  address: null,
  providerId: null,
  toolsEnabled: false,
  toolPolicy: null,
  loopback: false,
  detail: null,
};

/**
 * What the fake answers when asked for port `0`.
 *
 * A real host is given a port by the operating system. Echoing `0` back would
 * be the fake teaching the UI that `:0` is a thing a user sees, so it picks a
 * number in the ephemeral range instead. Fixed rather than random: a fake that
 * answers differently every run is a fake nothing can assert against.
 */
const FAKE_EPHEMERAL_PORT = 49_871;

interface BoundAddress {
  readonly host: string;
  readonly port: number;
  readonly loopback: boolean;
  /** IPv6 literals are written back inside brackets, as they were supplied. */
  readonly bracketed: boolean;
}

/**
 * Mirrors `std::net::SocketAddr`'s `FromStr`, which is what the host parses
 * `bind` with.
 *
 * The strictness is the point, not an omission: `SocketAddr` accepts an **IP
 * literal and a port**, and nothing else. `localhost:8034` does not parse, and
 * neither does a bare port. A fake that were more permissive would let the
 * browser build accept an address the packaged app refuses, which is the exact
 * class of drift `docs/architecture/conventions.md` §8 makes the host
 * authoritative over.
 */
function parseBindAddress(raw: string): BoundAddress | null {
  const text = raw.trim();
  const bracketed = text.startsWith('[');
  const split = bracketed ? text.indexOf(']:') : text.lastIndexOf(':');
  if (split < 0) return null;
  const host = bracketed ? text.slice(1, split) : text.slice(0, split);
  const portText = text.slice(bracketed ? split + 2 : split + 1);

  if (!/^\d{1,5}$/.test(portText)) return null;
  const port = Number(portText);
  if (port > 65_535) return null;

  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (octets !== null) {
    const parts = octets.slice(1).map(Number);
    if (bracketed || parts.some((part) => part > 255)) return null;
    // `127.0.0.0/8`, all of it — `IpAddr::is_loopback` is not a `127.0.0.1`
    // comparison, and neither is this.
    return { host, port, loopback: parts[0] === 127, bracketed: false };
  }

  // IPv6, only in brackets, and only the two forms a user actually types. A
  // full IPv6 parser here would be more code than the thing it checks; what
  // matters is that `[::1]` is loopback and `[::]` is not.
  if (bracketed && /^[0-9a-fA-F:]+$/.test(host)) {
    return { host, port, loopback: host === '::1' || host === '0:0:0:0:0:0:0:1', bracketed: true };
  }
  return null;
}

/**
 * Mirrors `vela_endpoint::policy::ToolPolicy::resolve`, arm for arm.
 *
 * **This is a security rule, so the fake implements it rather than assuming
 * it.** The table below is the whole of it: disabling wins everywhere, loopback
 * defaults on, anything else defaults off, and forcing tools onto an address
 * other machines can reach needs a confirmation or it fails closed.
 */
function resolveToolPolicy(
  loopback: boolean,
  tools: EndpointToolsRequest,
  confirmed: boolean,
): { readonly enabled: boolean; readonly reason: EndpointToolPolicy } {
  if (tools === 'off') return { enabled: false, reason: 'forced-off' };
  if (tools === 'default') {
    return loopback
      ? { enabled: true, reason: 'loopback-default' }
      : { enabled: false, reason: 'exposed-default' };
  }
  if (loopback || confirmed) return { enabled: true, reason: 'forced-on' };
  return { enabled: false, reason: 'exposed-enable-unconfirmed' };
}

/* -------------------------------------------------------------------------- */
/* store — the fake's stand-in for the SQLite tables                          */
/* -------------------------------------------------------------------------- */

/**
 * Stands in for a `messages` row plus its `message_parts` rows.
 *
 * Parts are the single source of truth here as they are in SQLite: the answer
 * text and the reasoning text are *derived* from them by {@link answerTextOf}
 * and {@link reasoningTextOf}, never stored twice. A fake that kept its own
 * flattened copy could agree with the host on writes and disagree on reads.
 */
interface FakeMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly seq: number;
  readonly role: MessageRole;
  status: StoredMessageStatus;
  parts: ContentPartInput[];
  readonly providerId: string | null;
  readonly modelId: string | null;
  /** Who answered, kept apart from who was asked. `null` is "not recorded". */
  readonly answeredByProviderId: string | null;
  readonly answeredByModelId: string | null;
  usage: TokenUsage;
  stopReason: StoredStopReason | null;
  errorMessage: string | null;
  readonly createdAtMs: number;
  updatedAtMs: number;
}

const NO_USAGE: TokenUsage = {
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  cachedInputTokens: null,
};

function toStoredMessage(message: FakeMessage): StoredMessage {
  return {
    id: message.id,
    conversationId: message.conversationId,
    seq: message.seq,
    role: message.role,
    status: message.status,
    parts: [...message.parts],
    providerId: message.providerId,
    modelId: message.modelId,
    answeredByProviderId: message.answeredByProviderId,
    answeredByModelId: message.answeredByModelId,
    usage: message.usage,
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
    createdAtMs: message.createdAtMs,
    updatedAtMs: message.updatedAtMs,
  };
}

/** The answer. Reasoning is deliberately not part of it. */
function answerTextOf(message: FakeMessage): string {
  return message.parts
    .filter((part) => part.kind === 'text')
    .map((part) => (part as { readonly text: string }).text)
    .join('\n');
}

/** The thinking, or `undefined` when the message has none. */
function reasoningTextOf(message: FakeMessage): string | undefined {
  const blocks = message.parts
    .filter((part) => part.kind === 'reasoning')
    .map((part) => (part as { readonly text: string }).text);
  return blocks.length === 0 ? undefined : blocks.join('\n');
}

interface FakeConversation {
  readonly id: string;
  title: string;
  readonly createdAtMs: number;
  updatedAtMs: number;
  readonly messages: FakeMessage[];
  /**
   * Which project this conversation is filed under, mirroring
   * `conversations.project_id`. `null` is the store's own "unfiled" state, which
   * `project_move_conversation` moves a conversation out of and never back into
   * — the sentinel default project is where "no project" goes.
   *
   * Deliberately **not** exposed on {@link ConversationSummary}: that shape is
   * frozen without a project id, and inventing one here would put a field on the
   * wire that the host does not send.
   */
  projectId: string | null;
}

/** Stands in for a row of the `projects` table. Never touches a filesystem. */
interface FakeProject {
  readonly id: string;
  name: string;
  instructions: string;
  enabledSkills: readonly string[];
  workingDirectoryPath: string | null;
  readonly createdAtMs: number;
  updatedAtMs: number;
  archivedAtMs: number | null;
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

/**
 * The most runs the fake will hold at once, mirroring `MAX_CONCURRENT_RUNS` in
 * `src-tauri/src/ipc/sandbox.rs`. Two spellings of one number is the parallel
 * pair this repo keeps finding, so it is named on both sides rather than
 * inlined on either.
 */
const SANDBOX_MAX_CONCURRENT_RUNS = 4;

export class BrowserAdapter implements PlatformAdapter {
  readonly kind = 'browser' as const;

  /**
   * A browser tab has no window to minimise, maximise or close, so these do
   * nothing and `isMaximized()` stays `false`. The title bar still draws its
   * three controls: it is one component in both runtimes, and the alternative —
   * hiding them when `kind === 'browser'` — is branching on which adapter is
   * live, which is the one thing {@link AdapterKind} says never to do.
   */
  readonly window = NO_WINDOW_CONTROLS;

  /**
   * Values are held here only so `secrets_status` can answer truthfully. They
   * are never returned by any command — the fake honours the one-way rule that
   * the real host enforces.
   */
  readonly #secrets = new Map<string, string>();
  /** Stands in for the SQLite settings rows. Never holds a credential. */
  readonly #providers = new Map<string, SettingsPutProviderReq>();
  /** Mirrors the host's `CapabilityCache`, keyed `providerId/modelId`. */
  readonly #capabilities = new Map<string, ModelCapabilityReport>();
  /** Endpoints that enumerate their own models. Absent = no listing route. */
  readonly #listings = new Map<string, ModelOption[]>();
  #theme: ThemePreference = 'system';
  readonly #listeners = new Map<string, Set<(payload: unknown) => void>>();
  /** Mirrors `ChatTurns` in the host: id -> "has been cancelled". */
  readonly #turns = new Map<string, { cancelled: boolean }>();
  /** Mirrors the host's run table: id -> lifecycle. Nothing here executes. */
  readonly #sandboxRuns = new Map<
    string,
    { settled: boolean; cancelled: boolean; seq: number }
  >();
  #sandboxPermission: PermissionLevel = 'ask';
  /** Stands in for the SQLite `conversations` and `messages` tables. */
  readonly #conversations = new Map<string, FakeConversation>();
  #conversationSeq = 0;
  /**
   * Stands in for the SQLite `schedules` table.
   *
   * **There is no `schedule_runs` map, and that is not an omission.** Runs are
   * produced by the host's poll thread (`src-tauri/src/scheduler_host.rs`),
   * which has no browser equivalent and no command that could stand in for one
   * — the renderer cannot fire a schedule, by design. So a schedule created
   * against this fake is stored, listed, enabled, disabled and deleted exactly
   * as the host does it, and never fires: `schedules_list_runs` answers an
   * empty list for a schedule that exists and `NOT_FOUND` for one that does
   * not, which are the two states a pane built here can be developed against.
   * Faking a run would mean a second copy of the cadence arithmetic with
   * nothing pinning it to the host's, which is the drift this repo keeps
   * finding in itself.
   */
  readonly #schedules = new Map<string, ScheduleView>();
  #scheduleSeq = 0;
  /**
   * Memory entries by id. Flat rather than bucketed by scope so that
   * `memory_update` and `memory_delete` are id lookups, exactly as they are
   * against the real host; the scope partition is applied on read.
   */
  readonly #memory = new Map<string, MemoryEntry>();
  #memorySeq = 0;
  /**
   * Stands in for the SQLite `projects` table, **seeded exactly as migration 3
   * seeds it**. The default project exists from construction rather than being
   * created on first read, for the reason the migration gives: two readers
   * racing to create a fallback target produce two fallback targets.
   */
  readonly #projects = new Map<string, FakeProject>([
    [
      DEFAULT_PROJECT_ID,
      {
        id: DEFAULT_PROJECT_ID,
        name: DEFAULT_PROJECT_NAME,
        instructions: '',
        enabledSkills: [],
        workingDirectoryPath: null,
        createdAtMs: 0,
        updatedAtMs: 0,
        archivedAtMs: null,
      },
    ],
  ]);
  #projectSeq = 0;
  #layout: UiLayout = {
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    sidebarCollapsed: false,
  };
  /**
   * Mirrors `DebugLogHandle` plus `vela_providers::debuglog`'s slot. Starts
   * off, exactly as the host does at every launch, and is not persisted — a
   * reload of `pnpm dev` puts it back off for the same reason a restart does.
   */
  #debugLogEnabled = false;
  /**
   * Mirrors `EndpointControl`. Off at every construction, exactly as the host
   * is at every launch, and not persisted for the same reason: a local HTTP
   * server is not something to restore from a saved preference.
   */
  #endpoint: EndpointStatus = ENDPOINT_OFF;
  readonly #now: () => number;
  readonly #latencyMs: number;
  readonly #scheduleFrame: (run: () => void) => void;
  /** See {@link BrowserAdapterOptions.mcp}: no servers configured by default. */
  readonly #mcp: McpListToolsRes;

  constructor(options: BrowserAdapterOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#latencyMs = options.latencyMs ?? 0;
    this.#scheduleFrame = options.scheduleFrame ?? ((run) => queueMicrotask(run));
    this.#mcp = options.mcp ?? { configFailure: null, servers: [] };
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
      case 'diagnostics_debug_log_get':
        return this.#debugLogStatus();
      case 'diagnostics_debug_log_set':
        return this.#debugLogSet(payload as DebugLogSetReq);
      case 'diagnostics_echo':
        return this.#echo(payload as EchoReq);
      case 'endpoint_status':
        return this.#endpoint;
      case 'endpoint_enable':
        return this.#endpointEnable(payload as EndpointEnableReq);
      case 'endpoint_disable':
        return this.#endpointDisable();
      case 'mcp_list_tools':
        return this.#mcp;
      case 'memory_add':
        return this.#memoryAdd(payload as MemoryAddReq);
      case 'memory_clear_scope':
        return this.#memoryClearScope(payload as MemoryScopeReq);
      case 'memory_delete':
        return this.#memoryDelete(payload as MemoryRefReq);
      case 'memory_list':
        return this.#memoryList(payload as MemoryScopeReq);
      case 'memory_update':
        return this.#memoryUpdate(payload as MemoryUpdateReq);
      case 'models_capabilities':
        return this.#modelsCapabilities(payload as ModelsRefReq);
      case 'models_list':
        return this.#modelsList(payload as ModelsProviderRefReq);
      case 'models_probe':
        return this.#modelsProbe(payload as ModelsRefReq);
      case 'project_list':
        return this.#projectList(payload as ProjectListReq);
      case 'project_get':
        return this.#projectGet(payload as ProjectRefReq);
      case 'project_create':
        return this.#projectCreate(payload as ProjectCreateReq);
      case 'project_update':
        return this.#projectUpdate(payload as ProjectUpdateReq);
      case 'project_delete':
        return this.#projectDelete(payload as ProjectRefReq);
      case 'project_layout':
      case 'project_reconcile_skills':
        // One operation, two names — exactly as the host has it. Reading a
        // layout has to reconcile anyway, or the mount list would describe the
        // last write rather than the disk.
        return this.#projectLayout(payload as ProjectRefReq);
      case 'project_move_conversation':
        return this.#projectMoveConversation(payload as ProjectMoveConversationReq);
      case 'sandbox_approve':
        return this.#sandboxApprove(payload as SandboxApproveReq);
      case 'sandbox_cancel':
        return this.#sandboxCancel(payload as SandboxCancelReq);
      case 'sandbox_policy':
        return this.#sandboxPolicy();
      case 'sandbox_release':
        return this.#sandboxRelease(payload as SandboxReleaseReq);
      case 'sandbox_report_document':
        return { ok: true } satisfies Ack;
      case 'sandbox_submit':
        return this.#sandboxSubmit(payload as SandboxSubmitReq);
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
      case 'store_append_message':
        return this.#storeAppendMessage(payload as StoreAppendMessageReq);
      case 'store_update_message':
        return this.#storeUpdateMessage(payload as StoreUpdateMessageReq);
      case 'store_list_messages':
        return this.#storeListMessages(payload as StoreListMessagesReq);
      case 'store_delete_message':
        return this.#storeDeleteMessage(payload as StoreMessageRefReq);
      case 'skills_list':
        return this.#skillsList();
      case 'skills_read':
        return this.#skillsRead(payload as SkillsReadReq);
      case 'schedules_create':
        return this.#schedulesCreate(payload as SchedulesCreateReq);
      case 'schedules_delete':
        return this.#schedulesDelete(payload as SchedulesRefReq);
      case 'schedules_list':
        return this.#schedulesList(payload as SchedulesListReq);
      case 'schedules_list_runs':
        return this.#schedulesListRuns(payload as SchedulesListRunsReq);
      case 'schedules_set_enabled':
        return this.#schedulesSetEnabled(payload as SchedulesSetEnabledReq);
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

  /**
   * The canonical skill store, faked.
   *
   * **VERIFIED-BY-FAKE, and narrowly.** These are canned records, not parsed
   * files: this adapter has no filesystem and deliberately no second copy of
   * the SKILL.md parser, because a fake parser that drifts from
   * `src-tauri/crates/vela-skills/src/document.rs` would teach the UI a format
   * the host does not read. What it proves is the protocol shape and that every
   * status the UI must render is reachable in a browser — the valid case, the
   * unparseable one, the unknown name and the traversal attempt. It proves
   * nothing whatsoever about any real skill on any real disk.
   *
   * The broken entry is here on purpose. A fake that only ever answers with
   * healthy rows is how a renderer ends up with no design for the row that says
   * "this skill is installed and cannot be read".
   */
  readonly #skills: readonly SkillListing[] = [
    {
      kind: 'skill',
      directory: 'commit-messages',
      name: 'commit-messages',
      description: 'Writes commit messages in this repository’s house style. Use when committing.',
    },
    { kind: 'invalid', directory: 'half-written', problem: 'missingDescription' },
  ];

  readonly #skillBodies: ReadonlyMap<string, string> = new Map([
    [
      'commit-messages',
      '# Commit messages\n\nSay what changed and why. One subject line, then the reasoning.\n',
    ],
  ]);

  #skillsList(): SkillsListRes {
    return { skills: this.#skills };
  }

  #skillsRead(request: SkillsReadReq): SkillsReadRes {
    // Refused before anything is joined onto a path, which is the host's rule
    // and the reason the host has it — see `SkillProblem` in `contract.ts`.
    // Mirrors `is_single_path_segment` in
    // `src-tauri/crates/vela-skills/src/document.rs`.
    if (
      request.name === '' ||
      request.name === '.' ||
      request.name === '..' ||
      /[/\\<>:"|?*]/.test(request.name)
    ) {
      throw new PlatformError('INVALID_PAYLOAD', 'a skill name must be one path segment');
    }
    const found = this.#skills.find((skill) => skill.directory === request.name);
    if (found === undefined) {
      throw new PlatformError('NOT_FOUND', 'no such skill');
    }
    if (found.kind === 'invalid') {
      return { kind: 'invalid', problem: found.problem };
    }
    return {
      kind: 'skill',
      name: found.name,
      description: found.description,
      body: this.#skillBodies.get(found.directory) ?? '',
      resources: { scripts: [], references: [], assets: [] },
    };
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

  /**
   * The fake has no disk, so it reports a path shaped like the host's and
   * labelled as what it is. A screenshot of this screen must not be mistakable
   * for evidence that anything was written anywhere.
   */
  #debugLogStatus(): DebugLogStatus {
    return {
      enabled: this.#debugLogEnabled,
      path: '(browser fake — no file is written) diagnostics/exchanges.jsonl',
    };
  }

  #debugLogSet(request: DebugLogSetReq): DebugLogStatus {
    this.#debugLogEnabled = request.enabled;
    return this.#debugLogStatus();
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

  /**
   * The local endpoint's switch, faked.
   *
   * **VERIFIED-BY-FAKE, and the boundary matters here more than usual.** No
   * socket is opened. What this reproduces is the *decision* the host makes —
   * which configurations are refused, what a bound address resolves to, and
   * above all the bind-address tool policy, which is a security rule and is
   * therefore worth having the headless UI exercise. What it proves is that the
   * panel renders every state; it is not evidence that any port ever opened.
   *
   * The address rules mirror `SocketAddr::parse`, hostnames included: the host
   * refuses `localhost:8034`, so this must too, or the browser build would
   * teach a user a spelling the real app rejects.
   */
  #endpointEnable(request: EndpointEnableReq): EndpointStatus {
    const bound = parseBindAddress(request.bind);
    if (bound === null) {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        'the address must be written as host:port',
        'endpoint_enable',
      );
    }
    if (request.key.trim() === '') {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        'the local endpoint needs a key: an endpoint anything on the network could use is not a configuration',
        'endpoint_enable',
      );
    }
    const providerId = request.providerId.trim();
    if (providerId === '') {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        'name which configured endpoint should answer here',
        'endpoint_enable',
      );
    }

    // Port 0 means "the operating system chooses". The host answers with the
    // port it was given, so a fake that echoed `0` back would let a panel ship
    // that never renders a real port.
    const port = bound.port === 0 ? FAKE_EPHEMERAL_PORT : bound.port;
    const address = bound.bracketed ? `[${bound.host}]:${port}` : `${bound.host}:${port}`;
    const policy = resolveToolPolicy(
      bound.loopback,
      request.tools ?? 'default',
      request.confirmExposedTools ?? false,
    );

    this.#endpoint = {
      state: 'serving',
      address,
      providerId,
      toolsEnabled: policy.enabled,
      toolPolicy: policy.reason,
      loopback: bound.loopback,
      detail: null,
    };
    return this.#endpoint;
  }

  #endpointDisable(): EndpointStatus {
    this.#endpoint = ENDPOINT_OFF;
    return this.#endpoint;
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
      protocols: PROTOCOLS,
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
      // Echoed exactly as it arrived, and defaulted exactly as `#[serde(default)]`
      // does in the host: absent means the shape most local runtimes serve.
      protocol: stored.protocol ?? DEFAULT_PROTOCOL,
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
  /* models — mirrors `src-tauri/src/ipc/models.rs`                         */
  /*                                                                        */
  /* The host keys its cache on (provider, model) and answers a MISS with   */
  /* the unknown floor rather than NOT_FOUND, because "nothing established" */
  /* is a fact the switcher has to render. This fake does the same.         */
  /* ---------------------------------------------------------------------- */

  /** Mirrors `validated_model_id` / `validated_provider_id` in the host. */
  #modelRef(request: ModelsRefReq, command: CommandName): [string, string] {
    const providerId = request.providerId.trim();
    if (providerId === '') {
      throw new PlatformError('INVALID_PAYLOAD', 'invalid providerId: must not be blank', command);
    }
    const modelId = request.modelId.trim();
    if (modelId === '') {
      throw new PlatformError('INVALID_PAYLOAD', 'invalid modelId: must not be blank', command);
    }
    if (modelId.length > MAX_MODEL_ID_LEN) {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        `invalid modelId: must be at most ${MAX_MODEL_ID_LEN} characters`,
        command,
      );
    }
    return [providerId, modelId];
  }

  #unknownReport(providerId: string, modelId: string): ModelCapabilityReport {
    return {
      providerId,
      modelId,
      capabilities: NO_CAPABILITIES,
      structuredOutput: false,
      toolCallsEmulated: false,
      contextWindowTokens: null,
      maxOutputTokens: null,
      probed: false,
      findings: [],
    };
  }

  #modelsCapabilities(request: ModelsRefReq): ModelCapabilityReport {
    const [providerId, modelId] = this.#modelRef(request, 'models_capabilities');
    return (
      this.#capabilities.get(`${providerId}/${modelId}`) ??
      this.#unknownReport(providerId, modelId)
    );
  }

  /**
   * Mirrors the host's listing: an endpoint that does not enumerate is
   * `enumerated: false` with **no** failure, because that is a supported
   * configuration and not a fault. The fake's default endpoint is one of those,
   * so the UI's free-text path is what gets exercised unless a test seeds
   * otherwise — which is the harder case, and therefore the right default.
   */
  #modelsList(request: ModelsProviderRefReq): ModelsListRes {
    const providerId = request.providerId.trim();
    if (providerId === '') {
      throw new PlatformError('INVALID_PAYLOAD', 'invalid providerId: must not be blank', 'models_list');
    }
    if (!this.#providers.has(providerId)) {
      throw new PlatformError(
        'NOT_FOUND',
        `no provider configured with id \`${providerId}\``,
        'models_list',
      );
    }
    const listed = this.#listings.get(providerId);
    if (listed === undefined) return { models: [], enumerated: false, failure: null };
    return { models: listed, enumerated: true, failure: null };
  }

  /**
   * Probing the fake establishes only what the fake can honestly demonstrate:
   * it streams. Everything else stays unknown, so a UI tested against it
   * under-promises. A test that needs a richer model seeds one.
   */
  #modelsProbe(request: ModelsRefReq): ModelsProbeRes {
    const [providerId, modelId] = this.#modelRef(request, 'models_probe');
    if (!this.#providers.has(providerId)) {
      throw new PlatformError(
        'NOT_FOUND',
        `no provider configured with id \`${providerId}\``,
        'models_probe',
      );
    }
    const key = `${providerId}/${modelId}`;
    const seeded = this.#capabilities.get(key);
    if (seeded !== undefined) return { report: seeded, failure: null };

    const report: ModelCapabilityReport = {
      ...this.#unknownReport(providerId, modelId),
      capabilities: { ...NO_CAPABILITIES, streaming: true },
      probed: true,
      findings: [{ capability: 'streaming', support: 'supported', evidence: 'probed' }],
    };
    this.#capabilities.set(key, report);
    return { report, failure: null };
  }

  /**
   * Test hook: give a model a capability profile, as though it had been probed.
   *
   * Like `seedConversation`, this is a hook on the fake and not a command — it
   * is unreachable from `invoke`, so no renderer code can call it. It exists
   * because the four capability profiles the harness exercises (frontier,
   * mid-local, small-local, hostile) cannot be produced by an in-memory echo,
   * and a UI tested only against "streams, nothing else" would never have its
   * degradation paths driven at all.
   */
  seedCapabilities(report: ModelCapabilityReport): ModelCapabilityReport {
    this.#capabilities.set(`${report.providerId}/${report.modelId}`, report);
    return report;
  }

  /** Test hook: make an endpoint one that enumerates its own models. */
  seedModelListing(providerId: string, models: readonly ModelOption[]): void {
    this.#listings.set(providerId, [...models]);
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
    request.messages.forEach((message, index) => {
      validateContentParts(message.parts ?? [], `messages[${index}].parts`, 'chat_send');
    });
    this.#validateTools(request);
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
          // Also honest, and the reason it is not `null`: this fake has exactly
          // one candidate and never fails over, so the endpoint that answered
          // really is the one addressed. Saying so — rather than leaving it
          // unattributed — is what makes `pnpm dev` exercise the attributed
          // path instead of the "host too old to say" path.
          answeredBy: { providerId: request.providerId, modelId: request.modelId },
        },
      });
    };

    this.#scheduleFrame(step);
    return { turnId: request.turnId, accepted: true };
  }

  /**
   * Mirrors `validated_tools` / `validated_tool_choice` in
   * `src-tauri/src/ipc/chat.rs`. The fake refuses exactly what the host
   * refuses, so a composer that offers a malformed catalogue fails the same way
   * in `pnpm dev` as it does in the packaged app.
   */
  #validateTools(request: ChatSendReq): void {
    const tools = request.tools ?? [];
    if (tools.length > MAX_TOOLS) {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        `invalid tools: at most ${MAX_TOOLS} tools per turn`,
        'chat_send',
      );
    }
    const seen = new Set<string>();
    tools.forEach((tool, index) => {
      const name = tool.name.trim();
      if (name === '') {
        throw new PlatformError(
          'INVALID_PAYLOAD',
          `invalid tools[${index}].name: must not be blank`,
          'chat_send',
        );
      }
      if (
        typeof tool.parameters !== 'object' ||
        tool.parameters === null ||
        Array.isArray(tool.parameters)
      ) {
        throw new PlatformError(
          'INVALID_PAYLOAD',
          `invalid tools[${index}].parameters: must be a JSON Schema object`,
          'chat_send',
        );
      }
      if (seen.has(name)) {
        // A call comes back naming a tool, not an index: two tools with one
        // name make the answer un-routable.
        throw new PlatformError(
          'INVALID_PAYLOAD',
          `invalid tools[${index}].name: \`${name}\` is offered twice`,
          'chat_send',
        );
      }
      seen.add(name);
    });

    const choice = request.toolChoice;
    if (choice?.type === 'named' && !seen.has(choice.name.trim())) {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        `invalid toolChoice: \`${choice.name}\` is not among the tools offered this turn`,
        'chat_send',
      );
    }
    if (choice?.type === 'required' && tools.length === 0) {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        'invalid toolChoice: `required` with no tools offered can never be satisfied',
        'chat_send',
      );
    }
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

  /* ---------------------------------------------------------------------- */
  /* sandbox — mirrors `src-tauri/src/ipc/sandbox.rs`                        */
  /*                                                                        */
  /* **This fake runs nothing, and that is the honest mirror rather than a   */
  /* gap.** A browser tab has no process backend, so it reports the process  */
  /* family at `none` with every guarantee `unenforced` and an empty         */
  /* `languages` list — which is exactly what the real host reports on a     */
  /* machine with no WSL distribution. Every submit is therefore refused,    */
  /* through the same ordered checks the host runs, so a surface built       */
  /* against this fake meets the refusal paths and not only the happy one.   */
  /* VERIFIED-BY-FAKE: nothing here is evidence about isolation.             */
  /* ---------------------------------------------------------------------- */

  #sandboxPolicy(): SandboxPolicySnapshot {
    const nothing: SandboxBackendReport['limits'] = {
      wallClockMs: 'unenforced',
      memoryBytes: 'unenforced',
      cpuMillicores: 'unenforced',
      outputBytes: 'unenforced',
      processes: 'unenforced',
      fileWriteBytes: 'unenforced',
    };
    return {
      permission: this.#sandboxPermission,
      profile: DEFAULT_AUTO_APPROVAL_PROFILE,
      backends: {
        process: {
          isolation: { family: 'process', level: 'none' },
          maximumIsolation: { family: 'process', level: 'none' },
          evidence: 'declared',
          network: 'unenforced',
          filesystem: 'unenforced',
          processTree: 'unenforced',
          limits: nothing,
        },
        document: {
          isolation: { family: 'document', level: 'sameOrigin' },
          maximumIsolation: { family: 'document', level: 'sameOrigin' },
          evidence: 'declared',
          network: 'unenforced',
          filesystem: 'unenforced',
          processTree: 'unenforced',
          limits: nothing,
        },
      },
      // Nothing can be run, so nothing is claimed. A surface reads this rather
      // than submitting and being refused in front of the user.
      languages: [],
      // The guest a process run *would* find itself on, which is a property of
      // the backend rather than of the tab this fake is in. The host answers
      // `posix` because its backend is a Linux namespace; answering something
      // else here would teach a surface to branch on which adapter is live.
      guestPlatform: 'posix',
      activeRuns: this.#sandboxRuns.size,
      maximumConcurrentRuns: SANDBOX_MAX_CONCURRENT_RUNS,
    };
  }

  /** The host's refusal order, mirrored. See `vela_sandbox::admission`. */
  #sandboxRefusal(request: SandboxSubmitReq): RefusalReason {
    if (this.#sandboxPermission === 'off') return 'permissionIsOff';
    if (this.#sandboxRuns.size > SANDBOX_MAX_CONCURRENT_RUNS) return 'tooManyConcurrentRuns';
    if (request.projectId !== DEFAULT_PROJECT_ID) return 'unknownProject';
    const backends = this.#sandboxPolicy().backends;
    const offered: Isolation =
      request.program.kind === 'process'
        ? backends.process.isolation
        : backends.document.isolation;
    if (offered.family !== request.minimumIsolation.family) return 'isolationFamilyMismatch';
    if (!isolationMeets(offered, request.minimumIsolation)) return 'isolationUnavailable';
    return 'languageUnsupported';
  }

  #sandboxSubmit(request: SandboxSubmitReq): SandboxSubmitRes {
    if (request.runId.trim() === '') {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        'invalid runId: must not be blank',
        'sandbox_submit',
      );
    }
    if (this.#sandboxRuns.has(request.runId)) {
      // A failure that rejects the invoke rather than settling the run: pushing
      // a refusal onto that id's stream would tell a different caller their
      // healthy run had failed. The host rejects malformed mounts, guest paths
      // and oversized programs the same way; this fake never reaches those
      // checks, because it refuses every submit `languageUnsupported` first.
      throw new PlatformError(
        'INVALID_PAYLOAD',
        `invalid runId: \`${request.runId}\` is already in flight`,
        'sandbox_submit',
      );
    }
    const run = { settled: false, cancelled: false, seq: 0 };
    this.#sandboxRuns.set(request.runId, run);
    const reason = this.#sandboxRefusal(request);
    this.#scheduleFrame(() => {
      if (run.settled) return;
      run.settled = true;
      const outcome: SandboxOutcome = run.cancelled
        ? { kind: 'cancelled', reason: 'user' }
        : { kind: 'refused', reason, mountIndex: null, protectedRoot: null };
      this.emit('sandbox:event', {
        runId: request.runId,
        seq: run.seq++,
        event: {
          type: 'settled',
          outcome,
          usage: {
            wallClockMs: 0,
            cpuMs: null,
            peakMemoryBytes: null,
            outputBytes: 0,
            droppedOutputBytes: 0,
          },
        },
      });
    });
    return { runId: request.runId, admitted: true };
  }

  #sandboxCancel(request: SandboxCancelReq): SandboxCancelRes {
    const run = this.#sandboxRuns.get(request.runId);
    // `false` when the run had already settled — a race, not an error.
    if (run === undefined || run.settled) return { cancelled: false };
    run.cancelled = true;
    return { cancelled: true };
  }

  #sandboxRelease(request: SandboxReleaseReq): Ack {
    const run = this.#sandboxRuns.get(request.runId);
    if (run !== undefined) {
      if (run.settled) {
        this.#sandboxRuns.delete(request.runId);
      } else {
        run.cancelled = true;
      }
    }
    return { ok: true };
  }

  #sandboxApprove(request: SandboxApproveReq): Ack {
    // No run in this fake ever waits for a person — every submit is refused
    // before approval is reached — so every digest is one that was never handed
    // out, which is the host's own answer to a mismatch.
    throw new PlatformError(
      'INVALID_PAYLOAD',
      `approval digest does not match for run \`${request.runId}\``,
      'sandbox_approve',
    );
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

  /**
   * The host's `validate_text`, in the fake. Same trim, same blankness rule,
   * same ceiling — the message text matters because `PlatformError.message` is
   * the only thing a test can compare across the two halves.
   */
  #validScheduleText(
    field: 'title' | 'prompt',
    raw: string,
    max: number,
    command: CommandName,
  ): string {
    const text = raw.trim();
    if (text === '') {
      throw new PlatformError('INVALID_PAYLOAD', `invalid ${field}: must not be blank`, command);
    }
    if ([...text].length > max) {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        `invalid ${field}: must be at most ${max} characters`,
        command,
      );
    }
    return text;
  }

  #requireSchedule(id: string, command: CommandName): ScheduleView {
    const found = this.#schedules.get(id.trim());
    if (found === undefined) {
      throw new PlatformError('NOT_FOUND', `no schedule with id \`${id}\``, command);
    }
    return found;
  }

  /* ---------------------------------------------------------------------- */
  /* projects                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * **VERIFIED-BY-FAKE, and this surface is where that label matters most.**
   *
   * A browser tab has no filesystem, so nothing here creates a workspace,
   * probes a link strategy, or mounts a skill. What it does reproduce is every
   * rule the host enforces *above* the disk: the seeded default project, the
   * `isDefault` flag, the refusals, the replacement semantics of
   * `enabledSkills`, and the reassignment on delete. What it reports for the
   * layout is labelled as a fake in the path string itself, so a screenshot of
   * this screen cannot be mistaken for evidence that anything was written.
   */
  #requireProject(id: string, command: CommandName): FakeProject {
    const found = this.#projects.get(id.trim());
    if (found === undefined) {
      throw new PlatformError('NOT_FOUND', `no project with id \`${id}\``, command);
    }
    return found;
  }

  #schedulesCreate(request: SchedulesCreateReq): ScheduleRes {
    const title = this.#validScheduleText(
      'title',
      request.title,
      MAX_SCHEDULE_TITLE,
      'schedules_create',
    );
    const prompt = this.#validScheduleText(
      'prompt',
      request.prompt,
      MAX_SCHEDULE_PROMPT,
      'schedules_create',
    );

    this.#scheduleSeq += 1;
    const now = this.#now();
    const schedule: ScheduleView = {
      id: `sched_${this.#scheduleSeq}`,
      title,
      prompt,
      cadence: request.cadence,
      nextRunAtMs: request.firstRunAtMs,
      enabled: true,
      projectId: request.projectId ?? null,
      missedRuns: 0,
      createdAtMs: now,
      updatedAtMs: now,
    };
    this.#schedules.set(schedule.id, schedule);
    return { schedule };
  }

  #schedulesList(request: SchedulesListReq): ScheduleListRes {
    // Soonest-due first, so the list reads as a queue — the host's ORDER BY.
    const schedules = [...this.#schedules.values()]
      .filter((schedule) => (request.includeDisabled === true ? true : schedule.enabled))
      .sort((a, b) => a.nextRunAtMs - b.nextRunAtMs || (a.id < b.id ? -1 : 1));
    return { schedules };
  }

  #schedulesSetEnabled(request: SchedulesSetEnabledReq): ScheduleRes {
    const existing = this.#requireSchedule(request.scheduleId, 'schedules_set_enabled');
    const schedule: ScheduleView = {
      ...existing,
      enabled: request.enabled,
      updatedAtMs: this.#now(),
    };
    this.#schedules.set(schedule.id, schedule);
    return { schedule };
  }

  #schedulesDelete(request: SchedulesRefReq): Ack {
    // NOT_FOUND rather than a silent success, exactly as the host: the user
    // just asked to destroy a schedule and its whole history.
    const schedule = this.#requireSchedule(request.scheduleId, 'schedules_delete');
    this.#schedules.delete(schedule.id);
    return { ok: true };
  }

  #schedulesListRuns(request: SchedulesListRunsReq): ScheduleRunListRes {
    // The schedule must exist — an empty list for an id that was deleted would
    // read as "it never ran" rather than "it is gone".
    this.#requireSchedule(request.scheduleId, 'schedules_list_runs');
    return { runs: [] };
  }

  #summariseProject(project: FakeProject): ProjectSummary {
    const filed = [...this.#conversations.values()].filter(
      (conversation) => conversation.projectId === project.id,
    );
    const lastActive = filed.reduce<number | null>(
      (latest, conversation) => Math.max(latest ?? 0, conversation.updatedAtMs),
      null,
    );
    return {
      id: project.id,
      name: project.name,
      // The flag, not a comparison against the id — that is the host's job and
      // this fake is standing in for the host.
      isDefault: project.id === DEFAULT_PROJECT_ID,
      workingDirectoryPath: project.workingDirectoryPath,
      createdAtMs: project.createdAtMs,
      updatedAtMs: project.updatedAtMs,
      lastActiveAtMs: lastActive,
      conversationCount: filed.length,
      archivedAtMs: project.archivedAtMs,
    };
  }

  #viewProject(project: FakeProject): ProjectView {
    return {
      summary: this.#summariseProject(project),
      instructions: project.instructions,
      enabledSkills: [...project.enabledSkills],
    };
  }

  #validProjectName(raw: string, command: CommandName): string {
    const name = raw.trim();
    if (name === '') {
      throw new PlatformError('INVALID_PAYLOAD', 'invalid name: must not be blank', command);
    }
    // Scalar values, matching the host's `chars().count()`. `[...name]`
    // iterates code points; `name.length` would count UTF-16 units and disagree
    // with Rust on any name containing an emoji.
    if ([...name].length > PROJECT_NAME_MAX_CHARS) {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        `invalid name: must be at most ${PROJECT_NAME_MAX_CHARS} characters`,
        command,
      );
    }
    return name;
  }

  #validInstructions(raw: string, command: CommandName): string {
    if ([...raw].length > PROJECT_INSTRUCTIONS_MAX_CHARS) {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        `invalid instructions: must be at most ${PROJECT_INSTRUCTIONS_MAX_CHARS} characters`,
        command,
      );
    }
    return raw;
  }

  /**
   * Refuses two enabled names that would land on one path.
   *
   * The real host measures its filesystem before deciding what folds together.
   * This fake has no filesystem, so it stands in with a case-insensitive
   * comparison — which is the answer on the platform Vela ships to, and is
   * therefore the useful one for a UI to develop against. It is a stand-in and
   * not a second source of truth: **a component may not do this itself**, and
   * nothing under `src/features/` may pre-filter the list it sends.
   */
  #validEnabledSkills(names: readonly string[], command: CommandName): readonly string[] {
    names.forEach((name, index) => {
      if (name.trim() === '') {
        throw new PlatformError(
          'INVALID_PAYLOAD',
          `invalid enabledSkills[${index}]: must not be blank`,
          command,
        );
      }
    });
    for (let later = 0; later < names.length; later += 1) {
      for (let earlier = 0; earlier < later; earlier += 1) {
        const a = names[earlier] as string;
        const b = names[later] as string;
        if (a === b || a.toLowerCase() === b.toLowerCase()) {
          throw new PlatformError(
            'INVALID_PAYLOAD',
            `invalid enabledSkills: \`${a}\` and \`${b}\` are one directory on this ` +
              'filesystem; disable one of them',
            command,
          );
        }
      }
    }
    return [...names];
  }

  /**
   * The three refusals on {@link WorkingDirectoryBinding}, minus the two this
   * runtime cannot answer.
   *
   * Only "must be absolute" is checked, and it is checked with a pattern rather
   * than by asking a path API, because there is no path API here. The
   * containment rules — not inside the application-data directory, not inside
   * another project's root — need to know where that directory *is*, and a
   * browser tab does not. A caller that needs those enforced is talking to the
   * host, which does enforce them.
   */
  #validWorkingDirectory(
    binding: WorkingDirectoryBinding,
    command: CommandName,
  ): string | null {
    if (binding.kind === 'none') return null;
    const path = binding.path.trim();
    const absolute = /^([A-Za-z]:[\\/]|[\\/]{2}[^\\/]|\/)/u.test(path);
    if (!absolute) {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        'invalid workingDirectory: must be an absolute path',
        command,
      );
    }
    return path;
  }

  #projectList(request: ProjectListReq): ProjectListRes {
    const includeArchived = request.includeArchived ?? false;
    const projects = [...this.#projects.values()]
      .filter((project) => includeArchived || project.archivedAtMs === null)
      // Mirrors `ORDER BY p.name COLLATE NOCASE, p.id`.
      .sort(
        (a, b) =>
          a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id),
      )
      .map((project) => this.#summariseProject(project));
    return { projects };
  }

  #projectGet(request: ProjectRefReq): ProjectRes {
    return { project: this.#viewProject(this.#requireProject(request.projectId, 'project_get')) };
  }

  #projectCreate(request: ProjectCreateReq): ProjectRes {
    const name = this.#validProjectName(request.name, 'project_create');
    const instructions = this.#validInstructions(request.instructions ?? '', 'project_create');
    const enabledSkills = this.#validEnabledSkills(request.enabledSkills ?? [], 'project_create');
    const workingDirectoryPath =
      request.workingDirectory === undefined
        ? null
        : this.#validWorkingDirectory(request.workingDirectory, 'project_create');

    this.#projectSeq += 1;
    const now = this.#now();
    const project: FakeProject = {
      id: `proj_${this.#projectSeq}`,
      name,
      instructions,
      enabledSkills,
      workingDirectoryPath,
      createdAtMs: now,
      updatedAtMs: now,
      archivedAtMs: null,
    };
    this.#projects.set(project.id, project);
    return { project: this.#viewProject(project) };
  }

  #projectUpdate(request: ProjectUpdateReq): ProjectRes {
    const project = this.#requireProject(request.projectId, 'project_update');
    // Everything is validated before anything is written, so a refused update
    // changes nothing — including the fields beside the one that was refused.
    const name =
      request.name === undefined
        ? undefined
        : this.#validProjectName(request.name, 'project_update');
    const instructions =
      request.instructions === undefined
        ? undefined
        : this.#validInstructions(request.instructions, 'project_update');
    const enabledSkills =
      request.enabledSkills === undefined
        ? undefined
        : this.#validEnabledSkills(request.enabledSkills, 'project_update');
    const workingDirectoryPath =
      request.workingDirectory === undefined
        ? undefined
        : this.#validWorkingDirectory(request.workingDirectory, 'project_update');

    if (name !== undefined) project.name = name;
    if (instructions !== undefined) project.instructions = instructions;
    if (enabledSkills !== undefined) project.enabledSkills = enabledSkills;
    if (workingDirectoryPath !== undefined) project.workingDirectoryPath = workingDirectoryPath;
    if (request.archived !== undefined) {
      project.archivedAtMs = request.archived ? this.#now() : null;
    }
    project.updatedAtMs = this.#now();
    return { project: this.#viewProject(project) };
  }

  #projectDelete(request: ProjectRefReq): Ack {
    const project = this.#requireProject(request.projectId, 'project_delete');
    if (project.id === DEFAULT_PROJECT_ID) {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        'invalid projectId: the default project cannot be deleted; it is where every ' +
          "other project's conversations go",
        'project_delete',
      );
    }
    for (const conversation of this.#conversations.values()) {
      if (conversation.projectId === project.id) {
        // Reassigned, never deleted. A user who wants them gone deletes them,
        // with `store_delete_conversation`, having been asked.
        conversation.projectId = DEFAULT_PROJECT_ID;
      }
    }
    this.#projects.delete(project.id);
    return { ok: true };
  }

  #projectLayout(request: ProjectRefReq): ProjectLayoutRes {
    const project = this.#requireProject(request.projectId, 'project_layout');
    // Paths shaped like the host's and labelled as what they are. Nothing here
    // exists on any disk, and the string says so rather than leaving a
    // screenshot to imply otherwise.
    const fake = '(browser fake — nothing is created)';
    const root = `${fake} projects/${project.id}`;
    return {
      layout: {
        projectId: project.id,
        paths: {
          root,
          workspace: `${root}/workspace`,
          skillsMount: `${root}/skills`,
          skillStore: `${fake} skills`,
        },
        // `probeFailed` is the honest member: it means the host does not know
        // what this machine supports, which is exactly true of a browser tab.
        // Reporting `junction` would claim a reparse point that does not exist.
        linkStrategy: { kind: 'copy', reason: 'probeFailed' },
        workingDirectory:
          project.workingDirectoryPath === null
            ? { kind: 'none' }
            : // Never `bound`: nothing here can stat a directory, and `bound`
              // asserts one is there and says whether it is writable. The
              // contract has no "not measured" member — `WorkingDirectory` is a
              // union of three answers about a real disk — so the fake reports
              // the state that is true of this runtime, where no directory
              // exists at any path. It is a statement about a browser tab and
              // never evidence about the user's own folder.
              { kind: 'unavailable', path: project.workingDirectoryPath, problem: 'notFound' },
        // One entry per enabled skill, all unavailable — which is precisely
        // what the host reports against an empty canonical skill store.
        mounts: project.enabledSkills.map((name) => ({
          name,
          source: `${fake} skills/${name}`,
          status: { kind: 'unavailable', problem: 'skillNotFound' },
        })),
        repaired: [],
      },
    };
  }

  #projectMoveConversation(request: ProjectMoveConversationReq): Ack {
    const conversation = this.#requireConversation(
      request.conversationId,
      'project_move_conversation',
    );
    const project = this.#requireProject(request.projectId, 'project_move_conversation');
    conversation.projectId = project.id;
    return { ok: true };
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
      projectId: null,
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
      const derived = deriveTitle(answerTextOf(message));
      if (derived !== null) {
        conversation.title = derived;
        conversation.updatedAtMs = this.#now();
        break;
      }
    }
    return { conversation: this.#summarise(conversation) };
  }

  /* -- memory ------------------------------------------------------------ */

  /**
   * The scope's partition key, as one string.
   *
   * A map keyed by this is how the fake keeps MEM-2's isolation with no chance
   * of a query that forgets to filter: two scopes are two buckets, so a read
   * of one cannot reach the other even by accident. The host gets the same
   * property from `WHERE scope_kind = ? AND project_id IS ?` and a test.
   */
  #memoryBucket(scope: MemoryScope, command: CommandName): string {
    if (scope.kind === 'global') return 'global';
    if (scope.projectId.trim() === '') {
      throw new PlatformError('INVALID_PAYLOAD', 'invalid projectId: must not be blank', command);
    }
    return `project:${scope.projectId.trim()}`;
  }

  #memoryRequire(entryId: string, command: CommandName): MemoryEntry {
    const entry = this.#memory.get(entryId.trim());
    if (entry === undefined) {
      throw new PlatformError('NOT_FOUND', `no memoryEntry with id \`${entryId}\``, command);
    }
    return entry;
  }

  #memoryValidateContent(content: string, command: CommandName): string {
    if (content.trim() === '') {
      throw new PlatformError('INVALID_PAYLOAD', 'invalid content: must not be blank', command);
    }
    if ([...content].length > MEMORY_CONTENT_MAX_CHARS) {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        `invalid content: must be at most ${String(MEMORY_CONTENT_MAX_CHARS)} characters`,
        command,
      );
    }
    return content.trim();
  }

  #memoryList(request: MemoryScopeReq): MemoryListRes {
    const bucket = this.#memoryBucket(request.scope, 'memory_list');
    // Pinned first, then most recently updated first — the host's ORDER BY,
    // reproduced here because a consumer that takes the first N under a budget
    // must take the same N against either host.
    const entries = [...this.#memory.values()]
      .filter((entry) => this.#memoryBucket(entry.scope, 'memory_list') === bucket)
      .sort((left, right) => {
        if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
        if (left.updatedAtMs !== right.updatedAtMs) return right.updatedAtMs - left.updatedAtMs;
        return right.id.localeCompare(left.id);
      });
    return { entries };
  }

  #memoryAdd(request: MemoryAddReq): MemoryRes {
    const content = this.#memoryValidateContent(request.content, 'memory_add');
    // Validates the scope before anything is written, so a bad project id
    // cannot leave a row in a bucket nothing lists.
    this.#memoryBucket(request.scope, 'memory_add');
    this.#memorySeq += 1;
    const now = this.#now();
    const source = request.sourceConversationId?.trim() ?? '';
    const entry: MemoryEntry = {
      id: `mem_${String(this.#memorySeq)}`,
      scope: request.scope,
      category: request.category,
      content,
      pinned: false,
      sourceConversationId: source === '' ? null : source,
      createdAtMs: now,
      updatedAtMs: now,
    };
    this.#memory.set(entry.id, entry);
    return { entry };
  }

  #memoryUpdate(request: MemoryUpdateReq): MemoryRes {
    const existing = this.#memoryRequire(request.entryId, 'memory_update');
    const content =
      request.content === undefined
        ? existing.content
        : this.#memoryValidateContent(request.content, 'memory_update');
    // The scope is not patchable here for the same reason it is not in the
    // host: moving an entry between scopes is a separate decision.
    const entry: MemoryEntry = {
      ...existing,
      category: request.category ?? existing.category,
      content,
      pinned: request.pinned ?? existing.pinned,
      updatedAtMs: this.#now(),
    };
    this.#memory.set(entry.id, entry);
    return { entry };
  }

  #memoryDelete(request: MemoryRefReq): Ack {
    const entry = this.#memoryRequire(request.entryId, 'memory_delete');
    this.#memory.delete(entry.id);
    return { ok: true };
  }

  #memoryClearScope(request: MemoryScopeReq): MemoryClearRes {
    const bucket = this.#memoryBucket(request.scope, 'memory_clear_scope');
    let removed = 0;
    for (const entry of [...this.#memory.values()]) {
      if (this.#memoryBucket(entry.scope, 'memory_clear_scope') !== bucket) continue;
      this.#memory.delete(entry.id);
      removed += 1;
    }
    return { removed };
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
          const fields: readonly (readonly [MessageHitKind, string | undefined])[] = [
            ['reasoning', reasoningTextOf(message)],
            ['answer', answerTextOf(message)],
          ];
          for (const [kind, text] of fields) {
            if (text === undefined || text === '' || !matchesTerms(text, terms)) continue;
            messages.push({
              messageId: message.id,
              conversationId: conversation.id,
              conversationTitle: conversation.title,
              kind,
              snippet: snippetOf(text, terms),
              createdAtMs: message.createdAtMs,
            });
          }
        }
      }
    }

    return { conversations, messages: messages.slice(0, limit) };
  }

  /* ---------------------------------------------------------------------- */
  /* the transcript                                                         */
  /* ---------------------------------------------------------------------- */

  #storeAppendMessage(request: StoreAppendMessageReq): MessageRes {
    const conversation = this.#requireConversation(
      request.conversationId,
      'store_append_message',
    );
    if (request.parts.length === 0) {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        'invalid parts: a message needs at least one part',
        'store_append_message',
      );
    }
    validateContentParts(request.parts, 'parts', 'store_append_message');
    const now = this.#now();
    const message: FakeMessage = {
      id: `${conversation.id}_msg_${conversation.messages.length + 1}`,
      conversationId: conversation.id,
      seq: conversation.messages.length,
      role: request.role,
      status: request.status ?? 'complete',
      parts: [...request.parts],
      providerId: request.providerId ?? null,
      modelId: request.modelId ?? null,
      // Mirrors the host: an omitted attribution stays absent. Defaulting these
      // to `providerId` would make the fake disagree with SQLite about the one
      // thing they exist to record.
      answeredByProviderId: request.answeredByProviderId ?? null,
      answeredByModelId: request.answeredByModelId ?? null,
      usage: request.usage ?? NO_USAGE,
      stopReason: request.stopReason ?? null,
      errorMessage: request.errorMessage ?? null,
      createdAtMs: now,
      updatedAtMs: now,
    };
    conversation.messages.push(message);
    conversation.updatedAtMs = now;
    return { message: toStoredMessage(message) };
  }

  #storeUpdateMessage(request: StoreUpdateMessageReq): MessageRes {
    if (request.parts !== undefined && request.parts.length === 0) {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        'invalid parts: a message needs at least one part',
        'store_update_message',
      );
    }
    if (request.parts !== undefined) {
      validateContentParts(request.parts, 'parts', 'store_update_message');
    }
    const found = this.#findMessage(request.messageId, 'store_update_message');
    // An omitted field leaves the value alone. There is no way to clear one.
    if (request.parts !== undefined) found.parts = [...request.parts];
    if (request.status !== undefined) found.status = request.status;
    if (request.usage !== undefined) found.usage = request.usage;
    if (request.stopReason !== undefined) found.stopReason = request.stopReason;
    if (request.errorMessage !== undefined) found.errorMessage = request.errorMessage;
    found.updatedAtMs = this.#now();
    return { message: toStoredMessage(found) };
  }

  #storeListMessages(request: StoreListMessagesReq): MessageListRes {
    const conversation = this.#requireConversation(request.conversationId, 'store_list_messages');
    const limit = Math.min(request.limit ?? DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT);
    const includeReasoning = request.includeReasoning ?? true;
    const messages = conversation.messages
      .filter((message) => request.afterSeq === undefined || message.seq > request.afterSeq)
      .slice(0, limit)
      .map((message) => {
        const stored = toStoredMessage(message);
        // A projection, never a delete — exactly as `MessageQuery` describes it.
        return includeReasoning
          ? stored
          : { ...stored, parts: stored.parts.filter((part) => part.kind !== 'reasoning') };
      });
    return { messages };
  }

  #storeDeleteMessage(request: StoreMessageRefReq): Ack {
    const id = request.messageId.trim();
    if (id === '') {
      throw new PlatformError(
        'INVALID_PAYLOAD',
        'invalid messageId: must not be blank',
        'store_delete_message',
      );
    }
    for (const conversation of this.#conversations.values()) {
      const index = conversation.messages.findIndex((message) => message.id === id);
      if (index >= 0) {
        conversation.messages.splice(index, 1);
        return { ok: true };
      }
    }
    throw new PlatformError('NOT_FOUND', `no message with id \`${id}\``, 'store_delete_message');
  }

  #findMessage(rawId: string, command: CommandName): FakeMessage {
    const id = rawId.trim();
    if (id === '') {
      throw new PlatformError('INVALID_PAYLOAD', 'invalid messageId: must not be blank', command);
    }
    for (const conversation of this.#conversations.values()) {
      const found = conversation.messages.find((message) => message.id === id);
      if (found !== undefined) return found;
    }
    throw new PlatformError('NOT_FOUND', `no message with id \`${id}\``, command);
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
        conversationId: id,
        seq: index,
        role: 'user' as MessageRole,
        status: 'complete' as StoredMessageStatus,
        parts: [
          ...(message.reasoning === undefined
            ? []
            : [{ kind: 'reasoning', text: message.reasoning, signature: null, redacted: false } as ContentPartInput]),
          { kind: 'text', text: message.text } as ContentPartInput,
        ],
        providerId: null,
        modelId: null,
        answeredByProviderId: null,
        answeredByModelId: null,
        usage: NO_USAGE,
        stopReason: null,
        errorMessage: null,
        createdAtMs: input.createdAtMs ?? now,
        updatedAtMs: input.createdAtMs ?? now,
      })),
      projectId: null,
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
