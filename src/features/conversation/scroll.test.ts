import { describe, expect, it } from 'vitest';

import { isPinnedToBottom, isScrollable, STICK_THRESHOLD_PX } from './scroll';

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
