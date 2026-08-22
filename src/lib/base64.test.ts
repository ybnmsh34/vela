/**
 * The encoder that decides whether an attached image survives the trip.
 *
 * Every vector here is written out rather than computed — a test that encodes
 * with the function it is testing proves the function agrees with itself.
 */

import { describe, expect, it } from 'vitest';

import { base64FromBytes } from './base64';

describe('base64FromBytes', () => {
  it('encodes the standard alphabet, including padding at both lengths', () => {
    expect(base64FromBytes(new Uint8Array([]))).toBe('');
    expect(base64FromBytes(new Uint8Array([1]))).toBe('AQ==');
    expect(base64FromBytes(new Uint8Array([1, 2]))).toBe('AQI=');
    expect(base64FromBytes(new Uint8Array([1, 2, 3]))).toBe('AQID');
  });

  it('encodes a PNG header — the bytes an attached screenshot actually starts with', () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52,
    ]);
    expect(base64FromBytes(png)).toBe('iVBORw0KGgoAAAANSUhEUg==');
  });

  it('uses `+` and `/`, not the URL-safe alphabet', () => {
    // 0xFB 0xFF 0xFE is `+//+`. The host decodes both alphabets, but the
    // boundary is documented as standard base64 and a wire format that drifts
    // by encoder is a wire format with two meanings.
    expect(base64FromBytes(new Uint8Array([0xfb, 0xff, 0xbe]))).toBe('+/++');
  });

  it('survives a payload past the argument-spread limit', () => {
    // `String.fromCharCode(...bytes)` throws on a real screenshot. The chunking
    // is the only reason this function works on anything worth attaching, so it
    // is exercised rather than assumed: 200,000 bytes is a small PNG.
    const big = new Uint8Array(200_000).fill(0);
    const encoded = base64FromBytes(big);
    expect(encoded).toHaveLength(Math.ceil(200_000 / 3) * 4);
    expect(encoded.startsWith('AAAAAAAA')).toBe(true);
  });
});
