# `phase-b-matrix/` — what Vela does when the endpoint misbehaves

This directory is the **Phase B** half of GATE M Part 1. Its sibling,
`../mock-matrix/`, records what four deliberately broken endpoints *did*. This
one records what **Vela's own provider stack does about it**, driven over real
TCP against those same four endpoints.

Phase A could not produce this directory: it shipped no HTTP client anywhere, so
the gate question — *does Vela degrade gracefully?* — had no code to ask it of.
Phase B is the first phase where the question is meaningful.

## Honesty

**Everything here is VERIFIED-BY-FAKE** (`docs/architecture/conventions.md` §10).
The four profiles are deterministic mock servers. Not one byte below came from a
language model. **GATE M Part 2 — a real llama.cpp at :8033 on the operator's
Windows host — is unreachable from this container, was not attempted, and remains
unverified.** Nothing here may be cited as a real-model result.

## What is in here

| File | What it is |
|---|---|
| `RESULTS.md` | The summary, the matrix, the findings, and the gate verdict. **Start here.** |
| `<profile>/00-…10-*.txt` | Verbatim transcripts: request bytes, response bytes, Vela's normalised outcome, wall-clock times, and every assertion with its verdict |
| `verdicts.tsv` | Every assertion in the run, machine-readable |
| `ASSERTION-CONTROL.txt` | Each assertion applied where it should *not* hold, with the FAIL recorded. An assertion that cannot fail is worthless |
| `SUMMARY.txt` | Counts and the failure list from the last run |
| `record.sh` | Regenerates all of the above |
| `structural/` | Round 3's half: five compile-time bypass attempts against `BodyStream`, and three defect injections into `src/http.rs`. `probe.sh` and `controls.sh` regenerate `probe-results.txt` and `control-results.txt`. **Round 4 adds `controls-round4.sh`** — four more injections, covering the redirect policy and both redaction barriers — writing `control-results-round4.txt` |

The case numbers follow the gate brief: `00` capability probe, `01` plain chat,
`02` tool calling (`02p` **parallel** tool calls, both transports), `03` vision,
`04` structured output, `05` context overflow, `06` reasoning, `07` stream
termination (`07b` a stalled socket, `07c` termination latency over five
samples), `08` malformed frames, `09` no credential (`09b` an endpoint that
demands one), `10` failover including an endpoint killed mid-request, `11` the
**credential canary** — `Auth::ApiKeyQuery` driven through seven real failure
paths with every rendering of every error grepped.

`02p`, `07c` and `11` are round-2 additions. `02p` exists because round 1 could
only *script* the parallel shape and the defect it missed lived exactly there;
the harness now answers a multi-tool request with a batch, so it is driven live.
`11` exists because round 2 shipped a credential-redaction fix, and a fix is not
evidence.

**Round 4 adds `12` and `13`, and rebuilds `07c`.**

* `12` **redirect egress** — the round-3 panel's security FAIL. A recording
  listener on a port the user never configured, a first-party endpoint that
  `3xx`-redirects to it, all four `Auth` variants (five bindings) across
  `complete()` and `stream()`, and a **positive control** that removes the policy
  and watches the canary arrive. Also the redirect-status sweep and the
  same-authority hop, neither of which anyone had driven.
* `13` **encoded credential leak** — the round-3 panel's functionality FAIL and
  the ground past it. Eight spellings of one credential, both bindings, both
  response shapes, both transports. **This is the case that fails.**
* `07c` used to build its provider with `Auth::None`, so it measured the
  empty-scrubber fast path and published those medians as evidence for redaction
  they never ran. It now measures a **credentialed** arm and keeps the
  uncredentialed one beside it, so the cost of redaction is visible.

Case 11's **premise** — did the endpoint really echo the credential back? — is
read in round 3 from each raw TCP peer's own send buffer, not from the recorder's
body tee. It used to be read from the tee, and round 3's fix scrubs before any
decorator can see a byte, so the tee went blind and the guard went red against a
tree that was in fact clean. The peer is upstream of everything Vela does; it is
the honest place to ask. What the tee sees is now asserted too, for the opposite
reason: it is what Vela's SSE parser consumes, and it must already read
`<redacted>`.

There are now **three** canaries, each with its own permitted home, and the
recorder fails the gate if one turns up anywhere else:

| canary | belongs in | why |
|---|---|---|
| `vela+gate/m1-7Q2Xz9f3a-DO-NOT-LEAK` | `11-credential-leak.txt` | round 2's, kept |
| `vela+gate/m4-encode-Zx7Tn2q-DO-NOT-LEAK` | `13-encoded-credential-leak.txt` | there the **spelling is the evidence**; masking it would destroy what a reader has to see |
| `vela+gate/m4-redirect-Rk2p9Wq-DO-NOT-LEAK` | **nowhere** | case 12 masks it wherever it prints received bytes, so it should not appear at all |

All three are fakes that were never credentials for anything.

## Reproducing

```bash
bash docs/regression-baseline/phase-b-matrix/record.sh
```

```bash
bash docs/regression-baseline/phase-b-matrix/structural/probe.sh      # 5 bypasses
bash docs/regression-baseline/phase-b-matrix/structural/controls.sh   # 3 defect injections
```

Needs Node 22+ on `PATH`; the recorder starts and stops its own servers on ports
the OS assigns — the four mock profiles as Node processes, plus the raw TCP peers
it needs for cases 11, 12 and 13. It exits non-zero if any gate assertion fails.

**As of round 4 it exits 1.** FINDING 1 and FINDING 2 are closed and stay
closed; the round-3 panel's two FAILs (credential egress on redirect, and
encoding-defeated redaction) are both closed and re-verified live. **FINDING 3
is open** — three spellings of a credential reach every error surface. See
`RESULTS.md` §5.

`controls.sh` edits `src-tauri/crates/vela-providers/src/http.rs` in place to
re-introduce each defect, and restores it from a backup on every exit path
including a failure. If it is ever interrupted hard,
`git checkout src-tauri/crates/vela-providers/src/http.rs` is the recovery.

The recorder is `src-tauri/crates/vela-providers/examples/gate_m_phase_b.rs`. It
is an example rather than a test on purpose: it writes into `docs/`, and a
`cargo test` that rewrites the repository would be a trap. It is still compiled
and linted by `cargo clippy --workspace --all-targets`, so it cannot rot silently.

Because the servers are deterministic, `git diff` over this directory is close to
a regression test. Two things legitimately differ every run and should be ignored
when reading a diff: **wall-clock lines**, and the **ephemeral port numbers** in
the recorded URLs.
