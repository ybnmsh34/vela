/**
 * FORCED COLOURS — AND THE QUESTION THAT IS ONE NOTCH WIDER THAN THE OBVIOUS ONE.
 *
 * In a forced-colours mode (Windows High Contrast, and `forced-colors: active`
 * generally) the engine throws away the author's `color`, `background`,
 * `border-color`, `fill`, `stroke` and `box-shadow` and substitutes the user's
 * own small palette. Everything a design says with colour and **only** with
 * colour stops being said.
 *
 * At `run-start-2026-08-17` the string `forced-colors` did not appear in any of
 * the 43 stylesheets under `src/`.
 *
 * ## The scan IS the assertion now
 *
 * The first version of this file scanned for the hazard and then asserted only
 * the three sheets that had been fixed, which reported a shell as covered on
 * the strength of three of its surfaces. {@link colourAloneStateRules} below is
 * the scan, and {@link CARRIED_BY_CONTENT} is the only way out of it: every
 * rule in `src/` whose selector encodes a **persistent** state and whose body
 * declares nothing but colour must either be restated inside a
 * `@media (forced-colors: active)` block in its own sheet, or be named in that
 * list with the content that already says the same thing.
 *
 * A new colour-alone state anywhere under `src/` therefore fails here, which is
 * the thing three hand-written assertions could not do.
 *
 * ## What the scan is deliberately not
 *
 * **Transient states are out.** `:hover`, `:focus`, `:focus-within`,
 * `:focus-visible` and `:active` are excluded: the pointer or the focus ring is
 * itself the signal, and demanding a second one of them would bury the states
 * that are genuinely invisible.
 *
 * That exclusion removes **nothing** from this scan as the tree stands: it is
 * only consulted after {@link ATTRIBUTE_STATE} has matched, and no rule under
 * `src/` carries both an attribute state and a transient pseudo-class, so
 * {@link TRANSIENT} rejects nothing today. An earlier version of this paragraph
 * said "all thirty-odd of them", which was the size of no set here — the set
 * it names is empty, and the wider sets it might have meant were 84 (rules with
 * a transient pseudo-class anywhere) and 43 (those of them declaring nothing
 * but substituted properties), all three counts measured over `src/` at this
 * commit and all three free to move. The paragraph states what the scan is for,
 * and it is written down so that the first rule to combine the two is refused
 * on purpose rather than by accident.
 *
 * **It only sees states spelled as attributes.** `[data-*]` and `[aria-*]`, not
 * a state carried by a class name. `ConversationRow`'s `.selected` is exactly
 * that case — it is the most consequential colour-alone state in the shell,
 * *which conversation is open*, and this scan does not find it. It was found by
 * reading, is fixed, and has its own test below. There is no reason to think it
 * is the only one; a class-name scan is the obvious next widening and it is not
 * in this file.
 *
 * **`border: 1px solid transparent` controls are examined now, and they were the
 * gap.** A forced-colours mode substitutes a border colour but **preserves a
 * fully transparent one**, so a control resting at `border: 1px solid transparent`
 * keeps an invisible border and a `border-style` restatement written on it draws
 * nothing. The rail's `aria-current` cue shipped in exactly that state — the
 * round-6 critic could show that either the cue was inert or the sentence
 * stating the mechanism was false, and no test in the tree could say which.
 * {@link inertBorderRestatements} is the answer, as a law over every sheet:
 * *leaves no forced-colours restatement resting on a border that stays
 * transparent*.
 *
 * ## What this file still says nothing about, stated rather than implied
 *
 * * **Focus rings.** Measured over `src/` at this commit: 35 rules carry
 *   `:focus-visible`, 34 of them draw the ring with `outline`, and **0** reach
 *   for `box-shadow` — which matters because forced colours forces `box-shadow`
 *   to `none` outright, where it merely substitutes an outline's colour. So the
 *   rings survive, by construction rather than by anything asserted here. The
 *   one rule that is neither is `Sidebar.module.css`'s
 *   `.handle:hover::after, .handle:focus-visible::after { opacity: 1 }`: the
 *   drag line is a `::after` with a `background`, revealed by opacity, so forced
 *   colours repaints it in the user's pair and it survives too. All of that is a
 *   count taken today, not a rule this file enforces — nothing here fails on the
 *   first `box-shadow` focus ring somebody writes.
 * * **Icons.** The inline SVG glyph set is not examined. `fill`/`stroke` are in
 *   {@link SUBSTITUTED}, so a glyph drawn with either is repainted rather than
 *   lost, but a glyph carried by a background image or by `opacity` is not
 *   checked by anything.
 * * **`prefers-contrast`.** There is no `prefers-contrast` rule anywhere under
 *   `src/` and this round did not add one. Raising contrast means changing
 *   colour values, and the palette is frozen for this run — so the honest
 *   position is that Vela answers `forced-colors` and does not answer
 *   `prefers-contrast: more`, rather than a rule that pretends to.
 * * **`forced-color-adjust`.** Not used anywhere, and deliberately: it is the
 *   opt-out, for a swatch that must keep its own colour to mean anything. This
 *   track's surfaces have no such swatch. The canvas diff rows come closest and
 *   they carry `+`/`-` prefixes instead, which is the better answer.
 * * **Rendering.** jsdom implements none of this. Every assertion in this file
 *   is a claim about stylesheet source, and 100/125/150% zoom, real High
 *   Contrast themes and the actual painted result remain unmeasured here.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative as relativeTo, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

function sheet(relative: string): string {
  return readFileSync(join(SRC, relative), 'utf8');
}

/** Every stylesheet under `src/`, as paths relative to it, with `/` separators. */
function stylesheets(): readonly string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.css')) found.push(relativeTo(SRC, full).split(sep).join('/'));
    }
  };
  walk(SRC);
  return found.sort();
}

/**
 * The properties a forced-colours mode substitutes, and therefore the ones a
 * distinction may not rest on alone. `opacity` is here because it is not
 * substituted but is the other way a state is said without saying it.
 *
 * The list runs past the six the header names because the forced-colours
 * property list in CSS Color Adjust is longer than six: `outline-color`,
 * `caret-color`, `text-decoration-color`, `accent-color`, `column-rule-color`
 * and `text-emphasis-color` are named there too. Adding them changes nothing
 * about what this scan finds today — the same rules come back with the six as
 * with the twelve, 21 of them measured at this commit — and they are here so
 * that a state first said with one of the other six is found the first time
 * somebody writes one.
 *
 * Read by {@link colourAloneStateRules}, which is its only caller, and asserted
 * by *the vocabulary a restatement may use is the one this file says it is*.
 * That test exists because deleting the six names above changed no test result
 * at all when the round-6 measurer tried it: a list whose only effect is on
 * rules nobody has written yet is a list nothing holds in place.
 */
const SUBSTITUTED =
  /^(color|background|background-color|[a-z-]*border[a-z-]*-color|fill|stroke|box-shadow|opacity|outline-color|caret-color|text-decoration-color|accent-color|column-rule-color|text-emphasis-color)$/u;

/** A state spelled as an attribute. See the header for what this does not see. */
const ATTRIBUTE_STATE = /\[(data-|aria-)[^\]]*\]/u;

/** The pointer and the focus ring are their own signal. */
const TRANSIENT = /:(hover|focus|focus-within|focus-visible|active)\b/u;

/**
 * The properties a forced-colours restatement is allowed to use: the ones the
 * engine leaves alone and that carry no colour of their own.
 *
 * **An allowlist, and that is the correction.** What this replaces was a ban —
 * a restatement failed if its property was one of the twelve {@link SUBSTITUTED}
 * names — over a comment claiming the rule was absolute. It was not: the
 * forced-colors property list in CSS Color Adjust also holds `scrollbar-color`
 * and `-webkit-tap-highlight-color`, and `scrollbar-color: Canvas CanvasText`
 * inside a forced-colours block passed that check, measured green twice by the
 * round-5 critic. A list of what is refused is only ever as complete as its
 * author's memory of the CSS colour property index. A list of what is permitted
 * is complete by construction: a property nobody here thought of is refused
 * because it is not on it, and permitting one is a line in this file with a
 * reviewer's eyes on it.
 *
 * Absences that are decisions rather than oversights:
 *
 * * `outline-color` — `Composer.module.css` leaves it unset on purpose so the
 *   dashed ring inherits `currentColor` and is substituted along with the text.
 * * `opacity` — not substituted, but dimming is the other way a state is said
 *   without saying it, and the header says so. No block reaches for it today.
 * * `forced-color-adjust` — the opt-out. A restatement that disables forced
 *   colours is not a restatement.
 */
const RESTATEMENT_MAY_USE: ReadonlySet<string> = new Set([
  // Border geometry. Style and width survive the substitution; the colour does
  // not, which is why no `border-*-color` spelling is here.
  'border-style',
  'border-top-style',
  'border-right-style',
  'border-bottom-style',
  'border-left-style',
  'border-block-style',
  'border-block-start-style',
  'border-block-end-style',
  'border-inline-style',
  'border-inline-start-style',
  'border-inline-end-style',
  'border-width',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-block-width',
  'border-block-start-width',
  'border-block-end-width',
  'border-inline-width',
  'border-inline-start-width',
  'border-inline-end-width',
  // The ring, less its colour.
  'outline-style',
  'outline-width',
  'outline-offset',
  // Weight, the underline, and a glyph the sheet supplies itself.
  'font-weight',
  'font-style',
  'text-decoration-line',
  'text-decoration-style',
  'text-decoration-thickness',
  'text-underline-offset',
  'text-transform',
  'content',
]);

/**
 * Every border declaration on every rule of `text` whose selector matches
 * `selector`, in source order, as `selector { property: value }` with runs of
 * whitespace collapsed.
 *
 * Comments are stripped first, because the prose around the guards that use
 * this quotes the declarations it is talking about.
 *
 * Three of this function's four filters are guarded by a named test — the
 * comment strip, the selector filter and the `border` prefix each red *keeps a
 * turn's ending apart from an ordinary notice* when removed. The fourth was
 * `if (declaration === '') continue;`, and it is gone rather than pinned: an
 * empty declaration's `split(':')[0]` is `''`, which fails `startsWith('border')`
 * on the very next line, so no input could tell the two versions apart. A
 * branch nothing can distinguish from its own absence is not an unguarded
 * invariant, it is a redundancy, and the honest close for one is deletion.
 */
function borderDeclarationsOf(text: string, selector: RegExp): readonly string[] {
  const found: string[] = [];
  for (const rule of text.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const head = (rule[1] ?? '').trim().split(/\s+/u).join(' ');
    if (!selector.test(head)) continue;
    for (const one of (rule[2] ?? '').split(';')) {
      const declaration = one.trim().split(/\s+/u).join(' ');
      if (!(declaration.split(':')[0] ?? '').trim().startsWith('border')) continue;
      found.push(`${head} { ${declaration} }`);
    }
  }
  return found;
}

/**
 * The value `property` is **last** given, outside the forced-colours blocks, by
 * a rule of `text` whose selector list holds `selector` exactly — or `undefined`
 * when no such rule declares it.
 *
 * Last, because that is what the cascade does between two rules of equal
 * specificity in one sheet, and exactly, because a substring match would let
 * `.title` read `.selected .title`'s value and report a state as restated when
 * it had only restated itself.
 *
 * Read by *keeps the sidebar saying which conversation is open*, which is the
 * guard that used to assert a property NAME appeared in the forced block and so
 * stayed green when the round-6 critic set the restated weight to the exact
 * weight the resting rule already carries.
 */
function declaredValue(text: string, selector: string, property: string): string | undefined {
  let value: string | undefined;
  for (const rule of text.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const heads = (rule[1] ?? '')
      .trim()
      .split(/\s+/u)
      .join(' ')
      .split(',')
      .map((one) => one.trim());
    if (!heads.includes(selector)) continue;
    for (const one of (rule[2] ?? '').split(';')) {
      const declaration = one.trim().split(/\s+/u).join(' ');
      const at = declaration.indexOf(':');
      if (at === -1) continue;
      if (declaration.slice(0, at).trim() !== property) continue;
      value = declaration.slice(at + 1).trim();
    }
  }
  return value;
}

/**
 * The border colour an element matching `selector` rests at, outside the
 * forced-colours blocks.
 *
 * Read from the rule for `selector` itself **and** from the rule for its
 * unqualified base — `.iconButton[aria-current='page']` also takes what
 * `.iconButton` sets — because the `border: 1px solid transparent` that makes a
 * restatement inert is normally written on the base and never repeated on the
 * state. The later of the two wins, which is the cascade for two rules in one
 * sheet where the state's specificity is the higher.
 *
 * The `border` shorthand is read as its last whitespace-separated token, which
 * is where the colour sits in every spelling this tree uses. `undefined` means
 * no rule in the chain says anything about a border colour, and an element with
 * no border at all cannot have an inert one.
 */
function restingBorderColour(text: string, selector: string): string | undefined {
  const base = selector.replace(/\[[^\]]*\]/gu, '').trim();
  const outside = text.replace(
    /@media\s*\(\s*forced-colors\s*:\s*active\s*\)\s*\{[\s\S]*?\n\}/gu,
    '',
  );
  const said: string[] = [];
  for (const from of [base, selector]) {
    const shorthand = declaredValue(outside, from, 'border');
    if (shorthand !== undefined) {
      const parts = shorthand.split(' ');
      const last = parts[parts.length - 1];
      if (last !== undefined) said.push(last);
    }
    const longhand = declaredValue(outside, from, 'border-color');
    if (longhand !== undefined) said.push(longhand);
  }
  return said[said.length - 1];
}

/**
 * Every forced-colours restatement in `text` that leans on a border the mode
 * will not repaint — and therefore says nothing at all.
 *
 * **THE FACT THIS FILE NOW HOLDS IN ONE PLACE.** A forced-colours mode
 * substitutes `border-color`, but it **preserves a fully transparent one**: an
 * element resting at `border: 1px solid transparent` keeps an invisible border
 * in High Contrast, and a `border-style: dashed` restatement on it draws
 * nothing. `Composer.module.css` states that fact and builds its pressed-state
 * reasoning on it; `Sidebar.module.css` shipped a rail cue whose resting border
 * was exactly that transparent one, so the round-6 critic could say only that
 * one of the two was wrong and no test in the tree could say which. This is the
 * test that says which: the fact is now a law over every sheet, the rail's
 * resting border carries a colour that is substituted rather than preserved,
 * and the next restatement written on a transparent border fails here.
 *
 * jsdom does not implement `forced-colors`, so this is still a claim about the
 * source and not about a rendered pixel — stated plainly rather than implied.
 * What it buys is that the claim is made once, in one place, over the whole
 * tree, instead of being a sentence in a stylesheet comment.
 */
function inertBorderRestatements(text: string): readonly string[] {
  const inert: string[] = [];
  for (const rule of forcedColorsBlocks(text).matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const heads = (rule[1] ?? '')
      .trim()
      .split(/\s+/u)
      .join(' ')
      .split(',')
      .map((one) => one.trim());
    const leansOnABorder = (rule[2] ?? '')
      .split(';')
      .some((one) => one.trim().startsWith('border'));
    if (!leansOnABorder) continue;
    for (const head of heads) {
      if (restingBorderColour(text, head) === 'transparent') inert.push(head);
    }
  }
  return inert;
}

interface ColourAloneRule {
  readonly file: string;
  readonly selector: string;
}

/**
 * Every rule of one stylesheet that says a persistent state with nothing but
 * colour — read from **outside** the forced-colours blocks, so a restatement is
 * not mistaken for the thing it restates.
 *
 * A pure function of the text, so its **branches** can be pinned as well as its
 * result. Each of the six `continue`s below is a structural position, and
 * *reads every structural position the scanners in this file branch on* feeds
 * one synthetic sheet carrying all six and asserts the enumerated outcome — so
 * deleting any one of them names the position that stopped being read. Before
 * that test existed, four of the six could be deleted with the whole suite
 * green; the sixth — the forced-colours strip on the line below, the line the
 * "read from outside" sentence above is about — could be broken by pointing its
 * marker at a string no sheet contains, and 551 targeted tests stayed green.
 */
function colourAloneRulesIn(text: string, file: string): readonly ColourAloneRule[] {
  const found: ColourAloneRule[] = [];
  const outside = text
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/@media\s*\(\s*forced-colors\s*:\s*active\s*\)\s*\{[\s\S]*?\n\}/gu, '');
  for (const match of outside.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const selector = (match[1] ?? '').trim().split(/\s+/u).join(' ');
    // An at-rule statement that ends in `;` has no block of its own, so the
    // next selector is glued onto it by the rule pattern above. Five heads in
    // `src/` arrive that way today — four `@font-face` and base.css's two
    // `@import`s in front of `*, *::before, *::after` — and every one of them
    // would also be refused by {@link ATTRIBUTE_STATE}. That is what made this
    // deletable in silence; it stops being so the moment an `@import` sits in
    // front of a selector that does carry a state, which is the fixture case.
    if (selector.startsWith('@')) continue;
    if (!ATTRIBUTE_STATE.test(selector)) continue;
    if (TRANSIENT.test(selector)) continue;
    const declarations = (match[2] ?? '')
      .split(';')
      .map((one) => one.trim())
      .filter((one) => one !== '');
    // An empty body makes `every` below vacuously true, so without this a rule
    // that declares nothing is reported as saying a state with colour alone.
    if (declarations.length === 0) continue;
    if (!declarations.every((one) => SUBSTITUTED.test((one.split(':')[0] ?? '').trim()))) continue;
    found.push({ file, selector });
  }
  return found;
}

/** {@link colourAloneRulesIn}, over every stylesheet under `src/`. */
function colourAloneStateRules(): readonly ColourAloneRule[] {
  return stylesheets().flatMap((file) => colourAloneRulesIn(sheet(file), file));
}

/**
 * What an entry in the escape hatch has to supply: the content that already
 * carries the distinction, the component that draws it, and the text in that
 * component whose removal would take the content away.
 *
 * The third field is why this stopped being a string. Every entry is a claim
 * about a `.tsx` file, and until now the claim was a comment — the round-6
 * measurer deleted `CanvasPanel.tsx`'s entire `'+' / '-' / ' '` prefix
 * expression, leaving added and removed rows differing by colour and nothing
 * else, and the whole suite stayed green: 121 files, 2443 tests, exit 0. The
 * companion test below checked that the *CSS rule* still existed and never
 * opened the component the entry was about.
 */
interface CarriedByContent {
  /** The content a sighted user has instead of the colour. */
  readonly says: string;
  /** The component that draws it, relative to `src/`. */
  readonly file: string;
  /**
   * Source text of that component which, if it went, would take {@link says}
   * with it. Read by *every entry in the escape hatch is content its component
   * still draws* below.
   */
  readonly evidence: RegExp;
}

/**
 * The rules the scan finds that need no forced-colours restatement, each with
 * the content that already carries the distinction — read out of the markup,
 * not assumed from the class name.
 *
 * This is the whole escape hatch. A rule that is neither restated nor listed
 * here fails, and adding a line here is a claim about a `.tsx` file that the
 * test below now makes rather than inviting the next reader to grep.
 */
const CARRIED_BY_CONTENT: Readonly<Record<string, CarriedByContent>> = {
  "features/canvas/CanvasPanel.module.css::.diffRow[data-kind='added']": {
    says: 'the + prefix',
    file: 'features/canvas/CanvasPanel.tsx',
    evidence: /row\.kind === 'added' \? '\+'/u,
  },
  "features/canvas/CanvasPanel.module.css::.diffRow[data-kind='removed']": {
    says: 'the - prefix',
    file: 'features/canvas/CanvasPanel.tsx',
    evidence: /row\.kind === 'removed' \? '-'/u,
  },
  "features/conversation/CopyButton.module.css::.button[data-outcome='copied']": {
    says: 'the label reads Copied',
    file: 'features/conversation/CopyButton.tsx',
    evidence: /outcome === 'copied' \? 'Copied'/u,
  },
  "features/conversation/CopyButton.module.css::.button[data-outcome='failed']": {
    says: 'the label reads Copy failed',
    file: 'features/conversation/CopyButton.tsx',
    evidence: /outcome === 'failed' \? 'Copy failed'/u,
  },
  "features/conversation/EmptyConversation.module.css::.capability[data-available='true']": {
    says: 'the tick glyph',
    file: 'features/conversation/EmptyConversation.tsx',
    evidence: /line\.available \? '✓' : '—'/u,
  },
  "features/conversation/EmptyConversation.module.css::.capability[data-available='true'] .tick": {
    says: 'the tick glyph',
    file: 'features/conversation/EmptyConversation.tsx',
    evidence: /line\.available \? '✓' : '—'/u,
  },
  "features/conversation/ToolCallList.module.css::.state[data-status='arriving'], .state[data-status='running']":
    {
      says: 'the status word',
      file: 'features/conversation/ToolCallList.tsx',
      evidence: /\{statusLabel\(view\.status\)\}/u,
    },
  "features/conversation/ToolCallList.module.css::.state[data-status='succeeded']": {
    says: 'the status word',
    file: 'features/conversation/ToolCallList.tsx',
    evidence: /\{statusLabel\(view\.status\)\}/u,
  },
  "features/conversation/ToolCallList.module.css::.state[data-status='failed']": {
    says: 'the status word',
    file: 'features/conversation/ToolCallList.tsx',
    evidence: /\{statusLabel\(view\.status\)\}/u,
  },
  "features/conversation/ToolCallList.module.css::.state[data-status='unreadable']": {
    says: 'the status word',
    file: 'features/conversation/ToolCallList.tsx',
    evidence: /\{statusLabel\(view\.status\)\}/u,
  },
  "features/conversation/ToolCallList.module.css::.block[data-error='true']": {
    says: 'the Error label above the block',
    file: 'features/conversation/ToolCallList.tsx',
    evidence: /view\.result\.isError \? 'Error' : 'Result'/u,
  },
};

/** The body of every `@media (forced-colors: active)` block in a sheet. */
function forcedColorsBlocks(text: string): string {
  const out: string[] = [];
  const marker = /@media\s*\(\s*forced-colors\s*:\s*active\s*\)\s*\{/gu;
  for (const match of text.matchAll(marker)) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (index < text.length && depth > 0) {
      if (text[index] === '{') depth += 1;
      else if (text[index] === '}') depth -= 1;
      index += 1;
    }
    out.push(text.slice(start, index - 1));
  }
  return out.join('\n');
}

/**
 * The structural positions {@link colourAloneRulesIn} branches on, in the order
 * its filters meet them, and therefore the positions {@link FIXTURE} has to
 * contain for a deleted branch to be nameable.
 *
 * Enumerated rather than counted: a count says how many were read, and this run
 * has spent six rounds learning that the question is always *which one stopped*.
 */
const POSITIONS = [
  'an at-rule statement glued to the selector that follows it',
  'a selector with no attribute state at all',
  'a transient pseudo-class beside an attribute state',
  'an attribute state whose body is empty',
  'an attribute state that also says something colour does not carry',
  'a colour-alone attribute state inside a forced-colours block',
  'a colour-alone attribute state — the one thing the scan is for',
  'a colour-alone attribute state written after a forced-colours block',
] as const;

/**
 * One stylesheet holding every entry of {@link POSITIONS}, plus the inputs the
 * three value readers below branch on.
 *
 * Written here rather than taken from `src/`, for the reason the round-6 critic
 * gave about the escape hatch: a scan asserted only against the tree it scans
 * reports whatever that tree happens to contain, and goes green the day the
 * tree stops containing it. Four of this file's filters reject **nothing** in
 * `src/` today — {@link TRANSIENT} rejects 0 rules, the empty-body skip rejects
 * 0, the forced-colours strip removes 0 rules that would otherwise be reported,
 * and all 5 at-rule heads would be refused by {@link ATTRIBUTE_STATE} anyway,
 * all four counts measured at this commit. Their universe is empty, so the tree
 * cannot pin them and this has to.
 *
 * The `@import` on the first line is not decoration: an at-rule statement that
 * ends in `;` has no block, so the rule pattern glues it onto the head of the
 * selector that follows — which is how a real selector can arrive at the scan
 * wearing an `@`.
 */
const FIXTURE = `
/* an at-rule statement glued to the selector that follows it */
@import './tokens.css';
.glued[data-state='on'] {
  color: var(--vela-text);
}

/* a selector with no attribute state at all */
.plain {
  color: var(--vela-text);
}

/* a transient pseudo-class beside an attribute state */
.hovered[data-state='on']:hover {
  background: var(--vela-row-hover);
}

/* an attribute state whose body is empty */
.blank[data-state='on'] {
}

/* an attribute state that also says something colour does not carry */
.mixed[data-state='on'] {
  color: var(--vela-text);
  font-weight: var(--vela-weight-bold);
}

/* a colour-alone attribute state — the one thing the scan is for */
.found[data-state='on'] {
  background: var(--vela-row-selected);
  color: var(--vela-row-selected-text);
}

.weighted {
  font-size: var(--vela-text-sm);
  font-weight: var(--vela-weight-medium);
}

.listed,
.listed-elsewhere {
  color: var(--vela-text);
}

.edge {
  border: 1px solid transparent;
  border-left-width: 3px;
  padding: var(--vela-space-2);
}

.edge[data-state='on'] {
  border-color: var(--vela-border);
  border-style: solid;
}

.inert {
  border: 1px solid transparent;
}

.painted {
  border: 1px solid transparent;
}

.painted[data-state='on'] {
  border-color: var(--vela-border-strong);
  border-style: solid;
}

@media (forced-colors: active) {
  /* a colour-alone attribute state inside a forced-colours block */
  .restated[data-state='on'] {
    color: CanvasText;
  }

  .selected .weighted {
    font-weight: var(--vela-weight-bold);
  }

  .inert[data-state='on'] {
    border-style: dashed;
  }

  .painted[data-state='on'] {
    border-style: dashed;
  }
}

/* a colour-alone attribute state written after a forced-colours block */
.after[data-state='on'] {
  color: var(--vela-accent);
}
`;

describe('a distinction carried by colour alone is restated without colour', () => {
  it('keeps the two note tones apart in the transcript', () => {
    // `.note[data-tone='warning']` differs from `.note` by `background` and
    // `border-color` only. Both resolve to the user's single pair under forced
    // colours, so the two tones become one box.
    const block = forcedColorsBlocks(sheet('features/conversation/TurnNotices.module.css'));
    expect(block).toContain(".note[data-tone='warning']");
    expect(block).toMatch(/border-style:\s*dashed/u);
    expect(block).toMatch(/border-style:\s*solid/u);
  });

  it('keeps a turn’s ending apart from an ordinary notice', () => {
    const text = sheet('features/conversation/MessageTurn.module.css');
    const block = forcedColorsBlocks(text);
    expect(block).toContain(".ending[data-tone='warning']");
    expect(block).toContain(".error[data-kind='stopped']");

    // FOUR BOXES, AND THE CLAIM MEASURED RATHER THAN ASSERTED.
    //
    // The first version of this comment said the border style alone kept all
    // four apart. It does not: there are four classes and two styles, and
    // `.ending` shares `solid` with `.error[data-kind='stopped']` while
    // `.ending[data-tone='warning']` shares `dashed` with `.error`.
    //
    // What actually separates the two families is the width of the left edge,
    // and a width is not a colour, so it survives. `.ending` carries a 3px left
    // border outside the forced-colours block; `.error` does not. That makes the
    // pair (family, style) four distinct values, and both halves are checked
    // here rather than described.
    expect(text).toMatch(/\.ending\s*\{[^}]*border-left-width:\s*3px/u);
    // EVERY BORDER DECLARATION `.error` AND `.ending` CARRY, LISTED — INSTEAD
    // OF A BAN ON THE SPELLINGS SOMEBODY THOUGHT OF.
    //
    // Four generations of this guard enumerated, and each was defeated by an
    // input its author had not enumerated. v1 banned `border-left-width`; v2
    // added the `border-left` shorthand; v3 added `border-width`'s four-value
    // form; v4 stopped reading names and read the *value* — on a rule whose
    // selector mentions `.error`, no `border…` property except `border-radius`
    // may carry a length that is not 1px — and claimed in a comment that a
    // spelling nobody had written yet was refused as well.
    //
    // Three walked past v4. The round-5 critic measured each of them green
    // twice, exit 0:
    //
    //   border-inline-start-width: calc(1px * 3)  an exact 3px left edge — the
    //                                             collapse this test exists to
    //                                             prevent — because v4 found
    //                                             the literal 1px inside the
    //                                             calc and compared that
    //   border-left-width: thick                  a <line-width> keyword CSS
    //                                             Backgrounds and Borders
    //                                             defines; no length token at
    //                                             all to read
    //   border-left-width: 3PX                    v4's length pattern carried
    //                                             `u` and not `i`
    //
    // So this stops asking what is forbidden and states what is present. Each
    // list below is every border declaration on every rule whose selector
    // mentions the class, in source order, verbatim. A declaration added,
    // removed or re-valued fails it — in any spelling, any case, any unit, any
    // function, thought of or not — because the assertion is an equality over
    // the whole set rather than a predicate over its members. A scan that
    // stopped matching fails it too: it would produce `[]`, which is why the
    // two hand-written floors this replaces are gone rather than kept.
    //
    // Both classes are listed, because the pair can be collapsed from either
    // side: `.error` growing a 3px left edge, or `.ending` losing its own.
    //
    // The cost is deliberate. A change to either border edits this file, and
    // the diff shows a reviewer exactly which edge moved.
    //
    // The three v4 survivors, and the collapse from the other side, measured
    // against this guard rather than described — each injected into
    // `MessageTurn.module.css`, each run twice, every one exit 1:
    //
    //   .error { border-inline-start-width: calc(1px * 3) }   red
    //   .error { border-left-width: thick }                   red
    //   .error { border-left-width: 3PX }                     red
    //   .ending { border-left-width: 1px } (the 3px undone)   red
    //
    // What it does not see, stated rather than left to be found: a declaration
    // in another sheet, and a rule in this one whose selector does not mention
    // the class. `.errorTitle`, `.errorDetail` and `.errorTrace` are not such
    // rules — `\b` does not match inside a word — and they carry no border.
    expect(borderDeclarationsOf(text, /\.error\b/u)).toEqual([
      '.error { border-radius: var(--vela-radius-md) }',
      '.error { border: 1px solid var(--vela-danger) }',
      ".error[data-kind='stopped'] { border-color: var(--vela-border) }",
      // The two inside the forced-colours block, where the distinction is
      // restated in a style rather than a colour.
      '.error { border-style: dashed }',
      ".error[data-kind='stopped'] { border-style: solid }",
    ]);
    expect(borderDeclarationsOf(text, /\.ending\b/u)).toEqual([
      '.ending { border: 1px solid var(--vela-border) }',
      // The 3px edge is the whole distinction between the two families, and it
      // is a width, so it survives forced colours.
      '.ending { border-left-width: 3px }',
      '.ending { border-radius: var(--vela-radius-md) }',
      ".ending[data-tone='warning'] { border-color: var(--vela-warning) }",
      '.ending { border-style: solid }',
      ".ending[data-tone='warning'] { border-style: dashed }",
    ]);
    expect(block).toMatch(/\.ending\s*\{\s*border-style:\s*solid/u);
    expect(block).toMatch(/\.ending\[data-tone='warning'\]\s*\{\s*border-style:\s*dashed/u);
    expect(block).toMatch(/\.error\s*\{\s*border-style:\s*dashed/u);
    expect(block).toMatch(/\.error\[data-kind='stopped'\]\s*\{\s*border-style:\s*solid/u);
  });

  it('keeps the rail saying where you are', () => {
    // This is the one in the scan that is genuinely colour-alone: `aria-current`
    // reaches a screen reader, and nothing reaches a sighted user in a
    // forced-colours mode once `--vela-surface` and `--vela-text` are replaced.
    //
    // WHAT THIS ASSERTED BEFORE, AND WHY IT WAS NOT ENOUGH. It read two property
    // NAMES out of the block — that `[aria-current='page']` appeared and that
    // some `border-style: dashed` did. The round-6 critic set
    // `.searchButton[aria-current='page']`'s `border-color` to `transparent`,
    // which makes the dashed restatement paint nothing on that branch, and
    // measured the whole suite green twice. And the other branch — the rail's
    // `.iconButton` — was ALREADY in that state at HEAD: it rests at
    // `border: 1px solid transparent`, forced colours preserves a transparent
    // border rather than substituting it, so the cue this track added to the
    // collapsed rail drew nothing for the users it was added for.
    //
    // Both halves are values now. The resting border colour of each branch is
    // read from the sheet and asserted to be a colour the mode replaces, and
    // *leaves no forced-colours restatement resting on a border that stays
    // transparent* makes the same check over every sheet in `src/`.
    const text = sheet('features/navigation/Sidebar.module.css');
    const block = forcedColorsBlocks(text);
    expect(block).toContain("[aria-current='page']");
    expect(block).toMatch(/border-style:\s*dashed/u);

    // The border the dashed restatement is drawn on, per branch, by value.
    expect(restingBorderColour(text, ".iconButton[aria-current='page']")).toBe(
      'var(--vela-border-strong)',
    );
    expect(restingBorderColour(text, ".searchButton[aria-current='page']")).toBe(
      'var(--vela-border-strong)',
    );
    // …and the unselected rail button is the one that stays invisible, which is
    // the distinction. Read from the base rule, which is where the shorthand is.
    expect(restingBorderColour(text, '.iconButton')).toBe('transparent');

    // Every border declaration the two rail affordances carry, verbatim — the
    // whole-set equality that worked for `.error`/`.ending`, so a declaration
    // added, removed or re-valued fails here in any spelling.
    expect(borderDeclarationsOf(text, /\.iconButton\b/u)).toEqual([
      '.iconButton { border: 1px solid transparent }',
      '.iconButton { border-radius: var(--vela-radius-md) }',
      ".iconButton[aria-current='page'] { border-color: var(--vela-border-strong) }",
      ".searchButton[aria-current='page'], .iconButton[aria-current='page'] { border-style: dashed }",
    ]);
  });

  it('keeps the sidebar saying which conversation is open', () => {
    // The state the scan cannot see, because `.selected` is a class and not an
    // attribute — and the one with the most riding on it. `aria-current='page'`
    // is on `.main` and reaches assistive technology; the fill is all a sighted
    // user gets, and it is the fill that goes.
    //
    // WHAT THIS ASSERTED BEFORE. That `.selected .title` appeared in the block
    // and that the block said `font-weight:` somewhere — two property NAMES.
    // The round-6 critic set the restated weight to `var(--vela-weight-medium)`,
    // the exact weight `.title` already rests at one screen up, so the
    // restatement restated nothing, and measured 121 files / 2451 tests green.
    // A restatement that says what the resting rule says is not a restatement,
    // and only a value can tell the two apart.
    const text = sheet('features/navigation/ConversationRow.module.css');
    expect(text).toMatch(/\.selected,\s*\.selected:hover\s*\{\s*background:/u);
    const block = forcedColorsBlocks(text);
    expect(block).toContain('.selected .title');

    const resting = declaredValue(text, '.title', 'font-weight');
    const restated = declaredValue(block, '.selected .title', 'font-weight');
    expect(resting).toBe('var(--vela-weight-medium)');
    expect(restated).toBe('var(--vela-weight-bold)');
    // The assertion the two above exist for: the restatement has to *differ*
    // from what the row already looked like, or it says nothing.
    expect(
      restated,
      'the selected row restates itself in the weight every row already has',
    ).not.toBe(resting);
    // And both were read, rather than defaulting to undefined together — which
    // would satisfy `not.toBe` in silence and is the shape of the defect above.
    expect(resting).not.toBeUndefined();
    expect(restated).not.toBeUndefined();
  });

  it('leaves no persistent colour-alone state unaccounted for, anywhere in src', () => {
    // THE WIDE QUESTION, ASKED OF THE WHOLE TREE. Three hand-written
    // assertions reported a shell as covered on the strength of three
    // surfaces; this one goes red for a fourth surface nobody looked at.
    const unaccounted: string[] = [];
    for (const rule of colourAloneStateRules()) {
      const key = `${rule.file}::${rule.selector}`;
      if (key in CARRIED_BY_CONTENT) continue;
      const block = forcedColorsBlocks(sheet(rule.file));
      const restated = rule.selector
        .split(',')
        .map((one) => one.trim())
        .every((one) => block.includes(one));
      if (!restated) unaccounted.push(key);
    }
    expect(
      unaccounted,
      'each of these says a state with colour alone: restate it without colour, or add it to CARRIED_BY_CONTENT with the content that already says it',
    ).toEqual([]);

    // And the scan is looking at something: an empty scan would pass the
    // assertion above while asserting nothing at all.
    expect(colourAloneStateRules().length).toBeGreaterThan(15);
    expect(stylesheets().length).toBeGreaterThan(40);
  });

  it('every entry in the escape hatch is a rule that still exists', () => {
    // Otherwise the list rots into a set of excuses for rules that were fixed
    // or deleted years ago, and the next colour-alone state slips in under a
    // key nobody re-read.
    const live = new Set(colourAloneStateRules().map((rule) => `${rule.file}::${rule.selector}`));
    for (const key of Object.keys(CARRIED_BY_CONTENT)) {
      expect(live.has(key), `${key} is listed as carried by content but no longer exists`).toBe(true);
    }
  });

  it('every entry in the escape hatch is content its component still draws', () => {
    // THE OTHER HALF OF THE CLAIM, AND THE HALF THAT WAS NOBODY'S.
    //
    // The test above checks that the CSS rule an entry excuses still exists. It
    // never opens the component the entry is *about*, and that component is the
    // whole content of the excuse: `.diffRow[data-kind='added']` is allowed to
    // differ from `.diffRow[data-kind='removed']` by colour alone **because
    // `CanvasPanel.tsx` prefixes the rows with '+' and '-'**. The round-6
    // measurer deleted that prefix expression outright — added and removed rows
    // then differed by colour and nothing else, which is exactly the state the
    // escape hatch exists to excuse them from — and the suite stayed at 121
    // files / 2443 tests, exit 0. Eleven entries, eleven unverified claims.
    //
    // Re-measured here rather than repeated: with that expression deleted the
    // whole suite now fails on this test and on
    // `CanvasPanel.test.tsx`'s *tells an added row from a removed one without
    // using any colour*, and on nothing else — 2 failed | 2449 passed at this
    // commit, so every test that existed before this round did stay green.
    //
    // Each entry now carries the source text its content is drawn by, and this
    // reads it. What that buys, stated exactly: the component still contains
    // the expression. It is not proof that the expression reaches the screen —
    // a component can keep it and stop rendering the element around it — because
    // this is a source read and not a mounted DOM. The pair with the most riding
    // on it has the DOM half too, in `CanvasPanel.test.tsx`'s *tells an added
    // row from a removed one without using any colour*, which reads the text of
    // the rows the panel actually rendered.
    for (const [key, entry] of Object.entries(CARRIED_BY_CONTENT)) {
      const source = readFileSync(join(SRC, entry.file), 'utf8');
      expect(
        entry.evidence.test(source),
        `${key} is excused because ${entry.says}, but ${entry.file} no longer contains ${String(entry.evidence)}`,
      ).toBe(true);
    }
    // And the loop is looking at something: an empty record would pass it in
    // silence, which is the shape of the defect it was written for.
    expect(Object.keys(CARRIED_BY_CONTENT)).toHaveLength(11);
  });

  it('the vocabulary a restatement may use is the one this file says it is', () => {
    // RULE V, ON THE TWO LISTS EVERY GUARD IN THIS FILE RESTS ON.
    //
    // Both were prose. The round-6 measurer deleted the six names
    // {@link SUBSTITUTED}'s comment says it grew by — returning it to the exact
    // six-name form the commit that widened it replaced — and ran the whole
    // renderer suite: 121 files / 2443 tests, identical to the untouched
    // baseline. The property is real: with the names present, injecting
    // `outline-color` into Composer's forced-colours block reds the check
    // above; with them gone the same declaration passes. Nothing asserted the
    // list. Both lists are asserted here, by name.
    //
    // Re-measured rather than repeated: deleting those six now fails the whole
    // suite on this test and on nothing else — 1 failed | 2450 passed at this
    // commit.
    //
    // The first is what CSS Color Adjust says a forced-colours mode replaces,
    // plus `opacity`, which it does not replace and which is the other way a
    // state is said without saying it.
    for (const name of [
      'color',
      'background',
      'background-color',
      'border-color',
      'border-inline-start-color',
      'fill',
      'stroke',
      'box-shadow',
      'opacity',
      'outline-color',
      'caret-color',
      'text-decoration-color',
      'accent-color',
      'column-rule-color',
      'text-emphasis-color',
    ]) {
      expect(SUBSTITUTED.test(name), `${name} says a state with colour alone`).toBe(true);
    }
    // And it is not matching everything: a rule that also sets one of these is
    // not colour-alone, and the scan has to keep letting it through.
    for (const name of ['border-style', 'font-weight', 'content', 'padding', 'display']) {
      expect(SUBSTITUTED.test(name), `${name} is not a colour`).toBe(false);
    }

    // The allowlist, from the other side. `scrollbar-color` and
    // `-webkit-tap-highlight-color` are the two the round-5 critic measured
    // straight through the ban this replaced.
    for (const name of [
      'color',
      'background',
      'background-color',
      'border-color',
      'border-inline-start-color',
      'fill',
      'stroke',
      'box-shadow',
      'outline-color',
      'caret-color',
      'text-decoration-color',
      'accent-color',
      'column-rule-color',
      'text-emphasis-color',
      'scrollbar-color',
      '-webkit-tap-highlight-color',
      'opacity',
      'forced-color-adjust',
    ]) {
      expect(
        RESTATEMENT_MAY_USE.has(name),
        `${name} must not be usable as a forced-colours restatement`,
      ).toBe(false);
    }
    // And the vocabulary a restatement actually needs is on it, so the check
    // above cannot be satisfied by emptying the list.
    for (const name of [
      'border-style',
      'border-left-style',
      'border-inline-start-width',
      'outline-style',
      'outline-width',
      'outline-offset',
      'font-weight',
      'text-decoration-line',
      'text-underline-offset',
      'content',
    ]) {
      expect(RESTATEMENT_MAY_USE.has(name), `${name} is how a restatement says a thing`).toBe(true);
    }
  });

  it('restates it in a property forced colours does not substitute', () => {
    // The point of the fix, stated as a rule: nothing inside a forced-colours
    // block may lean on a colour again. A `border-color` in there is the same
    // defect one level down — the exact failure mode this run exists for.
    //
    // Every sheet that has such a block, not a list somebody remembered to
    // extend: a new forced-colours block that reaches for a colour is exactly
    // the mistake this catches.
    //
    // A BAN NAMES WHAT ITS AUTHOR REMEMBERED. AN ALLOWLIST NAMES WHAT IS
    // PERMITTED, AND REFUSES THE REST WITHOUT HAVING TO KNOW IT.
    //
    // Two earlier versions of this check banned colour properties by name, and
    // the comment over each said the rule was absolute. The first matched six
    // names; replaying it over `Composer.module.css`'s block with one
    // declaration added, all six of `outline-color`, `caret-color`,
    // `text-decoration-color`, `accent-color`, `column-rule-color` and
    // `text-emphasis-color` passed. The second matched those twelve and said it
    // had grown to the CSS Color Adjust list; that list also holds
    // `scrollbar-color` and `-webkit-tap-highlight-color`, and the round-5
    // critic measured `scrollbar-color: Canvas CanvasText` inside that same
    // block green twice, exit 0.
    //
    // {@link RESTATEMENT_MAY_USE} inverts it. A declaration whose property is
    // not on that list fails, so a colour property nobody here has heard of is
    // refused for the same reason `scrollbar-color` now is — not because
    // somebody remembered it, but because nothing is permitted that was not
    // written down. *the vocabulary a restatement may use is the one this file
    // says it is* asserts that list's own membership, so this cannot be widened
    // by quietly deleting a name from it either.
    //
    // Measured against this version rather than described, each injected into
    // `Composer.module.css`'s block and run twice, both exit 1:
    // `scrollbar-color: Canvas CanvasText` reds — it did not before — and
    // `outline-color: CanvasText` still does.
    //
    // WHAT IT IS TOTAL OVER, AND WHAT IT IS NOT. Total over property *names*:
    // there is no name, spelled or unspelled, that passes without being on the
    // list. Not total over where a restatement can be written. Two limits, both
    // in {@link forcedColorsBlocks} rather than here, and neither has an
    // instance in this tree today:
    //
    // * the block has to be spelled `@media (forced-colors: active) {`. A
    //   compound query — `@media (forced-colors: active) and (prefers-contrast:
    //   more)` — is not found, so its declarations are read by nothing.
    // * a sheet is only examined if the string `forced-colors` appears in it,
    //   which is how the loop finds sheets at all.
    //
    // Both are scope, not leakage: a restatement the scan cannot see does not
    // *satisfy* the colour-alone check either, so it cannot be used to excuse a
    // rule. It can only fail to be checked itself.
    //
    // AND THE FLOOR ONE LEVEL UP, WHICH WAS MISSING. The loop below floors the
    // declaration count INSIDE each sheet — 'a block whose declarations stopped
    // being found would pass the loop above without reading anything'. It did
    // not floor the number of sheets. The round-6 critic pointed the filter at
    // `forced-colorsZZZ`, which makes this examine ZERO sheets, and measured it
    // green twice. The sibling test floors `stylesheets().length > 40`; this is
    // the same line, one level up.
    //
    // Exact rather than a floor, for the reason {@link RESTATEMENT_MAY_USE} is a
    // list rather than a ban: a sheet growing a forced-colours block is a change
    // that should have a reviewer's eyes on it, and adding a line here is how it
    // gets them. The list is measured, not remembered.
    const withBlocks = stylesheets().filter((one) => sheet(one).includes('forced-colors'));
    expect(withBlocks).toEqual([
      'features/canvas/CanvasPanel.module.css',
      'features/canvas/DocumentPreview.module.css',
      'features/conversation/Composer.module.css',
      'features/conversation/MessageTurn.module.css',
      'features/conversation/TurnNotices.module.css',
      'features/navigation/ConversationRow.module.css',
      'features/navigation/Sidebar.module.css',
    ]);
    for (const name of withBlocks) {
      const block = forcedColorsBlocks(sheet(name));
      expect(block.length, `${name} has no forced-colors block`).toBeGreaterThan(0);
      let properties = 0;
      for (const rule of block.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
        for (const declaration of (rule[2] ?? '').split(';')) {
          const property = (declaration.split(':')[0] ?? '').trim();
          if (property === '') continue;
          properties += 1;
          expect(
            RESTATEMENT_MAY_USE.has(property),
            `${name} restates a distinction with ${property}, which is not a property a restatement may lean on`,
          ).toBe(true);
        }
      }
      // The floor: a block whose declarations stopped being found would pass
      // the loop above without reading anything.
      expect(properties, `${name}: no declaration was read`).toBeGreaterThan(0);
    }
  });
  it('leaves no forced-colours restatement resting on a border that stays transparent', () => {
    // RULE V, ON THE FACT EVERY BORDER RESTATEMENT IN THIS TREE RESTS ON.
    //
    // `Composer.module.css` states it — a forced-colours mode preserves a fully
    // transparent border rather than substituting it — and the round-6 critic's
    // blocking finding was that nothing asserted it while the rail's own cue was
    // built on its negation. Exactly one of the two had to be wrong and no test
    // could say which. The fact is now a law over the tree: a `border-style` or
    // `border-width` restatement written on an element whose resting border is
    // `transparent` paints nothing, and fails here.
    const offenders = stylesheets().flatMap((file) =>
      inertBorderRestatements(sheet(file)).map((selector) => `${file} :: ${selector}`),
    );
    expect(
      offenders,
      'each of these restates a state on a border forced colours will not repaint: give the resting rule a border colour that is substituted, or restate the state in an outline',
    ).toEqual([]);

    // AND THE READER IS LOOKING AT SOMETHING. An empty answer over the tree is
    // what a scan that found nothing returns too, which is the round-6 shape
    // exactly — so the same reader is run over a sheet built to contain one, and
    // has to find it.
    expect(inertBorderRestatements(FIXTURE)).toEqual([".inert[data-state='on']"]);
    // …and not to find the one whose resting colour is a token, which is the
    // distinction the whole law turns on.
    expect(inertBorderRestatements(FIXTURE)).not.toContain(".painted[data-state='on']");
  });

  it('reads every structural position the scanners in this file branch on', () => {
    // RULE W, APPLIED TO THIS FILE'S OWN READERS.
    //
    // Every guard above is a claim about what a scan of `src/` found. A scan is
    // a chain of filters, and a filter nothing asserts is a law whose universe
    // is a set nobody pinned — which is the defect this run keeps finding one
    // level down from wherever it was last closed. Round 6 pinned the DATA
    // ({@link SUBSTITUTED}, {@link RESTATEMENT_MAY_USE}) and left the CODE that
    // reads it unpinned: the round-7 measurer deleted four of
    // {@link colourAloneRulesIn}'s six `continue`s, one at a time, and the whole
    // suite stayed green for each.
    //
    // {@link FIXTURE} is one stylesheet carrying every structural position that
    // function branches on, and the equality below is the enumerated answer. A
    // branch removed changes the answer and names the position it stopped
    // reading — which is what these positions are, in the order the reader meets
    // them.
    expect(POSITIONS).toEqual([
      'an at-rule statement glued to the selector that follows it',
      'a selector with no attribute state at all',
      'a transient pseudo-class beside an attribute state',
      'an attribute state whose body is empty',
      'an attribute state that also says something colour does not carry',
      'a colour-alone attribute state inside a forced-colours block',
      'a colour-alone attribute state — the one thing the scan is for',
      'a colour-alone attribute state written after a forced-colours block',
    ]);
    // The fixture actually contains each of them, marked by name, so a position
    // cannot be quietly dropped from the input to make the answer come out.
    for (const position of POSITIONS) {
      expect(FIXTURE, `${position} is not in the fixture`).toContain(`/* ${position} */`);
    }

    // THE ANSWER. Two rules and no others: the six `continue`s above reject the
    // other six positions, one position each.
    expect(colourAloneRulesIn(FIXTURE, 'fixture.css')).toEqual([
      { file: 'fixture.css', selector: ".found[data-state='on']" },
      { file: 'fixture.css', selector: ".after[data-state='on']" },
    ]);

    // `forcedColorsBlocks` reads the other side of the same sheet: the block's
    // body and nothing outside it, through a nested rule, so both arms of its
    // depth counter are exercised by this input too.
    const block = forcedColorsBlocks(FIXTURE);
    expect(block).toContain(".restated[data-state='on']");
    expect(block).toContain(".inert[data-state='on']");
    expect(block).not.toContain('.found');
    expect(block).not.toContain('.after');

    // `borderDeclarationsOf` over the same input: the selector filter, the
    // `border` prefix filter and the comment strip, enumerated.
    expect(borderDeclarationsOf(FIXTURE, /\.edge\b/u)).toEqual([
      '.edge { border: 1px solid transparent }',
      '.edge { border-left-width: 3px }',
      ".edge[data-state='on'] { border-color: var(--vela-border) }",
      ".edge[data-state='on'] { border-style: solid }",
    ]);

    // `declaredValue`: last wins, the selector must match a whole entry of the
    // list rather than a substring of one, and an undeclared property is
    // `undefined` rather than an empty string.
    expect(declaredValue(FIXTURE, '.weighted', 'font-weight')).toBe('var(--vela-weight-medium)');
    expect(declaredValue(FIXTURE, '.selected .weighted', 'font-weight')).toBe(
      'var(--vela-weight-bold)',
    );
    expect(declaredValue(FIXTURE, '.listed', 'color')).toBe('var(--vela-text)');
    expect(declaredValue(FIXTURE, '.weighted', 'border-color')).toBeUndefined();

    // `restingBorderColour`: the shorthand's last token, the longhand that
    // overrides it, the base rule a state inherits its border from, and the
    // element that has no border at all.
    expect(restingBorderColour(FIXTURE, '.edge')).toBe('transparent');
    expect(restingBorderColour(FIXTURE, ".edge[data-state='on']")).toBe('var(--vela-border)');
    expect(restingBorderColour(FIXTURE, ".inert[data-state='on']")).toBe('transparent');
    expect(restingBorderColour(FIXTURE, '.weighted')).toBeUndefined();
  });
});
