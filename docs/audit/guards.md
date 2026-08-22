# Audit — guards, contracts and the verification apparatus

Repo `C:\Users\User\vela-tmp`, branch `claude/new-session-tgl1ut`, HEAD `a1fa55e`.
Host: Windows 11, `core.autocrlf=true` (global), pnpm 10 / node 22, vitest 3.2.7.

Everything below was run on this machine. Where I mutated a tracked file I say so,
give the mutation, and record the revert. Ten other auditors were working in the same
worktree; the two entries that show up in `git status` next to my own runs
(`vela-endpoint/src/policy.rs`, `vela-providers/src/redact.rs`, `vela-sandbox/src/wsl.rs`,
`src/ipc/project.rs`, `MessageTurn.tsx`, …) are theirs, not mine. My own files were
confirmed clean at the end:

```
$ git --no-pager diff --stat -- src/platform/chat-contract-parity.test.ts \
    src/platform/contract.ts src/platform/contract-sandbox.ts \
    .github/workflows/ci.yml src-tauri/crates/vela-providers/tests/fixtures/
(empty)
```

---

## 0. Baseline

```
$ pnpm exec vitest run src/platform/claimed-guards.test.ts \
    src/platform/chat-contract-parity.test.ts src/platform/no-provider-leak.test.ts \
    src/platform/verify-covers-ci.test.ts src/platform/contract.test.ts

 ✓ src/platform/contract.test.ts (5 tests) 11ms
 ✓ src/platform/chat-contract-parity.test.ts (33 tests) 25ms
 ✓ src/platform/verify-covers-ci.test.ts (13 tests) 10ms
 ✓ src/platform/no-provider-leak.test.ts (18 tests) 252ms
 ✓ src/platform/claimed-guards.test.ts (9 tests) 27ms

 Test Files  5 passed (5)   Tests  78 passed (78)
```

Green on Windows, which is itself the finding of the previous session (these files
were never executing here). `vite.config.ts` sets `include: ['src/**/*.test.{ts,tsx}']`,
so all five are inside `pnpm test`, which the new `test-windows` CI job runs.

---

## 1. `claimed-guards.test.ts` — does it bite on real tree content?

The file's own controls (`this guard is not vacuous`) run the resolver over a
fabricated in-memory corpus. That proves `resolves()` rejects invented names; it does
**not** prove the scan reaches files on disk. So I planted claims in the tree.

Two **untracked** probe files (no tracked file touched):

`src-tauri/src/zz_audit_probe_delete_me.rs` — not referenced by any `mod`, so nothing
compiles it:

```rust
//! [`a_guard_this_audit_invented`] holds this invariant.
//! See `src/platform/definitely-not-here.test.ts` for the rest, and
//! `every_variant_is_listed_in_all` which is real, plus
//! `no_such_parity_guard_exists` which is not.
```

`src/platform/zz-audit-probe-delete-me.md`:

```markdown
Held by `a_second_invented_guard` and by `tests/no-such-thing.test.ts`.
```

Result:

```
 ❯ src/platform/claimed-guards.test.ts (9 tests | 3 failed)
   × names only Rust items that exist
     + "src-tauri/src/zz_audit_probe_delete_me.rs:3 names `a_guard_this_audit_invented`, which does not exist"
   × names only files that exist
     + "src/platform/zz-audit-probe-delete-me.md:3 names `tests/no-such-thing.test.ts`, which does not exist"
     + "src-tauri/src/zz_audit_probe_delete_me.rs:4 names `src/platform/definitely-not-here.test.ts`, which does not exist"
   × names only tests that exist   (3 entries)
   ✓ all six vacuity controls still pass
```

All three shapes fire, from both a `.rs` and a `.md` file, and the real name
`every_variant_is_listed_in_all` correctly did **not** appear. Probes deleted.

### 1a. Did the retreat from `codeVocabulary` lose coverage?

The header records that the six-language scanner was deleted in favour of nine named
facts in `FOREIGN_NAMES` plus a widened `rustItems()` (it now reads `let` bindings and
`fn` parameters). Deleting a *resolution route* can only make more claims unresolved,
so it cannot lose detection. The risk is the other half — that widening `rustItems()`
and `wireTokensAndMethods()` swallows plausible fabricated names.

Measured with a battery of fifteen plausible-but-fake guard names in one untracked
`.md`:

```
reported as nonexistent (12):
  no_secret_reaches_the_renderer  every_command_is_registered  is_allowed
  read_to_string  from_str  payload_is_named  parse_line  chunk_size
  run_once  the_guard_bites  allowlist_parity  mount_is_a_junction
resolved (3):
  to_owned          — real method, `.to_owned(` corpus
  handler_binding   — real file, src-tauri/tests/handler_binding.rs
  contract_version  — real item
```

Twelve of fifteen caught, and the three that resolved are genuinely real things. Note
in particular that `read_to_string` and `from_str` are *reported*: the method corpus
regex is `/\.([a-z]…)\s*\(/`, which requires a leading dot, so `std::fs::read_to_string(`
does not vouch for anything. The corpus is narrower than the header's caution implies.
No coverage was lost by the retreat.

### 1b. Scope gap

`SCANNED_EXTENSIONS` is `rs ts tsx css md sh mjs js yml toml`. Files tracked under the
claim roots whose extension is **not** in that list:

```
5 .sql   5 .json   1 .py   1 .ps1   1 .html
```

The header says the scope includes "the scripts", and `scripts/gate-m-debug-log-acl.ps1`
is a script that is never scanned. It carries thirteen backticked tokens, three of
which are path claims and two of which are sentence-shaped names:

```
`src-tauri/src/ipc/diagnostics.rs`  `vela-providers/src/private_fs.rs`
`gate_m_debug_log_acl.rs`  `create_dir_all`  `debug_log_set`
```

I checked each by hand: all resolve today (`private_fs.rs` exists,
`fn debug_log_set` is at `src-tauri/src/ipc/diagnostics.rs:184`, `create_dir_all` is in
`FOREIGN_NAMES`). So this is a gap, not a live false claim. Adding `.ps1` to
`SCANNED_EXTENSIONS` costs nothing today and closes it.

---

## 2. `chat-contract-parity.test.ts`

Two mutations of the tracked file, applied together, run, reverted.

**(a) the CRLF repair.** `source.slice(at).split(/\r?\n/)` → `.split('\n')`, i.e. the
pre-fix code:

```
 ❯ src/platform/chat-contract-parity.test.ts (33 tests | 30 failed)
   × MessageRole carries every MessageRole variant … → chat-contract-parity: unterminated MessageRole in model.rs
   × StopReason …                                   → unterminated StopReason in model.rs
   … 30 of 33
```

That is the historical defect reproduced exactly — the CI comment says "28 of its 31
cases threw"; with the two line-ending controls added it is now 30 of 33. The fix is
load-bearing on this platform and the guard cannot silently regress into it.

**(b) the TypeScript direction.** `'reasoning'` removed from `CONTENT_PART`:

```
$ pnpm exec tsc --build --force
src/platform/chat-contract-parity.test.ts(105,3): error TS2322: Type '"text"' is not assignable to type '"this list is missing a variant"'.
src/platform/chat-contract-parity.test.ts(106,3): error TS2322: Type '"image"' is not assignable to type '"reasoning"'.
```

`everyVariantOf` does what the header claims — the error names the missing variant.
Both halves of "there is no order in which a one-sided change is green" are real.

Reverted with `git checkout --`; lines 104–107 and 381 confirmed restored.

Stale comment, no defect: lines 372–375 still say "there is no `.gitattributes`". There
is one now. It does not cover `.rs`, so the substance (Rust source is CRLF here —
`src-tauri/src/ipc/mod.rs` measures CR=411) is still true.

---

## 3. `no-provider-leak.test.ts`

Planted one untracked file, `src/styles/zz-audit-leak.css`:

```css
:root { --vela-ollama-accent: #f00; }
```

```
 ❯ src/platform/no-provider-leak.test.ts (18 tests | 2 failed)
   × never appears in shipping renderer source
   × no design token is named after a backend
   ✓ the other 16, including both self-tests
```

Two independent tests fire. Deleted.

The Windows repair here (`basename(path)` instead of `path.split('/')`) is proved by
the baseline pass rather than by a mutation: the file asserts its exemption in both
directions —

```ts
expect(carriers.map(p => basename(p)).sort()).toEqual([...CARRIERS].sort());
expect(carriers.flatMap(inspections).length).toBeGreaterThan(0);
```

If `CARRIERS` matched nothing (the pre-fix state) `carriers` would be `[]` and the
first of those fails. It passed here. That is the strongest possible evidence for that
particular repair short of reverting it.

---

## 4. `verify-covers-ci.test.ts`, and the new Windows job

Three mutation rounds on `.github/workflows/ci.yml`, each reverted.

**Round 1 — a multi-line `run: |` block added to `test-windows`:**

```yaml
      - name: Audit probe multiline
        run: |
          sudo apt-get install -y nothing
          pnpm brand-new-gate
```

```
   ✓ every gate command in the workflow is accounted for above       <-- DID NOT FIRE
   × every job that runs cargo can actually build the dependency graph
     → CI job "test-windows" runs on windows-latest and installs Linux packages.
```

Two results in one run. The new per-runner branch **bites**. The accounting test
**does not**: `runLines` is built from `/^[ \t]*-?[ \t]*run: (.+)$/gm`, which matches
the `run: |` line, whose captured text is `|` and is then filtered out. The body lines
of a block are never inspected. So a brand-new gate written inside a `run: |` block is
invisible to the test whose whole job is to notice new gates — and the workflow
already uses that form for its apt steps, which is why the `!line.startsWith('sudo
apt-get')` exemption on line 96 is dead code. This is a false-negative in the newest
guard in the file.

**Round 2 — the same gate in single-line form:**

```yaml
      - run: pnpm brand-new-gate
```

```
   × every gate command in the workflow is accounted for above
     → expected [ 'pnpm brand-new-gate' ] to deeply equal []
```

So the accounting test is real for the form it can see. The hole is specifically the
block form.

**Round 3 — `runs-on: windows-latest` → `runs-on: freebsd-14`:**

```
   × every job that runs cargo can actually build the dependency graph
     → CI job "test-windows" runs cargo on "freebsd-14", which this guard cannot reason
       about. Teach it what that runner provides before trusting a green run from it.
```

And with `libwebkit2gtk-4.1-dev` deleted from the apt lists, the Linux branch fires on
`static` with the "never installs the Tauri system dependencies" message. All three
branches of the new three-way runner check are live.

**The job itself.** `test-windows` runs `pnpm typecheck`, `pnpm test`,
`cargo build --workspace --locked`, `cargo test --workspace --locked`, and
`check-transcripts.sh` under `shell: bash`. Cross-checking against the six Windows-only
defects its own comment lists: parity + provider-leak are covered by `pnpm test`;
`handler_binding`, `gate_m_assembled_app`, the `#[cfg(windows)]` halves and the four
`*_fixture_replay` controls are covered by `cargo test`. All six are actually covered.
It does not run `pnpm test:harness`, `pnpm build`, clippy or fmt, and does not claim to.
`needs: static` gives it the draft guard transitively. Separate `prefix-key: windows`
on the rust-cache is correct — a shared key would let a Linux build answer for it.

---

## 5. `pnpm verify` cannot run on the platform Vela ships on

`verify-covers-ci.test.ts` exists so that a green `pnpm verify` means a green CI. It
compares strings; it never executes either side. On Windows the local half does not
execute at all.

```
PS> pnpm run test:transcripts
> ./scripts/check-transcripts.sh
node.exe : '.' is not recognized as an internal or external command,

PS> pnpm run test:secrets
> ./scripts/secret-scan.test.sh && ./scripts/secret-scan.sh
node.exe : '.' is not recognized as an internal or external command,
 ELIFECYCLE  Command failed with exit code 1.
```

pnpm runs lifecycle scripts through `cmd.exe` on Windows and there is no `.npmrc`
`script-shell` setting (`.npmrc` holds only `strict-peer-dependencies` and
`auto-install-peers`). The `verify` chain is

```
typecheck && lint:rust && test && test:harness && build && test:transcripts && test:secrets && cd src-tauri && cargo build && cargo test
```

so it dies at step 6 of 9 and the two `cargo` gates never run either. The CI author
knew bash was needed — `test-windows` sets `shell: bash` explicitly for
`check-transcripts.sh` — but `package.json` carries no equivalent. The fix is one line
(`script-shell` in `.npmrc`, or invoke via `bash ./scripts/…`).

This is the same defect class the whole apparatus is aimed at: a gate everyone
believes is runnable, which on the machine that builds the product is not.

---

## 6. `contract.test.ts` — the "runtime exhaustiveness" claim is false

`src/platform/contract.ts:1692-1697`:

> Compile-time proof that the allowlist contains only real commands. The reverse
> direction (every command is listed) is asserted at runtime in `contract.test.ts` …

`contract.test.ts:12-14`:

> Runtime exhaustiveness: a key added to IpcContract but forgotten in the allowlist
> would be unreachable from the renderer.

What the test actually does is compare `COMMAND_ALLOWLIST` against a **hand-written**
array typed `(keyof IpcContract)[]`. That type requires every element to *be* a key; it
does not require the list to *cover* the keys. Nothing derives from `IpcContract`.

Measured. Added one key to `IpcContract` in `contract.ts` and to nothing else:

```ts
  zz_audit_probe: { req: EmptyPayload; res: Ack };
```

```
$ pnpm exec vitest run src/platform/
 Test Files  24 passed (24)      Tests  1187 passed (1187)
```

All 1187 platform tests, including `contract.test.ts` and the 80-case
`adapter-parity.test.ts`, pass with a phantom command in the contract.

The invariant is not actually unheld — `pnpm typecheck` catches it:

```
$ pnpm exec tsc --build --force
src/platform/browser-adapter.ts(909,15): error TS2322: Type '"zz_audit_probe"' is not assignable to type 'never'.
```

`browser-adapter.ts` has an exhaustive switch that bottoms out in `never`. So the
guarantee holds; the *attribution* is wrong, in two comments, and it points readers at
a runtime test that does nothing of the kind. That is documentation-shaped
false enforcement, and `claimed-guards.test.ts` cannot catch it because the claim is
prose rather than a backticked name. Reverted.

Four-way cross-check of the lists as they stand (no mutation):

```
rust 55  ts 55  IpcContract 55  contract.test 55
rust == ts            : true
ts   == IpcContract   : true
ts   == contractKeys  : true
```

---

## 7. IPC allowlist parity, `handler_binding`, `gate_m_assembled_app`

`ipc::tests::rust_and_typescript_allowlists_are_identical` reads `contract.ts` at
runtime (`std::fs::read_to_string`, not `include_str!`), so I could bite it using the
already-built test binary without taking the cargo build lock.

```
$ src-tauri/target/debug/deps/vela_lib-ddc97cccb9237147.exe ipc::tests
test ipc::tests::rust_and_typescript_allowlists_are_identical ... ok      (4 passed)

# then: contract.ts 'ui_set_layout' -> 'ui_set_layout_MUTANT'
thread 'ipc::tests::rust_and_typescript_allowlists_are_identical' panicked at src\ipc\mod.rs:206:9:
assertion `left == right` failed: the Rust COMMAND_ALLOWLIST and src/platform/contract.ts
have drifted apart …
  right: { …, "ui_get_layout", "ui_set_layout_MUTANT" }
test result: FAILED. 3 passed; 1 failed
```

Reverted; `grep -c ui_set_layout_MUTANT` → 0.

The two integration tests that died at process load on Windows for the whole life of
the project now run here. Executed the prebuilt binaries directly:

```
$ handler_binding-5dbaf59687dd08ff.exe --test-threads=1
test every_allowlisted_command_is_reachable_in_the_assembled_app ... ok
test every_command_takes_exactly_one_argument_and_it_is_named_payload ... ok
test no_command_is_reachable_that_the_allowlist_does_not_declare ... ok
test the_probe_can_tell_a_registered_command_from_an_unregistered_one ... ok
… test result: ok. 10 passed; 0 failed

$ gate_m_assembled_app-1831faed0c032135.exe
test a_command_outside_the_allowlist_is_not_dispatchable ... ok
test a_remote_origin_cannot_reach_a_command ... ok
test a_turn_sent_through_the_real_chat_command_reaches_the_configured_endpoint ... ok
… test result: ok. 15 passed; 0 failed; 1 ignored
```

No `STATUS_ENTRYPOINT_NOT_FOUND`. `build.rs`'s `rustc-link-arg-tests` fix is real, and
`the_probe_can_tell_a_registered_command_from_an_unregistered_one` — the in-file
anti-vacuity control that makes the other nine mean something — passes.

---

## 8. `scripts/secret-scan.sh`

Ran its own suite. It builds throwaway git repositories in `mktemp -d`, plants real key
shapes, and asserts the verdict — nothing in this worktree is touched.

```
$ ./scripts/secret-scan.test.sh
# the finding this file exists for: docs/ is scanned
ok   a key in a committed mock transcript is caught
ok   a key in ordinary docs prose is caught
ok   a key in a docs JSON fixture is caught
ok   a private key committed under docs/ is caught
# the shapes it already covered, still covered
ok   a key in source is caught
ok   a key in a Rust test is caught
ok   a tracked .env file is caught even when empty
# no false positives, or the tripwire gets muted
ok   prose that merely contains 'sk-' is not a credential
ok   a placeholder that is not key-shaped is left alone
ok   an empty repository is clean
# the scanner and this test are themselves in scope
ok   scan_scans_itself_and_stays_clean: the real tree passes with no exclusions
ok   exclusions_are_exact_paths_never_globs: the exclusion list is empty
12 passed, 0 failed
```

This is the best-evidenced guard in the domain: every claim it makes is demonstrated
against a real filesystem, including the negative cases. `excluded_paths=()` is empty
and the glob check is enforced by the suite. It runs in CI (`secret-tripwire`), and
would run in `pnpm verify` — except on Windows, per §5.

---

## 9. `.gitattributes` and `check-transcripts.sh`

### 9a. The attribute works

On-disk byte counts in this worktree:

```
anthropic/01-thinking-tool-use.sse          bytes=2420   CR=0   LF=54
google/01-thinking-function-call.sse        bytes=1785   CR=0   LF=14
mock-matrix/frontier/05-plain.sse           bytes=4878   CR=0   LF=50
local-smoke/10-vela-bridge-normal.jsonl     bytes=32181  CR=0   LF=273
mock-matrix/frontier/01-chat-plain-nonstreaming.txt  bytes=2981  CR=7  LF=71
mock-matrix/frontier/01-health.json         bytes=150    CR=8   LF=8
src/platform/contract.ts                    bytes=65058  CR=1703 LF=1703
src-tauri/src/ipc/mod.rs                    …            CR=411
```

`git check-attr text` reports `unset` for the `.sse` paths and `unspecified` for the
`.txt`/`.json` ones. Source is CRLF, captures are LF: the attribute is in force.

Confirmed causally in a throwaway repo (`core.autocrlf=true`, blob written LF):

```
no .gitattributes, fresh checkout:  cap.sse CR=6   note.txt CR=2
with '*.sse -text', fresh checkout: cap.sse CR=0   note.txt CR=2
```

### 9b. It is load-bearing, and something bites when it is lost

Mutation: CRLF-ified all seven `tests/fixtures/anthropic/*.sse` (they are read at
runtime with `std::fs::read_to_string`, so no recompile).

```
baseline: test result: ok. 15 passed; 0 failed
CRLF:
  control_a_sentinel_driven_consumer_delivers_nothing_from_that_same_body
    → Vela delivers every character the sentinel-driven consumer withheld: left 80, right 0
  control_d_a_frame_local_stripper_leaks_that_markup_to_the_user
    → control must fail: the frame-local stripper should leak markup, got ""
  control_e_keying_tool_slots_by_content_block_index_allocates_empty_calls
    → control must fail: index-keyed slots over-allocate on this body: left 1, right 3
  test result: FAILED. 12 passed; 3 failed
```

Reverted (`git checkout --`; CR back to 0 across all seven). So the Windows
`cargo test --workspace` job is a real detector for the attribute going away.

### 9c. But `ci.yml` names the wrong detector

`ci.yml:231-237` says of `check-transcripts.sh` on Windows:

> On a checkout that rewrote their line endings this reports a behaviour change nobody
> made, which is precisely the failure `.gitattributes` now prevents — so running it
> here is how we find out if that protection ever stops working.

`check-transcripts.sh` decides with `git diff --quiet -- docs/regression-baseline/mock-matrix`.
Measured, in the throwaway repo:

```
A) '*.sse -text' in force, fresh checkout            → CR=0,  git diff: CLEAN
B) '*.sse -text' in force, worktree forced to CRLF   → CR=6,  git diff: DIRTY   (reported)
C) attribute removed, re-checkout (CR=6), then the file
   regenerated as LF exactly as record-transcripts.ts writes it
                                                     → git diff: CLEAN  (NOT reported)
```

Case C is the scenario the sentence names — the protection stopping — and it is
invisible. With `core.autocrlf=true` and no `-text`, git normalises the working-tree
copy on read, so a CRLF checkout and an LF regeneration both hash to the LF blob.
`check-transcripts.sh` catches case B (a rewrite while the attribute holds) and nothing
else. The real detector for a lost attribute is §9b, in a different job.

### 9d. Coverage of the two patterns

`.gitattributes` covers `*.sse` and `*.jsonl` and its comment says that covers "the
recorded transcripts under `docs/regression-baseline/`". It does not: `mock-matrix`
also holds `.txt` and `.json` transcripts, measured above at CR=7 and CR=8, i.e. still
line-ending-translated. As §9c shows, git's own normalisation makes that harmless for
`git diff`, and nothing else reads those bytes byte-exactly. So no live defect, but the
sentence claims more than the two patterns deliver.

### 9e. What I did not do

I did not run `check-transcripts.sh`. It executes
`node tests/harness/mock-provider/src/record-transcripts.ts`, which **writes** into
`docs/regression-baseline/mock-matrix/`. In a worktree shared with ten other auditors
mid-edit, a non-deterministic regeneration would leave tracked files modified that are
not mine to revert. Its determinism claim is therefore UNVERIFIED by me.

---

## 10. The three frozen contracts

Traced the imports first — these are not test-only artifacts:

```
src/app/App.tsx:14                     import type { HarnessRuntime } from '@/platform/contract-harness'
src/app/App.tsx:15                     import { DEFAULT_PROJECT_ID } from '@/platform/contract-project'
src/platform/browser-adapter.ts:40,153 contract-sandbox, contract-project
src/data/sandbox-repository.ts:36      contract-sandbox
src/data/turn-driver.ts:29             contract-harness
src/features/canvas/document-run.ts:38 contract-sandbox
src/features/conversation/ConversationSurface.tsx:27  contract-harness
… 44 import sites in all
```

Mutation: renamed one field in `contract-sandbox.ts`.

```
$ pnpm exec tsc --build --force
src/features/canvas/document-host.ts(217,13): error TS2339: Property 'network' does not exist on type 'SandboxSubmitReq'.
src/features/canvas/document-host.ts(442,24): error TS2339: …
src/features/canvas/document-run.ts(92,5):   error TS2353: Object literal may only specify known properties …
src/features/canvas/document-run.ts(136,15): error TS2339: …
src/data/sandbox-repository.test.ts(49,5):   error TS2353: …
```

The errors land in **shipping** files, not only tests. The freeze is enforced by `tsc`
and the frozen shape is what the renderer is built out of. Reverted.

I did not re-derive the 58 behavioural rules; the brief records they were each watched
failing this session.

---

## 11. What I could not establish

- **`check-transcripts.sh` determinism.** Not run — see §9e.
- **CI as executed by GitHub.** Every CI finding here is from reading `ci.yml` and from
  running the same commands locally. I did not trigger a workflow run, so "the Windows
  job passes on a hosted runner" is untested; in particular `Swatinem/rust-cache@v2`
  with `prefix-key: windows` and `--locked` on a Windows dependency resolution are
  unexercised.
- **`gate_m_debug_log_acl.rs` / `scripts/gate-m-*.{sh,ps1}`.** Adjacent to the domain,
  not graded. The `.ps1` was inspected only for §1b.
- **Whether `handler_binding` / `gate_m_assembled_app` build cleanly right now.** I ran
  prebuilt binaries (timestamped 13:36 and 13:17 today) rather than `cargo test`,
  deliberately, because four Rust source files were modified by other auditors while I
  worked and the build lock was contended. The binaries prove the *manifest* fix and
  the tests' logic; they do not prove the current source compiles.
- **How much margin `claimed-guards`' vacuity floors have.** The thresholds
  (`SCANNED > 200`, doc-links `> 300`, paths `> 300`, named-tests `> 50`) pass, so the
  real counts exceed them, but I did not extract the actual numbers and cannot say
  whether a floor is one file away from being crossable.
- **Whether `pnpm verify` has *ever* completed on Windows.** §5 shows it cannot today.
  I did not go through history to find when that became true.
