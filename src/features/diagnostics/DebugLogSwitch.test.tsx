/**
 * The debug-log switch, driven through the real adapter seam.
 *
 * **VERIFIED-BY-FAKE.** `BrowserAdapter` mirrors the host's semantics and
 * writes no file. What is proved here is that the renderer asks the host, draws
 * the host's answer rather than its own optimism, and that the `trace` pointer
 * in a transcript is gated on the same fact.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { BrowserAdapter } from '@/platform/browser-adapter';
import { PlatformProvider } from '@/platform/PlatformProvider';
import { PlatformError } from '@/platform/errors';
import { resetDebugLogStore, useDebugLogStore } from '@/state/debug-log-store';

import { DebugLogSwitch } from './DebugLogSwitch';

function mount(adapter: BrowserAdapter) {
  return render(
    <PlatformProvider adapter={adapter}>
      <DebugLogSwitch />
    </PlatformProvider>,
  );
}

function toggle(): HTMLInputElement {
  return screen.getByRole('checkbox', {
    name: /Record what endpoints send back/,
  });
}

beforeEach(() => {
  resetDebugLogStore();
});

describe('the debug log switch', () => {
  it('starts off, and turning it on reaches the host', async () => {
    // ── THE LOAD-BEARING TEST ──────────────────────────────────────────────
    // `debuglog::enable` had no caller anywhere in the application: no command,
    // no setting, no affordance. Every failed turn nonetheless printed a
    // `trace` id pointing into the file it would have written. This is the
    // click that was missing.
    const adapter = new BrowserAdapter();
    const calls: string[] = [];
    const invoke = adapter.invoke.bind(adapter);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).invoke = (command: string, payload: unknown) => {
      calls.push(command);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any
      return invoke(command as any, payload as any);
    };
    mount(adapter);

    await waitFor(() => {
      expect(toggle()).not.toBeDisabled();
    });
    expect(toggle()).not.toBeChecked();
    expect(calls).toContain('diagnostics_debug_log_get');

    await userEvent.setup().click(toggle());

    await waitFor(() => {
      expect(toggle()).toBeChecked();
    });
    expect(calls).toContain('diagnostics_debug_log_set');
    expect(await adapter.invoke('diagnostics_debug_log_get', {})).toEqual({
      enabled: true,
      path: expect.any(String) as unknown as string,
    });
  });

  it('says where the file is, because the trace id has to be searched for somewhere', async () => {
    mount(new BrowserAdapter());
    const path = await screen.findByTestId('debug-log-path');
    expect(path).toHaveTextContent(/Would write to/);
    // The fake says it is a fake, so a screenshot of this screen cannot be read
    // as evidence that a file was written.
    expect(path).toHaveTextContent(/browser fake/);
  });

  it('draws the state the host reached, not the one the click asked for', async () => {
    // A switch that flips optimistically is a switch that claims to be
    // recording when the host could not create the directory.
    class RefusingHost extends BrowserAdapter {
      override async invoke(command: never, payload: never): Promise<never> {
        if ((command as string) === 'diagnostics_debug_log_set') {
          throw new PlatformError(
            'INTERNAL',
            'could not create the debug log directory',
            'diagnostics_debug_log_set',
          );
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return super.invoke(command, payload) as never;
      }
    }

    mount(new RefusingHost());
    await waitFor(() => {
      expect(toggle()).not.toBeDisabled();
    });
    await userEvent.setup().click(toggle());

    expect(await screen.findByRole('alert')).toHaveTextContent(/Nothing is being recorded/);
    expect(toggle()).not.toBeChecked();
    expect(useDebugLogStore.getState().state).toBe('off');
  });

  it('offers nothing to click until the host has answered', () => {
    // `unknown` is not `off`. A click that races the first answer would set a
    // state the two sides disagree about.
    mount(new BrowserAdapter());
    expect(toggle()).toBeDisabled();
    expect(useDebugLogStore.getState().state).toBe('unknown');
  });
});
