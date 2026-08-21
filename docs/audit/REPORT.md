# Vela — full audit

Twelve independent auditors, one per domain, run in parallel against HEAD `a1fa55e`.
**264 aspects graded.**

Every row carries three judgements, each established by the auditor rather than inferred:

| column | meaning |
|---|---|
| **verdict** | `PASS` · `FAIL` · `UNVERIFIED`. Binary by design — this project forbids scores, because a score lets a real defect hide inside a good average. `UNVERIFIED` is a real answer. |
| **evidence** | `hardware` = run against a real window, endpoint or filesystem · `test bites` = the auditor broke the implementation and watched a named test fail · `test unproven` = tests exist, not checked that they bite · `read only` = inspected · `none` |
| **shipped** | traced, not assumed. `reaches-user` · `behind-flag` · `tests-only` · `not-wired` · `n/a` |

## Corrections

This audit is itself subject to the rule it enforces: **a comment is not evidence.** Rows found to
be false at HEAD are corrected here rather than quietly edited, so the correction is auditable.

### Correction 1 — "The capability grant is guarded against growth" (2026-08-15)

The original row read: *"`capabilities/main.json` … read by zero tests … Adding a permission fails
nothing, anywhere."* Both halves are false, and the row was graded `evidence: none` — which is the
tell. It was written from a prose sweep, not from running anything.

**Two tests read the file from disk:**

- `src/app/shell/window-controls.test.tsx:322-350` — asserts five permissions are present, and that
  `core:window:allow-internal-toggle-maximize` and `core:window:default` are absent.
- `src/platform/project-host-parity.test.ts:718-728` — asserts no permission matches
  `/^(?:fs|dialog|shell|http):/` and every permission matches `/^core:(?:event|window):/`.

**Adding a permission does fail, for the dangerous cases.** Adding `core:fs:default`,
`shell:allow-execute`, `core:http:default` and `dialog:allow-open` together turned
`project-host-parity.test.ts` red — 1 file failed, 103 passed. The renderer cannot be granted
filesystem, shell, HTTP or dialog access without a named test noticing.

**The real hole is narrower and still real.** The allowlist is a *prefix shape*, so any permission
matching `^core:window:` or `^core:event:` is accepted on sight. Adding
`core:window:allow-set-always-on-top`, `core:window:allow-set-position`, `core:window:allow-hide`
and `core:event:allow-emit-to` left both guards green — **38/38 passing, reproduced three times.**
The window surface can be widened silently; the plugin surface cannot.

The fix is the one `docs/vela-plan-2026-08-15.md` already specifies: **an exact-set assertion, not a
shape assertion.** The grade stays FAIL, for a defect one order narrower than the one recorded.

### A note on how this correction was nearly botched

The intermediate full-suite run reported **4 files / 12 tests failed** against the widened window
grant, which would have supported the opposite conclusion. Re-running with byte-identical input
gave **104 files / 2105 tests passed**. The failing run took 193s with 1088s of `environment` time
against 60s and 314s for the passing one — four agents were building concurrently on the same box.

The failures were contention artefacts. **On this machine, under parallel load, a single observed
test failure is not evidence of anything** — in either direction. A mutation that "fails" once is
not proof that a test bites. Every mutation claim in this document that rests on one observed
failure should be re-run before it is relied on.

### Correction 2 — the verification environment is inside a container (2026-08-15)

**Every process in the audit session is a descendant of Claude Desktop, which is MSIX-packaged.**
That gives the whole session a filesystem and registry view which is *not* the machine's, and it
silently invalidated a `reaches-user` grade.

An agent built Vela's NSIS installer, ran it, and recorded the app installed at
`%LOCALAPPDATA%\Vela\vela.exe` with an HKCU uninstall entry — graded `reaches-user`. It does not.
Established from two independent vantage points outside the process tree — a scheduled task run by
the Task Scheduler service, and WMI `CIM_DataFile` serviced by `WmiPrvSE.exe` — each carrying a
planted control proving it could tell a container-only file from a real one:

```
CONTROL real     Public REAL_MARKER    exists=True
CONTROL inside   INSIDE_MARKER CLEAN   exists=False    <-- correctly blind to the container
QUESTION         vela.exe CLEAN        exists=False
QUESTION         vela.exe CONTAINER    exists=True
```

`Get-ChildItem C:\Users\User\AppData\Local` from outside returns no `Vela` directory at all. The
HKCU uninstall entry is container-only and would never appear in Settings → Installed apps.

**The rule the evidence supports.** A top-level name under `%LOCALAPPDATA%` or `%APPDATA%` that
**already existed** falls through to the real location; one **first created by this session** is
captured in `…\LocalCache\` and is invisible outside. Redirection is per-top-level-name, not
blanket — which is why the worktrees and scratchpad have behaved coherently all along.

| Container-only — measurements here are not about the machine | Real — trustworthy |
|---|---|
| `%LOCALAPPDATA%\Vela`, `%LOCALAPPDATA%\tauri`, `%APPDATA%\Claude` | all of `%TEMP%`, including the scratchpad |
| **every `HKCU` key written this session** | `Desktop`, Start Menu, `C:\ProgramData`, `C:\Users\User\vela*` |

**There is no rule. Capture is per path, and it is undetermined.** The boundary runs *through*
`%APPDATA%\dev.vela.desktop`:

```
REAL       %APPDATA%\dev.vela.desktop            <- the directory itself falls through
REAL       %APPDATA%\dev.vela.desktop\skills                 (a directory)
CONTAINER  %APPDATA%\dev.vela.desktop\diagnostics            (also a directory)
CONTAINER  %APPDATA%\dev.vela.desktop\vela.db
CONTAINER  %APPDATA%\dev.vela.desktop\vela.db-wal
```

An earlier version of this section said "directories merge; files inside do not uniformly follow
the parent." **That is false and is corrected here rather than edited away:** `skills` and
`diagnostics` are both directories and they resolve opposite ways. Two samples looked like a rule
and were not. **Probe the exact path with `GetFinalPathNameByHandle` and believe nothing broader** —
not about a parent, not about a sibling, not about a file's type.

**What a real path still gives you, in full.** A handle that resolves REAL is a handle on the real
object, so everything read *through that handle* is real, its security descriptor included. Verified
by opening one handle and reading both the kernel final path and the DACL through it, so no re-open
could substitute a different object: the app-data directory's own ACL read from inside this session
**is** the user's ACL, byte-identical to `Get-Acl`. What is *not* trustworthy is an enumeration of
its children, which is a merged view, and any file read from it that resolves into the container.

That distinction cost a second wrong conclusion. A neighbouring document generalised this into "no
measurement of that directory describes the user's real one, including its ACL", which its own data
contradicted — and which would have told the track that is hardening exactly that ACL that its
evidence was worthless. **An over-correction destroys good evidence as surely as the original error
manufactured bad evidence**, and a claim landing on an alarming conclusion needs the same scrutiny
as one landing on a reassuring conclusion.

This retired a claim that had stood all session. An agent repeatedly reported that directory
"byte-for-byte and timestamp-for-timestamp identical" as evidence nothing had been written. It had
compared a **container copy of the database**. Nothing was in fact damaged — the app was never
launched and the installer does not touch that path — but the evidence was weaker than the sentence
it carried, and it happened to land on a reassuring conclusion, which is exactly when a
verification needs checking hardest.

**The authoritative check for any path is `GetFinalPathNameByHandle`.** If it resolves under
`…\Packages\Claude_pzs8sxrjxfjjc\LocalCache\`, the observation is about the container.

Two traps worth naming. `%LOCALAPPDATA%\Vela` is **not** a reparse point — `fsutil reparsepoint
query` errors 4390 and `GetFileAttributes` shows no reparse bit — so nothing on disk reveals the
mapping. And an **identical NTFS file ID at both the clean and container paths does not prove
container-only**: `%APPDATA%\dev.vela.desktop\vela.db` shows one ID at both paths and is genuinely
real. Identical IDs prove one file at two paths; only an outside vantage separates "real file also
visible in the container" from "container file also visible at the clean path". That distinction
cost one wrong intermediate conclusion in this investigation.

**Consequence for the supreme rule.** `reaches-user` means an auditor clicked it in the running
window. Installing from inside this session does not establish that a user can run the result, so
any future install- or registry-based `reaches-user` claim must be confirmed from outside the
container or graded UNVERIFIED. Real damage is still possible in the unredirected paths: this
install overwrote two genuine shortcuts on the user's Desktop and Start Menu to point at a
container-only path, which would have failed for the user with no diagnostic.

## The first `reaches-user` evidence in this audit (2026-08-16)

Until this entry, **every** verdict in this document was `traced` or `test-bites`. The supreme rule
grades those UNVERIFIED. Three surfaces have now been clicked in a running Vela window at
`8200985`, driven by `tests/harness/desktop-click/vela-drive.mjs`.

Process ownership was proven on every command, not assumed: the pid holding the debug socket
(`msedgewebview2.exe` 35612) was verified to descend from the `vela.exe` the harness itself spawned
(3168). App-data was `isolated`, identifier `dev.vela.harness`.

| surface | what appeared in the live DOM when its sidebar control was clicked |
|---|---|
| Projects | `role="dialog"` — "A project holds instructions that are sent with every agent run…"; body text 1710 → 2025 chars |
| Skills | "Skills are folders in Vela's skill store on this device. Each one holds a SKILL.md file…"; body 2050 |
| Schedules | "When a slot comes round, Vela opens a conversation holding the prompt…"; body 2214 |

**What this evidence is not.** A dev-profile binary against a Vite dev server, not a release bundle
and not an installed one. Clicks after the first were dispatched through CDP, which React handles as
a genuine user event but which is not OS input. Nothing was typed, so the keystroke corruption
described in `fix/harness-keycode` does not touch these three results — but it does touch any
earlier grade that involved typing.

### Defect found by clicking, which 2,311 passing tests did not find

**Two controls share the accessible name "Close", and one of them quits the application.**

With a panel open, the DOM holds `aria-label="Close"` on the titlebar caption control
(`_captionButton_ _closeButton_`, outside any dialog) and a second control whose text is `Close`
inside the dialog (`_close_`). Name-based navigation — a screen reader, voice control, or any
automation — cannot distinguish "dismiss this panel" from "quit Vela".

Established by reproduction, per this document's own standard that an unnamed single failure stays
unestablished until a name repeats. First occurrence: an automated run died mid-sequence with
`CDP Runtime.evaluate timed out after 30000ms` and the process gone, with **no Rust panic and no
Windows Error Reporting entry** — which is why it initially read as a crash. Deliberate second
occurrence: with no dialog open exactly one control named `Close` exists; clicking it produced the
identical timeout signature followed by `vela processes alive: 0`.

Vela did not crash on either occasion. It was closed by a control that a user navigating by name
cannot tell from a panel dismissal.

### A second instrument defect, recorded because it affects how every grade here is read

`vela-drive.mjs`'s `up` returns `ok: true` while `readyState` is `interactive` and
`rootChildElements` is `0`. Its README states that `up` waits for `readyState === 'complete'`. It
does not. Both launches in this session reported success against an unmounted renderer, which reads
as "the app renders nothing" to anyone who trusts the return value. It is cold-start latency, and
`mount` re-run a minute later reports correctly — but a harness that reports success for a state its
own `mount` command calls `THE RENDERER DID NOT MOUNT` is a harness that can manufacture a false
verdict in either direction.

**Closed, 2026-08-21, by `2d69b9c` "T03: make `up` grade its own mount report instead of watching
one word".** Listed here rather than edited in place, per this file's own convention above. Neither
half of the finding holds now, measured in `C:/Users/User/vela-t03` at the commit this line is
committed in. `commands.up` in `tests/harness/desktop-click/vela-drive.mjs` ends with
`if (!readiness.grade.mounted)` throwing `HarnessError(EXIT.FAILED, ...)`, so an unmounted renderer
exits 7 carrying the mount verdict rather than returning `ok: true`. And the README no longer makes
the `readyState` claim: the word occurs there 5 times, and the occurrence that names the old
sentence is the heading paragraph of "What `up` waits for, and why it is not `readyState`", which
opens by quoting the old sentence and calling it the defect. What this finding says about the
`readyState` **mechanism** stands, and is why the fix took the shape it did — `readyState` reaches
`complete` faster when the bundle fails than when it loads.

## What Wave 1 closed, and what it did not (2026-08-15)

Six branches merged. Rows are listed here rather than edited in place, so the original grade and
the thing that closed it stay side by side.

**Closed, each by a merged commit and a critic PASS:**

| row | closed by |
|---|---|
| verify covers CI, reverse direction — `run: \|` block bodies | `7f5cd93` |
| verify-covers-ci: gates written inside a `run: \|` block | `7f5cd93` |
| Windows CI job covers the gates that break on Windows | `7f5cd93` |
| `.gitattributes` covers the byte-exact evidence it names | `7f5cd93` |
| `pnpm verify` is runnable on Windows | `7f5cd93` |
| `processes` limit reported `kernel`-enforced | `4949578` |
| An installable bundle has ever been produced | `9baf471` |
| Build determinism / toolchain pinning | `9baf471` |
| `vela-skills::mount` and `::enablement` are a dead duplicate | `730eca5` |
| `skill-mount-parity.test.ts` guards the shipped mount | `730eca5` |
| `contract.test.ts`: claimed runtime exhaustiveness of `IpcContract` | `ca22700` |

**The capability grant, closed in two stages, and the second was the larger hole.**

Stage one (`ca22700`) replaced a prefix shape with an exact set, so adding a permission to
`main.json` reddens a named test in both directions. Stage two (`ef82726`) closed what that left:
both guards read **one filename** while Tauri globs `capabilities/**/*` **unconditionally**, so a
second file registered in `tauri.conf.json` widened the window's real surface with both tests green
at 39/39 — a premise a critic reproduced from prose with its own independently written probe.

The resolution rules were read from the pinned crates rather than the docs site, and one is
**inverted from the intuitive reading**: `"capabilities": []` or a missing key means **all**, not
none (`tauri-utils acl/mod.rs:358`, with `#[serde(default)]` on the field). A guard built on the
safe-seeming assumption would have asserted exactly backwards, and no compile could have caught it.
Also established: the key is the `identifier` field rather than the filename; an untagged object
entry inlines a capability with **no file at all**; and the config itself is not one file, since
`read_platform` merges a per-target overlay over the base — which the builder found in its own
first commit while fixing the first instance.

**A recognised defect class came out of this: a guard reading one file from a directory the product
reads whole.** Three instances, one per track that went looking — the capability grant, the Tauri
config, and `verify-covers-ci.test.ts` reading `ci.yml` while GitHub Actions runs every workflow in
the directory. The third is on the backlog.

**Also closed since:** *the wave-long load artefact* (`64c970e`) — two mechanisms, neither fixable
by a timeout, with a critic measuring 9 distinct tests failing at base and 0 after. It was blocking
`pnpm verify` at gate 3 in two runs of three.

**A could-not-establish, now established — and the audit guessed the right way.** This document's
own open-question list says it could not determine whether `pnpm lint:rust` passes, because clippy
must build the whole dependency graph before it lints a line and the disk budget did not allow it,
and adds: *"This is link 2 of `pnpm verify`, so if it is red the Windows verify story is worse than
reported, not better."*

**It was red, and worse than reported.** `cargo fmt --all --check` produced 33 hunks across 5 files
and `clippy -D warnings` two errors — from the **pure-LF stored bytes**, so neither Windows nor
line endings, meaning gate 2 was red on **every platform** and CI had never run on this branch to
notice. Everything behind link 2 — including both cargo gates — had therefore never executed for
anyone, which is a stronger statement than the "never run on Windows" the table records. Fixed at
`4949578`; green cold from an empty target directory, confirmed from three worktrees.

Worth keeping as a matter of method: the auditor could not run the check and **said which answer
would be the bad one**. That framing is what made the finding legible the moment somebody could
run it. A could-not-establish that names its own worst case is worth more than one that just stops.

**`pnpm verify` runs to completion on Windows — CLOSED, and it took four runs to earn.** This was
deliberately left ungraded while every gate had been seen green *individually*, which is exactly the
evidence this document exists to distrust: gate 2 hid for the project's entire history behind people
checking the parts.

The four end-to-end runs, in order, are the record worth keeping:

| run | outcome |
|---|---|
| 1 | **gate 3** — `EndpointsPanel.test.tsx:121` timed out at 5000ms. The load artefact. |
| 2 | **gate 4** — `frontier/01-health.json is stale`. A **real** defect, and its advice was wrong. |
| 3 | **gate 3** — `EndpointsPanel.test.tsx:176`. The artefact again. |
| 4 | **exit 0**, 7.4 min — after the flake fix merged at `64c970e`. |
| 5 | **exit 0**, 2.9 min. Reproduced. |

Two different faults, two different gates, and each would have been misread alone. Run 1 alone says
"the flake blocks verify". Run 2 alone says "the transcripts are stale, re-record them" — which is
what the assertion advised and would have overwritten **58 correct baselines** with captures taken
that minute, destroying the one property a regression baseline has.

The gate-4 failure was not staleness. `.gitattributes` marks that directory `-text`, and the rule is
correct — but **an attribute added after a file is already in the working tree does not rewrite it**,
and git's stat cache means the content is never re-read. So `git status` reported clean while 58 of
106 files held CRLF on disk against pure LF in the object store. The rule had been verified against a
*fresh checkout*, where it gives 0 of 106. Nobody asked what an existing tree does — which is every
developer's machine and a cached CI runner. Restored with `rm -rf` + `git checkout --`; the guard now
distinguishes the two faults and names the right remedy for each (`9002685`).

**Not closed, and Wave 1 did not touch them:**

*Bundle identifier `dev.vela.desktop` is shared by every instance.* Still no single-instance
plugin, no named mutex, no `WEBVIEW2_USER_DATA_FOLDER`. Blocked behind the app-data track, which
owns the startup path.

*`ci.yml`'s claim that check-transcripts detects a lost `.gitattributes`.* The audit measured this
false — with the attribute removed, a CRLF checkout regenerated as LF gives `git diff --quiet`
CLEAN, because autocrlf normalises on read, so the step catches only the opposite case. The
sentence survives verbatim at `ci.yml:278-279`, **inside a comment block that `7f5cd93` rewrote at
length**. A correction that lands all around a false sentence and leaves it standing is the shape
this wave found three times over; it is on the backlog rather than quietly fixed here, because
whoever fixes it should re-run the measurement rather than take the audit's word or mine.

## Totals

| verdict | count |
|---|---|
| PASS | 197 |
| FAIL | 59 |
| UNVERIFIED | 8 |

| evidence | count |
|---|---|
| measured on hardware | 73 |
| test bites (mutation-proven) | 109 |
| test exists, unproven | 27 |
| inspection only | 53 |
| none | 2 |

| shipped | count |
|---|---|
| reaches a user | 195 |
| behind a flag | 6 |
| tests only | 0 |
| **not wired** | **36** |
| n/a | 27 |

**182 of 264 rows (69%) rest on something that was run or broken on purpose**, rather than read.

## Per domain

| domain | aspects | PASS | FAIL | UNVERIFIED | not wired |
|---|---|---|---|---|---|
| Agentic runtime and tool execution (src/runtime/ + wiring through App.tsx into use-conversation.ts) | 25 | 20 | 4 | 1 | 5 |
| Build, packaging and developer experience | 20 | 8 | 11 | 1 | 2 |
| Conversation surface | 23 | 18 | 4 | 1 | 1 |
| Desktop shell, layout and visual design (src/app, src/features/navigation, src/components, src/styles) | 23 | 21 | 2 | 0 | 0 |
| Documentation honesty and claim integrity | 22 | 15 | 7 | 0 | 0 |
| Guards, contracts and the verification apparatus | 23 | 18 | 4 | 1 | 1 |
| Projects, skills and MCP | 21 | 12 | 8 | 1 | 15 |
| Providers and model layer | 20 | 17 | 3 | 0 | 2 |
| Sandbox and code execution | 21 | 17 | 4 | 0 | 2 |
| Scheduler, dual local endpoint, memory, canvas/artifacts (Phase 3 tracks) | 23 | 17 | 5 | 1 | 5 |
| Secrets, credentials and data-at-rest | 20 | 17 | 2 | 1 | 0 |
| Storage, migrations and search (src-tauri/crates/vela-store) | 23 | 17 | 5 | 1 | 3 |

---

# The grading table

## Agentic runtime and tool execution (src/runtime/ + wiring through App.tsx into use-conversation.ts)

> The runtime is genuinely wired and its sequencing rules are real — I broke eleven of them one at a time and watched a named test fail each time, including from the full-app composition-root test. What is not wired is the directory's read side: `forConversation`, `list`, `snapshot` and every `RunDegradation` have no caller in the product, so a conversation view can never re-attach to a run in flight (locking that conversation for up to ten minutes with no cancel), and a run that hit a step, tool-call, wall-clock or missing-context limit is drawn identically to one that ended naturally.

| aspect | verdict | evidence | shipped | finding |
|---|---|---|---|---|
| A conversation view re-attaches to a run in flight on mount (LiveRuns.forConversation) | **FAIL** | read only | not-wired | `git grep forConversation -- src/` finds only contract-harness.ts and live-runs.ts. App.tsx:165 remounts on key={conversationId}; use-conversation.ts:288 unsubscribes without cancelling; stop() at :849 reads activeRun.current which is null after the remount. Net effect: switch away mid-run and back and the conversation is refused with RUN_BUSY, with no cancel control, until DEFAULT_RUN_LIMITS.wallClockMs (10 min) expires. |
| RunSnapshot / LiveRuns.list — the directory's read side | **FAIL** | read only | not-wired | `runs.list()` and `RunHandle.snapshot()` have no shipping caller anywhere under src/. Everything they expose — status.step, retainedFrom, startedAtMs, degradations — is computed for nobody. |
| Degradations reach the user (stepLimitReached, toolCallLimitReached, wallClockLimitReached, contextUnavailable) | **FAIL** | read only | not-wired | use-conversation.ts:773-798 handles only `chat` and `runFinished`; settleRun (:499) reads outcome.type/stopReason and nothing else. A run capped at 12 steps or cut off at 10 minutes renders identically to one that ended naturally — the silent reduction agent-loop-harness.ts:311 cites conventions §9 to forbid. |
| toolCallStarted emitted in call order, before any call is dispatched | **FAIL** | read only | not-wired | Two mutants survived the whole runtime suite: reversing the emission order (25/25 passed) and moving the emit loop below Promise.allSettled so it fires only after everything settled (42/42 passed across three files). agent-loop-harness.test.ts:588 asserts dispatch order and toolCallFinished order, never toolCallStarted. No surface consumes either event, so the user never sees a tool call in progress. |
| Subagent fan-out executed through the real composition root | **UNVERIFIED** | read only | reaches-user | The path is complete by trace (use-conversation.ts:747 offers subagentToolDefinition on every agent run; app-runtime.ts:81 toolsFor → toolkit). But BrowserAdapter always answers `toolCalls: []` (browser-adapter.ts:1403), so no test can drive spawn_subagent through <App/>. app-runtime.ts's store_create_conversation call has never been executed by any test. |
| Runtime reaches a user (composition root → composer → LiveRuns.start) | **PASS** | test bites | reaches-user | Traced main.tsx → App.tsx:119 createAgentRuntime → ConversationSurface → use-conversation:731 runs.start. Mutant M5b (`const begin = agentOn ? startRun : start` → `= start`) failed 16 tests across composition-root.test.tsx and agent-run.test.tsx, including the full-<App/> test 'runs the turn through the live-run directory, which writes the row as it goes'. |
| Agent affordance gated on capabilities.toolCalls | **PASS** | test bites | reaches-user | Honest gating, not a dead path: BrowserAdapter deliberately probes only `streaming` (browser-adapter.ts:1263), but the Tauri host reports toolCalls from capability.rs:191 `tool_calls: self.tool_calling.is_offerable()`. Removing the conjunct at use-conversation.ts:610 (M5a) failed 'offers no agent control on a model that cannot request a tool'. Caveat: the toggle can never appear in `pnpm dev` in a browser. |
| Structural reachability guard (reachable.test.ts) | **PASS** | test bites | n/a | Dropped a new unimported src/runtime/orphan-probe.ts (no tracked file touched); the guard failed with `expected [ 'src/runtime/orphan-probe.ts' ] to deeply equal []`. It bites on a real orphan, not only on its own fixture. |
| seq is dense, 0-based, assigned by the directory — runStarted is seq 0 | **PASS** | test bites | reaches-user | live-runs.ts:264 `nextSeq: 0` → `1` failed 8 of 21 tests in live-runs.test.ts, led by 'numbers events densely from zero, so runStarted is seq 0'. |
| Nothing is numbered after the terminal event | **PASS** | test bites | reaches-user | live-runs.ts:158 `if (record.terminal) return;` → `if (false) return;` failed 'sequencing > numbers nothing after the terminal event'. |
| Late join replays then goes live with no gap | **PASS** | test bites | not-wired | live-runs.ts:188 `Math.max(asked, …)` → `Math.max(asked + 1, …)` failed 3 tests. The rule holds — but the product never late-joins: use-conversation.ts:768 is the only subscribe and always passes { fromSeq: 0 } on the line after start(). |
| No duplicate: replay is delivered before the listener is registered | **PASS** | test bites | reaches-user | Moving `record.subscribers.add(subscriber)` above the replay loop failed exactly one test — 'never interleaves a live event into a replay that is still in flight' — the one whose comment says it was written because no other test held this ordering. The comment is accurate. |
| One services bundle and one harness per admitted run; a rejection builds neither | **PASS** | test bites | reaches-user | Hoisting `const bundle = services(request)` above the three rejection checks failed 'a rejected request builds neither a bundle nor a harness'. live-runs.ts:241-252: all three rejections are decided before the factory call, with no path around it. |
| A harness that throws out of create/start leaves no record behind | **PASS** | test bites | reaches-user | Moving `records.set(request.runId, record)` above `definition.create(bundle)` failed 'leaves no record behind when a harness throws out of create or start' — the exact defect live-runs.ts:273-285 describes (a conversation permanently conversationBusy). |
| Bounded buffer retains at least RUN_BUFFER_MIN_EVENTS | **PASS** | test bites | reaches-user | Compacting to `Math.floor(RUN_BUFFER_MIN_EVENTS / 2)` failed 'retains at least RUN_BUFFER_MIN_EVENTS and reports the truncation'. |
| Tool calls in one turn run genuinely concurrently | **PASS** | test bites | reaches-user | Replacing `Promise.allSettled(calls.map(...))` with an awaited for-loop failed 10 tests, including 'has three runs live in the directory at the same instant'. This one line is where 'real parallel subagents' actually comes from. |
| maxToolCalls counted across the whole run; wall clock checked after every streamed event | **PASS** | test bites | reaches-user | `maxToolCalls - toolCallsUsed` → `maxToolCalls` failed 'stops at maxToolCalls, counting across the whole run'. Deleting the elapsed check inside consumeTurn failed 'stops on the wall clock, measured on the injected now()' (by timeout, 5016ms). |
| Transcript row opened `streaming` at turn open and closed on all four exit paths | **PASS** | test bites | reaches-user | EMPTY_TURN_PARTS → [] failed 3 tests including both in adapter-integration.test.ts (harness over the real BrowserAdapter) — the defect the file header describes. Contrary to that header, agent-loop-harness.test.ts now catches it too. |
| Subagent depth ceiling — both mechanisms | **PASS** | test bites | reaches-user | Removing the `depth >= options.maxDepth` refusal (leaving only tool-stripping) failed 'refuses a call that arrives anyway, with an error result rather than a rejection'. MAX_SUBAGENT_DEPTH = 1 in app-runtime.ts. |
| Parent cancellation reaches every child run | **PASS** | test bites | reaches-user | Deleting `signal.addEventListener('abort', onAbort, { once: true })` in subagent-toolkit.ts failed "cancels every child when the parent's run is cancelled". |
| ContentPartCodec image branch (bytes → base64) | **PASS** | test bites | reaches-user | Replacing the image arm with `part as unknown as ContentPartInput` — the cast the header warns about — failed all 5 image tests including 'agrees with the one encoder the renderer ships'. |
| A ref from one project's resolver does not resolve in another's | **PASS** | test bites | reaches-user | Deleting `if (ref.id !== instructionsRefId(projectId)) return null;` from project-context.ts failed 'refuses a ref indexed against another project, rather than guessing'. |
| HarnessRuntime.contextFor memo is keyed by project | **PASS** | read only | reaches-user | Code is literally `resolvers.get(projectId)` and is correct. But collapsing the memo so contextFor(B) returns A's resolver passed 33/33 tests — nothing holds it, because every equivalence assertion uses DEFAULT_PROJECT_ID only. Latent, not live: App.tsx passes one constant project and readProjectInstructions answers null for all of them. |
| No surface branches on a harness id; a harness performs no I/O of its own | **PASS** | test bites | n/a | Adding `id === 'agent-loop'` to the real use-conversation.ts (not a synthetic fixture) failed 'never writes a registered id as a literal outside the definitions'. |
| Stop cancels the run, not just the open turn | **PASS** | test unproven | reaches-user | use-conversation.ts:853 prefers activeRun.current.cancel() over the turn handle; composition-root.test.tsx:375 drives it through <App/>. I did not mutate this specific ordering — note it is unreachable after a remount (see the forConversation row). |

**Could not establish:**

- Anything measured on real hardware. I did not launch the app and did not touch the llama.cpp server on 127.0.0.1:8033 — neither is in my brief. Every PASS here is VERIFIED-BY-FAKE (jsdom + BrowserAdapter) or read off source. Nobody in this session has seen the agent toggle rendered in a packaged Tauri build.
- Whether a real endpoint's probe actually sets capabilities.toolCalls true in the product. I read the Rust (capability.rs:191) and took the session's prior finding — probe under-reporting fixed — as given rather than re-deriving it.
- Whether the ten-minute conversation lockout after a mid-run conversation switch actually reproduces. The mechanism is traced and the conversationBusy half is asserted by agent-run.test.tsx:205; the 'no cancel affordance survives the remount' half is inspection-only.
- The subagent fan-out end to end. No fake in this repo can emit a tool call through the adapter seam (BrowserAdapter always returns toolCalls: []), so store_create_conversation for a child, the 'Subagent N' conversation in the sidebar, and two children genuinely in flight under the real composition root have never been executed by any test or by me.
- turnStarted / RunStatus.step folding. advance() is correct by inspection but its only readers are snapshot() and list(), neither of which the product calls, so I did not grade it as a separate row.
- Whether the RUN_REJECTED refusal text is ever wrong. It renders all three rejection reasons as 'Another run is already going in this conversation.' The other two (duplicateRunId from a crypto.randomUUID, unknownHarnessId from a definition the registry just returned) look unreachable from that call site, but I did not prove they are.
- Retry-with-agent internals. M5b showed the three retry tests fail when the routing is broken, so it is wired, but I did not mutate the deletion/rewrite ordering inside retry itself.
- I did not run the full TS suite under any mutant, only the targeted files named in each run. A mutant I recorded as 'survived' may be caught by a test file I did not run — though for M16/M17 I ran all three files that touch the tool path, and for M4b all three that touch context resolution.

## Build, packaging and developer experience

> `pnpm verify` — documented in README and conventions.md as "the full gate, and a superset of CI" — cannot complete on Windows, the platform Vela ships on: it dies at step 4 of 9 (`pnpm test:harness`, 2 real failures) and again at steps 6 and 7 (`'.' is not recognized` — pnpm runs `./scripts/*.sh` through cmd.exe), so the Rust half of the gate is never reached. The test that asserts verify covers CI passes anyway, because it only compares strings.

| aspect | verdict | evidence | shipped | finding |
|---|---|---|---|---|
| `pnpm verify` runs to completion on Windows | **FAIL** | hardware | reaches-user | Chain dies at link 4 (`pnpm test:harness`, exit 1) and again at links 6 and 7; `&&` short-circuits so `cargo build --workspace --locked` and `cargo test --workspace --locked` are never executed by anyone running the documented command on Windows (package.json:22). |
| pnpm can invoke the repo's shell scripts on Windows | **FAIL** | hardware | reaches-user | `pnpm run test:transcripts` and `pnpm run test:secrets` both print `'.' is not recognized as an internal or external command` and exit 1; pnpm uses cmd.exe and `.npmrc` sets no `script-shell`. The same scripts pass under bash (`bash scripts/check-transcripts.sh` exits 0). CI's Windows job knows this and passes `shell: bash`; package.json does not. |
| `pnpm test:harness` (GATE M Part 1) on Windows | **FAIL** | hardware | reaches-user | 2 failed / 140 passed, twice, deterministically: `record-transcripts.test.ts` byte comparison fails on CRLF-translated `.json` captures, and `server.test.ts` "a request body over the 8 MiB cap" fails with ECONNRESET (Winsock resets where Linux closes gracefully). It is a CI gate, but only in the ubuntu `test-ts` job. |
| verify covers CI, reverse direction (a new CI gate must be listed) | **FAIL** | test bites | reaches-user | Two proven blind spots. M3: a gate added as `run: \|` / `pnpm lint:css` / `pnpm audit --prod` gives 13/13 pass, because the harvest regex `/^[ \t]*-?[ \t]*run: (.+)$/gm` never sees block-scalar bodies. M7: `run: pnpm test:e2e` gives 13/13 pass, because "accounted for" is `line.includes('pnpm test')`. A single-line novel gate (M2) is correctly caught. |
| Windows CI job covers the gates that break on Windows | **FAIL** | read only | reaches-user | .github/workflows/ci.yml `test-windows` runs typecheck, `pnpm test`, cargo build/test and check-transcripts.sh — but not `pnpm test:harness` and not `pnpm build`. `pnpm test:harness` is exactly the gate that is currently red on Windows, so the job whose stated purpose is to make a green run mean something on the shipping platform omits it. |
| `.gitattributes` covers the byte-exact evidence it names | **FAIL** | hardware | reaches-user | Protects `*.sse` and `*.jsonl`. `docs/regression-baseline/mock-matrix/` holds 48 `.json`, 43 `.txt`, 12 `.sse`, 2 `.md`, 1 `.tsv` and zero `.jsonl`; `frontier/01-health.json` measured at 8 CRLF / 8 LF on disk. The line-ending repair at HEAD stopped one extension short of the directory its own comment describes. |
| The capability grant is guarded against growth | **FAIL** | test bites | reaches-user | **Corrected 2026-08-15 — the original row was false in both its reason and its conclusion; see "Correction 1" below.** Two tests do read the file. Plugin escalation is caught. The real hole is narrower: any permission matching `^core:(?:event\|window):` is accepted, so `core:window:allow-set-always-on-top`, `allow-set-position`, `allow-hide` and `core:event:allow-emit-to` were added together and both guards stayed green, 38/38, three runs. Shape assertion where an exact-set assertion is required. |
| Bundle identifier `dev.vela.desktop` is shared by every instance | **FAIL** | hardware | reaches-user | `store_host.rs` resolves the DB from `app.path().app_data_dir()` = `%APPDATA%\dev.vela.desktop`; projects, skills, diagnostics and the WebView2 `EBWebView` profile all hang off the same root, and the identifier is hard-coded again as `KEYCHAIN_SERVICE` (vela-secrets/src/lib.rs:47). No single-instance plugin (none exist in Cargo.lock), no named mutex, no `WEBVIEW2_USER_DATA_FOLDER`. `docs/desktop-gate/VERDICTS.md:1414` records the hazard and leaves the mitigation as a manual instruction to the operator. |
| An installable bundle has ever been produced | **FAIL** | hardware | not-wired | `src-tauri/target/release/bundle` does not exist; `target/release/wix/x64` exists and is empty, i.e. a `pnpm tauri build` on 2026-08-13 did not clear the bundler. `bundle.targets: "all"` means WiX+NSIS, both downloaded from the network at build time. No signing config, no updater config. conventions.md section 11 honestly lists it as "not attempted". |
| Build determinism / toolchain pinning | **FAIL** | read only | reaches-user | No `rust-toolchain.toml` anywhere; `rust-version = "1.82"` is a floor and CI uses `dtolnay/rust-toolchain@stable`, which floats with the calendar. `Cargo.lock` plus `--locked` pin dependencies but not the compiler, and the MSI/NSIS toolchains are fetched over the network at build time. The JS half is properly pinned. |
| `engines.node` floor matches what the tree actually needs | **FAIL** | read only | reaches-user | package.json declares `">=20.19"`, but the mock-provider harness is unbuilt TypeScript run directly by `node` — cli.ts:6 says "Node 22 strips TypeScript types natively", ci.yml:132 pins node 22 for that reason, and `vela-providers/tests/mock_matrix_live.rs:60-63` spawns `node .../cli.ts` from a Rust test. A contributor on Node 20.19 installs cleanly and then gets an unexplained Rust test failure. |
| Dev server bind address vs Tauri `devUrl` | **UNVERIFIED** | read only | reaches-user | vite.config.ts binds `host: '127.0.0.1'` with `strictPort`, while tauri.conf.json sets `devUrl: "http://localhost:1420"`. On Windows `localhost` can resolve to `::1` first. Confirming this requires launching `pnpm tauri dev`, which is another auditor's remit. |
| verify covers CI, forward direction (each CI gate reachable from verify) | **PASS** | test bites | reaches-user | Mutation M1 in a scratch copy: removing `pnpm build` from the verify chain fails `verify-covers-ci.test.ts` with the intended message (12 passed / 1 failed). The recursive `expand()` over `pnpm <name>` references works. |
| CI guard that every cargo job can build the dependency graph | **PASS** | test bites | reaches-user | M4 (new cargo job on `runs-on: freebsd-14`) hits `expect.fail` — an unknown runner is rejected rather than assumed. M5 (cargo job on ubuntu with no apt step) fails with the webkit2gtk message. Both non-vacuous. |
| Shipped capability grant is minimal (no fs/shell/http/process) | **PASS** | hardware | reaches-user | Recovered the embedded ACL from `src-tauri/target/release/vela.exe`: exactly `plugin:event\|{emit,listen}` and `plugin:window\|{close,minimize,toggle_maximize,internal_toggle_maximize}`. Probes for `plugin:fs\|read_file`, `plugin:shell\|execute`, `plugin:http\|fetch`, `plugin:process\|exit`, `plugin:path\|resolve`, `plugin:webview\|create_webview`, `plugin:window\|set_always_on_top` all return 0. The debug binary carries `internal_toggle_devtools`; the release binary does not. |
| Plugin surface absent from the dependency graph | **PASS** | hardware | reaches-user | `src-tauri/Cargo.lock` contains no `tauri-plugin-*` crate at all, and `src-tauri/gen/schemas/acl-manifests.json` contains only ten `core:*` manifests. There is no fs/shell/http/process manifest to grant a permission from, so lib.rs:9's claim is true structurally rather than by discipline. |
| Frontend production build and CSP compatibility | **PASS** | hardware | reaches-user | `pnpm run build` succeeds on Windows in 5.50s, 191 modules transformed. `dist/index.html` has zero inline `<script>` (module tag with src) and the Inter/JetBrains Mono faces are emitted as local `.woff2`, satisfying the `script-src 'self'` / `font-src 'self' data:` policy in tauri.conf.json. |
| Bundle icon set is complete and Windows-valid | **PASS** | test bites | reaches-user | `src/platform/bundle-icons.test.ts` re-implements tauri-build's `.ico` resolution rule instead of hard-coding it, checks the ICO magic rather than mere existence, and carries six non-vacuity controls that build a broken icon set in a temp dir and assert each detector fires; I ran the file, 10/10 pass. Closes a defect (`icon.ico` missing until a50ee9f) that was invisible on Linux and fatal on Windows. |
| `pnpm install --frozen-lockfile` succeeds (lockfile in sync) | **PASS** | hardware | reaches-user | Run in a scratch copy so the shared node_modules was untouched: `pnpm install --frozen-lockfile --lockfile-only` completed in 435ms and the regenerated lockfile is byte-identical to the committed one after EOL normalisation (70502 chars both). |
| Cargo workspace layout and default-members | **PASS** | read only | reaches-user | `members = ["crates/*"]` resolves to exactly the ten crates enumerated in `default-members`, plus the root, so the comment's claim that bare `cargo test` covers every crate is currently true. Unguarded — nothing fails if an eleventh crate is added and not listed — but CI and verify both use `--workspace`, so the blast radius is small. |

**Could not establish:**

- Whether `pnpm tauri build` produces a working MSI or NSIS installer. It needs WiX and NSIS downloaded plus a full release compile of a ten-crate workspace, on a machine with ~15 GB free shared by eleven agents. All that is established is that no bundle directory exists and one attempt on 2026-08-13 left an empty `target/release/wix/x64`.
- Whether the two Windows-only `pnpm test:harness` failures reproduce on GitHub's `windows-latest` runner. Failure 1 depends on the runner's `core.autocrlf`, failure 2 on Winsock behaviour I expect to reproduce but did not observe there. Moot in practice: CI never runs `pnpm test:harness` on Windows, so it would not find out either way.
- Whether `devUrl: http://localhost:1420` actually reaches a dev server bound only to `127.0.0.1` under WebView2. Requires launching the app, which I was not authorised to do.
- Whether a Node 20.19 contributor really fails on the harness. Only Node v24.15.0 is installed here; the conclusion is read off cli.ts's own header, ci.yml's pin and Node's type-stripping history, not measured.
- Whether `pnpm lint:rust` (`cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings`) passes. Clippy must build the whole dependency graph before it lints a line, and the disk budget did not allow it. This is link 2 of `pnpm verify`, so if it is red the Windows verify story is worse than reported, not better.
- Whether `cargo build --workspace --locked` / `cargo test --workspace --locked` pass. Taken as given from the lead's measurement (60 targets, 0 failed, 1277 tests), not re-run, by instruction.
- Whether the `verify-covers-ci` blind spots I proved (M3 block scalars, M7 substring swallowing) have already let a real CI step through unnoticed. Every gate in the current `ci.yml` is single-line and accounted for, so the holes are latent rather than currently exploited.
- Whether any other `pnpm` script silently depends on a POSIX shell. I measured `test:transcripts` and `test:secrets`; the rest are plain executables (`vite`, `tsc`, `vitest`, `node`, `cargo`) or `cd x && y`, which cmd.exe handles, but I did not run each one.
- Whether the other shell gates in `scripts/` (`gate-m-composition-root-controls.sh`, `gate-m-debug-log-modes.sh`, `gate-m-debug-log-acl.ps1`) are reachable from any automated gate at all. They appear in neither `pnpm verify` nor `ci.yml`, and I did not trace who, if anyone, runs them.

## Conversation surface

> The paths this surface was designed for are real and mutation-proven — I broke the implementation thirteen times and watched a named test go red each time, including the endpoint-text rule and the reasoning guard. The failures are all in states nobody wrote a screen for: a model that returns nothing renders as a literally empty turn, an answer truncated at maxTokens is drawn as if it finished, and the per-turn "Try again" button on an older failed turn silently re-runs and replaces the newest turn instead.

| aspect | verdict | evidence | shipped | finding |
|---|---|---|---|---|
| Retry button targeting on an older failed turn | **FAIL** | test bites | reaches-user | Probe driving the real hook+view: with turn 1 failed and turn 2 answered, clicking turn 1's only 'Try again' re-sent QUESTION TWO, wiped turn 2's answer, and left turn 1's error untouched — the button is per-turn, retry() is global (use-conversation.ts:866). |
| What a user sees when a model returns nothing | **FAIL** | test bites | reaches-user | Probe: a `done` with no parts, no reasoning, no error renders an empty <article aria-label="Model reply"> — textContent "". Reachable: stream.rs:335, anthropic/stream.rs:619 and google/stream.rs:559 all raise StreamEndedWithoutAnswer only when malformed_frames > 0, so a clean zero-token stream is not an error. |
| What a user sees when an answer was truncated at the token limit | **FAIL** | test bites | reaches-user | stopReason 'maxTokens' survives into TurnState and the store but `git grep maxTokens -- src` finds it only in contract.ts and a parity test; probe rendered a cut-off answer as "half a senCopy" with no truncation notice. |
| Tool-call surface on the ordinary chat path | **FAIL** | read only | not-wired | chat-repository.streamTurn never sends `tools`/`toolChoice` even though ChatSendReq validates both, so cards can only be fed by the agent path; and ToolCallList's `results`/`running` props have no production caller — MessageTurn.tsx:74 passes only outcomes and progress. |
| The memory block rides on every turn (plain and agent) | **UNVERIFIED** | test unproven | reaches-user | Twice on an unmutated tree under load, 'leads the run's input with the remembered facts' failed with role 'user' where 'system' was expected — the memory block absent — and I could not reproduce it in 12 isolated re-runs. |
| Compose & send a turn (composer → chat_send payload) | **PASS** | test bites | reaches-user | Mutating historyMessages to fold reasoning into the assistant text reddened both 'sends the prior turns, and never sends reasoning back' and 'reports exactly the messages chat_send will carry'; ConversationSurface is mounted at src/app/App.tsx:164. |
| Composer keyboard contract (Enter, Shift+Enter, IME) | **PASS** | test unproven | reaches-user | Composer.tsx checks nativeEvent.isComposing AND keyCode===229 before sending, and 13 tests cover it, but I mutated only the Escape branch. |
| Cancel: Escape and the Stop button reach the host | **PASS** | test bites | reaches-user | Adding an early return to `stop` in use-conversation.ts:849 reddened both 'cancels on Escape…' and 'cancels from the Stop button too'; chat_cancel is a registered #[tauri::command]. |
| Cancelling reads as "you stopped this", not as a failure | **PASS** | test bites | reaches-user | Forcing turn-stream.ts:186 to phase:'failed' reddened the reducer test and the surface test; a cancelled turn renders a 'Stopped' chip with role undefined rather than role=alert. |
| Streaming: first token committed synchronously, later frames coalesced per frame | **PASS** | test bites | reaches-user | Removing `isFirst() \|\|` from onEvent reddened exactly one test, 'commits the first token immediately and batches the rest' — the header's time-to-first-token claim is backed, though the ~16ms figure itself is not measured. |
| Reasoning kept out of the answer channel (renderer-side guard) | **PASS** | test bites | reaches-user | Making guardDelta a pass-through reddened 13 tests across reasoning-guard, turn-stream and the rendered surface, including the split-across-frames and unterminated-block cases. |
| Reasoning is never replayed back to the endpoint | **PASS** | test bites | reaches-user | historyMessages excludes turn.reasoning and drops reasoning-only turns entirely; the context meter reads the same traversal, so both went red together under mutation. |
| Markdown: model text is rendered, never built into HTML | **PASS** | test bites | reaches-user | Replacing the text span with dangerouslySetInnerHTML reddened 7 tests; the guard is behavioural (renders `<img src=x onerror=…>` and asserts no img role), not just a source scan. |
| Rendered errors carry no endpoint-authored text | **PASS** | test bites | reaches-user | Rewriting causeSentence to interpolate diagnosis.cause reddened 3 notices tests; Rust side confirmed — diagnostic.rs:811 Diagnosis is {Cause enum, Option<u16>, EndpointIdentity, FilterVerdict, CorrelationId} with no free-text field. |
| The error surface is still actionable (title, Vela's sentence, endpoint, trace, retry) | **PASS** | test bites | reaches-user | Probe rendering the real AssistantTurn for an unreachable endpoint produced "Could not reach the endpoint / Vela could not open a connection. / http://127.0.0.1:8033/v1"; the trace id shows only while recording, and DebugLogSwitch is mounted at EndpointsPanel.tsx:138. |
| A turn the host refused is drawn as Vela's own fault, not the endpoint's | **PASS** | test bites | reaches-user | Deleting the refusal block from MessageTurn reddened 'reports a turn the host refused as Vela's own fault'; NOT_FOUND is specially reworded, other IpcError messages render verbatim but are Vela-authored. |
| Retry of the last turn: no duplicate message, store rows replaced | **PASS** | test bites | reaches-user | Two mutations — retry appending instead of slicing, and dropping transcript.remove — each reddened its own named test ('…without duplicating it', '…instead of recording it twice'). |
| Transcript restore: no double-write, no spinner that cannot resolve | **PASS** | test bites | reaches-user | Dropping claimed.current.add in the restore loop reddened 'does not write the transcript it just read back'; making phaseOf return 'streaming' reddened 'never comes back with a spinner that cannot resolve'. |
| An unreadable transcript says so and blocks sending | **PASS** | test bites | reaches-user | Flipping setUnreadable(true) to false reddened 'says the transcript is unreadable rather than showing it as empty'; the composer's placeholder carries the reason and the box is disabled. |
| Empty state names the model's capabilities from the struct alone | **PASS** | test unproven | reaches-user | EmptyConversation reads ChatCapabilities, shows absence as well as presence, suggests no prompts, and never names a backend; three tests cover it and I did not mutate them. |
| Degradation notices: wording, totality, and reachability | **PASS** | test unproven | reaches-user | describeDegradation is total over the union so a new variant fails typecheck, and 'never names a backend' is tested — but toolCallingEmulated, toolCatalogueWithheld and both structuredOutput arms cannot occur on the plain chat path at all. |
| Agent path: failure sentences vs failure rendering | **PASS** | test bites | reaches-user | Deleting the whole refusal box left all 15 agent-run tests green — they assert turn.refusal on the hook, never the DOM; the agent path's rendering rides entirely on one plain-path test. |
| Scroll: follow the stream only while pinned to the bottom | **PASS** | test unproven | reaches-user | scroll.ts is pure with 10 tests including the measured 1280x672 display-scaling geometry, but the ConversationView plumbing (ResizeObserver, passive listener, layout-effect scrollTo) is unverifiable in jsdom and the file says so. |

**Could not establish:**

- Whether the intermittent 'memory block missing from a run's input' failure is a flaky test or a real race in useConversation. The read is an async effect (memory.list → setRemembered → memoryRef.current) and start/startRun read memoryRef.current, so a send that beats the read would go out without memory and say nothing — but I saw the failure only twice under machine contention and could not reproduce it in 12 isolated runs (3x file alone, 3x three-file combo, 6x single test under -t).
- Whether that same contention explains a second observation: with one mutation applied, all 15 agent-run tests failed in a three-file parallel run and only 1 failed when the same file ran alone. I did not isolate the mechanism, so 'the conversation suite is green' is a weaker statement in this domain than 239/239 implies.
- Nothing in this domain was exercised against a real window or a real endpoint — I was not the auditor authorised to launch the app, and I did not query the llama.cpp server on 8033. Every rendering claim above is jsdom (VERIFIED-BY-FAKE in this repo's vocabulary), including the three FAIL findings.
- Whether a real llama.cpp or OpenAI-compatible endpoint in practice ever emits a clean zero-token stream. I proved the renderer draws nothing for one and that the Rust adapters do not classify it as an error, but I did not produce one from a live endpoint.
- The ~16ms time-to-first-token saving the batching design claims. I proved the mechanism (the synchronous first commit) is real and guarded; I did not measure the latency.
- IME composition behaviour in the real Tauri webview. Composer.tsx handles both isComposing and keyCode 229, and jsdom tests cover the synthetic events, but the actual webview's event sequence for a Japanese/Chinese/Korean candidate accept was not observed.
- CopyButton against a real clipboard. Tested through a stubbed navigator.clipboard only.
- Whether the transcript's aria-live=polite / role=log region behaves acceptably with a screen reader during a fast stream — a per-token live region can be unusable, and jsdom cannot tell me.
- The agent path's cancel semantics (stop() preferring RunHandle.cancel over the turn handle). Read and reasoned about; I did not build a live run and cancel it.
- Whether the documented write-on-settle gap matters in practice: an ordinary turn interrupted by a window close is never written to the store, while an agent turn's question is. The code says so explicitly; I did not test an interrupted turn.

## Desktop shell, layout and visual design (src/app, src/features/navigation, src/components, src/styles)

> I drove the real WebView2 window over CDP and the shell held on every claim I could test: the caption buttons resize real glass, the double-click gesture fires exactly once, focus containment holds for 48 real Tab presses in a one-stop dialog, the bundled Inter genuinely paints, and prose measures 68.1 characters per line. Two real gaps: after the first conversation is opened nothing in the application returns you to the home surface (`select(null)` has exactly one caller — the delete path), and there is no `forced-colors` handling anywhere in `src/`, so under Windows High Contrast the selected conversation loses its only visual cue.

| aspect | verdict | evidence | shipped | finding |
|---|---|---|---|---|
| Returning to the home / empty-state surface | **FAIL** | hardware | reaches-user | Once any conversation is open, nothing returns to HomeSurface. I enumerated all 54 interactive elements in the assembled window: no Home/Back/Vela control; the wordmark and mark are non-clickable <span>s; Escape in main does nothing; the palette's only action is 'New conversation'. select(null) has exactly one caller — use-conversations.ts:160, the delete path — which I confirmed live. The only in-session route back is deleting the conversation you are reading. |
| Windows High Contrast (forced-colors) | **FAIL** | hardware | reaches-user | Zero forced-colors or -ms-high-contrast rules anywhere in src/. Under forced-colors:active the app stays usable, but the selected conversation is distinguished only by background and colour (ConversationRow.module.css:12-15, 38-40) and both are stripped, leaving no border, weight or marker. aria-current='page' is present so AT is told; a sighted High Contrast user is not. No test exercises forced-colors. |
| Window controls drive the real OS window | **PASS** | hardware | reaches-user | Clicking Maximise took the real window 1180x780 -> 2560x1392 (the work area) and Restore took it back; the icon and aria-label flipped Maximise/Restore from what the window reported, not from the click. Minimise and Close were deliberately not pressed. |
| Double-click on the drag region maximises exactly once | **PASS** | test bites | reaches-user | Real mousePressed clickCount 1 then 2 on [data-tauri-drag-region] produced one toggle (1180x780 -> 2560x1392); a second toggle from Tauri's own listener would have returned it. Removing event.stopPropagation() in TitleBar.tsx:113 fails exactly one test — 'keeps the double-click gesture away from the framework'. |
| Capability grant matches the window commands the bar calls | **PASS** | test bites | reaches-user | Removing core:window:allow-is-maximized and adding core:window:allow-internal-toggle-maximize from src-tauri/capabilities/main.json each fail their own assertion in window-controls.test.tsx. Reverted clean. |
| Title bar tab order and the Close button | **PASS** | hardware | reaches-user | Real Tab walk gives Theme, Minimise, Maximise, Close — Close last within the bar, as window-controls.test.tsx:287 asserts. The prose at TitleBar.tsx:26 saying 'nothing tabs through it on the way somewhere else' is bar-scoped: the bar is the first landmark, so a forward Tab does pass over Close en route to the sidebar. |
| Theme preference applied and persisted to the host | **PASS** | hardware | reaches-user | Clicking the title-bar button and then asking the Rust host: settings_get returned {theme:'dark'} then {theme:'light'}. The load half is proven too — first paint was dark on an OS set to light, and a full page reload came back dark from a fresh adapter. |
| color-scheme follows the app's theme, not the OS | **PASS** | hardware | reaches-user | Measured in all three states on a light-preference OS: dark/dark, system/light, light/light. This is what stops Windows painting a white legacy scrollbar down a dark app. |
| Vela draws its own scrollbar in WebView2 | **PASS** | test bites | reaches-user | Synthetic scroller gutter measured 12px (=--vela-scrollbar-size; the Windows classic widget is 17). x8 clips of both ends show a night-400 pill thumb and zero arrow buttons. The transcript scroller reserves 24px, exactly --vela-scroll-reserve. Adding `scrollbar-width: thin` to base.css fails platform-defaults.test.ts:265. |
| The bundled typeface actually paints | **PASS** | hardware | reaches-user | Advance-width against an absent family, never document.fonts.check(): Inter Variable 1467.00 vs control 1353.28 vs Segoe UI 1382.77; JetBrains Mono 1740.00 vs Consolas 1594.44. Repeated identically after loading the production dist/ bytes into the same WebView2, with both .woff2 files fetched and 'loaded'. |
| The reading measure is a measure, on WebView2 | **PASS** | test bites | reaches-user | Real assistant prose: 480px column at 68.1 and 68.0 chars/line at 1180px; 528px at 74.9 chars/line with the window really maximised to 2560. User turns cap narrower at 382px/53.1. Restoring --vela-measure to the pre-fix 46rem fails surfaces.test.ts. |
| Contrast clears AA in both themes | **PASS** | test bites | reaches-user | Live computed ratios: status line 5.69 dark / 5.26 light at 12px; hero lede 7.74; wordmark 16.03. Reverting --vela-text-subtle to night-400 in both dark blocks produces 12 named failures with resolved var() graphs and translucent rows composited over their grounds (3.34, 3.60, 3.74, 4.49 vs 4.5). |
| Command palette: open, filter, host search, activate, dismiss | **PASS** | hardware | reaches-user | Ctrl+K gives role=dialog, aria-modal, focus on the combobox, aria-activedescendant tracking. Typing 'kitchen' narrowed locally AND returned host hits labelled 'In message'/'In thinking'. Ctrl+P and Ctrl+F open the same bar in different modes (different aria-labels). |
| Modal focus containment and focus restore | **PASS** | test bites | reaches-user | The palette has exactly one tab stop, so containment does all the work: 24 forward and 24 backward real Tab presses all stayed inside; the alertdialog held 8. Escape returned focus to the opener button, never <body>. Disabling containTab in ModalSurface.tsx:181 fails 11 tests. This settles the open question in that file's header, which said a driven WebView2 window was unavailable. |
| Delete-conversation dialog | **PASS** | hardware | reaches-user | role=alertdialog, aria-modal, aria-labelledby + aria-describedby, initial focus on Cancel (not Delete), Escape cancels and the row survives. The destructive path was exercised once on a conversation I created myself and removed exactly that row. |
| Sidebar resize separator and its clamp | **PASS** | hardware | reaches-user | role=separator, tabIndex 0, aria-label 'Resize sidebar', live aria-valuenow. Keyboard-driven: clamped at 480 going right and 200 going left, and writes --vela-sidebar-width per element. The pointer-drag path was not tested. |
| Sidebar collapse to the rail | **PASS** | hardware | reaches-user | Toggle takes nav 480 -> 56 (= --vela-rail-width) -> 480, the button label flips Collapse/Expand, and the content region's x really moves with it. Ctrl+B does the same. |
| Roving tabindex in the conversation list | **PASS** | hardware | reaches-user | Ten rows, exactly one with tabIndex 0 at rest; after two real ArrowDown presses the single stop had moved to index 2 with focus. Per-row Rename/Delete stay tabindex=-1 (F2/Delete only), which is the documented design but is nowhere advertised on screen. |
| Global keyboard shortcuts | **PASS** | hardware | reaches-user | All five fired as real key events: Ctrl+K and Ctrl+P open the switcher, Ctrl+F opens search, Ctrl+B collapses/expands, Ctrl+N created a conversation (10 -> 11) and selected it. I deleted the one I created; the store is as I found it. |
| Focus ring and base.css element defaults at runtime | **PASS** | hardware | reaches-user | A focused control draws 2px solid rgb(13,133,127) at offset 2px — exactly --vela-focus-width/--vela-focus. user-select is none on body, title bar, sidebar rows and status bar, and 'text' on transcript prose and code blocks. Under prefers-reduced-motion transitions collapse from 0s/animated to 1e-05s. |
| Type scale: every rendered size is a token | **PASS** | hardware | reaches-user | Tallied computed font-size/weight over every text leaf: 12, 13, 15, 16, 18, 24px map to xs/sm/base/md/lg/xl at a 16px root; the only others are 11.7 and 10.8, which are --vela-text-inline (0.9em) against 13 and 12. Weights are exactly the four declared steps. |
| Status bar honesty readout | **PASS** | hardware | reaches-user | 'Bridge ready · os-keychain' / 'Offline · no telemetry' at 28px = --vela-statusbar-height. 'os-keychain' is the value settings_get really returned from the Rust host, not a literal; the dot is --vela-success and is aria-hidden with the state also in text. |
| Design-token drift guard (design-system.test.ts) | **PASS** | test unproven | n/a | Scans every *.module.css for raw colour, bare line-height/letter-spacing/z-index/font-size, hand-rolled shadows and non-token font stacks, and closes with a self-test asserting each regex fires on the bad shape and not the tokenised one. I read that self-test but did not plant a raw hex in a component sheet and watch it fail. |

**Could not establish:**

- Minimise and Close were never pressed on real hardware — one hides the window under audit with no in-app way back, the other ends it. Their wiring shares a seam with Maximise, which I did prove, and window-controls.test.tsx covers both against a fake window.
- Every interaction verdict is against the DEV bundle. The debug binary embeds devUrl, so it loaded http://localhost:1420 from a vite server rooted in this worktree (verified via Win32_Process CommandLine) with React in development mode. I separately served dist/ into the same WebView2 and confirmed the production bytes give identical typeface advance widths, 12px scrollbar gutter, 480px measure and a mounted tree — but could not interact with them, because Tauri IPC is origin-bound and the conversations call returned INTERNAL at the foreign origin, dropping the bundle to its in-memory adapter.
- The release binary was never built or run; disk was at 15 GB shared across eleven agents. Nothing here speaks for the shipped installer.
- 150% display scaling was emulated with deviceScaleFactor 1.5, not by changing real OS DPI. Chrome geometry stayed intact (header 0/40, footer bottom 780, main 712) but the probe reported elements above the viewport top, which I could not separate from ordinary scrolled-out content inside a scroller. Verdict withheld.
- The pointer-drag sidebar resize path was not driven — only the keyboard separator. Pointer capture and the 250ms settle-then-write are untested by me.
- Inline rename (F2) and the row action buttons' discoverability were not tested.
- The command palette's failure paths — a host search error and the 'no conversation or message matches' footnote — were not exercised, because forcing a host search failure would have disturbed other agents.
- Theme survival across a full process relaunch was not tested. I proved the host store round-trip (settings_get) and survival across a full page reload with a fresh adapter, which is strong but is not a cold start.
- design-system.test.ts was not mutation-tested against a real component stylesheet; its own self-test of the regexes is why I graded it PASS rather than UNVERIFIED.
- CONTAMINATION I CAUSED AND REPAIRED: at ~13:33 another agent ran `pnpm build` during the ~40s window in which my --vela-text-subtle mutation was live, baking night-400 into dist/. I could not rebuild (another agent's tsc error blocked it) so I restored dist/ byte-for-byte from a clean pre-mutation copy and verified the token, the measure and the absence of scrollbar-width. dist/ is correct now, but any measurement another auditor took from dist/ between roughly 13:33 and 13:41 should be re-taken. All six of my source mutations were reverted and each confirmed clean with git status --porcelain.

## Documentation honesty and claim integrity

> The enforcement claims are real — five doc-named guards were broken and watched fail, and the three frozen contracts' prose is the most honest writing in the repo (one hard number verified exact at its authorship commit; amendment blocks that catch their own failed sweeps). The failure is currency: `docs/vela-progress.md` and `docs/architecture/conventions.md` are 33 commits / 43,253 insertions behind, and the narrative's final section still states in present tense that the contracts are unwired and untested.

| aspect | verdict | evidence | shipped | finding |
|---|---|---|---|---|
| vela-progress.md currency | **FAIL** | hardware | n/a | Last written at c05a3c9 (2026-08-14). Since then: 33 commits, 166 files, 43,253 insertions; the only doc touched is desktop-gate/VERDICTS.md. Wave I (sandbox, MCP, projects, skills, scheduler, memory, endpoint, agentic runtime, 6 crates, 13 IPC modules) has zero coverage — grep for WSL/vela-sandbox/vela-mcp/vela-endpoint returns one unrelated substring hit. |
| Wave H section's present-tense claims | **FAIL** | hardware | n/a | vela-progress.md:2948 "Nothing below is wired… none of their command names are on COMMAND_ALLOWLIST" — contract.ts:1584-1597 and 1650-1663 carry all fourteen. :3143 "no test asserts a single behavioural rule in any of the three files" — fa5f3c5 added 2,985 lines of them. :2956-2960 "Enforced by: tsc only" ×3, and :3161 "all three versions read 2" (all read 3). It is the last section, so nothing supersedes it; claimed-guards cannot see a sentence with no backticked token in it. |
| vela-progress.md front matter and supersession rule | **FAIL** | hardware | n/a | Lines 9-36 still read `RUN STATUS: RUNNING`, ledger row `C–H … not started`, and `B … GATE FAIL r4: 471 assertions, 8 failures` (superseded by phase-b2-matrix's 1455/0). The "later sections supersede earlier ones" convention exists only in HANDOVER.md §5 — grep for append-only/later sections/reverse chronolog in the file itself returns nothing. |
| conventions §1 folder layout | **FAIL** | hardware | n/a | Diagram lists 4 crates and 5 ipc modules; the tree has 10 and 18. Not merely stale — it contradicts the prescriptive table eleven lines below in the same section, which routes persistence to `vela-store`, a crate the diagram omits. The doc is "binding for all Phase A–H work" and HANDOVER §5 calls it "Authoritative and current". Inside a code fence, so claimed-guards excludes it as illustration. |
| conventions §10/§11 environment claims | **FAIL** | hardware | n/a | "This repo is built and verified on a headless Linux container" and "no claim about the running application … may be made from this environment; 'It compiles' is the strongest honest statement available here". HEAD adds a windows-latest job running pnpm test + cargo test --workspace --locked + check-transcripts.sh, the repo is graded on a Windows machine, and VERDICTS.md TRACK 10 records real llama.cpp turns in a live WebView2 window. The labelling rule is right; the scoping sentence around it has gone false. |
| docs/desktop-gate/REQUESTS.md staleness marking | **FAIL** | read only | n/a | HANDOVER §5 warns its status blocks describe waves a container reset destroyed and says to trust VERDICTS.md over it. That warning is nowhere in REQUESTS.md, which still opens with a live two-session protocol ("This file is written by the CLOUD session", "The cloud session is a headless Linux container … which is why you exist") that ended 2026-08-14. |
| regression-baseline staleness banners | **FAIL** | read only | n/a | phase-b-matrix/README.md, phase-b2-matrix/RESULTS.md and phase-c-matrix/RESULTS.md all carry explicit in-file supersession banners. platform-defaults-executor/RESULTS.md opens "Verdict: FAIL" for a ruler regression HANDOVER §5 says is fixed and independently confirmed on WebView2, and 471 lines contain no such marker. Three siblings corrected, the one HANDOVER names as most misleading not. |
| claimed-guards bites on a live doc | **PASS** | test bites | reaches-user | Appended two fabricated claims to docs/vela-progress.md; claimed-guards.test.ts reported both at the right line (`a_guard_the_auditor_invented`, `src/platform/no-such-audit-file.test.ts`), 2 failed / 7 passed. Reverted, tree clean. Runs under `pnpm test` on both the Linux and Windows CI jobs. |
| conventions §4 — only tauri-adapter.ts may import @tauri-apps/api | **PASS** | test bites | reaches-user | Added src/lib/zz-audit-probe.ts importing @tauri-apps/api/core; adapter.test.ts failed naming `lib/zz-audit-probe.ts`. File removed. |
| conventions §7 — design-system.test.ts on raw colours and undefined tokens | **PASS** | test bites | reaches-user | Added a module.css with `#ff00ff` and `var(--vela-not-a-real-token)`; both halves of the sentence fired, including the interesting one ("an undefined custom property fails silently, which is the worst way"). File removed. |
| conventions §8 — verify is a superset of CI, in either direction | **PASS** | test bites | reaches-user | Appended `- run: pnpm audit:probe --strict` to ci.yml; verify-covers-ci.test.ts failed on the unaccounted step. Restored from a byte copy, not git checkout, so a concurrent writer could not be clobbered. The prefix hole HANDOVER §3.7 filed is closed too: the matcher is now /pnpm (?:run )?test(?![\w:-])/. |
| contract-harness.ts's named guard (no-harness-leak.test.ts) | **PASS** | test bites | reaches-user | The comment claims it takes ids from the registry and fails anywhere in shipping src/. Added src/features/zz-audit-probe.ts with `harnessId === 'agent-loop'`; both the literal rule and the comparison rule fired, in a file outside src/runtime/. Accurate to the word. File removed. |
| The three frozen contracts' honesty notes | **PASS** | read only | n/a | contract-sandbox.ts:62-90 and contract-project.ts:10-32 both name what they used to say ("They said the opposite until 2026-08-15") and enumerate the unbuilt surface by name — document commands, python, both copy materialisations, every non-`denied` network policy, four RefusalReason members no host emits. Matches what this session established independently. |
| The one hard number in the sandbox contract's honesty note | **PASS** | hardware | n/a | "the vela-sandbox crate carries 47 tests" reads stale against today's 65. `git log -S` located the authoring commit 201f979; counting #[test]/#[tokio::test] at that tree gives 28+3+3+6+7 = exactly 47. Counted, not gestured, and it drifted in the under-claiming direction. |
| Amendment-block discipline (a sweep claimed but not done) | **PASS** | read only | n/a | contract-project.ts AMENDMENT 7 records that AMENDMENT 5's claimed sweep had NOT been done and names the four sentences left standing, coining the third shape — a guard *denied* that exists. AMENDMENT 8 then corrects 7's own overstatement ("every removal in that crate goes through it" — six do not). I checked 8: casefold.rs has exactly four non-test removals (51,52,58,62, all inside CaseFolding::probe on a path it created); link.rs's are the remove_dir/remove_file pair in unlink. |
| conventions §3.4 least privilege | **PASS** | read only | n/a | capabilities/main.json grants exactly core:event:default plus five window permissions — no fs, shell, http, process or dialog, precisely as claimed. Notable: six subsystems landed since the sentence was written without widening it. |
| conventions §8 shared parity fixtures, both languages | **PASS** | read only | n/a | All three fixtures have readers on both sides: adapter-parity.json (adapter-parity.test.ts:95 / adapter_parity_fixture.rs), navigation.json, security-posture.json (security-posture-parity.test.ts:54 / vela-settings/tests/security_posture_parity.rs). Rust half not run — see unverified. |
| conventions §0 rule 4, §2 TODOs, §9 sole HTTP client | **PASS** | read only | n/a | secrets_get: #[test] no_command_returns_secret_material at ipc/mod.rs:222-230, mirrored at contract.test.ts:86. TODOs: exactly one under src/ and src-tauri/, carrying `(phase-D, providers)`. HTTP client: reqwest appears in one Cargo.toml; vela-endpoint declares no server crate and names capability_matrix_endpoints.rs, which does walk every Cargo.toml (lines 339/360) against reqwest/hyper/ureq/isahc (164-167). |
| docs/references/ external accuracy | **PASS** | hardware | n/a | Fetched three primary sources. Unsloth issue #4818: title, state, created_at, closed_at, closed_by, state_reason — six for six verbatim. mindsdb/cowork-server base.py: one abstract method stream_response, four attributes, three module functions, no sync_skills/recall_memory — exactly as claimed, and this is the fact contract-harness.ts's one-method seam rests on. harnesses/memory/: all six named files present. One drift: study says 87 lines, fetch reports 78 (post-conversion; not load-bearing). |
| UNVERIFIED markers, and their re-transmission downstream | **PASS** | hardware | n/a | The studies mark uncertainty at clause level and list what they could not confirm. More importantly the consumers carry it forward rather than laundering it: contract-harness.ts:24-44 reproduces "the straightforward reading", the six-filename count and the explicit UNVERIFIED, then designs so the inferred half cannot matter; contract-sandbox.ts calls the PR #4827 read "the study's secondary read of the fix", which is how the study labels it. Verified against mindshub-cowork.md:146-148 and [^17]. |
| ci.yml's head comments (the newest prose in the repo) | **PASS** | read only | n/a | Checked the specific, falsifiable ones: sandbox_boundary.rs:162 carries the literal "SKIPPED: no WSL distribution on this machine"; .gitattributes exists and names anthropic_fixture_replay / google_fixture_replay, both of which exist as integration-test files under vela-providers/tests/. The CRLF and path-split defects it describes were established by this session on hardware. |
| docs/HANDOVER.md | **PASS** | read only | n/a | Dates itself precisely ("HEAD … both bf10d98 at the time of writing", "Written at the point of retirement") and never claims currency, which is the honest form for a snapshot. Its §3 items 6/7 and 9-15 are closed and §6's "CI has never run" is superseded — normal for a roadmap. Its §6 line "Everything except the desktop verdicts is VERIFIED-BY-FAKE" is still true and is now harder to find because conventions §10 has gone stale around it. |

**Could not establish:**

- The Rust half of every cross-language claim. src-tauri/target is 34 GB against ~14 GB free shared by eleven agents, so I ran no cargo command at all — not even `-- --list`, which still compiles. no_command_returns_secret_material, handler_binding.rs, the three *_parity_fixture.rs readers and capability_matrix_endpoints.rs are all inspection-only: I read the assertion, I did not watch it fail. The lead's figure says they pass; it does not say they bite.
- The other 57 of the 58 contract behavioural rules. Taken as given from this session's record; I proved one (no-harness-leak) by mutation and inferred nothing about the rest.
- The bulk of docs/references/. I fetched 3 of 33 cited sources. What I graded is the studies' self-labelling discipline and its re-transmission into the contracts, both of which are good. Coverage of the remaining thirty citations — marketing pages, DeepWiki reads, PR threads, several self-labelled as secondary automated reads — is sampled, not audited.
- Whether docs/spec-parts/ (8,600 lines) and docs/vela-feature-spec.md (10,117 lines) accurately describe the Anthropic products they specify. Deliberately outside claimed-guards' scope and outside my sampling; I confirmed only that the '178 catalogued features' total is arithmetic that adds up (vela-feature-spec.md:337).
- Whether the wave-I documentation gap is a decision or an omission. No file says the narrative stops at wave H, no note retires vela-progress.md, and HANDOVER §5 still calls it the running narrative — so I graded it an omission. If it was retired deliberately, one line at the top of the file turns three of my FAILs into a nit.
- Whether the doc-comment corpus outside the three contracts holds. I grepped src/ and src-tauri/ for comments claiming enforcement in mechanism form (rather than by naming a test) and found the pattern almost absent — this repo names its guards, which is why claimed-guards works as well as it does. That is a sampling result, not a proof.
- One contaminated measurement, disclosed so it is never cited: a double-quoted grep pattern of mine expanded backticked `pnpm test` and ran the full suite, reporting 5 TS failures. At that moment `git status` showed src/features/conversation/turn-stream.ts and src/runtime/project-context.ts modified by another auditor. Not a baseline, not a finding.
- Procedural: docs/desktop-gate/OWNERSHIP.md rule 2 says a critic that mutates gets its own worktree. My brief instructed mutate-and-revert in the shared tree and I complied. Four of five probes added an untracked file rather than editing a tracked one; the fifth restored ci.yml from a byte copy rather than `git checkout --`. Every touched path was clean afterwards, but a full-suite reading taken by another agent during my five vitest windows would be contaminated.

## Guards, contracts and the verification apparatus

> The core guards are real: I broke ten of them and watched each one fail, on Windows, including the CRLF parity repair, the allowlist-to-assembled-app binding, the secret tripwire and the `.gitattributes` wire-capture protection. Three things do not hold — `pnpm verify` cannot execute on Windows at all (it dies at `./scripts/…sh` under cmd.exe, so four of nine gates including both cargo gates never run), `verify-covers-ci.test.ts` is blind to any gate written inside a `run: \|` block, and `contract.test.ts`'s advertised "runtime exhaustiveness" over `IpcContract` is not checked by it (a phantom command passes all 1187 platform tests; only `tsc` catches it).

| aspect | verdict | evidence | shipped | finding |
|---|---|---|---|---|
| verify-covers-ci: gates written inside a `run: \|` block | **FAIL** | test bites | reaches-user | Adding a multi-line block containing `pnpm brand-new-gate` to test-windows left the accounting test GREEN. The regex at verify-covers-ci.test.ts:89 captures `\|` for a block header and filters it, and never reads the body — so the `sudo apt-get` exemption on line 96 is dead code and any new gate in block form escapes. The workflow already uses that form. |
| `pnpm verify` is runnable on Windows, the platform Vela ships on | **FAIL** | hardware | not-wired | `pnpm run test:transcripts` and `pnpm run test:secrets` both die with "'.' is not recognized as an internal or external command" — pnpm runs scripts via cmd.exe and .npmrc sets no script-shell. verify is typecheck && lint:rust && test && test:harness && build && test:transcripts && test:secrets && cargo build && cargo test, so it stops at step 6 of 9 and neither cargo gate runs. ci.yml sets `shell: bash` for the same script; package.json has no equivalent. |
| contract.test.ts: the claimed runtime exhaustiveness of IpcContract vs COMMAND_ALLOWLIST | **FAIL** | test bites | reaches-user | Adding `zz_audit_probe` to IpcContract in contract.ts and to nothing else passes all 24 platform test files / 1187 tests, including contract.test.ts and the 80-case adapter-parity. `(keyof IpcContract)[]` types a hand-written list, it does not make it exhaustive. The invariant does hold — `tsc` catches it at browser-adapter.ts:909 with 'not assignable to type never' — but two comments (contract.ts:1692-1697 and contract.test.ts:12-14) name a mechanism that does not do the job. |
| ci.yml's claim that check-transcripts detects a lost .gitattributes | **FAIL** | hardware | reaches-user | ci.yml:231-237 says running check-transcripts.sh on Windows 'is how we find out if that protection ever stops working'. Measured in a throwaway repo: with the attribute removed, a CRLF checkout regenerated as LF gives `git diff --quiet` CLEAN, because autocrlf normalises on read. It catches only the other case — a rewrite while `-text` is still in force. Also, the file's own comment claims the two patterns cover the regression-baseline transcripts; the mock-matrix .txt/.json ones are not covered (measured CR=7 and CR=8), though nothing reads those byte-exactly. |
| check-transcripts.sh as a determinism gate | **UNVERIFIED** | read only | reaches-user | Not run: it executes record-transcripts.ts, which writes into docs/regression-baseline/mock-matrix/, and ten other auditors are editing this worktree — a non-deterministic regeneration would leave tracked files dirty that are not mine to revert. Wired into ci.yml (twice, incl. Windows with shell: bash) and into `pnpm verify` via test:transcripts, which cannot run on Windows. |
| claimed-guards: Rust intra-doc link claims | **PASS** | test bites | reaches-user | Planted `[`a_guard_this_audit_invented`]` in an untracked, uncompiled src-tauri/src/*.rs; `names only Rust items that exist` reported it by file:line. Probe deleted, tree confirmed clean. |
| claimed-guards: file-path claims | **PASS** | test bites | reaches-user | Planted paths in both a .rs and a .md probe; both reported. The directory-vs-basename repair is pinned by an in-file control that also still passes (src/platform/claimed-guards.test.ts:755). |
| claimed-guards: named-test claims | **PASS** | test bites | reaches-user | Three fabricated sentence-names reported across two probe files; the real `every_variant_is_listed_in_all` in the same corpus correctly resolved and was not reported. |
| claimed-guards: the codeVocabulary retreat did not lose coverage | **PASS** | test bites | reaches-user | Battery of 15 plausible fake guard names: 12 reported, and the 3 that resolved (`to_owned`, `handler_binding`, `contract_version`) are genuinely real. Deleting a resolution route can only tighten the guard; the widened rustItems()/wire-token corpora do not swallow test-shaped names — even `read_to_string` and `from_str` are reported. |
| claimed-guards: anti-vacuity controls and scan scope | **PASS** | hardware | reaches-user | All six `this guard is not vacuous` controls pass while the three real assertions fail under my probes, so the corpora are live. Gap worth closing: SCANNED_EXTENSIONS omits .ps1/.sql/.json/.py/.html, so scripts/gate-m-debug-log-acl.ps1 and its 13 backticked tokens are never checked — I resolved all 13 by hand and all exist today, so no live false claim. |
| chat-contract-parity: Rust->TS direction and the CRLF repair | **PASS** | test bites | reaches-user | Reverting `split(/\r?\n/)` to `split('\n')` at chat-contract-parity.test.ts:381 reproduces the historical Windows defect exactly: 30 of 33 cases throw `unterminated <Item> in model.rs`. Mutation reverted. |
| chat-contract-parity: TS->Rust direction via everyVariantOf + tsc | **PASS** | test bites | reaches-user | Removing 'reasoning' from CONTENT_PART makes `pnpm exec tsc --build --force` emit TS2322 naming the missing variant. Both halves of 'there is no order in which a one-sided change is green' are real. |
| no-provider-leak: the vendor-name scan | **PASS** | test bites | reaches-user | Planting `--vela-ollama-accent` in an untracked src/styles/*.css failed two independent tests (`never appears in shipping renderer source`, `no design token is named after a backend`) while the other 16 stayed green. |
| no-provider-leak: the Windows path-separator repair (basename vs split('/')) | **PASS** | hardware | reaches-user | The carrier exemption is asserted in both directions at lines 246-253; if CARRIERS matched nothing — the pre-fix state — `carriers` is [] and that assertion fails. It passes on this Windows checkout, which is the direct proof the repair holds. |
| verify-covers-ci: each listed CI gate is reachable from `pnpm verify` | **PASS** | test bites | reaches-user | Adding `- run: pnpm brand-new-gate` to ci.yml fails `every gate command in the workflow is accounted for above` with the new command named. All 11 CI_GATES entries also assert their own presence in ci.yml, so the list cannot silently go stale. |
| verify-covers-ci: the new per-runner cargo dependency check | **PASS** | test bites | reaches-user | All three branches fire: apt-get added to test-windows -> 'runs on windows-latest and installs Linux packages'; runs-on freebsd-14 -> 'which this guard cannot reason about'; libwebkit2gtk-4.1-dev removed -> 'never installs the Tauri system dependencies' on `static`. ci.yml reverted. |
| ipc::tests::rust_and_typescript_allowlists_are_identical | **PASS** | test bites | reaches-user | Renaming one entry in contract.ts's COMMAND_ALLOWLIST failed the test with the drifted set printed. It reads contract.ts at runtime via fs::read_to_string, and `.trim()` makes it CRLF-safe. Four-way cross-check with no mutation: Rust 55 == TS 55 == IpcContract keys 55 == contract.test.ts list 55. |
| handler_binding.rs: the allowlist bound to the real invoke_handler | **PASS** | hardware | reaches-user | Ran the prebuilt binary directly on this Windows box: 10 passed, 0 failed, no STATUS_ENTRYPOINT_NOT_FOUND — so build.rs's `rustc-link-arg-tests` manifest fix works. The anti-vacuity control `the_probe_can_tell_a_registered_command_from_an_unregistered_one` passes, which is what makes the other nine mean anything. |
| gate_m_assembled_app.rs: commands driven through the assembled app | **PASS** | hardware | reaches-user | Prebuilt binary run directly: 15 passed, 1 ignored (an evidence driver gated on VELA_GATE_DEBUG_LOG_HOME), 0 failed. Includes `a_command_outside_the_allowlist_is_not_dispatchable` and `a_remote_origin_cannot_reach_a_command`. Loads on Windows; the manifest defect is closed. |
| scripts/secret-scan.sh and its self-test | **PASS** | hardware | reaches-user | `./scripts/secret-scan.test.sh` -> 12 passed, 0 failed. It plants real key shapes in throwaway git repos and proves each is caught, including under docs/, plus three no-false-positive cases, plus scanning the real tree and its own scanner. excluded_paths=() is empty and the no-glob rule is enforced. Runs in CI; on Windows it is unreachable from `pnpm verify` (see the verify row). |
| .gitattributes: `-text` on the wire captures | **PASS** | test bites | reaches-user | Measured on disk: every .sse and .jsonl has CR=0 while .rs/.ts source is CRLF, and a throwaway repo with core.autocrlf=true gives CR=6 without the attribute and CR=0 with it. CRLF-ifying the seven anthropic fixtures fails 3 replay controls (control_a/control_d/control_e); reverted. So the Windows `cargo test --workspace` job is a live detector for losing it. |
| The new test-windows CI job covers the six Windows-only defects | **PASS** | read only | reaches-user | Traced each: parity + provider-leak via `pnpm test` (vite.config include is src/**/*.test.{ts,tsx}); handler_binding, gate_m_assembled_app, the #[cfg(windows)] halves and the four *_fixture_replay controls via `cargo test --workspace --locked`. `needs: static` inherits the draft guard; `prefix-key: windows` correctly separates the rust-cache. Not run on a hosted runner — no workflow was triggered. |
| The three frozen contracts are held by tsc against shipping code | **PASS** | test bites | reaches-user | Renaming one field in contract-sandbox.ts produced TS2339/TS2353 in src/features/canvas/document-run.ts, document-host.ts and src/data/sandbox-repository.ts — shipping files, not just tests. 44 import sites traced, including src/app/App.tsx and src/platform/browser-adapter.ts. Reverted. |

**Could not establish:**

- check-transcripts.sh determinism — never executed. It regenerates docs/regression-baseline/mock-matrix/ in place, and with ten other auditors mid-edit in this worktree a non-deterministic run would leave tracked files dirty that I could not safely revert.
- CI as GitHub actually executes it. Every workflow finding here comes from reading ci.yml and running the equivalent commands locally; no run was triggered. Specifically untested: Swatinem/rust-cache@v2 with prefix-key: windows, and whether `cargo build/test --workspace --locked` resolves on a hosted windows-latest runner.
- Whether src-tauri currently compiles. I ran the prebuilt handler_binding and gate_m_assembled_app binaries (timestamped today 13:36 and 13:17) rather than `cargo test`, deliberately — four Rust files were modified by other auditors during my session and the build lock was contended. Those runs prove the Windows manifest fix and the tests' logic, not that HEAD-plus-other-agents' edits builds.
- The actual claim counts behind claimed-guards' vacuity floors. SCANNED > 200, doc-links > 300, paths > 300, named-tests > 50 all pass, so the real numbers exceed them — but I did not extract the numbers, so I cannot say whether any floor is close to being crossable by an ordinary refactor.
- Whether `pnpm verify` has ever completed on Windows, or when it stopped. I established only that it cannot today, at step 6 of 9.
- scripts/gate-m-composition-root-controls.sh, gate-m-debug-log-modes.sh, gate-m-debug-log-acl.ps1 and src-tauri/tests/gate_m_debug_log_acl.rs — adjacent to the domain, not graded. The .ps1 was read only to enumerate the backticked tokens claimed-guards never sees.
- The 58 behavioural rules of the frozen contracts. Taken as given from this session's record; I verified the enforcement mechanism (tsc against shipping importers), not the individual rules.
- Whether the docs trees claimed-guards deliberately excludes (docs/regression-baseline/, docs/desktop-gate/, docs/spec-parts/) currently contain claims that would fail if scanned. The exclusion is documented and defensible; I did not measure what it is hiding.

## Projects, skills and MCP

> All three tracks are host-complete and renderer-absent: the Rust is genuinely good (I broke it in four places and watched tests go red each time), but no module the running app loads calls a project_*, skills_* or mcp_* command. Three shipping comments assert that COMMAND_ALLOWLIST has no project or skill-body command when it has nine, and one of those falsehoods is the stated reason the agent runtime's project-instruction reader is hardcoded to null.

| aspect | verdict | evidence | shipped | finding |
|---|---|---|---|---|
| A user-facing project surface | **FAIL** | hardware | not-wired | There is no src/data/project-repository.ts and no src/features/projects. src/app/App.tsx:93 states it outright: 'The project feature does not exist'. DEFAULT_PROJECT_ID travels only as a label into document-host.ts:214. |
| The private agent workspace is scoped to a run | **FAIL** | read only | not-wired | grep for workspace_path/ProjectPaths/vela_projects across src-tauri/src returns nothing outside ipc/project.rs. src/platform/project-run-scope.test.ts states projectFilesystemScope has no call site in shipping code; I confirmed it. The workspace is created and read by nothing. |
| Project instructions reach a model turn | **FAIL** | hardware | not-wired | src/runtime/app-runtime.ts ends `readProjectInstructions: () => Promise.resolve(null)`, justified by a comment saying no command reads a project. ChatSendReq (ipc/chat.rs:111) carries no projectId either, so there is no second route. |
| Comments describing COMMAND_ALLOWLIST's contents | **FAIL** | hardware | n/a | app-runtime.ts:20 ('no command that reads a project'), project-context.ts:5 and :12 ('nothing for skills or memory', 'no project_get'), contract-harness.ts:739. contract.ts:1650-1676 lists eight project_*, skills_list, skills_read and five memory_* commands. |
| vela-skills::mount and ::enablement are a dead duplicate implementation | **FAIL** | hardware | not-wired | 1237 lines re-implementing the junction rule, the reparse-aware delete and case folding. Zero non-test callers. The shipped path is vela-projects. The crate's lib.rs explains the deadness with reasons that have expired (it says project_create/update/reconcile 'do not exist'). |
| skill-mount-parity.test.ts guards the shipped mount | **FAIL** | test bites | n/a | It reads src-tauri/crates/vela-skills/src (line 154) — the dead crate. I put std::os::windows::fs::symlink_dir into the LIVE crate's Windows branch: project-host-parity.test.ts failed, skill-mount-parity.test.ts stayed green. The live crate is covered; the guard whose name says 'skill mount' is not the one covering it. |
| MCP HTTP/SSE transport | **FAIL** | read only | not-wired | Not implemented. config.rs::resolve returns TransportNotSupported for any url entry; the entry is still listed rather than dropped, which is the right failure. Declared honestly in vela-mcp/src/lib.rs, but the brief's 'stdio and HTTP/SSE transports' describes a product that does not exist. Era negotiation is likewise absent. |
| MCP tool execution reaching a turn | **FAIL** | hardware | not-wired | There is no mcp_call_tool command — McpConnection::call_tool's only callers are tests/stdio_end_to_end.rs. mcp-repository.ts's own header says so, and that repository is itself unreachable from main.tsx. |
| MCP servers are shut down when the app closes | **UNVERIFIED** | read only | n/a | McpPool::shutdown() has no explicit caller and lib.rs installs no on_window_event/RunEvent::Exit handler; it is reached only via impl Drop for McpPool, which fires only if Tauri drops managed state on exit. pool.rs claims 'Called when the app closes'. I did not launch the app. |
| Project CRUD command layer (create/get/list/update/delete/move) | **PASS** | test bites | not-wired | 34 host tests green in src-tauri/src/ipc/project.rs; I made validate_enabled_skills' first_collision branch unreachable and two_enabled_skills_that_are_one_directory_are_refused_rather_than_deduplicated failed. Registered in generate_handler! but no renderer caller exists. |
| Reparse-point-aware delete (vela_projects::remove_tree) | **PASS** | test bites | reaches-user | link.rs:197 neutered to `if false && is_reparse_point(path)?` — 8 tests failed including removing_a_project_root_unlinks_the_skill_mounts_instead_of_emptying_the_store. Runs at every launch inside probe_link_strategy's scratch cleanup. |
| Skill mount is a junction on Windows, never a symlink | **PASS** | hardware | reaches-user | link.rs test reads the 32-bit reparse tag back off real NTFS: Some(0xA0000003) IO_REPARSE_TAG_MOUNT_POINT, not 0xA000000C. probe_link_strategy creates and removes a real junction under %APPDATA% at every launch. |
| The case-folding backstop asks the volume, not the case table | **PASS** | test bites | not-wired | mount.rs refusal_for's Named-and-already-mounted guard forced false: what_the_volume_says_about_the_path_decides_whether_it_may_be_written and a_collision_the_case_table_misses_is_still_caught_by_the_filesystem both failed. The test sources its pair from a real NTFS 8.3 alias. |
| Colliding enabledSkills refused at the command layer | **PASS** | test bites | not-wired | src-tauri/src/ipc/project.rs:319 validate_enabled_skills; CaseFolding::probe measures the projects root per call. Refusal is INVALID_PAYLOAD with both names, per the module header. |
| Working directory: read, never created, never deleted | **PASS** | test unproven | not-wired | workdir.rs has 8 green tests covering relative paths, app-data escape, ..-escape, missing folder, detached volume, file-where-folder. project_delete never touches it and no flag exists that could ask. I did not mutate this one. |
| Canonical skill store created empty at launch before anything reads it | **PASS** | test unproven | reaches-user | SkillsHandle::under_data_dir and ProjectHost::establish both call it in lib.rs setup; the_store_directory_is_created_before_anything_reads_it is green. A creation failure is reported to stderr, not fatal — correct per the contract. |
| SKILL.md store: frontmatter parsing and progressive disclosure | **PASS** | hardware | not-wired | 33 vela-skills unit tests plus 3 against the committed hello-vela fixture; gate_m_assembled_app.rs:1020-1053 drives skills_list/skills_read through the assembled app including the ../escape refusal. But src/data/skills-repository.ts is off the import graph from main.tsx. |
| MCP stdio transport, end to end | **PASS** | hardware | not-wired | 11 e2e tests drive a real node child over real pipes: handshake, tools/list, tools/call, oversized-line refusal, stderr-is-not-failure, death mid-request, spawn failure. src/data/mcp-repository.ts is off the import graph, so nothing in the UI shows the result. |
| MCP child process environment isolation | **PASS** | test bites | not-wired | Deleted command.env_clear() from stdio.rs:146 and the_server_does_not_inherit_the_parent_environment failed with 'an undeclared variable of the parent process reached the child'. INHERITED_ENV is a 14-name allowlist with its own no-credentials guard. |
| MCP config file: partial failure, disabled entries, missing file | **PASS** | test unproven | not-wired | 7 config tests plus 6 at the ipc layer. A missing file is an empty config, a non-JSON file is a whole-file failure carried on every list, one bad entry does not take the others down. Read once at launch; no reload and none claimed. There is no UI to author or view it. |
| MCP pool: one process per server, restart on death, tool-list cache | **PASS** | hardware | not-wired | the_pool_reuses_one_process_per_server compares pids; the_pool_replaces_a_server_that_died kills through the server's own die tool; a_list_changed_notification_invalidates_the_cached_tool_list drives the push half. All against the real fixture process. |

**Could not establish:**

- Whether the packaged app leaves MCP server processes running after the window closes. McpPool::shutdown() has no caller; it depends entirely on Tauri dropping managed state at exit. Establishing this needs a launch, which I was not authorised to do.
- Whether probe_link_strategy answers Junction under the real %APPDATA% rather than under a TempDir. It answered Junction on real NTFS here, but a redirected or network-backed %APPDATA% takes the Copy arm, and the whole copy materialisation path (copy_one, refresh_copy, the stale flag) has crate tests but has never run on a machine that actually needs it.
- Whether BrowserAdapter's ~350 lines of project validation agree with the host's. Nothing binds them: adapter_parity_fixture.rs and adapter-parity.test.ts mention neither project, skills nor mcp, and project-host-parity.test.ts pins only wire names, the two length constants and the Windows link branch. It only matters for `pnpm dev`, so I spent the budget elsewhere.
- Whether occupant_of's PresentButUnnamed arm is reachable in practice. refusal_for's decision over the enum bites (I broke it and watched two tests fail), but no test constructs the Windows ACL — traverse granted, FILE_LIST_DIRECTORY withheld — that would make windows_junction::stored_name fail on a real directory. That half is asserted, not measured.
- Whether vela-skills::mount has already drifted semantically from vela-projects::mount. Both suites are green; I did not diff their behaviour. If they have drifted, skill-mount-parity.test.ts is worse than useless, because it pins the wrong copy to the TypeScript contract.
- Whether the four stale allowlist comments are the only ones of their kind in this domain. I grepped for the specific sentences I had already found; I did not sweep every comment in the three crates against the current allowlist.

## Providers and model layer

> The provider core is the best-guarded code I have read in this repository — six of six mutations I planted were caught by tests that named the exact rule they broke, and its OpenAI-compatible path works end to end against the real llama.cpp on :8033. But it implements a larger product than ships: the Anthropic and Google adapters (~5,000 lines) and the entire Router/failover layer have no caller outside the crate, while the renderer already draws a "failed over" notice for an event nothing can emit.

| aspect | verdict | evidence | shipped | finding |
|---|---|---|---|---|
| Capability findings crossing the IPC boundary | **FAIL** | hardware | reaches-user | openai_compatible/provider.rs:823 files the declared context window as `capability: Capability::Streaming, support: Unknown` — the live probe output carries it verbatim to ipc::models::CapabilityFindingView, which drops the note that would have revealed the mislabelling; it also makes ModelCapabilityReport.probed true on /props alone, which turns 'not established' into positive assertions of absence in capability-rows.ts. |
| Router, bounded retry and failover | **FAIL** | read only | not-wired | `git grep -n "Router\|Candidate::new\|\.route(" -- src-tauri/src src-tauri/crates/vela-endpoint` returns nothing; chat_send calls provider.stream directly, so 490 lines of failover, backoff and Retry-After handling have no caller outside the crate and its example binary — while notices.ts:110 already renders a 'failedOver' degradation the product cannot produce. |
| Anthropic and Google adapters | **FAIL** | read only | not-wired | ProviderHost::build (provider_host.rs:256) has one arm and it is CompatProvider; ~5,000 lines of Anthropic and Google adapter are reachable only from tests, which the module's own docs disclose as a deliberate limitation — the code itself is good (the held_back mutation broke both adapters' cross-frame reasoning guards). |
| Provider composition root (configured → registered → resolvable) | **PASS** | read only | reaches-user | Traced both directions: src-tauri/src/lib.rs:86 syncs at startup, ipc/settings.rs:148/:163 install and forget on every put/delete, ipc/chat.rs resolve_provider reads the same host — the defect this module was written to close (an empty registry nothing ever registered into) is genuinely closed. |
| Model-agnosticism: adding a provider needs zero renderer change | **PASS** | test bites | reaches-user | I added an untracked src/lib file containing `export const AUDIT_PROBE = 'ollama'` and no-provider-leak.test.ts failed naming the exact line and path (1 failed \| 17 passed); the guard also carries its own controls and per-scan non-vacuity assertions, though the top-level src/ scan alone has no file-count floor. |
| Rust↔TypeScript parity of the provider wire types | **PASS** | test bites | reaches-user | Deleting 'cancelled' from STOP_REASON in chat-contract-parity.test.ts produced a named diff against model.rs::StopReason; the CRLF repair holds on this Windows checkout (33/33 cases parse), but parseRustItem ignores per-variant #[serde(rename)] — no variant uses one today, so there is no live drift. |
| Shipped adapter (CompatProvider) driving a real endpoint | **PASS** | hardware | reaches-user | One turn through a CompatProvider built exactly as ProviderHost::build builds it, against llama.cpp on 127.0.0.1:8033: FLAVOUR LlamaCpp, window 131072 from /props, 127 reasoning deltas, 5 tool-call deltas, 1 usage frame, exactly one Done, StopReason::ToolUse, degradations []. |
| SSE decoding and stream normalisation (MEASURED-1, MEASURED-2) | **PASS** | hardware | reaches-user | The live turn above decoded a real streamed body with no lost frames and reported no false NoTerminationSentinel or UsageNotReported; sse.rs treats [DONE] as a flag, dispatches a trailing frame with no blank line, and every read in stream.rs::drive_stream is wrapped in tokio::time::timeout(context.timeouts.stall). |
| Reasoning channel separated across frame boundaries (MEASURED-3) | **PASS** | test bites | reaches-user | Making textscan.rs::held_back return 0 failed 7 tests across all three adapters plus the emulation stripper, with the leak itself in the failure message — and the live turn put all 127 deltas on ReasoningDelta with an empty answer, so it holds against a real reasoning model too. |
| Deliberation is not an instruction (the AnswerChannel chokepoint) | **PASS** | test bites | reaches-user | Adding `self.committed.push_str(text)` to AnswerChannel::push_reasoning (answer.rs:226) failed 2 lib tests and 3 in tests/deliberation_is_not_an_instruction.rs, including a_call_the_model_never_committed_to_is_not_executable_on_either_transport. |
| Native tool-call accumulation and the two wire shapes (MEASURED-4 / FINDING 1) | **PASS** | test bites | reaches-user | Collapsing WholeCall into Fragment at stream.rs:211 fused two parallel calls into one UnparseableArguments blob and failed 3 tests — but only in tests/parallel_tool_calls.rs; the lib tests and both fixture replays stayed green, so this property has a single line of defence. |
| Tool-call emulation for models with no native tools | **PASS** | test bites | reaches-user | The stripper is guarded (emulation::tests::the_stripper_never_lets_call_markup_reach_the_user_even_split_across_frames fell to the held_back mutation) and CompatOptions defaults emulate_tools: true, but only src/runtime/agent-loop-harness.ts:361 ever sends tools — src/data/chat-repository.ts's streamTurn omits the field, so the plain composer never exercises it. |
| Capability probing (probe evidence, never a provider-name table) | **PASS** | hardware | reaches-user | Ran the repo's own #[ignore]d live probe against :8033 in 9.68 s inside Timeouts::probing(): toolCalling Supported/Probed (the 64-token truncation fix confirmed), structuredOutput correctly Degraded on a real model that ignores a json_schema request, everything else probed rather than assumed. |
| Context-window accounting, fitting, and refit-on-overflow (MEASURED-7) | **PASS** | test bites | reaches-user | Flipping CompatOptions::default().refit_on_context_overflow to false failed 3 compat::provider tests covering both halves — that the refit happens, and that it happens once and only before anything reached the screen; context.rs never guesses a window (ContextBudget::for_request returns None when unknown). |
| Structured-output validation (MEASURED-5, silent degradation) | **PASS** | hardware | reaches-user | check_answer takes a MachineText that cannot be built from a &str, and the live probe reported structuredOutput degraded with 'the model returned prose, not JSON' — but no user path sets ResponseFormat (`git grep response_format -- src-tauri/src src` is empty), so structured.rs is exercised only by the probe. |
| Error taxonomy and the typed, closed Diagnosis | **PASS** | test unproven | reaches-user | Cause has no String-carrying variant, EndpointIdentity/ConfiguredModelId can only be built from a request, error::detail() no longer exists, and notices.ts maps every arm to renderer-owned prose; tests/typed_closed_error_surface.rs carries its own control (the_vocabulary_audit_can_detect_a_planted_string) which I read but did not exercise with a mutation. |
| Credential redaction (RequestUrl and Scrubber) | **PASS** | test bites | reaches-user | Making Scrubber::replace_encoded a no-op failed 5 redact tests including the solidus-escape, the all-\uXXXX spelling, the surrogate pair and the chunk-boundary case; RequestUrl::expose has two production call sites (http.rs:1039-1040), not the one its module doc claims. |
| Egress control: no ambient proxy, no redirect, Auth::None sends nothing | **PASS** | test unproven | reaches-user | tests/wire_{auth_headers,proxy_egress,redirect_egress}.rs open real loopback listeners and assert on literal request bytes with in-file positive controls, and all three were green in my baseline run — but I did not mutate the transport to confirm they bite. |
| Server discovery, flavour detection and error-dialect normalisation | **PASS** | hardware | reaches-user | compat/error_shapes.rs rewrites llama.cpp's numeric code, vLLM's missing error object and Ollama's string error into the canonical shape at the transport seam before the core sees them; the llama.cpp arm of discovery is confirmed live (ServerFlavour::LlamaCpp, Some(131072)), the other three families are mock-only. |
| Opt-in local debug log and its private directory | **PASS** | read only | reaches-user | diagnostics_debug_log_{get,set} are in generate_handler!, App.tsx → ModelWorkspace → EndpointsPanel:138 mounts DebugLogSwitch, the status crossing the bridge is {enabled, path} only, and private_fs re-reads the DACL off the filesystem rather than trusting the request — I did not independently re-measure the Windows DACL round-trip. |

**Could not establish:**

- The Anthropic and Google adapters have never been run against the real vendor APIs. Their fixtures are, by the replay harness's own admission, 'transcribed from the published protocol shape — not captured traffic'. No credential for either vendor exists in this environment, and nothing in the host can construct those providers anyway, so their wire encoders (whether Anthropic or Gemini would accept the bodies Vela builds) are entirely untested against a real server.
- Emulated tool calling has never been measured against a model that actually lacks native tool calling. The only live endpoint available calls tools natively (`emulated: false` in my live turn), so render_catalogue → parse_calls → render_results is fixture-and-mock evidence only.
- Context elision and summarisation were never exercised against a genuinely short window on hardware. The live endpoint declares 131,072 tokens, so fit_request's drop path and the ContextReduced degradation were only ever seen in unit tests and mock profiles.
- I did not mutate tests/wire_auth_headers.rs, tests/wire_proxy_egress.rs or tests/wire_redirect_egress.rs, so I cannot say those three guards bite — only that they passed and that they assert on literal socket bytes with in-file positive controls.
- I did not mutate tests/typed_closed_error_surface.rs. Its claim (no error in the taxonomy carries an unexplained string) is backed by an in-file control I read but did not run against a planted defect.
- Cancellation mid-turn was not exercised on hardware: chat_cancel → CancelToken → the tokio::select! in drive_stream is traced by inspection only. Nor was the stall timeout ever fired against a real socket that goes quiet — the wedged-socket guard MEASURED-1 requires is mock-only in my evidence.
- Multi-endpoint behaviour is unmeasured. One endpoint was available, so nothing about two configured providers — reconciliation keeping learned facts, an edit replacing the live object, a delete making an endpoint unreachable — was checked beyond provider_host.rs's own unit tests, which I read but did not break.
- Google's safety-block and thought-signature handling, and Anthropic's redacted-thinking and signature_delta handling, are fixture-only. Whether a real prompt-safety block produces the intended ProviderError with a FilterVerdict is unknown.
- The promptCaching flag's documented weaker meaning ('the endpoint accounts for cached input', not 'prompts get cached') is stated in capability.rs and I did not measure reuse. The live probe reported Supported off a zero-token cached-input field, which is exactly the weaker claim.
- private_fs's Windows DACL round-trip was not independently re-measured. I relied on the session's prior finding that the previously-uncompiled Windows code now compiles, plus the fact that the crate builds and tests green on this Windows host.
- Whether the misfiled Capability::Streaming finding can actually produce the 'probed: true with everything absent' UI state in practice was reasoned, not observed — it needs an endpoint that answers /props and then fails every subsequent probe step, which I had no way to stage without reconfiguring the shared server.

## Sandbox and code execution

> The escape battery ran for real against WSL2 on this machine (43 tests, 13.9 s, no skip) and it bites: five of my eight mutations to the confinement code produced immediate, well-named failures. But `SandboxBackendReport` claims `processes: kernel` and no process limit is applied at all — `/bin/sh` is dash, dash's `ulimit` has no `-u`, the error is swallowed by `2>/dev/null \|\| true`, and a run granted `processes: 8` forked 300 with an actual RLIMIT_NPROC of 127929.

| aspect | verdict | evidence | shipped | finding |
|---|---|---|---|---|
| `processes` limit reported `kernel`-enforced | **FAIL** | hardware | reaches-user | wsl.rs:178 declares `EnforcementLevel::Kernel`; wsl.rs:322-325 emits `ulimit -u N 2>/dev/null \|\| true` into a script piped to `/bin/sh` = dash, whose ulimit has no `-u` (`/bin/sh: 3: ulimit: Illegal option -u`). Via the real `SandboxHost`: grant said `processes: 8`, run reported `ulimit -u` 127929 and forked 300 with zero errors. No test covers this limit — the only `kernel` claim is the only untested one. |
| Test coverage for the descendant-reaping claim | **FAIL** | test unproven | n/a | I ran the mutation and it did NOT bite: `cancelling_stops_the_run_and_reaches_every_descendant` passes with `--kill-child` removed from the launcher. Its only descendant assertion is `!stdout.contains("NEVER")` against a pipe the host stops reading at cancellation, so an orphaned guest could print forever and it would still hold. The test is named for a guarantee it does not check. |
| stderr fidelity — host bytes attributed to the program | **FAIL** | hardware | reaches-user | A cold-VM run delivered UTF-16LE `wsl.exe` text ("the wsl2.localhostForwarding setting has no effect…", caused by the user's own .wslconfig `networkingMode=mirrored`) as `SandboxEvent::Output{stream:Stderr}`, counted against `output_bytes`. `new_command`'s comment anticipates this exact class for PATH noise and fixes it with `env_clear`; this warning is not environmental and gets through. Makes `output_arrives_in_the_programs_own_order…` (which asserts stderr equals `"to-stderr\n"` exactly) order-dependent. |
| End-to-end reachability from a UI surface | **FAIL** | read only | not-wired | All six commands are registered (the `ipc::sandbox::sandbox_*` rows of the `generate_handler!`
list in `src-tauri/src/lib.rs` — cited by symbol because the line numbers rot: they were 210-215
when this row was written, 211-216 at `e563575`, and 221-226 at `8200985` after the
project-instructions merge inserted `project_*` above them) and `src/data/sandbox-repository.ts`
invokes them, but `createSandboxRepository` has no non-test caller and the only `ToolExecutor` the composition root builds (`createSubagentToolkit`, app-runtime.ts:81) has no bash tool. No surface renders an approval prompt, so `awaitingApproval` has no consumer. The renderer test suite runs against `BrowserAdapter`'s fake, which refuses every submit `languageUnsupported` — VERIFIED-BY-FAKE. All of this is declared accurately in contract-sandbox.ts amendment 4, which I checked in both directions. |
| WSL2 namespace construction (the launcher) | **PASS** | test bites | reaches-user | Removing `unshare` and all five flags from `WslBackend::command` (wsl.rs:389-398) failed both escape tests immediately; the crate's dedicated unit test also pins each flag by name. Registered command path only — no renderer surface invokes it (see the reachability row). |
| Windows filesystem unreachable from a run (both 9p routes) | **PASS** | test bites | reaches-user | No-oping the `umount -l` loop in wsl.rs:271-276 produced `mnt-entries=0 ninep-mounts=4` and failed at sandbox_boundary.rs:231. The second prefix (`/usr/lib/wsl`) and the labelled two-count assertion are both load-bearing; the unlabelled form would have stayed green. |
| The pre-mount interlock protecting the user's live distribution | **PASS** | hardware | reaches-user | wsl.rs:217-220 checks `/proc/net/dev` has exactly 1 interface before the first mount. Distro's own namespace has 8. With `unshare` removed, both runs settled `HostFailed{BackendStartFailed}` with `stdout ""` — no script line after the check ran — and the user's Ubuntu afterwards still had /mnt/c, 5 /mnt entries, 4 9p mounts and a writable rootfs. This is the only guard whose failure mode is damage to the user. |
| Network denial (empty network namespace) | **PASS** | test bites | reaches-user | Losing `--net` fails `a_run_has_no_network_at_all`, but indirectly: the interlock refuses to run rather than the test observing a reachable network. A `--net` that was present but ineffective would not be caught by this test. |
| Read-only grant is remounted read-only | **PASS** | test bites | reaches-user | Gating the `remount,ro,bind` off (wsl.rs:244) produced `read-meWROTE` and failed sandbox_boundary.rs:304. The test also asserts the file did not appear on the real host disk. |
| Filesystem scope: granted directory readable, sibling not, bind writes through | **PASS** | hardware | reaches-user | `a_granted_directory_is_readable_and_the_directory_beside_it_is_not` runs a real program, checks `/work/../secret` is unreachable, and verifies from outside that the run's write landed on the user's disk and that the sibling genuinely exists. I did not mutate this one. |
| Privilege drop, PR_SET_NO_NEW_PRIVS, read-only rootfs | **PASS** | test bites | reaches-user | Removing `--no-new-privs` left `sudo-denied` and `rootfs-read-only` still true — only the `NoNewPrivs:\t1` assertion failed. That single assertion is what distinguishes kernel denial from a maintained list, which is the crate's whole thesis. |
| Program text never parsed by a shell (base64 in, file out) | **PASS** | hardware | reaches-user | `a_program_whose_text_is_hostile_to_a_shell_still_runs_as_written` executes `'; touch /vela/pwned; #` and `$(id -u)` inside the real guest and gets them back verbatim. Backed by unit tests on `sh_quote` and on the absence of source bytes from the script. |
| Protected roots checked against the resolved path, not the caller's string | **PASS** | test bites | reaches-user | Stripping `canonicalize` from `paths.rs:38-39` caused the `..`-out-and-back spelling to be admitted (`HostFailed`, not `Refused{MountIsProtectedRoot}`) — the run reached execution with key material granted. The Windows directory-junction spelling also ran (no SKIPPED line under --nocapture), and the test has a control. |
| Approval digest binds the person's answer to the request bytes | **PASS** | test bites | reaches-user | Computing the digest over `run_id` alone made the base request and the changed-program-text row hash identically; the test holds the run id fixed across all nine rows precisely so this cannot hide. host.rs:453-457. |
| memory / cpu / file_write limits declared `unenforced` | **PASS** | hardware | reaches-user | Inside a real run: `ulimit -v`, `-t`, `-f` all `unlimited`, exactly matching the three `Unenforced` declarations and their explanatory comments. The scratch tmpfs really is sized from `file_write_bytes` (df showed 102400 kb for a 104857600-byte request) and is still under-claimed as `Unenforced` because it does not bound writes into a readWrite bind mount. |
| Supervisor limits: wall clock and output budget | **PASS** | hardware | reaches-user | `a_run_that_will_not_finish_is_killed_at_the_wall_clock` runs a real `sleep 120` under a 3 s budget and gets `LimitExceeded{WallClockMs}`; `exceeding_the_output_budget_truncates_once_and_does_not_kill_the_run` gets exactly one `Truncated` and `Exited{exit_code:7}`. Both reported `Supervisor`, which is what they are. Not mutated. |
| Cancellation reaps the process tree | **PASS** | hardware | reaches-user | Measured outside the repo: same launcher shape, a `setsid`-detached grandchild, `Stop-Process -Force` on the Windows launcher. 2 markers alive during, 0 after — with and without `--kill-child`. Reaping comes from `--pid --fork` and/or WSL relay teardown; I did not isolate which. |
| Four-level permission selector | **PASS** | test unproven | not-wired | Admission semantics for all four levels are implemented and covered by five tests (refusal ordering, denial, abandonment, profile clauses). But `ipc/sandbox.rs:97` hardcodes `PermissionLevel::Ask` and `SandboxHost::set_permission` (host.rs:383) has zero callers repo-wide including tests — `off`, `approve` and `full` cannot be selected in the shipped binary. |
| Refusal vocabulary and declared absences | **PASS** | read only | reaches-user | 14 of 18 `RefusalReason` members have producers; the four without are exactly the four the contract names (`skillsMountMustBeReadOnly`, `guestPathRemapUnsupported`, `limitAboveHostCeiling`, `documentGrantInvalid`). `python`, the document family, both copy materialisations and every non-`denied` network policy are refused rather than downgraded, each with a test. Gap: `HostFailureReason::ScratchUnavailable` and `CopyOutFailed` also have no producer and are not called out anywhere. |
| Rust↔TypeScript contract parity (base environment, command allowlist) | **PASS** | test bites | reaches-user | Changing `PWD` to `SHELL` in the Rust `SANDBOX_BASE_ENVIRONMENT_POSIX` failed `the_base_environment_list_is_the_one_the_typescript_contract_froze`, which reads `src/platform/contract-sandbox.ts` off disk at test time. The array is single-line, so the CRLF hazard that broke a sibling guard does not reach it. All six commands are in both allowlists, pinned by `rust_and_typescript_allowlists_are_identical`. |
| `report_document` and the document backend | **PASS** | read only | reaches-user | `report_document` is a literal no-op (host.rs:381) and both the crate doc and ipc/sandbox.rs:180-187 say so plainly, including that it is not a trust boundary. `absent_document_backend()` reports every guarantee `Unenforced` rather than omitting the field. The absence is honestly declared, which is what this domain was asked to grade. |

**Could not establish:**

- Whether the `processes` defect is machine-specific. It is a property of `/bin/sh` being dash; a distribution whose `/bin/sh` is bash would apply the limit. `WslBackend::detect()` takes the first non-Docker distribution whatever it is, so a hardcoded `EnforcementLevel::Kernel` is a claim that varies by machine — which is the deeper problem.
- The cold-start trigger for the stderr leak. Observed once at `startup_ms: 3445`; not reproducible across four launcher invocations with a warm VM. Confirming it would require terminating the user's live distribution, which I judged out of bounds.
- Which mechanism actually reaps descendants — PID-namespace teardown (`--pid --fork`) or WSL's relay teardown when the Windows client disconnects. Both are present and either is sufficient; I did not isolate them, so I cannot say what `--kill-child` is buying.
- The TOCTOU window between `resolve_host_directory` and the bind mount. `paths.rs:16-19` names it openly and argues the mount namespace closes it. I did not attempt to race it.
- The hypervisor boundary. Whether WSL2's utility VM holds against a hostile guest is out of scope, and the crate correctly does not claim it (`isolation: Container`, not `MicroVm`, because the VM is shared with the user's own WSL session).
- `absent_process_backend()` on a machine with no WSL distribution. This machine has WSL; that path was exercised only through the tests' `unreachable_backend()` fake, never for real.
- Concurrency behaviour under real contention. `MAX_CONCURRENT_RUNS = 4` and the `saturating_sub(1)` accounting in `submit` are covered by `releasing_a_run_frees_its_id_and_the_slot_it_was_holding`, which I read but did not mutate.
- Whether `python` would work inside the guest if enabled. Untested by design and correctly not claimed — but that also means the refusal is the only thing anyone has verified about it.
- Six of the twenty aspects are graded `test-only-unproven` or `inspection-only`. Those are the rows most likely to be wrong, and the ones I would mutate next given more budget — particularly the auto-approval profile clauses and the concurrency accounting.

## Scheduler, dual local endpoint, memory, canvas/artifacts (Phase 3 tracks)

> Every rule in this domain that is written down is watched by something that bites — 15 of 15 mutations produced failing tests, including the bind-address tool policy at both the classification and the request-path level. The defects are absences, not lies: there is no schedules UI at all and nothing ever finishes a scheduled run; the dual endpoint has no switch, no documentation, and its one path to a real model (ProviderBrain) has never been executed by any test.

| aspect | verdict | evidence | shipped | finding |
|---|---|---|---|---|
| A fired run reaching a model and completing | **FAIL** | read only | not-wired | finish_schedule_run has no production caller anywhere — only vela-store's own tests and tests/durability.rs:413. Firing creates a conversation holding the prompt, opens a `running` run, and stops. That run then blocks its own schedule via the overlap guard until the next restart reaps it as `failed`. ScheduleRunStatus::Succeeded is unreachable in the shipped binary. Documented in three places (scheduler.rs:35, scheduler_host.rs:19, ipc/schedules.rs:17). |
| Schedules user surface (create/list/enable/history) | **FAIL** | read only | not-wired | There is no src/features/schedules/. grep for ScheduleView/schedules_list/Cadence across src/ returns only contract.ts, browser-adapter.ts and their tests. A user of the shipped app cannot create, see, or run a schedule. Separately, vela_store::run_now (manual 'run now') has no IPC command and no caller outside its own two tests. |
| A user-facing way to turn the endpoint on | **FAIL** | read only | not-wired | `git grep -ln VELA_LOCAL_ENDPOINT -- docs README.md scripts src` returns nothing. The only mentions are inside endpoint_host.rs and one lib.rs comment. No settings row, no command, no README line. endpoint_host.rs:32-35 names this gap itself. |
| Per-project memory, clear-scope, and automatic extraction from the UI | **FAIL** | read only | not-wired | Three absences. MemoryScopeDto::Project is implemented and tested but called by nothing in src/ — use-memory.ts:105 and use-conversation.ts:356 both pass GLOBAL_MEMORY literally. memory_clear_scope is registered and has a repository method that no component calls; there is no 'forget everything' button. MEM-1's post-turn extraction pass does not exist and no turn calls memory_add. All three are stated in the source (MemoryPanel.tsx:30, ipc/memory.rs:9 and :28). |
| Canvas sandbox host is host-held, and artifact execution can be switched off | **FAIL** | read only | not-wired | The six sandbox_* commands are on no allowlist and have no Rust module; LocalDocumentHost is a renderer-side stand-in for four of them, so permissionIsOff is held by the process it constrains, requestDigest is an identity token not a check, and wallClockMs is a setTimeout in the same event loop. All labelled as such at document-host.ts:6-45. Concretely: CanvasSurface.tsx:57 constructs `new LocalDocumentHost()` with no options, defaulting permission to 'ask', and nothing outside tests ever passes a permission — so there is no user setting to switch artifact rendering off and the permissionIsOff path is dead in the shipped app. Also DEFAULT_AUTO_APPROVAL_PROFILE's document floor (ownRendererProcess) is one rank above CANVAS_ISOLATION_FLOOR, so every artifact prompts, always. |
| ProviderBrain: the port's only path to a real model | **UNVERIFIED** | none | behind-flag | endpoint_host.rs:172-216. Its models() and stream() are exercised by no test — the one host test that starts a server asserts only the policy and the summary line and never sends a turn. Nothing in this domain was measured against the llama.cpp server on 127.0.0.1:8033; doing so needs the app launched or a new binary target, neither available to me. |
| Scheduler poll loop wired at startup | **PASS** | read only | reaches-user | src-tauri/src/lib.rs:166-167 calls scheduler_host::reap_on_boot then ::spawn unconditionally inside setup; spawn starts a named thread that sleeps POLL_INTERVAL (30s) before its first vela_store::poll_once. Nobody has ever watched it fire on wall clock — every scheduler assertion in the repo passes the instant as an argument. |
| Cadence semantics and catch-up counting | **PASS** | test bites | reaches-user | Mutated vela-store/src/model.rs 'let steps = elapsed / interval + 1' to 'let steps: i64 = 1'; a_day_asleep_fires_one_run_and_counts_the_slots_it_skipped FAILED (1/91). Only that one test caught it. Daily/Weekly are fixed ms offsets, so a daily schedule drifts an hour across DST — documented at model.rs:800, unguarded. |
| Overlap guard: an in-flight run blocks the next fire | **PASS** | test bites | reaches-user | Removed 'AND {NO_RUN_IN_FLIGHT}' from due_schedules (sqlite.rs:1379); two scheduler tests FAILED. The guard lives in the SQL query, not in the poll loop, which is the right place. |
| Boot reaping of runs left `running` by a dead process | **PASS** | test bites | reaches-user | Mutated reap_orphaned_runs (sqlite.rs:1502) to "WHERE status = 'running' AND 1 = 0"; runs_left_behind_by_a_restart_are_reaped_so_the_schedule_is_not_wedged FAILED. scheduler_host's own end-to-end reap test lives in vela-app and could not be run (see unverified). |
| schedules_* IPC commands, registration and validation | **PASS** | test unproven | reaches-user | Five commands in generate_handler! (lib.rs:216-220), in COMMAND_ALLOWLIST and in contract.ts ALLOWED_COMMANDS (1664-1668). create validates title <=200 and prompt <=8000 chars and resolves project_id via get_project so a bad ref is NOT_FOUND. Seven module tests. Could not mutate or run — vela-app would not build (see unverified). |
| Bind-address scope classification (0.0.0.0 is not loopback) | **PASS** | test bites | behind-flag | Mutated policy.rs BindScope::of_ip to 'ip.is_loopback() \|\| ip.is_unspecified()'; FOUR policy tests FAILED. ToolPolicy is Copy, has one constructor, no interior mutability, and serve() resolves it from listener.local_addr() after binding — a caller cannot ask for 0.0.0.0 and describe it as loopback. |
| Tool-policy enforcement at a single choke point on the request path | **PASS** | test bites | behind-flag | Removed BOTH 'let chat = policy.enforce(chat)' and its debug_assert from server.rs:445, so the probe tested the suite rather than the assertion. a_policy_with_tools_off_strips_them_however_the_request_body_asks FAILED over a real TCP socket with a body carrying enable_tools:true, a tools array and tool_choice. Note: binding_the_wildcard_address_turns_tools_off_by_itself PASSED under this mutation — it only reads the policy object, not the wire. Enforcement is guarded by exactly one test, and it is the right one. |
| Endpoint bearer auth and empty-key refusal | **PASS** | test bites | behind-flag | Disabled the auth gate in server.rs dispatch; neither_dialect_answers_without_the_key and the_model_list_answers_before_any_turn_is_sent both FAILED over a real socket. Comparison is hand-written constant-time over the full key; an empty/whitespace key makes serve() return ServeError::EmptyKey. x-api-key is deliberately not a second way in, which means a stock Anthropic SDK client would get 401 — a real interop constraint documented nowhere a user would see. |
| Endpoint off / refused when unconfigured | **PASS** | test unproven | behind-flag | endpoint_host::decide returns Off with no VELA_LOCAL_ENDPOINT, and Refused (BindAddressUnparseable / NoKey / NoProvider) rather than any fallback. Any unrecognised VELA_LOCAL_ENDPOINT_TOOLS value — including 'yes', 'true', '1' — falls through to Default so the bind address decides; a typo cannot turn tools on. Six unit tests; I did not mutate decide(). |
| Dual-dialect wire behaviour on one port | **PASS** | test unproven | behind-flag | Ran cargo test -p vela-endpoint on this machine: 43 lib + 12 integration tests binding real loopback sockets and speaking real HTTP/1.1, all green. Covers both dialects on one key, the Anthropic event sequence by name and order, the OpenAI chunk + [DONE] sentinel, /v1/responses -> 501 (so a wrong base URL is distinguishable), 405, malformed body refused in the caller's dialect, the asymmetric base URLs, and provider errors becoming one of eight codes with Diagnosis never crossing. The brain is a closure; I did not mutate the translators. |
| Memory pane reachable and editable | **PASS** | test unproven | reaches-user | Sidebar.tsx:189 and :249 call setMemoryOpen(true); App.tsx:37 mounts MemorySurface, which renders null until open so no host read happens at launch. Five memory_* commands registered (lib.rs:194-198). Controller exposes remember/amend/setPinned/forget with per-category headings owned by the renderer. |
| Memory reaches the outgoing turn on both paths, within budget | **PASS** | test bites | reaches-user | Four mutations. Dropping memoryRef.current from both toMessages calls FAILED memory-payload.test.tsx. Dropping it from the AGENT path alone (use-conversation.ts:746) FAILED 2 of 293 tests including agent-run.test.tsx asserting input[0] is the system block — so each path has its own guard. Making memoryBudgetTokens ignore the 5% window fraction FAILED 3 tests. Making noteChanged a no-op FAILED the 'counts the memory block in the context meter' test. |
| Memory scope isolation (project vs global) at the store | **PASS** | test bites | reaches-user | Neutered list_memory_entries' partition (sqlite.rs:1590) with 'OR 1 = 1'; project_memory_and_global_memory_never_see_each_other and clearing_one_scope_leaves_every_other_scope_intact both FAILED. The partition uses 'project_id IS ?2' not '=', because the global scope's project_id is NULL. No IPC command returns more than one scope. |
| Past-chat search | **PASS** | test unproven | reaches-user | CommandPalette.tsx:114 -> use-conversations.ts:170 -> repository.search -> store_search. ipc/store.rs:437-444 fans out to search_conversations (LIKE over titles, which are not in the FTS index) and search_messages (FTS5). Nine sqlite tests cover quoting, %, _, stemming and limits, including an unbalanced quote erroring rather than silently returning empty. Not mutated. |
| Canvas frame boundary: opaque origin, CSP, no frame before accepted | **PASS** | test bites | reaches-user | Three mutations, all bit. Adding allow-same-origin to the sandbox attribute FAILED 3 tests across document-frame.test.ts AND CanvasPanel.test.tsx (which reads the attribute off the rendered DOM node). Changing CSP default-src 'none' to * FAILED 1. Making drawnGrant return the approval's own grant while awaitingApproval FAILED 8 tests across CanvasPanel and canvas-wiring — confirming the refactor that collapsed two guards into one left a rule with a single, breakable guard. |
| Canvas artifact detection, versioning, version rail and diff | **PASS** | test bites | reaches-user | App.tsx:123 wraps the transcript in CanvasSurface with assistantTexts reported outward from ConversationSurface; canvas-wiring.test.tsx drives that joint at App level. Removing the byte-identical-revision dedup in collectArtifacts FAILED 'does not count a repetition as a revision'. Replacing 'pinned === null ? latest : min(pinned, latest)' with 'latest' FAILED 2 tests including 'lets the reader go back to an earlier one and stay there'. |
| Canvas refuses languages it cannot draw and still shows source | **PASS** | test unproven | reaches-user | CANVAS_LANGUAGES is ['html','svg']; jsx/tsx/react/mermaid fences are still detected and open a panel, then get a languageUnsupported refusal and the Code tab. Tested at document-host.test.ts:170 and CanvasPanel.test.tsx:110. Caveat: frameFor still has live 'react' and 'mermaid' arms that would inline JSX into an HTML body and Mermaid text into an SVG-styled document — unreachable today because the host refuses first, but they would render garbage if CANVAS_LANGUAGES ever grew. |

**Could not establish:**

- Nothing in this domain was measured against a real model. The dual endpoint's ProviderBrain — the only path from the open port to the llama.cpp server on 127.0.0.1:8033 — has no test and was not exercised. Reaching it needs the app launched (another auditor holds that authorisation) or a new binary target (would mean writing a tracked file). The endpoint's HTTP framing, routing, auth and tool policy WERE exercised over real loopback TCP sockets, but with a closure standing in for the model.
- cargo test -p vela-app would not build, twice: 'failed to remove file target\debug\vela.exe — Access is denied (os error 5)', because another agent is running the application. So the handler_binding probe — which assembles the real app on Tauri's mock runtime and asks the invoke_handler itself whether each command is registered — could not be run by me. Registration of schedules_* and memory_* is inspection-only here (I read generate_handler!, COMMAND_ALLOWLIST and ALLOWED_COMMANDS and they agree); the lead's workspace run covers the probe. For the same reason scheduler_host's, ipc::schedules' and ipc::memory's own tests were neither run nor mutated — the store-layer and endpoint-layer mutations stand in for them.
- I did not mutate the dialect translators (anthropic.rs, openai.rs, tool_choice.rs, ~1,600 lines). Their 43 lib + 12 integration tests all passed on this machine, but 'passes' is not 'bites'. Budget went to the two security rules instead.
- endpoint_host::decide was not mutated. Its six unit tests each assert a specific Decision variant and look non-vacuous on reading, but I did not confirm by breaking the function.
- The 30-second poll interval has never been observed firing, by me or by the repo. the_poll_thread_sleeps_before_its_first_poll proves the ordering with a 50 ms sleep, not the cadence. Every other scheduler assertion passes the instant as an argument by design.
- Nothing about DST, timezone changes or a clock jump was tested by me or by the repo. Cadence uses fixed millisecond offsets and the consequence is documented but unguarded.
- The worktree is shared and was noisy: during my run other auditors had vela-providers/src/answer.rs, redact.rs, four .sse fixtures and conversation/use-conversation.ts mutated at various moments (I verified by git diff that the use-conversation.ts change visible at the end was not mine — it altered a streaming first-token condition). My vela-endpoint builds compile vela-providers, so those runs carry that caveat, though no result depended on the mutated code.
- I could not establish whether a conversation spawned by a schedule would be visible or comprehensible in the sidebar, because no schedule can be created from the UI to produce one.

## Secrets, credentials and data-at-rest

> All four promises I was asked to grade hold, and I broke the implementation on real Windows hardware to prove three of them bite. But the DACL hardening that `private_fs.rs` exists for was applied to `diagnostics/` and to nothing else: I measured `%APPDATA%\dev.vela.desktop\vela.db` — a live 315 KB conversation database holding every prompt and answer — still carrying the exact inherited `CodexSandboxUsers ReadAndExecute` ACE with inheritance enabled, one directory above the folder that was fixed.

| aspect | verdict | evidence | shipped | finding |
|---|---|---|---|---|
| Real Windows Credential Manager path has no test that executes it | **FAIL** | read only | reaches-user | `git grep KeyringStore` over src-tauri/ returns only keyring_store.rs, state.rs's cfg, and docs — zero tests construct one. Under `cargo test -p vela-secrets` it is not even compiled (that crate's default features are empty). Honestly disclosed in the module docs, and covered by docs/desktop-gate/VERDICTS.md §A3 at commit 9540d6c, but nothing at HEAD would catch a regression. |
| The rest of the application-data directory is NOT owner-only | **FAIL** | hardware | reaches-user | Get-Acl now: vela.db (315 KB, live), vela.db-wal (2.6 MB) and skills/ all show Protected=False with DESKTOP-298M5DU\CodexSandboxUsers ReadAndExecute inherited=True plus an app-container SID FullControl — the identical ACE private_fs.rs was written to remove. DatabaseLocation::prepare (vela-store/src/location.rs:65) is plain create_dir_all, and vela-store/src/lib.rs:26 still asserts 'the real per-user application-data directory'. The database holds the same data class as the debug log (prompts and answers verbatim), permanently and always-on rather than opt-in. |
| Debug log lazy-open failure vs. reported status | **UNVERIFIED** | read only | reaches-user | FileSink opens lazily via private_fs::open_private_append(path).ok(). If file hardening fails after the directory succeeded, the sink silently records nothing while diagnostics_debug_log_get keeps reporting enabled:true. Fails closed for secrecy, open for honesty. No test covers it and I did not construct one. |
| No `secrets_get` on the IPC surface | **PASS** | test bites | reaches-user | Added `secrets_get` to COMMAND_ALLOWLIST (src-tauri/src/ipc/mod.rs:127) on this Windows box: `no_command_returns_secret_material` and `rust_and_typescript_allowlists_are_identical` both went red, clean run afterwards green. src/platform/contract.test.ts:85 mirrors it, and handler_binding.rs:471 dispatches the name against the real invoke_handler. |
| `SecretValue` is not `Serialize` | **PASS** | read only | reaches-user | src-tauri/crates/vela-core/src/secret.rs:40 derives only Clone/PartialEq/Eq/Deserialize. This, not the allowlist test, is what actually makes a secret-returning command impossible — a command named `secrets_read` would sail past the string-match guard but would not compile. |
| `SecretValue` Debug/Display redaction | **PASS** | test bites | reaches-user | Made Debug print self.0: three vela-core tests failed; with only Debug broken, vela-secrets::resolved_request_material_is_redacted_when_logged also failed. Four independent canary tests across two crates bite. |
| Renderer credential surface is write-only and reaches a real UI | **PASS** | read only | reaches-user | Traced ModelWorkspace.tsx:205 -> use-providers.ts:95 -> settings-repository.ts:70 -> adapter.invoke('secrets_set') -> lib.rs:222. Three commands total (set/delete/status); `SettingsRepository` has no getCredential. |
| `KeyringStore` is the live backend in the shipped binary | **PASS** | read only | reaches-user | src-tauri/Cargo.toml:105 `default = ["os-keychain"]`; state.rs:57 `for_runtime()` picks KeyringStore under that cfg. libkeyring-*.rlib is present in target/debug/deps, so it compiles under `cargo test --workspace`. |
| A credential never appears in a rendered error | **PASS** | test bites | reaches-user | 34 tests across credential_canary / encoded_credential_canary / streamed_credential_canary pass against real ReqwestTransport and real broken loopback sockets, each with its own positive control. The load-bearing mechanism is not redaction: map_reqwest_error (http.rs:1133) emits typed TransportFailure + Diagnosis and sends reqwest's string (with .without_url()) to the debug log instead, so ProviderError has no field that can hold endpoint text. |
| Query-credential URL redaction (`RequestUrl::redacted`) | **PASS** | test bites | reaches-user | Gutted it to return the wire form: two redact.rs unit tests failed — but ALL 34 integration canaries stayed green. The mechanism the module docs call 'the one that matters' is verified only by unit tests; no integration canary depends on it. Test-cover gap, not a product defect. |
| Scrubber second barrier (decode-then-scrub) | **PASS** | test bites | reaches-user | Made `Scrubber::scrub` the identity: 8 lib tests failed (including http::tests::a_response_header_that_echoes_the_credential_is_scrubbed) plus encoded_credential_canary's `the_two_barriers_are_independent` and the header-recording decorator test. |
| Diagnostics directory is owner-only on Windows | **PASS** | hardware | reaches-user | Get-Acl on %APPDATA%\dev.vela.desktop\diagnostics right now: Protected=True, exactly NT AUTHORITY\SYSTEM + DESKTOP-298M5DU\User, both inherited=False. The fix is live on disk. |
| Something holds the DACL going forward | **PASS** | test bites | reaches-user | Made the Win32 `apply()` in private_fs.rs a no-op: 4 of 6 private_fs tests failed on real NTFS, and the failure text shows %TEMP% itself hands down four foreign ACEs, so the tests are repairing a genuinely hostile state. ci.yml:186 runs `cargo test --workspace` on windows-latest, which executes these plus the 9 ipc::diagnostics tests (one of which widens with `icacls /grant *S-1-5-32-545`). The out-of-process Get-Acl driver (tests/gate_m_debug_log_acl.rs) is #[ignore]d and does NOT run in CI. |
| Debug log is off at every launch | **PASS** | read only | reaches-user | debuglog's slot is a OnceLock<RwLock<Option<..>>> starting None; lib.rs:97 only manages the path; `git grep debug_log` over vela-settings and vela-store returns nothing, so no persistence exists. But no test proves the launch default — every ipc::diagnostics test calls debuglog::disable() first, so it asserts the state it just set. |
| Debug log contents cannot be read back through IPC | **PASS** | test bites | reaches-user | Made status_of put the log's contents into DebugLogStatus.path: `no_debug_log_response_can_carry_what_the_log_recorded` went red. Only two commands touch the log and both return {enabled, path}. |
| No credential lands in the SQLite database | **PASS** | test unproven | reaches-user | vela-settings/tests/no_plaintext_on_disk.rs drives the real service against a real file, closes it, greps db+WAL+SHM for two canaries; 3/3 pass here. Non-vacuous by construction — it asserts the keychain entry NAME (`acme/primary`) IS on disk, so a scan reading the wrong files fails loudly. I did not mutate it. |
| `scripts/secret-scan.sh` tripwire | **PASS** | hardware | n/a | Ran both: scan clean (exit 0, docs/ included, excluded_paths empty), self-test 12 passed / 0 failed — it plants real key shapes in throwaway repos and proves each is caught, so it is its own mutation harness. Wired at ci.yml:251 with the self-test running BEFORE the scan, and as `pnpm test:secrets`. Covers four shapes only (sk-ant-, sk-, AIza, PEM); an Azure/AWS/JWT-shaped secret would not match. |
| `Auth::None` never touches the keychain; no empty auth header | **PASS** | test unproven | reaches-user | resolve_auth returns AppliedAuth::None before any store access; the test drives it with an ExplodingStore whose every method panics, so it cannot pass vacuously. A bound-but-missing credential is SecretError::NotFound, never `Authorization: Bearer `. |
| Secret material escaping the `SecretValue` wrapper | **PASS** | read only | reaches-user | Five production expose() sites. http.rs:130 copies the credential into `pub headers: Vec<(String,String)>` — a plain String, not zeroized, on a public field. Bounded by a hand-written redacting Debug, redacted_headers(), the private secret_headers marker, and no Serialize impl; I found no production reader that stringifies it. SecretValue's zeroize-on-Drop is real but best-effort and should not be described as a memory guarantee. |
| `app_info.secretBackend` is honest about a fake | **PASS** | read only | reaches-user | HomeSurface.tsx:162 renders 'memory-fake (not a real keychain)' for anything but os-keychain; BrowserAdapter reports memory-fake (browser-adapter.ts:989) and holds credentials in a Map with no localStorage/sessionStorage/indexedDB anywhere in that file, so nothing is at rest in the browser runtime. |

**Could not establish:**

- `KeyringStore` against the real Windows Credential Manager at HEAD. I did not run it — a probe would have written a credential into the user's real credential store. `cmdkey /list` shows no `dev.vela.desktop` entry on this machine (958 lines, none matching), which is consistent with the prior gate cleaning up and proves nothing positive. Prior evidence exists only at commit 9540d6c.
- Whether a member of `CodexSandboxUsers` can actually open `vela.db`. I read the ACE and applied the project's own `is_private()` definition to it; I cannot impersonate that group to demonstrate the read succeeding.
- The debug log's launch default under a real launch — I was not authorised to start the app. Established by absence of any persistence mechanism, not by observation.
- Whether `Scrubber::scrub_bytes` and its chunk-boundary `hold_back_len` logic are held by anything that bites. I mutated `scrub`, not `scrub_bytes`; the streamed canary suite stayed green under that mutation, implying a separate barrier in the streaming path that I did not isolate.
- `mcp-servers.json` at rest. src-tauri/src/ipc/mcp.rs:41 reads it from the same application-data directory and an MCP entry carries `env: BTreeMap<String,String>` — where users put API tokens. The file is absent on this machine, so I have no ACL reading; it would inherit the unprotected root.
- Whether `secret-scan.sh` misses the key shapes it does not enumerate. By design it covers four; I did not plant an Azure/AWS/JWT-shaped secret to confirm the miss.
- Whether `keyring_store.rs` has changed since the desktop gate at 9540d6c in any way that would invalidate that gate's PASS. I did not diff against that commit.

## Storage, migrations and search (src-tauri/crates/vela-store)

> The migration ledger, the collision guard, the real-file upgrade path and the FTS cascade cleanup all hold and all bite under mutation — but three claims in this domain are attached to mechanisms that do not operate: `recursive_triggers` is not what makes FTS cleanup work (proved by flipping it off and running the whole suite green), the `message_parts_search_update` trigger has no write path in Vela at all, and a refused migration aborts startup with no console, no dialog and no log — the user sees a double-click that does nothing.

| aspect | verdict | evidence | shipped | finding |
|---|---|---|---|---|
| What a refused migration looks like to the user | **FAIL** | read only | reaches-user | store_host::open err -> `setup(...)?` -> `.run(...).expect("error while running Vela")` panics, and main.rs sets `windows_subsystem = "windows"` in release, so there is no console: no window, no dialog, no log (DebugLogHandle is managed after the store opens). The IPC mapping to "the local database could not be read" is unreachable because no command is ever served. |
| Dead arm: MigrationChanged for a recorded-but-unknown version | **FAIL** | read only | not-wired | migrations.rs:167-175's comment says it catches a migration file renamed away, but that case shrinks MIGRATIONS and is intercepted by the SchemaAhead check twelve lines earlier; `validate_sequence` guarantees `known` is exactly 1..=N, so only a version-0 ledger row could reach it. Cosmetic, no user impact, untested. |
| `PRAGMA recursive_triggers = ON` and the reason given for it | **FAIL** | hardware | reaches-user | sqlite.rs:99-100 says the pragma is what makes the search triggers fire under ON DELETE CASCADE. Flipping it to OFF leaves all 99 tests green, and an independent SQLite 3.45.1 probe (effective=0) shows a grandchild AFTER DELETE trigger fires under a two-level cascade regardless. Behaviour is correct; the stated mechanism is wrong and no test distinguishes the pragma's two values. |
| `message_parts_search_update` trigger | **FAIL** | hardware | not-wired | `git grep "UPDATE message_parts"` returns nothing — update_message replaces parts by DELETE (sqlite.rs:1046) + re-INSERT. Making the trigger fully inert leaves all 99 tests green. `editing_a_message_updates_what_search_can_find` reads like its test but exercises the delete/insert pair. Frozen in a checksummed migration, so it cannot be removed; record it so it is not cited as coverage. |
| A schedule run reaching a terminal success state | **FAIL** | read only | not-wired | `finish_schedule_run` has no caller outside tests; the only wired terminal writer is `reap_on_boot` (lib.rs:166), which sets status='failed', error='Vela stopped before this run finished'. So ScheduleRunStatus::Success is unreachable in the packaged app. The crate documents this at scheduler.rs:35-39 rather than hiding it. |
| Two stores on one file / concurrency | **UNVERIFIED** | hardware | reaches-user | `a_second_store_on_the_same_file_sees_the_first_ones_writes` passes on a real file, so two readers coexist under WAL and busy_timeout=5000 is set — but nothing exercises two writers racing, so whether SQLITE_BUSY ever surfaces to a user is unestablished. |
| Migration ledger + checksum tamper-evidence | **PASS** | test bites | reaches-user | Disabling the compare at migrations.rs:176 (`if false && migration.checksum() != entry.checksum`) failed exactly `a_migration_edited_after_it_was_applied_is_refused` and nothing else; `migrations::apply` runs inside `SqliteStore::open_with` (sqlite.rs:131), which `store_host::open` calls at startup. |
| `no_two_shipped_migrations_share_a_version_or_a_body` guard | **PASS** | test bites | n/a | Pointing migration 5's `include_str!` at 0004_memory.sql — the exact wave-i mistake — failed the guard on its checksum-dedup clause plus 6 other tests; the version clause is redundant with `validate_sequence`, the checksum clause is the one that earns its place. |
| Existing-database in-place upgrade against a real file (not an in-memory handle) | **PASS** | test bites | reaches-user | tests/durability.rs stands databases up at v1, v3 and v4 with `rusqlite::Connection::open(&path)` in a tempdir, writes rows, drops the connection, reopens through `SqliteStore`; deleting the 0002 backfill (the statement that only does anything on an upgrade) failed durability.rs:176 with left:0 right:1. |
| Migration unit tests are in-memory only | **PASS** | read only | n/a | migrations.rs `fresh()` (line 245) is `Connection::open_in_memory()` — true, but every one of its upgrade cases is mirrored on a real file in tests/durability.rs, and the crate module header says so; not a gap. |
| Forward-only contiguity check (`validate_sequence`) runs before any SQL | **PASS** | test unproven | reaches-user | It is the first line of `apply_list`; `a_duplicate_or_out_of_order_version_is_rejected_before_any_sql_runs` asserts zero rows in sqlite_master afterwards. I did not mutate it. |
| Per-migration transaction: a failure leaves the previous version intact | **PASS** | test unproven | reaches-user | Each migration runs in its own `conn.transaction()` (migrations.rs:189-201); `a_failing_migration_leaves_the_database_at_the_previous_version` checks the ledger and that the half-created table rolled back. Not mutated. |
| `SchemaAhead`: a database from a newer Vela is refused, not downgraded | **PASS** | test unproven | reaches-user | Checked before any migration runs (migrations.rs:157-164); tested against a synthetic ledger row at version 99. Reaches the shipped path via `apply` -> `apply_list(MIGRATIONS)`. |
| FTS index is cleaned when a conversation is deleted | **PASS** | test bites | reaches-user | Neutering `message_parts_search_delete` to `rowid = -999` failed sqlite.rs:2485 with left:2 right:0 — two orphaned index rows. Path: store_delete_conversation (lib.rs:232) -> ipc/store.rs:372 -> conversations-repository.ts:69. |
| FTS search reaches a user surface | **PASS** | read only | reaches-user | store_search registered at lib.rs:236 -> ipc/store.rs `search` -> conversations-repository.ts:79 -> use-conversations.ts:170 -> CommandPalette.tsx:114. Traced, not clicked. |
| Malformed search input is a user error, and orphan index rows cannot become phantom hits | **PASS** | read only | reaches-user | ipc/store.rs:270-294 strips every non-alphanumeric and quotes each term, so FTS5 operator syntax is unreachable from the box; `map_search_error` still downgrades a bare SQLITE_ERROR to Invalid. `search_messages` inner-joins messages and conversations (sqlite.rs:1116-1118), so a stale index row shows a user nothing. |
| Title search treats LIKE metacharacters literally | **PASS** | test unproven | reaches-user | `instr(lower(c.title), lower(?1)) > 0` rather than LIKE (sqlite.rs:772-777), so searching `100%` finds `100%`; `title_search_treats_like_metacharacters_as_literal_text` covers it. Not mutated. |
| Foreign-key enforcement verified on open | **PASS** | test bites | reaches-user | Setting the pragma to OFF at sqlite.rs:106 made every open return Backend{"SQLite refused to enable foreign key enforcement"} and failed `a_file_database_gets_wal_journalling_and_foreign_key_enforcement`. The lib.rs guarantee table's claim is real. |
| WAL journalling: enabled, verified on open, sidecar on disk | **PASS** | hardware | reaches-user | `PRAGMA journal_mode = WAL` is read back and the open errors if the answer is not `wal` (sqlite.rs:112-121); `wal_leaves_its_sidecar_files_beside_the_database` asserts vela.db and vela.db-wal are both real files in a tempdir, and it ran green here. |
| Durability under an unclean shutdown (hot WAL recovery) | **PASS** | hardware | reaches-user | Vela's five migration files applied verbatim under journal_mode=WAL + synchronous=NORMAL on this NTFS volume, then os._exit(9) with a 403,792-byte uncheckpointed WAL: a fresh process recovered conversation, message, part AND the FTS row, integrity_check ok. Measured outside Vela's Rust — the crate itself ships no unclean-shutdown test; its durability test is a clean drop. |
| Credential-free schema | **PASS** | test unproven | reaches-user | Two independent guards: a static scan of every MIGRATIONS body with comments stripped (migrations.rs:666-701) and a live `PRAGMA table_info` sweep of every table in a migrated database (sqlite.rs:2961-3006). Both are real code, both green; not mutated. |
| Schedules and their run history survive a restart | **PASS** | hardware | reaches-user | `a_schedule_and_its_run_history_survive_a_restart_and_still_fire` writes a real file, fires, closes the run, drops the connection, reopens, checks next_run_at moved to NOON+24h and re-fires from the reopened database. Ran green. |
| Default project seeded by a migration, not lazily on first read | **PASS** | test bites | reaches-user | Migration 0005 inserts it under WHERE NOT EXISTS; swapping migration 5's body (M3) failed `the_default_project_is_seeded_by_a_migration_rather_than_at_first_read` and `upgrading_an_existing_database_seeds_the_default_without_disturbing_what_is_there`, which also proves the seed survives an upgrade alongside a user's own project. |

**Could not establish:**

- Nothing was run against the app itself — I am not the auditor authorised to launch it. Every `reaches-user` grade is a traced call path (registered command -> IPC function -> TS repository -> React surface), not an observed click. In particular the silent-startup-failure finding (§4) is a code trace, not something I watched happen.
- The crash-recovery result went through Python's SQLite 3.45.1 executing Vela's migration DDL, not through `SqliteStore::open`. WAL recovery is entirely SQLite's, so I believe it transfers, but I did not prove Vela's own Rust recovers a hot WAL.
- Write-write contention: `busy_timeout = 5000` is set and two connections coexist for reads, but no test races two writers. Whether 5 s is enough, or whether `SQLITE_BUSY` can reach a user as an error, is unestablished.
- The real per-user application-data directory. `store_host::database_location` needs a live Tauri AppHandle; every test substitutes a tempdir, so `%APPDATA%\<identifier>` resolution on this machine is untested.
- Memory, projects and settings behaviour was read and their tests observed green, but I did not mutate any of them — the mutation budget went to migrations, the FTS index and the pragmas, where being wrong costs most. Their `test-only-unproven` grades should be read as exactly that.
- Whether FTS rows are cleaned on a single-message delete is asserted by no test (only the conversation-level cascade is). The mechanism is a strict subset of what I proved, and the inner join in `search_messages` makes a miss invisible to users, so I did not chase it — but it is not proven.
- Migration 0005 stamps the seeded project's timestamps from `strftime('%s','now') * 1000`, bypassing the injected Clock and losing millisecond precision. No test pins it and I did not grade it.

---

Each auditor's full reasoning, with the literal commands and output behind these grades, is in `docs/audit/<domain>.md`.
