import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { NO_CAPABILITIES } from '@/platform/contract';

import { Composer } from './Composer';

interface Handlers {
  readonly onSend: ReturnType<typeof vi.fn>;
  readonly onCancel: ReturnType<typeof vi.fn>;
}

function mount(overrides: { streaming?: boolean; blockedReason?: string | null } = {}): Handlers {
  const onSend = vi.fn();
  const onCancel = vi.fn();
  render(
    <Composer
      capabilities={NO_CAPABILITIES}
      streaming={overrides.streaming ?? false}
      blockedReason={overrides.blockedReason ?? null}
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
