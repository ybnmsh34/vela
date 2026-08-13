/**
 * The command bar: quick switcher and search, in one control.
 *
 * ## Why one control and not two
 *
 * They share a list, a keyboard model and a mental model — "type, arrow, Enter".
 * The difference is only how far the query reaches: the switcher filters the
 * conversations already loaded (instant, no host round trip), and search also
 * asks the host to look inside them. Opening in `search` mode just means the
 * host query starts immediately; typing in the switcher promotes it anyway once
 * there is something to search for.
 *
 * ## The two halves stay labelled
 *
 * Title matches and content matches are shown under separate headings, and a
 * match found inside a reasoning block says so. Blending them would let the UI
 * imply words appear in a transcript when they only appear in its name — and
 * would quote the model's private thinking as though it were an answer.
 *
 * ## Combobox semantics
 *
 * `role="combobox"` on the input with `aria-activedescendant` pointing into a
 * `listbox`: focus stays in the text field while the arrows move a highlight,
 * which is the only arrangement where typing and navigating both work.
 *
 * ## Focus, on the way in and on the way out
 *
 * Taking the keyboard was always here. **Giving it back was not**, and Escape
 * therefore left focus on `<body>` — eleven Tab presses from the composer,
 * measured. The bar now remembers what it interrupted and hands the keyboard
 * back to it through the ladder in `src/state/focus-store.ts`, which skips the
 * opener when it no longer exists. That last part matters here more than
 * anywhere: activating a row *replaces the conversation on screen*, so the row
 * you came from is frequently gone by the time the bar closes.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import type { SearchResults } from '@/data/conversations-repository';
import type { ConversationSummary, MessageHit } from '@/platform/contract';
import { toPlatformError } from '@/platform/errors';
import { returnFocusTo } from '@/state/focus-store';
import { useNavigationStore } from '@/state/navigation-store';

import styles from './CommandPalette.module.css';
import { useConversations } from './use-conversations';

/** How long typing must pause before the host is asked. */
export const SEARCH_DEBOUNCE_MS = 140;

const EMPTY_RESULTS: SearchResults = { conversations: [], messages: [] };

type Row =
  | { readonly kind: 'conversation'; readonly conversation: ConversationSummary }
  | { readonly kind: 'message'; readonly hit: MessageHit }
  | { readonly kind: 'action'; readonly id: 'new'; readonly label: string };

interface CommandPaletteProps {
  /** Shortened in tests so a debounce is not a two-second wait. */
  readonly debounceMs?: number;
}

export function CommandPalette({ debounceMs = SEARCH_DEBOUNCE_MS }: CommandPaletteProps) {
  const mode = useNavigationStore((state) => state.paletteMode);
  const closePalette = useNavigationStore((state) => state.closePalette);
  const select = useNavigationStore((state) => state.select);
  const { conversations, createConversation, search } = useConversations();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults>(EMPTY_RESULTS);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  /** What had the keyboard when the bar opened, so closing can hand it back. */
  const openedFrom = useRef<Element | null>(null);
  const listId = useId();

  const open = mode !== 'closed';

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setResults(EMPTY_RESULTS);
    setSearchError(null);
    setActive(0);
    openedFrom.current = document.activeElement;
    inputRef.current?.focus();

    // The cleanup, not a handler on each exit: the bar is closed from five
    // places — Escape here, Escape in the global shortcut, the scrim, a row,
    // and the "New conversation" action — and a return-focus call attached to
    // each of them is four chances to forget one.
    return () => {
      returnFocusTo(openedFrom.current);
      openedFrom.current = null;
    };
  }, [open]);

  // Local filter: instant, and correct even with no host reachable.
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return conversations;
    return conversations.filter((conversation) =>
      conversation.title.toLowerCase().includes(needle),
    );
  }, [conversations, query]);

  useEffect(() => {
    if (!open) return;
    const needle = query.trim();
    if (needle === '') {
      setResults(EMPTY_RESULTS);
      setSearchError(null);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const found = await search(needle);
          if (!cancelled) {
            setResults(found);
            setSearchError(null);
          }
        } catch (thrown) {
          // A search that cannot reach the host must say so rather than render
          // "no results", which is a different and much more alarming claim.
          if (!cancelled) {
            setResults(EMPTY_RESULTS);
            setSearchError(toPlatformError(thrown).message);
          }
        }
      })();
    }, debounceMs);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query, search, debounceMs]);

  /**
   * The list the arrows walk. Title matches come from the local filter — which
   * is a superset of what the host returns while a request is in flight, so the
   * list never blinks empty mid-keystroke.
   */
  const rows = useMemo<Row[]>(() => {
    const conversationRows: Row[] = filtered.map((conversation) => ({
      kind: 'conversation',
      conversation,
    }));
    const seen = new Set(filtered.map((conversation) => conversation.id));
    for (const conversation of results.conversations) {
      if (!seen.has(conversation.id)) {
        conversationRows.push({ kind: 'conversation', conversation });
        seen.add(conversation.id);
      }
    }
    const messageRows: Row[] = results.messages.map((hit) => ({ kind: 'message', hit }));
    const actions: Row[] = [{ kind: 'action', id: 'new', label: 'New conversation' }];
    return [...actions, ...conversationRows, ...messageRows];
  }, [filtered, results]);

  useEffect(() => {
    if (active > rows.length - 1) setActive(Math.max(0, rows.length - 1));
  }, [rows.length, active]);

  const activate = useCallback(
    (row: Row | undefined) => {
      if (row === undefined) return;
      closePalette();
      if (row.kind === 'action') {
        void createConversation();
      } else if (row.kind === 'conversation') {
        select(row.conversation.id);
      } else {
        select(row.hit.conversationId);
      }
    },
    [closePalette, createConversation, select],
  );

  if (!open) return null;

  const optionId = (index: number): string => `${listId}-option-${index}`;

  return (
    <div
      className={styles.scrim}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) closePalette();
      }}
    >
      <div className={styles.panel} role="dialog" aria-modal="true" aria-label="Command bar">
        <div className={styles.field}>
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
            <circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path
              d="M10.2 10.2 13.4 13.4"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
          <input
            ref={inputRef}
            className={styles.input}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={rows.length > 0 ? optionId(active) : undefined}
            aria-label={mode === 'search' ? 'Search conversations' : 'Go to conversation'}
            placeholder={
              mode === 'search'
                ? 'Search titles and messages…'
                : 'Go to conversation, or type to search…'
            }
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              switch (event.key) {
                case 'ArrowDown':
                  event.preventDefault();
                  setActive((index) => Math.min(index + 1, rows.length - 1));
                  return;
                case 'ArrowUp':
                  event.preventDefault();
                  setActive((index) => Math.max(index - 1, 0));
                  return;
                case 'Home':
                  event.preventDefault();
                  setActive(0);
                  return;
                case 'End':
                  event.preventDefault();
                  setActive(Math.max(0, rows.length - 1));
                  return;
                case 'Enter':
                  event.preventDefault();
                  activate(rows[active]);
                  return;
                case 'Escape':
                  event.preventDefault();
                  closePalette();
                  return;
                default:
              }
            }}
          />
        </div>

        <ul className={styles.results} id={listId} role="listbox" aria-label="Results">
          {rows.map((row, index) => (
            <li
              key={rowKey(row, index)}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              className={`${styles.row} ${index === active ? styles.active : ''}`}
              onPointerDown={(event) => {
                // Down, not click: a click would first blur the input.
                event.preventDefault();
                activate(row);
              }}
              onPointerEnter={() => {
                setActive(index);
              }}
            >
              {row.kind === 'action' && (
                <>
                  <span className={styles.rowTitle}>{row.label}</span>
                  <span className={styles.rowKind}>Action</span>
                </>
              )}
              {row.kind === 'conversation' && (
                <>
                  <span className={styles.rowTitle}>{row.conversation.title}</span>
                  <span className={styles.rowKind}>Conversation</span>
                </>
              )}
              {row.kind === 'message' && (
                <>
                  <span className={styles.rowTitle}>
                    <Snippet snippet={row.hit.snippet} />
                  </span>
                  <span className={styles.rowKind}>
                    {row.hit.kind === 'reasoning' ? 'In thinking' : 'In message'} ·{' '}
                    {row.hit.conversationTitle}
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>

        {searchError !== null && (
          <p className={styles.footnote} role="alert">
            Search unavailable · {searchError}
          </p>
        )}
        {searchError === null && rows.length === 1 && query.trim() !== '' && (
          <p className={styles.footnote}>No conversation or message matches “{query.trim()}”.</p>
        )}
      </div>
    </div>
  );
}

function rowKey(row: Row, index: number): string {
  if (row.kind === 'action') return `action-${row.id}`;
  if (row.kind === 'conversation') return `conversation-${row.conversation.id}`;
  return `message-${row.hit.messageId}-${index}`;
}

/**
 * Renders the host's snippet, which delimits the match with `[` and `]`.
 *
 * Parsed rather than injected: the snippet is user content, and the one thing
 * that must never happen to user content is being handed to `innerHTML`.
 */
function Snippet({ snippet }: { readonly snippet: string }) {
  const parts = snippet.split(/(\[[^\]]*\])/u).filter((part) => part !== '');
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith('[') && part.endsWith(']') ? (
          <mark key={index} className={styles.mark}>
            {part.slice(1, -1)}
          </mark>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}
