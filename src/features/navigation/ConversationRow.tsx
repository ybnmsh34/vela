/**
 * One conversation in the sidebar.
 *
 * Renaming happens **in place**: the row becomes a text field, Enter commits,
 * Escape restores. A modal for a one-field edit is a modal too many, and an
 * in-place field keeps the row's position in the list visible while you retitle
 * it, which is how you can tell you are renaming the right one.
 *
 * The row is a button, not a link: there is no URL, and a link that goes
 * nowhere is a lie told to a screen reader.
 *
 * ## Where the keyboard goes when the field closes
 *
 * The field takes focus when it opens and used to take it with it when it
 * closed: committing an F2 rename left focus on `<body>`, seven Tab presses
 * from the composer, and the arrow keys that walk the list were gone one rename
 * in. The row button is the deliberate destination — you renamed *this* row, so
 * this row is where you still are.
 *
 * The one case that must **not** restore is a rename ended by clicking
 * somewhere else. `relatedTarget` on the blur is what tells the two apart: a
 * non-null value means the user chose where to go next, and taking it back
 * would be the same defect pointed the other way.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import type { ConversationSummary } from '@/platform/contract';
import { returnFocusTo, useKeyboardHandoff } from '@/state/focus-store';

import styles from './ConversationRow.module.css';

interface ConversationRowProps {
  readonly conversation: ConversationSummary;
  readonly selected: boolean;
  /** Roving tabindex: exactly one row in the list is tabbable at a time. */
  readonly tabbable: boolean;
  readonly onSelect: () => void;
  readonly onRename: (title: string) => void;
  readonly onRequestDelete: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly registerRef: (element: HTMLButtonElement | null) => void;
}

export function ConversationRow({
  conversation,
  selected,
  tabbable,
  onSelect,
  onRename,
  onRequestDelete,
  onKeyDown,
  registerRef,
}: ConversationRowProps) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(conversation.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLButtonElement | null>(null);
  /** Set by whichever exit is meant to hand the keyboard back to the row. */
  const restoreOnClose = useRef(false);

  // A row is the one thing in this app that gets destroyed while the user is
  // standing on it. The delete dialog cannot cover that — it closes one commit
  // before the list reloads — so the row itself hands the keyboard on.
  useKeyboardHandoff();

  useEffect(() => {
    if (renaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }
    if (!restoreOnClose.current) return;
    restoreOnClose.current = false;
    // The ladder, not `mainRef.current.focus()`: a rename can move the row
    // between recency groups, and a rename of the *last* conversation in a
    // filtered list can take it off screen entirely. Either way the button this
    // ref points at may be gone by now.
    returnFocusTo(mainRef.current);
  }, [renaming]);

  function startRenaming(): void {
    setDraft(conversation.title);
    setRenaming(true);
  }

  function commit(restoreFocus: boolean): void {
    const title = draft.trim();
    restoreOnClose.current = restoreFocus;
    setRenaming(false);
    // An unchanged or emptied title is a cancel, not a command. The host would
    // reject the blank one anyway; not sending it keeps the error surface for
    // failures the user can act on.
    if (title !== '' && title !== conversation.title) onRename(title);
  }

  if (renaming) {
    return (
      <li className={`${styles.row} ${styles.renaming}`}>
        <form
          className={styles.renameForm}
          onSubmit={(event) => {
            event.preventDefault();
            commit(true);
          }}
        >
          <input
            ref={inputRef}
            className={styles.renameInput}
            aria-label={`Rename ${conversation.title}`}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onBlur={(event) => {
              // Focus went somewhere the user chose: commit, and leave it there.
              // Focus went nowhere: commit, and take the row back.
              commit(event.relatedTarget === null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                restoreOnClose.current = true;
                setRenaming(false);
              }
              // Arrow keys belong to the text cursor while a field is open.
              event.stopPropagation();
            }}
          />
        </form>
      </li>
    );
  }

  return (
    <li className={`${styles.row} ${selected ? styles.selected : ''}`}>
      <button
        type="button"
        ref={(node) => {
          mainRef.current = node;
          registerRef(node);
        }}
        className={styles.main}
        tabIndex={tabbable ? 0 : -1}
        // Explicit, because the row's text content is the title plus its
        // message count, and "Star charts 3 messages" is a clumsy thing for a
        // screen reader to announce — and an ambiguous thing to query in a test
        // when "Rename Star charts" is sitting beside it.
        aria-label={`Open ${conversation.title}`}
        aria-current={selected ? 'page' : undefined}
        onClick={onSelect}
        onDoubleClick={startRenaming}
        onKeyDown={(event) => {
          if (event.key === 'F2') {
            event.preventDefault();
            startRenaming();
            return;
          }
          onKeyDown(event);
        }}
      >
        <span className={styles.title}>{conversation.title}</span>
        <span className={styles.meta}>
          {conversation.messageCount === 0
            ? 'Nothing said yet'
            : `${conversation.messageCount} message${conversation.messageCount === 1 ? '' : 's'}`}
        </span>
      </button>

      <span className={styles.actions}>
        <button
          type="button"
          className={styles.action}
          tabIndex={-1}
          aria-label={`Rename ${conversation.title}`}
          onClick={startRenaming}
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
            <path
              d="M11.2 2.3 13.7 4.8 5.9 12.6 2.6 13.4 3.4 10.1z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          className={styles.action}
          tabIndex={-1}
          aria-label={`Delete ${conversation.title}`}
          onClick={onRequestDelete}
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
            <path
              d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8.2h4.8L11 4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </span>
    </li>
  );
}
