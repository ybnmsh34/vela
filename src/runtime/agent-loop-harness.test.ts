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

import type { ChatMessageInput, ContentPart } from '@/platform/contract';
import type {
  ContextChunk,
  ContextRef,
  ExecutableToolCall,
  LiveRuns,
  RunEvent,
  RunHandle,
  RunOutcome,
  RunRequest,
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
