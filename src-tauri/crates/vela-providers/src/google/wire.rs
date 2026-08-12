//! Encoding Vela's request model into the Gemini `generateContent` wire format.
//!
//! This module and [`super::stream`] are the only two places in Vela that know
//! what `contents`, `parts`, `inlineData`, `functionDeclarations`,
//! `systemInstruction`, `safetySettings` or `thinkingConfig` are. Above the
//! adapter boundary there is only [`ChatRequest`] and [`ChatResponse`].
//!
//! Five rules are enforced here rather than trusted to call sites:
//!
//! * **There is no system role.** This API takes one top-level
//!   `systemInstruction`; a `system` message that stayed in `contents` is a 400.
//!   Every system turn in the conversation is collected into that one field —
//!   or, once a model has refused the field, folded into the first user turn so
//!   the instruction is not silently lost.
//! * **`contents` alternates.** Consecutive turns with the same role are merged
//!   rather than sent as-is: it costs nothing, and it removes the most common
//!   way a replayed transcript turns into a rejected request.
//! * **A tool result is addressed by tool *name*, not by call id.** Vela's model
//!   correlates by `call_id` (every other backend does); this API's
//!   `functionResponse` carries `name`. The mapping is rebuilt from the
//!   conversation here, so a transcript that round-trips through `vela-store`
//!   still encodes correctly.
//! * **Schemas are reduced to the subset this API accepts.** It rejects
//!   ordinary JSON Schema keywords (`$schema`, `additionalProperties`, `$defs`,
//!   `oneOf`, …) outright. Unknown keywords are dropped rather than passed
//!   through, because a 400 on an unrecognised keyword loses the whole turn
//!   while a dropped keyword only weakens the constraint — and the answer is
//!   validated against the *caller's* schema regardless (MEASURED-5).
//! * **No `Authorization` header is built here.** Auth is applied in
//!   `provider.rs` through `vela_secrets::resolve_auth`, the one function that
//!   guarantees "no credential" means *no header* rather than an empty one.

use serde_json::{json, Map, Value};

use crate::model::{
    ChatMessage, ChatRequest, ContentPart, MessageRole, ReasoningRequest, ResponseFormat,
    ToolChoice,
};
use crate::openai_compatible::wire::base64_encode;

/// The API version this adapter targets. `v1beta` rather than `v1` because
/// `thinkingConfig`, `responseSchema` and `systemInstruction` are only there.
/// Configurable on the provider: a gateway may pin an older one.
pub const DEFAULT_API_VERSION: &str = "v1beta";

/// The resource-name prefix for an ordinary published model.
const MODEL_PREFIX: &str = "models/";

/// Keywords this API's `Schema` understands. Everything else is dropped — see
/// the module docs for why dropping beats forwarding.
const SCHEMA_KEYWORDS: &[&str] = &[
    "type",
    "format",
    "title",
    "description",
    "nullable",
    "enum",
    "items",
    "properties",
    "required",
    "anyOf",
    "propertyOrdering",
    "minItems",
    "maxItems",
    "minProperties",
    "maxProperties",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "pattern",
    "example",
    "default",
];

/// Reductions applied to a retried request after the endpoint refused the
/// original shape. Each is applied *once*, on evidence, never pre-emptively.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Concessions {
    /// Do not send `generationConfig.thinkingConfig`.
    pub thinking_config: bool,
    /// Do not send a top-level `systemInstruction`; fold it into the first user
    /// turn instead, so the instruction still reaches the model.
    pub system_instruction: bool,
    /// Do not send `safetySettings` at all.
    pub safety_settings: bool,
}

/// A harm category this API can be told about.
///
/// Modelled as an enum rather than a free string so a typo cannot become a
/// silently ignored setting — and so the set the adapter will send is
/// enumerable and testable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HarmCategory {
    Harassment,
    HateSpeech,
    SexuallyExplicit,
    DangerousContent,
    CivicIntegrity,
}

impl HarmCategory {
    pub const ALL: [HarmCategory; 5] = [
        HarmCategory::Harassment,
        HarmCategory::HateSpeech,
        HarmCategory::SexuallyExplicit,
        HarmCategory::DangerousContent,
        HarmCategory::CivicIntegrity,
    ];

    pub const fn wire_name(self) -> &'static str {
        match self {
            HarmCategory::Harassment => "HARM_CATEGORY_HARASSMENT",
            HarmCategory::HateSpeech => "HARM_CATEGORY_HATE_SPEECH",
            HarmCategory::SexuallyExplicit => "HARM_CATEGORY_SEXUALLY_EXPLICIT",
            HarmCategory::DangerousContent => "HARM_CATEGORY_DANGEROUS_CONTENT",
            HarmCategory::CivicIntegrity => "HARM_CATEGORY_CIVIC_INTEGRITY",
        }
    }
}

/// How much the endpoint should block in a category.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SafetyThreshold {
    BlockLowAndAbove,
    BlockMediumAndAbove,
    BlockOnlyHigh,
    BlockNone,
    /// Turn the category off entirely where the endpoint supports it.
    Off,
}

impl SafetyThreshold {
    pub const fn wire_name(self) -> &'static str {
        match self {
            SafetyThreshold::BlockLowAndAbove => "BLOCK_LOW_AND_ABOVE",
            SafetyThreshold::BlockMediumAndAbove => "BLOCK_MEDIUM_AND_ABOVE",
            SafetyThreshold::BlockOnlyHigh => "BLOCK_ONLY_HIGH",
            SafetyThreshold::BlockNone => "BLOCK_NONE",
            SafetyThreshold::Off => "OFF",
        }
    }
}

/// One `safetySettings` entry.
///
/// Vela sends **none** by default. The endpoint's own defaults are the user's
/// business, and quietly loosening someone's content filtering is not a
/// decision a model-agnostic client gets to make on their behalf. A caller that
/// wants different thresholds sets them explicitly at construction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SafetySetting {
    pub category: HarmCategory,
    pub threshold: SafetyThreshold,
}

impl SafetySetting {
    pub const fn new(category: HarmCategory, threshold: SafetyThreshold) -> Self {
        Self {
            category,
            threshold,
        }
    }

    /// The same threshold for every modelled category.
    pub fn all(threshold: SafetyThreshold) -> Vec<Self> {
        HarmCategory::ALL
            .into_iter()
            .map(|category| Self::new(category, threshold))
            .collect()
    }
}

/// An encoded request, plus what the adapter needs to remember about it.
#[derive(Debug, Clone, PartialEq)]
pub struct Encoded {
    pub body: Value,
    /// A `responseSchema` was sent, so the answer must be validated against the
    /// caller's schema when it comes back (MEASURED-5).
    pub schema_requested: bool,
}

/// The resource path for a model id.
///
/// Users type `gemini-2.5-flash`; the API wants `models/gemini-2.5-flash`. An
/// id that already carries a collection prefix — `models/…`, `tunedModels/…` —
/// is left alone, because rewriting it would break the one case where the user
/// knew exactly what they meant.
pub fn model_resource(model_id: &str) -> String {
    let trimmed = model_id.trim().trim_start_matches('/');
    if trimmed.contains('/') {
        trimmed.to_owned()
    } else {
        format!("{MODEL_PREFIX}{trimmed}")
    }
}

/// The bare model id for a resource name, for reporting back to the caller.
pub fn model_id_of(resource: &str) -> &str {
    resource.strip_prefix(MODEL_PREFIX).unwrap_or(resource)
}

/// Encode a request body.
pub fn encode_request(
    request: &ChatRequest,
    concessions: Concessions,
    safety: &[SafetySetting],
) -> Encoded {
    let mut body = Map::new();

    // --- system instruction ------------------------------------------------
    let system_text = request
        .messages
        .iter()
        .filter(|message| message.role == MessageRole::System)
        .map(ChatMessage::answer_text)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let fold_system = concessions.system_instruction && !system_text.is_empty();
    if !system_text.is_empty() && !fold_system {
        body.insert(
            "systemInstruction".into(),
            json!({"parts": [{"text": system_text}]}),
        );
    }

    // --- contents ----------------------------------------------------------
    let names = tool_names_by_call_id(&request.messages);
    let mut contents: Vec<Value> = Vec::new();
    for message in request
        .messages
        .iter()
        .filter(|message| message.role != MessageRole::System)
    {
        let parts = encode_parts(message, &names);
        if parts.is_empty() {
            continue;
        }
        let role = role_name(message.role);
        // Merge into the previous turn when the role repeats. This API is
        // documented as a user/model alternation and a replayed transcript
        // (tool call, then tool result, then another user turn) trips it.
        match contents.last_mut() {
            Some(previous) if previous["role"] == role => {
                if let Some(Value::Array(existing)) = previous.get_mut("parts") {
                    existing.extend(parts);
                }
            }
            _ => contents.push(json!({"role": role, "parts": parts})),
        }
    }
    if fold_system {
        fold_system_instruction(&mut contents, &system_text);
    }
    body.insert("contents".into(), Value::Array(contents));

    // --- tools -------------------------------------------------------------
    if request.offers_tools() {
        body.insert(
            "tools".into(),
            json!([{
                "functionDeclarations": request
                    .tools
                    .iter()
                    .map(|tool| json!({
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": sanitise_schema(&tool.parameters),
                    }))
                    .collect::<Vec<_>>(),
            }]),
        );
        let config = match &request.tool_choice {
            ToolChoice::Auto => json!({"mode": "AUTO"}),
            ToolChoice::Required => json!({"mode": "ANY"}),
            ToolChoice::Named { name } => {
                json!({"mode": "ANY", "allowedFunctionNames": [name]})
            }
            // Unreachable: `offers_tools()` is false for `None`, and the
            // catalogue is withheld entirely rather than sent alongside a
            // "no tools" hint (GATE M FINDING 6, kept identical across adapters).
            ToolChoice::None => json!({"mode": "NONE"}),
        };
        body.insert(
            "toolConfig".into(),
            json!({"functionCallingConfig": config}),
        );
    }

    // --- safety ------------------------------------------------------------
    if !safety.is_empty() && !concessions.safety_settings {
        body.insert(
            "safetySettings".into(),
            Value::Array(
                safety
                    .iter()
                    .map(|setting| {
                        json!({
                            "category": setting.category.wire_name(),
                            "threshold": setting.threshold.wire_name(),
                        })
                    })
                    .collect(),
            ),
        );
    }

    // --- generationConfig --------------------------------------------------
    let mut generation = Map::new();
    if let Some(max_output_tokens) = request.max_output_tokens {
        generation.insert("maxOutputTokens".into(), json!(max_output_tokens));
    }
    if let Some(temperature) = request.sampling.temperature {
        generation.insert("temperature".into(), json!(round4(temperature)));
    }
    if let Some(top_p) = request.sampling.top_p {
        generation.insert("topP".into(), json!(round4(top_p)));
    }
    if !request.sampling.stop.is_empty() {
        generation.insert("stopSequences".into(), json!(request.sampling.stop));
    }
    if let Some(seed) = request.sampling.seed {
        // The field is a signed 32-bit int here; a value that does not fit is
        // dropped rather than wrapped into a different seed than the user chose.
        if let Ok(seed) = i32::try_from(seed) {
            generation.insert("seed".into(), json!(seed));
        }
    }

    let mut schema_requested = false;
    if let ResponseFormat::JsonSchema { schema, .. } = &request.response_format {
        schema_requested = true;
        generation.insert("responseMimeType".into(), json!("application/json"));
        generation.insert("responseSchema".into(), sanitise_schema(schema));
    }

    if !concessions.thinking_config {
        match request.reasoning {
            // "Take whatever the model does by default": send nothing. Models
            // differ in which thinking modes they accept, and the default is
            // the one setting that is never refused.
            ReasoningRequest::Auto => {}
            ReasoningRequest::Disabled => {
                generation.insert("thinkingConfig".into(), json!({"thinkingBudget": 0}));
            }
            ReasoningRequest::Enabled { budget_tokens } => {
                let mut config = Map::new();
                // Without this the model still thinks and Vela never sees the
                // thought parts — which would look like a model with no
                // reasoning at all rather than one whose reasoning was withheld.
                config.insert("includeThoughts".into(), json!(true));
                if let Some(budget) = budget_tokens {
                    config.insert("thinkingBudget".into(), json!(budget));
                }
                generation.insert("thinkingConfig".into(), Value::Object(config));
            }
        }
    }

    if !generation.is_empty() {
        body.insert("generationConfig".into(), Value::Object(generation));
    }

    // No `cachedContent`: Vela never uploads a conversation to a server-side
    // cache. Cache hints stay advisory here, and the adapter reports prompt
    // caching only if the endpoint's own accounting shows it (see `stream`).

    Encoded {
        body: Value::Object(body),
        schema_requested,
    }
}

pub fn role_name(role: MessageRole) -> &'static str {
    match role {
        // There is no tool role and no system role in `contents`: a tool result
        // rides in a user turn, and system turns never reach here.
        MessageRole::System | MessageRole::User | MessageRole::Tool => "user",
        MessageRole::Assistant => "model",
    }
}

/// `call_id -> tool name`, rebuilt from the assistant turns in the transcript.
///
/// Vela's model correlates a result with a call by id; this API correlates by
/// name. Without this map a replayed conversation would send a
/// `functionResponse` naming a call id, which the endpoint does not recognise.
fn tool_names_by_call_id(messages: &[ChatMessage]) -> std::collections::HashMap<String, String> {
    let mut names = std::collections::HashMap::new();
    for message in messages {
        for (call_id, name, _) in message.tool_calls() {
            names
                .entry(call_id.to_owned())
                .or_insert_with(|| name.to_owned());
        }
    }
    names
}

fn encode_parts(
    message: &ChatMessage,
    names: &std::collections::HashMap<String, String>,
) -> Vec<Value> {
    let mut parts = Vec::new();
    for part in &message.parts {
        match part {
            ContentPart::Text { text } => {
                if !text.is_empty() {
                    parts.push(json!({"text": text}));
                }
            }
            ContentPart::Image { mime_type, data } => parts.push(json!({
                "inlineData": {"mimeType": mime_type, "data": base64_encode(data)}
            })),
            ContentPart::Reasoning {
                text,
                signature,
                redacted,
            } => {
                // A thought is only replayable with the signature the endpoint
                // issued for it; without one it is rejected, and it costs input
                // tokens for nothing. A reasoning part with no signature came
                // from another backend, and a redacted one has no counterpart
                // on this API at all — both are dropped rather than mangled.
                if *redacted {
                    continue;
                }
                if let Some(signature) = signature {
                    parts.push(json!({
                        "text": text,
                        "thought": true,
                        "thoughtSignature": signature,
                    }));
                }
            }
            ContentPart::ToolCall {
                name, arguments, ..
            } => parts.push(json!({
                "functionCall": {"name": name, "args": arguments},
            })),
            ContentPart::ToolResult {
                call_id,
                content,
                is_error,
            } => {
                let name = names
                    .get(call_id)
                    .cloned()
                    .unwrap_or_else(|| call_id.clone());
                parts.push(json!({
                    "functionResponse": {
                        "name": name,
                        "response": tool_response_object(content, *is_error),
                    }
                }));
            }
        }
    }
    parts
}

/// This API requires `functionResponse.response` to be an **object**.
///
/// A tool that already returned JSON keeps its shape; anything else is wrapped
/// under one key so a plain-text result is not mistaken for a malformed one.
fn tool_response_object(content: &str, is_error: bool) -> Value {
    let key = if is_error { "error" } else { "result" };
    match serde_json::from_str::<Value>(content.trim()) {
        Ok(Value::Object(object)) if !is_error => Value::Object(object),
        _ => json!({key: content}),
    }
}

/// Put the system instruction where a model that refuses the dedicated field
/// will still read it: at the head of the first user turn.
fn fold_system_instruction(contents: &mut Vec<Value>, system_text: &str) {
    let folded = json!({"text": format!("{system_text}\n\n")});
    match contents
        .iter_mut()
        .find(|content| content["role"] == "user")
    {
        Some(content) => {
            if let Some(Value::Array(parts)) = content.get_mut("parts") {
                parts.insert(0, folded);
            }
        }
        None => contents.insert(0, json!({"role": "user", "parts": [folded]})),
    }
}

/// Reduce a JSON Schema to the subset this API's `Schema` accepts.
///
/// Unknown keywords are dropped, `type` values are upper-cased to the enum
/// spelling the API documents, and the recursion follows `properties`, `items`
/// and `anyOf`. A schema that is not an object at all becomes the empty object
/// schema rather than a 400.
pub fn sanitise_schema(schema: &Value) -> Value {
    let Some(object) = schema.as_object() else {
        return json!({"type": "OBJECT"});
    };
    let mut out = Map::new();
    for (key, value) in object {
        if !SCHEMA_KEYWORDS.contains(&key.as_str()) {
            continue;
        }
        let value = match key.as_str() {
            "type" => match value.as_str() {
                Some(name) => json!(name.to_ascii_uppercase()),
                None => continue,
            },
            "properties" => match value.as_object() {
                Some(properties) => Value::Object(
                    properties
                        .iter()
                        .map(|(name, child)| (name.clone(), sanitise_schema(child)))
                        .collect(),
                ),
                None => continue,
            },
            "items" => sanitise_schema(value),
            "anyOf" => match value.as_array() {
                Some(branches) => Value::Array(branches.iter().map(sanitise_schema).collect()),
                None => continue,
            },
            _ => value.clone(),
        };
        out.insert(key.clone(), value);
    }
    if !out.contains_key("type") && out.contains_key("properties") {
        // A schema with properties and no `type` keyword is valid JSON Schema
        // and is rejected here, so the one missing keyword is filled in.
        out.insert("type".into(), json!("OBJECT"));
    }
    if out.is_empty() {
        return json!({"type": "OBJECT"});
    }
    Value::Object(out)
}

/// Decode standard base64. Returns `None` on anything that is not valid
/// base64 — an endpoint sending malformed bytes is damage, not data.
///
/// Hand-rolled to match `base64_encode`, keeping the dependency surface of the
/// one crate that opens sockets as small as it already is.
pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut accumulator: u32 = 0;
    let mut bits = 0u32;
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            // Whitespace is legal padding in transport encodings.
            b'\n' | b'\r' | b' ' | b'\t' => continue,
            _ => return None,
        };
        accumulator = (accumulator << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((accumulator >> bits) & 0xff) as u8);
        }
    }
    Some(out)
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
    use crate::model::{Sampling, ToolDefinition};

    fn tools() -> Vec<ToolDefinition> {
        vec![ToolDefinition::new(
            "get_weather",
            "Current weather",
            json!({"type": "object", "properties": {"city": {"type": "string"}}}),
        )]
    }

    fn encode(request: &ChatRequest) -> Value {
        encode_request(request, Concessions::default(), &[]).body
    }

    #[test]
    fn a_system_turn_becomes_the_top_level_instruction_not_a_content() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::system("be brief"))
            .with_message(ChatMessage::user("hi"));
        let body = encode(&request);
        assert_eq!(body["systemInstruction"]["parts"][0]["text"], "be brief");
        assert_eq!(body["contents"].as_array().unwrap().len(), 1);
        assert_eq!(body["contents"][0]["role"], "user");
    }

    #[test]
    fn a_refused_system_instruction_is_folded_into_the_first_user_turn() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::system("be brief"))
            .with_message(ChatMessage::user("hi"));
        let body = encode_request(
            &request,
            Concessions {
                system_instruction: true,
                ..Concessions::default()
            },
            &[],
        )
        .body;
        assert!(
            body.get("systemInstruction").is_none(),
            "the refused field must not be resent"
        );
        assert_eq!(body["contents"][0]["parts"][0]["text"], "be brief\n\n");
        assert_eq!(
            body["contents"][0]["parts"][1]["text"], "hi",
            "the instruction must not replace the user's message: {body}"
        );
    }

    #[test]
    fn consecutive_turns_with_the_same_role_are_merged_into_one_content() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::user("first"))
            .with_message(ChatMessage::user("second"))
            .with_message(ChatMessage::assistant("answer"));
        let contents = encode(&request)["contents"].clone();
        assert_eq!(contents.as_array().unwrap().len(), 2);
        assert_eq!(contents[0]["parts"][0]["text"], "first");
        assert_eq!(contents[0]["parts"][1]["text"], "second");
        assert_eq!(contents[1]["role"], "model");
    }

    #[test]
    fn a_tool_result_is_addressed_by_the_name_of_the_call_it_answers() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::user("weather?"))
            .with_message(ChatMessage::new(
                MessageRole::Assistant,
                vec![ContentPart::ToolCall {
                    call_id: "call_slot_0".into(),
                    name: "get_weather".into(),
                    arguments: json!({"city": "berlin"}),
                }],
            ))
            .with_message(ChatMessage::new(
                MessageRole::Tool,
                vec![ContentPart::ToolResult {
                    call_id: "call_slot_0".into(),
                    content: "{\"celsius\": 21}".into(),
                    is_error: false,
                }],
            ));
        let contents = encode(&request)["contents"].clone();
        assert_eq!(
            contents[1]["parts"][0]["functionCall"]["name"],
            "get_weather"
        );
        let response = contents[2]["parts"][0]["functionResponse"].clone();
        assert_eq!(
            response["name"], "get_weather",
            "this API correlates by name, not by call id: {contents}"
        );
        assert_eq!(
            response["response"],
            json!({"celsius": 21}),
            "a JSON result keeps its shape"
        );
    }

    #[test]
    fn a_plain_text_tool_result_is_wrapped_because_the_field_must_be_an_object() {
        let request = ChatRequest::new("m").with_message(ChatMessage::new(
            MessageRole::Tool,
            vec![
                ContentPart::ToolResult {
                    call_id: "c1".into(),
                    content: "21 degrees".into(),
                    is_error: false,
                },
                ContentPart::ToolResult {
                    call_id: "c2".into(),
                    content: "no such city".into(),
                    is_error: true,
                },
            ],
        ));
        let parts = encode(&request)["contents"][0]["parts"].clone();
        assert_eq!(
            parts[0]["functionResponse"]["response"]["result"],
            "21 degrees"
        );
        assert_eq!(
            parts[1]["functionResponse"]["response"]["error"], "no such city",
            "a failed call is data, and says so"
        );
        assert_eq!(
            parts[0]["functionResponse"]["name"], "c1",
            "with no matching call the id is the best name available"
        );
    }

    #[test]
    fn an_image_is_sent_as_inline_base64_bytes_not_a_url() {
        let request = ChatRequest::new("m").with_message(ChatMessage::new(
            MessageRole::User,
            vec![ContentPart::Image {
                mime_type: "image/png".into(),
                data: vec![0x89, 0x50, 0x4e],
            }],
        ));
        let inline = encode(&request)["contents"][0]["parts"][0]["inlineData"].clone();
        assert_eq!(inline["mimeType"], "image/png");
        assert_eq!(inline["data"], "iVBO");
    }

    #[test]
    fn tools_are_omitted_entirely_when_the_choice_is_none() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::user("hi"))
            .with_tools(tools())
            .with_tool_choice(ToolChoice::None);
        let body = encode(&request);
        assert!(body.get("tools").is_none());
        assert!(body.get("toolConfig").is_none());
    }

    #[test]
    fn a_forced_tool_choice_becomes_any_and_a_named_one_allows_only_that_name() {
        let base = ChatRequest::new("m")
            .with_message(ChatMessage::user("hi"))
            .with_tools(tools());
        assert_eq!(
            encode(&base.clone().with_tool_choice(ToolChoice::Required))["toolConfig"]
                ["functionCallingConfig"]["mode"],
            "ANY"
        );
        let named = encode(&base.with_tool_choice(ToolChoice::Named {
            name: "get_weather".into(),
        }));
        let config = named["toolConfig"]["functionCallingConfig"].clone();
        assert_eq!(config["mode"], "ANY");
        assert_eq!(config["allowedFunctionNames"][0], "get_weather");
    }

    #[test]
    fn structured_output_becomes_a_response_mime_type_and_a_reduced_schema() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::user("hi"))
            .with_response_format(ResponseFormat::JsonSchema {
                name: "weather".into(),
                schema: json!({
                    "$schema": "https://json-schema.org/draft/2020-12/schema",
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "city": {"type": "string", "pattern": "^[a-z]+$"},
                        "tags": {"type": "array", "items": {"type": "string", "const": "x"}},
                    },
                    "required": ["city"],
                }),
            });
        let encoded = encode_request(&request, Concessions::default(), &[]);
        assert!(encoded.schema_requested);
        let generation = encoded.body["generationConfig"].clone();
        assert_eq!(generation["responseMimeType"], "application/json");
        let schema = generation["responseSchema"].clone();
        assert_eq!(schema["type"], "OBJECT");
        assert_eq!(schema["properties"]["city"]["type"], "STRING");
        assert_eq!(schema["properties"]["tags"]["items"]["type"], "STRING");
        assert_eq!(schema["required"][0], "city");
        assert_eq!(
            schema["properties"]["city"]["pattern"], "^[a-z]+$",
            "a keyword this API does understand survives"
        );
        for rejected in ["$schema", "additionalProperties"] {
            assert!(
                !schema.to_string().contains(rejected),
                "{rejected} is a 400 on this API: {schema}"
            );
        }
        assert!(
            !schema.to_string().contains("const"),
            "an unknown keyword inside an items schema must be dropped too: {schema}"
        );
    }

    #[test]
    fn a_schema_with_properties_but_no_type_keyword_is_completed() {
        let schema = sanitise_schema(&json!({"properties": {"a": {"type": "string"}}}));
        assert_eq!(schema["type"], "OBJECT");
        assert_eq!(sanitise_schema(&json!("nonsense"))["type"], "OBJECT");
        assert_eq!(sanitise_schema(&json!({"$ref": "#/x"}))["type"], "OBJECT");
    }

    #[test]
    fn thinking_is_only_configured_when_the_caller_asked_for_a_mode() {
        let base = ChatRequest::new("m").with_message(ChatMessage::user("hi"));
        assert!(
            encode(&base).get("generationConfig").is_none(),
            "an unadorned request carries no generationConfig at all"
        );
        let disabled = encode(&base.clone().with_reasoning(ReasoningRequest::Disabled));
        assert_eq!(
            disabled["generationConfig"]["thinkingConfig"]["thinkingBudget"],
            0
        );
        let enabled = encode(&base.clone().with_reasoning(ReasoningRequest::Enabled {
            budget_tokens: Some(2_048),
        }));
        let config = enabled["generationConfig"]["thinkingConfig"].clone();
        assert_eq!(config["thinkingBudget"], 2_048);
        assert_eq!(
            config["includeThoughts"], true,
            "without this the thoughts exist and Vela never sees them"
        );
    }

    #[test]
    fn the_thinking_config_disappears_once_the_model_has_refused_it() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::user("hi"))
            .with_reasoning(ReasoningRequest::Enabled {
                budget_tokens: Some(2_048),
            });
        let body = encode_request(
            &request,
            Concessions {
                thinking_config: true,
                ..Concessions::default()
            },
            &[],
        )
        .body;
        assert!(body
            .get("generationConfig")
            .and_then(|config| config.get("thinkingConfig"))
            .is_none());
    }

    #[test]
    fn no_safety_settings_are_sent_unless_the_caller_configured_them() {
        let request = ChatRequest::new("m").with_message(ChatMessage::user("hi"));
        assert!(
            encode(&request).get("safetySettings").is_none(),
            "loosening someone's content filtering is not Vela's decision to make"
        );
        let configured = encode_request(
            &request,
            Concessions::default(),
            &SafetySetting::all(SafetyThreshold::BlockNone),
        )
        .body;
        let settings = configured["safetySettings"].as_array().unwrap();
        assert_eq!(settings.len(), HarmCategory::ALL.len());
        assert_eq!(settings[0]["threshold"], "BLOCK_NONE");
        assert_eq!(settings[0]["category"], "HARM_CATEGORY_HARASSMENT");
    }

    #[test]
    fn safety_settings_disappear_once_the_endpoint_has_refused_a_category() {
        let request = ChatRequest::new("m").with_message(ChatMessage::user("hi"));
        let body = encode_request(
            &request,
            Concessions {
                safety_settings: true,
                ..Concessions::default()
            },
            &SafetySetting::all(SafetyThreshold::Off),
        )
        .body;
        assert!(body.get("safetySettings").is_none());
    }

    #[test]
    fn sampling_lands_in_generation_config_with_this_apis_spelling() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::user("hi"))
            .with_max_output_tokens(256)
            .with_sampling(Sampling {
                temperature: Some(0.2),
                top_p: Some(0.9),
                stop: vec!["</s>".into()],
                seed: Some(7),
            });
        let generation = encode(&request)["generationConfig"].clone();
        assert_eq!(generation["temperature"], 0.2);
        assert_eq!(generation["topP"], 0.9);
        assert_eq!(generation["stopSequences"][0], "</s>");
        assert_eq!(generation["seed"], 7);
        assert_eq!(generation["maxOutputTokens"], 256);
    }

    #[test]
    fn a_seed_that_does_not_fit_the_wire_field_is_dropped_rather_than_wrapped() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::user("hi"))
            .with_sampling(Sampling {
                seed: Some(u64::MAX),
                ..Sampling::default()
            });
        assert!(encode(&request)
            .get("generationConfig")
            .and_then(|config| config.get("seed"))
            .is_none());
    }

    #[test]
    fn a_signed_thought_is_replayed_and_an_unsigned_or_redacted_one_is_dropped() {
        let request = ChatRequest::new("m").with_message(ChatMessage::new(
            MessageRole::Assistant,
            vec![
                ContentPart::Reasoning {
                    text: "signed deliberation".into(),
                    signature: Some("CtcBAdHtim".into()),
                    redacted: false,
                },
                ContentPart::Reasoning {
                    text: "from another backend".into(),
                    signature: None,
                    redacted: false,
                },
                ContentPart::Reasoning {
                    text: "EncryptedPayload==".into(),
                    signature: Some("sig".into()),
                    redacted: true,
                },
                ContentPart::text("the answer"),
            ],
        ));
        let body = encode(&request);
        let parts = body["contents"][0]["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 2, "only the signed thought survives: {body}");
        assert_eq!(parts[0]["thought"], true);
        assert_eq!(parts[0]["thoughtSignature"], "CtcBAdHtim");
        assert!(!body.to_string().contains("from another backend"));
        assert!(!body.to_string().contains("EncryptedPayload"));
    }

    #[test]
    fn an_empty_message_is_not_sent_because_the_api_rejects_empty_parts() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::new(MessageRole::Assistant, vec![]))
            .with_message(ChatMessage::user("hi"));
        assert_eq!(encode(&request)["contents"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn a_model_id_gains_the_collection_prefix_only_when_it_has_none() {
        assert_eq!(
            model_resource("gemini-2.5-flash"),
            "models/gemini-2.5-flash"
        );
        assert_eq!(
            model_resource("models/gemini-2.5-flash"),
            "models/gemini-2.5-flash"
        );
        assert_eq!(
            model_resource("tunedModels/mine-abc"),
            "tunedModels/mine-abc"
        );
        assert_eq!(model_resource("/models/x"), "models/x");
        assert_eq!(model_id_of("models/gemini-2.5-flash"), "gemini-2.5-flash");
        assert_eq!(model_id_of("tunedModels/mine"), "tunedModels/mine");
    }

    #[test]
    fn base64_round_trips_and_refuses_bytes_that_are_not_base64() {
        for original in [
            b"".as_slice(),
            b"f",
            b"fo",
            b"foo",
            b"foobar",
            &[0xff, 0xfe],
        ] {
            assert_eq!(
                base64_decode(&base64_encode(original)).as_deref(),
                Some(original),
            );
        }
        assert_eq!(base64_decode("iVBO*"), None);
        assert_eq!(base64_decode("iV\nBO"), base64_decode("iVBO"));
    }
}
