/**
 * `TurnDriver` over the platform adapter — the three chat commands, and nothing
 * else.
 *
 * Conventions §1 keeps every host call in `src/data/`, which is why this sits
 * beside `createTranscriptRepository` rather than inside `src/runtime/`: a
 * harness must never see a `PlatformAdapter`, and this is the boundary that
 * makes sure it does not have to. `contract-harness.ts` states the reason —
 * given an adapter, a harness could write settings, delete conversations and
 * ask about credentials, none of which driving a turn requires.
 *
 * This is deliberately *not* `createChatRepository`. That one owns a route table
 * keyed by turn id and hands each caller a per-turn callback, which is the right
 * shape for the conversation surface and the wrong one here: `TurnDriver.listen`
 * is documented to deliver **every** turn's events, including turns this harness
 * did not start, so that a harness can subscribe once before its first `send`
 * and never race the first token. Two consumers, two shapes, one adapter.
 */

import type { PlatformAdapter } from '@/platform/adapter';
import type { Unsubscribe } from '@/platform/adapter';
import type {
  ChatCancelReq,
  ChatCancelRes,
  ChatEventEnvelope,
  ChatSendReq,
  ChatSendRes,
} from '@/platform/contract';
import type { TurnDriver } from '@/platform/contract-harness';

export function createTurnDriver(adapter: PlatformAdapter): TurnDriver {
  return {
    send: (request: ChatSendReq): Promise<ChatSendRes> => adapter.invoke('chat_send', request),
    cancel: (request: ChatCancelReq): Promise<ChatCancelRes> =>
      adapter.invoke('chat_cancel', request),
    listen: (handler: (envelope: ChatEventEnvelope) => void): Promise<Unsubscribe> =>
      adapter.listen('chat:event', handler),
  };
}
