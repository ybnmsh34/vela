/**
 * THE TYPEFACE IS SHIPPED, AND IT IS CONNECTED.
 *
 * `--vela-font-sans` led with `'Inter'` and `--vela-font-mono` with
 * `'JetBrains Mono'` from the day the token sheet was written, and for every
 * one of those days the repository contained no `@font-face`, no font file and
 * no font package. On Windows the product therefore shipped as Segoe UI and
 * Consolas: a design authored against metrics the machine did not have.
 * `--vela-tracking-tight: -0.01em` is annotated in `tokens.css` as a correction
 * for Inter's set widths and was being applied to a face that is not Inter.
 *
 * That is this project's recurring defect wearing a stylesheet: a thing named
 * in one file and shipped by no other. It survived every test the tree had,
 * because every test the tree had read the *name*.
 *
 * ## Why a static test at all, when the real check is a width probe
 *
 * The binding measurement is an advance-width comparison in a real engine —
 * `tests/harness/production-bundle/drive-app-root.mjs`, assertions P17–P20,
 * which render a probe string in the requested family and in a deliberately
 * absent one and compare. Nothing short of a layout engine can answer "did this
 * font load"; `document.fonts.check('16px Inter')` returns **true** on a Windows
 * machine with no Inter on it, which is how this defect stayed invisible.
 *
 * But that harness needs Playwright and a built `dist/`, so it is a gate script
 * and not part of `pnpm verify`. This file is the part that runs in CI on every
 * push. It cannot measure a glyph, so it does not pretend to: it checks the
 * chain of custody the width probe depends on — the family the stack asks for
 * is declared by an `@font-face` that is reachable from the app's own entry
 * point, whose `src` is a file that exists in this repository, and which is
 * fetched from nowhere.
 *
 * A regression that this file passes and the width probe catches is possible.
 * A regression that neither catches is the one that already happened.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const SRC_ROOT = join(REPO_ROOT, 'src');

/* -------------------------------------------------------------------------- */
/* the CSS graph, walked from the app's entry point                           */
/* -------------------------------------------------------------------------- */

/**
 * Resolves an `@import` specifier the way Vite does: relative to the importing
 * file, or — for a bare specifier — out of `node_modules`. The bare case is the
 * one that matters, because a bundled typeface arrives as a package.
 */
function resolveImport(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith('.') || isAbsolute(specifier)) {
    const path = resolve(dirname(fromFile), specifier);
    return existsSync(path) ? path : null;
  }
  // Bare specifier. pnpm links the package into the top-level node_modules, so
  // one level of lookup is enough; the link is followed by the filesystem.
  const path = join(REPO_ROOT, 'node_modules', specifier);
  return existsSync(path) ? path : null;
}

/** Every `@import` target in a stylesheet, in source order. */
function importsOf(css: string): string[] {
  return [...css.matchAll(/@import\s+(?:url\()?\s*['"]([^'"]+)['"]\s*\)?\s*;/g)].map(
    (match) => match[1] ?? '',
  );
}

/**
 * The stylesheet the shipping entry point imports. Read out of `main.tsx`
 * rather than hardcoded: a fix that adds an `@font-face` to a sheet nothing
 * imports is the exact defect this file exists to catch, and hardcoding the
 * root would hide it.
 */
function entryStylesheet(): string {
  const main = readFileSync(join(SRC_ROOT, 'main.tsx'), 'utf8');
  const found = [...main.matchAll(/import\s+['"]([^'"]+\.css)['"]/g)].map((m) => m[1] ?? '');
  expect(found, 'src/main.tsx must import exactly one stylesheet').toHaveLength(1);
  const path = resolveImport(found[0] ?? '', join(SRC_ROOT, 'main.tsx'));
  expect(path, `src/main.tsx imports ${found[0]}, which does not exist`).not.toBeNull();
  return path as string;
}

interface Sheet {
  path: string;
  text: string;
}

/** The transitive closure of `@import` from the entry stylesheet. */
function reachableStylesheets(): Sheet[] {
  const seen = new Set<string>();
  const out: Sheet[] = [];
  const queue = [entryStylesheet()];
  while (queue.length > 0) {
    const path = queue.shift() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    const text = readFileSync(path, 'utf8');
    out.push({ path, text });
    for (const specifier of importsOf(text)) {
      const next = resolveImport(specifier, path);
      // A specifier that resolves to nothing is reported by the assertion
      // below, not swallowed here.
      if (next !== null) queue.push(next);
      else out.push({ path: `${path} → UNRESOLVED(${specifier})`, text: '' });
    }
  }
  return out;
}

const SHEETS = reachableStylesheets();
const ALL_CSS = SHEETS.map((sheet) => sheet.text).join('\n');
const TOKENS = readFileSync(join(SRC_ROOT, 'styles', 'tokens.css'), 'utf8');

/* -------------------------------------------------------------------------- */
/* what the stacks ask for                                                    */
/* -------------------------------------------------------------------------- */

/** Strips quotes and surrounding space from one family name. */
function unquote(family: string): string {
  return family.trim().replace(/^['"]|['"]$/g, '');
}

/**
 * The value of a font-stack token, flattened. The token sheet wraps the sans
 * stack across lines, so the newlines go first.
 */
function stack(token: string): string[] {
  const match = TOKENS.match(new RegExp(`--${token}:([^;]+);`));
  expect(match, `tokens.css no longer defines --${token}`).not.toBeNull();
  return (match?.[1] ?? '')
    .replace(/\s+/g, ' ')
    .split(',')
    .map(unquote)
    .filter((family) => family.length > 0);
}

const SANS = stack('vela-font-sans');
const MONO = stack('vela-font-mono');

/* -------------------------------------------------------------------------- */
/* what the graph ships                                                       */
/* -------------------------------------------------------------------------- */

interface FontFace {
  sheet: string;
  family: string;
  weight: string;
  urls: string[];
  /** Resolved absolute paths for each `url()`, or null where nothing is there. */
  files: (string | null)[];
}

/** Every `@font-face` rule reachable from the entry point. */
function fontFaces(): FontFace[] {
  const faces: FontFace[] = [];
  for (const { path, text } of SHEETS) {
    for (const block of text.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
      const body = block[1] ?? '';
      const family = unquote((body.match(/font-family:\s*([^;]+);/) ?? [])[1] ?? '');
      const weight = ((body.match(/font-weight:\s*([^;]+);/) ?? [])[1] ?? '400').trim();
      const urls = [...body.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1] ?? '');
      faces.push({
        sheet: path,
        family,
        weight,
        urls,
        files: urls.map((url) => {
          if (/^(https?:)?\/\//.test(url) || url.startsWith('data:')) return null;
          const file = resolve(dirname(path), url.split('?')[0] ?? url);
          return existsSync(file) ? file : null;
        }),
      });
    }
  }
  return faces;
}

const FACES = fontFaces();

/** `100 900` covers 400; `600` covers only 600. */
function weightCovers(declared: string, weight: number): boolean {
  const parts = declared.split(/\s+/).map(Number).filter(Number.isFinite);
  if (parts.length === 0) return false;
  if (parts.length === 1) return parts[0] === weight;
  return (parts[0] as number) <= weight && weight <= (parts[1] as number);
}

/** Every weight the app actually asks for, taken from the tokens themselves. */
const WEIGHTS_IN_USE = [...TOKENS.matchAll(/--vela-weight-[a-z]+:\s*(\d+);/g)].map((m) =>
  Number(m[1]),
);

/* -------------------------------------------------------------------------- */

describe('the typeface the design was authored against is the one that renders', () => {
  it('reaches a real CSS graph from the shipping entry point', () => {
    // A walk that silently found nothing would pass every assertion below.
    expect(SHEETS.length).toBeGreaterThan(1);
    expect(ALL_CSS.length).toBeGreaterThan(1000);
    expect(WEIGHTS_IN_USE).toContain(400);
    expect(WEIGHTS_IN_USE.length).toBeGreaterThan(2);
  });

  it('every @import in the graph resolves to something that exists', () => {
    // An unresolved `@import` is how a bundled font silently stops being
    // bundled: Vite warns, the build succeeds, and the stack falls back.
    expect(
      SHEETS.filter((sheet) => sheet.path.includes('UNRESOLVED')).map((sheet) => sheet.path),
    ).toEqual([]);
  });

  it.each([
    ['--vela-font-sans', SANS],
    ['--vela-font-mono', MONO],
  ])('%s leads with a family this repository actually ships', (token, families) => {
    const requested = families[0] ?? '';
    expect(requested, `${token} is empty`).not.toEqual('');

    const declared = FACES.filter((face) => face.family === requested);
    expect(
      declared.length,
      `${token} asks for "${requested}" first, and no @font-face reachable from ` +
        `src/main.tsx declares it. Reachable families: ` +
        `${JSON.stringify([...new Set(FACES.map((f) => f.family))])}. ` +
        `A font stack naming a family nothing ships is a design authored against ` +
        `a face the user does not have — which is what this file exists to stop.`,
    ).toBeGreaterThan(0);
  });

  it.each([
    ['--vela-font-sans', SANS],
    ['--vela-font-mono', MONO],
  ])('%s covers every weight the tokens ask for', (_token, families) => {
    const requested = families[0] ?? '';
    const declared = FACES.filter((face) => face.family === requested);
    const uncovered = WEIGHTS_IN_USE.filter(
      (weight) => !declared.some((face) => weightCovers(face.weight, weight)),
    );
    expect(
      uncovered,
      `"${requested}" ships ${JSON.stringify(declared.map((f) => f.weight))} but the tokens ` +
        `ask for ${JSON.stringify(WEIGHTS_IN_USE)}. An uncovered weight is drawn by the ` +
        `engine's synthetic emboldening, which is not the face's own cut.`,
    ).toEqual([]);
  });

  it('no font is fetched over the network — offline-first is a posture, not a hope', () => {
    // Vela's first rule. A webfont from a CDN would be an outbound request on
    // first paint, before the user has configured anything at all.
    const remote = FACES.flatMap((face) =>
      face.urls.filter((url) => /^(https?:)?\/\//.test(url)).map((url) => `${face.family} ← ${url}`),
    );
    expect(remote, 'src-tauri/tauri.conf.json declares font-src \'self\' data:').toEqual([]);
    expect(
      [...ALL_CSS.matchAll(/@import\s+(?:url\()?\s*['"](https?:)?\/\//g)].length,
      'an @import of a remote stylesheet is the same request one level up',
    ).toBe(0);
  });

  it('every @font-face src points at a file that is in this checkout', () => {
    const dangling = FACES.flatMap((face) =>
      face.files
        .map((file, index) => (file === null ? `${face.family} ← ${face.urls[index]}` : null))
        .filter((entry): entry is string => entry !== null),
    );
    expect(
      dangling,
      'a src that resolves to nothing produces no error at build time and no glyph at run time',
    ).toEqual([]);
  });

  it('the global sheets read type from the tokens too', () => {
    // `design-system.test.ts` enforces §7 across every `*.module.css`, and that
    // scan cannot see `src/styles/base.css` — which is the one sheet whose
    // declarations every element in the app inherits. It was carrying a bare
    // `line-height: 1.5`: the single most widely inherited typographic value in
    // the product, decided outside the token sheet, invisible to the test whose
    // whole job is to stop exactly that.
    //
    // `tokens.css` is where the answers live and `typeface.css` is where the
    // faces are declared, so both are exempt by definition. Anything else
    // reachable from `main.tsx` and inside `src/` is a global sheet.
    const globals = SHEETS.filter(
      ({ path }) =>
        path.startsWith(SRC_ROOT) &&
        !path.endsWith('tokens.css') &&
        !path.endsWith('typeface.css') &&
        !path.includes('node_modules'),
    );
    expect(globals.length, 'the global sheet went missing from the graph').toBeGreaterThan(0);

    const bare = globals.flatMap(({ path, text }) =>
      text
        .split('\n')
        .map((line, index) => ({ line: line.trim(), number: index + 1 }))
        // The `\s*` sits INSIDE the lookahead. Outside it, the engine
        // backtracks it to zero width and tests the lookahead against the
        // space rather than the value, and the pattern then matches every
        // declaration including the correct ones — the same trap
        // `design-system.test.ts` documents, entered from the other side: there
        // it made a guard blind, here it made one cry wolf on `var(--…)`.
        .filter(({ line }) =>
          /^(line-height|font-size|letter-spacing|font-family|font-weight):(?!\s*(?:var\(|inherit))/.test(
            line,
          ),
        )
        .map(({ line, number }) => `${relative(REPO_ROOT, path)}:${number} — ${line}`),
    );
    expect(bare, 'a type value in a global sheet is inherited by everything and owned by nothing').toEqual(
      [],
    );
  });

  it('the weight budget stays sane', () => {
    // The cheap wrong fix for everything above is `@import` of a package's
    // top-level stylesheet, which declares every weight in every subset —
    // cyrillic, greek, vietnamese, latin-ext — and drags megabytes into a
    // desktop bundle for an interface that is set in Latin.
    const files = [...new Set(FACES.flatMap((face) => face.files))].filter(
      (file): file is string => file !== null,
    );
    const bytes = files.reduce((total, file) => total + statSync(file).size, 0);
    expect(
      bytes,
      `${files.length} font files, ${(bytes / 1024).toFixed(0)} KiB: ` +
        `${JSON.stringify(files.map((file) => relative(REPO_ROOT, file)))}`,
    ).toBeLessThan(256 * 1024);
  });

  it('the scans actually catch the shapes they exist to catch', () => {
    // Each assertion above passes when its pattern stops matching, so the
    // patterns are checked against the real shapes.
    expect(importsOf("@import './tokens.css';")).toEqual(['./tokens.css']);
    expect(importsOf('@import url("@fontsource/x/latin.css");')).toEqual(['@fontsource/x/latin.css']);
    expect(unquote(" 'Inter Variable' ")).toBe('Inter Variable');
    expect(weightCovers('100 900', 700)).toBe(true);
    expect(weightCovers('400', 700)).toBe(false);
    expect(weightCovers('400 600', 700)).toBe(false);
    expect(/^(https?:)?\/\//.test('https://fonts.gstatic.com/s/inter.woff2')).toBe(true);
    expect(/^(https?:)?\/\//.test('./files/inter-latin.woff2')).toBe(false);
    // The global-sheet scan, in both directions. The second and third of these
    // are the ones that catch the misplaced `\s*`: a pattern that flags a
    // correct `var(--…)` declaration is not a stricter guard, it is a broken
    // one, and it fails the sheet it is supposed to bless.
    const bareType =
      /^(line-height|font-size|letter-spacing|font-family|font-weight):(?!\s*(?:var\(|inherit))/;
    expect(bareType.test('line-height: 1.5;')).toBe(true);
    expect(bareType.test('line-height: var(--vela-leading-ui);')).toBe(false);
    expect(bareType.test('font-family: var(--vela-font-sans);')).toBe(false);
    expect(bareType.test('font-size: 15px;')).toBe(true);
    expect(bareType.test('font: inherit;')).toBe(false);
    // And the family match is exact: a stack asking for `Inter` is not served
    // by an `@font-face` for `Inter Variable`. They are two different families
    // to the engine, and a near-miss here is exactly the shape of a fix that
    // looks applied and is not.
    const near = [{ family: 'Inter Variable', weight: '100 900' }];
    expect(near.filter((face) => face.family === 'Inter')).toEqual([]);
    expect(near.filter((face) => face.family === 'Inter Variable')).toHaveLength(1);
  });
});
