/**
 * A markdown parser sized for model output, and for output that is still
 * arriving.
 *
 * ## Why hand-rolled
 *
 * Two reasons, both load-bearing. Vela ships offline with a strict CSP and no
 * CDN, so every byte of this is bundled anyway; and a general parser assumes a
 * *finished* document, while half of what this renders is a document with its
 * last line still being typed. An unclosed fence here is a code block that is
 * still open ({@link CodeBlock.open}), not three literal backticks that flip to
 * a code block a second later. That flip is the visible jank this file exists
 * to prevent.
 *
 * ## Scope
 *
 * Headings, paragraphs, fenced code, nested lists, block quotes, rules, pipe
 * tables; inline code, strong, emphasis, strikethrough and links. No raw HTML —
 * model output is untrusted text, and this surface renders it as text.
 *
 * ## Links
 *
 * Only `http:`, `https:` and `mailto:` survive as links. Anything else — most
 * importantly `javascript:` — renders as literal text with no anchor. The
 * renderer never builds an `href` it did not check.
 *
 * ## Why not `markdown.ts`
 *
 * It was, and that broke the app on every case-insensitive filesystem: the
 * renderer beside it is `Markdown.tsx`, Vite resolves `.ts` before `.tsx`, and
 * so `import { Markdown } from './Markdown'` bound *this* module — which
 * exports no `Markdown` — and Windows got a blank window. The two stems must
 * differ by more than case. `src/platform/case-collision.test.ts` holds that.
 */

export type Span =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'strong'; readonly spans: readonly Span[] }
  | { readonly kind: 'em'; readonly spans: readonly Span[] }
  | { readonly kind: 'strike'; readonly spans: readonly Span[] }
  | { readonly kind: 'link'; readonly href: string; readonly spans: readonly Span[] };

export interface CodeBlock {
  readonly kind: 'code';
  readonly language: string | null;
  readonly text: string;
  /** The fence has not been closed yet — the answer is still streaming. */
  readonly open: boolean;
}

export interface ListItem {
  readonly blocks: readonly Block[];
}

export type TableAlign = 'left' | 'center' | 'right';

export type Block =
  | { readonly kind: 'paragraph'; readonly spans: readonly Span[] }
  | { readonly kind: 'heading'; readonly level: number; readonly spans: readonly Span[] }
  | CodeBlock
  | {
      readonly kind: 'list';
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly ListItem[];
    }
  | { readonly kind: 'quote'; readonly blocks: readonly Block[] }
  | { readonly kind: 'rule' }
  | {
      readonly kind: 'table';
      readonly align: readonly TableAlign[];
      readonly header: readonly (readonly Span[])[];
      readonly rows: readonly (readonly (readonly Span[])[])[];
    };

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const RULE = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

export function parseMarkdown(source: string): Block[] {
  return parseBlocks(source.replace(/\r\n?/g, '\n').split('\n'));
}

function parseBlocks(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence !== null) {
      const [, , marker = '```', language = ''] = fence;
      const body: string[] = [];
      let closed = false;
      index += 1;
      while (index < lines.length) {
        const candidate = lines[index] ?? '';
        if (candidate.trimStart().startsWith(marker[0] ?? '`') && closesFence(candidate, marker)) {
          closed = true;
          index += 1;
          break;
        }
        body.push(candidate);
        index += 1;
      }
      blocks.push({
        kind: 'code',
        language: language === '' ? null : language,
        text: body.join('\n'),
        open: !closed,
      });
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({
        kind: 'heading',
        level: (heading[1] ?? '#').length,
        spans: parseInline((heading[2] ?? '').replace(/\s+#+\s*$/, '')),
      });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const match = QUOTE.exec(lines[index] ?? '');
        if (match === null) break;
        quoted.push(match[1] ?? '');
        index += 1;
      }
      blocks.push({ kind: 'quote', blocks: parseBlocks(quoted) });
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const list = parseList(lines, index);
      blocks.push(list.block);
      index = list.next;
      continue;
    }

    const table = parseTable(lines, index);
    if (table !== null) {
      blocks.push(table.block);
      index = table.next;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const candidate = lines[index] ?? '';
      if (
        candidate.trim() === '' ||
        FENCE.test(candidate) ||
        HEADING.test(candidate) ||
        RULE.test(candidate) ||
        QUOTE.test(candidate) ||
        BULLET.test(candidate) ||
        ORDERED.test(candidate)
      ) {
        break;
      }
      paragraph.push(candidate.trim());
      index += 1;
    }
    blocks.push({ kind: 'paragraph', spans: parseInline(paragraph.join('\n')) });
  }

  return blocks;
}

function closesFence(line: string, marker: string): boolean {
  const trimmed = line.trim();
  const char = marker[0] ?? '`';
  return trimmed.length >= marker.length && trimmed === char.repeat(trimmed.length);
}

function indentOf(line: string): number {
  return (/^\s*/.exec(line)?.[0] ?? '').length;
}

/**
 * Reads one list, recursing into anything indented under an item.
 *
 * Indentation, not a fixed depth: an item's continuation is every following
 * line indented past the marker, and those lines are parsed as blocks. That is
 * what makes a nested list, or a code block inside a bullet, work without a
 * special case for each.
 */
function parseList(lines: readonly string[], start: number): { block: Block; next: number } {
  const first = lines[start] ?? '';
  const ordered = ORDERED.test(first) && !BULLET.test(first);
  const baseIndent = indentOf(first);
  const startNumber = ordered ? Number.parseInt(ORDERED.exec(first)?.[2] ?? '1', 10) : 1;

  const items: ListItem[] = [];
  let index = start;
  let current: string[] | null = null;

  const commit = (): void => {
    if (current !== null) items.push({ blocks: parseBlocks(current) });
    current = null;
  };

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '') {
      // A blank line ends the list unless the next line continues an item.
      const next = lines[index + 1] ?? '';
      if (next.trim() === '' || indentOf(next) <= baseIndent) break;
      current?.push('');
      index += 1;
      continue;
    }

    const match = BULLET.exec(line) ?? ORDERED.exec(line);
    const isItem = match !== null && indentOf(line) <= baseIndent;
    if (isItem) {
      // A different marker family starts a different list.
      if (ORDERED.test(line) !== ordered && BULLET.test(line) === ordered) break;
      commit();
      current = [match[3] ?? ''];
      index += 1;
      continue;
    }

    if (indentOf(line) > baseIndent && current !== null) {
      current.push(line.slice(baseIndent + 2));
      index += 1;
      continue;
    }
    break;
  }
  commit();

  return { block: { kind: 'list', ordered, start: startNumber, items }, next: index };
}

function parseTable(lines: readonly string[], start: number): { block: Block; next: number } | null {
  const header = lines[start] ?? '';
  const divider = lines[start + 1] ?? '';
  if (!header.includes('|') || !TABLE_DIVIDER.test(divider) || !divider.includes('-')) return null;

  const headerCells = splitRow(header);
  const alignments = splitRow(divider).map<TableAlign>((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
  if (headerCells.length !== alignments.length) return null;

  const rows: (readonly Span[])[][] = [];
  let index = start + 2;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '' || !line.includes('|')) break;
    const cells = splitRow(line);
    rows.push(
      headerCells.map((_, column) => parseInline(cells[column] ?? '')),
    );
    index += 1;
  }

  return {
    block: {
      kind: 'table',
      align: alignments,
      header: headerCells.map((cell) => parseInline(cell)),
      rows,
    },
    next: index,
  };
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/* -------------------------------------------------------------------------- */
/* inline                                                                     */
/* -------------------------------------------------------------------------- */

const SAFE_SCHEMES = ['http:', 'https:', 'mailto:'];

/** `true` only for a scheme this surface is willing to put in an `href`. */
export function isSafeHref(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed.startsWith('#') || trimmed.startsWith('/')) return false;
  try {
    return SAFE_SCHEMES.includes(new URL(trimmed).protocol);
  } catch {
    return false;
  }
}

export function parseInline(source: string): Span[] {
  const spans: Span[] = [];
  let text = '';
  let index = 0;

  const flush = (): void => {
    if (text !== '') spans.push({ kind: 'text', text });
    text = '';
  };

  while (index < source.length) {
    const rest = source.slice(index);

    // Inline code first, and it never nests: a `**` inside backticks is two
    // asterisks, which is exactly what a model writing about markdown means.
    const code = /^(`+)([\s\S]*?)\1(?!`)/.exec(rest);
    if (code !== null) {
      flush();
      spans.push({ kind: 'code', text: (code[2] ?? '').replace(/^ | $/g, '') });
      index += code[0].length;
      continue;
    }

    const link = /^\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/.exec(rest);
    if (link !== null) {
      const href = link[2] ?? '';
      if (isSafeHref(href)) {
        flush();
        spans.push({ kind: 'link', href: href.trim(), spans: parseInline(link[1] ?? '') });
      } else {
        // Not a link Vela will build: kept in the running text run — verbatim,
        // and merged with its neighbours rather than becoming a second text
        // span the renderer would emit as a separate node.
        text += link[0];
      }
      index += link[0].length;
      continue;
    }

    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (strong !== null) {
      flush();
      spans.push({ kind: 'strong', spans: parseInline(strong[2] ?? '') });
      index += strong[0].length;
      continue;
    }

    const strike = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest);
    if (strike !== null) {
      flush();
      spans.push({ kind: 'strike', spans: parseInline(strike[1] ?? '') });
      index += strike[0].length;
      continue;
    }

    const em = /^([*_])(?=\S)([\s\S]*?\S)\1(?!\1)/.exec(rest);
    if (em !== null) {
      flush();
      spans.push({ kind: 'em', spans: parseInline(em[2] ?? '') });
      index += em[0].length;
      continue;
    }

    text += source[index] ?? '';
    index += 1;
  }

  flush();
  return spans;
}

/** The plain text of a span tree — used for copy affordances and for tests. */
export function spansToText(spans: readonly Span[]): string {
  return spans
    .map((span) => (span.kind === 'text' || span.kind === 'code' ? span.text : spansToText(span.spans)))
    .join('');
}
