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
 * **VERIFIED-BY-FAKE.** `BrowserAdapter` is an in-memory host. This proves the
 * renderer's parts are connected to each other and proves nothing about a real
 * endpoint or a packaged binary.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '@/app/App';
import { BrowserAdapter } from '@/platform/browser-adapter';
import { NO_CAPABILITIES, type ModelCapabilityReport } from '@/platform/contract';
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
    expect(within(panel).getByRole('group', { name: 'Approve this artifact' })).toBeInTheDocument();
  });

  it('draws the frame under the grant the run was accepted with', async () => {
    const user = userEvent.setup();
    render(<App adapter={await host()} />);
    await user.click(await screen.findByRole('button', { name: 'Start a conversation' }));
    await screen.findByRole('region', { name: 'Conversation' });

    await say(user, `Draw me this.\n\n\`\`\`svg\n${CHART}\n\`\`\`\n`);
    await user.click(await screen.findByRole('button', { name: 'Render once' }));

    const frame = screen.getByTestId('canvas-frame');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain('<circle r="4" fill="red"/>');
  });

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
