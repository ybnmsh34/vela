import { describe, expect, it } from 'vitest';

import { isSafeHref, parseInline, parseMarkdown, spansToText, type Block } from './markdown';

function only(source: string): Block {
  const blocks = parseMarkdown(source);
  expect(blocks).toHaveLength(1);
  return blocks[0] as Block;
}

describe('markdown blocks', () => {
  it('reads a fenced code block with its language', () => {
    const block = only('```rust\nfn main() {}\n```');
    expect(block).toEqual({ kind: 'code', language: 'rust', text: 'fn main() {}', open: false });
  });

  /**
   * The streaming property: the closing fence has not arrived yet, and the
   * block must already be a code block. Reporting `open` is what lets the view
   * avoid flipping between literal backticks and a rendered block mid-answer.
   */
  it('reports an unclosed fence as an open code block rather than literal text', () => {
    const block = only('```python\nprint("half a fi');
    expect(block).toMatchObject({ kind: 'code', language: 'python', open: true });
  });

  it('keeps a fence with no language rather than guessing one', () => {
    expect(only('```\nplain\n```')).toMatchObject({ language: null });
  });

  it('does not close a fence on a longer marker of a different kind', () => {
    const block = only('~~~\ncontains ``` inside\n~~~');
    expect(block).toMatchObject({ kind: 'code', text: 'contains ``` inside', open: false });
  });

  it('parses headings, rules and quotes', () => {
    expect(only('## Title')).toMatchObject({ kind: 'heading', level: 2 });
    expect(only('---')).toEqual({ kind: 'rule' });
    expect(only('> quoted')).toMatchObject({ kind: 'quote' });
  });

  it('parses a bullet list and its nested list', () => {
    const block = only(['- one', '- two', '  - nested', '- three'].join('\n'));
    expect(block.kind).toBe('list');
    if (block.kind !== 'list') return;
    expect(block.items).toHaveLength(3);
    const second = block.items[1]?.blocks ?? [];
    expect(second[1]).toMatchObject({ kind: 'list' });
  });

  it('keeps an ordered list’s starting number', () => {
    const block = only('3. third\n4. fourth');
    expect(block).toMatchObject({ kind: 'list', ordered: true, start: 3 });
  });

  it('parses a pipe table with alignments', () => {
    const block = only(['| a | b |', '| :- | --: |', '| 1 | 2 |'].join('\n'));
    expect(block.kind).toBe('table');
    if (block.kind !== 'table') return;
    expect(block.align).toEqual(['left', 'right']);
    expect(block.rows).toHaveLength(1);
    expect(spansToText(block.rows[0]?.[1] ?? [])).toBe('2');
  });

  it('does not mistake a line with a pipe in it for a table', () => {
    expect(only('a | b is not a table')).toMatchObject({ kind: 'paragraph' });
  });

  it('separates paragraphs on blank lines', () => {
    expect(parseMarkdown('one\n\ntwo')).toHaveLength(2);
  });
});

describe('markdown inline', () => {
  it('parses emphasis, strong, strike and inline code', () => {
    expect(parseInline('*a*')).toEqual([{ kind: 'em', spans: [{ kind: 'text', text: 'a' }] }]);
    expect(parseInline('**a**')).toEqual([{ kind: 'strong', spans: [{ kind: 'text', text: 'a' }] }]);
    expect(parseInline('~~a~~')).toEqual([{ kind: 'strike', spans: [{ kind: 'text', text: 'a' }] }]);
    expect(parseInline('`a`')).toEqual([{ kind: 'code', text: 'a' }]);
  });

  it('does not read markup inside inline code', () => {
    // A model explaining markdown writes this constantly.
    expect(parseInline('`**not bold**`')).toEqual([{ kind: 'code', text: '**not bold**' }]);
  });

  it('leaves an unterminated emphasis run as literal text', () => {
    // Mid-stream, half a bold run is normal and must not restyle the answer.
    expect(spansToText(parseInline('**half a bold run'))).toBe('**half a bold run');
    expect(parseInline('**half a bold run').every((span) => span.kind === 'text')).toBe(true);
  });

  it('builds a link only for a scheme it is willing to open', () => {
    expect(isSafeHref('https://example.test')).toBe(true);
    expect(isSafeHref('mailto:a@example.test')).toBe(true);
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('data:text/html,<script>')).toBe(false);
    expect(isSafeHref('file:///etc/passwd')).toBe(false);
  });

  it('renders an unsafe link as the literal text the model wrote', () => {
    const spans = parseInline('[click](javascript:alert(1))');
    expect(spans).toEqual([{ kind: 'text', text: '[click](javascript:alert(1))' }]);
    expect(spans.some((span) => span.kind === 'link')).toBe(false);
  });

  it('parses a safe link with its label', () => {
    expect(parseInline('[docs](https://example.test/x)')).toEqual([
      { kind: 'link', href: 'https://example.test/x', spans: [{ kind: 'text', text: 'docs' }] },
    ]);
  });
});

describe('markdown while streaming', () => {
  /**
   * The jank test. Growing the source one character at a time must never make
   * the *finished* prefix of the document change shape — only the last block
   * may still be in flux.
   */
  it('never re-classifies a completed block as more text arrives', () => {
    const source = '# Title\n\nSome **bold** text.\n\n```ts\nconst x = 1;\n```\n\nAfter.';
    let previous: Block[] = [];
    for (let length = 1; length <= source.length; length += 1) {
      const blocks = parseMarkdown(source.slice(0, length));
      const settled = blocks.slice(0, -1);
      for (let index = 0; index < settled.length && index < previous.length - 1; index += 1) {
        expect(settled[index]?.kind).toBe(previous[index]?.kind);
      }
      previous = blocks;
    }
    expect(previous.map((block) => block.kind)).toEqual([
      'heading',
      'paragraph',
      'code',
      'paragraph',
    ]);
  });
});
