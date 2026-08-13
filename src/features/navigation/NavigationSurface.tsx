/**
 * The navigation surface: sidebar, content region, command bar.
 *
 * This is the one component the shell mounts. Everything the navigation feature
 * owns hangs off it, so the shell stays layout-only (conventions §1) and the
 * feature can be tested on its own by rendering this with a fake adapter.
 *
 * The content region is a slot. When no conversation is selected the home
 * screen fills it; when one is, whatever the transcript surface passes as
 * `children` does. That keeps the boundary between "which conversation" and
 * "what is in it" at a component edge instead of inside one.
 */

import type { ReactNode } from 'react';

import { useNavigationStore } from '@/state/navigation-store';

import { CommandPalette } from './CommandPalette';
import { ConversationsProvider } from './ConversationsProvider';
import { HomeSurface } from './HomeSurface';
import { Sidebar } from './Sidebar';
import styles from './NavigationSurface.module.css';
import { useConversations } from './use-conversations';
import { useNavigationShortcuts } from './use-navigation-shortcuts';
import { useSidebarLayout } from './use-sidebar-layout';

interface NavigationSurfaceProps {
  /** Rendered in the content region when a conversation is open. */
  readonly children?: ReactNode;
  /** Reported by the host; shown verbatim on the home screen. */
  readonly secretBackend?: string | null;
  /** Injectable clock, so recency grouping is testable. */
  readonly now?: () => number;
}

export function NavigationSurface(props: NavigationSurfaceProps) {
  return (
    <ConversationsProvider>
      <NavigationLayout {...props} />
    </ConversationsProvider>
  );
}

/**
 * Split out because the shortcuts and the layout hook both need the
 * conversations context, and a provider cannot consume its own value.
 */
function NavigationLayout({ children, secretBackend = null, now }: NavigationSurfaceProps) {
  const { createConversation } = useConversations();
  const selectedId = useNavigationStore((state) => state.selectedConversationId);

  useSidebarLayout();
  useNavigationShortcuts({
    onNewConversation: () => void createConversation(),
  });

  return (
    <>
      <Sidebar {...(now === undefined ? {} : { now })} />
      <main className={styles.main}>
        {selectedId === null ? (
          <HomeSurface secretBackend={secretBackend} />
        ) : (
          (children ?? <OpenConversationPlaceholder />)
        )}
      </main>
      <CommandPalette />
    </>
  );
}

/**
 * What the content region shows when a conversation is open and no transcript
 * surface has been mounted into the slot.
 *
 * It says what is true rather than rendering an empty box: the conversation
 * exists and is selected, and the thing that draws its messages is not this
 * feature's to build.
 */
function OpenConversationPlaceholder() {
  return (
    <div className={styles.placeholder}>
      <p>This conversation is open. The transcript surface renders here.</p>
    </div>
  );
}
