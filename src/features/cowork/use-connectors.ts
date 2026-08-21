/**
 * The context panel's read: which tool servers this machine can reach, and what
 * they offer.
 *
 * ## This is the surface `src/data/mcp-repository.ts` was waiting for
 *
 * That module's entry in `AWAITING_A_SURFACE` in `src/runtime/reachable.test.ts`
 * read, verbatim: *"There is no `src/features/mcp/` — no pane, no control, no
 * store — so wiring it is a surface, not a mount, and it is not this branch's
 * change. Delete this entry when a user can press something that reaches
 * `toolCatalogue()`."* This hook calls `listServers()` and derives both
 * projections from the one response, so the entry goes.
 *
 * ## One call, both projections — not two calls
 *
 * `McpRepository` offers `toolCatalogue()` and `unavailableServers()`, and each
 * of them calls `mcp_list_tools` again. Cost is not the argument against that:
 * `McpListToolsRes` in `src/platform/contract.ts` says the host "reuses the
 * process afterwards" and that the command "can also answer instantly from
 * cache, which is what the second call does". The argument is that two calls
 * are two *moments*. The panel would be drawing a catalogue from one and a
 * failure list from another, and a server that connected between them appears
 * in both — connected and unavailable at once. `listServers()` once, with the
 * two exported pure projections taken over that single response, is the only
 * reading that cannot disagree with itself.
 *
 * That is why `toolCatalogueOf` and `unavailableServersOf` are exported from the
 * repository as functions over a response, and this hook uses those rather than
 * the two convenience methods beside them.
 *
 * ## `configFailure` is not a server problem and is not folded into one
 *
 * `McpListToolsRes.configFailure` is non-null when the *configuration* could not
 * be read at all — a different thing from a configured server that would not
 * start, and a different repair. Flattening it into the unavailable list would
 * tell a user with no config file that a server had failed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createMcpRepository,
  toolCatalogueOf,
  unavailableServersOf,
  type McpRepository,
  type McpUnavailableServer,
} from '@/data/mcp-repository';
import { usePlatform } from '@/platform/PlatformProvider';
import type { McpFailureReason, McpServerTools, ToolDefinitionInput } from '@/platform/contract';
import { toPlatformError } from '@/platform/errors';

export interface Connectors {
  readonly servers: readonly McpServerTools[];
  readonly connected: readonly McpServerTools[];
  readonly unavailable: readonly McpUnavailableServer[];
  /** Every tool a turn could be offered right now, in the shape it takes them. */
  readonly tools: readonly ToolDefinitionInput[];
  readonly configFailure: McpFailureReason | null;
}

export type ConnectorsState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly connectors: Connectors }
  | { readonly status: 'error'; readonly code: string; readonly message: string };

export interface ConnectorsController {
  readonly state: ConnectorsState;
  reload: () => void;
}

export function useConnectors(repository?: McpRepository): ConnectorsController {
  const adapter = usePlatform();
  const mcp = useMemo(() => repository ?? createMcpRepository(adapter), [repository, adapter]);

  const [state, setState] = useState<ConnectorsState>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let abandoned = false;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const response = await mcp.listServers();
        if (abandoned || !mounted.current) return;
        setState({
          status: 'ready',
          connectors: {
            servers: response.servers,
            connected: response.servers.filter((server) => server.status.kind === 'connected'),
            unavailable: unavailableServersOf(response),
            tools: toolCatalogueOf(response),
            configFailure: response.configFailure,
          },
        });
      } catch (error: unknown) {
        const failure = toPlatformError(error);
        if (!abandoned && mounted.current) {
          setState({ status: 'error', code: failure.code, message: failure.message });
        }
      }
    })();
    return () => {
      abandoned = true;
    };
  }, [mcp, nonce]);

  const reload = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  return { state, reload };
}
