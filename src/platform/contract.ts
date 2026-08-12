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
/* the contract                                                               */
/* -------------------------------------------------------------------------- */

export interface IpcContract {
  app_info: { req: EmptyPayload; res: AppInfo };
  diagnostics_echo: { req: EchoReq; res: EchoRes };
  secrets_delete: { req: SecretsRefReq; res: Ack };
  secrets_set: { req: SecretsSetReq; res: Ack };
  secrets_status: { req: SecretsRefReq; res: SecretsStatusRes };
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
