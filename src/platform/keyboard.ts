/**
 * WHICH MODIFIER KEY THIS MACHINE ACTUALLY HAS — and what to call it out loud.
 *
 * Vela ships one bundle to macOS, Windows and Linux. The *handler*
 * (`use-navigation-shortcuts.ts`) is deliberately platform-blind: it accepts
 * `metaKey || ctrlKey`, so Ctrl+K and ⌘K both work everywhere and nothing here
 * changes that. The **label** cannot be platform-blind. Until this file existed
 * the badges were the literals `⌘N` and `⌘K`, hardcoded in `Sidebar.tsx` and
 * `HomeSurface.tsx`, so a Windows user was told to press a key their keyboard
 * does not have — on the home surface, in the first sentence they read.
 *
 * ## Why the glyph and the accessible name are one value
 *
 * They were not just wrong on screen. `<kbd>⌘K</kbd>` sits *inside* the button,
 * so it is part of the button's accessible name: a screen reader on Windows
 * announced the Command character. That half was wrong silently — no screenshot
 * shows it, no visual critic can see it, and a fix that only swapped the painted
 * character would have left it wrong forever.
 *
 * So {@link PrimaryModifier} carries both, `glyph` and `accessibleName`, in one
 * frozen record, and {@link shortcutLabel} is the only thing that builds either.
 * There is no way to resolve one without the other, which is the point: they
 * cannot drift apart again.
 *
 * ## Why detection lives in the platform seam
 *
 * `src/platform/` exists to isolate environment differences, and a raw
 * `navigator.platform` read inside a component would be exactly the shape this
 * project keeps failing on — untestable except on the machine the test runs on.
 * Everything here is a pure function of an injected {@link KeyboardEnvironment},
 * so `keyboard.test.ts` drives a Windows-like environment and a Mac-like one in
 * the same process. {@link currentKeyboardEnvironment} is the single place a
 * real `navigator` is read, and it takes its scope as an argument too.
 *
 * ## Why `navigator` and not `app_info.os`
 *
 * The host already reports its OS over IPC (`AppInfo.os`), and it is the more
 * authoritative answer — but it arrives *after* a round trip. A label resolved
 * asynchronously paints `⌘K` and then flips to `Ctrl+K`, which is the same
 * first-paint defect already filed against the stored theme. `navigator` is
 * synchronous, is populated in WebView2, WKWebView and WebKitGTK alike, and is
 * meaningful in the browser adapter as well — the same bundle, headless, is
 * what the screenshots are taken of.
 */

/** The modifier a shortcut is spelled with. Two, because there are two. */
export type PrimaryModifierId = 'command' | 'control';

/**
 * A modifier key in both of the forms a user meets it in.
 *
 * `glyph` is painted; `accessibleName` is announced. `separator` belongs here
 * rather than at the call site because it is a property of the convention, not
 * of the shortcut: macOS writes `⌘K` closed up, Windows and Linux write
 * `Ctrl+K`.
 */
export interface PrimaryModifier {
  readonly id: PrimaryModifierId;
  /** What is drawn on screen. Never read by assistive technology. */
  readonly glyph: string;
  /** What assistive technology says. Never drawn on screen. */
  readonly accessibleName: string;
  /** Between modifier and key when painted. */
  readonly separator: string;
  /**
   * How Shift joins a chord on this keyboard, when a shortcut uses one.
   *
   * Both halves of the same problem the rest of this record solves, one level
   * down. macOS writes `⇧⌘N` — Shift **before** Command, both as glyphs, closed
   * up; Windows and Linux write `Ctrl+Shift+N` — Shift **after** Control, spelt
   * out, joined by the separator. A single "add a shift prefix" rule produces
   * `⌘⇧N` on one platform or `Shift+Ctrl+N` on the other, and both are wrong in
   * the way a native user notices immediately.
   *
   * `leading` is what carries that: the glyph order is a property of the
   * convention, not of any one shortcut, so it lives beside the convention.
   */
  readonly shift: {
    /** Painted. `⇧` or `Shift`. */
    readonly glyph: string;
    /** Announced. Always the word. */
    readonly accessibleName: string;
    /** Whether Shift is written before the primary modifier. */
    readonly leading: boolean;
  };
}

/** Apple keyboards: the Command key, written as its glyph. */
export const COMMAND_MODIFIER: PrimaryModifier = Object.freeze({
  id: 'command',
  glyph: '⌘',
  accessibleName: 'Command',
  separator: '',
  shift: Object.freeze({ glyph: '⇧', accessibleName: 'Shift', leading: true }),
});

/**
 * Everything else: Control, written out. `Ctrl` rather than `^` — the caret is
 * a macOS convention for the Control key and would be as foreign on Windows as
 * `⌘` is, and it is not what the key is labelled on the physical keyboard.
 */
export const CONTROL_MODIFIER: PrimaryModifier = Object.freeze({
  id: 'control',
  glyph: 'Ctrl',
  accessibleName: 'Control',
  separator: '+',
  /* Spelt out, never `⇧`: `shortcut-glyphs.test.tsx` sweeps both surfaces on a
     Windows-like environment for `/[⌘⌥⇧⌃]/u` and fails on any of them. That
     sweep is the reason this is a per-platform value and not a constant. */
  shift: Object.freeze({ glyph: 'Shift', accessibleName: 'Shift', leading: false }),
});

/**
 * The shape of the environment this module reads — a structural subset of
 * `Navigator`, so a real `navigator` satisfies it and a test literal does too.
 * Every field is optional: engines disagree about which of them exist, and
 * `navigator.platform` is deprecated (though still populated everywhere Vela
 * runs, including WebView2).
 */
export interface KeyboardEnvironment {
  /* `| undefined` explicitly, not just `?`. Under `exactOptionalPropertyTypes`
     those differ: `?` alone permits the key to be ABSENT but rejects it being
     PRESENT AND undefined. A real `navigator` hands us exactly that second
     shape — `navigator.platform` exists and reads `undefined` in some engines —
     and so does any caller forwarding a field it read from another environment.
     Rejecting it would push callers into `delete` or a spread dance to say the
     thing the type already means. */
  readonly platform?: string | undefined;
  readonly userAgent?: string | undefined;
  /** Chromium's replacement for `platform`: `"Windows"`, `"macOS"`, `"Linux"`. */
  readonly userAgentData?: { readonly platform?: string | undefined } | null | undefined;
}

/**
 * Substrings that mean "an Apple keyboard layout", across all three signals:
 * `macOS` and `MacIntel` and `Macintosh` and `iPhone` all match. No word
 * boundaries — `MacIntel` has none.
 */
const APPLE_SIGNAL = /(mac|iphone|ipad|ipod)/i;

/**
 * The most specific signal the environment actually carries.
 *
 * Order matters: `userAgentData.platform` is the modern, unfrozen answer;
 * `platform` is deprecated but universally populated; `userAgent` is the last
 * resort because it is the one a user or an extension can rewrite.
 */
function platformSignal(environment: KeyboardEnvironment | null | undefined): string | null {
  if (environment === null || environment === undefined) return null;
  const candidates = [
    environment.userAgentData?.platform,
    environment.platform,
    environment.userAgent,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return null;
}

/**
 * The modifier this environment's keyboard has.
 *
 * **Control is the default when nothing is known**, and that is a decision
 * rather than an accident: two of the three platforms Vela ships on use it, and
 * naming a key that is absent is worse than naming one that is present under a
 * different name — `Ctrl` on a Mac still works, because the handler accepts
 * either.
 */
export function resolvePrimaryModifier(
  environment?: KeyboardEnvironment | null,
): PrimaryModifier {
  const signal = platformSignal(environment);
  return signal !== null && APPLE_SIGNAL.test(signal) ? COMMAND_MODIFIER : CONTROL_MODIFIER;
}

/**
 * Read the live environment. The **only** place in `src/` that touches a real
 * `navigator`, and it takes its scope as an argument for the same reason
 * `isTauriRuntime` does.
 */
export function currentKeyboardEnvironment(scope: unknown = globalThis): KeyboardEnvironment | null {
  if (typeof scope !== 'object' || scope === null) return null;
  const navigator = (scope as { navigator?: unknown }).navigator;
  if (typeof navigator !== 'object' || navigator === null) return null;
  return navigator as KeyboardEnvironment;
}

/** A shortcut in both of the forms a user meets it in. Built only by {@link shortcutLabel}. */
export interface ShortcutLabel {
  /** Painted. `⌘K` or `Ctrl+K`. */
  readonly label: string;
  /** Announced. `Command K` or `Control K`. */
  readonly accessibleName: string;
}

/** Which extra modifiers a shortcut uses beyond the primary one. */
export interface ShortcutSpelling {
  /** `true` for a chord that also holds Shift, such as `Ctrl+Shift+N`. */
  readonly shift?: boolean | undefined;
}

/**
 * Spell one shortcut, both ways at once.
 *
 * `key` is the key as it is printed on the keycap — `'K'`, `'N'`. It is not
 * transformed: a caller that passes `'k'` gets `'k'`, because guessing at case
 * would be guessing at a keycap this function cannot see.
 *
 * A caller that needs Shift passes `{ shift: true }` rather than putting the
 * word in `key`. `key` is a keycap; `Shift+N` is not one, and a caller that
 * spelt it that way would get `⌘Shift+N` on a Mac — the Command glyph and the
 * English word in one badge — with nothing in the type to stop it.
 */
export function shortcutLabel(
  modifier: PrimaryModifier,
  key: string,
  spelling?: ShortcutSpelling,
): ShortcutLabel {
  if (spelling?.shift !== true) {
    return {
      label: `${modifier.glyph}${modifier.separator}${key}`,
      accessibleName: `${modifier.accessibleName} ${key}`,
    };
  }
  const painted = modifier.shift.leading
    ? [modifier.shift.glyph, modifier.glyph]
    : [modifier.glyph, modifier.shift.glyph];
  const announced = modifier.shift.leading
    ? [modifier.shift.accessibleName, modifier.accessibleName]
    : [modifier.accessibleName, modifier.shift.accessibleName];
  return {
    label: `${painted.join(modifier.separator)}${modifier.separator}${key}`,
    // Always spaces, never the painted separator: the accessible name is a
    // phrase a screen reader reads out, and `Control+Shift+N` is announced as
    // punctuation on some engines.
    accessibleName: `${announced.join(' ')} ${key}`,
  };
}
