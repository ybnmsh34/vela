/**
 * THE CLASS, NOT THE INSTANCE.
 *
 * `ThinkingBlock.test.tsx` fixes one channel. This file asks the question that
 * would have caught it without a critic: **is there any channel of a turn that
 * carries model-authored prose and does not go through `<Markdown>`?**
 *
 * The answer used to be yes, and nothing could see it, because "the reasoning
 * channel renders raw" is invisible from inside the reasoning channel's own
 * tests — there were none — and invisible from the answer channel's tests,
 * which were thorough and looked the other way.
 *
 * ## How the table is kept honest
 *
 * The list of prose channels is not maintained by hand and hoped over. The last
 * test in this file reads `turn-stream.ts`, pulls every `string` field of
 * `TurnState` whose own doc comment calls it the model's, and fails if the
 * table below does not cover it. Add a third model-prose channel to `TurnState`
 * and this file fails until that channel is rendered like the other two.
 *
 * ## Why literals rather than snapshots
 *
 * The defect was not "the wrong markup". It was "the source characters, printed
 * at a human". So the assertion is about characters a reader must never see —
 * which is the same assertion whatever the parser later grows into.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { AssistantTurn, UserTurn } from './MessageTurn';
import { EMPTY_TURN, type TurnState } from './turn-stream';

const TURN_STREAM = readFileSync(
  join(process.cwd(), 'src/features/conversation/turn-stream.ts'),
  'utf8',
);

/** Every markdown device a model actually reaches for, in one document. */
const MARKDOWN = `**Deconstruct the requirements:**

*   a bulleted plan the model hard-wrapped
    across two source lines
*   a second item with \`inline code\`

### A heading three levels down

\`\`\`bash
llama-server --jinja
\`\`\`
`;

/** Characters that must never reach the reader as characters. */
const SOURCE_LITERALS = ['**', '*   ', '```', '### ', '`inline code`'];

interface Channel {
  readonly name: string;
  readonly turn: TurnState;
  /** Reveals the channel if the surface keeps it behind a disclosure. */
  readonly reveal: RegExp | null;
}

const CHANNELS: readonly Channel[] = [
  {
    name: 'answer',
    turn: { ...EMPTY_TURN, phase: 'complete', answer: MARKDOWN },
    reveal: null,
  },
  {
    name: 'reasoning',
    turn: { ...EMPTY_TURN, phase: 'complete', reasoning: MARKDOWN, reasoningPhase: 'complete' },
    reveal: /Thought process/u,
  },
];

describe.each(CHANNELS)('the $name channel is rendered, not printed', ({ turn, reveal }) => {
  async function paint(): Promise<HTMLElement> {
    render(<AssistantTurn id="turn-1" turn={turn} />);
    if (reveal !== null) {
      await userEvent.setup().click(screen.getByRole('button', { name: reveal }));
    }
    return screen.getByRole('article', { name: 'Model reply' });
  }

  it('shows the reader no markdown source', async () => {
    const article = await paint();
    const shown = article.textContent ?? '';
    const leaked = SOURCE_LITERALS.filter((literal) => shown.includes(literal));
    expect(leaked, `markdown source reached the reader: ${leaked.join(' ')}`).toEqual([]);
  });

  it('builds the elements the source described', async () => {
    const article = await paint();
    expect(within(article).getByText('Deconstruct the requirements:').tagName).toBe('STRONG');
    expect(within(article).getAllByRole('listitem')).toHaveLength(2);
    expect(within(article).getByRole('heading', { name: 'A heading three levels down' })).toBeInTheDocument();
    expect(article.querySelector('pre')).not.toBeNull();
  });

  it('reflows what the model hard-wrapped', async () => {
    const article = await paint();
    expect(article.textContent).toContain('a bulleted plan the model hard-wrapped across two source lines');
  });
});

describe('the user’s own words are the one thing left literal', () => {
  it('does not reinterpret what the user typed as markup', () => {
    // The inverse defect, and it is a real one: a user asking *about* markdown,
    // or pasting a shell line with asterisks in it, must see what they typed.
    // They wrote it; they know what it says. This is why the class is
    // "model-authored prose" and not "all text".
    render(<UserTurn text="what does **this** mean in `bash`?" />);
    expect(screen.getByText('what does **this** mean in `bash`?')).toBeInTheDocument();
  });
});

describe('the table above covers every model-authored channel there is', () => {
  it('finds the channels by reading TurnState rather than by memory', () => {
    const body = /export interface TurnState \{([\s\S]*?)\n\}/u.exec(TURN_STREAM)?.[1] ?? '';
    expect(body, 'TurnState could not be located in turn-stream.ts').not.toBe('');

    // A model-prose channel is a `string` field whose own doc comment says the
    // text belongs to the model. That is the property that makes it this
    // file's business: host strings, ids and labels are not the model talking.
    const prose = [...body.matchAll(/\/\*\*([\s\S]*?)\*\/\s*readonly (\w+): string;/gu)]
      .filter(([, doc]) => /model'?’?s/iu.test(doc ?? ''))
      .map(([, , field]) => field ?? '');

    expect(prose.length, 'no model-prose channel was found — the reader is broken, not the code').toBeGreaterThan(0);
    expect(
      [...prose].sort(),
      'a model-authored channel exists that this file does not render-test; add it to CHANNELS',
    ).toEqual([...CHANNELS.map((channel) => channel.name)].sort());
  });
});


describe('the window says which endpoint answered', () => {
  /**
   * **Reaches-user, not reaches-a-pure-function.**
   *
   * `notices.test.ts` pins the sentence; this pins that the sentence is drawn.
   * The defect was never that the wording was wrong — there was no wording —
   * and a fix that stopped at a well-tested string the transcript does not
   * render would leave the product asserting the same false thing it did
   * before. So this renders the real component and reads the real DOM.
   */
  it('discloses a substitution in the transcript itself', () => {
    const substituted: TurnState = {
      ...EMPTY_TURN,
      phase: 'complete',
      answer: 'the answer',
      answeredBy: { providerId: 'rented-gpu-box', modelId: 'big-model' },
    };
    render(<AssistantTurn turn={substituted} id="t1" selectedProviderId="home-workstation" />);

    const reply = screen.getByRole('article', { name: 'Model reply' });
    expect(within(reply).getByText(/rented-gpu-box/u)).toBeInTheDocument();
    expect(within(reply).getByText(/home-workstation/u)).toBeInTheDocument();
  });

  /**
   * The quiet path stays quiet, and this is what stops the test above from
   * passing on a component that prints the note unconditionally: identical
   * turn, identical render, and the two endpoints agree.
   */
  it('says nothing when the endpoint that answered is the one that was asked', () => {
    const ordinary: TurnState = {
      ...EMPTY_TURN,
      phase: 'complete',
      answer: 'the answer',
      answeredBy: { providerId: 'home-workstation', modelId: 'local-model' },
    };
    render(<AssistantTurn turn={ordinary} id="t2" selectedProviderId="home-workstation" />);

    const reply = screen.getByRole('article', { name: 'Model reply' });
    expect(within(reply).queryByLabelText('Which endpoint answered')).toBeNull();
    expect(within(reply).queryByText(/home-workstation/u)).toBeNull();
  });

  /**
   * A turn restored from a transcript row written before provenance existed.
   * The window must not invent an endpoint for it — silence is the only honest
   * rendering of "nobody recorded this".
   */
  it('says nothing about an unattributed turn rather than naming the selection', () => {
    const unattributed: TurnState = {
      ...EMPTY_TURN,
      phase: 'complete',
      answer: 'the answer',
      answeredBy: null,
    };
    render(<AssistantTurn turn={unattributed} id="t3" selectedProviderId="home-workstation" />);

    const reply = screen.getByRole('article', { name: 'Model reply' });
    expect(within(reply).queryByLabelText('Which endpoint answered')).toBeNull();
    expect(within(reply).queryByText(/home-workstation/u)).toBeNull();
  });
});
