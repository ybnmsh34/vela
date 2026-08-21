/**
 * A fenced code block: language label, copy button, highlighted body.
 *
 * While the fence is still open the block says so, quietly, instead of jumping
 * between "three literal backticks" and "a code block" as the closing fence
 * arrives. See `markdown-parser.ts` for why the parser reports that state at all.
 */

import { useMemo } from 'react';

import { CopyButton } from './CopyButton';
import { languageLabel, tokenize } from './highlight';
import styles from './CodeBlock.module.css';

/**
 * Where this block sits, for the copy control's **accessible name** and for
 * nothing else.
 *
 * ## The defect this closes
 *
 * The name used to be `Copy ${label} code` and nothing more, so it was a
 * function of the fence's language alone. One answer containing two ```ts
 * fences therefore drew two buttons whose accessible names were byte-identical
 * — measured, `["Copy ts code","Copy ts code"]` — each copying a different
 * block. That is the same hazard `turnControlName` in `MessageTurn.tsx` was
 * written for (two controls, one name, different consequences), one component
 * down, and it survived the round that fixed the turn's own two controls
 * because the test that pinned them was scoped to *turn* controls.
 *
 * ## Why these three fields make the names distinct
 *
 * {@link index} separates two fences inside one document; {@link within}
 * separates two documents — a transcript draws one per reply plus one per
 * reasoning block, and `MessageTurn.tsx` builds the phrase from the reply's
 * position, which two replies cannot share. So (document, position) is unique
 * across a transcript by construction rather than by wording, which is the
 * property the questions-only version of the turn fix could not hold.
 *
 * Undefined for a `<Markdown>` rendered without a `within` and holding a single
 * fence — the name is then the bare label, which is where it was.
 */
export interface CodePlace {
  /** 1-based position among the code blocks of the document it was parsed from. */
  readonly index: number;
  /** How many code blocks that document holds. */
  readonly count: number;
  /** That document, in the reader's terms — 'reply 2 of 3', 'the reasoning'. */
  readonly within: string | undefined;
}

interface CodeBlockProps {
  readonly language: string | null;
  readonly text: string;
  /** The closing fence has not arrived yet. */
  readonly open: boolean;
  readonly place?: CodePlace | undefined;
}

/**
 * "Copy ts code" → "Copy ts code — code block 2 of 2, in reply 1 of 3".
 *
 * The visible text stays `Copy`, and the name still *begins* with it, so voice
 * control keeps matching what a sighted user can read (WCAG 2.5.3). The
 * position is stated only when there is more than one block to be among, for
 * the same reason `turnControlName` omits "reply 1 of 1": in a document with
 * one fence the phrase would be noise, and the document phrase alone already
 * tells that button apart from every other one on the screen.
 */
export function copyControlName(label: string | null, place: CodePlace | undefined): string {
  const base = label === null ? 'Copy code' : `Copy ${label} code`;
  if (place === undefined) return base;
  const parts: string[] = [];
  if (place.count > 1) parts.push(`code block ${String(place.index)} of ${String(place.count)}`);
  if (place.within !== undefined) parts.push(`in ${place.within}`);
  return parts.length === 0 ? base : `${base} — ${parts.join(', ')}`;
}

export function CodeBlock({ language, text, open, place }: CodeBlockProps) {
  const tokens = useMemo(() => tokenize(text, language), [text, language]);
  const label = languageLabel(language);

  return (
    <figure className={styles.block} data-open={open ? 'true' : undefined}>
      <figcaption className={styles.bar}>
        <span className={styles.language}>{label ?? 'code'}</span>
        {open ? (
          <span className={styles.pending} aria-hidden="true">
            still writing
          </span>
        ) : null}
        <CopyButton subtle getText={() => text} label={copyControlName(label, place)} />
      </figcaption>
      <pre className={styles.pre}>
        <code>
          {tokens.map((token, index) =>
            token.kind === 'plain' ? (
              token.text
            ) : (
              // eslint-disable-next-line react/no-array-index-key -- tokens are
              // positional by nature; the array IS the identity here.
              <span key={index} className={styles[token.kind]}>
                {token.text}
              </span>
            ),
          )}
        </code>
      </pre>
    </figure>
  );
}
