/**
 * The local debug log, as a hook.
 *
 * Reads the host's real state on mount — never assumes off — and writes the
 * state the host actually reached, not the one the click asked for. Enabling
 * has to create a directory and can fail; a switch that draws itself from its
 * own optimism is a switch that lies about whether anything is being recorded.
 */

import { useCallback, useEffect, useMemo } from 'react';

import { createHostRepository } from '@/data/host-repository';
import { usePlatform } from '@/platform/PlatformProvider';
import { toPlatformError } from '@/platform/errors';
import { useDebugLogStore, type DebugLogState } from '@/state/debug-log-store';

export interface DebugLogController {
  readonly state: DebugLogState;
  /** Where the host writes it. `null` until the host has answered. */
  readonly path: string | null;
  readonly failure: string | null;
  setEnabled: (enabled: boolean) => Promise<void>;
}

export function useDebugLog(): DebugLogController {
  const adapter = usePlatform();
  const repository = useMemo(() => createHostRepository(adapter), [adapter]);

  const state = useDebugLogStore((store) => store.state);
  const path = useDebugLogStore((store) => store.path);
  const failure = useDebugLogStore((store) => store.failure);
  const report = useDebugLogStore((store) => store.report);
  const reportFailure = useDebugLogStore((store) => store.reportFailure);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await repository.getDebugLog();
        if (!cancelled) report(status);
      } catch (thrown) {
        // The store stays `unknown`, which is what gates the `trace` pointer
        // off. A host that cannot answer is not a host whose log we can promise
        // the user will find anything in.
        if (!cancelled) reportFailure(toPlatformError(thrown).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repository, report, reportFailure]);

  const setEnabled = useCallback(
    async (enabled: boolean): Promise<void> => {
      try {
        report(await repository.setDebugLog(enabled));
      } catch (thrown) {
        reportFailure(toPlatformError(thrown).message);
      }
    },
    [repository, report, reportFailure],
  );

  return { state, path, failure, setEnabled };
}
