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
 */

import { useEffect, useRef } from 'react';

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
  const returnFocusTo = useRef<Element | null>(null);

  useEffect(() => {
    returnFocusTo.current = document.activeElement;
    cancelRef.current?.focus();
    const restore = returnFocusTo.current;
    return () => {
      if (restore instanceof HTMLElement) restore.focus();
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
