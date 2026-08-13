/**
 * THE PLATFORM'S DEFAULTS — what the OS paints when Vela has not said otherwise,
 * and what the layout does when the OS shrinks the window under it.
 *
 * Everything here was measured on real Windows 11 + WebView2 by the desktop
 * session. None of it reproduces on this container's engine, which is exactly
 * why the checks below are about *the stylesheet's rules* rather than about
 * pixels: a rule is true in every engine, and the pixels are the desktop
 * session's verdict to give.
 *
 * ## 1. The white scrollbar
 *
 * `color-scheme: light dark` was declared on bare `:root` and narrowed in
 * neither dark block; there was no scrollbar styling anywhere in `src/`. So the
 * palette followed the user's choice and the user agent's widgets followed the
 * OS, and on a machine whose OS is light with Vela set to dark they disagreed:
 * Windows painted its legacy scrollbar — white trough, grey arrow buttons —
 * down the side of a dark application. The invariant below is not "say dark
 * somewhere". It is: **for all three theme states and both OS preferences, the
 * scheme the UA paints is the scheme the palette selected.** That is six cases,
 * and the old sheet failed two of them.
 *
 * ### The fourth declaration site, which this file used to say did not exist
 *
 * This comment said the widened value was declared *once*. It is declared in two
 * places, and the integration wave found the second: `index.html` still carries
 * `<meta name="color-scheme" content="light dark">`, which is a document-level
 * declaration of the very value the token sheet exists to overrule, in a file
 * nothing under `src/styles/` reads.
 *
 * **It is inert, and that was measured rather than reasoned.** Two independent
 * readings in real Chromium against the built bundle:
 *
 * - `tests/harness/production-bundle/drive-display-scaling.mjs` already reports
 *   the *used* `color-scheme` for all six states with that meta in the page:
 *   system/light-OS `light`, system/dark-OS `dark`, forced-light/dark-OS
 *   `light`, forced-dark/light-OS `dark`. The palette and the widgets agree in
 *   every one.
 * - A counterfactual, run twice over the same bundle with the meta present and
 *   with it deleted from the served HTML: all twelve readings are pairwise
 *   identical. Transcript:
 *   `docs/regression-baseline/platform-defaults/meta-color-scheme-control.txt`.
 *
 * The reason is the cascade: an author declaration on the root element outranks
 * the metadata, and after this fix there is one in every state. So the meta is
 * overruled *because* the rule below holds — which is exactly why the assertion
 * that ties them together lives here, in the file that holds the rule. Delete
 * the `:root` declaration and the meta silently takes over, restoring the
 * defect; the assertion `an author declaration outranks the metadata in
 * index.html` fails first.
 *
 * ## 2. 150% display scaling
 *
 * The default on most Windows 11 laptops. It does not shrink the app's CSS
 * pixel — it shrinks *the desktop*: a 1920×1080 panel at 150% is a 1280×720
 * work area in CSS px, and a 1366×768 one is 911×512. The window Vela asks for
 * (1180×780, `tauri.conf.json`) does not fit in either, so the OS gives it what
 * is left, and the conversation's empty state was clipped: the mark disappeared
 * and the heading jammed against the header rule.
 *
 * **The cause was measured, not guessed, and it was not the first guess.** The
 * shape of the defect points straight at `justify-content: center` in a flex
 * column that has run out of room — but driving the real bundle at those
 * viewports showed the empty state was reachable and the *resting scroll
 * position* was wrong: the transcript pinned itself to the bottom on every
 * commit, including the one that renders an empty conversation, so a state
 * taller than its container opened scrolled past its own first line. At
 * 1280×672 the surface rested at `scrollTop: 104` with the mark 21px above the
 * top edge; at 911×464 it rested at 352 with the mark 269px above it. That fix
 * lives in `scroll.ts` (`restingScrollTop`) and is measured by
 * `tests/harness/production-bundle/drive-display-scaling.mjs`.
 *
 * What the rules below add is the neighbouring guarantee, which is a different
 * one: a centred column that is *compressed* rather than scrolled distributes
 * its negative free space to both ends, and the overflow above the start edge
 * is then unreachable by any gesture. `safe center` centres until it cannot and
 * then aligns to start. Every centred column in the app is held to that, and
 * every capped height to a cap that knows how tall the window is.
 *
 * ## 3. One inset in the model picker
 *
 * Its empty message sat 20px from the popover edge, its rows 12px and its footer
 * actions 12px. Three answers to one question, in one 24rem-wide popover.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const SRC_ROOT = join(REPO_ROOT, 'src');
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8');

const TOKENS = read('src/styles/tokens.css');
const BASE = read('src/styles/base.css');

/* -------------------------------------------------------------------------- */
/* 1. the widget scheme and the palette are chosen by the same rule            */
/* -------------------------------------------------------------------------- */

/** The three blocks the token sheet declares, in cascade order. */
function themeBlocks(): { base: string; byPreference: string; byChoice: string } {
  const media = TOKENS.indexOf('@media (prefers-color-scheme: dark)');
  const explicit = TOKENS.indexOf(":root[data-theme='dark']");
  expect(media, 'the token sheet was restructured; fix this slice').toBeGreaterThan(0);
  expect(explicit).toBeGreaterThan(media);
  return {
    base: TOKENS.slice(0, media),
    byPreference: TOKENS.slice(media, explicit),
    byChoice: TOKENS.slice(explicit),
  };
}

type ThemeChoice = 'system' | 'light' | 'dark';
type Scheme = 'light' | 'dark';

/**
 * Which of the three blocks apply, in cascade order, for one state of the world.
 *
 * `system` is `applyThemePreference` removing the attribute (`theme-store.ts`),
 * so the media block's `:root:not([data-theme='light'])` matches. Under an
 * explicit dark choice both dark blocks match and the later one wins — they are
 * the same specificity, which is why `design-system.test.ts` insists the two
 * stay in step.
 */
function applicableBlocks(choice: ThemeChoice, osPrefersDark: boolean): string[] {
  const { base, byPreference, byChoice } = themeBlocks();
  const blocks = [base];
  if (osPrefersDark && choice !== 'light') blocks.push(byPreference);
  if (choice === 'dark') blocks.push(byChoice);
  return blocks;
}

/** The last declaration of a property among the blocks that apply. */
function lastDeclaration(blocks: readonly string[], property: string): string | null {
  let value: string | null = null;
  for (const block of blocks) {
    for (const match of block.matchAll(new RegExp(`^\\s*${property}:\\s*([^;]+);`, 'gmu'))) {
      value = (match[1] ?? '').trim();
    }
  }
  return value;
}

/** Which palette the cascade selected, read off the one token everything sits on. */
function paletteOf(blocks: readonly string[]): Scheme {
  const bg = lastDeclaration(blocks, '--vela-bg');
  expect(bg, 'the page has to have a background').not.toBeNull();
  // The ramp is monotonic, so the step number is enough — no colour maths
  // needed to say which end of it the page is at.
  const step = Number.parseInt(/--vela-night-(\d+)/u.exec(bg ?? '')?.[1] ?? '', 10);
  expect(Number.isFinite(step), `--vela-bg is not a night-ramp step: ${String(bg)}`).toBe(true);
  return step >= 500 ? 'dark' : 'light';
}

/** What the user agent paints, given the declaration and the OS preference. */
function widgetSchemeOf(blocks: readonly string[], osPrefersDark: boolean): Scheme {
  const declared = lastDeclaration(blocks, 'color-scheme') ?? 'normal';
  const keywords = declared.split(/\s+/u).filter((word) => word === 'light' || word === 'dark');
  if (keywords.length === 0) return 'light'; // `normal` is the light UA default
  // Both keywords listed = the UA picks, and the UA picks by the OS preference.
  if (keywords.length > 1) return osPrefersDark ? 'dark' : 'light';
  return keywords[0] as Scheme;
}

const THEME_STATES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

describe('the OS never paints a widget in the theme the app is not in', () => {
  for (const choice of THEME_STATES) {
    for (const osPrefersDark of [false, true]) {
      it(`holds with theme=${choice} and an OS that prefers ${osPrefersDark ? 'dark' : 'light'}`, () => {
        const blocks = applicableBlocks(choice, osPrefersDark);
        const palette = paletteOf(blocks);
        const widgets = widgetSchemeOf(blocks, osPrefersDark);
        expect(
          widgets,
          `the palette is ${palette} and the user agent would paint its widgets ${widgets} — ` +
            'that is a white Windows scrollbar down a dark app, or the reverse',
        ).toBe(palette);
      });
    }
  }

  it('states a scheme in every block rather than letting the OS choose', () => {
    // The narrower form of the same rule, so a failure points at the file. A
    // block that declares `light dark` passes nothing above by accident: it
    // resolves to the OS preference, which is the thing being overruled.
    const { base, byPreference, byChoice } = themeBlocks();
    expect(lastDeclaration([base], 'color-scheme')).toBe('light');
    expect(lastDeclaration([byPreference], 'color-scheme')).toBe('dark');
    expect(lastDeclaration([byChoice], 'color-scheme')).toBe('dark');
  });

  it('an author declaration outranks the metadata in index.html', () => {
    // `index.html` declares `color-scheme: light dark` as document metadata. It
    // is overruled in every state — measured, see the header — but only because
    // an author declaration on the root element exists to overrule it. That is
    // a *conditional* inertness, and this is the condition, asserted rather
    // than trusted: bare `:root` must carry the declaration, since that is the
    // one block that applies in all six states.
    const html = read('index.html');
    const meta = /<meta\s+name=["']color-scheme["']\s+content=["']([^"']+)["']/u.exec(html);
    if (meta === null) return; // Removing it is also a fix; nothing to hold down.
    expect(
      lastDeclaration([themeBlocks().base], 'color-scheme'),
      `index.html declares color-scheme "${meta[1] ?? ''}" at document level. With no author ` +
        'declaration on :root to outrank it, the user agent picks its widget scheme by the OS ' +
        'preference again and the white scrollbar comes back on a dark app.',
    ).toBe('light');
  });

  it('reads the cascade rather than the file', () => {
    // The control. If `applicableBlocks` returned the same list every time, all
    // six cases above would agree trivially.
    expect(applicableBlocks('system', false)).toHaveLength(1);
    expect(applicableBlocks('system', true)).toHaveLength(2);
    expect(applicableBlocks('light', true)).toHaveLength(1);
    expect(applicableBlocks('dark', false)).toHaveLength(2);
    expect(applicableBlocks('dark', true)).toHaveLength(3);
    expect(paletteOf(applicableBlocks('system', false))).toBe('light');
    expect(paletteOf(applicableBlocks('dark', false))).toBe('dark');
    expect(widgetSchemeOf(['color-scheme: light dark;'], true)).toBe('dark');
    expect(widgetSchemeOf(['color-scheme: light dark;'], false)).toBe('light');
    expect(widgetSchemeOf(['color-scheme: dark;'], false)).toBe('dark');
    expect(widgetSchemeOf([''], true)).toBe('light');
  });
});

describe('Vela draws its own scrollbar', () => {
  it('styles the scrollbar at all', () => {
    // There was none. Not "a weak one" — none, in any file under src/.
    expect(BASE).toMatch(/::-webkit-scrollbar\s*\{/u);
    expect(BASE).toMatch(/::-webkit-scrollbar-thumb\s*\{/u);
  });

  it('removes the legacy arrow buttons', () => {
    // The visible half of the defect: two grey stepper buttons at the ends of a
    // white trough. Nothing else in this app has a stepper button.
    const rule = /::-webkit-scrollbar-button\s*\{([^}]*)\}/u.exec(BASE)?.[1] ?? '';
    expect(rule, 'the arrow buttons are drawn unless a rule removes them').toMatch(
      /display:\s*none/u,
    );
  });

  it('draws it from tokens, so both themes get an answer', () => {
    const thumb = /::-webkit-scrollbar-thumb\s*\{([^}]*)\}/u.exec(BASE)?.[1] ?? '';
    expect(thumb).toMatch(/background:\s*var\(--vela-scrollbar-thumb\)/u);
    expect(BASE).toMatch(/::-webkit-scrollbar-thumb:hover/u);
    for (const token of [
      '--vela-scrollbar-thumb',
      '--vela-scrollbar-thumb-hover',
      '--vela-scrollbar-track',
      '--vela-scrollbar-size',
    ]) {
      expect(TOKENS.includes(`${token}:`), `${token} is not defined`).toBe(true);
    }
    // And the colours are re-authored for dark, like every other colour role.
    const { byPreference, byChoice } = themeBlocks();
    for (const block of [byPreference, byChoice]) {
      expect(block).toMatch(/--vela-scrollbar-thumb:/u);
      expect(block).toMatch(/--vela-scrollbar-thumb-hover:/u);
    }
  });

  it('does not set the standard properties that would disable all of it', () => {
    // In Chromium — which is WebView2 — setting `scrollbar-width` or
    // `scrollbar-color` on a scroller makes the engine ignore every
    // `::-webkit-scrollbar-*` rule for it, arrow buttons included. The two
    // mechanisms do not compose, and only one of them can delete a button.
    const sheets = [BASE, TOKENS, ...moduleStylesheets().map(({ text }) => text)];
    const offenders = sheets.filter((text) => /\bscrollbar-(color|width)\s*:/u.test(text));
    expect(offenders, 'this silently restores the platform scrollbar in WebView2').toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. 150% display scaling                                                     */
/* -------------------------------------------------------------------------- */

interface Sheet {
  readonly name: string;
  readonly text: string;
}

function moduleStylesheets(directory: string = SRC_ROOT): Sheet[] {
  const found: Sheet[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...moduleStylesheets(path));
    else if (entry.name.endsWith('.module.css')) {
      found.push({
        name: relative(REPO_ROOT, path),
        text: readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, ''),
      });
    }
  }
  return found;
}

const SHEETS = moduleStylesheets();

interface Rule {
  readonly sheet: string;
  readonly selector: string;
  readonly body: string;
}

function rules(): Rule[] {
  return SHEETS.flatMap(({ name, text }) =>
    [...text.matchAll(/([^{}]+)\{([^}]*)\}/gu)].map((match) => ({
      sheet: name,
      selector: (match[1] ?? '').trim().replace(/\s+/gu, ' '),
      body: match[2] ?? '',
    })),
  );
}

const RULES = rules();

/**
 * The window Vela actually gets, in CSS pixels, on the machines this defect was
 * measured on. 150% scaling does not shrink the CSS pixel; it shrinks the
 * desktop, and the window is then capped by what is left of it.
 *
 * Windows 11's taskbar is 48 CSS px tall at every scale factor, and
 * `tauri.conf.json` asks for 1180×780 with `decorations: false`, so the whole
 * window is viewport.
 */
const SCALED_VIEWPORTS: readonly { label: string; width: number; height: number }[] = [
  { label: '1920×1080 at 150%', width: 1280, height: 720 - 48 },
  { label: '1600×900 at 150%', width: 1066, height: 600 - 48 },
  // Below Vela's own configured minHeight of 520 — the window cannot fit the
  // work area on this panel at all, which is worth knowing separately, and is
  // recorded for the desktop session. The layout still has to survive it.
  { label: '1366×768 at 150%', width: 911, height: 512 - 48 },
];

/** A length in CSS px at a given viewport. Understands rem, vh, vw, min/max, calc. */
function lengthPx(value: string, viewport: { width: number; height: number }): number {
  const source = value.trim();
  let at = 0;
  const tokens =
    source.match(/min\(|max\(|calc\(|\d*\.?\d+(?:px|rem|em|vh|vw|%)?|[+\-*/(),]/gu) ?? [];

  const primary = (): number => {
    const token = tokens[at];
    at += 1;
    if (token === 'min(' || token === 'max(') {
      const args: number[] = [sum()];
      while (tokens[at] === ',') {
        at += 1;
        args.push(sum());
      }
      at += 1; // ')'
      return token === 'min(' ? Math.min(...args) : Math.max(...args);
    }
    if (token === 'calc(' || token === '(') {
      const inner = sum();
      at += 1; // ')'
      return inner;
    }
    if (token === '-') return -primary();
    if (token === undefined) throw new Error(`unreadable length: ${value}`);
    const number = Number.parseFloat(token);
    if (token.endsWith('rem') || token.endsWith('em')) return number * 16;
    if (token.endsWith('vh')) return (number * viewport.height) / 100;
    if (token.endsWith('vw')) return (number * viewport.width) / 100;
    return number;
  };
  const product = (): number => {
    let left = primary();
    while (tokens[at] === '*' || tokens[at] === '/') {
      const operator = tokens[at];
      at += 1;
      const right = primary();
      left = operator === '*' ? left * right : left / right;
    }
    return left;
  };
  function sum(): number {
    let left = product();
    while (tokens[at] === '+' || tokens[at] === '-') {
      const operator = tokens[at];
      at += 1;
      const right = product();
      left = operator === '+' ? left + right : left - right;
    }
    return left;
  }
  return sum();
}

describe('the layout survives 150% display scaling', () => {
  it('never centres a column in a way that puts content above the top edge', () => {
    // `justify-content: center` on a column that has overflowed pushes the first
    // child off the top, where no scroll can reach it — which is precisely what
    // "the Vela mark disappears and the heading jams against the header rule"
    // looks like. `safe center` centres until it cannot, then aligns to start.
    // `place-items: center` on a grid is the same trap with a different name.
    const unsafe = RULES.filter(
      ({ body }) =>
        (/flex-direction:\s*column/u.test(body) || /display:\s*grid/u.test(body)) &&
        /(justify-content|align-items|place-items):\s*[a-z]*\s*center/u.test(body) &&
        // The safe keyword is declared *after* the plain one, so an engine that
        // does not know it still centres; finding it anywhere in the rule is
        // therefore what "this rule was thought about" looks like.
        !/(justify-content|align-items|place-items):\s*safe\s+center/u.test(body) &&
        // A box with a fixed height cannot overflow its own content off-screen:
        // the glyph buttons and the 56px mark are centred inside a known square.
        !/\bheight:\s*var\(--vela-(control|thumb|mark)/u.test(body),
    ).map(({ sheet, selector }) => `${sheet} — ${selector}`);

    expect(unsafe, 'centre with `safe center`, or the overflow is unreachable').toEqual([]);
  });

  it('caps no surface at a height the window may not have', () => {
    // Two rules, and the first is the one that matters: a cap must *read the
    // viewport*, because a cap written as a constant was written for the machine
    // it was written on. 320px is 41% of Vela's configured window and 69% of the
    // same laptop's window at 150% scaling.
    //
    // The second is a ceiling on the result: no single surface may take more
    // than 60% of the smallest window this defect was measured on. The command
    // palette sits at exactly 60vh and is deliberately the largest thing on
    // screen when it is open; anything above that is a surface that has stopped
    // sharing the window.
    const offenders: string[] = [];
    for (const { sheet, selector, body } of RULES) {
      const declared = /max-height:\s*([^;]+)/u.exec(body)?.[1]?.trim();
      if (declared === undefined || declared === 'none') continue;
      if (!/vh\b/u.test(declared)) {
        offenders.push(`${sheet} — ${selector} — max-height: ${declared} does not read the viewport`);
        continue;
      }
      for (const viewport of SCALED_VIEWPORTS) {
        const resolved = lengthPx(declared, viewport);
        if (resolved > viewport.height * 0.6 + 0.5) {
          offenders.push(
            `${sheet} — ${selector} — max-height: ${declared} is ${Math.round(resolved)}px of a ${String(viewport.height)}px window (${viewport.label})`,
          );
        }
      }
    }
    expect(offenders, 'clamp it against the viewport: min(<length>, <n>vh)').toEqual([]);
  });

  /* THE ASSERTION THAT WAS HERE, AND WHY IT IS GONE.
   *
   * It read `.scroller`'s `scrollbar-gutter` and required the literal string
   * `stable both-edges`. It was green, and it was worse than nothing: that
   * declaration had just regressed the reading ruler by 24px at every window
   * narrow enough for the transcript column to stop reaching its measure, and
   * this test made correcting it fail a passing test. A test that pins a
   * defect in place is a defect.
   *
   * The property it was reaching for is geometric — do the transcript's text
   * and the composer's box have the same width and the same edges, with a
   * scrollbar in the picture — and a string cannot answer that in either
   * direction: it passes on the broken tree and fails on any repair that
   * reserves the gutter another way.
   *
   * It is enforced, in the two places that measure rather than read:
   *   - `src/styles/surfaces.test.ts`, "one vertical ruler at every window
   *     width, not only at the wide one" — the same geometry computed from
   *     these stylesheets at seven windows, with a control that reproduces the
   *     regression's own numbers;
   *   - `tests/harness/production-bundle/drive-display-scaling.mjs`, the `R…`
   *     sweep — the two boxes' left edges, right edges and widths read out of a
   *     real engine at 1440 / 960 / 880 with the sidebar at its maximum, plus
   *     `D…-h`, and the Phase C matrix's `C29a`/`C29b`/`C30`.
   * Both exist and both fail on the tree this comment replaced. */

  it('lets the transcript scroll rather than clip', () => {
    // The other half: safe centring only helps if the overflow lands somewhere
    // scrollable. This is the container the empty state lives in.
    const conversation = read('src/features/conversation/ConversationView.module.css');
    expect(conversation).toMatch(/\.scroller\s*\{[^}]*overflow-y:\s*auto/u);
    expect(conversation).toMatch(/\.scroller\s*\{[^}]*min-height:\s*0/u);
  });

  it('reads lengths the way an engine at that viewport would', () => {
    // The control for the evaluator: a resolver that returned 0 would find no
    // offenders and the check above would pass on any stylesheet at all.
    const viewport = { width: 1000, height: 500 };
    expect(lengthPx('320px', viewport)).toBe(320);
    expect(lengthPx('20rem', viewport)).toBe(320);
    expect(lengthPx('60vh', viewport)).toBe(300);
    expect(lengthPx('min(320px, 30vh)', viewport)).toBe(150);
    expect(lengthPx('max(200px, 30vh)', viewport)).toBe(200);
    expect(lengthPx('calc(100vh - 40px)', viewport)).toBe(460);
    expect(lengthPx('min(20rem, calc(50vh - 20px))', viewport)).toBe(230);
    // And the scan has rules to scan.
    expect(RULES.length).toBeGreaterThan(200);
    expect(RULES.some(({ body }) => /max-height:/u.test(body))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. one inset in the model picker                                            */
/* -------------------------------------------------------------------------- */

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

/** `padding: a b c d` → the inline (left/right) component, in px. */
function inlinePadding(shorthand: string): number {
  const parts = shorthand.split(/\s+(?![^(]*\))/u).filter((part) => part.length > 0);
  const inline = (parts.length === 1 ? parts[0] : parts[1]) ?? '0';
  return lengthPx(inline.replace(/var\((--vela-space-\d)\)/gu, (whole, name: string) => {
    const declared = new RegExp(`${name}:\\s*([^;]+);`, 'u').exec(TOKENS)?.[1];
    return declared ?? whole;
  }), { width: 1000, height: 1000 });
}

function declarationsOf(sheet: string, selector: string): Map<string, string> {
  const text = read(sheet).replace(/\/\*[\s\S]*?\*\//gu, '');
  const pattern = new RegExp(`(^|\\})\\s*${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'mu');
  const body = pattern.exec(text)?.[2];
  expect(body, `no rule for ${selector} in ${sheet}`).toBeDefined();
  const out = new Map<string, string>();
  for (const line of (body ?? '').split(';')) {
    const at = line.indexOf(':');
    if (at > 0) out.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return out;
}

describe('the model picker has one inset, not three', () => {
  const SHEET = 'src/features/models/ModelSwitcher.module.css';

  it('starts every line of the popover on the same left edge', () => {
    // Measured from the popover's own inner edge, which is what a reader sees:
    // the list's padding plus whatever the item inside it adds. It was 20px for
    // the empty message, 12px for a row and 12px for a footer action — one of
    // the three answering the question differently.
    const list = inlinePadding(declarationsOf(SHEET, '.list').get('padding') ?? '0');
    const emptyMessage = list + inlinePadding(declarationsOf(SHEET, '.empty').get('padding') ?? '0');
    const row = list + inlinePadding(declarationsOf(SHEET, '.option').get('padding') ?? '0');
    const footerAction = inlinePadding(declarationsOf(SHEET, '.footerAction').get('padding') ?? '0');

    expect(
      { emptyMessage, row, footerAction },
      'three insets in one 24rem popover reads as a rendering fault',
    ).toEqual({ emptyMessage: row, row, footerAction: row });
  });

  it('measures padding rather than guessing it', () => {
    // The control: a reader that returned a constant would make the three agree.
    expect(inlinePadding('var(--vela-space-2) var(--vela-space-3)')).toBe(12);
    expect(inlinePadding('var(--vela-space-4)')).toBe(16);
    expect(inlinePadding('var(--vela-space-1)')).toBe(4);
  });
});
