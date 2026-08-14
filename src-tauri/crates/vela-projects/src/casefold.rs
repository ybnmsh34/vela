//! **Asking the filesystem how it folds case, rather than guessing.**
//!
//! Two enabled skills named `Foo` and `foo` are two skills and one directory on
//! Windows, and one skill each on a case-sensitive volume. Which of those is
//! true is a property of the volume the skills mount lives on, and nothing in a
//! renderer or in Unicode can answer it: JavaScript's `toLowerCase` is Unicode's
//! locale-independent mapping, NTFS compares through an upcase table fixed when
//! the volume was formatted, and a directory flagged case-sensitive on Windows
//! does not fold at all.
//!
//! So this module measures. It creates a probe directory under the volume in
//! question and asks whether the same name in the other case resolves to it.

use std::fs;
use std::path::Path;

/// What the volume under a given directory does with case.
///
/// Two members and not three, deliberately: this answers *whether* the volume
/// folds, and it does not claim to reproduce the volume's fold **table**. See
/// [`CaseFolding::folds`] for exactly how far that goes and where the authority
/// actually lies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaseFolding {
    /// `Foo` and `foo` are one directory entry here.
    Insensitive,
    /// `Foo` and `foo` are two.
    Sensitive,
    /// The probe could not run — the directory is unwritable, or gone. Treated
    /// as `Insensitive` by [`CaseFolding::folds`], because the expensive
    /// mistake is the other one: assuming two names are distinct and then
    /// writing both to one path.
    Unknown,
}

/// The probe name. Contains an ASCII letter in both cases so the question can be
/// asked at all, and is prefixed so a leftover is recognisable as ours.
const PROBE_UPPER: &str = ".vela-Case-Probe";
const PROBE_LOWER: &str = ".vela-case-probe";

impl CaseFolding {
    /// Measures `directory` by creating an entry under it and looking the same
    /// name up in a different case.
    ///
    /// The directory must already exist; this never creates it, because the
    /// caller that owns the directory is the caller that knows whether creating
    /// it is allowed.
    pub fn probe(directory: &Path) -> Self {
        let upper = directory.join(PROBE_UPPER);
        let lower = directory.join(PROBE_LOWER);
        let _ = fs::remove_dir_all(&upper);
        let _ = fs::remove_dir_all(&lower);

        if fs::create_dir(&upper).is_err() {
            return Self::Unknown;
        }
        let folded = lower.exists();
        let _ = fs::remove_dir_all(&upper);
        // Belt and braces: on a sensitive volume the two are different entries,
        // and `exists()` above created nothing — but a half-cleaned probe is a
        // directory the user would find and wonder about.
        let _ = fs::remove_dir_all(&lower);

        if folded {
            Self::Insensitive
        } else {
            Self::Sensitive
        }
    }

    /// Whether two skill names would land on the same path under this volume.
    ///
    /// **This is a best effort and the reconcile is the authority.** On a
    /// folding volume it compares Unicode simple lowercase, which agrees with
    /// NTFS on every name a skill is realistically called and can disagree on
    /// exotic ones. That asymmetry is affordable in exactly one direction, and
    /// it is the direction this is used in: this decides whether a *write* is
    /// refused with `INVALID_PAYLOAD`, and a pair it wrongly lets through is
    /// caught by `reconcile_skills`, which learns the truth by asking the
    /// filesystem whether the path is already there and reports
    /// `nameCollidesWithAnotherEnabledSkill`. A pair it wrongly refuses costs
    /// the user a rename. Nothing is ever silently deduplicated.
    ///
    /// Byte-identical names always collide, whatever the volume does.
    pub fn folds(self, left: &str, right: &str) -> bool {
        if left == right {
            return true;
        }
        match self {
            Self::Sensitive => false,
            Self::Insensitive | Self::Unknown => left.to_lowercase() == right.to_lowercase(),
        }
    }

    /// The first pair of entries in `names` that cannot both exist, in list
    /// order. `None` means the list is safe to write.
    pub fn first_collision(self, names: &[String]) -> Option<(&str, &str)> {
        for (index, later) in names.iter().enumerate() {
            for earlier in &names[..index] {
                if self.folds(earlier, later) {
                    return Some((earlier.as_str(), later.as_str()));
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_probe_measures_the_volume_and_leaves_nothing_behind() {
        let root = tempfile::tempdir().unwrap();
        let folding = CaseFolding::probe(root.path());

        assert_ne!(folding, CaseFolding::Unknown, "a tempdir is writable");
        if cfg!(windows) {
            assert_eq!(
                folding,
                CaseFolding::Insensitive,
                "an ordinary NTFS volume folds case, and the mount rules depend on it"
            );
        }
        assert!(!root.path().join(PROBE_UPPER).exists());
        assert!(!root.path().join(PROBE_LOWER).exists());
    }

    #[test]
    fn a_directory_that_cannot_be_probed_is_unknown_and_errs_toward_colliding() {
        let missing = std::path::Path::new("no-such-directory-anywhere").join("nested");
        let folding = CaseFolding::probe(&missing);
        assert_eq!(folding, CaseFolding::Unknown);
        assert!(
            folding.folds("Foo", "foo"),
            "not knowing must never license writing two mounts to one path"
        );
    }

    #[test]
    fn byte_identical_duplicates_collide_on_every_volume() {
        for folding in [
            CaseFolding::Sensitive,
            CaseFolding::Insensitive,
            CaseFolding::Unknown,
        ] {
            assert!(folding.folds("notes", "notes"));
        }
        assert!(!CaseFolding::Sensitive.folds("Notes", "notes"));
    }

    #[test]
    fn the_first_collision_is_reported_in_list_order_and_names_both_halves() {
        let names = vec![
            "alpha".to_string(),
            "Beta".to_string(),
            "gamma".to_string(),
            "beta".to_string(),
        ];
        assert_eq!(
            CaseFolding::Insensitive.first_collision(&names),
            Some(("Beta", "beta"))
        );
        assert_eq!(CaseFolding::Sensitive.first_collision(&names), None);
    }
}
