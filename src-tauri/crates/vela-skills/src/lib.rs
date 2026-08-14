//! # vela-skills
//!
//! The file-based skill store, and the mount a project reads it through.
//!
//! A skill is a directory holding a SKILL.md file: YAML frontmatter, then a
//! Markdown body. That is the public Agent Skills format
//! (`agentskills.io`), which `docs/references/mindshub-cowork.md` §6 establishes
//! the reference itself is built on — so this is an open format Vela reads, not
//! a shape Vela invented, and a skill written for one tool works in the other.
//!
//! ## What is wired, and what is not
//!
//! Stated first and plainly, because the defect this project keeps finding is a
//! module everybody believed was connected.
//!
//! **Reachable from the running application today:**
//! `skills_list` and `skills_read` in `src-tauri/src/ipc/skills.rs`, registered
//! in the allowlist and in `generate_handler!`, reading the real store under the
//! real application-data directory. [`store::SkillStore::ensure_root`] is called
//! from `configure`'s setup in `src-tauri/src/lib.rs`, which is what makes the
//! contract's "created empty at launch, before anything reads it" true.
//!
//! **Built, tested against real directories, and called by no command:**
//! everything in [`mount`] and [`enablement`]. Those implement the per-project
//! half — reconciling `<project root>/skills`, refusing a colliding
//! `enabledSkills` write — and the commands that would call them
//! (`project_create`, `project_update`, `project_reconcile_skills`) do not
//! exist: `src/platform/contract-project.ts` declares them, registers none, and
//! there is no projects table for them to read. They are here so that whoever
//! writes those commands finds the disk behaviour already built and already
//! covered, not so that anything can claim the feature ships.
//!
//! ## Progressive disclosure, as a shape rather than a policy
//!
//! The public spec loads `name` + `description` for every installed skill, the
//! body only when a skill activates, and the contents of the conventional
//! subdirectories only as needed. Here that is three calls returning three
//! types — [`document::SkillHeader`], a `String` body, and
//! [`store::SkillResources`] — and the first of them has no field a body could
//! travel in. A budget that is enforced by a type is a budget; a budget that is
//! enforced by remembering to truncate is a comment.
//!
//! ## Layout on disk
//!
//! ```text
//! <app data dir>/
//! ├── skills/<skill-name>/SKILL.md     the canonical store, one per machine
//! └── projects/<project-id>/
//!     └── skills/<skill-name>          the mount: a junction back to the store
//! ```

pub mod document;
pub mod enablement;
pub mod mount;
pub mod store;

pub use document::{
    body_of, is_single_path_segment, is_well_formed_name, parse_frontmatter, parse_header,
    FrontmatterEntry, ParsedFrontmatter, SkillHeader, SkillProblem, DESCRIPTION_MAX_CHARS,
    NAME_MAX_CHARS, SKILL_FILE_NAME,
};
pub use enablement::{
    fold, probe_case_folding, refuse_colliding_enabled_skills, CaseFolding, EnabledSkillsCollision,
};
pub use mount::{
    probe_link_strategy, reconcile, refresh_copy, remove_mount_entry, LinkFallbackReason,
    LinkStrategy, SkillLinkKind, SkillMount, SkillMountProblem, SkillMountStatus,
};
pub use store::{
    SkillListing, SkillResources, SkillStore, RESOURCE_DIRECTORIES, SKILL_STORE_DIRECTORY_NAME,
};
