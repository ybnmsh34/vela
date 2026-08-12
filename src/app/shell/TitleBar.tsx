/**
 * The window title bar.
 *
 * The Tauri window is created with `decorations: false`, so this element *is*
 * the title bar. `data-tauri-drag-region` makes the spacer draggable; in a
 * browser it is inert, which is exactly what we want when the app is rendered
 * headlessly.
 *
 * Native window buttons (minimise / maximise / close) are intentionally not
 * here yet: they need `usePlatform()`-mediated window commands, which land with
 * the shell feature work. The capability grant for them is already in
 * `src-tauri/capabilities/main.json`.
 */

import { VelaMark } from '@/components/VelaMark';
import { useThemeStore, type ThemePreference } from '@/state/theme-store';

import styles from './TitleBar.module.css';

const THEME_LABEL: Record<ThemePreference, string> = {
  system: 'Theme: system',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

interface TitleBarProps {
  /** Short context string shown next to the wordmark, e.g. the open workspace. */
  readonly context?: string;
}

export function TitleBar({ context }: TitleBarProps) {
  const preference = useThemeStore((state) => state.preference);
  const cyclePreference = useThemeStore((state) => state.cyclePreference);

  return (
    <header className={styles.bar}>
      <div className={styles.identity}>
        <span className={styles.mark}>
          <VelaMark size={16} title="Vela" />
        </span>
        <span className={styles.wordmark}>Vela</span>
      </div>
      {context !== undefined && <span className={styles.context}>{context}</span>}

      <div className={styles.drag} data-tauri-drag-region />

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.action}
          onClick={cyclePreference}
          aria-label={THEME_LABEL[preference]}
        >
          {THEME_LABEL[preference]}
        </button>
      </div>
    </header>
  );
}
