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

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { ChatCapabilities } from '@/platform/contract';

import { Composer } from './Composer';
import { EmptyConversation } from './EmptyConversation';
import { AssistantTurn, UserTurn } from './MessageTurn';
import { isPinnedToBottom, restingScrollTop, scrollEdges } from './scroll';
import type { Conversation } from './use-conversation';
import styles from './ConversationView.module.css';

interface ConversationViewProps {
  readonly conversation: Conversation;
  readonly capabilities: ChatCapabilities;
  /** How the user named this model. Never a backend identity. */
  readonly modelLabel: string | null;
  /**
   * The endpoint the conversation is addressed to, as the user configured it.
   * Forwarded to each assistant turn so it can disclose when a *different* one
   * answered. Compared, never branched on.
   */
  readonly selectedProviderId?: string | null | undefined;
  /** Forwarded to the composer; see {@link Composer}'s own note on why. */
  readonly onDraftChange?: ((text: string) => void) | undefined;
}

export function ConversationView({
  conversation,
  capabilities,
  modelLabel,
  selectedProviderId,
  onDraftChange,
}: ConversationViewProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Which edges have nothing beyond them. The stylesheet fades the transcript
  // into an edge that hides content and leaves an edge that does not alone — a
  // permanent gradient would dim the first turn of a conversation scrolled to
  // the top, which is the guillotine pointed the other way. Two booleans rather
  // than one object so React's own bail-out does the work: a scroll event that
  // does not change an edge causes no render.
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);

  const measureEdges = useCallback((node: HTMLDivElement): void => {
    const edges = scrollEdges(node);
    setAtTop(edges.atTop);
    setAtBottom(edges.atBottom);
  }, []);

  // Both inputs to the mask are measured **outside the commit phase**, and that
  // is deliberate rather than incidental. Measuring in the layout effect below
  // instead — which is where the scroll-to-bottom already lives, and the
  // obvious place to put it — reads the container's geometry and then sets
  // state inside the commit that produced it, on every delta of a stream. A
  // scroll listener and a `ResizeObserver` both fire after layout has settled,
  // so the transcript can grow a hundred times a second without a render ever
  // scheduling another render.
  useEffect(() => {
    const node = scroller.current;
    if (node === null) return;

    // Re-measured on the user's scroll, never on ours: `scrollTo` below fires a
    // scroll event too, and reading the *pinned* flag from that would make it
    // always true.
    const onScroll = (): void => {
      pinned.current = isPinnedToBottom(node);
      measureEdges(node);
    };
    node.addEventListener('scroll', onScroll, { passive: true });

    // The other way an edge changes, and the one a scroll event never reports:
    // a transcript that grew while the reader was parked in the middle of it
    // has content below them now, and the container never scrolled.
    // `ResizeObserver` is absent in jsdom, where there is no layout to observe.
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            measureEdges(node);
          });
    if (observer !== null && node.firstElementChild !== null) {
      observer.observe(node.firstElementChild);
    }
    measureEdges(node);

    return () => {
      node.removeEventListener('scroll', onScroll);
      observer?.disconnect();
    };
  }, [measureEdges]);

  // After the commit that grew the transcript, before paint — so the jump to
  // the bottom is never visible as a jump. Geometry only: no state is set here.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node === null) return;
    const resting = restingScrollTop(node, {
      pinned: pinned.current,
      entries: conversation.entries.length,
    });
    if (resting !== null) node.scrollTop = resting;
  }, [conversation.entries]);

  const empty = conversation.entries.length === 0;
  const replies = replyPositions(conversation.entries);

  return (
    <section className={styles.surface} aria-label="Conversation">
      <div
        className={styles.scroller}
        ref={scroller}
        data-at-top={atTop ? 'true' : 'false'}
        data-at-bottom={atBottom ? 'true' : 'false'}
      >
        <div className={styles.column}>
          {empty ? (
            <EmptyConversation capabilities={capabilities} modelLabel={modelLabel} />
          ) : (
            <div className={styles.transcript} role="log" aria-live="polite" aria-busy={conversation.streaming}>
              {conversation.entries.map((entry, index) =>
                entry.kind === 'user' ? (
                  <UserTurn key={entry.id} text={entry.text} />
                ) : (
                  <AssistantTurn
                    key={entry.id}
                    id={entry.id}
                    turn={entry.turn}
                    runDegradations={entry.runDegradations}
                    selectedProviderId={selectedProviderId ?? null}
                    // **Bound to this turn, not to the transcript.** Every
                    // assistant turn used to be handed the same argument-less
                    // `conversation.retry`, which re-sent whatever the *last*
                    // user message was — so the button on an early failed turn
                    // acted four turns away from itself. The id is the turn the
                    // button is drawn on; `retry` resolves the question from it.
                    onRetry={
                      conversation.streaming
                        ? undefined
                        : () => {
                            conversation.retry(entry.id);
                          }
                    }
                    // Retrying replaces this turn and everything after it. When
                    // there is an "after it", the button says so.
                    laterTurnsFollow={index < conversation.entries.length - 1}
                    // Which reply the retry control would discard, for its
                    // accessible name. The question is read off the transcript
                    // the same way `retry` reads it — walking back from this
                    // turn to the nearest user message — because a button that
                    // says which reply it discards and then discards a
                    // different one would be worse than one that says nothing.
                    //
                    // The position comes with it because the question alone
                    // does not tell two of these apart: several assistant turns
                    // can sit under one question, and two long questions can
                    // agree over the whole of the quote. See `RetryTarget`.
                    retryTarget={{
                      question: questionAnswered(conversation.entries, index),
                      replyIndex: replies.ordinals[index] ?? 1,
                      replyCount: replies.count,
                    }}
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
        agent={conversation.agent}
        onSend={conversation.send}
        onCancel={conversation.stop}
        onDraftChange={onDraftChange}
      />
    </section>
  );
}

/**
 * The question an assistant turn answers — the nearest user message **at or
 * before** it, or `undefined` for a turn with none in front of it.
 *
 * Deliberately the same walk `use-conversation.ts`'s `retry` makes: it takes
 * `current.slice(0, at + 1)` and `lastIndexOf('user')`. A retry control whose
 * accessible name quoted one question while the action discarded from another
 * would be a worse defect than the unnamed button it replaces, so the two read
 * the transcript the same way. `retry` owns the action and this owns the name;
 * neither derives from the other, which is why the comment says so rather than
 * leaving a reader to notice.
 */
function questionAnswered(entries: Conversation['entries'], index: number): string | undefined {
  for (let at = index; at >= 0; at -= 1) {
    const entry = entries[at];
    if (entry !== undefined && entry.kind === 'user') return entry.text;
  }
  return undefined;
}

/**
 * Where each assistant turn sits among the assistant turns, and how many there
 * are — the part of a retry control's name that **cannot** collide.
 *
 * `ordinals[i]` is the 1-based position of the entry at `i` among the
 * transcript's assistant entries, for an `i` that is one; for a user entry it
 * is the count so far, which nothing reads. No two assistant entries share a
 * value, which is the whole property {@link AssistantTurn}'s `RetryTarget`
 * rests on — a name built from it is distinct however the questions read.
 *
 * One pass rather than a count per turn: the alternative is a scan inside the
 * render loop, which is quadratic in a transcript that can hold hundreds of
 * rows and grows a row per step of an agent run.
 */
function replyPositions(entries: Conversation['entries']): {
  readonly ordinals: readonly number[];
  readonly count: number;
} {
  const ordinals: number[] = [];
  let count = 0;
  for (const entry of entries) {
    if (entry.kind === 'assistant') count += 1;
    ordinals.push(count);
  }
  return { ordinals, count };
}
