/**
 * Renders the block tree from `markdown-parser.ts`.
 *
 * Every node is a React element built from parsed data — there is no
 * `dangerouslySetInnerHTML` anywhere in this feature, and there must never be
 * one. Model output is untrusted text; it is rendered as text.
 */

import { memo } from 'react';

import { CodeBlock } from './CodeBlock';
import { parseMarkdown, type Block, type Span } from './markdown-parser';
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
}: MarkdownProps) {
  const blocks = parseMarkdown(source);
  return (
    <div
      className={styles.prose}
      data-scale={scale}
      data-streaming={streaming ? 'true' : undefined}
    >
      {blocks.map((block, index) => (
        <BlockNode key={index} block={block} last={index === blocks.length - 1} />
      ))}
    </div>
  );
});

function BlockNode({ block, last }: { readonly block: Block; readonly last: boolean }) {
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
      return <CodeBlock language={block.language} text={block.text} open={block.open} />;

    case 'rule':
      return <hr className={styles.rule} />;

    case 'quote':
      return (
        <blockquote className={styles.quote}>
          {block.blocks.map((child, index) => (
            <BlockNode key={index} block={child} last={false} />
          ))}
        </blockquote>
      );

    case 'list': {
      const items = block.items.map((item, index) => (
        <li key={index} className={styles.item}>
          {item.blocks.map((child, childIndex) => (
            <BlockNode key={childIndex} block={child} last={false} />
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
