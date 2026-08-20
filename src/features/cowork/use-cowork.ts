/**
 * The cowork surface's state: one task's plan, moved by the run that is working
 * on it.
 *
 * ## The plan follows the run; the run is never told what the plan says
 *
 * This hook subscribes to the live run for the selected conversation and folds
 * its events into the plan: `turnStarted` advances, `runFinished` stops. It is a
 * one-way read, and that is deliberate — `src/features/cowork/director.ts`
 * records why the other direction does not exist yet.
 *
 * The subscription is `LiveRuns.forConversation`, which
 * `src/platform/contract-harness.ts` describes as "the in-flight check a
 * conversation view makes on mount, before subscribing". Replay is why this
 * works at all: a panel opened halfway through a run receives every event from
 * the retained floor before a single live one, so the plan lands on the step the
 * run is actually on rather than on whatever happened next.
 *
 * ## Why it subscribes from the retained floor and not from 0
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

export interface CoworkController {
  readonly plan: Plan;
  readonly completed: number;
  readonly total: number;
  /** Comments the run never read. Empty unless the task has stopped. */
  readonly lost: readonly PlanStep[];
  stateOfStep: (n: number) => StepState;
  canRedirect: (n: number) => boolean;
  /** `null` when the comment was taken; a refusal the caller renders otherwise. */
  comment: (n: number, text: string) => RedirectRefusal | null;
  uncomment: (n: number) => void;
}

/**
 * Read one conversation's plan and keep it in step with the run.
 *
 * `runtime` is nullable so the panel can be rendered — and tested — without one.
 * A plan with no runtime is a plan nothing advances, which is exactly what a
 * user sees before they start the task, and is a state the surface has to draw
 * anyway.
 */
export function useCowork(
  runtime: HarnessRuntime | null,
  conversationId: string | null,
): CoworkController {
  const plans = useCoworkStore((store) => store.plans);
  const advance = useCoworkStore((store) => store.advance);
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
        // The directives this arrival delivers come back here. Nothing in this
        // build can put them in front of the model — see `director.ts` — so they
        // are not silently dropped either: `advanceTo` has already marked them
        // delivered on the plan, which is what `ProgressPanel` renders. When a
        // `TaskDirector` exists, this is its one call site.
        advance(conversationId, event.step);
        return;
      }
      if (event.type === 'runFinished') stopTask(conversationId);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [runtime, conversationId, hasPlan, advance, stopTask]);

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
