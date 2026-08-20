import { describe, expect, it } from 'vitest';

import { createUnwiredDirector } from './director';

/**
 * A test over a stub, which is a strange thing to write until you ask what it is
 * for.
 *
 * `createUnwiredDirector` exists because a mid-flight redirect has no host
 * behind it: `RunController` in `src/platform/contract-harness.ts` is, in that
 * file's own words, "the only thing a caller can do to a run in flight", and it
 * carries exactly one method — `cancel`. There is no way in.
 *
 * The hazard is not that the stub is wrong. It is that somebody later replaces
 * it with something that answers `delivered` without a run having taken
 * anything, because `delivered` is what makes the panel look finished. That is
 * this repo's defect in its purest form — a green surface over a seam that does
 * nothing — and it is why the stub answers the *pessimistic* member of the
 * union and why that answer is pinned here.
 */
describe('the unwired task director', () => {
  it('answers noLiveRun rather than claiming delivery', async () => {
    const director = createUnwiredDirector();
    await expect(director.deliver('conversation-1', 3, 'use staging instead')).resolves.toEqual({
      kind: 'noLiveRun',
    });
  });

  it('answers the same for every conversation and step, because nothing is wired', async () => {
    const director = createUnwiredDirector();
    const answers = await Promise.all([
      director.deliver('a', 1, 'one'),
      director.deliver('b', 99, 'two'),
      director.deliver('a', 1, 'three'),
    ]);
    // If this ever stops being uniform, something is deciding — and whatever is
    // deciding needs its own test, which is the point of this one failing.
    expect(answers.map((answer) => answer.kind)).toEqual(['noLiveRun', 'noLiveRun', 'noLiveRun']);
  });

  it('does not throw, so a panel can call it and render the answer', async () => {
    // A throwing stub would push every caller into a try/catch and tempt the
    // first one to swallow it, which is how "no run took your comment" becomes
    // silence.
    await expect(createUnwiredDirector().deliver('', 0, '')).resolves.toBeDefined();
  });
});
