//! Wiring between the Tauri host and [`vela_store`].
//!
//! This is the **only** place that knows where the database lives on a real
//! machine. `vela-store` itself never calls a path API: it is handed a
//! directory, which is what keeps it testable headlessly and what lets tests
//! point it at a temporary directory or at memory.
//!
//! The store is managed as its own state rather than as a field on
//! [`crate::state::AppState`], because the application-data directory is only
//! resolvable once the app handle exists — i.e. inside `setup`, after
//! `AppState` has already been constructed.

use std::sync::Arc;

use tauri::{AppHandle, Manager, Runtime};
use vela_store::{DatabaseLocation, SqliteStore, VelaStore};

/// Process-wide handle to the system of record, reachable from commands as
/// `State<'_, StoreHandle>`.
#[derive(Clone)]
pub struct StoreHandle {
    store: Arc<dyn VelaStore>,
}

impl StoreHandle {
    pub fn new(store: Arc<dyn VelaStore>) -> Self {
        Self { store }
    }

    pub fn store(&self) -> &dyn VelaStore {
        self.store.as_ref()
    }

    /// A cloneable reference, for anything that needs to outlive a command.
    pub fn shared(&self) -> Arc<dyn VelaStore> {
        Arc::clone(&self.store)
    }
}

/// Where this OS keeps per-user application data for Vela, as resolved by
/// Tauri's path API (`~/.local/share/<identifier>` on Linux,
/// `~/Library/Application Support/<identifier>` on macOS,
/// `%APPDATA%\<identifier>` on Windows).
pub fn database_location<R: Runtime>(app: &AppHandle<R>) -> Result<DatabaseLocation, tauri::Error> {
    Ok(DatabaseLocation::in_directory(app.path().app_data_dir()?))
}

/// Opens the database and applies every outstanding migration.
///
/// Failing here aborts startup on purpose. A chat client that silently runs
/// with no system of record would accept the user's work and drop it; refusing
/// to start is the honest failure.
pub fn open<R: Runtime>(app: &AppHandle<R>) -> Result<StoreHandle, Box<dyn std::error::Error>> {
    let location = database_location(app)?;
    let store = SqliteStore::open(location)?;
    Ok(StoreHandle::new(Arc::new(store)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use vela_store::{ContentPart, MessageQuery, NewConversation, NewMessage};

    /// The Tauri path lookup itself needs a running app, which this headless
    /// container has no display server for. Everything *after* the lookup —
    /// the directory-to-file rule, opening, migrating, reading back — is
    /// exercised here against a temporary directory.
    #[test]
    fn opening_a_store_in_a_given_directory_yields_a_migrated_working_database() {
        let dir = tempfile::tempdir().unwrap();
        let store = SqliteStore::open(DatabaseLocation::in_directory(dir.path())).unwrap();
        let handle = StoreHandle::new(Arc::new(store));

        assert_eq!(
            handle.store().schema_version().unwrap(),
            vela_store::SCHEMA_VERSION
        );
        assert!(dir.path().join(vela_store::DATABASE_FILE_NAME).is_file());

        let shared = handle.shared();
        let chat = shared
            .create_conversation(NewConversation::titled("host wiring"))
            .unwrap();
        shared
            .append_message(NewMessage::assistant(
                chat.id.clone(),
                vec![
                    ContentPart::reasoning("this came through the host handle"),
                    ContentPart::text("stored"),
                ],
            ))
            .unwrap();

        let transcript = shared
            .list_messages(&chat.id, MessageQuery::default())
            .unwrap();
        assert_eq!(transcript[0].answer_text(), "stored");
        assert!(transcript[0].has_reasoning());
    }

    #[test]
    fn the_database_file_sits_inside_the_application_data_directory() {
        let directory = std::path::Path::new("/home/someone/.local/share/dev.vela.desktop");
        let location = DatabaseLocation::in_directory(directory);
        let path = location.path().expect("a file location has a path");

        // Compared as path components rather than as a string. The separator
        // `join` inserts is the host's, so a string test written with `/` is a
        // test that only passes off Windows — which is the one platform this
        // application ships to.
        assert_eq!(path.file_name().unwrap(), vela_store::DATABASE_FILE_NAME);
        assert_eq!(path.parent().unwrap(), directory);
    }
}
