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
 * ## The scan, and why it is not the assertion
 *
 * The obvious guard is: *find every rule whose body contains only colour
 * properties and whose selector encodes a state, and demand a forced-colours
 * restatement.* That scan finds sixteen rules in six sheets. It is the wrong
 * question, and running it is how that became clear — most of those sixteen are
 * **already legible** with every colour removed, because the distinction is also
 * in the content:
 *
 *  - `ToolCallList` `.state[data-status]` prints `statusLabel(view.status)` as
 *    words inside the pill.
 *  - `EmptyConversation` `.capability[data-available]` renders `✓` or `—`.
 *  - `CanvasPanel` `.diffRow[data-kind]` prefixes each row with `+`, `-` or a
 *    space.
 *
 * A guard built on the narrow question would have demanded a dashed border on
 * all three, which is noise, and — worse — would have reported the surface as
 * covered while saying nothing about a state that really is colour alone. So the
 * scan lives here as a *finder*, and what is asserted is the thing that matters:
 * the sheets this track fixed restate their distinction in a property forced
 * colours does not touch.
 *
 * ## What this file does NOT claim
 *
 * It does not claim the shell supports forced colours. It covers three sheets.
 * `CanvasPanel .tab[aria-selected='true']` and `DocumentPreview .diagnostics
 * li[data-severity]` are, as far as this scan and a reading of their markup can
 * tell, still colour-alone, and are left to whoever owns those surfaces. Focus
 * rings, transparent borders, `background: none` controls and the inline SVG
 * glyphs across the shell are not examined here at all.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

function sheet(relative: string): string {
  return readFileSync(join(SRC, relative), 'utf8');
}

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
    const block = forcedColorsBlocks(sheet('features/conversation/MessageTurn.module.css'));
    expect(block).toContain(".ending[data-tone='warning']");
    // The stopped/failed pair has the same problem and is restated in the same
    // property, so all four boxes on a turn stay distinguishable.
    expect(block).toContain(".error[data-kind='stopped']");
  });

  it('keeps the rail saying where you are', () => {
    // This is the one in the scan that is genuinely colour-alone: `aria-current`
    // reaches a screen reader, and nothing reaches a sighted user in a
    // forced-colours mode once `--vela-surface` and `--vela-text` are replaced.
    const block = forcedColorsBlocks(sheet('features/navigation/Sidebar.module.css'));
    expect(block).toContain("[aria-current='page']");
    expect(block).toMatch(/border-style:\s*dashed/u);
  });

  it('restates it in a property forced colours does not substitute', () => {
    // The point of the fix, stated as a rule: nothing inside a forced-colours
    // block may lean on a colour again. A `border-color` in there is the same
    // defect one level down — the exact failure mode this run exists for.
    for (const name of [
      'features/conversation/TurnNotices.module.css',
      'features/conversation/MessageTurn.module.css',
      'features/navigation/Sidebar.module.css',
    ]) {
      const block = forcedColorsBlocks(sheet(name));
      expect(block.length, `${name} has no forced-colors block`).toBeGreaterThan(0);
      expect(block, `${name} restates a distinction with a colour`).not.toMatch(
        /(^|[\s;{])(color|background|background-color|[a-z-]*border[a-z-]*-color|fill|stroke|box-shadow)\s*:/u,
      );
    }
  });
});
