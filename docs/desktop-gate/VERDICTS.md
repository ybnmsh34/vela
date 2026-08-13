# Vela — Desktop Gate: VERDICTS

**This file is written by the DESKTOP session. The cloud session only reads it.**

The desktop session is a separate Claude Code session running on the operator's Windows
machine against this same repo. It owns five verdicts the cloud session is structurally
incapable of producing. The two sessions share no context and coordinate ONLY through the
files in this directory.

---

## How to write an entry

Append one block per verdict. Key every entry by **piece-id AND commit sha** — both are
required, because a verdict against stale code does not count.

```
## <piece-id> — <critic>
- commit: <full sha the verdict was produced against>
- critic: performance | keychain-runtime | visual | interaction | real-model
- verdict: PASS | FAIL
- largest_gap: <if FAIL, the single largest actionable gap; omit if PASS>
- evidence: <screenshots committed under docs/desktop-gate/evidence/, numbers measured,
             transcripts captured — real artifacts, not assertions>
- environment: <Windows version, WebView2 version, hardware — so results are interpretable>
```

## Rules governing these verdicts

Binding on both sessions:

1. **Strict binary.** PASS or FAIL. Never a score, never a percentage, never "mostly".
   No averaging, no majority vote.
2. **A FAIL here is exactly as binding as a cloud-side FAIL.** It sends the piece back to
   its builder and the loop runs again. The cloud session may not override it, discount it,
   or argue "but it passed in the container".
3. **PASS is explicitly permitted.** "No meaningful gap" and "no regression" are complete,
   acceptable reports when true. Do not manufacture failures to appear rigorous — that makes
   real FAILs unbelievable.
4. **Staleness.** If the sha in an entry is older than the current HEAD *for that piece*, the
   cloud session treats the verdict as STALE, does not count it, and re-requests it.
5. **Fail closed.** A critic that cannot actually obtain its external reference (cannot launch
   the app, cannot reach the model, cannot fetch the comparison target) must return FAIL and
   say it could not obtain the reference. Never invent a comparison and pass.
6. **No self-grading.** Whoever built a piece may not grade it.

## The five deferred critics

| Critic | Why the cloud session cannot produce it |
|---|---|
| `performance` | Cold start, idle RAM, and streaming throughput in a shared Linux container are meaningless for a Windows desktop binary. |
| `keychain-runtime` | No Credential Manager / Keychain / libsecret exists in the container. Cloud reviews the credential code path statically; only desktop can assert the OS integration actually works. |
| `visual` | Cloud can only render Linux WebKitGTK, which differs materially from WebView2 on Windows. Cloud verdicts are ADVISORY and PROVISIONAL. |
| `interaction` | Same rendering-engine problem, plus no real input latency, window management, or focus behavior. |
| `real-model` | GATE M Part 2. The llama.cpp server (Qwen3.6-27B, n_ctx 131072, vision via mmproj, `<think>` on by default) is on the operator's Windows host behind home NAT and is unroutable from the cloud sandbox. |

### Specific guidance for `real-model` (GATE M Part 2)

Follow the brief's CHARACTERIZE-BEFORE-CONCLUDING discipline, and record raw transcripts to
`docs/regression-baseline/local-smoke/` so they can be inspected rather than summarized:

- `GET /props` → record real `n_ctx`, slot count, server settings.
- `GET /v1/models` → record the exact model id string.
- `POST /v1/chat/completions` with `tools[]` → structured `tool_calls`, or plain text? If plain
  text, that is a possible **SERVER CONFIG** issue (llama.cpp may need `--jinja`). Report it as
  such. Do **NOT** record it as a Vela defect and do **NOT** record it as a model-capability finding.
- POST an image input → confirm the vision path works end to end.
- Send a prompt exceeding `n_ctx` → confirm Vela surfaces the context error gracefully.
- Confirm Vela separates `<think>` reasoning from the final answer AND excludes it from
  tool-call parsing.

**Concurrency:** `n_slots = 4`, `kv_unified = true`. Run serially, max 2 in flight.
**Do not restart or reconfigure the server.**

> **Interpretation limit, binding on both sessions:** this model is 27B, vision-capable,
> 131k-context, and reasoning-enabled — a STRONG model. Passing against it proves the happy
> path ONLY. It is never evidence of graceful degradation or model-agnosticism; that evidence
> comes exclusively from the GATE M Part 1 mock matrix.

---

## Verdicts

_None recorded yet. The desktop session appends below this line._

## GATE-M2-real-model — real-model

- commit: `51b5e163df22958853b24a281aa40268b5a1f44f`
- critic: real-model
- verdict: **FAIL**
- largest_gap: **The shipping desktop app cannot reach any model endpoint.**
  `AppState::for_runtime()` builds `ProviderRegistry::new()` (`src-tauri/src/state.rs:42`) and
  nothing in the host ever registers a provider — `grep -rn "OpenAiCompatibleProvider\|CompatProvider"
  src-tauri/src/` returns **zero matches**. So `resolve_provider` (`src-tauri/src/ipc/chat.rs:225`)
  returns `NOT_FOUND` for every configured id, and a turn sent from the real UI can never reach
  `localhost:8033`. This is the repo's own FINDING 1 (`src-tauri/examples/ui_matrix_bridge.rs:42`);
  it is recorded here as a desktop FAIL because it is the single thing standing between the
  provider core — which works — and a real end-to-end turn.

### What was proven to work, against real model bytes

Driven through `ui_matrix_bridge`, which wraps the **real** `vela_lib::ipc::*` command functions,
the real `OpenAiCompatibleProvider` and the real `ReqwestTransport` — the only layer it substitutes
is the browser transport, not the core:

- **Reasoning separation is correct.** 266 `reasoningDelta` events, 3 `textDelta` events,
  final answer `"391"` — correct and clean. No `<think>` markup and no reasoning prefix leaked
  into the answer channel.
- **Reasoning streams immediately**: first `reasoningDelta` at **0.57 s**, first `textDelta` at
  **10.21 s**. The UI has something to draw for the ~10 s before the answer exists.
- **Clean termination**: `done` received, no hang, 10.32 s total.
- Evidence: `docs/regression-baseline/local-smoke/10-vela-bridge-normal.jsonl`
- **Reasoning is correctly excluded from conversation history.** A two-turn exchange was run
  through a logging passthrough proxy, so the real model answered *and* the exact outbound bytes
  were captured. Turn 1 produced 295 reasoning deltas and the answer `"391"`. Turn 2's request body
  carried only:

  ```json
  [{"role":"user","content":"What is 17 * 23? Reply with only the number."},
   {"role":"assistant","content":"391"},
   {"role":"user","content":"Now multiply that result by 2. Only the number."}]
  ```

  No `reasoning` key and no `<think>` anywhere in either body, and the model answered `782` —
  so the history was not merely clean but semantically usable. Top-level keys are exactly
  `messages`, `model`, `stream`, `stream_options`.
  Evidence: `docs/regression-baseline/local-smoke/13-vela-multiturn-history.json`
- **Cancellation actually reaches the GPU**, verified against llama.cpp's own `/slots`, which is
  the only way to tell a real abort from a client that merely stops listening while the server keeps
  generating. Before the turn: 0 slots processing. Mid-generation: **1 slot processing**. On
  `chat_cancel` the stream terminated in **0.00 s** with the typed `{"error":{"kind":"cancelled"}}`,
  and one second later `/slots` reported **0 processing** — the upstream request was genuinely
  aborted and the slot freed.
  Evidence: `docs/regression-baseline/local-smoke/14-vela-cancel.jsonl`

### Blocking findings

1. **Empty provider registry** — see `largest_gap` above. Blocks every real-model item end to end.

2. **Vision and tool calling are structurally unreachable through the app's IPC.**
   `ChatMessageInput` is `{ role, text: String }` and `ChatSendReq` has no `tools` field
   (`src-tauri/src/ipc/chat.rs:60,67`); `build_request` maps every message to exactly one
   `ContentPart::Text` (`:206-210`). `grep -n "tools\|image\|attachment" src-tauri/src/ipc/chat.rs`
   returns **zero matches**. Two of the six required GATE-M2 items therefore cannot be exercised
   through Vela at all, independent of finding 1. Both work on the server (see below).

3. **The Windows build is broken.** `pnpm tauri dev` fails at `tauri-build`:
   `` `icons/icon.ico` not found; required for generating a Windows Resource file ``.
   `src-tauri/icons/` tracks four PNGs and no `.ico`; no script or CI step generates one, and
   `tauri.conf.json` `bundle.icon` lists only the PNGs. Linux does not require the `.ico`, so no
   cloud run can see this. **The repo cannot be built on Windows as committed.** To obtain the
   evidence above I generated a local `icon.ico`, kept it untracked via `.git/info/exclude`, and did
   not commit it — the FAIL stands and is not repaired here.
   Evidence: `docs/desktop-gate/evidence/GATE-M2-real-model/build-failure-windows.txt`

4. **The context-overflow error is surfaced but stripped of everything actionable.**
   Vela fails fast and typed (0.89 s, no hang, no silent truncation) with
   `{cause: endpoint_rejected_request, status: 400}` — but the server's message
   `"request (200018 tokens) exceeds the available context size (131072 tokens)"`, its
   `"type": "exceed_context_size_error"`, and its `n_prompt_tokens` / `n_ctx` integers are all
   discarded. Cause: `map_error_response` reads the code via
   `error.get("code").and_then(Value::as_str)` (`src-tauri/crates/vela-providers/src/openai_compatible/mod.rs:42`),
   but llama.cpp sends `"code": 400` as a **number**, so `as_str` yields `None`, `map_known_code`
   never runs, and the context-length number extractor behind it never runs either. A mock emitting
   a *string* code passes this; the real server does not. The user is told "the endpoint refused the
   request (400)" instead of "your prompt is 200k tokens, the limit is 131k".
   Evidence: `docs/regression-baseline/local-smoke/11-vela-bridge-overflow.jsonl`,
   `09-context-overflow.response.json`

### Server characterization — NOT a Vela result

Recorded so no builder chases a defect that is not in the code.
Raw bytes in `docs/regression-baseline/local-smoke/`, request bodies in `00-requests.md`.

- `/props`: `n_ctx` **131072**, `total_slots` **4**, `modalities.vision: true`,
  `system_fingerprint` `b8833-45cac7ca7`. Model id `unsloth/Qwen3.6-27B-GGUF:Q5_K_M`.
- **Tool calling WORKS — there is NO `--jinja` problem.** A `tools[]` payload returns structured
  `tool_calls` with proper `id`, name and `{"city":"Tel Aviv"}`, `finish_reason: "tool_calls"`.
  ⚠️ Note for whoever reads `/props` next: it reports `chat_format: "Content-only"` and
  `reasoning_format: "none"`, which is the exact signature of a server *without* `--jinja`.
  That reading is **wrong here** — those are the no-tools defaults, and b8833 switches per request.
  Concluding "tool calling is broken" from `/props` alone would file a false defect.
- **This server emits NO `<think>` tags.** Reasoning arrives in a dedicated field —
  `message.reasoning_content` non-streaming, `delta.reasoning_content` streaming — and `content`
  is clean. The brief, `REQUESTS.md` and this file all state `<think>` blocks arrive "BY DEFAULT";
  against this server that is **false**. Vela reads the dedicated field at
  `src-tauri/crates/vela-providers/src/stream.rs:216`, which is why item 6 passes. Its `<think>`
  splitter is correct but is never exercised by this endpoint.
- **Vision works** end to end at the server: a generated 64×64 PNG, left half `#FF0000`, right half
  `#0000FF`, was read back as "The left half is red and the right half is blue."
- **Over-context** returns HTTP 400 in 2.6 s with a fully typed body.
- Throughput 27.9 tok/s generate, 103 tok/s prompt. On "Name three primary colors. Brief.":
  first reasoning token 2.35 s, first **content** token **23.08 s**, 575 reasoning deltas vs 7
  content deltas. At a 300-token cap the same prompt produced **575 reasoning deltas and zero
  content deltas**, finishing `length` — a complete response containing no answer. Any client that
  renders only `delta.content` shows a blank bubble for 23 s, or forever.

> **Interpretation limit, restated because it binds this result.** Qwen3.6-27B is a strong model:
> 27B, vision-capable, 131k-context, reasoning-enabled. The passing items above prove the
> **happy path only**. They are NOT evidence of graceful degradation and NOT evidence of
> model-agnosticism — that comes exclusively from the GATE M Part 1 mock matrix. Note also that the
> one place this run diverged from the mocks (a numeric `error.code`) is precisely where Vela broke.

- evidence: `docs/regression-baseline/local-smoke/` (raw HTTP transcripts, SSE bodies, the vision
  input PNG, and both Vela bridge event streams);
  `docs/desktop-gate/evidence/GATE-M2-real-model/` (Windows build failure log)
- environment: Windows 11 Home 10.0.26200 · WebView2 Runtime 151.0.4129.78 ·
  Intel i7-11700K · 63.8 GB RAM · rustc 1.97.1 / cargo 1.97.1 (MSVC) · node v24.15.0 · pnpm 10.33.0 ·
  llama.cpp b8833-45cac7ca7 on Tesla V100 32GB, unmodified and not restarted
- staleness: tested at `51b5e16`; `origin` was at `11c46d1` when this was pushed. The five
  intervening commits (`e3cd67a`, `18ba572`, `a3b8b18`, `ec6f068`, `11c46d1`) are evidence
  snapshots only — `git diff 51b5e16 11c46d1 -- src-tauri/src/state.rs src-tauri/src/ipc/chat.rs
  src-tauri/icons/ src-tauri/crates/vela-providers/src/openai_compatible/mod.rs
  src-tauri/crates/vela-providers/src/stream.rs` is **empty**. Every surface this verdict rests on
  is byte-identical at `11c46d1`. **This verdict is NOT stale and does not need re-requesting.**
- `NOT_FOUND` is confirmed **at runtime**, not merely from code. Running the bridge with
  `--no-register` — the flag it provides precisely to reproduce the shipping host — yields
  `{"ready":true,"registered":false,"seeded":true}`, and then:

  ```
  chat_send   -> {"err":{"code":"NOT_FOUND","message":"no provider configured with id `local`"}}
  models_list -> {"err":{"code":"NOT_FOUND","message":"no provider configured with id `local`"}}
  ```

  Note `seeded: true`: the settings row **is** written. So the user configures an endpoint and the
  app then tells them no provider is configured with that id. The message is not merely unhelpful,
  it directly contradicts what the user just did.
  Evidence: `evidence/GATE-M2-real-model/12-shipping-host-not-found.jsonl`
- limits of this run: the app compiled and launched once a local `icon.ico` was supplied, but
  **it renders a blank window** — see the standalone finding below, which supersedes the earlier
  note that it "launched successfully". `visual`, `interaction` and `performance` were not requested
  and are not judged here; they are in any case unobtainable until the app renders.

---

## UNREQUESTED DESKTOP FINDING — the app cannot boot on Windows

Filed outside the request queue because it blocks every future desktop critic, and because no
cloud run can ever see it. Not a verdict on a piece; a defect report with a reproduction.

- commit: `884e40e29c96da43b865829abbf3bce3dd98ee51` (also present at `51b5e163`, and at every
  commit since `fd7b5a5`, where both files were added together)
- environment: Windows 11 Home 10.0.26200, NTFS (**case-insensitive**), node v24.15.0, pnpm 10.33.0

**Two files in one directory differ only in case:**

```
src/features/conversation/Markdown.tsx   <- the React component, exports `Markdown`
src/features/conversation/markdown.ts    <- the parser, exports parseMarkdown/parseInline/...
```

`MessageTurn.tsx:12` does `import { Markdown } from './Markdown'`. Vite's default
`resolve.extensions` tries **`.ts` before `.tsx`**, and `vite.config.ts` does not override it. On a
case-insensitive filesystem `./Markdown` + `.ts` matches **`markdown.ts`** — the parser — which has
no `Markdown` export. The renderer throws at module-evaluation time and React never mounts.

**Observed, both engines:**

- `pnpm tauri dev` → window opens, **fully blank white**, no UI at all.
  Evidence: `evidence/windows-case-collision/vela-window-blank-webview2.png`
- Same dev server (`http://localhost:1420`) in Chromium → also blank, console:
  `SyntaxError: The requested module '/src/features/conversation/markdown.ts' does not provide an
  export named 'Markdown'`
  **So this is NOT a WebView2 defect** — it is filesystem case-sensitivity, and it fails in every
  browser on Windows.
- `pnpm build` → **fails**, exit 2, with TypeScript naming the collision explicitly:
  `TS1149: File name '.../markdown.ts' differs from already included file name '.../Markdown.ts'
  only in casing`, plus `TS2305: Module './Markdown' has no exported member 'Markdown'`.
  `pnpm typecheck` is inside `pnpm verify`, so **`pnpm verify` cannot pass on Windows.**
  Evidence: `evidence/windows-case-collision/pnpm-build-windows.txt`

This is invisible on Linux: a case-sensitive filesystem resolves `./Markdown` to `Markdown.tsx`
correctly, so CI and every cloud critic see a working app.

**Smallest fix:** rename one of the two — e.g. `markdown.ts` → `markdown-parser.ts` (3 importers:
`Markdown.tsx:12`, `markdown.test.ts:3`, and the barrel if any). Renaming only by case will not
propagate through git on a case-insensitive checkout; the stem must actually differ.

A sweep of `src/` for same-directory, case-insensitively-identical module stems found **exactly one**
collision — this one. There is no second instance to fix.

**The rename should be sufficient — the fix is de-risked.** Across the whole `pnpm build`, the only
TypeScript errors are `TS1149` ×2, `TS1261` ×2, `TS2305` ×2, in exactly two files
(`MessageTurn.tsx`, `markdown.test.ts`), all arising from this single collision. There is no second,
hidden compile failure waiting behind it, so a desktop re-run after the rename should not stall on
another one. (Fix `icon.ico` in the same pass or `tauri-build` still blocks the Windows app.)

**Second, independent Windows blocker** (from the GATE-M2 run above, repeated here because they
must be fixed together or the next desktop run stalls again): `src-tauri/icons/icon.ico` is absent
and nothing generates it, so `tauri-build` fails before compiling. Fixing the casing alone still
leaves the app unbuildable on Windows.

---

## A3-keychain-settings — keychain-runtime

- commit: `9540d6c600316d63ebbd27ac6f833f4440d8762a`
- critic: keychain-runtime
- verdict: **PASS**
- evidence: `evidence/A3-keychain-settings/ipc-session-transcript.txt`,
  `evidence/A3-keychain-settings/wire-authnone-headers.txt`
- environment: Windows 11 Home 10.0.26200 · WebView2 Runtime 151.0.4129.78 · Intel i7-11700K ·
  63.8 GB RAM · `vela.exe` built `--no-default-features --features os-keychain`, so
  `app_info.secretBackend` reports **`os-keychain`** on every call below — the real `KeyringStore`,
  which the cloud correctly noted **had never been executed anywhere**.

**How it was driven, since this matters for how much the PASS is worth.** The renderer does not
mount (see the case-collision finding), so the settings form could not be used. Tauri injects its
IPC bridge before the app bundle evaluates, so I enabled WebView2 remote debugging via the
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` environment variable — **no code, config or build change** —
and invoked commands from inside the app's own webview. Every call therefore runs the real
`AppState::for_runtime()` → `KeyringStore` → Windows Credential Manager. `MemoryStore` is not
involved anywhere in this verdict.

| # | Step | Result |
|---|---|---|
| 1 | Store a key, confirm it reaches Credential Manager | **PASS** — `cmdkey /list` shows `LegacyGeneric:target=<providerId>/primary.dev.vela.desktop`, matching the documented `storage_key()` format exactly |
| 2 | Round-trip: read back, update, delete | **PASS** — set → `present:true`; update → ok; delete → `present:false` **and the OS entry is genuinely gone**; a second delete is idempotent, not an error |
| 3 | Canary scan | **PASS** — see below |
| 4 | `Auth::None` first-class + no `Authorization` header | **PASS** — see below |
| 5 | Non-loopback no-auth raises a risk signal | **PASS** — `level: elevated`, `concerns: ["plaintextTrafficLeavesDevice","remoteEndpointIsUnauthenticated"]` |
| 6 | Restart: credentials survive, settings reload | **PASS** — after a full process restart the stored credential is still `present:true`, the deleted one is still absent, and all three provider rows reload with correct `baseUrl`, `usable` and risk level |
| 7 | Telemetry off with no enable path | **PASS** — `telemetryEnabled:false`; `settings_set_telemetry`, `telemetry_set` and `settings_put_telemetry` all return "Command not found". The absence is also structurally asserted at `src-tauri/src/ipc/settings.rs:456` |

**Step 3, canary scan — with controls in both directions, because a scan that cannot fail proves
nothing.** Three distinct canary values were stored and then searched for as UTF-8 *and* UTF-16LE
across `vela.db`, `vela.db-wal`, `vela.db-shm` (read with `FileShare.ReadWrite`, since the running
app holds them open) and the whole WebView2 profile — 226 files.

- **0 hits.**
- *Negative control:* an in-memory positive probe confirmed the matcher detects the canary string.
- *Positive control:* the WAL **does** contain the non-secret `providerId` (`queryauth`), proving the
  scan reads real database content rather than failing to see anything at all.
- Read directly out of Credential Manager via `CredRead`, the blob is the exact canary,
  UTF-16LE, 88 bytes, `persist = 3`.

**Step 4, `Auth::None` — the load-bearing case, and it is clean.** `http://localhost:8033/v1` with
no credential returns `usable: true`, `credentialCheck: "satisfiedWithoutCredential"`,
`credentialFieldLabel: null` (so the UI renders no credential field at all, rather than an empty
one), `security.level: "none"`, `concerns: []`. Not an error, no ceremony.

The wire capture is the proof that matters. Vela's real `OpenAiCompatibleProvider` +
`ReqwestTransport`, provider built with no key, recorded by a loopback listener that echoes exactly
what arrived — **the complete set of headers sent, nothing omitted**:

```
POST /v1/chat/completions HTTP/1.1
content-type: application/json
accept: text/event-stream
user-agent: vela/0.1.0
host: 127.0.0.1:8099
content-length: 111
```

No `authorization` — not present, not empty. No `x-api-key`, `x-goog-api-key`, `api-key` or
`proxy-authorization`. No `key=` in the query string.

### The "known cloud-side gap" does not reproduce

The request warns that `Auth::ApiKeyQuery` has no `Concern` variant and reports `RiskLevel::None`.
Tested live at this sha, it does **not**: an HTTPS remote bound to `apiKeyQuery` returns
`credentialInQueryString: true`, `level: "elevated"`, `concerns: ["queryParamCredentialIsLogged"]`.
The gap was closed by the very commit that made this request stale. No action needed; I am not
raising it as worse than reported, because it is no longer there.

### Limits of this PASS — read before treating it as complete

- **The credential UI was never exercised.** `EndpointForm.tsx` was not run, because nothing renders.
  What is proven is the IPC → `KeyringStore` → Credential Manager path and the security posture the
  host returns. Whether the *form* stores, clears and re-reads correctly is unproven and belongs to
  `interaction` once the app boots.
- Step 4's wire capture uses `ui_matrix_bridge` for the outbound request, because the shipping host
  registers no provider and cannot originate one (GATE-M2 finding 1). The provider, transport and
  auth-application code are the real ones; only the process hosting them differs.
- This says nothing about macOS Keychain or libsecret. Windows Credential Manager only.
- Test artifacts were cleaned up: all credentials created here are deleted, all provider rows
  removed, and `cmdkey /list` shows no residual `dev.vela.desktop` entries.

### Incidental: the `icon.ico` fix is verified

`a50ee9f` resolves the Windows build blocker — `cargo build --no-default-features --features
os-keychain` now completes (exit 0) where it previously failed at `tauri-build`. The ICO parses as a
valid 3-entry file. One cosmetic wrinkle, already disclosed by the author: entry 3 declares 256×256
via the 0-marker but carries a **512×512** PNG. It builds and it is not blocking; `pnpm tauri icon`
would produce a true 256px rendition.

---

## A1-scaffold-shell — visual

- commit: `4c01a606c6d3c3f3dbf4084a30d24e16c178d5de`
- critic: visual
- verdict: **FAIL**
- largest_gap: **Vela ships no typeface, so on Windows it renders in Segoe UI and Consolas —
  not the Inter / JetBrains Mono the design was authored against.** `--vela-font-sans` leads with
  `'Inter'` (`src/styles/tokens.css:90`) and `--vela-font-mono` with `'JetBrains Mono'` (`:92`), but
  there is **no `@font-face` anywhere in `src/`, no font file in the repo, and no font package in
  `package.json`** — verified by grep and find. Measured at runtime in the live window, with a
  control:

  | requested family | rendered width of "Handgloves 12345" at 64px |
  |---|---|
  | `ZzQqNoSuchFontXx` (control — definitely absent) | **481.72** |
  | `Inter` | **481.72** — identical to the absent-font control |
  | `JetBrains Mono` | **481.72** — identical |
  | `Segoe UI` | 523.91 |
  | the app's actual body stack | **523.91** — Segoe UI |

  Note that `document.fonts.check('16px Inter')` returns `true` here. It is a false positive and must
  not be used to decide this question; the width control is what settles it.

  `--vela-tracking-tight: -0.01em` is annotated in-file as a correction for Inter's set widths and is
  being applied to a face with different metrics. Same root cause, related detail:
  `-webkit-font-smoothing: antialiased` (`src/styles/base.css:28`) is a macOS-only property and is
  inert here. This is invisible to a Mac/Linux team, whose stack resolves to `-apple-system` (SF) and
  looks fine. Fix: bundle the faces via `@fontsource` so they are served from the Vite bundle — no
  network request, offline-first preserved — or commit to the platform font and retune the type scale
  and tracking against Segoe UI's metrics. Either is defensible. Shipping a design authored for a
  font that never loads is not.

### Other defects, in severity order

2. **Dark mode renders a pure-white legacy Windows scrollbar.** `color-scheme: light dark` is
   declared once at `tokens.css:227` and never narrowed to `dark` in either dark block, and there is
   **zero scrollbar styling in the whole of `src/`** (verified by grep). Any Windows user on a
   light-themed OS who selects Vela's dark theme gets a white scrollbar with square arrow buttons
   hard against a `#080b16` canvas, in every scroll container.
3. **At 150% — the default scale on most Windows 11 laptops — the conversation empty state is
   clipped.** Confirmed by eye in `06-conversation-light-150pct.png`: the Vela mark present at 1x is
   gone entirely, the "No model chosen yet" heading sits flush against the header rule, and the
   transcript is already scrolled. Deterministic, identical in both themes.
4. **Model-picker popover misalignment:** the empty message insets 20px while the footer action
   insets 12px, so it is the one element not sharing the popover's left edge
   (`ModelSwitcher.module.css`).
5. **`--vela-text-subtle` (`#6f7896`) is the one colour role not re-authored for dark**, and computes
   to 4.16:1 light and 4.43:1 dark against `--vela-bg` — under AA in both. It is the composer
   placeholder, the most-read string in an idle app.
6. At 150% the header toolbar wraps and strands the attach button mid-pane rather than flush right.

### What is genuinely good — recorded because it is, and a FAIL should not obscure it

- **The colour-role system is real**: two ramps plus a semantic layer (`--vela-bg` / `-surface` /
  `-surface-raised` / `-chrome` / `-border`), producing four distinct neutral planes in dark rather
  than flat black with outlines.
- **Radius discipline holds**: 8px cards and CTAs, 12px composer, dialog and popover, correctly
  nested — the 8px Send button sits inside the 12px composer field, never the reverse.
- **Dark mode is designed, not inverted.** The accent moves *position on the ramp* — `signal-600`
  (`#0d857f`) in light, `signal-300` (`#5fe2d6`) in dark; row selection changes technique from opaque
  tint to translucent composite; shadows are re-authored (30% to 72% alpha, larger blur); elevation
  direction is correct in both, with chrome receding either way. `design-system.test.ts` asserts that
  no token is defined only inside a dark block.
- **The empty states are designed, not deferred** — the conversation view lists capabilities as
  *unknowns* and explains why nothing is being asserted, which is a better answer than a spinner.
- **No blur or fixed-px breakage at 150%**; the mark is inline SVG and stays crisp. The layout system
  handles 1.5x correctly — the 150% failures are fit and UA-chrome failures, not rendering failures.

### Identity check — clean

**No Anthropic trade dress.** The palette is teal-cyan on night-indigo; there is no clay, terracotta,
coral or cream anywhere in the tokens or the captures, and the token file explicitly forbids them.
The mark is a sail/triangle with a sparkle in a rounded mint tile and resembles nothing of
Anthropic's. The three-zone shell is the generic chat skeleton shared by a dozen products, not Claude
Desktop specifically.

- evidence: `evidence/A1-scaffold-shell/` — eight 1x captures (empty, conversation, model picker and
  search, in both themes), three true-high-DPI captures taken with `--force-device-scale-factor=1.5`,
  and `manifest.json` recording the verified DOM state of each. A CDP metrics override was tried
  first and discarded: it changes `devicePixelRatio` without changing layout, so those captures would
  have been misleading evidence dressed as DPI testing.
- environment: Windows 11 Home 10.0.26200 · WebView2 Runtime 151.0.4129.78 · captures at 1400x900

---

## A1-scaffold-shell — interaction

- commit: `4c01a606c6d3c3f3dbf4084a30d24e16c178d5de`
- critic: interaction
- verdict: **FAIL**
- largest_gap: **The command palette declares `aria-modal="true"`, does not enforce it, and never
  restores focus when it closes.** `CommandPalette.tsx:172` sets `role="dialog" aria-modal="true"`;
  its key handler covers ArrowDown, ArrowUp, Home, End, Enter and Escape and has **no `Tab` case**;
  and `:73` focuses the input without capturing `document.activeElement`. Measured live with the
  palette open: `mainInert: false`, `navInert: false`, **15 focusable elements reachable outside the
  dialog**, and Tab walks out into the title bar and sidebar in **both directions** — Shift+Tab leaks
  too. The fix already exists in-tree: `DeleteConversationDialog.tsx:33-40` captures `activeElement`,
  focuses the *safe* button, and restores on cleanup. Applying that pattern plus swallowing `Tab` is
  roughly ten lines; making the ARIA claim honest additionally wants `inert` on `<nav>` and `<main>`
  while the palette is open.

### Correcting the severity, because the distinction matters

An earlier reading inferred from source that a leaked background control would also **activate** on
Enter. **Measured, it does not.** With real OS keystrokes (`SendKeys`, not synthetic dispatch):
Ctrl+K, then Tab — focus lands on the Theme button, behind the open palette — then Enter: **theme
unchanged**, palette closed. A first attempt at this measurement read the wrong indicator, checking
the theme label while focus was on "New conversation", and was redone.

So the defect is: **focus escapes a dialog that claims modality, and `aria-modal="true"` is a false
promise to assistive technology** — worse than omitting the attribute, because it tells a screen
reader that the fifteen reachable controls do not exist. It is **not** "background controls are
operable through the modal". Overstating it would make the finding easy to dismiss.

### Second defect

**Every keyboard hint shows Mac glyphs on Windows** — `⌘N` and `⌘K` rendered while
`navigator.platform` is `Win32`, hardcoded at `Sidebar.tsx:189`, `Sidebar.tsx:212` and
`HomeSurface.tsx:82`, with no platform-aware glyph layer anywhere in `src/`. The glyphs are baked
into the buttons' accessible names, so a screen reader announces "command K".

**This is mislabelling, not breakage, and the distinction is load-bearing.** The handler tests
`metaKey || ctrlKey` (`use-navigation-shortcuts.ts:47`), and a genuine OS keystroke confirmed that
Ctrl+K opens the palette and focuses its input and that Ctrl+N starts a conversation. Nothing is
broken; Windows users are simply told to press a key their keyboard does not have.

### What works

Ctrl+K, Ctrl+N and Escape all function. The focus ring is real and visible
(`outline: solid 2px rgb(20,168,158)`) and gated on `:focus-visible`, so it does not fire on mouse
clicks. Tab order matches reading order in nine stops for the whole shell, and the conversation list
is a roving tabindex — a 40-item list costs one Tab, not forty, which is the correct call. The
sidebar resize handle is a real `role="separator"` with arrow-key resizing, so it earns its tab stop.
Window resize is clean: 1400x900 down to 560x560 with no horizontal scrollbar at any step and the
sidebar intact — and 560px is *narrower than a user can drag*, since `tauri.conf.json` sets
`minWidth: 720`.

### Not judged

Streaming, scroll-during-stream and send latency are unreachable while the provider registry is
empty — unjudgeable, not failed. Model-picker keyboard behaviour, Ctrl+P / Ctrl+F / Ctrl+B
suppression, and native window management (snap, double-click-maximise, multi-monitor DPI change)
were not exercised. Native minimise, maximise and close are absent by design and declared as such in
`TitleBar.tsx`.

- evidence: `evidence/A1-scaffold-shell/interaction-battery.txt` — raw recorded output. Keys go
  through CDP `Input.dispatchKeyEvent`; Ctrl+K and the activation test additionally used genuine
  OS-level keystrokes.
- environment: Windows 11 Home 10.0.26200 · WebView2 Runtime 151.0.4129.78 · window 1400x900

---

## UNREQUESTED DESKTOP FINDING — theme preference is lost on every restart

Found while capturing the two verdicts above, and filed separately because it belongs to neither.

- commit: `4c01a606c6d3c3f3dbf4084a30d24e16c178d5de`

Set the theme to light through the UI: `data-theme` updates correctly and the label follows. But the
setting is never written — `settings_get` still reports `dark` four seconds later — and after a
**real process restart** the app comes up as `Theme: system`.

Both halves are broken, and the cause is exact:

- `src/data/settings-repository.ts:56` defines `setTheme`, which calls `settings_set_theme`. It has
  **zero callers anywhere in `src/`.**
- `src/app/shell/TitleBar.tsx:51` wires the button to `cyclePreference`, which is purely client-side:
  `theme-store.ts` only calls `applyThemePreference` and `set({ preference })`.
- Nothing hydrates the store from `settings_get` at boot; `preference: 'system'` is a hardcoded
  initial value.

The Rust side is fine — `settings_set_theme` over IPC persisted `dark` across a restart. The frontend
simply never calls it and never reads it back. `theme-store.ts`'s own header states the convention
("No IPC calls inside a store: call a repository from `src/data/`, then set the result"); the
repository exists and is correct, it just has no caller.

---

## GATE-M2-real-model — real-model (RE-RUN, supersedes the FAIL at `51b5e163`)

- commit: `84c256feccb016e00ba240e8368aa1a17fa0ea6c`
- critic: real-model
- verdict: **PASS**
- environment: Windows 11 Home 10.0.26200 · WebView2 151.0.4129.78 · llama.cpp `b8833-45cac7ca7`,
  Qwen3.6-27B Q5_K_M on a Tesla V100 32GB, unmodified and not restarted throughout.

**All four blocking findings from the earlier FAIL are fixed, and I verified each rather than
taking the fix on trust.**

1. **The shipping host now reaches a real endpoint.** A new composition root
   `src-tauri/src/provider_host.rs` builds a `CompatProvider` per configured endpoint
   (`:256`) and registers it (`:180`). Verified live in the running app, not from source:
   `models_list` **enumerated the real model off the live server**, `chat_send` returned
   `accepted: true` rather than `NOT_FOUND`, and a full turn rendered in the window — real
   markdown, real answer, from real model bytes. This was the largest gap of the previous verdict.
2. **Vision now works through Vela's own IPC.** `ChatMessageInput` gained
   `parts: Vec<ContentPartDto>`. A generated 64×64 PNG (left half `#FF0000`, right half `#0000FF`)
   sent as `{kind:'image'}` came back as *"The left half is red and the right half is blue."* —
   correct against known ground truth.
3. **Tool calling now works through Vela's own IPC.** `ChatSendReq` gained `tools` and
   `tool_choice`. A `get_weather` catalogue produced **6 `toolCallDelta` events** with a stable
   `callId`, `name: get_weather`, `slot: 0`, and argument fragments assembling to
   `{"city":"Tel Aviv"}`. **114 reasoning deltas arrived in the same turn and none of them leaked
   into tool-call parsing** — which is the property that actually matters here.
4. **The context-length error is now typed and carries its numbers.** Previously flattened to a
   bare transport 400. Now returns `kind: "contextLengthExceeded"` with `limitTokens: 131072` and
   `requestedTokens: 225522`, in **0.34 s** — Vela rejects it *pre-flight* and never sends the
   request. Note its own estimate (225,522) differs from the server's count (200,018); that is
   expected for a local estimate and the decision is correct either way.

Carried forward from the earlier run and still true: reasoning is separated correctly
(266 `reasoningDelta` vs 3 `textDelta`, answer `"391"` clean, no leakage), reasoning is excluded
from conversation history sent upstream, and `chat_cancel` genuinely aborts the upstream request —
verified against llama.cpp's own `/slots` going 1 → 0 processing.

> **Interpretation limit, restated because it binds this PASS.** Qwen3.6-27B is a strong model:
> 27B, vision-capable, 131k-context, reasoning-enabled. This PASS proves the **happy path only**.
> It is **not** evidence of graceful degradation and **not** evidence of model-agnosticism — that
> comes exclusively from the GATE M Part 1 mock matrix. The one place the earlier run diverged from
> the mocks (a numeric `error.code`) is precisely where Vela broke, which is the whole argument for
> why this gate exists and why a PASS here must not be over-read.

- evidence: `docs/regression-baseline/local-smoke/20-gate-m2-rerun-tools-vision.txt` plus the
  earlier transcripts in that directory.
- note on host: the tool/vision/overflow probes were driven through `ui_matrix_bridge`, which calls
  the same `vela_lib::ipc::chat` functions the Tauri command wraps. Tauri's event surface cannot be
  hooked from CDP, so the event stream is not capturable from the shipping host. The *registry* fix
  — the actual subject of the old FAIL — was verified in the shipping app itself.

---

## CONV-1-conversation-surface — visual

- commit: `84c256feccb016e00ba240e8368aa1a17fa0ea6c`
- critic: visual
- verdict: **FAIL**
- largest_gap: **The thinking block renders raw markdown source.** `ThinkingBlock.tsx:64` emits
  `<p className={styles.text}>{text}</p>` — a raw string that never passes through `<Markdown>` —
  and `ThinkingBlock.module.css:91` sets `white-space: pre-wrap`. The user sees literal
  `**Deconstruct the requirements:**`, literal `*   Topic:` bullets, literal backticks and literal
  ``` fences, wrapped at the model's own column rather than the reader's. I confirmed this with my
  own eyes in `11-streaming-answer-light.png` and `21-thinking-expanded-*.png`, independently of the
  critic. It is not an edge case: `ThinkingBlock.tsx:36` opens the block by default while streaming,
  so on this reasoning-heavy endpoint it is **the first thing the user sees on every single turn**,
  and on a trivial prompt it is the *only* thing on screen for ~10 seconds. The renderer, parser and
  type scale all already exist and are used by the answer body 20 pixels below. This is wiring an
  existing component to a surface that was skipped, not building anything.

### Second, and nearly as costly: the reading measure

`--vela-measure: 46rem` yields a 688px text column, which at 15px body sets full-width prose at
**~95–105 characters per line** (a counted 91-char list item fits on one line *inside* a list
indent; a blockquote runs 103 chars). The comfortable band is 45–75 and the pragmatic ceiling every
reference product respects is ~80. The evidence set contains its own A/B: the same list item in
`24-narrow-window-light.png` sets to ~48 characters and is plainly easier to read.

### Other defects, ranked

3. **The composer and the transcript do not share a vertical ruler.** Transcript column x=489→1177
   (688px); composer field x=472→1208 (736px) — overhanging 17px left and 31px right, asymmetric.
   Cause: `.column` carries `max-width: var(--vela-measure)` *plus* 24px internal padding while
   `Composer.module.css` puts padding outside and gives `.field` the full measure. The 7px of
   asymmetry is the scrollbar.
4. **Content is guillotined at the scroll edge** with no mask or fade — the code block's header is
   sliced through its middle at y≈750 in `20-answer-rendered-light.png`.
5. **Two container tokens equal the page background, each in a different theme.** `--vela-code-bg`
   is pinned to `night-950` (which *is* dark's `--vela-bg`) and `--vela-thinking-bg` to `night-25`
   (which *is* light's). Each container is fill-differentiated in only one of the two themes.
6. **The sidebar is a fixed width** and does not respond to window width; at the app's real 720px
   minimum it would still consume ~40% of the window.
7. **The heading scale collapses below h3** — h4 is the same size as body, h5/h6 are *smaller*, and
   `Markdown.tsx:142` renders `<strong>` with no class so it inherits UA 700 while headings are 600.
   A bolded run of body text is therefore **heavier than any heading below h3**. Source-level: no
   artifact in this set exercises h1/h3/h4/h5/h6, so the evidence gap that hid the original defect
   is still partly open.

### What is genuinely good, recorded because a FAIL should not bury it

The type scale landed and is systematic — six levels off `data-level` with per-level rhythm, h2 cap
height measured at 1.21× body. **Wrapped prose now sets correctly**: proper hanging indents with the
marker outside the text block, and the parser reflows the model's 70-column source rather than
honouring it. `text-wrap: pretty` on paragraphs, `balance` on headings, subdued `::marker`,
restrained no-fill blockquote with a 2px accent rule, code block with language label, copy
affordance and its own overflow container. Spacing between block types is even and intentional
(32/36/28/36px). The command palette — scrim, highlighted match terms, source labels — is
competitive with Raycast. **Identity is clean**: teal-cyan on night-indigo, an explicit written
prohibition on clay/terracotta/cream in `tokens.css`, honoured in the render. No Anthropic trade
dress.

### Blind comparison

Answer body only, labels stripped, against Claude Desktop: **the reference wins, on measure alone.**
Vela is ahead on several craft details, but a page setting at 95–105 characters loses to one setting
at 72–78 — the eye loses the line return. With the thinking block in frame it is not close, because
one page has set prose and the other has visible asterisks. Worth stating plainly: **the answer
surface is one token change away from winning that comparison.**

- evidence: `evidence/CONV-1-conversation-surface/` — rendered answer, code block, thinking block
  collapsed and expanded, streaming states, filtered palette, narrow window; all from a **real
  streamed answer off the live llama.cpp**, plus `streaming-manifest.json` recording the verified
  theme and answer-length state of each streaming capture.
- environment: Windows 11 Home 10.0.26200 · WebView2 151.0.4129.78 · captures at 1400x900

---

## CONV-1-conversation-surface — interaction

- commit: `84c256feccb016e00ba240e8368aa1a17fa0ea6c`
- critic: interaction
- verdict: **PASS**

### Ruling on the cloud's PROVISIONAL focus-ownership finding

The cloud observed focus dropping to `<body>` at four moments and asked me to rule on WebView2.

- **Escape out of the command bar — VERIFIED FIXED.** Focus lands on `textarea :: Send a message…`,
  not `<body>`; **0 Tab presses to recover**, against the cloud's 11 pre-fix. Unambiguous WebView2
  measurement of the exact regression.
- **Committing an F2 rename — UNRESOLVED.** Verified good up to the commit: F2 opens the inline
  field and takes focus into it, and Escape returns focus to the row. Where focus lands *after* a
  commit was not measurable (see below).
- **Confirming a delete — UNRESOLVED for the confirm path, VERIFIED GOOD before it.** The
  confirmation opens with focus on **Cancel**, the safe control, never on the destructive one; and
  Escape returns focus to the originating row.
- **Dismissing the model switcher — NOT MEASURED.**

**Nothing in this evidence shows focus landing on `<body>` on WebView2 after `81b1b12`.** Three of
the four moments are *unmeasured*, not *failed*, and converting an unmeasured moment into a FAIL
would be the reporting error. On the one moment drivable end to end, the cloud's finding is refuted.

### Why two moments stayed unmeasured — a flaw in my harness, not in the app

The interaction critic identified it precisely: CDP `Input.dispatchKeyEvent` with no `text` field
produces `rawKeyDown` only, so no `keypress` fires. The rename field is a `<form>` with a single
input and no submit button, where Chromium relies on **implicit form submission** driven from the
keypress default handler — so the commit never ran. The same harness flaw explains why Enter also
failed to activate a plainly focused `<button>` elsewhere in my battery.

**Consequence: my earlier section 7b result is withdrawn.** It concluded that a leaked background
control does *not* activate while the palette is open. That negative is probably a harness artifact
and does not establish inertness. The *focus leak itself* remains measured and stands; it is the
mitigation that is unestablished. The already-filed A1 `aria-modal` finding must not be softened by
7b. I attempted the critic's one-line falsification (re-dispatch with `text: "\r"`) but the dev
server had been torn down for the release-build performance run and the retest never reached the
app; it remains open.

### What works

Roving tabindex in the sidebar (9 stops for the whole shell; a 40-item list costs one Tab, not
forty). Focus ring real and visible, gated on `:focus-visible`. Every disclosure in the conversation
surface is a real `<button>` with `aria-expanded` — no div-with-onclick, no dead keyboard path. The
composer guards IME composition before treating Enter as send, which on this machine is not
hypothetical: its IME host intermittently steals foreground. Renames commit and persist in the real
app — a 0-message row titled "Gate rename OK" can only have arrived via a committed, host-persisted
rename.

### One correction to my own evidence

My focus-ownership file notes that the delete confirmation "is NOT `[role=dialog]`", which reads
like a semantics defect. **It is not.** `DeleteConversationDialog.tsx:62` declares
`role="alertdialog"`, the correct APG role for a destructive confirmation. My probe used an exact
`[role=dialog]` selector that does not match it. **Probe bug, correct app.**

### Scope-widening note on an existing filing

`DeleteConversationDialog` declares `aria-modal="true"` with no Tab containment, no `inert`, and no
background `aria-hidden` — and a grep of the whole of `src/` finds **no focus-trap or `inert`
implementation anywhere in the app**. This is the same class as the already-filed palette finding,
so it widens that filing from one component to two rather than opening a new one. Unmeasured on
WebView2, and not driving this verdict.

- evidence: `evidence/CONV-1-conversation-surface/focus-ownership.txt`,
  `evidence/A1-scaffold-shell/interaction-battery.txt`
- environment: Windows 11 Home 10.0.26200 · WebView2 151.0.4129.78 · window 1400x900

---

## CONV-1-conversation-surface — performance

- commit: `84c256feccb016e00ba240e8368aa1a17fa0ea6c`
- critic: performance
- verdict: **PASS**
- environment: **release build** (`cargo`/`tauri build`, not the dev binary) · Windows 11 Home
  10.0.26200 · Intel i7-11700K, 16 logical cores · 63.8 GB RAM · WebView2 151.0.4129.78

| measure | value |
|---|---|
| binary size | **14.91 MB** |
| cold start to **rendered content** | **3106 ms** median of 3 (3170 / 3102 / 3106) |
| cold start to window *handle* existing | 47 ms warm, 579 ms first uncached — **not** interactive |
| idle RSS after 60 s, attributed to Vela's process tree | **360.6 MB** (vela.exe 34.5 MB + 6 WebView2 children 326.1 MB) |
| idle CPU | **0.00%** of one core over a 10 s sample |

A 14.91 MB binary and a genuinely idle 0.00% CPU are Tauri-class and clear the bar. 360 MB resident
is heavier than a lean Tauri app but is WebView2's process model rather than Vela's allocation, and
it is well inside the footprint of an Electron peer. Cold start at ~3.1 s to *painted content* is
the honest figure and is acceptable, though it is the number most worth improving.

### Two measurement corrections, because both would have been misleading

- **The 47 ms cold start is not a cold start.** That is the window handle existing; WebView2 has
  painted nothing at that point. Quoting it would have flattered the result by ~66×. The number
  above polls CDP until the app's root actually has content.
- **The idle memory figure was wrong on first measurement.** I summed every `msedgewebview2.exe` on
  the machine and got 1,363 MB across 30 processes — but this box runs other WebView2 apps,
  including the Claude desktop app. Re-measured by walking the descendants of `vela.exe`, Vela owns
  6 of those processes and 326 MB of that total. Reporting 1.4 GB would have failed the piece on
  another application's memory.

### Not measured — stated rather than estimated

- **RAM after a 200-message conversation.** Not run. 200 real turns against a 27B model is hours of
  wall clock; synthesising them through the store IPC would measure the renderer under synthetic
  load, not the app under use. No number is offered rather than a misleading one.
- **Streaming render throughput and dropped frames.** Not measured. At 27.9 tok/s this endpoint
  cannot stress a renderer, so any frame-drop claim from it would be meaningless. A faster endpoint
  is required before this is worth judging.
- **TTFT against a third-party API provider.** No API provider is configured on this machine.

This PASS therefore covers footprint, cold start and idle cost. It does **not** cover behaviour
under sustained load or under a fast endpoint, and should not be read as doing so.

---

## ⚠️ ROUTING CORRECTION — the CONV-1 visual FAIL is not the platform-defaults class

Raised because `docs/vela-progress.md` (at `a3579f4`) summarises the run as:

> **Visual remains FAIL** — the platform-defaults class: no bundled typeface, the white Windows
> scrollbar in dark mode, and 150% DPI layout breakage. That is the platform-polish wave's job.

Those three are the **A1** visual findings and they are correctly attributed in that document's own
A1 section. But they are being carried onto the **CONV-1** row, and a search of that document for
`thinking block`, `raw markdown`, `pre-wrap`, `measure` or `characters per line` returns **nothing**.
The CONV-1 visual verdict's actual content is absent from the record.

**The CONV-1 visual FAIL's largest gap is not a platform default and a platform-polish wave will not
fix it:**

1. **`ThinkingBlock.tsx:64` renders raw markdown source.** It emits `<p>{text}</p>` — never routed
   through `<Markdown>` — with `white-space: pre-wrap` at `ThinkingBlock.module.css:91`. The user
   sees literal `**Deconstruct the requirements:**`, literal `*   ` bullets, literal backticks and
   fences, wrapped at the model's column. `ThinkingBlock.tsx:36` opens the block by default while
   streaming, so on a reasoning-heavy endpoint it is the first thing on screen every turn, and on a
   short prompt the only thing for ~10 s. **This is a content-rendering defect, not a platform one.
   It reproduces identically on Linux.**
2. **The reading measure sets prose at ~95–105 characters** (`--vela-measure: 46rem` → a 688px
   column at 15px). One token change.
3. Composer and transcript do not share a vertical ruler (688px vs 736px, asymmetric).
4. Content is guillotined at the scroll edge with no mask.
5. `--vela-code-bg` and `--vela-thinking-bg` each equal the page background in one of the two themes.
6. The sidebar is a fixed width and does not respond to window width.
7. The heading scale collapses below h3 — h4 equals body size, h5/h6 are smaller, and unclassed
   `<strong>` (UA 700) outweighs every heading below h3 (600).

Items 1, 2, 3, 4, 6 and 7 are all engine-independent. Routing this FAIL to the platform-polish wave
would ship the typeface, the scrollbars and the DPI fix and leave the thinking block still printing
asterisks at the user.

**Still-open evidence gap, carried from the CONV-1 visual verdict:** no artifact in the set exercises
`h1`, `h3`, `h4`, `h5` or `h6`, so finding 7 is source-read rather than observed. That is the same
gap that let the original markdown defect survive a full cloud review. A prompt that emits every
heading level should be part of the re-test.

---

## CONV-1 visual — evidence gap CLOSED: the heading scale is now observed, not inferred

The CONV-1 visual verdict flagged finding 7 (heading scale collapses below h3) as **source-read
only**, because no artifact in the set exercised `h1` or `h3`–`h6` — the same gap that let the
original markdown defect survive a full cloud review. That gap is now closed by measurement on the
**release build**, from real model output.

| markdown | rendered | size | weight | note |
|---|---|---|---|---|
| `#` | `<h2>` | 24px | 600 | |
| `##` | `<h3>` | 18px | 600 | |
| `###` | `<h4>` | 16px | 600 | |
| `####` | `<h5>` | **15px** | 600 | same size as body |
| `#####` | `<h6>` | **13px** | 600 | |
| `######` | `<h6>` | **13px** | 600 | identical to h5 except `text-transform: uppercase` |
| body paragraph | | 15px | 400 | |
| `**bold**` | `<strong>` | 15px | **700** | |

**Both halves of the finding are confirmed observationally:**

1. **Markdown h5 and h6 are typographically identical** — same 13px, same weight 600, same element.
   They differ only by `text-transform`. That is five distinguishable levels, not six.
2. **Bold body text outweighs a markdown h4.** `<strong>` renders at 700 while every heading renders
   at 600, and markdown h4 sits at the same 15px as body. A bolded run is therefore heavier than the
   heading above it.

**One correction in the app's favour, which the source read did not surface.** Markdown levels are
**demoted by one** — `#` renders as `<h2>`, not `<h1>` — so the document keeps a single `<h1>` for
the page itself. That is correct accessibility practice and deserves recording alongside the defect.

This does not change the CONV-1 visual verdict, which remains **FAIL** on the thinking block and the
reading measure. It upgrades finding 7 from inferred to measured.

- evidence: `evidence/CONV-1-conversation-surface/heading-scale-observed.txt`,
  `evidence/CONV-1-conversation-surface/30-heading-scale.png`

### Incidental: the release bundle is sound, and a near-miss worth recording

While setting this up I observed the release binary loading `http://localhost:1420` with its IPC
returning `Command app_info not allowed by ACL`, which looked like a serious packaging defect. **It
is not, and I nearly filed it as one.** Relaunched with no dev server running, the release binary
loads `http://tauri.localhost/` — its own bundled assets — renders correctly, and `app_info`
succeeds with `secretBackend: os-keychain`.

The explanation is benign and mildly reassuring: WebView2 had restored the previous session URL from
the shared user-data folder, and **Tauri correctly refused IPC from that non-app origin.** Commands
being rejected from an origin that is not the app is the ACL doing its job.

---

## CONV-1 interaction — all four focus moments now MEASURED on WebView2

The interaction PASS rested on one of the cloud's four focus moments being verified and three being
*unmeasured*. Two were unmeasurable because of a flaw in my harness, which the interaction critic
diagnosed precisely: CDP `Input.dispatchKeyEvent` with no `text` field produces `rawKeyDown` only,
so no `keypress` fires and Chromium's **implicit form submission** never runs — which is how the
rename field commits.

**The critic's hypothesis was correct.** Re-dispatching Enter with `text: "\r"` plus a `char` event,
on the **release build**, committed the rename immediately. All four moments are now driven end to
end, and **none of them drops focus to `<body>`**:

| # | Moment | Focus lands on | Body? |
|---|---|---|---|
| 1 | Escape out of the command bar | `textarea` (the composer) — 0 Tabs to recover, against 11 pre-fix | no |
| 2 | **Committing an F2 rename** | the renamed row itself (`button :: RENAME COMMIT PROOF`) | no |
| 3 | **Confirming a delete** | `button :: Start a conversation` | no |
| 4 | **Choosing a model in the switcher** | the switcher trigger button — restore-to-trigger, as `ModelSwitcher.tsx:77-81` intends | no |

Moment 2 also confirms the rename genuinely commits and persists, and moment 3 confirms the delete
genuinely removes the row — the confirmation opens focused on **Cancel**, the safe control, and only
acts when Delete is chosen.

**The fix at `81b1b12` is fully verified on WebView2.** The cloud's provisional finding — focus
dropping to `<body>` at four moments, costing 7–11 Tab presses — is refuted on all four, on the
engine where the cloud could only guess.

This does not change the CONV-1 interaction verdict, which was already **PASS**. It removes the
caveat that three quarters of it was unmeasured.

**Consequence for the withdrawn section 7b.** My earlier "a leaked background control does not
activate on Enter" result was withdrawn because it used the same text-less dispatch. That withdrawal
was correct and stands: the harness flaw is now positively confirmed, so 7b measured the harness, not
the app. Whether a leaked control activates through the palette remains genuinely unknown, and the
already-filed `aria-modal` finding must not be softened by it.

- evidence: `evidence/CONV-1-conversation-surface/focus-ownership.txt` (final section)
- environment: **release build** · Windows 11 Home 10.0.26200 · WebView2 151.0.4129.78

---

## DESKTOP FINDING — the Windows debug-log directory is readable by a non-owner group

You disclosed that `create_private_dir` / `open_private` have a `#[cfg(not(unix))]` branch that is
"unenforced and unmeasured on Windows" and asked me to look. **Measured, and the assumption behind it
does not hold on this machine.**

The Windows branches rest on a claim stated in both files: *"the application-data directory is
already per-user, and nothing here widens it."* The first half is not guaranteed, and here it is
false.

`diagnostics_debug_log_set{enabled:true}` created
`C:\Users\User\AppData\Roaming\dev.vela.desktop\diagnostics`. Its real ACL:

```
Owner               : DESKTOP-298M5DU\User
Inheritance enabled : True          <-- nothing protects or replaces the inherited DACL
  DESKTOP-298M5DU\User              FullControl                inherited=True
  NT AUTHORITY\SYSTEM               FullControl                inherited=True
  BUILTIN\Administrators            FullControl                inherited=True
  DESKTOP-298M5DU\CodexSandboxUsers ReadAndExecute, Synchronize inherited=True   <-- NOT the owner
  S-1-15-3-3557520199-...-3692855932 FullControl                inherited=True   <-- app-container SID
```

**A separate local group has read access to the directory that holds raw provider exchanges.**
`debuglog.rs` is explicit that what lands there is the raw body — the material deliberately kept out
of rendered errors — so this is prompt and response content, not just timings.

### Being precise about blame and scope

- **Vela did not widen anything.** That ACE is inherited from a parent under `%APPDATA%`, put there
  by other software on this machine. The code's second clause ("nothing here widens it") is true.
- **The defect is the first clause and the asymmetry.** The Unix branch *enforces* `0700`/`0600`; the
  Windows branch enforces nothing and relies on the OS having already done it. That assumption is
  violable by any other installer, by group policy, or by an admin — and on a real machine, in this
  case, it was already violated before Vela ever ran.
- **Fix:** mirror the Unix guarantee rather than assume it. On Windows, set an explicit DACL and
  disable inheritance on the diagnostics directory (owner + SYSTEM only), so the Windows branch makes
  the same promise its `unix` sibling does instead of inheriting whatever the machine happens to have.
- **What I measured:** the **directory**. The log file itself was never created — `FileSink` opens
  lazily and no exchange wrote to it during the test window — but a file created there inherits the
  directory's DACL, so the exposure follows. I am flagging the directory because that is what I
  observed; the file remains unmeasured.

Impact is bounded by the feature being **opt-in and off by default**, which is the right posture and
is why this is a finding rather than a blocker.

---

## CONV-1-conversation-surface — visual (RE-JUDGE, supersedes the FAIL)

- commit: `923e6da` fix wave, verified at local HEAD after pull
- critic: visual
- verdict: **PASS**
- environment: Windows 11 Home 10.0.26200 · WebView2 151.0.4129.78 · 1400x900 · real streamed
  answer from live llama.cpp (Qwen3.6-27B)

All seven prior findings ruled on, each against real pixels:

| # | Prior finding | Now |
|---|---|---|
| 1 | Thinking block rendered raw markdown | **FIXED** — `<Markdown source={text} scale="aside" />`, `pre-wrap` gone; nested lists, bold lead-ins, inline-code chips, zero literal `**` |
| 2 | Measure ~95–105 chars | **FIXED** — 480px column, counted **69 characters** per line |
| 3 | Composer/transcript rulers | **FIXED** — transcript 592→1072, composer 599→1080; identical widths, 7px offset remains |
| 4 | Guillotined scroll edge | **FIXED, and switched** — fades only on the edge that has more content, correct at top, middle and end |
| 5 | Container tokens = page bg | **FIXED** — dark now steps page `#080b16` → code `#101426` → bar `#1a1f31` → border `#262c42` |
| 6 | Fixed sidebar | **FIXED per source** (200–480 clamp, keyboard-resizable separator) — not visually confirmable, every capture is at the 280px default |
| 7 | Heading scale + `<strong>` inversion | **FIXED** — see the correction below |

### A correction to my own measurement

I reported h4–h6 as "all still 15px/700, differing only by uppercase", and concluded the scale was
still collapsed. **That was wrong, because I measured size, weight and text-transform but not
colour.** Measured properly, the six markdown levels carry six distinct treatments, one device
changing per step:

| md | size | weight | colour | extra |
|---|---|---|---|---|
| 1 | 24px | 700 | `#eef0f6` | tracking −0.24px |
| 2 | 18px | 700 | `#eef0f6` | −0.18px |
| 3 | 16px | 700 | `#eef0f6` | −0.16px |
| 4 | 15px | 700 | `#eef0f6` | −0.15px |
| 5 | 15px | 700 | **`#9aa2bd` muted** | −0.15px |
| 6 | 15px | 700 | `#9aa2bd` | **uppercase, +0.6px** |

No heading is smaller than body, and `.prose strong` is pinned to 600 against `.heading` at 700 —
structure outranks emphasis, so the inversion is genuinely gone. The tag is demoted one step from the
`data-level` (markdown `#` → `<h2>`) to keep a single page `h1`, which is why a DOM tag census reads
one level low.

### Residuals — recorded, not blocking

Three survivors of finding 5's class, one layer deeper: in **light theme only**,
`--vela-turn-user-bg` and `--vela-thinking-bg` are both `#eef0f6` (they correctly differ in dark), so
"what you said" and "how the model thought" collapse onto one value; the inline-code chip fill
(`--vela-bg-inset`) equals `--vela-thinking-bg` in **both** themes, so chips survive on their border
alone; and the 7px composer offset, which is the unstyled scrollbar stealing layout width —
`scrollbar-gutter: stable` would close it. None of these read as bugs on screen; all violate the
token file's own stated rule.

One nit: nested markers inside the thinking aside fall through to the UA `disc → circle → square`
cascade, and the filled square at level 3 is the most dated mark on the surface.

### Blind comparison

Answer body only, labels stripped, against a reference at this tier: **Vela wins, narrowly.** Six
markdown heading levels that are genuinely six distinct things is rare — most renderers at this tier
flatten h4–h6 into body and hope bold carries it. The blockquote outdented onto the text ruler, the
bullet column dropped to punctuation colour, the 69-character measure, and the code block's three-step
elevation are all traceable to a token or rule.

**Where the reference still wins is the letterforms** — blind, the body reads as Segoe UI and the code
as a system mono. That is the unbundled-typeface item filed under A1, and a blind test cannot unsee
it. **Land the typeface and this stops being close.**

### Not assessable from this evidence

Paragraph-to-paragraph spacing (this answer has no two adjacent paragraphs), tables, links, and the
empty/streaming states — every capture is of a completed answer. The streaming caret and the
"Thinking…" pulse exist in source with reduced-motion fallbacks but are not captured here, and are
not ruled on.

- evidence: `evidence/CONV-1-retest/` — six answer captures across three scroll positions in both
  themes, thinking expanded in both, `retest-measurements.txt`, `manifest.json`

---

## CONV-1 residual CLOSED — the composer/transcript offset is now zero

The CONV-1 visual PASS recorded three residuals. One is now fixed and verified.

`scrollbar-gutter: stable both-edges` landed at `0f83c71`
(`ConversationView.module.css:46`). Measured on real WebView2 with a live conversation open, so the
scroller is genuinely scrolling:

```
transcript column : left 490  width 480
composer field    : left 490  width 480
left delta        : 0
```

Previously 592 vs 599 — a 7px offset caused by the unstyled scrollbar stealing layout width from the
centred column. Both edges now reserve the gutter, so the two boxes share one ruler exactly.

Note the author chose `stable both-edges` rather than plain `stable`, which is the right call here:
plain `stable` reserves on one side only and would have re-introduced an asymmetry of the same kind
it was meant to remove.

Two residuals from that verdict remain open, both cosmetic and neither blocking: in light theme
`--vela-turn-user-bg` and `--vela-thinking-bg` are still the same value, and the inline-code chip
fill still equals the thinking-panel fill in both themes.

---

## A1-scaffold-shell — visual (RE-JUDGE, supersedes the FAIL)

- commit: `e7b56d665f90c1f9046469b837de17fb67bac343`
- critic: visual
- verdict: **PASS**
- environment: Windows 11 Home 10.0.26200 · WebView2 151.0.4129.78 · 1400x900, and true high-DPI
  via `--force-device-scale-factor=1.5`

All five platform-defaults findings ruled on:

| # | Prior finding | Now |
|---|---|---|
| 1 | No bundled typeface | **FIXED** — `@fontsource-variable/{inter,jetbrains-mono}` are real dependencies, four `@font-face` rules (roman + true italic per family) reachable from the entry graph via `base.css:11` |
| 2 | White legacy scrollbar in dark | **FIXED** — was `#fcfcfc` trough with arrow buttons; now page `#080b16` with a `#6f7896` pill, no trough, no buttons |
| 3 | Empty state clipped at 150% | **FIXED** — mark renders in full with ~76 device px of clear air below the header rule; pane scrolls, third card reachable |
| 4 | Model-picker popover misalignment | **FIXED IN SOURCE, NOT OBSERVED** — `.empty` moved `space-4 → space-2`, so `.empty`, `.option` and `.footerAction` all land on 12px. **No capture in this evidence set has the popover open**, so this is arithmetic, not observation |
| 5 | `--vela-text-subtle` under AA | **FIXED** — re-authored per theme (light `#5b6280`, dark `#868fac`): composer placeholder now **5.99:1** light / **5.09:1** dark, was 4.16 / 4.43 |

The typeface is confirmed by runtime width control, not by inspection:
`appBody 560.09 == InterVariable 560.09`, against `SegoeUI 523.91` and an absent-font control of
`481.72`; `appMono 614.41 == JetBrainsMonoVariable 614.41`. Plain `'Inter'` still measures 481.72 —
identical to the absent control — so the only reason Inter renders at all is the bundle.

**Two fixes were better than the brief asked for, and both avoid a regression a naive fix invites:**

- `color-scheme` is narrowed inside a *guarded* media block —
  `@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) { … } }` — which closes the
  inverse bug (dark OS + in-app light theme) that a plain narrowing would have created.
- `base.css` deliberately avoids `scrollbar-color` / `scrollbar-width`. Either one makes Chromium
  discard the whole `::-webkit-scrollbar-*` block, and the arrow buttons return.

Also verified absent: no FOUT risk (`font-display: block` on local files), no orphaned fallback (the
packages' `unicode-range` values are carried, so out-of-subset codepoints degrade to the platform
font rather than to nothing), and the scrollbar thumb clears 3:1 on every ground it sits on.

### One item in this ruling is arithmetic, not observation

Finding 4 is closed by reading three padding values that now agree, **not by seeing the popover**.
No capture in `A1-retest/` has it open. I am recording that distinction rather than letting a
source-read pass as a pixel-read, because that is exactly the gap that let the original markdown
defect survive a full cloud review.

### An evidence-hygiene failure of mine

`A1-retest/manifest.json` — the 1x capture manifest — **does not exist.** My capture script threw on
a stray reference *after* taking the shots but *before* writing the manifest; I saw the traceback,
checked that the images were written, and reported "captures succeeded" without noticing the manifest
was the thing that had failed. The 150% manifest exists; the 1x one does not.

The theme state of `50-scrollbar-light.png` / `-dark.png` is therefore attested only by the visible
"Theme: light" / "Theme: dark" pill in each capture and by the runtime readings in
`typeface-verification.txt`. That is sufficient here, and the critic said so, but the record is
weaker than it should be and I am not going to write the manifest after the fact — a state
attestation composed from memory is worth less than none.

### Blind comparison — the qualifier is gone

The previous critic picked Vela **narrowly**, losing only on letterforms. Letterforms are exactly
what this wave bought, so that loss is gone.

On the **reading surface** Vela now wins outright, on two counts beyond parity: the code block is a
genuine three-step surface in dark (`night-950` page → `night-900` block → `night-800` language bar),
which is more considered than the flat panel most references ship; and the transcript header carries
information no reference offers — *"Context window not reported by this endpoint · about 471 tokens
in this turn"*.

On the **shell** it is closer to a coin-flip, for one reason that is filed and outside A1's scope:
**there are still no minimise / maximise / close controls.** With `decorations: false` and a title bar
rendering only a theme toggle, the window reads as unfinished at a glance in a way nothing inside the
app does. The Mac `⌘` glyphs on a Windows box are the second tell. Close both and Vela wins outright
against every reference at this tier.

- evidence: `evidence/A1-retest/` (six captures across both themes at 1x and true 150%),
  `evidence/CONV-1-retest/typeface-verification.txt` (width-control probe and runtime readings)
