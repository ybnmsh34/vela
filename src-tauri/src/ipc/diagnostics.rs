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

/// Turn recording on or off.
///
/// Enabling creates the directory first: `FileSink` opens its file lazily and
/// swallows write failures by design — a full disk must not turn a 429 into a
/// panic — so a missing directory would otherwise leave the switch reporting
/// `enabled: true` over a log that never receives a line.
pub fn debug_log_set(handle: &DebugLogHandle, req: DebugLogSetReq) -> IpcResult<DebugLogStatus> {
    if !req.enabled {
        debuglog::disable();
        return Ok(status_of(handle));
    }

    if let Some(parent) = handle.path().parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
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
