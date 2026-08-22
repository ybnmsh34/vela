//! Encoding Vela's request model into the OpenAI-compatible wire format.
//!
//! This is the *only* place that knows what the wire looks like. Two rules are
//! enforced here rather than trusted to call sites:
//!
//! * **`tools` is omitted entirely unless the catalogue is actually being
//!   offered.** GATE M FINDING 6: `small-local` answers `400
//!   tools_not_supported` to a request carrying `tools` even with
//!   `tool_choice: "none"`, locking a client out of the endpoint for turns that
//!   needed no tools at all.
//! * **No `Authorization` header is built here.** Auth is applied in
//!   `provider.rs` through `vela_secrets::resolve_auth`, which is the one
//!   function that guarantees "no credential" means *no header* rather than an
//!   empty one — the mistake the harness answers with a 401
//!   `empty_authorization_header` precisely to make loud.

use serde_json::{json, Map, Value};

use crate::model::{
    ChatMessage, ChatRequest, ContentPart, MessageRole, ResponseFormat, ToolChoice,
};

pub fn role_name(role: MessageRole) -> &'static str {
    match role {
        MessageRole::System => "system",
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
        MessageRole::Tool => "tool",
    }
}

/// Encode a request body.
///
/// `include_usage` is only meaningful when streaming, and asking for usage is
/// never evidence it will arrive: `small-local` accepts the option and never
/// sends the frame (MEASURED-1).
pub fn encode_request(request: &ChatRequest, stream: bool, include_usage: bool) -> Value {
    let mut body = Map::new();
    if !request.model_id.is_empty() {
        body.insert("model".into(), json!(request.model_id));
    }
    body.insert(
        "messages".into(),
        Value::Array(encode_messages(&request.messages)),
    );
    body.insert("stream".into(), json!(stream));
    if stream && include_usage {
        body.insert("stream_options".into(), json!({ "include_usage": true }));
    }

    if request.offers_tools() {
        body.insert(
            "tools".into(),
            Value::Array(
                request
                    .tools
                    .iter()
                    .map(|tool| {
                        json!({
                            "type": "function",
                            "function": {
                                "name": tool.name,
                                "description": tool.description,
                                "parameters": tool.parameters,
                            }
                        })
                    })
                    .collect(),
            ),
        );
        match &request.tool_choice {
            ToolChoice::Auto => {}
            ToolChoice::Required => {
                body.insert("tool_choice".into(), json!("required"));
            }
            ToolChoice::Named { name } => {
                body.insert(
                    "tool_choice".into(),
                    json!({"type": "function", "function": {"name": name}}),
                );
            }
            // Unreachable: `offers_tools()` is false for `None`. The catalogue
            // is omitted rather than sent alongside `tool_choice: "none"`.
            ToolChoice::None => {}
        }
    }

    if let ResponseFormat::JsonSchema { name, schema } = &request.response_format {
        body.insert(
            "response_format".into(),
            json!({
                "type": "json_schema",
                "json_schema": {"name": name, "schema": schema, "strict": true}
            }),
        );
    }

    if let Some(max) = request.max_output_tokens {
        body.insert("max_tokens".into(), json!(max));
    }
    // Rounded on the way out: widening an `f32` to the `f64` JSON uses would
    // otherwise put `0.20000000298023224` on the wire for a temperature the
    // user typed as `0.2`, which is noise in every transcript that captures it.
    if let Some(temperature) = request.sampling.temperature {
        body.insert("temperature".into(), json!(round4(temperature)));
    }
    if let Some(top_p) = request.sampling.top_p {
        body.insert("top_p".into(), json!(round4(top_p)));
    }
    if !request.sampling.stop.is_empty() {
        body.insert("stop".into(), json!(request.sampling.stop));
    }
    if let Some(seed) = request.sampling.seed {
        body.insert("seed".into(), json!(seed));
    }

    // Cache hints are advisory and non-standard across runtimes; they are sent
    // as an OpenAI-compatible extension that endpoints ignore harmlessly.
    if request.cache.cache_system_prompt || request.cache.cache_conversation_prefix {
        body.insert("cache_prompt".into(), json!(true));
    }

    Value::Object(body)
}

fn encode_messages(messages: &[ChatMessage]) -> Vec<Value> {
    let mut out = Vec::new();
    for message in messages {
        // Tool results are their own messages on the wire, one per result.
        let results: Vec<&ContentPart> = message
            .parts
            .iter()
            .filter(|part| matches!(part, ContentPart::ToolResult { .. }))
            .collect();
        for part in &results {
            if let ContentPart::ToolResult {
                call_id, content, ..
            } = part
            {
                out.push(json!({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": content,
                }));
            }
        }

        let content_parts: Vec<&ContentPart> = message
            .parts
            .iter()
            .filter(|part| matches!(part, ContentPart::Text { .. } | ContentPart::Image { .. }))
            .collect();
        let tool_calls: Vec<Value> = message
            .parts
            .iter()
            .filter_map(|part| match part {
                ContentPart::ToolCall {
                    call_id,
                    name,
                    arguments,
                } => Some(json!({
                    "id": call_id,
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": serde_json::to_string(arguments).unwrap_or_default(),
                    }
                })),
                _ => None,
            })
            .collect();

        if content_parts.is_empty() && tool_calls.is_empty() {
            continue;
        }

        let mut object = Map::new();
        object.insert("role".into(), json!(role_name(message.role)));
        object.insert("content".into(), encode_content(&content_parts));
        if !tool_calls.is_empty() {
            object.insert("tool_calls".into(), Value::Array(tool_calls));
        }
        out.push(Value::Object(object));
    }
    out
}

/// A single text part is sent as a plain string — the shape every runtime
/// understands. Anything richer becomes the parts array.
fn encode_content(parts: &[&ContentPart]) -> Value {
    if parts.is_empty() {
        return Value::String(String::new());
    }
    if parts.len() == 1 {
        if let ContentPart::Text { text } = parts[0] {
            return Value::String(text.clone());
        }
    }
    Value::Array(
        parts
            .iter()
            .map(|part| match part {
                ContentPart::Text { text } => json!({"type": "text", "text": text}),
                ContentPart::Image { mime_type, data } => json!({
                    "type": "image_url",
                    "image_url": {"url": format!("data:{mime_type};base64,{}", base64_encode(data))}
                }),
                // Reasoning is never re-sent as content: replaying a model's
                // private deliberation as if the user wrote it corrupts the
                // next turn, and some backends reject it outright.
                _ => json!({"type": "text", "text": ""}),
            })
            .collect(),
    )
}

fn round4(value: f32) -> f64 {
    (f64::from(value) * 10_000.0).round() / 10_000.0
}

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding. Hand-rolled to keep the dependency surface of
/// the one crate that talks to the network as small as possible.
pub fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(BASE64_ALPHABET[(triple >> 18) as usize & 0x3f] as char);
        out.push(BASE64_ALPHABET[(triple >> 12) as usize & 0x3f] as char);
        out.push(if chunk.len() > 1 {
            BASE64_ALPHABET[(triple >> 6) as usize & 0x3f] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            BASE64_ALPHABET[triple as usize & 0x3f] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Sampling, ToolDefinition};
    use serde_json::json;

    fn tools() -> Vec<ToolDefinition> {
        vec![ToolDefinition::new(
            "get_weather",
            "d",
            json!({"type": "object"}),
        )]
    }

    #[test]
    fn tools_are_omitted_entirely_when_the_choice_is_none() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::user("hi"))
            .with_tools(tools())
            .with_tool_choice(ToolChoice::None);
        let body = encode_request(&request, false, false);
        assert!(
            body.get("tools").is_none(),
            "FINDING 6: `tools` with tool_choice=none is a 400 on small-local"
        );
        assert!(body.get("tool_choice").is_none());
    }

    #[test]
    fn tools_are_sent_when_they_are_actually_offered() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::user("hi"))
            .with_tools(tools())
            .with_tool_choice(ToolChoice::Required);
        let body = encode_request(&request, false, false);
        assert_eq!(body["tools"][0]["function"]["name"], "get_weather");
        assert_eq!(body["tool_choice"], "required");
    }

    #[test]
    fn a_single_text_part_is_a_plain_string_not_an_array() {
        let request = ChatRequest::new("m").with_message(ChatMessage::user("hello"));
        let body = encode_request(&request, false, false);
        assert_eq!(body["messages"][0]["content"], "hello");
    }

    #[test]
    fn an_image_becomes_a_data_url_because_vela_is_offline_first() {
        let request = ChatRequest::new("m").with_message(ChatMessage::new(
            MessageRole::User,
            vec![
                ContentPart::text("what is this?"),
                ContentPart::Image {
                    mime_type: "image/png".into(),
                    data: vec![0x89, 0x50, 0x4e],
                },
            ],
        ));
        let body = encode_request(&request, false, false);
        let url = body["messages"][0]["content"][1]["image_url"]["url"]
            .as_str()
            .unwrap();
        assert_eq!(url, "data:image/png;base64,iVBO");
    }

    #[test]
    fn reasoning_is_never_replayed_to_the_model_as_content() {
        let request = ChatRequest::new("m").with_message(ChatMessage::new(
            MessageRole::Assistant,
            vec![
                ContentPart::reasoning("private deliberation"),
                ContentPart::text("public answer"),
            ],
        ));
        let body = encode_request(&request, false, false);
        assert_eq!(body["messages"][0]["content"], "public answer");
        assert!(!body.to_string().contains("private deliberation"));
    }

    #[test]
    fn a_tool_result_becomes_its_own_tool_role_message() {
        let request = ChatRequest::new("m").with_message(ChatMessage::new(
            MessageRole::Tool,
            vec![ContentPart::ToolResult {
                call_id: "c1".into(),
                content: "21C".into(),
                is_error: false,
            }],
        ));
        let body = encode_request(&request, false, false);
        assert_eq!(body["messages"][0]["role"], "tool");
        assert_eq!(body["messages"][0]["tool_call_id"], "c1");
        assert_eq!(body["messages"][0]["content"], "21C");
    }

    #[test]
    fn an_assistant_tool_call_round_trips_as_a_json_string_argument() {
        let request = ChatRequest::new("m").with_message(ChatMessage::new(
            MessageRole::Assistant,
            vec![ContentPart::ToolCall {
                call_id: "c1".into(),
                name: "get_weather".into(),
                arguments: json!({"city": "berlin"}),
            }],
        ));
        let body = encode_request(&request, false, false);
        assert_eq!(
            body["messages"][0]["tool_calls"][0]["function"]["arguments"],
            "{\"city\":\"berlin\"}"
        );
    }

    #[test]
    fn stream_options_are_only_sent_when_streaming() {
        let request = ChatRequest::new("m").with_message(ChatMessage::user("hi"));
        assert!(encode_request(&request, false, true)
            .get("stream_options")
            .is_none());
        assert_eq!(
            encode_request(&request, true, true)["stream_options"]["include_usage"],
            true
        );
    }

    #[test]
    fn sampling_knobs_are_sent_even_though_the_matrix_discards_them() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::user("hi"))
            .with_sampling(Sampling {
                temperature: Some(0.2),
                top_p: Some(0.9),
                stop: vec!["</s>".into()],
                seed: Some(7),
            });
        let body = encode_request(&request, false, false);
        assert_eq!(body["temperature"], 0.2);
        assert_eq!(body["stop"][0], "</s>");
        assert_eq!(body["seed"], 7);
    }

    #[test]
    fn base64_matches_the_known_answers() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(&[0xff, 0xfe, 0xfd]), "//79");
    }
}
