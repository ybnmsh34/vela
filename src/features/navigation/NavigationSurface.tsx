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

import { useEffect, useRef, type ReactNode } from 'react';

import { useFocusAnchor } from '@/state/focus-store';
import { useIncognitoStore } from '@/state/incognito-store';
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
  const select = useNavigationStore((state) => state.select);
  const incognito = useIncognitoStore((state) => state.active);
  const incognitoEpoch = useIncognitoStore((state) => state.epoch);

  /**
   * AN INCOGNITO CONVERSATION IS AN UNSAVED ONE, and that is forced rather than
   * chosen.
   *
   * `store_create_conversation` is classified `writes` and the wrapper refuses
   * it, so the mode cannot mint a row to hang a transcript on — which is the
   * point. What it can do is what `use-conversation.ts` already does with
   * `conversationId === null`: no restore on the way in, no write on settle,
   * everything in component state. So the content region shows the transcript
   * while incognito even with nothing selected, and crossing in or out clears
   * the selection.
   *
   * Clearing on the way **in** is what stops the refusals from being felt as
   * breakage: sitting in a saved conversation with a refusing adapter would
   * look like a store that had stopped working. Clearing on the way **out** is
   * what stops the private transcript being on screen after the mode ends.
   *
   * The cost, stated: an agent run needs a conversation to write its rows into
   * as it goes, so `agentAvailable` in `use-conversation.ts` is false here and
   * the composer offers no agent toggle in incognito. That also means project
   * instructions do not reach a turn in this mode — the styles pane's resolved
   * view says so, because it says so for every ordinary send.
   */
  const seenEpoch = useRef(incognitoEpoch);
  useEffect(() => {
    // **On a transition, never on mount.** Written first as a bare
    // `select(null)` in this effect, which is one notch wider than the rule it
    // is implementing: "clear when the mode changes" became "clear whenever
    // this effect runs", and mounting runs it. That clobbered a selection made
    // before render — `ModelWorkspace.test.tsx` sets one that way, and went red
    // — and it would clobber a restored-on-launch selection the same way. The
    // ref is what makes the first run a no-op.
    if (seenEpoch.current === incognitoEpoch) return;
    seenEpoch.current = incognitoEpoch;
    select(null);
  }, [incognitoEpoch, select]);
  // The floor of the focus ladder. `tabindex="-1"` makes the content region a
  // destination without making it a stop on the Tab order, so an overlay that
  // closes while nothing else can hold the keyboard lands here rather than on
  // `<body>` — see `src/state/focus-store.ts`.
  const ground = useFocusAnchor<HTMLElement>('ground');

  useSidebarLayout();
  useNavigationShortcuts({
    onNewConversation: () => void createConversation(),
  });

  return (
    <>
      <Sidebar {...(now === undefined ? {} : { now })} />
      <main className={styles.main} ref={ground} tabIndex={-1}>
        {selectedId === null && !incognito ? (
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
