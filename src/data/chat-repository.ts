/**
 * The conversation surface's one door to the host.
 *
 * Adapter in, domain shapes out — no React, no component imports, so the whole
 * streaming protocol is testable with no DOM at all.
 *
 * ## The ordering rule this file exists to enforce
 *
 * `chat_send` returns as soon as the host has *accepted* the turn; the tokens
 * follow on the `chat:event` channel, and the first one can be emitted before
 * the invoke promise settles. A caller that subscribed after sending would drop
 * it. So the repository subscribes **first**, once, for the lifetime of the
 * process, and multiplexes events to turns by id. Callers cannot get this
 * wrong because they never touch `listen` themselves.
 *
 * ## Unknown turns
 *
 * An event for a turn nobody is listening to is dropped silently rather than
 * throwing. It is the normal shape of a race: cancel, unmount, then one last
 * frame that was already in flight arrives.
 */

import type { PlatformAdapter } from '@/platform/adapter';
import type { ChatEventEnvelope, ChatMessageInput, ChatStreamEvent } from '@/platform/contract';

export interface StreamTurnRequest {
  /**
   * Minted by the caller, because events for it can arrive before `chat_send`
   * resolves. Use {@link newTurnId}.
   */
  readonly turnId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly messages: readonly ChatMessageInput[];
  /** Called for every event of this turn, in arrival order. */
  readonly onEvent: (event: ChatStreamEvent) => void;
}

export interface TurnHandle {
  readonly turnId: string;
  /** Asks the host to stop. `false` means the turn had already finished. */
  cancel(): Promise<boolean>;
  /** Stops delivering events to `onEvent`. Idempotent. */
  release(): void;
}

export interface ChatRepository {
  streamTurn(request: StreamTurnRequest): Promise<TurnHandle>;
}

/**
 * A turn id. `crypto.randomUUID` where it exists — every browser Vela targets
 * and the Tauri webview — with a counter fallback so a test environment
 * without it still produces unique ids rather than throwing.
 */
export function newTurnId(): string {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  turnCounter += 1;
  return `turn-${String(turnCounter)}-${String(Date.now())}`;
}

let turnCounter = 0;

export function createChatRepository(adapter: PlatformAdapter): ChatRepository {
  const routes = new Map<string, (event: ChatStreamEvent) => void>();
  let subscription: Promise<unknown> | null = null;

  function ensureSubscribed(): Promise<unknown> {
    subscription ??= adapter.listen('chat:event', (payload: ChatEventEnvelope) => {
      routes.get(payload.turnId)?.(payload.event);
    });
    return subscription;
  }

  return {
    async streamTurn(request: StreamTurnRequest): Promise<TurnHandle> {
      await ensureSubscribed();
      routes.set(request.turnId, request.onEvent);

      const handle: TurnHandle = {
        turnId: request.turnId,
        async cancel(): Promise<boolean> {
          const result = await adapter.invoke('chat_cancel', { turnId: request.turnId });
          return result.cancelled;
        },
        release(): void {
          routes.delete(request.turnId);
        },
      };

      try {
        await adapter.invoke('chat_send', {
          turnId: request.turnId,
          providerId: request.providerId,
          modelId: request.modelId,
          messages: request.messages,
        });
      } catch (error) {
        // A refused turn has no stream, so its route would leak. Errors
        // propagate as `PlatformError` — never swallowed into a null handle.
        handle.release();
        throw error;
      }

      return handle;
    },
  };
}
