/**
 * The cowork surface's state: one task's plan, moved by the run that is working
 * on it, and the one place a released directive is read.
 *
 * ## The plan follows the run; the directive goes the other way, as far as it can
 *
 * This hook subscribes to the live run for the selected conversation and folds
 * its events into the plan: `turnStarted` advances, `runFinished` stops.
 *
 * Advancing is not only a fold. `advanceTo` hands back the comments that arrival
 * released, and **this hook is what reads them**: every one is passed to a
 * {@link TaskDirector} and whatever comes back is written onto the plan through
 * `recordDelivery`, where `ProgressPanel.tsx` renders it. An earlier draft
 * called `advance` for its side effect and dropped the returned array, which
 * made the user's comment an unread write with a label over it saying it had
 * been acted on.
 *
 * The director this build ships is `createUnwiredDirector`, and it answers
 * `noLiveRun` to everything — `src/features/cowork/director.ts` sets out why
 * there is no path from the renderer into a run already in flight. So in this
 * build the loop below is real, its answer is real, and the answer is that
 * nothing took the comment. That is what the panel says.
 *
 * It is a parameter with a default rather than a value constructed inside, so
 * that `use-cowork.test.tsx` can put a director in that answers something else
 * and watch what the plan does with it. Note what that does *not* buy: nothing
 * threads a director down from the composition root — `CoworkDock` calls this
 * hook with two arguments — so wiring a real one is still an edit to
 * `CoworkPanel.tsx` and `App.tsx` as well as a new implementation. The seam is
 * here; the plumbing to it is not.
 *
 * ## Why the subscription starts at the retained floor and not at 0
 *
 * `subscribe` with no `fromSeq` replays from whatever the buffer still holds,
 * and `RUN_BUFFER_MIN_EVENTS` is a floor rather than a size — a long run drops
 * its oldest events. Asking for 0 would not bring them back; it would only make
 * `replayedFrom` come back higher than asked, which this hook has no use for.
 * The plan is a fold over `turnStarted`, and a fold that starts late lands on
 * the same answer as one that starts early, because `advanceTo` takes the
 * highest step it is given and never moves backwards.
 *
 * That last clause is the load-bearing one and it is why `advanceTo` ignores a
 * step at or below the current one rather than resetting: a dropped prefix must
 * not read as a run that went backwards.
 *
 * Replay is also why the read above is safe to run from a late join: a panel
 * opened halfway through a run receives every retained event before a single
 * live one, so a comment on a step the buffer still remembers is released and
 * answered once, not once per mount — `advanceTo` releases a directive only
 * while `directiveReleased` is false, and the store holds the plan across
 * mounts.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { HarnessRuntime } from '@/platform/contract-harness';
import { planFor, useCoworkStore } from '@/state/cowork-store';
import {
  completedCount,
  isRedirectable,
  stateOf,
  undelivered,
  type Plan,
  type PlanStep,
  type RedirectRefusal,
  type StepState,
} from '@/lib/task-plan';

import { createUnwiredDirector, type TaskDirector } from './director';

/**
 * The default director: one instance, at module scope.
 *
 * Not `createUnwiredDirector()` inline in the parameter list, because that would
 * mint a new object on every render and put a value with a fresh identity into
 * the subscription effect's dependency list — a resubscribe per render, which is
 * a tail opened and dropped on every keystroke.
 */
const UNWIRED_DIRECTOR: TaskDirector = createUnwiredDirector();

export interface CoworkController {
  readonly plan: Plan;
  readonly completed: number;
  readonly total: number;
  /** Comments the run did not read, delivered-and-refused ones included. */
  readonly lost: readonly PlanStep[];
  stateOfStep: (n: number) => StepState;
  canRedirect: (n: number) => boolean;
  /** `null` when the comment was taken; a refusal the caller renders otherwise. */
  comment: (n: number, text: string) => RedirectRefusal | null;
  uncomment: (n: number) => void;
}

/**
 * Read one conversation's plan, keep it in step with the run, and hand every
 * directive the run's arrival releases to `director`.
 *
 * `runtime` is nullable so the panel can be rendered — and tested — without one.
 * A plan with no runtime is a plan nothing advances, which is exactly what a
 * user sees before they start the task, and is a state the surface has to draw
 * anyway.
 */
export function useCowork(
  runtime: HarnessRuntime | null,
  conversationId: string | null,
  director: TaskDirector = UNWIRED_DIRECTOR,
): CoworkController {
  const plans = useCoworkStore((store) => store.plans);
  const advance = useCoworkStore((store) => store.advance);
  const recordDelivery = useCoworkStore((store) => store.recordDelivery);
  const stopTask = useCoworkStore((store) => store.stopTask);
  const setComment = useCoworkStore((store) => store.comment);
  const uncommentAt = useCoworkStore((store) => store.uncomment);

  const plan = planFor(plans, conversationId);
  const hasPlan = plan.steps.length > 0;

  useEffect(() => {
    if (runtime === null || conversationId === null || !hasPlan) return;
    const handle = runtime.runs.forConversation(conversationId);
    if (handle === null) return;

    const subscription = handle.subscribe((envelope) => {
      const event = envelope.event;
      if (event.type === 'turnStarted') {
        // The read. `advance` releases the comments this arrival lets go of, and
        // each one goes to the director; the answer is written back onto the
        // plan, where the panel renders it. Discarding this array is what an
        // earlier draft did, and it is the whole defect this file was rewritten
        // to remove.
        for (const released of advance(conversationId, event.step)) {
          void director
            .deliver(conversationId, released.n, released.text)
            .then((outcome) => {
              // Deliberately not guarded by an unmount flag. The plan lives in
              // the store, not in this component, so an answer that arrives
              // after the dock closes is still an answer the user is owed the
              // next time they open it. Dropping it would put the row back to
              // "handing over" for ever.
              recordDelivery(conversationId, released.n, outcome);
            })
            .catch((error: unknown) => {
              // A director that rejects is out of contract — `deliver` answers
              // with a `DirectiveDelivery`. Recorded rather than swallowed,
              // because the alternative is a row that says "handing over" and
              // never changes, which is the silent failure this feature exists
              // to not have.
              recordDelivery(conversationId, released.n, {
                kind: 'refused',
                reason: error instanceof Error ? error.message : String(error),
              });
            });
        }
        return;
      }
      if (event.type === 'runFinished') stopTask(conversationId);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [runtime, conversationId, hasPlan, advance, recordDelivery, stopTask, director]);

  const comment = useCallback(
    (n: number, text: string): RedirectRefusal | null => {
      if (conversationId === null) return 'noSuchStep';
      const result = setComment(conversationId, n, text);
      return result.ok ? null : result.refusal;
    },
    [conversationId, setComment],
  );

  const uncomment = useCallback(
    (n: number): void => {
      if (conversationId === null) return;
      uncommentAt(conversationId, n);
    },
    [conversationId, uncommentAt],
  );

  return useMemo(
    () => ({
      plan,
      completed: completedCount(plan),
      total: plan.steps.length,
      lost: undelivered(plan),
      stateOfStep: (n: number) => stateOf(plan, n),
      canRedirect: (n: number) => isRedirectable(plan, n),
      comment,
      uncomment,
    }),
    [plan, comment, uncomment],
  );
}

/**
 * A composer for the comment box, kept out of the panel because a refusal has to
 * survive the render that produced it and `useState` in a mapped row is how that
 * gets lost.
 */
export function useCommentDraft(): {
  readonly openFor: number | null;
  readonly draft: string;
  readonly refusal: RedirectRefusal | null;
  open: (n: number) => void;
  close: () => void;
  setDraft: (text: string) => void;
  setRefusal: (refusal: RedirectRefusal | null) => void;
} {
  const [openFor, setOpenFor] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [refusal, setRefusal] = useState<RedirectRefusal | null>(null);

  return {
    openFor,
    draft,
    refusal,
    open: (n: number) => {
      setOpenFor(n);
      setDraft('');
      setRefusal(null);
    },
    close: () => {
      setOpenFor(null);
      setDraft('');
      setRefusal(null);
    },
    setDraft,
    setRefusal,
  };
}
