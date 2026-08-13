# `phase-b2-matrix/` — GATE M Part 1, Phase B2: the CROSS PRODUCTS

This directory is the live half of GATE M Part 1. Its two siblings are history:

| directory | what it is |
|---|---|
| `../mock-matrix/` | what four deliberately broken endpoints **did** |
| `../phase-b-matrix/` | **FROZEN.** Round 4's record of what Vela did about it — a run that exits 1 and names FINDING 3 open |
| **`.` (here)** | **LIVE.** The B2 run: every round-4 case re-driven, plus six cross-product cases |

## Honesty

**Everything here is VERIFIED-BY-FAKE** (`docs/architecture/conventions.md` §10).
Every endpoint is a deterministic mock — the four Node profiles, plus purpose-built
loopback peers for the cases that need a dialect the profiles do not speak. **Not one
byte below came from a language model.** **GATE M Part 2 — a real llama.cpp at :8033
on the operator's Windows host — is unreachable from this container, was not
attempted, and remains unverified.** Nothing here may be cited as a real-model result.

## Why this directory exists at all

Four gate rounds drove the matrix **case by case**. Every case was driven; every
**pair** of cases was not. FINDING 3 — the highest-severity defect of the whole run,
in which an unterminated `<think>` block turned a refusal into an executable
`delete_everything` — lived in the pair (case 06 reasoning, case 02 tools) and
survived four rounds because nothing ever put them in the same turn.

The lesson is not "add case 14". It is that **a matrix of independent cases has a
blind spot the size of its own cross product**, and the blind spot is where the next
defect is. Everything numbered 15 and above drives pairs — and drives all three
adapters, because cases 00–14 drive `OpenAiCompatible` and nothing else.

**It worked.** Case 16 — reasoning × structured output, a pair nobody had briefed —
is red on all three adapters and both transports. See `RESULTS.md` §3.

## What is in here

| File | What it is |
|---|---|
| `RESULTS.md` | The summary, the findings, and the gate verdict. **Start here.** |
| `<profile>/00-…20-*.txt` | Verbatim transcripts: request bytes, response bytes, Vela's normalised outcome, wall clock, and every assertion with its verdict |
| `verdicts.tsv` | Every assertion in the run, machine-readable |
| `ASSERTION-CONTROL.txt` | 25 controls: each assertion applied where it must **not** hold, with the FAIL recorded |
| `SUMMARY.txt` | Counts and the failure list from the last run |
| `record.sh` | Regenerates all of the above |
| `structural/controls-b2.sh` · `control-results-b2.txt` | Seven defect injections, **in a copy of the tree**, with the recorder re-run after each |

Cases `00`–`13` are round 4's, re-driven live. `14` is FINDING 3's turn. **`15`–`20`
are new and are all cross products:**

| case | the pair | why |
|---|---|---|
| `15` | reasoning × tools, **× all three adapters, × both transports** | FINDING 3 was closed and verified on one adapter; the defect lived in shared normalisation all three reach by three different routes |
| `16` | reasoning × structured output | **RED.** A value the model wrote inside a never-closed `<think>` and then rejected comes back as a schema-validated answer |
| `17` | tools × malformed frames | "skip the bad frame" and "`index` is the only join key, and it lives in the frames" are individually right and jointly dangerous |
| `18` | error-echo × every adapter × both transports | the stronger property: **no endpoint-derived text at all**, not merely no credential |
| `19` | cancellation × tool accumulation | *executor's pick.* A half-arrived call is a half-arrived call whether the MODEL truncated it or the USER pressed stop |
| `20` | the sibling surfaces × endpoint text | *executor's pick.* B2 closed `ProviderError`; `ChatResponse` crosses the same bridge and has three string fields nobody had audited |

Case `07c` gains an **arm C**, which is the regression critic's standing complaint made
mechanical: round 4's latency arm streamed 222 characters with **zero backslash bytes**,
so it measured a scrubber that short-circuited on every chunk. Arm C streams a payload
built to make every branch run, and prints the counts read off the wire.

## Reproducing

```bash
bash docs/regression-baseline/phase-b2-matrix/record.sh
bash docs/regression-baseline/phase-b2-matrix/structural/controls-b2.sh
```

Needs Node 22+ on `PATH`. The recorder starts and stops its own servers on ports the
OS assigns. **It exits 1**, and the reason is FINDING 4 — see `RESULTS.md` §3.

`controls-b2.sh` copies the tree to `$TMPDIR` before injecting anything. Its
predecessors in `../phase-b-matrix/structural/` patch the working tree and restore on
exit; that is not safe in this checkout, which a concurrent Phase C session shares and
which has already lost work to exactly that mistake.

## Canary containment

Unchanged from round 4, and still enforced by the recorder — it fails the gate if a
canary turns up in a transcript that is not its permitted home. B2 adds two more
markers, neither of which is or ever was a credential:

| marker | belongs in | why |
|---|---|---|
| `VELA-B2-ECHO-MARKER-Qp7Xn` | `18-error-echo-every-adapter.txt` | it is the thing case 18 proves does **not** reach the error surface; seeing it on the wire and not in the error is the evidence |
| `VELA-B2-SIBLING-MARKER-Wm4Zt` | `20-sibling-surfaces-x-endpoint-text.txt` | same, for the success-path fields |
