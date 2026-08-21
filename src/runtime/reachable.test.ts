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
 * ## Twenty-eight times this asked a narrower question than the product's
 *
 * Each entry below was executed against the guard as it then stood, not argued
 * from reading it, and every one after the first was found in the fix for an
 * earlier one. 6 and 7 are both holes in the single commit that closed 2 — the
 * one that moved the extractor onto a parser and made stylesheets and the html
 * entry first-class in the same breath. 8 *is* 2, carried forward untouched
 * through both rebuilds that cited it, two assertions below the extractor they
 * rewrote. 9 is 2 again inside the fix for 7; 12 is 5's own diagnosis applied to
 * uses instead of imports; 13 is 6's sentence in the consumer of the function
 * written to close 6; and 14 is 8's finding — a name is not a binding — in a
 * config reader. 15 is inside the tokenizer written to close 9; 16 and 17 are
 * both inside the CSS reader rebuilt to close 13; 18 is inside the config reader
 * written to close 14. 23 through 28 are the sixth round's, and they are all in
 * the *traversal* around tables the fifth round had copied correctly: which
 * nodes the table is applied to, where the regexes are run, which attribute
 * spellings count, which attributes are CSS at all, which channel is a channel,
 * and which node kind creates a binding. So the list is kept rather than tidied
 * away: the recurrence is the finding, and five rounds did not break it. What
 * round six does about it is not another entry in the same shape — it is
 * `reads what the build reads, and reaches nothing the build did not`, which
 * runs `vite build` and compares its module set against this walk's, so that a
 * twenty-ninth divergence is a failing assertion rather than the next finding.
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
 *    been sent`, which occurs in exactly one file under `src/` — asserted by
 *    `the marker that proves a double reached dist/ names exactly one file`,
 *    because for six rounds it was a fact about the tree that only prose kept
 *    true. Present in the bundle with the plant (221 modules transformed) and
 *    absent from the control build of the unmodified tree (219 modules).
 *
 *    So `htmlLoads` replaces `htmlEntries` and inverts the question: an inline
 *    module body is walked as the module it is, and a `<script>` whose body this
 *    file does not parse — a classic one, an import map, one carrying both a
 *    `src` and a body — goes in `unreadHtml` and **reddens**. The sentence that stood here as well, that *any* `src=`/`href=`
 *    into this tree is an edge whatever tag carries it, was false about the
 *    product in both directions and 10 and the `HTML_ASSET_SOURCES` table are
 *    what replaced it; `unreadHtml` is a named list of shapes, not a promise
 *    about everything. `build.rollupOptions.input` and `build.lib` can move the
 *    entry out of `index.html` altogether, so the keys of `build` are pinned
 *    against `vite.config.ts` as well.
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
 * 9. **It decided what was prose before it knew what was a script body.**
 *    `htmlLoads` stripped `<!-- … -->` with a regex and *then* pulled `<script>`
 *    elements out of what was left. Inside a raw-text element there is no comment
 *    syntax, so a `<!--` typed in one module script's body and a `-->` typed in a
 *    later one deleted the tag between them from the reader's view while Vite
 *    compiled and bundled it. Executed: guard green twice, `tsc -b --force` exit
 *    0, `vite build` exit 0 at 223 modules against a 219-module control, and `no
 *    turn has been sent` — a string in exactly one file under `src/`, which
 *    `the marker that proves a double reached dist/ names exactly one file`
 *    now asserts rather than assumes — inside `dist/assets/index-*.js` and
 *    absent from the control. That is defect 2's
 *    shape (a reader confusing code and prose) inside the function written to
 *    close defect 7. The fix at the time was a one-pass tokenizer, where the
 *    question of which layer runs first cannot be asked — and that tokenizer is
 *    defect 15, because its own termination rules were three more guesses at the
 *    grammar.
 *
 * 10. **It gave an HTML attribute a module specifier's rules.**
 *    `pointsIntoThisTree` demands `.`, `/` or an alias prefix, which is right for
 *    an ESM specifier and wrong for a `src=` attribute, where a bare path is
 *    relative to the document. `<script type="module" src="src/runtime/run-doubles.ts">`
 *    is resolved by Vite — 220 modules transformed against a 219-module control,
 *    build exit 0 — and was classified as neither a `file` nor an `unread`:
 *    invisible in both directions at once, guard green twice. `resolveHtmlReference`
 *    is the separate rule, and `externalReference` is what draws the line, by
 *    scheme rather than by prefix.
 *
 * 11. **It made a module's identity a string the specifier spelled.**
 *    `existsSync` was replaced by `readdirSync` because `existsSync` is
 *    case-blind on NTFS. The replacement respelled only the **basename** — its
 *    own doc said as much — and `walk` keys `REACHABLE` on what it returns, while
 *    `NOT_SHIPPED` looks a module up under `join(REPO_ROOT, 'src/runtime/…')`. So
 *    `import('../Runtime/run-doubles.ts?raw')`, one capital letter from an
 *    ordinary edge, went onto the graph under a key spelled `Runtime` and the
 *    exemption asked for `runtime`, got `false`, and the double this file exists
 *    to exclude shipped in `dist/assets/run-doubles-*.js` with every assertion
 *    green, `tsc` exit 0 (`?raw` matches an ambient wildcard, so `tsc` never
 *    resolves the path) and `vite build` at 220 modules against 219. The
 *    case-blindness had moved out of the filesystem call and into the `Set` key.
 *    `canonical` now walks every segment from `REPO_ROOT` down, and the casing
 *    fault is `requested !== file` over the whole path rather than a second
 *    function re-deriving it from a basename.
 *
 * 12. **It enumerated *use* syntax and called that every use.** Defect 5's
 *    diagnosis was that the extractor enumerated import syntax; `factoryUsesIn`
 *    resolved bindings through renames, namespaces and a re-export fixpoint and
 *    then asked *which syntax node* a use was, matching `Identifier` and
 *    `PropertyAccessExpression`. `appRuntime['createAgentRuntime'](adapter)` is
 *    an `ElementAccessExpression`, and the namespace identifier is in
 *    `namespaces` rather than `locals`, so the call was neither counted in
 *    `calls` nor pushed into `escapes` — neither an entry nor loud, which is the
 *    failure §7 names. The plant is a real second construction site:
 *    `export function buildShellRuntime(adapter: PlatformAdapter): HarnessRuntime
 *    { return appRuntime['createAgentRuntime'](adapter); }` appended to
 *    `AppShell.tsx` compiles at `npx tsc -b --force` exit 0 under this repo's
 *    `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, and
 *    against this file it now reddens twice naming
 *    `[ 'src/app/App.tsx', …(1) ]`. The whole difference was `.` against `['…']`.
 *    Now a reference to a namespace object is closed over rather than
 *    enumerated: a member read this file can name, a member read it cannot, or
 *    the object going somewhere — and the last two are `escapes`.
 *
 * 13. **It gated a CSS rule by position and never by file kind.** `cssSpecifiers`
 *    correctly puts `@import` at the root and `composes` inside a block, and then
 *    applied both to every stylesheet. Vite runs the CSS-modules transform on
 *    `*.module.css` and nothing else, so `composes` in a plain stylesheet is an
 *    unknown declaration copied through and honoured by nobody — prose to the
 *    bundler, an edge to the reader, which is defect 6's sentence verbatim inside
 *    the consumer of the function written to close defect 6. One line appended to
 *    `src/styles/typeface.css` laundered a planted orphan `.module.css` onto the
 *    graph: `vite build` at 219 modules, identical to the control, the orphan's
 *    marker in no file under `dist/`, and the laundering line itself shipped as
 *    inert text in `dist/assets/*.css`. The first spelling of that attack, through
 *    `base.css`, was blocked — by the hand-written specifier list in
 *    `base.css is the only stylesheet main.tsx imports`, which `typeface.css` and
 *    `tokens.css` do not have. A pin protects one value somebody wrote down.
 *    `isCssModule` is the rule, and `cssInert` keeps the other direction loud.
 *
 * 14. **It identified a config property by its name.** `configProperty` returned
 *    the initializer of the first `PropertyAssignment` named `alias` anywhere in
 *    `vite.config.ts`, with no path and no parent check. Moving the `test:` block
 *    above `resolve:` — an inert reordering of an object literal — and giving it
 *    a decoy `test.alias` let `resolve.alias` grow a second prefix while
 *    `holds its claims about vite.config.ts to vite.config.ts` went green, and
 *    `'~/runtime/run-doubles.ts?raw'` then failed `pointsIntoThisTree`, was not
 *    lost, and was dropped in the silent `continue` defect 5 abolished: `vite
 *    build` at 220 modules against 219, `run-doubles-*.js` emitted. §8 of this
 *    list is that a name is not a binding; that is what a config reader keyed on
 *    a bare name is. The path is walked from the object the module exports, and
 *    the alias prefixes are read out of it rather than listed in this file.
 *
 *    The four above were found in one sitting by a fifth agent, and they share a
 *    shape worth naming rather than tidying away: each fix replaced an
 *    enumeration with a **narrower** enumeration and then wrote a comment
 *    claiming a property. Where this file genuinely held that round it held by
 *    hand-written pins — `GRAPH.entries`, `base.css`'s specifier list — and a pin
 *    is not a property either. So each of 9–14 is closed by a rule with its own
 *    control, and the two places a pin was the only defence now have one:
 *    `HTML_ASSET_SOURCES` is compared against the installed bundler's own table,
 *    and `composes` is gated by file kind everywhere rather than enumerated in
 *    one stylesheet's expected list.
 *
 * 15. **It hand-rolled the parser the bundler already ships.** `scanHtml` closed
 *    defect 9 by tokenizing in one pass, and then decided what markup *is* with
 *    three termination rules and one attribute rule of its own. Each of the four
 *    was narrower than the spec, and each was executed against it, green twice at
 *    30 assertions with `tsc -b --force` exit 0 and `vite build` exit 0:
 *
 *    - A comment ends at `--!>` as well as `-->`. `<!-- build note --!>` before an
 *      inline module script erased the rest of `index.html` from the reader while
 *      Vite compiled it: 221 modules against a 219-module control, `no turn has
 *      been sent` in `dist/assets/index-*.js` and absent from the control.
 *    - A raw-text element ends at `</script` followed by whitespace, `/` or `>`.
 *      Requiring the `>` let `</script/>` or `</script x>` in a body swallow a
 *      real module script tag. Measured with the `</script/>` spelling: `vite
 *      build` exit 0 at 221 modules against a 219-module control, printing
 *      `parse5 error code end-tag-with-trailing-solidus` — the parser recording
 *      that it ended the element exactly where this reader did not.
 *    - `tagEnd` treated `'` inside an **unquoted** attribute value as a quote and
 *      jumped to the next `'` in the document. `<div id="root" title=Vela's>` …
 *      `<span data-note=don't>` swallowed the inline module script between them,
 *      and the swept-up attribute values resolved to nothing, so the loud branch
 *      never fired: 221 modules against 219, the double's bytes in the shipped
 *      entry chunk.
 *    - `attributesOf` built a `Map` and `set` each name as it went, so a repeated
 *      attribute resolved to the **last**; HTML resolves it to the first. One
 *      extra `src=` on the tag this file already reads —
 *      `<script type="module" src="/src/runtime/run-doubles.ts" src="/src/main.tsx">`
 *      — left `GRAPH.entries` pinned to exactly `['src/main.tsx']`, the value the
 *      pin exists to protect, while `vite build` compiled **5 modules against a
 *      219-module control**: the guard green over a bundle containing none of the
 *      renderer.
 *
 *    **Three** comments in the version this replaces argued the tokenizer was
 *    wrong "in the loud direction" — the module docblock's own list of what it
 *    could not see, `scanHtml`'s docblock, and an inline comment inside
 *    `reads a script body as text`. The sentence that stood here said two, and
 *    put a phrase in quotation marks ("wrong only in the loud direction") that
 *    none of the three wrote. Three of the four above are wrong in the *quiet*
 *    one, which is the point the miscount was making badly. The fix is
 *    not a fourth rule: `vite build` parses `index.html` with **parse5**, and so
 *    does the `jsdom` environment this test already runs in, so `htmlElements`
 *    asks the DOM instead of guessing at the grammar a fourth time. Be exact
 *    about what that is worth — it is agreement on the *spec*, not on a binary.
 *    Vite carries its own parse5 bundled into `node_modules/vite/dist/node/
 *    chunks/dist.js` and declares it as a devDependency at `^8.0.0`; jsdom
 *    depends on parse5 at `^7.2.1` and `node_modules/.pnpm` holds that one,
 *    `parse5@7.3.0`. Two copies, two majors, one WHATWG tokenizer. A behavioural
 *    divergence between those majors is a hole nothing here would notice, and it
 *    is named in "What it still cannot see" rather than left implied. What is
 *    still this file's own is which attributes are asset references and which
 *    bodies are modules, and both of those are checked against vite rather than
 *    asserted.
 *
 * 16. **It had no form at all for the CSS edge the bundler follows most often.**
 *    `cssSpecifiers` read `@import` and `composes` and wrote that "a form not
 *    listed here drops an edge, and a dropped edge reddens the walk naming the
 *    file it lost". `url()` was not listed. It is not exotic — `src/styles/
 *    typeface.css` uses it four times and the control build emits four woff2
 *    files from it — and appending
 *
 *        .vela-diagnostics-mark { background-image: url('../runtime/run-doubles.ts'); }
 *
 *    to `src/styles/base.css` dropped that edge in total silence: guard green
 *    twice at 30/30, `tsc -b --force` exit 0, `vite build` exit 0 at **219
 *    modules transformed — the control's own count**, because an asset is not a
 *    module, and `dist/assets/run-doubles-*.ts` holding all 10636 bytes of the
 *    first `NOT_SHIPPED` entry. The quietest evasion this file has taken, and the
 *    comment claiming it could not happen was the reason nobody looked.
 *    `urlTargets` is the form; the four faces are on the graph as a result.
 *
 * 17. **It gated `@import` on brace depth and called that position.** `readCss`'s
 *    own doc stated the real rule — "a browser ignores one that appears after any
 *    other rule" — and the code implemented "outside every `{ … }`", which is a
 *    different sentence. An `@import` appended after five `@font-face` rules in
 *    `src/styles/typeface.css` was an edge to this reader and dead text to
 *    everything else, laundering a planted orphan stylesheet onto the graph:
 *    guard green twice at 30/30, `vite build` exit 0 at **219 modules,
 *    identical to the control**, the orphan's marker in no file under `dist/`,
 *    and vite's own postcss printing `@import must precede all other statements
 *    (besides @charset or empty @layer)` into the log the guard went green over.
 *    That is defect 13 one axis across: 13 taught the reader which *file kind*
 *    honours a rule and left which *position* honours it exactly as wrong as it
 *    was. `importRules` tracks the preamble, and a late one is reported by
 *    `cssInert` rather than dropped.
 *
 * 18. **It pinned the two ways the author could think of to move the entry.** The
 *    keys of `build` were pinned because `rollupOptions.input` and `lib` replace
 *    `index.html`. A third way is `plugins`: a `transformIndexHtml` hook at
 *    `order: 'pre'` rewrites the document *before* the build parses it for
 *    entries. `index.html` on disk stayed byte-identical, so the tokenizer,
 *    `GRAPH.entries` and every HTML assertion saw what they always saw, while
 *    `vite build` hoisted an injected inline module script into the entry chunk:
 *    221 modules against a 219-module control, `no turn has
 *    been sent` in `dist/assets/index-*.js`. `grep` for `plugins` or
 *    `publicDir` in this file
 *    returned nothing — neither key was read anywhere in 3459 lines. This is §8's
 *    lesson (a name is not a binding) as "a key list is not a config", and the
 *    honest note is that the fix is still an enumeration: the top-level keys of
 *    the exported object and the callees in `plugins` are pinned, which closes
 *    "the config grew a door" and does not close "a door changed behind its own
 *    name". Reading the build's own entry set instead of the config's shape is
 *    the structural fix, and §22 is where that got done: `recordBuild` captures
 *    rollup's `input` in a `buildStart` hook, and `the build reaches the
 *    renderer, and every shipping module under src/` asserts what it captured.
 *
 * 19. **It asked the parser for the document, and the bundler reads the parse.**
 *    Defect 15's fix was to stop hand-rolling a tokenizer and use the parser
 *    `vite build` uses. It was implemented as
 *    `new DOMParser().parseFromString(html, 'text/html').querySelectorAll('*')`,
 *    which is the element tree of the **document** — and a `<template>`'s
 *    children are not in it. parse5 puts them in a `DocumentFragment` hanging off
 *    the element and vite's traversal descends into it, so
 *    `<template><script type="module">import … '/src/runtime/run-doubles.ts'…
 *    </script></template>` was a tag the bundler compiled and this file had no
 *    node for: 221 modules against a 219-module control, the double's bytes in
 *    the shipped entry chunk, guard green at 30/30. The docblock above the
 *    selector asserted the absolute that "a tag the bundler cannot see is a tag
 *    this file cannot see either — agreement rather than a direction", and the
 *    round-4 critic's verdict records that as the fourth round running in which
 *    this file shipped a false absolute. Same parser is not the same question.
 *
 * 20. **It added the CSS form it had been shown, not the class the bundler has.**
 *    Defect 16 was `url()` missing. The fix added `url()`. Vite's CSS url
 *    replacer is one postcss plugin that tests each declaration value against
 *    **two** regexes and rewrites whichever matched, so `image-set()` goes
 *    through the same resolver — and
 *    `image-set('../runtime/run-doubles.ts' 1x)` in `src/styles/base.css` shipped
 *    the first `NOT_SHIPPED` entry into `dist/assets/run-doubles-*.ts` at **219
 *    modules transformed, the control's own count**, with the guard green at
 *    30/30 and nothing in the build log. Because an asset is not a module, even
 *    a reviewer diffing build output sees the same count as the control. This is
 *    16's shape exactly, one function across and one round later: an asset form
 *    the reader had no pattern for, shipping the whole file in silence. And the
 *    file's own prose already listed `image-set` as "a silent drop" — the listing
 *    was accurate the whole time, which is this list's project-level finding
 *    restated: honest prose is not a guard.
 *
 * 21. **It read the alias facts out of *a* config.** Defect 5's fix stopped
 *    listing alias prefixes and started reading `resolve.alias` out of
 *    `vite.config.ts`, and wrote down the principle — "a prefix list is a config
 *    fact; writing one here is prose about a config". A tree can declare a
 *    specifier-moving prefix in more than one file. `"imports": { "#runtime/*":
 *    "./src/runtime/*.ts" }` in `package.json`, plus one
 *    `void import('#runtime/run-doubles')` in a module already on the graph, put
 *    the double in `dist/assets/` at 220 modules against 219 with `tsc -b
 *    --force` exit 0 and the guard green at 30/30 — because `pointsIntoThisTree`
 *    knew `.`, `/` and the config's own prefixes, and a `#` specifier is none of
 *    those, so it was neither an edge nor lost. Defect 5's silent `continue`, one
 *    config *file* over instead of one config *key* over.
 *
 * 22. **It read the config's named properties and called that the config.**
 *    `configProperty`, `objectKeys` and `aliasesIn` each begin
 *    `if (!ts.isPropertyAssignment(property)) continue;`. A `SpreadAssignment`
 *    has no name, so a trailing `...packaging` in the exported literal contributed
 *    nothing to `objectKeys(VITE_CONFIG_ROOT)` — still exactly the five keys the
 *    pin listed — while at runtime it **overwrote** `plugins`, whose own
 *    `plugins: [react()]` was still on the page for `calleeNames` to read and
 *    still answered `['react']`. Both pins written to close defect 18 passed over
 *    a config vite never received, and the build shipped the double at 221 modules
 *    against 219. §8 again — a name is not a binding — this time as "the
 *    properties you can name are not the object".
 *
 *    19 through 22 were found by a seventh agent, and they share a shape that is
 *    worth naming because four rounds of fixes have not touched it: **this file
 *    reads the sources it has been told about, and the bundler reads whatever is
 *    on disk.** Each fix so far widened the set of things read *inside* a source
 *    — more CSS forms, more HTML tags, more config keys — and none changed the
 *    direction of the question. 19 is a subtree beside the document tree, 20 a
 *    function beside `url()`, 21 a file beside `vite.config.ts`, 22 a property
 *    kind beside the named ones. The structural fix this list has now named three
 *    times is to read the entry and module set `vite build` itself reports and
 *    compare it against `shippingModules(SRC_ROOT)`; that would have closed all
 *    four in one move. Round six is where that got done — see 23 through 28 for
 *    what it took to stop putting it off, and `BUILD_PROGRAM` for the
 *    instrument.
 *
 *    15 through 18 were found in one sitting by a sixth agent, and the shape is
 *    the one this list keeps recording rather than escaping: each of them sits in
 *    something the previous round built. 15 is in the tokenizer written to close
 *    9. 16 and 17 are in the CSS reader rebuilt to close 13 — one form it has no
 *    pattern for, one predicate it states correctly and implements differently.
 *    18 is in the config reader written to close 14. Three of the four had a
 *    comment beside them claiming the property they lacked, which is why the
 *    round that fixed them also deleted every sentence in this file that could
 *    not be measured, rather than softening it.
 *
 * 23. **It copied vite's table and none of the function that reads it.**
 *    `HTML_ASSET_SOURCES` was made a transcription of `DEFAULT_HTML_ASSET_SOURCES`
 *    in round 5, and the transcription is correct. `getNodeAssetAttributes`
 *    checks `"vite-ignore" in attributes` and returns a lone `remove` action —
 *    **after** the table lookup the function opens with, which round 6 got
 *    backwards four times over and 29 is — and the build-time script branch is
 *    `if (isIgnored) removeViteIgnoreAttr(…) else { … }`. `vite-ignore` is
 *    documented, first-class API whose whole purpose is "leave this tag alone",
 *    and it appeared **zero times** in this file. Two adversaries landed it
 *    independently in one round, in both directions with the same attribute: on
 *    the one script tag in this document, `<script type="module"
 *    src="/src/main.tsx" vite-ignore>` left `vite build` exit 0 at **1 module
 *    transformed against a 219-module control** — `dist/assets/` holding a lone
 *    sourcemap, `dist/`'s own `index.html` pointing at a path absent from the output —
 *    with this file green twice at 33/33 and `GRAPH.entries` still the pinned
 *    `['src/main.tsx']`. That is defect 15's fourth bullet, "the guard green over
 *    a bundle containing none of the renderer", reproduced in the reader built to
 *    close it, at a strictly worse module count. On a `<link>` it went the other
 *    way and laundered a planted orphan, caught only by that same pin.
 *
 * 24. **It ran vite's regexes over text vite never runs them over.** Round 5
 *    stopped listing CSS forms and transcribed `cssUrlRE` and `cssImageSetRE` out
 *    of the installed package, which was the right move. It then ran them over
 *    `css.atRoot` and `css.inRules` — the whole stylesheet — while
 *    `UrlRewritePostcssPlugin` is `Once(root) { root.walkDecls(…) }` and tests
 *    **declaration values only**. A superset is the laundering direction: a
 *    `@supports (background-image: url("…/T05Orphan.module.css"))` block appended
 *    to a stylesheet already on the graph turned a planted orphan from a clean
 *    red into green twice at 33/33, `vite build` exit 0 at **219 modules, the
 *    control's own count**, the orphan's marker in no file under `dist/`, and the
 *    laundering line shipped verbatim as inert CSS. Two adversaries built it
 *    independently in two different stylesheets. Defect 13's shape — prose to the
 *    bundler, an edge to the reader — one CSS construct over.
 *
 * 25. **It asked whether a whole attribute value was a path.** Vite's
 *    `findNeedTransformStyleAttribute` matches any `style` attribute whose value
 *    merely *contains* `url(` or `image-set(` and routes the value through the
 *    CSS pipeline. `htmlLoads` classified a non-table attribute by asking whether
 *    the **entire value** resolved to a file, and `background-image: url('…')`
 *    does not, so it was neither an edge nor loud. `<div id="root"
 *    style="background-image: url('/src/runtime/run-doubles.ts')">` — one
 *    attribute on the tag already in this document — gave `vite build` exit 0 at
 *    **220 modules against 219** and `dist/assets/run-doubles-*.ts`
 *    holding **10636 bytes, `wc -c` identical to the source**, with this file
 *    green twice at 33/33. Landed by two adversaries in two consecutive rounds,
 *    on the same emitted filename hash, while this file's own limits list said of
 *    that exact case "there is nothing in this tree for it to hide".
 *
 * 26. **It read a wider `type` than the bundler, and could not spell half its own
 *    entry set.** `getScriptInfo` is `p.name === "type" && p.value === "module"`,
 *    byte for byte; this reader trimmed and lower-cased. `<script type="Module">`
 *    was therefore a module body here and a data block there, and because `walk`
 *    built `entries` from `kind === 'file'` loads only, an inline body's edges
 *    went into `reachable` **without ever touching the pin** that had caught the
 *    `<link>` half of 23. The second half of that is its own defect and older:
 *    `HTML_ENTRY`'s docblock says in plain words that "a second module script,
 *    with a body instead of a `src`, is also an entry", and adding a real second
 *    inline entry — `vite build` exit 0 at 220 modules against 219 — left
 *    `GRAPH.entries` at `['src/main.tsx']`, green at 33/33. A docblock naming a
 *    key set while the pin checks one branch of it.
 *
 * 27. **It walked `src/` and called that the repo's shipping channel.**
 *    `publicDir` defaults to `public` and needs no config key, so
 *    `objectKeys(VITE_CONFIG_ROOT)` cannot see it: there is nothing in the config
 *    to see. `mkdir public` and one file copied into it — no edit to
 *    `index.html`, `vite.config.ts`, `package.json` or anything under `src/` —
 *    put a `run-doubles.ts` at the top of `dist/` at **10636 bytes, byte-identical to the first
 *    `NOT_SHIPPED` entry**, with `vite build` at 219 modules, the control's own
 *    count, and this file green at 33/33. The directory does not exist here, and
 *    this file mentioned it once, about resolution, and never as a second way out
 *    of the repo.
 *
 * 28. **It enumerated one node kind and called that a binding.** `factoryUsesIn`
 *    was written to close defect 12 and builds `locals` and `namespaces` inside
 *    `if (!ts.isImportDeclaration(node)) return`. A dynamic import binds through
 *    a `VariableDeclaration`, so
 *    `const { createAgentRuntime } = await import('@/runtime/app-runtime')`
 *    followed by `createAgentRuntime(adapter)` — appended to a file already on
 *    the graph, `tsc -b --force` exit 0 under this repo's strict settings — was a
 *    real second construction site that produced neither a builder nor an escape.
 *    Invisible in both directions, which is the failure §7 of this list names and
 *    the one that function exists to end. The control is that the identical
 *    function with a *static* import reddens on the first run, so what the reader
 *    was blind to was the syntax and not the semantics; and the lazy spelling is
 *    the ordinary one, being what a contributor writes when told to keep a heavy
 *    dependency out of the initial chunk.
 *
 * 29. **It asked a build, and the build it asked was not the one this repo
 *    ships.** Round 6's answer to five rounds of reader-versus-bundler
 *    divergence was to stop reconstructing vite's front end and ask
 *    `vite build` what it read. That was right and it works. What it asked was
 *    a build launched from inside vitest's process, pointed at a config file by
 *    name. `execFileSync` passed no `env`, so the child resolved the config with
 *    `VITEST="true"` and `NODE_ENV="test"` — measured directly by instrumenting
 *    `BUILD_PROGRAM`. Four constructions landed on that: a plugin gated
 *    `if (process.env.NODE_ENV !== 'production') return realReact();`, the same
 *    gate on `process.env.VITEST`, a "vite.config.mjs" shadowing the `.ts` one
 *    (vite's `DEFAULT_CONFIG_FILES` ranks `.js` and `.mjs` ahead of it), and a
 *    production config named from `package.json`'s build script. Each put the
 *    double's bytes in the shipped entry chunk with `vite build` exit 0 at 221
 *    or 222 modules against the control, and this file green at 48/48 twice.
 *    The boundary is the finding: the same plugin with the gate line deleted
 *    reds three named assertions, so one five-word conditional was the whole
 *    difference. `resolved.isProduction` follows `NODE_ENV`, so the recorded
 *    build also had `import.meta.env.DEV` **true** — dev-only mock wiring
 *    reddened against a bundle that provably did not contain it, and
 *    `import.meta.env.PROD` code shipped while being absent here. Both
 *    directions wrong, from the same line.
 *
 * 30. **Its universe was `src/`, and nothing asserted the universe.**
 *    `readBySourceKind` filtered the bundler's set to `src/`,
 *    `reachedBySourceKind` filtered the walk's set to `src/`, and
 *    `shippingModules(SRC_ROOT)` was the must-be-reachable list — so a file one
 *    directory over was invisible to the build side, invisible to the walk side
 *    and outside the list, and the two-directional comparison of 28's fix agreed
 *    about it by being blind to it twice. Two adversaries reached the identical
 *    construction independently: a scripted turn driver under `tests/support/`
 *    imported by `src/runtime/app-runtime.ts`, with the include `tsc`'s own
 *    TS6307 message asks for added to `tsconfig.app.json`. `vite build` exit 0
 *    at 220 modules against 219, the double's class body in the shipped entry
 *    chunk, this file green at 48/48 and the whole suite at 118/118. A second
 *    needed no TypeScript at all: one `@import` from a component stylesheet to a
 *    stylesheet under `tests/` put a rule from outside `src/` into the shipped
 *    CSS with the module count unchanged. This repo already compiles TypeScript
 *    under `tests/` and already has a tsconfig including such a directory beside
 *    `src`, so the edit is one a reviewer nods at.
 *
 * 31. **It closed `await import(…)` and left `.then(…)`.** 28's fix reads a
 *    dynamic import's binding through `awaitedImportSpecifier(node.initializer)`
 *    on a `VariableDeclaration`. `import('@/x').then(({ f }) => f())` binds its
 *    module object in a `ParameterDeclaration`, so the specifier came back
 *    `null` and the branch did a bare `return` rather than an `escapes.push` —
 *    invisible in both directions at once, verbatim the failure that function's
 *    docblock says it was rewritten to end. An adversary put a second
 *    construction site in a reachable module that way, green twice, while the
 *    same three lines written `const { f } = await import('@/x')` reddened on
 *    the first run. The docblock's own excuse — that `unanalysableImports` says
 *    such an edge out loud — was false by execution: that function reports a
 *    dynamic import only when its **specifier** is not static, and this one is.
 *
 * 32. **It got the bundler's own control flow backwards, in the paragraph
 *    correcting an earlier version of itself.** 23's fix wrote, in four separate
 *    places, that `getNodeAssetAttributes` checks `"vite-ignore" in attributes`
 *    *before* it looks at the asset table. It does the opposite: the function
 *    opens `const matched = DEFAULT_HTML_ASSET_SOURCES[node.nodeName]; if
 *    (!matched) return [];` and tests the attribute after that — measured on the
 *    installed vite@7.3.6, row lookup at offset 57 of the function body and
 *    attribute test at offset 230. So `htmlLoads` tested the attribute ahead of
 *    the tag dispatch for **every** element and reported
 *    `<a href="/src/main.tsx" vite-ignore>` as *the bundler is told to leave this
 *    tag alone, so everything it names is out of the build*, about a build that
 *    returns `[]` for an `a` tag before reading a single attribute and does not
 *    even strip the marker. A message asserting something false about the build
 *    is the delete-me direction this file already records for `<noscript>`.
 *
 * 33. **It pinned the reader's data and not the reader's branches.** A measurer
 *    deleted 52 structural branches of the functions this file adds, one at a
 *    time: 21 left `tsc --build --force` at exit 0 and the whole suite at 2432
 *    passed, and a 22nd was caught by the type checker alone. Seven of the 21
 *    were in `factoryUsesIn` and `reExported` — the two functions round 6
 *    rebuilt — and `factoryUsesIn` carried an inline comment saying its branches
 *    were pinned individually, which was true of three arms and false of six
 *    beside them. The sharpest single case is one level in from the rest and is
 *    this round's own shape: `subpathBase` had four synthetic assertions
 *    covering wildcard, exact key, conditions object and non-subpath, and
 *    `resolveInTree`'s `?? subpathBase(path)` deleted green — every one of those
 *    assertions called the helper directly with a synthetic map, this repo
 *    declares no `imports` field, and the wire from the helper into the resolver
 *    had never run. **Two thoroughly tested things with an unasserted edge
 *    between them.** The same at `aliasTarget`'s plain-string arm and at
 *    `canonical`'s outside-this-repository branch. Nine invariants stated in
 *    comments were in the same condition, the marker string among them: five
 *    paragraphs prove a double reached `dist/` by a phrase whose validity
 *    condition is that it occurs in exactly one file under `src/`, this file
 *    states that condition three times and names the typographic convention that
 *    preserves it — and round 6 wrote the phrase unbroken into a docblock 1,500
 *    lines away. Measured: two files. The fix is not more prose. Every reader
 *    named in 29–33 is now driven by one input per structural position it
 *    handles, checked against an enumerated list, so a deleted branch names the
 *    position that stopped being read.
 *
 *    29 through 33 keep the pattern the twenty-eight above it set, and it is
 *    worth naming rather than hoping it stops. Each round's fix has been the
 *    right fix and each round's defect has been one level inside it: a
 *    reconstruction disagreeing with the bundler (1–22), then the recorded build
 *    differing from the shipping build in its **options** (round 6's `write:
 *    false`), then the recorded build not being the shipping build's build at
 *    all — different config file, different environment (29). And beside that,
 *    the same move in the assertions: the data list pinned and the reader's
 *    branch list not (round 6), then the reader pinned and the **edge between
 *    two pinned readers** not (33). Assume there is a level below this one.

 *    23 through 28 were found by two adversaries working independently, and three
 *    of the six were landed by both of them. Their shape is one level down from
 *    19–22's: that round's finding was that this file reads the sources it has
 *    been told about while the bundler reads whatever is on disk, and round 5
 *    answered it by copying the bundler's **data** — its asset table, its CSS
 *    regexes — out of the installed package. The data is right. What was still
 *    hand-written is the bundler's **control flow** around that data, and every
 *    one of these six is in it. There is no version of a second implementation of
 *    vite's front end that stops diverging from vite's front end, which is why
 *    the fix this round is not a seventh transcription: `BUILD_PROGRAM` runs the
 *    real build with `write: false` and reads back `this.getModuleIds()` and
 *    `this.getWatchFiles()`, and the walk is compared against it in both
 *    directions. The reader is still fixed — all six — because the walk is what
 *    produces every classification below; what changed is that a seventh
 *    divergence is now a failing assertion instead of a finding.
 *
 *    Two findings the same round went the other way, and they belong here because
 *    the direction that kills a guard is not always the quiet one. `<noscript>`
 *    content is markup to jsdom (scripting disabled) and a raw-text node to
 *    vite's parse5 (scripting enabled), so an ordinary `<noscript><link
 *    rel="stylesheet" …></noscript>` reddened this file against a build that
 *    stayed at the control's own module count, with a message that asserted
 *    something false about that build. And `extname('vite-env.d.ts')` is `.ts`,
 *    so creating the file `npm create vite@latest` writes for every TypeScript
 *    template reddened the orphan assertion with a message saying a file that has
 *    no runtime "is called by nothing". Round 4's timeout regression was the
 *    same class: the fix put an explicit budget on the one assertion that had
 *    timed out and left the two slowest in the file at vitest's 5000ms default,
 *    where an adversary running the *committed* guard on a loaded machine got
 *    three timeouts on a tree nobody had touched. A guard that reddens on routine
 *    work is a guard somebody deletes, which is a slower way of losing than being
 *    evaded.
 *
 * ## What it still cannot see
 *
 * This list is not a proof of completeness and the version of it that read like
 * one was wrong twice over: it was framed as "stated rather than discovered
 * later" while two live holes in the reader above it were in neither the list
 * nor the code. What follows is what is known today, and the pattern of this
 * file is that the next entry arrives by somebody executing something.
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
 * - In `index.html`, an attribute is followed only when `HTML_ASSET_SOURCES`
 *   says the bundler rewrites it **and** vite's own row-level `filter` says so,
 *   which is now transcribed rather than stood in for by skipping `<meta>` by
 *   name. `vite-ignore` is honoured on a `<script>` and on a tag with a row in
 *   that table, and on nothing else, because those are the two places the
 *   bundler reads it — `getScriptInfo`, and `getNodeAssetAttributes` **after**
 *   its row lookup. An inline `style` attribute is read whichever way that goes,
 *   because `findNeedTransformStyleAttribute` runs on every node and never looks
 *   at the marker. Two kinds are read and deliberately **not** followed, each loud
 *   instead: a `srcset`/`imagesrcset` candidate list, which this file does not
 *   parse; and any other attribute whose value resolves to a real file here. A
 *   tag carrying `vite-ignore` is read and reported rather than followed, because
 *   that is what the bundler does with it. An inline `style` attribute is a
 *   declaration list, not a path, and is read by the CSS reader: the sentence
 *   that stood here said an attribute whose value resolves to nothing has
 *   "nothing in this tree to hide" and that an inline `style="…url(…)…"` "would
 *   be silent", and the second sentence was the measurement that disproved the
 *   first — 10636 bytes of the first `NOT_SHIPPED` entry shipped into
 *   `dist/assets/` in exactly that case, twice, by two people. What remains
 *   genuinely silent is an attribute outside the table whose value neither
 *   resolves here nor parses as CSS; that is stated as an observation about the
 *   readers named above, and it is the direction
 *   `reads what the build reads, and reaches nothing the build did not` exists to
 *   catch when it is wrong.
 * - A module `src` pointing off this tree — a scheme, `//`, a `#` — is not an
 *   edge and not lost. It can still execute; what it cannot do is name a file in
 *   `src/`, which is what every assertion here is about.
 * - What is markup in `index.html` is decided by parse5 through the `jsdom`
 *   environment this test runs in, which is the same parser `vite build` uses and
 *   **not the same copy of it**: vite bundles parse5 into its own dist and
 *   declares it at `^8.0.0`, jsdom depends on it at `^7.2.1`, and the installed
 *   one is `parse5@7.3.0`. Both implement the WHATWG tokenizer, so the residual
 *   hole is a behavioural difference between those two majors, which nothing here
 *   would notice. That is one surface where there used to be four hand-written
 *   rules. The sentence that stood here called that residue "a lockfile change
 *   and a reviewer rather than an evasion somebody can write into `index.html`",
 *   and a `<template>` wrapper was exactly such an evasion at the time — not
 *   through a version difference but through this file reading the document tree
 *   instead of the parse (defect 19). `htmlElements` now descends into every
 *   `content` fragment, so what is left really is the version difference, and it
 *   is stated as a difference rather than as a bound. It is not the only way two
 *   parse5 calls disagree: jsdom parses with **scripting disabled** and vite's
 *   parse5 with it enabled, so a `<noscript>` body is an element subtree here and
 *   one raw-text node there. That was a live false red — an ordinary
 *   `<noscript><link rel="stylesheet" …></noscript>` reddened this file against a
 *   build that stayed at the control's own module count — and `htmlElements` now
 *   stops at a `noscript` element, which is where the bundler's parser stops.
 *   What the DOM also costs is that a tag
 *   the parser drops is not reported: an unterminated tag at end of input yields
 *   no element, so it leaves `unreadHtml` empty where the hand-written reader
 *   emitted a `broken` token. The bundler drops it too, and a dropped *entry*
 *   still reddens `GRAPH.entries`.
 * - `public/` is a second, ungoverned path from this repo into `dist/`: vite
 *   copies `publicDir` verbatim, with no module graph and no config key to see it
 *   through. There is no such directory here today, and the contents are pinned
 *   rather than assumed absent, because the first favicon anybody adds creates
 *   one. What the pin does not do is *read* what is in there: a file named in
 *   `PUBLIC_FILES` ships, and nothing here asks what it is.
 * - Every "read vite's own X back out of the installed package" comparison here
 *   — the asset table and its `filter` key, the two meta allow-lists, the three
 *   CSS regexes and which of them the declaration walker tests — has one failure
 *   mode no assertion over it can catch: a reader rewritten to answer out of this
 *   file's own expectation instead of out of the package. Measured, so it is not
 *   a worry but a result: replacing the `filter`-presence scan with a lookup of
 *   this file's own table is green twice at 48/48, while making it always-true or
 *   always-false reds `matches vite's own table of asset-bearing attributes`
 *   twice. What the comparison buys is that the *values* cannot drift; what it
 *   cannot buy is that the reader still reads. A reviewer, and this sentence, are
 *   what stand there.
 * - The build comparison is a second opinion and not a second guard. It answers
 *   "which files under `src/` did the bundler read", which is the question every
 *   reachability assertion here asks, and it says nothing about `node_modules`,
 *   about virtual modules, or about whether rollup then tree-shook what it read.
 *   It also runs one configuration — the production build — so a file reached
 *   only in `pnpm dev` is outside it. And it is a `vite build`: if the build
 *   fails, this file fails with it, which is loud and is the point.
 * - `url()` is followed as an edge, and a bare one is read as relative to the
 *   stylesheet. Vite will also resolve a bare `url()` through node resolution,
 *   which this reader does not; that direction produces a specifier pointing into
 *   this tree that resolves to nothing, which is `GRAPH.unresolved` and loud.
 *   `image-set()` is followed too — it was listed here as a silent drop for a
 *   round, and it shipped a double while the listing was accurate, which is
 *   defect 20. Both patterns are transcribed from vite's own plugin and compared
 *   back against the installed copy. Two residues: a `url()` assembled by `var()`
 *   substitution is not evaluated by this reader, and `cssUnfollowable`'s scan
 *   for a function form vite does *not* rewrite stops at the first `)`, so a
 *   nested argument list is not seen — `image-set(url(…))`, the nesting that
 *   matters, is followed by `urlTargets` rather than left to that scan.
 * - `readCss` is more permissive than the CSS grammar: it ends a string at the
 *   closing quote or at end of input, never at a newline, while CSS Syntax makes
 *   an unescaped newline inside a string a bad-string token. A stray apostrophe
 *   — `content: 'there's nothing here yet'` — therefore shifts every later string
 *   boundary in the file, and a `url()` after it can disappear from this reader
 *   entirely. It is not an evasion here and that is luck about which instrument is
 *   stricter, not a property of this one: postcss scans across newlines for the
 *   closing quote too, so the same file fails `vite build` with an `Input.error`
 *   and nothing ships. A green from this file is not evidence that the
 *   stylesheets it read are stylesheets the bundler will accept.
 * - `@import` is honoured only before any other statement, `@charset` and an
 *   `@layer` statement excepted, which is CSS's rule. A conditional `@import`
 *   with `layer()`/`supports()`/a media query is still read as an edge, because
 *   the file is fetched whether or not the condition applies.
 * - `HTML_ASSET_SOURCES` is checked against `DEFAULT_HTML_ASSET_SOURCES` in the
 *   installed `vite` package's built output. That is a private name in a bundled
 *   file: an upgrade that renames or reshapes it makes `viteHtmlAssetSources`
 *   return `null`, which reddens rather than passes, and the honest fix then is
 *   to find where the table moved.
 * - An inline module body is parsed, not type-checked: nothing runs `tsc` over
 *   `index.html`. A body that neither the TS nor the TSX grammar accepts yields
 *   whatever partial tree the parser recovers from it, and edges inside the part
 *   it could not read are lost without a word.
 * - In CSS, `composes` is the only rule gated by file kind, because it is the
 *   only one this file reads that a plain stylesheet does not honour. Other
 *   CSS-modules-only syntax — `@value`, `:global` — is not read at all, and
 *   `@value x from './a.css'` would be a dropped edge rather than a loud one.
 * - The entry configuration is pinned at the keys of `build` in `vite.config.ts`,
 *   read from the object the module exports. A config that exports a function,
 *   or spreads another object into its literal, is one `configRootOf` cannot
 *   read: it answers `null` and the assertion reddens rather than passing.
 *   `resolve.alias` is read in its object form; vite also accepts an array of
 *   `{ find, replacement }`, which `objectKeys` reports as empty — every aliased
 *   specifier then resolves to nothing and lands in `unresolved`, loudly. A
 *   **plugin** can move the entry or rewrite the document without any of those
 *   keys changing, which is defect 18, so the config's top-level keys and the
 *   callees in `plugins` are pinned too. Both of those pins read named
 *   properties, and a `SpreadAssignment` has no name: a trailing spread passed
 *   them both while overwriting the key one of them was reading (defect 22), so
 *   `unreadableProperties` now sweeps the whole config file for any property none
 *   of the three readers can see and pins that empty.
 * - The config is not the only file that moves a specifier, which is defect 21.
 *   `package.json`'s `imports` field declares a `#` namespace vite resolves;
 *   `SUBPATH_IMPORTS` reads it, `pointsIntoThisTree` treats every `#` specifier as
 *   internal because the module specification reserves it, and the manifest's
 *   top-level keys are pinned so a new field is a reviewer's decision. The third
 *   candidate, `paths` in `tsconfig.app.json`, is measured not to move the
 *   bundler: an import through a path only `tsc` knows about fails `vite build`
 *   with `Rollup failed to resolve import`, exit 1.
 * - All of that is still an enumeration of config surfaces: it reddens when a
 *   door is added. What it used not to see at all was an existing door changing
 *   behind its own name — a `writeBundle` or a `transformIndexHtml` mounted on
 *   the plugin object `react()` already returns is not a new name, and a critic
 *   put 10636 bytes of a double at the top of `dist/` that way with the module
 *   count untouched. `RESOLVED_PLUGINS` therefore pins each plugin's **hook
 *   set** beside its name, so a hook appearing on any object reddens whoever
 *   owns the object. A hook that already exists doing something new in a future
 *   version is still a lockfile change and a reviewer. *Driving* the walk from
 *   the entry and module set `vite build` itself reports, rather than from any
 *   config's shape, is the fix that would not be an enumeration; the build's own
 *   entry set is read and asserted, and the traversal is still this file's.
 * - The recorded build is a real `vite build` and it is not the shipping build,
 *   in two named ways and no longer in four. It runs with the runner's
 *   environment scrubbed — `VITEST`, its three siblings and `NODE_ENV` removed,
 *   which is what a maintainer's shell gives it — and with no `configFile`
 *   named, so it discovers the config the way `pnpm build` does; the config it
 *   found, `isProduction`, `import.meta.env.DEV`/`.PROD` and the two environment
 *   variables are all recorded and asserted, and `package.json`'s build script is
 *   read as an argv and held to selecting neither a config nor a root. What
 *   remains is `build: { write: false, sourcemap: false, minify: false }`.
 *   Everything downstream of writing is invisible to every assertion that reads
 *   the recorded set: a `writeBundle` that copies a file next to the bundle adds
 *   no module, and a hook that branches on `resolved.build.write` can behave one
 *   way here and another in `dist/`. The hook-set pin above is what stands in
 *   for it. Reading `dist/` itself is the instrument that would end it, and it is
 *   a different, slower, non-read-only one.
 * - The build's own set is now narrowed twice rather than once: to `src/` for
 *   the two-directional comparison, and — everything else this repo owns — to an
 *   enumerated list of what the build reads outside `src/` and outside
 *   `node_modules/`. That list is `index.html` and `package.json` today. It
 *   catches a file the build **reads**; it does not catch a file that reaches
 *   `dist/` without being read, which is `public/` (pinned separately) and the
 *   write half above.
 * - A factory binding used as a value is reported, not followed. `escapes` says
 *   where the analysis stopped; it does not say where the thing is finally built.
 *   A namespace object read with a computed member name is in the same list, for
 *   the same reason.
 * - `src-tauri/` is not walked. This is the renderer's graph.
 * - `readdirSync` is the authority on a path's case, every segment of it, not
 *   `existsSync`, which is case-blind on NTFS. `resolveInTree` carries out both
 *   the disk's spelling and the specifier's, `walk` keys the graph on the
 *   former and reports the difference, because `forceConsistentCasingInFileNames`
 *   covers what `tsc` resolves and `tsc` resolves neither a `.css` path nor a
 *   `?raw` one — those match ambient wildcard modules in `vite/client`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
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
 * reads it now. What it reports rather than skips is named in its own doc and
 * bounded there — a `<script>` whose body this file does not parse, a
 * `<style>` body, and any attribute outside `HTML_ASSET_SOURCES` whose value
 * resolves to a real file here. An unterminated tag was on this list and is not
 * any more: parse5 drops it, so there is no element to classify, and the
 * `'the parser drops it'` expectation inside `reads a script body as text, not
 * as a place comments can start` is what says so. The sentence this replaces said it
 * reported everything it could not read, and two shapes it reported nothing
 * about were live at the time.
 */
const HTML_ENTRY = join(REPO_ROOT, 'index.html');

/**
 * The time a slow assertion is allowed, and why it is not vitest's default.
 *
 * Round 4's clean-tree false red was `Test timed out in 5000ms` on assertions
 * that walk the module graph several times, and the fix was structural — the
 * memos above — plus one explicit budget. The budget went on the assertion that
 * had timed out, and on no other, which left the two `constructionSites`
 * assertions at the 5000ms default; measured here on an unloaded box they are
 * the slowest in the file after the build, 397–862ms and 287–489ms against
 * single-digit milliseconds for most of the rest. A measurer on a different box
 * exceeded both of those ranges — 1576ms and 611ms — which is what an observed
 * range on one machine is worth and why it is written as one. Both still clear
 * this budget by more than ten times. An adversary reports running
 * the committed guard on a **loaded** machine, with no plant at all, and getting
 * three timeouts on an unmodified tree — 9755ms, 9373ms and 5379ms, all on
 * `builds the sandbox door once, at the composition root`. That is their
 * measurement rather than one reproduced here, and it does not need reproducing
 * to be acted on: a red on somebody else's untouched tree is the delete-me
 * direction, and an idle box is exactly the instrument that cannot see it. So
 * every assertion that walks the graph carries the budget now, not only the one
 * that was caught.
 *
 * `pnpm test` runs 118 files and `vite.config.ts` gives vitest no `testTimeout`
 * override and no pool isolation, so this is the only place the number can be
 * said.
 */
const BOUNDARY_BUDGET = 20_000;

/**
 * The same, for the assertions that run a real `vite build`.
 *
 * The build is memoised, so exactly one of them pays for it — and that is a
 * property with an assertion rather than a sentence: `runs one build for the
 * whole file, however many assertions read it` counts the child processes.
 * Measured inside the suite on this box: 2817ms at its quickest and 15053ms at
 * its slowest across the runs of this round, against a whole-file cost of well
 * under a second before it existed. A measurer on a different box saw 16814ms
 * idle and 34789ms under load, so both ends of the range here have already been
 * exceeded elsewhere; that spread is the argument for the number, because what
 * is being bounded is a bundler on a box that may be doing something else and
 * the cost of this budget being too small is a red on a tree nobody touched. It
 * is a range observed here, open at both ends, not a bound.
 */
const BUILD_BUDGET = 120_000;

/**
 * Everything in `public/`, which the build copies into `dist/` without a graph.
 *
 * Empty, and the directory does not exist. It is a list rather than an
 * assertion that the directory is absent because the first favicon anybody adds
 * creates it, and the entries have to become visible then rather than the
 * assertion becoming false.
 */
const PUBLIC_FILES: readonly string[] = [];

/**
 * The plugin list vite resolved, in order, as of the installed vite and
 * `@vitejs/plugin-react`.
 *
 * A pin, and it is the same kind of pin as `GRAPH.entries`: it protects one
 * value somebody wrote down, and it is the cheap second signal rather than the
 * argument. The argument against a plugin injecting an edge is
 * `reads what the build reads, and reaches nothing the build did not`. What this
 * adds is the case where a wrapper plugin does something that is *not* an edge —
 * and the reason it is worth its upkeep is that three rounds of adversaries have
 * pointed `vite.config.ts`'s `react` import at a local module and shipped a
 * double through the plugin it returned, against a file that pins the callee's
 * *name*.
 *
 * Each row carries the plugin's **hook set** as well as its name, and that is
 * the round-6 blocker rather than decoration. A name pin reads names, and the
 * construction it could not see was a hook mounted on an **existing** plugin
 * object: a `writeBundle` on the react plugin copying
 * `src/runtime/run-doubles.ts` next to the bundle put 10636 bytes — byte
 * identical to the first `NOT_SHIPPED` entry — at the top of `dist/` with
 * `vite build` at 219 modules, the control's own count, and this file green
 * twice; a `transformIndexHtml` on the same object, guarded by
 * `if (resolved.build.write === false) return html;`, put the double's code in
 * the shipped entry chunk at 221 modules against 219, green twice. Neither is a
 * new name and neither adds an edge the recorded build can see, so for
 * write-time work the name pin was not the cheap second signal, it was the whole
 * argument, and it was reading the wrong thing. A hook set moves when a hook is
 * added to an object, whoever owns the object.
 *
 * The keys are `Object.keys(plugin)` less the six that are not hooks — `name`,
 * `enforce`, `api`, `apply`, `sharedDuringBuild` and
 * `perEnvironmentStartEndDuringDev` — sorted, so the row is stable across
 * orderings and moves only when the plugin's surface does.
 */
const RESOLVED_PLUGINS = [
  'vite:build-metadata [renderChunk]',
  'vite:watch-package-data [buildEnd buildStart watchChange]',
  'alias [buildStart resolveId]',
  'vite:react-babel [config configResolved options]',
  'vite:react-refresh [config load resolveId transformIndexHtml]',
  'vite:modulepreload-polyfill [load resolveId]',
  'vite:resolve [load resolveId]',
  'vite:html-inline-proxy [load resolveId]',
  'vite:css [buildEnd buildStart load transform]',
  'vite:esbuild [configureServer transform]',
  'vite:json [transform]',
  'vite:wasm-helper [load resolveId]',
  'vite:worker [buildStart generateBundle load renderChunk transform watchChange]',
  'vite:asset [buildStart generateBundle load renderChunk resolveId]',
  'vite:react-virtual-preamble [load resolveId]',
  'vite:wasm-fallback [load]',
  'vite:define [transform]',
  'vite:css-post [augmentChunkHash generateBundle renderChunk renderStart transform]',
  'vite:build-html [generateBundle transform]',
  'vite:worker-import-meta-url [applyToEnvironment transform]',
  'vite:asset-import-meta-url [applyToEnvironment transform]',
  'vite:force-amd-wrap-require [renderChunk]',
  'vite:force-systemjs-wrap-complete [renderChunk]',
  'vite:prepare-out-dir [options renderStart]',
  'commonjs [applyToEnvironment]',
  'vite:data-uri [buildStart load resolveId]',
  'vite:rollup-options-plugins [applyToEnvironment]',
  'vite:dynamic-import-vars [load resolveId transform]',
  'vite:import-glob [buildStart hotUpdate transform]',
  'vite:build-import-analysis [generateBundle load renderChunk resolveId transform]',
  'vite:esbuild-transpile [applyToEnvironment renderChunk]',
  'vite:terser [applyToEnvironment closeBundle renderChunk]',
  'vite:license [generateBundle]',
  'vite:manifest [applyToEnvironment buildStart generateBundle]',
  'vite:ssr-manifest [applyToEnvironment generateBundle]',
  'vite:reporter [generateBundle renderChunk renderStart writeBundle]',
  'vite:load-fallback [load]',
];

/** How the entry list spells an entry that has a body instead of a file. */
const INLINE_ENTRY = 'index.html <script type="module"> (inline)';

/**
 * The two things the entry pin can be saying, named so they can be told apart.
 *
 * Round 5 split one assertion into two because the single one misdescribed half
 * of what it caught, and named nothing: the property — *a routine new reference
 * in `index.html` reddens saying the entry set moved, not that the graph is
 * vacuous* — lived in a twelve-line comment and in no assertion. Collapsing the
 * split back into the one assertion it replaced left the suite at
 * `33 passed (33)`, exit 0. As constants they are readable by a test, and
 * `the entry pin says the entry set moved, not that the graph is vacuous` reads
 * them.
 */
const ENTRY_SET_VACUOUS =
  'index.html declares no module entry this walk can resolve; the graph below is vacuous';

const ENTRY_SET_MOVED =
  'index.html names a file this guard has not been told about. That is ordinary ' +
  '— a favicon, a preload, a second stylesheet — and it is still the entry set ' +
  'moving: say what the new one is and add it here';

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

/**
 * A TypeScript **declaration** file, which has no runtime and cannot be loaded.
 *
 * `extname('vite-env.d.ts')` is `.ts`, so the enumerator counted one as a
 * shipping module and then demanded the walk reach it. A "vite-env.d.ts" under
 * `src/` is the file `npm create vite@latest` scaffolds for every TypeScript
 * template, and it is the standard place to declare the `?raw`/`?url` ambient
 * wildcards this guard's own prose leans on. Creating it — or any module
 * augmentation, or any global type — turned this file **red** with a message
 * asserting that the declaration file "is called by nothing", and the only ways
 * to green it were to put it in `NOT_SHIPPED` (whose docblock says every entry
 * "would be a defect if the application could reach it", which is untrue of a
 * file that has no runtime) or in the debt list (which is worse). No declaration
 * file exists under `src/` today — measured, zero of them — so nothing here is
 * describing a file a reader can go and look at. That is the delete-me
 * direction: a false red on boilerplate nobody asked this guard about.
 *
 * It is a spelling rule rather than an extension entry because the extension is
 * `.ts` either way, and `declares every file kind under src/` still holds:
 * a declaration file's kind is declared, it is just not a module.
 */
const DECLARATION_FILE = /\.d\.tsx?$/;

/** True for a file under `src/` the bundler can load — not a test, not a declaration. */
function bundlerLoads(name: string): boolean {
  if (!SHIPPING_EXTENSIONS.has(extname(name).toLowerCase())) return false;
  return !TEST_FILE.test(name) && !DECLARATION_FILE.test(name);
}

/** Every file under `directory` the bundler could load, recursively, tests excluded. */
function shippingModules(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...shippingModules(path));
      continue;
    }
    if (!bundlerLoads(entry.name)) continue;
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
 * The second argument is required to be `import.meta.url`, and that requirement
 * is what keeps an ordinary runtime `new URL(…)` from being read as a module
 * edge. The two such calls in this tree are single-argument —
 * `src/lib/markdown-parser.ts` does `new URL(trimmed).protocol` to check a
 * scheme and `src/platform/browser-adapter.ts` does `new URL(raw.trim())` — and
 * neither is an edge, because parsing a URL a user typed is not one. A
 * two-argument `new URL(text, someBase)` would also not be one; there is none in
 * the tree today, and this sentence used to name those two files as carrying one,
 * which they never have.
 */
function isAssetUrl(node: ts.Node): node is ts.NewExpression {
  if (!ts.isNewExpression(node)) return false;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'URL') return false;
  const base = node.arguments?.[1];
  return base !== undefined && isImportMetaUrl(base);
}

/**
 * The specifier of an `import('…')` an initializer awaits or returns directly, or `null`.
 *
 * `await import(x)`, `import(x)` and a parenthesised spelling of either are the
 * three ways a `VariableDeclaration`'s initializer is the module object. All
 * three are driven, one per row, by `reads every initializer shape that is a
 * module object`; the parenthesised one had a true sentence here and no
 * assertion anywhere, and deleting its arm left `tsc` at 0 and the whole suite
 * green.
 *
 * `.then` is not one of them, and the sentence that stood here — that
 * `unanalysableImports` is where an edge this reader cannot read gets said out
 * loud — was false by execution. `unanalysableImports` reports a dynamic import
 * only when its **specifier** is not static, and `import('@/x').then(({ f }) =>
 * f())` has a perfectly static one, so nothing was said out loud and nothing
 * reddened: an adversary put a second construction site in a reachable module
 * that way and this file was green twice, while the same three lines written
 * `const { f } = await import('@/x')` reddened on the first run. `.then` binds
 * its module object in a `ParameterDeclaration` rather than in a declaration, so
 * it is read where parameters are read — in `factoryUsesIn`, not here.
 */
function awaitedImportSpecifier(node: ts.Expression | undefined): string | null {
  let current = node;
  while (current !== undefined) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAwaitExpression(current)) {
      current = current.expression;
      continue;
    }
    if (isDynamicImportCall(current)) {
      const argument = current.arguments[0];
      return argument === undefined ? null : staticSpecifier(argument);
    }
    return null;
  }
  return null;
}

/** `import('…').then(…)` — the module object bound in a parameter. */
function isThenOnDynamicImport(
  node: ts.Node,
): node is ts.CallExpression & { readonly expression: ts.PropertyAccessExpression } {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'then' &&
    awaitedImportSpecifier(node.expression.expression) !== null
  );
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
 * unquoted `url(...)` pattern match the quoted pattern's own output.
 *
 * The sentence that stood here — "NUL cannot occur in a stylesheet, so a marker
 * cannot be forged by the file being read" — was false, and a measurer executed
 * it: a U+0000 byte survives `readFileSync(file, 'utf8')` into the string
 * `readCss` reads, so a stylesheet carrying `@import <NUL>0<NUL>;` after a
 * `content: "…"` declaration made this reader turn that string literal into an
 * `@import` edge, in a plain `.css` and in a `.module.css` alike — defect 6's
 * laundering rebuilt out of the very mechanism written to stop it.
 *
 * The fix is not a bigger marker. CSS Syntax §3.3 says a U+0000 in a stylesheet
 * **is** a U+FFFD as far as the grammar is concerned, so `readCss` does that
 * substitution before it scans anything and the byte is gone by the time a
 * marker can be written. `a NUL in a stylesheet cannot forge a string marker`
 * drives the forged input this paragraph describes.
 */
const CSS_STRING = /\u0000(\d+)\u0000/;

/** A stylesheet split the way its grammar splits, not the way a regex reads it. */
type CssText = {
  /**
   * Everything outside every `{ … }`, with each string literal a marker and each
   * outermost brace a `{` or `}` statement of its own, so order survives.
   */
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
 * literal, never a substring found inside one. And a declaration lives inside a
 * `{ … }` while an at-rule statement lives outside every one, so `composes` is
 * looked for in `inRules` and `@import` in `atRoot`.
 *
 * Brace depth is *not* the whole of `@import`'s position, and the version that
 * said it was is defect 17: CSS honours an `@import` only before any other rule,
 * not merely outside every block, so one appended to the **end** of a stylesheet
 * was an edge here and dead text to the browser. `atRoot` therefore keeps the
 * braces it crossed — a `{` at depth 0 leaves the statement `{` behind in it —
 * so `importRules` can tell "before any rule" from "outside every rule" instead
 * of assuming they are the same sentence.
 *
 * `postcss` is present under `node_modules/.pnpm` as a transitive dependency of
 * Vite but is not resolvable from this package and is not a declared dependency
 * of it, so reaching for it is a lockfile change and not this branch's. What is
 * implemented here is the part of the grammar this file needs — comments,
 * strings, brace depth — and each of those is one rule with no nesting.
 */
function readCss(text: string): CssText {
  // CSS Syntax §3.3: a stylesheet's U+0000 code points *are* U+FFFD. Doing that
  // substitution here is what makes the NUL marker unforgeable by the file being
  // read, which the comment on `CSS_STRING` used to assert and not implement.
  const source = text.replace(/\u0000/g, '\uFFFD');
  let atRoot = '';
  let inRules = '';
  const literals: string[] = [];
  let depth = 0;
  let index = 0;
  const emit = (piece: string): void => {
    if (depth === 0) atRoot += piece;
    else inRules += piece;
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
      // `from` that belongs to somebody else. The outermost pair also leaves the
      // brace itself behind **in `atRoot`**, as its own statement: that is the
      // only record of where a block started, and without it "before any rule"
      // and "outside every rule" are the same sentence — which is defect 17.
      emit(character === '{' && depth === 0 ? ';{;' : ';');
      depth = character === '{' ? depth + 1 : Math.max(0, depth - 1);
      emit(character === '}' && depth === 0 ? ';};' : ';');
      index += 1;
      continue;
    }
    emit(character);
    index += 1;
  }
  return { atRoot, inRules, literals };
}

/**
 * A stylesheet split into the text postcss's declaration walk sees, and the rest.
 *
 * Vite's url replacer is `root.walkDecls(...)`: it tests `declaration.value` and
 * nothing else. A selector, an at-rule prelude and an `@import` statement are all
 * text postcss visits as something other than a declaration, so a `url()` in one
 * of them is dead text to the bundler. The reader that ran vite's regexes over
 * `atRoot` and `inRules` whole was therefore correct about the pattern and wrong
 * about the input, which is the same shape as being correct about the tag table
 * and wrong about `getNodeAssetAttributes`.
 *
 * `readCss` has already put a `;` on both sides of every brace, so splitting on
 * `;` gives statements that never span one. Inside a block, a piece beginning
 * `@` is a nested at-rule's prelude and a piece with no `:` is a nested
 * selector; everything else is a declaration, and its value is what follows the
 * first `:`. Outside every block, nothing is a declaration.
 *
 * `elsewhere` is not a leftovers bin: it is what `cssUnfollowable` scans so that
 * narrowing `urlTargets` cannot be a silent narrowing. An `@import` statement is
 * excluded from it because `importRules` owns that form and reports on it under
 * the preamble rule; counting it here would redden `base.css`, which is a false
 * red on the only stylesheet this repo `@import`s from.
 */
type CssParts = {
  /** Every declaration value in the stylesheet — what `walkDecls` hands the replacer. */
  readonly declarationValues: readonly string[];
  /** Every other statement, `@import` and `@charset` aside. */
  readonly elsewhere: readonly string[];
};

function cssParts(css: CssText): CssParts {
  const declarationValues: string[] = [];
  const elsewhere: string[] = [];
  for (const piece of css.atRoot.split(';')) {
    const statement = piece.trim();
    if (statement === '' || statement === '{' || statement === '}') continue;
    if (/^@(?:import|charset)\b/i.test(statement)) continue;
    elsewhere.push(statement);
  }
  for (const piece of css.inRules.split(';')) {
    const statement = piece.trim();
    if (statement === '') continue;
    const colon = statement.indexOf(':');
    if (statement.startsWith('@') || colon === -1) {
      elsewhere.push(statement);
      continue;
    }
    declarationValues.push(statement.slice(colon + 1));
  }
  return { declarationValues, elsewhere };
}

/** True for the file kinds Vite runs the CSS-modules transform over. */
function isCssModule(file: string): boolean {
  return /\.module\.css$/i.test(basename(file));
}

/** The whole of one string literal, or `null` when the text is not one. */
function literalOf(text: string, css: CssText): string | null {
  const marked = new RegExp(`^${CSS_STRING.source}$`).exec(text.trim());
  const index = marked?.[1];
  return index === undefined ? null : (css.literals[Number(index)] ?? null);
}

/** The `@import` target a root-level statement names, quoted or `url(...)`, or `null`. */
function importTargetOf(statement: string, css: CssText): string | null {
  const quoted = new RegExp(`^@import\\s+(?:url\\(\\s*)?${CSS_STRING.source}`).exec(statement);
  const index = quoted?.[1];
  if (index !== undefined) return css.literals[Number(index)] ?? null;
  const bare = /^@import\s+url\(\s*([^)]*?)\s*\)/.exec(statement);
  const inside = bare?.[1];
  return inside === undefined || inside === '' ? null : inside;
}

/**
 * A stylesheet's `@import` rules, split into the ones CSS honours and the ones it
 * has already stopped honouring.
 *
 * The version this replaces ran one regex over the whole of `atRoot` and called
 * every hit an edge, on the stated grounds that "a browser ignores one that
 * appears after any other rule, so `atRoot` is where it may be honoured". That
 * sentence states the real rule and the code implemented a different one —
 * position in the brace nesting rather than position in the sheet — and a sixth
 * agent walked between them. An `@import` appended **after** five `@font-face`
 * rules in `src/styles/typeface.css`, a plain stylesheet already on the graph,
 * was an edge to that reader and dead text to everything else: guard green twice
 * at 30/30, `tsc -b --force` exit 0, `vite build` exit 0 at **219 modules
 * transformed, identical to the control**, vite's own postcss printing `@import
 * must precede all other statements (besides @charset or empty @layer)` into the
 * build log, and the planted orphan stylesheet's marker in no file under `dist/`.
 * A dead stylesheet reported as reachable is `NOT_SHIPPED`'s direction of proof
 * one file kind over.
 *
 * So the preamble is tracked rather than assumed. `@charset`, another `@import`
 * and an `@layer` *statement* keep it open; anything else — a rule's prelude, the
 * `{` that opens a block, a bare declaration — closes it, and every `@import`
 * after that point is `late`. Late ones are not dropped in silence either:
 * `cssInert` reports them, because a rule that loads nothing and does nothing is
 * only ever written to be read by something that is not the bundler.
 */
function importRules(css: CssText): { readonly honoured: string[]; readonly late: string[] } {
  const honoured: string[] = [];
  const late: string[] = [];
  let preamble = true;
  for (const piece of css.atRoot.split(';')) {
    const statement = piece.trim();
    if (statement === '') continue;
    const target = importTargetOf(statement, css);
    if (target !== null) {
      if (preamble) honoured.push(target);
      else late.push(target);
      continue;
    }
    // `@layer a, b;` is a statement and keeps the preamble open. `@layer a { … }`
    // is a block, and the `{` statement `readCss` leaves behind is what closes it.
    if (/^@charset\b/i.test(statement) || /^@layer\b/i.test(statement)) continue;
    preamble = false;
  }
  return { honoured, late };
}

/**
 * The CSS patterns vite's url replacer runs, transcribed from the installed package.
 *
 * Not this file's opinion about CSS, for the same reason `HTML_ASSET_SOURCES` is
 * not its opinion about HTML: `matches vite's own CSS url rewriter` reads these
 * three sources back out of `node_modules/vite/dist/` and compares them, and it
 * also reads back *which* of them the declaration walker tests, so a vite upgrade
 * that grows a third form reddens this file instead of leaving an edge unread.
 *
 * `VITE_CSS_URL_RE` carries the `(?<!@import\s+)` lookbehind, which is why
 * `urlTargets` no longer needs its own rule for not counting an `@import url(…)`
 * twice. `VITE_CSS_NOT_PROCESSED_RE` and `viteSkipsUrl` are the two places vite
 * declines to rewrite something it matched; a reader that followed those would
 * invent edges the bundler does not have, which is the laundering direction.
 */
const VITE_CSS_URL_RE =
  /(?<!@import\s+)(?<=^|[^\w\-\u0080-\uffff])url\((\s*('[^']+'|"[^"]+")\s*|(?:\\.|[^'")\\])+)\)/;
const VITE_CSS_IMAGE_SET_RE = /(?<=image-set\()((?:[\w-]{1,256}\([^)]*\)|[^)])*)(?=\))/;
const VITE_CSS_NOT_PROCESSED_RE = /(?:gradient|element|cross-fade|image)\(/;
const VITE_FUNCTION_CALL_RE = /^[A-Z_][.\w-]*\(/i;

/** vite's `skipUrlReplacer`: a url it matched and declines to resolve. */
function viteSkipsUrl(unquoted: string): boolean {
  return (
    externalReference(unquoted) ||
    VITE_FUNCTION_CALL_RE.test(unquoted) ||
    unquoted.startsWith('__VITE_ASSET__') ||
    unquoted.startsWith('__VITE_PUBLIC_ASSET__')
  );
}

/**
 * Every `url(…)` target in a stylesheet, as a specifier this tree can resolve.
 *
 * `url()` is not an import, and it is the CSS edge Vite follows most often: it is
 * how `src/styles/typeface.css` names its four woff2 files, and how every image,
 * mask, cursor and font in a stylesheet names a file. The reader that had a form
 * for `@import`, a form for `composes` and none at all for this dropped the whole
 * class in silence, and a sixth agent shipped a test double through the hole.
 * Appending
 *
 *     .vela-diagnostics-mark { background-image: url('../runtime/run-doubles.ts'); }
 *
 * to `src/styles/base.css` — a stylesheet one hop from `main.tsx` — left the guard
 * green twice at 30/30, `tsc -b --force` exit 0 and `vite build` exit 0 at **219
 * modules transformed, the control's own count**, because an asset is not a
 * module; and `dist/assets/run-doubles-*.ts` then held all 10636 bytes of the
 * first `NOT_SHIPPED` entry. `cssSpecifiers`' claim that "a form not listed here
 * drops an edge, and a dropped edge reddens the walk naming the file it lost" was
 * measurably false for this form: nothing reddened, and the file shipped whole.
 *
 * A bare `url(logo.png)` is relative to the **stylesheet**, not a package, so it
 * is normalised to `./logo.png` — the same distinction `bareIsRelative` draws for
 * an HTML attribute. Vite will also resolve a bare one through node resolution,
 * which this reader does not do; being wrong that way makes the specifier point
 * into this tree, resolve to nothing, and land in `GRAPH.unresolved` by name.
 * Loud, not silent.
 *
 * An `@import url(…)` is read by `importRules`, which is subject to the preamble
 * rule, so it is skipped here rather than counted a second time — by vite's own
 * `(?<!@import\s+)` lookbehind now, rather than by a second hand-written rule.
 *
 * Where the patterns are run is as much of vite's behaviour as the patterns
 * themselves, and the version this replaces got the first half right and the
 * second half wrong. `UrlRewritePostcssPlugin` is `Once(root) {
 * root.walkDecls(declaration => … cssUrlRE.test(declaration.value) …) }` —
 * **declaration values only**. This ran the identical regexes over the whole
 * stylesheet text, selectors and at-rule preludes included, which is a strict
 * superset, and a superset is the laundering direction. Two adversaries landed
 * the same construction independently, in two different stylesheets: a block
 * appended to one already on the graph,
 *
 *     @supports (background-image: url("../features/canvas/T05Orphan.module.css")) {
 *       :root { --typeface-backdrop: 1; }
 *     }
 *
 * turned a planted orphan from a clean red into **green twice at 33/33**, with
 * `vite build` exit 0 at **219 modules — the control's own count** — the
 * orphan's marker in no file under `dist/`, and the laundering line itself
 * shipped verbatim as inert text inside `dist/assets/index-*.css`. So `cssParts`
 * splits the stylesheet the way postcss's own walk splits it, this reader takes
 * the declaration values, and a `url()` anywhere else is reported by
 * `cssUnfollowable` rather than followed or dropped in silence.
 *
 * `url()` is not the only form. Vite's CSS url replacer is one postcss plugin
 * that tests each declaration value with two regexes and rewrites whichever
 * matched, so `image-set()` is rewritten through the *same* resolver, and
 * appending
 *
 *     .velaHiDpiMark { background-image: image-set('../runtime/run-doubles.ts' 1x); }
 *
 * to `src/styles/base.css` shipped the first `NOT_SHIPPED` entry into
 * `dist/assets/run-doubles-*.ts` at **219 modules transformed, the control's own
 * count**, with the guard as it then stood green at 30/30. That is defect 20,
 * and it is defect 16
 * one CSS function across: the fix for 16 added the form it had been shown
 * instead of the class the bundler has. So the patterns below are vite's own,
 * transcribed and compared back against the installed package by
 * `matches vite's own CSS url rewriter`, and the forms it does **not** rewrite
 * are loud rather than absent — see `cssUnfollowable`.
 */
function urlTargets(css: CssText): string[] {
  const found: string[] = [];
  const take = (raw: string): void => {
    const target = (literalOf(raw.trim(), css) ?? raw).trim();
    if (target === '' || viteSkipsUrl(target)) return;
    found.push(pointsIntoThisTree(target) ? target : `./${target}`);
  };
  for (const half of cssParts(css).declarationValues) {
    for (const match of half.matchAll(new RegExp(VITE_CSS_URL_RE.source, 'g'))) {
      const inside = match[1];
      if (inside !== undefined) take(inside);
    }
    // `image-set(a 1x, b 2x)` is a srcset, so each candidate's first token is the
    // url. A candidate that is itself a `url()` was already taken by the loop
    // above — vite runs both rewriters over such a declaration too — and one that
    // is a gradient or another image function is left alone by vite's own
    // `cssNotProcessedRE`, so it is left alone here.
    for (const match of half.matchAll(new RegExp(VITE_CSS_IMAGE_SET_RE.source, 'g'))) {
      for (const candidate of srcSetCandidates(match[1] ?? '')) {
        if (VITE_CSS_URL_RE.test(candidate) || VITE_CSS_NOT_PROCESSED_RE.test(candidate)) continue;
        take(candidate);
      }
    }
  }
  return found;
}

/** The first token of each comma-separated candidate in a srcset-shaped value. */
function srcSetCandidates(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of text) {
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts.flatMap((part) => {
    const trimmed = part.trim();
    if (trimmed === '') return [];
    let end = 0;
    let nesting = 0;
    while (end < trimmed.length) {
      const character = trimmed.charAt(end);
      if (character === '(') nesting += 1;
      else if (character === ')') nesting -= 1;
      else if (nesting === 0 && /\s/.test(character)) break;
      end += 1;
    }
    return [trimmed.slice(0, end)];
  });
}

/**
 * Whether `urlTargets` follows a CSS function of this name — asked of the
 * patterns, not of a list.
 *
 * This was a `Set` of three names, with a docblock calling it "vite's set and
 * not a longer one". It was neither checked nor complete. Deleting
 * `-webkit-image-set` from it left the suite at `33 passed (33)`, exit 0, and
 * still does against a loop written over the set's own members — a set that
 * enumerates itself cannot be short. And it *was* short: `cssImageSetRE`'s
 * lookbehind is `(?<=image-set\()`, which matches the tail of any vendor
 * prefixing, so vite rewrites `-ms-image-set(…)` as readily as
 * `-webkit-image-set(…)` and this file would have reported that one as
 * unfollowable while following it.
 *
 * So the question is put to the transcribed patterns instead: a call of this
 * name, would either regex match it? That is exactly what `urlTargets` then
 * does with it, and there is no second list to drift.
 */
function cssFunctionFollowed(name: string): boolean {
  const call = `${name}("t05")`;
  return VITE_CSS_URL_RE.test(call) || VITE_CSS_IMAGE_SET_RE.test(call);
}

/**
 * Every other CSS function in a stylesheet whose argument names a path in this tree.
 *
 * This is the half that makes the two forms above a *decision* rather than a
 * list. The reader that had `@import` and `composes` and no `url()` was silent
 * about `url()`; the reader that added `url()` was silent about `image-set()`;
 * both times the sentence in `cssSpecifiers` claiming a missing form would redden
 * was false, because a pattern nothing matches produces nothing in either
 * direction. A function form this file does not follow is now reported by name
 * and reddens `follows every edge it finds`, so the next one is a failing
 * assertion rather than a fifth round of the same finding.
 *
 * It has two halves, because vite's replacer has two halves. Inside a
 * declaration value — the only text `root.walkDecls` hands it — a function form
 * `cssFunctionFollowed` says no to is reported. *Outside* a declaration value,
 * **every** function form is reported, `url()` and `image-set()` included,
 * because there the bundler rewrites nothing at all. That second half is what
 * keeps narrowing `urlTargets` to declarations from being a silent narrowing:
 * the `@supports (background-image: url(…))` two adversaries laundered an orphan
 * through is now a named red rather than an invented edge, and it would have been
 * a named red rather than a silent drop had it been narrowed without this.
 *
 * The gate is that the argument **resolves to a file that exists here** — a
 * narrower gate than `htmlLoads`' `unread` branch uses, and narrower on purpose.
 * CSS puts functions in selectors as well as in declarations, so `.a:not(.b)`
 * would be a red under "points into this tree" and is silent under this one,
 * while `data-uri('../runtime/run-doubles.ts')` — a form vite carries a regex for
 * and applies when rebasing an imported package's stylesheet rather than to this
 * tree's own declarations — is reported rather than guessed at in either
 * direction. `format('woff2')`, `local('Vela')`, `cubic-bezier(…)` and
 * `var(--surface)` name no file here and are silent.
 *
 * What it does not see: a function whose argument list contains parentheses of
 * its own, because the scan stops at the first `)`. That is stated, not
 * discovered — `image-set(url(…))` is the one nested case that matters and it is
 * followed above.
 */
function cssUnfollowable(source: string, file: string): string[] {
  const css = readCss(source);
  const parts = cssParts(css);
  const found: string[] = [];
  const scan = (text: string, inDeclaration: boolean): void => {
    for (const match of text.matchAll(/(?<![\w-])([\w-]{1,256})\(\s*([^()]*?)\s*\)/g)) {
      const name = (match[1] ?? '').toLowerCase();
      if (inDeclaration && cssFunctionFollowed(name)) continue;
      const inside = match[2] ?? '';
      const target = (literalOf(inside, css) ?? inside).trim();
      if (target === '' || viteSkipsUrl(target)) continue;
      const asPath = pointsIntoThisTree(target) ? target : `./${target}`;
      if (resolveInTree(file, asPath) === null) continue;
      found.push(
        inDeclaration
          ? `${name}(${target}) names a path in this tree, and this reader follows only the ` +
            'CSS function forms vite rewrites: url() and image-set()'
          : `${name}(${target}) names a path in this tree and is not in a declaration value. ` +
            "vite's url replacer is `root.walkDecls`, so the bundler never rewrites this one: " +
            'following it would invent an edge, and dropping it in silence is how an orphan ' +
            'stays hidden behind one',
      );
    }
  };
  for (const value of parts.declarationValues) scan(value, true);
  for (const statement of parts.elsewhere) scan(statement, false);
  return found;
}

/** Every `composes: … from '…'` target inside a rule. */
function composesTargets(css: CssText): string[] {
  const found: string[] = [];
  for (const match of css.inRules.matchAll(
    new RegExp(`\\bcomposes\\s*:[^;]*?\\bfrom\\s+${CSS_STRING.source}`, 'g'),
  )) {
    const index = match[1];
    const value = index === undefined ? undefined : css.literals[Number(index)];
    if (value !== undefined) found.push(value);
  }
  return found;
}

/**
 * Every file a stylesheet pulls in, in the position and the file kind that
 * honour the rule naming it.
 *
 * Three rules, all three real in this tree's shape: `@import` before any other
 * rule (quoted or `url(...)`, which is how `src/styles/base.css` holds
 * `tokens.css` and `typeface.css`), the asset functions vite's url replacer
 * rewrites — `url(...)` and `image-set(...)`, which is how
 * `src/styles/typeface.css` holds its four woff2 files — and CSS Modules'
 * `composes: name from './other.module.css'` inside a `*.module.css`.
 *
 * "The forms this reader has a pattern for" was the shape of defects 16 and 20 in
 * two consecutive rounds, so the asset half is no longer a list of forms: the
 * patterns are vite's own, and `cssUnfollowable` reports any *other* function
 * naming a file that exists here rather than leaving it to be discovered.
 *
 * The sentence that stood here — "a form not listed here drops an edge, and a
 * dropped edge reddens the walk naming the file it lost" — was **false**, and it
 * was false about the biggest missing form. `url()` was not listed, the edge was
 * dropped, nothing reddened, and `src/runtime/run-doubles.ts` shipped whole into
 * `dist/assets/` at a module count identical to the control. A form this reader
 * has no pattern for is invisible in both directions; it is not loud. What is
 * loud is a form it reads and cannot *resolve* — that lands in `GRAPH.unresolved`
 * with the file and the specifier. The difference between those two sentences is
 * defect 16.
 *
 * Each pattern runs over the half of the stylesheet where its rule is legal, and
 * matches a **whole** string literal by marker rather than "text between two
 * quotes". That is what stops `content: "@import '…'"` from manufacturing an
 * edge, which it did, measured, with this file green twice. A U+0000 in the
 * source cannot forge such a marker because `readCss` has already substituted it
 * for U+FFFD, which is what the CSS grammar does with one — the version that
 * only asserted this in a comment let `@import <NUL>0<NUL>;` turn a `content`
 * string into an edge.
 *
 * And `composes` is gated by **file kind** as well as by position, which is the
 * half the version before this one did not have. Position in the grammar was
 * checked; which file kind honours the rule was not. Vite runs the CSS-modules
 * transform on `*.module.css` and on nothing else, so in a plain stylesheet
 * `composes` is an unknown declaration that is copied through and ignored — prose
 * to the bundler, an edge to the reader. Executed against that version: a
 * `composes … from '../features/canvas/T05Ghost3.module.css'` line appended to
 * `src/styles/typeface.css`, a plain stylesheet already on the graph, laundered a
 * planted orphan onto the graph and `reaches every shipping module under src/`
 * went green over dead shipped CSS — with `vite build` at **219 modules
 * transformed**, identical to the control, and the laundering text itself
 * shipped verbatim into `dist/assets/*.css`. Defect 6's own sentence, one level
 * down, in the consumer of the function written to close defect 6.
 *
 * Reading it as nothing would only trade an invented edge for a silent one, so
 * `cssInert` reports it instead: the rule is there, it does nothing, and the
 * walk says so.
 */
function cssSpecifiers(source: string, file: string): string[] {
  const css = readCss(source);
  return [
    ...importRules(css).honoured,
    ...urlTargets(css),
    ...(isCssModule(file) ? composesTargets(css) : []),
  ];
}

/**
 * Every rule in a stylesheet the file it sits in does not honour.
 *
 * The loud half of both gates above, and it has two entries rather than one
 * because a rule is honoured by a *position* and by a *file kind* and this file
 * has now been wrong about each of them once.
 *
 * A `composes` in a plain `.css` is dead text: Vite runs the CSS-modules
 * transform on `*.module.css` and on nothing else, so nothing loads what it names
 * and nothing does anything with it at runtime. An `@import` after any other rule
 * is dead text for a different reason — CSS honours `@import` only before every
 * other statement, and vite's own postcss says so in the build log — and the
 * version of `readCss` that gated it on brace depth alone counted one as an edge
 * while the bundler ignored it.
 *
 * Neither is read as nothing, because a rule that loads nothing and does nothing
 * is only ever written to be read by something that is not the bundler.
 * `honours a CSS rule only where that rule is honoured` reddens on both.
 */
function cssInert(source: string, file: string): string[] {
  const css = readCss(source);
  const found = importRules(css).late.map(
    (specifier) =>
      `@import '${specifier}' after another rule — CSS honours @import only before ` +
      'every other statement, so this loads nothing',
  );
  if (isCssModule(file)) return found;
  return [
    ...found,
    ...composesTargets(css).map(
      (specifier) =>
        `composes … from '${specifier}' — only *.module.css honours composes, so this loads nothing`,
    ),
  ];
}

/** Whichever extractor the file's kind calls for. */
function edgesOf(file: string, source: string): string[] {
  return extname(file).toLowerCase() === '.css'
    ? cssSpecifiers(source, file)
    : specifiers(source, file);
}

/** Whichever rules the file's kind writes down and does not honour. */
function inertRulesOf(file: string, source: string): string[] {
  return extname(file).toLowerCase() === '.css' ? cssInert(source, file) : [];
}

/** One specifier out of a file, and what became of it. */
type Edge = {
  /** As written, query suffix and all. */
  readonly specifier: string;
  /** The file it names as the disk spells it, or `null` for a package or nothing. */
  readonly resolved: string | null;
  /** The same file as the specifier spelled it — the other half of the casing test. */
  readonly requested: string | null;
  /** It names a path in this repository and no file is there. */
  readonly lost: boolean;
};

type DirectoryEntry = { readonly name: string; readonly isFile: boolean };

const DIRECTORY_ENTRIES = new Map<string, DirectoryEntry[]>();

/** What `directory` holds, as the filesystem spells it, files and directories alike. */
function entriesIn(directory: string): DirectoryEntry[] {
  const cached = DIRECTORY_ENTRIES.get(directory);
  if (cached !== undefined) return cached;
  let entries: DirectoryEntry[] = [];
  try {
    entries = readdirSync(directory, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
    }));
  } catch {
    entries = [];
  }
  DIRECTORY_ENTRIES.set(directory, entries);
  return entries;
}

/**
 * `path` respelled the way the filesystem spells it, **every segment**, or `null`.
 *
 * `existsSync` was the wrong instrument twice over on this box: case-blind on
 * NTFS, so `'./Run-Doubles'` "exists", and `true` for a directory, so a specifier
 * naming a folder had to be filtered out by extension. `readdirSync` answers both
 * at once. The version that replaced it respelled **only the basename**, and that
 * left the same case-blindness one segment to the left, where it mattered more:
 * `walk` keys `REACHABLE` on the string this function returns, and `NOT_SHIPPED`
 * looks a module up by `join(REPO_ROOT, 'src/runtime/run-doubles.ts')`. Executed
 * against that version — `import('../Runtime/run-doubles.ts?raw')` at module scope
 * in a file already on the graph, one capital letter different from an ordinary
 * edge. NTFS lists `src/runtime`'s entries through the mis-cased directory path,
 * so respelling the basename succeeded and the walk stored a key spelled
 * `Runtime`; the exemption asked for the key spelled `runtime`, got `false`, and
 * the first `NOT_SHIPPED` entry shipped in `dist/assets/` with every assertion
 * here green. Identity had become a string built by `join` out of segments
 * nothing had checked.
 *
 * So the whole path is walked from `REPO_ROOT` down, one `readdirSync` per
 * segment, each intermediate segment required to be a directory and the last
 * required to be a file. Two spellings of one file now produce one key, because
 * the key comes from the disk rather than from the specifier.
 *
 * A path outside `REPO_ROOT` — `resolveSpecifier` can build one out of enough
 * `../` — has no anchor to walk down from, so only its last segment is respelled.
 * It cannot be a shipping module either way: `shippingModules` enumerates `src/`.
 */
function canonical(path: string): string | null {
  const inside = relative(REPO_ROOT, path);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    const wanted = basename(path).toLowerCase();
    const real = entriesIn(dirname(path)).find(
      (entry) => entry.isFile && entry.name.toLowerCase() === wanted,
    );
    return real === undefined ? null : join(dirname(path), real.name);
  }
  const segments = inside.split(/[\\/]/).filter((segment) => segment !== '');
  let at = REPO_ROOT;
  for (let index = 0; index < segments.length; index += 1) {
    const wanted = segments[index]?.toLowerCase();
    const isLast = index === segments.length - 1;
    const real = entriesIn(at).find(
      (entry) => entry.isFile === isLast && entry.name.toLowerCase() === wanted,
    );
    if (real === undefined) return null;
    at = join(at, real.name);
  }
  return at;
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
 *
 * The alias prefixes are **read out of `vite.config.ts`**, not listed here. The
 * version that listed them said `.`, `/` and `@/`, and a fourth agent walked
 * through the gap: adding `'~': fileURLToPath(new URL('./src', import.meta.url))`
 * to `resolve.alias` and importing `'~/runtime/run-doubles.ts?raw'` produced a
 * specifier that was neither relative, nor root-absolute, nor `@/` — so it was
 * not in this tree, so it was not lost, so it was dropped in the same silent
 * `continue` defect 5 was written to abolish, and the module shipped. A prefix
 * list is a config fact; writing one here is prose about a config, which is the
 * instrument failure this file already names twice.
 *
 * Vite matches a string alias key the way `@rollup/plugin-alias` does — the
 * whole id, or the id up to the next `/` — which is why `@tauri-apps/api/core`
 * is not the `@` alias and is still correctly a package.
 *
 * And the config is not the only file that declares a prefix. A leading `#` is
 * reserved by the module specification for a package's own `imports` field, so
 * `#runtime/run-doubles` can never be a package: it is either a path in this tree
 * or a resolution failure, and both of those are this walk's business. The
 * version without that line answered `false`, which made the specifier neither an
 * edge nor lost, and dropped it in the same silent `continue` defect 5 was
 * written to abolish — defect 21, one config *file* over rather than one config
 * *key* over. `resolveInTree` translates it through `SUBPATH_IMPORTS`; a `#`
 * specifier this repo declares no mapping for is `lost` and reddens by name,
 * which is also what `vite build` does with it.
 */
function pointsIntoThisTree(
  specifier: string,
  aliases: ReadonlyMap<string, string | null> = ALIASES,
): boolean {
  const path = withoutQuery(specifier);
  if (path.startsWith('.') || path.startsWith('/') || path.startsWith('#')) return true;
  // `path === prefix` is the bare-prefix spelling — `import '~'` with `'~'`
  // declared — and it was deletable with the whole suite green while the
  // identical arm one function over, in `aliasBase`, reddened. `recognises a
  // declared prefix in every spelling that can carry one` drives both.
  return [...aliases.keys()].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** A specifier's alias prefix rewritten to a path, when this file can translate it. */
function aliasBase(path: string, aliases: ReadonlyMap<string, string | null> = ALIASES): string | null {
  for (const [prefix, target] of aliases) {
    if (target === null) continue;
    if (path === prefix) return target;
    if (path.startsWith(`${prefix}/`)) return join(target, path.slice(prefix.length + 1));
  }
  return null;
}

/**
 * A specifier resolved to a file in this tree: the disk's spelling, and the
 * spelling the specifier asked for.
 *
 * Both halves are kept because the difference between them **is** the casing
 * fault. The version this replaced returned one string and had a second function
 * re-derive the fault from the specifier's basename, which is how a mis-cased
 * *directory* segment stayed invisible in both directions at once. Here the
 * candidate that matched is carried out alongside what the disk calls it, so
 * `requested !== file` is the whole test, over every segment, including the
 * `.ts` or `/index.ts` this resolver appended itself.
 */
type Resolution = {
  /** The file, spelled the way the filesystem spells it. This is the graph's key. */
  readonly file: string;
  /** The same path as the specifier asked for it, extension resolution included. */
  readonly requested: string;
};

/**
 * A specifier resolved to a file in this tree, or `null` for anything else.
 *
 * The bare path is tried **first**, which is what makes `AppShell.module.css`
 * resolve; the old order could not reach a CSS file at all because every
 * candidate was gated on `/\.tsx?$/` before `existsSync` ran. A root-absolute
 * specifier (`/src/main.tsx`) resolves against the project root, which is how
 * Vite reads the one in `index.html`, and an aliased one against whatever
 * `resolve.alias` says.
 *
 * The query suffix is cut before any of that happens. `import('./x?raw')` is an
 * edge to the file `./x` names: Vite reads it and inlines its **source text**
 * into the bundle. Measured — one such line naming
 * `src/runtime/run-doubles.ts` put `FakeTurnDriver`'s source into a
 * `run-doubles` chunk under `dist/assets/` with this file
 * green twice and `tsc --build --force` exit 0, because `?raw` matches an
 * ambient wildcard module in `vite/client` and `tsc` therefore never resolves
 * the path at all.
 *
 * `bareIsRelative` is for `index.html` only, and it is not a convenience. In a
 * module specifier `run-doubles.ts` is a **package**; in an HTML attribute it is
 * a path relative to the document, which Vite resolves and bundles. The reader
 * that used one rule for both classified `<script type="module"
 * src="src/runtime/run-doubles.ts">` as neither an edge nor a loud one.
 */
function resolveInTree(
  fromFile: string,
  specifier: string,
  bareIsRelative = false,
  aliases: ReadonlyMap<string, string | null> = ALIASES,
  imports: ReadonlyMap<string, string | null> = SUBPATH_IMPORTS,
): Resolution | null {
  const path = withoutQuery(specifier);
  // Both halves of this, and the wire from each helper into it. `subpathBase` had
  // four synthetic assertions covering wildcard, exact key, conditions object and
  // non-subpath, and `?? subpathBase(path)` deleted with `tsc` at 0 and the whole
  // suite green, because this repo's `package.json` declares no `imports` and no
  // assertion ever called the resolver with one. Two thoroughly tested things
  // with an unasserted edge between them is the shape; the maps are parameters
  // now so `resolves a specifier through every prefix a manifest or a config can
  // declare` can drive the edge rather than the helper.
  const aliased = aliasBase(path, aliases) ?? subpathBase(path, imports);
  const base =
    aliased !== null
      ? aliased
      : path.startsWith('/')
        ? join(REPO_ROOT, path.slice(1))
        : path.startsWith('.') || bareIsRelative
          ? resolve(dirname(fromFile), path)
          : null;
  if (base === null) return null;
  for (const requested of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    const file = canonical(requested);
    if (file !== null) return { file, requested };
  }
  return null;
}

/** The same resolution, for the callers that only need the file. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  return resolveInTree(fromFile, specifier)?.file ?? null;
}

/** One thing `index.html` hands the bundler. */
type HtmlLoad =
  /** A path in this tree named by an attribute Vite rewrites. */
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

/** An attribute value that does not name a path in this document's tree. */
function externalReference(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed === '' || trimmed.startsWith('#') || /^(?:[a-zA-Z][a-zA-Z\d+\-.]*:|\/\/)/.test(trimmed)
  );
}

/** An `index.html` attribute value resolved against the document, or `null`. */
function resolveHtmlReference(value: string): Resolution | null {
  return externalReference(value) ? null : resolveInTree(HTML_ENTRY, value.trim(), true);
}

/** Tag to the attributes Vite reads as an asset reference on it. */
type HtmlAssetAttributes = {
  /** Attributes holding exactly one URL. */
  readonly url: readonly string[];
  /** Attributes holding a comma-separated candidate list this reader does not parse. */
  readonly srcset: readonly string[];
  /**
   * Whether vite's own row carries a `filter`, and this file's copy of it.
   *
   * The third of vite's three per-row keys, and the one the comparison used to
   * drop. `matches vite's own table of asset-bearing attributes` read
   * `srcAttributes` and `srcsetAttributes` back out of the installed package and
   * never `filter`, so a row that gained one — or an upgrade that moved a row
   * *behind* one — reddened nothing, while the promise directly above said an
   * upgrade that changed the table reddens this file. `meta` carries the only
   * one today, and this file's stand-in for it was a second set naming the
   * `meta` tag: a whole row dropped because one of its attribute values is
   * usually not a path. That is the laundering direction — `<meta property="og:image"
   * content="/src/…">` is an edge vite follows and this file did not — so the
   * predicate is transcribed instead of the tag being skipped.
   */
  readonly filter: ((attributes: ReadonlyMap<string, string>) => boolean) | null;
};

/**
 * The tags and attributes Vite rewrites in `index.html`, and where they came from.
 *
 * This table is not this file's opinion about HTML. It is a transcription of
 * `DEFAULT_HTML_ASSET_SOURCES` in the installed `vite` package, and
 * `matches vite's own table of asset-bearing attributes` reads that object back
 * out of `node_modules/vite/dist/` and compares it — so an upgrade that adds a
 * tag reddens this file instead of quietly leaving an edge unfollowed.
 *
 * It exists because the reader it replaces took `src=`/`href=` off **every** tag
 * and called each one an edge, on the stated grounds that "Vite rewrites in-tree
 * asset references from any element". That is broader than Vite, and broader is
 * not the safe direction here: an edge the reader invents where the bundler has
 * none launders an orphan onto the graph, which is exactly how a `composes` line
 * in a plain stylesheet laundered one. `<a href="/src/…">` was the attack; it
 * failed against a **pin** on `GRAPH.entries` rather than against a rule, and a
 * pin protects one value somebody wrote down.
 *
 * Narrowing alone would trade an invented edge for a dropped one, so both
 * directions are closed: an attribute in this table is followed, and an
 * attribute **not** in it whose value resolves to a real file in this tree is
 * `unread` and reddens.
 *
 * The sentence that stood there — "being wrong about Vite in either direction is
 * loud" — was an absolute and two adversaries disproved it in one round, in both
 * directions, using the *same* documented attribute. `getNodeAssetAttributes`
 * short-circuits on `"vite-ignore" in attributes` — after the row lookup rather
 * than before it, which is 29 — so `<link rel="stylesheet" href="/src/…"
 * vite-ignore />` was an edge here
 * and none in the bundle (the laundering direction: a planted orphan went green,
 * caught only by the `GRAPH.entries` pin), and `<script type="module"
 * src="/src/main.tsx" vite-ignore>` left `vite build` at **1 module transformed
 * against a 219-module control** — `dist/assets/` holding a lone sourcemap and
 * `dist/`'s own `index.html` pointing at a path that does not exist in the output — with
 * this guard green at 33/33. The table was a correct copy of vite's data and
 * none of the function that consumes it. `htmlLoads` now honours `vite-ignore`
 * and this table carries vite's third per-row key; what makes either claim
 * checkable rather than another sentence is `reads what the build reads, and
 * reaches nothing the build did not`, which compares this reconstruction
 * against the module set `vite build` itself reports.
 *
 * Two rows are transcribed because vite carries them and cannot fire in an HTML
 * document: the parser turns an `<image>` start tag into `img`, and `use` and
 * `image` are SVG elements, so both only appear inside an `<svg>` subtree. They
 * stay in the table because the table's job is to equal vite's, not to be the
 * shorter list of the two.
 *
 * `meta` used to be listed and then dropped by name, on the grounds that
 * `<meta name="viewport" content="width=device-width, …">` is not a path. Vite
 * expresses that as a `filter` on the row, over two allow-lists it carries, so
 * the predicate is transcribed and the row is followed when the predicate says
 * so — which makes `<meta property="og:image" content="/src/…">` the edge it is.
 */
const ALLOWED_META_NAME = [
  'msapplication-tileimage',
  'msapplication-square70x70logo',
  'msapplication-square150x150logo',
  'msapplication-wide310x150logo',
  'msapplication-square310x310logo',
  'msapplication-config',
  'twitter:image',
];

const ALLOWED_META_PROPERTY = [
  'og:image',
  'og:image:url',
  'og:image:secure_url',
  'og:audio',
  'og:audio:secure_url',
  'og:video',
  'og:video:secure_url',
];

/** vite's `filter` on the `meta` row, transcribed. */
function metaCarriesAnAsset(attributes: ReadonlyMap<string, string>): boolean {
  const name = attributes.get('name');
  const property = attributes.get('property');
  if (name !== undefined && ALLOWED_META_NAME.includes(name.trim().toLowerCase())) return true;
  return property !== undefined && ALLOWED_META_PROPERTY.includes(property.trim().toLowerCase());
}

const HTML_ASSET_SOURCES = new Map<string, HtmlAssetAttributes>([
  ['audio', { url: ['src'], srcset: [], filter: null }],
  ['embed', { url: ['src'], srcset: [], filter: null }],
  ['img', { url: ['src'], srcset: ['srcset'], filter: null }],
  ['image', { url: ['href', 'xlink:href'], srcset: [], filter: null }],
  ['input', { url: ['src'], srcset: [], filter: null }],
  ['link', { url: ['href'], srcset: ['imagesrcset'], filter: null }],
  ['meta', { url: ['content'], srcset: [], filter: metaCarriesAnAsset }],
  ['object', { url: ['data'], srcset: [], filter: null }],
  ['source', { url: ['src'], srcset: ['srcset'], filter: null }],
  ['track', { url: ['src'], srcset: [], filter: null }],
  ['use', { url: ['href', 'xlink:href'], srcset: [], filter: null }],
  ['video', { url: ['src', 'poster'], srcset: [], filter: null }],
]);

/**
 * The attribute that takes a tag out of vite's hands entirely.
 *
 * Documented, first-class vite API, and it is honoured on **two kinds of tag
 * and no others**. `getScriptInfo` reads it into `isIgnored` for every
 * `<script>`, and the build-time script branch is
 * `if (isIgnored) removeViteIgnoreAttr(…) else { … }`. `getNodeAssetAttributes`
 * reads it for a tag with a row in the table above and for no other, because the
 * function opens `const matched = DEFAULT_HTML_ASSET_SOURCES[node.nodeName]; if
 * (!matched) return [];` and tests `"vite-ignore" in attributes` after that.
 * Measured on the installed vite@7.3.6: the row lookup is at offset 57 of that
 * function body and the attribute test at offset 230.
 *
 * So a tag carrying it is a tag the bundler reads and then declines to act on,
 * which is neither an edge nor — since the maintainer said so on purpose — a
 * surprise worth reddening on its own. It is `unread` rather than silent all the
 * same, because what it takes out of the graph is real: on the one script tag in
 * this document it takes the whole product out.
 *
 * On a tag with no row and no script branch it takes nothing out, because there
 * was nothing there to take: vite returns `[]` for an `<a>` before it has looked
 * at a single attribute, and does not even strip the marker. Round 6 tested the
 * attribute ahead of the tag dispatch for **every** element and stated the
 * ordering backwards in four separate paragraphs, so
 * `<a href="/src/main.tsx" vite-ignore>` was reported as *the bundler is told to
 * leave this tag alone, so everything it names is out of the build* — a message
 * asserting something false about the build, which is the delete-me direction
 * this file already records for `<noscript>`. `honoursViteIgnore` is where the
 * two kinds are decided, and `honours vite-ignore where the bundler honours it,
 * and reads a style attribute either way` is what asserts them.
 */
const VITE_IGNORE = 'vite-ignore';

/**
 * The tags on which `vite-ignore` changes what the bundler does.
 *
 * A row in `HTML_ASSET_SOURCES` is `getNodeAssetAttributes`' own gate, and
 * `<script>` is `getScriptInfo`'s. Every other tag reads the attribute as an
 * ordinary unknown attribute, which is to say it does not read it.
 */
function honoursViteIgnore(tag: string): boolean {
  return tag === 'script' || HTML_ASSET_SOURCES.has(tag);
}

/** Tags whose children the bundler's parser never builds elements for. */
const RAW_TEXT_WHEN_SCRIPTING = new Set(['noscript']);

/** `{ … }` starting at or after `from`, brace-matched. */
function braceBlock(text: string, from: number): string | null {
  const open = text.indexOf('{', from);
  if (open === -1) return null;
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open, index + 1);
    }
  }
  return null;
}

/** vite's CSS url replacer as the installed package spells it. */
type ViteCssRewriter = {
  /** `cssUrlRE`'s source, to compare against this file's transcription. */
  readonly url: string;
  /** `cssImageSetRE`'s source, likewise. */
  readonly imageSet: string;
  /** `cssNotProcessedRE`'s source, likewise. */
  readonly notProcessed: string;
  /** The regexes the declaration walker actually tests, in the order it tests them. */
  readonly tested: readonly string[];
};

/**
 * Vite's `UrlRewritePostcssPlugin` and its patterns, read out of the installed package.
 *
 * `null` when it cannot be found, which reddens rather than passing — the point
 * is that `VITE_CSS_URL_RE` and its two neighbours stop being this file's claim
 * about CSS and become a comparison, the same way `HTML_ASSET_SOURCES` is.
 *
 * `tested` is the half that closes the class rather than the instance. Reading
 * the two regexes back only proves the two forms this file knows about still look
 * the way it thinks; reading back *which* regexes the plugin's `walkDecls` tests
 * against `declaration.value` is what makes a third form — vite growing a
 * `cssSomethingRE` beside them — a failing assertion here instead of another
 * silent drop.
 */
function viteCssRewriter(): ViteCssRewriter | null {
  const directories = [
    join(REPO_ROOT, 'node_modules', 'vite', 'dist', 'node'),
    join(REPO_ROOT, 'node_modules', 'vite', 'dist', 'node', 'chunks'),
  ];
  for (const directory of directories) {
    for (const entry of entriesIn(directory)) {
      if (!entry.isFile || !entry.name.endsWith('.js')) continue;
      const text = readFileSync(join(directory, entry.name), 'utf8');
      // The definition, not the first mention: the plugin is *used* about two
      // hundred lines above the line that declares it.
      const at = text.indexOf('UrlRewritePostcssPlugin = ');
      if (at === -1) continue;
      const literal = (name: string): string | null => {
        const match = new RegExp(`\\b${name}\\s*=\\s*(/.*/)[a-z]*\\s*;`).exec(text);
        const source = match?.[1];
        return source === undefined ? null : source.slice(1, -1);
      };
      const url = literal('cssUrlRE');
      const imageSet = literal('cssImageSetRE');
      const notProcessed = literal('cssNotProcessedRE');
      if (url === null || imageSet === null || notProcessed === null) continue;
      const tested = [
        ...text.slice(at, at + 4000).matchAll(/\b(css\w*RE)\.test\(declaration\.value\)/g),
      ].map((match) => match[1] ?? '');
      return { url, imageSet, notProcessed, tested };
    }
  }
  return null;
}

/** One row of vite's own table, as the installed package spells it. */
type ViteAssetRow = {
  /** `srcAttributes`. */
  readonly url: readonly string[];
  /** `srcsetAttributes`. */
  readonly srcset: readonly string[];
  /**
   * Whether the row carries a `filter`.
   *
   * Vite's row has three keys and the comparison used to read two. A predicate
   * cannot be compared as text across an upgrade, but its **presence** can, and
   * presence is the half that matters: a row that grows a filter is a row this
   * file would otherwise keep following unconditionally, and a row that loses one
   * is an edge this file would keep declining.
   */
  readonly hasFilter: boolean;
};

/**
 * Vite's own `DEFAULT_HTML_ASSET_SOURCES`, read out of the installed package.
 *
 * `null` when it cannot be found, which reddens rather than passing: the whole
 * point is that the table above stops being a claim and becomes a comparison.
 */
function viteHtmlAssetSources(): Map<string, ViteAssetRow> | null {
  const directories = [
    join(REPO_ROOT, 'node_modules', 'vite', 'dist', 'node'),
    join(REPO_ROOT, 'node_modules', 'vite', 'dist', 'node', 'chunks'),
  ];
  for (const directory of directories) {
    for (const entry of entriesIn(directory)) {
      if (!entry.isFile || !entry.name.endsWith('.js')) continue;
      const text = readFileSync(join(directory, entry.name), 'utf8');
      const at = text.indexOf('DEFAULT_HTML_ASSET_SOURCES');
      if (at === -1) continue;
      const block = braceBlock(text, at);
      if (block === null) continue;
      const found = new Map<string, ViteAssetRow>();
      const body = block.slice(1, -1);
      for (const match of body.matchAll(/([A-Za-z][\w-]*)\s*:\s*\{/g)) {
        const tag = match[1];
        if (tag === undefined) continue;
        const inner = braceBlock(body, match.index);
        if (inner === null) continue;
        const list = (name: string): string[] => {
          const array = new RegExp(`${name}\\s*:\\s*\\[([^\\]]*)\\]`).exec(inner);
          return array === null || array[1] === undefined
            ? []
            : [...array[1].matchAll(/["']([^"']+)["']/g)].flatMap((one) =>
                one[1] === undefined ? [] : [one[1]],
              );
        };
        found.set(tag, {
          url: list('srcAttributes'),
          srcset: list('srcsetAttributes'),
          hasFilter: /(?:^|[\s,{])filter\s*[({]/.test(inner),
        });
      }
      if (found.size > 0) return found;
    }
  }
  return null;
}

/**
 * A `const NAME = [ … ]` array of strings out of the installed vite package.
 *
 * `ALLOWED_META_NAME` and `ALLOWED_META_PROPERTY` are the data behind the one
 * `filter` in vite's table, and transcribing data without comparing it back is
 * the mistake `HTML_ASSET_SOURCES`' own header spent two rounds on.
 */
function viteStringArray(name: string): string[] | null {
  const directories = [
    join(REPO_ROOT, 'node_modules', 'vite', 'dist', 'node'),
    join(REPO_ROOT, 'node_modules', 'vite', 'dist', 'node', 'chunks'),
  ];
  for (const directory of directories) {
    for (const entry of entriesIn(directory)) {
      if (!entry.isFile || !entry.name.endsWith('.js')) continue;
      const text = readFileSync(join(directory, entry.name), 'utf8');
      const at = text.indexOf(`${name} = [`);
      if (at === -1) continue;
      const end = text.indexOf(']', at);
      if (end === -1) continue;
      return [...text.slice(at, end).matchAll(/["']([^"']+)["']/g)].flatMap((one) =>
        one[1] === undefined ? [] : [one[1]],
      );
    }
  }
  return null;
}

/**
 * The markup, parsed by the parser the bundler parses it with.
 *
 * This file has now hand-rolled an HTML reader three times and been wrong about
 * the grammar every time, in four separate spellings, each one found by
 * executing it rather than by reading it:
 *
 * - Two independent passes, `<!-- … -->` stripped first and `<script>` bodies
 *   extracted second, so a `<!--` in one module script's body and a `-->` in a
 *   later one deleted the tag between them (defect 9; guard green twice, `vite
 *   build` exit 0 at 223 modules against a 219 control, `run-doubles.ts` in
 *   `dist/assets/`).
 * - One left-to-right tokenizer, but its comment-end rule was `-->` only, while
 *   the spec — and parse5 — also end a comment at `--!>`, so `<!-- x --!>` before
 *   an inline module script erased the rest of the document from the reader while
 *   Vite compiled and shipped it (guard green twice at 30/30, 221 modules against
 *   219, the double's bytes in `dist/assets/index-*.js`).
 * - The same tokenizer's raw-text-end rule was `</script\s*>`, while parse5 ends
 *   the element at `</script` followed by whitespace, `/` or `>`, so
 *   `</script/>` or `</script x>` in a body let one script swallow a real module
 *   script tag — the direction two comments in this file said could not happen.
 * - And `tagEnd` treated an apostrophe inside an **unquoted** attribute value as
 *   opening a quoted region, which parse5 treats as data. `<div id="root"
 *   title=Vela's>` … `<span data-note=don't>` made one `div` token swallow the
 *   inline module script between them: guard green twice at 30/30, `tsc -b
 *   --force` exit 0, `vite build` exit 0 at 221 modules against 219, and
 *   `run-doubles.ts`'s bytes in the shipped entry chunk.
 *
 * Four fixes to those four rules would be a fifth guess at the grammar. The
 * grammar is not in doubt and it is not this file's to restate: `vite build`
 * parses `index.html` with **parse5**, and the `jsdom` environment this test
 * already runs in parses HTML with parse5 too. So the reader stops tokenizing and
 * asks the DOM.
 *
 * They are not the same copy, and saying they were would be this file's own
 * failure mode. Vite bundles parse5 into `node_modules/vite/dist/node/chunks/
 * dist.js` and declares it as a devDependency at `^8.0.0`; jsdom depends on it at
 * `^7.2.1` and the installed one is `parse5@7.3.0`. What is shared is the WHATWG
 * tokenizer both implement, not the binary — so the residue is "the two majors
 * disagree somewhere", which is one surface a reviewer can watch, against three
 * hand-written termination rules and an attribute rule that were each wrong.
 *
 * What that buys, and it is bounded rather than total: this reader and the
 * bundler build the same element tree out of the same bytes wherever the two
 * parse5 majors agree *and the two callers configure the parser the same way*.
 * The sentence that stood here claimed the absolute — that this reader "can no
 * longer disagree with the bundler about **what is markup**" — and it was false
 * on both halves of that qualifier, measured rather than argued.
 *
 * jsdom parses with scripting **disabled** and vite's parse5 runs with it
 * enabled, so a `<noscript>`'s content is an element subtree here and a single
 * raw-text node there. `<noscript><link rel="stylesheet" href="…"></noscript>`
 * left `vite build` at **219 modules, the control's own count**, with the `link`
 * never resolved, and turned this guard **red** with a message that asserted
 * something false about that build. That is the delete-me direction — a red on
 * ordinary boilerplate — so the walk below stops at a `noscript` element, which
 * is where the bundler's parser stops. The `specifiersOfLoad` and `unreadOf`
 * expectations over a `noscript` inside `stops where the bundler's traversal
 * stops, and reads what it reads` are what drive it.
 *
 * And agreement about the element tree was never agreement about what vite does
 * with the elements in it. `vite-ignore` and an inline `style="…url(…)…"` are
 * both nodes both parsers build identically, and vite acts on exactly one of
 * them; that half is `htmlLoads`', and it is stated there rather than claimed
 * away here. Duplicate attributes resolve to the
 * first occurrence here because they do in the parser (the hand-written map kept
 * the last, and one repeated `src=` on the existing entry tag left
 * `GRAPH.entries` pinned to `['src/main.tsx']` while `vite build` compiled five
 * modules instead of 219 — the guard green over a bundle containing none of the
 * product). A script-data-escaped `<!--<script>` keeps the element open here
 * because it does in the parser.
 *
 * The sentence that stood here — that a tag the bundler cannot see is a tag this
 * file cannot see either, "agreement rather than a direction" — was an absolute
 * and it was false the day it was written. The parser buys agreement about the
 * *grammar*. It does not buy agreement about which of the nodes that parser built
 * you then read. `querySelectorAll('*')` returns the element tree of the
 * **document**, and a `<template>`'s children are not in it: parse5 puts them in
 * a `DocumentFragment` hanging off the element, and vite's own traversal descends
 * into it. `<template><script type="module">import { FakeTurnDriver } from
 * '/src/runtime/run-doubles.ts'; …</script></template>` in `index.html` was
 * therefore a tag the bundler saw and this file did not — 221 modules against a
 * 219-module control, `no turn has
 * been sent` in the shipped entry chunk, with
 * the guard as it then stood green at 30/30. That is defect 19, and the loop below closes it by
 * descending into any element that carries a parsed subtree of its own, keyed on
 * the property rather than on the tag name, so the next element the DOM gives a
 * `content` fragment to is walked without this file being edited.
 *
 * What it does not buy: parse5 answers "what is in the document", not "what does
 * Vite do with it". Which attributes are asset references is still
 * `HTML_ASSET_SOURCES`, checked against vite's own table; which script bodies are
 * modules is still `htmlLoads`. And a tag the parser drops entirely — an
 * unterminated one at end of file — is a tag the bundler drops too, so it is no
 * longer reported as `unread`: there is no token to report. That is a real
 * narrowing of the loud list and it is stated rather than discovered, with the
 * consequence asserted inside `reads a script body as text, not as a place
 * comments can start`, under the message `the parser drops it`. The citation
 * that stood here named an `it()` that exists nowhere in this file — the round-4
 * measurer's own finding, "the citation of an assertion name that exists
 * nowhere", recurring one paragraph away one round later.
 *
 * Where the walk **stops** is a third thing parse5 does not settle, and it is
 * settled here rather than left to whichever parser is nearer: a `noscript`
 * element's children are markup to jsdom (scripting disabled) and a raw-text
 * node to vite's parse5 (scripting enabled), so the walk does not descend into
 * one. Descending is a red on markup the bundler compiles unchanged.
 */
function htmlElements(html: string): readonly Element[] {
  const found: Element[] = [];
  const visit = (root: ParentNode): void => {
    for (const element of root.children) {
      found.push(element);
      // Where the bundler's parser stops. Not a skip of the element — the tag
      // itself is still classified — a skip of its contents.
      if (RAW_TEXT_WHEN_SCRIPTING.has(element.tagName.toLowerCase())) continue;
      visit(element);
      const content = (element as { readonly content?: DocumentFragment }).content;
      if (content !== undefined && typeof content.children === 'object') visit(content);
    }
  };
  visit(new DOMParser().parseFromString(html, 'text/html'));
  return found;
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
 * - A `<script>`, or a tag with a row in `HTML_ASSET_SOURCES`, carrying
 *   **`vite-ignore`** is `unread`, and nothing that row or that branch would
 *   have followed is followed. Those two tags are `honoursViteIgnore`, and they
 *   are the two places the bundler reads the attribute: `getScriptInfo` for a
 *   script, `getNodeAssetAttributes` **after** its row lookup for the rest. On
 *   the one script tag in this document it takes the entire product out of the
 *   bundle — `vite build` at 1 module against a 219-module control — so it is
 *   reported rather than passed over in silence. A `style` attribute is read
 *   either way, because `findNeedTransformStyleAttribute` is called on every
 *   node with no reference to `vite-ignore` at all.
 * - An attribute **in `HTML_ASSET_SOURCES`**, whose row-level `filter` (vite's,
 *   transcribed) admits it, naming a path in this tree is a `file`. Any *other*
 *   attribute whose value resolves to a real file here is `unread` and reddens,
 *   so being wrong about which tags Vite rewrites is loud in both directions
 *   rather than silently inventing or dropping an edge.
 * - A `style` attribute is a **declaration list**, and vite hands any whose value
 *   contains `url(` or `image-set(` to the same postcss url replacer a stylesheet
 *   goes through (`findNeedTransformStyleAttribute`, then the
 *   `?html-proxy&inline-css&style-attr` id). So it is read by this file's CSS
 *   reader rather than by asking whether the whole attribute value happens to
 *   name a file — which is what it did, and why
 *   `style="background-image: url('/src/runtime/run-doubles.ts')"` on the tag
 *   already in this document was neither an edge nor loud while all 10636 bytes
 *   of the first `NOT_SHIPPED` entry went into `dist/assets/`.
 * - An inline `type="module"` body is `inline`: source, read by the same
 *   extractor every `.ts` file is read by, with its edges resolved against the
 *   repo root exactly as the tag's own `src` would be. `type` is compared to
 *   `module` **byte for byte**, because `getScriptInfo` does; the version that
 *   trimmed and lower-cased first had a strictly wider set than the bundler, so
 *   `<script type="Module">import '…'</script>` was a module body here and a
 *   data block there, and its edges reached `reachable` without ever touching
 *   the entry pin. A `src` on any script,
 *   unlike a module specifier, is a **document-relative path** when it is bare:
 *   `src="src/runtime/run-doubles.ts"` is a file Vite resolves and bundles, and
 *   the reader that applied ESM's bare-means-package rule to it classified that
 *   tag as neither an edge nor a loud one.
 * - Everything else that can execute or fetch is `unread` and **reddens** this
 *   file: a classic `<script>` (whose body this file does not parse and whose
 *   `document.write` or `import()` it cannot see), an import map (which can
 *   repoint a bare specifier at a file in this tree), a module script carrying
 *   both a `src` and a body, a `<style>` body (whose `@import` this reader does
 *   not follow). None exist here today; the next one stops the build instead of
 *   silently widening the entry set. An unterminated tag was on this list and is
 *   not any more: parse5 drops it, so there is no element to classify — and the
 *   bundler drops it for the same reason, which is the only ground on which
 *   dropping it here is honest.
 *
 * One thing to know before adding a favicon: Vite serves a static directory at
 * the URL root as well as the project root, so `/vela.svg` would mean
 * `public/vela.svg`. There is no such directory in this repo — `git ls-files`
 * matches nothing under `public/` — so `resolveSpecifier` does not look there,
 * and the first root-absolute reference to a static asset will land in
 * `unresolved` rather than go quiet. Teach the resolver that directory then,
 * with a file in it to prove the branch runs.
 *
 * And know the other half of that, which this paragraph used to leave unsaid:
 * `public/` is not only a place `resolveSpecifier` does not look, it is a second
 * shipping channel. Vite copies every file in it into `dist/` verbatim, with no
 * module graph, no entry and no config key — `publicDir` defaults to `public`
 * — so nothing in this file governed it. An adversary made the directory and
 * copied the first `NOT_SHIPPED` entry into it: a `run-doubles.ts` at the top of `dist/`, 10636
 * bytes, byte-identical to the source, at 219 modules, the control's own count,
 * with this file green. `names everything public/ ships` reads the resolved
 * `publicDir` and pins what is in it.
 */
function htmlLoads(html: string): HtmlLoad[] {
  const found: HtmlLoad[] = [];
  for (const element of htmlElements(html)) {
    const tag = element.tagName.toLowerCase();
    const body = element.textContent ?? '';
    const hasBody = body.trim() !== '';
    const attributes = new Map<string, string>();
    for (const attribute of element.attributes) {
      if (!attributes.has(attribute.name.toLowerCase())) {
        attributes.set(attribute.name.toLowerCase(), attribute.value);
      }
    }
    // Honoured where the bundler honours it and nowhere else — see
    // `honoursViteIgnore`. It is reported rather than dropped: on this
    // document's one script tag it removes the whole product from the bundle,
    // and a guard that goes quiet about that is the guard two adversaries walked
    // through in one round. It does not `continue` past the `style` attribute
    // below, because vite's `findNeedTransformStyleAttribute` runs on every node
    // whatever `getNodeAssetAttributes` returned for it.
    if (attributes.has(VITE_IGNORE) && honoursViteIgnore(tag)) {
      found.push({
        kind: 'unread',
        text: collapse(
          `<${tag} ${VITE_IGNORE}> — the bundler is told to leave this tag alone, so ` +
            'everything it names is out of the build. Deliberate on a vendor snippet, ' +
            'and the whole bundle on the entry script',
        ),
      });
    } else if (tag === 'style') {
      if (hasBody) found.push({ kind: 'unread', text: collapse(element.outerHTML) });
    } else if (tag === 'script') {
      // `getScriptInfo` is `p.name === "type" && p.value === "module"` — byte
      // exact, no trim and no case fold. The reader that lower-cased first had a
      // strictly wider set than the bundler, so `<script type="Module">import
      // '…'</script>` was a module body here, a plain data block there, and its
      // specifiers went into `reachable` without ever reaching `GRAPH.entries` —
      // an orphan laundered onto the graph by a script the build never compiled.
      const type = attributes.get('type') ?? null;
      const source = attributes.get('src') ?? null;
      if (type === 'module') {
        if (source !== null && hasBody) {
          found.push({ kind: 'unread', text: collapse(element.outerHTML) });
        } else if (source !== null && !externalReference(source)) {
          found.push({ kind: 'file', specifier: source });
        } else if (hasBody) {
          found.push({ kind: 'inline', source: body });
        }
      } else if (source !== null || hasBody) {
        found.push({ kind: 'unread', text: collapse(element.outerHTML) });
      }
    } else {
      const table = HTML_ASSET_SOURCES.get(tag);
      for (const [name, value] of attributes) {
        if (externalReference(value)) continue;
        const row = table !== undefined && table.url.includes(name) ? table : undefined;
        if (row !== undefined && (row.filter === null || row.filter(attributes))) {
          found.push({ kind: 'file', specifier: value });
          continue;
        }
        const candidates =
          table !== undefined && table.srcset.includes(name)
            ? value.split(',').map((one) => one.trim().split(/\s+/)[0] ?? '')
            : [value];
        if (candidates.some((one) => resolveHtmlReference(one) !== null)) {
          found.push({
            kind: 'unread',
            text: collapse(`<${tag} ${name}="${value}"> names a file this reader does not follow`),
          });
        }
      }
    }
    // Vite's `findNeedTransformStyleAttribute` matches any `style` attribute
    // whose value merely *contains* `url(` or `image-set(` and routes the value
    // through the CSS pipeline as `?html-proxy&inline-css&style-attr`. This
    // reader classified a non-table attribute by asking whether the **whole
    // value** resolved to a file, and `background-image: url('…')` does not, so
    // `<div id="root" style="background-image: url('/src/runtime/run-doubles.ts')">`
    // — one attribute on the tag already in this document — was neither an edge
    // nor a loud one, while `vite build` went to 220 modules against 219 and put
    // all 10636 bytes of the first NOT_SHIPPED entry in `dist/assets/`. Two
    // adversaries landed it independently, two rounds running.
    const style = attributes.get('style');
    if (style !== undefined && (style.includes('url(') || style.includes('image-set('))) {
      for (const specifier of styleAttributeTargets(style)) {
        found.push({ kind: 'file', specifier });
      }
    }
  }
  return found;
}

/**
 * The in-tree targets of an inline `style` attribute, read the way vite reads
 * a declaration value.
 *
 * The attribute's value *is* a declaration list, which is why vite can hand it
 * to the same postcss url replacer a stylesheet's declarations go through. So it
 * is wrapped in a rule and read by the same reader, rather than by a second
 * hand-written pattern beside it — the mistake this file has now made in CSS
 * three times.
 */
function styleAttributeTargets(value: string): string[] {
  return urlTargets(readCss(`.style-attribute { ${value} }`));
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
 * True when the disk spells this path differently from the way it was asked for.
 *
 * There is nothing to re-derive here: `resolveInTree` already carries out both
 * the candidate it matched and what the filesystem calls it, so the comparison
 * is the whole string, every segment, extension and index resolution included.
 *
 * The version this replaces compared **basenames**. Its own doc said so — "only
 * the segment the specifier actually wrote is compared" — without noticing that
 * a specifier writes its directory segments too. A specifier that spells the
 * directory segment of `src/runtime/run-doubles.ts` with a capital R therefore
 * returned `false`: the basename it wrote and the basename on disk are the same
 * string. That is the same blank screen on a case-sensitive filesystem as an
 * all-lowercase spelling of `src/app/shell/AppShell.module.css`, which it did
 * catch — a difference of one segment, and no difference at all in what a
 * case-sensitive checkout would do with it. It was also, on this box, a
 * different key in `REACHABLE` from the one `NOT_SHIPPED` looks up — which is
 * how the double this guard exists to exclude reached `dist/assets/` with the
 * round-2 guard green in two consecutive runs at 24 assertions passed.
 */
function miscasedRequest(resolution: Resolution): boolean {
  return resolution.requested !== resolution.file;
}

/**
 * Facts this file would otherwise have hard-coded from `vite.config.ts`.
 *
 * Four of the rules above are really claims about that config: `resolveInTree`
 * translates the alias prefixes, `pointsIntoThisTree` recognises them,
 * `TEST_FILE` claims to match `test.include`, and `NOT_SHIPPED` exempts
 * `src/test/setup.ts` on the grounds that it is a `setupFiles` entry. Each was
 * written here as prose, and prose about a config is the same instrument failure
 * as prose about an import: it can stop being true without anything noticing.
 * Since the parser is already loaded, they are read out of the config instead.
 */
const VITE_CONFIG_PATH = 'vite.config.ts';

const VITE_CONFIG = parse(
  readFileSync(join(REPO_ROOT, VITE_CONFIG_PATH), 'utf8'),
  VITE_CONFIG_PATH,
);

/**
 * The object literal a config module exports, through `defineConfig(…)` or not.
 *
 * This is where the path in `configProperty` starts, and having a start is the
 * fix. The reader it replaces took the initializer of the **first**
 * `PropertyAssignment` named `alias` **anywhere in the file**, with no path and
 * no parent — so moving the `test:` block above `resolve:` (an inert reordering
 * of an object literal) and giving it a decoy `test.alias` of `{ '@': … }` let
 * the real `resolve.alias` grow a second prefix while
 * `holds its claims about vite.config.ts to vite.config.ts` — the assertion
 * whose entire job is to catch that — went green. Executed, twice, with the
 * second prefix carrying `run-doubles.ts` into `dist/assets/`.
 *
 * §8 of this file's header is that a name is not a binding. A config reader that
 * identifies a property by bare name is that mistake one file kind over.
 */
function configRootOf(source: ts.SourceFile): ts.ObjectLiteralExpression | null {
  let found: ts.ObjectLiteralExpression | null = null;
  eachNode(source, (node) => {
    if (found !== null || !ts.isExportAssignment(node) || node.isExportEquals === true) return;
    let expression: ts.Expression = node.expression;
    const wrapped = ts.isCallExpression(expression) ? expression.arguments[0] : undefined;
    if (wrapped !== undefined) expression = wrapped;
    if (ts.isObjectLiteralExpression(expression)) found = expression;
  });
  return found;
}

const VITE_CONFIG_ROOT = configRootOf(VITE_CONFIG);

/**
 * The initializer at `path` in a config's exported object, or `null`.
 *
 * Each step is looked up **in one object literal**, and the last property of that
 * name wins, because that is the one JavaScript keeps when a literal repeats a
 * key. A name matched anywhere in the file is not a property of the config.
 */
function configProperty(
  path: readonly string[],
  root: ts.ObjectLiteralExpression | null = VITE_CONFIG_ROOT,
): ts.Expression | null {
  let at: ts.Expression | null = root;
  for (const name of path) {
    if (at === null || !ts.isObjectLiteralExpression(at)) return null;
    let next: ts.Expression | null = null;
    for (const property of at.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      if (propertyName(property.name) === name) next = property.initializer;
    }
    at = next;
  }
  return at;
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

/**
 * The keys of an object literal, or `[]` for anything else.
 *
 * A property that is not a named assignment comes back as its **syntax kind**,
 * the way `calleeNames` reports an array element it does not understand, and for
 * the same reason: skipping it is how a key list stops describing the object.
 * `export default defineConfig({ plugins: [react()], …, ...packaging })` with a
 * trailing spread overwrites `plugins` at runtime while the literal's own
 * `plugins: [react()]` is still on the page for `calleeNames` to read — so both
 * pins written to close defect 18 passed over a config vite never received, and
 * `vite build` shipped the double at 221 modules against 219. That is defect 22.
 * The reader that produced it did `if (!ts.isPropertyAssignment(property))
 * continue;` in three places; this is one of them, `unreadableProperties` is the
 * sweep that covers the other two, and neither is a list of spellings.
 */
function objectKeys(node: ts.Expression | null): string[] {
  if (node === null || !ts.isObjectLiteralExpression(node)) return [];
  return node.properties.flatMap((property) => {
    if (!ts.isPropertyAssignment(property)) return [`<${ts.SyntaxKind[property.kind]}>`];
    const name = propertyName(property.name);
    return name === null ? [`<${ts.SyntaxKind[property.name.kind]}>`] : [name];
  });
}

/**
 * Every object property in a source file that is not a plain named assignment.
 *
 * `configProperty`, `objectKeys` and `aliasesIn` all read a config by walking
 * `PropertyAssignment`s, so anything else in one of those literals is a part of
 * the config none of them can see. Rather than teach each reader a rule, the
 * whole file is swept once and the result pinned empty: a spread, a shorthand, a
 * method, a getter or a computed key anywhere in `vite.config.ts` reddens and
 * names itself, and the pins above go on meaning what they say.
 *
 * Sweeping the file rather than the exported literal is deliberate. The evasion
 * that motivated it put the payload in a *second file* and spread the import in;
 * a sweep of the root object alone would have caught that one, and a sweep of the
 * file also catches the same trick one level down in `resolve` or `test`.
 */
function unreadableProperties(source: ts.SourceFile): string[] {
  const found: string[] = [];
  eachNode(source, (node) => {
    if (!ts.isObjectLiteralExpression(node)) return;
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property) && propertyName(property.name) !== null) continue;
      found.push(`<${ts.SyntaxKind[property.kind]}> ${collapse(property.getText(source), 60)}`);
    }
  });
  return found;
}

/**
 * The callee of every element of an array literal — `[react()]` → `['react']` —
 * or `null` when the node is not an array literal at all.
 *
 * `null` rather than `[]`, because `[]` is a real answer (`plugins: []`) and "not
 * an array" has to redden rather than read as "no plugins". An element that is
 * not a plain call comes back as its syntax kind, which reddens the same way: the
 * point is that a reviewer sees the change, not that this file understands it.
 */
function calleeNames(node: ts.Expression | null): string[] | null {
  if (node === null || !ts.isArrayLiteralExpression(node)) return null;
  return node.elements.map((element) => {
    if (ts.isCallExpression(element) && ts.isIdentifier(element.expression)) {
      return element.expression.text;
    }
    return ts.isIdentifier(element) ? element.text : `<${ts.SyntaxKind[element.kind]}>`;
  });
}

/**
 * An alias target this file can turn into a path, or `null` for one it cannot.
 *
 * `null` is not a shrug. A prefix that is declared and untranslatable still makes
 * `pointsIntoThisTree` true, so every specifier using it resolves to nothing,
 * lands in `GRAPH.unresolved` and reddens by name. The unsafe answer would be to
 * not know the prefix at all, which is what dropped `'~/runtime/run-doubles.ts'`
 * in silence.
 */
function aliasTarget(node: ts.Expression): string | null {
  if (ts.isStringLiteralLike(node)) return resolve(REPO_ROOT, node.text);
  // `fileURLToPath(new URL('./src', import.meta.url))` — the spelling this
  // config uses, and the one Vite's own documentation gives.
  const inner = ts.isCallExpression(node) ? node.arguments[0] : undefined;
  if (inner !== undefined && isAssetUrl(inner)) {
    const relativeTo = inner.arguments?.[0];
    const text = relativeTo === undefined ? null : staticSpecifier(relativeTo);
    if (text !== null) return resolve(REPO_ROOT, text);
  }
  return null;
}

/** Every `resolve.alias` prefix the config declares, to a path or to `null`. */
function aliasesIn(root: ts.ObjectLiteralExpression | null): Map<string, string | null> {
  const found = new Map<string, string | null>();
  const node = configProperty(['resolve', 'alias'], root);
  if (node === null || !ts.isObjectLiteralExpression(node)) return found;
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyName(property.name);
    if (name === null) continue;
    found.set(name, aliasTarget(property.initializer));
  }
  return found;
}

const ALIASES = aliasesIn(VITE_CONFIG_ROOT);

/**
 * `package.json`, as text and as data.
 *
 * This file is here because a fifth-round adversary put `run-doubles.ts` in
 * `dist/` without touching `vite.config.ts` or `index.html` at all. Two edits:
 * `"imports": { "#runtime/*": "./src/runtime/*.ts" }` beside the existing
 * `"type": "module"`, and one `void import('#runtime/run-doubles')` in a module
 * already on the graph. `vite build` exit 0 at 220 modules against a 219-module
 * control with the double's own chunk in `dist/assets/`; `tsc -b --force` exit 0,
 * because `moduleResolution: "bundler"` makes a `#` specifier first-class; this
 * guard green at 30/30 as it then stood, because `pointsIntoThisTree` had never
 * heard of `#` and
 * `ALIASES` is read out of one file.
 *
 * That is §5's own sentence — "a prefix list is a config fact; writing one here
 * is prose about a config" — applied to the wrong noun. The fix for defect 5
 * learned to read the alias facts out of *a* config. A tree can declare a
 * specifier-moving prefix in more than one place, and this one has three
 * candidates: `resolve.alias` in `vite.config.ts`, `paths` in
 * `tsconfig.app.json`, and `imports` here.
 *
 * Two of the three move the bundler and one does not, and that is measured
 * rather than assumed: adding `"~t05/*": ["./src/runtime/*"]` to
 * `tsconfig.app.json`'s `paths` and importing `'~t05/run-doubles'` from a module
 * on the graph fails the build — `[vite]: Rollup failed to resolve import
 * "~t05/run-doubles"`, exit 1 at 28 modules. Vite does not read `tsconfig`
 * `paths`, so a mapping only `tsc` knows about cannot put a file in `dist/`; it
 * stops the build instead, which is louder than this file.
 */
const PACKAGE_JSON: unknown = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));

/**
 * Every Node subpath-import prefix a package manifest declares, to a path or `null`.
 *
 * The same two-answer shape as `aliasesIn`, for the same reason: a declared
 * prefix this file cannot translate still makes `pointsIntoThisTree` true, so
 * every specifier using it resolves to nothing and reddens by name. Not knowing
 * the prefix at all is the unsafe answer.
 *
 * A key is `#name` or `#name/*`; a value is a path string, or a conditions object
 * whose branches are paths. Only the string form is translated — a conditions
 * object comes back `null`, which is loud rather than a guess about which branch
 * the bundler took.
 */
function subpathImportsIn(manifest: unknown): Map<string, string | null> {
  const found = new Map<string, string | null>();
  const imports =
    typeof manifest === 'object' && manifest !== null
      ? (manifest as { readonly imports?: unknown }).imports
      : undefined;
  if (typeof imports !== 'object' || imports === null) return found;
  for (const [key, value] of Object.entries(imports as Record<string, unknown>)) {
    if (!key.startsWith('#')) continue;
    found.set(key, typeof value === 'string' ? value : null);
  }
  return found;
}

const SUBPATH_IMPORTS = subpathImportsIn(PACKAGE_JSON);

/**
 * A `#…` specifier rewritten to a path, or `null` when nothing here maps it.
 *
 * One `*` in the key is a wildcard that carries its match into the value, which
 * is the spelling every real `imports` field uses. An exact key maps exactly.
 */
function subpathBase(
  path: string,
  imports: ReadonlyMap<string, string | null> = SUBPATH_IMPORTS,
): string | null {
  if (!path.startsWith('#')) return null;
  for (const [key, target] of imports) {
    if (target === null) continue;
    const star = key.indexOf('*');
    if (star === -1) {
      if (path === key) return resolve(REPO_ROOT, target);
      continue;
    }
    const head = key.slice(0, star);
    const tail = key.slice(star + 1);
    if (!path.startsWith(head) || !path.endsWith(tail)) continue;
    if (path.length < head.length + tail.length) continue;
    const middle = path.slice(head.length, path.length - tail.length);
    return resolve(REPO_ROOT, target.split('*').join(middle));
  }
  return null;
}

/** One `&&`-separated step of a package script, split into its argv. */
type CommandStep = {
  readonly command: string;
  readonly args: readonly string[];
};

/**
 * A package script split into the commands it runs, in order.
 *
 * `package.json`'s `scripts` values were read by nothing. `packageJsonKeys` pins
 * the manifest's top-level key list and `scripts` is already on it, so changing
 * a script's **value** was invisible by construction — and the value is what
 * decides which config `pnpm build` hands vite. An adversary added
 * "vite.config.prod.ts", changed the build script to
 * "tsc --build --force && vite build --config vite.config.prod.ts", left
 * `vite.config.ts` byte-identical, and put the first `NOT_SHIPPED` entry's
 * source into the shipped entry chunk at 222 modules against 220 with this file
 * green at 48/48 twice. Every AST assertion here was reading a file the shipping
 * build never loaded.
 *
 * The split is on `&&` because that is the only sequencing this repo's scripts
 * use. A step whose first token is not a command — an empty step — is dropped
 * rather than reported as a command named `''`.
 */
function commandSteps(script: string): CommandStep[] {
  return script.split('&&').flatMap((step) => {
    const tokens = step.trim().split(/\s+/).filter((token) => token !== '');
    const command = tokens[0];
    return command === undefined ? [] : [{ command, args: tokens.slice(1) }];
  });
}

/** The flags that point vite at a config file rather than letting it search. */
const CONFIG_SELECTING_FLAGS = new Set(['--config', '-c']);

/** The flags that move the directory vite searches from. */
const ROOT_SELECTING_FLAGS = new Set(['--root', '-r']);

/**
 * Every value an argv passes to one of `flags`, in both spellings.
 *
 * `--config x` and `--config=x` are the same instruction to vite's CLI and a
 * reader that knows one of them is a reader an ordinary command line walks
 * through. `reads the build script as the argv it is` drives every position this
 * function handles against an enumerated list, so deleting one names itself.
 */
function selectedBy(args: readonly string[], flags: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? '';
    const equals = argument.indexOf('=');
    const name = equals === -1 ? argument : argument.slice(0, equals);
    if (!flags.has(name)) continue;
    found.push(equals === -1 ? (args[index + 1] ?? '') : argument.slice(equals + 1));
  }
  return found;
}

/** A named script from the manifest, or `''` when there is none of that name. */
function packageScript(name: string, manifest: unknown = PACKAGE_JSON): string {
  const scripts =
    typeof manifest === 'object' && manifest !== null
      ? (manifest as { readonly scripts?: unknown }).scripts
      : undefined;
  if (typeof scripts !== 'object' || scripts === null) return '';
  const value = (scripts as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : '';
}

/**
 * Every top-level key `package.json` carries.
 *
 * Pinned for the reason the config's top-level keys are pinned: `imports` moved a
 * specifier for the bundler while every instrument in this file was pointed at
 * `vite.config.ts`. This says which fields of the manifest a reviewer has decided
 * cannot move the graph, and it reddens when a new one appears — `exports`,
 * `browser`, `workspaces` and `imports` are all fields that can.
 */
function packageJsonKeys(manifest: unknown): string[] {
  return typeof manifest === 'object' && manifest !== null
    ? Object.keys(manifest as Record<string, unknown>)
    : [];
}

/** Every shipping module, parsed once and kept, since several passes read them. */
const PARSED_MODULES = new Map<string, ts.SourceFile>();

/** The same count for the parser memo, asserted by the same test. */
let MODULES_PARSED = 0;

function parsedModule(file: string): ts.SourceFile {
  const cached = PARSED_MODULES.get(file);
  if (cached !== undefined) return cached;
  MODULES_PARSED += 1;
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
 *
 * Which is what happened next, one node kind over. The version that closed
 * defect 12 built `locals` and `namespaces` inside
 * `if (!ts.isImportDeclaration(node)) return`, and a dynamic import binds through
 * a `VariableDeclaration` — so
 * `const { createAgentRuntime } = await import('@/runtime/app-runtime')` and a
 * call on the next line was neither a builder nor an escape, invisible in both
 * directions, which is the sentence above being false about the very reader it
 * describes. The control is that the identical function written with a static
 * import reddens on the first run, so the blindness was to the syntax and not to
 * the meaning; and the lazy spelling is the ordinary one, being what a
 * contributor writes when told to keep a heavy dependency out of the initial
 * chunk. `awaitedImportSpecifier` reads the three initializer shapes that are the
 * module object, and `reads a lazily imported factory as a construction site`
 * drives all four ways of getting the export back out of it.
 */
function factoryUsesIn(
  parsed: ts.SourceFile,
  isFactory: (specifier: string, exported: string) => boolean,
): FactoryUse {
  const locals = new Set<string>();
  const namespaces = new Map<string, string>();
  let calls = 0;
  const escapes: string[] = [];
  /**
   * One module object, bound under whatever name the code gave it.
   *
   * Shared by the declaration form and the `.then` form because they bind the
   * same thing: `const { f } = await import(m)` and `import(m).then(({ f }) =>
   * …)` differ only in which node kind holds the pattern. Written twice, one of
   * them would go on being read and the other would not, which is exactly what
   * happened.
   */
  const bindModuleObject = (specifier: string, name: ts.BindingName, at: ts.Node): void => {
    if (ts.isIdentifier(name)) {
      namespaces.set(name.text, specifier);
      return;
    }
    if (!ts.isObjectBindingPattern(name)) {
      // An array pattern over a module object is not a shape this reader
      // follows, and absence is what the two assertions below read as proof.
      escapes.push(collapse(at.getText(parsed), 80));
      return;
    }
    for (const element of name.elements) {
      if (!ts.isIdentifier(element.name)) {
        // A nested or renamed-into-a-pattern binding is a shape this reader
        // does not follow, and absence is what the two assertions below read
        // as proof, so it is loud instead.
        escapes.push(collapse(at.getText(parsed), 80));
        continue;
      }
      const exported = element.propertyName;
      if (exported === undefined) {
        if (isFactory(specifier, element.name.text)) locals.add(element.name.text);
        continue;
      }
      if (ts.isIdentifier(exported) || ts.isStringLiteralLike(exported)) {
        if (isFactory(specifier, exported.text)) locals.add(element.name.text);
        continue;
      }
      escapes.push(collapse(at.getText(parsed), 80));
    }
  };
  eachNode(parsed, (node) => {
    // `import('@/runtime/app-runtime').then(({ createAgentRuntime }) => …)` is
    // the plain ES lazy-load idiom and it binds the module object in a
    // **parameter**. Round 6 closed the `await` destructuring and left this one
    // open — the same "closed evasion, one spelling over" this file records for
    // `setAttribute`/`setAttributeNS` — and an adversary put a second
    // construction site in `app-runtime.ts` through it, green twice, while the
    // `await` spelling of the identical three lines reddened on the first run.
    // A callback this reader cannot open is loud rather than silent.
    if (isThenOnDynamicImport(node)) {
      const specifier = awaitedImportSpecifier(node.expression.expression);
      if (specifier === null) return;
      const callback = node.arguments[0];
      if (callback === undefined) return;
      if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) {
        escapes.push(collapse(node.getText(parsed), 80));
        return;
      }
      const parameter = callback.parameters[0];
      if (parameter === undefined) return;
      bindModuleObject(specifier, parameter.name, node);
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      // `const { createAgentRuntime } = await import('@/runtime/app-runtime')`
      // binds the same export the `import` statement above binds, and this
      // function could not see it: `locals` and `namespaces` were built inside
      // `if (!ts.isImportDeclaration(node)) return`, and a dynamic import's
      // binding is a `VariableDeclaration`, never an `ImportDeclaration`. So the
      // call was in neither `calls` nor `escapes` — invisible in both
      // directions at once, which is the failure §7 of the header names, and
      // which this function's own docblock says it was written to end. The
      // lazy spelling is the one a contributor reaches for when told to keep a
      // heavy dependency out of the initial chunk; it is shorter than the static
      // one and it compiles under this repo's strict settings. Measured: the
      // static spelling of the identical function reddens `builds the sandbox
      // door once, at the composition root` on the first run, and the lazy one
      // was green twice at 33/33.
      const specifier = awaitedImportSpecifier(node.initializer);
      if (specifier === null) return;
      bindModuleObject(specifier, node.name, node);
      return;
    }
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

  // Called, or loud. Every reference below reaches exactly one of these two.
  const classify = (reference: ts.Node): void => {
    const parent = reference.parent;
    if (parent !== undefined && ts.isCallExpression(parent) && parent.expression === reference) {
      calls += 1;
      return;
    }
    escapes.push(collapse((parent ?? reference).getText(parsed), 80));
  };
  eachNode(parsed, (node) => {
    if (!ts.isIdentifier(node)) return;
    const parent = node.parent;
    if (parent === undefined) return;
    // The import clause that created the binding is not a use of it.
    if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) {
      return;
    }
    // `something.createAgentRuntime`, `{ createAgentRuntime: x }` and a
    // qualified type name are different identifiers that happen to be spelled
    // the same.
    const names =
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      (ts.isPropertyAssignment(parent) && parent.name === node) ||
      (ts.isQualifiedName(parent) && parent.right === node);
    if (names) return;
    const namespace = namespaces.get(node.text);
    if (namespace !== undefined) {
      // Every reference to a namespace object is one of exactly three things:
      // a member read with a name this file can see, a member read with a name
      // it cannot, or the object itself going somewhere. The version this
      // replaces enumerated one of the three — `ts.isPropertyAccessExpression`
      // — so `appRuntime['createAgentRuntime'](adapter)` was neither counted in
      // `calls` nor pushed into `escapes`, invisible in both directions at once,
      // which is the failure mode §7 of the header names. The plant compiles:
      // appended to `AppShell.tsx` it is `npx tsc -b --force` exit 0 under this
      // repo's `strict`, `noUncheckedIndexedAccess` and
      // `exactOptionalPropertyTypes`, and it reddens this file twice now.
      // Both this branch and the catch-all below it are load-bearing, and
      // separately: `reads a construction site as a binding, not as a spelling`
      // reds on each. That sentence was written about the whole function and it
      // was true of three of its arms and false of six others — the qualified
      // name skip, the property-assignment skip, the import-clause skip, the
      // default-import binding, the inline-`type` skip and the string-literal
      // property arm each deleted with the whole suite green. `reads every
      // binding and every reference shape a factory can arrive in` is the
      // assertion that names all of them, one row per position.
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        if (isFactory(namespace, parent.name.text)) classify(parent);
        return;
      }
      if (ts.isElementAccessExpression(parent) && parent.expression === node) {
        const key = staticSpecifier(parent.argumentExpression);
        if (key === null) {
          // A computed member name could be the factory's. Absence is what the
          // two assertions below read as proof, so it is not assumed.
          escapes.push(collapse(parent.getText(parsed), 80));
          return;
        }
        if (isFactory(namespace, key)) classify(parent);
        return;
      }
      // The namespace object is passed, assigned, spread or re-exported: every
      // export it carries leaves with it, this one included.
      escapes.push(collapse(parent.getText(parsed), 80));
      return;
    }
    if (locals.has(node.text)) classify(node);
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
/**
 * What the one assertion that fires on a shipped double says.
 *
 * A named function rather than a template inside the loop, because the reason is
 * only ever *rendered* when the assertion fails, and nothing in a green run
 * reads a failure message. Commit 3697252 exists to put the exemption's reason
 * in this string — "the half that says whether the import or the exemption is
 * the mistake" — and reverting that commit exactly left the suite at
 * `33 passed (33)`, exit 0. A property established by a commit and described by
 * a comment is not a guarded property; `an exemption that fires says why it was
 * exempt` drives both of these and reads what comes back.
 */
function shippedDoubleMessage(path: string, reason: string): string {
  return (
    `${path} is exempt because nothing ships it. It is now on the graph: ` +
    `either that is the bug, or the exemption should go. It is exempt as — ${reason}`
  );
}

/** The same, for the debt list, whose second column had no reader either. */
function debtLandedMessage(path: string, waitingFor: string): string {
  return (
    `${path} is on the graph now. That is the fix landing, not a failure: ` +
    `delete its AWAITING_A_SURFACE entry. It was waiting for — ${waitingFor}`
  );
}

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
  /** Every file the entry reaches, transitively, spelled the way the disk spells it. */
  readonly reachable: ReadonlySet<string>;
  /**
   * Every entry `index.html` declares, in document order, as a repo path — or as
   * `INLINE_ENTRY` for one that has a body instead of a file.
   *
   * The version this replaces was built from `kind === 'file'` loads only, and
   * `HTML_ENTRY`'s docblock two hundred lines above it says in plain words that
   * "a second module script, with a body instead of a `src`, is also an entry".
   * Both sentences were true of their own halves and the pin over this list could
   * not express the second one: adding `<script type="module">import
   * '/src/app/App.tsx';</script>` beside the real entry is a real second vite
   * entry — `vite build` exit 0 at **220 modules against 219** — and left this
   * list at `['src/main.tsx']` with the guard green at 33/33. An inline entry has
   * no file to name, so it is named as what it is; a pin that cannot spell half
   * of what it pins is a pin protecting the wrong half.
   */
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
 *
 * `requested` is the fourth field and it is not decoration: it is the spelling
 * the specifier asked for, and `resolved` is what the filesystem calls the same
 * file. `walk` compares the two, which is the only place the difference between
 * `src/Runtime/…` and `src/runtime/…` can be seen at all now that the graph is
 * keyed on the disk's answer.
 */
function edgesFrom(file: string, source: string): Edge[] {
  return edgesOf(file, source).map((specifier) => {
    const resolution = resolveInTree(file, specifier);
    return {
      specifier,
      resolved: resolution?.file ?? null,
      requested: resolution?.requested ?? null,
      lost: resolution === null && pointsIntoThisTree(specifier),
    };
  });
}

/**
 * One file's edges and its unfollowable forms, read once per run.
 *
 * `walk` is called with a substitute `index.html` by nine assertions, and every
 * one of them used to re-read and re-parse the whole reachable tree. The
 * committed round-4 guard timed out on a clean tree at vitest's default 5000ms
 * for that reason — a false red, and a guard that reddens on untouched work is a
 * guard somebody deletes. The module graph does not depend on which html is
 * being walked, so it is computed once and kept; the html's own edges are not
 * cached, because those are the part that differs.
 */
type FileAnalysis = {
  /** `file: text` for every form in this file the walk reports rather than follows. */
  readonly unfollowable: readonly string[];
  /** Every edge out of the file, already classified. */
  readonly edges: readonly Edge[];
};

const FILE_ANALYSIS = new Map<string, FileAnalysis>();

/**
 * How many times a file has actually been read and classified this run.
 *
 * The memo above is commit f925355's "structural fix for the clean-tree timeout
 * the round-4 critic measured", and removing the cache lookup — restoring the
 * exact pre-fix behaviour, every walk re-reading and re-parsing every reachable
 * file — left the suite at `33 passed (33)`, exit 0, because a cache that is
 * only faster is a cache nothing observes. A duration is the wrong thing to
 * assert: it is the property the round-4 false red was made of. A **count** is
 * not, and it is the property the commit message actually claims — "computed
 * once per run instead of once per walk". `reads and parses each reachable file
 * once per run, not once per walk` reads these two counters.
 */
let FILE_ANALYSES_COMPUTED = 0;

function fileAnalysis(file: string): FileAnalysis {
  const cached = FILE_ANALYSIS.get(file);
  if (cached !== undefined) return cached;
  FILE_ANALYSES_COMPUTED += 1;
  const source = readFileSync(file, 'utf8');
  const label = asRepoPath(file);
  const reported =
    extname(file).toLowerCase() === '.css'
      ? cssUnfollowable(source, file)
      : unanalysableImports(source, file);
  const analysis: FileAnalysis = {
    unfollowable: reported.map((text) => `${label}: ${text}`),
    edges: edgesFrom(file, source),
  };
  FILE_ANALYSIS.set(file, analysis);
  return analysis;
}

/** Everything `index.html` reaches at runtime, transitively. */
/** What one label's edges contribute to the three lists `walk` keeps. */
type EdgeReport = {
  readonly unresolved: readonly string[];
  readonly miscased: readonly string[];
  readonly reached: readonly string[];
};

/**
 * Every edge of one file, sorted into the three answers `walk` has for an edge.
 *
 * Lifted out of `walk`'s `record` closure so its structural positions can be
 * driven directly. One of them — `requested === null` beside `resolved === null`
 * — was held up by nothing but the type checker: deleting it left the whole
 * suite at 2432 green and only `tsc --build --force` reddened, with TS2322. A
 * position the compiler happens to notice is not a position this file asserts,
 * and the compiler would stop noticing the moment `requested` gained a
 * non-nullable spelling. `classifies every edge shape the walk can hand it`
 * supplies one edge per position.
 */
function classifyEdges(label: string, edges: readonly Edge[]): EdgeReport {
  const unresolved: string[] = [];
  const miscased: string[] = [];
  const reached: string[] = [];
  for (const { specifier, resolved, requested, lost } of edges) {
    if (lost) unresolved.push(`${label}: ${specifier}`);
    if (resolved === null || requested === null) continue;
    if (miscasedRequest({ file: resolved, requested })) {
      miscased.push(`${label}: ${specifier} is on disk as ${asRepoPath(resolved)}`);
    }
    reached.push(resolved);
  }
  return { unresolved, miscased, reached };
}

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
    const report = classifyEdges(label, edges);
    unresolved.push(...report.unresolved);
    miscased.push(...report.miscased);
    for (const file of report.reached) if (!reachable.has(file)) queue.push(file);
  };
  // An attribute value is a document-relative URL, not a module specifier: bare
  // means "next to index.html", not "a package". An inline body's specifiers are
  // module specifiers and keep ESM's rule. One resolver for both is what made
  // `src="src/runtime/run-doubles.ts"` neither an edge nor a loud one.
  const htmlEdge = (specifier: string): Edge => {
    const resolution = resolveHtmlReference(specifier);
    return {
      specifier,
      resolved: resolution?.file ?? null,
      requested: resolution?.requested ?? null,
      lost: resolution === null && !externalReference(specifier),
    };
  };
  const moduleEdge = (specifier: string): Edge => {
    const resolution = resolveInTree(HTML_ENTRY, specifier);
    return {
      specifier,
      resolved: resolution?.file ?? null,
      requested: resolution?.requested ?? null,
      lost: resolution === null && pointsIntoThisTree(specifier),
    };
  };
  const entryEdges = loads.flatMap((load) => (load.kind === 'file' ? [htmlEdge(load.specifier)] : []));
  // Document order, both kinds. An inline body is an entry with no file to name,
  // so it is spelled as itself rather than dropped for not having one.
  const entries = loads.flatMap((load) => {
    if (load.kind === 'inline') return [INLINE_ENTRY];
    if (load.kind !== 'file') return [];
    const resolved = htmlEdge(load.specifier).resolved;
    return resolved === null ? [] : [asRepoPath(resolved)];
  });
  record('index.html', entryEdges);
  const inlineScripts = loads.flatMap((load) => (load.kind === 'inline' ? [load.source] : []));
  // An inline module body is a module. Its imports are edges Rollup follows and
  // its specifiers resolve against the repo root, exactly as the tag's own `src`
  // does — there is no file on disk to enumerate, which is precisely why one of
  // these could put `run-doubles.ts` in the bundle with this file green.
  for (const source of inlineScripts) {
    const label = 'index.html <script type="module">';
    for (const text of inlineUnfollowable(source)) unfollowable.push(`${label}: ${text}`);
    record(label, inlineSpecifiers(source).map(moduleEdge));
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
    const analysis = fileAnalysis(file);
    for (const text of analysis.unfollowable) unfollowable.push(text);
    // A lost edge is not the same thing as `'react'`, and a lost edge shrinks
    // `REACHABLE` — the direction `NOT_SHIPPED` reads as proof. It gets said
    // out loud by `record` instead of being `continue`d past.
    record(asRepoPath(file), analysis.edges);
  }
  return { reachable, entries, unreadHtml, unfollowable, unresolved, miscased };
}

/**
 * What `vite build` itself loaded, asked of `vite build` rather than reconstructed.
 *
 * Six rounds of this file have asked a reconstruction question — *"is every
 * shipping file under `src/` present in the module graph **this file** rebuilds
 * from a parse of `index.html`, a hand-written resolver, a transcription of
 * vite's html table and CSS regexes, and an AST reading of `vite.config.ts`?"* —
 * and every round the answer diverged from the bundler's somewhere new. The
 * divergences were never in the tables, which are copied correctly; they were in
 * the traversal around the tables: *which* nodes the table is applied to
 * (`vite-ignore`), *where* the regexes are run (`walkDecls`), *which* attribute
 * spellings count (`p.value === "module"`), *which* attributes are CSS at all
 * (the inline `style`), and *which file the config object came from* (an import
 * specifier in `vite.config.ts` pointing at a local wrapper).
 *
 * There is no version of a second implementation of vite's front end that stops
 * diverging, so this stops being the only instrument. Vite's programmatic
 * `build()` runs the real pipeline with the real config over the real
 * `index.html`, with `write: false` so nothing lands on disk, and a recording
 * plugin reads back `this.getModuleIds()` and `this.getWatchFiles()`. The union
 * of those two, restricted to this repo, is the bundler's own answer to "what
 * did you read" — module ids alone would miss a stylesheet reached through
 * `@import`, which postcss inlines rather than handing to rollup, so both are
 * taken.
 *
 * This does not replace the walk and it is not meant to. The walk is what
 * produces the `unfollowable`/`unresolved`/`miscased` classifications and what
 * every reader-level assertion in this file drives. What the build adds is the
 * one thing a reconstruction cannot have: a second, independent answer to
 * compare against, so that a disagreement between this file and the bundler is a
 * failing assertion instead of a finding.
 */
type BuildFacts = {
  /** Every file under this repo the build read, as repo paths, sorted. */
  readonly read: readonly string[];
  /** Rollup's input set, as repo paths. */
  readonly inputs: readonly string[];
  /** `publicDir` as the resolved config gives it. */
  readonly publicDir: string;
  /** Every plugin in the resolved config, `name [hooks]`, this file's recorder aside. */
  readonly plugins: readonly string[];
  /** Every string alias prefix the resolved config carries. */
  readonly aliases: readonly string[];
  /** The config file vite **found**, as a repo path, or `''` for none. */
  readonly configFile: string;
  /** `resolved.isProduction`, which is what decides `import.meta.env`. */
  readonly isProduction: boolean;
  /** `import.meta.env.DEV` and `.PROD` as this build resolved them. */
  readonly dev: boolean;
  readonly prod: boolean;
  /** `VITEST` and `NODE_ENV` as the child saw them, so the scrub is checkable. */
  readonly runnerVitest: string | null;
  readonly runnerNodeEnv: string | null;
};

const BUILD_RECORDER = 't05-reachability-recorder';

/** The fence the child prints its result between, so a stray log line is not the result. */
const BUILD_FENCE = '<<t05-reachability>>';

/**
 * The program the child runs, as source, because it does not run here.
 *
 * Vitest gives this file a **jsdom** environment, which it needs: `htmlElements`
 * asks jsdom for the parse5 parse vite parses `index.html` with. Vite's build
 * loads esbuild, and esbuild refuses to start unless
 * `new TextEncoder().encode('') instanceof Uint8Array`, which is false in a
 * jsdom realm whatever this file swaps into `globalThis` — the array and the
 * constructor come from different realms and only one of them can be replaced
 * without replacing the environment the rest of the assertions need. So the
 * build runs in its own node process, which is also the honest arrangement: the
 * point of this instrument is a second opinion, and a second opinion computed
 * inside the first opinion's globals is a weaker one.
 *
 * `write: false` is why this cannot create, empty or race a `dist/` — the guard
 * stays as read-only as every other assertion in this file.
 */
const BUILD_PROGRAM = `
const { build } = await import('vite');
const NOT_A_HOOK = new Set([
  'name',
  'enforce',
  'api',
  'apply',
  'sharedDuringBuild',
  'perEnvironmentStartEndDuringDev',
]);
const read = new Set();
let inputs = [];
let publicDir = '';
let plugins = [];
let aliases = [];
let configFile = '';
let isProduction = false;
let dev = true;
let prod = false;
await build({
  root: process.cwd(),
  logLevel: 'silent',
  build: { write: false, sourcemap: false, minify: false },
  plugins: [
    {
      name: '${BUILD_RECORDER}',
      enforce: 'post',
      configResolved(resolved) {
        configFile = resolved.configFile ?? '';
        isProduction = resolved.isProduction === true;
        dev = resolved.env.DEV === true;
        prod = resolved.env.PROD === true;
        publicDir = resolved.publicDir;
        plugins = resolved.plugins
          .filter((plugin) => plugin.name !== '${BUILD_RECORDER}')
          .map((plugin) => {
            const hooks = Object.keys(plugin)
              .filter((key) => !NOT_A_HOOK.has(key))
              .sort()
              .join(' ');
            return plugin.name + ' [' + hooks + ']';
          });
        aliases = resolved.resolve.alias.flatMap((entry) =>
          typeof entry.find === 'string' ? [entry.find] : [],
        );
      },
      buildStart(options) {
        const input = options.input;
        inputs =
          typeof input === 'string' ? [input] : Array.isArray(input) ? input : Object.values(input);
      },
      generateBundle() {
        for (const id of this.getModuleIds()) read.add(id);
        for (const file of this.getWatchFiles()) read.add(file);
      },
    },
  ],
});
process.stdout.write(
  '${BUILD_FENCE}' +
    JSON.stringify({
      read: [...read],
      inputs,
      publicDir,
      plugins,
      aliases,
      configFile,
      isProduction,
      dev,
      prod,
      runnerVitest: process.env.VITEST ?? null,
      runnerNodeEnv: process.env.NODE_ENV ?? null,
    }) +
    '${BUILD_FENCE}',
);
`;

let BUILD_FACTS: BuildFacts | null = null;

/**
 * How many child builds this run has paid for.
 *
 * The memo's own property, as a count rather than as a sentence. What stood
 * here was `The build is memoised, so exactly one of them pays for it` and
 * nothing else: replacing the memo with `return recordBuild()` was exit 0 twice
 * at 48 passed, with the file's duration going 9.41s to 20.28s and four builds
 * running instead of one — RULE V's stated form, found by a critic in the round
 * that wrote RULE V, while the parse memo twenty lines away got two counters and
 * a named test. `runs one build for the whole file, however many assertions read
 * it` reads this.
 */
let BUILDS_RECORDED = 0;

/** The build, run at most once per run however many assertions ask for it. */
function buildFacts(): BuildFacts {
  BUILD_FACTS ??= recordBuild();
  return BUILD_FACTS;
}

type RecordedBuild = {
  readonly read: readonly string[];
  readonly inputs: readonly string[];
  readonly publicDir: string;
  readonly plugins: readonly string[];
  readonly aliases: readonly string[];
  readonly configFile: string;
  readonly isProduction: boolean;
  readonly dev: boolean;
  readonly prod: boolean;
  readonly runnerVitest: string | null;
  readonly runnerNodeEnv: string | null;
};

/**
 * The variables vitest sets that a config is entitled to branch on.
 *
 * `execFileSync` with no `env` hands the child the runner's environment, and the
 * child is a `vite build`. Measured by instrumenting this file's own child
 * process: it saw `VITEST="true"` and `NODE_ENV="test"`. Two consequences, both
 * executed rather than reasoned about:
 *
 * - A plugin gated `if (process.env.NODE_ENV !== 'production') return realReact();`
 *   — or on `process.env.VITEST`, which is the documented way to keep a
 *   build-only plugin out of a shared vite/vitest config — is **absent from this
 *   recording and present in the shipping build**. Two adversaries landed the
 *   double's bytes in the shipped entry chunk that way, at 221 modules against
 *   219, with this file green at 48/48 twice. The ungated version of the same
 *   plugin reds three named assertions, so the entire difference was five words.
 * - `resolved.isProduction` is `(process.env.NODE_ENV || mode) === 'production'`,
 *   so under the runner's environment it is **false** and `import.meta.env.DEV`
 *   resolves **true**. Ordinary `if (import.meta.env.DEV)` mock wiring was
 *   therefore in the recorded build and absent from the shipping one: a false
 *   red on an idiom nobody would think twice about, and the mirror image —
 *   `import.meta.env.PROD` code that ships and is missing here — is the silent
 *   direction of the same defect.
 *
 * Measured both ways on this tree: with the runner's environment,
 * `resolved.isProduction` is `false` and `env.DEV` is `true`; with it scrubbed,
 * `true` and `false`. `the recorded build is the build this repo ships` asserts
 * every one of those values, so the scrub is a property rather than a habit.
 */
const RUNNER_ONLY_ENV = ['VITEST', 'VITEST_WORKER_ID', 'VITEST_POOL_ID', 'VITEST_MODE'];

/**
 * The environment a `vite build` from a clean shell would have.
 *
 * `NODE_ENV` is removed rather than set: `vite build` sets it to `production`
 * itself when it is unset, which is what a maintainer's shell gives it, and
 * hard-coding a value here would be this file deciding the answer instead of
 * reading it.
 */
function buildEnvironment(from: Record<string, string | undefined>): Record<string, string | undefined> {
  const scrubbed: Record<string, string | undefined> = { ...from };
  for (const name of [...RUNNER_ONLY_ENV, 'NODE_ENV']) delete scrubbed[name];
  return scrubbed;
}

/**
 * Rollup's own mark for an id that is not a file: a leading NUL.
 *
 * Documented convention — a plugin that invents a module prefixes its id with
 * `\0` so no other plugin and no filesystem tries to read it. `commonjsHelpers`,
 * `vite/preload-helper` and the `?commonjs-module` proxies over each CJS
 * dependency all arrive that way.
 */
const VIRTUAL_MODULE_ID = '\u0000';

/**
 * The ids the recorder reported that name a file inside this repository.
 *
 * Split out of `recordBuild` so the positions it decides can be driven directly.
 * Three of them were individually deletable with the whole suite green, because
 * a real build reports no id of those shapes — `reads a recorded id as a place
 * in this repository, or as somewhere else` supplies one of each.
 *
 * The virtual-id branch is the fourth and it is a fix rather than a pin. `\0…`
 * ids are not paths, and `relative(REPO_ROOT, '\0vite/preload-helper.js')`
 * happily answers "vite/preload-helper.js" — a repo path naming nothing — so
 * sixteen invented modules were being reported as files in this repository, and
 * the enumeration of what the build reads outside `src/` could not be written at
 * all until they stopped being.
 */
function insideThisRepo(ids: readonly string[]): string[] {
  return ids.flatMap((id) => {
    if (id.startsWith(VIRTUAL_MODULE_ID)) return [];
    const path = relative(REPO_ROOT, id).split('\\').join('/');
    return path === '' || path.startsWith('..') || isAbsolute(path) ? [] : [path];
  });
}

function recordBuild(): BuildFacts {
  BUILDS_RECORDED += 1;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', BUILD_PROGRAM], {
    cwd: REPO_ROOT,
    env: buildEnvironment(process.env),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // Fenced rather than parsed whole, because a plugin or a dependency is free to
  // write to stdout and a build that prints a warning is not a build that failed.
  const fenced = output.split(BUILD_FENCE)[1];
  if (fenced === undefined) {
    throw new Error(`the recorded build printed no result. Its output was: ${collapse(output, 400)}`);
  }
  const recorded = JSON.parse(fenced) as RecordedBuild;
  return {
    read: [...new Set(insideThisRepo(recorded.read))].sort(),
    inputs: recorded.inputs.map(asRepoPath),
    publicDir: recorded.publicDir,
    plugins: recorded.plugins,
    aliases: recorded.aliases,
    configFile: recorded.configFile === '' ? '' : asRepoPath(recorded.configFile),
    isProduction: recorded.isProduction,
    dev: recorded.dev,
    prod: recorded.prod,
    runnerVitest: recorded.runnerVitest,
    runnerNodeEnv: recorded.runnerNodeEnv,
  };
}

/**
 * The paths of a set that are under `src/` and of a kind the bundler loads.
 *
 * One function rather than the same two filters written twice, because the two
 * filters were individually deletable with the whole suite green: each side of
 * the comparison ran the same predicate, so a kind the predicate rejected was
 * invisible in **both** directions and only deleting both filters at once
 * reddened anything. `reads a build's set as the src/ modules in it, and names
 * every kind it drops` drives one entry per structural position against an
 * enumerated list.
 *
 * The query suffix is cut before the kind test, and that is a fix rather than a
 * tidy. A rollup module id carries it — `src/styles/embedded.css?raw` is the id
 * for `import embedded from './styles/embedded.css?raw'` — and
 * `extname('embedded.css?raw')` is `.css?raw`, which is in no map, so the id was
 * dropped as an unshipped kind. It survived only because `getWatchFiles()`
 * independently reports the clean path; a module the build **loads** without
 * watching — a plugin-`load`ed or virtual one — was dropped twice over.
 */
function sourceKindPaths(paths: readonly string[]): string[] {
  const found = new Set<string>();
  for (const path of paths) {
    const bare = withoutQuery(path);
    if (!bare.startsWith('src/')) continue;
    if (!bundlerLoads(basename(bare))) continue;
    found.add(bare);
  }
  return [...found].sort();
}

/** The files under `src/` the build read — the bundler's own answer to the walk's question. */
function readBySourceKind(facts: BuildFacts): string[] {
  return sourceKindPaths(facts.read);
}

/** The files under `src/` this walk reaches, on the same terms. */
function reachedBySourceKind(): string[] {
  return sourceKindPaths([...REACHABLE].map(asRepoPath));
}

/**
 * Every file in this repository the build read that is **not** under `src/` and
 * not a dependency.
 *
 * The universe of both instruments was `src/`, and nothing asserted the
 * universe. `readBySourceKind` filters the bundler's set to `src/`,
 * `reachedBySourceKind` filters the walk's set to `src/`, and
 * `shippingModules(SRC_ROOT)` is the must-be-reachable list — so a file one
 * directory over is invisible to the build side, invisible to the walk side and
 * outside the list, and the two-directional comparison agrees because neither
 * side can see it. Two adversaries reached the identical construction
 * independently: `tests/support/…` exporting a scripted turn driver, imported by
 * `src/runtime/app-runtime.ts`, with the include added to `tsconfig.app.json`
 * that `tsc`'s own TS6307 message asks for. `vite build` exit 0 at 220 modules
 * against 219, the double's class body in the shipped entry chunk, this file
 * green at 48/48 and the whole suite at 118/118. A second one needed no
 * TypeScript at all: `@import '../../../tests/support/dev-overlay.css'` in a
 * component stylesheet put a rule from outside `src/` into the shipped CSS with
 * the module count unchanged.
 *
 * So the universe is pinned the way `PUBLIC_FILES` pins the other unwalked path
 * into `dist/`: everything the build reads that is neither a dependency nor
 * under `src/` is named here, and a new one reddens once.
 */
const BUILD_READS_OUTSIDE_SRC: readonly string[] = ['index.html', 'package.json'];

function repoReadsOutsideSrc(facts: BuildFacts): string[] {
  return facts.read
    .filter((path) => !path.startsWith('src/') && !path.startsWith('node_modules/'))
    .sort();
}

/** Everything inside `publicDir`, recursively, as paths relative to it. */
function publicFiles(directory: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of entriesIn(directory)) {
    if (entry.isFile) found.push(`${prefix}${entry.name}`);
    else found.push(...publicFiles(join(directory, entry.name), `${prefix}${entry.name}/`));
  }
  return found;
}

/**
 * The message a failing expectation carries, or `null` when it passed.
 *
 * A failure message is only ever produced by a failure, so nothing in a green
 * run reads one — which is how three separate properties of this file came to be
 * carried by strings no assertion had ever seen. This is what lets a test read
 * one on purpose.
 */
function whyItFailed(assertion: () => void): string | null {
  try {
    assertion();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * The entry pin, as one function, so that collapsing it is an edit to the thing
 * its guard drives.
 *
 * Two assertions rather than one, and that is the property: a document that
 * grows an ordinary second reference must redden saying **the entry set moved**,
 * and only a document with no resolvable entry at all gets the vacuity message.
 * Written inline, the split was a comment; written here, `the entry pin says the
 * entry set moved, not that the graph is vacuous` reads which message comes back.
 */
function entryPinFailure(entries: readonly string[]): string | null {
  return whyItFailed(() => {
    expect(entries, ENTRY_SET_VACUOUS).toContain('src/main.tsx');
    expect(entries, ENTRY_SET_MOVED).toEqual(['src/main.tsx']);
  });
}

function asRepoPath(file: string): string {
  return relative(REPO_ROOT, file).split('\\').join('/');
}

const GRAPH = walk();
const REACHABLE = GRAPH.reachable;

/**
 * Every rule in the tree's stylesheets that the file kind carrying it ignores.
 *
 * Enumerated rather than walked, deliberately: an orphan stylesheet is exactly
 * the thing a laundered `composes` is trying to hide, and an orphan is not on
 * the graph to be walked. `shippingModules` sees it either way.
 *
 * It is a map from every stylesheet to what that stylesheet writes down and does
 * not honour, rather than a flat list of the offenders, and that is not a
 * presentation choice. The offenders are empty on a clean tree, so a list of
 * them is empty whether the sweep ran or not — `const INERT_RULES = []` passes
 * every assertion an empty list can carry. The keys say which files were opened,
 * so `honours a CSS rule only where that rule is honoured` can check that the
 * sweep looked at the tree before it reports the tree clean.
 */
const STYLESHEETS = shippingModules(SRC_ROOT).filter(
  (file) => extname(file).toLowerCase() === '.css',
);

const INERT_RULES = new Map<string, readonly string[]>(
  STYLESHEETS.map((file) => [asRepoPath(file), inertRulesOf(file, readFileSync(file, 'utf8'))]),
);

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
    // this assertion passed while `run-doubles.ts` sat in `dist/`. The pin is a
    // pin: it protects this one value, and on its own it protected nothing when
    // the reader below it could be made to see two scripts where the file had
    // four. What carries the weight is in `reads a script body as text`, `reads
    // a bare src in html as a path` and `follows the attributes vite rewrites` —
    // the pin is the cheap second signal, not the argument.
    // Two assertions, because one was making a false statement about half of what
    // it caught. Adding a second resolvable asset reference to this document —
    // `<link rel="icon" href="/src/styles/tokens.css" />`, standing in for the
    // favicon a real repo would name — reddened the single pin that stood here
    // with `expected [ 'src/styles/tokens.css', …(1) ] to deeply equal
    // [ 'src/main.tsx' ]` under the message "index.html declares no module entry
    // this walk can resolve; the graph below is vacuous". The graph was not
    // vacuous and the entry was right there in the array being printed. A guard
    // that reddens on routine work with a message that misdescribes what it
    // found is a guard somebody deletes, which is a slower way of losing than
    // being evaded.
    //
    // The version of this paragraph that stood here cited
    // `<link rel="icon" href="/src/assets/vela.svg">` instead, and a measurer
    // executed it: there is no `src/assets/` in this repo and no `.svg` under
    // `src/` at all, so that edit resolves to nothing and reddens a different
    // named test — `says so when a specifier into this tree resolves to nothing`
    // — in both the old guard and this one. The behaviour described was real; the
    // input given for it was not, which made the paragraph unfalsifiable as
    // written. The href above is a file that exists, and
    // `the entry pin says the entry set moved, not that the graph is vacuous`
    // drives it and reads which of the two messages comes back.
    const failure = entryPinFailure(GRAPH.entries);
    if (failure !== null) throw new Error(failure);

    const specifiersOf = (html: string): string[] =>
      htmlLoads(html).flatMap((load) => (load.kind === 'file' ? [load.specifier] : []));
    expect(specifiersOf('<!-- <script type="module" src="/src/ghost.tsx"></script> -->')).toEqual([]);
    expect(specifiersOf('<script type="module" src="/src/main.tsx"></script>')).toEqual([
      '/src/main.tsx',
    ]);
    // A `<link href>` is an edge because `HTML_ASSET_SOURCES` says vite rewrites
    // it, not because it is spelled `href`. The sentence that stood here — "any
    // tag, not a list of tags this file happened to think of" — was the opposite
    // of what the table eleven lines below it does, and `follows the attributes
    // vite rewrites` proves it wrong in the same run by showing that
    // `<a href="/src/main.tsx">` is not an edge. Two instruments, opposite claims.
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
    // The entry list spells this one, and did not use to. An inline module body
    // is an entry with no file to name; the version built from `kind === 'file'`
    // loads alone returned `[]` here, which said "index.html declares no entry"
    // about a document whose only entry is the one being walked.
    expect(inline.entries).toEqual([INLINE_ENTRY]);
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

    // A duplicate attribute resolves to the **first** occurrence, because HTML
    // says so and because parse5 does it. The reader that built a `Map` and
    // `set` each name as it went kept the last, and one repeated `src=` on the
    // tag this file already reads was enough to invert the guard: it read
    // `/src/main.tsx`, so `GRAPH.entries` stayed pinned to exactly the value the
    // pin exists to protect, while `vite build` read `/src/runtime/run-doubles.ts`
    // and compiled **5 modules against a 219-module control** — the whole
    // renderer absent from the bundle, this file green twice at 30/30.
    expect(
      specifiersOfLoad(
        '<script type="module" src="/src/runtime/run-doubles.ts" src="/src/main.tsx"></script>',
      ),
      'a repeated attribute is the first one, which is the one the bundler loads',
    ).toEqual(['/src/runtime/run-doubles.ts']);
    expect(
      walk(
        '<script type="module" src="/src/runtime/run-doubles.ts" src="/src/main.tsx"></script>',
      ).entries,
    ).toEqual(['src/runtime/run-doubles.ts']);
  });

  /**
   * What is markup is decided by the parser the bundler parses with, not by a
   * rule this file wrote down.
   *
   * Three readers have stood here. A pair of regex passes, `<!-- … -->` stripped
   * first and `<script>` bodies pulled out of the result — so a `<!--` in one
   * module script's body and a `-->` in a later one deleted the tag between them
   * while Vite compiled and bundled it (guard green twice, `tsc -b --force` exit
   * 0, `vite build` exit 0 at 223 modules against a 219-module control, and `no
   * turn has been sent` — a sentence in exactly one file under `src/`, which is
   * why this comment writes it across a line break and why `the marker that
   * proves a double reached dist/ names exactly one file` asserts it — inside
   * `dist/assets/index-*.js` and absent from the control). Then a hand-written
   * one-pass tokenizer, whose three termination rules were each narrower than the
   * spec: `-->` without `--!>`, `</script>` without `</script/>` or `</script x>`,
   * and a `tagEnd` that read an apostrophe in an unquoted attribute value as a
   * quote. All three were executed against it and all three shipped
   * `run-doubles.ts` or hid a tag, at 221 modules against 219, with the guard
   * green twice at 30/30 each time.
   *
   * Now the document is parsed by `jsdom`'s DOM, which is parse5 — a different
   * installed copy from the one `vite build` bundles, and the same WHATWG
   * tokenizer. The cases below are the four spellings that got past the
   * hand-written rules plus the two the earlier
   * readers lost, and each of them is now a statement about agreement with the
   * bundler rather than about a direction this reader is wrong in.
   */
  it('reads a script body as text, not as a place comments can start', () => {
    const specifiersOfLoad = (html: string): string[] =>
      htmlLoads(html).flatMap((load) => (load.kind === 'file' ? [load.specifier] : []));
    const unreadOf = (html: string): number =>
      htmlLoads(html).filter((load) => load.kind === 'unread').length;

    // The evasion, in the spelling it was executed in.
    const hidden =
      '<script type="module">const a = "<!--";</script>' +
      '<script type="module" src="/src/main.tsx"></script>' +
      '<script type="module">const b = "-->";</script>';
    expect(
      specifiersOfLoad(hidden),
      'a `<!--` in one script body must not erase the tag after it',
    ).toEqual(['/src/main.tsx']);
    expect(walk(hidden).entries).toEqual([INLINE_ENTRY, 'src/main.tsx', INLINE_ENTRY]);

    // And the same shape hiding an import rather than a tag.
    const hiddenInline =
      '<script type="module">const a = "<!--";</script>' +
      '<script type="module">import "/src/runtime/run-doubles.ts";</script>' +
      '<script type="module">const b = "-->";</script>';
    expect([...walk(hiddenInline).reachable].map(asRepoPath)).toContain(
      'src/runtime/run-doubles.ts',
    );

    // A comment in *data* is still prose: that is the direction the strip
    // existed for, and it is kept.
    expect(specifiersOfLoad('<!-- <script type="module" src="/src/ghost.tsx"></script> -->')).toEqual(
      [],
    );
    expect(unreadOf('<!-- <script>alert(1)</script> -->')).toBe(0);

    // A `>` inside a quoted attribute value does not end the tag. Reading it as
    // the end would hide the `src` after it while Vite still loaded it, which is
    // the same hiding trick one attribute over.
    expect(
      specifiersOfLoad('<script type="module" title="a>b" src="/src/main.tsx"></script>'),
    ).toEqual(['/src/main.tsx']);

    // …and an apostrophe inside an **unquoted** value is data, not a quote. The
    // hand-written `tagEnd` jumped to the next `'` anywhere in the document, so
    // one `div` swallowed the module script between `title=Vela's` and
    // `data-note=don't` and the swept-up attributes resolved to nothing, leaving
    // the loud list empty: guard green twice at 30/30, `tsc -b --force` exit 0,
    // `vite build` exit 0 at 221 modules against 219, `run-doubles.ts`'s bytes in
    // the shipped entry chunk. It is a tag ending *later* than the parser, which
    // produces fewer tokens — the direction two comments in this file used to say
    // could not happen.
    const apostrophes =
      `<div id="root" title=Vela's></div>` +
      '<script type="module">import "/src/runtime/run-doubles.ts";</script>' +
      `<span data-note=don't></span>` +
      '<script type="module" src="/src/main.tsx"></script>';
    expect(specifiersOfLoad(apostrophes)).toEqual(['/src/main.tsx']);
    expect([...walk(apostrophes).reachable].map(asRepoPath)).toContain(
      'src/runtime/run-doubles.ts',
    );

    // A comment ends at `--!>` as well as at `-->`. The tokenizer that knew only
    // the second let `<!-- build note --!>` erase the rest of the document from
    // this reader while Vite compiled and shipped what followed it — 221 modules
    // against 219, the double's bytes in `dist/assets/index-*.js`.
    expect(
      [
        ...walk('<!-- build note --!><script type="module">import "/src/runtime/run-doubles.ts";</script>')
          .reachable,
      ].map(asRepoPath),
    ).toContain('src/runtime/run-doubles.ts');

    // A raw-text element ends at `</script` followed by whitespace, `/` or `>`,
    // not only at `</script>`. The tokenizer that required the `>` let one script
    // swallow a real module script tag.
    expect(
      specifiersOfLoad(
        '<script type="module">const note = "x"; // </script/>' +
          '<script type="module" src="/src/runtime/run-doubles.ts"></script>',
      ),
    ).toEqual(['/src/runtime/run-doubles.ts']);

    // And where the parser keeps a raw-text element open, so does this. A
    // `<!--<script>` in a body puts the tokenizer into script-data-double-escaped
    // and the next `</script>` does **not** end the element — for the browser,
    // for parse5, for `vite build`, and therefore here. The tag after it is
    // invisible to this reader because it is invisible to the bundler: not a
    // direction this file is wrong in, an agreement. What it costs is stated —
    // the entry it hides is hidden from the build too, so the pin goes red on an
    // entry list holding only the swallowing script rather than green on a
    // bundle nobody read.
    const escaped =
      '<script type="module">const s = "<!--<script>";</script>' +
      '<script type="module" src="/src/main.tsx"></script>';
    expect(specifiersOfLoad(escaped), 'agrees with the parser the bundler uses').toEqual([]);
    expect(walk(escaped).entries).toEqual([INLINE_ENTRY]);

    // A tag the parser drops is a tag the bundler drops. An unterminated one at
    // end of input is dropped outright — no element, so nothing to classify and
    // nothing in the loud list, which is a real narrowing of `unreadHtml` against
    // the hand-written reader. What it cannot do is hide a live entry: the tag is
    // gone from the build as well, and an empty entry list reddens the pin.
    expect(htmlLoads('<script type="module" src="/src/main.tsx"'), 'the parser drops it').toEqual(
      [],
    );
    expect(walk('<script type="module" src="/src/main.tsx"').entries).toEqual([]);
    // An element left open before end of input is closed there, and it is still
    // the tag it was: this one is the entry, not a broken thing.
    expect(specifiersOfLoad('<script type="module" title="a>b" src="/src/main.tsx">')).toEqual([
      '/src/main.tsx',
    ]);

    // A `<style>` body is raw text too, and its `@import` is a real edge this
    // reader does not follow — so it is loud rather than skipped. An empty one,
    // closed or left open, loads nothing and says nothing.
    expect(unreadOf('<style>@import "/src/styles/tokens.css";</style>')).toBe(1);
    expect(unreadOf('<style></style>')).toBe(0);
    expect(unreadOf('<style>')).toBe(0);
    // This assertion is the one the round-4 critic measured going red on an
    // untouched tree — vitest's default 5000ms, twice in ten consecutive runs —
    // because it walks the module graph six times and each walk re-read and
    // re-parsed every reachable file. `fileAnalysis` is the fix and it is
    // structural rather than a larger number. Measured on this box after the
    // build assertions landed: consecutive runs of the whole file on a clean
    // tree, exit 0 every time, 11.16s to 53.89s for all sixty-five assertions
    // together on this box alone - the spread is the machine and not the file,
    // the slowest run being one where something else was compiling - and a
    // measurer on another box reports 19847ms. An observed range on machines
    // doing other things, open at both ends, not a bound. The explicit budget is belt as well as braces, because a false
    // red on somebody else's clean tree costs this guard its life; and an idle
    // box is exactly the measurement that cannot see such a red, which is why
    // BOUNDARY_BUDGET is now on every assertion that walks the graph rather than
    // on the one that was caught.
  }, BOUNDARY_BUDGET);

  /**
   * A `<template>`'s children are parsed, and they are not in the document tree.
   *
   * The round that stopped hand-rolling a tokenizer and asked the parser instead
   * asked it the wrong question: `querySelectorAll('*')` walks the **document**,
   * and parse5 puts a template's children in a `DocumentFragment` hanging off the
   * element. Vite's traversal descends into it, so
   * `<template><script type="module">import … '/src/runtime/run-doubles.ts'…
   * </script></template>` in `index.html` was a tag the bundler compiled — 221
   * modules against a 219-module control, the double's bytes in the shipped entry
   * chunk — and a tag this file had no node for, with the guard as it then
   * stood green at 30/30.
   *
   * The reader descends by the `content` property rather than by the tag name, so
   * this assertion is about the shape and not about `template`.
   */
  it('reads a subtree the document tree does not contain', () => {
    // `html`, `head` and `body` are made by the parser whatever the input is, so
    // they are dropped here to leave the shape the snippet actually declares.
    const tags = (html: string): string[] =>
      htmlElements(html)
        .map((element) => element.tagName.toLowerCase())
        .filter((tag) => tag !== 'html' && tag !== 'head' && tag !== 'body');
    expect(tags('<template><b></b></template>')).toEqual(['template', 'b']);
    expect(tags('<div><template><i></i></template></div>')).toEqual(['div', 'template', 'i']);
    expect(tags('<template><template><u></u></template></template>')).toEqual([
      'template',
      'template',
      'u',
    ]);

    // The evasion itself: the inline body inside the template is a module the
    // bundler compiles, so it is a module this walk follows.
    expect(
      [
        ...walk(
          '<template><script type="module">import "/src/runtime/run-doubles.ts";</script></template>',
        ).reachable,
      ].map(asRepoPath),
      'a module script inside a template is compiled by vite and must be on this graph',
    ).toContain('src/runtime/run-doubles.ts');
    // …and a `src` inside one is an entry, not a decoration.
    expect(
      walk('<template><script type="module" src="/src/main.tsx"></script></template>').entries.map(
        asRepoPath,
      ),
    ).toEqual(['src/main.tsx']);
    // The loud branch reaches in there too: a classic script inside a template is
    // still a body this file does not parse.
    expect(walk('<template><script>parse("<b>")</script></template>').unreadHtml.length).toBe(1);
  });

  /**
   * The CSS forms vite rewrites are vite's list, and they are read back from it.
   *
   * `url()` was added because an agent shipped a double through the missing
   * `url()`; `image-set()` was then open for exactly the same reason, and shipped
   * the same file at the control's own module count. Reading the two patterns —
   * and the walker's own choice of which patterns to test — out of the installed
   * package is what stops the third one being another round of this.
   */
  it("matches vite's own CSS url rewriter", () => {
    const rewriter = viteCssRewriter();
    expect(
      rewriter,
      "vite's UrlRewritePostcssPlugin could not be read out of node_modules/vite. " +
        'The three patterns below are then this file\'s opinion about CSS rather ' +
        'than a transcription of the bundler, which is the state defect 20 was in',
    ).not.toBeNull();
    expect(
      rewriter?.tested,
      'vite tests a CSS declaration value against a pattern this file has not been ' +
        'told about: a form it rewrites and urlTargets does not read is an edge ' +
        'that lands in dist/ with this file green',
    ).toEqual(['cssUrlRE', 'cssImageSetRE']);
    expect(rewriter?.url).toBe(VITE_CSS_URL_RE.source);
    expect(rewriter?.imageSet).toBe(VITE_CSS_IMAGE_SET_RE.source);
    expect(rewriter?.notProcessed).toBe(VITE_CSS_NOT_PROCESSED_RE.source);
  });

  /**
   * An attribute is an edge because Vite rewrites it, not because it is spelled
   * `src` or `href`.
   *
   * The reader this replaces took `src=`/`href=` off **every** tag and called
   * each one a `file`, on the stated grounds that Vite rewrites in-tree asset
   * references from any element. It does not: it has a table, `<a href>` is not
   * in it, and an edge invented where the bundler has none launders an orphan
   * onto the graph exactly the way a `composes` in a plain stylesheet does. That
   * attack was tried and failed — but against the `GRAPH.entries` pin, which
   * protects one value somebody wrote down, not against a rule.
   *
   * Narrowing alone would trade an invented edge for a dropped one, so the other
   * direction is closed in the same breath: an attribute **not** in the table
   * whose value resolves to a real file here is `unread` and reddens. Being
   * wrong about Vite is loud either way.
   */
  it('follows the attributes vite rewrites, and is loud about the ones it does not', () => {
    const specifiersOfLoad = (html: string): string[] =>
      htmlLoads(html).flatMap((load) => (load.kind === 'file' ? [load.specifier] : []));
    const unreadOf = (html: string): number =>
      htmlLoads(html).filter((load) => load.kind === 'unread').length;

    expect(specifiersOfLoad('<link rel="stylesheet" href="/src/styles/base.css">')).toEqual([
      '/src/styles/base.css',
    ]);
    expect(specifiersOfLoad('<img src="/src/assets/logo.svg">')).toEqual(['/src/assets/logo.svg']);
    expect(specifiersOfLoad('<video poster="/src/assets/p.png"></video>')).toEqual([
      '/src/assets/p.png',
    ]);
    expect(specifiersOfLoad('<object data="/src/assets/x.svg"></object>')).toEqual([
      '/src/assets/x.svg',
    ]);

    // `<a href>` is the one that was tried. It names a real file and Vite leaves
    // it alone, so it is neither an edge nor silence.
    expect(specifiersOfLoad('<a href="/src/main.tsx">source</a>')).toEqual([]);
    expect(unreadOf('<a href="/src/main.tsx">source</a>')).toBe(1);
    // …and an `<a href>` that names nothing in this tree is just a link.
    expect(unreadOf('<a href="/docs/readme">docs</a>')).toBe(0);
    expect(unreadOf('<a href="https://example.com/">out</a>')).toBe(0);
    expect(unreadOf('<a href="#anchor">here</a>')).toBe(0);

    // `<meta content>` is in vite's table behind a name/property allow-list this
    // reader does not implement, so a `content` that names a real file is loud
    // rather than followed — and the three metas in the real index.html, whose
    // content is not a path, stay silent.
    expect(specifiersOfLoad('<meta property="og:image" content="/src/main.tsx">')).toEqual([
      '/src/main.tsx',
    ]);
    expect(unreadOf('<meta property="og:image" content="/src/main.tsx">')).toBe(0);
    expect(specifiersOfLoad('<meta name="viewport" content="/src/main.tsx">')).toEqual([]);
    expect(unreadOf('<meta name="viewport" content="/src/main.tsx">')).toBe(1);
    expect(unreadOf('<meta name="viewport" content="width=device-width, initial-scale=1.0">')).toBe(
      0,
    );
    expect(unreadOf('<meta charset="UTF-8">')).toBe(0);

    // A `srcset` is a candidate list, not a URL. Parsing it is not implemented,
    // so one that names a real file is loud rather than half-read.
    expect(unreadOf('<img srcset="/src/main.tsx 1x, /src/nothing.png 2x">')).toBe(1);
    expect(unreadOf('<img srcset="https://cdn.example/a.png 1x">')).toBe(0);

    // An ordinary attribute whose value happens to be a word is not a reference.
    expect(unreadOf('<div id="root"></div>')).toBe(0);
    expect(unreadOf('<html lang="en">')).toBe(0);
  });

  /**
   * `matches vite's own table` is the point of the table: it stops being this
   * file's opinion about HTML and becomes a comparison against the installed
   * bundler.
   */
  it("matches vite's own table of asset-bearing attributes", () => {
    const vite = viteHtmlAssetSources();
    expect(
      vite,
      'vite\'s DEFAULT_HTML_ASSET_SOURCES could not be found in node_modules/vite/dist. ' +
        'HTML_ASSET_SOURCES is then a claim nothing checks: find it, or say here ' +
        'why it cannot be read',
    ).not.toBeNull();
    // Vite's rows have three keys, and the comparison that stood here read two.
    // `filter` is the third, and it is not decoration: it is the whole of what
    // makes `meta` different from `img`, and the reason this file used to skip
    // `meta` by name instead. A row that grows one, or loses one, moves an edge
    // in or out of the graph; both are silent unless the key is compared.
    const rows = (table: ReadonlyMap<string, ViteAssetRow>): string[] =>
      [...table.entries()]
        .map(
          ([tag, { url, srcset, hasFilter }]) =>
            `${tag}: ${[...url].sort().join(',')} | ${[...srcset].sort().join(',')} | ` +
            `${hasFilter ? 'filter' : 'no filter'}`,
        )
        .sort();
    const mine = new Map(
      [...HTML_ASSET_SOURCES].map(([tag, row]) => [
        tag,
        { url: row.url, srcset: row.srcset, hasFilter: row.filter !== null },
      ]),
    );
    expect(
      rows(vite ?? new Map()),
      'vite rewrites a tag or attribute this file has not been told about, or no ' +
        'longer rewrites one it follows, or gates one behind a predicate this ' +
        'file does not carry. Each of those invents or drops an edge in index.html',
    ).toEqual(rows(mine));
    // The predicate is data as well as a function, and transcribed data that is
    // never compared back is the mistake this docblock spent two rounds on.
    expect(
      viteStringArray('ALLOWED_META_NAME'),
      "vite's ALLOWED_META_NAME could not be read, so the meta filter is a claim " +
        'nothing checks',
    ).toEqual(ALLOWED_META_NAME);
    expect(
      viteStringArray('ALLOWED_META_PROPERTY'),
      "vite's ALLOWED_META_PROPERTY could not be read, so the meta filter is a " +
        'claim nothing checks',
    ).toEqual(ALLOWED_META_PROPERTY);
    // And the filter is exercised in both directions, because a predicate that
    // is never false is a predicate the row does not need.
    expect(metaCarriesAnAsset(new Map([['property', 'og:image']]))).toBe(true);
    expect(metaCarriesAnAsset(new Map([['name', 'twitter:image']]))).toBe(true);
    expect(metaCarriesAnAsset(new Map([['name', 'viewport']]))).toBe(false);
    expect(metaCarriesAnAsset(new Map())).toBe(false);
  }, BOUNDARY_BUDGET);

  /**
   * In an HTML attribute a bare path is relative to the document. In a module
   * specifier it is a package. One rule for both is a tag that is neither an
   * edge nor loud.
   *
   * Measured against the reader that had one rule: `<script type="module"
   * src="src/runtime/run-doubles.ts">` is resolved by Vite — 220 modules
   * transformed against a 219-module control, build exit 0 — and was classified
   * as neither `file` nor `unread`, with the guard green twice.
   */
  it('reads a bare src in html as a path, not as a package', () => {
    const specifiersOfLoad = (html: string): string[] =>
      htmlLoads(html).flatMap((load) => (load.kind === 'file' ? [load.specifier] : []));

    expect(specifiersOfLoad('<script type="module" src="src/main.tsx"></script>')).toEqual([
      'src/main.tsx',
    ]);
    expect(
      [...walk('<script type="module" src="src/runtime/run-doubles.ts"></script>').reachable].map(
        asRepoPath,
      ),
      'a document-relative src is a file the bundler loads',
    ).toContain('src/runtime/run-doubles.ts');
    expect(
      walk('<script type="module" src="src/nothing-here.tsx"></script>').unresolved,
    ).toEqual(['index.html: src/nothing-here.tsx']);
    // A module *specifier* keeps ESM's rule: bare is a package, and a package is
    // not a lost edge.
    expect(pointsIntoThisTree('src/runtime/run-doubles.ts')).toBe(false);
    expect(
      walk('<script type="module">import "src/runtime/run-doubles.ts";</script>').unresolved,
    ).toEqual([]);
    // An external src is not this tree's file and is not lost either.
    expect(specifiersOfLoad('<script type="module" src="https://cdn.example/x.js"></script>')).toEqual(
      [],
    );
    expect(walk('<script type="module" src="https://cdn.example/x.js"></script>').unresolved).toEqual(
      [],
    );
  });

  /**
   * The claims this file makes about `vite.config.ts`, held to the config — at
   * the **path** they live at, not at their name.
   *
   * `resolveInTree` translates the alias prefixes and `pointsIntoThisTree`
   * recognises them. That is not a property of the resolver, it is a property of
   * `resolve.alias`: a second prefix there is a whole class of specifier the walk
   * has to know about, and a prefix it does not know is an edge dropped in
   * silence — the direction that reads as a *smaller* graph and lets a
   * `NOT_SHIPPED` entry stay green. Same for `TEST_FILE`, whose safety argument is
   * that it matches `test.include` exactly, and for the `src/test/setup.ts`
   * exemption, whose stated reason is that `setupFiles` names it.
   *
   * The reader this drives took the first property assignment named `alias`
   * **anywhere in the file**. A fourth agent moved `test:` above `resolve:`,
   * planted a decoy `test.alias` of `{ '@': … }`, added a second real prefix to
   * `resolve.alias` and imported `run-doubles.ts` through it: this assertion
   * passed, `vite build` shipped the double, and the assertion whose entire job
   * is to catch a second alias was reading a different object.
   */
  it('holds its claims about vite.config.ts to vite.config.ts', () => {
    expect(
      VITE_CONFIG_ROOT,
      'vite.config.ts no longer exports an object literal this file can read; ' +
        'every claim below is then vacuous',
    ).not.toBeNull();
    expect(
      objectKeys(configProperty(['resolve', 'alias'])),
      'every alias prefix here is one resolveInTree has to translate or lose',
    ).toEqual(['@']);
    expect(
      [...ALIASES.entries()].map(([prefix, target]) => `${prefix} -> ${asRepoPath(target ?? '')}`),
      'the prefixes the walk actually resolves, read out of the config it claims to follow',
    ).toEqual(['@ -> src']);
    expect(
      stringElements(configProperty(['test', 'include'])),
      'TEST_FILE is only safe while it is the same set of files vitest runs',
    ).toEqual(['src/**/*.test.{ts,tsx}']);
    expect(
      stringElements(configProperty(['test', 'setupFiles'])),
      'the src/test/setup.ts exemption says setupFiles names it',
    ).toEqual(['./src/test/setup.ts']);

    // The decoy, driven through the same reader over a substitute config,
    // because this repo's own config has one `alias` in it and a reader that
    // matched the name anywhere would pass every assertion above just the same.
    const decoy = configRootOf(
      parse(
        'export default defineConfig({\n' +
          "  test: { alias: { '@': 'decoy' }, include: ['src/**/*.test.ts'] },\n" +
          "  resolve: { alias: { '@': 'a', '~': 'b' } },\n" +
          '});\n',
        'vite.config.ts',
      ),
    );
    expect(
      objectKeys(configProperty(['resolve', 'alias'], decoy)),
      'a property named alias somewhere else in the file is not resolve.alias',
    ).toEqual(['@', '~']);
    expect(objectKeys(configProperty(['test', 'alias'], decoy))).toEqual(['@']);
    expect(configProperty(['resolve', 'nothing'], decoy)).toBeNull();
    expect(configProperty(['nothing', 'alias'], decoy)).toBeNull();
    // A repeated key in one literal is the last one, which is the value the
    // module actually has.
    const repeated = configRootOf(
      parse("export default { resolve: { alias: { '@': 'a' }, alias: { '~': 'b' } } };\n", 'c.ts'),
    );
    expect(objectKeys(configProperty(['resolve', 'alias'], repeated))).toEqual(['~']);

    // And a declared prefix this file cannot translate is still a prefix it
    // knows about, so a specifier using it is lost and loud rather than dropped.
    const untranslatable = aliasesIn(
      configRootOf(parse('export default { resolve: { alias: { "~": someValue } } };\n', 'c.ts')),
    );
    expect([...untranslatable.entries()]).toEqual([['~', null]]);

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

    // A further claim, and it is the one the whole walk stands on: that
    // `index.html`, as it sits on disk, is the document the bundler compiles.
    // That is a default, not a law, and the version of this pin that listed the
    // keys of `build` — reasoning from `rollupOptions.input` and `lib`, the two
    // ways its author could think of to move the entry — enumerated two doors and
    // left the rest of the config open. A sixth agent used a third: a plugin with
    // a `transformIndexHtml` hook at `order: 'pre'` rewrites the document
    // *before* the build parses it for entries, so `index.html` on disk stayed
    // byte-identical, every HTML assertion here saw exactly what it saw before,
    // and `vite build` shipped `run-doubles.ts`'s bytes inside the entry chunk at
    // 221 modules against a 219 control. `plugins` was read by nothing; so was
    // `publicDir`; §8's lesson — a name is not a binding — restated as "a key
    // list is not a config".
    //
    // So the surface pinned is the config's own, top level included, rather than
    // a list of the options somebody could name. This is an enumeration and it is
    // worth being exact about what it closes: a key appearing anywhere the walk's
    // premises live reddens here, and a plugin being added or swapped reddens
    // here. What it does not close is an existing door changing behind its own
    // name — `@vitejs/plugin-react` gaining an html transform in a future version
    // is a lockfile change and a reviewer, not something this assertion can see.
    // The structural fix is to stop reading the config for the entry set and
    // read the build's own, and `facts.inputs` is that: `recordBuild` captures
    // rollup's `input` in a `buildStart` hook and `the build reaches the
    // renderer, and every shipping module under src/` asserts it. What this pin
    // remains for is the config surface itself, not the entry set.
    expect(
      objectKeys(VITE_CONFIG_ROOT),
      'a top-level key in vite.config.ts this guard has not been told about. ' +
        'The walk starts from index.html because nothing in this config moves it: ' +
        'say whether this one does',
    ).toEqual(['plugins', 'resolve', 'server', 'build', 'test']);
    expect(
      calleeNames(configProperty(['plugins'])),
      'a plugin this guard has not been told about. A transformIndexHtml hook ' +
        'rewrites the document before the build parses it for entries, so the ' +
        'bytes of index.html this file reads stop being what vite compiles',
    ).toEqual(['react']);
    expect(
      objectKeys(configProperty(['build'])).sort(),
      'a build option this guard has not been told about. If it can name an ' +
        'entry — rollupOptions.input, lib — then index.html is no longer the ' +
        'whole question and this file has to read it too',
    ).toEqual(['emptyOutDir', 'outDir', 'sourcemap', 'target']);

    // Both pins above read `PropertyAssignment`s and skip everything else, which
    // is how the pair of them passed over a config vite never received. A
    // seventh agent put `...packaging` last in this literal, importing a
    // `UserConfig` from a second file whose `plugins` carried a
    // `transformIndexHtml`: the spread has no name, so `objectKeys` still read
    // exactly the five keys below and `calleeNames` still read the literal's own
    // `plugins: [react()]`, while at runtime the spread overwrote it. `vite build`
    // shipped the double at 221 modules against 219. So the file is swept once
    // for any property none of the three readers can see, and the pin is empty.
    expect(
      unreadableProperties(VITE_CONFIG),
      'a property in vite.config.ts that is not a plain named assignment. ' +
        'configProperty, objectKeys and aliasesIn all read this config by ' +
        'walking named assignments, so anything else here is config none of ' +
        'them can see — and a trailing spread overwrites a key written above it',
    ).toEqual([]);

    // Driven over substitute configs, because this one has no spread in it and a
    // sweep that found nothing would pass the pin above with its body deleted.
    const spread = parse(
      'export default defineConfig({ plugins: [react()], ...packaging });\n',
      'vite.config.ts',
    );
    expect(objectKeys(configRootOf(spread))).toEqual(['plugins', '<SpreadAssignment>']);
    expect(unreadableProperties(spread)).toEqual(['<SpreadAssignment> ...packaging']);
    // The pin written to close defect 18 still answers `['react']` over that
    // config, which is the whole point: it is reading a key the spread replaces.
    expect(calleeNames(configProperty(['plugins'], configRootOf(spread)))).toEqual(['react']);
    const shorthand = parse('export default defineConfig({ plugins });\n', 'vite.config.ts');
    expect(objectKeys(configRootOf(shorthand))).toEqual(['<ShorthandPropertyAssignment>']);
    expect(unreadableProperties(shorthand)).toEqual([
      '<ShorthandPropertyAssignment> plugins',
    ]);
    const nested = parse(
      "export default defineConfig({ resolve: { alias: { '@': 'a', ...more } } });\n",
      'vite.config.ts',
    );
    expect(objectKeys(configProperty(['resolve', 'alias'], configRootOf(nested)))).toEqual([
      '@',
      '<SpreadAssignment>',
    ]);
    expect(unreadableProperties(nested)).toEqual(['<SpreadAssignment> ...more']);
    expect(unreadableProperties(parse('export default { a: 1 };\n', 'vite.config.ts'))).toEqual([]);

    // Driven over a substitute config as well, because this repo's own has one
    // plugin in it and a reader that answered `[]` for anything it did not
    // recognise would pass the assertion above with the array deleted.
    const withPlugin = configRootOf(
      parse(
        'export default defineConfig({ plugins: [react(), diagnosticsProbe()] });\n',
        'vite.config.ts',
      ),
    );
    expect(calleeNames(configProperty(['plugins'], withPlugin))).toEqual([
      'react',
      'diagnosticsProbe',
    ]);
    expect(calleeNames(configProperty(['build'], withPlugin))).toBeNull();
    expect(
      calleeNames(
        configProperty(['plugins'], configRootOf(parse('export default { plugins: [] };\n', 'c.ts'))),
      ),
    ).toEqual([]);
  });

  /**
   * An alias prefix the config declares is one the walk follows, or one it loses
   * out loud. It is never one it has not heard of.
   *
   * `pointsIntoThisTree` used to list `.`, `/` and `@/`. The list was right about
   * today's config and that is all a list can ever be: adding
   * `'~': fileURLToPath(new URL('./src', import.meta.url))` to `resolve.alias`
   * made `'~/runtime/run-doubles.ts?raw'` a specifier that pointed at nothing as
   * far as this file was concerned, so it was not an edge, not lost, and not
   * reported — `vite build` at 220 modules against a 219-module control, with
   * `run-doubles-*.js` in `dist/assets/`, and the guard as it then stood green in
   * two consecutive runs at 24 assertions passed.
   */
  it('knows an alias prefix because the config declares it, not because it is listed here', () => {
    expect(pointsIntoThisTree('@/runtime/run-doubles.ts')).toBe(true);
    expect(pointsIntoThisTree('./run-doubles.ts')).toBe(true);
    expect(pointsIntoThisTree('/src/runtime/run-doubles.ts')).toBe(true);
    // A package that merely starts with the alias character is not the alias:
    // vite matches a string alias on the whole id or up to the next `/`.
    expect(pointsIntoThisTree('@tauri-apps/api/core')).toBe(false);
    expect(pointsIntoThisTree('react')).toBe(false);

    // The evasion, driven through the same functions with a substitute config.
    const twoPrefixes = aliasesIn(
      configRootOf(
        parse(
          'export default defineConfig({ resolve: { alias: {\n' +
            "  '@': fileURLToPath(new URL('./src', import.meta.url)),\n" +
            "  '~': fileURLToPath(new URL('./src', import.meta.url)),\n" +
            '} } });\n',
          'vite.config.ts',
        ),
      ),
    );
    expect([...twoPrefixes.keys()]).toEqual(['@', '~']);
    expect(asRepoPath(twoPrefixes.get('~') ?? '')).toBe('src');
    expect(asRepoPath(aliasBase('~/runtime/run-doubles.ts', twoPrefixes) ?? '')).toBe(
      'src/runtime/run-doubles.ts',
    );
    expect(aliasBase('~', twoPrefixes)).toBe(SRC_ROOT);
    expect(aliasBase('~tilde/x', twoPrefixes)).toBeNull();
  });

  /**
   * A prefix that moves a specifier is a fact about a config file, and there is
   * more than one config file.
   *
   * The fix for defect 5 stopped listing alias prefixes and started reading them
   * out of `vite.config.ts`, and wrote down the principle: a prefix list is a
   * config fact, and writing one here is prose about a config. It then read *one*
   * config. `package.json`'s `imports` field is the standards-track spelling of
   * the same thing — it needs no bundler-specific plumbing, `tsc` honours it under
   * `moduleResolution: "bundler"`, and vite resolves it — so two edits with
   * nothing bundler-shaped about them,
   *
   *     "imports": { "#runtime/*": "./src/runtime/*.ts" }
   *     void import('#runtime/run-doubles');
   *
   * put the first `NOT_SHIPPED` entry in `dist/assets/` at 220 modules against a
   * 219-module control with `tsc -b --force` exit 0 and the guard as it then
   * stood green at 30/30.
   * `pointsIntoThisTree` answered `false` for a `#` specifier, so it was not an
   * edge, not lost, and not reported — defect 5's silent `continue`, one config
   * file over. That is defect 21.
   *
   * The third candidate is `paths` in `tsconfig.app.json`, and it is measured
   * rather than assumed: `"~t05/*": ["./src/runtime/*"]` with an import through it
   * fails the build — `[vite]: Rollup failed to resolve import "~t05/run-doubles"`,
   * exit 1 at 28 modules — because vite does not read tsconfig `paths`. A mapping
   * only `tsc` knows about cannot put a file in `dist/`.
   */
  it('reads every file that can move a specifier, not only the bundler config', () => {
    expect(
      [...SUBPATH_IMPORTS.keys()],
      'package.json declares a subpath import namespace this guard has not been ' +
        'told about. Every `#` specifier using it is an edge vite follows',
    ).toEqual([]);
    expect(
      packageJsonKeys(PACKAGE_JSON),
      'a top-level field in package.json this guard has not been told about. ' +
        'imports, exports and browser all move a specifier for the bundler, and ' +
        'none of them is in vite.config.ts: say whether this one does',
    ).toEqual([
      'name',
      'version',
      'private',
      'type',
      'description',
      'license',
      'engines',
      'scripts',
      'dependencies',
      'devDependencies',
      'pnpm',
    ]);

    // A leading `#` is reserved by the module specification for the package's own
    // `imports`, so it can never be a package: with no mapping declared it is a
    // lost edge and loud, which is also what `vite build` does with it.
    expect(pointsIntoThisTree('#runtime/run-doubles')).toBe(true);
    const shell = join(SRC_ROOT, 'app', 'shell', 'AppShell.tsx');
    expect(edgesFrom(shell, "void import('#runtime/run-doubles');\n")).toEqual([
      { specifier: '#runtime/run-doubles', resolved: null, requested: null, lost: true },
    ]);

    // The translation, driven over a substitute manifest, because this repo's own
    // declares none and a reader that answered nothing would pass the pin above
    // with the whole function deleted.
    const declared = subpathImportsIn({
      imports: {
        '#runtime/*': './src/runtime/*.ts',
        '#entry': './src/main.tsx',
        '#conditional': { default: './src/main.tsx' },
        'not-a-subpath': './src/main.tsx',
      },
    });
    expect([...declared.keys()]).toEqual(['#runtime/*', '#entry', '#conditional']);
    expect(asRepoPath(subpathBase('#runtime/run-doubles', declared) ?? '')).toBe(
      'src/runtime/run-doubles.ts',
    );
    expect(asRepoPath(subpathBase('#entry', declared) ?? '')).toBe('src/main.tsx');
    // A conditions object is untranslatable rather than guessed at, and an
    // untranslatable prefix is still a prefix: the specifier is lost, not dropped.
    expect(subpathBase('#conditional', declared)).toBeNull();
    expect(subpathBase('#nothing/here', declared)).toBeNull();
    expect(subpathBase('./relative', declared)).toBeNull();
    expect(subpathImportsIn({}).size).toBe(0);
    expect(subpathImportsIn(null).size).toBe(0);
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
        requested: join(SRC_ROOT, 'app', 'shell', 'AppShell.module.css'),
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
      { specifier: 'react', resolved: null, requested: null, lost: false },
    ]);
    expect(edgesFrom(shell, "import '@tauri-apps/api/core';\n")).toEqual([
      { specifier: '@tauri-apps/api/core', resolved: null, requested: null, lost: false },
    ]);
    expect(edgesFrom(shell, "import './nothing-here.ts?raw';\n")).toEqual([
      { specifier: './nothing-here.ts?raw', resolved: null, requested: null, lost: true },
    ]);
    expect(edgesFrom(shell, "import '@/nothing-here';\n")).toEqual([
      { specifier: '@/nothing-here', resolved: null, requested: null, lost: true },
    ]);
    expect(edgesFrom(shell, "import '/src/nothing-here';\n")).toEqual([
      { specifier: '/src/nothing-here', resolved: null, requested: null, lost: true },
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
    const plain = 'probe.css';
    const cssModule = 'probe.module.css';
    expect(cssSpecifiers("@import './tokens.css';\n", plain)).toEqual(['./tokens.css']);
    expect(cssSpecifiers('@import url("./tokens.css");\n', plain)).toEqual(['./tokens.css']);
    expect(cssSpecifiers('@import url(./tokens.css);\n', plain)).toEqual(['./tokens.css']);
    expect(cssSpecifiers(".a { composes: b from './other.module.css'; }\n", cssModule)).toEqual([
      './other.module.css',
    ]);

    expect(cssSpecifiers("/* @import './ghost.css'; */\n", plain)).toEqual([]);
    expect(cssSpecifiers("/*\n@import './ghost.css';\n*/\n.a { color: red }\n", plain)).toEqual([]);
    // A string is not a comment: the `/*` inside one does not open one, so the
    // rule after it is still a rule and the `@import` before it is still read.
    expect(cssSpecifiers('@import \'./kept.css\';\n.a { content: "/*"; }\n', plain)).toEqual([
      './kept.css',
    ]);

    // A string is not a rule, exactly as a comment is not a node. Measured, not
    // argued: appending the first of these to `src/app/shell/AppShell.module.css`
    // put a planted orphan stylesheet on the graph and every assertion in this
    // file passed, twice over, with dead shipped CSS in `src/features/canvas/`.
    expect(cssSpecifiers('.a { content: "@import \'./ghost.css\'"; }\n', plain)).toEqual([]);
    expect(
      cssSpecifiers('.a { content: "composes: b from \'./ghost.module.css\'"; }\n', cssModule),
    ).toEqual([]);

    // `@import` is a top-level rule: a browser ignores one that sits inside a
    // block, so reading one there would be inventing an edge the product has not
    // got. `composes` is the mirror image — a declaration, never at the root.
    expect(cssSpecifiers(".a { @import './ghost.css'; }\n", plain)).toEqual([]);
    expect(cssSpecifiers("composes: b from './ghost.module.css';\n", cssModule)).toEqual([]);

    // A bare number is not a marker, which is the reason the marker is NUL.
    expect(cssSpecifiers('.a { margin: 0 12 0; }\n', plain)).toEqual([]);

    // …and a NUL in the file cannot forge one, which is the reason `readCss`
    // substitutes U+FFFD for it the way the CSS grammar does. The comment on
    // `CSS_STRING` used to assert "NUL cannot occur in a stylesheet" and nothing
    // implemented it: a U+0000 survives `readFileSync(file, 'utf8')`, and
    // `.a { content: "…"; }` followed by `@import <NUL>0<NUL>;` turned that string
    // into an `@import` edge against the reader of the round before this one —
    // defect 6's laundering rebuilt out of the mechanism written to stop it.
    //
    // The first spelling of this control was **vacuous**, and it is recorded here
    // rather than quietly repaired. That exact input comes back empty whether or
    // not the substitution runs, because the rule before it has already closed the
    // `@import` preamble — so a mutant deleting the substitution left this file
    // green in two consecutive runs. It is the failure the `INERT_RULES` doc names
    // for a different check, an empty result being empty whether the rule ran or
    // not, arriving in a control written the same round. So the marker is forged
    // where nothing else can stop it: after `@charset`, which keeps the preamble
    // open, and inside `url()`, which has no positional gate at all.
    const nul = String.fromCharCode(0);
    const ghost = '../features/canvas/Ghost.module.css';
    const forgedImport = `@charset "${ghost}";\n@import ${nul}0${nul};\n`;
    const forgedUrl = `.a { content: "${ghost}"; }\n.b { background: url(${nul}0${nul}); }\n`;
    expect(
      cssSpecifiers(forgedImport, plain),
      'a NUL in a stylesheet cannot forge a string marker',
    ).toEqual([]);
    expect(cssSpecifiers(forgedImport, cssModule)).toEqual([]);
    // The `url()` forge does not come back empty, and that is the more useful
    // answer: the substitution leaves U+FFFD behind, so what the reader sees is a
    // specifier naming no file at all rather than the path the string held. It
    // points into this tree, resolves to nothing, and lands in `GRAPH.unresolved`
    // by name — the loud residue, not a laundered edge.
    const replacement = String.fromCharCode(0xfffd);
    expect(cssSpecifiers(forgedUrl, plain)).toEqual([`./${replacement}0${replacement}`]);
    expect(cssSpecifiers(forgedUrl, plain)).not.toContain(ghost);
    expect(cssSpecifiers(forgedUrl, cssModule)).not.toContain(ghost);
    expect(resolveSpecifier(join(SRC_ROOT, 'styles', 'probe.css'), `./${replacement}0${replacement}`))
      .toBeNull();
    // A specifier is the **whole of** one literal, never a substring found inside
    // one, which is what `literalOf`'s anchors implement. The claim had no
    // control on the `url()` path, and unanchoring them survived a round-4
    // mutation sweep green twice. It does not survive this: with a bare token in
    // front of the string, the marker is no longer the whole of the argument, so
    // the reader must come back with the unresolvable text it actually saw rather
    // than with the path hiding inside it.
    const marker = `${nul}0${nul}`;
    expect(
      cssSpecifiers(`.a { background: url(x'${ghost}'); }
`, plain),
      'a specifier is the whole of one literal, not a path found inside one',
    ).toEqual([`./x${marker}`]);
    expect(cssSpecifiers(`.a { background: url(x'${ghost}'); }
`, plain)).not.toContain(ghost);

    // And the controls that prove those two positions are live at all, so the
    // emptiness above is the substitution's doing and not the position's.
    expect(cssSpecifiers(`@charset "utf-8";\n@import '${ghost}';\n`, plain)).toEqual([ghost]);
    expect(cssSpecifiers(`.b { background: url('${ghost}'); }\n`, plain)).toEqual([ghost]);

    // `url()` is an edge and it is the one Vite follows most often. The reader
    // that had no form for it dropped `url('../runtime/run-doubles.ts')` in
    // silence and the file shipped whole into `dist/assets/` at a module count
    // identical to the control, because an asset is not a module.
    expect(cssSpecifiers('.a { background-image: url("../runtime/run-doubles.ts"); }\n', plain)).toEqual(
      ['../runtime/run-doubles.ts'],
    );
    expect(cssSpecifiers('.a { background-image: url(../runtime/run-doubles.ts); }\n', plain)).toEqual(
      ['../runtime/run-doubles.ts'],
    );
    // A bare `url()` is relative to the stylesheet, not a package — the same
    // distinction `bareIsRelative` draws for an HTML attribute.
    expect(cssSpecifiers('.a { background: url(logo.png); }\n', plain)).toEqual(['./logo.png']);
    // A scheme, a protocol-relative URL and a fragment reference are not files.
    expect(
      cssSpecifiers(
        '.a { background: url(data:image/png;base64,AA); mask: url(#m); cursor: url(https://x/y.png); }\n',
        plain,
      ),
    ).toEqual([]);
    // And the `url()` of an `@import` is read once, by the rule that governs it —
    // by vite's own `(?<!@import\s+)` lookbehind rather than a second rule here.
    expect(cssSpecifiers('@import url("./tokens.css");\n', plain)).toEqual(['./tokens.css']);

    // `url()` is not the only form vite's replacer rewrites, and the round that
    // added `url()` added the form it had been shown rather than the class the
    // bundler has. `image-set()` goes through the same resolver, and one
    // declaration of it shipped the same file at the control's own module count.
    expect(
      cssSpecifiers(".a { background-image: image-set('../runtime/run-doubles.ts' 1x); }\n", plain),
      'image-set is rewritten by the same postcss plugin url() is',
    ).toEqual(['../runtime/run-doubles.ts']);
    expect(
      cssSpecifiers('.a { background-image: -webkit-image-set(url("./a.png") 1x); }\n', plain),
    ).toEqual(['./a.png']);
    expect(
      cssSpecifiers(".a { background-image: image-set('a.png' 1x, 'b.png' 2x); }\n", plain),
    ).toEqual(['./a.png', './b.png']);
    // vite's own `cssNotProcessedRE` leaves a gradient candidate alone, so this
    // reader leaves it alone too: inventing an edge is the laundering direction.
    expect(
      cssSpecifiers('.a { background-image: image-set(linear-gradient(red, blue) 1x); }\n', plain),
    ).toEqual([]);

    // The loud half, which is what makes the two forms above a decision rather
    // than the next list to be one function short. A CSS function this reader
    // does not follow, naming a file that exists here, is reported by name.
    const probe = join(SRC_ROOT, 'styles', 'probe.css');
    expect(
      cssUnfollowable('.a { src: data-uri("../runtime/run-doubles.ts"); }\n', probe),
      'a CSS function form this reader has no pattern for is loud, not absent',
    ).toEqual([
      'data-uri(../runtime/run-doubles.ts) names a path in this tree, and this reader ' +
        'follows only the CSS function forms vite rewrites: url() and image-set()',
    ]);
    expect(cssUnfollowable(".a { background: url('../runtime/run-doubles.ts'); }\n", probe)).toEqual(
      [],
    );
    expect(
      cssUnfollowable(".a { background: image-set('../runtime/run-doubles.ts' 1x); }\n", probe),
    ).toEqual([]);
    // And the shapes that must stay silent, because a guard that reddens on
    // ordinary CSS is a guard somebody deletes. A selector is full of function
    // syntax and none of it names a file.
    expect(
      cssUnfollowable(
        "@font-face { src: local('Vela'), url('./x.woff2') format('woff2'); }\n",
        probe,
      ),
    ).toEqual([]);
    expect(
      cssUnfollowable(
        '.a:not(.b):nth-child(2n+1) { color: var(--surface); transform: translate(-50%); ' +
          'transition: all 1s cubic-bezier(0.4, 0, 0.2, 1); }\n',
        probe,
      ),
    ).toEqual([]);
    expect(
      cssUnfollowable('@media (min-width: 700px) { .a { color: red } }\n', probe),
    ).toEqual([]);
    // The four faces `typeface.css` names are `url()`s, and they are the reason
    // this form is not a hypothetical: they are on the graph now and were not.
    expect(
      [...REACHABLE].map(asRepoPath).filter((file) => file.endsWith('.woff2')).sort(),
      'the four woff2 files typeface.css names are edges the bundler follows',
    ).toEqual([
      'node_modules/@fontsource-variable/inter/files/inter-latin-wght-italic.woff2',
      'node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
      'node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-italic.woff2',
      'node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2',
    ]);

    // `@import` is honoured only **before every other statement**, which is not
    // the same rule as "outside every block" and was implemented as if it were.
    // `@charset`, another `@import` and an `@layer` statement keep the preamble
    // open; a rule closes it, and `{` is how a block says it is a rule.
    expect(
      cssSpecifiers("@charset \"utf-8\";\n@layer a, b;\n@import './early.css';\n.a { color: red }\n", plain),
    ).toEqual(['./early.css']);
    expect(
      cssSpecifiers(".a { color: red; }\n@import './late.css';\n", plain),
      'an @import after another rule is dead text, and postcss says so in the build log',
    ).toEqual([]);
    expect(cssSpecifiers("@layer a { .x { color: red } }\n@import './after.css';\n", plain)).toEqual(
      [],
    );

    // A declaration missing its own semicolon does not reach into the next rule
    // for a `from` that belongs to somebody else.
    expect(
      cssSpecifiers(".a { composes: b }\n.c { color: red; from: './ghost.css' }\n", cssModule),
    ).toEqual([]);

    const base = join(SRC_ROOT, 'styles', 'base.css');
    expect(
      cssSpecifiers(readFileSync(base, 'utf8'), base).map((specifier) =>
        asRepoPath(resolveSpecifier(base, specifier) ?? '<unresolved>'),
      ),
      'base.css is the only stylesheet main.tsx imports; the rest hang off it',
    ).toEqual(['src/styles/typeface.css', 'src/styles/tokens.css']);
  });

  /**
   * Position in the grammar is not the whole of a rule. **Which file kind
   * honours it** is the other half.
   *
   * `cssSpecifiers` gated `composes` to inside a block and `@import` to the root,
   * correctly, and then applied both to every stylesheet. Vite runs the
   * CSS-modules transform on `*.module.css` and on nothing else, so a `composes`
   * in a plain stylesheet is an unknown declaration: copied through, honoured by
   * nobody. A fourth agent planted an orphan `.module.css` and appended one line
   * to `src/styles/typeface.css` — a plain stylesheet already on the graph — and
   * `reaches every shipping module under src/ from index.html` went green over
   * dead shipped CSS. Measured: `vite build` at 219 modules transformed, byte for
   * byte the same count as the control, `grep -rl` of the orphan's marker in
   * `dist/` matching nothing, and the laundering line itself in
   * `dist/assets/*.css` as inert text. Prose to the bundler, an edge to the
   * reader — defect 6's sentence, one level down, in the consumer of the function
   * written to close defect 6.
   *
   * The first spelling of that attack, through `src/styles/base.css`, was caught
   * — but by the hand-written specifier list in the assertion above, which
   * `typeface.css` and `tokens.css` do not have. A pin protects one value
   * somebody wrote down. This is the rule.
   */
  it('honours a CSS rule only where that rule is honoured', () => {
    expect(isCssModule('src/app/shell/AppShell.module.css')).toBe(true);
    expect(isCssModule('src/styles/typeface.css')).toBe(false);
    expect(isCssModule('src/styles/base.module.css.ts')).toBe(false);

    const laundering = ".t05Launder { composes: ghost from '../features/canvas/Ghost.module.css'; }\n";
    expect(
      cssSpecifiers(laundering, 'src/styles/typeface.css'),
      'a composes in a plain stylesheet is not an edge: nothing transforms it',
    ).toEqual([]);
    expect(cssSpecifiers(laundering, 'src/features/canvas/Real.module.css')).toEqual([
      '../features/canvas/Ghost.module.css',
    ]);

    // And it is not silently nothing either, because a rule that loads nothing
    // and does nothing is only ever written to be read by something that is not
    // the bundler.
    expect(cssInert(laundering, 'src/styles/typeface.css')).toEqual([
      "composes … from '../features/canvas/Ghost.module.css' — only *.module.css " +
        'honours composes, so this loads nothing',
    ]);
    expect(cssInert(laundering, 'src/features/canvas/Real.module.css')).toEqual([]);
    expect(cssInert("@import './tokens.css';\n", 'src/styles/base.css')).toEqual([]);

    // The other half of the same idea: a rule can be dead because of **where** it
    // sits, not only because of what file it sits in. An `@import` appended after
    // five `@font-face` rules in `src/styles/typeface.css` — a plain stylesheet
    // already on the graph, and deliberately not the one covered by the
    // hand-written specifier pin on `base.css` — laundered a planted orphan onto
    // the graph with `vite build` at 219 modules, identical to the control, and
    // vite's own postcss printing `@import must precede all other statements
    // (besides @charset or empty @layer)` into the log it went green over.
    const late = "@font-face { font-family: x; }\n@import '../features/canvas/Ghost.css';\n";
    const lateMessage =
      "@import '../features/canvas/Ghost.css' after another rule — CSS honours " +
      '@import only before every other statement, so this loads nothing';
    expect(cssInert(late, 'src/styles/typeface.css')).toEqual([lateMessage]);
    expect(
      cssInert(late, 'src/app/shell/AppShell.module.css'),
      'position is not gated by file kind: a late @import is dead in both',
    ).toEqual([lateMessage]);
    expect(inertRulesOf('src/styles/typeface.css', late)).toEqual([lateMessage]);
    expect(cssSpecifiers(late, 'src/styles/typeface.css')).toEqual([]);

    // …and through the dispatcher the sweep actually calls, which is where the
    // file kind is decided for a real path rather than for a probe name.
    expect(inertRulesOf('src/styles/typeface.css', laundering)).toEqual([
      "composes … from '../features/canvas/Ghost.module.css' — only *.module.css " +
        'honours composes, so this loads nothing',
    ]);
    expect(inertRulesOf('src/app/shell/AppShell.module.css', laundering)).toEqual([]);
    expect(inertRulesOf('src/app/App.tsx', laundering)).toEqual([]);

    expect(
      [...INERT_RULES.values()].flat(),
      'a stylesheet declares a rule its own file kind ignores. It loads nothing ' +
        'and it does nothing; either the rule belongs in a *.module.css or it ' +
        'belongs deleted',
    ).toEqual([]);
    // An empty result is only worth anything if the sweep opened the tree. The
    // keys are which files it opened, and they are every stylesheet the
    // enumerator finds — 40 `*.module.css` and the three plain ones.
    expect(
      [...INERT_RULES.keys()].sort(),
      'the inert-rule sweep did not look at the stylesheets it reports clean',
    ).toEqual(STYLESHEETS.map(asRepoPath).sort());
    expect([...INERT_RULES.keys()]).toContain('src/styles/typeface.css');
    expect([...INERT_RULES.keys()]).toContain('src/app/shell/AppShell.module.css');
    expect(INERT_RULES.size).toBeGreaterThan(40);
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
  }, BOUNDARY_BUDGET);

  /**
   * A module's identity is what the filesystem calls it, not what a specifier
   * called it.
   *
   * `existsSync` is case-blind on NTFS, and `forceConsistentCasingInFileNames`
   * only covers paths `tsc` resolves — which excludes every `.css` specifier and
   * every `?raw` one, since those match ambient wildcard modules in `vite/client`
   * and are never looked up on disk. On a case-sensitive filesystem, or in a
   * Docker build, a mis-cased import is a blank screen.
   *
   * The version this replaces respelled only the **basename**, and `REACHABLE` is
   * keyed on what it returned. So `import('../Runtime/run-doubles.ts?raw')` — one
   * capital letter — went into the graph under a key spelled `Runtime` while
   * `NOT_SHIPPED` looked up the key spelled `runtime`, and the double this file
   * exists to exclude was in `dist/assets/run-doubles-*.js` with the guard as it
   * then stood green in two consecutive runs at 24 assertions passed, `tsc -b
   * --force` exit 0 and `vite build` exit 0 at 220
   * modules against a 219-module control. The case-blindness had moved out of the
   * filesystem call and into the `Set` key.
   */
  it('resolves every specifier to the name the filesystem actually uses', () => {
    expect(GRAPH.miscased, 'a specifier whose case does not match the file on disk').toEqual([]);

    // The control, against real files, because the tree has no mis-cased
    // specifier today and an assertion over an empty list proves nothing about
    // the instrument that produced it. `readdirSync` answers with the disk's
    // spelling where `existsSync` would just have said "yes".
    const shell = join(SRC_ROOT, 'app', 'shell', 'AppShell.tsx');
    const wrongName = resolveInTree(shell, './appshell.module.css');
    expect(asRepoPath(wrongName?.file ?? '')).toBe('src/app/shell/AppShell.module.css');
    expect(miscasedRequest(wrongName ?? { file: '', requested: '' })).toBe(true);
    const rightName = resolveInTree(shell, './AppShell.module.css');
    expect(miscasedRequest(rightName ?? { file: '', requested: 'x' })).toBe(false);

    // The directory segment, which is the one that got past the basename
    // comparison. Same file, same last segment, different key.
    const wrongDirectory = resolveInTree(shell, '../../Runtime/run-doubles.ts?raw');
    expect(
      asRepoPath(wrongDirectory?.file ?? ''),
      'a mis-cased directory segment must resolve to the one file that is there',
    ).toBe('src/runtime/run-doubles.ts');
    expect(
      wrongDirectory?.file,
      'the graph key is the disk spelling, so NOT_SHIPPED can find it',
    ).toBe(join(SRC_ROOT, 'runtime', 'run-doubles.ts'));
    expect(miscasedRequest(wrongDirectory ?? { file: '', requested: '' })).toBe(true);

    // Extension and index resolution are this resolver appending segments, not a
    // casing fault, and both spellings are compared whole.
    const extensionless = resolveInTree(shell, '../../runtime/run-doubles');
    expect(asRepoPath(extensionless?.file ?? '')).toBe('src/runtime/run-doubles.ts');
    expect(miscasedRequest(extensionless ?? { file: '', requested: 'x' })).toBe(false);

    // And the whole walk, driven from a substitute entry, because the assertion
    // above is over an empty list on a clean tree.
    const miscased = walk(
      '<script type="module">import "/src/Runtime/run-doubles.ts?raw";</script>',
    );
    expect(
      [...miscased.reachable].map(asRepoPath),
      'a mis-cased specifier reaches the same file, under the disk\'s key',
    ).toContain('src/runtime/run-doubles.ts');
    expect(miscased.miscased).toEqual([
      'index.html <script type="module">: /src/Runtime/run-doubles.ts?raw is on disk as ' +
        'src/runtime/run-doubles.ts',
    ]);
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
  }, BOUNDARY_BUDGET);

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
  }, BOUNDARY_BUDGET);

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
    // A member read with brackets is the same construction site as a member read
    // with a dot, and the version this replaces matched `PropertyAccessExpression`
    // only — so this one was neither counted in `calls` nor pushed into
    // `escapes`, invisible in both directions at once. It compiles, it runs, and
    // the whole difference between green and red was `.` against `['…']`.
    expect(
      uses("import * as rt from '@/runtime/app-runtime';\nrt['createAgentRuntime'](a);\n"),
    ).toEqual({ calls: 1, escapes: [] });
    expect(
      uses("import * as rt from '@/runtime/app-runtime';\nrt[`createAgentRuntime`](a);\n"),
    ).toEqual({ calls: 1, escapes: [] });
    expect(
      uses("import * as rt from '@/runtime/app-runtime';\nrt['other'](a);\n"),
    ).toEqual({ calls: 0, escapes: [] });
    expect(uses("import * as rt from '@/runtime/app-runtime';\nrt.other(a);\n")).toEqual({
      calls: 0,
      escapes: [],
    });
    // A computed member name could be the factory's, and the namespace object
    // itself carries every export it has. Both are loud rather than absent,
    // because absence is what the two assertions below read as proof.
    expect(uses("import * as rt from '@/runtime/app-runtime';\nrt[name](a);\n")).toEqual({
      calls: 0,
      escapes: ['rt[name]'],
    });
    expect(uses("import * as rt from '@/runtime/app-runtime';\nuse(rt);\n")).toEqual({
      calls: 0,
      escapes: ['use(rt)'],
    });
    expect(uses("import * as rt from '@/runtime/app-runtime';\nconst all = { ...rt };\n")).toEqual({
      calls: 0,
      escapes: ['...rt'],
    });
    expect(uses("import * as rt from '@/runtime/app-runtime';\nexport { rt };\n")).toEqual({
      calls: 0,
      escapes: ['rt'],
    });
    // A namespace over a different module is a different object.
    expect(uses("import * as rt from './elsewhere';\nrt['createAgentRuntime'](a);\n")).toEqual({
      calls: 0,
      escapes: [],
    });

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
  }, BOUNDARY_BUDGET);

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
  }, BOUNDARY_BUDGET);

  it('names every exemption, and every exemption is still off the graph', () => {
    // An exemption that has stopped applying reads exactly like a clean tree, so
    // both maps are asserted in both directions rather than trusted. For
    // NOT_SHIPPED a hit means a test helper reached the bundle. For
    // AWAITING_A_SURFACE it means somebody did the work — good news, and the
    // entry has to go, because a debt list nobody is made to update is a comment.
    // The reason is interpolated, exactly as AWAITING_A_SURFACE's is. This loop
    // discarded it — `for (const [path] of NOT_SHIPPED)` — so the one assertion
    // that fires when a test double reaches the bundle told the operator which
    // module and not why it was ever exempt, which is the half that says whether
    // the import or the exemption is the mistake.
    for (const [path, reason] of NOT_SHIPPED) {
      expect(canonical(join(REPO_ROOT, path)), `${path} moved; fix NOT_SHIPPED`).not.toBeNull();
      expect(REACHABLE.has(join(REPO_ROOT, path)), shippedDoubleMessage(path, reason)).toBe(false);
    }
    for (const [path, waitingFor] of AWAITING_A_SURFACE) {
      expect(
        canonical(join(REPO_ROOT, path)),
        `${path} moved; fix AWAITING_A_SURFACE`,
      ).not.toBeNull();
      expect(REACHABLE.has(join(REPO_ROOT, path)), debtLandedMessage(path, waitingFor)).toBe(false);
    }
  }, BOUNDARY_BUDGET);

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
  }, BOUNDARY_BUDGET);

  /**
   * Where the bundler's traversal stops, starts and looks sideways.
   *
   * Round 5 stopped listing forms and started transcribing vite's own data, and
   * that was the right move: the tables are correct. What it did not transcribe
   * is the control flow around the tables, and every construction that landed in
   * round 6 is in that control flow rather than in the data. Four of them, each
   * measured against the committed guard before it was changed:
   *
   * - `vite-ignore` on the one script tag in this document. `vite build` exit 0
   *   at **1 module transformed against a 219-module control**; `dist/assets/`
   *   holding nothing but a sourcemap; `dist/`'s own `index.html` still pointing at
   *   `/src/main.tsx`, which does not exist in the output; guard green twice at
   *   33/33 with `GRAPH.entries` still `['src/main.tsx']`. The same attribute on
   *   a `<link>` laundered a planted orphan, and was caught only by that pin.
   * - `<script type="Module">`. `getScriptInfo` compares `p.value === "module"`
   *   byte for byte; this reader trimmed and lower-cased, a strict superset, so
   *   it read a body the bundler treats as data \u2014 and an inline body's edges
   *   went into `reachable` without touching the entry pin at all.
   * - `<div id="root" style="background-image: url('\u2026')">`, landed independently
   *   by two adversaries in two rounds: 220 modules against 219, and all 10636
   *   bytes of the first `NOT_SHIPPED` entry in
   *   `dist/assets/run-doubles-*.ts`.
   * - `<noscript>`, in the other direction: markup to jsdom, raw text to vite's
   *   parse5, so a `<link>` inside one reddened this guard against a build that
   *   stayed at the control's own module count.
   */
  it("stops where the bundler's traversal stops, and reads what it reads", () => {
    const specifiersOfLoad = (html: string): string[] =>
      htmlLoads(html).flatMap((load) => (load.kind === 'file' ? [load.specifier] : []));
    const unreadOf = (html: string): number =>
      htmlLoads(html).filter((load) => load.kind === 'unread').length;

    // Read by `getScriptInfo` on a script and by `getNodeAssetAttributes` after
    // its row lookup on a table tag, which is what `honoursViteIgnore` says.
    // Loud rather than silent, because on this document's one script tag it
    // removes the whole product.
    const ignoredEntry = '<script type="module" src="/src/main.tsx" vite-ignore></script>';
    expect(specifiersOfLoad(ignoredEntry), 'vite is told to leave this tag alone').toEqual([]);
    expect(unreadOf(ignoredEntry)).toBe(1);
    expect(walk(ignoredEntry).entries, 'a bundle containing none of the product').toEqual([]);
    const ignoredLink = '<link rel="stylesheet" href="/src/styles/base.css" vite-ignore />';
    expect(specifiersOfLoad(ignoredLink)).toEqual([]);
    expect(unreadOf(ignoredLink)).toBe(1);
    expect(specifiersOfLoad('<link rel="stylesheet" href="/src/styles/base.css" />')).toEqual([
      '/src/styles/base.css',
    ]);

    // `p.name === "type" && p.value === "module"`, byte for byte.
    expect(specifiersOfLoad('<script type="Module" src="/src/main.tsx"></script>')).toEqual([]);
    expect(unreadOf('<script type="Module" src="/src/main.tsx"></script>')).toBe(1);
    expect(specifiersOfLoad('<script type=" module" src="/src/main.tsx"></script>')).toEqual([]);
    const casedInline = '<script type="Module">import "/src/runtime/run-doubles.ts";</script>';
    expect(
      [...walk(casedInline).reachable],
      'a body the bundler reads as data must not put edges on this graph',
    ).toEqual([]);
    expect(unreadOf(casedInline)).toBe(1);

    // `findNeedTransformStyleAttribute` matches any `style` whose value merely
    // contains `url(` or `image-set(` and hands the value to the CSS pipeline.
    const styled =
      '<div id="root" style="background-image: url(\'/src/runtime/run-doubles.ts\')"></div>';
    expect(specifiersOfLoad(styled), 'an inline style is a declaration list').toEqual([
      '/src/runtime/run-doubles.ts',
    ]);
    expect([...walk(styled).reachable].map(asRepoPath)).toContain('src/runtime/run-doubles.ts');
    expect(specifiersOfLoad('<div id="root" style="color: inherit"></div>')).toEqual([]);
    expect(
      specifiersOfLoad('<div style="background-image: image-set(\'/src/main.tsx\' 1x)"></div>'),
      'vite tests for image-set( in the attribute value as well as url(',
    ).toEqual(['/src/main.tsx']);

    // Scripting is enabled in the parser vite uses and disabled in jsdom's, so a
    // `noscript` body is one raw-text node there and an element subtree here.
    const noscript = '<noscript><link rel="stylesheet" href="/src/styles/base.css"></noscript>';
    expect(specifiersOfLoad(noscript), 'the bundler never builds these elements').toEqual([]);
    expect(unreadOf(noscript), 'and there is no tag to be loud about either').toBe(0);
  }, BOUNDARY_BUDGET);

  /**
   * A `url()` outside a declaration value is dead text, and is said so.
   *
   * Narrowing `urlTargets` to `walkDecls` closes the laundering direction and
   * would open the silent one: a form that is neither followed nor reported is
   * exactly the shape this file has been evaded through four times. So the
   * narrowing and the loud branch are asserted together, and the same `url()`
   * is driven in both positions.
   */
  it('reads a url() the declaration walk never sees, and refuses to follow it', () => {
    const stylesheet = join(SRC_ROOT, 'styles', 'base.css');
    const prelude = '@supports (background-image: url("./typeface.css")) { :root { --p: 1; } }';
    expect(
      cssSpecifiers(prelude, stylesheet),
      'a url() in an at-rule prelude is an edge this reader invents; postcss ' +
        'never hands the prelude to the replacer',
    ).toEqual([]);
    expect(
      cssUnfollowable(prelude, stylesheet).join(' | '),
      'and refusing to follow it silently is how the orphan behind it stays hidden',
    ).toContain('is not in a declaration value');
    expect(
      cssSpecifiers('.a { background-image: url("./typeface.css"); }', stylesheet),
      'the same url() in a declaration value is the edge it always was',
    ).toEqual(['./typeface.css']);
    expect(cssUnfollowable('.a { background-image: url("./typeface.css"); }', stylesheet)).toEqual(
      [],
    );
    // A nested at-rule prelude is inside a block and still not a declaration.
    expect(
      cssSpecifiers('.a { @supports (background-image: url("./typeface.css")) { color: inherit; } }', stylesheet),
    ).toEqual([]);
    // And `@import url(...)` is `importRules`' form, not this one, in both halves.
    expect(cssUnfollowable('@import url("./typeface.css");', stylesheet)).toEqual([]);
    expect(cssSpecifiers('@import url("./typeface.css");', stylesheet)).toEqual(['./typeface.css']);
  });

  /**
   * What this reader follows and what it calls unfollowable are the same
   * question, asked once.
   *
   * The predecessor was a hand-written `Set` of three names whose docblock
   * claimed it was "vite's set and not a longer one". Deleting a member left the
   * suite green twice — and a loop written over that set's own members cannot
   * catch that, because a set that enumerates itself is never short. So the
   * probe list below is written here, in the test, and every name on it is
   * driven through **both** readers: whatever `cssSpecifiers` follows must be
   * exactly what `cssUnfollowable` stays quiet about. A form that is followed
   * and reported is a double count; a form that is neither is a silent drop, and
   * a silent drop is what four separate agents have shipped a double through.
   */
  it('follows and reports the same set of CSS function forms', () => {
    const stylesheet = join(SRC_ROOT, 'styles', 'base.css');
    const forms = [
      'url',
      'image-set',
      '-webkit-image-set',
      '-ms-image-set',
      'local',
      'format',
      'data-uri',
      'attr',
      'src',
    ];
    const followed: string[] = [];
    const reported: string[] = [];
    for (const form of forms) {
      const rule = `.a { background-image: ${form}("./typeface.css"); }`;
      if (cssSpecifiers(rule, stylesheet).includes('./typeface.css')) followed.push(form);
      if (cssUnfollowable(rule, stylesheet).length > 0) reported.push(form);
    }
    expect(
      followed,
      'the forms vite rewrites, read out of the patterns transcribed from it',
    ).toEqual(['url', 'image-set', '-webkit-image-set', '-ms-image-set']);
    expect(
      reported,
      'and every other form naming a real file is loud rather than dropped',
    ).toEqual(['local', 'format', 'data-uri', 'attr', 'src']);
    for (const form of forms) {
      expect(
        followed.includes(form),
        `${form}() is both followed and reported, or neither`,
      ).toBe(!reported.includes(form));
      expect(
        cssFunctionFollowed(form),
        `cssFunctionFollowed disagrees with what urlTargets does with ${form}()`,
      ).toBe(followed.includes(form));
    }
  });

  /**
   * `viteSkipsUrl` is four branches, and one of them used to be asserted.
   *
   * Its whole justification is that it is a transcription of vite's
   * `skipUrlReplacer`: a url vite matched and declines to resolve. Following one
   * of those invents an edge. Deleting the `VITE_FUNCTION_CALL_RE` half, and
   * separately the two `__VITE_*__` halves, each left the suite green twice at
   * 33/33 \u2014 three of four branches uncontrolled in a function that exists to
   * copy somebody else's.
   */
  it("declines exactly the urls vite's own replacer declines", () => {
    expect(viteSkipsUrl('https://cdn.example/a.png'), 'an external reference').toBe(true);
    expect(viteSkipsUrl('#fragment'), 'a fragment').toBe(true);
    expect(viteSkipsUrl('var(--surface)'), 'a css function call, not a path').toBe(true);
    expect(viteSkipsUrl('__VITE_ASSET__abc__'), "vite's own asset placeholder").toBe(true);
    expect(viteSkipsUrl('__VITE_PUBLIC_ASSET__abc__'), "vite's own public placeholder").toBe(true);
    expect(viteSkipsUrl('./typeface.css'), 'and a real relative path is not skipped').toBe(false);
    const stylesheet = join(SRC_ROOT, 'styles', 'base.css');
    expect(
      cssSpecifiers('.a { background-image: url(var(--surface)); }', stylesheet),
      'a declaration whose url() wraps a css function is not an edge',
    ).toEqual([]);
  });

  /**
   * An inline module body is parsed under both grammars, and both readings matter.
   *
   * `inlineSpecifiers`' docblock calls the union load-bearing \u2014 "reading it
   * under one grammar only would drop every edge in a body the other grammar is
   * needed for, and a dropped edge is the direction `NOT_SHIPPED` reads as
   * proof" \u2014 and deleting the TSX half left the suite green twice at 33/33.
   * The two bodies below are each invisible to exactly one grammar.
   */
  it('reads an inline body under both grammars, because the tag declares neither', () => {
    const tsxOnly = "const view = <><span>{import('/src/app/App.tsx')}</span></>;";
    const tsOnly = "const identity = <T>(value: T) => import('/src/main.tsx');";
    expect(specifiers(tsxOnly, 'inline.ts'), 'the TypeScript grammar loses this one').toEqual([]);
    expect(specifiers(tsxOnly, 'inline.tsx')).toEqual(['/src/app/App.tsx']);
    expect(specifiers(tsOnly, 'inline.tsx'), 'and the TSX grammar loses this one').toEqual([]);
    expect(specifiers(tsOnly, 'inline.ts')).toEqual(['/src/main.tsx']);
    expect(inlineSpecifiers(tsxOnly), 'the union must carry the TSX reading').toEqual([
      '/src/app/App.tsx',
    ]);
    expect(inlineSpecifiers(tsOnly), 'and the TypeScript reading').toEqual(['/src/main.tsx']);
  });

  /**
   * A declaration file is not a module, and demanding the walk reach one is a
   * false red on boilerplate.
   *
   * `extname('vite-env.d.ts')` is `.ts`, so the enumerator listed one and the
   * orphan assertion then failed with a message asserting that a file with no
   * runtime "is called by nothing". a `vite-env` declaration file under `src/` is what
   * `npm create vite@latest` writes for every TypeScript template.
   */
  it('does not ask the walk to reach a file the bundler cannot load', () => {
    expect(bundlerLoads('vite-env.d.ts'), 'a declaration file has no runtime').toBe(false);
    expect(bundlerLoads('adapter.d.tsx')).toBe(false);
    expect(bundlerLoads('adapter.ts'), 'and an ordinary module still is one').toBe(true);
    expect(bundlerLoads('App.tsx')).toBe(true);
    expect(bundlerLoads('AppShell.module.css')).toBe(true);
    expect(bundlerLoads('reachable.test.ts')).toBe(false);
    expect(bundlerLoads('README.md')).toBe(false);
    expect(
      shippingModules(SRC_ROOT).filter((file) => DECLARATION_FILE.test(basename(file))),
      'a declaration file reached the enumerator anyway',
    ).toEqual([]);
  });

  /**
   * The entry pin's two messages, told apart by driving them.
   *
   * Round 5 split one assertion into two because the single one misdescribed
   * half of what it caught, and left the property in a twelve-line comment:
   * collapsing the split back into the one assertion it replaced left the suite
   * at `33 passed (33)`, exit 0. `entryPinFailure` is the pin itself, so the
   * collapse is an edit to the thing this assertion drives.
   */
  it('the entry pin says the entry set moved, not that the graph is vacuous', () => {
    expect(entryPinFailure(GRAPH.entries), "today's entry set is the pinned one").toBeNull();
    const moved = walk(
      '<link rel="icon" href="/src/styles/tokens.css" />' +
        '<script type="module" src="/src/main.tsx"></script>',
    ).entries;
    expect(moved, 'the substitute document does not carry the edge this drives').toEqual([
      'src/styles/tokens.css',
      'src/main.tsx',
    ]);
    const message = entryPinFailure(moved) ?? '';
    expect(
      message,
      'a routine second reference in index.html must redden saying the entry set ' +
        'moved. The message that stood here said the graph was vacuous while ' +
        'printing an array with the entry in it',
    ).toContain('index.html names a file this guard has not been told about');
    expect(message, 'and it must not be the vacuity message').not.toContain(
      'the graph below is vacuous',
    );
    const vacuous = entryPinFailure([]) ?? '';
    expect(vacuous, 'an entry set that really is empty gets the other message').toContain(
      'the graph below is vacuous',
    );
  });

  /**
   * The one assertion that fires on a shipped double says why it was exempt.
   *
   * That is the whole subject of commit 3697252, and reverting it exactly \u2014 the
   * loop back to `for (const [path] of NOT_SHIPPED)` and the message string
   * without the reason \u2014 left the suite at `33 passed (33)`, exit 0. A reason is
   * only ever rendered when the assertion fails, and nothing in a green run
   * reads a failure message, so the property had no reader at all. RULE U applies
   * to both maps' second columns as written.
   */
  it('an exemption that fires says why it was exempt', () => {
    for (const [path, reason] of NOT_SHIPPED) {
      const message = shippedDoubleMessage(path, reason);
      expect(reason, `${path} has no stated reason`).not.toBe('');
      expect(message, 'the module is named').toContain(path);
      expect(message, 'and so is the reason it was ever exempt').toContain(reason);
    }
    for (const [path, waitingFor] of AWAITING_A_SURFACE) {
      const message = debtLandedMessage(path, waitingFor);
      expect(waitingFor, `${path} has no stated debt`).not.toBe('');
      expect(message).toContain(path);
      expect(message, 'the debt list interpolates its own second column too').toContain(waitingFor);
    }
    // And what a failing assertion actually carries, rather than what a call to
    // the builder returns: the two are the same string only while the loops
    // above use these functions.
    const fired =
      whyItFailed(() => {
        expect(true, shippedDoubleMessage('src/probe.ts', 'a stated reason')).toBe(false);
      }) ?? '';
    expect(fired).toContain('a stated reason');
    expect(fired).toContain('src/probe.ts');
  });

  /**
   * A factory reached through `await import(...)` is a construction site.
   *
   * `factoryUsesIn` built its bindings inside `if (!ts.isImportDeclaration(node))
   * return`, and a dynamic import binds through a `VariableDeclaration`. So
   *
   *     const { createAgentRuntime } = await import('@/runtime/app-runtime');
   *     return createAgentRuntime(adapter);
   *
   * appended to a file already on the graph was a real, compiling second
   * construction site that produced neither a builder nor an escape \u2014 invisible
   * in both directions, which is the failure \u00a77 of this file's header names and
   * the one `factoryUsesIn` was written to end. The control is that the identical
   * function written with a static import reddens on the first run, so what the
   * reader was blind to is the syntax and not the semantics. It is also the
   * ordinary spelling: it is what a contributor writes when told to keep a heavy
   * dependency out of the initial chunk.
   */
  it('reads a lazily imported factory as a construction site', () => {
    const fromRuntime = (specifier: string, exported: string): boolean =>
      specifier === '@/runtime/app-runtime' && exported === 'createAgentRuntime';
    const uses = (body: string): FactoryUse =>
      factoryUses(`export async function build(adapter: unknown) {\n${body}\n}\n`, 'probe.tsx', fromRuntime);

    expect(
      uses(
        "  const { createAgentRuntime } = await import('@/runtime/app-runtime');\n" +
          '  return createAgentRuntime(adapter);',
      ).calls,
      'the ordinary lazy spelling of a second construction site',
    ).toBe(1);
    expect(
      uses(
        "  const { createAgentRuntime: make } = await import('@/runtime/app-runtime');\n" +
          '  return make(adapter);',
      ).calls,
      'renamed in the binding pattern',
    ).toBe(1);
    expect(
      uses(
        "  const runtime = await import('@/runtime/app-runtime');\n" +
          '  return runtime.createAgentRuntime(adapter);',
      ).calls,
      'the namespace spelling of the same thing',
    ).toBe(1);
    expect(
      uses(
        "  const runtime = await import('@/runtime/app-runtime');\n" +
          "  return runtime['createAgentRuntime'](adapter);",
      ).calls,
      'and its element-access spelling',
    ).toBe(1);
    expect(
      uses(
        "  const runtime = await import('@/runtime/app-runtime');\n" + '  return register(runtime);',
      ).escapes,
      'a lazily imported namespace that leaves is loud, exactly as a static one is',
    ).not.toEqual([]);
    // A lazy import of something else is not a construction site. The three in
    // this tree today are all of that shape, in `src/platform/tauri-adapter.ts`.
    expect(
      uses("  const { invoke } = await import('zustand');\n  return invoke('x');"),
      'a lazy import of another package is neither a builder nor an escape',
    ).toEqual({ calls: 0, escapes: [] });
    expect(
      uses("  const { createAgentRuntime } = await import(name);\n  return createAgentRuntime(adapter);")
        .calls,
      'a computed specifier names no module this reader can resolve',
    ).toBe(0);
  }, BOUNDARY_BUDGET);

  /**
   * The bundler's own answer, beside this file's reconstruction of it.
   *
   * Every landed evasion of the last three rounds is one place where a second
   * implementation of vite's front end diverged from vite's front end, and each
   * fix closed the instance. This closes the class the only way it can be
   * closed: `vite build` is run for real, with `write: false`, and asked which
   * files it read. A disagreement in **either** direction is a named failure.
   *
   * - The bundler read a file this walk does not reach. Something ships that this
   *   file's `NOT_SHIPPED` assertion, which reads absence as proof, would call
   *   absent. That is the hiding direction, and it is how an inline `style`
   *   attribute put 10636 bytes of a test double into `dist/assets/` with the
   *   guard green.
   * - This walk reaches a file the bundler did not read. The walk invented an
   *   edge, and an invented edge launders an orphan onto the graph. That is how
   *   a `url()` in an `@supports` prelude turned a planted orphan green.
   *
   * It is deliberately not a whole-repo comparison. The build reads
   * `node_modules` and vite's own virtual modules, which this walk has never
   * claimed to enumerate; the question both instruments answer is about `src/`,
   * on the file kinds `bundlerLoads` names.
   */
  it('reads what the build reads, and reaches nothing the build did not', () => {
    const facts = buildFacts();
    const built = readBySourceKind(facts);
    const walked = reachedBySourceKind();
    expect(
      built.length,
      'the build reported almost nothing; this comparison is vacuous',
    ).toBeGreaterThan(40);
    expect(
      built.filter((path) => !walked.includes(path)),
      'the bundler loaded a file under src/ that this walk does not reach. Whatever ' +
        'is here ships while every assertion in this file that reads absence as ' +
        'proof — NOT_SHIPPED first among them — reads it as absent',
    ).toEqual([]);
    expect(
      walked.filter((path) => !built.includes(path)),
      'this walk follows an edge into src/ that the bundler does not have. An edge ' +
        'this file invents launders an orphan onto the graph: the module below is ' +
        'reachable here and dead there',
    ).toEqual([]);
  }, BUILD_BUDGET);

  /**
   * The renderer is in the bundle, asked of the bundle.
   *
   * `<script type="module" src="/src/main.tsx" vite-ignore>` — one documented
   * attribute on the one script tag this document has — left `vite build` exit 0
   * at **1 module transformed against a 219-module control**, `dist/assets/`
   * holding nothing but a sourcemap and `dist/`'s own `index.html` pointing at a source
   * path that does not exist in the output, with the assertion named *the
   * renderer is wired into the product* green twice at 33/33. Two adversaries
   * landed it independently in the same round. `htmlLoads` now reads the
   * attribute, and this asks the build directly, because no amount of reading
   * `index.html` tells you that vite declined to read it.
   */
  it('the build reaches the renderer, and every shipping module under src/', () => {
    const facts = buildFacts();
    const built = new Set(readBySourceKind(facts));
    expect(facts.inputs, "rollup's input is not this repo's index.html").toEqual(['index.html']);
    expect(
      [...built],
      'the build did not read src/main.tsx. The product in dist/ contains none of ' +
        'the renderer, whatever this file reconstructs from index.html',
    ).toContain('src/main.tsx');
    expect(
      shippingModules(SRC_ROOT)
        .map(asRepoPath)
        .filter((path) => !NOT_SHIPPED.has(path))
        .filter((path) => !AWAITING_A_SURFACE.has(path))
        .filter((path) => !built.has(path)),
      'a module under src/ that the bundler did not load. The same finding as ' +
        '`reaches every shipping module under src/ from index.html`, asked of the ' +
        'build instead of the walk, so it survives being wrong about the walk',
    ).toEqual([]);
  }, BUILD_BUDGET);

  /**
   * Every exemption, checked against the build rather than against the walk.
   *
   * `NOT_SHIPPED` reads absence from `REACHABLE` as proof that nothing ships a
   * module, and `REACHABLE` is this file's reconstruction. Three separate
   * constructions have made a `NOT_SHIPPED` entry ship while that set stayed
   * clean. This one reads the bundler's own set instead, so it is right about a
   * double the reconstruction is wrong about.
   *
   * What stood here was an absolute — *a double in the bundle is a red no matter
   * what the reconstruction believes* — and a critic disproved it by execution
   * twice in the round that wrote it, and adversaries disproved it five more
   * times in the round after. The set this reads is what the recorded build
   * **loaded**, and loading is not the only way into `dist/`: a `writeBundle`
   * copying a file next to the bundle adds no module and is invisible here, and
   * `build: { write: false }` means everything downstream of writing is
   * invisible to it as well. `RESOLVED_PLUGINS` now carries each plugin's hook
   * set for exactly that reason, which turns "a hook appeared on an existing
   * object" into a red — and a hook that already exists doing something new is
   * still outside this assertion. `What it still cannot see` says so in the
   * limits list rather than here, and reading `dist/` itself is the instrument
   * that would end it.
   */
  it('no exemption is in the build', () => {
    const facts = buildFacts();
    const built = new Set(readBySourceKind(facts));
    for (const [path, reason] of NOT_SHIPPED) {
      expect(built.has(path), shippedDoubleMessage(path, reason)).toBe(false);
    }
    for (const [path, waitingFor] of AWAITING_A_SURFACE) {
      expect(built.has(path), debtLandedMessage(path, waitingFor)).toBe(false);
    }
  }, BUILD_BUDGET);

  /**
   * `public/` is a second path from this repo into `dist/`, and it is not walked.
   *
   * `publicDir` defaults to `public` and needs no config key, so
   * `objectKeys(VITE_CONFIG_ROOT)` cannot see it — there is nothing in the config
   * to see — and `shippingModules` walks `SRC_ROOT` and nothing else. An
   * adversary made the directory and copied one file into it: `vite build` exit 0
   * at **219 modules, the control's own count**, and a `run-doubles.ts` at the top of `dist/` holding
   * **10636 bytes, byte-identical to `src/runtime/run-doubles.ts`** — the whole
   * of the first `NOT_SHIPPED` entry in the product, guard green at 33/33 and the
   * module count untouched, because a copied file is not a module.
   *
   * The directory does not exist today and the honest thing is not to claim it
   * never will: creating one is the most ordinary edit imaginable, and
   * `htmlLoads`' own docblock opens by telling the reader to do it for a favicon.
   * So the contents are pinned. When somebody adds `public/vela.svg` this reddens
   * once, they name it here, and the channel stops being invisible.
   */
  it('names everything public/ ships, because the build copies it unasked', () => {
    const facts = buildFacts();
    expect(
      asRepoPath(facts.publicDir),
      'the resolved publicDir is not where this assertion is looking',
    ).toBe('public');
    expect(
      publicFiles(facts.publicDir),
      'everything in public/ is copied into dist/ verbatim: no module graph, no ' +
        'walk, and no assertion in this file governed it. Name each file here, or ' +
        'delete it',
    ).toEqual(PUBLIC_FILES);
    // The control. `public/` does not exist, so the assertion above compares an
    // empty list with an empty list and would pass just as well with the
    // enumerator returning nothing at all — which is precisely the shape this
    // file calls a trap. So the enumerator is driven over a directory that does
    // exist, and asked for something only a real recursive read can produce.
    const underSrc = publicFiles(SRC_ROOT);
    expect(underSrc.length, 'the directory reader enumerates nothing').toBeGreaterThan(100);
    expect(underSrc, 'and it descends rather than reading one level').toContain(
      'runtime/reachable.test.ts',
    );
  }, BUILD_BUDGET);

  /**
   * The config vite resolved, against the config this file read off the page.
   *
   * `calleeNames` pins the *name* `react`, `objectKeys` pins the five top-level
   * keys, and `unreadableProperties` sweeps for spreads and shorthands — and
   * nothing pinned `vite.config.ts`'s **import specifiers**, so the name resolved
   * to whatever module a maintainer pointed it at. Three rounds of adversaries
   * landed the same construction: `import react from './vite.extra'`, that file
   * default-exporting a `react()` returning `[realReact(), { transformIndexHtml:
   * { order: 'pre' } }]`, guard green twice at 33/33, `vite build` exit 0 at 221
   * modules against 219, and the double's bytes in the shipped entry chunk.
   * Splitting a growing config into a helper and keeping the local binding name
   * is routine refactoring; there is no reading of the object literal that can
   * tell the two apart.
   *
   * The comparison above catches what such a plugin *does* — an injected import
   * makes the build read a file the walk does not. This catches the plugin
   * itself, and the aliases, which are the other thing this file reads off the
   * page and the bundler reads out of the module it actually loaded.
   */
  it('holds vite.config.ts to the config the bundler resolved', () => {
    const facts = buildFacts();
    expect(
      facts.plugins,
      'the resolved plugin list moved. Either vite was upgraded — say so and ' +
        'update this — or vite.config.ts is loading a plugin that is not written ' +
        'in vite.config.ts, which is the one thing every AST assertion in this ' +
        'file is structurally unable to see',
    ).toEqual(RESOLVED_PLUGINS);
    expect(
      facts.aliases,
      'the alias prefixes vite resolved are not the ones this file read out of ' +
        'the config object literal. Every specifier this walk translates goes ' +
        'through the list on the left',
    ).toEqual([...ALIASES.keys()]);
  }, BUILD_BUDGET);

  /**
   * The two memos, asserted as counts rather than as durations.
   *
   * Removing either cache lookup restores the exact pre-fix behaviour — every
   * walk re-reading and re-parsing every reachable file — and left the suite at
   * `33 passed (33)`, exit 0 both times. The `20_000` budget is a real partial
   * guard against the 5000ms default that bit round 4, but it clears by roughly
   * eight times either way, so it cannot see this; and asserting a duration is
   * asserting the thing the round-4 false red was made of. A second walk that
   * reads nothing new is the property the commit claims, and it is timing-free.
   */
  it('reads and parses each reachable file once per run, not once per walk', () => {
    expect(
      FILE_ANALYSIS.size,
      'the analysis memo is empty; this assertion is vacuous',
    ).toBeGreaterThan(40);
    expect(PARSED_MODULES.size, 'the parse memo is empty; this assertion is vacuous').toBeGreaterThan(
      40,
    );
    const reads = FILE_ANALYSES_COMPUTED;
    const parses = MODULES_PARSED;
    walk();
    constructionSites('createAgentRuntime', join(SRC_ROOT, 'runtime', 'app-runtime.ts'));
    expect(
      FILE_ANALYSES_COMPUTED - reads,
      'a second walk re-read and re-classified files the first walk had already ' +
        'read. That is once per walk rather than once per run, which is the shape ' +
        'that timed out on a clean tree at vitest’s 5000ms default',
    ).toBe(0);
    expect(
      MODULES_PARSED - parses,
      'a second pass over the module graph re-parsed modules already parsed',
    ).toBe(0);
  }, BOUNDARY_BUDGET);

  /**
   * ## Reader positions, not only reader tables
   *
   * Round 6 pinned a thirteen-name data list with a synthetic source carrying
   * every name, and then wrote a thirteen-branch reader whose branch list
   * nothing pinned at all. A measurer swept the functions this diff adds and
   * deleted 52 structural branches one at a time: 21 of them left
   * `tsc --build --force` at exit 0 and the whole suite at 2432 passed, and a
   * 22nd was held up by the type checker alone. Seven of the 21 were in
   * `factoryUsesIn` and `reExported` — the two functions round 6 rebuilt — and
   * `factoryUsesIn` carried a comment claiming its branches were pinned
   * individually, which was true of three arms and false of six beside them.
   *
   * So each assertion below drives one reader against **one input per structural
   * position it handles**, checked against an enumerated list, and names the
   * position in its own failure message. Deleting a branch stops naming a
   * position rather than going quiet.
   */
  it('reads every initializer shape that is a module object', () => {
    const initializerOf = (expression: string): ts.Expression | undefined => {
      let found: ts.Expression | undefined;
      eachNode(parse(`const probe = ${expression};`, 'probe.ts'), (node) => {
        if (found === undefined && ts.isVariableDeclaration(node)) found = node.initializer;
      });
      return found;
    };
    // Every position `awaitedImportSpecifier` decides, and the answer it owes.
    // The parenthesised arm was described by a true sentence in its own docblock
    // and asserted by nothing: deleting it was `tsc` exit 0 and 2432 green.
    const shapes = new Map<string, string | null>([
      ["await import('@/a')", '@/a'],
      ["import('@/a')", '@/a'],
      ["(await import('@/a'))", '@/a'],
      ["(import('@/a'))", '@/a'],
      ['await import(`@/a`)', '@/a'],
      ['await import(name)', null],
      ["import('@/a').then((m) => m)", null],
      ["require('@/a')", null],
      ['plainValue', null],
    ]);
    expect(shapes.size, 'the position list is empty; this assertion is vacuous').toBe(9);
    for (const [expression, specifier] of shapes) {
      expect(
        awaitedImportSpecifier(initializerOf(expression)),
        `\`${expression}\` is no longer read as the module object it is`,
      ).toBe(specifier);
    }
  }, BOUNDARY_BUDGET);

  /**
   * Every binding shape a factory can arrive in, and every reference shape it
   * can be spelled with, one module per position.
   *
   * Six arms of `factoryUsesIn` deleted with the whole suite green while a
   * comment beside them said each was pinned: the qualified-name skip, the
   * property-assignment skip, the import-clause skip, the default-import
   * binding, the inline-`type` skip in named bindings, and the string-literal
   * property arm of the object binding pattern. Each is a row here. So is
   * `.then`, which is not a skipped arm but an arm that did not exist — an
   * adversary put a second construction site through it in a reachable module,
   * green twice, while the `await` spelling of the same three lines reddened on
   * the first run.
   *
   * `escapes` is counted rather than matched, because its contents are source
   * text and the property is that the residue is **loud**, not what it says.
   */
  it('reads every binding and every reference shape a factory can arrive in', () => {
    const isFactory = (specifier: string, exported: string): boolean =>
      specifier === '@/f' && (exported === 'make' || exported === 'default');
    const uses = (source: string): string => {
      const found = factoryUses(source, 'probe.ts', isFactory);
      return `${found.calls} called, ${found.escapes.length} loud`;
    };
    const positions = new Map<string, { source: string; calls: number; escapes: number }>([
      ['a named import', { source: "import { make } from '@/f';\nmake();", calls: 1, escapes: 0 }],
      [
        'a renamed named import',
        { source: "import { make as build } from '@/f';\nbuild();", calls: 1, escapes: 0 },
      ],
      [
        'a default import',
        { source: "import make from '@/f';\nmake();", calls: 1, escapes: 0 },
      ],
      [
        'an inline type-only named import, which is erased',
        { source: "import { type make } from '@/f';\nmake();", calls: 0, escapes: 0 },
      ],
      [
        'a wholly type-only import clause, which is erased',
        { source: "import type { make } from '@/f';\nmake();", calls: 0, escapes: 0 },
      ],
      [
        'a namespace member read',
        { source: "import * as f from '@/f';\nf.make();", calls: 1, escapes: 0 },
      ],
      [
        'a namespace member read with a literal key',
        { source: "import * as f from '@/f';\nf['make']();", calls: 1, escapes: 0 },
      ],
      [
        'a namespace member read with a computed key, which is loud',
        { source: "import * as f from '@/f';\nf[key]();", calls: 0, escapes: 1 },
      ],
      [
        'a namespace object leaving, which is loud',
        { source: "import * as f from '@/f';\nregister(f);", calls: 0, escapes: 1 },
      ],
      [
        'the import clause itself, which is a binding and not a use',
        { source: "import { make } from '@/f';\nmake();\nimport * as make2 from '@/f';", calls: 1, escapes: 0 },
      ],
      [
        'a property access whose name happens to be the factory',
        { source: "import { make } from '@/f';\nmake();\nother.make;", calls: 1, escapes: 0 },
      ],
      [
        'a property assignment whose key happens to be the factory',
        { source: "import { make } from '@/f';\nmake();\nconst o = { make: 1 };", calls: 1, escapes: 0 },
      ],
      [
        'a qualified type name whose right half happens to be the factory',
        { source: "import { make } from '@/f';\nmake();\nlet v: other.make;", calls: 1, escapes: 0 },
      ],
      [
        'a lazy import destructured at the declaration',
        { source: "const { make } = await import('@/f');\nmake();", calls: 1, escapes: 1 },
      ],
      [
        'a lazy import destructured by a string-literal property',
        { source: "const { 'make': build } = await import('@/f');\nbuild();", calls: 1, escapes: 1 },
      ],
      [
        // The binding identifier of a namespace object is itself in the loud
        // residue: `locals`/`namespaces` are built in the same pass the
        // references are read in, so the declaration's own name is one of the
        // references. That is the conservative direction and it is why the two
        // boundary assertions can read `escapes` as "this analysis stopped
        // here" — but it is a property of this reader, so it is written down
        // rather than left for the next person to rediscover.
        'a lazy import bound whole, whose binding name is itself loud',
        { source: "const f = await import('@/f');\nf.make();", calls: 1, escapes: 1 },
      ],
      [
        'a lazy import destructured in a .then callback',
        { source: "import('@/f').then(({ make }) => make());", calls: 1, escapes: 1 },
      ],
      [
        'a .then callback taking the module object whole, whose parameter is loud',
        { source: "import('@/f').then((f) => f.make());", calls: 1, escapes: 1 },
      ],
      [
        'a .then callback this reader cannot open, which is loud',
        { source: "import('@/f').then(handler);", calls: 0, escapes: 1 },
      ],
      [
        'a lazy import of something else',
        { source: "const { make } = await import('@/other');\nmake();", calls: 0, escapes: 0 },
      ],
    ]);
    expect(positions.size, 'the position list is empty; this assertion is vacuous').toBe(20);
    // One object rather than one expectation per row, so a deleted branch names
    // **every** position that stopped being read rather than only the first.
    const read: Record<string, string> = {};
    const owed: Record<string, string> = {};
    for (const [name, { source, calls, escapes }] of positions) {
      read[name] = uses(source);
      owed[name] = `${calls} called, ${escapes} loud`;
    }
    expect(
      read,
      'a binding or reference shape this reader claims to read stopped being ' +
        'read. Every key below is one structural position in `factoryUsesIn`; ' +
        'the ones that moved are the branches that are gone',
    ).toEqual(owed);
  }, BOUNDARY_BUDGET);

  /**
   * Every re-export shape, and the two this reader deliberately does not follow.
   *
   * `export * as ns from` was folded in "deliberately conservatively" by a
   * sentence in its own docblock and by nothing else: deleting the whole
   * fallthrough left `tsc` at 0 and 2432 green, because the test drove `export
   * *`, named and type-only re-exports and never the namespace form. The
   * inline-`type` skip in the named-exports loop deleted green for the same
   * reason.
   */
  it('reads every re-export shape, and the two it deliberately does not', () => {
    const from = join(SRC_ROOT, 'runtime', 'app-runtime.ts');
    const target = join(SRC_ROOT, 'data', 'sandbox-repository.ts');
    const reaching = (asked: string): ReadonlySet<string> | undefined =>
      asked === target ? new Set(['make']) : undefined;
    const namesOf = (source: string): string[] =>
      reExported(parse(source, 'probe.ts'), from, reaching);
    const positions = new Map<string, { source: string; found: string[] }>([
      ['a star re-export', { source: "export * from '@/data/sandbox-repository';", found: ['make'] }],
      [
        'a named re-export',
        { source: "export { make } from '@/data/sandbox-repository';", found: ['make'] },
      ],
      [
        'a renamed re-export',
        { source: "export { make as build } from '@/data/sandbox-repository';", found: ['build'] },
      ],
      [
        'a named re-export of something else',
        { source: "export { other } from '@/data/sandbox-repository';", found: [] },
      ],
      [
        'a namespace re-export, folded in conservatively',
        { source: "export * as ns from '@/data/sandbox-repository';", found: ['ns'] },
      ],
      [
        'an inline type-only re-export, which is erased',
        { source: "export { type make } from '@/data/sandbox-repository';", found: [] },
      ],
      [
        'a wholly type-only re-export, which is erased',
        { source: "export type { make } from '@/data/sandbox-repository';", found: [] },
      ],
      [
        'a re-export from a module outside this tree',
        { source: "export * from 'react';", found: [] },
      ],
      ['a local export, which names no module', { source: 'export { make };', found: [] }],
    ]);
    expect(positions.size, 'the position list is empty; this assertion is vacuous').toBe(9);
    for (const [name, { source, found }] of positions) {
      expect(namesOf(source), `${name} is no longer read as a re-export`).toEqual(found);
    }
  }, BOUNDARY_BUDGET);

  /**
   * The resolver's candidate list and both prefix wires, driven end to end.
   *
   * `subpathBase` was pinned in four directions — wildcard, exact key,
   * conditions object, non-subpath — by assertions that all called it directly
   * with a synthetic map, and `resolveInTree`'s `?? subpathBase(path)` deleted
   * with `tsc` at 0 and the whole suite green, because this repo's
   * `package.json` declares no `imports` and no assertion had ever driven the
   * edge between the two. That is the shape this round is about: two thoroughly
   * tested things with nothing asserting the wire between them. The same was
   * true of `aliasBase`'s bare-prefix arm and of `join(base, 'index.tsx')`,
   * which has no file under `src/` to reach it — measured, ten `index.ts` and
   * zero of the other.
   *
   * So the maps are parameters, the candidate list is driven against a directory
   * outside this repository whose entries are seeded, and every position is a
   * row. The seeded directory is not on any real path: nothing in this repo
   * resolves through `..`, and `DIRECTORY_ENTRIES` is consulted before the disk,
   * so this cannot make a real lookup answer differently.
   */
  it('resolves a specifier through every prefix and every candidate it names', () => {
    const outside = resolve(REPO_ROOT, '..', 't05-outside-this-repository');
    DIRECTORY_ENTRIES.set(outside, [
      { name: 'Exact.css', isFile: true },
      { name: 'ts-file.ts', isFile: true },
      { name: 'tsx-file.tsx', isFile: true },
      { name: 'ts-dir', isFile: false },
      { name: 'tsx-dir', isFile: false },
    ]);
    DIRECTORY_ENTRIES.set(join(outside, 'ts-dir'), [{ name: 'index.ts', isFile: true }]);
    DIRECTORY_ENTRIES.set(join(outside, 'tsx-dir'), [{ name: 'index.tsx', isFile: true }]);
    const from = join(outside, 'probe.ts');
    const none = new Map<string, string | null>();
    const candidateOf = (specifier: string): string | null => {
      const found = resolveInTree(from, specifier, false, none, none);
      return found === null ? null : basename(found.file);
    };
    // One row per candidate `resolveInTree` tries, in the order it tries them.
    const candidates = new Map<string, string | null>([
      ['./Exact.css', 'Exact.css'],
      ['./ts-file', 'ts-file.ts'],
      ['./tsx-file', 'tsx-file.tsx'],
      ['./ts-dir', 'index.ts'],
      ['./tsx-dir', 'index.tsx'],
      ['./nothing-here', null],
    ]);
    expect(candidates.size, 'the candidate list is empty; this assertion is vacuous').toBe(6);
    const tried: Record<string, string | null> = {};
    const owed: Record<string, string | null> = {};
    for (const [specifier, file] of candidates) {
      tried[specifier] = candidateOf(specifier);
      owed[specifier] = file;
    }
    expect(
      tried,
      'a candidate spelling this resolver claims to try stopped being tried. ' +
        'Each key is one entry of the candidate list',
    ).toEqual(owed);

    // The outside-this-repository branch of `canonical`: no anchor to walk down
    // from, so the last segment and only the last segment is respelled. The
    // whole branch was replaceable by `return null` with the suite green.
    const miscased = resolveInTree(from, './exact.css', false, none, none);
    expect(
      miscased === null ? null : basename(miscased.file),
      'a path outside this repository is no longer respelled at all',
    ).toBe('Exact.css');
    expect(
      miscased === null ? null : basename(miscased.requested),
      'and the spelling the specifier asked for is no longer carried out beside it',
    ).toBe('exact.css');

    // The two wires. Both targets are real files, so the whole path — prefix
    // translation, candidate list, `canonical` — has to run for these to answer.
    const double = join(SRC_ROOT, 'runtime', 'run-doubles.ts');
    const wires = new Map<
      string,
      { specifier: string; aliases: Map<string, string | null>; imports: Map<string, string | null> }
    >([
      [
        'an alias prefix with a path after it',
        {
          specifier: '~t05/run-doubles.ts',
          aliases: new Map([['~t05', join(SRC_ROOT, 'runtime')]]),
          imports: none as Map<string, string | null>,
        },
      ],
      [
        'an alias prefix spelled bare',
        {
          specifier: '~t05',
          aliases: new Map([['~t05', double]]),
          imports: none as Map<string, string | null>,
        },
      ],
      [
        'a wildcard subpath import',
        {
          specifier: '#t05/run-doubles.ts',
          aliases: none as Map<string, string | null>,
          imports: new Map([['#t05/*', './src/runtime/*']]),
        },
      ],
      [
        'an exact subpath import',
        {
          specifier: '#t05',
          aliases: none as Map<string, string | null>,
          imports: new Map([['#t05', './src/runtime/run-doubles.ts']]),
        },
      ],
    ]);
    expect(wires.size, 'the wire list is empty; this assertion is vacuous').toBe(4);
    const reached: Record<string, string | null> = {};
    for (const [name, { specifier, aliases, imports }] of wires) {
      const found = resolveInTree(HTML_ENTRY, specifier, false, aliases, imports);
      reached[name] = found === null ? null : asRepoPath(found.file);
    }
    expect(
      reached,
      'a declared prefix stopped reaching the file it names. The helper that ' +
        'translates it is pinned separately; this is the edge from the helper ' +
        'into the resolver, which is the edge that was pinned by nothing',
    ).toEqual({
      'an alias prefix with a path after it': 'src/runtime/run-doubles.ts',
      'an alias prefix spelled bare': 'src/runtime/run-doubles.ts',
      'a wildcard subpath import': 'src/runtime/run-doubles.ts',
      'an exact subpath import': 'src/runtime/run-doubles.ts',
    });
    expect(
      resolveInTree(HTML_ENTRY, '#t05/run-doubles.ts', false, none, none),
      'an undeclared subpath import must resolve to nothing, loudly, rather ' +
        'than to whatever the last declared one happened to map',
    ).toBe(null);
  }, BOUNDARY_BUDGET);

  /**
   * Every spelling a declared prefix can carry, on both sides of the question.
   *
   * `pointsIntoThisTree`'s `path === prefix` arm deleted with the whole suite
   * green while the identical arm one function over, in `aliasBase`, reddened.
   * `subpathBase`'s wildcard length guard deleted green as well: no real
   * `imports` key overlaps its own head and tail, so nothing ever reached it.
   */
  it('recognises a declared prefix in every spelling that can carry one', () => {
    const aliases = new Map<string, string | null>([['~', join(SRC_ROOT, 'runtime')]]);
    const inTree = new Map<string, boolean>([
      ['./relative', true],
      ['../up-one', true],
      ['/root-absolute', true],
      ['#subpath/thing', true],
      ['~', true],
      ['~/thing', true],
      ['~notaprefix', false],
      ['react', false],
      ['@tauri-apps/api/core', false],
    ]);
    expect(inTree.size, 'the spelling list is empty; this assertion is vacuous').toBe(9);
    const answered: Record<string, boolean> = {};
    const owed: Record<string, boolean> = {};
    for (const [specifier, points] of inTree) {
      answered[specifier] = pointsIntoThisTree(specifier, aliases);
      owed[specifier] = points;
    }
    expect(
      answered,
      'a specifier spelling stopped being recognised as naming a file in this ' +
        'tree. Anything that stops being recognised stops being `lost` when it ' +
        'resolves to nothing, which is the silent `continue` defect 5 abolished',
    ).toEqual(owed);

    const keys = new Map<string, string>([
      ['a wildcard key', '#w/thing'],
      ['an exact key', '#e'],
      ['a conditions object, which is not a guess', '#c'],
      ['a key whose head and tail overlap the whole specifier', '#o'],
      ['a specifier that is not a subpath at all', './plain'],
    ]);
    const imports = new Map<string, string | null>([
      ['#w/*', './src/runtime/*'],
      ['#e', './src/runtime/run-doubles.ts'],
      ['#c', null],
      ['#o*o', './src/*'],
    ]);
    const mapped: Record<string, string | null> = {};
    for (const [name, specifier] of keys) {
      const base = subpathBase(specifier, imports);
      mapped[name] = base === null ? null : asRepoPath(base);
    }
    expect(
      mapped,
      'a subpath key shape stopped being translated, or started being ' +
        'translated into something the manifest does not say',
    ).toEqual({
      'a wildcard key': 'src/runtime/thing',
      'an exact key': 'src/runtime/run-doubles.ts',
      'a conditions object, which is not a guess': null,
      'a key whose head and tail overlap the whole specifier': null,
      'a specifier that is not a subpath at all': null,
    });
  }, BOUNDARY_BUDGET);

  /**
   * Every shape a config's exported object, its plugin list and its alias
   * targets can be written in.
   *
   * Three arms of the config readers deleted with the whole suite green:
   * `configRootOf`'s `node.isExportEquals === true` guard, `calleeNames`' bare
   * identifier arm, and — the one that matters most — `aliasTarget`'s
   * plain-string arm, which is the spelling vite accepts and the spelling this
   * file's own decoy configs are written in, while every real assertion drove
   * the `fileURLToPath` one.
   */
  it('reads a config through every shape its object, plugins and aliases take', () => {
    const rootKeys = (source: string): string[] | null => {
      const root = configRootOf(parse(source, 'probe.ts'));
      return root === null ? null : objectKeys(root);
    };
    const exports = new Map<string, string[] | null>([
      ['export default { plugins: [] };', ['plugins']],
      ['export default defineConfig({ plugins: [] });', ['plugins']],
      ['export = { plugins: [] };', null],
      ['export const config = { plugins: [] };', null],
    ]);
    expect(exports.size, 'the export list is empty; this assertion is vacuous').toBe(4);
    const found: Record<string, string[] | null> = {};
    const owed: Record<string, string[] | null> = {};
    for (const [source, keys] of exports) {
      found[source] = rootKeys(source);
      owed[source] = keys;
    }
    expect(
      found,
      'a config export form stopped being read, or a form vite cannot use ' +
        'started being read as the config. `export =` is CommonJS and an ESM ' +
        'config file cannot use it, so reading it would be this file inventing ' +
        'a config the bundler never sees',
    ).toEqual(owed);

    const plugins = new Map<string, string[] | null>([
      ['[react()]', ['react']],
      ['[react]', ['react']],
      ['[...packaging]', ['<SpreadElement>']],
      ["['react']", ['<StringLiteral>']],
      ['{}', null],
    ]);
    const listed: Record<string, string[] | null> = {};
    const listedOwed: Record<string, string[] | null> = {};
    for (const [source, names] of plugins) {
      listed[source] = calleeNames(configProperty(['plugins'], configRootOf(
        parse(`export default { plugins: ${source} };`, 'probe.ts'),
      )));
      listedOwed[source] = names;
    }
    expect(
      listed,
      'a plugin-list element shape stopped being reported. An element this ' +
        'reader does not understand must come back as its syntax kind and ' +
        'redden, not be skipped: a skipped element is a plugin nobody named',
    ).toEqual(listedOwed);

    const aliasesOf = (source: string): (string | null)[] => [
      ...aliasesIn(configRootOf(parse(`export default { resolve: { alias: ${source} } };`, 'probe.ts'))).values(),
    ].map((target) => (target === null ? null : asRepoPath(target)));
    const targets = new Map<string, (string | null)[]>([
      ["{ '@': './src' }", ['src']],
      ["{ '@': fileURLToPath(new URL('./src', import.meta.url)) }", ['src']],
      ["{ '@': somewhereElse }", [null]],
    ]);
    const translated: Record<string, (string | null)[]> = {};
    const translatedOwed: Record<string, (string | null)[]> = {};
    for (const [source, paths] of targets) {
      translated[source] = aliasesOf(source);
      translatedOwed[source] = paths;
    }
    expect(
      translated,
      'an alias target spelling stopped being translated. `null` is the safe ' +
        'answer — the prefix is still declared, so every specifier using it is ' +
        'lost and loud — and a spelling silently dropped from the map is not ' +
        '`null`, it is a prefix this file has never heard of',
    ).toEqual(translatedOwed);
  }, BOUNDARY_BUDGET);

  /**
   * Every position the stylesheet reader decides, from the token scanner up.
   *
   * The escape arm of `readCss`'s string scanner deleted with the whole suite
   * green — every forged-marker and string-laundering case in
   * `reads a stylesheet as a module, and a CSS comment as prose` uses unescaped
   * strings — and so did `cssParts`' brace skip, and so did the
   * already-a-`url()` arm of `urlTargets`' image-set loop, while the sibling
   * `cssNotProcessedRE` arm beside it reddened.
   */
  it('reads a stylesheet through every token and statement position it names', () => {
    const scanned = new Map<string, { atRoot: string; literals: string[] }>();
    const scan = (name: string, css: string): void => {
      const read = readCss(css);
      scanned.set(name, { atRoot: read.atRoot.trim(), literals: [...read.literals] });
    };
    scan('a comment, which is not a token', '@import /* x */ "a";');
    scan('a double-quoted string, which is opaque', '@import "a";');
    scan('a single-quoted string, which is opaque', "@import 'a';");
    scan('an escaped quote, which does not end the string', '@import "a\\"b";');
    scan('an escaped backslash, which does not escape the quote after it', '@import "a\\\\";');
    expect(scanned.size, 'the token list is empty; this assertion is vacuous').toBe(5);
    expect(
      Object.fromEntries([...scanned].map(([name, { literals }]) => [name, literals])),
      'a token position in the CSS scanner stopped being read. A string whose ' +
        'interior leaks into the statement text is a specifier this file can be ' +
        'shown, which is defect 6 rebuilt out of the fix for defect 6',
    ).toEqual({
      'a comment, which is not a token': ['a'],
      'a double-quoted string, which is opaque': ['a'],
      'a single-quoted string, which is opaque': ['a'],
      'an escaped quote, which does not end the string': ['a"b'],
      'an escaped backslash, which does not escape the quote after it': ['a\\'],
    });

    const parts = cssParts(
      readCss(
        '@charset "utf-8"; @import "base.css"; @media print { .a { color: red } }' +
          ' .b { background: url("x.png") } @supports (a: b) { .c { color: blue } }',
      ),
    );
    expect(
      parts.declarationValues.length,
      'a declaration value stopped reaching the reader postcss hands them to',
    ).toBe(3);
    expect(
      parts.declarationValues
        .map((value) => value.trim())
        .filter((value) => !value.includes('url(')),
      'and each one is the text after the first colon, block by block',
    ).toEqual(['red', 'blue']);
    expect(
      parts.elsewhere.filter((statement) => statement === '{' || statement === '}'),
      'the brace statements `readCss` leaves in `atRoot` to mark where a block ' +
        'started are being reported as text the bundler never reads. They are ' +
        'position markers for `importRules`, not statements',
    ).toEqual([]);
    expect(
      parts.elsewhere.some((statement) => statement.startsWith('@media')),
      'an at-rule prelude stopped being reported. A url() in one is dead text ' +
        'to the bundler and this file has to say so rather than follow it',
    ).toBe(true);
    expect(
      parts.elsewhere.some((statement) => /^@(?:import|charset)\b/i.test(statement)),
      '`@import` and `@charset` are owned by `importRules`, which reports them ' +
        'under the preamble rule; counting them here reddens base.css',
    ).toBe(false);

    const imageSet = readCss(
      '.a { background-image: image-set(url("/src/a.png") 1x, "/src/b.png" 2x,' +
        ' linear-gradient(red, blue) 3x) }',
    );
    expect(
      urlTargets(imageSet),
      'an image-set candidate that is already a url() must be taken once, by ' +
        'the url() loop, and a candidate vite’s own cssNotProcessedRE ' +
        'declines must not be taken at all',
    ).toEqual(['/src/a.png', '/src/b.png']);
    // The already-a-url() guard needs a token the ordinary spelling cannot
    // supply. `url("/src/a.png")` taken whole is a function call, so
    // `viteSkipsUrl` declines it a second time and deleting the guard changes
    // nothing — measured, green twice. Where the two differ is a candidate whose
    // `url(` is not at the head of the token: `VITE_FUNCTION_CALL_RE` is
    // anchored, so it does not match, and only the guard stands between this and
    // an edge invented out of a path the url() loop has already read. The guard
    // is vite's own `cssUrlRE.test(candidate) || cssNotProcessedRE.test(candidate)`
    // continue, transcribed, so agreeing with it here is the whole point.
    expect(
      urlTargets(readCss('.a { background-image: image-set(/src/a/url(b.png) 1x) }')),
      'a candidate carrying a url() the declaration loop has already taken is ' +
        'being taken a second time, as a path naming the candidate itself',
    ).toEqual(['./b.png']);
  }, BOUNDARY_BUDGET);

  /**
   * Every shape an edge can be in when the walk classifies it.
   *
   * `classifyEdges` was `walk`'s `record` closure, and one of its positions —
   * `requested === null` beside `resolved === null` — was held up by the type
   * checker and by nothing else: deleting it left the whole suite at 2432 green
   * and only `tsc --build --force` reddened. A position `tsc` happens to notice
   * is not a position this file asserts.
   */
  it('classifies every edge shape the walk can hand it', () => {
    const file = join(SRC_ROOT, 'main.tsx');
    const other = join(SRC_ROOT, 'runtime', 'run-doubles.ts');
    const edges: Edge[] = [
      { specifier: './lost', resolved: null, requested: null, lost: true },
      { specifier: 'react', resolved: null, requested: null, lost: false },
      { specifier: './main', resolved: file, requested: file, lost: false },
      { specifier: './Main', resolved: file, requested: join(SRC_ROOT, 'Main.tsx'), lost: false },
      { specifier: './half', resolved: other, requested: null, lost: false },
    ];
    const report = classifyEdges('probe', edges);
    expect(
      {
        unresolved: [...report.unresolved],
        miscased: [...report.miscased],
        reached: report.reached.map(asRepoPath),
      },
      'an edge shape stopped being classified the way this walk classifies it. ' +
        'An edge resolved to a file with no spelling beside it cannot be tested ' +
        'for casing — `requested` is the other half of that test — so it is ' +
        'neither reached nor reported as mis-cased',
    ).toEqual({
      unresolved: ['probe: ./lost'],
      miscased: ['probe: ./Main is on disk as src/main.tsx'],
      reached: ['src/main.tsx', 'src/main.tsx'],
    });
  }, BOUNDARY_BUDGET);

  /**
   * `vite-ignore` on the two kinds of tag the bundler reads it on, and on one it
   * does not.
   *
   * Round 6 tested the attribute ahead of the tag dispatch for every element and
   * said four times over that `getNodeAssetAttributes` does the same. It does
   * not: it opens with the row lookup and tests the attribute after it, so on a
   * tag with no row vite returns `[]` having read no attribute at all and having
   * left the marker in place. `<a href="/src/main.tsx" vite-ignore>` was
   * therefore reported as *the bundler is told to leave this tag alone, so
   * everything it names is out of the build* — a message about a build that had
   * done nothing of the kind. Measured against the installed vite@7.3.6: row
   * lookup at offset 57 of that function body, attribute test at offset 230.
   */
  it('honours vite-ignore where the bundler honours it, and reads a style attribute either way', () => {
    const honoured = new Map<string, boolean>([
      ['script', true],
      ['link', true],
      ['img', true],
      ['meta', true],
      ['a', false],
      ['div', false],
      ['style', false],
      ['template', false],
    ]);
    expect(honoured.size, 'the tag list is empty; this assertion is vacuous').toBe(8);
    const answered: Record<string, boolean> = {};
    const owed: Record<string, boolean> = {};
    for (const [tag, honours] of honoured) {
      answered[tag] = honoursViteIgnore(tag);
      owed[tag] = honours;
    }
    expect(
      answered,
      'a tag changed sides on whether `vite-ignore` does anything to it. The ' +
        'two sides are `getScriptInfo`, which reads it for every script, and ' +
        '`getNodeAssetAttributes`, which reads it only after finding a row',
    ).toEqual(owed);

    const textOf = (html: string): string[] =>
      htmlLoads(html).flatMap((load) => (load.kind === 'unread' ? [load.text] : []));
    expect(
      textOf('<a href="/src/main.tsx" vite-ignore>x</a>'),
      'a tag with no row and no script branch must be reported for the reason ' +
        'it is really unread — an attribute outside the table naming a file ' +
        'here — and not for a bundler decision that never happened',
    ).toEqual(['<a href="/src/main.tsx"> names a file this reader does not follow']);
    expect(
      textOf('<script type="module" src="/src/main.tsx" vite-ignore></script>').length,
      'the one script tag in this document, taken out of the build by one ' +
        'documented attribute, stopped being reported',
    ).toBe(1);
    expect(
      htmlLoads(
        '<img src="/src/main.tsx" vite-ignore style="background: url(\'/src/main.tsx\')" />',
      ).flatMap((load) => (load.kind === 'file' ? [load.specifier] : [])),
      'a style attribute is read whatever `getNodeAssetAttributes` returned ' +
        'for the tag: `findNeedTransformStyleAttribute` runs on every node and ' +
        'never looks at `vite-ignore`',
    ).toEqual(['/src/main.tsx']);
  }, BOUNDARY_BUDGET);

  /**
   * The three positions `insideThisRepo` decides, one recorded id each.
   *
   * All three deleted with the whole suite green, because a real build reports
   * no id of any of those shapes: every path it names is either under this repo
   * or comfortably outside it. A filter nothing supplies an input for is a
   * filter that is not being read.
   */
  it('reads a recorded id as a place in this repository, or as somewhere else', () => {
    const ids = new Map<string, string>([
      ['a module under src/', join(SRC_ROOT, 'main.tsx')],
      ['a dependency', join(REPO_ROOT, 'node_modules', 'react', 'index.js')],
      ['the repository root itself, which is a directory and not a file', REPO_ROOT],
      ['a path above the repository', resolve(REPO_ROOT, '..', 'elsewhere', 'x.ts')],
      // On Windows a path on another root has no relative spelling at all and
      // `relative` hands back the absolute path; on a single-rooted filesystem
      // the same input comes back as `../…`. Either way it is not in this repo,
      // and on this box it is the only input that reaches the `isAbsolute` arm.
      ['a path on another filesystem root', 'D:\\elsewhere\\x.ts'],
      ["a bundler's virtual module id", `${VIRTUAL_MODULE_ID}vite/preload-helper.js`],
      [
        "a bundler's virtual module id over a real dependency",
        `${VIRTUAL_MODULE_ID}${join(REPO_ROOT, 'node_modules', 'react', 'index.js')}?commonjs-module`,
      ],
    ]);
    expect(ids.size, 'the id list is empty; this assertion is vacuous').toBe(7);
    const placed: Record<string, string | null> = {};
    const owed: Record<string, string | null> = {
      'a module under src/': 'src/main.tsx',
      'a dependency': 'node_modules/react/index.js',
      'the repository root itself, which is a directory and not a file': null,
      'a path above the repository': null,
      'a path on another filesystem root': null,
      "a bundler's virtual module id": null,
      "a bundler's virtual module id over a real dependency": null,
    };
    for (const [name, id] of ids) {
      placed[name] = insideThisRepo([id])[0] ?? null;
    }
    expect(
      placed,
      'a recorded id shape stopped being placed. Anything this drops is a file ' +
        'the build read and no assertion in this file ever sees',
    ).toEqual(owed);
  }, BOUNDARY_BUDGET);

  /**
   * Both filters of the src/ narrowing, and the query suffix that got past one.
   *
   * Each filter was individually deletable with the whole suite green, and only
   * deleting both at once reddened anything — because both sides of the build
   * comparison ran the same predicate, so a kind it rejected was invisible in
   * both directions and their disagreement never appeared. Two branches, neither
   * pinned, under an assertion that appears to cover them and covers only the
   * case where both are gone.
   *
   * The query row is a real defect rather than a shape nobody writes:
   * `extname('embedded.css?raw')` is `.css?raw`, which is in no map, so the
   * rollup module id for `import x from './styles/embedded.css?raw'` was dropped
   * as an unshipped kind. It survived only because `getWatchFiles()` reports the
   * clean path beside it.
   */
  it('reads a build set as the src/ modules in it, whatever query an id carries', () => {
    const recorded = [
      'src/main.tsx',
      'src/styles/base.css',
      'src/styles/base.css?used',
      // The row that matters: a module the recorder reported *only* under a
      // query. With the suffix left on, `extname` answers `.ts?raw`, which is in
      // no map, and the module the build read disappears from this set.
      'src/runtime/run-doubles.ts?raw',
      'src/runtime/reachable.test.ts',
      'src/runtime/nothing.d.ts',
      'src/features/README.md',
      'index.html',
      'package.json',
      'tests/support/double.ts',
      'node_modules/react/index.js',
    ];
    expect(
      sourceKindPaths(recorded),
      'a kind or a place this narrowing decides stopped being decided. A test ' +
        'file, a declaration file, a kind the bundler has no loader for and a ' +
        'path outside src/ are each one row; a query-suffixed id is the same ' +
        'module as the id without it, and dropping it drops a module the build ' +
        'read',
    ).toEqual(['src/main.tsx', 'src/runtime/run-doubles.ts', 'src/styles/base.css']);
  }, BOUNDARY_BUDGET);

  /**
   * The marker five paragraphs of this file measure a shipped double by.
   *
   * Its validity condition is that it occurs in exactly one file under `src/`,
   * this file states that condition three times, one of those sentences names
   * the typographic convention that preserves it — and the same round wrote the
   * phrase unbroken into a docblock 1,500 lines away, so the condition was false
   * and nothing noticed. A convention held up by a habit in prose is the
   * canonical RULE V shape: the property the fix depends on, asserted by
   * nothing. The phrase is built from pieces here for the same reason the
   * docblocks break it across a line.
   */
  it('the marker that proves a double reached dist/ names exactly one file', () => {
    const marker = ['no turn has', 'been sent'].join(' ');
    const readable = new Set([...SHIPPING_EXTENSIONS.keys(), ...NOT_LOADED_EXTENSIONS.keys()]);
    const under = publicFiles(SRC_ROOT).filter((name) =>
      readable.has(extname(name).toLowerCase()),
    );
    expect(under.length, 'the sweep enumerated nothing; this assertion is vacuous').toBeGreaterThan(
      100,
    );
    expect(
      under.filter((name) => readFileSync(join(SRC_ROOT, name), 'utf8').includes(marker)).sort(),
      'the string this file measures a shipped double by is in more than one ' +
        'file under src/, or in none. Every paragraph that reports "the marker ' +
        'was in the entry chunk" is reporting something weaker than it says the ' +
        'moment a second file carries it',
    ).toEqual(['runtime/run-doubles.ts']);
  }, BOUNDARY_BUDGET);

  /**
   * The build script's argv, one row per flag spelling that can move the config.
   *
   * `package.json`'s `scripts` values were read by nothing at all, and
   * `packageJsonKeys` pins the manifest's key list rather than its contents, so
   * `scripts` was already on the list and changing a script's **value** was
   * invisible by construction.
   */
  it('reads a build script as the argv it is', () => {
    const readOf = (script: string): string =>
      commandSteps(script)
        .map(
          (step) =>
            `${step.command}(${selectedBy(step.args, CONFIG_SELECTING_FLAGS).join(',')}|` +
            `${selectedBy(step.args, ROOT_SELECTING_FLAGS).join(',')})`,
        )
        .join(' ');
    const scripts = new Map<string, string>([
      ['vite build', 'vite(|)'],
      ['tsc --build --force && vite build', 'tsc(|) vite(|)'],
      ['vite build --config other.ts', 'vite(other.ts|)'],
      ['vite build --config=other.ts', 'vite(other.ts|)'],
      ['vite build -c other.ts', 'vite(other.ts|)'],
      ['vite build -c=other.ts', 'vite(other.ts|)'],
      ['vite build --root packages/app', 'vite(|packages/app)'],
      ['vite build --root=packages/app', 'vite(|packages/app)'],
      ['vite build -r packages/app', 'vite(|packages/app)'],
      ['   ', ''],
    ]);
    expect(scripts.size, 'the argv list is empty; this assertion is vacuous').toBe(10);
    const read: Record<string, string> = {};
    const owed: Record<string, string> = {};
    for (const [script, shape] of scripts) {
      read[script] = readOf(script);
      owed[script] = shape;
    }
    expect(
      read,
      'a command-line spelling that points vite at a different config, or at a ' +
        'different root, stopped being read. Anything this misses is a config ' +
        'the shipping build loads and this file has never opened',
    ).toEqual(owed);
  }, BOUNDARY_BUDGET);

  /**
   * `pnpm build` and this file's recorder resolve the same config, the same way.
   *
   * The recorder used to name `vite.config.ts` outright, which is not what vite
   * does: `DEFAULT_CONFIG_FILES` ranks "vite.config.js" and "vite.config.mjs"
   * **ahead** of it, so adding a "vite.config.mjs" that imports the `.ts` one,
   * spreads it and appends a plugin left `vite build` at 222 modules against 220
   * with the double's bytes in the shipped entry chunk and this file green twice
   * — the recorder loading one config and the product built from another.
   * Dropping the name is half the fix; the other half is that the config vite
   * **found** is now recorded and compared against the file every AST assertion
   * here parses.
   *
   * That still leaves how the build is invoked, and nothing read it. A
   * "vite.config.prod.ts" named from `package.json`'s build script survives the
   * first half entirely: auto-discovery finds `vite.config.ts`, which is still
   * not the file `pnpm build` uses. So the script is read as an argv and held to
   * selecting neither a config nor a root.
   */
  it('the build script and the recorded build resolve the same config', () => {
    const script = packageScript('build');
    expect(script, 'package.json declares no build script for this to hold').not.toBe('');
    const steps = commandSteps(script);
    expect(
      steps.map((step) => step.command),
      'the build script runs a command this guard has not been told about. ' +
        'Every step is a chance to point vite somewhere else — a wrapper, an ' +
        'env shim, a second bundler — and none of them is visible in the config',
    ).toEqual(['tsc', 'vite']);
    const bundling = steps.filter((step) => step.command === 'vite' && step.args[0] === 'build');
    expect(bundling.length, 'no step of the build script runs `vite build`').toBe(1);
    for (const step of bundling) {
      expect(
        selectedBy(step.args, CONFIG_SELECTING_FLAGS),
        'the build script names a config file. Every AST assertion in this ' +
          'file reads vite.config.ts, and the shipping build would be reading ' +
          'this one instead',
      ).toEqual([]);
      expect(
        selectedBy(step.args, ROOT_SELECTING_FLAGS),
        'the build script moves vite’s root, so the config it discovers is not ' +
          'the one discovered from this repository root',
      ).toEqual([]);
    }
  }, BOUNDARY_BUDGET);

  /**
   * The recorded build is the build this repo ships, in the four ways it was not.
   *
   * `execFileSync` passed no `env`, so the child inherited vitest's — measured
   * directly by instrumenting this file's own `BUILD_PROGRAM`:
   * `VITEST="true"`, `NODE_ENV="test"`. Two adversaries landed the double's
   * bytes in the shipped entry chunk through one five-word conditional on each
   * of those variables, at 221 modules against 219, with this file green at
   * 48/48 twice; the ungated version of the same plugin reds three named
   * assertions, so the gate was the entire difference. And `resolved.isProduction`
   * is `(process.env.NODE_ENV || mode) === 'production'`, so the recorded build
   * had `import.meta.env.DEV` **true** — dev-only mock wiring was in this set and
   * absent from `dist/`, a false red on an ordinary idiom, and `import.meta.env.PROD`
   * code shipped while being absent here.
   *
   * Measured both ways on this tree: under the runner's environment
   * `isProduction` is `false` and `env.DEV` is `true`; with it scrubbed, `true`
   * and `false`. All four values are asserted, so the scrub cannot quietly stop
   * happening.
   */
  it('the recorded build is the build this repo ships', () => {
    expect(
      buildEnvironment({
        VITEST: 'true',
        VITEST_WORKER_ID: '1',
        VITEST_POOL_ID: '1',
        VITEST_MODE: 'run',
        NODE_ENV: 'test',
        PATH: 'kept',
      }),
      'a variable the runner sets survived into the environment the recorded ' +
        'build resolves its config in. A config is entitled to branch on any of ' +
        'them, and a plugin behind such a branch is a plugin this file records ' +
        'the absence of and the product ships',
    ).toEqual({ PATH: 'kept' });

    const facts = buildFacts();
    expect(
      facts.configFile,
      'the config vite found is not the config this file parses. Every claim ' +
        'here about plugins, aliases, keys and callees is a claim about a file ' +
        'the bundler did not load — vite ranks vite.config.js and ' +
        'vite.config.mjs ahead of the .ts one',
    ).toBe(VITE_CONFIG_PATH);
    expect(
      {
        vitest: facts.runnerVitest,
        nodeEnv: facts.runnerNodeEnv,
        isProduction: facts.isProduction,
        dev: facts.dev,
        prod: facts.prod,
      },
      'the recorded build resolved its config in an environment the shipping ' +
        'build does not have. Anything a config gates on these four values is ' +
        'recorded here and shipped there, or the reverse',
    ).toEqual({
      vitest: null,
      nodeEnv: 'production',
      isProduction: true,
      dev: false,
      prod: true,
    });
  }, BUILD_BUDGET);

  /**
   * Everything the build reads that is neither under `src/` nor a dependency.
   *
   * The universe of both instruments was `src/`, and nothing asserted the
   * universe. Two adversaries reached the same construction independently: a
   * scripted turn driver under `tests/support/`, imported by
   * `src/runtime/app-runtime.ts`, with the include `tsc`'s own TS6307 message
   * asks for added to `tsconfig.app.json` — `vite build` exit 0 at 220 modules
   * against 219, the double's class body in the shipped entry chunk, this file
   * green at 48/48 and the whole suite at 118/118. A second needed no TypeScript
   * at all: `@import '../../../tests/support/dev-overlay.css'` in a component
   * stylesheet put a rule from outside `src/` into the shipped CSS with the
   * module count unchanged. The repo already compiles TypeScript under `tests/`
   * and already has a tsconfig including such a directory beside `src`, so this
   * is a refactor a reviewer nods at.
   *
   * `PUBLIC_FILES` is the same pin over the other unwalked path into `dist/`,
   * and this is the third. A new entry reddens once and gets named.
   */
  it('names every file outside src/ the build reads', () => {
    const facts = buildFacts();
    expect(
      repoReadsOutsideSrc(facts),
      'the build read a file in this repository that is neither under src/ nor ' +
        'a dependency. Nothing under src/ governs it: `readBySourceKind` and ' +
        '`reachedBySourceKind` both drop it, and `shippingModules(SRC_ROOT)` ' +
        'never enumerated it, so the two-directional comparison agrees about it ' +
        'by being blind to it twice. Name it here, or take it out of the build',
    ).toEqual([...BUILD_READS_OUTSIDE_SRC]);
    expect(
      facts.read.some((path) => path.startsWith('node_modules/')),
      'the recorded set contains no dependency at all, so the filter above is ' +
        'not narrowing anything and this assertion is vacuous',
    ).toBe(true);
  }, BUILD_BUDGET);

  /**
   * One `vite build` per run, counted rather than described.
   *
   * The count is taken after this assertion's own call, so it holds whether the
   * seven assertions above that read the build ran or a `-t` filter skipped
   * them: the first call is the one that pays, and every later one is free.
   */
  it('runs one build for the whole file, however many assertions read it', () => {
    buildFacts();
    expect(
      BUILDS_RECORDED,
      'more than one child `vite build` ran in this file. The memo is what ' +
        'keeps seven readers from costing seven bundles, and removing it was ' +
        'exit 0 twice with nothing but the clock to notice',
    ).toBe(1);
    const paid = BUILDS_RECORDED;
    buildFacts();
    buildFacts();
    expect(
      BUILDS_RECORDED - paid,
      'a second reader of the recorded build ran the build again',
    ).toBe(0);
  }, BUILD_BUDGET);
});
