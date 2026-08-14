/**
 * The one conversion between the provider's content vocabulary and the
 * boundary's.
 *
 * `ContentPartCodec` in `src/platform/contract-harness.ts` explains why this
 * exists and why there is exactly one of it: `ChatResponseBody.parts` is
 * `ContentPart`, `ChatMessageInput.parts` is `ContentPartInput`, and the two
 * differ in **one field** — an image's `data` is a byte array coming out and
 * standard base64 going in. Every other kind is structurally identical, which is
 * what makes it dangerous: a builder who checks two or three kinds concludes the
 * types are the same and writes a cast, and the cast is correct until an image
 * arrives.
 *
 * The conversion is needed twice on every trip round the loop — to persist a
 * turn, and to put the assistant's own turn back into the next request — so
 * there is one implementation and both callers use it. Ten copies would be ten
 * base64 encodings, and they would differ.
 */

import { base64FromBytes } from '@/lib/base64';
import type { ChatResponseBody, ContentPart, ContentPartInput } from '@/platform/contract';
import type { ContentPartCodec } from '@/platform/contract-harness';

function toInput(part: ContentPart): ContentPartInput {
  if (part.kind === 'image') {
    return {
      kind: 'image',
      mimeType: part.mimeType,
      data: base64FromBytes(Uint8Array.from(part.data)),
    };
  }
  // Every remaining kind is assignable as it stands: the input side makes
  // `signature`, `redacted` and `isError` optional, and a required field
  // satisfies an optional one. This is a widening, not a cast — the compiler
  // checks it, which is exactly what a hand-written cast would have removed.
  return part;
}

export const contentPartCodec: ContentPartCodec = {
  toInput,
  turnToInput: (response: ChatResponseBody): readonly ContentPartInput[] =>
    response.parts.map(toInput),
};
