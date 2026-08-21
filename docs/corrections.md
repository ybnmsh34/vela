# Corrections

A false statement is a defect regardless of who made it. Correcting it is what makes the other
grades believable. This file records claims made by the lead, by builders, and by critics that
turned out to be wrong — with what was said, what is true, and how it was caught.

Entries are append-only. Do not delete a correction because it has been fixed; the record of
having been wrong is the point.

---

## 2026-08-21 (round 2) — the fix carried the defect one level down, four times

Every entry below was found by the round-1 critic, by mutating the tree rather than reading it.
All four are the same shape as the entry beneath this one, and three of them are that entry's own
fix.

### 1. `--from` printed `VERIFY_EXIT=0` over nine gates it never started

**Claimed:** `docs/release-posture.md` §13b, "The final run, with the corrected probe", showing
`cargo-test PASS 0 168.2 / RUST_TAIL=CONFIRMED / VERIFY_EXIT=0`, presented as the evidence that the
release path is green.

**True:** that was `node scripts/verify.mjs --from cargo-test` — a ONE-gate run. Its full summary
line, which the quotation dropped, was `1 passed, 0 failed, 0 SKIPPED (skipped is not passed)`. The
nine gates ahead of it were recorded `NOT-RUN` in the table and then excluded from the summary
counts *and* from the exit code, so a run that certified nothing exited 0. The ten-gate table
printed beside it in the same section carried no `VERIFY_EXIT` line at all, and had ended at 1.

**How it was caught:** the critic ran `--from` on a synthetic three-gate file and read the output.

**Consequence:** `NOT-RUN` is now counted in the summary line and in the exit status. A resumed run
whose every executed gate passed exits **3** and prints `INCOMPLETE: n of m gates were not run`.
`src/platform/verify-runner.test.ts` asserts it, with a control that the same gates without
`--from` still exit 0, and a stamp-file check that a gate reported NOT-RUN did not execute. §13b
below now carries a genuine ten-gate run instead.

### 2. `check-bundle.mjs` could not tell the installer from the application

**Claimed:** the header of `scripts/check-bundle.mjs`, step 3 — "an NSIS setup is a PE image (MZ).
A guard that reads the first eight bytes cannot be fooled by a text file."

**True:** it cannot be fooled by a text file, and it could be fooled by `vela.exe`. Copying
`src-tauri/target/release/vela.exe` (18,095,104 bytes) into `bundle/nsis/` as
`Vela_0.1.0_x64-setup.exe` produced `OK ... NSIS setup (PE image)`, `BUNDLE_OK=yes`, exit 0 — the
guard certifying the application binary as its own installer. The defect the file exists for is a
build that produced `vela.exe` and no installer; this is that defect with a `cp` in front of it.
`bundle-guard.test.ts`'s own `goodNsis()` fixture was a zero-filled buffer starting `MZ`, so the
test agreed with the guard on the wrong question and no mutation of step 3 could have shown it.

**How it was caught:** the critic performed the copy.

**Consequence:** the `nsis` row now also demands NSIS's first-header signature — `EF BE AD DE`
followed by `NullsoftInst` — anywhere in the file. Measured on this tree: present once, at offset
52,744, in the real 5,444,437-byte setup; absent from `vela.exe`, which contains no `Nullsoft`
substring at all. `bundle-guard.test.ts` gains step 3b (a PE image without it is
`APP-NOT-INSTALLER`) and a control (the same fixture plus those sixteen bytes is `OK`).

### 3. A comment in `verify.mjs` described a rule the file two doors down says was abandoned

**Claimed:** `scripts/verify.mjs`, in the tail-probe block — "The probe derives its own threshold
from the newest source in the workspace, which is the invariant `cargo test` actually establishes.
See the header of `scripts/check-rust-tail.mjs`."

**True:** the probe derives no threshold and demands no age. `node scripts/check-rust-tail.mjs`
prints `age demand: (nothing: no age is demanded ...)` on its second line. The header it cites
records the newest-source rule as the SECOND of two freshness attempts, both abandoned for
producing false reds. The comment was a survivor of a discarded design, pointing at the document
that refutes it.

**And the same false claim was two files away.** `scripts/gates.json`'s `_comment` said the probe
runs "with a `--since` sentinel taken when the run started". It does not; the runner passes
`--root` and nothing else. Correcting one and not the other is how the last round shipped a false
comment two files from its own fix, so both were grepped for and both are fixed.

**How it was caught:** the critic ran the probe.

### 4. `scripts/bundle.mjs` was driven by no test at all

**Claimed:** that file's header, at length — "WHY THE CHECK RUNS EVEN WHEN THE BUNDLER FAILS ...
`x && y` would skip it."

**True:** nothing held it. Inserting `if (buildExit !== 0) { process.exit(1); }` ahead of the disk
check — which deletes the argument entirely — left all 72 tests in the four release-path test
files green (the critic's measurement, from the mutation they performed). The `BUNDLER_EXIT=` and
`BUNDLE_EXIT=` lines it prints had no reader anywhere either.

**How it was caught:** the critic mutated the file and ran the suite.

**Consequence:** `src/platform/bundle-runner.test.ts` drives the real CLI against a synthetic tree
with a fake bundler: one that exits 1 after writing good installers (the load-bearing case — the
check's own output must still be in the log), one that exits 0 after writing none, one control that
works, and one that writes installers dated two days ago, which is what the sentinel is for. Under
the mutation above the first goes red, twice, and no other test file changes verdict.

---

## 2026-08-21 — "verify covers CI" was a claim about text, not about execution

**Claimed:** `src/platform/verify-covers-ci.test.ts` established that `pnpm verify` is a superset
of CI. Its own header says so, and names the failure it was written to close: "`pnpm verify` was
quietly narrower than the workflow: it ran the tests but not `pnpm build`, not `cargo build`".

**True:** it established that each CI gate's *command string* appears somewhere in the expanded
`verify` script. `VERIFY` was `expand(PACKAGE.scripts.verify)` and every assertion was
`matches.test(VERIFY)`. Run at tag `run-start-2026-08-17` on the platform Vela ships on:

```
> vela@0.1.0 lint:rust
> cd src-tauri && cargo fmt --all --check && cargo clippy ...
'cargo' is not recognized as an internal or external command,
ELIFECYCLE  Command failed with exit code 1.
VERIFY_EXIT=1
```

`&&` short-circuits. Gates 3 through 10 — every test suite, the frontend build, the secret
tripwire and both cargo gates — never started, and the guard was 42/42 green, because the string
contains them whether or not a process is ever spawned.

**How it was caught:** by running the documented command and reading the transcript, rather than
by reading the guard. The guard cannot catch this; it is the wrong question, not a wrong answer.

**Same class, one level down.** The original defect was "the text does not mention the gate". The
fix made the text mention the gate. The defect moved to "the text mentions a gate that does not
run" — which the fix's own guard was, by construction, unable to see.

**Consequence:** the gate list moved to `scripts/gates.json` as structured data; `scripts/verify.mjs`
runs it and reports PASS / FAIL / **SKIPPED** per gate with each child's real exit status;
`src/platform/verify-runner.test.ts` asserts that a gate reported SKIPPED *did not execute*, by
having every synthetic gate stamp a file and then reading the directory. `verify-covers-ci.test.ts`
keeps its static scope and now says so in its header: it answers "could verify reach every CI
gate", never "did it".

---

## 2026-08-21 — three items in the T01 brief described work already done, or work with no subject

**Claimed** (track T01 brief, items 4, 6 and 7): add `rust-toolchain.toml`; add `test:harness` and
`build` to Windows CI; confirm that `vela.db`, `diagnostics\` **and backups** resolve to real user
paths.

**True**, read off the tree at `run-start-2026-08-17`:

| brief item | state at the tag |
|---|---|
| add `rust-toolchain.toml` | `src-tauri/rust-toolchain.toml` exists, pins `channel = "1.97.1"` with `rustfmt` and `clippy`, and carries a 50-line rationale about rustfmt output moving between releases |
| add `test:harness` and `build` to Windows CI | both are already steps of the `test-windows` job in `.github/workflows/ci.yml` — `GATE M Part 1 — mock capability matrix` (wrapped in the crash-retry) and `Frontend build` |
| confirm backups resolve to a real path | Vela writes no backups. No `.rs` file in `src-tauri/` contains a backups directory, a backup path constant or a backup routine |

**How it was caught:** the brief says to re-verify from the bytes rather than from the brief,
because "briefs on this project have carried invented symbols and wrong line numbers". Doing that
found it.

**Consequence:** none of the three was performed. Recorded here so the next reader does not go
looking for a `rust-toolchain.toml` commit that would have overwritten a deliberate pin, or for a
backups directory that does not exist.

---

## 2026-08-17 — the ladder itself was one notch narrow

**Claimed:** Projects, Skills and Schedules reached `reaches-user`, the top tier, on the strength
of being clicked in a running window.

**True:** that evidence is `dev-clicked`. A dev binary against a Vite dev server, CDP-dispatched
events rather than OS input, and app-data substituted into an isolated profile inside an MSIX
container — three substitutions from the shipping product.

**How it was caught:** the operator. Not by any agent, and not by the audit, which had *already
written down* the three substitutions in a paragraph headed "What this evidence is not" and then
graded the section top-tier anyway. The defect was in the rule, not the measurement: `reaches-user`
was defined as "clicked in a running window", which asks *did something respond to a click* when
the question is *does this reach a person who installed the app*.

**Consequence:** the ladder now has five rungs (`traced` → `test-bites` → `dev-clicked` →
`reaches-user` → `ships`), and nothing rises above `dev-clicked` until an installer exists.

This is the same class the whole run is organised around — a check asking a question one notch
narrower than the real one — occurring in the definition of the check that grades everything else.

---

## 2026-08-16 — seven corrections from the previous session

Carried forward from the session record so they are not lost with the scrollback.

| # | claimed | true | caught by |
|---|---|---|---|
| 1 | contrast ratios of 1.17:1 / 1.11:1, stated twice | **1.19:1 / 1.14:1**, settled to four decimals by three independent derivations | a builder recomputing rather than accepting the brief |
| 2 | "the app renders nothing" | cold-start latency on a first-run Vite dev server | re-checking `mount` a minute later |
| 3 | "that's the explanation" for the app's disappearance | stated before the confirmation ran; the first confirmation was inconclusive (a modal covered the titlebar) | the lead's own follow-up test |
| 4 | the harness sent "59 of 95 characters wrong" | **32** carried a wrong virtual-key code; 59 had at least one wrong field. The builder's own README contradicted itself | a critic re-deriving the character table by hand |
| 5 | the harness calibration was "strong evidence the account is right" | it validates exactly one claim — that VK 46 swallowed the character — and says nothing about five other modelled commands | a critic replacing `DeleteForward` with a pure swallow and getting identical output |
| 6 | a lead brief specified the range as "12–13" | the builder sampled four more times, got 14/16/17/17, and refused the instruction. **The brief would have planted the defect it was sent to fix** | the builder declining a lead instruction |
| 7 | "two orphans in `src/data`" | one. `skills-repository.ts` is value-reachable in four edges from `main.tsx` | a builder rebuilding the census on the TypeScript AST |

**The pattern across all seven:** five were caught by an agent refusing to accept a claim from the
agent above it. None were caught by more care from the agent that made them.

---

## How to add an entry

Record: what was claimed, verbatim where possible; what is true, with the evidence; who caught it
and how. Do not soften. "I was wrong about X because I assumed Y" is worth more than a silent fix,
because the assumption is reusable and the fix is not.
