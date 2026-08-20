/**
 * React binding for the keyboard half of the platform seam.
 *
 * Shaped deliberately like `PlatformProvider`: the composition root binds the
 * environment once, components ask a hook, and a test substitutes the whole
 * environment by wrapping the component under test. No component reads
 * `navigator`, and the hook throws rather than silently guessing — a label that
 * quietly falls back to the wrong platform is the defect this file exists to
 * close, so it must not be reachable by forgetting to mount the provider.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';

import {
  currentKeyboardEnvironment,
  resolvePrimaryModifier,
  shortcutLabel,
  type KeyboardEnvironment,
  type PrimaryModifier,
  type ShortcutLabel,
} from './keyboard';

const ModifierContext = createContext<PrimaryModifier | null>(null);

export interface KeyboardProviderProps {
  /**
   * Substitute the whole environment. Tests pass a Windows-like or Mac-like
   * literal; production omits it and the live `navigator` is read.
   */
  readonly environment?: KeyboardEnvironment | null;
  /** Substitute the resolved answer directly. Only useful to force a value. */
  readonly modifier?: PrimaryModifier;
  readonly children: ReactNode;
}

export function KeyboardProvider({
  environment,
  modifier,
  children,
}: KeyboardProviderProps): ReactNode {
  const value = useMemo(() => {
    if (modifier !== undefined) return modifier;
    return resolvePrimaryModifier(
      environment === undefined ? currentKeyboardEnvironment() : environment,
    );
  }, [environment, modifier]);

  return <ModifierContext.Provider value={value}>{children}</ModifierContext.Provider>;
}

/** The modifier this machine's keyboard has. */
export function usePrimaryModifier(): PrimaryModifier {
  const modifier = useContext(ModifierContext);
  if (modifier === null) {
    throw new Error(
      'usePrimaryModifier() called outside <KeyboardProvider>. Wrap the tree (or, in a test, the component under test) in a KeyboardProvider — a shortcut badge must never guess which keyboard it is on.',
    );
  }
  return modifier;
}

/**
 * One shortcut, painted and announced, resolved together.
 *
 * `key` is the keycap: `'K'`, `'N'`. The modifier is this machine's. `shift` is
 * for a chord that also holds it — a boolean rather than part of `key`, because
 * where Shift goes in the spelling is a property of the keyboard and not of the
 * shortcut: `⇧⌘N` on a Mac, `Ctrl+Shift+N` everywhere else.
 */
export function useShortcutLabel(key: string, shift = false): ShortcutLabel {
  const modifier = usePrimaryModifier();
  return useMemo(() => shortcutLabel(modifier, key, { shift }), [modifier, key, shift]);
}
