/**
 * **This directory has to be reachable from the application.**
 *
 * The defect this guard exists for is not behavioural and no behavioural test
 * can catch it. `src/runtime/` shipped once with a registry, a live-run
 * directory with replay, an agent loop that executes tool calls and feeds them
 * back, and real parallel subagents — every module correct, every module tested,
 * and **three importers, all of them its own tests**. Nothing under `src/app`,
 * `src/features`, `src/components`, `src/state` or `src/main.tsx` named it. A
 * reviewer found that by tracing every importer by hand.
 *
 * It is the same shape as `src/features/diagnostics/dead-pointer.test.ts`
 * (a trace id pointing into a log nothing could switch on) and as the two joints
 * `src/app/App.tsx` documents (a meter fed nothing, a tray read by nobody). Only
 * reading the tree catches it, so the tree is read: this walks the import graph
 * from `src/main.tsx` and insists every shipping module in this directory is in
 * it.
 *
 * It is deliberately structural and deliberately weak about *behaviour*. The
 * behavioural half — that the runtime actually drives a turn a user asked for —
 * is `src/app/composition-root.test.tsx`, which drives the assembled app. This
 * one only says the code is on the graph; that one says it does something.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const SRC_ROOT = join(REPO_ROOT, 'src');
const ENTRY = join(SRC_ROOT, 'main.tsx');

/**
 * Modules that are allowed to be off the graph, each with the reason.
 *
 * One entry, and it has to stay a list of named exceptions rather than a
 * pattern: "anything ending in `-doubles`" is how the next unwired module gets
 * a name that matches.
 */
const NOT_SHIPPED = new Map<string, string>([
  [
    'src/runtime/run-doubles.ts',
    'the doubles the tests in this directory are built from — a test helper by ' +
      'definition, and reachable from the application would be the bug',
  ],
]);

/** `.ts`/`.tsx` under a directory, recursively, tests excluded. */
function shippingModules(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...shippingModules(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.[a-z]+$/.test(entry.name)) found.push(path);
  }
  return found;
}

/**
 * Every import specifier in a module, as written.
 *
 * Static `import`/`export … from` and dynamic `import(...)`. A regex rather than
 * a parser, and that is a deliberate weakness in the *safe* direction: a
 * specifier this misses makes the reachable set smaller, so the guard fails
 * loudly rather than passing wrongly.
 */
function specifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) found.push(specifier);
    }
  }
  return found;
}

/** A specifier resolved to a file in this tree, or `null` for anything else. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  const base = specifier.startsWith('@/')
    ? join(SRC_ROOT, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(fromFile), specifier)
      : null;
  if (base === null) return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Everything `src/main.tsx` reaches, transitively. */
function reachableFromEntry(): Set<string> {
  const seen = new Set<string>();
  const queue = [ENTRY];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    for (const specifier of specifiers(readFileSync(file, 'utf8'))) {
      const resolved = resolveSpecifier(file, specifier);
      if (resolved !== null && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

const REACHABLE = reachableFromEntry();

function asRepoPath(file: string): string {
  return relative(REPO_ROOT, file).split('\\').join('/');
}

describe('the agentic runtime is wired into the product', () => {
  it('walks a graph big enough to be worth walking', () => {
    // The guard's own control. A resolver that silently stopped resolving would
    // make every assertion below vacuous in the direction that reads as clean —
    // which is exactly how a guard becomes a trap.
    expect(REACHABLE.size, 'the import walk resolved almost nothing; fix the resolver').toBeGreaterThan(
      40,
    );
    expect([...REACHABLE].map(asRepoPath)).toContain('src/app/App.tsx');
  });

  it('reaches every shipping module in src/runtime from src/main.tsx', () => {
    const unreachable = shippingModules(join(SRC_ROOT, 'runtime'))
      .map(asRepoPath)
      .filter((path) => !NOT_SHIPPED.has(path))
      .filter((path) => !REACHABLE.has(join(REPO_ROOT, path)));

    expect(
      unreachable,
      'a runtime module the application cannot reach is code that exists and is ' +
        'called by nothing — this repo has shipped that three times',
    ).toEqual([]);
  });

  it('names its exemption, and the exemption is still off the graph', () => {
    // An exemption that has stopped applying reads exactly like a clean tree, so
    // it is asserted in both directions rather than trusted.
    for (const [path] of NOT_SHIPPED) {
      expect(existsSync(join(REPO_ROOT, path)), `${path} moved; fix NOT_SHIPPED`).toBe(true);
      expect(
        REACHABLE.has(join(REPO_ROOT, path)),
        `${path} is exempt because nothing ships it. It is now on the graph: ` +
          'either that is the bug, or the exemption should go.',
      ).toBe(false);
    }
  });

  it('reaches the runtime through the composition root, not through a back door', () => {
    // The join is meant to be one, visible, at the place this repo puts joins.
    // A feature that built its own runtime would satisfy the walk above and
    // recreate the defect one level down: a second directory nothing else can
    // see, thrown away on every conversation switch.
    const builders = shippingModules(SRC_ROOT)
      .filter((file) => !file.startsWith(join(SRC_ROOT, 'runtime')))
      .filter((file) => /\bcreateAgentRuntime\s*\(/.test(readFileSync(file, 'utf8')))
      .map(asRepoPath);

    expect(builders, 'the runtime is built once, at the composition root').toEqual([
      'src/app/App.tsx',
    ]);
  });
});
