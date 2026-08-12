//! The store's error type.
//!
//! Deliberately small and *closed*: the IPC layer maps these onto wire codes
//! (`NOT_FOUND`, `INVALID_PAYLOAD`, `INTERNAL`) rather than forwarding
//! `Display` strings as protocol. Nothing here should ever be parsed by a
//! caller — match the variant.

pub type StoreResult<T> = Result<T, StoreError>;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StoreError {
    /// The addressed row does not exist. `entity` is a stable, non-localised
    /// tag (`"conversation"`, `"message"`, `"project"`, `"setting"`).
    #[error("no {entity} with id `{id}`")]
    NotFound { entity: &'static str, id: String },

    /// The caller supplied something that cannot form a well-formed row.
    #[error("invalid {field}: {reason}")]
    Invalid { field: String, reason: String },

    /// A relational invariant was violated — usually a foreign key pointing at
    /// a row that does not exist. Distinct from [`StoreError::Backend`] so the
    /// caller can tell "you referenced something missing" from "the database
    /// itself failed".
    #[error("constraint violated: {reason}")]
    Constraint { reason: String },

    /// The database file was written by a newer Vela than this one. Refusing is
    /// the only safe response: migrations are forward-only, so this build has no
    /// way to interpret a schema it has never seen.
    #[error(
        "database schema version {database_version} is newer than this build supports \
         ({supported_version}); refusing to open it"
    )]
    SchemaAhead {
        database_version: u32,
        supported_version: u32,
    },

    /// An already-applied migration's SQL no longer matches what was recorded.
    /// Editing shipped migrations silently forks users' databases, so it is an
    /// error rather than a warning.
    #[error("migration {version} (`{name}`) was modified after it had been applied")]
    MigrationChanged { version: u32, name: String },

    /// A persisted row cannot be read back into the domain model — an unknown
    /// enum discriminant, malformed JSON, a part row that violates its own kind.
    /// Data written by this crate can never produce this; it means the file was
    /// edited by something else.
    #[error("stored data is not readable: {reason}")]
    Corrupt { reason: String },

    /// Could not create or reach the database file / its directory.
    #[error("cannot open the database at `{path}`: {reason}")]
    Io { path: String, reason: String },

    /// Anything SQLite reported that is not one of the above.
    #[error("database error: {reason}")]
    Backend { reason: String },
}

impl StoreError {
    pub(crate) fn invalid(field: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::Invalid {
            field: field.into(),
            reason: reason.into(),
        }
    }

    pub(crate) fn corrupt(reason: impl Into<String>) -> Self {
        Self::Corrupt {
            reason: reason.into(),
        }
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        use rusqlite::ErrorCode;

        match &error {
            rusqlite::Error::SqliteFailure(inner, _) => match inner.code {
                ErrorCode::ConstraintViolation => StoreError::Constraint {
                    reason: error.to_string(),
                },
                ErrorCode::CannotOpen | ErrorCode::ReadOnly | ErrorCode::DiskFull => {
                    StoreError::Io {
                        path: "<open connection>".into(),
                        reason: error.to_string(),
                    }
                }
                _ => StoreError::Backend {
                    reason: error.to_string(),
                },
            },
            rusqlite::Error::QueryReturnedNoRows => StoreError::NotFound {
                entity: "row",
                id: String::new(),
            },
            other => StoreError::Backend {
                reason: other.to_string(),
            },
        }
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(error: serde_json::Error) -> Self {
        StoreError::corrupt(format!("malformed JSON column: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_foreign_key_failure_is_a_constraint_error_not_an_opaque_backend_error() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE parent (id TEXT PRIMARY KEY);
             CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));",
        )
        .unwrap();

        let error: StoreError = conn
            .execute("INSERT INTO child VALUES ('c', 'missing')", [])
            .unwrap_err()
            .into();

        assert!(
            matches!(error, StoreError::Constraint { .. }),
            "expected a constraint error, got {error:?}"
        );
    }
}
