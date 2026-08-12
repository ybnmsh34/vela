/**
 * The isolation guard.
 *
 * This harness is test infrastructure. It must never appear in the app's module
 * graph — not in the renderer, not in the Rust core, not transitively. And it
 * must stay dependency-free, because a test double that drags in third-party
 * code can fail for reasons that have nothing to do with the thing under test.
 *
 * Both directions are checked here, mirroring `src/platform/adapter.test.ts`,
 * which does the same job for the Tauri seam.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const harnessRoot = fileURLToPath(new URL('./', import.meta.url));

function filesUnder(root: string, extensions: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'target' || entry === 'dist' || entry === 'gen') {
        continue;
      }
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (extensions.some((ext) => entry.endsWith(ext))) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/** Strips `//` and block comments so a mention in prose is not a false positive. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');
}

describe('the harness is not reachable from app code', () => {
  it('is imported by nothing under src/', () => {
    const offenders = filesUnder(join(repoRoot, 'src'), ['.ts', '.tsx'])
      .filter((file) => /tests\/harness|mock-provider/u.test(stripComments(readFileSync(file, 'utf8'))))
      .map((file) => file.slice(repoRoot.length));

    expect(offenders).toEqual([]);
  });

  it('is referenced by nothing in the Rust core', () => {
    const offenders = filesUnder(join(repoRoot, 'src-tauri'), ['.rs'])
      .filter((file) => /tests\/harness|mock-provider/u.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(repoRoot.length));

    expect(offenders).toEqual([]);
  });

  it('is excluded from the app TypeScript project, so it cannot be bundled', () => {
    const appConfig = readFileSync(join(repoRoot, 'tsconfig.app.json'), 'utf8');
    expect(appConfig).toContain('"include": ["src"]');
    expect(appConfig).not.toContain('tests');
  });
});

describe('the harness depends on nothing but node and vitest', () => {
  it('imports only node builtins, relative paths, and vitest in tests', () => {
    const imports = new Set<string>();
    for (const file of filesUnder(harnessRoot, ['.ts'])) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const match of source.matchAll(/from\s+'([^']+)'/gu)) {
        const specifier = match[1];
        if (specifier !== undefined) {
          imports.add(specifier);
        }
      }
    }

    const foreign = [...imports].filter(
      (specifier) =>
        !specifier.startsWith('.') &&
        !specifier.startsWith('node:') &&
        specifier !== 'vitest' &&
        specifier !== 'vitest/config',
    );
    expect(foreign).toEqual([]);
  });

  it('pulled no HTTP or mocking library into the app package', () => {
    // The obvious way to build this harness is `express` + `msw` + `node-fetch`.
    // It is built on node:http and global fetch instead, so the shipped app
    // gains nothing from it — in either dependency block.
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const installed = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    const serverOrMockLibraries = [
      'express', 'fastify', 'koa', 'hapi', 'msw', 'nock', 'node-fetch',
      'undici', 'axios', 'got', 'supertest', 'eventsource', 'ws',
    ];
    expect(installed.filter((name) => serverOrMockLibraries.includes(name))).toEqual([]);
  });
});
