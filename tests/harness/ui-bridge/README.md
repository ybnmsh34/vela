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

## Two more the endpoint does on request: `#headings` and `#thinkmd`

Both exist because the previous pass closed one evidence gap and disclosed two others.

`#headings` answers with `tests/fixtures/heading-scale-answer.md`, which exercises **all six
heading levels** with a bold run beside each. `#markdown` reaches `h4` and stops, so no artifact
in the set ever rendered `h1`, `h3`, `h4`, `h5` or `h6` — which is why "the scale collapses below
`h3`, and an unclassed `<strong>` at 700 outweighs every heading under it at 600" had to be read
out of a stylesheet instead of seen. `headingsOutrankEmphasis()` now measures that comparison
from the engine's own computed weights.

`#thinkmd` puts markdown in the **reasoning** channel. Every profile's narration was plain
prose, so no run here had ever painted a thinking block containing a bold lead-in, a bulleted
plan or a fence — and the block that printed `**Deconstruct the requirements:**` at the user,
verbatim, with `white-space: pre-wrap`, was therefore invisible from this matrix and had to be
found on a real machine. `reasoningSurface()` reads what came out the other end.

Like `#tools` and `#markdown`, both fire only when asked for, so every recorded transcript and
every pre-existing case stays byte-identical.

## What `layoutRuler()` is for

Three findings that are properties of the *assembled layout at a particular window size*, and
so can only be read from a browser: the transcript's text and the composer's box stood on two
different rulers (688px of text under a 736px box); the sidebar was a constant, so a 480px
choice took half of a 1000px window; and the reading column set prose at ~95–105 characters per
line. `drive-matrix.mjs` reads it at **two** viewports with the sidebar dragged to its maximum —
a single reading cannot tell a responsive width from a constant that happens to look right where
you measured, and a sidebar left at its default is under the cap at both sizes and would prove
nothing.

The characters-per-line figure is measured through `Range.getClientRects()` rather than
"characters ÷ line boxes": the last line of every paragraph is partial, and that bias is about
8% on a document this length — enough to move the number out of the band it is judged against.

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
| `drive-matrix.mjs` | One profile, twenty-three screenshots, thirty-five assertions — thirty on `hostile`, which has no answer channel for the reading surface to be judged in, and thirty-three on `small-local`, which has no reasoning channel |
| `controls.mjs` | The same assertions applied where they must fail |

`checks.mjs` is shared on purpose: a control that re-implements the assertion it is controlling
proves nothing about the assertion that actually ran.
