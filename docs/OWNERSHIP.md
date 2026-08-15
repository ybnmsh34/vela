# Ownership

One row per in-flight branch, claiming the files it edits. Claim **before** you
edit, so a concurrent agent finds the conflict here rather than in a merge.

A claim is a statement about a working branch, not about `main`. Delete the row
when the branch merges.

| Branch | Agent | Files claimed |
| --- | --- | --- |
| `fix/dead-skill-mount` | Wave 1 / B6 | **deleted:** `vela-skills`' `mount.rs` and `enablement.rs`, and the parity test that guarded them. **added:** `src/platform/skill-store-parity.test.ts`, this file. **edited (doc comments only, no behaviour):** `src-tauri/crates/vela-skills/src/lib.rs`, `src-tauri/crates/vela-skills/src/document.rs`, `src-tauri/src/ipc/skills.rs`, `src/platform/project-host-parity.test.ts`, `src/platform/contract.ts`, `src/platform/contract-project.ts`, `src/data/skills-repository.ts` |

`src-tauri/src/ipc/mod.rs` was **examined and not edited** — see the B6 report.
No file under `src-tauri/crates/vela-projects/` is modified by this branch; it
was mutated during verification and reverted.
