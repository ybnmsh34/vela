/**
 * The capability-driven affordances, driven end to end through the adapter seam.
 *
 * These mount the real workspace against the real `BrowserAdapter`, with the
 * capability report seeded exactly as a probe would have left it. Nothing is
 * mocked — the component asks the fake host over the same command surface the
 * Tauri host answers.
 *
 * The first test in this file is the one the whole feature exists to pass.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { BrowserAdapter } from '@/platform/browser-adapter';
import { PlatformProvider } from '@/platform/PlatformProvider';
import { NO_CAPABILITIES, type ChatCapabilities, type ModelCapabilityReport } from '@/platform/contract';
import { resetModelStore } from '@/state/model-store';

import { ModelWorkspace } from './ModelWorkspace';

interface Profile {
  readonly providerId: string;
  readonly modelId: string;
  readonly capabilities?: Partial<ChatCapabilities>;
  readonly structuredOutput?: boolean;
  readonly toolCallsEmulated?: boolean;
  readonly contextWindowTokens?: number | null;
}

function profile(input: Profile): ModelCapabilityReport {
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    capabilities: { ...NO_CAPABILITIES, streaming: true, ...input.capabilities },
    structuredOutput: input.structuredOutput ?? false,
    toolCallsEmulated: input.toolCallsEmulated ?? false,
    contextWindowTokens: input.contextWindowTokens ?? null,
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
    modelId: 'text-only',
  });
  return adapter;
}

function mount(adapter: BrowserAdapter, hasHistory = false) {
  return render(
    <PlatformProvider adapter={adapter}>
      <ModelWorkspace hasHistory={hasHistory}>
        <p>transcript</p>
      </ModelWorkspace>
    </PlatformProvider>,
  );
}

/** Every route a user could reach an image affordance by. */
function imageAffordances(): HTMLElement[] {
  return [
    ...screen.queryAllByTestId('attach-image'),
    ...screen.queryAllByTestId('attachment-picker-with-images'),
    ...screen.queryAllByRole('button', { name: /image/i }),
  ];
}

beforeEach(() => {
  resetModelStore();
});

describe('capability-driven affordances', () => {
  it('offers NO attach-image affordance at all when the capability struct reports no vision', async () => {
    // ── THE LOAD-BEARING TEST ──────────────────────────────────────────────
    // Not "a disabled button". Not "a button that errors on click". Nothing.
    // A disabled control is a promise the endpoint cannot keep, and it leaves
    // the user unable to tell whether their file, their model or Vela is wrong.
    const adapter = await host();
    adapter.seedCapabilities(
      profile({ providerId: 'workstation', modelId: 'text-only', capabilities: { vision: false } }),
    );
    mount(adapter);

    await screen.findByRole('button', { name: /The workstation/ });

    expect(imageAffordances()).toEqual([]);
    // What is offered instead is honest and useful: a text file can be inlined
    // into any model's prompt, and the control says exactly that.
    expect(screen.getByRole('button', { name: 'Attach a text file' })).toBeInTheDocument();
    expect(screen.getByTestId('attachment-picker-text-only')).toHaveAttribute(
      'accept',
      expect.stringContaining('.md'),
    );
    expect(screen.getByTestId('attachment-picker-text-only').getAttribute('accept')).not.toMatch(
      /image\//,
    );
  });

  it('offers the image affordance exactly when vision is reported', async () => {
    // The other half of the same claim: the absence above is caused by the
    // capability flag, and nothing else about the endpoint changed.
    const adapter = await host();
    adapter.seedCapabilities(
      profile({ providerId: 'workstation', modelId: 'text-only', capabilities: { vision: true } }),
    );
    mount(adapter);

    expect(await screen.findByRole('button', { name: 'Attach an image or a file' })).toBeInTheDocument();
    expect(screen.getByTestId('attach-image')).toBeInTheDocument();
    expect(screen.getByTestId('attachment-picker-with-images').getAttribute('accept')).toMatch(
      /image\/png/,
    );
  });

  it('offers nothing and says why when the model has never been probed', async () => {
    const adapter = await host();
    mount(adapter);

    await screen.findByRole('button', { name: /The workstation/ });
    expect(screen.getByRole('button', { name: 'Capabilities unknown' })).toBeInTheDocument();
    expect(imageAffordances()).toEqual([]);
  });

  it('lists what the model cannot do, in words, one click from the bar', async () => {
    const adapter = await host();
    adapter.seedCapabilities(
      profile({
        providerId: 'workstation',
        modelId: 'text-only',
        capabilities: { vision: false, toolCalls: false },
        toolCallsEmulated: true,
      }),
    );
    mount(adapter);

    const user = userEvent.setup();
    const limits = await screen.findByRole('button', { name: /limits?$/ });
    await user.click(limits);

    const summary = screen.getByRole('region', { name: 'What this model can do' });
    expect(within(summary).getByText('Not accepted')).toBeInTheDocument();
    expect(within(summary).getByText('Emulated')).toBeInTheDocument();
    expect(within(summary).getByText(/shown to you rather than run/i)).toBeInTheDocument();
    expect(within(summary).getByText(/no sign anything was ignored/i)).toBeInTheDocument();
  });

  it('surfaces the endpoint’s own context window, and says when there is none', async () => {
    const adapter = await host();
    adapter.seedCapabilities(
      profile({ providerId: 'workstation', modelId: 'text-only', contextWindowTokens: 4096 }),
    );
    mount(adapter);

    await waitFor(() => {
      expect(screen.getByTestId('context-meter')).toHaveTextContent(/of 4K tokens/);
    });
    expect(screen.getByTestId('context-meter')).toHaveAttribute('data-verdict', 'comfortable');
  });

  it('says the window is unreported rather than drawing a bar against a guess', async () => {
    const adapter = await host();
    adapter.seedCapabilities(profile({ providerId: 'workstation', modelId: 'text-only' }));
    mount(adapter);

    expect(await screen.findByTestId('context-meter')).toHaveTextContent(
      /not reported by this endpoint/i,
    );
  });

  it('probes on demand and never on mount, because a probe is a network request', async () => {
    const adapter = await host();
    const commands: string[] = [];
    const seen = adapter.invoke.bind(adapter);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).invoke = (command: string, payload: unknown) => {
      commands.push(command);
      return seen(command as never, payload as never);
    };
    mount(adapter);

    await screen.findByRole('button', { name: /The workstation/ });
    await waitFor(() => {
      expect(commands).toContain('models_capabilities');
    });
    expect(commands).not.toContain('models_probe');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Capabilities unknown' }));
    await user.click(screen.getByRole('button', { name: 'Check' }));

    await waitFor(() => {
      expect(commands).toContain('models_probe');
    });
  });
});

describe('switching model', () => {
  async function twoEndpoints(): Promise<BrowserAdapter> {
    const adapter = await host();
    await adapter.invoke('settings_put_provider', {
      id: 'zz-laptop',
      displayName: 'The laptop',
      kind: 'local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      modelId: 'other-model',
    });
    return adapter;
  }

  it('switches, and shows the consequences when a conversation is open', async () => {
    const adapter = await twoEndpoints();
    adapter.seedCapabilities(
      profile({ providerId: 'workstation', modelId: 'text-only', contextWindowTokens: 128 * 1024 }),
    );
    adapter.seedCapabilities(
      profile({ providerId: 'zz-laptop', modelId: 'other-model', contextWindowTokens: 4096 }),
    );
    mount(adapter, true);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /The workstation/ }));
    await user.click(screen.getByRole('option', { name: /other-model/ }));

    // The bar now addresses the new endpoint…
    await screen.findByRole('button', { name: /The laptop · other-model/ });
    // …and states what changing model actually did.
    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent(/has not seen any of it/i);
    expect(notice).toHaveTextContent(/text-only/);
    // The window follows the model, not the conversation.
    await waitFor(() => {
      expect(screen.getByTestId('context-meter')).toHaveTextContent(/of 4K tokens/);
    });

    await user.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('says nothing about consequences when there is no conversation to have them', async () => {
    const adapter = await twoEndpoints();
    mount(adapter, false);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /The workstation/ }));
    await user.click(screen.getByRole('option', { name: /other-model/ }));

    await screen.findByRole('button', { name: /The laptop/ });
    expect(screen.queryByText(/has not seen any of it/i)).not.toBeInTheDocument();
  });

  it('withdraws the image affordance the moment a text-only model is chosen', async () => {
    // The affordance is a function of the report, so it has to disappear on the
    // switch — not on the next reload, and not when the send fails.
    const adapter = await twoEndpoints();
    adapter.seedCapabilities(
      profile({ providerId: 'workstation', modelId: 'text-only', capabilities: { vision: true } }),
    );
    adapter.seedCapabilities(
      profile({ providerId: 'zz-laptop', modelId: 'other-model', capabilities: { vision: false } }),
    );
    mount(adapter);

    const user = userEvent.setup();
    await screen.findByTestId('attach-image');

    await user.click(screen.getByRole('button', { name: /The workstation/ }));
    await user.click(screen.getByRole('option', { name: /other-model/ }));

    await waitFor(() => {
      expect(imageAffordances()).toEqual([]);
    });
  });
});
