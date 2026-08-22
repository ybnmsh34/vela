/**
 * Hook convention: hooks live beside the feature that owns them, are named
 * `use-*.ts`, and get their data from a repository in `src/data/` rather than
 * calling the adapter directly. Loading/error state is modelled as an explicit
 * union — never as `undefined` doing double duty.
 */

import { useEffect, useMemo, useState } from 'react';

import { createHostRepository } from '@/data/host-repository';
import { usePlatform } from '@/platform/PlatformProvider';
import type { AppInfo } from '@/platform/contract';
import { toPlatformError } from '@/platform/errors';

export type HostStatus =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly info: AppInfo; readonly roundTripMs: number }
  | { readonly state: 'error'; readonly code: string; readonly message: string };

export function useHostStatus(): HostStatus {
  const adapter = usePlatform();
  const repository = useMemo(() => createHostRepository(adapter), [adapter]);
  const [status, setStatus] = useState<HostStatus>({ state: 'loading' });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const startedAt = performance.now();
        const info = await repository.getAppInfo();
        await repository.probeBridge('vela:bridge-probe');
        const roundTripMs = Math.round(performance.now() - startedAt);
        if (!cancelled) setStatus({ state: 'ready', info, roundTripMs });
      } catch (thrown) {
        const error = toPlatformError(thrown);
        if (!cancelled) {
          setStatus({ state: 'error', code: error.code, message: error.message });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [repository]);

  return status;
}
