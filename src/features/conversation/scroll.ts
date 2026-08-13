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
 * Where the container belongs after the transcript changed — or `null` for
 * "leave it where the reader put it".
 *
 * Following the stream means the bottom, and that was the only rule: the
 * surface pinned to the bottom on every commit, including the first one, and
 * including the commit that renders an **empty** conversation. That is harmless
 * on a window tall enough for the empty state and it is the 150%-display-scaling
 * defect on a window that is not: at a 1280×672 work area — a 1920×1080 laptop
 * at the Windows 11 default scaling — the empty state is 536px tall in a 447px
 * container, so pinning it to the bottom puts the Vela mark 89px above the top
 * edge on first launch and cuts the heading against the header rule. That is
 * exactly what the desktop session saw, and the numbers here are its measured
 * geometry (`tests/harness/production-bundle/drive-display-scaling.mjs`).
 *
 * There is no stream to follow when there are no entries, so an empty
 * conversation rests at the **top**: it is an introduction, and an introduction
 * is read from its first line.
 */
export function restingScrollTop(
  metrics: ScrollMetrics,
  state: { readonly pinned: boolean; readonly entries: number },
): number | null {
  if (state.entries === 0) return 0;
  if (!state.pinned) return null;
  return metrics.scrollHeight;
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
