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
 */
const SUBSTITUTED =
  /^(color|background|background-color|[a-z-]*border[a-z-]*-color|fill|stroke|box-shadow|opacity|outline-color|caret-color|text-decoration-color|accent-color|column-rule-color|text-emphasis-color)$/u;

/** A state spelled as an attribute. See the header for what this does not see. */
const ATTRIBUTE_STATE = /\[(data-|aria-)[^\]]*\]/u;

/** The pointer and the focus ring are their own signal. */
const TRANSIENT = /:(hover|focus|focus-within|focus-visible|active)\b/u;

/**
 * A CSS length, anywhere in a declaration's value. It is how the guard below
 * reads a border edge's width off the *value* instead of guessing at which of
 * the property's several spellings somebody used.
 */
const LENGTH = /-?\d*\.?\d+(?:px|rem|em|ch|ex|pt|pc|in|cm|mm|vh|vw|vmin|vmax|%)/gu;

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
 * The rules the scan finds that need no forced-colours restatement, each with
 * the content that already carries the distinction — read out of the markup,
 * not assumed from the class name.
 *
 * This is the whole escape hatch. A rule that is neither restated nor listed
 * here fails, and adding a line here is a claim about a `.tsx` file that the
 * next reader can check in one grep.
 */
const CARRIED_BY_CONTENT: Readonly<Record<string, string>> = {
  // `CanvasPanel.tsx` prefixes each row with '+', '-' or ' '.
  "features/canvas/CanvasPanel.module.css::.diffRow[data-kind='added']": 'the + prefix',
  "features/canvas/CanvasPanel.module.css::.diffRow[data-kind='removed']": 'the - prefix',
  // `CopyButton.tsx` renders 'Copy', 'Copied' or 'Copy failed' as the label.
  "features/conversation/CopyButton.module.css::.button[data-outcome='copied']":
    'the label reads Copied',
  "features/conversation/CopyButton.module.css::.button[data-outcome='failed']":
    'the label reads Copy failed',
  // `EmptyConversation.tsx` renders a tick or an em dash in `.tick`.
  "features/conversation/EmptyConversation.module.css::.capability[data-available='true']":
    'the tick glyph',
  "features/conversation/EmptyConversation.module.css::.capability[data-available='true'] .tick":
    'the tick glyph',
  // `ToolCallList.tsx` prints `statusLabel(view.status)` inside the pill.
  "features/conversation/ToolCallList.module.css::.state[data-status='arriving'], .state[data-status='running']":
    'the status word',
  "features/conversation/ToolCallList.module.css::.state[data-status='succeeded']": 'the status word',
  "features/conversation/ToolCallList.module.css::.state[data-status='failed']": 'the status word',
  "features/conversation/ToolCallList.module.css::.state[data-status='unreadable']":
    'the status word',
  // `ToolCallList.tsx` draws `<p class=label>Error</p>` immediately above it.
  "features/conversation/ToolCallList.module.css::.block[data-error='true']":
    'the Error label above the block',
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
    // ANY LEFT EDGE ON `.error`, IN ANY SPELLING — READ AS A WIDTH RATHER THAN
    // MATCHED AS A SUBSTRING.
    //
    // Three versions of this guard banned a spelling, and each one left the
    // next spelling open. Replaying all three over this sheet with one
    // declaration injected into `.error`, PASS meaning the guard let it through
    // and red meaning the guard caught it:
    //
    //   spelling                          v1     v2     v3     this
    //   border-left-width: 3px            red    red    red    red
    //   border-left: 3px solid …          PASS   red    red    red
    //   border-width: 1px 1px 1px 3px     PASS   PASS   red    red
    //   border-inline-start-width: 3px    PASS   PASS   PASS   red
    //   border-inline-start: 3px solid …  PASS   PASS   PASS   red
    //   border-inline: 3px                PASS   PASS   PASS   red
    //   border: 3px solid … (all four)    PASS   PASS   PASS   red
    //
    // Each of those gives `.error` the same 3px left edge as `.ending` in this
    // LTR shell and collapses the two families the test exists to keep apart.
    // Logical properties are not exotic here either: `TitleBar.module.css`,
    // `CodeBlock.module.css` and `Markdown.module.css` already write
    // `margin-inline-*`. The comment on this spot claimed at v3 that there was
    // no third spelling. There were four.
    //
    // So this stops enumerating spellings and reads the **value**: on a rule
    // whose selector mentions `.error`, no property named `border…` except
    // `border-radius` may carry a length that is not 1px. Every spelling in the
    // table above is such a property carrying such a length, and so is every
    // border-width spelling CSS Backgrounds and Borders and CSS Logical
    // Properties define — which is the argument for why a spelling nobody has
    // written yet is refused as well. `.ending`'s own 3px is asserted above, so
    // the pair cannot be collapsed from the other side either.
    //
    // What it does not see, stated rather than left to be found: a declaration
    // in another sheet, and a rule in this one whose selector does not mention
    // `.error`. Comments are stripped first, because the prose above quotes the
    // declarations it is banning.
    const rules = text.replace(/\/\*[\s\S]*?\*\//gu, '');
    let errorRules = 0;
    let borderLengths = 0;
    for (const rule of rules.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      const selector = (rule[1] ?? '').trim();
      if (!/\.error\b/u.test(selector)) continue;
      errorRules += 1;
      for (const declaration of (rule[2] ?? '').split(';')) {
        const property = (declaration.split(':')[0] ?? '').trim();
        if (!property.startsWith('border') || property.startsWith('border-radius')) continue;
        for (const length of declaration.slice(property.length).match(LENGTH) ?? []) {
          borderLengths += 1;
          expect(length, `${selector} { ${property} } sets a border edge to ${length}`).toBe('1px');
        }
      }
    }
    // Two floors, because a scan that stopped matching would pass the loop
    // above in silence: the rules are still being found, and a width inside
    // them is still being read.
    expect(errorRules).toBeGreaterThanOrEqual(3);
    expect(borderLengths).toBeGreaterThanOrEqual(1);
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

  it('restates it in a property forced colours does not substitute', () => {
    // The point of the fix, stated as a rule: nothing inside a forced-colours
    // block may lean on a colour again. A `border-color` in there is the same
    // defect one level down — the exact failure mode this run exists for.
    //
    // Every sheet that has such a block, not a list somebody remembered to
    // extend: a new forced-colours block that reaches for a colour is exactly
    // the mistake this catches.
    //
    // THE RULE IS ABSOLUTE AND THE CHECK NOW IS TOO. It used to match a
    // six-name pattern while the sentence above said "a colour". Measured by
    // replaying that pattern over `Composer.module.css`'s block with one
    // declaration added to it, all six of `outline-color`, `caret-color`,
    // `text-decoration-color`, `accent-color`, `column-rule-color` and
    // `text-emphasis-color` passed. `outline-color` is the one with something
    // riding on it: that block deliberately leaves it unset so its dashed ring
    // inherits `currentColor` and is substituted along with the text, and
    // nothing here was enforcing that. The check now reads each declaration's
    // property and refuses any that {@link SUBSTITUTED} names — one definition,
    // two readers — less `opacity`, which a restatement may reach for.
    for (const name of stylesheets().filter((one) => sheet(one).includes('forced-colors'))) {
      const block = forcedColorsBlocks(sheet(name));
      expect(block.length, `${name} has no forced-colors block`).toBeGreaterThan(0);
      let properties = 0;
      for (const rule of block.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
        for (const declaration of (rule[2] ?? '').split(';')) {
          const property = (declaration.split(':')[0] ?? '').trim();
          if (property === '' || property === 'opacity') continue;
          properties += 1;
          expect(
            SUBSTITUTED.test(property),
            `${name} restates a distinction with ${property}, which forced colours substitutes`,
          ).toBe(false);
        }
      }
      // The floor: a block whose declarations stopped being found would pass
      // the loop above without reading anything.
      expect(properties, `${name}: no declaration was read`).toBeGreaterThan(0);
    }
  });
});
