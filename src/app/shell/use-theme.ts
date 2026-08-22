/**
 * The appearance preference, joined to the place it is actually kept.
 *
 * ## The defect this closes
 *
 * Every piece existed and none of them touched. `vela-settings` persists a
 * theme; `settings_get` returns it; `settings_set_theme` writes it and has its
 * own Rust tests; `settings-repository.ts` exposes `setTheme`. And the only
 * control in the application — the title bar's cycle button — moved a zustand
 * value and stopped there. So `settings_set_theme` had no caller anywhere in
 * the renderer, `SettingsSnapshot.theme` was never read, and a user's choice
 * was silently discarded at every restart.
 *
 * The same shape as the context meter and the debug log: correct parts, no
 * joint. The joint belongs in the shell, which is what mounts the control.
 *
 * ## Two ordering decisions, both deliberate
 *
 * **The click applies before it persists.** A theme that waits for a round trip
 * is a control that feels broken, and appearance is a renderer concern that
 * needs no permission to change. It is written through immediately afterwards.
 *
 * **A refused write reverts.** If the host will not keep the choice, the
 * preference is put back to what the host actually holds. Leaving the new theme
 * on screen would mean the user sees the old one again at the next launch with
 * nothing to explain it — a silent failure that surfaces days later.
 *
 * **A load never overwrites a choice.** The first read is asynchronous, so a
 * user who clicks before it lands must win: the stored value is applied only
 * while nothing in this session has set one.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';

import { createSettingsRepository } from '@/data/settings-repository';
import { usePlatform } from '@/platform/PlatformProvider';
import { useThemeStore, type ThemePreference } from '@/state/theme-store';

const CYCLE: readonly ThemePreference[] = ['system', 'light', 'dark'];

export interface ThemeController {
  readonly preference: ThemePreference;
  /** system -> light -> dark -> system, persisted. */
  cycle: () => void;
}

export function useTheme(): ThemeController {
  const adapter = usePlatform();
  const repository = useMemo(() => createSettingsRepository(adapter), [adapter]);

  const preference = useThemeStore((state) => state.preference);
  const setPreference = useThemeStore((state) => state.setPreference);

  /** Set the moment the user chooses, so a late load cannot overrule them. */
  const chosenThisSession = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const snapshot = await repository.load();
        if (!cancelled && !chosenThisSession.current) setPreference(snapshot.theme);
      } catch {
        // The store keeps its default, which is `system` — the one preference
        // that needs no storage to be correct.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repository, setPreference]);

  const cycle = useCallback(() => {
    chosenThisSession.current = true;
    const current = useThemeStore.getState().preference;
    const next = CYCLE[(CYCLE.indexOf(current) + 1) % CYCLE.length] ?? 'system';
    setPreference(next);

    void (async () => {
      try {
        // The host answers with what it stored, not with what it was asked for.
        setPreference(await repository.setTheme(next));
      } catch {
        // Put back whatever the host actually holds, rather than leaving a
        // preference on screen that will not survive the next launch.
        try {
          setPreference((await repository.load()).theme);
        } catch {
          setPreference(current);
        }
      }
    })();
  }, [repository, setPreference]);

  return { preference, cycle };
}
