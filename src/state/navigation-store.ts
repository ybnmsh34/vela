/**
 * Client state for the navigation surface: which conversation is open, how wide
 * the sidebar is, and whether the quick switcher is up.
 *
 * Rules from conventions §5, followed here: state and actions only, **no IPC**.
 * The sidebar width is persisted through `layout-repository` by the hook that
 * owns it (`use-sidebar-layout.ts`), never from inside this store.
 *
 * Width lives here rather than in a component because two things read it — the
 * sidebar itself and the drag handle's live preview — and because the palette
 * has to be openable from a keyboard handler mounted somewhere else entirely.
 */

import { create } from 'zustand';

/**
 * What the command bar is doing. One control, two jobs, because they share a
 * list and a keyboard model: `switcher` filters the conversations you have,
 * `search` also asks the host about their contents.
 */
export type PaletteMode = 'closed' | 'switcher' | 'search';

/** Mirrors the bounds the host clamps to (`src-tauri/src/ipc/ui.rs`). */
export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 480;
export const DEFAULT_SIDEBAR_WIDTH = 280;

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

interface NavigationState {
  readonly selectedConversationId: string | null;
  /**
   * How many unsaved conversations this window has been asked to start.
   *
   * Only incognito produces one. Everywhere else **New conversation** mints a
   * row and the new id is what makes the transcript surface remount; in
   * incognito `store_create_conversation` is refused, so there is no id to
   * change and pressing the button a second time would have left the previous
   * conversation on screen. This counter is the id's stand-in.
   *
   * RULE U — its reader is `src/app/App.tsx`, which puts it in the
   * `ConversationSurface` `key` alongside the conversation id, and
   * `src/app/instructions-and-incognito.test.tsx` is what observes that the
   * remount happens. It is deliberately not a boolean: two presses in a row
   * have to differ, or the second is a no-op.
   */
  readonly draftCount: number;
  readonly sidebarWidth: number;
  readonly sidebarCollapsed: boolean;
  readonly paletteMode: PaletteMode;

  select: (conversationId: string | null) => void;
  /**
   * Start a conversation that has no row behind it.
   *
   * Called by `use-conversations.ts` when the host refuses the create with
   * `INCOGNITO_REFUSED` — the one refusal that is the mode working rather than
   * failing, handled the same way `use-theme.ts` handles its own.
   */
  startDraft: () => void;
  setSidebarWidth: (width: number) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  openPalette: (mode: Exclude<PaletteMode, 'closed'>) => void;
  closePalette: () => void;
}

export const useNavigationStore = create<NavigationState>((set, get) => ({
  selectedConversationId: null,
  draftCount: 0,
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  sidebarCollapsed: false,
  paletteMode: 'closed',

  select: (conversationId) => set({ selectedConversationId: conversationId }),
  startDraft: () => set({ selectedConversationId: null, draftCount: get().draftCount + 1 }),
  // Clamped on the way in as well as in the host: the drag handle reads this
  // back every frame, and an unclamped value would render before the host ever
  // saw it.
  setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
  openPalette: (mode) => set({ paletteMode: mode }),
  closePalette: () => set({ paletteMode: 'closed' }),
}));

/** Test helper: put the store back to its initial values between renders. */
export function resetNavigationStore(): void {
  useNavigationStore.setState({
    selectedConversationId: null,
    draftCount: 0,
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    sidebarCollapsed: false,
    paletteMode: 'closed',
  });
}
