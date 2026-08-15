//! How a skill directory is made visible inside a project, and how anything the
//! host owns is removed without walking through a link.

use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// How a skill directory is made visible inside a project.
///
/// `Symlink` and `Junction` are both links: one target, edits to the canonical
/// skill are live everywhere. A copy is not a link and is deliberately not a
/// member here — see [`crate::SkillMountStatus`], which keeps it a separate
/// variant so no consumer can render a snapshot as though it were live.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillLinkKind {
    Symlink,
    Junction,
}

/// Why the host fell back to copying instead of linking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkFallbackReason {
    /// The filesystem under the application-data directory does not implement
    /// directory links at all: FAT or exFAT on any platform, some container
    /// overlays, some network filesystems. Reparse points are an NTFS feature,
    /// so a `%APPDATA%` on exFAT belongs here and not in `JunctionRefused`.
    FilesystemDoesNotSupportLinks,
    /// Windows. A junction was attempted and refused — realistically a
    /// redirected application-data directory, since junctions cannot target a
    /// remote volume.
    JunctionRefused,
    /// The probe itself could not be run, so the host does not know what this
    /// machine supports and took the option that always works. A statement about
    /// missing knowledge, not about the filesystem.
    ProbeFailed,
}

/// What the host will use to mount skills on this machine.
///
/// **There is no "symlinks are available" flag and nothing may act on one.**
/// Creating a symbolic link on Windows needs `SeCreateSymbolicLinkPrivilege`,
/// which ordinary accounts do not hold; the only routes around it are Developer
/// Mode or elevation, and both make two users of the same build get different
/// products. So [`probe_link_strategy`] never attempts a symlink on Windows,
/// even on a machine where one would succeed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LinkStrategy {
    Symlink,
    Junction,
    Copy { reason: LinkFallbackReason },
}

impl LinkStrategy {
    pub fn link_kind(self) -> Option<SkillLinkKind> {
        match self {
            Self::Symlink => Some(SkillLinkKind::Symlink),
            Self::Junction => Some(SkillLinkKind::Junction),
            Self::Copy { .. } => None,
        }
    }
}

/// Establishes what this machine can do by **attempting the real operation** in
/// a scratch directory under `app_data_dir`, then removing it.
///
/// Not by reading a policy key: Developer Mode being on does not guarantee the
/// process token carries the privilege, and a registry read that disagrees with
/// the filesystem is a guess dressed as a fact. That is the lesson
/// `src-tauri/crates/vela-providers/src/private_fs.rs` was written to record —
/// its Windows branch assumed and the desktop gate measured something else.
///
/// Called once per launch. Cheap (one directory create, one link, two removals)
/// but it does touch the disk, so it is not something to run per project.
pub fn probe_link_strategy(app_data_dir: &Path) -> LinkStrategy {
    let scratch = app_data_dir.join(".link-probe");
    // A leftover from a probe that was killed mid-flight would make every later
    // probe report `JunctionRefused` for a machine that is perfectly capable.
    let _ = remove_tree(&scratch);

    let target = scratch.join("target");
    let link = scratch.join("link");
    if fs::create_dir_all(&target).is_err() {
        return LinkStrategy::Copy {
            reason: LinkFallbackReason::ProbeFailed,
        };
    }

    let outcome = create_link(&link, &target);
    // Read the result back rather than trusting the call's own success: a
    // filesystem that silently degrades a link to a directory would otherwise
    // report `Junction` and then serve stale skills forever.
    let established = outcome.is_ok() && is_reparse_point(&link).unwrap_or(false);
    let _ = remove_tree(&scratch);

    if established {
        return NATIVE_LINK_STRATEGY;
    }
    LinkStrategy::Copy {
        reason: match outcome {
            // A refusal the OS reported is a refusal of *this* operation. On
            // Windows the operation was a junction, so it is `JunctionRefused`;
            // elsewhere the only link this crate attempts is a symlink and a
            // filesystem that refuses one does not implement links at all.
            Err(_) if cfg!(windows) => LinkFallbackReason::JunctionRefused,
            Err(_) => LinkFallbackReason::FilesystemDoesNotSupportLinks,
            // The call claimed success and the reparse-point read disagreed, so
            // the host does not actually know what this machine does.
            Ok(()) => LinkFallbackReason::ProbeFailed,
        },
    }
}

/// The one link kind this platform is allowed to use. A constant rather than a
/// branch inside [`probe_link_strategy`] so that "Windows never uses a symlink"
/// is a single readable fact rather than a condition someone can widen.
#[cfg(windows)]
const NATIVE_LINK_STRATEGY: LinkStrategy = LinkStrategy::Junction;
#[cfg(not(windows))]
const NATIVE_LINK_STRATEGY: LinkStrategy = LinkStrategy::Symlink;

/// Creates a directory link at `link` pointing at `target`.
///
/// Windows gets a junction and never a symlink. Everywhere else gets a symlink,
/// which is unprivileged there.
pub fn create_link(link: &Path, target: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        windows_junction::create(link, target)
    }
    #[cfg(not(windows))]
    {
        std::os::unix::fs::symlink(target, link)
    }
}

/// Whether `path` is a reparse point — a junction or a symlink on Windows, a
/// symlink anywhere else.
///
/// **This is the guard that stands between a project delete and every skill on
/// the machine.** `remove_tree` asks it before descending, so a version of this
/// that answers `false` turns one project's removal into the removal of the
/// canonical skill store.
pub fn is_reparse_point(path: &Path) -> io::Result<bool> {
    let metadata = fs::symlink_metadata(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        /// `FILE_ATTRIBUTE_REPARSE_POINT`. A junction carries it alongside
        /// `FILE_ATTRIBUTE_DIRECTORY`, which is why the directory bit alone
        /// cannot be used to decide whether descending is safe.
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        Ok(metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
    }
    #[cfg(not(windows))]
    {
        Ok(metadata.file_type().is_symlink())
    }
}

/// Removes a file, a directory tree, or a link, **never walking through a
/// reparse point**.
///
/// A missing path is success: removal is idempotent, and a caller that has to
/// check first has a race.
pub fn remove_tree(path: &Path) -> io::Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };

    if is_reparse_point(path)? {
        // Unlink, never descend. A junction into the canonical skill store is
        // removed with `std::fs::remove_dir`, which detaches the link and leaves the
        // target untouched; a file symlink needs `std::fs::remove_file`. Trying the
        // directory form first covers both without asking the metadata which
        // one it is, because a Windows junction reports `is_dir() == false`
        // through `std::fs::symlink_metadata`.
        return fs::remove_dir(path).or_else(|_| fs::remove_file(path));
    }

    if metadata.is_dir() {
        for entry in fs::read_dir(path)? {
            remove_tree(&entry?.path())?;
        }
        return fs::remove_dir(path);
    }
    fs::remove_file(path)
}

/// What the volume says is at a path.
///
/// Four members and not two, because the two failure shapes call for opposite
/// actions and collapsing them into one `Err` is what let a real hole hide. See
/// [`occupant_of`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MountOccupant {
    /// Nothing is there.
    Free,
    /// Something is there, and this is the name the volume stored it under —
    /// which is not necessarily the name that was asked for.
    Named(String),
    /// **Something is there and the volume would not say what it is called.**
    ///
    /// The dangerous answer, and the reason this is a member rather than an
    /// error. A caller that goes on to remove-and-recreate can succeed here:
    /// the entry is real and removable, and only the *question* was refused. So
    /// a caller that would have been told `Named(<some earlier name>)` and
    /// stopped instead proceeds and destroys it.
    ///
    /// Reachable on Windows through an ACL on the parent directory that grants
    /// traverse but withholds `FILE_LIST_DIRECTORY`: opening the child answers,
    /// enumerating it does not.
    PresentButUnnamed,
    /// The volume would not say whether anything is there at all.
    ///
    /// Safe to walk into, and that is the difference from
    /// [`MountOccupant::PresentButUnnamed`]: whatever refused *this* question
    /// refuses the removal that follows too, so nothing is destroyed by trying
    /// and the caller gets to report the real error rather than a guess.
    Indeterminate,
}

/// The name this volume **actually stored** for `path`, or `None` when nothing
/// is there.
///
/// **This is the filesystem answering the question [`crate::CaseFolding::folds`]
/// can only approximate.** `folds` compares in memory against Unicode's simple
/// lowercase; this asks the directory. On a volume that holds `Foo` and `foo` as
/// one entry, asking for `<root>/foo` answers `Foo` — the name the directory
/// really carries — so a caller can tell "this path is free" from "this path is
/// already some other name's entry". No case table of this crate's is consulted
/// anywhere in the answer, which is the whole point: the caller compares the
/// result byte for byte.
///
/// The reparse point is **not followed**: a junction answers with its own name,
/// not with the name of what it points at. `std::fs::canonicalize` would answer
/// with the target and is the wrong tool here for that reason.
///
/// **Neither failure is reported as an error**, and that is the point of the
/// four-member answer. "The volume would not say whether anything is there" and
/// "something is there and the volume would not name it" are one `Err` and two
/// opposite instructions to a caller: the first is safe to walk into and the
/// second is not. A caller handed one `Err` for both either treats every
/// refusal as a collision, which turns an odd ACL into a project whose skills
/// all refuse to mount, or treats none as one, which is a silent overwrite.
pub fn occupant_of(path: &Path) -> MountOccupant {
    // Asked first for three reasons: a free path is the common case and this
    // answers it in one call; it separates the two failure shapes, because
    // reaching the naming step at all means something is there; and it is what
    // keeps a wildcard out of the enumeration below — `*` and `?` cannot appear
    // in a stored name, and this call refuses them rather than matching
    // something else.
    match fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return MountOccupant::Free,
        Err(_) => return MountOccupant::Indeterminate,
    }

    let named = {
        #[cfg(windows)]
        {
            windows_junction::stored_name(path)
        }
        #[cfg(not(windows))]
        {
            stored_name_by_inode(path)
        }
    };
    match named {
        Ok(name) => MountOccupant::Named(name),
        Err(_) => MountOccupant::PresentButUnnamed,
    }
}

/// The volume's short-name alias for `path` — `RESEAR~1` for a long name — or
/// `None` where it makes none.
///
/// Crate-visible test scaffolding and not exported: it exists so a test can get
/// hold of a **real** pair of names that this volume treats as one entry and
/// that [`crate::CaseFolding::folds`] treats as two, without inventing one and
/// without forcing an argument. Always `None` off Windows, and `None` on a
/// Windows volume with 8.3 generation switched off — which is why every use of
/// it asks rather than assumes.
#[cfg(test)]
pub(crate) fn short_name_alias(path: &Path) -> Option<String> {
    #[cfg(windows)]
    {
        windows_junction::short_name(path)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        None
    }
}

/// Off Windows the directory is read and the entry with `path`'s inode is the
/// answer.
///
/// `readdir` yields stored names and inode identity is identity, so this is
/// exact on a case-insensitive APFS volume exactly as it is on ext4. Directory
/// entries are compared without following a symlink, for the reason
/// [`occupant_of`] gives.
#[cfg(not(windows))]
fn stored_name_by_inode(path: &Path) -> io::Result<String> {
    use std::os::unix::fs::MetadataExt;

    let wanted = fs::symlink_metadata(path)?;
    let asked = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let parent = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    for entry in fs::read_dir(parent)? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        if metadata.dev() == wanted.dev() && metadata.ino() == wanted.ino() {
            return Ok(entry.file_name().to_string_lossy().into_owned());
        }
    }
    // Something is at the path and the directory does not list it: a race with a
    // removal, or a filesystem that hides it. Naming an occupant here would be a
    // guess, so answer with the name as asked and let the operation that follows
    // report what actually happens.
    Ok(asked)
}

/// Whether this process may create entries in `directory`, **without creating
/// one**.
///
/// The obvious implementation — write a probe file and delete it — is not
/// available here. This is asked of the user's own working directory, and
/// `src/platform/contract-project.ts` is explicit that nothing in the project
/// machinery writes a byte inside that directory. So Windows gets an access
/// check instead: opening the directory handle with `FILE_ADD_FILE` runs the
/// ACL evaluation the create would have run and creates nothing.
///
/// Off Windows this reads the mode bits, which is what `PermissionsExt` exposes
/// and is honest for the owner case without an `access(2)` binding.
pub fn directory_is_writable(directory: &Path) -> bool {
    #[cfg(windows)]
    {
        windows_junction::can_add_files(directory)
    }
    #[cfg(not(windows))]
    {
        match fs::metadata(directory) {
            Ok(metadata) => !metadata.permissions().readonly(),
            Err(_) => false,
        }
    }
}

/// Copies a directory tree. Used only when [`LinkStrategy::Copy`] is in force.
///
/// Refuses to descend a reparse point for the same reason `remove_tree` does:
/// following one would copy an unbounded amount of somebody else's disk into a
/// project root.
pub fn copy_tree(source: &Path, destination: &Path) -> io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let from = entry.path();
        let to = destination.join(entry.file_name());
        if is_reparse_point(&from)? {
            continue;
        }
        if entry.file_type()?.is_dir() {
            copy_tree(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Whether two directory trees hold the same relative paths with the same
/// bytes.
///
/// **By content, not by timestamp**, because a file synced onto this machine can
/// arrive with an older modification time than the copy it invalidates. That is
/// the whole reason `SkillMountStatus::Copied` carries a `stale` flag rather
/// than leaving a consumer to compare two `mtime`s.
pub fn trees_have_same_content(left: &Path, right: &Path) -> io::Result<bool> {
    let mut left_names = Vec::new();
    for entry in fs::read_dir(left)? {
        let entry = entry?;
        if is_reparse_point(&entry.path())? {
            continue;
        }
        left_names.push(entry.file_name());
    }
    let mut right_names = Vec::new();
    for entry in fs::read_dir(right)? {
        let entry = entry?;
        if is_reparse_point(&entry.path())? {
            continue;
        }
        right_names.push(entry.file_name());
    }
    left_names.sort();
    right_names.sort();
    if left_names != right_names {
        return Ok(false);
    }

    for name in left_names {
        let from = left.join(&name);
        let to = right.join(&name);
        let from_dir = fs::metadata(&from)?.is_dir();
        let to_dir = fs::metadata(&to)?.is_dir();
        if from_dir != to_dir {
            return Ok(false);
        }
        let same = if from_dir {
            trees_have_same_content(&from, &to)?
        } else {
            fs::read(&from)? == fs::read(&to)?
        };
        if !same {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Directory junctions, by hand.
///
/// `std::os::windows::fs::junction_point` is still unstable, and the two
/// alternatives are worse: `std::os::windows::fs::symlink_dir` needs a privilege the user does not
/// have, and shelling out to `mklink /J` hands a path to `cmd.exe`'s quoting
/// rules. So the reparse point is written directly, which is what the standard
/// library does too.
#[cfg(windows)]
mod windows_junction {
    use std::ffi::{c_void, OsStr};
    use std::io;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    const GENERIC_WRITE: u32 = 0x4000_0000;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_SHARE_DELETE: u32 = 0x0000_0004;
    const OPEN_EXISTING: u32 = 3;
    /// Required to open a *directory* handle at all.
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    /// Opens the link itself rather than what it points at — mandatory here,
    /// since the point is to write the link's own reparse data.
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;
    const FSCTL_SET_REPARSE_POINT: u32 = 0x0009_00A4;
    const INVALID_HANDLE_VALUE: isize = -1;
    /// `REPARSE_DATA_BUFFER` up to and including `PrintNameLength`: the tag, the
    /// data length, the reserved word, and the four offset/length words.
    const HEADER_BYTES: usize = 16;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateFileW(
            lp_file_name: *const u16,
            dw_desired_access: u32,
            dw_share_mode: u32,
            lp_security_attributes: *mut c_void,
            dw_creation_disposition: u32,
            dw_flags_and_attributes: u32,
            h_template_file: isize,
        ) -> isize;
        fn DeviceIoControl(
            h_device: isize,
            dw_io_control_code: u32,
            lp_in_buffer: *const c_void,
            n_in_buffer_size: u32,
            lp_out_buffer: *mut c_void,
            n_out_buffer_size: u32,
            lp_bytes_returned: *mut u32,
            lp_overlapped: *mut c_void,
        ) -> i32;
        fn CloseHandle(h_object: isize) -> i32;
        fn FindFirstFileW(lp_file_name: *const u16, lp_find_file_data: *mut FindDataW) -> isize;
        fn FindClose(h_find_file: isize) -> i32;
    }

    /// `WIN32_FIND_DATAW`.
    ///
    /// Declared in full even though one field is read: the OS writes the whole
    /// structure, so a truncated version would be a buffer overrun. Every field
    /// is an integer or an array of them, which is what makes an all-zero value
    /// a valid one.
    #[repr(C)]
    #[allow(dead_code)]
    struct FindDataW {
        attributes: u32,
        creation_time: [u32; 2],
        last_access_time: [u32; 2],
        last_write_time: [u32; 2],
        size_high: u32,
        size_low: u32,
        reserved0: u32,
        reserved1: u32,
        /// `cFileName[MAX_PATH]`, NUL-terminated. **The name NTFS stored**, not
        /// the name that was asked for.
        file_name: [u16; 260],
        alternate_file_name: [u16; 14],
    }

    /// The name this directory really carries at `path`.
    ///
    /// `FindFirstFileW` enumerates the **directory entry**, so it neither
    /// follows the reparse point nor consults any case table of ours; the
    /// upcase table that decided which entry `path` lands on is the same one
    /// that stored the name it returns.
    pub(super) fn stored_name(path: &Path) -> io::Result<String> {
        Ok(text(&find_entry(path)?.file_name))
    }

    /// The volume's 8.3 alias for `path`, when it makes one.
    ///
    /// **Test scaffolding, and the reason it earns its place in the module it
    /// is testing:** short-name aliasing is a pair of names that are one
    /// directory entry and that Unicode simple lowercase calls distinct —
    /// `RESEAR~1` and the long name it abbreviates — on an ordinary NTFS
    /// volume, with no exotic character and no forced argument. It is the
    /// cheapest real instance of the hazard [`stored_name`] exists to catch.
    /// `None` where the volume does not generate one, which is a per-volume
    /// setting and so is measured rather than assumed.
    #[cfg(test)]
    pub(super) fn short_name(path: &Path) -> Option<String> {
        let alias = text(&find_entry(path).ok()?.alternate_file_name);
        (!alias.is_empty()).then_some(alias)
    }

    /// The directory entry for `path`, exactly as the volume stores it.
    fn find_entry(path: &Path) -> io::Result<FindDataW> {
        let name: Vec<u16> = path.as_os_str().encode_wide().chain(once(0)).collect();
        // SAFETY: every field of `FindDataW` is an integer or an array of them,
        // so all-zero is a valid value of it.
        let mut data: FindDataW = unsafe { std::mem::zeroed() };
        // SAFETY: `name` is NUL-terminated and outlives the call, and `data` is
        // a live structure of exactly the size the OS writes.
        let handle = unsafe { FindFirstFileW(name.as_ptr(), &mut data) };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `handle` came from `FindFirstFileW` and is not used again.
        unsafe { FindClose(handle) };
        Ok(data)
    }

    /// A NUL-terminated UTF-16 field of `WIN32_FIND_DATAW`, as a `String`.
    fn text(field: &[u16]) -> String {
        let end = field
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(field.len());
        String::from_utf16_lossy(&field[..end])
    }

    pub(super) fn create(link: &Path, target: &Path) -> io::Result<()> {
        // The substitute name has to be an NT object path, and it has to be the
        // *resolved* one: a junction stores an absolute target and does not
        // re-resolve it later, so a relative or symlinked input would freeze a
        // path that means something else tomorrow.
        let resolved = std::fs::canonicalize(target)?;
        let verbatim = resolved.as_os_str().to_string_lossy().into_owned();
        let plain = verbatim
            .strip_prefix(r"\\?\")
            .unwrap_or(&verbatim)
            .to_owned();

        let substitute: Vec<u16> = OsStr::new(&format!(r"\??\{plain}")).encode_wide().collect();
        let print: Vec<u16> = OsStr::new(&plain).encode_wide().collect();
        let substitute_bytes = substitute.len() * 2;
        let print_bytes = print.len() * 2;
        // Each name is stored NUL-terminated, and the lengths exclude the NUL.
        let path_buffer_bytes = substitute_bytes + 2 + print_bytes + 2;
        let reparse_data_length = 8 + path_buffer_bytes;
        let total = 8 + reparse_data_length;

        let mut buffer = vec![0u8; total];
        buffer[0..4].copy_from_slice(&IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
        buffer[4..6].copy_from_slice(&as_u16(reparse_data_length)?.to_le_bytes());
        buffer[8..10].copy_from_slice(&0u16.to_le_bytes());
        buffer[10..12].copy_from_slice(&as_u16(substitute_bytes)?.to_le_bytes());
        buffer[12..14].copy_from_slice(&as_u16(substitute_bytes + 2)?.to_le_bytes());
        buffer[14..16].copy_from_slice(&as_u16(print_bytes)?.to_le_bytes());

        let mut at = HEADER_BYTES;
        for unit in substitute.iter().chain(once(&0u16)).chain(print.iter()) {
            buffer[at..at + 2].copy_from_slice(&unit.to_le_bytes());
            at += 2;
        }

        // A junction is a directory that has been given reparse data, so the
        // directory has to exist before the handle can be opened.
        std::fs::create_dir(link)?;
        let name: Vec<u16> = link.as_os_str().encode_wide().chain(once(0)).collect();

        // SAFETY: `name` is NUL-terminated and outlives the call; the two
        // pointer arguments this call does not use are null.
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null_mut(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                0,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            let error = io::Error::last_os_error();
            let _ = std::fs::remove_dir(link);
            return Err(error);
        }

        let mut returned: u32 = 0;
        // SAFETY: `buffer` is `total` bytes long and lives across the call; the
        // output buffer is null with a zero length, which this control code
        // accepts.
        let wrote = unsafe {
            DeviceIoControl(
                handle,
                FSCTL_SET_REPARSE_POINT,
                buffer.as_ptr().cast::<c_void>(),
                as_u32(total)?,
                std::ptr::null_mut(),
                0,
                &mut returned,
                std::ptr::null_mut(),
            )
        };
        let failure = (wrote == 0).then(io::Error::last_os_error);
        // SAFETY: `handle` is a live handle this function opened and does not
        // use again.
        unsafe { CloseHandle(handle) };

        if let Some(error) = failure {
            // A directory with no reparse data is not a junction, and leaving
            // one behind would make the next reconcile report a mount that
            // silently serves nothing.
            let _ = std::fs::remove_dir(link);
            return Err(error);
        }
        Ok(())
    }

    /// `FILE_ADD_FILE` — the right a create inside this directory would be
    /// checked against. Asking for it and closing the handle performs the ACL
    /// evaluation and leaves nothing behind.
    const FILE_ADD_FILE: u32 = 0x0000_0002;

    pub(super) fn can_add_files(directory: &Path) -> bool {
        let name: Vec<u16> = directory.as_os_str().encode_wide().chain(once(0)).collect();
        // SAFETY: `name` is NUL-terminated and outlives the call; the unused
        // pointer arguments are null.
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                FILE_ADD_FILE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null_mut(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                0,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return false;
        }
        // SAFETY: `handle` is a live handle this function opened.
        unsafe { CloseHandle(handle) };
        true
    }

    fn as_u16(value: usize) -> io::Result<u16> {
        u16::try_from(value).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "the reparse buffer for this target does not fit in a mount point",
            )
        })
    }

    fn as_u32(value: usize) -> io::Result<u32> {
        u32::try_from(value)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "reparse buffer is too large"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(root: &Path, name: &str) -> std::path::PathBuf {
        let path = root.join(name);
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("SKILL.md"), format!("# {name}")).unwrap();
        path
    }

    #[test]
    fn windows_never_reaches_for_a_symlink_even_where_one_would_succeed() {
        // The single fact this crate's whole link story rests on. Stated as a
        // constant so it is one readable line rather than a branch, and asserted
        // so that widening the branch fails here.
        if cfg!(windows) {
            assert_eq!(NATIVE_LINK_STRATEGY, LinkStrategy::Junction);
            assert_ne!(NATIVE_LINK_STRATEGY, LinkStrategy::Symlink);
        } else {
            assert_eq!(NATIVE_LINK_STRATEGY, LinkStrategy::Symlink);
        }
    }

    #[test]
    fn the_probe_leaves_nothing_behind_and_reports_what_this_machine_did() {
        let root = tempfile::tempdir().unwrap();
        let strategy = probe_link_strategy(root.path());

        // Whatever this machine turns out to do, the scratch directory is gone.
        assert!(!root.path().join(".link-probe").exists());
        // On any developer or CI machine this project runs on, linking works.
        // A `Copy` here is a real answer, not a failure, so the assertion is on
        // the shape rather than the outcome.
        assert!(matches!(
            strategy,
            LinkStrategy::Junction | LinkStrategy::Symlink | LinkStrategy::Copy { .. }
        ));
        if cfg!(windows) {
            assert_ne!(strategy, LinkStrategy::Symlink, "never on Windows");
        }
    }

    #[test]
    fn a_link_is_followed_transparently_and_is_reported_as_a_reparse_point() {
        let root = tempfile::tempdir().unwrap();
        let target = tree(root.path(), "store-skill");
        let link = root.path().join("mounted");

        create_link(&link, &target).unwrap();
        assert!(is_reparse_point(&link).unwrap());
        assert!(!is_reparse_point(&target).unwrap());
        assert_eq!(
            fs::read_to_string(link.join("SKILL.md")).unwrap(),
            "# store-skill"
        );
    }

    #[test]
    fn removing_a_link_detaches_it_and_leaves_the_target_untouched() {
        let root = tempfile::tempdir().unwrap();
        let target = tree(root.path(), "store-skill");
        let link = root.path().join("mounted");
        create_link(&link, &target).unwrap();

        remove_tree(&link).unwrap();

        assert!(!link.exists());
        assert!(target.join("SKILL.md").is_file(), "the target survives");
    }

    #[test]
    fn removing_a_tree_that_contains_a_link_does_not_walk_through_it() {
        let root = tempfile::tempdir().unwrap();
        let store = tree(root.path(), "store-skill");
        let doomed = root.path().join("project-root");
        fs::create_dir_all(doomed.join("skills")).unwrap();
        fs::write(doomed.join("workspace.txt"), "scratch").unwrap();
        create_link(&doomed.join("skills").join("store-skill"), &store).unwrap();

        remove_tree(&doomed).unwrap();

        assert!(!doomed.exists());
        assert!(
            store.join("SKILL.md").is_file(),
            "the canonical skill must survive the project that mounted it"
        );
    }

    #[test]
    fn the_volume_says_which_name_it_stored_rather_than_the_name_it_was_asked_for() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("Research")).unwrap();

        assert_eq!(
            occupant_of(&root.path().join("Research")),
            MountOccupant::Named("Research".to_string())
        );
        assert_eq!(
            occupant_of(&root.path().join("never-created")),
            MountOccupant::Free,
            "a free path is a free path, and is not a refusal"
        );

        // A junction must answer with its own name. `canonicalize` would answer
        // with the target's, which is why it is not what this is built on.
        let target = tree(root.path(), "store-skill");
        let link = root.path().join("mounted");
        create_link(&link, &target).unwrap();
        assert_eq!(
            occupant_of(&link),
            MountOccupant::Named("mounted".to_string()),
            "the entry is named `mounted`; what it points at is named something else"
        );

        if crate::casefold::CaseFolding::probe(root.path())
            == crate::casefold::CaseFolding::Insensitive
        {
            assert_eq!(
                occupant_of(&root.path().join("research")),
                MountOccupant::Named("Research".to_string()),
                "`research` and `Research` are one entry here, and the volume — not \
                 Unicode — is the authority on which name that entry carries"
            );
        }
    }

    #[test]
    fn removing_something_that_is_not_there_is_success_rather_than_an_error() {
        let root = tempfile::tempdir().unwrap();
        remove_tree(&root.path().join("never-existed")).unwrap();
    }

    #[test]
    fn a_copy_is_a_snapshot_and_content_is_what_says_it_went_stale() {
        let root = tempfile::tempdir().unwrap();
        let source = tree(root.path(), "source");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::write(source.join("nested").join("a.txt"), "one").unwrap();
        let destination = root.path().join("copy");

        copy_tree(&source, &destination).unwrap();
        assert!(trees_have_same_content(&source, &destination).unwrap());
        assert_eq!(
            fs::read_to_string(destination.join("nested").join("a.txt")).unwrap(),
            "one"
        );

        // Same byte count, different bytes: a length check or an mtime check
        // would both miss this, which is why the comparison reads the files.
        fs::write(source.join("nested").join("a.txt"), "two").unwrap();
        assert!(!trees_have_same_content(&source, &destination).unwrap());
    }
}
