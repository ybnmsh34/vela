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
//! directory, the security system rewrites the **inherited portion** of every
//! existing non-protected child's DACL then and there, and stamps the same two
//! ACEs onto every entry created afterwards. Such a child ends up with
//! `foreign` empty and `inheritance_disabled == Some(false)` — it is
//! unreachable by anyone else, but it is unreachable *because of its parent*,
//! so `is_private()` reports `false` for it. That is not a false alarm; it is
//! the honest reading of a path whose safety is delegated.
//!
//! **"Inherited portion" is exact, and the imprecise version of that sentence
//! was wrong in a way that mattered.** An ACE a child carries *explicitly*
//! (`inherited=False`) is not inherited, so protecting the parent does not
//! rewrite it and it survives — and the child goes on handing it down to
//! everything created inside. That was measured on a `skills/` directory here,
//! not deduced. [`repair_entries`] exists for exactly that shape, and is the
//! reason "harden the root" is a start rather than a finish.
//!
//! So the rule the callers follow:
//!
//! - A **root** gets [`create_private_dir`] and must satisfy `is_private()`.
//! - **Whatever is already inside it** gets [`repair_entries`], which re-stamps
//!   anything a foreign principal can still reach and leaves everything else
//!   untouched. This is the only thing that reaches an explicit ACE.
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
use std::path::{Path, PathBuf};

/// Reading one Windows ACE: does it hand access to somebody who is not us?
///
/// **Pure, and deliberately outside the `windows` implementation.** The
/// decision this makes is integer logic over an ACE type and an access mask,
/// and it is the single most consequential decision in this crate — it decides
/// whether a path counts as private, which decides whether Vela starts. Inside
/// the `unsafe` block it was unreachable by any test, and four different ways
/// of getting it wrong left the whole workspace green. Out here it is
/// exhaustively testable on every platform, including the ones that will never
/// execute it.
mod ace {
    /// `ACCESS_ALLOWED_ACE_TYPE`. Only an *allow* ACE hands access to anyone.
    pub const ALLOWED: u8 = 0;
    /// `ACCESS_DENIED_ACE_TYPE`. Same memory layout, opposite meaning.
    pub const DENIED: u8 = 1;

    /// What one ACE means for "can a principal other than us reach this path".
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Verdict {
        /// Hands nothing to anybody foreign. Either it is ours, or it is a
        /// denial, or it grants an empty set of rights.
        Harmless,
        /// Hands access to a principal that is neither the account Vela runs as
        /// nor the local system.
        Foreign,
        /// A layout this code does not decode — an object ACE, a callback ACE,
        /// something added to Windows after this was written. Refused rather
        /// than guessed at.
        Undecodable,
    }

    /// `ours` is the caller's `EqualSid` answer: the ACE's trustee is the
    /// running account or `NT AUTHORITY\SYSTEM`.
    ///
    /// # The three ways this has to be right
    ///
    /// - A **deny** ACE takes access away. Counting one as granting would make
    ///   any path carrying a deny entry for a foreign principal read as
    ///   non-private. **The consequence is not a refusal to start, and saying
    ///   so was wrong.** Every [`describe`] whose answer can produce a refusal
    ///   runs immediately after [`imp::apply`], which builds a fresh two-ACE
    ///   DACL from `NULL` — so no pre-existing deny entry survives to be read
    ///   back on that path, and it is unreachable.
    ///
    ///   The reachable consequence is worse. The one [`describe`] that reads a
    ///   DACL nobody has just replaced is the `before` in [`repair_within`],
    ///   and a non-empty `foreign` there means **repair**: the entry is
    ///   re-stamped with two ACEs and nothing else. So a directory an
    ///   administrator had locked a group out of would have had that lockout
    ///   **silently deleted by a routine startup**, and the read-back would
    ///   have confirmed the result as private, because it is. Vela would have
    ///   quietly widened a path in the name of narrowing it.
    /// - An **empty mask** grants nothing. Reporting it as a foreign reader
    ///   would be a false alarm with the same consequence.
    /// - An **unrecognised type** must be `Undecodable`, never `Harmless`.
    ///   Reading an object ACE with the layout of a plain one yields a
    ///   nonsense SID and a nonsense mask; the honest answer is to refuse to
    ///   call the path private rather than to decode it wrong or ignore it.
    pub fn verdict(ace_type: u8, mask: u32, ours: bool) -> Verdict {
        match ace_type {
            ALLOWED if !ours && mask != 0 => Verdict::Foreign,
            ALLOWED | DENIED => Verdict::Harmless,
            _ => Verdict::Undecodable,
        }
    }
}

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
    /// The subset of [`Self::foreign`] the path carries **in its own right** —
    /// `inherited=False` — rather than receiving from a parent.
    ///
    /// This is the distinction the whole repair turns on, so it is a field
    /// rather than something a caller re-derives by reading [`Self::detail`].
    /// Protecting a parent rewrites only the inherited portion of a child's
    /// DACL; anything in here survives that and has to be re-stamped by
    /// [`repair_entries`].
    ///
    /// It is also what a **control** in a test must assert. `%TEMP%` on the
    /// machine this was built on already hands three foreign principals to
    /// every directory created inside it, so "this directory has a foreign
    /// principal" is ambient-true there and a precondition asserting only that
    /// establishes nothing. On unix this equals [`Self::foreign`]: mode bits
    /// are never inherited.
    pub foreign_explicit: Vec<String>,
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

    /// Who can reach the path, in the words a user has to act on.
    ///
    /// **This is the actionable half of every message this crate produces.**
    /// "Vela would not open your conversations" tells a user something is
    /// wrong; "`DESKTOP-…\CodexSandboxUsers` can read them" tells them what to
    /// type into `icacls`. Every error path here goes through this, including
    /// the one where the *enforcement* failed rather than the verification —
    /// that path used to report a bare `SetNamedSecurityInfoW failed: Access is
    /// denied` and name nobody, which is a message that cannot be acted on.
    pub fn reach_summary(&self) -> String {
        format!(
            "{} reachable by: {}; inheritance disabled: {}; {}",
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
        )
    }

    fn refusal(&self, path: &Path) -> io::Error {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "`{}` could not be made private on this machine ({}). \
                 Vela will not keep your conversations, or the raw provider \
                 exchanges behind them, at a path another account can read.",
                path.display(),
                self.reach_summary(),
            ),
        )
    }
}

/// **Which half of the promise failed.**
///
/// The distinction is the caller's to act on and it is not cosmetic: one is
/// *could not*, the other is *would not*. A directory that cannot be created —
/// a name collision, a missing parent, a full disk — is an ordinary I/O fault
/// and was one before any of this existed. A directory that exists and cannot
/// be made private is a decision this crate is making.
///
/// `vela-store` maps them onto two different `StoreError` variants for exactly
/// that reason, and
/// `a_directory_that_cannot_be_created_is_an_io_fault_not_a_privacy_refusal`
/// is what stops the first quietly becoming the second.
#[derive(Debug)]
pub enum Failure {
    /// The path could not be created or reached at all. Nothing to do with
    /// privacy.
    Unreachable(io::Error),
    /// The path exists and could not be made reachable-by-owner-only — or the
    /// read-back said it still is not.
    NotPrivate(io::Error),
}

impl Failure {
    /// The underlying error, discarding which half produced it. Used by the
    /// entry points that predate this distinction and whose callers do not act
    /// on it.
    pub fn into_io(self) -> io::Error {
        match self {
            Self::Unreachable(error) | Self::NotPrivate(error) => error,
        }
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreachable(error) | Self::NotPrivate(error) => write!(f, "{error}"),
        }
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
    create_private_dir_reporting(path).map_err(Failure::into_io)
}

/// [`create_private_dir`], keeping which half failed.
///
/// The caller that needs this is `vela-store`: a directory it cannot *create*
/// must stay an ordinary I/O error, and only a directory it will not *accept*
/// becomes a privacy refusal. Collapsing the two is how a disk fault starts
/// reporting itself as a security decision.
pub fn create_private_dir_reporting(path: &Path) -> Result<(), Failure> {
    create_private_dir_with_reporting(path, imp::harden_dir)
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
    create_private_dir_with_reporting(path, harden).map_err(Failure::into_io)
}

/// [`create_private_dir_with`], keeping which half failed. See [`Failure`].
pub fn create_private_dir_with_reporting(
    path: &Path,
    harden: impl FnOnce(&Path) -> io::Result<()>,
) -> Result<(), Failure> {
    // Created as tight as the platform allows in the first place, so there is
    // no window in which the directory exists and is readable. A failure here
    // is a plain I/O fault — the path collides with a file, the parent is
    // gone, the disk is full — and is reported as one.
    imp::create_dir(path).map_err(Failure::Unreachable)?;
    enforce(path, harden).map_err(Failure::NotPrivate)
}

/// Apply the policy, then re-read it off the filesystem.
///
/// Both exits name the principals. The verification exit always could; the
/// **enforcement** exit could not, and reported a bare
/// `SetNamedSecurityInfoW failed: Access is denied. (os error 5)` — true, and
/// useless to the person who has to fix it. [`describe`] still works when
/// `SetNamedSecurityInfoW` does not, because reading a DACL and writing one are
/// different rights, so the accounts that can reach the path are available
/// exactly when they matter most.
fn enforce(path: &Path, harden: impl FnOnce(&Path) -> io::Result<()>) -> io::Result<()> {
    if let Err(error) = harden(path) {
        return Err(match describe(path) {
            Ok(report) => io::Error::new(
                error.kind(),
                format!(
                    "`{}` could not be made private on this machine: {error} \
                     ({}). Vela will not keep your conversations, or the raw \
                     provider exchanges behind them, at a path another account \
                     can read.",
                    path.display(),
                    report.reach_summary(),
                ),
            ),
            // Neither writing nor reading the ACL worked. Say so rather than
            // implying the principals were checked and found empty.
            Err(unreadable) => io::Error::new(
                error.kind(),
                format!(
                    "`{}` could not be made private on this machine: {error}; \
                     and who can reach it could not be read either \
                     ({unreadable}).",
                    path.display(),
                ),
            ),
        });
    }
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

/// Re-stamp anything **inside** `dir` that a foreign principal can still reach.
///
/// # Why protecting the parent is not enough
///
/// It is tempting to think [`create_private_dir`] on a root settles everything
/// below it. It does not, and the gap was measured rather than reasoned about.
/// Windows inheritance is static: protecting a directory rewrites the
/// **inherited portion** of each existing non-protected child's DACL. An ACE a
/// child carries **explicitly** — `inherited=False` — is not inherited, so it
/// is not rewritten, and it survives. On the machine this was found on, a
/// `skills/` directory holding an explicit
/// `CodexSandboxUsers ReadAndExecute` kept it after the root was hardened, and
/// went on handing it down to every file created inside.
///
/// That is not an exotic shape. It is what a previous installer, a sandbox
/// tool, or anyone who has ever run `icacls /grant` on the directory leaves
/// behind — and it is invisible to a check that only reads the root.
///
/// # What this walks, and what it does not
///
/// Direct entries of `dir`, and the contents of any directory it **had to
/// repair** — a directory carrying a foreign ACE is one whose contents are
/// demonstrably suspect, whereas a clean directory's subtree inherits from
/// something already verified. Entries that are already unreachable by anyone
/// foreign are left completely alone, so the steady-state cost at every launch
/// is one [`describe`] per entry and zero writes.
///
/// **Symlinks and junctions are skipped, and the reason is the walk, not the
/// stamp.**
///
/// An earlier version of this said stamping a DACL through one "would rewrite
/// the target's ACL". That is false and was measured false:
/// `Get`/`SetNamedSecurityInfoW` with `SE_FILE_OBJECT` act on the **link
/// object**, and a target's SDDL comes back byte-identical after the link has
/// been hardened. The stamp is harmless.
///
/// What is *not* harmless is [`repair_within`] recursing through one.
/// `projects/<id>/skills/<name>` are junctions into the machine-wide canonical
/// skill store; descending one would walk a tree that is not this root's, and
/// re-stamp files belonging to every project at once. That is the same hazard
/// `vela-projects::remove_tree` exists for, and it is a property of *walking*,
/// not of setting an ACL.
///
/// The skip is therefore exactly as wide as it needs to be, and no wider than
/// the code: `FileType::is_symlink` is true on Windows for
/// `IO_REPARSE_TAG_SYMLINK` and `IO_REPARSE_TAG_MOUNT_POINT` only. Other
/// reparse tags — an app-execution alias, a cloud-storage placeholder — are
/// **not** skipped, and are treated as the ordinary files they behave like.
/// Saying "reparse points are skipped" claimed a breadth this does not have.
///
/// # Two guards, redundant on purpose, and neither one provable alone
///
/// Descent is blocked twice: this skip, and `kind.is_dir()` on the recursive
/// call — which is already false for a junction, because `FileType` is
/// symlink-aware. **Removing either one alone changes no observable
/// behaviour**, which was established by mutation rather than assumed: with the
/// skip deleted the walk still cannot descend, and with the `is_dir()` guard
/// forced open the skip still stops it. Only removing *both* lets the walk out
/// of the tree, and that is the mutation
/// `the_walk_does_not_follow_a_junction_out_of_the_tree` reddens under.
///
/// So the test guards the **pair**, and no single-mutation test can attribute
/// the property to one of them. That is what defence in depth means when it is
/// working, and it is worth writing down rather than leaving a reader to infer
/// that each line is individually load-bearing.
///
/// The residual gap, stated plainly: an explicit foreign ACE on a deep entry
/// underneath an otherwise-clean directory is not searched for. Closing it
/// would mean walking every file under `projects/` at every launch, through
/// exactly those junctions. If that shape is ever observed in the wild it wants
/// its own repair pass, not a silent full-tree walk here.
///
/// Returns the paths it repaired, so a caller can report them.
pub fn repair_entries(dir: &Path) -> Result<Vec<PathBuf>, EntryFailure> {
    repair_entries_with(dir, describe, |path, is_dir| {
        enforce(
            path,
            if is_dir {
                imp::harden_dir
            } else {
                imp::harden_file
            },
        )
    })
}

/// [`repair_entries`] with the per-entry enforcement supplied by the caller.
///
/// The seam exists for the reason [`create_private_dir_with`] exists, and it
/// was added because its absence hid a defect: the two mutations that were
/// supposed to prove the walk reports the **failing entry** rather than the
/// directory it was walking both landed on `entry_failure`, a pure mapping
/// function, and the walk's own error construction went unguarded through two
/// rounds of review. A failure that cannot be provoked cannot be tested, and a
/// test that cannot fail is a comment.
///
/// The **ACL reader** is injectable for the same reason and by the same
/// argument. The walk's two responses to a failed read — step over an entry
/// that has vanished, stop for anything else — are a fail-closed decision that
/// a comment asserted and nothing checked: replacing the second with a silent
/// `continue` left the whole workspace green three times over. Neither arm can
/// be provoked through the real reader, because an object's owner holds
/// implicit `READ_CONTROL` and `icacls /deny` on oneself does not make
/// `GetNamedSecurityInfoW` fail.
///
/// Production code calls [`repair_entries`].
pub fn repair_entries_with(
    dir: &Path,
    read_acl: impl Fn(&Path) -> io::Result<Privacy> + Copy,
    enforce_entry: impl Fn(&Path, bool) -> io::Result<()> + Copy,
) -> Result<Vec<PathBuf>, EntryFailure> {
    let mut repaired = Vec::new();
    repair_within(dir, 0, &mut repaired, read_acl, enforce_entry)?;
    Ok(repaired)
}

/// A failure **at a named entry**, not at the root that contains it.
///
/// Without the path, every fault inside a walk collapses into one message
/// naming the directory that was being walked — which is the wrong path to put
/// in front of a user and the wrong one to hand to `icacls`. Without the
/// [`Failure`], a directory-listing I/O fault and a refusal to accept an ACL become
/// the same error, which is the *could not* / *would not* collapse all over
/// again, one call site to the right.
#[derive(Debug)]
pub struct EntryFailure {
    /// The entry that failed. Always more specific than the directory the walk
    /// started from.
    pub path: PathBuf,
    pub failure: Failure,
}

impl EntryFailure {
    fn unreachable(path: impl Into<PathBuf>, error: io::Error) -> Self {
        Self {
            path: path.into(),
            failure: Failure::Unreachable(error),
        }
    }

    fn not_private(path: impl Into<PathBuf>, error: io::Error) -> Self {
        Self {
            path: path.into(),
            failure: Failure::NotPrivate(error),
        }
    }
}

impl std::fmt::Display for EntryFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "`{}`: {}", self.path.display(), self.failure)
    }
}

/// Bounded so a filesystem loop cannot turn a startup check into a hang.
/// Reached only through directories that needed repair, so in a healthy tree
/// the recursion never starts.
const REPAIR_MAX_DEPTH: u32 = 16;

fn repair_within(
    dir: &Path,
    depth: u32,
    repaired: &mut Vec<PathBuf>,
    read_acl: impl Fn(&Path) -> io::Result<Privacy> + Copy,
    enforce_entry: impl Fn(&Path, bool) -> io::Result<()> + Copy,
) -> Result<(), EntryFailure> {
    if depth >= REPAIR_MAX_DEPTH {
        return Ok(());
    }
    let listing = std::fs::read_dir(dir).map_err(|error| EntryFailure::unreachable(dir, error))?;
    for entry in listing {
        let entry = entry.map_err(|error| EntryFailure::unreachable(dir, error))?;
        let path = entry.path();
        let kind = entry
            .file_type()
            .map_err(|error| EntryFailure::unreachable(&path, error))?;
        if kind.is_symlink() {
            continue;
        }
        // An entry that vanished between the directory listing and here is not
        // a privacy failure. SQLite deletes a write-ahead log on checkpoint and
        // this runs at startup beside a database that may already be live.
        let before = match read_acl(&path) {
            Ok(report) => report,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            // Not being able to read who can reach a path is not the same as
            // reading that nobody can. Fail closed, at the entry.
            Err(error) => return Err(EntryFailure::not_private(&path, error)),
        };
        if before.foreign.is_empty() {
            continue;
        }

        // Through `enforce`, not by hand: that is what applies the policy, then
        // re-reads it off the filesystem, and names the principals if the
        // enforcement call itself fails. Repairing an entry any other way would
        // be a second implementation of the promise with its own read-back to
        // forget — and `assuming_the_os_already_made_it_private_does_not_get_past_the_read_back`
        // guards this path only because it is this path.
        enforce_entry(&path, kind.is_dir())
            .map_err(|error| EntryFailure::not_private(&path, error))?;
        repaired.push(path.clone());

        if kind.is_dir() {
            repair_within(&path, depth + 1, repaired, read_acl, enforce_entry)?;
        }
    }
    Ok(())
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
            // Mode bits belong to the file and are never handed down from a
            // parent, so every foreign bit is one the path carries in its own
            // right.
            foreign_explicit: foreign.clone(),
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

    /// The ACE types this decoder understands, and what one means for privacy.
    /// Kept out here so the decision is reachable by a test — see
    /// [`super::ace`].
    use super::ace;

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
            let mut foreign_explicit = Vec::new();
            let mut lines = vec![format!("owner={}", sid_string(owner))];

            if dacl.is_null() {
                // A NULL DACL is not "no access". It is unrestricted access.
                foreign.push("everyone (NULL DACL)".to_owned());
                foreign_explicit.push("everyone (NULL DACL)".to_owned());
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
                        ace::ALLOWED | ace::DENIED => {
                            let allowed = &*(ace as *const ACCESS_ALLOWED_ACE);
                            let sid = (&allowed.SidStart) as *const u32 as PSID;
                            let name = sid_string(sid);
                            lines.push(format!(
                                "ace type={} sid={name} mask=0x{:08x} inherited={inherited}",
                                header.AceType, allowed.Mask
                            ));
                            let ours = EqualSid(sid, user.as_psid()) != 0
                                || EqualSid(sid, system.as_psid()) != 0;
                            // The decision itself lives in `super::ace`, where
                            // a test can reach it.
                            if ace::verdict(header.AceType, allowed.Mask, ours)
                                == ace::Verdict::Foreign
                            {
                                foreign.push(name.clone());
                                if !inherited {
                                    foreign_explicit.push(name);
                                }
                            }
                        }
                        other => {
                            // Object ACEs and audit ACEs have a different
                            // layout. Rather than misread one, refuse to call
                            // the path private.
                            lines.push(format!("ace type={other} — unrecognised layout"));
                            let undecodable = format!("<ACE type {other}, not decoded>");
                            foreign.push(undecodable.clone());
                            if !inherited {
                                foreign_explicit.push(undecodable);
                            }
                        }
                    }
                }
            }

            LocalFree(descriptor as HLOCAL);
            Ok(Privacy {
                platform: "windows",
                foreign,
                foreign_explicit,
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

    // -----------------------------------------------------------------------
    // Reading one ACE. Pure, so it runs on every platform including the ones
    // that will never execute the Windows branch.
    //
    // Every case below was a mutation that left the ENTIRE workspace green at
    // 1291/1291 before these existed.
    // -----------------------------------------------------------------------

    /// **The one with teeth.**
    ///
    /// A deny ACE takes access away. Counting one as granting makes a path
    /// carrying a denial for a foreign principal read as *not private* — and
    /// what that costs is set out on [`ace::verdict`]: not a refusal, because
    /// no production `describe` that can refuse ever sees an unreplaced DACL,
    /// but a **silent repair that deletes an administrator's lockout**. Deny
    /// entries are not exotic; they are exactly what an administrator adds to
    /// lock a group out of a folder.
    ///
    /// `a_deny_ace_an_administrator_added_survives_the_walk` measures that
    /// consequence on a real DACL. This one pins the decision itself.
    #[test]
    fn a_deny_ace_for_a_foreign_principal_is_not_a_foreign_reader() {
        assert_eq!(
            ace::verdict(ace::DENIED, 0x001f01ff, false),
            ace::Verdict::Harmless,
            "a denial was read as handing access to the principal it denies"
        );
    }

    #[test]
    fn an_allow_ace_for_a_foreign_principal_is_a_foreign_reader() {
        assert_eq!(
            ace::verdict(ace::ALLOWED, 0x001200a9, false),
            ace::Verdict::Foreign
        );
    }

    #[test]
    fn an_allow_ace_for_us_is_harmless() {
        assert_eq!(
            ace::verdict(ace::ALLOWED, 0x001f01ff, true),
            ace::Verdict::Harmless
        );
    }

    /// An ACE granting an empty set of rights hands over nothing. Reporting it
    /// as a reader is a false alarm with the same cost as the deny case: an
    /// entry needlessly re-stamped, losing whatever its DACL said.
    #[test]
    fn an_allow_ace_with_an_empty_mask_grants_nothing() {
        assert_eq!(ace::verdict(ace::ALLOWED, 0, false), ace::Verdict::Harmless);
    }

    /// Object ACEs, callback ACEs and anything Windows gains later have a
    /// different layout; read with this one's, the SID and mask are nonsense.
    /// The honest answer is to refuse to call the path private — never to treat
    /// the entry as harmless because it was not understood.
    #[test]
    fn an_ace_layout_this_code_cannot_decode_is_never_called_harmless() {
        for unknown in [2u8, 5, 9, 17, 255] {
            assert_eq!(
                ace::verdict(unknown, 0x001f01ff, false),
                ace::Verdict::Undecodable,
                "ace type {unknown} was decoded as if its layout were known"
            );
            assert_eq!(
                ace::verdict(unknown, 0, true),
                ace::Verdict::Undecodable,
                "ace type {unknown} was waved through because it looked like ours"
            );
        }
    }

    /// **A retracted claim must not come back, and this is the third time it
    /// has.**
    ///
    /// The consequence of reading a deny ACE as a grant was stated wrongly — as
    /// a refusal to start rather than a silent repair — and retracted on
    /// [`ace::verdict`], then shipped verbatim twice more in this same file, a
    /// thousand lines below the retraction, in a commit whose own message said
    /// "checking took one grep". The round before that, the same shape: a
    /// retracted claim left standing one file away from its correction.
    ///
    /// The wording itself is deliberately **not** quoted here. It is assembled
    /// below from fragments, because a guard that spells out the phrase it
    /// bans is a guard that fails on itself — which is how this test first ran.
    ///
    /// Twice is a mistake, three times is a missing check. Greping the tree
    /// after a retraction is a procedure that depends on remembering; this does
    /// not. It walks every Rust source in the workspace, so it is not confined
    /// to the crate that happened to be wrong last time.
    ///
    /// The wording is distinctive enough that an innocent recurrence is
    /// implausible. If one ever happens, rephrase — do not widen this.
    #[test]
    fn the_retracted_reason_for_the_deny_rule_stays_retracted() {
        // Assembled rather than written out, so this file does not contain the
        // string it is banning.
        let retracted = format!("stricter than {} one it demands", "the");
        // A positive control. An assertion that a phrase is ABSENT passes just
        // as happily when the search is broken as when the tree is clean, so
        // the same walk is asked for something that must be there. This does
        // not defend against the needle being swapped for a phrase that never
        // occurs — no absence assertion can — but it does catch the walk
        // silently finding nothing, which is the way this would actually rot.
        let sentinel = "PROTECTED_DACL_SECURITY_INFORMATION";

        let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .expect("the crate sits at src-tauri/crates/<name>")
            .to_path_buf();

        let mut offenders = Vec::new();
        let mut sentinel_hits = 0usize;
        let mut scanned = 0usize;
        let mut stack = vec![workspace.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(listing) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in listing.flatten() {
                let path = entry.path();
                let name = entry.file_name();
                if name == "target" || name == "node_modules" || name == ".git" {
                    continue;
                }
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().is_some_and(|ext| ext == "rs") {
                    scanned += 1;
                    if let Ok(text) = std::fs::read_to_string(&path) {
                        if text.contains(sentinel) {
                            sentinel_hits += 1;
                        }
                        if text.contains(&retracted) {
                            offenders.push(path);
                        }
                    }
                }
            }
        }

        assert!(
            scanned > 50,
            "only {scanned} Rust files were scanned from {} — the walk is not \
             reaching the workspace, so this guard is vacuous",
            workspace.display()
        );
        assert!(
            sentinel_hits > 0,
            "the walk read {scanned} files and found none containing `{sentinel}`, \
             so it is not reading their contents and the absence below means \
             nothing"
        );
        assert!(
            offenders.is_empty(),
            "a claim this crate retracted is being made again in: {offenders:?}"
        );
    }

    /// **The deny case on a real DACL, at the one call site where it bites.**
    ///
    /// The pure test above fixes the decision; this fixes the wiring — and it
    /// drives [`repair_entries`], not [`describe`] alone, because that is where
    /// the consequence actually lives. Every `describe` whose answer can
    /// produce a *refusal* runs just after the DACL has been rebuilt from
    /// `NULL`, so a pre-existing deny cannot reach it. The `before` read inside
    /// the walk is the exception, and there a false `Foreign` does not refuse —
    /// **it repairs**, replacing the entry's DACL with two ACEs and destroying
    /// the administrator's lockout on the way past.
    ///
    /// So: a directory an administrator has locked `BUILTIN\Users` out of,
    /// sitting inside the application-data root, must come through a startup
    /// with that lockout intact.
    #[cfg(windows)]
    #[test]
    fn a_deny_ace_an_administrator_added_survives_the_walk() {
        let root = scratch("deny");
        let data = root.join("app-data");
        let locked = data.join("locked");
        std::fs::create_dir_all(&locked).unwrap();
        create_private_dir(&data).unwrap();

        // Stricter than what this crate demands, not looser.
        deny(&locked, "*S-1-5-32-545");

        let before = describe(&locked).unwrap();
        assert!(
            before.detail.contains("ace type=1"),
            "control: no deny ace was recorded, so nothing here is under test: \
             {before:?}"
        );
        assert!(
            before.foreign.is_empty(),
            "a deny entry was read as a principal that can reach the path — the \
             walk is about to 'repair' a directory that needs no repair: \
             {before:?}"
        );

        repair_entries(&data).unwrap();

        let after = describe(&locked).unwrap();
        assert!(
            after.detail.contains("ace type=1"),
            "a routine startup silently deleted an administrator's lockout: \
             before={before:?} after={after:?}"
        );
        reset_and_remove(&root);
    }

    /// **A refusal inside the walk names the entry that failed.**
    ///
    /// Driven through the real walk with a failing enforcer, not by
    /// hand-building an [`EntryFailure`]. That distinction is the whole point:
    /// the two mutations that were supposed to prove this both landed on
    /// `vela-store`'s pure mapping function, and the walk's own error
    /// construction — `EntryFailure::not_private(&path, …)` — stayed green
    /// while being changed to report the directory instead.
    #[cfg(windows)]
    #[test]
    fn a_refusal_inside_the_walk_names_the_entry_not_the_directory() {
        let root = scratch("walk-entry");
        let data = root.join("app-data");
        let child = data.join("skills");
        std::fs::create_dir_all(&child).unwrap();
        create_private_dir(&data).unwrap();
        widen(&child);
        assert!(
            !describe(&child).unwrap().foreign.is_empty(),
            "control: the walk has nothing to repair, so it will never reach \
             the enforcement step"
        );

        let failure = repair_entries_with(&data, describe, |_, _| {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "SetNamedSecurityInfoW failed: Access is denied. (os error 5)",
            ))
        })
        .unwrap_err();

        assert_eq!(
            failure.path, child,
            "the walk reported the directory it was walking rather than the \
             entry that could not be tightened"
        );
        assert!(
            matches!(failure.failure, Failure::NotPrivate(_)),
            "an ACL refusal was classified as an I/O fault: {failure:?}"
        );
        reset_and_remove(&root);
    }

    /// **An entry whose ACL cannot be read stops the walk.**
    ///
    /// Not being able to read who can reach a path is not the same as reading
    /// that nobody can, so the walk fails closed. That arm carried a comment
    /// saying exactly this and nothing checked it: replacing it with a silent
    /// `continue` — an unreadable entry skipped, failing **open** — left the
    /// whole workspace green three times over.
    ///
    /// Driven through the injected reader because it cannot be provoked through
    /// the real one: an object's owner holds implicit `READ_CONTROL`, and
    /// `icacls /deny` against oneself does not make `GetNamedSecurityInfoW`
    /// fail. An unprovokable arm is still a decision, and a decision with a
    /// comment and no test is the shape this repair keeps producing.
    #[cfg(windows)]
    #[test]
    fn an_entry_whose_acl_cannot_be_read_stops_the_walk() {
        let root = scratch("unreadable");
        let data = root.join("app-data");
        let child = data.join("skills");
        std::fs::create_dir_all(&child).unwrap();
        create_private_dir(&data).unwrap();

        let failure = repair_entries_with(
            &data,
            |_| {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "GetNamedSecurityInfoW failed: Access is denied. (os error 5)",
                ))
            },
            |_, _| Ok(()),
        )
        .unwrap_err();

        assert_eq!(failure.path, child);
        assert!(
            matches!(failure.failure, Failure::NotPrivate(_)),
            "an unreadable ACL was not treated as a privacy failure: {failure:?}"
        );
        reset_and_remove(&root);
    }

    /// The other arm: an entry that has **gone** is stepped over, not fatal.
    ///
    /// SQLite deletes a write-ahead log on checkpoint, and this runs at startup
    /// beside a database that may already be live, so a vanished entry is
    /// ordinary. Failing closed on it would turn a routine race into a refusal
    /// to start — which is the one place that phrase does belong.
    #[cfg(windows)]
    #[test]
    fn an_entry_that_vanished_mid_walk_is_stepped_over() {
        let root = scratch("vanished");
        let data = root.join("app-data");
        std::fs::create_dir_all(data.join("skills")).unwrap();
        create_private_dir(&data).unwrap();

        let repaired = repair_entries_with(
            &data,
            |_| Err(io::Error::from(io::ErrorKind::NotFound)),
            |_, _| panic!("nothing should have been repaired"),
        )
        .expect("a vanished entry is not a privacy failure");

        assert!(repaired.is_empty());
        reset_and_remove(&root);
    }

    /// **The walk descends into a directory it had to repair.**
    ///
    /// [`repair_entries`] documents this affirmatively, and the residual gap it
    /// states is phrased in terms that presuppose it — yet `if false` on the
    /// recursive call left 1303 tests green. The whole mechanism could be
    /// deleted unnoticed.
    ///
    /// It needs a file carrying its **own** explicit ACE, one level down.
    /// `an_explicit_ace_on_a_subdirectory_is_removed_not_merely_out_voted` has
    /// the file merely *inheriting*, so protecting the subdirectory fixes it
    /// without anyone descending — which is exactly why that test did not
    /// notice.
    #[cfg(windows)]
    #[test]
    fn the_walk_descends_into_a_directory_it_had_to_repair() {
        let root = scratch("descend");
        let data = root.join("app-data");
        let skills = data.join("skills");
        std::fs::create_dir_all(&skills).unwrap();
        let installed = skills.join("my-skill.md");
        std::fs::write(&installed, b"---\nname: my-skill\n---\n").unwrap();
        create_private_dir(&data).unwrap();

        // Explicit on both levels: the subdirectory, and the file inside it.
        // Protecting `skills/` rewrites only the file's INHERITED portion, so
        // the file's own ace survives unless something walks down to it.
        widen(&skills);
        widen_file(&installed);

        let before = describe(&installed).unwrap();
        assert!(
            !before.foreign_explicit.is_empty(),
            "control: the file carries no ace of its own, so protecting its \
             parent would clean it and this test would pass without any \
             descent: {before:?}"
        );

        repair_entries(&data).unwrap();

        let after = describe(&installed).unwrap();
        assert!(
            after.foreign.is_empty(),
            "the walk stopped at `skills/` and left a file inside it reachable \
             by another account: {after:?}"
        );
        reset_and_remove(&root);
    }

    /// **A directory that cannot be listed is an I/O fault, not a refusal.**
    ///
    /// The could-not / would-not split, at the walk rather than at the root.
    /// The three `EntryFailure::unreachable` sites were changed to
    /// `not_private` together and nothing went red.
    ///
    /// This covers the listing call. The two remaining sites — the per-entry
    /// iteration error and `file_type()` — are not independently provokable
    /// without injecting faults into `std::fs`, and are **not** claimed to be
    /// guarded.
    #[test]
    fn a_directory_that_cannot_be_listed_is_an_io_fault_not_a_refusal() {
        let root = scratch("unlistable");
        let missing = root.join("was-never-created");

        let failure = repair_entries(&missing).unwrap_err();

        assert_eq!(failure.path, missing);
        assert!(
            matches!(failure.failure, Failure::Unreachable(_)),
            "a directory that could not be listed was reported as a privacy \
             refusal: {failure:?}"
        );
    }

    /// **`foreign_explicit` is the non-inherited subset, not a copy of
    /// `foreign`.**
    ///
    /// The field exists so a control can tell "this path carries a foreign ACE
    /// of its own" from "this path is under a directory that hands one down" —
    /// the difference between a precondition a test established and one the
    /// filesystem supplied for free. If it ever aliases `foreign`, every
    /// control built on it silently becomes the ambient-true check it replaced,
    /// and the five vacuous preconditions this repair has already produced
    /// would come back at once.
    ///
    /// Self-contained rather than relying on `%TEMP%`'s own ACL: the parent is
    /// widened here, so the child's foreign principal is inherited by
    /// construction on any machine.
    #[cfg(windows)]
    #[test]
    fn foreign_explicit_holds_only_what_the_path_carries_itself() {
        let root = scratch("explicit");
        let parent = root.join("parent");
        let child = parent.join("child");
        std::fs::create_dir_all(&child).unwrap();
        widen(&parent);

        let inherited = describe(&child).unwrap();
        assert!(
            !inherited.foreign.is_empty(),
            "control: the child inherited nothing, so there is no distinction \
             to draw: {inherited:?}"
        );
        assert!(
            inherited.foreign_explicit.is_empty(),
            "an ace the child merely inherits was reported as one it carries \
             itself, which makes every control built on this field vacuous: \
             {inherited:?}"
        );

        widen(&child);
        let own = describe(&child).unwrap();
        assert!(
            !own.foreign_explicit.is_empty(),
            "an ace granted directly on the child was not reported as its own: \
             {own:?}"
        );
        for who in &own.foreign_explicit {
            assert!(
                own.foreign.contains(who),
                "`foreign_explicit` is not a subset of `foreign`: {own:?}"
            );
        }
        reset_and_remove(&root);
    }

    /// **The walk must not leave the tree it was given.**
    ///
    /// A junction under the application-data root points at the machine-wide
    /// canonical skill store. Descending one would re-stamp files belonging to
    /// every project at once. The skip is what stops that — and the reason is
    /// the recursion, not the stamp: setting an ACL by path acts on the link,
    /// not on what it points at.
    ///
    /// What changes if the skip is removed: the file inside `outside` is
    /// re-stamped, which is this test's way of saying Vela reached out of its
    /// own directory and rewrote somebody else's permissions.
    ///
    /// # What this can and cannot attribute
    ///
    /// Getting it to bite took two goes. [`repair_within`] descends only into
    /// directories it had to **repair**, so a junction whose own DACL is
    /// already clean is passed over for reasons unrelated to the check under
    /// test — the first version of this test passed with the skip deleted. The
    /// link is therefore widened **after** the root is protected, which is the
    /// shape a previous `icacls` on a mount point leaves behind.
    ///
    /// Even so, this reddens only when **both** descent guards are removed —
    /// the symlink skip and `kind.is_dir()` on the recursive call. Each alone
    /// is sufficient, so neither is individually falsifiable, and this test
    /// does not claim otherwise. See [`repair_entries`] for why both are kept.
    #[cfg(windows)]
    #[test]
    fn the_walk_does_not_follow_a_junction_out_of_the_tree() {
        let root = scratch("junction");
        let inside = root.join("app-data");
        let outside = root.join("somewhere-else");
        let theirs = outside.join("not-ours.txt");
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(&theirs, b"belongs to something else").unwrap();
        widen(&outside);

        let before_dir = describe(&outside).unwrap();
        let before_file = describe(&theirs).unwrap();
        assert!(
            !before_file.foreign.is_empty(),
            "control: the outside file has nothing to lose: {before_file:?}"
        );

        // A junction, the way `vela-projects` mounts the canonical store.
        let link = inside.join("skills-mount");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .output()
            .expect("cmd must be present on Windows");
        assert!(
            made.status.success(),
            "could not create a junction: {}",
            String::from_utf8_lossy(&made.stdout)
        );

        create_private_dir(&inside).unwrap();
        // Widened after the protection, so the walk has a reason to want to
        // repair the link — and therefore a reason to descend it.
        widen(&link);
        let link_report = describe(&link).unwrap();
        assert!(
            !link_report.foreign.is_empty(),
            "control: the junction is already clean, so the walk would skip it \
             for reasons that have nothing to do with the check under test: \
             {link_report:?}"
        );
        assert_eq!(
            describe(&theirs).unwrap().detail,
            before_file.detail,
            "control: widening the junction reached through it to the target, \
             so this test cannot distinguish the walk from its own setup"
        );

        repair_entries(&inside).unwrap();

        assert_eq!(
            describe(&theirs).unwrap().detail,
            before_file.detail,
            "the walk followed a junction and rewrote a file outside the tree \
             it was given"
        );
        assert_eq!(
            describe(&outside).unwrap().detail,
            before_dir.detail,
            "the walk followed a junction and rewrote a directory outside the \
             tree it was given"
        );
        reset_and_remove(&root);
    }

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
        widen_as(path, "*S-1-5-32-545", "(OI)(CI)(RX)");
    }

    /// Widen a **file**: no container-inherit flags, which mean nothing on a
    /// leaf, and a different principal so the ace it gains is distinguishable
    /// from whatever it inherited from its parent.
    ///
    /// [`widen`] on a file that already inherits the same grant for the same
    /// principal produces no explicit ace at all — which is exactly how the
    /// descent test failed its own control the first time it ran, and why that
    /// control is worth having.
    #[cfg(windows)]
    fn widen_file(path: &Path) {
        widen_as(path, "*S-1-5-32-546", "(R)");
    }

    #[cfg(windows)]
    fn widen_as(path: &Path, principal: &str, rights: &str) {
        let status = std::process::Command::new("icacls")
            .arg(path)
            .arg("/grant")
            .arg(format!("{principal}:{rights}"))
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

    /// Lock a principal out of `path` the way an administrator would.
    #[cfg(windows)]
    fn deny(path: &Path, principal: &str) {
        let output = std::process::Command::new("icacls")
            .arg(path)
            .arg("/deny")
            .arg(format!("{principal}:(OI)(CI)(R)"))
            .output()
            .expect("icacls must be present on Windows");
        assert!(
            output.status.success(),
            "could not add a deny ace to {}: {}",
            path.display(),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// Remove a scratch tree, **restoring access first, and checking it went**.
    ///
    /// A test that denies `BUILTIN\Users` denies the account running the test,
    /// which is a member of it — so the recursive delete fails, and the idiom
    /// used everywhere else here (a discarded `let _ = …` around it) throws
    /// that failure away. The test stays green and leaves a directory in
    /// `%TEMP%` that its own author cannot delete. Thirty-three of them
    /// accumulated in under an hour before this existed, and clearing them by
    /// hand needed `icacls /reset /T` and a re-grant.
    ///
    /// Discarding the result of a cleanup is the same mistake as discarding the
    /// result of a check: it cannot fail, so it cannot tell you anything.
    #[cfg(windows)]
    fn reset_and_remove(root: &Path) {
        let _ = std::process::Command::new("icacls")
            .arg(root)
            .args(["/reset", "/T", "/C", "/Q"])
            .output();
        std::fs::remove_dir_all(root).unwrap_or_else(|error| {
            panic!(
                "the scratch tree at {} could not be removed ({error}); it will \
                 accumulate in %TEMP% on every run",
                root.display()
            )
        });
    }
}
