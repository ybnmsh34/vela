/**
 * WHAT THE CODE WORKSPACE LOOKS LIKE WHEN THE SYSTEM TAKES THE COLOURS AWAY.
 *
 * Windows High Contrast does not adjust author colours; it discards them and
 * repaints from a system palette. Every `background`, `color` and
 * `border-color` in `CodeWorkspace.module.css` stops applying at the same
 * instant. Four critic reports in a row have raised that nothing in this
 * repository has an opinion about it, and no track had claimed it — so this
 * file claims it for `src/features/code/CodeWorkspace.module.css`, and for
 * nothing else. The forty other `*.module.css` files under `src/` still have no
 * `forced-colors` rule and this round does not give them one; that is stated in
 * the sheet, in the round's report, and here, rather than left to be inferred
 * from a test that only looks at one file.
 *
 * ## Why the universe is computed rather than listed
 *
 * A list of selectors to check is a list that shrinks: the next state signal
 * added to the sheet is simply not in it, and every assertion below still
 * passes. So {@link statefulRules} is a scan of the sheet itself — every rule
 * whose selector carries a state (`[data-…]`, `[aria-…]`, `:hover`,
 * `:focus-visible`, `:disabled`) and whose body paints that state with a colour
 * — and the law is that each one is either answered under `forced-colors` or
 * carries a written reason for not needing to be. Adding a fifth tinted state
 * to the sheet fails this file by name until one of the two is true of it.
 *
 * That shape is copied deliberately from `src/styles/contrast.test.ts`'s
 * `NOT_A_TEXT_GROUND`: an exemption list is honest only when the thing it
 * exempts from is a scan and not a hand-written roll.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SHEET = readFileSync(
  join(process.cwd(), 'src', 'features', 'code', 'CodeWorkspace.module.css'),
  'utf8',
);

interface Rule {
  readonly selector: string;
  readonly body: string;
}

/**
 * Every rule in one stretch of the sheet, as selector and body.
 *
 * Comments go first, because this sheet argues in prose and a `{` inside a
 * comment would split a rule in half.
 */
function rulesIn(source: string): readonly Rule[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: (match[1] ?? '').trim().replace(/\s+/g, ' '),
    body: (match[2] ?? '').trim(),
  }));
}

/** One at-rule block of the sheet, from its `@media` line to its closing brace. */
function blockAt(name: string): string {
  const start = SHEET.indexOf(`@media (${name}) {`);
  expect(start, `the sheet no longer has an @media (${name}) block`).toBeGreaterThan(0);
  // The block ends at the first `}` alone at the start of a line, which is how
  // every rule inside it is closed one indent further in.
  const end = SHEET.indexOf('\n}\n', start);
  expect(end, `the @media (${name}) block is unterminated`).toBeGreaterThan(start);
  return SHEET.slice(start, end);
}

const FORCED = blockAt('forced-colors: active');
const CONTRAST = blockAt('prefers-contrast: more');
const ORDINARY = SHEET.replace(FORCED, '').replace(CONTRAST, '');

/** Selectors the forced-colours block actually answers, one per selector. */
function answeredByForcedColours(): ReadonlySet<string> {
  const answered = new Set<string>();
  for (const rule of rulesIn(FORCED)) {
    for (const one of rule.selector.split(',')) answered.add(one.trim());
  }
  return answered;
}

/** A declaration that survives a forced palette: geometry or text, not a tint. */
const SURVIVES = /(?:^|[\s;])(?:border|outline|text-decoration|forced-color-adjust)[a-z-]*:/;

/** A declaration a forced palette overwrites. */
const IS_A_TINT = /(?:^|[\s;])(?:background|background-color|color|border-color):/;

/**
 * A state signal that needs no forced-colours answer, and why.
 *
 * The reason is the point. An exemption without one is the same thing as an
 * omission, which is the note `contrast.test.ts` makes about its own list.
 */
const NEEDS_NO_ANSWER: Record<string, string> = {
  ".pane[data-focused='true']":
    'already an outline — outlines are repainted by the UA, not discarded',
  '.diffLine:focus-visible':
    'already an outline, and the UA draws its own focus ring in forced-colors besides',
  '.fileRow:hover': 'pointer feedback for a pointer that is already on the row',
  '.paneButton:hover:not(:disabled)': 'pointer feedback, not a state to be read',
  '.moveItem:hover:not(:disabled)': 'pointer feedback, not a state to be read',
  '.splitterVertical:hover, .splitterHorizontal:hover':
    'pointer feedback, and the splitter keeps its two borders either way',
  '.primary:hover:not(:disabled)': 'pointer feedback, not a state to be read',
  '.paneButton:disabled': 'the UA forces GrayText on a disabled control in forced-colors',
  '.moveItem:disabled': 'the UA forces GrayText on a disabled control in forced-colors',
  '.primary:disabled': 'the UA forces GrayText on a disabled control in forced-colors',
};

/** Every rule outside the two at-rule blocks that paints a *state* with colour. */
function statefulRules(): readonly Rule[] {
  return rulesIn(ORDINARY).filter(
    (rule) =>
      /\[(?:data-|aria-)|:hover|:focus-visible|:disabled/.test(rule.selector) &&
      IS_A_TINT.test(rule.body),
  );
}

describe('the code workspace under a forced palette', () => {
  it('has a sheet, two at-rule blocks and rules inside them to check', () => {
    // A scan that silently stopped finding anything would pass every assertion
    // below while checking nothing at all — the failure mode this file exists
    // to close in the first place.
    expect(SHEET.length).toBeGreaterThan(1000);
    expect(rulesIn(ORDINARY).length).toBeGreaterThan(50);
    expect(rulesIn(FORCED).length).toBeGreaterThan(0);
    expect(rulesIn(CONTRAST).length).toBeGreaterThan(0);
    expect(statefulRules().length).toBeGreaterThan(5);
  });

  it('answers every state it paints with a colour, or says why it need not', () => {
    const answered = answeredByForcedColours();
    const unanswered = statefulRules()
      .map((rule) => rule.selector)
      .filter(
        (selector) =>
          NEEDS_NO_ANSWER[selector] === undefined &&
          !selector.split(',').every((one) => answered.has(one.trim())),
      );
    expect(
      unanswered,
      'High Contrast discards this tint and nothing replaces it: give it a rule under @media (forced-colors: active), or exempt it with a reason in NEEDS_NO_ANSWER',
    ).toEqual([]);
  });

  it('answers each of them with something a forced palette cannot take away', () => {
    // A `forced-colors` rule that only re-states a colour is worse than none: it
    // reads as an answer and is discarded exactly like the declaration it was
    // written to replace.
    const tints = rulesIn(FORCED)
      .filter((rule) => !SURVIVES.test(rule.body))
      .map((rule) => `${rule.selector} — ${rule.body.replace(/\s+/g, ' ')}`);
    expect(
      tints,
      'a forced palette overwrites this too; answer with a border, an outline, an underline, or forced-color-adjust',
    ).toEqual([]);
  });

  it('every exemption names a rule the sheet still has', () => {
    // The other half of an exemption list: an entry for a selector that has been
    // renamed or deleted silently exempts nothing and hides the next omission.
    const present = new Set(rulesIn(ORDINARY).map((rule) => rule.selector));
    expect(Object.keys(NEEDS_NO_ANSWER).filter((one) => !present.has(one))).toEqual([]);
  });

  it('keeps the live region present to a screen reader, not merely invisible', () => {
    // Round 6 added `.srOnly` and argued in a comment that it uses `clip-path`
    // rather than `display: none`, "which for a live region means it is never
    // announced". A critic replaced the whole rule with `display: none` and the
    // full suite stayed green — the invariant was stated and guarded by
    // nothing. This is the guard. `role="status"` in DiffPane.tsx is what wears
    // the class, and `speaks the second removal even when it produces the same
    // sentence as the first` is what proves the region is live at all.
    const rule = rulesIn(ORDINARY).find((candidate) => candidate.selector === '.srOnly');
    expect(rule, 'the visually-hidden rule the live region wears').toBeDefined();
    const body = (rule?.body ?? '').replace(/\s+/g, ' ');
    expect(body).toContain('clip-path:');
    for (const banned of ['display: none', 'visibility: hidden', 'content-visibility: hidden']) {
      expect(
        body,
        `${banned} takes the text out of the accessibility tree along with the pixels`,
      ).not.toContain(banned);
    }
  });

  it('asks for more contrast without inventing a value for it', () => {
    // `prefers-contrast` is not `forced-colors`: the palette is still the
    // author's, so this block may only reach for tokens the sheet already has.
    // A raw colour here would be a new value, which the palette freeze forbids
    // and `src/styles/design-system.test.ts` catches sheet-wide; what that scan
    // cannot say is that this block spends itself on hairlines rather than on
    // text, which is where the sheet has the least separation to give.
    for (const rule of rulesIn(CONTRAST)) {
      for (const declaration of rule.body.split(';').filter((one) => one.trim() !== '')) {
        expect(
          declaration.trim(),
          `${rule.selector} should raise a hairline, not a text colour`,
        ).toMatch(/^border-[a-z-]*color: var\(--vela-border-strong\)$/);
      }
    }
  });

  it('the scans catch the shapes they exist to catch', () => {
    // Every assertion above passes when its pattern stops matching, so each
    // pattern is checked against the real shape it is for.
    expect(SURVIVES.test('border-inline-start: 1px solid CanvasText;')).toBe(true);
    expect(SURVIVES.test('outline: var(--vela-focus-ring);')).toBe(true);
    expect(SURVIVES.test('text-decoration: underline;')).toBe(true);
    expect(SURVIVES.test('background: var(--vela-row-selected);')).toBe(false);
    expect(SURVIVES.test('color: var(--vela-danger);')).toBe(false);
    expect(IS_A_TINT.test('background: var(--vela-accent-quiet);')).toBe(true);
    expect(IS_A_TINT.test('color: var(--vela-danger);')).toBe(true);
    expect(IS_A_TINT.test('border-inline-start: 1px solid CanvasText;')).toBe(false);
  });
});
