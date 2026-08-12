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

Phase A cleared its full cloud panel on 2026-08-12 — functionality, architecture, and security
all returned PASS, `failing: []`. The two pieces below carry deferred critics and are therefore
**AWAITING_DESKTOP, not complete**.

Useful setup for both: `pnpm install && pnpm build`, then `pnpm tauri dev` (or build a release
binary). `pnpm verify` runs the full cloud-side suite. The Tauri release binary **compiles and
links on Linux but was never launched** in the cloud container — there is no display server — so
you are the first to actually run it.

---

## A1-scaffold-shell — Tauri v2 app shell, secure IPC bridge, adapter seam

- **commit:** `cb385356937efb04781926f9326ec43a748f4f7c`
- **status:** AWAITING_DESKTOP
- **deferred critics:** `visual`, `interaction`, `performance`
- **cloud verdicts already passed:** functionality (PASS), architecture (PASS), security (PASS)

**What to exercise**

1. Launch the real app on Windows. Confirm the window opens, the title bar renders, and the
   shell paints in **both light and dark** — the cloud captured
   `docs/regression-baseline/phase-a/app-shell-{light,dark}.png` under **Linux WebKitGTK**;
   you are looking at **WebView2**, and any divergence is exactly what the cloud cannot see.
2. Toggle the OS theme while the app is running. The shell reads `Theme: system`; confirm it
   actually follows.
3. Check the platform-bridge panel resolves to the **`tauri`** adapter, not `browser`, and that
   the credential-store row shows the **real keychain**, not `memory-fake`.
4. Resize, minimise, restore, and move between monitors with different DPI.
5. **Performance, real numbers, on stated hardware:** cold start to first paint; idle RAM after
   60 s; RAM after ten minutes idle (leak check). Compare against a Tauri-class footprint.

**What "good" looks like**

Interaction and visual polish **at or above Claude Desktop, Linear, Raycast, and Zed** — a
quality *tier*, not a clone. Judge type scale and hierarchy, spacing rhythm, radii, elevation
discipline, colour-role system, dark/light theming, motion quality, and empty/loading states.
Compare **blind** where you can: screenshot Vela beside a reference, strip labels, pick the
better one.

**Vela must keep its OWN visual identity — do not reward resemblance to Anthropic's trade dress,
colour palette, or marks.** Matching the *tier* is the goal.

> **Calibration, so you do not fail this for the wrong reason:** this is a **Phase A diagnostic
> shell**, not product UI. There is no chat, no sidebar, no conversation view — those are Phase C.
> Judge the shell, the theming system, the type/spacing foundation, and window behaviour. A FAIL
> should mean *the foundation is not at tier*, not *the product is unfinished*.

---

## A3-keychain-settings — credential store and settings layer

- **commit:** `cb385356937efb04781926f9326ec43a748f4f7c`
- **status:** AWAITING_DESKTOP
- **deferred critics:** `keychain-runtime`
- **cloud verdicts already passed:** functionality (PASS), architecture (PASS), security (PASS —
  **static review only**; every credential test in the cloud ran against `MemoryStore` and is
  labelled VERIFIED-BY-FAKE. `KeyringStore` has **never been executed anywhere**.)

**What to exercise**

1. Store an API key through the app. Confirm with `Get-StoredCredential` / `cmdkey /list` that it
   lands in **Windows Credential Manager** under the expected target name.
2. Round-trip it: read it back, update it, delete it. Confirm deletion actually removes the entry.
3. **Canary scan.** Put a unique string in as a key, then grep the SQLite DB, its `-wal` and
   `-shm` files, every app-data file, and all logs for that string. It must appear **nowhere**.
   The cloud proved this at byte level against `MemoryStore`; you are proving it against the real
   backend.
4. **The `Auth::None` path — the load-bearing case.** Configure a local endpoint with **no
   credential at all** (`http://localhost:8033/v1`). It must be accepted as a **first-class valid
   state**: not an error, not a validation failure, and it must send **no `Authorization` header
   whatsoever** — not an empty one. Capture the real outbound request to prove it.
5. Confirm a **non-loopback** no-auth endpoint (e.g. `http://192.168.1.50:8033/v1`) reports an
   elevated risk signal rather than silent trust.
6. Restart the app; confirm credentials survive and settings reload correctly.
7. Confirm telemetry is off and has no enable path.

**What "good" looks like**

Keys in Credential Manager and **nowhere else**. No plaintext on disk, nothing in logs. `Auth::None`
works end to end without ceremony — a user pointing Vela at a local llama.cpp with no key must
never see an error. The risk signal for off-machine no-auth endpoints is surfaced, not buried.

> **Known cloud-side gap worth your attention:** `Auth::ApiKeyQuery` puts the credential in a
> query string. It is documented as discouraged, but `SecurityPosture` has **no `Concern` variant**
> for it, so an HTTPS remote endpoint using query-param auth currently reports `RiskLevel::None`
> even though the key lands in server and proxy access logs. The cloud security critic flagged
> this as non-blocking. If you judge it worse than that on real usage, say so.
