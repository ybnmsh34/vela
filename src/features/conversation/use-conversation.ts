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
import { NO_CAPABILITIES } from '@/platform/contract';
import type {
  ChatCapabilities,
  ChatMessageInput,
  ChatStreamEvent,
  ContentPartInput,
} from '@/platform/contract';
import {
  DEFAULT_RUN_LIMITS,
  mergeRunCapabilities,
  type ContextRef,
  type HarnessRuntime,
  type RunFailure,
  type RunHandle,
  type RunOutcome,
} from '@/platform/contract-harness';
import { DEFAULT_PROJECT_ID, type ProjectId } from '@/platform/contract-project';
import { PlatformError } from '@/platform/errors';
import { subagentToolDefinition } from '@/runtime/subagent-toolkit';

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

/**
 * The two ways an agent run never starts, worded here because this surface owns
 * every sentence a user reads.
 *
 * Both are build- or state-level facts rather than reports from an endpoint, so
 * neither carries a `PlatformError` code: `HARNESS_UNAVAILABLE` and `RUN_BUSY`
 * are this file's own vocabulary, in the shape `refuseTurn` already takes.
 */
const NO_HARNESS = {
  code: 'HARNESS_UNAVAILABLE',
  message: 'No agent runtime in this build can run against the chosen model.',
} as const;

const RUN_REJECTED = {
  code: 'RUN_BUSY',
  message: 'Another run is already going in this conversation.',
} as const;

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
  /**
   * What the chosen model has actually demonstrated. Used for one decision:
   * whether an agent run may be offered, and what it is allowed to do once it
   * is. The floor — every flag `false` — offers nothing, which is the correct
   * answer for an unprobed endpoint.
   */
  readonly capabilities?: ChatCapabilities;
  /**
   * The agent runtime, built once at the composition root and handed down.
   *
   * `null`/omitted means **there is no agent affordance at all**, which is the
   * state a surface mounted on its own in a test is in — the same rule
   * {@link UseConversationOptions.attachments} follows, for the same reason.
   */
  readonly runtime?: HarnessRuntime | null;
  /** Which project an agent run belongs to. See `RunRequest.projectId`. */
  readonly projectId?: ProjectId;
  /** Defaults to `requestAnimationFrame`. */
  readonly scheduleCommit?: (run: () => void) => void;
}

/**
 * The agent affordance, as the composer renders it.
 *
 * `available` is a capability answer and never a backend one: a runtime has to
 * be wired, the conversation has to be a record the run can write into, and the
 * model has to be able to request a tool — otherwise an agent run is the same
 * single turn a plain send already does, and offering it would be a control
 * that promises something it cannot deliver.
 */
export interface AgentMode {
  readonly available: boolean;
  readonly enabled: boolean;
  setEnabled: (next: boolean) => void;
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
  /** Whether the next turn runs through the agent runtime, and whether it may. */
  readonly agent: AgentMode;
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
  const runtime = options.runtime ?? null;
  const capabilities = options.capabilities ?? NO_CAPABILITIES;
  const projectId = options.projectId ?? DEFAULT_PROJECT_ID;

  const [entries, setEntries] = useState<readonly ConversationEntry[]>(() => supplied ?? []);
  const [streaming, setStreaming] = useState(false);
  const [unreadable, setUnreadable] = useState(false);
  const [agentEnabled, setAgentEnabled] = useState(false);

  // Read by `send`/`retry`, which need the current transcript without taking a
  // dependency on it — a side effect inside a state updater would run twice
  // under StrictMode and start the turn twice.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const active = useRef<{ id: string; handle: TurnHandle | null } | null>(null);
  const queue = useRef<ChatStreamEvent[]>([]);
  const scheduled = useRef(false);
  const mounted = useRef(true);

  /**
   * The run in flight, when this turn is an agent run rather than a single
   * `chat_send`. A separate ref from {@link active} because the two are cancelled
   * differently — a turn handle stops one turn, a `RunHandle` stops the loop —
   * and collapsing them would make `stop` guess which it was holding.
   */
  const activeRun = useRef<RunHandle | null>(null);
  /**
   * This mount's tail on that run, dropped when the mount goes.
   *
   * **Unsubscribing is not cancelling, and that asymmetry is the point.** A run
   * outlives the surface that started it — the directory is built above the
   * remount, in `src/app/App.tsx` — so switching conversations leaves it
   * running and writing its own transcript, which is the durability rule at
   * `RunHandle` doing exactly what it is for. What must not outlive the mount is
   * this listener.
   */
  const runSubscription = useRef<{ unsubscribe: () => void } | null>(null);
  /**
   * Which assistant entries a run produced. Read by `retry`, which has to clean
   * up rows this surface never wrote: a run writes its own transcript as it goes
   * (the durability rule at `RunHandle`) and does not report the ids it used.
   */
  const agentEntries = useRef(new Set<string>());

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
      runSubscription.current?.unsubscribe();
      runSubscription.current = null;
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
   * Close out a run's entry when the stream did not close it.
   *
   * A run ends at `runFinished` and a *turn* ends at `chat.done` or `chat.error`,
   * and the two are not the same event. A cancelled run stops waiting for the
   * turn it cancelled, so the last thing the reducer saw may well have been a
   * `textDelta` — leaving a turn drawn as still arriving under a surface that has
   * stopped streaming. A harness fault produces no chat event at all.
   *
   * So the outcome settles whatever the stream left open, and settles nothing
   * that the stream already closed: a provider failure arrives as `chat.error`
   * first, and the error it carries is the one worth rendering.
   */
  const settleRun = useCallback((runId: string, outcome: RunOutcome) => {
    setEntries((current) =>
      current.map((entry) => {
        if (entry.kind !== 'assistant' || entry.id !== runId) return entry;
        if (isSettled(entry.turn)) return entry;
        if (outcome.type === 'cancelled') {
          return { ...entry, turn: { ...entry.turn, phase: 'stopped', stopReason: 'cancelled' } };
        }
        if (outcome.type === 'failed') {
          return { ...entry, turn: { ...entry.turn, phase: 'failed', refusal: runRefusal(outcome.failure) } };
        }
        return { ...entry, turn: { ...entry.turn, phase: 'complete', stopReason: outcome.stopReason } };
      }),
    );
  }, []);

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
   * Whether an agent run is even a thing this surface could offer.
   *
   * Three conditions, and none of them is an identity. A runtime has to have
   * been handed down — no runtime, no affordance, exactly as with the attachment
   * tray. The conversation has to be a record, because a run writes its own rows
   * as it goes and there is nowhere to write them otherwise. And the model has to
   * be able to request a tool: `mergeRunCapabilities` ANDs the harness's
   * `toolExecution` with the model's `toolCalls`, so on a model that cannot ask
   * for one the loop ends after a single turn and an agent run *is* a plain send
   * — a control that would promise a fan-out it can never produce.
   */
  const agentAvailable = runtime !== null && conversationId !== null && capabilities.toolCalls;
  const agentOn = agentAvailable && agentEnabled;

  /**
   * The other way a turn happens: through the agent runtime rather than through
   * one `chat_send`.
   *
   * The same three entries go on screen and the same reducer draws them —
   * `RunEvent`'s `chat` arm carries `ChatStreamEvent` verbatim, which is the
   * whole reason a renderer that can already draw a turn needs no new code to
   * draw a run. What differs is underneath: the loop may take several turns, it
   * executes the tool calls the model asks for, and it writes the transcript as
   * it goes instead of at the end.
   *
   * That last difference is why the two paths cannot share their store writes.
   * A run opens its assistant row when the turn opens and closes it when the turn
   * ends, so this surface must not also write one — both ids are claimed here,
   * before anything is awaited, and the write-on-settle effect below skips a
   * claimed reply. The question is still this surface's to write, and it is
   * written *first*, so the record reads in the order it happened.
   */
  const startRun = useCallback(
    (
      history: readonly ConversationEntry[],
      userText: string,
      prepare: () => Promise<readonly ContentPartInput[]>,
    ) => {
      if (runtime === null || conversationId === null) return;
      if (providerId === null || modelId === null) return;

      const runId = newTurnId();
      const userId = `${runId}-user`;
      const userEntry: ConversationEntry = { kind: 'user', id: userId, text: userText };
      const assistantEntry: ConversationEntry = { kind: 'assistant', id: runId, turn: EMPTY_TURN };

      touched.current = true;
      setEntries([...history, userEntry, assistantEntry]);
      setStreaming(true);
      queue.current = [];
      scheduled.current = false;
      active.current = { id: runId, handle: null };
      activeRun.current = null;
      // Defensive rather than load-bearing: `send` and `retry` both refuse while
      // `streaming`, so nothing should be attached here. A tail left on a run
      // this surface has stopped drawing would keep drawing it.
      runSubscription.current?.unsubscribe();
      runSubscription.current = null;
      agentEntries.current.add(runId);
      // Claimed before the first await: the run owns the assistant row, and a
      // second copy written from here is a transcript with the answer in it
      // twice.
      claimed.current.add(userId);
      claimed.current.add(runId);

      let seen = 0;

      void (async () => {
        let parts: readonly ContentPartInput[];
        try {
          parts = await prepare();
        } catch (error: unknown) {
          if (!mounted.current) return;
          refuseTurn(runId, attachmentRefusal(error));
          return;
        }
        if (!mounted.current) return;

        if (parts.length > 0) {
          setEntries((current) =>
            current.map((entry) =>
              entry.kind === 'user' && entry.id === userId ? { ...entry, parts } : entry,
            ),
          );
        }

        enqueue(async () => {
          const written = await transcript.append({
            conversationId,
            role: 'user',
            parts: [{ kind: 'text', text: userText }, ...parts],
          });
          messageIds.current.set(userId, written.id);
        });

        // `requestedId` is `null` on every call: nothing in `contract.ts` can
        // store a harness choice, so every selection comes back `substituted`
        // with reason `noneChosen` — a success state, and not something to
        // render as a warning.
        const selection = runtime.select({ requestedId: null, model: capabilities });
        if (selection.outcome === 'unavailable') {
          refuseTurn(runId, NO_HARNESS);
          return;
        }
        const definition = selection.definition;

        // The caller indexes and picks; the harness loads. With no project
        // command in the allowlist this is empty today, and the wiring is here so
        // that it stops being empty without this file changing.
        let preload: readonly ContextRef[] = [];
        try {
          preload = await runtime.contextFor(projectId).index();
        } catch {
          preload = [];
        }
        if (!mounted.current) return;

        // **Nothing starts until every write this surface has queued has
        // landed**, and both halves of that matter.
        //
        // A run opens its assistant row the instant the first turn opens, and it
        // does so off this chain — the harness holds the writer directly. So
        // without the barrier the answer's row can be written before the
        // question's, and the record reads in an order the conversation never
        // happened in. And on a retry the deletions queued a moment ago would
        // race the rows the new run is about to write, which is the one
        // interleaving that can delete an answer the user is waiting for.
        //
        // `enqueue` attaches its own `catch`, so this never rejects: a store that
        // refuses a write is not a reason to refuse to answer.
        await writes.current;

        const started = runtime.runs.start({
          runId,
          conversationId,
          projectId,
          harnessId: definition.descriptor.id,
          models: { primary: { providerId, modelId } },
          input: toMessages(history, userText, parts),
          tools: [subagentToolDefinition],
          context: { systemPrompt: null, preload },
          limits: DEFAULT_RUN_LIMITS,
          capabilities: mergeRunCapabilities(definition.descriptor.capabilities, capabilities, false),
        });
        if (started.outcome === 'rejected') {
          refuseTurn(runId, RUN_REJECTED);
          return;
        }
        activeRun.current = started.handle;

        // From seq 0, because `runStarted` is emitted synchronously inside
        // `start` and is already in the buffer by the time this line runs.
        //
        // The replay is delivered *before* `subscribe` returns, so a run that
        // has already finished — a harness that failed immediately does — hands
        // its `runFinished` to this listener while the subscription it would
        // have to cancel does not yet exist. Hence the flag: the assignment
        // below happens only for a run that is still going, and the finished
        // case unsubscribes the value it actually has.
        let ended = false;
        const subscription = started.handle.subscribe(
          (envelope) => {
            if (!mounted.current) return;
            const event = envelope.event;

            if (event.type === 'chat') {
              queue.current.push(event.event);
              seen += 1;
              // The first token pays no scheduling tax, exactly as on the other
              // path; every frame after it is coalesced.
              if (seen === 1) {
                drain(runId);
                return;
              }
              if (scheduled.current) return;
              scheduled.current = true;
              schedule(() => {
                drain(runId);
              });
              return;
            }

            if (event.type !== 'runFinished') return;
            drain(runId);
            ended = true;
            activeRun.current = null;
            active.current = null;
            runSubscription.current?.unsubscribe();
            runSubscription.current = null;
            setStreaming(false);
            settleRun(runId, event.outcome);
          },
          { fromSeq: 0 },
        );
        if (ended) subscription.unsubscribe();
        else runSubscription.current = subscription;
      })();
    },
    [
      capabilities,
      conversationId,
      drain,
      enqueue,
      modelId,
      projectId,
      providerId,
      refuseTurn,
      runtime,
      schedule,
      settleRun,
      transcript,
    ],
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
      const begin = agentOn ? startRun : start;
      begin(entriesRef.current, trimmed, async () => {
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
    [agentOn, start, startRun, streaming],
  );

  const stop = useCallback(() => {
    // A run first: `RunController.cancel` stops the loop, and the turn it has
    // open with it. Cancelling only the turn would leave the loop free to open
    // the next one.
    const run = activeRun.current;
    if (run !== null) {
      void run.cancel();
      return;
    }
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
    //
    // A run's own rows are the case this cannot remember: the harness wrote
    // them and reported no ids, so for a dropped agent turn the tail is found in
    // the store — everything at or after the question — rather than looked up.
    // Without it a retried agent turn leaves its old answer behind, and the
    // transcript that comes back is not the one the user was looking at.
    const viaRun = dropped.some(
      (entry) => entry.kind === 'assistant' && agentEntries.current.has(entry.id),
    );
    if (conversationId !== null) {
      enqueue(async () => {
        if (viaRun) {
          // **The anchor is read here, on the chain, and not where `retry` was
          // called.** The question's own append is a link *ahead* of this one, so
          // read a moment too early it is `undefined` — and the id-keyed loop
          // below can never find a row a harness wrote, so the old answer
          // survived the retry and the transcript came back holding two, with
          // the answer filed before the question.
          //
          // The barrier in `startRun` is what actually closes that window: a run
          // cannot write a row before the question is in the store, so it cannot
          // finish before it either, so `retry` can never reach a state where a
          // run's rows exist and the anchor does not. **This read is therefore
          // not load-bearing on its own and does not go red when it is put
          // back** — it is here so the branch is total, rather than resting on
          // an argument made in another function that a later edit could quietly
          // invalidate.
          const anchor = messageIds.current.get(lastUser.id);
          for (const entry of dropped) {
            messageIds.current.delete(entry.id);
            claimed.current.delete(entry.id);
            agentEntries.current.delete(entry.id);
          }
          // No anchor means the question's append did not merely lag, it failed
          // — `enqueue` swallows, and the record already holds an answer with no
          // question in front of it. Store order is the only handle on where the
          // dropped tail begins, and a guessed boundary would take a turn the
          // user is keeping: an earlier agent turn's rows are indistinguishable
          // from this one's, because a run reports none of the ids it writes.
          // So nothing is deleted, and the retry appends beside the orphan.
          if (anchor === undefined) return;
          const stored = await transcript.list(conversationId);
          const from = stored.findIndex((message) => message.id === anchor);
          if (from !== -1) {
            for (const message of stored.slice(from)) await transcript.remove(message.id);
          }
          return;
        }
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
    const begin = agentOn ? startRun : start;
    begin(current.slice(0, current.indexOf(lastUser)), lastUser.text, () =>
      Promise.resolve(carried),
    );
  }, [agentOn, conversationId, enqueue, start, startRun, streaming, transcript]);

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

  const agent = useMemo<AgentMode>(
    () => ({ available: agentAvailable, enabled: agentOn, setEnabled: setAgentEnabled }),
    [agentAvailable, agentOn],
  );

  return { entries, streaming, blockedReason, send, stop, retry, agent };
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

/**
 * Why a run failed, in Vela's own words.
 *
 * `RunFailure` splits deliberately: a provider failure travels as the one
 * `ChatError` taxonomy and has already been drawn from the `chat.error` event
 * that carried it, so only the harness arm reaches here. `RunFailureCause` is a
 * closed set with no free-text field — the same decision `ChatError` documents —
 * so every sentence below is written here rather than passed through.
 */
function runRefusal(failure: RunFailure): { code: string; message: string } {
  if (failure.kind === 'provider') {
    return { code: failure.error.kind, message: 'The endpoint did not finish this run.' };
  }
  switch (failure.cause) {
    case 'toolExecutorFailed':
      return { code: failure.cause, message: 'A tool this run started could not be run.' };
    case 'contextResolverFailed':
      return { code: failure.cause, message: 'The material this run was asked to read could not be loaded.' };
    case 'harnessFault':
      return { code: failure.cause, message: 'The agent runtime failed while driving this run.' };
  }
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
