/**
 * The frozen sandbox contract's document rules, asserted for the first time.
 *
 * `src/platform/contract-sandbox.ts` says of itself: "No test in this repo
 * enforces a single rule stated below … where this file says 'must', read 'the
 * implementation must, and no machine is watching yet'." These are the rules
 * Canvas is built on, so this is the machine for those four:
 *
 *  1. A document submit fixes `processes` at 1, `fileWriteBytes` at 0 and an
 *     empty mount set, and a request saying otherwise is `documentGrantInvalid`
 *     rather than quietly corrected.
 *  2. The isolation floor's family must match the program's, and the mismatch is
 *     `isolationFamilyMismatch` rather than a coercion.
 *  3. `isolationMeets` refuses a family mismatch and refuses an unknown level in
 *     either direction — the `-1` case the contract ships that function for.
 *
 * The fourth — auto-approval decided **over the request**, never over the
 * backend — used to be here too. It moved to `document-host-double.test.ts` with
 * the function it tests, because approval is a host decision and the only caller
 * of the TypeScript copy is now the fake host.
 *
 * **VERIFIED-BY-CONSTRUCTION.** These assert what Vela's own submit builder
 * produces and what a validator says about it. A real host *does* now see these
 * requests — `CanvasSurface` submits them through
 * `src/data/sandbox-repository.ts` — and refuses every one of them, because no
 * host in this tree serves a document run. The six `sandbox_*` commands are
 * wired; what is unbuilt is the document command path, `python`, both copying
 * materialisations and the approval surface. See the header of
 * `document-host-double.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DOCUMENT_LIMITS,
  DEFAULT_PROCESS_LIMITS,
  NO_FILESYSTEM,
  isolationMeets,
  type DocumentProgram,
  type Isolation,
  type SandboxSubmitReq,
} from '@/platform/contract-sandbox';
import { DEFAULT_PROJECT_ID } from '@/platform/contract-project';

import { CANVAS_ISOLATION_FLOOR, documentRefusal, documentSubmit, withScripts } from './document-run';

const SVG: DocumentProgram = {
  kind: 'document',
  language: 'svg',
  source: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>',
};

const HTML: DocumentProgram = {
  kind: 'document',
  language: 'html',
  source: '<p>hello</p>',
  scripts: 'denied',
};

function submit(program: DocumentProgram = SVG): SandboxSubmitReq {
  return documentSubmit('run-1', DEFAULT_PROJECT_ID, program);
}

describe('the three things a document submit may not choose', () => {
  it('builds a submit that carries all three, so the panel never has to be refused', () => {
    const request = submit();
    expect(request.limits.processes).toBe(1);
    expect(request.limits.fileWriteBytes).toBe(0);
    expect(request.filesystem.mounts).toEqual([]);
    expect(request.filesystem).toBe(NO_FILESYSTEM);
    expect(request.network).toEqual({ kind: 'denied' });
    expect(documentRefusal(request)).toBeNull();
  });

  it('refuses a second process rather than clamping it', () => {
    const request: SandboxSubmitReq = {
      ...submit(),
      limits: { ...DEFAULT_DOCUMENT_LIMITS, processes: 2 },
    };
    expect(documentRefusal(request)).toBe('documentGrantInvalid');
  });

  it('refuses a write budget rather than zeroing it', () => {
    const request: SandboxSubmitReq = {
      ...submit(),
      limits: { ...DEFAULT_DOCUMENT_LIMITS, fileWriteBytes: 1 },
    };
    expect(documentRefusal(request)).toBe('documentGrantInvalid');
  });

  it('refuses a mount rather than dropping it', () => {
    const request: SandboxSubmitReq = {
      ...submit(),
      filesystem: {
        mounts: [
          {
            hostPath: 'C:/Users/someone/notes',
            guestPath: 'C:/Users/someone/notes',
            mode: 'readOnly',
            materialisation: 'bind',
          },
        ],
        scratch: { guestPath: null, retainAfterSettled: false },
        outsideMounts: 'denied',
      },
    };
    expect(documentRefusal(request)).toBe('documentGrantInvalid');
  });
});

describe('a floor from the wrong family is a refusal, not a coercion', () => {
  it('refuses a document program asked to meet a process floor', () => {
    const request: SandboxSubmitReq = {
      ...submit(),
      minimumIsolation: { family: 'process', level: 'container' },
    };
    expect(documentRefusal(request)).toBe('isolationFamilyMismatch');
  });

  it('refuses a process program asked to meet a document floor', () => {
    const request: SandboxSubmitReq = {
      runId: 'run-2',
      projectId: DEFAULT_PROJECT_ID,
      program: {
        kind: 'process',
        language: 'bash',
        source: 'echo hi',
        workingDirectory: { kind: 'scratch' },
        environment: [],
        stdin: null,
      },
      filesystem: NO_FILESYSTEM,
      network: { kind: 'denied' },
      limits: DEFAULT_PROCESS_LIMITS,
      minimumIsolation: CANVAS_ISOLATION_FLOOR,
    };
    expect(documentRefusal(request)).toBe('isolationFamilyMismatch');
  });

  it('checks the family before the document-only rules, so the reason is stable', () => {
    // A request that is wrong in both ways must report the family, because on a
    // mismatched request the grant rules are being read against the wrong family
    // — and two implementations that ordered these differently would give a user
    // two different explanations for one bad request.
    const request: SandboxSubmitReq = {
      ...submit(),
      limits: { ...DEFAULT_DOCUMENT_LIMITS, processes: 9 },
      minimumIsolation: { family: 'process', level: 'none' },
    };
    expect(documentRefusal(request)).toBe('isolationFamilyMismatch');
  });
});

describe('isolationMeets, including the case it is a shipped function for', () => {
  it('ranks within a family', () => {
    const offered: Isolation = { family: 'document', level: 'ownRendererProcess' };
    expect(isolationMeets(offered, CANVAS_ISOLATION_FLOOR)).toBe(true);
    expect(isolationMeets(CANVAS_ISOLATION_FLOOR, offered)).toBe(false);
  });

  it('never ranks across families', () => {
    expect(
      isolationMeets({ family: 'process', level: 'microVm' }, CANVAS_ISOLATION_FLOOR),
    ).toBe(false);
  });

  it('refuses an unranked level rather than treating it as the weakest', () => {
    // The whole reason the contract ships this instead of telling each builder
    // to call `indexOf`: `-1` compared with `>=` accepts a run it should have
    // refused. A host newer than this renderer can send exactly this.
    const unknown = { family: 'document', level: 'somethingNewer' } as unknown as Isolation;
    expect(isolationMeets(unknown, CANVAS_ISOLATION_FLOOR)).toBe(false);
    expect(isolationMeets(CANVAS_ISOLATION_FLOOR, unknown)).toBe(false);
  });
});

describe('script is a property of the program, not a setting beside it', () => {
  it('cannot be put on an SVG, because the union has nowhere to put it', () => {
    const escalated = withScripts(SVG, 'sandboxedNullOrigin');
    expect(escalated).toEqual(SVG);
    expect('scripts' in escalated).toBe(false);
  });

  it('changes the program for HTML, which is what makes it a different run', () => {
    const escalated = withScripts(HTML, 'sandboxedNullOrigin');
    expect(escalated).toEqual({ ...HTML, scripts: 'sandboxedNullOrigin' });
    expect(HTML.scripts).toBe('denied');
  });
});
