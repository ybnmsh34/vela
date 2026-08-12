//! Encoding Vela's request model into the Anthropic Messages wire format.
//!
//! This module and [`super::stream`] are the only two places in Vela that know
//! what `/v1/messages` looks like. Above the adapter boundary there is no
//! `thinking` object, no `cache_control`, no `tool_use` block and no
//! `anthropic-version` header — only [`ChatRequest`] and [`ChatResponse`].
//!
//! Four rules are enforced here rather than trusted to call sites:
//!
//! * **`max_tokens` is mandatory on this API.** Vela's model makes it optional,
//!   so a default is supplied here — visibly, once, with a name — instead of
//!   letting a missing field become a 400 the user cannot act on.
//! * **`tools` is omitted entirely unless the catalogue is actually offered**,
//!   the same rule GATE M FINDING 6 forced on the OpenAI encoder. It costs
//!   nothing here and keeps one behaviour across adapters.
//! * **Reasoning is round-tripped only when it can be.** A thinking block is
//!   echoed back verbatim — text *and* signature — because that is what this
//!   API requires within a tool-use turn (spec THK-7). A reasoning part that
//!   carries no signature came from some other backend, and replaying it would
//!   be rejected, so it is dropped. That is the model-switch rule THK-7 asks
//!   for, applied automatically rather than left to the user.
//! * **No `Authorization` header is built here.** Auth is applied in
//!   `provider.rs` through `vela_secrets::resolve_auth`, the one function that
//!   guarantees "no credential" means *no header* rather than an empty one.

use serde_json::{json, Map, Value};

use crate::model::{
    ChatMessage, ChatRequest, ContentPart, MessageRole, ReasoningRequest, ResponseFormat,
    ToolChoice,
};
use crate::openai_compatible::wire::base64_encode;

/// The version header this adapter pins. Sent on every request; the API
/// requires it and treats its absence as an error.
pub const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Beta header that lets reasoning appear between tool calls in manual
/// (`budget_tokens`) thinking mode — spec THK-6. Never sent unless both manual
/// thinking and a tool catalogue are in play, and dropped on refusal.
pub const INTERLEAVED_THINKING_BETA: &str = "interleaved-thinking-2025-05-14";

/// `max_tokens` when the caller did not say. This API rejects a request without
/// one, and Vela's request model makes it optional, so the default lives here
/// where it can be seen rather than in a `unwrap_or` at a call site.
pub const DEFAULT_MAX_OUTPUT_TOKENS: u32 = 4_096;

/// Smallest thinking budget this API accepts; smaller values are rejected.
pub const MIN_THINKING_BUDGET_TOKENS: u32 = 1_024;

/// The internal tool used to obtain structured output.
///
/// This API has no `response_format`. The documented way to get schema-shaped
/// output is a forced call to a tool whose input schema *is* the schema, so
/// that is what the adapter does — and the answer is validated regardless, per
/// MEASURED-5. The name is Vela's own and never leaves the adapter: the call is
/// consumed as structured output and never surfaced as an executable tool call.
pub const SCHEMA_TOOL_NAME: &str = "vela_structured_output";

/// Reductions applied to a retried request after the endpoint refused the
/// original shape.
///
/// Each one exists because this API documents a specific 400 for it, and each
/// is applied *once*, on evidence, rather than pre-emptively.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Concessions {
    /// Do not send the `thinking` object: this model rejects the mode asked for.
    pub thinking_config: bool,
    /// Do not replay prior-turn reasoning blocks: the history is incompatible.
    pub prior_reasoning: bool,
    /// Do not send the interleaved-thinking beta header.
    pub interleaved_beta: bool,
}

/// An encoded request, plus the beta headers it needs.
#[derive(Debug, Clone, PartialEq)]
pub struct Encoded {
    pub body: Value,
    pub betas: Vec<&'static str>,
    /// The structured-output tool was injected; its call is consumed by the
    /// adapter rather than reported as a tool call.
    pub schema_tool: bool,
}

/// Encode a request body.
pub fn encode_request(
    request: &ChatRequest,
    stream: bool,
    concessions: Concessions,
    interleaved_thinking: bool,
) -> Encoded {
    let mut body = Map::new();
    body.insert("model".into(), json!(request.model_id));
    body.insert("stream".into(), json!(stream));

    // --- system -----------------------------------------------------------
    // System turns are a top-level field on this API, not messages.
    let system_text = request
        .messages
        .iter()
        .filter(|message| message.role == MessageRole::System)
        .map(ChatMessage::answer_text)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    if !system_text.is_empty() {
        body.insert(
            "system".into(),
            if request.cache.cache_system_prompt {
                // A cache breakpoint needs the block form; the string form
                // cannot carry one.
                json!([{
                    "type": "text",
                    "text": system_text,
                    "cache_control": {"type": "ephemeral"},
                }])
            } else {
                json!(system_text)
            },
        );
    }

    // --- messages ---------------------------------------------------------
    let mut messages: Vec<Value> = Vec::new();
    for message in request
        .messages
        .iter()
        .filter(|message| message.role != MessageRole::System)
    {
        let blocks = encode_blocks(message, concessions);
        if blocks.is_empty() {
            continue;
        }
        messages.push(json!({"role": role_name(message.role), "content": blocks}));
    }
    if request.cache.cache_conversation_prefix && messages.len() >= 2 {
        // The breakpoint marks everything up to — but not including — the final
        // turn, which is the part that is stable between requests.
        let prefix_end = messages.len() - 2;
        mark_cached(&mut messages[prefix_end]);
    }
    body.insert("messages".into(), Value::Array(messages));

    // --- thinking and the output ceiling ----------------------------------
    let mut max_tokens = request
        .max_output_tokens
        .unwrap_or(DEFAULT_MAX_OUTPUT_TOKENS);
    let mut thinking_on = false;
    if !concessions.thinking_config {
        match request.reasoning {
            // "Take whatever the model does by default": send nothing. Every
            // model rejects at least one explicit thinking mode, and the
            // default is the one setting that is never refused.
            ReasoningRequest::Auto => {}
            ReasoningRequest::Disabled => {
                body.insert("thinking".into(), json!({"type": "disabled"}));
            }
            ReasoningRequest::Enabled { budget_tokens } => {
                let budget = budget_tokens
                    .unwrap_or(MIN_THINKING_BUDGET_TOKENS)
                    .max(MIN_THINKING_BUDGET_TOKENS);
                // The API requires budget < max_tokens because thinking is
                // billed against the same ceiling. Raising the ceiling is the
                // only fix that keeps the user's intent intact.
                if max_tokens <= budget {
                    max_tokens = budget.saturating_add(DEFAULT_MAX_OUTPUT_TOKENS);
                }
                body.insert(
                    "thinking".into(),
                    json!({"type": "enabled", "budget_tokens": budget}),
                );
                thinking_on = true;
            }
        }
    }
    body.insert("max_tokens".into(), json!(max_tokens));

    // --- tools, and the structured-output tool ----------------------------
    // Forced tool choice is rejected while manual thinking is on. Asking for
    // `auto` instead keeps the turn alive; the answer is validated either way,
    // so a model that declines to call the tool produces a reported mismatch
    // rather than silently wrong output.
    let may_force = !thinking_on;
    let mut schema_tool = false;

    if let ResponseFormat::JsonSchema { name, schema } = &request.response_format {
        if !request.offers_tools() {
            schema_tool = true;
            body.insert(
                "tools".into(),
                json!([{
                    "name": SCHEMA_TOOL_NAME,
                    "description": format!(
                        "Return the answer for `{name}` as this tool's input. \
                         Call this tool exactly once and produce no other output."
                    ),
                    "input_schema": as_input_schema(schema),
                }]),
            );
            if may_force {
                body.insert(
                    "tool_choice".into(),
                    json!({"type": "tool", "name": SCHEMA_TOOL_NAME}),
                );
            }
        }
    }

    if !schema_tool && request.offers_tools() {
        body.insert(
            "tools".into(),
            Value::Array(
                request
                    .tools
                    .iter()
                    .map(|tool| {
                        json!({
                            "name": tool.name,
                            "description": tool.description,
                            "input_schema": as_input_schema(&tool.parameters),
                        })
                    })
                    .collect(),
            ),
        );
        match &request.tool_choice {
            ToolChoice::Auto => {
                body.insert("tool_choice".into(), json!({"type": "auto"}));
            }
            ToolChoice::Required if may_force => {
                body.insert("tool_choice".into(), json!({"type": "any"}));
            }
            ToolChoice::Named { name } if may_force => {
                body.insert("tool_choice".into(), json!({"type": "tool", "name": name}));
            }
            // Forced choice withheld while thinking is on — see `may_force`.
            ToolChoice::Required | ToolChoice::Named { .. } => {
                body.insert("tool_choice".into(), json!({"type": "auto"}));
            }
            // Unreachable: `offers_tools()` is false for `None`, and the
            // catalogue is omitted rather than sent alongside a "no tools" hint.
            ToolChoice::None => {}
        }
    }

    // --- sampling ---------------------------------------------------------
    // Temperature and top_p are rejected outright while thinking is on, so they
    // are withheld there rather than sent and refused. `seed` has no equivalent
    // on this API and is not invented into one.
    if !thinking_on {
        if let Some(temperature) = request.sampling.temperature {
            body.insert("temperature".into(), json!(round4(temperature)));
        }
        if let Some(top_p) = request.sampling.top_p {
            body.insert("top_p".into(), json!(round4(top_p)));
        }
    }
    if !request.sampling.stop.is_empty() {
        body.insert("stop_sequences".into(), json!(request.sampling.stop));
    }

    // No `metadata.user_id`: Vela is offline-first and sends the endpoint
    // nothing that identifies the person using it (conventions.md §0.1).

    let mut betas = Vec::new();
    if interleaved_thinking
        && thinking_on
        && request.offers_tools()
        && !concessions.interleaved_beta
    {
        betas.push(INTERLEAVED_THINKING_BETA);
    }

    Encoded {
        body: Value::Object(body),
        betas,
        schema_tool,
    }
}

pub fn role_name(role: MessageRole) -> &'static str {
    match role {
        // A tool result is carried by a user turn on this API — there is no
        // tool role — and a system turn never reaches here (see `encode_request`).
        MessageRole::System | MessageRole::User | MessageRole::Tool => "user",
        MessageRole::Assistant => "assistant",
    }
}

fn encode_blocks(message: &ChatMessage, concessions: Concessions) -> Vec<Value> {
    let mut blocks = Vec::new();
    for part in &message.parts {
        match part {
            ContentPart::Text { text } => {
                if !text.is_empty() {
                    blocks.push(json!({"type": "text", "text": text}));
                }
            }
            ContentPart::Image { mime_type, data } => blocks.push(json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": mime_type,
                    "data": base64_encode(data),
                }
            })),
            ContentPart::Reasoning {
                text,
                signature,
                redacted,
            } => {
                if concessions.prior_reasoning {
                    continue;
                }
                if *redacted {
                    // Passed back unchanged. Filtering these out is the exact
                    // mistake THK-8 warns about: it breaks the turn structure.
                    blocks.push(json!({"type": "redacted_thinking", "data": text}));
                } else if let Some(signature) = signature {
                    blocks.push(json!({
                        "type": "thinking",
                        "thinking": text,
                        "signature": signature,
                    }));
                }
                // No signature: this block came from a different backend. It
                // would be rejected here and costs input tokens for nothing.
            }
            ContentPart::ToolCall {
                call_id,
                name,
                arguments,
            } => blocks.push(json!({
                "type": "tool_use",
                "id": call_id,
                "name": name,
                "input": arguments,
            })),
            ContentPart::ToolResult {
                call_id,
                content,
                is_error,
            } => blocks.push(json!({
                "type": "tool_result",
                "tool_use_id": call_id,
                "content": content,
                "is_error": is_error,
            })),
        }
    }
    blocks
}

/// This API requires an object schema. A schema that omits `type` is otherwise
/// valid JSON Schema and is rejected here, so the one missing keyword is filled
/// in — nothing else about the caller's schema is touched.
fn as_input_schema(schema: &Value) -> Value {
    match schema.as_object() {
        Some(object) if !object.contains_key("type") => {
            let mut filled = object.clone();
            filled.insert("type".into(), json!("object"));
            Value::Object(filled)
        }
        Some(_) => schema.clone(),
        None => json!({"type": "object"}),
    }
}

fn mark_cached(message: &mut Value) {
    if let Some(Value::Array(blocks)) = message.get_mut("content") {
        if let Some(Value::Object(last)) = blocks.last_mut() {
            last.insert("cache_control".into(), json!({"type": "ephemeral"}));
        }
    }
}

/// Rounded on the way out: widening an `f32` to the `f64` JSON uses would
/// otherwise put `0.20000000298023224` on the wire for a temperature the user
/// typed as `0.2`.
fn round4(value: f32) -> f64 {
    (f64::from(value) * 10_000.0).round() / 10_000.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{CacheHints, Sampling, ToolDefinition};

    fn tools() -> Vec<ToolDefinition> {
        vec![ToolDefinition::new(
            "get_weather",
            "Current weather",
            json!({"type": "object", "properties": {"city": {"type": "string"}}}),
        )]
    }

    fn encode(request: &ChatRequest) -> Value {
        encode_request(request, false, Concessions::default(), true).body
    }

    #[test]
    fn a_system_turn_becomes_the_top_level_system_field_not_a_message() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::system("be brief"))
            .with_message(ChatMessage::user("hi"));
        let body = encode(&request);
        assert_eq!(body["system"], "be brief");
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        assert_eq!(body["messages"][0]["role"], "user");
    }

    #[test]
    fn max_tokens_is_always_present_because_the_api_rejects_a_request_without_one() {
        let body = encode(&ChatRequest::new("m").with_message(ChatMessage::user("hi")));
        assert_eq!(body["max_tokens"], DEFAULT_MAX_OUTPUT_TOKENS);
    }

    #[test]
    fn a_thinking_budget_is_floored_and_always_leaves_room_under_max_tokens() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::user("hi"))
            .with_reasoning(ReasoningRequest::Enabled {
                budget_tokens: Some(10),
            })
            .with_max_output_tokens(512);
        let body = encode(&request);
        assert_eq!(
            body["thinking"]["budget_tokens"],
            MIN_THINKING_BUDGET_TOKENS
        );
        assert!(
            body["max_tokens"].as_u64().unwrap() > MIN_THINKING_BUDGET_TOKENS as u64,
            "the API requires budget_tokens < max_tokens: {body}"
        );
    }

    #[test]
    fn sampling_is_withheld_while_thinking_is_on_because_it_is_rejected_there() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::user("hi"))
            .with_reasoning(ReasoningRequest::Enabled {
                budget_tokens: None,
            })
            .with_sampling(Sampling {
                temperature: Some(0.2),
                top_p: Some(0.9),
                stop: vec!["</s>".into()],
                seed: Some(7),
            });
        let body = encode(&request);
        assert!(body.get("temperature").is_none());
        assert!(body.get("top_p").is_none());
        assert_eq!(body["stop_sequences"][0], "</s>", "stop is still honoured");
        assert!(body.get("seed").is_none(), "this API has no seed parameter");
    }

    #[test]
    fn sampling_is_sent_when_thinking_is_not_on() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::user("hi"))
            .with_sampling(Sampling {
                temperature: Some(0.2),
                ..Sampling::default()
            });
        assert_eq!(encode(&request)["temperature"], 0.2);
    }

    #[test]
    fn tools_are_omitted_entirely_when_the_choice_is_none() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::user("hi"))
            .with_tools(tools())
            .with_tool_choice(ToolChoice::None);
        let body = encode(&request);
        assert!(body.get("tools").is_none());
        assert!(body.get("tool_choice").is_none());
    }

    #[test]
    fn a_forced_tool_choice_is_relaxed_to_auto_while_thinking_is_on() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::user("hi"))
            .with_tools(tools())
            .with_tool_choice(ToolChoice::Required)
            .with_reasoning(ReasoningRequest::Enabled {
                budget_tokens: None,
            });
        assert_eq!(
            encode(&request)["tool_choice"]["type"],
            "auto",
            "manual thinking rejects a forced tool choice outright"
        );
        let without = ChatRequest::new("m")
            .with_message(ChatMessage::user("hi"))
            .with_tools(tools())
            .with_tool_choice(ToolChoice::Required);
        assert_eq!(encode(&without)["tool_choice"]["type"], "any");
    }

    #[test]
    fn structured_output_becomes_a_forced_call_to_an_internal_schema_tool() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::user("hi"))
            .with_response_format(ResponseFormat::JsonSchema {
                name: "answer".into(),
                schema: json!({"type": "object", "required": ["answer"]}),
            });
        let encoded = encode_request(&request, false, Concessions::default(), true);
        assert!(encoded.schema_tool);
        assert_eq!(encoded.body["tools"][0]["name"], SCHEMA_TOOL_NAME);
        assert_eq!(encoded.body["tool_choice"]["name"], SCHEMA_TOOL_NAME);
        assert!(
            encoded.body.get("response_format").is_none(),
            "this API has no response_format field to send"
        );
    }

    #[test]
    fn a_schema_with_no_type_keyword_is_completed_rather_than_rejected() {
        assert_eq!(
            as_input_schema(&json!({"required": ["a"]}))["type"],
            "object"
        );
        assert_eq!(
            as_input_schema(&json!({"type": "object"}))["type"],
            "object"
        );
        assert_eq!(as_input_schema(&json!("nonsense"))["type"], "object");
    }

    #[test]
    fn a_signed_thinking_block_is_replayed_verbatim_and_an_unsigned_one_is_dropped() {
        let request = ChatRequest::new("m").with_message(ChatMessage::new(
            MessageRole::Assistant,
            vec![
                ContentPart::Reasoning {
                    text: "signed deliberation".into(),
                    signature: Some("WaUjzky".into()),
                    redacted: false,
                },
                ContentPart::Reasoning {
                    text: "from another backend".into(),
                    signature: None,
                    redacted: false,
                },
                ContentPart::text("the answer"),
            ],
        ));
        let body = encode(&request);
        let blocks = body["messages"][0]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 2, "the unsigned block is dropped: {body}");
        assert_eq!(blocks[0]["type"], "thinking");
        assert_eq!(blocks[0]["signature"], "WaUjzky");
        assert!(!body.to_string().contains("from another backend"));
    }

    #[test]
    fn a_redacted_thinking_block_survives_the_round_trip() {
        // THK-8: filtering by `type == "thinking"` drops these and breaks the
        // protocol, so the encoder must carry them through untouched.
        let request = ChatRequest::new("m").with_message(ChatMessage::new(
            MessageRole::Assistant,
            vec![ContentPart::Reasoning {
                text: "EncryptedPayload==".into(),
                signature: None,
                redacted: true,
            }],
        ));
        let blocks = encode(&request)["messages"][0]["content"].clone();
        assert_eq!(blocks[0]["type"], "redacted_thinking");
        assert_eq!(blocks[0]["data"], "EncryptedPayload==");
    }

    #[test]
    fn reasoning_is_dropped_wholesale_once_the_history_has_been_refused() {
        let request = ChatRequest::new("m").with_message(ChatMessage::new(
            MessageRole::Assistant,
            vec![
                ContentPart::Reasoning {
                    text: "signed".into(),
                    signature: Some("sig".into()),
                    redacted: false,
                },
                ContentPart::text("answer"),
            ],
        ));
        let body = encode_request(
            &request,
            false,
            Concessions {
                prior_reasoning: true,
                ..Concessions::default()
            },
            true,
        )
        .body;
        let blocks = body["messages"][0]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["type"], "text");
    }

    #[test]
    fn a_tool_result_rides_in_a_user_turn_because_there_is_no_tool_role() {
        let request = ChatRequest::new("m").with_message(ChatMessage::new(
            MessageRole::Tool,
            vec![ContentPart::ToolResult {
                call_id: "toolu_1".into(),
                content: "21C".into(),
                is_error: false,
            }],
        ));
        let body = encode(&request);
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"][0]["type"], "tool_result");
        assert_eq!(body["messages"][0]["content"][0]["tool_use_id"], "toolu_1");
    }

    #[test]
    fn an_assistant_tool_call_keeps_its_arguments_as_an_object() {
        let request = ChatRequest::new("m").with_message(ChatMessage::new(
            MessageRole::Assistant,
            vec![ContentPart::ToolCall {
                call_id: "toolu_1".into(),
                name: "get_weather".into(),
                arguments: json!({"city": "berlin"}),
            }],
        ));
        let block = encode(&request)["messages"][0]["content"][0].clone();
        assert_eq!(block["type"], "tool_use");
        assert_eq!(
            block["input"],
            json!({"city": "berlin"}),
            "this API takes an object, not a JSON string"
        );
    }

    #[test]
    fn an_image_is_sent_as_base64_bytes_not_a_url() {
        let request = ChatRequest::new("m").with_message(ChatMessage::new(
            MessageRole::User,
            vec![ContentPart::Image {
                mime_type: "image/png".into(),
                data: vec![0x89, 0x50, 0x4e],
            }],
        ));
        let source = encode(&request)["messages"][0]["content"][0]["source"].clone();
        assert_eq!(source["type"], "base64");
        assert_eq!(source["media_type"], "image/png");
        assert_eq!(source["data"], "iVBO");
    }

    #[test]
    fn cache_hints_become_breakpoints_and_nothing_else_changes() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::system("stable prefix"))
            .with_message(ChatMessage::user("turn one"))
            .with_message(ChatMessage::assistant("answer one"))
            .with_message(ChatMessage::user("turn two"))
            .with_cache_hints(CacheHints {
                cache_system_prompt: true,
                cache_conversation_prefix: true,
            });
        let body = encode(&request);
        assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!(
            messages[1]["content"][0]["cache_control"]["type"], "ephemeral",
            "the breakpoint ends before the final turn, which changes every request"
        );
        assert!(messages[2]["content"][0].get("cache_control").is_none());
    }

    #[test]
    fn no_cache_hint_means_no_cache_control_anywhere() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::system("s"))
            .with_message(ChatMessage::user("a"))
            .with_message(ChatMessage::assistant("b"))
            .with_message(ChatMessage::user("c"));
        assert!(!encode(&request).to_string().contains("cache_control"));
    }

    #[test]
    fn the_interleaved_beta_is_sent_only_for_manual_thinking_with_tools() {
        let base = ChatRequest::new("m").with_message(ChatMessage::user("hi"));
        let with_both =
            base.clone()
                .with_tools(tools())
                .with_reasoning(ReasoningRequest::Enabled {
                    budget_tokens: None,
                });
        assert_eq!(
            encode_request(&with_both, true, Concessions::default(), true).betas,
            vec![INTERLEAVED_THINKING_BETA]
        );
        assert!(
            encode_request(&with_both, true, Concessions::default(), false)
                .betas
                .is_empty(),
            "the option must be able to turn it off"
        );
        assert!(
            encode_request(
                &with_both,
                true,
                Concessions {
                    interleaved_beta: true,
                    ..Concessions::default()
                },
                true
            )
            .betas
            .is_empty(),
            "a refusal must be able to withdraw it"
        );
        assert!(
            encode_request(
                &base.clone().with_tools(tools()),
                true,
                Concessions::default(),
                true
            )
            .betas
            .is_empty(),
            "no thinking, no interleaving"
        );
    }

    #[test]
    fn the_thinking_object_disappears_once_the_model_has_refused_it() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::user("hi"))
            .with_reasoning(ReasoningRequest::Disabled);
        assert_eq!(encode(&request)["thinking"]["type"], "disabled");
        assert!(encode_request(
            &request,
            false,
            Concessions {
                thinking_config: true,
                ..Concessions::default()
            },
            true
        )
        .body
        .get("thinking")
        .is_none());
    }

    #[test]
    fn an_empty_message_is_not_sent_because_the_api_rejects_empty_content() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::new(MessageRole::Assistant, vec![]))
            .with_message(ChatMessage::user("hi"));
        assert_eq!(encode(&request)["messages"].as_array().unwrap().len(), 1);
    }
}
