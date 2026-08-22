/**
 * Application-level keyboard shortcuts for navigation.
 *
 * | Keys | Does |
 * |---|---|
 * | `Ctrl/Cmd + K` | quick switcher |
 * | `Ctrl/Cmd + P` | quick switcher (the other muscle memory) |
 * | `Ctrl/Cmd + F` | search — the same bar, asking the host about contents too |
 * | `Ctrl/Cmd + N` | new conversation |
 * | `Ctrl/Cmd + B` | collapse / expand the sidebar |
 *
 * ## Why the modifier test is `metaKey || ctrlKey`
 *
 * Vela ships on macOS, Windows and Linux from one bundle. Branching on the
 * platform would need a platform lookup in the renderer; accepting either
 * modifier costs nothing and is what every editor does.
 *
 * ## Why a text field is not exempt
 *
 * `Ctrl+K` inside the composer must still open the switcher — that is the point
 * of a global shortcut. What *is* respected is a pending IME composition
 * (`event.isComposing`), because stealing a key mid-composition corrupts input
 * in Japanese, Chinese and Korean.
 */

import { useEffect } from 'react';

import { useNavigationStore } from '@/state/navigation-store';

export interface NavigationShortcutActions {
  readonly onNewConversation: () => void;
}

export function useNavigationShortcuts(actions: NavigationShortcutActions): void {
  const openPalette = useNavigationStore((state) => state.openPalette);
  const closePalette = useNavigationStore((state) => state.closePalette);
  const toggleSidebar = useNavigationStore((state) => state.toggleSidebar);
  const { onNewConversation } = actions;

  useEffect(() => {
    function handle(event: KeyboardEvent): void {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        closePalette();
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;

      switch (event.key.toLowerCase()) {
        case 'k':
        case 'p':
          event.preventDefault();
          openPalette('switcher');
          return;
        case 'f':
          event.preventDefault();
          openPalette('search');
          return;
        case 'n':
          event.preventDefault();
          onNewConversation();
          return;
        case 'b':
          event.preventDefault();
          toggleSidebar();
          return;
        default:
      }
    }

    window.addEventListener('keydown', handle);
    return () => {
      window.removeEventListener('keydown', handle);
    };
  }, [openPalette, closePalette, toggleSidebar, onNewConversation]);
}
