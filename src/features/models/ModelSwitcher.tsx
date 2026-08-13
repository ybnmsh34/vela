/**
 * The model switcher.
 *
 * Lists every configured endpoint and the models it offers, says which one is
 * active, and switches. Rows the user cannot choose stay visible with the
 * reason attached — a switcher that silently omits the endpoint you just set up
 * is a switcher that makes you doubt you set it up.
 *
 * Nothing here knows what a backend is. Labels come from the user's own
 * configuration or from what the endpoint called its model; every branch is on
 * a flag the host computed.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';

import type { ModelSelection } from '@/state/model-store';

import { entryKey, isSelectable, selectionOf, type EntryBlock, type ModelEntry } from './catalogue';
import styles from './ModelSwitcher.module.css';

interface ModelSwitcherProps {
  readonly entries: readonly ModelEntry[];
  readonly selection: ModelSelection | null;
  /** Whether the open conversation already has turns in it. */
  readonly hasHistory: boolean;
  readonly onSelect: (selection: ModelSelection, hasHistory: boolean) => void;
  /** Ask an endpoint to enumerate its models. Absent = do not offer it. */
  readonly onDiscover?: (providerId: string) => void;
  /** Opens the endpoint configuration surface. */
  readonly onConfigure?: () => void;
}

const BLOCK_TEXT: Record<EntryBlock, string> = {
  noModelChosen: 'No model named yet',
  credentialRequired: 'Needs a key before it can be used',
};

export function ModelSwitcher({
  entries,
  selection,
  hasHistory,
  onSelect,
  onDiscover,
  onConfigure,
}: ModelSwitcherProps) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const listId = useId();

  const close = useCallback(() => {
    setOpen(false);
  }, []);

  // Escape closes, and a click anywhere else does too. Both are registered only
  // while the popover is up, so an idle switcher costs the document nothing.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    const onPointerDown = (event: MouseEvent): void => {
      if (!container.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open, close]);

  const activeLabel =
    selection === null ? 'Choose a model' : `${selection.providerLabel} · ${selection.modelLabel}`;

  return (
    <div className={styles.switcher} ref={container}>
      <button
        type="button"
        className={styles.trigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => {
          setOpen((wasOpen) => !wasOpen);
        }}
      >
        <span className={styles.triggerLabel}>{activeLabel}</span>
        <ChevronGlyph />
      </button>

      {open ? (
        <div className={styles.popover}>
          <ul className={styles.list} id={listId} role="listbox" aria-label="Models">
            {entries.length === 0 ? (
              <li className={styles.empty}>
                No endpoints configured yet. Add one to start a conversation.
              </li>
            ) : (
              entries.map((entry) => {
                const key = entryKey(entry);
                const active =
                  selection !== null &&
                  selection.providerId === entry.providerId &&
                  selection.modelId === entry.modelId;
                const selectable = isSelectable(entry);
                return (
                  <li key={key}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      disabled={!selectable}
                      className={`${styles.option} ${active ? styles.optionActive : ''}`}
                      onClick={() => {
                        const next = selectionOf(entry);
                        if (next === null) return;
                        onSelect(next, hasHistory);
                        close();
                      }}
                    >
                      <span className={styles.optionMain}>
                        <span className={styles.optionModel}>
                          {entry.modelLabel ?? 'No model named'}
                        </span>
                        <span className={styles.optionProvider}>{entry.providerLabel}</span>
                      </span>
                      {entry.blocked === null ? null : (
                        <span className={styles.optionBlocked}>{BLOCK_TEXT[entry.blocked]}</span>
                      )}
                      {active ? (
                        <span className={styles.check} aria-hidden="true">
                          <CheckGlyph />
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })
            )}
          </ul>

          <div className={styles.footer}>
            {onDiscover === undefined || selection === null ? null : (
              <button
                type="button"
                className={styles.footerAction}
                onClick={() => {
                  onDiscover(selection.providerId);
                }}
              >
                Ask this endpoint what models it has
              </button>
            )}
            {onConfigure === undefined ? null : (
              <button
                type="button"
                className={styles.footerAction}
                onClick={() => {
                  close();
                  onConfigure();
                }}
              >
                Manage endpoints…
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ChevronGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none">
      <path d="m4 6.5 4 3.5 4-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none">
      <path
        d="m3.5 8.5 3 3 6-7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
