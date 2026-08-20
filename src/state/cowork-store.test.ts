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
 * rather than guessed: replacing the whole ranking function with `() => 0` left
 * `src/features/cowork` and `src/lib/task-plan.test.ts` green, 38/38, twice. An
 * ordering nothing asserts is an ordering the next edit is free to lose.
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

    // Returned, not stored. A directive sitting in a store with nothing reading
    // it back is the unread write this whole feature is built to avoid.
    expect(useCoworkStore.getState().advance('a', 2)).toEqual(['change of plan']);
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
