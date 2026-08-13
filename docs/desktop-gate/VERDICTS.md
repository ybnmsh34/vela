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
- limits of this run: the GUI could not be driven — screen-control access was denied — so the
  `NOT_FOUND` path was confirmed from code, not from a screenshot of the running window. The app
  itself was built and launched successfully (PID 8252) once a local `icon.ico` was supplied.
  `visual`, `interaction` and `performance` were not requested and are not judged here.
