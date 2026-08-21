/**
 * **Two subagents, in flight at once, through the composition root.**
 *
 * ## What was untestable, and why that was a property of the fake
 *
 * The path from a model's `spawn_subagent` call to a second live run has two
 * halves, and only the second one used to be hard to reach.
 *
 * **The offer.** `use-conversation.ts` puts `subagentToolDefinition` in
 * `startRun`'s `tools`, and `app-runtime.ts` wires `createSubagentToolkit` into
 * `toolsFor`. Nothing below asserts either by reading it. The catalogue is read
 * back off the `ChatSendReq` the host actually received, and the scripted call
 * is **gated** on it: a script that invented a call regardless of what it was
 * handed would prove the execution half while leaving the offer — the first
 * link — free to be deleted with the suite still green. So an agent run started
 * with an empty `tools` fans out to nothing, and every assertion below the
 * offer goes with it.
 *
 * **The execution.** That half had no test that executed it through the app.
 * `BrowserAdapter`'s `#chatSend` answered every turn with `toolCalls: []` — a
 * literal, not a decision the request could influence — so the agent loop's
 * `executableCalls` came back empty on every turn `<App />` could produce, the
 * toolkit's `execute` was never reached that way, and `createAgentRuntime`'s
 * `newRunId` and `newConversationId` closures never ran at all — the counter
 * described below attributes every one of its hits to this file.
 * (`newConversationId` is the only non-test caller of
 * `store_create_conversation` under `src/runtime/`;
 * `adapter-integration.test.ts` invokes the command itself.)
 *
 * The existing subagent proof, `src/runtime/subagent-toolkit.test.ts`, has no
 * adapter in it at all: it hands `createHarnessRuntime` a `FakeTurnDriver`, a
 * recording transcript writer, and its own `newRunId` and `newConversationId`.
 * So it says nothing about `chat_send`, about `chat:event`, about the store, or
 * about anything `App.tsx` assembles — including the two id minters the
 * shipping wiring supplies instead.
 *
 * `BrowserAdapter.seedReplyScript` is the seam-preserving alternative: the tool
 * call is carried by the same `chat:event` stream every other turn uses, over
 * the same `chat_send` the same validation refuses.
 *
 * ## Why a barrier and not a snapshot
 *
 * A pair of runs observed to be live *after the fact* is satisfied by a
 * sequential implementation whose first child simply had not been cleaned up
 * yet. So concurrency here is not observed, it is **required**: neither child's
 * turn is answered until both children's turns have arrived at the fake. An
 * implementation that started the second child only after the first finished
 * cannot get past that, and `RENDEZVOUS_DEADLOCK_MS` turns the resulting hang
 * into a legible failure instead of a runner timeout.
 *
 * **Honesty (conventions §10): VERIFIED-BY-FAKE.** The host is `BrowserAdapter`
 * and the model is a script. What is substituted, precisely:
 *
 *  - **The endpoint.** No model decides to call `spawn_subagent` here; the test
 *    does. That the tool definition actually offered would elicit such a call
 *    from a real model is not evidenced by anything below.
 *  - **The store.** An in-memory `Map`, not SQLite. Two concurrent children
 *    writing rows prove nothing about transaction behaviour in the real one.
 *  - **The scheduler.** jsdom, one thread. "At the same time" here means "both
 *    awaiting, neither settled", which is what concurrency means in this
 *    runtime — but it is not two OS threads and must not be read as such.
 *  - **The clock.** `Date.now`, un-driven. No claim is made about how long a
 *    fan-out takes.
 *
 * The last test in the file is about `seedReplyScript` itself rather than about
 * the fan-out: it is the only thing in the tree that stops a turn while its
 * script is still an unsettled promise, which is a state no other turn in this
 * fake can be in.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '@/app/App';
import { BrowserAdapter, type ScriptedReply } from '@/platform/browser-adapter';
import {
  NO_CAPABILITIES,
  type ChatEventEnvelope,
  type ChatSendReq,
  type ChatStreamEvent,
  type ModelCapabilityReport,
  type StoredMessage,
  type ToolCallOutcome,
  type ToolDefinitionInput,
} from '@/platform/contract';
import { SUBAGENT_TOOL_NAME, subagentToolDefinition } from '@/runtime/subagent-toolkit';
import { resetModelStore } from '@/state/model-store';
import { resetNavigationStore } from '@/state/navigation-store';

/** What the user types. Distinct from every task below, so the script can tell. */
const PARENT_ASK = 'delegate this';
/** The two tasks the scripted model delegates. One child each. */
const TASKS: readonly string[] = ['read the log', 'write the summary'];
/** What a script decides after its turn was already stopped. Must reach nobody. */
const AFTER_THE_STOP = 'answered after the stop';

/**
 * How long a held child waits for its sibling before the rendezvous gives up.
 *
 * **A deadlock detector, not a budget.** The mechanism, not the measurement, is
 * why it can be this loose: `runTools` dispatches both calls into one
 * `Promise.allSettled`, so the gap between the two arrivals is a microtask
 * cascade broken only by the two `store_create_conversation` round trips against
 * an in-memory store. Nothing in it waits on wall-clock time.
 *
 * The number is therefore chosen against the *other* risk — a machine so loaded
 * that microtasks are minutes apart is not distinguishable from a deadlock, and
 * a fabricated red costs more than a slow one. Observed so far: the detector has
 * never fired on a working tree, including runs of this same file that took over
 * six seconds end to end under load. That is an observation and not a bound;
 * should it ever fire on a working tree, the assertion says so in as many words
 * and this is the number to raise.
 */
const RENDEZVOUS_DEADLOCK_MS = 10_000;

/** Room for the detector above to fire and be *reported*, rather than time out. */
const TEST_TIMEOUT_MS = 30_000;

function report(): ModelCapabilityReport {
  return {
    providerId: 'workstation',
    modelId: 'local-model',
    // `toolCalls` is what `use-conversation.ts` gates `agentAvailable` on, and
    // what `mergeRunCapabilities` ANDs into `RunCapabilities.toolExecution`.
    // Without it the loop ends after one turn and no executor is ever reached.
    capabilities: { ...NO_CAPABILITIES, streaming: true, toolCalls: true },
    structuredOutput: false,
    toolCallsEmulated: false,
    contextWindowTokens: 200_000,
    maxOutputTokens: null,
    probed: true,
    findings: [],
  };
}

async function host(): Promise<BrowserAdapter> {
  const adapter = new BrowserAdapter();
  await adapter.invoke('settings_put_provider', {
    id: 'workstation',
    displayName: 'The workstation',
    kind: 'local',
    baseUrl: 'http://127.0.0.1:8080/v1',
    modelId: 'local-model',
  });
  adapter.seedCapabilities(report());
  return adapter;
}

function ok(callId: string, task: string): ToolCallOutcome {
  return { status: 'ok', callId, name: SUBAGENT_TOOL_NAME, arguments: { task }, emulated: false };
}

/** The last thing a *user* said in this turn's replay, which is what an echo answers. */
function lastUserText(request: ChatSendReq): string {
  return [...request.messages].reverse().find((message) => message.role === 'user')?.text ?? '';
}

/**
 * The tool catalogue this turn was handed, as the host received it.
 *
 * `ChatSendReq.tools` is optional, and absent is not the same statement as
 * empty — but it is the same catalogue, so the reading below flattens them and
 * the distinction is left to whatever cares about it.
 */
function offeredTools(request: ChatSendReq): readonly ToolDefinitionInput[] {
  return request.tools ?? [];
}

/** Whether this turn could have asked for the subagent tool at all. */
function wasOfferedSubagent(request: ChatSendReq): boolean {
  return offeredTools(request).some((tool) => tool.name === SUBAGENT_TOOL_NAME);
}

/* -------------------------------------------------------------------------- */

/**
 * A meeting point that `width` turns must all reach before any of them may
 * leave.
 *
 * `observe` runs on the last arrival, while every other arrival is still parked
 * — so anything it reads is read with all of them genuinely unsettled. That is
 * the point: it is not a snapshot taken afterwards and argued about.
 */
interface Rendezvous {
  arrive(key: string): Promise<void>;
  readonly arrived: ReadonlySet<string>;
  /** True when a waiter was released by the detector rather than by a sibling. */
  readonly deadlocked: boolean;
}

function rendezvous(width: number, observe: () => Promise<void>): Rendezvous {
  const arrived = new Set<string>();
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  let deadlocked = false;

  return {
    arrived,
    get deadlocked() {
      return deadlocked;
    },
    async arrive(key: string): Promise<void> {
      arrived.add(key);
      if (arrived.size >= width) {
        await observe();
        open();
        return;
      }
      const timer = setTimeout(() => {
        deadlocked = true;
        open();
      }, RENDEZVOUS_DEADLOCK_MS);
      await opened;
      clearTimeout(timer);
    },
  };
}

/* -------------------------------------------------------------------------- */

/** Open a conversation the way a user does, and wait for the transcript. */
async function openConversation(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Start a conversation' }));
  await screen.findByRole('region', { name: 'Conversation' });
}

/** Turn the agent on and send, the way a user does. */
async function delegate(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByTestId('composer-agent-toggle'));
  await user.click(screen.getByRole('textbox', { name: 'Message' }));
  await user.paste(PARENT_ASK);
  await user.click(screen.getByRole('button', { name: 'Send' }));
}

async function settled(timeoutMs: number): Promise<void> {
  await waitFor(
    () => {
      expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'false');
    },
    { timeout: timeoutMs },
  );
}

async function conversationIds(adapter: BrowserAdapter): Promise<readonly string[]> {
  const { conversations } = await adapter.invoke('store_list_conversations', {});
  return conversations.map((conversation) => conversation.id);
}

async function messagesIn(adapter: BrowserAdapter, id: string): Promise<readonly StoredMessage[]> {
  const { messages } = await adapter.invoke('store_list_messages', { conversationId: id });
  return messages;
}

function textOf(message: StoredMessage | undefined): string {
  return (message?.parts ?? [])
    .map((part) => (part.kind === 'text' ? part.text : ''))
    .join('');
}

beforeEach(() => {
  resetModelStore();
  resetNavigationStore();
});

/* -------------------------------------------------------------------------- */

describe('the fan-out reaches a second run through the composition root', () => {
  it(
    'holds two children unsettled at once, each on its own conversation',
    async () => {
      // ── THE LOAD-BEARING TEST ────────────────────────────────────────────
      const user = userEvent.setup();
      const adapter = await host();

      const childTurnIds: string[] = [];
      const parentTurnIds: string[] = [];
      /** What each turn was offered, by `turnId`. Asserted after the run. */
      const offered = new Map<string, readonly ToolDefinitionInput[]>();
      let parentConversationId: string | null = null;
      /** Read while both children are parked. See `rendezvous`. */
      let whileHeld: {
        readonly children: readonly string[];
        readonly rows: readonly string[];
      } = { children: [], rows: [] };

      const meeting = rendezvous(TASKS.length, async () => {
        const ids = await conversationIds(adapter);
        const children = ids.filter((id) => id !== parentConversationId);
        const rows: string[] = [];
        for (const id of children) {
          for (const message of await messagesIn(adapter, id)) {
            rows.push(`${message.role}:${message.status}`);
          }
        }
        whileHeld = { children, rows };
      });

      adapter.seedReplyScript(async (request): Promise<ScriptedReply> => {
        offered.set(request.turnId, offeredTools(request));
        // Ordered widest-first: the parent's second turn still has `PARENT_ASK`
        // as its last *user* message, because tool results are `role: 'tool'`.
        if (request.messages.some((message) => message.role === 'tool')) {
          parentTurnIds.push(request.turnId);
          return { text: 'both children answered' };
        }
        const task = lastUserText(request);
        if (TASKS.includes(task)) {
          childTurnIds.push(request.turnId);
          await meeting.arrive(task);
          return { text: `finished: ${task}` };
        }
        parentTurnIds.push(request.turnId);
        // A model may only call a tool it was handed, so neither may this
        // script. Without the gate the fan-out below would happen whatever
        // `startRun` offered, and deleting `subagentToolDefinition` from it —
        // which makes the feature invisible to every real endpoint — would not
        // redden a single assertion in this file.
        if (!wasOfferedSubagent(request)) return { text: 'nothing here to delegate with' };
        return {
          text: 'fanning out',
          toolCalls: [ok('call-a', TASKS[0] ?? ''), ok('call-b', TASKS[1] ?? '')],
        };
      });

      render(<App adapter={adapter} />);
      await openConversation(user);
      parentConversationId = (await conversationIds(adapter))[0] ?? null;
      expect(parentConversationId).not.toBeNull();

      await delegate(user);
      await settled(TEST_TIMEOUT_MS - 5_000);

      // ── the offer ─────────────────────────────────────────────────────────
      // The first link, and the one the script above refuses to work around.
      // Pinned by value rather than by name: `startRun` must hand over the
      // definition `createSubagentToolkit` dispatches on and whose `task`
      // parameter `readTask` reads, not merely something called the same.
      const firstParentTurn = parentTurnIds[0] ?? '';
      expect(
        offered.get(firstParentTurn),
        'the agent run was started without `subagentToolDefinition` in its `tools`, ' +
          'so a real model would never learn that `spawn_subagent` exists',
      ).toContainEqual(subagentToolDefinition);

      // ── the concurrency claim ─────────────────────────────────────────────
      // Both halves of the pair, and in this order because `deadlocked` alone is
      // vacuously false when nothing ever arrived: it is `arrived` that says the
      // rendezvous happened, and `deadlocked` that says the detector was not
      // what ended it. Neither carries the claim without the other.
      expect([...meeting.arrived].sort()).toEqual([...TASKS].sort());
      expect(
        meeting.deadlocked,
        `a held child was released by the ${String(RENDEZVOUS_DEADLOCK_MS)}ms deadlock ` +
          'detector rather than by its sibling arriving — the two children did not overlap',
      ).toBe(false);

      // Two children, two conversations, both mid-turn at the same instant.
      expect(whileHeld.children).toHaveLength(2);
      expect(whileHeld.rows).toEqual(['assistant:streaming', 'assistant:streaming']);

      // Two runs, not one loop with two sections — and minted by
      // `createAgentRuntime`'s own `newRunId`, which spells a child
      // `${parentRunId}.${index}`. `AgentRun` names a turn `${runId}:${step}`.
      expect(new Set(childTurnIds).size).toBe(2);
      const parentRunId = (parentTurnIds[0] ?? '').split(':')[0] ?? '';
      expect(parentRunId).not.toBe('');
      for (const turnId of childTurnIds) {
        expect(turnId).toMatch(new RegExp(`^${parentRunId}\\.\\d+:\\d+$`));
        // The ceiling reached the wire, and not only the toolkit: `toolsFor`
        // strips the subagent tool from a child that is already at `maxDepth`,
        // so a child is not offered the means to delegate further. Read off the
        // request the host received, the same place the parent's offer above is
        // read from. (What each child was handed on this tree is the empty
        // catalogue, the subagent tool being the only one `startRun` offers —
        // an observation, not the assertion: the assertion is the absence.)
        expect(
          (offered.get(turnId) ?? []).map((tool) => tool.name),
          `child turn ${turnId} was offered ${SUBAGENT_TOOL_NAME} — the depth ceiling ` +
            'did not reach the request, so a child could delegate without bound',
        ).not.toContain(SUBAGENT_TOOL_NAME);
      }

      // ── the results came back as tool results, in call order ──────────────
      const parentMessages = await messagesIn(adapter, parentConversationId as string);
      expect(parentMessages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'tool',
        'assistant',
      ]);
      expect(parentMessages[2]?.parts).toEqual([
        { kind: 'toolResult', callId: 'call-a', content: `finished: ${TASKS[0] ?? ''}`, isError: false },
      ]);
      expect(parentMessages[3]?.parts).toEqual([
        { kind: 'toolResult', callId: 'call-b', content: `finished: ${TASKS[1] ?? ''}`, isError: false },
      ]);
      expect(parentMessages[4]?.status).toBe('complete');

      // …and the user sees the turn that came after the fan-out, plus the two
      // delegations that produced it. The calls reach the screen through
      // `reduceTurn`'s `toolCallDelta` arm into `TurnState.toolProgress`, which
      // `MessageTurn` hands to `ToolCalls` — a path nothing could previously
      // drive from `<App />`, because nothing could make this host emit a tool
      // call at all.
      //
      // What is deliberately *not* asserted: the status word beside each call.
      // It currently reads "Arriving" on a run that has finished, because the
      // parent's second turn overwrites `TurnState.outcomes` with its own empty
      // list while `toolProgress` accumulates across both turns — so
      // `buildToolCallViews` falls through to its progress branch. That is a
      // real defect and it is recorded rather than pinned here: a test that
      // asserted "Arriving" would make the wrong label the specification.
      const log = screen.getByRole('log');
      expect(log).toHaveTextContent('both children answered');
      expect(log).toHaveTextContent(SUBAGENT_TOOL_NAME);
      for (const task of TASKS) expect(log).toHaveTextContent(task);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'leaves each child a conversation of its own that the user can open',
    async () => {
      // The fan-out's caller of `store_create_conversation` is
      // `createAgentRuntime`'s `newConversationId` — the only *non-test*
      // caller of that command under `src/runtime/`, the qualifier this file's
      // header carries too, because `adapter-integration.test.ts` invokes the
      // command itself — and this file is where that closure
      // runs: with a counter in the adapter's command case, a full-suite run
      // (119 files, 2397 tests) reached it four times, twice in this test and
      // twice in the one above, and from nowhere else.
      //
      // It is not the product's only caller of that command, and this test
      // fires the other one first: `conversations-repository`'s `create`,
      // reached from `use-conversations.ts`'s `createConversation`, is what
      // this test's `openConversation` click runs. The same instrumented run
      // counted that caller 58 times across the suite, four of them in this
      // file — one per test. Both counts are observations of one run, and
      // both move the moment another test drives a fan-out or opens a
      // conversation.
      //
      // What it buys the user is asserted rather than assumed: a real row,
      // named, with the child's own answer in it — not a synthetic id whose
      // first append would have failed and taken the child down before its
      // first token.
      const user = userEvent.setup();
      const adapter = await host();

      adapter.seedReplyScript((request): ScriptedReply => {
        if (request.messages.some((message) => message.role === 'tool')) return { text: 'done' };
        const task = lastUserText(request);
        if (TASKS.includes(task)) return { text: `finished: ${task}` };
        // Gated on the offer for the same reason the first test's script is:
        // an ungated script here would keep this test green on a build where
        // `startRun` offers nothing, and a child conversation created for a
        // tool no model can see is not a feature.
        if (!wasOfferedSubagent(request)) return { text: 'nothing here to delegate with' };
        return {
          text: 'fanning out',
          toolCalls: [ok('call-a', TASKS[0] ?? ''), ok('call-b', TASKS[1] ?? '')],
        };
      });

      render(<App adapter={adapter} />);
      await openConversation(user);
      const parentId = (await conversationIds(adapter))[0] ?? null;

      await delegate(user);
      await settled(10_000);

      const { conversations } = await adapter.invoke('store_list_conversations', {});
      const children = conversations.filter((conversation) => conversation.id !== parentId);
      expect(children).toHaveLength(2);
      // The title is `subagentConversationTitle`'s. The read just above is
      // this test's own, direct on the adapter — fifteen call sites across six
      // test files do that, this one included. What reads it back for the
      // *user* takes the other route: `use-conversations.ts` loads the list
      // through `conversations-repository`'s `list` — the only *non-test*
      // caller of `store_list_conversations` in `src/`, the fifteen above being
      // the test ones — and `ConversationRow` renders `conversation.title` on
      // the row it draws for each one.
      expect(children.map((child) => child.title).sort()).toEqual(['Subagent 1', 'Subagent 2']);

      // Each child's own transcript holds its own answer, and only its own.
      const answers: string[] = [];
      for (const child of children) {
        const messages = await messagesIn(adapter, child.id);
        expect(messages.map((message) => message.role)).toEqual(['assistant']);
        expect(messages[0]?.status).toBe('complete');
        answers.push(textOf(messages[0]));
      }
      expect(answers.sort()).toEqual([...TASKS].map((task) => `finished: ${task}`).sort());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'answers no tool call at all when nothing scripts one',
    async () => {
      // The control for the seam itself. `seedReplyScript` is the only thing
      // that can make this fake ask for a tool; an adapter with no script must
      // behave exactly as it did before there was one, or every other test in
      // the tree is quietly being told something new.
      //
      // "Exactly as it did before" is asserted here rather than gestured at:
      // the answer's text is the echo of what the user typed. Without that one
      // line this test passes against an adapter whose unscripted answer has
      // changed, and the property this test is named for is left to whatever
      // else in the tree happens to notice. A control that does not control is
      // worse than no control, because it gets cited.
      const user = userEvent.setup();
      const adapter = await host();
      render(<App adapter={adapter} />);
      await openConversation(user);

      await delegate(user);
      await settled(10_000);

      const ids = await conversationIds(adapter);
      expect(ids).toHaveLength(1);
      const messages = await messagesIn(adapter, ids[0] ?? '');
      expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
      expect(textOf(messages[1])).toBe(PARENT_ASK);
      expect(within(screen.getByRole('log')).getAllByRole('article')).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'ends the turn cancelled, once, when the stop lands while the script is still deciding',
    async () => {
      // The state `seedReplyScript` makes reachable and nothing else in this
      // fake can produce: a turn stopped while its script is still an unsettled
      // promise, so not one frame has been scheduled for it. `#chatCancel` sets
      // a flag and emits nothing, so the single terminal event has to come from
      // `step`'s own cancelled check once the reply finally arrives — which is
      // why the script's resolution path carries no cancel branch of its own.
      //
      // Asserted on the wire rather than on the screen, because "once" is the
      // claim: a second terminal for a turn that already ended is exactly the
      // shape of defect a rendered transcript can absorb without showing it.
      const user = userEvent.setup();
      const adapter = await host();

      const terminals: ChatStreamEvent[] = [];
      const unlisten = await adapter.listen('chat:event', (envelope: ChatEventEnvelope) => {
        const { event } = envelope;
        if (event.type === 'done' || event.type === 'error') terminals.push(event);
      });

      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let deciding = false;
      adapter.seedReplyScript(async (): Promise<ScriptedReply> => {
        deciding = true;
        await held;
        return { text: AFTER_THE_STOP };
      });

      render(<App adapter={adapter} />);
      await openConversation(user);
      await delegate(user);

      // The stop has to land *inside* the script, which is the whole point, so
      // it waits for the script to be entered rather than for a frame.
      await waitFor(() => {
        expect(deciding).toBe(true);
      });
      await user.click(await screen.findByRole('button', { name: 'Stop' }));
      release();

      await settled(10_000);
      expect(terminals.map((event) => event.type)).toEqual(['error']);
      expect(terminals[0]).toEqual({ type: 'error', error: { kind: 'cancelled' } });
      // And what the script decided after the stop is not passed off as an
      // answer: a cancelled turn has no reply, on the wire or on the screen.
      expect(screen.getByRole('log')).not.toHaveTextContent(AFTER_THE_STOP);

      unlisten();
    },
    TEST_TIMEOUT_MS,
  );
});
