import { describe, expect, it } from 'vitest';

import {
  advanceTo,
  clearRedirect,
  completedCount,
  isRedirectable,
  planOf,
  redirect,
  stateOf,
  stop,
  undelivered,
} from './task-plan';

const TITLES = ['Read the brief', 'Draft the migration', 'Run the suite', 'Write it up'];

describe('a plan numbers its steps the way the run does', () => {
  it('starts at step 0, which is before the first turn', () => {
    const plan = planOf(TITLES);
    // `turnStarted.step` is 1-based per contract-harness.ts, and
    // `createLiveRuns` seeds `RunStatus` with `step: 0`. Anything else here
    // would be a second numbering scheme.
    expect(plan.currentStep).toBe(0);
    expect(plan.steps.map((step) => step.n)).toEqual([1, 2, 3, 4]);
  });

  it('reports done / current / ahead against the running step', () => {
    const plan = advanceTo(planOf(TITLES), 2).plan;
    expect(stateOf(plan, 1)).toBe('done');
    expect(stateOf(plan, 2)).toBe('current');
    expect(stateOf(plan, 3)).toBe('ahead');
    expect(completedCount(plan)).toBe(1);
  });

  it('has no current step once the task has stopped', () => {
    const plan = stop(advanceTo(planOf(TITLES), 2).plan);
    expect(stateOf(plan, 2)).toBe('done');
    expect(stateOf(plan, 3)).toBe('ahead');
  });
});

describe('a comment on an upcoming step redirects the task', () => {
  it('is delivered when the plan arrives at that step', () => {
    const planned = redirect(planOf(TITLES), 3, 'use the staging database instead');
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    // Arriving at 2 delivers nothing: the comment is on 3.
    const atTwo = advanceTo(planned.plan, 2);
    expect(atTwo.directives).toEqual([]);

    const atThree = advanceTo(atTwo.plan, 3);
    expect(atThree.directives).toEqual(['use the staging database instead']);
  });

  it('delivers each comment exactly once', () => {
    const planned = redirect(planOf(TITLES), 2, 'skip the fixture');
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    const first = advanceTo(planned.plan, 2);
    expect(first.directives).toEqual(['skip the fixture']);
    // A harness may re-emit `turnStarted` for the same step; the plan must not
    // hand the same instruction to the model twice.
    const again = advanceTo(first.plan, 2);
    expect(again.directives).toEqual([]);
  });

  it('delivers a comment on a step the run jumped over, rather than dropping it', () => {
    const planned = redirect(planOf(TITLES), 2, 'mind the index');
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    // Step 2 is never the arriving step: the run goes 0 -> 3.
    const jumped = advanceTo(planned.plan, 3);
    expect(jumped.directives).toEqual(['mind the index']);
  });

  it('keeps the comment visible after it has been acted on', () => {
    const planned = redirect(planOf(TITLES), 2, 'mind the index');
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const after = advanceTo(planned.plan, 2).plan;
    const step = after.steps.find((candidate) => candidate.n === 2);
    expect(step?.directive).toBe('mind the index');
    expect(step?.directiveDelivered).toBe(true);
  });
});

/**
 * THE BOUNDARY THIS FEATURE TURNS ON.
 *
 * `n >= currentStep` and `n > currentStep` differ on exactly one input, and that
 * input is the step the run is on right now. `advanceTo` delivers on *arrival*
 * and the plan never arrives at the step it is already on, so a comment stored
 * against `currentStep` is a write nothing reads. These are the cases that tell
 * the two guards apart.
 */
describe('the redirect guard refuses what nothing would read', () => {
  it('refuses a comment on the step that is running right now', () => {
    const running = advanceTo(planOf(TITLES), 2).plan;
    expect(isRedirectable(running, 2)).toBe(false);

    const attempt = redirect(running, 2, 'too late for this one');
    expect(attempt.ok).toBe(false);
    if (attempt.ok) return;
    expect(attempt.refusal).toBe('stepIsNotAhead');
  });

  it('accepts a comment on the very next step', () => {
    const running = advanceTo(planOf(TITLES), 2).plan;
    expect(isRedirectable(running, 3)).toBe(true);
    expect(redirect(running, 3, 'change of plan').ok).toBe(true);
  });

  it('refuses a comment on a step already behind the run', () => {
    const running = advanceTo(planOf(TITLES), 3).plan;
    const attempt = redirect(running, 1, 'should have said');
    expect(attempt.ok).toBe(false);
    if (attempt.ok) return;
    expect(attempt.refusal).toBe('stepIsNotAhead');
  });

  it('refuses every step once the task has stopped', () => {
    const stopped = stop(advanceTo(planOf(TITLES), 2).plan);
    expect(isRedirectable(stopped, 4)).toBe(false);
    const attempt = redirect(stopped, 4, 'one more thing');
    expect(attempt.ok).toBe(false);
    if (attempt.ok) return;
    expect(attempt.refusal).toBe('stepIsNotAhead');
  });

  it('refuses a step number no step carries, and a blank comment', () => {
    const plan = planOf(TITLES);
    const missing = redirect(plan, 99, 'nowhere to put this');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.refusal).toBe('noSuchStep');

    const blank = redirect(plan, 2, '   \n  ');
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.refusal).toBe('emptyComment');
  });

  it('stores the comment trimmed, because that is what is sent', () => {
    const planned = redirect(planOf(TITLES), 2, '  use the staging database  ');
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(advanceTo(planned.plan, 2).directives).toEqual(['use the staging database']);
  });
});

describe('a comment the run never reached is reported, not swallowed', () => {
  it('names every pending directive once the task has stopped', () => {
    const planned = redirect(planOf(TITLES), 4, 'and mention the caveat');
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    // The run dies at step 2. Step 4 never arrives.
    const stopped = stop(advanceTo(planned.plan, 2).plan);
    expect(undelivered(stopped).map((step) => step.directive)).toEqual(['and mention the caveat']);
  });

  it('reports nothing while the task is still running', () => {
    const planned = redirect(planOf(TITLES), 4, 'and mention the caveat');
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    // Pending is not lost. A running task's comment is waiting its turn.
    expect(undelivered(advanceTo(planned.plan, 2).plan)).toEqual([]);
  });

  it('reports nothing for a directive that was delivered before the stop', () => {
    const planned = redirect(planOf(TITLES), 2, 'mind the index');
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(undelivered(stop(advanceTo(planned.plan, 2).plan))).toEqual([]);
  });
});

describe('a comment can be withdrawn while it is still ahead', () => {
  it('clears an upcoming comment', () => {
    const planned = redirect(planOf(TITLES), 3, 'never mind');
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const cleared = clearRedirect(planned.plan, 3);
    expect(advanceTo(cleared, 3).directives).toEqual([]);
  });

  it('will not clear one the run has already been given', () => {
    const planned = redirect(planOf(TITLES), 2, 'mind the index');
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const delivered = advanceTo(planned.plan, 2).plan;
    // Step 2 is the running step, so it is not redirectable, so clearing is a
    // no-op. Withdrawing an instruction the model has already been given would
    // be a lie told to the panel.
    const cleared = clearRedirect(delivered, 2);
    expect(cleared.steps.find((step) => step.n === 2)?.directive).toBe('mind the index');
  });
});
