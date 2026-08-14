# Module ownership — one repo, possibly two sessions

Two sessions on one repo will swallow each other's commits. Anything you are about to touch, claim
here first, by module, with a timestamp and a session id. Never touch a module claimed by another
session without an explicit release entry below.

Sessions: `desktop` (this Windows machine, builds and orchestrates) · `cloud` (retired 2026-08-14,
see `docs/HANDOVER.md`).

## Active claims

| module / path | session | claimed (UTC) | purpose |
|---|---|---|---|
| `src/platform/chat-contract-parity.test.ts` | desktop | 2026-08-14 | CRLF bug — the guard cannot run on a Windows checkout |
| `src/platform/claimed-guards.test.ts` | desktop | 2026-08-14 | red at HEAD; two measured holes in the guard itself |
| `src-tauri/crates/vela-providers/src/private_fs.rs` | desktop | 2026-08-14 | orphaned, uncompiled, carries a live false claim |
| `src-tauri/src/ipc/diagnostics.rs` | desktop | 2026-08-14 | Windows DACL enforcement for the debug-log directory |
| `docs/vela-state-2026-08-14.md` | desktop | 2026-08-14 | verified state read |

## Released

_None yet._

## Rules

1. One git index per wave. Parallel builders get **separate git worktrees**, never the shared index.
2. Push every cycle. Unpushed work is invisible work — the cloud session lost five commits and
   47 source files to exactly this, and said so in its handover.
3. Pull before every wave. If HEAD moved, re-read state before proceeding.
4. A claim is released by moving its row to **Released** with the sha that finished it.
