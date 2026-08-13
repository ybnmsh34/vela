# GATE M — the composition root, driven for real

**Verdict: PASS.** With three findings recorded below, none of them blocking, and a hard limit
on what a headless Linux container is entitled to conclude.

This gate exists because of one sentence in the wave brief: *every gate this project has run
drove a bridge, an example, or a component — never the real assembled application.* That is how
1455 passing assertions accumulated against a product that did not start on the operator's
machine. A gate that verified the composition root through another bridge would have failed at
its only job, however green its numbers.

---

## 0. Honesty — read before quoting any number

Per `docs/architecture/conventions.md` §10, **everything here is VERIFIED-BY-FAKE**:

- **No byte of any answer came from a language model.** Every endpoint in this gate is either a
  loopback socket whose response bytes are written in the test file, or the deterministic
  `tests/harness/mock-provider`. Nothing here is evidence about llama.cpp, Ollama, vLLM, or any
  hosted API. GATE M Part 2 is the desktop session's and remains so.
- **The credential store is `MemoryStore`.** The Rust gate runs without the `os-keychain`
  feature; one of its assertions is that the app *says* `memory-fake` rather than letting the
  substitution be silent. Nothing here is evidence about Windows Credential Manager — that is
  A3's `keychain-runtime` PASS, at its own sha.
- **Neither renderer is the Tauri webview.** The Rust gate runs on `tauri::test`'s mock runtime,
  which implements the `Runtime` trait with no windowing system at all. The frontend gate runs
  in **Chromium on Linux**. Neither is WebView2 and neither is WebKitGTK.

### What this gate is NOT allowed to conclude, and why

| Claim | Why not here | Whose it is |
|---|---|---|
| The shipping window paints | The mock runtime has no webview; Chromium is not WebView2 | desktop `visual` / `interaction` |
| The Windows build works | `tauri-build`'s `icon.ico` requirement only fires when the target OS is windows | desktop |
| Case-insensitive resolution is fixed | Linux is case-sensitive. The guard checks *names*; it cannot make this filesystem fold case | desktop |
| Any statement about a real model | No model was contacted | desktop, GATE M Part 2 |
| Cold start, idle RAM, throughput | A shared Linux container is not a Windows desktop binary | desktop `performance` |

Naming these is the reason this project has two sessions. It is not a hedge.

---

## 1. What was actually driven — the layer table

The distinction this whole gate turns on:

| Layer | every previous gate | **this gate** |
|---|---|---|
| `AppState::for_runtime()` | never constructed by any test | constructed by `configure()` |
| `run()`'s builder configuration | asserted by `include_str!`-grepping `lib.rs` for `"sync_from_settings"` | **executed** |
| `setup` — open the database, fill the provider set, install the debug-log handle | never run anywhere | **executed** |
| the `generate_handler!` allowlist | asserted by comparing two lists of strings | **dispatched through, by name** |
| `chat_send` | reimplemented by the test as `build_request` + `resolve_provider` + `run_turn` | **called** |
| the `chat:event` channel | a `Vec` the test owned | the real `Emitter` path, read by a real `listen` |
| the frontend root | components, or a *variant* entry point with the adapter swapped | **`dist/index.html` → `src/main.tsx` → `<App/>`, no adapter argument** |

`run()` was made drivable by lifting its builder configuration into
`vela_lib::configure<R: Runtime>(Builder<R>) -> Builder<R>`. `run()` is now `configure(...)
.run(context)` and nothing else, so there is exactly one description of how Vela is assembled
and this gate drives that one. `chat_send` and `WindowSink` became generic over
`tauri::Runtime`; nothing else in the host moved.

---

## 2. Results

| Suite | Assertions | Failures |
|---|---|---|
| `src-tauri/tests/gate_m_assembled_app.rs` — the assembled host | **14 tests** | 0 |
| `tests/harness/production-bundle/drive-app-root.mjs` — the built bundle in Chromium | **19** | 0 |
| its assertion controls | **6** | 0 (all behaved as expected) |
| guard controls (case collision, bundle icons) | **6** | 0 (all behaved as expected) |
| Rust composition-root assertion controls | see §6 | — |
| Phase C matrix, 4 profiles re-run | **98** (25/25/25/23) | 0 |
| Phase C assertion controls | **28** | 0 (all behaved as expected) |
| Phase B2 matrix re-run | **1455** | 0 |
| Phase B2 assertion controls | **46** | 0 (their FAILs are expected) |
| `cargo test --workspace` | **914** | 0 |
| `pnpm test` | **1312** | 0 |
| `pnpm test:harness` | **135** | 0 |

`pnpm typecheck`, `cargo fmt --check`, `cargo clippy -D warnings`, `pnpm test:transcripts`
(byte-identical regeneration) and `pnpm test:secrets` are all clean.

### 2.1 The central claim, and its control

**Claim.** Configure a provider through the real `settings_put_provider` command; send a turn
through the real `chat_send` command; the bytes arrive at the address the user typed, and the
answer comes back on the real `chat:event` channel with reasoning on its own channel.

```
a_turn_sent_through_the_real_chat_command_reaches_the_configured_endpoint ... ok
    POST /v1/chat/completions, body contains "what is 17 times 23?"
    textDelta      "three hundred and ninety one"
    reasoningDelta "counting on my fingers"     (never in the answer channel)
    last event     done
    every event carries turnId "turn-1"
```

**The negative control, in the same file and the same process.** A settings row on disk with
nothing live — the exact pre-fix wiring — answers `NOT_FOUND` and reaches no socket at all.
Going through the real command instead makes the identical endpoint reachable:

```
the_pre_fix_wiring_still_reproduces_not_found_on_demand ... ok
    chat_send -> {"code":"NOT_FOUND", ...}   endpoint saw 0 requests
    then, same process, same endpoint, through settings_put_provider:
    textDelta "three hundred and ninety one"
```

Phase C's `K21` reproduces the same symptom from the other side, through the bridge's
`--no-register` flag, and still behaves as expected.

### 2.2 Persistence — the distinction the brief drew, kept

The brief's wording is the standard: *in-memory state that survives navigation but not a
restart is not persistence.* The two halves are proven in the two places that can prove them.

**Navigation** (frontend, production bundle). `App.tsx` keys the conversation surface on the
conversation id, so switching conversations and switching back **destroys and rebuilds** the
component. Anything still on screen afterwards came from the store, not from component state.

```
P13  a sent turn appears in the transcript              {"user":1,"assistant":1}
P14  navigating away leaves the transcript behind       {"user":0,"assistant":0}
P15  coming back restores it, with the sent text        {"user":1,"assistant":1}
P16  and does not re-run the turn                       1 -> 1 assistant turns
```

**Restart** (backend, assembled host, SQLite on disk). The whole application is torn down and a
new one built over the same data directory — new `AppState`, new store handle, nothing in
memory.

```
a_turn_written_through_the_shipping_commands_survives_a_cold_restart ... ok
    within the session:  2 messages
    after the restart:   2 messages, roles [user, assistant],
                         assistant text "three hundred and ninety one",
                         conversation listed by title from cold
the_assembled_app_writes_a_database_file_to_the_application_data_directory ... ok
nothing_is_readable_before_anything_is_written ... ok      (the control)
```

The navigation half runs against `BrowserAdapter`, whose store is in-memory; it proves the
**wiring**, not the durability. The durability is the Rust half, against a file. Neither claim
is made with the other's evidence.

### 2.3 The context meter — Phase C's only FAIL, closed

Phase C failed on C5: the meter read **"About 0 of 200,000 tokens"** while the composer held
880,000 characters. That was not a missing warning; it was a quantity on screen that was false,
and it told the user they had room they did not have.

Re-run against the current tree, on all four profiles:

| profile | C5 before | C5 now |
|---|---|---|
| frontier | FAIL — `About 0 of 200,000 tokens` | **PASS** — `About 220,005 of 200,000 tokens — this turn is larger than the window…` |
| mid-local | FAIL — `About 0 of 32K tokens` | **PASS** — `About 36,049 of 32K tokens — …` |
| small-local | FAIL — `About 0 of 8K tokens` | **PASS** — `About 9,016 of 8K tokens — …` |
| hostile | FAIL — `About 0 of 4K tokens` | **PASS** — `About 4,510 of 4K tokens — …` |

And the other half of the requirement — `unknown` where no figure can honestly be computed —
holds in the production bundle, where the endpoint reports no window:

```
P8   with no endpoint configured, no figure is stated at all
     (the meter is not rendered before a model is selected)
P9   typing 880,000 characters:
     before  "Context window not reported by this endpoint · about 0 tokens in this turn"
     after   "Context window not reported by this endpoint · about 220,004 tokens in this turn"
P10  the meter never claims a window this endpoint did not report
K4   CONTROL: the same assertion fails on an empty draft
```

So the meter now moves with what the turn holds, warns before the turn is sent when it will not
fit, and says which of the two numbers it does not have — instead of computing one from an empty
input and printing it as fact.

### 2.4 Zero browser-to-endpoint requests, measured twice

The architectural rule is that all provider HTTP originates in the Rust core. The traps are
installed by `addInitScript`, i.e. before the first module evaluates — and that is *measured*,
not assumed:

```
P6a  the traps were installed before the document had a body   document.readyState = "loading"
P6b  zero fetch / XHR / WebSocket / EventSource / sendBeacon calls        []
P6c  Chromium's own request event saw nothing leave the page origin       []
P11  still zero after configuring an endpoint and typing 880,000 chars
```

Both an in-page trap and Chromium's network-level `request` event, because an in-page trap can
be side-stepped (a fresh iframe's `fetch`, an `img.src`, a `<link>`) and a network-level count
cannot. Controls `K2a`/`K2b` show both catching real traffic when it is made. The page is served
under the **shipping** Content-Security-Policy from `tauri.conf.json`, not a permissive one.

The Phase C matrix asserts the same thing against the *real* endpoints, on all four profiles:
`C20` and `C21` — the browser never requested the model endpoint, fast or slow.

---

## 3. Findings

### FINDING 1 — the wave's own controls K25–K28 had never been executed

`81b1b12` added four assertion controls to `tests/harness/ui-bridge/controls.mjs`. They had
never run. The controls script died before reaching them: K25's setup reloads the page and waits
for `#vela-composer`, but a reload returns the app to the home surface — a conversation
selection is process state, not a URL — so it timed out and took K25 through K28 with it. The
committed `ASSERTION-CONTROL.tsv` stops at K21, which is the visible symptom nobody followed up.

**This is the wave's own defect class, in the wave's own output: written, and never run.** It is
recorded here rather than quietly fixed, because the pattern is the point. Fixed in the harness
by reopening a conversation the way a user would; controls now **28/28 behaved as expected**.

Severity: test infrastructure only. Non-blocking.

### FINDING 2 — `provider_host.rs`'s structural guard is now redundant, and should say so

`the_real_app_builder_fills_the_provider_set_at_startup` asserts the composition root by
`include_str!`-ing `lib.rs` and grepping it for the strings `"sync_from_settings"` and
`"AppState::for_runtime()"`. Its own comment explains why: *"`run()` itself needs a windowing
system and cannot be executed here."* That is no longer true — `tests/gate_m_assembled_app.rs`
executes it.

The grep still passes and is harmless, but a text search over a source file is a weaker
statement than the behaviour it stands in for, and leaving it unqualified invites the next
reader to treat it as the real check. Left in place, un-edited: **an executor who edits what he
grades is manufacturing agreement.** Recorded for the piece's builder.

Severity: documentation. Non-blocking.

### FINDING 3 — a reload drops the open conversation

Surfaced by FINDING 1's diagnosis rather than looked for. Reloading the renderer returns the app
to the home surface: the selected conversation lives in process state and nothing restores it.
In the shipping desktop app a reload is rare, so this is a small matter — but the conversation
*is* in the database, and the app already knows how to reopen it.

Not raised as a gate failure: the brief's persistence requirement is navigation and restart of
the **backing store**, and both hold. Recorded as a product observation for whoever owns
navigation.

Severity: minor UX. Non-blocking.

---

## 4. What the wave fixed, confirmed by execution

Each of the five recorded instances of "built, tested in isolation, never connected", checked
against behaviour rather than against a diff:

| # | The instance | How it is confirmed here |
|---|---|---|
| 1 | provider registry never populated | a turn through the real `chat_send` reaches the endpoint; the pre-fix wiring reproduces `NOT_FOUND` on demand |
| 2 | `ChatMessageInput` could not carry an image or a tool | both arrive on the wire through the shipping command; a turn that offers neither puts neither there |
| 3 | `ContextMeter` never received `turnTexts` | C5 PASS on four profiles; P9/P10 in the production bundle |
| 4 | `icon.ico` missing / build composition | the icon guard is green, and three controls show it going red |
| 5 | the transcript store nobody called | P13–P16 across a remount, and a cold restart in Rust |
| + | the `trace` id pointed at a log with no switch | `diagnostics_debug_log_get/set` reachable from the assembled app, and off by default |
| + | the `Markdown`/`markdown` case collision | the guard is green, and two controls reproduce both hazards |

---

## 5. Files

```
docs/regression-baseline/gate-m-composition-root/
├── RESULTS.md                          this file
├── ASSERTION-CONTROL.txt               the Rust controls: the composition root broken, joint by joint
├── GUARD-CONTROLS.txt                  the case-collision and icon guards, proven able to fail
├── ASSERTION-LEDGER.tsv                every frontend assertion, verdict and detail
├── production-bundle-session.json      scripts loaded, requests seen, console, meter readings
├── 01-production-bundle-cold.png       the built bundle, first paint, nothing configured
├── 02-production-bundle-large-draft.png  880,000 characters in the composer
└── 03-restored-after-navigation.png    the turn, after leaving the conversation and coming back
```

Reproduce:

```bash
cd src-tauri && cargo test --test gate_m_assembled_app

pnpm build
export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
export VELA_PLAYWRIGHT=/opt/node22/lib/node_modules/playwright/index.js
node tests/harness/production-bundle/drive-app-root.mjs --controls

scripts/gate-m-composition-root-controls.sh
```

---

## 6. ASSERTION CONTROLS

Numbers mean nothing until the assertions behind them have been watched failing. Three separate
control suites, none of which put a defect in the shared tree — every mutation happens in a
detached `git worktree` under `$TMPDIR`, with its own `CARGO_TARGET_DIR`.

### 6.1 The composition root, broken joint by joint

`scripts/gate-m-composition-root-controls.sh`; full output in `ASSERTION-CONTROL.txt`.

<!-- CONTROLS-TABLE -->

### 6.2 The frontend assertions

Run with `--controls`; ledger in `ASSERTION-LEDGER.tsv`.

| id | control | result |
|---|---|---|
| K1 | P1/P2 applied to a page with an empty `#root` | fails, as it must |
| K2a | the in-page traps, when fetch/XHR/WebSocket/EventSource *are* used | all four recorded |
| K2b | Chromium's `request` event, when an off-origin request is made | seen |
| K3 | P4/P5 applied after a real `console.error` and a real uncaught throw | both caught |
| K4 | P9 applied to an empty draft | fails, as it must |
| K5 | the served policy is the shipping CSP, confining connections to `self` | confirmed |

### 6.3 The two guards

`GUARD-CONTROLS.txt`. Both are guards for defect classes this container is blind to by
construction, so a guard that has never been seen to fail is indistinguishable from one that
cannot fail.

| id | violation staged in the scratch worktree | guard |
|---|---|---|
| G0 | none — the unmodified tree | both green, 125 assertions |
| G1 | `markdown-parser.ts` renamed back to `markdown.ts` — **the exact shipped defect** | red: case-ambiguous module stems |
| G2 | a second `markdown.tsx` beside `Markdown.tsx` | red: both hazards, checkout collision *and* stem ambiguity |
| G3 | `icons/icon.ico` deleted | red: missing, and not an ICO |
| G4 | `icons/icon.ico` replaced with eleven bytes of text | red: not an ICO |
| G5 | a `bundle.icon` entry deleted from disk | red: declared but absent |

After every control the scratch worktree is restored and `git status` is empty. The shared
checkout is never written.

### 6.4 Phase C and Phase B2

Re-run in full on the wave's output: Phase C **28/28** controls behaved as expected (K1–K28,
including the four that had never run — FINDING 1), Phase B2 **46** controls, their FAILs
expected.
