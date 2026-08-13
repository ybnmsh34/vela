/**
 * THE IPC CONTRACT — single source of truth for the renderer side.
 *
 * This file mirrors `src-tauri/src/ipc/`. A Rust test
 * (`ipc::tests::rust_and_typescript_allowlists_are_identical`) reads this file
 * and fails `cargo test` if the two allowlists drift apart, so a command can
 * never exist on one side only.
 *
 * ## Adding a command
 *  1. Add the request/response interfaces below.
 *  2. Add the entry to {@link IpcContract}.
 *  3. Add the name to {@link COMMAND_ALLOWLIST} (keep it sorted).
 *  4. Implement it in `src-tauri/src/ipc/<domain>.rs` and register it in both
 *     `COMMAND_ALLOWLIST` (Rust) and `generate_handler!` in `lib.rs`.
 *  5. Implement it in `BrowserAdapter` so the UI still runs headlessly.
 * Miss any of these and either `cargo test` or `pnpm test` fails. That is the
 * point.
 *
 * ## Rules
 *  - Every command takes exactly one payload object and returns one object.
 *    Never `void`, never a bare scalar — use {@link EmptyPayload} / {@link Ack}.
 *  - Field names are camelCase on the wire; Rust structs carry
 *    `#[serde(rename_all = "camelCase")]`.
 *  - No secret value ever appears in a response type. There is no
 *    `secrets_get`, and adding one is a review-blocking change.
 */

/** Bump together with `IPC_CONTRACT_VERSION` in `src-tauri/src/ipc/mod.rs`. */
export const IPC_CONTRACT_VERSION = 1;

/** Payload for commands that take no input. */
export type EmptyPayload = Record<string, never>;

/** Response for commands that return no data. */
export interface Ack {
  readonly ok: boolean;
}

/* -------------------------------------------------------------------------- */
/* app                                                                        */
/* -------------------------------------------------------------------------- */

export interface AppInfo {
  readonly name: string;
  readonly version: string;
  readonly contractVersion: number;
  readonly os: string;
  readonly arch: string;
  /**
   * Which credential backend the host actually used: `os-keychain` or
   * `memory-fake`. Surfaced so diagnostics can never imply a real keychain was
   * exercised when it was not.
   */
  readonly secretBackend: string;
}

/* -------------------------------------------------------------------------- */
/* diagnostics                                                                */
/* -------------------------------------------------------------------------- */

export interface EchoReq {
  readonly message: string;
}

export interface EchoRes {
  readonly message: string;
  readonly receivedAtMs: number;
}

/* -------------------------------------------------------------------------- */
/* secrets                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * An opaque pointer to a credential. Carries no secret material, so it is safe
 * to hold in renderer state, log, or persist.
 */
export interface SecretRefDto {
  readonly providerId: string;
  /** Omit for the provider's primary credential. */
  readonly field?: string;
}

export interface SecretsSetReq extends SecretRefDto {
  readonly value: string;
}

export type SecretsRefReq = SecretRefDto;

export interface SecretsStatusRes {
  /**
   * `false` is NOT an error. A provider with no stored credential may be fully
   * usable — many local endpoints have no auth at all. Consult the provider's
   * auth policy before treating this as a problem.
   */
  readonly present: boolean;
}

/* -------------------------------------------------------------------------- */
/* settings                                                                   */
/* -------------------------------------------------------------------------- */

export type ThemePreference = 'light' | 'dark' | 'system';

/**
 * The transport shape of a provider's credential, if it has one.
 *
 * The renderer picks a shape; it never names a keychain entry and never sees a
 * value. `{ type: 'none' }` is a first-class choice, not an empty state — most
 * local runtimes take no credential at all.
 */
export type AuthMode =
  | { readonly type: 'none' }
  | { readonly type: 'bearerToken' }
  | { readonly type: 'apiKeyHeader'; readonly header: string }
  | { readonly type: 'apiKeyQuery'; readonly param: string };

/** Whether a credential is needed. Only `required` can make a config invalid. */
export type AuthRequirement = 'notRequired' | 'optional' | 'required';

/** The outcome of the host's auth check. Two of the three are success states. */
export type CredentialCheck = 'satisfied' | 'satisfiedWithoutCredential' | 'missingRequired';

export type ProviderKind = 'local' | 'remoteApi' | 'remoteSubscription';

/** What the credential binding points at. Never a value. */
export type ProviderAuth =
  | { readonly type: 'none' }
  | { readonly type: 'bearer'; readonly secret: SecretRefDto }
  | { readonly type: 'apiKeyHeader'; readonly header: string; readonly secret: SecretRefDto }
  | { readonly type: 'apiKeyQuery'; readonly param: string; readonly secret: SecretRefDto };

/** How far the user's prompts travel. */
export type NetworkScope = 'loopback' | 'privateNetwork' | 'publicNetwork';

/**
 * How loudly to speak. `none` covers the entire normal local-model case —
 * plaintext HTTP to 127.0.0.1 with no credential is *not* a risk, and warning
 * about it would train the user to ignore warnings that matter.
 */
export type RiskLevel = 'none' | 'notice' | 'elevated' | 'high';

/**
 * Enumerable, provider-neutral reasons. The UI owns the wording.
 *
 * Listed in the order the host emits them: `concerns` arrives sorted, and both
 * implementations sort lexicographically by these names. See
 * `Concern::ALL` in `src-tauri/crates/vela-settings/src/security.rs`.
 */
export type Concern =
  | 'credentialSentInPlaintext'
  | 'plaintextTrafficLeavesDevice'
  /**
   * The credential rides in the URL's query string to a non-loopback endpoint.
   * **Present even when the transport is `https:`** — TLS hides the URL from
   * the network, then the server and every TLS-terminating proxy write the
   * request line, query string and all, into an access log.
   */
  | 'queryParamCredentialIsLogged'
  | 'remoteEndpointIsUnauthenticated'
  | 'requiredCredentialMissing';

export interface SecurityPosture {
  readonly level: RiskLevel;
  readonly scope: NetworkScope;
  readonly leavesDevice: boolean;
  readonly trafficIsPlaintext: boolean;
  readonly credentialSentInPlaintext: boolean;
  /** Independent of `trafficIsPlaintext`: encryption does not stop logging. */
  readonly credentialInQueryString: boolean;
  readonly endpointIsUnauthenticated: boolean;
  readonly concerns: readonly Concern[];
}

/**
 * One configured provider, plus everything the host derived from it.
 *
 * Branch on these flags, never on `id`. Adding a backend must require zero
 * changes under `src/`.
 */
export interface ProviderView {
  readonly id: string;
  readonly displayName: string;
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  readonly modelId: string | null;
  readonly auth: ProviderAuth;
  readonly authRequirement: AuthRequirement;
  /**
   * A credential is stored right now. **`false` is not a problem on its own** —
   * gate the UI on `usable`, never on this.
   */
  readonly credentialPresent: boolean;
  readonly usable: boolean;
  readonly credentialCheck: CredentialCheck;
  readonly authMode: AuthMode;
  /** `null` when the provider takes no credential: render no field at all. */
  readonly credentialFieldLabel: string | null;
  readonly security: SecurityPosture;
}

export interface SettingsSnapshot {
  readonly theme: ThemePreference;
  /**
   * Always `false`. There is no command that can change it — the field exists
   * so the UI can show the user telemetry is off rather than assert it.
   */
  readonly telemetryEnabled: boolean;
  /** `os-keychain` or `memory-fake`. Displayed verbatim; never inferred. */
  readonly credentialBackend: string;
  readonly providers: readonly ProviderView[];
}

export interface SettingsSetThemeReq {
  readonly theme: ThemePreference;
}

export interface SettingsSetThemeRes {
  readonly theme: ThemePreference;
}

export interface SettingsPutProviderReq {
  readonly id: string;
  readonly displayName: string;
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  readonly modelId?: string;
  /** Omit for an endpoint with no authentication. */
  readonly auth?: AuthMode;
  /** Omit for "no credential needed". */
  readonly authRequirement?: AuthRequirement;
}

export interface SettingsProviderRefReq {
  readonly providerId: string;
}

/* -------------------------------------------------------------------------- */
/* chat — the normalised turn model                                           */
/* -------------------------------------------------------------------------- */

/**
 * These types are the wire form of `vela-providers`' normalised model. They are
 * transcribed, not invented: every one mirrors a `serde` shape in
 * `src-tauri/crates/vela-providers/src/{model,event,error,capability}.rs`, and
 * `src/platform/chat-contract-parity.test.ts` reads those Rust files and fails
 * if a variant is added on one side only.
 *
 * Note what is *absent*: no HTTP status, no `finish_reason`, no vendor error
 * string, no backend identity. Six event types cover every backend Vela will
 * ever have, so the conversation surface is written once.
 */

/** Mirrors `vela_providers::model::MessageRole`. */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** Mirrors `vela_providers::model::StopReason`. */
export type StopReason = 'endTurn' | 'maxTokens' | 'cancelled' | 'toolUse' | 'unspecified';

/** Mirrors `vela_providers::error::Capability`. */
export type CapabilityName =
  | 'streaming'
  | 'vision'
  | 'toolCalling'
  | 'structuredOutput'
  | 'reasoning'
  | 'modelListing'
  | 'usageReporting'
  | 'promptCaching';

/**
 * Mirrors `vela_core::provider::ProviderCapabilities` — **the entire vocabulary
 * the UI has for what a model can do.** Branch on these; never on an id.
 *
 * The floor is every flag `false` ({@link NO_CAPABILITIES}). An unprobed model
 * offers nothing, because offering an affordance the endpoint cannot serve is
 * worse than not offering it.
 */
export interface ChatCapabilities {
  readonly streaming: boolean;
  readonly vision: boolean;
  readonly toolCalls: boolean;
  readonly reasoning: boolean;
  readonly modelListing: boolean;
  readonly usageReporting: boolean;
  readonly promptCaching: boolean;
}

/** The pessimistic floor — `ProviderCapabilities::minimal()`. */
export const NO_CAPABILITIES: ChatCapabilities = {
  streaming: false,
  vision: false,
  toolCalls: false,
  reasoning: false,
  modelListing: false,
  usageReporting: false,
  promptCaching: false,
};

/** Mirrors `vela_providers::model::ContentPart` (`#[serde(tag = "kind")]`). */
export type ContentPart =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'reasoning';
      readonly text: string;
      readonly signature: string | null;
      readonly redacted: boolean;
    }
  | { readonly kind: 'image'; readonly mimeType: string; readonly data: readonly number[] }
  | {
      readonly kind: 'toolCall';
      readonly callId: string;
      readonly name: string;
      readonly arguments: unknown;
    }
  | {
      readonly kind: 'toolResult';
      readonly callId: string;
      readonly content: string;
      readonly isError: boolean;
    };

/** Mirrors `vela_providers::model::MalformedToolCall`. */
export type MalformedToolCallReason =
  | 'missingName'
  | 'unparseableArguments'
  | 'argumentsNotAnObject'
  | 'unknownDiscriminator';

/**
 * Mirrors `vela_providers::model::ToolCallOutcome` (`#[serde(tag = "status")]`).
 *
 * `malformed` is not an error state to hide: the host refuses to execute a bad
 * reconstruction and hands the evidence to the UI instead. Rendering it is
 * mandatory — a silently dropped call is the failure mode this type exists to
 * prevent.
 */
export type ToolCallOutcome =
  | {
      readonly status: 'ok';
      readonly callId: string;
      readonly name: string;
      readonly arguments: unknown;
      /** Recovered from the model's text because the endpoint has no native tools. */
      readonly emulated: boolean;
    }
  | {
      readonly status: 'malformed';
      readonly index: number | null;
      readonly callId: string | null;
      readonly name: string | null;
      /** Exactly as received, bounded. Shown as evidence; never parsed into a call. */
      readonly rawArguments: string;
      readonly reason: MalformedToolCallReason;
    };

/** Mirrors `vela_providers::model::ContextStrategy`. */
export type ContextStrategy = 'elideOldest' | 'summarise';

/**
 * Mirrors `vela_providers::model::Degradation` (`#[serde(tag = "kind")]`).
 *
 * Every reduction the host made compared to what was asked. **These must be
 * visible.** Silently wrong output is the one forbidden outcome.
 */
export type Degradation =
  | { readonly kind: 'toolCallingEmulated'; readonly toolCount: number }
  | { readonly kind: 'toolCatalogueWithheld' }
  | {
      readonly kind: 'contextReduced';
      readonly droppedMessages: number;
      readonly approxDroppedTokens: number;
      readonly strategy: ContextStrategy;
    }
  | { readonly kind: 'structuredOutputUnsupported' }
  | { readonly kind: 'structuredOutputMismatch'; readonly detail: string }
  | { readonly kind: 'malformedFramesSkipped'; readonly count: number }
  | { readonly kind: 'unterminatedReasoning'; readonly recoveredAnswerChars: number }
  | { readonly kind: 'noTerminationSentinel' }
  | { readonly kind: 'usageNotReported' }
  | { readonly kind: 'malformedToolCalls'; readonly count: number }
  | { readonly kind: 'failedOver'; readonly attempts: number };

/**
 * Mirrors `vela_providers::model::TokenUsage`. Every field optional, and `null`
 * means **not reported** — never substitute a zero, which would be a claim.
 */
export interface TokenUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly cachedInputTokens: number | null;
}

/** Mirrors `vela_providers::error::TransportFailure` (externally tagged). */
export type TransportFailure =
  | 'connect'
  | 'timeout'
  | 'stalled'
  | 'reset'
  | { readonly server: { readonly status: number } }
  | { readonly request: { readonly status: number } };

/**
 * Mirrors `vela_providers::error::ProviderError` (`#[serde(tag = "kind")]`) —
 * the one error taxonomy. `detail` is host-sanitised and bounded; it is never a
 * raw upstream body.
 */
export type ChatError =
  | {
      readonly kind: 'contextLengthExceeded';
      readonly limitTokens: number | null;
      readonly requestedTokens: number | null;
      readonly detail: string;
    }
  | { readonly kind: 'authFailed'; readonly detail: string }
  | { readonly kind: 'rateLimited'; readonly retryAfterMs: number | null; readonly detail: string }
  | { readonly kind: 'modelNotFound'; readonly modelId: string; readonly detail: string }
  | {
      readonly kind: 'capabilityUnsupported';
      readonly capability: CapabilityName;
      readonly detail: string;
    }
  | { readonly kind: 'transport'; readonly failure: TransportFailure; readonly detail: string }
  | { readonly kind: 'malformedResponse'; readonly detail: string }
  | { readonly kind: 'cancelled' };

/** Mirrors `vela_providers::model::SchemaMismatch`. */
export interface SchemaMismatch {
  readonly path: string;
  readonly detail: string;
}

/** Mirrors `Option<Result<Value, SchemaMismatch>>` as serde writes it. */
export type StructuredOutcome = { readonly Ok: unknown } | { readonly Err: SchemaMismatch } | null;

/** Mirrors `vela_providers::model::ChatResponse` — the assembled turn. */
export interface ChatResponseBody {
  readonly parts: readonly ContentPart[];
  readonly toolCalls: readonly ToolCallOutcome[];
  readonly stopReason: StopReason;
  readonly usage: TokenUsage;
  readonly structured: StructuredOutcome;
  readonly degradations: readonly Degradation[];
}

/** Mirrors `vela_providers::event::ToolCallDelta`. */
export interface ToolCallDelta {
  /** Vela's own slot key — stable even when the endpoint reuses or skips `index`. */
  readonly slot: number;
  readonly callId: string | null;
  readonly name: string | null;
  readonly argumentsFragment: string;
}

/**
 * Mirrors `vela_providers::event::StreamEvent` (`#[serde(tag = "type")]`).
 *
 * Six events, no more. A backend that cannot stream at all emits one
 * `textDelta` and a `done`, and this surface cannot tell the difference.
 *
 * `textDelta.text` is the answer and **never contains reasoning markup** — the
 * host's splitter has already run, across frame boundaries. The renderer
 * re-checks anyway (defence in depth), because a leaked `<think>` in the answer
 * is the single most visible way this surface can be wrong.
 */
export type ChatStreamEvent =
  | { readonly type: 'textDelta'; readonly text: string }
  | { readonly type: 'reasoningDelta'; readonly text: string }
  | { readonly type: 'toolCallDelta'; readonly delta: ToolCallDelta }
  | { readonly type: 'usage'; readonly usage: TokenUsage }
  | { readonly type: 'done'; readonly response: ChatResponseBody }
  | { readonly type: 'error'; readonly error: ChatError };

/** One message on its way to the host. */
export interface ChatMessageInput {
  readonly role: MessageRole;
  readonly text: string;
}

/**
 * Start a turn.
 *
 * The **renderer** mints `turnId`, not the host: events for a turn can arrive
 * before the `invoke` promise settles, so a subscriber that had to wait for the
 * id would drop the first token. The host rejects an id already in flight.
 */
export interface ChatSendReq {
  readonly turnId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly messages: readonly ChatMessageInput[];
}

export interface ChatSendRes {
  readonly turnId: string;
  /**
   * The turn was accepted and is now streaming. Always `true` — a refusal is an
   * `IpcError`, never a `false` the caller might forget to read.
   */
  readonly accepted: boolean;
}

export interface ChatCancelReq {
  readonly turnId: string;
}

export interface ChatCancelRes {
  /** `false` when the turn had already finished — a race, not an error. */
  readonly cancelled: boolean;
}

/** The payload of the `chat:event` host event. */
export interface ChatEventEnvelope {
  readonly turnId: string;
  readonly event: ChatStreamEvent;
}

/* -------------------------------------------------------------------------- */
/* the contract                                                               */
/* -------------------------------------------------------------------------- */

export interface IpcContract {
  app_info: { req: EmptyPayload; res: AppInfo };
  chat_cancel: { req: ChatCancelReq; res: ChatCancelRes };
  chat_send: { req: ChatSendReq; res: ChatSendRes };
  diagnostics_echo: { req: EchoReq; res: EchoRes };
  secrets_delete: { req: SecretsRefReq; res: Ack };
  secrets_set: { req: SecretsSetReq; res: Ack };
  secrets_status: { req: SecretsRefReq; res: SecretsStatusRes };
  settings_delete_provider: { req: SettingsProviderRefReq; res: Ack };
  settings_get: { req: EmptyPayload; res: SettingsSnapshot };
  settings_put_provider: { req: SettingsPutProviderReq; res: ProviderView };
  settings_set_theme: { req: SettingsSetThemeReq; res: SettingsSetThemeRes };
}

export type CommandName = keyof IpcContract & string;
export type CommandReq<C extends CommandName> = IpcContract[C]['req'];
export type CommandRes<C extends CommandName> = IpcContract[C]['res'];

/**
 * The runtime allowlist. Kept sorted. Parsed verbatim by the Rust parity test,
 * so keep it a plain array of string literals — no spreads, no computation.
 */
export const COMMAND_ALLOWLIST = [
  'app_info',
  'chat_cancel',
  'chat_send',
  'diagnostics_echo',
  'secrets_delete',
  'secrets_set',
  'secrets_status',
  'settings_delete_provider',
  'settings_get',
  'settings_put_provider',
  'settings_set_theme',
] as const;

/**
 * Compile-time proof that the allowlist contains only real commands. The
 * reverse direction (every command is listed) is asserted at runtime in
 * `contract.test.ts`, because TypeScript cannot check exhaustiveness of a
 * `readonly` tuple against a key union without a type-level equality hack.
 */
const _allowlistIsWellTyped: readonly CommandName[] = COMMAND_ALLOWLIST;
void _allowlistIsWellTyped;

export function isAllowedCommand(name: string): name is CommandName {
  return (COMMAND_ALLOWLIST as readonly string[]).includes(name);
}
