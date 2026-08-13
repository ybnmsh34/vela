/**
 * The composition root of the UI tree. The only place that mounts the platform
 * provider. Keep it boring: wiring, not logic.
 */

import { ConversationSurface } from '@/features/conversation';
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
        <Transcript />
      </AppShell>
    </PlatformProvider>
  );
}

/**
 * Joins the two features that meet here: navigation says *which* conversation,
 * the conversation surface draws *what is in it*. Neither imports the other.
 *
 * The `key` is the load-bearing part. Switching conversations must not leave
 * the previous transcript's streaming state attached to the new one, and
 * remounting on the id is the cheapest way to make that impossible rather than
 * merely unlikely.
 *
 * No provider is passed yet: choosing where a conversation runs belongs to the
 * providers feature, and until it lands the composer says so plainly rather
 * than pretending to be ready.
 */
function Transcript() {
  const conversationId = useNavigationStore((state) => state.selectedConversationId);
  return <ConversationSurface key={conversationId ?? 'none'} />;
}
