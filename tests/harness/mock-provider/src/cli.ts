/**
 * Standalone CLI for the mock provider.
 *
 *   node tests/harness/mock-provider/src/cli.ts --profile hostile --port 8033
 *
 * Node 22 strips TypeScript types natively, so there is no build step and no
 * runner dependency. Point curl, an OpenAI SDK, or a Vela dev build at the
 * printed URL.
 */

import { PROFILE_NAMES, isProfileName, type ProfileName } from './profiles.ts';
import { startMockProvider } from './server.ts';

const USAGE = `vela mock-provider — GATE M Part 1 capability-matrix harness

Usage:
  node tests/harness/mock-provider/src/cli.ts [options]

Options:
  --profile <name>    ${PROFILE_NAMES.join(' | ')}   (default: frontier)
  --port <n>          TCP port; 0 asks the OS for a free one   (default: 8080)
  --host <addr>       bind address                             (default: 127.0.0.1)
  --seed <n>          base seed for deterministic output       (default: 1447122753)
  --api-key <key>     require this bearer token. Omit for a NO-AUTH endpoint,
                      which is the common local case and the default.
  --chunk-delay <ms>  delay between SSE frames                 (default: 0)
  --help              this text

Endpoints: GET /health, GET /props, GET /v1/models, POST /v1/chat/completions
(the /v1 prefix is optional, as on llama.cpp).
`;

interface CliArgs {
  readonly profile: ProfileName;
  readonly port: number;
  readonly host: string;
  readonly seed: number | undefined;
  readonly apiKey: string | undefined;
  readonly chunkDelayMs: number;
}

export function parseArgs(argv: readonly string[]): CliArgs | 'help' {
  let profile: ProfileName = 'frontier';
  let port = 8080;
  let host = '127.0.0.1';
  let seed: number | undefined;
  let apiKey: string | undefined;
  let chunkDelayMs = 0;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--help':
      case '-h':
        return 'help';
      case '--profile':
        if (value === undefined || !isProfileName(value)) {
          throw new Error(`--profile must be one of: ${PROFILE_NAMES.join(', ')}`);
        }
        profile = value;
        i += 1;
        break;
      case '--port':
        port = requireInteger('--port', value);
        i += 1;
        break;
      case '--host':
        if (value === undefined) {
          throw new Error('--host requires a value');
        }
        host = value;
        i += 1;
        break;
      case '--seed':
        seed = requireInteger('--seed', value);
        i += 1;
        break;
      case '--api-key':
        if (value === undefined) {
          throw new Error('--api-key requires a value');
        }
        apiKey = value;
        i += 1;
        break;
      case '--chunk-delay':
        chunkDelayMs = requireInteger('--chunk-delay', value);
        i += 1;
        break;
      default:
        throw new Error(`unknown argument: ${String(flag)}`);
    }
  }
  return { profile, port, host, seed, apiKey, chunkDelayMs };
}

function requireInteger(flag: string, value: string | undefined): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} requires a non-negative integer`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args === 'help') {
    process.stdout.write(USAGE);
    return;
  }

  const handle = await startMockProvider({
    profile: args.profile,
    port: args.port,
    host: args.host,
    chunkDelayMs: args.chunkDelayMs,
    ...(args.seed === undefined ? {} : { seed: args.seed }),
    ...(args.apiKey === undefined ? {} : { apiKey: args.apiKey }),
  });

  const p = handle.profile;
  process.stdout.write(
    [
      `vela mock-provider listening on ${handle.url}`,
      `  profile            ${p.name}  (${p.displayName})`,
      `  model id           ${p.modelId}`,
      `  context window     ${String(p.contextWindow)} tokens`,
      `  tool calling       ${p.toolCalling}`,
      `  vision             ${p.vision ? 'yes' : 'no — image parts are rejected with 400'}`,
      `  structured output  ${p.structuredOutput}`,
      `  reasoning          ${p.reasoning}`,
      `  [DONE] sentinel    ${p.emitDoneSentinel ? 'yes' : 'NO — the stream just stops'}`,
      `  malformed frames   ${p.emitMalformedSseFrames ? 'YES' : 'no'}`,
      `  auth               ${args.apiKey === undefined ? 'none (valid, first-class state)' : 'bearer token required'}`,
      '',
      'This is a MOCK. Nothing it returns is evidence about any real model.',
      'Ctrl-C to stop.',
      '',
    ].join('\n'),
  );

  const shutdown = (): void => {
    void handle.close().then(() => {
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run only when invoked directly, so the module stays importable by tests.
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/gu, '/'))) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
