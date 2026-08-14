/**
 * **VERIFIED-BY-FAKE.** Every row here is driven through {@link BrowserAdapter},
 * so what is checked is the projection from a command response into a turn's
 * tool catalogue — not that any MCP server exists. The evidence that a real
 * server process answers over a real pipe is in Rust:
 * `src-tauri/crates/vela-mcp/tests/stdio_end_to_end.rs`, and the command that
 * carries it is covered by `the_command_returns_tools_from_a_real_server_process`
 * in `src-tauri/src/ipc/mcp.rs`.
 *
 * The split is the point. The transport can only be told the truth about by a
 * real process; the shape the renderer consumes can only be told the truth about
 * on this side of the boundary.
 */

import { describe, expect, it } from 'vitest';

import { BrowserAdapter } from '@/platform/browser-adapter';
import type { McpListToolsRes } from '@/platform/contract';

import {
  createMcpRepository,
  isSchemaObject,
  toolCatalogueOf,
  unavailableServersOf,
} from './mcp-repository';

const MIXED: McpListToolsRes = {
  configFailure: null,
  servers: [
    {
      serverId: 'files',
      status: { kind: 'connected' },
      tools: [
        {
          name: 'mcp__files__search',
          toolName: 'search',
          description: 'Search the indexed files.',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        },
        {
          name: 'mcp__files__broken',
          toolName: 'broken',
          description: 'Describes its arguments with a string.',
          parameters: 'not a schema',
        },
      ],
    },
    {
      serverId: 'web',
      status: { kind: 'connected' },
      tools: [
        {
          name: 'mcp__web__search',
          toolName: 'search',
          description: 'Search the web.',
          parameters: { type: 'object' },
        },
      ],
    },
    { serverId: 'remote', status: { kind: 'unavailable', reason: 'transportNotSupported' }, tools: [] },
    { serverId: 'gone', status: { kind: 'unavailable', reason: 'serverExited' }, tools: [] },
  ],
};

describe('the MCP tool catalogue a turn is offered', () => {
  it('carries every connected server tool in the shape chat_send takes', async () => {
    const repository = createMcpRepository(new BrowserAdapter({ mcp: MIXED }));
    const catalogue = await repository.toolCatalogue();

    expect(catalogue.map((tool) => tool.name)).toEqual([
      'mcp__files__search',
      'mcp__web__search',
    ]);
    expect(catalogue[0]).toEqual({
      name: 'mcp__files__search',
      description: 'Search the indexed files.',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
    });
  });

  it('keeps two servers that expose the same tool name apart', async () => {
    // The collision the namespace exists for. Both servers call it `search`;
    // a catalogue with two entries called `search` is a catalogue in which one
    // of them can never be reached.
    const repository = createMcpRepository(new BrowserAdapter({ mcp: MIXED }));
    const names = (await repository.toolCatalogue()).map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('offers nothing from a server that is not connected', async () => {
    // Offering a tool that cannot be called means the model calls it and the
    // turn fails on something the user could have been shown first.
    const repository = createMcpRepository(new BrowserAdapter({ mcp: MIXED }));
    const catalogue = await repository.toolCatalogue();
    expect(catalogue.some((tool) => tool.name.includes('remote'))).toBe(false);
    expect(catalogue.some((tool) => tool.name.includes('gone'))).toBe(false);
  });

  it('drops a tool whose schema is not an object rather than risking the request', () => {
    const catalogue = toolCatalogueOf(MIXED);
    expect(catalogue.some((tool) => tool.name === 'mcp__files__broken')).toBe(false);
    expect(isSchemaObject({ type: 'object' })).toBe(true);
    expect(isSchemaObject(null)).toBe(false);
    expect(isSchemaObject([])).toBe(false);
    expect(isSchemaObject('not a schema')).toBe(false);
  });

  it('reports every unavailable server with its reason', async () => {
    const repository = createMcpRepository(new BrowserAdapter({ mcp: MIXED }));
    expect(await repository.unavailableServers()).toEqual([
      { serverId: 'remote', reason: 'transportNotSupported' },
      { serverId: 'gone', reason: 'serverExited' },
    ]);
  });

  it('an unavailable server never disappears from the server list', async () => {
    // Conventions §9: a reduction the user cannot see is the forbidden outcome.
    // A remote entry this build cannot speak to is exactly that risk — the
    // user's file is correct and the client is incomplete.
    const repository = createMcpRepository(new BrowserAdapter({ mcp: MIXED }));
    const listed = await repository.listServers();
    expect(listed.servers.map((server) => server.serverId)).toContain('remote');
  });

  it('a machine with no MCP configuration is an empty catalogue and not a failure', async () => {
    const repository = createMcpRepository(new BrowserAdapter());
    const listed = await repository.listServers();
    expect(listed.configFailure).toBeNull();
    expect(listed.servers).toEqual([]);
    expect(await repository.toolCatalogue()).toEqual([]);
    expect(await repository.unavailableServers()).toEqual([]);
  });

  it('an unreadable configuration file is reported without losing the call', async () => {
    const broken: McpListToolsRes = { configFailure: 'configUnreadable', servers: [] };
    const repository = createMcpRepository(new BrowserAdapter({ mcp: broken }));
    await expect(repository.listServers()).resolves.toEqual(broken);
    expect(unavailableServersOf(broken)).toEqual([]);
  });
});
