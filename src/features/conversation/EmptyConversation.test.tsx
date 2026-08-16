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
 * The assertions below are deliberately about the shape of the claim rather than
 * its exact prose. Pinning the sentence would make every copy edit a test
 * change and would pin nothing that matters; pinning "does not promise locality"
 * survives rewording and fails the moment someone reaches for the reassuring
 * phrasing again.
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
 * Claims about where bytes go, which this surface cannot observe and failover
 * can contradict. Matched case-insensitively against the whole rendered text.
 *
 * `stays on`/`stay on` and `leaves your` are the two shapes the original
 * sentence and its obvious rewrites take. `local` is here because "runs
 * locally" is the same promise in one word — Vela cannot know that a configured
 * endpoint is local, and the fallback it reaches for may not be.
 */
const LOCALITY_PROMISES: readonly RegExp[] = [
  /leaves? your machine/iu,
  /stays? on (?:your|this) (?:machine|computer|device)/iu,
  /never leaves/iu,
  /\bruns? locally\b/iu,
  /\bstays? local\b/iu,
  /\boffline\b/iu,
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
   * The guard proves it can fail, on the exact sentence that was there. Without
   * this, a pattern list that had silently stopped matching anything would read
   * as a clean screen.
   */
  it('would have caught the sentence it replaced', () => {
    const original =
      'This conversation runs on a-configured-endpoint. Nothing leaves your machine except the request you send it.';
    expect(LOCALITY_PROMISES.some((pattern) => pattern.test(original))).toBe(true);
    expect(LOCALITY_PROMISES.some((pattern) => pattern.test('This model runs locally.'))).toBe(true);
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
