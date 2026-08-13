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
//! * **It does not persist.** Each launch starts with the log off. Vela's
//!   posture is offline-first with no telemetry, and a debug log that survives
//!   a restart is a file that grows for months after the session that needed
//!   it. Turning it on is a thing you do to the run you are debugging.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::State;
use vela_providers::debuglog;

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

/// Create the directory the log lives in, reachable by its owner and nobody
/// else.
///
/// # Why not `create_dir_all`
///
/// Because that is `0755` under the ordinary `0022` umask, and a `0600` log
/// inside a world-listable directory still publishes its name, its size and its
/// timestamps to every account on the machine — which is to say, that this user
/// is debugging their endpoint and when they were doing it. The file's own mode
/// is set where the file is opened (`vela_providers::debuglog`); this is the
/// other half, and neither half is the property on its own.
///
/// An existing directory is tightened rather than accepted: it may have been
/// created by an earlier run, or by a build from before this rule.
#[cfg(unix)]
fn create_private_dir(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    let mut permissions = std::fs::metadata(path)?.permissions();
    if permissions.mode() & 0o077 != 0 {
        permissions.set_mode(0o700);
        std::fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

/// Windows: the application-data directory is already per-user, and nothing
/// here widens it. See the `unix` sibling for what this is protecting.
#[cfg(not(unix))]
fn create_private_dir(path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)
}

/// Turn recording on or off.
///
/// Enabling creates the directory first: `FileSink` opens its file lazily and
/// swallows write failures by design — a full disk must not turn a 429 into a
/// panic — so a missing directory would otherwise leave the switch reporting
/// `enabled: true` over a log that never receives a line.
///
/// It is created **private** (`0700`), and the log inside it is opened `0600`.
/// This file is where the raw endpoint bodies go; it is precisely the one that
/// must not be readable by other accounts.
pub fn debug_log_set(handle: &DebugLogHandle, req: DebugLogSetReq) -> IpcResult<DebugLogStatus> {
    if !req.enabled {
        debuglog::disable();
        return Ok(status_of(handle));
    }

    if let Some(parent) = handle.path().parent() {
        create_private_dir(parent).map_err(|error| {
            IpcError::new(
                super::IpcErrorCode::Internal,
                format!(
                    "could not create the debug log directory `{}`: {error}",
                    parent.display()
                ),
            )
        })?;
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
