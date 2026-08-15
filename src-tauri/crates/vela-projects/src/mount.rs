//! Reconciling the skills mount: one entry per **enabled** skill, reported as it
//! actually is.

use std::fs;
use std::io;
use std::path::{Component, Path};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::casefold::CaseFolding;
use crate::layout::ProjectPaths;
use crate::link::{
    copy_tree, create_link, is_reparse_point, occupant_of, remove_tree, trees_have_same_content,
    LinkStrategy, MountOccupant, SkillLinkKind,
};

/// The longest mount path this platform will accept.
///
/// 260 on Windows is the classic limit, and it bites here because a project root
/// is already deep before a skill name is appended to it. Long-path support is
/// opt-in per call and cannot be assumed of every API that will later walk this
/// tree, so the conservative number is the honest one.
const MAX_MOUNT_PATH_CHARS: usize = if cfg!(windows) { 260 } else { 4096 };

/// Why one skill could not be mounted, when the machine can mount others.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillMountProblem {
    /// Enabled on the project, absent from the canonical store. The normal
    /// state on a machine with no skills installed.
    SkillNotFound,
    /// The name is not a single path segment. Rejected **before** it is joined
    /// onto a path: a name carrying a separator or a parent reference is a
    /// directory-traversal attempt wearing a skill's clothes.
    NameIsNotASinglePathSegment,
    /// The resulting path exceeded what the platform accepts.
    PathTooLong,
    /// Something already occupies the mount path and is not ours to replace.
    OccupiedByUnrelatedEntry,
    /// An earlier entry in the enabled list already mounted at this path: two
    /// enabled names that are one directory under this volume's casing rules.
    ///
    /// **Distinct from `OccupiedByUnrelatedEntry`, and the distinction is the
    /// whole reason this member exists.** There the occupant is a stranger and
    /// the repair is the user's; here the occupant is this project's own other
    /// skill and the repair is to disable one of the two. Told the wrong one, a
    /// user goes and looks at a directory that is exactly as Vela made it.
    ///
    /// Decided twice over, and the second one is the authority:
    /// [`CaseFolding::folds`] compares the names in memory, and
    /// [`crate::occupant_of`] then asks the volume which name the entry at
    /// the mount path actually carries.
    NameCollidesWithAnotherEnabledSkill,
    PermissionDenied,
}

/// The state of one mounted skill.
///
/// `Copied` is a separate variant rather than a third [`SkillLinkKind`], and
/// that is the point of this union: a copy is a **snapshot**. Edit the canonical
/// skill and the project keeps running the old one until something re-copies
/// it. Folding it in beside the link kinds would let every consumer treat all
/// three identically — the UI must be unable to render a copy without also being
/// handed `copiedAtMs` and `stale`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SkillMountStatus {
    Linked {
        link: SkillLinkKind,
        path: String,
    },
    Copied {
        path: String,
        copied_at_ms: i64,
        /// The canonical skill has changed since the copy was taken. Compared
        /// by content, not by timestamp: a file synced onto this machine can
        /// arrive with an older modification time than the copy it invalidates.
        stale: bool,
    },
    Unavailable {
        problem: SkillMountProblem,
    },
}

/// One entry in the skills mount.
///
/// There is exactly one of these per **enabled** skill. A skill that failed to
/// mount still appears, with an `Unavailable` status — dropping it would let a
/// project silently run without a skill the user switched on, and
/// silently-wrong is the one forbidden outcome.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMount {
    pub name: String,
    /// `<skillStore>/<name>`, joined by the host.
    ///
    /// **`None` in exactly one case, and it is not an omission.** A name that is
    /// not a single path segment must be rejected *before* it is joined, so
    /// producing its resolved path in order to report it would perform the very
    /// join the rule forbids. Every other status carries the path, including
    /// `SkillNotFound`, so a UI explaining why a skill is missing can name where
    /// it looked.
    pub source: Option<String>,
    pub status: SkillMountStatus,
}

impl SkillMount {
    fn unavailable(name: &str, source: Option<String>, problem: SkillMountProblem) -> Self {
        Self {
            name: name.to_owned(),
            source,
            status: SkillMountStatus::Unavailable { problem },
        }
    }
}

/// Re-mounts the enabled skills and reports what happened. Idempotent.
///
/// Order is the record's order, and it decides who wins a collision: the first
/// entry mounts, every later entry that collides with an earlier one is reported
/// rather than silently dropped.
pub fn reconcile_skills(
    paths: &ProjectPaths,
    strategy: LinkStrategy,
    enabled: &[String],
    folding: CaseFolding,
) -> Vec<SkillMount> {
    let mount_root = paths.skills_mount_path();
    sweep(mount_root, enabled, folding);

    let mut mounts = Vec::with_capacity(enabled.len());
    let mut already_mounted: Vec<&str> = Vec::new();

    for name in enabled {
        if !is_single_path_segment(name) {
            mounts.push(SkillMount::unavailable(
                name,
                None,
                SkillMountProblem::NameIsNotASinglePathSegment,
            ));
            continue;
        }

        let source = paths.skill_store_path().join(name);
        let source_text = Some(source.to_string_lossy().into_owned());
        let mount = mount_root.join(name);

        if mount.to_string_lossy().chars().count() > MAX_MOUNT_PATH_CHARS {
            mounts.push(SkillMount::unavailable(
                name,
                source_text,
                SkillMountProblem::PathTooLong,
            ));
            continue;
        }

        if already_mounted
            .iter()
            .any(|earlier| folding.folds(earlier, name))
        {
            mounts.push(SkillMount::unavailable(
                name,
                source_text,
                SkillMountProblem::NameCollidesWithAnotherEnabledSkill,
            ));
            continue;
        }

        // The same question, asked of the volume rather than of a case table.
        if let Some(problem) = refusal_for(&occupant_of(&mount), &already_mounted) {
            mounts.push(SkillMount::unavailable(name, source_text, problem));
            continue;
        }
        // Recorded even when the mount below fails. The promise is one entry per
        // enabled skill, and a later `foo` after a failed `Foo` is still a
        // collision — reporting it as a second independent failure would tell
        // the user to go and fix two things when there is one.
        already_mounted.push(name);

        if !source.is_dir() {
            mounts.push(SkillMount::unavailable(
                name,
                source_text,
                SkillMountProblem::SkillNotFound,
            ));
            continue;
        }

        mounts.push(SkillMount {
            name: name.clone(),
            source: source_text,
            status: mount_one(&source, &mount, strategy),
        });
    }

    mounts
}

/// Whether the volume's answer about a mount path forbids writing to it, given
/// the names this pass has already mounted.
///
/// **This is the backstop that lets [`CaseFolding::folds`] be an
/// approximation.** `folds` compares Unicode simple lowercase in memory and can
/// miss a pair this volume's upcase table joins into one entry. This asks the
/// directory what it actually holds at the path about to be written, and
/// byte-compares — a comparison here that folded case would be the
/// approximation the whole check exists to catch.
///
/// Without it a miss is not a near miss: `mount_one` opens with
/// `remove_tree(mount)`, which on such a pair is the *earlier* skill's entry, so
/// the first skill is unlinked, a link is made at what the volume considers the
/// same path, and both entries are then reported `Linked` with different `path`
/// strings naming one directory — the silently-wrong outcome this module's
/// header and conventions §9 rule 6 forbid.
///
/// The two refusals the volume itself can make are handled oppositely, and that
/// asymmetry is the whole reason [`MountOccupant`] has four members:
///
///  - [`MountOccupant::Indeterminate`] — it would not say whether anything is
///    there — is walked into. Whatever refused that question refuses the
///    removal too, so nothing is destroyed by trying, and `problem` then
///    reports the real error and can still tell `PermissionDenied` from an
///    occupied entry. Guessing here would only replace a diagnosis with a guess.
///  - [`MountOccupant::PresentButUnnamed`] — something is there and it would
///    not say what — is **not**. The entry is real and removable; only the
///    question was refused. Proceeding is exactly the overwrite this function
///    exists to prevent, with the volume's answer withheld instead of wrong.
///
/// That refusal is deliberately conservative in two ways worth writing down.
/// `already_mounted` carries names whose mount *failed*, so a pass can refuse on
/// account of an earlier name that never created anything; and on a volume that
/// will not enumerate its own mount root at all, every skill after the first
/// comes back `occupiedByUnrelatedEntry` rather than mounting. Both are loud,
/// both are recoverable by disabling a skill, and both are the cheap side of a
/// trade whose expensive side is one skill's mount silently replacing another's.
fn refusal_for(occupant: &MountOccupant, already_mounted: &[&str]) -> Option<SkillMountProblem> {
    match occupant {
        MountOccupant::Free | MountOccupant::Indeterminate => None,
        // The entry there is one this pass already mounted: two enabled names,
        // one directory, whatever `folds` said about them.
        MountOccupant::Named(stored) if already_mounted.contains(&stored.as_str()) => {
            Some(SkillMountProblem::NameCollidesWithAnotherEnabledSkill)
        }
        // Named, and not ours from this pass: this name's own mount from an
        // earlier reconcile, or a stranger's directory. Both are the
        // remove-and-re-point case, and `mount_one` reports a stranger it
        // cannot replace.
        MountOccupant::Named(_) => None,
        // Nothing has been mounted yet, so there is nothing of this pass's to
        // destroy and the ordinary path is safe.
        MountOccupant::PresentButUnnamed if already_mounted.is_empty() => None,
        MountOccupant::PresentButUnnamed => Some(SkillMountProblem::OccupiedByUnrelatedEntry),
    }
}

/// Removes every entry under the mount root that no enabled name claims.
///
/// A skill the user switched off must stop being visible to the agent on the
/// next reconcile, not on the next restart. Removal goes through `remove_tree`,
/// so a junction is detached rather than followed.
fn sweep(mount_root: &Path, enabled: &[String], folding: CaseFolding) {
    let Ok(entries) = fs::read_dir(mount_root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if enabled.iter().any(|wanted| folding.folds(wanted, &name)) {
            continue;
        }
        let _ = remove_tree(&entry.path());
    }
}

fn mount_one(source: &Path, mount: &Path, strategy: LinkStrategy) -> SkillMountStatus {
    match strategy.link_kind() {
        Some(link) => {
            // A link is cheap and must be re-pointed rather than trusted: the
            // canonical store may have moved since it was made.
            if let Err(error) = remove_tree(mount) {
                return problem(error);
            }
            match create_link(mount, source) {
                Ok(()) => SkillMountStatus::Linked {
                    link,
                    path: mount.to_string_lossy().into_owned(),
                },
                Err(error) => problem(error),
            }
        }
        None => copy_one(source, mount),
    }
}

/// The copying path, which is deliberately **not** "delete and re-copy".
///
/// Re-copying on every read would make `stale` permanently `false` and the flag
/// a lie: the whole point of the copied variant is that a project can be running
/// a snapshot that no longer matches the canonical skill. So an existing copy is
/// kept and measured.
fn copy_one(source: &Path, mount: &Path) -> SkillMountStatus {
    let existing = fs::symlink_metadata(mount);
    let reusable = matches!(&existing, Ok(metadata) if metadata.is_dir())
        && !is_reparse_point(mount).unwrap_or(true);

    if reusable {
        let stale = !trees_have_same_content(source, mount).unwrap_or(true);
        return SkillMountStatus::Copied {
            path: mount.to_string_lossy().into_owned(),
            copied_at_ms: modified_at_ms(mount),
            stale,
        };
    }

    if existing.is_ok() {
        if let Err(error) = remove_tree(mount) {
            return problem(error);
        }
    }
    match copy_tree(source, mount) {
        Ok(()) => SkillMountStatus::Copied {
            path: mount.to_string_lossy().into_owned(),
            copied_at_ms: modified_at_ms(mount),
            stale: false,
        },
        Err(error) => problem(error),
    }
}

fn problem(error: io::Error) -> SkillMountStatus {
    SkillMountStatus::Unavailable {
        problem: if error.kind() == io::ErrorKind::PermissionDenied {
            SkillMountProblem::PermissionDenied
        } else {
            // The path is there and this host could not make it ours. That is
            // exactly what `OccupiedByUnrelatedEntry` says, and it is the only
            // honest answer available: the host cannot see who put it there.
            SkillMountProblem::OccupiedByUnrelatedEntry
        },
    }
}

/// When the mount directory was last written, which for a copy this crate made
/// and nothing else touches is when the copy was taken.
///
/// Said plainly rather than dressed up as a recorded timestamp: nothing stores
/// the moment of the copy, and a directory somebody edited by hand will report
/// that edit instead. `0` when the platform cannot answer — an absence, not a
/// claim that the copy was taken in 1970, and the reason `stale` is computed
/// from content rather than from this number.
fn modified_at_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .and_then(|since| i64::try_from(since.as_millis()).ok())
        .unwrap_or(0)
}

/// Whether `name` addresses one directory directly under the mount root.
///
/// Rejects separators of either flavour, drive-relative forms, `.` and `..`, a
/// NUL, and anything with leading or trailing whitespace — Windows silently
/// strips a trailing space or dot from a filename, so `research ` and `research`
/// would be one directory under two names.
fn is_single_path_segment(name: &str) -> bool {
    if name.is_empty() || name.trim() != name || name.ends_with('.') {
        return false;
    }
    if name.contains(['/', '\\', ':', '\0']) {
        return false;
    }
    let mut components = Path::new(name).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::{create_project_directories, ensure_skill_store, skill_store};
    use crate::link::probe_link_strategy;

    const PROJECT: &str = "proj_reconcile";

    struct Fixture {
        _dir: tempfile::TempDir,
        paths: ProjectPaths,
        strategy: LinkStrategy,
        folding: CaseFolding,
        app_data: std::path::PathBuf,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        ensure_skill_store(dir.path()).unwrap();
        let paths = create_project_directories(dir.path(), PROJECT).unwrap();
        let strategy = probe_link_strategy(dir.path());
        let folding = CaseFolding::probe(paths.skills_mount_path());
        Fixture {
            app_data: dir.path().to_path_buf(),
            _dir: dir,
            paths,
            strategy,
            folding,
        }
    }

    /// A machine whose application-data volume cannot hold a link, so every
    /// mount is a copy. Exercised on every platform rather than only on the
    /// exotic ones it describes, because the copying branch is otherwise
    /// unreachable on any machine the suite actually runs on.
    fn copying_fixture() -> Fixture {
        let mut fixture = fixture();
        fixture.strategy = LinkStrategy::Copy {
            reason: crate::link::LinkFallbackReason::FilesystemDoesNotSupportLinks,
        };
        fixture
    }

    impl Fixture {
        fn install(&self, name: &str, body: &str) -> std::path::PathBuf {
            let path = skill_store(&self.app_data).join(name);
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("SKILL.md"), body).unwrap();
            path
        }

        fn reconcile(&self, enabled: &[&str]) -> Vec<SkillMount> {
            let enabled: Vec<String> = enabled.iter().map(|name| (*name).to_string()).collect();
            reconcile_skills(&self.paths, self.strategy, &enabled, self.folding)
        }
    }

    #[test]
    fn there_is_one_entry_per_enabled_skill_even_when_a_skill_cannot_be_mounted() {
        let fixture = fixture();
        fixture.install("research", "# research");

        let mounts = fixture.reconcile(&["research", "never-installed"]);

        assert_eq!(mounts.len(), 2, "a failed mount is reported, never dropped");
        assert_eq!(mounts[0].name, "research");
        assert_eq!(mounts[1].name, "never-installed");
        assert_eq!(
            mounts[1].status,
            SkillMountStatus::Unavailable {
                problem: SkillMountProblem::SkillNotFound
            }
        );
        assert!(
            mounts[1]
                .source
                .as_deref()
                .unwrap()
                .ends_with("never-installed"),
            "a skill that is merely absent still says where the host looked"
        );
    }

    #[test]
    fn an_empty_canonical_store_makes_every_enabled_skill_unavailable_and_is_not_an_error() {
        let fixture = fixture();
        let mounts = fixture.reconcile(&["research", "writing"]);
        assert!(mounts.iter().all(|mount| mount.status
            == SkillMountStatus::Unavailable {
                problem: SkillMountProblem::SkillNotFound
            }));
    }

    #[test]
    fn a_name_that_is_not_a_single_segment_is_refused_before_it_is_ever_joined() {
        let fixture = fixture();
        for hostile in [
            "../../escape",
            "..\\escape",
            "nested/skill",
            "nested\\skill",
            "..",
            ".",
            "C:evil",
            " research",
            "research ",
        ] {
            let mounts = fixture.reconcile(&[hostile]);
            assert_eq!(
                mounts[0].status,
                SkillMountStatus::Unavailable {
                    problem: SkillMountProblem::NameIsNotASinglePathSegment
                },
                "`{hostile}` must be refused"
            );
            assert_eq!(
                mounts[0].source, None,
                "`{hostile}` must not be joined onto a path in order to be reported"
            );
        }
        // Nothing escaped: the traversal attempts created nothing anywhere.
        assert!(!fixture.app_data.join("escape").exists());
    }

    #[test]
    fn two_names_that_are_one_directory_mount_the_first_and_report_the_second() {
        let fixture = fixture();
        if fixture.folding == CaseFolding::Sensitive {
            // On a case-sensitive volume these really are two skills, and the
            // rule under test does not apply.
            return;
        }
        fixture.install("Research", "# upper");
        fixture.install("writing", "# writing");

        let mounts = fixture.reconcile(&["Research", "writing", "research"]);

        assert_eq!(mounts.len(), 3);
        assert!(matches!(
            mounts[0].status,
            SkillMountStatus::Linked { .. } | SkillMountStatus::Copied { .. }
        ));
        assert_eq!(
            mounts[2].status,
            SkillMountStatus::Unavailable {
                problem: SkillMountProblem::NameCollidesWithAnotherEnabledSkill
            },
            "the later entry is reported as a collision, not as a stranger's directory \
             and not as a silent dedupe"
        );
    }

    /// The backstop that lets [`CaseFolding::folds`] be an approximation,
    /// over a pair this volume really does treat as one entry.
    ///
    /// **8.3 short-name aliasing is the cheapest real instance of the hazard.**
    /// `RESEAR~1` and the long name it abbreviates are one directory entry on an
    /// ordinary NTFS volume, and Unicode simple lowercase calls them two, so
    /// `folds` waves them through — no exotic character required, just a skill
    /// whose name is long. An earlier version of this test said no such pair
    /// could be exhibited; it was looking only at Unicode case mappings, and a
    /// critic found this one and FAT32 pairs besides. What is measured rather
    /// than assumed is whether the volume generates an alias at all, since that
    /// is a per-volume setting.
    ///
    /// The forced case below covers the machines where it does not, and covers
    /// the general shape: any in-memory verdict of "two distinct names" laid
    /// over a volume that holds one entry. It supplies the disagreement through
    /// the `folding` argument, which is the only channel by which one can reach
    /// `reconcile_skills` on a machine with no aliasing and no FAT32 to hand.
    #[test]
    fn a_collision_the_case_table_misses_is_still_caught_by_the_filesystem() {
        // The real pair, with nothing forced.
        for fixture in [fixture(), copying_fixture()] {
            const LONG: &str = "Research Notes Long Name";
            fixture.install(LONG, "# long");
            fixture.reconcile(&[LONG]);

            let Some(alias) =
                crate::link::short_name_alias(&fixture.paths.skills_mount_path().join(LONG))
            else {
                continue; // this volume makes no 8.3 alias; nothing to test here
            };
            assert!(
                !fixture.folding.folds(LONG, &alias),
                "the premise: `{alias}` and `{LONG}` are two different skills in memory"
            );

            let mounts = fixture.reconcile(&[LONG, &alias]);
            assert_collision_was_caught(&mounts, &fixture, LONG, "# long");
        }

        // The same shape, forced, for a volume that hands out no alias.
        for mut fixture in [fixture(), copying_fixture()] {
            if CaseFolding::probe(fixture.paths.skills_mount_path()) != CaseFolding::Insensitive {
                // A volume that really does keep the two apart cannot have this
                // failure, and forcing the verdict here would test nothing.
                continue;
            }
            fixture.folding = CaseFolding::Sensitive;
            fixture.install("Research", "# upper");

            let mounts = fixture.reconcile(&["Research", "research"]);
            assert_collision_was_caught(&mounts, &fixture, "Research", "# upper");
        }
    }

    /// The first name mounted, the second was reported, and one directory is
    /// named by exactly one of them.
    fn assert_collision_was_caught(
        mounts: &[SkillMount],
        fixture: &Fixture,
        first: &str,
        body: &str,
    ) {
        assert_eq!(mounts.len(), 2);
        assert!(
            matches!(
                mounts[0].status,
                SkillMountStatus::Linked { .. } | SkillMountStatus::Copied { .. }
            ),
            "the first name mounts, as it would on any volume"
        );
        assert_eq!(
            mounts[1].status,
            SkillMountStatus::Unavailable {
                problem: SkillMountProblem::NameCollidesWithAnotherEnabledSkill
            },
            "the names were two in memory; the volume holds one entry, and it is the authority"
        );

        let live = mounts
            .iter()
            .filter(|mount| {
                matches!(
                    mount.status,
                    SkillMountStatus::Linked { .. } | SkillMountStatus::Copied { .. }
                )
            })
            .count();
        assert_eq!(
            live, 1,
            "one directory reported by two mounts under two `path` strings is the silently-wrong outcome the backstop exists to prevent"
        );

        let mount_root = fixture.paths.skills_mount_path();
        assert_eq!(
            fs::read_to_string(mount_root.join(first).join("SKILL.md")).unwrap(),
            body,
            "the first skill's mount survived the second skill's arrival"
        );
        assert_eq!(
            fs::read_dir(mount_root).unwrap().count(),
            1,
            "and there is exactly one entry to survive"
        );
    }

    /// Every answer the volume can give, and what each one licenses.
    ///
    /// The two refusal shapes are the reason this is a table rather than a
    /// reading of the branch: neither can be produced on demand on an ordinary
    /// machine — `PresentButUnnamed` needs an ACL granting traverse and
    /// withholding list on the mount root, and `Indeterminate` needs the
    /// existence question itself refused — so the decision they drive is tested
    /// where it is made rather than left to a scenario nobody can build. What
    /// this does not prove is that [`occupant_of`] really answers
    /// `PresentButUnnamed` in that ACL state; it proves what `reconcile_skills`
    /// does when it does.
    #[test]
    fn what_the_volume_says_about_the_path_decides_whether_it_may_be_written() {
        let nothing: &[&str] = &[];
        let earlier: &[&str] = &["Research"];

        assert_eq!(refusal_for(&MountOccupant::Free, earlier), None);
        assert_eq!(
            refusal_for(&MountOccupant::Named("Research".into()), earlier),
            Some(SkillMountProblem::NameCollidesWithAnotherEnabledSkill),
            "the entry is one this pass already mounted, whatever `folds` said"
        );
        assert_eq!(
            refusal_for(&MountOccupant::Named("research".into()), earlier),
            None,
            "byte-for-byte: a case-folding comparison here would reintroduce the \
             approximation this check exists to catch"
        );
        assert_eq!(
            refusal_for(&MountOccupant::Named("leftover".into()), earlier),
            None,
            "this name's own earlier mount, or a stranger — both are remove-and-re-point"
        );
        assert_eq!(
            refusal_for(&MountOccupant::Indeterminate, earlier),
            None,
            "walked into on purpose: the removal that follows fails the same way and \
             reports the real error, so nothing is lost by trying"
        );
        assert_eq!(
            refusal_for(&MountOccupant::PresentButUnnamed, earlier),
            Some(SkillMountProblem::OccupiedByUnrelatedEntry),
            "something is there, the volume withheld its name, and removing it could \
             be removing the skill mounted a moment ago — the one answer that cannot \
             be acted on"
        );
        assert_eq!(
            refusal_for(&MountOccupant::PresentButUnnamed, nothing),
            None,
            "with nothing mounted yet there is nothing of this pass's to destroy"
        );
    }

    #[test]
    fn switching_a_skill_off_removes_its_mount_on_the_next_reconcile() {
        let fixture = fixture();
        fixture.install("research", "# research");
        fixture.install("writing", "# writing");

        fixture.reconcile(&["research", "writing"]);
        assert!(fixture.paths.skills_mount_path().join("writing").exists());

        fixture.reconcile(&["research"]);
        assert!(fixture.paths.skills_mount_path().join("research").exists());
        assert!(!fixture.paths.skills_mount_path().join("writing").exists());
    }

    #[test]
    fn a_mount_reaches_the_canonical_skill_and_reconciling_twice_changes_nothing() {
        let fixture = fixture();
        let installed = fixture.install("research", "# research");

        let first = fixture.reconcile(&["research"]);
        let second = fixture.reconcile(&["research"]);
        assert_eq!(first[0].name, second[0].name);

        let mounted = fixture.paths.skills_mount_path().join("research");
        assert_eq!(
            fs::read_to_string(mounted.join("SKILL.md")).unwrap(),
            "# research"
        );
        assert!(installed.join("SKILL.md").is_file());
    }

    #[test]
    fn a_copy_is_a_snapshot_and_goes_stale_when_the_canonical_skill_changes() {
        let fixture = copying_fixture();
        let installed = fixture.install("research", "# research");

        let first = fixture.reconcile(&["research"]);
        match &first[0].status {
            SkillMountStatus::Copied { stale, path, .. } => {
                assert!(!stale, "a copy just taken is not stale");
                assert_eq!(
                    fs::read_to_string(Path::new(path).join("SKILL.md")).unwrap(),
                    "# research"
                );
            }
            other => panic!("expected a copy, got {other:?}"),
        }

        fs::write(installed.join("SKILL.md"), "# research, revised").unwrap();
        let second = fixture.reconcile(&["research"]);
        match &second[0].status {
            SkillMountStatus::Copied { stale, path, .. } => {
                assert!(stale, "the canonical skill moved on and the copy did not");
                assert_eq!(
                    fs::read_to_string(Path::new(path).join("SKILL.md")).unwrap(),
                    "# research",
                    "a stale copy still serves what it captured — that is what makes it stale"
                );
            }
            other => panic!("expected a copy, got {other:?}"),
        }
    }

    #[test]
    fn a_mount_path_the_platform_cannot_hold_is_reported_rather_than_attempted() {
        if !cfg!(windows) {
            // The 260-character limit is a Windows fact; elsewhere a single
            // path segment cannot get near the platform's limit.
            return;
        }
        let fixture = fixture();
        let long = "s".repeat(250);
        let mounts = fixture.reconcile(&[&long]);
        assert_eq!(
            mounts[0].status,
            SkillMountStatus::Unavailable {
                problem: SkillMountProblem::PathTooLong
            }
        );
    }

    #[test]
    fn the_wire_shape_is_what_the_renderer_switches_on() {
        let fixture = fixture();
        fixture.install("research", "# research");
        let mounts = fixture.reconcile(&["research", "nested/skill"]);

        let json = serde_json::to_value(&mounts).unwrap();
        assert_eq!(json[0]["name"], "research");
        assert!(matches!(
            json[0]["status"]["kind"].as_str(),
            Some("linked") | Some("copied")
        ));
        assert_eq!(json[1]["status"]["kind"], "unavailable");
        assert_eq!(json[1]["status"]["problem"], "nameIsNotASinglePathSegment");
        assert!(json[1]["source"].is_null());
    }
}
