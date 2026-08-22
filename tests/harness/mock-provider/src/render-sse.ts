/**
 * Streaming rendering of a {@link ReplyPlan}.
 *
 * Two builders: a well-behaved one, and the hostile one. They are separate
 * functions rather than one function with flags, because the hostile stream is
 * not "the good stream plus noise" — its frame *order* is wrong too, and
 * pretending otherwise would understate the damage a real broken runtime does.
 */

import type { CapabilityProfile } from './profiles.ts';
import type { ReplyPlan } from './reply-plan.ts';
import { encodeSseComment, encodeSseData, encodeSseRaw, SSE_DONE_FRAME } from './sse.ts';

function chunkFrame(
  plan: ReplyPlan,
  delta: Record<string, unknown>,
  finishReason: string | null,
): string {
  return encodeSseData({
    id: plan.id,
    object: 'chat.completion.chunk',
    created: plan.created,
    model: plan.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

function usageFrame(plan: ReplyPlan): string {
  return encodeSseData({
    id: plan.id,
    object: 'chat.completion.chunk',
    created: plan.created,
    model: plan.model,
    choices: [],
    usage: {
      prompt_tokens: plan.promptTokens,
      completion_tokens: plan.completionTokens,
      total_tokens: plan.promptTokens + plan.completionTokens,
    },
  });
}

const ARGUMENT_FRAGMENT_SIZE = 4;

function argumentFragments(text: string): readonly string[] {
  if (text.length === 0) {
    return [];
  }
  const out: string[] = [];
  for (let i = 0; i < text.length; i += ARGUMENT_FRAGMENT_SIZE) {
    out.push(text.slice(i, i + ARGUMENT_FRAGMENT_SIZE));
  }
  return out;
}

function wellBehavedStream(
  profile: CapabilityProfile,
  plan: ReplyPlan,
  includeUsage: boolean,
): readonly string[] {
  const frames: string[] = [chunkFrame(plan, { role: 'assistant' }, null)];

  for (const fragment of plan.reasoningFragments) {
    frames.push(chunkFrame(plan, { reasoning_content: fragment }, null));
  }

  for (const call of plan.toolCalls) {
    frames.push(
      chunkFrame(
        plan,
        {
          tool_calls: [
            {
              index: call.index,
              id: call.id,
              type: call.typeField,
              function: { name: call.name, arguments: '' },
            },
          ],
        },
        null,
      ),
    );
    for (const piece of argumentFragments(call.argumentsText)) {
      frames.push(
        chunkFrame(plan, { tool_calls: [{ index: call.index, function: { arguments: piece } }] }, null),
      );
    }
  }

  for (const fragment of plan.contentFragments) {
    frames.push(chunkFrame(plan, { content: fragment }, null));
  }

  frames.push(chunkFrame(plan, {}, plan.finishReason));

  if (includeUsage && profile.streamUsage) {
    frames.push(usageFrame(plan));
  }
  if (profile.emitDoneSentinel) {
    frames.push(SSE_DONE_FRAME);
  }
  return frames;
}

/**
 * Hostile rendering of a parallel batch: the calls are opened up front and
 * their argument fragments then arrive **round-robin**, so frames belonging to
 * three different `index`es interleave.
 *
 * That is the discriminating case. With one call's fragments emitted
 * contiguously, an accumulator that simply appends to "the call I touched last"
 * is indistinguishable from one that keys by `index`. Interleaved, it produces
 * an argument string that never existed on the wire.
 *
 * Returned in two halves so the caller can keep the profile's unparseable
 * frames where they already are — in the middle of the tool-call run.
 */
function interleavedToolFrames(plan: ReplyPlan): { before: string[]; after: string[] } {
  const opens = plan.toolCalls.map((call) =>
    chunkFrame(
      plan,
      {
        tool_calls: [
          {
            index: call.index,
            ...(call.omitId ? {} : { id: call.id }),
            type: call.typeField,
            function: { name: call.name, arguments: '' },
          },
        ],
      },
      null,
    ),
  );

  const perCall = plan.toolCalls.map((call) => argumentFragments(call.argumentsText));
  const rounds = perCall.reduce((most, fragments) => Math.max(most, fragments.length), 0);
  const interleaved: string[][] = [];
  for (let round = 0; round < rounds; round += 1) {
    const frames: string[] = [];
    plan.toolCalls.forEach((call, position) => {
      const piece = perCall[position]?.[round];
      if (piece !== undefined) {
        frames.push(
          chunkFrame(plan, { tool_calls: [{ index: call.index, function: { arguments: piece } }] }, null),
        );
      }
    });
    interleaved.push(frames);
  }

  return {
    before: [...opens, ...(interleaved[0] ?? [])],
    after: interleaved.slice(1).flat(),
  };
}

function hostileStream(profile: CapabilityProfile, plan: ReplyPlan): readonly string[] {
  const frames: string[] = [chunkFrame(plan, { role: 'assistant' }, null)];
  const content = plan.contentFragments;

  const emitContent = (from: number, to: number): void => {
    for (const fragment of content.slice(from, to)) {
      frames.push(chunkFrame(plan, { content: fragment }, null));
    }
  };

  emitContent(0, 2);

  // A frame whose JSON is cut off mid-string. Any consumer that assumes every
  // `data:` payload parses will throw here.
  frames.push(
    encodeSseRaw(`{"id":"${plan.id}","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"`),
  );
  frames.push(encodeSseComment('keepalive'));

  emitContent(2, 5);

  const parallel = plan.parallelToolCalls ? interleavedToolFrames(plan) : null;
  if (parallel !== null) {
    frames.push(...parallel.before);
  }

  // The one-call-at-a-time hostilities below are the single-tool shape; a
  // parallel batch is rendered by `interleavedToolFrames` instead.
  const [first, second] = plan.parallelToolCalls ? [] : plan.toolCalls;
  if (first !== undefined) {
    // The function name arrives with no `index`, no `id` and no `type` — the
    // accumulator has nothing to key on yet.
    frames.push(chunkFrame(plan, { tool_calls: [{ function: { name: first.name } }] }, null));
    // …and the id turns up two frames later, on a different shape.
    frames.push(
      chunkFrame(plan, { tool_calls: [{ index: first.index, id: first.id, type: first.typeField }] }, null),
    );
    for (const piece of argumentFragments(first.argumentsText)) {
      frames.push(
        chunkFrame(plan, { tool_calls: [{ index: first.index, function: { arguments: piece } }] }, null),
      );
    }
    // An empty function object: no name, no arguments, nothing to merge.
    frames.push(chunkFrame(plan, { tool_calls: [{ index: first.index, function: {} }] }, null));
  }

  // Valid JSON, wrong shape: `choices` is a string.
  frames.push(
    encodeSseData({ id: plan.id, object: 'chat.completion.chunk', created: plan.created, choices: 'not-an-array' }),
  );
  // Not JSON at all.
  frames.push(encodeSseRaw('not-json-at-all'));

  if (second !== undefined) {
    // Index jumps from 0 to 7, no id, misspelled discriminator, arguments that
    // are not JSON and never will be.
    frames.push(
      chunkFrame(
        plan,
        {
          tool_calls: [
            {
              index: second.index,
              type: second.typeField,
              function: { name: second.name, arguments: second.argumentsText },
            },
          ],
        },
        null,
      ),
    );
  }

  if (parallel !== null) {
    frames.push(...parallel.after);
  }

  emitContent(5, content.length);
  frames.push(chunkFrame(plan, {}, plan.finishReason));

  if (profile.streamUsage) {
    frames.push(usageFrame(plan));
  }
  // Deliberately no `[DONE]` unless the profile was overridden: the stream just
  // stops. A consumer that waits for the sentinel before finalising will hang,
  // and that is exactly the bug this profile exists to find.
  if (profile.emitDoneSentinel) {
    frames.push(SSE_DONE_FRAME);
  }
  return frames;
}

export function renderSseStream(
  profile: CapabilityProfile,
  plan: ReplyPlan,
  includeUsage: boolean,
): readonly string[] {
  return profile.emitMalformedSseFrames
    ? hostileStream(profile, plan)
    : wellBehavedStream(profile, plan, includeUsage);
}
