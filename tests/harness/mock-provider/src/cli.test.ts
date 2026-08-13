import { describe, expect, it } from 'vitest';

import { parseArgs } from './cli.ts';

describe('the CLI', () => {
  it('defaults to the frontier profile on a fixed port', () => {
    expect(parseArgs([])).toEqual({
      profile: 'frontier',
      port: 8080,
      host: '127.0.0.1',
      seed: undefined,
      apiKey: undefined,
      chunkDelayMs: 0,
      recordRequests: undefined,
    });
  });

  it('defaults to NO api key, because most local endpoints have none', () => {
    const args = parseArgs(['--profile', 'small-local']);
    expect(args).not.toBe('help');
    if (args !== 'help') {
      expect(args.apiKey).toBeUndefined();
    }
  });

  it('parses every flag', () => {
    expect(
      parseArgs([
        '--profile', 'hostile',
        '--port', '0',
        '--host', '0.0.0.0',
        '--seed', '77',
        '--api-key', 'sk-abc',
        '--chunk-delay', '5',
        '--record-requests', '/tmp/requests.jsonl',
      ]),
    ).toEqual({
      profile: 'hostile',
      port: 0,
      host: '0.0.0.0',
      seed: 77,
      apiKey: 'sk-abc',
      chunkDelayMs: 5,
      recordRequests: '/tmp/requests.jsonl',
    });
  });

  it('refuses --record-requests with no path, rather than recording to nowhere', () => {
    expect(() => parseArgs(['--record-requests'])).toThrow(/requires a path/u);
  });

  it('reports help instead of starting', () => {
    expect(parseArgs(['--help'])).toBe('help');
    expect(parseArgs(['-h'])).toBe('help');
  });

  it('refuses a profile outside the matrix', () => {
    expect(() => parseArgs(['--profile', 'gpt-5'])).toThrow(/--profile must be one of/u);
  });

  it('refuses a malformed number rather than silently using a default', () => {
    expect(() => parseArgs(['--port', 'eighty'])).toThrow(/non-negative integer/u);
    expect(() => parseArgs(['--seed', '-1'])).toThrow(/non-negative integer/u);
  });

  it('refuses an unknown flag', () => {
    expect(() => parseArgs(['--turbo'])).toThrow(/unknown argument/u);
  });
});
