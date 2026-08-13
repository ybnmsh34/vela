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
