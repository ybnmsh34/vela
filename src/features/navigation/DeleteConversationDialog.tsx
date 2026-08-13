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
 */

import { useEffect, useRef } from 'react';

import type { ConversationSummary } from '@/platform/contract';
import { returnFocusTo } from '@/state/focus-store';

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

  useEffect(() => {
    const restore = document.activeElement;
    cancelRef.current?.focus();
    return () => {
      returnFocusTo(restore);
    };
  }, []);

  return (
    <div
      className={styles.scrim}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-conversation-title"
        aria-describedby="delete-conversation-body"
        className={styles.dialog}
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
      </div>
    </div>
  );
}
