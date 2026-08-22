/**
 * Non-streaming rendering of a {@link ReplyPlan}.
 */

import type { CapabilityProfile } from './profiles.ts';
import type { PlannedToolCall, ReplyPlan } from './reply-plan.ts';
import type { ChatCompletionResponse } from './wire-types.ts';

/**
 * Serialised tool call. Not `ToolCall` from the wire types: the hostile profile
 * omits `id` and misspells `type`, which the honest type forbids — that is the
 * whole point of the profile, so the harness models it as a loose record.
 */
export function renderToolCall(call: PlannedToolCall): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: call.typeField,
    function: { name: call.name, arguments: call.argumentsText },
  };
  if (!call.omitId) {
    out['id'] = call.id;
  }
  return out;
}

export function renderChatCompletion(
  profile: CapabilityProfile,
  plan: ReplyPlan,
): ChatCompletionResponse {
  const message: Record<string, unknown> = {
    role: 'assistant',
    // OpenAI sends `content: null` on a pure tool-calling turn. The harness
    // reproduces that rather than an empty string, because a caller that does
    // `content.length` on it is a bug worth catching.
    content: plan.content === '' ? null : plan.content,
  };
  if (plan.reasoningText !== '') {
    message['reasoning_content'] = plan.reasoningText;
  }
  if (plan.toolCalls.length > 0) {
    message['tool_calls'] = plan.toolCalls.map(renderToolCall);
  }

  return {
    id: plan.id,
    object: 'chat.completion',
    created: plan.created,
    model: profile.modelId,
    choices: [
      {
        index: 0,
        // One cast, here, on purpose: the hostile profile emits a message shape
        // the honest wire type forbids (no `id`, misspelled `type`). Keeping the
        // type honest and casting once is better than loosening the type for
        // everyone.
        message: message as unknown as ChatCompletionResponse['choices'][number]['message'],
        finish_reason: plan.finishReason,
      },
    ],
    usage: {
      prompt_tokens: plan.promptTokens,
      completion_tokens: plan.completionTokens,
      total_tokens: plan.promptTokens + plan.completionTokens,
    },
  };
}
