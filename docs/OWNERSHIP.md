# Ownership

Wave 1 runs several builders concurrently against the same tree. This file is
the claim registry: before editing, claim the paths you will touch, so a
conflict is found here rather than in a merge.

A claim is a claim on *edits*. Reading anything is always allowed.

## B2 — real bundle, toolchain pin, release posture

Branch: `fix/real-bundle`

Claimed:

| Path | Kind |
| --- | --- |
| `src-tauri/rust-toolchain.toml` | new file |
| `docs/release-posture.md` | new file |
| `docs/OWNERSHIP.md` | new file (this registry) |
| `src-tauri/tauri.conf.json` | one line added to `bundle.icon` |

The `tauri.conf.json` edit is a single added array element,
`"icons/icon.ico"`. It is the defect that made `"targets": "all"` unachievable
on Windows: the bundler refuses with ``Couldn't find a .ico icon`` when no
`.ico` appears in `bundle.icon`, and none did, even though
`src-tauri/icons/icon.ico` has been present on disk all along. See
`docs/release-posture.md` §6.

B2 added **no** signing keys, **no** updater keys, and did **not** narrow
`bundle.targets` — the posture record is a record, not a plan.
- `.github/workflows/ci.yml` — the toolchain pin changes what CI resolves (see
  `docs/release-posture.md`), but the workflow file itself is left alone: the
  `pnpm verify` builder owns `src/platform/verify-covers-ci.test.ts`, which
  reads it.
- `README.md`, `src/platform/verify-covers-ci.test.ts`, `.gitattributes` —
  owned by the `pnpm verify` builder.
- `src-tauri/crates/vela-sandbox/**`, `src-tauri/crates/vela-skills/**` —
  owned by the process-limit builder. These hold all 33 known-red `cargo fmt`
  hunks; B2 must not touch them and must not add to them.
- `src-tauri/src/fatal.rs`, and the startup/`run()` path in
  `src-tauri/src/lib.rs` — owned by the app-data builder. B2 read `run()` to
  establish where the app writes its data; it changed nothing there.
