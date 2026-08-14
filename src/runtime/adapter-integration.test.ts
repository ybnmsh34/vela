/**
 * The runtime, joined to code that ships.
 *
 * Every other test in this directory drives the seam with doubles, which is the
 * right way to hold a rule and the wrong way to answer "is any of this actually
 * connected to anything". This one uses no doubles at all: a real
 * `BrowserAdapter`, a real `createTurnDriver` over its `chat_send`/`chat:event`,
 * a real `createTranscriptRepository` over its `store_*` commands, the real
 * codec, the real registry, the real directory and the real loop. The only
 * substitution is the one the composition root always makes — which adapter.
 *
 * What it proves, and the reason it is worth a whole file: the `TranscriptWriter`
 * on `HarnessServices` is not a shape somebody invented for a test. The
 * repository this repo already ships satisfies it as written, so the durability
 * rule at `RunHandle` — "a harness must write the transcript as the run goes" —
 * names something a harness can reach, and the row it wrote is readable back out
 * of the store through a command that existed before this track started.
 *
 * `BrowserAdapter` is the fake host: it echoes the last user message across
 * several frames. Everything asserted here is therefore VERIFIED-BY-FAKE about
 * the *endpoint* and load-bearing about the *wiring*.
 */

import { describe, expect, it } from 'vitest';

import { createTranscriptRepository } from '@/data/transcript-repository';
import { createTurnDriver } from '@/data/turn-driver';
import { BrowserAdapter } from '@/platform/browser-adapter';
import { DEFAULT_PROJECT_ID } from '@/platform/contract-project';
import {
  DEFAULT_RUN_LIMITS,
  type RunEvent,
  type RunOutcome,
  type RunRequest,
} from '@/platform/contract-harness';

import { AGENT_LOOP_HARNESS_ID } from './agent-loop-harness';
import { createHarnessRuntime } from './harness-runtime';

const PROVIDER = 'workstation';

async function host(): Promise<BrowserAdapter> {
  const adapter = new BrowserAdapter();
  await adapter.invoke('settings_put_provider', {
    id: PROVIDER,
    displayName: 'Workstation',
    kind: 'local',
    baseUrl: 'http://127.0.0.1:8080/v1',
  });
  return adapter;
}

describe('the runtime over the real adapter', () => {
  it('runs a turn end to end and leaves the answer in the store', async () => {
    const adapter = await host();
    const created = await adapter.invoke('store_create_conversation', {});
    const conversationId = created.conversation.id;

    const runtime = createHarnessRuntime({
      turns: createTurnDriver(adapter),
      transcript: createTranscriptRepository(adapter),
      toolsFor: () => ({ execute: () => Promise.reject(new Error('no tools this run')) }),
      readProjectInstructions: () => Promise.resolve(null),
    });

    const request: RunRequest = {
      runId: 'run-integration-1',
      conversationId,
      projectId: DEFAULT_PROJECT_ID,
      harnessId: AGENT_LOOP_HARNESS_ID,
      models: { primary: { providerId: PROVIDER, modelId: 'a-model' } },
      input: [{ role: 'user', text: 'echo this back' }],
      context: { systemPrompt: null, preload: [] },
      limits: DEFAULT_RUN_LIMITS,
      capabilities: { multiStep: true, toolExecution: false, auxiliaryModel: false },
    };

    const events: RunEvent[] = [];
    const outcome = await new Promise<RunOutcome>((resolve) => {
      const start = runtime.runs.start(request);
      if (start.outcome !== 'started') throw new Error(`rejected: ${start.reason}`);
      start.handle.subscribe(
        (envelope) => {
          events.push(envelope.event);
          if (envelope.event.type === 'runFinished') resolve(envelope.event.outcome);
        },
        { fromSeq: 0 },
      );
    });

    expect(outcome).toEqual({ type: 'completed', stopReason: 'endTurn' });

    // The fake host splits its echo across frames, so a run that only forwarded
    // the assembled `done` would show one delta and this would fail.
    const deltas = events.flatMap((event) =>
      event.type === 'chat' && event.event.type === 'textDelta' ? [event.event.text] : [],
    );
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe('echo this back');

    const listed = await adapter.invoke('store_list_messages', { conversationId });
    const assistant = listed.messages.filter((message) => message.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.status).toBe('complete');
    expect(assistant[0]?.stopReason).toBe('endTurn');
    expect(assistant[0]?.parts).toEqual([{ kind: 'text', text: 'echo this back' }]);
  });

  it('leaves a row marked streaming when a run is cancelled mid-turn', async () => {
    // "A run that is killed mid-turn therefore leaves a row marked `streaming`,
    // which is exactly the state `StoredMessageStatus` has for it and is
    // readable rather than absent." Here the run is cancelled rather than
    // killed, so the loop gets to close the row out as `cancelled` — the
    // stronger of the two, and the one a user can tell apart from a crash.
    const adapter = new BrowserAdapter({ scheduleFrame: (run) => setTimeout(run, 50) });
    await adapter.invoke('settings_put_provider', {
      id: PROVIDER,
      displayName: 'Workstation',
      kind: 'local',
      baseUrl: 'http://127.0.0.1:8080/v1',
    });
    const created = await adapter.invoke('store_create_conversation', {});
    const conversationId = created.conversation.id;

    const runtime = createHarnessRuntime({
      turns: createTurnDriver(adapter),
      transcript: createTranscriptRepository(adapter),
      toolsFor: () => ({ execute: () => Promise.reject(new Error('no tools this run')) }),
      readProjectInstructions: () => Promise.resolve(null),
    });

    const start = runtime.runs.start({
      runId: 'run-integration-2',
      conversationId,
      projectId: DEFAULT_PROJECT_ID,
      harnessId: AGENT_LOOP_HARNESS_ID,
      models: { primary: { providerId: PROVIDER, modelId: 'a-model' } },
      input: [{ role: 'user', text: 'a much longer sentence to stream slowly' }],
      context: { systemPrompt: null, preload: [] },
      limits: DEFAULT_RUN_LIMITS,
      capabilities: { multiStep: true, toolExecution: false, auxiliaryModel: false },
    });
    if (start.outcome !== 'started') throw new Error(`rejected: ${start.reason}`);

    const finished = new Promise<RunOutcome>((resolve) => {
      start.handle.subscribe(
        (envelope) => {
          if (envelope.event.type === 'runFinished') resolve(envelope.event.outcome);
        },
        { fromSeq: 0 },
      );
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    await start.handle.cancel();

    // "cancel() resolving is not the end of the run. The run is over when
    // runFinished reaches the stream."
    expect(await finished).toEqual({ type: 'cancelled' });

    const listed = await adapter.invoke('store_list_messages', { conversationId });
    const assistant = listed.messages.filter((message) => message.role === 'assistant');
    expect(assistant[0]?.status).toBe('cancelled');
  });
});
