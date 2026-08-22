//! `chat_*` — starting and stopping a streamed turn.
//!
//! # Shape
//!
//! A turn is **two channels, not one**. `chat_send` is a fast acknowledgement:
//! it validates, registers a cancellation token, spawns the turn, and returns.
//! The tokens themselves arrive on the `chat:event` channel as
//! [`vela_providers::StreamEvent`]s, verbatim.
//!
//! That split is deliberate. `vela-providers` terminates streams in single-digit
//! milliseconds; if `chat_send` awaited the whole turn, the renderer would have
//! no token to draw until the last one arrived, and every one of those
//! milliseconds would be spent by a UI that could have been painting.
//!
//! # Why the renderer mints the turn id
//!
//! Events can be emitted before `invoke`'s promise settles — that is the point
//! of spawning. A renderer that had to wait for a host-assigned id would have
//! nowhere to route the first frames. So the id comes in with the request, and
//! the host's job is to refuse one that is already in flight.
//!
//! # What crosses the boundary
//!
//! `StreamEvent` is forwarded as-is because it is *already* the provider-neutral
//! form: no HTTP status, no `finish_reason`, no vendor error string, no backend
//! identity. Re-mapping it here would add a second place for the two models to
//! drift apart, and drift is how provider detail leaks.
//!
//! # A turn runs against a router, not against a provider
//!
//! [`chat_send`] resolves a [`vela_providers::Router`] rather than a single
//! [`Provider`], and that is the difference between the two shapes:
//!
//! * A provider is one endpoint, tried once. A refused connection was the end
//!   of the turn, whatever else the user had configured.
//! * A router is the ordered candidate list from
//!   [`ProviderHost::router_for`], with bounded retries, growing backoff, the
//!   endpoint's own `Retry-After` honoured, and — the rule that matters most —
//!   **no failover once any output has reached the screen**, because splicing a
//!   second answer onto a half-drawn first one is worse than the error it was
//!   avoiding.
//!
//! `resolve_provider` still exists and is still the right thing for
//! `models_list` and `models_probe`: listing models on *this* endpoint is a
//! question about that endpoint, and answering it from a different one would be
//! a lie. Failover is for a turn, not for a question about a box.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime, State};
use vela_providers::event::{EventSink, StreamEvent};
use vela_providers::model::{ChatMessage, ChatRequest, ContentPart, MessageRole};
use vela_providers::model::{ToolChoice, ToolDefinition};
use vela_providers::provider::{CancelToken, Provider, RequestContext};
use vela_providers::Router;

use super::content::{to_provider_parts, ContentPartDto};
use super::{IpcError, IpcResult};
use crate::provider_host::ProviderHost;
use crate::state::AppState;

/// The event name the renderer subscribes to. Mirrored in
/// `src/platform/adapter.ts`'s `EventContract`.
pub const CHAT_EVENT: &str = "chat:event";

/// Longest single message Vela will forward. Generous enough for a pasted file,
/// bounded so a runaway renderer cannot ask the host to allocate without limit.
const MAX_MESSAGE_BYTES: usize = 1_048_576;

/// Most messages in one request. A conversation longer than this is a bug in
/// the caller, not a user intent.
const MAX_MESSAGES: usize = 4_096;

/// Most tools offerable in one turn. Generous for a real catalogue, bounded so
/// the prompt-emulation path cannot be handed an unbounded list to inline.
const MAX_TOOLS: usize = 128;

/// Longest tool name and description. Both reach the model verbatim.
const MAX_TOOL_NAME: usize = 128;
const MAX_TOOL_DESCRIPTION: usize = 8_192;

/* -------------------------------------------------------------------------- */
/* wire types                                                                 */
/* -------------------------------------------------------------------------- */

/// One message in the turn being sent.
///
/// # Why there are two content fields
///
/// `text` is the ordinary case and stays exactly as it was, so the overwhelming
/// majority of turns — a person typing a sentence — are one field. `parts`
/// carries everything text cannot say: an attached image, a tool result being
/// fed back, a signed reasoning block a backend requires returned verbatim.
///
/// The composition rule is one line and is pinned by
/// [`tests::text_and_parts_compose_in_the_order_the_user_sees`]:
///
/// > **the effective content is `text` (when non-empty) followed by `parts`,
/// > in order** — and a message with neither is a single empty text part,
/// > which is what a message with no `parts` field has always been.
///
/// Two fields rather than one because collapsing `text` into `parts` would
/// break every caller for no gain, and because a required `parts` array makes
/// the common case the awkward one.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageInput {
    pub role: MessageRole,
    #[serde(default)]
    pub text: String,
    /// Non-text content, appended after `text`. Empty for an ordinary turn.
    #[serde(default)]
    pub parts: Vec<ContentPartDto>,
}

impl ChatMessageInput {
    /// The plain-text message this used to be the only way to express.
    pub fn text(role: MessageRole, text: impl Into<String>) -> Self {
        Self {
            role,
            text: text.into(),
            parts: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSendReq {
    pub turn_id: String,
    pub provider_id: String,
    pub model_id: String,
    pub messages: Vec<ChatMessageInput>,
    /// The tools offered for this turn.
    ///
    /// Per-turn rather than per-provider on purpose: which tools are available
    /// is a property of what the user is doing, not of which endpoint is
    /// answering. Empty is the normal case and means "no tool use", which the
    /// encoder turns into omitting the catalogue entirely — GATE M FINDING 6
    /// recorded a profile that rejects a request carrying `tools` even with
    /// `toolChoice: none`.
    #[serde(default)]
    pub tools: Vec<ToolDefinition>,
    #[serde(default)]
    pub tool_choice: ToolChoice,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSendRes {
    pub turn_id: String,
    /// Always `true`. A refusal is an [`IpcError`], never a `false` a caller
    /// could forget to read.
    pub accepted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCancelReq {
    pub turn_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCancelRes {
    /// `false` when the turn had already finished. A race, not an error: the
    /// user pressed stop as the last token landed.
    pub cancelled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatEventEnvelope {
    pub turn_id: String,
    pub event: StreamEvent,
}

/* -------------------------------------------------------------------------- */
/* the in-flight turn registry                                                */
/* -------------------------------------------------------------------------- */

/// Cancellation tokens for turns currently streaming.
///
/// Managed separately from [`AppState`] because it is host-process bookkeeping,
/// not domain state: nothing in `crates/` needs to know a turn is in flight.
///
/// `Clone` shares one registry, which is what lets a spawned turn deregister
/// itself long after the command's `State` borrow has expired — no lifetime
/// laundering, no second source of truth.
#[derive(Default, Clone)]
pub struct ChatTurns {
    inner: Arc<Mutex<HashMap<String, CancelToken>>>,
}

impl ChatTurns {
    pub fn new() -> Self {
        Self::default()
    }

    /// Claims `turn_id`. `None` when it is already in flight — the caller turns
    /// that into an `INVALID_PAYLOAD`, because reusing a live id would make two
    /// streams indistinguishable on the event channel.
    pub fn begin(&self, turn_id: &str) -> Option<CancelToken> {
        let mut turns = self.lock();
        if turns.contains_key(turn_id) {
            return None;
        }
        let token = CancelToken::new();
        turns.insert(turn_id.to_owned(), token.clone());
        Some(token)
    }

    /// Cancels a live turn. `false` when there is nothing to cancel.
    pub fn cancel(&self, turn_id: &str) -> bool {
        match self.lock().get(turn_id) {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    /// Releases the id. Idempotent: a cancelled turn also finishes.
    pub fn finish(&self, turn_id: &str) {
        self.lock().remove(turn_id);
    }

    pub fn in_flight(&self) -> usize {
        self.lock().len()
    }

    /// A poisoned lock here means a previous turn panicked while holding it.
    /// Recovering is correct: the map is a plain id→token index with no
    /// invariant a panic could have half-broken, and refusing every subsequent
    /// turn would be a worse outcome than continuing.
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, CancelToken>> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/* -------------------------------------------------------------------------- */
/* logic — plain functions, no Tauri types                                    */
/* -------------------------------------------------------------------------- */

/// Validates the payload and builds the provider-facing request.
///
/// Rejection order is part of the contract: identity first, then the message
/// list, so a payload with two faults always blames the same field.
pub fn build_request(req: &ChatSendReq) -> IpcResult<ChatRequest> {
    if req.turn_id.trim().is_empty() {
        return Err(IpcError::invalid("invalid turnId: must not be blank"));
    }
    if req.provider_id.trim().is_empty() {
        return Err(IpcError::invalid("invalid providerId: must not be blank"));
    }
    if req.model_id.trim().is_empty() {
        return Err(IpcError::invalid("invalid modelId: must not be blank"));
    }
    if req.messages.is_empty() {
        return Err(IpcError::invalid(
            "invalid messages: a turn needs at least one message",
        ));
    }
    if req.messages.len() > MAX_MESSAGES {
        return Err(IpcError::invalid(format!(
            "invalid messages: at most {MAX_MESSAGES} messages per turn"
        )));
    }
    let mut messages = Vec::with_capacity(req.messages.len());
    for (index, message) in req.messages.iter().enumerate() {
        if message.text.len() > MAX_MESSAGE_BYTES {
            return Err(IpcError::invalid(format!(
                "invalid messages[{index}]: exceeds {MAX_MESSAGE_BYTES} bytes"
            )));
        }
        messages.push(ChatMessage::new(
            message.role,
            content_of(message, &format!("messages[{index}]"))?,
        ));
    }

    Ok(ChatRequest::new(req.model_id.trim())
        .with_messages(messages)
        .with_tools(validated_tools(&req.tools)?)
        .with_tool_choice(validated_tool_choice(&req.tool_choice, &req.tools)?))
}

/// `text` then `parts`, in that order. See [`ChatMessageInput`].
fn content_of(message: &ChatMessageInput, whose: &str) -> IpcResult<Vec<ContentPart>> {
    let extra = to_provider_parts(&message.parts, whose)?;
    if extra.is_empty() {
        // Including the empty-text case: a message that says nothing is one
        // empty text part, exactly as it was before `parts` existed.
        return Ok(vec![ContentPart::text(message.text.clone())]);
    }
    let mut parts = Vec::with_capacity(extra.len() + 1);
    if !message.text.is_empty() {
        parts.push(ContentPart::text(message.text.clone()));
    }
    parts.extend(extra);
    Ok(parts)
}

fn validated_tools(tools: &[ToolDefinition]) -> IpcResult<Vec<ToolDefinition>> {
    if tools.len() > MAX_TOOLS {
        return Err(IpcError::invalid(format!(
            "invalid tools: at most {MAX_TOOLS} tools per turn"
        )));
    }
    let mut seen = std::collections::BTreeSet::new();
    for (index, tool) in tools.iter().enumerate() {
        let name = tool.name.trim();
        if name.is_empty() {
            return Err(IpcError::invalid(format!(
                "invalid tools[{index}].name: must not be blank"
            )));
        }
        if name.len() > MAX_TOOL_NAME {
            return Err(IpcError::invalid(format!(
                "invalid tools[{index}].name: must be at most {MAX_TOOL_NAME} characters"
            )));
        }
        if tool.description.len() > MAX_TOOL_DESCRIPTION {
            return Err(IpcError::invalid(format!(
                "invalid tools[{index}].description: must be at most {MAX_TOOL_DESCRIPTION} characters"
            )));
        }
        // A JSON Schema for an argument object is an object. Anything else
        // reaches the model as nonsense, or reaches the emulation path as a
        // prompt fragment that cannot be satisfied.
        if !tool.parameters.is_object() {
            return Err(IpcError::invalid(format!(
                "invalid tools[{index}].parameters: must be a JSON Schema object"
            )));
        }
        if !seen.insert(name.to_owned()) {
            // Two tools with one name make the model's answer un-routable: the
            // call comes back naming a tool, not an index.
            return Err(IpcError::invalid(format!(
                "invalid tools[{index}].name: `{name}` is offered twice"
            )));
        }
    }
    Ok(tools.to_vec())
}

fn validated_tool_choice(choice: &ToolChoice, tools: &[ToolDefinition]) -> IpcResult<ToolChoice> {
    match choice {
        ToolChoice::Named { name } if !tools.iter().any(|tool| tool.name.trim() == name.trim()) => {
            Err(IpcError::invalid(format!(
                "invalid toolChoice: `{name}` is not among the tools offered this turn"
            )))
        }
        ToolChoice::Required if tools.is_empty() => Err(IpcError::invalid(
            "invalid toolChoice: `required` with no tools offered can never be satisfied",
        )),
        other => Ok(other.clone()),
    }
}

/// Resolves the backend for this turn. `NOT_FOUND` is the honest answer for an
/// id that is not configured — never a fallback to "some other provider".
///
/// Takes the [`ProviderHost`] rather than a bare registry, because the host is
/// the only thing that can have been filled from the user's settings. A
/// registry reference was what made this function reliably answer `NOT_FOUND`
/// for every endpoint the user had configured.
pub fn resolve_provider(
    providers: &ProviderHost,
    provider_id: &str,
) -> IpcResult<std::sync::Arc<dyn Provider>> {
    providers.get(provider_id).ok_or_else(|| {
        IpcError::not_found(format!("no provider configured with id `{provider_id}`"))
    })
}

/// Wraps a sink and remembers whether a terminal event went through it.
///
/// The reason this exists: a `Provider` emits `Done` itself on every successful
/// path, but an `Err` return may or may not have been preceded by an `Error`
/// event depending on where it failed. Without this flag the driver would
/// either double-report a failure or leave the renderer waiting forever for an
/// end that never comes. Both are worse than one extra bool.
struct TerminalTracking<'sink> {
    inner: &'sink mut dyn EventSink,
    saw_terminal: bool,
}

impl EventSink for TerminalTracking<'_> {
    fn emit(&mut self, event: StreamEvent) {
        self.saw_terminal |= event.is_terminal();
        self.inner.emit(event);
    }
}

/// Drives one turn to completion, guaranteeing the sink sees exactly one
/// terminal event.
///
/// Takes a [`Router`] rather than a provider: a turn is addressed to the
/// endpoint the user chose and may be *retried* there or *failed over* from
/// there, and the rules for when it may be are the router's, not this layer's.
/// A single-endpoint turn is the one-candidate case of the same thing and gets
/// bounded retry and backoff for free.
///
/// Split out from the command so it can be tested with a `Vec<StreamEvent>`
/// sink and in-process providers — no window, no runtime, no endpoint.
pub async fn run_turn(
    router: Router,
    request: ChatRequest,
    context: RequestContext,
    sink: &mut dyn EventSink,
) {
    let mut tracking = TerminalTracking {
        inner: sink,
        saw_terminal: false,
    };
    let outcome = router.stream(request, &mut tracking, &context).await;
    if let Err(error) = outcome {
        if !tracking.saw_terminal {
            tracking.emit(StreamEvent::Error { error });
        }
    }
}

/* -------------------------------------------------------------------------- */
/* commands                                                                   */
/* -------------------------------------------------------------------------- */

/// Emits each event to the webview as it is produced.
struct WindowSink<R: Runtime> {
    app: AppHandle<R>,
    turn_id: String,
}

impl<R: Runtime> EventSink for WindowSink<R> {
    fn emit(&mut self, event: StreamEvent) {
        // Infallible by contract: a sink that has gone away must not be able to
        // turn into a provider error halfway through a turn. If the window is
        // gone there is nobody left to tell, and the turn's own cancellation
        // token is what stops the work.
        let _ = self.app.emit(
            CHAT_EVENT,
            ChatEventEnvelope {
                turn_id: self.turn_id.clone(),
                event,
            },
        );
    }
}

#[tauri::command]
pub fn chat_send<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    turns: State<'_, ChatTurns>,
    payload: ChatSendReq,
) -> IpcResult<ChatSendRes> {
    let request = build_request(&payload)?;
    // Resolved before the turn id is claimed, so an unconfigured endpoint is a
    // refusal rather than a claimed id with nothing behind it.
    let router = state
        .providers
        .router_for(&payload.provider_id, request.model_id.as_str())?;

    let cancel = turns.begin(&payload.turn_id).ok_or_else(|| {
        IpcError::invalid(format!(
            "invalid turnId: `{}` is already streaming",
            payload.turn_id
        ))
    })?;

    let turn_id = payload.turn_id.clone();
    // Cloned rather than borrowed from `State`: the task outlives this call.
    let turns_handle = turns.inner().clone();
    tauri::async_runtime::spawn(async move {
        let mut sink = WindowSink {
            app,
            turn_id: turn_id.clone(),
        };
        run_turn(
            router,
            request,
            RequestContext::new().with_cancel(cancel),
            &mut sink,
        )
        .await;
        turns_handle.finish(&turn_id);
    });

    Ok(ChatSendRes {
        turn_id: payload.turn_id,
        accepted: true,
    })
}

#[tauri::command]
pub fn chat_cancel(
    turns: State<'_, ChatTurns>,
    payload: ChatCancelReq,
) -> IpcResult<ChatCancelRes> {
    if payload.turn_id.trim().is_empty() {
        return Err(IpcError::invalid("invalid turnId: must not be blank"));
    }
    Ok(ChatCancelRes {
        cancelled: turns.cancel(&payload.turn_id),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use vela_providers::{Candidate, EchoProvider};

    fn request(turn: &str) -> ChatSendReq {
        ChatSendReq {
            turn_id: turn.to_owned(),
            provider_id: "configured-endpoint".to_owned(),
            model_id: "some-model".to_owned(),
            messages: vec![ChatMessageInput::text(MessageRole::User, "hello")],
            tools: Vec::new(),
            tool_choice: ToolChoice::Auto,
        }
    }

    fn tool(name: &str) -> ToolDefinition {
        ToolDefinition::new(
            name,
            "look something up",
            serde_json::json!({"type": "object", "properties": {}}),
        )
    }

    fn png_part() -> ContentPartDto {
        ContentPartDto::Image {
            mime_type: "image/png".into(),
            data: vela_providers::base64_encode(&[0x89, b'P', b'N', b'G']),
        }
    }

    #[test]
    fn a_well_formed_turn_becomes_a_provider_request() {
        let built = build_request(&request("t1")).expect("valid");
        assert_eq!(built.model_id, "some-model");
        assert_eq!(built.messages.len(), 1);
        assert_eq!(built.messages[0].answer_text(), "hello");
    }

    #[test]
    fn a_blank_turn_id_is_rejected_before_anything_else() {
        let mut req = request("   ");
        req.provider_id = String::new();
        let error = build_request(&req).expect_err("blank turnId");
        assert!(error.message.contains("turnId"), "{}", error.message);
    }

    #[test]
    fn a_turn_with_no_messages_is_rejected() {
        let mut req = request("t1");
        req.messages.clear();
        let error = build_request(&req).expect_err("no messages");
        assert!(error.message.contains("at least one message"));
    }

    #[test]
    fn an_oversized_message_is_rejected_and_names_its_index() {
        let mut req = request("t1");
        req.messages.push(ChatMessageInput::text(
            MessageRole::User,
            "x".repeat(MAX_MESSAGE_BYTES + 1),
        ));
        let error = build_request(&req).expect_err("oversized");
        assert!(error.message.contains("messages[1]"), "{}", error.message);
    }

    #[test]
    fn an_unconfigured_provider_is_not_found_rather_than_a_substitute() {
        let providers = ProviderHost::new(
            Arc::new(vela_secrets::MemoryStore::new()),
            Arc::new(vela_providers::http::testing::ScriptedTransport::new(
                Vec::new(),
            )),
        );
        let Err(error) = resolve_provider(&providers, "absent") else {
            panic!("an unconfigured id must not resolve to a provider");
        };
        assert_eq!(error.code, super::super::IpcErrorCode::NotFound);
    }

    /* ------------------------------------------------------------------ */
    /* the widened contract                                               */
    /* ------------------------------------------------------------------ */

    #[test]
    fn an_image_reaches_the_provider_request_instead_of_being_dropped() {
        let mut req = request("t1");
        req.messages[0].text = "what is in this picture?".into();
        req.messages[0].parts = vec![png_part()];

        let built = build_request(&req).expect("valid");
        assert!(
            built.needs_vision(),
            "the provider layer must see this turn as needing vision"
        );
        assert!(matches!(
            built.messages[0].parts.as_slice(),
            [ContentPart::Text { .. }, ContentPart::Image { .. }]
        ));
    }

    #[test]
    fn text_and_parts_compose_in_the_order_the_user_sees() {
        let mut req = request("t1");
        req.messages[0].text = "before".into();
        req.messages[0].parts = vec![png_part(), ContentPartDto::text("after")];
        let built = build_request(&req).unwrap();
        assert_eq!(built.messages[0].parts.len(), 3);
        assert!(matches!(
            &built.messages[0].parts[0],
            ContentPart::Text { text } if text == "before"
        ));
        assert!(matches!(
            &built.messages[0].parts[2],
            ContentPart::Text { text } if text == "after"
        ));
    }

    #[test]
    fn an_image_only_message_carries_no_empty_text_part() {
        // An empty leading text part is not free: several encoders emit it as a
        // content block, and at least one profile treats an empty string
        // content block as a malformed request.
        let mut req = request("t1");
        req.messages[0].text = String::new();
        req.messages[0].parts = vec![png_part()];
        let built = build_request(&req).unwrap();
        assert_eq!(built.messages[0].parts.len(), 1);
        assert!(matches!(
            built.messages[0].parts[0],
            ContentPart::Image { .. }
        ));
    }

    #[test]
    fn a_message_with_no_parts_field_is_exactly_what_it_always_was() {
        // Backward compatibility, asserted rather than assumed: the shape the
        // renderer has sent since Phase A still means one text part.
        let payload: ChatSendReq = serde_json::from_str(
            r#"{"turnId":"t1","providerId":"p","modelId":"m",
                "messages":[{"role":"user","text":"hello"}]}"#,
        )
        .unwrap();
        let built = build_request(&payload).unwrap();
        assert_eq!(built.messages[0].parts.len(), 1);
        assert_eq!(built.messages[0].answer_text(), "hello");
        assert!(built.tools.is_empty());
        assert_eq!(built.tool_choice, ToolChoice::Auto);
    }

    #[test]
    fn a_tool_catalogue_reaches_the_provider_request() {
        let mut req = request("t1");
        req.tools = vec![tool("get_weather")];
        let built = build_request(&req).expect("valid");
        assert!(built.offers_tools());
        assert_eq!(built.tools[0].name, "get_weather");
    }

    #[test]
    fn a_named_tool_choice_must_name_a_tool_that_was_offered() {
        let mut req = request("t1");
        req.tools = vec![tool("get_weather")];
        req.tool_choice = ToolChoice::Named {
            name: "delete_everything".into(),
        };
        let error = build_request(&req).expect_err("unoffered tool");
        assert!(error.message.contains("toolChoice"), "{}", error.message);

        req.tool_choice = ToolChoice::Named {
            name: "get_weather".into(),
        };
        build_request(&req).expect("a tool that was offered is fine");
    }

    #[test]
    fn requiring_a_tool_call_with_no_tools_offered_is_refused_rather_than_hanging_the_turn() {
        let mut req = request("t1");
        req.tool_choice = ToolChoice::Required;
        let error = build_request(&req).expect_err("unsatisfiable");
        assert!(error.message.contains("can never be satisfied"));
    }

    #[test]
    fn two_tools_with_one_name_are_refused_because_a_call_names_a_tool_not_an_index() {
        let mut req = request("t1");
        req.tools = vec![tool("f"), tool("f")];
        let error = build_request(&req).expect_err("duplicate");
        assert!(error.message.contains("offered twice"), "{}", error.message);
    }

    #[test]
    fn a_tool_schema_that_is_not_an_object_is_refused() {
        let mut req = request("t1");
        req.tools = vec![ToolDefinition::new("f", "", serde_json::json!("a string"))];
        let error = build_request(&req).expect_err("not a schema");
        assert!(error.message.contains("parameters"), "{}", error.message);
    }

    #[test]
    fn a_tool_result_can_be_fed_back_as_its_own_message() {
        // The other half of tool calling: without this the model can ask, and
        // nothing can answer.
        let mut req = request("t1");
        req.messages.push(ChatMessageInput {
            role: MessageRole::Tool,
            text: String::new(),
            parts: vec![ContentPartDto::ToolResult {
                call_id: "call_1".into(),
                content: "17C".into(),
                is_error: false,
            }],
        });
        let built = build_request(&req).unwrap();
        assert!(matches!(
            built.messages[1].parts[0],
            ContentPart::ToolResult { .. }
        ));
    }

    #[test]
    fn a_malformed_part_names_the_message_and_the_part_that_was_wrong() {
        let mut req = request("t1");
        req.messages.push(ChatMessageInput {
            role: MessageRole::User,
            text: String::new(),
            parts: vec![ContentPartDto::Image {
                mime_type: "image/png".into(),
                data: "%%%".into(),
            }],
        });
        let error = build_request(&req).expect_err("bad base64");
        assert!(
            error.message.contains("messages[1].parts[0].data"),
            "{}",
            error.message
        );
    }

    #[test]
    fn a_turn_id_can_only_be_claimed_once_while_it_is_live() {
        let turns = ChatTurns::new();
        assert!(turns.begin("t1").is_some());
        assert!(
            turns.begin("t1").is_none(),
            "a live id must not be reusable"
        );
        turns.finish("t1");
        assert!(turns.begin("t1").is_some(), "a finished id is free again");
    }

    #[test]
    fn cancelling_an_unknown_turn_is_false_and_not_an_error() {
        let turns = ChatTurns::new();
        assert!(!turns.cancel("nobody"));
        let token = turns.begin("t1").expect("claimed");
        assert!(turns.cancel("t1"));
        assert!(token.is_cancelled());
    }

    #[test]
    fn finishing_a_turn_releases_it_from_the_registry() {
        let turns = ChatTurns::new();
        turns.begin("t1");
        assert_eq!(turns.in_flight(), 1);
        turns.finish("t1");
        turns.finish("t1"); // idempotent
        assert_eq!(turns.in_flight(), 0);
    }

    /// The guarantee the renderer's stream reducer is built on: whatever
    /// happens, the sink sees exactly one terminal event.
    #[test]
    fn a_driven_turn_always_terminates_the_stream_exactly_once() {
        let provider: Arc<dyn Provider> = Arc::new(EchoProvider::new("configured-endpoint"));
        let built = build_request(&request("t1")).expect("valid");
        let mut sink: Vec<StreamEvent> = Vec::new();

        tauri::async_runtime::block_on(run_turn(
            Router::new(vec![Candidate::new(provider, "some-model")]),
            built,
            RequestContext::new(),
            &mut sink,
        ));

        let terminals = sink.iter().filter(|event| event.is_terminal()).count();
        assert_eq!(terminals, 1, "events: {sink:?}");
        assert!(matches!(sink.last(), Some(StreamEvent::Done { .. })));
        assert!(
            sink.iter()
                .any(|event| matches!(event, StreamEvent::TextDelta { .. })),
            "a turn must produce at least one delta before it ends"
        );
    }

    #[test]
    fn a_cancelled_turn_still_terminates_rather_than_hanging_the_renderer() {
        let provider: Arc<dyn Provider> = Arc::new(EchoProvider::new("configured-endpoint"));
        let built = build_request(&request("t1")).expect("valid");
        let cancel = CancelToken::new();
        cancel.cancel();
        let mut sink: Vec<StreamEvent> = Vec::new();

        tauri::async_runtime::block_on(run_turn(
            Router::new(vec![Candidate::new(provider, "some-model")]),
            built,
            RequestContext::new().with_cancel(cancel),
            &mut sink,
        ));

        assert_eq!(sink.iter().filter(|e| e.is_terminal()).count(), 1);
    }

    /* ------------------------------------------------------------------ */
    /* routing                                                            */
    /* ------------------------------------------------------------------ */

    fn empty_host() -> ProviderHost {
        ProviderHost::new(
            Arc::new(vela_secrets::MemoryStore::new()),
            Arc::new(vela_providers::http::testing::ScriptedTransport::new(
                Vec::new(),
            )),
        )
    }

    #[test]
    fn a_turn_addressed_to_an_unconfigured_endpoint_gets_no_router_at_all() {
        // Same answer `resolve_provider` gives, at the surface that actually
        // sends turns. A router that quietly dropped the missing primary and
        // ran the *other* endpoints would send the user's prompt somewhere
        // they never pointed it.
        let error = empty_host().router_for("absent", "m").unwrap_err();
        assert_eq!(error.code, super::super::IpcErrorCode::NotFound);
    }

    #[test]
    fn the_endpoint_the_user_chose_is_the_first_candidate_and_the_rest_follow_it() {
        let host = empty_host();
        // Configured out of alphabetical order, and asked for last-in-order.
        host.install(
            &vela_settings::ProviderConfig::local("aaa", "A", "http://127.0.0.1:8081/v1")
                .unwrap()
                .with_model("model-a"),
        )
        .unwrap();
        host.install(
            &vela_settings::ProviderConfig::local("zzz", "Z", "http://127.0.0.1:8082/v1")
                .unwrap()
                .with_model("model-z"),
        )
        .unwrap();

        let router = host.router_for("zzz", "chosen-model").unwrap();
        assert_eq!(
            router.candidate_ids(),
            vec!["zzz".to_string(), "aaa".to_string()],
            "the chosen endpoint leads; nothing outranks it"
        );
        assert_eq!(
            router.candidate_models(),
            vec!["chosen-model".to_string(), "model-a".to_string()],
            "the primary answers about the model the user picked; a fallback \
             about its own, because `chosen-model` is not a name on that box"
        );
    }

    #[test]
    fn an_endpoint_with_no_model_of_its_own_is_not_a_fallback() {
        let host = empty_host();
        host.install(
            &vela_settings::ProviderConfig::local("primary", "P", "http://127.0.0.1:8081/v1")
                .unwrap(),
        )
        .unwrap();
        // No `.with_model(..)`: nothing records what to ask this box for.
        host.install(
            &vela_settings::ProviderConfig::local("silent", "S", "http://127.0.0.1:8082/v1")
                .unwrap(),
        )
        .unwrap();

        let router = host.router_for("primary", "m").unwrap();
        assert_eq!(
            router.candidate_ids(),
            vec!["primary".to_string()],
            "Vela does not invent a model name for a box that never named one"
        );
    }

    #[test]
    fn a_fallback_that_cannot_authenticate_is_left_out_rather_than_asked() {
        // Left in, it would answer `AuthFailed` — which the router never fails
        // over — and a "the box you chose is down" turn would surface as a
        // credential error about an endpoint the user did not choose.
        let host = empty_host();
        host.install(
            &vela_settings::ProviderConfig::local("primary", "P", "http://127.0.0.1:8081/v1")
                .unwrap(),
        )
        .unwrap();
        host.install(
            &vela_settings::ProviderConfig::local("locked", "L", "https://api.example.test/v1")
                .unwrap()
                .with_auth(
                    &vela_core::auth::AuthMode::BearerToken,
                    vela_core::auth::AuthRequirement::Required,
                )
                .unwrap()
                .with_model("model-l"),
        )
        .unwrap();

        assert_eq!(
            host.router_for("primary", "m").unwrap().candidate_ids(),
            vec!["primary".to_string()]
        );
    }

    #[test]
    fn the_endpoint_the_user_chose_is_never_filtered_out_of_its_own_turn() {
        // The mirror of the two tests above. A missing required credential on
        // the *selected* endpoint is the error the user needs to read, not a
        // reason to route their prompt to somebody else.
        let host = empty_host();
        host.install(
            &vela_settings::ProviderConfig::local("locked", "L", "https://api.example.test/v1")
                .unwrap()
                .with_auth(
                    &vela_core::auth::AuthMode::BearerToken,
                    vela_core::auth::AuthRequirement::Required,
                )
                .unwrap(),
        )
        .unwrap();
        host.install(
            &vela_settings::ProviderConfig::local("other", "O", "http://127.0.0.1:8082/v1")
                .unwrap()
                .with_model("model-o"),
        )
        .unwrap();

        let router = host.router_for("locked", "m").unwrap();
        assert_eq!(router.candidate_ids()[0], "locked");
    }
}
