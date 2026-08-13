/**
 * THE ASSEMBLED SURFACE, READ FROM ABOVE.
 *
 * `design-system.test.ts` asks whether the tokens are used. This file asks
 * whether the values they carry survive being *assembled* — in both themes, and
 * at more than one window width. Those are different questions, and the second
 * one had never been asked: every finding below was found by a human looking at
 * the running application on a real machine, and every one of them reproduces
 * identically here.
 *
 * ## The four it exists for
 *
 * 1. **A surface that equals its ground is not a surface.** `--vela-thinking-bg`
 *    was `--vela-night-25` in light and `--vela-bg` was `--vela-night-25` too;
 *    `--vela-code-bg` was `--vela-night-950` in dark and so was `--vela-bg`. In
 *    each case the panel existed, had a border, and painted nothing. Neither
 *    theme was wrong on its own — each token was reviewed in the theme where it
 *    reads — which is exactly why this has to be checked as a *pair*, per
 *    theme, from above.
 * 2. **A measure is a character count, not a container width.** 46rem set prose
 *    at ~95–105 characters per line. Comfortable is 65–75.
 * 3. **The composer and the transcript are one column or they are two.** They
 *    were two — 688px of text above a 736px box — which reads as a misalignment
 *    rather than as a design.
 * 4. **The sidebar is a share of the window, not a constant.** A 480px sidebar
 *    is a third of a 1440px window and half of a 1000px one.
 *
 * ## Why arithmetic and not a screenshot
 *
 * jsdom does no layout, so nothing here can be measured by rendering. Instead
 * the token graph is resolved to pixels — the same substitution the engine
 * does — and the two columns' edges are *computed*. That makes these facts
 * about the stylesheet, true in every engine, which is what lets them stand
 * while the browser-driven measurement in `tests/harness/ui-bridge` remains the
 * evidence for what was actually painted.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8');

const TOKENS = read('src/styles/tokens.css');
const CONVERSATION = read('src/features/conversation/ConversationView.module.css');
const COMPOSER = read('src/features/conversation/Composer.module.css');
const SIDEBAR = read('src/features/navigation/Sidebar.module.css');
const SIDEBAR_TSX = read('src/features/navigation/Sidebar.tsx');

/* -------------------------------------------------------------------------- */
/* resolving the token graph, the way the engine does                          */
/* -------------------------------------------------------------------------- */

const ROOT_FONT_SIZE_PX = 16;

/** The three blocks the token sheet declares, in cascade order. */
function themeBlocks(): { light: string; dark: string } {
  const media = TOKENS.indexOf('@media (prefers-color-scheme: dark)');
  const explicit = TOKENS.indexOf(":root[data-theme='dark']");
  expect(media, 'the token sheet was restructured; fix this slice').toBeGreaterThan(0);
  expect(explicit).toBeGreaterThan(media);
  return { light: TOKENS.slice(0, media), dark: TOKENS.slice(explicit) };
}

function declaredTokens(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of block.matchAll(/^\s*(--vela-[a-z0-9-]+):\s*([^;]+);/gm)) {
    out.set(match[1] ?? '', (match[2] ?? '').trim());
  }
  return out;
}

/** Light first, then the dark overrides on top — the cascade, in a Map. */
function paletteFor(theme: 'light' | 'dark'): Map<string, string> {
  const { light, dark } = themeBlocks();
  const palette = declaredTokens(light);
  if (theme === 'dark') {
    for (const [name, value] of declaredTokens(dark)) palette.set(name, value);
  }
  return palette;
}

/** Substitutes `var(--x)` until nothing is left to substitute. */
function substitute(value: string, palette: Map<string, string>): string {
  let out = value;
  for (let pass = 0; pass < 12 && out.includes('var('); pass += 1) {
    out = out.replace(/var\((--vela-[a-z0-9-]+)\)/gu, (whole, name: string) => palette.get(name) ?? whole);
  }
  return out.trim();
}

/**
 * A length, in px. `rem` against a 16px root, which is what the app runs at —
 * `base.css` never resets it, so this is the engine's own arithmetic and not a
 * convention invented here.
 *
 * A four-function evaluator rather than `eval`: this reads a file, and a file
 * that reaches an evaluator is a file that can execute.
 */
function lengthPx(value: string, palette: Map<string, string>): number {
  const flat = substitute(value, palette).replace(/\bcalc\b/gu, '');
  const tokens = flat.match(/\d*\.?\d+(?:px|rem|em)?|[+\-*/()]/gu) ?? [];
  let at = 0;

  const peek = (): string | undefined => tokens[at];
  const number = (): number => {
    const token = tokens[at];
    at += 1;
    if (token === '(') {
      const inner = sum();
      at += 1; // ')'
      return inner;
    }
    if (token === '-') return -number();
    if (token === undefined) throw new Error(`unreadable length: ${value}`);
    if (token.endsWith('rem') || token.endsWith('em')) {
      return Number.parseFloat(token) * ROOT_FONT_SIZE_PX;
    }
    return Number.parseFloat(token);
  };
  const product = (): number => {
    let left = number();
    while (peek() === '*' || peek() === '/') {
      const operator = tokens[at];
      at += 1;
      const right = number();
      left = operator === '*' ? left * right : left / right;
    }
    return left;
  };
  function sum(): number {
    let left = product();
    while (peek() === '+' || peek() === '-') {
      const operator = tokens[at];
      at += 1;
      const right = product();
      left = operator === '+' ? left + right : left - right;
    }
    return left;
  }

  const result = sum();
  expect(Number.isFinite(result), `could not resolve "${value}" to a length`).toBe(true);
  return result;
}

/** The declarations of the first rule whose selector list contains `selector`. */
function rule(sheet: string, selector: string): Map<string, string> {
  const stripped = sheet.replace(/\/\*[\s\S]*?\*\//gu, '');
  const pattern = new RegExp(`(^|,|\\})\\s*${selector.replace('.', '\\.')}\\s*(,[^{]*)?\\{([^}]*)\\}`, 'mu');
  const body = pattern.exec(stripped)?.[3];
  expect(body, `no rule for ${selector}`).toBeDefined();
  const out = new Map<string, string>();
  for (const line of (body ?? '').split(';')) {
    const at = line.indexOf(':');
    if (at > 0) out.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return out;
}

/** `padding: a b c` → the inline (left/right) component. */
function inlinePadding(shorthand: string, palette: Map<string, string>): number {
  const parts = shorthand.split(/\s+(?![^(]*\))/u).filter((part) => part.length > 0);
  const inline = parts.length === 1 ? parts[0] : parts[1];
  return lengthPx(inline ?? '0', palette);
}

/* -------------------------------------------------------------------------- */
/* 1. no surface disappears into its ground                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every painted surface and the thing it is painted on top of.
 *
 * A pair, not a token, because "is this colour right" is unanswerable and "can
 * you see this panel against what is behind it" is not. Both themes, always:
 * each of the two real failures was correct in one theme and invisible in the
 * other, which is precisely the shape a single-theme review cannot catch.
 */
const SURFACES: readonly (readonly [surface: string, ground: string, what: string])[] = [
  ['--vela-thinking-bg', '--vela-bg', 'the thinking block, against the transcript'],
  ['--vela-code-bg', '--vela-bg', 'a fenced code block, against the transcript'],
  ['--vela-code-surface', '--vela-code-bg', 'the code block’s language bar, against its own body'],
  ['--vela-turn-user-bg', '--vela-bg', 'your own message, against the transcript'],
  ['--vela-notice-bg', '--vela-bg', 'a degradation note, against the transcript'],
  ['--vela-warning-bg', '--vela-bg', 'a warning, against the page'],
  ['--vela-danger-bg', '--vela-bg', 'an error, against the page'],
  ['--vela-bg-inset', '--vela-bg', 'an inset well, against the page'],
  ['--vela-surface', '--vela-bg', 'a raised card, against the page'],
  ['--vela-chrome', '--vela-bg', 'the sidebar, against the content region'],
  ['--vela-accent-quiet', '--vela-bg', 'a quiet accent fill, against the page'],
];

describe('no surface disappears into its ground, in either theme', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`holds in ${theme}`, () => {
      const palette = paletteFor(theme);
      const collapsed = SURFACES.filter(([surface, ground]) => {
        const a = substitute(`var(${surface})`, palette);
        const b = substitute(`var(${ground})`, palette);
        return a === b;
      }).map(([surface, ground, what]) => `${what}: ${surface} === ${ground} (${substitute(`var(${surface})`, palette)})`);

      expect(collapsed, `these surfaces paint nothing in ${theme}`).toEqual([]);
    });
  }

  it('resolves the graph rather than comparing var() strings', () => {
    // The control. If `substitute` stopped substituting, every pair above would
    // compare `var(--a)` with `var(--b)`, differ, and the suite would pass while
    // checking nothing.
    const palette = paletteFor('light');
    expect(substitute('var(--vela-bg)', palette)).toMatch(/^#[0-9a-f]{6}$/iu);
    expect(substitute('var(--vela-thinking-bg)', palette)).toMatch(/^#[0-9a-f]{6}$/iu);
    expect(paletteFor('dark').get('--vela-bg')).not.toBe(palette.get('--vela-bg'));
  });
});

/* -------------------------------------------------------------------------- */
/* 2. the reading measure                                                      */
/* -------------------------------------------------------------------------- */

describe('the reading measure is a measure', () => {
  it('sets the reading column near the comfortable band', () => {
    // The operator's own measurement is the anchor: 688px of content at
    // --vela-text-base put prose at ~95–105 characters per line on a real
    // machine. Linearly, ~70 characters is ~480px. The band here is deliberately
    // wider than one value, because the average character advance depends on a
    // typeface Vela does not yet bundle; the *measured* characters-per-line
    // assertion lives in the browser-driven gate, which can see the face that
    // was actually used.
    const measure = lengthPx('var(--vela-measure)', paletteFor('light'));
    expect(measure, `--vela-measure resolves to ${String(measure)}px of prose`).toBeGreaterThanOrEqual(440);
    expect(measure).toBeLessThanOrEqual(540);
  });

  it('does not make a settings form read at prose width', () => {
    // The measure used to be shared with the endpoints panel, so narrowing it
    // for prose would have silently narrowed a form full of side-by-side
    // fields. A form is not prose and does not want a prose measure.
    const panel = read('src/features/models/EndpointsPanel.module.css');
    expect(panel).not.toMatch(/max-width:\s*var\(--vela-measure\)/u);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. one vertical ruler                                                       */
/* -------------------------------------------------------------------------- */

describe('the transcript and the composer stand on one vertical ruler', () => {
  it('puts the reader’s text and the composer’s box on the same left edge', () => {
    const palette = paletteFor('light');

    const column = rule(CONVERSATION, '.column');
    const columnOuter = lengthPx(column.get('max-width') ?? '', palette);
    const columnPad = inlinePadding(column.get('padding') ?? '0', palette);
    // Both are centred, so measure each edge from the centre line: the sign
    // cancels and the two numbers are directly comparable.
    const transcriptEdge = columnOuter / 2 - columnPad;

    const field = rule(COMPOSER, '.field');
    const composerEdge = lengthPx(field.get('max-width') ?? '', palette) / 2;

    expect(
      Math.round(composerEdge * 100) / 100,
      `the composer's box is ${String(composerEdge * 2)}px wide over ${String(transcriptEdge * 2)}px of text`,
    ).toBe(Math.round(transcriptEdge * 100) / 100);
  });

  it('gives both the same gutter, from one token', () => {
    const palette = paletteFor('light');
    const columnPad = inlinePadding(rule(CONVERSATION, '.column').get('padding') ?? '0', palette);
    const composerPad = inlinePadding(rule(COMPOSER, '.composer').get('padding') ?? '0', palette);
    expect(composerPad).toBe(columnPad);
    // And the hint under the field reads on the same ruler as the field.
    expect(rule(COMPOSER, '.hint').get('max-width')).toBe(rule(COMPOSER, '.field').get('max-width'));
  });

  it('reads a length the way the engine reads one', () => {
    // The control for the evaluator above. A resolver that quietly returned 0
    // for everything would make both edges equal and pass test one.
    const palette = paletteFor('light');
    expect(lengthPx('2rem', palette)).toBe(32);
    expect(lengthPx('calc(30rem + 2 * 1.5rem)', palette)).toBe(528);
    expect(lengthPx('calc(1rem - 4px)', palette)).toBe(12);
    expect(lengthPx('var(--vela-space-5)', palette)).toBe(24);
    expect(inlinePadding('var(--vela-space-3) var(--vela-space-5) var(--vela-space-4)', palette)).toBe(24);
    expect(inlinePadding('var(--vela-space-4)', palette)).toBe(16);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. the scroll edge                                                          */
/* -------------------------------------------------------------------------- */

describe('content is not guillotined at the scroll edge', () => {
  it('fades the transcript into its edges instead of cutting it', () => {
    const scroller = rule(CONVERSATION, '.scroller');
    const mask = scroller.get('mask-image') ?? scroller.get('mask') ?? '';
    expect(mask, 'a scroll container that ends in a hard cut reads as a rendering fault').toMatch(
      /linear-gradient/u,
    );
    expect(mask, 'the fade depth is a token like every other length').toMatch(/var\(--vela-scroll-fade\)/u);
  });

  it('does not fade an edge that has nothing beyond it', () => {
    // A permanent gradient dims the first turn even when the transcript is
    // scrolled to the top, which is the same defect pointed the other way. The
    // fade is switched by the edge state the component already measures.
    expect(CONVERSATION).toMatch(/\.scroller\[data-at-top='true'\]|\.scroller\[data-edges/u);
    expect(read('src/features/conversation/ConversationView.tsx')).toMatch(/data-at-top|data-edges/u);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. the sidebar is a share of the window                                     */
/* -------------------------------------------------------------------------- */

describe('the sidebar responds to the window it is in', () => {
  it('caps itself against the viewport, not against a constant alone', () => {
    const sidebar = rule(SIDEBAR, '.sidebar');
    const width = sidebar.get('width') ?? '';
    expect(width, 'a 480px sidebar is half of a 1000px window').toMatch(/min\(/u);
    expect(width, 'only the viewport knows how much room there is').toMatch(/100vw/u);
  });

  it('gives way to the reading column rather than to a percentage', () => {
    // The cap is the width the *reader* needs, not a share of the window. A
    // percentage is a guess; this is the thing that was actually being
    // protected, and naming it is what makes the rule checkable: at any window
    // width, sidebar + reading column never exceeds the window.
    //
    // Both sides must read the *same token*. Two files that each spell out
    // `calc(measure + 2 * gutter)` agree until one of them is edited.
    const width = rule(SIDEBAR, '.sidebar').get('width') ?? '';
    expect(width).toMatch(/var\(--vela-reading-column\)/u);
    expect(rule(CONVERSATION, '.column').get('max-width')).toBe('var(--vela-reading-column)');

    const palette = paletteFor('light');
    expect(
      lengthPx('var(--vela-reading-column)', palette),
      'the column is the measure plus a gutter on each side',
    ).toBe(
      lengthPx('var(--vela-measure)', palette) + 2 * lengthPx('var(--vela-gutter)', palette),
    );
  });

  it('hands the user’s chosen width to CSS as a ceiling, not as the answer', () => {
    // The stored width is what the user dragged to. It stops being the final
    // word the moment the window is too narrow to honour it, and only CSS knows
    // how wide the window is.
    expect(SIDEBAR_TSX).not.toMatch(/style=\{\{\s*width:/u);
    expect(SIDEBAR_TSX).toMatch(/'--vela-sidebar-width'/u);
  });
});
