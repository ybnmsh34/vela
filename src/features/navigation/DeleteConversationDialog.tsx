/**
 * Confirmation before a conversation is destroyed.
 *
 * Deleting is irreversible — the store cascades to the messages, their parts
 * and their search-index rows — so it gets a confirmation rather than an undo
 * toast that expires while the user is reading it.
 *
 * `role="alertdialog"` with `aria-modal`, focus moved to Cancel (the safe
 * choice, never the destructive one), Escape cancels, and focus returns to
 * where it came from on close.
 *
 * ## The focus bug that hid inside a correct focus implementation
 *
 * That last clause used to be a plain `restore.focus()`, which is the textbook
 * pattern and was wrong here for a reason specific to this dialog: **the
 * element it remembers is the row it is asking permission to destroy.** Cancel
 * restored correctly; Delete restored focus to a detached node, which the
 * browser answers by focusing `<body>` and saying nothing.
 *
 * `returnFocusTo` is the same pattern with that case answered — it verifies the
 * opener can still take the keyboard and falls to the next rung of the ladder
 * when it cannot. A dialog whose subject is destruction must assume its opener
 * is a corpse.
 *
 * ## And the half of `aria-modal` that was still missing
 *
 * The attribute claimed the sidebar behind this dialog was unreachable while it
 * asked its question. One Shift+Tab off Cancel reached it. The capture, the
 * restore and the containment are all `src/components/ModalSurface.tsx` now —
 * the dialog says what it is about and which control is the safe one, and gets
 * the rest by construction.
 */

import { useRef } from 'react';

import { ModalSurface } from '@/components/ModalSurface';
import type { ConversationSummary } from '@/platform/contract';

import styles from './DeleteConversationDialog.module.css';

interface DeleteConversationDialogProps {
  readonly conversation: ConversationSummary;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function DeleteConversationDialog({
  conversation,
  onCancel,
  onConfirm,
}: DeleteConversationDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <ModalSurface
      role="alertdialog"
      labelledBy="delete-conversation-title"
      describedBy="delete-conversation-body"
      scrimClassName={styles.scrim}
      className={styles.dialog}
      // Cancel, never Delete. Which control the keyboard lands on is a statement
      // about what a reflexive Enter should cost.
      initialFocus={cancelRef}
      onDismiss={onCancel}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <h2 id="delete-conversation-title" className={styles.title}>
        Delete this conversation?
      </h2>
      <p id="delete-conversation-body" className={styles.body}>
        <strong className={styles.name}>{conversation.title}</strong> and everything in it will be
        removed from this device. This cannot be undone.
      </p>
      <div className={styles.actions}>
        <button type="button" ref={cancelRef} className={styles.cancel} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={styles.confirm} onClick={onConfirm}>
          Delete
        </button>
      </div>
    </ModalSurface>
  );
}
