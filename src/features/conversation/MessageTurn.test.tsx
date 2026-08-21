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
import { entriesFromStored } from './stored-entries';
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

describe('the disclosure survives closing and reopening the conversation', () => {
  /**
   * **The loop the two unit tests do not close on their own.**
   *
   * `stored-entries.test.ts` proves a stored row produces a `TurnState` with
   * `answeredBy` set. The tests above prove a `TurnState` with `answeredBy` set
   * renders the note. Neither proves the composition, and the composition is
   * where the defect lived: the column was written, carried through the
   * contract, and read by nothing, so the disclosure a user saw when the turn
   * arrived was gone the moment they reopened the conversation — while the truth
   * sat correctly in SQLite.
   *
   * So this drives the real restore path into the real component and reads the
   * real DOM, with a stored row whose two endpoints differ.
   */
  it('draws the substitution for a turn rebuilt from a stored row', () => {
    const [entry] = entriesFromStored([
      {
        id: 'msg_1',
        conversationId: 'conv_1',
        seq: 0,
        role: 'assistant',
        status: 'complete',
        parts: [{ kind: 'text', text: 'the answer' }],
        providerId: 'home-workstation',
        modelId: 'local-model',
        answeredByProviderId: 'rented-gpu-box',
        answeredByModelId: 'big-model',
        usage: { inputTokens: null, outputTokens: null, reasoningTokens: null, cachedInputTokens: null },
        stopReason: null,
        errorMessage: null,
        createdAtMs: 1_700_000_000_000,
        updatedAtMs: 1_700_000_000_000,
      },
    ]);
    if (entry?.kind !== 'assistant') throw new Error('the restore did not produce an assistant turn');

    render(<AssistantTurn turn={entry.turn} id="t4" selectedProviderId="home-workstation" />);

    const reply = screen.getByRole('article', { name: 'Model reply' });
    const note = within(reply).getByLabelText('Which endpoint answered');
    expect(within(note).getByText(/rented-gpu-box/u)).toBeInTheDocument();
    expect(within(note).getByText(/home-workstation/u)).toBeInTheDocument();
  });
});

/**
 * ONE ENDING, SAID ONCE.
 *
 * `turn-ending.ts` states the rule — "this speaks only when nothing else does"
 * — and the footer was the thing else. A turn with phase `stopped` and no error
 * drew the `cutShort` block *and* a muted "Stopped" in the footer: two
 * statements of one ending on one turn, which is exactly what the rule exists
 * to prevent, and the sort of thing a rule stated in a header does not catch.
 */
describe('a turn states how it ended exactly once', () => {
  const stoppedWithNoError: TurnState = {
    ...EMPTY_TURN,
    phase: 'stopped',
    stopReason: 'cancelled',
    answer: 'as far as it got',
  };

  it('does not repeat the ending in the footer', () => {
    render(<AssistantTurn turn={stoppedWithNoError} id="t5" />);
    const reply = screen.getByRole('article', { name: 'Model reply' });

    // The block says it, in a sentence, with the control on it.
    expect(within(reply).getByText('Stopped before it finished')).toBeInTheDocument();
    expect(reply.querySelectorAll('[data-kind="cutShort"]')).toHaveLength(1);

    // And nothing else on the turn says it a second time. `Stopped` on its own
    // is the footer's exact wording; the block's is a different sentence, so
    // this matches the footer and only the footer.
    expect(within(reply).queryByText('Stopped')).not.toBeInTheDocument();
  });

  it('still says it once for a stopped turn whose error block speaks instead', () => {
    // The other half of the old condition, and the half that was right:
    // `describeChatError`'s `cancelled` title is 'Stopped', so the ending block
    // returns null there and the error block is the single statement.
    const cancelledWithError: TurnState = {
      ...stoppedWithNoError,
      error: { kind: 'cancelled' },
    };
    render(<AssistantTurn turn={cancelledWithError} id="t6" />);
    const reply = screen.getByRole('article', { name: 'Model reply' });

    expect(within(reply).getAllByText('Stopped')).toHaveLength(1);
    expect(within(reply).queryByText('Stopped before it finished')).not.toBeInTheDocument();
  });
});

/**
 * WHERE THE ENDING SITS, WHICH WAS A COMMENT AND IS NOW AN ASSERTION.
 *
 * The ending block used to render above `<ToolCalls>`. That position was chosen
 * for the empty ending — the case where nothing else is on the turn at all —
 * and never re-examined for the others, so a truncated turn that had made tool
 * calls put "Cut off at the model's output limit" *above* the cards for the
 * calls that happened before the cut, and put it on the opposite side of the
 * notes from the `.error` block underneath, which states the same class of
 * fact. It was moved below both; the move is described in a JSX comment in
 * `MessageTurn.tsx`.
 *
 * Nothing asserted it. The round-6 measurer moved the whole block back above
 * `<ToolCalls>` — undoing the fix and making that comment false — and the
 * renderer suite stayed at 121 files / 2443 tests, exit 0. Every existing
 * assertion about an ending is existence-or-content: `visibleText()`,
 * `querySelector('[data-kind=…]')`, `toHaveLength(1)`. None is order.
 *
 * Order is what the fix was, so order is what this reads: the position of each
 * landmark in the rendered article, compared against the order the turn
 * happened in. Re-measured with these two in place: moving the block back above
 * `<ToolCalls>` fails the whole suite on the first of them and on nothing else
 * — 1 failed | 2450 passed at this commit.
 */
describe('a turn is laid out in the order the turn happened', () => {
  /** Every landmark of an assistant turn that has a position, in reading order. */
  const LANDMARKS: readonly (readonly [string, string])[] = [
    ['the tool calls', '[aria-label="Tool calls"]'],
    ['which endpoint answered', '[aria-label="Which endpoint answered"]'],
    ['what Vela had to change', '[aria-label="What Vela had to change for this model"]'],
    ['the ending', '[data-kind="truncated"]'],
    ['the failure', '[data-kind="failed"]'],
  ];

  /**
   * The landmarks present in `reply`, named, in the order they appear in it.
   *
   * Read off the flattened element list rather than off `children`, because
   * these are not all siblings and a test that assumed they were would be
   * asserting the shape of the tree instead of the order of the page.
   */
  function layoutOf(reply: HTMLElement): readonly string[] {
    const elements = [...reply.querySelectorAll('*')];
    return LANDMARKS.map(([name, selector]) => [name, reply.querySelector(selector)] as const)
      .filter((entry): entry is readonly [string, Element] => entry[1] !== null)
      .map(([name, element]) => [name, elements.indexOf(element)] as const)
      .sort((left, right) => left[1] - right[1])
      .map(([name]) => name);
  }

  const withToolCallsAndNotes = {
    answer: 'as far as it got',
    outcomes: [
      { status: 'ok', callId: 'call_1', name: 'read_file', arguments: {}, emulated: false },
    ],
    degradations: [{ kind: 'toolCatalogueWithheld' }],
    answeredBy: { providerId: 'laptop', modelId: 'other-model' },
  } as const;

  it('puts a truncated turn’s ending below the calls it made before the cut', () => {
    const turn: TurnState = {
      ...EMPTY_TURN,
      ...withToolCallsAndNotes,
      phase: 'complete',
      stopReason: 'maxTokens',
    };
    render(<AssistantTurn turn={turn} id="t7" selectedProviderId="workstation" />);
    const reply = screen.getByRole('article', { name: 'Model reply' });

    // The four are all drawn — a layout assertion over one element would hold
    // however the page was ordered.
    expect(layoutOf(reply)).toEqual([
      'the tool calls',
      'which endpoint answered',
      'what Vela had to change',
      'the ending',
    ]);
    expect(within(reply).getByText('Cut off at the model’s output limit')).toBeInTheDocument();
  });

  it('puts a failure in the same place, which is why the ending moved there', () => {
    // The `.error` block was always last. The ending block states the same
    // class of fact and sat on the other side of the notes from it; both now
    // read the same way, and this is the half that fixes the position of the
    // one the other was moved to match.
    const turn: TurnState = {
      ...EMPTY_TURN,
      ...withToolCallsAndNotes,
      phase: 'failed',
      error: { kind: 'authFailed', diagnosis: { cause: 'credential_rejected', correlation: 0 } },
    };
    render(<AssistantTurn turn={turn} id="t8" selectedProviderId="workstation" />);
    const reply = screen.getByRole('article', { name: 'Model reply' });

    expect(layoutOf(reply)).toEqual([
      'the tool calls',
      'which endpoint answered',
      'what Vela had to change',
      'the failure',
    ]);
  });
});
