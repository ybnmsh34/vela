/**
 * Real parallel subagents.
 *
 * A subagent here is **a run**: its own `RunRequest`, its own harness instance,
 * its own services bundle, its own seq space and buffer in the directory, its
 * own cancel. Not a scratchpad section inside one loop, and not a second prompt
 * on the same `ChatSession` — the study of MindsHub Cowork is explicit that
 * Anton decomposes into sub-scratchpads inside a single session, and that is the
 * thing this is not. Two subagents are two entries in `LiveRuns.list()` with
 * `status.type === 'running'` at the same instant, which is what
 * `src/runtime/subagent-toolkit.test.ts` asserts rather than describes.
 *
 * ## Where the parallelism actually comes from
 *
 * Not from here. `src/runtime/agent-loop-harness.ts` dispatches one turn's tool
 * calls together and awaits them together, so a model that emits two
 * `spawn_subagent` calls in one turn causes two `execute` calls to be in flight
 * at once, and each of those starts a run. This file's job is to make each one a
 * genuine child run and to make the parent's cancel reach it.
 *
 * ## What keeps it from recursing forever
 *
 * `RunRequest` is frozen and carries no depth, so depth is tracked beside the
 * runs rather than on them: this toolkit remembers the depth of every run it
 * spawned, keyed by the run id it minted, and reads it back when the directory
 * asks for that run's executor. That is why the toolkit is an object with state
 * and not a free function — a per-run executor cannot know how deep it is, and
 * an amendment adding a depth field to a frozen contract would be the wrong
 * trade for a fact only this component needs.
 *
 * Two mechanisms, deliberately: a child at the ceiling is not *offered* the tool
 * (it is stripped from its `tools`), and a call that arrives anyway is refused
 * with an error result rather than a rejection. The first is what a
 * well-behaved model sees; the second is what actually holds, because the tool
 * catalogue is a suggestion and a model may call a tool it was never offered.
 *
 * ## Why a refusal is a result and never a rejection
 *
 * `ToolExecutor` says it: a failure is a result with `isError: true`, because a
 * rejected promise fails the whole run and would turn "one subagent could not
 * start" into "the parent died". Every refusal below — depth, bad arguments, a
 * directory rejection — comes back as an error result the model can read and
 * work around.
 */

import type { ToolDefinitionInput } from '@/platform/contract';
import type {
  ExecutableToolCall,
  LiveRuns,
  RunId,
  RunLimits,
  RunListener,
  RunOutcome,
  RunRequest,
  ToolExecutor,
  ToolResultPart,
} from '@/platform/contract-harness';

export const SUBAGENT_TOOL_NAME = 'spawn_subagent';

/**
 * The catalogue entry a caller puts on `RunRequest.tools` to offer this.
 *
 * Offered per run, like every tool, because which tools are available is a
 * property of what the user is doing. A run that omits this is a run with no
 * subagents, and nothing else about it changes.
 */
export const subagentToolDefinition: ToolDefinitionInput = {
  name: SUBAGENT_TOOL_NAME,
  description:
    'Delegate one self-contained task to a subagent that runs independently and ' +
    'returns its final answer as text. Issue several calls in one turn to run ' +
    'them at the same time.',
  parameters: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'The whole task, stated so it can be worked on without further context.',
      },
    },
    required: ['task'],
    additionalProperties: false,
  },
};

export interface SubagentToolkitOptions {
  /**
   * How many levels of subagent may exist below a run started by a caller. `1`
   * means a top-level run may spawn subagents and those subagents may not.
   */
  readonly maxDepth: number;
  /** Mints a child run id. Must be unique — the directory rejects a duplicate. */
  readonly newRunId: (parentRunId: RunId, index: number) => RunId;
  /**
   * Mints the conversation a child run writes into.
   *
   * A child needs one of its own: at most one run may be live per conversation,
   * so two subagents sharing the parent's conversation would mean the second is
   * rejected as `conversationBusy` — and the parent's transcript would be
   * interleaved with work the user never asked to see. What that id *is* — a
   * real conversation created through `store_create_conversation`, or a
   * synthetic one — is the composition root's decision, not this file's.
   *
   * **May answer a promise**, because one of those two decisions is a host call.
   * A root that creates a real conversation cannot answer synchronously, and a
   * root that mints a synthetic id still can — the union is what lets both be
   * expressed without this file knowing which was chosen. A rejection is a
   * refusal like any other here: the child never starts and the model is told
   * so, rather than the parent dying for it.
   */
  readonly newConversationId: (
    parentConversationId: string,
    index: number,
  ) => string | Promise<string>;
  /** The child's ceilings, derived from the parent's. Identity by default. */
  readonly limitsFor?: ((parent: RunLimits) => RunLimits) | undefined;
  /**
   * Runs every tool that is not this one. Omitted means a run whose only tool is
   * the subagent tool: any other call comes back `isError: true`, which is the
   * honest answer for an executor that cannot run it.
   */
  readonly delegate?: ((request: RunRequest) => ToolExecutor) | undefined;
}

export interface SubagentToolkit {
  /**
   * The `ToolExecutor` for one run — the function a composition root hands to
   * `createHarnessRuntime`. Called once per admitted run, never per turn.
   */
  toolsFor(request: RunRequest, runs: LiveRuns): ToolExecutor;
  /** The depth of a run this toolkit spawned. `0` for a run it did not. */
  depthOf(runId: RunId): number;
}

function errorResult(callId: string, content: string): ToolResultPart {
  return { kind: 'toolResult', callId, content, isError: true };
}

/** The `task` argument, or `null` if the model did not send a usable one. */
function readTask(argumentsValue: unknown): string | null {
  if (typeof argumentsValue !== 'object' || argumentsValue === null) return null;
  const task = (argumentsValue as { readonly task?: unknown }).task;
  if (typeof task !== 'string' || task.trim() === '') return null;
  return task;
}

export function createSubagentToolkit(options: SubagentToolkitOptions): SubagentToolkit {
  const depths = new Map<RunId, number>();
  let counter = 0;

  const depthOf = (runId: RunId): number => depths.get(runId) ?? 0;

  return {
    depthOf,
    toolsFor(request: RunRequest, runs: LiveRuns): ToolExecutor {
      const delegate = options.delegate?.(request) ?? null;

      return {
        async execute(call: ExecutableToolCall, signal: AbortSignal): Promise<ToolResultPart> {
          if (call.name !== SUBAGENT_TOOL_NAME) {
            if (delegate === null) {
              return errorResult(call.callId, `no executor for tool: ${call.name}`);
            }
            return delegate.execute(call, signal);
          }

          const depth = depthOf(request.runId);
          if (depth >= options.maxDepth) {
            return errorResult(call.callId, 'subagent depth limit reached');
          }
          const task = readTask(call.arguments);
          if (task === null) {
            return errorResult(call.callId, 'spawn_subagent requires a non-empty "task" string');
          }

          counter += 1;
          const index = counter;
          const childRunId = options.newRunId(request.runId, index);
          const childDepth = depth + 1;
          // Recorded *before* `start`, because the directory calls the services
          // factory — and therefore `toolsFor` for the child — inside that call.
          // A depth written afterwards would be written after the only reader.
          depths.set(childRunId, childDepth);

          const childTools =
            childDepth >= options.maxDepth
              ? request.tools?.filter((tool) => tool.name !== SUBAGENT_TOOL_NAME)
              : request.tools;

          let childConversationId: string;
          try {
            childConversationId = await options.newConversationId(request.conversationId, index);
          } catch {
            // Somewhere for the child's transcript to go is a precondition, not
            // a detail: without it the child's first `append` fails and the
            // child dies as a `harnessFault`. A refusal here is the same shape
            // as every other refusal in this file — an error result the parent
            // can read — rather than a rejection that would kill the parent too.
            depths.delete(childRunId);
            return errorResult(call.callId, 'subagent could not be given a conversation');
          }

          const childRequest: RunRequest = {
            runId: childRunId,
            conversationId: childConversationId,
            projectId: request.projectId,
            harnessId: request.harnessId,
            models: request.models,
            input: [{ role: 'user', text: task }],
            ...(childTools === undefined ? {} : { tools: childTools }),
            ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
            // The same project's preload, because a subagent works inside the
            // same project and the refs came from that project's resolver — the
            // one thing `RunContextRequest.preload` requires of them.
            context: request.context,
            limits: options.limitsFor?.(request.limits) ?? request.limits,
            capabilities: request.capabilities,
          };

          const started = runs.start(childRequest);
          if (started.outcome === 'rejected') {
            depths.delete(childRunId);
            return errorResult(call.callId, `subagent could not start: ${started.reason}`);
          }

          const handle = started.handle;
          const chunks: string[] = [];
          let settle: ((outcome: RunOutcome) => void) | null = null;
          let early: RunOutcome | null = null;

          const listener: RunListener = (envelope) => {
            const event = envelope.event;
            if (event.type === 'chat') {
              if (event.event.type === 'textDelta') chunks.push(event.event.text);
              return;
            }
            if (event.type !== 'runFinished') return;
            if (settle === null) early = event.outcome;
            else settle(event.outcome);
          };

          // From seq 0: the child may have finished before this listener is
          // attached — a harness that fails immediately does — and the whole
          // point of replay is that arriving late costs nothing.
          const subscription = handle.subscribe(listener, { fromSeq: 0 });

          const onAbort = (): void => {
            void handle.cancel();
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });

          try {
            const outcome = await new Promise<RunOutcome>((resolve) => {
              if (early !== null) {
                resolve(early);
                return;
              }
              settle = resolve;
            });
            return {
              kind: 'toolResult',
              callId: call.callId,
              content: chunks.join(''),
              // A cancelled or failed subagent is a failed tool, not a failed
              // parent: the parent decides what to do about it, which is the
              // whole reason this comes back as a result.
              isError: outcome.type !== 'completed',
            };
          } finally {
            subscription.unsubscribe();
            signal.removeEventListener('abort', onAbort);
            depths.delete(childRunId);
          }
        },
      };
    },
  };
}
