# Audit: storage, migrations and search

Domain: `src-tauri/crates/vela-store/` — SQLite schema, the migration ledger,
conversations/messages/parts, the FTS5 index, schedules and runs, memory,
projects, and durability.

Worktree `C:\Users\User\vela-tmp`, branch `claude/new-session-tgl1ut`, HEAD
`a1fa55e` ("Run CI on the platform Vela ships on"). Windows 11, NTFS.

Every mutation below was made, run, and reverted with `git checkout --` inside a
single shell invocation, and the tree was confirmed clean afterwards
(`git status --porcelain -- src-tauri/crates/vela-store/` → empty).

---

## 0. Baseline

```
$ cargo test -p vela-store
test result: ok. 91 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.42s   (lib)
test result: ok.  7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.22s   (tests/durability.rs)
test result: ok.  1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.56s   (doc-test)
```

99 green. Everything below is measured against that baseline.

---

## 1. The brief's three questions, answered first

### 1a. Does `no_two_shipped_migrations_share_a_version_or_a_body` bite?

Yes, and it bites on the clause that matters. The version clause is redundant
(`validate_sequence` already forces contiguity from 1); the load-bearing clause
is the **checksum** dedup, which is exactly the "two branches both shipped
`0003`, someone renumbered and pointed the wrong `include_str!`" failure.

Mutation M3 — reproduce that mistake precisely, migration 5 including migration
4's file:

```rust
    Migration {
        version: 5,
        name: "project_workspace",
        sql: include_str!("migrations/0004_memory.sql"),   // was 0005_project_workspace.sql
    },
```

```
failures:
    migrations::tests::a_database_migrated_before_memory_landed_gains_it_without_disturbing_schedules
    migrations::tests::a_database_migrated_before_projects_landed_gains_them_without_disturbing_memory
    migrations::tests::a_fresh_database_applies_every_migration_and_records_it
    migrations::tests::applying_an_already_current_database_changes_nothing
    migrations::tests::no_two_shipped_migrations_share_a_version_or_a_body
    migrations::tests::the_default_project_is_seeded_by_a_migration_rather_than_at_first_read
    migrations::tests::upgrading_an_existing_database_seeds_the_default_without_disturbing_what_is_there

test result: FAILED. 7 passed; 7 failed; 0 ignored; 0 measured; 77 filtered out
```

The guard fires, and — worth noting — it is not the only thing that fires; six
other tests catch the same mistake by its consequence (`table memory_entries
already exists`). The guard's contribution is that it names the cause instead of
reporting a SQL error 200 lines into a stack trace.

### 1b. Are the existing-database upgrade tests real, or in-memory only?

**Both exist, and the file-based ones are the real ones.** The unit tests in
`migrations.rs` use `Connection::open_in_memory()` (`fresh()`, line 245-249) —
on their own they would not be enough. But `tests/durability.rs` mirrors each of
them against a real file:

```rust
let dir = tempfile::tempdir().unwrap();
let path = dir.path().join(vela_store::DATABASE_FILE_NAME);
{
    let mut old = rusqlite::Connection::open(&path).unwrap();
    ...apply_list(&mut old, &MIGRATIONS[..1], ...)      // stand up an old build's file
    ...INSERT INTO conversations / messages / message_parts by hand
}                                                       // connection dropped = app quit
let store = open(dir.path());                           // this build opens the same file
```

Three of them: `a_database_left_by_an_older_build_is_upgraded_in_place_and_its_content_indexed`
(1 → 5), `a_database_from_before_the_memory_merge_gains_memory_and_keeps_its_schedules`
(3 → 5), `a_database_from_before_the_projects_merge_gains_them_and_keeps_memory_and_schedules`
(4 → 5). Each writes rows before the upgrade and checks the pre-existing ledger
entries are byte-identical afterwards.

To prove the file-based one bites rather than passing on a fresh-create path,
mutation M5 deleted the 0002 backfill (lines 59-63) — the statement that only
ever does anything on an *upgrade*, and selects zero rows on a fresh database:

```
---- a_database_left_by_an_older_build_is_upgraded_in_place_and_its_content_indexed stdout ----
panicked at crates\vela-store\tests\durability.rs:176:5:
assertion `left == right` failed
  left: 0
 right: 1
```

Line 176 is `assert_eq!(hits.len(), 1)` for the term "heliocentrism", written
into a version-1 database before the search index existed. The test is real.

### 1c. Does deleting a conversation clean the FTS index?

**Yes** — and the test that says so bites. Mutation M2 neutered the delete
trigger in `0002_message_search.sql`:

```sql
CREATE TRIGGER message_parts_search_delete
AFTER DELETE ON message_parts
BEGIN
    DELETE FROM message_search WHERE rowid = -999;   -- was: old.id
END;
```

```
panicked at crates\vela-store\src\sqlite.rs:2485:13:
assertion `left == right` failed: `message_search` still holds rows after the cascade
  left: 2
 right: 0
```

Two orphaned index rows (the reasoning part and the text part). So the cascade
`conversations → messages → message_parts` really does drive the trigger, and
`deleting_a_conversation_takes_its_messages_parts_and_search_rows_with_it` is
load-bearing.

Path to a user: `store_delete_conversation` is in `generate_handler!`
(`src-tauri/src/lib.rs:232`), `delete()` calls `store.delete_conversation`
(`src-tauri/src/ipc/store.rs:372`), and `src/data/conversations-repository.ts:69`
invokes it from `remove()`.

---

## 2. The `recursive_triggers` premise is false, and nothing guards the pragma

The brief's framing was "cascades do not fire triggers unless
`recursive_triggers` is on", and `sqlite.rs:99-100` says the same thing:

```rust
// recursive_triggers: the search-index triggers must also fire for
//   rows removed by ON DELETE CASCADE.
"PRAGMA foreign_keys = ON;
 PRAGMA recursive_triggers = ON;
 ...
```

That is not what the pragma does. Two independent measurements:

**M1 — flip the pragma in the shipped open path and run the whole suite:**

```
$ sed -i 's/PRAGMA recursive_triggers = ON;/PRAGMA recursive_triggers = OFF;/' crates/vela-store/src/sqlite.rs
$ cargo test -p vela-store
test result: ok. 91 passed; 0 failed; ...
test result: ok.  7 passed; 0 failed; ...
test result: ok.  1 passed; 0 failed; ...
```

All 99 tests pass with the pragma off, including the FTS-cascade test from §1c.

**An independent SQLite, same shape, both settings** (Python 3.11.9,
`sqlite3.sqlite_version = 3.45.1`; script at
`scratchpad/rt_probe.py`) — a two-level cascade
`conversations → messages → message_parts` with an FTS5 table and an
`AFTER DELETE` trigger on the grandchild:

```
sqlite lib version: 3.45.1
recursive_triggers requested=ON  effective=1 | fts rows before=1 after=0 | message_parts after=0
recursive_triggers requested=OFF effective=0 | fts rows before=1 after=0 | message_parts after=0
```

`effective=0` confirms the pragma actually took. The trigger fires either way.
SQLite's `recursive_triggers` only prevents a trigger from re-entering *itself*
(the `OP_Program` P5 self-recursion check); a named trigger invoked from inside a
foreign-key action sub-program is not on its own frame stack, so it runs.

**Consequence.** The behaviour is correct and no user is affected. But this is
the project's own central defect class in miniature: a comment names the guard
that makes a behaviour hold, the behaviour holds for a different reason, and
**nothing in the crate distinguishes the pragma being on from it being off**. If
some future SQLite build or configuration did make it load-bearing, its removal
would be silent. Either the comment should be corrected, or a test should pin
the pragma's value (`PRAGMA recursive_triggers` reads back `1`) so the claim has
something behind it.

---

## 3. `message_parts_search_update` has no write path

`0002_message_search.sql` ships three triggers. Two of them fire. The third
never does.

```
$ git grep -n "UPDATE message_parts" -- src-tauri/
(no matches)
$ git grep -n "DELETE FROM message_parts" -- src-tauri/crates/vela-store/src/sqlite.rs
1046:                    "DELETE FROM message_parts WHERE message_id = ?1",
```

`update_message` — the streaming-finalise path, the one that swaps a partial
answer for the finished one — replaces parts by **deleting and re-inserting**
them, which drives the insert and delete triggers. Nothing in Vela ever issues
an `UPDATE` against `message_parts`.

M7 made the update trigger completely inert (`WHERE rowid = -999` on its delete,
`WHERE 0` on its insert):

```
test result: ok. 91 passed; 0 failed; ...
test result: ok.  7 passed; 0 failed; ...
test result: ok.  1 passed; 0 failed; ...
```

Nothing noticed. `editing_a_message_updates_what_search_can_find`, which reads
like the test for this trigger, actually exercises the delete+insert pair.

Not a bug — it is dead SQL in a frozen, checksummed migration, so it cannot be
removed anyway. Worth recording so nobody cites it as coverage.

---

## 4. What a refused migration looks like to a user: nothing at all

`SchemaAhead` and `MigrationChanged` are the two errors that exist to protect a
user's database. Trace what happens when one fires:

- `SqliteStore::open_with` → `migrations::apply` returns `Err` (`sqlite.rs:131`)
- `store_host::open` propagates it (`src-tauri/src/store_host.rs:53-57`), whose
  doc-comment says "Failing here aborts startup on purpose … refusing to start
  is the honest failure"
- `.setup(|app| { let store = store_host::open(app.handle())?; …})`
  (`src-tauri/src/lib.rs:69-70`)
- `configure(...).run(...).expect("error while running Vela")` (`lib.rs:246-248`)
- `src-tauri/src/main.rs`:
  ```rust
  // Prevents an extra console window on Windows in release builds.
  #![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
  ```

So in a release build the panic message goes to a stderr that has no console.
The user double-clicks Vela and nothing happens. No window, no dialog, no log
file — `DebugLogHandle` is only managed *after* the store opens, so the opt-in
debug log cannot capture it either.

The IPC mapping that turns these into `"the local database could not be read"`
(`src-tauri/src/ipc/error.rs:99-104`) is unreachable in this scenario: no
command is ever served, because `setup` never returned.

Refusing to start is the right call. Refusing to start *silently* is not, and
this is the single most user-visible gap I found in the domain. A `MessageDialog`
before the `?`, or writing the error to a file beside the database, would cost a
few lines.

I could not confirm this by launching the app — I am not the auditor authorised
to. The grade is inspection-only and the trace above is the whole of my evidence.

---

## 5. The dead arm of the ledger check

`migrations.rs:166-175`:

```rust
for (version, entry) in &recorded {
    let Some(migration) = known.get(version) else {
        // Recorded, known-version range, but absent from this build's list:
        // the file was renamed away or removed. ...
        return Err(StoreError::MigrationChanged { version: *version, name: entry.name.clone() });
    };
```

The scenario the comment names cannot reach this branch. If a migration file is
renamed away, `MIGRATIONS` shrinks (say 5 → 4), and a user database recorded at
5 hits the `SchemaAhead` check twelve lines earlier
(`highest_recorded > highest_known`) and is reported as "written by a newer
Vela" — a different error with a different meaning. `validate_sequence`
guarantees `known` holds exactly `1..=N`, and the ledger is only ever written by
this function in ascending order, so the only way into this arm is a ledger row
with version 0 or negative, i.e. external tampering.

No test covers it. Cosmetic — no user impact — but it is a comment describing a
mechanism that does not operate, which is the class this project grades itself
against.

---

## 6. Durability under an unclean shutdown

Vela's own coverage stops at a **clean** close.
`everything_written_survives_closing_and_reopening_the_file` drops the store
(`}  // the connection is dropped here — as it would be on quitting the app`)
and reopens. `wal_leaves_its_sidecar_files_beside_the_database` asserts
`vela.db` and `vela.db-wal` are both files while the connection is open. Neither
says anything about a process that dies mid-flight, and the crate's own module
header admits it: "What this still does not prove: … behaviour under power loss."

Since I cannot kill the app, I measured the claim directly instead —
Vela's five migration files applied verbatim by Python's SQLite on this NTFS
volume, under `journal_mode=WAL` + `synchronous=NORMAL` + `foreign_keys=ON`,
then `os._exit(9)` with a hot WAL and no checkpoint
(`scratchpad/crash_probe.py`):

```
=== phase write (dies with os._exit, no checkpoint) ===
  committed. journal_mode=wal wal size=403792 bytes
  exit code: 9
=== phase read (fresh process) ===
  sidecars before reopen: ['vela.db', 'vela.db-shm', 'vela.db-wal']
  conversations=1 messages=1 parts=1 fts=1
  fts match for 'barycentre': [('the barycentre of the system',)]
  integrity_check: ok
```

Everything committed survived, **including the FTS index row** — the trigger's
write is in the same transaction as the part, so recovery cannot desynchronise
them. `integrity_check` clean. The `synchronous = NORMAL` comment in
`sqlite.rs:101-103` ("durable across process crashes, only at risk from an
OS-level power loss") is accurate, at least on this filesystem.

Caveat, stated plainly: this went through SQLite 3.45.1 and Vela's schema DDL,
not through Vela's Rust. It proves the storage claim, not the code path.

---

## 7. Open-time pragma verification

`lib.rs` claims "Referential integrity | `PRAGMA foreign_keys = ON`, verified on
open". It is. M6 set the pragma to `OFF` in the batch at `sqlite.rs:106`:

```
test sqlite::tests::a_file_database_gets_wal_journalling_and_foreign_key_enforcement ... FAILED
called `Result::unwrap()` on an `Err` value:
  Backend { reason: "SQLite refused to enable foreign key enforcement" }
```

The store refuses to open at all, so every caller fails loudly rather than
silently running without referential integrity. WAL gets the same treatment —
`PRAGMA journal_mode = WAL` is read back and the open errors if the mode is not
`wal` (`sqlite.rs:112-121`). Both checks are real.

---

## 8. The checksum ledger

M4 disabled the comparison (`if false && migration.checksum() != entry.checksum`):

```
thread 'migrations::tests::a_migration_edited_after_it_was_applied_is_refused'
  panicked at crates\vela-store\src\migrations.rs:524:9
test result: FAILED. 90 passed; 1 failed; ...
```

Exactly one test, and the right one. Note that FNV-1a is tamper-*evidence*, not
tamper-*resistance*, and the crate says so (`migrations.rs:41-43`). That is the
correct claim for the threat: a developer editing a shipped `.sql`, not an
attacker who already owns the disk.

---

## 9. Search: what it can and cannot do

- **FTS query sanitisation.** `src-tauri/src/ipc/store.rs:270-294` splits the
  raw query on `!c.is_alphanumeric()`, lowercases each term, quotes it, and
  joins with `AND` — the last term gets a `*` prefix-match. A user cannot reach
  FTS5 operator syntax at all, so the malformed-expression path is mostly
  defence in depth. `map_search_error` (`sqlite.rs:1162-1168`) still maps a bare
  `SQLITE_ERROR` to `Invalid` rather than `Backend`, tested by
  `a_malformed_search_expression_is_a_user_error_not_a_crash`.
- **Title search does not use `LIKE`.** `instr(lower(title), lower(?1)) > 0`, so
  a user searching `100%` gets `100%` and not `1000 tokens`. Tested by
  `title_search_treats_like_metacharacters_as_literal_text`.
- **Orphaned index rows cannot become phantom hits.** `search_messages`
  inner-joins `messages` and `conversations` (`sqlite.rs:1116-1118`), so an FTS
  row whose message is gone contributes nothing. This is why a hypothetical
  trigger miss would waste space rather than show a user a deleted message.
- **No test asserts FTS cleanup for a single-message delete.**
  `deleting_a_message_leaves_the_rest_of_the_transcript_intact` checks the
  transcript, not the index. The mechanism is the same one-level cascade that
  §1c proved at two levels, and the join above makes a miss invisible, so this
  is a coverage note, not a defect.
- **Reaches a user:** `store_search` → `generate_handler!` (lib.rs:236) →
  `conversations-repository.ts:79` → `use-conversations.ts:170` →
  `CommandPalette.tsx:114`.

---

## 10. Schedules: a run can never succeed

The schema and the persistence are sound —
`a_schedule_and_its_run_history_survive_a_restart_and_still_fire` writes a real
file, fires a schedule, closes the run, quits, reopens, and checks
`next_run_at` moved and the history is there. It passes.

But `finish_schedule_run` has no caller in shipped code:

```
$ git grep -n "finish_schedule_run" -- src-tauri/ src/
crates/vela-store/src/repository.rs:292      (trait declaration)
crates/vela-store/src/scheduler.rs:35        (doc comment saying exactly this)
crates/vela-store/src/scheduler.rs:293,334,359,416,434   (tests)
crates/vela-store/src/sqlite.rs:1432         (impl)
crates/vela-store/tests/durability.rs:413    (test)
```

The only wired writer of a terminal run status is the boot reaper
(`src-tauri/src/lib.rs:166` → `scheduler_host::reap_on_boot` →
`reap_orphaned_runs`), and it writes:

```sql
UPDATE schedule_runs
   SET status = 'failed', finished_at = ?1, duration_ms = max(?1 - started_at, 0),
       error = 'Vela stopped before this run finished'
 WHERE status = 'running'
```

So in the packaged application `ScheduleRunStatus::Success` is unreachable.
Every schedule run a user ever sees is `running` (until the next launch) or
`failed` with that message. The crate documents this honestly and at length
(`scheduler.rs:35-39`, `ipc/schedules.rs:22`) — it is a known missing component
(the agent loop), not a lie. I am grading it `not-wired` on that basis rather
than as a hidden defect.

---

## 11. Things I did not establish

- Nothing was run against the app itself. Every "reaches-user" grade here is a
  traced call path (registered command → IPC function → TS repository → React
  surface), not an observed click.
- The crash-recovery result (§6) went through Python's SQLite 3.45.1 and Vela's
  schema DDL, not through `SqliteStore::open`. WAL recovery is SQLite's, so I
  believe it transfers, but I did not prove Vela's Rust recovers a hot WAL.
- Write-write contention: `busy_timeout = 5000` is set and
  `a_second_store_on_the_same_file_sees_the_first_ones_writes` proves two
  connections coexist for reads, but nothing exercises two writers racing, so I
  cannot say whether 5 s is enough or whether `SQLITE_BUSY` ever surfaces.
- Real per-user application-data directory: `store_host::database_location` needs
  a live Tauri `AppHandle`; every test substitutes a `tempfile::TempDir`. The
  `%APPDATA%\<identifier>` resolution itself is untested here.
- Memory, projects and settings behaviour was read and their tests observed
  green, but I did not mutate them — my four mutation budget went to migrations
  and search, where being wrong costs most.
- Migration 5's seed stamps `created_at`/`updated_at` from
  `strftime('%s','now') * 1000`, i.e. whole seconds, bypassing the injected
  `Clock`. Harmless for a sentinel row, and no test pins it, so I did not grade
  it.

---

## Appendix: mutations run, in order

| # | File | Change | Result |
|---|---|---|---|
| M1 | `sqlite.rs:107` | `recursive_triggers = ON` → `OFF` | all 99 tests still pass |
| M2 | `0002_message_search.sql:39` | delete trigger → `rowid = -999` | FTS cascade test fails (`left: 2`) |
| M3 | `migrations.rs:79` | migration 5 includes 0004's file | collision guard + 6 others fail |
| M4 | `migrations.rs:176` | checksum compare → `if false && …` | `a_migration_edited_after_it_was_applied_is_refused` fails |
| M5 | `0002_message_search.sql:59-63` | delete the backfill | real-file 1→5 upgrade test fails |
| M6 | `sqlite.rs:106` | `foreign_keys = ON` → `OFF` | store refuses to open; test fails |
| M7 | `0002_message_search.sql:45,54` | update trigger made inert | all 99 tests still pass |

Each reverted with `git checkout --` in the same shell invocation;
`git status --porcelain -- src-tauri/crates/vela-store/` empty after each and at
the end.
