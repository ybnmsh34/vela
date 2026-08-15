/**
 * The local endpoint's state, and the two operations that change it.
 *
 * Loading/error is an explicit union (conventions §6) for the same reason
 * `use-providers.ts` has one: "we have not asked the host yet" and "the
 * endpoint is off" are different screens, and only the second one is a switch
 * the user can throw.
 *
 * **Nothing here decides what the endpoint resolved to.** The tool policy in
 * particular is read off the host's answer and never recomputed: the host
 * resolves it from the address the listener actually bound, so a hook that
 * inferred "this string starts with 127, so tools are on" would be describing a
 * listener it has not seen. Every field the panel renders comes back from
 * `endpoint_enable`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createEndpointRepository } from '@/data/endpoint-repository';
import { usePlatform } from '@/platform/PlatformProvider';
import type { EndpointEnableReq, EndpointStatus } from '@/platform/contract';
import { toPlatformError, type IpcErrorCode } from '@/platform/errors';

export type LocalEndpointState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly endpoint: EndpointStatus }
  | { readonly status: 'error'; readonly code: IpcErrorCode; readonly message: string };

export interface LocalEndpointController {
  readonly state: LocalEndpointState;
  /**
   * The last refusal of an *operation*, as opposed to a failure to read the
   * state at all. Kept apart from `state` because a rejected address must not
   * blank out the panel that is showing a running endpoint.
   */
  readonly failure: string | null;
  /** True while an enable or disable is in flight. */
  readonly busy: boolean;
  enable: (request: EndpointEnableReq) => Promise<void>;
  disable: () => Promise<void>;
}

export function useLocalEndpoint(): LocalEndpointController {
  const adapter = usePlatform();
  const repository = useMemo(() => createEndpointRepository(adapter), [adapter]);
  const [state, setState] = useState<LocalEndpointState>({ status: 'loading' });
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Guards a `setState` after unmount, and a slow answer landing on a fast one.
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    const mine = generation.current;
    void (async () => {
      try {
        const endpoint = await repository.status();
        if (generation.current !== mine) return;
        setState({ status: 'ready', endpoint });
      } catch (thrown) {
        if (generation.current !== mine) return;
        const error = toPlatformError(thrown, 'endpoint_status');
        setState({ status: 'error', code: error.code, message: error.message });
      }
    })();
    return () => {
      generation.current += 1;
    };
  }, [repository]);

  const run = useCallback(
    async (operation: () => Promise<EndpointStatus>, command: string): Promise<void> => {
      generation.current += 1;
      const mine = generation.current;
      setBusy(true);
      setFailure(null);
      try {
        const endpoint = await operation();
        if (generation.current !== mine) return;
        setState({ status: 'ready', endpoint });
      } catch (thrown) {
        if (generation.current !== mine) return;
        setFailure(toPlatformError(thrown, command).message);
      } finally {
        if (generation.current === mine) setBusy(false);
      }
    },
    [],
  );

  const enable = useCallback(
    (request: EndpointEnableReq): Promise<void> =>
      run(() => repository.enable(request), 'endpoint_enable'),
    [repository, run],
  );

  const disable = useCallback(
    (): Promise<void> => run(() => repository.disable(), 'endpoint_disable'),
    [repository, run],
  );

  return { state, failure, busy, enable, disable };
}
