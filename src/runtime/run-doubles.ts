/**
 * The test doubles the runtime's own tests are built from.
 *
 * Not a test file, so nothing here runs on its own; it is imported by the four
 * `*.test.ts` files beside it. It lives in `src/` rather than in `tests/`
 * because vitest's `include` for this project is `src/**` and a double that
 * cannot be imported by the tests that need it is no use.
 *
 * Everything here is deliberately small. `contract-harness.ts` makes the point
 * itself about `TurnDriver`: a harness is handed three functions rather than a
 * `PlatformAdapter` precisely so that a harness test needs three functions and
 * not a whole fake host. None of these doubles opens a socket, and no test in
 * this directory talks to a model.
 */

import type { Unsubscribe } from '@/platform/adapter';
import type {
  ChatCancelReq,
  ChatCancelRes,
  ChatEventEnvelope,
  ChatMessageInput,
  ChatResponseBody,
  ChatSendReq,
  ChatSendRes,
  ChatStreamEvent,
  ContentPart,
  StopReason,
  StoreAppendMessageReq,
  StoreUpdateMessageReq,
  StoredMessage,
  TokenUsage,
  ToolCallOutcome,
} from '@/platform/contract';
import { DEFAULT_PROJECT_ID } from '@/platform/contract-project';
import {
  DEFAULT_RUN_LIMITS,
  type HarnessDefinition,
  type HarnessServices,
  type RunEmit,
  type RunEvent,
  type RunId,
  type RunRequest,
  type RuntimeHarness,
  type TranscriptWriter,
  type TurnDriver,
} from '@/platform/contract-harness';

export const NO_USAGE: TokenUsage = {
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  cachedInputTokens: null,
};

export function chatResponse(overrides: Partial<ChatResponseBody> = {}): ChatResponseBody {
  return {
    parts: [],
    toolCalls: [],
    stopReason: 'endTurn',
    usage: NO_USAGE,
    structured: null,
    degradations: [],
    ...overrides,
  };
}

/** A turn that says one thing and stops. */
export function textReply(text: string, stopReason: StopReason = 'endTurn'): ChatResponseBody {
  const parts: readonly ContentPart[] = [{ kind: 'text', text }];
  return chatResponse({ parts, stopReason });
}

export function toolCall(callId: string, name: string, args: unknown): ToolCallOutcome {
  return { status: 'ok', callId, name, arguments: args, emulated: false };
}

/* -------------------------------------------------------------------------- */

/**
 * A `TurnDriver` a test scripts turn by turn.
 *
 * `send` runs the script **synchronously**, before it resolves, which is the
 * awkward ordering `contract.ts` records as real: events for a turn can arrive
 * before the invoke promise settles. A double that only ever emitted afterwards
 * would let a harness that subscribed too late pass.
 */
export class FakeTurnDriver implements TurnDriver {
  readonly sent: ChatSendReq[] = [];
  readonly cancelled: string[] = [];
  private readonly handlers = new Set<(envelope: ChatEventEnvelope) => void>();
  private readonly scripted: ((request: ChatSendReq, driver: FakeTurnDriver) => void)[] = [];
  private standing: ((request: ChatSendReq, driver: FakeTurnDriver) => void) | null = null;

  /** The reply for the next turn sent, in order. */
  script(reply: (request: ChatSendReq, driver: FakeTurnDriver) => void): this {
    this.scripted.push(reply);
    return this;
  }

  /** The reply for every turn the script does not cover. */
  always(reply: (request: ChatSendReq, driver: FakeTurnDriver) => void): this {
    this.standing = reply;
    return this;
  }

  /** Convenience: answer the next turn with one text delta and a `done`. */
  scriptText(text: string, stopReason: StopReason = 'endTurn'): this {
    return this.script((request, driver) => {
      driver.emit(request.turnId, { type: 'textDelta', text });
      driver.emit(request.turnId, { type: 'done', response: textReply(text, stopReason) });
    });
  }

  emit(turnId: string, event: ChatStreamEvent): void {
    for (const handler of [...this.handlers]) handler({ turnId, event });
  }

  /** The last turn id this driver was asked to run. */
  lastTurnId(): string {
    const last = this.sent[this.sent.length - 1];
    if (last === undefined) throw new Error('no turn has been sent');
    return last.turnId;
  }

  send(request: ChatSendReq): Promise<ChatSendRes> {
    this.sent.push(request);
    const reply = this.scripted.shift() ?? this.standing;
    reply?.(request, this);
    return Promise.resolve({ turnId: request.turnId, accepted: true });
  }

  cancel(request: ChatCancelReq): Promise<ChatCancelRes> {
    this.cancelled.push(request.turnId);
    return Promise.resolve({ cancelled: true });
  }

  listen(handler: (envelope: ChatEventEnvelope) => void): Promise<Unsubscribe> {
    this.handlers.add(handler);
    return Promise.resolve(() => {
      this.handlers.delete(handler);
    });
  }
}

/* -------------------------------------------------------------------------- */

export interface RecordingTranscript {
  readonly writer: TranscriptWriter;
  readonly appended: StoreAppendMessageReq[];
  readonly updated: StoreUpdateMessageReq[];
}

export function recordingTranscript(): RecordingTranscript {
  const appended: StoreAppendMessageReq[] = [];
  const updated: StoreUpdateMessageReq[] = [];
  let next = 0;
  const stored = (request: StoreAppendMessageReq, id: string): StoredMessage => ({
    id,
    conversationId: request.conversationId,
    seq: next,
    role: request.role,
    status: request.status ?? 'complete',
    parts: request.parts,
    providerId: request.providerId ?? null,
    modelId: request.modelId ?? null,
    usage: request.usage ?? NO_USAGE,
    stopReason: request.stopReason ?? null,
    errorMessage: request.errorMessage ?? null,
    createdAtMs: 0,
    updatedAtMs: 0,
  });
  return {
    appended,
    updated,
    writer: {
      append: (request) => {
        appended.push(request);
        const id = `msg-${next}`;
        next += 1;
        return Promise.resolve(stored(request, id));
      },
      update: (request) => {
        updated.push(request);
        return Promise.resolve(
          stored({ conversationId: 'c', role: 'assistant', parts: [] }, request.messageId),
        );
      },
    },
  };
}

/* -------------------------------------------------------------------------- */

export function runRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  const input: readonly ChatMessageInput[] = [{ role: 'user', text: 'hello' }];
  return {
    runId: 'run-1',
    conversationId: 'conv-1',
    projectId: DEFAULT_PROJECT_ID,
    harnessId: 'agent-loop',
    models: { primary: { providerId: 'p1', modelId: 'm1' } },
    input,
    context: { systemPrompt: null, preload: [] },
    limits: DEFAULT_RUN_LIMITS,
    capabilities: { multiStep: true, toolExecution: true, auxiliaryModel: false },
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */

/**
 * A harness a test drives by hand.
 *
 * The directory's own rules — sequencing, buffering, replay, one bundle and one
 * instance per admitted run — are about what happens *around* a harness, so the
 * harness in those tests should do nothing on its own. This one emits only what
 * a test tells it to, and records every bundle it was created with so the
 * once-per-run rule can be checked by counting rather than by trusting.
 */
export interface ManualHarness {
  readonly definition: HarnessDefinition;
  /** One entry per `create` call. Its length is the once-per-run assertion. */
  readonly bundles: HarnessServices[];
  readonly started: RunRequest[];
  readonly cancelled: RunId[];
  /** Emit into a started run. Throws for a run it never started. */
  emitTo(runId: RunId, event: RunEvent): void;
}

export function createManualHarness(id = 'manual'): ManualHarness {
  const bundles: HarnessServices[] = [];
  const started: RunRequest[] = [];
  const cancelled: RunId[] = [];
  const emitters = new Map<RunId, RunEmit>();

  const definition: HarnessDefinition = {
    descriptor: {
      id,
      displayName: 'Manual',
      capabilities: { multiStep: true, toolExecution: true, auxiliaryModel: false },
      requiresModelCapabilities: [],
    },
    create: (services: HarnessServices): RuntimeHarness => {
      bundles.push(services);
      return {
        start: (request: RunRequest, emit: RunEmit) => {
          started.push(request);
          emitters.set(request.runId, emit);
          return {
            cancel: () => {
              cancelled.push(request.runId);
              return Promise.resolve();
            },
          };
        },
      };
    },
  };

  return {
    definition,
    bundles,
    started,
    cancelled,
    emitTo: (runId, event) => {
      const emit = emitters.get(runId);
      if (emit === undefined) throw new Error(`no started run: ${runId}`);
      emit(event);
    },
  };
}

/** A services bundle for tests that never reach past `now`. */
export function inertServices(now: () => number = () => 0): HarnessServices {
  const unreachable = (name: string): never => {
    throw new Error(`inert services: ${name} was called`);
  };
  return {
    turns: {
      send: () => unreachable('turns.send'),
      cancel: () => unreachable('turns.cancel'),
      listen: () => unreachable('turns.listen'),
    },
    tools: { execute: () => unreachable('tools.execute') },
    context: { index: () => unreachable('context.index'), load: () => unreachable('context.load') },
    transcript: {
      append: () => unreachable('transcript.append'),
      update: () => unreachable('transcript.update'),
    },
    parts: { toInput: () => unreachable('parts.toInput'), turnToInput: () => unreachable('parts.turnToInput') },
    now,
  };
}
