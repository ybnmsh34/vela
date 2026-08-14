//! # vela-projects
//!
//! **A project's three host-owned directories, and the rules for touching
//! them.** This crate is the implementation of the on-disk half of
//! `src/platform/contract-project.ts`; the record half (name, instructions,
//! enabled skills, working-directory binding) lives in `vela-store`, and the
//! command layer that joins them is `src-tauri/src/ipc/project.rs`.
//!
//! It knows nothing about SQLite, nothing about Tauri and nothing about the
//! renderer. It is handed an application-data directory and a project id and it
//! answers with what is actually on disk — which is what lets every rule below
//! be tested headlessly against a `tempfile::TempDir`.
//!
//! ## The layout
//!
//! ```text
//! <app data dir>/
//! ├── vela.db                        the store. NOT inside any project root.
//! ├── skills/<skill-name>/           the canonical skill store, host-wide
//! └── projects/<project-id>/         one per project — the root
//!     ├── workspace/                 the private agent workspace
//!     └── skills/<skill-name>        the mount: a link back to the store
//! ```
//!
//! Directories are keyed by **id**, never by name, so renaming a project moves
//! nothing. See [`ProjectPaths`].
//!
//! ## The two rules that will destroy a machine if they are got wrong
//!
//! 1. **Symlinks are never used on Windows, even where they would succeed.**
//!    Creating one needs a privilege ordinary accounts do not hold, so a design
//!    that mounts skills with symlinks works for the developer and fails for the
//!    user. [`probe_link_strategy`] establishes what this machine does by
//!    *attempting the real operation* in a scratch directory, and on Windows the
//!    operation it attempts is a **directory junction** —
//!    `IO_REPARSE_TAG_MOUNT_POINT`, what `mklink /J` makes — which any
//!    unprivileged user can create. There is no Developer Mode branch and no
//!    "symlinks are available" flag, because behaviour must not depend on a
//!    machine-wide developer setting.
//!
//! 2. **A junction is a reparse point, and a naive recursive delete walks
//!    through it into the canonical skill store.** Every removal in this crate
//!    goes through [`remove_tree`], which asks
//!    [`is_reparse_point`] before it descends and unlinks instead. One wrong
//!    delete takes every skill on the machine, not one project's view of them.
//!    `removing_a_project_root_unlinks_the_skill_mounts_instead_of_emptying_the_store`
//!    is the test that holds it, and it fails if `is_reparse_point` stops
//!    answering truthfully.
//!
//! ## What this crate does not do
//!
//! It never creates, scaffolds, or writes a byte inside the user's **working
//! directory**. [`resolve_working_directory`] reads it and reports; a missing one
//! is reported, never recreated, because conjuring an empty folder where a user's
//! files used to be looks exactly like data loss.

mod casefold;
mod layout;
mod link;
mod mount;
mod workdir;

pub use casefold::CaseFolding;
pub use layout::{
    create_project_directories, ensure_skill_store, project_root, projects_root,
    remove_project_root, resolve_layout, skill_store, ProjectDirectory, ProjectLayout,
    ProjectPaths,
};
pub use link::{
    copy_tree, create_link, directory_is_writable, is_reparse_point, probe_link_strategy,
    remove_tree, trees_have_same_content, LinkFallbackReason, LinkStrategy, SkillLinkKind,
};
pub use mount::{reconcile_skills, SkillMount, SkillMountProblem, SkillMountStatus};
pub use workdir::{
    resolve_working_directory, validate_binding, WorkingDirectory, WorkingDirectoryBinding,
    WorkingDirectoryProblem, WorkingDirectoryRefusal,
};
