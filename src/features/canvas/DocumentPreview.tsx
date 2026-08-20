/**
 * The preview half of the panel: an approval card, then a frame, then whatever
 * the frame had to say.
 *
 * ## The rule this component exists to obey
 *
 * **No `accepted` event, no frame** — and, the half that was missing, *no frame
 * for a program other than the accepted one*. The contract names the first as
 * the signal a Canvas surface waits for, and says in the same breath that a
 * surface which drew a frame without an accepted grant would be a defect in Vela
 * rather than an attack on it. The second half is what makes the first mean
 * anything: a check on the phase paired with bytes taken from somewhere else
 * answers "has *some* run been accepted", which is one notch narrower than the
 * question, and the gap is a whole model-authored revision wide. So the
 * `<iframe>` below is behind {@link drawable}, which hands back the grant and the
 * program the host granted *for*, together or not at all — not a boolean the
 * component also sets elsewhere, not an optimistic draw with a later teardown,
 * and no longer a program prop travelling beside the run. `CanvasPanel.test.tsx`
 * holds both halves.
 *
 * ## Who observes what
 *
 * The host owns the run and cannot see the frame; this component can, and reports
 * what it saw through `sandbox_report_document` — the real command, over the real
 * seam, since Canvas was wired to `src/data/sandbox-repository.ts`. **This
 * build's host discards every report**: `report_document` in the `vela-sandbox`
 * crate is an empty body, because a host that accepts no document run has no run
 * for a report to belong to. So the observations below are produced correctly and
 * land nowhere, and nothing on this surface may be read as evidence that a
 * document outcome was recorded. That is the fork the contract draws
 * deliberately, and it is why three of the four observation kinds are produced
 * here:
 *
 *  - `rendered` — the frame's own `load`, timed from the moment it was mounted.
 *  - `failed` — only for SVG, only from a parse performed *outside* the frame.
 *    See `svgFailsToParse`; a frame with an opaque origin cannot be read, so a
 *    document that died inside it is invisible and this build does not pretend
 *    to see it. `frameCrashed` has no producer here and is not faked.
 *  - `diagnostic` and `truncated` — from the bridge script, which exists only
 *    when script is allowed. With script denied there is nothing running in the
 *    frame to have an opinion, and the absence of diagnostics is the truth.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';

import type {
  DocumentProgram,
  DocumentScripts,
  EffectiveGrant,
  RefusalReason,
  SandboxProgram,
} from '@/platform/contract-sandbox';

import { CANVAS_FRAME_MESSAGE, frameFor, svgFailsToParse } from './document-frame';
import type { DocumentRun } from './use-document-run';
import styles from './DocumentPreview.module.css';

interface DocumentPreviewProps {
  readonly run: DocumentRun;
  /** Vela's own words for the artifact, for the frame's accessible name. */
  readonly title: string;
}

/**
 * The run a frame may be drawn for, or `null` if none may.
 *
 * **One value, carrying both halves.** This used to answer only "is there an
 * accepted grant", and the bytes that went into the frame came from a `program`
 * prop the panel supplied separately. Nothing tied the two to the same run, so
 * the rule this component exists to obey — *no accepted event, no frame* — held
 * only in the case where the panel happened not to have moved on. It moves on
 * whenever the model revises the artifact: the panel follows the newest version,
 * the prop becomes the new source, and `run.phase` is still the previous run's
 * `accepted` until an effect gets a chance to run. Measured on the double, with
 * script already allowed for the previous version: the DOM received one
 * `<iframe sandbox="allow-scripts">` whose `srcdoc` held the *new* version's
 * bytes, for a run that had not been submitted, let alone approved.
 *
 * Now the grant and the program come out of the same phase, minted by
 * `use-document-run.ts` for one run, and there is no second source to disagree
 * with. A frame cannot be built from a program the host said nothing about,
 * because there is nowhere left to get one.
 */
function drawable(run: DocumentRun): { grant: EffectiveGrant; program: DocumentProgram } | null {
  const phase = run.phase;
  if (phase.kind === 'accepted') return { grant: phase.grant, program: phase.program };
  if (phase.kind === 'settled' && phase.outcome.kind === 'rendered') {
    return phase.grant === null || phase.program === null
      ? null
      : { grant: phase.grant, program: phase.program };
  }
  return null;
}

export function DocumentPreview({ run, title }: DocumentPreviewProps) {
  const drawn = drawable(run);
  const grant = drawn?.grant ?? null;
  const program = drawn?.program ?? null;
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const mountedAt = useRef<number>(0);
  const spentBytes = useRef<number>(0);
  const source = useMemo(() => (program === null ? null : frameFor(program)), [program]);
  const { report } = run;

  // The SVG parse check runs the moment the run is accepted and before the
  // frame has had a chance to load, so a rejected document settles `failed`
  // rather than settling `rendered` on a browser error page.
  useEffect(() => {
    if (program === null) return;
    if (program.language !== 'svg') return;
    if (!svgFailsToParse(program.source)) return;
    report({ kind: 'failed', reason: 'sourceRejectedByParser' });
  }, [program, report]);

  useEffect(() => {
    if (grant === null) return;
    mountedAt.current = Date.now();
    spentBytes.current = 0;
  }, [grant]);

  const budget = grant?.limits.outputBytes ?? 0;

  useEffect(() => {
    if (grant === null) return;
    const handler = (event: MessageEvent<unknown>): void => {
      // The real check. A null-origin frame's `origin` is the string "null" and
      // says nothing about which frame sent it, so identity is the window
      // itself — the one this component mounted, and no other.
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data;
      if (typeof data !== 'object' || data === null) return;
      const message = data as { tag?: unknown; severity?: unknown; text?: unknown };
      if (message.tag !== CANVAS_FRAME_MESSAGE) return;
      if (typeof message.text !== 'string') return;
      const severity =
        message.severity === 'error' || message.severity === 'warning' ? message.severity : 'info';

      const bytes = new TextEncoder().encode(message.text).length;
      if (spentBytes.current >= budget) {
        report({ kind: 'truncated', droppedBytes: bytes });
        return;
      }
      spentBytes.current += bytes;
      report({ kind: 'diagnostic', severity, text: message.text });
    };
    window.addEventListener('message', handler);
    return () => {
      window.removeEventListener('message', handler);
    };
  }, [grant, budget, report]);

  const onLoad = useCallback(() => {
    report({ kind: 'rendered', renderMs: Math.max(0, Date.now() - mountedAt.current) });
  }, [report]);

  // One decision, in one place. An earlier draft asked the phase twice — once
  // here to show the approval card, and once through {@link drawable} to
  // decide about the frame — and a mutation probe found the consequence: with
  // that function broken to hand back the approval's own grant, the frame still
  // did not draw, because the *other* branch caught it first. A rule with two
  // guards is a rule whose test passes when one of them is wrong.
  //
  // `source === null` is not a second guard on the same fact. It is the same
  // fact: {@link drawable} returns the grant and the program together or returns
  // neither, so the two are `null` in exactly the same cases and the compiler is
  // what narrows `source` for the `srcDoc` below.
  if (grant === null || source === null) {
    return run.phase.kind === 'awaitingApproval' ? (
      <ApprovalCard run={run} title={title} />
    ) : (
      <PreviewNotice run={run} />
    );
  }

  return (
    <div className={styles.stage}>
      <iframe
        ref={frameRef}
        className={styles.frame}
        title={title}
        // The whole boundary. `sandbox` never carries `allow-same-origin`; see
        // `document-frame.ts`, which builds both of these and is where the
        // reasoning lives.
        sandbox={source.sandbox}
        srcDoc={source.html}
        onLoad={onLoad}
        data-testid="canvas-frame"
      />
      <Diagnostics run={run} />
    </div>
  );
}

/**
 * What a person is agreeing to.
 *
 * The contract's unit of approval is one submitted run, approved whole, before
 * it starts — and it is emphatic that a prompt which hides what the run was
 * granted manufactures consent rather than collecting it. So the grant is on the
 * card: the confinement, the network policy, and whether script will execute.
 * The program's own source is not repeated here because the Code tab beside this
 * one shows it in full and never elides it.
 */
function ApprovalCard({ run, title }: { readonly run: DocumentRun; readonly title: string }) {
  if (run.phase.kind !== 'awaitingApproval') return null;
  const request = run.phase.request;
  const grant = request.grant;
  // **Every row comes off the request the digest is over.** `Isolation` and
  // `Network` already did; `Script` came off a copy of the program the panel
  // held beside the run, which is the same two-sources defect `drawable` above
  // was rewritten to close. The contract calls `ApprovalRequest.program` "the
  // exact program text that will run", so it is what a person is being asked
  // about, and a card sourcing one row from somewhere else is describing a run
  // other than the one `allowOnce` would approve.
  const scripts = scriptDecision(request.program);

  return (
    <div className={styles.card} role="group" aria-label="Approve this artifact">
      <h3 className={styles.cardTitle}>Run {title}?</h3>
      <dl className={styles.grant}>
        <dt>Isolation</dt>
        <dd>{isolationSentence(grant)}</dd>
        <dt>Network</dt>
        <dd>{grant.network.kind === 'denied' ? 'No network access' : 'Network access'}</dd>
        {scripts === null ? null : (
          <>
            <dt>Script</dt>
            <dd>{scripts === 'denied' ? 'Will not execute' : 'Executes in the isolated frame'}</dd>
          </>
        )}
        <dt>Files</dt>
        <dd>No filesystem access</dd>
      </dl>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={() => run.answer('allowOnce')}>
          Render once
        </button>
        <button type="button" className={styles.secondary} onClick={() => run.answer('deny')}>
          Don&rsquo;t render
        </button>
      </div>
    </div>
  );
}

/**
 * What the request says about script, or `null` if it says nothing.
 *
 * Total over {@link SandboxProgram} rather than over the document arm, because
 * the value being read is the host's echo and this surface does not get to
 * assume what shape came back. `svg` and `mermaid` answer `denied` — the union
 * gives them no `scripts` field precisely because there is nothing to decide,
 * and `document-frame.ts` draws both with an empty `sandbox`, so the row is a
 * fact rather than a guess. A `process` program answers `null` and the row is
 * omitted: a run with no frame has no script decision, and inventing a
 * reassuring "Will not execute" for it would be this card describing something
 * it has not been told.
 */
function scriptDecision(program: SandboxProgram): DocumentScripts | null {
  if (program.kind !== 'document') return null;
  return program.language === 'html' || program.language === 'react'
    ? program.scripts
    : 'denied';
}

/**
 * The renderer writes every sentence a user reads.
 *
 * A closed union in, Vela's prose out — the rule the whole error taxonomy in
 * `src/platform/contract.ts` follows, and it matters most here, because the thing
 * being described was written by a model.
 */
function isolationSentence(grant: EffectiveGrant): string {
  const isolation = grant.backend.isolation;
  if (isolation.family === 'process') return 'Runs as an ordinary process';
  switch (isolation.level) {
    case 'sameOrigin':
      return 'Drawn inside Vela — not isolated';
    case 'opaqueOriginFrame':
      return 'Drawn in an isolated frame with no access to Vela';
    case 'ownRendererProcess':
      return 'Drawn in an isolated frame in its own process';
  }
}

function PreviewNotice({ run }: { readonly run: DocumentRun }) {
  if (run.phase.kind === 'notSubmitted') {
    return (
      <p className={styles.notice} data-testid="canvas-notice">
        Vela could not send this artifact to be run. The source is in the Code tab.
      </p>
    );
  }
  if (run.phase.kind !== 'settled') {
    return <p className={styles.notice}>Preparing…</p>;
  }
  return (
    <p className={styles.notice} data-testid="canvas-notice">
      {outcomeSentence(run)}
    </p>
  );
}

function outcomeSentence(run: DocumentRun): string {
  if (run.phase.kind !== 'settled') return 'Preparing…';
  const outcome = run.phase.outcome;
  switch (outcome.kind) {
    case 'refused':
      return refusalSentence(outcome.reason);
    case 'documentFailed':
      return outcome.reason === 'frameCrashed'
        ? 'The preview stopped unexpectedly.'
        : 'This could not be drawn — the source did not parse.';
    case 'limitExceeded':
      return 'The preview did not finish in time.';
    case 'cancelled':
      return 'The preview was stopped.';
    case 'hostFailed':
      return 'The preview could not be started.';
    // A document run cannot exit or crash as a process, and `rendered` is drawn
    // rather than described. Listed so this switch stays exhaustive over the
    // outcome union rather than over the ones a document happens to reach.
    case 'exited':
    case 'crashed':
    case 'rendered':
      return '';
  }
}

/**
 * A host refusal, in Vela's words.
 *
 * The two arms that are not about the user's own decision are the ones a real
 * host reaches today, and they are worded here rather than left to the default
 * for a reason the boundary move makes concrete: with the decision host-held,
 * **every** Canvas run ends in one of them. `vela-sandbox` reports the document
 * backend at `sameOrigin` and carries no document language, so a submit asking
 * for `opaqueOriginFrame` is refused `isolationUnavailable`, and a submit that
 * somehow met that floor would be refused `languageUnsupported` immediately
 * after. A generic "this artifact was refused" would be the whole of what a user
 * ever sees from this feature.
 *
 * The default arm stays for the reasons no producer in this tree emits — the
 * mount and path refusals a document submit carries nothing to trigger. Wording
 * those would be inventing sentences about states that cannot occur.
 */
function refusalSentence(reason: RefusalReason): string {
  switch (reason) {
    case 'permissionIsOff':
      return 'Running artifacts is switched off. The source is in the Code tab.';
    case 'approvalDenied':
      return 'Not rendered.';
    case 'approvalAbandoned':
      return 'Not rendered.';
    case 'languageUnsupported':
      return 'This build cannot draw this kind of artifact. The source is in the Code tab.';
    case 'isolationUnavailable':
      return 'This build has no isolated frame to draw artifacts in, so nothing was run. The source is in the Code tab.';
    case 'tooManyConcurrentRuns':
      return 'Too many artifacts are open at once. Close one and try again.';
    default:
      return 'This artifact was refused.';
  }
}

function Diagnostics({ run }: { readonly run: DocumentRun }) {
  if (run.diagnostics.length === 0) return null;
  return (
    <div className={styles.diagnostics} data-testid="canvas-diagnostics">
      <p className={styles.diagnosticsLead}>Reported by the artifact:</p>
      <ul>
        {run.diagnostics.map((diagnostic, index) => (
          // Quoted and attributed. Program-supplied text is never parsed for
          // meaning and never set in Vela's own voice.
          <li key={index} data-severity={diagnostic.severity}>
            <q>{diagnostic.text}</q>
          </li>
        ))}
      </ul>
    </div>
  );
}
