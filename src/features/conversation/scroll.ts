/**
 * When the transcript should follow the stream, and when it must not.
 *
 * Pure, because the rule is the interesting part and a jsdom scroll container
 * would test nothing: a list that yanks you back to the bottom while you are
 * reading three turns up is the most irritating bug a chat UI can have, and it
 * only shows up on a real stream. Keeping the decision here means it can be
 * asserted directly.
 */

export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/**
 * How far from the bottom still counts as "at the bottom".
 *
 * Roughly a line and a half. Small enough that scrolling up to read detaches
 * immediately, large enough to absorb sub-pixel rounding and the browser's own
 * scroll anchoring, which otherwise leaves the container one or two pixels off
 * the bottom and detaches a user who never moved.
 */
export const STICK_THRESHOLD_PX = 48;

export function isPinnedToBottom(
  metrics: ScrollMetrics,
  threshold: number = STICK_THRESHOLD_PX,
): boolean {
  const distance = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  return distance <= threshold;
}

/** A transcript shorter than its viewport is always pinned. */
export function isScrollable(metrics: ScrollMetrics): boolean {
  return metrics.scrollHeight > metrics.clientHeight + 1;
}
