import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

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
 * rather than guessed: replacing the whole ranking function with `() => 0` reds
 * exactly one test — `the task switcher’s order > puts running tasks first,
 * then not-started, then stopped`, below — and reds nothing at all in
 * `src/features/cowork` or in `src/lib/task-plan.test.ts`. An ordering nothing
 * asserts is an ordering the next edit is free to lose.
 *
 * The pass count that used to be in that sentence — "72 passed, twice" — is
 * gone rather than refreshed. It was true at `474c9c7`, where it was written;
 * `70989d5` added three tests inside the scope it counted — two to
 * `task-plan.test.ts` and one to `use-cowork.test.tsx` — which made it 75; and
 * it still said 72 at `507c668`, where the round ended. That is the defect
 * `cowork-store.ts`'s header now describes at length: a suite-wide total,
 * written inside the suite, is stale as soon as anybody adds a test. "Reds
 * exactly this one and nothing else in those files" is what the mutation
 * actually establishes, and it does not move when the suite grows.
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
 * `recordDelivery` gives EXIT=1 with exactly one red in the whole cowork scope
 * — `writes nothing for a second answer about a directive that already has
 * one`, below — and nothing else in that scope moves. Reproduced twice.
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

  it('writes nothing when a finished run replays the turn it stopped on', () => {
    // The replay a resubscribe produces is `turnStarted` *after* `runFinished`,
    // so this arrival lands on a stopped plan. It moves no step, and it must
    // not move `state` either: a write here and the `runFinished` behind it in
    // the same replay alternate for ever. `use-cowork.test.tsx` is where that
    // alternation is a crash rather than a cost.
    const store = useCoworkStore.getState();
    store.setPlan('a', ['one', 'two', 'three']);
    store.advance('a', 2);
    store.stopTask('a');
    const plans = useCoworkStore.getState().plans;

    const released = useCoworkStore.getState().advance('a', 2);

    expect(released).toEqual([]);
    expect(useCoworkStore.getState().plans).toBe(plans);
    expect(useCoworkStore.getState().plans['a']?.state).toBe('stopped');
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

/**
 * THE GUARD THAT REPLACED A NUMBER.
 *
 * `cowork-store.ts`'s header says `setPlan` has no caller outside the tests —
 * the largest disclosed gap in this feature, because it is what makes every "the
 * user sees" in the progress panel conditional on a plan a user cannot create.
 * That header used to say so by quoting a count of the call sites, and the count
 * went stale inside the round that wrote it: correct at `474c9c7`, false by
 * `70989d5`, still false when the round ended.
 *
 * A number in a comment cannot notice that. This walk recomputes it on every
 * run, and on the day somebody wires a plan up it fails here naming their file —
 * which is the day that paragraph and this test both want rewriting.
 *
 * Two positive controls, because a walk that finds no callers passes for two
 * very different reasons. The first says the walk reached a tree at all; the
 * second says the pattern still matches a call site that genuinely exists, so a
 * regex that had quietly stopped matching could not pass itself off as silence.
 */
function modulesUnder(directory: string, keep: (name: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...modulesUnder(path, keep));
    else if (/\.tsx?$/.test(entry.name) && keep(entry.name)) found.push(path);
  }
  return found;
}

const SRC_ROOT = join(process.cwd(), 'src');
const CALLS_SET_PLAN = /\bsetPlan\s*\(/;
const THIS_FILE = join(SRC_ROOT, 'state', 'cowork-store.test.ts');

describe('the gap this store is honest about', () => {
  it('nothing outside the tests calls setPlan', () => {
    const shipping = modulesUnder(SRC_ROOT, (name) => !/\.test\.[a-z]+$/.test(name));

    // Control 1: the walk reached a tree. Without it, a working directory that
    // is not the repo root reports the same empty answer that success does.
    expect(shipping.length, `no shipping modules found under ${SRC_ROOT}`).toBeGreaterThan(100);
    expect(shipping).toContain(join(SRC_ROOT, 'state', 'cowork-store.ts'));

    // Control 2: the pattern still matches a call site that is really there.
    expect(CALLS_SET_PLAN.test(readFileSync(THIS_FILE, 'utf8'))).toBe(true);

    const callers = shipping
      .filter((file) => CALLS_SET_PLAN.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(SRC_ROOT.length + 1).split(sep).join('/'));

    expect(
      callers,
      'a shipping module calls setPlan, so a user can reach a plan now. That is ' +
        'the gap closing rather than a failure: rewrite the AND NOTHING IN THIS ' +
        'BUILD PUTS A PLAN IN paragraph in cowork-store.ts, and delete this test',
    ).toEqual([]);
  });
});
