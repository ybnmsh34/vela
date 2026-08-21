# Corrections

A false statement is a defect regardless of who made it. Correcting it is what makes the other
grades believable. This file records claims made by the lead, by builders, and by critics that
turned out to be wrong — with what was said, what is true, and how it was caught.

Entries are append-only. Do not delete a correction because it has been fixed; the record of
having been wrong is the point.

---

## 2026-08-21 (round 5) — a guard that computed its verdict twice, and five claims that were false when they were written

Round 4's prose was measured before this round started: **83** checkable claims, **5** false. Three
of the five sit in this file's own round-4 section, and two of those three were falsified by the
very commit that wrote them. That is the pattern round 4 was convened to close, reproduced instead
of closed, so this section states the rule it broke:

> A present-tense claim about what a grep returns, or about how many times a word appears, is
> falsified by the entry that makes it, because the entry adds text to the tree the grep runs over.
> Anchor such a claim to a commit and put it in the past tense, or do not make it.

Every claim added below is either anchored to a commit, or is a property of a file that this round
re-measured after writing it.

### 1. `scripts/check-rust-tail.mjs` wrote four fields no reader ever consumed, and computed its verdict twice

**Claimed:** round 4's report carried a heading the round-4 critic quotes as `WRITE-READ — the
unread writes, both closed`, and its §6, "What I found and did not fix", did not mention this file.

**True:** the heading was true of `scripts/check-bundle.mjs` and false of the track. The sibling
guard this track added in round 1 carried four writes with no reader anywhere in the repository:

- `rows[].source`, on all three row shapes;
- `rows[].binary` — the whole binary descriptor object — on the STALE and BUILT shapes;
- `binary.path`, inside that descriptor, which nothing read even through `row.binary`;
- `result.ok`.

The file has no exports, `parseArgs` accepts only `--target-dir`, `--since` and `--root` so there
is no `--json` mode, `main` printed only `row.verdict`, `row.name` and `row.detail`, and
`src/platform/rust-tail.test.ts` drives the script as a subprocess and asserts on its combined
stdout and stderr. The last
of the four is the interesting one: `main` re-derived the overall verdict from a `bad.length > 0`
of its own while `checkRustTail` computed `ok` and nobody read it. A guard with two derivations of
one verdict can disagree with itself, and while they agree the second derivation is invisible.

**Fix.** `binary` and `binary.path` are deleted; the two values inside that object which ever reach
a reader already do so through the detail strings — `mtimeMs` as the date in a STALE detail, `size`
as the byte count in a BUILT one. `source` is not deleted but printed: a MISSING row now reads
`no test binary in deps/ for src-tauri/tests/<name>.rs`, because the expectation set is derived
from the tree and a MISSING row is only actionable if it says which file it was derived from. The
path is normalised to forward slashes by a new `repoRelative`, so the row reads the same on Windows
and on a CI runner. `main` now branches on `result.ok`; `bad` survives only to count rows for the
failure message, which was also reworded — it said "have no compiled binary", which is false of a
STALE row, and now says "are not BUILT; see the rows above". Every row carries `name`, `verdict`
and `detail`, and `main` prints all three.

**Mutation evidence, each planted twice on a byte snapshot restored and re-hashed after every
cycle** (`sha256(scripts/check-rust-tail.mjs) = 878c997c…ff8f3e4b`, identical before and after).
Baseline across the five release-path test files is `91 passed (91)`, exit 0.

| mutation | result, twice | message |
| --- | --- | --- |
| `ok:` loses its `every(BUILT)` clause | `6 failed \| 85 passed (91)` | `expected 'check-rust-tail: deps directory C:\Us…' to contain '2 of 3 integration test targets are n…'`, plus five |
| the MISSING detail drops `+ repoRelative(root, target.source)` | `1 failed \| 90 passed (91)` | `expected 'check-rust-tail: deps directory C:\Us…' to contain 'no test binary in deps/ for src-tauri…'` |
| `repoRelative` returns `relative(root, path)` unnormalised | `1 failed \| 90 passed (91)` | same message — the Windows separators make the row unreadable to the assertion |

**And the control that proves the write was unread before, not merely undertested.** Restoring
round 4's `main` — `const bad = …; if (bad.length > 0)`, with `result.ok` consulted by nobody — and
planting the *first* mutation on top of it gives `91 passed (91)`, exit 0, twice. The same
corruption of the same field reds six tests once `main` reads it and reds nothing while it does
not. That is the difference between a field with a reader and a field with a comment saying it has
one.

### 2. "a row carries exactly two numeric fields" was a false universal, in the sentence written to replace a false universal

**Claimed:** round 4, entry 1 of this file — "a row carries exactly two numeric fields, `bytes` and
`signatureAt`" — and, more explicitly, the docblock round 4 wrote above
`src/platform/bundle-guard.test.ts`'s renamed block: "A row carries `target`, `file`, `path`,
`verdict` and `detail`, all strings, plus exactly two numeric fields: **`bytes` on every row**".

**True:** not every row reaches a file. Running the shipped guard against a tree with no
`release/bundle` directory prints rows whose keys are exactly `target`, `verdict`, `path`,
`detail` — no `file`, no `bytes`, no numeric field of any kind. `check-bundle.mjs`'s own human
output path writes `String(row.file ?? row.path)` for precisely that reason, which the round-4
critic pointed out. Round 3 failed for a block *name* that was a false universal about this
document; round 4 replaced the name and wrote a false universal about the same document in the
docblock underneath it.

**Fix.** The docblock now states the two shapes separately and says which one carries numbers, and
the claim is asserted rather than described: a new test,
`a row that never reached a file carries no number to read`, drives the guard over a config-only
tree and asserts both rows' key sets exactly. Adding `bytes: 0` to the NO-DIR row literal reds it
and nothing else, twice, `1 failed | 90 passed (91)`,
`expected [ 'bytes', 'detail', 'path', …(2) ] to deeply equal [ 'detail', 'path', 'target', …(1) ]`.
The block name `every number the --json row carries is read back here` is unchanged; it was true
and the critic said so.

### 3. The "ten-link" parenthetical was refuted by the fix described in its own paragraph

**Claimed:** round 4, entry 7b — "(The measurer attributed the "ten-link" phrase to
`scripts/verify.mjs`; it is in `scripts/check-rust-tail.mjs`. `grep -rn 'ten-link'` over the tree
returns that one site and no other.)"

**True:** both halves were false at the commit that stated them. The same entry's own fix had
rewritten that header, so the phrase was no longer in the script; and the tree-wide grep it invited
returned only this file, because this file had just quoted the phrase three times while describing
its removal. `git grep -n ten-link 52e6f37 -- scripts/` returns exactly one line, inside
`scripts/check-rust-tail.mjs`'s file header, which is where it *was*.

**Fix.** Past tense, and scoped to a directory this file cannot contaminate: the parenthetical now
says the phrase was in that header until the fix rewrote it, and that no file under `scripts/`
carries it now.

### 4. A count that its own commit invalidated: 97

**Claimed:** round 4, entry 3 — "the whole tracked repository gives 97".

**True:** 97 was the count at the parent commit, `52e6f37`. The commit that wrote the sentence,
`4517644`, added twelve more occurrences of the word `backup` — nine in this file (7 → 16) and
three in `docs/release-posture.md` (7 → 10) — so the tracked-repository count at the commit that
states 97 was **109**. Counted with `git grep -oih backup <commit> --`.

**Fix.** The figure is anchored and dated: `git grep -oih backup 52e6f37 -- | wc -l` gives 97, and
the sentence now says so, with a parenthetical noting that this particular figure moves every time
an entry discusses the word.

### 5. A sentence about `bundleRoot` that belonged to no investigation in this file

**Claimed:** round 4, entry 1, "How it was caught" — "The only `src/platform/` hits were a local
variable also called `bundleRoot`, used to build fixture paths."

**True:** false under every reading. The grep described is for `mtimeMs` and `.bytes`; neither
string occurs in the identifier `bundleRoot`, so `bundleRoot` cannot be a hit of it. At the pre-fix
commit the grep had no `src/platform/` hits at all: `git grep -n mtimeMs 52e6f37 -- src/` returns
nothing, and `git grep -n '\.bytes' 52e6f37 -- src/` returns three lines, all in `src/lib/base64.ts`
and `src/lib/base64.test.ts`.

**Fix.** The sentence is deleted and the paragraph is anchored to `52e6f37` in the past tense, with
the two greps quoted and the note that the `src/platform/` hits which exist today are the readers
that entry's own fix added.

### 6. "No gate reads this document" — gate 8 does

**Claimed:** `docs/release-posture.md` §13b, the scope statement above the ten-gate table — "No
gate reads this document — `check-transcripts.sh` reads only
`docs/regression-baseline/mock-matrix`, and the comment-claim guard's roots are …".

**True:** the two named gates were described correctly, but the sentence they supported was false,
and this track is what made it false. `scripts/secret-scan.sh` sets `excluded_paths=()`, so gate 8,
`test:secrets`, `git grep`s every tracked file — `docs/release-posture.md` among them — and its
verdict depends on this document's bytes. §13b already said so further down its own length —
"`test:secrets` reads tracked file contents, and this subsection was written after the runs it
describes" — so the subsection contradicted itself between its scope statement and its closing
paragraphs.

**Fix.** The paragraph now states that gate 8 reads this file, why nothing is excluded, and what
that gate reads it *for* — credential shapes, not claims — and then separates out the gates that
read prose for its content, naming `CLAIM_ROOTS` in `src/platform/claimed-guards.test.ts` and the
fact that this file is under none of them.

### 7. The fourth copy of the `&&`-chain sentence, in a file round 4 edited

**Claimed:** round 4, entry 7b — "Fixed in all three places". And
`src/platform/rust-tail.test.ts`'s docblock — "`pnpm verify` **ends** with `cargo build --workspace
--locked && cargo test --workspace --locked`".

**True:** "all three places" was accurate about the three sites carrying the phrase "eight `&&`
links", which is what that entry was about. But the same tense defect sat untouched in a fourth
site, and round 4 edited that file without correcting it. `package.json`'s `verify` is
`node scripts/verify.mjs`, and the last two gates are separate `command` entries in
`scripts/gates.json`; there is no `&&` chain to end with.

**Fix.** That docblock now opens "At tag `run-start-2026-08-17`, `pnpm verify` was one shell string
ending in …", says what replaced the chain, and says what survives the replacement — that an exit
code still cannot distinguish a tail that passed from a tail that never started, which is why the
guard exists. Its "cargo is on no shell's PATH" is also narrowed to what is true: cargo is not on
the default PATH here, it is in `%USERPROFILE%\.cargo\bin`, and a runner has to prepend it by hand.

**A fifth site, outside this track's diff, fixed anyway.** `scripts/run-bash.mjs` opened with
"`pnpm verify` chains nine gates with `&&`" — present tense, and nine was wrong at the tag too. It
predates `run-start-2026-08-17`, so this track did not write it; this track's round-1 change is
what made it false. Now past tense, anchored to the tag, with the replacement named.

### 8. A test labelled for a property it does not check

**Claimed:** `scripts/secret-scan.test.sh`, at the tag — `expect_clean "an empty repository is
clean"`.

**True:** that case plants a `README.md` and then asserts clean, so it never checked an empty
repository. It was harmless until this track added
`a_repository_with_no_tracked_files_is_refused`, which proves the scanner exits 2 on a genuinely
empty repository — at which point the file asserted a property that another test in it refutes
it. Not a sentence this track wrote; this track is what made it self-contradictory.

**Fix.** Retitled `a repository with one harmless file is clean`, with a comment saying why.

### 9. A round-1 transcript that reads as current output

**Claimed:** nothing, explicitly — `docs/release-posture.md` §13's `### The run on this branch`
block is framed as a past run and does not claim to be current. But it sits directly under the
paragraph explaining round 2's signature clause and shows
`OK ... NSIS setup (PE image)`, which is what the guard printed before that clause existed.

**True:** the shipped guard prints `NSIS setup (PE image carrying an NSIS payload)`, and the gap
between `OK` and the filename is 13 spaces in that block against the 17 that
`row.verdict.padEnd(18)` produces. Both are tells that the block is a round-1 capture.

**Fix.** The block is now labelled as a round-1 capture, the two tells are named, and a fresh
`check-bundle` run against the same artefacts on disk is printed above it.

---

## 2026-08-21 (round 4) — the numbers in the section whose job was to record what was measured

Round 3's write-up was itself measured, before this round committed, by an agent that ran the
commands rather than reading the sentences. Four of the seventy-four checkable claims in this
track's diff came back false. All four are claims round 3 wrote **while correcting round 2**,
which is the third round running that this has been the failing shape. Two further items below
were raised by the round-3 critic and are fixed here for the same reason.

### 1. Two fields were written into the `--json` document with no reader, under a block named for the opposite

**Claimed:** `src/platform/bundle-guard.test.ts` named its new block
`the --json document has a reader for every field it carries`.

**True:** it did not. The row literal in `scripts/check-bundle.mjs` was

```js
const row = { target: name, file, path, bytes: stat.size, mtimeMs: stat.mtimeMs };
```

and nothing anywhere in the repository read `rows[].bytes` or `rows[].mtimeMs` out of that
document. Both were written one line above `signatureAt`, the field round 3 had just given a
reader. The round-3 critic's words for this were "the round-2 defect displaced by one line rather
than removed", and the measurer reached the same finding independently by running the shipped
guard against a synthetic tree and enumerating the document it printed.

**How it was caught:** at commit `52e6f37`, the state this entry was measured against, a
repository-wide grep for `mtimeMs` and for `.bytes` across `src`, `scripts` and `tests` returned
the write site in `scripts/check-bundle.mjs` and nothing that consumes it: `git grep -n mtimeMs
52e6f37 -- src/` returned nothing at all, and `git grep -n '\.bytes' 52e6f37 -- src/` returned only
`src/lib/base64.ts` and `src/lib/base64.test.ts`, with no hit under `src/platform/`. The two
`src/platform/bundle-guard.test.ts` hits for `.bytes` that exist today are the readers this entry's
own fix added.

**Fix, and why each half went the way it did.** `mtimeMs` is **deleted** from the row. It was
never load-bearing: the freshness check reads `stat.mtimeMs` directly and so does the STALE detail
string, so the row copy was pure duplication. `bytes` is **kept and given a reader**, because it is
the one field that ties a TRUNCATED verdict to the artefact that earned it — the verdict alone
cannot separate a 1 KB stub from a 250 KB partial write, both of which are under the 262,144-byte
msi floor and both of which read TRUNCATED. The new
test `the --json row on a TRUNCATED verdict says how big the file it rejected was` writes a
1,024-byte MSI with perfect OLE2 magic and a perfect name, and asserts the TRUNCATED row's `bytes`
is 1,024 **and** the OK NSIS row's `bytes` is 4,000,000 — two different numbers, so a guard that
stamped a constant, or that reported the 262,144-byte floor it compared against, fails.

The block is renamed to `every number the --json row carries is read back here`, which is a
statement about the tests inside it and is checkable: two numeric field NAMES exist anywhere in the
document, `bytes` and `signatureAt`, and each has a test in that block that reads it back and
compares it to a value the fixture chose. Everything else in a row is a string the human output
path prints.

*Corrected in round 5.* This paragraph originally read "a row carries exactly two numeric fields",
and the docblock above the block said the same thing more explicitly — "`bytes` on every row". That
is a false universal, of the same kind as the block name it was written to replace. Measured by
running the shipped guard: a row that never reached a file is `{target, verdict, path, detail}`,
four strings, no `file` and no number at all, and `check-bundle.mjs`'s own `String(row.file ??
row.path)` is there because of it. Round 5 rewrote the docblock and added a test,
`a row that never reached a file carries no number to read`, so the shape is asserted rather than
described. Round 5, entry 2.

**Mutation evidence.** Three mutations of the write site, each planted, run twice across all five
release-path test files, and restored from a byte snapshot confirmed by sha256. Every one reds the
new test and nothing else:

| mutation | result, twice | message |
| --- | --- | --- |
| `bytes: stat.size` -> `bytes: 0` | `1 failed \| 87 passed (88)` | `expected +0 to be 1024` |
| `bytes: stat.size` -> `bytes: 1024` (the constant the TRUNCATED row wants) | `1 failed \| 87 passed (88)` | `expected 1024 to be 4000000` |
| `bytes: stat.size` -> `bytes: shape.minBytes` (the floor it compared against) | `1 failed \| 87 passed (88)` | `expected 262144 to be 1024` |

The middle row is the point of asserting both rows: a guard that satisfied the TRUNCATED assertion
with a constant fails on the OK row instead. And the round-3 mutation still bites — replacing
`findBytes`'s `indexOf` with `includes(...) ? 0 : -1` reds `the --json row says WHERE the NSIS
signature was found` and nothing else, twice, `1 failed | 87 passed (88)`, `expected +0 to be
52740`. That count read `86 passed (87)` in round 3 and is one higher now because of the test this
entry adds; the comment in `scripts/check-bundle.mjs` that quotes it has been updated to match.

### 2. `Sidebar.test.tsx` run alone was reported as `1 passed (1)`

**Claimed:** `docs/release-posture.md` §13b — "Run alone, `ModalSurface.test.tsx` was `8 passed
(8)`, exit 0, three times out of three; `Sidebar.test.tsx` was `1 passed (1)`, exit 0, three times
out of three."

**True:** the ModalSurface half is right. `src/features/navigation/Sidebar.test.tsx` contains
**fifteen** tests and run alone reports `Tests 15 passed (15)`. `1 passed (1)` is that file's Test
**Files** line, printed in a sentence whose other half is unambiguously a Tests line, and asserted
three times over. No invocation of that file produces `1 passed (1)` as a Tests line; the
`-t`-filtered form gives `1 passed | 14 skipped (15)`.

**How it was caught:** the round-3 critic ran the file. The measurer ran it again three times and
got `Test Files 1 passed (1)` / `Tests 15 passed (15)` / exit 0 every time, with ModalSurface as the
control. Round 4 ran it a third time, same result.

**Consequence:** the sentence now prints both lines explicitly for both files, so the two cannot be
confused again.

### 3. The `backup` string was counted at 34 occurrences

**Claimed:** `docs/release-posture.md` §13a — "the 34 occurrences of the string are
`FILE_FLAG_BACKUP_SEMANTICS` in `vela-projects/src/link.rs`, a `.pre-cleanup-` rename in
`vela-privatefs/src/lib.rs`, test fixtures, and a mock server named `backup` in a provider
example."

**True:** the substantive claim — no backups directory, no backup path constant, no backup routine
— holds. The count does not: there are **21** occurrences on **18** lines in **six** files. No
widening produces 34 either: including the untracked build artefacts under `src-tauri/target` gave
43, and `git grep -oih backup 52e6f37 -- | wc -l` over the whole tracked repository gave **97** at
commit `52e6f37`, the tree this entry was measured against. (That last figure is a moving one and
is dated for that reason — every entry in this file that discusses the word adds occurrences of
it.) The enumeration also named neither
`vela-settings/src/service.rs` (2, doc-comment prose about database backups) nor
`vela-store/src/location.rs` (1, the `.pre-cleanup-` rename from the other side).

**How it was caught:** counting occurrences rather than trusting the sentence — `find src-tauri
-name target -prune -o -name '*.rs' -type f -print`, piped through `grep -oih backup | wc -l`,
gives 21; `git grep -ci backup -- 'src-tauri/*'` gives six files summing to 18 lines, whose
per-file **occurrence** counts are 1 / 3 / 2 / 12 / 2 / 1.

**Consequence:** §13a now carries the per-file table rather than a total plus a partial list, so
the number and the enumeration cannot drift apart again.

### 4. "cannot be gated" was justified by naming only the CI job that could not have threatened it

**Claimed:** the `NSIS_SIGNATURE_AT` comment in `src/platform/bundle-guard.test.ts` — that the
constant equalling the real setup's offset is not gated "and cannot be: `pnpm test` runs on
`ubuntu-latest`, where there is no `target/release/bundle` to measure".

**True as far as it goes, and incomplete.** `pnpm test` runs in **two** jobs in
`.github/workflows/ci.yml`: `test-ts` on `ubuntu-latest` and `test-windows` on `windows-latest`.
The sentence named only the job on the platform where a Windows installer could not exist in the
first place, and omitted the one job on the platform where it could.

**How it was caught:** the round-3 critic, reading the workflow rather than the comment.

**The argument survives, and now says why.** `test-windows` never bundles — its build steps are
`pnpm build`, `cargo build --workspace --locked` and `cargo test --workspace --locked`, none of
which write `target/release/bundle`. The only job that runs `pnpm bundle` is `bundle`, which is a
separate job on its own runner and does not run `pnpm test`. The comment now names both jobs and
gives that reason.

### 5. 4535 ms, "90.7% of its own budget on a quiet machine"

**Claimed:** `docs/release-posture.md` §13b — that in an isolated, otherwise idle run, `resizes by
keyboard through the separator` took **4535 ms** against Vitest's 5000 ms default, and that "a test
whose measured cost on a quiet machine is 90.7% of its own budget ... is a coin toss that any
concurrent load decides."

**True:** the 5000 ms default is right — `vite.config.ts` sets no `testTimeout`. The 4535 ms is not
reproducible. Three independent attempts, three whole-file runs each:

```
round-3 critic    946 /  947 /  917 ms
the measurer     1496 /  948 / 1071 ms
round 4           956 /  926 /  941 ms
```

Nine observations, none of them near 4535 ms and none of them past a third of the budget. That is a
description of nine measurements and not a bound on the tenth — but the inference the paragraph was
built on runs the other way regardless. The test is not near its ceiling on a quiet box; the ceiling was eaten by
everything else running when the full suite went red.

**How it was caught:** running the file three times and reading the per-test duration the basic
reporter prints, rather than repeating the recorded figure.

**Consequence:** the number is replaced with the three costs actually measured this round and the
percentages they give, the "coin toss" conclusion is withdrawn, and the recommendation to the two
files' owner — an explicit per-test timeout with a stated reason — is re-based on load, which is
what the failing runs' own `Duration 156.73s` against `environment 811.58s` already said. This
entry does not claim 4535 ms was never observed; it claims the sentence generalising it to a quiet
machine does not reproduce, across three sets of attempts including the round-3 critic's.

### 6. "This machine runs seventeen agents and a Rust workspace build at the same time"

**Claimed:** the `SPAWN_TIMEOUT_MS` docblock, verbatim in `src/platform/bundle-guard.test.ts`,
`bundle-runner.test.ts`, `rust-tail.test.ts` and `verify-runner.test.ts`.

**Not false, and not checkable.** The measurer listed it under what it could not check: nothing
inside one session can count the other sessions on the box. It reads as a measurement and it is
not one.

**Consequence:** all four copies now justify the 60-second ceiling with something a reader can
verify — the `Test timed out in 5000ms` failures this branch's own runs hit, in files it does not
touch, each of those files green when run alone three times out of three, recorded in
`docs/release-posture.md` §13b. They carry no count, deliberately: the list grew during this very
round, from two failures in two files to four in three, and §13b is where the current tally lives.
Same conclusion, evidence that can be checked.

### 7. Two numbers the measurer recorded as borderline rather than raising

It listed both "so the panel can overrule me". The panel does not have to: both are numbers, both
are checkable, and both were wrong enough to fix.

**a. "carries a 50-line rationale about rustfmt output moving between releases"** — the round-2
entry in this file about `src-tauri/rust-toolchain.toml`. Measured: the file is 58 lines, 53 of
them comment. "50-line" is a round number for neither. It now states both counts.

**b. "`pnpm verify` reaches these two gates through eight `&&` links"** — the comment headed
`A GREEN cargo test IS NOT EVIDENCE`, both copies of it, in `.github/workflows/ci.yml`. Two things
are wrong with it. The count: the `verify` string at tag `run-start-2026-08-17` carries **ten**
`&&` operators, **nine** of them ahead of `cargo build --workspace --locked`. Eight is right only
under a reading of "link" that this track's own `scripts/check-rust-tail.mjs` contradicts, since
its header called the same thing "a ten-link `&&` chain" — so the file set was not self-consistent
about what a link is, which is how a number nobody can check stays wrong. And the tense:
`package.json`'s `verify` is no longer a shell chain at all — this track replaced it with `node
scripts/verify.mjs` in round 1 — so a present-tense sentence about its `&&` links describes
something the tree does not contain. Fixed in all three places: both `ci.yml` copies and the
`check-rust-tail.mjs` header now say ten operators and nine ahead of `cargo build`, in the past
tense, and each says what replaced the chain and why the replacement still does not make the
disk-reading step redundant. (The measurer attributed the phrase "a ten-link `&&` chain" to
`scripts/verify.mjs`. It was in `scripts/check-rust-tail.mjs`'s header, until this entry's own fix
rewrote that header; no file under `scripts/` carries it now.)

---

## 2026-08-21 (round 3) — a correction measured four bytes off, and a comment whose mutation was never run

Both entries below were found by the round-2 critic, by measuring the bytes and by mutating the
tree. Both are claims written by round 2 *while correcting round 1*.

### 1. The NSIS signature offset was stated four bytes past where the guard finds it

**Claimed:** round 2, entry 2 of this file, and the same sentence in `scripts/check-bundle.mjs`
step 3b, `docs/release-posture.md`, and three times in `src/platform/bundle-guard.test.ts` — that
`EF BE AD DE` + `NullsoftInst` is "present once at offset 52,744" in the real 5,444,437-byte
setup. `src/platform/bundle-guard.test.ts` also set `const NSIS_SIGNATURE_AT = 52_744` as the
offset its fixture writes the sequence at, under a comment saying this was "the real one so that
the fixture and the artefact it stands for are the same shape", and
`src/platform/bundle-runner.test.ts` carried the same constant.

**True:** the sixteen-byte sequence begins at **52,740**. 52,744 is where the ASCII `NullsoftInst`
begins, four bytes into it. Re-measured on this tree with the guard's own method — `body.indexOf`
over the whole file — at the commit this entry ships in:

```
nsis bytes          = 5444437
SIG(16) offsets     = [52740]          <- efbeadde4e756c6c736f6674496e7374
"NullsoftInst" offs = [52744]
EF BE AD DE count   = 2 first = 9732
bytes 52736..52760  = 00000000 efbeadde 4e756c6c736f6674496e7374 06200100
SIG(16) in vela.exe = -1
"Nullsoft" in exe   = -1
```

So the guard's own `findBytes` contradicted the guard's own header by four, and the fixture and
the artefact were **not** the same shape — they differed by exactly those four bytes, which is the
one thing that comment claimed they did not.

**How it was caught:** the critic ran the guard's method against the artefact instead of reading
the sentence.

**Consequence:** 52,740 wherever the subject is the sixteen-byte sequence. Grepping the tree for
the number found **seven sites in five files** — `scripts/check-bundle.mjs`, `docs/corrections.md`,
`docs/release-posture.md`, three in `src/platform/bundle-guard.test.ts` and one in
`src/platform/bundle-runner.test.ts`. The critic named four files; the fifth,
`bundle-runner.test.ts`'s copy of the constant, came out of the grep. Each site now also says why
neither half of the sequence would do: `NullsoftInst` alone starts at 52,744, and `EF BE AD DE`
alone occurs twice, first at 9,732. The two fixture constants are now 52,740, which is what makes
the "same shape" claim true.

**What is now gated, and what is still only written down.** `src/platform/bundle-guard.test.ts`
gains `the --json row says WHERE the NSIS signature was found`: it writes the sequence into a
synthetic setup at `NSIS_SIGNATURE_AT`, runs the guard with `--json`, and asserts the row's
`signatureAt` equals that constant — which also gives that field, an unread write this branch was
failed for, its reader. Measured twice: replacing the `indexOf` in the guard's `findBytes` with
`includes(...) ? 0 : -1` reds that test and nothing else across the five release-path files,
`1 failed | 86 passed (87)`, `expected +0 to be 52740`. What that does **not** gate is the equality
of the constant to the real artefact's offset: `pnpm test` runs on `ubuntu-latest`, where there is
no `target/release/bundle`, and a test that asserts only when an artefact happens to be present is
the vacuous pass step 7 of the guard's own header refuses. That equality is a hand measurement —
the block above — and nothing more.

### 2. "A sentinel taken after the build ... passes this tree" was never run

**Claimed:** `src/platform/bundle-runner.test.ts`, in the STALE test — "A sentinel taken after the
build, or none at all, passes this tree."

**True:** only "none at all" passes it. Measured by mutating `scripts/bundle.mjs` and running that
file twice per mutation:

| mutation | this file's verdict |
|---|---|
| delete `'--since', String(sentinelMs)` from the check's argv | STALE test **red**, `1 failed \| 5 passed (6)`, twice |
| move `const sentinelMs = Date.now()` to after the spawn | STALE test **green**; the two good-bundler tests red instead, `2 failed \| 4 passed (6)`, twice |

The backdated artefacts are two days old, so they are stale against a sentinel taken after the
build as well as before it. What a post-build sentinel actually breaks is the opposite case: it is
later than the mtimes the bundler just wrote, so *fresh* installers are called STALE and the
load-bearing "the bundler FAILS and the check still runs" test plus its control go red. A
post-build sentinel is a false-**red** machine, not a false-green one.

**How it was caught:** the critic performed the mutation the comment described.

**Consequence:** the clause is withdrawn. The comment now states both mutations and which tests
each one reds, with the counts above, and says plainly that this test holds down the missing
`--since` and not the misplaced sentinel.

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

> **The offset in the paragraph above is wrong and is corrected in round 3, entry 1.** The
> sixteen-byte sequence begins at **52,740**; 52,744 is where `NullsoftInst` alone begins. The
> paragraph is left standing because this file is append-only, and this note is here so that no
> reader carries the wrong number away from it.

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
| add `rust-toolchain.toml` | `src-tauri/rust-toolchain.toml` exists, pins `channel = "1.97.1"` with `rustfmt` and `clippy`, and carries a rationale about rustfmt output moving between releases -- 53 comment lines in a 58-line file |
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
