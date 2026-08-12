# Vela — Gauntlet Loop Progress

**Run started:** 2026-08-12
**Lead orchestrator:** decomposition + integration only (does not build, does not grade)
**Branch:** `claude/new-session-tgl1ut` · **PR:** [#1](https://github.com/ybnmsh34/vela/pull/1)

---

## RUN STATUS: 🟢 RUNNING

Two sessions build this repo and coordinate **only through files**:

- **CLOUD** (this session) — headless Linux container. Owns functionality, architecture,
  security (static), regression, and the entire GATE M Part 1 mock matrix.
- **DESKTOP** (operator's Windows machine) — owns five verdicts this container is structurally
  incapable of producing. See [`docs/desktop-gate/`](./desktop-gate/).

Neither session can see the other's context. Handoff is
[`REQUESTS.md`](./desktop-gate/REQUESTS.md) → [`VERDICTS.md`](./desktop-gate/VERDICTS.md).

---

## Verdict ledger — cloud and desktop side by side

Legend: ✅ PASS · ❌ FAIL · 🟡 in progress · ⏸️ **AWAITING_DESKTOP** · ⏳ DEFERRED · ⚪ n/a · — not started

| Piece | Func | Arch | Sec (static) | Regr | GateM P1 | ‖ | Perf | Keychain-rt | Visual | Interact | Real-model | State | Rounds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **P0** repo inventory | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ | ‖ | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ | ✅ COMPLETE (null result) | 1 |
| **P1** docs → feature spec | 🟡 | ⚪ | ⚪ | ⚪ | ⚪ | ‖ | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ | 🟡 synthesis running (8/8 areas ingested) | 1 |
| **A1** Tauri scaffold + IPC | 🟡 | 🟡 | 🟡 | ⚪ | 🟡 | ‖ | ⏳ | ⚪ | ⏳ | ⏳ | ⚪ | 🟡 built, panel not yet convened | 1 |
| **A2** SQLite data layer | 🟡 | 🟡 | 🟡 | ⚪ | 🟡 | ‖ | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ | 🟡 built, panel not yet convened | 1 |
| **A3** keychain + settings | 🟡 | 🟡 | 🟡 | ⚪ | 🟡 | ‖ | ⚪ | ⏳ | ⚪ | ⚪ | ⚪ | 🟡 BUILDING (builder mid-write) | 1 |
| **A4** mock-provider harness | 🟡 | 🟡 | 🟡 | ⚪ | ✅ evidence captured | ‖ | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ | 🟡 built, panel not yet convened | 1 |
| **B–H** | — | — | — | — | — | ‖ | — | — | — | — | — | not started | 0 |

**No critic panel has convened yet.** Every 🟡 above means *built, ungraded* — not *passing*.
The Phase A workflow still has integration → GATE M execution → the three binary critics ahead
of it. Nothing in this table may be read as a pass.

### Evidence landed so far (inspectable, not summarized)

- `docs/regression-baseline/mock-matrix/` — **all four profiles, 13 cases each**: health, props,
  models, plain completion (JSON + SSE), tools (JSON + SSE), vision, structured output, context
  overflow, max-tokens, unknown-model. Deterministic and byte-reproducible, so `git diff` over
  the directory is itself a regression test — and CI enforces exactly that.
- `docs/regression-baseline/phase-a/` — app-shell screenshots, light and dark.
- The harness stamps a `vela_mock` block into `/health` and `/props` so a transcript lifted out
  of that directory can never be mistaken for a capture from a real model server. No app code
  may read it.

**A piece with ANY deferred critic outstanding is NOT complete.** It is ⏸️ AWAITING_DESKTOP —
never reported as passing, and no dependent work is built on the assumption that it passed.

---

## GATE M — capability matrix

### Part 1 — mock matrix · 🟡 RUNNING (fully executable here)

Four capability profiles exercised in-container. This is the **sole evidence source for
graceful degradation** in the entire project.

| profile | tool-calling | vision | context | structured output | reasoning |
|---|---|---|---|---|---|
| frontier | native | yes | 200k | yes | yes |
| mid-local | native | no | 32k | no | yes |
| small-local | NONE | no | 8k | no | no |
| hostile | malformed/partial | no | 4k | no | interleaved junk |

A piece FAILS the gate if, under any profile, it crashes, hangs, silently produces wrong output,
or offers UI affordances the profile cannot support. Degradation must be **explicit and
asserted**, never incidental. Raw transcripts land in `docs/regression-baseline/mock-matrix/`
so critics inspect real bytes rather than summaries.

### Part 2 — real-model smoke check · ⏳ DEFERRED TO DESKTOP

Owned by the desktop session; procedure and interpretation limit in
[`VERDICTS.md`](./desktop-gate/VERDICTS.md).

The llama.cpp server (Qwen3.6-27B, `n_ctx` 131072, vision via mmproj, `<think>` on by default)
runs on the operator's Windows host behind home NAT. This container sits on RFC 5737 TEST-NET-1
with no route to it. **Not a blocker and not retried** — reassigned, not abandoned.

> **Binding interpretation limit:** that model is 27B, vision-capable, 131k-context, and
> reasoning-enabled — a STRONG model. Passing against it proves the **happy path only**. It is
> never cited as evidence of graceful degradation or model-agnosticism. That evidence comes
> exclusively from the Part 1 mock matrix.

---

## Deferred critics — what this container cannot judge, and why

| Critic | Reason | Cloud still does |
|---|---|---|
| `performance` | Cold start, idle RAM, and streaming throughput in a shared Linux container are meaningless for a Windows desktop binary. | nothing — fully deferred |
| `keychain-runtime` | No Credential Manager / Keychain / libsecret exists here. | **static** review of the credential code path — binding as a normal FAIL |
| `visual` | Cloud renders Linux WebKitGTK; Windows ships WebView2. Materially different. | ADVISORY pre-check for gross layout breakage — **PROVISIONAL, never final** |
| `interaction` | Same engine gap, plus no real input latency, window management, or focus behavior. | ADVISORY pre-check only — **PROVISIONAL, never final** |
| `real-model` | Server is behind home NAT, unroutable from this sandbox. | GATE M Part 1 mock matrix instead |

Windows/macOS builds are likewise not viable from here.

**Nothing in this deferral relaxes the remaining panels.** Functionality, architecture,
security-static, regression, and GATE M Part 1 run at full rigor on everything non-GUI.

---

## Phase 0 — complete, with a null result

The repository was **completely empty**: zero commits, zero objects, zero remote refs. Verified
via `git log`, `git ls-remote`, `git count-objects`, and `ls`. Detail in
[`vela-inventory.md`](./vela-inventory.md).

- No code to inventory, no suite to baseline, no screens to screenshot.
- The **regression baseline is the empty set** and accumulates from Phase A onward. The
  "do not break what works" rule is vacuously satisfied until the first working flow lands.
- The *"stay on Electron if already committed"* conditional **does not fire** →
  **Tauri v2**, uncontested.
- `main` did not exist; created at `d205a88` solely to give PR #1 a base. Working tree untouched.

---

## Standing honesty commitments

- No mock result is ever reported as a real-model result.
- Any critic that cannot obtain its external reference **fails closed** and says so.
- Nothing verified only against a fake is described as verified on real hardware —
  such results are labelled **VERIFIED-BY-FAKE**.
- Cloud-side visual and interaction runs are labelled **PROVISIONAL** wherever they appear.
- A desktop **FAIL** is exactly as binding as a cloud FAIL. No override, no averaging, no
  "but it passed here."
- A verdict citing a sha older than that piece's current HEAD is **STALE**, does not count,
  and is re-requested.
- PASS is explicitly permitted. "No meaningful gap" and "no regression" are complete, acceptable
  reports when true. Failures are not manufactured to appear rigorous.

---

## Sequencing decisions

**Phase B is deliberately held, not blocked.** The Phase A workflow still has its integration
agent ahead of it, whose whole job is reconciling three parallel builders into one coherent
tree. Launching a second workflow that writes to the same tree concurrently would fight that
reconciliation and produce exactly the thrash the run is meant to avoid. Phase B (provider
abstraction + capability negotiation, exercised against the Part 1 mock matrix) launches the
moment Phase A's panel returns — and it is genuinely independent of every deferred desktop
verdict, so it will not be gated on the desktop session.

**CI carries a draft guard.** This PR accumulates in-flight commits from parallel build agents,
so CI stays quiet while it is a draft and gates every push once marked ready for review. A red
run on half-written code is noise, not signal. It can be run on demand at any time via
`workflow_dispatch`.

## Open blockers

**None.** GATE M Part 2 is reassigned to the desktop session, not blocked. No operator decision
is outstanding.
