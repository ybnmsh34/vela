/**
 * Conventions §7, enforced instead of narrated.
 *
 * > All design tokens live in `src/styles/tokens.css`. A hex code, a `px` radius,
 * > or a bare font stack inside a component file is a review-blocking change.
 *
 * Phase C is the first phase where that rule could actually break at scale. Four
 * builders worked the conversation surface in parallel, and each answered the
 * same typographic questions separately: line height arrived as 1.3, 1.45, 1.5,
 * 1.55, 1.6 and 1.65 for overlapping jobs; a bare icon button arrived at 22px,
 * 24px, 26px, 30px and 32px; the focus ring's offset arrived as 1px, 2px, -1px
 * and -2px; four indicator dots landed on three diameters; and the stacking
 * order was four bare integers written in four files that never saw each other.
 *
 * None of that is visible in a screenshot of any single component, and no test
 * that existed then could see it either — every one of those files was
 * internally consistent. Drift between builders is only visible from above, so
 * this is the check that looks from above.
 *
 * The rule these enforce is *not* "these exact values". It is: the answer to a
 * design question is written once, in `tokens.css`, and every component reads it
 * from there. Adding a step to a scale is fine. Answering the question again,
 * privately, inside a component, is what fails.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const SRC_ROOT = join(REPO_ROOT, 'src');
const TOKENS = readFileSync(join(SRC_ROOT, 'styles', 'tokens.css'), 'utf8');

function moduleStylesheets(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...moduleStylesheets(path));
    else if (entry.name.endsWith('.module.css')) found.push(path);
  }
  return found;
}

const SHEETS = moduleStylesheets(SRC_ROOT).map((path) => ({
  path,
  name: relative(REPO_ROOT, path),
  text: readFileSync(path, 'utf8'),
}));

/** `file:line — the offending declaration`, so a failure names the drift. */
function declarationsMatching(pattern: RegExp): string[] {
  return SHEETS.flatMap(({ name, text }) =>
    text
      .split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => pattern.test(line))
      .map(({ line, number }) => `${name}:${number} — ${line}`),
  );
}

/** Every `--vela-*` custom property the token sheet actually defines. */
function definedTokens(): Set<string> {
  return new Set([...TOKENS.matchAll(/^\s*(--vela-[a-z0-9-]+):/gm)].map((match) => match[1] ?? ''));
}

describe('the design system is one system, not four', () => {
  it('has component stylesheets to check', () => {
    // A guard that silently stopped finding files would pass every assertion
    // below while checking nothing at all.
    expect(SHEETS.length).toBeGreaterThan(20);
  });

  it('no component writes a raw colour', () => {
    // The one rule that was already holding when Phase C landed. Kept here so
    // the whole of §7 reads from one place.
    expect(
      declarationsMatching(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/),
      'a colour belongs in tokens.css, where both themes can define it',
    ).toEqual([]);
  });

  it('no component answers the line-height question for itself', () => {
    expect(
      declarationsMatching(/line-height:\s*[0-9.]/),
      'line height is a --vela-leading-* step; a bare ratio is a fifth opinion',
    ).toEqual([]);
  });

  it('no component answers the letter-spacing question for itself', () => {
    expect(
      declarationsMatching(/letter-spacing:\s*-?[0-9.]/),
      'tracking is a --vela-tracking-* step',
    ).toEqual([]);
  });

  it('the focus ring is drawn one way everywhere', () => {
    // The ring's *offset* is the part that drifted, and it is the part a user
    // notices: a ring that is 1px out on one control and 2px out on the next,
    // in the same toolbar, reads as a rendering bug. There are exactly two
    // correct answers — outside a control, or inset on a full-bleed row whose
    // outward ring the scroll container would clip — and both are tokens.
    expect(
      declarationsMatching(/outline:\s*[0-9]/),
      'draw the ring with var(--vela-focus-ring)',
    ).toEqual([]);
    expect(
      declarationsMatching(/outline-offset:\s*-?[0-9]/),
      'offset is --vela-focus-offset or --vela-focus-offset-inset, and nothing else',
    ).toEqual([]);
  });

  it('the stacking order is decided in one file', () => {
    // A bare z-index is a guess about what else is on screen. Four of them,
    // written independently, are four guesses that happened not to collide yet.
    expect(
      declarationsMatching(/z-index:\s*[0-9]/),
      'layering is a --vela-z-* step, so the whole order is readable at once',
    ).toEqual([]);
  });

  it('no component invents a type size', () => {
    expect(
      declarationsMatching(/font-size:\s*[0-9.]+(px|rem|em)/),
      'type sizes are --vela-text-* steps',
    ).toEqual([]);
  });

  it('no component invents a font stack or a radius', () => {
    // The `\s*` sits *inside* the lookahead deliberately: outside it, the engine
    // backtracks `\s*` to zero width, checks the space instead of the value, and
    // the guard passes on everything it exists to catch.
    expect(
      declarationsMatching(/font-family:(?!\s*var\()/),
      'there are two font stacks and both are tokens',
    ).toEqual([]);
    expect(
      declarationsMatching(/border-radius:\s*[0-9]/),
      'radii are --vela-radius-* steps',
    ).toEqual([]);
  });

  it('elevation is a token, never a hand-rolled shadow', () => {
    expect(
      declarationsMatching(/box-shadow:(?!\s*(?:var\(|none))/),
      'three elevations exist; a fourth written inline will not match either theme',
    ).toEqual([]);
  });

  it('motion has one duration and one easing curve', () => {
    // Conventions §7 again. `prefers-reduced-motion` is honoured globally in
    // base.css by overriding *these*; a hand-written duration escapes that.
    expect(
      declarationsMatching(/transition(-duration|-timing-function)?:\s*[^;]*[0-9]+m?s/),
      'transitions use var(--vela-duration) and var(--vela-ease)',
    ).toEqual([]);
    expect(
      declarationsMatching(/animation:[^;]*\bcubic-bezier\(|animation-timing-function:(?!\s*var\()/),
      'easing is var(--vela-ease)',
    ).toEqual([]);
  });

  it('every token a component reads is one the token sheet defines', () => {
    // The failure this catches is a rename: a token dropped or respelled in
    // tokens.css leaves `var(--vela-gone)` resolving to nothing, which CSS
    // reports by silently dropping the declaration. Nothing throws, no test
    // fails, and the component quietly loses a colour.
    const defined = definedTokens();
    const dangling = SHEETS.flatMap(({ name, text }) =>
      text
        .split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .flatMap(({ line, number }) =>
          [...line.matchAll(/var\((--vela-[a-z0-9-]+)/g)]
            .map((match) => match[1] ?? '')
            .filter((token) => !defined.has(token))
            .map((token) => `${name}:${number} — ${token}`),
        ),
    );
    expect(dangling, 'an undefined custom property fails silently, which is the worst way').toEqual(
      [],
    );
  });

  it('every colour token is defined in the light block before either dark block', () => {
    // Conventions §7: "Never define a colour only inside a dark block." A token
    // that exists only under `prefers-color-scheme: dark` is invisible in light
    // mode and, because CSS drops unresolvable declarations rather than
    // complaining, invisible in the test suite too.
    const light = TOKENS.slice(0, TOKENS.indexOf('@media (prefers-color-scheme: dark)'));
    expect(light.length, 'the token sheet was restructured; fix this slice').toBeGreaterThan(1000);

    const lightTokens = new Set(
      [...light.matchAll(/^\s*(--vela-[a-z0-9-]+):/gm)].map((match) => match[1] ?? ''),
    );
    const darkOnly = [...definedTokens()].filter((token) => !lightTokens.has(token));
    expect(darkOnly, 'define it on bare :root first, then override it in both dark blocks').toEqual(
      [],
    );
  });

  it('the two dark blocks stay in step with each other', () => {
    // Dark is declared twice on purpose — once by system preference, once by
    // explicit choice — so a user who forces dark gets the same result as one
    // who inherits it. Two blocks maintained by hand drift; this is what says
    // so. Phase C touched this sheet heavily, which is exactly when it drifts.
    const media = TOKENS.indexOf('@media (prefers-color-scheme: dark)');
    const explicit = TOKENS.indexOf(":root[data-theme='dark']");
    expect(explicit).toBeGreaterThan(media);

    const names = (block: string): string[] =>
      [...block.matchAll(/^\s*(--vela-[a-z0-9-]+):/gm)].map((match) => match[1] ?? '').sort();

    const byPreference = names(TOKENS.slice(media, explicit));
    const byChoice = names(TOKENS.slice(explicit));
    expect(byPreference.length).toBeGreaterThan(20);
    expect(byChoice, 'an explicit dark choice must produce exactly the inherited dark palette').toEqual(
      byPreference,
    );
  });

  it('the scans actually catch drift', () => {
    // Every assertion above passes when its pattern stops matching, so each
    // pattern is checked against the real shape it exists to catch.
    const fires = (pattern: RegExp, line: string): boolean => pattern.test(line);
    expect(fires(/line-height:\s*[0-9.]/, 'line-height: 1.55;')).toBe(true);
    expect(fires(/line-height:\s*[0-9.]/, 'line-height: var(--vela-leading-ui);')).toBe(false);
    expect(fires(/outline-offset:\s*-?[0-9]/, 'outline-offset: -1px;')).toBe(true);
    expect(fires(/outline-offset:\s*-?[0-9]/, 'outline-offset: var(--vela-focus-offset);')).toBe(
      false,
    );
    expect(fires(/z-index:\s*[0-9]/, 'z-index: 20;')).toBe(true);
    expect(fires(/z-index:\s*[0-9]/, 'z-index: var(--vela-z-popover);')).toBe(false);
    expect(fires(/font-size:\s*[0-9.]+(px|rem|em)/, 'font-size: 9px;')).toBe(true);
    expect(fires(/font-size:\s*[0-9.]+(px|rem|em)/, 'font-size: var(--vela-text-2xs);')).toBe(false);
    expect(fires(/box-shadow:(?!\s*(?:var\(|none))/, 'box-shadow: 0 2px 4px black;')).toBe(true);
    expect(fires(/box-shadow:(?!\s*(?:var\(|none))/, 'box-shadow: var(--vela-shadow-md);')).toBe(
      false,
    );
    expect(fires(/font-family:(?!\s*var\()/, "font-family: 'Inter', sans-serif;")).toBe(true);
    expect(fires(/font-family:(?!\s*var\()/, 'font-family: var(--vela-font-mono);')).toBe(false);
    expect(fires(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/, 'color: #ff0000;')).toBe(true);
    expect(fires(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/, 'color: var(--vela-text);')).toBe(false);
    expect(
      fires(/transition(-duration|-timing-function)?:\s*[^;]*[0-9]+m?s/, 'transition: opacity 200ms;'),
    ).toBe(true);
    expect(
      fires(
        /transition(-duration|-timing-function)?:\s*[^;]*[0-9]+m?s/,
        'transition: opacity var(--vela-duration) var(--vela-ease);',
      ),
    ).toBe(false);
  });
});
