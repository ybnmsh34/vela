/**
 * The conversation's state and its wiring to the host.
 *
 * ## Why the events are batched, and why the first one is not
 *
 * The core terminates streams in single-digit milliseconds and a fast endpoint
 * can push frames far quicker than a browser paints. Committing React state per
 * frame would re-render the transcript dozens of times per animation frame and
 * throw away exactly the headroom the core worked for.
 *
 * So events are queued and applied once per frame — **except** the first event
 * of a turn and any terminal event, which are applied synchronously. That is
 * the whole trick: time-to-first-token pays no scheduling tax at all, and every
 * frame after it is coalesced. Waiting a frame to draw the first token would
 * add up to ~16 ms to the one number the user actually feels.
 *
 * Batching is injectable (`scheduleCommit`) so tests drive it deterministically
 * instead of waiting on `requestAnimationFrame`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createChatRepository, newTurnId, type ChatRepository, type TurnHandle } from '@/data/chat-repository';
import { usePlatform } from '@/platform/PlatformProvider';
import type { ChatMessageInput, ChatStreamEvent } from '@/platform/contract';
import { PlatformError } from '@/platform/errors';

import { EMPTY_TURN, isSettled, isTerminalEvent, reduceTurn, type TurnState } from './turn-stream';

export type ConversationEntry =
  | { readonly kind: 'user'; readonly id: string; readonly text: string }
  | { readonly kind: 'assistant'; readonly id: string; readonly turn: TurnState };

export interface UseConversationOptions {
  /** Substituted in tests; defaults to one built over the platform adapter. */
  readonly repository?: ChatRepository;
  /** `null` until the user has chosen where this conversation runs. */
  readonly providerId?: string | null;
  readonly modelId?: string | null;
  readonly initialEntries?: readonly ConversationEntry[];
  /** Defaults to `requestAnimationFrame`. */
  readonly scheduleCommit?: (run: () => void) => void;
}

export interface Conversation {
  readonly entries: readonly ConversationEntry[];
  readonly streaming: boolean;
  /** `null` when sending is possible; otherwise why it is not. */
  readonly blockedReason: string | null;
  send: (text: string) => void;
  stop: () => void;
  /** Re-runs the last user message. No-op when there is nothing to re-run. */
  retry: () => void;
}

function defaultScheduler(run: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => {
    run();
  });
  else queueMicrotask(run);
}

export function useConversation(options: UseConversationOptions = {}): Conversation {
  const adapter = usePlatform();
  const repository = useMemo(
    () => options.repository ?? createChatRepository(adapter),
    [options.repository, adapter],
  );
  const schedule = options.scheduleCommit ?? defaultScheduler;
  const providerId = options.providerId ?? null;
  const modelId = options.modelId ?? null;

  const [entries, setEntries] = useState<readonly ConversationEntry[]>(
    () => options.initialEntries ?? [],
  );
  const [streaming, setStreaming] = useState(false);

  // Read by `send`/`retry`, which need the current transcript without taking a
  // dependency on it — a side effect inside a state updater would run twice
  // under StrictMode and start the turn twice.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const active = useRef<{ id: string; handle: TurnHandle | null } | null>(null);
  const queue = useRef<ChatStreamEvent[]>([]);
  const scheduled = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    // Set on the way *in*, not just cleared on the way out. React runs mount →
    // unmount → mount under StrictMode, and a flag that is only ever cleared
    // stays cleared: every frame of every later turn is dropped, and the
    // surface sits on "waiting for the first token" forever. Found by rendering
    // it, not by a test — which is why there is now a test.
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.handle?.release();
    };
  }, []);

  const drain = useCallback((turnId: string) => {
    scheduled.current = false;
    const events = queue.current;
    if (events.length === 0) return;
    queue.current = [];

    setEntries((current) =>
      current.map((entry) => {
        if (entry.kind !== 'assistant' || entry.id !== turnId) return entry;
        return { ...entry, turn: events.reduce(reduceTurn, entry.turn) };
      }),
    );
  }, []);

  const onEvent = useCallback(
    (turnId: string, event: ChatStreamEvent, isFirst: () => boolean) => {
      if (!mounted.current) return;
      queue.current.push(event);

      // The first token and the end of the turn are the two moments the user is
      // waiting on. Neither waits for a frame.
      if (isFirst() || isTerminalEvent(event)) {
        drain(turnId);
        if (isTerminalEvent(event)) {
          active.current?.handle?.release();
          active.current = null;
          setStreaming(false);
        }
        return;
      }

      if (scheduled.current) return;
      scheduled.current = true;
      schedule(() => {
        drain(turnId);
      });
    },
    [drain, schedule],
  );

  const start = useCallback(
    (history: readonly ConversationEntry[], userText: string) => {
      if (providerId === null || modelId === null) return;

      const turnId = newTurnId();
      const userEntry: ConversationEntry = { kind: 'user', id: `${turnId}-user`, text: userText };
      const assistantEntry: ConversationEntry = { kind: 'assistant', id: turnId, turn: EMPTY_TURN };

      setEntries([...history, userEntry, assistantEntry]);
      setStreaming(true);
      queue.current = [];
      scheduled.current = false;
      active.current = { id: turnId, handle: null };

      let seen = 0;
      const isFirst = (): boolean => {
        seen += 1;
        return seen === 1;
      };

      void repository
        .streamTurn({
          turnId,
          providerId,
          modelId,
          messages: toMessages(history, userText),
          onEvent: (event) => {
            onEvent(turnId, event, isFirst);
          },
        })
        .then((handle) => {
          // The turn may have already finished by the time this resolves —
          // a terminal event clears `active`, and re-attaching here would leak
          // a handle nobody releases.
          if (active.current?.id === turnId) active.current = { id: turnId, handle };
          else handle.release();
        })
        .catch((error: unknown) => {
          if (!mounted.current) return;
          active.current = null;
          setStreaming(false);
          setEntries((current) =>
            current.map((entry) =>
              entry.kind === 'assistant' && entry.id === turnId
                ? { ...entry, turn: { ...entry.turn, phase: 'failed', refusal: refusalOf(error) } }
                : entry,
            ),
          );
        });
    },
    [modelId, onEvent, providerId, repository],
  );

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed === '' || streaming) return;
      start(entriesRef.current, trimmed);
    },
    [start, streaming],
  );

  const stop = useCallback(() => {
    const handle = active.current?.handle;
    if (handle === undefined || handle === null) return;
    void handle.cancel();
  }, []);

  const retry = useCallback(() => {
    if (streaming) return;
    const current = entriesRef.current;
    const lastUser = [...current].reverse().find((entry) => entry.kind === 'user');
    if (lastUser === undefined) return;
    // Everything before that user turn is the history; the failed reply and the
    // message itself are replaced, not appended to.
    start(current.slice(0, current.indexOf(lastUser)), lastUser.text);
  }, [start, streaming]);

  const blockedReason =
    providerId === null || modelId === null ? 'Choose a model to start a conversation' : null;

  return { entries, streaming, blockedReason, send, stop, retry };
}

/**
 * The transcript as the host wants it.
 *
 * Reasoning is deliberately **not** sent back: it is the model's private
 * deliberation, the store keeps it as a separate part for exactly this reason,
 * and re-feeding it invites a model to treat its own musings as commitments.
 * A turn that only ever produced reasoning contributes nothing, and is dropped
 * rather than sent as an empty assistant message that some endpoints reject.
 */
function toMessages(
  history: readonly ConversationEntry[],
  userText: string,
): readonly ChatMessageInput[] {
  const messages: ChatMessageInput[] = [];
  for (const entry of history) {
    if (entry.kind === 'user') messages.push({ role: 'user', text: entry.text });
    else if (isSettled(entry.turn) && entry.turn.answer !== '')
      messages.push({ role: 'assistant', text: entry.turn.answer });
  }
  messages.push({ role: 'user', text: userText });
  return messages;
}

function refusalOf(error: unknown): { code: string; message: string } {
  if (error instanceof PlatformError) return { code: error.code, message: error.message };
  return { code: 'INTERNAL', message: 'The host refused the request.' };
}
