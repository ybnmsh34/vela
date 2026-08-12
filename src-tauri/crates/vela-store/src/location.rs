//! Where the database file lives.
//!
//! The location is **injected, never discovered**. The store has no opinion
//! about the OS and never calls a path API itself: the Tauri host resolves the
//! real per-user application-data directory
//! (`app.path().app_data_dir()` — see `src-tauri/src/store_host.rs`) and hands
//! the directory in, while tests hand in a `tempfile::TempDir` or ask for
//! [`DatabaseLocation::InMemory`]. That is what makes the whole data layer
//! testable headlessly with no filesystem assumptions.

use std::path::{Path, PathBuf};

use crate::error::{StoreError, StoreResult};

/// The database file name inside the application-data directory. Changing it
/// orphans every existing user database, so treat it as a storage migration.
pub const DATABASE_FILE_NAME: &str = "vela.db";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DatabaseLocation {
    /// A private, per-connection database that vanishes when the connection is
    /// dropped. Tests only — nothing is persisted and WAL does not apply.
    InMemory,
    /// A real file on disk.
    File(PathBuf),
}

impl DatabaseLocation {
    /// `<dir>/vela.db`. The caller supplies the directory; on the desktop that
    /// is the OS application-data directory resolved by Tauri.
    pub fn in_directory(dir: impl AsRef<Path>) -> Self {
        Self::File(dir.as_ref().join(DATABASE_FILE_NAME))
    }

    pub fn path(&self) -> Option<&Path> {
        match self {
            Self::InMemory => None,
            Self::File(path) => Some(path.as_path()),
        }
    }

    pub fn is_in_memory(&self) -> bool {
        matches!(self, Self::InMemory)
    }

    /// Human-readable form for diagnostics. For a file it is the path, which is
    /// host-side information: do not forward it to the renderer.
    pub fn describe(&self) -> String {
        match self {
            Self::InMemory => "in-memory (not persisted)".to_string(),
            Self::File(path) => path.display().to_string(),
        }
    }

    /// Creates the containing directory if needed. A first run on a clean
    /// machine has no application-data directory yet, and failing to open the
    /// database because of a missing parent would be a confusing first
    /// impression.
    pub(crate) fn prepare(&self) -> StoreResult<()> {
        let Self::File(path) = self else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|error| StoreError::Io {
                    path: parent.display().to_string(),
                    reason: error.to_string(),
                })?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_name_is_appended_to_the_injected_directory() {
        let location =
            DatabaseLocation::in_directory("/home/someone/.local/share/dev.vela.desktop");
        assert_eq!(
            location.path().unwrap(),
            Path::new("/home/someone/.local/share/dev.vela.desktop/vela.db")
        );
    }

    #[test]
    fn preparing_a_location_creates_a_missing_application_data_directory() {
        let root = tempfile::tempdir().unwrap();
        let nested = root.path().join("dev.vela.desktop").join("data");
        let location = DatabaseLocation::in_directory(&nested);

        assert!(!nested.exists());
        location.prepare().unwrap();
        assert!(nested.is_dir());
    }

    #[test]
    fn an_in_memory_location_touches_no_filesystem() {
        let location = DatabaseLocation::InMemory;
        assert!(location.is_in_memory());
        assert_eq!(location.path(), None);
        location.prepare().unwrap();
    }
}
