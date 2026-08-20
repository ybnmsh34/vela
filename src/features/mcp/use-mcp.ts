/**
 * The MCP pane's state: one read of `mcp_list_tools`, projected three ways.
 *
 * ## Why one call and not three
 *
 * `src/data/mcp-repository.ts` offers `listServers`, `toolCatalogue` and
 * `unavailableServers`, and each of those three methods issues its own
 * `mcp_list_tools`. Calling all three to draw one pane would be three round
 * trips — and worse than slow, three *different* answers: the host spawns a
 * server on first use and a pool entry can die between calls, so a pane built
 * that way could list a server as connected in one section and as gone in the
 * next, with nothing on screen saying which read won.
 *
 * So the command is called once, through {@link McpRepository.listServers}, and
 * the two projections are applied to that single response with the pure
 * functions the repository exports for exactly this: {@link toolCatalogueOf} and
 * {@link unavailableServersOf}. Every section of the pane then describes the
 * same instant.
 *
 * **The rules are not re-derived here, and that is the point.** The repository's
 * header argues that a rule which must not vary should not be re-implemented by
 * each caller — two callers namespacing tools differently would produce two
 * catalogues in which the same tool has two names. The same argument covers the
 * schema guard: `isSchemaObject` decides which tools a turn may be offered, and
 * this hook learns that verdict by *reading the catalogue it produced*, never by
 * asking the question again. {@link McpSurvey.offered} is that verdict.
 *
 * ## Failure is a state, not a swallow
 *
 * A machine with no "mcp-servers.json" file and a machine whose `mcp_list_tools`
 * refused look identical drawn as an empty list, and one of them is a lie —
 * the same distinction `src/features/skills/use-skills.ts` and
 * `src/features/memory/use-memory.ts` draw, for the same reason. `configFailure`
 * is a third state again: the command answered, and the answer is that the
 * user's own file could not be used.
 */

import { useEffect, useMemo, useState } from 'react';

import {
  createMcpRepository,
  toolCatalogueOf,
  unavailableServersOf,
  type McpRepository,
  type McpUnavailableServer,
} from '@/data/mcp-repository';
import { usePlatform } from '@/platform/PlatformProvider';
import type { McpFailureReason, McpServerTools } from '@/platform/contract';
import { toPlatformError } from '@/platform/errors';

/**
 * One `mcp_list_tools` answer, with the two projections already applied.
 *
 * Every field here is read on screen; see the pane. `servers` is the host's
 * answer verbatim and keeps **every** configured server, including the ones that
 * are not serving — conventions §9 forbids a row vanishing without a sentence
 * saying why, and `unavailable` is where that sentence is attached.
 */
export interface McpSurvey {
  /** Why the user's "mcp-servers.json" could not be used, or `null`. */
  readonly configFailure: McpFailureReason | null;
  /** Every configured server, connected or not, in the host's order. */
  readonly servers: readonly McpServerTools[];
  /** The servers that contributed no tools, each with its reason. */
  readonly unavailable: readonly McpUnavailableServer[];
  /**
   * The namespaced names a turn would actually be offered.
   *
   * A set rather than the catalogue itself because the only questions the pane
   * asks of it are "is this tool in it" and "how many". Derived from
   * {@link toolCatalogueOf}, so a tool missing from here is missing for the one
   * reason the catalogue drops one.
   */
  readonly offered: ReadonlySet<string>;
}

export type McpState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly survey: McpSurvey }
  | { readonly status: 'error'; readonly code: string; readonly message: string };

export interface McpController {
  readonly state: McpState;
}

export function useMcp(repository?: McpRepository): McpController {
  const adapter = usePlatform();
  const mcp = useMemo(
    () => repository ?? createMcpRepository(adapter),
    [repository, adapter],
  );

  const [state, setState] = useState<McpState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const answer = await mcp.listServers();
        if (cancelled) return;
        setState({
          status: 'ready',
          survey: {
            configFailure: answer.configFailure,
            servers: answer.servers,
            unavailable: unavailableServersOf(answer),
            offered: new Set(toolCatalogueOf(answer).map((tool) => tool.name)),
          },
        });
      } catch (error: unknown) {
        const failure = toPlatformError(error);
        if (cancelled) return;
        setState({ status: 'error', code: failure.code, message: failure.message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mcp]);

  return { state };
}
