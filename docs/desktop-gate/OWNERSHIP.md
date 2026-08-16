# Module ownership — one repo, possibly two sessions

Two sessions on one repo will swallow each other's commits. Anything you are about to touch, claim
here first, by module, with a timestamp and a session id. Never touch a module claimed by another
session without an explicit release entry below.

Sessions: `desktop` (this Windows machine, builds and orchestrates) · `cloud` (retired 2026-08-14,
see `docs/HANDOVER.md`).

## Worktrees

| path | branch | holder |
|---|---|---|
| `C:/Users/User/vela-tmp` | `claude/new-session-tgl1ut` | lead |
| `C:/Users/User/vela-wt-guards` | `fix/guards-that-bite` | Wave 1 / B7 |
| `C:/Users/User/vela-wt-caps` | `fix/capability-union` | Wave 1 / caps |
| `C:/Users/User/vela-w2-harness` | `wave2/click-harness` | Wave 2 / click harness |
| `C:/Users/User/vela-w2-sched` | `wave2/schedules-surface` | Wave 2 / schedules |
| `C:/Users/User/vela-w2-proj` | `wave2/project-instructions` | Wave 2 / projects |
| `C:/Users/User/vela-w2-prov` | `wave2/provider-selection` | Wave 2 / provider selection |
| `C:/Users/User/vela-w2-endpoint` | `wave2/endpoint-control` | Wave 2 / endpoint control |
| `C:/Users/User/vela-w2-canvas` | `wave2/canvas-host-boundary` | Wave 2 / canvas host boundary |

`vela-wt-privatefs` is gone; `wave-g/private-fs` still exists as a branch. Removed with
`fix/sandbox-process-limit`, `fix/verify-on-windows`, `fix/dead-skill-mount`, `fix/real-bundle`
and `fix/guard-tokeniser-phase` once each was merged and confirmed an ancestor of `HEAD` with
`git merge-base --is-ancestor` — **not** with `git branch --merged`, whose output this session has
already misread once. Note `git worktree remove` fails with *"Directory not empty"* when
`node_modules` is a junction; unlink the junction with `[System.IO.Directory]::Delete(path, false)`
first, or the reclaim silently does not happen.

## Active claims

| module / path | session | claimed (UTC) | purpose |
|---|---|---|---|
| `src/platform/no-provider-leak.test.ts` | desktop | 2026-08-14 | carrier allowlist never matches on Windows |
| `docs/references/*` | desktop | 2026-08-14 | Phase 1 reference studies, under correction after a PASS |
| `src/features/models/EndpointsPanel.test.tsx`, `src/features/models/ModelWorkspace.test.tsx`, `src/app/modal-containment.test.tsx`, `src/app/memory-payload.test.tsx`, `src/features/conversation/ConversationSurface.test.tsx` | Wave 1 / load flake | 2026-08-15 | the load flake: `userEvent`'s per-input-step scheduler tick and cold `import('@/app/App')` inside a test body |
| `src/features/models/EndpointsPanel.test.tsx`, `src/app/memory-payload.test.tsx`, `src/app/modal-containment.test.tsx` | Wave 1 / flake | 2026-08-15 | the load artefact, now named: three jsdom files timing out at the default under CPU+IO contention |
| `src/platform/capability-surface.ts`, `src/app/shell/window-controls.test.tsx`, `src/platform/project-host-parity.test.ts` | Wave 1 / caps | 2026-08-15 | both capability guards read one filename out of a directory the build reads whole; the union is now derived from `tauri.conf.json` |
| `tests/harness/desktop-click/**`, `package.json` (two script lines) | Wave 2 / click harness | 2026-08-15 | **new directory, nothing existing touched except two lines of `package.json`:** a `test:click-harness` script and its place in `verify`. The scriptable way to launch Vela, click its real UI and read what it shows. `docs/desktop-gate/OWNERSHIP.md` edited for this row and the worktree table only |
| `src-tauri/crates/vela-providers/src/router.rs`, `src-tauri/crates/vela-providers/src/event.rs`, `src-tauri/src/provider_host.rs`, `src-tauri/src/ipc/chat.rs`, `src-tauri/tests/routed_turn.rs`, `src-tauri/tests/composition_root.rs`, `src-tauri/examples/ui_matrix_bridge.rs` | Wave 2 / provider selection | 2026-08-16 | `Router` had no caller outside its own crate: `chat_send` called `provider.stream` directly, so bounded retry, backoff, `Retry-After` and the never-fail-over-after-first-output rule were dead in the product |
| `src-tauri/crates/vela-core/src/protocol.rs`, `src-tauri/crates/vela-core/src/lib.rs`, `src-tauri/crates/vela-settings/src/{provider_config,view,service}.rs`, `src-tauri/src/ipc/settings.rs`, `src-tauri/tests/adapter_parity_fixture.rs`, `src/platform/{contract,browser-adapter}.ts`, `src/features/models/{EndpointForm.tsx,EndpointForm.test.tsx,EndpointsPanel.tsx,use-providers.ts,catalogue.test.ts,ModelSwitcher.test.tsx}` | Wave 2 / provider selection | 2026-08-16 | `ProviderHost::build` took no decision: ~5,000 lines of Anthropic and Google adapter were reachable only from their own tests. Closed with a **user-declared** `WireProtocol` — never inferred from a URL — carried to the renderer as an opaque token with the catalogue supplied as data |
| `src/features/skills/**`, `src/state/skills-store.ts`, `src/app/skills-reachable.test.tsx`, `src/app/App.tsx`, `src/features/navigation/Sidebar.tsx` | Wave 2 / skills surface | 2026-08-16 | `src/data/skills-repository.ts` was correct, tested and off the import graph — its only importer was its own test. A skills pane, the sidebar control that opens it and the composition-root mount put `skills_list` / `skills_read` behind something a user can press. `src/data` is ungoverned by `src/runtime/reachable.test.ts`; two orphans remain there (see below) |
| `src/data/schedules-repository.ts`, `src/features/schedules/**`, `src/state/schedules-store.ts`, `src/app/schedules-wiring.test.tsx`, and the schedules lines only of `src/app/App.tsx` and `src/features/navigation/Sidebar.tsx` | Wave 2 / schedules | 2026-08-16 | the renderer half of the five `schedules_*` commands, which were registered, allowlisted, declared and faked with **no caller under `src/data/` or `src/features/`** — the poll thread ran every thirty seconds over a table nothing could add a row to. Worktree `C:/Users/User/vela-w2-sched`, branch `wave2/schedules-surface`. No Rust touched |
| `src-tauri/src/endpoint_host.rs`, `src-tauri/src/ipc/endpoint.rs`, `src-tauri/crates/vela-endpoint/src/server.rs`, `src-tauri/tests/endpoint_runtime_control.rs`, `src/data/endpoint-repository.ts(+test)`, `src/features/models/LocalEndpointSection.{tsx,module.css,test.tsx}`, `src/features/models/use-local-endpoint.ts`, `docs/local-endpoint.md` | Wave 2 / endpoint control | 2026-08-16 | the endpoint had no start/stop/rebind entry point and no user-facing switch, and the comment explaining that was false. Also touched, additively only: `src-tauri/src/{lib.rs,ipc/mod.rs}`, `src/platform/{contract.ts,browser-adapter.ts}`, `src/features/models/{EndpointsPanel.tsx,index.ts}`, `README.md`. **`src/features/models/EndpointsPanel.test.tsx` is claimed by Wave 1 and was NOT edited** — the new section's endpoint menu was reworded to `name (id)` so its `getByText` queries stay unambiguous |
| `src/runtime/app-runtime.ts`, `src/runtime/project-context.ts`, `src/runtime/project-context.test.ts`, `src/runtime/app-runtime.test.ts`, `src/data/projects-repository.ts`, `src/state/project-store.ts`, `src/features/projects/`, `src/app/App.tsx`, `src/app/project-instructions.test.tsx`, `src/features/conversation/use-conversation.ts`, `src/features/conversation/ConversationSurface.tsx`, `src/features/conversation/ConversationView.tsx`, `src/features/conversation/MessageTurn.tsx`, `src/features/conversation/TurnNotices.tsx`, `src/features/conversation/notices.ts`, `src/features/conversation/agent-run.test.tsx`, `src/features/navigation/Sidebar.tsx`, `src/features/memory/MemoryPanel.tsx`, `src/platform/contract-harness.ts` | Wave 2 / project instructions | 2026-08-16 | `readProjectInstructions` answered `null` for every project under a false comment, so the whole project-context layer was dead; and `App.tsx` passed `DEFAULT_PROJECT_ID` literally while `use-conversation.ts` fell through to the same constant, so one project's context served every run |
| `src/features/canvas/CanvasSurface.tsx`, `src/app/App.tsx` | Wave 2 / project instructions | 2026-08-16 | **collides with `wave2/canvas-host-boundary` in `C:/Users/User/vela-w2-canvas`, in two files — see the note below. A careless resolution silently restores the defect this branch removed.** |
| `src/features/canvas/**`, `src/data/sandbox-repository.ts`, `src/data/sandbox-repository.test.ts`, `src/app/App.tsx`, `src/app/canvas-wiring.test.tsx`, `src/runtime/reachable.test.ts`, `src/platform/contract-sandbox.ts` (amendment 6 + honesty note 1 only) | Wave 2 / canvas host boundary | 2026-08-16 | `CanvasSurface` built `new LocalDocumentHost()`, so `permissionIsOff`, the approval, the digest and the wall clock were held by the renderer they constrain. It now takes a `SandboxRepository` built at the composition root. `LocalDocumentHost` demoted to `document-host-double.ts`; `autoApproves` moved there with it. **No shape changed in `contract-sandbox.ts`** — one clause of honesty note 1 was narrowed because the wiring falsified it |

### `wave2/project-instructions` × `wave2/canvas-host-boundary` — resolve by hand, in this order

> **Status, 2026-08-16: both branches have landed. This section is history, kept for the
> resolution it records.** `wave2/project-instructions` merged first, then
> `wave2/canvas-host-boundary`. The union below is what shipped; the paragraph numbered 1 is the
> one that mattered, and both critics derived the same answer independently:
>
> ```tsx
> const sandbox = useMemo(() => createSandboxRepository(adapter), [adapter]);
> const projectId = useActiveProjectId();
> …
> <CanvasSurface assistantTexts={answers} projectId={projectId} sandbox={sandbox}>
> ```
>
> Taking either side alone loses something real: the canvas side re-introduces
> `DEFAULT_PROJECT_ID` at the exact point the other branch removed it — every conversation in
> every project running as the default, which is invisible with one project — and the
> project-instructions side drops `sandbox={sandbox}` and with it the whole boundary move.
> In `CanvasSurface.tsx` the shipped shape is `projectId: ProjectId | null` **and**
> `sandbox: SandboxRepository`, with `host?: DocumentHost` deleted: the renderer-side host is
> what that branch existed to remove, and an optional prop is somewhere for it to live again.

Both branches are based at `e563575` and both rewrite **the same two files**. Read this before
merging either; the shapes below were read out of the two branches with `git show`, not assumed.

**`src/app/App.tsx` — three overlapping edits, one of them dangerous.**

1. **Line 137, the `CanvasSurface` element.** `wave2/canvas-host-boundary` has
   `projectId={DEFAULT_PROJECT_ID}` and adds `sandbox={sandbox}`;
   `wave2/project-instructions` has `projectId={projectId}`, from `useActiveProjectId()`.
   **Taking the canvas side of this line re-introduces `DEFAULT_PROJECT_ID` at the exact point
   this branch removed it** — which is mutation M3 in the project-instructions commit message,
   and it is caught only by `src/app/project-instructions.test.tsx`. The merged line needs *both*
   changes: `projectId={projectId} sandbox={sandbox}`.
2. **The import block.** Canvas keeps `import { DEFAULT_PROJECT_ID } from '@/platform/contract-project'`;
   project-instructions replaces it with `import type { ProjectId }` plus
   `import { ProjectsSurface, useActiveProjectId } from '@/features/projects'`. Keeping the canvas
   import is how (1) gets re-introduced quietly after being fixed.
3. **The `Workspace` doc comment.** Both rewrite the paragraph beginning "`DEFAULT_PROJECT_ID` is
   passed literally". The canvas side still contains that sentence, which is false once (1) is
   resolved correctly.

**`src/features/canvas/CanvasSurface.tsx`.** Canvas adds a required `sandbox: SandboxRepository`
prop and passes it to `CanvasPanel`; project-instructions widens `projectId` to `ProjectId | null`
and changes the panel guard to `openTrack !== null && projectId !== null`. These are compatible and
both are wanted — the widening exists because the composition root has no constant left to pass
before `project_list` answers.

## Released

| module / path | sha | outcome |
|---|---|---|
| `src/platform/chat-contract-parity.test.ts` | `7e3ad40` | CRLF fixed; mutation-proven to catch drift |
| `src/platform/claimed-guards.test.ts` | `7e3ad40` | floor 4→2 words, path rule tightened, four controls added |
| `docs/vela-state-2026-08-14.md` | `b02a848` | verified state read |
| `src-tauri/crates/vela-providers/src/private_fs.rs` | `960ddce` (`wave-g/private-fs`) | compiled and wired — **awaiting critic, not yet merged** |
| `src-tauri/src/ipc/diagnostics.rs` | `960ddce` (`wave-g/private-fs`) | fails closed on a directory that cannot be made private |
| `scripts/run-bash.mjs`, `.gitattributes`, `.github/workflows/ci.yml`, `README.md` | `7f5cd93` (`fix/verify-on-windows`) | `pnpm verify` reaches its last gates on Windows; the launcher refuses the WSL `bash.exe` against a compiled decoy |
| `scripts/ci-retry-vitest-crash.mjs` | `7f5cd93` | crash-retry wrapper. Took three rounds — it could launder a real regression, because its verdict check keyed only on end-of-run signals while an inline failure prints ~6.5s earlier |
| `src-tauri/crates/vela-sandbox/**` | `4949578` (`fix/sandbox-process-limit`) | per-run process limit via cgroup v2 `pids.max`. `RLIMIT_NPROC` is per-uid, so a second concurrent run forked **zero**. Landed gate 2 green for the first time |
| `src-tauri/crates/vela-skills/src/{mount,enablement}.rs` | `730eca5` (`fix/dead-skill-mount`) | deleted, 1237 lines with no caller. The parity test guarding them also guarded live types, so it was split and renamed rather than repointed |
| `src-tauri/rust-toolchain.toml`, `src-tauri/tauri.conf.json`, `docs/release-posture.md` | `9baf471` (`fix/real-bundle`) | `bundle.icon` had no `.ico`, so `targets: "all"` produced nothing behind a green build. Pin verified inert for both gates. **No `reaches-user` grade** — the install landed in the MSIX container |
| `src/platform/contract.test.ts`, `src/app/shell/window-controls.test.tsx`, `src-tauri/src/ipc/mod.rs` | `fix/guards-that-bite` | Three guards that did not bite, each hole measured at the base first. The capability grant was a **prefix shape**, so four new `core:window:` permissions passed 38/38. `contract.test.ts` checked exhaustiveness against a **hand-typed** key list. The secrets guard was one string, so `secrets_reveal` passed. Both secrets guards turn out to be real at different strengths, and the **limit is measured**: a command returning `SecretValue` is refused, one returning `String` from `expose()` compiles cleanly |
| `EndpointsPanel`, `ModelWorkspace`, `modal-containment`, `memory-payload`, `ConversationSurface` test setups | `fix/endpoints-timeout` | The wave-long load artefact, diagnosed. **Two mechanisms, neither fixable by a timeout.** `userEvent`'s default `delay: 0` yields once per input step and a `setTimeout(0)` turn costs **14.3–15.1ms whether idle or loaded**; and a dynamic `import('@/app/App')` inside a test body is charged to that test's timeout — 2193ms idle, up to 25707ms loaded, in a test using no `userEvent` at all. A critic reproduced **9 distinct tests failing at base, 0 at head**, interleaved so drift hit both sides equally, with 13 mutations covering all 46 changed-setup tests. `{ timeout: 10_000 }` was **removed**, not added: it did not prevent the failure and it doubled hang detection, 5014ms → 10013ms |
| `src-tauri/crates/vela-privatefs/**`, `vela-store/src/location.rs`, `src/lib.rs`, `src/fatal.rs` | `eda3d95` (`fix/appdata-owner-only`) | Five rounds, and the last four were about the prose, not the ACL work. **A deny ACE read as granting** — the decision sat inside an `unsafe` block no test could reach; the reachable consequence is not a refusal to start but `repair_within` **silently deleting an administrator's lockout ACE** on a routine startup, the read-back then confirming the result private *because it is*. A retracted claim shipped verbatim **1010 lines below its own retraction**; the guard built from that failure **could not see the defect it was built for**, its needle being single-line while the phrase was always wrapped. Every needle is now proven against the defect's own bytes from git |
| `src/platform/verify-covers-ci.test.ts` | `e585eb9` (`fix/capability-union`) | The capability defect one directory over: the CI guard read `.github/workflows/ci.yml` by name, and GitHub Actions runs every file in that directory. Hole measured at the base first — a second workflow with an unlisted gate, the crash-retry wrapper on a second job, and `cargo build` on a bare runner left it **16/16 green**. Now enumerates the directory, asserts over the union, pins the file list by name, and identifies a job by **file and name** so the wrapper is confined to one job in one file. Four unreadable inputs refused rather than read past. **Probing the reader found a hole in the reader**: the job indent was taken from the first header-*shaped* line, which is the nested `steps:` key when the real job key wears a trailing comment — two gates counted under two jobs named `steps`, green. Depth is now read off the block. **No critic grade** |
| `src/platform/verify-covers-ci.test.ts` | `b2cf32d` (`fix/capability-union`) | The refusals `e585eb9` added read the `uses:` value as a raw token, and a raw token carries its quotes. `"./.github/actions/foo"` begins `"`, not `./`, so it missed both arms and fell off the end **allowed** — a composite action in this repo, whose `run:` steps this reader cannot see, admitted because somebody quoted the path. Hole measured at the base with the defect's own bytes, not a reconstruction: that one line in `ci.yml`'s `static` job left the file **17/17 green, twice**, and green again single-quoted; unquoted it is refused. The value is now parsed, not tokenised, and a half-quoted value is refused rather than guessed at either way. 19 tests, five mutations, every red reproduced twice: reverting the parser alone kills 12; removing the allowance branch kills exactly the four local-reusable-workflow rows, of which the two **quoted** ones were the pair that had been allowed by falling off the end (the two unquoted ones went through the allowance branch before the fix too, and are its controls); dropping stop-at-whitespace kills the three trailing-comment rows; widening the remote arm dies on `ci.yml` at module load; silently unquoting a half-quoted value kills that one case alone. One row — `actions/checkout@v4`, unquoted and uncommented — reddens under no parser mutation and is a **control**, not coverage. **FAILED review — superseded by the row below** |
| `src/platform/verify-covers-ci.test.ts` | `8cea9d0` (`fix/capability-union`) | The critic's FAIL on `b2cf32d`, fixed: unquoting the `uses:` value left the identical hole for the spellings where the value **is not on the line** — `uses:` with the target below it, or a block scalar. `usesValue` called those *not a `uses:` line* and returned `undefined`, which is the one report a reader of this kind must never make, and handed `>-` to the arms as if it were a target. Measured on `ci.yml`'s bytes, one step in `static`, each twice: the one-line spelling is refused; all three off-the-line spellings left the file **36/36 green**. `yaml.safe_load` resolves all four to the same string — checked, not assumed. So `b2cf32d` took the set of spellings that hide a composite action from three to two. `UsesValue` now carries an `elsewhere` case beside `unterminated`, refused at the same call site. Six tests, both halves of the arm proven separately and each red twice: the pre-fix parse kills all 6; the block-scalar half alone kills 4; the empty-remainder half alone kills 2; keeping the parse and dropping the refusal kills 6 on the other assertion. Earlier matrix re-confirmed unchanged (M1 now 18, subsuming the new 6). **Whether GitHub's parser accepts every one of these forms is NOT established** — deliberately not relied on: a line reader that cannot see the value must refuse either way. **Critic PASS.** Re-verified independently: eight spellings inserted into `ci.yml` one at a time, each run twice, all sixteen refused at module load. The critic found a **sixth** spelling — plain `\|`, like plain `>`, resolves with a trailing newline — and confirmed both newline-keeping forms have their own rows and are refused. It also ran the complementary mutation the builder did not: keeping the refusal arm and corrupting only the `raw` payload reddens 6 on the *first* assertion while the throw still matches, so each of the two assertions per row catches something the other does not, **proven in both directions**. One non-blocking imprecision left open: on the over-refused `with:`-parameter case the message still asserts "a composite action written this way would reach CI unread", which is false for that line — it names the exact line, so a reviewer resolves it in one look |
| `src/platform/claimed-guards.test.ts` | `fix/guard-tokeniser-phase` | Fixed twice: the first fix kept a cursor and kept a hole, the second removed the cursor. A regex tokeniser's cursor has a phase, and **anything the pattern declines takes the phase with it** — so it now `split`s on backticks and matches nothing. Nine claims surfaced across both fixes, all real. An exhaustive differential over 2,441,406 strings found zero disagreements with a reference |

## Rules

1. One git index per wave. Parallel builders get **separate git worktrees**, never the shared index.
2. **A critic that mutates gets its own worktree too.** Learned the hard way on wave G: a critic
   was told to mutation-test in the shared worktree and revert afterwards, which it did correctly —
   but while it ran, its probes were in the lead's tree. A full-suite reading taken during that
   window was contaminated, and a commit taken during it would have carried `zzq_fence_gamma` into
   the history. Read-only critics may share; anything that writes may not.
3. Push every cycle. Unpushed work is invisible work — the cloud session lost five commits and
   47 source files to exactly this, and said so in its handover.
4. Verify a push by fetching and comparing shas. A clean `git push` is not evidence; this session
   has already reported PUSHED for a commit that was not on the remote.
5. Pull before every wave. If HEAD moved, re-read state before proceeding.
6. A claim is released by moving its row to **Released** with the sha that finished it.
7. A builder never grades its own work, and the lead never grades its own either. Critics are
   fresh-context and run the commands themselves.
8. **This file is the only registry.** `docs/OWNERSHIP.md` was created during Wave 1 because the
   lead sent two builders to that path without checking it existed. A second registry is worse
   than none: two agents each claim correctly, in different files, and neither finds the other.
   That file now points here.
9. **Use a uniquely-named scratch subdirectory.** A critic's scratch clone was replaced mid-run by
   another agent's clone of a different repository state — different reflog origin, different
   `node_modules` shape, and a HEAD commit absent from this object store. It noticed only because
   it checked its workspace identity. **Verify at the end that the directory you measured is the
   one you created**, and prefer a name carrying the branch and a stamp.
10. Linked worktrees share one object store. A transient `Permission denied` writing a loose object
   has been seen under concurrent git use; `git fsck --connectivity-only` reported dangling objects
   only, no broken links. If you see it, verify the object landed rather than assuming either way.

## Hazards that manufacture red — and one that manufactures green

The first two produce a failing test for a reason unrelated to the change under test. That is worse
than a crash, because a red is what you are looking for when you mutation-test — so both arrive
disguised as the exact evidence you came for. The last one is worse still, and is at the bottom.

**Parallel load fabricates failures.** A full `vitest` run with a fixed mutation gave `4 files /
12 tests failed`; the very next run, byte-identical input, gave `104 / 2105 passed`. The failing
run spent 1088s in `environment` against 314s. Two further agents and the lead have each hit it
independently. **Reproduce anything red at least twice.** The direction that matters more is the
reassuring one: **a mutation that reddens once is not proof that a test bites** — a vacuous guard
can pass its mutation proof purely because the machine was loaded.

**`Set-Content -Encoding utf8` writes a BOM in Windows PowerShell 5.1.** A mutated `main.json`
became unparseable and surfaced as `SyntaxError: Unexpected token U+FEFF` inside `JSON.parse` —
**a test failure, not a write error**, at exactly the moment the builder was looking for one. Safe
writes on this box: Python with `newline='\n'`, or the Write/Edit tools. Not `Set-Content` or
`Out-File` from 5.1. Byte-check after writing a file another tool will parse.

**Corroboration of a hazard is not corroboration of an instance.** When one agent reports an
unexplained red and another has independently seen the load hazard, that establishes the hazard
exists — not that this red was it. An unnamed single failure stays unestablished until a **name**
repeats. Capture the failing test name (`--reporter=verbose`, or tee the whole log) rather than
filtering to the summary, so a recurrence can be compared.

### `git checkout -- <path>` can rewrite the file it restores, and `git status` will not say so

This repository has `core.autocrlf=true` from the system gitconfig and **no `* text=auto` rule**.
The working tree is mixed: `vela-drive.mjs` is CRLF on disk, `keys.mjs` and `keys.test.mjs` are LF.
Restoring an LF file with `git checkout -- <path>` **writes it back as CRLF**, and because the
filter normalises on the way in, `git status` still reports the tree clean.

That makes the standard "put it back the way I found it" move a silent mutation. It was caught once
today only because the agent had recorded a raw hash before touching the file — `git status` said
clean, and the bytes on disk were not the bytes it started with.

**Restore from a byte snapshot you took yourself, and verify by hash, not by `git status`.** Take
the hash before the first edit; compare after the last. A related and harmless follow-on: writing a
file invalidates git's index stat cache, after which git may report an LF file as ` M` even though
its *filtered* content matches the blob. `git add` on identical content resyncs the stat and changes
no blob and no tree — `git diff --cached HEAD` stays empty — so that particular ` M` is noise, not a
change. Distinguish the two cases by hashing; do not assume either way.

This is the third line-ending hazard on this project, after the 58-of-106 CRLF-vs-store mismatch at
Wave 1 gate 4 and the pure-LF `cargo fmt` failure at gate 2. The common cause is the missing
`.gitattributes` coverage, and until that is closed every byte-exact operation here has to defend
itself.

### A pipeline reports the exit status of the *last* command, so a gate can fail green

This one cost nothing only because the log was read anyway. Running the gate as

```bash
pnpm verify 2>&1 | tail -60; echo "VERIFY_EXIT=${PIPESTATUS[0]}"
```

makes the shell's own exit status that of `echo`, which is always `0`. The task harness reports
**"completed (exit code 0)"** while `VERIFY_EXIT=1` sits in the body of the log. An agent that
trusts the notification — or that greps the tail for `error` and finds none, because the failure
was thirty lines up — reports a green gate that never ran.

Two separate faults compound here, and both are worth knowing on their own:

- **`cargo` is on no shell's `PATH` in this environment — not Bash, not PowerShell.** The binary is
  real and sits at `C:\Users\User\.cargo\bin\cargo.exe`; the directory holding it is simply absent
  from `PATH`, and `rustup` is not resolvable either. `pnpm verify` therefore dies at gate 2
  (`lint:rust`) with `'cargo' is not recognized` — a **cmd.exe** message, because that is what pnpm
  shells out to on Windows — having run `typecheck` and nothing else. Every gate behind it (the
  whole `vitest` suite, the harnesses, the build, the transcript and secret guards, and the entire
  Rust workspace) is skipped, not passed. Prepend the directory before running the gate:

  ```
  $env:PATH = "C:\Users\User\.cargo\bin;$env:PATH"
  ```

  Do not conclude from a green `typecheck` that the Rust side was checked. The honest tell that the
  tail really ran is physical: `src-tauri/target/debug/deps` fills with **test binaries**, which
  only `cargo test` produces — `cargo build` alone does not.
- **Never let a reporting command be the last in the pipeline.** Check the status directly
  (`pnpm verify; echo "EXIT=$?"` with no pipe), or tee to a file and read the file. A gate whose
  result you learned from a notification rather than from its own output has not been verified —
  which is the same rule as `reaches-user`, applied to the toolchain instead of the product.
