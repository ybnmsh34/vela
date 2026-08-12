import { describe, expect, it } from 'vitest';

import {
  SSE_DONE_FRAME,
  encodeSseComment,
  encodeSseData,
  encodeSseRaw,
  parseSseFrames,
} from './sse.ts';

describe('SSE framing', () => {
  it('round-trips a well-formed frame', () => {
    const raw = encodeSseData({ hello: 'world' });
    expect(raw).toBe('data: {"hello":"world"}\n\n');
    const events = parseSseFrames(raw);
    expect(events).toHaveLength(1);
    expect(events[0]?.json).toEqual({ hello: 'world' });
    expect(events[0]?.parseError).toBeNull();
  });

  it('surfaces a broken payload instead of hiding or throwing on it', () => {
    const events = parseSseFrames(encodeSseRaw('{"truncated": '));
    expect(events).toHaveLength(1);
    expect(events[0]?.json).toBeNull();
    expect(events[0]?.parseError).not.toBeNull();
    // The exact bytes survive, so a transcript shows what really arrived.
    expect(events[0]?.data).toBe('{"truncated": ');
  });

  it('skips comment frames the way EventSource does', () => {
    const events = parseSseFrames(encodeSseComment('keepalive') + encodeSseData({ a: 1 }));
    expect(events).toHaveLength(1);
    expect(events[0]?.json).toEqual({ a: 1 });
  });

  it('recognises the [DONE] sentinel without trying to parse it', () => {
    const events = parseSseFrames(SSE_DONE_FRAME);
    expect(events[0]?.done).toBe(true);
    expect(events[0]?.parseError).toBeNull();
  });

  it('returns nothing for a body that never contained a data field', () => {
    expect(parseSseFrames('')).toEqual([]);
    expect(parseSseFrames(': only a comment\n\n')).toEqual([]);
  });
});
