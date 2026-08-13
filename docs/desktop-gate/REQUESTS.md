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

## ▶ START HERE — `GATE-M2-real-model` (ready now, nothing else blocks it)

- **commit:** any current HEAD of `claude/new-session-tgl1ut`
- **status:** VERDICT_WRITTEN — **FAIL** at `51b5e163df22958853b24a281aa40268b5a1f44f`.
  See [`VERDICTS.md`](./VERDICTS.md) § `GATE-M2-real-model`. Largest gap: the shipping host
  registers no provider (`src-tauri/src/state.rs:42`), so no turn from the real UI can reach any
  endpoint. The provider core itself passed against real model bytes.
- **deferred critics:** `real-model`
- **cloud verdicts already passed:** n/a — this is evidence the cloud is structurally incapable of
  producing, not a re-judgement of cloud work.

**Why this one first.** Every result in this repository is **VERIFIED-BY-FAKE** — four
deterministic mock profiles, and not one byte from a language model. That is the **largest hole in
the project's evidence base**, it is stated plainly in every gate report, and it is the one thing
no amount of cloud work can close. It is also completely independent of what the cloud is currently
building, so it cannot be invalidated by work in flight.

**What to exercise** — the full procedure, including the interpretation limit and the `--jinja`
caveat, is in [`VERDICTS.md`](./VERDICTS.md) under "Specific guidance for `real-model`". In short:
`GET /props` and `/v1/models` to characterise the server; a `tools[]` payload to see whether real
`tool_calls` come back or plain text; an image input to prove the vision path; a prompt exceeding
`n_ctx`; and confirmation that Vela separates `<think>` reasoning from the answer **and excludes it
from tool-call parsing**. Save raw transcripts to `docs/regression-baseline/local-smoke/`.

**Run serially, max 2 in flight** (`n_slots = 4`, `kv_unified = true`). **Do not restart or
reconfigure the server.**

> **Binding interpretation limit:** Qwen3.6-27B is a strong model — 27B, vision-capable,
> 131k-context, reasoning-enabled. Passing against it proves the **happy path only**. It is never
> evidence of graceful degradation or model-agnosticism; that evidence comes exclusively from the
> mock matrix. A report that overstates this is worse than no report.

---

## 📌 STATUS FOR THE DESKTOP SESSION — read before spending time on the app

**Your two blockers are acknowledged, and one is already fixed.**

| Blocker | State |
|---|---|
| `icons/icon.ico` missing → `tauri-build` fails | ✅ **FIXED at `a50ee9f`.** Pull. A 3-entry ICO (32, 128, and the 512×512 `icon.png` carried under the ICO 256 marker) assembled from the repo's own PNGs. It is hand-built — this container has no image tooling — so **`pnpm tauri icon` on your machine is the better regeneration path** if you want a proper 256px rendition. Landed by the lead, not by you, so your FAIL stands ungraded by its own reporter. |
| `Markdown.tsx` / `markdown.ts` case collision → **blank white app** | ✅ **FIXED at `d0092af`. Pull.** The parser is now `markdown-parser.ts`, so the two stems genuinely differ rather than differing only in case. |

### What I verified before telling you it is fixed

- `MessageTurn.tsx:12` binds the **component** — there is no longer a `.ts` for Vite to prefer.
- `Markdown.tsx` imports `parseMarkdown` from `./markdown-parser`.
- **A sweep of every directory in `src/` and `src-tauri/src/` finds no remaining case-only
  collision**, and `src/platform/case-collision.test.ts` now guards the class.
- `pnpm typecheck` passes clean.

**So the app should BOOT and RENDER on Windows now.** `visual` and `interaction` are worth your
time again.

### ⚠️ But a turn will still fail — that part is mid-fix

The provider registry is **still empty** as I write this; the builder wiring it is running right
now. So expect the UI to come up, show a configured provider, and then fail the send with
`NOT_FOUND`. **That is finding 1 from your own verdict, not a new defect** — do not re-report it,
and do not judge `performance` on a run that cannot complete a turn.

Judge what renders: layout, type, spacing, theming, focus behaviour, empty and loading states.
Hold `performance` and any end-to-end timing until I tell you the registry is wired.

**What is also worth your time now:** `keychain-runtime`. It exercises the Rust side and the OS
credential store and never needed the renderer at all. Its request below is stale only in its
*risk-signal expectations*; the canary and `Auth::None` steps still hold exactly.

**Your unrequested findings were the right call.** You were asked for `real-model` and instead also
reported that the app cannot build, then cannot boot, on the operator's actual platform. Both are
invisible from a Linux container **by construction** — case-insensitivity and the Windows resource
step do not exist here. Keep reporting outside the request when you find something that makes the
request meaningless.

## ⚠️ STALE — do not action as written

Both requests below were filed at `cb38535` and are **stale by this run's own rule**: a verdict
against a piece whose files have since changed does not count, and the same applies to a request
whose subject has changed underneath it.

| Piece | Commits touching its surface since `cb38535` | Why the steps are wrong now |
|---|---|---|
| **A1-scaffold-shell** | **13** | It tells you to judge a *diagnostic shell* — a bridge-status panel and a placeholder region. Phase C has since built the real conversation UI on top. Judging the old steps would either fail the app unfairly or pass it meaninglessly. |
| **A3-keychain-settings** | **2** (`36d13fe` security findings, `a59b96e` provider core) | The credential model gained `Concern::QueryParamCredentialIsLogged` and the risk ladder is now derived from `Concern::severity()`. The canary steps still hold, but the risk-signal expectations are out of date. |

**Both will be re-filed with fresh shas and corrected steps when Phase C clears its cloud panel** —
which is also when the *first real* visual and interaction verdicts become worth your time. Judging
UI that may still be sent back to its builders wastes the effort.

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
