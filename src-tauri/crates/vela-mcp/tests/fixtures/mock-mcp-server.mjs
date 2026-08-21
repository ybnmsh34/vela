#!/usr/bin/env node
// A real stdio MCP server, in the shape the ecosystem actually ships them:
// a script launched as a child process that reads newline-delimited JSON-RPC
// from stdin and writes it to stdout.
//
// It is a fixture, not a product, but the *transport* it speaks is not
// simulated in any way: the tests that drive it spawn a real OS process, hand
// it a real pipe, and read real bytes back. That is the whole point — a mocked
// transport would prove nothing about framing, buffering, process death, or
// environment isolation, which are exactly the parts that are hard.
//
// Tools it exposes, each existing to make one client behaviour testable:
//   add            — an ordinary tool call with structured arguments
//   echo_env       — returns one environment variable, so a test can prove the
//                    child did NOT inherit the parent's environment
//   list_calls     — how many `tools/list` requests this process has served, so
//                    a test can prove the client cached instead of refetching
//   whoami         — this process's pid, so a test can prove the pool reused a
//                    connection rather than spawning a second server
//   grow           — mutates the tool set and sends
//                    `notifications/tools/list_changed`, so a test can prove the
//                    cache is invalidated by the notification
//   die            — exits the process without answering, so a test can prove an
//                    in-flight request fails instead of hanging forever
//   hang           — stays alive and never answers, so a test can prove a
//                    request deadline expires and says whose silence it was
//
// It deliberately writes a line to stderr at startup. The stdio transport spec
// says a client MUST NOT treat stderr output as an error, and a fixture that was
// silent there would let a client that does so pass.

import process from 'node:process';

process.stderr.write('mock-mcp-server: ready (this is a log line, not an error)\n');

let listCalls = 0;
let grown = false;

const baseTools = [
  {
    name: 'add',
    title: 'Add two numbers',
    description: 'Adds a and b.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
  {
    name: 'echo_env',
    description: 'Returns the value of one environment variable, or the string "<unset>".',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'list_calls',
    description: 'How many tools/list requests this process has served.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'whoami',
    description: 'This server process id.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'grow',
    description: 'Adds a tool and announces it with notifications/tools/list_changed.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'die',
    description: 'Exits immediately without answering.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'hang',
    description: 'Stays alive and never answers.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const grownTool = {
  name: 'grown_tool',
  description: 'Only exists after grow has been called.',
  inputSchema: { type: 'object', properties: {} },
};

function currentTools() {
  return grown ? [...baseTools, grownTool] : baseTools;
}

function send(message) {
  // One message per line, and the JSON encoder never emits a raw newline, so
  // the framing rule holds by construction.
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function text(value) {
  return { content: [{ type: 'text', text: String(value) }] };
}

function callTool(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  switch (name) {
    case 'add':
      return reply(id, text(Number(args.a) + Number(args.b)));
    case 'echo_env':
      return reply(id, text(process.env[String(args.name)] ?? '<unset>'));
    case 'list_calls':
      return reply(id, text(listCalls));
    case 'whoami':
      return reply(id, text(process.pid));
    case 'grow': {
      grown = true;
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      return reply(id, text('grown'));
    }
    case 'die':
      // No response, no flush, no goodbye — the shape a crashing server has.
      process.exit(3);
      return undefined;
    case 'hang':
      // Alive, reading, and silent — the shape a wedged server has, and the one
      // `die` does not cover: end-of-file never arrives, so only the client's
      // own deadline ends the wait.
      return undefined;
    default:
      // A tool that fails is a result with isError, not a JSON-RPC error: the
      // model is supposed to be able to read it and try something else.
      return reply(id, { ...text(`no such tool: ${name}`), isError: true });
  }
}

function handle(message) {
  const { id, method, params } = message;
  if (id === undefined) return; // a notification; nothing is owed
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'mock-mcp-server', version: '0.1.0' },
      });
    case 'tools/list':
      listCalls += 1;
      return reply(id, {
        tools: currentTools(),
        // The caching hint a modern server is required to send. The client
        // reads it; a client that ignored it would refetch on every access.
        _meta: { 'io.modelcontextprotocol/ttlMs': 60_000 },
      });
    case 'tools/call':
      return callTool(id, params);
    default:
      return replyError(id, -32601, `method not found: ${method}`);
  }
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline === -1) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line === '') continue;
    try {
      handle(JSON.parse(line));
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
  }
});

// Closing stdin is the primary graceful-shutdown signal and the only portable
// one, so exiting on EOF is not optional politeness — a server that ignored it
// would have to be killed by every client that ever ran it.
process.stdin.on('end', () => process.exit(0));
