/**
 * The loop, and the four accumulation rules `contract-harness.ts` says are not
 * per-harness policy.
 *
 * The contract's argument for freezing them is that two harnesses accumulating
 * differently produce two transcripts that cannot be swapped between engines —
 * the one property the study recommends taking whole. It states them and nothing
 * held them. These tests read the `messages` the loop actually put on the wire,
 * turn by turn, through a fake `TurnDriver`. Nothing here opens a socket.
 */

import { describe, expect, it } from 'vitest';

import type {
  ChatMessageInput,
  ContentPart,
  ContentPartInput,
  MessageRole,
} from '@/platform/contract';
import type {
  ContextChunk,
  ContextRef,
  ExecutableToolCall,
  HarnessServices,
  LiveRuns,
  RunEvent,
  RunHandle,
  RunOutcome,
  RunRequest,
  RuntimeHarness,
  ToolExecutor,
  ToolResultPart,
} from '@/platform/contract-harness';

import { agentLoopHarness, singleTurnHarness } from './agent-loop-harness';
import { contentPartCodec } from './content-part-codec';
import { createHarnessRegistry } from './harness-registry';
import { createLiveRuns } from './live-runs';
import {
  FakeTurnDriver,
  chatResponse,
  recordingTranscript,
  runRequest,
  textReply,
  toolCall,
} from './run-doubles';

/** One turn of the event loop. Enough for the harness to reach its next await. */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A promise a test releases by hand. Seeded so no narrowing games are needed. */
function gate(): { readonly wait: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    release = () => {
      resolve();
    };
  });
  return { wait, release: () => release() };
}

interface BenchOptions {
  readonly tools?: ToolExecutor | undefined;
  readonly load?: ((ref: ContextRef) => Promise<ContextChunk | null>) | undefined;
}

class Bench {
  readonly turns = new FakeTurnDriver();
  readonly transcript = recordingTranscript();
  readonly clock = { ms: 0 };
  readonly contextLoads: ContextRef[] = [];
  readonly events: RunEvent[] = [];
  readonly runs: LiveRuns;
  private outcome: RunOutcome | null = null;
  private settle: ((outcome: RunOutcome) => void) | null = null;

  constructor(options: BenchOptions = {}) {
    const registry = createHarnessRegistry([agentLoopHarness, singleTurnHarness]);
    this.runs = createLiveRuns(registry, () => ({
      turns: this.turns,
      tools: options.tools ?? {
        execute: () => Promise.reject(new Error('this bench has no tool executor')),
      },
      context: {
        index: () => Promise.resolve([]),
        load: (ref: ContextRef) => {
          this.contextLoads.push(ref);
          return options.load === undefined ? Promise.resolve(null) : options.load(ref);
        },
      },
      transcript: this.transcript.writer,
      parts: contentPartCodec,
      now: () => this.clock.ms,
    }));
  }

  start(overrides: Partial<RunRequest> = {}): RunHandle {
    const start = this.runs.start(runRequest(overrides));
    if (start.outcome !== 'started') throw new Error(`rejected: ${start.reason}`);
    start.handle.subscribe(
      (envelope) => {
        this.events.push(envelope.event);
        if (envelope.event.type !== 'runFinished') return;
        const outcome = envelope.event.outcome;
        if (this.settle === null) this.outcome = outcome;
        else this.settle(outcome);
      },
      { fromSeq: 0 },
    );
    return start.handle;
  }

  finished(): Promise<RunOutcome> {
    return new Promise<RunOutcome>((resolve) => {
      if (this.outcome !== null) {
        resolve(this.outcome);
        return;
      }
      this.settle = resolve;
    });
  }

  /** The `messages` of the nth `chat_send`, 0-based. */
  sentMessages(index: number): readonly ChatMessageInput[] {
    const request = this.turns.sent[index];
    if (request === undefined) throw new Error(`no send at index ${index}`);
    return request.messages;
  }

  kinds(): readonly string[] {
    return this.events.map((event) => event.type);
  }
}

function result(callId: string, content: string): ToolResultPart {
  return { kind: 'toolResult', callId, content, isError: false };
}

/** A message as a comparison sees it: who said it, and with what parts. */
interface Row {
  readonly role: MessageRole;
  readonly parts: readonly ContentPartInput[];
}

/**
 * The rows the store would hold, folded out of the appends and their updates.
 *
 * `store_update_message` replaces the whole part list, and an omitted `parts`
 * means "leave it alone" — so a row's final content is its last update that
 * carried parts, or the append's if none did. This is the read-back the contract
 * compares the in-memory sequence against, and doing the fold here rather than
 * asserting on raw calls is the whole point: the claim is about what survives.
 */
function storedRows(transcript: ReturnType<typeof recordingTranscript>): readonly Row[] {
  return transcript.appended.map((append, index) => {
    const id = transcript.ids[index];
    const parts = transcript.updated
      .filter((update) => update.messageId === id && update.parts !== undefined)
      .map((update) => update.parts)
      .at(-1);
    return { role: append.role, parts: parts ?? append.parts };
  });
}

/** The same view of an in-memory message, so the two sequences are comparable. */
function asRow(message: ChatMessageInput): Row {
  return { role: message.role, parts: message.parts ?? [{ kind: 'text', text: message.text }] };
}

/* -------------------------------------------------------------------------- */

describe('the run stream', () => {
  it('emits runStarted first and exactly one terminal event last', async () => {
    const bench = new Bench();
    bench.turns.scriptText('hello');
    bench.start();

    const outcome = await bench.finished();
    expect(bench.kinds()[0]).toBe('runStarted');
    expect(bench.kinds().filter((kind) => kind === 'runFinished')).toHaveLength(1);
    expect(bench.kinds()[bench.kinds().length - 1]).toBe('runFinished');
    expect(outcome).toEqual({ type: 'completed', stopReason: 'endTurn' });
  });

  it('carries the six chat events verbatim rather than restating them', async () => {
    // "`chat` carries those six events verbatim — this is not a second
    // streaming vocabulary and must never become one."
    const bench = new Bench();
    bench.turns.script((request, driver) => {
      driver.emit(request.turnId, { type: 'reasoningDelta', text: 'thinking' });
      driver.emit(request.turnId, { type: 'textDelta', text: 'answer' });
      driver.emit(request.turnId, { type: 'done', response: textReply('answer') });
    });
    bench.start();
    await bench.finished();

    const chat = bench.events.filter((event) => event.type === 'chat');
    expect(chat.map((event) => (event.type === 'chat' ? event.event.type : ''))).toEqual([
      'reasoningDelta',
      'textDelta',
      'done',
    ]);
  });
});

describe('the accumulation rule', () => {
  it("appends the assistant's own turn and one message per tool result, in call order", async () => {
    const calls: ExecutableToolCall[] = [];
    const bench = new Bench({
      tools: {
        execute: (call) => {
          calls.push(call);
          return Promise.resolve(result(call.callId, `ran ${call.name}`));
        },
      },
    });
    const assistantParts: readonly ContentPart[] = [
      { kind: 'text', text: 'working' },
      { kind: 'toolCall', callId: 'c1', name: 'alpha', arguments: {} },
      { kind: 'toolCall', callId: 'c2', name: 'beta', arguments: {} },
    ];
    bench.turns.script((request, driver) => {
      driver.emit(request.turnId, {
        type: 'done',
        response: chatResponse({
          parts: assistantParts,
          toolCalls: [toolCall('c1', 'alpha', {}), toolCall('c2', 'beta', {})],
          stopReason: 'toolUse',
        }),
      });
    });
    bench.turns.scriptText('done');
    bench.start();
    await bench.finished();

    expect(calls.map((call) => call.callId)).toEqual(['c1', 'c2']);
    // Rule 1: the assistant's own turn, always appended, parts from the codec.
    // Rule 3: one message per tool result, role 'tool', one part, in call order.
    // Rule 4: nothing else is inserted.
    expect(bench.sentMessages(1)).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: '', parts: assistantParts },
      { role: 'tool', text: '', parts: [result('c1', 'ran alpha')] },
      { role: 'tool', text: '', parts: [result('c2', 'ran beta')] },
    ]);
  });

  it('re-sends reasoning verbatim, signature included', async () => {
    // "some backends require a signed reasoning block returned exactly as
    // issued ... The projection that leaves reasoning out belongs to the
    // rebuild-the-prompt-from-the-store path, not to the live loop."
    const bench = new Bench({
      tools: { execute: (call) => Promise.resolve(result(call.callId, 'ok')) },
    });
    const parts: readonly ContentPart[] = [
      { kind: 'reasoning', text: 'deliberating', signature: 'sig-abc', redacted: false },
      { kind: 'toolCall', callId: 'c1', name: 'alpha', arguments: {} },
    ];
    bench.turns.script((request, driver) => {
      driver.emit(request.turnId, {
        type: 'done',
        response: chatResponse({ parts, toolCalls: [toolCall('c1', 'alpha', {})], stopReason: 'toolUse' }),
      });
    });
    bench.turns.scriptText('done');
    bench.start();
    await bench.finished();

    expect(bench.sentMessages(1)[1]).toEqual({ role: 'assistant', text: '', parts });
  });

  it('composes the system message once, before turn 1, and never again', async () => {
    // Rule 4's other half. "No synthetic 'continue' turn, **no system message
    // per step**. `RunContextRequest.systemPrompt` is composed once, by the
    // caller, before the run."
    //
    // The test below it — 'inserts no synthetic turn between steps' — runs with
    // `systemPrompt` null and no preload, so `composeSystemMessage` answers null
    // and a loop that re-composed on every step would be invisible to it. This
    // one gives the run both halves of the material a system message is made of,
    // and reads turn 2's wire messages.
    //
    // What it costs when it goes: the model reads the project's instructions
    // twice on turn 2 and three times on turn 3 — no crash, no event, an answer
    // built from a prompt nobody wrote.
    const ref: ContextRef = {
      source: 'projectInstructions',
      id: 'r1',
      title: 'Project instructions',
      estimatedTokens: null,
    };
    const bench = new Bench({
      tools: { execute: (call) => Promise.resolve(result(call.callId, 'ok')) },
      load: (r) => Promise.resolve({ ref: r, text: 'be brief' }),
    });
    bench.turns.script((request, driver) => {
      driver.emit(request.turnId, {
        type: 'done',
        response: chatResponse({ toolCalls: [toolCall('c1', 'alpha', {})], stopReason: 'toolUse' }),
      });
    });
    bench.turns.scriptText('done');
    bench.start({ context: { systemPrompt: 'you are helpful', preload: [ref] } });
    await bench.finished();

    const composed: ChatMessageInput = { role: 'system', text: 'you are helpful\n\nbe brief' };
    expect(bench.sentMessages(0)).toEqual([composed, { role: 'user', text: 'hello' }]);
    expect(
      bench.sentMessages(1).filter((message) => message.role === 'system'),
      'the one system message is composed before turn 1 and never re-inserted',
    ).toEqual([composed]);
    // And it is still leading, followed by nothing but the accumulation rule's
    // own three additions.
    expect(bench.sentMessages(1).map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ]);
  });

  it('inserts no synthetic turn between steps', async () => {
    const bench = new Bench({
      tools: { execute: (call) => Promise.resolve(result(call.callId, 'ok')) },
    });
    bench.turns.script((request, driver) => {
      driver.emit(request.turnId, {
        type: 'done',
        response: chatResponse({ toolCalls: [toolCall('c1', 'alpha', {})], stopReason: 'toolUse' }),
      });
    });
    bench.turns.scriptText('done');
    bench.start();
    await bench.finished();

    const roles = bench.sentMessages(1).map((message) => message.role);
    expect(roles).toEqual(['user', 'assistant', 'tool']);
  });

  it('persists the sequence it accumulated, in the same order', async () => {
    // "The same four rules decide what `TranscriptWriter` persists, in the same
    // order, so that a transcript read back from the store and a transcript
    // accumulated in memory are the same sequence. Where they would differ, the
    // store is right — it is the one that survives."
    //
    // Nothing compared the two. The tests around this one read the appends'
    // roles and statuses and check that every append carries at least one part,
    // and a loop that persisted the assistant turn *without* its `toolCall`
    // parts, or wrote the tool rows in an order the calls did not have, passes
    // every one of them. The store then holds an answer that never mentions
    // calling anything, or results attached to the wrong calls — invisible today
    // only because the on-screen transcript drops tool rows, and visible the
    // moment anything rebuilds a prompt from the store.
    const assistantParts: readonly ContentPart[] = [
      { kind: 'text', text: 'working' },
      { kind: 'toolCall', callId: 'c1', name: 'alpha', arguments: {} },
      { kind: 'toolCall', callId: 'c2', name: 'beta', arguments: {} },
    ];
    const bench = new Bench({
      tools: { execute: (call) => Promise.resolve(result(call.callId, `ran ${call.name}`)) },
    });
    bench.turns.script((request, driver) => {
      driver.emit(request.turnId, {
        type: 'done',
        response: chatResponse({
          parts: assistantParts,
          toolCalls: [toolCall('c1', 'alpha', {}), toolCall('c2', 'beta', {})],
          stopReason: 'toolUse',
        }),
      });
    });
    bench.turns.script((request, driver) => {
      driver.emit(request.turnId, {
        type: 'done',
        response: chatResponse({
          parts: [{ kind: 'text', text: 'once more' }],
          toolCalls: [toolCall('c3', 'gamma', {})],
          stopReason: 'toolUse',
        }),
      });
    });
    bench.turns.scriptText('done');
    bench.start();
    await bench.finished();

    // What the loop accumulated: turn 3's wire messages, less the caller's own
    // input, which the store never held because this run did not write it.
    const accumulated = bench.sentMessages(2).slice(1).map(asRow);
    expect(accumulated.map((row) => row.role)).toEqual([
      'assistant',
      'tool',
      'tool',
      'assistant',
      'tool',
    ]);

    const persisted = storedRows(bench.transcript);
    expect(
      persisted.slice(0, accumulated.length),
      'the store and the loop must hold the same sequence, in the same order',
    ).toEqual(accumulated);

    // The one row memory has no copy of: the last turn's own answer, which no
    // later turn re-sends. Asserted rather than truncated away, so the
    // comparison above cannot be passing because both sides were cut short.
    expect(persisted).toHaveLength(accumulated.length + 1);
    expect(persisted.at(-1)).toEqual({
      role: 'assistant',
      parts: [{ kind: 'text', text: 'done' }],
    });
  });
});

describe('context', () => {
  it('loads the preload, reports each one, and composes one system message', async () => {
    const ref: ContextRef = {
      source: 'projectInstructions',
      id: 'r1',
      title: 'Project instructions',
      estimatedTokens: null,
    };
    const bench = new Bench({ load: (r) => Promise.resolve({ ref: r, text: 'be brief' }) });
    bench.turns.scriptText('ok');
    bench.start({ context: { systemPrompt: 'you are helpful', preload: [ref] } });
    await bench.finished();

    expect(bench.contextLoads).toEqual([ref]);
    expect(bench.events).toContainEqual({ type: 'contextLoaded', ref });
    expect(bench.sentMessages(0)[0]).toEqual({
      role: 'system',
      text: 'you are helpful\n\nbe brief',
    });
  });

  it('loads the preload in the order asked for, whatever settles first', async () => {
    // "`preload`: loaded up front, **in this order**." Every other context test
    // in this file uses exactly one ref, so nothing held the ordering — and
    // `composeSystemMessage` joins the chunks in load order, so a loop that
    // loaded them concurrently (the obvious optimisation: the loads are
    // independent) would compose the caller's material in whatever order the
    // promises settled and report a reading order the run did not have. Same
    // text, different order, different answer, no event.
    //
    // The two loads settle in the opposite order to the one asked for, so a
    // concurrent loop cannot come out right by accident.
    const first: ContextRef = { source: 'skill', id: 'a', title: 'A', estimatedTokens: null };
    const second: ContextRef = { source: 'memory', id: 'b', title: 'B', estimatedTokens: null };
    const bench = new Bench({
      load: async (ref) => {
        if (ref.id === 'a') await flush(3);
        return { ref, text: `body of ${ref.id}` };
      },
    });
    bench.turns.scriptText('ok');
    bench.start({ context: { systemPrompt: 'lead', preload: [first, second] } });
    await bench.finished();

    expect(bench.sentMessages(0)[0]).toEqual({
      role: 'system',
      text: 'lead\n\nbody of a\n\nbody of b',
    });
    // And the run reported the reading order it actually had.
    expect(bench.events.filter((event) => event.type === 'contextLoaded')).toEqual([
      { type: 'contextLoaded', ref: first },
      { type: 'contextLoaded', ref: second },
    ]);
    expect(bench.contextLoads).toEqual([first, second]);
  });

  it('degrades rather than fails when named material has gone', async () => {
    // "The run continues without it and must emit a `contextUnavailable`
    // degradation" — a missing ref is a degradation, not a failure.
    const ref: ContextRef = { source: 'skill', id: 'gone', title: 'Gone', estimatedTokens: null };
    const bench = new Bench({ load: () => Promise.resolve(null) });
    bench.turns.scriptText('ok');
    bench.start({ context: { systemPrompt: null, preload: [ref] } });

    const outcome = await bench.finished();
    expect(outcome.type).toBe('completed');
    expect(bench.events).toContainEqual({
      type: 'degraded',
      degradation: { kind: 'contextUnavailable', ref },
    });
  });

  it('fails the run with contextResolverFailed when the resolver rejects', async () => {
    // "`contextResolverFailed` — ContextResolver rejected. A missing ref is a
    // degradation, not this."
    const ref: ContextRef = { source: 'memory', id: 'm', title: 'M', estimatedTokens: null };
    const bench = new Bench({ load: () => Promise.reject(new Error('disk')) });
    bench.start({ context: { systemPrompt: null, preload: [ref] } });

    expect(await bench.finished()).toEqual({
      type: 'failed',
      failure: { kind: 'harness', cause: 'contextResolverFailed' },
    });
  });
});

describe('limits', () => {
  it('stops at maxSteps and says it was capped', async () => {
    const bench = new Bench({
      tools: { execute: (call) => Promise.resolve(result(call.callId, 'ok')) },
    });
    bench.turns.always((request, driver) => {
      driver.emit(request.turnId, {
        type: 'done',
        response: chatResponse({ toolCalls: [toolCall('c', 'alpha', {})], stopReason: 'toolUse' }),
      });
    });
    bench.start({ limits: { maxSteps: 3, maxToolCalls: 100, wallClockMs: 100_000 } });

    const outcome = await bench.finished();
    expect(bench.turns.sent).toHaveLength(3);
    expect(bench.events).toContainEqual({
      type: 'degraded',
      degradation: { kind: 'stepLimitReached', steps: 3 },
    });
    // "Hitting one is not a failure: the run finishes, and says it was capped."
    expect(outcome).toEqual({ type: 'completed', stopReason: 'toolUse' });
  });

  it('stops at maxToolCalls, counting across the whole run', async () => {
    const bench = new Bench({
      tools: { execute: (call) => Promise.resolve(result(call.callId, 'ok')) },
    });
    bench.turns.always((request, driver) => {
      driver.emit(request.turnId, {
        type: 'done',
        response: chatResponse({
          toolCalls: [toolCall('c1', 'alpha', {}), toolCall('c2', 'beta', {})],
          stopReason: 'toolUse',
        }),
      });
    });
    bench.start({ limits: { maxSteps: 10, maxToolCalls: 3, wallClockMs: 100_000 } });

    const outcome = await bench.finished();
    const finished = bench.events.filter((event) => event.type === 'toolCallFinished');
    expect(finished).toHaveLength(3);
    expect(bench.events).toContainEqual({
      type: 'degraded',
      degradation: { kind: 'toolCallLimitReached', calls: 3 },
    });
    expect(outcome.type).toBe('completed');
  });

  it('stops on the wall clock, measured on the injected now()', async () => {
    // Conventions §8: the test drives the clock rather than sleeping.
    const bench = new Bench();
    bench.turns.script((request, driver) => {
      bench.clock.ms = 500_000;
      driver.emit(request.turnId, { type: 'textDelta', text: 'still going' });
    });
    bench.start({ limits: { maxSteps: 10, maxToolCalls: 10, wallClockMs: 1_000 } });

    const outcome = await bench.finished();
    expect(bench.events).toContainEqual({
      type: 'degraded',
      degradation: { kind: 'wallClockLimitReached', elapsedMs: 500_000 },
    });
    expect(bench.turns.cancelled).toEqual(['run-1:1']);
    expect(outcome).toEqual({ type: 'completed', stopReason: 'unspecified' });
  });

  it('caps a single-turn harness at one turn whatever the request asks for', async () => {
    // "A single-turn harness is capped at 1 regardless of this." The request
    // below asks for twelve steps and claims multiStep.
    const bench = new Bench({
      tools: { execute: (call) => Promise.resolve(result(call.callId, 'ok')) },
    });
    bench.turns.always((request, driver) => {
      driver.emit(request.turnId, {
        type: 'done',
        response: chatResponse({ toolCalls: [toolCall('c', 'alpha', {})], stopReason: 'toolUse' }),
      });
    });
    bench.start({ harnessId: 'single-turn' });

    await bench.finished();
    expect(bench.turns.sent).toHaveLength(1);
  });
});

describe('tools', () => {
  it('runs one turn’s calls concurrently, and reports them in call order', async () => {
    const inFlight: string[] = [];
    const first = gate();
    const bench = new Bench({
      tools: {
        execute: async (call) => {
          inFlight.push(call.callId);
          if (call.callId === 'c1') await first.wait;
          return result(call.callId, `ran ${call.callId}`);
        },
      },
    });
    bench.turns.script((request, driver) => {
      driver.emit(request.turnId, {
        type: 'done',
        response: chatResponse({
          toolCalls: [toolCall('c1', 'alpha', {}), toolCall('c2', 'beta', {})],
          stopReason: 'toolUse',
        }),
      });
    });
    bench.turns.scriptText('done');
    bench.start();
    await flush();

    // The second tool was dispatched while the first was still blocked. A
    // sequential loop could not have reached it.
    expect(inFlight).toEqual(['c1', 'c2']);
    expect(bench.events.filter((event) => event.type === 'toolCallFinished')).toHaveLength(0);

    first.release();
    await bench.finished();

    const finished = bench.events.filter((event) => event.type === 'toolCallFinished');
    expect(
      finished.map((event) => (event.type === 'toolCallFinished' ? event.result.callId : '')),
    ).toEqual(['c1', 'c2']);
  });

  it('fails the run with toolExecutorFailed when an executor rejects', async () => {
    // "If it rejects anyway, that is a defect in the executor and the harness
    // must fail the run with `toolExecutorFailed` — never invent a result."
    const bench = new Bench({ tools: { execute: () => Promise.reject(new Error('boom')) } });
    bench.turns.script((request, driver) => {
      driver.emit(request.turnId, {
        type: 'done',
        response: chatResponse({ toolCalls: [toolCall('c', 'alpha', {})], stopReason: 'toolUse' }),
      });
    });
    bench.start();

    expect(await bench.finished()).toEqual({
      type: 'failed',
      failure: { kind: 'harness', cause: 'toolExecutorFailed' },
    });
  });

  it('leaves requested calls as evidence when the run may not execute them', async () => {
    // "`false` with a tool-calling model is a real combination — the model's
    // requested calls arrive on the stream as evidence and nothing runs them."
    const bench = new Bench({
      tools: { execute: () => Promise.reject(new Error('must not be called')) },
    });
    bench.turns.script((request, driver) => {
      driver.emit(request.turnId, {
        type: 'done',
        response: chatResponse({ toolCalls: [toolCall('c', 'alpha', {})], stopReason: 'toolUse' }),
      });
    });
    bench.start({ capabilities: { multiStep: true, toolExecution: false, auxiliaryModel: false } });

    const outcome = await bench.finished();
    expect(outcome).toEqual({ type: 'completed', stopReason: 'toolUse' });
    expect(bench.turns.sent).toHaveLength(1);
    expect(bench.events.filter((event) => event.type === 'toolCallStarted')).toHaveLength(0);
  });
});

describe('durability and cancellation', () => {
  it('writes the transcript as the run goes, not at the end', async () => {
    // "a harness must write the transcript as the run goes ... One append with
    // status streaming when a turn opens; one update closing it out."
    const bench = new Bench({
      tools: { execute: (call) => Promise.resolve(result(call.callId, 'ok')) },
    });
    bench.turns.script((request, driver) => {
      driver.emit(request.turnId, {
        type: 'done',
        response: chatResponse({ toolCalls: [toolCall('c', 'alpha', {})], stopReason: 'toolUse' }),
      });
    });
    bench.turns.scriptText('done');
    bench.start();
    await bench.finished();

    expect(bench.transcript.appended.map((entry) => [entry.role, entry.status])).toEqual([
      ['assistant', 'streaming'],
      ['tool', 'complete'],
      ['assistant', 'streaming'],
    ]);
    expect(bench.transcript.updated.map((entry) => entry.status)).toEqual(['complete', 'complete']);

    // Every append carries at least one part. `store_append_message` refuses an
    // empty list, so a row opened with `[]` fails the append and takes the run
    // down before the first token. This double accepts anything, which is why
    // that defect survived here until `adapter-integration.test.ts` ran the same
    // loop over the real store.
    for (const entry of bench.transcript.appended) expect(entry.parts.length).toBeGreaterThan(0);
    for (const entry of bench.transcript.updated) {
      if (entry.parts !== undefined) expect(entry.parts.length).toBeGreaterThan(0);
    }
  });

  it('cancels: the run ends at runFinished and the open turn is closed as cancelled', async () => {
    const bench = new Bench();
    bench.turns.script((request, driver) => {
      driver.emit(request.turnId, { type: 'textDelta', text: 'partial' });
    });
    const handle = bench.start();
    await flush();

    await handle.cancel();
    const outcome = await bench.finished();

    expect(outcome).toEqual({ type: 'cancelled' });
    expect(bench.turns.cancelled).toEqual(['run-1:1']);
    expect(bench.transcript.updated).toEqual([{ messageId: 'msg-0', status: 'cancelled' }]);
  });

  it('cancels twice without a second chat_cancel for a turn that is already over', async () => {
    // "Cancelling twice is legal and does nothing the second time."
    // `live-runs.test.ts` holds the directory half — two cancels reach the
    // controller and neither throws. This is the harness half: the second press
    // must not put a second `chat_cancel` on the wire. The host answers
    // `cancelled: false` for a turn that already ended, which the contract calls
    // a race rather than an error — and in the sandbox-backed executor the
    // contract describes, it is a second cancel aimed at a run somebody else may
    // now own.
    const bench = new Bench();
    bench.turns.script((request, driver) => {
      driver.emit(request.turnId, { type: 'textDelta', text: 'partial' });
    });
    const handle = bench.start();
    await flush();

    // Both presses land while the turn is still open — the second one taken
    // before the loop has had a chance to notice the first, which is the window
    // a real second click falls in.
    await Promise.all([handle.cancel(), handle.cancel()]);
    const outcome = await bench.finished();
    expect(outcome).toEqual({ type: 'cancelled' });
    expect(bench.turns.cancelled, 'one open turn, one cancel').toEqual(['run-1:1']);

    // And a third, after the run is over: legal, and still nothing.
    await handle.cancel();
    expect(bench.turns.cancelled).toEqual(['run-1:1']);
    expect(bench.events.filter((event) => event.type === 'runFinished')).toHaveLength(1);
  });

  it('reports a provider failure as ChatError, unchanged', async () => {
    // "A provider failure travels as ChatError, unchanged — it is the one error
    // taxonomy and re-wrapping it would strip the Diagnosis."
    const bench = new Bench();
    bench.turns.script((request, driver) => {
      driver.emit(request.turnId, {
        type: 'error',
        error: { kind: 'cancelled' },
      });
    });
    bench.start();

    expect(await bench.finished()).toEqual({
      type: 'failed',
      failure: { kind: 'provider', error: { kind: 'cancelled' } },
    });
  });
});

/* -------------------------------------------------------------------------- */

/**
 * One run driven straight against a harness instance, with no directory above
 * it.
 *
 * Every other test in this file goes through `createLiveRuns`, which builds a
 * fresh harness per run — so no test in this repo has ever called `start` twice
 * on one instance, which is exactly the rule below.
 */
function runOn(
  harness: RuntimeHarness,
  request: RunRequest,
): { readonly events: RunEvent[]; readonly done: Promise<RunOutcome>; readonly cancel: () => Promise<void> } {
  const events: RunEvent[] = [];
  let settle: ((outcome: RunOutcome) => void) | null = null;
  let early: RunOutcome | null = null;
  const controller = harness.start(request, (event) => {
    events.push(event);
    if (event.type !== 'runFinished') return;
    if (settle === null) early = event.outcome;
    else settle(event.outcome);
  });
  const done = new Promise<RunOutcome>((resolve) => {
    if (early !== null) {
      resolve(early);
      return;
    }
    settle = resolve;
  });
  return { events, done, cancel: () => controller.cancel() };
}

function sharedServices(turns: FakeTurnDriver, executed: string[]): HarnessServices {
  return {
    turns,
    tools: {
      execute: (call) => {
        executed.push(call.callId);
        return Promise.resolve(result(call.callId, `ran ${call.name}`));
      },
    },
    context: { index: () => Promise.resolve([]), load: () => Promise.resolve(null) },
    transcript: recordingTranscript().writer,
    parts: contentPartCodec,
    now: () => 0,
  };
}

function turnIdsOf(events: readonly RunEvent[]): readonly string[] {
  return events.filter((event) => event.type === 'turnStarted').map((event) => event.turnId);
}

describe('a harness holds no state that outlives one call to start', () => {
  // "An implementation must, **without exception** … hold no state that outlives
  // one call to `start`."
  //
  // Nothing held this. `harness-registry.test.ts` holds the neighbouring rule —
  // `create` is a factory, not a shared instance — and stops there, and the
  // directory happens to call `create` once per run, so a harness that hoisted
  // `messages`, the tool-call counter or the `AbortController` off its run and
  // onto itself passes every test in this repo. It stops passing the day
  // anything memoises a harness the way `harness-runtime.ts` memoises resolvers,
  // and the failure is two conversations sharing one message list: each user
  // gets an answer containing the other's turn.

  /** Every turn asks for one tool and the next one answers. */
  function toolThenAnswer(turns: FakeTurnDriver): void {
    turns.always((request, driver) => {
      if (request.turnId.endsWith(':1')) {
        const callId = `${request.turnId}-call`;
        driver.emit(request.turnId, {
          type: 'done',
          response: chatResponse({
            parts: [{ kind: 'toolCall', callId, name: 'alpha', arguments: {} }],
            toolCalls: [toolCall(callId, 'alpha', {})],
            stopReason: 'toolUse',
          }),
        });
        return;
      }
      driver.emit(request.turnId, {
        type: 'done',
        response: chatResponse({ parts: [{ kind: 'text', text: `answer to ${request.turnId}` }] }),
      });
    });
  }

  /** One tool call each, against a budget of exactly one, so a shared counter shows. */
  const LIMITS = { maxSteps: 4, maxToolCalls: 1, wallClockMs: 100_000 };

  function requestFor(name: 'a' | 'b'): RunRequest {
    return runRequest({
      runId: `run-${name}`,
      conversationId: `c-${name}`,
      input: [{ role: 'user', text: `${name} question` }],
      limits: LIMITS,
    });
  }

  /** The three messages a run of this shape puts on its second turn. */
  function secondTurnOf(name: 'a' | 'b'): readonly ChatMessageInput[] {
    const callId = `run-${name}:1-call`;
    return [
      { role: 'user', text: `${name} question` },
      {
        role: 'assistant',
        text: '',
        parts: [{ kind: 'toolCall', callId, name: 'alpha', arguments: {} }],
      },
      { role: 'tool', text: '', parts: [result(callId, 'ran alpha')] },
    ];
  }

  it('drives two runs at once on one instance without either seeing the other’s messages', async () => {
    const turns = new FakeTurnDriver();
    toolThenAnswer(turns);
    const executed: string[] = [];
    const harness = agentLoopHarness.create(sharedServices(turns, executed));

    const alpha = runOn(harness, requestFor('a'));
    const beta = runOn(harness, requestFor('b'));

    expect(await alpha.done).toEqual({ type: 'completed', stopReason: 'endTurn' });
    expect(await beta.done).toEqual({ type: 'completed', stopReason: 'endTurn' });

    const sent = (turnId: string): readonly ChatMessageInput[] | undefined =>
      turns.sent.find((request) => request.turnId === turnId)?.messages;

    // The second run's first turn carries its own question and nothing else.
    expect(sent('run-b:1'), 'a second run must start from its own input').toEqual([
      { role: 'user', text: 'b question' },
    ]);
    expect(sent('run-a:2')).toEqual(secondTurnOf('a'));
    expect(sent('run-b:2')).toEqual(secondTurnOf('b'));

    // Each run spent its own tool budget, and each emitter saw only its own run.
    expect([...executed].sort()).toEqual(['run-a:1-call', 'run-b:1-call']);
    expect(turnIdsOf(alpha.events)).toEqual(['run-a:1', 'run-a:2']);
    expect(turnIdsOf(beta.events)).toEqual(['run-b:1', 'run-b:2']);
    expect(alpha.events.filter((event) => event.type === 'degraded')).toEqual([]);
    expect(beta.events.filter((event) => event.type === 'degraded')).toEqual([]);
  });

  it('gives a run started after another has finished a fresh budget, not the spent one', async () => {
    // Sequential, and that is the point: the *ceilings* are the state a
    // concurrent pair cannot show has been hoisted, because both runs read the
    // budget before either has spent it. Two messages in the same conversation,
    // one after the other, is what a caller that memoised a harness would do —
    // and a run reading the previous run's counter is capped before it
    // dispatches, so the second question silently gets an answer with no tool
    // call in it and a degradation the first run earned.
    const turns = new FakeTurnDriver();
    toolThenAnswer(turns);
    const executed: string[] = [];
    const harness = agentLoopHarness.create(sharedServices(turns, executed));

    expect(await runOn(harness, requestFor('a')).done).toEqual({
      type: 'completed',
      stopReason: 'endTurn',
    });
    const second = runOn(harness, requestFor('b'));
    expect(await second.done).toEqual({ type: 'completed', stopReason: 'endTurn' });

    expect(executed, 'each run has its own tool budget').toEqual([
      'run-a:1-call',
      'run-b:1-call',
    ]);
    expect(second.events.filter((event) => event.type === 'degraded')).toEqual([]);
    expect(turnIdsOf(second.events)).toEqual(['run-b:1', 'run-b:2']);
    expect(turns.sent.find((request) => request.turnId === 'run-b:2')?.messages).toEqual(
      secondTurnOf('b'),
    );
  });

  it('cancels one run on an instance without cancelling the other', async () => {
    // The `AbortController` half of the same rule, and the one whose cost is
    // worst: a shared controller means the Stop button on one conversation ends
    // the other user's run, and the tool executor's signal aborts work nobody
    // asked to stop.
    // Both runs are mid-turn — nothing is scripted, so neither turn answers —
    // and the second is still open when the first is cancelled. That is the
    // whole of the setup: a shared controller can only show while there is
    // another run left to abort.
    const turns = new FakeTurnDriver();
    const harness = agentLoopHarness.create(sharedServices(turns, []));
    const alpha = runOn(harness, runRequest({ runId: 'run-a', conversationId: 'c-a' }));
    const beta = runOn(harness, runRequest({ runId: 'run-b', conversationId: 'c-b' }));
    await flush();

    await alpha.cancel();
    expect(await alpha.done).toEqual({ type: 'cancelled' });

    // The second run answers afterwards, and is unaffected.
    turns.emit('run-b:1', {
      type: 'done',
      response: chatResponse({ parts: [{ kind: 'text', text: 'beta answer' }] }),
    });
    expect(await beta.done).toEqual({ type: 'completed', stopReason: 'endTurn' });
    expect(turns.cancelled, 'only the cancelled run’s open turn is cancelled').toEqual(['run-a:1']);
  });
});
