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
| `C:/Users/User/vela-wt-privatefs` | `wave-g/private-fs` | wave-G builder |
| `C:/Users/User/vela-wt-tokeniser` | `fix/guard-tokeniser-phase` | tokeniser-phase builder |

## Active claims

| module / path | session | claimed (UTC) | purpose |
|---|---|---|---|
| `src/platform/no-provider-leak.test.ts` | desktop | 2026-08-14 | carrier allowlist never matches on Windows |
| `docs/references/*` | desktop | 2026-08-14 | Phase 1 reference studies, under correction after a PASS |
| `src/platform/claimed-guards.test.ts` | desktop (`fix/guard-tokeniser-phase`) | 2026-08-15 | backtick tokeniser loses phase; fixed twice — the first fix kept the cursor and kept a hole, the second removed the cursor. Fallout was nine claims, all real, so no other file was touched |

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
