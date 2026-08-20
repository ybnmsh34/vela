/**
 * The MCP pane: what it shows, and the two rows it must never hide.
 *
 * The states here are the ones the assembled-application test in
 * `src/app/mcp-reachable.test.tsx` cannot reach cheaply — the read still in
 * flight, the read that refused, a server that is connected and offers nothing,
 * a tool the server described with no words. They are driven through an injected
 * {@link McpController}, which is what that prop is for.
 *
 * The load-bearing behaviour — a withheld tool and a server that is not serving
 * both stay on screen with a sentence saying why — is asserted **there** rather
 * than here, and deliberately. A pane test passes whether or not anything in the
 * application mounts the pane, and the defect this whole slice exists for was a
 * repository nothing mounted.
 *
 * **Honesty (conventions §10):** VERIFIED-BY-FAKE where a host answers at all.
 * Nothing here starts an MCP server. The evidence that a real server process
 * answers over a real pipe is in Rust:
 * `src-tauri/crates/vela-mcp/tests/stdio_end_to_end.rs`, and the command
 * carrying it is covered by
 * `the_command_returns_tools_from_a_real_server_process` in
 * `src-tauri/src/ipc/mcp.rs`.
 */

import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { BrowserAdapter } from '@/platform/browser-adapter';
import { PlatformProvider } from '@/platform/PlatformProvider';
import { resetMcpStore } from '@/state/mcp-store';

import { McpPanel } from './McpPanel';
import type { McpController, McpState } from './use-mcp';

/**
 * `McpPanel` calls `useMcp()` unconditionally — hooks may not be skipped — and
 * discards it when a controller is supplied, so the provider is still required
 * even though nothing below reads the adapter's answer.
 */
function mount(state: McpState) {
  const controller: McpController = { state };
  return render(
    <PlatformProvider adapter={new BrowserAdapter()}>
      <McpPanel onClose={() => undefined} controller={controller} />
    </PlatformProvider>,
  );
}

beforeEach(() => {
  resetMcpStore();
});

describe('the MCP servers pane', () => {
  it('says it is asking rather than showing an empty list', () => {
    // Connecting means spawning a process and waiting for a handshake, which can
    // take as long as a process takes to start. An empty list in the meantime is
    // a claim that there is nothing there.
    mount({ status: 'loading' });

    expect(screen.getByTestId('mcp-loading')).toBeInTheDocument();
    expect(screen.queryByText(/No MCP servers are configured/u)).toBeNull();
  });

  it('keeps a refusal apart from an empty machine', () => {
    // The distinction `use-mcp.ts` is written around: a machine with no servers
    // and a command that refused look identical drawn as an empty list, and one
    // of them is a lie.
    mount({ status: 'error', code: 'HOST_UNAVAILABLE', message: 'no host' });

    expect(screen.getByRole('status')).toHaveTextContent(
      'MCP servers unavailable · HOST_UNAVAILABLE',
    );
    expect(screen.queryByText(/No MCP servers are configured/u)).toBeNull();
  });

  it('distinguishes a server that offers no tools from one that is not serving', () => {
    // A live server with an empty tool list is a healthy state and must not be
    // drawn as a failure — it belongs under Tools with a sentence, not under
    // Not serving.
    mount({
      status: 'ready',
      survey: {
        configFailure: null,
        servers: [{ serverId: 'quiet', status: { kind: 'connected' }, tools: [] }],
        unavailable: [],
        offered: new Set<string>(),
      },
    });

    expect(screen.getByText('quiet')).toBeInTheDocument();
    expect(screen.getByText('This server is connected and offers no tools.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Servers that are not serving' })).toBeNull();
    expect(screen.getByText(/0 would be offered to a turn/u)).toBeInTheDocument();
  });

  it('words a tool the server described with nothing at all', () => {
    // `McpToolView.description` is empty rather than absent when the server
    // described nothing — `ipc/mcp.rs` says a missing description is a tool with
    // no explanation, not a tool that is absent. An empty string drawn verbatim
    // is a row with a blank line under its name.
    mount({
      status: 'ready',
      survey: {
        configFailure: null,
        servers: [
          {
            serverId: 'terse',
            status: { kind: 'connected' },
            tools: [
              {
                name: 'mcp__terse__go',
                toolName: 'go',
                description: '',
                parameters: { type: 'object' },
              },
            ],
          },
        ],
        unavailable: [],
        offered: new Set(['mcp__terse__go']),
      },
    });

    const tools = screen.getByRole('list', { name: 'Tools from terse' });
    expect(within(tools).getByText('mcp__terse__go')).toBeInTheDocument();
    expect(tools).toHaveTextContent('This server gave no description for it.');
    expect(tools).not.toHaveTextContent(/Withheld/u);
  });

  it('words every failure reason rather than printing its wire token', () => {
    // `REASON_LABELS` is a total map so the compiler asks for a sentence when a
    // reason is added on this side. This is the other half: that the sentence,
    // and not the token, is what reaches the screen. A pane that printed
    // `spawnFailed` would be showing the user somebody else's vocabulary.
    mount({
      status: 'ready',
      survey: {
        configFailure: null,
        servers: [
          { serverId: 'gone', status: { kind: 'unavailable', reason: 'serverExited' }, tools: [] },
          { serverId: 'missing', status: { kind: 'unavailable', reason: 'spawnFailed' }, tools: [] },
        ],
        unavailable: [
          { serverId: 'gone', reason: 'serverExited' },
          { serverId: 'missing', reason: 'spawnFailed' },
        ],
        offered: new Set<string>(),
      },
    });

    const list = screen.getByRole('list', { name: 'Servers that are not serving' });
    expect(list).toHaveTextContent('The process is no longer running.');
    expect(list).toHaveTextContent('The command could not be started');
    expect(list).not.toHaveTextContent('serverExited');
    expect(list).not.toHaveTextContent('spawnFailed');
  });

  it('says out loud that Vela cannot call any of these tools', () => {
    // The sentence that keeps the pane honest. This build has no command that
    // dispatches an MCP tool call, so a pane that listed tools with no such note
    // would be describing an affordance that does not exist — the failure
    // `SkillsPanel.tsx` avoids with its own footnote, for the same reason.
    mount({
      status: 'ready',
      survey: { configFailure: null, servers: [], unavailable: [], offered: new Set<string>() },
    });

    expect(screen.getByText(/It cannot call one yet/u)).toBeInTheDocument();
  });
});
