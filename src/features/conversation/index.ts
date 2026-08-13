/**
 * The conversation surface's public face.
 *
 * A shell mounts {@link ConversationSurface} and hands it the chosen model's
 * id, label and capability struct. Everything else — streaming, reasoning,
 * tool-call state, degradation notices, cancellation — is internal.
 *
 * `turnFromParts` is here for whoever restores a conversation from the store:
 * stored content parts go in, the same {@link ConversationEntry} shape the
 * stream produces comes out, so a reloaded transcript renders through exactly
 * the same view as a live one.
 */

export { ConversationSurface } from './ConversationSurface';
export { ConversationView } from './ConversationView';
export { useConversation, type Conversation, type ConversationEntry } from './use-conversation';
export { turnFromParts, type TurnState } from './turn-stream';
/** Tool results out of stored parts, for a transcript restored from the store. */
export { collectToolResults, type ToolResultView } from './tool-calls';
