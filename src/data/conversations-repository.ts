/**
 * The conversation list, as the navigation surface needs it.
 *
 * A plain factory over a {@link PlatformAdapter} — no React, no singleton, no
 * SQL. Every method is one host command; the reshaping this layer does is
 * limited to naming things for the UI and refusing to invent data the host did
 * not send.
 *
 * Errors propagate as `PlatformError`. In particular `NOT_FOUND` from a delete
 * or a rename is passed through rather than swallowed: the sidebar asked about
 * a specific row, and "it is not there any more" is an answer it has to render.
 */

import type { PlatformAdapter } from '@/platform/adapter';
import type {
  ConversationSummary,
  MessageHit,
  StoreSearchRes,
} from '@/platform/contract';

/** What a search produced, in its two labelled halves. */
export interface SearchResults {
  readonly conversations: readonly ConversationSummary[];
  readonly messages: readonly MessageHit[];
}

export interface ConversationsRepository {
  list(limit?: number): Promise<readonly ConversationSummary[]>;
  create(title?: string): Promise<ConversationSummary>;
  rename(conversationId: string, title: string): Promise<ConversationSummary>;
  remove(conversationId: string): Promise<void>;
  /**
   * Asks the host to name an untitled conversation after what was said in it.
   * Idempotent and non-destructive: a conversation the user has titled comes
   * back unchanged, so the caller may ask about every placeholder it lists
   * without tracking which ones it has already asked about.
   */
  autotitle(conversationId: string): Promise<ConversationSummary>;
  search(query: string, limit?: number): Promise<SearchResults>;
}

export function createConversationsRepository(adapter: PlatformAdapter): ConversationsRepository {
  return {
    async list(limit?: number): Promise<readonly ConversationSummary[]> {
      const response = await adapter.invoke(
        'store_list_conversations',
        limit === undefined ? {} : { limit },
      );
      return response.conversations;
    },

    async create(title?: string): Promise<ConversationSummary> {
      const response = await adapter.invoke(
        'store_create_conversation',
        title === undefined ? {} : { title },
      );
      return response.conversation;
    },

    async rename(conversationId: string, title: string): Promise<ConversationSummary> {
      const response = await adapter.invoke('store_rename_conversation', {
        conversationId,
        title,
      });
      return response.conversation;
    },

    async remove(conversationId: string): Promise<void> {
      await adapter.invoke('store_delete_conversation', { conversationId });
    },

    async autotitle(conversationId: string): Promise<ConversationSummary> {
      const response = await adapter.invoke('store_autotitle_conversation', { conversationId });
      return response.conversation;
    },

    async search(query: string, limit?: number): Promise<SearchResults> {
      const response: StoreSearchRes = await adapter.invoke(
        'store_search',
        limit === undefined ? { query } : { query, limit },
      );
      return { conversations: response.conversations, messages: response.messages };
    },
  };
}
