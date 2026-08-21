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
 * **It says nothing about the rest of forced-colours support.** Focus rings,
 * `border: 1px solid transparent` controls, the inline SVG glyph set, and every
 * opacity-only affordance are not examined here at all.
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
 */
function borderDeclarationsOf(text: string, selector: RegExp): readonly string[] {
  const found: string[] = [];
  for (const rule of text.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const head = (rule[1] ?? '').trim().split(/\s+/u).join(' ');
    if (!selector.test(head)) continue;
    for (const one of (rule[2] ?? '').split(';')) {
      const declaration = one.trim().split(/\s+/u).join(' ');
      if (declaration === '') continue;
      if (!(declaration.split(':')[0] ?? '').trim().startsWith('border')) continue;
      found.push(`${head} { ${declaration} }`);
    }
  }
  return found;
}

interface ColourAloneRule {
  readonly file: string;
  readonly selector: string;
}

/**
 * Every rule under `src/` that says a persistent state with nothing but colour
 * — read from **outside** the forced-colours blocks, so a restatement is not
 * mistaken for the thing it restates.
 */
function colourAloneStateRules(): readonly ColourAloneRule[] {
  const found: ColourAloneRule[] = [];
  for (const file of stylesheets()) {
    const text = sheet(file)
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/@media\s*\(\s*forced-colors\s*:\s*active\s*\)\s*\{[\s\S]*?\n\}/gu, '');
    for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      const selector = (match[1] ?? '').trim().split(/\s+/u).join(' ');
      if (selector.startsWith('@')) continue;
      if (!ATTRIBUTE_STATE.test(selector) || TRANSIENT.test(selector)) continue;
      const declarations = (match[2] ?? '')
        .split(';')
        .map((one) => one.trim())
        .filter((one) => one !== '');
      if (declarations.length === 0) continue;
      if (!declarations.every((one) => SUBSTITUTED.test((one.split(':')[0] ?? '').trim()))) continue;
      found.push({ file, selector });
    }
  }
  return found;
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
    const block = forcedColorsBlocks(sheet('features/navigation/Sidebar.module.css'));
    expect(block).toContain("[aria-current='page']");
    expect(block).toMatch(/border-style:\s*dashed/u);
  });

  it('keeps the sidebar saying which conversation is open', () => {
    // The state the scan cannot see, because `.selected` is a class and not an
    // attribute — and the one with the most riding on it. `aria-current='page'`
    // is on `.main` and reaches assistive technology; the fill is all a sighted
    // user gets, and it is the fill that goes.
    const text = sheet('features/navigation/ConversationRow.module.css');
    expect(text).toMatch(/\.selected,\s*\.selected:hover\s*\{\s*background:/u);
    const block = forcedColorsBlocks(text);
    expect(block).toContain('.selected .title');
    expect(block).toMatch(/font-weight:/u);
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
    for (const name of stylesheets().filter((one) => sheet(one).includes('forced-colors'))) {
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
});
