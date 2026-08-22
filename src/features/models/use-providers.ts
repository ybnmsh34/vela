/**
 * The configured-endpoint list, and the operations that change it.
 *
 * Loading/error is an explicit union (conventions §6) — never `undefined` doing
 * double duty, because "we have not asked yet" and "there are no endpoints" are
 * different screens and the second one is a call to action.
 *
 * Nothing here knows what a backend is. Every decision a caller needs comes off
 * the host-computed flags on `ProviderView`: `usable`, `credentialFieldLabel`,
 * `credentialCheck`, `security`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createSettingsRepository } from '@/data/settings-repository';
import { usePlatform } from '@/platform/PlatformProvider';
import type {
  ProviderView,
  SettingsPutProviderReq,
  WireProtocolOption,
} from '@/platform/contract';
import { toPlatformError, type IpcErrorCode } from '@/platform/errors';

export type ProvidersState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly providers: readonly ProviderView[];
      /** `os-keychain` or `memory-fake`, verbatim from the host. Never inferred. */
      readonly credentialBackend: string;
      /**
       * The protocol choices, verbatim from the host. Carried, never
       * enumerated: this hook could not name one if it wanted to, which is what
       * makes a fourth protocol zero lines of renderer change.
       */
      readonly protocols: readonly WireProtocolOption[];
    }
  | { readonly status: 'error'; readonly code: IpcErrorCode; readonly message: string };

export interface ProvidersController {
  readonly state: ProvidersState;
  reload: () => Promise<void>;
  /** Create or replace an endpoint. Rejects with a `PlatformError`. */
  save: (config: SettingsPutProviderReq) => Promise<ProviderView>;
  remove: (providerId: string) => Promise<void>;
  /** One-way: written to the OS keychain, never read back. */
  storeCredential: (providerId: string, value: string) => Promise<void>;
  clearCredential: (providerId: string) => Promise<void>;
}

export function useProviders(): ProvidersController {
  const adapter = usePlatform();
  const repository = useMemo(() => createSettingsRepository(adapter), [adapter]);
  const [state, setState] = useState<ProvidersState>({ status: 'loading' });
  // Guards a `setState` after unmount, and — more importantly — a slow reload
  // landing on top of a fast one.
  const generation = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    generation.current += 1;
    const mine = generation.current;
    try {
      const snapshot = await repository.load();
      if (generation.current !== mine) return;
      setState({
        status: 'ready',
        providers: snapshot.providers,
        credentialBackend: snapshot.credentialBackend,
        protocols: snapshot.protocols,
      });
    } catch (thrown) {
      if (generation.current !== mine) return;
      const error = toPlatformError(thrown, 'settings_get');
      setState({ status: 'error', code: error.code, message: error.message });
    }
  }, [repository]);

  useEffect(() => {
    void reload();
    return () => {
      // Invalidate anything in flight, so a response cannot arrive into an
      // unmounted tree.
      generation.current += 1;
    };
  }, [reload]);

  const save = useCallback(
    async (config: SettingsPutProviderReq): Promise<ProviderView> => {
      const view = await repository.putProvider(config);
      await reload();
      return view;
    },
    [repository, reload],
  );

  const remove = useCallback(
    async (providerId: string): Promise<void> => {
      await repository.deleteProvider(providerId);
      await reload();
    },
    [repository, reload],
  );

  const storeCredential = useCallback(
    async (providerId: string, value: string): Promise<void> => {
      await repository.storeCredential(providerId, value);
      await reload();
    },
    [repository, reload],
  );

  const clearCredential = useCallback(
    async (providerId: string): Promise<void> => {
      await repository.clearCredential(providerId);
      await reload();
    },
    [repository, reload],
  );

  return { state, reload, save, remove, storeCredential, clearCredential };
}
