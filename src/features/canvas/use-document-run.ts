/**
 * One artifact version, one sandbox run, for as long as it is on screen.
 *
 * ## Where the decisions are taken, and why not here
 *
 * Every call below goes to {@link SandboxRepository}, which is
 * `PlatformAdapter.invoke` over the six `sandbox_*` commands. Nothing in this
 * file decides whether a run may start, what it is granted, or when it has taken
 * too long. That reads as an obvious thing to say and it is the whole point of
 * the file: Canvas previously ran a renderer-side host that answered all three,
 * which put `permissionIsOff` inside the process it is meant to constrain and
 * made `requestDigest` a token the renderer both issued and checked.
 *
 * The digest is the clearest case and it is one line: `answer` echoes back
 * `phase.request.requestDigest` exactly as it arrived. The contract calls it
 * host-computed and host-checked and forbids the renderer recomputing it, and
 * there is nothing here that could.
 *
 * ## Subscribe, then submit
 *
 * The contract states the rule for the chat stream and restates it for this one:
 * events for a run can arrive before the call that started it returns, so a
 * subscriber that waited would miss the first one — which is why the *caller*
 * mints `runId`. `watch` is therefore awaited to completion before `submit` is
 * issued, and the effect's teardown has to cope with unmounting in between.
 *
 * ## One run per version, and release is not optional
 *
 * Switching version, closing the panel, or unmounting releases the run. The
 * contract makes release required rather than polite because a retained scratch
 * directory is a directory nothing else will ever delete; a Canvas document
 * retains nothing, but the *other* half of release applies exactly: a document
 * run stays live after it settles, so a panel that walked away from ten
 * artifacts would be holding ten frames. Releasing an unsettled run is legal and
 * is what gives `approvalAbandoned` a trigger — a user who opens an approval
 * card and then closes the panel produces one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { SandboxRepository } from '@/data/sandbox-repository';
import type { Unsubscribe } from '@/platform/adapter';
import type { ProjectId } from '@/platform/contract-project';
import type {
  ApprovalRequest,
  DocumentObservation,
  DocumentProgram,
  EffectiveGrant,
  RunUsage,
  SandboxDiagnostic,
  SandboxOutcome,
  SandboxRunId,
} from '@/platform/contract-sandbox';

import { documentSubmit } from './document-run';

/**
 * Where the run is, as a surface needs to know it.
 *
 * A discriminated union rather than flags, so "approved but not settled" and
 * "settled but never approved" cannot both be true — and so the one rule the
 * Canvas surface must obey, *draw no frame before `accepted`*, is enforced by
 * there being no frame-shaped state to draw from until then.
 */
export type RunPhase =
  | { readonly kind: 'submitting' }
  | { readonly kind: 'awaitingApproval'; readonly request: ApprovalRequest }
  | { readonly kind: 'accepted'; readonly grant: EffectiveGrant }
  | {
      readonly kind: 'settled';
      readonly outcome: SandboxOutcome;
      readonly usage: RunUsage;
      /** The grant it ran under, kept so a rendered document can stay drawn. */
      readonly grant: EffectiveGrant | null;
    }
  /**
   * The submit was rejected rather than settled, so there is no run and there
   * will be no `settled` event for one.
   *
   * The contract keeps a short list of failures that reject the *call*: a run id
   * already in flight, a program past the size the host carries, a mount or
   * guest path that does not resolve. A Canvas submit mints a UUID, carries no
   * mounts and asks for nothing exotic, so none of them is reachable from this
   * surface today — but an unhandled rejection is not an acceptable way to find
   * out, and inventing a `hostFailed` outcome for it would be this renderer
   * claiming a host said something it did not.
   */
  | { readonly kind: 'notSubmitted' };

export interface DocumentRun {
  readonly phase: RunPhase;
  /** Program-supplied text. Render it as quoted, attributed foreign text. */
  readonly diagnostics: readonly SandboxDiagnostic[];
  readonly answer: (decision: 'allowOnce' | 'deny') => void;
  readonly report: (observation: DocumentObservation) => void;
}

/**
 * A run id.
 *
 * Deliberately not `newTurnId` from `src/data/chat-repository.ts`, and the
 * contract says why: one agent run submits many sandbox runs, and a type — or a
 * minting function — that made them interchangeable invites reusing an id and
 * discovering the collision on the second call.
 */
let runCounter = 0;
function newRunId(): SandboxRunId {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (typeof cryptoApi?.randomUUID === 'function') return `run-${cryptoApi.randomUUID()}`;
  runCounter += 1;
  return `run-${String(runCounter)}-${String(Date.now())}`;
}

const NO_DIAGNOSTICS: readonly SandboxDiagnostic[] = [];

/** `scripts` exists only on the executable arm; `svg` and `mermaid` have none. */
function scriptsOf(program: DocumentProgram): string | null {
  return 'scripts' in program ? program.scripts : null;
}

/**
 * One object identity per distinct program, so the run below is keyed on what a
 * program *is* rather than on which object happens to carry it.
 *
 * This is not a micro-optimisation, and the reason is the boundary this file
 * exists to move. `collectArtifacts` rebuilds every track — and every
 * `DocumentProgram` inside it — whenever the assistant-message array changes
 * identity, which is once per drained batch of stream deltas for *any* turn in
 * the conversation, including turns that contain no artifact at all. The
 * artifact on screen has not changed; only its wrapper is new.
 *
 * While Canvas ran its own renderer-side host that churn cost a few objects. Now
 * every cycle puts a real `sandbox_release` and `sandbox_submit` across `invoke`
 * and tears down and re-establishes the `sandbox:event` subscription in between
 * — `watch` is an `adapter.listen`, not a command, which is why only two of the
 * three show up in a count of invokes. Measured on the fake with one word per
 * macrotask: a 39-word answer streaming beside an open panel drove **12 to 17
 * submits**, with a release behind each but the last, where one submit was
 * warranted.
 *
 * Read that as a magnitude and not a fixture. The count is however many batches
 * the stream happened to drain in, so it tracks machine speed and load rather
 * than anything about the defect — ten samples spread across that whole span,
 * two clusters of them on one machine hours apart, none below twelve. What does
 * not move is the guard in `src/app/canvas-wiring.test.tsx`: it asserts
 * `toHaveLength(1)` and reddens at two, so the spread costs it nothing.
 *
 * It never reached `tooManyConcurrentRuns` — release is issued in the teardown
 * that precedes the next submit, so the table held one run and the host refuses
 * at five — but a surface that resubmits a dozen times over to draw one artifact
 * is telling the host something untrue about what the user did.
 */
function useStableProgram(next: DocumentProgram | null): DocumentProgram | null {
  const held = useRef<DocumentProgram | null>(null);
  const current = held.current;
  if (next === null) {
    held.current = null;
  } else if (
    current === null ||
    current.language !== next.language ||
    current.source !== next.source ||
    scriptsOf(current) !== scriptsOf(next)
  ) {
    held.current = next;
  }
  return held.current;
}

export function useDocumentRun(
  sandbox: SandboxRepository,
  projectId: ProjectId,
  incoming: DocumentProgram | null,
): DocumentRun {
  // Keyed by value: an equal program that arrived in a new object must not
  // start a second run. See {@link useStableProgram}.
  const program = useStableProgram(incoming);
  const [phase, setPhase] = useState<RunPhase>({ kind: 'submitting' });
  const [diagnostics, setDiagnostics] = useState<readonly SandboxDiagnostic[]>(NO_DIAGNOSTICS);
  const runIdRef = useRef<SandboxRunId | null>(null);
  const grantRef = useRef<EffectiveGrant | null>(null);

  useEffect(() => {
    if (program === null) return;

    const runId = newRunId();
    runIdRef.current = runId;
    grantRef.current = null;
    setPhase({ kind: 'submitting' });
    setDiagnostics(NO_DIAGNOSTICS);

    // Torn down between the `watch` and the `submit`, or between the `submit`
    // and its answer, is an ordinary outcome here rather than an edge case: a
    // user who closes the panel while an artifact is still being submitted does
    // exactly that. The flag is read on both sides of every await.
    let live = true;
    let unsubscribe: Unsubscribe | null = null;

    void (async () => {
      const stop = await sandbox.watch(runId, ({ event }) => {
        switch (event.type) {
          case 'awaitingApproval':
            setPhase({ kind: 'awaitingApproval', request: event.request });
            break;
          case 'accepted':
            grantRef.current = event.grant;
            setPhase({ kind: 'accepted', grant: event.grant });
            break;
          case 'settled':
            setPhase({
              kind: 'settled',
              outcome: event.outcome,
              usage: event.usage,
              grant: grantRef.current,
            });
            break;
          case 'diagnostic':
            setDiagnostics((current) => [...current, event]);
            break;
          // `started` is a timing fact the panel has nothing to say about, and a
          // document run never emits `output` — that arm belongs to a process.
          case 'started':
          case 'output':
          case 'truncated':
            break;
        }
      });
      if (!live) {
        stop();
        return;
      }
      unsubscribe = stop;

      try {
        await sandbox.submit(documentSubmit(runId, projectId, program));
      } catch {
        // The reason is a `PlatformError` about this call, not an outcome for a
        // run — there is no run. The surface says so in its own words rather
        // than rendering a host's; see `DocumentPreview.tsx`.
        if (live) setPhase({ kind: 'notSubmitted' });
      }
    })();

    return () => {
      live = false;
      unsubscribe?.();
      // A run that was never admitted has nothing to release and the host
      // answers `{ ok: false }`, which is not an error and is not read.
      void sandbox.release(runId).catch(() => undefined);
      runIdRef.current = null;
    };
  }, [sandbox, projectId, program]);

  const answer = useCallback(
    (decision: 'allowOnce' | 'deny') => {
      const runId = runIdRef.current;
      if (runId === null || phase.kind !== 'awaitingApproval') return;
      // The digest is opaque: it goes back exactly as it arrived. Recomputing it
      // is the one thing the contract names as forbidden on this side.
      //
      // A rejection here means the host was handed a digest it never issued,
      // which the contract calls a bug rather than a decision — and it would be
      // a bug in Vela, because there is no expression above that could produce a
      // different one. It leaves the approval card up and answers nothing, which
      // is the truthful outcome: the run is still awaiting an answer the host
      // will accept. **This surface has no channel for reporting a Vela defect to
      // the user, and that is a gap rather than a design.**
      void sandbox.approve(runId, phase.request.requestDigest, decision).catch(() => undefined);
    },
    [sandbox, phase],
  );

  const report = useCallback(
    (observation: DocumentObservation) => {
      const runId = runIdRef.current;
      if (runId === null) return;
      // An observation is a statement, not a question. This build's host
      // discards every one of them — `report_document` in the `vela-sandbox`
      // crate is an empty body — so there is nothing in the `Ack` to read and
      // nothing a rejection would change about what is on screen.
      void sandbox.reportDocument(runId, observation).catch(() => undefined);
    },
    [sandbox],
  );

  return useMemo(
    () => ({ phase, diagnostics, answer, report }),
    [phase, diagnostics, answer, report],
  );
}
