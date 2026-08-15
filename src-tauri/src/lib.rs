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

pub mod endpoint_host;
pub mod ipc;
pub mod provider_host;
pub mod scheduler_host;
pub mod state;
pub mod store_host;

use state::AppState;

/// **The composition root, as a function.**
///
/// `run()` is `configure(...).run(context)` and nothing else, so there is
/// exactly one description of how this application is assembled — the state it
/// manages, the startup work in `setup`, and the command allowlist.
///
/// It is a function rather than a block inside `run()` for one reason: `run()`
/// takes over the calling thread and needs a windowing system, so nothing could
/// ever execute it under test, and the assembly went unverified for the whole
/// project while 1455 assertions passed against bridges and examples. Generic
/// over the runtime so `tests/gate_m_assembled_app.rs` can build **this** code
/// on `tauri::test::mock_runtime` and drive the real commands through the real
/// `invoke_handler`.
///
/// **The `generate_handler!` list below is the only list that decides what the
/// packaged binary will answer.** [`ipc::COMMAND_ALLOWLIST`] is a declaration;
/// this is the dispatch table. A command in one and not the other is either
/// unreachable in the shipped app or reachable without ever being declared.
///
/// `tests/handler_binding.rs` enforces that they agree, and does it by building
/// **this** function on the mock runtime and asking the assembled
/// `invoke_handler` about each command by name — not by reading this file for
/// the answer. Until that file existed, this comment claimed an enforcement
/// that did not exist, and was believed.
pub fn configure<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    // Scoped to this function so the module's import list stays as the scaffold
    // left it; `manage` needs the trait in scope.
    use tauri::Manager;

    builder
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

            // THE COMPOSITION ROOT. Configuration in the database becomes live
            // provider objects here and only here. Without this call the
            // registry stays empty for the whole life of the process, the UI
            // draws every configured endpoint as ready, and every turn comes
            // back `NOT_FOUND` — which is precisely what the packaged
            // application did before this line existed.
            //
            // A provider that cannot be built does not stop startup: the report
            // records it per-id and the endpoints that do build keep working.
            // A failure to *read* settings does stop startup, for the same
            // reason a failed migration does.
            let report = app
                .state::<AppState>()
                .providers
                .sync_from_settings(store.store())?;
            for (id, error) in &report.failed {
                eprintln!("vela: provider `{id}` is configured but unusable: {error}");
            }

            // Where the opt-in debug log would write, resolved here for the
            // same reason the database is. The log itself stays **off** — this
            // only makes the switch addressable, and `diagnostics_debug_log_set`
            // is the only thing that turns it on. Before this line the switch
            // had no caller anywhere in the application, while every failed turn
            // in the UI printed a `trace` id pointing into it.
            app.manage(ipc::diagnostics::DebugLogHandle::under_data_dir(
                app.path().app_data_dir()?,
            ));

            // The user's MCP servers, read from the same directory. Reading the
            // file is all that happens here: a server is a child process, and
            // one is spawned on the first `mcp_list_tools` rather than at
            // startup, so a machine with four configured servers does not
            // launch four processes to draw a window. An unreadable file does
            // not stop startup — see `McpHost`.
            app.manage(ipc::mcp::McpHost::under_data_dir(
                app.path().app_data_dir()?,
            ));

            // The canonical skill store, created **empty, here, before any
            // command that reads it is served**. That ordering is what
            // `src/platform/contract-project.ts` requires and it has exactly
            // one observable consequence worth stating: on a machine with no
            // skills installed, `skills_list` answers with an empty list and
            // every enabled skill would mount unavailable — not an error, not a
            // refused command. A host that instead created the directory lazily
            // inside whichever command happened to run first would produce a
            // different sentence in the UI for the same disk.
            //
            // A failure to create it does **not** stop startup, unlike a
            // failure to open the database. An absent store is an empty store,
            // which is a state the contract defines and every caller already
            // handles; the database has no such reading, because running
            // without a system of record accepts the user's work and drops it.
            let (skills, skills_failure) =
                ipc::skills::SkillsHandle::under_data_dir(app.path().app_data_dir()?);
            if let Some(error) = skills_failure {
                eprintln!("vela: the skill store could not be created: {error}");
            }
            app.manage(skills);

            // Scheduling, in the two steps it takes.
            //
            // The repair first: a run row still marked `running` is what
            // `due_schedules` reads as "still working", so a process that died
            // mid-run would wedge that schedule forever. Reaping has to happen
            // before the first poll, which is why it is a separate call and not
            // something the loop does on its way round.
            //
            // Then the loop. It sleeps a full interval before its first poll,
            // so nothing fires while the window is still being drawn. What a
            // fired schedule does — spawn a conversation, record a run, move to
            // its next slot — is `vela_store::poll_once`; nothing about it
            // depends on a real clock, which is how it is tested without
            // waiting an hour.
            scheduler_host::reap_on_boot(store.store());
            scheduler_host::spawn(store.shared());

            // THE DUAL LOCAL ENDPOINT. Off unless `VELA_LOCAL_ENDPOINT` names
            // an address, and refused rather than defaulted if the key or the
            // provider is missing — see `endpoint_host`. It is started after
            // the provider sync above because it serves one of those providers,
            // and it is `manage`d rather than dropped because `ServerHandle`'s
            // `Drop` stops the listener: a handle nobody holds is a port that
            // closes the moment startup returns.
            let endpoint = endpoint_host::start_if_configured(
                &endpoint_host::ProcessEnv,
                std::sync::Arc::clone(&app.state::<AppState>().providers),
            );
            eprintln!("{}", endpoint.summary());
            app.manage(endpoint);

            app.manage(store);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::app::app_info,
            ipc::chat::chat_cancel,
            ipc::chat::chat_send,
            ipc::diagnostics::diagnostics_debug_log_get,
            ipc::diagnostics::diagnostics_debug_log_set,
            ipc::diagnostics::diagnostics_echo,
            ipc::mcp::mcp_list_tools,
            ipc::models::models_capabilities,
            ipc::models::models_list,
            ipc::models::models_probe,
            ipc::schedules::schedules_create,
            ipc::schedules::schedules_delete,
            ipc::schedules::schedules_list,
            ipc::schedules::schedules_list_runs,
            ipc::schedules::schedules_set_enabled,
            ipc::secrets::secrets_delete,
            ipc::secrets::secrets_set,
            ipc::secrets::secrets_status,
            ipc::settings::settings_delete_provider,
            ipc::settings::settings_get,
            ipc::settings::settings_put_provider,
            ipc::settings::settings_set_theme,
            ipc::skills::skills_list,
            ipc::skills::skills_read,
            ipc::store::store_autotitle_conversation,
            ipc::store::store_create_conversation,
            ipc::store::store_delete_conversation,
            ipc::store::store_list_conversations,
            ipc::store::store_rename_conversation,
            ipc::store::store_search,
            ipc::transcript::store_append_message,
            ipc::transcript::store_delete_message,
            ipc::transcript::store_list_messages,
            ipc::transcript::store_update_message,
            ipc::ui::ui_get_layout,
            ipc::ui::ui_set_layout,
        ])
}

/// The process entry point. Everything about how Vela is assembled lives in
/// [`configure`]; this adds the real runtime and the real context.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure(tauri::Builder::default())
        .run(tauri::generate_context!())
        .expect("error while running Vela");
}
