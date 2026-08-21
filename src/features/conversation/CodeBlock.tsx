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
 * ## When the name falls back to the bare label, and how
 *
 * A `<Markdown>` rendered without a `within` and holding a single fence draws
 * its copy control as `Copy ts code` — the name it had before any of this. An
 * earlier version of this paragraph said that happened because `place` was
 * `undefined` there, and that is **false**: in exactly that case `place` is
 * `{ index: 1, count: 1, within: undefined }`, and the bare label comes from the
 * `parts.length === 0` arm of `copyControlName`, which finds a count of one and
 * a document of none and so has nothing to append. Measured both ways — replacing
 * the `place === undefined` guard's body with a throw leaves the whole suite
 * green and the guard unhit, while deleting the `parts.length === 0` arm reds
 * *leaves a lone fence in an unplaced document with the name it always had*.
 *
 * `place === undefined` is unreachable from product code: the sole caller is
 * `Markdown.tsx`'s `BlockNode` `case 'code'`, which always passes
 * `place={places.get(block)}`, and `codePlaces` maps every fence its walk
 * reaches — a walk that covers `code`, `quote` and `list`, which are the only
 * `Block` kinds that can nest a `Block`. It survives because the map lookup is
 * typed `| undefined` and `noUncheckedIndexedAccess` will not let it be dropped.
 * *places every fence in a document, at every depth the walk reaches* is what
 * holds that unreachability in place; see the note on `copyControlName`.
 */
export interface CodePlace {
  /** 1-based position among the code blocks of the document it was parsed from. */
  readonly index: number;
  /**
   * How many code blocks that document holds.
   *
   * Counted from the parsed document, so it moves while one is arriving: a
   * second fence landing in a streaming answer renumbers the first control from
   * `Copy ts code — in the reply` to
   * `Copy ts code — code block 1 of 2, in the reply`. Correct at rest and
   * unavoidable while the count is derived rather than declared — a name that
   * did not renumber would have to be wrong about one of the two states.
   *
   * RULE V: that paragraph was true and nothing checked it. The round-7 measurer
   * reproduced both strings exactly with a throwaway probe and then deleted the
   * probe, which is the whole problem — the only streaming test that touches
   * this pushes one fence and asserts one name, so the renumbering this field
   * both causes and defends was never exercised. *renumbers the first control
   * when a second fence arrives in the same answer* in `Markdown.test.tsx` is
   * the assertion now: it renders one fence, reads the name, renders two, and
   * reads both, against the literal strings above.
   */
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
function copyControlName(label: string | null, place: CodePlace | undefined): string {
  const base = label === null ? 'Copy code' : `Copy ${label} code`;
  // UNREACHABLE FROM PRODUCT CODE, AND KEPT ANYWAY — see {@link CodePlace}.
  //
  // `places.get(block)` is typed `CodePlace | undefined` because a `Map` lookup
  // is, and `codePlaces` maps every fence, so no render reaches this. Deleting
  // it is caught by `tsc` (three TS18048) and by no test, and a throw in its
  // body is never hit. It stays because the alternative is a non-null assertion
  // in `Markdown.tsx`, which would be the same unreachability with the compiler
  // silenced instead of satisfied. What holds the unreachability is *places
  // every fence in a document, at every depth the walk reaches*, which pins the
  // map's coverage rather than this line's behaviour.
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
