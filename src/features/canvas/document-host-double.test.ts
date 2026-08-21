/**
 * The document run's lifetime, against the contract's ordering block.
 *
 * `src/platform/contract-sandbox.ts` states the ordering, the "exactly one
 * `settled`, always" rule, the document-only exception that lets `diagnostic`
 * and `truncated` keep arriving after settlement, and the single failure that
 * rejects the call instead of arriving as an event. Nothing in this repo watched
 * any of it. This does.
 *
 * **VERIFIED-BY-FAKE, and more so than usual.** The host under test runs in the
 * renderer — not because the six `sandbox_*` commands are unwired (they are on
 * both allowlists, registered in `src-tauri/src/lib.rs`, and implemented in
 * `src-tauri/src/ipc/sandbox.rs`; the shipping surface goes through
 * `src/data/sandbox-repository.ts`) but because **no host in this tree accepts a
 * document run**, so a real one could never be driven past a refusal into the
 * sequence these tests are about. What is genuinely unbuilt is the list
 * `src/platform/contract-sandbox.ts` keeps under "Still unbuilt" in its opening
 * note: every document command path, `python`, both copying materialisations,
 * and any surface rendering an approval prompt. (A line range stood here until
 * it was measured and found off at both ends; `document-host-double.ts` says
 * what happened to the other six.)
 *
 * So these assertions are evidence about lifetime and sequencing and about
 * nothing else — not about a boundary, not about a policy a request cannot
 * raise. The honesty note at the top of `document-host-double.ts` says which
 * claims survive that placement and which do not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_PROJECT_ID } from '@/platform/contract-project';
import {
  DEFAULT_AUTO_APPROVAL_PROFILE,
  DEFAULT_DOCUMENT_LIMITS,
  type AutoApprovalProfile,
  type DocumentProgram,
  type SandboxEvent,
  type SandboxEventEnvelope,
  type SandboxSubmitReq,
} from '@/platform/contract-sandbox';
import { PlatformError } from '@/platform/errors';

import { LocalDocumentHost, autoApproves } from './document-host-double';
import { documentSubmit } from './document-run';

const SVG: DocumentProgram = {
  kind: 'document',
  language: 'svg',
  source: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>',
};

const MERMAID: DocumentProgram = {
  kind: 'document',
  language: 'mermaid',
  source: 'graph TD; A-->B;',
};

const BASH: DocumentProgram | never = SVG;

interface Recorder {
  readonly events: readonly SandboxEventEnvelope[];
  readonly types: readonly SandboxEvent['type'][];
}

function record(host: LocalDocumentHost): Recorder {
  const events: SandboxEventEnvelope[] = [];
  host.subscribe((envelope) => events.push(envelope));
  return {
    get events() {
      return events;
    },
    get types() {
      return events.map((envelope) => envelope.event.type);
    },
  };
}

function settledEvent(recorder: Recorder): Extract<SandboxEvent, { type: 'settled' }> | null {
  for (const envelope of recorder.events) {
    if (envelope.event.type === 'settled') return envelope.event;
  }
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a run at the default permission level', () => {
  it('asks a person before anything is drawn', () => {
    const host = new LocalDocumentHost();
    const recorder = record(host);
    const response = host.submit(documentSubmit('r1', DEFAULT_PROJECT_ID, SVG));

    expect(response).toEqual({ runId: 'r1', admitted: true });
    expect(recorder.types).toEqual(['awaitingApproval']);
  });

  it('carries the whole grant on the prompt, not a summary of it', () => {
    const host = new LocalDocumentHost();
    const recorder = record(host);
    host.submit(documentSubmit('r1', DEFAULT_PROJECT_ID, SVG));

    const first = recorder.events[0]?.event;
    if (first?.type !== 'awaitingApproval') throw new Error('expected an approval request');
    expect(first.request.program).toEqual(SVG);
    expect(first.request.grant.network).toEqual({ kind: 'denied' });
    expect(first.request.grant.limits).toEqual(DEFAULT_DOCUMENT_LIMITS);
    expect(first.request.grant.backend.isolation).toEqual({
      family: 'document',
      level: 'opaqueOriginFrame',
    });
    expect(first.request.grant.workingDirectory).toBeNull();
  });

  it('accepts and starts only after the answer, in that order', () => {
    const host = new LocalDocumentHost();
    const recorder = record(host);
    host.submit(documentSubmit('r1', DEFAULT_PROJECT_ID, SVG));
    const first = recorder.events[0]?.event;
    if (first?.type !== 'awaitingApproval') throw new Error('expected an approval request');

    host.approve({
      runId: 'r1',
      requestDigest: first.request.requestDigest,
      decision: 'allowOnce',
    });
    expect(recorder.types).toEqual(['awaitingApproval', 'accepted', 'started']);
  });

  it('settles refused when the person says no', () => {
    const host = new LocalDocumentHost();
    const recorder = record(host);
    host.submit(documentSubmit('r1', DEFAULT_PROJECT_ID, SVG));
    const first = recorder.events[0]?.event;
    if (first?.type !== 'awaitingApproval') throw new Error('expected an approval request');

    host.approve({ runId: 'r1', requestDigest: first.request.requestDigest, decision: 'deny' });
    expect(settledEvent(recorder)?.outcome).toEqual({
      kind: 'refused',
      reason: 'approvalDenied',
      mountIndex: null,
      protectedRoot: null,
    });
  });

  it('refuses an answer that does not match the request it was given', () => {
    const host = new LocalDocumentHost();
    record(host);
    host.submit(documentSubmit('r1', DEFAULT_PROJECT_ID, SVG));
    expect(() =>
      host.approve({ runId: 'r1', requestDigest: 'not-the-one', decision: 'allowOnce' }),
    ).toThrow(PlatformError);
  });
});

describe('every refusal arrives as an event, and exactly one does not', () => {
  it('settles refused rather than rejecting, when running artifacts is switched off', () => {
    const host = new LocalDocumentHost({ permission: 'off' });
    const recorder = record(host);
    const response = host.submit(documentSubmit('r1', DEFAULT_PROJECT_ID, SVG));

    expect(response.admitted).toBe(true);
    expect(settledEvent(recorder)?.outcome).toMatchObject({
      kind: 'refused',
      reason: 'permissionIsOff',
    });
  });

  it('refuses `off` for a language that runs no script of its own', () => {
    // The contract is explicit that `off` covers `svg` and `mermaid` too:
    // exempting the languages that "don't really execute" is a judgement about
    // what a program will do, made from its language tag.
    const host = new LocalDocumentHost({ permission: 'off' });
    const recorder = record(host);
    host.submit(documentSubmit('r1', DEFAULT_PROJECT_ID, MERMAID));
    expect(settledEvent(recorder)?.outcome).toMatchObject({ reason: 'permissionIsOff' });
  });

  it('refuses a language this build cannot draw, instead of drawing it wrong', () => {
    const host = new LocalDocumentHost({ permission: 'full' });
    const recorder = record(host);
    host.submit(documentSubmit('r1', DEFAULT_PROJECT_ID, MERMAID));
    expect(settledEvent(recorder)?.outcome).toMatchObject({
      kind: 'refused',
      reason: 'languageUnsupported',
    });
  });

  it('rejects a duplicate run id rather than pushing a refusal onto somebody else’s stream', () => {
    const host = new LocalDocumentHost();
    record(host);
    host.submit(documentSubmit('r1', DEFAULT_PROJECT_ID, SVG));
    expect(() => host.submit(documentSubmit('r1', DEFAULT_PROJECT_ID, BASH))).toThrow(
      PlatformError,
    );
  });

  it('refuses past its concurrency ceiling', () => {
    const host = new LocalDocumentHost({ permission: 'full' });
    const recorder = record(host);
    for (let index = 0; index < 9; index += 1) {
      host.submit(documentSubmit(`r${String(index)}`, DEFAULT_PROJECT_ID, SVG));
    }
    const refusals = recorder.events.filter(
      (envelope) =>
        envelope.event.type === 'settled' && envelope.event.outcome.kind === 'refused',
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.runId).toBe('r8');
  });
});

describe('exactly one settled, always, and the sequence is dense', () => {
  it('numbers a run’s events from zero with no gaps', () => {
    const host = new LocalDocumentHost({ permission: 'full' });
    const recorder = record(host);
    host.submit(documentSubmit('r1', DEFAULT_PROJECT_ID, SVG));
    host.reportDocument({ runId: 'r1', observation: { kind: 'rendered', renderMs: 4 } });

    expect(recorder.events.map((envelope) => envelope.seq)).toEqual([0, 1, 2]);
    expect(recorder.types).toEqual(['accepted', 'started', 'settled']);
  });

  it('settles a run released before it was ever answered', () => {
    const host = new LocalDocumentHost();
    const recorder = record(host);
    host.submit(documentSubmit('r1', DEFAULT_PROJECT_ID, SVG));
    host.release({ runId: 'r1' });

    expect(settledEvent(recorder)?.outcome).toMatchObject({
      kind: 'refused',
      reason: 'approvalAbandoned',
    });
  });

  it('settles a live run as cancelled when the surface goes away', () => {
    const host = new LocalDocumentHost({ permission: 'full' });
    const recorder = record(host);
    host.submit(documentSubmit('r1', DEFAULT_PROJECT_ID, SVG));
    host.release({ runId: 'r1' });

    expect(settledEvent(recorder)?.outcome).toEqual({
      kind: 'cancelled',
      reason: 'surfaceClosed',
    });
  });

  it('does not settle a second time when a released run is released again', () => {
    const host = new LocalDocumentHost({ permission: 'full' });
    const recorder = record(host);
    host.submit(documentSubmit('r1', DEFAULT_PROJECT_ID, SVG));
    host.release({ runId: 'r1' });
    host.release({ runId: 'r1' });

    const settlements = recorder.types.filter((type) => type === 'settled');
    expect(settlements).toHaveLength(1);
  });

  it('reports a cancel of an already-settled run as a race rather than an error', () => {
    const host = new LocalDocumentHost({ permission: 'full' });
    const recorder = record(host);
    host.submit(documentSubmit('r1', DEFAULT_PROJECT_ID, SVG));
    host.reportDocument({ runId: 'r1', observation: { kind: 'rendered', renderMs: 1 } });

    expect(host.cancel({ runId: 'r1', reason: 'user' })).toEqual({ cancelled: false });
    expect(recorder.types.filter((type) => type === 'settled')).toHaveLength(1);
  });
});

describe('a document settles when it renders and lives on afterwards', () => {
  it('keeps taking diagnostics after it has settled', () => {
    const host = new LocalDocumentHost({ permission: 'full' });
    const recorder = record(host);
    host.submit(documentSubmit('r1', DEFAULT_PROJECT_ID, SVG));
    host.reportDocument({ runId: 'r1', observation: { kind: 'rendered', renderMs: 2 } });
    host.reportDocument({
      runId: 'r1',
      observation: { kind: 'diagnostic', severity: 'error', text: 'it threw' },
    });

    expect(recorder.types).toEqual(['accepted', 'started', 'settled', 'diagnostic']);
  });

  it('drops a second render report, because that race is the host’s to win', () => {
    const host = new LocalDocumentHost({ permission: 'full' });
    const recorder = record(host);
    host.submit(documentSubmit('r1', DEFAULT_PROJECT_ID, SVG));
    host.reportDocument({ runId: 'r1', observation: { kind: 'rendered', renderMs: 2 } });
    host.reportDocument({ runId: 'r1', observation: { kind: 'rendered', renderMs: 900 } });

    expect(recorder.types.filter((type) => type === 'settled')).toHaveLength(1);
  });

  it('emits truncated once and keeps counting what it dropped', () => {
    const host = new LocalDocumentHost({ permission: 'full' });
    const recorder = record(host);
    host.submit(documentSubmit('r1', DEFAULT_PROJECT_ID, SVG));
    host.reportDocument({ runId: 'r1', observation: { kind: 'truncated', droppedBytes: 10 } });
    host.reportDocument({ runId: 'r1', observation: { kind: 'truncated', droppedBytes: 90 } });
    host.reportDocument({ runId: 'r1', observation: { kind: 'rendered', renderMs: 1 } });

    expect(recorder.types.filter((type) => type === 'truncated')).toHaveLength(1);
    expect(settledEvent(recorder)?.usage.droppedOutputBytes).toBe(100);
  });

  it('never reports a cost it did not measure', () => {
    const host = new LocalDocumentHost({ permission: 'full' });
    const recorder = record(host);
    host.submit(documentSubmit('r1', DEFAULT_PROJECT_ID, SVG));
    host.reportDocument({ runId: 'r1', observation: { kind: 'rendered', renderMs: 1 } });

    const usage = settledEvent(recorder)?.usage;
    // A zero here would be a claim that this host measured a cost and found
    // none. It has measured nothing, so it says nothing.
    expect(usage?.cpuMs).toBeNull();
    expect(usage?.peakMemoryBytes).toBeNull();
  });

  it('settles documentFailed when the surface says the source did not parse', () => {
    const host = new LocalDocumentHost({ permission: 'full' });
    const recorder = record(host);
    host.submit(documentSubmit('r1', DEFAULT_PROJECT_ID, SVG));
    host.reportDocument({
      runId: 'r1',
      observation: { kind: 'failed', reason: 'sourceRejectedByParser' },
    });

    expect(settledEvent(recorder)?.outcome).toEqual({
      kind: 'documentFailed',
      reason: 'sourceRejectedByParser',
    });
  });
});

describe('the first-render budget is the host’s timer and nobody else’s', () => {
  it('settles limitExceeded on wallClockMs when nothing ever rendered', () => {
    const host = new LocalDocumentHost({ permission: 'full' });
    const recorder = record(host);
    host.submit(documentSubmit('r1', DEFAULT_PROJECT_ID, SVG));

    vi.advanceTimersByTime(DEFAULT_DOCUMENT_LIMITS.wallClockMs + 1);
    expect(settledEvent(recorder)?.outcome).toEqual({
      kind: 'limitExceeded',
      limit: 'wallClockMs',
    });
  });

  it('does not kill a document that has already rendered', () => {
    // "A document that has rendered is not killed at the deadline, because a
    // Canvas artefact is meant to be looked at."
    const host = new LocalDocumentHost({ permission: 'full' });
    const recorder = record(host);
    host.submit(documentSubmit('r1', DEFAULT_PROJECT_ID, SVG));
    host.reportDocument({ runId: 'r1', observation: { kind: 'rendered', renderMs: 3 } });

    vi.advanceTimersByTime(DEFAULT_DOCUMENT_LIMITS.wallClockMs * 4);
    expect(recorder.types.filter((type) => type === 'settled')).toHaveLength(1);
    expect(settledEvent(recorder)?.outcome).toMatchObject({ kind: 'rendered' });
  });
});

describe('the policy a surface reads before it offers a button', () => {
  it('describes the absent process family as absent rather than as a sandbox', () => {
    const policy = new LocalDocumentHost().policy();
    expect(policy.backends.process.isolation).toEqual({ family: 'process', level: 'none' });
    expect(policy.backends.process.filesystem).toBe('unenforced');
    expect(policy.languages).not.toContain('bash');
    expect(policy.languages).not.toContain('python');
  });

  it('names the two languages it can actually draw and no others', () => {
    expect(new LocalDocumentHost().policy().languages).toEqual(['html', 'svg']);
  });

  it('counts the runs it is holding', () => {
    const host = new LocalDocumentHost({ permission: 'full' });
    expect(host.policy().activeRuns).toBe(0);
    host.submit(documentSubmit('r1', DEFAULT_PROJECT_ID, SVG));
    expect(host.policy().activeRuns).toBe(1);
    host.release({ runId: 'r1' });
    expect(host.policy().activeRuns).toBe(0);
  });
});

/**
 * Auto-approval, which is a **host** decision and is tested here for that reason.
 *
 * These assertions moved from `document-run.test.ts` when Canvas was wired to the
 * real host: `autoApproves` stopped having any caller in shipping renderer code,
 * and a rule about what a host decides belongs beside the fake host that decides
 * it. The rule itself is the contract's, and the authoritative implementation is
 * `within_profile` in `src-tauri/crates/vela-sandbox/src/admission.rs`.
 *
 * The first case below is the dead branch, pinned: under the profile Vela ships,
 * **no submit Canvas can build ever auto-approves**, so the `||` arm in
 * `LocalDocumentHost.submit` that calls this can never be taken and a user who
 * selects permission `approve` is prompted exactly as if they had selected `ask`.
 * The rest use a profile with the floor lowered to `opaqueOriginFrame`, which is
 * the only way to reach the clauses after the first one at all.
 */

const HTML: DocumentProgram = {
  kind: 'document',
  language: 'html',
  source: '<p>hello</p>',
  scripts: 'denied',
};

function autoApprovalSubmit(program: DocumentProgram = SVG): SandboxSubmitReq {
  return documentSubmit('run-auto', DEFAULT_PROJECT_ID, program);
}

describe('automatic approval is decided over the request', () => {
  it('auto-approves nothing Canvas can submit, under the profile Vela ships', () => {
    expect(autoApproves(DEFAULT_AUTO_APPROVAL_PROFILE, autoApprovalSubmit())).toBe(false);
    expect(autoApproves(DEFAULT_AUTO_APPROVAL_PROFILE, autoApprovalSubmit(HTML))).toBe(false);
  });

  it('approves once the request itself demands the floor the profile names', () => {
    const profile: AutoApprovalProfile = {
      ...DEFAULT_AUTO_APPROVAL_PROFILE,
      minimumIsolation: { process: 'container', document: 'opaqueOriginFrame' },
      maximumLimits: DEFAULT_DOCUMENT_LIMITS,
    };
    expect(autoApproves(profile, autoApprovalSubmit())).toBe(true);
  });

  it('does not approve a run that merely lands on a capable backend', () => {
    // The distinction the contract calls "not academic". A caller that named a
    // floor of `sameOrigin` asked for nothing, and must not sail through on the
    // strength of what the machine happens to be able to do.
    const profile: AutoApprovalProfile = {
      ...DEFAULT_AUTO_APPROVAL_PROFILE,
      minimumIsolation: { process: 'container', document: 'opaqueOriginFrame' },
      maximumLimits: DEFAULT_DOCUMENT_LIMITS,
    };
    const weak: SandboxSubmitReq = {
      ...autoApprovalSubmit(),
      minimumIsolation: { family: 'document', level: 'sameOrigin' },
    };
    expect(autoApproves(profile, weak)).toBe(false);
  });

  it('never approves a run that asked for the network', () => {
    const profile: AutoApprovalProfile = {
      ...DEFAULT_AUTO_APPROVAL_PROFILE,
      minimumIsolation: { process: 'container', document: 'opaqueOriginFrame' },
      maximumLimits: DEFAULT_DOCUMENT_LIMITS,
    };
    const noisy: SandboxSubmitReq = { ...autoApprovalSubmit(), network: { kind: 'allowed' } };
    expect(autoApproves(profile, noisy)).toBe(false);
  });

  it('never approves a limit above the profile ceiling', () => {
    const profile: AutoApprovalProfile = {
      ...DEFAULT_AUTO_APPROVAL_PROFILE,
      minimumIsolation: { process: 'container', document: 'opaqueOriginFrame' },
      maximumLimits: { ...DEFAULT_DOCUMENT_LIMITS, wallClockMs: 1 },
    };
    expect(autoApproves(profile, autoApprovalSubmit())).toBe(false);
  });
});
