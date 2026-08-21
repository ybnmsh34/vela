/**
 * Renders the block tree from `markdown-parser.ts`.
 *
 * Every node is a React element built from parsed data — there is no
 * `dangerouslySetInnerHTML` anywhere in this feature, and there must never be
 * one. Model output is untrusted text; it is rendered as text.
 */

import { memo } from 'react';

import { CodeBlock, type CodePlace } from './CodeBlock';
import { parseMarkdown, type Block, type Span } from '@/lib/markdown-parser';
import styles from './Markdown.module.css';

/**
 * Which voice this document speaks in.
 *
 * `answer` is the primary reading surface. `aside` is a subordinate channel —
 * today the thinking block — and it exists because routing reasoning through
 * this component raised a question the answer channel never had to answer: the
 * display sizes belong to the answer, so an `h1` the model wrote *inside* its
 * own reasoning would set larger than the answer it is reasoning about.
 *
 * It is also how a reader tells the channels apart. `data-scale` is on the
 * container, so the gate's reading-surface reader can measure the answer
 * without a thinking block flattering the numbers.
 */
export type MarkdownScale = 'answer' | 'aside';

interface MarkdownProps {
  readonly source: string;
  /** Marks the last block as the live edge of a stream, for the caret. */
  readonly streaming?: boolean;
  readonly scale?: MarkdownScale;
  /**
   * What to call this document in the accessible name of each copy control it
   * draws — 'reply 2 of 3', 'the reasoning behind reply 2 of 3'.
   *
   * Two documents on one screen can hold fences in the same language, and the
   * copy control's name was a function of the language alone. See
   * {@link CodePlace}. Omitted by a caller that has nothing to say about which
   * document this is (`Markdown.test.tsx` renders one on its own), and then the
   * names fall back to the language, which is where they were.
   */
  readonly within?: string | undefined;
}

/**
 * Memoised on the source string. A streaming turn re-renders on every commit,
 * and every *other* turn in the list must not re-parse its markdown when it
 * does — that is the difference between a smooth stream and a list that stalls
 * as the conversation grows.
 */
export const Markdown = memo(function Markdown({
  source,
  streaming = false,
  scale = 'answer',
  within,
}: MarkdownProps) {
  const blocks = parseMarkdown(source);
  const places = codePlaces(blocks, within);
  return (
    <div
      className={styles.prose}
      data-scale={scale}
      data-streaming={streaming ? 'true' : undefined}
    >
      {blocks.map((block, index) => (
        <BlockNode
          key={index}
          block={block}
          last={index === blocks.length - 1}
          places={places}
        />
      ))}
    </div>
  );
});

/**
 * Every code block of a document, in reading order, with its position.
 *
 * Keyed by the block object because `parseMarkdown` builds a fresh literal per
 * fence — two fences are never one object, whatever their text — so this is an
 * identity map and not a content map. It walks into quotes and list items
 * because `BlockNode` renders a `CodeBlock` from those too: a fence inside a
 * bullet that this never reached would not be in the map at all, and an
 * unplaced fence falls back to the bare label, which is the collision. Measured
 * by cutting the two recursive branches out of the walk, against the document
 * `Markdown.test.tsx` builds from a top-level fence, a fence in a list item and
 * a fence in a quote: the three names collapse to
 * ["Copy ts code — in the reply", "Copy ts code", "Copy ts code"].
 */
function codePlaces(
  blocks: readonly Block[],
  within: string | undefined,
): ReadonlyMap<Block, CodePlace> {
  const fences: Block[] = [];
  const walk = (list: readonly Block[]): void => {
    for (const block of list) {
      if (block.kind === 'code') fences.push(block);
      else if (block.kind === 'quote') walk(block.blocks);
      else if (block.kind === 'list') for (const item of block.items) walk(item.blocks);
    }
  };
  walk(blocks);
  const places = new Map<Block, CodePlace>();
  fences.forEach((block, at) => {
    places.set(block, { index: at + 1, count: fences.length, within });
  });
  return places;
}

function BlockNode({
  block,
  last,
  places,
}: {
  readonly block: Block;
  readonly last: boolean;
  readonly places: ReadonlyMap<Block, CodePlace>;
}) {
  switch (block.kind) {
    case 'paragraph':
      return (
        <p className={styles.paragraph} data-last={last ? 'true' : undefined}>
          <Spans spans={block.spans} />
        </p>
      );

    case 'heading': {
      // The tag is the document outline: the answer sits inside the page, so
      // `#` is an `h2`. The *type scale* is `data-level`, because six markdown
      // levels do not fit into five available tags — `######` and `#####` both
      // clamp to `h6` — and because sizing off the tag would put the scale in
      // the stylesheet's selector list instead of in one place.
      const Tag = `h${String(Math.min(block.level + 1, 6))}` as 'h2';
      return (
        <Tag className={styles.heading} data-level={block.level}>
          <Spans spans={block.spans} />
        </Tag>
      );
    }

    case 'code':
      return (
        <CodeBlock
          language={block.language}
          text={block.text}
          open={block.open}
          place={places.get(block)}
        />
      );

    case 'rule':
      return <hr className={styles.rule} />;

    case 'quote':
      return (
        <blockquote className={styles.quote}>
          {block.blocks.map((child, index) => (
            <BlockNode key={index} block={child} last={false} places={places} />
          ))}
        </blockquote>
      );

    case 'list': {
      const items = block.items.map((item, index) => (
        <li key={index} className={styles.item}>
          {item.blocks.map((child, childIndex) => (
            <BlockNode key={childIndex} block={child} last={false} places={places} />
          ))}
        </li>
      ));
      return block.ordered ? (
        <ol className={styles.list} start={block.start}>
          {items}
        </ol>
      ) : (
        <ul className={styles.list}>{items}</ul>
      );
    }

    case 'table':
      return (
        // Its own scroll container: a wide table must never push the page
        // sideways.
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th key={index} style={{ textAlign: block.align[index] ?? 'left' }}>
                    <Spans spans={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} style={{ textAlign: block.align[cellIndex] ?? 'left' }}>
                      <Spans spans={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function Spans({ spans }: { readonly spans: readonly Span[] }) {
  return (
    <>
      {spans.map((span, index) => {
        switch (span.kind) {
          case 'text':
            return span.text;
          case 'break':
            return <br key={index} />;
          case 'code':
            return (
              <code key={index} className={styles.inlineCode}>
                {span.text}
              </code>
            );
          case 'strong':
            return (
              <strong key={index}>
                <Spans spans={span.spans} />
              </strong>
            );
          case 'em':
            return (
              <em key={index}>
                <Spans spans={span.spans} />
              </em>
            );
          case 'strike':
            return (
              <s key={index}>
                <Spans spans={span.spans} />
              </s>
            );
          case 'link':
            // `href` has already been checked against an allowlist of schemes
            // in `markdown-parser.ts`; anything else never becomes an anchor.
            return (
              <a
                key={index}
                className={styles.link}
                href={span.href}
                target="_blank"
                rel="noreferrer noopener"
              >
                <Spans spans={span.spans} />
              </a>
            );
        }
      })}
    </>
  );
}
