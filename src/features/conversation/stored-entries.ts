/**
 * The translation between what the store keeps and what the transcript renders.
 *
 * Pure functions over plain data — no React, no adapter, no clock — so the
 * round trip can be asserted without mounting anything.
 *
 * ## What survives, and what honestly does not
 *
 * A stored message carries parts, a status, a stop reason, usage and an error
 * *string*. A live {@link TurnState} carries all of that plus a typed
 * {@link ChatError} with a {@link Diagnosis} behind it, and a `ToolCallOutcome`
 * list whose `emulated` flag records *how* a call was recovered.
 *
 * Two of those cannot be rebuilt from a stored message, and this module refuses
 * to invent them rather than reconstructing something that looks equivalent:
 *
 * * **The typed error.** `errorMessage` is a sentence; `ChatError` is a closed
 *   union carrying a diagnosis. Widening a sentence back into a variant would
 *   put a specific claim about *why* a turn failed in front of the user on the
 *   strength of a string match. A restored turn keeps its `failed` phase — the
 *   record that it failed is not lost — and carries no error box.
 *
 *   The *sentence itself* is a different question from the variant, and it is
 *   restored: `errorMessage` lands on {@link TurnState.recordedFailure} and is
 *   quoted verbatim under the turn. Refusing to rebuild the union is not a
 *   reason to drop the column, and dropping it is what made a reopened
 *   conversation say "what went wrong was not kept" about a row that kept it.
 * * **Tool calls.** The parts are stored faithfully, but `emulated` is not one
 *   of them, and it is the flag that decides whether the UI tells the user
 *   "this model has no native tool calling, so Vela recovered these from its
 *   text". Restoring the calls with `emulated: false` would make every restored
 *   emulated call claim it was native. So restored turns carry no outcomes.
 *
 * Both are stated here rather than left for a reader to discover, and both are
 * live limitations rather than settled design: the fix for either is a wider
 * stored shape, not a cleverer reconstruction.
 *
 * The converse case is {@link answeredByOf}: the endpoint that answered *is* in
 * the store, so it is restored. "Refuses to invent" is not "declines to read" —
 * dropping a fact the row actually holds turned a recorded substitution into
 * silence on reload, which is its own way of misreporting the turn.
 */

import type {
  AnswerProvenance,
  ContentPart,
  ContentPartInput,
  StopReason,
  StoredMessage,
  StoredMessageStatus,
  StoredStopReason,
  TokenUsage,
} from '@/platform/contract';

import { hasReportedUsage, turnFromParts, type TurnPhase, type TurnState } from './turn-stream';
import type { ConversationEntry } from './use-conversation';

/**
 * The transcript as the surface renders it.
 *
 * `system` and `tool` messages are skipped: the transcript draws the
 * conversation between the user and the model, and a tool result is already
 * shown as part of the turn that called for it.
 */
export function entriesFromStored(
  messages: readonly StoredMessage[],
): readonly ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      // Text collapses into the message's own text — an inlined file was
      // stored as a text part and reads as one. Everything else (an image)
      // is carried through, because the next turn replays this message and a
      // conversation that forgets the picture halfway through is a
      // conversation the model stops being able to answer questions about.
      const carried = message.parts.filter((part) => part.kind !== 'text');
      entries.push({
        kind: 'user',
        id: message.id,
        text: textOf(message.parts),
        ...(carried.length === 0 ? {} : { parts: carried }),
      });
    } else if (message.role === 'assistant') {
      entries.push({ kind: 'assistant', id: message.id, turn: turnFromStored(message) });
    }
  }
  return entries;
}

/**
 * What to write for a settled turn.
 *
 * Reasoning is written as its own part and never folded into the answer — the
 * store models it separately for exactly this reason, and the projection that
 * rebuilds a prompt leaves it out by asking for it to be left out. Merging the
 * two here would make that projection impossible for every later reader.
 */
export function partsOfTurn(turn: TurnState): readonly ContentPartInput[] {
  const parts: ContentPartInput[] = [];
  if (turn.reasoning !== '') parts.push({ kind: 'reasoning', text: turn.reasoning });
  if (turn.answer !== '') parts.push({ kind: 'text', text: turn.answer });
  return parts;
}

/** The store's word for the phase this turn settled in. */
export function statusOfTurn(turn: TurnState): StoredMessageStatus {
  if (turn.phase === 'failed') return 'failed';
  if (turn.phase === 'stopped') return 'cancelled';
  return 'complete';
}

/**
 * The sentence to keep for a failed turn, or `null`.
 *
 * Deliberately the turn's own already-rendered reason rather than a new
 * formatting of the error: the string in the store should be the string the
 * user saw.
 */
export function errorMessageOfTurn(turn: TurnState): string | null {
  if (turn.refusal !== null) return turn.refusal.message;
  if (turn.error === null) return null;
  return turn.error.kind;
}

function textOf(parts: readonly ContentPartInput[]): string {
  return parts
    .filter((part): part is { kind: 'text'; text: string } => part.kind === 'text')
    .map((part) => part.text)
    .join('');
}

/**
 * Widen the store's input-shaped parts to the full {@link ContentPart} shape
 * {@link turnFromParts} takes, keeping only the two kinds it reads.
 *
 * The two types differ in their optional fields — `reasoning` may omit
 * `signature` and `redacted` on the way in — so this fills those with the
 * defaults the store itself applies, and drops the kinds a settled turn's text
 * channels have nothing to say about.
 */
function textual(parts: readonly ContentPartInput[]): readonly ContentPart[] {
  return parts.flatMap((part): ContentPart[] => {
    if (part.kind === 'text') return [{ kind: 'text', text: part.text }];
    if (part.kind === 'reasoning') {
      return [
        {
          kind: 'reasoning',
          text: part.text,
          signature: part.signature ?? null,
          redacted: part.redacted ?? false,
        },
      ];
    }
    return [];
  });
}

/**
 * Delegates the answer/reasoning split to {@link turnFromParts} rather than
 * repeating it. That helper exists for exactly this — "resume-safe rendering",
 * in its own words — and two implementations of one split is how a restored
 * transcript starts rendering differently from a live one.
 */
function turnFromStored(message: StoredMessage): TurnState {
  return turnFromParts(textual(message.parts), {
    phase: phaseOf(message.status),
    usage: usageOf(message.usage),
    stopReason: stopReasonOf(message.stopReason),
    answeredBy: answeredByOf(message),
    recordedFailure: message.errorMessage,
  });
}

/**
 * Who answered, as the row records it — **the one thing on this list that is
 * rebuilt rather than refused.**
 *
 * The module header explains why the typed error and the tool outcomes are not
 * restored: neither is in the store, so reconstructing them would put an
 * invented claim in front of the user. This is the opposite case and that is the
 * whole reason it belongs here. The answering endpoint *is* in the store, in its
 * own column, written by the turn that happened. Leaving it out was not caution
 * — it silently downgraded a recorded fact to "unattributed", so reopening a
 * conversation made the substitution disclosure vanish while the truth sat
 * correctly in SQLite.
 *
 * Both halves or neither. {@link AnswerProvenance} has no shape for "an endpoint
 * whose model is unknown", and filling in the missing half from
 * `message.modelId` — the model the user *selected* — would be exactly the
 * confusion between addressed and answering that this column exists to end. A
 * half-written row is treated as no record, which is what it is.
 *
 * `null` stays `null`, and nothing here reads the selection columns. Every row
 * written before migration 6 lands on that path, and it must render as silence
 * rather than as the endpoint the turn was addressed to.
 *
 * The locals are named for the columns they hold rather than for the fields they
 * become. A `StoredMessage` carries **two** provider ids — the one addressed and
 * the one that answered — so a local called `providerId` in this function names
 * whichever of them the reader assumes, which is the precise ambiguity the
 * second column was added to end. (It also keeps `no-provider-leak.test.ts`
 * quiet, which is a consequence and not the reason: that scan flags any
 * comparison on a bare `providerId` outside `use-conversation.ts`, and it cannot
 * tell a presence check from a branch on backend identity. Moving this function
 * into that carrier — the fix used for `attributionOf` — is not available here,
 * because `use-conversation.ts` already imports `entriesFromStored` from this
 * module and the pair would become a runtime import cycle.)
 */
function answeredByOf(message: StoredMessage): AnswerProvenance | null {
  const answeredByProviderId = message.answeredByProviderId;
  const answeredByModelId = message.answeredByModelId;
  if (answeredByProviderId === null || answeredByModelId === null) return null;
  return { providerId: answeredByProviderId, modelId: answeredByModelId };
}

/**
 * A message still marked `streaming` is a turn the application never got to
 * finish — the window closed, or the user left mid-answer. It is restored as
 * `stopped` rather than `streaming`: the phase must be one the UI can draw a
 * settled turn in, or the transcript comes back with a spinner that will never
 * resolve.
 */
function phaseOf(status: StoredMessageStatus): TurnPhase {
  if (status === 'failed') return 'failed';
  if (status === 'complete') return 'complete';
  return 'stopped';
}

function stopReasonOf(stored: StoredStopReason | null): StopReason | null {
  return stored;
}

/** All-`null` usage means the endpoint reported none, which is `null` here. */
function usageOf(usage: TokenUsage): TokenUsage | null {
  return hasReportedUsage(usage) ? usage : null;
}
