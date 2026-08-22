//! `sandbox_*` — submitting, approving, cancelling and releasing a confined run.
//!
//! # Shape
//!
//! The same two-channel split `chat.rs` uses, for the same reason. `sandbox_submit`
//! validates the payload, registers the run and returns; everything the run has
//! to say arrives on the `sandbox:event` channel. A submit at permission level
//! `ask` sits waiting for a person for as long as the person takes, and holding
//! an IPC call open for that is not a thing to do.
//!
//! **"Validates the payload" is the whole payload and not just `runId`.** This
//! function checks the one field it can check without the host — a blank
//! `runId` — and [`vela_sandbox::host::SandboxHost::submit`] runs the admission
//! decision synchronously before it spawns anything, so every malformed shape
//! the decision knows about (a materialisation this host does not serve, a
//! `hostPath` that does not resolve, a program past the size this host can
//! carry, a `guestPath` that is not one) rejects this invoke with
//! `INVALID_PAYLOAD`. None of them settles the run: `HostFailureReason` is
//! "nobody's request being wrong", and a caller told `internal` for a directory
//! they misspelled goes looking for a bug in Vela.
//!
//! Because events can be emitted before `invoke`'s promise settles, the
//! **caller** mints `runId`, exactly as the renderer mints `turnId`. A run id
//! already in flight rejects the invoke rather than settling the run — pushing a
//! refusal onto that id's stream would tell a different caller their healthy run
//! had failed.
//!
//! # Where the host is built
//!
//! In [`sandbox_host`], on first use, and not in the composition root: the
//! backend probe asks Windows which WSL distributions exist, which costs about
//! half a second, and a desktop app should not spend it on a launch where
//! nobody runs anything. The protected roots are resolved from the same
//! app-data directory the store uses, which is why the handle is threaded
//! through rather than read from the environment.
//!
//! # What this module does not do
//!
//! It does not read the program. There is no allowlist, no blocklist, no static
//! analysis and no place to put one; [`vela_sandbox::admission`] decides from
//! the request alone. See that module and `docs/references/unsloth-studio.md`
//! for what the other approach costs.

use std::sync::{Arc, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use vela_sandbox::contract::{
    PermissionLevel, SandboxApproveReq, SandboxCancelReq, SandboxCancelRes, SandboxEventEnvelope,
    SandboxPolicySnapshot, SandboxReleaseReq, SandboxReportDocumentReq, SandboxSubmitReq,
    SandboxSubmitRes, SANDBOX_EVENT,
};
use vela_sandbox::{
    default_auto_approval_profile, protected_paths_for_this_machine, SandboxConfig,
    SandboxEventSink, SandboxHost, WslBackend, DEFAULT_PROJECT_ID, HOST_CEILINGS,
};

use super::{Ack, IpcError, IpcResult};

/// The most runs Vela will hold at once.
///
/// Every admitted run owns a launcher process and two reader threads until it is
/// released, so this bounds threads as much as it bounds confusion.
const MAX_CONCURRENT_RUNS: u32 = 4;

/// Lazily-built sandbox host. Managed by the composition root; filled on the
/// first sandbox command.
#[derive(Default)]
pub struct SandboxState {
    host: OnceLock<Arc<SandboxHost>>,
}

impl SandboxState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Emits one `sandbox:event` per envelope, verbatim.
struct WindowSink<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> SandboxEventSink for WindowSink<R> {
    fn emit(&self, envelope: SandboxEventEnvelope) {
        let _ = self.app.emit(SANDBOX_EVENT, &envelope);
    }
}

fn sandbox_host<R: Runtime>(app: &AppHandle<R>, state: &SandboxState) -> Arc<SandboxHost> {
    Arc::clone(state.host.get_or_init(|| {
        let app_data = app.path().app_data_dir().ok();
        let config = SandboxConfig {
            // **Host-held, and `ask` until a settings surface writes it.** No
            // request can raise it; nothing in this build lowers it either, and
            // saying so here is better than a settings row nothing reads.
            permission: PermissionLevel::Ask,
            profile: default_auto_approval_profile(),
            known_projects: vec![DEFAULT_PROJECT_ID.to_string()],
            protected: protected_paths_for_this_machine(
                app_data.clone(),
                std::env::current_exe()
                    .ok()
                    .and_then(|exe| exe.parent().map(std::path::Path::to_path_buf)),
            ),
            app_data_dir: app_data,
            ceilings: HOST_CEILINGS,
            maximum_concurrent_runs: MAX_CONCURRENT_RUNS,
        };
        Arc::new(SandboxHost::new(
            config,
            WslBackend::detect(),
            Arc::new(WindowSink { app: app.clone() }),
        ))
    }))
}

/// `Ack`'s sandbox-shaped twin. Commands never return `void` or a bare scalar.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxAck {
    pub ok: bool,
}

#[tauri::command]
pub fn sandbox_policy<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SandboxState>,
    payload: super::EmptyPayload,
) -> IpcResult<SandboxPolicySnapshot> {
    let _ = payload;
    Ok(sandbox_host(&app, &state).policy())
}

#[tauri::command]
pub fn sandbox_submit<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SandboxState>,
    payload: SandboxSubmitReq,
) -> IpcResult<SandboxSubmitRes> {
    if payload.run_id.trim().is_empty() {
        return Err(IpcError::invalid("invalid runId: must not be blank"));
    }
    sandbox_host(&app, &state)
        .submit(payload)
        .map_err(|error| IpcError::invalid(error.0))
}

#[tauri::command]
pub fn sandbox_approve<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SandboxState>,
    payload: SandboxApproveReq,
) -> IpcResult<Ack> {
    sandbox_host(&app, &state)
        .approve(payload)
        .map(|()| Ack { ok: true })
        .map_err(|error| IpcError::invalid(error.0))
}

#[tauri::command]
pub fn sandbox_cancel<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SandboxState>,
    payload: SandboxCancelReq,
) -> IpcResult<SandboxCancelRes> {
    Ok(sandbox_host(&app, &state).cancel(payload))
}

#[tauri::command]
pub fn sandbox_release<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SandboxState>,
    payload: SandboxReleaseReq,
) -> IpcResult<Ack> {
    sandbox_host(&app, &state).release(payload);
    Ok(Ack { ok: true })
}

/// The one command that runs renderer-to-host rather than host-to-renderer.
///
/// It exists because a browser boundary is enforced where the browser is, and
/// the alternative was a document event stream with no producer. **It is not a
/// trust boundary**: the report comes from Vela's own renderer, and the host
/// cannot check it. This build accepts no document run, so every report is about
/// a run that does not exist and is dropped — which is what the contract already
/// says to do with a report for a run the host has settled.
#[tauri::command]
pub fn sandbox_report_document<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SandboxState>,
    payload: SandboxReportDocumentReq,
) -> IpcResult<Ack> {
    sandbox_host(&app, &state).report_document(payload);
    Ok(Ack { ok: true })
}
