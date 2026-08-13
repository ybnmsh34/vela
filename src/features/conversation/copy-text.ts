/**
 * Copying to the clipboard, with an honest failure.
 *
 * The async Clipboard API is not universally available (an insecure context, an
 * older webview, a user who denied the permission), and the difference between
 * "copied" and "silently did nothing" is the whole value of a copy button. So
 * this resolves to a boolean the caller must render, rather than swallowing the
 * failure into a checkmark that lies.
 */
export async function copyText(text: string): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard as
    | { writeText?: (value: string) => Promise<void> }
    | undefined;
  if (typeof clipboard?.writeText !== 'function') return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
