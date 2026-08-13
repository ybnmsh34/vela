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
//! # The one thing this binary does that the shipping host does not
//!
//! It registers a provider in the `ProviderRegistry`. Nothing in
//! `src-tauri/src/` does — `AppState::for_runtime()` builds an empty registry
//! and `settings_put_provider` writes a settings row without ever constructing
//! a `Provider`. That gap is FINDING 1 of this gate; see RESULTS.md. The bridge
//! performs the missing step explicitly (the `registry.register(...)` call in
//! `main`) so that the rest of the matrix is reachable at all.

use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{json, Value};

use vela_core::credential::Auth;
use vela_core::provider::{ProviderDescriptor, ProviderKind};
use vela_lib::ipc::chat::{ChatSendReq, ChatTurns};
use vela_lib::ipc::models::{CapabilityCache, ModelCapabilityReport, ModelsProbeRes};
use vela_lib::ipc::{chat, diagnostics, models, secrets, settings, store, ui, IpcError, IpcResult};
use vela_lib::state::AppState;
use vela_lib::store_host::StoreHandle;
use vela_providers::http::ReqwestTransport;
use vela_providers::model::{ToolChoice, ToolDefinition};
use vela_providers::provider::{RequestContext, Timeouts};
use vela_providers::{OpenAiCompatibleProvider, ProviderRegistry};
use vela_secrets::{MemoryStore, SecretStore};
use vela_store::{DatabaseLocation, SqliteStore};

/// Prefix on a user message that makes the bridge attach a tool catalogue to
/// the `ChatRequest`.
///
/// It exists because `ChatSendReq` has no `tools` field: the shipping composer
/// cannot ask for tools, so the tool axis of the matrix would otherwise be
/// unreachable from the UI (FINDING 2). Everything downstream of the request —
/// native calls, prompt emulation, malformed reconstruction, the degradations —
/// is the real core against the real endpoint. Only the *request* was built by
/// the harness rather than by the composer, and RESULTS.md says so on every
/// screenshot that shows a tool call.
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

    let mut registry = ProviderRegistry::new();
    if register {
        registry.register(Arc::new(build_provider(
            &provider_id,
            &endpoint,
            api_key.as_deref(),
        )));
    }
    let state = AppState::new(Arc::new(MemoryStore::new()), registry);

    let out = Arc::new(Mutex::new(std::io::stdout()));
    let turns = Arc::new(ChatTurns::new());
    let cache = Arc::new(CapabilityCache::new());

    // The endpoint the user "configured", written through the real settings
    // command so the renderer sees a real `ProviderView` — including the host's
    // own security posture and credential check.
    let seeded = settings::put_provider(
        store_handle.store(),
        state.secrets.as_ref(),
        serde_json::from_value(json!({
            "id": provider_id,
            "displayName": "Capability matrix endpoint",
            "kind": "local",
            "baseUrl": endpoint,
            "modelId": model_id,
            "authRequirement": "notRequired",
            "auth": { "type": "none" },
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

fn build_provider(provider_id: &str, endpoint: &str, api_key: Option<&str>) -> OpenAiCompatibleProvider {
    let secrets = Arc::new(MemoryStore::new());
    let auth = match api_key {
        // The credentialled case is not what the matrix is about, but the
        // bridge must be able to reach it for the no-credential control.
        Some(key) => {
            let reference = vela_core::secret::SecretRef::primary(provider_id).expect("secret ref");
            secrets
                .set(&reference, &vela_core::secret::SecretValue::new(key))
                .expect("memory store accepts a value");
            Auth::Bearer { secret: reference }
        }
        None => Auth::None,
    };
    OpenAiCompatibleProvider::new(
        ProviderDescriptor::new(provider_id, "Capability matrix endpoint", ProviderKind::Local)
            .expect("descriptor"),
        endpoint.to_owned(),
        auth,
        secrets,
        Arc::new(ReqwestTransport::new().expect("http client builds")),
    )
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

        "settings_get" => encode(settings::get(store, state.secrets.as_ref(), decode(payload)?)?),
        "settings_set_theme" => encode(settings::set_theme(
            store,
            state.secrets.as_ref(),
            decode(payload)?,
        )?),
        "settings_put_provider" => encode(settings::put_provider(
            store,
            state.secrets.as_ref(),
            decode(payload)?,
        )?),
        "settings_delete_provider" => encode(settings::delete_provider(
            store,
            state.secrets.as_ref(),
            decode(payload)?,
        )?),

        "store_list_conversations" => encode(store::list(store, decode(payload)?)?),
        "store_create_conversation" => encode(store::create(store, decode(payload)?)?),
        "store_rename_conversation" => encode(store::rename(store, decode(payload)?)?),
        "store_delete_conversation" => encode(store::delete(store, decode(payload)?)?),
        "store_autotitle_conversation" => encode(store::autotitle(store, decode(payload)?)?),
        "store_search" => encode(store::search(store, decode(payload)?)?),

        "ui_get_layout" => encode(ui::get(store, decode(payload)?)?),
        "ui_set_layout" => encode(ui::set(store, decode(payload)?)?),

        "models_capabilities" => encode(models::capabilities(cache, decode(payload)?)?),
        "models_list" => {
            let reference: models::ModelsProviderRefReq = decode(payload)?;
            let provider = chat::resolve_provider(state.providers.as_ref(), &reference.provider_id)?;
            let context = RequestContext::new().with_timeouts(Timeouts::probing());
            let outcome =
                tauri::async_runtime::block_on(async move { provider.list_models(&context).await });
            encode(models::listing_result(outcome))
        }
        "models_probe" => {
            let reference: models::ModelsRefReq = decode(payload)?;
            let provider = chat::resolve_provider(state.providers.as_ref(), &reference.provider_id)?;
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
                .find(|message| {
                    matches!(message.role, vela_providers::model::MessageRole::User)
                })
                .is_some_and(|message| message.text.trim_start().starts_with(TOOLS_SENTINEL));

            let mut built = chat::build_request(&send)?;
            if wants_tools {
                built = built
                    .with_tools([
                        ToolDefinition::new(
                            "get_weather",
                            "Current conditions for a place",
                            json!({
                                "type": "object",
                                "properties": { "city": { "type": "string" } },
                                "required": ["city"],
                            }),
                        ),
                    ])
                    .with_tool_choice(ToolChoice::Auto);
            }
            let provider = chat::resolve_provider(state.providers.as_ref(), &send.provider_id)?;
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
                    provider,
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
