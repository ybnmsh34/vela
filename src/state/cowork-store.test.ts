import { beforeEach, describe, expect, it } from 'vitest';

import { planFor, resetCoworkStore, tasksIn, useCoworkStore } from './cowork-store';

/**
 * The store's own rules, as distinct from the plan algebra it delegates to.
 *
 * `src/lib/task-plan.test.ts` owns when a directive is deliverable. What is left
 * here is the part the store decides by itself — how tasks are keyed, what a
 * conversation with no plan answers, and the order the switcher shows them in.
 *
 * That last one is here because it was **not** covered and the gap was measured
 * rather than guessed. Re-measured against the tree this commit ships: replacing
 * the whole ranking function with `() => 0` leaves `src/features/cowork` and
 * `src/lib/task-plan.test.ts` green — 72 passed, twice — and fails exactly one
 * test, here. An ordering nothing asserts is an ordering the next edit is free
 * to lose.
 */
beforeEach(() => {
  resetCoworkStore();
});

describe('tasks are keyed by conversation', () => {
  it('keeps each conversation’s plan separate', () => {
    const store = useCoworkStore.getState();
    store.setPlan('a', ['one', 'two']);
    store.setPlan('b', ['three']);
    store.advance('a', 2);

    const plans = useCoworkStore.getState().plans;
    expect(plans['a']?.currentStep).toBe(2);
    expect(plans['b']?.currentStep).toBe(0);
    expect(plans['b']?.steps).toHaveLength(1);
  });

  it('answers an empty plan for a conversation that has none, and for none at all', () => {
    const plans = useCoworkStore.getState().plans;
    // Never `undefined`: a caller that had to branch on it would branch on it
    // wrong somewhere, and an empty plan renders as "no plan yet".
    expect(planFor(plans, 'nobody').steps).toEqual([]);
    expect(planFor(plans, null).steps).toEqual([]);
  });

  it('forgets a plan when its conversation goes', () => {
    const store = useCoworkStore.getState();
    store.setPlan('a', ['one']);
    store.clearPlan('a');
    expect(useCoworkStore.getState().plans['a']).toBeUndefined();
  });

  it('hands directives back to the caller rather than parking them', () => {
    const store = useCoworkStore.getState();
    store.setPlan('a', ['one', 'two']);
    const accepted = store.comment('a', 2, 'change of plan');
    expect(accepted.ok).toBe(true);

    // Returned, not stored, and with the step number on it so the caller can say
    // what became of it. A directive sitting in a store with nothing reading it
    // back is the unread write this whole feature is built to avoid — and so is
    // one handed to a caller that drops it, which is why
    // `src/features/cowork/use-cowork.test.tsx` drives the caller as well.
    expect(useCoworkStore.getState().advance('a', 2)).toEqual([{ n: 2, text: 'change of plan' }]);
  });

  it('takes the answer back and does not invent one', () => {
    const store = useCoworkStore.getState();
    store.setPlan('a', ['one', 'two']);
    expect(store.comment('a', 2, 'change of plan').ok).toBe(true);
    useCoworkStore.getState().advance('a', 2);

    // Released and unanswered is not delivered. Only `recordDelivery` may put an
    // outcome on a step, and until it does the plan says nothing.
    expect(useCoworkStore.getState().plans['a']?.steps[1]?.directiveOutcome).toBeNull();

    useCoworkStore.getState().recordDelivery('a', 2, { kind: 'noLiveRun' });
    expect(useCoworkStore.getState().plans['a']?.steps[1]?.directiveOutcome).toEqual({
      kind: 'noLiveRun',
    });
  });

  it('ignores an answer for a conversation it holds no plan for', () => {
    useCoworkStore.getState().recordDelivery('ghost', 1, { kind: 'delivered' });
    expect(useCoworkStore.getState().plans['ghost']).toBeUndefined();
  });

  it('refuses a comment for a conversation with no plan instead of inventing one', () => {
    const result = useCoworkStore.getState().comment('ghost', 1, 'hello');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe('noSuchStep');
    expect(useCoworkStore.getState().plans['ghost']).toBeUndefined();
  });
});

describe('the task switcher’s order', () => {
  it('puts running tasks first, then not-started, then stopped', () => {
    const store = useCoworkStore.getState();
    store.setPlan('stopped-one', ['x']);
    store.setPlan('idle-one', ['x']);
    store.setPlan('running-one', ['x', 'y']);
    store.stopTask('stopped-one');
    store.advance('running-one', 1);

    expect(tasksIn(useCoworkStore.getState().plans).map((task) => task.conversationId)).toEqual([
      'running-one',
      'idle-one',
      'stopped-one',
    ]);
  });

  it('keeps insertion order within a state, so the list does not move under the user', () => {
    const store = useCoworkStore.getState();
    store.setPlan('first', ['x']);
    store.setPlan('second', ['x']);
    store.setPlan('third', ['x']);

    expect(tasksIn(useCoworkStore.getState().plans).map((task) => task.conversationId)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('does not reorder a task when its plan advances but its state does not change', () => {
    const store = useCoworkStore.getState();
    store.setPlan('first', ['x', 'y']);
    store.setPlan('second', ['x', 'y']);
    store.advance('first', 1);
    store.advance('second', 1);
    // Both running. Advancing `first` again must not move it past `second`.
    store.advance('first', 2);

    expect(tasksIn(useCoworkStore.getState().plans).map((task) => task.conversationId)).toEqual([
      'first',
      'second',
    ]);
  });
});

/**
 * AN ACTION THAT CHANGES NOTHING WRITES NOTHING.
 *
 * The identity asserted here is the `plans` **map**, not the plan inside it,
 * and the difference is the whole test. `set({ plans: { ...get().plans, [id]:
 * unchanged } })` leaves the plan object alone and still hands every selector
 * reading `plans` a value it has not seen before, which is a re-render of the
 * dock — so an assertion on the plan object cannot see the write at all, and
 * the first draft of these tests made exactly that mistake. Measured
 * against the tree this commit ships: dropping the `next !== plan` guard from
 * `recordDelivery` gives EXIT=1, `Tests  1 failed | 86 passed (87)`, and the
 * single red is `writes nothing for a second answer about a directive that
 * already has one`. Reproduced twice.
 *
 * It is not only a render. In `useCowork` a re-render is a fresh `director`
 * identity for any caller that builds one inline, a fresh identity is a
 * resubscribe, and a resubscribe replays the event that caused the write.
 * `use-cowork.test.tsx` drives that caller.
 */
describe('a no-op action leaves the plan alone', () => {
  it('writes nothing when the run re-reports a step it is on', () => {
    const store = useCoworkStore.getState();
    store.setPlan('a', ['one', 'two', 'three']);
    store.advance('a', 2);
    const plans = useCoworkStore.getState().plans;

    const released = useCoworkStore.getState().advance('a', 2);

    expect(released).toEqual([]);
    expect(useCoworkStore.getState().plans).toBe(plans);
  });

  it('writes nothing when a finished run reports finishing again', () => {
    const store = useCoworkStore.getState();
    store.setPlan('a', ['one', 'two']);
    store.advance('a', 1);
    store.stopTask('a');
    const plans = useCoworkStore.getState().plans;

    useCoworkStore.getState().stopTask('a');

    expect(useCoworkStore.getState().plans).toBe(plans);
  });

  it('writes nothing for a second answer about a directive that already has one', () => {
    const store = useCoworkStore.getState();
    store.setPlan('a', ['one', 'two']);
    const accepted = store.comment('a', 2, 'use staging');
    expect(accepted.ok).toBe(true);
    useCoworkStore.getState().advance('a', 2);
    useCoworkStore.getState().recordDelivery('a', 2, { kind: 'noLiveRun' });
    const plans = useCoworkStore.getState().plans;

    // A late duplicate must not restate what the user was already shown, and it
    // must not cost a render to decline to.
    useCoworkStore.getState().recordDelivery('a', 2, { kind: 'delivered' });

    expect(useCoworkStore.getState().plans).toBe(plans);
    expect(useCoworkStore.getState().plans['a']?.steps[1]?.directiveOutcome).toEqual({
      kind: 'noLiveRun',
    });
  });

  it('writes nothing when a comment is removed from a step the run has passed', () => {
    const store = useCoworkStore.getState();
    store.setPlan('a', ['one', 'two', 'three']);
    store.comment('a', 3, 'use staging');
    useCoworkStore.getState().advance('a', 3);
    const plans = useCoworkStore.getState().plans;

    useCoworkStore.getState().uncomment('a', 3);

    expect(useCoworkStore.getState().plans).toBe(plans);
    // The comment is still there, because it was already released — removing it
    // afterwards would erase what the user said about a step that read it.
    expect(useCoworkStore.getState().plans['a']?.steps[2]?.directive).toBe('use staging');
  });

  it('writes nothing when a refused comment is not taken', () => {
    const store = useCoworkStore.getState();
    store.setPlan('a', ['one', 'two']);
    const plans = useCoworkStore.getState().plans;

    const refused = store.comment('a', 2, '   ');

    expect(refused.ok).toBe(false);
    expect(useCoworkStore.getState().plans).toBe(plans);
  });
});
