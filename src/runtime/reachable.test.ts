/**
 * **Renderer code has to be reachable from the application.**
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
 * from `src/main.tsx` and insists every shipping module **under `src/`** is in
 * it.
 *
 * ## This used to walk one directory
 *
 * It walked `src/runtime/` and named exactly one module in `src/data/`. That
 * was a deliberate limit and it was recorded as one — but it was recorded *in
 * prose*, and prose is not enforced. What the prose said had already stopped
 * being true: it named `mcp-repository.ts` and `skills-repository.ts` as the two
 * modules a widened walk would find, and `skills-repository.ts` had been wired
 * to a sidebar control by then, leaving a comment that overstated the debt by
 * one and a guard that could not tell anybody so. The walk is now the whole of
 * `src/`, and every module allowed to be off the graph is a **named entry in a
 * map, asserted in both directions**, so an exemption that has stopped applying
 * fails instead of reading as a clean tree.
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
 * Modules that **must** be off the graph, each with the reason.
 *
 * These are not debt. Every one of them would be a defect if the application
 * could reach it, which is why the assertion at the bottom of this file checks
 * that they are still unreachable rather than merely allowing them to be.
 *
 * It has to stay a list of named exceptions rather than a pattern: "anything
 * ending in `-doubles`" is how the next unwired module gets a name that matches.
 */
const NOT_SHIPPED = new Map<string, string>([
  [
    'src/runtime/run-doubles.ts',
    'the doubles the tests in this directory are built from — a test helper by ' +
      'definition, and reachable from the application would be the bug',
  ],
  [
    'src/features/canvas/document-host-double.ts',
    '`LocalDocumentHost`, demoted from shipping boundary to test double by ' +
      'wave2/canvas-host-boundary. `CanvasSurface` used to construct one, which ' +
      'is how a double became the renderer-side host that decided its own ' +
      'permission level. On the graph again means that is back',
  ],
  [
    'src/platform/declared-commands.ts',
    'reads an `export interface`’s members back out of its own source text, for ' +
      '`contract.test.ts` and `project-host-parity.test.ts`. An interface has no ' +
      'runtime value, so this exists only at test time; its own header says ' +
      'nothing outside a test imports it',
  ],
  [
    'src/platform/capability-surface.ts',
    'derives the capability union from the `src-tauri/capabilities/` directory ' +
      'and `tauri.conf.json`, for the two guards that used to read one filename ' +
      'out of a directory the build reads whole. Test infrastructure over the ' +
      'build’s inputs, not something the renderer loads',
  ],
  [
    'src/test/setup.ts',
    'vitest’s `setupFiles`, named in `vite.config.ts`. The runner enters it; ' +
      '`src/main.tsx` never does, and a bundle that pulled in jest-dom would be ' +
      'the bug',
  ],
]);

/**
 * Modules that are off the graph and **should not be** — the debt, named.
 *
 * **It is empty**, and that is a fact about the tree rather than a decision to
 * stop tracking: the last entry was `src/data/mcp-repository.ts`, and it went
 * when `src/features/mcp/` and the `<McpSurface />` line in `src/app/App.tsx`
 * gave `mcp_list_tools` a control a user can press. Leaving the map in place
 * empty is deliberate — the mechanism below is what makes the next orphan a
 * named entry instead of an invisible one, and deleting the map would take the
 * mechanism with it.
 *
 * Every entry is a module this repo built, documented and tested, behind a host
 * command that is registered and served, with nothing a user can press on the
 * other end — the defect this whole guard is about, sitting in the tree with a
 * date on it rather than sitting in the tree invisibly.
 *
 * **It is asserted in both directions too**, and that is the point of splitting
 * it from `NOT_SHIPPED`: when somebody wires one of these up, this file goes
 * **red** and the only way to green is to delete the entry. An exemption that
 * quietly stops applying is how the comment this map replaced came to overstate
 * its own debt by one module for a whole wave.
 *
 * ## What that redness proves, and the notch it is narrower than
 *
 * Stated because the mcp entry's own wording promised more than the assertion
 * that removed it can deliver. It read "delete this entry when a user can press
 * something that reaches `toolCatalogue()`" — but what actually reddens this
 * file is one `import` from a module on the graph. A wiring that imported
 * `mcp-repository.ts` and called nothing would have gone red in exactly the same
 * way, and deleting the entry would then have recorded a surface that does not
 * exist. **Reachability of a file is not reachability of a behaviour**, and no
 * import walk can tell the two apart. The behavioural half is
 * `src/app/mcp-reachable.test.tsx`, which drives `<App />` through the sidebar
 * control and asserts on something only `toolCatalogueOf` could have decided —
 * the same division of labour this file's header draws with
 * `src/app/composition-root.test.tsx`.
 */
const AWAITING_A_SURFACE = new Map<string, string>([]);

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
 * Every import specifier in a module **that survives to runtime**, as written.
 *
 * Static `import`/`export … from` and dynamic `import(...)`. A regex rather than
 * a parser.
 *
 * ## The head class is `[^;/]`, and that is the whole ballgame
 *
 * This function used to say its weakness ran in the *safe* direction — "a
 * specifier this misses makes the reachable set smaller, so the guard fails
 * loudly rather than passing wrongly". **That was false, and it was measured
 * false on this codebase.** The head was `[\s\S]*?`, which spans lines. A match
 * begins at any line-initial `import`/`export` keyword, and one that is not an
 * import statement at all — `export interface`, `export function` — ran forward
 * through comments until it found any `from '…'`. Quoted prose became a
 * specifier, and a specifier that resolves is a runtime edge that nothing in the
 * tree actually has.
 *
 * A differential against the TypeScript AST over all 265 files under `src/` gave
 * **9 disagreements, every one an overcount, zero undercounts** — doc-comment
 * prose scraped out of `endpoint-repository.ts`, `settings-repository.ts`,
 * `turn-attachments.ts`, `EndpointsPanel.tsx`, `contract-sandbox.ts` and this
 * file. None of them resolved, so the verdict stayed right by luck.
 *
 * The consequence is not academic and was reproduced twice: plant an orphan in
 * `src/data`, and this guard correctly reddens; add to a file already on the
 * graph a **comment** reading `re-exported from './that-orphan'`, and the guard
 * goes **green 7/7 with a module nothing in the tree imports**. A guard whose
 * project-level finding is *a comment is not evidence* was reading comments as
 * evidence.
 *
 * So the head cannot cross a statement terminator **or a comment opener**.
 * Excluding `;` alone is not enough: an `export interface` block with no
 * semicolons in it reaches a following doc comment anyway, which was checked
 * rather than assumed. Excluding `/` closes the class outright, because every
 * comment in the language begins with one and no import clause contains one —
 * the specifier's own slashes sit after `from`, outside this class.
 *
 * **What it costs, stated rather than discovered later:** an inline comment
 * *inside* an import clause makes this miss a real edge. That direction is the
 * loud one — the module drops off the graph and the walk names it — and the
 * differential says the tree has none. A string literal holding `from '…'` with
 * no `;` or `/` before it can still manufacture an edge; three remain, all in
 * test files this walk never reads, since it enters only what `src/main.tsx`
 * imports.
 *
 * ## Why type-only imports are dropped rather than counted
 *
 * This used to count them, and that made the guard weaker than it read.
 * A specifier is a specifier whether the binding is a value or a type, so
 * severing the composition root's call — deleting `createSandboxRepository`
 * from `App.tsx` and handing `CanvasSurface` a stub — left the old guard
 * **green in two consecutive runs**, because `use-document-run.ts` and
 * `CanvasPanel.tsx` still `import type { SandboxRepository }` from that module.
 * Type imports vanish at build time; they keep a module on the graph while
 * nothing at runtime ever enters it. That is the original defect wearing the
 * guard written against it.
 *
 * **And the compiler does not see it either**, which is the sharpest way to put
 * why this distinction has to live here. Severing `harness-runtime.ts`'s value
 * import of `project-context.ts` down to `import type { ProjectInstructionsReader }`
 * and stubbing the call leaves `pnpm typecheck` at **exit 0** — measured, twice —
 * while `src/runtime/project-context.ts` has nothing entering it at runtime. A
 * type-only orphan is invisible to `tsc`, invisible to every behavioural test
 * that does not happen to drive it, and was invisible to this guard. That is
 * three instruments agreeing on a module that is not there.
 *
 * So a type-only statement contributes no edge. Three spellings are erased and
 * all three are dropped here: `import type … from`, `export type … from`, and a
 * brace list in which **every** specifier carries an inline `type` — the last
 * only when there is no default or namespace binding to keep the statement
 * alive.
 *
 * **This is exact for this codebase rather than a heuristic**, and the reason is
 * `verbatimModuleSyntax: true` in `tsconfig.app.json`: with it on, TypeScript
 * emits import statements exactly as written and elides only what is marked
 * `type`. An unmarked import is a runtime import even when every binding it
 * names happens to be a type, so there is no fourth, invisible spelling for this
 * to miss. Turn that flag off and this becomes an approximation again.
 */
function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(
    /(?:^|\n)\s*((?:import|export)[^;/]*?from\s*['"]([^'"]+)['"])/g,
  )) {
    const statement = match[1];
    const specifier = match[2];
    if (statement === undefined || specifier === undefined) continue;
    if (/^\s*(?:import|export)\s+type\b/.test(statement)) continue;
    const braced = /\{([\s\S]*?)\}/.exec(statement);
    if (braced?.[1] !== undefined) {
      const names = braced[1]
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
      const bindsOutsideBraces = /^\s*import\s+(?!\{)[A-Za-z_$*]/.test(statement);
      if (names.length > 0 && !bindsOutsideBraces && names.every((n) => /^type\s/.test(n))) continue;
    }
    found.push(specifier);
  }
  for (const pattern of [
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
  ]) {
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

/** Everything `src/main.tsx` reaches at runtime, transitively. */
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

describe('the renderer is wired into the product', () => {
  it('walks a graph big enough to be worth walking', () => {
    // The guard's own control. A resolver that silently stopped resolving would
    // make every assertion below vacuous in the direction that reads as clean —
    // which is exactly how a guard becomes a trap.
    expect(REACHABLE.size, 'the import walk resolved almost nothing; fix the resolver').toBeGreaterThan(
      40,
    );
    expect([...REACHABLE].map(asRepoPath)).toContain('src/app/App.tsx');
  });

  /**
   * The extractor, exercised directly on text rather than on the tree.
   *
   * The walk above is only as good as what counts as an edge, and the failure
   * that matters is the silent one: counting an erased import as reachability
   * reads as a bigger, healthier graph. On the tree these cases are currently
   * indistinguishable — every module held by a type import is also held by a
   * value import today, so both readings give the same 142 files — which means
   * nothing in this repo would notice if the distinction broke. Hence a control
   * on the function itself.
   */
  it('counts a value import as an edge and an erased one as nothing', () => {
    expect(specifiers("import { thing } from './a';\n")).toEqual(['./a']);
    expect(specifiers("import './a';\n")).toEqual(['./a']);
    expect(specifiers("const m = await import('./a');\n")).toEqual(['./a']);
    expect(specifiers("import Default, { type A } from './a';\n")).toEqual(['./a']);
    expect(specifiers("import * as ns from './a';\n")).toEqual(['./a']);
    expect(specifiers("import { value, type A } from './a';\n")).toEqual(['./a']);

    expect(specifiers("import type { A } from './a';\n")).toEqual([]);
    expect(specifiers("import type A from './a';\n")).toEqual([]);
    expect(specifiers("export type { A } from './a';\n")).toEqual([]);
    expect(specifiers("import { type A, type B } from './a';\n")).toEqual([]);
    expect(specifiers("import type {\n  A,\n} from './a';\n")).toEqual([]);
  });

  /**
   * Prose is not an import — asserted, because this guard once believed it was.
   *
   * Every case below is a comment naming a module, downstream of a line-initial
   * `export` keyword that does not begin an import statement. Under the old
   * `[\s\S]*?` head each one yielded a specifier, which is how a planted orphan
   * was hidden from the walk by adding a sentence to a file that was already on
   * the graph. The first two carry **no semicolon** before the comment, which is
   * why excluding `;` alone does not close this and `/` has to go with it.
   */
  it('does not manufacture an edge out of a comment that names a module', () => {
    expect(specifiers('export interface Foo {\n  bar(): void\n}\n\n/**\n * re-exported from \'./ghost\'\n */\n')).toEqual([]);
    expect(specifiers('export function foo() {\n  return 1\n}\n\n// used to be imported from \'./ghost\'\n')).toEqual([]);
    expect(specifiers("export function make() {\n  return { a: 1 };\n}\n\n/**\n * re-exported from './ghost'\n */\n")).toEqual([]);
    expect(specifiers("export const x = 1;\n/* loaded from './ghost' */\n")).toEqual([]);

    // The control for the four above: the same shape, but a real import, which
    // must still be found. A fix that returned [] for everything would pass the
    // assertions above and silence the entire guard.
    expect(specifiers("export const x = 1;\nimport { real } from './kept';\n")).toEqual(['./kept']);
  });

  it('reaches every shipping module under src/ from src/main.tsx', () => {
    const unreachable = shippingModules(SRC_ROOT)
      .map(asRepoPath)
      .filter((path) => !NOT_SHIPPED.has(path))
      .filter((path) => !AWAITING_A_SURFACE.has(path))
      .filter((path) => !REACHABLE.has(join(REPO_ROOT, path)));

    expect(
      unreachable,
      'a module the application cannot reach is code that exists and is called ' +
        'by nothing — this repo has shipped that in `src/runtime`, in `src/data` ' +
        'twice, and in the Rust crate that was deleted at 1237 lines. If one of ' +
        'these is deliberately off the graph it goes in NOT_SHIPPED with its ' +
        'reason; if it is waiting for a surface it goes in AWAITING_A_SURFACE ' +
        'with what it is waiting for. It does not get to be neither',
    ).toEqual([]);
  });

  /**
   * The named door, kept as its own assertion above and beyond the walk.
   *
   * `src/data/sandbox-repository.ts` was a tested door to five `sandbox_*`
   * commands whose **only importer was its own test** — `contract-sandbox.ts`
   * and `project-run-scope.test.ts` name the file in prose, which is not an
   * import, and the first of those is not a test — while
   * `src/features/canvas/CanvasSurface.tsx` built a renderer-side host instead,
   * so the sandbox contract's permission level, approval decision and request
   * digest were all decided inside the process that contract exists to
   * constrain. The sixth command, `sandbox_report_document`, had no caller in
   * `src/` at all and was added with this wiring.
   *
   * The walk above now covers it. This stays because a general assertion reports
   * a path in a list and this one reports what losing that path *means*.
   */
  it('reaches the sandbox door from src/main.tsx', () => {
    const door = 'src/data/sandbox-repository.ts';
    expect(existsSync(join(REPO_ROOT, door)), `${door} moved; fix this guard`).toBe(true);
    expect(
      REACHABLE.has(join(REPO_ROOT, door)),
      `${door} is the renderer's only door to the six sandbox_* commands. Nothing ` +
        'on the import graph reaches it, which means whatever surface used to ' +
        'submit through it is deciding for itself again.',
    ).toBe(true);
  });

  /**
   * And the walk is **weaker than it looks even now**, which was measured rather
   * than reasoned about.
   *
   * Dropping type-only imports closes the hole where a module sits on the graph
   * with nothing entering it. It does not close the hole one level up: a module
   * can be value-imported by something that is itself only imported for a type,
   * or imported and never called. The walk says the code is loadable, not that
   * anything loads it.
   *
   * So the door is held the way the runtime is held: by where the *factory* is
   * called. One call, in the composition root, and nowhere else — a feature that
   * built its own would satisfy both assertions above and be back to a host it
   * can reach into.
   */
  it('builds the sandbox door once, at the composition root', () => {
    const builders = shippingModules(SRC_ROOT)
      .filter((file) => file !== join(SRC_ROOT, 'data', 'sandbox-repository.ts'))
      .filter((file) => /\bcreateSandboxRepository\s*\(/.test(readFileSync(file, 'utf8')))
      .map(asRepoPath);

    expect(
      builders,
      'the renderer door to the sandbox commands is built once, at the ' +
        'composition root, and handed down — a surface that builds its own host ' +
        'is how the boundary ended up inside the process it constrains',
    ).toEqual(['src/app/App.tsx']);
  });

  it('names every exemption, and every exemption is still off the graph', () => {
    // An exemption that has stopped applying reads exactly like a clean tree, so
    // both maps are asserted in both directions rather than trusted. For
    // NOT_SHIPPED a hit means a test helper reached the bundle. For
    // AWAITING_A_SURFACE it means somebody did the work — good news, and the
    // entry has to go, because a debt list nobody is made to update is a comment.
    for (const [path] of NOT_SHIPPED) {
      expect(existsSync(join(REPO_ROOT, path)), `${path} moved; fix NOT_SHIPPED`).toBe(true);
      expect(
        REACHABLE.has(join(REPO_ROOT, path)),
        `${path} is exempt because nothing ships it. It is now on the graph: ` +
          'either that is the bug, or the exemption should go.',
      ).toBe(false);
    }
    for (const [path, waitingFor] of AWAITING_A_SURFACE) {
      expect(existsSync(join(REPO_ROOT, path)), `${path} moved; fix AWAITING_A_SURFACE`).toBe(true);
      expect(
        REACHABLE.has(join(REPO_ROOT, path)),
        `${path} is on the graph now. That is the fix landing, not a failure: ` +
          `delete its AWAITING_A_SURFACE entry. It was waiting for — ${waitingFor}`,
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
