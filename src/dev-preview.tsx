/** Scratch preview entry — deleted before commit. */
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { ConversationView } from '@/features/conversation/ConversationView';
import { useConversation } from '@/features/conversation/use-conversation';
import { PlatformProvider } from '@/platform/PlatformProvider';
import { BrowserAdapter } from '@/platform/browser-adapter';
import type { ChatEventEnvelope, ChatStreamEvent } from '@/platform/contract';
import { NO_CAPABILITIES } from '@/platform/contract';
import type { PlatformAdapter, Unsubscribe } from '@/platform/adapter';

import '@/styles/tokens.css';
import '@/styles/base.css';

const ANSWER = `Yes — and the interesting part is *why*.

A streamed answer arrives as a sequence of frames, and no frame is guaranteed to
contain a whole anything. Here is the guard, in full:

\`\`\`ts
export function guardDelta(state: GuardState, chunk: string): GuardOutput {
  let buffer = state.pending + chunk; // held-back bytes from last time
  let inside = state.inside;
  for (;;) {
    const hit = firstTag(buffer);
    if (hit === null) break;   // nothing complete yet — wait for more
    inside = hit.isOpen;       // depth clamps at one, deliberately
  }
  return { state: { inside, pending: held }, answer, reasoning };
}
\`\`\`

Three things fall out of that:

1. A tag split across frames is still one tag.
2. An unterminated block is **reported**, never swallowed.
3. \`<think>\` cannot reach the answer, however the stream is chopped.

| Frame | Bytes | Goes to |
| :--- | :--- | ---: |
| 1 | \`The answer <thi\` | answer |
| 2 | \`nk>weighing it\` | reasoning |
| 3 | \`</think> is 42.\` | answer |

> The endpoint chooses which arm is taken. It never chooses what the arm says.
`;

const FRAMES: ChatStreamEvent[] = [
  { type: 'reasoningDelta', text: 'The user is asking about frame boundaries. I should show the guard itself, then the three properties it buys, and keep the table short.' },
  ...ANSWER.match(/\S+\s*/g)!.map((text): ChatStreamEvent => ({ type: 'textDelta', text })),
  {
    type: 'done',
    response: {
      parts: [{ kind: 'text', text: ANSWER }],
      toolCalls: [
        {
          status: 'malformed',
          index: 7,
          callId: null,
          name: 'search_notes',
          rawArguments: '{"query": unquoted, "limit": }',
          reason: 'unparseableArguments',
        },
      ],
      stopReason: 'endTurn',
      usage: { inputTokens: 812, outputTokens: 341, reasoningTokens: 96, cachedInputTokens: null },
      structured: null,
      degradations: [
        { kind: 'malformedToolCalls', count: 1 },
        { kind: 'toolCallingEmulated', toolCount: 3 },
      ],
    },
  },
];

class ScriptedHost implements PlatformAdapter {
  readonly kind = 'browser' as const;
  #handlers = new Set<(p: ChatEventEnvelope) => void>();
  #turn = '';
  async invoke(command: string, payload: unknown): Promise<never> {
    if (command === 'chat_send') {
      const request = payload as { turnId: string };
      this.#turn = request.turnId;
      let index = 0;
      const step = () => {
        if (index >= FRAMES.length) return;
        const event = FRAMES[index]!;
        index += 1;
        for (const handler of this.#handlers) handler({ turnId: this.#turn, event });
        setTimeout(step, 8);
      };
      setTimeout(step, 60);
      return { turnId: request.turnId, accepted: true } as never;
    }
    return { cancelled: true } as never;
  }
  async listen(_e: string, handler: (p: never) => void): Promise<Unsubscribe> {
    const typed = handler as unknown as (p: ChatEventEnvelope) => void;
    this.#handlers.add(typed);
    return () => this.#handlers.delete(typed);
  }
}

const host = new ScriptedHost();

function Preview() {
  const conversation = useConversation({ providerId: 'p', modelId: 'm' });
  useEffect(() => {
    conversation.send('Can the reasoning guard really handle a tag split across two frames?');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <ConversationView
      conversation={conversation}
      capabilities={{ ...NO_CAPABILITIES, streaming: true, reasoning: true, vision: true, usageReporting: true }}
      modelLabel="the model on this machine"
    />
  );
}

void BrowserAdapter;

createRoot(document.getElementById('root')!).render(
  <div style={{ height: '100vh' }}>
    <PlatformProvider adapter={host}>
      <Preview />
    </PlatformProvider>
  </div>,
);
