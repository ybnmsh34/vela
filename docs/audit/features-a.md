# Audit: Projects, Skills and MCP

Auditor: features-a. Worktree `C:\Users\User\vela-tmp`, branch `claude/new-session-tgl1ut`,
HEAD `a1fa55e`. Windows 11, real NTFS, real `node` on PATH.

Every command below was run in this worktree. Every mutation was reverted immediately and
the revert confirmed with `git status --porcelain` before the next step.

---

## 0. The headline

All three tracks are **host-complete and renderer-absent**. The Rust is genuinely good —
I broke it four times in four different places and watched tests go red each time — but
no module under `src/` that the running application loads ever calls a `project_*`,
`skills_*` or `mcp_*` command. `src/app/App.tsx` says so about itself:

```
 * `DEFAULT_PROJECT_ID` is passed literally, and that is a statement about what
 * is not built rather than a shortcut. The project feature does not exist, so
 * there is exactly one project and this is its id;
```

Three findings go beyond "not wired yet", because they are the repo believing something
false about itself:

1. Three shipping comments state that `COMMAND_ALLOWLIST` has no command that reads a
   project and none that reads a skill's body. It has eight of the first and one of the
   second. One of those comments is the *reason* the agent runtime's project-instruction
   reader is hardcoded to `null`.
2. `src-tauri/crates/vela-skills/src/mount.rs` (1020 lines) and `enablement.rs`
   (217 lines) are a **complete second implementation** of the junction rule, the
   reparse-aware delete and the case-folding rule. Nothing calls them. The shipped
   implementation is `vela-projects`.
3. `src/platform/skill-mount-parity.test.ts` — the guard whose name says it holds the
   skill mount — reads the **dead** crate. I proved this by putting `symlink_dir` into
   the live crate's Windows branch: `project-host-parity.test.ts` went red,
   `skill-mount-parity.test.ts` stayed green.

---

## 1. What is registered, and what calls it

### 1.1 The dispatch table

`src-tauri/src/lib.rs` `generate_handler!` registers, in my domain:

```
ipc::mcp::mcp_list_tools,
ipc::project::project_create, project_delete, project_get, project_layout,
ipc::project::project_list, project_move_conversation, project_reconcile_skills,
ipc::project::project_update,
ipc::skills::skills_list, ipc::skills::skills_read,
```

`src/platform/contract.ts` `COMMAND_ALLOWLIST` carries the same eleven names.
`src-tauri/tests/handler_binding.rs` binds the two by asking the assembled
`invoke_handler` about each name on `tauri::test`'s mock runtime, with its own
non-vacuity control. Registration is not in doubt.

There is **no** `mcp_call_tool`, no `mcp_reload`, no `skills_install`, no
`skills_set_enabled`. Skill enablement is a column on the project row
(`ProjectView.enabledSkills`), written by `project_create`/`project_update`.

### 1.2 The renderer side — measured, not read

I ran the same import-graph walk `src/runtime/reachable.test.ts` uses (regex specifier
scan, `@/` and relative resolution, BFS from `src/main.tsx`), applied to all of `src/`.
Script at
`…\scratchpad\reach.mjs`. Literal output:

```
reachable module count: 119
src/data/mcp-repository.ts => UNREACHABLE
src/data/skills-repository.ts => UNREACHABLE
src/runtime/project-context.ts => REACHABLE
src/platform/contract-project.ts => REACHABLE
src/data/chat-repository.ts => REACHABLE

--- all unreachable shipping modules under src/data and src/platform ---
  UNREACHABLE src/data/mcp-repository.ts
  UNREACHABLE src/data/sandbox-repository.ts
  UNREACHABLE src/data/skills-repository.ts
```

`src/runtime/reachable.test.ts` only walks `src/runtime`, so `src/data` is not covered by
any guard — which is why two repositories can sit off the graph and every suite stays
green.

There is **no `src/data/project-repository.ts` at all**:

```
$ ls src/data
chat-repository.ts  conversations-repository.ts  host-repository.ts  layout-repository.ts
mcp-repository.ts   memory-repository.ts  models-repository.ts  sandbox-repository.ts
settings-repository.ts  skills-repository.ts  transcript-repository.ts  turn-driver.ts
```

`grep -rln "mcp-repository|skills-repository" src/` returns exactly the two `.test.ts`
files that test them. `src/features/` has no projects, skills or MCP directory.

`DEFAULT_PROJECT_ID` does travel: `App.tsx` → `CanvasSurface` → `document-host.ts:214`,
where it becomes one field of a `SandboxSubmitReq` digest. It is used as a label. No
`project_get` is ever issued for it.

### 1.3 Which adapter production uses

`src/platform/index.ts:40`:

```ts
return isTauriRuntime(scope) ? new TauriAdapter() : new BrowserAdapter();
```

So `src/platform/browser-adapter-projects.test.ts` (350+ lines, 20-odd cases covering
name limits, collisions, working-directory refusals) exercises the **`pnpm dev` double**,
not the host. `src-tauri/tests/adapter_parity_fixture.rs` and
`src/platform/adapter-parity.test.ts` mention neither `project`, `skills` nor `mcp`:

```
$ grep -n "project\|skills\|mcp" src-tauri/tests/adapter_parity_fixture.rs
$ grep -n "project\|skills\|mcp" src/platform/adapter-parity.test.ts
(both empty)
```

The only thing binding the two implementations is
`src/platform/project-host-parity.test.ts`, and what it binds is wire *names*, the two
length constants, and the Windows link branch — not the validation behaviour.

---

## 2. Stale claims about the allowlist

`src/platform/contract.ts:1650-1657` and `:1675-1676`:

```
  'project_create', 'project_delete', 'project_get', 'project_layout',
  'project_list', 'project_move_conversation', 'project_reconcile_skills',
  'project_update',
  ...
  'skills_list', 'skills_read',
```

Against that, three shipping (non-test) files:

| File | Claim | Truth |
|---|---|---|
| `src/runtime/app-runtime.ts:20` | "`src/platform/contract.ts` has no command that reads a project, so there is nothing to call." | `project_get` and `project_list` are allowlisted and registered. |
| `src/runtime/project-context.ts:12` | "`src/platform/contract.ts` has no `project_get` in its allowlist either, so there is no host call to make yet" | It does. |
| `src/runtime/project-context.ts:5` and `src/platform/contract-harness.ts:739` | "`COMMAND_ALLOWLIST` has nothing for skills or memory, and no command reads a skill's *body*" | `skills_list`, `skills_read` and five `memory_*` commands are allowlisted; `skills_read` returns `body: String`. |

The consequence is not cosmetic. `src/runtime/app-runtime.ts` ends:

```ts
    readProjectInstructions: () => Promise.resolve(null),
```

So `createProjectContextResolver` indexes nothing, `preload` comes back empty, and a
project's instructions cannot reach a turn. The stub is justified in its own comment by a
statement about the allowlist that the allowlist contradicts. `chat_send` is the other
possible route and it does not carry a project either — `ChatSendReq` is
`{ turnId, providerId, modelId, messages, tools, toolChoice }` (`src-tauri/src/ipc/chat.rs:111`).

`src-tauri/src/ipc/skills.rs:22-23` carries a fourth, milder version: "no command calls
it … (there is no projects table, and `project_update` does not exist)". The conclusion
(nothing calls `vela_skills::mount`) is still true; both stated reasons are not.
`src/platform/project-host-parity.test.ts:15-16` then cites that comment as its own
premise.

---

## 3. The duplicate implementation, and the guard that watches the wrong copy

Two crates implement the same three safety rules:

| Rule | `vela-projects` (live) | `vela-skills` (dead) |
|---|---|---|
| junction not symlink | `src/link.rs` `create_link`, `NATIVE_LINK_STRATEGY` | `src/mount.rs` `create_link` |
| reparse-aware delete | `src/link.rs` `remove_tree` | `src/mount.rs` `remove_mount_entry` |
| case folding | `src/casefold.rs` `CaseFolding` | `src/enablement.rs` `CaseFolding`, `refuse_colliding_enabled_skills` |

Non-test references to `vela_skills` outside its own crate:

```
src-tauri/src/ipc/skills.rs:29:use vela_skills::{SkillListing, SkillProblem, SkillResources, SkillStore};
src-tauri/tests/cross_layer_invariants.rs:157: vela_skills::SkillStore::under_data_dir(...)
src-tauri/tests/gate_m_assembled_app.rs:1002/1013: SKILL_STORE_DIRECTORY_NAME / SKILL_FILE_NAME
```

`vela_skills::mount` and `vela_skills::enablement` have zero non-test callers. The crate's
own `lib.rs` says so, but gives a reason that has expired:

> **Built, tested against real directories, and called by no command:** everything in
> [`mount`] and [`enablement`] … the commands that would call them (`project_create`,
> `project_update`, `project_reconcile_skills`) do not exist: `src/platform/contract-project.ts`
> declares them, registers none, and there is no projects table for them to read.

All three commands exist and are registered; there is a projects table; they were wired to
a *different* implementation.

### The guard experiment

`src/platform/skill-mount-parity.test.ts:154`:

```ts
const CRATE = join(process.cwd(), 'src-tauri', 'crates', 'vela-skills', 'src');
```

and its Windows check at `:349-357` reads `SOURCES['mount.rs']` — the dead crate.

`src/platform/project-host-parity.test.ts:182` reads `vela-projects` and knows why
(`:12-21`, "Which crate this reads, and why that is the point").

**Mutation.** In `src-tauri/crates/vela-projects/src/link.rs`, `create_link`'s Windows
branch changed from `windows_junction::create(link, target)` to
`std::os::windows::fs::symlink_dir(target, link)`. Then:

```
$ pnpm exec vitest run src/platform/project-host-parity.test.ts src/platform/skill-mount-parity.test.ts

 FAIL  src/platform/project-host-parity.test.ts > the live crate never reaches for a
       symbolic link on Windows > makes its link with something other than symlink_dir
AssertionError: expected [ 'symlink_dir' ] to deeply equal []

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 36 passed (37)
```

The live-crate guard bites. The one named "skill-mount-parity" does not, and cannot — it
is reading a file the user's machine never executes. Reverted:
`git checkout -- src-tauri/crates/vela-projects/src/link.rs`, `git status --porcelain` empty.

---

## 4. Mutation log

All four survived-vs-bit experiments, in order. Each reverted before the next.

### 4.1 The reparse guard between a project delete and every skill on the machine

`src-tauri/crates/vela-projects/src/link.rs`, `remove_tree`:
`if is_reparse_point(path)? {` → `if false && is_reparse_point(path)? {`

```
$ cargo test -p vela-projects
test link::tests::removing_a_link_detaches_it_and_leaves_the_target_untouched ... FAILED
test link::tests::removing_a_tree_that_contains_a_link_does_not_walk_through_it ... FAILED
test link::tests::the_probe_leaves_nothing_behind_and_reports_what_this_machine_did ... FAILED
test layout::tests::a_link_left_directly_under_the_root_is_still_not_walked_through ... FAILED
test layout::tests::removing_a_project_root_unlinks_the_skill_mounts_instead_of_emptying_the_store ... FAILED
test mount::tests::switching_a_skill_off_removes_its_mount_on_the_next_reconcile ... FAILED
test layout::tests::nothing_in_the_project_machinery_writes_inside_the_users_working_directory ... FAILED
test mount::tests::a_collision_the_case_table_misses_is_still_caught_by_the_filesystem ... FAILED
test result: FAILED. 33 passed; 8 failed
```

Eight tests, including the one the crate header names. The claim is real.

### 4.2 The case-folding backstop (the volume, not the case table)

`src-tauri/crates/vela-projects/src/mount.rs`, `refusal_for`:
`MountOccupant::Named(stored) if already_mounted.contains(&stored.as_str())` →
`… if false && already_mounted.contains(…)`

```
test mount::tests::what_the_volume_says_about_the_path_decides_whether_it_may_be_written ... FAILED
  assertion `left == right` failed: the entry is one this pass already mounted, whatever `folds` said
test mount::tests::a_collision_the_case_table_misses_is_still_caught_by_the_filesystem ... FAILED
  assertion `left == right` failed: the names were two in memory; the volume holds one entry, and it is the authority
test result: FAILED. 39 passed; 2 failed
```

Worth noting *how* that test gets its pair: it asks NTFS for a real 8.3 short-name alias
of `Research Notes Long Name` and asserts up front that `folds` does **not** join them.
It is measuring this volume, not a fixture.

### 4.3 MCP child-process environment isolation

`src-tauri/crates/vela-mcp/src/stdio.rs`, `StdioTransport::spawn`: deleted
`command.env_clear();`

```
test the_server_does_not_inherit_the_parent_environment ... FAILED
  assertion `left == right` failed: an undeclared variable of the parent process reached the child
test result: FAILED. 10 passed; 1 failed
```

A real `node` child, a real pipe, a real canary variable exported by the test.

### 4.4 The enabled-skills collision refusal at the command layer

`src-tauri/src/ipc/project.rs`, `validate_enabled_skills`: the `first_collision` branch
made unreachable.

```
test ipc::project::tests::two_enabled_skills_that_are_one_directory_are_refused_rather_than_deduplicated ... FAILED
test result: FAILED. 22 passed; 1 failed
```

---

## 5. What passed on this hardware

```
$ cargo test -p vela-projects -p vela-skills -p vela-mcp
vela_mcp   unit           25 passed
vela_mcp   stdio_end_to_end  11 passed
vela_projects unit         41 passed
vela_skills unit           33 passed
vela_skills fixture_skill   3 passed

$ cargo test -p vela-app --lib -- ipc::project ipc::mcp ipc::skills
34 passed; 0 failed
```

Notable individual results, all green, all against real artefacts:

- `link::tests::the_link_this_crate_makes_on_windows_is_a_junction_and_never_a_symbolic_link`
  creates a link on a real `tempfile::TempDir` and reads the 32-bit reparse tag back:
  `Some(0xA0000003)` (`IO_REPARSE_TAG_MOUNT_POINT`), asserts it is not `0xA000000C`
  (`IO_REPARSE_TAG_SYMLINK`), and asserts an ordinary directory has no tag at all. That is
  the junction claim measured on the disk, not on the wire.
- `mcp::tests::the_command_returns_tools_from_a_real_server_process` runs `mcp_list_tools`'
  pure half against `tests/fixtures/mock-mcp-server.mjs` launched as a real `node` process
  and checks the namespaced name `mcp__fixture__add` and the schema's `type: object`
  survived the boundary.
- `the_pool_replaces_a_server_that_died` kills the server through its own `die` tool and
  asks the pool again; `a_list_changed_notification_invalidates_the_cached_tool_list`
  drives the push half.
- `gate_m_assembled_app.rs:987-1055` drives `skills_list` and `skills_read` through the
  assembled app, including the `../escape` refusal.

---

## 6. MCP: what is and is not built

`src-tauri/crates/vela-mcp/src/lib.rs` states it plainly and correctly:

> **The HTTP/SSE transport is not built.** A configuration entry naming a `url` parses, is
> listed, and reports `McpError::TransportNotSupported`.

`config.rs::resolve` confirms it; `ipc/mcp.rs` has a test named
`a_remote_entry_is_listed_as_an_unsupported_transport` whose comment reads "The one place
the missing HTTP transport becomes visible to a user." So my brief's phrase "stdio and
HTTP/SSE transports" describes a product that does not exist. The absence is declared,
not hidden — but it is an absence.

Era negotiation (`server/discover`, revision 2026-07-28) is likewise absent and declared.

`McpPool::shutdown()` has **no explicit caller** anywhere in the tree, and `lib.rs`
installs no `on_window_event` / `RunEvent::Exit` handler:

```
$ grep -rn "\.shutdown()" src-tauri/src/ src-tauri/crates/vela-mcp/
src-tauri/crates/vela-mcp/src/stdio.rs:302:    pub fn shutdown(&self) {
src-tauri/crates/vela-mcp/src/stdio.rs:360:        self.shutdown();
$ grep -n "on_window_event\|RunEvent\|Exit" src-tauri/src/lib.rs
(empty)
```

The pool's doc comment says "Called when the app closes". It is reached only through
`impl Drop for McpPool`, which fires only if Tauri drops its managed state on exit. I did
not launch the app, so whether a configured MCP server outlives the window is unverified.

The configuration is read **once**, at launch, into `McpHost::under_data_dir`. `pool.rs`
says so and explains why there is no reload. A user editing `mcp-servers.json` gets the
change next launch — correct, and worth a UI sentence that does not exist because there is
no UI.

---

## 7. The private workspace and the sandbox

`src/platform/project-run-scope.test.ts` is unusually honest and I confirmed it:

> `projectFilesystemScope` has **no call site in shipping code** … So the seven tests below
> hold a rule for a function no production path reaches.

Independently: `grep -rn "workspace_path|ProjectPaths|vela_projects" src-tauri/src/` returns
nothing outside `src/ipc/project.rs`. The private agent workspace is created (at
`project_create` and repaired at every `project_layout`) and then read by nothing. No run
in this application is scoped by the three-mount rule, because no run executes code.

---

## 8. Things I could not establish

- **Whether the packaged app leaves MCP server processes running after the window closes.**
  Requires launching; I was not the authorised auditor for that.
- **Whether `probe_link_strategy` answers `Junction` under the *real* `%APPDATA%`.** It
  answers `Junction` under a real NTFS `TempDir` on this machine (4.1/§5 above). A
  redirected or network-backed `%APPDATA%` would take the `Copy` arm, and the copy
  materialisation path (`copy_one`, `refresh_copy`, `stale`) is covered by crate tests but
  has never run against a machine that actually needs it.
- **Whether `BrowserAdapter`'s project validation agrees with the host's.** Nothing binds
  them; comparing 350 lines of dev-double behaviour against the Rust by hand was not the
  best use of the budget, and it only matters for `pnpm dev`.
- **`occupant_of`'s `PresentButUnnamed` arm.** It is reachable only through a Windows ACL
  that grants traverse and withholds `FILE_LIST_DIRECTORY`. `refusal_for` is unit-tested
  over the enum directly, so the *decision* bites (4.2), but no test constructs that ACL,
  so `windows_junction::stored_name` returning `Err` on a real directory is asserted, not
  measured.
- **Whether `vela-skills::mount`'s dead code diverges from `vela-projects`'s live code.**
  Both suites are green; I did not diff their semantics. If they have already drifted, the
  guard in §3 is worse than useless — it pins the wrong one to the contract.
