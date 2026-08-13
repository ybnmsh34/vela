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
 * * **Tool calls.** The parts are stored faithfully, but `emulated` is not one
 *   of them, and it is the flag that decides whether the UI tells the user
 *   "this model has no native tool calling, so Vela recovered these from its
 *   text". Restoring the calls with `emulated: false` would make every restored
 *   emulated call claim it was native. So restored turns carry no outcomes.
 *
 * Both are stated here rather than left for a reader to discover, and both are
 * live limitations rather than settled design: the fix for either is a wider
 * stored shape, not a cleverer reconstruction.
 */

import type {
  ContentPartInput,
  StopReason,
  StoredMessage,
  StoredMessageStatus,
  StoredStopReason,
  TokenUsage,
} from '@/platform/contract';

import { GUARD_START } from './reasoning-guard';
import { EMPTY_TURN, hasReportedUsage, type TurnPhase, type TurnState } from './turn-stream';
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
      entries.push({ kind: 'user', id: message.id, text: textOf(message.parts) });
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

function reasoningOf(parts: readonly ContentPartInput[]): string {
  return parts
    .filter((part): part is { kind: 'reasoning'; text: string } => part.kind === 'reasoning')
    .map((part) => part.text)
    .join('');
}

function turnFromStored(message: StoredMessage): TurnState {
  const reasoning = reasoningOf(message.parts);
  return {
    ...EMPTY_TURN,
    phase: phaseOf(message.status),
    answer: textOf(message.parts),
    reasoning,
    reasoningPhase: reasoning === '' ? 'none' : 'complete',
    usage: usageOf(message.usage),
    stopReason: stopReasonOf(message.stopReason),
    guard: GUARD_START,
  };
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
