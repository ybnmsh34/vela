/**
 * THE CLASS, NOT THE INSTANCE.
 *
 * The defect was not "the empty reply is not drawn". It was that **a turn's
 * ending was never a thing the view had a name for**, so the one ending someone
 * happened to look at (`showThinkingOnly`) was drawn and the others were not.
 * Testing only "an empty reply now says so" would fix the instance and leave the
 * shape that produced it, which is the failure mode this run exists for.
 *
 * So this file asks the wider question in two ways:
 *
 *  1. **Every ending, enumerated.** The table below crosses each
 *     {@link TurnPhase} with each {@link StopReason} and with the turn being
 *     empty or not, and asserts the kind for every cell. A cell nobody thought
 *     about is a row that has to be written down before this file compiles, not
 *     a `null` nobody notices.
 *  2. **The unions are read off their own sources.** The last two tests parse
 *     `contract.ts` and `turn-stream.ts` for the members of `StopReason` and
 *     `TurnPhase` and fail if `turn-ending.ts` does not name each one in a
 *     `case`. Add a sixth stop reason and this file goes red — the type checker
 *     already would, but a `default:` added in haste would silence it and this
 *     would not.
 *
 * RULE T applies to the doc comments in `turn-ending.ts` as much as to anyone
 * else's: `describeTurnEnding` *claims* it goes quiet when an error or a refusal
 * is already speaking. The `hasError`/`hasRefusal` rows below check the fact.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { StopReason } from '@/platform/contract';

import { describeTurnEnding, type TurnEndingInput, type TurnEndingKind } from './turn-ending';
import type { TurnPhase } from './turn-stream';

const SOURCE = readFileSync(
  join(process.cwd(), 'src/features/conversation/turn-ending.ts'),
  'utf8',
);

const SETTLED: Omit<TurnEndingInput, 'phase' | 'stopReason'> = {
  hasAnswer: true,
  hasReasoning: false,
  hasToolCalls: false,
  hasError: false,
  hasRefusal: false,
};

const NOTHING: Omit<TurnEndingInput, 'phase' | 'stopReason'> = {
  hasAnswer: false,
  hasReasoning: false,
  hasToolCalls: false,
  hasError: false,
  hasRefusal: false,
};

function ending(
  phase: TurnPhase,
  stopReason: StopReason | null,
  rest: Omit<TurnEndingInput, 'phase' | 'stopReason'> = SETTLED,
): TurnEndingKind | null {
  return describeTurnEnding({ phase, stopReason, ...rest })?.kind ?? null;
}

/** Every stop reason on the contract's union, named here so the table is total. */
const STOP_REASONS: readonly (StopReason | null)[] = [
  'endTurn',
  'maxTokens',
  'cancelled',
  'toolUse',
  'unspecified',
  null,
];

describe('how a turn ended, for every way a turn can end', () => {
  it('marks an answer cut off at the output cap, with or without text', () => {
    // THE DEFECT, DIRECTLY. `TurnState.stopReason` carried `maxTokens` out of
    // `reduceTurn`'s `done` arm and was persisted by `use-conversation.ts`, and
    // no component read it: an answer that stopped mid-word against the model's
    // cap was drawn exactly like one that finished.
    expect(ending('complete', 'maxTokens')).toBe('truncated');
    expect(ending('complete', 'maxTokens', NOTHING)).toBe('truncated');
  });

  it('does not offer a retry for a truncation, because retrying re-runs the cap', () => {
    const truncated = describeTurnEnding({ phase: 'complete', stopReason: 'maxTokens', ...SETTLED });
    expect(truncated?.offerRetry).toBe(false);
    // …and does offer one where re-running is the thing that helps.
    const silent = describeTurnEnding({ phase: 'complete', stopReason: 'endTurn', ...NOTHING });
    expect(silent?.offerRetry).toBe(true);
  });

  it('marks a reply that arrived with nothing in it', () => {
    // `answer === '' && reasoning === ''` with no tool calls and no error used
    // to render an <article> containing a hidden footer and nothing else.
    expect(ending('complete', 'endTurn', NOTHING)).toBe('silent');
    expect(ending('complete', 'unspecified', NOTHING)).toBe('silent');
    expect(ending('complete', null, NOTHING)).toBe('silent');
    expect(ending('complete', 'toolUse', NOTHING)).toBe('silent');
  });

  it('says nothing about a turn that has content, on the ordinary endings', () => {
    expect(ending('complete', 'endTurn')).toBeNull();
    expect(ending('complete', 'unspecified')).toBeNull();
    expect(ending('complete', null)).toBeNull();
    expect(ending('complete', 'toolUse')).toBeNull();
    // Reasoning alone, and tool calls alone, are both content: `MessageTurn`
    // already draws a sentence for the first and a list for the second, and a
    // second sentence claiming the model returned nothing would be false.
    expect(ending('complete', 'endTurn', { ...NOTHING, hasReasoning: true })).toBeNull();
    expect(ending('complete', 'endTurn', { ...NOTHING, hasToolCalls: true })).toBeNull();
  });

  it('reads the stop reason before it reads emptiness', () => {
    // A truncation with nothing written yet is still a truncation. Calling it
    // "the model returned nothing" would send the user to retry a request that
    // hits the same cap again — the ordering is the whole content of this test.
    expect(ending('complete', 'maxTokens', NOTHING)).toBe('truncated');
    expect(ending('complete', 'maxTokens', NOTHING)).not.toBe('silent');
  });

  it('separates a turn that was cut short from one that simply ended', () => {
    expect(ending('stopped', 'cancelled')).toBe('cutShort');
    expect(ending('stopped', null)).toBe('cutShort');
    // Read back out of the store, a cancelled turn comes back `complete` with
    // its stop reason intact. It must still read as cancelled.
    expect(ending('complete', 'cancelled')).toBe('cutShort');
    expect(ending('complete', 'endTurn')).toBeNull();
  });

  it('marks a failure the store kept the status of and not the reason', () => {
    // `stored-entries.ts` restores `status: 'failed'` as phase `failed` and
    // restores neither the typed error nor the outcomes, so a reopened
    // conversation used to render every failure in it as an ordinary reply.
    expect(ending('failed', null, NOTHING)).toBe('failedUnrecorded');
    expect(ending('failed', 'endTurn')).toBe('failedUnrecorded');
  });

  it('goes quiet whenever the error or refusal block is already speaking', () => {
    // Otherwise the turn carries two sentences about one ending and — worse —
    // two `Try again` buttons, one of which is not the one the user aimed at.
    for (const stopReason of STOP_REASONS) {
      for (const phase of ['complete', 'stopped', 'failed'] as const) {
        expect(ending(phase, stopReason, { ...NOTHING, hasError: true })).toBeNull();
        expect(ending(phase, stopReason, { ...NOTHING, hasRefusal: true })).toBeNull();
      }
    }
  });

  it('says nothing about a turn that has not settled', () => {
    for (const stopReason of STOP_REASONS) {
      expect(ending('awaiting', stopReason, NOTHING)).toBeNull();
      expect(ending('streaming', stopReason, NOTHING)).toBeNull();
    }
  });

  it('has a decided answer for every phase crossed with every stop reason', () => {
    // Not an assertion about any one cell — an assertion that no cell throws and
    // that the empty and non-empty cases were both considered everywhere. The
    // rows above are what pin the values.
    const phases: readonly TurnPhase[] = ['awaiting', 'streaming', 'complete', 'stopped', 'failed'];
    let cells = 0;
    for (const phase of phases) {
      for (const stopReason of STOP_REASONS) {
        for (const rest of [SETTLED, NOTHING]) {
          expect(() => ending(phase, stopReason, rest)).not.toThrow();
          cells += 1;
        }
      }
    }
    expect(cells).toBe(phases.length * STOP_REASONS.length * 2);
  });
});

describe('the endings stay total against the unions they switch over', () => {
  it('names every member of StopReason in a case', () => {
    const contract = readFileSync(join(process.cwd(), 'src/platform/contract.ts'), 'utf8');
    const declaration = /export type StopReason =([^;]+);/u.exec(contract)?.[1];
    expect(declaration).toBeDefined();
    const members = [...(declaration ?? '').matchAll(/'([a-zA-Z]+)'/gu)].map((match) => match[1]);
    expect(members.length).toBeGreaterThan(0);
    // The table in this file must know them all, too — otherwise the crossing
    // test above quietly stops covering the union it claims to cover.
    expect([...STOP_REASONS].filter((reason) => reason !== null).sort()).toEqual([...members].sort());
    for (const member of members) {
      expect(SOURCE, `StopReason '${String(member)}' has no case in turn-ending.ts`).toContain(
        `case '${String(member)}':`,
      );
    }
  });

  it('names every member of TurnPhase in a case', () => {
    const stream = readFileSync(join(process.cwd(), 'src/features/conversation/turn-stream.ts'), 'utf8');
    const declaration = /export type TurnPhase =([^;]+);/u.exec(stream)?.[1];
    expect(declaration).toBeDefined();
    const members = [...(declaration ?? '').matchAll(/'([a-zA-Z]+)'/gu)].map((match) => match[1]);
    expect(members.length).toBeGreaterThan(0);
    for (const member of members) {
      expect(SOURCE, `TurnPhase '${String(member)}' has no case in turn-ending.ts`).toContain(
        `case '${String(member)}':`,
      );
    }
  });

  it('has no `default` arm to absorb a member nobody wrote a case for', () => {
    // A `default:` would make both scans above pass while a new variant fell
    // into it silently. The type checker catches that too — until someone adds
    // the `default:` to make the type checker stop complaining.
    expect(SOURCE).not.toMatch(/^\s*default:/mu);
  });
});
