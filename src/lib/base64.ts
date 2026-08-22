/**
 * Bytes → standard base64, for the one place the renderer needs it: an image
 * crossing the IPC boundary.
 *
 * `src-tauri/src/ipc/content.rs` is explicit that `ContentPartDto::Image.data`
 * is **standard base64**, not a `data:` URL and not a byte array — the host
 * decodes it with the same codec its wire encoders use. A renderer that sends
 * `[137, 80, 78, ...]` there is not sending a slightly different shape; it is
 * sending something the host cannot deserialise at all. That mismatch is
 * invisible in a component test and fatal in the application, which is why the
 * conversion lives in one named function with one test rather than inline at a
 * call site.
 *
 * `btoa` is the platform's own encoder and is present in every webview Vela
 * runs in, and in jsdom. It takes a binary string, so the bytes are fed through
 * in chunks: `String.fromCharCode(...bytes)` on a multi-megabyte screenshot
 * blows the argument limit and throws.
 */

/** Large enough to keep the loop short, small enough to stay under the spread limit. */
const CHUNK = 0x8000;

export function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}
