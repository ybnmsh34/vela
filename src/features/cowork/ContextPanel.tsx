/**
 * CONTEXT — the tool servers this machine can reach, and what they offer a run.
 *
 * ## Why an unavailable server is listed rather than hidden
 *
 * `src/data/mcp-repository.ts` separates the two on purpose: "available tools go
 * in a catalogue, unavailable servers go in a list of things to fix". A server
 * the user configured that is not serving is not absent — it is broken, and a
 * panel that showed only what worked would answer "no connectors" to a user with
 * three of them misconfigured.
 *
 * The same file gives the reason an unavailable server contributes no tools: "a
 * tool that cannot be called must not be offered to a model, because the model
 * will call it and the turn will fail on something the user could have been told
 * about first." This panel is the telling.
 *
 * ## `configFailure` is its own row
 *
 * `McpListToolsRes.configFailure` means the configuration itself could not be
 * read — a different fact from any single server's, with a different repair.
 * Folding it into the server list would report a failure against servers that
 * were never named.
 *
 * ## What this panel does not claim
 *
 * That any of these tools can be *run*. `mcp-repository.ts` is explicit: "It does
 * not execute anything. Calling a tool is the harness contract's `ToolExecutor`,
 * which is not built." So the wording here is what a run would be *offered*,
 * never what it can do.
 */

import type { McpFailureReason } from '@/platform/contract';

import styles from './CoworkPanel.module.css';
import type { ConnectorsController } from './use-connectors';

/** Vela's words for the host's closed failure vocabulary. */
function failureText(reason: McpFailureReason): string {
  switch (reason) {
    case 'notConfigured':
      return 'No configuration for this server.';
    case 'configUnreadable':
      return 'The configuration file could not be read.';
    case 'configInvalid':
      return 'The configuration is not valid.';
    case 'transportNotSupported':
      return 'Vela does not support the transport this server asks for.';
    case 'spawnFailed':
      return 'The server process would not start.';
    case 'handshakeFailed':
      return 'The server started and would not complete the MCP handshake.';
    case 'serverExited':
      return 'The server exited.';
    case 'protocolError':
      return 'The server sent something Vela could not parse.';
    case 'timedOut':
      return 'The server did not answer in time.';
    case 'serverError':
      return 'The server reported an error.';
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

export function ContextPanel({ connectors }: { readonly connectors: ConnectorsController }) {
  const state = connectors.state;

  if (state.status === 'loading') {
    return (
      <p className={styles.note} data-testid="cowork-context-loading">
        Asking the host which tool servers are reachable…
      </p>
    );
  }

  if (state.status === 'error') {
    return (
      <p className={styles.error} role="status" data-testid="cowork-context-error">
        {`Tool servers could not be listed · ${state.code} · ${state.message}`}
      </p>
    );
  }

  const { servers, connected, unavailable, tools, configFailure } = state.connectors;

  return (
    <>
      <p className={styles.intro} data-testid="cowork-context-summary">
        {`${connected.length} of ${servers.length} servers connected · ${tools.length} tools a run could be offered`}
      </p>

      {configFailure !== null && (
        <p className={styles.error} role="status" data-testid="cowork-config-failure">
          {`Connector configuration · ${failureText(configFailure)}`}
        </p>
      )}

      {servers.length === 0 && configFailure === null && (
        <p className={styles.note} data-testid="cowork-context-empty">
          No tool servers are configured. A run in this project is offered Vela’s
          own tools only.
        </p>
      )}

      <ul className={styles.rows}>
        {servers.map((server) => (
          <li
            className={styles.row}
            key={server.serverId}
            data-testid={`cowork-server-${server.serverId}`}
            data-status={server.status.kind}
          >
            <span className={styles.rowHead}>
              <span className={styles.rowName}>{server.serverId}</span>
              <span
                className={`${styles.badge} ${
                  server.status.kind === 'connected' ? styles.badgeOk : styles.badgeBad
                }`}
              >
                {server.status.kind === 'connected'
                  ? `${server.tools.length} tool${server.tools.length === 1 ? '' : 's'}`
                  : 'Unavailable'}
              </span>
            </span>

            {server.status.kind === 'unavailable' && (
              <p className={styles.note}>{failureText(server.status.reason)}</p>
            )}

            {server.status.kind === 'connected' && server.tools.length > 0 && (
              <ul className={styles.tools}>
                {server.tools.map((tool) => (
                  // The server's own name for the tool, not the namespaced one:
                  // `mcp__<server>__<tool>` is what a model is sent, and the
                  // server id is already the row's heading.
                  <li className={styles.tool} key={tool.name}>
                    {tool.toolName}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>

      {unavailable.length > 0 && (
        <p className={styles.footnote} data-testid="cowork-unavailable-count">
          {`${unavailable.length} configured server${
            unavailable.length === 1 ? '' : 's'
          } contributed no tools. A run is not offered them — a tool that cannot be called must not be put in front of a model.`}
        </p>
      )}

      <span className={styles.commentActions}>
        <button type="button" className={styles.button} onClick={connectors.reload}>
          Check again
        </button>
      </span>
    </>
  );
}
