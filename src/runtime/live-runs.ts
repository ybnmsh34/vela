/**
 * The live-run directory — the implementation of `LiveRuns` and `RunHandle`.
 *
 * `src/platform/contract-harness.ts` splits the runtime in two: a
 * `RuntimeHarness` with one method, and this layer, which owns sequencing,
 * buffering, lookup and fan-out **so that no harness has to**. That split is the
 * whole reason replay is a property of the seam rather than a promise each
 * implementation makes separately, and it is why nothing below ever asks a
 * harness what number an event should carry.
 *
 * ## What this file enforces that the contract could only state
 *
 * The contract names several rules with, in its own words, nothing behind them.
 * These are the ones that live here, and each is held by a test in
 * `src/runtime/live-runs.test.ts`:
 *
 *  - **One services bundle and one harness instance per admitted run.** The
 *    factory is called once, then `create` once, then `start` once. A rejected
 *    request builds neither — which is why every rejection is decided before
 *    the first call in `admit` below.
 *  - **`seq` is dense and 0-based and assigned here.** `runStarted` is therefore
 *    always seq 0, because it is the first event a conforming harness emits.
 *  - **Replay then live, with no gap and no duplicate.** `subscribe` replays
 *    synchronously against the buffer and only then registers the listener, so
 *    there is no window in which an event could be both replayed and delivered
 *    live, and none in which it could be neither.
 *  - **At most one live run per conversation**, which is what makes
 *    `forConversation` answerable at all.
 *
 * ## Why the buffer is bounded, and what a caller learns when it bites
 *
 * `RUN_BUFFER_MIN_EVENTS` is a floor, not a size: an implementation retains at
 * least that many and may drop older ones, oldest first. This one retains
 * between one and two times the floor — it appends, and compacts back to the
 * floor once the array has grown to twice it, so the amortised cost of an event
 * is a push rather than a shift of a four-thousand-element array. A ten-minute
 * runaway loop therefore costs a bounded amount of renderer memory, and a late
 * joiner that asked for more than is left learns it from `replayedFrom` coming
 * back higher than the `fromSeq` it asked for.
 *
 * ## What this file does not do
 *
 * **It does not drop finished runs.** `LiveRuns.get` is documented to answer
 * `null` "once a finished run has been dropped"; dropping is permitted, not
 * required, and a directory that never drops is conforming. Nothing here evicts,
 * so a finished run stays addressable — which is what lets a conversation view
 * mounted after a run ended still replay it. The directory dies with the
 * renderer process either way; see `RunHandle` in the contract for why that is a
 * rule rather than a caveat.
 */

import {
  RUN_BUFFER_MIN_EVENTS,
  type CreateLiveRuns,
  type LiveRuns,
  type RunController,
  type RunDegradation,
  type RunDelivery,
  type RunEmit,
  type RunEvent,
  type RunEventEnvelope,
  type RunHandle,
  type RunId,
  type RunListener,
  type RunRequest,
  type RunSnapshot,
  type RunStart,
  type RunStatus,
  type RunSubscription,
  type SubscribeOptions,
} from '@/platform/contract-harness';

/**
 * A subscription's identity.
 *
 * A `Set<RunListener>` would collapse two subscriptions that passed the same
 * function, so unsubscribing one would silently unsubscribe the other. Two
 * panes watching one run with the same handler is ordinary, so the identity has
 * to be the subscription rather than the callback.
 */
interface Subscriber {
  readonly listener: RunListener;
}

interface RunRecord {
  readonly request: RunRequest;
  /** Oldest retained first. `retainedFrom` is derived: `nextSeq - buffer.length`. */
  readonly buffer: RunEventEnvelope[];
  readonly subscribers: Set<Subscriber>;
  readonly degradations: RunDegradation[];
  readonly startedAtMs: number;
  nextSeq: number;
  status: RunStatus;
  /** Set by `runFinished`. Nothing is numbered after it — see `emitInto`. */
  terminal: boolean;
  /**
   * `null` only inside the synchronous window between the record being created
   * and `RuntimeHarness.start` returning — a window nothing can reach into as
   * `start` below is now ordered, because no handle for this record exists until
   * `start` has returned. It stays nullable because it has to: `emit` closes over
   * the record, `start` takes `emit`, and the controller is what `start`
   * returns, so there is no order in which the field is populated at
   * construction.
   *
   * `pendingCancel` is what makes a cancel taken in that window take effect
   * rather than vanish. It is the answer if the window ever reopens — a harness
   * that emitted `runStarted` synchronously to a listener that cancelled would
   * land in it — and it is deliberately kept rather than deleted along with the
   * ordering that made it live, because the alternative is a silent no-op.
   */
  controller: RunController | null;
  pendingCancel: boolean;
}

function retainedFrom(record: RunRecord): number {
  return record.nextSeq - record.buffer.length;
}

function snapshotOf(record: RunRecord): RunSnapshot {
  return {
    runId: record.request.runId,
    conversationId: record.request.conversationId,
    status: record.status,
    capabilities: record.request.capabilities,
    nextSeq: record.nextSeq,
    retainedFrom: retainedFrom(record),
    startedAtMs: record.startedAtMs,
    // Copied: a snapshot a caller could mutate is a directory a caller could
    // rewrite the history of.
    degradations: record.degradations.slice(),
  };
}

/**
 * The status a run is in after `event`.
 *
 * `turnStarted` is the only event that moves `step`, and `runFinished` is the
 * only one that leaves `running`. Nothing else changes the answer, which is why
 * this is a fold over the stream rather than a field a harness sets.
 */
function advance(status: RunStatus, event: RunEvent): RunStatus {
  switch (event.type) {
    case 'turnStarted':
      return { type: 'running', step: event.step };
    case 'runFinished':
      return event.outcome;
    default:
      return status;
  }
}

function emitInto(record: RunRecord, event: RunEvent): void {
  // A conforming harness emits exactly one terminal event and stops. One that
  // does not is a defect, and the choice here is to drop rather than to number:
  // a late joiner that has already been told the run finished must not be able
  // to receive a seq after the one that said so, or `replayedFrom`/`liveFrom`
  // stop describing the same stream for two subscribers.
  if (record.terminal) return;

  const envelope: RunEventEnvelope = {
    runId: record.request.runId,
    seq: record.nextSeq,
    event,
  };
  record.nextSeq += 1;
  record.buffer.push(envelope);
  if (record.buffer.length > RUN_BUFFER_MIN_EVENTS * 2) {
    record.buffer.splice(0, record.buffer.length - RUN_BUFFER_MIN_EVENTS);
  }

  if (event.type === 'degraded') record.degradations.push(event.degradation);
  record.status = advance(record.status, event);
  if (event.type === 'runFinished') record.terminal = true;

  // A copy: a listener that unsubscribes itself, or that subscribes another,
  // must not mutate the set being iterated.
  for (const subscriber of [...record.subscribers]) {
    subscriber.listener(envelope, 'live' satisfies RunDelivery);
  }
}

function handleFor(record: RunRecord): RunHandle {
  return {
    runId: record.request.runId,
    snapshot: () => snapshotOf(record),
    subscribe: (listener: RunListener, options?: SubscribeOptions): RunSubscription => {
      const asked = options?.fromSeq ?? retainedFrom(record);
      const from = Math.max(asked, retainedFrom(record));
      const replayed = record.buffer.filter((envelope) => envelope.seq >= from);

      // Replay happens before the listener is registered, and both are
      // synchronous. That ordering is the no-gap-no-duplicate guarantee: no
      // event can be emitted between the last replayed one and the first live
      // one, because nothing runs in between.
      for (const envelope of replayed) listener(envelope, 'replay' satisfies RunDelivery);

      const first = replayed[0];
      const subscriber: Subscriber = { listener };
      record.subscribers.add(subscriber);
      return {
        replayedFrom: first === undefined ? record.nextSeq : first.seq,
        liveFrom: record.nextSeq,
        unsubscribe: () => {
          record.subscribers.delete(subscriber);
        },
      };
    },
    cancel: async () => {
      const controller = record.controller;
      if (controller === null) {
        record.pendingCancel = true;
        return;
      }
      await controller.cancel();
    },
  };
}

/**
 * Build the directory. See `CreateLiveRuns` for why the second argument is a
 * factory rather than a bundle — it is the type that makes "services are per
 * run" a thing the compiler holds instead of a thing a builder remembers.
 */
export const createLiveRuns: CreateLiveRuns = (registry, services): LiveRuns => {
  const records = new Map<RunId, RunRecord>();
  const handles = new Map<RunId, RunHandle>();

  function liveInConversation(conversationId: string): RunRecord | null {
    for (const record of records.values()) {
      if (record.request.conversationId !== conversationId) continue;
      if (record.status.type === 'running') return record;
    }
    return null;
  }

  return {
    start(request: RunRequest): RunStart {
      // Every rejection is decided here, before anything is built. "A rejected
      // request builds neither" is not a comment about intent: the factory call
      // is below all three checks and there is no path around it.
      if (records.has(request.runId)) {
        return { outcome: 'rejected', reason: 'duplicateRunId' };
      }
      if (liveInConversation(request.conversationId) !== null) {
        return { outcome: 'rejected', reason: 'conversationBusy' };
      }
      const definition = registry.find(request.harnessId);
      if (definition === null) {
        return { outcome: 'rejected', reason: 'unknownHarnessId' };
      }

      const bundle = services(request);
      const record: RunRecord = {
        request,
        buffer: [],
        subscribers: new Set<Subscriber>(),
        degradations: [],
        // The directory has no clock of its own — `CreateLiveRuns` takes a
        // registry and a factory, and nothing else. The run's own injected clock
        // is the right one anyway: a second clock would be a second answer to
        // what time the run started.
        startedAtMs: bundle.now(),
        nextSeq: 0,
        status: { type: 'running', step: 0 },
        terminal: false,
        controller: null,
        pendingCancel: false,
      };
      const emit: RunEmit = (event) => {
        emitInto(record, event);
      };

      // **Built before it is published, and that ordering is the whole of it.**
      // `create` and `start` belong to the harness, not to this file: a third
      // party's implementation may throw synchronously, and the throw is left to
      // escape — a caller that handed in a broken definition has a bug in its own
      // wiring, and swallowing it would start a run that never runs.
      //
      // What must not survive that throw is a record. Inserted first — as this
      // did — the run is left in the directory with `status: running` and no
      // controller, nothing clears it because only `runFinished` leaves
      // `running`, and `liveInConversation` then answers `conversationBusy` for
      // that conversation for the rest of the session. The two harnesses this
      // build ships cannot reach it; a third one can, and the cost of being
      // wrong is a conversation the user can never send in again.
      const harness = definition.create(bundle);
      const controller = harness.start(request, emit);

      records.set(request.runId, record);
      const handle = handleFor(record);
      handles.set(request.runId, handle);
      record.controller = controller;
      if (record.pendingCancel) void controller.cancel();

      return { outcome: 'started', handle };
    },

    get: (runId: RunId): RunHandle | null => handles.get(runId) ?? null,

    /**
     * The live run for this conversation if there is one, and otherwise the most
     * recently started run still held for it.
     *
     * The contract calls this "the in-flight check a conversation view makes on
     * mount, before subscribing", and the live case is the one it names. The
     * fallback is the same question one moment later: a view that mounts just
     * after a run ended wants the handle it would have got a second earlier, so
     * it can replay what happened rather than showing nothing. Callers read
     * `snapshot().status` to tell the two apart, which they must do regardless —
     * a run can finish between the check and the subscribe.
     */
    forConversation: (conversationId: string): RunHandle | null => {
      const live = liveInConversation(conversationId);
      if (live !== null) return handles.get(live.request.runId) ?? null;
      let latest: RunRecord | null = null;
      for (const record of records.values()) {
        if (record.request.conversationId === conversationId) latest = record;
      }
      return latest === null ? null : (handles.get(latest.request.runId) ?? null);
    },

    list: (): readonly RunSnapshot[] => [...records.values()].map(snapshotOf),
  };
};
