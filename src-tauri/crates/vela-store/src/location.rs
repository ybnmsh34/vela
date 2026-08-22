//! Where the database file lives.
//!
//! The location is **injected, never discovered**. The store has no opinion
//! about the OS and never calls a path API itself: the Tauri host resolves the
//! real per-user application-data directory
//! (`app.path().app_data_dir()` — see `src-tauri/src/store_host.rs`) and hands
//! the directory in, while tests hand in a `tempfile::TempDir` or ask for
//! [`DatabaseLocation::InMemory`]. That is what makes the whole data layer
//! testable headlessly with no filesystem assumptions.
//!
//! **Injected is not the same as unexamined.** The store has no opinion about
//! *where* the directory is; it has a firm one about *what must be true of it*.
//! It must be reachable by the account Vela is running as and by nobody else,
//! because it holds every conversation the user has ever had — and on the
//! Windows machine this was measured on it was not, having inherited a second
//! local group's read access from a parent under `%APPDATA%`. That is enforced
//! by `DatabaseLocation::prepare` on every launch, using the same
//! [`vela_privatefs`] the debug log uses, and it is the one thing here that is
//! deliberately *not* injectable — see `prepare_with`.

use std::path::{Path, PathBuf};

use crate::error::{StoreError, StoreResult};

/// The database file name inside the application-data directory. Changing it
/// orphans every existing user database, so treat it as a storage migration.
pub const DATABASE_FILE_NAME: &str = "vela.db";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DatabaseLocation {
    /// A private, per-connection database that vanishes when the connection is
    /// dropped. Tests only — nothing is persisted and WAL does not apply.
    InMemory,
    /// A real file on disk.
    File(PathBuf),
}

impl DatabaseLocation {
    /// `<dir>/vela.db`. The caller supplies the directory; on the desktop that
    /// is the OS application-data directory resolved by Tauri.
    pub fn in_directory(dir: impl AsRef<Path>) -> Self {
        Self::File(dir.as_ref().join(DATABASE_FILE_NAME))
    }

    pub fn path(&self) -> Option<&Path> {
        match self {
            Self::InMemory => None,
            Self::File(path) => Some(path.as_path()),
        }
    }

    pub fn is_in_memory(&self) -> bool {
        matches!(self, Self::InMemory)
    }

    /// Human-readable form for diagnostics. For a file it is the path, which is
    /// host-side information: do not forward it to the renderer.
    pub fn describe(&self) -> String {
        match self {
            Self::InMemory => "in-memory (not persisted)".to_string(),
            Self::File(path) => path.display().to_string(),
        }
    }

    /// Creates the containing directory if needed, **reachable by this account
    /// and nobody else**, and tightens the database files already in it.
    ///
    /// A first run on a clean machine has no application-data directory yet,
    /// and failing to open the database because of a missing parent would be a
    /// confusing first impression. Everything below is about the other case.
    ///
    /// # What must be private, and why the directory is nearly all of it
    ///
    /// The root, `vela.db`, `vela.db-wal`, `vela.db-shm`, and the `skills/`,
    /// `projects/` and `diagnostics/` subdirectories beside them.
    ///
    /// **The `-wal` is not a lesser file than the database.** It holds
    /// committed transactions that have not been checkpointed into the main
    /// file yet — conversation text under another name — which is a fact about
    /// how SQLite works and needs no measurement to support it. An earlier
    /// version of this sentence gave a size and called it un-checkpointed live
    /// data; that figure was copied from the audit rather than measured here,
    /// and the only object of that size in this project's own evidence is a
    /// `.pre-cleanup-` **backup**, which by definition is not live. Removed
    /// rather than corrected: no claim on this page needs a number to be true,
    /// and every candidate number came from a path that resolves into a
    /// container.
    ///
    /// Hardening the **root** covers most of that, for a reason worth stating
    /// precisely rather than approximately. Windows ACL inheritance is
    /// *static*: when `create_private_dir` protects a directory, the security
    /// system rewrites the **inherited portion** of every existing
    /// non-protected child's DACL at that moment, and stamps the same two ACEs
    /// onto every entry created afterwards. So `skills/` and `projects/` —
    /// which `vela-projects` creates with a plain `create_dir_all` — are born
    /// private, and so is each `-wal` SQLite spins up and throws away. This
    /// runs from `SqliteStore::open`, which the host calls **first** in
    /// `setup`, before the skill store, the project host or the diagnostics
    /// handle exist, so no entry created during a launch predates the
    /// protection.
    ///
    /// That claim is measured, not argued:
    /// `the_wal_and_shm_sqlite_creates_are_born_unreachable_by_anyone_else`
    /// opens a real database and reads the siblings' ACLs back off the disk.
    ///
    /// # Two things the root does not reach, and what does
    ///
    /// **An ACE a child carries explicitly.** "Inherited portion" is the whole
    /// of it: an ACE with `inherited=False` on a child is not inherited, so
    /// protecting the parent does not rewrite it and it survives — and keeps
    /// being handed down to everything created inside that child. This was
    /// measured, not predicted: a `skills/` holding an explicit
    /// `CodexSandboxUsers ReadAndExecute` kept it through a root hardening and
    /// propagated it onward. It is the shape any previous `icacls /grant`
    /// leaves behind. `vela_privatefs::repair_entries` walks for exactly this;
    /// what it does and does not cover is documented there.
    ///
    /// **A child with its own protected DACL**, which inheritance cannot reach
    /// by definition. `vela.db` and its siblings are therefore tightened
    /// individually: they are the files this crate owns across restarts, and a
    /// leaf protected in its own right cannot be widened tomorrow by widening
    /// the parent.
    ///
    /// # An existing installation is repaired, not merely accepted
    ///
    /// This is the case that matters, because it is the one that exists. The
    /// directory measured for the audit was already there, already full of
    /// conversations, and already carrying
    /// `CodexSandboxUsers ReadAndExecute (inherited)` from a parent under
    /// `%APPDATA%` that other software had widened. Vela did not create that
    /// ACE and cannot stop it being re-applied to `%APPDATA%` — it can only
    /// refuse to let it *reach in*, which is what
    /// `PROTECTED_DACL_SECURITY_INFORMATION` does. `create_private_dir` applies
    /// the same repair to an existing directory as to a new one and re-reads
    /// the result either way, so tightening on startup is not a side effect of
    /// creation; it is the point.
    ///
    /// # If it cannot be made private, the database is not opened
    ///
    /// **This stops startup.** It is the largest consequence anything in this
    /// crate reaches for, so here is the case for it and the case against.
    ///
    /// The case against is real. A user with three years of conversations, on a
    /// host where the DACL cannot be tightened — a domain policy that
    /// re-asserts inheritance, a roaming profile on a share, a volume with no
    /// ACL support at all — opens Vela and gets nothing. And refusing does not
    /// un-leak a byte: the transcripts are already on that disk, already
    /// readable by whoever could read them this morning. Vela declining to open
    /// them closes no window that is currently open. That argument deserves to
    /// be answered rather than waved past.
    ///
    /// It is answered on three counts.
    ///
    /// **The exposure that continuing would create is Vela's own.** The
    /// existing leak is not this crate's to undo, true. But every turn the user
    /// takes after startup writes *new* prompts and answers into that file, and
    /// that is entirely Vela's doing. If a debug log that silently stays
    /// readable is worse than no debug log — the reasoning `vela-privatefs` was
    /// built on — then the same reasoning applies with more force to the corpus
    /// the log is a sample of. Refusing does not fix the past; it declines to
    /// keep adding to it.
    ///
    /// **The two failure modes are not comparable in cost.** Harden-and-carry-on
    /// fails silently, permanently, and towards disclosure: a green light over a
    /// store another local account is reading, for as long as the user keeps
    /// using the app. Refusing fails loudly, immediately, and towards nothing
    /// disclosed — and it is reversible from a shell in one command. A
    /// mistake in the first direction is discovered by whoever reads the file.
    /// A mistake in the second is discovered by the user, at once, with the
    /// path and the offending principals named in the message.
    ///
    /// **It is not a new failure surface.** `prepare` could already abort
    /// startup: a directory that cannot be *created* has always been fatal
    /// here, and `store_host::open` has always documented refusing to start as
    /// the honest failure when there is no system of record. A directory that
    /// cannot be made *private* now joins it, through the same return value and
    /// the same call path. Nothing new was invented to carry this decision.
    ///
    /// The refusal is [`StoreError::NotPrivate`], separate from
    /// [`StoreError::Io`] so that *would not* is never read as *could not*, and
    /// it carries the reason `vela-privatefs` produced — which names the path,
    /// every principal that can reach it, and whether inheritance is disabled.
    /// That split is enforced by the `Failure` this crate matches on rather
    /// than by wording: a directory that cannot be *created* is still
    /// [`StoreError::Io`], because a name collision or a full disk is not a
    /// security decision and must not present as one.
    ///
    /// The user's data is untouched: nothing is moved, copied or deleted on
    /// this path, so backing it up or fixing the ACL by hand and relaunching
    /// are both available.
    ///
    /// # It has to reach the user
    ///
    /// A refusal nobody sees is indistinguishable from a crash, and on Windows
    /// a release build has no console: `main.rs` sets
    /// `windows_subsystem = "windows"`. Returning `Err` from here therefore
    /// only *starts* the job. `vela_lib::fatal` finishes it — `run()` reports
    /// any startup failure through a native message box before the process
    /// leaves, so the decision taken here is one the user is actually told
    /// about. Without that, refusing and crashing look the same from outside.
    pub(crate) fn prepare(&self) -> StoreResult<()> {
        self.prepare_with(vela_privatefs::create_private_dir_reporting)
    }

    /// [`Self::prepare`] with the directory hardening supplied by the caller.
    ///
    /// The seam exists for one reason, the same one
    /// `vela_privatefs::create_private_dir_with` exists for: what a caller does
    /// when the platform *cannot* deliver the promise has to be drivable
    /// without persuading a real machine to fail. Injecting a refusing enforcer
    /// is how `a_directory_that_cannot_be_made_private_is_refused_not_opened`
    /// shows that this returns `Err` and leaves no database behind.
    ///
    /// Production code calls [`Self::prepare`]. Note what is *not* injectable:
    /// the per-file tightening below, and the fact that a failure is fatal. The
    /// directory is injected because *which* directory is the caller's business
    /// — that is this crate's founding rule. What must be true of it is not,
    /// because an enforcement step a caller can forget is how the defect this
    /// repairs came to exist: `vela-privatefs` kept its promise perfectly, and
    /// was simply never called on this directory.
    pub(crate) fn prepare_with(
        &self,
        harden_dir: impl FnOnce(&Path) -> Result<(), vela_privatefs::Failure>,
    ) -> StoreResult<()> {
        let Self::File(path) = self else {
            return Ok(());
        };
        let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        else {
            return Ok(());
        };

        // Creates it if missing, repairs its DACL if it is not, and re-reads
        // the result off the filesystem before returning `Ok`.
        //
        // The two halves land on two different variants. A directory that
        // could not be *created* is the error it always was; only a directory
        // that exists and will not be *accepted* is a privacy refusal.
        harden_dir(parent).map_err(|failure| {
            let path = parent.display().to_string();
            match failure {
                vela_privatefs::Failure::Unreachable(error) => StoreError::Io {
                    path,
                    reason: error.to_string(),
                },
                vela_privatefs::Failure::NotPrivate(error) => StoreError::NotPrivate {
                    path,
                    reason: error.to_string(),
                },
            }
        })?;

        // Anything already inside that a foreign principal can still reach —
        // an ACE carried explicitly rather than inherited, which protecting the
        // parent does not rewrite. Nothing is touched unless the read-back says
        // it needs to be, so a healthy directory pays one `describe` per entry.
        //
        // The error names **the entry**, not this directory, and keeps the same
        // could-not/would-not split as the root. Collapsing either — reporting
        // the root's path for a fault three levels down, or calling a
        // directory-listing I/O error a privacy refusal — would undo, one call
        // site to the right, exactly what the two branches above are for.
        vela_privatefs::repair_entries(parent).map_err(entry_failure)?;

        // The files this crate owns across restarts, protected in their own
        // right rather than left to inherit. Only the ones already on disk: a
        // sibling SQLite has not created yet will inherit from the directory
        // above, which the read-back inside `harden_dir` has just confirmed is
        // protected.
        for sibling in self.sibling_files() {
            if !sibling.exists() {
                continue;
            }
            vela_privatefs::make_file_private(&sibling).map_err(|error| {
                StoreError::NotPrivate {
                    path: sibling.display().to_string(),
                    reason: error.to_string(),
                }
            })?;
        }
        Ok(())
    }

    /// The database file and the two SQLite keeps beside it.
    ///
    /// `-wal` holds committed transactions that have not been checkpointed into
    /// the main file yet, and `-shm` is its index. Both are conversation text
    /// under another name, which is why they are listed here rather than
    /// treated as scratch.
    fn sibling_files(&self) -> Vec<PathBuf> {
        let Self::File(path) = self else {
            return Vec::new();
        };
        let mut files = vec![path.clone()];
        for suffix in ["-wal", "-shm"] {
            let mut name = path.as_os_str().to_owned();
            name.push(suffix);
            files.push(PathBuf::from(name));
        }
        files
    }
}

/// A failure at one entry of the walk, in the store's own vocabulary.
///
/// Two things have to survive the translation, and both were lost when this was
/// an inline closure over the whole walk:
///
/// - **The path is the entry's**, never the directory the walk started from.
///   Reporting the root for a fault three levels down puts the wrong path in
///   front of the user and the wrong one into the `icacls` command they are
///   being invited to run.
/// - **The could-not / would-not split holds here too.** A directory-listing
///   fault and a refusal to accept an ACL are no more the same kind of event
///   one call site to the right than they are at the root.
fn entry_failure(entry: vela_privatefs::EntryFailure) -> StoreError {
    let path = entry.path.display().to_string();
    match entry.failure {
        vela_privatefs::Failure::Unreachable(error) => StoreError::Io {
            path,
            reason: error.to_string(),
        },
        vela_privatefs::Failure::NotPrivate(error) => StoreError::NotPrivate {
            path,
            reason: error.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_name_is_appended_to_the_injected_directory() {
        let location =
            DatabaseLocation::in_directory("/home/someone/.local/share/dev.vela.desktop");
        assert_eq!(
            location.path().unwrap(),
            Path::new("/home/someone/.local/share/dev.vela.desktop/vela.db")
        );
    }

    #[test]
    fn preparing_a_location_creates_a_missing_application_data_directory() {
        let root = tempfile::tempdir().unwrap();
        let nested = root.path().join("dev.vela.desktop").join("data");
        let location = DatabaseLocation::in_directory(&nested);

        assert!(!nested.exists());
        location.prepare().unwrap();
        assert!(nested.is_dir());
    }

    #[test]
    fn an_in_memory_location_touches_no_filesystem() {
        let location = DatabaseLocation::InMemory;
        assert!(location.is_in_memory());
        assert_eq!(location.path(), None);
        location.prepare().unwrap();
    }

    // -----------------------------------------------------------------------
    // Privacy. Every assertion below re-reads the path off the filesystem
    // through `vela_privatefs::describe` — the same reader `Get-Acl` and `stat`
    // agree with — rather than restating what `prepare` was asked to do.
    // -----------------------------------------------------------------------

    /// Widen a path so a principal that is not its owner can reach it: the
    /// state the audit measured, expressed in whatever the platform spells it
    /// in.
    ///
    /// Duplicated from `vela-privatefs`'s own tests on purpose. It is the
    /// *control* — the thing that makes the assertion after it mean something —
    /// and a control that a crate imports from the crate under test is a
    /// control that stops being independent the moment that crate is wrong.
    /// Ten lines of `icacls` is a cheap price for that.
    /// The SID [`widen`] grants: `BUILTIN\Users`. Named, because a control that
    /// only counts foreign principals cannot tell what this test did from what
    /// `%TEMP%` already does.
    #[cfg(windows)]
    const WIDENED_SID: &str = "S-1-5-32-545";

    #[cfg(windows)]
    fn widen(path: &Path) {
        let output = std::process::Command::new("icacls")
            .arg(path)
            .arg("/grant")
            .arg("*S-1-5-32-545:(OI)(CI)(RX)")
            .output()
            .expect("icacls must be present on Windows");
        assert!(
            output.status.success(),
            "could not widen {}: {}",
            path.display(),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(unix)]
    fn widen(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(path).unwrap().permissions();
        let mode = permissions.mode() & 0o7777;
        permissions.set_mode(mode | 0o055);
        std::fs::set_permissions(path, permissions).unwrap();
    }

    /// The post-condition on a clean machine: the directory Vela's database
    /// will sit in is reachable by this account and nobody else, and its DACL
    /// is not open to whatever a parent decides tomorrow.
    #[test]
    fn the_directory_prepare_creates_is_reachable_by_nobody_else() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("dev.vela.desktop");
        DatabaseLocation::in_directory(&data).prepare().unwrap();

        let report = vela_privatefs::describe(&data).unwrap();
        assert!(
            report.is_private(),
            "the directory holding every conversation is reachable by someone \
             else: {report:?}"
        );
    }

    /// **The audit finding, executed, and then repaired.**
    ///
    /// This is the case that actually exists on users' machines: the directory
    /// is already there, already holds a database, and already carries a
    /// foreign principal's read access inherited from a parent under
    /// `%APPDATA%`. Creating it is not the interesting half — repairing it is.
    ///
    /// What changes if the fix is absent: `after.foreign` stays non-empty. That
    /// is the same field, filled from the same real ACEs, that
    /// `DESKTOP-298M5DU\CodexSandboxUsers` showed up in on the machine the
    /// finding came from.
    #[test]
    fn an_existing_directory_a_non_owner_can_read_is_tightened_not_accepted() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("dev.vela.desktop");

        // The pre-fix body of `prepare`, verbatim, plus a database sitting in
        // it from previous launches.
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(data.join(DATABASE_FILE_NAME), b"SQLite format 3\0").unwrap();
        widen(&data);

        let before = vela_privatefs::describe(&data).unwrap();
        assert!(
            !before.foreign.is_empty(),
            "the control did not produce a directory a non-owner can reach, so \
             the assertion below would pass on anything: {before:?}"
        );

        DatabaseLocation::in_directory(&data).prepare().unwrap();

        let after = vela_privatefs::describe(&data).unwrap();
        assert!(
            after.is_private(),
            "an existing loose directory was accepted rather than tightened — \
             this is the audit finding, unfixed: {after:?}"
        );
    }

    /// The database file itself, not only the directory around it — and with
    /// every byte still in it. A "fix" that reached privacy by deleting the
    /// user's conversations would be a far worse bug than the one it closed,
    /// and only this asserts otherwise.
    #[test]
    fn an_existing_database_a_non_owner_can_read_is_tightened_without_losing_a_byte() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("dev.vela.desktop");
        std::fs::create_dir_all(&data).unwrap();

        let database = data.join(DATABASE_FILE_NAME);
        let wal = data.join(format!("{DATABASE_FILE_NAME}-wal"));
        std::fs::write(&database, b"conversation number one").unwrap();
        std::fs::write(&wal, b"conversation number two, not yet checkpointed").unwrap();
        widen(&database);
        widen(&wal);

        for path in [&database, &wal] {
            let before = vela_privatefs::describe(path).unwrap();
            assert!(
                !before.foreign.is_empty(),
                "control: {} was already private, so the assertion below proves \
                 nothing: {before:?}",
                path.display()
            );
        }

        DatabaseLocation::in_directory(&data).prepare().unwrap();

        for path in [&database, &wal] {
            let after = vela_privatefs::describe(path).unwrap();
            assert!(
                after.is_private(),
                "{} was left readable by another account: {after:?}",
                path.display()
            );
        }
        assert_eq!(
            std::fs::read(&database).unwrap(),
            b"conversation number one",
            "tightening destroyed the database"
        );
        assert_eq!(
            std::fs::read(&wal).unwrap(),
            b"conversation number two, not yet checkpointed",
            "tightening destroyed the write-ahead log"
        );
    }

    /// **The claim that hardening the root is most of the work, measured.**
    ///
    /// `skills/` and `projects/` are created by `vela-projects` with a plain
    /// `create_dir_all`, after `SqliteStore::open` has run. Nothing tightens
    /// them individually and nothing should have to: on Windows, inheritance
    /// from a protected parent is what makes them private, both for entries
    /// that already existed when the root was hardened and for entries created
    /// afterwards. This drives both halves and reads the ACLs back.
    ///
    /// Windows-only, because the mechanism is Windows-only. On unix a child's
    /// mode bits are its own — `create_dir_all` gives it whatever the umask
    /// says — and what protects the tree there is that nobody else can
    /// *traverse* a `0700` root to reach the child at all. Two different
    /// mechanisms, the same end; asserting the Windows one on unix would be
    /// asserting something false.
    #[cfg(windows)]
    #[test]
    fn the_subdirectories_beside_the_database_inherit_the_root_they_sit_in() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("dev.vela.desktop");

        // An existing installation: `skills/` is already there, and already
        // carries the inherited ACE the audit measured on it.
        std::fs::create_dir_all(data.join("skills")).unwrap();
        widen(&data);
        // **The principal `widen` grants, by name.** `!foreign.is_empty()` is
        // ambient-true here — a bare `create_dir_all` under `%TEMP%` already
        // reports three foreign principals — so deleting the `widen` above left
        // this control passing. `BUILTIN\Users` is not among what `%TEMP%`
        // hands down, so its arrival on `skills/` can only have come from
        // widening the parent, which is the propagation this test is about.
        let inherited = vela_privatefs::describe(&data.join("skills")).unwrap();
        assert!(
            inherited.foreign.iter().any(|who| who == WIDENED_SID),
            "control: `skills/` did not inherit {WIDENED_SID} from widening its \
             parent, so the propagation this test measures never happened: \
             {inherited:?}"
        );

        DatabaseLocation::in_directory(&data).prepare().unwrap();

        // Created afterwards, exactly as `vela-projects` creates them.
        std::fs::create_dir_all(data.join("projects")).unwrap();
        std::fs::create_dir_all(data.join("diagnostics")).unwrap();

        for child in ["skills", "projects", "diagnostics"] {
            let report = vela_privatefs::describe(&data.join(child)).unwrap();
            assert!(
                report.foreign.is_empty(),
                "`{child}` beside the database is reachable by another \
                 account: {report:?}"
            );
        }
    }

    /// **The gap protecting the root does not close, measured.**
    ///
    /// Protecting a directory rewrites the *inherited* portion of each existing
    /// child's DACL. An ACE a child carries **explicitly** is not inherited, so
    /// it survives — and keeps being handed down to everything created inside
    /// that child afterwards. This widens `skills/` **itself**, not the root,
    /// which is what makes it able to fail for that reason;
    /// `the_subdirectories_beside_the_database_inherit_the_root_they_sit_in`
    /// widens only the root and is structurally incapable of catching it.
    ///
    /// The file inside is created *after* the widening precisely so it is born
    /// carrying the foreign ACE by inheritance — the propagation half of the
    /// defect, not just the directory half.
    ///
    /// What changes if `repair_entries` is absent: both assertions fail with
    /// `CodexSandboxUsers` (here, `BUILTIN\Users`) still present.
    #[cfg(windows)]
    #[test]
    fn an_explicit_ace_on_a_subdirectory_is_removed_not_merely_out_voted() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("dev.vela.desktop");
        let skills = data.join("skills");
        std::fs::create_dir_all(&skills).unwrap();

        // Explicitly on the child. Nothing is done to the root.
        widen(&skills);
        let installed = skills.join("my-skill.md");
        std::fs::write(&installed, b"---\nname: my-skill\n---\n").unwrap();

        // **`foreign_explicit`, not `foreign`.** `tempfile::tempdir()` lands
        // under `%TEMP%`, which on this machine hands three foreign principals
        // to every directory created inside it — so `!foreign.is_empty()` is
        // ambient-true and establishes nothing about what `widen` did. With
        // that weaker precondition this test passed with `repair_entries`
        // fully neutered: it bit only because `widen` happens to grant a SID
        // `%TEMP%` does not, an accident it never asserted. The explicit,
        // non-inherited ACE is the thing under test and the thing protecting
        // the root cannot reach.
        let before = vela_privatefs::describe(&skills).unwrap();
        assert!(
            !before.foreign_explicit.is_empty(),
            "control: `skills/` carries no NON-INHERITED foreign ace, so the \
             case this test exists for — the one protecting the root does not \
             fix — was never set up: {before:?}"
        );
        let before_file = vela_privatefs::describe(&installed).unwrap();
        assert!(
            before_file
                .foreign
                .iter()
                .any(|who| before.foreign_explicit.contains(who)),
            "control: the file did not inherit the explicit ace from `skills/`, \
             so the propagation half is not under test: {before_file:?} vs \
             {before:?}"
        );

        DatabaseLocation::in_directory(&data).prepare().unwrap();

        let after = vela_privatefs::describe(&skills).unwrap();
        assert!(
            after.foreign.is_empty(),
            "an explicit foreign ACE on `skills/` survived hardening the root: \
             {after:?}"
        );
        let after_file = vela_privatefs::describe(&installed).unwrap();
        assert!(
            after_file.foreign.is_empty(),
            "the file `skills/` handed the ACE down to is still reachable by \
             another account: {after_file:?}"
        );
    }

    /// **A fault inside the walk names the entry, and keeps its kind.**
    ///
    /// Every error out of `repair_entries` used to become
    /// `NotPrivate { path: <the root> }` — so a directory-listing fault was reported
    /// as a privacy refusal, and a genuine refusal three levels down named the
    /// application-data directory instead of the file that could not be
    /// tightened. That is items 4 and 5 re-opened one call site to the right,
    /// and `a_directory_that_cannot_be_created_is_an_io_fault_not_a_privacy_refusal`
    /// does not cover it: it guards the create path only.
    #[test]
    fn a_fault_inside_the_walk_names_the_entry_and_keeps_its_kind() {
        let entry = std::path::PathBuf::from(r"C:\data\dev.vela.desktop\skills\my-skill.md");

        let io = entry_failure(vela_privatefs::EntryFailure {
            path: entry.clone(),
            failure: vela_privatefs::Failure::Unreachable(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "the directory listing failed",
            )),
        });
        match &io {
            StoreError::Io { path, .. } => assert_eq!(path, &entry.display().to_string()),
            other => panic!("a listing fault became a privacy refusal: {other:?}"),
        }

        let refusal = entry_failure(vela_privatefs::EntryFailure {
            path: entry.clone(),
            failure: vela_privatefs::Failure::NotPrivate(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "SetNamedSecurityInfoW failed",
            )),
        });
        match &refusal {
            StoreError::NotPrivate { path, .. } => {
                assert_eq!(
                    path,
                    &entry.display().to_string(),
                    "the refusal named a directory other than the entry that failed"
                );
            }
            other => panic!("a privacy refusal became an I/O fault: {other:?}"),
        }
    }

    /// **A disk fault must not present as a security decision.**
    ///
    /// `StoreError::NotPrivate` exists because `Io` means *could not* and this
    /// means *would not*. A directory that cannot be created at all — here a
    /// plain file sitting where the application-data directory belongs — is a
    /// genuine *could not*, and routing it through the privacy variant is the
    /// exact confusion that variant was invented to prevent.
    ///
    /// What changes if the classification collapses: this returns
    /// `NotPrivate { reason: "… Cannot create a file when that file already
    /// exists. (os error 183)" }`, telling the user their conversations are
    /// exposed when in fact a file is in the way.
    #[test]
    fn a_directory_that_cannot_be_created_is_an_io_fault_not_a_privacy_refusal() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("dev.vela.desktop");
        // Not a directory. `create_dir_all` cannot proceed and privacy never
        // enters into it.
        std::fs::write(&data, b"something else is already here").unwrap();

        let error = DatabaseLocation::in_directory(&data).prepare().unwrap_err();

        assert!(
            matches!(error, StoreError::Io { .. }),
            "a directory that could not be created was reported as a privacy \
             refusal: {error:?}"
        );
    }

    /// **The refusal names the accounts, not just the folder.**
    ///
    /// `prepare`'s own documentation promises the message carries "every
    /// principal that can reach it", and that is the half a user can act on —
    /// it is what turns the message into one `icacls` command. When the
    /// *enforcement* call failed rather than the verification, the error used
    /// to be a bare `SetNamedSecurityInfoW failed: Access is denied` naming
    /// nobody, so the promise was false on precisely the branch that matters.
    ///
    /// Driven through the seam with a hardener that fails the way a locked-down
    /// host fails, over a directory that genuinely has a foreign principal.
    #[cfg(windows)]
    #[test]
    fn a_refusal_names_the_accounts_that_can_still_reach_the_folder() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("dev.vela.desktop");

        let error = DatabaseLocation::in_directory(&data)
            .prepare_with(|path| {
                vela_privatefs::create_private_dir_with_reporting(path, |path| {
                    widen(path);
                    Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "SetNamedSecurityInfoW failed: Access is denied. (os error 5)",
                    ))
                })
            })
            .unwrap_err();

        let message = error.to_string();
        assert!(matches!(error, StoreError::NotPrivate { .. }), "{error:?}");
        assert!(
            message.contains("SetNamedSecurityInfoW"),
            "the underlying cause was dropped: {message}"
        );
        // The SID `widen` grants (`BUILTIN\Users`), which is the spelling
        // `describe` reports.
        //
        // **Asserted on the SID alone, deliberately.** The first version of
        // this accepted `message.contains("Users")` as an alternative, and that
        // made it vacuous: the path in the message is under
        // `C:\Users\…\Temp\…`, so the substring is present whether or not a
        // single principal was named. It passed with the principals removed.
        // A SID cannot appear by accident in a temp path.
        assert!(
            message.contains("S-1-5-32-545"),
            "the refusal names the folder but not the accounts that can reach \
             it, which is the half a user can act on: {message}"
        );
    }

    /// **The siblings SQLite creates on its own, measured on a real database.**
    ///
    /// `prepare` runs before any connection is opened, so the `-wal` and `-shm`
    /// carrying uncheckpointed conversation text are created by SQLite, after
    /// the fact, by code this crate does not control. Their privacy rests
    /// entirely on the root having been hardened first. Nothing about that is
    /// worth believing without reading it back off the disk.
    ///
    /// Note the quantity: `foreign`, not `is_private()`. A file that inherits
    /// from a protected parent is unreachable by anyone else *and* reports
    /// `inheritance_disabled: Some(false)`, because its safety is delegated
    /// rather than its own — see `vela_privatefs`' module docs.
    #[cfg(windows)]
    #[test]
    fn the_wal_and_shm_sqlite_creates_are_born_unreachable_by_anyone_else() {
        use crate::repository::{ConversationRepository, MessageRepository};
        use crate::{NewConversation, NewMessage, SqliteStore};

        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("dev.vela.desktop");
        std::fs::create_dir_all(&data).unwrap();
        widen(&data);

        let store = SqliteStore::open(DatabaseLocation::in_directory(&data)).unwrap();
        let chat = store
            .create_conversation(NewConversation::titled(
                "something the user would not say twice",
            ))
            .unwrap();
        store
            .append_message(NewMessage::user(
                chat.id.clone(),
                "and something they typed",
            ))
            .unwrap();

        let wal = data.join(format!("{DATABASE_FILE_NAME}-wal"));
        assert!(
            wal.is_file(),
            "no write-ahead log was created, so this test measured nothing"
        );

        for name in [
            DATABASE_FILE_NAME.to_owned(),
            format!("{DATABASE_FILE_NAME}-wal"),
            format!("{DATABASE_FILE_NAME}-shm"),
        ] {
            let path = data.join(&name);
            if !path.exists() {
                continue;
            }
            let report = vela_privatefs::describe(&path).unwrap();
            assert!(
                report.foreign.is_empty(),
                "`{name}` holds conversation text and is reachable by another \
                 account: {report:?}"
            );
        }
        drop(store);
    }

    /// **Failing closed, at the seam the whole decision turns on.**
    ///
    /// When the platform cannot make the directory private, `prepare` returns
    /// [`StoreError::NotPrivate`] — not `Io`, because *would not* is not
    /// *could not* — and `SqliteStore::open` never gets as far as a connection.
    /// No database file is left behind for a later launch to find and trust.
    ///
    /// What changes if the fix is absent: `prepare` returns `Ok`, the database
    /// opens over a directory nothing protected, and the user's conversations
    /// accumulate in a file another local account is reading.
    #[test]
    fn a_directory_that_cannot_be_made_private_is_refused_not_opened() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("dev.vela.desktop");
        let location = DatabaseLocation::in_directory(&data);

        let error = location
            .prepare_with(|path| {
                // What a locked-down host looks like from here: the directory
                // is creatable, and its ACL is not ours to set.
                std::fs::create_dir_all(path).map_err(vela_privatefs::Failure::Unreachable)?;
                Err(vela_privatefs::Failure::NotPrivate(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "SetNamedSecurityInfoW failed: Access is denied. (os error 5)",
                )))
            })
            .unwrap_err();

        match &error {
            StoreError::NotPrivate { path, reason } => {
                assert_eq!(path, &data.display().to_string());
                assert!(reason.contains("SetNamedSecurityInfoW"), "{reason}");
            }
            other => panic!("expected a privacy refusal, got {other:?}"),
        }
        assert!(
            !data.join(DATABASE_FILE_NAME).exists(),
            "a database was created at a path Vela had already refused"
        );
    }

    /// The refusal a user actually reads. It has to say which folder, and it
    /// has to say Vela declined rather than failed — those are different
    /// instructions to whoever has to fix it.
    #[test]
    fn the_refusal_names_the_folder_and_says_vela_declined_rather_than_failed() {
        let error = StoreError::NotPrivate {
            path: r"C:\Users\User\AppData\Roaming\dev.vela.desktop".into(),
            reason: "reachable by: DESKTOP-298M5DU\\CodexSandboxUsers".into(),
        };
        let message = error.to_string();
        assert!(message.contains(r"C:\Users\User\AppData\Roaming\dev.vela.desktop"));
        assert!(message.contains("did not open the database"));
        assert!(message.contains("CodexSandboxUsers"));
    }

    /// **The pre-fix `prepare`, driven through the fix's own wiring.**
    ///
    /// Its entire body was `create_dir_all` and no opinion about who could read
    /// the result. Injected as the hardening step, it succeeds — and the
    /// read-back inside `vela_privatefs` catches the directory anyway. Without
    /// that verification this call would return `Ok` over a directory a
    /// non-owner can read, which is precisely what shipped.
    #[test]
    fn create_dir_all_and_no_opinion_does_not_get_past_the_read_back() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("dev.vela.desktop");

        let error = DatabaseLocation::in_directory(&data)
            .prepare_with(|path| {
                vela_privatefs::create_private_dir_with_reporting(path, |path| {
                    // `location.rs:65` as it stood, plus the state the audit
                    // measured on a real machine.
                    std::fs::create_dir_all(path)?;
                    widen(path);
                    Ok(())
                })
            })
            .unwrap_err();

        assert!(
            matches!(error, StoreError::NotPrivate { .. }),
            "expected a privacy refusal, got {error:?}"
        );
        assert!(
            error.to_string().contains("could not be made private"),
            "{error}"
        );
    }
}
