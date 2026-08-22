# GATE M — the platform-defaults wave — EXECUTOR'S REPORT

**Verdict: FAIL.** Three defects, one of them a regression this wave introduced into a
guarantee a previous wave had closed. Everything else the wave claims holds, and holds under
attack.

Fresh executor: built none of this, wrote none of the fixes under test, and re-ran the previous
waves' gates rather than trusting their recorded numbers.

---

## 0. Honesty, first, because every number below rests on it

**Everything in this report is VERIFIED-BY-FAKE and PROVISIONAL** (`docs/architecture/conventions.md` §10).

Chromium on Linux, the production `dist/` bundle served under the shipping CSP, `BrowserAdapter`,
no Tauri IPC, no Rust host in the browser runs, `MemoryStore`, no model.

**What this session is structurally incapable of judging, stated plainly:**

| Not judged here | Why | Whose it is |
|---|---|---|
| Real WebView2 rendering | Chromium on Linux is a different engine; the Tauri webview needs a display server | desktop `visual` |
| True Windows display scaling | no Windows, no DPI virtualisation, no per-monitor DPI change, no non-client area | desktop `visual` |
| **The OS scrollbar** | measured, not assumed: this engine draws **overlay** scrollbars and paints no widget at all — see §3 | desktop `visual` |
| The packaged binary | cross-compilation not attempted | desktop |
| The real keychain | no Credential Manager / libsecret | desktop `keychain-runtime` |
| Any real model | the operator's llama.cpp is behind home NAT | desktop `real-model` |
| Cold start, idle RAM | container figures are meaningless for a desktop binary | desktop `performance` |

### The rule this driver was written against

The previous gate caught itself reporting `fontFamily: Inter` computed from the **declared**
stack rather than from what the engine resolved, so every committed artefact asserted a font
that had never loaded. The governing rule here is therefore:

> Every assertion must be about a **result** the engine produced, never about a **declaration**
> the stylesheet made. Where the engine cannot produce the result, the assertion is not written;
> the gap is reported instead.

Four checks were deliberately re-cut against that rule, and one existing assertion in the
wave's own gate was found to be measuring the wrong quantity because of it (§7).

---

## 1. The instrument

`tests/harness/production-bundle/drive-platform-defaults-executor.mjs`, against `dist/` — the
directory `tauri.conf.json` points `frontendDist` at — served under the shipping CSP.

**134 assertions, 1 failure.** Ledger: `ASSERTION-LEDGER.tsv`. Raw run: `run-log.txt`.

The one failure is finding **A** below. Every control passed: each staged damage made its own
assertion family fail, and the damages are served from a rewritten response body, so no byte on
disk is touched.

---

## 2. TYPEFACE — measured on the nodes the user reads

The composition-root gate already width-controls the `--vela-font-*` tokens. This asks the other
half of the question: not "is the face in the bundle" but "is the reader looking at it". Seven
rendered elements were found in the live app, the family the **engine resolved for that element**
was read, and each was measured three ways — the element's own stack, its first family with only
a deliberately absent family behind it, and the absent family alone.

| rendered element | first family the element asks for | its advance | absent-font control | painted at |
|---|---|---|---|---|
| `<body>` | `Inter Variable` | 2009px | 1725.91px | 2009px |
| `<h2>` empty-state heading | `Inter Variable` | 2043px | 1808.09px | 2043px |
| `<p>` prose | `Inter Variable` | 2009px | 1725.91px | 2009px |
| `<button>` | `Inter Variable` | 2009px | 1725.91px | 2009px |
| `<textarea>` composer | `Inter Variable` | 2009px | 1725.91px | 2009px |
| `<code>` inline | `JetBrains Mono Variable` | 2356px | 1725.91px | 2356px |
| `<pre>` code block | `JetBrains Mono Variable` | 2356px | 1725.91px | 2356px |

Loaded ⇔ the requested advance differs from the control. Painted in it ⇔ the applied advance
equals the requested one. Both hold on all seven. Prose and code differ by 347px, so they are
genuinely two faces and not one stack shadowing the other.

**`document.fonts.check()` returned `true` for every family in every case, including in the
control where the face is provably absent.** It is recorded in `X1-typeface-rendered.json` as a
data point and asserted on nowhere.

**Control `C1`** — the same bundle re-served with every `@font-face` rule stripped, which is the
state this repository shipped in until `410936b`: all seven `-loaded` readings collapse to
**exactly** the absent-font control (1725.91px), and all seven `-painted` readings diverge from
it into a platform fallback (2134.16px for the sans — the shape of the Segoe UI reading the
desktop session took on Windows). `C1-X1-typeface-rendered.json`.

### Zero network requests for fonts, trapped before the first module evaluates

- `X2-trap-order` — the traps were installed at `document.readyState === 'loading'`, so "zero
  requests" covers the whole session and not merely what happened after mount.
- `X2-no-egress` — a complete session (mount → endpoint configured through the shipping UI →
  a turn sent → a rich markdown answer rendered) produced **zero** `fetch` / `XMLHttpRequest` /
  `WebSocket` / `EventSource` / `sendBeacon` / `new FontFace(url)` calls.
- `X2-no-off-origin` — Chromium's own `request` event saw nothing leave the page origin. This is
  watched as well as the in-page traps, because an in-page trap can be bypassed by an `img.src`,
  a `<link>`, or a fresh iframe's `fetch`.
- `X2-fonts-from-bundle` — four font requests, all same-origin:
  `inter-latin-wght-{normal,italic}.woff2`, `jetbrains-mono-latin-wght-{normal,italic}.woff2`.
- `X2-font-src` — the shipping CSP declares `font-src 'self' data:`, so a remote face could not
  be fetched even if a stylesheet asked for one.

---

## 3. SCROLLBARS and `color-scheme` — all three theme states, and what pixels can settle

### The half an engine can settle, settled in pixels rather than in computed styles

`getComputedStyle(...).colorScheme` reports the **declared** value. Asserting on it alone would
be the exact error this driver exists to avoid, so the used value is proven to reach painted
pixels: a bare, unstyled `<input>` is inserted into the live app and screenshotted, and its
centre pixel is compared against reference shots of the same element under forced `light` and
forced `dark`. Chromium paints that widget's background from the used `color-scheme` —
`rgb(255,255,255)` under light, `rgb(59,59,59)` under dark — which is the same switch that
decides whether the Windows scrollbar is drawn light or dark.

All six states (three theme states × two OS preferences):

| theme state | OS prefers | declared | UA painted | page | agrees |
|---|---|---|---|---|---|
| explicit light | light | `light` | light | `rgb(247,248,251)` | ✓ |
| explicit light | dark | `light` | light | `rgb(247,248,251)` | ✓ |
| explicit dark | light | `dark` | dark | `rgb(8,11,22)` | ✓ |
| explicit dark | dark | `dark` | dark | `rgb(8,11,22)` | ✓ |
| system-follows | light | `light` | light | `rgb(247,248,251)` | ✓ |
| system-follows | dark | `dark` | dark | `rgb(8,11,22)` | ✓ |

Every state resolves to **exactly one** keyword — the app decides, rather than delegating to the
OS and being right by luck in four states out of six. `X3-color-scheme.json`.

**Control `C3`** — `color-scheme: dark` widened back to `light dark`, explicit dark theme, OS
prefers light: the UA paints a **white** widget on the `#080b16` canvas. That is the reported
white-scrollbar defect reproduced in pixels, in the one engine available here.

### The half this engine cannot settle — measured, not assumed

Screenshots of a genuinely scrollable region (a rendered answer, wound to the middle so both
edges are live) in all three theme states: `scrollable-light.png`, `scrollable-dark.png`,
`scrollable-system.png`. The scroller is confirmed scrollable in each — `scrollHeight 1581` vs
`clientHeight 355`.

**No scrollbar is visible in any of them, and that is a fact about the engine, not about Vela.**
It was measured rather than assumed:

- an unstyled 200×100 scroller with 900px of content reserves a **0px** gutter here;
- so does one carrying an explicit `::-webkit-scrollbar { width: 12px }` with a coloured thumb
  and track;
- and screenshots of both are **byte-identical** (`md5 c609c962…`) to an unstyled control.

Linux Chromium draws **overlay** scrollbars that paint nothing while idle. The app's own scroller
still reports a 24px reserved gutter, but that comes from `scrollbar-gutter: stable both-edges`
reserving it explicitly, not from a widget. Four flag combinations (`--disable-features=OverlayScrollbar`,
`FluentOverlayScrollbar`, `FluentScrollbar`) were tried and none produced a classic scrollbar.

**The painted scrollbar is therefore reported and not asserted.** `X4-gutter` is recorded as
`REPORTED, NOT ASSERTED` rather than as a green tick, because a tick that means "your platform
hid the thing I was measuring" is worse than no tick. The binding verdict is the desktop
session's, and it already exists: A1 visual re-judge, `#080b16` page with a `#6f7896` pill, no
trough, no buttons.

**One thing in the wave's own gate should be read with this in mind.** `drive-display-scaling.mjs`
asserts `B-scrollbar-token`: "the dark palette carries a scrollbar thumb colour", by reading
`--vela-scrollbar-thumb` off `:root`. That is a declaration check wearing an assertion's clothes —
it passes whether or not any rule ever applies the token. It is not wrong, but it is not evidence
that the scrollbar is styled.

---

## 4. 150% DISPLAY SCALING — the empty state **and** the conversation

150% scaling does not change the CSS pixel; it shrinks the desktop, and the window is capped by
what is left. The viewports below are the real effective work areas less Windows 11's 48px
taskbar, at `deviceScaleFactor: 1.5` so every measurement lands on the fractional device-pixel
grid the hardware uses.

**This approximates Windows scaling and nothing more.** It is not Windows, not WebView2, and it
exercises none of Windows' own DPI virtualisation, per-monitor DPI changes, or non-client area.
**Only the desktop session can confirm the finding.** What is established here is that the layout
rules hold at those sizes in an engine.

The **header rule** is found structurally — the nearest ancestor of the model switcher that
actually carries a bottom border — so the clearance is measured against the rule the user sees
rather than against a class name.

| viewport | theme | mark drawn, whole, in container | heading clears the rule |
|---|---|---|---|
| 1280×672 (1920×1080 @150%) | light / dark | 161.8–195.8, container 86.5–533.5 | **153.3px** |
| 1066×552 (1600×900 @150%) | light / dark | 194.6–228.6, container 126.5–413.5 | **186.1px** |
| 911×464 (1366×768 @150%) | light / dark | 189.3–223.3, container 126.5–325.5 | **180.8px** |

All six rest at `scrollTop 0`. Twelve screenshots: `dpi150-<viewport>-<theme>-{empty,conversation}.png`.

**The conversation, which the previous run never drove at this scale**, is measured on three
claims instead: the latest turn is on screen (a transcript with entries is *supposed* to rest at
the bottom), the first turn is reachable when wound back to the top, and the transcript clears
the header rule there. All pass at all three viewports in both themes — 73.0px of clearance at
1280×672.

> **A correction to this driver's own first cut, recorded rather than quietly fixed.** It first
> asserted that a conversation opens with its **first** turn on screen, and produced six red
> lines that were not defects: `restingScrollTop` pins a transcript with entries to the bottom,
> which is what a reader wants. The wrong assertion was replaced with the three above. A gate
> that manufactures failures makes real ones unbelievable.

**Control `C5`** — the empty state pinned to the bottom of its scroller, which is where the
pre-fix bundle rested: the mark assertion fails at all three viewports (mark at `-122.7` against
a container starting at `126.5` on the 1366×768 panel).

---

## 5. CONTRAST — computed from the rendered DOM

`src/styles/contrast.test.ts` resolves the token graph in jsdom over 181 declared pairs. That is
a good test answering a different question: whether the **declarations** pair up. This asks what
the engine put on screen — which ancestor's fill is actually behind this text after the cascade,
after alpha compositing, after an ancestor's `opacity` has faded the pair together.

Five surfaces were driven in **both themes** — the home surface, a conversation carrying a real
rendered answer (six heading levels, prose, list, blockquote, inline code, fenced block), the
model switcher popover, the endpoints panel with its Add form open, and the command palette —
producing **273 painted (element, ground) observations, rolled up to 47 distinct pairs, 43 of
them computable**. Every ratio is in `contrast-table.txt`; the raw rows, with the file and the
sample text each was read from, are in `X6-contrast-rendered.json`.

Grounds are composited by walking the real ancestor chain and stacking every non-transparent
`background-color` until an opaque one is reached. Foregrounds are named by reverse-mapping the
painted colour against every `--vela-*` custom property **resolved in that document under that
theme**.

### The result

**Every body-text pair in the light theme clears 4.5:1** — 22 pairs, worst 4.61:1.
**Every body-text pair in the dark theme clears 4.5:1 except one** — see finding A.
Both large-text pairs clear 3:1.

Nine grounds carry **no token at all**: `#112c39`, `#193542`, `#1e2233`, `#e3e5ec`, `#f3f3f4`.
These are composited translucent fills — a `--vela-row-selected` over a surface, a `<kbd>`'s
tint. A token-graph audit cannot compute them; that is the work this instrument is doing.

Four pairs are **not computable** and are reported rather than asserted: the `<kbd>` chips sit
under `opacity: 0.75`, which fades foreground and ground together, and a single ratio there
would be a fiction.

**Control `C6`** — `--vela-text-subtle` reverted to its pre-fix `#6f7896`: five light pairs and
six dark pairs go under 4.5:1, down to **3.34:1**. **Control `C6b`** — `--vela-text` damaged:
3 of 15 body pairs fail, worst 2.23:1. The audit reads the page, not the token file.

---

## 6. THE THREE DEFECTS

### A. The endpoints form's placeholders are painted in a colour Vela never chose — 3.96:1 in dark

**FAIL, and the only failing assertion in this run.**

```
dark   3.96:1   13px/400   #757575  (NO TOKEN)  on  #101426 (--vela-bg-inset)
                                                 [endpoints:<input>::placeholder]
light  4.61:1   13px/400   #757575  (NO TOKEN)  on  #ffffff (--vela-surface)
```

`EndpointForm.tsx` sets three real placeholders — `The workstation in the study` (:138),
`study-box` (:154), `http://127.0.0.1:8080/v1` (:173) — and `EndpointForm.module.css` styles
`.input { color: var(--vela-text) }` with **no `::placeholder` rule at all**. The UA default
`#757575` paints them. Under AA in dark; scraping it at 4.61:1 in light.

The form opens empty, so this text is on screen every time a user configures an endpoint — which
is the first thing anyone does with this application.

**Why the existing audit cannot see it.** `contrast.test.ts` enumerates pairs of **tokens**. This
foreground is not a token, so it is not in the table, and "every token used as a text colour
appears in the table" is satisfied while a real painted string fails AA. The claim in
`platform-defaults/RESULTS.md` — *"every `(foreground, ground)` the components actually paint"* —
is broader than what the test does, and this is the gap between the two sentences.

**Smallest fix, for the builder:** `EndpointForm.module.css` gains
`.input::placeholder { color: var(--vela-text-subtle) }`, which is what `Composer.module.css:47`
and `CommandPalette.module.css:52` already do — those two are the only `::placeholder` rules in
the whole of `src/`. Measured: `--vela-text-subtle` on `--vela-bg-inset` is **5.69:1** in dark.

**Not fixed here.** This report is a gate; whoever fixes it should not be the one who graded it.

### B. `scrollbar-gutter: stable both-edges` regressed the CONV-1 shared ruler at narrow windows

**The wave's own fix broke a guarantee a previous wave had closed.**

The Phase C matrix, re-run on all four profiles, went from the recorded `40 / 38 / 36 / 33
assertions, 0 failures` to **38 / 36 / 34 / 31** — the same two assertions fail on every profile:

```
C29b  they stay on it when the window narrows   text 388–844 (456px), composer 376–856 (480px)
C30   the sidebar gives way to the reading column   1440px → sidebar 480, column 480
                                                     880px → sidebar 352, column 456
```

**Bisected, with the matrix's own instruments.** `tests/harness/production-bundle/drive-ruler-bisect.mjs`
imports `layoutRuler`, `oneVerticalRuler` and `sidebarTracksTheWindow` from the Phase C harness —
nothing is re-implemented — and runs them against the production bundle twice:

```
== SHIPPING — scrollbar-gutter: stable both-edges (0f83c71) ==
  C29a  wide   : PASS  text 720–1200 (480px), composer 720–1200 (480px)
  C29b  narrow : FAIL  text 388–844 (456px), composer 376–856 (480px)
  C30   both   : FAIL  1440px → sidebar 480px, column 480px; 880px → sidebar 352px, column 456px

== WITHOUT the gutter — the declaration removed from the built CSS ==
  C29a  wide   : PASS  text 720–1200 (480px), composer 720–1200 (480px)
  C29b  narrow : PASS  text 376–856 (480px), composer 376–856 (480px)
  C30   both   : PASS  1440px → sidebar 480px, column 480px; 880px → sidebar 352px, column 480px
```

`ruler-bisect.txt`. The cause is exact: `.scroller` reserves 24px unconditionally, the transcript
column lives **inside** the scroller, and the composer lives **outside** it. While the window is
wide enough for the column to reach `--vela-measure` (480px) both boxes are 480px and the ruler
holds. Narrow the window and the column clamps to the scroller's reduced content box — 456px —
while the composer keeps 480px. The two boxes are off by 12px on each side.

**Why nobody saw it, which is the part worth keeping:**

1. The desktop session measured the ruler at **1400×900 only** — wide. Its reading, "left delta
   0", is correct at that width and says nothing about any other.
2. The wave's own gate has an assertion for this — `drive-display-scaling.mjs`'s `-h`, "the
   transcript column and the composer field share one centre line" — and it **compares centres**.
   Both boxes stay centred in the same window, so a pure width difference is invisible to it. It
   reports `column 456.0 vs field 456.0` and passes on a broken ruler. Same class as the font
   defect: the right subject, the wrong quantity.
3. The Phase C matrix does measure **edges**, at two viewports, with the sidebar at its maximum —
   and was never re-run after `0f83c71`.

**For the builder, not decided here:** the gutter has to be reserved by the same box the composer
is centred in, or the column has to be sized against the scroller's content width rather than
inside a reservation. `-h` should compare edges as well as centres, or it will pass on the fix
too.

### C. Two claimed guards do not enforce what their sentences say

Ten mutations against seven guards, each staged in a **detached scratch worktree** and reverted;
the shared tree was never modified. Full record: `contract-ledger-mutations.txt`. Eight caught.
Two defeated — both in the guards whose subject is other guards.

**C1 — `claimed-guards.test.ts` resolves file claims by basename, not by path.**
A comment naming `` `src/app/contract.ts` `` — a path that does not exist — passes, because
`contract.ts` exists at `src/platform/contract.ts`. So does `` `src/features/tauri-adapter.ts` ``.
It fires correctly only when the basename exists **nowhere** (`definitely-not-here.ts` → caught).
`resolves()`'s `path` arm falls back to `BASENAMES.has(...)` and to
`ALL_FILES.some(p => p.endsWith('/' + token))`. The guard enforces *"a file with this name
exists"*, and the file's own header says it enforces *"every backticked token that looks like a
path into this repo must exist on disk"*. A token containing a `/` is a path claim and should
have to resolve exactly.

**C2 — `verify-covers-ci.test.ts` accounts for any CI step whose command has a listed gate as a
prefix.** Its second test exists to catch *"a **new** CI step that nobody listed here"*. A job
running `pnpm test:e2e` passes it, because the filter is `line.includes(ci)` and
`'pnpm test:e2e'.includes('pnpm test')` is true. `pnpm test:*`, `pnpm build*` and any
`cargo test …` variant are all silently accounted for and never have to reach `pnpm verify` —
which is precisely the failure the file was written after. A step with no overlap
(`./scripts/ledger-probe.sh`) is caught, so the machinery works; the comparison is too loose.

**What was attacked and held**, so this is not a list of everything that was tried:
`rust_and_typescript_allowlists_are_identical` (a name added to the TS allowlist only → red);
`every_command_takes_exactly_one_argument_and_it_is_named_payload` (a command taking `req` → red),
which is what conventions.md §3.1 stakes "there is no exception to this rule" on;
`claimed-guards`' named-test arm (the ninth false enforcement's own shape → red);
`adapter.test.ts`'s single-importer rule → red; `design-system.test.ts` on a raw hex and on an
undefined `var(--vela-…)` → red; `contrast.test.ts`'s completeness scan → red; and
`chat-contract-parity.test.ts`, the test written to close the ninth false enforcement, which
genuinely enforces (renaming `ContentPart::Reasoning` in Rust → red).

---

## 7. REGRESSION — everything else re-run, and the bundle-size delta

| gate | result |
|---|---|
| `pnpm test` (vitest) | **68 files, 1498 tests, 0 failures** |
| `cargo test --workspace --locked` | **929 tests, 0 failures**, 44 binaries |
| composition-root gate (`drive-app-root.mjs --controls`) | **42 assertions, 0 failures** — includes P17–P20 typeface and P6 zero-egress, with controls K6a–K6d, K7, K8a–K8c |
| platform-defaults gate (`drive-display-scaling.mjs --controls`) | **88 assertions, 0 failures** |
| **Phase C matrix, four profiles** | **38 / 36 / 34 / 31 — two failures per profile.** Was 40 / 38 / 36 / 33, 0 failures. See finding B |
| B2 matrix (`gate_m_phase_b2`) | **1455 gate assertions, 0 failures**, 46 controls behaving as expected, 25.9s |
| this executor's gate | **134 assertions, 1 failure** — finding A |

### Bundle-size delta — what the typeface costs

Built at `410936b~1` (the commit before `@fontsource` landed) in a scratch worktree, against
HEAD. Source maps excluded, since they are not shipped:

| | pre-typeface | shipping | delta |
|---|---|---|---|
| JS | 340,387 B | 340,511 B | +124 B |
| CSS | 65,222 B | 68,216 B | +2,994 B (the `@font-face` rules) |
| fonts | 0 B | 183,456 B | **+183,456 B** |
| **total shipped** | **406,052 B** | **592,626 B** | **+186,574 B (+45.9%)** |

The four faces: Inter roman 48,256 B + italic 51,832 B; JetBrains Mono roman 40,404 B + italic
42,964 B. **The italics are 94,796 B — 52% of the font weight** — and exist because `P17c`/`P18c`
require a real italic cut rather than a synthesised oblique. Whether markdown emphasis and code
comments are worth 95 KB is an operator's call, not a gate's; the number is here so it can be
made.

**On the RAM concern, honestly.** +183 KB of compressed woff2 on disk; decompressed and rasterised
they are a fraction of a megabyte resident. Against the 360.6 MB idle RSS the desktop session
measured for Vela's process tree, that is roughly **0.05%**. The typeface is a real 46% increase
in *bundle* and a rounding error in *memory*, and those two sentences should not be swapped.

---

## 8. ASSERTION CONTROLS — every assertion in this run, applied where it must not hold

Every control serves a **rewritten response body** from a copy of the real bundle, or stages the
mutation in a **detached scratch worktree**. No byte of the shared tree was modified by any
control, and every worktree mutation was reverted before the next.

| control | what it damages | which assertions must fail | outcome |
|---|---|---|---|
| `C1` | every `@font-face` stripped from the built CSS | all 7 `X1-*-loaded` and all 7 `X1-*-painted` | all 14 flipped; requested advances collapse to the absent control exactly |
| `C3` | `color-scheme: dark` → `light dark` | `X3-dark-oslight-painted` | UA painted a **white** widget on `#080b16` |
| `C5` | the empty state rested at the bottom of its scroller | `X5-*-empty-mark` at all three viewports | all 3 flipped; mark at −122.7 on the 1366×768 panel |
| `C6` | `--vela-text-subtle` → pre-fix `#6f7896` | `X6-light-body-aa`, `X6-dark-body-aa` | both flipped; 11 pairs under AA, worst 3.34:1 |
| `C6b` | `--vela-text` → a mid-ramp step | `X6-light-body-aa` | flipped; 3 of 15 pairs under AA, worst 2.23:1 |
| ruler bisect | `scrollbar-gutter` removed | `C29b`, `C30` flip from FAIL to PASS | both flipped — which is what identifies the cause |
| `L1b` | a path claim whose basename exists nowhere | `claimed-guards` "names only files that exist" | fired — so the resolver is not simply returning `true` |
| `L7b` | a CI step sharing no substring with a gate | `verify-covers-ci` "every gate command … accounted for" | fired — so the machinery works and only the comparison is loose |

Two further controls are inherited and were re-run rather than trusted: `K6a`–`K6d` (the width
control controlled, including the pre-fix bundle) and `K8a`–`K8c` (the italic assertions
controlled), both green in the composition-root gate.

One control is **absent and that is disclosed**: there is no control for the painted scrollbar,
because this engine paints no scrollbar to damage. See §3.

---

## 9. A note on how this evidence reached the tree

Most of the artefacts in this directory, and the re-driven Phase C matrix they refer to, were
committed at `4a374aa` — *"Re-captured Phase C matrix: every screenshot now renders in the real
typeface"* — by a **concurrent agent in the same session**, while this run was still in progress.
Nothing was lost and no content differs; recording it because two facts follow from it.

**First, that commit's message is right about the screenshots and silent about the regression.**
Re-capturing a baseline whose every image was taken in a fallback face is legitimate, and the
message argues that well. But the same commit also landed four `assertions.tsv` files carrying
`C29b` and `C30` as **FAIL** — `38+2 / 36+2 / 34+2 / 31+2` — and describes the change as evidence
catching up to a fix. A baseline that records two red assertions per profile is not a baseline
catching up; it is a regression being committed as a picture. Finding B is that regression.

**Second, a green `git diff` over this directory means less than usual right now.** The evidence
was written by this run and committed by another process between the writing and the reading, so
"unmodified" here is not independent confirmation of anything. The numbers in this report come
from the run logs (`run-log.txt`, `ASSERTION-LEDGER.tsv`, `ruler-bisect.txt`), not from the
absence of a diff.

---

## 10. What the desktop session must settle

1. **Finding B on WebView2.** The ruler regression is measured in an engine with *overlay*
   scrollbars, where the 24px gutter comes entirely from the declaration. On Windows a classic
   scrollbar also takes width, so the interaction may be different — worse, or partly
   self-cancelling. Measure the transcript's text edges against the composer's box edges at
   **1400×900 and again at ~880px**, sidebar dragged to maximum. The wide reading alone is how
   this got in.
2. **Finding A on WebView2.** Whether WebView2's default `::placeholder` colour matches
   Chromium's `#757575`. The defect is that Vela does not choose the colour at all, which is
   engine-independent; the exact ratio is not.
3. **The painted scrollbar after any fix to B**, since the fix will touch `scrollbar-gutter`.
4. Everything in `docs/desktop-gate/REQUESTS.md` that this run could not reach.
