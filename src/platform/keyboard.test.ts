/**
 * Both platforms are DRIVEN here. Not one of these assertions depends on the
 * machine the suite runs on: every case supplies its own environment, so the
 * Windows expectations and the macOS expectations are checked in the same
 * process on the same box.
 *
 * The quantity under test is a **pair**: the glyph that gets painted and the
 * name that gets announced. If the pre-fix defect were present — a hardcoded
 * `⌘` — the Windows cases would report `⌘K` and `Command K`. That is what these
 * assertions read.
 */

import { describe, expect, it } from 'vitest';

import {
  COMMAND_MODIFIER,
  CONTROL_MODIFIER,
  currentKeyboardEnvironment,
  resolvePrimaryModifier,
  shortcutLabel,
  type KeyboardEnvironment,
} from './keyboard';

/** A real WebView2 navigator, as Vela meets it on the operator's machine. */
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

/** WebKitGTK on the Linux box these tests are actually running on. */
const LINUX: KeyboardEnvironment = {
  platform: 'Linux x86_64',
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  userAgentData: { platform: 'Linux' },
};

describe('resolvePrimaryModifier', () => {
  it('gives Windows the Control key, by both of its names', () => {
    const modifier = resolvePrimaryModifier(WINDOWS);

    expect(modifier.id).toBe('control');
    expect(modifier.glyph).toBe('Ctrl');
    expect(modifier.accessibleName).toBe('Control');
    // The defect being guarded: neither half may be the Command key.
    expect(modifier.glyph).not.toBe('⌘');
    expect(modifier.accessibleName).not.toBe('Command');
  });

  it('gives macOS the Command key, by both of its names', () => {
    const modifier = resolvePrimaryModifier(MACOS);

    expect(modifier.id).toBe('command');
    expect(modifier.glyph).toBe('⌘');
    expect(modifier.accessibleName).toBe('Command');
  });

  it('gives Linux the Control key', () => {
    expect(resolvePrimaryModifier(LINUX)).toBe(CONTROL_MODIFIER);
  });

  it('reads userAgentData in preference to the deprecated platform field', () => {
    // A Chromium that has frozen `platform` to the legacy "Win32" value while
    // reporting the truth in `userAgentData`. The modern signal wins.
    expect(
      resolvePrimaryModifier({ platform: 'Win32', userAgentData: { platform: 'macOS' } }),
    ).toBe(COMMAND_MODIFIER);
  });

  it('falls back to platform when userAgentData is absent, and to the user agent after that', () => {
    expect(resolvePrimaryModifier({ platform: 'MacIntel' })).toBe(COMMAND_MODIFIER);
    expect(resolvePrimaryModifier({ platform: 'Win32' })).toBe(CONTROL_MODIFIER);

    expect(resolvePrimaryModifier({ userAgent: MACOS.userAgent })).toBe(COMMAND_MODIFIER);
    expect(resolvePrimaryModifier({ userAgent: WINDOWS.userAgent })).toBe(CONTROL_MODIFIER);
  });

  it('steps past empty signals rather than reading them as "not a Mac"', () => {
    // An engine that exposes `platform` as "" would otherwise pin every machine
    // to Control, including Apple ones.
    expect(resolvePrimaryModifier({ platform: '', userAgent: MACOS.userAgent })).toBe(
      COMMAND_MODIFIER,
    );
    expect(
      resolvePrimaryModifier({ userAgentData: { platform: '' }, platform: 'MacIntel' }),
    ).toBe(COMMAND_MODIFIER);
  });

  it('defaults to Control when the environment says nothing at all', () => {
    // Naming a key that is present under another name still works — the handler
    // accepts metaKey || ctrlKey. Naming an absent key does not.
    expect(resolvePrimaryModifier(null)).toBe(CONTROL_MODIFIER);
    expect(resolvePrimaryModifier(undefined)).toBe(CONTROL_MODIFIER);
    expect(resolvePrimaryModifier({})).toBe(CONTROL_MODIFIER);
  });
});

describe('shortcutLabel', () => {
  it('spells a Windows shortcut the way Windows spells it', () => {
    expect(shortcutLabel(resolvePrimaryModifier(WINDOWS), 'K')).toEqual({
      label: 'Ctrl+K',
      accessibleName: 'Control K',
    });
    expect(shortcutLabel(resolvePrimaryModifier(WINDOWS), 'N')).toEqual({
      label: 'Ctrl+N',
      accessibleName: 'Control N',
    });
  });

  it('spells a macOS shortcut the way macOS spells it — closed up, no separator', () => {
    expect(shortcutLabel(resolvePrimaryModifier(MACOS), 'K')).toEqual({
      label: '⌘K',
      accessibleName: 'Command K',
    });
    expect(shortcutLabel(resolvePrimaryModifier(MACOS), 'N')).toEqual({
      label: '⌘N',
      accessibleName: 'Command N',
    });
  });

  it('never puts a glyph in the announced name, on either platform', () => {
    for (const environment of [WINDOWS, MACOS, LINUX]) {
      const { accessibleName } = shortcutLabel(resolvePrimaryModifier(environment), 'K');
      expect(accessibleName).not.toMatch(/[⌘⌃⇧⌥]/u);
    }
  });
});

describe('currentKeyboardEnvironment', () => {
  it('reads navigator off the scope it is handed, not off a global', () => {
    const scope = { navigator: MACOS };
    expect(resolvePrimaryModifier(currentKeyboardEnvironment(scope))).toBe(COMMAND_MODIFIER);
    expect(resolvePrimaryModifier(currentKeyboardEnvironment({ navigator: WINDOWS }))).toBe(
      CONTROL_MODIFIER,
    );
  });

  it('answers null rather than throwing where there is no navigator', () => {
    // The Rust-side host, a worker, a server render: none of these have one, and
    // a label must not be the thing that takes the app down.
    expect(currentKeyboardEnvironment({})).toBeNull();
    expect(currentKeyboardEnvironment(null)).toBeNull();
    expect(currentKeyboardEnvironment('not a scope')).toBeNull();
    expect(currentKeyboardEnvironment({ navigator: null })).toBeNull();
  });

  it('reads the live navigator when handed no scope', () => {
    // jsdom supplies one; this asserts the wiring, not the value.
    expect(currentKeyboardEnvironment()).not.toBeNull();
  });
});
