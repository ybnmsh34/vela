/**
 * The renderer's door to `CONTRACT-SANDBOX`.
 *
 * A plain factory over a {@link PlatformAdapter}, exactly as every other
 * repository in this folder is, so a feature hook takes one of these and a test
 * takes a `BrowserAdapter` and needs no DOM.
 *
 * ## Who holds one
 *
 * `src/app/App.tsx` builds it once and hands it to `CanvasSurface`, which is the
 * only consumer in the tree. That sentence is the point of this paragraph: this
 * file was tested and **on no import path from `src/main.tsx`** for as long as
 * Canvas ran its own renderer-side stand-in, and a door nothing walks through is
 * not a door. It covered five commands while it sat there;
 * {@link SandboxRepository.reportDocument} is the sixth and was added with the
 * wiring that finally gave the file a caller.
 * `src/runtime/reachable.test.ts` now fails if this module leaves the graph again.
 *
 * ## The one rule a caller must not get wrong
 *
 * **Subscribe before you submit.** Events for a run can be emitted before the
 * invoke promise settles — that is the whole reason the caller mints `runId` —
 * so {@link SandboxRepository.watch} is a separate call that comes first.
 * `submit` deliberately does not take a handler, because an API that accepted
 * one would look like it closed this race and would not.
 *
 * ## What this file does not do
 *
 * It does not decide anything. It does not re-check a digest, re-check a mount,
 * or classify a program: every one of those is host-side, against paths the host
 * resolved, and a renderer-side copy would be theatre performed on the side of
 * the boundary that is already assumed compromised. The digest in particular is
 * opaque here and is echoed back untouched.
 */

import type { PlatformAdapter, Unsubscribe } from '@/platform/adapter';
import type { Ack } from '@/platform/contract';
import type {
  ApprovalDecision,
  CancelReason,
  DocumentObservation,
  SandboxCancelRes,
  SandboxEvent,
  SandboxPolicySnapshot,
  SandboxRunId,
  SandboxSubmitReq,
  SandboxSubmitRes,
} from '@/platform/contract-sandbox';

/** One event for the run being watched, with its delivery position. */
export interface WatchedSandboxEvent {
  readonly seq: number;
  readonly event: SandboxEvent;
}

export interface SandboxRepository {
  /**
   * What this machine can actually do, and what the user's permission level is.
   * A surface reads this before offering an execute affordance: a build
   * reporting `filesystem: 'unenforced'` should say what that means rather than
   * draw a padlock.
   */
  policy(): Promise<SandboxPolicySnapshot>;
  /**
   * Deliver every event for one run. Call before {@link submit}.
   *
   * Events for other runs are dropped here rather than by the caller, so a
   * surface watching two runs cannot cross their streams.
   */
  watch(runId: SandboxRunId, handler: (event: WatchedSandboxEvent) => void): Promise<Unsubscribe>;
  submit(request: SandboxSubmitReq): Promise<SandboxSubmitRes>;
  /** `requestDigest` is opaque: pass back exactly what the host handed out. */
  approve(runId: SandboxRunId, requestDigest: string, decision: ApprovalDecision): Promise<Ack>;
  cancel(runId: SandboxRunId, reason: CancelReason): Promise<SandboxCancelRes>;
  /**
   * Let go of a run. Required rather than optional: a retained scratch
   * directory is a directory nothing else will ever delete.
   */
  release(runId: SandboxRunId): Promise<Ack>;
  /**
   * What the surface saw the frame do. The one command that travels *toward*
   * the host with an observation rather than a request.
   *
   * It is here because the host cannot see a frame: `SandboxReportDocumentReq`
   * exists precisely so the side that can see one may say so. This build's host
   * discards every report — `SandboxHost::report_document` in
   * `src-tauri/crates/vela-sandbox/src/host.rs` has an empty body, because a
   * host that accepts no document run has no run for a report to belong to — so
   * a caller must not read an `Ack` here as "the outcome was recorded".
   */
  reportDocument(runId: SandboxRunId, observation: DocumentObservation): Promise<Ack>;
}

export function createSandboxRepository(adapter: PlatformAdapter): SandboxRepository {
  return {
    async policy() {
      return adapter.invoke('sandbox_policy', {});
    },

    async watch(runId, handler) {
      return adapter.listen('sandbox:event', (envelope) => {
        if (envelope.runId !== runId) return;
        handler({ seq: envelope.seq, event: envelope.event });
      });
    },

    async submit(request) {
      return adapter.invoke('sandbox_submit', request);
    },

    async approve(runId, requestDigest, decision) {
      return adapter.invoke('sandbox_approve', { runId, requestDigest, decision });
    },

    async cancel(runId, reason) {
      return adapter.invoke('sandbox_cancel', { runId, reason });
    },

    async release(runId) {
      return adapter.invoke('sandbox_release', { runId });
    },

    async reportDocument(runId, observation) {
      return adapter.invoke('sandbox_report_document', { runId, observation });
    },
  };
}
