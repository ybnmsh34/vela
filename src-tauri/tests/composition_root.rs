//! **The assembled application, driven end to end.**
//!
//! Every previous gate in this project drove a bridge, an example, or a
//! component. This file drives the host: the real `vela_lib::ipc::*` functions,
//! the real composition root, the real `ReqwestTransport`, over a real TCP
//! socket to a server that records the bytes it was sent.
//!
//! Three defects are pinned here, and each one has a **control** that
//! reproduces the pre-fix behaviour on demand, so a green run is a statement
//! about the wiring rather than about the assertions:
//!
//! | # | Defect | Control |
//! |---|---|---|
//! | 1 | `settings_put_provider` wrote a row and no provider was ever built, so every turn answered `NOT_FOUND` | [`the_pre_fix_wiring_reproduces_not_found_on_demand`] |
//! | 2 | `ChatSendReq` could not carry an image or a tool, so no shipping path could send either | [`a_turn_that_offers_nothing_puts_no_tools_on_the_wire`] |
//! | 3 | nothing could write a message, so a transcript died with the React tree | [`nothing_is_readable_before_anything_is_written`] |
//!
//! # Honesty (`docs/architecture/conventions.md` §10)
//!
//! The endpoint is a fixture this file starts, not a model. Every claim here is
//! about **what the assembled host does with a configured endpoint**: which
//! address it opens, what bytes it puts in the request, what it does with the
//! answer, and what it writes down. Nothing here is evidence about a real
//! model, and the credential store is `MemoryStore`, so nothing here is
//! evidence about an OS keychain either.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

use vela_core::auth::{AuthMode, AuthRequirement};
use vela_core::protocol::WireProtocol;
use vela_core::provider::ProviderKind;
use vela_lib::ipc::chat::{self, ChatMessageInput, ChatSendReq};
use vela_lib::ipc::content::ContentPartDto;
use vela_lib::ipc::settings::{self as ipc_settings, SettingsPutProviderReq};
use vela_lib::ipc::transcript::{self, StoreAppendMessageReq, StoreListMessagesReq};
use vela_lib::ipc::{IpcErrorCode, COMMAND_ALLOWLIST};
use vela_lib::provider_host::ProviderHost;
use vela_lib::state::AppState;
use vela_providers::model::{MessageRole, ToolChoice, ToolDefinition};
use vela_providers::provider::RequestContext;
use vela_providers::{ChatRequest, StreamEvent};
use vela_secrets::{MemoryStore, SecretStore};
use vela_store::{
    ConversationRepository, DatabaseLocation, MessageStatus, NewConversation, SqliteStore,
};

/* -------------------------------------------------------------------------- */
/* the fixture endpoint                                                       */
/* -------------------------------------------------------------------------- */

/// One recorded HTTP request, as bytes off the socket.
#[derive(Debug, Clone)]
struct Recorded {
    method: String,
    path: String,
    body: String,
}

/// A loopback server that answers the OpenAI-compatible routes and keeps every
/// request it was sent.
///
/// Deliberately hand-written rather than reusing the mock harness: this file is
/// about what the **host** puts on a socket, so the far end has to be something
/// that records raw bytes and nothing else.
struct FixtureEndpoint {
    base_url: String,
    seen: Arc<Mutex<Vec<Recorded>>>,
    shutdown: Arc<Mutex<bool>>,
}

impl FixtureEndpoint {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let shutdown = Arc::new(Mutex::new(false));

        let thread_seen = Arc::clone(&seen);
        let thread_shutdown = Arc::clone(&shutdown);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if *thread_shutdown.lock().unwrap() {
                    return;
                }
                let Ok(stream) = stream else { continue };
                serve(stream, &thread_seen);
            }
        });

        Self {
            base_url: format!("http://127.0.0.1:{port}/v1"),
            seen,
            shutdown,
        }
    }

    fn requests(&self) -> Vec<Recorded> {
        self.seen.lock().unwrap().clone()
    }

    /// The completion request, or `None` when the host never sent one.
    fn completion(&self) -> Option<Recorded> {
        self.requests()
            .into_iter()
            .find(|request| request.path.contains("chat/completions"))
    }
}

impl Drop for FixtureEndpoint {
    fn drop(&mut self) {
        *self.shutdown.lock().unwrap() = true;
    }
}

fn serve(mut stream: TcpStream, seen: &Arc<Mutex<Vec<Recorded>>>) {
    let mut reader = BufReader::new(stream.try_clone().expect("clone"));

    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() || request_line.trim().is_empty() {
        return;
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_owned();
    let path = parts.next().unwrap_or_default().to_owned();

    let mut content_length = 0usize;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).is_err() {
            return;
        }
        if header.trim().is_empty() {
            break;
        }
        if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or(0);
        }
    }

    let mut body = vec![0u8; content_length];
    if content_length > 0 && reader.read_exact(&mut body).is_err() {
        return;
    }
    seen.lock().unwrap().push(Recorded {
        method,
        path: path.clone(),
        body: String::from_utf8_lossy(&body).into_owned(),
    });

    let response = if path.contains("chat/completions") {
        // One SSE turn: a reasoning frame, two answer frames, a terminator.
        let frames = concat!(
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"counting\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"three hundred \"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"and ninety one\"}}]}\n\n",
            "data: [DONE]\n\n",
        );
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{frames}",
            frames.len()
        )
    } else if path.contains("/models") {
        let body = r#"{"data":[{"id":"fixture-model"}]}"#;
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    } else {
        // Everything else — llama.cpp's `/props`, Ollama's `/api/tags`, LM
        // Studio's `/api/v0/models` — is honestly absent.
        "HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_owned()
    };
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

/* -------------------------------------------------------------------------- */
/* the assembled host                                                         */
/* -------------------------------------------------------------------------- */

/// Everything `run()` manages, minus the window: the same `AppState`, the same
/// `ProviderHost`, the same store — built here so a test can hold them.
struct Host {
    state: AppState,
    store: SqliteStore,
}

impl Host {
    fn new() -> Self {
        let secrets: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
        Self {
            state: AppState::new(
                Arc::clone(&secrets),
                ProviderHost::for_runtime(Arc::clone(&secrets)),
            ),
            store: SqliteStore::open(DatabaseLocation::InMemory).unwrap(),
        }
    }

    /// What the user does in the settings screen, through the real command's
    /// own function.
    fn configure(&self, id: &str, base_url: &str) {
        ipc_settings::put_provider(
            &self.store,
            self.state.secrets.as_ref(),
            self.state.providers.as_ref(),
            SettingsPutProviderReq {
                id: id.to_owned(),
                display_name: "The user's endpoint".into(),
                kind: ProviderKind::Local,
                protocol: WireProtocol::default(),
                base_url: base_url.to_owned(),
                model_id: Some("fixture-model".into()),
                auth: AuthMode::None,
                auth_requirement: AuthRequirement::NotRequired,
            },
        )
        .expect("a local endpoint is a valid configuration");
    }

    /// What `chat_send` does, minus the window sink and the spawn.
    fn send(&self, request: ChatSendReq) -> Result<Vec<StreamEvent>, vela_lib::ipc::IpcError> {
        let built: ChatRequest = chat::build_request(&request)?;
        let router = self
            .state
            .providers
            .router_for(&request.provider_id, built.model_id.as_str())?;
        let mut sink: Vec<StreamEvent> = Vec::new();
        tauri::async_runtime::block_on(chat::run_turn(
            router,
            built,
            RequestContext::new(),
            &mut sink,
        ));
        Ok(sink)
    }
}

fn turn(provider_id: &str, message: ChatMessageInput) -> ChatSendReq {
    ChatSendReq {
        turn_id: "t1".into(),
        provider_id: provider_id.to_owned(),
        model_id: "fixture-model".into(),
        messages: vec![message],
        tools: Vec::new(),
        tool_choice: ToolChoice::Auto,
    }
}

fn answer_text(events: &[StreamEvent]) -> String {
    events
        .iter()
        .filter_map(|event| match event {
            StreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

/* ========================================================================== */
/* DEFECT 1 — the app can chat                                                */
/* ========================================================================== */

#[test]
fn a_turn_sent_through_the_real_ipc_functions_reaches_the_configured_endpoint() {
    let endpoint = FixtureEndpoint::start();
    let host = Host::new();
    host.configure("my-box", &endpoint.base_url);

    let events = host
        .send(turn(
            "my-box",
            ChatMessageInput::text(MessageRole::User, "what is 17 times 23?"),
        ))
        .expect("a configured endpoint must be reachable");

    let completion = endpoint
        .completion()
        .expect("the host must have opened a connection to the address the user typed");
    assert_eq!(completion.method, "POST");
    assert!(
        completion.body.contains("what is 17 times 23?"),
        "the user's words must arrive at the endpoint: {}",
        completion.body
    );

    assert_eq!(answer_text(&events), "three hundred and ninety one");
    assert!(
        events
            .iter()
            .any(|event| matches!(event, StreamEvent::ReasoningDelta { .. })),
        "reasoning must arrive on its own channel, not inside the answer"
    );
    assert!(matches!(events.last(), Some(StreamEvent::Done { .. })));
}

/// **The control.** The exact pre-fix wiring: a settings row written, no
/// provider built. Every capability axis is `NOT_FOUND` under it, which is what
/// the packaged application did for every endpoint a user had configured.
#[test]
fn the_pre_fix_wiring_reproduces_not_found_on_demand() {
    let endpoint = FixtureEndpoint::start();
    let host = Host::new();

    // The row is written through a throwaway host, so the live set stays empty
    // exactly as `ProviderRegistry::new()` left it.
    let throwaway = ProviderHost::for_runtime(Arc::new(MemoryStore::new()));
    ipc_settings::put_provider(
        &host.store,
        host.state.secrets.as_ref(),
        &throwaway,
        SettingsPutProviderReq {
            id: "my-box".into(),
            display_name: "The user's endpoint".into(),
            kind: ProviderKind::Local,
            protocol: WireProtocol::default(),
            base_url: endpoint.base_url.clone(),
            model_id: None,
            auth: AuthMode::None,
            auth_requirement: AuthRequirement::NotRequired,
        },
    )
    .unwrap();

    // The renderer would draw this as configured…
    let snapshot = ipc_settings::get(
        &host.store,
        host.state.secrets.as_ref(),
        vela_lib::ipc::EmptyPayload {},
    )
    .unwrap();
    assert_eq!(snapshot.providers.len(), 1);
    assert!(snapshot.providers[0].usable, "the UI is told it is ready");

    // …and every turn to it fails.
    let error = host
        .send(turn(
            "my-box",
            ChatMessageInput::text(MessageRole::User, "hello"),
        ))
        .expect_err("this is the defect, reproduced");
    assert_eq!(error.code, IpcErrorCode::NotFound);
    assert!(
        endpoint.requests().is_empty(),
        "and no byte ever left the machine"
    );
}

#[test]
fn a_provider_configured_in_an_earlier_session_is_reachable_after_a_restart() {
    // What `run()`'s `setup` does: the database already holds the row, and the
    // process that just started has an empty live set until it reads it.
    let endpoint = FixtureEndpoint::start();
    let first = Host::new();
    first.configure("my-box", &endpoint.base_url);

    let secrets: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    let restarted = AppState::new(
        Arc::clone(&secrets),
        ProviderHost::for_runtime(Arc::clone(&secrets)),
    );
    assert!(
        restarted.providers.is_empty(),
        "a fresh process knows nothing until it reads the database"
    );

    let report = restarted
        .providers
        .sync_from_settings(&first.store)
        .expect("stored settings are readable");
    assert_eq!(report.installed, vec!["my-box".to_string()]);
    assert!(report.failed.is_empty());
    assert!(chat::resolve_provider(restarted.providers.as_ref(), "my-box").is_ok());
}

#[test]
fn deleting_a_provider_makes_it_unreachable_within_the_same_session() {
    let endpoint = FixtureEndpoint::start();
    let host = Host::new();
    host.configure("my-box", &endpoint.base_url);
    assert!(chat::resolve_provider(host.state.providers.as_ref(), "my-box").is_ok());

    ipc_settings::delete_provider(
        &host.store,
        host.state.secrets.as_ref(),
        host.state.providers.as_ref(),
        vela_lib::ipc::settings::SettingsProviderRefReq {
            provider_id: "my-box".into(),
        },
    )
    .unwrap();

    let error = host
        .send(turn(
            "my-box",
            ChatMessageInput::text(MessageRole::User, "hello"),
        ))
        .expect_err("a deleted provider must stop answering");
    assert_eq!(error.code, IpcErrorCode::NotFound);
}

#[test]
fn a_corrected_base_url_takes_effect_on_the_next_turn_not_the_next_restart() {
    let wrong = FixtureEndpoint::start();
    let right = FixtureEndpoint::start();
    let host = Host::new();

    host.configure("my-box", &wrong.base_url);
    host.configure("my-box", &right.base_url); // the user fixes a typo

    host.send(turn(
        "my-box",
        ChatMessageInput::text(MessageRole::User, "hello"),
    ))
    .expect("reachable");

    assert!(
        right.completion().is_some(),
        "the turn must go to the corrected address"
    );
    assert!(
        wrong.completion().is_none(),
        "and never to the one the user replaced"
    );
}

/* ========================================================================== */
/* DEFECT 2 — vision and tools are reachable                                  */
/* ========================================================================== */

/// A 1×1 PNG. Real bytes, so the assertion is about a picture rather than a
/// string that happens to be valid base64.
const PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
];

#[test]
fn an_image_attached_in_the_ipc_payload_arrives_at_the_endpoint() {
    let endpoint = FixtureEndpoint::start();
    let host = Host::new();
    host.configure("my-box", &endpoint.base_url);

    host.send(turn(
        "my-box",
        ChatMessageInput {
            role: MessageRole::User,
            text: "what is in this picture?".into(),
            parts: vec![ContentPartDto::Image {
                mime_type: "image/png".into(),
                data: vela_providers::base64_encode(PNG),
            }],
        },
    ))
    .expect("reachable");

    let body = endpoint.completion().expect("a request was sent").body;
    assert!(
        body.contains("image_url"),
        "the image must be encoded into the request: {body}"
    );
    assert!(
        body.contains(&format!(
            "data:image/png;base64,{}",
            vela_providers::base64_encode(PNG)
        )),
        "and it must be the bytes the renderer supplied, unchanged: {body}"
    );
}

#[test]
fn a_tool_catalogue_in_the_ipc_payload_arrives_at_the_endpoint() {
    let endpoint = FixtureEndpoint::start();
    let host = Host::new();
    host.configure("my-box", &endpoint.base_url);

    let mut request = turn(
        "my-box",
        ChatMessageInput::text(MessageRole::User, "weather in Oslo?"),
    );
    request.tools = vec![ToolDefinition::new(
        "get_weather",
        "Current conditions for a place",
        serde_json::json!({
            "type": "object",
            "properties": { "city": { "type": "string" } },
            "required": ["city"],
        }),
    )];
    host.send(request).expect("reachable");

    let body = endpoint.completion().expect("a request was sent").body;
    assert!(
        body.contains("get_weather"),
        "the offered tool must reach the endpoint: {body}"
    );
    assert!(
        body.contains("\"tools\""),
        "as a tool catalogue, not as prose: {body}"
    );
}

/// **The control for the tool assertion.** Without it, "the body contains
/// `tools`" could be true of every request the host sends.
#[test]
fn a_turn_that_offers_nothing_puts_no_tools_on_the_wire() {
    let endpoint = FixtureEndpoint::start();
    let host = Host::new();
    host.configure("my-box", &endpoint.base_url);

    host.send(turn(
        "my-box",
        ChatMessageInput::text(MessageRole::User, "just talking"),
    ))
    .expect("reachable");

    let body = endpoint.completion().expect("a request was sent").body;
    assert!(
        !body.contains("get_weather") && !body.contains("\"tools\""),
        "a turn offering no tools must not carry a catalogue — GATE M FINDING 6 \
         recorded a profile that rejects the request outright: {body}"
    );
    assert!(
        !body.contains("image_url"),
        "and a turn with no picture must not carry one either: {body}"
    );
}

#[test]
fn a_tool_result_fed_back_reaches_the_endpoint_as_a_tool_message() {
    let endpoint = FixtureEndpoint::start();
    let host = Host::new();
    host.configure("my-box", &endpoint.base_url);

    let mut request = turn(
        "my-box",
        ChatMessageInput::text(MessageRole::User, "weather in Oslo?"),
    );
    request.messages.push(ChatMessageInput {
        role: MessageRole::Tool,
        text: String::new(),
        parts: vec![ContentPartDto::ToolResult {
            call_id: "call_1".into(),
            content: "17C and raining".into(),
            is_error: false,
        }],
    });
    host.send(request).expect("reachable");

    let body = endpoint.completion().expect("a request was sent").body;
    assert!(
        body.contains("17C and raining") && body.contains("call_1"),
        "without this the model can ask and nothing can answer: {body}"
    );
}

/* ========================================================================== */
/* DEFECT 3 — the transcript is written down                                  */
/* ========================================================================== */

#[test]
fn a_streamed_turn_can_be_persisted_and_read_back_with_its_reasoning_intact() {
    let endpoint = FixtureEndpoint::start();
    let host = Host::new();
    host.configure("my-box", &endpoint.base_url);

    let chat = host
        .store
        .create_conversation(NewConversation::titled("arithmetic"))
        .unwrap()
        .id
        .into_string();

    // The turn the user typed.
    transcript::append_message(
        &host.store,
        StoreAppendMessageReq {
            conversation_id: chat.clone(),
            role: MessageRole::User.into_store(),
            parts: vec![ContentPartDto::text("what is 17 times 23?")],
            status: MessageStatus::Complete,
            provider_id: None,
            model_id: None,
            // A user's own message was produced by no endpoint.
            answered_by_provider_id: None,
            answered_by_model_id: None,
            usage: Default::default(),
            stop_reason: None,
            error_message: None,
        },
    )
    .unwrap();

    // The answer, as the stream produced it.
    let events = host
        .send(turn(
            "my-box",
            ChatMessageInput::text(MessageRole::User, "what is 17 times 23?"),
        ))
        .unwrap();
    let reasoning: String = events
        .iter()
        .filter_map(|event| match event {
            StreamEvent::ReasoningDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();

    transcript::append_message(
        &host.store,
        StoreAppendMessageReq {
            conversation_id: chat.clone(),
            role: vela_store::MessageRole::Assistant,
            parts: vec![
                ContentPartDto::reasoning(&reasoning),
                ContentPartDto::text(answer_text(&events)),
            ],
            status: MessageStatus::Complete,
            provider_id: Some("my-box".into()),
            model_id: Some("fixture-model".into()),
            answered_by_provider_id: Some("my-box".into()),
            answered_by_model_id: Some("fixture-model".into()),
            usage: Default::default(),
            stop_reason: Some(vela_store::StopReason::EndTurn),
            error_message: None,
        },
    )
    .unwrap();

    // …and the conversation survives leaving it.
    let loaded = transcript::list_messages(
        &host.store,
        StoreListMessagesReq {
            conversation_id: chat.clone(),
            include_reasoning: true,
            after_seq: None,
            limit: None,
        },
    )
    .unwrap()
    .messages;
    assert_eq!(loaded.len(), 2);
    assert_eq!(
        loaded[1].parts,
        vec![
            ContentPartDto::reasoning("counting"),
            ContentPartDto::text("three hundred and ninety one"),
        ],
        "reasoning is stored as reasoning, never folded into the answer"
    );
    assert_eq!(loaded[1].model_id.as_deref(), Some("fixture-model"));

    // The projection that rebuilds a prompt leaves the thinking out.
    let replayable = transcript::list_messages(
        &host.store,
        StoreListMessagesReq {
            conversation_id: chat,
            include_reasoning: false,
            after_seq: None,
            limit: None,
        },
    )
    .unwrap()
    .messages;
    assert_eq!(
        replayable[1].parts,
        vec![ContentPartDto::text("three hundred and ninety one")]
    );
}

/// **The control for the persistence assertions.** An empty transcript reads as
/// empty, so a later read that finds two messages found something that was
/// written rather than something that was always there.
#[test]
fn nothing_is_readable_before_anything_is_written() {
    let host = Host::new();
    let chat = host
        .store
        .create_conversation(NewConversation::titled("empty"))
        .unwrap()
        .id
        .into_string();
    let loaded = transcript::list_messages(
        &host.store,
        StoreListMessagesReq {
            conversation_id: chat,
            include_reasoning: true,
            after_seq: None,
            limit: None,
        },
    )
    .unwrap();
    assert!(loaded.messages.is_empty());
}

#[test]
fn the_transcript_commands_are_reachable_from_the_renderer() {
    // Structural: a command function nothing can call is the same defect in a
    // third costume.
    for name in [
        "store_append_message",
        "store_update_message",
        "store_list_messages",
        "store_delete_message",
    ] {
        assert!(
            COMMAND_ALLOWLIST.contains(&name),
            "`{name}` is implemented but not reachable from the renderer"
        );
    }
}

/// Small convenience so the test above can say `MessageRole::User` once and
/// mean the store's role rather than the provider's. The two enums are
/// deliberately separate types; the mapping belongs at the call site that owns
/// both, which is this test.
trait IntoStoreRole {
    fn into_store(self) -> vela_store::MessageRole;
}

impl IntoStoreRole for MessageRole {
    fn into_store(self) -> vela_store::MessageRole {
        match self {
            MessageRole::System => vela_store::MessageRole::System,
            MessageRole::User => vela_store::MessageRole::User,
            MessageRole::Assistant => vela_store::MessageRole::Assistant,
            MessageRole::Tool => vela_store::MessageRole::Tool,
        }
    }
}
