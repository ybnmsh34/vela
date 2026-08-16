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

### `wave2/project-instructions` × `wave2/canvas-host-boundary` — resolve by hand, in this order

> **Status, 2026-08-16: `wave2/project-instructions` has landed on the integration branch.**
> Only `wave2/canvas-host-boundary` remains. It is still based at `e563575`, so the conflicts
> below are the ones it will raise when it is merged forward — but the sides have swapped:
> what is described as "the project-instructions side" is now *what is already in the tree*,
> and it is the side to keep. The canvas branch must be rebased, not merged blind.

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
