import { describe, expect, it } from 'vitest';

import {
  advanceTo,
  clearRedirect,
  completedCount,
  isRedirectable,
  planOf,
  recordDelivery,
  redirect,
  stateOf,
  stop,
  undelivered,
} from './task-plan';

const TITLES = ['Read the brief', 'Draft the migration', 'Run the suite', 'Write it up'];

/** The texts a plan released, which is what most of these assertions are about. */
function textsOf(directives: readonly { readonly text: string }[]): readonly string[] {
  return directives.map((directive) => directive.text);
}

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

describe('a comment on an upcoming step is released when the plan arrives', () => {
  it('is released when the plan arrives at that step', () => {
    const planned = redirect(planOf(TITLES), 3, 'use the staging database instead');
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    // Arriving at 2 releases nothing: the comment is on 3.
    const atTwo = advanceTo(planned.plan, 2);
    expect(atTwo.directives).toEqual([]);

    const atThree = advanceTo(atTwo.plan, 3);
    expect(atThree.directives).toEqual([{ n: 3, text: 'use the staging database instead' }]);
  });

  it('carries the step number, so an answer has somewhere to land', () => {
    const planned = redirect(planOf(TITLES), 3, 'use staging');
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    // Without `n` the caller could deliver a directive and have nowhere to
    // record what came back, which is how "delivered" becomes a guess.
    expect(advanceTo(planned.plan, 3).directives.map((each) => each.n)).toEqual([3]);
  });

  it('releases each comment exactly once', () => {
    const planned = redirect(planOf(TITLES), 2, 'skip the fixture');
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    const first = advanceTo(planned.plan, 2);
    expect(textsOf(first.directives)).toEqual(['skip the fixture']);
    // A harness may re-emit `turnStarted` for the same step; the plan must not
    // hand the same instruction out twice.
    const again = advanceTo(first.plan, 2);
    expect(again.directives).toEqual([]);
  });

  it('releases a comment on a step the run jumped over, rather than dropping it', () => {
    const planned = redirect(planOf(TITLES), 2, 'mind the index');
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    // Step 2 is never the arriving step: the run goes 0 -> 3.
    const jumped = advanceTo(planned.plan, 3);
    expect(textsOf(jumped.directives)).toEqual(['mind the index']);
  });

  it('keeps the comment visible after it has been released', () => {
    const planned = redirect(planOf(TITLES), 2, 'mind the index');
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const after = advanceTo(planned.plan, 2).plan;
    const step = after.steps.find((candidate) => candidate.n === 2);
    expect(step?.directive).toBe('mind the index');
    expect(step?.directiveReleased).toBe(true);
  });

  /**
   * THE DISTINCTION THIS FILE WAS REWRITTEN FOR.
   *
   * Arrival is not delivery. A plan that marked a comment delivered because the
   * run reached its step is a plan that reports success for a hop that has not
   * been attempted — and in this build that hop does not exist at all. So
   * arrival leaves `directiveOutcome` null, and null is not a success.
   */
  it('does not claim delivery on arrival — only an answer can say that', () => {
    const planned = redirect(planOf(TITLES), 2, 'mind the index');
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const arrived = advanceTo(planned.plan, 2).plan;
    expect(arrived.steps.find((step) => step.n === 2)?.directiveOutcome).toBeNull();
  });
});

describe('what became of a released directive is written back, not assumed', () => {
  /** A plan with a comment on step 2, released by arriving there. */
  function released() {
    const planned = redirect(planOf(TITLES), 2, 'mind the index');
    if (!planned.ok) throw new Error('the fixture comment was refused');
    return advanceTo(planned.plan, 2).plan;
  }

  it('records the answer against the step it was written for', () => {
    const answered = recordDelivery(released(), 2, { kind: 'delivered' });
    expect(answered.steps.find((step) => step.n === 2)?.directiveOutcome).toEqual({
      kind: 'delivered',
    });
  });

  it('ignores an answer for a step that released nothing', () => {
    const plan = released();
    // Step 3 has no comment. An answer landing there would invent a delivery
    // for a directive that does not exist.
    const answered = recordDelivery(plan, 3, { kind: 'delivered' });
    expect(answered.steps.find((step) => step.n === 3)?.directiveOutcome).toBeNull();
  });

  it('keeps the first answer when a second arrives', () => {
    const first = recordDelivery(released(), 2, { kind: 'noLiveRun' });
    const second = recordDelivery(first, 2, { kind: 'delivered' });
    // The user was already shown the first answer. A later one overwriting it
    // would change the panel's account of what happened with nothing new having
    // happened.
    expect(second.steps.find((step) => step.n === 2)?.directiveOutcome).toEqual({
      kind: 'noLiveRun',
    });
  });
});

/**
 * THE BOUNDARY THIS FEATURE TURNS ON.
 *
 * `n >= currentStep` and `n > currentStep` differ on exactly one input, and that
 * input is the step the run is on right now. `advanceTo` releases on *arrival*
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
    expect(isRedirectable(stopped, 1)).toBe(false);
  });

  /**
   * One refusal for two conditions is one wrong sentence. A task that died on
   * step 2 never reached step 4, and telling the user it did is a false claim
   * about their own task in the exact moment they are trying to work out what
   * happened.
   */
  it('tells a stopped task apart from a run that has passed the step', () => {
    const stopped = stop(advanceTo(planOf(TITLES), 2).plan);
    const ahead = redirect(stopped, 4, 'one more thing');
    expect(ahead.ok).toBe(false);
    if (ahead.ok) return;
    expect(ahead.refusal).toBe('taskHasStopped');

    const running = advanceTo(planOf(TITLES), 2).plan;
    const passed = redirect(running, 1, 'should have said');
    expect(passed.ok).toBe(false);
    if (passed.ok) return;
    expect(passed.refusal).toBe('stepIsNotAhead');
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
    expect(textsOf(advanceTo(planned.plan, 2).directives)).toEqual(['use the staging database']);
  });
});

describe('a comment the run did not read is reported, not swallowed', () => {
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

  /**
   * The case an arrival-means-delivery plan could not report at all: the run
   * reached the step, the comment was handed on, and the hop answered that it
   * did not take it. That is a comment the user must be told about, and the task
   * has not stopped, so the stopped-only rule would have kept quiet.
   */
  it('names a released directive the hop answered anything but delivered', () => {
    const planned = redirect(planOf(TITLES), 2, 'mind the index');
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const arrived = advanceTo(planned.plan, 2).plan;

    const refused = recordDelivery(arrived, 2, { kind: 'noLiveRun' });
    expect(refused.state).toBe('running');
    expect(undelivered(refused).map((step) => step.directive)).toEqual(['mind the index']);
  });

  it('says nothing about one still waiting for its answer', () => {
    const planned = redirect(planOf(TITLES), 2, 'mind the index');
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    // Released, no answer yet. In flight is neither delivered nor lost, and
    // guessing either way is the whole defect.
    expect(undelivered(advanceTo(planned.plan, 2).plan)).toEqual([]);
  });

  it('reports nothing for a directive a run actually took', () => {
    const planned = redirect(planOf(TITLES), 2, 'mind the index');
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const delivered = recordDelivery(advanceTo(planned.plan, 2).plan, 2, { kind: 'delivered' });
    expect(undelivered(stop(delivered))).toEqual([]);
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
    const released = advanceTo(planned.plan, 2).plan;
    // Step 2 is the running step, so it is not redirectable, so clearing is a
    // no-op. Withdrawing an instruction that has already been handed on would
    // be a lie told to the panel.
    const cleared = clearRedirect(released, 2);
    expect(cleared.steps.find((step) => step.n === 2)?.directive).toBe('mind the index');
  });
});
