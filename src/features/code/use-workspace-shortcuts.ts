/**
 * The workspace's own keys.
 *
 * | Keys | Does |
 * |---|---|
 * | `F6` / `Shift+F6` | move pane focus forward / back |
 * | `Ctrl/Cmd + \` | close the focused pane |
 *
 * `Cmd+\` is the spec's binding for closing the focused pane
 * (`docs/spec-parts/claude-code-desktop.md` §7). `F6` is not in the spec and is
 * added because the spec has no answer at all for *reaching* a pane by keyboard:
 * without it the only route into the fourth pane is Tab through every control in
 * the first three. F6 is the platform convention for exactly this on Windows and
 * is what editors bind, so it costs no new idea.
 *
 * ## Why `metaKey || ctrlKey`, and why a text field is not exempt
 *
 * Both copied from `src/features/navigation/use-navigation-shortcuts.ts`, which
 * argues them: one bundle ships to three platforms, and a shortcut a composer
 * swallows is not a global shortcut. `event.isComposing` is respected for the
 * same reason it is there — stealing a key mid-composition corrupts input in
 * Japanese, Chinese and Korean.
 *
 * ## Why this listens on `window` while the workspace is a dialog
 *
 * The hook is mounted only while the workspace is open, so the listener exists
 * only while the keys mean something. It is the same shape as the navigation
 * shortcuts and it keeps the bindings in one readable table rather than
 * scattered down a component's `onKeyDown`.
 */

import { useEffect } from 'react';

import { paneOrder } from '@/lib/pane-layout';
import { useCodeWorkspaceStore } from '@/state/code-workspace-store';

export function useWorkspaceShortcuts(): void {
  const layout = useCodeWorkspaceStore((state) => state.layout);
  const focusedPane = useCodeWorkspaceStore((state) => state.focusedPane);
  const focusPane = useCodeWorkspaceStore((state) => state.focusPane);
  const closePane = useCodeWorkspaceStore((state) => state.closePane);

  useEffect(() => {
    function handle(event: KeyboardEvent): void {
      if (event.isComposing) return;
      const order = paneOrder(layout);
      if (order.length === 0) return;

      if (event.key === 'F6') {
        event.preventDefault();
        const at = focusedPane === null ? -1 : order.indexOf(focusedPane);
        const step = event.shiftKey ? -1 : 1;
        // "Nothing is focused yet" is its own case rather than an index of -1
        // to do arithmetic on: `(-1 - 1 + n) % n` is `n - 2`, so the modular
        // form silently lands Shift+F6 on the second-to-last pane instead of the
        // last one.
        const next =
          at === -1 ? (step > 0 ? 0 : order.length - 1) : (at + step + order.length) % order.length;
        focusPane(order[next] ?? null);
        return;
      }

      if (event.key === '\\' && (event.metaKey || event.ctrlKey) && !event.altKey) {
        event.preventDefault();
        // No focused pane means the user has not been in one; closing the first
        // would be a guess about which pane they meant. Doing nothing is the
        // honest answer, and F6 is one press away.
        if (focusedPane !== null) closePane(focusedPane);
      }
    }

    window.addEventListener('keydown', handle);
    return () => {
      window.removeEventListener('keydown', handle);
    };
  }, [layout, focusedPane, focusPane, closePane]);
}
