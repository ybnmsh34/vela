/**
 * `mergeRunCapabilities` — the one piece of executable code inside the frozen
 * contract, and the one that had no test of its own.
 *
 * `contract-harness.ts` ships it rather than describing it, for the reason it
 * gives: the caller computes the merge **once** so that two harnesses cannot
 * disagree about what the same model can do. The rule it encodes is stated in
 * three sentences and the file's own header admits that `pnpm typecheck` holds
 * the shape and nothing holds the sentences:
 *
 *  - `multiStep` is the harness's alone — no model flag speaks to whether a loop
 *    may go round twice;
 *  - `toolExecution` needs both flags;
 *  - `auxiliaryModel` needs the harness flag **and** a target actually assigned.
 *
 * "The merge is AND, never OR." Both `&&` can be flipped to `||` and every test
 * in this repo still passes, which is what these are for. With OR, a run claims
 * a fan-out against a model that cannot request a tool, and claims an auxiliary
 * slot that was never assigned — the reduction the user cannot see that
 * conventions §9.6 calls the one forbidden outcome.
 *
 * Where the merge's answer has a consequence the loop can show, these drive the
 * real loop over a fake `TurnDriver` and read what it did. Where it does not —
 * `auxiliaryModel` has no producer in either shipped harness — the assertion is
 * on the flag the settings slot is gated on, and says so.
 */

import { describe, expect, it } from 'vitest';

import { NO_CAPABILITIES, type ChatCapabilities } from '@/platform/contract';
import {
  mergeRunCapabilities,
  type HarnessCapabilities,
  type RunCapabilities,
  type RunEvent,
  type RunOutcome,
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
  toolCall,
} from './run-doubles';

interface Driven {
  readonly outcome: RunOutcome;
  readonly events: readonly RunEvent[];
  /** The name of every tool the run actually executed, in order. */
  readonly executed: readonly string[];
  readonly turnsSent: number;
}

/**
 * One run of the shipped agent loop, whose model asks for a tool on its first
 * turn and answers plainly afterwards.
 *
 * The tool executor records rather than refusing: a run that must not execute
 * has to be shown *not* executing, and an executor that throws would report the
 * same failure as a loop that crashed for another reason.
 */
async function drive(capabilities: RunCapabilities): Promise<Driven> {
  const turns = new FakeTurnDriver();
  turns.script((request, driver) => {
    driver.emit(request.turnId, {
      type: 'done',
      response: chatResponse({
        parts: [{ kind: 'toolCall', callId: 'c1', name: 'alpha', arguments: {} }],
        toolCalls: [toolCall('c1', 'alpha', {})],
        stopReason: 'toolUse',
      }),
    });
  });
  turns.always((request, driver) => {
    driver.emit(request.turnId, {
      type: 'done',
      response: chatResponse({ parts: [{ kind: 'text', text: 'done' }] }),
    });
  });

  const executed: string[] = [];
  const registry = createHarnessRegistry([agentLoopHarness, singleTurnHarness]);
  const runs = createLiveRuns(registry, () => ({
    turns,
    tools: {
      execute: (call) => {
        executed.push(call.name);
        return Promise.resolve({
          kind: 'toolResult' as const,
          callId: call.callId,
          content: 'ok',
          isError: false,
        });
      },
    },
    context: { index: () => Promise.resolve([]), load: () => Promise.resolve(null) },
    transcript: recordingTranscript().writer,
    parts: contentPartCodec,
    now: () => 0,
  }));

  const events: RunEvent[] = [];
  const start = runs.start(runRequest({ capabilities }));
  if (start.outcome !== 'started') throw new Error(`rejected: ${start.reason}`);
  const outcome = await new Promise<RunOutcome>((resolve) => {
    start.handle.subscribe(
      (envelope) => {
        events.push(envelope.event);
        if (envelope.event.type === 'runFinished') resolve(envelope.event.outcome);
      },
      { fromSeq: 0 },
    );
  });

  return { outcome, events, executed, turnsSent: turns.sent.length };
}

/** What a run announced it could do, off `runStarted`. */
function announced(events: readonly RunEvent[]): RunCapabilities {
  const first = events[0];
  if (first === undefined || first.type !== 'runStarted') {
    throw new Error('the run did not open with runStarted');
  }
  return first.capabilities;
}

const AUXILIARY_HARNESS: HarnessCapabilities = {
  multiStep: true,
  toolExecution: true,
  auxiliaryModel: true,
};

const TOOL_CALLING_MODEL: ChatCapabilities = { ...NO_CAPABILITIES, toolCalls: true };

/* -------------------------------------------------------------------------- */

describe('the capability merge is AND, never OR', () => {
  it('runs no tool for a model that cannot request one, whatever the harness can do', async () => {
    // The shipped tool-executing harness in front of an unprobed model — every
    // model flag `false`, which is `NO_CAPABILITIES` and the ordinary state
    // before a capability probe. "A harness that runs tools against a model that
    // cannot request them offers nothing."
    const merged = mergeRunCapabilities(
      agentLoopHarness.descriptor.capabilities,
      NO_CAPABILITIES,
      false,
    );

    // The consequence first, so a failure names what the run did rather than
    // what a boolean was. The model asked for `alpha` anyway — the calls stand
    // on the stream as evidence — and nothing ran it. With OR this run executes
    // a tool against a model the host has never seen request one, and claims a
    // fan-out it cannot produce.
    const run = await drive(merged);
    expect(
      run.executed,
      'a run may not execute a tool for a model that cannot request one',
    ).toEqual([]);
    expect(run.turnsSent).toBe(1);
    expect(run.outcome).toEqual({ type: 'completed', stopReason: 'toolUse' });
    expect(merged.toolExecution).toBe(false);
    expect(announced(run.events).toolExecution).toBe(false);
  });

  it('runs the tool when both flags are true, so the check above is not vacuous', async () => {
    const merged = mergeRunCapabilities(
      agentLoopHarness.descriptor.capabilities,
      TOOL_CALLING_MODEL,
      false,
    );
    expect(merged.toolExecution).toBe(true);

    const run = await drive(merged);
    expect(run.executed).toEqual(['alpha']);
    expect(run.turnsSent).toBe(2);
  });

  it('never claims an auxiliary model that was not assigned', () => {
    // No shipped harness has an internal step, so this flag has no producer to
    // drive: `agent-loop-harness.ts` says so where it declines to emit
    // `auxiliaryModelUnavailable`. What the flag does have is a consumer — it
    // gates the second model slot — so the assertion is on the answer itself.
    //
    // With OR, `auxiliaryModel` comes out `true` with no `models.auxiliary` on
    // the request, and a harness with internal steps then sends to a slot that
    // was never assigned, or quietly spends the primary model without emitting
    // the degradation that would let the user see it.
    expect(mergeRunCapabilities(AUXILIARY_HARNESS, TOOL_CALLING_MODEL, false).auxiliaryModel).toBe(
      false,
    );
    expect(mergeRunCapabilities(AUXILIARY_HARNESS, TOOL_CALLING_MODEL, true).auxiliaryModel).toBe(
      true,
    );
    // A target assigned to a harness that has no second step is still nothing:
    // the flag is the harness's to claim first. Both shipped harnesses are here.
    expect(
      mergeRunCapabilities(agentLoopHarness.descriptor.capabilities, TOOL_CALLING_MODEL, true)
        .auxiliaryModel,
    ).toBe(false);
    expect(
      mergeRunCapabilities(singleTurnHarness.descriptor.capabilities, TOOL_CALLING_MODEL, true)
        .auxiliaryModel,
    ).toBe(false);
  });

  it('announces to the run the auxiliary answer the merge gave, not a re-derived one', async () => {
    // The one place the flag reaches a caller: `runStarted` carries the
    // capabilities the request was built with, and the harness is forbidden from
    // re-deriving them.
    const merged = mergeRunCapabilities(AUXILIARY_HARNESS, TOOL_CALLING_MODEL, false);
    const run = await drive(merged);
    expect(announced(run.events)).toEqual({
      multiStep: true,
      toolExecution: true,
      auxiliaryModel: false,
    });
  });

  it('leaves multiStep to the harness — the model has no say in it', () => {
    // Asserted on the merge rather than through the loop, deliberately. With
    // every model flag `false` there is nothing for a second turn to be about:
    // the model can request no tool, so the loop ends after turn 1 whatever this
    // flag says, and a run that took one turn would prove nothing about it.
    // The next test drives the flag itself.
    expect(
      mergeRunCapabilities(agentLoopHarness.descriptor.capabilities, NO_CAPABILITIES, false)
        .multiStep,
    ).toBe(true);
    expect(
      mergeRunCapabilities(singleTurnHarness.descriptor.capabilities, TOOL_CALLING_MODEL, false)
        .multiStep,
    ).toBe(false);
  });

  it('stops the loop after one turn when multiStep is false', async () => {
    // The flag with teeth: two runs differing in nothing but `multiStep`, over a
    // model that does request a tool. "`false` means one turn and done."
    const both = mergeRunCapabilities(
      agentLoopHarness.descriptor.capabilities,
      TOOL_CALLING_MODEL,
      false,
    );
    const single: RunCapabilities = { ...both, multiStep: false };

    expect((await drive(both)).turnsSent).toBe(2);
    expect((await drive(single)).turnsSent).toBe(1);
  });
});
