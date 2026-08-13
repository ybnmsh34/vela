/**
 * The conversation surface: transcript above, composer below.
 *
 * Presentational on purpose — it takes a {@link Conversation} and renders it,
 * so the whole surface can be driven from a scripted state in a test without a
 * host, a repository or a timer anywhere in sight.
 *
 * ## Scroll behaviour
 *
 * The transcript follows the stream only while the reader is already at the
 * bottom. Scroll up mid-answer and it stops following; scroll back down and it
 * resumes. The decision lives in `scroll.ts` so it can be asserted; this
 * component only owns the plumbing.
 */

import { useEffect, useLayoutEffect, useRef } from 'react';

import type { ChatCapabilities } from '@/platform/contract';

import { Composer } from './Composer';
import { EmptyConversation } from './EmptyConversation';
import { AssistantTurn, UserTurn } from './MessageTurn';
import { isPinnedToBottom } from './scroll';
import type { Conversation } from './use-conversation';
import styles from './ConversationView.module.css';

interface ConversationViewProps {
  readonly conversation: Conversation;
  readonly capabilities: ChatCapabilities;
  /** How the user named this model. Never a backend identity. */
  readonly modelLabel: string | null;
  /** Forwarded to the composer; see {@link Composer}'s own note on why. */
  readonly onDraftChange?: ((text: string) => void) | undefined;
}

export function ConversationView({
  conversation,
  capabilities,
  modelLabel,
  onDraftChange,
}: ConversationViewProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Re-measured on the user's scroll, never on ours: `scrollTo` below fires a
  // scroll event too, and reading the flag from that would make it always true.
  useEffect(() => {
    const node = scroller.current;
    if (node === null) return;
    const onScroll = (): void => {
      pinned.current = isPinnedToBottom(node);
    };
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      node.removeEventListener('scroll', onScroll);
    };
  }, []);

  // After the commit that grew the transcript, before paint — so the jump to
  // the bottom is never visible as a jump.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node === null || !pinned.current) return;
    node.scrollTop = node.scrollHeight;
  }, [conversation.entries]);

  const empty = conversation.entries.length === 0;

  return (
    <section className={styles.surface} aria-label="Conversation">
      <div className={styles.scroller} ref={scroller}>
        <div className={styles.column}>
          {empty ? (
            <EmptyConversation capabilities={capabilities} modelLabel={modelLabel} />
          ) : (
            <div className={styles.transcript} role="log" aria-live="polite" aria-busy={conversation.streaming}>
              {conversation.entries.map((entry) =>
                entry.kind === 'user' ? (
                  <UserTurn key={entry.id} text={entry.text} />
                ) : (
                  <AssistantTurn
                    key={entry.id}
                    id={entry.id}
                    turn={entry.turn}
                    onRetry={conversation.streaming ? undefined : conversation.retry}
                  />
                ),
              )}
            </div>
          )}
        </div>
      </div>

      <Composer
        capabilities={capabilities}
        streaming={conversation.streaming}
        blockedReason={conversation.blockedReason}
        onSend={conversation.send}
        onCancel={conversation.stop}
        onDraftChange={onDraftChange}
      />
    </section>
  );
}
