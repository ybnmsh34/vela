# Vela

A desktop AI workspace that brings its own interface and none of its own intelligence. You
supply the model: a local runtime (llama.cpp, Ollama, LM Studio, vLLM), your own API key, or a
subscription endpoint. Offline-first, no telemetry, credentials in the OS keychain.

Tauri v2 — Rust core, React + TypeScript renderer, strict IPC boundary between them.

## Getting started

```bash
pnpm install
pnpm dev                 # frontend alone in a browser, backed by the in-memory fake host
pnpm verify              # typecheck + vitest + cargo test
cargo tauri dev          # the real desktop app (needs a display server)
```

Linux hosts need the webview toolchain before the Rust workspace will build:

```bash
apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
    libjavascriptcoregtk-4.1-dev librsvg2-dev patchelf libayatana-appindicator3-dev
```

## Layout

| Path | What lives there |
|---|---|
| `src/platform/` | The adapter seam and the typed IPC contract. Read this first. |
| `src/app/` | Composition root and the window shell. |
| `src/features/` | One folder per user-facing capability. |
| `src/data/`, `src/state/`, `src/components/`, `src/lib/` | Repositories, zustand stores, shared primitives, pure helpers. |
| `src-tauri/src/ipc/` | The command allowlist — the entire renderer-facing surface. |
| `src-tauri/crates/` | Domain logic with no Tauri dependency: `vela-core`, `vela-secrets`, `vela-providers`. |

## Before you write code

**[`docs/architecture/conventions.md`](docs/architecture/conventions.md) is binding.** It
defines the folder layout, the IPC command pattern, the adapter seam, state management, the
testing layout, and the honesty rules for what may be claimed about a headless build.
