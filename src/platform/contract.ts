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
 *  4. Implement it in `src-tauri/src/ipc/<domain>.rs`, take its one argument as
 *     `payload`, and register it in both `COMMAND_ALLOWLIST` (Rust) and
 *     `generate_handler!` in `lib.rs`. Those last two are different things:
 *     the allowlist is the declaration, `generate_handler!` is the dispatch
 *     table the packaged app consults.
 *  5. Implement it in `BrowserAdapter` so the UI still runs headlessly.
 * Miss any of these and either `cargo test` or `pnpm test` fails. That is the
 * point — and step 4's `generate_handler!` half only became true when
 * `src-tauri/tests/handler_binding.rs` was written, which is why that file
 * exists. Step 5 is `tsc`'s doing: `BrowserAdapter.#handle` ends in a
 * `const exhaustive: never = command`, so an unhandled command fails the build.
 *
 * ## Rules
 *  - Every command takes exactly one payload object and returns one object.
 *    Never `void`, never a bare scalar — use {@link EmptyPayload} / {@link Ack}.
 *  - Field names are camelCase on the wire; Rust structs carry
 *    `#[serde(rename_all = "camelCase")]`.
 *  - No secret value ever appears in a response type. There is no
 *    `secrets_get`, and adding one is a review-blocking change.
 */

/**
 * The sandbox surface lives in its own file — `src/platform/contract-sandbox.ts`
 * — and joins the command map here.
 *
 * **Why the types are imported rather than restated.** That file is frozen and
 * is where the reasoning lives; a second spelling of `SandboxSubmitReq` beside
 * this map would be the parallel-list defect this repo keeps finding, one layer
 * up. The import is type-only in both directions (that file imports {@link Ack}
 * and {@link EmptyPayload} from here), so nothing circular survives to runtime.
 */
import type {
  SandboxApproveReq,
  SandboxCancelReq,
  SandboxCancelRes,
  SandboxPolicySnapshot,
  SandboxReleaseReq,
  SandboxReportDocumentReq,
  SandboxSubmitReq,
  SandboxSubmitRes,
} from './contract-sandbox';
/**
 * The project surface, on the same terms and for the same reason: its shapes
 * are argued in `src/platform/contract-project.ts` and imported rather than
 * restated here.
 */
import type {
  ProjectCreateReq,
  ProjectDeleteReq,
  ProjectLayoutRes,
  ProjectListReq,
  ProjectListRes,
  ProjectMoveConversationReq,
  ProjectRefReq,
  ProjectRes,
  ProjectUpdateReq,
} from './contract-project';

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

/**
 * The local, opt-in debug log: whether it is recording, and where it writes.
 *
 * **What is deliberately absent is the point.** There is no command that
 * returns what the log recorded. Vela takes endpoint-supplied text out of every
 * error it renders and keeps the raw bytes in this file instead; a command that
 * handed those bytes back to the renderer would undo that in one step. What
 * crosses the bridge is a flag and a path on the user's own disk — the user
 * opens the file with their own tools, and the `trace` id on a failed turn is
 * what they search it for.
 *
 * The log is **off at every launch** and is not persisted. A debug log that
 * survives a restart is a file that grows for months after the session that
 * needed it, which is not what offline-first with no telemetry looks like.
 */
export interface DebugLogStatus {
  readonly enabled: boolean;
  /** Absolute path, shown to the user. Never fetched, never read by the UI. */
  readonly path: string;
}

export interface DebugLogSetReq {
  readonly enabled: boolean;
}

/* -------------------------------------------------------------------------- */
/* the local endpoint                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Vela can serve one of the user's configured endpoints back out on a local
 * HTTP port, so that other tools on the machine can talk to it. This is the
 * switch for that.
 *
 * **Off at every launch**, and not persisted — the same rule
 * {@link DebugLogStatus} follows and for a stronger reason: a local HTTP server
 * is not something a desktop chat client should start on its own, and the key
 * that guards it lives in this process only.
 *
 * What is *not* in this vocabulary is the point of it. The port answers more
 * than one wire format, and none of them is nameable here: what a caller
 * supplies is an address, a key, one of its own configured endpoint ids, and
 * what it wants done about tools. `no-provider-leak.test.ts` scans both sides
 * of this boundary for backend identities, and this surface gives it nothing to
 * find. The host's `endpoint_host` module records why that mattered: the belief
 * that a switch *would* need them is what kept this off the contract.
 */
export interface EndpointEnableReq {
  /** `host:port`. Its scope decides the tool policy — see {@link EndpointStatus}. */
  readonly bind: string;
  /**
   * The bearer key callers must present. Travels one way, exactly like
   * {@link SecretsSetReq.value}: nothing returns it, and no status carries it.
   */
  readonly key: string;
  /** One of the ids from {@link SettingsSnapshot.providers}. Opaque. */
  readonly providerId: string;
  /**
   * `default` lets the bound address decide, and is the safe answer. `on` is a
   * request, not a guarantee — see {@link EndpointEnableReq.confirmExposedTools}.
   */
  readonly tools?: EndpointToolsRequest;
  /**
   * The user's answer to "tools, on an address other machines can reach". Only
   * consulted when `tools` is `on` **and** the bound address is not loopback;
   * without it that combination resolves to tools off rather than to an error,
   * because failing closed is the only defensible answer to a question nobody
   * answered.
   */
  readonly confirmExposedTools?: boolean;
}

export type EndpointToolsRequest = 'default' | 'on' | 'off';

/** Which of the four things the endpoint can be doing it is doing. */
export type EndpointRunState = 'off' | 'refused' | 'bindFailed' | 'serving';

/**
 * Why the tool policy resolved the way it did. A closed set of codes, never a
 * sentence: the renderer owns every word a user reads, the same rule
 * {@link Concern} follows.
 *
 * `loopbackDefault` and `exposedDefault` are the rule doing its job — a port
 * only this machine can reach may run tools, a port anything can reach may not.
 * `exposedEnableUnconfirmed` is the one that surprises people: they asked for
 * tools, and got none, because they did not confirm.
 */
export type EndpointToolPolicy =
  | 'loopback-default'
  | 'exposed-default'
  | 'forced-on'
  | 'exposed-enable-unconfirmed'
  | 'forced-off';

/**
 * What the endpoint is doing, read back off the listener that is actually up.
 *
 * `address` is the address that was **bound**, not the one that was asked for,
 * which is why asking for port `0` comes back with a real port. The same is
 * true of `toolsEnabled` and `toolPolicy`: the host resolves them from the
 * listener's own address, so they cannot describe a wildcard bind as loopback.
 */
export interface EndpointStatus {
  readonly state: EndpointRunState;
  /** `host:port` as bound. `null` unless serving. */
  readonly address: string | null;
  /** Which configured endpoint answers turns here. `null` unless serving. */
  readonly providerId: string | null;
  /** Whether tool calls reach the model. `false` whenever not serving. */
  readonly toolsEnabled: boolean;
  readonly toolPolicy: EndpointToolPolicy | null;
  /** Whether the bound address is reachable only from this machine. */
  readonly loopback: boolean;
  /** The refusal code, or the reason the bind failed. `null` when there is none. */
  readonly detail: string | null;
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
/**
 * Which wire protocol an endpoint speaks, as an **opaque token**.
 *
 * A `string`, and deliberately not a union of literals. This is the whole of
 * how conventions §0.3 survives a protocol chooser: the rule is that the UI
 * branches on capability flags and never on a backend identity, and that adding
 * a backend requires zero changes under `src/`. A union here would put the
 * three names in the renderer's vocabulary, and a vocabulary is all a branch
 * needs — `protocol === 'anthropicMessages'` would then be one keystroke and
 * one code review away, and a fourth protocol would be a renderer change.
 *
 * So the renderer holds one of these exactly as it holds a `providerId`: it
 * receives it, forwards it, compares it to another one it also received, and
 * can never spell one. The list of what exists, and the words to show for each,
 * arrive as data on {@link SettingsSnapshot.protocols}.
 *
 * Mirrors `vela_core::protocol::WireProtocol`, which is where the names live
 * and where they are allowed to live.
 */
export type WireProtocolId = string;

/**
 * One entry in the protocol chooser, as the host supplies it.
 *
 * The host owning this wording is the same arrangement as
 * {@link ProviderView.credentialFieldLabel}, and for the same reason: the
 * renderer must be able to label a choice it is not allowed to know the name
 * of. These are Vela's own words about Vela's own build — nothing here is
 * endpoint-supplied text.
 */
export interface WireProtocolOption {
  readonly id: WireProtocolId;
  /** What to show in the chooser. */
  readonly label: string;
  /** One sentence of help under it. */
  readonly summary: string;
}

export interface ProviderView {
  readonly id: string;
  readonly displayName: string;
  readonly kind: ProviderKind;
  /** What the user said this endpoint speaks. Carried, never inspected. */
  readonly protocol: WireProtocolId;
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
  /**
   * The protocols this build can speak, with the words to show for each.
   *
   * Data, not vocabulary. The endpoints form renders this list and sends back
   * whichever `id` was picked; it never enumerates the possibilities itself,
   * which is what keeps "adding a backend requires zero changes under `src/`"
   * true for this field.
   */
  readonly protocols: readonly WireProtocolOption[];
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
  /**
   * One of {@link SettingsSnapshot.protocols}. Omit for the shape most local
   * runtimes serve, which is what an endpoint configured before this field
   * existed already was.
   */
  readonly protocol?: WireProtocolId;
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
 * `src-tauri/crates/vela-providers/src/{model,event,error,capability,diagnostic}.rs`.
 *
 * `src/platform/chat-contract-parity.test.ts` holds them to that, in both
 * directions and with both halves of the gate: it reads those Rust files off
 * disk and fails `pnpm test` when a Rust variant or field has no twin here, and
 * it lists every member of each union through a type-level exhaustiveness check
 * that fails `pnpm typecheck` when a member is added here and nowhere else.
 * Until that file was written this paragraph claimed an enforcement that had
 * never existed — the same defect `src-tauri/tests/handler_binding.rs` was
 * written to close, one file over.
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
  | 'unknownDiscriminator'
  /**
   * The call parsed perfectly and is refused anyway: it was found in text
   * rescued out of a `<think>` block the model never closed, so the model was
   * cut off mid-deliberation and never committed to it. Render it as an offer,
   * not as a failure — the arguments are carried so the user can ask for the
   * call deliberately. See `vela_providers::answer::Provenance::Salvaged`.
   */
  | 'recoveredFromUnterminatedReasoning';

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

/* -- the diagnosis an error carries ------------------------------------- */

/**
 * Mirrors `vela_providers::diagnostic::Cause`.
 *
 * The closed vocabulary of *why* something failed. The endpoint chooses which
 * of these is reported; it has no say in what any of them means, and there is
 * no variant that can carry endpoint-supplied text. The renderer owns the
 * wording, exactly as it does for {@link Concern}.
 *
 * The Rust enum is `#[non_exhaustive]`, so this type is open on purpose: a host
 * newer than this renderer must produce a fallback sentence, never a blank.
 */
export type KnownCause =
  | 'credential_rejected'
  | 'credential_missing'
  | 'credential_store_unreadable'
  | 'credential_store_failed'
  | 'model_not_served'
  | 'model_list_malformed'
  | 'context_window_exceeded'
  | 'pinned_turns_exceed_window'
  | 'request_too_large'
  | 'too_many_requests'
  | 'endpoint_overloaded'
  | 'endpoint_failed_to_answer'
  | 'endpoint_rejected_request'
  | 'endpoint_timed_out'
  | 'endpoint_cancelled_request'
  | 'endpoint_reported_an_error'
  | 'content_filter_refused_the_turn'
  | 'capability_refused_by_endpoint'
  | 'capability_absent_on_this_model'
  | 'capability_not_offered_by_backend'
  | 'connection_failed'
  | 'request_timed_out'
  | 'stream_stalled'
  | 'connection_reset'
  | 'redirect_refused_cross_authority'
  | 'redirect_loop'
  | 'no_endpoint_answered'
  | 'response_was_not_json'
  | 'response_shape_unrecognised'
  | 'stream_ended_without_answer'
  | 'request_could_not_be_encoded'
  | 'no_provider_configured'
  | 'no_candidate_answered'
  | 'caller_cancelled'
  | 'synthetic_test_failure';

export type Cause = KnownCause | (string & {});

/**
 * Mirrors `vela_providers::diagnostic::EndpointIdentity`.
 *
 * Scheme, host, port and path of the endpoint **the user configured** — never
 * userinfo, never a query string. Present so a user with three candidates set
 * up can tell which one failed.
 */
export interface EndpointIdentity {
  readonly authority: string;
  /** Empty means `/`. */
  readonly path: string;
}

/** Mirrors `vela_providers::diagnostic::{FilterStage, FilterKind}`. */
export type FilterStage = 'prompt' | 'answer';
export type FilterKind =
  | 'safety'
  | 'prohibited_content'
  | 'blocklist'
  | 'personal_information'
  | 'recitation'
  | 'image_safety'
  | 'unsupported_language'
  | 'other';

/**
 * Mirrors `vela_providers::diagnostic::FilterVerdict`. `categories` is a
 * bitset, not a list of strings — five bits cannot spell a credential.
 */
export interface FilterVerdict {
  readonly stage: FilterStage;
  readonly kind: FilterKind;
  readonly categories: number;
  readonly generatedChars: number;
}

/**
 * Mirrors `vela_providers::diagnostic::Diagnosis`.
 *
 * **This type is the reason there is no `detail: string` anywhere near an
 * error.** A cause from a closed set, some integers, the endpoint the user
 * configured, and a correlation id that links to the raw exchange in the
 * user's own opt-in local debug log. Nothing the endpoint wrote travels.
 */
export interface Diagnosis {
  readonly cause: Cause;
  /** The HTTP status, when there was a response to have one. */
  readonly status?: number;
  readonly endpoint?: EndpointIdentity;
  readonly filter?: FilterVerdict;
  /** `0` means "never correlated with an exchange" — Vela's own refusal. */
  readonly correlation: number;
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
 * the one error taxonomy.
 *
 * **There is no free-text field here, and that is the design.** Four rounds of
 * Phase B tried carrying an endpoint's own error text and laundering it; each
 * round closed one spelling and the next found another. What crosses now is a
 * {@link Diagnosis}: a cause from a closed set, some integers, the endpoint the
 * *user* configured, and a correlation id pointing at the user's own local
 * debug log. The renderer writes every sentence a user reads.
 */
export type ChatError =
  | {
      readonly kind: 'contextLengthExceeded';
      readonly limitTokens: number | null;
      readonly requestedTokens: number | null;
      readonly diagnosis: Diagnosis;
    }
  | { readonly kind: 'authFailed'; readonly diagnosis: Diagnosis }
  | {
      readonly kind: 'rateLimited';
      readonly retryAfterMs: number | null;
      readonly diagnosis: Diagnosis;
    }
  | {
      readonly kind: 'modelNotFound';
      /** The id **Vela sent**, read back off the request — never off the reply. */
      readonly modelId: string;
      readonly diagnosis: Diagnosis;
    }
  | {
      readonly kind: 'capabilityUnsupported';
      readonly capability: CapabilityName;
      readonly diagnosis: Diagnosis;
    }
  | { readonly kind: 'transport'; readonly failure: TransportFailure; readonly diagnosis: Diagnosis }
  | { readonly kind: 'malformedResponse'; readonly diagnosis: Diagnosis }
  | { readonly kind: 'cancelled' };

/** Mirrors `vela_providers::model::SchemaMismatch`. */
export interface SchemaMismatch {
  readonly path: string;
  readonly detail: string;
}

/** Mirrors `Option<Result<Value, SchemaMismatch>>` as serde writes it. */
export type StructuredOutcome = { readonly Ok: unknown } | { readonly Err: SchemaMismatch } | null;

/**
 * Mirrors `vela_providers::model::AnswerProvenance` — **who actually answered**.
 *
 * A property of the answer, not an event about the turn, which is why it is a
 * field on {@link ChatResponseBody} rather than a {@link Degradation} arm. The
 * host-side doc explains the choice in full; the consequence here is that this
 * is present on *every* routed answer, not only the ones that failed over, so a
 * reader never has to conclude "no `failedOver` arrived, therefore it must have
 * been the endpoint I picked". That inference is what let a turn addressed to
 * `localhost` be answered by a hosted endpoint with every surface still naming
 * `localhost`.
 *
 * Not a switch. `conventions.md` §0.3 forbids the UI *branching* on a provider
 * id and requires that adding a provider needs zero changes under `src/`.
 * Neither is at stake: this value is compared for equality against the user's
 * own selection and otherwise printed, exactly as {@link Diagnosis.endpoint}
 * has always been.
 */
export interface AnswerProvenance {
  /** The configured id of the endpoint that produced this answer. */
  readonly providerId: string;
  /** The model **that endpoint** was asked for — a fallback answers about its own. */
  readonly modelId: string;
}

/** Mirrors `vela_providers::model::ChatResponse` — the assembled turn. */
export interface ChatResponseBody {
  readonly parts: readonly ContentPart[];
  readonly toolCalls: readonly ToolCallOutcome[];
  readonly stopReason: StopReason;
  readonly usage: TokenUsage;
  readonly structured: StructuredOutcome;
  readonly degradations: readonly Degradation[];
  /**
   * Which endpoint produced this answer, or `null` when nothing was in a
   * position to know.
   *
   * **`null` means unattributed, never "the one you picked".** Treating it as
   * the selection reintroduces the exact falsehood this field exists to end.
   * Every answer that came through the host's router carries a value; `null` is
   * reachable from a stub adapter or a host older than this renderer.
   */
  readonly answeredBy: AnswerProvenance | null;
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

/**
 * Mirrors `src-tauri/src/ipc/content.rs`'s `ContentPartDto` — the one content
 * vocabulary that crosses the boundary, in both directions.
 *
 * The only difference from {@link ContentPart}, which mirrors the *provider*
 * model, is `image.data`: **standard base64 here**, raw bytes there. An image is
 * bytes in the host and in the database; encoding it once at the boundary is
 * what keeps a JSON payload from carrying a byte array with one number per
 * pixel channel.
 */
export type ContentPartInput =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'reasoning';
      readonly text: string;
      readonly signature?: string | null;
      readonly redacted?: boolean;
    }
  | { readonly kind: 'image'; readonly mimeType: string; readonly data: string }
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
      readonly isError?: boolean;
    };

/**
 * One message on its way to the host.
 *
 * `text` is the ordinary case. `parts` carries what text cannot say — an
 * attached image, a tool result being fed back, a signed reasoning block a
 * backend requires returned verbatim. The host composes them as **`text` (when
 * non-empty) followed by `parts`, in order**; a message with neither is one
 * empty text part, which is what a message with no `parts` has always been.
 */
export interface ChatMessageInput {
  readonly role: MessageRole;
  readonly text: string;
  /** Non-text content, appended after `text`. Omit for an ordinary turn. */
  readonly parts?: readonly ContentPartInput[];
}

/** Mirrors `vela_providers::model::ToolDefinition`. */
export interface ToolDefinitionInput {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments object. Must be an object. */
  readonly parameters: unknown;
}

/** Mirrors `vela_providers::model::ToolChoice` (`#[serde(tag = 'type')]`). */
export type ToolChoiceInput =
  | { readonly type: 'auto' }
  | { readonly type: 'none' }
  | { readonly type: 'required' }
  | { readonly type: 'named'; readonly name: string };

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
  /**
   * Tools offered for this turn. Per-turn rather than per-provider: which tools
   * are available is a property of what the user is doing, not of which
   * endpoint answers. Omit for no tool use — the host then omits the catalogue
   * from the request entirely, because GATE M FINDING 6 recorded a profile that
   * rejects a request carrying `tools` even with `toolChoice: none`.
   */
  readonly tools?: readonly ToolDefinitionInput[];
  readonly toolChoice?: ToolChoiceInput;
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
/* models — what an endpoint holds, and what each model demonstrated          */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors `src-tauri/src/ipc/models.rs`.
 *
 * `settings_*` describes what the user **configured**; these describe what an
 * endpoint **demonstrated**. Keeping them apart is deliberate: a perfectly valid
 * configuration pointing at a box that is switched off has no established
 * capabilities at all, and a single type would have to lie about one of the two.
 */

/** Mirrors `vela_providers::capability::Support`. */
export type CapabilitySupport = 'unknown' | 'unsupported' | 'supported' | 'degraded';

/**
 * Mirrors `vela_providers::capability::Evidence` — how a belief was reached, so
 * the UI can never imply a probe happened when a default was used.
 */
export type CapabilityEvidence = 'probed' | 'declared' | 'cached' | 'unprobed';

/**
 * Mirrors `models::CapabilityFindingView`.
 *
 * Note what is absent: the adapter's free-text `note`. Three closed enums cross;
 * the renderer writes every sentence, exactly as it does for {@link Concern}
 * and {@link Cause}.
 */
export interface CapabilityFinding {
  readonly capability: CapabilityName;
  readonly support: CapabilitySupport;
  readonly evidence: CapabilityEvidence;
}

/** Mirrors `models::ModelOption`. */
export interface ModelOption {
  readonly modelId: string;
  /** How the endpoint names it. Rendered as-is; never parsed, never matched. */
  readonly displayName: string;
  /** `null` when the endpoint reports none. Never a guessed default. */
  readonly contextWindowTokens: number | null;
}

/**
 * Mirrors `models::ModelCapabilityReport` — **the whole vocabulary the UI has
 * for what the chosen model can do.**
 */
export interface ModelCapabilityReport {
  readonly providerId: string;
  readonly modelId: string;
  /** The offerable flag set. `unknown` reads as `false`, decided host-side. */
  readonly capabilities: ChatCapabilities;
  /**
   * May a structured-output request be *sent*? Separate from `capabilities`
   * because its failure mode is silent wrong output rather than a loud error.
   */
  readonly structuredOutput: boolean;
  /**
   * No native tool calling, so the core emulates it in the prompt. The UI must
   * say "emulated" rather than implying the endpoint understands tools.
   */
  readonly toolCallsEmulated: boolean;
  readonly contextWindowTokens: number | null;
  readonly maxOutputTokens: number | null;
  /** `false` means nothing has been established: the floor above is a floor. */
  readonly probed: boolean;
  readonly findings: readonly CapabilityFinding[];
}

export interface ModelsProviderRefReq {
  readonly providerId: string;
}

export interface ModelsRefReq {
  readonly providerId: string;
  readonly modelId: string;
}

export interface ModelsListRes {
  readonly models: readonly ModelOption[];
  /**
   * The endpoint enumerated its own models. `false` is a **normal state** for a
   * runtime with no listing route — the UI falls back to free-text model entry
   * and must not render an error.
   */
  readonly enumerated: boolean;
  /** Set only for a real failure, never for "this endpoint does not list". */
  readonly failure: ChatError | null;
}

export interface ModelsProbeRes {
  /** What is known *after* the attempt. On failure, whatever was known before. */
  readonly report: ModelCapabilityReport;
  readonly failure: ChatError | null;
}

/* -------------------------------------------------------------------------- */
/* store — the conversation list the navigation surface is built on           */
/* -------------------------------------------------------------------------- */

/**
 * A conversation as the navigation surface sees it.
 *
 * Note what is **absent**: the stored row carries the backend and model that
 * last answered in this conversation, and neither appears here. A field the
 * renderer can read is a field the renderer will eventually branch on, and
 * conventions §0 rule 3 forbids that. Which model said what is a property of a
 * message, and belongs to the transcript surface.
 */
export interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  /** `null` when nothing has been said yet — not the same as `createdAtMs`. */
  readonly lastMessageAtMs: number | null;
  readonly messageCount: number;
  /**
   * The title is still the host's placeholder. The UI may render it quietly and
   * may ask the host to derive a real one.
   */
  readonly titleIsPlaceholder: boolean;
}

/**
 * Where a search hit came from. `reasoning` is surfaced distinctly so the UI can
 * say the match was inside a thinking block rather than quoting private
 * reasoning back as though it were an answer.
 */
export type MessageHitKind = 'answer' | 'reasoning';

export interface MessageHit {
  readonly messageId: string;
  readonly conversationId: string;
  readonly conversationTitle: string;
  readonly kind: MessageHitKind;
  /** The matched text, with the hit delimited by `[` and `]`. */
  readonly snippet: string;
  readonly createdAtMs: number;
}

export interface StoreListConversationsReq {
  readonly limit?: number;
}

export interface ConversationListRes {
  readonly conversations: readonly ConversationSummary[];
}

export interface StoreCreateConversationReq {
  /** Omit to open an untitled conversation, which is the normal case. */
  readonly title?: string;
}

export interface ConversationRes {
  readonly conversation: ConversationSummary;
}

export interface StoreRenameConversationReq {
  readonly conversationId: string;
  readonly title: string;
}

export interface StoreConversationRefReq {
  readonly conversationId: string;
}

export interface StoreSearchReq {
  readonly query: string;
  readonly limit?: number;
}

/**
 * Two labelled halves rather than one blended list: a title match and a content
 * match are different claims, and merging them would let the UI imply words
 * appear in a transcript when they only appear in its name.
 */
export interface StoreSearchRes {
  readonly conversations: readonly ConversationSummary[];
  readonly messages: readonly MessageHit[];
}

/* -------------------------------------------------------------------------- */
/* memory                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors `src-tauri/src/ipc/memory.rs`.
 *
 * The durable facts Vela keeps about the user, and only what a human or a
 * surface the human drove has written. **Nothing writes here automatically.**
 * `docs/vela-feature-spec.md` MEM-1 describes a post-turn extraction pass that
 * decides what was worth remembering; it does not exist in this build, no code
 * calls `memory_add` from a turn, and nothing in this file may be read as
 * saying otherwise.
 */

/**
 * Which memory space a request addresses.
 *
 * A discriminated union rather than MEM-1's `project:<id>` string, because a
 * caller that has to build that string is a caller that can build `project:`
 * with nothing after it — a partition that is neither global nor any project
 * and that nothing can ever read back. The host refuses a blank project id with
 * `INVALID_PAYLOAD`.
 *
 * **The two scopes never mix.** MEM-2's rule is that a chat inside a project
 * reads and writes that project's space only, and a chat outside projects reads
 * and writes global only. It is enforced in the store — every read takes one
 * scope and there is no method that returns more than one — and
 * `vela-store`'s `project_memory_and_global_memory_never_see_each_other` is
 * what holds it.
 *
 * The renderer only ever sends `global` today, because nothing in the renderer
 * knows which project a conversation belongs to: {@link ConversationSummary}
 * carries no project id, and there is no project surface. The project variant
 * is real and reachable from the host; it is not reachable from the UI yet.
 */
export type MemoryScope =
  | { readonly kind: 'global' }
  | { readonly kind: 'project'; readonly projectId: string };

/**
 * The four things the reference captures, plus `other`.
 *
 * A closed enum so the renderer writes every heading a user reads and the host
 * never invents one — the same discipline the error causes keep. `other` exists
 * so a fact that cannot be placed is still stored: a dropped fact is the
 * silently-wrong outcome, a fact under "Other" is a visible one.
 */
export type MemoryCategory =
  | 'roleContext'
  | 'commsPrefs'
  | 'techPrefs'
  | 'projectDetails'
  | 'other';

/** Mirrors `MEMORY_CONTENT_MAX_CHARS` in `vela-store/src/model.rs`. */
export const MEMORY_CONTENT_MAX_CHARS = 2_000;

export interface MemoryEntry {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly category: MemoryCategory;
  readonly content: string;
  /** Ranked ahead of everything unpinned when the injection budget is short. */
  readonly pinned: boolean;
  /**
   * Which conversation this fact came out of, when that is known. `null` both
   * for an entry the user typed and for one whose source conversation has been
   * deleted — the host does not distinguish those, and neither does this.
   */
  readonly sourceConversationId: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface MemoryScopeReq {
  readonly scope: MemoryScope;
}

export interface MemoryListRes {
  /**
   * Pinned first, then most recently updated first. That is MEM-1's injection
   * order, produced once by the host so a consumer taking the first N under a
   * budget takes the right N without re-sorting.
   */
  readonly entries: readonly MemoryEntry[];
}

export interface MemoryAddReq {
  readonly scope: MemoryScope;
  readonly category: MemoryCategory;
  readonly content: string;
  readonly sourceConversationId?: string;
}

/**
 * Amend an entry. An omitted field means "leave it alone".
 *
 * There is no `scope` field, deliberately: moving an entry between scopes is
 * MEM-2's "promote to global" and carries its own consent question. It must not
 * be something a caller can do as a side effect of fixing a typo.
 */
export interface MemoryUpdateReq {
  readonly entryId: string;
  readonly category?: MemoryCategory;
  readonly content?: string;
  readonly pinned?: boolean;
}

export interface MemoryRefReq {
  readonly entryId: string;
}

export interface MemoryRes {
  readonly entry: MemoryEntry;
}

export interface MemoryClearRes {
  /**
   * How many entries went. Reported rather than acked so a confirmation can say
   * what it did — "forgot 12 things" is checkable, "ok" is not.
   */
  readonly removed: number;
}

/* -------------------------------------------------------------------------- */
/* store — the transcript itself                                              */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors `src-tauri/src/ipc/transcript.rs`.
 *
 * Before these commands existed the transcript was pure React state, destroyed
 * the moment the user left the conversation: the `messages` table had been in
 * the schema since Phase A with nothing able to write to it. Reasoning is
 * carried and stored as its own part kind, never folded into the answer, so the
 * UI can collapse it and the prompt-rebuilding path can leave it out.
 */

/** Mirrors `vela_store::MessageStatus`. */
export type StoredMessageStatus = 'streaming' | 'complete' | 'cancelled' | 'failed';

/** Mirrors `vela_store::StopReason`. */
export type StoredStopReason = 'endTurn' | 'maxTokens' | 'cancelled' | 'toolUse' | 'unspecified';

/** Mirrors `transcript::MessageDto`. */
export interface StoredMessage {
  readonly id: string;
  readonly conversationId: string;
  /** Dense, 0-based position assigned by the host. `afterSeq` is exclusive. */
  readonly seq: number;
  readonly role: MessageRole;
  readonly status: StoredMessageStatus;
  readonly parts: readonly ContentPartInput[];
  /**
   * Which backend this message was **addressed to** — the user's selection at
   * the time. A record of what happened, per message — not a switch the UI
   * branches on.
   *
   * This used to be documented as "which backend produced this message", and
   * nothing made that true: the renderer wrote its own `providerId` option here
   * while the host was free to fail over to a different endpoint. See
   * {@link answeredByProviderId}.
   */
  readonly providerId: string | null;
  readonly modelId: string | null;
  /**
   * Which backend **actually produced** it, from {@link AnswerProvenance}.
   *
   * `null` means **not recorded** — a row written before the store learned to
   * keep this, a message no endpoint produced, or a turn the host did not
   * attribute. It is never "the same as {@link providerId}", and rendering it
   * that way reintroduces the falsehood the column exists to end.
   */
  readonly answeredByProviderId: string | null;
  readonly answeredByModelId: string | null;
  readonly usage: TokenUsage;
  readonly stopReason: StoredStopReason | null;
  readonly errorMessage: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface StoreAppendMessageReq {
  readonly conversationId: string;
  readonly role: MessageRole;
  readonly parts: readonly ContentPartInput[];
  /** Defaults to `complete`. Send `streaming` when opening a live turn. */
  readonly status?: StoredMessageStatus;
  /** What the user selected. */
  readonly providerId?: string | null;
  readonly modelId?: string | null;
  /**
   * Who actually answered. Omitted or `null` means "not recorded", which is
   * what a caller that does not know must send — never the selection.
   */
  readonly answeredByProviderId?: string | null;
  readonly answeredByModelId?: string | null;
  readonly usage?: TokenUsage;
  readonly stopReason?: StoredStopReason | null;
  readonly errorMessage?: string | null;
}

/**
 * Amend a message already written — the call that closes out a streaming turn.
 *
 * An omitted field means "leave it alone". There is no way to spell "set this
 * back to nothing": a renderer that could erase a `failed` status could make a
 * failed turn look complete.
 */
export interface StoreUpdateMessageReq {
  readonly messageId: string;
  /** Replaces the whole part list. */
  readonly parts?: readonly ContentPartInput[];
  readonly status?: StoredMessageStatus;
  readonly usage?: TokenUsage;
  readonly stopReason?: StoredStopReason;
  readonly errorMessage?: string;
}

export interface StoreListMessagesReq {
  readonly conversationId: string;
  /**
   * `false` leaves reasoning parts out — the projection the "rebuild the
   * prompt" path wants. It is a projection, never a delete. Defaults to `true`.
   */
  readonly includeReasoning?: boolean;
  /** Exclusive. Only messages after this position; drives incremental loading. */
  readonly afterSeq?: number;
  readonly limit?: number;
}

export interface StoreMessageRefReq {
  readonly messageId: string;
}

export interface MessageRes {
  readonly message: StoredMessage;
}

export interface MessageListRes {
  readonly messages: readonly StoredMessage[];
}

/* -------------------------------------------------------------------------- */
/* mcp — tools the user's own MCP servers offer                               */
/* -------------------------------------------------------------------------- */

/**
 * Why a configured MCP server is not serving tools.
 *
 * Closed, and provider-neutral in the same sense {@link Concern} is: the UI owns
 * every sentence. Mirrors `vela_mcp::McpFailureCode`.
 *
 * There is no free-text arm and there must never be one. The text would be
 * written by a third-party process the user pasted a command line for — an
 * unbounded string from an untrusted source, rendered in a window. `ChatError`
 * makes the same argument for the same reason.
 *
 * The arms a user acts on differently:
 *  - `configUnreadable` — their file has a typo; nothing else could be read.
 *  - `configInvalid` — that one entry does not describe a launchable server.
 *  - `transportNotSupported` — their file is *correct* and this build cannot do
 *    it. It is no longer every remote (`url`) entry: `vela-mcp` implements the
 *    HTTP transport, so this now means a build whose composition root wired no
 *    HTTP backend into the MCP host. See the note on {@link McpServerTools}.
 *  - `spawnFailed` — the command is not on the machine, or not on `PATH`.
 *  - `endpointUnreachable` — an endpoint that remote entry names answered
 *    nothing at all: no DNS, no route, no TLS. The remote twin of `spawnFailed`,
 *    and a separate arm because the thing to fix is a URL or a network, not a
 *    missing program. Note *an* endpoint, not *the* server's: an OAuth entry
 *    names two hosts — its `url` and its `auth.tokenEndpoint` — and either going
 *    quiet reaches the user under this one code. Which host it was is in the
 *    Rust-side error and is deliberately not on this wire type, because the arms
 *    here carry no free text. A surface that means to name the host must get it
 *    from somewhere that has it; naming `url` on this code alone is a guess
 *    this arm cannot support.
 *  - `authorizationRequired` — a remote server needs a credential that is not
 *    stored, or refused the one that is. The only arm whose remedy is "sign in",
 *    which is why it is not folded into `handshakeFailed`.
 *  - `serverExited` — it was running and is not any more. Asking again restarts
 *    it: the pool replaces a dead connection rather than returning it. For a
 *    remote server this is also what an ended session reads as.
 */
export type McpFailureReason =
  | 'notConfigured'
  | 'configUnreadable'
  | 'configInvalid'
  | 'transportNotSupported'
  | 'spawnFailed'
  | 'endpointUnreachable'
  | 'authorizationRequired'
  | 'handshakeFailed'
  | 'serverExited'
  | 'protocolError'
  | 'timedOut'
  | 'serverError';

/**
 * A discriminated union rather than `{ connected: boolean; reason?: … }`,
 * because a reason is meaningless on a connected server and the boolean form
 * makes that state expressible.
 */
export type McpServerStatus =
  | { readonly kind: 'connected' }
  | { readonly kind: 'unavailable'; readonly reason: McpFailureReason };

/**
 * One tool an MCP server offers.
 *
 * `name`, `description` and `parameters` are deliberately the three fields
 * {@link ToolDefinitionInput} carries, so putting an MCP tool into a turn is a
 * projection and not a translation. `toolName` is the extra one: it is the
 * server's own name, which is what a call has to be addressed to, and carrying
 * it means nothing ever has to take `name` apart to recover it.
 */
export interface McpToolView {
  /** `mcp__<server>__<tool>`. Unique across servers; `toolName` is not. */
  readonly name: string;
  /** The server's own name for this tool. */
  readonly toolName: string;
  /** Empty when the server described nothing. Never absent. */
  readonly description: string;
  /** JSON Schema for the arguments object, verbatim from the server. */
  readonly parameters: unknown;
}

/**
 * One configured server and what it is currently offering.
 *
 * **An unavailable server keeps its row**, with `tools` empty. A server the user
 * configured that quietly vanished from this list is the silent reduction
 * conventions §9 forbids — they would see a shorter list and no reason for it.
 * That applies most of all to the arms that are not the user's fault:
 * `transportNotSupported`, which is this build saying it cannot speak the
 * transport their entry names, and `authorizationRequired`, which is a server
 * that is there and reachable and waiting to be signed into.
 */
export interface McpServerTools {
  readonly serverId: string;
  readonly status: McpServerStatus;
  readonly tools: readonly McpToolView[];
}

/**
 * Every configured server's tools.
 *
 * Connecting is lazy: the host spawns a server the first time this is called,
 * not at startup, and reuses the process afterwards. So this is a command that
 * can take as long as a process takes to start — and can also answer instantly
 * from cache, which is what the second call does.
 *
 * `configFailure` is `null` when the file read cleanly, **including when there
 * is no file at all** — no MCP servers configured is where every user starts,
 * and reporting the ordinary case as a fault would train them past the reasons
 * that matter.
 */
export interface McpListToolsRes {
  readonly configFailure: McpFailureReason | null;
  readonly servers: readonly McpServerTools[];
}

/* -------------------------------------------------------------------------- */
/* skills — the canonical store on disk, read one level at a time             */
/* -------------------------------------------------------------------------- */

/**
 * Why a directory in the skill store could not be read as a skill.
 *
 * A closed vocabulary the **renderer** words. Transcribed from
 * `SkillProblem` in `src-tauri/crates/vela-skills/src/document.rs`, and
 * `src/platform/skill-store-parity.test.ts` is what keeps the two lists equal:
 * a Rust variant added without its twin here fails `pnpm test`, and one added
 * here without its twin there fails `pnpm typecheck`.
 *
 * The format is the public Agent Skills spec — YAML frontmatter, then a
 * Markdown body — so most of these are the spec's own rules: a `name` of 1–64
 * lowercase alphanumerics and single hyphens that matches the directory it sits
 * in, and a `description` of 1–1024 characters.
 */
export type SkillProblem =
  | 'noSkillFile'
  | 'unreadable'
  | 'noFrontmatter'
  | 'unterminatedFrontmatter'
  | 'unsupportedFrontmatterSyntax'
  | 'duplicateFrontmatterKey'
  | 'missingName'
  | 'missingDescription'
  | 'nameIsNotWellFormed'
  | 'nameTooLong'
  | 'nameDoesNotMatchDirectory'
  | 'descriptionIsEmpty'
  | 'descriptionTooLong'
  | 'nameIsNotASinglePathSegment';

/**
 * One entry of the first level of progressive disclosure.
 *
 * A skill that cannot be parsed is **listed with its problem**, never dropped:
 * a skill the user installed that vanishes from every surface with no sentence
 * saying why is the silently-wrong outcome conventions §9 rule 6 forbids.
 *
 * A discriminated union rather than an entry with optional halves, so no
 * consumer can read a description off a broken skill.
 */
export type SkillListing =
  | {
      readonly kind: 'skill';
      /**
       * The directory name on disk. Equal to `name` for a valid skill — the
       * spec requires it — and carried separately because the mount is keyed by
       * the directory, so anything explaining a mount names this one.
       */
      readonly directory: string;
      readonly name: string;
      readonly description: string;
    }
  | { readonly kind: 'invalid'; readonly directory: string; readonly problem: SkillProblem };

export interface SkillsListRes {
  /** Every directory in the store, in name order. Empty is the normal state. */
  readonly skills: readonly SkillListing[];
}

export interface SkillsReadReq {
  /** One path segment. Anything else is `INVALID_PAYLOAD`. */
  readonly name: string;
}

/**
 * The third level of disclosure: what a skill carries, **by name only**.
 *
 * No file's contents cross the bridge. The spec's loading model fetches this
 * level "only as needed", and the need is per file; a caller that wants one
 * asks for it, and no command does that today.
 */
export interface SkillResources {
  readonly scripts: readonly string[];
  readonly references: readonly string[];
  readonly assets: readonly string[];
}

/**
 * The second level of disclosure, for exactly one skill.
 *
 * `invalid` is a **response**, not an error: the request was well formed and
 * the host answered it truthfully — the file on disk is not a skill. Making it
 * an error would split "this skill is broken" across a catch block and a
 * branch, in a renderer that already has to word the same vocabulary for
 * {@link SkillListing}.
 */
export type SkillsReadRes =
  | {
      readonly kind: 'skill';
      readonly name: string;
      readonly description: string;
      /** The instruction text: loaded because this skill was asked for. */
      readonly body: string;
      readonly resources: SkillResources;
    }
  | { readonly kind: 'invalid'; readonly problem: SkillProblem };

/* -------------------------------------------------------------------------- */
/* ui — window layout that must survive a restart                             */
/* -------------------------------------------------------------------------- */

/**
 * Persisted in the user's own database, not in webview storage: a sidebar the
 * user dragged is part of how their workspace looks, and it should not live
 * somewhere they cannot back up and the browser profile can clear.
 *
 * Out-of-range values are clamped by the host, never rejected. A width is a
 * preference, not an assertion.
 */
export interface UiLayout {
  readonly sidebarWidth: number;
  /** Collapsing keeps the width, so expanding restores what the user chose. */
  readonly sidebarCollapsed: boolean;
}

/* -------------------------------------------------------------------------- */
/* schedules                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How often a schedule comes round.
 *
 * A closed set of four rather than a cron expression, and the reason is the
 * same one `Concern` is a closed set: the UI owns every sentence it renders. A
 * cron string would have to be parsed to be described, and a schedules pane
 * that parses is a schedules pane that disagrees with the host about what a
 * given expression means.
 *
 * `once` is not a cadence in the ordinary sense — it fires and then the
 * schedule disables itself, which is a state the list shows rather than a
 * failure.
 */
export type Cadence = 'once' | 'hourly' | 'daily' | 'weekly';

/**
 * A schedule as this surface sees it.
 *
 * **No `providerId`, no `modelId`.** The stored row carries both, exactly as a
 * stored conversation does, and this view drops them for the reason
 * {@link ConversationSummary} drops them: conventions §0 rule 3, the UI branches
 * on capability and never on a backend identity.
 *
 * `nextRunAtMs` is an absolute epoch millisecond, so rendering "in 3 hours" is
 * arithmetic the renderer already knows how to do against its own clock.
 */
export interface ScheduleView {
  readonly id: string;
  readonly title: string;
  /** Sent verbatim as the first user message of every run. */
  readonly prompt: string;
  readonly cadence: Cadence;
  readonly nextRunAtMs: number;
  readonly enabled: boolean;
  readonly projectId: string | null;
  /**
   * Slots that came due while Vela was not running. **Counted, never fired** —
   * a laptop shut for a week owes an hourly schedule 168 runs, and opening 168
   * conversations at breakfast is not what the user asked for. One run and this
   * number is the honest answer.
   */
  readonly missedRuns: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/**
 * Where one attempt got to.
 *
 * `running` covers two situations the renderer cannot tell apart and does not
 * need to: a run genuinely in flight, and a run whose process died before it
 * finished. The second is repaired at the next startup, which turns it into a
 * `failed` with a reason.
 */
export type ScheduleRunStatus = 'running' | 'success' | 'failed';

/**
 * Whether the poll started a run or a person did.
 *
 * Carried because the two behave differently and the difference is visible: a
 * `manual` run does not move the schedule's next slot, so a history showing two
 * runs an hour apart on a daily schedule is correct rather than a bug.
 */
export type ScheduleRunTrigger = 'schedule' | 'manual';

/** One attempt at a schedule, finished or not. */
export interface ScheduleRunView {
  readonly id: string;
  readonly scheduleId: string;
  readonly status: ScheduleRunStatus;
  readonly trigger: ScheduleRunTrigger;
  readonly startedAtMs: number;
  /** `null` while the run is still in flight. */
  readonly finishedAtMs: number | null;
  readonly durationMs: number | null;
  /**
   * The conversation this run spawned, already holding the schedule's prompt.
   * Present from the moment the run starts, which is what lets a UI open a run
   * that has not finished. `null` only if the user deleted the conversation and
   * kept the history.
   */
  readonly conversationId: string | null;
  /**
   * Why a `failed` run failed. Free text from whatever failed, so it is
   * rendered and never matched — the same contract `ChatError.message` carries.
   */
  readonly error: string | null;
}

export interface SchedulesCreateReq {
  readonly title: string;
  readonly prompt: string;
  readonly cadence: Cadence;
  /**
   * When the first run is owed, absolute.
   *
   * **The renderer computes this, and that is deliberate.** "Nine tomorrow" is
   * a question about the user's timezone, which lives here, and a host that
   * re-derived it would be a second answer to what tomorrow means. What the
   * host owns is what happens after: cadences advance by fixed offsets, so
   * `daily` is exactly 24h and not "09:00 whatever the clocks did overnight".
   */
  readonly firstRunAtMs: number;
  readonly projectId?: string | undefined;
}

export interface SchedulesListReq {
  /**
   * Disabled schedules are hidden by default — disabling is the user saying
   * "not now", and a list that ignores it is a list that lies. The same rule
   * archived conversations follow.
   */
  readonly includeDisabled?: boolean | undefined;
}

export interface SchedulesRefReq {
  readonly scheduleId: string;
}

export interface SchedulesSetEnabledReq {
  readonly scheduleId: string;
  readonly enabled: boolean;
}

export interface SchedulesListRunsReq {
  readonly scheduleId: string;
  readonly limit?: number | undefined;
}

export interface ScheduleRes {
  readonly schedule: ScheduleView;
}

export interface ScheduleListRes {
  readonly schedules: readonly ScheduleView[];
}

export interface ScheduleRunListRes {
  readonly runs: readonly ScheduleRunView[];
}

/* -------------------------------------------------------------------------- */
/* the contract                                                               */
/* -------------------------------------------------------------------------- */

export interface IpcContract {
  app_info: { req: EmptyPayload; res: AppInfo };
  chat_cancel: { req: ChatCancelReq; res: ChatCancelRes };
  chat_send: { req: ChatSendReq; res: ChatSendRes };
  diagnostics_debug_log_get: { req: EmptyPayload; res: DebugLogStatus };
  diagnostics_debug_log_set: { req: DebugLogSetReq; res: DebugLogStatus };
  diagnostics_echo: { req: EchoReq; res: EchoRes };
  endpoint_disable: { req: EmptyPayload; res: EndpointStatus };
  endpoint_enable: { req: EndpointEnableReq; res: EndpointStatus };
  endpoint_status: { req: EmptyPayload; res: EndpointStatus };
  mcp_list_tools: { req: EmptyPayload; res: McpListToolsRes };
  memory_add: { req: MemoryAddReq; res: MemoryRes };
  memory_clear_scope: { req: MemoryScopeReq; res: MemoryClearRes };
  memory_delete: { req: MemoryRefReq; res: Ack };
  memory_list: { req: MemoryScopeReq; res: MemoryListRes };
  memory_update: { req: MemoryUpdateReq; res: MemoryRes };
  models_capabilities: { req: ModelsRefReq; res: ModelCapabilityReport };
  models_list: { req: ModelsProviderRefReq; res: ModelsListRes };
  models_probe: { req: ModelsRefReq; res: ModelsProbeRes };
  /**
   * The project surface. Its request and response shapes live in
   * `src/platform/contract-project.ts`, which is where they are argued; only the
   * command-to-payload mapping is here, because this is the file the allowlist
   * and the Rust parity test read. See that file's AMENDMENTS 5 for what changed
   * when these stopped being declared-but-unregistered.
   */
  project_create: { req: ProjectCreateReq; res: ProjectRes };
  project_delete: { req: ProjectDeleteReq; res: Ack };
  project_get: { req: ProjectRefReq; res: ProjectRes };
  project_layout: { req: ProjectRefReq; res: ProjectLayoutRes };
  project_list: { req: ProjectListReq; res: ProjectListRes };
  project_move_conversation: { req: ProjectMoveConversationReq; res: Ack };
  project_reconcile_skills: { req: ProjectRefReq; res: ProjectLayoutRes };
  project_update: { req: ProjectUpdateReq; res: ProjectRes };
  sandbox_approve: { req: SandboxApproveReq; res: Ack };
  sandbox_cancel: { req: SandboxCancelReq; res: SandboxCancelRes };
  sandbox_policy: { req: EmptyPayload; res: SandboxPolicySnapshot };
  sandbox_release: { req: SandboxReleaseReq; res: Ack };
  sandbox_report_document: { req: SandboxReportDocumentReq; res: Ack };
  sandbox_submit: { req: SandboxSubmitReq; res: SandboxSubmitRes };
  schedules_create: { req: SchedulesCreateReq; res: ScheduleRes };
  schedules_delete: { req: SchedulesRefReq; res: Ack };
  schedules_list: { req: SchedulesListReq; res: ScheduleListRes };
  schedules_list_runs: { req: SchedulesListRunsReq; res: ScheduleRunListRes };
  schedules_set_enabled: { req: SchedulesSetEnabledReq; res: ScheduleRes };
  secrets_delete: { req: SecretsRefReq; res: Ack };
  secrets_set: { req: SecretsSetReq; res: Ack };
  secrets_status: { req: SecretsRefReq; res: SecretsStatusRes };
  settings_delete_provider: { req: SettingsProviderRefReq; res: Ack };
  settings_get: { req: EmptyPayload; res: SettingsSnapshot };
  settings_put_provider: { req: SettingsPutProviderReq; res: ProviderView };
  settings_set_theme: { req: SettingsSetThemeReq; res: SettingsSetThemeRes };
  skills_list: { req: EmptyPayload; res: SkillsListRes };
  skills_read: { req: SkillsReadReq; res: SkillsReadRes };
  store_append_message: { req: StoreAppendMessageReq; res: MessageRes };
  store_autotitle_conversation: { req: StoreConversationRefReq; res: ConversationRes };
  store_create_conversation: { req: StoreCreateConversationReq; res: ConversationRes };
  store_delete_conversation: { req: StoreConversationRefReq; res: Ack };
  store_delete_message: { req: StoreMessageRefReq; res: Ack };
  store_list_conversations: { req: StoreListConversationsReq; res: ConversationListRes };
  store_list_messages: { req: StoreListMessagesReq; res: MessageListRes };
  store_rename_conversation: { req: StoreRenameConversationReq; res: ConversationRes };
  store_search: { req: StoreSearchReq; res: StoreSearchRes };
  store_update_message: { req: StoreUpdateMessageReq; res: MessageRes };
  ui_get_layout: { req: EmptyPayload; res: UiLayout };
  ui_set_layout: { req: UiLayout; res: UiLayout };
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
  'diagnostics_debug_log_get',
  'diagnostics_debug_log_set',
  'diagnostics_echo',
  'endpoint_disable',
  'endpoint_enable',
  'endpoint_status',
  'mcp_list_tools',
  'memory_add',
  'memory_clear_scope',
  'memory_delete',
  'memory_list',
  'memory_update',
  'models_capabilities',
  'models_list',
  'models_probe',
  'project_create',
  'project_delete',
  'project_get',
  'project_layout',
  'project_list',
  'project_move_conversation',
  'project_reconcile_skills',
  'project_update',
  'sandbox_approve',
  'sandbox_cancel',
  'sandbox_policy',
  'sandbox_release',
  'sandbox_report_document',
  'sandbox_submit',
  'schedules_create',
  'schedules_delete',
  'schedules_list',
  'schedules_list_runs',
  'schedules_set_enabled',
  'secrets_delete',
  'secrets_set',
  'secrets_status',
  'settings_delete_provider',
  'settings_get',
  'settings_put_provider',
  'settings_set_theme',
  'skills_list',
  'skills_read',
  'store_append_message',
  'store_autotitle_conversation',
  'store_create_conversation',
  'store_delete_conversation',
  'store_delete_message',
  'store_list_conversations',
  'store_list_messages',
  'store_rename_conversation',
  'store_search',
  'store_update_message',
  'ui_get_layout',
  'ui_set_layout',
] as const;

/**
 * Compile-time proof that the allowlist contains only real commands.
 *
 * The reverse direction — every declared command is listed — is held twice in
 * `src/platform/contract.test.ts`: once at `pnpm typecheck` by an `Exclude`
 * annotation, and once at `pnpm test` by reading {@link IpcContract}'s members
 * back out of this file's source, since an interface has no runtime value to
 * enumerate.
 *
 * This paragraph used to say that the reverse direction was asserted at runtime
 * and that TypeScript could not express it. Both halves were wrong: the runtime
 * assertion compared the allowlist against a hand-typed copy of the key list in
 * the test file, so it could not see a command missing from either real list,
 * and the annotation this sentence called impossible is nine lines and now sits
 * next to it.
 */
const _allowlistIsWellTyped: readonly CommandName[] = COMMAND_ALLOWLIST;
void _allowlistIsWellTyped;

export function isAllowedCommand(name: string): name is CommandName {
  return (COMMAND_ALLOWLIST as readonly string[]).includes(name);
}
