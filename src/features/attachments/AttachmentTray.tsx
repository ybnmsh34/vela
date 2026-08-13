/**
 * What is staged for the next message, and how to take it back out.
 *
 * Removal is a real button with a real accessible name per file, not an "×" the
 * screen reader calls "button". Attachments are the thing a user most often
 * changes their mind about, and a tray you cannot undo is a tray you stop using.
 *
 * Refusals live here too rather than in a toast that vanishes. A file the user
 * dropped and did not get is exactly the thing they need told, and it must stay
 * on screen until they have read it.
 */

import { formatBytes } from './attachment-rules';
import { refusalText, type RefusedAttachment, type StagedAttachment } from './use-attachments';
import styles from './AttachmentTray.module.css';

interface AttachmentTrayProps {
  readonly attachments: readonly StagedAttachment[];
  readonly refused: readonly RefusedAttachment[];
  readonly onRemove: (id: string) => void;
  readonly onDismissRefusals: () => void;
}

export function AttachmentTray({
  attachments,
  refused,
  onRemove,
  onDismissRefusals,
}: AttachmentTrayProps) {
  if (attachments.length === 0 && refused.length === 0) return null;

  return (
    <div className={styles.tray} data-testid="attachment-tray">
      {attachments.length === 0 ? null : (
        <ul className={styles.list} aria-label="Attached files">
          {attachments.map((attachment) => (
            <li key={attachment.id} className={styles.chip}>
              {attachment.previewUrl === null ? (
                <span className={styles.glyph} aria-hidden="true">
                  {attachment.kind === 'image' ? 'IMG' : 'TXT'}
                </span>
              ) : (
                <img
                  className={styles.preview}
                  src={attachment.previewUrl}
                  alt={`Preview of ${attachment.name}`}
                />
              )}
              <span className={styles.meta}>
                <span className={styles.name}>{attachment.name}</span>
                <span className={styles.size}>{formatBytes(attachment.size)}</span>
              </span>
              <button
                type="button"
                className={styles.remove}
                aria-label={`Remove ${attachment.name}`}
                onClick={() => {
                  onRemove(attachment.id);
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {refused.length === 0 ? null : (
        <div className={styles.refusals} role="status">
          <ul className={styles.refusalList}>
            {refused.map((refusal, index) => (
              <li key={`${refusal.name}-${refusal.reason}-${String(index)}`}>
                {refusalText(refusal)}
              </li>
            ))}
          </ul>
          <button type="button" className={styles.dismiss} onClick={onDismissRefusals}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
