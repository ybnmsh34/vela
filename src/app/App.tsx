/**
 * The composition root of the UI tree. The only place that mounts the platform
 * provider. Keep it boring: wiring, not logic.
 */

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
 */
function Workspace() {
  const conversationId = useNavigationStore((state) => state.selectedConversationId);
  return (
    <ModelWorkspace hasHistory={conversationId !== null}>
      <Transcript />
    </ModelWorkspace>
  );
}

/**
 * The `key` is the load-bearing part. Switching conversations must not leave the
 * previous transcript's streaming state attached to the new one, and remounting
 * on the id is the cheapest way to make that impossible rather than merely
 * unlikely.
 */
function Transcript() {
  const conversationId = useNavigationStore((state) => state.selectedConversationId);
  const { selection, capabilities } = useSelectedModel();

  return (
    <ConversationSurface
      key={conversationId ?? 'none'}
      providerId={selection?.providerId ?? null}
      modelId={selection?.modelId ?? null}
      modelLabel={selection?.modelLabel ?? null}
      capabilities={capabilities}
    />
  );
}
