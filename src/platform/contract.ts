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

/** Enumerable, provider-neutral reasons. The UI owns the wording. */
export type Concern =
  | 'plaintextTrafficLeavesDevice'
  | 'credentialSentInPlaintext'
  | 'remoteEndpointIsUnauthenticated'
  | 'requiredCredentialMissing';

export interface SecurityPosture {
  readonly level: RiskLevel;
  readonly scope: NetworkScope;
  readonly leavesDevice: boolean;
  readonly trafficIsPlaintext: boolean;
  readonly credentialSentInPlaintext: boolean;
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
/* the contract                                                               */
/* -------------------------------------------------------------------------- */

export interface IpcContract {
  app_info: { req: EmptyPayload; res: AppInfo };
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
