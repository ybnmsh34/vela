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
pub mod store_host;

use state::AppState;

/// Registers the command allowlist. The `generate_handler!` list and
/// [`ipc::COMMAND_ALLOWLIST`] must agree — `cargo test` enforces it.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Scoped to this function so the module's import list stays as the scaffold
    // left it; `manage` needs the trait in scope.
    use tauri::Manager;

    tauri::Builder::default()
        .manage(AppState::for_runtime())
        // In-flight turn bookkeeping. Separate from `AppState` because it is
        // host-process state, not domain state.
        .manage(ipc::chat::ChatTurns::new())
        // Probe results for the current process. Not persisted on purpose: a
        // stale `vision: true` surviving a model swap would offer an affordance
        // the endpoint cannot serve, so a restart returns every model to
        // "nothing established".
        .manage(ipc::models::CapabilityCache::new())
        // The system of record. Opened here rather than in `AppState` because
        // the OS application-data directory is only resolvable once the app
        // handle exists. Migrations run inside this call; if it fails, startup
        // fails, because running without storage would accept the user's work
        // and then drop it.
        .setup(|app| {
            let store = store_host::open(app.handle())?;
            app.manage(store);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::app::app_info,
            ipc::chat::chat_cancel,
            ipc::chat::chat_send,
            ipc::diagnostics::diagnostics_echo,
            ipc::models::models_capabilities,
            ipc::models::models_list,
            ipc::models::models_probe,
            ipc::secrets::secrets_delete,
            ipc::secrets::secrets_set,
            ipc::secrets::secrets_status,
            ipc::settings::settings_delete_provider,
            ipc::settings::settings_get,
            ipc::settings::settings_put_provider,
            ipc::settings::settings_set_theme,
            ipc::store::store_autotitle_conversation,
            ipc::store::store_create_conversation,
            ipc::store::store_delete_conversation,
            ipc::store::store_list_conversations,
            ipc::store::store_rename_conversation,
            ipc::store::store_search,
            ipc::ui::ui_get_layout,
            ipc::ui::ui_set_layout,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Vela");
}
