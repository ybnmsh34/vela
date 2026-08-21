/**
 * The mounted styles feature: nothing at all until the user opens it.
 *
 * The same shape as `src/features/projects/ProjectsSurface.tsx`, and for the
 * same two reasons. Mounted by the composition root rather than by the sidebar
 * that opens it, because `src/features/README.md` forbids one feature importing
 * another — the sidebar sets a boolean in `src/state/style-store.ts` and this
 * reads it. And rendering `null` while closed keeps the pane's `project_get` off
 * every launch in which the user never opens it.
 *
 * What is deliberately **not** gated behind this mount is incognito itself. The
 * mode is entered from the sidebar control and from the keyboard, its indication
 * is drawn by `AppShell`, and its enforcement is `IncognitoGate` — which
 * `App.tsx` mounts, but does not itself contain: the wrapping happens in
 * `IncognitoGate.tsx` and `App.tsx` selects nothing from the incognito store at
 * all. (This sentence said `App.tsx` was the wrapper. It is not, and the same
 * wrong reader was named in `src/state/incognito-store.ts`; both are corrected,
 * because a claim repaired in one file and left standing two files away is how
 * the wrong one survives.) A privacy mode that only worked while its settings
 * pane happened to be open would be the shape of defect this repository keeps
 * finding.
 */

import { useStyleStore } from '@/state/style-store';

import { StylePanel } from './StylePanel';

export function StylesSurface() {
  const open = useStyleStore((state) => state.open);
  const setOpen = useStyleStore((state) => state.setOpen);

  if (!open) return null;
  return (
    <StylePanel
      onClose={() => {
        setOpen(false);
      }}
    />
  );
}
