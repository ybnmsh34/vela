//! The skills mount: how a project sees the skills it has enabled.
//!
//! `src/platform/contract-project.ts` puts the mount at `<project root>/skills`
//! — a sibling of the private agent workspace, not a directory inside it — and
//! fills it with one entry per enabled skill pointing back into the machine-wide
//! store. This module is the half that touches the disk.
//!
//! ## The link is a junction on Windows, and never a symlink
//!
//! Creating a symbolic link on Windows needs a privilege ordinary user accounts
//! do not hold; the only ways around it are Developer Mode or running elevated.
//! A design that mounts skills with symlinks therefore works on the developer's
//! machine and fails on the user's, which is the worst available failure
//! distribution. So Vela uses a directory junction, which any unprivileged user
//! can create and which every file API follows transparently. The contract says
//! this is used on Windows **at all times, even when a symlink would succeed**,
//! so that two users of the same build do not get two products.
//!
//! `std::os::windows::fs::symlink_dir` is not called on Windows anywhere in
//! this crate, and `src/platform/skill-mount-parity.test.ts` is what makes that
//! sentence checkable rather than merely written: it reads this file and fails
//! if the Windows branch reaches for one.
//!
//! ## A junction is a reparse point, and a naive delete walks through it
//!
//! The contract calls this the single most destructive way the layout can be
//! got wrong: one recursive delete that descends through a junction takes every
//! skill on the machine rather than one project's view of them.
//! [`remove_mount_entry`] is the guard — it unlinks a reparse point and only
//! recurses into a real directory — and
//! [`removing_a_mounted_skill_leaves_the_canonical_skill_alone`] is the test
//! that has been watched to fail without it.
//!
//! ## What the strategy is, and how it is decided
//!
//! By **attempting the real operation** in a scratch directory and reading the
//! result back, once, rather than by reading a policy key. Developer Mode being
//! on does not guarantee the process token carries the privilege, and a
//! registry read that disagrees with the filesystem is a guess dressed as a
//! fact — the lesson `src-tauri/crates/vela-privatefs/src/lib.rs` was
//! written to record.
//!
//! **One honest limitation.** [`LinkFallbackReason::FilesystemDoesNotSupportLinks`]
//! is the contract's name for an application-data directory on a FAT or exFAT
//! volume, and this implementation never reports it on Windows: a failed
//! junction attempt is reported [`LinkFallbackReason::JunctionRefused`],
//! because telling those two apart needs a volume query this code does not
//! make. The fallback behaviour is identical either way — copy — so the cost is
//! the precision of one sentence in a UI, and the alternative was to guess
//! which reason to print.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::document::is_single_path_segment;
use crate::enablement::{fold, CaseFolding};
use crate::store::SkillStore;

/// How a skill directory is made visible inside a project.
///
/// Both members are links: one target, edits to the canonical skill are live
/// everywhere. A copy is not a link and is a different variant of
/// [`SkillMountStatus`] rather than a third member here — see that type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillLinkKind {
    Symlink,
    Junction,
}

/// Why the host fell back to copying instead of linking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkFallbackReason {
    /// The filesystem does not implement directory links at all.
    FilesystemDoesNotSupportLinks,
    /// Windows. A junction was attempted and refused.
    JunctionRefused,
    /// The probe itself could not be run, so the host does not know what this
    /// machine supports and took the option that always works. A statement
    /// about missing knowledge, not about the filesystem.
    ProbeFailed,
}

/// What the host will use to mount skills on this machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LinkStrategy {
    Symlink,
    Junction,
    Copy { reason: LinkFallbackReason },
}

/// Why one skill could not be mounted, when the machine can mount others.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillMountProblem {
    /// Enabled on the project, absent from the canonical store.
    SkillNotFound,
    /// The name is not a single path segment. Rejected **before** it is joined
    /// onto a path.
    NameIsNotASinglePathSegment,
    /// The resulting path exceeded what the platform accepts.
    PathTooLong,
    /// Something already occupies the mount path and is not ours to replace.
    OccupiedByUnrelatedEntry,
    /// An earlier enabled entry already mounted at this path: two names that
    /// are one directory under this volume's casing rules. Distinct from
    /// [`Self::OccupiedByUnrelatedEntry`] because there the occupant is a
    /// stranger and the repair is the user's, here the occupant is this
    /// project's own other skill and the repair is to disable one of the two.
    NameCollidesWithAnotherEnabledSkill,
    PermissionDenied,
}

/// The state of one mounted skill.
///
/// `Copied` is a separate variant rather than a third [`SkillLinkKind`], and
/// that is the whole point of this union: a copy is a **snapshot**. Edit the
/// canonical skill and the project keeps running the old one until something
/// re-copies it. Folding it in beside the link kinds would let every consumer
/// treat all three identically, so the UI must be unable to render a copy
/// without also being handed `copied_at_ms` and `stale`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SkillMountStatus {
    Linked {
        link: SkillLinkKind,
        path: PathBuf,
    },
    Copied {
        path: PathBuf,
        copied_at_ms: u64,
        /// The canonical skill has changed since the copy was taken. Compared
        /// by **content**, not by timestamp: a file synced onto this machine
        /// can arrive with an older modification time than the copy it
        /// invalidates.
        stale: bool,
    },
    Unavailable {
        problem: SkillMountProblem,
    },
}

/// One entry in the skills mount, reported as it actually is.
///
/// There is exactly one of these per **enabled** skill, including the ones that
/// failed: dropping a failure would let a project silently run without a skill
/// the user switched on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMount {
    pub name: String,
    /// `<store root>/<name>`, joined by the host.
    ///
    /// `None` in exactly one case: [`SkillMountProblem::NameIsNotASinglePathSegment`],
    /// where reporting a resolved path would perform the very join the rule
    /// forbids. Every other status carries it, including `SkillNotFound`, so a
    /// UI explaining a missing skill can name where it looked.
    pub source: Option<PathBuf>,
    pub status: SkillMountStatus,
}

/* -------------------------------------------------------------------------- */
/* the strategy probe                                                         */
/* -------------------------------------------------------------------------- */

/// Find out what this machine can actually do, by doing it.
///
/// Creates a scratch directory under `scratch_parent`, attempts one real link
/// inside it, reads the result back, and removes the scratch directory before
/// returning. Intended to be called once per launch with the application-data
/// directory, exactly as the contract describes.
pub fn probe_link_strategy(scratch_parent: &Path) -> LinkStrategy {
    let stamp = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    let scratch = scratch_parent.join(format!(".vela-link-probe-{}-{stamp}", std::process::id()));
    let target = scratch.join("target");
    let link = scratch.join("link");

    if fs::create_dir_all(&target).is_err() {
        return LinkStrategy::Copy {
            reason: LinkFallbackReason::ProbeFailed,
        };
    }

    let outcome = create_link(&link, &target);
    let _ = remove_mount_entry(&link);
    let _ = fs::remove_dir_all(&scratch);

    match outcome {
        Ok(SkillLinkKind::Junction) => LinkStrategy::Junction,
        Ok(SkillLinkKind::Symlink) => LinkStrategy::Symlink,
        Err(_) => LinkStrategy::Copy {
            reason: link_failure_reason(),
        },
    }
}

#[cfg(windows)]
fn link_failure_reason() -> LinkFallbackReason {
    LinkFallbackReason::JunctionRefused
}

#[cfg(not(windows))]
fn link_failure_reason() -> LinkFallbackReason {
    LinkFallbackReason::FilesystemDoesNotSupportLinks
}

/// Create one directory link, and read the result back before believing it.
///
/// On Windows this is a **junction**. There is no Rust standard-library call
/// that makes one — `std::os::windows::fs::symlink_dir` makes a symbolic link,
/// which this design refuses — so the junction is created by the one
/// unprivileged mechanism Windows ships, `mklink /J`, which is a `cmd` builtin
/// rather than an executable and so has to be spawned through `cmd`. The two
/// paths are quoted into the command line, which is safe because every name
/// that reaches here has already been through
/// [`crate::document::is_single_path_segment`], and that refuses the quote
/// character along with every other character Windows will not put in a
/// filename.
///
/// Elsewhere it is a symbolic link, which is unprivileged on POSIX systems.
#[cfg(windows)]
fn create_link(link: &Path, target: &Path) -> io::Result<SkillLinkKind> {
    use std::os::windows::process::CommandExt;

    /// So a mounted skill does not flash a console window at the user.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let status = std::process::Command::new("cmd")
        .raw_arg(format!(
            "/D /C mklink /J \"{}\" \"{}\"",
            link.display(),
            target.display()
        ))
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()?;

    if !status.success() {
        return Err(io::Error::other("the volume refused a directory junction"));
    }
    verify_link(link)?;
    Ok(SkillLinkKind::Junction)
}

#[cfg(not(windows))]
fn create_link(link: &Path, target: &Path) -> io::Result<SkillLinkKind> {
    std::os::unix::fs::symlink(target, link)?;
    verify_link(link)?;
    Ok(SkillLinkKind::Symlink)
}

/// Read back what was just created. A link that reports success and leaves an
/// ordinary directory behind is the failure this project has been bitten by
/// before, and it costs one `stat` to refuse to believe it.
fn verify_link(link: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(link)?;
    if !metadata.file_type().is_symlink() {
        return Err(io::Error::other(
            "the link was reported created and is not a link",
        ));
    }
    Ok(())
}

/* -------------------------------------------------------------------------- */
/* removal — the destructive hazard                                           */
/* -------------------------------------------------------------------------- */

/// Remove one entry from a skills mount without ever walking through it.
///
/// A junction and a symlink are **unlinked**; only a real directory is
/// recursed into. This is the guard the contract asks for on every path that
/// removes anything under a project root, and it is why removing a project's
/// mount cannot take the machine's skills with it.
///
/// A missing entry is success: this is called on the removal path, and the
/// caller wants the entry gone, which it already is.
pub fn remove_mount_entry(path: &Path) -> io::Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };

    if metadata.file_type().is_symlink() {
        // On Windows a directory junction is removed with the directory call,
        // not the file one; on POSIX a symlink is removed with the file call
        // whatever it points at. Trying both in that order is what makes one
        // function correct on both, and neither call follows the link.
        return fs::remove_dir(path).or_else(|_| fs::remove_file(path));
    }
    if metadata.is_dir() {
        return fs::remove_dir_all(path);
    }
    fs::remove_file(path)
}

/* -------------------------------------------------------------------------- */
/* reconcile                                                                  */
/* -------------------------------------------------------------------------- */

/// Bring the mount directory into line with the enabled list, and report what
/// actually happened, one entry per enabled skill in the record's own order.
///
/// What it does, and does not do:
///
///  - Creates the mount directory if it is missing.
///  - Mounts every enabled skill that exists in the store.
///  - Removes entries in the mount directory that are no longer enabled, using
///    [`remove_mount_entry`], so a stale junction is unlinked and never walked.
///  - **Does not refresh a copy that has drifted.** A copy is a snapshot, and
///    swapping the instructions a project runs on, without being asked, at
///    whatever moment a reconcile happens to be triggered, is not a repair. A
///    drifted copy is reported `stale`, and [`refresh_copy`] is the deliberate
///    act that replaces it.
///
/// Errors that belong to one entry become that entry's status. An error that
/// belongs to the whole operation — the mount directory cannot be created, a
/// disk is full — comes back as `Err`, rather than being flattened into a
/// per-entry problem the closed vocabulary has no honest name for.
pub fn reconcile(
    store: &SkillStore,
    mount_dir: &Path,
    enabled: &[String],
    strategy: LinkStrategy,
    folding: CaseFolding,
) -> io::Result<Vec<SkillMount>> {
    fs::create_dir_all(mount_dir)?;

    let mut mounts: Vec<SkillMount> = Vec::with_capacity(enabled.len());
    let mut claimed: Vec<String> = Vec::with_capacity(enabled.len());

    for name in enabled {
        if !is_single_path_segment(name) {
            mounts.push(SkillMount {
                name: name.clone(),
                source: None,
                status: SkillMountStatus::Unavailable {
                    problem: SkillMountProblem::NameIsNotASinglePathSegment,
                },
            });
            continue;
        }

        let source = store.root().join(name);
        let key = fold(name, folding);
        if claimed.contains(&key) {
            // Half 2 of the collision rule: the first entry in record order
            // mounted, and this one says so rather than silently vanishing or
            // fighting the first for the path.
            mounts.push(SkillMount {
                name: name.clone(),
                source: Some(source),
                status: SkillMountStatus::Unavailable {
                    problem: SkillMountProblem::NameCollidesWithAnotherEnabledSkill,
                },
            });
            continue;
        }
        claimed.push(key);

        if !source.is_dir() {
            mounts.push(SkillMount {
                name: name.clone(),
                source: Some(source),
                status: SkillMountStatus::Unavailable {
                    problem: SkillMountProblem::SkillNotFound,
                },
            });
            continue;
        }

        let status = mount_one(&source, &mount_dir.join(name), strategy)?;
        mounts.push(SkillMount {
            name: name.clone(),
            source: Some(source),
            status,
        });
    }

    sweep(mount_dir, &mounts, folding)?;
    Ok(mounts)
}

/// Replace one copied mount with a fresh copy of the canonical skill.
///
/// The deliberate act [`reconcile`] refuses to perform on its own. Only
/// meaningful under a copy strategy; a linked mount is already live and has
/// nothing to refresh.
pub fn refresh_copy(store: &SkillStore, mount_dir: &Path, name: &str) -> io::Result<SkillMount> {
    let source = store
        .directory_of(name)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "not a single path segment"))?;
    let path = mount_dir.join(name);
    remove_mount_entry(&path)?;
    copy_tree(&source, &path)?;
    Ok(SkillMount {
        name: name.to_owned(),
        source: Some(source),
        status: SkillMountStatus::Copied {
            copied_at_ms: modified_at_ms(&path),
            path,
            stale: false,
        },
    })
}

fn mount_one(
    source: &Path,
    link_path: &Path,
    strategy: LinkStrategy,
) -> io::Result<SkillMountStatus> {
    let existing = match fs::symlink_metadata(link_path) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return recognised(error),
    };

    match strategy {
        LinkStrategy::Symlink | LinkStrategy::Junction => {
            let kind = match strategy {
                LinkStrategy::Junction => SkillLinkKind::Junction,
                _ => SkillLinkKind::Symlink,
            };
            if let Some(metadata) = existing {
                if !metadata.file_type().is_symlink() {
                    // Under a link strategy nothing we made is a plain
                    // directory, so whatever is here is not ours to replace.
                    return Ok(SkillMountStatus::Unavailable {
                        problem: SkillMountProblem::OccupiedByUnrelatedEntry,
                    });
                }
                if links_to(link_path, source) {
                    return Ok(SkillMountStatus::Linked {
                        link: kind,
                        path: link_path.to_path_buf(),
                    });
                }
                remove_mount_entry(link_path)?;
            }
            match create_link(link_path, source) {
                Ok(link) => Ok(SkillMountStatus::Linked {
                    link,
                    path: link_path.to_path_buf(),
                }),
                Err(error) => recognised(error),
            }
        }
        LinkStrategy::Copy { .. } => {
            if let Some(metadata) = existing {
                if metadata.file_type().is_symlink() {
                    // A link left over from a machine that could make one, read
                    // on a machine that cannot. Ours, and replaceable.
                    remove_mount_entry(link_path)?;
                } else if metadata.is_dir() {
                    // Under a copy strategy a plain directory at the mount path
                    // is a copy we made. That is an assumption, and it is the
                    // one this design can defend: the mount directory is
                    // host-owned, created by project creation and removed by
                    // project deletion, so a directory in it came from here.
                    // Nothing on disk distinguishes it from a stranger's
                    // directory, and inventing a marker file would put Vela's
                    // bookkeeping inside a tree the sandbox mounts read-only.
                    return Ok(SkillMountStatus::Copied {
                        path: link_path.to_path_buf(),
                        copied_at_ms: modified_at_ms(link_path),
                        stale: trees_differ(source, link_path)?,
                    });
                } else {
                    return Ok(SkillMountStatus::Unavailable {
                        problem: SkillMountProblem::OccupiedByUnrelatedEntry,
                    });
                }
            }
            match copy_tree(source, link_path) {
                Ok(()) => Ok(SkillMountStatus::Copied {
                    path: link_path.to_path_buf(),
                    copied_at_ms: modified_at_ms(link_path),
                    stale: false,
                }),
                Err(error) => recognised(error),
            }
        }
    }
}

/// Turn an error this vocabulary has a name for into a status, and one it does
/// not into a failure of the whole operation.
///
/// The closed set from the contract is `pathTooLong`, `permissionDenied`,
/// `occupiedByUnrelatedEntry`, `skillNotFound`, `nameCollidesWithAnotherEnabledSkill`
/// and `nameIsNotASinglePathSegment`. A full disk is none of those, and
/// labelling it `permissionDenied` because that is the nearest member would put
/// a sentence in front of the user that sends them to check permissions they
/// have.
fn recognised(error: io::Error) -> io::Result<SkillMountStatus> {
    if error.kind() == io::ErrorKind::PermissionDenied {
        return Ok(SkillMountStatus::Unavailable {
            problem: SkillMountProblem::PermissionDenied,
        });
    }
    // ERROR_FILENAME_EXCED_RANGE. The classic Windows limit is 260 characters
    // unless long paths are enabled *and* the call opts in, and a project root
    // is already deep before a skill name is appended to it.
    if error.raw_os_error() == Some(206) {
        return Ok(SkillMountStatus::Unavailable {
            problem: SkillMountProblem::PathTooLong,
        });
    }
    Err(error)
}

/// Whether the link at `link_path` already resolves to `source`.
///
/// Compared by canonical path rather than by the link's stored target, because
/// a junction's stored target carries a device prefix that the source path does
/// not, and comparing the two strings would call every correct mount wrong.
fn links_to(link_path: &Path, source: &Path) -> bool {
    match (fs::canonicalize(link_path), fs::canonicalize(source)) {
        (Ok(resolved), Ok(expected)) => resolved == expected,
        _ => false,
    }
}

/// Remove everything in the mount directory that no enabled skill mounted.
///
/// Uses [`remove_mount_entry`], so a junction is unlinked rather than walked.
///
/// Two things survive the sweep. A skill that mounted, obviously; and the one
/// that reported [`SkillMountProblem::OccupiedByUnrelatedEntry`], which is the
/// entry this reconcile just decided was **not ours to replace** — sweeping it
/// would be the same claim of ownership made by a different function ten lines
/// later. Everything else goes: the mount directory is host-owned, created with
/// the project and removed with it, so a directory in it that nothing enables
/// is a leftover.
fn sweep(mount_dir: &Path, mounts: &[SkillMount], folding: CaseFolding) -> io::Result<()> {
    let kept: Vec<String> = mounts
        .iter()
        .filter(|mount| {
            !matches!(
                mount.status,
                SkillMountStatus::Unavailable {
                    problem: SkillMountProblem::SkillNotFound
                        | SkillMountProblem::NameIsNotASinglePathSegment
                        | SkillMountProblem::PathTooLong
                        | SkillMountProblem::PermissionDenied
                }
            )
        })
        .map(|mount| fold(&mount.name, folding))
        .collect();

    for entry in fs::read_dir(mount_dir)? {
        let entry = entry?;
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if kept.contains(&fold(&name, folding)) {
            continue;
        }
        remove_mount_entry(&entry.path())?;
    }
    Ok(())
}

/// Copy a skill directory, without following anything that leaves it.
///
/// A link inside a skill is skipped rather than resolved. Following one would
/// let a skill copy an arbitrary tree — the user's home directory, say — into a
/// project's mount, which is the sandbox's whole concern arriving through the
/// back door.
fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let destination = to.join(entry.file_name());
        if file_type.is_dir() {
            copy_tree(&entry.path(), &destination)?;
        } else {
            fs::copy(entry.path(), &destination)?;
        }
    }
    Ok(())
}

/// Whether a copy has drifted from the skill it was taken from.
///
/// By content: every relative path and every byte. Timestamps are not consulted
/// because a file synced onto this machine can arrive older than the copy it
/// invalidates. Skills are instruction text and small reference files, so the
/// comparison is cheap; a skill carrying a large binary asset pays for it here.
fn trees_differ(source: &Path, copy: &Path) -> io::Result<bool> {
    Ok(fingerprint(source, source)? != fingerprint(copy, copy)?)
}

fn fingerprint(root: &Path, directory: &Path) -> io::Result<Vec<(String, Vec<u8>)>> {
    let mut found: Vec<(String, Vec<u8>)> = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            found.extend(fingerprint(root, &entry.path())?);
        } else {
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            found.push((relative, fs::read(&path)?));
        }
    }
    found.sort();
    Ok(found)
}

fn modified_at_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::SKILL_STORE_DIRECTORY_NAME;

    struct Fixture {
        #[allow(dead_code)]
        _root: tempfile::TempDir,
        store: SkillStore,
        mount: PathBuf,
    }

    fn fixture(skills: &[&str]) -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let store = SkillStore::under_data_dir(root.path());
        store.ensure_root().unwrap();
        for name in skills {
            let directory = store.root().join(name);
            fs::create_dir_all(&directory).unwrap();
            fs::write(
                directory.join(crate::document::SKILL_FILE_NAME),
                format!("---\nname: {name}\ndescription: Does {name}.\n---\n\nBody of {name}.\n"),
            )
            .unwrap();
        }
        let mount = root.path().join("projects").join("p1").join("skills");
        Fixture {
            _root: root,
            store,
            mount,
        }
    }

    fn names(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    /// What this machine can really do. Every test that asserts a *link* runs
    /// under this, so the suite is honest on a volume that cannot link instead
    /// of failing there.
    fn live_strategy(fixture: &Fixture) -> LinkStrategy {
        probe_link_strategy(fixture.store.root().parent().unwrap())
    }

    #[test]
    fn a_skill_really_mounts_into_a_real_project_directory() {
        let fixture = fixture(&["alpha", "beta"]);
        let strategy = live_strategy(&fixture);

        let mounts = reconcile(
            &fixture.store,
            &fixture.mount,
            &names(&["alpha"]),
            strategy,
            CaseFolding::Insensitive,
        )
        .unwrap();

        assert_eq!(mounts.len(), 1);
        assert_eq!(mounts[0].name, "alpha");
        assert_eq!(mounts[0].source, Some(fixture.store.root().join("alpha")));

        // The mount is reachable as a directory, whichever way it was made, and
        // the skill's own file is readable through it. That is the property the
        // whole design exists for.
        let through_the_mount = fixture.mount.join("alpha").join("SKILL.md");
        assert!(through_the_mount.is_file(), "{mounts:?}");
        assert!(fs::read_to_string(&through_the_mount)
            .unwrap()
            .contains("name: alpha"));

        match (&strategy, &mounts[0].status) {
            (LinkStrategy::Junction, SkillMountStatus::Linked { link, .. }) => {
                assert_eq!(*link, SkillLinkKind::Junction);
            }
            (LinkStrategy::Symlink, SkillMountStatus::Linked { link, .. }) => {
                assert_eq!(*link, SkillLinkKind::Symlink);
            }
            (LinkStrategy::Copy { .. }, SkillMountStatus::Copied { stale, .. }) => {
                assert!(!stale);
            }
            other => panic!("strategy and status disagree: {other:?}"),
        }
    }

    #[test]
    fn on_windows_the_link_is_a_junction_and_never_a_symlink() {
        // The contract's flat rule: no symbolic links on Windows, ever, even
        // where one would succeed. The probe is the only decision point, so
        // this asserts what the probe answers on the platform Vela ships to.
        let fixture = fixture(&["alpha"]);
        let strategy = live_strategy(&fixture);
        assert!(
            !matches!(strategy, LinkStrategy::Symlink) || !cfg!(windows),
            "a symlink strategy was chosen on Windows"
        );
        #[cfg(windows)]
        assert_eq!(strategy, LinkStrategy::Junction);
    }

    #[test]
    fn removing_a_mounted_skill_leaves_the_canonical_skill_alone() {
        // The single most destructive way this layout can be got wrong: a
        // recursive delete that walks through a reparse point takes every skill
        // on the machine. Skipped where the machine cannot link, because there
        // is then no reparse point to walk through.
        let fixture = fixture(&["alpha"]);
        let strategy = live_strategy(&fixture);
        if matches!(strategy, LinkStrategy::Copy { .. }) {
            return;
        }

        reconcile(
            &fixture.store,
            &fixture.mount,
            &names(&["alpha"]),
            strategy,
            CaseFolding::Insensitive,
        )
        .unwrap();

        let canonical = fixture.store.root().join("alpha").join("SKILL.md");
        assert!(canonical.is_file());

        remove_mount_entry(&fixture.mount.join("alpha")).unwrap();

        assert!(!fixture.mount.join("alpha").exists(), "the mount survived");
        assert!(
            canonical.is_file(),
            "the delete walked through the link and took the canonical skill"
        );
    }

    #[test]
    fn disabling_a_skill_sweeps_its_mount_and_not_the_store() {
        let fixture = fixture(&["alpha", "beta"]);
        let strategy = live_strategy(&fixture);

        reconcile(
            &fixture.store,
            &fixture.mount,
            &names(&["alpha", "beta"]),
            strategy,
            CaseFolding::Insensitive,
        )
        .unwrap();
        assert!(fixture.mount.join("beta").exists());

        reconcile(
            &fixture.store,
            &fixture.mount,
            &names(&["alpha"]),
            strategy,
            CaseFolding::Insensitive,
        )
        .unwrap();

        assert!(!fixture.mount.join("beta").exists());
        assert!(fixture.mount.join("alpha").exists());
        assert!(fixture.store.root().join("beta").join("SKILL.md").is_file());
    }

    #[test]
    fn a_second_name_that_is_the_same_directory_is_reported_not_dropped() {
        let fixture = fixture(&["alpha"]);
        let strategy = live_strategy(&fixture);

        let mounts = reconcile(
            &fixture.store,
            &fixture.mount,
            &names(&["alpha", "Alpha"]),
            strategy,
            CaseFolding::Insensitive,
        )
        .unwrap();

        assert_eq!(mounts.len(), 2, "one entry per enabled skill, always");
        assert!(matches!(
            mounts[0].status,
            SkillMountStatus::Linked { .. } | SkillMountStatus::Copied { .. }
        ));
        assert_eq!(
            mounts[1].status,
            SkillMountStatus::Unavailable {
                problem: SkillMountProblem::NameCollidesWithAnotherEnabledSkill
            }
        );
        assert_eq!(
            mounts[1].source,
            Some(fixture.store.root().join("Alpha")),
            "a collision still says where it looked"
        );
    }

    #[test]
    fn an_enabled_skill_the_store_does_not_have_is_unavailable_and_still_listed() {
        let fixture = fixture(&[]);
        let strategy = live_strategy(&fixture);

        let mounts = reconcile(
            &fixture.store,
            &fixture.mount,
            &names(&["missing"]),
            strategy,
            CaseFolding::Insensitive,
        )
        .unwrap();

        assert_eq!(
            mounts[0].status,
            SkillMountStatus::Unavailable {
                problem: SkillMountProblem::SkillNotFound
            }
        );
        assert_eq!(mounts[0].source, Some(fixture.store.root().join("missing")));
    }

    #[test]
    fn a_traversal_name_is_refused_with_no_path_to_show_for_it() {
        let fixture = fixture(&["alpha"]);
        let strategy = live_strategy(&fixture);

        let mounts = reconcile(
            &fixture.store,
            &fixture.mount,
            &names(&["../alpha"]),
            strategy,
            CaseFolding::Insensitive,
        )
        .unwrap();

        assert_eq!(
            mounts[0].status,
            SkillMountStatus::Unavailable {
                problem: SkillMountProblem::NameIsNotASinglePathSegment
            }
        );
        assert_eq!(
            mounts[0].source, None,
            "reporting a resolved path would perform the join the rule forbids"
        );
        assert!(!fixture.mount.join("..").join("alpha").exists());
    }

    #[test]
    fn a_stranger_at_the_mount_path_is_not_replaced() {
        let fixture = fixture(&["alpha"]);
        let strategy = live_strategy(&fixture);
        if matches!(strategy, LinkStrategy::Copy { .. }) {
            // Under a copy strategy a plain directory is by construction one of
            // ours; the distinction this test is about does not exist there.
            return;
        }

        fs::create_dir_all(fixture.mount.join("alpha")).unwrap();
        fs::write(fixture.mount.join("alpha").join("theirs.txt"), "mine").unwrap();

        let mounts = reconcile(
            &fixture.store,
            &fixture.mount,
            &names(&["alpha"]),
            strategy,
            CaseFolding::Insensitive,
        )
        .unwrap();

        assert_eq!(
            mounts[0].status,
            SkillMountStatus::Unavailable {
                problem: SkillMountProblem::OccupiedByUnrelatedEntry
            }
        );
        assert!(fixture.mount.join("alpha").join("theirs.txt").is_file());
    }

    #[test]
    fn a_copy_that_has_drifted_is_reported_stale_and_refreshed_only_on_request() {
        let fixture = fixture(&["alpha"]);
        let strategy = LinkStrategy::Copy {
            reason: LinkFallbackReason::ProbeFailed,
        };
        let enabled = names(&["alpha"]);

        let mounts = reconcile(
            &fixture.store,
            &fixture.mount,
            &enabled,
            strategy,
            CaseFolding::Insensitive,
        )
        .unwrap();
        assert!(matches!(
            mounts[0].status,
            SkillMountStatus::Copied { stale: false, .. }
        ));

        // Edit the canonical skill. A copy is a snapshot, so the project keeps
        // running the old one — and must say so.
        let canonical = fixture.store.root().join("alpha").join("SKILL.md");
        fs::write(
            &canonical,
            "---\nname: alpha\ndescription: Does alpha, differently.\n---\n\nNew body.\n",
        )
        .unwrap();

        let mounts = reconcile(
            &fixture.store,
            &fixture.mount,
            &enabled,
            strategy,
            CaseFolding::Insensitive,
        )
        .unwrap();
        assert!(
            matches!(
                mounts[0].status,
                SkillMountStatus::Copied { stale: true, .. }
            ),
            "{:?}",
            mounts[0].status
        );
        assert!(
            !fs::read_to_string(fixture.mount.join("alpha").join("SKILL.md"))
                .unwrap()
                .contains("New body"),
            "reconcile silently swapped the instructions the project runs on"
        );

        let refreshed = refresh_copy(&fixture.store, &fixture.mount, "alpha").unwrap();
        assert!(matches!(
            refreshed.status,
            SkillMountStatus::Copied { stale: false, .. }
        ));
        assert!(
            fs::read_to_string(fixture.mount.join("alpha").join("SKILL.md"))
                .unwrap()
                .contains("New body")
        );
    }

    #[test]
    fn a_copy_does_not_follow_a_link_out_of_the_skill() {
        let fixture = fixture(&["alpha"]);
        let strategy = live_strategy(&fixture);
        if !matches!(strategy, LinkStrategy::Junction | LinkStrategy::Symlink) {
            return;
        }

        // A skill that links at somebody else's tree. Copying must not bring it
        // along: that would be an arbitrary directory arriving inside a mount
        // the sandbox exposes to model-authored code.
        let elsewhere = fixture.store.root().parent().unwrap().join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::write(elsewhere.join("private.txt"), "not yours").unwrap();
        create_link(&fixture.store.root().join("alpha").join("out"), &elsewhere).unwrap();

        let mounts = reconcile(
            &fixture.store,
            &fixture.mount,
            &names(&["alpha"]),
            LinkStrategy::Copy {
                reason: LinkFallbackReason::ProbeFailed,
            },
            CaseFolding::Insensitive,
        )
        .unwrap();

        assert!(matches!(mounts[0].status, SkillMountStatus::Copied { .. }));
        assert!(!fixture.mount.join("alpha").join("out").exists());
        assert!(elsewhere.join("private.txt").is_file());
    }

    #[test]
    fn the_store_directory_name_is_the_one_the_contract_names() {
        assert_eq!(SKILL_STORE_DIRECTORY_NAME, "skills");
    }
}
