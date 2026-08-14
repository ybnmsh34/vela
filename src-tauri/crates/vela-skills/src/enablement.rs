//! Which skills a project has switched on, and the one write this host refuses.
//!
//! `ProjectView.enabledSkills` in `src/platform/contract-project.ts` is
//! **intent**: a list of directory names, in the user's order, each of which
//! mounts at `<skillsMount>/<name>`. Amendment 1 of that contract settles what
//! happens when two entries are one directory:
//!
//!  1. **The write is refused** with `INVALID_PAYLOAD`, byte-identical
//!     duplicates included. Not deduplicated and not reordered — the user
//!     enabled two things, one of them cannot exist, and the host has no way to
//!     know which they meant. A refused write leaves the record as it was.
//!  2. **A record that already holds a colliding pair is reported, not
//!     repaired**: the first entry in list order mounts, every later colliding
//!     entry is reported unavailable. That half lives in `crate::mount`.
//!
//! [`refuse_colliding_enabled_skills`] is half 1. It is a function this crate
//! exports and **nothing in the shipped application calls it yet**, because the
//! commands that would — `project_create` and `project_update` — do not exist:
//! the project contract declares them and registers none, and there is no
//! projects table for them to write to. Said here rather than implied, because
//! a comment describing an enforcement nobody invokes is this project's central
//! defect wearing a helpful tone.
//!
//! ## Why the folding is measured rather than assumed
//!
//! The contract is explicit that the only answer that decides whether two
//! mounts land on one path is the filesystem's: NTFS compares through an upcase
//! table fixed when the volume was formatted, a directory flagged
//! case-sensitive on Windows does not fold at all, and a case-sensitive APFS
//! volume does not either. So [`probe_case_folding`] creates a file and asks
//! the volume, in the same spirit as the link probe in `crate::mount` and for
//! the reason `src-tauri/crates/vela-providers/src/private_fs.rs` records: a
//! setting that disagrees with the filesystem is a guess dressed as a fact.

use std::fs;
use std::path::Path;

/// What the volume holding the skills mount does with case.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaseFolding {
    /// Two names differing only by case are two directories.
    Sensitive,
    /// Two names differing only by case are one directory.
    Insensitive,
}

/// Two enabled entries that are one directory on this volume.
///
/// Carries both spellings and both positions so the host can say which pair,
/// rather than making the user compare a list against itself. The message the
/// user reads is still the renderer's to write — this is the fact, not the
/// sentence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnabledSkillsCollision {
    pub first_index: usize,
    pub first: String,
    pub second_index: usize,
    pub second: String,
}

/// The single spelling this host folds names by.
///
/// `to_lowercase`, Unicode's locale-independent mapping. It agrees with NTFS on
/// every name the skill-name grammar allows — those are `a`–`z`, `0`–`9` and
/// hyphens, where nothing is ambiguous — and it can disagree outside that set,
/// which is why an enabled entry is only ever *compared* through this function
/// and never rewritten by it. What lands on disk is always the string the user
/// wrote.
pub fn fold(name: &str, folding: CaseFolding) -> String {
    match folding {
        CaseFolding::Sensitive => name.to_owned(),
        CaseFolding::Insensitive => name.to_lowercase(),
    }
}

/// Half 1 of the collision rule: refuse the write.
///
/// Returns the **first** colliding pair in list order. One pair rather than all
/// of them because the write is refused whole either way, and a caller that
/// reported five pairs would be describing a list the user is about to edit.
pub fn refuse_colliding_enabled_skills(
    enabled: &[String],
    folding: CaseFolding,
) -> Result<(), EnabledSkillsCollision> {
    let mut seen: Vec<(String, usize)> = Vec::with_capacity(enabled.len());
    for (index, name) in enabled.iter().enumerate() {
        let key = fold(name, folding);
        if let Some((_, first_index)) = seen.iter().find(|(existing, _)| *existing == key) {
            return Err(EnabledSkillsCollision {
                first_index: *first_index,
                first: enabled[*first_index].clone(),
                second_index: index,
                second: name.clone(),
            });
        }
        seen.push((key, index));
    }
    Ok(())
}

/// Ask the volume whether it folds case, by writing a file and looking for it
/// under a different spelling.
///
/// The probe file is created inside `directory`, which must exist — the mount
/// root and the store root are both created by the host before anything reads
/// them, so there is always a real directory on the real volume to ask. It is
/// removed before this returns, on both the success and the failure path.
///
/// A probe that cannot run at all answers [`CaseFolding::Insensitive`]. That is
/// the conservative direction and the choice is deliberate: assuming
/// insensitivity refuses a write that might have been legal, and assuming
/// sensitivity accepts a pair that then silently becomes one mount. The second
/// is the silently-wrong outcome, so the unknown case takes the first.
pub fn probe_case_folding(directory: &Path) -> CaseFolding {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    let lower = format!(".vela-case-probe-{}-{stamp}", std::process::id());
    let upper = lower.to_ascii_uppercase();

    let lower_path = directory.join(&lower);
    if fs::write(&lower_path, b"case probe").is_err() {
        return CaseFolding::Insensitive;
    }
    let folded = directory.join(&upper).exists();
    let _ = fs::remove_file(&lower_path);

    if folded {
        CaseFolding::Insensitive
    } else {
        CaseFolding::Sensitive
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn a_case_collision_is_refused_rather_than_deduplicated() {
        let enabled = names(&["alpha", "Alpha", "beta"]);
        let collision =
            refuse_colliding_enabled_skills(&enabled, CaseFolding::Insensitive).unwrap_err();
        assert_eq!(collision.first, "alpha");
        assert_eq!(collision.first_index, 0);
        assert_eq!(collision.second, "Alpha");
        assert_eq!(collision.second_index, 1);
        assert_eq!(
            enabled,
            names(&["alpha", "Alpha", "beta"]),
            "a refused write leaves the list exactly as it was"
        );
    }

    #[test]
    fn a_byte_identical_duplicate_is_a_collision_on_every_volume() {
        for folding in [CaseFolding::Sensitive, CaseFolding::Insensitive] {
            let enabled = names(&["alpha", "alpha"]);
            assert!(refuse_colliding_enabled_skills(&enabled, folding).is_err());
        }
    }

    #[test]
    fn the_same_pair_is_legal_on_a_case_sensitive_volume() {
        let enabled = names(&["alpha", "Alpha"]);
        assert!(refuse_colliding_enabled_skills(&enabled, CaseFolding::Sensitive).is_ok());
        assert!(refuse_colliding_enabled_skills(&enabled, CaseFolding::Insensitive).is_err());
    }

    #[test]
    fn an_empty_or_single_entry_list_never_collides() {
        assert!(refuse_colliding_enabled_skills(&[], CaseFolding::Insensitive).is_ok());
        assert!(
            refuse_colliding_enabled_skills(&names(&["only"]), CaseFolding::Insensitive).is_ok()
        );
    }

    #[test]
    fn folding_compares_and_never_rewrites() {
        assert_eq!(fold("Alpha", CaseFolding::Insensitive), "alpha");
        assert_eq!(fold("Alpha", CaseFolding::Sensitive), "Alpha");
    }

    #[test]
    fn the_probe_answers_from_the_volume_and_leaves_nothing_behind() {
        let directory = tempfile::tempdir().unwrap();
        let before = fs::read_dir(directory.path()).unwrap().count();
        let answer = probe_case_folding(directory.path());
        let after = fs::read_dir(directory.path()).unwrap().count();

        // Which answer is right depends on the volume this test is running on,
        // so the assertion is on the two things that are true everywhere: the
        // probe answers, and it cleans up after itself.
        assert!(matches!(
            answer,
            CaseFolding::Sensitive | CaseFolding::Insensitive
        ));
        assert_eq!(after, before);

        // On Windows the answer is knowable, and asserting it there is what
        // makes this more than a smoke test.
        #[cfg(windows)]
        assert_eq!(answer, CaseFolding::Insensitive);
    }

    #[test]
    fn a_probe_that_cannot_write_takes_the_conservative_answer() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("not-created");
        assert_eq!(probe_case_folding(&missing), CaseFolding::Insensitive);
    }
}
