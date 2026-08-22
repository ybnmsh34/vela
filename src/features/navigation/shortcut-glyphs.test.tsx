/**
 * THE APP MUST NOT NAME A KEY THE KEYBOARD DOES NOT HAVE.
 *
 * Both platforms are driven. Every case below mounts the real `Sidebar` and the
 * real `HomeSurface` inside a `KeyboardProvider` carrying a *substituted*
 * environment, so the Windows expectations and the macOS expectations are both
 * checked on this Linux box. Nothing here reads the machine it runs on; a test
 * that only passes where it was written is not evidence.
 *
 * ## The two quantities, and what each would read if the defect were present
 *
 * The defect was `<kbd className={styles.kbd}>⌘N</kbd>` — one literal, doing two
 * jobs badly.
 *
 * 1. **Painted.** The text of the badge's *visible* half. Under the defect this
 *    reads `⌘N` on Windows; it must read `Ctrl+N`.
 * 2. **Announced.** The button's computed accessible name — the badge sits
 *    inside the button, so the badge is part of it. Under the defect this reads
 *    `New conversation ⌘N` on Windows, and a screen reader pronounces the
 *    Command character on a machine that has no Command key. It must read
 *    `New conversation Control N`.
 *
 * The second is the half that was wrong *silently*: no screenshot shows an
 * accessible name, which is why no visual pass on any platform ever caught it.
 * Both are asserted for both platforms, and each is asserted to be free of the
 * other platform's spelling — a fix that painted `Ctrl` while still announcing
 * "Command" would fail here.
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { KeyboardProvider } from '@/platform/KeyboardProvider';
import { BrowserAdapter } from '@/platform/browser-adapter';
import { PlatformProvider } from '@/platform/PlatformProvider';
import type { KeyboardEnvironment } from '@/platform/keyboard';
import { resetNavigationStore } from '@/state/navigation-store';

import { ConversationsProvider } from './ConversationsProvider';
import { HomeSurface } from './HomeSurface';
import { Sidebar } from './Sidebar';

/** A real WebView2 navigator — the operator's actual machine. */
const WINDOWS: KeyboardEnvironment = {
  platform: 'Win32',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  userAgentData: { platform: 'Windows' },
};

/** A real macOS WKWebView navigator. */
const MACOS: KeyboardEnvironment = {
  platform: 'MacIntel',
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  userAgentData: { platform: 'macOS' },
};

function mountSidebar(environment: KeyboardEnvironment) {
  return render(
    <KeyboardProvider environment={environment}>
      <PlatformProvider adapter={new BrowserAdapter()}>
        <ConversationsProvider>
          <Sidebar />
        </ConversationsProvider>
      </PlatformProvider>
    </KeyboardProvider>,
  );
}

function mountHome(environment: KeyboardEnvironment) {
  return render(
    <KeyboardProvider environment={environment}>
      <PlatformProvider adapter={new BrowserAdapter()}>
        <ConversationsProvider>
          <HomeSurface secretBackend="memory-fake" />
        </ConversationsProvider>
      </PlatformProvider>
    </KeyboardProvider>,
  );
}

/**
 * What a sighted user reads off the badge.
 *
 * The painted half is exactly the half hidden from assistive technology, so
 * that is how it is identified. When a badge has no such half — the pre-fix
 * shape, one literal serving both audiences — the whole badge is what was
 * painted, and the assertion reads it and fails, which is the intent.
 */
function painted(badge: HTMLElement): string {
  const glyph = badge.querySelector('[aria-hidden="true"]');
  return (glyph ?? badge).textContent ?? '';
}

/** The badge inside a named button. */
function badgeIn(button: HTMLElement): HTMLElement {
  const kbd = button.querySelector('kbd');
  if (kbd === null) throw new Error(`no shortcut badge inside "${button.textContent}"`);
  return kbd;
}

beforeEach(() => {
  resetNavigationStore();
});

describe('shortcut badges on Windows', () => {
  it('offers the sidebar’s new-conversation shortcut as Ctrl+N, and announces Control', () => {
    mountSidebar(WINDOWS);

    const button = screen.getByRole('button', { name: /New conversation/ });

    expect(painted(badgeIn(button))).toBe('Ctrl+N');
    expect(button).toHaveAccessibleName('New conversation Control N');
    expect(button.textContent).not.toContain('⌘');
    expect(button).not.toHaveAccessibleName(expect.stringContaining('Command'));
  });

  it('offers the sidebar’s search shortcut as Ctrl+K, and announces Control', () => {
    mountSidebar(WINDOWS);

    const button = screen.getByRole('button', { name: /Search conversations/ });

    expect(painted(badgeIn(button))).toBe('Ctrl+K');
    expect(button).toHaveAccessibleName('Search conversations Control K');
    expect(button.textContent).not.toContain('⌘');
  });

  it('offers the home surface’s search shortcut as Ctrl+K, and announces Control', () => {
    mountHome(WINDOWS);

    const button = screen.getByRole('button', { name: /Search everything/ });

    expect(painted(badgeIn(button))).toBe('Ctrl+K');
    expect(button).toHaveAccessibleName('Search everything Control K');
    expect(button.textContent).not.toContain('⌘');
  });

  it('paints no Command glyph anywhere on either surface', () => {
    // The sweep, so a fourth call site added later cannot reintroduce the
    // literal without this failing.
    const sidebar = mountSidebar(WINDOWS);
    expect(sidebar.container.textContent).not.toMatch(/[⌘⌥⇧⌃]/u);
    sidebar.unmount();

    const home = mountHome(WINDOWS);
    expect(home.container.textContent).not.toMatch(/[⌘⌥⇧⌃]/u);
  });
});

describe('shortcut badges on macOS', () => {
  it('offers the sidebar’s shortcuts as ⌘N and ⌘K, and announces Command', () => {
    mountSidebar(MACOS);

    const create = screen.getByRole('button', { name: /New conversation/ });
    expect(painted(badgeIn(create))).toBe('⌘N');
    expect(create).toHaveAccessibleName('New conversation Command N');

    const search = screen.getByRole('button', { name: /Search conversations/ });
    expect(painted(badgeIn(search))).toBe('⌘K');
    expect(search).toHaveAccessibleName('Search conversations Command K');
  });

  it('offers the home surface’s shortcut as ⌘K, and announces Command', () => {
    mountHome(MACOS);

    const button = screen.getByRole('button', { name: /Search everything/ });
    expect(painted(badgeIn(button))).toBe('⌘K');
    expect(button).toHaveAccessibleName('Search everything Command K');
  });

  it('never hands the ⌘ character to a screen reader, even where it paints one', () => {
    // The glyph is drawn and the word is announced. On macOS the painted half
    // is right in both spellings, so only the announced half can be wrong —
    // and it is the half nothing else in this repository looks at.
    mountHome(MACOS);
    const button = screen.getByRole('button', { name: /Search everything/ });

    expect(painted(badgeIn(button))).toContain('⌘');
    expect(button).not.toHaveAccessibleName(expect.stringContaining('⌘'));
  });
});
