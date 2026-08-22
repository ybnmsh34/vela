/**
 * Holds the conversation list for everything that navigates by it.
 *
 * Wiring only: the state lives in `use-conversations.ts` so that hook stays
 * testable without a component, and this file stays a component without logic.
 */

import type { ReactNode } from 'react';

import { ConversationsContext, useConversationsApi } from './use-conversations';

interface ConversationsProviderProps {
  readonly children: ReactNode;
}

export function ConversationsProvider({ children }: ConversationsProviderProps) {
  const api = useConversationsApi();
  return <ConversationsContext.Provider value={api}>{children}</ConversationsContext.Provider>;
}
