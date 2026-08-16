//! Versioned, forward-only schema migrations, applied at startup.
//!
//! ## The rules
//!
//! 1. **Forward only.** There are no down migrations. A user's database is
//!    their own data; the recovery story for a bad migration is a new migration
//!    that fixes it, not a rollback that discards rows.
//! 2. **Shipped migrations are frozen.** Every applied migration's SQL is
//!    checksummed into `"schema_migrations"`. Editing one after release would
//!    silently fork users' schemas, so it is detected and refused
//!    ([`StoreError::MigrationChanged`]).
//! 3. **A newer database is refused, not downgraded** ([`StoreError::SchemaAhead`]).
//!    If the user ran a newer Vela, this build cannot know what its tables mean.
//! 4. **Each migration runs in its own transaction**, so a failure leaves the
//!    database exactly at the last complete version.
//!
//! ## Adding a migration
//!
//! Add `src/migrations/000N_short_name.sql`, then add one line to
//! [`MIGRATIONS`]. Versions must be contiguous from 1 — if two branches both
//! add `0003`, [`validate_sequence`] fails the build's tests rather than
//! letting one silently win at a user's machine.

use std::collections::BTreeMap;

use rusqlite::Connection;

use crate::clock::Clock;
use crate::error::{StoreError, StoreResult};
use crate::model::Timestamp;

/// One forward-only schema step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Migration {
    pub version: u32,
    pub name: &'static str,
    pub sql: &'static str,
}

impl Migration {
    /// Tamper-evidence, not cryptography: it exists to catch an edited
    /// migration file, not to resist an attacker who already has write access
    /// to the user's disk. FNV-1a keeps the crate dependency-free.
    pub fn checksum(&self) -> String {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in self.sql.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        format!("fnv1a64:{hash:016x}")
    }
}

/// Every migration this build knows about, in order.
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "initial_schema",
        sql: include_str!("migrations/0001_initial_schema.sql"),
    },
    Migration {
        version: 2,
        name: "message_search",
        sql: include_str!("migrations/0002_message_search.sql"),
    },
    Migration {
        version: 3,
        name: "schedules",
        sql: include_str!("migrations/0003_schedules.sql"),
    },
    Migration {
        version: 4,
        name: "memory",
        sql: include_str!("migrations/0004_memory.sql"),
    },
    Migration {
        version: 5,
        name: "project_workspace",
        sql: include_str!("migrations/0005_project_workspace.sql"),
    },
    Migration {
        version: 6,
        name: "answering_endpoint",
        sql: include_str!("migrations/0006_answering_endpoint.sql"),
    },
];

/// The schema version this build produces and understands.
pub const SCHEMA_VERSION: u32 = MIGRATIONS.len() as u32;

/// A migration as recorded in the database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedMigration {
    pub version: u32,
    pub name: String,
    pub checksum: String,
    pub applied_at: Timestamp,
}

const CREATE_LEDGER: &str = "CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    checksum   TEXT    NOT NULL,
    applied_at INTEGER NOT NULL
) STRICT;";

/// Checks the migration list itself is well-formed. Called by [`apply`] before
/// touching the database, so a bad merge fails loudly at startup and in tests
/// rather than half-applying.
pub fn validate_sequence(migrations: &[Migration]) -> StoreResult<()> {
    for (index, migration) in migrations.iter().enumerate() {
        let expected = index as u32 + 1;
        if migration.version != expected {
            return Err(StoreError::invalid(
                "migrations",
                format!(
                    "migration versions must be contiguous from 1; expected {expected}, found {} (`{}`)",
                    migration.version, migration.name
                ),
            ));
        }
        if migration.name.trim().is_empty() {
            return Err(StoreError::invalid(
                "migrations",
                "every migration needs a name",
            ));
        }
        if migration.sql.trim().is_empty() {
            return Err(StoreError::invalid(
                "migrations",
                format!(
                    "migration {} (`{}`) is empty",
                    migration.version, migration.name
                ),
            ));
        }
    }
    Ok(())
}

/// Applies every migration the database has not seen yet. Returns the versions
/// that were applied by *this* call — empty means the schema was already
/// current, which is the normal case on every start after the first.
pub fn apply(conn: &mut Connection, clock: &dyn Clock) -> StoreResult<Vec<u32>> {
    apply_list(conn, MIGRATIONS, clock)
}

/// [`apply`] against an explicit list. Exists so the migration engine itself
/// can be tested with small synthetic migrations instead of Vela's real schema.
pub fn apply_list(
    conn: &mut Connection,
    migrations: &[Migration],
    clock: &dyn Clock,
) -> StoreResult<Vec<u32>> {
    validate_sequence(migrations)?;
    conn.execute_batch(CREATE_LEDGER)?;

    let recorded = applied(conn)?;
    let known: BTreeMap<u32, &Migration> = migrations.iter().map(|m| (m.version, m)).collect();

    let highest_known = migrations.last().map(|m| m.version).unwrap_or(0);
    if let Some(highest_recorded) = recorded.keys().next_back() {
        if *highest_recorded > highest_known {
            return Err(StoreError::SchemaAhead {
                database_version: *highest_recorded,
                supported_version: highest_known,
            });
        }
    }

    for (version, entry) in &recorded {
        let Some(migration) = known.get(version) else {
            // Recorded, known-version range, but absent from this build's list:
            // the file was renamed away or removed. Same failure mode as an
            // edit — this build cannot reproduce that schema.
            return Err(StoreError::MigrationChanged {
                version: *version,
                name: entry.name.clone(),
            });
        };
        if migration.checksum() != entry.checksum {
            return Err(StoreError::MigrationChanged {
                version: *version,
                name: migration.name.to_string(),
            });
        }
    }

    let mut newly_applied = Vec::new();
    for migration in migrations {
        if recorded.contains_key(&migration.version) {
            continue;
        }
        let tx = conn.transaction()?;
        tx.execute_batch(migration.sql)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, name, checksum, applied_at)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                migration.version,
                migration.name,
                migration.checksum(),
                clock.now().as_millis(),
            ],
        )?;
        tx.commit()?;
        newly_applied.push(migration.version);
    }

    Ok(newly_applied)
}

/// The ledger, keyed by version. Empty on a database that has never been
/// migrated (the ledger table is created by [`apply_list`]).
pub fn applied(conn: &Connection) -> StoreResult<BTreeMap<u32, AppliedMigration>> {
    let ledger_exists: bool = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
        [],
        |row| row.get::<_, i64>(0),
    )? > 0;
    if !ledger_exists {
        return Ok(BTreeMap::new());
    }

    let mut statement = conn.prepare(
        "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(AppliedMigration {
            version: row.get(0)?,
            name: row.get(1)?,
            checksum: row.get(2)?,
            applied_at: Timestamp::from_millis(row.get(3)?),
        })
    })?;

    let mut out = BTreeMap::new();
    for row in rows {
        let row = row?;
        out.insert(row.version, row);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::FixedClock;

    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn
    }

    const TOY: &[Migration] = &[
        Migration {
            version: 1,
            name: "one",
            sql: "CREATE TABLE a (id TEXT PRIMARY KEY) STRICT;",
        },
        Migration {
            version: 2,
            name: "two",
            sql: "CREATE TABLE b (id TEXT PRIMARY KEY) STRICT;",
        },
    ];

    #[test]
    fn the_shipped_migration_list_is_contiguous_and_non_empty() {
        validate_sequence(MIGRATIONS).unwrap();
        assert_eq!(SCHEMA_VERSION, MIGRATIONS.len() as u32);
    }

    #[test]
    fn a_duplicate_or_out_of_order_version_is_rejected_before_any_sql_runs() {
        let clashing = &[
            Migration {
                version: 1,
                name: "one",
                sql: "SELECT 1;",
            },
            Migration {
                version: 1,
                name: "also_one",
                sql: "SELECT 1;",
            },
        ];
        assert!(matches!(
            validate_sequence(clashing),
            Err(StoreError::Invalid { .. })
        ));

        let mut conn = fresh();
        assert!(apply_list(&mut conn, clashing, &FixedClock::default()).is_err());
        let tables: i64 = conn
            .query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tables, 0, "nothing may be created when the list is invalid");
    }

    #[test]
    fn a_fresh_database_applies_every_migration_and_records_it() {
        let mut conn = fresh();
        let applied_now = apply(&mut conn, &FixedClock::new(1_000, 10)).unwrap();
        assert_eq!(applied_now, (1..=SCHEMA_VERSION).collect::<Vec<_>>());

        let ledger = applied(&conn).unwrap();
        assert_eq!(ledger.len() as u32, SCHEMA_VERSION);
        assert_eq!(ledger[&1].name, "initial_schema");
        assert_eq!(ledger[&1].applied_at, Timestamp::from_millis(1_000));
        assert_eq!(ledger[&2].applied_at, Timestamp::from_millis(1_010));
        assert!(ledger[&1].checksum.starts_with("fnv1a64:"));

        // The real schema, not just a ledger row.
        for table in [
            "projects",
            "conversations",
            "messages",
            "message_parts",
            "settings",
            "message_search",
            "schedules",
            "schedule_runs",
            "memory_entries",
        ] {
            let count: i64 = conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name = ?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "migration did not create `{table}`");
        }
    }

    /// The integration guard for the wave-i merge, where three branches each
    /// added "the next migration" and all three called it `0003`. Schedules
    /// kept version 3 (it was already on the integration branch); memory was
    /// renumbered to 4 and the project workspace to 5. A fresh database would
    /// pass whatever the numbering was — it runs the whole list top to bottom —
    /// so the failure mode this pins down is only visible on a database that
    /// already exists: the upgrade must add the *new* steps without re-running,
    /// renaming or overwriting the old ones.
    ///
    /// The expected version list is spelled out rather than derived, so the next
    /// branch to add a migration has to look at this test and decide that its
    /// step really does belong on this path.
    #[test]
    fn a_database_migrated_before_memory_landed_gains_it_without_disturbing_schedules() {
        let mut conn = fresh();

        // Exactly what the pre-memory build shipped: versions 1..=3, the last
        // of which is `schedules`. These entries are byte-identical to that
        // build's, so their checksums are too.
        let pre_merge = &MIGRATIONS[..3];
        assert_eq!(pre_merge.last().unwrap().name, "schedules");
        apply_list(&mut conn, pre_merge, &FixedClock::new(1_000, 10)).unwrap();
        let before = applied(&conn).unwrap();
        assert_eq!(before.keys().copied().collect::<Vec<_>>(), vec![1, 2, 3]);

        // Now the merged build opens that same database.
        let applied_now = apply(&mut conn, &FixedClock::new(5_000, 10)).unwrap();
        assert_eq!(
            applied_now,
            vec![4, 5, 6],
            "only the steps this database has not seen may run against it"
        );

        let after = applied(&conn).unwrap();
        assert_eq!(
            after.keys().copied().collect::<Vec<_>>(),
            vec![1, 2, 3, 4, 5, 6]
        );
        assert_eq!(after[&3].name, "schedules");
        assert_eq!(after[&4].name, "memory");
        assert_eq!(after[&5].name, "project_workspace");
        // 6 belongs on this path, per the note above about spelling the list
        // out: a pre-memory database's `messages` table lacks the
        // answering-endpoint columns exactly as a fresh one would.
        assert_eq!(after[&6].name, "answering_endpoint");
        assert_ne!(
            after[&3].checksum, after[&4].checksum,
            "two migrations sharing a checksum means one file is included twice"
        );
        for version in [1, 2, 3] {
            assert_eq!(
                after[&version], before[&version],
                "migration {version} was rewritten by the upgrade"
            );
        }

        // Both branches' tables, on one database, after an upgrade rather than
        // a fresh create.
        for table in ["schedules", "schedule_runs", "memory_entries"] {
            let count: i64 = conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name = ?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "`{table}` is missing after the upgrade");
        }
    }

    /// One step further along the same path: a database that a *post-memory*
    /// build already brought to version 4 must gain the project workspace
    /// without disturbing either of the two features that landed before it.
    ///
    /// This is the case the previous test cannot make. That one starts at 3, so
    /// memory and the project workspace both run in the same call and a bug
    /// that applied them in the wrong order, or skipped one, could still leave
    /// the database looking right.
    ///
    /// **Amendment.** "Starting at 4 isolates the single new step" is what this
    /// said, and it stopped being true when `answering_endpoint` landed as 6: a
    /// database at 4 now climbs two. The isolation this test still provides is
    /// of the *project workspace's effect* — every assertion below is about its
    /// seeded row and the two features it must not disturb — and the isolation
    /// that was lost is restored one test down, by
    /// [`a_database_at_five_gains_the_answering_columns_without_backfilling_them`],
    /// which starts at 5 for the newest step the way this one started at 4 for
    /// what was then the newest. A doc that keeps a claim the code stopped
    /// supporting is the same defect this migration exists to fix, one layer up.
    #[test]
    fn a_database_migrated_before_projects_landed_gains_them_without_disturbing_memory() {
        let mut conn = fresh();

        // What the post-memory, pre-projects build shipped: versions 1..=4.
        let pre_projects = &MIGRATIONS[..4];
        assert_eq!(pre_projects.last().unwrap().name, "memory");
        apply_list(&mut conn, pre_projects, &FixedClock::new(1_000, 10)).unwrap();

        // Rows in both of the features that already exist, so this is an
        // upgrade of a database in use rather than of an empty shell.
        conn.execute(
            "INSERT INTO schedules
                 (id, title, prompt, cadence, next_run_at, created_at, updated_at)
             VALUES ('sched_1', 'weekly review', 'what happened?', 'weekly', 10, 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO memory_entries
                 (id, scope_kind, category, content, created_at, updated_at)
             VALUES ('mem_1', 'global', 'techPrefs', 'prefers Rust', 1, 1)",
            [],
        )
        .unwrap();
        let before = applied(&conn).unwrap();
        assert_eq!(before.keys().copied().collect::<Vec<_>>(), vec![1, 2, 3, 4]);

        let applied_now = apply(&mut conn, &FixedClock::new(5_000, 10)).unwrap();
        assert_eq!(
            applied_now,
            vec![5, 6],
            "the steps this database has not seen, in order"
        );

        let after = applied(&conn).unwrap();
        assert_eq!(
            after.keys().copied().collect::<Vec<_>>(),
            vec![1, 2, 3, 4, 5, 6]
        );
        assert_eq!(after[&5].name, "project_workspace");
        for version in [1, 2, 3, 4] {
            assert_eq!(
                after[&version], before[&version],
                "migration {version} was rewritten by the upgrade"
            );
        }

        // Neither earlier feature's rows were touched.
        let schedules: i64 = conn
            .query_row("SELECT count(*) FROM schedules", [], |r| r.get(0))
            .unwrap();
        assert_eq!(schedules, 1, "the schedule did not survive the upgrade");
        let memory: i64 = conn
            .query_row("SELECT count(*) FROM memory_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(memory, 1, "the memory entry did not survive the upgrade");

        // And the new step did what it is for.
        let default_name: String = conn
            .query_row(
                "SELECT name FROM projects WHERE id = ?1",
                [crate::model::DEFAULT_PROJECT_ID],
                |r| r.get(0),
            )
            .expect("the upgrade must seed the default project");
        assert_eq!(default_name, crate::model::DEFAULT_PROJECT_NAME);
    }

    /// **What happens to the transcript rows a user already has.**
    ///
    /// Starting at 5 isolates the single newest step, the way the test above
    /// started at 4 for what was then the newest.
    ///
    /// The rows written before migration 6 hold the endpoint the user
    /// *selected*, because that is the value `use-conversation.ts` had and
    /// passed. Nothing recorded who actually answered, and for a turn that
    /// failed over the two differ. So the question this test settles is what the
    /// upgrade is allowed to say about those rows, and the answer is **nothing**:
    ///
    ///   * `provider_id` / `model_id` are left exactly as they were, so no
    ///     existing row changes meaning;
    ///   * the new columns are NULL, meaning "not recorded".
    ///
    /// The assertion that carries the weight is the NULL one. Copying
    /// `provider_id` across would look tidier and would be a fabricated claim —
    /// it would assert, for every historical turn, that the selected endpoint
    /// answered it, which is unknowable and is precisely the falsehood the
    /// migration exists to stop. A backfill would also be undetectable
    /// afterwards, since a copied value is indistinguishable from a recorded one.
    #[test]
    fn a_database_at_five_gains_the_answering_columns_without_backfilling_them() {
        let mut conn = fresh();
        let pre = &MIGRATIONS[..5];
        assert_eq!(pre.last().unwrap().name, "project_workspace");
        apply_list(&mut conn, pre, &FixedClock::new(1_000, 10)).unwrap();

        // A transcript row exactly as the pre-migration build wrote one: the
        // user picked `local-llamacpp`, and that is all the row knows. Whether
        // `local-llamacpp` is also what answered is the fact nobody recorded.
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, updated_at)
             VALUES ('conv_old', 'before provenance', 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages
                 (id, conversation_id, seq, role, status, provider_id, model_id,
                  created_at, updated_at)
             VALUES ('msg_old', 'conv_old', 0, 'assistant', 'complete',
                     'local-llamacpp', 'qwen2.5-coder', 1, 1)",
            [],
        )
        .unwrap();

        let applied_now = apply(&mut conn, &FixedClock::new(5_000, 10)).unwrap();
        assert_eq!(applied_now, vec![6], "exactly one step was outstanding");
        assert_eq!(applied(&conn).unwrap()[&6].name, "answering_endpoint");

        let (selected_provider, selected_model, answered_provider, answered_model): (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT provider_id, model_id, answered_by_provider_id, answered_by_model_id
                 FROM messages WHERE id = 'msg_old'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();

        assert_eq!(
            selected_provider.as_deref(),
            Some("local-llamacpp"),
            "the selection this row already held must survive untouched"
        );
        assert_eq!(selected_model.as_deref(), Some("qwen2.5-coder"));
        assert_eq!(
            answered_provider, None,
            "backfilling this from provider_id would fabricate an attribution \
             for a turn nobody attributed"
        );
        assert_eq!(answered_model, None);

        // The columns exist and accept a value — the upgrade produced a usable
        // schema, not just two NULLs.
        conn.execute(
            "INSERT INTO messages
                 (id, conversation_id, seq, role, status, provider_id, model_id,
                  answered_by_provider_id, answered_by_model_id, created_at, updated_at)
             VALUES ('msg_new', 'conv_old', 1, 'assistant', 'complete',
                     'local-llamacpp', 'qwen2.5-coder',
                     'hosted-openai', 'gpt-4o-mini', 2, 2)",
            [],
        )
        .unwrap();
        let answered: Option<String> = conn
            .query_row(
                "SELECT answered_by_provider_id FROM messages WHERE id = 'msg_new'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            answered.as_deref(),
            Some("hosted-openai"),
            "a row written after the upgrade can disagree with its own selection"
        );
    }

    /// Every shipped migration must occupy its own version and its own file.
    #[test]
    fn no_two_shipped_migrations_share_a_version_or_a_body() {
        let mut versions: Vec<u32> = MIGRATIONS.iter().map(|m| m.version).collect();
        versions.sort_unstable();
        versions.dedup();
        assert_eq!(
            versions.len(),
            MIGRATIONS.len(),
            "two migrations claim the same version"
        );

        let mut checksums: Vec<String> = MIGRATIONS.iter().map(|m| m.checksum()).collect();
        checksums.sort();
        checksums.dedup();
        assert_eq!(
            checksums.len(),
            MIGRATIONS.len(),
            "two migrations have identical SQL; one of them is including the wrong file"
        );

        let mut names: Vec<&str> = MIGRATIONS.iter().map(|m| m.name).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), MIGRATIONS.len(), "two migrations share a name");
    }

    #[test]
    fn applying_an_already_current_database_changes_nothing() {
        let mut conn = fresh();
        apply(&mut conn, &FixedClock::default()).unwrap();
        let before = applied(&conn).unwrap();

        let second = apply(&mut conn, &FixedClock::new(9_999_999, 1)).unwrap();
        assert!(second.is_empty(), "migrations must not re-run");
        assert_eq!(applied(&conn).unwrap(), before);
    }

    #[test]
    fn a_migration_edited_after_it_was_applied_is_refused() {
        let mut conn = fresh();
        apply_list(&mut conn, TOY, &FixedClock::default()).unwrap();

        let edited: &[Migration] = &[
            Migration {
                version: 1,
                name: "one",
                sql: "CREATE TABLE a (id TEXT PRIMARY KEY, extra TEXT) STRICT;",
            },
            TOY[1],
        ];

        assert!(matches!(
            apply_list(&mut conn, edited, &FixedClock::default()),
            Err(StoreError::MigrationChanged { version: 1, .. })
        ));
    }

    #[test]
    fn a_database_written_by_a_newer_vela_is_refused_rather_than_downgraded() {
        let mut conn = fresh();
        apply_list(&mut conn, TOY, &FixedClock::default()).unwrap();
        conn.execute(
            "INSERT INTO schema_migrations (version, name, checksum, applied_at)
             VALUES (99, 'from_the_future', 'fnv1a64:0', 0)",
            [],
        )
        .unwrap();

        assert!(matches!(
            apply_list(&mut conn, TOY, &FixedClock::default()),
            Err(StoreError::SchemaAhead {
                database_version: 99,
                supported_version: 2,
            })
        ));
    }

    #[test]
    fn a_partially_migrated_database_resumes_at_the_next_step() {
        let mut conn = fresh();
        apply_list(&mut conn, &TOY[..1], &FixedClock::default()).unwrap();
        assert_eq!(applied(&conn).unwrap().len(), 1);

        let applied_now = apply_list(&mut conn, TOY, &FixedClock::default()).unwrap();
        assert_eq!(applied_now, vec![2]);
        assert_eq!(applied(&conn).unwrap().len(), 2);
    }

    #[test]
    fn a_failing_migration_leaves_the_database_at_the_previous_version() {
        let broken: &[Migration] = &[
            TOY[0],
            Migration {
                version: 2,
                name: "broken",
                sql: "CREATE TABLE b (id TEXT PRIMARY KEY) STRICT; \
                      INSERT INTO nonexistent_table VALUES (1);",
            },
        ];

        let mut conn = fresh();
        assert!(apply_list(&mut conn, broken, &FixedClock::default()).is_err());

        let ledger = applied(&conn).unwrap();
        assert_eq!(ledger.keys().copied().collect::<Vec<_>>(), vec![1]);
        let leftover: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = 'b'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            leftover, 0,
            "the failed migration's transaction must roll back"
        );
    }

    /// The default project must exist **before any row can reference it**, and
    /// a migration is the only place that can promise that.
    ///
    /// The alternative — creating it lazily on first read — has two readers
    /// racing to create the fallback target, producing two fallback targets and
    /// attaching the loser's conversations to a project the UI never lists.
    /// This drives the real migration list against a raw connection, so it
    /// fails if the seed is ever moved out of the schema and into startup code.
    #[test]
    fn the_default_project_is_seeded_by_a_migration_rather_than_at_first_read() {
        let mut conn = fresh();
        apply(&mut conn, &FixedClock::default()).unwrap();

        let (id, name): (String, String) = conn
            .query_row(
                "SELECT id, name FROM projects WHERE id = ?1",
                [crate::model::DEFAULT_PROJECT_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the migrations must leave the default project in place");
        assert_eq!(id, crate::model::DEFAULT_PROJECT_ID);
        assert_eq!(name, crate::model::DEFAULT_PROJECT_NAME);

        let total: i64 = conn
            .query_row("SELECT count(*) FROM projects", [], |row| row.get(0))
            .unwrap();
        assert_eq!(total, 1, "the seed creates one row, not one per launch");
    }

    /// A database that already holds user projects, upgraded in place, keeps
    /// them and gains the default. The project workspace step is the first
    /// schema step this project has shipped that inserts a row rather than only
    /// shaping tables, so the in-place path is worth proving rather than
    /// assuming.
    ///
    /// It was written as migration 3 on its own branch and became 5 in the
    /// wave-i merge, behind schedules and memory — which is why a database
    /// stopped at 2 now climbs three steps rather than one.
    #[test]
    fn upgrading_an_existing_database_seeds_the_default_without_disturbing_what_is_there() {
        let mut conn = fresh();
        apply_list(&mut conn, &MIGRATIONS[..2], &FixedClock::default()).unwrap();
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at)
             VALUES ('proj_existing', 'Sails', 1, 1)",
            [],
        )
        .unwrap();

        let applied_now = apply(&mut conn, &FixedClock::default()).unwrap();
        assert_eq!(applied_now, vec![3, 4, 5, 6]);

        let names: Vec<String> = conn
            .prepare("SELECT name FROM projects ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(names, vec!["General".to_string(), "Sails".to_string()]);

        let skills: String = conn
            .query_row(
                "SELECT enabled_skills FROM projects WHERE id = 'proj_existing'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(skills, "[]", "the new column's default reaches old rows");
    }

    /// Structural guard for rule 0.4: config may name a keychain entry, never
    /// hold one. This scans the shipped SQL for a column that would invite a
    /// credential onto disk.
    #[test]
    fn no_migration_creates_a_column_that_could_hold_a_credential() {
        const FORBIDDEN: &[&str] = &[
            "secret_value",
            "api_key",
            "apikey",
            "password",
            "passphrase",
            "access_token",
            "refresh_token",
            "bearer",
            "credential",
        ];

        for migration in MIGRATIONS {
            let sql = migration.sql.to_lowercase();
            // Strip comments: the files discuss credentials at length on purpose.
            let code: String = sql
                .lines()
                .map(|line| match line.find("--") {
                    Some(at) => &line[..at],
                    None => line,
                })
                .collect::<Vec<_>>()
                .join("\n");

            for needle in FORBIDDEN {
                assert!(
                    !code.contains(needle),
                    "migration {} (`{}`) declares `{needle}`; credentials belong in the OS \
                     keychain and settings may reference one by name only",
                    migration.version,
                    migration.name
                );
            }
        }
    }
}
