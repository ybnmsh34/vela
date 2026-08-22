import { describe, expect, it } from 'vitest';

import {
  EDGE_THRESHOLD_PX,
  isPinnedToBottom,
  isScrollable,
  restingScrollTop,
  scrollEdges,
  STICK_THRESHOLD_PX,
} from './scroll';

describe('transcript autoscroll', () => {
  it('is pinned when the container is at the bottom', () => {
    expect(isPinnedToBottom({ scrollTop: 800, scrollHeight: 1400, clientHeight: 600 })).toBe(true);
  });

  it('stays pinned within the threshold, so rounding does not detach a still reader', () => {
    expect(
      isPinnedToBottom({
        scrollTop: 800 - STICK_THRESHOLD_PX,
        scrollHeight: 1400,
        clientHeight: 600,
      }),
    ).toBe(true);
  });

  it('detaches as soon as the reader scrolls up past the threshold', () => {
    expect(
      isPinnedToBottom({
        scrollTop: 800 - STICK_THRESHOLD_PX - 1,
        scrollHeight: 1400,
        clientHeight: 600,
      }),
    ).toBe(false);
  });

  it('treats a transcript shorter than the viewport as pinned', () => {
    const metrics = { scrollTop: 0, scrollHeight: 300, clientHeight: 600 };
    expect(isScrollable(metrics)).toBe(false);
    expect(isPinnedToBottom(metrics)).toBe(true);
  });
});

/**
 * The scroll mask asks a different question from the autoscroll rule, and the
 * two must not share a threshold. "Should the transcript follow the stream?"
 * wants slack. "Is there a line of text hidden above this edge?" wants none —
 * a fade that switches off while content is still hidden is the hard cut it
 * exists to remove, just moved 48px.
 */
describe('which scroll edges have nothing beyond them', () => {
  it('reports the top edge only when the transcript is actually at the top', () => {
    expect(scrollEdges({ scrollTop: 0, scrollHeight: 1400, clientHeight: 600 }).atTop).toBe(true);
    expect(
      scrollEdges({ scrollTop: EDGE_THRESHOLD_PX + 1, scrollHeight: 1400, clientHeight: 600 }).atTop,
    ).toBe(false);
  });

  it('reports the bottom edge only when the transcript is actually at the bottom', () => {
    expect(scrollEdges({ scrollTop: 800, scrollHeight: 1400, clientHeight: 600 }).atBottom).toBe(
      true,
    );
    expect(
      scrollEdges({ scrollTop: 700, scrollHeight: 1400, clientHeight: 600 }).atBottom,
    ).toBe(false);
  });

  it('does not borrow the autoscroll threshold, which would unmask too early', () => {
    // 48px above the bottom is still "pinned" — and still hiding two lines.
    const metrics = { scrollTop: 800 - STICK_THRESHOLD_PX, scrollHeight: 1400, clientHeight: 600 };
    expect(isPinnedToBottom(metrics)).toBe(true);
    expect(scrollEdges(metrics).atBottom).toBe(false);
  });

  it('rests an empty conversation at the top, not at the bottom', () => {
    // The 150%-display-scaling defect, in one line. These are the measured
    // numbers from a 1920×1080 laptop at the Windows 11 default scaling: a
    // 536px empty state in a 447px container. Resting it at the bottom puts the
    // Vela mark 89px above the top edge on first launch — "the mark disappears
    // and the heading jams against the header rule".
    const overflowing = { scrollTop: 0, scrollHeight: 536, clientHeight: 447 };
    expect(restingScrollTop(overflowing, { pinned: true, entries: 0 })).toBe(0);
    // And it is the *emptiness* that decides, not the overflow: a conversation
    // with turns in it still follows the stream.
    expect(restingScrollTop(overflowing, { pinned: true, entries: 1 })).toBe(536);
  });

  it('leaves a reader who scrolled up exactly where they are', () => {
    const metrics = { scrollTop: 120, scrollHeight: 1400, clientHeight: 600 };
    expect(restingScrollTop(metrics, { pinned: false, entries: 4 })).toBeNull();
    // Except when there is nothing to follow at all, where the top is the only
    // sensible answer and there is nothing to lose by taking it.
    expect(restingScrollTop(metrics, { pinned: false, entries: 0 })).toBe(0);
  });

  it('calls a transcript shorter than its viewport both edges at once', () => {
    // Which is the signal the stylesheet uses to drop the mask entirely: there
    // is nothing hidden in either direction to fade towards.
    expect(scrollEdges({ scrollTop: 0, scrollHeight: 300, clientHeight: 600 })).toEqual({
      atTop: true,
      atBottom: true,
    });
  });
});
