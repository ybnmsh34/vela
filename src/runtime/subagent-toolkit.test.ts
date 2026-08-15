/**
 * Parallel subagents, asserted rather than claimed.
 *
 * The claim this file has to earn is narrow and checkable: two subagents are two
 * **runs**, live in the directory at the same instant, each with its own harness
 * instance and its own event stream. Not one loop with two scratchpad sections.
 * The first test takes `runs.list()` while both children are mid-turn and counts
 * three running runs; everything else here is about what happens to them —
 * results feeding back into the parent's next turn, the parent's cancel reaching
 * them, and the depth ceiling holding when a model calls a tool it was never
 * offered.
 *
 * The whole thing is driven by a fake `TurnDriver`. Nothing talks to a model.
 */

import { describe, expect, it } from 'vitest';

import type { ChatSendReq } from '@/platform/contract';
import type { RunEvent, RunSnapshot } from '@/platform/contract-harness';

import { createHarnessRuntime } from './harness-runtime';
import {
  SUBAGENT_TOOL_NAME,
  createSubagentToolkit,
  subagentToolDefinition,
} from './subagent-toolkit';
import {
  FakeTurnDriver,
  chatResponse,
  recordingTranscript,
  runRequest,
  toolCall,
} from './run-doubles';

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

const PARENT_RUN = 'run-1';

function isParent(request: ChatSendReq): boolean {
  return request.turnId.startsWith(`${PARENT_RUN}:`);
}

interface World {
  readonly turns: FakeTurnDriver;
  readonly runtime: ReturnType<typeof createHarnessRuntime>;
  readonly events: RunEvent[];
  readonly childTurns: string[];
  readonly childSends: ChatSendReq[];
  startParent(): Promise<RunEvent & { readonly type: 'runFinished' }>;
  running(): readonly RunSnapshot[];
}

/**
 * A parent whose first turn asks for two subagents and whose second turn wraps
 * up, and children that hang until a test releases them.
 */
function world(
  maxDepth = 1,
  newConversationId: (parent: string, index: number) => string | Promise<string> = (
    parent,
    index,
  ) => `${parent}/sub-${String(index)}`,
): World {
  const turns = new FakeTurnDriver();
  const childTurns: string[] = [];
  const childSends: ChatSendReq[] = [];
  let parentTurn = 0;

  turns.always((request, driver) => {
    if (!isParent(request)) {
      childTurns.push(request.turnId);
      childSends.push(request);
      return;
    }
    parentTurn += 1;
    if (parentTurn === 1) {
      driver.emit(request.turnId, {
        type: 'done',
        response: chatResponse({
          toolCalls: [
            toolCall('c1', SUBAGENT_TOOL_NAME, { task: 'read the file' }),
            toolCall('c2', SUBAGENT_TOOL_NAME, { task: 'write the summary' }),
          ],
          stopReason: 'toolUse',
        }),
      });
      return;
    }
    driver.emit(request.turnId, { type: 'textDelta', text: 'both done' });
    driver.emit(request.turnId, {
      type: 'done',
      response: chatResponse({ parts: [{ kind: 'text', text: 'both done' }] }),
    });
  });

  const toolkit = createSubagentToolkit({
    maxDepth,
    newRunId: (parent, index) => `${parent}/sub-${index}`,
    newConversationId,
  });

  const runtime = createHarnessRuntime({
    turns,
    transcript: recordingTranscript().writer,
    toolsFor: (request, runs) => toolkit.toolsFor(request, runs),
    readProjectInstructions: () => Promise.resolve(null),
    now: () => 0,
  });

  const events: RunEvent[] = [];

  return {
    turns,
    runtime,
    events,
    childTurns,
    childSends,
    running: () => runtime.runs.list().filter((snapshot) => snapshot.status.type === 'running'),
    startParent: () =>
      new Promise((resolve) => {
        const start = runtime.runs.start(
          runRequest({ runId: PARENT_RUN, tools: [subagentToolDefinition] }),
        );
        if (start.outcome !== 'started') throw new Error(`rejected: ${start.reason}`);
        start.handle.subscribe(
          (envelope) => {
            events.push(envelope.event);
            if (envelope.event.type === 'runFinished') resolve(envelope.event);
          },
          { fromSeq: 0 },
        );
      }),
  };
}

/* -------------------------------------------------------------------------- */

describe('two subagents are two runs', () => {
  it('has three runs live in the directory at the same instant', async () => {
    const w = world();
    const finished = w.startParent();
    await flush();

    const live = w.running().map((snapshot) => snapshot.runId);
    expect(live).toEqual([PARENT_RUN, `${PARENT_RUN}/sub-1`, `${PARENT_RUN}/sub-2`]);
    // Both children reached the model. A decomposition inside one loop could not
    // have two turns open at once.
    expect(w.childTurns).toEqual([`${PARENT_RUN}/sub-1:1`, `${PARENT_RUN}/sub-2:1`]);

    for (const turnId of w.childTurns) {
      w.turns.emit(turnId, { type: 'textDelta', text: `answer from ${turnId}` });
      w.turns.emit(turnId, {
        type: 'done',
        response: chatResponse({ parts: [{ kind: 'text', text: `answer from ${turnId}` }] }),
      });
    }
    await finished;
  });

  it('gives each child its own conversation, so neither is rejected as busy', async () => {
    const w = world();
    const finished = w.startParent();
    await flush();

    const conversations = w.runtime.runs.list().map((snapshot) => snapshot.conversationId);
    expect(conversations).toEqual(['conv-1', 'conv-1/sub-1', 'conv-1/sub-2']);
    expect(new Set(conversations).size).toBe(conversations.length);
    // Each child is addressable on its own conversation, which is what a
    // background-task pane would tail. Sharing the parent's would have made the
    // second child a `conversationBusy` rejection.
    expect(w.runtime.runs.forConversation('conv-1/sub-1')?.runId).toBe(`${PARENT_RUN}/sub-1`);

    for (const turnId of w.childTurns) {
      w.turns.emit(turnId, {
        type: 'done',
        response: chatResponse({ parts: [{ kind: 'text', text: 'x' }] }),
      });
    }
    await finished;
  });

  it("feeds each child's answer back as the tool result that called it", async () => {
    const w = world();
    const finished = w.startParent();
    await flush();

    w.turns.emit(`${PARENT_RUN}/sub-1:1`, { type: 'textDelta', text: 'file contents' });
    w.turns.emit(`${PARENT_RUN}/sub-1:1`, {
      type: 'done',
      response: chatResponse({ parts: [{ kind: 'text', text: 'file contents' }] }),
    });
    w.turns.emit(`${PARENT_RUN}/sub-2:1`, { type: 'textDelta', text: 'the summary' });
    w.turns.emit(`${PARENT_RUN}/sub-2:1`, {
      type: 'done',
      response: chatResponse({ parts: [{ kind: 'text', text: 'the summary' }] }),
    });

    const outcome = await finished;
    expect(outcome.outcome).toEqual({ type: 'completed', stopReason: 'endTurn' });

    const parentSecondTurn = w.turns.sent.find((request) => request.turnId === `${PARENT_RUN}:2`);
    expect(parentSecondTurn?.messages.slice(2)).toEqual([
      {
        role: 'tool',
        text: '',
        parts: [{ kind: 'toolResult', callId: 'c1', content: 'file contents', isError: false }],
      },
      {
        role: 'tool',
        text: '',
        parts: [{ kind: 'toolResult', callId: 'c2', content: 'the summary', isError: false }],
      },
    ]);
  });

  it('reports a failed subagent as a failed tool, not as a failed parent', async () => {
    const w = world();
    const finished = w.startParent();
    await flush();

    w.turns.emit(`${PARENT_RUN}/sub-1:1`, { type: 'error', error: { kind: 'cancelled' } });
    w.turns.emit(`${PARENT_RUN}/sub-2:1`, {
      type: 'done',
      response: chatResponse({ parts: [{ kind: 'text', text: 'fine' }] }),
    });

    const outcome = await finished;
    // The parent survived and got to decide what to do about it.
    expect(outcome.outcome.type).toBe('completed');
    const parentSecondTurn = w.turns.sent.find((request) => request.turnId === `${PARENT_RUN}:2`);
    const firstResult = parentSecondTurn?.messages[2]?.parts?.[0];
    expect(firstResult).toEqual({
      kind: 'toolResult',
      callId: 'c1',
      content: '',
      isError: true,
    });
  });
});

describe('cancellation reaches down', () => {
  it("cancels every child when the parent's run is cancelled", async () => {
    const w = world();
    const finished = w.startParent();
    await flush();

    const parent = w.runtime.runs.get(PARENT_RUN);
    expect(parent).not.toBeNull();
    await parent?.cancel();
    await flush();

    const outcome = await finished;
    expect(outcome.outcome).toEqual({ type: 'cancelled' });
    expect(w.runtime.runs.get(`${PARENT_RUN}/sub-1`)?.snapshot().status).toEqual({
      type: 'cancelled',
    });
    expect(w.runtime.runs.get(`${PARENT_RUN}/sub-2`)?.snapshot().status).toEqual({
      type: 'cancelled',
    });
    // "A cancelled agent run has to cancel the sandbox runs it started ... or
    // the frame or child process outlives the loop that asked for it." Same
    // argument, one level up: the child's open turn is cancelled too.
    expect(w.turns.cancelled).toContain(`${PARENT_RUN}/sub-1:1`);
    expect(w.turns.cancelled).toContain(`${PARENT_RUN}/sub-2:1`);
  });
});

describe('the depth ceiling', () => {
  it('does not offer the tool to a child at the ceiling', async () => {
    const w = world(1);
    const finished = w.startParent();
    await flush();

    const childSend = w.childSends[0];
    expect(childSend).toBeDefined();
    expect(childSend?.tools ?? []).toEqual([]);

    for (const turnId of w.childTurns) {
      w.turns.emit(turnId, {
        type: 'done',
        response: chatResponse({ parts: [{ kind: 'text', text: 'x' }] }),
      });
    }
    await finished;
  });

  it('refuses a call that arrives anyway, with an error result rather than a rejection', async () => {
    // A catalogue is a suggestion; a model may call a tool it was never offered.
    const w = world(1);
    const finished = w.startParent();
    await flush();

    // The first child asks for a grandchild.
    w.turns.emit(`${PARENT_RUN}/sub-1:1`, {
      type: 'done',
      response: chatResponse({
        toolCalls: [toolCall('g1', SUBAGENT_TOOL_NAME, { task: 'go deeper' })],
        stopReason: 'toolUse',
      }),
    });
    await flush();

    // No grandchild was ever admitted.
    expect(w.runtime.runs.list().map((snapshot) => snapshot.runId)).toEqual([
      PARENT_RUN,
      `${PARENT_RUN}/sub-1`,
      `${PARENT_RUN}/sub-2`,
    ]);

    const childSecondTurn = w.turns.sent.find(
      (request) => request.turnId === `${PARENT_RUN}/sub-1:2`,
    );
    const refusal = childSecondTurn?.messages.at(-1)?.parts?.[0];
    expect(refusal).toEqual({
      kind: 'toolResult',
      callId: 'g1',
      content: 'subagent depth limit reached',
      isError: true,
    });

    w.turns.emit(`${PARENT_RUN}/sub-1:2`, {
      type: 'done',
      response: chatResponse({ parts: [{ kind: 'text', text: 'stopped' }] }),
    });
    w.turns.emit(`${PARENT_RUN}/sub-2:1`, {
      type: 'done',
      response: chatResponse({ parts: [{ kind: 'text', text: 'x' }] }),
    });
    await finished;
  });

  it('refuses arguments without a task, rather than starting an empty run', async () => {
    const w = world(1);
    const finished = w.startParent();
    await flush();

    w.turns.emit(`${PARENT_RUN}/sub-1:1`, {
      type: 'done',
      response: chatResponse({ parts: [{ kind: 'text', text: 'x' }] }),
    });
    w.turns.emit(`${PARENT_RUN}/sub-2:1`, {
      type: 'done',
      response: chatResponse({ parts: [{ kind: 'text', text: 'y' }] }),
    });
    await finished;

    // A second parent run, whose model sends a malformed argument object.
    const toolkit = createSubagentToolkit({
      maxDepth: 1,
      newRunId: (parent, index) => `${parent}/sub-${index}`,
      newConversationId: (parent, index) => `${parent}/sub-${index}`,
    });
    const executor = toolkit.toolsFor(runRequest(), w.runtime.runs);
    const outcome = await executor.execute(
      { status: 'ok', callId: 'x', name: SUBAGENT_TOOL_NAME, arguments: { task: '  ' }, emulated: false },
      new AbortController().signal,
    );
    expect(outcome).toEqual({
      kind: 'toolResult',
      callId: 'x',
      content: 'spawn_subagent requires a non-empty "task" string',
      isError: true,
    });
  });
});

/* -------------------------------------------------------------------------- */

describe('a directory rejection is a tool result, never a rejection', () => {
  // `ToolExecutor`: "It does not reject for a tool that failed … If it rejects
  // anyway, that is a defect in the executor and the harness must fail the run"
  // with `toolExecutorFailed`. This file's other refusals — the depth ceiling,
  // bad arguments, a conversation that could not be minted — are covered; the
  // one branch nothing drove is the directory answering `rejected`, which is
  // reachable two ways: two children handed the same conversation id, and a
  // minted run id that collides. The first is below.
  //
  // What it costs when that branch throws instead: one subagent that could not
  // start kills the parent, and the user loses an answer that was most of the
  // way finished.

  it('answers conversationBusy as an error result, and the parent finishes', async () => {
    // Both children are handed the *same* conversation, which is exactly what
    // `SubagentToolkitOptions.newConversationId` exists to prevent: at most one
    // run may be live per conversation, so the second child is refused.
    const w = world(1, (parent) => `${parent}/shared`);
    const finished = w.startParent();
    await flush();

    // One child was admitted and the other never existed.
    expect(w.runtime.runs.list().map((snapshot) => snapshot.runId)).toEqual([
      PARENT_RUN,
      `${PARENT_RUN}/sub-1`,
    ]);
    expect(w.childTurns).toEqual([`${PARENT_RUN}/sub-1:1`]);

    w.turns.emit(`${PARENT_RUN}/sub-1:1`, { type: 'textDelta', text: 'the one that ran' });
    w.turns.emit(`${PARENT_RUN}/sub-1:1`, {
      type: 'done',
      response: chatResponse({ parts: [{ kind: 'text', text: 'the one that ran' }] }),
    });

    const outcome = await finished;
    // The parent survived and got to decide what to do about it — rather than
    // dying as `toolExecutorFailed` for a subagent that could not start.
    expect(outcome.outcome).toEqual({ type: 'completed', stopReason: 'endTurn' });

    const parentSecondTurn = w.turns.sent.find((request) => request.turnId === `${PARENT_RUN}:2`);
    expect(parentSecondTurn?.messages.slice(2)).toEqual([
      {
        role: 'tool',
        text: '',
        parts: [{ kind: 'toolResult', callId: 'c1', content: 'the one that ran', isError: false }],
      },
      {
        role: 'tool',
        text: '',
        parts: [
          {
            kind: 'toolResult',
            callId: 'c2',
            content: 'subagent could not start: conversationBusy',
            isError: true,
          },
        ],
      },
    ]);
  });
});

describe('where a child writes is the composition root’s call, and it may be a host call', () => {
  // `newConversationId` may answer a promise, and in the shipping wiring it does:
  // `src/runtime/app-runtime.ts` creates a real conversation through
  // `store_create_conversation`, because a synthetic id has nowhere to write —
  // `store_append_message` resolves the conversation before it writes, so the
  // child's first turn would fail its append and die as a `harnessFault` before
  // its first token.

  it('awaits an id that arrives asynchronously, and the child runs in it', async () => {
    const w = world(1, async (parent, index) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return `stored:${parent}:${String(index)}`;
    });
    const finished = w.startParent();
    await flush();

    expect(w.runtime.runs.list().map((snapshot) => snapshot.conversationId)).toEqual([
      'conv-1',
      'stored:conv-1:1',
      'stored:conv-1:2',
    ]);

    for (const turnId of w.childTurns) {
      w.turns.emit(turnId, {
        type: 'done',
        response: chatResponse({ parts: [{ kind: 'text', text: 'x' }] }),
      });
    }
    await finished;
  });

  it('refuses the child as a tool result when the id cannot be minted', async () => {
    // A rejection here is a refusal like every other refusal in this file: the
    // parent is told one subagent could not start, rather than dying for it.
    const w = world(1, () => Promise.reject(new Error('the store said no')));
    const finished = w.startParent();
    await flush();

    // No child was admitted, so the parent's own run is the only one there is…
    expect(w.runtime.runs.list().map((snapshot) => snapshot.runId)).toEqual([PARENT_RUN]);
    expect(w.childTurns).toEqual([]);

    // …and the loop carried straight on to its second turn with two error
    // results in hand.
    const parentSecondTurn = w.turns.sent.find((request) => request.turnId === `${PARENT_RUN}:2`);
    expect(parentSecondTurn?.messages.slice(2)).toEqual([
      {
        role: 'tool',
        text: '',
        parts: [
          {
            kind: 'toolResult',
            callId: 'c1',
            content: 'subagent could not be given a conversation',
            isError: true,
          },
        ],
      },
      {
        role: 'tool',
        text: '',
        parts: [
          {
            kind: 'toolResult',
            callId: 'c2',
            content: 'subagent could not be given a conversation',
            isError: true,
          },
        ],
      },
    ]);

    const outcome = await finished;
    expect(outcome.outcome).toEqual({ type: 'completed', stopReason: 'endTurn' });
  });
});
