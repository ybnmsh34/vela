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
import { pendingTurnTexts, useConversation, type ConversationEntry } from './use-conversation';

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
}

export function ConversationSurface({
  conversationId = null,
  providerId = null,
  modelId = null,
  modelLabel = null,
  capabilities = NO_CAPABILITIES,
  initialEntries,
  onPendingTurn,
}: ConversationSurfaceProps) {
  const conversation = useConversation({
    conversationId,
    providerId,
    modelId,
    ...(initialEntries === undefined ? {} : { initialEntries }),
  });

  // The draft is mirrored, not owned: the composer keeps the authoritative copy
  // (see its own note), and this is the shadow the meter is weighed against.
  const [draft, setDraft] = useState('');

  const pending = useMemo(
    () => pendingTurnTexts(conversation.entries, draft),
    [conversation.entries, draft],
  );

  useEffect(() => {
    onPendingTurn?.(pending);
  }, [pending, onPendingTurn]);

  return (
    <ConversationView
      conversation={conversation}
      capabilities={capabilities}
      modelLabel={modelLabel}
      onDraftChange={setDraft}
    />
  );
}
