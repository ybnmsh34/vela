//! The OpenAI-compatible half: `POST /v1/chat/completions` and
//! `GET /v1/models`.
//!
//! `/v1/responses` is routed and answered `501` — see [`crate::route::Endpoint`]
//! for why it is routed at all rather than simply absent. Nothing in this
//! module pretends to serve it.
//!
//! The tool-result message shape in this dialect is the **confirmed** one:
//! `docs/references/unsloth-studio.md` §3 quotes the reference's own published
//! sample, `{"role": "tool", "tool_call_id": _id, "name": fx, "content": …}`,
//! which is what [`decode`] reads. That is the asymmetry with the Anthropic
//! half worth knowing about — there, the equivalent shape is UNVERIFIED.
//!
//! Reasoning is not forwarded here either, for the reason given in
//! [`crate::anthropic`].

use serde_json::{json, Value};
use vela_providers::model::{
    ChatMessage, ChatRequest, ChatResponse, ContentPart, MessageRole, Sampling, ToolCallOutcome,
    ToolDefinition,
};
use vela_providers::sse::SseFrame;
use vela_providers::StreamEvent;

use crate::route::openai_finish_reason;
use crate::{tool_choice, DecodeError, Decoded};

/* -------------------------------------------------------------------------- */
/* decode                                                                     */
/* -------------------------------------------------------------------------- */

pub fn decode(body: &[u8]) -> Result<Decoded, DecodeError> {
    let root: Value = serde_json::from_slice(body).map_err(|_| DecodeError::NotJson)?;

    let model = root
        .get("model")
        .and_then(Value::as_str)
        .ok_or(DecodeError::MissingModel)?;

    let wire_messages = root
        .get("messages")
        .and_then(Value::as_array)
        .ok_or(DecodeError::MissingMessages)?;

    let mut messages: Vec<ChatMessage> = Vec::new();
    for message in wire_messages {
        messages.push(decode_message(message)?);
    }

    let mut request = ChatRequest::new(model).with_messages(messages);

    if let Some(tools) = root.get("tools") {
        request = request.with_tools(decode_tools(tools)?);
    }
    if let Some(choice) = root.get("tool_choice") {
        request = request
            .with_tool_choice(tool_choice::from_openai(choice).ok_or(DecodeError::BadToolChoice)?);
    }
    if let Some(max) = root
        .get("max_completion_tokens")
        .or_else(|| root.get("max_tokens"))
        .and_then(Value::as_u64)
    {
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
        stop: decode_stop(root.get("stop")),
        seed: root.get("seed").and_then(Value::as_u64),
    });

    Ok(Decoded {
        chat: request,
        stream: root.get("stream").and_then(Value::as_bool).unwrap_or(false),
    })
}

fn decode_stop(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(text)) => vec![text.clone()],
        Some(Value::Array(entries)) => entries
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn decode_message(message: &Value) -> Result<ChatMessage, DecodeError> {
    let role = match message.get("role").and_then(Value::as_str) {
        Some("system") | Some("developer") => MessageRole::System,
        Some("user") => MessageRole::User,
        Some("assistant") => MessageRole::Assistant,
        Some("tool") => return decode_tool_message(message),
        _ => return Err(DecodeError::BadRole),
    };

    let mut parts: Vec<ContentPart> = Vec::new();

    match message.get("content") {
        Some(Value::String(text)) => parts.push(ContentPart::text(text)),
        Some(Value::Array(blocks)) => {
            for block in blocks {
                parts.push(decode_block(block)?);
            }
        }
        // An assistant message that is nothing but tool calls carries
        // `"content": null`, which is legal and common.
        Some(Value::Null) | None => {}
        Some(_) => return Err(DecodeError::BadContentBlock),
    }

    if role == MessageRole::Assistant {
        if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                parts.push(decode_tool_call(call)?);
            }
        }
    }

    Ok(ChatMessage::new(role, parts))
}

/// The confirmed shape: `{"role":"tool","tool_call_id":…,"content":…}`.
fn decode_tool_message(message: &Value) -> Result<ChatMessage, DecodeError> {
    let call_id = message
        .get("tool_call_id")
        .and_then(Value::as_str)
        .ok_or(DecodeError::BadContentBlock)?;
    let content = match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => {
            let mut out = String::new();
            for block in blocks {
                match decode_block(block)? {
                    ContentPart::Text { text } => out.push_str(&text),
                    _ => return Err(DecodeError::BadContentBlock),
                }
            }
            out
        }
        Some(Value::Null) | None => String::new(),
        Some(_) => return Err(DecodeError::BadContentBlock),
    };
    Ok(ChatMessage::new(
        MessageRole::Tool,
        vec![ContentPart::ToolResult {
            call_id: call_id.to_string(),
            content,
            // This dialect has no error flag on a tool message. A failed tool
            // arrives as ordinary content, which is what the sample shows.
            is_error: false,
        }],
    ))
}

fn decode_tool_call(call: &Value) -> Result<ContentPart, DecodeError> {
    if call
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("function")
        != "function"
    {
        return Err(DecodeError::BadTool);
    }
    let call_id = call
        .get("id")
        .and_then(Value::as_str)
        .ok_or(DecodeError::BadTool)?;
    let function = call.get("function").ok_or(DecodeError::BadTool)?;
    let name = function
        .get("name")
        .and_then(Value::as_str)
        .ok_or(DecodeError::BadTool)?;
    // `arguments` is a JSON *string* on this wire, not an object. Parsing it
    // here rather than passing the string through is what makes the two
    // dialects produce the same `ContentPart::ToolCall`.
    let arguments = match function.get("arguments") {
        Some(Value::String(text)) => {
            serde_json::from_str(text).map_err(|_| DecodeError::BadTool)?
        }
        Some(other) => other.clone(),
        None => json!({}),
    };
    Ok(ContentPart::ToolCall {
        call_id: call_id.to_string(),
        name: name.to_string(),
        arguments,
    })
}

fn decode_block(block: &Value) -> Result<ContentPart, DecodeError> {
    match block.get("type").and_then(Value::as_str) {
        Some("text") => Ok(ContentPart::text(
            block
                .get("text")
                .and_then(Value::as_str)
                .ok_or(DecodeError::BadContentBlock)?,
        )),
        Some("image_url") => {
            let url = block
                .get("image_url")
                .and_then(|image| image.get("url"))
                .and_then(Value::as_str)
                .ok_or(DecodeError::BadImage)?;
            decode_data_url(url)
        }
        _ => Err(DecodeError::BadContentBlock),
    }
}

/// `data:<mime>;base64,<payload>` only.
///
/// An `http(s)` image URL is refused for the same reason the Anthropic half
/// refuses a `url` source: serving it would mean this endpoint fetching a
/// remote resource on a caller's behalf.
fn decode_data_url(url: &str) -> Result<ContentPart, DecodeError> {
    let rest = url.strip_prefix("data:").ok_or(DecodeError::BadImage)?;
    let (meta, payload) = rest.split_once(',').ok_or(DecodeError::BadImage)?;
    let mime_type = meta
        .strip_suffix(";base64")
        .ok_or(DecodeError::BadImage)?
        .to_string();
    Ok(ContentPart::Image {
        mime_type,
        data: vela_providers::base64_decode(payload).ok_or(DecodeError::BadImage)?,
    })
}

fn decode_tools(tools: &Value) -> Result<Vec<ToolDefinition>, DecodeError> {
    let entries = tools.as_array().ok_or(DecodeError::BadTool)?;
    entries
        .iter()
        .map(|tool| {
            if tool
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("function")
                != "function"
            {
                return Err(DecodeError::BadTool);
            }
            let function = tool.get("function").ok_or(DecodeError::BadTool)?;
            let name = function
                .get("name")
                .and_then(Value::as_str)
                .ok_or(DecodeError::BadTool)?;
            Ok(ToolDefinition::new(
                name,
                function
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                function
                    .get("parameters")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
            ))
        })
        .collect()
}

/* -------------------------------------------------------------------------- */
/* encode                                                                     */
/* -------------------------------------------------------------------------- */

/// `GET /v1/models`. The call almost every OpenAI-compatible client makes
/// before it will believe an endpoint exists.
pub fn models_body(model_ids: &[String], created: u64) -> Value {
    json!({
        "object": "list",
        "data": model_ids
            .iter()
            .map(|id| json!({
                "id": id,
                "object": "model",
                "created": created,
                "owned_by": "vela",
            }))
            .collect::<Vec<Value>>(),
    })
}

/// The whole assembled turn, in the non-streaming `chat.completion` shape.
pub fn encode_completion(
    response: &ChatResponse,
    completion_id: &str,
    model: &str,
    created: u64,
) -> Value {
    let text = response.answer_text();
    let mut message = json!({
        "role": "assistant",
        "content": if text.is_empty() { Value::Null } else { Value::String(text) },
    });
    let calls = tool_calls_json(response);
    if !calls.is_empty() {
        message["tool_calls"] = Value::Array(calls);
    }

    json!({
        "id": completion_id,
        "object": "chat.completion",
        "created": created,
        "model": model,
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": openai_finish_reason(response.stop_reason),
        }],
        "usage": usage_json(response),
    })
}

fn tool_calls_json(response: &ChatResponse) -> Vec<Value> {
    response
        .tool_calls
        .iter()
        .enumerate()
        .filter_map(|(index, call)| match call {
            ToolCallOutcome::Ok {
                call_id,
                name,
                arguments,
                ..
            } => Some(json!({
                "index": index,
                "id": call_id,
                "type": "function",
                "function": {
                    "name": name,
                    // A JSON *string*, per this dialect's wire format.
                    "arguments": serde_json::to_string(arguments).unwrap_or_default(),
                },
            })),
            // Evidence for Vela's own UI, not a call to hand a client.
            ToolCallOutcome::Malformed { .. } => None,
        })
        .collect()
}

/// See [`crate::anthropic`]'s note: an unreported count becomes `0` because the
/// wire format has no way to say "not counted". Vela's own `TokenUsage` keeps
/// the distinction on its side of the seam.
fn usage_json(response: &ChatResponse) -> Value {
    let input = response.usage.input_tokens.unwrap_or(0);
    let output = response.usage.output_tokens.unwrap_or(0);
    json!({
        "prompt_tokens": input,
        "completion_tokens": output,
        "total_tokens": input.saturating_add(output),
    })
}

/// Turns Vela's six-event stream into `chat.completion.chunk` frames.
///
/// Every frame in this dialect is an unnamed `data:` line — there are no SSE
/// event names here, which is the visible difference from the Anthropic half
/// and the reason the two encoders are separate types rather than one with a
/// flag.
pub struct StreamEncoder {
    completion_id: String,
    model: String,
    created: u64,
}

impl StreamEncoder {
    pub fn new(completion_id: impl Into<String>, model: impl Into<String>, created: u64) -> Self {
        Self {
            completion_id: completion_id.into(),
            model: model.into(),
            created,
        }
    }

    /// The role chunk. Clients key "a message has begun" off this.
    pub fn opening(&self) -> Vec<SseFrame> {
        vec![self.chunk(json!({ "role": "assistant" }), Value::Null)]
    }

    pub fn on_event(&mut self, event: &StreamEvent) -> Vec<SseFrame> {
        match event {
            StreamEvent::TextDelta { text } => {
                vec![self.chunk(json!({ "content": text }), Value::Null)]
            }
            StreamEvent::ReasoningDelta { .. } | StreamEvent::ToolCallDelta { .. } => Vec::new(),
            StreamEvent::Usage { .. } => Vec::new(),
            StreamEvent::Done { response } => self.closing(response),
            StreamEvent::Error { error } => vec![SseFrame {
                event: None,
                data: json!({
                    "error": {
                        "type": "api_error",
                        "message": crate::error_code(error),
                    }
                })
                .to_string(),
            }],
        }
    }

    fn closing(&mut self, response: &ChatResponse) -> Vec<SseFrame> {
        let mut frames = Vec::new();
        let calls = tool_calls_json(response);
        if !calls.is_empty() {
            frames.push(self.chunk(json!({ "tool_calls": calls }), Value::Null));
        }
        frames.push(self.chunk(
            json!({}),
            Value::String(openai_finish_reason(response.stop_reason).to_string()),
        ));
        // The sentinel this dialect's clients wait for. Vela's own SSE decoder
        // treats it as a hint rather than a terminator (`SseFrame::is_done_hint`
        // and MEASURED-1) — but a client that wants it and never gets it hangs
        // until its own timeout, so it is written.
        frames.push(SseFrame {
            event: None,
            data: "[DONE]".to_string(),
        });
        frames
    }

    fn chunk(&self, delta: Value, finish_reason: Value) -> SseFrame {
        SseFrame {
            event: None,
            data: json!({
                "id": self.completion_id,
                "object": "chat.completion.chunk",
                "created": self.created,
                "model": self.model,
                "choices": [{
                    "index": 0,
                    "delta": delta,
                    "finish_reason": finish_reason,
                }],
            })
            .to_string(),
        }
    }
}

/// An error body in this dialect, for the paths that fail before a turn opens.
pub fn error_body(kind: &str, message: &str) -> Value {
    json!({ "error": { "type": kind, "message": message, "code": kind } })
}

#[cfg(test)]
mod tests {
    use super::*;
    use vela_providers::model::{StopReason, TokenUsage, ToolChoice};

    fn decode_or_panic(body: &str) -> Decoded {
        decode(body.as_bytes()).expect("body must decode")
    }

    #[test]
    fn a_system_message_keeps_its_role_and_developer_is_the_same_role() {
        let decoded = decode_or_panic(
            r#"{"model":"m","messages":[
                 {"role":"developer","content":"be brief"},
                 {"role":"user","content":"hi"}]}"#,
        );
        assert_eq!(decoded.chat.messages[0].role, MessageRole::System);
        assert_eq!(decoded.chat.messages[1].role, MessageRole::User);
    }

    #[test]
    fn the_confirmed_tool_result_message_shape_decodes() {
        // The shape the study quotes from the reference's own published sample.
        let decoded = decode_or_panic(
            r#"{"model":"m","messages":[
                 {"role":"assistant","content":null,"tool_calls":[
                   {"id":"c1","type":"function",
                    "function":{"name":"bash","arguments":"{\"cmd\":\"ls\"}"}}]},
                 {"role":"tool","tool_call_id":"c1","name":"bash","content":"a\nb"}]}"#,
        );
        assert!(matches!(
            &decoded.chat.messages[0].parts[0],
            ContentPart::ToolCall { call_id, name, arguments }
                if call_id == "c1" && name == "bash" && arguments["cmd"] == "ls"
        ));
        assert_eq!(decoded.chat.messages[1].role, MessageRole::Tool);
        assert!(matches!(
            &decoded.chat.messages[1].parts[0],
            ContentPart::ToolResult { call_id, content, .. }
                if call_id == "c1" && content == "a\nb"
        ));
    }

    #[test]
    fn the_arguments_string_becomes_the_same_json_the_other_dialect_produces() {
        // Both halves must land on one `ContentPart::ToolCall` or a transcript
        // is not portable between the two doors into this endpoint.
        let openai = decode_or_panic(
            r#"{"model":"m","messages":[
                 {"role":"assistant","tool_calls":[
                   {"id":"c1","type":"function",
                    "function":{"name":"bash","arguments":"{\"cmd\":\"ls\"}"}}]}]}"#,
        );
        let anthropic = crate::anthropic::decode(
            br#"{"model":"m","messages":[
                 {"role":"assistant","content":[
                   {"type":"tool_use","id":"c1","name":"bash","input":{"cmd":"ls"}}]}]}"#,
        )
        .expect("must decode");
        assert_eq!(
            openai.chat.messages[0].parts,
            anthropic.chat.messages[0].parts
        );
    }

    #[test]
    fn tools_and_tool_choice_decode_in_this_dialects_own_spelling() {
        let decoded = decode_or_panic(
            r#"{"model":"m","messages":[{"role":"user","content":"hi"}],
                "tools":[{"type":"function","function":{
                  "name":"bash","description":"run","parameters":{"type":"object"}}}],
                "tool_choice":"required"}"#,
        );
        assert_eq!(decoded.chat.tools[0].name, "bash");
        assert_eq!(decoded.chat.tool_choice, ToolChoice::Required);
    }

    #[test]
    fn an_unreadable_body_is_refused() {
        assert_eq!(decode(b"{"), Err(DecodeError::NotJson));
        assert_eq!(
            decode(br#"{"messages":[]}"#),
            Err(DecodeError::MissingModel)
        );
        assert_eq!(
            decode(br#"{"model":"m"}"#),
            Err(DecodeError::MissingMessages)
        );
        assert_eq!(
            decode(br#"{"model":"m","messages":[{"role":"nobody","content":"x"}]}"#),
            Err(DecodeError::BadRole)
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
            input_tokens: Some(5),
            output_tokens: Some(3),
            ..TokenUsage::default()
        };
        response
    }

    #[test]
    fn a_streamed_answer_is_chunks_and_then_the_done_sentinel() {
        let mut encoder = StreamEncoder::new("cmpl_1", "m", 42);
        let mut frames = encoder.opening();
        frames.extend(encoder.on_event(&StreamEvent::TextDelta {
            text: "hi".to_string(),
        }));
        frames.extend(encoder.on_event(&StreamEvent::Done {
            response: Box::new(response_with("hi", Vec::new(), StopReason::EndTurn)),
        }));

        assert!(
            frames.iter().all(|frame| frame.event.is_none()),
            "this dialect names no SSE events"
        );
        let first: Value = serde_json::from_str(&frames[0].data).unwrap();
        assert_eq!(first["object"], "chat.completion.chunk");
        assert_eq!(first["choices"][0]["delta"]["role"], "assistant");
        let second: Value = serde_json::from_str(&frames[1].data).unwrap();
        assert_eq!(second["choices"][0]["delta"]["content"], "hi");
        let last_chunk: Value = serde_json::from_str(&frames[2].data).unwrap();
        assert_eq!(last_chunk["choices"][0]["finish_reason"], "stop");
        assert_eq!(frames[3].data, "[DONE]");
        assert!(frames[3].is_done_hint());
    }

    #[test]
    fn a_tool_call_arrives_as_a_tool_calls_delta_and_a_tool_calls_finish_reason() {
        let mut encoder = StreamEncoder::new("cmpl_1", "m", 42);
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
        let call_chunk: Value = serde_json::from_str(&frames[0].data).unwrap();
        let call = &call_chunk["choices"][0]["delta"]["tool_calls"][0];
        assert_eq!(call["type"], "function");
        assert_eq!(call["function"]["name"], "bash");
        assert_eq!(
            call["function"]["arguments"], r#"{"cmd":"ls"}"#,
            "arguments are a JSON string on this wire, not an object"
        );
        let final_chunk: Value = serde_json::from_str(&frames[1].data).unwrap();
        assert_eq!(final_chunk["choices"][0]["finish_reason"], "tool_calls");
    }

    #[test]
    fn the_non_streaming_body_is_a_chat_completion() {
        let body = encode_completion(
            &response_with("hello", Vec::new(), StopReason::EndTurn),
            "cmpl_1",
            "m",
            42,
        );
        assert_eq!(body["object"], "chat.completion");
        assert_eq!(body["choices"][0]["message"]["content"], "hello");
        assert_eq!(body["choices"][0]["finish_reason"], "stop");
        assert_eq!(body["usage"]["total_tokens"], 8);
    }

    #[test]
    fn the_model_list_names_what_the_brain_offers() {
        let body = models_body(&["local-model".to_string()], 42);
        assert_eq!(body["object"], "list");
        assert_eq!(body["data"][0]["id"], "local-model");
    }
}
