/**
 * The composition root of the UI tree. The only place that mounts the platform
 * provider. Keep it boring: wiring, not logic.
 */

import { useState } from 'react';

import { ConversationSurface } from '@/features/conversation';
import { ModelWorkspace, useSelectedModel } from '@/features/models';
import { PlatformProvider } from '@/platform/PlatformProvider';
import type { PlatformAdapter } from '@/platform/adapter';
import { useNavigationStore } from '@/state/navigation-store';

import { AppShell } from './shell/AppShell';

interface AppProps {
  /** Injected by tests. Left undefined in production so the runtime is auto-detected. */
  readonly adapter?: PlatformAdapter;
}

export function App({ adapter }: AppProps) {
  return (
    <PlatformProvider {...(adapter === undefined ? {} : { adapter })}>
      <AppShell>
        <Workspace />
      </AppShell>
    </PlatformProvider>
  );
}

/**
 * Joins the three features that meet here: navigation says *which* conversation,
 * the models feature says *where it runs and what that model can do*, and the
 * conversation surface draws *what is in it*. None of the three imports another.
 *
 * The models feature wraps rather than sits beside the transcript, because the
 * transcript needs what it chose: an endpoint to address and a capability struct
 * to render affordances from. Both arrive through `useSelectedModel`.
 *
 * ## The one thing that travels back up, and why it lives here
 *
 * `ModelWorkspace` draws the context meter and the transcript is in its slot,
 * so the meter cannot see what the turn holds — a parent cannot read its
 * children. Something has to carry it, and a composition root is exactly the
 * place: `ConversationSurface` reports what pressing send would put on the
 * wire, this holds it, and `ModelWorkspace` measures it.
 *
 * That connection did not exist. `<ModelWorkspace>` was mounted with no
 * `turnTexts` at all, so the meter measured a permanently empty array: typing
 * 880,000 characters left it reading "About 0 of 200,000 tokens", and the
 * transcript already on screen was never counted either. Both components were
 * correct and separately tested. Nothing joined them, and the joint is here.
 *
 * `null` is the honest initial value, not `[]`: until the surface in the slot
 * has reported, this root does not know what the turn holds, and the meter says
 * "unknown" for that frame rather than "about 0".
 */
function Workspace() {
  const conversationId = useNavigationStore((state) => state.selectedConversationId);
  const [turnTexts, setTurnTexts] = useState<readonly string[] | null>(null);

  return (
    <ModelWorkspace hasHistory={conversationId !== null} turnTexts={turnTexts}>
      <Transcript onPendingTurn={setTurnTexts} />
    </ModelWorkspace>
  );
}

/**
 * The `key` is the load-bearing part. Switching conversations must not leave the
 * previous transcript's streaming state attached to the new one, and remounting
 * on the id is the cheapest way to make that impossible rather than merely
 * unlikely.
 */
function Transcript({ onPendingTurn }: { readonly onPendingTurn: (texts: readonly string[]) => void }) {
  const conversationId = useNavigationStore((state) => state.selectedConversationId);
  const { selection, capabilities } = useSelectedModel();

  return (
    <ConversationSurface
      key={conversationId ?? 'none'}
      providerId={selection?.providerId ?? null}
      modelId={selection?.modelId ?? null}
      modelLabel={selection?.modelLabel ?? null}
      capabilities={capabilities}
      onPendingTurn={onPendingTurn}
    />
  );
}
