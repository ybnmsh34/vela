/**
 * Recency grouping for the conversation list.
 *
 * A pure function of (conversations, now). No adapter, no React, no ambient
 * clock — the current time arrives as an argument, which is the only reason
 * "yesterday" is testable without waiting a day.
 *
 * The bucket boundaries are **calendar days in the viewer's local timezone**,
 * not fixed 24-hour windows. A message sent at 23:50 is "yesterday" at 00:10
 * the next morning, because that is what the user means by yesterday.
 */

import type { ConversationSummary } from '@/platform/contract';

export interface ConversationGroup {
  /** Stable key: safe as a React key and as a test handle. */
  readonly id: string;
  readonly label: string;
  readonly conversations: readonly ConversationSummary[];
}

/**
 * When a conversation last mattered. Falls back to `updatedAtMs` for a
 * conversation that has been opened, or renamed, but never spoken in — those
 * belong at the top of the list they were just created in, not at the bottom.
 */
export function activityOf(conversation: ConversationSummary): number {
  return conversation.lastMessageAtMs ?? conversation.updatedAtMs;
}

/**
 * English month names, written out rather than taken from `Intl`.
 *
 * The label has to be identical in a test runner, in a headless screenshot and
 * on a user's machine; `Intl.DateTimeFormat` depends on the ICU data the build
 * happens to carry, and a Node built with `small-icu` silently produces
 * different strings. When Vela is localised this is one of the strings that
 * moves into the catalogue — not into `Intl`.
 */
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function groupConversationsByRecency(
  conversations: readonly ConversationSummary[],
  nowMs: number,
): ConversationGroup[] {
  const today = startOfLocalDay(nowMs);
  const yesterday = startOfLocalDay(today - DAY_MS);
  const lastWeek = today - 6 * DAY_MS;
  const lastMonth = today - 29 * DAY_MS;
  const now = new Date(nowMs);
  const thisYear = now.getFullYear();
  const monthsNow = thisYear * 12 + now.getMonth();

  const groups = new Map<string, { label: string; order: number; items: ConversationSummary[] }>();

  const sorted = [...conversations].sort(
    // `id` breaks ties so two conversations written in the same millisecond
    // still list in a stable order, matching the host's own tiebreak.
    (a, b) => activityOf(b) - activityOf(a) || (a.id < b.id ? 1 : -1),
  );

  for (const conversation of sorted) {
    const at = activityOf(conversation);
    // A timestamp in the future is clock skew, not a category. It sorts first
    // and lands in "Today" rather than inventing a "Later" heading.
    let key: string;
    let label: string;
    let order: number;

    if (at >= today) {
      [key, label, order] = ['today', 'Today', 0];
    } else if (at >= yesterday) {
      [key, label, order] = ['yesterday', 'Yesterday', 1];
    } else if (at >= lastWeek) {
      [key, label, order] = ['previous-7-days', 'Previous 7 days', 2];
    } else if (at >= lastMonth) {
      [key, label, order] = ['previous-30-days', 'Previous 30 days', 3];
    } else {
      const date = new Date(at);
      const year = date.getFullYear();
      const month = date.getMonth();
      const name = MONTHS[month] ?? '';
      key = `month-${year}-${String(month + 1).padStart(2, '0')}`;
      // The year is shown only when it is not the current one: "March" reads
      // better than "March 2026" for eleven months of the year, and "March 2025"
      // is essential for the twelfth.
      label = year === thisYear ? name : `${name} ${year}`;
      // Rank 4 and up, ascending with age, so every month bucket sorts after
      // the four relative ones and the recent months come first.
      order = 4 + Math.max(0, monthsNow - (year * 12 + month));
    }

    const group = groups.get(key) ?? { label, order, items: [] };
    group.items.push(conversation);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .sort(([, a], [, b]) => a.order - b.order)
    .map(([id, group]) => ({ id, label: group.label, conversations: group.items }));
}
