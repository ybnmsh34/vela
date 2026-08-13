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
 */

import { NO_CAPABILITIES, type ChatCapabilities } from '@/platform/contract';

import { ConversationView } from './ConversationView';
import { useConversation, type ConversationEntry } from './use-conversation';

interface ConversationSurfaceProps {
  /** `null` until a model has been chosen. The composer says so. */
  readonly providerId?: string | null;
  readonly modelId?: string | null;
  /** How the user named this model; shown in the empty state. */
  readonly modelLabel?: string | null;
  readonly capabilities?: ChatCapabilities;
  /** A transcript restored from the store. Renders through the same view. */
  readonly initialEntries?: readonly ConversationEntry[];
}

export function ConversationSurface({
  providerId = null,
  modelId = null,
  modelLabel = null,
  capabilities = NO_CAPABILITIES,
  initialEntries,
}: ConversationSurfaceProps) {
  const conversation = useConversation({
    providerId,
    modelId,
    ...(initialEntries === undefined ? {} : { initialEntries }),
  });

  return (
    <ConversationView
      conversation={conversation}
      capabilities={capabilities}
      modelLabel={modelLabel}
    />
  );
}
