/**
 * The renderer-side error type for everything that crosses the bridge.
 *
 * The host always rejects with `{ code, message }` (see
 * `src-tauri/src/ipc/error.rs`). Anything else — a thrown string, a network
 * blip in the browser fake, a genuine JS bug — is normalised into the same
 * shape here so UI code has exactly one error contract to handle.
 */

/** Mirrors `IpcErrorCode` in `src-tauri/src/ipc/error.rs`, plus renderer-only codes. */
export const IPC_ERROR_CODES = [
  'INVALID_PAYLOAD',
  'NOT_FOUND',
  'SECRET_STORE_UNAVAILABLE',
  'UNSUPPORTED',
  'INTERNAL',
  /** Renderer-only: the command is not on the allowlist. Never reaches the host. */
  'UNKNOWN_COMMAND',
  /** Renderer-only: host and renderer disagree on the contract version. */
  'CONTRACT_MISMATCH',
] as const;

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number];

export interface IpcErrorShape {
  readonly code: IpcErrorCode;
  readonly message: string;
}

export class PlatformError extends Error implements IpcErrorShape {
  readonly code: IpcErrorCode;
  /** The command that failed, for logging. Never included in user-facing copy. */
  readonly command: string | undefined;

  constructor(code: IpcErrorCode, message: string, command?: string) {
    super(message);
    this.name = 'PlatformError';
    this.code = code;
    this.command = command;
  }
}

function isIpcErrorShape(value: unknown): value is IpcErrorShape {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { code?: unknown; message?: unknown };
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.message === 'string' &&
    (IPC_ERROR_CODES as readonly string[]).includes(candidate.code)
  );
}

/**
 * Turn anything thrown by an adapter into a {@link PlatformError}. UI code
 * should never see a raw unknown.
 */
export function toPlatformError(thrown: unknown, command?: string): PlatformError {
  if (thrown instanceof PlatformError) return thrown;
  if (isIpcErrorShape(thrown)) {
    return new PlatformError(thrown.code, thrown.message, command);
  }
  if (thrown instanceof Error) {
    return new PlatformError('INTERNAL', thrown.message, command);
  }
  return new PlatformError('INTERNAL', String(thrown), command);
}
