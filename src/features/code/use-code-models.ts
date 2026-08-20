/**
 * What the session's model picker offers, and how big that model's window is.
 *
 * ## Why the choices come from the configured endpoints and not from a probe
 *
 * `settings_get` is a read of the user's own settings row; it opens no socket.
 * `models_list` asks an endpoint to enumerate itself, which is a network call,
 * and doing that on mount is what `use-model-selection.ts` spends its header
 * refusing to do: "A settings screen that quietly opens sockets to every
 * configured box the moment it mounts is not offline-first." A session-setup
 * form is the same screen with a different name.
 *
 * So the offer is exactly the endpoints the user already configured with a model
 * on them. It is smaller than the full catalogue and it is free.
 *
 * ## Why the window comes from `models_capabilities`
 *
 * Same argument, same seam. That command reads the host's cache and never
 * touches the network (`src/data/models-repository.ts` says so at its
 * declaration), and it answers `contextWindowTokens: null` for a model nobody
 * has probed. `null` is passed on unchanged: `src/lib/context-budget.ts` has a
 * first-class `noWindow` outcome and the meter says the window is unknown.
 * Inventing 200,000 here would draw a bar against a number nothing reported.
 */

import { useEffect, useMemo, useState } from 'react';

import { createModelsRepository } from '@/data/models-repository';
import { createSettingsRepository } from '@/data/settings-repository';
import { usePlatform } from '@/platform/PlatformProvider';

export interface CodeModelChoice {
  readonly providerId: string;
  readonly modelId: string;
  /** What the picker shows. The endpoint's own name for itself and its model. */
  readonly label: string;
}

export interface CodeModels {
  readonly status: 'loading' | 'ready' | 'error';
  readonly choices: readonly CodeModelChoice[];
  readonly error: string | null;
}

export function useCodeModels(): CodeModels {
  const adapter = usePlatform();
  const repository = useMemo(() => createSettingsRepository(adapter), [adapter]);
  const [state, setState] = useState<CodeModels>({
    status: 'loading',
    choices: [],
    error: null,
  });

  useEffect(() => {
    let live = true;
    void repository
      .load()
      .then((snapshot) => {
        if (!live) return;
        const choices = snapshot.providers
          .filter((provider) => provider.usable && provider.modelId !== null)
          .map<CodeModelChoice>((provider) => ({
            providerId: provider.id,
            modelId: provider.modelId ?? '',
            label: `${provider.displayName} · ${provider.modelId ?? ''}`,
          }));
        setState({ status: 'ready', choices, error: null });
      })
      .catch((error: unknown) => {
        if (!live) return;
        setState({
          status: 'error',
          choices: [],
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      live = false;
    };
  }, [repository]);

  return state;
}

/**
 * The context window the host has on record for this model, or `null`.
 *
 * `null` covers both "no model chosen" and "the host has nothing cached", and
 * the two are the same answer to the only question a meter asks. What must not
 * happen is a number, and that is the whole reason this returns the host's
 * value rather than a default.
 */
export function useContextWindow(
  providerId: string | null,
  modelId: string | null,
): number | null {
  const adapter = usePlatform();
  const repository = useMemo(() => createModelsRepository(adapter), [adapter]);
  const [window, setWindow] = useState<number | null>(null);

  useEffect(() => {
    if (providerId === null || modelId === null) {
      setWindow(null);
      return;
    }
    let live = true;
    void repository
      .capabilities(providerId, modelId)
      .then((report) => {
        if (live) setWindow(report.contextWindowTokens);
      })
      .catch(() => {
        // A cache read that failed is not a window. Staying `null` is the same
        // answer as "nothing on record", which is what the user is told.
        if (live) setWindow(null);
      });
    return () => {
      live = false;
    };
  }, [repository, providerId, modelId]);

  return window;
}
