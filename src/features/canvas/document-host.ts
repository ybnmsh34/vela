/**
 * The document family's run lifetime, implemented.
 *
 * ## Read this before believing anything else in this file
 *
 * **The six `sandbox_*` commands are not wired.** They are declared in
 * `src/platform/contract-sandbox.ts`, they are on no allowlist, there is no Rust
 * module behind them, and `isAllowedCommand` in `src/platform/contract.ts`
 * answers `false` for every one of them. This file is not those commands and does
 * not pretend to be: it is a **renderer-side implementation of the document
 * family's lifetime and sequencing**, sitting behind {@link DocumentHost}, which
 * is shaped exactly like the four commands a document run needs so that wiring
 * the real ones later is a change to one constructor call and not to the surface.
 *
 * What that costs, stated plainly rather than left for a reader to work out:
 *
 *  - **`permissionIsOff` is not a boundary here.** The contract's whole claim for
 *    it is that it is host-held, so no request can raise it. Held in the renderer
 *    it is held by the same process it is meant to constrain. It is implemented
 *    because the *surface* must behave correctly when it is set — Canvas shows
 *    source and offers no execute affordance — not because this placement makes
 *    it enforcement.
 *  - **`requestDigest` is an identity token, not a security check.** The contract
 *    calls it host-computed and host-checked and forbids the renderer
 *    recomputing it. Here there is no other side to compute it, so it does the
 *    one thing it can still do honestly: bind an approval to the exact bytes and
 *    grant that were shown, so a second submit under the same run id cannot
 *    inherit the first one's answer.
 *  - **`wallClockMs` is `supervisor` and says so.** A timer in this process
 *    notices a frame that never rendered. It is real and it is racy.
 *
 * What *is* genuinely enforced is the part the contract puts on this side of the
 * seam on purpose: the browser boundary. The frame is drawn by
 * `document-frame.ts` with an opaque origin, and no `accepted` event means no
 * frame — which the contract names as the rule a Canvas surface must follow, and
 * `CanvasPanel.test.tsx` is what watches it follow it.
 *
 * ## What this implements from the contract, exactly
 *
 * The event ordering block, the "exactly one `settled`, always" rule, dense
 * 0-based `seq` per run, the document-only exception that `diagnostic` and
 * `truncated` may keep arriving after `settled` until release, refusal-as-event
 * for every member of `RefusalReason` this host can reach, and the one failure
 * that rejects the call instead — a run id already in flight.
 */

import {
  DEFAULT_AUTO_APPROVAL_PROFILE,
  isolationMeets,
  type ApprovalRequest,
  type EffectiveGrant,
  type PermissionLevel,
  type RefusalReason,
  type RunUsage,
  type SandboxApproveReq,
  type SandboxBackendReport,
  type SandboxBackends,
  type SandboxCancelReq,
  type SandboxCancelRes,
  type SandboxEvent,
  type SandboxEventEnvelope,
  type SandboxLanguage,
  type SandboxOutcome,
  type SandboxPolicySnapshot,
  type SandboxReleaseReq,
  type SandboxReportDocumentReq,
  type SandboxRunId,
  type SandboxSubmitReq,
  type SandboxSubmitRes,
} from '@/platform/contract-sandbox';
import type { Ack } from '@/platform/contract';
import { PlatformError } from '@/platform/errors';

import { autoApproves, documentRefusal } from './document-run';

/**
 * The seam. Four of the six commands, in the shape `SandboxContract` gives them.
 *
 * `sandbox_policy` is here because a surface must know the permission level and
 * the language set before it offers a button; the other two absentees are
 * `sandbox_approve`'s twin and nothing — this interface is the whole of what
 * Canvas needs, and adding a method it does not call would be the defect this
 * repo keeps finding wearing an interface's clothes.
 */
export interface DocumentHost {
  policy(): SandboxPolicySnapshot;
  /** Subscribe **before** submitting: a refusal can be emitted synchronously. */
  subscribe(listener: (envelope: SandboxEventEnvelope) => void): () => void;
  submit(request: SandboxSubmitReq): SandboxSubmitRes;
  approve(request: SandboxApproveReq): Ack;
  reportDocument(request: SandboxReportDocumentReq): Ack;
  cancel(request: SandboxCancelReq): SandboxCancelRes;
  release(request: SandboxReleaseReq): Ack;
}

/**
 * What a browser frame can and cannot hold, per guarantee.
 *
 * Every `kernel` below is a claim about a mechanism, so each one names it:
 *
 *  - `network` — the frame's first `<meta>` is `default-src 'none'` and its
 *    `sandbox` attribute never carries `allow-same-origin`, so a request is
 *    refused by the browser rather than by a policy this process consults.
 *    `document-frame.test.ts` asserts the meta is there and is first; without
 *    that assertion this field would be a sentence about a thing nobody checked.
 *  - `filesystem` — `NO_FILESYSTEM` is an empty mount set, and there is no
 *    mechanism by which a mount could be attached to a frame at all. The empty
 *    scope is not merely intended; it is the only expressible one.
 *  - `processTree` — removing the element destroys the frame and everything it
 *    owns. The browser holds that.
 *
 * `memoryBytes` and `cpuMillicores` are `unenforced` because a frame sharing the
 * app's renderer process has nothing to enforce them with, which is what the
 * contract predicts for exactly this level.
 */
const DOCUMENT_BACKEND: SandboxBackendReport = {
  isolation: { family: 'document', level: 'opaqueOriginFrame' },
  maximumIsolation: { family: 'document', level: 'opaqueOriginFrame' },
  evidence: 'declared',
  network: 'kernel',
  filesystem: 'kernel',
  processTree: 'kernel',
  limits: {
    wallClockMs: 'supervisor',
    memoryBytes: 'unenforced',
    cpuMillicores: 'unenforced',
    outputBytes: 'supervisor',
    processes: 'kernel',
    fileWriteBytes: 'kernel',
  },
};

/**
 * There is no process backend, and this is what saying so looks like.
 *
 * `none` with every guarantee `unenforced` is the truthful self-description the
 * contract makes room for. It is paired with an empty process half of
 * {@link CANVAS_LANGUAGES}, so a `bash` submit is refused `languageUnsupported`
 * before this report is ever consulted — a caller learns from `languages` rather
 * than by submitting, which is what that field is for.
 */
const ABSENT_PROCESS_BACKEND: SandboxBackendReport = {
  isolation: { family: 'process', level: 'none' },
  maximumIsolation: { family: 'process', level: 'none' },
  evidence: 'declared',
  network: 'unenforced',
  filesystem: 'unenforced',
  processTree: 'unenforced',
  limits: {
    wallClockMs: 'unenforced',
    memoryBytes: 'unenforced',
    cpuMillicores: 'unenforced',
    outputBytes: 'unenforced',
    processes: 'unenforced',
    fileWriteBytes: 'unenforced',
  },
};

const BACKENDS: SandboxBackends = {
  process: ABSENT_PROCESS_BACKEND,
  document: DOCUMENT_BACKEND,
};

/**
 * What this build can actually draw, and the two absences are the honest part.
 *
 * `react` is absent because nothing in this tree turns JSX into a frame: React 19
 * ships no UMD build to inline into an opaque-origin document, and there is no
 * transpiler bundled. `mermaid` is absent because the contract's "compiled to SVG
 * by a bundled renderer" describes a renderer that is not bundled. The
 * alternative to leaving them out was reporting `sourceRejectedByParser` for
 * both, which would be a failure invented to describe a parser that does not
 * exist — a lie in the shape of a diagnostic. A caller reads this list and shows
 * source instead, which is what the contract designed the field for.
 */
export const CANVAS_LANGUAGES: readonly SandboxLanguage[] = ['html', 'svg'];

/** More live artifacts than this and the panel is a leak, not a feature. */
const MAXIMUM_CONCURRENT_RUNS = 8;

interface RunRecord {
  readonly request: SandboxSubmitReq;
  readonly startedAt: number;
  seq: number;
  phase: 'awaitingApproval' | 'running' | 'settled';
  digest: string;
  truncated: boolean;
  droppedBytes: number;
  deadline: ReturnType<typeof setTimeout> | null;
}

export interface LocalDocumentHostOptions {
  /**
   * The user's setting. Held here because this host is where policy lives in
   * this build; when `sandbox_policy` is wired it comes from the host instead
   * and this option goes away.
   */
  readonly permission?: PermissionLevel;
  /** Injectable clock so a test can assert a usage number rather than a range. */
  readonly now?: () => number;
}

/**
 * A non-cryptographic hash of the canonical request.
 *
 * FNV-1a over `JSON.stringify` of the fields an approval is about. It is not a
 * defence against anything and is not described as one — see the header. What it
 * buys is that an approval carries the identity of the bytes that were shown, so
 * an answer cannot be replayed onto a different program under the same run id.
 */
function digestOf(request: SandboxSubmitReq): string {
  const canonical = JSON.stringify([
    request.runId,
    request.projectId,
    request.program,
    request.filesystem,
    request.network,
    request.limits,
    request.minimumIsolation,
  ]);
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export class LocalDocumentHost implements DocumentHost {
  readonly #runs = new Map<SandboxRunId, RunRecord>();
  readonly #listeners = new Set<(envelope: SandboxEventEnvelope) => void>();
  readonly #permission: PermissionLevel;
  readonly #now: () => number;

  constructor(options: LocalDocumentHostOptions = {}) {
    this.#permission = options.permission ?? 'ask';
    this.#now = options.now ?? (() => Date.now());
  }

  policy(): SandboxPolicySnapshot {
    return {
      permission: this.#permission,
      profile: DEFAULT_AUTO_APPROVAL_PROFILE,
      backends: BACKENDS,
      languages: CANVAS_LANGUAGES,
      // Required, and about a family this host does not serve. `languages`
      // contains no process language, so no program will ever find itself on
      // this guest; the value names the platform Vela ships to rather than
      // describing a guest that does not exist.
      guestPlatform: 'windows',
      activeRuns: this.#runs.size,
      maximumConcurrentRuns: MAXIMUM_CONCURRENT_RUNS,
    };
  }

  subscribe(listener: (envelope: SandboxEventEnvelope) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Admit a run, then decide about it.
   *
   * The refusal order is a decision, not an accident, and it is stated because
   * two implementations that ordered these differently would report different
   * reasons for the same bad request. Permission first, because a host that is
   * switched off has no opinion about the rest; then capacity, which is about
   * this host rather than this request; then the request's own shape; then what
   * the backend can reach.
   */
  submit(request: SandboxSubmitReq): SandboxSubmitRes {
    if (this.#runs.has(request.runId)) {
      // The one failure that rejects the call rather than arriving as an event:
      // the only stream that id names belongs to the run already using it, and
      // pushing a refusal onto it would tell a different caller their healthy
      // run had failed.
      throw new PlatformError('INVALID_PAYLOAD', 'run id already in flight');
    }

    const atCapacity = this.#runs.size >= MAXIMUM_CONCURRENT_RUNS;
    const record: RunRecord = {
      request,
      startedAt: this.#now(),
      seq: 0,
      phase: 'awaitingApproval',
      digest: digestOf(request),
      truncated: false,
      droppedBytes: 0,
      deadline: null,
    };
    this.#runs.set(request.runId, record);

    const refusal = this.#refusalFor(request, atCapacity);
    if (refusal !== null) {
      this.#settle(record, { kind: 'refused', reason: refusal, mountIndex: null, protectedRoot: null });
      return { runId: request.runId, admitted: true };
    }

    if (this.#permission === 'full' || autoApproves(DEFAULT_AUTO_APPROVAL_PROFILE, request)) {
      this.#accept(record);
      return { runId: request.runId, admitted: true };
    }

    const approval: ApprovalRequest = {
      runId: request.runId,
      requestDigest: record.digest,
      program: request.program,
      grant: this.#grantFor(request),
    };
    this.#emit(record, { type: 'awaitingApproval', request: approval });
    return { runId: request.runId, admitted: true };
  }

  approve(request: SandboxApproveReq): Ack {
    const record = this.#runs.get(request.runId);
    if (record === undefined || record.phase !== 'awaitingApproval') return { ok: false };
    if (request.requestDigest !== record.digest) {
      throw new PlatformError('INVALID_PAYLOAD', 'approval does not match the request');
    }
    if (request.decision === 'deny') {
      this.#settle(record, {
        kind: 'refused',
        reason: 'approvalDenied',
        mountIndex: null,
        protectedRoot: null,
      });
      return { ok: true };
    }
    this.#accept(record);
    return { ok: true };
  }

  /**
   * One observation in, at most one event out.
   *
   * A `rendered` or `failed` report for a run this host has already settled is
   * dropped silently, because it is a race the host is entitled to win — the
   * wall-clock timer and a slow first render can both be right. A `diagnostic`
   * or `truncated` is **not** dropped after settling: a document that has
   * rendered stays live, and a canvas artefact that throws at minute three is
   * the case the contract carves out by name.
   */
  reportDocument(request: SandboxReportDocumentReq): Ack {
    const record = this.#runs.get(request.runId);
    if (record === undefined) return { ok: false };
    const observation = request.observation;

    switch (observation.kind) {
      case 'rendered':
        if (record.phase !== 'running') return { ok: false };
        this.#settle(record, { kind: 'rendered', renderMs: observation.renderMs });
        return { ok: true };

      case 'failed':
        if (record.phase !== 'running') return { ok: false };
        this.#settle(record, { kind: 'documentFailed', reason: observation.reason });
        return { ok: true };

      case 'diagnostic':
        if (record.phase === 'awaitingApproval') return { ok: false };
        this.#emit(record, {
          type: 'diagnostic',
          severity: observation.severity,
          text: observation.text,
        });
        return { ok: true };

      case 'truncated':
        record.droppedBytes += observation.droppedBytes;
        if (record.truncated) return { ok: false };
        record.truncated = true;
        this.#emit(record, { type: 'truncated', droppedBytes: observation.droppedBytes });
        return { ok: true };
    }
  }

  cancel(request: SandboxCancelReq): SandboxCancelRes {
    const record = this.#runs.get(request.runId);
    if (record === undefined) return { cancelled: false };
    if (record.phase === 'settled') {
      // "On a document run that has already settled, cancel means release: the
      // frame is torn down." The answer is still `false`, because the run did
      // not settle here — a race, not an error.
      this.release({ runId: request.runId });
      return { cancelled: false };
    }
    this.#settle(record, { kind: 'cancelled', reason: request.reason });
    return { cancelled: true };
  }

  release(request: SandboxReleaseReq): Ack {
    const record = this.#runs.get(request.runId);
    if (record === undefined) return { ok: false };
    if (record.phase === 'awaitingApproval') {
      this.#settle(record, {
        kind: 'refused',
        reason: 'approvalAbandoned',
        mountIndex: null,
        protectedRoot: null,
      });
    } else if (record.phase === 'running') {
      this.#settle(record, { kind: 'cancelled', reason: 'surfaceClosed' });
    }
    this.#clearDeadline(record);
    this.#runs.delete(request.runId);
    return { ok: true };
  }

  /* ---------------------------------------------------------------- private */

  #refusalFor(request: SandboxSubmitReq, atCapacity: boolean): RefusalReason | null {
    if (this.#permission === 'off') return 'permissionIsOff';
    if (atCapacity) return 'tooManyConcurrentRuns';
    const shape = documentRefusal(request);
    if (shape !== null) return shape;
    if (!CANVAS_LANGUAGES.includes(request.program.language)) return 'languageUnsupported';
    const backend =
      request.minimumIsolation.family === 'document' ? BACKENDS.document : BACKENDS.process;
    if (!isolationMeets(backend.isolation, request.minimumIsolation)) return 'isolationUnavailable';
    return null;
  }

  /**
   * The request, narrowed. Nothing here may be wider than what was asked for.
   *
   * A document has no working directory, so that field is `null` rather than an
   * uninteresting path, and the scratch directory it never writes to resolves to
   * the empty guest path the contract's own `NO_FILESYSTEM` implies.
   */
  #grantFor(request: SandboxSubmitReq): EffectiveGrant {
    const backend =
      request.minimumIsolation.family === 'document' ? BACKENDS.document : BACKENDS.process;
    return {
      backend,
      filesystem: {
        mounts: request.filesystem.mounts,
        scratch: { guestPath: '', retainAfterSettled: false },
        outsideMounts: 'denied',
      },
      network: request.network,
      limits: request.limits,
      workingDirectory: null,
    };
  }

  #accept(record: RunRecord): void {
    record.phase = 'running';
    this.#emit(record, { type: 'accepted', grant: this.#grantFor(record.request) });
    this.#emit(record, { type: 'started', startupMs: 0 });
    const budget = record.request.limits.wallClockMs;
    record.deadline = setTimeout(() => {
      record.deadline = null;
      if (record.phase !== 'running') return;
      this.#settle(record, { kind: 'limitExceeded', limit: 'wallClockMs' });
    }, budget);
  }

  #settle(record: RunRecord, outcome: SandboxOutcome): void {
    this.#clearDeadline(record);
    record.phase = 'settled';
    this.#emit(record, { type: 'settled', outcome, usage: this.#usageFor(record) });
  }

  #usageFor(record: RunRecord): RunUsage {
    return {
      wallClockMs: this.#now() - record.startedAt,
      // `null` is not reported. A zero here would be a claim that this host
      // measured a cost and found none, and it has measured nothing.
      cpuMs: null,
      peakMemoryBytes: null,
      outputBytes: 0,
      droppedOutputBytes: record.droppedBytes,
    };
  }

  #clearDeadline(record: RunRecord): void {
    if (record.deadline !== null) {
      clearTimeout(record.deadline);
      record.deadline = null;
    }
  }

  #emit(record: RunRecord, event: SandboxEvent): void {
    const envelope: SandboxEventEnvelope = {
      runId: record.request.runId,
      seq: record.seq,
      event,
    };
    record.seq += 1;
    for (const listener of this.#listeners) listener(envelope);
  }
}
