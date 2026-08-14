//! The **user's** directory: the one place in a project Vela never creates,
//! never scaffolds and never writes into.
//!
//! Everything here either reads the disk and reports what it found, or refuses a
//! binding before it is stored. Nothing in this module creates a directory, and
//! a missing working directory is reported rather than conjured — an empty
//! folder appearing where a user's files used to be looks exactly like data
//! loss.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::link::directory_is_writable;

/// Why a working directory could not be used. A closed vocabulary: the renderer
/// owns every sentence a user reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkingDirectoryProblem {
    /// Nothing at that path. Deleted, renamed, or never there.
    NotFound,
    /// Something is there and it is not a directory.
    NotADirectory,
    /// It exists and this process may not read it.
    PermissionDenied,
    /// The volume is not currently attached — an unplugged drive, a
    /// disconnected share, a cloud placeholder that would need a download.
    /// Distinct from `NotFound` because it is expected to come back, and the UI
    /// must not offer to re-pick a folder that is merely asleep.
    VolumeUnavailable,
}

/// The working directory, resolved against the disk at the moment it was read.
///
/// A union rather than a path plus an `exists` flag, because the three states
/// carry different fields and a flat shape would let a caller read a path that
/// means nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WorkingDirectory {
    /// The project has no working directory. Complete and ordinary.
    None,
    Bound {
        path: String,
        /// The process may create entries here. `false` is not a failure — a
        /// read-only reference folder is a legitimate thing to point at — but a
        /// surface offering to save into it must be disabled rather than
        /// allowed to fail at the end.
        writable: bool,
    },
    Unavailable {
        /// The stored binding, so the UI can say which path is missing.
        path: String,
        problem: WorkingDirectoryProblem,
    },
}

/// A request to point a project at a directory, or at none.
///
/// A union rather than `Option<String>`, because "leave it alone" and "clear it"
/// are different intents and one nullable field can only spell one of them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WorkingDirectoryBinding {
    None,
    Path { path: String },
}

/// Why a binding was refused before it was ever stored. Each of these is an
/// `INVALID_PAYLOAD` at the command layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkingDirectoryRefusal {
    /// A relative path resolves against a working directory that differs
    /// between the host process, the agent, and whatever shell the user copied
    /// the path out of.
    NotAbsolute,
    /// Inside Vela's application-data directory, which holds `vela.db` and every
    /// project's private workspace. Agent file writes do not belong next to the
    /// database.
    InsideApplicationData,
    /// Inside the projects root, one level more specific than the rule above.
    /// Checked first, because "this is inside another project" is the sentence a
    /// user can act on.
    InsideAnotherProjectRoot,
}

impl WorkingDirectoryRefusal {
    /// The field name the command layer reports. Kept here so the host and the
    /// browser fake cannot word the same refusal two ways.
    pub fn as_message(self) -> &'static str {
        match self {
            Self::NotAbsolute => "invalid workingDirectory: must be an absolute path",
            Self::InsideApplicationData => {
                "invalid workingDirectory: must not be inside Vela's application data directory"
            }
            Self::InsideAnotherProjectRoot => {
                "invalid workingDirectory: must not be inside a project's own directory"
            }
        }
    }
}

/// Checks a binding against the three refusals, without touching the disk for
/// anything but resolution.
///
/// Note what is **not** checked: whether the directory exists. A user may bind a
/// folder on a drive that is currently unplugged, and refusing that would make
/// the binding depend on what happened to be attached at the moment they typed
/// it. Existence is [`resolve_working_directory`]'s question, and its answer is
/// a state rather than an error.
pub fn validate_binding(
    binding: &WorkingDirectoryBinding,
    app_data_dir: &Path,
) -> Result<Option<PathBuf>, WorkingDirectoryRefusal> {
    let WorkingDirectoryBinding::Path { path } = binding else {
        return Ok(None);
    };
    let candidate = Path::new(path.trim());
    if !candidate.is_absolute() {
        // On Windows this also refuses `\folder` and `C:folder`, which look
        // absolute and are resolved against the process's current drive and
        // current directory on that drive.
        return Err(WorkingDirectoryRefusal::NotAbsolute);
    }

    let resolved = resolve_for_comparison(candidate);
    let projects = crate::layout::projects_root(app_data_dir);
    if contains(&resolve_for_comparison(&projects), &resolved) {
        return Err(WorkingDirectoryRefusal::InsideAnotherProjectRoot);
    }
    if contains(&resolve_for_comparison(app_data_dir), &resolved) {
        return Err(WorkingDirectoryRefusal::InsideApplicationData);
    }
    Ok(Some(without_verbatim_prefix(&resolved)))
}

/// Drops Windows' `\\?\` extended-length prefix from a canonicalised path.
///
/// `fs::canonicalize` returns the verbatim form, and that form is what gets
/// stored and handed back to the renderer to display. It is a legal path and
/// several Windows APIs treat it as a different one — notably it disables the
/// normalisation that makes a relative segment inside it work — so a user
/// pasting what Vela showed them into a shell gets a path that behaves subtly
/// differently from the one they picked. The prefix is a calling convention, not
/// part of the identity of the directory.
fn without_verbatim_prefix(path: &Path) -> PathBuf {
    let text = path.as_os_str().to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{unc}"));
    }
    match text.strip_prefix(r"\\?\") {
        // Only a drive-letter path is safe to unwrap: `\\?\Volume{…}` has no
        // shorter spelling at all, so it keeps the prefix it needs.
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

/// Reads the binding against the disk.
///
/// **Never creates anything.** The three failure states are distinguished
/// because the UI's response to each differs: `NotFound` invites re-picking a
/// folder, `VolumeUnavailable` must not.
pub fn resolve_working_directory(stored: Option<&str>) -> WorkingDirectory {
    let Some(path) = stored else {
        return WorkingDirectory::None;
    };
    let candidate = Path::new(path);

    match fs::metadata(candidate) {
        Ok(metadata) if metadata.is_dir() => WorkingDirectory::Bound {
            path: path.to_owned(),
            writable: directory_is_writable(candidate),
        },
        Ok(_) => WorkingDirectory::Unavailable {
            path: path.to_owned(),
            problem: WorkingDirectoryProblem::NotADirectory,
        },
        Err(error) => WorkingDirectory::Unavailable {
            path: path.to_owned(),
            problem: classify(candidate, &error),
        },
    }
}

fn classify(path: &Path, error: &std::io::Error) -> WorkingDirectoryProblem {
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        return WorkingDirectoryProblem::PermissionDenied;
    }
    // `ERROR_NOT_READY` (an empty drive bay) and `ERROR_BAD_NETDEV`/
    // `ERROR_BAD_NETPATH` (a share that is not answering) are the volume saying
    // "not now" rather than "not here".
    #[cfg(windows)]
    if matches!(error.raw_os_error(), Some(21) | Some(53) | Some(1231)) {
        return WorkingDirectoryProblem::VolumeUnavailable;
    }
    // A path whose own volume root has gone is an unplugged drive, not a
    // deleted folder. Asked of the root rather than of the path, because the
    // path is missing either way and only the root can tell the two apart.
    if let Some(root) = volume_root(path) {
        if !root.exists() {
            return WorkingDirectoryProblem::VolumeUnavailable;
        }
    }
    WorkingDirectoryProblem::NotFound
}

/// `C:\` for `C:\a\b`, `/` for `/a/b`, `\\server\share\` for a UNC path.
fn volume_root(path: &Path) -> Option<PathBuf> {
    let mut components = path.components();
    let prefix = match components.next()? {
        Component::Prefix(prefix) => Some(prefix.as_os_str().to_owned()),
        Component::RootDir => None,
        _ => return None,
    };
    let mut root = PathBuf::new();
    if let Some(prefix) = prefix {
        root.push(prefix);
    }
    root.push(std::path::MAIN_SEPARATOR.to_string());
    Some(root)
}

/// Resolves a path as far as the disk allows, then normalises the rest
/// lexically.
///
/// `fs::canonicalize` alone is not enough: a binding may name a directory that
/// does not exist yet, and refusing to compare it would mean the containment
/// rules stop applying to exactly the paths a user is most likely to typo.
/// Lexical normalisation alone is not enough either: `C:\Users\me\..\me\data`
/// and a junction into the application-data directory both defeat it.
fn resolve_for_comparison(path: &Path) -> PathBuf {
    if let Ok(real) = fs::canonicalize(path) {
        return real;
    }
    // Canonicalise the deepest ancestor that exists and re-attach the tail, so
    // a link partway up the path is still resolved.
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut walker = path.to_path_buf();
    while let Some(parent) = walker.parent().map(Path::to_path_buf) {
        let Some(name) = walker.file_name().map(|name| name.to_owned()) else {
            break;
        };
        tail.push(name);
        if let Ok(real) = fs::canonicalize(&parent) {
            let mut out = real;
            for name in tail.iter().rev() {
                out.push(name);
            }
            return out;
        }
        walker = parent;
    }
    lexically_normalised(path)
}

fn lexically_normalised(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Whether `candidate` is `ancestor` or sits underneath it.
///
/// Component-wise rather than by string prefix, so `C:\vela-data-backup` is not
/// found to be inside `C:\vela-data`. Case-insensitive on Windows, because
/// `%APPDATA%` and `%appdata%` name one directory there and a case-sensitive
/// comparison would let a differently-cased spelling walk straight past the
/// refusal.
fn contains(ancestor: &Path, candidate: &Path) -> bool {
    let mut ancestors = ancestor.components();
    let mut candidates = candidate.components();
    loop {
        let Some(expected) = ancestors.next() else {
            return true;
        };
        let Some(actual) = candidates.next() else {
            return false;
        };
        let (expected, actual) = (
            expected.as_os_str().to_string_lossy().into_owned(),
            actual.as_os_str().to_string_lossy().into_owned(),
        );
        let same = if cfg!(windows) {
            expected.to_lowercase() == actual.to_lowercase()
        } else {
            expected == actual
        };
        if !same {
            return false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app_data() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(crate::layout::projects_root(dir.path())).unwrap();
        dir
    }

    fn bind(path: &Path) -> WorkingDirectoryBinding {
        WorkingDirectoryBinding::Path {
            path: path.to_string_lossy().into_owned(),
        }
    }

    #[test]
    fn a_relative_path_is_refused_because_it_means_something_different_per_process() {
        let data = app_data();
        for spelling in ["notes", "./notes", "../notes"] {
            let binding = WorkingDirectoryBinding::Path {
                path: spelling.to_string(),
            };
            assert_eq!(
                validate_binding(&binding, data.path()),
                Err(WorkingDirectoryRefusal::NotAbsolute),
                "`{spelling}` must be refused"
            );
        }
    }

    #[test]
    fn a_path_inside_the_application_data_directory_is_refused() {
        let data = app_data();
        let inside = data.path().join("sneaky");
        assert_eq!(
            validate_binding(&bind(&inside), data.path()),
            Err(WorkingDirectoryRefusal::InsideApplicationData)
        );
        // The database's own directory, spelled as the root itself.
        assert_eq!(
            validate_binding(&bind(data.path()), data.path()),
            Err(WorkingDirectoryRefusal::InsideApplicationData)
        );
    }

    #[test]
    fn a_path_inside_a_project_root_is_refused_with_the_more_specific_reason() {
        let data = app_data();
        let inside = crate::layout::project_root(data.path(), "proj_other").join("workspace");
        assert_eq!(
            validate_binding(&bind(&inside), data.path()),
            Err(WorkingDirectoryRefusal::InsideAnotherProjectRoot)
        );
    }

    #[test]
    fn a_dot_dot_escape_back_into_the_application_data_directory_is_still_refused() {
        let data = app_data();
        // Lexically this leaves the tree and comes back. A string prefix test
        // would let it through.
        let sneaky = data.path().join("..").join(
            data.path()
                .file_name()
                .expect("a tempdir has a final component"),
        );
        assert_eq!(
            validate_binding(&bind(&sneaky), data.path()),
            Err(WorkingDirectoryRefusal::InsideApplicationData)
        );
    }

    #[test]
    fn a_sibling_whose_name_merely_starts_the_same_is_not_inside() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("vela-data");
        let sibling = root.path().join("vela-data-backup");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&sibling).unwrap();

        assert!(validate_binding(&bind(&sibling), &data).is_ok());
    }

    #[test]
    fn an_ordinary_folder_of_the_users_is_accepted_and_read_back_as_bound() {
        let data = app_data();
        let notes = tempfile::tempdir().unwrap();
        let accepted = validate_binding(&bind(notes.path()), data.path()).unwrap();
        let stored = accepted.unwrap().to_string_lossy().into_owned();

        assert!(
            !stored.starts_with(r"\\?\"),
            "the stored binding is what a user is shown; it must not carry the \
             extended-length calling convention: {stored}"
        );
        match resolve_working_directory(Some(&stored)) {
            WorkingDirectory::Bound { path, writable } => {
                assert_eq!(path, stored);
                assert!(writable, "a tempdir this process just made is writable");
            }
            other => panic!("expected a bound directory, got {other:?}"),
        }
    }

    #[test]
    fn no_binding_at_all_is_an_ordinary_complete_state() {
        assert_eq!(
            validate_binding(&WorkingDirectoryBinding::None, Path::new("C:\\data")),
            Ok(None)
        );
        assert_eq!(resolve_working_directory(None), WorkingDirectory::None);
    }

    #[test]
    fn a_missing_folder_is_reported_and_never_recreated() {
        let notes = tempfile::tempdir().unwrap();
        let gone = notes.path().join("deleted-by-the-user");
        let stored = gone.to_string_lossy().into_owned();

        let resolved = resolve_working_directory(Some(&stored));
        assert_eq!(
            resolved,
            WorkingDirectory::Unavailable {
                path: stored,
                problem: WorkingDirectoryProblem::NotFound,
            }
        );
        assert!(!gone.exists(), "reading a layout must not conjure a folder");
    }

    #[test]
    fn a_file_where_a_folder_should_be_is_its_own_problem() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("notes.txt");
        fs::write(&file, "not a directory").unwrap();
        let stored = file.to_string_lossy().into_owned();

        assert_eq!(
            resolve_working_directory(Some(&stored)),
            WorkingDirectory::Unavailable {
                path: stored,
                problem: WorkingDirectoryProblem::NotADirectory,
            }
        );
    }

    #[test]
    fn a_folder_on_a_volume_that_is_not_attached_is_asleep_rather_than_gone() {
        // A drive letter no machine running this suite has mounted. The
        // distinction matters because the UI must not offer to re-pick a folder
        // that is merely unplugged.
        let stored = if cfg!(windows) {
            "Q:\\field-notes".to_string()
        } else {
            // No portable equivalent off Windows; the classification there falls
            // through to `NotFound`, which is the honest answer when the root
            // (`/`) is present.
            return;
        };
        assert_eq!(
            resolve_working_directory(Some(&stored)),
            WorkingDirectory::Unavailable {
                path: stored,
                problem: WorkingDirectoryProblem::VolumeUnavailable,
            }
        );
    }
}
