/**
 * The rules `contract-harness.ts` states about the run directory, asserted.
 *
 * That file's header says plainly that `pnpm typecheck` holds every shape in it
 * and that this is the whole of the automatic enforcement — no test asserts a
 * single behavioural rule it states. These are the ones this layer owns. Each
 * `it` below names the rule it holds, in the contract's own words where they
 * are short enough to quote.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  RUN_BUFFER_MIN_EVENTS,
  type HarnessServices,
  type RunEventEnvelope,
  type RunDelivery,
  type RunHandle,
  type RunRequest,
} from '@/platform/contract-harness';

import { createHarnessRegistry } from './harness-registry';
import { createLiveRuns } from './live-runs';
import { createManualHarness, inertServices, runRequest } from './run-doubles';

interface Harnessed {
  readonly runs: ReturnType<typeof createLiveRuns>;
  readonly harness: ReturnType<typeof createManualHarness>;
  readonly factory: ReturnType<typeof vi.fn>;
  readonly bundles: HarnessServices[];
}

function setup(): Harnessed {
  const harness = createManualHarness('manual');
  const registry = createHarnessRegistry([harness.definition]);
  const bundles: HarnessServices[] = [];
  const factory = vi.fn((_request: RunRequest) => {
    const bundle = inertServices(() => 1_000 + bundles.length);
    bundles.push(bundle);
    return bundle;
  });
  const runs = createLiveRuns(registry, factory);
  return { runs, harness, factory, bundles };
}

function started(runs: Harnessed['runs'], request: RunRequest): RunHandle {
  const start = runs.start(request);
  if (start.outcome !== 'started') throw new Error(`rejected: ${start.reason}`);
  return start.handle;
}

function collect(): {
  readonly seen: [number, RunDelivery][];
  readonly listener: (envelope: RunEventEnvelope, delivery: RunDelivery) => void;
} {
  const seen: [number, RunDelivery][] = [];
  return {
    seen,
    listener: (envelope, delivery) => {
      seen.push([envelope.seq, delivery]);
    },
  };
}

describe('admission', () => {
  it('builds one services bundle and one harness instance per admitted run', () => {
    // "One services bundle and one harness instance per admitted run, both
    // dropped when the run is." — LiveRuns.start
    const { runs, harness, factory } = setup();
    started(runs, runRequest({ runId: 'a', conversationId: 'c1', harnessId: 'manual' }));
    started(runs, runRequest({ runId: 'b', conversationId: 'c2', harnessId: 'manual' }));

    expect(factory).toHaveBeenCalledTimes(2);
    expect(harness.bundles).toHaveLength(2);
    expect(harness.started).toHaveLength(2);
  });

  it('calls the factory once per run and hands that same bundle to create', () => {
    // "Called once per admitted run ... immediately before
    // HarnessDefinition.create. Not per turn and not per tool call."
    const { runs, harness, factory, bundles } = setup();
    started(runs, runRequest({ runId: 'a', conversationId: 'c1', harnessId: 'manual' }));

    expect(factory).toHaveBeenCalledTimes(1);
    expect(harness.bundles[0]).toBe(bundles[0]);
  });

  it('drives many turns without rebuilding the bundle', () => {
    // The per-turn half of the same rule: an executor rebuilt mid-run would hold
    // a different AbortSignal chain than the one the run started with.
    const { runs, harness, factory } = setup();
    started(runs, runRequest({ runId: 'a', conversationId: 'c1', harnessId: 'manual' }));
    for (let step = 1; step <= 5; step += 1) {
      harness.emitTo('a', { type: 'turnStarted', turnId: `t${step}`, step, model: 'primary' });
    }
    expect(factory).toHaveBeenCalledTimes(1);
    expect(harness.bundles).toHaveLength(1);
  });

  it('a rejected request builds neither a bundle nor a harness', () => {
    const { runs, harness, factory } = setup();
    started(runs, runRequest({ runId: 'a', conversationId: 'c1', harnessId: 'manual' }));
    factory.mockClear();

    expect(runs.start(runRequest({ runId: 'a', conversationId: 'cx', harnessId: 'manual' }))).toEqual(
      { outcome: 'rejected', reason: 'duplicateRunId' },
    );
    expect(runs.start(runRequest({ runId: 'b', conversationId: 'c1', harnessId: 'manual' }))).toEqual(
      { outcome: 'rejected', reason: 'conversationBusy' },
    );
    expect(runs.start(runRequest({ runId: 'c', conversationId: 'c9', harnessId: 'nope' }))).toEqual({
      outcome: 'rejected',
      reason: 'unknownHarnessId',
    });

    expect(factory).not.toHaveBeenCalled();
    expect(harness.bundles).toHaveLength(1);
  });

  it('admits a second run in a conversation once the first has finished', () => {
    // "At most one live run per conversation" is about *live* runs.
    const { runs, harness } = setup();
    started(runs, runRequest({ runId: 'a', conversationId: 'c1', harnessId: 'manual' }));
    harness.emitTo('a', { type: 'runFinished', outcome: { type: 'completed', stopReason: 'endTurn' } });

    const second = runs.start(runRequest({ runId: 'b', conversationId: 'c1', harnessId: 'manual' }));
    expect(second.outcome).toBe('started');
  });

  it('leaves no record behind when a harness throws out of create or start', () => {
    // A `HarnessDefinition` is somebody else's code — `create` is a factory and
    // `start` runs whatever that factory built — so both can throw
    // synchronously. The throw is allowed to escape: a caller that registered a
    // broken definition has a bug in its own wiring.
    //
    // What must not survive it is a record. Inserted before `create`, the run is
    // left `status: running` with no controller and nothing that can clear it —
    // only `runFinished` leaves `running`, and a harness that never started
    // emits nothing — so `liveInConversation` answers `conversationBusy` for
    // that conversation for the rest of the session. Neither harness this build
    // ships can reach it; a third-party one can, and the cost is a conversation
    // the user can never send in again.
    for (const broken of [
      {
        descriptor: {
          id: 'broken',
          displayName: 'Broken',
          capabilities: { multiStep: false, toolExecution: false, auxiliaryModel: false },
          requiresModelCapabilities: [],
        },
        create: () => {
          throw new Error('create exploded');
        },
      },
      {
        descriptor: {
          id: 'broken',
          displayName: 'Broken',
          capabilities: { multiStep: false, toolExecution: false, auxiliaryModel: false },
          requiresModelCapabilities: [],
        },
        create: () => ({
          start: () => {
            throw new Error('start exploded');
          },
        }),
      },
    ] as const) {
      const working = createManualHarness('manual');
      const registry = createHarnessRegistry([broken, working.definition]);
      const runs = createLiveRuns(registry, () => inertServices());

      expect(() =>
        runs.start(runRequest({ runId: 'a', conversationId: 'c1', harnessId: 'broken' })),
      ).toThrow();

      // The conversation is not poisoned, the id is not spent, and the
      // directory never claims a run it does not have.
      expect(runs.list()).toEqual([]);
      expect(runs.get('a')).toBeNull();
      expect(runs.forConversation('c1')).toBeNull();
      const second = runs.start(
        runRequest({ runId: 'a', conversationId: 'c1', harnessId: 'manual' }),
      );
      expect(second.outcome).toBe('started');
    }
  });

  it('runs against different conversations are live at the same time', () => {
    const { runs } = setup();
    started(runs, runRequest({ runId: 'a', conversationId: 'c1', harnessId: 'manual' }));
    started(runs, runRequest({ runId: 'b', conversationId: 'c2', harnessId: 'manual' }));
    started(runs, runRequest({ runId: 'c', conversationId: 'c3', harnessId: 'manual' }));

    const live = runs.list().filter((snapshot) => snapshot.status.type === 'running');
    expect(live.map((snapshot) => snapshot.runId)).toEqual(['a', 'b', 'c']);
  });
});

describe('sequencing', () => {
  it('numbers events densely from zero, so runStarted is seq 0', () => {
    // "Always seq 0, so a late joiner replaying from 0 learns the shape first."
    const { runs, harness } = setup();
    const handle = started(runs, runRequest({ runId: 'a', harnessId: 'manual' }));
    const { seen, listener } = collect();
    handle.subscribe(listener);

    harness.emitTo('a', { type: 'runStarted', capabilities: runRequest().capabilities });
    harness.emitTo('a', { type: 'turnStarted', turnId: 't', step: 1, model: 'primary' });
    harness.emitTo('a', { type: 'chat', turnId: 't', event: { type: 'textDelta', text: 'hi' } });

    expect(seen).toEqual([
      [0, 'live'],
      [1, 'live'],
      [2, 'live'],
    ]);
    expect(handle.snapshot().nextSeq).toBe(3);
  });

  it('numbers nothing after the terminal event', () => {
    // "Exactly one of these is emitted, exactly once, as the last event."
    const { runs, harness } = setup();
    const handle = started(runs, runRequest({ runId: 'a', harnessId: 'manual' }));
    harness.emitTo('a', { type: 'runStarted', capabilities: runRequest().capabilities });
    harness.emitTo('a', { type: 'runFinished', outcome: { type: 'cancelled' } });
    harness.emitTo('a', { type: 'chat', turnId: 't', event: { type: 'textDelta', text: 'late' } });

    expect(handle.snapshot().nextSeq).toBe(2);
    expect(handle.snapshot().status).toEqual({ type: 'cancelled' });
  });

  it('tracks step, degradations and outcome on the snapshot', () => {
    const { runs, harness } = setup();
    const handle = started(runs, runRequest({ runId: 'a', harnessId: 'manual' }));
    expect(handle.snapshot().status).toEqual({ type: 'running', step: 0 });

    harness.emitTo('a', { type: 'turnStarted', turnId: 't', step: 1, model: 'primary' });
    expect(handle.snapshot().status).toEqual({ type: 'running', step: 1 });

    harness.emitTo('a', { type: 'degraded', degradation: { kind: 'stepLimitReached', steps: 1 } });
    expect(handle.snapshot().degradations).toEqual([{ kind: 'stepLimitReached', steps: 1 }]);

    harness.emitTo('a', {
      type: 'runFinished',
      outcome: { type: 'completed', stopReason: 'toolUse' },
    });
    expect(handle.snapshot().status).toEqual({ type: 'completed', stopReason: 'toolUse' });
  });

  it('hands back a degradation list a caller cannot rewrite', () => {
    const { runs, harness } = setup();
    const handle = started(runs, runRequest({ runId: 'a', harnessId: 'manual' }));
    harness.emitTo('a', { type: 'degraded', degradation: { kind: 'toolCallLimitReached', calls: 2 } });

    const snapshot = handle.snapshot();
    (snapshot.degradations as { length: number }).length = 0;
    expect(handle.snapshot().degradations).toHaveLength(1);
  });
});

describe('late join', () => {
  it('replays from a seq and then delivers live, with no gap and no duplicate', () => {
    const { runs, harness } = setup();
    const handle = started(runs, runRequest({ runId: 'a', harnessId: 'manual' }));
    for (let i = 0; i < 5; i += 1) {
      harness.emitTo('a', { type: 'chat', turnId: 't', event: { type: 'textDelta', text: `${i}` } });
    }

    const { seen, listener } = collect();
    const subscription = handle.subscribe(listener, { fromSeq: 2 });
    expect(subscription.replayedFrom).toBe(2);
    expect(subscription.liveFrom).toBe(5);

    harness.emitTo('a', { type: 'chat', turnId: 't', event: { type: 'textDelta', text: '5' } });

    expect(seen).toEqual([
      [2, 'replay'],
      [3, 'replay'],
      [4, 'replay'],
      [5, 'live'],
    ]);
  });

  it('delivers the replay before subscribe returns', () => {
    // "The replay is delivered before `subscribe` returns. It is synchronous
    // against an in-memory buffer" — which is what lets the two numbers on the
    // subscription be honest by the time the caller reads them.
    const { runs, harness } = setup();
    const handle = started(runs, runRequest({ runId: 'a', harnessId: 'manual' }));
    harness.emitTo('a', { type: 'runStarted', capabilities: runRequest().capabilities });

    let seenDuringSubscribe = 0;
    const subscription = handle.subscribe(() => {
      seenDuringSubscribe += 1;
    });
    expect(seenDuringSubscribe).toBe(1);
    expect(subscription.replayedFrom).toBe(0);
  });

  it('replays nothing from a seq past the end, and says so with replayedFrom', () => {
    // "Equal to `nextSeq` when nothing was replayed."
    const { runs, harness } = setup();
    const handle = started(runs, runRequest({ runId: 'a', harnessId: 'manual' }));
    harness.emitTo('a', { type: 'runStarted', capabilities: runRequest().capabilities });

    const { seen, listener } = collect();
    const subscription = handle.subscribe(listener, { fromSeq: 99 });
    expect(seen).toEqual([]);
    expect(subscription.replayedFrom).toBe(1);
    expect(subscription.liveFrom).toBe(1);
  });

  it('gives every subscriber its own replay', () => {
    const { runs, harness } = setup();
    const handle = started(runs, runRequest({ runId: 'a', harnessId: 'manual' }));
    harness.emitTo('a', { type: 'runStarted', capabilities: runRequest().capabilities });

    const first = collect();
    const second = collect();
    handle.subscribe(first.listener);
    handle.subscribe(second.listener);
    expect(first.seen).toEqual([[0, 'replay']]);
    expect(second.seen).toEqual([[0, 'replay']]);
  });

  it('unsubscribes one subscription without touching another that shares a listener', () => {
    const { runs, harness } = setup();
    const handle = started(runs, runRequest({ runId: 'a', harnessId: 'manual' }));
    const { seen, listener } = collect();
    const first = handle.subscribe(listener);
    handle.subscribe(listener);
    first.unsubscribe();

    harness.emitTo('a', { type: 'runStarted', capabilities: runRequest().capabilities });
    expect(seen).toEqual([[0, 'live']]);
  });

  it('retains at least RUN_BUFFER_MIN_EVENTS and reports the truncation', () => {
    // "an implementation retains at least RUN_BUFFER_MIN_EVENTS events and may
    // drop older ones, oldest first. `retainedFrom` is what it actually still
    // holds, and a late joiner learns from `replayedFrom` that it lost some."
    const { runs, harness } = setup();
    const handle = started(runs, runRequest({ runId: 'a', harnessId: 'manual' }));
    const total = RUN_BUFFER_MIN_EVENTS * 2 + 1000;
    for (let i = 0; i < total; i += 1) {
      harness.emitTo('a', { type: 'chat', turnId: 't', event: { type: 'textDelta', text: 'x' } });
    }

    const snapshot = handle.snapshot();
    expect(snapshot.nextSeq).toBe(total);
    expect(snapshot.retainedFrom).toBeGreaterThan(0);
    expect(snapshot.nextSeq - snapshot.retainedFrom).toBeGreaterThanOrEqual(RUN_BUFFER_MIN_EVENTS);

    const subscription = handle.subscribe(() => undefined, { fromSeq: 0 });
    expect(subscription.replayedFrom).toBe(snapshot.retainedFrom);
    expect(subscription.replayedFrom).toBeGreaterThan(0);
  });
});

describe('lookup and cancel', () => {
  it('answers forConversation with the live run, and afterwards with the finished one', () => {
    const { runs, harness } = setup();
    started(runs, runRequest({ runId: 'a', conversationId: 'c1', harnessId: 'manual' }));
    expect(runs.forConversation('c1')?.runId).toBe('a');
    expect(runs.forConversation('c-none')).toBeNull();

    harness.emitTo('a', {
      type: 'runFinished',
      outcome: { type: 'completed', stopReason: 'endTurn' },
    });
    expect(runs.forConversation('c1')?.runId).toBe('a');
    expect(runs.forConversation('c1')?.snapshot().status.type).toBe('completed');
  });

  it('answers get with the handle, and null for a run it never held', () => {
    const { runs } = setup();
    started(runs, runRequest({ runId: 'a', harnessId: 'manual' }));
    expect(runs.get('a')?.runId).toBe('a');
    expect(runs.get('b')).toBeNull();
  });

  it('reaches the harness controller on cancel, and cancelling twice is legal', async () => {
    const { runs, harness } = setup();
    const handle = started(runs, runRequest({ runId: 'a', harnessId: 'manual' }));
    await handle.cancel();
    await handle.cancel();
    expect(harness.cancelled).toEqual(['a', 'a']);
  });
});
