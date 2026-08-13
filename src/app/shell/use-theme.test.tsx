/**
 * The appearance preference, driven through the assembled shell.
 *
 * Found by auditing `App.tsx` for the defect class this wave exists to close:
 * a component built, tested, and never connected. Here it was the *setting*.
 * `settings_set_theme` had its own Rust tests, `settings-repository.setTheme`
 * had none of its own callers, `SettingsSnapshot.theme` was never read, and the
 * title bar's button moved a zustand value and stopped. The theme was correct
 * on screen and gone at the next launch.
 *
 * **VERIFIED-BY-FAKE.** `BrowserAdapter` holds the theme in memory the way the
 * host holds it in SQLite.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { App } from '@/app/App';
import { BrowserAdapter } from '@/platform/browser-adapter';
import { PlatformError } from '@/platform/errors';
import { resetThemeStore } from '@/state/theme-store';

function themeButton(): HTMLElement {
  return screen.getByRole('button', { name: /^Theme:/ });
}

beforeEach(() => {
  resetThemeStore();
});

afterEach(() => {
  resetThemeStore();
});

describe('the theme is kept where it is kept', () => {
  it('writes the choice through to the host instead of losing it on restart', async () => {
    // ── THE LOAD-BEARING TEST ──────────────────────────────────────────────
    const adapter = new BrowserAdapter();
    const user = userEvent.setup();
    render(<App adapter={adapter} />);

    await user.click(themeButton());
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    // The claim is about the *host*, not the DOM: what the user chose has to
    // survive the process, and nothing in the renderer was telling it.
    await waitFor(async () => {
      expect((await adapter.invoke('settings_get', {})).theme).toBe('light');
    });

    await user.click(themeButton());
    await waitFor(async () => {
      expect((await adapter.invoke('settings_get', {})).theme).toBe('dark');
    });
  });

  it('restores what the host holds when the app starts', async () => {
    // The other half: writing it down is pointless if nothing reads it back.
    const adapter = new BrowserAdapter();
    await adapter.invoke('settings_set_theme', { theme: 'dark' });

    render(<App adapter={adapter} />);

    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
    expect(themeButton()).toHaveAccessibleName('Theme: dark');
  });

  it('lets a click that beats the first read win', async () => {
    // The load is asynchronous. A stored preference landing after the user has
    // already chosen must not overrule them.
    class SlowHost extends BrowserAdapter {
      override async invoke(command: never, payload: never): Promise<never> {
        if ((command as string) === 'settings_get') {
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return super.invoke(command, payload) as never;
      }
    }
    // Typed as the base class so the seeding call below uses its generic
    // signature rather than the narrowed override.
    const adapter: BrowserAdapter = new SlowHost();
    await adapter.invoke('settings_set_theme', { theme: 'dark' });

    const user = userEvent.setup();
    render(<App adapter={adapter} />);
    await user.click(themeButton());

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('reverts rather than showing a preference that will not survive', async () => {
    // A refused write that left the new theme on screen would reappear as the
    // old one days later with nothing to explain it.
    class RefusingHost extends BrowserAdapter {
      override async invoke(command: never, payload: never): Promise<never> {
        if ((command as string) === 'settings_set_theme') {
          throw new PlatformError('INTERNAL', 'the store is read-only', 'settings_set_theme');
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return super.invoke(command, payload) as never;
      }
    }

    const user = userEvent.setup();
    render(<App adapter={new RefusingHost()} />);
    await user.click(themeButton());

    await waitFor(() => {
      expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    });
    expect(themeButton()).toHaveAccessibleName('Theme: system');
  });
});
