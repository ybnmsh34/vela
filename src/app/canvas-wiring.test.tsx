/**
 * The joint: does a model's answer actually reach the artifact panel?
 *
 * This project's central defect class is "the thing everyone believed was
 * connected, was not", and `App.tsx` records two instances of it in this exact
 * shape — a context meter measuring an array nobody filled, and an attachment
 * tray whose files were never put in the payload. Both halves worked in both
 * cases. Canvas is a third component with the same risk profile: detection,
 * versioning, the run and the frame are each covered by their own suite in
 * `src/features/canvas/`, and none of that is evidence that an assistant message
 * ever gets to any of it.
 *
 * So this renders the real `<App />` against the fake host and drives it the way
 * a user does. The fake echoes the message back as the assistant's answer, which
 * is what puts a fenced block on the transcript without a model.
 *
 * ## What changed when the sandbox boundary moved, and why these read as losses
 *
 * Two of these used to click *Render once* and assert a drawn frame. They could,
 * because `CanvasSurface` built its own `LocalDocumentHost` in the renderer and
 * that host approved and accepted its own runs. It is now handed a
 * `SandboxRepository` from the composition root, so the decision belongs to
 * whatever is behind `invoke` — and **no host in this tree serves a document
 * run**. `BrowserAdapter` reports the document backend at `sameOrigin`, every
 * Canvas submit demands `opaqueOriginFrame`, and the Rust host answers the same
 * way; so the run is refused `isolationUnavailable` and no frame is drawn on any
 * machine.
 *
 * That is a real reduction in what this app does, and it is written here rather
 * than absorbed quietly. What these tests assert instead is a *stronger* claim
 * about the joint they exist for: the submit left the renderer, a host decided
 * it, and the host's answer came back and was put on screen in Vela's words with
 * the model's source still one click away. A drawn frame proved a renderer
 * talking to itself.
 *
 * **VERIFIED-BY-FAKE.** `BrowserAdapter` is an in-memory host. This proves the
 * renderer's parts are connected to each other and proves nothing about a real
 * endpoint or a packaged binary.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '@/app/App';
import { BrowserAdapter } from '@/platform/browser-adapter';
import {
  NO_CAPABILITIES,
  type CommandName,
  type CommandReq,
  type CommandRes,
  type ModelCapabilityReport,
} from '@/platform/contract';
import { resetModelStore } from '@/state/model-store';
import { resetNavigationStore } from '@/state/navigation-store';

const CHART = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4" fill="red"/></svg>';

function report(): ModelCapabilityReport {
  return {
    providerId: 'workstation',
    modelId: 'local-model',
    capabilities: { ...NO_CAPABILITIES, streaming: true },
    structuredOutput: false,
    toolCallsEmulated: false,
    contextWindowTokens: 128_000,
    maxOutputTokens: null,
    probed: true,
    findings: [],
  };
}

async function host(): Promise<BrowserAdapter> {
  const adapter = new BrowserAdapter();
  await adapter.invoke('settings_put_provider', {
    id: 'workstation',
    displayName: 'The workstation',
    kind: 'local',
    baseUrl: 'http://127.0.0.1:8080/v1',
    modelId: 'local-model',
  });
  adapter.seedCapabilities(report());
  return adapter;
}

async function say(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
  await user.click(screen.getByRole('textbox', { name: 'Message' }));
  await user.paste(text);
  await user.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => {
    expect(within(screen.getByRole('log')).getAllByRole('article')).toHaveLength(2);
  });
  await waitFor(() => {
    expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'false');
  });
}

beforeEach(() => {
  resetModelStore();
  resetNavigationStore();
});

describe('an artifact in an answer reaches the panel', () => {
  it('opens the panel for a fenced document the assistant produced', async () => {
    const user = userEvent.setup();
    render(<App adapter={await host()} />);
    await user.click(await screen.findByRole('button', { name: 'Start a conversation' }));
    await screen.findByRole('region', { name: 'Conversation' });

    await say(user, `Draw me this.\n\n\`\`\`svg\n${CHART}\n\`\`\`\n`);

    const panel = await screen.findByRole('complementary', { name: 'Artifact: SVG image' });
    expect(panel).toBeInTheDocument();
  });

  it('submits the run to the host and shows the host’s answer, whatever it is', async () => {
    const user = userEvent.setup();
    render(<App adapter={await host()} />);
    await user.click(await screen.findByRole('button', { name: 'Start a conversation' }));
    await screen.findByRole('region', { name: 'Conversation' });

    await say(user, `Draw me this.\n\n\`\`\`svg\n${CHART}\n\`\`\`\n`);

    // The whole joint in one assertion: this sentence exists only because a
    // `sandbox_submit` crossed `invoke`, the host ran its admission order, and
    // the refusal came back on `sandbox:event` for this run's id. Nothing in the
    // renderer can produce it on its own.
    const panel = await screen.findByRole('complementary', { name: 'Artifact: SVG image' });
    await waitFor(() => {
      expect(within(panel).getByTestId('canvas-notice')).toHaveTextContent(
        'no isolated frame to draw artifacts in',
      );
    });
    expect(within(panel).queryByTestId('canvas-frame')).not.toBeInTheDocument();
  });

  it('keeps the model’s source in front of the reader when the host refuses', async () => {
    const user = userEvent.setup();
    render(<App adapter={await host()} />);
    await user.click(await screen.findByRole('button', { name: 'Start a conversation' }));
    await screen.findByRole('region', { name: 'Conversation' });

    await say(user, `Draw me this.\n\n\`\`\`svg\n${CHART}\n\`\`\`\n`);

    const panel = await screen.findByRole('complementary', { name: 'Artifact: SVG image' });
    await user.click(within(panel).getByRole('tab', { name: 'Code' }));
    expect(within(panel).getByTestId('canvas-code')).toHaveTextContent('circle r="4" fill="red"');
  });

  /**
   * One artifact on screen is one run, however much streams beside it.
   *
   * `collectArtifacts` rebuilds every track from scratch whenever the
   * assistant-message array changes identity, which is once per drained batch of
   * stream deltas — including deltas of a *later* turn that contains no artifact
   * at all. Each rebuild produced a new `DocumentProgram` object for the artifact
   * already on screen, and `useDocumentRun` keyed its effect on that object.
   *
   * While Canvas ran a renderer-side host this cost objects. Once the boundary
   * moved it cost a `sandbox_release` and a `sandbox_submit` across `invoke` per
   * batch, either side of a torn-down and re-established `sandbox:event`
   * subscription. This test pins the fix; before it, the run below measured
   * **twelve** submits for one artifact.
   *
   * The pacing matters and is the reason this test looks odd. With the fake's
   * default microtask scheduling every delta of an answer lands in one burst and
   * the surface's own coalescing hides the defect — it measured two submits, not
   * twelve. One word per macrotask is what a real stream looks like to the
   * renderer, and it is the only setting under which this test can fail.
   */
  it('submits once for an artifact no matter how much streams beside it', async () => {
    const submits: CommandName[] = [];
    class Counting extends BrowserAdapter {
      override async invoke<C extends CommandName>(
        command: C,
        payload: CommandReq<C>,
      ): Promise<CommandRes<C>> {
        if (command === 'sandbox_submit') submits.push(command);
        return super.invoke(command, payload);
      }
    }
    const adapter = new Counting({ scheduleFrame: (run) => setTimeout(run, 1) });
    await adapter.invoke('settings_put_provider', {
      id: 'workstation',
      displayName: 'The workstation',
      kind: 'local',
      baseUrl: 'http://127.0.0.1:8080/v1',
      modelId: 'local-model',
    });
    adapter.seedCapabilities(report());

    const user = userEvent.setup();
    render(<App adapter={adapter} />);
    await user.click(await screen.findByRole('button', { name: 'Start a conversation' }));
    await screen.findByRole('region', { name: 'Conversation' });

    await user.click(screen.getByRole('textbox', { name: 'Message' }));
    await user.paste(`Draw me this.\n\n\`\`\`svg\n${CHART}\n\`\`\`\n`);
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(
      () => {
        expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'false');
      },
      { timeout: 10_000 },
    );
    await screen.findByRole('complementary', { name: 'Artifact: SVG image' });
    expect(submits).toHaveLength(1);

    // A second turn with no fence in it. The panel from the first turn stays
    // open and showing the same artifact for every word of it.
    await user.click(screen.getByRole('textbox', { name: 'Message' }));
    await user.paste(
      'Here is a much longer explanation that streams one word at a time and ' +
        'carries no fenced block at all so the panel beside it never changes ' +
        'which artifact it is showing while every one of these words arrives.',
    );
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(
      () => {
        expect(within(screen.getByRole('log')).getAllByRole('article')).toHaveLength(4);
      },
      { timeout: 10_000 },
    );
    await waitFor(
      () => {
        expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'false');
      },
      { timeout: 10_000 },
    );

    expect(
      submits,
      'the artifact on screen never changed, so the host should have been asked ' +
        'to run it exactly once — a second submit means the panel is keyed on ' +
        'the object carrying the program rather than on the program',
    ).toHaveLength(1);
  }, 30_000);

  it('leaves the transcript alone when the answer has nothing to draw', async () => {
    const user = userEvent.setup();
    render(<App adapter={await host()} />);
    await user.click(await screen.findByRole('button', { name: 'Start a conversation' }));
    await screen.findByRole('region', { name: 'Conversation' });

    await say(user, 'Just a sentence, no fences.');

    expect(screen.queryByRole('complementary', { name: /^Artifact:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Artifacts' })).not.toBeInTheDocument();
  });
});
