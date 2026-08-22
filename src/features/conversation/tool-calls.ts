/**
 * What a tool call *is*, as far as the transcript is concerned.
 *
 * A pure derivation: host outcomes, in-flight fragments, results and the ids of
 * anything currently executing go in; a list of drawable calls comes out. No
 * React, no DOM, so every state below — including the ones that are hard to
 * provoke live — is asserted directly.
 *
 * ## The three things this file exists to get right
 *
 * 1. **A malformed call renders as something.** The core deliberately refuses to
 *    execute a reconstruction it is not sure of and hands the evidence over
 *    instead (`ToolCallOutcome::Malformed`, measured against the hostile
 *    profile: truncated JSON, a misspelled discriminator, fragments arriving
 *    with no id and an index that jumps 0 → 7). Turning that into a rendered
 *    card is the entire point of the host keeping it. A dropped one is a
 *    failure, not a tidy-up.
 * 2. **Emulation is disclosed, not disguised.** On an endpoint with no native
 *    tool calling the core describes the tools in the prompt and reads the call
 *    back out of the reply — and marks the outcome `emulated`. That flag is a
 *    *capability* fact (the probe said no native tools), which is why the UI
 *    can be honest about it without ever learning which backend it is talking
 *    to.
 * 3. **Parallel calls stay distinct.** A batch is N calls with N correlation
 *    ids, and the one shape the wire makes easy to get wrong is collapsing them
 *    into one. Each outcome becomes exactly one view, in arrival order, keyed
 *    by position and never by name.
 *
 * ## Why there is no `settled` flag
 *
 * The data already says. In-flight fragments exist only before the turn ends;
 * outcomes exist only after it. So `outcomes.length > 0` *is* "this turn has
 * finished deciding what it called", and a separate boolean could only ever
 * disagree with it.
 */

import type {
  ContentPart,
  MalformedToolCallReason,
  ToolCallOutcome,
} from '@/platform/contract';

import { describeMalformedReason } from './notices';
import type { ToolCallProgress } from './turn-stream';

/**
 * How far along one call is.
 *
 * `awaitingResult` is not a spinner: it means the model asked for the call and
 * nothing has come back yet. Vela does not run tools yet, so on today's builds
 * every well-formed call settles here — and saying "running" would be a claim
 * about something that is not happening.
 */
export type ToolCallStatus =
  | 'arriving'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'awaitingResult'
  | 'unreadable'
  | 'notCommitted';

/** A result that has come back for a call, matched by its correlation id. */
export interface ToolResultView {
  readonly callId: string;
  readonly content: string;
  readonly isError: boolean;
}

/**
 * The arguments, in the form they can honestly be shown.
 *
 * `json` was parsed by the host and is re-printed by Vela. `raw` is bytes
 * exactly as they arrived and is **never** re-serialised — a malformed call
 * shown prettified would be Vela's guess wearing the model's clothes.
 */
export type ArgumentsView =
  | { readonly kind: 'none' }
  | { readonly kind: 'json'; readonly text: string }
  | { readonly kind: 'raw'; readonly text: string };

export interface ToolCallView {
  /** Stable within one turn. Position-based: names and ids both repeat. */
  readonly key: string;
  readonly status: ToolCallStatus;
  /** `null` when no name ever arrived — a real hostile-profile shape. */
  readonly name: string | null;
  /** Always drawable, even when {@link name} is `null`. */
  readonly title: string;
  /** The correlation id. Shown because it is what keeps a batch un-mixable. */
  readonly callId: string | null;
  /** Recovered from the reply's text because the model has no native tools. */
  readonly emulated: boolean;
  readonly args: ArgumentsView;
  /** One line of arguments for the collapsed header, or `null` if there is none. */
  readonly preview: string | null;
  readonly result: ToolResultView | null;
  /** Why this call was not run, as a sentence. `null` for a well-formed call. */
  readonly problem: string | null;
  readonly reason: MalformedToolCallReason | null;
}

export interface ToolCallInputs {
  readonly outcomes: readonly ToolCallOutcome[];
  readonly progress: readonly ToolCallProgress[];
  /** Results seen so far, from the transcript's own `toolResult` parts. */
  readonly results?: readonly ToolResultView[];
  /**
   * Correlation ids currently executing. Empty on every build that has no tool
   * runtime — which is why `running` can never be claimed by accident.
   */
  readonly running?: readonly string[];
}

/** How long a single-line argument preview may get before it is cut. */
const PREVIEW_BUDGET = 96;

export function buildToolCallViews(inputs: ToolCallInputs): readonly ToolCallView[] {
  const results = inputs.results ?? [];
  const running = inputs.running ?? [];

  const settled = inputs.outcomes.map((outcome, index) =>
    outcome.status === 'ok'
      ? okView(outcome, index, results, running)
      : malformedView(outcome, index),
  );

  // Once outcomes exist they are the truth: the same calls, finished. Drawing
  // the half-assembled fragments beside them would double every call in the
  // batch, which is exactly the "N calls became 2N" shape the wire invites.
  if (settled.length > 0) return settled;

  return [...inputs.progress]
    .sort((a, b) => a.slot - b.slot)
    .map((call) => ({
      key: `slot-${String(call.slot)}`,
      status: 'arriving' as const,
      name: call.name,
      title: call.name ?? 'Tool call',
      callId: call.callId,
      emulated: false,
      args: call.argumentsText === '' ? { kind: 'none' as const } : { kind: 'raw' as const, text: call.argumentsText },
      // Deliberately no preview: a fragment is a prefix of JSON, and a prefix
      // read as a summary is a summary that is wrong for as long as it shows.
      preview: null,
      result: null,
      problem: null,
      reason: null,
    }));
}

function okView(
  outcome: Extract<ToolCallOutcome, { status: 'ok' }>,
  index: number,
  results: readonly ToolResultView[],
  running: readonly string[],
): ToolCallView {
  const result = results.find((candidate) => candidate.callId === outcome.callId) ?? null;
  const status: ToolCallStatus =
    result !== null
      ? result.isError
        ? 'failed'
        : 'succeeded'
      : running.includes(outcome.callId)
        ? 'running'
        : 'awaitingResult';

  const text = formatArguments(outcome.arguments);
  return {
    key: `call-${String(index)}`,
    status,
    name: outcome.name,
    title: outcome.name,
    callId: outcome.callId,
    emulated: outcome.emulated,
    args: text === '' ? { kind: 'none' } : { kind: 'json', text },
    preview: previewArguments(outcome.arguments),
    result,
    problem: null,
    reason: null,
  };
}

function malformedView(
  outcome: Extract<ToolCallOutcome, { status: 'malformed' }>,
  index: number,
): ToolCallView {
  // One reason on this union is not a defect at all: the call parsed, and the
  // core refused it because it was rescued from a thinking block the model
  // never closed. Saying "could not be read" about a call Vela read perfectly
  // well would be a lie in the user's favour, which is still a lie.
  const committed = outcome.reason !== 'recoveredFromUnterminatedReasoning';
  return {
    key: `call-${String(index)}`,
    status: committed ? 'unreadable' : 'notCommitted',
    name: outcome.name,
    title: outcome.name ?? 'Unnamed tool call',
    callId: outcome.callId,
    emulated: false,
    args:
      outcome.rawArguments === ''
        ? { kind: 'none' }
        : { kind: 'raw', text: outcome.rawArguments },
    preview: null,
    result: null,
    problem: committed
      ? `Vela could not read this call: ${describeMalformedReason(outcome.reason)}. It was not run.`
      : `Vela did not run this call: ${describeMalformedReason(outcome.reason)}.`,
    reason: outcome.reason,
  };
}

/** The short word in the card's header. Plain, and never an exclamation. */
export function statusLabel(status: ToolCallStatus): string {
  switch (status) {
    case 'arriving':
      return 'Arriving';
    case 'running':
      return 'Running';
    case 'succeeded':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'awaitingResult':
      return 'No result yet';
    case 'unreadable':
      return 'Could not be read';
    case 'notCommitted':
      return 'Not sent';
  }
}

/**
 * Whether a call is still moving. Drives the live dot, and the default open
 * state — a call you are watching should not need a click.
 */
export function isLive(status: ToolCallStatus): boolean {
  return status === 'arriving' || status === 'running';
}

/** Group heading. Says how many calls there are, because a batch is the point. */
export function summariseToolCalls(views: readonly ToolCallView[]): string {
  const unreadable = views.filter((view) => view.status === 'unreadable').length;
  const head = views.length === 1 ? '1 tool call' : `${String(views.length)} tool calls`;
  if (unreadable === 0) return head;
  return `${head} · ${String(unreadable)} could not be read`;
}

/**
 * The one sentence that says the model is not doing this natively.
 *
 * Derived from the outcome's own `emulated` flag — which the core sets because
 * the capability probe found no native tool calling. No provider is named
 * because none is knowable here.
 */
export function emulationSentence(views: readonly ToolCallView[]): string | null {
  if (!views.some((view) => view.emulated)) return null;
  return 'This model has no built-in tool calling. Vela described the tools in the prompt and read the call back out of the reply.';
}

/**
 * Arguments as an indented JSON block.
 *
 * Returns `''` — not `'undefined'` — for anything `JSON.stringify` declines to
 * represent, so a caller renders nothing rather than the word.
 */
export function formatArguments(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    // A cycle cannot arrive over IPC, but a caller is free to hand us one.
    return '';
  }
}

/**
 * A single line of arguments for the collapsed header.
 *
 * `city: "alpha"` beats `{…}`: most calls are two short scalars and a user who
 * can read them in place never has to open the card at all.
 */
export function previewArguments(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    const scalar = formatArguments(value);
    return scalar === '' ? null : clip(scalar.replace(/\s+/g, ' '));
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return null;
  const rendered = entries
    .map(([key, entry]) => `${key}: ${clip(formatArguments(entry).replace(/\s+/g, ' '), 32)}`)
    .join(', ');
  return clip(rendered);
}

function clip(text: string, budget = PREVIEW_BUDGET): string {
  return text.length <= budget ? text : `${text.slice(0, budget - 1)}…`;
}

/**
 * Tool results out of stored content parts.
 *
 * The store keeps a result as its own part, addressed by the id of the call it
 * answers, so a restored transcript can show the same succeeded/failed states a
 * live one did.
 */
export function collectToolResults(parts: readonly ContentPart[]): readonly ToolResultView[] {
  const results: ToolResultView[] = [];
  for (const part of parts) {
    if (part.kind === 'toolResult') {
      results.push({ callId: part.callId, content: part.content, isError: part.isError });
    }
  }
  return results;
}
