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
 * 33, `CoworkPanel.test.tsx` stays green at 26, `cowork-store.test.ts` stays
 * green at 16 and `director.test.ts` at 3, and 9 of the 13 tests below go red —
 * EXIT=1, `Tests  9 failed | 82 passed (91)`, reproduced twice. Four whole
 * files of assertions cannot see the defect this one file is for.
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

/**
 * A director that breaks the contract by rejecting instead of answering.
 *
 * `reason` is deliberately `unknown`: `use-cowork.ts` narrows with
 * `error instanceof Error`, and the arm that does not is the one a host bridge
 * rejecting with a bare string lands in.
 */
function rejectingDirector(reason: unknown): TaskDirector {
  return { deliver: () => Promise.reject(reason) };
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

  /**
   * THE CALLER THAT CONSTRUCTS ITS DIRECTOR INLINE, WHICH IS A CRASH IF THE
   * STORE WRITES ON A NO-OP.
   *
   * `director` is in the subscription effect's dependency list, so a director
   * minted in the render call has a new identity every render: render →
   * resubscribe → replay of the retained `turnStarted` → `advance` → store
   * write → render. The loop only closes if that `advance` writes when nothing
   * changed, and it used to: `advanceTo` returned a fresh object for an arrival
   * at a step the plan was already on. Measured against the tree this commit
   * ships, with that spelling put back — `return { plan: { ...plan },
   * directives: [] }` — this file gives EXIT=1, `Tests  2 failed | 11 passed
   * (13)`, and both reds are `Maximum update depth exceeded`: this test, and
   * the lifecycle one further down that the round after it was written to
   * catch.
   *
   * `use-cowork.ts` tells the reader to keep the default director at module
   * scope for the resubscribe cost. This is the same hazard one level up, where
   * the cost is not a cost but a hang, and the fix is in the plan algebra
   * rather than in a sentence asking callers to be careful.
   */
  it('does not loop when the caller builds a director inline on every render', async () => {
    planWithCommentOn(2, 'use staging, not prod');
    const { runtime, arriveAt } = fixture();

    renderHook(() =>
      useCowork(runtime, CONVERSATION, {
        deliver: () => Promise.resolve<DirectiveDelivery>({ kind: 'delivered' }),
      }),
    );
    arriveAt(2);
    // The second arrival at the same step is the one a replay produces, and is
    // the write that used to feed the loop.
    arriveAt(2);

    await waitFor(() => {
      expect(stepInStore(2)?.directiveOutcome).toEqual({ kind: 'delivered' });
    });
  });
});

/**
 * THE DIRECTOR THAT BREAKS ITS OWN CONTRACT.
 *
 * `TaskDirector.deliver` answers with a `DirectiveDelivery`; a real one over a
 * real host will one day throw instead — a dead IPC channel, a window closed
 * mid-await. That path is a `.catch` in `use-cowork.ts` whose own comment says
 * it exists so there is no "silent failure this feature exists to not have",
 * and for a round the comment was the only thing saying so: the handler could
 * be changed to record `{ kind: 'delivered' }` for a director that REJECTS and
 * nothing anywhere went red. Both halves of its ternary are driven here, so the
 * word over a hop that threw is a tested word.
 */
describe('a director that rejects', () => {
  it('is recorded as refused, carrying the error message, not as delivered', async () => {
    planWithCommentOn(2, 'use staging, not prod');
    const { runtime, arriveAt } = fixture();

    const director = rejectingDirector(new Error('the host went away'));

    const { result } = renderHook(() => useCowork(runtime, CONVERSATION, director));
    arriveAt(2);

    await waitFor(() => {
      expect(stepInStore(2)?.directiveOutcome).toEqual({
        kind: 'refused',
        reason: 'the host went away',
      });
    });
    // And it is reported to the user rather than sitting at "handing over" for
    // ever, which is the whole reason the rejection is recorded at all.
    expect(result.current.lost.map((step) => step.directive)).toEqual(['use staging, not prod']);
  });

  it('carries a rejection that is not an Error through as its own text', async () => {
    planWithCommentOn(2, 'use staging, not prod');
    const { runtime, arriveAt } = fixture();

    // A rejected promise carrying a string is what a `postMessage` bridge and a
    // good deal of host code actually throw. `String(error)` is the other half
    // of the handler's ternary and it prints in the panel verbatim.
    const director = rejectingDirector('the socket closed');

    renderHook(() => useCowork(runtime, CONVERSATION, director));
    arriveAt(2);

    await waitFor(() => {
      expect(stepInStore(2)?.directiveOutcome).toEqual({
        kind: 'refused',
        reason: 'the socket closed',
      });
    });
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

  /**
   * THE SAME HAZARD ON THE LIFECYCLE EVERY REAL RUN HAS.
   *
   * The test above drives a repeated arrival, which is one way a replay hands
   * `advanceTo` a step behind the cursor. This is the other, and it is the
   * ordinary one: a run starts a turn, the run finishes, and every resubscribe
   * replays `turnStarted` *after* `runFinished`. If that replayed arrival
   * promotes the stopped plan back to `running`, the `runFinished` behind it
   * stops it again, and the two writes alternate — with an inline director each
   * write is a resubscribe and the alternation never ends.
   *
   * Measured against the tree this commit ships, with the promotion put back —
   * `advanceTo`'s no-op branch spelled `if (plan.state === 'running') return
   * { plan, directives: [] }; return { plan: { ...plan, state: 'running' },
   * directives: [] };` — this file gives EXIT=1, `Tests  1 failed | 12 passed
   * (13)`, the single red is this test, and the message is React's
   * `Maximum update depth exceeded`. Reproduced twice.
   */
  it('leaves a finished task stopped when the run replays its last turn', async () => {
    useCoworkStore.getState().setPlan(CONVERSATION, PLAN);
    const { runtime, emit, arriveAt } = fixture();

    renderHook(() =>
      useCowork(runtime, CONVERSATION, {
        deliver: () => Promise.resolve<DirectiveDelivery>({ kind: 'delivered' }),
      }),
    );
    arriveAt(2);
    emit({ type: 'runFinished', outcome: { type: 'cancelled' } });

    await waitFor(() => {
      expect(useCoworkStore.getState().plans[CONVERSATION]?.state).toBe('stopped');
    });
    expect(useCoworkStore.getState().plans[CONVERSATION]?.currentStep).toBe(2);
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
