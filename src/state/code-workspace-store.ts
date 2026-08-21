/**
 * Client state for the code workspace: which panes are up and how they are
 * arranged, which sessions exist, and what each session holds.
 *
 * Rules from conventions §5, followed here: state and actions only, **no IPC**.
 * Nothing in this file talks to the host, and that is not only a convention —
 * there is no host command to talk to. `src/platform/contract.ts` declares no
 * filesystem and no git command, so every byte a session holds arrived through
 * the workspace's own editor pane. `src/features/code/README.md` says what that
 * costs and what would replace it.
 *
 * ## Why the pane layout is per workspace and the work is per session
 *
 * A session's *work* — its files, its review comments, its queued instructions —
 * is what "isolated by worktree" is about, so it is keyed by session and two
 * sessions cannot see each other's. The *arrangement of the panes* is not work;
 * it is how this user likes to look at a workspace, and re-deriving it per
 * session would mean a user who dragged the diff wide had to do it again on
 * every new session. One layout, many sessions.
 *
 * ## Why the session id **is** the worktree key
 *
 * Isolation is by worktree, so two sessions on one worktree are not two
 * sessions — they are one worktree with two sets of uncommitted edits, which is
 * the state worktree isolation exists to prevent. Making the key the identity
 * makes that unrepresentable rather than merely checked.
 *
 * The key is **case-folded**, and that is not tidiness. `.vela/worktrees/Fix-A`
 * and `.vela/worktrees/fix-a` are one directory on NTFS and on APFS and two on
 * ext4 — the same asymmetry `src/platform/case-collision.test.ts` was written
 * for after a case-only filename collision produced a blank window on Windows
 * while every Linux gate stayed green. A registry that folds case refuses the
 * second session on every platform; one that does not, refuses it on none and
 * lets two sessions share a directory on the two platforms Vela ships to most.
 */

import { create } from 'zustand';

import {
  closePane as closePaneIn,
  columnsOf,
  movePane as movePaneIn,
  openPane as openPaneIn,
  paneOrder,
  resizeColumns as resizeColumnsIn,
  resizeSlots as resizeSlotsIn,
  type PaneLayout,
} from '@/lib/pane-layout';

/**
 * The panes this build actually has.
 *
 * The spec (`docs/spec-parts/claude-code-desktop.md` §7) lists eight, plus the
 * iOS simulator. Three are built. The union names three, deliberately: a pane
 * listed in the Views menu that opens an empty box is worse than a Views menu
 * that is short, and this union is what the menu is drawn from.
 */
export type PaneKind = 'chat' | 'diff' | 'editor';

/** Where a session's tools run. Chosen before the first message. */
export type CodeEnvironment = 'local' | 'container' | 'ssh' | 'wsl';

/**
 * The permission mode a session starts in.
 *
 * The names are the settings keys from the spec's table, not prose labels, so
 * that a future settings-file reader and this surface cannot disagree about
 * what the user picked.
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto';

/** What the user filled in before the first message. All four are required. */
export interface SessionDraft {
  readonly worktree: string;
  readonly folder: string;
  readonly environment: CodeEnvironment | null;
  /**
   * A model is a *pair*: the endpoint that serves it and the id that endpoint
   * knows it by. Carrying only the id is how a workspace ends up asking one
   * provider for another provider's model — `models_capabilities` takes both,
   * and so does every command after it.
   */
  readonly providerId: string;
  readonly modelId: string;
  readonly permissionMode: PermissionMode | null;
}

export interface CodeSession {
  /** The case-folded worktree name. Unique by construction; see the header. */
  readonly id: string;
  /** The worktree name **as the user typed it**, which is what is shown. */
  readonly worktree: string;
  readonly folder: string;
  readonly environment: CodeEnvironment;
  readonly providerId: string;
  readonly modelId: string;
  readonly permissionMode: PermissionMode;
}

/** One file the session has open. `baseline` is the last save; `working` is now. */
export interface SessionFile {
  readonly path: string;
  readonly baseline: string;
  readonly working: string;
}

/**
 * A review comment, anchored to one line on one side of one file's diff.
 *
 * `text` is the line **as it read when the comment was written**, kept rather
 * than re-derived. A review comment quotes what it is about: re-reading the line
 * out of the current diff at submit time would quote whatever the editor has
 * done to it since, and the comment "this should be a constant" would arrive
 * attached to a line that no longer says what it said.
 *
 * `line` is where it was written, and it is **not** where the comment points
 * once the file has been edited above it. Nothing here can keep it current — the
 * store holds no diff — so nothing here pretends to: `anchorComments` in
 * `src/features/code/review-comments.ts` re-finds the quoted line in the diff as
 * it reads now, and it is the only thing that decides which row a card sits
 * under or which coordinate a submitted message carries. Reading `line` for
 * either of those is the defect that shipped in the first version.
 */
export interface LineComment {
  readonly id: string;
  readonly path: string;
  readonly side: 'left' | 'right';
  readonly line: number;
  readonly text: string;
  readonly body: string;
}

/** Everything one session holds. Never shared with another session. */
export interface SessionWork {
  readonly files: readonly SessionFile[];
  readonly comments: readonly LineComment[];
  /** Submitted review rounds, oldest first. Read by the chat pane. */
  readonly queue: readonly string[];
}

const NO_WORK: SessionWork = { files: [], comments: [], queue: [] };

/**
 * The arrangement a workspace opens with, and what "reset layout" restores.
 *
 * Chat on the left because it is where the session is driven from; the editor
 * next because it is the only thing in this build that can produce a change; the
 * diff last because it reads what the editor wrote and a diff reads left to
 * right.
 */
export const DEFAULT_PANE_LAYOUT: PaneLayout<PaneKind> = columnsOf<PaneKind>(
  'chat',
  'editor',
  'diff',
);

/** Why a session could not be started. Both are recoverable in the form. */
export type StartSessionRefusal = 'incomplete' | 'worktreeTaken';

export type StartSessionResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: StartSessionRefusal };

/**
 * The identity a worktree name resolves to.
 *
 * `trim` then fold. Exported because the form has to be able to tell the user
 * *before* they press Start that the name they typed is the one already taken —
 * saying "taken" about a string that does not look like the one in the list is
 * how a case-folded registry becomes baffling instead of protective.
 */
export function worktreeKey(worktree: string): string {
  return worktree.trim().toLowerCase();
}

function isComplete(draft: SessionDraft): boolean {
  return (
    draft.worktree.trim() !== '' &&
    draft.folder.trim() !== '' &&
    draft.environment !== null &&
    draft.providerId.trim() !== '' &&
    draft.modelId.trim() !== '' &&
    draft.permissionMode !== null
  );
}

interface CodeWorkspaceState {
  readonly open: boolean;
  readonly layout: PaneLayout<PaneKind>;
  /** Which pane the keyboard is in. `null` before anything has been focused. */
  readonly focusedPane: PaneKind | null;
  readonly sessions: readonly CodeSession[];
  readonly activeSessionId: string | null;
  readonly work: Readonly<Record<string, SessionWork>>;
  /** Monotonic, so a comment id is deterministic and never a clock read. */
  readonly nextCommentSeq: number;

  setOpen: (open: boolean) => void;

  openPane: (pane: PaneKind) => void;
  closePane: (pane: PaneKind) => void;
  movePane: (pane: PaneKind, column: number, slot: number) => void;
  resizeColumns: (boundary: number, delta: number) => void;
  resizeSlots: (column: number, boundary: number, delta: number) => void;
  resetLayout: () => void;
  focusPane: (pane: PaneKind | null) => void;

  startSession: (draft: SessionDraft) => StartSessionResult;
  selectSession: (id: string | null) => void;

  addFile: (sessionId: string, path: string) => void;
  editFile: (sessionId: string, path: string, working: string) => void;
  saveFile: (sessionId: string, path: string) => void;

  addComment: (
    sessionId: string,
    anchor: Omit<LineComment, 'id' | 'body'>,
    body: string,
  ) => void;
  removeComment: (sessionId: string, commentId: string) => void;
  /**
   * Put a message on this session's queue. The chat composer's door.
   *
   * Separate from {@link submitComments} because the two differ in what they
   * *consume*, not in what they produce: a review round empties the pending
   * comments and a typed message does not. Folding them into one action means
   * either a typed message silently clears a review the user had not sent, or a
   * review round with no comments queues a blank turn.
   */
  queueMessage: (sessionId: string, message: string) => void;
  /** Empty the pending comments, and queue the message composed from them. */
  submitComments: (sessionId: string, message: string) => void;
}

const INITIAL = {
  open: false,
  layout: DEFAULT_PANE_LAYOUT,
  focusedPane: null,
  sessions: [],
  activeSessionId: null,
  work: {},
  nextCommentSeq: 1,
} as const;

export const useCodeWorkspaceStore = create<CodeWorkspaceState>((set, get) => {
  /** Rewrite one session's work, leaving every other session untouched. */
  function withWork(sessionId: string, change: (work: SessionWork) => SessionWork): void {
    const state = get();
    const current = state.work[sessionId];
    if (current === undefined) return;
    set({ work: { ...state.work, [sessionId]: change(current) } });
  }

  return {
    ...INITIAL,

    setOpen: (open) => set({ open }),

    openPane: (pane) => set({ layout: openPaneIn(get().layout, pane), focusedPane: pane }),

    closePane: (pane) => {
      const layout = closePaneIn(get().layout, pane);
      // Closing the focused pane must hand the keyboard on rather than leave
      // `focusedPane` naming a pane that is no longer rendered — the store-level
      // half of the rule `src/state/focus-store.ts` enforces in the DOM.
      const focused = get().focusedPane;
      const next = focused !== pane ? focused : (paneOrder(layout)[0] ?? null);
      set({ layout, focusedPane: next });
    },

    movePane: (pane, column, slot) =>
      set({ layout: movePaneIn(get().layout, pane, column, slot) }),

    resizeColumns: (boundary, delta) =>
      set({ layout: resizeColumnsIn(get().layout, boundary, delta) }),

    resizeSlots: (column, boundary, delta) =>
      set({ layout: resizeSlotsIn(get().layout, column, boundary, delta) }),

    resetLayout: () => set({ layout: DEFAULT_PANE_LAYOUT }),

    focusPane: (pane) => set({ focusedPane: pane }),

    startSession: (draft) => {
      if (!isComplete(draft)) return { ok: false, reason: 'incomplete' };
      const id = worktreeKey(draft.worktree);
      const state = get();
      if (state.sessions.some((session) => session.id === id)) {
        return { ok: false, reason: 'worktreeTaken' };
      }
      // `environment` and `permissionMode` are non-null here: `isComplete` said
      // so. The `??` is the type system's price for that, not a default — a
      // silent default for a permission mode is precisely the thing this form
      // exists to stop.
      const session: CodeSession = {
        id,
        worktree: draft.worktree.trim(),
        folder: draft.folder.trim(),
        environment: draft.environment ?? 'local',
        providerId: draft.providerId.trim(),
        modelId: draft.modelId.trim(),
        permissionMode: draft.permissionMode ?? 'default',
      };
      set({
        sessions: [...state.sessions, session],
        activeSessionId: id,
        work: { ...state.work, [id]: NO_WORK },
      });
      return { ok: true, id };
    },

    selectSession: (id) => set({ activeSessionId: id }),

    addFile: (sessionId, path) => {
      const trimmed = path.trim();
      if (trimmed === '') return;
      withWork(sessionId, (work) =>
        work.files.some((file) => file.path === trimmed)
          ? work
          : { ...work, files: [...work.files, { path: trimmed, baseline: '', working: '' }] },
      );
    },

    editFile: (sessionId, path, working) =>
      withWork(sessionId, (work) => ({
        ...work,
        files: work.files.map((file) => (file.path === path ? { ...file, working } : file)),
      })),

    saveFile: (sessionId, path) =>
      withWork(sessionId, (work) => ({
        ...work,
        files: work.files.map((file) =>
          file.path === path ? { ...file, baseline: file.working } : file,
        ),
        // A save moves the baseline up to the working copy, so the file's
        // whole diff goes and every comment on it has nothing left to point at.
        // This is the *erased* case and only that. The narrower and more common
        // case — the diff is still there but has moved under the comment — is
        // not answerable here and is not answered here: see `LineComment`.
        comments: work.comments.filter((comment) => comment.path !== path),
      })),

    addComment: (sessionId, anchor, body) => {
      const text = body.trim();
      if (text === '') return;
      const id = `comment-${get().nextCommentSeq}`;
      set({ nextCommentSeq: get().nextCommentSeq + 1 });
      withWork(sessionId, (work) => ({
        ...work,
        comments: [...work.comments, { ...anchor, id, body: text }],
      }));
    },

    removeComment: (sessionId, commentId) =>
      withWork(sessionId, (work) => ({
        ...work,
        comments: work.comments.filter((comment) => comment.id !== commentId),
      })),

    queueMessage: (sessionId, message) => {
      const text = message.trim();
      if (text === '') return;
      withWork(sessionId, (work) => ({ ...work, queue: [...work.queue, text] }));
    },

    submitComments: (sessionId, message) =>
      withWork(sessionId, (work) =>
        work.comments.length === 0
          ? work
          : { ...work, comments: [], queue: [...work.queue, message] },
      ),
  };
});

/** One session's work, or the empty one. Never `undefined`, so a pane can render. */
export function workOf(
  state: Pick<CodeWorkspaceState, 'work'>,
  sessionId: string | null,
): SessionWork {
  if (sessionId === null) return NO_WORK;
  return state.work[sessionId] ?? NO_WORK;
}

/** Test helper: put the store back to its initial values between renders. */
export function resetCodeWorkspaceStore(): void {
  useCodeWorkspaceStore.setState({ ...INITIAL });
}
