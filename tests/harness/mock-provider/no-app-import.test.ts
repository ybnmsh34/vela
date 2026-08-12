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

/**
 * Removes `#[cfg(test)] mod … { … }` bodies, brace-balanced.
 *
 * Phase B gave the provider crates unit tests that assert against the exact JSON
 * shapes the harness serves. Those live in-file per the Rust conventions, so a
 * whole-file grep cannot tell "shipping code reaches for the harness" — the thing
 * this guard exists to forbid — from "a test names the fixture it replays".
 * Only the code outside these blocks is part of the app's module graph.
 */
function stripRustTestModules(source: string): string {
  const marker = /#\[cfg\(test\)\]/gu;
  let out = '';
  let cursor = 0;
  for (const match of source.matchAll(marker)) {
    const start = match.index;
    if (start === undefined || start < cursor) continue;
    const open = source.indexOf('{', start);
    if (open === -1) continue;
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end === -1) break;
    out += source.slice(cursor, start);
    cursor = end;
  }
  return out + source.slice(cursor);
}

describe('the harness is not reachable from app code', () => {
  it('is imported by nothing under src/', () => {
    const offenders = filesUnder(join(repoRoot, 'src'), ['.ts', '.tsx'])
      .filter((file) => /tests\/harness|mock-provider/u.test(stripComments(readFileSync(file, 'utf8'))))
      .map((file) => file.slice(repoRoot.length));

    expect(offenders).toEqual([]);
  });

  it('is referenced by nothing that ships in the Rust core', () => {
    // Rust integration tests (`crates/*/tests/`, `src-tauri/tests/`) are test
    // infrastructure, exactly like this harness, and Phase B drives the harness
    // from two of them over real TCP — that is why the CI Rust job installs
    // Node 22. They are excluded here for the same reason `#[cfg(test)]` bodies
    // are. What stays in scope is every line that compiles into the shipped
    // binary; a `mock-provider` reference there is still a hard failure.
    const offenders = filesUnder(join(repoRoot, 'src-tauri'), ['.rs'])
      .filter((file) => !/[/\\]tests[/\\]/u.test(file.slice(repoRoot.length)))
      .filter((file) =>
        /tests\/harness|mock-provider/u.test(
          stripRustTestModules(stripComments(readFileSync(file, 'utf8'))),
        ),
      )
      .map((file) => file.slice(repoRoot.length));

    expect(offenders).toEqual([]);
  });

  it('the Rust guard still catches a reference in shipping code', () => {
    // A guard that was narrowed is a guard worth re-proving. These are the two
    // shapes the narrowing must NOT have let through.
    expect(
      stripRustTestModules(stripComments('fn spawn() { run("tests/harness/mock-provider"); }')),
    ).toMatch(/tests\/harness/u);
    expect(
      stripRustTestModules(
        'pub fn ship() { let _ = "mock-provider"; }\n#[cfg(test)]\nmod tests { const X: &str = "mock-provider"; }\n',
      ),
    ).toMatch(/mock-provider/u);
    // …and the shape it must swallow: the mention exists only inside the tests.
    expect(
      stripRustTestModules(
        'pub fn ship() {}\n#[cfg(test)]\nmod tests {\n  fn f() { if true { } }\n  const X: &str = "mock-provider";\n}\n',
      ),
    ).not.toMatch(/mock-provider/u);
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
