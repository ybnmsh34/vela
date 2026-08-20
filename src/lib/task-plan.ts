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
 * ## The guard, and the narrower question it is deliberately not asking
 *
 * A comment on an upcoming step redirects the task. The obvious guard is "is
 * this step still in the future", spelled `n >= currentStep`, and it is wrong by
 * exactly one. A directive is delivered by {@link advanceTo}, which fires when
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
 * Refusing the un-deliverable at write time is not enough. A directive on step 6
 * of a plan whose run fails at step 3 was accepted correctly and is still never
 * read. Nothing can prevent that — the run's failure is not knowable when the
 * comment is written — so the answer is to make it **visible** rather than
 * silent: {@link undelivered} names every directive still pending on a task that
 * has stopped, and `ProgressPanel.tsx` renders them. A comment the run never got
 * is a thing the user must be told about, not a row that quietly looks like the
 * others.
 */

/** Where a step sits relative to the run. */
export type StepState = 'done' | 'current' | 'ahead';

/** Why {@link redirect} would not take a comment. */
export type RedirectRefusal =
  /** No step carries that number. */
  | 'noSuchStep'
  /**
   * The step is the one running, or is behind it. Nothing will arrive at it
   * again, so nothing would ever read the comment. See the header.
   */
  | 'stepIsNotAhead'
  /** The comment was blank once trimmed. A blank redirect is not a redirect. */
  | 'emptyComment';

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
   * `true` once {@link advanceTo} has handed this step's directive to the run.
   * Kept rather than clearing {@link directive}, because the panel shows the
   * user what they said after it has been acted on — a comment that vanishes at
   * the moment it takes effect looks exactly like a comment that was dropped.
   */
  readonly directiveDelivered: boolean;
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
      directiveDelivered: false,
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
 */
export function redirect(plan: Plan, n: number, comment: string): RedirectResult {
  const trimmed = comment.trim();
  if (trimmed === '') return { ok: false, refusal: 'emptyComment' };
  if (stepAt(plan, n) === null) return { ok: false, refusal: 'noSuchStep' };
  if (!isRedirectable(plan, n)) return { ok: false, refusal: 'stepIsNotAhead' };
  return {
    ok: true,
    plan: {
      ...plan,
      steps: plan.steps.map((step) =>
        step.n === n ? { ...step, directive: trimmed, directiveDelivered: false } : step,
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
      step.n === n ? { ...step, directive: null, directiveDelivered: false } : step,
    ),
  };
}

export interface Advance {
  readonly plan: Plan;
  /**
   * The comments the arriving step carried, in step order. **This is the read**
   * that makes a redirect a redirect; `use-cowork.ts` hands it to the run.
   * Empty on every ordinary step.
   */
  readonly directives: readonly string[];
}

/**
 * Move the plan to `step` and take whatever directives that arrival delivers.
 *
 * ## Why it collects a range rather than one step
 *
 * A run does not promise to visit every number. `turnStarted` carries the turn's
 * step, and a harness that completes two plan steps in one turn — or a plan
 * whose steps do not map one-to-one onto turns, which is every plan a user
 * writes — jumps. Taking only `stepAt(step).directive` would drop the comment on
 * every skipped step silently. So everything from just after the old position up
 * to and including the new one is delivered.
 *
 * Undelivered comments on steps that were jumped are therefore delivered late
 * rather than lost, which is the only one of the three available behaviours
 * (drop, late, refuse) that never loses a user's words.
 */
export function advanceTo(plan: Plan, step: number): Advance {
  if (step <= plan.currentStep) {
    return { plan: { ...plan, state: 'running' }, directives: [] };
  }
  const arriving = plan.steps.filter(
    (candidate) =>
      candidate.n > plan.currentStep &&
      candidate.n <= step &&
      candidate.directive !== null &&
      !candidate.directiveDelivered,
  );
  return {
    plan: {
      ...plan,
      currentStep: step,
      state: 'running',
      steps: plan.steps.map((candidate) =>
        arriving.some((hit) => hit.n === candidate.n)
          ? { ...candidate, directiveDelivered: true }
          : candidate,
      ),
    },
    // `directive` is non-null on every member of `arriving` — the filter above
    // is what makes that true — but the compiler cannot see it, and a `!` here
    // would be an assertion where a filter will do.
    directives: arriving.flatMap((step_) => (step_.directive === null ? [] : [step_.directive])),
  };
}

/** The run ended, whatever the outcome. There is no current step any more. */
export function stop(plan: Plan): Plan {
  return { ...plan, state: 'stopped' };
}

/**
 * Comments the run will never read.
 *
 * Only meaningful once the task has stopped: while it is running, a pending
 * directive ahead of the cursor is waiting, not lost. Rendered by
 * `ProgressPanel.tsx` — see the header for why this must not be silent.
 */
export function undelivered(plan: Plan): readonly PlanStep[] {
  if (plan.state !== 'stopped') return [];
  return plan.steps.filter((step) => step.directive !== null && !step.directiveDelivered);
}

/** How many steps have been completed, for the panel's "3 of 7". */
export function completedCount(plan: Plan): number {
  return plan.steps.filter((step) => stateOf(plan, step.n) === 'done').length;
}
