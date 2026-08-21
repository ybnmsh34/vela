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
 * **Transient states are out.** `:hover`, `:focus`, `:focus-visible` and
 * `:active` are excluded: the pointer or the focus ring is itself the signal,
 * and demanding a second one on all thirty-odd of them is noise that would bury
 * the states that are genuinely invisible.
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
 */
const SUBSTITUTED =
  /^(color|background|background-color|[a-z-]*border[a-z-]*-color|fill|stroke|box-shadow|opacity)$/u;

/** A state spelled as an attribute. See the header for what this does not see. */
const ATTRIBUTE_STATE = /\[(data-|aria-)[^\]]*\]/u;

/** The pointer and the focus ring are their own signal. */
const TRANSIENT = /:(hover|focus|focus-within|focus-visible|active)\b/u;

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
    // ANY LEFT EDGE ON `.error`, NOT ONLY THE LONGHAND. This read
    // `border-left-width` alone, which a `border-left: 3px solid …` shorthand
    // walks straight past — it would give `.error` the same 3px edge as
    // `.ending`, collapse the two families back into two boxes under forced
    // colours, and redden nothing. Measured against a sheet with that shorthand
    // added to `.error`: the old pattern returns false, this one returns true.
    //
    // It covers the `border-left` shorthand and the `border-left-*` longhands.
    expect(text).not.toMatch(/\.error\s*\{[^}]*border-left/u);

    // AND THE FOUR-VALUE HOLE THIS COMMENT USED TO LEAVE OPEN. The line above
    // reads a substring, so a four-value `border-width` — 1px on three sides
    // and 3px on the fourth — set the same left edge without ever writing
    // `border-left`, and reddened nothing. Both spellings are refused now, on
    // every rule in this sheet whose selector mentions `.error` rather than on
    // the bare `.error {` rule alone. There is no third spelling: the `border`
    // shorthand takes one width for all four sides, so it cannot single an edge
    // out. Comments are stripped first, because this file's own prose quotes
    // the declaration it is banning.
    const rules = text.replace(/\/\*[\s\S]*?\*\//gu, '');
    let errorRules = 0;
    for (const rule of rules.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      const selector = (rule[1] ?? '').trim();
      if (!/\.error\b/u.test(selector)) continue;
      errorRules += 1;
      expect(rule[2] ?? '', `${selector} gives itself a left edge`).not.toMatch(
        /border-left|border-width/u,
      );
    }
    // A scan that stopped finding the rules would pass the loop above silently.
    expect(errorRules).toBeGreaterThanOrEqual(3);
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
    for (const name of stylesheets().filter((one) => sheet(one).includes('forced-colors'))) {
      const block = forcedColorsBlocks(sheet(name));
      expect(block.length, `${name} has no forced-colors block`).toBeGreaterThan(0);
      expect(block, `${name} restates a distinction with a colour`).not.toMatch(
        /(^|[\s;{])(color|background|background-color|[a-z-]*border[a-z-]*-color|fill|stroke|box-shadow)\s*:/u,
      );
    }
  });
});
