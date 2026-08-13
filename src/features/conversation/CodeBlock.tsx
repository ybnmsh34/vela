/**
 * A fenced code block: language label, copy button, highlighted body.
 *
 * While the fence is still open the block says so, quietly, instead of jumping
 * between "three literal backticks" and "a code block" as the closing fence
 * arrives. See `markdown.ts` for why the parser reports that state at all.
 */

import { useMemo } from 'react';

import { CopyButton } from './CopyButton';
import { languageLabel, tokenize } from './highlight';
import styles from './CodeBlock.module.css';

interface CodeBlockProps {
  readonly language: string | null;
  readonly text: string;
  /** The closing fence has not arrived yet. */
  readonly open: boolean;
}

export function CodeBlock({ language, text, open }: CodeBlockProps) {
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
        <CopyButton
          subtle
          getText={() => text}
          label={label === null ? 'Copy code' : `Copy ${label} code`}
        />
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
