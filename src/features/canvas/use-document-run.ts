/**
 * One artifact version, one sandbox run, for as long as it is on screen.
 *
 * ## Subscribe, then submit
 *
 * The contract states the rule for the chat stream and restates it for this one:
 * events for a run can arrive before the call that started it returns, so a
 * subscriber that waited would miss the first one. Here it is not a race that
 * *usually* loses — this host emits `awaitingApproval` and every refusal
 * synchronously inside `submit`, so a listener attached afterwards would miss
 * every one of them, every time. The order in the effect below is load-bearing.
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

import type { DocumentHost } from './document-host';
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
    };

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

export function useDocumentRun(
  host: DocumentHost,
  projectId: ProjectId,
  program: DocumentProgram | null,
): DocumentRun {
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

    const unsubscribe = host.subscribe((envelope) => {
      if (envelope.runId !== runId) return;
      const event = envelope.event;
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

    host.submit(documentSubmit(runId, projectId, program));

    return () => {
      unsubscribe();
      host.release({ runId });
      runIdRef.current = null;
    };
  }, [host, projectId, program]);

  const answer = useCallback(
    (decision: 'allowOnce' | 'deny') => {
      const runId = runIdRef.current;
      if (runId === null || phase.kind !== 'awaitingApproval') return;
      host.approve({ runId, requestDigest: phase.request.requestDigest, decision });
    },
    [host, phase],
  );

  const report = useCallback(
    (observation: DocumentObservation) => {
      const runId = runIdRef.current;
      if (runId === null) return;
      host.reportDocument({ runId, observation });
    },
    [host],
  );

  return useMemo(
    () => ({ phase, diagnostics, answer, report }),
    [phase, diagnostics, answer, report],
  );
}
