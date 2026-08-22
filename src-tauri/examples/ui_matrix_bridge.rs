//! **GATE M Part 1 (Phase C) — the UI↔core bridge.**
//!
//! The desktop shell cannot run in this container (no display server), but the
//! renderer can: `src/platform/adapter.ts` is a seam, so the shipping UI runs
//! in a browser as long as *something* answers `invoke` and emits `chat:event`.
//! In the browser that something is normally `BrowserAdapter`, an in-memory
//! echo — which can never produce reasoning, a degradation, a malformed tool
//! call, or a capability report. A UI gate driven against it would prove
//! nothing about the capability matrix.
//!
//! So this binary stands in for the Tauri host process, and *only* for the
//! transport:
//!
//! ```text
//!   Chromium (real src/ bundle)
//!        │  fetch /invoke, EventSource /events        ← relay, not IPC
//!   node tests/harness/ui-bridge/server.mjs
//!        │  JSON lines on stdin/stdout
//!   THIS BINARY  ──►  vela_lib::ipc::*  (the real command functions)
//!        │            vela_providers::OpenAiCompatibleProvider (the real core)
//!        ▼  real HTTP over a real TCP socket
//!   node tests/harness/mock-provider  (frontier | mid-local | small-local | hostile)
//! ```
//!
//! Everything below the relay is the shipping code. This file contains no
//! normalisation, no reasoning splitting, no capability inference and no error
//! mapping of its own: each command delegates to the same
//! `vela_lib::ipc::<domain>::<fn>` the `#[tauri::command]` wrapper delegates to,
//! and the events written to stdout are `vela_providers::StreamEvent`s
//! serialised by their own `Serialize` impl, exactly as `WindowSink` emits them.
//!
//! # Honesty (conventions.md §10)
//!
//! **VERIFIED-BY-FAKE.** The endpoint is a deterministic mock; no byte of any
//! answer came from a language model. The secret store is `MemoryStore`. The
//! transport into the browser is HTTP+SSE, not Tauri IPC. What this setup can
//! prove is what the *renderer* does with what the *core* produces from the
//! recorded behaviour of endpoints that break in the documented ways.
//!
//! # FINDING 1 — closed, and what `--no-register` means now
//!
//! This binary used to hand-roll an `OpenAiCompatibleProvider` and push it into
//! a `ProviderRegistry` itself, because nothing in `src-tauri/src/` did:
//! `AppState::for_runtime()` built an empty registry and `settings_put_provider`
//! wrote a settings row without ever constructing a `Provider`. That was
//! FINDING 1 of this gate, and the bridge performing the missing step was the
//! only reason the rest of the matrix was reachable.
//!
//! **It no longer does that.** The provider is built by
//! [`vela_lib::provider_host::ProviderHost`] — the shipping composition root —
//! through the same `settings::put_provider` call the real command makes. The
//! bridge now contains no provider construction of its own.
//!
//! `--no-register` is kept as the **regression control**: it seeds the identical
//! settings row through a *throwaway* `ProviderHost`, so the row exists and the
//! live set the chat surface resolves against stays empty. That is exactly the
//! pre-fix shipping wiring, and every capability axis goes `NOT_FOUND` under it.
//! If the composition root is ever removed again, this flag reproduces the
//! symptom on demand.

use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{json, Value};

use vela_lib::ipc::chat::{ChatSendReq, ChatTurns};
use vela_lib::ipc::models::{CapabilityCache, ModelCapabilityReport, ModelsProbeRes};
use vela_lib::ipc::{
    chat, diagnostics, models, secrets, settings, store, transcript, ui, IpcError, IpcResult,
};
use vela_lib::provider_host::ProviderHost;
use vela_lib::state::AppState;
use vela_lib::store_host::StoreHandle;
use vela_providers::http::{HttpTransport, ReqwestTransport};
use vela_providers::model::{ToolChoice, ToolDefinition};
use vela_providers::provider::{RequestContext, Timeouts};
use vela_providers::{Candidate, Router};
use vela_secrets::{MemoryStore, SecretStore};
use vela_store::{DatabaseLocation, SqliteStore};

/// Prefix on a user message that makes the bridge attach a tool catalogue when
/// the payload carried none.
///
/// It exists because `ChatSendReq` used to have no `tools` field: the shipping
/// composer could not ask for tools, so the tool axis of the matrix was
/// otherwise unreachable from the UI (FINDING 2). **That field now exists**, and
/// a payload carrying `tools` goes through `chat::build_request` like any other
/// — the sentinel only fires when the request offered nothing, so the existing
/// matrix driver keeps working while a caller that sends a real catalogue is
/// no longer overridden by the harness.
const TOOLS_SENTINEL: &str = "#tools";

fn main() {
    let mut endpoint = String::new();
    let mut provider_id = "matrix".to_owned();
    let mut model_id = String::new();
    let mut api_key: Option<String> = None;
    let mut register = true;

    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        let value = args.get(index + 1).cloned();
        match flag {
            "--endpoint" => endpoint = value.expect("--endpoint needs a value"),
            "--provider-id" => provider_id = value.expect("--provider-id needs a value"),
            "--model-id" => model_id = value.expect("--model-id needs a value"),
            "--api-key" => api_key = value,
            // Control knob for the assertion controls: skip the registration
            // step and the bridge behaves exactly like the shipping host does
            // today, which is how FINDING 1 is demonstrated rather than argued.
            "--no-register" => {
                register = false;
                index += 1;
                continue;
            }
            other => panic!("unknown flag {other}"),
        }
        index += 2;
    }
    assert!(!endpoint.is_empty(), "--endpoint is required");
    assert!(!model_id.is_empty(), "--model-id is required");

    let temp = std::env::temp_dir().join(format!("vela-ui-bridge-{}", std::process::id()));
    std::fs::create_dir_all(&temp).expect("scratch directory");
    let sqlite = SqliteStore::open(DatabaseLocation::in_directory(&temp)).expect("store opens");
    let store_handle = StoreHandle::new(Arc::new(sqlite));

    let secrets: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    if let Some(key) = api_key.as_deref() {
        // The credentialled case is not what the matrix is about, but the
        // bridge must be able to reach it for the no-credential control.
        let reference = vela_core::secret::SecretRef::primary(&provider_id).expect("secret ref");
        secrets
            .set(&reference, &vela_core::secret::SecretValue::new(key))
            .expect("memory store accepts a value");
    }
    let transport: Arc<dyn HttpTransport> =
        Arc::new(ReqwestTransport::new().expect("http client builds"));
    let state = AppState::new(
        Arc::clone(&secrets),
        ProviderHost::new(Arc::clone(&secrets), Arc::clone(&transport)),
    );

    let out = Arc::new(Mutex::new(std::io::stdout()));
    let turns = Arc::new(ChatTurns::new());
    let cache = Arc::new(CapabilityCache::new());

    // The endpoint the user "configured", written through the real settings
    // command so the renderer sees a real `ProviderView` — including the host's
    // own security posture and credential check — and so the provider is built
    // by the shipping composition root rather than by this file.
    //
    // `--no-register` routes the identical write through a throwaway host, which
    // leaves the row written and the live set empty: the pre-fix wiring, exact.
    let throwaway = ProviderHost::new(Arc::new(MemoryStore::new()), transport);
    let seeded = settings::put_provider(
        store_handle.store(),
        state.secrets.as_ref(),
        if register {
            state.providers.as_ref()
        } else {
            &throwaway
        },
        serde_json::from_value(json!({
            "id": provider_id,
            "displayName": "Capability matrix endpoint",
            "kind": "local",
            "baseUrl": endpoint,
            "modelId": model_id,
            "authRequirement": if api_key.is_some() { "required" } else { "notRequired" },
            "auth": if api_key.is_some() { json!({ "type": "bearerToken" }) } else { json!({ "type": "none" }) },
        }))
        .expect("seed provider payload"),
    );
    emit(
        &out,
        &json!({ "ready": true, "seeded": seeded.is_ok(), "registered": register }),
    );

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(request) = serde_json::from_str::<Request>(&line) else {
            continue;
        };
        let id = request.id;
        let outcome = dispatch(&request, &state, &store_handle, &turns, &cache, &out);
        match outcome {
            Ok(value) => emit(&out, &json!({ "id": id, "ok": value })),
            Err(error) => emit(
                &out,
                &json!({ "id": id, "err": serde_json::to_value(&error).expect("ipc error") }),
            ),
        }
    }
}

#[derive(Deserialize)]
struct Request {
    id: u64,
    command: String,
    #[serde(default)]
    payload: Value,
}

type Sink = Arc<Mutex<std::io::Stdout>>;

fn emit(out: &Sink, value: &Value) {
    let mut handle = out.lock().expect("stdout lock");
    let _ = writeln!(handle, "{value}");
    let _ = handle.flush();
}

fn decode<T: serde::de::DeserializeOwned>(payload: &Value) -> IpcResult<T> {
    serde_json::from_value(payload.clone())
        .map_err(|error| IpcError::invalid(format!("invalid payload: {error}")))
}

fn encode<T: serde::Serialize>(value: T) -> IpcResult<Value> {
    serde_json::to_value(value).map_err(|error| IpcError::invalid(error.to_string()))
}

/// Dispatches one command to the same function its `#[tauri::command]` wrapper
/// calls. Kept deliberately mechanical: any behaviour written here rather than
/// delegated would be behaviour the shipping host does not have.
fn dispatch(
    request: &Request,
    state: &AppState,
    store_handle: &StoreHandle,
    turns: &Arc<ChatTurns>,
    cache: &Arc<CapabilityCache>,
    out: &Sink,
) -> IpcResult<Value> {
    let payload = &request.payload;
    let store = store_handle.store();
    match request.command.as_str() {
        "app_info" => encode(vela_lib::ipc::app::app_info_of(state)),
        "diagnostics_echo" => encode(diagnostics::echo(decode(payload)?, now_ms())?),

        "secrets_set" => encode(secrets::set(state.secrets.as_ref(), decode(payload)?)?),
        "secrets_delete" => encode(secrets::delete(state.secrets.as_ref(), decode(payload)?)?),
        "secrets_status" => encode(secrets::status(state.secrets.as_ref(), decode(payload)?)?),

        "settings_get" => encode(settings::get(
            store,
            state.secrets.as_ref(),
            decode(payload)?,
        )?),
        "settings_set_theme" => encode(settings::set_theme(
            store,
            state.secrets.as_ref(),
            decode(payload)?,
        )?),
        "settings_put_provider" => encode(settings::put_provider(
            store,
            state.secrets.as_ref(),
            state.providers.as_ref(),
            decode(payload)?,
        )?),
        "settings_delete_provider" => encode(settings::delete_provider(
            store,
            state.secrets.as_ref(),
            state.providers.as_ref(),
            decode(payload)?,
        )?),

        "store_list_conversations" => encode(store::list(store, decode(payload)?)?),
        "store_create_conversation" => encode(store::create(store, decode(payload)?)?),
        "store_rename_conversation" => encode(store::rename(store, decode(payload)?)?),
        "store_delete_conversation" => encode(store::delete(store, decode(payload)?)?),
        "store_autotitle_conversation" => encode(store::autotitle(store, decode(payload)?)?),
        "store_search" => encode(store::search(store, decode(payload)?)?),

        "store_append_message" => encode(transcript::append_message(store, decode(payload)?)?),
        "store_update_message" => encode(transcript::update_message(store, decode(payload)?)?),
        "store_list_messages" => encode(transcript::list_messages(store, decode(payload)?)?),
        "store_delete_message" => encode(transcript::delete_message(store, decode(payload)?)?),

        "ui_get_layout" => encode(ui::get(store, decode(payload)?)?),
        "ui_set_layout" => encode(ui::set(store, decode(payload)?)?),

        "models_capabilities" => encode(models::capabilities(cache, decode(payload)?)?),
        "models_list" => {
            let reference: models::ModelsProviderRefReq = decode(payload)?;
            let provider =
                chat::resolve_provider(state.providers.as_ref(), &reference.provider_id)?;
            let context = RequestContext::new().with_timeouts(Timeouts::probing());
            let outcome =
                tauri::async_runtime::block_on(async move { provider.list_models(&context).await });
            encode(models::listing_result(outcome))
        }
        "models_probe" => {
            let reference: models::ModelsRefReq = decode(payload)?;
            let provider =
                chat::resolve_provider(state.providers.as_ref(), &reference.provider_id)?;
            let context = RequestContext::new().with_timeouts(Timeouts::probing());
            let model_id = reference.model_id.trim().to_owned();
            let provider_id = reference.provider_id.trim().to_owned();
            let probed = tauri::async_runtime::block_on(async move {
                provider.probe_capabilities(&model_id, &context).await
            });
            match probed {
                Ok(found) => {
                    cache.put(&provider_id, found.clone());
                    encode(ModelsProbeRes {
                        report: ModelCapabilityReport::of(&provider_id, &found),
                        failure: None,
                    })
                }
                Err(error) => {
                    let known = models::capabilities(
                        cache,
                        models::ModelsRefReq {
                            provider_id: provider_id.clone(),
                            model_id: reference.model_id.clone(),
                        },
                    )?;
                    encode(ModelsProbeRes {
                        report: known,
                        failure: Some(error),
                    })
                }
            }
        }

        "chat_send" => {
            let send: ChatSendReq = decode(payload)?;
            let wants_tools = send
                .messages
                .iter()
                .rev()
                .find(|message| matches!(message.role, vela_providers::model::MessageRole::User))
                .is_some_and(|message| message.text.trim_start().starts_with(TOOLS_SENTINEL));

            let mut built = chat::build_request(&send)?;
            if wants_tools && built.tools.is_empty() {
                built = built
                    .with_tools([ToolDefinition::new(
                        "get_weather",
                        "Current conditions for a place",
                        json!({
                            "type": "object",
                            "properties": { "city": { "type": "string" } },
                            "required": ["city"],
                        }),
                    )])
                    .with_tool_choice(ToolChoice::Auto);
            }
            // Deliberately a **one-candidate** router rather than
            // `ProviderHost::router_for`. This bridge exists to pin what one
            // matrix profile does; it has all four configured at once, so a
            // failover would let a profile's recorded behaviour depend on which
            // of its siblings happened to be registered beside it. The retry,
            // backoff and first-output rules are still the real ones.
            let provider = chat::resolve_provider(state.providers.as_ref(), &send.provider_id)?;
            let router = Router::new(vec![Candidate::new(provider, built.model_id.clone())]);
            let cancel = turns.begin(&send.turn_id).ok_or_else(|| {
                IpcError::invalid(format!(
                    "invalid turnId: `{}` is already streaming",
                    send.turn_id
                ))
            })?;

            let turn_id = send.turn_id.clone();
            let turns_handle = Arc::clone(turns);
            let sink_out = Arc::clone(out);
            tauri::async_runtime::spawn(async move {
                let mut sink = RelaySink {
                    out: sink_out,
                    turn_id: turn_id.clone(),
                };
                chat::run_turn(
                    router,
                    built,
                    RequestContext::new().with_cancel(cancel),
                    &mut sink,
                )
                .await;
                turns_handle.finish(&turn_id);
            });

            Ok(json!({ "turnId": send.turn_id, "accepted": true }))
        }
        "chat_cancel" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Cancel {
                turn_id: String,
            }
            let cancel: Cancel = decode(payload)?;
            if cancel.turn_id.trim().is_empty() {
                return Err(IpcError::invalid("invalid turnId: must not be blank"));
            }
            Ok(json!({ "cancelled": turns.cancel(&cancel.turn_id) }))
        }

        // Not on the allowlist: the same answer the renderer's own adapter
        // gives, so a typo in the harness cannot look like a host feature.
        other => Err(IpcError::not_found(format!("unknown command `{other}`"))),
    }
}

/// The stand-in for `WindowSink`. It serialises the event and writes it; it
/// does not inspect, reshape or filter anything.
struct RelaySink {
    out: Sink,
    turn_id: String,
}

impl vela_providers::event::EventSink for RelaySink {
    fn emit(&mut self, event: vela_providers::event::StreamEvent) {
        let payload = json!({
            "event": "chat:event",
            "payload": {
                "turnId": self.turn_id,
                "event": serde_json::to_value(&event).expect("stream events serialise"),
            },
            "at": now_ms(),
        });
        emit(&self.out, &payload);
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}
