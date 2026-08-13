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

The case numbers follow the gate brief: `00` capability probe, `01` plain chat,
`02` tool calling, `03` vision, `04` structured output, `05` context overflow,
`06` reasoning, `07` stream termination (`07b` a stalled socket), `08` malformed
frames, `09` no credential (`09b` an endpoint that demands one), `10` failover
including an endpoint killed mid-request.

## Reproducing

```bash
bash docs/regression-baseline/phase-b-matrix/record.sh
```

Needs Node 22+ on `PATH`; the recorder starts and stops its own servers on ports
the OS assigns. It exits non-zero if any gate assertion fails — and **it currently
does**, see FINDING 1 in `RESULTS.md`.

The recorder is `src-tauri/crates/vela-providers/examples/gate_m_phase_b.rs`. It
is an example rather than a test on purpose: it writes into `docs/`, and a
`cargo test` that rewrites the repository would be a trap. It is still compiled
and linted by `cargo clippy --workspace --all-targets`, so it cannot rot silently.

Because the servers are deterministic, `git diff` over this directory is close to
a regression test. Two things legitimately differ every run and should be ignored
when reading a diff: **wall-clock lines**, and the **ephemeral port numbers** in
the recorded URLs.
