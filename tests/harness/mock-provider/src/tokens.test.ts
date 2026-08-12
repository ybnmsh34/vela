import { describe, expect, it } from 'vitest';

import {
  CHARS_PER_TOKEN,
  TOKENS_PER_IMAGE,
  TOKENS_PER_MESSAGE,
  countImageParts,
  estimatePromptTokens,
  estimateTextTokens,
  textOfContent,
} from './tokens.ts';
import type { ChatMessage } from './wire-types.ts';

describe('the token estimator', () => {
  it('is a fixed function of length, not a tokenizer', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('a')).toBe(1);
    expect(estimateTextTokens('a'.repeat(CHARS_PER_TOKEN))).toBe(1);
    expect(estimateTextTokens('a'.repeat(CHARS_PER_TOKEN + 1))).toBe(2);
    expect(estimateTextTokens('a'.repeat(400))).toBe(100);
  });

  it('charges per-message overhead so short turns are not free', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: '' },
      { role: 'user', content: '' },
    ];
    expect(estimatePromptTokens(messages)).toBe(2 * TOKENS_PER_MESSAGE);
  });

  it('charges a flat cost for each image part', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ];
    expect(countImageParts(messages)).toBe(1);
    expect(estimatePromptTokens(messages)).toBe(TOKENS_PER_MESSAGE + TOKENS_PER_IMAGE);
  });

  it('reads text out of both content shapes and ignores image parts', () => {
    expect(textOfContent('plain')).toBe('plain');
    expect(textOfContent(null)).toBe('');
    expect(
      textOfContent([
        { type: 'text', text: 'one' },
        { type: 'image_url', image_url: { url: 'x' } },
        { type: 'text', text: 'two' },
      ]),
    ).toBe('one\ntwo');
  });
});
