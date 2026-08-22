/**
 * The one branch this codec exists for, run.
 *
 * `contentPartCodec` is a widening for six of the seven content kinds and a
 * *conversion* for the seventh: `ContentPart` carries an image as
 * `readonly number[]`, `ContentPartInput` carries it as standard base64, and
 * `contract-harness.ts` says in as many words why that is dangerous — "a builder
 * who checks two or three kinds concludes the types are the same and writes a
 * cast, and the cast is correct until an image arrives".
 *
 * The image branch was the only one no test anywhere ran. Every other test in
 * this directory drives the loop with text and tool calls, which is exactly the
 * two-or-three-kinds check the file's own header warns about — so the warning
 * described this file's coverage as well as the hazard.
 *
 * The encoding asserted here is the one `src-tauri/src/ipc/content.rs` decodes:
 * standard base64, no `data:` prefix and no padding stripped. A byte array sent
 * there is not a slightly different shape, it is something the host cannot
 * deserialise at all — which is invisible in a component test and fatal in the
 * application.
 */

import { describe, expect, it } from 'vitest';

import { base64FromBytes } from '@/lib/base64';
import type { ChatResponseBody, ContentPart } from '@/platform/contract';

import { contentPartCodec } from './content-part-codec';
import { chatResponse } from './run-doubles';

/** The eight-byte PNG signature: real bytes, and none of them ASCII-safe. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function response(parts: readonly ContentPart[]): ChatResponseBody {
  return chatResponse({ parts });
}

describe('the image branch, which is the whole reason this codec exists', () => {
  it('converts a byte array to standard base64 and keeps the mime type', () => {
    const part: ContentPart = { kind: 'image', mimeType: 'image/png', data: [...PNG_MAGIC] };

    expect(contentPartCodec.toInput(part)).toEqual({
      kind: 'image',
      mimeType: 'image/png',
      data: 'iVBORw0KGgo=',
    });
  });

  it('agrees with the one encoder the renderer ships', () => {
    // Not a second base64 implementation: `contract-harness.ts` asks for one
    // conversion so that ten copies cannot become ten encodings, and this is
    // the assertion that the one it uses is `base64FromBytes` — the same
    // function the attachment path puts an image on the wire with.
    const bytes = Array.from({ length: 257 }, (_value, index) => index % 256);
    const converted = contentPartCodec.toInput({
      kind: 'image',
      mimeType: 'image/jpeg',
      data: bytes,
    });

    expect(converted).toEqual({
      kind: 'image',
      mimeType: 'image/jpeg',
      data: base64FromBytes(Uint8Array.from(bytes)),
    });
  });

  it('carries an image through a whole turn, in order, beside the parts it did not convert', () => {
    // The path that actually runs on the loop: `turnToInput` is what persists a
    // turn and what puts the assistant's own turn back into the next request. A
    // codec that converted a lone image and dropped it out of a mixed turn
    // would pass the two assertions above.
    const converted = contentPartCodec.turnToInput(
      response([
        { kind: 'text', text: 'here it is' },
        { kind: 'image', mimeType: 'image/png', data: [...PNG_MAGIC] },
        { kind: 'reasoning', text: 'thought', signature: 'sig', redacted: false },
      ]),
    );

    expect(converted).toEqual([
      { kind: 'text', text: 'here it is' },
      { kind: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
      // Verbatim, signature included: the accumulation rule's second point, and
      // the reason the widening below the image branch is a widening rather
      // than a projection.
      { kind: 'reasoning', text: 'thought', signature: 'sig', redacted: false },
    ]);
  });

  it('does not copy the bytes back out of the input part', () => {
    // The failure a cast would produce, asserted as a negative: `data` on the
    // way in is a string, and anything holding an array here is a payload the
    // host rejects before it reaches a model.
    const converted = contentPartCodec.toInput({
      kind: 'image',
      mimeType: 'image/png',
      data: [...PNG_MAGIC],
    });

    expect(converted.kind).toBe('image');
    expect(typeof (converted as { readonly data: unknown }).data).toBe('string');
  });

  it('leaves an empty image as an empty string rather than refusing it', () => {
    // Zero bytes is a degenerate image and not an error state this seam has any
    // vocabulary for. `btoa('')` is `''`, and passing that on is what lets the
    // host be the one that refuses it.
    expect(contentPartCodec.toInput({ kind: 'image', mimeType: 'image/png', data: [] })).toEqual({
      kind: 'image',
      mimeType: 'image/png',
      data: '',
    });
  });
});

describe('every other kind widens rather than converting', () => {
  it('passes text, tool calls and tool results through unchanged', () => {
    const parts: readonly ContentPart[] = [
      { kind: 'text', text: 'answer' },
      { kind: 'toolCall', callId: 'c1', name: 'spawn_subagent', arguments: { task: 'go' } },
      { kind: 'toolResult', callId: 'c1', content: 'done', isError: false },
    ];

    expect(contentPartCodec.turnToInput(response(parts))).toEqual(parts);
  });

  it('turns an empty turn into an empty list', () => {
    expect(contentPartCodec.turnToInput(response([]))).toEqual([]);
  });
});
