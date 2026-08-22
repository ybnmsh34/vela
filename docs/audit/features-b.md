# Audit — Scheduler, dual local endpoint, memory, canvas/artifacts

Auditor: independent, parallel with eleven others.
Worktree: `C:\Users\User\vela-tmp`, branch `claude/new-session-tgl1ut`, HEAD `a1fa55e`.
Date of run: 2026-08-15.

Everything below was established in this worktree. Where a claim is graded
`test-bites` I broke the implementation, ran the tests, watched them fail, and
reverted with `git checkout --`. Every mutation window was under a minute of
wall clock except the three that needed a `cargo` rebuild. All mutated files
were confirmed clean afterwards with `git status --porcelain`.

---

## 1. Method

The question this project's history says to ask is not "is there code for
this" but "does the code reach a user, and does anything bite when it is
broken". So the work split three ways:

1. **Trace** every track from a UI surface (or a registered Tauri command)
   down to the implementation, by reading the composition roots
   (`src/app/App.tsx`, `src-tauri/src/lib.rs`) rather than by reading the
   feature's own prose about itself.
2. **Mutate** the four or five places where being wrong costs the most —
   the bind-address tool policy, the endpoint's auth gate, the canvas frame's
   sandbox attribute, the memory→payload joint, the scheduler's overlap guard
   and boot reaping, the memory scope partition — and watch a test fail.
3. **Record what could not be established**, which for this domain is a
   longer list than usual and is in §7.

Thirteen mutations were performed (A–O). Every one of them produced at least
one failing test. Not one silent pass. That is the headline for this domain:
where a rule is written down here, something watches it.

---

## 2. Scheduler

### 2.1 What is wired

`src-tauri/src/lib.rs:166-167`, inside the composition root's `setup`:

```
scheduler_host::reap_on_boot(store.store());
scheduler_host::spawn(store.shared());
```

Both lines are literal and unconditional. `spawn` starts a named thread
(`vela-scheduler`) that sleeps `POLL_INTERVAL` (30s) and then calls
`vela_store::poll_once` forever. `reap_on_boot` runs once, before the loop,
and marks every `schedule_runs` row still `running` as `failed`.

Five `schedules_*` commands are in `tauri::generate_handler!`
(`src-tauri/src/lib.rs:216-220`): `schedules_create`, `schedules_delete`,
`schedules_list`, `schedules_list_runs`, `schedules_set_enabled`. All five are
in `COMMAND_ALLOWLIST` and in `src/platform/contract.ts`'s `ALLOWED_COMMANDS`
(lines 1664-1668).

### 2.2 What is not wired: there is no schedules surface

```
$ git grep -rln "schedules_list\|schedules_create\|ScheduleView" src/
src/platform/browser-adapter.ts
src/platform/browser-adapter-schedules.test.ts
src/platform/contract.test.ts
src/platform/contract.ts
```

```
$ grep -rn "Cadence\|'hourly'\|Hourly" src/ --include=*.ts --include=*.tsx | grep -v '\.test\.'
src/platform/contract.ts:1429:export type Cadence = 'once' | 'hourly' | 'daily' | 'weekly';
src/platform/contract.ts:1447:  readonly cadence: Cadence;
src/platform/contract.ts:1508:  readonly cadence: Cadence;
```

There is no `src/features/schedules/`. Nothing under `src/features/` or
`src/app/` imports a schedule type, calls a schedule command, or renders a
cadence. The contract declares the surface, the browser adapter implements a
fake of it for the dev-browser runtime, and the Tauri host implements the real
one. **The React application in between does not exist.** A user of the
shipped app cannot create a schedule, cannot see one, and cannot see a run.

The poll thread therefore runs in production over a table that can never have
a row in it.

### 2.3 What is not wired: nothing ever finishes a run

```
$ grep -rn "finish_schedule_run" src-tauri/src src-tauri/crates --include=*.rs
crates/vela-store/src/repository.rs:235  (doc comment)
crates/vela-store/src/repository.rs:281  (doc comment)
crates/vela-store/src/repository.rs:292  fn finish_schedule_run(
crates/vela-store/src/sqlite.rs:1432     fn finish_schedule_run(
crates/vela-store/tests/durability.rs:413  .finish_schedule_run(
```

Plus the in-module tests in `scheduler.rs`. **No production caller.** The
crate says so itself, twice, in `vela-store/src/scheduler.rs:35-39` and
`src-tauri/src/ipc/schedules.rs:17-24`, and in `scheduler_host.rs:19-25`. So
the lifecycle a schedule actually has, end to end, is:

1. poll finds it due,
2. a conversation is created holding the prompt as its only message,
3. a `schedule_runs` row opens `running`,
4. the schedule's `next_run_at` moves on,
5. nothing sends the conversation to a model,
6. the run stays `running` — which *blocks the schedule from ever firing
   again* (the overlap guard, §2.5) — until the next application restart,
7. `reap_on_boot` marks it `failed` with "Vela stopped before this run
   finished".

`ScheduleRunStatus::Succeeded` is unreachable in the shipped binary. The
honesty here is complete and repeated; the feature is nevertheless not a
feature.

### 2.4 Cadence arithmetic — MUTATION O

`Cadence::advance` (`vela-store/src/model.rs:825`) is closed-form: the next
slot is the first strictly after `now`, and skipped slots are counted, not
fired.

Mutation: `let steps = elapsed / interval + 1;` → `let steps: i64 = 1;`

```
test scheduler::tests::a_day_asleep_fires_one_run_and_counts_the_slots_it_skipped ... FAILED
test result: FAILED. 90 passed; 1 failed
```

Bites. Note only *one* test caught it — `firing_moves_the_schedule_to_the_next_slot`
survives because when `now` is exactly on the slot, `steps` is 1 either way.
The catch-up case is the only one guarded, and it is the one that matters.

Limitation, documented at `model.rs:800-803` and confirmed by reading
`interval_ms`: `Daily` is exactly 86,400,000 ms, not "the same wall-clock
time". A daily schedule drifts an hour across a DST boundary. There is no
timezone column.

### 2.5 The overlap guard — MUTATION I

`due_schedules` (`sqlite.rs:1375`) filters on `NO_RUN_IN_FLIGHT`.

Mutation: dropped `AND {NO_RUN_IN_FLIGHT}` from the `WHERE`.

```
test scheduler::tests::runs_left_behind_by_a_restart_are_reaped_so_the_schedule_is_not_wedged ... FAILED
test scheduler::tests::a_schedule_whose_previous_run_is_still_in_flight_is_not_fired_again ... FAILED
test result: FAILED. 89 passed; 2 failed
```

Bites.

### 2.6 Boot reaping — MUTATION H (first half)

Mutation: `WHERE status = 'running'` → `WHERE status = 'running' AND 1 = 0`
in `reap_orphaned_runs`.

```
test scheduler::tests::runs_left_behind_by_a_restart_are_reaped_so_the_schedule_is_not_wedged ... FAILED
```

Bites. `scheduler_host`'s own end-to-end test
(`boot_reaping_unwedges_a_schedule_whose_run_never_finished`) lives in the
`vela-app` crate and could not be run — see §7.

### 2.7 IPC validation

`ipc::schedules::create` validates title (≤200 chars) and prompt (≤8,000
chars) before a row exists, and resolves `project_id` through
`store.get_project` so a bad reference is `NOT_FOUND` naming the project
rather than a foreign-key error. Seven tests in the module, including
`a_schedule_created_through_ipc_is_fired_by_the_poll_and_listed_as_a_run`,
which is the only place the IPC layer and the poll loop are exercised
together. Not mutated (the `vela-app` crate would not build — §7).

`run_now` in `vela-store` (manual "run now", overlap-guarded, does not move
the slot) has **no caller anywhere**, not even an IPC command:

```
$ grep -rn "run_now" src-tauri/ --include=*.rs | grep -v target
crates/vela-store/src/lib.rs:88:pub use scheduler::{poll_once, run_now, …};
crates/vela-store/src/scheduler.rs:113,129,391,405   (definition, doc, two tests)
```

There is no `schedules_run_now` command. It is tested-only code.

---

## 3. Dual local endpoint

### 3.1 The bind-address tool policy is real, and it bites — MUTATIONS F and G

This is the security rule the brief asks to grade hard, so it got two
mutations at two different levels.

**MUTATION G — the classification.** `BindScope::of_ip` decides whether an
address is loopback. The wildcard `0.0.0.0` is the dangerous case, because
`is_loopback()` is `false` for it and a careless implementation would treat
"unspecified" as "local".

Mutation: `if ip.is_loopback() {` → `if ip.is_loopback() || ip.is_unspecified() {`

```
test policy::tests::forcing_tools_on_an_exposed_bind_fails_closed_until_it_is_confirmed ... FAILED
test policy::tests::enforcement_strips_the_catalogue_and_the_choice_together ... FAILED
test policy::tests::loopback_addresses_are_loopback_and_the_wildcard_is_not ... FAILED
test policy::tests::loopback_defaults_tools_on_and_an_exposed_bind_defaults_them_off ... FAILED
```

Four tests. Bites hard.

**MUTATION F — the choke point.** `policy.rs`'s module header claims
`ToolPolicy::enforce` is the single point every decoded request passes
through. `server.rs:445` is the call site, followed by a `debug_assert!`.

Mutation: removed **both** the `enforce` call and the `debug_assert`, so the
probe tested the *test suite*, not the assertion.

```
running 12 tests
test binding_the_wildcard_address_turns_tools_off_by_itself ... ok
test a_policy_with_tools_off_strips_them_however_the_request_body_asks ... FAILED
…
thread 'a_policy_with_tools_off_strips_them_however_the_request_body_asks' panicked at
  crates\vela-endpoint\tests\dual_endpoint_over_a_real_socket.rs:347:5:
  a request body must not be able to put a tool in front of the model
test result: FAILED. 11 passed; 1 failed
```

Bites, **over a real TCP socket**, with a real HTTP body that sets
`"enable_tools": true` and carries a `tools` array and `tool_choice`.

Worth recording precisely because it is the shape of this project's recurring
defect: `binding_the_wildcard_address_turns_tools_off_by_itself` **passed**
under this mutation. It only asserts `handle.policy().tools_enabled()` — the
resolved policy object — and says nothing about whether that object is
consulted on the request path. If it had been the only test, the enforcement
could have been deleted and the suite would have stayed green. It is not the
only test, and the one that matters asserts against what the fake brain
actually received.

**Where the policy comes from.** `serve` binds first, then reads
`listener.local_addr()` back and resolves the policy from *that*
(`server.rs:140-145`). A caller cannot ask for `0.0.0.0` and describe it as
loopback afterwards. `ToolPolicy` is `Copy`, has one constructor, and has no
interior mutability, so it cannot be widened after the listener is up.

**The environment layer** (`endpoint_host::decide`) contributes only the
operator's `--enable-tools` equivalent. `VELA_LOCAL_ENDPOINT_TOOLS=on` on an
exposed bind produces `Enable { confirmed: false }` unless
`VELA_LOCAL_ENDPOINT_TOOLS_CONFIRM=yes`, and an unconfirmed enable on an
exposed bind resolves **off**. Any unrecognised value of `TOOLS_VAR`
(including `yes`, `true`, `1`, `enable`) falls through to `Default`, which
means the bind address decides — a typo cannot turn tools on. Six unit tests
cover this. Not mutated.

### 3.2 Bearer auth — MUTATION L

Mutation: `if route::authenticate(…) != AuthOutcome::Ok {` →
`if false && route::authenticate(…) != AuthOutcome::Ok {`

```
test neither_dialect_answers_without_the_key ... FAILED
test the_model_list_answers_before_any_turn_is_sent ... FAILED
test result: FAILED. 10 passed; 2 failed
```

Bites. The comparison itself is a hand-written constant-time equality
(`route.rs:143`) over the whole key, length-checked first. An empty key is
refused at `serve` (`ServeError::EmptyKey`), so an unauthenticated endpoint
cannot come up.

**Compatibility note, not a defect:** `x-api-key` is deliberately *not* a
second way in (`route.rs`, test
`the_anthropic_sdk_key_header_is_not_a_second_way_in`). A stock Anthropic SDK
client that sets `ANTHROPIC_API_KEY` sends `x-api-key` and would get a 401
here; it has to be pointed at this endpoint with an `Authorization: Bearer`
header. That is a real interoperability constraint and it is not written down
anywhere a user would find it.

### 3.3 What a user can actually do with this

Nothing, without reading the source.

```
$ git grep -ln "VELA_LOCAL_ENDPOINT" -- docs README.md scripts src
(no output)
```

The only mentions in the tree are in `src-tauri/src/endpoint_host.rs` and one
comment in `src-tauri/src/lib.rs`. There is no settings row, no command, no
README line, no docs page. `endpoint_host.rs:32-35` says so itself: "A
user-facing switch is a real gap and is named as one in this module's own
report."

Unconfigured, the behaviour is correct and quiet: `Decision::Off`, nothing
binds, one line on stderr (`vela: local endpoint off`). A bind address with no
key or no provider is `Refused`, not a fallback. That is the right failure
direction.

### 3.4 The one untested seam: `ProviderBrain`

`ProviderBrain` (`endpoint_host.rs:172-216`) is the glue that turns one of the
user's configured providers into a `Brain`. It is constructed in
`start_if_configured` and it is the only thing standing between a client on
the port and a real model.

Its `models()` and `stream()` are **exercised by no test**. The one host test
that starts a server
(`a_started_endpoint_serves_the_named_provider_and_reports_its_policy`)
asserts the policy and the summary line and never sends a turn. So the whole
of the endpoint's *usefulness* — as opposed to its security posture and its
wire format — rests on code that has never been run in this repository's
history except, possibly, by hand.

Nothing here has been measured against the llama.cpp server on 127.0.0.1:8033.
Doing so would require launching the app (not authorised for this auditor) or
adding a binary target (would mean writing a tracked file).

### 3.5 The rest of the wire

`cargo test -p vela-endpoint` ran clean on this machine (43 lib tests + 12
integration tests binding real loopback sockets and speaking real HTTP/1.1).
The integration suite covers: both dialects on one port with one key; the
Anthropic streaming event sequence by name and order; the OpenAI chunk +
`[DONE]` sentinel; `/v1/responses` → `501` (so a wrong base URL is
distinguishable from an unbuilt path); `405` for the wrong method; a
malformed body refused in the caller's own dialect; the asymmetric base URLs
(`http://host:port` for Anthropic, `http://host:port/v1` for OpenAI); and a
provider failure becoming one of eight stable codes with the `Diagnosis`
never crossing the port. I did not mutate any of these.

Stated non-features, verified by reading and by the `501` test: no TLS, no
keep-alive, no chunked request bodies, no reasoning forwarded, no embeddings,
no per-model capability detail on `/v1/models`.

---

## 4. Memory

### 4.1 The pane reaches a user

`src/features/navigation/Sidebar.tsx:189` and `:249` — two buttons (collapsed
icon, expanded row) calling `setMemoryOpen(true)` on
`src/state/memory-store.ts`. `src/app/App.tsx:37` mounts `<MemorySurface />`
outside the shell; it renders `null` until `open`, then mounts `MemoryPanel`.
That indirection exists because a feature may not import another feature, and
it also means `useMemory` does not read the host on every launch.

Five `memory_*` commands are registered (`lib.rs:194-198`) and allowlisted on
both sides.

### 4.2 Memory reaches the outgoing turn — MUTATIONS D and E

**MUTATION D** — both call sites at once. Changed both
`toMessages(history, userText, parts, memoryRef.current)` to pass `null`.

```
FAIL src/app/memory-payload.test.tsx > puts it in the outgoing chat_send request…
  Expected: "system"  Received: "user"
Tests  1 failed | 14 passed
```

**MUTATION E** — the agent path only (`use-conversation.ts:746`), to find out
whether the harness path is separately guarded. It is:

```
Test Files  2 failed (25)
Tests       2 failed | 291 passed (293)
```

Two tests failed, in `src/features/conversation/agent-run.test.tsx` (asserting
`request.input[0]` is a `system` message containing the remembered fact) and
one in `memory-payload.test.tsx`. So the plain chat path and the agent-run
path each have their own guard. That is the joint this file's own comment says
was found broken once before.

**MUTATION M** — the budget. `memoryBudgetTokens` returns
`min(floor(window × 0.05), 6250)`.
Changed to return `MEMORY_BUDGET_MAX_TOKENS` unconditionally:

```
FAIL is a fraction of the window, so a small model is not swamped
FAIL assumes the smallest window worth supporting when the endpoint reported none
FAIL never exceeds the budget it was given
Tests  3 failed | 8 passed
```

**MUTATION N** — the change announcement. `useMemory` calls
`noteChanged()` after every successful write so an open conversation re-reads
memory. Replaced with a no-op:

```
FAIL src/app/memory-payload.test.tsx > counts the memory block in the context meter, not only in the payload
```

Bites. This is the "you saved a memory and the next answer ignored it" failure,
and it is guarded.

### 4.3 Scope isolation — MUTATION H (second half)

`list_memory_entries` (`sqlite.rs:1582`) partitions on
`scope_kind = ?1 AND project_id IS ?2` (`IS`, not `=`, because the global
scope's `project_id` is NULL).

Mutation: `… OR 1 = 1`.

```
test sqlite::tests::clearing_one_scope_leaves_every_other_scope_intact ... FAILED
test sqlite::tests::project_memory_and_global_memory_never_see_each_other ... FAILED
```

Bites. MEM-2 is enforced at the store, which is where it should be, and no IPC
command returns more than one scope.

### 4.4 What is not reachable

- **Per-project memory.** `MemoryScopeDto::Project` exists on the wire, is
  implemented, is tested at both the store and IPC layers — and is called by
  nothing in `src/`. `use-memory.ts:105` and `use-conversation.ts:356` both
  pass `GLOBAL_MEMORY` literally. `ConversationSummary` carries no project id
  and there is no project surface. Both `MemoryPanel.tsx:30-35` and
  `ipc/memory.rs:28-35` say this out loud.
- **`memory_clear_scope`.** Registered, allowlisted, implemented in the
  repository (`memory-repository.ts:54`) — and no component calls
  `repository.clear`. `MemoryController` exposes `remember`, `amend`,
  `setPinned`, `forget`, and no clear. There is no "forget everything" button.
- **Automatic extraction.** MEM-1's post-turn pass that decides for itself
  what to remember does not exist. No turn calls `memory_add`. The pane says
  so to the user at the bottom of the panel; `ipc/memory.rs:9-15` says so to
  the reader.
- **Embedding-similarity ranking.** MEM-1's third ranking term. Entries are
  taken as a prefix of the host's order (pinned, then recency). Stated at
  `memory-prompt.ts:29-38`.
- **A markdown memory file on disk.** MEM-1 wants one; there is a SQLite
  table instead. Stated at `MemoryPanel.tsx:16-21`.

### 4.5 Past-chat search

`store_search` is registered, and the renderer reaches it:
`CommandPalette.tsx:114` → `use-conversations.ts:170` → `repository.search`.
`ipc/store.rs:437-444` fans out to two store queries: `search_conversations`
(a LIKE over titles, because titles are not in the FTS index) and
`search_messages` (FTS5 over message content). `ipc/store.rs:14-16` explains
why both are needed. Nine tests in `sqlite.rs` cover FTS quoting, `%`, `_`,
stemming, and limits, including one asserting an unbalanced quote is an error
rather than a silent empty result. Not mutated.

---

## 5. Canvas / artifacts

### 5.1 It reaches a user

`App.tsx:123` wraps the transcript in `<CanvasSurface assistantTexts={answers}
projectId={DEFAULT_PROJECT_ID}>`. `answers` comes back up from
`ConversationSurface`'s `onAssistantMessages`. `CanvasSurface` re-parses each
answer with `parseMarkdown` and folds the fenced blocks into artifact tracks.
`src/app/canvas-wiring.test.tsx` (3 tests) drives that joint end to end at the
`App` level.

### 5.2 The frame boundary — MUTATIONS A, B, C

**MUTATION A — `allow-same-origin`.** The single worst line that could be
written in this repo. Changed `'allow-scripts'` → `'allow-scripts
allow-same-origin'`:

```
FAIL document-frame.test.ts > the frame never gets Vela's origin > grants exactly one token when script is allowed
  Expected: "allow-scripts"  Received: "allow-scripts allow-same-origin"
Test Files  2 failed (2)
Tests       3 failed | 24 passed (27)
```

Three tests across two files, including `CanvasPanel.test.tsx`, which asserts
the attribute on the DOM node the component actually rendered — not just on
the string the builder returned.

**MUTATION B — the CSP.** Changed `"default-src 'none'"` → `'default-src *'`:

```
Tests  1 failed | 12 passed
```

Bites. The skeleton is Vela's, the meta is the first element in `<head>`, and
the model's source is only ever the `<body>` — so the policy cannot be
preceded by anything the model wrote. `form-action 'none'` and
`base-uri 'none'` are named explicitly because `default-src` covers neither.

**MUTATION C — no frame before `accepted`.** `drawnGrant` in
`DocumentPreview.tsx` is the single decision. Added a line returning the
approval request's own grant while `awaitingApproval`:

```
Test Files  2 failed (2)
Tests       8 failed | 9 passed (17)
```

Eight tests, across `CanvasPanel.test.tsx` and `canvas-wiring.test.tsx`. The
file's own header records that an earlier draft asked the phase twice and a
mutation probe found the frame still refusing to draw because the *other*
guard caught it. That refactor held: with the one remaining guard broken, the
frame draws and eight tests notice.

### 5.3 Versioning and the Code view — MUTATIONS J and K

**MUTATION J** — removed the "a byte-identical revision is not a new version"
rule in `collectArtifacts`:

```
FAIL artifacts.test.ts > does not count a repetition as a revision
```

**MUTATION K** — `const selected = pinned === null ? latest : Math.min(pinned,
latest);` → `const selected = latest;`, so a user's pin is ignored:

```
FAIL lets the reader go back to an earlier one and stay there
FAIL offers no comparison for the first version, because there is nothing before it
```

Both bite. The Code tab is a peer of Preview rather than a disclosure under
it, and there are explicit tests for "still shows the code when running
artifacts is switched off" and "shows the source of a language this build
cannot draw, and says so".

### 5.4 What Canvas cannot do

- **`react` and `mermaid` are detected but never drawn.**
  `FENCE_LANGUAGES` maps `jsx`/`tsx`/`react` and `mermaid`, so those fences
  do open a panel and do get a version rail. `CANVAS_LANGUAGES` is
  `['html', 'svg']`, so the submit is refused `languageUnsupported` and the
  user gets "This build cannot draw this kind of artifact. The source is in
  the Code tab." That is the honest outcome and it is tested. Worth flagging
  anyway: `frameFor` still has a `case 'react'` arm that inlines JSX into an
  HTML body, and a `case 'mermaid'` arm that inlines Mermaid text into an
  SVG-styled document. Neither is reachable today — the host refuses first —
  but if `CANVAS_LANGUAGES` ever grows, those arms would render garbage
  rather than fail.
- **`permissionIsOff` cannot be set.** `CanvasSurface:57` constructs
  `new LocalDocumentHost()` with no options; `LocalDocumentHost`'s constructor
  defaults `permission` to `'ask'`. Nothing in `src/` passes a `permission`
  option except tests. So the refusal path, its sentence, and the "Code still
  works when it is off" behaviour are all correct and all unreachable in the
  shipped app. There is no setting for it.
- **`frameCrashed` has no producer.** An opaque-origin frame cannot be read,
  so a document that died inside it is invisible. Only SVG gets a real
  `failed` outcome, from a `DOMParser` pass performed *outside* the frame.
  `DocumentPreview.tsx:25-27` says so and does not fake the rest.
- **The sandbox host is renderer-side.** `document-host.ts:6-13` opens by
  saying the six `sandbox_*` commands are not wired, are on no allowlist, and
  have no Rust module. `LocalDocumentHost` is a renderer-side stand-in shaped
  like four of them. So `permissionIsOff` is held by the process it is meant
  to constrain, `requestDigest` is an identity token and not a check, and
  `wallClockMs` is a `setTimeout` in the same event loop as the thing it is
  timing. All three are labelled as such in the source. What *is* genuinely
  enforced is the browser boundary, which is the half that matters, and §5.2
  shows it bites. (The lead's sweep separately established that
  `SandboxHost::report_document` on the Rust side is a no-op.)
- **The auto-approval profile never auto-approves.** `autoApproves` compares
  `request.minimumIsolation` against the profile's floor.
  `DEFAULT_AUTO_APPROVAL_PROFILE`'s document floor is `ownRendererProcess`;
  `CANVAS_ISOLATION_FLOOR` is `opaqueOriginFrame`, one rank below. So every
  artifact prompts, always. That is intended (`document-run.ts:122-128`) but
  means a user gets an approval card for every SVG a model draws.

---

## 6. Mutation log

| # | File | Change | Result |
|---|---|---|---|
| A | `canvas/document-frame.ts` | sandbox `+ allow-same-origin` | 3 failed / 27 |
| B | `canvas/document-frame.ts` | CSP `default-src 'none'` → `*` | 1 failed / 13 |
| C | `canvas/DocumentPreview.tsx` | draw a frame while awaiting approval | 8 failed / 17 |
| D | `conversation/use-conversation.ts` | drop memory from both payloads | 1 failed / 15 |
| E | `conversation/use-conversation.ts` | drop memory from the agent path only | 2 failed / 293 |
| F | `vela-endpoint/src/server.rs` | remove `policy.enforce` + `debug_assert` | 1 failed / 12 (integration) |
| G | `vela-endpoint/src/policy.rs` | `0.0.0.0` classified as loopback | 4 failed / 43 |
| H | `vela-store/src/sqlite.rs` | memory scope filter neutered; reap reaps nothing | 3 failed / 91 |
| I | `vela-store/src/sqlite.rs` | overlap guard removed from `due_schedules` | 2 failed / 91 |
| J | `canvas/artifacts.ts` | identical re-emission becomes a new version | 1 failed / 11 |
| K | `canvas/CanvasPanel.tsx` | version pin ignored | 2 failed / 14 |
| L | `vela-endpoint/src/server.rs` | bearer auth gate disabled | 2 failed / 12 (integration) |
| M | `lib/memory-prompt.ts` | budget ignores the window fraction | 3 failed / 11 |
| N | `memory/use-memory.ts` | writes no longer announce | 1 failed / 11 |
| O | `vela-store/src/model.rs` | catch-up arithmetic → single step | 1 failed / 91 |

All fifteen reverted; `git status --porcelain` clean for every path afterwards.

---

## 7. What could not be established, and why

1. **Nothing in this domain was measured against a real model.** The dual
   endpoint's `ProviderBrain` — the only path from the port to the llama.cpp
   server on 127.0.0.1:8033 — has no test and was not exercised. Doing so
   needs the app launched (another auditor holds that authorisation) or a new
   binary target (would mean writing a tracked file). The endpoint's HTTP,
   routing, auth, tool policy and both dialects *were* exercised over real
   loopback TCP sockets, but with a closure standing in for the model.

2. **`cargo test -p vela-app` would not build.** Two attempts, both:
   ```
   error: failed to remove file `…\target\debug\vela.exe`
   Caused by: Access is denied. (os error 5)
   ```
   `vela.exe` is locked by another agent running the application. So the
   `handler_binding` probe — which builds the real app on Tauri's mock runtime
   and asks the assembled `invoke_handler` whether each command is registered
   — could not be run by me. Command registration for `schedules_*` and
   `memory_*` is therefore **inspection-only** here: I read the
   `generate_handler!` list, `COMMAND_ALLOWLIST`, and `ALLOWED_COMMANDS`, and
   they agree. The lead's workspace run (60 targets, 0 failed) covers the
   probe itself.

   For the same reason `scheduler_host`'s and `ipc::schedules`'s and
   `ipc::memory`'s own tests — all of which live in `vela-app` — were not run
   and not mutated. The store-layer and endpoint-layer mutations stand in for
   them.

3. **I did not mutate the dialect translators** (`anthropic.rs`,
   `openai.rs`, `tool_choice.rs`, ~1,600 lines). They have 43 lib tests plus
   12 integration tests and I watched all of them pass on this machine, but
   "tests exist and pass" is not "tests bite". Budget went to the security
   rules instead.

4. **`endpoint_host::decide` was not mutated.** Six unit tests cover the
   refusal table and the tools-flag vocabulary. I read them and they look
   non-vacuous (each asserts a specific `Decision` variant), but I did not
   confirm by breaking the function.

5. **The 30-second poll interval was never observed firing.** Every scheduler
   assertion in this repo passes an instant as an argument, by design.
   `the_poll_thread_sleeps_before_its_first_poll` proves the *ordering* by
   sleeping 50 ms, not the cadence. Nobody has watched a schedule fire on wall
   clock, here or in the repo's history.

6. **Nothing about DST, timezones or clock changes was tested by me or by
   the repo.** `Cadence` uses fixed millisecond offsets; the consequence is
   documented and unguarded.

7. **The concurrent worktree is noisy.** During my run, other auditors had
   `vela-providers/src/answer.rs`, `vela-providers/src/redact.rs`, four
   `.sse` fixtures and `conversation/use-conversation.ts` mutated at various
   moments, and left untracked probe files
   (`src/styles/zz-audit-leak.css`, `vela-sandbox/tests/zz_audit_probe.rs`).
   I verified via `git diff` that the `use-conversation.ts` modification
   visible at the end of my run was not mine (it changed a streaming
   first-token condition). None of my Rust builds depended on the mutated
   `answer.rs` in a way that changed a result, but it is a caveat on the
   `vela-endpoint` runs, which do compile `vela-providers`.

8. **`docs/audit/features-b.md` is the only file I wrote.** No tracked source
   file is modified as of the end of this run.
