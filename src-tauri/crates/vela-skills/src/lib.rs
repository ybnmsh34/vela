//! # vela-skills
//!
//! The file-based skill store. **Only** the store: the mount a project reads it
//! through belongs to `vela-projects`, and the two sentences below say why that
//! is worth stating in the first line of the crate.
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
//! **Deleted, and the reason recorded here rather than lost with the diff:**
//! this crate used to carry a `mount` module and an `enablement` module — the
//! per-project half, reconciling `<project root>/skills` and refusing a
//! colliding `enabledSkills` write. Nothing ever called either one. They were
//! kept under a header that said the commands which would call them
//! "do not exist", and by the time anybody re-read that sentence all three of
//! them did: `project_create`, `project_update` and `project_reconcile_skills`
//! are in `COMMAND_ALLOWLIST` and in `generate_handler!`, the projects table has
//! existed since migration `0001_initial_schema.sql`, and
//! `src/platform/contract-project.ts` both declares and lists all eight project
//! commands. They were wired the whole time — to `vela-projects`, whose
//! `mount.rs`, `link.rs` and `casefold.rs` are the implementation that runs.
//!
//! So the modules were not waiting for a caller. They were a second complete
//! implementation of the junction rule, the reparse-aware delete and case
//! folding, sitting behind an explanation that had quietly expired, and a guard
//! named skill-mount-parity.test.ts was pinning the TypeScript contract to
//! *them* rather than to the copy that ships. **The crate now spells exactly one
//! thing: the store.** Anything about a project's view of it is in
//! `vela-projects`, and `src/platform/project-host-parity.test.ts` is what pins
//! that crate's wire names.
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
//! ├── skills/<skill-name>/SKILL.md     the canonical store — THIS CRATE
//! └── projects/<project-id>/
//!     └── skills/<skill-name>          the mount, a junction back to the store,
//!                                      owned by `vela-projects`
//! ```

pub mod document;
pub mod store;

pub use document::{
    body_of, is_single_path_segment, is_well_formed_name, parse_frontmatter, parse_header,
    FrontmatterEntry, ParsedFrontmatter, SkillHeader, SkillProblem, DESCRIPTION_MAX_CHARS,
    NAME_MAX_CHARS, SKILL_FILE_NAME,
};
pub use store::{
    SkillListing, SkillResources, SkillStore, RESOURCE_DIRECTORIES, SKILL_STORE_DIRECTORY_NAME,
};
