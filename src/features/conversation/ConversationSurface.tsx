/**
 * The mounted conversation feature: hook plus view.
 *
 * This is the component a shell mounts. It takes the model's identity and its
 * capabilities as props rather than fetching them, because *choosing* the model
 * is a different feature's job — and because a capability struct handed in is a
 * capability struct that can be varied in a test.
 *
 * The default capabilities are the pessimistic floor: nothing is offered until
 * something has been established. That default is the correct one for an
 * unprobed endpoint, and it means a caller that forgets to pass capabilities
 * under-promises rather than over-promises.
 *
 * ## What travels back out
 *
 * One thing: {@link ConversationSurfaceProps.onPendingTurn}, the text this
 * surface would send if the user pressed Enter now. The host that mounts this
 * owns the model bar and its context meter, and the meter cannot reach in here.
 * Reporting outward — rather than letting the meter reach in — keeps the
 * dependency pointing the way the rest of the feature boundary points: the
 * conversation feature still imports nothing from the models feature.
 */

import { useEffect, useMemo, useState } from 'react';

import { NO_CAPABILITIES, type ChatCapabilities } from '@/platform/contract';

import { ConversationView } from './ConversationView';
import { TurnAttachmentsProvider, type TurnAttachments } from './turn-attachments';
import {
  assistantTexts,
  pendingTurnTexts,
  useConversation,
  type ConversationEntry,
} from './use-conversation';

interface ConversationSurfaceProps {
  /**
   * Which conversation this is. Given one, the surface reads its transcript
   * back from the store on mount and writes each settled turn to it — which is
   * what makes a conversation a record rather than the lifetime of a mount.
   * `null` keeps the old behaviour: nothing is read, nothing is written.
   */
  readonly conversationId?: string | null;
  /** `null` until a model has been chosen. The composer says so. */
  readonly providerId?: string | null;
  readonly modelId?: string | null;
  /** How the user named this model; shown in the empty state. */
  readonly modelLabel?: string | null;
  readonly capabilities?: ChatCapabilities;
  /** A transcript restored from the store. Renders through the same view. */
  readonly initialEntries?: readonly ConversationEntry[];
  /**
   * Called with everything pressing send would put on the wire — the replayed
   * transcript plus the draft — whenever either changes, and once on mount.
   *
   * A host that wants to weigh the turn before it happens (the context meter)
   * subscribes here. A host that does not simply omits it, and nothing in this
   * surface changes.
   */
  readonly onPendingTurn?: ((texts: readonly string[]) => void) | undefined;
  /**
   * Called with every settled assistant answer, oldest first, whenever the
   * transcript changes and once on mount.
   *
   * Reported outward for the same reason {@link ConversationSurfaceProps.onPendingTurn}
   * is: something else on screen needs what this surface holds, and it must not
   * reach in. Canvas is that something — it scans these for fenced blocks it can
   * draw — and the array is plain strings so that this feature still imports
   * nothing from that one.
   */
  readonly onAssistantMessages?: ((texts: readonly string[]) => void) | undefined;
  /**
   * The files the user staged for the next message.
   *
   * Handed in rather than reached for, like the capability struct above and for
   * the same reason: the picker, the tray and the drop zone belong to another
   * feature, and this one must not import it. What arrives is the narrow port
   * in `turn-attachments.ts` — read, send, clear.
   *
   * Omitted means *there is no attach affordance at all*, which is the state a
   * surface mounted on its own in a test is in. It is not "the tray is empty".
   */
  readonly attachments?: TurnAttachments | null;
  /**
   * The chosen model's context window, when the endpoint reported one.
   *
   * Handed in for the same reason the capability struct is: what the model can
   * do belongs to another feature. Used only to size the memory block — see
   * `src/lib/memory-prompt.ts` — so `null` costs the user a smaller memory
   * block, never a refused turn.
   */
  readonly contextWindowTokens?: number | null;
}

export function ConversationSurface({
  conversationId = null,
  providerId = null,
  modelId = null,
  modelLabel = null,
  capabilities = NO_CAPABILITIES,
  initialEntries,
  onPendingTurn,
  onAssistantMessages,
  attachments = null,
  contextWindowTokens = null,
}: ConversationSurfaceProps) {
  const conversation = useConversation({
    conversationId,
    providerId,
    modelId,
    attachments,
    contextWindowTokens,
    ...(initialEntries === undefined ? {} : { initialEntries }),
  });

  // The draft is mirrored, not owned: the composer keeps the authoritative copy
  // (see its own note), and this is the shadow the meter is weighed against.
  const [draft, setDraft] = useState('');

  // The memory block is part of what pressing send would put on the wire, so
  // it is part of what the meter is told about. Leaving it out here while
  // `toMessages` sends it is exactly the drift the shared traversal exists to
  // prevent.
  const pending = useMemo(
    () => pendingTurnTexts(conversation.entries, draft, conversation.memoryPreamble),
    [conversation.entries, draft, conversation.memoryPreamble],
  );

  useEffect(() => {
    onPendingTurn?.(pending);
  }, [pending, onPendingTurn]);

  const answers = useMemo(() => assistantTexts(conversation.entries), [conversation.entries]);

  useEffect(() => {
    onAssistantMessages?.(answers);
  }, [answers, onAssistantMessages]);

  // The composer's picker reads the holder from here rather than through the
  // view, which is presentational and has no business knowing files exist.
  return (
    <TurnAttachmentsProvider value={attachments}>
      <ConversationView
        conversation={conversation}
        capabilities={capabilities}
        modelLabel={modelLabel}
        onDraftChange={setDraft}
      />
    </TurnAttachmentsProvider>
  );
}
