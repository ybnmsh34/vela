# The UI↔core bridge (GATE M Part 1, Phase C)

Test infrastructure. It exists so the **shipping renderer** can be driven against the **real
provider core** against the **real capability-matrix mock endpoints**, on a machine where the
Tauri desktop shell cannot start.

```
  Chromium ── the real src/ bundle, mounted by main.tsx with a RelayAdapter
      │  POST /invoke, EventSource /events         ← a relay standing in for Tauri IPC
  server.mjs ── owns two child processes
      │  JSON lines on stdin/stdout
  src-tauri/examples/ui_matrix_bridge.rs ── the real vela_lib::ipc::* functions
      │                                     over the real OpenAiCompatibleProvider
      ▼  real HTTP over a real TCP socket
  tests/harness/mock-provider ── frontier | mid-local | small-local | hostile
```

## Why not `BrowserAdapter`

`BrowserAdapter` is an in-memory echo. It cannot produce a capability report, a reasoning
channel, a degradation, or a malformed tool call, so a UI gate driven against it would assert
nothing about the capability matrix. This relay changes the transport and nothing else: every
byte the renderer receives was produced by the core from a real exchange with a mock endpoint.

## What is real and what is not

| Layer | Real? |
|---|---|
| The component tree, its state, its CSS | **Real** — imported from `src/`, no forks |
| The IPC contract, allowlist, error shapes | **Real** — `src/platform/contract.ts` |
| Command semantics | **Real** — the same `vela_lib::ipc::<domain>::<fn>` the Tauri commands call |
| Stream normalisation, reasoning split, tool accumulation, degradations | **Real** — `vela-providers` |
| The endpoint | A deterministic **mock**. No model produced any of it |
| The transport into the browser | HTTP + SSE, **not** Tauri IPC |
| The credential store | `MemoryStore` |
| The window chrome, the webview | Chromium on Linux, **not** WebView2/WebKitGTK in Tauri |

Everything produced here is **VERIFIED-BY-FAKE** (conventions.md §10).

## Two things the bridge does that the shipping host does not

1. **It registers a provider.** Nothing under `src-tauri/src/` ever calls
   `ProviderRegistry::register`, so on today's builds `chat_send` cannot reach any endpoint.
   That is FINDING 1 of the gate. `--no-register` reproduces the shipping behaviour exactly,
   and control K21 uses it.
2. **It can attach a tool catalogue** to a request, when a user message starts with `#tools`.
   `ChatSendReq` has no `tools` field, so the shipping composer cannot ask for tools at all —
   FINDING 2. Everything after the request is the real core: native calls, prompt emulation,
   malformed reconstruction, degradations.

Both are stated on every screenshot they affect.

## One thing the *endpoint* does on request: `#markdown`

A prompt containing `#markdown` makes the mock answer with
`tests/fixtures/rich-markdown-answer.md` instead of filler prose — a long document with six
heading levels, nested lists, a block quote, a fenced code block, a five-column table, a rule
and hard-wrapped paragraphs.

It exists because the rendered markdown answer is Vela's **primary reading surface** and no
screenshot in the Phase C evidence set exercised it. Every profile answers a plain prompt with
one paragraph, so no run had ever painted a heading — which is why a critic, and not this gate,
was the one to find that all six heading levels were set at the same size.

The directive fires only when asked for, so every recorded transcript and every pre-existing
case is byte-identical. The same file is read by `src/features/conversation/Markdown.test.tsx`,
so the screenshot and the unit assertions are about one artifact rather than two that resemble
each other; it lives in `tests/fixtures/` — belonging to neither the app nor this harness — for
the same reason `tests/parity/` does.

`readingSurface()` in `checks.mjs` reads the result through **computed styles**, not the DOM:
six headings with six correct tags and one shared font size is a well-formed document that
cannot be read as one, and no amount of `innerText` will say so.

## Running it

```bash
pnpm dev &                                            # Vite on 127.0.0.1:1420
cd src-tauri && cargo build --example ui_matrix_bridge && cd ..

export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers      # never run `playwright install`
export VELA_PLAYWRIGHT=/opt/node22/lib/node_modules/playwright/index.js

node tests/harness/ui-bridge/drive-matrix.mjs --profile frontier
node tests/harness/ui-bridge/drive-matrix.mjs --profile mid-local
node tests/harness/ui-bridge/drive-matrix.mjs --profile small-local
node tests/harness/ui-bridge/drive-matrix.mjs --profile hostile
node tests/harness/ui-bridge/controls.mjs
```

Evidence lands in `docs/regression-baseline/phase-c-matrix/`. Each profile run replaces its own
directory; the controls write `ASSERTION-CONTROL.tsv` at the root.

To look at a profile by hand:

```bash
node tests/harness/ui-bridge/server.mjs --profile hostile --port 8420 --chunk-delay 60
# then open http://127.0.0.1:1420/tests/harness/ui-bridge/index.html?relay=http://127.0.0.1:8420
```

## Files

| File | Job |
|---|---|
| `index.html`, `main.tsx` | `src/main.tsx` with one line changed: the adapter |
| `relay-adapter.ts` | `PlatformAdapter` over HTTP + SSE. Transport only |
| `server.mjs` | Starts the mock and the Rust bridge; serves `/invoke`, `/events`, `/health` |
| `checks.mjs` | The DOM readers and the assertions — shared by the driver and the controls |
| `drive-matrix.mjs` | One profile, eighteen screenshots, twenty-five assertions — twenty-three on `hostile`, which has no answer channel for the reading surface to be judged in |
| `controls.mjs` | The same assertions applied where they must fail |

`checks.mjs` is shared on purpose: a control that re-implements the assertion it is controlling
proves nothing about the assertion that actually ran.
