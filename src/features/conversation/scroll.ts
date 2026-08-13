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

/**
 * How close to an edge still counts as being *at* it, for the scroll mask.
 *
 * Much tighter than {@link STICK_THRESHOLD_PX}, because the two thresholds
 * answer different questions. "Should the transcript follow the stream?" wants
 * slack — a reader who never moved must not be detached by scroll anchoring.
 * "Is there content above this edge?" wants none: a fade that switches off
 * while a line is still hidden above it is the guillotine it exists to remove.
 */
export const EDGE_THRESHOLD_PX = 2;

export interface ScrollEdges {
  readonly atTop: boolean;
  readonly atBottom: boolean;
}

/**
 * Which edges have nothing beyond them.
 *
 * A container that does not scroll is at both edges at once, which is the
 * signal the stylesheet uses to drop the mask entirely — a short transcript has
 * no hidden content to fade towards in either direction.
 */
export function scrollEdges(metrics: ScrollMetrics): ScrollEdges {
  if (!isScrollable(metrics)) return { atTop: true, atBottom: true };
  const fromBottom = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  return {
    atTop: metrics.scrollTop <= EDGE_THRESHOLD_PX,
    atBottom: fromBottom <= EDGE_THRESHOLD_PX,
  };
}
