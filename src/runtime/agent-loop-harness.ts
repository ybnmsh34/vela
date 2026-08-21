/**
 * The agent loop — one `RuntimeHarness`, and the accumulation rule made real.
 *
 * `src/platform/contract.ts` describes one model turn. This is the loop around
 * it: send, stream, execute what the model asked for, feed the results back,
 * send again, stop at a ceiling and say which one it hit. Every rule below is
 * the contract's; what is added here is the decision of *when* each check
 * happens, and those are called out where they are made.
 *
 * ## The accumulation rule, which is the whole reason this file exists
 *
 * `contract-harness.ts` states four rules for building turn N+1's `messages`
 * and says they are not per-harness policy — two harnesses that accumulate
 * differently produce two transcripts that cannot be swapped between engines.
 * They are implemented once, across `accumulateAssistant` and `runTools`:
 *
 *  1. the assistant's own turn is always appended, `parts` from
 *     `ContentPartCodec.turnToInput`, so the tool results have calls to answer;
 *  2. reasoning parts travel verbatim, signature included, because the codec
 *     copies them and nothing here filters — the projection that drops
 *     reasoning belongs to the rebuild-from-store path, not the live loop;
 *  3. one message per tool result, `role: 'tool'`, one part, in call order;
 *  4. nothing else is inserted — no synthetic continue turn, no per-step system
 *     message. The system message is composed once, before turn 1.
 *
 * `src/runtime/agent-loop-harness.test.ts` asserts all four against a fake
 * `TurnDriver`, and that is the test to break first if this file is edited.
 *
 * ## Where each limit is checked, stated because "enforced" is a claim
 *
 *  - `maxSteps` at the turn boundary, before a turn opens.
 *  - `maxToolCalls` across the whole run, before a turn's calls are dispatched;
 *    a turn that asks for more than the budget leaves gets the prefix that fits
 *    and the run ends capped.
 *  - `wallClockMs` against the injected `now()`, checked at the turn boundary
 *    **and after every streamed event**, so a long answer is cut off rather than
 *    only noticed once it ends. It is not a timer: nothing here fires on its
 *    own, so a turn that streams nothing at all and never terminates is ended by
 *    cancellation, not by this. Conventions §8 wants a test that drives the
 *    clock rather than sleeping, and a `setTimeout` would defeat that.
 *
 * ## Tool calls in one turn run concurrently
 *
 * They are dispatched together and awaited together, so two tools — two
 * subagent runs, in the wiring this repo ships — are genuinely in flight at the
 * same time. What is *not* concurrent is the event stream: `toolCallStarted` is
 * emitted for every admitted call in call order before any of them is
 * dispatched, and `toolCallFinished` in the same order once all have settled.
 * A stream ordered by completion would make replay depend on scheduling, and
 * two subscribers of one run would then see different orders.
 */

import type {
  AnswerProvenance,
  ChatError,
  ChatMessageInput,
  ChatResponseBody,
  ChatStreamEvent,
  ContentPartInput,
  StoredStopReason,
} from '@/platform/contract';
import type { Unsubscribe } from '@/platform/adapter';
import type {
  ContextChunk,
  ExecutableToolCall,
  HarnessDefinition,
  HarnessServices,
  ModelTarget,
  RunController,
  RunEmit,
  RunEvent,
  RunOutcome,
  RunRequest,
  RuntimeHarness,
} from '@/platform/contract-harness';

/* -------------------------------------------------------------------------- */

/**
 * The events of one turn, in arrival order, awaitable one at a time.
 *
 * A queue rather than a callback because `TurnDriver.listen` delivers every
 * turn's events and can deliver them *before* `send` resolves — `contract.ts`
 * records why that is not a bug to design around but a fact to buffer for. One
 * waiter at a time is all the loop needs, and more than one would mean two
 * places reading the same turn.
 */
class TurnQueue {
  private readonly pending: ChatStreamEvent[] = [];
  private waiting: ((event: ChatStreamEvent) => void) | null = null;

  push(event: ChatStreamEvent): void {
    const waiter = this.waiting;
    if (waiter !== null) {
      this.waiting = null;
      waiter(event);
      return;
    }
    this.pending.push(event);
  }

  next(): Promise<ChatStreamEvent> {
    const head = this.pending.shift();
    if (head !== undefined) return Promise.resolve(head);
    return new Promise<ChatStreamEvent>((resolve) => {
      this.waiting = resolve;
    });
  }
}

type TurnResult =
  | { readonly type: 'done'; readonly response: ChatResponseBody }
  | { readonly type: 'error'; readonly error: ChatError }
  | { readonly type: 'cancelled' }
  | { readonly type: 'wallClock'; readonly elapsedMs: number };

/**
 * What a turn's row holds before the turn has said anything.
 *
 * `ChatMessageInput` documents a message with no text and no parts as being one
 * empty text part; the store's append refuses `[]` outright. Both point the same
 * way, so this is the vocabulary's own answer rather than a placeholder invented
 * here.
 */
const EMPTY_TURN_PARTS: readonly ContentPartInput[] = [{ kind: 'text', text: '' }];

/** `StopReason` and `StoredStopReason` have the same members, deliberately. */
function storedStopReason(response: ChatResponseBody): StoredStopReason {
  return response.stopReason;
}

/**
 * The attribution as `store_update_message` takes it: the whole
 * {@link AnswerProvenance}, or nothing at all.
 *
 * One field, because an update is a **merge**. A half sent on its own would not
 * be discarded downstream — it would join whatever the row already recorded and
 * produce a provider/model pair no endpoint ever returned, which `answeredByOf`
 * in `stored-entries.ts` accepts as a genuine record — its whole test is that
 * both columns are non-null — and which the transcript then discloses as a
 * substitution whenever the invented provider differs from the one the user
 * picked. That is worse than the silence this change exists to end, so the halves
 * do not travel separately anywhere on this path:
 * `StoreUpdateMessageReq.answeredBy` is one object, `AnsweredByDto` has no
 * optional half for `serde` to default, `vela_store::AnsweredBy` has no
 * one-field constructor, and `MessagePatch::validate` refuses a pair with a
 * blank half. This function is the near end of that chain, not its guarantee.
 *
 * Spread-or-nothing rather than `answeredBy: … ?? undefined`: this file compiles
 * under `tsconfig.app.json`, which sets `exactOptionalPropertyTypes`, and an
 * explicit `undefined` is not the same as an absent key on a payload that
 * crosses a serde boundary.
 */
function answeredByFields(
  response: ChatResponseBody,
): { readonly answeredBy: AnswerProvenance } | Record<string, never> {
  const answeredBy = response.answeredBy;
  if (answeredBy === null) return {};
  return { answeredBy };
}

/* -------------------------------------------------------------------------- */

/** One call to `start`. Every piece of run state lives here and nowhere else. */
class AgentRun {
  private readonly abort = new AbortController();
  private readonly cancelledSignal: Promise<'cancelled'>;
  private readonly queues = new Map<string, TurnQueue>();
  private readonly messages: ChatMessageInput[];
  private readonly startedAtMs: number;
  private unsubscribe: Unsubscribe | null = null;
  private openTurnId: string | null = null;
  private toolCallsUsed = 0;
  private finished = false;

  constructor(
    private readonly services: HarnessServices,
    private readonly request: RunRequest,
    private readonly emit: RunEmit,
    private readonly stepCeiling: number | null,
  ) {
    this.messages = [...request.input];
    this.startedAtMs = services.now();
    this.cancelledSignal = new Promise<'cancelled'>((resolve) => {
      this.abort.signal.addEventListener('abort', () => resolve('cancelled'), { once: true });
    });
  }

  controller(): RunController {
    return {
      cancel: async () => {
        if (this.finished || this.abort.signal.aborted) return;
        this.abort.abort();
        const turnId = this.openTurnId;
        if (turnId === null) return;
        // A turn that had already finished answers `cancelled: false`, which the
        // contract calls a race rather than an error. Nothing here reads it.
        await this.services.turns.cancel({ turnId }).catch(() => undefined);
      },
    };
  }

  async drive(): Promise<void> {
    try {
      this.unsubscribe = await this.services.turns.listen((envelope) => {
        this.queues.get(envelope.turnId)?.push(envelope.event);
      });
      await this.loop();
    } catch {
      // The harness itself threw. Reported rather than swallowed — including a
      // `TranscriptWriter` rejection, which has no arm of its own in
      // `RunFailureCause` and is a fault in this loop's ability to keep the
      // durability rule.
      this.finish({ type: 'failed', failure: { kind: 'harness', cause: 'harnessFault' } });
    } finally {
      this.unsubscribe?.();
    }
  }

  /* -- the loop ---------------------------------------------------------- */

  private async loop(): Promise<void> {
    if (!(await this.preload())) return;

    const maxSteps = this.stepBudget();
    let lastResponse: ChatResponseBody | null = null;

    for (let step = 1; step <= maxSteps; step += 1) {
      const elapsed = this.services.now() - this.startedAtMs;
      if (elapsed >= this.request.limits.wallClockMs) {
        this.emit({ type: 'degraded', degradation: { kind: 'wallClockLimitReached', elapsedMs: elapsed } });
        this.finishCompleted(lastResponse);
        return;
      }

      const result = await this.runTurn(step);
      if (result.type === 'cancelled') {
        this.finish({ type: 'cancelled' });
        return;
      }
      if (result.type === 'error') {
        this.finish({ type: 'failed', failure: { kind: 'provider', error: result.error } });
        return;
      }
      if (result.type === 'wallClock') {
        this.emit({
          type: 'degraded',
          degradation: { kind: 'wallClockLimitReached', elapsedMs: result.elapsedMs },
        });
        this.finishCompleted(lastResponse);
        return;
      }

      lastResponse = result.response;
      this.accumulateAssistant(result.response);

      const calls = executableCalls(result.response);
      // A model that asked for nothing, or a run that may not execute what it
      // asked for: either way the run is over and the calls stand as evidence on
      // the stream. `toolExecution` false with a tool-calling model is a real
      // combination the contract names, not a misconfiguration.
      if (calls.length === 0 || !this.request.capabilities.toolExecution) {
        this.finishCompleted(lastResponse);
        return;
      }

      const budget = this.request.limits.maxToolCalls - this.toolCallsUsed;
      const admitted = calls.slice(0, Math.max(0, budget));
      const capped = admitted.length < calls.length;

      if (admitted.length > 0) {
        const outcome = await this.runTools(admitted);
        if (outcome === 'cancelled') {
          this.finish({ type: 'cancelled' });
          return;
        }
        if (outcome === 'failed') {
          this.finish({
            type: 'failed',
            failure: { kind: 'harness', cause: 'toolExecutorFailed' },
          });
          return;
        }
      }

      if (capped) {
        this.emit({
          type: 'degraded',
          degradation: { kind: 'toolCallLimitReached', calls: this.toolCallsUsed },
        });
        this.finishCompleted(lastResponse);
        return;
      }

      if (step === maxSteps) {
        this.emit({ type: 'degraded', degradation: { kind: 'stepLimitReached', steps: step } });
        this.finishCompleted(lastResponse);
        return;
      }
    }

    // Reached only when the budget was zero to begin with.
    this.emit({ type: 'degraded', degradation: { kind: 'stepLimitReached', steps: 0 } });
    this.finishCompleted(lastResponse);
  }

  /**
   * The harness's own ceiling wins over the request's.
   *
   * `RunLimits.maxSteps` says "a single-turn harness is capped at 1 regardless
   * of this", and `RunCapabilities.multiStep` is the harness's flag with the
   * model having no say in it. Both are floors on how far this can be talked
   * upward by a caller that computed capabilities wrongly.
   */
  private stepBudget(): number {
    const requested = this.request.limits.maxSteps;
    const ceiling = this.stepCeiling === null ? requested : Math.min(this.stepCeiling, requested);
    return this.request.capabilities.multiStep ? ceiling : Math.min(1, ceiling);
  }

  /* -- context ----------------------------------------------------------- */

  /** `false` when the run was failed and the caller must stop. */
  private async preload(): Promise<boolean> {
    const loaded: ContextChunk[] = [];
    for (const ref of this.request.context.preload) {
      let chunk: ContextChunk | null;
      try {
        chunk = await this.services.context.load(ref);
      } catch {
        this.finish({
          type: 'failed',
          failure: { kind: 'harness', cause: 'contextResolverFailed' },
        });
        return false;
      }
      if (chunk === null) {
        // Material named by the caller that was gone by the time the run
        // reached it. The run continues without it and says so — a run that
        // quietly ran with less than it was asked to is the silent reduction
        // conventions §9 forbids.
        this.emit({ type: 'degraded', degradation: { kind: 'contextUnavailable', ref } });
        continue;
      }
      this.emit({ type: 'contextLoaded', ref });
      loaded.push(chunk);
    }

    const system = composeSystemMessage(this.request.context.systemPrompt, loaded);
    if (system !== null) this.messages.unshift(system);
    return true;
  }

  /* -- one turn ---------------------------------------------------------- */

  private async runTurn(step: number): Promise<TurnResult> {
    const target: ModelTarget = this.request.models.primary;
    const turnId = `${this.request.runId}:${step}`;
    const queue = new TurnQueue();
    this.queues.set(turnId, queue);
    this.openTurnId = turnId;

    this.emit({ type: 'turnStarted', turnId, step, model: 'primary' });

    // One `append` with status `streaming` when a turn opens, one `update`
    // closing it out when it ends — on every one of the four paths below. A run
    // killed mid-turn leaves the row marked `streaming`, which is the state
    // `StoredMessageStatus` has for exactly that.
    const opened = await this.services.transcript.append({
      conversationId: this.request.conversationId,
      role: 'assistant',
      // **One empty text part, not an empty list.** `store_append_message`
      // refuses a message with no parts, in the host and in the browser fake
      // alike, so a row opened with `[]` fails the append and takes the whole
      // run down as a `harnessFault` before the first token. An earlier draft
      // did exactly that and every test in this directory passed, because they
      // all use a transcript double that accepts anything —
      // `adapter-integration.test.ts` is what found it. The empty text part is
      // also what `ChatMessageInput` documents a message with no content to be,
      // so the placeholder is in the vocabulary rather than beside it.
      parts: EMPTY_TURN_PARTS,
      status: 'streaming',
      providerId: target.providerId,
      modelId: target.modelId,
    });

    await this.services.turns.send({
      turnId,
      providerId: target.providerId,
      modelId: target.modelId,
      messages: [...this.messages],
      ...(this.request.tools === undefined ? {} : { tools: this.request.tools }),
      ...(this.request.toolChoice === undefined ? {} : { toolChoice: this.request.toolChoice }),
    });

    const result = await this.consumeTurn(turnId, queue);
    this.queues.delete(turnId);

    switch (result.type) {
      case 'done': {
        // Same rule on the way out: `store_update_message` refuses an empty
        // part list too, so a turn that produced nothing keeps the placeholder
        // the append wrote rather than trying to erase it. An omitted field
        // means "leave it alone", which is exactly the intent here.
        const written = this.services.parts.turnToInput(result.response);
        await this.services.transcript.update({
          messageId: opened.id,
          ...(written.length === 0 ? {} : { parts: written }),
          status: 'complete',
          usage: result.response.usage,
          stopReason: storedStopReason(result.response),
          // **The append above could not carry this and this is the only place
          // that can.** The row is opened before the turn is sent, when the
          // only endpoint anyone knows about is `target` — the one the turn is
          // addressed to. Who answered arrives with `done`, on
          // `ChatResponseBody.answeredBy`, and until this spread existed the
          // fact was in hand at this line and dropped: every row an agent run
          // left behind reloaded as unattributed, so the substitution notice a
          // live run had shown vanished when the conversation was reopened.
          //
          // Spread rather than `?? null`, and never from `target`: an
          // unattributed turn must stay unattributed. A host too old to say
          // who answered, and a host that failed over silently, are different
          // facts, and back-filling the selection makes them look the same.
          ...answeredByFields(result.response),
        });
        break;
      }
      case 'cancelled':
        await this.services.transcript.update({ messageId: opened.id, status: 'cancelled' });
        break;
      case 'wallClock':
        await this.services.transcript.update({ messageId: opened.id, status: 'cancelled' });
        break;
      case 'error':
        await this.services.transcript.update({ messageId: opened.id, status: 'failed' });
        break;
    }
    this.openTurnId = null;
    return result;
  }

  private async consumeTurn(turnId: string, queue: TurnQueue): Promise<TurnResult> {
    for (;;) {
      const next = await Promise.race([
        queue.next().then((event) => ({ type: 'event', event }) as const),
        this.cancelledSignal.then(() => ({ type: 'cancelled' }) as const),
      ]);
      if (next.type === 'cancelled') return { type: 'cancelled' };

      // `chat` carries the six events verbatim. This is not a second streaming
      // vocabulary and must never become one.
      this.emit({ type: 'chat', turnId, event: next.event });

      if (next.event.type === 'done') return { type: 'done', response: next.event.response };
      if (next.event.type === 'error') return { type: 'error', error: next.event.error };

      const elapsed = this.services.now() - this.startedAtMs;
      if (elapsed >= this.request.limits.wallClockMs) {
        await this.services.turns.cancel({ turnId }).catch(() => undefined);
        return { type: 'wallClock', elapsedMs: elapsed };
      }
    }
  }

  /* -- tools ------------------------------------------------------------- */

  private async runTools(calls: readonly ExecutableToolCall[]): Promise<'ok' | 'failed' | 'cancelled'> {
    for (const call of calls) this.emit({ type: 'toolCallStarted', call });

    // Dispatched together: this is the concurrency, and it is real. The results
    // are read back in call order so the stream and the transcript do not depend
    // on which tool happened to finish first.
    const settled = await Promise.allSettled(
      calls.map((call) => this.services.tools.execute(call, this.abort.signal)),
    );
    this.toolCallsUsed += calls.length;

    if (settled.some((outcome) => outcome.status === 'rejected')) {
      // A tool that *failed* is a result with `isError: true`. A rejection is a
      // defect in the executor, and the contract is explicit: fail the run,
      // never invent a result and never continue as though the tool returned
      // nothing.
      return 'failed';
    }
    if (this.abort.signal.aborted) return 'cancelled';

    for (const outcome of settled) {
      if (outcome.status !== 'fulfilled') continue;
      const result = outcome.value;
      this.emit({ type: 'toolCallFinished', result });
      this.messages.push({ role: 'tool', text: '', parts: [result] });
      await this.services.transcript.append({
        conversationId: this.request.conversationId,
        role: 'tool',
        parts: [result],
        status: 'complete',
      });
    }
    return 'ok';
  }

  /* -- accumulation ------------------------------------------------------ */

  private accumulateAssistant(response: ChatResponseBody): void {
    const parts: readonly ContentPartInput[] = this.services.parts.turnToInput(response);
    this.messages.push({ role: 'assistant', text: '', parts });
  }

  /* -- terminal ---------------------------------------------------------- */

  private finishCompleted(response: ChatResponseBody | null): void {
    this.finish({
      type: 'completed',
      // No turn ran at all — a zero step budget, or a wall clock already spent.
      // `unspecified` is the honest answer; inventing `endTurn` would claim the
      // model said something.
      stopReason: response === null ? 'unspecified' : response.stopReason,
    });
  }

  private finish(outcome: RunOutcome): void {
    if (this.finished) return;
    this.finished = true;
    const event: RunEvent = { type: 'runFinished', outcome };
    this.emit(event);
  }
}

/* -------------------------------------------------------------------------- */

function executableCalls(response: ChatResponseBody): readonly ExecutableToolCall[] {
  const calls: ExecutableToolCall[] = [];
  for (const outcome of response.toolCalls) {
    // `malformed` cannot reach an executor by construction — the type says so,
    // and this is where the type is honoured rather than asserted around.
    if (outcome.status === 'ok') calls.push(outcome);
  }
  return calls;
}

/**
 * The one system message, composed before turn 1 and never again.
 *
 * `RunContextRequest.systemPrompt` is the caller's own composition and a harness
 * may add to it but not replace it — the user's instructions came through it —
 * so the prompt leads and the loaded material follows.
 */
function composeSystemMessage(
  systemPrompt: string | null,
  loaded: readonly ContextChunk[],
): ChatMessageInput | null {
  const segments: string[] = [];
  if (systemPrompt !== null && systemPrompt !== '') segments.push(systemPrompt);
  for (const chunk of loaded) segments.push(chunk.text);
  if (segments.length === 0) return null;
  return { role: 'system', text: segments.join('\n\n') };
}

/* -------------------------------------------------------------------------- */

class AgentLoopHarness implements RuntimeHarness {
  constructor(
    private readonly services: HarnessServices,
    private readonly stepCeiling: number | null,
  ) {}

  start(request: RunRequest, emit: RunEmit): RunController {
    // `runStarted` is emitted synchronously, before anything is awaited, so seq
    // 0 is in the buffer by the time `start` returns and a caller that
    // subscribes on the next line replays the shape of the run first.
    emit({ type: 'runStarted', capabilities: request.capabilities });
    const run = new AgentRun(this.services, request, emit, this.stepCeiling);
    void run.drive();
    return run.controller();
  }
}

export const AGENT_LOOP_HARNESS_ID = 'agent-loop';
export const SINGLE_TURN_HARNESS_ID = 'single-turn';

/**
 * The multi-step, tool-executing harness.
 *
 * `requiresModelCapabilities` is empty on purpose. A tool-executing harness
 * pointed at a model that cannot request tools is a perfectly good chat run:
 * `mergeRunCapabilities` ANDs the two flags, so `RunCapabilities.toolExecution`
 * comes out `false` and the loop above ends after one turn. Demanding
 * `toolCalls` here would make an unprobed model — every flag `false` — unable to
 * select any harness at all, which is the pessimistic floor working against the
 * user rather than for them.
 *
 * `auxiliaryModel` is `false` and the loop **never emits**
 * `auxiliaryModelUnavailable`. That degradation reports internal steps that fell
 * back to the primary model; this loop has no internal steps — no title, no
 * summary, no compaction — so there is nothing that fell back, and emitting it
 * would report a reduction that did not happen. A harness that adds such a step
 * flips the flag and owes the degradation.
 */
export const agentLoopHarness: HarnessDefinition = {
  descriptor: {
    id: AGENT_LOOP_HARNESS_ID,
    displayName: 'Agent loop',
    capabilities: { multiStep: true, toolExecution: true, auxiliaryModel: false },
    requiresModelCapabilities: [],
  },
  create: (services: HarnessServices): RuntimeHarness => new AgentLoopHarness(services, null),
};

/**
 * The same loop with the ceiling pinned at one turn.
 *
 * Not a second implementation: a second implementation of an accumulation rule
 * is exactly the divergence `contract-harness.ts` argues a one-method seam
 * exists to prevent. What differs is one number, and `multiStep: false` is what
 * the settings surface renders from.
 */
export const singleTurnHarness: HarnessDefinition = {
  descriptor: {
    id: SINGLE_TURN_HARNESS_ID,
    displayName: 'Single turn',
    capabilities: { multiStep: false, toolExecution: false, auxiliaryModel: false },
    requiresModelCapabilities: [],
  },
  create: (services: HarnessServices): RuntimeHarness => new AgentLoopHarness(services, 1),
};
