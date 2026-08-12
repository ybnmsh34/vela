//! # vela-app
//!
//! The Tauri host process. This crate is intentionally thin: it owns the IPC
//! boundary, window creation, and process state — nothing else. All domain
//! logic lives in `crates/vela-core`, `crates/vela-secrets` and
//! `crates/vela-providers` so that it is testable without a windowing system.
//!
//! The renderer's only power is the command allowlist in [`ipc`]. Tauri
//! capabilities (`capabilities/main.json`) grant nothing beyond window chrome
//! and the event channel: no `fs`, no `shell`, no `http`, no `process`.

pub mod ipc;
pub mod state;

use state::AppState;

/// Registers the command allowlist. The `generate_handler!` list and
/// [`ipc::COMMAND_ALLOWLIST`] must agree — `cargo test` enforces it.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::for_runtime())
        .invoke_handler(tauri::generate_handler![
            ipc::app::app_info,
            ipc::diagnostics::diagnostics_echo,
            ipc::secrets::secrets_delete,
            ipc::secrets::secrets_set,
            ipc::secrets::secrets_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Vela");
}
