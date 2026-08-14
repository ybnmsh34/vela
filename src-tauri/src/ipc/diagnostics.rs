//! `diagnostics_*` commands.
//!
//! `diagnostics_echo` is the canonical example of the command pattern and the
//! liveness probe the renderer uses to prove the bridge is up. It is also the
//! reference for how a command reports a rejected payload.
//!
//! # The debug-log switch, and the defect it closes
//!
//! [`vela_providers::debuglog`] keeps the raw upstream bytes behind an error,
//! locally and opt-in, and every rendered failure shows a correlation id that
//! joins the two. That was built, tested, and **never wired**:
//! `debuglog::enable` was called nowhere outside tests — no command, no
//! setting, no affordance — while `MessageTurn.tsx` printed `trace
//! 0000000000000002` on every failed turn. A pointer into a log the user has no
//! way to switch on is worse than no pointer, because it reads like something
//! they failed to find.
//!
//! [`debug_log_get`] and [`debug_log_set`] are that switch. What they carry is
//! deliberately thin:
//!
//! * **The status crosses the bridge. The log does not.** `DebugLogStatus` is
//!   `{enabled, path}` — a flag and a path on the user's own disk. No recorded
//!   body, no endpoint text, no correlation id. The property `diagnostic.rs`
//!   exists to hold — that endpoint-supplied text never rides an IPC response
//!   toward the renderer — is unchanged, and [`tests`] asserts it.
//! * **Enabling can fail, and a failure means off.** The log holds raw upstream
//!   bodies, so the directory it lives in has to be reachable by its owner and
//!   nobody else — `0700` on unix, an owner-and-`SYSTEM` DACL with inheritance
//!   disabled on Windows. [`vela_providers::private_fs`] applies that and then
//!   re-reads it off the filesystem; if what comes back is not private,
//!   [`debug_log_set`] returns an error naming the path and the log stays
//!   **off**. A debug log that silently stays readable by another account is
//!   worse than no debug log.
//! * **It does not persist.** Each launch starts with the log off. Vela's
//!   posture is offline-first with no telemetry, and a debug log that survives
//!   a restart is a file that grows for months after the session that needed
//!   it. Turning it on is a thing you do to the run you are debugging.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::State;
use vela_providers::{debuglog, private_fs};

use super::{EmptyPayload, IpcError, IpcResult};

/// Guard against a runaway renderer pushing unbounded strings across the
/// bridge. Every command that accepts free text must impose a bound.
pub const MAX_ECHO_BYTES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EchoReq {
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EchoRes {
    pub message: String,
    /// Host wall clock in milliseconds since the Unix epoch.
    pub received_at_ms: u64,
}

pub fn echo(req: EchoReq, now_ms: u64) -> IpcResult<EchoRes> {
    if req.message.is_empty() {
        return Err(IpcError::invalid("message must not be empty"));
    }
    if req.message.len() > MAX_ECHO_BYTES {
        return Err(IpcError::invalid(format!(
            "message exceeds {MAX_ECHO_BYTES} bytes"
        )));
    }
    Ok(EchoRes {
        message: req.message,
        received_at_ms: now_ms,
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn diagnostics_echo(payload: EchoReq) -> IpcResult<EchoRes> {
    echo(payload, now_ms())
}

// ---------------------------------------------------------------------------
// The debug log switch
// ---------------------------------------------------------------------------

/// Where this installation's debug log would be written.
///
/// Managed state rather than a field on [`crate::state::AppState`], for the
/// same reason [`crate::store_host::StoreHandle`] is: the application-data
/// directory is only resolvable once the app handle exists, which is after
/// `AppState` has been built.
#[derive(Clone)]
pub struct DebugLogHandle {
    path: PathBuf,
}

impl DebugLogHandle {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// `<app data dir>/diagnostics/exchanges.jsonl`.
    ///
    /// Its own subdirectory so that "delete the debug log" is a directory the
    /// user can remove without going near the database next to it.
    pub fn under_data_dir(data_dir: impl AsRef<Path>) -> Self {
        Self::new(data_dir.as_ref().join("diagnostics").join(LOG_FILE_NAME))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

pub const LOG_FILE_NAME: &str = "exchanges.jsonl";

/// What the renderer is told about the log: whether it is recording, and where
/// to look. **Never what it recorded** — see the module docs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugLogStatus {
    pub enabled: bool,
    /// The absolute path, shown so the user can open it with their own tools.
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugLogSetReq {
    pub enabled: bool,
}

fn status_of(handle: &DebugLogHandle) -> DebugLogStatus {
    DebugLogStatus {
        // Read from the module's own slot, not from a flag this file keeps.
        // Two copies of "is it on" is one copy too many, and the one that
        // matters is the one `record` consults.
        enabled: debuglog::is_enabled(),
        path: handle.path().display().to_string(),
    }
}

pub fn debug_log_get(handle: &DebugLogHandle, _req: EmptyPayload) -> IpcResult<DebugLogStatus> {
    Ok(status_of(handle))
}

/// Turn recording on or off.
///
/// Enabling creates the directory first: `FileSink` opens its file lazily and
/// swallows write failures by design — a full disk must not turn a 429 into a
/// panic — so a missing directory would otherwise leave the switch reporting
/// `enabled: true` over a log that never receives a line.
///
/// It is created **private** — `0700` on unix, an owner-and-`SYSTEM` DACL with
/// inheritance disabled on Windows — and the log inside it likewise. This file
/// is where the raw endpoint bodies go; it is precisely the one that must not
/// be readable by other accounts.
///
/// # Why this is one call into [`private_fs`] and not two implementations here
///
/// It used to be two. The `unix` arm set `0700`; the `#[cfg(not(unix))]` arm was
/// `create_dir_all` under a comment asserting *"the application-data directory
/// is already per-user, and nothing here widens it"*. The second clause is true
/// and the first was an assumption, and on this project's own Windows machine it
/// was false before Vela ever ran: `%APPDATA%\dev.vela.desktop\diagnostics` was
/// measured carrying an inherited `CodexSandboxUsers  ReadAndExecute` ACE, with
/// DACL inheritance enabled. A separate local group could read the directory
/// holding raw provider exchanges. [`private_fs`] is the one place that keeps
/// the promise on every platform, and — the part that matters — **reads the
/// result back off the filesystem** instead of trusting the request it just
/// made.
pub fn debug_log_set(handle: &DebugLogHandle, req: DebugLogSetReq) -> IpcResult<DebugLogStatus> {
    debug_log_set_with(handle, req, private_fs::create_private_dir)
}

/// [`debug_log_set`] with the directory step supplied by the caller.
///
/// The seam exists because the platform enforcement — a Win32 DACL, unix mode
/// bits — is the part a test cannot make fail on demand, while *the wiring
/// around it* is exactly what has to be proven: that a directory which cannot be
/// made private leaves the log **off** rather than on. Production passes
/// [`private_fs::create_private_dir`];
/// [`tests::the_log_stays_off_when_the_directory_cannot_be_made_private`] passes
/// [`private_fs::create_private_dir_with`] with an enforcer that refuses, and
/// its control passes the pre-fix body (`create_dir_all` and a shrug) and shows
/// the log coming up enabled over a directory nothing protected.
///
/// # Failing closed
///
/// On failure the sink is **removed**, not merely left uninstalled. A caller who
/// asks to enable the log and is told no must not be left recording into a path
/// this function has just refused to vouch for.
fn debug_log_set_with(
    handle: &DebugLogHandle,
    req: DebugLogSetReq,
    create_private_dir: impl FnOnce(&Path) -> std::io::Result<()>,
) -> IpcResult<DebugLogStatus> {
    if !req.enabled {
        debuglog::disable();
        return Ok(status_of(handle));
    }

    if let Some(parent) = handle.path().parent() {
        if let Err(error) = create_private_dir(parent) {
            debuglog::disable();
            return Err(IpcError::new(
                super::IpcErrorCode::Internal,
                format!(
                    "the debug log was not turned on: `{}` could not be made \
                     private on this machine ({error}). Vela will not write raw \
                     provider exchanges to a path another account can read.",
                    parent.display()
                ),
            ));
        }
    }
    debuglog::enable(Arc::new(debuglog::FileSink::new(handle.path())));
    Ok(status_of(handle))
}

#[tauri::command]
pub fn diagnostics_debug_log_get(
    handle: State<'_, DebugLogHandle>,
    payload: EmptyPayload,
) -> IpcResult<DebugLogStatus> {
    debug_log_get(&handle, payload)
}

#[tauri::command]
pub fn diagnostics_debug_log_set(
    handle: State<'_, DebugLogHandle>,
    payload: DebugLogSetReq,
) -> IpcResult<DebugLogStatus> {
    debug_log_set(&handle, payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::{IpcErrorCode, COMMAND_ALLOWLIST};

    /// `debuglog`'s sink slot is process-global, so the tests that move it run
    /// under one lock rather than racing each other into a flake that only ever
    /// appears on a busy machine.
    fn debug_log_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// **The defect this switch closes.** Before it existed,
    /// `debuglog::enable` had no caller outside the provider crate's own
    /// tests — no command, no setting, no affordance — while every failed turn
    /// in the UI printed a `trace` id pointing into it. This drives the switch
    /// the renderer now has, and asserts the log actually starts receiving the
    /// bytes the id refers to.
    #[test]
    fn the_switch_turns_the_log_on_and_off_and_the_log_then_records() {
        let _guard = debug_log_lock();
        let dir = tempfile::tempdir().unwrap();
        let handle = DebugLogHandle::under_data_dir(dir.path());
        debuglog::disable();

        // Off is the state a launch starts in, and the status says so while
        // still naming where the log would go.
        let off = debug_log_get(&handle, EmptyPayload {}).unwrap();
        assert!(!off.enabled);
        assert!(off.path.ends_with(LOG_FILE_NAME));
        assert!(!handle.path().exists(), "nothing is written until it is on");

        let on = debug_log_set(&handle, DebugLogSetReq { enabled: true }).unwrap();
        assert!(on.enabled);
        assert_eq!(on.path, off.path, "the path does not move when it is on");
        assert!(
            handle.path().parent().unwrap().is_dir(),
            "the directory is created eagerly; FileSink swallows write failures, \
             so a missing one would leave the switch claiming to record nothing"
        );

        // The join the UI's `trace <id>` promises: record an exchange, then
        // find it by the id the error showed.
        let correlation = vela_providers::diagnostic::CorrelationId::next();
        debuglog::record(|| debuglog::DebugEntryOwned {
            correlation,
            cause: vela_providers::diagnostic::Cause::CredentialRejected,
            status: Some(401),
            endpoint: None,
            body: b"the endpoint's own words".to_vec(),
        });
        let written = std::fs::read_to_string(handle.path()).unwrap();
        assert!(
            written.contains(&correlation.to_string()),
            "the correlation id the user is shown must be findable in the log"
        );
        assert!(written.contains("the endpoint's own words"));

        let off_again = debug_log_set(&handle, DebugLogSetReq { enabled: false }).unwrap();
        assert!(!off_again.enabled);
        assert!(!debuglog::is_enabled());

        let before = std::fs::read_to_string(handle.path()).unwrap();
        debuglog::record(|| debuglog::DebugEntryOwned {
            correlation: vela_providers::diagnostic::CorrelationId::next(),
            cause: vela_providers::diagnostic::Cause::CredentialRejected,
            status: Some(401),
            endpoint: None,
            body: b"must not be recorded".to_vec(),
        });
        assert_eq!(
            std::fs::read_to_string(handle.path()).unwrap(),
            before,
            "turning it off must actually stop the recording"
        );
    }

    /// Widen a path so a principal that is not its owner can read it — the state
    /// the desktop gate measured on `%APPDATA%\dev.vela.desktop\diagnostics`,
    /// expressed in whatever the platform spells it in.
    ///
    /// The control below needs this to be *deterministic*: `create_dir_all` in a
    /// temporary directory happens to produce a non-private directory on both
    /// platforms this ships on, but "happens to" is how a control quietly stops
    /// controlling for anything. This makes it so on purpose.
    #[cfg(unix)]
    fn widen(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(path).unwrap().permissions();
        let mode = permissions.mode() & 0o7777;
        permissions.set_mode(mode | 0o055);
        std::fs::set_permissions(path, permissions).unwrap();
    }

    /// `BUILTIN\Users` (`S-1-5-32-545`): a group that exists on every
    /// installation, is not the owner and is not `SYSTEM` — standing in for the
    /// `CodexSandboxUsers` ACE that was actually inherited on the measured
    /// machine.
    #[cfg(windows)]
    fn widen(path: &Path) {
        let out = std::process::Command::new("icacls")
            .arg(path)
            .arg("/grant")
            .arg("*S-1-5-32-545:(OI)(CI)(RX)")
            .output()
            .expect("icacls must be present on Windows");
        assert!(
            out.status.success(),
            "could not widen {}: {}",
            path.display(),
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// **The wiring the whole module exists for: a directory that cannot be made
    /// private leaves the log OFF.**
    ///
    /// The platform enforcement itself is unfakeable in a test — a Win32 DACL
    /// either applies or it does not — so it is injected through the seam
    /// `private_fs` publishes for exactly this. What is under test is everything
    /// around it: that `debug_log_set` propagates the refusal instead of
    /// swallowing it, that no sink is installed, that `debug_log_get` agrees,
    /// and that the user is told which path failed and why.
    ///
    /// Its control is
    /// [`the_pre_fix_body_lets_the_log_come_up_over_a_directory_nothing_protected`],
    /// and without that control this test proves nothing: a switch that refused
    /// to enable under every enforcer would pass it too.
    #[test]
    fn the_log_stays_off_when_the_directory_cannot_be_made_private() {
        let _guard = debug_log_lock();
        let dir = tempfile::tempdir().unwrap();
        let handle = DebugLogHandle::under_data_dir(dir.path());
        debuglog::disable();

        let error = debug_log_set_with(&handle, DebugLogSetReq { enabled: true }, |path| {
            // The enforcement step refusing: `SetNamedSecurityInfoW` denied on
            // Windows, `chmod` refused on a filesystem with no mode bits.
            private_fs::create_private_dir_with(path, |_| {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "SetNamedSecurityInfoW failed: Access is denied. (os error 5)",
                ))
            })
        })
        .unwrap_err();

        assert!(
            !debuglog::is_enabled(),
            "the directory could not be made private and the log was turned on \
             anyway — every prompt and answer in the session goes to a path \
             another account can read"
        );
        assert!(
            !debug_log_get(&handle, EmptyPayload {}).unwrap().enabled,
            "the switch reports `enabled: true` after refusing to enable"
        );

        assert_eq!(error.code, IpcErrorCode::Internal);
        let parent = handle.path().parent().unwrap().display().to_string();
        assert!(
            error.message.contains(&parent),
            "the refusal does not name the path that failed, so the user \
             cannot act on it: {}",
            error.message
        );
        assert!(
            error.message.contains("SetNamedSecurityInfoW"),
            "the refusal does not say why: {}",
            error.message
        );

        // And nothing was installed that could receive a line.
        debuglog::record(|| debuglog::DebugEntryOwned {
            correlation: vela_providers::diagnostic::CorrelationId::next(),
            cause: vela_providers::diagnostic::Cause::CredentialRejected,
            status: Some(401),
            endpoint: None,
            body: b"must not be recorded".to_vec(),
        });
        assert!(
            !handle.path().exists(),
            "a log file was written under a directory that could not be secured"
        );
    }

    /// **The control for the test above, and the defect it closes.**
    ///
    /// The `#[cfg(not(unix))]` body as it shipped was `create_dir_all` and a
    /// comment assuming the OS had already made the directory private. Injected
    /// as the directory step, it succeeds, and the switch comes up **enabled**
    /// over a directory a principal that is not the owner can read — measured
    /// through the same reader `Get-Acl` and `stat` answer from a shell, not
    /// asserted about the request that was made.
    ///
    /// Without this, the test above would pass on a `debug_log_set` that had
    /// been broken into never enabling at all.
    #[test]
    fn the_pre_fix_body_lets_the_log_come_up_over_a_directory_nothing_protected() {
        let _guard = debug_log_lock();
        let dir = tempfile::tempdir().unwrap();
        let handle = DebugLogHandle::under_data_dir(dir.path());
        let diagnostics = handle.path().parent().unwrap().to_path_buf();
        debuglog::disable();

        let status = debug_log_set_with(&handle, DebugLogSetReq { enabled: true }, |path| {
            // The pre-fix body, verbatim, plus the state the desktop gate
            // measured on a real machine.
            std::fs::create_dir_all(path)?;
            widen(path);
            Ok(())
        })
        .unwrap();

        assert!(
            status.enabled,
            "the control did not enable the log, so the test above is not \
             distinguishing a refusal from a switch that never turns on"
        );
        assert!(debuglog::is_enabled());

        let report = private_fs::describe(&diagnostics).unwrap();
        assert!(
            !report.is_private(),
            "the control did not produce a directory a non-owner can reach, so \
             it is not controlling for anything: {report:?}"
        );
        debuglog::disable();
    }

    /// **The fix, measured on whatever platform is running this.**
    ///
    /// Not `#[cfg(unix)]`: the defect was a Windows one, and a guard that only
    /// runs where the bug was not is how it survived. `describe` reads mode bits
    /// on unix and the real ACEs on Windows, so this asserts the same sentence
    /// in both places — nobody but the owner can reach the directory holding raw
    /// provider exchanges.
    #[test]
    fn turning_the_log_on_tightens_a_directory_another_account_could_read() {
        let _guard = debug_log_lock();
        let dir = tempfile::tempdir().unwrap();
        let handle = DebugLogHandle::under_data_dir(dir.path());
        let diagnostics = handle.path().parent().unwrap().to_path_buf();
        debuglog::disable();

        // An earlier run — or an earlier build — left one behind, loose.
        std::fs::create_dir_all(&diagnostics).unwrap();
        widen(&diagnostics);
        let before = private_fs::describe(&diagnostics).unwrap();
        assert!(!before.is_private(), "control: {before:?}");

        let status = debug_log_set(&handle, DebugLogSetReq { enabled: true }).unwrap();
        assert!(status.enabled);

        let after = private_fs::describe(&diagnostics).unwrap();
        assert!(
            after.is_private(),
            "the real switch accepted a diagnostics directory another account \
             can read: {after:?}"
        );
        assert!(after.foreign.is_empty(), "{after:?}");
        assert_ne!(after.inheritance_disabled, Some(false), "{after:?}");
        debuglog::disable();
    }

    #[cfg(unix)]
    fn mode_of(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    /// **The directory the log lives in must not be listable by other accounts
    /// either.** `create_dir_all` under the default umask makes `0755`, and a
    /// `0700` file inside a `0755` directory still tells everyone on the
    /// machine that this user is debugging their endpoint, and when.
    ///
    /// Measured, not reasoned about: this reads the mode off the real
    /// directory the real switch created.
    #[cfg(unix)]
    #[test]
    fn turning_the_log_on_creates_a_private_directory() {
        let _guard = debug_log_lock();
        let dir = tempfile::tempdir().unwrap();
        let handle = DebugLogHandle::under_data_dir(dir.path());

        debug_log_set(&handle, DebugLogSetReq { enabled: true }).unwrap();
        let created = handle.path().parent().unwrap();
        assert_eq!(
            mode_of(created),
            0o700,
            "the diagnostics directory is listable by every account on the machine"
        );

        // And the log inside it, once something is recorded — the two bits
        // together are the property, and either one alone is not.
        debuglog::record(|| debuglog::DebugEntryOwned {
            correlation: vela_providers::diagnostic::CorrelationId::next(),
            cause: vela_providers::diagnostic::Cause::CredentialRejected,
            status: Some(401),
            endpoint: None,
            body: b"the endpoint's own words".to_vec(),
        });
        assert_eq!(mode_of(handle.path()), 0o600);
        debuglog::disable();
    }

    /// An earlier run — or an earlier build — left a `0755` directory behind.
    /// Turning the switch on has to fix it, because the user has no way to know
    /// it is there and no reason to expect they must.
    #[cfg(unix)]
    #[test]
    fn an_existing_loose_directory_is_tightened() {
        use std::os::unix::fs::PermissionsExt;

        let _guard = debug_log_lock();
        let dir = tempfile::tempdir().unwrap();
        let handle = DebugLogHandle::under_data_dir(dir.path());
        let diagnostics = handle.path().parent().unwrap().to_path_buf();
        std::fs::create_dir_all(&diagnostics).unwrap();
        std::fs::set_permissions(&diagnostics, std::fs::Permissions::from_mode(0o755)).unwrap();

        debug_log_set(&handle, DebugLogSetReq { enabled: true }).unwrap();

        assert_eq!(
            mode_of(&diagnostics),
            0o700,
            "a diagnostics directory from an earlier run kept its loose mode"
        );
        debuglog::disable();
    }

    /// The status is reported from `debuglog`'s own slot, so it cannot claim
    /// the log is on while nothing is installed to receive a line.
    #[test]
    fn the_reported_state_is_the_real_one_not_a_second_copy() {
        let _guard = debug_log_lock();
        let dir = tempfile::tempdir().unwrap();
        let handle = DebugLogHandle::under_data_dir(dir.path());

        debug_log_set(&handle, DebugLogSetReq { enabled: true }).unwrap();
        assert!(debuglog::is_enabled());

        // Something else in the process turns it off — the status follows the
        // module, not a flag this file remembers.
        debuglog::disable();
        assert!(!debug_log_get(&handle, EmptyPayload {}).unwrap().enabled);
    }

    /// The security property `diagnostic.rs` exists to hold. The switch may
    /// cross the bridge; what the log holds may not.
    #[test]
    fn no_debug_log_response_can_carry_what_the_log_recorded() {
        let _guard = debug_log_lock();
        let dir = tempfile::tempdir().unwrap();
        let handle = DebugLogHandle::under_data_dir(dir.path());
        debug_log_set(&handle, DebugLogSetReq { enabled: true }).unwrap();
        debuglog::record(|| debuglog::DebugEntryOwned {
            correlation: vela_providers::diagnostic::CorrelationId::next(),
            cause: vela_providers::diagnostic::Cause::CredentialRejected,
            status: Some(401),
            endpoint: None,
            body: b"UPSTREAM-CANARY-DO-NOT-SHIP".to_vec(),
        });

        for response in [
            serde_json::to_string(&debug_log_get(&handle, EmptyPayload {}).unwrap()).unwrap(),
            serde_json::to_string(
                &debug_log_set(&handle, DebugLogSetReq { enabled: false }).unwrap(),
            )
            .unwrap(),
        ] {
            assert!(
                !response.contains("UPSTREAM-CANARY"),
                "a diagnostics response carried endpoint-supplied text: {response}"
            );
        }
        debuglog::disable();
    }

    /// The pointer and the switch have to arrive together. A renderer that can
    /// read the flag but not set it cannot honour the `trace` id it prints.
    #[test]
    fn both_halves_of_the_switch_are_reachable_from_the_renderer() {
        for name in ["diagnostics_debug_log_get", "diagnostics_debug_log_set"] {
            assert!(
                COMMAND_ALLOWLIST.contains(&name),
                "`{name}` is not on the allowlist, so the renderer cannot call it"
            );
        }
    }

    #[test]
    fn echoes_the_message_and_stamps_it() {
        let res = echo(
            EchoReq {
                message: "bridge up".into(),
            },
            1_700_000_000_000,
        )
        .unwrap();
        assert_eq!(res.message, "bridge up");
        assert_eq!(res.received_at_ms, 1_700_000_000_000);
    }

    #[test]
    fn rejects_empty_and_oversized_payloads_with_invalid_payload() {
        let empty = echo(
            EchoReq {
                message: String::new(),
            },
            0,
        )
        .unwrap_err();
        assert_eq!(empty.code, IpcErrorCode::InvalidPayload);

        let huge = echo(
            EchoReq {
                message: "x".repeat(MAX_ECHO_BYTES + 1),
            },
            0,
        )
        .unwrap_err();
        assert_eq!(huge.code, IpcErrorCode::InvalidPayload);
    }
}
