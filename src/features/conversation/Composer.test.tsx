import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { NO_CAPABILITIES } from '@/platform/contract';

import { Composer } from './Composer';
import type { AgentMode } from './use-conversation';

interface Handlers {
  readonly onSend: ReturnType<typeof vi.fn>;
  readonly onCancel: ReturnType<typeof vi.fn>;
}

function mount(
  overrides: {
    streaming?: boolean;
    blockedReason?: string | null;
    agent?: AgentMode;
  } = {},
): Handlers {
  const onSend = vi.fn();
  const onCancel = vi.fn();
  render(
    <Composer
      capabilities={NO_CAPABILITIES}
      streaming={overrides.streaming ?? false}
      blockedReason={overrides.blockedReason ?? null}
      {...(overrides.agent === undefined ? {} : { agent: overrides.agent })}
      onSend={onSend}
      onCancel={onCancel}
    />,
  );
  return { onSend, onCancel };
}

const box = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: 'Message' });

describe('the composer keyboard contract', () => {
  it('sends on Enter and clears the box', async () => {
    const user = userEvent.setup();
    const { onSend } = mount();
    await user.type(box(), 'hello{Enter}');
    expect(onSend).toHaveBeenCalledWith('hello');
    expect(box()).toHaveValue('');
  });

  it('inserts a newline on Shift+Enter and does not send', async () => {
    const user = userEvent.setup();
    const { onSend } = mount();
    await user.type(box(), 'first{Shift>}{Enter}{/Shift}second');
    expect(onSend).not.toHaveBeenCalled();
    expect(box()).toHaveValue('first\nsecond');
  });

  /**
   * Without this, the first Enter a Japanese, Chinese or Korean user presses to
   * accept an IME candidate sends a half-converted fragment.
   */
  it('does not send on the Enter that accepts an IME candidate', () => {
    const { onSend } = mount();
    fireEvent.change(box(), { target: { value: 'にほ' } });
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();

    // …and the next Enter, after composition ends, does send.
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('にほ');
  });

  it('sends nothing for whitespace only', async () => {
    const user = userEvent.setup();
    const { onSend } = mount();
    await user.type(box(), '   {Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('cancels the stream on Escape, and only while one is running', async () => {
    const user = userEvent.setup();
    const idle = mount();
    await user.type(box(), '{Escape}');
    expect(idle.onCancel).not.toHaveBeenCalled();
  });

  it('cancels on Escape while streaming', async () => {
    const user = userEvent.setup();
    const { onCancel } = mount({ streaming: true });
    box().focus();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not send while a stream is running', async () => {
    const user = userEvent.setup();
    const { onSend } = mount({ streaming: true });
    await user.type(box(), 'queued{Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('swaps Send for Stop while streaming, and says which key stops it', () => {
    mount({ streaming: true });
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(screen.getByText('Esc')).toBeInTheDocument();
  });

  it('states the reason in the box rather than silently refusing', () => {
    mount({ blockedReason: 'Choose a model to start a conversation' });
    expect(box()).toBeDisabled();
    expect(box()).toHaveAttribute('placeholder', 'Choose a model to start a conversation');
  });

  it('keeps Send disabled until there is something to send', async () => {
    const user = userEvent.setup();
    mount();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await user.type(box(), 'x');
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });
});

describe('the agent toggle', () => {
  const agent = (
    overrides: Partial<AgentMode> = {},
  ): AgentMode & { readonly setEnabled: ReturnType<typeof vi.fn> } => ({
    available: true,
    enabled: false,
    ...overrides,
    setEnabled: vi.fn(),
  });

  it('is absent entirely when a run could do nothing a plain send cannot', () => {
    // The same rule the attach control follows: no affordance rather than a
    // disabled one. A disabled toggle is a promise the model cannot keep, and a
    // composer rendered with no runtime behind it is in exactly that state.
    mount();
    expect(screen.queryByRole('button', { name: 'Run this turn as an agent' })).toBeNull();
  });

  it('reports its state where a screen reader and a stylesheet can both read it', () => {
    mount({ agent: agent({ enabled: true }) });
    expect(screen.getByRole('button', { name: 'Run this turn as an agent' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // The mode changes what pressing Send does, so it is said in words too.
    expect(screen.getByText(/Agent mode/)).toBeInTheDocument();
  });

  it('hands the flip back to whoever owns the state', async () => {
    const user = userEvent.setup();
    const mode = agent();
    mount({ agent: mode });
    await user.click(screen.getByRole('button', { name: 'Run this turn as an agent' }));
    expect(mode.setEnabled).toHaveBeenCalledWith(true);
  });
});
