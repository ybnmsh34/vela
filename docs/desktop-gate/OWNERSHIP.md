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
| `C:/Users/User/vela-wt-dacl` | `fix/appdata-owner-only` | Wave 1 / B4a |
| `C:/Users/User/vela-wt-guards` | `fix/guards-that-bite` | Wave 1 / B7 |

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
| `src/platform/contract.test.ts`, `src/app/shell/window-controls.test.tsx`, `src/platform/project-host-parity.test.ts`, `src-tauri/src/ipc/mod.rs` | Wave 1 / B7 | 2026-08-15 | three guards that do not bite: a shape-not-exact-set capability assertion, a hand-written contract key list, a one-string secrets check |
| `src-tauri/crates/vela-privatefs/**`, `src-tauri/crates/vela-store/src/location.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/fatal.rs` | Wave 1 / B4a | 2026-08-15 | app-data owner-only; deny-ACE reading, walk error attribution, pre-window fatal dialog |

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

## Two hazards that manufacture red, and why they are dangerous

Both produce a failing test for a reason unrelated to the change under test. That is worse than a
crash, because a red is what you are looking for when you mutation-test — so both arrive disguised
as the exact evidence you came for.

**Parallel load fabricates failures.** A full `vitest` run with a fixed mutation gave `4 files /
12 tests failed`; the very next run, byte-identical input, gave `104 / 2105 passed`. The failing
run spent 1088s in `environment` against 314s. Two further agents and the lead have each hit it
independently. **Reproduce anything red at least twice.** The direction that matters more is the
reassuring one: **a mutation that reddens once is not proof that a test bites** — a vacuous guard
can pass its mutation proof purely because the machine was loaded.

**`Set-Content -Encoding utf8` writes a BOM in Windows PowerShell 5.1.** A mutated `main.json`
became unparseable and surfaced as `SyntaxError: Unexpected token '﻿'` inside `JSON.parse` —
**a test failure, not a write error**, at exactly the moment the builder was looking for one. Safe
writes on this box: Python with `newline='\n'`, or the Write/Edit tools. Not `Set-Content` or
`Out-File` from 5.1. Byte-check after writing a file another tool will parse.

**Corroboration of a hazard is not corroboration of an instance.** When one agent reports an
unexplained red and another has independently seen the load hazard, that establishes the hazard
exists — not that this red was it. An unnamed single failure stays unestablished until a **name**
repeats. Capture the failing test name (`--reporter=verbose`, or tee the whole log) rather than
filtering to the summary, so a recurrence can be compared.
