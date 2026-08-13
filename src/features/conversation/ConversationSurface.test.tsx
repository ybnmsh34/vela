/**
 * The conversation surface, driven end to end.
 *
 * Two rigs, on purpose:
 *
 *  - a **scripted host** that hands the surface exactly the frames a hostile or
 *    limited endpoint would produce, so the states that matter (markup in the
 *    answer, an unterminated thinking block, a malformed tool call, a stalled
 *    transport) can be produced deliberately rather than hoped for;
 *  - the ordinary **`BrowserAdapter`**, so at least one path is the real
 *    protocol from composer keystroke to rendered answer with nothing stubbed.
 *
 * Everything here is **VERIFIED-BY-FAKE**.
 */

import { StrictMode } from 'react';

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { NO_WINDOW_CONTROLS, type PlatformAdapter, type Unsubscribe } from '@/platform/adapter';
import { BrowserAdapter } from '@/platform/browser-adapter';
import { PlatformProvider } from '@/platform/PlatformProvider';
import type {
  ChatCapabilities,
  ChatEventEnvelope,
  ChatResponseBody,
  ChatSendReq,
  ChatStreamEvent,
  CommandName,
  CommandReq,
  CommandRes,
  TokenUsage,
} from '@/platform/contract';
import { NO_CAPABILITIES } from '@/platform/contract';
import { PlatformError } from '@/platform/errors';
import { resetDebugLogStore, useDebugLogStore } from '@/state/debug-log-store';

import { ConversationSurface } from './ConversationSurface';
import { ConversationView } from './ConversationView';
import { useConversation } from './use-conversation';

const NO_USAGE: TokenUsage = {
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  cachedInputTokens: null,
};

function done(overrides: Partial<ChatResponseBody> = {}): ChatStreamEvent {
  return {
    type: 'done',
    response: {
      parts: [],
      toolCalls: [],
      stopReason: 'endTurn',
      usage: NO_USAGE,
      structured: null,
      degradations: [],
      ...overrides,
    },
  };
}

/** A host whose stream this test writes, frame by frame. */
class ScriptedHost implements PlatformAdapter {
  readonly kind = 'browser' as const;
  /** No window to control: this fake exists to script a chat stream. */
  readonly window = NO_WINDOW_CONTROLS;
  readonly sent: ChatSendReq[] = [];
  readonly cancelled: string[] = [];
  refuseWith: PlatformError | null = null;
  #handlers = new Set<(payload: ChatEventEnvelope) => void>();

  async invoke<C extends CommandName>(command: C, payload: CommandReq<C>): Promise<CommandRes<C>> {
    if (command === 'chat_send') {
      if (this.refuseWith !== null) throw this.refuseWith;
      const request = payload as ChatSendReq;
      this.sent.push(request);
      return { turnId: request.turnId, accepted: true } as CommandRes<C>;
    }
    if (command === 'chat_cancel') {
      const { turnId } = payload as { turnId: string };
      this.cancelled.push(turnId);
      return { cancelled: true } as CommandRes<C>;
    }
    throw new PlatformError('UNKNOWN_COMMAND', `unscripted command \`${command}\``);
  }

  async listen(_event: string, handler: (payload: never) => void): Promise<Unsubscribe> {
    const typed = handler as unknown as (payload: ChatEventEnvelope) => void;
    this.#handlers.add(typed);
    return () => this.#handlers.delete(typed);
  }

  /** Pushes frames for the newest turn, as the host would. */
  push(...events: readonly ChatStreamEvent[]): void {
    const turnId = this.sent.at(-1)?.turnId ?? 'unknown';
    for (const event of events) {
      for (const handler of [...this.#handlers]) handler({ turnId, event });
    }
  }
}

/**
 * The real hook and the real view, with the frame scheduler made synchronous so
 * assertions do not race an animation frame. Batching itself is covered by its
 * own test below, with a scheduler this test drives by hand.
 */
function Harness({
  host,
  capabilities = NO_CAPABILITIES,
  scheduleCommit = (run: () => void) => {
    run();
  },
}: {
  readonly host: ScriptedHost;
  readonly capabilities?: ChatCapabilities;
  readonly scheduleCommit?: (run: () => void) => void;
}) {
  const conversation = useConversation({ providerId: 'p', modelId: 'm', scheduleCommit });
  return (
    <PlatformProvider adapter={host}>
      <ConversationView
        conversation={conversation}
        capabilities={capabilities}
        modelLabel="the model on this machine"
      />
    </PlatformProvider>
  );
}

function mount(host: ScriptedHost, capabilities?: ChatCapabilities) {
  return render(
    <PlatformProvider adapter={host}>
      <Harness host={host} {...(capabilities === undefined ? {} : { capabilities })} />
    </PlatformProvider>,
  );
}

async function ask(text: string): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: 'Message' }), text);
  await user.click(screen.getByRole('button', { name: 'Send' }));
}

/** Everything a user can actually read on screen. */
function visibleText(): string {
  return document.body.textContent ?? '';
}

describe('the conversation surface: empty state', () => {
  it('names what the model can do, from the capability struct alone', () => {
    render(
      <PlatformProvider adapter={new BrowserAdapter()}>
        <ConversationSurface
          providerId="p"
          modelId="m"
          modelLabel="the model on this machine"
          capabilities={{ ...NO_CAPABILITIES, streaming: true, reasoning: true }}
        />
      </PlatformProvider>,
    );

    const list = screen.getByRole('list', { name: 'What this model can do' });
    expect(within(list).getByText('Streams token by token').closest('li')).toHaveAttribute(
      'data-available',
      'true',
    );
    expect(within(list).getByText('Accepts images').closest('li')).toHaveAttribute(
      'data-available',
      'false',
    );
  });

  it('says nothing is established when nothing has been probed', () => {
    render(
      <PlatformProvider adapter={new BrowserAdapter()}>
        <ConversationSurface providerId="p" modelId="m" modelLabel="a local model" />
      </PlatformProvider>,
    );
    expect(screen.getByText(/Vela does not guess/)).toBeInTheDocument();
  });

  it('blocks the composer, with a reason, until a model is chosen', () => {
    render(
      <PlatformProvider adapter={new BrowserAdapter()}>
        <ConversationSurface />
      </PlatformProvider>,
    );
    const box = screen.getByRole('textbox', { name: 'Message' });
    expect(box).toBeDisabled();
    expect(box).toHaveAttribute('placeholder', 'Choose a model to start a conversation');
  });
});

describe('the conversation surface: streaming', () => {
  it('shows a waiting state, then replaces it with the first token', async () => {
    const host = new ScriptedHost();
    mount(host);
    await ask('hello');

    expect(screen.getByText(/Waiting for the first token/)).toBeInTheDocument();

    act(() => {
      host.push({ type: 'textDelta', text: 'Hi.' });
    });
    expect(screen.queryByText(/Waiting for the first token/)).not.toBeInTheDocument();
    expect(screen.getByText('Hi.')).toBeInTheDocument();
  });

  it('renders markdown incrementally, including a fence that is still open', async () => {
    const host = new ScriptedHost();
    mount(host);
    await ask('show me code');

    act(() => {
      host.push({ type: 'textDelta', text: 'Here:\n\n```ts\nconst x' });
    });
    // Already a code block, before the closing fence exists.
    expect(screen.getByText('still writing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy ts code' })).toBeInTheDocument();

    act(() => {
      host.push({ type: 'textDelta', text: ' = 1;\n```\n' }, done());
    });
    expect(screen.queryByText('still writing')).not.toBeInTheDocument();
    expect(visibleText()).not.toContain('```');
  });

  /* ------------------------------------------------------------------ *
   * THE RULE: reasoning markup must never reach user-visible text.       *
   * ------------------------------------------------------------------ */

  it('never leaks reasoning markup into the answer, even split across frames', async () => {
    const host = new ScriptedHost();
    mount(host);
    await ask('think about it');

    // A host that failed to split reasoning out: the tag arrives in pieces, no
    // single frame contains a whole one, and it opens twice.
    act(() => {
      host.push(
        { type: 'textDelta', text: 'The answer <thi' },
        { type: 'textDelta', text: 'nk>first I must weigh <thin' },
        { type: 'textDelta', text: 'k>the options</thi' },
        { type: 'textDelta', text: 'nk> is 42.' },
        done(),
      );
    });

    const rendered = visibleText();
    expect(rendered).not.toContain('<think');
    expect(rendered).not.toContain('</think');
    expect(rendered).not.toContain('<thi');
    expect(rendered).not.toContain('nk>');

    // The answer is intact and the deliberation is in its own channel.
    expect(screen.getByText(/The answer\s+is 42\./)).toBeInTheDocument();
    const reasoning = screen.getByRole('button', { name: /Thought process/ });
    await userEvent.setup().click(reasoning);
    expect(screen.getByText(/first I must weigh the options/)).toBeInTheDocument();
  });

  it('keeps reasoning out of the answer when the host does split it properly', async () => {
    const host = new ScriptedHost();
    mount(host);
    await ask('think');

    act(() => {
      host.push(
        { type: 'reasoningDelta', text: 'weighing it up' },
        { type: 'textDelta', text: 'Forty-two.' },
      );
    });

    // Live: collapsed, with the live edge of the thought on the row.
    //
    // This used to assert `true`, and that was the CONV-1 visual FAIL: on a
    // real reasoning endpoint the first reasoning delta arrives ~10s before the
    // first answer delta, so a block that opens itself is the whole screen for
    // ten seconds of every turn — and on a short prompt it is the only thing
    // there. The wait still has evidence; it is one line, not a transcript.
    expect(screen.getByRole('button', { name: /Thinking…/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.getByTestId('thinking-peek')).toHaveTextContent('weighing it up');

    act(() => {
      host.push(done({ parts: [{ kind: 'text', text: 'Forty-two.' }] }));
    });

    // Settled: collapsed, the peek gone, the thought still there behind a click.
    const toggle = screen.getByRole('button', { name: /Thought process/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('thinking-peek')).toBeNull();
    expect(screen.getByText('weighing it up')).not.toBeVisible();
    expect(screen.getByText('Forty-two.')).toBeVisible();

    await userEvent.setup().click(toggle);
    expect(screen.getByText('weighing it up')).toBeVisible();
  });

  it('respects an explicit expand while the block is still streaming', async () => {
    const host = new ScriptedHost();
    const user = userEvent.setup();
    mount(host);
    await ask('think');

    act(() => {
      host.push({ type: 'reasoningDelta', text: 'step one' });
    });
    await user.click(screen.getByRole('button', { name: /Thinking…/ }));
    expect(screen.getByRole('button', { name: /Thinking…/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    act(() => {
      host.push({ type: 'reasoningDelta', text: ' step two' });
    });
    // Still open, and now carrying both deltas: a reader who asked to watch the
    // thought does not get the panel shut under their cursor by the next frame.
    const toggle = screen.getByRole('button', { name: /Thinking…/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('step one step two')).toBeVisible();
  });

  it('keeps an unterminated thinking block open and says why', async () => {
    const host = new ScriptedHost();
    mount(host);
    await ask('think forever');

    act(() => {
      host.push(
        { type: 'textDelta', text: '<think>I am still deciding and then' },
        done({ degradations: [{ kind: 'unterminatedReasoning', recoveredAnswerChars: 0 }] }),
      );
    });

    expect(screen.getByRole('button', { name: /never closed/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    // Nothing is swallowed: the text is on screen, markup-free.
    expect(screen.getByText(/I am still deciding and then/)).toBeVisible();
    expect(visibleText()).not.toContain('<think>');
    // Said twice on purpose: once inside the block, once as the host's own
    // degradation note. Both are the user's business.
    expect(screen.getAllByText(/no answer text/).length).toBeGreaterThanOrEqual(1);
  });

  it('commits the first token immediately and batches the rest', async () => {
    const host = new ScriptedHost();
    const frames: (() => void)[] = [];
    render(
      <PlatformProvider adapter={host}>
        <Harness
          host={host}
          scheduleCommit={(run) => {
            frames.push(run);
          }}
        />
      </PlatformProvider>,
    );
    await ask('go');

    // No frame has run, and the first token is already on screen: that is the
    // whole point — time-to-first-token pays no scheduling tax.
    act(() => {
      host.push({ type: 'textDelta', text: 'immediate' });
    });
    expect(frames).toHaveLength(0);
    expect(screen.getByText(/immediate/)).toBeInTheDocument();

    act(() => {
      host.push(
        { type: 'textDelta', text: ' one' },
        { type: 'textDelta', text: ' two' },
        { type: 'textDelta', text: ' three' },
      );
    });
    // Three deltas, one scheduled commit — not three.
    expect(frames).toHaveLength(1);
    expect(screen.getByText(/immediate$/)).toBeInTheDocument();

    act(() => {
      frames.forEach((run) => {
        run();
      });
    });
    expect(screen.getByText(/immediate one two three/)).toBeInTheDocument();
  });

  /**
   * React mounts, unmounts and mounts again under StrictMode. A surface that
   * only *cleared* its mounted flag survived the first render and then dropped
   * every frame of every later turn — the whole thing sat on "waiting for the
   * first token" forever. It shipped past every test in this file until it was
   * rendered in a browser, so it gets its own.
   */
  it('still streams after a remount', async () => {
    const host = new ScriptedHost();
    render(
      <StrictMode>
        <PlatformProvider adapter={host}>
          <Harness host={host} />
        </PlatformProvider>
      </StrictMode>,
    );
    await ask('after a remount');

    act(() => {
      host.push({ type: 'textDelta', text: 'still arriving' }, done());
    });
    expect(screen.getByText('still arriving')).toBeInTheDocument();
  });

  it('flushes a terminal event without waiting for a frame', async () => {
    const host = new ScriptedHost();
    const frames: (() => void)[] = [];
    render(
      <PlatformProvider adapter={host}>
        <Harness
          host={host}
          scheduleCommit={(run) => {
            frames.push(run);
          }}
        />
      </PlatformProvider>,
    );
    await ask('go');

    act(() => {
      host.push({ type: 'textDelta', text: 'a' }, { type: 'textDelta', text: 'b' }, done());
    });
    expect(screen.getByText('ab')).toBeInTheDocument();
    // The composer is usable again the moment the turn ends.
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });
});

describe('the conversation surface: tool calls and degradation', () => {
  it('shows a malformed tool call with its raw arguments, never dropping it', async () => {
    const host = new ScriptedHost();
    mount(host);
    await ask('use a tool');

    act(() => {
      host.push(
        done({
          toolCalls: [
            {
              status: 'malformed',
              index: 7,
              callId: null,
              name: 'search',
              rawArguments: '{"query": unquoted}',
              reason: 'unparseableArguments',
            },
          ],
          degradations: [{ kind: 'malformedToolCalls', count: 1 }],
        }),
      );
    });

    // Queried by what a user must be able to see, not by the markup that shows
    // it: the presentation of a tool call is its own component's business, and
    // this assertion is about the rule that it is *shown at all*.
    const calls = screen.getByLabelText('Tool calls');
    expect(within(calls).getByText(/search/)).toBeInTheDocument();
    expect(within(calls).getByText(/not valid JSON/)).toBeInTheDocument();
    expect(calls.textContent).toContain('{"query": unquoted}');
    expect(screen.getByText('A tool call could not be read')).toBeInTheDocument();
  });

  it('shows in-flight tool fragments while they assemble', async () => {
    const host = new ScriptedHost();
    mount(host);
    await ask('use a tool');

    act(() => {
      host.push({
        type: 'toolCallDelta',
        delta: { slot: 0, callId: 'c1', name: 'search', argumentsFragment: '{"q":' },
      });
    });
    const calls = screen.getByLabelText('Tool calls');
    expect(within(calls).getByText(/search/)).toBeInTheDocument();
    expect(calls.textContent).toContain('{"q":');
  });

  it('surfaces every degradation the host reported', async () => {
    const host = new ScriptedHost();
    mount(host);
    await ask('anything');

    act(() => {
      host.push(
        done({
          degradations: [
            { kind: 'toolCallingEmulated', toolCount: 1 },
            { kind: 'contextReduced', droppedMessages: 2, approxDroppedTokens: 800, strategy: 'elideOldest' },
            { kind: 'usageNotReported' },
          ],
        }),
      );
    });

    const notes = screen.getByRole('list', { name: 'What Vela had to change for this model' });
    expect(within(notes).getAllByRole('listitem')).toHaveLength(3);
    expect(within(notes).getByText('The conversation was shortened')).toBeInTheDocument();
  });

  it('renders token usage only when the endpoint reported it', async () => {
    const host = new ScriptedHost();
    mount(host);
    await ask('count');

    act(() => {
      host.push({ type: 'textDelta', text: 'ok' });
    });
    expect(screen.queryByText(/tokens$/)).not.toBeInTheDocument();

    // Usage arrives before the turn ends, which is the only place the contract
    // allows it: `done` is terminal and nothing follows it.
    act(() => {
      host.push({ type: 'usage', usage: { ...NO_USAGE, inputTokens: 10, outputTokens: 4 } }, done());
    });
    expect(screen.getByText('10 in · 4 out tokens')).toBeInTheDocument();
  });

  it('shows no usage line at all when the endpoint never reports one', async () => {
    const host = new ScriptedHost();
    mount(host);
    await ask('count');

    act(() => {
      host.push({ type: 'textDelta', text: 'ok' }, done());
    });
    expect(screen.queryByText(/tokens$/)).not.toBeInTheDocument();
  });
});

describe('the conversation surface: failure and cancellation', () => {
  it('reads a stalled transport as a failure, keeps the partial answer, offers a retry', async () => {
    const host = new ScriptedHost();
    mount(host);
    await ask('long one');

    act(() => {
      host.push(
        { type: 'textDelta', text: 'As far as I got' },
        {
          type: 'error',
          error: {
            kind: 'transport',
            failure: 'stalled',
            diagnosis: { cause: 'stream_stalled', correlation: 41 },
          },
        },
      );
    });

    expect(screen.getByRole('alert')).toHaveTextContent('The reply stopped arriving');
    expect(screen.getByText('As far as I got')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('offers no retry for a failure that would fail identically', async () => {
    const host = new ScriptedHost();
    mount(host);
    await ask('with a bad key');

    act(() => {
      host.push({
        type: 'error',
        error: {
          kind: 'authFailed',
          diagnosis: {
            cause: 'credential_rejected',
            status: 401,
            endpoint: { authority: 'https://gpu.example.test', path: '/v1' },
            correlation: 42,
          },
        },
      });
    });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('The endpoint rejected the credential');
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    // The endpoint the *user* configured, so three candidates can be told apart.
    expect(alert).toHaveTextContent('https://gpu.example.test/v1');

    // The trace id is a *reference into the local debug log*, and the log is
    // off. It used to be printed regardless, into a file nothing in the
    // application could create — a pointer to nothing, which reads to a user as
    // something they failed to find rather than something that is not there.
    expect(alert).not.toHaveTextContent('trace');

    act(() => {
      useDebugLogStore.getState().report({ enabled: true, path: '/tmp/exchanges.jsonl' });
    });
    // With the log recording, the id is the most useful thing on the screen:
    // it is what the user greps that file for.
    expect(screen.getByRole('alert')).toHaveTextContent('trace 000000000000002a');
    act(() => {
      resetDebugLogStore();
    });
  });

  it('cancels on Escape and reads the result as stopped, not failed', async () => {
    const host = new ScriptedHost();
    const user = userEvent.setup();
    mount(host);
    await ask('a long answer');

    act(() => {
      host.push({ type: 'textDelta', text: 'Starting…' });
    });
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(host.cancelled).toEqual([host.sent[0]?.turnId]);

    act(() => {
      host.push({ type: 'error', error: { kind: 'cancelled' } });
    });

    // Stopping is something the user did. It must not be announced as an error.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Stopped')).toBeInTheDocument();
    expect(screen.getByText('Starting…')).toBeInTheDocument();
  });

  it('cancels from the Stop button too', async () => {
    const host = new ScriptedHost();
    const user = userEvent.setup();
    mount(host);
    await ask('a long answer');

    act(() => {
      host.push({ type: 'textDelta', text: 'Starting…' });
    });
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(host.cancelled).toHaveLength(1);
  });

  it('reports a turn the host refused as Vela’s own fault, not the endpoint’s', async () => {
    const host = new ScriptedHost();
    host.refuseWith = new PlatformError('NOT_FOUND', 'no provider configured with id `p`');
    mount(host);
    await ask('hello');

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Vela could not start this turn');
    });
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('re-sends the last message on retry, without duplicating it', async () => {
    const host = new ScriptedHost();
    const user = userEvent.setup();
    mount(host);
    await ask('try me');

    act(() => {
      host.push({
        type: 'error',
        error: {
          kind: 'malformedResponse',
          diagnosis: { cause: 'response_was_not_json', correlation: 43 },
        },
      });
    });
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(host.sent).toHaveLength(2);
    expect(host.sent[1]?.messages).toEqual([{ role: 'user', text: 'try me' }]);
    expect(screen.getAllByLabelText('Your message')).toHaveLength(1);
  });
});

describe('the conversation surface: capability gating', () => {
  it('offers no attach control when the model has no vision', async () => {
    const host = new ScriptedHost();
    mount(host, NO_CAPABILITIES);
    expect(screen.queryByRole('button', { name: 'Attach an image' })).not.toBeInTheDocument();
  });

  it('offers one when the capability struct says the model takes images', async () => {
    const host = new ScriptedHost();
    mount(host, { ...NO_CAPABILITIES, vision: true });
    expect(screen.getByRole('button', { name: 'Attach an image' })).toBeInTheDocument();
  });
});

describe('the conversation surface: the transcript sent back', () => {
  it('sends the prior turns, and never sends reasoning back', async () => {
    const host = new ScriptedHost();
    mount(host);
    await ask('first');

    act(() => {
      host.push(
        { type: 'reasoningDelta', text: 'private deliberation' },
        { type: 'textDelta', text: 'first answer' },
        done(),
      );
    });
    await ask('second');

    expect(host.sent[1]?.messages).toEqual([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'first answer' },
      { role: 'user', text: 'second' },
    ]);
    expect(JSON.stringify(host.sent[1])).not.toContain('private deliberation');
  });
});

describe('the conversation surface: mounted in the app', () => {
  /**
   * The seam between the two features that meet in `App.tsx`: navigation says
   * *which* conversation, this surface draws *what is in it*. Asserted here
   * rather than assumed, because a surface nothing mounts is a surface nobody
   * sees.
   */
  it('fills the content region once a conversation is selected', async () => {
    const { App } = await import('@/app/App');
    const { useNavigationStore } = await import('@/state/navigation-store');
    const previous = useNavigationStore.getState().selectedConversationId;

    render(<App adapter={new BrowserAdapter()} />);
    act(() => {
      useNavigationStore.setState({ selectedConversationId: 'conversation-1' });
    });

    expect(screen.getByRole('region', { name: 'Conversation' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeInTheDocument();
    expect(screen.queryByText(/transcript surface renders here/)).not.toBeInTheDocument();

    act(() => {
      useNavigationStore.setState({ selectedConversationId: previous });
    });
  });
});

describe('the conversation surface: the real fake host', () => {
  it('carries a message from the composer to a rendered answer over the real protocol', async () => {
    const adapter = new BrowserAdapter();
    await adapter.invoke('settings_put_provider', {
      id: 'workstation',
      displayName: 'Workstation',
      kind: 'local',
      baseUrl: 'http://127.0.0.1:8080/v1',
    });

    render(
      <PlatformProvider adapter={adapter}>
        <ConversationSurface
          providerId="workstation"
          modelId="a-model"
          modelLabel="the model on this machine"
          capabilities={{ ...NO_CAPABILITIES, streaming: true }}
        />
      </PlatformProvider>,
    );

    await ask('round trip please');

    // The fake echoes, so the same words appear in both turns. Scope the
    // assertion to the reply, which is the half that had to travel.
    await waitFor(() => {
      expect(screen.getByLabelText('Model reply')).toBeInTheDocument();
    });
    const reply = screen.getByLabelText('Model reply');
    await waitFor(() => {
      expect(within(reply).getByText('round trip please')).toBeInTheDocument();
    });
    expect(within(reply).getByText('No token counts')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Your message')).getByText('round trip please')).toBeInTheDocument();
  });
});

describe('the conversation surface: what it reports about the turn to come', () => {
  /**
   * The surface owns the transcript and the composer owns the draft, so nothing
   * outside can weigh the next turn — which is why the meter that tried, and
   * was mounted with nothing feeding it, read zero forever. What travels out is
   * this report.
   */
  it('reports the draft as it is typed, and again as it is cleared', async () => {
    const host = new ScriptedHost();
    const reported: (readonly string[])[] = [];
    render(
      <PlatformProvider adapter={host}>
        <ConversationSurface
          providerId="p"
          modelId="m"
          capabilities={{ ...NO_CAPABILITIES, streaming: true }}
          onPendingTurn={(texts) => reported.push(texts)}
        />
      </PlatformProvider>,
    );

    // Reported once on mount, before a key is pressed: an empty turn is a
    // measurement, and the surface says so rather than staying silent.
    await waitFor(() => {
      expect(reported.at(-1)).toEqual([]);
    });

    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'weigh me');
    await waitFor(() => {
      expect(reported.at(-1)).toEqual(['weigh me']);
    });

    await user.clear(screen.getByRole('textbox', { name: 'Message' }));
    await waitFor(() => {
      expect(reported.at(-1)).toEqual([]);
    });
  });

  /**
   * **The anti-drift assertion.** The report and the send are derived from one
   * traversal, and this is what says so: whatever the surface last reported it
   * would send, plus the draft, is byte-for-byte what `chat_send` carried.
   *
   * A meter with its own opinion of the transcript drifts from the sender the
   * first time either changes — reasoning starts being replayed, or an
   * unsettled turn starts counting — and the user finds out by losing a
   * message. This fails the moment the two disagree.
   */
  it('reports exactly the messages chat_send will carry — reasoning excluded', async () => {
    const host = new ScriptedHost();
    let latest: readonly string[] = [];
    render(
      <PlatformProvider adapter={host}>
        <ConversationSurface
          providerId="p"
          modelId="m"
          capabilities={{ ...NO_CAPABILITIES, streaming: true }}
          onPendingTurn={(texts) => {
            latest = texts;
          }}
        />
      </PlatformProvider>,
    );

    await ask('first question');
    act(() => {
      host.push(
        { type: 'reasoningDelta', text: 'private deliberation nobody replays' },
        { type: 'textDelta', text: 'first answer' },
        done({ parts: [{ kind: 'text', text: 'first answer' }] }),
      );
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Model reply')).toHaveTextContent('first answer');
    });

    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'second question');
    await waitFor(() => {
      expect(latest).toEqual(['first question', 'first answer', 'second question']);
    });
    const measured = latest;

    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(host.sent).toHaveLength(2);
    });
    expect(host.sent[1]?.messages.map((message) => message.text)).toEqual(measured);
    // Stated separately because it is the thing most likely to drift: the
    // model's reasoning is not replayed, so it must not be weighed either.
    expect(measured.join(' ')).not.toContain('private deliberation');
  });
});
