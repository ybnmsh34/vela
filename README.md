# Vela

A desktop AI workspace that brings its own interface and none of its own intelligence. You
supply the model: a local runtime (llama.cpp, Ollama, LM Studio, vLLM), your own API key, or a
subscription endpoint. Offline-first, no telemetry, credentials in the OS keychain.

Tauri v2 — Rust core, React + TypeScript renderer, strict IPC boundary between them.

## Getting started

```bash
pnpm install
pnpm dev                 # frontend alone in a browser, backed by the in-memory fake host
pnpm verify              # the full gate, and a superset of CI — run before every commit
pnpm tauri dev           # the real desktop app (needs a display server)
```

Linux hosts need the webview toolchain before the Rust workspace will build:

```bash
apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
    libjavascriptcoregtk-4.1-dev librsvg2-dev patchelf libayatana-appindicator3-dev
```

Every host needs **`cargo` on the PATH of the shell `pnpm` spawns**. Four of the
nine gates in `pnpm verify` are cargo — `fmt`, `clippy`, `build`, `test` — and
`verify` chains them with `&&`, so a shell that cannot resolve `cargo` fails at
the second gate and silently takes the two build gates at the end with it:

```
> vela@0.1.0 lint:rust
'cargo' is not recognized as an internal or external command
```

`rustup` normally puts `cargo` there for you; if that error appears, its
directory (`~/.cargo/bin`, or `$CARGO_HOME/bin`) is missing from your PATH.
Note that `pnpm` runs script bodies through the *system* shell — `cmd.exe` on
Windows — which does not read your shell profile, so exporting it in `.bashrc`
or a PowerShell profile alone is not enough. It must be on the PATH the OS hands
to a new process. This is deliberately not worked around in `package.json`:
resolving a hard-coded toolchain path would let `verify` pass while `cargo` was
still unusable from your own terminal.

Windows hosts additionally need **Git Bash**, which ships with Git for Windows.
Two gates are shell scripts, and `scripts/run-bash.mjs` locates that specific
shell rather than trusting `bash` on PATH — where Windows resolves it to the WSL
launcher, a different operating system with a different toolchain.

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
