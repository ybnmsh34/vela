/**
 * Application-level keyboard shortcuts for navigation.
 *
 * | Keys | Does |
 * |---|---|
 * | `Ctrl/Cmd + K` | quick switcher |
 * | `Ctrl/Cmd + P` | quick switcher (the other muscle memory) |
 * | `Ctrl/Cmd + F` | search — the same bar, asking the host about contents too |
 * | `Ctrl/Cmd + N` | new conversation |
 * | `Ctrl/Cmd + Shift + N` | enter / leave incognito |
 * | `Ctrl/Cmd + B` | collapse / expand the sidebar |
 *
 * ## Why the modifier test is `metaKey || ctrlKey`
 *
 * Vela ships on macOS, Windows and Linux from one bundle. Branching on the
 * platform would need a platform lookup in the renderer; accepting either
 * modifier costs nothing and is what every editor does.
 *
 * ## Shift, and the defect that adding one binding exposed
 *
 * The guard used to be `if (!(event.metaKey || event.ctrlKey) || event.altKey)
 * return;` — it asked about the primary modifier and about Alt, and **said
 * nothing about Shift**, then switched on `event.key.toLowerCase()`. So
 * `Ctrl+Shift+N` arrived as `key === 'N'`, lowercased to `'n'`, and opened a new
 * conversation; `Ctrl+Shift+K` opened the switcher; `Ctrl+Shift+F`, the search.
 * Four bindings each answered to two chords.
 *
 * That was invisible while every binding was unshifted — a spare chord that does
 * the same thing looks like generosity. It stops being invisible the moment one
 * shifted chord means something else, which is what `Ctrl+Shift+N` now does:
 * without this, pressing it would toggle incognito **and** create a
 * conversation, and the conversation is a durable row the mode exists to
 * prevent. So the switch is keyed on the chord including Shift, and the
 * unshifted bindings require Shift to be up rather than merely not caring.
 *
 * ## Why a text field is not exempt
 *
 * `Ctrl+K` inside the composer must still open the switcher — that is the point
 * of a global shortcut. What *is* respected is a pending IME composition
 * (`event.isComposing`), because stealing a key mid-composition corrupts input
 * in Japanese, Chinese and Korean.
 */

import { useEffect } from 'react';

import { useIncognitoStore } from '@/state/incognito-store';
import { useNavigationStore } from '@/state/navigation-store';

export interface NavigationShortcutActions {
  readonly onNewConversation: () => void;
}

/**
 * The chord, as a string, including whether Shift was down.
 *
 * Built rather than switched on piecemeal so that every binding below is forced
 * to state its answer to Shift. A `case 'n'` cannot silently also mean
 * `Ctrl+Shift+N` when the thing being matched is `'shift+n'`.
 */
function chordOf(event: KeyboardEvent): string {
  return `${event.shiftKey ? 'shift+' : ''}${event.key.toLowerCase()}`;
}

export function useNavigationShortcuts(actions: NavigationShortcutActions): void {
  const openPalette = useNavigationStore((state) => state.openPalette);
  const closePalette = useNavigationStore((state) => state.closePalette);
  const toggleSidebar = useNavigationStore((state) => state.toggleSidebar);
  const incognito = useIncognitoStore((state) => state.active);
  const setIncognito = useIncognitoStore((state) => state.setActive);
  const { onNewConversation } = actions;

  useEffect(() => {
    function handle(event: KeyboardEvent): void {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        closePalette();
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;

      switch (chordOf(event)) {
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
        // The keyboard half of incognito. The brief for this mode is that it be
        // reachable **both** ways: a control alone is slow for someone who works
        // in it, and a chord alone is a privacy mode nobody discovers. The
        // control is the sidebar's `Incognito` button; this is the chord, and
        // `Ctrl/Cmd+Shift+N` is chosen because it is the one every browser
        // already binds to the same idea.
        //
        // Reading `incognito` from the store and negating it — rather than a
        // `toggle` action — keeps this handler symmetric with the button, which
        // does the same thing. `setActive` is idempotent, so a key held down and
        // repeating cannot flip the mode twice per press.
        case 'shift+n':
          event.preventDefault();
          setIncognito(!incognito);
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
  }, [openPalette, closePalette, toggleSidebar, onNewConversation, incognito, setIncognito]);
}
