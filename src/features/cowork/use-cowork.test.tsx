/**
 * THE HOP THE WHOLE FEATURE IS FOR, DRIVEN.
 *
 * `src/lib/task-plan.test.ts` proves the plan algebra and
 * `CoworkPanel.test.tsx` proves what the surface draws. Between them sat the
 * only thing that makes a comment a redirect rather than a note to nobody: a
 * caller that actually **reads** what `advanceTo` releases. Nothing tested that.
 * An earlier build called `advance` for its side effect and threw the returned
 * array away — the store moved, the panel drew, and the user's words went
 * nowhere.
 *
 * Measured against the tree this commit ships, by putting that mistake back:
 * with the released array discarded, `src/lib/task-plan.test.ts` stays green at
 * 26 and `CoworkPanel.test.tsx` stays green at 21, and 6 of the 9 tests below go
 * red. Reproduced twice. Two whole files of assertions cannot see the defect
 * this one file is for.
 *
 * So this file drives the read end to end: a real `LiveRuns` directory over a
 * hand-driven harness, `turnStarted` emitted into it, and a `TaskDirector`
 * standing where the host would be.
 *
 * ## What is real and what is a double
 *
 * The run directory is real — `createHarnessRuntime` over `createManualHarness`,
 * so sequencing, buffering and `forConversation` are the shipping code and not a
 * fake with the same shape. The model is not: the harness emits only what a test
 * tells it to, which is the point, since the event under test is `turnStarted`
 * and nothing else.
 *
 * The director is a double in the tests that need a specific answer, and is the
 * **shipped** `createUnwiredDirector` in the last one, which is the test that
 * says what this build actually does to a user's comment.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { createTranscriptRepository } from '@/data/transcript-repository';
import { BrowserAdapter } from '@/platform/browser-adapter';
import type { HarnessRuntime, RunEvent, RunId } from '@/platform/contract-harness';
import type { DirectiveDelivery } from '@/lib/task-plan';
import { createHarnessRuntime } from '@/runtime/harness-runtime';
import { FakeTurnDriver, createManualHarness, runRequest } from '@/runtime/run-doubles';
import { resetCoworkStore, useCoworkStore } from '@/state/cowork-store';

import type { TaskDirector } from './director';
import { useCowork } from './use-cowork';

const CONVERSATION = 'conversation-alpha';
const RUN: RunId = 'run-alpha';
const PLAN = ['Read the brief', 'Draft the migration', 'Run the suite', 'Write it up'];

interface Fixture {
  readonly runtime: HarnessRuntime;
  /** Emit one event into the live run, as its harness would. */
  emit: (event: RunEvent) => void;
  /** Emit `turnStarted` for `step`. */
  arriveAt: (step: number) => void;
}

function fixture(): Fixture {
  const manual = createManualHarness('manual');
  const runtime = createHarnessRuntime({
    turns: new FakeTurnDriver(),
    transcript: createTranscriptRepository(new BrowserAdapter()),
    toolsFor: () => ({ execute: () => Promise.reject(new Error('no tools in this test')) }),
    readProjectInstructions: (): Promise<string | null> => Promise.resolve(null),
    definitions: [manual.definition],
    now: () => 0,
  });
  const start = runtime.runs.start(
    runRequest({ runId: RUN, conversationId: CONVERSATION, harnessId: 'manual' }),
  );
  if (start.outcome !== 'started') throw new Error(`the directory rejected the run: ${start.reason}`);
  const emit = (event: RunEvent): void => {
    act(() => {
      manual.emitTo(RUN, event);
    });
  };
  return {
    runtime,
    emit,
    arriveAt: (step: number) => {
      emit({ type: 'turnStarted', turnId: `turn-${step}`, step, model: 'primary' });
    },
  };
}

/** A director that answers what a test tells it to, and remembers what it was asked. */
function watchedDirector(answer: DirectiveDelivery): {
  readonly director: TaskDirector;
  readonly asked: { conversationId: string; step: number; directive: string }[];
} {
  const asked: { conversationId: string; step: number; directive: string }[] = [];
  return {
    asked,
    director: {
      deliver: (conversationId, step, directive) => {
        asked.push({ conversationId, step, directive });
        return Promise.resolve(answer);
      },
    },
  };
}

/** A plan on the selected conversation with a comment waiting on `step`. */
function planWithCommentOn(step: number, text: string): void {
  useCoworkStore.getState().setPlan(CONVERSATION, PLAN);
  const accepted = useCoworkStore.getState().comment(CONVERSATION, step, text);
  if (!accepted.ok) throw new Error(`the fixture comment was refused: ${accepted.refusal}`);
}

function stepInStore(n: number) {
  return useCoworkStore.getState().plans[CONVERSATION]?.steps[n - 1];
}

beforeEach(() => {
  resetCoworkStore();
});

describe('a released directive is read, not dropped', () => {
  it('hands the comment to the director when the run arrives at its step', async () => {
    planWithCommentOn(2, 'use staging, not prod');
    const { runtime, arriveAt } = fixture();
    const { director, asked } = watchedDirector({ kind: 'delivered' });

    renderHook(() => useCowork(runtime, CONVERSATION, director));
    arriveAt(2);

    // The assertion the whole feature rests on. Nothing else in this repo fails
    // if the hook throws the released array away.
    await waitFor(() => {
      expect(asked).toEqual([
        { conversationId: CONVERSATION, step: 2, directive: 'use staging, not prod' },
      ]);
    });
  });

  it('asks nothing when the arriving step carries no comment', async () => {
    planWithCommentOn(4, 'and mention the caveat');
    const { runtime, arriveAt } = fixture();
    const { director, asked } = watchedDirector({ kind: 'delivered' });

    renderHook(() => useCowork(runtime, CONVERSATION, director));
    arriveAt(2);

    await waitFor(() => {
      expect(useCoworkStore.getState().plans[CONVERSATION]?.currentStep).toBe(2);
    });
    // The plan moved; the comment on step 4 is still waiting, so the seam was
    // not touched. A hook that delivered on every turn would be handing the
    // model instructions for work it has not started.
    expect(asked).toEqual([]);
  });

  it('writes the answer back onto the plan, where the panel reads it', async () => {
    planWithCommentOn(2, 'use staging, not prod');
    const { runtime, arriveAt } = fixture();
    const { director } = watchedDirector({ kind: 'delivered' });

    renderHook(() => useCowork(runtime, CONVERSATION, director));
    arriveAt(2);

    await waitFor(() => {
      expect(stepInStore(2)?.directiveOutcome).toEqual({ kind: 'delivered' });
    });
  });

  it('records a refusal as a refusal, and reports it as never read', async () => {
    planWithCommentOn(2, 'use staging, not prod');
    const { runtime, arriveAt } = fixture();
    const { director } = watchedDirector({ kind: 'tooLate' });

    const { result } = renderHook(() => useCowork(runtime, CONVERSATION, director));
    arriveAt(2);

    await waitFor(() => {
      expect(stepInStore(2)?.directiveOutcome).toEqual({ kind: 'tooLate' });
    });
    // The task is still running. A report that only spoke for stopped tasks
    // would say nothing here, which is the case the old shape could not reach.
    expect(useCoworkStore.getState().plans[CONVERSATION]?.state).toBe('running');
    expect(result.current.lost.map((step) => step.directive)).toEqual(['use staging, not prod']);
  });

  it('releases a comment on a step the run jumped, and still asks about it', async () => {
    planWithCommentOn(2, 'mind the index');
    const { runtime, arriveAt } = fixture();
    const { director, asked } = watchedDirector({ kind: 'delivered' });

    renderHook(() => useCowork(runtime, CONVERSATION, director));
    // The run goes straight to 3. Step 2 is never the arriving step.
    arriveAt(3);

    await waitFor(() => {
      expect(asked.map((each) => each.step)).toEqual([2]);
    });
  });

  it('asks once, not once per turn, when a harness re-emits the same step', async () => {
    planWithCommentOn(2, 'use staging, not prod');
    const { runtime, arriveAt } = fixture();
    const { director, asked } = watchedDirector({ kind: 'delivered' });

    renderHook(() => useCowork(runtime, CONVERSATION, director));
    arriveAt(2);
    await waitFor(() => {
      expect(asked).toHaveLength(1);
    });
    arriveAt(2);
    arriveAt(3);

    await waitFor(() => {
      expect(useCoworkStore.getState().plans[CONVERSATION]?.currentStep).toBe(3);
    });
    // Handing the model the same instruction twice is worse than not handing it
    // over at all: the user wrote it once.
    expect(asked).toHaveLength(1);
  });
});

/**
 * WHAT THIS BUILD ACTUALLY DOES TO A USER'S COMMENT.
 *
 * No director argument, so the hook uses the one it ships with —
 * `createUnwiredDirector`, which answers `noLiveRun` because
 * `src/features/cowork/director.ts` has no host behind it. The comment is read,
 * carried to the seam, answered honestly, and reported to the user as never
 * read. That is the truth about this build and it is what the surface says.
 */
describe('the director this build ships', () => {
  it('answers that nothing took the comment, and the plan says so', async () => {
    planWithCommentOn(2, 'use staging, not prod');
    const { runtime, arriveAt } = fixture();

    const { result } = renderHook(() => useCowork(runtime, CONVERSATION));
    arriveAt(2);

    await waitFor(() => {
      expect(stepInStore(2)?.directiveOutcome).toEqual({ kind: 'noLiveRun' });
    });
    expect(result.current.lost.map((step) => step.directive)).toEqual(['use staging, not prod']);
  });
});

describe('the plan follows the run', () => {
  it('stops the task when the run finishes', async () => {
    useCoworkStore.getState().setPlan(CONVERSATION, PLAN);
    const { runtime, emit, arriveAt } = fixture();
    expect(runtime.runs.forConversation(CONVERSATION)?.runId).toBe(RUN);

    renderHook(() => useCowork(runtime, CONVERSATION));
    arriveAt(2);
    emit({ type: 'runFinished', outcome: { type: 'cancelled' } });

    await waitFor(() => {
      expect(useCoworkStore.getState().plans[CONVERSATION]?.state).toBe('stopped');
    });
  });

  it('reports a comment the run stopped short of, once it has stopped', async () => {
    planWithCommentOn(4, 'and mention the caveat');
    const { runtime, emit, arriveAt } = fixture();

    const { result } = renderHook(() => useCowork(runtime, CONVERSATION));
    arriveAt(2);
    emit({ type: 'runFinished', outcome: { type: 'cancelled' } });

    await waitFor(() => {
      expect(result.current.lost.map((step) => step.directive)).toEqual([
        'and mention the caveat',
      ]);
    });
    // Never released, so nothing was ever asked about it — a different reason
    // from the one the shipped director gives, and the panel prints both.
    expect(stepInStore(4)?.directiveReleased).toBe(false);
    expect(stepInStore(4)?.directiveOutcome).toBeNull();
  });
});
