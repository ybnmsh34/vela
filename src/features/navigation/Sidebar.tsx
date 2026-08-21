/**
 * The conversation sidebar: the app's primary navigation.
 *
 * ## Keyboard model
 *
 * The list uses a **roving tabindex**, not `tabindex="0"` on every row: one Tab
 * enters the list, arrows move within it, one Tab leaves. A list of forty
 * conversations that costs forty Tab presses to step past is not keyboard
 * accessible, it is keyboard hostile.
 *
 * `Enter`/`Space` open (the row is a button, so that is free), `F2` renames,
 * `Delete` asks to delete, `Home`/`End` jump.
 *
 * ## The rail's icon-only controls
 *
 * Collapsed, this component is a column of buttons whose only content is a
 * 14px glyph. `aria-label` gives each one a name for assistive technology and
 * gives a sighted user nothing at all: a rail of eight unlabelled marks, of
 * which two — the folder and the sheets — are a coin toss even for someone who
 * has used the app before.
 *
 * Every one of them carries a `title` equal to its `aria-label`, which is what
 * `TitleBar.tsx` already does for the three caption buttons it draws instead of
 * the OS. `title` is the browser's own tooltip and it does not change the
 * accessible name — `aria-label` wins that computation — so this adds a name
 * for the pointer without touching the one already announced.
 *
 * It is the narrow fix and not the wide one. A tooltip is a hover affordance:
 * it does not appear for a keyboard user tabbing the rail, and it does not
 * appear on touch. The wide fix is a real tooltip component bound to focus as
 * well as hover, and there is no such component in this codebase to reuse.
 *
 * ## Home
 *
 * The rail's **Home** control is the only thing in the product that clears the
 * selection. `select(null)` had one caller before it — `deleteConversation` —
 * which meant the home screen was reachable exactly by deleting the
 * conversation you were reading. It is offered in both branches of this
 * component, expanded and collapsed, because a control that exists only in the
 * expanded rail is not reachable from a collapsed one, and `sidebarCollapsed` is
 * persisted across restarts.
 *
 * ## Resizing
 *
 * The handle is a `separator` with `aria-valuenow`, which makes it operable
 * from the keyboard as well as by dragging. Pointer capture is used so a fast
 * drag that leaves the element does not drop the gesture.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';

import { groupConversationsByRecency } from '@/lib/conversation-groups';
import { useMemoryStore } from '@/state/memory-store';
import { useSkillsStore } from '@/state/skills-store';
import { useSchedulesStore } from '@/state/schedules-store';
import { useProjectStore } from '@/state/project-store';
import type { ConversationSummary } from '@/platform/contract';
import {
  clampSidebarWidth,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  useNavigationStore,
} from '@/state/navigation-store';

import { ConversationRow } from './ConversationRow';
import { DeleteConversationDialog } from './DeleteConversationDialog';
import { ShortcutHint } from '@/components/ShortcutHint';

import styles from './Sidebar.module.css';
import { useConversations } from './use-conversations';

/** How far one arrow-key press moves the resize handle. */
const KEYBOARD_RESIZE_STEP = 16;

interface SidebarProps {
  /** Injectable clock, so "Yesterday" is testable without waiting a day. */
  readonly now?: () => number;
}

export function Sidebar({ now = () => Date.now() }: SidebarProps) {
  const {
    status,
    conversations,
    createConversation,
    renameConversation,
    deleteConversation,
    actionError,
  } = useConversations();

  const selectedId = useNavigationStore((state) => state.selectedConversationId);
  const select = useNavigationStore((state) => state.select);
  const width = useNavigationStore((state) => state.sidebarWidth);
  const collapsed = useNavigationStore((state) => state.sidebarCollapsed);
  const setSidebarWidth = useNavigationStore((state) => state.setSidebarWidth);
  const toggleSidebar = useNavigationStore((state) => state.toggleSidebar);
  const openPalette = useNavigationStore((state) => state.openPalette);
  // Only a boolean is set: the memory pane is another feature, and one feature
  // may not import another (`src/features/README.md`). The composition root
  // mounts it; this opens it. The projects pane is reached the same way, for
  // the same reason.
  const setMemoryOpen = useMemoryStore((state) => state.setOpen);
  // The skills pane reaches this sidebar the same way and for the same reason.
  const setSkillsOpen = useSkillsStore((state) => state.setOpen);
  // The same seam, for the same reason: the schedules pane is a third feature
  // and this one may not import it either.
  const setSchedulesOpen = useSchedulesStore((state) => state.setOpen);
  const setProjectsOpen = useProjectStore((state) => state.setOpen);

  const [pendingDelete, setPendingDelete] = useState<ConversationSummary | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // `now` is read once per render rather than stored: a group boundary that
  // moves while the user watches is a redraw nobody asked for.
  const groups = useMemo(
    () => groupConversationsByRecency(conversations, now()),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `now` is a clock, not data
    [conversations],
  );
  const flat = useMemo(() => groups.flatMap((group) => group.conversations), [groups]);

  useEffect(() => {
    // The list shrank under the cursor — a delete, or a search that narrowed it.
    if (focusIndex > flat.length - 1) setFocusIndex(Math.max(0, flat.length - 1));
  }, [flat.length, focusIndex]);

  const focusRow = useCallback((index: number) => {
    setFocusIndex(index);
    rowRefs.current[index]?.focus();
  }, []);

  const onRowKeyDown = useCallback(
    (index: number, conversation: ConversationSummary) =>
      (event: KeyboardEvent<HTMLElement>): void => {
        switch (event.key) {
          case 'ArrowDown':
            event.preventDefault();
            focusRow(Math.min(index + 1, flat.length - 1));
            return;
          case 'ArrowUp':
            event.preventDefault();
            focusRow(Math.max(index - 1, 0));
            return;
          case 'Home':
            event.preventDefault();
            focusRow(0);
            return;
          case 'End':
            event.preventDefault();
            focusRow(flat.length - 1);
            return;
          case 'Delete':
          case 'Backspace':
            event.preventDefault();
            setPendingDelete(conversation);
            return;
          default:
        }
      },
    [flat.length, focusRow],
  );

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const handle = event.currentTarget;
      const originX = event.clientX;
      const originWidth = width;
      handle.setPointerCapture(event.pointerId);

      const move = (moved: PointerEvent): void => {
        setSidebarWidth(originWidth + (moved.clientX - originX));
      };
      const stop = (): void => {
        handle.releasePointerCapture(event.pointerId);
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', stop);
        handle.removeEventListener('pointercancel', stop);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('pointercancel', stop);
    },
    [width, setSidebarWidth],
  );

  if (collapsed) {
    return (
      <nav className={`${styles.sidebar} ${styles.collapsed}`} aria-label="Primary">
        <button
          type="button"
          className={styles.iconButton}
          onClick={toggleSidebar}
          aria-label="Expand sidebar"
          title="Expand sidebar"
        >
          <ChevronIcon direction="right" />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => void createConversation()}
          aria-label="New conversation"
          title="New conversation"
        >
          <PlusIcon />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => {
            select(null);
          }}
          aria-label="Home"
          title="Home"
          {...(selectedId === null ? { 'aria-current': 'page' as const } : {})}
        >
          <HomeIcon />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => {
            openPalette('search');
          }}
          aria-label="Search conversations"
          title="Search conversations"
        >
          <SearchIcon />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => {
            setMemoryOpen(true);
          }}
          aria-label="Memory"
          title="Memory"
        >
          <MemoryIcon />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => {
            setSkillsOpen(true);
          }}
          aria-label="Skills"
          title="Skills"
        >
          <SkillsIcon />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => {
            setSchedulesOpen(true);
          }}
          aria-label="Schedules"
          title="Schedules"
        >
          <ScheduleIcon />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => {
            setProjectsOpen(true);
          }}
          aria-label="Projects"
          title="Projects"
        >
          <ProjectsIcon />
        </button>
      </nav>
    );
  }

  return (
    <nav
      className={styles.sidebar}
      aria-label="Primary"
      // The width the user dragged to is a *ceiling*, not the answer: 480px is
      // a third of a 1440px window and half of a 1000px one, and this component
      // does not know which it is in. So the number is handed to CSS as a
      // custom property and `Sidebar.module.css` caps it against the viewport.
      // Setting `width` here instead — which is what this used to do — puts an
      // inline declaration above every stylesheet rule that could respond.
      style={{ '--vela-sidebar-width': `${clampSidebarWidth(width)}px` } as CSSProperties}
    >
      <div className={styles.head}>
        <div className={styles.headRow}>
          <button
            type="button"
            className={styles.newButton}
            onClick={() => void createConversation()}
          >
            <PlusIcon />
            <span>New conversation</span>
            <ShortcutHint keyName="N" className={styles.kbd} />
          </button>
          {/* The collapse control shares the row with the primary action rather
              than the search field: search is the one that has to hold a full
              sentence at 200px, and it loses if it shares its line. */}
          <button
            type="button"
            className={styles.iconButton}
            onClick={toggleSidebar}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
          >
            <ChevronIcon direction="left" />
          </button>
        </div>
        <button
          type="button"
          className={styles.searchButton}
          onClick={() => {
            select(null);
          }}
          {...(selectedId === null ? { 'aria-current': 'page' as const } : {})}
        >
          <HomeIcon />
          <span>Home</span>
        </button>
        <button
          type="button"
          className={styles.searchButton}
          onClick={() => {
            openPalette('search');
          }}
        >
          <SearchIcon />
          <span>Search conversations</span>
          <ShortcutHint keyName="K" className={styles.kbd} />
        </button>
        <button
          type="button"
          className={styles.searchButton}
          onClick={() => {
            setMemoryOpen(true);
          }}
        >
          <MemoryIcon />
          <span>Memory</span>
        </button>
        <button
          type="button"
          className={styles.searchButton}
          onClick={() => {
            setSkillsOpen(true);
          }}
        >
          <SkillsIcon />
          <span>Skills</span>
        </button>
        <button
          type="button"
          className={styles.searchButton}
          onClick={() => {
            setSchedulesOpen(true);
          }}
        >
          <ScheduleIcon />
          <span>Schedules</span>
        </button>
        <button
          type="button"
          className={styles.searchButton}
          onClick={() => {
            setProjectsOpen(true);
          }}
        >
          <ProjectsIcon />
          <span>Projects</span>
        </button>
      </div>

      <div className={styles.list}>
        {status.state === 'loading' && (
          <p className={styles.note} data-testid="sidebar-loading">
            Loading conversations…
          </p>
        )}

        {status.state === 'error' && (
          <p className={styles.error} role="status">
            Conversations unavailable · {status.code}
          </p>
        )}

        {status.state === 'ready' && flat.length === 0 && (
          <p className={styles.note}>No conversations yet.</p>
        )}

        {groups.map((group) => (
          <section key={group.id} className={styles.group}>
            <h2 className={styles.groupLabel}>{group.label}</h2>
            <ul className={styles.rows}>
              {group.conversations.map((conversation) => {
                const index = flat.indexOf(conversation);
                return (
                  <ConversationRow
                    key={conversation.id}
                    conversation={conversation}
                    selected={conversation.id === selectedId}
                    tabbable={index === Math.min(focusIndex, flat.length - 1)}
                    onSelect={() => {
                      setFocusIndex(index);
                      select(conversation.id);
                    }}
                    onRename={(title) => void renameConversation(conversation.id, title)}
                    onRequestDelete={() => {
                      setPendingDelete(conversation);
                    }}
                    onKeyDown={onRowKeyDown(index, conversation)}
                    registerRef={(element) => {
                      rowRefs.current[index] = element;
                    }}
                  />
                );
              })}
            </ul>
          </section>
        ))}

        {actionError !== null && (
          <p className={styles.error} role="alert">
            {actionError}
          </p>
        )}
      </div>

      <div
        className={styles.handle}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={clampSidebarWidth(width)}
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            setSidebarWidth(width - KEYBOARD_RESIZE_STEP);
          } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            setSidebarWidth(width + KEYBOARD_RESIZE_STEP);
          }
        }}
      />

      {pendingDelete !== null && (
        <DeleteConversationDialog
          conversation={pendingDelete}
          onCancel={() => {
            setPendingDelete(null);
          }}
          onConfirm={() => {
            const target = pendingDelete;
            setPendingDelete(null);
            void deleteConversation(target.id);
          }}
        />
      )}
    </nav>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/**
 * A roof over a doorway. Drawn from the same 16-unit box and 1.4 stroke as the
 * rest of the rail, so the set still reads as one set.
 */
function HomeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M2.6 7.2 8 2.8l5.4 4.4v5.4a1 1 0 0 1-1 1H3.6a1 1 0 0 1-1-1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M6.4 13.6V9.4h3.2v4.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.2 10.2 13.4 13.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function MemoryIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <rect
        x="3.2"
        y="3.2"
        width="9.6"
        height="9.6"
        rx="2.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path d="M6 6.4h4M6 9.6h2.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** A stack of sheets: a skill is a folder of files, not a setting. */
function SkillsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M5.4 2.8h4.2l2.2 2.2v6.6a1.2 1.2 0 0 1-1.2 1.2H5.4a1.2 1.2 0 0 1-1.2-1.2V4a1.2 1.2 0 0 1 1.2-1.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M9.4 2.9v2.3h2.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ProjectsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M2.4 5.2v7.2a1 1 0 0 0 1 1h9.2a1 1 0 0 0 1-1V6.4a1 1 0 0 0-1-1H8L6.6 3.6H3.4a1 1 0 0 0-1 1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A clock face. Drawn from the same 16-unit box and stroke weight as the rest. */
function ScheduleIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 5.2V8l2.2 1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronIcon({ direction }: { readonly direction: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d={direction === 'left' ? 'M9.8 3.6 5.4 8l4.4 4.4' : 'M6.2 3.6 10.6 8l-4.4 4.4'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
