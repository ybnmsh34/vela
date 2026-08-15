//! Making a path reachable by its owner and nobody else — on every platform
//! Vela ships on, and **measured rather than assumed**.
//!
//! # Who needs it
//!
//! Two crates, which is why this is a crate and not a module inside either.
//!
//! | Caller | What it protects |
//! |---|---|
//! | `vela-providers` (`debuglog`, via `vela-app`'s `ipc::diagnostics`) | `<app data>/diagnostics` and the opt-in debug log inside it — raw upstream bodies, prompts and answers verbatim |
//! | `vela-store` (`DatabaseLocation::prepare`) | `<app data>` itself — `vela.db` and its `-wal`/`-shm` siblings, which hold **every conversation the user has ever had**, plus `skills/` and `projects/` beside them |
//!
//! The two halves of keeping any of that private are the *directory* it lives
//! in and the *file* itself, and neither half is the property on its own: a
//! `0600` database inside a world-listable directory still publishes its name,
//! its size and its timestamps.
//!
//! Both halves used to be written twice — the directory in `vela-app`'s
//! `ipc::diagnostics`, the file here — and both copies carried the same
//! two-clause comment on their `#[cfg(not(unix))]` branch:
//!
//! > *"the application-data directory is already per-user, and nothing here
//! > widens it."*
//!
//! **The second clause is true. The first was an assumption, and on a real
//! Windows machine it was already false before Vela ever ran.** The desktop
//! gate measured `%APPDATA%\dev.vela.desktop\diagnostics` immediately after
//! `diagnostics_debug_log_set{enabled:true}` created it:
//!
//! ```text
//! Owner               : DESKTOP-298M5DU\User
//! Inheritance enabled : True
//!   DESKTOP-298M5DU\User               FullControl                 inherited=True
//!   NT AUTHORITY\SYSTEM                FullControl                 inherited=True
//!   BUILTIN\Administrators             FullControl                 inherited=True
//!   DESKTOP-298M5DU\CodexSandboxUsers  ReadAndExecute, Synchronize inherited=True
//!   S-1-15-3-3557520199-…-3692855932   FullControl                 inherited=True
//! ```
//!
//! A **separate local group could read the directory holding raw provider
//! exchanges**. Vela did not widen anything — that ACE is inherited from a
//! parent under `%APPDATA%` put there by other software — and that is exactly
//! the point. The `unix` branch *enforced* `0700`/`0600`; the Windows branch
//! *assumed* the OS had already done the equivalent, and an assumption about
//! another installer's ACLs is not a security property.
//!
//! So: one crate, one promise, three implementations of it.
//!
//! | Platform | How the promise is kept |
//! |---|---|
//! | unix | `0700` on the directory, `0600` on the file, set at creation and re-applied to anything stale |
//! | windows | An explicit DACL — the running account and `NT AUTHORITY\SYSTEM`, nobody else — with **inheritance disabled** (`PROTECTED_DACL_SECURITY_INFORMATION`), so an inherited ACE from a parent is *discarded*, not merely out-voted |
//! | anything else | [`create_private_dir`] and [`open_private_append`] **refuse**. There is no fourth branch that shrugs |
//!
//! # Set, then read back
//!
//! Every entry point here **applies** the policy and then **re-reads it from
//! the filesystem** through [`describe`], and returns an error if what came
//! back is not private. That is deliberate and it is the lesson of this
//! project's own history: a check that reads back the declaration you just
//! wrote verifies your intent, not the system's behaviour. [`describe`] asks
//! the OS who can reach the path — mode bits on unix, the actual ACEs on
//! Windows — which is the same question `stat` and `Get-Acl` answer from a
//! shell.
//!
//! # Failing closed
//!
//! **Nothing here returns `Ok` over a path it could not verify.** That is the
//! whole contract, and both callers turn it into a refusal — but they refuse
//! different things, and the second one costs more, so it is argued where it
//! is taken rather than asserted here.
//!
//! `diagnostics::debug_log_set` refuses to enable the log. **A debug log that
//! silently stays readable by another account is worse than no debug log.**
//! The feature is opt-in and off by default, so refusing costs a user a
//! diagnostic aid they can obtain other ways; enabling anyway would cost them
//! every prompt and answer in the session, silently, with the switch cheerfully
//! reporting `enabled: true`.
//!
//! `DatabaseLocation::prepare` refuses to open the database, **which stops
//! startup**. That is a much larger consequence and it is defended at length on
//! `prepare` itself, in `vela-store/src/location.rs` — including what a user
//! with an existing installation sees, and why the alternative (harden, shrug,
//! carry on) is the one that cannot be made safe.
//!
//! In both cases the user is told which path failed and which principals can
//! reach it, so the refusal is actionable rather than mysterious.
//!
//! # What "private" means for a directory versus a file
//!
//! [`Privacy::is_private`] demands two things: no foreign principal, **and** a
//! DACL that is not open to inheritance. The second clause is what makes a
//! *root* trustworthy — it is precisely the bit that was `False` on the
//! measured machine, and it is why a parent's ACE reached in at all.
//!
//! A file that Vela creates *inside* an already-protected directory is a
//! different case, and the distinction is load-bearing rather than pedantic.
//! Windows inheritance is **static**: when [`create_private_dir`] protects a
//! directory, the security system rewrites the DACL of every existing
//! non-protected child then and there, and stamps the same two ACEs onto every
//! entry created afterwards. Such a child ends up with `foreign` empty and
//! `inheritance_disabled == Some(false)` — it is unreachable by anyone else,
//! but it is unreachable *because of its parent*, so `is_private()` reports
//! `false` for it. That is not a false alarm; it is the honest reading of a
//! path whose safety is delegated.
//!
//! So the rule the callers follow:
//!
//! - A **root** gets [`create_private_dir`] and must satisfy `is_private()`.
//! - A **file this crate is responsible for across restarts** — the debug log,
//!   the database and its siblings — additionally gets [`make_file_private`],
//!   which protects the leaf in its own right so that widening the parent
//!   tomorrow cannot widen it.
//! - A file the *operating system or SQLite* creates inside a protected root
//!   between those calls (a fresh `-wal`, a `-shm`) is covered by inheritance
//!   alone. `foreign` is the quantity that must be empty for it, and
//!   `the_wal_and_shm_sqlite_creates_are_born_unreachable_by_anyone_else` in
//!   `vela-store` measures exactly that, on a real database, rather than
//!   asserting it.
//!
//! # Honesty (conventions.md §10)
//!
//! The **unix** implementation is measured by this module's own tests and, out
//! of process, by `scripts/gate-m-debug-log-modes.sh`.
//!
//! The **Windows** implementation was **UNRUN** — written in a Linux container,
//! type-checked against `x86_64-pc-windows-msvc`, never executed, and, it turned
//! out, never even *compiled*: this module was missing from `lib.rs`, so no
//! platform had built a line of it.
//!
//! It has now been run. `scripts/gate-m-debug-log-acl.ps1` drove the real
//! `debug_log_set` against the real `%APPDATA%\dev.vela.desktop\diagnostics` on
//! the machine the original finding came from, and read the result back with
//! `Get-Acl` — a reader that shares no code with this module. Before, after
//! `icacls /reset` restored the shipped state:
//!
//! ```text
//! Owner               : DESKTOP-298M5DU\User
//! Inheritance enabled : True
//!   S-1-15-3-3557520199-…-3692855932   FullControl                 inherited=True
//!   DESKTOP-298M5DU\User               FullControl                 inherited=True
//!   DESKTOP-298M5DU\CodexSandboxUsers  ReadAndExecute, Synchronize inherited=True
//!   NT AUTHORITY\SYSTEM                FullControl                 inherited=True
//!   BUILTIN\Administrators             FullControl                 inherited=True
//! ```
//!
//! After:
//!
//! ```text
//! Owner               : DESKTOP-298M5DU\User
//! Inheritance enabled : False
//!   NT AUTHORITY\SYSTEM                FullControl                 inherited=False
//!   DESKTOP-298M5DU\User               FullControl                 inherited=False
//! SDDL                : …D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;S-1-5-21-…-1001)
//! ```
//!
//! `D:PAI` — `P` for protected — is the Windows spelling of the promise at the
//! top of this file, and the log file inside came out the same way.
//!
//! **The `diagnostics` subdirectory was the only thing that fix was ever
//! applied to.** The audit that followed measured the directory *containing*
//! it — the application-data root, holding `vela.db`, its 2.6 MB `-wal`, and
//! `skills/` — and found the identical inherited ACE this crate had been
//! written to remove, still there:
//!
//! ```text
//! C:\Users\User\AppData\Roaming\dev.vela.desktop
//!   Protected           : False
//!   DESKTOP-298M5DU\CodexSandboxUsers  ReadAndExecute, Synchronize  inherited=True
//! C:\Users\User\AppData\Roaming\dev.vela.desktop\diagnostics
//!   Protected           : True
//!   NT AUTHORITY\SYSTEM                FullControl                  inherited=False
//!   DESKTOP-298M5DU\User               FullControl                  inherited=False
//! ```
//!
//! The debug log was private and the transcripts beside it were not. A
//! mechanism is not a policy: this crate kept its promise everywhere it was
//! *called*, and the lesson is that the call site is part of the fix. It is now
//! called on the root, by `DatabaseLocation::prepare`, before anything else in
//! `setup` touches that directory.
//!
//! The remaining honesty note is narrower and still real: **the Windows branch
//! has been measured on exactly one machine**, one Windows build, one account
//! that is a member of `Administrators`. Nothing here has been exercised on a
//! domain-joined host, on a network share, or as a standard user.

use std::fs::File;
use std::io;
use std::path::Path;

/// What the operating system says about who can reach a path.
///
/// This is a **measurement**, not a restatement of what was requested. It is
/// produced by [`describe`], which re-reads the path from the filesystem after
/// any policy has been applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Privacy {
    /// Which implementation produced this — `"unix"` or `"windows"`.
    pub platform: &'static str,
    /// Every principal that can reach the path and is neither the account Vela
    /// is running as nor the local system.
    ///
    /// **This is the quantity the Windows defect moved.** On the machine the
    /// desktop gate measured it held `BUILTIN\Administrators`,
    /// `DESKTOP-298M5DU\CodexSandboxUsers` and an app-container SID. It must be
    /// empty.
    pub foreign: Vec<String>,
    /// Windows: whether the DACL is protected from inheritance
    /// (`SE_DACL_PROTECTED`). **The second quantity the defect moved** — it was
    /// measured `False`, which is why a parent's ACE reached the directory at
    /// all. `None` where the concept does not exist (unix).
    pub inheritance_disabled: Option<bool>,
    /// The raw reading, for evidence: the octal mode, or one line per ACE.
    pub detail: String,
}

impl Privacy {
    /// Whether the promise holds: nobody foreign can reach the path, and on
    /// Windows the DACL is not open to whatever a parent directory decides
    /// tomorrow.
    pub fn is_private(&self) -> bool {
        self.foreign.is_empty() && self.inheritance_disabled != Some(false)
    }

    fn refusal(&self, path: &Path) -> io::Error {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "`{}` could not be made private on this machine \
                 ({} reachable by: {}; inheritance disabled: {}; {}). \
                 Vela will not keep your conversations, or the raw provider \
                 exchanges behind them, at a path another account can read.",
                path.display(),
                self.platform,
                if self.foreign.is_empty() {
                    "nobody".to_owned()
                } else {
                    self.foreign.join(", ")
                },
                match self.inheritance_disabled {
                    Some(v) => v.to_string(),
                    None => "n/a".to_owned(),
                },
                self.detail,
            ),
        )
    }
}

/// Read back who can reach `path`.
///
/// The same reader the tests and the two shell gates use, so "private" means
/// one thing in the code, in `stat` and in `Get-Acl`.
pub fn describe(path: &Path) -> io::Result<Privacy> {
    imp::describe(path)
}

/// Create `path` and every missing parent, reachable by its owner and nobody
/// else — or fail.
pub fn create_private_dir(path: &Path) -> io::Result<()> {
    create_private_dir_with(path, imp::harden_dir)
}

/// [`create_private_dir`] with the enforcement step supplied by the caller.
///
/// The seam exists for one reason: the platform enforcement is the part a
/// Linux container cannot exercise on Windows, so the *wiring around it* — that
/// a failure to make the directory private stops the debug log being enabled —
/// has to be drivable without it. `vela-app`'s
/// `ipc::diagnostics::tests::the_log_stays_off_when_the_directory_cannot_be_made_private`
/// injects a failing enforcer; its control injects the pre-fix Windows body
/// (`create_dir_all` and a shrug) and shows the log coming up enabled over a
/// directory nothing protected.
///
/// Production code calls [`create_private_dir`].
pub fn create_private_dir_with(
    path: &Path,
    harden: impl FnOnce(&Path) -> io::Result<()>,
) -> io::Result<()> {
    // Created as tight as the platform allows in the first place, so there is
    // no window in which the directory exists and is readable.
    imp::create_dir(path)?;
    harden(path)?;
    let report = describe(path)?;
    if !report.is_private() {
        return Err(report.refusal(path));
    }
    Ok(())
}

/// Open `path` for appending, readable and writable by its owner and nobody
/// else — or fail.
///
/// The file is tightened rather than trusted: the switch is off at every
/// launch, so a log already on disk was left by an earlier run, possibly by a
/// build from before this rule. A user who upgrades should not have to know a
/// stale file is there.
///
/// On Windows the hardening is applied **by path** rather than through the
/// handle, which is safe precisely because the directory is hardened first: an
/// owner-only, inheritance-protected directory is one no other account can
/// create or substitute an entry inside. Order matters, and
/// `diagnostics::debug_log_set` establishes it before any sink is installed.
pub fn open_private_append(path: &Path) -> io::Result<File> {
    let file = imp::open_append(path)?;
    make_file_private(path)?;
    Ok(file)
}

/// Tighten a file that **already exists**, without opening it — or fail.
///
/// The same enforcement [`open_private_append`] applies, minus the opening.
/// That distinction is the reason this exists: `vela-store` must harden
/// `vela.db` and its `-wal`/`-shm` siblings *before* SQLite opens them, and
/// opening a database file for append in order to set its ACL would be an
/// absurd way to acquire a handle it then has to throw away.
///
/// Returns [`io::ErrorKind::NotFound`] if the path is not there. Callers that
/// mean "tighten it if it exists" must say so; a silent no-op on a missing path
/// is how a check stops checking.
pub fn make_file_private(path: &Path) -> io::Result<()> {
    imp::harden_file(path)?;
    let report = describe(path)?;
    if !report.is_private() {
        return Err(report.refusal(path));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// unix
// ---------------------------------------------------------------------------

#[cfg(unix)]
mod imp {
    use super::Privacy;
    use std::fs::File;
    use std::io;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
    use std::path::Path;

    const DIR_MODE: u32 = 0o700;
    const FILE_MODE: u32 = 0o600;
    /// Group and other. Any bit here is a principal that is not the owner.
    const FOREIGN: u32 = 0o077;

    pub(super) fn create_dir(path: &Path) -> io::Result<()> {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(DIR_MODE)
            .create(path)
    }

    pub(super) fn harden_dir(path: &Path) -> io::Result<()> {
        tighten(path, DIR_MODE)
    }

    pub(super) fn harden_file(path: &Path) -> io::Result<()> {
        tighten(path, FILE_MODE)
    }

    /// `mode` on [`std::fs::OpenOptions`] applies only when the file is
    /// created, which is why [`harden_file`] runs unconditionally afterwards.
    pub(super) fn open_append(path: &Path) -> io::Result<File> {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(FILE_MODE)
            .open(path)
    }

    fn tighten(path: &Path, wanted: u32) -> io::Result<()> {
        let mut permissions = std::fs::metadata(path)?.permissions();
        if permissions.mode() & FOREIGN != 0 {
            permissions.set_mode(wanted);
            std::fs::set_permissions(path, permissions)?;
        }
        Ok(())
    }

    pub(super) fn describe(path: &Path) -> io::Result<Privacy> {
        let mode = std::fs::metadata(path)?.permissions().mode() & 0o7777;
        let mut foreign = Vec::new();
        for (shift, who) in [(3, "group"), (0, "other")] {
            let bits = (mode >> shift) & 0o7;
            if bits != 0 {
                foreign.push(format!("{who} ({})", rwx(bits)));
            }
        }
        Ok(Privacy {
            platform: "unix",
            foreign,
            inheritance_disabled: None,
            detail: format!("mode {mode:04o}"),
        })
    }

    fn rwx(bits: u32) -> String {
        format!(
            "{}{}{}",
            if bits & 0o4 != 0 { 'r' } else { '-' },
            if bits & 0o2 != 0 { 'w' } else { '-' },
            if bits & 0o1 != 0 { 'x' } else { '-' },
        )
    }
}

// ---------------------------------------------------------------------------
// windows
// ---------------------------------------------------------------------------

/// The Win32 half. Written in a Linux container, never executed and never
/// compiled until this crate root learned the module existed; since then it has
/// been run against a real ACL on a real machine — see the module docs for the
/// before/after `Get-Acl` readings and for what that one machine does and does
/// not settle.
#[cfg(windows)]
mod imp {
    use super::Privacy;
    use std::ffi::OsStr;
    use std::fs::File;
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows_sys::Win32::Foundation::{
        CloseHandle, LocalFree, ERROR_SUCCESS, HANDLE, HLOCAL, WIN32_ERROR,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW,
        EXPLICIT_ACCESS_W, SET_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_USER,
        TRUSTEE_IS_WELL_KNOWN_GROUP,
    };
    use windows_sys::Win32::Security::{
        AclSizeInformation, CreateWellKnownSid, EqualSid, GetAce, GetAclInformation, GetLengthSid,
        GetSecurityDescriptorControl, GetTokenInformation, TokenUser, WinLocalSystemSid,
        ACCESS_ALLOWED_ACE, ACE_FLAGS, ACE_HEADER, ACL, ACL_SIZE_INFORMATION,
        DACL_SECURITY_INFORMATION, INHERITED_ACE, NO_INHERITANCE, OWNER_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SE_DACL_PROTECTED,
        SUB_CONTAINERS_AND_OBJECTS_INHERIT, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    /// `ACCESS_ALLOWED_ACE_TYPE`. Only an *allow* ACE hands access to anyone;
    /// a deny ACE for a foreign principal takes access away and is not a leak.
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
    /// `ACCESS_DENIED_ACE_TYPE`. Same layout, opposite meaning.
    const ACCESS_DENIED_ACE_TYPE: u8 = 1;

    /// A SID, owned. Held as `u32`s because a `SID` is a structure of `DWORD`s
    /// and the API is entitled to a 4-byte-aligned pointer; a `Vec<u8>` is only
    /// guaranteed 1.
    struct OwnedSid(Vec<u32>);

    impl OwnedSid {
        fn as_psid(&self) -> PSID {
            self.0.as_ptr() as PSID
        }
    }

    fn wide(path: &Path) -> Vec<u16> {
        OsStr::new(path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn win32(rc: WIN32_ERROR, what: &str) -> io::Result<()> {
        if rc == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(io::Error::new(
                io::Error::from_raw_os_error(rc as i32).kind(),
                format!("{what} failed: {}", io::Error::from_raw_os_error(rc as i32)),
            ))
        }
    }

    /// The SID of the account this process is running as. This is the "owner"
    /// half of "owner + SYSTEM": the account that turned the debug log on.
    fn current_user_sid() -> io::Result<OwnedSid> {
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut needed: u32 = 0;
            // Expected to fail with ERROR_INSUFFICIENT_BUFFER; it is how the
            // size is asked for.
            GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed);
            if needed == 0 {
                let error = io::Error::last_os_error();
                CloseHandle(token);
                return Err(error);
            }
            // `TOKEN_USER` holds a pointer, so the buffer must be
            // pointer-aligned. `Vec<u64>` guarantees 8.
            let mut buffer = vec![0u64; needed.div_ceil(8) as usize];
            let ok = GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                needed,
                &mut needed,
            );
            let error = io::Error::last_os_error();
            CloseHandle(token);
            if ok == 0 {
                return Err(error);
            }
            let user = &*(buffer.as_ptr() as *const TOKEN_USER);
            copy_sid(user.User.Sid)
        }
    }

    fn local_system_sid() -> io::Result<OwnedSid> {
        unsafe {
            let mut size: u32 = 0;
            CreateWellKnownSid(
                WinLocalSystemSid,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut size,
            );
            if size == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut sid = vec![0u32; size.div_ceil(4) as usize];
            if CreateWellKnownSid(
                WinLocalSystemSid,
                std::ptr::null_mut(),
                sid.as_mut_ptr() as PSID,
                &mut size,
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(OwnedSid(sid))
        }
    }

    /// # Safety
    /// `sid` must point at a valid SID.
    unsafe fn copy_sid(sid: PSID) -> io::Result<OwnedSid> {
        let length = GetLengthSid(sid);
        if length == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut owned = vec![0u32; length.div_ceil(4) as usize];
        std::ptr::copy_nonoverlapping(
            sid as *const u8,
            owned.as_mut_ptr() as *mut u8,
            length as usize,
        );
        Ok(OwnedSid(owned))
    }

    /// # Safety
    /// `sid` must point at a valid SID.
    unsafe fn sid_string(sid: PSID) -> String {
        let mut text: *mut u16 = std::ptr::null_mut();
        if ConvertSidToStringSidW(sid, &mut text) == 0 || text.is_null() {
            return "<unreadable SID>".to_owned();
        }
        let mut length = 0usize;
        while *text.add(length) != 0 {
            length += 1;
        }
        let owned = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
        LocalFree(text as HLOCAL);
        owned
    }

    pub(super) fn create_dir(path: &Path) -> io::Result<()> {
        // Windows has no "create with this DACL" on `std::fs`, so the directory
        // exists for an instant carrying the parent's inherited ACEs. That
        // instant is why `harden_dir` runs immediately after and why the
        // caller re-reads the result: this is a repair, and it is verified.
        std::fs::create_dir_all(path)
    }

    pub(super) fn open_append(path: &Path) -> io::Result<File> {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
    }

    pub(super) fn harden_dir(path: &Path) -> io::Result<()> {
        // Inheritable, so a log file created inside is born with the same two
        // ACEs and nothing else. The desktop gate measured the directory; the
        // file was never created during its window. This is the flag that makes
        // the file follow the directory rather than the parent.
        apply(path, SUB_CONTAINERS_AND_OBJECTS_INHERIT)
    }

    pub(super) fn harden_file(path: &Path) -> io::Result<()> {
        // Inheritance flags on a leaf mean nothing. Applied explicitly anyway,
        // because a log left by an earlier run — or by a build from before this
        // rule — carries whatever ACL it was born with.
        apply(path, NO_INHERITANCE)
    }

    /// Replace the DACL with exactly two ACEs and **disable inheritance**.
    ///
    /// `PROTECTED_DACL_SECURITY_INFORMATION` is the whole point:
    /// without it the ACEs below would be *added to* whatever the parent
    /// hands down, and the `CodexSandboxUsers ReadAndExecute` the desktop gate
    /// measured would survive. With it, inherited ACEs are discarded rather
    /// than merged, which is the Windows spelling of `0700`.
    fn apply(path: &Path, inheritance: ACE_FLAGS) -> io::Result<()> {
        let user = current_user_sid()?;
        let system = local_system_sid()?;

        let mut entries: [EXPLICIT_ACCESS_W; 2] = unsafe { std::mem::zeroed() };
        for (slot, sid, kind) in [
            (0usize, user.as_psid(), TRUSTEE_IS_USER),
            (1usize, system.as_psid(), TRUSTEE_IS_WELL_KNOWN_GROUP),
        ] {
            let entry = &mut entries[slot];
            entry.grfAccessPermissions = FILE_ALL_ACCESS;
            // SET_ACCESS, not GRANT_ACCESS: this replaces any existing entry
            // for the trustee rather than accumulating another one.
            entry.grfAccessMode = SET_ACCESS;
            entry.grfInheritance = inheritance;
            entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
            entry.Trustee.TrusteeType = kind;
            entry.Trustee.ptstrName = sid as *mut u16;
        }

        unsafe {
            let mut acl: *mut ACL = std::ptr::null_mut();
            // `NULL` for the old ACL: build from nothing. Passing the existing
            // one would carry every inherited ACE forward, which is the defect.
            win32(
                SetEntriesInAclW(2, entries.as_ptr(), std::ptr::null(), &mut acl),
                "SetEntriesInAclW",
            )?;
            let wide = wide(path);
            let rc = SetNamedSecurityInfoW(
                wide.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                acl,
                std::ptr::null(),
            );
            LocalFree(acl as HLOCAL);
            win32(rc, "SetNamedSecurityInfoW")
        }
    }

    pub(super) fn describe(path: &Path) -> io::Result<Privacy> {
        let user = current_user_sid()?;
        let system = local_system_sid()?;
        let wide = wide(path);

        unsafe {
            let mut dacl: *mut ACL = std::ptr::null_mut();
            let mut owner: PSID = std::ptr::null_mut();
            let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
            win32(
                GetNamedSecurityInfoW(
                    wide.as_ptr(),
                    SE_FILE_OBJECT,
                    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                    &mut owner,
                    std::ptr::null_mut(),
                    &mut dacl,
                    std::ptr::null_mut(),
                    &mut descriptor,
                ),
                "GetNamedSecurityInfoW",
            )?;

            let mut control: u16 = 0;
            let mut revision: u32 = 0;
            let protected =
                if GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) != 0 {
                    control & SE_DACL_PROTECTED != 0
                } else {
                    false
                };

            let mut foreign = Vec::new();
            let mut lines = vec![format!("owner={}", sid_string(owner))];

            if dacl.is_null() {
                // A NULL DACL is not "no access". It is unrestricted access.
                foreign.push("everyone (NULL DACL)".to_owned());
                lines.push("dacl=NULL — unrestricted".to_owned());
            } else {
                // `windows-sys` derives no `Default` for its raw structs — the
                // caller is expected to hand the API a zeroed out-parameter,
                // which `GetAclInformation` then fills.
                let mut size: ACL_SIZE_INFORMATION = std::mem::zeroed();
                if GetAclInformation(
                    dacl,
                    (&mut size) as *mut ACL_SIZE_INFORMATION as *mut core::ffi::c_void,
                    std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                    AclSizeInformation,
                ) == 0
                {
                    LocalFree(descriptor as HLOCAL);
                    return Err(io::Error::last_os_error());
                }
                for index in 0..size.AceCount {
                    let mut ace: *mut core::ffi::c_void = std::ptr::null_mut();
                    if GetAce(dacl, index, &mut ace) == 0 || ace.is_null() {
                        foreign.push(format!("<ACE {index} unreadable>"));
                        continue;
                    }
                    let header = &*(ace as *const ACE_HEADER);
                    let inherited = ACE_FLAGS::from(header.AceFlags) & INHERITED_ACE != 0;
                    match header.AceType {
                        ACCESS_ALLOWED_ACE_TYPE | ACCESS_DENIED_ACE_TYPE => {
                            let allowed = &*(ace as *const ACCESS_ALLOWED_ACE);
                            let sid = (&allowed.SidStart) as *const u32 as PSID;
                            let name = sid_string(sid);
                            lines.push(format!(
                                "ace type={} sid={name} mask=0x{:08x} inherited={inherited}",
                                header.AceType, allowed.Mask
                            ));
                            let grants =
                                header.AceType == ACCESS_ALLOWED_ACE_TYPE && allowed.Mask != 0;
                            let ours = EqualSid(sid, user.as_psid()) != 0
                                || EqualSid(sid, system.as_psid()) != 0;
                            if grants && !ours {
                                foreign.push(name);
                            }
                        }
                        other => {
                            // Object ACEs and audit ACEs have a different
                            // layout. Rather than misread one, refuse to call
                            // the path private.
                            lines.push(format!("ace type={other} — unrecognised layout"));
                            foreign.push(format!("<ACE type {other}, not decoded>"));
                        }
                    }
                }
            }

            LocalFree(descriptor as HLOCAL);
            Ok(Privacy {
                platform: "windows",
                foreign,
                inheritance_disabled: Some(protected),
                detail: lines.join("; "),
            })
        }
    }
}

// ---------------------------------------------------------------------------
// everything else
// ---------------------------------------------------------------------------

/// No third platform is shipped, and none is assumed private either. This is
/// the branch the Windows one used to be: the difference is that this one
/// **refuses** instead of shrugging.
#[cfg(all(not(unix), not(windows)))]
mod imp {
    use super::Privacy;
    use std::fs::File;
    use std::io;
    use std::path::Path;

    fn unsupported(path: &Path) -> io::Error {
        io::Error::new(
            io::ErrorKind::Unsupported,
            format!(
                "Vela has no way to make `{}` private on this platform, and \
                 will not keep your conversations, or the raw provider \
                 exchanges behind them, at a path it cannot protect",
                path.display()
            ),
        )
    }

    pub(super) fn create_dir(path: &Path) -> io::Result<()> {
        Err(unsupported(path))
    }
    pub(super) fn open_append(path: &Path) -> io::Result<File> {
        Err(unsupported(path))
    }
    pub(super) fn harden_dir(path: &Path) -> io::Result<()> {
        Err(unsupported(path))
    }
    pub(super) fn harden_file(path: &Path) -> io::Result<()> {
        Err(unsupported(path))
    }
    pub(super) fn describe(path: &Path) -> io::Result<Privacy> {
        Err(unsupported(path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "vela-private-fs-{}-{name}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    use std::path::PathBuf;

    /// The post-condition, on the real implementation, read back off the real
    /// filesystem.
    #[test]
    fn a_directory_this_module_creates_is_reachable_by_nobody_else() {
        let dir = scratch("fresh").join("diagnostics");
        create_private_dir(&dir).unwrap();

        let report = describe(&dir).unwrap();
        assert!(
            report.foreign.is_empty(),
            "a principal other than the owner can reach the diagnostics \
             directory: {report:?}"
        );
        assert_ne!(
            report.inheritance_disabled,
            Some(false),
            "the DACL is open to whatever a parent hands down: {report:?}"
        );
        assert!(report.is_private(), "{report:?}");
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }

    /// **The defect, executed, and then fixed, on one directory.**
    ///
    /// The pre-fix Windows branch was `std::fs::create_dir_all(path)` and a
    /// comment asserting the OS had already made it private. The first half of
    /// this test runs exactly that and then widens the result to the state the
    /// desktop gate actually measured — a principal that is not the owner
    /// holding read access. The reader says so. `create_private_dir` is then
    /// pointed at the same existing directory, and the reader says so again.
    ///
    /// What changes if the fix is absent: `foreign` stays non-empty. That is
    /// the quantity, and it is the same field the Windows implementation fills
    /// from real ACEs.
    #[test]
    fn an_existing_directory_a_non_owner_can_read_is_tightened_not_accepted() {
        let root = scratch("loose");
        let dir = root.join("diagnostics");

        // The pre-fix body, verbatim.
        std::fs::create_dir_all(&dir).unwrap();
        widen(&dir);

        let before = describe(&dir).unwrap();
        assert!(
            !before.foreign.is_empty(),
            "the control did not produce a directory a non-owner can reach, so \
             the assertion below would pass on anything: {before:?}"
        );
        assert!(!before.is_private(), "{before:?}");

        create_private_dir(&dir).unwrap();

        let after = describe(&dir).unwrap();
        assert!(
            after.is_private(),
            "an existing loose directory was accepted rather than tightened: \
             {after:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The log itself, not just the directory around it.
    #[test]
    fn a_log_this_module_opens_is_reachable_by_nobody_else() {
        let root = scratch("log");
        let dir = root.join("diagnostics");
        create_private_dir(&dir).unwrap();
        let path = dir.join("exchanges.jsonl");

        {
            let mut file = open_private_append(&path).unwrap();
            use std::io::Write;
            file.write_all(b"{\"body\":\"the endpoint's own words\"}\n")
                .unwrap();
        }

        let report = describe(&path).unwrap();
        assert!(report.is_private(), "the debug log is readable: {report:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A log left by an earlier run keeps its contents and loses its exposure.
    /// A "fix" that reached privacy by deleting the user's log would be a worse
    /// bug than the one it closed, and only this asserts otherwise.
    #[test]
    fn a_log_from_an_earlier_run_is_tightened_without_losing_a_line() {
        let root = scratch("stale");
        let dir = root.join("diagnostics");
        create_private_dir(&dir).unwrap();
        let path = dir.join("exchanges.jsonl");
        std::fs::write(&path, "{\"ref\":\"0000000000000001\"}\n").unwrap();
        widen(&path);
        assert!(!describe(&path).unwrap().is_private(), "control");

        let mut file = open_private_append(&path).unwrap();
        use std::io::Write;
        file.write_all(b"{\"ref\":\"0000000000000002\"}\n").unwrap();
        drop(file);

        assert!(describe(&path).unwrap().is_private());
        let written = std::fs::read_to_string(&path).unwrap();
        assert!(
            written.contains("0000000000000001"),
            "tightening destroyed the earlier run's entries"
        );
        assert!(written.contains("0000000000000002"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The seam `vela-app` drives. When the platform cannot deliver the
    /// promise, the caller is told, and no directory is handed back as if it
    /// could be trusted.
    #[test]
    fn a_directory_that_cannot_be_hardened_is_an_error_not_a_warning() {
        let root = scratch("refuse");
        let dir = root.join("diagnostics");

        let error = create_private_dir_with(&dir, |_| {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "SetNamedSecurityInfoW failed: Access is denied. (os error 5)",
            ))
        })
        .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(error.to_string().contains("SetNamedSecurityInfoW"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// **The pre-fix Windows branch, driven through the fix's own wiring.**
    ///
    /// Its entire body was "create it and assume the OS did the rest". Injected
    /// as the enforcement step, it succeeds — and the verification behind it
    /// catches the directory anyway. Without that read-back this call would
    /// return `Ok` over a directory a non-owner can read, which is precisely
    /// what shipped.
    #[test]
    fn assuming_the_os_already_made_it_private_does_not_get_past_the_read_back() {
        let root = scratch("assumed");
        let dir = root.join("diagnostics");

        let error = create_private_dir_with(&dir, |path| {
            // The `#[cfg(not(unix))]` body as it stood, plus the state the
            // desktop gate measured on a real machine: a principal that is not
            // the owner, holding read access, inherited from a parent.
            std::fs::create_dir_all(path)?;
            widen(path);
            Ok(())
        })
        .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(
            error.to_string().contains("could not be made private"),
            "{error}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Widen a path so a principal that is not its owner can read it — the
    /// state the desktop gate measured, expressed in whatever the platform
    /// spells it in.
    ///
    /// On Windows this grants `BUILTIN\Users`: a group that exists on every
    /// installation, is not the owner and is not `SYSTEM`, standing in for the
    /// `CodexSandboxUsers` ACE that was actually inherited there.
    #[cfg(unix)]
    fn widen(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(path).unwrap().permissions();
        let mode = permissions.mode() & 0o7777;
        permissions.set_mode(mode | 0o055);
        std::fs::set_permissions(path, permissions).unwrap();
    }

    #[cfg(windows)]
    fn widen(path: &Path) {
        let status = std::process::Command::new("icacls")
            .arg(path)
            .arg("/grant")
            .arg("*S-1-5-32-545:(OI)(CI)(RX)")
            .output()
            .expect("icacls must be present on Windows");
        assert!(
            status.status.success(),
            "could not widen {}: {}",
            path.display(),
            String::from_utf8_lossy(&status.stderr)
        );
    }

    #[cfg(all(not(unix), not(windows)))]
    fn widen(_path: &Path) {
        unreachable!("no third platform is supported");
    }
}
