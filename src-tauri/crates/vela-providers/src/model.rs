//! The unified internal request/response model — **the** normalisation layer.
//!
//! There is exactly one of these. Every backend converts *its* wire format to
//! and from the types here, and nothing above this crate ever sees an
//! OpenAI-shaped, Anthropic-shaped or llama.cpp-shaped payload.
//!
//! # Alignment with `vela-store`
//!
//! [`ContentPart`], [`MessageRole`], [`StopReason`] and [`TokenUsage`] are the
//! *same model* as `vela_store`'s, field for field and tag for tag — not a
//! second one. They are re-declared rather than imported because the dependency
//! must not exist in that direction: the provider seam has no business linking
//! SQLite, and `vela-store`'s own docs say the system of record must not depend
//! on the provider seam. The alignment is therefore held down mechanically, not
//! by prose: `tests/store_model_parity.rs` round-trips every variant through
//! JSON in both directions and fails if either side drifts.
//!
//! The two are converted at the one call site that owns both — the Tauri host
//! crate — exactly as `vela_store::model`'s `StopReason` comment prescribes.

use serde::{Deserialize, Serialize};

/// Who produced a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MessageRole {
    System,
    User,
    Assistant,
    Tool,
}

/// One piece of a message's content.
///
/// **Reasoning is a distinct part.** It is never merged into the answer, never
/// re-sent as answer text, and — see [`ChatMessage::tool_parse_text`] — never
/// fed to the tool-call parser: a model's private deliberation frequently
/// *describes* a call it then does not make.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ContentPart {
    /// Ordinary output. This — and only this — is the model's answer.
    Text { text: String },
    /// A `<think>` / reasoning block, or a separate `reasoning_content` field.
    Reasoning {
        text: String,
        /// Some backends sign reasoning blocks and require the signature back
        /// verbatim on the next turn. Round-tripping it is not optional.
        signature: Option<String>,
        /// The backend returned the block redacted; the text is a placeholder.
        redacted: bool,
    },
    /// Inline image bytes. Bytes, not a URL: Vela is offline-first, and the
    /// wire encoding (a `data:` URL, a base64 field) is the backend's problem.
    Image { mime_type: String, data: Vec<u8> },
    /// The model asked to run a tool.
    ToolCall {
        call_id: String,
        name: String,
        /// Arguments exactly as the model produced them.
        arguments: serde_json::Value,
    },
    /// The outcome of a tool call.
    ToolResult {
        call_id: String,
        content: String,
        /// A failed tool call is data, not an error: it is part of the
        /// transcript and is usually fed back to the model.
        is_error: bool,
    },
}

impl ContentPart {
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text { text: text.into() }
    }

    pub fn reasoning(text: impl Into<String>) -> Self {
        Self::Reasoning {
            text: text.into(),
            signature: None,
            redacted: false,
        }
    }

    pub fn is_reasoning(&self) -> bool {
        matches!(self, Self::Reasoning { .. })
    }
}

/// One turn, as the provider layer sees it. No ids, no timestamps, no
/// persistence concerns — those belong to `vela-store`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: MessageRole,
    pub parts: Vec<ContentPart>,
}

impl ChatMessage {
    pub fn new(role: MessageRole, parts: Vec<ContentPart>) -> Self {
        Self { role, parts }
    }

    pub fn user(text: impl Into<String>) -> Self {
        Self::new(MessageRole::User, vec![ContentPart::text(text)])
    }

    pub fn system(text: impl Into<String>) -> Self {
        Self::new(MessageRole::System, vec![ContentPart::text(text)])
    }

    pub fn assistant(text: impl Into<String>) -> Self {
        Self::new(MessageRole::Assistant, vec![ContentPart::text(text)])
    }

    /// The answer text only. Reasoning is excluded by construction.
    pub fn answer_text(&self) -> String {
        self.parts
            .iter()
            .filter_map(|part| match part {
                ContentPart::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    /// The text a tool-call parser is allowed to look at.
    ///
    /// Identical to [`ChatMessage::answer_text`], and separate from it so the
    /// exclusion of reasoning is a named rule with a test on it rather than an
    /// accident of which method someone happened to call.
    pub fn tool_parse_text(&self) -> String {
        self.answer_text()
    }

    pub fn reasoning_text(&self) -> Option<String> {
        let joined: String = self
            .parts
            .iter()
            .filter_map(|part| match part {
                ContentPart::Reasoning { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        (!joined.is_empty()).then_some(joined)
    }

    pub fn has_image(&self) -> bool {
        self.parts
            .iter()
            .any(|part| matches!(part, ContentPart::Image { .. }))
    }

    pub fn tool_calls(&self) -> impl Iterator<Item = (&str, &str, &serde_json::Value)> {
        self.parts.iter().filter_map(|part| match part {
            ContentPart::ToolCall {
                call_id,
                name,
                arguments,
            } => Some((call_id.as_str(), name.as_str(), arguments)),
            _ => None,
        })
    }
}

/// A tool Vela is offering the model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    /// JSON Schema for the arguments object.
    pub parameters: serde_json::Value,
}

impl ToolDefinition {
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        parameters: serde_json::Value,
    ) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            parameters,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ToolChoice {
    #[default]
    Auto,
    /// No tool use this turn.
    ///
    /// GATE M FINDING 6: `small-local` rejects a request carrying `tools` even
    /// with `tool_choice: "none"`. The encoder therefore omits the catalogue
    /// entirely in this state — see `openai::wire`.
    None,
    /// The model must call some tool.
    Required,
    /// The model must call this tool.
    Named { name: String },
}

/// What shape the answer must take.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ResponseFormat {
    #[default]
    Text,
    /// MEASURED-5: three of four profiles accept this, answer 200, and return
    /// prose, with nothing in the response saying the schema was ignored. It is
    /// therefore never sent without a policy for what to do about that —
    /// see [`StructuredOutputPolicy`](crate::structured::StructuredOutputPolicy).
    JsonSchema {
        name: String,
        schema: serde_json::Value,
    },
}

/// Whether Vela wants the model's reasoning, and how much of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ReasoningRequest {
    /// Take whatever the model does by default, and separate it correctly.
    #[default]
    Auto,
    /// Ask the model not to think out loud. Advisory: most endpoints ignore it,
    /// which is why separation runs regardless of this setting.
    Disabled,
    Enabled { budget_tokens: Option<u32> },
}

/// Prompt-caching hints. Advisory everywhere: an endpoint that does not cache
/// simply ignores them, and no behaviour depends on them being honoured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheHints {
    /// Mark the system prompt as a stable prefix worth caching.
    pub cache_system_prompt: bool,
    /// Mark everything up to the final user turn as a stable prefix.
    pub cache_conversation_prefix: bool,
}

/// Sampling knobs.
///
/// GATE M FINDING 7: `temperature`, `top_p`, `stop` and `seed` are accepted and
/// silently discarded by the matrix endpoints. They are sent anyway — a real
/// runtime honours them — but nothing in Vela may *depend* on them taking
/// effect, and no test asserts an effect that cannot be observed.
// No `Eq`: floats.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sampling {
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    pub stop: Vec<String>,
    pub seed: Option<u64>,
}

/// One completion request, backend-independent.
///
/// Build with [`ChatRequest::new`] and the `with_*` methods; the struct is
/// exhaustive-constructible too, but the builder keeps call sites readable and
/// survives new fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub model_id: String,
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolDefinition>,
    pub tool_choice: ToolChoice,
    pub response_format: ResponseFormat,
    pub reasoning: ReasoningRequest,
    pub cache: CacheHints,
    pub sampling: Sampling,
    pub max_output_tokens: Option<u32>,
    /// The context window Vela will plan against, when it knows one. `None`
    /// means "not known" — never a guess. Populated from a capability probe.
    pub max_context_tokens: Option<u32>,
}

impl ChatRequest {
    pub fn new(model_id: impl Into<String>) -> Self {
        Self {
            model_id: model_id.into(),
            messages: Vec::new(),
            tools: Vec::new(),
            tool_choice: ToolChoice::default(),
            response_format: ResponseFormat::default(),
            reasoning: ReasoningRequest::default(),
            cache: CacheHints::default(),
            sampling: Sampling::default(),
            max_output_tokens: None,
            max_context_tokens: None,
        }
    }

    pub fn with_message(mut self, message: ChatMessage) -> Self {
        self.messages.push(message);
        self
    }

    pub fn with_messages(mut self, messages: impl IntoIterator<Item = ChatMessage>) -> Self {
        self.messages.extend(messages);
        self
    }

    pub fn with_tools(mut self, tools: impl IntoIterator<Item = ToolDefinition>) -> Self {
        self.tools.extend(tools);
        self
    }

    pub fn with_tool_choice(mut self, choice: ToolChoice) -> Self {
        self.tool_choice = choice;
        self
    }

    pub fn with_response_format(mut self, format: ResponseFormat) -> Self {
        self.response_format = format;
        self
    }

    pub fn with_reasoning(mut self, reasoning: ReasoningRequest) -> Self {
        self.reasoning = reasoning;
        self
    }

    pub fn with_cache_hints(mut self, cache: CacheHints) -> Self {
        self.cache = cache;
        self
    }

    pub fn with_sampling(mut self, sampling: Sampling) -> Self {
        self.sampling = sampling;
        self
    }

    pub fn with_max_output_tokens(mut self, tokens: u32) -> Self {
        self.max_output_tokens = Some(tokens);
        self
    }

    pub fn with_max_context_tokens(mut self, tokens: u32) -> Self {
        self.max_context_tokens = Some(tokens);
        self
    }

    /// Does any message carry an image? Drives the vision capability check, so
    /// that "no vision" is refused *before* a request is sent rather than
    /// discovered as a 400.
    pub fn needs_vision(&self) -> bool {
        self.messages.iter().any(ChatMessage::has_image)
    }

    /// Will the catalogue actually be offered? `false` when there are no tools,
    /// or when the caller said `None` — the case FINDING 6 makes load-bearing.
    pub fn offers_tools(&self) -> bool {
        !self.tools.is_empty() && self.tool_choice != ToolChoice::None
    }

    pub fn wants_structured_output(&self) -> bool {
        matches!(self.response_format, ResponseFormat::JsonSchema { .. })
    }
}

/// Why generation stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    EndTurn,
    MaxTokens,
    Cancelled,
    ToolUse,
    /// The endpoint gave no reason. Recorded honestly rather than assumed.
    Unspecified,
}

/// Token accounting. Every field optional; `None` means **not reported**, which
/// is the normal case for local runtimes. Never substitute `0`: a zero is a
/// claim, an absence is the truth.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
    pub reasoning_tokens: Option<u32>,
    pub cached_input_tokens: Option<u32>,
}

impl TokenUsage {
    pub fn is_unreported(&self) -> bool {
        self == &Self::default()
    }
}

/// A tool call as it survived accumulation.
///
/// MEASURED-4: `hostile` produces calls with no name, no id, a misspelled
/// discriminator and arguments that are not JSON. Every one of those becomes a
/// [`ToolCallOutcome::Malformed`] the UI can show — never a silent drop, never
/// a best-effort reconstruction that gets executed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ToolCallOutcome {
    Ok {
        call_id: String,
        name: String,
        arguments: serde_json::Value,
        /// The call was recovered from the model's *text* because the endpoint
        /// has no native tool calling. Surfaced so the UI can say so.
        emulated: bool,
    },
    Malformed {
        /// The wire `index`, when one was ever sent. Deliberately not used as
        /// an array offset: `hostile` jumps from 0 to 7.
        index: Option<u32>,
        call_id: Option<String>,
        name: Option<String>,
        /// Arguments exactly as received, bounded. Shown to the user as
        /// evidence; never parsed into a call.
        raw_arguments: String,
        reason: MalformedToolCall,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MalformedToolCall {
    /// No `function.name` ever arrived.
    MissingName,
    /// `arguments` never parsed as JSON.
    UnparseableArguments,
    /// Arguments parsed, but not into a JSON object.
    ArgumentsNotAnObject,
    /// `type` was present and was not `function`.
    UnknownDiscriminator,
}

impl ToolCallOutcome {
    pub fn is_ok(&self) -> bool {
        matches!(self, ToolCallOutcome::Ok { .. })
    }
}

/// A deliberate, reported reduction in what Vela did compared to what was
/// asked. **Every degradation path emits one of these.** The UI reads them as
/// data; none of them names a provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Degradation {
    /// The model has no native tool calling, so the catalogue was rendered into
    /// the prompt and the answer parsed for a textual call.
    ToolCallingEmulated { tool_count: usize },
    /// Tools were withheld because the caller said `ToolChoice::None`
    /// (FINDING 6: sending them anyway is a 400 on some endpoints).
    ToolCatalogueWithheld,
    /// The conversation did not fit and was reduced, explicitly.
    ContextReduced {
        dropped_messages: usize,
        approx_dropped_tokens: u32,
        strategy: ContextStrategy,
    },
    /// A structured-output request went to a model that does not honour it.
    StructuredOutputUnsupported,
    /// The answer did not conform to the requested schema. MEASURED-5: this is
    /// reported explicitly because the endpoint reports nothing at all.
    StructuredOutputMismatch { detail: String },
    /// One or more SSE frames could not be parsed and were skipped. Prior
    /// content was kept (MEASURED-2).
    MalformedFramesSkipped { count: usize },
    /// The stream ended with a reasoning block still open (MEASURED-3).
    /// `recovered_answer_chars` is how much text was rescued out of it, so the
    /// answer is not swallowed.
    UnterminatedReasoning { recovered_answer_chars: usize },
    /// `[DONE]` never arrived; end-of-body terminated the stream (MEASURED-1).
    NoTerminationSentinel,
    /// Usage was requested and never sent (MEASURED-1, `small-local`).
    UsageNotReported,
    /// At least one tool call could not be reconstructed (MEASURED-4).
    MalformedToolCalls { count: usize },
    /// The request was retried, or moved to another candidate, before it
    /// succeeded. Carries no provider identity by design.
    FailedOver { attempts: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContextStrategy {
    /// Oldest turns replaced by an explicit, visible elision note.
    ElideOldest,
    /// Oldest turns replaced by a caller-supplied summary.
    Summarise,
}

/// The finished turn.
///
/// Note what is *not* here: no raw body, no HTTP status, no provider id, no
/// wire-format remnants. This is everything the app layer is allowed to know.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatResponse {
    /// Answer and reasoning, in order, as content parts.
    pub parts: Vec<ContentPart>,
    pub tool_calls: Vec<ToolCallOutcome>,
    pub stop_reason: StopReason,
    pub usage: TokenUsage,
    /// Present only when the request asked for structured output.
    ///
    /// It is a `Result` on purpose: MEASURED-5 says a non-conforming answer
    /// arrives as a 200 with no indication anything is wrong, so the only way
    /// to make the failure impossible to ignore is to make the caller destructure
    /// it before it can reach the JSON.
    pub structured: Option<Result<serde_json::Value, SchemaMismatch>>,
    pub degradations: Vec<Degradation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaMismatch {
    /// JSON-Pointer-ish path to the first offending value, `""` for the root.
    pub path: String,
    pub detail: String,
}

impl ChatResponse {
    pub fn empty() -> Self {
        Self {
            parts: Vec::new(),
            tool_calls: Vec::new(),
            stop_reason: StopReason::Unspecified,
            usage: TokenUsage::default(),
            structured: None,
            degradations: Vec::new(),
        }
    }

    pub fn answer_text(&self) -> String {
        self.parts
            .iter()
            .filter_map(|part| match part {
                ContentPart::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    pub fn reasoning_text(&self) -> String {
        self.parts
            .iter()
            .filter_map(|part| match part {
                ContentPart::Reasoning { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    pub fn has_degradation(&self, matches: impl Fn(&Degradation) -> bool) -> bool {
        self.degradations.iter().any(matches)
    }

    /// The tool calls that are safe to execute. Malformed ones are excluded
    /// here and reported separately, so "run the calls" can never accidentally
    /// run a reconstruction.
    pub fn executable_tool_calls(&self) -> impl Iterator<Item = &ToolCallOutcome> {
        self.tool_calls.iter().filter(|call| call.is_ok())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasoning_is_never_part_of_the_answer_or_of_tool_parsing() {
        let message = ChatMessage::new(
            MessageRole::Assistant,
            vec![
                ContentPart::reasoning("I should call get_weather(\"berlin\")"),
                ContentPart::text("It is sunny."),
            ],
        );
        assert_eq!(message.answer_text(), "It is sunny.");
        assert_eq!(message.tool_parse_text(), "It is sunny.");
        assert_eq!(
            message.reasoning_text().unwrap(),
            "I should call get_weather(\"berlin\")"
        );
    }

    #[test]
    fn a_tool_choice_of_none_means_no_catalogue_is_offered() {
        let request = ChatRequest::new("m")
            .with_tools([ToolDefinition::new("t", "d", serde_json::json!({}))])
            .with_tool_choice(ToolChoice::None);
        assert!(
            !request.offers_tools(),
            "FINDING 6: sending tools with tool_choice=none is a 400 on some endpoints"
        );
        assert!(ChatRequest::new("m")
            .with_tools([ToolDefinition::new("t", "d", serde_json::json!({}))])
            .offers_tools());
    }

    #[test]
    fn vision_need_is_derived_from_the_messages_not_declared_by_the_caller() {
        let request = ChatRequest::new("m").with_message(ChatMessage::new(
            MessageRole::User,
            vec![ContentPart::Image {
                mime_type: "image/png".into(),
                data: vec![1, 2, 3],
            }],
        ));
        assert!(request.needs_vision());
        assert!(!ChatRequest::new("m").needs_vision());
    }

    #[test]
    fn structured_output_cannot_be_read_without_handling_the_mismatch_case() {
        let mut response = ChatResponse::empty();
        response.structured = Some(Err(SchemaMismatch {
            path: "/city".into(),
            detail: "expected string".into(),
        }));
        // The only way to the value is through the Result. This test exists to
        // fail loudly if `structured` is ever softened to an Option<Value>.
        match response.structured.as_ref().expect("requested") {
            Ok(value) => panic!("must not be readable as a value: {value}"),
            Err(mismatch) => assert_eq!(mismatch.path, "/city"),
        }
    }

    #[test]
    fn malformed_tool_calls_are_excluded_from_the_executable_set() {
        let mut response = ChatResponse::empty();
        response.tool_calls = vec![
            ToolCallOutcome::Ok {
                call_id: "call_1".into(),
                name: "get_weather".into(),
                arguments: serde_json::json!({"city": "berlin"}),
                emulated: false,
            },
            ToolCallOutcome::Malformed {
                index: Some(7),
                call_id: None,
                name: Some("get_weather".into()),
                raw_arguments: "not-json-at-all".into(),
                reason: MalformedToolCall::UnparseableArguments,
            },
        ];
        assert_eq!(response.executable_tool_calls().count(), 1);
        assert_eq!(response.tool_calls.len(), 2, "the bad one is still reported");
    }

    #[test]
    fn content_parts_serialise_with_the_stores_tags() {
        let json = serde_json::to_value(ContentPart::ToolCall {
            call_id: "c1".into(),
            name: "t".into(),
            arguments: serde_json::json!({}),
        })
        .unwrap();
        assert_eq!(json["kind"], "toolCall");
        assert_eq!(json["callId"], "c1");
    }
}
