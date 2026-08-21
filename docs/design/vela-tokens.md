# Vela — the frozen design tokens

**This file is a locked contract.** Recorded at HEAD `84dbfc2` from source and from the running
window, on 2026-08-15.

## The rule

Vela's colours are final. Whatever the app painted on the day this was written is correct.

- **No builder may introduce a colour value that is not in this file.** A surface needing one files
  a token-amendment request; the lead decides; the amendment is recorded here. A silent addition is
  a FAIL, and a colour-fidelity critic runs on every UI track to catch one.
- **Vela does not adopt any other assistant product's palette.** No cream or off-white canvases, no
  clay or terracotta accents. `src/styles/tokens.css:12-15` has said so since before this freeze,
  and a repo-wide sweep for those values at HEAD found **zero** hits outside that prohibition.
- Everything else in the design language — layout, information architecture, typographic rhythm,
  spacing, motion, interaction — is changing to match a measured reference. **Colour is the one axis
  where Vela stays itself.**

## Identity, in the words already in the tree

> Vela is the constellation of the Sails. The palette is night-sky indigo with a cyan-teal "signal"
> accent and a warm amber highlight. It is deliberately unlike any other assistant product's trade
> dress.
> — `src/styles/tokens.css:12-15`

## How this was recorded

Three extractors ran in parallel. The declared values were resolved **mechanically** — a script
sliced the sheet into the three blocks the way the engine cascades them (light `:root`, then
`@media (prefers-color-scheme: dark) :root:not([data-theme='light'])`, then `:root[data-theme='dark']`)
and substituted `var()` down to a terminal value — so every resolved hex here is computed, not
transcribed. Usage was established by `git grep` of each name across `src/`, counting `var()`
references separately from definition sites. The painted values were read from the live window over
CDP with `getComputedStyle` on real elements. 441 values across 63 groups.

---


## Typefaces shipped — the headline nuance

| token / role | value | note |
|---|---|---|
| `Font files tracked in git` | `ZERO` | `git ls-files` filtered for .woff2/.woff/.ttf/.otf/.eot returns nothing at HEAD. The repository contains no font bytes. This is not a contradiction of 'Vela bundles its typeface' but it is the load-bearing detail: the faces are npm dependencies, not vendored assets, and a fresh clone without `pnpm install` has no typeface at all. |
| `Where the faces actually come from` | `@fontsource-variable/inter ^5.3.0, @fontsource-variable/jetbrains-mono ^5.3.0` | Both are runtime `dependencies` (not devDependencies) in package.json. node_modules/ is gitignored, as is dist/. src/styles/typeface.css `url()`s directly into ../../node_modules/...; Vite resolves and emits them into dist/assets/ at build time and Tauri serves them from the app bundle. |
| `Bundled vs system font — still true` | `CONFIRMED bundled` | Confirmed three independent ways, none of which is document.fonts.check (typeface.css and the harness both explicitly forbid it — it returns true for a font the engine cannot draw, which is how this defect hid through Phases A–C). |
| `Confirmation 1 — static chain of custody` | `src/styles/typeface.test.ts` | Walks the transitive @import closure from src/main.tsx (main.tsx:5 → base.css:11 @import './typeface.css', base.css:12 @import './tokens.css'), then asserts: the family each stack names first is declared by a reachable @font-face; every src resolves to a file that exists in this checkout; no url is remote; and no @import of a remote stylesheet exists. Runs in CI on every push. |
| `Confirmation 2 — runtime advance-width probe` | `tests/harness/production-bundle/drive-app-root.mjs, P17–P20` | Renders a probe string against a deliberately absent family and compares advance widths in a real engine, over the built dist/. Gate script, not part of `pnpm verify` (needs Playwright + a built dist/). |
| `Confirmation 3 — recorded WebView2 measurement` | `appBody 560.09px vs absent-control 481.72px vs Segoe UI 523.91px` | docs/desktop-gate/evidence/CONV-1-retest/typeface-verification.txt, real WebView2 151.0.4129.78 on Windows 11 26200. Mono: 614.41px vs 481.72px control. Bare 'Inter' and bare 'JetBrains Mono' both measure exactly the absent-control 481.72 — i.e. the machine has neither installed — so the app body rendering at 560.09 can only be the bundled 'Inter Variable'. document.fonts.size = 4. |

## The four font files (family, cut, bytes)

| token / role | value | note |
|---|---|---|
| `Inter Variable — normal` | `48,256 B (47.1 KiB)` | node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2. font-weight: 100 900, font-style: normal, format woff2-variations. Declared at src/styles/typeface.css:74-83. |
| `Inter Variable — italic` | `51,832 B (50.6 KiB)` | inter-latin-wght-italic.woff2. font-weight: 100 900, font-style: italic. Declared at src/styles/typeface.css:85-94. A real italic cut, not a synthesised oblique — markdown emphasis and code comments both ask for it. |
| `JetBrains Mono Variable — normal` | `40,404 B (39.5 KiB)` | jetbrains-mono-latin-wght-normal.woff2. font-weight: 100 800, font-style: normal. Declared at src/styles/typeface.css:98-107. |
| `JetBrains Mono Variable — italic` | `42,964 B (42.0 KiB)` | jetbrains-mono-latin-wght-italic.woff2. font-weight: 100 800, font-style: italic. Declared at src/styles/typeface.css:109-118. |
| `Total font payload` | `183,456 B = 179.2 KiB across 4 files` | Matches the '179 KiB total' claim in the typeface.css header exactly. Latin subset only; each rule carries the upstream package's own unicode-range (U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD), so a Cyrillic or Greek codepoint degrades to the platform font by design. |
| `Weight coverage` | `one variable face per style covers the whole axis` | --vela-weight-regular 400 / medium 500 / semibold 600 / bold 700 are all real cuts on the 100–900 (Inter) and 100–800 (JetBrains Mono) axes — no synthetic emboldening. typeface.test.ts derives the required weights from the --vela-weight-* tokens themselves and fails on any uncovered one. |
| `Weight budget ceiling` | `< 256 KiB, asserted` | typeface.test.ts 'the weight budget stays sane' stats every resolved @font-face file and fails above 256 KiB. Guards against the cheap wrong fix of @import-ing a package's top-level stylesheet, which would drag cyrillic/greek/vietnamese/latin-ext subsets into the bundle. |
| `font-display` | `block (all four faces)` | Deliberate, not an oversight — documented in typeface.css: there is no network round trip (local disk, single-digit ms decode), so `swap` buys nothing and costs a visible Segoe-UI-to-Inter reflow on every cold start. |

## Fallback stacks (what happens when a face is missing)

| token / role | value | note |
|---|---|---|
| `--vela-font-sans` | `'Inter Variable', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, 'Helvetica Neue', sans-serif` | tokens.css. Yes, there is a full fallback stack. Entry 2 is the same family as a user may have installed system-wide; everything after is the platform's, reached only for codepoints outside the bundled Latin subset. |
| `--vela-font-mono` | `'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace` | tokens.css. Same shape. |
| `Does anything test the bundled face is used, not silently fallen back to?` | `YES — and the runtime width control still exists at HEAD` | This is the earlier verdict's control and it is intact. measureTypeface() in tests/harness/production-bundle/drive-app-root.mjs renders a probe string in (1) a deliberately absent family — the control, (2) the family the stack names first, (3) the stack as the app actually applies it, and compares advance widths. |
| `P17a / P18a` | `requested face must differ from absent-font control by > 1px` | 'WIDTH CONTROL, not document.fonts.check' is in the assertion label itself. Failure message prints what document.fonts.check said alongside, annotated 'which is not evidence'. |
| `P17b / P18b` | `applied width must equal requested width within 0.5px` | Proves the stack as applied resolves to the leading face rather than falling through to entry 2 or the platform font. |
| `P17c / P18c` | `italic must be a real cut in the document font set` | Deliberately NOT a width assertion — a monospaced italic carries the roman's advances by definition, and Inter's ~6px delta over a 2009px string is a 0.3% margin, a rasterisation rounding from a coin flip. Settled instead by @font-face italic entry present + status 'loaded'; width delta reported as corroboration only. |
| `P19a` | `sans and mono applied widths must differ by > 1px` | Catches one stack shadowing the other. |
| `P19b` | `every font byte came from the page origin` | Offline-first. Watches both an in-page trap and Playwright's own request event, because an in-page trap can be bypassed by a fresh iframe fetch, an img.src or a <link>. |
| `P20` | `reading measure sets 65–75 chars/line in the face that now renders` | Measured 68.3 cpl (480px column ÷ 7.029px mean advance) in Inter. Computed as column ÷ mean advance, not characters ÷ line boxes, the latter being biased ~8% by every paragraph's partial last line. |
| `Negative controls on the probe` | `K6a–K6d, K7, K8a–K8c` | The controls are what make P17/P18 evidence rather than a tautology. K6a: a second definitely-absent family must measure exactly the control. K6c: with every @font-face stripped from the real bundle, P17a/P18a must FAIL. K6d: characters-per-line moves when the face does (64.2 in the platform fallback). K7: the old 46rem token reads 104.7 cpl, reproducing the operator's original ~95–105 complaint from a different engine. K8a–K8c: with italic faces stripped, P17c/P18c FAIL and the sans italic width delta collapses to exactly zero (the signature of a sheared roman) while P17a/P18a still PASS. |
| `CI-time vs gate-time split` | `typeface.test.ts runs on every push; P17–P20 is a gate script` | Stated honestly in typeface.test.ts's own header: 'A regression that this file passes and the width probe catches is possible. A regression that neither catches is the one that already happened.' |

## Motion — the tokens

| token / role | value | note |
|---|---|---|
| `--vela-duration` | `140ms` | tokens.css. The single duration for the whole app. |
| `--vela-ease` | `cubic-bezier(0.2, 0, 0.1, 1)` | tokens.css. The single easing curve. |
| `Enforcement that components cannot hand-write motion` | `design-system.test.ts 'motion has one duration and one easing curve'` | Fails on any transition/transition-duration/transition-timing-function carrying a literal number+s/ms, and on any animation with an inline cubic-bezier() or a non-var animation-timing-function. The stated reason is exactly the reduced-motion posture: 'prefers-reduced-motion is honoured globally in base.css by overriding *these*; a hand-written duration escapes that.' Scans *.module.css only. |

## Motion — every transition in src/

| token / role | value | note |
|---|---|---|
| `TitleBar.module.css:71` | `color 140ms + border-color 140ms, --vela-ease` | Toolbar .action hover. |
| `TitleBar.module.css:118` | `background-color 140ms + color 140ms, --vela-ease` | Window caption buttons. |
| `AttachmentControls.module.css:32` | `color 140ms, --vela-ease` |  |
| `Composer.module.css:52` | `border-color 140ms, --vela-ease` | .field focus-within border to --vela-accent. |
| `Composer.module.css:106` | `background-color 140ms + color 140ms, --vela-ease` | The send button. |
| `CopyButton.module.css:12` | `color + border-color + background-color, each 140ms, --vela-ease` | Three properties. |
| `MessageTurn.module.css:182` | `opacity 140ms, --vela-ease` |  |
| `ThinkingBlock.module.css:47` | `transform 140ms, --vela-ease` | Disclosure chevron rotation. |
| `ToolCallList.module.css:106` | `transform 140ms, --vela-ease` | Disclosure chevron rotation. |
| `ContextMeter.module.css:20` | `width 140ms, --vela-ease` | The meter fill. |
| `ModelSwitcher.module.css:20` | `background 140ms, --vela-ease` |  |
| `ConversationRow.module.css:68` | `opacity 140ms, --vela-ease` | Row actions fading in on hover/focus-within. Never display:none, so they stay in the accessibility tree. |
| `Sidebar.module.css:220` | `opacity 140ms, --vela-ease` |  |
| `Total` | `13 transition declarations, 100% on --vela-duration + --vela-ease` | Not one hand-written duration or curve anywhere in src/. |

## Motion — every @keyframes and animation in src/

| token / role | value | note |
|---|---|---|
| `caret — Markdown.module.css:254 / @keyframes 257` | `1.1s steps(2, start) infinite` | The streaming caret on the last paragraph. 0%,50% opacity 1 → 50.01%,100% opacity 0. NOTE: `steps(2, start)` is a hand-written timing function on the animation shorthand — it is not --vela-ease. It is not caught by the design-system guard, whose animation pattern only matches an inline `cubic-bezier(` or a non-var `animation-timing-function:`. A blink is arguably the one animation that must be stepped rather than eased, so this reads as deliberate, but it is the single motion value in src/ living outside the token. |
| `bounce — MessageTurn.module.css:77 / @keyframes 88` | `1.1s var(--vela-ease) infinite` | The three typing dots. 0%,60%,100% opacity 0.3 → 30% opacity 1. Staggered by animation-delay 0.15s (:nth-child(2), line 81) and 0.3s (:nth-child(3), line 85) — two more hand-written time values, again untokenised, again not caught by the guard (it matches `transition…`, not `animation-delay`). |
| `pulse — ThinkingBlock.module.css:65 / @keyframes 68` | `1.4s var(--vela-ease) infinite` | The thinking indicator dot. 0%,100% opacity 0.35 → 50% opacity 1. |
| `pulse — ToolCallList.module.css:162 / @keyframes 165` | `1.4s var(--vela-ease) infinite` | Byte-identical keyframe body and timing to ThinkingBlock's. Two independent definitions of the same animation in two files — the exact drift shape design-system.test.ts exists to catch, but its guards cover durations and easings, not duplicated @keyframes bodies. Low severity (they currently agree) but they can part company silently. |
| `JS-driven motion` | `NONE` | No Web Animations API .animate(), no scroll-behavior: smooth, no scrollIntoView({behavior:'smooth'}), no animation library. The only requestAnimationFrame hits (use-conversation.ts:153, 207) schedule a scroll position, not an animation. So nothing escapes the CSS-level reduced-motion override by living in JS. |

## Reduced-motion posture — NO GAP FOUND

| token / role | value | note |
|---|---|---|
| `Global override` | `src/styles/base.css:130-138` | @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; } } — the universal selector plus both pseudo-elements, with !important. This alone covers all 13 transitions and all 4 animations. |
| `Per-component block 1` | `Markdown.module.css:268-273` | Streaming caret: animation: none; opacity: 0.6 — degrades to a static visible caret rather than vanishing. |
| `Per-component block 2` | `MessageTurn.module.css:99-104` | Typing dots: animation: none; opacity: 0.6. |
| `Per-component block 3` | `ThinkingBlock.module.css:78-82` | Pulse: animation: none. |
| `Per-component block 4` | `ToolCallList.module.css:175-179` | Pulse: animation: none. |
| `Animations NOT covered by a reduced-motion rule` | `NONE — zero gaps` | This is the direct answer to the brief. All 4 keyframe animations are covered TWICE: once by the base.css universal block and again by a per-component block that sets animation:none and restores a sensible static appearance. All 13 transitions are covered by the base.css block. The per-component blocks are the better implementation — 0.01ms still runs the animation, whereas animation:none plus a chosen resting opacity gives a deliberate static state rather than whatever frame 0 happens to be. Nothing in src/ animates outside that coverage. |
| `Residual weakness (not a coverage gap)` | `coverage depends on the token discipline holding` | The global override works by shortening durations, so it neutralises a transition only because every duration is a var(). design-system.test.ts is what keeps that true. The three untokenised time values noted above — steps(2,start), and the 0.15s/0.3s animation-delays — are unaffected in practice (animation:none wins in both per-component blocks) but they are outside the guard, so a future hand-written animation-duration in a component with no per-component block would be caught by neither the guard nor a reviewer. |

## Forced-colors posture — CONFIRMED ZERO at HEAD 84dbfc2

| token / role | value | note |
|---|---|---|
| `Rule count in src/ and src-tauri/` | `0` | `git grep -icE 'forced-colors\|-ms-high-contrast' -- src src-tauri` exits 1 with no matches. Also zero `forced-color-adjust`. The audit's count is reproduced exactly at HEAD. Every textual hit in the repo is in docs/ (docs/audit/REPORT.md:188,193; docs/audit/shell.md:539-556; docs/vela-plan-2026-08-15.md:789-793,1524) — i.e. the finding is documented and unfixed. |
| `Tests exercising forced-colors` | `0` | No test in the suite emulates forced-colors: active. Nothing would fail if the posture got worse. |
| `LOSS 1 — selected conversation` | `ConversationRow.module.css:12-15 and :38-40` | The audit's cited case, confirmed verbatim. `.selected, .selected:hover { background: var(--vela-row-selected); }` and `.selected .main { color: var(--vela-row-selected-text); }`. Background and text colour are the ONLY cues — no border, no font-weight change, no marker glyph. forced-colors strips both. aria-current='page' (ConversationRow.tsx:150) tells assistive technology; a sighted High Contrast user is told nothing about which conversation they are in. |
| `LOSS 2 — command palette active row (NOT in the original audit)` | `CommandPalette.module.css:74-75 and :88-89` | Same defect shape, and arguably more severe: `.active { background: var(--vela-row-selected); }` plus `.active .rowTitle { color: var(--vela-row-selected-text); }`. This is the keyboard-navigation highlight that moves with the arrow keys — under forced-colors the user loses the cursor in the palette entirely, with no way to tell what Enter will select. The audit named only ConversationRow; this one shares the tokens and the failure and should be recorded alongside it. |
| `LOSS 3 — canvas tab selection (NOT in the original audit)` | `CanvasPanel.module.css:80-83` | `.tab[aria-selected='true'] { background: var(--vela-accent-quiet); color: var(--vela-accent); }` on a `border: 0` tab. Background + colour only; both stripped. aria-selected carries it for AT, not for a sighted High Contrast user. |
| `LOSS 4 — hover affordance across the app` | `--vela-row-selected: rgb(20 168 158 / 16%), --vela-row-hover: rgb(16 20 38 / 5%) and rgb(255 255 255 / 6%)` | The state colours are alpha washes over the ground. Under forced-colors these flatten to the system Canvas colour, so hover feedback disappears everywhere it is the only cue. Lower severity than the selection cases (hover is transient) but same root cause. |
| `SURVIVES — floating surfaces keep their edge` | `every popover/dialog pairs box-shadow with a 1px border` | Good news worth recording, because forced-colors removes box-shadow entirely. Composer.module.css:48-51, MemoryPanel:25-27, ModelSwitcher:45-48, CommandPalette:23-25, DeleteConversationDialog:21-23 all declare `border: 1px solid var(--vela-border...)` alongside the shadow. No surface depends on elevation alone to separate from the page. |
| `SURVIVES — user vs assistant turn attribution` | `MessageTurn.module.css:42-47` | The user turn carries `border: 1px solid var(--vela-turn-user-border)` as well as its background, plus a narrower max-width and opposite alignment. Three cues, at least two of which survive forced-colors. |
| `SURVIVES — context meter severity` | `ContextMeter.module.css:36-45 + ContextMeter.tsx:85-96` | The fill ramps accent → warning → danger by colour, but the component also renders a word readout naming the 'tight'/'over' verdict in text, and the track carries role='meter' with aria-valuetext. Colour is not the only cue. |
| `SURVIVES — focus rings` | `--vela-focus-ring: 2px solid var(--vela-focus)` | Drawn with `outline`, which forced-colors preserves (repainting it in the system Highlight colour). design-system.test.ts forces every component to use the token, so this holds uniformly. |
| `DEGRADES ACCEPTABLY — code syntax colours` | `--vela-syntax-comment/string/number/keyword/punct` | Syntax highlighting is colour-only by nature and collapses to a single forced text colour. Standard and expected; not a finding. |

## Icon and image assets

| token / role | value | note |
|---|---|---|
| `Raster or SVG asset files under src/` | `ZERO` | No .svg, .png, .jpg, .gif, .webp or .ico is tracked anywhere under src/. No `<img>` pointing at a bundled asset, no `background-image`, and the only url() in any stylesheet is the four @font-face srcs. Nothing to theme, nothing to go stale. |
| `All chrome iconography` | `inline JSX <svg>, currentColor throughout` | 14 files draw inline SVG. Across all non-test .tsx the complete set of paint values is: stroke="currentColor" ×21, fill="none" ×14, fill="currentColor" ×6. Not one hardcoded hex, rgb() or named colour in any shipped icon — every glyph inherits its colour from the token-driven text colour of its container and therefore follows the theme automatically. |
| `VelaMark` | `src/components/VelaMark.tsx, 24×24 viewBox, currentColor` | Vela's own identity mark — a sail under two stars. Its header states it is drawn inline so it inherits currentColor and needs no asset request under the strict CSP, and that it 'must not be replaced with, or drawn to resemble, any other product's mark'. Correct role handling: role='presentation' + aria-hidden when untitled, role='img' + aria-label + <title> when titled, focusable='false'. |
| `fill="red" — 7 hits, all benign` | `test fixtures only` | Worth stating explicitly since a repo-wide colour sweep will surface them. All 7 are inside string literals in canvas-wiring.test.tsx:32,102 and CanvasPanel.test.tsx:26,27,66,96,107 — SVG documents standing in for model-generated artifacts rendered into a sandboxed iframe. They are test input, not shipped chrome, and they are not Vela painting a colour. |
| `Shipped binary images — the ONLY ones` | `5 Tauri app icons under src-tauri/icons/` | 32x32.png (407 B), 128x128.png (960 B), 128x128@2x.png (1,861 B), icon.png (512×512, 3,854 B), icon.ico (5,275 B). Referenced from tauri.conf.json:45-50 (the .ico is used by the Windows bundler, not listed there). |
| `App icon accent — baked in` | `#5FE2D6` | Dominant non-background colour in all three PNGs I sampled (7,937 of the sampled pixels in icon.png). This is EXACTLY --vela-signal-300 from tokens.css. On-palette, so it does not violate the identity — but it is a frozen literal living outside the token sheet. |
| `App icon ground — baked in` | `~#111529 – #1B2140 (indigo gradient)` | Sampled range across the three PNGs: #111529, #12162B, #13172D, #141930, #151A32, #161B34, #191F3C, #1A203E, #1B2140. Sits between --vela-night-900 (#101426) and --vela-night-700 (#262c42) — a night-sky indigo gradient consistent with the identity, but no single value in it is a token. |
| `Do the icons follow the theme?` | `NO — and correctly so` | The answer to the brief's question. These are static rasters with a permanently dark ground, used unchanged in light theme, dark theme, the Windows taskbar and the installer. That is the right behaviour for an OS application icon (a themed app icon is not a thing Windows offers), so it is not a defect — but it IS the one place where Vela's frozen colours exist as pixels rather than as tokens. |
| `Enforcement gap on the icons` | `nothing checks the icon PNGs against the palette` | The colour guard in design-system.test.ts scans *.module.css only; contrast.test.ts resolves the token graph. Neither can see a PNG. If the freeze is to be enforceable against rendered pixels, the app icons are a blind spot: their #5FE2D6 and their indigo ground could drift off-palette in a redraw and no test in the tree would notice. |
| `User-content images` | `AttachmentTray.tsx:43` | The single <img> in shipped code renders a user-supplied attachment preview from a blob:/data: URL, with a text alt. User content, not chrome, and it carries no Vela colour. CSP permits it: tauri.conf.json:30 declares img-src 'self' data: blob:. |

## The colour-freeze enforcement surface (what makes the rule enforceable)

| token / role | value | note |
|---|---|---|
| `Raw colour ban` | `design-system.test.ts 'no component writes a raw colour'` | Fails on any /#[0-9a-fA-F]{3,8}\b\|\brgba?\(/ in any *.module.css. Verified holding at HEAD: `git grep -nE '#[0-9a-fA-F]{3,8}\b\|\brgba?\(' -- 'src/**/*.module.css'` returns zero. This is the primary instrument for the freeze. |
| `Scope limit of that ban` | `*.module.css ONLY` | Important for a critic. moduleStylesheets() recurses src/ collecting only files ending .module.css, so base.css, tokens.css and typeface.css are all outside it. tokens.css is exempt by design (it is where colour lives) and typeface.css likewise. base.css is NOT exempt by design — it is simply unscanned by this test. I checked it directly: base.css currently contains zero raw hex or rgb(). typeface.test.ts partially plugs this hole ('the global sheets read type from the tokens too') but that scan covers line-height/font-size/letter-spacing/font-family/font-weight only — NOT colour. A hex code added to base.css today would be caught by no test. |
| `Dangling-token guard` | `design-system.test.ts 'every token a component reads is one the token sheet defines'` | Catches a rename: var(--vela-gone) resolves to nothing and CSS drops the declaration silently, so a component loses a colour with nothing throwing. Essential under a freeze, since amendments will rename things. |
| `Light-first structural rule` | `design-system.test.ts 'every colour token is defined in the light block before either dark block'` | Enforces the tokens.css header rule 3. A token defined only under prefers-color-scheme: dark is invisible in light mode and invisible to the suite too. |
| `Contrast completeness` | `src/styles/contrast.test.ts` | The strongest lever for the freeze. Resolves the token graph to sRGB the way the engine does (light declarations, then dark on top), composites translucent fills over their actual stack, and applies WCAG 2.2 AA. Its 'every colour role is audited' assertion means a colour role absent from the table FAILS THE SUITE — per its header, 'There is no way to add a colour to this app and not audit it.' That is exactly the mechanism a token-amendment process needs. |
| `Assembled-surface check` | `src/styles/surfaces.test.ts` | Asks whether token values survive assembly — in both themes and at more than one window width. Catches a surface that equals its ground (--vela-thinking-bg once equalled --vela-bg in light; --vela-code-bg equalled --vela-bg in dark: a panel with a border that painted nothing). |
| `UA-paint consistency` | `src/styles/platform-defaults.test.ts` | Walks all six states (three theme states × two OS preferences) and fails if color-scheme and the palette ever part company — the defect where a data-theme='dark' user on a light OS got Vela's dark palette with Windows' white legacy scrollbar down the side of it. |
| `What the enforcement surface does NOT cover` | `forced-colors, icon pixels, base.css colour` | Three named blind spots, in rough severity order: (1) nothing tests forced-colors, and three selection cues are colour-only; (2) nothing checks the app icon PNGs against the palette; (3) the raw-colour ban does not scan base.css. |

## Brand ramp — teal-cyan "signal" (theme-independent; defined once in light, never overridden)

| token / role | value | note |
|---|---|---|
| `--vela-signal-50` | `#e6fbf8` | Referenced by --vela-accent-quiet (light) and --vela-row-selected (light). |
| `--vela-signal-100` | `#c2f4ee` | UNUSED. Zero references anywhere in src/, including inside tokens.css. |
| `--vela-signal-200` | `#8ce8df` | Referenced by --vela-accent-hover (dark), --vela-row-selected-text (dark), --vela-syntax-string (both themes). |
| `--vela-signal-300` | `#5fe2d6` | Referenced by --vela-accent (dark), --vela-focus (dark), --vela-syntax-keyword (both themes). |
| `--vela-signal-400` | `#2ec9bd` | UNUSED. Zero references anywhere in src/. |
| `--vela-signal-500` | `#14a89e` | UNUSED as a token, but its VALUE is painted: --vela-row-selected in both dark blocks is the literal rgb(20 168 158 / 16%), which is exactly #14a89e at 16%. A hardcoded duplicate of a rung nothing references. |
| `--vela-signal-600` | `#0d857f` | Referenced by --vela-focus (light) only. Comment at tokens.css:99-101 explains 700 was not used here because a focus ring needs 3:1 per WCAG 1.4.11 and signal-500 gave 2.59:1 on the chrome. |
| `--vela-signal-700` | `#0b6864` | Referenced by --vela-accent (light) and --vela-row-selected-text (light). Comment at tokens.css:93-95: chosen over 600 because it is read both as text on a light page (5.8:1 vs 3.9:1) and as a fill under --vela-text-on-accent (6.6:1). |
| `--vela-signal-800` | `#0a4f4d` | Referenced by --vela-accent-hover (light). |
| `--vela-signal-900` | `#073836` | Referenced by --vela-accent-quiet (dark). |

## Neutral ramp — night-sky indigo (theme-independent; every rung is referenced by at least one semantic role)

| token / role | value | note |
|---|---|---|
| `--vela-night-0` | `#ffffff` | --vela-surface, --vela-surface-raised, --vela-text-on-accent, --vela-text-on-danger, all light only. |
| `--vela-night-25` | `#f7f8fb` | --vela-bg (light) only. |
| `--vela-night-50` | `#eef0f6` | --vela-bg-inset, --vela-chrome, --vela-turn-user-bg, --vela-thinking-bg, --vela-notice-bg (light); --vela-text (dark). |
| `--vela-night-100` | `#e0e3ed` | --vela-border, --vela-turn-user-border, --vela-turn-rule, --vela-thinking-border (light); --vela-code-text (both themes). |
| `--vela-night-200` | `#c7ccdc` | --vela-border-strong (light) only. The ramp's least-used rung but not dead. |
| `--vela-night-300` | `#9aa2bd` | --vela-syntax-punct (both); --vela-text-muted, --vela-scrollbar-thumb-hover, --vela-thinking-text (dark). |
| `--vela-night-350` | `#868fac` | Half-step. --vela-text-subtle (dark) and --vela-syntax-comment (BOTH themes). Comment at tokens.css:389-391: 350 not 400 because a code block is dark in light mode too, and night-400 measured 3.74:1 on the language bar. |
| `--vela-night-400` | `#6f7896` | --vela-scrollbar-thumb, deliberately the SAME value in both themes (tokens.css:128-130): the one rung clearing 3:1 against every ground a scroller sits on in either theme. This is also the value --vela-text-subtle used to be in both themes — the briefed defect. |
| `--vela-night-450` | `#5b6280` | Half-step. --vela-text-subtle (light) only. Exists because the ramp had no rung clearing 4.5:1 for a quiet text role — tokens.css:31-35. |
| `--vela-night-500` | `#4d5675` | --vela-text-muted, --vela-scrollbar-thumb-hover, --vela-thinking-text (light). |
| `--vela-night-600` | `#363e59` | --vela-border-strong (dark). |
| `--vela-night-700` | `#262c42` | --vela-border, --vela-turn-user-border, --vela-code-border, --vela-thinking-border (dark). |
| `--vela-night-800` | `#1a1f31` | --vela-code-border (light); --vela-surface-raised, --vela-turn-user-bg, --vela-turn-rule, --vela-code-surface, --vela-notice-bg (dark). |
| `--vela-night-900` | `#101426` | --vela-text, --vela-code-surface (light); --vela-bg-inset, --vela-surface, --vela-chrome, --vela-code-bg, --vela-thinking-bg (dark). |
| `--vela-night-950` | `#080b16` | --vela-code-bg (light); --vela-bg, --vela-text-on-accent, --vela-text-on-danger (dark). |

## Status hues (theme-independent rungs; each carries a 400 for dark grounds and a 700 for light)

| token / role | value | note |
|---|---|---|
| `--vela-amber-400` | `#f0b429` | --vela-warning (dark), --vela-syntax-number (both themes). |
| `--vela-amber-600` | `#b7791f` | UNUSED. Zero references. Comment at tokens.css:53-57 claims the 600s are "kept because both dark fills and the light *fills* still read them" — that claim is false as of this HEAD; nothing reads it. |
| `--vela-amber-700` | `#975a16` | --vela-warning (light). Replaced amber-600, which measured 3.20:1 on the light page. |
| `--vela-rose-400` | `#f2668b` | --vela-danger (dark). |
| `--vela-rose-600` | `#c33c62` | UNUSED. Zero references. |
| `--vela-rose-700` | `#a93253` | --vela-danger (light). |
| `--vela-mint-400` | `#45cf88` | --vela-success (dark). |
| `--vela-mint-600` | `#1f9a5c` | UNUSED. Zero references. Measured 3.16:1 on the light page before replacement. |
| `--vela-mint-700` | `#16794a` | --vela-success (light). |

## Semantic — grounds and borders (light value → dark value; both dark blocks identical)

| token / role | value | note |
|---|---|---|
| `--vela-bg` | `night-25 #f7f8fb → night-950 #080b16` | The page. |
| `--vela-bg-inset` | `night-50 #eef0f6 → night-900 #101426` | An inset well. |
| `--vela-surface` | `night-0 #ffffff → night-900 #101426` | A card. |
| `--vela-surface-raised` | `night-0 #ffffff → night-800 #1a1f31` | A popover. Identical to --vela-surface in light, one step up in dark. |
| `--vela-chrome` | `night-50 #eef0f6 → night-900 #101426` | Sidebar, title bar, status bar, model bar. |
| `--vela-border` | `night-100 #e0e3ed → night-700 #262c42` | Hairline separator. Exempt from the contrast table as a text ground (surfaces.test.ts proves each surface is visible without it). |
| `--vela-border-strong` | `night-200 #c7ccdc → night-600 #363e59` |  |

## Semantic — text roles (light → dark)

| token / role | value | note |
|---|---|---|
| `--vela-text` | `night-900 #101426 → night-50 #eef0f6` | Most-referenced colour role in the tree (66 var() refs in component CSS). |
| `--vela-text-muted` | `night-500 #4d5675 → night-300 #9aa2bd` |  |
| `--vela-text-subtle` | `night-450 #5b6280 → night-350 #868fac` | The quiet role — composer placeholder, row timestamp, status line. Was night-400 #6f7896 in BOTH themes and measured 4.16:1 light / 4.43:1 dark, under AA in both. The defect contrast.test.ts was written for. |
| `--vela-text-on-accent` | `night-0 #ffffff → night-950 #080b16` | Inverts with the accent fill. Two components once wrote --vela-night-0 here directly, giving 1.57:1 on the dark theme's cyan fill (measured; this cell said 1.4:1 until 2026-08-21 — see docs/corrections.md). |
| `--vela-text-on-danger` | `night-0 #ffffff → night-950 #080b16` | Same inversion for the destructive fill. |

## Semantic — accent and focus

| token / role | value | note |
|---|---|---|
| `--vela-accent` | `signal-700 #0b6864 → signal-300 #5fe2d6` |  |
| `--vela-accent-hover` | `signal-800 #0a4f4d → signal-200 #8ce8df` |  |
| `--vela-accent-quiet` | `signal-50 #e6fbf8 → signal-900 #073836` | Also the ::selection background in base.css:78. |
| `--vela-focus` | `signal-600 #0d857f → signal-300 #5fe2d6` | Only 1 direct var() ref in component CSS — components reach it via --vela-focus-ring; base.css:72 uses it directly. |

## Semantic — status roles

| token / role | value | note |
|---|---|---|
| `--vela-success` | `mint-700 #16794a → mint-400 #45cf88` |  |
| `--vela-warning` | `amber-700 #975a16 → amber-400 #f0b429` |  |
| `--vela-danger` | `rose-700 #a93253 → rose-400 #f2668b` |  |

## Shadows (fully re-authored per theme, not a token reference)

| token / role | value | note |
|---|---|---|
| `--vela-shadow-sm` | `light 0 1px 2px rgb(16 20 38 / 8%) → dark 0 1px 2px rgb(0 0 0 / 40%)` | Light shadows are tinted with night-900's rgb; dark shadows are pure black. |
| `--vela-shadow-md` | `light 0 6px 20px -6px rgb(16 20 38 / 18%) → dark 0 8px 24px -8px rgb(0 0 0 / 60%)` | Geometry changes with theme, not only opacity. |
| `--vela-shadow-lg` | `light 0 24px 64px -16px rgb(16 20 38 / 30%) → dark 0 28px 72px -20px rgb(0 0 0 / 72%)` |  |

## Rows, selection and scrim

| token / role | value | note |
|---|---|---|
| `--vela-row-hover` | `light rgb(16 20 38 / 5%) → dark rgb(255 255 255 / 6%)` | Translucent; composited over chrome/surface/bg by the contrast audit. |
| `--vela-row-selected` | `light signal-50 #e6fbf8 → dark rgb(20 168 158 / 16%)` | The dark value is an opaque-ramp bypass: it is signal-500 (#14a89e) written as a literal rgb() rather than as var(--vela-signal-500). Only colour token whose light form is a token reference and whose dark form is a raw value. |
| `--vela-row-selected-text` | `signal-700 #0b6864 → signal-200 #8ce8df` |  |
| `--vela-scrim` | `light rgb(16 20 38 / 32%) → dark rgb(2 4 10 / 62%)` | rgb(2 4 10) is not a ramp rung — a raw value unique to this token. |

## Scrollbar colours

| token / role | value | note |
|---|---|---|
| `--vela-scrollbar-thumb` | `night-400 #6f7896 (SAME in both themes)` | Re-declared identically in both dark blocks, deliberately. tokens.css:128-130 gives the reason: the one rung clearing 3:1 on every ground a scroller sits on in either theme. |
| `--vela-scrollbar-thumb-hover` | `night-500 #4d5675 → night-300 #9aa2bd` | Only the hover state inverts. |
| `--vela-scrollbar-track` | `transparent (both themes)` | Not a colour by design — a scroller can sit on the page, the chrome or inside a popover. |

## Conversation surface — turn and rule

| token / role | value | note |
|---|---|---|
| `--vela-turn-user-bg` | `night-50 #eef0f6 → night-800 #1a1f31` |  |
| `--vela-turn-user-border` | `night-100 #e0e3ed → night-700 #262c42` |  |
| `--vela-turn-rule` | `night-100 #e0e3ed → night-800 #1a1f31` | Note the asymmetry: light tracks --vela-border (100/700) but dark drops to 800, not 700. |

## Code block and syntax

| token / role | value | note |
|---|---|---|
| `--vela-code-bg` | `night-950 #080b16 → night-900 #101426` | Steps UP in dark: in dark the page is already night-950, so a night-950 block was a 1px border around nothing. |
| `--vela-code-surface` | `night-900 #101426 → night-800 #1a1f31` | The language bar. |
| `--vela-code-text` | `night-100 #e0e3ed (SAME in both themes)` | Re-declared identically in the dark blocks. |
| `--vela-code-border` | `night-800 #1a1f31 → night-700 #262c42` |  |
| `--vela-syntax-comment` | `night-350 #868fac (SAME in both themes)` | Re-declared identically. 350 not 400 because a code block is dark in light mode too; at night-400 it was 3.74:1 on the language bar. |
| `--vela-syntax-string` | `signal-200 #8ce8df (SAME in both themes)` | Re-declared identically. |
| `--vela-syntax-number` | `amber-400 #f0b429 (SAME in both themes)` | Re-declared identically. |
| `--vela-syntax-keyword` | `signal-300 #5fe2d6 (SAME in both themes)` | Re-declared identically. |
| `--vela-syntax-punct` | `night-300 #9aa2bd (SAME in both themes)` | Re-declared identically. All five syntax roles are theme-invariant because the code block is dark in both themes. |

## Notice / thinking / status grounds

| token / role | value | note |
|---|---|---|
| `--vela-thinking-bg` | `night-50 #eef0f6 → night-900 #101426` | One step IN from the page, not equal to it — was night-25, which is exactly --vela-bg in light, so the block painted nothing. |
| `--vela-thinking-border` | `night-100 #e0e3ed → night-700 #262c42` |  |
| `--vela-thinking-text` | `night-500 #4d5675 → night-300 #9aa2bd` |  |
| `--vela-notice-bg` | `night-50 #eef0f6 → night-800 #1a1f31` |  |
| `--vela-warning-bg` | `light #fdf4e0 → dark #2a2109` | RAW HEX in both blocks — not a ramp reference. One of only two colour tokens whose value is a literal in both themes. |
| `--vela-danger-bg` | `light #fdeef2 → dark #2e1420` | RAW HEX in both blocks. Together with --vela-warning-bg and the rgb() literals, these are the values that exist outside the ramps and must be captured explicitly in the frozen set. |

## User-agent scheme

| token / role | value | note |
|---|---|---|
| `color-scheme` | `light → dark (declared in all three blocks)` | Not a --vela-* token but a per-theme declaration in the same three blocks. `light`, not `light dark`, deliberately: it decides what the UA paints (scrollbars, caret, <select> popup). platform-defaults.test.ts walks all six states (three theme states x two OS preferences) and fails if the widget scheme and the palette part company. |

## Type — font stacks (identical in both themes)

| token / role | value | note |
|---|---|---|
| `--vela-font-sans` | `'Inter Variable', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, 'Helvetica Neue', sans-serif` | Leading family is the BUNDLED face declared in typeface.css. Only 4 var() refs in component CSS because base.css:30 sets it on body and everything inherits. |
| `--vela-font-mono` | `'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace` | 18 var() refs across components. |
| `@font-face families (typeface.css)` | `'Inter Variable' 100-900 normal + italic; 'JetBrains Mono Variable' 100-800 normal + italic` | Four files, 179 KiB, latin subset only, font-display: block, src is url() into node_modules resolved by Vite at build time. unicode-range on all four: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD. Note the mono axis tops out at 800, not 900. |

## Type scale (rem-based; identical in both themes)

| token / role | value | note |
|---|---|---|
| `--vela-text-2xs` | `0.625rem` | 3 refs. |
| `--vela-text-xs` | `0.75rem` | 70 refs — the most-used size. |
| `--vela-text-sm` | `0.8125rem` | 57 refs. |
| `--vela-text-base` | `0.9375rem` | 11 refs; also the body font-size in base.css:31. |
| `--vela-text-md` | `1rem` | 3 refs. Added to give six distinguishable heading levels; base → lg was the one gap wide enough to hide a level in. |
| `--vela-text-lg` | `1.125rem` | 6 refs. |
| `--vela-text-xl` | `1.5rem` | 3 refs. The only 24px step; contrast.test.ts notes it clears AAA everywhere so nothing in the UI qualifies as WCAG "large text". |
| `--vela-text-icon` | `1rem` | 1 ref. Sized against the text it sits in, not the root. |
| `--vela-text-inline` | `0.9em` | 2 refs. `em`, not `rem`, deliberately — inline code tracks whatever it is embedded in. |

## Weights

| token / role | value | note |
|---|---|---|
| `--vela-weight-regular` | `400` | 1 ref (EndpointForm.module.css:25). |
| `--vela-weight-medium` | `500` | 19 refs. |
| `--vela-weight-semibold` | `600` | 20 refs. |
| `--vela-weight-bold` | `700` | 1 ref (Markdown.module.css:59). Exists so a heading and a <strong> run are not the same weight — the UA's 700 otherwise outranked every heading below h3 at 600. |

## Leading — one step per job

| token / role | value | note |
|---|---|---|
| `--vela-leading-none` | `1` | A glyph centred in a box. 2 refs. |
| `--vela-leading-tight` | `1.3` | Headings. 2 refs. |
| `--vela-leading-snug` | `1.45` | Large-size text. 1 ref (HomeSurface.module.css:41). |
| `--vela-leading-ui` | `1.5` | Default interface text. 19 refs; also base.css:37 body line-height. |
| `--vela-leading-code` | `1.55` | Monospace blocks. 4 refs. |
| `--vela-leading-prose` | `1.6` | Sustained reading. 9 refs. Replaced the 1.3/1.45/1.5/1.55/1.6/1.65 spread four Phase C builders each answered separately. |

## Tracking

| token / role | value | note |
|---|---|---|
| `--vela-tracking-tight` | `-0.01em` | Display sizes. 4 refs. Annotated as a correction for Inter's set widths — which is why bundling the face mattered. |
| `--vela-tracking-label` | `0.01em` | 1 ref (ThinkingBlock.module.css:57). |
| `--vela-tracking-code` | `0.02em` | 3 refs. |
| `--vela-tracking-caps` | `0.04em` | Uppercase micro-labels. 10 refs. |
| `--vela-tracking-wordmark` | `0.06em` | 1 ref (TitleBar.module.css:32). Identity: the Vela wordmark alone. |

## Space — 4px base scale

| token / role | value | note |
|---|---|---|
| `--vela-space-1` | `0.25rem` | 42 refs. |
| `--vela-space-2` | `0.5rem` | 122 refs — the most-used token in the sheet. |
| `--vela-space-3` | `0.75rem` | 100 refs. |
| `--vela-space-4` | `1rem` | 36 refs. |
| `--vela-space-5` | `1.5rem` | 19 refs; also the source of --vela-gutter. Note the scale breaks 4px linearity here (1rem → 1.5rem, not 1.25rem). |
| `--vela-space-6` | `2rem` | 11 refs; also the source of --vela-scroll-fade. |
| `--vela-space-7` | `3rem` | 2 refs. |

## Radii

| token / role | value | note |
|---|---|---|
| `--vela-radius-xs` | `2px` | 1 ref (Markdown.module.css:253). |
| `--vela-radius-sm` | `4px` | 23 refs; also base.css:74 on :focus-visible. |
| `--vela-radius-md` | `8px` | 37 refs. |
| `--vela-radius-lg` | `12px` | 12 refs. |
| `--vela-radius-pill` | `999px` | 20 refs; also base.css:122 on the scrollbar thumb. |

## Square controls and object sizes

| token / role | value | note |
|---|---|---|
| `--vela-control-xs` | `24px` | A glyph button inside a row or chip. 9 refs. |
| `--vela-control-sm` | `28px` | A compact control in chrome. 4 refs. |
| `--vela-control-md` | `32px` | A standalone icon button. 5 refs. These three replaced 22/24/26/30/32px arrived at independently in five files. |
| `--vela-dot` | `6px` | Every status/activity dot. 8 refs. |
| `--vela-thumb` | `32px` | An attachment thumbnail. 4 refs. Deliberately separate from --vela-control-md despite the identical value, so an image well does not move when a button size does. |
| `--vela-mark-lg` | `56px` | The Vela mark at empty-state size. 4 refs. Reconciled 52px and 56px from two features. |

## Overlay widths and the disclosure chevron

| token / role | value | note |
|---|---|---|
| `--vela-overlay-sm` | `420px` | A dialog asking one question. 1 ref. |
| `--vela-overlay-md` | `620px` | A palette listing results. 2 refs. |
| `--vela-chevron-run` | `5px` | The pointing edge. 2 refs. |
| `--vela-chevron-rise` | `4px` | Each transparent flank. 4 refs. |

## Focus metrics

| token / role | value | note |
|---|---|---|
| `--vela-focus-width` | `2px` | No direct component refs — consumed only by --vela-focus-ring inside tokens.css. Alive indirectly. |
| `--vela-focus-ring` | `var(--vela-focus-width) solid var(--vela-focus) → resolves to 2px solid #0d857f (light) / 2px solid #5fe2d6 (dark)` | 33 refs. A composite token that inherits its theme sensitivity from --vela-focus. base.css:72 writes the equivalent ring longhand rather than using this token. |
| `--vela-focus-offset` | `2px` | 24 refs. The ring sits outside a control. |
| `--vela-focus-offset-inset` | `-2px` | 9 refs. For a full-bleed row where an outward ring would be clipped by the scroll container. Exactly two answers, both tokens — the offset previously drifted to 1px/2px/-1px/-2px. |

## Layering

| token / role | value | note |
|---|---|---|
| `--vela-z-overlay` | `10` | An overlay inside a surface — the drop target. 1 ref. |
| `--vela-z-popover` | `20` | A menu anchored to its control. 2 refs. |
| `--vela-z-dialog` | `40` | A modal dialog and its scrim. 2 refs. |
| `--vela-z-palette` | `50` | The command palette. 1 ref. The whole stacking order is 4 values in one place; it was previously 4 bare integers in 4 files. |

## Chrome metrics

| token / role | value | note |
|---|---|---|
| `--vela-titlebar-height` | `40px` | 1 ref. |
| `--vela-statusbar-height` | `28px` | 1 ref (AppShell.module.css:22). |
| `--vela-rail-width` | `56px` | 3 refs. |
| `--vela-scrollbar-size` | `12px` | 4 refs; base.css:105-106 sets both width and height from it. Also feeds --vela-scroll-reserve. |
| `--vela-scrollbar-inset` | `3px` | 1 ref, and it is in base.css:121 (not a module) — the thumb's transparent border with background-clip: padding-box. |
| `--vela-sidebar-width` | `280px` | 2 refs. First-paint default only; Sidebar.tsx overwrites it per element from navigation-store.ts, where the live value and its 200-480 clamp live. |

## Motion

| token / role | value | note |
|---|---|---|
| `--vela-duration` | `140ms` | 20 refs. The only transition duration in the system. |
| `--vela-ease` | `cubic-bezier(0.2, 0, 0.1, 1)` | 24 refs. The only easing curve. base.css:130-137 honours prefers-reduced-motion globally by overriding animation-duration/iteration-count/transition-duration with !important. |

## Reading measure and layout (all theme-independent)

| token / role | value | note |
|---|---|---|
| `--vela-measure` | `clamp(30rem, 24rem + 6vw, 33rem)` | 7 refs. Floor 480px = 68.3 chars in Inter (measured: 480px column / 7.029px mean advance, assertion P20). Ceiling 528px = 75.1 chars. Was a hard 46rem reading ~104.7 chars. |
| `--vela-wide-measure` | `calc(var(--vela-measure) + 16rem) → calc(clamp(30rem, 24rem + 6vw, 33rem) + 16rem)` | 5 refs. Deliberately NOT min(100%, …): 100% resolves against the reading column itself, which collapsed the min() to the column width. |
| `--vela-wide-breakout-from` | `1600px` | UNUSED — zero references. Its value is duplicated as a literal in two media queries: src/features/conversation/CodeBlock.module.css:25 and src/features/conversation/Markdown.module.css:214, both `@media (min-width: 1600px)`. CSS media queries cannot read custom properties, so the token is structurally unusable; three places now hold 1600 independently. |
| `--vela-turn-user-measure` | `min(100%, 26rem)` | 1 ref (MessageTurn.module.css:42). The user's turn is capped narrower than the assistant's. |
| `--vela-gutter` | `var(--vela-space-5) → 1.5rem` | 2 refs. Shared by the transcript and the composer — that shared value is the vertical ruler both stand on. |
| `--vela-reading-column` | `calc(var(--vela-measure) + 2 * var(--vela-gutter))` | 5 refs. The measure plus a gutter each side; the sidebar is capped at 100vw minus this. |
| `--vela-scroll-reserve` | `calc(2 * var(--vela-scrollbar-size)) → calc(2 * 12px)` | 2 refs. What scrollbar-gutter: stable both-edges takes out of a scroller. Knowable as a number only because base.css styles ::-webkit-scrollbar to --vela-scrollbar-size. |
| `--vela-reading-surface` | `calc(var(--vela-reading-column) + var(--vela-scroll-reserve))` | 2 refs. The width the sidebar gives way to. |
| `--vela-panel-measure` | `46rem` | 2 refs. For side-by-side form fields, which are not prose. This is the width the reading column used to have. |
| `--vela-scroll-fade` | `var(--vela-space-6) → 2rem` | 4 refs. How deep content fades into a scroll edge. |

## DEAD TOKENS — nothing references them, so they are not part of the painted contract

| token / role | value | note |
|---|---|---|
| `--vela-signal-100` | `#c2f4ee` | Zero references in src/, including inside tokens.css. Record as unused, do not freeze as painted. |
| `--vela-signal-400` | `#2ec9bd` | Zero references. |
| `--vela-signal-500` | `#14a89e` | Zero references AS A TOKEN, but the value IS painted via the literal rgb(20 168 158 / 16%) in --vela-row-selected in both dark blocks. Freeze the value; the token itself is a dangling name. Pointing --vela-row-selected at rgb(from var(--vela-signal-500) …) or re-expressing it would make the token live and remove the duplicate. |
| `--vela-amber-600` | `#b7791f` | Zero references. The tokens.css:53-57 comment asserting the 600s are still read by dark and light fills is stale. |
| `--vela-rose-600` | `#c33c62` | Zero references. Same stale comment. |
| `--vela-mint-600` | `#1f9a5c` | Zero references. Same stale comment. |
| `--vela-wide-breakout-from` | `1600px` | Zero references; structurally unusable in the media queries it was written for. Value duplicated literally at CodeBlock.module.css:25 and Markdown.module.css:214. |

## Rule-1 violation sweep — every *.module.css searched

| token / role | value | note |
|---|---|---|
| `Literal hex codes` | `ZERO violations` | Searched /#[0-9a-fA-F]{3,8}/ across all 35 *.module.css files. No hits. The only hex in src/ outside tokens.css is none at all. |
| `rgb() / rgba()` | `ZERO violations` | No hits in any module. |
| `hsl() / hsla() / oklch() / lab() / color-mix()` | `ZERO violations` | No hits — but note these are NOT covered by the enforcing test's regex (see the enforcement-gaps group). |
| `Named colours` | `ZERO violations` | Only `transparent` (16 sites) and `currentcolor` (MessageTurn.module.css:76, ToolCallList.module.css:161), neither of which is a palette value. |
| `Bare px/rem radii` | `ZERO violations` | Searched border-radius and all longhand forms. Every radius is a --vela-radius-* step. |
| `Bare font stacks` | `ZERO violations` | All 19 font-family declarations in modules are var(--vela-font-sans\|mono). The only literal families in src/ are the four @font-face names in typeface.css, which is where they belong. |
| `Bare z-index / box-shadow / cubic-bezier` | `ZERO violations` | No hits for any. |
| `VERDICT` | `No colour exists outside tokens.css` | A freeze that reads only tokens.css would miss nothing painted today. This is not luck: src/styles/design-system.test.ts enforces it mechanically. |

## Bare values that DO escape the guards (non-colour, low severity)

| token / role | value | note |
|---|---|---|
| `Keyframe animation durations` | `1.1s, 1.4s, 0.15s, 0.3s` | Markdown.module.css:254 (caret 1.1s), MessageTurn.module.css:77 (bounce 1.1s), :81 (animation-delay 0.15s), :85 (animation-delay 0.3s), ThinkingBlock.module.css:65 (pulse 1.4s), ToolCallList.module.css:162 (pulse 1.4s). The design-system guard regex targets `transition…`, not `animation:`, so these pass. tokens.css declares no token for looping animation duration, so there is nothing to reference. prefers-reduced-motion still neutralises them globally via base.css. |
| `The 1600px breakpoint` | `1600px, written three times` | tokens.css:338 (--vela-wide-breakout-from, dead), CodeBlock.module.css:25, Markdown.module.css:214. The one genuine token-drift risk in the non-colour axes. |

## src/styles/contrast.test.ts — confirmed, and confirmed to bite

| token / role | value | note |
|---|---|---|
| `Exists` | `Yes — 32,088 bytes, 583 lines, 8 tests, runs in ~15ms` | Verified passing at HEAD 84dbfc2 via `npx vitest run src/styles/contrast.test.ts`: 8/8 green. |
| `What it measures` | `184 hand-authored (foreground, ground-chain) pairs × 2 themes` | 158 pairs at the `text` threshold of 4.5:1 and 26 at the `ui` threshold of 3:1 (WCAG 1.4.11, for focus rings, status dots and meter fills). It resolves the token graph to sRGB the way the engine cascades it, source-over-composites translucent layers onto their ground chain, and applies WCAG 2.x relative luminance. Each pair names the file and rule it was read from, because the ground chain is the one hand-made part. |
| `Would it fail on a contrast regression?` | `YES — demonstrated, not assumed` | I reverted --vela-text-subtle from night-450 to night-400 in an untracked copy — the exact briefed defect. Result: `27 colour pairs are below AA in light`, each naming the ratio and the component, e.g. `4.37:1 (needs 4.5) — --vela-text-subtle on --vela-surface-raised — Composer .input::placeholder — the briefed defect` and `3.47:1 … ConversationRow .meta, hovered`. It also fires on the composited hover/selected chains, not only flat grounds. |
| `Anti-vacuity guards` | `Three, and they are real` | `reads real colours, not var() strings` pins #777 on white to 4.48 (a naive channel average gives 4.9), asserts compositing actually composites, and asserts light≠dark. `has a table big enough to be an audit` requires >120 pairs and a non-empty provenance string on each. `the completeness scan can actually see the stylesheets` requires >20 sheets and asserts border-color is not mistaken for color. |
| `The completeness half` | `A colour role absent from the table FAILS the suite` | `every token used as a text colour appears in the table` scans all *.module.css plus base.css for `color: var(--vela-*)` and fails by name on any token no pair mentions. Backgrounds must be audited or listed in NOT_A_TEXT_GROUND with a stated reason (11 entries). `no component paints a ramp step as a text colour` bans `color: var(--vela-{night,signal,amber,rose,mint}-*)` outright. This is what makes it an audit rather than a sample. |

## src/styles/design-system.test.ts — the actual rule-1 enforcer

| token / role | value | note |
|---|---|---|
| `What it is` | `14 tests enforcing Conventions §7 across all 35 *.module.css files` | Not referenced in the brief but it is the file that makes the rule-1 sweep come back clean. Bans raw colour, bare line-height, bare letter-spacing, bare outline/outline-offset, bare z-index, bare font-size, bare font-family, bare border-radius, hand-rolled box-shadow, bare transition duration/easing. |
| `Raw-hex guard bites` | `Demonstrated` | I set `background: #ff0000` in ModelBar.module.css in the untracked copy: `a colour belongs in tokens.css, where both themes can define it` → `src\features\models\ModelBar.module.css:25 — background: #ff0000;`. |
| `Dark-only-token guard bites` | `Demonstrated` | I added --vela-darkonly-test only inside the dark block: two tests failed — `define it on bare :root first, then override it in both dark blocks` and `an explicit dark choice must produce exactly the inherited dark palette`. |
| `It also self-tests its own regexes` | ``the scans actually catch drift`` | Each pattern is asserted to fire on the shape it exists to catch and not fire on the var() form — closing the failure mode where a guard silently stops matching. |

## Rule-3 compliance — "never define a colour only inside a dark block"

| token / role | value | note |
|---|---|---|
| `Violations found` | `ZERO` | All 155 declarations appear in the light :root block. Machine-checked by parsing the three blocks: the set of names in either dark block minus the light set is empty. |
| `Dark-block symmetry` | `47 tokens in each dark block, identical names AND identical values` | Zero drift between the @media (prefers-color-scheme: dark) block and the :root[data-theme='dark'] block — checked name-by-name and value-by-value. design-system.test.ts enforces the name-set equality but NOT the value equality; the values happen to match today. |
| `Tokens overridden in dark` | `47 of 155` | The other 108 are theme-independent by design: the 34 ramp rungs, and every non-colour token (type, space, radii, z-index, motion, metrics, measure). Six colour tokens are re-declared in dark with the SAME value on purpose — --vela-scrollbar-thumb, --vela-scrollbar-track, --vela-code-text, and the syntax roles comment/string/number/keyword/punct. |

## THE FREEZE GAP — what no test enforces

| token / role | value | note |
|---|---|---|
| `Hue and palette identity` | `ENFORCED BY NOTHING` | Demonstrated, not inferred. In the untracked copy I replaced the entire signal ramp with a luminance-matched clay/terracotta ramp (#fdf5f1 #f9e7de #f3d1c1 #f1c5af #e4a789 #e8773e #ca5014 #9e4011 #77320f #54230b) plus the matching rgb(232 119 62 / 16%) — precisely the trade dress tokens.css:14-15 forbids. contrast.test.ts, design-system.test.ts, surfaces.test.ts and typeface.test.ts all PASSED, 62/62 green. (platform-defaults.test.ts failed only on a missing index.html, an artefact of my partial copy, not a colour finding.) |
| `Why it passes` | `The suite gates ratios and structure, not values` | contrast.test.ts measures relative luminance, which a hue rotation preserves. design-system.test.ts checks that components reference tokens, not what the tokens contain. Nothing anywhere asserts a specific hex. The identity statement at tokens.css:12-15 is a comment — exactly the "aspirational rather than enforceable" condition this record exists to close. |
| `What would close it` | `An assertion over the 34 ramp rungs plus the 6 non-ramp literals` | The frozen set is: 10 signal + 15 night + 9 status = 34 ramp hexes, plus --vela-warning-bg (#fdf4e0/#2a2109), --vela-danger-bg (#fdeef2/#2e1420), --vela-row-hover (rgb(16 20 38 / 5%) / rgb(255 255 255 / 6%)), --vela-row-selected dark (rgb(20 168 158 / 16%)), --vela-scrim (rgb(16 20 38 / 32%) / rgb(2 4 10 / 62%)), and the three shadow triples (rgb(16 20 38 / 8%\|18%\|30%) light, rgb(0 0 0 / 40%\|60%\|72%) dark). Every other colour in the app is a var() away from those. A test pinning that list, plus a hue-family assertion on the signal ramp, makes the freeze enforceable. |
| `Coverage holes in the existing hex guard` | `hsl(), oklch(), lab(), hwb(), color-mix(), named colours, radius longhands` | design-system.test.ts's colour regex is /#[0-9a-fA-F]{3,8}\b\|\brgba?\(/ — a future `color: hsl(20 70% 40%)` or `color: rebeccapurple` in a module would pass it. Its radius guard is /border-radius:\s*[0-9]/, which misses border-top-left-radius and friends. No such value exists today (I swept for all of them), so these are latent holes, not live violations. It also scans only *.module.css — base.css is outside its reach, though contrast.test.ts's completeness scan does include base.css. |

## Run identity (what these numbers describe)

| token / role | value | note |
|---|---|---|
| `binary` | `C:\Users\User\vela-tmp\src-tauri\target\debug\vela.exe, built 2026-08-15 14:58` | rebuilt this session; newer than every file under src/, src-tauri/src, src-tauri/crates and dist/ |
| `frontend served from` | `http://localhost:1420/ (vite dev server rooted at C:\Users\User\vela-tmp)` | debug build uses build.devUrl, so the page is live src/, not the embedded dist. Same checkout, branch claude/new-session-tgl1ut, HEAD 84dbfc2 |
| `viewport measured at` | `1180 x 780 CSS px, devicePixelRatio 1` | sidebar was 480px wide (user-persisted resize), not the 280px token default; irrelevant to colour |
| `custom properties resolved on :root` | `155 in each theme, 40 of them differ between light and dark` | enumerated from the live document, not from tokens.css |

## Signal ramp (teal-cyan) — identical in both themes

| token / role | value | note |
|---|---|---|
| `--vela-signal-50` | `#e6fbf8` | light accent-quiet and light row-selected/selection |
| `--vela-signal-100` | `#c2f4ee` | not observed painted |
| `--vela-signal-200` | `#8ce8df` | dark accent-hover, dark selected-row title, syntax string in BOTH themes |
| `--vela-signal-300` | `#5fe2d6` | dark accent + dark focus ring + syntax keyword token |
| `--vela-signal-400` | `#2ec9bd` | not observed painted |
| `--vela-signal-500` | `#14a89e` | base of dark row-selected rgba(20,168,158,0.16) |
| `--vela-signal-600` | `#0d857f` | light focus ring |
| `--vela-signal-700` | `#0b6864` | light accent |
| `--vela-signal-800` | `#0a4f4d` | light accent-hover |
| `--vela-signal-900` | `#073836` | dark accent-quiet: hero mark bg and dark text selection |

## Neutral ramp (night-sky indigo) — identical in both themes

| token / role | value | note |
|---|---|---|
| `--vela-night-0` | `#ffffff` | light surface / surface-raised / text-on-accent |
| `--vela-night-25` | `#f7f8fb` | light window canvas |
| `--vela-night-50` | `#eef0f6` | dark primary text; light chrome, bg-inset, notice-bg, user-turn bg |
| `--vela-night-100` | `#e0e3ed` | code text in both themes; light hairline border |
| `--vela-night-200` | `#c7ccdc` | light border-strong |
| `--vela-night-300` | `#9aa2bd` | dark text-muted; syntax punct in BOTH themes; dark scrollbar-thumb-hover |
| `--vela-night-350` | `#868fac` | dark text-subtle; syntax comment and code language label in BOTH themes |
| `--vela-night-400` | `#6f7896` | scrollbar thumb at rest in BOTH themes (pixel-verified) |
| `--vela-night-450` | `#5b6280` | light text-subtle |
| `--vela-night-500` | `#4d5675` | light text-muted; light scrollbar-thumb-hover |
| `--vela-night-600` | `#363e59` | dark border-strong |
| `--vela-night-700` | `#262c42` | dark hairline border |
| `--vela-night-800` | `#1a1f31` | dark elevated surface, dark code-surface, dark turn rule; light code-border |
| `--vela-night-900` | `#101426` | dark chrome/surface/code-bg; light primary text; light code-surface |
| `--vela-night-950` | `#080b16` | dark window canvas + dark text-on-accent; light code-bg |

## Amber / mint / rose ramps — identical in both themes

| token / role | value | note |
|---|---|---|
| `--vela-amber-400` | `#f0b429` | dark warning; syntax number in BOTH themes (measured on span._number_qm4p6_) |
| `--vela-amber-600` | `#b7791f` | not observed painted |
| `--vela-amber-700` | `#975a16` | light warning |
| `--vela-mint-400` | `#45cf88` | dark success |
| `--vela-mint-600` | `#1f9a5c` | not observed painted |
| `--vela-mint-700` | `#16794a` | light success |
| `--vela-rose-400` | `#f2668b` | dark danger |
| `--vela-rose-600` | `#c33c62` | not observed painted |
| `--vela-rose-700` | `#a93253` | light danger |

## Painted surfaces — DARK

| token / role | value | note |
|---|---|---|
| `window canvas` | `#080b16 / rgb(8, 11, 22)` | body, div._shell_zzt6q_1, main._main_7z4fm_1, section._surface_1z05q_1 (conversation), form._composer_19uy7_57 |
| `chrome / sidebar / status bar` | `#101426 / rgb(16, 20, 38)` | header._bar_1qf9p_1, nav._sidebar_x9qqi_47, footer._statusBar_zzt6q_35, div._bar_bbxsw_1 (workspace top bar) |
| `resting control fill` | `#101426` | button._action_1qf9p_105 (theme pill), button._searchButton_x9qqi_179, button._trigger_odv98_11, button._secondary_1ypmf_101, article._point_1ypmf_211 (proposition card), button._send_19uy7_191 |
| `elevated surface (dialog / palette / popover)` | `#1a1f31 / rgb(26, 31, 49)` | div._panel_3i3a8_27 (command palette), div._popover_odv98_75 (model switcher), div._dialog_11fa1_35 (Memory modal) |
| `user-turn bubble` | `#1a1f31` | div._userBody_1e188_71, border 1px #262c42, radius 12px |
| `composer field` | `#1a1f31` | div._field_19uy7_79, border 1px #363e59, radius 12px, shadow rgba(0,0,0,0.4) 0 1px 2px |
| `reasoning / thinking block` | `#101426` | section._block_1jtsp_1, border 1px #262c42, radius 8px; body text #9aa2bd |
| `notice surface` | `#1a1f31` | p._floor_f2my8_91 in the capability summary (--vela-notice-bg) |
| `accent-quiet block` | `#073836` | span._mark_1ypmf_33 / span._mark_1qf9p_37 (hero + titlebar logo tile), radius 12px |
| `scrim / overlay backdrop` | `rgba(2, 4, 10, 0.62)` | div._scrim_3i3a8_1 (palette) and div._scrim_11fa1_1 (Memory modal) |

## Painted surfaces — LIGHT

| token / role | value | note |
|---|---|---|
| `window canvas` | `#f7f8fb / rgb(247, 248, 251)` | body, div._shell_zzt6q_1, main._main_7z4fm_1, section._surface_1z05q_1, form._composer_19uy7_57 |
| `chrome / sidebar / status bar` | `#eef0f6 / rgb(238, 240, 246)` | header._bar_1qf9p_1, nav._sidebar_x9qqi_47, footer._statusBar_zzt6q_35, div._bar_bbxsw_1 |
| `resting control fill / surface` | `#ffffff` | button._action_1qf9p_105, button._searchButton_x9qqi_179, button._trigger_odv98_11, article._point_1ypmf_211, div._field_19uy7_79, li._row_18ha3_183 |
| `elevated surface (dialog / palette / popover)` | `#ffffff` | div._panel_3i3a8_27, div._dialog_11fa1_35 — surface and surface-raised collapse to white in light |
| `user-turn bubble` | `#eef0f6` | div._userBody_1e188_71, border 1px #e0e3ed, radius 12px |
| `reasoning / thinking block` | `#eef0f6` | section._block_1jtsp_1, border 1px #e0e3ed; body text #4d5675 |
| `accent-quiet block` | `#e6fbf8` | span._mark_1ypmf_33 hero tile; also the selected-row fill |
| `composer send button (idle)` | `#eef0f6` | button._send_19uy7_191, text #5b6280 |
| `scrim / overlay backdrop` | `rgba(16, 20, 38, 0.32)` | div._scrim_3i3a8_1 and div._scrim_11fa1_1 |

## Hairlines and borders

| token / role | value | note |
|---|---|---|
| `hairline (dark)` | `1px solid #262c42` | most common border in the window — 152 occurrences in the dark census: title-bar bottom, sidebar right, cards, pills, inline code, code figure, palette panel |
| `border-strong (dark)` | `1px solid #363e59` | composer field, secondary CTA, capability 'Check' pill, endpoints buttons, limits pill; also the hover border for quiet pills |
| `hairline (light)` | `1px solid #e0e3ed` | 99 occurrences: title bar, sidebar, cards, dialog, textarea, select, turn rule |
| `border-strong (light)` | `1px solid #c7ccdc` | composer field, secondary CTA, limits pill, endpoints buttons |
| `assistant turn rule` | `dark #1a1f31 / light #e0e3ed` | border-top on article._turn_1e188_25[data-role=assistant] |
| `blockquote rule` | `2px solid — dark #5fe2d6, light #0b6864` | border-left on blockquote._quote_1wlom_301 — the accent, not a neutral |
| `capability row rule` | `2px solid #363e59 (dark, unknown verdict)` | border-left on div._row_f2my8_129._unknown_f2my8_243 |
| `kbd key border` | `1px top/left/right + 2px bottom, dark #262c42 / light #e0e3ed` | composer hint <kbd>; the 2px bottom is the only asymmetric border found |

## Text colours as painted

| token / role | value | note |
|---|---|---|
| `primary text (dark)` | `#eef0f6` | body, h1._title_1ypmf_55, prose paragraphs, wordmark, palette row title, capability badge |
| `muted text (dark)` | `#9aa2bd` | p._lede_1ypmf_71, p._pointBody_1ypmf_239, reasoning body, blockquote, theme-pill label, context meter — the single most frequent text colour in a conversation view (237 elements) |
| `subtle text (dark)` | `#868fac` | span._context_1qf9p_73, h2._groupLabel_x9qqi_333, row meta, status-bar text, composer hint + placeholder, list ::marker |
| `primary text (light)` | `#101426` | same roles as #eef0f6 in dark |
| `muted text (light)` | `#4d5675` | same roles as #9aa2bd in dark |
| `subtle text (light)` | `#5b6280` | same roles as #868fac in dark |
| `text on accent` | `dark #080b16 / light #ffffff` | button._newButton_x9qqi_123 and button._primary_1ypmf_99 label; also the close-button label on danger hover |
| `selected-row title` | `dark #8ce8df / light #0b6864` | span._title_18v2a_83 in li._selected_18v2a_, and span._rowTitle_3i3a8_ in the active palette row |
| `accent-as-text` | `dark #5fe2d6 / light #0b6864` | button._footerAction_odv98_309 ('Ask this endpoint…', 'Manage endpoints…'), span._check_odv98_281 tick, svg logo fill |

## Hover / active / selected / focus — DARK

| token / role | value | note |
|---|---|---|
| `row hover` | `rgba(255, 255, 255, 0.06)` | li._row_18v2a_1:hover, button._recentItem_1ypmf_171:hover, caption buttons:hover, open model-switcher trigger (--vela-row-hover) |
| `row selected` | `rgba(20, 168, 158, 0.16)` | li._selected_18v2a_ and li._active_3i3a8_ (palette) and button._optionActive_odv98_205 |
| `accent button rest → hover/active` | `#5fe2d6 → #8ce8df` | button._newButton_x9qqi_123 and button._primary_1ypmf_99; :active is identical to :hover, no separate pressed colour |
| `quiet pill hover` | `text #9aa2bd → #eef0f6, border #262c42 → #363e59, bg unchanged #101426` | button._action_1qf9p_105 (theme), button._searchButton_x9qqi_179; :active identical to :hover |
| `secondary button hover` | `bg stays #101426` | button._secondary_1ypmf_101 — hover sets --vela-bg-inset, which equals chrome in dark, so it is a no-op visually; in light it is a real change |
| `window close button hover` | `bg #f2668b, text #080b16` | button._closeButton_1qf9p_273 — the only place danger is used as a fill |
| `focus ring` | `2px solid #5fe2d6, offset 2px` | measured by tabbing: theme pill, new-conversation button, collapse icon button, home CTAs |
| `focus ring (inset variant)` | `2px solid #5fe2d6, offset -2px` | caption buttons and input._renameInput_18v2a_217 (which also swaps its border to #5fe2d6) |
| `composer focus-within` | `border-color → #5fe2d6` | div._field_19uy7_79:focus-within; no outline, no shadow change |
| `text selection` | `background #073836, text #eef0f6` | pixel-verified by selecting a real paragraph and sampling — #073836 was 24565 of the pixels inside the selected rect |
| `caret` | `#eef0f6` | textarea._input_19uy7_117 |

## Hover / active / selected / focus — LIGHT

| token / role | value | note |
|---|---|---|
| `row hover` | `rgba(16, 20, 38, 0.05)` | li._row_18v2a_1:hover, button._recentItem_1ypmf_171:hover, caption buttons:hover, kbd hint fill |
| `row selected` | `#e6fbf8 (opaque, not an alpha wash)` | li._selected_18v2a_ and li._active_3i3a8_ — light deliberately uses a solid tint where dark uses rgba(20,168,158,0.16) |
| `accent button rest → hover/active` | `#0b6864 → #0a4f4d` | button._newButton_x9qqi_123, button._primary_1ypmf_99 |
| `quiet pill hover` | `text #4d5675 → #101426, border #e0e3ed → #c7ccdc, bg stays #ffffff` | theme pill, sidebar search buttons |
| `secondary button hover` | `bg #ffffff → #eef0f6` | button._secondary_1ypmf_101 — bg-inset differs from chrome in light so the hover is visible |
| `window close button hover` | `bg #a93253, text #ffffff` | button._closeButton_1qf9p_273 |
| `focus ring` | `2px solid #0d857f, offset 2px (or -2px inset)` | note this is signal-600, NOT the light accent #0b6864 — focus and accent are different colours in light |
| `composer focus-within` | `border-color → #0b6864` | div._field_19uy7_79:focus-within |
| `text selection` | `background #e6fbf8, text #101426` | pixel-verified — #e6fbf8 was 36285 of the pixels inside the selected rect |
| `caret` | `#101426` | textarea._input_19uy7_117 |

## Scrollbar (measured by pixel sampling, not computed style)

| token / role | value | note |
|---|---|---|
| `thumb at rest` | `#6f7896 in BOTH themes` | sampled at x=470 on the sidebar list scrollbar in each theme. getComputedStyle on ::-webkit-scrollbar-thumb lies here — it returns the :hover rule — so this was settled from pixels |
| `thumb on hover (dark)` | `#9aa2bd` | sampled with the pointer parked on the thumb |
| `thumb on hover (light)` | `#4d5675` | sampled with the pointer parked on the thumb |
| `track` | `transparent` | --vela-scrollbar-track: transparent; sampling 6px outboard of the thumb returned the surface beneath (#101426 dark, #eef0f6 light) |
| `geometry` | `12px wide, 3px transparent inset border, radius 999px` | ::-webkit-scrollbar width/height = --vela-scrollbar-size; border = 3px solid transparent with background-clip: padding-box, so the visible thumb is 6px |
| `scrollbar buttons` | `display: none` | ::-webkit-scrollbar-button suppressed |

## Code block and syntax — the code surface stays dark in BOTH themes

| token / role | value | note |
|---|---|---|
| `code figure background` | `dark #101426 / light #080b16` | figure._block_qm4p6_11 — light uses a DARKER code well than dark theme does; radius 8px |
| `code bar (figcaption)` | `dark #1a1f31 / light #101426` | figcaption._bar_qm4p6_63, border-bottom 1px (dark #262c42 / light #1a1f31) |
| `code border` | `dark #262c42 / light #1a1f31` | on the figure and the bar |
| `code text` | `#e0e3ed in both themes` | pre._pre_qm4p6_119 and its <code> |
| `syntax comment` | `#868fac in both themes` | span._comment_qm4p6_151 |
| `syntax string` | `#8ce8df in both themes` | span._string_qm4p6_161 |
| `syntax number` | `#f0b429 in both themes` | span._number_qm4p6_169 — the only place the amber is actually painted anywhere in the app |
| `syntax punct` | `#9aa2bd in both themes` | span._punct_qm4p6_185 |
| `syntax keyword (token value)` | `#5fe2d6 in both themes` | --vela-syntax-keyword resolves to signal-300 in both blocks; no keyword span existed in any stored transcript, so this is the token, not a measured pixel |
| `code language label` | `#868fac in both themes` | span._language_qm4p6_81, mono 12px/19.2px, letter-spacing 0.24px |
| `inline code (answer scale)` | `bg dark #101426 / light #eef0f6; text dark #eef0f6 / light #4d5675; border 1px hairline; radius 4px` | code._inlineCode_1wlom_343 — note the inline code follows the theme while fenced blocks do not |
| `code-bar copy button (subtle)` | `text #868fac, border dark #262c42 / light #1a1f31` | button._button_12ur1_1._subtle_12ur1_77; on success it becomes text #e0e3ed / border #868fac |

## Status roles: success, danger, warning

| token / role | value | note |
|---|---|---|
| `success (dark)` | `#45cf88` | span._dot_zzt6q_61._dotOk_zzt6q_75 fill (6px pill) and the Copy button's 'Copied' state — text AND border both #45cf88 on bg #101426 |
| `success (light)` | `#16794a` | same two elements; 'Copied' is text+border #16794a on bg #ffffff |
| `danger (dark)` | `#f2668b` | button._rowDanger_18ha3_295 ('Remove' in Endpoints) as text + 1px border, radius 999px; and as a fill on close-button hover |
| `danger (light)` | `#a93253` | same two elements |
| `warning (token only)` | `dark #f0b429 / light #975a16` | resolved on :root but I could not trigger any surface that paints it — see couldNotEstablish |
| `danger-bg (token only)` | `dark #2e1420 / light #fdeef2` | no reachable surface painted it |
| `warning-bg (token only)` | `dark #2a2109 / light #fdf4e0` | no reachable surface painted it |
| `notice-bg (painted)` | `dark #1a1f31 / light #eef0f6` | p._floor_f2my8_91 in the capability summary |

## Typefaces as resolved

| token / role | value | note |
|---|---|---|
| `UI and prose font-family` | `"Inter Variable", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Helvetica Neue", sans-serif` | computed on body and on every prose element; one stack for both UI and prose — there is no separate prose face |
| `code font-family` | `"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace` | pre/code, inline code, kbd, the code language label, and the <dd> values in the home 'facts' list |
| `font files actually shipped` | `inter-latin-wght-normal / -italic and jetbrains-mono-latin-wght-normal / -italic (.woff2, variable-weight)` | four woff2 files in dist/assets; @fontsource-variable/inter ^5.3.0 and @fontsource-variable/jetbrains-mono ^5.3.0 |
| `weights in use` | `400, 500, 600, 700` | 400 body/prose/most controls; 500 accent buttons, palette-ish labels, model name, reasoning summary, sidebar row title; 600 wordmark, h1 home, dialog title, card headings, group labels, <strong>; 700 all six markdown heading levels |
| `html element (unstyled)` | `"Times New Roman" 16px` | the root element never gets the stack — it lands on body. Worth knowing so a critic does not sample the html node |

## Type scale as painted (font-size / line-height / weight / tracking)

| token / role | value | note |
|---|---|---|
| `body / UI base` | `15px / 22.5px / 400 / normal` | body and inherited across the shell (--vela-text-base 0.9375rem, --vela-leading-ui 1.5) |
| `prose answer scale` | `15px / 24px / 400` | div._prose_1wlom_1[data-scale=answer] (--vela-leading-prose 1.6) |
| `prose aside scale (reasoning)` | `13px / 20.8px / 400` | div._prose_1wlom_1[data-scale=aside] |
| `markdown h1` | `24px / 31.2px / 700 / -0.24px` | h2[data-level='1'] in answer prose |
| `markdown h2` | `18px / 23.4px / 700 / -0.18px` | h3[data-level='2'] |
| `markdown h3` | `16px / 20.8px / 700 / -0.16px` | h4[data-level='3'] |
| `markdown h4` | `15px / 19.5px / 700 / -0.15px` | h5[data-level='4'] |
| `markdown h5` | `15px / 19.5px / 700 / -0.15px, colour drops to muted` | h6[data-level='5'] — same metrics as h4, differentiated only by colour |
| `markdown h6` | `15px / 19.5px / 700 / 0.6px, uppercase, muted` | h6[data-level='6'] |
| `home h1` | `24px / 36px / 600 / -0.24px` | h1._title_1ypmf_55 |
| `home lede` | `18px / 26.1px / 400` | p._lede_1ypmf_71 |
| `wordmark` | `13px / 19.5px / 600 / 0.78px, uppercase` | span._wordmark_1qf9p_57 (--vela-tracking-wordmark 0.06em) |
| `section labels` | `12px / 18px / 600 / 0.48px, uppercase` | h2._groupLabel_x9qqi_333, h2._recentHeading_1ypmf_265 (--vela-tracking-caps 0.04em) |
| `control / button label` | `13px / 19.5px / 500` | primary + secondary CTAs, new-conversation, model trigger, reasoning summary (which adds 0.13px tracking) |
| `small meta / status` | `12px / 18px / 400` | status bar, context meter, capability detail, row kind badge, palette kind badge |
| `palette input` | `18px / 27px / 400` | input._input_3i3a8_75 |
| `dialog title` | `18px / 27px / 600` | h2._title_11fa1_75, h2._heading_18ha3_53 |
| `fenced code` | `13px / 20.15px / 400` | pre._pre_qm4p6_119 (--vela-leading-code 1.55) |
| `inline code` | `13.5px / 21.6px / 0.27px at answer scale; 11.7px / 18.72px / 0.234px at aside scale` | 0.9em of the surrounding size (--vela-text-inline), so it tracks the prose scale |
| `kbd` | `10.8px / 16.2px mono, padding 0 3.24px` | composer hint keys |
| `copy button` | `12px / 12px / 400` | button._button_12ur1_1 — line-height equals font-size (--vela-leading-none) |

## Radii, measured off real elements

| token / role | value | note |
|---|---|---|
| `4px (--vela-radius-sm)` | `4px` | most frequent (34 elements): inline code, kbd hint, copy buttons, row action buttons, rename input, palette input, home primary CTA, titlebar logo tile |
| `8px (--vela-radius-md)` | `8px` | 30 elements: sidebar buttons, conversation rows, palette rows, reasoning block, code figure, composer send, model options, modal close, endpoints buttons |
| `12px (--vela-radius-lg)` | `12px` | user-turn bubble, composer field, palette panel, model popover, Memory dialog, proposition cards, hero mark, endpoint rows |
| `999px (--vela-radius-pill)` | `999px` | theme pill, capabilities pill, attach pill, endpoint Edit/Remove pills, status dot, scrollbar thumb |
| `2px (--vela-radius-xs)` | `2px` | declared and resolved on :root; its only consumer is src/features/conversation/Markdown.module.css:253 and no stored conversation rendered that element, so I never saw it painted |

## Shadows, measured off real elements

| token / role | value | note |
|---|---|---|
| `--vela-shadow-sm (dark)` | `rgba(0, 0, 0, 0.4) 0px 1px 2px 0px` | div._field_19uy7_79 (composer) — the only element in the app that paints it |
| `--vela-shadow-sm (light)` | `rgba(16, 20, 38, 0.08) 0px 1px 2px 0px` | same element |
| `--vela-shadow-lg (dark)` | `rgba(0, 0, 0, 0.72) 0px 28px 72px -20px` | command palette panel, model popover, Memory dialog |
| `--vela-shadow-lg (light)` | `rgba(16, 20, 38, 0.3) 0px 24px 64px -16px` | same three surfaces — note light also changes the geometry, not just the alpha |
| `--vela-shadow-md` | `dark 0 8px 24px -8px rgb(0 0 0 / 60%) / light 0 6px 20px -6px rgb(16 20 38 / 18%)` | resolved on :root but has zero consumers in any CSS module — declared, never painted |

## Spacing and layout metrics in use

| token / role | value | note |
|---|---|---|
| `space scale` | `1=0.25rem, 2=0.5rem, 3=0.75rem, 4=1rem, 5=1.5rem, 6=2rem, 7=3rem` | resolved on :root; painted as 4/8/12/16/24/32px |
| `padding values actually painted` | `8px 12px (x15), 0 0 0 4px (x15), 0 4px 0 0 (x10), 24px 0 (turns), 0 12px (title/status bar), 4px 8px, 0 0 0 24px (lists), 8px 12px 4px, 8px 16px, 4px 12px (pills), 12px 16px (user bubble), 12px, 8px, 24px 24px 32px (transcript column), 12px 24px 16px (composer), 8px 8px 8px 12px (composer field), 16px (cards), 24px (dialog/panels), 32px (modal scrim), 93.6px 24px 24px (palette scrim)` | whole-document census of computed padding on visible elements |
| `gap values actually painted` | `1px, 2px, 4px, 8px, 12px, 16px` | 2px on row internals, 8px most controls, 12px title bar / turn footer / capability rows, 16px dialog stack, 1px between sidebar rows |
| `titlebar height` | `40px` | header._bar_1qf9p_1 measured 1180x40 |
| `status bar height` | `28px` | footer._statusBar_zzt6q_35 measured 1180x28 |
| `reading measure` | `clamp(30rem, 24rem + 6vw, 33rem); transcript column resolved to 528px content at this window width` | --vela-measure; --vela-reading-column adds 2 x 1.5rem gutter |
| `sidebar width token` | `280px` | --vela-sidebar-width; the running window had it dragged to 480px, persisted from a prior session |
| `overlay widths` | `palette 620px (--vela-overlay-md), Memory dialog 620px, model popover 384px` | measured rects; --vela-overlay-sm is 420px |
| `control heights` | `24 / 28 / 32px` | --vela-control-xs/sm/md; painted as the 24px row-action buttons, 28px pills, 32px icon buttons |
| `motion` | `140ms, cubic-bezier(0.2, 0, 0.1, 1)` | --vela-duration / --vela-ease; the composer field's border-color transition is the one I saw declared on a live rule |
| `z-index` | `overlay 10, popover 20, dialog 40, palette 50` | --vela-z-*; the scrim rule reads z-index: var(--vela-z-dialog) |

---

## Could not establish (23)

Recorded rather than guessed. A value missing here is a value no critic may assume.

- Whether Vite actually emits the four .woff2 into dist/assets/ at THIS HEAD — I did not build (read-only, and dist/ is gitignored). The bundling claim rests on typeface.test.ts's static @import-graph walk plus a recorded harness run, not on a build I performed.
- Whether P17–P20 currently pass at HEAD 84dbfc2 — the harness needs Playwright and a built dist/, and another agent holds the app, so I did not run it. The figures I quote (appBody 560.09 / absent-control 481.72 / Segoe UI 523.91, 68.3 cpl) come from the recorded evidence file docs/desktop-gate/evidence/CONV-1-retest/typeface-verification.txt, taken on WebView2 151.0.4129.78, not from a live run.
- The exact installed versions behind the ^5.3.0 ranges for @fontsource-variable/inter and jetbrains-mono — I read the sizes off node_modules on this machine but did not open pnpm-lock.yaml to pin the resolved versions, so the byte counts are true for this checkout and may differ under a different lock resolution.
- Colours inside icon.ico (a multi-resolution container I did not decode) and 128x128@2x.png (not sampled). My icon colour figures come from 32x32.png, 128x128.png and icon.png, sampled on a 2px stride with alpha < 16 skipped, so faint antialiased edge pixels are under-represented and the true gradient range may extend slightly beyond #111529–#1B2140.
- Whether the caret's `steps(2, start)` and the bounce delays of 0.15s/0.3s are deliberate exceptions to the one-duration/one-easing rule or simply values that predate the guard — nothing in the source comments either way. I report them as outside the token, not as defects.
- How the three colour-only selection cues actually render under Windows High Contrast — I did not launch the app or emulate forced-colors. The losses I list are derived by reading the CSS against the forced-colors specification (which strips background-color, color and box-shadow while preserving outline), not observed on screen.
- Whether any surface outside src/ — the Rust/Tauri side, the installer chrome, or the WebView2 host — introduces colour. I scoped the sweep to src/ and src-tauri/ config as briefed, and did not read the Rust sources.
- Whether the two dark blocks are guaranteed to hold identical VALUES over time. They do today (checked value-by-value, zero drift), but design-system.test.ts only asserts the two blocks declare the same set of NAMES — `expect(byChoice).toEqual(byPreference)` compares sorted name arrays. A future edit that changes --vela-accent in the @media block but not in the [data-theme='dark'] block would pass the suite and give a user who forces dark a different palette from one who inherits it.
- Whether the 184 ground chains in contrast.test.ts are accurate. The file states plainly that the `on:` chain is the one hand-made part and that a wrong chain is a wrong audit. Verifying each chain against the component it names would require reading all 35 module stylesheets against the table; I confirmed the mechanism and the provenance strings exist, not that each chain matches what is actually stacked on screen.
- Whether the pixels the app currently paints match these declared values. This extraction is static — it resolves the stylesheet, it does not drive the app. Anything injected at runtime via element.style (Sidebar.tsx is documented in tokens.css:275-279 as overwriting --vela-sidebar-width per element from navigation-store.ts) is outside what I read. A pixel diff against a running build is still needed to close that gap.
- Whether --vela-signal-100, --vela-signal-400, --vela-amber-600, --vela-rose-600 and --vela-mint-600 are intentionally reserved for planned surfaces or are genuinely abandoned. The tokens.css:53-57 comment gives a reason for keeping the status 600s that is factually wrong at this HEAD (nothing reads them), but I cannot tell whether the comment is stale or the usage was removed by accident and is meant to return. That is a call for the lead, not a fact I can extract.
- Whether platform-defaults.test.ts, surfaces.test.ts and typeface.test.ts contain colour assertions I did not exercise. I ran them against the terracotta palette and they passed, which establishes they do not gate hue; I read their test titles but not their full bodies (28 KB, 33 KB and 17 KB respectively), so I cannot rule out other colour-adjacent constraints inside them.
- --vela-warning (#f0b429 dark / #975a16 light) as a painted colour anywhere. Its consumers are AttachmentTray (needs a truncated text attachment via a native file dialog), TurnNotices, ToolCallList, ThinkingBlock's truncation hint, the AppShell _dotWarn_ status dot (the bridge was healthy the whole session), and CapabilitySummary's warn verdict rows — which would need me to press 'Check' and send a request to the llama.cpp endpoint on 8033, which I was told not to touch. Recorded as a token value only. The one place amber IS painted is the syntax number colour, which is the same hex.
- --vela-warning-bg (#2a2109 dark / #fdf4e0 light) and --vela-danger-bg (#2e1420 dark / #fdeef2 light). No reachable surface painted either; both are consumed only by TurnNotices, ToolCallList's error row, MessageTurn's error notice, and CanvasPanel — all of which require a failed or tool-using turn.
- --vela-syntax-keyword as a painted pixel. Two of the ten stored conversations contain fenced code, both bash, and the highlighter emitted only comment/string/number/punct spans — zero elements with the _keyword_qm4p6_ class existed in the live DOM. The token resolves to #5fe2d6 in both themes (signal-300); that value is from the cascade, not from a measured element.
- --vela-radius-xs (2px) as a painted radius. The whole-document radius census found only 4px, 8px, 12px and 999px. Its sole consumer is src/features/conversation/Markdown.module.css:253, and no stored transcript rendered that element.
- --vela-shadow-md. It resolves on :root but a repo-wide search for `vela-shadow-md` outside tokens.css returns nothing — it has no consumer at all, so it can never be painted in the current build.
- The delete-conversation dialog (src/features/navigation/DeleteConversationDialog.tsx, which is the fourth --vela-shadow-lg consumer). I deliberately did not open it: it is the destructive path on real user conversations. Its elevated surface should match the Memory dialog and command palette, all three of which I did measure, but I did not confirm that.
- Composer error state (Composer.module.css:133-134, border-color and color → --vela-danger). Reaching it requires a send that fails, which means firing a request at the endpoint.
- CapabilitySummary's warn and success verdict rows (--vela-warning-bg / --vela-warning, and the --vela-success left border). Every row in the running app read 'Not established' / 'Not reported', i.e. the unknown verdict; establishing any other verdict requires probing the endpoint.
- ToolCallList, the canvas/artifact DocumentPreview, and the AttachmentTray surfaces. No route to any of them without sending a turn or opening a native file-picker dialog.
- The 'system' theme setting was only spot-checked. Clicking through it, the resolved values were byte-identical to the explicit light theme on this machine (the OS is in light mode), so I could not verify that the `@media (prefers-color-scheme: dark)` block in tokens.css matches the explicit `[data-theme=dark]` block by observation — only that the light pair agree.
- SVG icon stroke colours are recorded as observed (#868fac and #9aa2bd in dark, #5b6280 and #4d5675 in light) but I did not trace each icon to a token; they inherit currentColor from their button, so they will track whatever text colour the control has rather than being independent values.

---

## Amendments

None. Add one row per amendment: the date, the token, the value, the surface that needed it, and
who decided. An amendment is how this file changes; an edit without one is a defect.

| date | token | value | why | decided by |
|---|---|---|---|---|
