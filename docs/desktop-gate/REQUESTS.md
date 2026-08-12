# Vela — Desktop Gate: REQUESTS

**This file is written by the CLOUD session. The desktop session reads it and replies in
[`VERDICTS.md`](./VERDICTS.md).**

---

## Read this first (the desktop session has no shared context)

**Vela** is a desktop application intended to be functionally equivalent to Anthropic's Claude
Desktop, but **model-agnostic**: the user supplies the brain — any local model (llama.cpp,
Ollama, LM Studio, vLLM), any third-party API key, or any subscription provider. Every feature
Claude Desktop has, Vela should have. Only the underlying model is swappable.

Runtime is **Tauri v2** (Rust core + web frontend), decided in Phase 0 on a greenfield repo.

The build runs as a **Gauntlet Loop**: each piece is judged by a panel of independent,
fresh-context critics returning **strict binary PASS/FAIL**. A piece advances only when
**ALL** critics on its panel PASS. One FAIL sends it back to its builder and the loop runs again.
No averaging, no majority vote, no scores.

The cloud session is a headless Linux container. It is structurally incapable of five verdicts,
which is why you exist. It owns everything else.

## Division of labour

| Cloud session (headless Linux container) | Desktop session (operator's Windows machine) |
|---|---|
| Functionality / correctness (non-GUI) | `performance` — cold start, idle RAM, streaming throughput |
| Architecture / code quality | `keychain-runtime` — real OS credential storage |
| Security — **static** code-path review | `visual` — design polish as a **final** verdict |
| Regression vs the Phase 0 baseline | `interaction` — UX responsiveness, focus, jank |
| GATE M **Part 1** — the mock capability matrix | `real-model` — GATE M **Part 2**, llama.cpp at `:8033` |
| `visual` / `interaction` as ADVISORY pre-checks only | Windows / macOS builds |

The cloud session's visual and interaction runs catch gross layout breakage on WebKitGTK. They
are **PROVISIONAL and never final** — WebView2 on Windows differs materially. Your verdict is
the binding one.

## Protocol

1. Cloud appends a request block below when a piece has passed every critic it *can* run but
   has a deferred critic outstanding. That piece is marked **AWAITING_DESKTOP** — it is **NOT
   complete**, is not reported as passing, and no dependent work is built on the assumption it
   passed.
2. You exercise the piece per **what to exercise**, judge against **what "good" looks like**,
   and append a verdict to `VERDICTS.md` keyed by **piece-id + commit sha**.
3. Cloud reads `VERDICTS.md` at the start of every wave. A **FAIL** returns the piece to its
   builder with exactly the force of a cloud-side FAIL. A verdict citing a sha older than that
   piece's current HEAD is **STALE**, does not count, and gets re-requested.
4. Commit any evidence — screenshots, measurements, transcripts — under
   `docs/desktop-gate/evidence/<piece-id>/`. Real artifacts, not assertions.

## Quality bars, so both sessions judge against the same thing

- **Visual / interaction:** a **quality tier, not a clone**. At or above Claude Desktop, Linear,
  Raycast, and Zed. Judge type scale and hierarchy, spacing rhythm, radii, elevation discipline,
  colour-role system, dark/light theming, motion quality, and empty/loading/streaming states.
  Compare **blind** where possible: put Vela's output beside the reference with labels stripped
  and pick the better one.
  **Vela must have its OWN visual identity — do not copy Anthropic's trade dress, colour
  palette, or marks.** Resemblance to Claude Desktop is not the goal; matching its *tier* is.
- **Performance:** a Tauri-class footprint. Real numbers, measured, with the machine specified.
- **Keychain-runtime:** keys live in Windows Credential Manager and nowhere else. Verify no
  plaintext on disk, nothing in logs. Note especially that **"no API key" is a first-class valid
  state** — local endpoints frequently have no auth at all — so an empty credential must not be
  an error, and must not produce an empty `Authorization` header.
- **Real-model:** see the GATE M Part 2 section in `VERDICTS.md` for the full characterization
  procedure and its interpretation limit.

---

## Open requests

_None yet._ Phase A (Tauri scaffold, secure IPC, settings, keychain credential store, SQLite
layer, and the GATE M Part 1 mock-provider harness) is still building and has not yet cleared
its cloud-side panel. The first request will be appended below when it does.

Expected first entries, once Phase A clears cloud critics:

- `A3-keychain-settings` → `keychain-runtime` (the credential store's real OS integration)
- `A1-scaffold-shell` → `visual`, `interaction`, `performance` (the app shell actually running
  in a Windows window, plus cold start and idle RAM for a packaged binary)
