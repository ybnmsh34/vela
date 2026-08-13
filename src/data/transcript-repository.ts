/**
 * The messages inside one conversation, as the transcript surface needs them.
 *
 * A plain factory over a {@link PlatformAdapter}, exactly like
 * `conversations-repository.ts`: one host command per method, no React, no
 * singleton, no SQL, and no reshaping beyond unwrapping the response envelope.
 *
 * ## Why this file did not exist until now
 *
 * Everything on both sides of it did. `src-tauri/src/ipc/transcript.rs`
 * implements the three commands; `contract.ts` types them and lists them in
 * `COMMAND_ALLOWLIST`; `BrowserAdapter` fakes them and has its own test file;
 * `ConversationSurface` even takes an `initialEntries` prop whose doc comment
 * says "a transcript restored from the store". The renderer never called any of
 * it, so the transcript lived and died in React state — and `App.tsx` remounts
 * the surface on `key={conversationId}`, so clicking another conversation and
 * clicking back was enough to lose everything that had been said.
 *
 * That is the composition-root defect one more time: two correct halves and no
 * joint. This is the joint.
 */

import type { PlatformAdapter } from '@/platform/adapter';
import type {
  StoreAppendMessageReq,
  StoreListMessagesReq,
  StoreUpdateMessageReq,
  StoredMessage,
} from '@/platform/contract';

export interface TranscriptRepository {
  /**
   * The conversation's messages in store order.
   *
   * Reasoning is included: the surface can collapse it, and the *sending* path
   * has its own projection that leaves it out. A store read that dropped it
   * would make the collapse impossible rather than optional.
   */
  list(conversationId: string): Promise<readonly StoredMessage[]>;
  append(request: StoreAppendMessageReq): Promise<StoredMessage>;
  update(request: StoreUpdateMessageReq): Promise<StoredMessage>;
  /**
   * Used by retry, which replaces the tail of a conversation rather than
   * appending to it. `NOT_FOUND` propagates: the caller asked about a specific
   * row it believes it wrote.
   */
  remove(messageId: string): Promise<void>;
}

export function createTranscriptRepository(adapter: PlatformAdapter): TranscriptRepository {
  return {
    async list(conversationId: string): Promise<readonly StoredMessage[]> {
      const request: StoreListMessagesReq = { conversationId };
      const response = await adapter.invoke('store_list_messages', request);
      return response.messages;
    },

    async append(request: StoreAppendMessageReq): Promise<StoredMessage> {
      const response = await adapter.invoke('store_append_message', request);
      return response.message;
    },

    async update(request: StoreUpdateMessageReq): Promise<StoredMessage> {
      const response = await adapter.invoke('store_update_message', request);
      return response.message;
    },

    async remove(messageId: string): Promise<void> {
      await adapter.invoke('store_delete_message', { messageId });
    },
  };
}
