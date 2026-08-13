/**
 * The composer.
 *
 * ## Keyboard contract
 *
 * | Key | Effect |
 * |---|---|
 * | `Enter` | send |
 * | `Shift+Enter` | newline |
 * | `Escape` | stop the stream in flight (and nothing at all when idle) |
 *
 * `Enter` during IME composition inserts, it does not send. Without that check
 * every Japanese, Chinese and Korean user sends a half-converted fragment the
 * first time they press Enter to accept a candidate — the single most common
 * way a chat composer is broken for a large fraction of its users.
 *
 * ## Capability gating
 *
 * Affordances are rendered from the capability struct, never from a model or
 * backend name. A model with no vision gets **no attach control at all** —
 * not a disabled one. A disabled button is a promise the endpoint cannot keep.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

import type { ChatCapabilities } from '@/platform/contract';
import { useFocusAnchor } from '@/state/focus-store';

import styles from './Composer.module.css';

const MAX_TEXTAREA_HEIGHT = 320;

interface ComposerProps {
  readonly capabilities: ChatCapabilities;
  readonly streaming: boolean;
  /** Blocks sending, e.g. no model chosen yet. `null` when sending is fine. */
  readonly blockedReason: string | null;
  readonly onSend: (text: string) => void;
  readonly onCancel: () => void;
  /**
   * The draft, on every change and on send.
   *
   * The composer keeps owning its own text — an editor whose value round-trips
   * through a parent is an editor that drops characters the moment anything
   * above it re-renders slowly. What travels upward is a *copy*, for surfaces
   * that need to know what the turn currently weighs. Without it the context
   * meter measures an empty string forever, which is exactly what it did.
   */
  readonly onDraftChange?: ((text: string) => void) | undefined;
}

export function Composer({
  capabilities,
  streaming,
  blockedReason,
  onSend,
  onCancel,
  onDraftChange,
}: ComposerProps) {
  const [text, setText] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);

  /**
   * The composer is where a chat application's keyboard lives, so it is the
   * first rung of the focus ladder every overlay falls back to when the thing
   * it was opened from is gone (`src/state/focus-store.ts`). Registering it
   * here rather than naming it from the overlays keeps the knowledge in one
   * place: this component knows it is the message box; nothing else has to.
   */
  const anchor = useFocusAnchor<HTMLTextAreaElement>('composer');
  const attach = useCallback(
    (node: HTMLTextAreaElement | null) => {
      textarea.current = node;
      anchor(node);
    },
    [anchor],
  );

  const change = (next: string): void => {
    setText(next);
    onDraftChange?.(next);
  };

  // Grow with the content, up to a ceiling, then scroll inside. Layout effect
  // so the height is corrected in the same frame the text changed — measuring
  // in a passive effect makes the box visibly jump one frame late.
  useLayoutEffect(() => {
    const node = textarea.current;
    if (node === null) return;
    node.style.height = 'auto';
    node.style.height = `${String(Math.min(node.scrollHeight, MAX_TEXTAREA_HEIGHT))}px`;
  }, [text]);

  // Focus follows the end of a stream: after a reply lands, the next thing the
  // user does is type.
  useEffect(() => {
    if (!streaming) textarea.current?.focus();
  }, [streaming]);

  const canSend = text.trim() !== '' && blockedReason === null && !streaming;

  const send = (): void => {
    if (!canSend) return;
    onSend(text.trim());
    change('');
    // Focus stays in the box, including when the send came from the button.
    // Otherwise focus lands on Send, and `Escape` — the documented way to stop
    // the stream that just started — goes nowhere.
    textarea.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape' && streaming) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== 'Enter') return;
    // `nativeEvent.isComposing` is the reliable signal; `keyCode === 229` is
    // the older one some webviews still send.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.shiftKey || event.altKey) return;
    event.preventDefault();
    send();
  };

  return (
    <form
      className={styles.composer}
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <div className={styles.field}>
        <label className={styles.srOnly} htmlFor="vela-composer">
          Message
        </label>
        <textarea
          id="vela-composer"
          ref={attach}
          className={styles.input}
          rows={1}
          value={text}
          placeholder={blockedReason ?? 'Send a message…'}
          disabled={blockedReason !== null}
          onChange={(event) => {
            change(event.target.value);
          }}
          onKeyDown={onKeyDown}
        />

        <div className={styles.actions}>
          {/* Rendered only when the capability struct says the model takes
              images. Never gated on a backend identity. */}
          {capabilities.vision ? (
            <button type="button" className={styles.iconButton} aria-label="Attach an image">
              <ImageGlyph />
            </button>
          ) : null}

          {streaming ? (
            <button type="button" className={styles.stop} onClick={onCancel}>
              Stop
            </button>
          ) : (
            <button type="submit" className={styles.send} disabled={!canSend}>
              Send
            </button>
          )}
        </div>
      </div>

      <p className={styles.hint}>
        {streaming ? (
          <>
            <kbd>Esc</kbd> to stop
          </>
        ) : (
          <>
            <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
          </>
        )}
      </p>
    </form>
  );
}

function ImageGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="5.75" cy="6.25" r="1.25" fill="currentColor" />
      <path d="M2 11.5 5.5 8l3 2.5L11 8.5l3 3" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
