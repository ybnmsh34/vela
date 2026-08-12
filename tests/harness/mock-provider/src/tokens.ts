/**
 * A deterministic token estimator.
 *
 * It is NOT a tokenizer and does not pretend to be one — it is a stable,
 * documented function of the input so that "this prompt overflows a 4k window"
 * is reproducible to the byte. Consumers must treat the numbers as this
 * harness's arithmetic, never as evidence about any real model's tokenizer.
 */

import type { ChatMessage, ContentPart } from './wire-types.ts';

/** Four characters per token — the usual rule of thumb, fixed here forever. */
export const CHARS_PER_TOKEN = 4;

/** Per-message framing overhead (role markers, separators). */
export const TOKENS_PER_MESSAGE = 4;

/**
 * Flat cost for one image part, matching the low-detail tile cost real vision
 * endpoints quote. Only profiles with `vision: true` ever get this far.
 */
export const TOKENS_PER_IMAGE = 85;

export function estimateTextTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function textOfContent(content: string | readonly ContentPart[] | null): string {
  if (content === null) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

export function countImageParts(messages: readonly ChatMessage[]): number {
  let count = 0;
  for (const message of messages) {
    const content = message.content;
    if (content === null || typeof content === 'string') {
      continue;
    }
    for (const part of content) {
      if (part.type === 'image_url') {
        count += 1;
      }
    }
  }
  return count;
}

export function estimatePromptTokens(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += TOKENS_PER_MESSAGE;
    total += estimateTextTokens(textOfContent(message.content));
    for (const call of message.tool_calls ?? []) {
      total += estimateTextTokens(call.function.name + call.function.arguments);
    }
  }
  total += countImageParts(messages) * TOKENS_PER_IMAGE;
  return total;
}
