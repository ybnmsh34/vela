/**
 * The `<kbd>` badge on a button that also has a keyboard shortcut.
 *
 * Two spans, because the two audiences need different strings and the badge
 * sits inside the button's accessible name:
 *
 *  - the glyph is `aria-hidden`, so `⌘` is never handed to a screen reader as a
 *    character to pronounce;
 *  - the name is visually hidden, so "Command K" is announced and never drawn.
 *
 * Both come from one call to `useShortcutLabel`, so the painted and the spoken
 * halves cannot disagree. The caller supplies `className` for the badge's own
 * look — every surface already has one — and this component owns nothing but
 * the split.
 */

import { useShortcutLabel } from '@/platform/KeyboardProvider';

import styles from './ShortcutHint.module.css';

export interface ShortcutHintProps {
  /** The key as printed on the keycap: `'K'`, `'N'`. */
  readonly keyName: string;
  /** The badge's visual class, owned by the surface it sits on. */
  /** `| undefined` explicitly: the repo runs `exactOptionalPropertyTypes`,
   *  so an optional prop passed through from a CSS-module lookup is
   *  `string | undefined` and `?:` alone will not accept it. */
  readonly className?: string | undefined;
}

export function ShortcutHint({ keyName, className }: ShortcutHintProps) {
  const { label, accessibleName } = useShortcutLabel(keyName);

  return (
    <kbd className={className} data-shortcut-hint={keyName}>
      <span aria-hidden="true">{label}</span>
      <span className={styles.srOnly}>{accessibleName}</span>
    </kbd>
  );
}
