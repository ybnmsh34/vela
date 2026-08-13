/**
 * STATE MANAGEMENT — zustand.
 *
 * The choice is settled: **zustand** for shared client state, plain `useState`
 * for state that never leaves one component. Do not add Redux, MobX, Jotai or
 * a second context-based store.
 *
 * Rules:
 *   - One store per domain, in `src/state/<domain>-store.ts`.
 *   - Stores hold state and actions only. No IPC calls inside a store: call a
 *     repository from `src/data/`, then set the result.
 *   - Export a `use<Domain>Store` hook plus selector helpers. Components select
 *     the narrowest slice they need so unrelated updates do not re-render them.
 */

import { create } from 'zustand';

export type ThemePreference = 'system' | 'light' | 'dark';

/**
 * Note what is **not** here: a `cyclePreference`. It used to be, the title bar
 * called it, and because a store may not do IPC (see the rules above) the
 * user's choice went no further than this object — while `settings_set_theme`,
 * which persists it, had no caller anywhere in the renderer. Cycling now lives
 * in `src/app/shell/use-theme.ts`, where it can also be written down. A store
 * action that changes a *persisted* setting without being able to persist it is
 * an invitation to lose the setting, so this one is gone rather than unused.
 */
interface ThemeState {
  readonly preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

/**
 * Applies the preference to the document root. `system` removes the attribute
 * so the `prefers-color-scheme` blocks in tokens.css take over.
 */
export function applyThemePreference(
  preference: ThemePreference,
  root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
): void {
  if (root === null) return;
  if (preference === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', preference);
  }
}

export const useThemeStore = create<ThemeState>((set) => ({
  preference: 'system',
  setPreference: (preference) => {
    applyThemePreference(preference);
    set({ preference });
  },
}));

/** Test helper: put the store, and the document, back to their defaults. */
export function resetThemeStore(): void {
  applyThemePreference('system');
  useThemeStore.setState({ preference: 'system' });
}
