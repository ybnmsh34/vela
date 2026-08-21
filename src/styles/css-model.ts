/**
 * A stylesheet read as **structure**, and a declaration value read as a
 * **value** — for the two contrast guards beside this file.
 *
 * ## Why this is not two regexes
 *
 * `contrast.test.ts` used to find compositions with a pair of regexes:
 *
 *     /(?:^|[^-\w])color:\s*var\((--vela-[a-z0-9-]+)\)/u
 *     /(?:^|[^-\w])background(?:-color)?:\s*[^;]*var\((--vela-[a-z0-9-]+)\)/u
 *
 * over a rule body cut out by a brace counter. Three separate constructions
 * walked past that, and they are three different failures rather than three
 * instances of one:
 *
 * 1. **The value the reader cannot parse.** `background: var(--vela-x, transparent)`
 *    paints `--vela-x`; the capture demands `)` straight after the token name, so
 *    the fallback comma makes the ground unreadable and the rule is treated as
 *    declaring **no** ground. A local custom property —
 *    `--panel-bg: var(--vela-x); background: var(--panel-bg);` — is the same
 *    blindness. Note the asymmetry that made it attractive: spelling the local
 *    `--vela-panel-bg` would have failed loudly as an unknown ground token, so
 *    the *silent* spelling is the one without the prefix.
 * 2. **The forged reading.** A rule ending in a nested
 *    `@supports (background: var(--vela-y)) { … }` had that **prelude** left in
 *    its parent's body by the brace cutter, where the ground regex matched it —
 *    so the guard reported a green measurement of `--vela-y` as the ground of a
 *    rule that declares no background at all. Worse than an omission: a made-up
 *    number that reads like a measurement.
 * 3. **The composition no rule states.** An ancestor declares the ground, a
 *    descendant declares the colour, and no single rule holds both. Nothing in
 *    the CSS *text* can see that one; `painted-contrast.test.tsx` reads it off
 *    the rendered DOM instead, using this file to know what each rule paints.
 *
 * (1) and (2) are fixed here by refusing to guess. The parser knows what a
 * prelude is, so a condition can never be mistaken for a declaration; the value
 * reader expands `var()` with its fallbacks and follows custom properties; and
 * **anything it cannot read is a named failure rather than a skip** — see
 * {@link Paint}'s `unreadable` arm. That last part is the general repair: every
 * one of these escapes was a reader answering "nothing here" for something it
 * could not parse, and a caller treating "nothing here" as "nothing to measure".
 *
 * ## What this file is not
 *
 * It is not a CSS engine. It does not do specificity, cascade order, shorthand
 * expansion beyond a bare colour, or `calc()`. It reads the subset this repo's
 * stylesheets are written in and fails loudly outside it, which is the only
 * honest shape for a guard: the alternative — a partial parser that silently
 * drops what it does not understand — is the defect it was written to remove.
 *
 * The one piece of cascade it does carry is {@link Declaration.important}, and
 * it carries it *outwards* rather than resolving it: importance cannot be
 * ranked by a reader that sees one rule at a time, and dropping it — which this
 * file did until the reader below was asked to rank two rules — turns
 * "I cannot tell which of these wins" into a confident wrong answer.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const REPO_ROOT = process.cwd();
export const SRC_ROOT = join(REPO_ROOT, 'src');

/* -------------------------------------------------------------------------- */
/* the parser                                                                  */
/* -------------------------------------------------------------------------- */

export interface Declaration {
  /** Lower-cased property name, e.g. `background-color`. */
  readonly property: string;
  /** The value exactly as written, whitespace collapsed, without `!important`. */
  readonly value: string;
  /**
   * Whether the declaration carried `!important`.
   *
   * It used to be stripped and forgotten, and that was the same collapse this
   * file exists to remove, one axis over. An important declaration beats every
   * normal one in the author origin *regardless of specificity*, so a reader
   * that cannot see importance will confidently hand its caller the
   * higher-specificity normal declaration and name a colour the engine never
   * paints. Carrying the flag is what lets `painted-contrast.test.tsx`'s
   * cascade sort it above the rules it really does beat.
   */
  readonly important: boolean;
}

export interface Rule {
  /** Repo-relative, forward slashes. */
  readonly file: string;
  /**
   * The selector this block's declarations apply to, whitespace collapsed.
   * Nested selectors are composed with their parent, and a nested at-rule keeps
   * the selector of the rule it sits in — which is what CSS does, and what stops
   * an `@supports` condition from being read as a declaration.
   */
  readonly selector: string;
  /** The at-rule preludes wrapping this block, outermost first. */
  readonly conditions: readonly string[];
  readonly declarations: readonly Declaration[];
}

const BACKSLASH = '\\';

/** Index just past the string literal starting at `start`. */
function skipString(text: string, start: number): number {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length && text[index] !== quote) {
    if (text[index] === BACKSLASH) index += 1;
    index += 1;
  }
  return index + 1;
}

/** Index just past the `(…)` or `[…]` group starting at `start`. */
function skipGroup(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  let index = start;
  while (index < text.length) {
    const character = text[index];
    if (character === '"' || character === "'") {
      index = skipString(text, index);
      continue;
    }
    if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return index;
}

const collapse = (text: string): string => text.trim().replace(/\s+/gu, ' ');

/**
 * The selector a nested block resolves to. `&` is substituted where written;
 * otherwise the nested selector is a descendant of its parent, which is what
 * CSS nesting means.
 */
function composeSelector(parent: string, nested: string): string {
  if (parent === '') return nested;
  if (nested.includes('&')) return collapse(nested.split('&').join(parent));
  return collapse(`${parent} ${nested}`);
}

function toDeclaration(chunk: string): Declaration | null {
  const text = chunk.trim();
  if (text === '' || text.startsWith('@')) return null;
  const colon = text.indexOf(':');
  if (colon < 0) return null;
  const property = text.slice(0, colon).trim().toLowerCase();
  if (property === '') return null;
  const written = collapse(text.slice(colon + 1));
  const value = written.replace(/\s*!important$/iu, '');
  return { property, value, important: value !== written };
}

interface OpenBlock {
  readonly selector: string;
  readonly conditions: readonly string[];
  readonly declarations: Declaration[];
  /** Where the block opened, so rules come back in source order, parent first. */
  readonly opensAt: number;
}

/**
 * Every block of declarations in a stylesheet, with the selector and conditions
 * that reach it.
 *
 * Comments, string literals, `[…]` attribute selectors and `(…)` groups are all
 * skipped as opaque spans, so a `;`, `{` or `}` inside any of them cannot
 * terminate anything. That is not decoration: a `;` inside an attribute selector
 * used to truncate the emitted selector, and an unbalanced brace inside a string
 * would have desynchronised the brace counter for the rest of the file.
 */
export function parseStylesheet(file: string, text: string): readonly Rule[] {
  const rules: (Rule & { readonly opensAt: number })[] = [];
  const open: OpenBlock[] = [];
  let buffer = '';
  let index = 0;

  const flush = (): void => {
    const declaration = toDeclaration(buffer);
    const block = open[open.length - 1];
    if (declaration !== null && block !== undefined) block.declarations.push(declaration);
    buffer = '';
  };

  while (index < text.length) {
    const character = text[index];
    if (character === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end < 0 ? text.length : end + 2;
      continue;
    }
    if (character === '"' || character === "'") {
      const end = skipString(text, index);
      buffer += text.slice(index, end);
      index = end;
      continue;
    }
    if (character === '[' || character === '(') {
      const end = skipGroup(text, index, character, character === '[' ? ']' : ')');
      buffer += text.slice(index, end);
      index = end;
      continue;
    }
    if (character === '{') {
      const prelude = collapse(buffer);
      buffer = '';
      const parent = open[open.length - 1];
      const isAtRule = prelude.startsWith('@');
      open.push({
        selector: isAtRule
          ? (parent?.selector ?? '')
          : composeSelector(parent?.selector ?? '', prelude),
        conditions: isAtRule ? [...(parent?.conditions ?? []), prelude] : (parent?.conditions ?? []),
        declarations: [],
        opensAt: index,
      });
      index += 1;
      continue;
    }
    if (character === '}') {
      flush();
      const block = open.pop();
      if (block !== undefined && block.declarations.length > 0) {
        rules.push({
          file,
          selector: block.selector,
          conditions: block.conditions,
          declarations: block.declarations,
          opensAt: block.opensAt,
        });
      }
      index += 1;
      continue;
    }
    if (character === ';') {
      flush();
      index += 1;
      continue;
    }
    buffer += character;
    index += 1;
  }
  return rules
    .sort((a, b) => a.opensAt - b.opensAt)
    .map(({ file: from, selector, conditions, declarations }) => ({
      file: from,
      selector,
      conditions,
      declarations,
    }));
}

/** A declaration that won inside one rule, with the flag its caller has to rank. */
export interface Won {
  readonly value: string;
  readonly important: boolean;
}

/**
 * The winning declaration of a property in one rule.
 *
 * Within a single rule the later declaration wins — except that an `!important`
 * one is never displaced by a normal one written after it, which is the
 * cascade's importance step applied at the only scope this function can see.
 * Ordering *between* rules is the caller's problem, and is why {@link Won}
 * carries the flag out rather than resolving it here.
 */
export function declaredBy(rule: Rule, ...properties: readonly string[]): Won | undefined {
  let found: Won | undefined;
  for (const declaration of rule.declarations) {
    if (!properties.includes(declaration.property)) continue;
    if (found?.important === true && !declaration.important) continue;
    found = { value: declaration.value, important: declaration.important };
  }
  return found;
}

/** {@link declaredBy} when the caller has no cascade to run. */
export function declaredValue(rule: Rule, ...properties: readonly string[]): string | undefined {
  return declaredBy(rule, ...properties)?.value;
}

/* -------------------------------------------------------------------------- */
/* the sheets                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every stylesheet under `src/`, not merely every `*.module.css`.
 *
 * The narrower list was a hole of its own: `src/styles/typeface.css` ships —
 * `base.css` opens with `@import './typeface.css'` — and no check in either
 * guard could see it, as would be true of any new non-module sheet.
 */
export function stylesheetFiles(directory: string = SRC_ROOT): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...stylesheetFiles(path));
    else if (entry.name.endsWith('.css')) found.push(path);
  }
  return found.sort();
}

export interface Sheet {
  /** Repo-relative, forward slashes. */
  readonly name: string;
  readonly text: string;
  readonly rules: readonly Rule[];
}

export function loadSheets(): readonly Sheet[] {
  return stylesheetFiles().map((path) => {
    const name = relative(REPO_ROOT, path).replace(/\\/gu, '/');
    const text = readFileSync(path, 'utf8');
    return { name, text, rules: parseStylesheet(name, text) };
  });
}

/* -------------------------------------------------------------------------- */
/* colour                                                                      */
/* -------------------------------------------------------------------------- */

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/iu;
const RGB =
  /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+)(%?)\s*)?\)$/iu;

/** `#rgb`, `#rrggbb`, `#rrggbbaa` and `rgb()`/`rgba()` — this sheet's whole syntax. */
export function tryParseColour(css: string): Rgba | null {
  const text = css.trim();
  if (HEX.test(text)) {
    const digits = text.slice(1);
    const wide = digits.length === 3 ? [...digits].map((d) => `${d}${d}`).join('') : digits;
    const byte = (at: number): number => Number.parseInt(wide.slice(at, at + 2), 16);
    return {
      r: byte(0),
      g: byte(2),
      b: byte(4),
      a: wide.length === 8 ? byte(6) / 255 : 1,
    };
  }
  const rgb = RGB.exec(text);
  if (rgb !== null) {
    const raw = rgb[4] === undefined ? 1 : Number.parseFloat(rgb[4]);
    return {
      r: Number.parseFloat(rgb[1] ?? '0'),
      g: Number.parseFloat(rgb[2] ?? '0'),
      b: Number.parseFloat(rgb[3] ?? '0'),
      a: rgb[5] === '%' ? raw / 100 : raw,
    };
  }
  return null;
}

export function parseColour(css: string): Rgba {
  const colour = tryParseColour(css);
  if (colour === null) throw new Error(`not a colour this audit can read: ${css}`);
  return colour;
}

/** Source-over compositing, which is what a translucent fill does to its ground. */
export function composite(top: Rgba, under: Rgba): Rgba {
  if (top.a >= 1) return top;
  const mix = (x: number, y: number): number => x * top.a + y * (1 - top.a);
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a: 1 };
}

/** WCAG 2.x relative luminance. */
export function luminance({ r, g, b }: Rgba): number {
  const channel = (value: number): number => {
    const x = value / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgba, b: Rgba): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
}

/* -------------------------------------------------------------------------- */
/* the token graph                                                             */
/* -------------------------------------------------------------------------- */

export type Theme = 'light' | 'dark';

const TOKEN_SHEET = 'src/styles/tokens.css';

const isDarkRule = (rule: Rule): boolean =>
  rule.conditions.some((condition) => condition.includes('prefers-color-scheme: dark')) ||
  rule.selector.includes("[data-theme='dark']");

/**
 * Every custom property `:root` declares, resolved the way the engine resolves
 * it: light declarations first, then the dark ones on top.
 *
 * Structural rather than a slice of the file's text. The slice it replaces
 * assumed the dark block was the tail of the file and that every `--vela-*` line
 * before it was a light declaration — true today, and an assumption no reader of
 * the token sheet is told about.
 */
export function paletteFor(theme: Theme, sheets: readonly Sheet[]): Map<string, string> {
  const tokens = sheets.find((sheet) => sheet.name === TOKEN_SHEET);
  if (tokens === undefined) throw new Error(`the token sheet moved: ${TOKEN_SHEET} is not there`);
  const palette = new Map<string, string>();
  const take = (rule: Rule): void => {
    for (const { property, value } of rule.declarations) {
      if (property.startsWith('--')) palette.set(property, value);
    }
  };
  const roots = tokens.rules.filter((rule) => rule.selector.startsWith(':root'));
  const light = roots.filter((rule) => !isDarkRule(rule));
  const dark = roots.filter(isDarkRule);
  if (light.length === 0) throw new Error('the token sheet declares no light :root block');
  if (dark.length === 0) throw new Error('the token sheet declares no dark :root block');
  for (const rule of light) take(rule);
  if (theme === 'dark') for (const rule of dark) take(rule);
  return palette;
}

/* -------------------------------------------------------------------------- */
/* reading a declaration value                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What a `color` or `background` declaration paints.
 *
 * `unreadable` is the arm that matters. Every escape this file was written for
 * was a reader answering "no ground here" for a value it could not parse; an
 * arm that says *"there is a value here and I could not read it"* is a different
 * answer, and both guards treat it as a failure with the value quoted.
 */
export type Paint =
  | { readonly kind: 'transparent' }
  | { readonly kind: 'inherit' }
  | { readonly kind: 'currentcolor' }
  | { readonly kind: 'colour'; readonly rgba: Rgba; readonly token: string | null }
  | { readonly kind: 'unreadable'; readonly text: string; readonly why: string };

/** Resolves a custom property name to its declared value, or `undefined`. */
export type Lookup = (name: string) => string | undefined;

interface Expansion {
  readonly text: string;
  /** Custom properties followed, in the order they were entered. */
  readonly followed: readonly string[];
  /** Custom properties with no declaration and no fallback. */
  readonly unresolved: readonly string[];
}

/** Splits `var()`'s arguments at the top-level comma: name, then the fallback. */
function splitVarArguments(inner: string): { name: string; fallback: string | null } {
  let depth = 0;
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (character === ',' && depth === 0) {
      return { name: inner.slice(0, index).trim(), fallback: inner.slice(index + 1).trim() };
    }
  }
  return { name: inner.trim(), fallback: null };
}

/**
 * `var()` expanded the way the engine expands it: the fallback is used when — and
 * only when — the custom property has no declaration.
 */
export function expandVars(value: string, lookup: Lookup, depth = 0): Expansion {
  if (depth > 16) return { text: value, followed: [], unresolved: ['<recursion limit>'] };
  const followed: string[] = [];
  const unresolved: string[] = [];
  let out = '';
  let index = 0;
  while (index < value.length) {
    const at = value.indexOf('var(', index);
    if (at < 0) {
      out += value.slice(index);
      break;
    }
    out += value.slice(index, at);
    const end = skipGroup(value, at + 3, '(', ')');
    const inner = value.slice(at + 4, end - 1);
    const { name, fallback } = splitVarArguments(inner);
    const declared = lookup(name);
    if (declared !== undefined) {
      followed.push(name);
      const nested = expandVars(declared, lookup, depth + 1);
      followed.push(...nested.followed);
      unresolved.push(...nested.unresolved);
      out += nested.text;
    } else if (fallback !== null) {
      const nested = expandVars(fallback, lookup, depth + 1);
      followed.push(...nested.followed);
      unresolved.push(...nested.unresolved);
      out += nested.text;
    } else {
      unresolved.push(name);
      out += `var(${name})`;
    }
    index = end;
  }
  return { text: collapse(out), followed, unresolved };
}

/**
 * Reads one `color` / `background` value.
 *
 * The token reported is the first `--vela-*` custom property the expansion
 * entered, which is the role the rule is asking for however many local aliases
 * it is spelled through.
 */
export function readPaint(value: string, lookup: Lookup): Paint {
  const expansion = expandVars(value, lookup);
  const text = expansion.text.trim();
  const keyword = text.toLowerCase();
  if (expansion.unresolved.length > 0) {
    return {
      kind: 'unreadable',
      text: value,
      why: `no declaration for ${expansion.unresolved.join(', ')}`,
    };
  }
  if (keyword === 'transparent' || keyword === 'none') return { kind: 'transparent' };
  if (keyword === 'inherit') return { kind: 'inherit' };
  if (keyword === 'currentcolor') return { kind: 'currentcolor' };
  const rgba = tryParseColour(text);
  if (rgba === null) {
    return { kind: 'unreadable', text: value, why: `resolves to \`${text}\`, which is not a colour` };
  }
  const token = expansion.followed.find((name) => name.startsWith('--vela-')) ?? null;
  return { kind: 'colour', rgba, token };
}

/** The `--vela-*` role a value asks for, or `null` when it names none. */
export function paintToken(paint: Paint): string | null {
  return paint.kind === 'colour' ? paint.token : null;
}
