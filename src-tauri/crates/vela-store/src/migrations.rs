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
