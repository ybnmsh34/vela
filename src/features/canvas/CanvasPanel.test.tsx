/**
 * The panel, driven the way a user drives it: from an assistant message.
 *
 * These mount `CanvasSurface` rather than `CanvasPanel`, so the whole chain is
 * under test — parse, detect, version, submit, approve, draw. A test that
 * constructed a track by hand would prove the panel renders and prove nothing
 * about whether a model's answer ever reaches it, which is the connection this
 * repo keeps discovering it did not have.
 *
 * The load-bearing assertion is the first one: **no frame before `accepted`**.
 * The contract names that as the rule a Canvas surface must follow, and a
 * surface that drew a frame without an accepted grant would be a defect in Vela
 * rather than an attack on it. Everything else here is behaviour; that one is a
 * boundary.
 *
 * ## Two hosts, and the difference between them is the point
 *
 * The surface talks to a {@link SandboxRepository} — the same promise-returning
 * door over `sandbox_submit` and friends that `src/app/App.tsx` builds. Which
 * host sits behind it is the only thing these suites vary:
 *
 *  - {@link documentHostDouble} is a **fake that accepts document runs**. No host
 *    in this tree does, so it is the only way to reach `awaitingApproval`,
 *    `accepted` and a drawn frame at all. Everything it proves is about the
 *    surface's own behaviour given those states, and nothing it proves is
 *    evidence about a boundary.
 *  - `BrowserAdapter` is the shipped fake, and it refuses every submit through
 *    the same ordered checks the Rust host runs. The suite at the bottom drives
 *    that path on purpose: with the decision host-held, **a host-side refusal has
 *    to arrive on screen as a refusal**, and that is the failure direction this
 *    feature's wiring has to get right before anything else about it matters.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { createSandboxRepository, type SandboxRepository } from '@/data/sandbox-repository';
import { BrowserAdapter } from '@/platform/browser-adapter';
import { DEFAULT_PROJECT_ID } from '@/platform/contract-project';
import type { EffectiveFilesystemScope, Mount } from '@/platform/contract-sandbox';
import { PlatformError } from '@/platform/errors';

import { CanvasSurface } from './CanvasSurface';
import { documentHostDouble } from './document-host-double';

const CHART_V1 = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4" fill="red"/></svg>';
const CHART_V2 = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="9" fill="red"/></svg>';

function answer(source: string, language = 'svg'): string {
  return `Here it is.\n\n\`\`\`${language}\n${source}\n\`\`\`\n`;
}

function mount(texts: readonly string[], sandbox: SandboxRepository = documentHostDouble()) {
  return render(
    <CanvasSurface assistantTexts={texts} projectId={DEFAULT_PROJECT_ID} sandbox={sandbox}>
      <div>transcript</div>
    </CanvasSurface>,
  );
}

/**
 * The approval button, once the host has asked for one.
 *
 * `findBy` rather than `getBy` throughout: the seam is `invoke`, so a submit and
 * its first event cross at least one microtask even against an in-process
 * double. A synchronous query here would be asserting that a boundary is not
 * one.
 */
function renderOnce(): Promise<HTMLElement> {
  return screen.findByRole('button', { name: 'Render once' });
}

describe('an artifact in an answer opens a panel', () => {
  it('draws no frame until a person has approved the run', async () => {
    mount([answer(CHART_V1)]);

    expect(await screen.findByRole('group', { name: 'Approve this artifact' })).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-frame')).not.toBeInTheDocument();
  });

  it('shows what the run was granted, not a reassuring sentence about it', async () => {
    mount([answer(CHART_V1)]);

    expect(
      await screen.findByText('Drawn in an isolated frame with no access to Vela'),
    ).toBeInTheDocument();
    expect(screen.getByText('No network access')).toBeInTheDocument();
    expect(screen.getByText('No filesystem access')).toBeInTheDocument();
    expect(screen.getByText('Will not execute')).toBeInTheDocument();
  });

  it('draws the frame once the person says yes, with the model’s bytes inside it', async () => {
    const user = userEvent.setup();
    mount([answer(CHART_V1)]);

    await user.click(await renderOnce());

    const frame = await screen.findByTestId('canvas-frame');
    expect(frame).toBeInTheDocument();
    expect(frame.getAttribute('srcdoc')).toContain('<circle r="4" fill="red"/>');
  });

  it('never hands the frame Vela’s own origin', async () => {
    const user = userEvent.setup();
    mount([answer(CHART_V1)]);
    await user.click(await renderOnce());

    const sandbox = (await screen.findByTestId('canvas-frame')).getAttribute('sandbox');
    expect(sandbox).toBe('');
    expect(sandbox).not.toContain('allow-same-origin');
  });

  it('draws nothing at all when the person says no', async () => {
    const user = userEvent.setup();
    mount([answer(CHART_V1)]);

    await renderOnce();
    await user.click(screen.getByRole('button', { name: 'Don’t render' }));

    expect(await screen.findByTestId('canvas-notice')).toHaveTextContent('Not rendered.');
    expect(screen.queryByTestId('canvas-frame')).not.toBeInTheDocument();
  });
});

/**
 * The row that could not go red.
 *
 * `documentSubmit` passes `NO_FILESYSTEM`, so every grant this feature can
 * currently provoke has an empty mount set — and for as long as that was true the
 * approval card's Files row was the literal string `No filesystem access`, sitting
 * beside three rows that were read off the grant. It was never wrong on screen,
 * because nothing could make it wrong: it answered what Canvas asks for, not what
 * the host granted. The test above it is named *shows what the run was granted,
 * not a reassuring sentence about it* and asserted a reassuring sentence.
 *
 * These drive the question the row is actually for. The host is the same
 * {@link documentHostDouble} the suites above use — the same backend report, the
 * same approve and release — with one event rewritten on its way across the seam,
 * so what is being modelled is *this host having granted mounts, a scratch path
 * and a write budget*, not a new fake with new opinions. A card that reads its
 * grant says what arrived; a card with a literal in it says `No filesystem
 * access` over a read-write mount of the user's home directory, which is the
 * exact sentence `ApprovalRequest` in
 * `src/platform/contract-sandbox.ts` exists to prevent.
 */
function grantingHost(
  filesystem: EffectiveFilesystemScope,
  fileWriteBytes = 0,
): SandboxRepository {
  const inner = documentHostDouble();
  return {
    ...inner,
    watch: (runId, handler) =>
      inner.watch(runId, (watched) => {
        if (watched.event.type !== 'awaitingApproval') {
          handler(watched);
          return;
        }
        const request = watched.event.request;
        handler({
          seq: watched.seq,
          event: {
            type: 'awaitingApproval',
            request: {
              ...request,
              grant: {
                ...request.grant,
                filesystem,
                limits: { ...request.grant.limits, fileWriteBytes },
              },
            },
          },
        });
      }),
  };
}

/**
 * A grant that names no directory at all: no mount, and no resolved scratch path.
 *
 * The contract calls {@link ResolvedScratch.guestPath} "Never absent", and
 * `admit` in `src-tauri/crates/vela-sandbox/src/admission.rs` does name one on
 * every grant it builds. This is the shape `document-host-double.ts` emits
 * instead: its `#grantFor` says "the scratch directory it never writes to
 * resolves to the empty guest path the contract's own `NO_FILESYSTEM` implies".
 */
const NAMES_NOTHING = { guestPath: '', retainAfterSettled: false } as const;

/**
 * What `admit` resolves for a run that asked for no particular path:
 * `DEFAULT_SCRATCH_GUEST_PATH`. A caller may ask for a different guest path and
 * get it, but not for a different fate: `retain_after_settled` is hardcoded
 * `false` on every grant `admit` builds, with the comment "Narrowed, never
 * widened".
 */
const DEFAULT_SCRATCH = { guestPath: '/vela/scratch', retainAfterSettled: false } as const;

const HOME_READ_WRITE: Mount = {
  hostPath: 'C:\\Users\\ada\\notes',
  guestPath: 'C:\\Users\\ada\\notes',
  mode: 'readWrite',
  materialisation: 'bind',
};

const SKILLS_READ_ONLY: Mount = {
  hostPath: 'C:\\Users\\ada\\vela\\skills',
  guestPath: 'C:\\Users\\ada\\vela\\skills',
  mode: 'readOnly',
  materialisation: 'bind',
};

const OWN_FOLDER_DELETED =
  'A folder of its own at /vela/scratch, writable, deleted when the run is released';

describe('the approval card tells the truth about the user’s disk', () => {
  it('names every granted directory and which way it may be used', async () => {
    mount(
      [answer(CHART_V1)],
      grantingHost({
        mounts: [HOME_READ_WRITE, SKILLS_READ_ONLY],
        scratch: NAMES_NOTHING,
        outsideMounts: 'denied',
      }),
    );

    await screen.findByRole('group', { name: 'Approve this artifact' });
    expect(screen.getByText('Read and write: C:\\Users\\ada\\notes')).toBeInTheDocument();
    expect(screen.getByText('Read only: C:\\Users\\ada\\vela\\skills')).toBeInTheDocument();
  });

  it('does not say “no filesystem access” over a mounted directory', async () => {
    // The regression in one line. A literal in this row is a prompt that
    // manufactures consent, and it is the failure the contract names by example.
    mount(
      [answer(CHART_V1)],
      grantingHost({
        mounts: [HOME_READ_WRITE],
        scratch: NAMES_NOTHING,
        outsideMounts: 'denied',
      }),
    );

    await screen.findByRole('group', { name: 'Approve this artifact' });
    expect(screen.queryByText('No filesystem access')).not.toBeInTheDocument();
  });

  it('names the folder the run gets to itself, on a zero write budget', async () => {
    // The defect the first version of this row shipped: it ended
    // `grant.limits.fileWriteBytes === 0 ? ['No filesystem access'] : […]`, so
    // this grant — which names `/vela/scratch` — was described as no filesystem
    // at all. `guest_script` in `src-tauri/crates/vela-sandbox/src/wsl.rs` sizes that
    // directory's tmpfs with
    // `(plan.limits.file_write_bytes / 1024).clamp(1024, 262_144)`: zero clamps
    // *up* to a writable 1024 KiB, and `base_environment_for` points `HOME`,
    // `TMPDIR` and `PWD` at it. A cost field is not a statement about reach.
    mount(
      [answer(CHART_V1)],
      grantingHost({ mounts: [], scratch: DEFAULT_SCRATCH, outsideMounts: 'denied' }, 0),
    );

    await screen.findByRole('group', { name: 'Approve this artifact' });
    expect(screen.getByText(OWN_FOLDER_DELETED)).toBeInTheDocument();
    expect(screen.queryByText('No filesystem access')).not.toBeInTheDocument();
  });

  it('reads the same folder the same way on a hundred-megabyte budget', async () => {
    // The other direction of the same rule, so the row is pinned off the cost
    // field from both sides: same scope, a budget a hundred times the 1024 KiB
    // the tmpfs clamps up to, and the sentence does not move.
    // `DEFAULT_PROCESS_LIMITS` is where this number comes from.
    mount(
      [answer(CHART_V1)],
      grantingHost(
        { mounts: [], scratch: DEFAULT_SCRATCH, outsideMounts: 'denied' },
        100 * 1024 * 1024,
      ),
    );

    await screen.findByRole('group', { name: 'Approve this artifact' });
    expect(screen.getByText(OWN_FOLDER_DELETED)).toBeInTheDocument();
  });

  it('says when a scratch directory outlives the run', async () => {
    // `retainAfterSettled` is the flag that leaves a directory on disk after the
    // run settles. A card that ignored it would be describing a run that cleans
    // up after itself when it does not. No backend in this tree sets it —
    // `admit` hardcodes `false` — so this case is guarded here rather than
    // observed; the field is on the grant and the wrong answer under-warns.
    mount(
      [answer(CHART_V1)],
      grantingHost({
        mounts: [],
        scratch: { guestPath: '/scratch/run-1', retainAfterSettled: true },
        outsideMounts: 'denied',
      }),
    );

    await screen.findByRole('group', { name: 'Approve this artifact' });
    expect(
      screen.getByText(
        'A folder of its own at /scratch/run-1, writable, kept after the run finishes',
      ),
    ).toBeInTheDocument();
  });

  it('says nothing is reachable only when the grant names nothing', async () => {
    // No mount and no scratch path, under a budget that is not zero — so the
    // sentence can only have come from the empty scope. This is the grant shape
    // `document-host-double.ts` emits for a document run, and the only shape in
    // this tree that names nothing: `admit` names a scratch path on every grant.
    mount(
      [answer(CHART_V1)],
      grantingHost(
        { mounts: [], scratch: NAMES_NOTHING, outsideMounts: 'denied' },
        100 * 1024 * 1024,
      ),
    );

    await screen.findByRole('group', { name: 'Approve this artifact' });
    expect(screen.getByText('No filesystem access')).toBeInTheDocument();
  });
});

describe('the source is always reachable, including where nothing can run', () => {
  it('shows the code behind a tab beside the preview', async () => {
    const user = userEvent.setup();
    mount([answer(CHART_V1)]);

    await user.click(screen.getByRole('tab', { name: 'Code' }));
    expect(screen.getByTestId('canvas-code')).toHaveTextContent('circle r="4" fill="red"');
  });

  it('still shows the code when running artifacts is switched off', async () => {
    const user = userEvent.setup();
    mount([answer(CHART_V1)], documentHostDouble({ permission: 'off' }));

    expect(await screen.findByTestId('canvas-notice')).toHaveTextContent('switched off');
    expect(screen.queryByTestId('canvas-frame')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Code' }));
    expect(screen.getByTestId('canvas-code')).toHaveTextContent('circle r="4" fill="red"');
  });

  it('shows the source of a language this build cannot draw, and says so', async () => {
    const user = userEvent.setup();
    mount([answer('graph TD;\n  Alpha-->Beta;\n  Beta-->Gamma;', 'mermaid')]);

    expect(await screen.findByTestId('canvas-notice')).toHaveTextContent('cannot draw this kind');
    await user.click(screen.getByRole('tab', { name: 'Code' }));
    expect(screen.getByTestId('canvas-code')).toHaveTextContent('Alpha-->Beta');
  });
});

describe('a revision is a version of the same artifact', () => {
  it('opens one panel with two versions, showing the newest', async () => {
    const user = userEvent.setup();
    mount([answer(CHART_V1), answer(CHART_V2)]);

    expect(screen.getAllByRole('button', { name: /^v\d$/ })).toHaveLength(2);
    await user.click(screen.getByRole('tab', { name: 'Code' }));
    expect(screen.getByTestId('canvas-code')).toHaveTextContent('r="9"');
  });

  it('lets the reader go back to an earlier one and stay there', async () => {
    const user = userEvent.setup();
    mount([answer(CHART_V1), answer(CHART_V2)]);

    await user.click(screen.getByRole('button', { name: 'v1' }));
    await user.click(screen.getByRole('tab', { name: 'Code' }));
    expect(screen.getByTestId('canvas-code')).toHaveTextContent('r="4"');
  });

  it('offers no comparison for the first version, because there is nothing before it', async () => {
    const user = userEvent.setup();
    mount([answer(CHART_V1), answer(CHART_V2)]);

    await user.click(screen.getByRole('button', { name: 'v1' }));
    expect(screen.getByRole('tab', { name: 'Changes' })).toBeDisabled();
  });

  it('shows what the revision changed', async () => {
    const user = userEvent.setup();
    mount([answer(CHART_V1), answer(CHART_V2)]);

    await user.click(screen.getByRole('tab', { name: 'Changes' }));
    const diff = screen.getByTestId('canvas-diff');
    expect(diff).toHaveTextContent('v1 → v2');
    expect(diff).toHaveTextContent('1 added, 1 removed');
    expect(diff).toHaveTextContent('r="9"');
  });
});

describe('closing the panel sticks to the artifact, not to the panel', () => {
  it('leaves a way back in', async () => {
    const user = userEvent.setup();
    mount([answer(CHART_V1)]);

    await user.click(screen.getByRole('button', { name: 'Close the artifact panel' }));
    expect(screen.queryByRole('tab', { name: 'Preview' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'SVG image' }));
    expect(screen.getByRole('tab', { name: 'Preview' })).toBeInTheDocument();
  });
});

describe('script is a decision, taken once, per program', () => {
  it('is denied until the reader asks, and asking asks again', async () => {
    const user = userEvent.setup();
    mount([answer('<p>a paragraph long enough to be an artifact</p>', 'html')]);

    await user.click(await renderOnce());
    expect((await screen.findByTestId('canvas-frame')).getAttribute('sandbox')).toBe('');

    await user.click(screen.getByRole('checkbox'));
    // A different program is a different run, so the approval is asked again
    // rather than inherited — which is the reason `scripts` is on the program.
    expect(screen.queryByTestId('canvas-frame')).not.toBeInTheDocument();
    await user.click(await renderOnce());
    expect((await screen.findByTestId('canvas-frame')).getAttribute('sandbox')).toBe(
      'allow-scripts',
    );
  });
});

/**
 * The direction that matters most, and the only one that is about the wiring.
 *
 * `BrowserAdapter` is the shipped fake host, and it answers a Canvas submit the
 * way the Rust host does: the document backend is reported at `sameOrigin`,
 * every Canvas submit demands `opaqueOriginFrame`, and a floor the host cannot
 * reach is `isolationUnavailable` rather than a quiet downgrade. So this is the
 * whole of what a user gets from Canvas on a real machine today — and the point
 * of these two assertions is that they get a *refusal*, in Vela's words, with the
 * model's source still one click away, rather than an empty panel.
 *
 * The rest of this file could be green with the surface still deciding everything
 * itself. This suite could not: a renderer-held host would draw the frame.
 */
describe('a host that refuses is a refusal on screen, not a blank panel', () => {
  const shippedFake = (): SandboxRepository => createSandboxRepository(new BrowserAdapter());

  it('says why nothing was drawn, and draws nothing', async () => {
    mount([answer(CHART_V1)], shippedFake());

    expect(await screen.findByTestId('canvas-notice')).toHaveTextContent(
      'no isolated frame to draw artifacts in',
    );
    expect(screen.queryByTestId('canvas-frame')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('group', { name: 'Approve this artifact' }),
    ).not.toBeInTheDocument();
  });

  it('still puts the model’s source in front of the reader', async () => {
    const user = userEvent.setup();
    mount([answer(CHART_V1)], shippedFake());

    await screen.findByTestId('canvas-notice');
    await user.click(screen.getByRole('tab', { name: 'Code' }));
    expect(screen.getByTestId('canvas-code')).toHaveTextContent('circle r="4" fill="red"');
  });

  it('says so in its own words when the submit is rejected rather than settled', async () => {
    // The other failure direction, and the one with no run behind it. The
    // contract rejects the *call* for a handful of malformed requests, and a
    // rejected invoke produces no `settled` event — so a surface that only
    // listened to the stream would sit on "Preparing…" for ever. There is no
    // outcome to word here, and inventing a `hostFailed` would be the renderer
    // putting words in the host's mouth, so the sentence is Vela's own.
    const rejecting: SandboxRepository = {
      ...documentHostDouble(),
      submit: () => Promise.reject(new PlatformError('INVALID_PAYLOAD', 'nope', 'sandbox_submit')),
    };
    mount([answer(CHART_V1)], rejecting);

    expect(await screen.findByTestId('canvas-notice')).toHaveTextContent(
      'could not send this artifact to be run',
    );
    expect(screen.queryByTestId('canvas-frame')).not.toBeInTheDocument();
  });
});
