//! `skills_*` commands — the canonical skill store, read one level at a time.
//!
//! Two commands, and the split between them **is** the public spec's
//! progressive-disclosure model rather than a description of it:
//!
//!  - `skills_list` is level one. Every installed skill, as a name and a
//!    description. No body is read into the response, because
//!    `vela_skills::SkillHeader` has no field one could travel in.
//!  - `skills_read` is level two and three for exactly one skill: the
//!    instruction body, plus the *names* under the conventional resource
//!    directories. No resource file's contents cross this boundary; a caller
//!    that needs one asks for it, and today nothing does.
//!
//! ## What these do not do
//!
//! They read, and that is the whole surface: no write command, no upload and
//! no delete exists, so nothing here can damage a skill. The store is a
//! directory the user owns and edits with their own editor, which is the whole
//! point of the format being files.
//!
//! Neither command knows what a project is. Enabling a skill *into* a project
//! is `project_reconcile_skills` and `project_layout` in
//! `src-tauri/src/ipc/project.rs`, over `vela_projects::reconcile_skills` — both
//! allowlisted, both in `generate_handler!`, both reading the `projects` table
//! that migration `0001_initial_schema.sql` creates.
//!
//! This paragraph used to say the opposite: that the mount was
//! `vela_skills::mount`, that no command called it, and that `project_update`
//! did not exist. The first was a second implementation nobody executed and is
//! now deleted; the other two were true once and had stopped being true without
//! the sentence changing. It is restated here rather than quietly corrected
//! because a comment pointing a future implementer at a dead module is the
//! defect `src/platform/claimed-guards.test.ts` exists to make expensive.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::State;
use vela_skills::{SkillListing, SkillProblem, SkillResources, SkillStore};

use super::{EmptyPayload, IpcError, IpcResult};

/// Process-wide handle to the canonical store.
///
/// Managed as its own state, for the reason `crate::store_host` gives for the
/// database: the application-data directory is only resolvable once the app
/// handle exists, which is inside `setup`, after `AppState` was built.
pub struct SkillsHandle {
    store: SkillStore,
}

impl SkillsHandle {
    pub fn new(store: SkillStore) -> Self {
        Self { store }
    }

    /// `<app data dir>/skills`, created if it is not there.
    ///
    /// `src/platform/contract-project.ts` requires the store to exist, empty,
    /// **before any command that reads it is served** — that is what makes
    /// "every enabled skill mounts unavailable" the behaviour on a machine with
    /// no skills, rather than one command creating the directory and another
    /// erroring on it.
    ///
    /// A creation failure is **not** fatal to startup. An unreadable store is
    /// an empty store, which is a state the contract already defines and every
    /// caller already handles; refusing to launch a chat application because a
    /// skills directory could not be made would be a worse answer than
    /// launching without skills. The failure is returned so the caller can say
    /// so out loud rather than swallow it.
    pub fn under_data_dir(data_dir: impl AsRef<Path>) -> (Self, Option<std::io::Error>) {
        let store = SkillStore::under_data_dir(data_dir);
        let failure = store.ensure_root().err();
        (Self::new(store), failure)
    }

    pub fn store(&self) -> &SkillStore {
        &self.store
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsListRes {
    /// Every directory in the store, in name order, including the ones that
    /// could not be parsed — those carry their problem instead of a
    /// description. A skill the user installed never silently disappears from
    /// this list.
    pub skills: Vec<SkillListing>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsReadReq {
    /// The skill's directory name. One path segment; anything else is
    /// `INVALID_PAYLOAD` and is refused before it is joined onto anything.
    pub name: String,
}

/// The answer to a read, as a union rather than a body plus an error field.
///
/// A malformed skill is **not** an `IpcError`. The request was well formed and
/// the host answered it truthfully: the file on disk is not a skill, and the
/// renderer already has to word that same closed vocabulary for the listing. An
/// error would make the caller handle one class of "this skill is broken" in a
/// catch block and the other in a branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SkillsReadRes {
    Skill {
        name: String,
        description: String,
        /// The instruction text: level two, loaded because this skill was
        /// asked for by name.
        body: String,
        /// Level three, by name only. No file's contents are read.
        resources: SkillResources,
    },
    Invalid {
        problem: SkillProblem,
    },
}

/// Pure logic — no Tauri types, so it is testable headlessly.
pub fn list_skills(store: &SkillStore) -> SkillsListRes {
    SkillsListRes {
        skills: store.list(),
    }
}

/// Pure logic — no Tauri types, so it is testable headlessly.
///
/// Two of the parse problems are answered as errors rather than as an `Invalid`
/// response, because they are not statements about the file:
///
///  - a name that is not one path segment is a bad **payload**, and refusing it
///    here is what stops the join that would make it a traversal;
///  - a directory that is not in the store at all is `NOT_FOUND`, which is what
///    the error taxonomy already means by "the addressed entity does not
///    exist".
pub fn read_skill(store: &SkillStore, name: &str) -> IpcResult<SkillsReadRes> {
    let header = match store.header(name) {
        Ok(header) => header,
        Err(SkillProblem::NameIsNotASinglePathSegment) => {
            return Err(IpcError::invalid("a skill name must be one path segment"))
        }
        Err(SkillProblem::NoSkillFile) => return Err(IpcError::not_found("no such skill")),
        Err(problem) => return Ok(SkillsReadRes::Invalid { problem }),
    };

    let body = match store.body(name) {
        Ok(body) => body,
        Err(problem) => return Ok(SkillsReadRes::Invalid { problem }),
    };
    let resources = store.resources(name).unwrap_or_default();

    Ok(SkillsReadRes::Skill {
        name: header.name,
        description: header.description,
        body,
        resources,
    })
}

#[tauri::command]
pub fn skills_list(
    state: State<'_, SkillsHandle>,
    payload: EmptyPayload,
) -> IpcResult<SkillsListRes> {
    let _ = payload;
    Ok(list_skills(state.store()))
}

#[tauri::command]
pub fn skills_read(
    state: State<'_, SkillsHandle>,
    payload: SkillsReadReq,
) -> IpcResult<SkillsReadRes> {
    read_skill(state.store(), &payload.name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn store_with(entries: &[(&str, &str)]) -> (tempfile::TempDir, SkillStore) {
        let root = tempfile::tempdir().unwrap();
        let (handle, failure) = SkillsHandle::under_data_dir(root.path());
        assert!(failure.is_none());
        for (directory, source) in entries {
            let path = handle.store().root().join(directory);
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join(vela_skills::SKILL_FILE_NAME), source).unwrap();
        }
        let store = handle.store().clone();
        (root, store)
    }

    const ALPHA: &str =
        "---\nname: alpha\ndescription: Does alpha. Use when alpha.\n---\n\n# Alpha\n\nDo the thing.\n";

    #[test]
    fn the_store_directory_is_created_before_anything_reads_it() {
        let root = tempfile::tempdir().unwrap();
        let (handle, failure) = SkillsHandle::under_data_dir(root.path());
        assert!(failure.is_none());
        assert!(handle.store().root().is_dir());
        assert_eq!(list_skills(handle.store()).skills, Vec::new());
    }

    #[test]
    fn the_listing_is_level_one_and_carries_no_body() {
        let (_root, store) = store_with(&[("alpha", ALPHA)]);
        let listed = list_skills(&store);
        assert_eq!(
            listed.skills,
            vec![SkillListing::Skill {
                directory: "alpha".to_owned(),
                name: "alpha".to_owned(),
                description: "Does alpha. Use when alpha.".to_owned(),
            }]
        );
        assert!(!format!("{listed:?}").contains("Do the thing"));
    }

    #[test]
    fn reading_one_skill_is_level_two_and_three() {
        let (_root, store) = store_with(&[("alpha", ALPHA)]);
        let scripts = store.root().join("alpha").join("scripts");
        fs::create_dir_all(&scripts).unwrap();
        fs::write(scripts.join("run.sh"), "echo hello").unwrap();

        match read_skill(&store, "alpha").unwrap() {
            SkillsReadRes::Skill {
                name,
                body,
                resources,
                ..
            } => {
                assert_eq!(name, "alpha");
                assert_eq!(body, "# Alpha\n\nDo the thing.\n");
                assert_eq!(resources.scripts, vec!["run.sh".to_owned()]);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_malformed_skill_answers_with_its_problem_rather_than_an_error() {
        let (_root, store) = store_with(&[("beta", "just prose, no frontmatter\n")]);
        assert_eq!(
            read_skill(&store, "beta").unwrap(),
            SkillsReadRes::Invalid {
                problem: SkillProblem::NoFrontmatter
            }
        );
    }

    #[test]
    fn an_unknown_skill_is_not_found_and_a_traversal_is_an_invalid_payload() {
        let (_root, store) = store_with(&[("alpha", ALPHA)]);
        assert_eq!(
            read_skill(&store, "nope").unwrap_err().code,
            super::super::IpcErrorCode::NotFound
        );
        for attempt in ["../alpha", "..", "sub/dir", "C:x"] {
            assert_eq!(
                read_skill(&store, attempt).unwrap_err().code,
                super::super::IpcErrorCode::InvalidPayload,
                "{attempt:?}"
            );
        }
    }
}
