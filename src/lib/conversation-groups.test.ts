import { describe, expect, it } from 'vitest';

import type { ConversationSummary } from '@/platform/contract';

import { activityOf, groupConversationsByRecency } from './conversation-groups';

/** 2026-08-13, 14:00 local. Fixed so "yesterday" is testable in one run. */
const NOW = new Date(2026, 7, 13, 14, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

function conversation(
  id: string,
  lastMessageAtMs: number | null,
  updatedAtMs = lastMessageAtMs ?? NOW,
): ConversationSummary {
  return {
    id,
    title: id,
    createdAtMs: updatedAtMs,
    updatedAtMs,
    lastMessageAtMs,
    messageCount: lastMessageAtMs === null ? 0 : 2,
    titleIsPlaceholder: false,
  };
}

function labels(conversations: readonly ConversationSummary[]): string[] {
  return groupConversationsByRecency(conversations, NOW).map((group) => group.label);
}

describe('grouping conversations by recency', () => {
  it('separates today from yesterday by calendar day, not by 24 hours', () => {
    // 00:10 today and 23:50 yesterday are 20 minutes apart, and belong in
    // different groups — which is exactly what the user means by "yesterday".
    const justAfterMidnight = new Date(2026, 7, 13, 0, 10).getTime();
    const justBeforeMidnight = new Date(2026, 7, 12, 23, 50).getTime();

    const groups = groupConversationsByRecency(
      [conversation('a', justAfterMidnight), conversation('b', justBeforeMidnight)],
      NOW,
    );

    expect(groups.map((group) => [group.label, group.conversations.map((c) => c.id)])).toEqual([
      ['Today', ['a']],
      ['Yesterday', ['b']],
    ]);
  });

  it('orders the buckets newest first and names them', () => {
    expect(
      labels([
        conversation('today', NOW - 60_000),
        conversation('yesterday', NOW - DAY),
        conversation('week', NOW - 4 * DAY),
        conversation('month', NOW - 20 * DAY),
        conversation('june', new Date(2026, 5, 2).getTime()),
        conversation('lastyear', new Date(2025, 10, 2).getTime()),
      ]),
    ).toEqual(['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'June', 'November 2025']);
  });

  it('shows the year only when it is not the current one', () => {
    expect(labels([conversation('a', new Date(2026, 2, 4).getTime())])).toEqual(['March']);
    expect(labels([conversation('b', new Date(2024, 2, 4).getTime())])).toEqual(['March 2024']);
  });

  it('omits empty buckets rather than rendering blank headings', () => {
    expect(labels([conversation('a', NOW - 3 * DAY)])).toEqual(['Previous 7 days']);
    expect(labels([])).toEqual([]);
  });

  it('sorts within a bucket by most recent activity, with the host\'s tiebreak', () => {
    // The host orders `updated_at DESC, id DESC`. Two rows written in the same
    // millisecond must land in the same order here, or the list reshuffles when
    // it is regrouped client-side.
    const same = NOW - 60_000;
    const groups = groupConversationsByRecency(
      [
        conversation('older', NOW - 3600_000),
        conversation('a-tie', same),
        conversation('b-tie', same),
      ],
      NOW,
    );
    expect(groups[0]?.conversations.map((c) => c.id)).toEqual(['b-tie', 'a-tie', 'older']);
  });

  it('files a conversation with nothing said in it by when it was last touched', () => {
    // A brand-new empty conversation must appear at the top of Today, not fall
    // out of the list because it has no messages.
    const empty = conversation('empty', null, NOW - 1000);
    expect(activityOf(empty)).toBe(NOW - 1000);

    const groups = groupConversationsByRecency([empty, conversation('spoken', NOW - DAY)], NOW);
    expect(groups[0]?.label).toBe('Today');
    expect(groups[0]?.conversations[0]?.id).toBe('empty');
  });

  it('treats a future timestamp as clock skew rather than inventing a bucket', () => {
    const groups = groupConversationsByRecency([conversation('skewed', NOW + 5 * DAY)], NOW);
    expect(groups.map((group) => group.label)).toEqual(['Today']);
  });

  it('gives every group a key stable enough to render with', () => {
    const groups = groupConversationsByRecency(
      [conversation('a', NOW), conversation('b', new Date(2025, 10, 2).getTime())],
      NOW,
    );
    expect(groups.map((group) => group.id)).toEqual(['today', 'month-2025-11']);
    expect(new Set(groups.map((group) => group.id)).size).toBe(groups.length);
  });
});
