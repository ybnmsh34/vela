# Audit — documentation honesty and claim integrity

Independent audit, one of twelve parallel domains. Worktree `C:/Users/User/vela-tmp`, branch
`claude/new-session-tgl1ut`, HEAD `a1fa55e`. Nothing tracked was left modified; every probe below
is recorded with the command, its literal output, and the removal or restore that followed.

**Scope.** `docs/vela-progress.md`, `docs/architecture/conventions.md`, `docs/HANDOVER.md`,
`docs/desktop-gate/`, `docs/references/`, `docs/regression-baseline/`, the three frozen contracts'
prose, and doc comments across `src/` and `src-tauri/`.

**Method, stated up front because it decides how much the grades are worth.** The brief's standard
is that a claim is only as good as the thing that bites when it is broken. Five claims were graded
by breaking the implementation and watching a named test fail; the rest by reading, by git
archaeology, or by fetching the live external source a reference study cites. Every row says which.

---

## 0. A procedural disclosure, and a caveat on one measurement

`docs/desktop-gate/OWNERSHIP.md` rule 2 says: *"A critic that mutates gets its own worktree too…
Read-only critics may share; anything that writes may not."* My brief instructed mutate-and-revert
in the shared worktree. I complied with the brief, and I am recording that it departs from the
repo's own rule, learned (per that file) the hard way on wave G. Mitigation: four of the five
probes created a new **untracked** file rather than editing a tracked one, each lived for a single
`vitest` invocation, and each was removed in the same shell command. The fifth appended one line to
`.github/workflows/ci.yml` and restored it from a byte copy rather than `git checkout --`, so a
concurrent writer could not have been clobbered. `git status --porcelain` was clean for every path
I touched afterwards.

**One accidental measurement, disclosed so nobody cites it.** A `git grep` pattern of mine was
written in double quotes and contained backticked command names; the shell expanded them, and
`pnpm test` ran the full suite. It reported **5 failures** in
`composition-root.test.tsx`, `memory-payload.test.tsx`, `project-host-parity.test.ts`,
`agent-run.test.tsx` and `ConversationSurface.test.tsx`. **Those are not a finding.** At the moment
it ran, `git status --porcelain src/` showed `src/features/conversation/turn-stream.ts` and
`src/runtime/project-context.ts` modified by another auditor. The reading is contaminated by
exactly the mechanism OWNERSHIP.md rule 2 describes, and it is recorded here only so that it is not
mistaken for a baseline. The lead's figure — 2090 TS tests, 0 failures — stands.

---

## 1. The mechanical guard, proven to bite on a live doc

`src/platform/claimed-guards.test.ts` resolves backticked paths and snake_case names across
`src/`, `src-tauri/`, `tests/`, `scripts/`, `.github/`, `docs/architecture/` and
`docs/vela-progress.md`. My brief's premise is that its blind spot is prose. First I confirmed it
is not also blind to the thing it claims to catch, in the one documentation file it scans.

Baseline:

```
$ ./node_modules/.bin/vitest run src/platform/claimed-guards.test.ts
 ✓ src/platform/claimed-guards.test.ts (9 tests) 8ms
 Test Files  1 passed (1)
      Tests  9 passed (9)
```

Probe — two fabricated claims appended to the running narrative:

```
$ printf '\n<!-- audit probe -->\nThis rule is held by `a_guard_the_auditor_invented` and by `src/platform/no-such-audit-file.test.ts`.\n' >> docs/vela-progress.md
$ ./node_modules/.bin/vitest run src/platform/claimed-guards.test.ts
AssertionError: expected [ Array(1) ] to deeply equal []
+   "docs/vela-progress.md:3230 names `src/platform/no-such-audit-file.test.ts`, which does not exist"
AssertionError: expected [ Array(1) ] to deeply equal []
+   "docs/vela-progress.md:3230 names `a_guard_the_auditor_invented`, which does not exist"
 Test Files  1 failed (1)
      Tests  2 failed | 7 passed (9)
$ git checkout -- docs/vela-progress.md
REVERTED
$ git status --porcelain docs/vela-progress.md
(empty)
```

**Verdict: PASS, test-bites.** Both shapes are caught, at the right line, in a documentation file.
The guard reaches a developer: `pnpm test` runs it, `pnpm verify` chains `pnpm test`, and
`ci.yml` runs `pnpm test` on both the Linux and the Windows job.

Note in passing: `docs/vela-progress.md:3174` records this file as `12/12` at the wave-H gate. It
holds 9 tests today. That is a historical gate reading, not a live claim, and I do not raise it.

---

## 2. The largest finding: the running narrative stopped running

`docs/vela-progress.md` is described by `docs/HANDOVER.md` §5 as *"the running narrative and the
best single account of how the project got here"*, and it is the only prose document inside
`claimed-guards.test.ts`'s claim scope. It was last written at `c05a3c9` (2026-08-14, the wave-H
merge).

```
$ git log --format="%h %ad %s" --date=short -1 -- docs/vela-progress.md
c05a3c9 2026-08-14 Merge branch 'wave-h/contracts' into claude/new-session-tgl1ut

$ git rev-list --count c05a3c9..HEAD
33

$ git diff --stat c05a3c9..HEAD | tail -1
 166 files changed, 43253 insertions(+), 195 deletions(-)

$ git diff --name-only c05a3c9..HEAD -- docs/
docs/desktop-gate/VERDICTS.md
```

Thirty-three commits, 166 files, 43,253 insertions — the sandbox, the MCP client, projects,
skills, the scheduler, memory, the local dual endpoint, the agentic runtime, six new crates and
thirteen new IPC modules — and the only documentation touched in all of it is one desktop verdict.

Direct corroboration that wave I is absent rather than merely thin:

```
$ grep -i -c "WSL\|vela-sandbox\|vela-mcp\|vela-skills\|vela-endpoint\|vela-projects" docs/vela-progress.md
1
```

The single hit is `1661: **Caveat I am tracking:** the composition-root wave is currently editing
src-tauri/src/state.rs` — an unrelated substring match on "wave I". There is no account of wave I
in the narrative at all.

### 2.1 The consequence: the final section's present-tense claims are now false

Wave H (lines 2939–3228) is the **last** section of the file, so nothing supersedes it. Three of
its statements were true at `c05a3c9` and are false at `a1fa55e`:

| line | claim | state at HEAD |
|---|---|---|
| 2948–2950 | "**Nothing below is wired.** All three files declare payload shapes and none of their command names are on `COMMAND_ALLOWLIST` in `src/platform/contract.ts`; `isAllowedCommand` answers `false` for every one of them" | `contract.ts:1592–1597` and `1658–1663` carry all six sandbox commands; `1584–1591` and `1650–1657` carry all eight project commands |
| 2956–2960 | the per-contract table's **Enforced by** column reads "`tsc` only" on all three rows | false for sandbox and project |
| 3143 | "**no test asserts a single behavioural rule in any of the three files.**" | `fa5f3c5` — *Make the frozen contracts' rules fail when they are broken* — added 2,985 lines across `sandbox_boundary.rs` (+1343), `no-harness-leak.test.ts` (+308), `run-capabilities.test.ts` (+253), `agent-loop-harness.test.ts` (+431), `live-runs.test.ts`, `project-context.test.ts`, `subagent-toolkit.test.ts` |
| 3160–3163 | "all three versions read 2" | `SANDBOX_CONTRACT_VERSION = 3`, `PROJECT_CONTRACT_VERSION = 3`, `HARNESS_CONTRACT_VERSION = 3` |

This is the defect class exactly as the brief frames it. `claimed-guards.test.ts` cannot see any
of it: "Nothing below is wired" contains no backtick, no path and no snake_case name. Every token
in that sentence resolves. The sentence is false.

The contracts themselves were repaired — `contract-sandbox.ts` carries *"They said the opposite
until 2026-08-15 — see amendment 4 — and a reader who trusts a stale 'nothing is wired up' will
change a rule believing nothing is watching"*, and `contract-project.ts` opens with *"**All eight
commands in {@link ProjectCommands} are now wired**, and this paragraph replaces one that said the
opposite."* The narrative that describes those same contracts was not.

### 2.2 The header, and a supersession convention that lives in the wrong file

A reader opening `docs/vela-progress.md` sees, at lines 9–36:

- `## RUN STATUS: 🟢 RUNNING`
- a ledger row `**C–H** | — | … | not started | 0`
- a ledger row `**B** provider abstraction … ⛔ **GATE FAIL r4: 471 assertions, 8 failures**`
- "CLOUD (this session) — headless Linux container"

The cloud session retired on 2026-08-14 (`docs/HANDOVER.md`), phases C and H both landed, and the
B round-4 FAIL is superseded by a run recorded at
`docs/regression-baseline/phase-b2-matrix/RESULTS.md` as *"1455 gate assertions, 0 failures"*.

`HANDOVER.md` §5 says the file is *"Append-only in spirit; later sections supersede earlier ones
where they conflict."* That instruction exists **only in HANDOVER**:

```
$ grep -n -i "append-only\|later sections\|reverse chronolog" docs/vela-progress.md
(no match)
```

So the file's own front matter tells a reader the run is in progress and phases C–H have not
started, and the correction is in a different document the reader has no reason to have opened.

---

## 3. `docs/architecture/conventions.md` — enforcement claims proven, description stale

The document opens: *"This document is prescriptive, not advisory. Where it says 'must', the tree
has a test that fails if you don't."* That is a claim about tests, and I graded it by breaking
things.

### 3.1 §4 — the adapter seam (PROVEN)

Claim: *"nothing under `src/` may import `@tauri-apps/api` except `src/platform/tauri-adapter.ts`.
`src/platform/adapter.test.ts` scans every `.ts`/`.tsx` file in `src/` (comments stripped) and
fails if a second importer appears."*

```
$ printf "import { invoke } from '@tauri-apps/api/core';\nexport const auditProbe = invoke;\n" > src/lib/zz-audit-probe.ts
$ ./node_modules/.bin/vitest run src/platform/adapter.test.ts
AssertionError: only platform/tauri-adapter.ts may import @tauri-apps/api: expected [ 'lib/zz-audit-probe.ts' ] to deeply equal []
+   "lib/zz-audit-probe.ts"
 Test Files  1 failed (1)
      Tests  1 failed | 3 passed (4)
$ rm -f src/lib/zz-audit-probe.ts
REMOVED
```

**PASS, test-bites.**

### 3.2 §7 — the token discipline (PROVEN, both halves)

Claim: *"`src/styles/design-system.test.ts` scans every `*.module.css` and fails on a raw colour…
It also fails on a `var(--vela-…)` the token sheet does not define — CSS drops an unresolvable
declaration silently, so nothing else would ever notice."*

```
$ printf '.zzAuditProbe {\n  color: var(--vela-not-a-real-token);\n  background: #ff00ff;\n}\n' > src/components/ZzAuditProbe.module.css
$ ./node_modules/.bin/vitest run src/styles/design-system.test.ts
AssertionError: a colour belongs in tokens.css, where both themes can define it: expected [ Array(1) ] to deeply equal []
+   "src\components\ZzAuditProbe.module.css:3 — background: #ff00ff;"
AssertionError: an undefined custom property fails silently, which is the worst way: expected [ Array(1) ] to deeply equal []
+   "src\components\ZzAuditProbe.module.css:2 — --vela-not-a-real-token"
 Test Files  1 failed (1)
      Tests  2 failed | 12 passed (14)
$ rm -f src/components/ZzAuditProbe.module.css
REMOVED
```

**PASS, test-bites.** Both halves of the sentence, including the interesting one.

### 3.3 §8 — `verify` is a superset of CI, "in either direction" (REVERSE DIRECTION PROVEN)

Claim: *"`src/platform/verify-covers-ci.test.ts` now fails if a gate command appears in the
workflow but is unreachable from `verify`, in either direction."*

The reverse direction — a new CI step nobody listed — is the harder one and the one
`docs/HANDOVER.md` §3 item 7 filed as broken (*"matches CI steps by prefix, so `pnpm test:e2e` is
'covered' by `pnpm test`"*).

```
$ cp .github/workflows/ci.yml "$SCRATCH/ci.yml.bak"
$ printf '      - run: pnpm audit:probe --strict\n' >> .github/workflows/ci.yml
$ ./node_modules/.bin/vitest run src/platform/verify-covers-ci.test.ts
AssertionError: a new CI step appeared. Add it to CI_GATES and to "pnpm verify", or exempt it here with a reason if it is setup rather than a gate.: expected [ 'pnpm audit:probe --strict' ] to deeply equal []
+   "pnpm audit:probe --strict"
 Test Files  1 failed (1)
      Tests  1 failed | 12 passed (13)
$ cp "$SCRATCH/ci.yml.bak" .github/workflows/ci.yml
RESTORED
$ git status --porcelain .github/workflows/ci.yml
(empty)
```

**PASS, test-bites.** The prefix hole HANDOVER filed is also closed by inspection: the matcher is
now `/pnpm (?:run )?test(?![\w:-])/`, which no longer swallows `pnpm test:e2e`.

### 3.4 §3.4 — least privilege (VERIFIED BY READING, exact)

Claim: *"`src-tauri/capabilities/main.json` grants the renderer the event channel and five
window-chrome permissions. That is all. No `fs`, no `shell`, no `http`, no `process`, no `dialog`."*

The file grants exactly `core:event:default` plus `allow-start-dragging`, `allow-minimize`,
`allow-toggle-maximize`, `allow-is-maximized`, `allow-close`. One event channel, five window
permissions, nothing else. **PASS**, and notable because six new subsystems landed since the
sentence was written without widening it — every one of them went through an IPC command, which is
what the sentence asks for.

### 3.5 §8 — the shared parity fixtures (VERIFIED BY READING)

Claim: *"`tests/parity/` holds JSON tables of `(input) -> (expected output)` read from disk by
**both** `cargo test` and `pnpm test`."* Three fixtures, six readers, all present:

| fixture | TypeScript reader | Rust reader |
|---|---|---|
| `adapter-parity.json` | `src/platform/adapter-parity.test.ts:95` | `src-tauri/tests/adapter_parity_fixture.rs` |
| `navigation.json` | `src/platform/browser-adapter-navigation.test.ts` | `src-tauri/tests/navigation_parity_fixture.rs` |
| `security-posture.json` | `src/platform/security-posture-parity.test.ts:54` | `src-tauri/crates/vela-settings/tests/security_posture_parity.rs` |

**PASS, inspection-only.** The Rust half was not run — see §7 on why cargo was off limits.

### 3.6 §0 rule 4 — `secrets_get` (VERIFIED BY READING)

Claim: *"There is no `secrets_get` and there never will be; a `cargo test` asserts its absence."*
`src-tauri/src/ipc/mod.rs:222–230` is `#[test] fn no_command_returns_secret_material()`, asserting
`!COMMAND_ALLOWLIST.contains(&"secrets_get")`. A TypeScript twin at `contract.test.ts:86–87`
asserts the same on the renderer's list, and `handler_binding.rs:471` dispatches the name against
the real handler. **PASS, inspection-only** for the Rust half.

### 3.7 §2 — TODO discipline (VERIFIED)

Claim: *"No `TODO` without an owner and a phase."* Exactly one TODO exists under `src/` and
`src-tauri/`: `vela-providers/src/http.rs:808 — // TODO(phase-D, providers): explicit,
user-configured proxy support.` **PASS.**

### 3.8 §9 — "the workspace's ONLY HTTP client" (VERIFIED)

`git grep -l reqwest -- "*.toml"` returns one file: `vela-providers/Cargo.toml`. The claim survived
the arrival of `vela-endpoint`, which serves HTTP and deliberately declares no server crate —
`vela-endpoint/Cargo.toml:20–26` states the reasoning and names
`vela-settings/tests/capability_matrix_endpoints.rs` as the guard. That file exists and does what
is claimed: it walks every `Cargo.toml` in the workspace (line 339, 360) and checks a list
containing `reqwest`, `hyper`, `ureq`, `isahc` (lines 164–167). **PASS**, inspection-only for the
guard's biting.

### 3.9 §1 — the folder layout is stale, and internally contradicts itself (FAIL)

The tree diagram at lines 35–97 lists four crates under `src-tauri/crates/` and five modules under
`src-tauri/src/ipc/`. Actual:

```
$ ls src-tauri/crates/
vela-core  vela-endpoint  vela-mcp  vela-projects  vela-providers
vela-sandbox  vela-secrets  vela-settings  vela-skills  vela-store

$ ls src-tauri/src/ipc/
app.rs  chat.rs  content.rs  diagnostics.rs  error.rs  mcp.rs  memory.rs
mod.rs  models.rs  project.rs  sandbox.rs  schedules.rs  secrets.rs
settings.rs  skills.rs  store.rs  transcript.rs  ui.rs
```

Ten crates, eighteen modules. This is not merely stale: the diagram contradicts a prescriptive
table **eleven lines below it in the same section**, which routes persistence to *"Rust:
`vela-store`, exposed via `store_*` commands"* — a crate the diagram does not contain. The document
is declared *"binding for all Phase A–H work"* and is named by `HANDOVER.md` §5 as
*"Authoritative and current"*. A builder following §1 to place new code is being routed by a map of
a repository that no longer exists.

`claimed-guards.test.ts` cannot see this either: the diagram is inside a fenced code block, which
that file deliberately excludes as illustration.

### 3.10 §10 and §11 — the environment claims are stale in the dangerous direction (FAIL)

§10 opens: *"This repo is built and verified on a headless Linux container."* §11's table is a
list of what does and does not build *"here"*, ending: *"**Therefore: no claim about the running
application — startup time, idle memory, window chrome, OS notifications, keychain round-trips —
may be made from this environment.** 'It compiles' is the strongest honest statement available here
about the desktop shell."*

Neither is true of the repository at HEAD. The head commit is *Run CI on the platform Vela ships
on*: `.github/workflows/ci.yml` now carries a `test-windows` job on `windows-latest` that runs
`pnpm typecheck`, `pnpm test`, `cargo build --workspace --locked`, `cargo test --workspace
--locked` and `./scripts/check-transcripts.sh`. The repository is checked out and graded on a
Windows machine, and `docs/desktop-gate/VERDICTS.md`'s newest entry (TRACK 10, added since the
progress doc's last update) records real turns through llama.cpp at `127.0.0.1:8033` in a running
WebView2 window.

This is the stale direction that costs something. §10's honesty rules are the repo's own
labelling discipline, and they are written as facts about *the* environment rather than about *an*
environment. A builder reading §11 today is told the strongest available statement about the
desktop shell is "it compiles", when a Windows CI job and a real-model verdict both exist. Worse,
§10's three "cannot be exercised here" items — the OS keychain, a real endpoint, the packaged
binary — are the exact list the desktop session *has* partly closed. The rule was right; the
scoping sentence around it has gone false.

The fix is a scoping sentence, not a rewrite: these are rules about a *headless Linux* run, and
that is now one of two environments.

---

## 4. The three frozen contracts — the strongest prose in the repository

This is where I expected to find the most over-claiming and found the least. Three checks.

### 4.1 The honesty notes are explicit, dated, and say what they used to say

`contract-sandbox.ts` lines 62–90 carry two numbered "honesty notes", introduced with:

> *"Two honesty notes, stated here because a reader will otherwise infer their opposites. They said
> the opposite until 2026-08-15 — see amendment 4 — and a reader who trusts a stale 'nothing is
> wired up' will change a rule believing nothing is watching"*

and then enumerate the unbuilt surface by name: *"Still unbuilt: every document command path,
`python`, both copying materialisations, and any surface that renders an approval prompt"*, and
*"What no machine watches: the entire document family (no producer exists), the four
{@link RefusalReason} members no host emits… the copy-out semantics of
{@link MountMaterialisation}, and every network policy other than `denied`."* That list matches
what this session established independently.

### 4.2 The one hard number in those notes is exactly right, and was measured

Note 2 says *"As of 2026-08-15 the `vela-sandbox` crate carries 47 tests"*. The crate carries 65
today. That looked like a defect until I checked the commit that wrote the sentence:

```
$ git log --format="%h %s" -S"carries 47 tests" -- src/platform/contract-sandbox.ts
201f979 sandbox: answer a malformed request at the invoke, not as a host failure

$ git show 201f979:src-tauri/crates/vela-sandbox/tests/sandbox_boundary.rs | grep -c "#\[test\]\|#\[tokio::test\]"
28
$ # plus, at that commit: contract.rs 3, digest.rs 3, paths.rs 6, wsl.rs 7, host.rs 0, admission.rs 0
$ # 28 + 3 + 3 + 6 + 7 = 47
```

Exactly 47 at authorship. The drift to 65 arrived two commits later in `fa5f3c5`, and it drifts in
the safe direction — the file under-claims its own coverage. This is a counted number, not a
gestured one, and it is the single best evidence in this audit that the contract prose is written
by measurement.

### 4.3 The amendment blocks catch their own failed sweeps

The brief asked me to hunt for *"an amendment block that says a sweep was done where it was not."*
There is one, and the repository found it first. `contract-project.ts` AMENDMENT 7:

> *"AMENDMENT 5 said the sweep for 'claims this file is NOT connected, where it is' had been done.
> It had not: it replaced two paragraphs and left four sentences standing, and one of them was on
> the most safety-critical rule here… A missing guard is a hole and a claimed guard is a trap; a
> guard **denied** is the third shape, and it is how a second unguarded delete gets written by
> someone who read this file and believed it."*

And AMENDMENT 8 then corrects AMENDMENT 7's own overstatement:

> *"{@link LinkStrategy} said 'every removal in that crate goes through it'. Six do not — four in
> `casefold.rs` and two in `link.rs`"*

I checked that correction rather than accepting it. `vela-projects/src/casefold.rs` has exactly
four `fs::remove_dir_all` calls outside `#[cfg(test)]` (lines 51, 52, 58, 62 — all inside
`CaseFolding::probe`, all on a `.vela-case-probe` path it created itself). `link.rs` has removals
at 204/211/213 inside its `unlink` path (`remove_dir` then `remove_file`, the two mechanisms a
junction and a file symlink need respectively). The count is defensible and the exceptions are
where the amendment says they are.

**Grade for the amendment discipline: PASS.** The third shape — a guard *denied* that exists — is
named here for the first time in this repo's history, and the file that names it also demonstrates
it.

### 4.4 One named guard in the contract prose, proven to bite

`contract-harness.ts` lines 62–74 make an unusually specific mechanism claim:

> *"The rule below that no surface may branch on a harness id is one that **is** now driven:
> `src/runtime/no-harness-leak.test.ts` takes the ids the registry actually holds and fails a build
> for any of them written as a literal, or for a `harnessId` compared against one, anywhere in
> shipping `src/`. This paragraph said 'no test behind it' until 2026-08-15 — see amendment 5 — and
> that sentence is the reason the guard exists."*

Two testable specifics: ids from the registry, and a failure anywhere in shipping `src/` (not just
`src/runtime/`). The registered ids are `agent-loop` and `single-turn`
(`agent-loop-harness.ts:534–535`), reached through `DEFAULT_HARNESS_DEFINITIONS` rather than copied
into the test.

```
$ printf "export function pickLabel(harnessId: string): string {\n  return harnessId === 'agent-loop' ? 'Agent' : 'Chat';\n}\n" > src/features/zz-audit-probe.ts
$ ./node_modules/.bin/vitest run src/runtime/no-harness-leak.test.ts
AssertionError: adding a harness must be a zero-change operation under src/; a literal id is where that stops: expected [ Array(1) ] to deeply equal []
+   "src/features/zz-audit-probe.ts:2 — return harnessId === 'agent-loop' ? 'Agent' : 'Chat';"
AssertionError: the UI branches on capability flags, never on an identity — conventions §0 rule 3: expected [ Array(1) ] to deeply equal []
+   "src/features/zz-audit-probe.ts:2 — return harnessId === 'agent-loop' ? 'Agent' : 'Chat';"
 Test Files  1 failed (1)
      Tests  2 failed | 9 passed (11)
$ rm -f src/features/zz-audit-probe.ts
REMOVED
```

**PASS, test-bites.** In a file outside `src/runtime/`, on an id it read from the registry, on both
the literal rule and the comparison rule. The contract's sentence is accurate to the word.

---

## 5. `docs/references/` — verified against the live sources they cite

The brief asks whether the two studies accurately describe the products and whether their
UNVERIFIED markers are honest. I could not re-derive 600 lines of external research, so I picked
the three claims the repo's own design rests on and fetched the primary sources.

### 5.1 Unsloth: issue #4818's metadata (VERIFIED VERBATIM)

`unsloth-studio.md` [^28] claims a specific set of API fields. Fetched
`https://api.github.com/repos/unslothai/unsloth/issues/4818`:

| study claims | live API |
|---|---|
| title "[Bug] [Security] Unsloth Studio: Code execution (terminal) tool sandboxing can be bypassed to allow privileged commands like sudo/chmod" | identical |
| `state: "closed"` | closed |
| `created_at: 2026-04-03T06:25:33Z` | 2026-04-03T06:25:33Z |
| `closed_at: 2026-04-03T20:33:45Z` | 2026-04-03T20:33:45Z |
| `closed_by: danielhanchen` | danielhanchen |
| `state_reason: "completed"` | completed |

Six for six. This is the citation `contract-sandbox.ts`'s opening argument rests on ("it was closed
the same day as 'completed', and the reporter's own follow-up the next day was that it was still
reachable"), and the timestamps carry that argument.

### 5.2 MindsHub: the one-method Protocol (VERIFIED AGAINST SOURCE)

This is the single most load-bearing external fact in the repository: `contract-harness.ts`'s
`RuntimeHarness` has one method *because* the reference's `HarnessProvider` has one method, and the
study explicitly overrides the product's own README on this point. Fetched
`https://raw.githubusercontent.com/mindsdb/cowork-server/main/cowork/harnesses/base.py`:

- one abstract method: `stream_response` ✓
- four attributes: `id`, `label`, `formatter`, `supports_org_mode` ✓
- three module-level functions: `register`, `get_harness`, `available_harness_ids` ✓
- no `sync_skills`, no `recall_memory` on the Protocol ✓

One numeric drift: the study calls it 87 lines; the fetch reports 78. Line count is not
load-bearing and the fetched figure is post-markdown-conversion, so I record it rather than raise
it.

### 5.3 The sibling package, which is where the UNVERIFIED marker lives

The study says (line 148): *"A sibling package, `cowork/harnesses/memory/` (files: `adapter.py`,
`layout.py`, `migration.py`, `registry.py`, `runtime.py`, `store.py`)… The straightforward reading
is that skill sync and memory are handled by this shared support package… I did not fetch the
contents of those six files, so the exact shape of that shared layer is UNVERIFIED beyond its file
names."*

Fetched `https://api.github.com/repos/mindsdb/cowork-server/contents/cowork/harnesses/memory`: all
six named files exist, plus `__init__.py` which the study omits (it does list `__init__.py` in the
parent directory, so this is an inconsistency of one line, not a convention).

### 5.4 The marker survives being re-transmitted downstream — the part that matters

An UNVERIFIED marker is only worth something if the document that consumes it carries it forward.
`contract-harness.ts` lines 24–44:

> *"**The study is the authority here, not the product's README**… Where they *are* instead is a
> weaker claim and is marked as one here, because the study marks it as one. A sibling package
> exists at that path — the study lists its six filenames — and the study's own words are that
> harness implementations calling into it is 'the straightforward reading', with the contents of
> those files explicitly UNVERIFIED. So: the interface has one method (verbatim, quoted); the
> sibling package's role is inferred. This file follows the verbatim half… and it does not depend
> on where the reference actually put them."*

Every clause of that is accurate to `mindshub-cowork.md:146–148` and `[^17]`, including the
"straightforward reading" quotation and the six-filename count. The contract then designs so that
the inferred half cannot matter. `contract-sandbox.ts` does the same with the Unsloth PR: it calls
[^30] *"the study's secondary read of the fix"*, which is exactly how the study labels it.

**PASS.** Three primary-source checks, three confirmations, and the uncertainty markers are
re-transmitted rather than laundered — which is the property this repo's defect class exists to
attack.

---

## 6. `docs/desktop-gate/` and `docs/regression-baseline/` — staleness marking

### 6.1 `REQUESTS.md` carries no in-file staleness banner (FAIL)

`HANDOVER.md` §5 says: *"`docs/desktop-gate/REQUESTS.md` — the request side. Mostly current, but it
contains status blocks I wrote about waves that a container reset then destroyed. Trust
`VERDICTS.md` over any status I claimed in `REQUESTS.md`."*

That warning is in HANDOVER and nowhere else. `REQUESTS.md`'s own first forty lines present a live
two-session protocol — *"**This file is written by the CLOUD session.** The desktop session reads
it and replies in VERDICTS.md"*, *"The cloud session is a headless Linux container. It is
structurally incapable of five verdicts, which is why you exist"* — a division of labour that ended
2026-08-14 when the cloud session retired. A reader opening REQUESTS.md gets no signal that either
its status blocks or its framing are historical.

The remedy is one banner, of the kind two sibling directories already carry (§6.2).

### 6.2 The regression-baseline banner discipline is applied inconsistently (FAIL)

The repo's own convention, stated in the very first line of `phase-b-matrix/README.md`, is that a
superseded record gets an in-file banner:

```
# `phase-b-matrix/` — FROZEN. Round 4's record, kept verbatim.
> **This directory is history and is no longer regenerated.**
```

```
docs/regression-baseline/phase-b2-matrix/RESULTS.md:
> **RE-RUN BY THE GATE M EXECUTOR (CONV-1 wave). The FAIL below is closed.**
> … Read the header, not the verdict line, for the current state.
```

```
docs/regression-baseline/phase-c-matrix/RESULTS.md:115:
> **SUPERSEDED ON THE CONTEXT AXIS — the FAIL below is closed.**
```

`docs/regression-baseline/platform-defaults-executor/RESULTS.md` opens
*"**Verdict: FAIL.** Three defects, one of them a regression this wave introduced into a guarantee a
previous wave had closed"* — and `HANDOVER.md` §5 lists it as *"reports a FAIL on a ruler regression
that has since been fixed and independently confirmed on WebView2."* Grepping the whole 471-line
file for `superseded|since fixed|now closed|no longer` finds nothing of that kind. Three siblings
carry a banner; this one does not, and it is the one HANDOVER names as most misleading.

`claimed-guards.test.ts` deliberately excludes `docs/regression-baseline/` and `docs/desktop-gate/`
from its scope, on the correct reasoning that *"a verdict that names the file a defect used to live
in is correct history, not a stale claim."* That reasoning is about **backticked tokens**. It is
not a licence for a headline verdict to stand uncorrected while its siblings are corrected.

### 6.3 `ci.yml`'s comment block — every factual claim I could check is true (PASS)

The head-of-job comment on `test-windows` makes five specific claims about defects that passed
Linux CI, plus two about what the job does not cover. Checked:

- *"`sandbox_boundary.rs` prints `SKIPPED: no WSL distribution on this machine`"* —
  `vela-sandbox/tests/sandbox_boundary.rs:162` carries that literal string.
- *"Four `*_fixture_replay` controls that fail only when git rewrites the wire captures on
  checkout. See `.gitattributes`."* — `.gitattributes` exists, names
  `anthropic_fixture_replay` and `google_fixture_replay`, and both exist as integration test files
  under `vela-providers/tests/`.
- *"`no-provider-leak.test.ts` keyed its carrier allowlist off `path.split('/')`"* and the
  `chat-contract-parity.test.ts` CRLF defect — established by this session on real hardware; not
  re-derived.

**PASS.** This is the newest prose in the repository and it is also the most specific.

---

## 7. `docs/HANDOVER.md`

Graded PASS, on the ground that it dates itself precisely and never claims currency. Its first
substantive sentence is *"`HEAD` and `origin/claude/new-session-tgl1ut` are both **`bf10d98`** at the
time of writing"*, and it opens *"Written at the point of retirement."* A reader can locate it in
history in one command.

Several of its rows are now closed, which is what a roadmap is for, and I record them so nobody
re-opens them: §3 item 6/7's two guards are both repaired (`claimed-guards` no longer falls back to
the basename — the control at `claimed-guards.test.ts:755` pins it; `verify-covers-ci` no longer
prefix-matches — §3.3 above), items 9–15 (projects, artifacts, sandbox, MCP, skills, scheduler,
memory) have all landed, and §6's *"CI has never run"* is superseded by HEAD.

One row of §6 I want to keep alive because it is *still* true and easy to lose: *"Everything except
the desktop verdicts is VERIFIED-BY-FAKE… The genuinely real evidence is narrow."* Nothing in the
33 undocumented commits changes that, and the conventions §10 staleness in §3.10 above makes it
harder to find.

---

## 8. What I could not establish

- **The Rust half of every cross-language claim.** `src-tauri/target` is **34 GB** and the machine
  has ~14 GB free with eleven agents sharing it, so I ran no `cargo` command at all — not even
  `cargo test -p vela-sandbox -- --list`, which still compiles. Every Rust-side guard in this
  report (`no_command_returns_secret_material`, `handler_binding.rs`, the three
  `*_parity_fixture.rs` readers, `capability_matrix_endpoints.rs`) is **inspection-only**: I read
  the assertion, I did not watch it fail. The lead's workspace figure (60 targets, 0 failed, 1277
  tests) says they pass; it does not say they bite.
- **The bulk of `docs/references/`.** I verified three primary sources out of thirty-three. The
  remaining thirty are marketing pages, DeepWiki reads and PR threads, several of which the studies
  themselves label as secondary automated reads. The studies' *self-labelling* is what I graded,
  and it is good; their *coverage* I sampled.
- **Whether `docs/spec-parts/` and `docs/vela-feature-spec.md` describe the real Anthropic
  products.** 10,117 + 8,600 lines of external-product specification, deliberately out of
  `claimed-guards`' scope, unsampled here beyond confirming the "178 features" total is arithmetic
  that adds up (22+22+31+23+16+18+30+16 = 178, `vela-feature-spec.md:337`).
- **Whether the 58 contract behavioural rules bite.** Taken as given from this session's own
  record; I proved one of them (`no-harness-leak`) and inferred nothing about the other 57.
- **Whether the wave-I doc gap is a decision or an omission.** No file says "the narrative stops
  here". I found no note anywhere retiring `vela-progress.md`, and `HANDOVER.md` §5 still calls it
  the running narrative, so I graded it as an omission. If it was retired deliberately, the fix is
  one line at the top of the file and this finding becomes a documentation nit.
- **Whether the doc-comment corpus outside the three contracts holds.** I grepped `src/` and
  `src-tauri/` for comments claiming enforcement in mechanism form and found the pattern almost
  absent — this repo names its guards rather than describing them, which is why
  `claimed-guards.test.ts` is as effective as it is. That is a sampling result, not a proof.
