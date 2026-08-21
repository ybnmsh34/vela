/**
 * The context panel, driven state by state.
 *
 * `CoworkPanel.test.tsx` proves the panel is wired to the host: it drives the
 * dock through `BrowserAdapter` and watches `mcp_list_tools` cross the seam.
 * What that cannot reach is the rest of `ConnectorsState`. The fake host answers
 * one way, so failure, an empty configuration and an unreadable one are states
 * the dock can be in that no test had ever put it in — and the loading state,
 * which those tests pass through on the way to an answer, none of them ever
 * asserts a word of.
 *
 * The panel takes a `ConnectorsController` — `{ state, reload }` and nothing
 * else — so each of them is a value here, not a scenario. That is the reason
 * `use-connectors.ts` hands the panel a controller instead of the panel calling
 * the host itself.
 *
 * ## WHY THIS FILE EXISTS AT ALL: the writes had no reader
 *
 * Round 4's critic found `ContextPanel.tsx` shipping two attributes on one
 * element that nothing anywhere read — `data-testid="cowork-server-…"` and
 * `data-status` — and five more `data-testid`s with no reader: the loading
 * line, the error line, the config-failure line, the empty-configuration line
 * and the unavailable count. No stylesheet rule, no selector, no test.
 * `CoworkPanel.module.css` keys nothing on a `data-*` attribute at all — its
 * only attribute selectors are `[aria-selected='true']` and
 * `[aria-current='page']`, written twice each, the second pair inside the
 * forced-colors block — so an attribute this panel writes is read by a test or
 * by nothing. That is the defect `ProgressPanel.tsx`'s header declares this
 * feature exists to stop shipping, sitting inside the feature that declares it.
 *
 * There were two honest repairs: delete the attributes, or write the tests that
 * read them. Deleting would also have deleted the only handle on states a user
 * genuinely meets — a server that will not start is the *normal* reason to open
 * this panel — so the tests are here, and every attribute this panel writes is
 * read below by an assertion that would go red if its value changed.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { McpFailureReason, McpServerTools } from '@/platform/contract';

import { ContextPanel } from './ContextPanel';
import type { Connectors, ConnectorsController, ConnectorsState } from './use-connectors';

function connected(serverId: string, tools: readonly string[]): McpServerTools {
  return {
    serverId,
    status: { kind: 'connected' },
    tools: tools.map((toolName) => ({
      name: `mcp__${serverId}__${toolName}`,
      toolName,
      description: '',
      parameters: { type: 'object' },
    })),
  };
}

function unavailable(serverId: string, reason: McpFailureReason): McpServerTools {
  return { serverId, status: { kind: 'unavailable', reason }, tools: [] };
}

/**
 * The projection `use-connectors.ts` makes over one `mcp_list_tools` response,
 * rebuilt here from the same servers.
 *
 * Derived rather than passed in, so a fixture cannot describe a panel state the
 * hook could not produce — two connected servers and an unavailable count of
 * nine, say, which would let the assertions below pass against nothing real.
 */
function ready(
  servers: readonly McpServerTools[],
  configFailure: McpFailureReason | null = null,
): ConnectorsState {
  const value: Connectors = {
    servers,
    connected: servers.filter((server) => server.status.kind === 'connected'),
    unavailable: servers.flatMap((server) =>
      server.status.kind === 'unavailable'
        ? [{ serverId: server.serverId, reason: server.status.reason }]
        : [],
    ),
    tools: servers.flatMap((server) =>
      server.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    ),
    configFailure,
  };
  return { status: 'ready', connectors: value };
}

function show(state: ConnectorsState, reload: () => void = () => undefined) {
  const controller: ConnectorsController = { state, reload };
  return render(<ContextPanel connectors={controller} />);
}

describe('the context panel before it has an answer', () => {
  it('says it is asking rather than saying there is nothing', () => {
    show({ status: 'loading' });

    // The distinction the state machine is for: "not yet" must not be drawn as
    // "none", which is what an empty list would have said.
    expect(screen.getByTestId('cowork-context-loading')).toHaveTextContent(
      'Asking the host which tool servers are reachable',
    );
    expect(screen.queryByTestId('cowork-context-empty')).toBeNull();
  });

  it('carries the host’s own code and message when the read fails', () => {
    show({ status: 'error', code: 'IPC_FAILED', message: 'the bridge went away' });

    const error = screen.getByTestId('cowork-context-error');
    expect(error).toHaveTextContent('Tool servers could not be listed');
    // Both halves, because a failure a user cannot name is a failure they cannot
    // report. The code is the part that survives being retold.
    expect(error).toHaveTextContent('IPC_FAILED');
    expect(error).toHaveTextContent('the bridge went away');
    expect(error).toHaveAttribute('role', 'status');
  });
});

describe('the context panel with an answer', () => {
  it('keeps a server that would not start, and says which one it is', () => {
    show(
      ready([connected('files', ['read_file', 'write_file']), unavailable('search', 'spawnFailed')]),
    );

    const broken = screen.getByTestId('cowork-server-search');
    // The attribute is the row's state, and these two rows differ by it — so it
    // is read here rather than written and forgotten.
    expect(broken).toHaveAttribute('data-status', 'unavailable');
    expect(broken).toHaveTextContent('The server process would not start.');
    expect(within(broken).getByText('Unavailable')).toBeVisible();

    const working = screen.getByTestId('cowork-server-files');
    expect(working).toHaveAttribute('data-status', 'connected');
    expect(within(working).getByText('2 tools')).toBeVisible();
    // The server's own name for the tool, not the `mcp__files__read_file` a
    // model is addressed with.
    expect(within(working).getByText('read_file')).toBeVisible();
    expect(within(working).queryByText('mcp__files__read_file')).toBeNull();

    expect(screen.getByTestId('cowork-context-summary')).toHaveTextContent(
      '1 of 2 servers connected · 2 tools a run could be offered',
    );
    expect(screen.getByTestId('cowork-unavailable-count')).toHaveTextContent(
      '1 configured server contributed no tools',
    );
  });

  it('counts the unreachable servers in the plural when there are two', () => {
    show(ready([unavailable('search', 'timedOut'), unavailable('mail', 'handshakeFailed')]));

    expect(screen.getByTestId('cowork-unavailable-count')).toHaveTextContent(
      '2 configured servers contributed no tools',
    );
    expect(screen.getByTestId('cowork-server-mail')).toHaveTextContent(
      'The server started and would not complete the MCP handshake.',
    );
  });

  it('says a machine with no servers is offered Vela’s own tools, not nothing', () => {
    show(ready([]));

    expect(screen.getByTestId('cowork-context-empty')).toHaveTextContent(
      'No tool servers are configured',
    );
    // Nothing failed, so nothing is drawn as a failure.
    expect(screen.queryByTestId('cowork-config-failure')).toBeNull();
    expect(screen.queryByTestId('cowork-unavailable-count')).toBeNull();
  });

  it('reports an unreadable configuration on its own row, against no server', () => {
    show(ready([], 'configUnreadable'));

    expect(screen.getByTestId('cowork-config-failure')).toHaveTextContent(
      'Connector configuration · The configuration file could not be read.',
    );
    // And not as "no tool servers are configured": the panel cannot know that,
    // and saying it would answer a question the host had refused to answer.
    expect(screen.queryByTestId('cowork-context-empty')).toBeNull();
  });

  it('asks the host again when the user presses the button', async () => {
    const user = userEvent.setup({ delay: null });
    const reload = vi.fn();
    show(ready([connected('files', [])]), reload);

    await user.click(screen.getByRole('button', { name: 'Check again' }));

    expect(reload).toHaveBeenCalledTimes(1);
  });
});
