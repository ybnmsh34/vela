/**
 * Turning an artifact into a submit CONTRACT-SANDBOX will accept, and checking
 * the three things it fixes about a document run.
 *
 * `src/platform/contract-sandbox.ts` states, in prose, that "Three parts of a
 * document submit are fixed, and a request that says otherwise is refused with
 * `documentGrantInvalid` rather than quietly corrected: `processes` is 1 …
 * `fileWriteBytes` is 0; and `mounts` is empty." It also states that the
 * isolation floor's family must match the program's, and that the mismatch is
 * `isolationFamilyMismatch` rather than a coercion. That file's own header says
 * no test in the repo enforces a single rule it states. {@link documentRefusal}
 * is those four rules as code, and `document-run.test.ts` is a machine watching
 * them — which is the difference between a specification and a guarantee.
 *
 * ## Why the checks live on this side of the seam at all
 *
 * They are not a security check and must never be described as one: the host
 * decides refusals, over paths and numbers it resolved itself, and a renderer
 * that re-checked would be performing theatre on the compromised side of the
 * boundary — the same argument the contract makes about `requestDigest`. What
 * these are is a **constructor's own postcondition**. {@link documentSubmit} is
 * the one place in Vela that builds a document submit, so it is the one place
 * that can be held to building a legal one, and holding it there means a
 * defect shows up in a unit test rather than as a refusal in front of a user.
 */

import {
  DEFAULT_DOCUMENT_LIMITS,
  NO_FILESYSTEM,
  type DocumentProgram,
  type DocumentScripts,
  type Isolation,
  type RefusalReason,
  type SandboxRunId,
  type SandboxSubmitReq,
} from '@/platform/contract-sandbox';
import type { ProjectId } from '@/platform/contract-project';

/**
 * The floor every Canvas submit names, and the reason it is a constant.
 *
 * `opaqueOriginFrame` is the only value that describes what a Canvas frame
 * actually gets — a browser-enforced boundary — and naming `sameOrigin` would
 * be asking to be served a document that can read Vela's DOM, which the contract
 * says no submit in Vela should ever be served. Naming `ownRendererProcess`
 * would be honest about what we would like and would be refused with
 * `isolationUnavailable` by every backend that exists, so Canvas would render
 * nothing at all. This is the floor Canvas can both demand and be served.
 */
export const CANVAS_ISOLATION_FLOOR: Isolation = {
  family: 'document',
  level: 'opaqueOriginFrame',
};

/**
 * The same program with a different script decision.
 *
 * Only the two script-capable languages have the field, so this is total on
 * {@link DocumentProgram} without a runtime check: an `svg` program comes back
 * unchanged because there is nothing on it to change, which is the shape of the
 * contract's own union doing the work instead of a validator.
 */
export function withScripts(program: DocumentProgram, scripts: DocumentScripts): DocumentProgram {
  if (program.language === 'html' || program.language === 'react') {
    return { ...program, scripts };
  }
  return program;
}

/**
 * Build the submit for one document.
 *
 * Everything except the program and the ids is fixed, and each fixed value is
 * the contract's own: {@link NO_FILESYSTEM} is "the whole of the filesystem a
 * document gets", {@link DEFAULT_DOCUMENT_LIMITS} carries the `processes: 1` and
 * `fileWriteBytes: 0` that a document submit must have, and the network policy is
 * `denied` because a drawn artifact that can reach the network is an artifact
 * that can phone home about what it was drawn next to.
 */
export function documentSubmit(
  runId: SandboxRunId,
  projectId: ProjectId,
  program: DocumentProgram,
): SandboxSubmitReq {
  return {
    runId,
    projectId,
    program,
    filesystem: NO_FILESYSTEM,
    network: { kind: 'denied' },
    limits: DEFAULT_DOCUMENT_LIMITS,
    minimumIsolation: CANVAS_ISOLATION_FLOOR,
  };
}

/**
 * The refusal this request would earn, or `null` if it earns none.
 *
 * Ordered so the answer does not depend on which check runs first: a family
 * mismatch is decided before the document-specific grant rules, because on a
 * mismatched request the grant rules are being read against the wrong family.
 */
export function documentRefusal(request: SandboxSubmitReq): RefusalReason | null {
  if (request.program.kind !== request.minimumIsolation.family) return 'isolationFamilyMismatch';
  if (request.program.kind !== 'document') return null;
  if (request.limits.processes !== 1) return 'documentGrantInvalid';
  if (request.limits.fileWriteBytes !== 0) return 'documentGrantInvalid';
  if (request.filesystem.mounts.length !== 0) return 'documentGrantInvalid';
  return null;
}

/*
 * `autoApproves` used to live here. It is now in `document-host-double.ts`,
 * because approval is a host decision — `within_profile` in
 * `src-tauri/crates/vela-sandbox/src/admission.rs` is the one that decides it —
 * and once `CanvasSurface` was wired to `src/data/sandbox-repository.ts` its only
 * caller in this tree was the fake host. A decision procedure sitting in shipping
 * renderer code with no shipping caller is the defect this feature was repaired
 * for, one size smaller. Its tests moved with it, including the one that holds
 * the contract's "over the request, never over the backend" rule.
 */
