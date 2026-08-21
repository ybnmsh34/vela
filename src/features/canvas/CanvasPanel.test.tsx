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

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { createSandboxRepository, type SandboxRepository } from '@/data/sandbox-repository';
import { BrowserAdapter } from '@/platform/browser-adapter';
import { DEFAULT_PROJECT_ID } from '@/platform/contract-project';
import type { SandboxProgram } from '@/platform/contract-sandbox';
import { PlatformError } from '@/platform/errors';

import { CanvasSurface } from './CanvasSurface';
import { CANVAS_FRAME_MESSAGE } from './document-frame';
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

/**
 * **The frame may only ever hold bytes the host accepted.**
 *
 * The suite above asserts the first half of that rule — no `accepted` event, no
 * frame — by querying the DOM once React has settled. That is exactly the query
 * that could not see the defect these two tests exist for, and it stayed green
 * through all of it: by the time it runs, the offending frame has already been
 * committed, loaded and torn down again.
 *
 * So the instrument here is the DOM's own history. A `MutationObserver` records
 * every `<iframe>` the document ever held and the `srcdoc` and `sandbox` it held
 * it with, because the value React *commits* is the value the browser acts on —
 * a frame that exists for one commit has already begun parsing its `srcdoc` and
 * running the inline script inside it. "It was removed again on the next tick"
 * is not a boundary.
 *
 * What made the gap reachable with no user action at all: the panel follows the
 * newest version of an artifact, so a model revising its own output moves the
 * surface's `program` while `run.phase` is still the previous run's `accepted`.
 * With script allowed for the previous version — one earlier tick of the
 * checkbox, which the panel keeps across revisions because `CanvasPanel` is
 * keyed on the artifact slot and not on the version — the revision reached the
 * DOM as `<iframe sandbox="allow-scripts">` carrying the new source, for a run
 * that had not been submitted, let alone approved.
 */
interface FrameSighting {
  readonly srcdoc: string;
  readonly sandbox: string;
}

function recordEveryFrame(): { readonly seen: FrameSighting[]; stop: () => void } {
  const seen: FrameSighting[] = [];
  const take = (node: Node): void => {
    if (!(node instanceof HTMLElement)) return;
    const frames = node.tagName === 'IFRAME' ? [node] : [...node.querySelectorAll('iframe')];
    for (const frame of frames) {
      seen.push({
        srcdoc: frame.getAttribute('srcdoc') ?? '',
        sandbox: frame.getAttribute('sandbox') ?? '',
      });
    }
  };
  const observer = new MutationObserver((records) => {
    for (const entry of records) {
      if (entry.type === 'childList') for (const node of entry.addedNodes) take(node);
      else take(entry.target);
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['srcdoc', 'sandbox'],
  });
  return { seen, stop: () => observer.disconnect() };
}

const PAGE_V1 = '<p id="first">a paragraph long enough to count as an artifact</p>';
const PAGE_V2 = '<p id="second">the revision, also long enough to count as one</p>';

describe('a revision is a different run, and reaches no frame before the host says so', () => {
  async function drawV1WithScript(sandbox: SandboxRepository) {
    const user = userEvent.setup();
    const view = render(
      <CanvasSurface
        assistantTexts={[answer(PAGE_V1, 'html')]}
        projectId={DEFAULT_PROJECT_ID}
        sandbox={sandbox}
      >
        <div>transcript</div>
      </CanvasSurface>,
    );
    await user.click(await renderOnce());
    await screen.findByTestId('canvas-frame');
    await user.click(screen.getByRole('checkbox'));
    await user.click(await renderOnce());
    expect((await screen.findByTestId('canvas-frame')).getAttribute('sandbox')).toBe(
      'allow-scripts',
    );
    return view;
  }

  it('never commits a frame holding a revision the host has not accepted', async () => {
    const sandbox = documentHostDouble();
    const view = await drawV1WithScript(sandbox);

    // The model revises the artifact. No click, no keystroke: the panel follows
    // the newest version on its own, which is the whole point of the rail.
    const watcher = recordEveryFrame();
    view.rerender(
      <CanvasSurface
        assistantTexts={[answer(PAGE_V1, 'html'), answer(PAGE_V2, 'html')]}
        projectId={DEFAULT_PROJECT_ID}
        sandbox={sandbox}
      >
        <div>transcript</div>
      </CanvasSurface>,
    );
    // The host has to get as far as asking about the revision, so that a frame
    // drawn for it would have had every chance to appear.
    await renderOnce();
    watcher.stop();

    const leaked = watcher.seen.filter((frame) => frame.srcdoc.includes('id="second"'));
    expect(leaked).toEqual([]);
  });

  it('draws the revision once, and only once the person has approved it', async () => {
    const user = userEvent.setup();
    const sandbox = documentHostDouble();
    const view = await drawV1WithScript(sandbox);

    view.rerender(
      <CanvasSurface
        assistantTexts={[answer(PAGE_V1, 'html'), answer(PAGE_V2, 'html')]}
        projectId={DEFAULT_PROJECT_ID}
        sandbox={sandbox}
      >
        <div>transcript</div>
      </CanvasSurface>,
    );
    // The control: the fix must not have made the revision undrawable. It is a
    // new run with its own approval, and answering that approval draws it.
    await user.click(await renderOnce());
    const frame = await screen.findByTestId('canvas-frame');
    expect(frame.getAttribute('srcdoc')).toContain('id="second"');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
  });
});

/**
 * **One program: the one the digest is over, described on the card and drawn in
 * the frame.**
 *
 * `Isolation` and `Network` always came off `ApprovalRequest`. `Script` came off
 * a program the panel held separately — the same two-sources shape as the frame
 * above, on the row that decides whether model-authored code executes. Moving
 * that row alone was not a fix: it left the card reading the host's echo and the
 * `<iframe>` reading the surface's submitted copy, which is the identical defect
 * with the two halves swapped, and the suite below is what caught it.
 *
 * The double echoes a `request.program` that disagrees with what was submitted.
 * **The shipped host would not do that**, and none of this is a claim that it
 * might: a divergent echo is the only instrument that can ask *which* of two
 * sources a value came from, and the contract has already answered which it
 * should be — `ApprovalRequest.program` is "the exact program text that will
 * run", and it is part of the submit `requestDigest` is computed over, so it is
 * what `allowOnce` consents to. A card that reads anything else describes a
 * different run to the person answering for this one; a frame built from
 * anything else *is* a different run.
 */
describe('the card and the frame are one program, not two that agree', () => {
  function echoing(rewrite: (program: SandboxProgram) => SandboxProgram): SandboxRepository {
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
              ...watched.event,
              request: { ...request, program: rewrite(request.program) },
            },
          });
        }),
    };
  }

  function echoingScripts(scripts: 'denied' | 'sandboxedNullOrigin'): SandboxRepository {
    return echoing((program) =>
      program.kind === 'document'
        ? { ...program, language: 'html', source: ECHOED_SOURCE, scripts }
        : program,
    );
  }

  const SUBMITTED = '<p id="submitted">a paragraph long enough to be an artifact</p>';
  const ECHOED_SOURCE = '<p id="echoed">a different paragraph, long enough to count as one</p>';

  it('says script executes when the host’s request says so', async () => {
    // Submitted with `scripts: 'denied'` — the panel's checkbox is untouched.
    mount([answer(SUBMITTED, 'html')], echoingScripts('sandboxedNullOrigin'));

    expect(await screen.findByText('Executes in the isolated frame')).toBeInTheDocument();
    expect(screen.queryByText('Will not execute')).not.toBeInTheDocument();
  });

  it('draws the program the card described, script and bytes together', async () => {
    const user = userEvent.setup();
    mount([answer(SUBMITTED, 'html')], echoingScripts('sandboxedNullOrigin'));

    await screen.findByText('Executes in the isolated frame');
    await user.click(await renderOnce());

    const frame = await screen.findByTestId('canvas-frame');
    const srcdoc = frame.getAttribute('srcdoc') ?? '';
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(srcdoc).toContain('id="echoed"');
    expect(srcdoc).not.toContain('id="submitted"');
  });

  /**
   * The direction that matters, because it is the one a person is misled by: the
   * card says script will not run, and the frame runs it. Nothing here is
   * clicked twice by accident — ticking the checkbox builds a different program,
   * which is a different run with its own approval, so the assertions are read
   * off the card that is up when `Render once` is finally pressed.
   */
  it('never draws script the card said would not execute', async () => {
    const user = userEvent.setup();
    mount([answer(SUBMITTED, 'html')], echoingScripts('denied'));

    const firstCard = await renderOnce();
    await user.click(screen.getByRole('checkbox'));
    // The submit now carries `scripts: 'sandboxedNullOrigin'`; the echo still
    // says `denied`. Wait for the second card rather than the first.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Render once' })).not.toBe(firstCard);
    });
    expect(screen.getByText('Will not execute')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Render once' }));
    const frame = await screen.findByTestId('canvas-frame');
    const srcdoc = frame.getAttribute('srcdoc') ?? '';
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(srcdoc).not.toContain("script-src 'unsafe-inline'");
    expect(srcdoc).not.toContain(CANVAS_FRAME_MESSAGE);
  });

  /**
   * The narrowing has to land somewhere, and where it lands is a decision.
   *
   * The phase carries a `SandboxProgram` because that is what the host said, and
   * `drawable` is the one place it becomes a `DocumentProgram`. A host that
   * approved a program this surface has no frame for gets nothing drawn and a
   * sentence saying so — not a fallback to the copy this renderer submitted,
   * which is the second source the whole change exists to remove.
   */
  it('draws nothing when the host approves a program it has no frame for', async () => {
    const user = userEvent.setup();
    mount(
      [answer(SUBMITTED, 'html')],
      echoing(() => ({
        kind: 'process',
        language: 'python',
        source: 'print(1)',
        workingDirectory: { kind: 'scratch' },
        environment: [],
        stdin: null,
      })),
    );

    await user.click(await renderOnce());

    expect(await screen.findByTestId('canvas-notice')).toHaveTextContent(
      'no way to draw what the host approved',
    );
    expect(screen.queryByTestId('canvas-frame')).not.toBeInTheDocument();
  });
});
