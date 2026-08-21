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
 * reading the tree catches it, so the tree is read: this walks the module graph
 * from what `index.html` loads and insists every shipping file **under `src/`**
 * is in it.
 *
 * ## Eight times this asked a narrower question than the product's
 *
 * Each entry below was executed against the guard as it then stood, not argued
 * from reading it, and every one after the first was found in the fix for an
 * earlier one. 6 and 7 are both holes in the single commit that closed 2 — the
 * one that moved the extractor onto a parser and made stylesheets and the html
 * entry first-class in the same breath. 8 *is* 2, carried forward untouched
 * through both rebuilds that cited it, two assertions below the extractor they
 * rewrote. So the list is kept rather than tidied away.
 *
 * 1. **It walked one directory.** It walked `src/runtime/` and named exactly one
 *    module in `src/data/`. That limit was recorded *in prose*, and prose is not
 *    enforced; what the prose said had already stopped being true. Fixed by
 *    walking the whole of `src/` with every exemption a **named entry in a map,
 *    asserted in both directions**.
 *
 * 2. **It read prose as code.** The extractor was a regex whose head was
 *    `[\s\S]*?`, so a match beginning at any line-initial `import`/`export`
 *    keyword ran forward *through comments* until it found `from` and a quoted
 *    path. A planted orphan went green behind a single comment naming it.
 *    Narrowing that head to `[^;/]` closed one route and left two open: the same
 *    function ran two further regexes, for dynamic `import(…)` and for bare
 *    side-effect `import '…'`, **with no head class at all**. So a line comment
 *    mentioning a dynamic import of a module, or a block comment one of whose
 *    interior lines begins with a side-effect import of it, still laundered an
 *    orphan onto the graph. Both were executed against this guard and both went
 *    green.
 *
 *    A regex cannot tell code from prose, and this file's own project-level
 *    finding is that a comment is not evidence — so the extractor is now the
 *    **TypeScript parser** (`ts.createSourceFile`). Comments are trivia in that
 *    grammar: they are not nodes, so no comment can produce an edge, and all
 *    three regexes are gone rather than hardened. The parser also gets back the
 *    real edge the `[^;/]` head lost — an inline comment sitting inside an import
 *    clause — and closes the hole that head conceded: a string literal in code
 *    containing the word `from` and a quoted path is a `StringLiteral` node, not
 *    an `ImportDeclaration`, and cannot manufacture anything.
 *
 * 3. **It walked one file extension of a product that ships several.** The
 *    enumerator kept `/\.tsx?$/` and the resolver only ever returned a `.ts` or
 *    `.tsx` candidate, so the **43 `.css` files under `src/`** — 40 of them
 *    `.module.css`, the other three `src/styles/base.css`, `tokens.css` and
 *    `typeface.css` — were
 *    neither enumerated nor resolvable: a CSS file with no importer was dead
 *    shipped source that the guard reported as a clean tree. That is defect 1 one
 *    axis over, and no amount of parser is any help with it — the fix has to be
 *    in the enumerator and the resolver.
 *
 *    So the universe is no longer a list of extensions to keep. **Every file
 *    under `src/` is enumerated**, and each extension present is declared either
 *    in `SHIPPING_EXTENSIONS` or in `NOT_LOADED_EXTENSIONS`, asserted in both
 *    directions. The next file kind somebody adds — `.svg`, `.json`, `.wasm` —
 *    reddens this file until a human says which it is, instead of escaping the
 *    walk in silence. CSS is a real node with real out-edges: `cssSpecifiers`
 *    follows `@import` and `composes … from`, which is how `src/styles/base.css`
 *    holds `tokens.css` and `typeface.css`.
 *
 * 4. **It dropped an import the build keeps.** `specifiers` used to discard a
 *    brace list in which every binding carried an inline `type`, citing
 *    `verbatimModuleSyntax: true` as making that *exact*. The flag says the
 *    opposite, and it was measured with this repo's own settings — `tsc` emits
 *    `import {} from './a'` for `import { type A } from './a'`, and a `vite
 *    build` over a fixture whose tsconfig carries the flag put that module's
 *    top-level `console.log` in `dist/assets/*` `.js`. An empty brace list is a
 *    side-effect import: the module is fetched and its top level runs. The same
 *    goes for `export { type A } from './a'`, which emits `export {} from
 *    './a'`. Both are edges now, because both are in the graph the bundler
 *    builds — which is the same line drawn everywhere else in this file, since
 *    `import type … from` is erased before Rollup ever sees the module and
 *    contributes nothing.
 *
 *    The direction of that old mistake is the one that matters: a dropped edge
 *    shrinks the reachable set, and `NOT_SHIPPED` asserts modules are **absent**
 *    from it, so an undercount is a false green on the map whose job is keeping
 *    test doubles out of the build.
 *
 *    **Measured, and it does not go as far as it sounds.** Appending
 *    `import { type RecordingTranscript } from '../runtime/run-doubles'` to
 *    `src/data/sandbox-repository.ts` puts `run-doubles` on the module graph and
 *    reddens this file — but `npx vite build` then emits **no** `run-doubles`
 *    chunk, because that module's top level only declares things and Rollup
 *    shakes an inert module back out. So the red is about the module graph, not
 *    about `dist/`, which is the boundary the last bullet below draws for every
 *    other assertion here as well. A dynamic import of the same module is a
 *    different story: it cannot be shaken, and it really does ship.
 *
 * It is deliberately structural and deliberately weak about *behaviour*. The
 * behavioural half — that the runtime actually drives a turn a user asked for —
 * is `src/app/composition-root.test.tsx`, which drives the assembled app. This
 * one only says the code is on the graph; that one says it does something.
 *
 * 5. **It enumerated import syntax and called that "every edge".** Two holes,
 *    both silent, both measured against the parser rebuild rather than against
 *    the regexes it replaced.
 *
 *    `resolveSpecifier` answering `null` meant two unrelated things and `walk`
 *    treated them the same: `'react'` is a package, correctly ignored, while
 *    `'../runtime/run-doubles.ts?raw'` is a **file in this tree** whose name the
 *    resolver could not spell, because Vite's query suffix was still attached
 *    when `canonical` went looking on disk. One module-scope line of that in
 *    `src/data/sandbox-repository.ts` put `FakeTurnDriver`'s **source text** into
 *    `dist/assets/run-doubles-*.js` — `?raw` inlines the file — with this guard
 *    green twice and `tsc --build --force` exit 0, because `?raw` matches an
 *    ambient wildcard module in `vite/client` and `tsc` never resolves the path.
 *    So the suffix is cut before resolution, **and** an in-tree specifier that
 *    still resolves to nothing is reported by `GRAPH.unresolved` instead of
 *    being `continue`d past. The second half is the part that does not depend on
 *    knowing today's suffix list.
 *
 *    And `new URL('./w.ts', import.meta.url)` — the documented Vite spelling for
 *    a module worker and for an asset — is an edge Rollup follows that ESM
 *    syntax does not spell, so an extractor built out of `ImportDeclaration`,
 *    `ExportDeclaration` and `import()` saw nothing: not an edge, and not an
 *    unfollowable one either. `new Worker(new URL('../runtime/run-doubles.ts',
 *    import.meta.url), { type: 'module' })` emitted a `run-doubles` chunk with
 *    this file green twice. `isAssetUrl` reads it, and a computed one goes in
 *    the loud list.
 *
 *    The shape both share is the one this file keeps repeating: the rebuild
 *    asked *"can prose reach my extractor?"* and answered it completely, while
 *    the product's question is *"what does the bundler load?"* — and the bundler
 *    loads things through spellings that are not import statements at all.
 *
 * 6. **It fixed prose-makes-an-edge in TypeScript and left it standing in CSS.**
 *    The rebuild that put defect 2 to bed moved the TypeScript extractor onto a
 *    parser and, in the same commit, made stylesheets first-class — with a CSS
 *    reader that stripped comments and then ran three regexes over the result,
 *    each defining a specifier as "text between two quotes". A CSS *string* is
 *    not a comment, so nothing stripped it. Appending
 *
 *        .t05Launder { content: "@import '…/T05Ghost.module.css'"; }
 *
 *    to a stylesheet already on the graph put a planted orphan stylesheet on the
 *    graph and this file passed **every assertion in it, in two consecutive
 *    runs**, with dead
 *    shipped CSS in `src/features/canvas/`. That is defect 2 exactly, in the
 *    commit that closed defect 2, one file kind over — which is why `readCss`
 *    exists: strings come out as opaque tokens and each rule is matched only in
 *    the half of the grammar where CSS honours it.
 *
 * 7. **It read what `index.html` *names*, not what the build *loads*.** The
 *    entry was taken out of the file rather than hard-coded — one axis closed —
 *    by a reader that looked for a `src=` attribute on `<script type="module">`.
 *    An **inline** module script has no `src`. Its body is a module: Vite
 *    compiles it and bundles what it imports. Adding
 *
 *        <script type="module">import { FakeTurnDriver } from
 *          '/src/runtime/run-doubles.ts'; console.log(new FakeTurnDriver());</script>
 *
 *    to `index.html` left every assertion in this file green, `npx tsc -b
 *    --force` exit 0 and `npx vite build` exit 0, and put `run-doubles.ts` —
 *    the **first `NOT_SHIPPED` entry**, the double this guard exists to keep out
 *    — into `dist/assets/*.js`. Measured by the string `no turn has
 *    been sent`, which occurs in exactly one file under `src/`: present in the
 *    bundle with the plant (221 modules transformed) and absent from the control
 *    build of the unmodified tree (219 modules transformed).
 *
 *    So `htmlLoads` replaces `htmlEntries` and inverts the question. Any
 *    `src=`/`href=` into this tree is an edge whatever tag carries it and
 *    however it is quoted; an inline module body is walked as the module it is;
 *    and anything else that can execute or fetch — a classic `<script>`, an
 *    import map, a module script with both a `src` and a body, an unterminated
 *    tag — goes in `unreadHtml` and **reddens** rather than being skipped for
 *    not matching the shape the reader knew. `build.rollupOptions.input` and
 *    `build.lib` can move the entry out of `index.html` altogether, so the keys
 *    of `build` are pinned against `vite.config.ts` as well.
 *
 * 8. **It fixed prose-makes-a-fact in the extractor and left it in the two
 *    assertions underneath.** `builds the sandbox door once` and `reaches the
 *    runtime through the composition root` are the boundary claims this file
 *    makes beyond reachability, and both were `/\bcreateAgentRuntime\s*\(/`
 *    against `readFileSync` — defect 2, still standing, in the commit that took
 *    it out of the extractor. Broken in both directions, executed twice each:
 *    `import { createAgentRuntime as buildRuntime }` plus a function returning
 *    `buildRuntime(adapter)` is a compiling second construction site the regex
 *    cannot see (green twice, `tsc` exit 0), and a bare comment reading
 *    `// the shell used to call createAgentRuntime( ) itself` turned that guard
 *    **red** twice against a file that builds nothing.
 *
 *    The name is not the binding, so the parser is asked which binding an
 *    identifier is and where it came from. `factoryUsesIn` counts calls through
 *    a rename, through a namespace import and — via `exportsReaching`, a
 *    fixpoint over the re-export graph — through a barrel of any depth; a
 *    comment and a string literal are not identifiers and cannot make a site.
 *    What it cannot follow it does not assume away: a binding used as a *value*
 *    is reported in `escapes`. Two of the files this assertion reads name
 *    `createSandboxRepository` in prose today — `CanvasSurface.tsx` once and
 *    `document-host-double.ts` twice — and the regex missed all three sentences
 *    only because none of them happens to be followed by `(`.
 *
 * ## What it still cannot see, stated rather than discovered later
 *
 * - A specifier that is not a literal — `import(someVariable)`, a template with
 *   a substitution in it, `import.meta.glob`, `require` — is a real edge to
 *   Rollup that no static reading of this kind can follow. Rather than drop one
 *   silently (an undercount reads as a *smaller* graph, which is exactly how a
 *   test double stays "unreachable" while sitting in `dist/`), every one is
 *   collected by `unanalysableImports` and **reddens** this file with the file
 *   and the text. There are none in the tree today; that is an observation about
 *   today's tree and not a bound. A template literal with no substitution *is* a
 *   literal and is followed — that spelling was used to put
 *   `src/runtime/run-doubles.ts` into `dist/` as its own chunk carrying
 *   `FakeTurnDriver`, with this guard green in two consecutive runs.
 * - This models the bundler's *module graph*, not the bundler. It says a file is
 *   loadable from the entry, not that Rollup emitted it — tree-shaking can still
 *   drop a value-imported module whose exports are all unused and whose top
 *   level is side-effect free. Proving emission needs `vite build` and a read of
 *   `dist/`: a different, slower instrument than this one.
 * - In `index.html`, only `src` and `href` are read as references into this
 *   tree. `srcset`, an inline `style` with a `url(...)` in it, or a framework
 *   attribute would each be one this reader does not look at — and unlike a
 *   `<script>` it cannot classify, an attribute it does not know about is not
 *   in `unreadHtml` either. There are none in the file today.
 * - An inline module body is parsed, not type-checked: nothing runs `tsc` over
 *   `index.html`. A body that neither the TS nor the TSX grammar accepts yields
 *   whatever partial tree the parser recovers from it, and edges inside the part
 *   it could not read are lost without a word.
 * - The entry configuration is pinned at the keys of `build` in `vite.config.ts`.
 *   A **plugin** can add an entry without any of those keys changing; `react()`
 *   is the only one here, and a second one is a lockfile change and a reviewer.
 * - A factory binding used as a value is reported, not followed. `escapes` says
 *   where the analysis stopped; it does not say where the thing is finally built.
 * - `src-tauri/` is not walked. This is the renderer's graph.
 * - `readdirSync` is the authority on a filename's case, not `existsSync`, which
 *   is case-blind on NTFS. `resolveSpecifier` returns the on-disk spelling, and
 *   the mismatches are reported, because `forceConsistentCasingInFileNames`
 *   covers what `tsc` resolves and `tsc` never resolves a `.css` path — those
 *   come from an ambient wildcard module in `vite/client`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const SRC_ROOT = join(REPO_ROOT, 'src');

/**
 * The entries are read out of `index.html` rather than named here.
 *
 * A guard that names the entry itself keeps walking the module it *believes* is
 * launched after somebody edits that file, which is the prose-exemption mistake
 * one level further out: the question stops being "what does the product load"
 * and becomes "what did this file's author think it loads".
 *
 * `src/main.tsx` is the only file `index.html` names today. That is an
 * observation about today's file, and the sentence it replaces — "the entry,
 * because one `<script type="module">` says so" — was false about the product
 * as written: a second module script, with a body instead of a `src`, is also
 * an entry, and both this file and the one assertion pinning the entry list
 * stayed green while what it imported went into `dist/`. `htmlLoads` is what
 * reads it now, and it reports what it cannot read instead of skipping it.
 */
const HTML_ENTRY = join(REPO_ROOT, 'index.html');

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
 * This is the list that must shrink. Every entry is a module this repo built,
 * documented and tested, behind a host command that is registered and served,
 * with nothing a user can press on the other end — the defect this whole guard
 * is about, sitting in the tree with a date on it rather than sitting in the
 * tree invisibly.
 *
 * **It is asserted in both directions too**, and that is the point of splitting
 * it from `NOT_SHIPPED`: when somebody wires one of these up, this file goes
 * **red** and the only way to green is to delete the entry. An exemption that
 * quietly stops applying is how the comment this map replaced came to overstate
 * its own debt by one module for a whole wave.
 */
const AWAITING_A_SURFACE = new Map<string, string>([
  [
    'src/data/mcp-repository.ts',
    'the renderer’s door to `mcp_list_tools`, which `src-tauri/src/ipc/mcp.rs` ' +
      'serves, `src-tauri/src/lib.rs` registers and `src-tauri/src/ipc/mod.rs` ' +
      'allowlists. Its only importer in the whole tree is its own test. There is ' +
      'no `src/features/mcp/` — no pane, no control, no store — so wiring it is a ' +
      'surface, not a mount, and it is not this branch’s change. Delete this entry ' +
      'when a user can press something that reaches `toolCatalogue()`',
  ],
]);

/**
 * File kinds under `src/` that the bundler loads, and what reads edges out of
 * each.
 *
 * Declaring the universe here rather than writing `/\.tsx?$/` into the
 * enumerator is the whole point: this map is **asserted against the tree in both
 * directions** by `declares every file kind under src/`. An extension that
 * appears under `src/` and is in neither this map nor `NOT_LOADED_EXTENSIONS`
 * fails; an extension declared here that no longer exists fails too. The
 * enumerator this replaced hard-coded `.ts`/`.tsx`, and 43 `.css` files were
 * simply not part of the question it asked.
 */
const SHIPPING_EXTENSIONS = new Map<string, string>([
  ['.ts', 'parsed by `ts.createSourceFile`; read by `specifiers`'],
  ['.tsx', 'parsed by `ts.createSourceFile` as TSX; read by `specifiers`'],
  [
    '.css',
    'a real module to Vite — `import styles from "./X.module.css"` loads one and ' +
      '`@import` chains out of it. Read by `cssSpecifiers`',
  ],
]);

/** File kinds under `src/` the bundler never loads, each with the reason. */
const NOT_LOADED_EXTENSIONS = new Map<string, string>([
  [
    '.md',
    'prose for whoever opens the directory — `src/features/README.md` and ' +
      '`src/lib/README.md`. Nothing imports them and Vite has no loader for ' +
      'them. If one is ever imported as `?raw` it has become a shipping kind and ' +
      'this entry has to move',
  ],
]);

/**
 * A test file, in exactly the spelling `vite.config.ts` gives `test.include`.
 *
 * That match is what makes skipping these safe: a file this walk does not
 * enumerate is a file the runner does enter. The exclusion this replaces was
 * `/\.test\.[a-z]+$/`, which also swallowed spellings vitest does **not** run —
 * a stylesheet with a test infix in its name, for one — leaving an escape hatch
 * from both instruments at once.
 */
const TEST_FILE = /\.test\.tsx?$/;

/** Every file under `directory` the bundler could load, recursively, tests excluded. */
function shippingModules(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...shippingModules(path));
      continue;
    }
    if (!SHIPPING_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    if (TEST_FILE.test(entry.name)) continue;
    found.push(path);
  }
  return found;
}

/** Every distinct file extension under `directory`, recursively. */
function extensionsUnder(directory: string): Set<string> {
  const found = new Set<string>();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const extension of extensionsUnder(join(directory, entry.name))) found.add(extension);
    } else {
      found.add(extname(entry.name).toLowerCase());
    }
  }
  return found;
}

/** `source` parsed as TypeScript, as TSX when the file name says so. */
function parse(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ESNext,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** Depth-first over every node. Comments are trivia in this grammar, not nodes. */
function eachNode(root: ts.Node, visit: (node: ts.Node) => void): void {
  visit(root);
  root.forEachChild((child) => {
    eachNode(child, visit);
  });
}

/**
 * The text of a module specifier the bundler can read statically, or `null`.
 *
 * `ts.isStringLiteralLike` is `StringLiteral | NoSubstitutionTemplateLiteral`,
 * and the second half is load-bearing rather than tidy. A backtick with nothing
 * interpolated is a compile-time constant and Rollup follows it, while every
 * regex this replaced defined a specifier as "text between a single or double
 * quote". One module-scope dynamic import of `../runtime/run-doubles` written
 * with backticks, in a file already on the graph, put that module into `dist/`
 * as its own chunk carrying `FakeTurnDriver` — with the old guard green twice.
 */
function staticSpecifier(node: ts.Node): string | null {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

/** `import(...)` as a call — not `import('...').Thing`, which is a type. */
function isDynamicImportCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

/** `import.meta.glob(...)`, Vite's compile-time directory expansion. */
function isImportMetaGlob(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isMetaProperty(callee.expression) &&
    callee.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    callee.name.text === 'glob'
  );
}

/** `import.meta.url` — the base a `new URL(…)` edge is resolved against. */
function isImportMetaUrl(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.name.text === 'url'
  );
}

/**
 * `new URL(<specifier>, import.meta.url)` — an edge Rollup follows and ESM syntax
 * does not spell.
 *
 * This is not an exotic corner. It is the **documented** way to reference a
 * worker or an asset in Vite, `new Worker(new URL('./w.ts', import.meta.url), {
 * type: 'module' })` is the shape the docs give, and Rollup emits a chunk for
 * the target. Nothing about it is an `ImportDeclaration` or an `import()` call,
 * so an extractor that enumerates *import syntax* sees nothing at all — not an
 * edge, and not an unfollowable one either. Measured: one module-scope line of
 * exactly that form in `src/data/sandbox-repository.ts` naming
 * `src/runtime/run-doubles.ts` left this file green in two consecutive runs
 * while `vite build` emitted a `run-doubles` chunk under `dist/assets/`.
 *
 * The second argument is required to be `import.meta.url` precisely so that the
 * ordinary runtime `new URL(text)` and `new URL(text, someBase)` in
 * `src/lib/markdown-parser.ts` and `src/platform/browser-adapter.ts` stay what
 * they are — parsing a URL a user typed is not a module edge.
 */
function isAssetUrl(node: ts.Node): node is ts.NewExpression {
  if (!ts.isNewExpression(node)) return false;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'URL') return false;
  const base = node.arguments?.[1];
  return base !== undefined && isImportMetaUrl(base);
}

/** A `require(...)` call, which has no business in this ESM renderer. */
function isRequireCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
  );
}

/**
 * Every module specifier in a source file **that survives to runtime**, as written.
 *
 * The extractor is the TypeScript parser, and that is not a tidiness preference.
 * This guard's job is to tell code from prose; comments are trivia in
 * TypeScript's grammar rather than nodes; so the class of defect where a
 * sentence in a doc comment manufactures an edge cannot be *expressed* here.
 * Each of the regexes this replaced could be evaded by a comment and two of them
 * had no defence at all.
 *
 * What counts as an edge, and why:
 *
 * - `ImportDeclaration`, unless the clause is `import type`, in which case the
 *   whole statement is erased. **An empty or all-inline-`type` brace list is
 *   still an edge**: `verbatimModuleSyntax: true` emits `import {} from './a'`,
 *   which fetches the module and runs its top level.
 * - `ExportDeclaration` carrying a specifier, unless `export type … from`. That
 *   covers `export * from`, and `export { type A } from` for the same reason.
 * - `import(...)` as a call, with a `StringLiteral` or a substitution-free
 *   template literal.
 * - `ImportTypeNode` — `typeof import('./a')` in a type position — is **not** a
 *   call expression, so it never reaches here. It is erased syntax that a regex
 *   hunting for the four bytes `import(` counted as a runtime edge.
 */
function specifiers(source: string, fileName = 'probe.tsx'): string[] {
  const found: string[] = [];
  eachNode(parse(source, fileName), (node) => {
    if (ts.isImportDeclaration(node)) {
      if (node.importClause?.isTypeOnly === true) return;
      const specifier = staticSpecifier(node.moduleSpecifier);
      if (specifier !== null) found.push(specifier);
      return;
    }
    if (ts.isExportDeclaration(node)) {
      if (node.isTypeOnly || node.moduleSpecifier === undefined) return;
      const specifier = staticSpecifier(node.moduleSpecifier);
      if (specifier !== null) found.push(specifier);
      return;
    }
    if (isDynamicImportCall(node)) {
      const argument = node.arguments[0];
      const specifier = argument === undefined ? null : staticSpecifier(argument);
      if (specifier !== null) found.push(specifier);
      return;
    }
    if (isAssetUrl(node)) {
      const argument = node.arguments?.[0];
      const specifier = argument === undefined ? null : staticSpecifier(argument);
      if (specifier !== null) found.push(specifier);
    }
  });
  return found;
}

/**
 * Every edge in a source file the walk **cannot follow**, as source text.
 *
 * This is the half that stops an undercount from being silent. A missed edge
 * makes `REACHABLE` smaller, and smaller is not the safe direction: the
 * `NOT_SHIPPED` assertions read a module's **absence** from that set as proof
 * nothing ships it. So anything the bundler resolves and this file cannot —
 * a computed `import()`, `import.meta.glob`, `require` — is reported by name and
 * reddens `follows every edge it finds` instead of being dropped.
 *
 * The tree has none of these today. `import.meta.glob` in particular is a
 * statically expanded directory read: if one is ever added, the honest fix is to
 * teach this file the glob, not to widen an exemption.
 */
function unanalysableImports(source: string, fileName = 'probe.tsx'): string[] {
  const parsed = parse(source, fileName);
  const found: string[] = [];
  eachNode(parsed, (node) => {
    if (isDynamicImportCall(node)) {
      const argument = node.arguments[0];
      if (argument === undefined || staticSpecifier(argument) === null) {
        found.push(node.getText(parsed));
      }
      return;
    }
    if (isAssetUrl(node)) {
      const argument = node.arguments?.[0];
      if (argument === undefined || staticSpecifier(argument) === null) {
        found.push(node.getText(parsed));
      }
      return;
    }
    if (isImportMetaGlob(node) || isRequireCall(node)) found.push(node.getText(parsed));
  });
  return found;
}

/**
 * The marker a string literal leaves behind in `readCss`'s output.
 *
 * NUL delimits it rather than whitespace, and that is load-bearing rather than
 * fastidious. CSS is full of bare numbers, so a marker written with spaces
 * would let `margin: 0 12 0` be read as a specifier, and would let the
 * unquoted `url(...)` pattern match the quoted pattern's own output. NUL cannot
 * occur in a stylesheet, so a marker cannot be forged by the file being read.
 */
const CSS_STRING = /\u0000(\d+)\u0000/;

/** A stylesheet split the way its grammar splits, not the way a regex reads it. */
type CssText = {
  /** Everything outside every `{ … }`, with each string literal a marker. */
  readonly atRoot: string;
  /** Everything inside a `{ … }`, with each string literal a marker. */
  readonly inRules: string;
  /** The string literals, in order, without their quotes. */
  readonly literals: readonly string[];
};

/**
 * A stylesheet read structurally: comments gone, strings opaque, depth tracked.
 *
 * The TypeScript half of this file was rebuilt onto a parser because a regex
 * cannot tell code from prose. The CSS half kept the regexes and only stripped
 * comments — which left the same defect standing one file kind over, and it was
 * executed rather than argued about. Appending
 *
 *     .t05Launder { content: "@import '../../features/canvas/T05Ghost.module.css'"; }
 *
 * to `src/app/shell/AppShell.module.css`, a stylesheet already on the graph, put
 * a planted orphan stylesheet on the graph too, and this file went **green in
 * two consecutive runs** with dead shipped CSS sitting in `src/features/canvas/`.
 * A string is not a rule, exactly as a comment is not a node.
 *
 * Two structural facts do the work, and both are properties of CSS rather than
 * guesses about how people write it. A string literal is an opaque token, so its
 * interior can never supply a keyword — the literals come out into `literals`
 * and leave a marker behind, and a specifier is only ever *the whole of* one
 * literal, never a substring found inside one. And `@import` is a top-level rule:
 * a browser ignores one that appears after any other rule, so `atRoot` is where
 * it may be honoured, while `composes` is a declaration and lives in `inRules`.
 *
 * `postcss` is present under `node_modules/.pnpm` as a transitive dependency of
 * Vite but is not resolvable from this package and is not a declared dependency
 * of it, so reaching for it is a lockfile change and not this branch's. What is
 * implemented here is the part of the grammar this file needs — comments,
 * strings, brace depth — and each of those is one rule with no nesting.
 */
function readCss(source: string): CssText {
  let atRoot = '';
  let inRules = '';
  const literals: string[] = [];
  let depth = 0;
  let index = 0;
  const emit = (text: string): void => {
    if (depth === 0) atRoot += text;
    else inRules += text;
  };
  while (index < source.length) {
    const character = source.charAt(index);
    if (character === '/' && source.charAt(index + 1) === '*') {
      const end = source.indexOf('*/', index + 2);
      emit(' ');
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (character === '"' || character === "'") {
      let value = '';
      index += 1;
      while (index < source.length) {
        const inside = source.charAt(index);
        index += 1;
        if (inside === '\\' && index < source.length) {
          value += source.charAt(index);
          index += 1;
          continue;
        }
        if (inside === character) break;
        value += inside;
      }
      emit(`\u0000${literals.length}\u0000`);
      literals.push(value);
      continue;
    }
    if (character === '{' || character === '}') {
      // A `;` on both sides of every brace, so a declaration missing its own
      // trailing semicolon cannot run on into the next rule's text and pick up a
      // `from` that belongs to somebody else.
      emit(';');
      depth = character === '{' ? depth + 1 : Math.max(0, depth - 1);
      emit(';');
      index += 1;
      continue;
    }
    emit(character);
    index += 1;
  }
  return { atRoot, inRules, literals };
}

/**
 * Every module specifier a stylesheet pulls in.
 *
 * Two forms, both real in this tree's shape: `@import` (quoted or `url(...)`,
 * which is how `src/styles/base.css` holds `tokens.css` and `typeface.css`) and
 * CSS Modules' `composes: name from './other.module.css'`. A form not listed
 * here drops an edge, and a dropped edge reddens the walk naming the file it
 * lost — the loud direction, since the file it lost is itself enumerated. It
 * does not go quiet.
 *
 * Each pattern runs over the half of the stylesheet where its rule is legal, and
 * matches a **whole** string literal by marker rather than "text between two
 * quotes". That is what stops `content: "@import '…'"` from manufacturing an
 * edge, which it did, measured, with this file green twice.
 */
function cssSpecifiers(source: string): string[] {
  const css = readCss(source);
  const found: string[] = [];
  const literalAt = (index: string | undefined): void => {
    const value = index === undefined ? undefined : css.literals[Number(index)];
    if (value !== undefined) found.push(value);
  };
  for (const match of css.atRoot.matchAll(
    new RegExp(`@import\\s+(?:url\\(\\s*)?${CSS_STRING.source}`, 'g'),
  )) {
    literalAt(match[1]);
  }
  for (const match of css.atRoot.matchAll(/@import\s+url\(\s*([^)\s\u0000][^)]*?)\s*\)/g)) {
    const specifier = match[1];
    if (specifier !== undefined) found.push(specifier);
  }
  for (const match of css.inRules.matchAll(
    new RegExp(`\\bcomposes\\s*:[^;]*?\\bfrom\\s+${CSS_STRING.source}`, 'g'),
  )) {
    literalAt(match[1]);
  }
  return found;
}

/** Whichever extractor the file's kind calls for. */
function edgesOf(file: string, source: string): string[] {
  return extname(file).toLowerCase() === '.css' ? cssSpecifiers(source) : specifiers(source, file);
}

/** One specifier out of a file, and what became of it. */
type Edge = {
  /** As written, query suffix and all. */
  readonly specifier: string;
  /** The file it names, or `null` for a package or for nothing at all. */
  readonly resolved: string | null;
  /** It names a path in this repository and no file is there. */
  readonly lost: boolean;
};

const FILES_IN_DIRECTORY = new Map<string, string[]>();

/** The names of the plain files in `directory`, as the filesystem spells them. */
function filesIn(directory: string): string[] {
  const cached = FILES_IN_DIRECTORY.get(directory);
  if (cached !== undefined) return cached;
  let names: string[] = [];
  try {
    names = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    names = [];
  }
  FILES_IN_DIRECTORY.set(directory, names);
  return names;
}

/**
 * `path` respelled the way the filesystem spells it, or `null` if no file is there.
 *
 * `existsSync` is the wrong instrument twice over on this box: it is case-blind
 * on NTFS, so `'./Run-Doubles'` "exists", and it answers `true` for a directory,
 * so a specifier naming a folder used to have to be filtered out by extension.
 * `readdirSync` answers both questions at once, which is why the walk's keys and
 * the enumerator's keys are guaranteed to be the same strings.
 */
function canonical(path: string): string | null {
  const wanted = basename(path).toLowerCase();
  for (const real of filesIn(dirname(path))) {
    if (real.toLowerCase() === wanted) return join(dirname(path), real);
  }
  return null;
}

/**
 * A specifier with Vite's query suffix removed.
 *
 * `?raw`, `?url`, `?inline`, `?worker` and friends are not part of the path;
 * they select how Vite *loads* the file the path names. Leaving the suffix on
 * meant `canonical` looked on disk for a file literally called
 * `run-doubles.ts?raw`, found nothing, and the edge was dropped. `?` cannot
 * appear in a filename on this filesystem, so cutting at the first one loses
 * nothing.
 */
function withoutQuery(specifier: string): string {
  const mark = specifier.indexOf('?');
  return mark === -1 ? specifier : specifier.slice(0, mark);
}

/**
 * True when a specifier names a file in this repository rather than a package.
 *
 * This is the distinction `walk` needs and did not have. `'react'` resolving to
 * `null` means "not our file, correctly ignored"; `'./x?raw'` resolving to
 * `null` means "this walk just lost an edge into its own tree", and the two used
 * to be the same `continue`.
 */
function pointsIntoThisTree(specifier: string): boolean {
  return (
    specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('@/')
  );
}

/**
 * A specifier resolved to a file in this tree, or `null` for anything else.
 *
 * The bare path is tried **first**, which is what makes `AppShell.module.css`
 * resolve; the old order could not reach a CSS file at all because every
 * candidate was gated on `/\.tsx?$/` before `existsSync` ran. A root-absolute
 * specifier (`/src/main.tsx`) resolves against the project root, which is how
 * Vite reads the one in `index.html`.
 *
 * The query suffix is cut before any of that happens. `import('./x?raw')` is an
 * edge to the file `./x` names: Vite reads it and inlines its **source text**
 * into the bundle. Measured — one such line naming
 * `src/runtime/run-doubles.ts` put `FakeTurnDriver`'s source into a
 * `run-doubles` chunk under `dist/assets/` with this file
 * green twice and `tsc --build --force` exit 0, because `?raw` matches an
 * ambient wildcard module in `vite/client` and `tsc` therefore never resolves
 * the path at all.
 */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  const path = withoutQuery(specifier);
  const base = path.startsWith('@/')
    ? join(SRC_ROOT, path.slice(2))
    : path.startsWith('/')
      ? join(REPO_ROOT, path.slice(1))
      : path.startsWith('.')
        ? resolve(dirname(fromFile), path)
        : null;
  if (base === null) return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    const real = canonical(candidate);
    if (real !== null) return real;
  }
  return null;
}

/** One thing `index.html` hands the bundler. */
type HtmlLoad =
  /** A path in this tree named by an attribute — `src=`, `href=`. */
  | { readonly kind: 'file'; readonly specifier: string }
  /** The body of an inline `<script type="module">`, which is source. */
  | { readonly kind: 'inline'; readonly source: string }
  /** A tag that loads or runs something this reader cannot read. */
  | { readonly kind: 'unread'; readonly text: string };

/** `text` on one line, cut to `limit`, for a failure message. */
function collapse(text: string, limit = 120): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/**
 * The value of `attribute` in a tag's attribute text, or `undefined`.
 *
 * Unquoted is a real spelling — `<script type=module src=/src/main.tsx>` is what
 * HTML5 says it is — and a reader that only matched quotes returned `undefined`
 * for both halves of that tag, which made it neither an entry nor loud. That is
 * the same hole as the one this whole reader was rewritten for, one attribute
 * syntax over, so both spellings are read.
 */
function attributeValue(attributes: string, attribute: string): string | undefined {
  const match = new RegExp(`\\b${attribute}\\s*=\\s*(?:["']([^"']*)["']|([^\\s"'>]+))`, 'i').exec(
    attributes,
  );
  if (match === null) return undefined;
  return match[1] ?? match[2];
}

/**
 * Everything `index.html` hands the bundler, classified — not "what its script
 * tags name".
 *
 * The function this replaced asked the narrower question and answered it
 * completely: it read `src=` off `<script type="module">` and `href=` off
 * `<link rel=stylesheet>`. A third agent, shown that fix, got past it in one
 * line. An **inline** `<script type="module">` has no `src` for that reader to
 * find, and its body is a real module: Vite compiles it, its imports are real
 * edges, and what they pull in lands in `dist/`. Executed, not argued —
 * `<script type="module">import { FakeTurnDriver } from
 * '/src/runtime/run-doubles.ts'; …</script>` in this file's own `index.html`
 * left the guard green, `tsc -b --force` exit 0 and `vite build` exit 0, with
 * `run-doubles.ts` inside `dist/assets/*.js`. That is the first `NOT_SHIPPED`
 * entry in the bundle with every assertion in this file passing.
 *
 * So the reader is built the other way round, and the classes are these:
 *
 * - **Any** `src=`/`href=` naming a path in this tree is a `file`, whatever tag
 *   carries it. Vite rewrites in-tree asset references from any element, so
 *   enumerating the tags that may carry one is the same losing game as
 *   enumerating extensions was in defect 3.
 * - An inline `type="module"` body is `inline`: source, read by the same
 *   extractor every `.ts` file is read by, with its edges resolved against the
 *   repo root exactly as the tag's own `src` would be.
 * - Everything else that can execute or fetch is `unread` and **reddens** this
 *   file: a classic `<script>` (whose body this file does not parse and whose
 *   `document.write` or `import()` it cannot see), an import map (which can
 *   repoint a bare specifier at a file in this tree), a module script carrying
 *   both a `src` and a body, an unterminated `<script>`. None exist here today;
 *   the next one stops the build instead of silently widening the entry set.
 *
 * HTML comments are stripped first, for the reason the whole rest of this file
 * exists: a commented-out `<script>` tag is not an entry, and a guard that reads
 * one as an entry is reading prose as code.
 *
 * One thing to know before adding a favicon: Vite serves a static directory at
 * the URL root as well as the project root, so `/vela.svg` would mean
 * `public/vela.svg`. There is no such directory in this repo — `git ls-files`
 * matches nothing under `public/` — so `resolveSpecifier` does not look there,
 * and the first root-absolute reference to a static asset will land in
 * `unresolved` rather than go quiet. Teach the resolver that directory then,
 * with a file in it to prove the branch runs.
 */
function htmlLoads(html: string): HtmlLoad[] {
  const found: HtmlLoad[] = [];
  const scripts: Array<{ attributes: string; body: string }> = [];
  // Script elements come out first, so that the attribute sweep below reads
  // markup only and never the inside of a script body: `'<img src="/src/x">'`
  // written in JavaScript is a string, not a tag, and inventing an edge out of
  // it would let a body mask an orphan.
  const markup = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (_whole, attributes, body) => {
      scripts.push({ attributes: String(attributes), body: String(body) });
      return ' ';
    });
  for (const { attributes, body } of scripts) {
    const type = attributeValue(attributes, 'type');
    const source = attributeValue(attributes, 'src');
    const hasBody = body.trim() !== '';
    if (type !== undefined && type.trim().toLowerCase() === 'module') {
      if (source !== undefined && hasBody) {
        found.push({ kind: 'unread', text: collapse(`<script${attributes}> with a src and a body`) });
        continue;
      }
      if (source !== undefined && pointsIntoThisTree(source)) {
        found.push({ kind: 'file', specifier: source });
        continue;
      }
      if (hasBody) found.push({ kind: 'inline', source: body });
      continue;
    }
    if (source !== undefined || hasBody) {
      found.push({ kind: 'unread', text: collapse(`<script${attributes}>${body}`) });
    }
  }
  if (/<script\b/i.test(markup)) {
    found.push({ kind: 'unread', text: collapse('a <script> tag with no closing tag') });
  }
  for (const match of markup.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
    const attributes = match[2] ?? '';
    for (const attribute of ['src', 'href']) {
      const value = attributeValue(attributes, attribute);
      if (value !== undefined && pointsIntoThisTree(value)) {
        found.push({ kind: 'file', specifier: value });
      }
    }
  }
  return found;
}

/**
 * An inline module body's edges, read under both grammars.
 *
 * The tag declares no dialect — `type="module"` says how the browser loads the
 * body, not what syntax is in it — so the body is parsed once as TypeScript and
 * once as TSX and the two readings unioned. Reading it under one grammar only
 * would drop every edge in a body the other grammar is needed for, and a dropped
 * edge is the direction `NOT_SHIPPED` reads as proof.
 */
function inlineSpecifiers(source: string): string[] {
  return [...new Set([...specifiers(source, 'inline.ts'), ...specifiers(source, 'inline.tsx')])];
}

/** The same union, for the edges an inline body has that cannot be followed. */
function inlineUnfollowable(source: string): string[] {
  return [
    ...new Set([
      ...unanalysableImports(source, 'inline.ts'),
      ...unanalysableImports(source, 'inline.tsx'),
    ]),
  ];
}

/**
 * True when the disk spells this specifier's own last segment differently.
 *
 * Only the segment the specifier actually wrote is compared. An extensionless
 * specifier resolving to the same stem plus `.ts`, or a directory specifier
 * resolving to its index, is extension and index resolution doing its job and
 * not a casing fault. What this catches is a specifier written in all-lowercase
 * finding `AppShell.module.css`, which `existsSync` calls a hit on NTFS and a
 * case-sensitive filesystem calls a blank screen.
 */
function miscasedAgainst(specifier: string, resolved: string): boolean {
  const written = basename(withoutQuery(specifier));
  if (written === '' || written === '.' || written === '..') return false;
  const found = basename(resolved);
  return found.toLowerCase().startsWith(written.toLowerCase()) && !found.startsWith(written);
}

/**
 * Facts this file would otherwise have hard-coded from `vite.config.ts`.
 *
 * Three of the rules above are really claims about that config: `resolveSpecifier`
 * knows one alias prefix, `TEST_FILE` claims to match `test.include`, and
 * `NOT_SHIPPED` exempts `src/test/setup.ts` on the grounds that it is a
 * `setupFiles` entry. Each was written here as prose, and prose about a config
 * is the same instrument failure as prose about an import: it can stop being
 * true without anything noticing. Since the parser is already loaded, they are
 * read out of the config and asserted instead.
 */
const VITE_CONFIG = parse(
  readFileSync(join(REPO_ROOT, 'vite.config.ts'), 'utf8'),
  'vite.config.ts',
);

/** The first `name:` property assignment anywhere in `vite.config.ts`. */
function configProperty(name: string): ts.Expression | null {
  let found: ts.Expression | null = null;
  eachNode(VITE_CONFIG, (node) => {
    if (found !== null || !ts.isPropertyAssignment(node)) return;
    if (propertyName(node.name) === name) found = node.initializer;
  });
  return found;
}

function propertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;
}

/** The string elements of an array literal, or `[]` for anything else. */
function stringElements(node: ts.Expression | null): string[] {
  if (node === null || !ts.isArrayLiteralExpression(node)) return [];
  return node.elements.flatMap((element) =>
    ts.isStringLiteralLike(element) ? [element.text] : [],
  );
}

/** The keys of an object literal, or `[]` for anything else. */
function objectKeys(node: ts.Expression | null): string[] {
  if (node === null || !ts.isObjectLiteralExpression(node)) return [];
  return node.properties.flatMap((property) => {
    if (!ts.isPropertyAssignment(property)) return [];
    const name = propertyName(property.name);
    return name === null ? [] : [name];
  });
}

/** Every shipping module, parsed once and kept, since several passes read them. */
const PARSED_MODULES = new Map<string, ts.SourceFile>();

function parsedModule(file: string): ts.SourceFile {
  const cached = PARSED_MODULES.get(file);
  if (cached !== undefined) return cached;
  const parsed = parse(readFileSync(file, 'utf8'), file);
  PARSED_MODULES.set(file, parsed);
  return parsed;
}

/** Every shipping module whose edges and uses are read by a parser. */
function parsedModules(): string[] {
  return shippingModules(SRC_ROOT).filter((file) => extname(file).toLowerCase() !== '.css');
}

/** What one file does with a factory it imports. */
type FactoryUse = {
  /** Times it is called. */
  readonly calls: number;
  /** Every use that is **not** a call, as source text — the loud residue. */
  readonly escapes: readonly string[];
};

/**
 * How a file uses a factory, decided by the parser rather than by matching its
 * name in the file's text.
 *
 * The two boundary assertions at the bottom of this file — the sandbox door is
 * built once, the runtime is built once — used to be `/\bcreateAgentRuntime\s*\(/`
 * over `readFileSync`. That is defect 2 exactly, still standing in the commit
 * that removed it from the extractor, and a third agent broke it in **both**
 * directions in one sitting:
 *
 * - `import { createAgentRuntime as buildRuntime } from '@/runtime/app-runtime'`
 *   plus a function returning `buildRuntime(adapter)` is a real, compiling,
 *   second construction site — the exact thing the assertion exists to forbid —
 *   and the regex never sees the name it is looking for.
 * - `// Historical note: the shell used to call createAgentRuntime( ) itself.`
 *   is a sentence, and it turned the guard **red** against a file that does
 *   nothing. Prose creating a fact, in the file whose finding is that a comment
 *   is not evidence.
 *
 * So the question asked here is the one the product asks: *which binding is this
 * identifier, and where did it come from?* A local name is a factory binding
 * only if an `import` in this file bound it to that export — through a rename,
 * through a namespace import, or through a re-export chain (`exportsReaching`).
 * A comment is trivia and a string is a literal, so neither can produce one.
 *
 * The residue is loud rather than assumed away. A binding that is used as a
 * *value* — assigned, passed, re-exported, wrapped — is a construction site this
 * analysis cannot follow to its call, so it is reported instead of counted as
 * absent. `NOT_SHIPPED` and these two assertions all read absence as proof, and
 * absence is the direction that goes quiet.
 */
function factoryUsesIn(
  parsed: ts.SourceFile,
  isFactory: (specifier: string, exported: string) => boolean,
): FactoryUse {
  const locals = new Set<string>();
  const namespaces = new Map<string, string>();
  eachNode(parsed, (node) => {
    if (!ts.isImportDeclaration(node)) return;
    const clause = node.importClause;
    if (clause === undefined || clause.isTypeOnly) return;
    const specifier = staticSpecifier(node.moduleSpecifier);
    if (specifier === null) return;
    if (clause.name !== undefined && isFactory(specifier, 'default')) locals.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings === undefined) return;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.set(bindings.name.text, specifier);
      return;
    }
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      if (isFactory(specifier, (element.propertyName ?? element.name).text)) {
        locals.add(element.name.text);
      }
    }
  });

  let calls = 0;
  const escapes: string[] = [];
  eachNode(parsed, (node) => {
    let reference: ts.Node | null = null;
    if (ts.isPropertyAccessExpression(node)) {
      const target = node.expression;
      const specifier = ts.isIdentifier(target) ? namespaces.get(target.text) : undefined;
      if (specifier !== undefined && isFactory(specifier, node.name.text)) reference = node;
    } else if (ts.isIdentifier(node) && locals.has(node.text)) {
      const parent = node.parent;
      // The import clause that created the binding is not a use of it, and
      // `something.createAgentRuntime` is a different identifier that happens to
      // be spelled the same.
      const declares =
        parent !== undefined &&
        (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent));
      const names =
        parent !== undefined &&
        ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isQualifiedName(parent) && parent.right === node));
      if (!declares && !names) reference = node;
    }
    if (reference === null) return;
    const parent = reference.parent;
    if (parent !== undefined && ts.isCallExpression(parent) && parent.expression === reference) {
      calls += 1;
      return;
    }
    escapes.push(collapse((parent ?? reference).getText(parsed), 80));
  });
  return { calls, escapes };
}

/** The same analysis over text, for the assertions that drive it directly. */
function factoryUses(
  source: string,
  fileName: string,
  isFactory: (specifier: string, exported: string) => boolean,
): FactoryUse {
  return factoryUsesIn(parse(source, fileName), isFactory);
}

/**
 * Every `module -> exported name` in this tree that reaches one factory.
 *
 * A re-export is a rename with a file boundary in it: `export { createAgentRuntime
 * as make } from '@/runtime/app-runtime'` in a barrel, then `import { make }` and
 * `make(adapter)`, is a second construction site that neither the regex nor a
 * one-hop import check would see. This is a fixpoint over the re-export graph, so
 * the chain can be any length.
 *
 * `export * as ns from` is folded in deliberately conservatively — the namespace
 * object is treated as reaching the factory, which can only ever produce a red
 * that a human resolves, never a silent green.
 */
/**
 * The names one module re-exports that reach the factory, given what its
 * targets export.
 *
 * Split out from the fixpoint so it can be driven directly: the tree contains no
 * barrel over either factory today, so every assertion about re-export
 * laundering would otherwise pass just as well with this rule deleted.
 */
function reExported(
  parsed: ts.SourceFile,
  file: string,
  reaching: (target: string) => ReadonlySet<string> | undefined,
): string[] {
  const found: string[] = [];
  eachNode(parsed, (node) => {
    if (!ts.isExportDeclaration(node) || node.isTypeOnly) return;
    if (node.moduleSpecifier === undefined) return;
    const specifier = staticSpecifier(node.moduleSpecifier);
    if (specifier === null) return;
    const target = resolveSpecifier(file, specifier);
    const exported = target === null ? undefined : reaching(target);
    if (exported === undefined) return;
    const clause = node.exportClause;
    if (clause === undefined) {
      found.push(...exported);
      return;
    }
    if (ts.isNamedExports(clause)) {
      for (const element of clause.elements) {
        if (element.isTypeOnly) continue;
        if (exported.has((element.propertyName ?? element.name).text)) found.push(element.name.text);
      }
      return;
    }
    // `export * as ns from` — the namespace object is folded in deliberately
    // conservatively. It can only ever produce a red a human resolves.
    found.push(clause.name.text);
  });
  return found;
}

/** One parsed module, with the path its specifiers resolve against. */
type ParsedModule = { readonly file: string; readonly parsed: ts.SourceFile };

function exportsReaching(
  factory: string,
  definingModule: string,
  modules: readonly ParsedModule[] = parsedModules().map((file) => ({
    file,
    parsed: parsedModule(file),
  })),
): Map<string, Set<string>> {
  const reaching = new Map<string, Set<string>>([[definingModule, new Set([factory])]]);
  // A chain is followed a hop per pass, so the loop runs until nothing new
  // appears — a barrel over a barrel is two passes, and the bound is the number
  // of modules because that is the longest chain that can exist.
  for (let pass = 0; pass <= modules.length; pass += 1) {
    let changed = false;
    for (const { file, parsed } of modules) {
      const mine = reaching.get(file) ?? new Set<string>();
      for (const name of reExported(parsed, file, (target) => reaching.get(target))) {
        if (mine.has(name)) continue;
        mine.add(name);
        changed = true;
      }
      if (mine.size > 0) reaching.set(file, mine);
    }
    if (!changed) break;
  }
  return reaching;
}

/** Where a factory is built, and every use of it this analysis cannot follow. */
type ConstructionSites = {
  /** Files containing a call to it, by repo path. */
  readonly builders: readonly string[];
  /** `file: text` for every use of it that is not a call. */
  readonly escapes: readonly string[];
};

function constructionSites(factory: string, definingModule: string): ConstructionSites {
  const reaching = exportsReaching(factory, definingModule);
  const builders: string[] = [];
  const escapes: string[] = [];
  for (const file of parsedModules()) {
    if (file === definingModule) continue;
    const uses = factoryUsesIn(parsedModule(file), (specifier, exported) => {
      const target = resolveSpecifier(file, specifier);
      return target !== null && reaching.get(target)?.has(exported) === true;
    });
    if (uses.calls > 0) builders.push(asRepoPath(file));
    for (const escape of uses.escapes) escapes.push(`${asRepoPath(file)}: ${escape}`);
  }
  return { builders: builders.sort(), escapes: escapes.sort() };
}

type Graph = {
  /** Every file the entry reaches, transitively, as an absolute path. */
  readonly reachable: ReadonlySet<string>;
  /** The files `index.html` names in an attribute, resolved. */
  readonly entries: readonly string[];
  /** Every tag in `index.html` that loads or runs something this file cannot read. */
  readonly unreadHtml: readonly string[];
  /** `file: text` for every edge the walk could not follow. */
  readonly unfollowable: readonly string[];
  /** `file: specifier` for every in-tree specifier that resolved to nothing. */
  readonly unresolved: readonly string[];
  /** `file: specifier` for every specifier whose case does not match the disk. */
  readonly miscased: readonly string[];
};

/**
 * Every edge out of a file, each one classified.
 *
 * `walk` used to do this inline and had **no name for the third case**:
 * `resolved === null` was `continue`, whether the specifier was `'react'` or
 * `'./x?raw'`. Naming it is what makes it assertable — the tree has no lost edge
 * today, so an assertion over `GRAPH.unresolved` alone would pass just as well
 * with the classification deleted.
 */
function edgesFrom(file: string, source: string): Edge[] {
  return edgesOf(file, source).map((specifier) => {
    const resolved = resolveSpecifier(file, specifier);
    return { specifier, resolved, lost: resolved === null && pointsIntoThisTree(specifier) };
  });
}

/** Everything `index.html` reaches at runtime, transitively. */
function walk(html: string = readFileSync(HTML_ENTRY, 'utf8')): Graph {
  const loads = htmlLoads(html);
  const reachable = new Set<string>();
  const unfollowable: string[] = [];
  const unresolved: string[] = [];
  const miscased: string[] = [];
  const queue: string[] = [];
  // The same classification the walk gives every other file's edges, applied to
  // the ones `index.html` itself declares. It used to resolve them and drop
  // whatever came back `null`, which put the html on a shorter leash than any
  // module: a mistyped entry read as a clean, and smaller, graph.
  const record = (label: string, edges: readonly Edge[]): void => {
    for (const { specifier, resolved, lost } of edges) {
      if (lost) unresolved.push(`${label}: ${specifier}`);
      if (resolved === null) continue;
      if (miscasedAgainst(specifier, resolved)) {
        miscased.push(`${label}: ${specifier} is on disk as ${basename(resolved)}`);
      }
      if (!reachable.has(resolved)) queue.push(resolved);
    }
  };
  const htmlEdge = (specifier: string): Edge => {
    const resolved = resolveSpecifier(HTML_ENTRY, specifier);
    return { specifier, resolved, lost: resolved === null && pointsIntoThisTree(specifier) };
  };
  const entryEdges = loads.flatMap((load) => (load.kind === 'file' ? [htmlEdge(load.specifier)] : []));
  const entries = entryEdges.flatMap((edge) => (edge.resolved === null ? [] : [edge.resolved]));
  record('index.html', entryEdges);
  const inlineScripts = loads.flatMap((load) => (load.kind === 'inline' ? [load.source] : []));
  // An inline module body is a module. Its imports are edges Rollup follows and
  // its specifiers resolve against the repo root, exactly as the tag's own `src`
  // does — there is no file on disk to enumerate, which is precisely why one of
  // these could put `run-doubles.ts` in the bundle with this file green.
  for (const source of inlineScripts) {
    const label = 'index.html <script type="module">';
    for (const text of inlineUnfollowable(source)) unfollowable.push(`${label}: ${text}`);
    record(label, inlineSpecifiers(source).map(htmlEdge));
  }
  const unreadHtml = loads.flatMap((load) => (load.kind === 'unread' ? [load.text] : []));
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || reachable.has(file)) continue;
    reachable.add(file);
    // A file the bundler loads but that this file declares no edge reader for is
    // a leaf: it is on the graph and nothing comes out of it. `?raw` on a `.md`
    // lands here, which is what `declares every file kind under src/` then reads.
    // It is also why nothing tries to parse a binary as TypeScript.
    const extension = extname(file).toLowerCase();
    if (!SHIPPING_EXTENSIONS.has(extension)) continue;
    const source = readFileSync(file, 'utf8');
    if (extension !== '.css') {
      for (const text of unanalysableImports(source, file)) {
        unfollowable.push(`${asRepoPath(file)}: ${text}`);
      }
    }
    // A lost edge is not the same thing as `'react'`, and a lost edge shrinks
    // `REACHABLE` — the direction `NOT_SHIPPED` reads as proof. It gets said
    // out loud by `record` instead of being `continue`d past.
    record(asRepoPath(file), edgesFrom(file, source));
  }
  return { reachable, entries, unreadHtml, unfollowable, unresolved, miscased };
}

function asRepoPath(file: string): string {
  return relative(REPO_ROOT, file).split('\\').join('/');
}

const GRAPH = walk();
const REACHABLE = GRAPH.reachable;

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

  it('starts where index.html starts, not where this file assumes', () => {
    // If the tag moves, the walk moves. A hard-coded entry is a guard that keeps
    // proving something about a module the product may no longer launch.
    //
    // This list being exactly one file is a fact about today's `index.html`, not
    // a licence to stop reading it. The reader that produced it used to see only
    // `src=` attributes, so an inline `<script type="module">` — a real Vite
    // entry whose body is bundled — was in neither this list nor the graph, and
    // this assertion passed while `run-doubles.ts` sat in `dist/`. What makes
    // the pin safe is not the pin: it is that an inline body is now walked as a
    // module and that anything else in the file reddens `unreadHtml`.
    expect(
      GRAPH.entries.map(asRepoPath),
      'index.html declares no module entry this walk can resolve; the graph below is vacuous',
    ).toEqual(['src/main.tsx']);

    const specifiersOf = (html: string): string[] =>
      htmlLoads(html).flatMap((load) => (load.kind === 'file' ? [load.specifier] : []));
    expect(specifiersOf('<!-- <script type="module" src="/src/ghost.tsx"></script> -->')).toEqual([]);
    expect(specifiersOf('<script type="module" src="/src/main.tsx"></script>')).toEqual([
      '/src/main.tsx',
    ]);
    // Any tag, not a list of tags this file happened to think of. Enumerating
    // which elements may carry an in-tree reference is defect 3 one axis over.
    expect(specifiersOf('<link rel="stylesheet" href="/src/styles/base.css">')).toEqual([
      '/src/styles/base.css',
    ]);
    expect(specifiersOf('<img src="/src/assets/logo.svg">')).toEqual(['/src/assets/logo.svg']);
    expect(specifiersOf('<link rel="preload" as="font" href="https://cdn.example/x.woff2">')).toEqual(
      [],
    );
    // A `src` written inside a script body is a string in a program, not a tag.
    expect(specifiersOf('<script type="module">const s = \'<img src="/src/ghost.tsx">\';</script>'))
      .toEqual([]);
  });

  /**
   * An inline `<script type="module">` is an entry, and its body is a module.
   *
   * This is the hole a third agent walked through after the rebuild above. The
   * reader answered *"what do index.html's script tags name?"* completely and
   * the product's question is *"what does the build load?"* — the same swap this
   * file has now made six times. One line in `index.html`,
   *
   *     <script type="module">import { FakeTurnDriver } from
   *       '/src/runtime/run-doubles.ts'; console.log(new FakeTurnDriver());</script>
   *
   * left every assertion in this file green, `npx tsc -b --force` exit 0 and
   * `npx vite build` exit 0, and put `run-doubles.ts` — the first `NOT_SHIPPED`
   * entry, the test double this whole guard exists to keep out — into
   * `dist/assets/*.js`.
   */
  it('reads an inline module script as the module it is', () => {
    expect(
      GRAPH.unreadHtml,
      'a tag in index.html that runs or fetches something this file cannot read. ' +
        'Everything it loads is invisible to every assertion below, which is how ' +
        'a test double reaches the bundle while this file reports a clean tree',
    ).toEqual([]);

    const inlineOf = (html: string): string[] =>
      htmlLoads(html).flatMap((load) => (load.kind === 'inline' ? [load.source.trim()] : []));
    const unreadOf = (html: string): number =>
      htmlLoads(html).filter((load) => load.kind === 'unread').length;
    const specifiersOfLoad = (html: string): string[] =>
      htmlLoads(html).flatMap((load) => (load.kind === 'file' ? [load.specifier] : []));

    expect(inlineOf('<script type="module">import "/src/main.tsx";</script>')).toEqual([
      'import "/src/main.tsx";',
    ]);
    expect(inlineOf('<script type="module" src="/src/main.tsx"></script>')).toEqual([]);
    expect(inlineOf('<!-- <script type="module">import "/src/ghost.ts";</script> -->')).toEqual([]);

    // And the body is read by the same extractor a `.ts` file is read by, under
    // both grammars, since the tag declares no dialect.
    expect(inlineSpecifiers('import { A } from "/src/runtime/run-doubles.ts";')).toEqual([
      '/src/runtime/run-doubles.ts',
    ]);
    expect(inlineSpecifiers('void import(`/src/runtime/run-doubles.ts`);')).toEqual([
      '/src/runtime/run-doubles.ts',
    ]);
    expect(inlineSpecifiers('const el = <div className="x" />;\nimport "/src/a.ts";')).toEqual([
      '/src/a.ts',
    ]);
    expect(inlineSpecifiers('// import "/src/ghost.ts";')).toEqual([]);
    expect(inlineUnfollowable('void import(name);')).toEqual(['import(name)']);

    // Everything that can execute and is not a module body goes in the loud
    // list rather than being skipped for not matching `type="module"`.
    expect(unreadOf('<script>document.write("<script src=\'/src/ghost.ts\'>")</script>')).toBe(1);
    expect(unreadOf('<script type="importmap">{"imports":{"x":"/src/ghost.ts"}}</script>')).toBe(1);
    expect(unreadOf('<script type="module" src="/src/main.tsx">import "/src/ghost.ts";</script>')).toBe(
      1,
    );
    expect(unreadOf('<script type="module">import "/src/main.tsx";</script>')).toBe(0);
    expect(unreadOf('<script type="module" src="/src/main.tsx"></script>')).toBe(0);

    // The whole walk, driven from a substitute `index.html`. Reading the tag is
    // half the job; the other half is that what it says reaches the graph, and
    // the real file has no lost, mis-cased or inline reference to prove that
    // with. Measured: without these, dropping the html's edges into the queue
    // without classifying them at all leaves this file green in two runs.
    const inline = walk('<script type="module">import "/src/runtime/run-doubles.ts";</script>');
    expect(
      [...inline.reachable].map(asRepoPath),
      'an inline module body reached the reader but not the graph',
    ).toContain('src/runtime/run-doubles.ts');
    expect(inline.entries).toEqual([]);
    expect(walk('<script type="module" src="/src/nothing-here.tsx"></script>').unresolved).toEqual([
      'index.html: /src/nothing-here.tsx',
    ]);
    expect(walk('<script type="module">import "/src/nothing-here.tsx";</script>').unresolved).toEqual(
      ['index.html <script type="module">: /src/nothing-here.tsx'],
    );
    expect(walk('<script type="module">void import(name);</script>').unfollowable).toEqual([
      'index.html <script type="module">: import(name)',
    ]);
    expect(walk('<script>parse("<b>")</script>').unreadHtml.length).toBe(1);

    // Unquoted attribute values are HTML, and a reader that only understood
    // quotes made this tag invisible in both directions at once — no entry, and
    // nothing in the loud list either.
    expect(specifiersOfLoad('<script type=module src=/src/main.tsx></script>')).toEqual([
      '/src/main.tsx',
    ]);
    expect(unreadOf('<script type=text/javascript src=/src/ghost.ts></script>')).toBe(1);
    expect(specifiersOfLoad('<link rel=modulepreload href=/src/runtime/run-doubles.ts>')).toEqual([
      '/src/runtime/run-doubles.ts',
    ]);
    expect(unreadOf('<script type="module" src="/src/main.tsx"')).toBe(1);
  });

  /**
   * The three claims this file makes about `vite.config.ts`, held to the config.
   *
   * `resolveSpecifier` translates exactly one alias prefix. That is not a
   * property of the resolver, it is a property of `resolve.alias`, and a second
   * alias added there would make every specifier using it resolve to `null` —
   * an undercount, which is the direction that reads as a *smaller* graph and
   * lets a `NOT_SHIPPED` entry stay green. Same for `TEST_FILE`, whose safety
   * argument is that it matches `test.include` exactly, and for the
   * `src/test/setup.ts` exemption, whose stated reason is that `setupFiles`
   * names it.
   */
  it('holds its three claims about vite.config.ts to vite.config.ts', () => {
    expect(
      objectKeys(configProperty('alias')),
      'resolveSpecifier translates one alias prefix and this is where the list lives',
    ).toEqual(['@']);
    expect(
      stringElements(configProperty('include')),
      'TEST_FILE is only safe while it is the same set of files vitest runs',
    ).toEqual(['src/**/*.test.{ts,tsx}']);
    expect(
      stringElements(configProperty('setupFiles')),
      'the src/test/setup.ts exemption says setupFiles names it',
    ).toEqual(['./src/test/setup.ts']);

    // And the regex is held to that glob spelling by spelling, not only by the
    // sentence above it. `TEST_FILE` was `/\.test\.[a-z]+$/`, which also skipped
    // names vitest does not run — a stylesheet with a test infix in its name is
    // enumerated by neither instrument, an escape hatch out of both at once — and
    // nothing in this file
    // could tell the two regexes apart. The names below are the difference.
    expect(['a.test.ts', 'a.test.tsx'].filter((name) => TEST_FILE.test(name))).toEqual([
      'a.test.ts',
      'a.test.tsx',
    ]);
    expect(
      ['a.test.css', 'a.test.js', 'a.test.mjs', 'a.tests.ts', 'atest.ts', 'a.ts'].filter((name) =>
        TEST_FILE.test(name),
      ),
      'TEST_FILE skips a file vitest does not run: it is out of both walks at once',
    ).toEqual([]);

    // A fourth claim, and it is the one the whole walk stands on: that
    // `index.html` is where the entries are. It is a default, not a law —
    // `build.rollupOptions.input` and `build.lib` both replace it, and an entry
    // this file never reads is a subgraph it never walks, in the direction
    // `NOT_SHIPPED` reads as proof. So the keys of `build` are pinned: a new one
    // reddens here until somebody says whether it moves the entry.
    expect(
      objectKeys(configProperty('build')).sort(),
      'a build option this guard has not been told about. If it can name an ' +
        'entry — rollupOptions.input, lib — then index.html is no longer the ' +
        'whole question and this file has to read it too',
    ).toEqual(['emptyOutDir', 'outDir', 'sourcemap', 'target']);
  });

  /**
   * The extractor, exercised directly on text rather than on the tree.
   *
   * The walk above is only as good as what counts as an edge, and the failure
   * that matters is the silent one: counting an erased import as reachability
   * reads as a bigger, healthier graph, and dropping a real one reads as a
   * smaller graph in which a test double looks unshipped. On the tree these
   * cases are largely indistinguishable today, which means nothing in this repo
   * would notice if the distinction broke. Hence a control on the function.
   */
  it('counts a value import as an edge and an erased one as nothing', () => {
    expect(specifiers("import { thing } from './a';\n")).toEqual(['./a']);
    expect(specifiers("import './a';\n")).toEqual(['./a']);
    expect(specifiers("const m = await import('./a');\n")).toEqual(['./a']);
    expect(specifiers("import Default, { type A } from './a';\n")).toEqual(['./a']);
    expect(specifiers("import * as ns from './a';\n")).toEqual(['./a']);
    expect(specifiers("import { value, type A } from './a';\n")).toEqual(['./a']);
    expect(specifiers("export * from './a';\n")).toEqual(['./a']);

    expect(specifiers("import type { A } from './a';\n")).toEqual([]);
    expect(specifiers("import type A from './a';\n")).toEqual([]);
    expect(specifiers("export type { A } from './a';\n")).toEqual([]);
    expect(specifiers("import type {\n  A,\n} from './a';\n")).toEqual([]);
  });

  /**
   * An empty brace list is a side-effect import, and `verbatimModuleSyntax` is
   * the reason **for** that rather than against it.
   *
   * The extractor this replaced dropped these two spellings and called the rule
   * "exact for this codebase" on the strength of that flag. Measured instead of
   * reasoned about, with the repo's own compiler options:
   *
   *     import { type A } from './a';   ->  tsc emits  import {} from './a';
   *     export { type A } from './a';   ->  tsc emits  export {} from './a';
   *
   * and a `vite build` over a two-module fixture carrying the same flag put the
   * imported module's top-level `console.log` in the bundle. Drop the edge and
   * the module is still fetched and still runs — while `NOT_SHIPPED`, which
   * reads a module's absence from `REACHABLE` as proof nothing ships it, reports
   * a clean tree.
   *
   * The honest limit, measured rather than assumed: on the real tree this puts
   * a module on the *graph*, and Rollup will still shake it back out if its top
   * level does nothing, which is what happens to `run-doubles` specifically.
   * That boundary is the header's last bullet and it applies to every assertion
   * in this file, not just this one.
   */
  it('counts an all-type brace list as the side-effect import the build emits', () => {
    expect(specifiers("import { type A } from './a';\n")).toEqual(['./a']);
    expect(specifiers("import { type A, type B } from './a';\n")).toEqual(['./a']);
    expect(specifiers("import {} from './a';\n")).toEqual(['./a']);
    expect(specifiers("export { type A } from './a';\n")).toEqual(['./a']);
  });

  /**
   * Prose is not an import — asserted, because this guard twice believed it was.
   *
   * The first four are the shapes the `[\s\S]*?` head fell for. The next two are
   * the ones that survived the `[^;/]` hardening, because that head was added to
   * one of three regexes and the other two matched anywhere in the text: a line
   * comment naming a dynamic import, and a block comment whose interior line
   * begins with a side-effect import. Both were executed against the hardened
   * guard and both laundered a planted orphan onto the graph.
   *
   * None of them can be expressed against a parser, which is the point: a
   * comment is not a node, so there is no rule here doing the excluding that a
   * cleverer sentence could get around.
   */
  it('does not manufacture an edge out of a comment that names a module', () => {
    expect(specifiers("export interface Foo {\n  bar(): void\n}\n\n/**\n * re-exported from './ghost'\n */\n")).toEqual([]);
    expect(specifiers("export function foo() {\n  return 1\n}\n\n// used to be imported from './ghost'\n")).toEqual([]);
    expect(specifiers("export const x = 1;\n/* loaded from './ghost' */\n")).toEqual([]);
    expect(specifiers("export const x = 1;\n// Wave 3 dropped it; it used to be `await import('./ghost')`.\n")).toEqual([]);
    expect(specifiers('export const x = 1;\n/*\nimport \'./ghost\'\n*/\n')).toEqual([]);
    expect(specifiers("const doc = \"see import { a } from './ghost'\";\n")).toEqual([]);
    expect(specifiers("export const x = 1;\n// import('./ghost')\n// import './ghost2'\n")).toEqual([]);

    // The control for the six above: the same shapes, but real code, which must
    // still be found. A fix that returned [] for everything would pass every
    // assertion above and silence the entire guard.
    expect(specifiers("export const x = 1;\nimport { real } from './kept';\n")).toEqual(['./kept']);
    expect(specifiers("export const x = 1;\nvoid import('./kept');\n")).toEqual(['./kept']);
    expect(specifiers("export const x = 1;\nimport './kept';\n")).toEqual(['./kept']);
  });

  /**
   * The two shapes the regex got wrong in the *other* direction, both recovered
   * by the parser rather than by another exclusion class.
   *
   * `[^;/]` cannot cross a slash, so an inline comment inside an import clause
   * dropped a genuine edge and the walk then reported a plainly-imported module
   * as an orphan — a red naming a module anyone can see is imported, whose
   * cheapest green is an exemption entry, which is how `NOT_SHIPPED` starts
   * lying. And `import('./a').Thing` in a type position is fully erased, but the
   * old dynamic-import regex was four bytes and a quote, so it counted it.
   */
  it('follows an import clause that carries a comment, and not a type-position import', () => {
    expect(specifiers("import { /* wired later */ thing } from './a';\n")).toEqual(['./a']);
    expect(specifiers("import {\n  // one day\n  thing,\n} from './a';\n")).toEqual(['./a']);
    expect(specifiers("export type X = typeof import('./a');\n")).toEqual([]);
    expect(specifiers("export type X = import('./a').Thing;\n")).toEqual([]);
  });

  /**
   * A specifier is not "the text between two quotes".
   *
   * A substitution-free template literal is a compile-time constant that Rollup
   * resolves like any other. One line of it at module scope in a file already on
   * the graph — a dynamic import of `../runtime/run-doubles` written with
   * backticks — emitted a `run-doubles` chunk into `dist/` carrying
   * `FakeTurnDriver`, which is the exact thing the first `NOT_SHIPPED` entry
   * exists to prevent, with the guard green twice over.
   */
  it('reads a template-literal specifier, because Rollup does', () => {
    expect(specifiers('void import(`./a`);\n')).toEqual(['./a']);
    expect(specifiers('void import(`../runtime/run-doubles`);\n')).toEqual([
      '../runtime/run-doubles',
    ]);
  });

  /**
   * And when it genuinely cannot follow an edge, it says so instead of shrinking.
   *
   * An undercount is not the safe direction here, however often that gets
   * written down. `NOT_SHIPPED` reads absence from `REACHABLE` as proof, so a
   * dropped edge is a false green on the map whose whole job is keeping test
   * doubles out of the bundle.
   */
  it('reports an edge it cannot follow rather than dropping it', () => {
    expect(unanalysableImports('void import(name);\n')).toEqual(['import(name)']);
    expect(unanalysableImports('void import(`./x/${name}`);\n')).toEqual(['import(`./x/${name}`)']);
    expect(unanalysableImports("const all = import.meta.glob('./f/*.ts');\n")).toEqual([
      "import.meta.glob('./f/*.ts')",
    ]);
    expect(unanalysableImports("const a = require('./a');\n")).toEqual(["require('./a')"]);

    expect(unanalysableImports("void import('./a');\n")).toEqual([]);
    expect(unanalysableImports('void import(`./a`);\n')).toEqual([]);
    expect(unanalysableImports("import { a } from './a';\n")).toEqual([]);
  });

  /**
   * `new URL('./x', import.meta.url)` is an edge, and ESM syntax does not spell it.
   *
   * The extractor above enumerates *import syntax* — declarations, re-exports,
   * `import()`. Vite's asset and worker edge is none of those, so it was neither
   * followed nor reported: the one silent hole left in a function whose stated
   * policy is that it never drops an edge quietly. It is the documented spelling
   * for a module worker, and Rollup emits a chunk for the target — measured, one
   * module-scope `new Worker(new URL('../runtime/run-doubles.ts', import.meta.url),
   * { type: 'module' }))` in a file already on the graph produced
   * `dist/assets/run-doubles-*.js` with this file green in two consecutive runs.
   */
  it('reads the asset and worker edge that is not import syntax', () => {
    expect(specifiers("new Worker(new URL('./w.ts', import.meta.url), { type: 'module' });\n")).toEqual(
      ['./w.ts'],
    );
    expect(specifiers("const u = new URL('./a.png', import.meta.url);\n")).toEqual(['./a.png']);
    expect(specifiers('const u = new URL(`./a.png`, import.meta.url);\n')).toEqual(['./a.png']);

    // A URL a user typed is not a module edge, which is the whole reason the
    // base has to be `import.meta.url` rather than "there is a second argument".
    expect(specifiers("const u = new URL(text);\n")).toEqual([]);
    expect(specifiers("const u = new URL(text, base);\n")).toEqual([]);
    expect(specifiers("const u = new URL('./a.png', base);\n")).toEqual([]);
    expect(unanalysableImports("const u = new URL(text, base);\n")).toEqual([]);

    // And a computed one goes in the loud list with everything else it cannot read.
    expect(unanalysableImports('const u = new URL(name, import.meta.url);\n')).toEqual([
      'new URL(name, import.meta.url)',
    ]);
    expect(unanalysableImports("const u = new URL('./a.png', import.meta.url);\n")).toEqual([]);
  });

  it('follows every edge it finds', () => {
    expect(
      GRAPH.unfollowable,
      'a specifier this walk cannot read statically is one the bundler can. ' +
        'Every entry here is a module that may be in the bundle while every ' +
        'assertion below reports it as unreachable — teach this file the shape, ' +
        'or make the import a literal',
    ).toEqual([]);
  });

  /**
   * A specifier that names a path in this repo and finds nothing is a lost edge.
   *
   * `resolveSpecifier` answering `null` used to mean one of two completely
   * different things, and `walk` treated them identically: `'react'` is a
   * package and correctly ignored, while `'./x?raw'` is a file in this tree that
   * the resolver could not spell. The second was dropped in silence, and a
   * dropped edge makes `REACHABLE` smaller — the direction `NOT_SHIPPED` reads
   * as proof that nothing ships a module.
   *
   * Vite's query suffix is now cut before resolution, so `?raw` is an edge
   * rather than a miss. This assertion is the part that does not depend on
   * knowing the suffix list: whatever spelling comes next — a new Vite query, a
   * typo, an extension `resolveSpecifier` does not try — reddens here naming the
   * file and the specifier, instead of quietly shrinking the graph.
   */
  it('says so when a specifier into this tree resolves to nothing', () => {
    expect(
      GRAPH.unresolved,
      'a specifier naming a path in this repository that resolves to no file. ' +
        'The bundler resolves it or fails the build; either way this walk has ' +
        'lost an edge, and a lost edge is how a module stays absent from ' +
        'REACHABLE while sitting in the bundle',
    ).toEqual([]);

    // The control, driven through the same classifier the walk uses, because the
    // list above is empty today and an empty list proves nothing about the
    // instrument that produced it. A tree with no lost edge in it would pass the
    // assertion above with the whole rule deleted.
    const shell = join(SRC_ROOT, 'app', 'shell', 'AppShell.tsx');

    // The suffix is part of how Vite loads the file, not part of its name. Both
    // of these are edges, and the second one is the one that shipped a double.
    expect(edgesFrom(shell, "import s from './AppShell.module.css?inline';\n")).toEqual([
      {
        specifier: './AppShell.module.css?inline',
        resolved: join(SRC_ROOT, 'app', 'shell', 'AppShell.module.css'),
        lost: false,
      },
    ]);
    expect(
      edgesFrom(shell, "const t = await import('../../runtime/run-doubles.ts?raw');\n").map(
        (edge) => asRepoPath(edge.resolved ?? '<lost>'),
      ),
    ).toEqual(['src/runtime/run-doubles.ts']);

    // A package is not a lost edge; a path in this repo naming no file is.
    expect(edgesFrom(shell, "import 'react';\n")).toEqual([
      { specifier: 'react', resolved: null, lost: false },
    ]);
    expect(edgesFrom(shell, "import '@tauri-apps/api/core';\n")).toEqual([
      { specifier: '@tauri-apps/api/core', resolved: null, lost: false },
    ]);
    expect(edgesFrom(shell, "import './nothing-here.ts?raw';\n")).toEqual([
      { specifier: './nothing-here.ts?raw', resolved: null, lost: true },
    ]);
    expect(edgesFrom(shell, "import '@/nothing-here';\n")).toEqual([
      { specifier: '@/nothing-here', resolved: null, lost: true },
    ]);
    expect(edgesFrom(shell, "import '/src/nothing-here';\n")).toEqual([
      { specifier: '/src/nothing-here', resolved: null, lost: true },
    ]);
  });

  /**
   * CSS is a module, and its comments are prose too.
   *
   * The `.module.css` files were invisible to this guard entirely: not
   * enumerated, and not resolvable, so `import styles from './X.module.css'`
   * produced `null` and CSS was never a node. A stylesheet with no importer was
   * dead shipped source in a directory the walk claimed to govern.
   */
  it('reads a stylesheet as a module, and a CSS comment as prose', () => {
    expect(cssSpecifiers("@import './tokens.css';\n")).toEqual(['./tokens.css']);
    expect(cssSpecifiers('@import url("./tokens.css");\n')).toEqual(['./tokens.css']);
    expect(cssSpecifiers('@import url(./tokens.css);\n')).toEqual(['./tokens.css']);
    expect(cssSpecifiers(".a { composes: b from './other.module.css'; }\n")).toEqual([
      './other.module.css',
    ]);

    expect(cssSpecifiers("/* @import './ghost.css'; */\n")).toEqual([]);
    expect(cssSpecifiers("/*\n@import './ghost.css';\n*/\n.a { color: red }\n")).toEqual([]);
    expect(cssSpecifiers('.a { content: "/*"; }\n@import \'./kept.css\';\n')).toEqual([
      './kept.css',
    ]);

    // A string is not a rule, exactly as a comment is not a node. Measured, not
    // argued: appending the first of these to `src/app/shell/AppShell.module.css`
    // put a planted orphan stylesheet on the graph and every assertion in this
    // file passed, twice over, with dead shipped CSS in `src/features/canvas/`.
    expect(cssSpecifiers('.a { content: "@import \'./ghost.css\'"; }\n')).toEqual([]);
    expect(
      cssSpecifiers('.a { content: "composes: b from \'./ghost.module.css\'"; }\n'),
    ).toEqual([]);

    // `@import` is a top-level rule: a browser ignores one that sits inside a
    // block, so reading one there would be inventing an edge the product has not
    // got. `composes` is the mirror image — a declaration, never at the root.
    expect(cssSpecifiers(".a { @import './ghost.css'; }\n")).toEqual([]);
    expect(cssSpecifiers("composes: b from './ghost.module.css';\n")).toEqual([]);

    // A bare number is not a marker, which is the reason the marker is NUL.
    expect(cssSpecifiers('.a { margin: 0 12 0; }\n')).toEqual([]);

    // A declaration missing its own semicolon does not reach into the next rule
    // for a `from` that belongs to somebody else.
    expect(
      cssSpecifiers(".a { composes: b }\n.c { color: red; from: './ghost.css' }\n"),
    ).toEqual([]);

    const base = join(SRC_ROOT, 'styles', 'base.css');
    expect(
      cssSpecifiers(readFileSync(base, 'utf8')).map((specifier) =>
        asRepoPath(resolveSpecifier(base, specifier) ?? '<unresolved>'),
      ),
      'base.css is the only stylesheet main.tsx imports; the rest hang off it',
    ).toEqual(['src/styles/typeface.css', 'src/styles/tokens.css']);
  });

  it('resolves a stylesheet specifier to the stylesheet', () => {
    const shell = join(SRC_ROOT, 'app', 'shell', 'AppShell.tsx');
    expect(asRepoPath(resolveSpecifier(shell, './AppShell.module.css') ?? '')).toBe(
      'src/app/shell/AppShell.module.css',
    );
    expect(resolveSpecifier(shell, './nothing-here.module.css')).toBeNull();
  });

  /**
   * The universe, asserted in both directions.
   *
   * This is the assertion that makes the extension list a rule rather than a
   * preference. The enumerator this replaced said `/\.tsx?$/` and 43 `.css`
   * files were outside the question — the same shape as the walk that once
   * covered one directory of a product shipping several, one axis over. A new
   * kind of file under `src/` now reddens here until somebody says whether the
   * bundler loads it.
   */
  it('declares every file kind under src/', () => {
    const present = extensionsUnder(SRC_ROOT);
    const declared = new Set([...SHIPPING_EXTENSIONS.keys(), ...NOT_LOADED_EXTENSIONS.keys()]);

    expect(
      [...present].filter((extension) => !declared.has(extension)).sort(),
      'a file kind under src/ that this file has never heard of. If the bundler ' +
        'loads it, it belongs in SHIPPING_EXTENSIONS with something that reads ' +
        'its edges; if not, in NOT_LOADED_EXTENSIONS with why. It does not get ' +
        'to be neither, because neither is how 43 stylesheets went ungoverned',
    ).toEqual([]);
    expect(
      [...declared].filter((extension) => !present.has(extension)).sort(),
      'declared under src/ and no longer there. A stale declaration reads exactly ' +
        'like a governed tree',
    ).toEqual([]);

    // And the declaration is tied to what the enumerator actually walks, not
    // only to what is on disk. Without this the two can drift silently: `.css`
    // can be declared shipping, sit in `src/`, satisfy both assertions above,
    // and still never be enumerated — which is precisely the state this file
    // was in, with 43 stylesheets declared by nothing and walked by nothing.
    expect(
      [...new Set(shippingModules(SRC_ROOT).map((file) => extname(file).toLowerCase()))].sort(),
      'the enumerator walks a different set of file kinds than SHIPPING_EXTENSIONS declares',
    ).toEqual([...SHIPPING_EXTENSIONS.keys()].sort());

    // The third direction, and the one the `.md` entry previously stated in
    // prose: "if one is ever imported as `?raw` it has become a shipping kind
    // and this entry has to move". Prose cannot enforce that. The walk can, now
    // that `?raw` resolves — a file whose kind is declared *not loaded* turning
    // up on the graph means the declaration is false, and a false declaration in
    // this map is how the 43 stylesheets went ungoverned in the first place.
    expect(
      [...REACHABLE]
        .filter((file) => NOT_LOADED_EXTENSIONS.has(extname(file).toLowerCase()))
        .map(asRepoPath)
        .sort(),
      'this file kind is declared NOT_LOADED_EXTENSIONS and the entry point ' +
        'reaches it. Either the import is wrong or the declaration is: move the ' +
        'extension to SHIPPING_EXTENSIONS and say what reads its edges',
    ).toEqual([]);
  });

  it('reaches every shipping module under src/ from index.html', () => {
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

  it('resolves every specifier to the name the filesystem actually uses', () => {
    // `existsSync` is case-blind on NTFS, and `forceConsistentCasingInFileNames`
    // only covers paths `tsc` resolves — which excludes every `.css` specifier,
    // since those match an ambient wildcard module in `vite/client` and are
    // never looked up on disk. On a case-sensitive filesystem, or in a Docker
    // build, a mis-cased stylesheet import is a blank screen.
    expect(GRAPH.miscased, 'a specifier whose case does not match the file on disk').toEqual([]);

    // The control, against a real file, because the tree has no mis-cased
    // specifier today and an assertion over an empty list proves nothing about
    // the instrument that produced it. `readdirSync` answers with the disk's
    // spelling where `existsSync` would just have said "yes".
    const shell = join(SRC_ROOT, 'app', 'shell', 'AppShell.tsx');
    const wrongCase = resolveSpecifier(shell, './appshell.module.css');
    expect(asRepoPath(wrongCase ?? '')).toBe('src/app/shell/AppShell.module.css');
    expect(miscasedAgainst('./appshell.module.css', wrongCase ?? '')).toBe(true);
    expect(miscasedAgainst('./AppShell.module.css', wrongCase ?? '')).toBe(false);
    expect(miscasedAgainst('.', join(SRC_ROOT, 'index.ts'))).toBe(false);
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
  it('reaches the sandbox door from the entry', () => {
    const door = 'src/data/sandbox-repository.ts';
    expect(canonical(join(REPO_ROOT, door)), `${door} moved; fix this guard`).not.toBeNull();
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
    const sites = constructionSites(
      'createSandboxRepository',
      join(SRC_ROOT, 'data', 'sandbox-repository.ts'),
    );

    expect(
      sites.escapes,
      'the factory is used here as a value rather than called, so this file ' +
        'cannot say where the door actually gets built. Call it at the ' +
        'composition root, or teach this analysis the shape',
    ).toEqual([]);
    expect(
      sites.builders,
      'the renderer door to the sandbox commands is built once, at the ' +
        'composition root, and handed down — a surface that builds its own host ' +
        'is how the boundary ended up inside the process it constrains',
    ).toEqual(['src/app/App.tsx']);
  });

  /**
   * The two assertions above and below are only worth their names if the thing
   * they read is a binding rather than a spelling.
   *
   * Two of the files this assertion reads name `createSandboxRepository` in a
   * doc comment right now — `CanvasSurface.tsx` once, `document-host-double.ts`
   * twice. The regex this replaced missed all three sentences only because none
   * of them happens to be followed by an open parenthesis; a fourth that was
   * would have reddened this file against a module that builds nothing. And the rename in
   * the first case below compiles, runs, and is exactly the second construction
   * site the assertion exists to forbid.
   */
  it('reads a construction site as a binding, not as a spelling', () => {
    const fromRuntime = (specifier: string, exported: string): boolean =>
      specifier === '@/runtime/app-runtime' && exported === 'createAgentRuntime';
    const uses = (source: string): FactoryUse => factoryUses(source, 'probe.tsx', fromRuntime);

    // The evasion, in the spelling it was executed in.
    expect(
      uses(
        "import { createAgentRuntime as buildRuntime } from '@/runtime/app-runtime';\n" +
          'export const make = (a: A) => buildRuntime(a);\n',
      ),
    ).toEqual({ calls: 1, escapes: [] });
    expect(
      uses("import { createAgentRuntime } from '@/runtime/app-runtime';\ncreateAgentRuntime(a);\n"),
    ).toEqual({ calls: 1, escapes: [] });
    expect(
      uses("import * as rt from '@/runtime/app-runtime';\nrt.createAgentRuntime(a);\n"),
    ).toEqual({ calls: 1, escapes: [] });

    // The inverse: prose cannot make a construction site, which is the direction
    // that reddens an innocent file and gets fixed by weakening the assertion.
    expect(uses('// the shell used to call createAgentRuntime( ) itself\n')).toEqual({
      calls: 0,
      escapes: [],
    });
    expect(uses("const doc = 'createAgentRuntime(adapter)';\n")).toEqual({ calls: 0, escapes: [] });
    expect(uses('/**\n * createAgentRuntime(adapter)\n */\nexport const x = 1;\n')).toEqual({
      calls: 0,
      escapes: [],
    });
    // A different module exporting the same name is a different function, and a
    // local one is not imported at all.
    expect(
      uses("import { createAgentRuntime } from './elsewhere';\ncreateAgentRuntime(a);\n"),
    ).toEqual({ calls: 0, escapes: [] });
    expect(uses('function createAgentRuntime() {}\ncreateAgentRuntime();\n')).toEqual({
      calls: 0,
      escapes: [],
    });
    expect(uses("import { other } from '@/runtime/app-runtime';\nother(a);\n")).toEqual({
      calls: 0,
      escapes: [],
    });
    // A type-only import builds nothing; the value it names is erased.
    expect(
      uses("import type { createAgentRuntime } from '@/runtime/app-runtime';\nconst x = 1;\n"),
    ).toEqual({ calls: 0, escapes: [] });

    // And a binding used as a value goes in the loud list rather than counting
    // as absence, because absence is what the assertions above read as proof.
    expect(
      uses("import { createAgentRuntime } from '@/runtime/app-runtime';\nconst make = createAgentRuntime;\n"),
    ).toEqual({ calls: 0, escapes: ['make = createAgentRuntime'] });
    expect(
      uses("import { createAgentRuntime } from '@/runtime/app-runtime';\nexport { createAgentRuntime };\n"),
    ).toEqual({ calls: 0, escapes: ['createAgentRuntime'] });
    expect(
      uses("import { createAgentRuntime } from '@/runtime/app-runtime';\nuse(createAgentRuntime);\n"),
    ).toEqual({ calls: 0, escapes: ['use(createAgentRuntime)'] });
  });

  /**
   * A re-export is a rename with a file boundary in it.
   *
   * `export { createAgentRuntime as make } from '@/runtime/app-runtime'` in one
   * module and `make(adapter)` in another is a second construction site that a
   * one-hop import check cannot see, and the chain can be any length. There is
   * no barrel over either factory in this tree, so every assertion above would
   * pass with the whole fixpoint deleted — hence this, which drives it.
   *
   * The module *paths* below are real, because specifiers resolve against them;
   * the sources are not. That keeps a two-hop chain testable without planting
   * two files in `src/` and leaving them there.
   */
  it('follows a factory through a re-export chain, however long', () => {
    const runtime = join(SRC_ROOT, 'runtime', 'app-runtime.ts');
    const shell = join(SRC_ROOT, 'app', 'shell', 'AppShell.tsx');
    const app = join(SRC_ROOT, 'app', 'App.tsx');
    const module = (file: string, source: string): ParsedModule => ({
      file,
      parsed: parse(source, file),
    });

    // The far end of the chain is visited **first**, deliberately. One pass is
    // enough whenever the modules happen to come in dependency order, and the
    // order they really come in is whatever `readdirSync` returns — so a control
    // written the easy way round passes with the fixpoint deleted. Measured:
    // with these two swapped, cutting the loop to a single pass leaves this file
    // green in two consecutive runs.
    const chain = exportsReaching('createAgentRuntime', runtime, [
      module(app, "export { make as build } from './shell/AppShell';\n"),
      module(shell, "export { createAgentRuntime as make } from '@/runtime/app-runtime';\n"),
    ]);
    expect([...(chain.get(shell) ?? [])]).toEqual(['make']);
    expect(
      [...(chain.get(app) ?? [])],
      'a two-hop chain needs the fixpoint; one pass reaches the first barrel only',
    ).toEqual(['build']);

    // `export *` carries it, a type-only re-export does not, and a name that is
    // not the factory is not the factory.
    const reaching = (target: string): ReadonlySet<string> | undefined =>
      target === runtime ? new Set(['createAgentRuntime']) : undefined;
    const names = (source: string): string[] =>
      reExported(parse(source, shell), shell, reaching);
    expect(names("export * from '@/runtime/app-runtime';\n")).toEqual(['createAgentRuntime']);
    expect(names("export { createAgentRuntime } from '@/runtime/app-runtime';\n")).toEqual([
      'createAgentRuntime',
    ]);
    expect(names("export type { createAgentRuntime } from '@/runtime/app-runtime';\n")).toEqual([]);
    expect(names("export { other } from '@/runtime/app-runtime';\n")).toEqual([]);
    expect(names("export { createAgentRuntime } from './AppShell.module.css';\n")).toEqual([]);
    expect(names("// export { createAgentRuntime } from '@/runtime/app-runtime';\n")).toEqual([]);
  });

  it('names every exemption, and every exemption is still off the graph', () => {
    // An exemption that has stopped applying reads exactly like a clean tree, so
    // both maps are asserted in both directions rather than trusted. For
    // NOT_SHIPPED a hit means a test helper reached the bundle. For
    // AWAITING_A_SURFACE it means somebody did the work — good news, and the
    // entry has to go, because a debt list nobody is made to update is a comment.
    for (const [path] of NOT_SHIPPED) {
      expect(canonical(join(REPO_ROOT, path)), `${path} moved; fix NOT_SHIPPED`).not.toBeNull();
      expect(
        REACHABLE.has(join(REPO_ROOT, path)),
        `${path} is exempt because nothing ships it. It is now on the graph: ` +
          'either that is the bug, or the exemption should go.',
      ).toBe(false);
    }
    for (const [path, waitingFor] of AWAITING_A_SURFACE) {
      expect(
        canonical(join(REPO_ROOT, path)),
        `${path} moved; fix AWAITING_A_SURFACE`,
      ).not.toBeNull();
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
    //
    // The exclusion this replaced was the whole of `src/runtime/`, on the
    // grounds that the factory lives there. Only its own module needs excusing,
    // and the wider skip meant a second builder written next door to the first
    // was the one place this assertion could not see.
    const sites = constructionSites('createAgentRuntime', join(SRC_ROOT, 'runtime', 'app-runtime.ts'));

    expect(
      sites.escapes,
      'the runtime factory is used here as a value rather than called; where it ' +
        'is finally built is then invisible to this assertion',
    ).toEqual([]);
    expect(sites.builders, 'the runtime is built once, at the composition root').toEqual([
      'src/app/App.tsx',
    ]);
  });
});
