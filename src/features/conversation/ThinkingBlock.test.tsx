/**
 * THE THINKING BLOCK IS A READING SURFACE TOO.
 *
 * ## The defect this file exists for
 *
 * `ThinkingBlock` rendered `<p>{text}</p>` with `white-space: pre-wrap`. The
 * `<Markdown>` component sitting in the same folder — tested, and used by the
 * answer channel two lines away in `MessageTurn.tsx` — was never reached. So a
 * reasoning-heavy endpoint printed literal `**Deconstruct the requirements:**`,
 * literal `*   ` bullets, literal backticks and literal fences at the user,
 * wrapped at the model's seventy-column source rather than at the reader's
 * column.
 *
 * That is this project's recurring defect class in miniature: the part existed,
 * worked, and was never connected. It is not a platform defect — it reproduces
 * identically on Linux — and it is not cosmetic. On the operator's real
 * llama.cpp/Qwen3.6-27B run the first reasoning delta arrived at 0.57 s and the
 * first answer delta at 10.21 s, and this block opens by default while
 * streaming: for ten seconds it was the *only* thing on screen.
 *
 * ## What is asserted, and why in two halves
 *
 * The DOM half renders the real component and asks what a reader gets. The
 * stylesheet half reads `ThinkingBlock.module.css` from disk, because `css:
 * false` means a component test can never see a declaration — and "no literal
 * asterisk in the text" would still pass with `pre-wrap` left in place, which
 * is the half of the defect that decides where lines end.
 *
 * ## What is deliberately NOT asserted
 *
 * That reasoning renders at the *same* scale as the answer. It must not: the
 * block is subordinate by design, and `<Markdown scale="aside">` is how that is
 * said. What must be true is that it renders *as markdown* at whatever scale.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ThinkingBlock } from './ThinkingBlock';

/** Comments stripped: a note explaining that `pre-wrap` is gone is not one. */
const SHEET = readFileSync(
  join(process.cwd(), 'src/features/conversation/ThinkingBlock.module.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//gu, '');

/**
 * A reasoning channel shaped like the ones real reasoning models emit: a bold
 * lead-in, a bulleted plan hard-wrapped in the source, inline code, and a
 * fenced block. Every one of these is a literal the user must never see.
 */
const REASONING = `**Deconstruct the requirements:**

*   The user wants a *model-agnostic* desktop client, so the answer
    cannot name a vendor.
*   They mentioned \`llama-server\`, which means the endpoint is
    OpenAI-compatible.

Then check the flag:

\`\`\`bash
llama-server --jinja
\`\`\`

Answering now.`;

/** The source characters that must never reach the reader as characters. */
const SOURCE_LITERALS = ['**', '*   ', '```', '`llama-server`'];

function open(text: string): HTMLElement {
  render(<ThinkingBlock id="t1" text={text} phase="complete" />);
  const region = document.getElementById('t1-reasoning');
  if (region === null) throw new Error('the reasoning region was never rendered');
  return region;
}

describe('the thinking block renders markdown, not markdown source', () => {
  it('never prints a markdown literal at the reader', async () => {
    const user = userEvent.setup();
    const region = open(REASONING);
    await user.click(screen.getByRole('button', { name: /Thought process/u }));

    const shown = region.textContent ?? '';
    const leaked = SOURCE_LITERALS.filter((literal) => shown.includes(literal));
    expect(leaked, `the reader is being shown markdown source: ${leaked.join(' ')}`).toEqual([]);
  });

  it('renders the bold lead-in as bold, the bullets as a list, the fence as code', async () => {
    const user = userEvent.setup();
    const region = open(REASONING);
    await user.click(screen.getByRole('button', { name: /Thought process/u }));

    expect(within(region).getByText('Deconstruct the requirements:').tagName).toBe('STRONG');
    expect(within(region).getAllByRole('listitem')).toHaveLength(2);
    // `llama-server` inline, and the fenced block, are both code — the fence
    // additionally gets the real `<pre>` the answer channel would give it.
    expect(region.querySelectorAll('code').length).toBeGreaterThanOrEqual(2);
    expect(region.querySelector('pre')).not.toBeNull();
  });

  it('reflows the model’s hard-wrapped source to the reader’s column', async () => {
    const user = userEvent.setup();
    const region = open('One line of reasoning\nwrapped by the model, not by the reader.');
    await user.click(screen.getByRole('button', { name: /Thought process/u }));

    expect(region.textContent).toContain(
      'One line of reasoning wrapped by the model, not by the reader.',
    );
  });

  it('does not ask the stylesheet to preserve the model’s line endings', () => {
    // The other half of the same defect. A component test cannot see this:
    // `css: false` means no declaration ever reaches jsdom.
    expect(
      SHEET.includes('pre-wrap'),
      'white-space: pre-wrap makes the model’s column the reader’s column',
    ).toBe(false);
  });
});

describe('the thinking block stays subordinate to the answer', () => {
  it('is closed by default once the thought is complete', () => {
    render(<ThinkingBlock id="t2" text={REASONING} phase="complete" />);
    expect(screen.getByRole('button', { name: /Thought process/u })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('does not open itself while streaming — a peek, not the whole transcript', () => {
    // The rule the desktop run made concrete: reasoning starts ~10s before the
    // answer on a real reasoning endpoint, so an auto-opening block is the
    // entire screen for ten seconds every turn. The live block announces itself
    // and shows its latest line; it does not take the page.
    render(<ThinkingBlock id="t3" text={REASONING} phase="streaming" />);
    expect(screen.getByRole('button', { name: /Thinking/u })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('shows the live edge of the thought while collapsed, so the wait has evidence', () => {
    // A pulse alone says "something is happening"; it does not say what. The
    // sibling surface in this folder already answers this question — a settled
    // `ToolCallCard` shows `view.preview` when collapsed — so the answer is
    // borrowed rather than invented. One line, plain, from the live edge.
    render(<ThinkingBlock id="t3b" text={'Earlier thought.\n\n**Now:** checking the flag'} phase="streaming" />);
    const peek = screen.getByTestId('thinking-peek');
    expect(peek).toHaveTextContent('Now: checking the flag');
    expect(peek.textContent).not.toContain('**');
  });

  it('still opens itself when the stream ended mid-thought, because that is all there is', () => {
    render(<ThinkingBlock id="t4" text={REASONING} phase="unterminated" />);
    expect(screen.getByRole('button', { name: /never closed/u })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByText(/ended while this block was still open/u)).toBeInTheDocument();
  });

  it('lets the user’s own choice win over every default', async () => {
    const user = userEvent.setup();
    render(<ThinkingBlock id="t5" text={REASONING} phase="streaming" />);
    const toggle = screen.getByRole('button', { name: /Thinking/u });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });
});
