/**
 * The model's reasoning — a distinct content type, rendered as a distinct thing.
 *
 * ## The rules this component encodes
 *
 * * **It is markdown, because the model wrote markdown.** Reasoning arrives
 *   with bold lead-ins, bulleted plans, inline code and fenced blocks in it,
 *   exactly like an answer does. This component used to emit `<p>{text}</p>`
 *   with `white-space: pre-wrap` — the `<Markdown>` component two files away,
 *   already tested and already used by the answer channel, was never reached —
 *   so the user was shown literal `**Deconstruct the requirements:**`, literal
 *   `*   ` bullets and literal fences, wrapped at the model's seventy-column
 *   source rather than at their own column.
 * * **Subordinate to the answer, never mixed into it.** Quieter, in its own
 *   container, and at `<Markdown scale="aside">` so nothing inside it can set
 *   larger than the answer's body text. It is deliberation, not output.
 * * **A peek while it streams, not the whole transcript.** On the operator's
 *   real reasoning endpoint the first reasoning delta landed at 0.57 s and the
 *   first answer delta at 10.21 s. A block that opens itself is therefore the
 *   entire screen for ten seconds of every turn, and on a short prompt it is
 *   the only thing there. So the live block announces itself, pulses, and shows
 *   its latest line — the same answer the sibling `ToolCallCard` in this folder
 *   gives to the same question — and leaves the page to the answer.
 * * **An unterminated block stays open and says so.** The host reports
 *   `unterminatedReasoning` when a stream ends mid-thought (hostile endpoints
 *   open the block twice and never close it). Collapsing that by default would
 *   hide the only text the turn produced.
 * * **The user's own click outranks every default above.** A panel that snaps
 *   shut under your cursor is worse than one that never moves.
 */

import { useState } from 'react';

import { Markdown } from './Markdown';
import type { ReasoningPhase } from './turn-stream';
import styles from './ThinkingBlock.module.css';

interface ThinkingBlockProps {
  readonly text: string;
  readonly phase: ReasoningPhase;
  /** Distinguishes this turn's block from every other one for aria wiring. */
  readonly id: string;
}

/**
 * The live edge of the thought, as one plain line.
 *
 * Plain, not rendered: a peek is a status line, and half a markdown block
 * parsed mid-token would render as debris. The markdown *syntax* is stripped
 * rather than shown, because the whole defect this file exists for is source
 * characters reaching a reader.
 */
export function reasoningPeek(text: string): string {
  const line = text
    .split('\n')
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate !== '')
    .at(-1);
  if (line === undefined) return '';
  return line
    .replace(/^[>\s]*(?:[-*+]|\d+[.)])\s+/u, '')
    .replace(/^#{1,6}\s+/u, '')
    .replace(/[*_~`]/gu, '')
    .trim();
}

export function ThinkingBlock({ text, phase, id }: ThinkingBlockProps) {
  const [choice, setChoice] = useState<boolean | null>(null);
  if (phase === 'none' || text === '') return null;

  const live = phase === 'streaming';
  const open = choice ?? phase === 'unterminated';
  const summary = live ? 'Thinking…' : phase === 'unterminated' ? 'Thinking (never closed)' : 'Thought process';
  const peek = live && !open ? reasoningPeek(text) : '';

  return (
    <section className={styles.block} data-live={live ? 'true' : undefined}>
      <h3 className={styles.headingReset}>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          aria-controls={`${id}-reasoning`}
          onClick={() => {
            setChoice(!open);
          }}
        >
          <span className={styles.chevron} data-open={open ? 'true' : undefined} aria-hidden="true" />
          <span className={styles.summary}>{summary}</span>
          {live ? <span className={styles.pulse} aria-hidden="true" /> : null}
          {peek === '' ? null : (
            <span className={styles.peek} data-testid="thinking-peek">
              {peek}
            </span>
          )}
        </button>
      </h3>

      <div id={`${id}-reasoning`} className={styles.body} hidden={!open}>
        {phase === 'unterminated' ? (
          <p className={styles.notice}>
            The stream ended while this block was still open. It is shown in full so nothing is
            lost — but the model never marked where its answer was meant to begin.
          </p>
        ) : null}
        <Markdown source={text} scale="aside" />
      </div>
    </section>
  );
}
