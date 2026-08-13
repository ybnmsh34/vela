/**
 * THE PRIMARY READING SURFACE.
 *
 * ## Why this file exists
 *
 * A rendered markdown answer is the thing a Vela user spends nearly all of
 * their time looking at, and until now nothing looked at it. `markdown-parser.
 * test.ts` proves the block tree is correct; `ConversationSurface.test.tsx`
 * proves an answer arrives. Neither asks the question a reader asks, which is
 * whether the result can be *read*.
 *
 * A Phase C critic answered it: no typographic hierarchy — every heading level
 * rendered at one size, so a six-level document read as a flat one — and
 * mis-set wrapped prose. And **no screenshot in the entire Phase C evidence set
 * exercised this surface at all.** The second half matters as much as the
 * first: the evidence base could not see the main thing users look at.
 *
 * That verdict is PROVISIONAL — Linux WebKitGTK is not Windows WebView2 — but
 * "all six heading levels resolve to the same font size" and "a source line
 * break renders as a line break" are facts about the DOM and the stylesheet.
 * They are the same facts in every engine, so they are treated as real.
 *
 * ## Two halves, deliberately
 *
 * The DOM half renders the real component and asks what a reader gets. The
 * stylesheet half reads `Markdown.module.css` from disk and asks whether the
 * type scale exists at all — because a component test cannot see a stylesheet
 * that `css: false` never loaded, and "six headings render" is not the same
 * claim as "six headings look different".
 *
 * ## The fixture is shared with the gate, on purpose
 *
 * `tests/fixtures/rich-markdown-answer.md` is the same document the mock
 * endpoint streams for the gate's reading-surface case. The assertion here and
 * the screenshot there are then about one artifact rather than two that
 * resemble each other. It sits in a directory that belongs to neither side —
 * like `tests/parity/` — so this file names a fixture, never the harness.
 */

import { render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { Markdown } from './Markdown';
import { parseMarkdown, spansToText } from './markdown-parser';

const REPO_ROOT = process.cwd();

const RICH_ANSWER = readFileSync(
  join(REPO_ROOT, 'tests/fixtures/rich-markdown-answer.md'),
  'utf8',
);

const SHEET = readFileSync(
  join(REPO_ROOT, 'src/features/conversation/Markdown.module.css'),
  'utf8',
);

const TOKEN_SHEET = readFileSync(join(REPO_ROOT, 'src/styles/tokens.css'), 'utf8');

/** The declarations of every rule whose selector matches. Comments stripped. */
function declarationsOf(selector: RegExp): string[] {
  const withoutComments = SHEET.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  return rules
    .filter((rule) => selector.test((rule[1] ?? '').trim()))
    .flatMap((rule) =>
      (rule[2] ?? '')
        .split(';')
        .map((declaration) => declaration.trim())
        .filter((declaration) => declaration !== ''),
    );
}

function valueOf(selector: RegExp, property: string): string | null {
  const found = declarationsOf(selector)
    .map((declaration) => /^([a-z-]+)\s*:\s*(.+)$/.exec(declaration))
    .filter((match): match is RegExpExecArray => match !== null)
    .filter((match) => match[1] === property)
    .at(-1);
  return found?.[2] ?? null;
}

/**
 * The canonical rule for a heading level — anchored, so it reads the scale
 * itself and not a later, narrower override. `valueOf` takes the last matching
 * declaration; without the anchor, adding `.prose[data-scale='aside']
 * .heading[data-level='1']` would silently redirect this whole describe block
 * at the subordinate scale and assert the wrong document.
 */
function headingLevelRule(level: number): RegExp {
  return new RegExp(`^\\.heading\\[data-level=['"]${String(level)}['"]\\]$`);
}

function headingSize(level: number): string | null {
  return valueOf(headingLevelRule(level), 'font-size') ?? valueOf(/^\.heading$/, 'font-size');
}

/** `--vela-text-*` in px, at the 16px root the app actually runs at. */
function typeScale(): Map<string, number> {
  const out = new Map<string, number>();
  for (const match of TOKEN_SHEET.matchAll(/^\s*(--vela-text-[a-z0-9-]+):\s*([0-9.]+)rem;/gm)) {
    out.set(match[1] ?? '', Number.parseFloat(match[2] ?? '0') * 16);
  }
  return out;
}

function sizePx(value: string | null): number {
  const token = /^var\((--vela-text-[a-z0-9-]+)\)$/.exec(value ?? '')?.[1] ?? '';
  const px = typeScale().get(token);
  expect(px, `${String(value)} is not a step on the type scale`).toBeDefined();
  return px ?? 0;
}

/** `--vela-weight-*` as numbers, for the one comparison that decides rank. */
function weightScale(): Map<string, number> {
  const out = new Map<string, number>();
  for (const match of TOKEN_SHEET.matchAll(/^\s*(--vela-weight-[a-z]+):\s*([0-9]+);/gm)) {
    out.set(match[1] ?? '', Number.parseInt(match[2] ?? '0', 10));
  }
  return out;
}

function weightOf(value: string | null): number {
  const token = /^var\((--vela-weight-[a-z]+)\)$/.exec(value ?? '')?.[1] ?? '';
  const weight = weightScale().get(token);
  expect(weight, `${String(value)} is not a step on the weight scale`).toBeDefined();
  return weight ?? 0;
}

function prose(): HTMLElement {
  const node = document.querySelector('[data-testid="markdown"], .prose') ?? document.body;
  return node as HTMLElement;
}

describe('the rendered answer has a typographic hierarchy', () => {
  it('gives every heading level its own size, from one type scale', () => {
    // The defect in one assertion. Six levels sharing one `font-size` is a
    // document with no shape: the reader cannot tell a section from a
    // sub-sub-section, and a long answer becomes a wall.
    const sizes = [1, 2, 3, 4, 5, 6].map((level) => headingSize(level));

    expect(sizes, 'every heading level needs its own rule in Markdown.module.css').not.toContain(
      null,
    );
    expect(new Set(sizes).size, 'a scale is distinct steps, not one size repeated').toBeGreaterThan(
      3,
    );
    for (const size of sizes) {
      expect(size, 'type sizes are --vela-text-* steps, never a raw value').toMatch(
        /^var\(--vela-text-[a-z0-9-]+\)$/,
      );
    }
  });

  it('carries the level into the DOM so the stylesheet can reach it', () => {
    // `h2`…`h6` cannot express six levels — the sixth clamps — and a class per
    // level would put the scale in two places. One attribute, read by both.
    render(<Markdown source={'# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six'} />);
    for (const [level, text] of [
      [1, 'One'],
      [2, 'Two'],
      [3, 'Three'],
      [4, 'Four'],
      [5, 'Five'],
      [6, 'Six'],
    ] as const) {
      expect(screen.getByText(text)).toHaveAttribute('data-level', String(level));
    }
  });

  it('sets headings tight and prose loose, from the shared leading steps', () => {
    // The two jobs have different answers and both are tokens: a heading set at
    // reading leading looks unglued from its own second line.
    expect(valueOf(/^\.heading$/, 'line-height')).toBe('var(--vela-leading-tight)');
    expect(valueOf(/^\.heading$/, 'letter-spacing')).toBe('var(--vela-tracking-tight)');
    expect(valueOf(/^\.prose$/, 'line-height')).toBe('var(--vela-leading-prose)');
  });

  it('sets monospace on its own tracking, inline and in blocks', () => {
    // Monospace sets too tight beside a proportional face; the token exists for
    // exactly this and `CodeBlock.module.css` already uses it.
    expect(valueOf(/\.inlineCode\b/, 'letter-spacing')).toBe('var(--vela-tracking-code)');
  });
});

describe('wrapped prose is prose, not a stack of short lines', () => {
  const WRAPPED = [
    'The endpoint reports a context window of 131,072 tokens, which is',
    'plenty for this conversation and for most of the ones after it, and',
    'it is the number the meter measures against.',
  ].join('\n');

  it('reflows a paragraph the model hard-wrapped in its source', () => {
    // Models hard-wrap at seventy-odd columns. Rendering those breaks verbatim
    // sets every paragraph ragged at the model's column width instead of the
    // reader's, and it is the single most visible thing wrong with the surface.
    render(<Markdown source={WRAPPED} />);
    const paragraph = screen.getByText(/The endpoint reports/u);

    expect(paragraph.tagName).toBe('P');
    expect(paragraph.textContent).not.toContain('\n');
    expect(paragraph.textContent).toBe(WRAPPED.split('\n').join(' '));
    expect(paragraph.querySelector('br')).toBeNull();
  });

  it('does not ask the stylesheet to preserve source line breaks', () => {
    // `white-space: pre-wrap` on a paragraph is what made the source's line
    // endings load-bearing. The user's own message keeps it — you wrote that,
    // and you should get it back exactly — but a rendered answer must not.
    expect(valueOf(/\.paragraph\b/, 'white-space')).not.toBe('pre-wrap');
  });

  it('still honours a deliberate hard break, both ways of writing one', () => {
    // The reason this is a parser change and not just a CSS change: reflowing
    // everything would silently destroy the one break the author *meant*.
    const { container } = render(<Markdown source={'Vela  \nis a workspace\\\nfor any model'} />);
    const paragraph = container.querySelector('p');

    expect(paragraph?.querySelectorAll('br')).toHaveLength(2);

    // `textContent` renders a `<br>` as nothing, which is why the span tree —
    // not the DOM — is what anything reading this as text must consult.
    const [block] = parseMarkdown('Vela  \nis a workspace\\\nfor any model');
    expect(block?.kind).toBe('paragraph');
    expect(spansToText(block?.kind === 'paragraph' ? block.spans : [])).toBe(
      'Vela\nis a workspace\nfor any model',
    );
  });

  it('keeps a blank line as a paragraph boundary, not a break', () => {
    render(<Markdown source={'First thought.\n\nSecond thought.'} />);
    expect(screen.getByText('First thought.').tagName).toBe('P');
    expect(screen.getByText('Second thought.').tagName).toBe('P');
    expect(screen.getByText('First thought.').querySelector('br')).toBeNull();
  });
});

describe('the long, rich answer the gate now screenshots', () => {
  it('renders every block kind the fixture exercises', () => {
    // The evidence case and this assertion read the same document. If the
    // screenshot shows something wrong, this is where it is reproduced.
    const { container } = render(<Markdown source={RICH_ANSWER} />);

    expect(container.querySelectorAll('h2, h3, h4, h5, h6').length).toBeGreaterThanOrEqual(6);
    expect(container.querySelectorAll('ul').length).toBeGreaterThanOrEqual(2);
    expect(container.querySelectorAll('ol').length).toBeGreaterThanOrEqual(1);
    // The nested list is the one a flat renderer silently flattens.
    expect(container.querySelector('ul ul')).not.toBeNull();
    expect(container.querySelectorAll('blockquote').length).toBe(1);
    expect(container.querySelectorAll('pre').length).toBe(1);
    expect(container.querySelectorAll('table').length).toBe(1);
    expect(container.querySelectorAll('hr').length).toBe(1);
    expect(container.querySelectorAll('code').length).toBeGreaterThan(5);
    expect(container.querySelectorAll('strong').length).toBeGreaterThan(2);
    expect(container.querySelectorAll('em').length).toBeGreaterThanOrEqual(1);
    expect(container.querySelectorAll('s').length).toBe(1);
  });

  it('reads as paragraphs, not as the model’s line endings', () => {
    render(<Markdown source={RICH_ANSWER} />);
    const opening = screen.getByText(/Short answer/u);
    expect(opening.textContent).not.toContain('\n');
    expect(opening.textContent).toContain('only move up if the quality gap');
  });

  it('gives the table its own scroll container, so the page never scrolls sideways', () => {
    // A wide table is the commonest way a reading surface breaks its own
    // layout, and the fixture has a five-column one.
    const { container } = render(<Markdown source={RICH_ANSWER} />);
    const table = container.querySelector('table');
    expect(table?.parentElement?.className).toBeTruthy();
    expect(valueOf(/\.tableWrap\b/, 'overflow-x')).toBe('auto');
  });

  it('opens links safely and never builds an unsafe href', () => {
    render(<Markdown source={RICH_ANSWER} />);
    const link = screen.getByRole('link', { name: /llama\.cpp server documentation/u });
    expect(link).toHaveAttribute('href', 'https://github.com/ggml-org/llama.cpp');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('exposes the DOM contract the gate reader depends on', () => {
    // `tests/harness/ui-bridge/checks.mjs#readingSurface` finds the prose
    // container structurally — the parent of the first `[data-level]` — and
    // reads body paragraphs as its direct `p` children. It runs in a browser
    // this suite cannot start, so the *shape* it relies on is pinned here
    // instead: a refactor that moves the headings out of the prose container
    // would otherwise break the gate silently, and only on the machine that
    // runs it.
    const { container } = render(<Markdown source={RICH_ANSWER} />);
    const firstHeading = container.querySelector('[data-level]');
    expect(firstHeading).not.toBeNull();

    const prose = firstHeading?.parentElement ?? null;
    expect(prose).not.toBeNull();
    expect(prose?.querySelectorAll(':scope > p').length ?? 0).toBeGreaterThan(2);
    expect(prose?.querySelectorAll('[data-level]').length ?? 0).toBeGreaterThanOrEqual(6);
    // The same filter the reader uses for inline code, for the same reason.
    const inline = [...(prose?.querySelectorAll('code') ?? [])].filter(
      (node) => node.closest('pre') === null,
    );
    expect(inline.length).toBeGreaterThan(5);
  });

  it('keeps the streaming caret on the last paragraph and nowhere else', () => {
    // The one rule the type scale must not break: the caret is what says an
    // answer is still arriving rather than finished and short.
    const { container } = render(<Markdown source={'Still going'} streaming />);
    expect(container.querySelector('[data-streaming="true"]')).not.toBeNull();
    expect(container.querySelector('p[data-last="true"]')).not.toBeNull();
  });
});

describe('the reading surface is typed end to end', () => {
  it('gives lists, quotes and tables a rule of their own', () => {
    // Not "does it look nice" — whether each block kind was answered at all.
    // Anything with no rule falls back to the browser's defaults, which are
    // sized against 16px Times and belong to no design system.
    for (const part of ['.list', '.item', '.quote', '.table', '.inlineCode', '.link']) {
      expect(
        declarationsOf(new RegExp(part.replace('.', '\\.') + '\\b')).length,
        `${part} has no rule in Markdown.module.css`,
      ).toBeGreaterThan(0);
    }
  });

  it('reads its measure and rhythm from tokens, never from raw values', () => {
    // `design-system.test.ts` scans every sheet for this; asserted again here
    // because this is the sheet a type scale is most likely to be smuggled into.
    const raw = SHEET.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(raw).not.toMatch(/font-size:\s*[0-9.]+(px|rem)/);
    expect(raw).not.toMatch(/line-height:\s*[0-9.]/);
    expect(raw).not.toMatch(/letter-spacing:\s*-?[0-9.]/);
  });

  it('renders nothing through innerHTML, at any level', () => {
    // Model output is untrusted text. The scale changes how it is *set*; it
    // must not change how it is built.
    // The prop, not the word: this component's own doc comment names it in
    // order to forbid it, and a scan that cannot tell those apart would fail on
    // the sentence that promises the thing it is checking for.
    const source = readFileSync(join(REPO_ROOT, 'src/features/conversation/Markdown.tsx'), 'utf8');
    expect(source).not.toMatch(/dangerouslySetInnerHTML\s*=/);
    render(<Markdown source={'<img src=x onerror="alert(1)"> **after**'} />);
    expect(within(prose()).queryByRole('img')).toBeNull();
    expect(document.body.textContent).toContain('<img src=x onerror="alert(1)">');
  });
});


/**
 * THE SCALE BELOW h3 — the half of the hierarchy the first pass got wrong.
 *
 * Levels 1–3 were given real size steps and levels 4–6 were left where the
 * interface scale happened to put them: `h4` at body size, `h5` and `h6`
 * *smaller* than the prose they head. A heading set smaller than its own body
 * text is not a quiet heading, it is a caption — and every one of them was
 * `--vela-weight-semibold` (600) while an unclassed `<strong>` inherits the
 * user agent's 700, so `**a bold run**` in a paragraph outranked every heading
 * below `h3`. The document's own emphasis outweighed its structure.
 *
 * No screenshot in the evidence set rendered `h1`, `h3`, `h4`, `h5` or `h6`, so
 * the finding had to be read out of the source. `tests/fixtures/
 * heading-scale-answer.md` exists so that is never true again: it is rendered
 * here and screenshotted by the gate.
 */
describe('the scale does not collapse below h3', () => {
  const LEVELS = [1, 2, 3, 4, 5, 6] as const;

  it('never sets a heading smaller than the text it heads', () => {
    const body = sizePx(valueOf(/^\.prose$/, 'font-size'));
    const undersized = LEVELS.map((level) => ({ level, px: sizePx(headingSize(level)) }))
      .filter(({ px }) => px < body)
      .map(({ level, px }) => `h${String(level)} at ${String(px)}px under ${String(body)}px of body text`);
    expect(undersized, 'a heading smaller than its own paragraphs is a caption').toEqual([]);
  });

  it('descends — a deeper level is never larger than a shallower one', () => {
    const sizes = LEVELS.map((level) => sizePx(headingSize(level)));
    const inversions = sizes
      .map((px, index) => ({ px, index }))
      .filter(({ px, index }) => index > 0 && px > (sizes[index - 1] ?? 0))
      .map(({ index }) => `h${String(index + 1)} is larger than h${String(index)}`);
    expect(inversions).toEqual([]);
  });

  it('separates levels that share a size by something a reader can see', () => {
    // Four sizes at or above body text cannot express six levels, and steps
    // fine enough to try would be steps nobody can see. Levels that share a
    // size must differ in weight, colour, case or rhythm instead — which is how
    // a type scale is supposed to work anyway. What is forbidden is two levels
    // that are identical in every respect.
    const DEVICES = ['font-size', 'font-weight', 'color', 'text-transform', 'letter-spacing', 'margin-top'] as const;
    const fingerprint = (level: number): string =>
      DEVICES.map((device) => valueOf(headingLevelRule(level), device) ?? `inherit:${device}`).join('|');

    const collisions = LEVELS.slice(1)
      .filter((level) => fingerprint(level) === fingerprint(level - 1))
      .map((level) => `h${String(level)} is indistinguishable from h${String(level - 1)}`);
    expect(collisions).toEqual([]);
  });

  it('outranks the emphasis inside it — a bold run never beats a heading', () => {
    // The inversion, stated as the comparison that produces it. `<strong>` is
    // unclassed by design (`Markdown.tsx` renders the element, not a class), so
    // without a rule it inherits the user agent's 700 and wins.
    const strong = weightOf(valueOf(/\.prose\s+strong\b/, 'font-weight'));
    const heading = weightOf(valueOf(/^\.heading$/, 'font-weight'));
    expect(
      heading,
      `a bold run sets at ${String(strong)} and the weakest heading at ${String(heading)}`,
    ).toBeGreaterThan(strong);
  });

  it('does not then weaken a bold run inside a heading', () => {
    // The correction pointed the wrong way: if `strong` is lighter than a
    // heading, `## a **bold** word` would set that word lighter than the rest
    // of its own heading. Inside a heading, emphasis inherits.
    expect(valueOf(/\.heading\s+strong\b/, 'font-weight')).toBe('inherit');
  });

  it('renders all six levels and a bold run from the shared fixture', () => {
    const source = readFileSync(join(REPO_ROOT, 'tests/fixtures/heading-scale-answer.md'), 'utf8');
    render(<Markdown source={source} />);
    for (const level of LEVELS) {
      expect(
        document.querySelector(`[data-level="${String(level)}"]`),
        `the fixture must exercise h${String(level)}; that gap is why this defect was source-read`,
      ).not.toBeNull();
    }
    expect(document.querySelectorAll('strong').length).toBeGreaterThan(0);
    // A bold run must sit *beside* a deep heading in the document, or the
    // screenshot cannot show the comparison this whole block is about.
    for (const level of [5, 6] as const) {
      const deep = document.querySelector(`[data-level="${String(level)}"]`);
      expect(
        deep?.nextElementSibling?.querySelectorAll('strong').length ?? 0,
        `h${String(level)} needs a bold run directly beneath it, or the screenshot cannot show the comparison`,
      ).toBeGreaterThan(0);
    }
  });
});

/**
 * THE SUBORDINATE SCALE.
 *
 * Routing the thinking block through `<Markdown>` raised a question the answer
 * channel never had to answer: reasoning is *subordinate*, so it cannot simply
 * borrow the answer's display sizes — an `h1` inside a collapsed aside would
 * set larger than the answer it is reasoning about. One prop, two scales.
 */
describe('an aside renders markdown without borrowing the answer’s voice', () => {
  it('offers a scale, and defaults to the answer’s', () => {
    render(<Markdown source={'# Heading\n\ntext'} />);
    expect(document.querySelector('[data-scale]')).toHaveAttribute('data-scale', 'answer');
  });

  it('marks the aside so a reader — human or gate — can tell the channels apart', () => {
    render(<Markdown source={'# Heading\n\ntext'} scale="aside" />);
    expect(document.querySelector('[data-scale]')).toHaveAttribute('data-scale', 'aside');
  });

  it('never lets anything in an aside set larger than the answer’s body text', () => {
    const body = sizePx(valueOf(/^\.prose$/, 'font-size'));
    const asideSizes = declarationsOf(/\[data-scale=['"]aside['"]\]/)
      .map((declaration) => /^font-size\s*:\s*(.+)$/.exec(declaration)?.[1] ?? null)
      .filter((value): value is string => value !== null);
    expect(asideSizes.length, 'the aside scale must actually resize something').toBeGreaterThan(0);
    for (const size of asideSizes) {
      expect(sizePx(size), `${size} is louder than the answer`).toBeLessThanOrEqual(body);
    }
  });
});
