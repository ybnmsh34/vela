//! The canonical skill store: one directory per skill, one per machine.
//!
//! `src/platform/contract-project.ts` fixes the location at
//! `<app data dir>/skills` and says three things about it that this module
//! implements literally:
//!
//!  - It is **machine-wide**, shared by every project. A project's mount points
//!    into it; it is never a per-project copy of anything.
//!  - The host creates it **empty, at launch**, before serving any command that
//!    reads it — [`SkillStore::ensure_root`], called from `configure`'s setup in
//!    `src-tauri/src/lib.rs`. Not lazily inside whichever command runs first,
//!    because two commands creating it two ways is two behaviours for one disk.
//!  - **Empty is correct**, not an error. A machine with no skills installed
//!    lists nothing, and every enabled skill then mounts unavailable with
//!    `skillNotFound`. A store that treated a missing directory as a failure
//!    would turn the ordinary first-run state into an error dialog.
//!
//! ## The location is injected, never discovered
//!
//! Same rule `vela-store` keeps in `src-tauri/crates/vela-store/src/location.rs`:
//! this crate never calls a path API to find out where it is. The Tauri host
//! resolves the application-data directory and hands the path in; tests hand in
//! a `tempfile::TempDir`. That is what makes every behaviour below testable on
//! a real filesystem without touching the user's own.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::document::{
    body_of, is_single_path_segment, parse_frontmatter, parse_header, SkillHeader, SkillProblem,
    SKILL_FILE_NAME,
};

/// The store directory name under the application-data directory.
pub const SKILL_STORE_DIRECTORY_NAME: &str = "skills";

/// The three conventional subdirectories of a skill, from the public spec.
///
/// Listed rather than walked freely so that the third level of disclosure has a
/// closed shape: a UI showing what a skill carries shows these three, and a
/// skill that invents a fourth does not silently widen what gets loaded.
pub const RESOURCE_DIRECTORIES: [&str; 3] = ["scripts", "references", "assets"];

/// One entry of the first-level listing.
///
/// An unreadable skill is **listed, with its problem**, never dropped. Dropping
/// it would make a skill the user installed vanish with no sentence anywhere
/// saying why — the silently-wrong outcome that `docs/architecture/conventions.md`
/// §9 rule 6 forbids, and the same reason `SkillMount` in
/// `src/platform/contract-project.ts` keeps one entry per enabled skill even
/// when the mount failed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SkillListing {
    Skill {
        /// The directory name on disk. Equal to `name` for a valid skill —
        /// the spec requires it — and carried separately because it is what the
        /// mount is keyed by, so a UI reporting a mount names this one.
        directory: String,
        name: String,
        description: String,
    },
    Invalid {
        directory: String,
        problem: SkillProblem,
    },
}

impl SkillListing {
    pub fn directory(&self) -> &str {
        match self {
            Self::Skill { directory, .. } | Self::Invalid { directory, .. } => directory,
        }
    }
}

/// The third level of disclosure: what a skill carries, by name only.
///
/// **No bytes are read.** The spec's loading model has this level fetched "only
/// as needed", and the need is per-file; listing names is what lets a caller
/// decide which file it needs without paying for any of them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillResources {
    pub scripts: Vec<String>,
    pub references: Vec<String>,
    pub assets: Vec<String>,
}

/// The canonical store, rooted at an injected directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillStore {
    root: PathBuf,
}

impl SkillStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// `<app data dir>/skills`.
    pub fn under_data_dir(data_dir: impl AsRef<Path>) -> Self {
        Self::new(data_dir.as_ref().join(SKILL_STORE_DIRECTORY_NAME))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Create the store directory if it is not there. Idempotent.
    ///
    /// Called at launch. An existing directory is left exactly as it is —
    /// this never removes, repairs or migrates anything inside it.
    pub fn ensure_root(&self) -> std::io::Result<()> {
        fs::create_dir_all(&self.root)
    }

    /// The first level of disclosure for every skill on the machine.
    ///
    /// Sorted by directory name so two calls agree and a UI does not reorder
    /// itself between reads. Files at the top level are ignored: a skill is a
    /// directory, and a stray text file sitting beside the skills is not a
    /// broken skill, it is not a skill.
    ///
    /// A missing store directory lists nothing. See the module header.
    pub fn list(&self) -> Vec<SkillListing> {
        let Ok(entries) = fs::read_dir(&self.root) else {
            return Vec::new();
        };

        let mut directories: Vec<String> = Vec::new();
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            // `file_type` does not follow links, so a link left in the store
            // is not silently treated as a directory here. The store holds real
            // skill directories; the *mount* is where links live.
            if !file_type.is_dir() {
                continue;
            }
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            directories.push(name);
        }
        directories.sort();

        directories
            .into_iter()
            .map(|directory| match self.header(&directory) {
                Ok(header) => SkillListing::Skill {
                    directory,
                    name: header.name,
                    description: header.description,
                },
                Err(problem) => SkillListing::Invalid { directory, problem },
            })
            .collect()
    }

    /// The first level of disclosure for one skill.
    pub fn header(&self, name: &str) -> Result<SkillHeader, SkillProblem> {
        let source = self.read_document(name)?;
        parse_header(&source, name)
    }

    /// The second level of disclosure: the instruction text.
    ///
    /// Validated exactly as the listing is, so a skill that cannot be listed
    /// cannot be loaded either. A body reachable past a header that failed
    /// validation would mean the checks describe the UI rather than the file.
    pub fn body(&self, name: &str) -> Result<String, SkillProblem> {
        let source = self.read_document(name)?;
        parse_header(&source, name)?;
        let frontmatter = parse_frontmatter(&source)?;
        Ok(body_of(&source, &frontmatter))
    }

    /// The third level: the names under `scripts/`, `references/` and
    /// `assets/`, one directory deep, sorted. Reads no file contents.
    pub fn resources(&self, name: &str) -> Result<SkillResources, SkillProblem> {
        let directory = self.directory_of(name)?;
        let mut resources = SkillResources::default();
        for kind in RESOURCE_DIRECTORIES {
            let mut names: Vec<String> = fs::read_dir(directory.join(kind))
                .into_iter()
                .flatten()
                .flatten()
                .filter_map(|entry| entry.file_name().into_string().ok())
                .collect();
            names.sort();
            match kind {
                "scripts" => resources.scripts = names,
                "references" => resources.references = names,
                _ => resources.assets = names,
            }
        }
        Ok(resources)
    }

    /// `<root>/<name>`, joined only after the name is proven to be one segment.
    pub fn directory_of(&self, name: &str) -> Result<PathBuf, SkillProblem> {
        if !is_single_path_segment(name) {
            return Err(SkillProblem::NameIsNotASinglePathSegment);
        }
        Ok(self.root.join(name))
    }

    fn read_document(&self, name: &str) -> Result<String, SkillProblem> {
        let directory = self.directory_of(name)?;
        if !directory.is_dir() {
            return Err(SkillProblem::NoSkillFile);
        }
        let file = directory.join(SKILL_FILE_NAME);
        match fs::read(&file) {
            Ok(bytes) => String::from_utf8(bytes).map_err(|_| SkillProblem::Unreadable),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Err(SkillProblem::NoSkillFile)
            }
            Err(_) => Err(SkillProblem::Unreadable),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(root: &Path, directory: &str, source: &str) {
        let dir = root.join(directory);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(SKILL_FILE_NAME), source).unwrap();
    }

    fn valid(name: &str) -> String {
        format!("---\nname: {name}\ndescription: Does {name}. Use when {name}.\n---\n\n# {name}\n\nInstructions for {name}.\n")
    }

    #[test]
    fn a_store_that_does_not_exist_lists_nothing_and_is_not_an_error() {
        let root = tempfile::tempdir().unwrap();
        let store = SkillStore::new(root.path().join("never-created"));
        assert_eq!(store.list(), Vec::new());
    }

    #[test]
    fn the_launch_time_creation_is_idempotent_and_keeps_what_is_there() {
        let root = tempfile::tempdir().unwrap();
        let store = SkillStore::under_data_dir(root.path());
        store.ensure_root().unwrap();
        assert!(store.root().is_dir());
        assert_eq!(store.root(), root.path().join("skills"));

        write_skill(store.root(), "alpha", &valid("alpha"));
        store.ensure_root().unwrap();
        assert_eq!(store.list().len(), 1);
    }

    #[test]
    fn a_broken_skill_is_listed_with_its_problem_rather_than_dropped() {
        let root = tempfile::tempdir().unwrap();
        let store = SkillStore::new(root.path());
        write_skill(store.root(), "alpha", &valid("alpha"));
        write_skill(store.root(), "beta", "no frontmatter here\n");
        fs::create_dir_all(store.root().join("gamma")).unwrap();
        fs::write(store.root().join("loose.md"), "not a skill").unwrap();

        let listed = store.list();
        assert_eq!(
            listed
                .iter()
                .map(SkillListing::directory)
                .collect::<Vec<_>>(),
            vec!["alpha", "beta", "gamma"],
            "a file beside the skills is not a skill, and a broken one is still listed"
        );
        assert!(matches!(listed[0], SkillListing::Skill { .. }));
        assert_eq!(
            listed[1],
            SkillListing::Invalid {
                directory: "beta".to_owned(),
                problem: SkillProblem::NoFrontmatter
            }
        );
        assert_eq!(
            listed[2],
            SkillListing::Invalid {
                directory: "gamma".to_owned(),
                problem: SkillProblem::NoSkillFile
            }
        );
    }

    #[test]
    fn the_listing_carries_no_body_text() {
        // The first level of disclosure is name plus description. This is the
        // property the whole loading model rests on, asserted against a real
        // file rather than against the parser alone.
        let root = tempfile::tempdir().unwrap();
        let store = SkillStore::new(root.path());
        write_skill(store.root(), "alpha", &valid("alpha"));

        let rendered = format!("{:?}", store.list());
        assert!(
            !rendered.contains("Instructions for alpha"),
            "the listing leaked the body: {rendered}"
        );
        assert_eq!(
            store.body("alpha").unwrap(),
            "# alpha\n\nInstructions for alpha.\n"
        );
    }

    #[test]
    fn a_name_that_is_not_one_path_segment_is_refused_before_any_join() {
        let root = tempfile::tempdir().unwrap();
        let outside = root.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join(SKILL_FILE_NAME), valid("outside")).unwrap();

        let store = SkillStore::new(root.path().join("skills"));
        store.ensure_root().unwrap();

        for attempt in ["../outside", "..\\outside", "..", "sub/dir"] {
            assert_eq!(
                store.header(attempt).unwrap_err(),
                SkillProblem::NameIsNotASinglePathSegment,
                "{attempt:?} was joined"
            );
            assert_eq!(
                store.body(attempt).unwrap_err(),
                SkillProblem::NameIsNotASinglePathSegment
            );
            assert_eq!(
                store.directory_of(attempt).unwrap_err(),
                SkillProblem::NameIsNotASinglePathSegment
            );
        }
    }

    #[test]
    fn a_body_is_refused_when_the_header_it_belongs_to_is_invalid() {
        let root = tempfile::tempdir().unwrap();
        let store = SkillStore::new(root.path());
        write_skill(store.root(), "alpha", &valid("elsewhere"));
        assert_eq!(
            store.body("alpha").unwrap_err(),
            SkillProblem::NameDoesNotMatchDirectory
        );
    }

    #[test]
    fn the_third_level_lists_names_and_reads_nothing() {
        let root = tempfile::tempdir().unwrap();
        let store = SkillStore::new(root.path());
        write_skill(store.root(), "alpha", &valid("alpha"));
        let alpha = store.root().join("alpha");
        fs::create_dir_all(alpha.join("scripts")).unwrap();
        fs::create_dir_all(alpha.join("references")).unwrap();
        fs::write(alpha.join("scripts").join("run.py"), "print('secret')").unwrap();
        fs::write(alpha.join("references").join("api.md"), "# api").unwrap();

        let resources = store.resources("alpha").unwrap();
        assert_eq!(resources.scripts, vec!["run.py".to_owned()]);
        assert_eq!(resources.references, vec!["api.md".to_owned()]);
        assert!(resources.assets.is_empty());

        let rendered = format!("{resources:?}");
        assert!(!rendered.contains("secret"), "{rendered}");
    }
}
