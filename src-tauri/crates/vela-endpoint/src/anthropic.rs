//! The Anthropic-compatible half: `POST /v1/messages`.
//!
//! ## What is confirmed and what is assumed
//!
//! The **event names** are the confirmed part.
//! `docs/references/unsloth-studio.md` §3 records the sequence as
//! `message_start`, `content_block_start`, `content_block_delta`,
//! `content_block_stop`, `message_delta`, `message_stop`, and notes that this
//! is consistent with Anthropic's own public Messages API. That is what
//! [`StreamEncoder`] emits and what its tests assert by name.
//!
//! The **client-side `tool_result` request shape** — the block a client sends
//! back carrying a tool's output — is marked **UNVERIFIED** by the study: it
//! could not find the shape stated in any fetched source. The decoder below
//! reads `{"type":"tool_result","tool_use_id":…,"content":…,"is_error":…}`,
//! which is Anthropic's published shape and the only candidate, but it is an
//! assumption and is labelled as one here rather than presented as confirmed.
//!
//! ## What this half does not do
//!
//! - **Reasoning is not forwarded.** Vela separates a model's reasoning into
//!   its own `ContentPart`, and `thinking` blocks would be the place to put it.
//!   `StreamEncoder` drops `ReasoningDelta` on the floor. That is a real
//!   reduction and it is written down here rather than left for a client to
//!   discover; nothing in this crate claims otherwise.
//! - **Tool-use blocks are not streamed incrementally.** A tool call is emitted
//!   as a complete `content_block_start` / `input_json_delta` /
//!   `content_block_stop` triple at the end of the turn, built from the
//!   assembled `ChatResponse`. That is where a call is first declared
//!   well-formed — `ToolCallDelta`'s own doc says it is "deliberately not
//!   enough to execute a call" — so emitting from the deltas would mean
//!   forwarding fragments Vela does not yet consider a call.

use serde_json::{json, Value};
use vela_providers::model::{
    ChatMessage, ChatRequest, ChatResponse, ContentPart, MessageRole, Sampling, ToolCallOutcome,
    ToolDefinition,
};
use vela_providers::sse::SseFrame;
use vela_providers::StreamEvent;

use crate::route::anthropic_stop_reason;
use crate::{tool_choice, DecodeError, Decoded};

/* -------------------------------------------------------------------------- */
/* decode                                                                     */
/* -------------------------------------------------------------------------- */

/// `POST /v1/messages` body → a Vela turn.
pub fn decode(body: &[u8]) -> Result<Decoded, DecodeError> {
    let root: Value = serde_json::from_slice(body).map_err(|_| DecodeError::NotJson)?;

    let model = root
        .get("model")
        .and_then(Value::as_str)
        .ok_or(DecodeError::MissingModel)?;

    let mut messages: Vec<ChatMessage> = Vec::new();

    // `system` is a top-level field here, not a message. Vela has a `System`
    // role, so it becomes the first message — which is also where every other
    // dialect puts it, so the transcript that reaches the model is the same
    // shape whichever door the request came in by.
    if let Some(system) = root.get("system") {
        let text = flatten_text(system).ok_or(DecodeError::BadContentBlock)?;
        if !text.is_empty() {
            messages.push(ChatMessage::system(text));
        }
    }

    let wire_messages = root
        .get("messages")
        .and_then(Value::as_array)
        .ok_or(DecodeError::MissingMessages)?;

    for message in wire_messages {
        decode_message(message, &mut messages)?;
    }

    let mut request = ChatRequest::new(model).with_messages(messages);

    if let Some(tools) = root.get("tools") {
        request = request.with_tools(decode_tools(tools)?);
    }
    if let Some(choice) = root.get("tool_choice") {
        request = request.with_tool_choice(
            tool_choice::from_anthropic(choice).ok_or(DecodeError::BadToolChoice)?,
        );
    }
    if let Some(max) = root.get("max_tokens").and_then(Value::as_u64) {
        request = request.with_max_output_tokens(max.min(u64::from(u32::MAX)) as u32);
    }
    request = request.with_sampling(Sampling {
        temperature: root
            .get("temperature")
            .and_then(Value::as_f64)
            .map(|value| value as f32),
        top_p: root
            .get("top_p")
            .and_then(Value::as_f64)
            .map(|value| value as f32),
        stop: root
            .get("stop_sequences")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        seed: None,
    });

    Ok(Decoded {
        chat: request,
        stream: root.get("stream").and_then(Value::as_bool).unwrap_or(false),
    })
}

/// One wire message becomes one **or more** Vela messages.
///
/// Anthropic carries tool results inside a `user` message; Vela has a `Tool`
/// role and `contract-harness.ts`'s accumulation rule says one message per tool
/// result. So a user message holding tool results is split: each result becomes
/// its own `Tool` message, in block order, and whatever else the message held
/// stays behind as the `User` message. A message that was nothing but results
/// produces no user message at all rather than an empty one.
fn decode_message(message: &Value, out: &mut Vec<ChatMessage>) -> Result<(), DecodeError> {
    let role = match message.get("role").and_then(Value::as_str) {
        Some("user") => MessageRole::User,
        Some("assistant") => MessageRole::Assistant,
        // `system` is the top-level field, not a role, and anything else is a
        // vocabulary this endpoint does not have. Refused rather than coerced.
        _ => return Err(DecodeError::BadRole),
    };

    let content = message.get("content").ok_or(DecodeError::BadContentBlock)?;

    if let Some(text) = content.as_str() {
        out.push(ChatMessage::new(role, vec![ContentPart::text(text)]));
        return Ok(());
    }

    let blocks = content.as_array().ok_or(DecodeError::BadContentBlock)?;
    let mut own: Vec<ContentPart> = Vec::new();

    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                let text = block
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or(DecodeError::BadContentBlock)?;
                own.push(ContentPart::text(text));
            }
            Some("image") => own.push(decode_image(block)?),
            Some("tool_use") => {
                let call_id = block
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or(DecodeError::BadContentBlock)?;
                let name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or(DecodeError::BadContentBlock)?;
                own.push(ContentPart::ToolCall {
                    call_id: call_id.to_string(),
                    name: name.to_string(),
                    arguments: block.get("input").cloned().unwrap_or_else(|| json!({})),
                });
            }
            // UNVERIFIED shape — see the module docs.
            Some("tool_result") => {
                let call_id = block
                    .get("tool_use_id")
                    .and_then(Value::as_str)
                    .ok_or(DecodeError::BadContentBlock)?;
                let text = block
                    .get("content")
                    .map(|content| flatten_text(content).ok_or(DecodeError::BadContentBlock))
                    .transpose()?
                    .unwrap_or_default();
                out.push(ChatMessage::new(
                    MessageRole::Tool,
                    vec![ContentPart::ToolResult {
                        call_id: call_id.to_string(),
                        content: text,
                        is_error: block
                            .get("is_error")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    }],
                ));
            }
            _ => return Err(DecodeError::BadContentBlock),
        }
    }

    if !own.is_empty() {
        out.push(ChatMessage::new(role, own));
    }
    Ok(())
}

fn decode_image(block: &Value) -> Result<ContentPart, DecodeError> {
    let source = block.get("source").ok_or(DecodeError::BadImage)?;
    // Only `base64`. A `url` source would mean this endpoint fetching a remote
    // resource on a caller's behalf, which is a network capability Vela's whole
    // architecture keeps in one place and it is not this one.
    if source.get("type").and_then(Value::as_str) != Some("base64") {
        return Err(DecodeError::BadImage);
    }
    let mime_type = source
        .get("media_type")
        .and_then(Value::as_str)
        .ok_or(DecodeError::BadImage)?;
    let data = source
        .get("data")
        .and_then(Value::as_str)
        .ok_or(DecodeError::BadImage)?;
    Ok(ContentPart::Image {
        mime_type: mime_type.to_string(),
        data: vela_providers::base64_decode(data).ok_or(DecodeError::BadImage)?,
    })
}

fn decode_tools(tools: &Value) -> Result<Vec<ToolDefinition>, DecodeError> {
    let entries = tools.as_array().ok_or(DecodeError::BadTool)?;
    entries
        .iter()
        .map(|tool| {
            let name = tool
                .get("name")
                .and_then(Value::as_str)
                .ok_or(DecodeError::BadTool)?;
            Ok(ToolDefinition::new(
                name,
                tool.get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                tool.get("input_schema")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
            ))
        })
        .collect()
}

/// A string, or an array of text blocks, as one string. `None` for anything
/// else — a shape this endpoint cannot read is refused, not silently emptied.
fn flatten_text(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    let blocks = value.as_array()?;
    let mut out = String::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => out.push_str(block.get("text")?.as_str()?),
            _ => return None,
        }
    }
    Some(out)
}

/* -------------------------------------------------------------------------- */
/* encode                                                                     */
/* -------------------------------------------------------------------------- */

/// The whole assembled turn, in the non-streaming `/v1/messages` shape.
pub fn encode_message(response: &ChatResponse, message_id: &str, model: &str) -> Value {
    let mut content: Vec<Value> = Vec::new();
    let text = response.answer_text();
    if !text.is_empty() {
        content.push(json!({ "type": "text", "text": text }));
    }
    for call in response.tool_calls.iter() {
        if let ToolCallOutcome::Ok {
            call_id,
            name,
            arguments,
            ..
        } = call
        {
            content.push(json!({
                "type": "tool_use",
                "id": call_id,
                "name": name,
                "input": arguments,
            }));
        }
    }

    json!({
        "id": message_id,
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content,
        "stop_reason": anthropic_stop_reason(response.stop_reason),
        "stop_sequence": Value::Null,
        "usage": usage_json(response),
    })
}

/// `input_tokens` and `output_tokens` are required fields on Anthropic's usage
/// object, and Vela's are `Option` with `None` meaning **not reported** — the
/// normal case for a local runtime.
///
/// This writes `0` for an unreported count, and that is a lie the wire format
/// forces: the field cannot be omitted and cannot be null. It is confined to
/// this function, and `TokenUsage::is_unreported` remains the truth on Vela's
/// side of the seam. A client reading `0` here should read it as "this endpoint
/// does not count tokens", which is what every local endpoint Vela targets
/// does.
fn usage_json(response: &ChatResponse) -> Value {
    json!({
        "input_tokens": response.usage.input_tokens.unwrap_or(0),
        "output_tokens": response.usage.output_tokens.unwrap_or(0),
    })
}

/// Turns Vela's six-event stream into Anthropic's SSE vocabulary.
///
/// Stateful because the wire format is: a text block has to be opened before it
/// can be delta'd and closed after, and only the encoder knows whether one is
/// open. Frames come back in a `Vec` rather than being written directly so the
/// encoder stays testable without a socket.
pub struct StreamEncoder {
    message_id: String,
    model: String,
    text_open: bool,
    next_index: u32,
}

impl StreamEncoder {
    pub fn new(message_id: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            message_id: message_id.into(),
            model: model.into(),
            text_open: false,
            next_index: 0,
        }
    }

    /// `message_start`, emitted before the brain has produced anything, because
    /// a client that has not seen it does not yet believe it has a message.
    pub fn opening(&self) -> Vec<SseFrame> {
        vec![frame(
            "message_start",
            json!({
                "type": "message_start",
                "message": {
                    "id": self.message_id,
                    "type": "message",
                    "role": "assistant",
                    "model": self.model,
                    "content": [],
                    "stop_reason": Value::Null,
                    "stop_sequence": Value::Null,
                    "usage": { "input_tokens": 0, "output_tokens": 0 },
                }
            }),
        )]
    }

    pub fn on_event(&mut self, event: &StreamEvent) -> Vec<SseFrame> {
        match event {
            StreamEvent::TextDelta { text } => {
                let mut frames = self.open_text_block();
                frames.push(frame(
                    "content_block_delta",
                    json!({
                        "type": "content_block_delta",
                        "index": 0,
                        "delta": { "type": "text_delta", "text": text },
                    }),
                ));
                frames
            }
            // Dropped. See the module docs: forwarding reasoning is not built.
            StreamEvent::ReasoningDelta { .. } => Vec::new(),
            // Dropped. Tool calls are emitted whole at `Done`, from the place a
            // call is first declared well-formed.
            StreamEvent::ToolCallDelta { .. } => Vec::new(),
            // Usage rides on `message_delta`; there is no separate usage event
            // in this vocabulary.
            StreamEvent::Usage { .. } => Vec::new(),
            StreamEvent::Done { response } => self.closing(response),
            StreamEvent::Error { error } => vec![frame(
                "error",
                json!({
                    "type": "error",
                    "error": { "type": "api_error", "message": crate::error_code(error) },
                }),
            )],
        }
    }

    fn open_text_block(&mut self) -> Vec<SseFrame> {
        if self.text_open {
            return Vec::new();
        }
        self.text_open = true;
        self.next_index = 1;
        vec![frame(
            "content_block_start",
            json!({
                "type": "content_block_start",
                "index": 0,
                "content_block": { "type": "text", "text": "" },
            }),
        )]
    }

    fn closing(&mut self, response: &ChatResponse) -> Vec<SseFrame> {
        let mut frames = Vec::new();

        // A backend that cannot stream emits no `TextDelta` at all — the whole
        // answer arrives on `Done`. Without this the client would receive a
        // message with no content and no error, which is the worst of the three
        // possible outcomes.
        let text = response.answer_text();
        if !self.text_open && !text.is_empty() {
            frames.extend(self.open_text_block());
            frames.push(frame(
                "content_block_delta",
                json!({
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": { "type": "text_delta", "text": text },
                }),
            ));
        }
        if self.text_open {
            frames.push(frame(
                "content_block_stop",
                json!({ "type": "content_block_stop", "index": 0 }),
            ));
        }

        for call in response.tool_calls.iter() {
            let ToolCallOutcome::Ok {
                call_id,
                name,
                arguments,
                ..
            } = call
            else {
                // A malformed call is evidence for Vela's own UI, not something
                // to hand a client as a call it should execute.
                continue;
            };
            let index = self.next_index;
            self.next_index += 1;
            frames.push(frame(
                "content_block_start",
                json!({
                    "type": "content_block_start",
                    "index": index,
                    "content_block": { "type": "tool_use", "id": call_id, "name": name, "input": {} },
                }),
            ));
            frames.push(frame(
                "content_block_delta",
                json!({
                    "type": "content_block_delta",
                    "index": index,
                    "delta": {
                        "type": "input_json_delta",
                        "partial_json": serde_json::to_string(arguments).unwrap_or_default(),
                    },
                }),
            ));
            frames.push(frame(
                "content_block_stop",
                json!({ "type": "content_block_stop", "index": index }),
            ));
        }

        frames.push(frame(
            "message_delta",
            json!({
                "type": "message_delta",
                "delta": {
                    "stop_reason": anthropic_stop_reason(response.stop_reason),
                    "stop_sequence": Value::Null,
                },
                "usage": { "output_tokens": response.usage.output_tokens.unwrap_or(0) },
            }),
        ));
        frames.push(frame("message_stop", json!({ "type": "message_stop" })));
        frames
    }
}

/// An error body in this dialect, for the paths that fail before a turn opens.
pub fn error_body(kind: &str, message: &str) -> Value {
    json!({ "type": "error", "error": { "type": kind, "message": message } })
}

fn frame(event: &str, data: Value) -> SseFrame {
    SseFrame {
        event: Some(event.to_string()),
        data: data.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vela_providers::model::{StopReason, TokenUsage, ToolChoice};

    fn decode_or_panic(body: &str) -> Decoded {
        decode(body.as_bytes()).expect("body must decode")
    }

    #[test]
    fn a_system_field_becomes_the_first_message_rather_than_being_dropped() {
        let decoded = decode_or_panic(
            r#"{"model":"m","max_tokens":16,"system":"be brief",
                "messages":[{"role":"user","content":"hi"}]}"#,
        );
        assert_eq!(decoded.chat.messages[0].role, MessageRole::System);
        assert_eq!(decoded.chat.messages[0].answer_text(), "be brief");
        assert_eq!(decoded.chat.messages[1].role, MessageRole::User);
        assert_eq!(decoded.chat.max_output_tokens, Some(16));
    }

    #[test]
    fn a_tool_result_block_becomes_its_own_tool_role_message() {
        // The UNVERIFIED shape, decoded. If the real shape turns out to differ
        // this test is what will have to change, and it names the assumption.
        let decoded = decode_or_panic(
            r#"{"model":"m","messages":[
                 {"role":"assistant","content":[
                   {"type":"tool_use","id":"c1","name":"bash","input":{"cmd":"ls"}}]},
                 {"role":"user","content":[
                   {"type":"tool_result","tool_use_id":"c1","content":"a\nb"},
                   {"type":"text","text":"and now?"}]}]}"#,
        );
        let roles: Vec<MessageRole> = decoded.chat.messages.iter().map(|m| m.role).collect();
        assert_eq!(
            roles,
            vec![MessageRole::Assistant, MessageRole::Tool, MessageRole::User]
        );
        assert!(matches!(
            &decoded.chat.messages[1].parts[0],
            ContentPart::ToolResult { call_id, content, is_error }
                if call_id == "c1" && content == "a\nb" && !is_error
        ));
        assert_eq!(decoded.chat.messages[2].answer_text(), "and now?");
    }

    #[test]
    fn tools_and_the_named_tool_choice_survive_decoding() {
        let decoded = decode_or_panic(
            r#"{"model":"m","messages":[{"role":"user","content":"hi"}],
                "tools":[{"name":"bash","description":"run","input_schema":{"type":"object"}}],
                "tool_choice":{"type":"tool","name":"bash"}}"#,
        );
        assert_eq!(decoded.chat.tools.len(), 1);
        assert_eq!(decoded.chat.tools[0].name, "bash");
        assert_eq!(
            decoded.chat.tool_choice,
            ToolChoice::Named {
                name: "bash".to_string()
            }
        );
    }

    #[test]
    fn an_unreadable_body_is_refused_rather_than_partly_understood() {
        assert_eq!(decode(b"not json"), Err(DecodeError::NotJson));
        assert_eq!(
            decode(br#"{"messages":[]}"#),
            Err(DecodeError::MissingModel)
        );
        assert_eq!(
            decode(br#"{"model":"m"}"#),
            Err(DecodeError::MissingMessages)
        );
        assert_eq!(
            decode(br#"{"model":"m","messages":[{"role":"system","content":"x"}]}"#),
            Err(DecodeError::BadRole)
        );
        assert_eq!(
            decode(
                br#"{"model":"m","messages":[{"role":"user","content":"x"}],
                     "tool_choice":{"type":"whatever"}}"#
            ),
            Err(DecodeError::BadToolChoice)
        );
    }

    fn response_with(text: &str, calls: Vec<ToolCallOutcome>, stop: StopReason) -> ChatResponse {
        let mut response = ChatResponse::empty();
        if !text.is_empty() {
            response.parts.push(ContentPart::text(text));
        }
        response.tool_calls = calls;
        response.stop_reason = stop;
        response.usage = TokenUsage {
            output_tokens: Some(3),
            ..TokenUsage::default()
        };
        response
    }

    fn event_names(frames: &[SseFrame]) -> Vec<String> {
        frames
            .iter()
            .map(|f| f.event.clone().unwrap_or_default())
            .collect()
    }

    #[test]
    fn a_streamed_answer_uses_anthropics_documented_event_names_in_order() {
        let mut encoder = StreamEncoder::new("msg_1", "m");
        let mut frames = encoder.opening();
        frames.extend(encoder.on_event(&StreamEvent::TextDelta {
            text: "he".to_string(),
        }));
        frames.extend(encoder.on_event(&StreamEvent::TextDelta {
            text: "llo".to_string(),
        }));
        frames.extend(encoder.on_event(&StreamEvent::Done {
            response: Box::new(response_with("hello", Vec::new(), StopReason::EndTurn)),
        }));

        assert_eq!(
            event_names(&frames),
            vec![
                "message_start",
                "content_block_start",
                "content_block_delta",
                "content_block_delta",
                "content_block_stop",
                "message_delta",
                "message_stop",
            ]
        );

        let delta: Value = serde_json::from_str(&frames[2].data).unwrap();
        assert_eq!(delta["delta"]["type"], "text_delta");
        assert_eq!(delta["delta"]["text"], "he");

        let message_delta: Value = serde_json::from_str(&frames[5].data).unwrap();
        assert_eq!(message_delta["delta"]["stop_reason"], "end_turn");
    }

    #[test]
    fn a_tool_call_is_emitted_as_a_complete_tool_use_block() {
        let mut encoder = StreamEncoder::new("msg_1", "m");
        let _ = encoder.opening();
        let frames = encoder.on_event(&StreamEvent::Done {
            response: Box::new(response_with(
                "",
                vec![ToolCallOutcome::Ok {
                    call_id: "c1".to_string(),
                    name: "bash".to_string(),
                    arguments: json!({"cmd": "ls"}),
                    emulated: false,
                }],
                StopReason::ToolUse,
            )),
        });

        assert_eq!(
            event_names(&frames),
            vec![
                "content_block_start",
                "content_block_delta",
                "content_block_stop",
                "message_delta",
                "message_stop",
            ],
            "with no text there is no text block to open or close"
        );
        let start: Value = serde_json::from_str(&frames[0].data).unwrap();
        assert_eq!(start["index"], 0);
        assert_eq!(start["content_block"]["type"], "tool_use");
        assert_eq!(start["content_block"]["name"], "bash");
        let delta: Value = serde_json::from_str(&frames[1].data).unwrap();
        assert_eq!(delta["delta"]["type"], "input_json_delta");
        assert_eq!(delta["delta"]["partial_json"], r#"{"cmd":"ls"}"#);
        let message_delta: Value = serde_json::from_str(&frames[3].data).unwrap();
        assert_eq!(message_delta["delta"]["stop_reason"], "tool_use");
    }

    #[test]
    fn a_backend_that_never_streamed_still_produces_a_content_block() {
        // The whole answer arrives on `Done` and nowhere else. A client must
        // not receive an empty message.
        let mut encoder = StreamEncoder::new("msg_1", "m");
        let _ = encoder.opening();
        let frames = encoder.on_event(&StreamEvent::Done {
            response: Box::new(response_with(
                "all at once",
                Vec::new(),
                StopReason::EndTurn,
            )),
        });
        assert_eq!(
            event_names(&frames),
            vec![
                "content_block_start",
                "content_block_delta",
                "content_block_stop",
                "message_delta",
                "message_stop",
            ]
        );
        let delta: Value = serde_json::from_str(&frames[1].data).unwrap();
        assert_eq!(delta["delta"]["text"], "all at once");
    }

    #[test]
    fn a_tool_use_block_is_indexed_after_the_text_block_it_follows() {
        let mut encoder = StreamEncoder::new("msg_1", "m");
        let _ = encoder.opening();
        let _ = encoder.on_event(&StreamEvent::TextDelta {
            text: "thinking about it".to_string(),
        });
        let frames = encoder.on_event(&StreamEvent::Done {
            response: Box::new(response_with(
                "thinking about it",
                vec![ToolCallOutcome::Ok {
                    call_id: "c1".to_string(),
                    name: "bash".to_string(),
                    arguments: json!({}),
                    emulated: false,
                }],
                StopReason::ToolUse,
            )),
        });
        let start: Value = serde_json::from_str(&frames[1].data).unwrap();
        assert_eq!(start["index"], 1, "the text block already holds index 0");
    }

    #[test]
    fn the_non_streaming_body_carries_the_same_content_the_stream_would_have() {
        let response = response_with(
            "hello",
            vec![ToolCallOutcome::Ok {
                call_id: "c1".to_string(),
                name: "bash".to_string(),
                arguments: json!({"cmd": "ls"}),
                emulated: false,
            }],
            StopReason::ToolUse,
        );
        let body = encode_message(&response, "msg_1", "m");
        assert_eq!(body["type"], "message");
        assert_eq!(body["content"][0]["type"], "text");
        assert_eq!(body["content"][0]["text"], "hello");
        assert_eq!(body["content"][1]["type"], "tool_use");
        assert_eq!(body["content"][1]["input"]["cmd"], "ls");
        assert_eq!(body["stop_reason"], "tool_use");
    }
}
