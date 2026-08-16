/**
 * A **fake sandbox host** for the document family. Test double. Not shipped.
 *
 * ## Read this before believing anything else in this file
 *
 * This file used to open with a four-clause claim about the six `sandbox_*`
 * commands: that they were unwired, that they appeared on neither allowlist,
 * that nothing under `src-tauri/` implemented them, and that `isAllowedCommand`
 * in `src/platform/contract.ts` rejected every one of them. That claim was the
 * stated reason a second implementation of a security boundary lived in the
 * renderer, and **every clause of it was false**. The false sentence is not
 * reproduced here, so that a reader grepping this directory for it finds only
 * code that is true. What is true, re-derived at each named line:
 *
 *  - All six are in `COMMAND_ALLOWLIST` in `src/platform/contract.ts` (declared
 *    at 1634, the sandbox rows at 1658-1663), and `isAllowedCommand` is a
 *    membership test on that array, so it answers `true` for each. (There is no
 *    export named `ALLOWED_COMMANDS` in this repo. The plan item that sent this
 *    repair called it that; the array is `COMMAND_ALLOWLIST` on both sides.)
 *  - All six are in the Rust `COMMAND_ALLOWLIST` in `src-tauri/src/ipc/mod.rs`
 *    (123-128). The module's own test reads the TypeScript file and fails if the
 *    two have drifted, so `cargo test` is what pins them together.
 *  - All six are registered handlers in `src-tauri/src/lib.rs` (211-216), defined
 *    in `src-tauri/src/ipc/sandbox.rs` over the `vela-sandbox` crate.
 *  - `src/data/sandbox-repository.ts` is the renderer's door to all six, and
 *    `src/app/App.tsx` hands it to `CanvasSurface`. **That is the shipping path.
 *    This file is not on it.**
 *
 * What is genuinely unbuilt is the list `src/platform/contract-sandbox.ts` keeps
 * at 73-77, and nothing wider: every document command path, `python`, both
 * copying materialisations, and any surface that renders an approval prompt.
 * Concretely for this feature — the host's `languages` carries no document
 * language and `absent_document_backend` reports the document family at
 * `sameOrigin`, one rank below the `opaqueOriginFrame` every Canvas submit
 * demands, so `admit` refuses every one of them; and `report_document` in
 * `src-tauri/crates/vela-sandbox/src/host.rs` (line 381) is an empty body, so a
 * frame's observations are discarded. **Canvas therefore draws nothing against a
 * real host today, and shows the host's refusal instead.**
 *
 * ## What this double is for, and what it can never be evidence of
 *
 * A surface still has to be driven through `awaitingApproval → accepted →
 * settled` by something, or the only states `CanvasPanel.test.tsx` could reach
 * would be refusals. This is that something: an in-process implementation of the
 * contract's document lifetime, wrapped as a {@link SandboxRepository} by
 * {@link documentHostDouble} so the surface under test talks to the *same*
 * interface it talks to in production and only the far side is fake.
 *
 * **VERIFIED-BY-FAKE, and the fake is deliberately more capable than any real
 * host.** It accepts document runs; no host in this tree does. So:
 *
 *  - **`permissionIsOff` here is not a boundary.** The contract's whole claim for
 *    it is that it is host-held, so no request can raise it. Held in the renderer
 *    it is held by the same process it is meant to constrain. It is implemented
 *    because the *surface* must behave correctly when it is set — Canvas shows
 *    source and offers no execute affordance — not because this placement makes
 *    it enforcement. In the shipped app the level comes from `sandbox_policy`.
 *  - **`requestDigest` here is an identity token, not a security check.** The
 *    contract calls it host-computed and host-checked and forbids the renderer
 *    recomputing it. Inside this double there is no other side to compute it, so
 *    it does the one thing it can still do honestly: bind an approval to the
 *    exact bytes and grant that were shown, so a second submit under the same run
 *    id cannot inherit the first one's answer. The renderer never recomputes it —
 *    `use-document-run.ts` echoes back whatever arrived.
 *  - **`wallClockMs` here is `supervisor` and says so.** A timer in this process
 *    notices a frame that never rendered. It is real and it is racy.
 *
 * The one guarantee that is *not* faked is the browser boundary, and it is not
 * faked because it does not live here: the frame is drawn by `document-frame.ts`
 * with an opaque origin, and no `accepted` event means no frame — which the
 * contract names as the rule a Canvas surface must follow, and
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
  type AutoApprovalProfile,
  type EffectiveGrant,
  type Isolation,
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
import type { SandboxRepository } from '@/data/sandbox-repository';

import { documentRefusal } from './document-run';

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
   * The user's setting, as this double pretends to hold it.
   *
   * `sandbox_policy` is not missing and never was: it is on both allowlists,
   * registered in `src-tauri/src/lib.rs` (line 213), implemented in
   * `src-tauri/src/ipc/sandbox.rs`, faked by `BrowserAdapter`, and exposed as
   * the `policy` method of `createSandboxRepository`. In the shipped app it comes
   * from there. This option exists so a *test* can drive the surface at a level
   * other than the default, which is the only reason a renderer object should
   * ever have one.
   */
  readonly permission?: PermissionLevel;
  /** Injectable clock so a test can assert a usage number rather than a range. */
  readonly now?: () => number;
}

/**
 * Would this submit run without asking a person, under this profile?
 *
 * This is a **fake host's** copy of a host decision. The real one is
 * `within_profile` in `src-tauri/crates/vela-sandbox/src/admission.rs`, and it
 * lives there because approval is a thing the renderer must not decide. It moved
 * here from `document-run.ts` when Canvas was wired to the real host, because at
 * that point its only caller was this double and a decision procedure with no
 * shipping caller is the defect this repo keeps finding.
 *
 * **The comparison is over the request and never over the backend**, which the
 * contract calls out as the distinction that is not academic: reading it against
 * the backend would auto-approve a run whose caller never demanded containment,
 * on the strength of a guarantee it did not request and cannot rely on. So the
 * only isolation value read here is `request.minimumIsolation`.
 *
 * **With `DEFAULT_AUTO_APPROVAL_PROFILE` this returns `false` for every submit
 * Canvas can make, so the branch that calls it in {@link LocalDocumentHost.submit}
 * is dead under the shipped profile.** That profile's document floor is
 * `ownRendererProcess`; {@link CANVAS_ISOLATION_FLOOR} is `opaqueOriginFrame`,
 * one rank below; `isolationMeets` therefore returns `false` and no later clause
 * is reached. A user who selects permission `approve` is prompted exactly as if
 * they had selected `ask`. That is the contract's intended behaviour and not a
 * placeholder — the floor moves down only when a mechanism moves up — but it is
 * a dead branch today and is written down as one rather than left to be
 * discovered. It is kept, rather than deleted, because it is the structure the
 * real host has and a fake that dropped it would stop mirroring it.
 */
export function autoApproves(profile: AutoApprovalProfile, request: SandboxSubmitReq): boolean {
  const floor: Isolation =
    request.minimumIsolation.family === 'document'
      ? { family: 'document', level: profile.minimumIsolation.document }
      : { family: 'process', level: profile.minimumIsolation.process };
  if (!isolationMeets(request.minimumIsolation, floor)) return false;
  if (request.network.kind !== 'denied') return false;
  if (!profile.languages.includes(request.program.language)) return false;

  // "The two lists are checked independently and neither implies the other."
  // Read strictly, that makes a `readWrite` mount need both entries — it is
  // read access as well as write access, and `writableRoots` is explicitly not
  // a way to grant reading. A Canvas submit carries no mounts at all, so this
  // loop never runs for the surface in this feature; it is here because a
  // half-implemented rule is the thing the next caller inherits.
  for (const mount of request.filesystem.mounts) {
    if (!profile.readableRoots.includes(mount.hostPath)) return false;
    if (mount.mode === 'readWrite' && !profile.writableRoots.includes(mount.hostPath)) return false;
  }

  const limits = request.limits;
  const ceilings = profile.maximumLimits;
  return (
    limits.wallClockMs <= ceilings.wallClockMs &&
    limits.memoryBytes <= ceilings.memoryBytes &&
    limits.cpuMillicores <= ceilings.cpuMillicores &&
    limits.outputBytes <= ceilings.outputBytes &&
    limits.processes <= ceilings.processes &&
    limits.fileWriteBytes <= ceilings.fileWriteBytes
  );
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

export class LocalDocumentHost {
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

/**
 * The double, wearing the interface the shipping surface actually talks to.
 *
 * `SandboxRepository` is a promise-returning door over `PlatformAdapter.invoke`.
 * Wrapping the synchronous host in it means a component test drives *the same*
 * `use-document-run.ts`, `CanvasPanel.tsx` and `DocumentPreview.tsx` code paths
 * as the shipped app, with only the far side of the seam replaced — rather than
 * a second seam that exists to be tested.
 *
 * `watch` filters by run id here, exactly as `createSandboxRepository` does, so
 * a surface driving two runs cannot cross their streams under the double either.
 * The subscription is registered synchronously *before* the returned promise
 * resolves: the real repository does the same, and it is what makes "subscribe
 * before you submit" hold for a caller that awaits both in order.
 */
export function documentHostDouble(
  options: LocalDocumentHostOptions = {},
): SandboxRepository & { readonly host: LocalDocumentHost } {
  const host = new LocalDocumentHost(options);
  return {
    host,
    // `async` rather than `Promise.resolve(...)`: `submit` and `approve` throw a
    // `PlatformError` for the two failures the contract rejects the *call* for,
    // and across a real IPC seam those arrive as a rejected promise. A double
    // that threw synchronously would let a caller get away with handling them in
    // a way the shipped adapter never permits.
    policy: async () => host.policy(),
    watch: async (runId, handler) =>
      host.subscribe((envelope) => {
        if (envelope.runId !== runId) return;
        handler({ seq: envelope.seq, event: envelope.event });
      }),
    submit: async (request) => host.submit(request),
    approve: async (runId, requestDigest, decision) =>
      host.approve({ runId, requestDigest, decision }),
    cancel: async (runId, reason) => host.cancel({ runId, reason }),
    release: async (runId) => host.release({ runId }),
    reportDocument: async (runId, observation) => host.reportDocument({ runId, observation }),
  };
}
