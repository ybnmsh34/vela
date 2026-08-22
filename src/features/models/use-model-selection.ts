/**
 * Joins the configured endpoints to the chosen one and its capability report.
 *
 * ## The two costs, kept apart
 *
 * `models_capabilities` is free: it reads the host's cache and never touches
 * the network, so it runs automatically whenever the selection changes. `probe`
 * and `discover` contact the endpoint, so they are only ever called because the
 * user asked. A settings screen that quietly opens sockets to every configured
 * box the moment it mounts is not offline-first.
 *
 * ## Staleness
 *
 * A capability report is only ever applied to the selection it was fetched for
 * (`setReport` in the store enforces it, and the generation counter here stops
 * the request landing at all). A slow probe must never hand a newly-chosen model
 * the previous one's flags — that is precisely how an affordance gets offered
 * for an endpoint that cannot serve it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createModelsRepository } from '@/data/models-repository';
import { usePlatform } from '@/platform/PlatformProvider';
import type { ChatError, ModelOption, ProviderView } from '@/platform/contract';
import { toPlatformError } from '@/platform/errors';
import { capabilitiesOf, useModelStore, type ModelSelection } from '@/state/model-store';

import { defaultSelection, modelEntries, stillExists, type ModelEntry } from './catalogue';

export interface ModelSelectionController {
  readonly entries: readonly ModelEntry[];
  readonly selection: ModelSelection | null;
  /** The flag set every affordance branches on. Never `null`, never optimistic. */
  readonly capabilities: ReturnType<typeof capabilitiesOf>;
  readonly report: ReturnType<typeof useModelStore.getState>['report'];
  readonly switchedFrom: ModelSelection | null;
  readonly probing: boolean;
  /** The last probe's failure, in the taxonomy the chat surface already renders. */
  readonly probeFailure: ChatError | null;
  select: (selection: ModelSelection, hasHistory: boolean) => void;
  acknowledgeSwitch: () => void;
  /** Ask the endpoint what the chosen model can do. User-triggered only. */
  probe: () => Promise<void>;
  /** Ask an endpoint to enumerate its models. User-triggered only. */
  discover: (providerId: string) => Promise<void>;
}

export function useModelSelection(
  providers: readonly ProviderView[],
): ModelSelectionController {
  const adapter = usePlatform();
  const repository = useMemo(() => createModelsRepository(adapter), [adapter]);

  const selection = useModelStore((state) => state.selection);
  const report = useModelStore((state) => state.report);
  const switchedFrom = useModelStore((state) => state.switchedFrom);
  const select = useModelStore((state) => state.select);
  const setReport = useModelStore((state) => state.setReport);
  const acknowledgeSwitch = useModelStore((state) => state.acknowledgeSwitch);
  const clear = useModelStore((state) => state.clear);

  const [discovered, setDiscovered] = useState<ReadonlyMap<string, readonly ModelOption[]>>(
    () => new Map(),
  );
  const [probing, setProbing] = useState(false);
  const [probeFailure, setProbeFailure] = useState<ChatError | null>(null);
  const generation = useRef(0);

  const entries = useMemo(() => modelEntries(providers, discovered), [providers, discovered]);

  // Choose a default, and drop a selection whose endpoint the user deleted.
  // Both directions matter: a stale selection would address a provider the host
  // no longer has, and every turn would come back NOT_FOUND.
  useEffect(() => {
    if (stillExists(entries, selection)) return;
    const fallback = defaultSelection(entries);
    if (fallback === null) {
      if (selection !== null) clear();
      return;
    }
    select(fallback, { hasHistory: false });
  }, [entries, selection, select, clear]);

  // Free lookup, every time the selection changes.
  useEffect(() => {
    if (selection === null) return;
    generation.current += 1;
    const mine = generation.current;
    void (async () => {
      try {
        const found = await repository.capabilities(selection.providerId, selection.modelId);
        if (generation.current === mine) setReport(found);
      } catch {
        // A cache read that failed leaves the report `null`, which the UI reads
        // as the pessimistic floor. Nothing is offered, nothing is claimed.
        if (generation.current === mine) setReport(null);
      }
    })();
  }, [selection, repository, setReport]);

  const probe = useCallback(async (): Promise<void> => {
    if (selection === null) return;
    const target = selection;
    setProbing(true);
    setProbeFailure(null);
    generation.current += 1;
    const mine = generation.current;
    try {
      const result = await repository.probe(target.providerId, target.modelId);
      if (generation.current !== mine) return;
      setReport(result.report);
      setProbeFailure(result.failure);
    } catch (thrown) {
      if (generation.current !== mine) return;
      // A host-level refusal (an endpoint that is not registered, a blank id)
      // is not a provider error. It is reported as a transport-shaped failure
      // so the surface has exactly one thing to render, with the cause naming
      // what actually happened.
      const error = toPlatformError(thrown, 'models_probe');
      setProbeFailure({
        kind: 'transport',
        failure: 'connect',
        diagnosis: {
          cause: error.code === 'NOT_FOUND' ? 'no_provider_configured' : 'connection_failed',
          correlation: 0,
        },
      });
    } finally {
      if (generation.current === mine) setProbing(false);
    }
  }, [selection, repository, setReport]);

  const discover = useCallback(
    async (providerId: string): Promise<void> => {
      try {
        const result = await repository.listModels(providerId);
        // An endpoint with no listing route reports `enumerated: false` and no
        // failure. Storing an empty list for it would be indistinguishable from
        // "it listed nothing", so it is simply not recorded.
        if (!result.enumerated) return;
        setDiscovered((previous) => {
          const next = new Map(previous);
          next.set(providerId, result.models);
          return next;
        });
      } catch {
        // Same reasoning as above: nothing discovered, nothing claimed. The
        // configured model stays offered.
      }
    },
    [repository],
  );

  return {
    entries,
    selection,
    capabilities: capabilitiesOf(report),
    report,
    switchedFrom,
    probing,
    probeFailure,
    select: useCallback(
      (next: ModelSelection, hasHistory: boolean) => {
        setProbeFailure(null);
        select(next, { hasHistory });
      },
      [select],
    ),
    acknowledgeSwitch,
    probe,
    discover,
  };
}
