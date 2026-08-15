/**
 * MCP repository — the user's own tool servers, and the catalogue a turn is
 * offered.
 *
 * ## The one job that is not a passthrough
 *
 * {@link McpRepository.toolCatalogue} turns what the servers report into
 * `ToolDefinitionInput[]`, which is exactly what `ChatSendReq.tools` and
 * `RunRequest.tools` take. That is the whole point of the subsystem: an MCP
 * server's tools are useless until they are in the shape the turn that will call
 * them accepts. Everything else here is a call and a projection.
 *
 * The conversion is one function, in one place, for the reason
 * `src/platform/contract-harness.ts` gives for shipping `mergeRunCapabilities`
 * rather than describing it — a rule that must not vary should not be
 * re-derived by every caller. Two callers namespacing tools differently would
 * produce two catalogues in which the same tool has two names, and a model that
 * called the one it saw last turn would be calling a tool that no longer exists.
 *
 * ## What it does not do
 *
 * It does not execute anything. Calling a tool is the harness contract's
 * `ToolExecutor`, which is not built — see the report for this track. This
 * repository can say what tools exist and hand them to a turn; nothing here
 * runs one.
 */

import type { PlatformAdapter } from '@/platform/adapter';
import type {
  McpListToolsRes,
  McpServerTools,
  ToolDefinitionInput,
} from '@/platform/contract';

/**
 * A server the user configured that is not serving, paired with why.
 *
 * Separated out because it is a different UI: available tools go in a catalogue,
 * unavailable servers go in a list of things to fix. Deriving it here rather
 * than in a component means every surface that reports the problem reports the
 * same set.
 */
export interface McpUnavailableServer {
  readonly serverId: string;
  readonly reason: Extract<McpServerTools['status'], { kind: 'unavailable' }>['reason'];
}

export interface McpRepository {
  /** Every configured server, connected or not. Connects on first use. */
  listServers(): Promise<McpListToolsRes>;
  /**
   * The tools of every *connected* server, in the shape a turn takes.
   *
   * An unavailable server contributes nothing here — a tool that cannot be
   * called must not be offered to a model, because the model will call it and
   * the turn will fail on something the user could have been told about first.
   * {@link unavailableServers} is how it is told about.
   */
  toolCatalogue(): Promise<readonly ToolDefinitionInput[]>;
  /** The servers that contributed nothing, and the reason each did not. */
  unavailableServers(): Promise<readonly McpUnavailableServer[]>;
}

/**
 * A JSON Schema object is what a tool's arguments are described by, and a
 * backend that receives anything else — `null`, a string, an array — rejects the
 * whole request, taking every other tool in the catalogue down with it. A server
 * that sends one is not lying about a tool so much as failing to describe one,
 * so the tool is dropped rather than the request being risked.
 *
 * Exported for the test that pins it. It is a guard on somebody else's output,
 * and a guard nobody has watched reject anything is a claim.
 */
export function isSchemaObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The projection, shipped rather than described. See the header.
 *
 * `name` is already namespaced by the host — `mcp__<server>__<tool>` — because
 * that is where the server id is authoritative. This does not re-derive it: a
 * second implementation of a naming rule is a second answer to what a tool is
 * called.
 */
export function toolCatalogueOf(response: McpListToolsRes): readonly ToolDefinitionInput[] {
  return response.servers
    .filter((server) => server.status.kind === 'connected')
    .flatMap((server) => server.tools)
    .filter((tool) => isSchemaObject(tool.parameters))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
}

export function unavailableServersOf(
  response: McpListToolsRes,
): readonly McpUnavailableServer[] {
  return response.servers.flatMap((server) =>
    server.status.kind === 'unavailable'
      ? [{ serverId: server.serverId, reason: server.status.reason }]
      : [],
  );
}

export function createMcpRepository(adapter: PlatformAdapter): McpRepository {
  const list = (): Promise<McpListToolsRes> => adapter.invoke('mcp_list_tools', {});
  return {
    listServers: list,
    async toolCatalogue(): Promise<readonly ToolDefinitionInput[]> {
      return toolCatalogueOf(await list());
    },
    async unavailableServers(): Promise<readonly McpUnavailableServer[]> {
      return unavailableServersOf(await list());
    },
  };
}
