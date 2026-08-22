/**
 * The way to attach something, chosen by what the model can do.
 *
 * ## The load-bearing behaviour
 *
 * With `vision: false` there is **no image affordance in the DOM**. Not a
 * disabled button, not a greyed icon, not a button that opens a picker and then
 * apologises. A disabled control is a promise the endpoint cannot keep, and the
 * user is left to guess whether it is their file, their model or Vela that is
 * wrong. What remains is a text-file picker, because inlining a `.md` into a
 * prompt is something every model can do — and its accessible name says so.
 *
 * `src/features/attachments/AttachmentControls.test.tsx` asserts the absence
 * directly, by every route a user could reach it: the accessible name, the
 * picker's `accept` list, and the test id.
 */

import { useId, useRef } from 'react';

import { IMAGE_MIME_TYPES, TEXT_EXTENSIONS } from './attachment-rules';
import styles from './AttachmentControls.module.css';

interface AttachmentControlsProps {
  /** Straight off the capability struct. Never a provider id, never a model name. */
  readonly vision: boolean;
  readonly onFiles: (files: readonly File[]) => void;
}

const TEXT_ACCEPT = TEXT_EXTENSIONS.map((extension) => `.${extension}`).join(',');

export function AttachmentControls({ vision, onFiles }: AttachmentControlsProps) {
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();

  const accept = vision ? `${IMAGE_MIME_TYPES.join(',')},${TEXT_ACCEPT}` : TEXT_ACCEPT;

  return (
    <div className={styles.controls}>
      <input
        ref={input}
        id={inputId}
        className={styles.input}
        type="file"
        multiple
        accept={accept}
        data-testid={vision ? 'attachment-picker-with-images' : 'attachment-picker-text-only'}
        onChange={(event) => {
          const chosen = event.target.files;
          if (chosen !== null && chosen.length > 0) onFiles([...chosen]);
          // Reset, so choosing the same file twice in a row still fires.
          event.target.value = '';
        }}
      />
      <button
        type="button"
        className={styles.button}
        {...(vision ? { 'data-testid': 'attach-image' } : {})}
        aria-label={vision ? 'Attach an image or a file' : 'Attach a text file'}
        onClick={() => {
          input.current?.click();
        }}
      >
        {vision ? <ImageGlyph /> : <PaperclipGlyph />}
        <span className={styles.label}>{vision ? 'Image or file' : 'Text file'}</span>
      </button>
    </div>
  );
}

function ImageGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="5.75" cy="6.25" r="1.25" fill="currentColor" />
      <path d="M2 11.5 5.5 8l3 2.5L11 8.5l3 3" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function PaperclipGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none">
      <path
        d="M11 4.5 5.9 9.6a1.6 1.6 0 0 0 2.3 2.3l5.1-5.1a3.2 3.2 0 0 0-4.5-4.5L3.6 7.5a4.8 4.8 0 0 0 6.8 6.8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
