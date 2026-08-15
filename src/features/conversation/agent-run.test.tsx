/**
 * The agent-run path through {@link useConversation}, on the branches a user only
 * meets when something has gone wrong.
 *
 * `src/app/composition-root.test.tsx` drives this path through the assembled app
 * twice: a run that completes, and a run the user stops. Those are the two happy
 * shapes. Everything else the join can do — no harness for this model, a
 * conversation already busy, a run that fails, a context index that throws, a
 * retry that has to unpick rows the surface never wrote — was written and run by
 * nothing, and every one of those branches ends in a **sentence on screen**.
 * A wrong sentence costs most exactly when the user is already stuck.
 *
 * ## What is real here and what is a double
 *
 * The store is real: a `BrowserAdapter` and the shipping
 * `createTranscriptRepository` over it, and the *same repository object* is
 * handed to the runtime as its `TranscriptWriter` — which is the production
 * topology, and what makes the retry assertions about rows a harness wrote
 * rather than about a recording double.
 *
 * The model is not: `FakeTurnDriver` scripts turns, and most tests here swap the
 * agent loop for `createManualHarness` so a failure is an event a test emits
 * rather than a race it has to provoke. Where the *loop* is the thing under test
 * — the retry cases, which need real rows in the store — the real
 * `agentLoopHarness` runs.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import {
  createTranscriptRepository,
  type TranscriptRepository,
} from '@/data/transcript-repository';
import { PlatformProvider } from '@/platform/PlatformProvider';
import { BrowserAdapter } from '@/platform/browser-adapter';
import { NO_CAPABILITIES, type ChatCapabilities, type ChatError } from '@/platform/contract';
import type {
  HarnessDefinition,
  HarnessRuntime,
  RunEmit,
  RunFailureCause,
  RunHandle,
  RunRequest,
} from '@/platform/contract-harness';
import { createHarnessRuntime } from '@/runtime/harness-runtime';
import { FakeTurnDriver, chatResponse, createManualHarness } from '@/runtime/run-doubles';

import { useConversation, type Conversation, type ConversationEntry } from './use-conversation';

/** A model that can request a tool, which is what makes an agent run offerable. */
const TOOL_CALLING: ChatCapabilities = { ...NO_CAPABILITIES, streaming: true, toolCalls: true };

interface Fixture {
  readonly adapter: BrowserAdapter;
  readonly conversationId: string;
  readonly transcript: TranscriptRepository;
  readonly wrapper: (props: { children: ReactNode }) => ReactNode;
}

async function fixture(): Promise<Fixture> {
  const adapter = new BrowserAdapter({ now: () => 1_700_000_000_000 });
  const { conversation } = await adapter.invoke('store_create_conversation', {});
  return {
    adapter,
    conversationId: conversation.id,
    transcript: createTranscriptRepository(adapter),
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(PlatformProvider, { adapter, children }),
  };
}

interface RuntimeOptions {
  readonly transcript: TranscriptRepository;
  readonly definitions?: readonly HarnessDefinition[];
  readonly readProjectInstructions?: () => Promise<string | null>;
  readonly turns?: FakeTurnDriver;
}

function runtimeOf(options: RuntimeOptions): HarnessRuntime {
  return createHarnessRuntime({
    turns: options.turns ?? new FakeTurnDriver(),
    transcript: options.transcript,
    toolsFor: () => ({ execute: () => Promise.reject(new Error('no tools in this test')) }),
    readProjectInstructions:
      options.readProjectInstructions ?? ((): Promise<string | null> => Promise.resolve(null)),
    ...(options.definitions === undefined ? {} : { definitions: options.definitions }),
    now: () => 0,
  });
}

function mount(fx: Fixture, runtime: HarnessRuntime) {
  return renderHook(
    () =>
      useConversation({
        conversationId: fx.conversationId,
        providerId: 'workstation',
        modelId: 'local-model',
        capabilities: TOOL_CALLING,
        transcript: fx.transcript,
        runtime,
        scheduleCommit: (run) => {
          run();
        },
      }),
    { wrapper: fx.wrapper },
  );
}

/**
 * A runtime that counts the tails opened on its runs, and the ones closed again.
 *
 * The only way to observe a subscription this surface forgot to drop: a
 * `RunHandle` reports its subscribers to nobody, and a leaked listener on a
 * *terminal* run receives nothing, so no amount of driving events reveals it.
 * Counting at the seam does.
 */
function countingRuntime(inner: HarnessRuntime): {
  readonly runtime: HarnessRuntime;
  opened: () => number;
  live: () => number;
} {
  let opened = 0;
  let closed = 0;
  const wrap = (handle: RunHandle): RunHandle => ({
    ...handle,
    subscribe: (listener, options) => {
      opened += 1;
      const subscription = handle.subscribe(listener, options);
      return {
        replayedFrom: subscription.replayedFrom,
        liveFrom: subscription.liveFrom,
        unsubscribe: () => {
          closed += 1;
          subscription.unsubscribe();
        },
      };
    },
  });
  return {
    runtime: {
      ...inner,
      runs: {
        ...inner.runs,
        start: (request) => {
          const start = inner.runs.start(request);
          return start.outcome === 'started'
            ? { outcome: 'started', handle: wrap(start.handle) }
            : start;
        },
      },
    },
    opened: () => opened,
    live: () => opened - closed,
  };
}

/** The assistant entry of the turn on screen. */
function reply(conversation: Conversation): Extract<ConversationEntry, { kind: 'assistant' }> {
  const last = conversation.entries[conversation.entries.length - 1];
  if (last === undefined || last.kind !== 'assistant') throw new Error('no assistant entry');
  return last;
}

async function messagesIn(adapter: BrowserAdapter, conversationId: string) {
  const { messages } = await adapter.invoke('store_list_messages', { conversationId });
  return messages;
}

/** A `Diagnosis` with nothing optional filled in — Vela's own refusal shape. */
const NO_DIAGNOSIS = { cause: 'transport', correlation: 0 } as const;

/* -------------------------------------------------------------------------- */
/* the run never starts                                                        */
/* -------------------------------------------------------------------------- */

describe('an agent run that never starts says which of the two reasons it was', () => {
  it('says no harness in this build can run against this model', async () => {
    // `selectHarness` answers `unavailable` for an empty registry, which is a
    // build defect rather than a user state — and the contract is explicit that
    // it must be a state the caller renders rather than a throw that takes the
    // window down.
    const fx = await fixture();
    const runtime = runtimeOf({ transcript: fx.transcript, definitions: [] });
    const { result } = mount(fx, runtime);

    act(() => {
      result.current.agent.setEnabled(true);
    });
    act(() => {
      result.current.send('go');
    });

    await waitFor(() => {
      expect(reply(result.current).turn.phase).toBe('failed');
    });
    expect(reply(result.current).turn.refusal).toEqual({
      code: 'HARNESS_UNAVAILABLE',
      message: 'No agent runtime in this build can run against the chosen model.',
    });
    expect(result.current.streaming).toBe(false);
  });

  it('says the conversation is busy when a run outlived the mount that started it', async () => {
    // Not hypothetical, and this is the shape it takes in the product: the
    // directory is built above the remount (`src/app/App.tsx`), so a run
    // survives the user switching conversations. Coming back and sending finds
    // `LiveRuns` still holding a live run for this conversation, and "at most one
    // live run per conversation" makes that a `conversationBusy` rejection.
    const fx = await fixture();
    const manual = createManualHarness('manual');
    const runtime = runtimeOf({ transcript: fx.transcript, definitions: [manual.definition] });

    const orphan = runtime.runs.start({
      runId: 'run-from-a-previous-mount',
      conversationId: fx.conversationId,
      projectId: '00000000-0000-4000-8000-000000000001',
      harnessId: 'manual',
      models: { primary: { providerId: 'workstation', modelId: 'local-model' } },
      input: [{ role: 'user', text: 'still going' }],
      context: { systemPrompt: null, preload: [] },
      limits: { maxSteps: 4, maxToolCalls: 4, wallClockMs: 1_000 },
      capabilities: { multiStep: true, toolExecution: true, auxiliaryModel: false },
    });
    expect(orphan.outcome).toBe('started');

    const { result } = mount(fx, runtime);
    act(() => {
      result.current.agent.setEnabled(true);
    });
    act(() => {
      result.current.send('and again');
    });

    await waitFor(() => {
      expect(reply(result.current).turn.phase).toBe('failed');
    });
    expect(reply(result.current).turn.refusal).toEqual({
      code: 'RUN_BUSY',
      message: 'Another run is already going in this conversation.',
    });
    // The rejection is decided before anything is built, so the orphan is still
    // the only run there is.
    expect(manual.started.map((request: RunRequest) => request.runId)).toEqual([
      'run-from-a-previous-mount',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* the run starts and fails                                                    */
/* -------------------------------------------------------------------------- */

describe('a run that fails is drawn as a failure, in Vela’s own words', () => {
  const CAUSES: readonly (readonly [RunFailureCause, string])[] = [
    ['toolExecutorFailed', 'A tool this run started could not be run.'],
    ['contextResolverFailed', 'The material this run was asked to read could not be loaded.'],
    ['harnessFault', 'The agent runtime failed while driving this run.'],
  ];

  for (const [cause, sentence] of CAUSES) {
    it(`renders ${cause} as a sentence with no endpoint text in it`, async () => {
      // `RunFailureCause` is a closed set with no free-text field, for the reason
      // `ChatError` documents: the detail belongs in the local debug log, not in
      // a string that ends up rendered. So every sentence is written in
      // `use-conversation.ts` and this is what pins it.
      const fx = await fixture();
      const manual = createManualHarness('manual');
      const runtime = runtimeOf({ transcript: fx.transcript, definitions: [manual.definition] });
      const { result } = mount(fx, runtime);

      act(() => {
        result.current.agent.setEnabled(true);
      });
      act(() => {
        result.current.send('go');
      });
      await waitFor(() => {
        expect(manual.started).toHaveLength(1);
      });

      const runId = manual.started[0]?.runId as string;
      act(() => {
        manual.emitTo(runId, { type: 'runStarted', capabilities: manual.started[0]!.capabilities });
        manual.emitTo(runId, {
          type: 'runFinished',
          outcome: { type: 'failed', failure: { kind: 'harness', cause } },
        });
      });

      await waitFor(() => {
        expect(result.current.streaming).toBe(false);
      });
      expect(reply(result.current).turn.phase).toBe('failed');
      expect(reply(result.current).turn.refusal).toEqual({ code: cause, message: sentence });
    });
  }

  it('leaves the endpoint’s own error alone when the stream already carried one', async () => {
    // The rule `settleRun` states: it settles whatever the stream left open and
    // settles nothing the stream already closed. A provider failure arrives as
    // `chat.error` first — `agent-loop-harness.ts` emits the event before it
    // finishes the run — and that error is the one with the `Diagnosis` on it, so
    // overwriting it with a `refusal` would strip the only thing that tells a
    // user which of three configured endpoints failed.
    const fx = await fixture();
    const manual = createManualHarness('manual');
    const runtime = runtimeOf({ transcript: fx.transcript, definitions: [manual.definition] });
    const { result } = mount(fx, runtime);

    act(() => {
      result.current.agent.setEnabled(true);
    });
    act(() => {
      result.current.send('go');
    });
    await waitFor(() => {
      expect(manual.started).toHaveLength(1);
    });

    const runId = manual.started[0]?.runId as string;
    const error: ChatError = { kind: 'authFailed', diagnosis: NO_DIAGNOSIS };
    act(() => {
      manual.emitTo(runId, { type: 'chat', turnId: `${runId}:1`, event: { type: 'error', error } });
      manual.emitTo(runId, {
        type: 'runFinished',
        outcome: { type: 'failed', failure: { kind: 'provider', error } },
      });
    });

    await waitFor(() => {
      expect(result.current.streaming).toBe(false);
    });
    expect(reply(result.current).turn.phase).toBe('failed');
    expect(reply(result.current).turn.error).toEqual(error);
    expect(reply(result.current).turn.refusal).toBeNull();
  });

  it('still says something when a provider failure arrives with no stream behind it', async () => {
    // **Not reachable from `agentLoopHarness`**, which always emits the
    // `chat.error` before it finishes the run — so the test above is the shape
    // this build produces. `RuntimeHarness` is a seam, though, and a third
    // implementation may report a provider failure it never streamed. The
    // alternative to this branch is a turn drawn as still arriving under a
    // surface that has stopped streaming.
    const fx = await fixture();
    const manual = createManualHarness('manual');
    const runtime = runtimeOf({ transcript: fx.transcript, definitions: [manual.definition] });
    const { result } = mount(fx, runtime);

    act(() => {
      result.current.agent.setEnabled(true);
    });
    act(() => {
      result.current.send('go');
    });
    await waitFor(() => {
      expect(manual.started).toHaveLength(1);
    });

    const runId = manual.started[0]?.runId as string;
    act(() => {
      manual.emitTo(runId, {
        type: 'runFinished',
        outcome: {
          type: 'failed',
          failure: { kind: 'provider', error: { kind: 'rateLimited', retryAfterMs: null, diagnosis: NO_DIAGNOSIS } },
        },
      });
    });

    await waitFor(() => {
      expect(result.current.streaming).toBe(false);
    });
    expect(reply(result.current).turn.refusal).toEqual({
      code: 'rateLimited',
      message: 'The endpoint did not finish this run.',
    });
  });

  it('settles a run that was over before the tail was attached', async () => {
    // The replay is delivered *before* `subscribe` returns, so a harness that
    // finishes inside `start` hands its `runFinished` to the listener while the
    // subscription it would have to drop does not exist yet. What must not
    // happen is the surface sitting on "waiting for the first token" forever
    // because the one event that ends the turn arrived too early to be heard.
    const fx = await fixture();
    const instant: HarnessDefinition = {
      descriptor: {
        id: 'instant',
        displayName: 'Instant',
        capabilities: { multiStep: true, toolExecution: true, auxiliaryModel: false },
        requiresModelCapabilities: [],
      },
      create: () => ({
        start: (request: RunRequest, emit: RunEmit) => {
          emit({ type: 'runStarted', capabilities: request.capabilities });
          emit({
            type: 'runFinished',
            outcome: { type: 'failed', failure: { kind: 'harness', cause: 'harnessFault' } },
          });
          return { cancel: () => Promise.resolve() };
        },
      }),
    };
    const counted = countingRuntime(
      runtimeOf({ transcript: fx.transcript, definitions: [instant] }),
    );
    const { result } = mount(fx, counted.runtime);

    act(() => {
      result.current.agent.setEnabled(true);
    });
    act(() => {
      result.current.send('go');
    });

    await waitFor(() => {
      expect(result.current.streaming).toBe(false);
    });
    expect(reply(result.current).turn.phase).toBe('failed');
    expect(reply(result.current).turn.refusal?.code).toBe('harnessFault');

    // …and the tail it opened is closed. The listener that ends the run runs
    // *inside* `subscribe`, so the subscription it has to drop does not exist
    // yet when it looks for it: a surface that only ever unsubscribed through
    // the ref would leave this one attached to the directory for as long as the
    // directory lives. Nothing else can see that — a terminal run delivers
    // nothing — which is why it is counted at the seam rather than provoked.
    expect(counted.opened(), 'the counter never saw a subscribe; the wrapper is vacuous').toBe(1);
    expect(counted.live(), 'a tail was left on a run that had already finished').toBe(0);
  });

  it('does not leave a run that completed without streaming drawn as still arriving', async () => {
    // The third arm of `settleRun`, and the one that is not about failure: a run
    // can complete having said nothing. `agentLoopHarness` does it for a step
    // budget of zero or a wall clock already spent — `finishCompleted(null)`,
    // `stopReason` `unspecified`, because inventing `endTurn` would claim the
    // model said something. Neither is reachable on `DEFAULT_RUN_LIMITS`, so
    // this is written against the seam rather than the shipped limits. Without
    // the arm the turn keeps its spinner under a surface that has stopped
    // streaming, which is the one state `turn-stream.ts` promises cannot happen.
    const fx = await fixture();
    const silent: HarnessDefinition = {
      descriptor: {
        id: 'silent',
        displayName: 'Silent',
        capabilities: { multiStep: true, toolExecution: true, auxiliaryModel: false },
        requiresModelCapabilities: [],
      },
      create: () => ({
        start: (request: RunRequest, emit: RunEmit) => {
          emit({ type: 'runStarted', capabilities: request.capabilities });
          emit({ type: 'runFinished', outcome: { type: 'completed', stopReason: 'unspecified' } });
          return { cancel: () => Promise.resolve() };
        },
      }),
    };
    const runtime = runtimeOf({ transcript: fx.transcript, definitions: [silent] });
    const { result } = mount(fx, runtime);

    act(() => {
      result.current.agent.setEnabled(true);
    });
    act(() => {
      result.current.send('go');
    });

    await waitFor(() => {
      expect(result.current.streaming).toBe(false);
    });
    expect(reply(result.current).turn.phase).toBe('complete');
    expect(reply(result.current).turn.stopReason).toBe('unspecified');
    expect(reply(result.current).turn.refusal).toBeNull();
  });

  it('drops its tail when the surface goes, and leaves the run itself alone', async () => {
    // The asymmetry the join rests on: a run outlives the surface that started
    // it — the directory is built above `App.tsx`'s remount — so unmounting must
    // *not* cancel it. It must drop the listener, though, or every conversation
    // the user visits leaves one behind on a run that is still emitting.
    const fx = await fixture();
    const manual = createManualHarness('manual');
    const counted = countingRuntime(
      runtimeOf({ transcript: fx.transcript, definitions: [manual.definition] }),
    );
    const { result, unmount } = mount(fx, counted.runtime);

    act(() => {
      result.current.agent.setEnabled(true);
    });
    act(() => {
      result.current.send('go');
    });
    await waitFor(() => {
      expect(manual.started).toHaveLength(1);
    });
    expect(counted.live()).toBe(1);

    unmount();

    expect(counted.live(), 'the surface left a tail on a run it stopped drawing').toBe(0);
    expect(manual.cancelled, 'unmounting is not cancelling').toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* context                                                                     */
/* -------------------------------------------------------------------------- */

describe('context the run could not index', () => {
  it('starts the run with nothing preloaded rather than not starting it', async () => {
    // The resolver reads through an injected function precisely because there is
    // no project command to call yet, and the day there is one it can fail. A
    // run refused because a *source of extra prompt material* could not be
    // listed would be a chat the user cannot have for a reason they cannot see;
    // an empty `preload` is a run with nothing extra, which is what every run
    // has today anyway.
    const fx = await fixture();
    const manual = createManualHarness('manual');
    const runtime = runtimeOf({
      transcript: fx.transcript,
      definitions: [manual.definition],
      readProjectInstructions: () => Promise.reject(new Error('project_get is not a command')),
    });
    const { result } = mount(fx, runtime);

    act(() => {
      result.current.agent.setEnabled(true);
    });
    act(() => {
      result.current.send('go');
    });

    await waitFor(() => {
      expect(manual.started).toHaveLength(1);
    });
    expect(manual.started[0]?.context).toEqual({ systemPrompt: null, preload: [] });
    expect(result.current.streaming).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* the record a run leaves, and what retry has to unpick                       */
/* -------------------------------------------------------------------------- */

/**
 * The transcript repository with one append held open on demand.
 *
 * Only the *question* is delayed. A run writes its rows through the same object
 * and off this surface's write chain, which is exactly the interleaving the two
 * tests below are about.
 */
function withHeldUserAppend(inner: TranscriptRepository): TranscriptRepository & {
  hold: () => void;
  release: () => void;
} {
  let gate: Promise<void> | null = null;
  let open: () => void = () => undefined;
  return {
    ...inner,
    append: async (request) => {
      if (gate !== null && request.role === 'user') await gate;
      return inner.append(request);
    },
    hold: () => {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release: () => {
      open();
      gate = null;
    },
  };
}

/** The real loop, against a driver that answers every turn with one sentence. */
function loopRuntime(transcript: TranscriptRepository, answers: readonly string[]): HarnessRuntime {
  const turns = new FakeTurnDriver();
  let call = 0;
  turns.always((request, driver) => {
    const text = answers[Math.min(call, answers.length - 1)] ?? '';
    call += 1;
    driver.emit(request.turnId, { type: 'textDelta', text });
    driver.emit(request.turnId, {
      type: 'done',
      response: chatResponse({ parts: [{ kind: 'text', text }] }),
    });
  });
  return createHarnessRuntime({
    turns,
    transcript,
    toolsFor: () => ({ execute: () => Promise.reject(new Error('no tools in this test')) }),
    readProjectInstructions: () => Promise.resolve(null),
    now: () => 0,
  });
}

describe('retrying an agent turn replaces the rows the run wrote', () => {
  it('writes the question before the run opens a row of its own', async () => {
    // A run's assistant row is opened by the harness, off this surface's write
    // chain. Without the barrier in `startRun` the answer can be written before
    // the question and the record reads in an order the conversation never
    // happened in — which is not a race a fast store makes impossible, only one
    // it makes rare.
    const fx = await fixture();
    const held = withHeldUserAppend(fx.transcript);
    const runtime = loopRuntime(held, ['answered']);
    const { result } = mount({ ...fx, transcript: held }, runtime);

    held.hold();
    act(() => {
      result.current.agent.setEnabled(true);
    });
    act(() => {
      result.current.send('asked');
    });
    // Every chance the run has to get ahead of the question, taken. Without the
    // barrier the loop has already sent its turn and opened a `streaming` row by
    // now; with it, the conversation is still empty.
    await act(async () => {
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(await messagesIn(fx.adapter, fx.conversationId)).toEqual([]);

    act(() => {
      held.release();
    });
    await waitFor(async () => {
      expect(await messagesIn(fx.adapter, fx.conversationId)).toHaveLength(2);
    });
    const messages = await messagesIn(fx.adapter, fx.conversationId);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('replaces the run’s answer instead of leaving it beside the new one', async () => {
    const fx = await fixture();
    const runtime = loopRuntime(fx.transcript, ['first answer', 'second answer']);
    const { result } = mount(fx, runtime);

    act(() => {
      result.current.agent.setEnabled(true);
    });
    act(() => {
      result.current.send('asked');
    });
    await waitFor(async () => {
      expect(await messagesIn(fx.adapter, fx.conversationId)).toHaveLength(2);
    });
    await waitFor(() => {
      expect(result.current.streaming).toBe(false);
    });

    act(() => {
      result.current.retry();
    });
    await waitFor(() => {
      expect(reply(result.current).turn.answer).toBe('second answer');
    });
    await waitFor(async () => {
      const messages = await messagesIn(fx.adapter, fx.conversationId);
      expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
      expect(messages[1]?.parts).toEqual([{ kind: 'text', text: 'second answer' }]);
    });
  });

  it('closes the window in which a retry could beat the question it is replacing', async () => {
    // ── THE RACE ───────────────────────────────────────────────────────────
    // The anchor for the deletion is the question's own store id, and that id is
    // set by an append **on the write chain**. So there used to be a window: the
    // run could answer and write its rows while the question was still being
    // written, `retry` would find no anchor, and the id-keyed removal it fell
    // through to can never find a row a harness wrote. The old answer survived
    // the retry and the conversation came back holding two of them, with the
    // answer filed before the question that provoked it.
    //
    // The timeline below is that window held open: the store refuses to write
    // the question, and everything else is allowed to proceed as fast as it
    // likes. Without the barrier in `startRun` the run answers inside it, the
    // retry lands in it, and the store ends up `[assistant, user, assistant]`.
    // With the barrier there is no window to land in — the run has not started,
    // so `retry` is the no-op that `streaming` makes it — and the record is the
    // two rows it should be.
    const fx = await fixture();
    const held = withHeldUserAppend(fx.transcript);
    const runtime = loopRuntime(held, ['first answer', 'second answer']);
    const { result } = mount({ ...fx, transcript: held }, runtime);

    held.hold();
    act(() => {
      result.current.agent.setEnabled(true);
    });
    act(() => {
      result.current.send('asked');
    });

    // Whatever the run can get done while the question is unwritten, it gets
    // done here.
    await act(async () => {
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    act(() => {
      result.current.retry();
    });
    act(() => {
      held.release();
    });

    await waitFor(() => {
      expect(result.current.streaming).toBe(false);
    });
    await waitFor(async () => {
      const messages = await messagesIn(fx.adapter, fx.conversationId);
      expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    });
    const messages = await messagesIn(fx.adapter, fx.conversationId);
    expect(messages[0]?.parts).toEqual([{ kind: 'text', text: 'asked' }]);
  });
});

/* -------------------------------------------------------------------------- */
/* what the run is actually sent                                              */
/* -------------------------------------------------------------------------- */

/**
 * The joint the wave-i merge created, and the reason it is tested rather than
 * trusted.
 *
 * Track 6 wrote `runs.start({ input: toMessages(history, userText, parts) })`
 * on a branch where `toMessages` took three arguments. Track 9 had since made
 * the memory preamble a required fourth. The compiler caught *that* spelling,
 * but it would equally accept a literal `null` — and a run started with the
 * agent toggle on would then be the one path in this hook that silently forgets
 * everything the user asked Vela to remember. Nothing else here looks at what
 * the run is handed, so nothing else would notice.
 */
describe('an agent run carries the same memory the plain chat path does', () => {
  it('leads the run’s input with the remembered facts, not just the question', async () => {
    const fx = await fixture();
    await fx.adapter.invoke('memory_add', {
      scope: { kind: 'global' },
      category: 'techPrefs',
      content: 'always answers in British English',
    });

    // The only way to see what the surface handed the runtime: a `RunRequest`
    // is not readable back off a `RunHandle`.
    let sent: RunRequest | null = null;
    const inner = runtimeOf({ transcript: fx.transcript });
    const runtime: HarnessRuntime = {
      ...inner,
      runs: {
        ...inner.runs,
        start: (request) => {
          sent = request;
          return inner.runs.start(request);
        },
      },
    };

    const { result } = mount(fx, runtime);
    // The memory read is an effect; the block is empty until it lands.
    await waitFor(() => {
      expect(result.current.memoryPreamble).toContain('British English');
    });

    act(() => {
      result.current.agent.setEnabled(true);
    });
    act(() => {
      result.current.send('what is the weather');
    });

    await waitFor(() => {
      expect(sent).not.toBeNull();
    });
    const request = sent as unknown as RunRequest;
    expect(request.input[0]).toMatchObject({ role: 'system' });
    expect(request.input[0]?.text).toContain('British English');
    // The question still arrives, and after the block rather than before it.
    expect(request.input[request.input.length - 1]).toMatchObject({
      role: 'user',
      text: 'what is the weather',
    });
  });
});
