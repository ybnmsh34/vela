/**
 * The conversation list, loaded once and shared by everything that navigates.
 *
 * Three surfaces read the same list — the sidebar, the quick switcher and the
 * home screen's "recent" strip — so it is held in one context provider rather
 * than fetched three times. Conventions §5: host data lives beside its feature
 * unless two features genuinely share it; these are one feature.
 *
 * Loading and failure are an explicit union, never `undefined` doing double
 * duty. A sidebar that cannot reach the store must say so — an empty list and a
 * broken bridge look identical otherwise, and one of them is a lie.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { createConversationsRepository, type SearchResults } from '@/data/conversations-repository';
import { usePlatform } from '@/platform/PlatformProvider';
import type { ConversationSummary } from '@/platform/contract';
import { toPlatformError } from '@/platform/errors';
import { useNavigationStore } from '@/state/navigation-store';

export type ConversationsState =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly conversations: readonly ConversationSummary[] }
  | { readonly state: 'error'; readonly code: string; readonly message: string };

export interface ConversationsApi {
  readonly status: ConversationsState;
  /** Convenience: the list, or empty while loading or failed. */
  readonly conversations: readonly ConversationSummary[];
  reload: () => Promise<void>;
  createConversation: () => Promise<ConversationSummary | null>;
  renameConversation: (conversationId: string, title: string) => Promise<void>;
  deleteConversation: (conversationId: string) => Promise<void>;
  search: (query: string) => Promise<SearchResults>;
  /** The last action's failure, or `null`. Cleared by the next successful one. */
  readonly actionError: string | null;
}

/** Populated by `<ConversationsProvider>`; read through {@link useConversations}. */
export const ConversationsContext = createContext<ConversationsApi | null>(null);

export function useConversations(): ConversationsApi {
  const api = useContext(ConversationsContext);
  if (api === null) {
    throw new Error('useConversations must be used inside <ConversationsProvider>');
  }
  return api;
}

/**
 * The stateful half of the provider, kept out of the component file so this
 * stays a plain `use-*.ts` hook with no JSX in it.
 */
export function useConversationsApi(): ConversationsApi {
  const adapter = usePlatform();
  const repository = useMemo(() => createConversationsRepository(adapter), [adapter]);
  const [status, setStatus] = useState<ConversationsState>({ state: 'loading' });
  const [actionError, setActionError] = useState<string | null>(null);
  const select = useNavigationStore((state) => state.select);
  const startDraft = useNavigationStore((state) => state.startDraft);
  const selectedId = useNavigationStore((state) => state.selectedConversationId);

  /**
   * Conversations already offered a derived title. Asking twice is harmless —
   * the host is idempotent — but it would be a command per render, and the
   * sidebar re-renders on every keystroke in the search box.
   */
  const autotitled = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const conversations = await repository.list();
      if (mounted.current) setStatus({ state: 'ready', conversations });
    } catch (thrown) {
      const error = toPlatformError(thrown);
      if (mounted.current) {
        setStatus({ state: 'error', code: error.code, message: error.message });
      }
    }
  }, [repository]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Names the untitled conversations that have something to be named after.
   *
   * The host owns the rule; this only decides *when* to ask. It runs after a
   * load rather than at creation time because a conversation is created empty:
   * there is nothing to derive a title from until a turn has been stored.
   */
  useEffect(() => {
    if (status.state !== 'ready') return;
    const pending = status.conversations.filter(
      (conversation) =>
        conversation.titleIsPlaceholder &&
        conversation.messageCount > 0 &&
        !autotitled.current.has(conversation.id),
    );
    if (pending.length === 0) return;

    void (async () => {
      let changed = false;
      for (const conversation of pending) {
        autotitled.current.add(conversation.id);
        try {
          const named = await repository.autotitle(conversation.id);
          if (named.title !== conversation.title) changed = true;
        } catch {
          // A conversation that could not be titled keeps its placeholder. That
          // is a cosmetic loss, and never a reason to break the list.
        }
      }
      if (changed && mounted.current) await load();
    })();
  }, [status, repository, load]);

  /**
   * **New conversation**, from all five of the places that offer it.
   *
   * Counted, not remembered: `grep -rn 'createConversation()' src/ --include=*.ts
   * --include=*.tsx` outside tests names `Sidebar.tsx` twice (the wide button
   * and the collapsed icon), `CommandPalette.tsx`, `HomeSurface.tsx`'s **Start a
   * conversation**, and `NavigationSurface.tsx`, which is where `Ctrl/Cmd+N`
   * arrives. The home screen is not on screen in incognito — `NavigationSurface`
   * fills the content region with the transcript instead — so four of the five
   * are reachable in the mode, and all five go through here.
   *
   * ## The incognito branch, and why it is here rather than at those four
   *
   * `store_create_conversation` is classified `writes`, so the wrapper in
   * `src/platform/incognito-adapter.ts` refuses it and this `catch` runs. Before
   * this branch existed, the most prominent control in the window answered a
   * press by painting the refusal into the sidebar's error line — a raw internal
   * message, in the mode a user enters precisely because they want it to behave
   * normally.
   *
   * `INCOGNITO_REFUSED` is handled the way `use-theme.ts` handles its own: as
   * the mode working rather than failing. An incognito conversation is an
   * unsaved one — `conversationId === null`, no restore on the way in and no
   * write on settle — so a new one is a cleared selection and a fresh surface,
   * which is exactly what `startDraft` does. Nothing is quietly reduced: the
   * user asked for a new conversation and gets one, and the three indications
   * the mode already carries are what say it will not be kept.
   *
   * The branch is here and not at the four call sites for the same reason the
   * refusal itself is at the adapter: a rule enforced at call sites is a rule
   * the next call site does not know about.
   */
  const createConversation = useCallback(async (): Promise<ConversationSummary | null> => {
    try {
      const created = await repository.create();
      setActionError(null);
      await load();
      select(created.id);
      return created;
    } catch (thrown) {
      const error = toPlatformError(thrown);
      if (error.code === 'INCOGNITO_REFUSED') {
        setActionError(null);
        startDraft();
        return null;
      }
      setActionError(error.message);
      return null;
    }
  }, [repository, load, select, startDraft]);

  const renameConversation = useCallback(
    async (conversationId: string, title: string) => {
      try {
        await repository.rename(conversationId, title);
        // A user-chosen title must never be overwritten by a derived one, and
        // the host agrees — but remembering it here saves the round trip.
        autotitled.current.add(conversationId);
        setActionError(null);
        await load();
      } catch (thrown) {
        setActionError(toPlatformError(thrown).message);
      }
    },
    [repository, load],
  );

  const deleteConversation = useCallback(
    async (conversationId: string) => {
      try {
        await repository.remove(conversationId);
        setActionError(null);
        if (selectedId === conversationId) select(null);
        await load();
      } catch (thrown) {
        setActionError(toPlatformError(thrown).message);
      }
    },
    [repository, load, select, selectedId],
  );

  const search = useCallback(
    (query: string): Promise<SearchResults> => repository.search(query),
    [repository],
  );

  const api = useMemo<ConversationsApi>(
    () => ({
      status,
      conversations: status.state === 'ready' ? status.conversations : [],
      reload: load,
      createConversation,
      renameConversation,
      deleteConversation,
      search,
      actionError,
    }),
    [status, load, createConversation, renameConversation, deleteConversation, search, actionError],
  );

  return api;
}
