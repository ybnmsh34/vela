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

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use vela_providers::event::{EventSink, StreamEvent};
use vela_providers::model::{ChatMessage, ChatRequest, MessageRole};
use vela_providers::provider::{CancelToken, Provider, RequestContext};
use vela_providers::ProviderRegistry;

use super::{IpcError, IpcResult};
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

/* -------------------------------------------------------------------------- */
/* wire types                                                                 */
/* -------------------------------------------------------------------------- */

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageInput {
    pub role: MessageRole,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSendReq {
    pub turn_id: String,
    pub provider_id: String,
    pub model_id: String,
    pub messages: Vec<ChatMessageInput>,
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
    for (index, message) in req.messages.iter().enumerate() {
        if message.text.len() > MAX_MESSAGE_BYTES {
            return Err(IpcError::invalid(format!(
                "invalid messages[{index}]: exceeds {MAX_MESSAGE_BYTES} bytes"
            )));
        }
    }

    Ok(ChatRequest::new(req.model_id.trim()).with_messages(
        req.messages
            .iter()
            .map(|message| ChatMessage::new(message.role, vec![text_part(&message.text)])),
    ))
}

fn text_part(text: &str) -> vela_providers::model::ContentPart {
    vela_providers::model::ContentPart::Text {
        text: text.to_owned(),
    }
}

/// Resolves the backend for this turn. `NOT_FOUND` is the honest answer for an
/// id that is not configured — never a fallback to "some other provider".
pub fn resolve_provider(
    registry: &ProviderRegistry,
    provider_id: &str,
) -> IpcResult<std::sync::Arc<dyn Provider>> {
    registry.get(provider_id).ok_or_else(|| {
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
/// Split out from the command so it can be tested with a `Vec<StreamEvent>`
/// sink and an in-process provider — no window, no runtime, no endpoint.
pub async fn run_turn(
    provider: std::sync::Arc<dyn Provider>,
    request: ChatRequest,
    context: RequestContext,
    sink: &mut dyn EventSink,
) {
    let mut tracking = TerminalTracking {
        inner: sink,
        saw_terminal: false,
    };
    let outcome = provider.stream(request, &mut tracking, &context).await;
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
struct WindowSink {
    app: AppHandle,
    turn_id: String,
}

impl EventSink for WindowSink {
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
pub fn chat_send(
    app: AppHandle,
    state: State<'_, AppState>,
    turns: State<'_, ChatTurns>,
    payload: ChatSendReq,
) -> IpcResult<ChatSendRes> {
    let request = build_request(&payload)?;
    let provider = resolve_provider(state.providers.as_ref(), &payload.provider_id)?;

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
            provider,
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
    use vela_providers::EchoProvider;

    fn request(turn: &str) -> ChatSendReq {
        ChatSendReq {
            turn_id: turn.to_owned(),
            provider_id: "configured-endpoint".to_owned(),
            model_id: "some-model".to_owned(),
            messages: vec![ChatMessageInput {
                role: MessageRole::User,
                text: "hello".to_owned(),
            }],
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
        req.messages.push(ChatMessageInput {
            role: MessageRole::User,
            text: "x".repeat(MAX_MESSAGE_BYTES + 1),
        });
        let error = build_request(&req).expect_err("oversized");
        assert!(error.message.contains("messages[1]"), "{}", error.message);
    }

    #[test]
    fn an_unconfigured_provider_is_not_found_rather_than_a_substitute() {
        let registry = ProviderRegistry::new();
        let Err(error) = resolve_provider(&registry, "absent") else {
            panic!("an unconfigured id must not resolve to a provider");
        };
        assert_eq!(error.code, super::super::IpcErrorCode::NotFound);
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

        tauri::async_runtime::block_on(run_turn(provider, built, RequestContext::new(), &mut sink));

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
            provider,
            built,
            RequestContext::new().with_cancel(cancel),
            &mut sink,
        ));

        assert_eq!(sink.iter().filter(|e| e.is_terminal()).count(), 1);
    }
}
