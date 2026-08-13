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
 *
 * ## What a turn carries besides its text
 *
 * Whatever the user staged. {@link UseConversationOptions.attachments} is the
 * port ({@link TurnAttachments}) the host fills in with the tray's contents;
 * `send` reads it, puts the parts on the outgoing message, and clears it.
 *
 * That connection is the whole of a defect this project shipped: the tray, the
 * picker, the capability gate, `toContentParts`, `ChatMessageInput.parts` and
 * the host's `ContentPartDto` all existed and were all tested, and pressing
 * Send discarded the user's picture without a word, because nothing read the
 * tray. The reading happens **here**, in the same function that builds the
 * payload, so a future reader cannot wire one without the other.
 *
 * The parts are then kept on the user's entry, which is what makes the picture
 * part of the *conversation* rather than of one request: it is replayed with
 * the history on every later turn, re-sent by `retry`, and written to the
 * store with the message.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createChatRepository, newTurnId, type ChatRepository, type TurnHandle } from '@/data/chat-repository';
import { createTranscriptRepository, type TranscriptRepository } from '@/data/transcript-repository';
import { usePlatform } from '@/platform/PlatformProvider';
import type { ChatMessageInput, ChatStreamEvent, ContentPartInput } from '@/platform/contract';
import { PlatformError } from '@/platform/errors';

import { entriesFromStored, errorMessageOfTurn, partsOfTurn, statusOfTurn } from './stored-entries';
import type { TurnAttachments } from './turn-attachments';
import { EMPTY_TURN, isSettled, isTerminalEvent, reduceTurn, type TurnState } from './turn-stream';

export type ConversationEntry =
  | {
      readonly kind: 'user';
      readonly id: string;
      readonly text: string;
      /**
       * What was attached to this message: an image, an inlined file. Absent
       * for the ordinary turn, and never empty when present.
       */
      readonly parts?: readonly ContentPartInput[];
    }
  | { readonly kind: 'assistant'; readonly id: string; readonly turn: TurnState };

/** No attachments, as a shared constant so `send` allocates nothing per turn. */
const NO_PARTS: readonly ContentPartInput[] = [];

/** Shown instead of the transcript's contents when the store cannot be read. */
const UNREADABLE = 'This conversation could not be read from the store';

export interface UseConversationOptions {
  /** Substituted in tests; defaults to one built over the platform adapter. */
  readonly repository?: ChatRepository;
  /**
   * Which conversation this is, so the transcript is a record rather than a
   * session: `null` means nothing is loaded and nothing is written.
   */
  readonly conversationId?: string | null;
  /** Substituted in tests; defaults to one built over the platform adapter. */
  readonly transcript?: TranscriptRepository;
  /** `null` until the user has chosen where this conversation runs. */
  readonly providerId?: string | null;
  readonly modelId?: string | null;
  /**
   * A transcript supplied by the caller. When given, the store is not read —
   * the caller is the authority for this mount. Turns are still written.
   */
  readonly initialEntries?: readonly ConversationEntry[];
  /**
   * The files the user staged for the next message, if anything is holding
   * any. `null`/omitted is a surface with no attach affordance at all, not a
   * surface whose tray happens to be empty.
   */
  readonly attachments?: TurnAttachments | null;
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
  const transcript = useMemo(
    () => options.transcript ?? createTranscriptRepository(adapter),
    [options.transcript, adapter],
  );
  const schedule = options.scheduleCommit ?? defaultScheduler;
  const providerId = options.providerId ?? null;
  const modelId = options.modelId ?? null;
  const conversationId = options.conversationId ?? null;
  const supplied = options.initialEntries;

  const [entries, setEntries] = useState<readonly ConversationEntry[]>(() => supplied ?? []);
  const [streaming, setStreaming] = useState(false);
  const [unreadable, setUnreadable] = useState(false);

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

  /**
   * Which store row each rendered entry was written as. Seeded by a restore
   * (where the entry id *is* the message id) and extended by every turn this
   * mount writes, so `retry` knows what it is replacing.
   */
  const messageIds = useRef(new Map<string, string>());
  /** Entries a write has already been started for. Claimed before the await. */
  const claimed = useRef(new Set<string>());
  /**
   * Whether anything has happened on this mount yet.
   *
   * The restore below is a read that started before the user could act, and it
   * can still be in flight when they do. Applying it then would replace the
   * turn they just sent with the transcript as it was a moment earlier — the
   * message disappearing as they watch. So the restore is only ever applied to
   * an untouched surface.
   */
  const touched = useRef(false);

  /**
   * Every store mutation, in order, on one chain.
   *
   * The alternative is a set of independent promises whose interleaving decides
   * the order rows land in — and the transcript's order *is* its meaning. One
   * chain also makes `retry`'s delete land after the writes it is deleting,
   * without any of them having to know about each other. A failed write breaks
   * the record, not the chain: the surface keeps rendering what it has.
   */
  const writes = useRef<Promise<void>>(Promise.resolve());
  const enqueue = useCallback((work: () => Promise<void>) => {
    writes.current = writes.current.then(work).catch(() => {
      // Deliberately swallowed: a store that cannot be written is not a reason
      // to stop drawing the answer that is already on screen. The next mount
      // reads what did land, and says so if it cannot read at all.
    });
  }, []);

  /**
   * Read the conversation back on the way in.
   *
   * `App.tsx` remounts this surface on `key={conversationId}`, so this runs once
   * per conversation the user opens — which is exactly the moment the record
   * has to reappear.
   */
  useEffect(() => {
    if (conversationId === null || supplied !== undefined) return;
    let abandoned = false;
    void (async () => {
      try {
        const messages = await transcript.list(conversationId);
        if (abandoned || !mounted.current || touched.current) return;
        const restored = entriesFromStored(messages);
        for (const entry of restored) {
          messageIds.current.set(entry.id, entry.id);
          // Claimed as well as mapped: the write-on-settle effect below fires
          // for whatever settled turn is last in the transcript, and a restored
          // turn is already settled. Without this, opening a conversation
          // would append its own last turn to it again, every time.
          claimed.current.add(entry.id);
        }
        setEntries(restored);
      } catch {
        // An empty transcript and an unreadable one look identical on screen,
        // and one of them is a lie — so this one says which it is, and blocks
        // sending. Appending a turn to a history that failed to load would
        // write a reply with the conversation missing from behind it.
        if (!abandoned && mounted.current) setUnreadable(true);
      }
    })();
    return () => {
      abandoned = true;
    };
  }, [conversationId, supplied, transcript]);

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

  /**
   * Mark a turn as never having started, with a reason the user can read.
   *
   * The same shape whether the refusal came from the host or from a file that
   * could not be read: both are "this turn did not happen, and here is why",
   * and the transcript already knows how to draw one of those.
   */
  const refuseTurn = useCallback(
    (turnId: string, refusal: { code: string; message: string }) => {
      active.current = null;
      setStreaming(false);
      setEntries((current) =>
        current.map((entry) =>
          entry.kind === 'assistant' && entry.id === turnId
            ? { ...entry, turn: { ...entry.turn, phase: 'failed', refusal } }
            : entry,
        ),
      );
    },
    [],
  );

  /**
   * `prepare` produces what this message carries besides its text.
   *
   * A function rather than a value because reading a file is I/O: the user's
   * turn goes on screen in the same tick they pressed Send, and the bytes are
   * gathered after. A read that fails takes the turn down with a sentence
   * naming the file — it never sends a message with the attachment quietly
   * missing.
   */
  const start = useCallback(
    (
      history: readonly ConversationEntry[],
      userText: string,
      prepare: () => Promise<readonly ContentPartInput[]>,
    ) => {
      if (providerId === null || modelId === null) return;

      const turnId = newTurnId();
      const userId = `${turnId}-user`;
      const userEntry: ConversationEntry = { kind: 'user', id: userId, text: userText };
      const assistantEntry: ConversationEntry = { kind: 'assistant', id: turnId, turn: EMPTY_TURN };

      // From here the surface is the authority on what this conversation holds,
      // and a restore still in flight must not overwrite it.
      touched.current = true;
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

      void (async () => {
        let parts: readonly ContentPartInput[];
        try {
          parts = await prepare();
        } catch (error: unknown) {
          if (!mounted.current) return;
          refuseTurn(turnId, attachmentRefusal(error));
          return;
        }
        if (!mounted.current) return;

        // Recorded on the entry, not just on the request: this is what makes an
        // attached image part of the conversation — replayed with the history,
        // re-sent by `retry`, written to the store with the message.
        if (parts.length > 0) {
          setEntries((current) =>
            current.map((entry) =>
              entry.kind === 'user' && entry.id === userId ? { ...entry, parts } : entry,
            ),
          );
        }

        try {
          const handle = await repository.streamTurn({
            turnId,
            providerId,
            modelId,
            messages: toMessages(history, userText, parts),
            onEvent: (event) => {
              onEvent(turnId, event, isFirst);
            },
          });
          // The turn may have already finished by the time this resolves —
          // a terminal event clears `active`, and re-attaching here would leak
          // a handle nobody releases.
          if (active.current?.id === turnId) active.current = { id: turnId, handle };
          else handle.release();
        } catch (error: unknown) {
          if (!mounted.current) return;
          refuseTurn(turnId, refusalOf(error));
        }
      })();
    },
    [modelId, onEvent, providerId, refuseTurn, repository],
  );

  /**
   * Read through a ref, because the controller is a fresh object on every
   * render of the host that owns it. Depending on its identity would rebuild
   * `send` every render, and `send` is handed to the composer.
   */
  const attachments = useRef<TurnAttachments | null>(null);
  attachments.current = options.attachments ?? null;

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed === '' || streaming) return;
      start(entriesRef.current, trimmed, async () => {
        const staged = attachments.current;
        if (staged === null || staged.attachments.length === 0) return NO_PARTS;
        const parts = await staged.toContentParts();
        // Cleared only now: the tray is the user's copy of what is about to be
        // sent, and emptying it before the bytes are in hand would lose the
        // file if the read failed.
        staged.clear();
        return parts;
      });
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
    const dropped = current.slice(current.indexOf(lastUser));
    // …and replaced in the store too. Without this the record grows a second
    // copy of every retried message, so the transcript that comes back after a
    // retry is not the transcript the user was looking at when they retried.
    if (conversationId !== null) {
      enqueue(async () => {
        for (const entry of dropped) {
          const messageId = messageIds.current.get(entry.id);
          if (messageId === undefined) continue;
          messageIds.current.delete(entry.id);
          claimed.current.delete(entry.id);
          await transcript.remove(messageId);
        }
      });
    }
    // Re-sent with what it was sent with. The tray was emptied when the turn
    // was first sent, so a retry that read it again would send nothing — the
    // parts on the entry are the record of what this message carries.
    const carried = lastUser.parts ?? NO_PARTS;
    start(current.slice(0, current.indexOf(lastUser)), lastUser.text, () =>
      Promise.resolve(carried),
    );
  }, [conversationId, enqueue, start, streaming, transcript]);

  /**
   * Write the turn once it has settled.
   *
   * Watching the committed transcript rather than hooking the terminal event
   * keeps every store call off the streaming hot path — the whole reason the
   * frames above are batched — and means a turn is written from the same state
   * the user is looking at, not from a reconstruction of it.
   *
   * A turn is written when it settles, not as it opens. That does lose a turn
   * the app never got to finish, and the alternative — opening a `streaming`
   * row and closing it later, which is what `StoreAppendMessageReq.status` and
   * `store_update_message` are shaped for — is the better record. It is not
   * this change: it needs the write to survive an unmount that currently
   * abandons the turn, and both hosts reject a message with no parts, so an
   * opening row would have to carry a placeholder part that the close then has
   * to remember to replace.
   *
   * The question is always written; the reply is written only if it produced
   * something, because a message with no parts is a payload both hosts refuse.
   * So a turn that failed before a single token restores as what it was — the
   * user's message, with nothing after it.
   */
  useEffect(() => {
    if (conversationId === null || streaming) return;
    const reply = entries[entries.length - 1];
    const asked = entries[entries.length - 2];
    if (reply === undefined || reply.kind !== 'assistant' || !isSettled(reply.turn)) return;
    if (asked === undefined || asked.kind !== 'user') return;
    if (claimed.current.has(reply.id)) return;
    claimed.current.add(asked.id);
    claimed.current.add(reply.id);

    const { turn } = reply;
    const parts = partsOfTurn(turn);
    const errorMessage = errorMessageOfTurn(turn);
    enqueue(async () => {
      if (!messageIds.current.has(asked.id)) {
        const written = await transcript.append({
          conversationId,
          role: 'user',
          // The attachment is written down with the message it came with. A
          // record that keeps the question and drops the picture it was asked
          // about is a record of a conversation that never happened.
          parts: [{ kind: 'text', text: asked.text }, ...(asked.parts ?? NO_PARTS)],
        });
        messageIds.current.set(asked.id, written.id);
      }
      if (parts.length === 0) return;
      const written = await transcript.append({
        conversationId,
        role: 'assistant',
        parts,
        status: statusOfTurn(turn),
        providerId,
        modelId,
        ...(turn.stopReason === null ? {} : { stopReason: turn.stopReason }),
        ...(errorMessage === null ? {} : { errorMessage }),
      });
      messageIds.current.set(reply.id, written.id);
    });
  }, [conversationId, enqueue, entries, modelId, providerId, streaming, transcript]);

  const blockedReason = unreadable
    ? UNREADABLE
    : providerId === null || modelId === null
      ? 'Choose a model to start a conversation'
      : null;

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
function historyMessages(history: readonly ConversationEntry[]): ChatMessageInput[] {
  const messages: ChatMessageInput[] = [];
  for (const entry of history) {
    if (entry.kind === 'user') messages.push(userMessage(entry.text, entry.parts ?? NO_PARTS));
    else if (isSettled(entry.turn) && entry.turn.answer !== '')
      messages.push({ role: 'assistant', text: entry.turn.answer });
  }
  return messages;
}

/**
 * `parts` is omitted entirely when there are none — the host composes `text`
 * then `parts`, and an empty array is a field on the wire that means nothing.
 */
function userMessage(text: string, parts: readonly ContentPartInput[]): ChatMessageInput {
  return parts.length === 0 ? { role: 'user', text } : { role: 'user', text, parts };
}

function toMessages(
  history: readonly ConversationEntry[],
  userText: string,
  parts: readonly ContentPartInput[],
): readonly ChatMessageInput[] {
  return [...historyMessages(history), userMessage(userText, parts)];
}

/**
 * What pressing send would put on the wire, as plain strings — for the context
 * meter, and for anything else that needs to weigh a turn before it happens.
 *
 * **Derived from the same traversal as {@link toMessages} on purpose.** A meter
 * with its own opinion of what gets sent is a meter that drifts from the sender
 * the first time either changes, and the user only finds out by losing a
 * message. Reasoning is excluded here because it is excluded there; an
 * unsettled turn is excluded here because it is excluded there.
 *
 * The draft is included only when it is non-blank, because a blank composer
 * sends nothing — `toMessages` would append an empty user message that `send`
 * refuses to start.
 */
export function pendingTurnTexts(
  history: readonly ConversationEntry[],
  draft: string,
): readonly string[] {
  const messages = historyMessages(history);
  if (draft.trim() !== '') messages.push({ role: 'user', text: draft });
  return messages.map((message) => message.text);
}

function refusalOf(error: unknown): { code: string; message: string } {
  if (error instanceof PlatformError) return { code: error.code, message: error.message };
  return { code: 'INTERNAL', message: 'The host refused the request.' };
}

/**
 * A staged file could not be read, so the turn did not happen.
 *
 * The thrower owns the sentence — it is the only party that knows which file
 * and why — and this feature does not second-guess it. Anything without a
 * message of its own still says that nothing was sent, because the one
 * outcome that is never acceptable here is the user believing their
 * attachment went along.
 */
function attachmentRefusal(error: unknown): { code: string; message: string } {
  const message =
    error instanceof Error && error.message !== ''
      ? error.message
      : 'An attached file could not be read, so nothing was sent.';
  return { code: 'ATTACHMENT_UNREADABLE', message };
}
