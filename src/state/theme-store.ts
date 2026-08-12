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

interface ThemeState {
  readonly preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
  /** Cycles system -> light -> dark -> system. */
  cyclePreference: () => void;
}

const CYCLE: readonly ThemePreference[] = ['system', 'light', 'dark'];

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

export const useThemeStore = create<ThemeState>((set, get) => ({
  preference: 'system',
  setPreference: (preference) => {
    applyThemePreference(preference);
    set({ preference });
  },
  cyclePreference: () => {
    const current = get().preference;
    const index = CYCLE.indexOf(current);
    const next = CYCLE[(index + 1) % CYCLE.length] ?? 'system';
    get().setPreference(next);
  },
}));
