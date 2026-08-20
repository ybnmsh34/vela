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
  /**
   * `true` for a chord that also holds Shift.
   *
   * A flag rather than `keyName="Shift+N"`, because `keyName` is a keycap and
   * `Shift+N` is not one: spelt into the key it would paint `⌘Shift+N` on a Mac
   * — the Command glyph and the English word in one badge. Where Shift goes is
   * a property of the keyboard, so `src/platform/keyboard.ts` decides it.
   */
  readonly shift?: boolean | undefined;
}

export function ShortcutHint({ keyName, className, shift = false }: ShortcutHintProps) {
  const { label, accessibleName } = useShortcutLabel(keyName, shift);

  return (
    <kbd className={className} data-shortcut-hint={shift ? `Shift+${keyName}` : keyName}>
      <span aria-hidden="true">{label}</span>
      <span className={styles.srOnly}>{accessibleName}</span>
    </kbd>
  );
}
