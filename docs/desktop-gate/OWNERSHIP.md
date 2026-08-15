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
| `C:/Users/User/vela-wt-bundle` | `fix/real-bundle` | Wave 1 / B2 |
| `C:/Users/User/vela-wt-dacl` | `fix/appdata-owner-only` | Wave 1 / B4a |
| `C:/Users/User/vela-wt-guards` | `fix/guards-that-bite` | Wave 1 / B7 |
| `C:/Users/User/vela-wt-tokeniser` | `fix/guard-tokeniser-phase` | Wave 1 / tokeniser |

`vela-wt-privatefs` is gone; `wave-g/private-fs` still exists as a branch. Removed with
`fix/sandbox-process-limit`, `fix/verify-on-windows` and `fix/dead-skill-mount` once each was
merged and confirmed an ancestor of `HEAD` with `git merge-base --is-ancestor` — **not** with
`git branch --merged`, whose output this session has already misread once. Note `git worktree
remove` fails with *"Directory not empty"* when `node_modules` is a junction; unlink the junction
with `[System.IO.Directory]::Delete(path, false)` first, or the reclaim silently does not happen.

## Active claims

| module / path | session | claimed (UTC) | purpose |
|---|---|---|---|
| `src/platform/no-provider-leak.test.ts` | desktop | 2026-08-14 | carrier allowlist never matches on Windows |
| `docs/references/*` | desktop | 2026-08-14 | Phase 1 reference studies, under correction after a PASS |
| `src-tauri/rust-toolchain.toml` | Wave 1 / B2 | 2026-08-15 | new file — pins 1.97.1 + rustfmt/clippy, so gate 2's answer stops floating with the calendar |
| `src-tauri/tauri.conf.json` | Wave 1 / B2 | 2026-08-15 | one line added to `bundle.icon` — `icons/icon.ico`, without which the Windows bundler produces no installer at all |
| `docs/release-posture.md` | Wave 1 / B2 | 2026-08-15 | new file — signing, updater, WebView2, elevation and uninstall posture, plus the MSIX-container finding that withdrew B2's install claim |

## Released

| module / path | sha | outcome |
|---|---|---|
| `src/platform/chat-contract-parity.test.ts` | `7e3ad40` | CRLF fixed; mutation-proven to catch drift |
| `src/platform/claimed-guards.test.ts` | `7e3ad40` | floor 4→2 words, path rule tightened, four controls added |
| `docs/vela-state-2026-08-14.md` | `b02a848` | verified state read |
| `src-tauri/crates/vela-providers/src/private_fs.rs` | `960ddce` (`wave-g/private-fs`) | compiled and wired — **awaiting critic, not yet merged** |
| `src-tauri/src/ipc/diagnostics.rs` | `960ddce` (`wave-g/private-fs`) | fails closed on a directory that cannot be made private |

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
