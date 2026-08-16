/**
 * The one screen that makes a promise before anything has happened.
 *
 * This file exists for a single property: **the empty state must not assert
 * something failover can falsify.** It used to say *"This conversation runs on
 * X. Nothing leaves your machine except the request you send it."* The router
 * tries the endpoint the user chose and then every other configured one behind
 * it, so a turn can be answered elsewhere and a request can leave a machine the
 * sentence promised it would not. It is the same falsehood class as the one the
 * transcript's `AnsweredByNote` was added to correct — except this one is read
 * *before* the user decides whether to trust the app, by exactly the person who
 * cares most.
 *
 * The assertions below are about the shape of the claim rather than its exact
 * prose. Pinning the sentence would make every copy edit a test change and would
 * pin nothing that matters.
 *
 * ## What {@link LOCALITY_PROMISES} actually does, at its own strength
 *
 * It catches the sentence it replaced and its obvious rewrites. That is all it
 * is: a blacklist of phrasings, not a decision procedure for "does this promise
 * locality". **No regex list can be that**, and a green run here is not evidence
 * that a newly written sentence is honest — only that it is not one of the
 * phrasings already known to be dishonest. A reviewer reading a new lede has to
 * think, and this file cannot do it for them.
 *
 * That paragraph used to claim the list "survives rewording and fails the moment
 * someone reaches for the reassuring phrasing again". A reviewer falsified it in
 * one line — appending *"Your prompts are processed on-device and never go
 * anywhere else"* to the live sentence left all five tests green, because the
 * list knew nothing of `on-device`, `never go anywhere`, `stays private`, `to
 * the cloud`, or `processed locally`. Those are in it now, and the claim has
 * been cut back to what the evidence supports.
 *
 * It is worth leaving both halves written down. A test file asserting a property
 * more confidently than its evidence allows is the same fault as a screen
 * asserting a guarantee the router can contradict — which is the entire subject
 * of this branch. The correction had to be applied to the branch's own work
 * before it could be claimed as finished.
 *
 * It then had to be applied twice. The first attempt at this fix added the
 * missing phrasings and a "no pattern catches nothing" check, and *that* check
 * was itself too weak to support the sentence written above it — see
 * {@link PATTERN_WITNESSES}. Both rounds are recorded because the lesson is not
 * "add more patterns"; it is that a guard and the claim made for it are separate
 * artefacts, and the second one is the one that goes stale silently.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ChatCapabilities } from '@/platform/contract';

import { EmptyConversation } from './EmptyConversation';

const NOTHING_KNOWN: ChatCapabilities = {
  streaming: false,
  reasoning: false,
  vision: false,
  toolCalls: false,
  usageReporting: false,
  modelListing: false,
  promptCaching: false,
};

/**
 * Phrasings that promise something about where bytes go — which this surface
 * cannot observe and failover can contradict. Matched case-insensitively
 * against the whole rendered text.
 *
 * A blacklist, with the limits the file header spells out. Every entry earns its
 * place by catching a sentence in {@link PROMISES_THAT_MUST_BE_CAUGHT}, and a
 * test below fails if any entry stops catching anything — a dead pattern in a
 * list like this reads exactly like a clean screen.
 *
 * `\blocally\b` is deliberately the bare adverb rather than `runs? locally`,
 * which was the original and which missed *"processed locally"*. There is no
 * honest use of the word on this screen: Vela cannot know that a configured
 * endpoint is local, and the fallback it reaches for may not be.
 *
 * `never go(?:es)? anywhere` is spelled with a grouped suffix on purpose.
 * `never goes? anywhere` looks equivalent and is not — `?` binds to the `s`
 * alone, so it matches "goe" and "goes" and misses the "never go anywhere" that
 * prompted the entry.
 */
/**
 * Each pattern paired with the sentence it alone is responsible for catching.
 *
 * **Pairs, not two independent lists, and that shape is load-bearing.** The
 * first draft kept a flat corpus and asserted only that *some* pattern objected
 * to each sentence. That is too weak to prove anything about an individual
 * entry: breaking `never go(?:es)? anywhere` into the `never goes? anywhere`
 * spelling — where `?` binds to the `s`, so it matches "goe" and "goes" and
 * misses "go" — left the suite green, because the one sentence exercising it
 * also contained `on-device` and a neighbouring pattern covered the hole. A
 * guard whose entries can cover for each other cannot tell a working list from
 * a list with a broken entry in it.
 *
 * So every witness is chosen to trip exactly one pattern, and the test below
 * checks each pattern against its own witness rather than against the pile.
 */
const PATTERN_WITNESSES: readonly (readonly [RegExp, string])[] = [
  [/leaves? your machine/iu, 'Nothing leaves your machine except the request you send it.'],
  [/stays? on (?:your|this) (?:machine|computer|device)/iu, 'Everything stays on your device.'],
  [/never leaves/iu, 'Your prompt never leaves this app.'],
  [/\blocally\b/iu, 'Your text is processed locally.'],
  [/\bstays? local\b/iu, 'Your data stays local.'],
  [/\boffline\b/iu, 'Vela works offline.'],
  [/on-device/iu, 'Everything happens on-device.'],
  // The bare "go", deliberately: this is the witness the `goes?` misspelling
  // fails, and the reason it is written without any other trippable phrase.
  [/never go(?:es)? anywhere/iu, 'Your prompt will never go anywhere else.'],
  [/stays? private/iu, 'Your conversation stays private.'],
  [/to the cloud/iu, 'Nothing is sent to the cloud.'],
];

const LOCALITY_PROMISES: readonly RegExp[] = PATTERN_WITNESSES.map(([pattern]) => pattern);

/**
 * Whole sentences a real screen might plausibly render, which must be rejected
 * by *something*. Unlike the witnesses these are not isolated, and they are not
 * asked to be: they are the realistic shapes, kept as a record of what was
 * actually written and what was actually missed.
 */
const PROMISES_THAT_MUST_BE_CAUGHT: readonly string[] = [
  // The sentence this branch removed.
  'This conversation runs on a-configured-endpoint. Nothing leaves your machine except the request you send it.',
  // The one that falsified this file's own docstring: it passed every test here
  // when the list was six patterns long.
  'Your prompts are processed on-device and never go anywhere else.',
  'This model runs locally.',
  'Your data never goes anywhere.',
];

function textOfEmptyState(modelLabel: string | null): string {
  render(<EmptyConversation capabilities={NOTHING_KNOWN} modelLabel={modelLabel} />);
  return screen.getByRole('list', { name: 'What this model can do' }).parentElement?.textContent ?? '';
}

describe('the empty state promises nothing failover can falsify', () => {
  it('makes no claim about where the request goes', () => {
    const text = textOfEmptyState('a-configured-endpoint');
    const broken = LOCALITY_PROMISES.filter((pattern) => pattern.test(text));
    expect(
      broken.map(String),
      `the empty state promised locality, which failover can contradict: ${text}`,
    ).toEqual([]);
  });

  /**
   * The guard proves it can fail, on every shape it claims to know — including
   * the reviewer's counter-example, which passed when this list was shorter.
   * Without this, a pattern list that had silently stopped matching anything
   * would read as a clean screen.
   */
  it.each(PROMISES_THAT_MUST_BE_CAUGHT)('rejects %s', (sentence) => {
    expect(
      LOCALITY_PROMISES.some((pattern) => pattern.test(sentence)),
      'no pattern in the list objects to this sentence',
    ).toBe(true);
  });

  /**
   * Every pattern earns its place **individually**, against a witness written to
   * trip it and nothing else.
   *
   * This is the assertion that catches a broken entry. The weaker "some pattern
   * objects to each sentence" version does not: a neighbouring pattern covers
   * the hole and the suite stays green while the entry matches nothing it was
   * added for. That was not hypothetical — it is how the `never goes? anywhere`
   * spelling survived a run of this file.
   */
  it.each(PATTERN_WITNESSES)('%s catches the sentence it exists for', (pattern, witness) => {
    expect(pattern.test(witness), `${String(pattern)} does not match ${witness}`).toBe(true);
  });

  /**
   * And no witness is caught by more than one pattern, which is what makes the
   * test above an isolated check rather than a restatement of the pile. If a new
   * pattern starts overlapping an existing witness, that witness stops proving
   * anything about its own entry and must be rewritten.
   */
  it('gives each pattern a witness that only it catches', () => {
    const overlapping = PATTERN_WITNESSES.filter(
      ([, witness]) => LOCALITY_PROMISES.filter((pattern) => pattern.test(witness)).length !== 1,
    ).map(([pattern, witness]) => `${String(pattern)} ← ${witness}`);
    expect(overlapping, 'these witnesses are caught by more than one pattern').toEqual([]);
  });

  /**
   * And the corpus is not doing the work alone: the live text must survive every
   * pattern. Stated separately from the main assertion so that a list which had
   * grown so broad it rejected the honest sentence too fails here rather than
   * looking like a stricter guard.
   */
  it('leaves the sentence that is actually rendered alone', () => {
    const text = textOfEmptyState('a-configured-endpoint');
    expect(LOCALITY_PROMISES.filter((pattern) => pattern.test(text)).map(String)).toEqual([]);
  });

  /**
   * Not hedged into uselessness. The screen still has to be worth reading, so
   * the two claims that *are* true under failover must actually be made:
   *
   *  - Vela reaches no endpoint the user did not configure. True **because** of
   *    how failover works — `ProviderHost::router_for` builds its candidates
   *    from installed configurations and skips the unusable ones — not in spite
   *    of it.
   *  - Vela adds nothing of its own to what is sent (conventions §0 rule 1).
   */
  it('still says the two things that stay true when a turn fails over', () => {
    const text = textOfEmptyState('a-configured-endpoint');
    expect(text).toMatch(/configured/iu);
    expect(text).toMatch(/nothing of its own/iu);
    expect(text).toContain('a-configured-endpoint');
  });

  /**
   * And it points at the correction rather than pretending the case cannot
   * arise. A user who reads this screen and later sees a different endpoint
   * named in the transcript should have been told to expect that.
   */
  it('says a turn will disclose it when another endpoint answers', () => {
    expect(textOfEmptyState('a-configured-endpoint')).toMatch(/answers a turn, that turn says so/iu);
  });

  /**
   * The no-model state has always been honest — it promises nothing — and is
   * asserted so a future edit cannot introduce the claim on the other branch,
   * where none of the assertions above would look at it.
   */
  it('promises nothing on the branch where no model has been chosen', () => {
    const text = textOfEmptyState(null);
    expect(LOCALITY_PROMISES.filter((pattern) => pattern.test(text)).map(String)).toEqual([]);
  });
});
