/**
 * The code workspace: the session bar, the Views menu, and the panes.
 *
 * ## Why it is a modal surface
 *
 * It fills the window, so everything behind it is invisible — and an invisible
 * control that Tab still reaches is a keyboard user pressing Tab into nothing.
 * `src/components/ModalSurface.tsx` is where this tree keeps the answer:
 * containment that is written next to the `aria-modal` that claims it, plus the
 * focus restore on close. Rendering a full-bleed panel outside it would mean
 * re-deriving both, and the two dialogs that each derived their own focus
 * restore are why `src/state/focus-store.ts` exists.
 *
 * It deliberately does **not** cover the title bar or the status line. The title
 * bar carries the window controls on Windows, and a workspace that hides the
 * close button is a workspace you cannot get out of by the route you expect.
 *
 * ## What is not built, and where that is written down
 *
 * Five of the spec's eight panes, the permission-approval cards, and everything
 * that would run a tool. `src/features/code/README.md` is the list, with what
 * each one needs before it can exist.
 */

import { useRef, useState } from 'react';

import { ModalSurface } from '@/components/ModalSurface';
import { isOpen } from '@/lib/pane-layout';
import { useCodeWorkspaceStore, type PaneKind } from '@/state/code-workspace-store';

import { ChatPane } from './ChatPane';
import { DiffPane } from './DiffPane';
import { EditorPane } from './EditorPane';
import { PANE_TITLES } from './PaneFrame';
import { PaneGrid } from './PaneGrid';
import { SessionSetup } from './SessionSetup';
import { useWorkspaceShortcuts } from './use-workspace-shortcuts';
import styles from './CodeWorkspace.module.css';

const ALL_PANES: readonly PaneKind[] = ['chat', 'editor', 'diff'];

export function CodeWorkspace({ onClose }: { readonly onClose: () => void }) {
  const layout = useCodeWorkspaceStore((state) => state.layout);
  const sessions = useCodeWorkspaceStore((state) => state.sessions);
  const activeSessionId = useCodeWorkspaceStore((state) => state.activeSessionId);
  const selectSession = useCodeWorkspaceStore((state) => state.selectSession);
  const openPane = useCodeWorkspaceStore((state) => state.openPane);
  const resetLayout = useCodeWorkspaceStore((state) => state.resetLayout);

  const viewsTrigger = useRef<HTMLButtonElement>(null);
  const [viewsOpen, setViewsOpen] = useState(false);
  const [dragging, setDragging] = useState<PaneKind | null>(null);

  useWorkspaceShortcuts();

  const session = sessions.find((candidate) => candidate.id === activeSessionId) ?? null;

  return (
    <ModalSurface
      label="Code workspace"
      scrimClassName={styles.scrim}
      className={styles.workspace}
      onDismiss={onClose}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onClose();
      }}
    >
      <header
        className={styles.workspaceHead}
        // The Views menu is a disclosure with the same structure and the same
        // repair as the pane header's: the list does not contain the trigger —
        // the trigger is inside `headActions` and the list sits beside it — so
        // the key has to be caught here, on the element that is an ancestor of
        // both. Without this the workspace's own Escape closed the whole surface
        // while the menu it was aimed at stayed open. `PaneFrame.tsx`'s header
        // carries the full account.
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || !viewsOpen) return;
          event.stopPropagation();
          setViewsOpen(false);
          viewsTrigger.current?.focus();
        }}
      >
        <h2 className={styles.workspaceTitle}>Code</h2>

        {session === null ? null : (
          <p className={styles.sessionLine} data-testid="code-session-line">
            <span className={styles.sessionWorktree}>{session.worktree}</span>
            <span className={styles.sessionDetail}>{session.folder}</span>
            <span className={styles.sessionDetail}>{session.environment}</span>
            <span className={styles.sessionDetail}>{session.permissionMode}</span>
          </p>
        )}

        <div className={styles.headActions}>
          {sessions.length > 0 ? (
            <label className={styles.headField}>
              <span className={styles.fieldLabel}>Session</span>
              <select
                className={styles.input}
                value={activeSessionId ?? ''}
                onChange={(event) =>
                  selectSession(event.target.value === '' ? null : event.target.value)
                }
              >
                <option value="">New session…</option>
                {sessions.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.worktree}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <button
            ref={viewsTrigger}
            type="button"
            className={styles.paneButton}
            aria-expanded={viewsOpen}
            onClick={() => setViewsOpen((was) => !was)}
          >
            Views
          </button>
          <button type="button" className={styles.paneButton} onClick={onClose}>
            Close workspace
          </button>
        </div>

        {viewsOpen ? (
          <div className={styles.viewsList}>
            {ALL_PANES.map((pane) => (
              <button
                key={pane}
                type="button"
                className={styles.moveItem}
                disabled={isOpen(layout, pane)}
                onClick={() => {
                  setViewsOpen(false);
                  openPane(pane);
                }}
              >
                {PANE_TITLES[pane]}
              </button>
            ))}
            <button
              type="button"
              className={styles.moveItem}
              onClick={() => {
                setViewsOpen(false);
                resetLayout();
              }}
            >
              Reset layout
            </button>
          </div>
        ) : null}
      </header>

      {session === null ? (
        <SessionSetup />
      ) : (
        <PaneGrid
          dragging={dragging}
          onDragging={setDragging}
          renderPane={(pane) => {
            if (pane === 'chat') return <ChatPane session={session} />;
            if (pane === 'editor') return <EditorPane sessionId={session.id} />;
            return <DiffPane sessionId={session.id} />;
          }}
        />
      )}
    </ModalSurface>
  );
}
