/**
 * A TASK'S PLAN — the numbered steps, and the comment that redirects the run.
 *
 * Pure. No React, no store, no IPC. Everything here is a value in and a value
 * out, because the one rule this file exists to hold is a rule about *when a
 * write will still be read*, and that is exactly the kind of rule that rots
 * when it is spread across a component and a hook.
 *
 * ## The step number is the run's, not ours
 *
 * `PlanStep.n` is 1-based and is the same number `RunEvent`'s `turnStarted`
 * carries: `src/platform/contract-harness.ts` says "1-based. `step` 1 is the
 * first model turn of the run." {@link Plan.currentStep} is therefore `0` for a
 * plan whose run has not opened a turn yet — the same seed `createLiveRuns` in
 * `src/runtime/live-runs.ts` gives `RunStatus` (`{ type: 'running', step: 0 }`)
 * — and a second numbering scheme here would be a second answer to which step
 * is running.
 *
 * ## Arrival releases a directive. It does not deliver it.
 *
 * These are two events, and an earlier draft of this file collapsed them into
 * one boolean — which made the panel print "Redirected" over a comment no model
 * had seen. {@link advanceTo} *releases*: it hands the arriving step's comment
 * to its caller and records that it will not hand that one out again. What
 * became of it afterwards is a separate fact, written back by
 * {@link recordDelivery} and carried by {@link PlanStep.directiveOutcome}. Only
 * a {@link DirectiveDelivery} of kind `delivered` means a run took it.
 *
 * The distinction is the whole honesty of the surface. `directiveOutcome` is
 * `null` between the release and the answer, and a plan in that state says
 * "handing over", never "redirected".
 *
 * ## The guard, and the narrower question it is deliberately not asking
 *
 * A comment on an upcoming step redirects the task. The obvious guard is "is
 * this step still in the future", spelled `n >= currentStep`, and it is wrong by
 * exactly one. A directive is released by {@link advanceTo}, which fires when
 * the plan *arrives at* a step. The plan never arrives at the step it is already
 * on. So a comment attached to `currentStep` passes an `n >= currentStep` guard,
 * is stored, is rendered, and is **never read by anything** — an unread write,
 * which is the defect class this repo keeps finding, wearing a validation.
 *
 * {@link redirect} therefore refuses `n <= currentStep`, and
 * `task-plan.test.ts` pins the `n === currentStep` boundary specifically, because
 * that single case is the whole difference between the two guards.
 *
 * ## The second reader, and why {@link undelivered} exists
 *
 * Refusing the un-deliverable at write time is not enough. Two more ways exist
 * to end up with a comment nothing read, and neither is knowable when the
 * comment is written: the run can stop before reaching the step, and the hop
 * that puts a released directive in front of a model can answer that it did not
 * take it. So the answer is to make both **visible** rather than silent:
 * {@link undelivered} names every directive the run demonstrably did not read,
 * whichever of the two it was, and `ProgressPanel.tsx` renders each with its
 * reason. A comment the run never got is a thing the user must be told about,
 * not a row that quietly looks like the ones that landed.
 */

/** Where a step sits relative to the run. */
export type StepState = 'done' | 'current' | 'ahead';

/** Why {@link redirect} would not take a comment. */
export type RedirectRefusal =
  /** No step carries that number. */
  | 'noSuchStep'
  /**
   * The run is on this step or has passed it. Nothing will arrive at it again,
   * so nothing would ever read the comment. See the header.
   *
   * Only ever answered about a task that is still going. A stopped task answers
   * `taskHasStopped` instead — including for a step strictly ahead of
   * where the run got to, because telling a user the run "already reached" step
   * 4 of a task that died on step 2 is a false sentence about their own task.
   */
  | 'stepIsNotAhead'
  /** The task is over. No step will arrive, ahead of the run or not. */
  | 'taskHasStopped'
  /** The comment was blank once trimmed. A blank redirect is not a redirect. */
  | 'emptyComment';

/**
 * What became of one directive that was put in front of a run.
 *
 * Defined here rather than beside `TaskDirector` in
 * `src/features/cowork/director.ts` because {@link PlanStep} has to carry it and
 * this file imports nothing — a plan that had to reach into a feature to say
 * what happened to a comment would invert the layering. `director.ts`
 * re-exports this name, so there is one definition and not two that can drift.
 */
export type DirectiveDelivery =
  /** The run took it and the model will see it on the step it was written for. */
  | { readonly kind: 'delivered' }
  /**
   * The run had already moved past the step. Not an error and not a success: the
   * user's words exist and the model did not get them, and a caller that treated
   * this as either would be wrong in a way the user cannot see.
   */
  | { readonly kind: 'tooLate' }
  /** No run is live for that conversation, so nothing took it. */
  | { readonly kind: 'noLiveRun' }
  /** The run refused it. `reason` is the host's, rendered verbatim. */
  | { readonly kind: 'refused'; readonly reason: string };

export interface PlanStep {
  /** 1-based, and the same number `turnStarted.step` carries. */
  readonly n: number;
  readonly title: string;
  /**
   * The user's comment on this step, if they have left one, as they typed it
   * (trimmed). `null` is "no comment"; there is no second empty value, for the
   * reason `ProjectView.instructions` gives for `''` being the only spelling of
   * none.
   */
  readonly directive: string | null;
  /**
   * `true` once {@link advanceTo} has handed this step's directive to its
   * caller. It says the plan let go of it and **nothing more** — not that a
   * model saw it. It exists so that the same comment is not handed out twice
   * when a harness re-emits `turnStarted` for a step.
   *
   * {@link directive} is kept rather than cleared, because the panel shows the
   * user what they said after it has been acted on — a comment that vanishes at
   * the moment it takes effect looks exactly like a comment that was dropped.
   */
  readonly directiveReleased: boolean;
  /**
   * What the hop past this plan answered, or `null` for "no answer yet" — which
   * covers every unreleased directive, and a released one in the window between
   * the release and the answer.
   *
   * A `null` here is never rendered as a success. See {@link undelivered}.
   */
  readonly directiveOutcome: DirectiveDelivery | null;
}

/** Whether the task is still going. Mirrors `RunStatus` without importing it. */
export type TaskState = 'idle' | 'running' | 'stopped';

export interface Plan {
  readonly steps: readonly PlanStep[];
  /** `0` before the first turn. See the header. */
  readonly currentStep: number;
  readonly state: TaskState;
}

export function planOf(titles: readonly string[]): Plan {
  return {
    steps: titles.map((title, index) => ({
      n: index + 1,
      title,
      directive: null,
      directiveReleased: false,
      directiveOutcome: null,
    })),
    currentStep: 0,
    state: 'idle',
  };
}

export function stepAt(plan: Plan, n: number): PlanStep | null {
  return plan.steps.find((step) => step.n === n) ?? null;
}

/**
 * Where a step sits.
 *
 * A stopped task has no current step — the run is not on it any more — so every
 * step it reached reads `done` and the rest read `ahead`. Reporting a `current`
 * step on a task nothing is running is the same overstatement as a spinner that
 * never stops.
 */
export function stateOf(plan: Plan, n: number): StepState {
  if (plan.state !== 'running') return n <= plan.currentStep ? 'done' : 'ahead';
  if (n < plan.currentStep) return 'done';
  if (n === plan.currentStep) return 'current';
  return 'ahead';
}

/**
 * Can a comment on this step still reach the run?
 *
 * `n > currentStep`, not `n >= currentStep`. The header argues the difference;
 * it is the whole guard.
 */
export function isRedirectable(plan: Plan, n: number): boolean {
  if (plan.state === 'stopped') return false;
  if (stepAt(plan, n) === null) return false;
  return n > plan.currentStep;
}

export type RedirectResult =
  | { readonly ok: true; readonly plan: Plan }
  | { readonly ok: false; readonly refusal: RedirectRefusal };

/**
 * Attach a comment to an upcoming step, redirecting the task when it gets there.
 *
 * Refuses rather than silently no-ops, and the refusal is a value the caller
 * renders: conventions §9 rule 6 — silently wrong is the one forbidden outcome,
 * and a comment box that accepts text nothing will read is precisely that.
 *
 * The checks run in the order the sentences should be told, and the stopped
 * check sits ahead of the ahead-of-the-run check on purpose: with one refusal
 * for both, a comment written on step 4 of a task that died on step 2 came back
 * saying the run had already reached step 4, which it never did.
 */
export function redirect(plan: Plan, n: number, comment: string): RedirectResult {
  const trimmed = comment.trim();
  if (trimmed === '') return { ok: false, refusal: 'emptyComment' };
  if (stepAt(plan, n) === null) return { ok: false, refusal: 'noSuchStep' };
  if (plan.state === 'stopped') return { ok: false, refusal: 'taskHasStopped' };
  if (!isRedirectable(plan, n)) return { ok: false, refusal: 'stepIsNotAhead' };
  return {
    ok: true,
    plan: {
      ...plan,
      steps: plan.steps.map((step) =>
        step.n === n
          ? { ...step, directive: trimmed, directiveReleased: false, directiveOutcome: null }
          : step,
      ),
    },
  };
}

/** Remove a comment the user has thought better of. Only while it is still ahead. */
export function clearRedirect(plan: Plan, n: number): Plan {
  if (!isRedirectable(plan, n)) return plan;
  return {
    ...plan,
    steps: plan.steps.map((step) =>
      step.n === n
        ? { ...step, directive: null, directiveReleased: false, directiveOutcome: null }
        : step,
    ),
  };
}

/** One comment let go of by {@link advanceTo}, with the step it was written against. */
export interface ReleasedDirective {
  /** The step the user attached it to, so an answer can be recorded against it. */
  readonly n: number;
  readonly text: string;
}

export interface Advance {
  readonly plan: Plan;
  /**
   * The comments this arrival let go of, in step order. **This is the read**
   * that makes a redirect a redirect: a caller that discards this array has
   * dropped the user's words on the floor. Empty on every ordinary step.
   *
   * It carries `n` and not only the text because the caller owes an answer back
   * through {@link recordDelivery}, and an answer needs a step to land on.
   */
  readonly directives: readonly ReleasedDirective[];
}

/**
 * Move the plan to `step` and release whatever directives that arrival lets go.
 *
 * ## Why it collects a range rather than one step
 *
 * A run does not promise to visit every number. `turnStarted` carries the turn's
 * step, and a harness that completes two plan steps in one turn — or a plan
 * whose steps do not map one-to-one onto turns, which is every plan a user
 * writes — jumps. Taking only `stepAt(step).directive` would drop the comment on
 * every skipped step silently. So everything from just after the old position up
 * to and including the new one is released.
 *
 * Comments on steps that were jumped are therefore released late rather than
 * lost, which is the only one of the three available behaviours (drop, late,
 * refuse) that never loses a user's words.
 */
export function advanceTo(plan: Plan, step: number): Advance {
  if (step <= plan.currentStep) {
    // Nothing arrived, so nothing changes: **the same object back, in every
    // state the plan can be in**. Not a fresh copy, and not a fresh copy with
    // `state` promoted to `running`, which is what this clause said until the
    // test named below was written.
    //
    // A fresh object for a no-op is not free, and the store cannot make up for
    // it: `advance` in `src/state/cowork-store.ts` writes when what comes back
    // is not the plan it already holds, and a fresh copy is not that plan. So
    // the check has to be here as well as there, or every repeated event is a
    // new `plans` map and a re-render of the dock.
    //
    // For a caller that passes `useCowork` a director constructed inline, that
    // re-render is also a fresh director identity, which is a resubscribe,
    // which replays the retained events again. That is a loop, and promoting
    // `state` here is enough to close it even though `currentStep` never moves:
    // a replayed `turnStarted` resurrected a stopped plan to `running`, the
    // `runFinished` behind it in the same replay stopped it again, and the two
    // writes alternated for ever. `use-cowork.test.tsx` drives both replays
    // behind an inline director — a repeated arrival, and the ordinary
    // `turnStarted` -> `runFinished` lifecycle — and each spelling this clause
    // has had is a `Maximum update depth exceeded` crash in one of them.
    // Measured on that file: a fresh copy for every no-op reds both,
    // `Tests  2 failed | 11 passed (13)`; a fresh copy with `state` promoted
    // reds the lifecycle one alone, `Tests  1 failed | 12 passed (13)`; the
    // line below reds neither.
    //
    // WHAT THIS GIVES UP, said plainly. A second run on the same conversation
    // is not modelled: its `turnStarted` for step 1 lands here as an arrival
    // behind the cursor and leaves the plan exactly where the first run ended.
    // Nothing in a step number tells a replayed turn from a re-run one — the
    // thing that does is `RunEventEnvelope.runId`, which lives a layer up in
    // `contract-harness.ts` and is not threaded into a plan. The alternative
    // spelling did not model a restart either; it only made one look like a
    // running task frozen on the step the last run died on.
    return { plan, directives: [] };
  }
  const arriving = plan.steps.filter(
    (candidate) =>
      candidate.n > plan.currentStep &&
      candidate.n <= step &&
      candidate.directive !== null &&
      !candidate.directiveReleased,
  );
  return {
    plan: {
      ...plan,
      currentStep: step,
      state: 'running',
      steps: plan.steps.map((candidate) =>
        arriving.some((hit) => hit.n === candidate.n)
          ? { ...candidate, directiveReleased: true }
          : candidate,
      ),
    },
    // `directive` is non-null on every member of `arriving` — the filter above
    // is what makes that true — but the compiler cannot see it, and a `!` here
    // would be an assertion where a filter will do.
    directives: arriving.flatMap((step_) =>
      step_.directive === null ? [] : [{ n: step_.n, text: step_.directive }],
    ),
  };
}

/**
 * Write back what became of a directive this plan released.
 *
 * Ignores a step that released nothing, and ignores a second answer for one that
 * already carries an answer: the first is what the user was shown, and letting a
 * late duplicate overwrite it would change the panel's account of what happened
 * without anything new having happened.
 */
export function recordDelivery(plan: Plan, n: number, outcome: DirectiveDelivery): Plan {
  const step = stepAt(plan, n);
  if (step === null) return plan;
  // "Released nothing" is `!directiveReleased` and nothing else. A step with no
  // directive is already covered by it, and the reason takes all four writers of
  // that flag rather than one. {@link advanceTo} is the only writer that sets it
  // `true`, behind a filter requiring `directive !== null`. The other three write
  // it `false`: {@link planOf} creates the step with no directive and the flag
  // down, {@link redirect} puts a directive on and the flag down, and
  // {@link clearRedirect} — the one that could strand it — takes the directive
  // off and the flag down in the same object. So `directive === null &&
  // directiveReleased` is a state no function here can produce. A second clause
  // for it would be a branch no input reaches, which is a rule no test can pin.
  if (!step.directiveReleased) return plan;
  if (step.directiveOutcome !== null) return plan;
  return {
    ...plan,
    steps: plan.steps.map((candidate) =>
      candidate.n === n ? { ...candidate, directiveOutcome: outcome } : candidate,
    ),
  };
}

/** The run ended, whatever the outcome. There is no current step any more. */
export function stop(plan: Plan): Plan {
  // Same object when it is already stopped, for the reason {@link advanceTo}
  // gives: a run that reports finishing twice must not be two store writes.
  if (plan.state === 'stopped') return plan;
  return { ...plan, state: 'stopped' };
}

/**
 * Comments the run did not read, and why not.
 *
 * Two ways to get here, and both are reported the moment they are known:
 *
 *  1. **Released, and answered with anything but `delivered`.** Known as soon as
 *     the answer arrives, running task or not. An earlier draft of this file
 *     missed this case entirely, because it treated arrival as delivery and so
 *     had nothing left to report.
 *  2. **Never released, on a task that has stopped.** The run died before
 *     reaching the step. While the task is still going, a pending directive
 *     ahead of the cursor is waiting rather than lost, so it is not named here.
 *
 * A released directive still waiting for its answer is in neither: it is in
 * flight, and calling it lost would be as wrong as calling it delivered.
 * Rendered by `ProgressPanel.tsx` — see the header for why this must not be
 * silent.
 */
export function undelivered(plan: Plan): readonly PlanStep[] {
  return plan.steps.filter((step) => {
    if (step.directive === null) return false;
    if (step.directiveOutcome !== null) return step.directiveOutcome.kind !== 'delivered';
    return !step.directiveReleased && plan.state === 'stopped';
  });
}

/** How many steps have been completed, for the panel's "3 of 7". */
export function completedCount(plan: Plan): number {
  return plan.steps.filter((step) => stateOf(plan, step.n) === 'done').length;
}
