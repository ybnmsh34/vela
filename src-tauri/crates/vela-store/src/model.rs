//! The persisted domain model.
//!
//! # Why the message model looks like this
//!
//! Everything downstream depends on it, so it is designed for what is coming,
//! not for what Phase A renders:
//!
//! * A message is **not** a string. It is an ordered list of
//!   [`ContentPart`]s, because a single assistant turn routinely contains
//!   reasoning, then a tool call, then a tool result, then prose.
//! * **Reasoning is its own part kind**, never merged into the answer text.
//!   Many models emit `<think>` blocks; those must be storable, retrievable and
//!   *separable* from the final answer — [`Message::answer_text`] can never
//!   return reasoning, and [`Message::reasoning_text`] can never return the
//!   answer. Reasoning may also arrive redacted or signed, so the part carries
//!   `signature` and `redacted` rather than forcing a lossy round-trip.
//! * **Token counts are `Option`.** `None` means "the endpoint did not report
//!   it". Storing a guessed zero would silently corrupt usage accounting for
//!   every local runtime that reports nothing.
//! * **`provider_id` / `model_id` are recorded per message**, not only per
//!   conversation, because Vela is model-agnostic by design: switching model
//!   mid-conversation is a normal thing to do and the transcript must remain
//!   truthful about which model said what.

use serde::{Deserialize, Serialize};

use crate::error::{StoreError, StoreResult};

/// Milliseconds since the Unix epoch, UTC. Stored as an SQLite `INTEGER`, which
/// sorts correctly and is timezone-free.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Timestamp(i64);

impl Timestamp {
    pub const fn from_millis(millis: i64) -> Self {
        Self(millis)
    }

    pub const fn as_millis(self) -> i64 {
        self.0
    }
}

macro_rules! id_newtype {
    ($(#[$meta:meta])* $name:ident, $prefix:literal, $entity:literal) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// The prefix generated ids carry, e.g. `conv`.
            pub const PREFIX: &'static str = $prefix;
            /// Stable tag used in [`StoreError::NotFound`].
            pub const ENTITY: &'static str = $entity;

            pub fn new(value: impl Into<String>) -> StoreResult<Self> {
                let value = value.into();
                if value.trim().is_empty() {
                    return Err(StoreError::invalid(
                        concat!($entity, "Id"),
                        "must not be blank",
                    ));
                }
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn into_string(self) -> String {
                self.0
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

id_newtype!(
    /// Identifier of a [`Project`].
    ProjectId, "proj", "project"
);
id_newtype!(
    /// Identifier of a [`Conversation`].
    ConversationId, "conv", "conversation"
);
id_newtype!(
    /// Identifier of a [`Message`].
    MessageId, "msg", "message"
);

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/// Who produced a message. `Tool` is a first-class author because tool results
/// are transcript entries in their own right for several backends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MessageRole {
    System,
    User,
    Assistant,
    Tool,
}

impl MessageRole {
    pub(crate) const fn as_db(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::Tool => "tool",
        }
    }

    pub(crate) fn from_db(value: &str) -> StoreResult<Self> {
        Ok(match value {
            "system" => Self::System,
            "user" => Self::User,
            "assistant" => Self::Assistant,
            "tool" => Self::Tool,
            other => {
                return Err(StoreError::corrupt(format!(
                    "unknown message role `{other}`"
                )))
            }
        })
    }
}

/// Lifecycle of a message row. A streaming turn is persisted *before* it
/// completes so a crash mid-generation loses nothing but the tail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MessageStatus {
    /// Still being generated. Parts may still change.
    Streaming,
    /// Finished normally.
    Complete,
    /// The user stopped generation. Whatever arrived is kept.
    Cancelled,
    /// Generation failed; `error_message` explains why.
    Failed,
}

impl MessageStatus {
    pub(crate) const fn as_db(self) -> &'static str {
        match self {
            Self::Streaming => "streaming",
            Self::Complete => "complete",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }

    pub(crate) fn from_db(value: &str) -> StoreResult<Self> {
        Ok(match value {
            "streaming" => Self::Streaming,
            "complete" => Self::Complete,
            "cancelled" => Self::Cancelled,
            "failed" => Self::Failed,
            other => {
                return Err(StoreError::corrupt(format!(
                    "unknown message status `{other}`"
                )))
            }
        })
    }
}

/// Why generation stopped.
///
/// Mirrors `vela_providers::StopReason` on purpose: the system of record must
/// not depend on the provider seam, or persistence would break every time the
/// provider layer changes shape. The mapping between the two lives at the call
/// site that owns both.
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

impl StopReason {
    pub(crate) const fn as_db(self) -> &'static str {
        match self {
            Self::EndTurn => "end_turn",
            Self::MaxTokens => "max_tokens",
            Self::Cancelled => "cancelled",
            Self::ToolUse => "tool_use",
            Self::Unspecified => "unspecified",
        }
    }

    pub(crate) fn from_db(value: &str) -> StoreResult<Self> {
        Ok(match value {
            "end_turn" => Self::EndTurn,
            "max_tokens" => Self::MaxTokens,
            "cancelled" => Self::Cancelled,
            "tool_use" => Self::ToolUse,
            "unspecified" => Self::Unspecified,
            other => {
                return Err(StoreError::corrupt(format!(
                    "unknown stop reason `{other}`"
                )))
            }
        })
    }
}

/// Token accounting for one message.
///
/// Every field is optional and `None` means **"not reported"**, which is the
/// normal case for most local runtimes. Never substitute `0`: a zero is a
/// claim, an absence is the truth.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
    /// Reasoning/thinking tokens billed separately by some backends.
    pub reasoning_tokens: Option<u32>,
    /// Input tokens served from a prompt cache.
    pub cached_input_tokens: Option<u32>,
}

impl TokenUsage {
    pub fn is_unreported(&self) -> bool {
        self == &Self::default()
    }
}

/// One piece of a message's content.
///
/// Tagged with `kind` on the wire so the renderer can switch exhaustively, and
/// stored one row per part so that ordering, streaming appends and
/// reasoning-only queries are all cheap.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
// `rename_all` renames the variants; `rename_all_fields` renames the fields
// *inside* them. Both are needed, or `call_id` reaches the renderer as
// `call_id` while every other wire field is camelCase.
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ContentPart {
    /// Ordinary output. This — and only this — is the model's answer.
    Text { text: String },

    /// A `<think>` / reasoning block. Stored separately from the answer so the
    /// UI can collapse it, so it can be excluded from what is re-sent to the
    /// model, and so it can be exported or discarded on its own.
    Reasoning {
        text: String,
        /// Some backends sign reasoning blocks and require the signature back
        /// verbatim on the next turn. Round-tripping it is not optional.
        signature: Option<String>,
        /// The backend returned the block redacted (encrypted / withheld). The
        /// text is then a placeholder, not the model's thoughts.
        redacted: bool,
    },

    /// Inline image bytes. Stored as a BLOB: Vela is offline-first, so an image
    /// referenced by URL would be a dangling pointer the moment the user goes
    /// offline or the host deletes it.
    Image { mime_type: String, data: Vec<u8> },

    /// The model asked to run a tool.
    ToolCall {
        /// Correlates with the matching [`ContentPart::ToolResult`].
        call_id: String,
        name: String,
        /// Arguments exactly as the model produced them.
        arguments: serde_json::Value,
    },

    /// The outcome of a tool call.
    ToolResult {
        call_id: String,
        /// The tool's output, rendered as text. Structured output is stored as
        /// its JSON encoding so the column type stays uniform.
        content: String,
        /// The tool failed. Kept as data, not as an error: a failed tool call
        /// is part of the transcript and is usually fed back to the model.
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

    /// Stable discriminant, matching the `kind` column.
    pub(crate) const fn kind_db(&self) -> &'static str {
        match self {
            Self::Text { .. } => "text",
            Self::Reasoning { .. } => "reasoning",
            Self::Image { .. } => "image",
            Self::ToolCall { .. } => "tool_call",
            Self::ToolResult { .. } => "tool_result",
        }
    }

    pub fn is_reasoning(&self) -> bool {
        matches!(self, Self::Reasoning { .. })
    }

    fn validate(&self, index: usize) -> StoreResult<()> {
        let blank = |what: &str| {
            Err(StoreError::invalid(
                format!("parts[{index}].{what}"),
                "must not be blank",
            ))
        };
        match self {
            // An empty text part is allowed: a streaming turn legitimately
            // starts as an empty buffer that is filled in later.
            Self::Text { .. } => Ok(()),
            Self::Reasoning { .. } => Ok(()),
            Self::Image { mime_type, data } => {
                if mime_type.trim().is_empty() {
                    return blank("mimeType");
                }
                if data.is_empty() {
                    return Err(StoreError::invalid(
                        format!("parts[{index}].data"),
                        "image part must carry bytes",
                    ));
                }
                Ok(())
            }
            Self::ToolCall { call_id, name, .. } => {
                if call_id.trim().is_empty() {
                    return blank("callId");
                }
                if name.trim().is_empty() {
                    return blank("name");
                }
                Ok(())
            }
            Self::ToolResult { call_id, .. } => {
                if call_id.trim().is_empty() {
                    return blank("callId");
                }
                Ok(())
            }
        }
    }
}

/// A persisted message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: MessageId,
    pub conversation_id: ConversationId,
    /// Position within the conversation, assigned by the store. Gapless and
    /// strictly increasing; the `(conversation_id, seq)` pair is unique.
    pub seq: i64,
    pub role: MessageRole,
    pub status: MessageStatus,
    /// Ordered. Reasoning keeps its position relative to the text it preceded.
    pub parts: Vec<ContentPart>,
    /// Which backend produced this turn — `None` for user/system messages.
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub usage: TokenUsage,
    pub stop_reason: Option<StopReason>,
    pub error_message: Option<String>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Message {
    /// The model's answer. **Never includes reasoning** — that separation is
    /// the whole point of the part model, and a test enforces it.
    pub fn answer_text(&self) -> String {
        self.parts
            .iter()
            .filter_map(|part| match part {
                ContentPart::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("")
    }

    /// The reasoning the model emitted, or `None` if it emitted none.
    pub fn reasoning_text(&self) -> Option<String> {
        let joined = self
            .parts
            .iter()
            .filter_map(|part| match part {
                ContentPart::Reasoning { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        if joined.is_empty() {
            None
        } else {
            Some(joined.join("\n"))
        }
    }

    pub fn has_reasoning(&self) -> bool {
        self.parts.iter().any(ContentPart::is_reasoning)
    }

    /// Tool calls in this turn, in order.
    pub fn tool_calls(&self) -> Vec<&ContentPart> {
        self.parts
            .iter()
            .filter(|p| matches!(p, ContentPart::ToolCall { .. }))
            .collect()
    }
}

/// Input for appending a message. `seq`, `id` and the timestamps are the
/// store's business, not the caller's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewMessage {
    pub conversation_id: ConversationId,
    pub role: MessageRole,
    pub status: MessageStatus,
    pub parts: Vec<ContentPart>,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub usage: TokenUsage,
    pub stop_reason: Option<StopReason>,
    pub error_message: Option<String>,
}

impl NewMessage {
    pub fn new(conversation_id: ConversationId, role: MessageRole) -> Self {
        Self {
            conversation_id,
            role,
            status: MessageStatus::Complete,
            parts: Vec::new(),
            provider_id: None,
            model_id: None,
            usage: TokenUsage::default(),
            stop_reason: None,
            error_message: None,
        }
    }

    pub fn user(conversation_id: ConversationId, text: impl Into<String>) -> Self {
        Self::new(conversation_id, MessageRole::User).with_parts(vec![ContentPart::text(text)])
    }

    pub fn assistant(conversation_id: ConversationId, parts: Vec<ContentPart>) -> Self {
        Self::new(conversation_id, MessageRole::Assistant).with_parts(parts)
    }

    pub fn with_parts(mut self, parts: Vec<ContentPart>) -> Self {
        self.parts = parts;
        self
    }

    pub fn with_status(mut self, status: MessageStatus) -> Self {
        self.status = status;
        self
    }

    pub fn with_model(
        mut self,
        provider_id: impl Into<String>,
        model_id: impl Into<String>,
    ) -> Self {
        self.provider_id = Some(provider_id.into());
        self.model_id = Some(model_id.into());
        self
    }

    pub fn with_usage(mut self, usage: TokenUsage) -> Self {
        self.usage = usage;
        self
    }

    pub fn with_stop_reason(mut self, reason: StopReason) -> Self {
        self.stop_reason = Some(reason);
        self
    }

    pub(crate) fn validate(&self) -> StoreResult<()> {
        if self.parts.is_empty() {
            return Err(StoreError::invalid(
                "parts",
                "a message must have at least one content part",
            ));
        }
        for (index, part) in self.parts.iter().enumerate() {
            part.validate(index)?;
        }
        if let Some(provider_id) = &self.provider_id {
            if provider_id.trim().is_empty() {
                return Err(StoreError::invalid("providerId", "must not be blank"));
            }
        }
        if let Some(model_id) = &self.model_id {
            if model_id.trim().is_empty() {
                return Err(StoreError::invalid("modelId", "must not be blank"));
            }
        }
        Ok(())
    }
}

/// Partial update of a message. `None` means "leave alone".
///
/// This is what turns a streamed turn into a finished one: the parts are
/// replaced wholesale with the final list, the status moves off `Streaming`,
/// and the usage numbers the endpoint reported at the end are recorded.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MessagePatch {
    pub parts: Option<Vec<ContentPart>>,
    pub status: Option<MessageStatus>,
    pub usage: Option<TokenUsage>,
    /// `Some(None)` clears the stop reason; `None` leaves it untouched.
    pub stop_reason: Option<Option<StopReason>>,
    /// `Some(None)` clears the error; `None` leaves it untouched.
    pub error_message: Option<Option<String>>,
}

impl MessagePatch {
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }

    pub(crate) fn validate(&self) -> StoreResult<()> {
        if let Some(parts) = &self.parts {
            if parts.is_empty() {
                return Err(StoreError::invalid(
                    "parts",
                    "a message must keep at least one content part",
                ));
            }
            for (index, part) in parts.iter().enumerate() {
                part.validate(index)?;
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: ConversationId,
    /// `None` = not filed under any project. Deleting a project unfiles its
    /// conversations rather than destroying them.
    pub project_id: Option<ProjectId>,
    pub title: String,
    /// The backend last used in this conversation. Advisory only — the
    /// authoritative record of what produced a turn is on the message.
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub last_message_at: Option<Timestamp>,
    pub archived_at: Option<Timestamp>,
    pub message_count: i64,
}

impl Conversation {
    pub fn is_archived(&self) -> bool {
        self.archived_at.is_some()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NewConversation {
    pub title: String,
    pub project_id: Option<ProjectId>,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
}

impl NewConversation {
    pub fn titled(title: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            ..Self::default()
        }
    }

    pub fn in_project(mut self, project_id: ProjectId) -> Self {
        self.project_id = Some(project_id);
        self
    }

    pub fn with_model(
        mut self,
        provider_id: impl Into<String>,
        model_id: impl Into<String>,
    ) -> Self {
        self.provider_id = Some(provider_id.into());
        self.model_id = Some(model_id.into());
        self
    }
}

/// Partial update. `None` leaves a field alone; a nested `Some(None)` clears it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConversationPatch {
    pub title: Option<String>,
    pub project_id: Option<Option<ProjectId>>,
    pub provider_id: Option<Option<String>>,
    pub model_id: Option<Option<String>>,
    /// `Some(true)` archives, `Some(false)` restores.
    pub archived: Option<bool>,
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: ProjectId,
    pub name: String,
    pub description: Option<String>,
    /// Instructions applied to every conversation in the project.
    pub system_prompt: Option<String>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub archived_at: Option<Timestamp>,
    pub conversation_count: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NewProject {
    pub name: String,
    pub description: Option<String>,
    pub system_prompt: Option<String>,
}

impl NewProject {
    pub fn named(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            ..Self::default()
        }
    }

    pub(crate) fn validate(&self) -> StoreResult<()> {
        if self.name.trim().is_empty() {
            return Err(StoreError::invalid("name", "a project must have a name"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProjectPatch {
    pub name: Option<String>,
    pub description: Option<Option<String>>,
    pub system_prompt: Option<Option<String>>,
    pub archived: Option<bool>,
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/// A configuration row.
///
/// # The rule this type exists to enforce
///
/// **Credentials never live here.** A setting may *point at* a keychain entry
/// by name — `secret_ref` holds `<providerId>/<field>`, which is a lookup key,
/// not a secret — and the value itself stays in the OS keychain, reachable only
/// by the Rust core. There is no column that can hold a credential, and a test
/// scans the migration SQL to keep it that way.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Setting {
    /// Dotted, namespaced key: `appearance.theme`, `provider.ollama.endpoint`.
    pub key: String,
    /// Arbitrary JSON. Non-secret by construction.
    pub value: serde_json::Value,
    /// Name of the keychain entry this setting refers to, if any.
    pub secret_ref: Option<SecretRefName>,
    pub updated_at: Timestamp,
}

/// The *name* of a keychain entry — never its value.
///
/// Wraps the same `<providerId>/<field>` string that
/// `vela_core::secret::SecretRef::storage_key` produces, so the two layers
/// agree on how a credential is addressed without the store depending on how
/// credentials are *stored*.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SecretRefName(String);

impl SecretRefName {
    pub fn new(name: impl Into<String>) -> StoreResult<Self> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(StoreError::invalid("secretRef", "must not be blank"));
        }
        if !name.contains('/') {
            return Err(StoreError::invalid(
                "secretRef",
                "must be a keychain entry name of the form `<providerId>/<field>`",
            ));
        }
        Ok(Self(name))
    }

    /// Build from a `vela-core` secret reference, which is the only thing that
    /// knows the canonical key format.
    pub fn from_secret_ref(reference: &vela_core::secret::SecretRef) -> Self {
        Self(reference.storage_key())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for SecretRefName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Input for writing a setting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingEntry {
    pub key: String,
    pub value: serde_json::Value,
    pub secret_ref: Option<SecretRefName>,
}

impl SettingEntry {
    pub fn new(key: impl Into<String>, value: serde_json::Value) -> Self {
        Self {
            key: key.into(),
            value,
            secret_ref: None,
        }
    }

    /// Attach the *name* of the keychain entry that holds this setting's
    /// credential. The credential itself is never passed to the store.
    pub fn referencing_secret(mut self, name: SecretRefName) -> Self {
        self.secret_ref = Some(name);
        self
    }

    pub(crate) fn validate(&self) -> StoreResult<()> {
        if self.key.trim().is_empty() {
            return Err(StoreError::invalid("key", "must not be blank"));
        }
        if self.key.len() > 256 {
            return Err(StoreError::invalid("key", "must be at most 256 characters"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message_with(parts: Vec<ContentPart>) -> Message {
        Message {
            id: MessageId::new("msg_1").unwrap(),
            conversation_id: ConversationId::new("conv_1").unwrap(),
            seq: 0,
            role: MessageRole::Assistant,
            status: MessageStatus::Complete,
            parts,
            provider_id: None,
            model_id: None,
            usage: TokenUsage::default(),
            stop_reason: None,
            error_message: None,
            created_at: Timestamp::from_millis(1),
            updated_at: Timestamp::from_millis(1),
        }
    }

    #[test]
    fn the_answer_text_never_contains_reasoning() {
        let message = message_with(vec![
            ContentPart::reasoning("the user probably means Vega, not Vela"),
            ContentPart::text("Vela is a southern constellation."),
        ]);

        assert_eq!(message.answer_text(), "Vela is a southern constellation.");
        assert!(!message.answer_text().contains("probably"));
        assert_eq!(
            message.reasoning_text().unwrap(),
            "the user probably means Vega, not Vela"
        );
    }

    #[test]
    fn a_message_without_reasoning_reports_none_rather_than_an_empty_string() {
        let message = message_with(vec![ContentPart::text("hi")]);
        assert_eq!(message.reasoning_text(), None);
        assert!(!message.has_reasoning());
    }

    #[test]
    fn unreported_token_counts_stay_absent_instead_of_becoming_zero() {
        let usage = TokenUsage::default();
        assert!(usage.is_unreported());
        assert_eq!(usage.input_tokens, None);

        let reported = TokenUsage {
            input_tokens: Some(0),
            ..TokenUsage::default()
        };
        assert!(
            !reported.is_unreported(),
            "an explicit zero is a report, not an absence"
        );
    }

    #[test]
    fn a_message_must_carry_content() {
        let conversation = ConversationId::new("conv_1").unwrap();
        let empty = NewMessage::new(conversation.clone(), MessageRole::User);
        assert!(matches!(empty.validate(), Err(StoreError::Invalid { .. })));

        let ok = NewMessage::user(conversation, "hello");
        assert!(ok.validate().is_ok());
    }

    #[test]
    fn malformed_parts_are_rejected_before_they_reach_sql() {
        let conversation = ConversationId::new("conv_1").unwrap();

        let no_bytes = NewMessage::assistant(
            conversation.clone(),
            vec![ContentPart::Image {
                mime_type: "image/png".into(),
                data: Vec::new(),
            }],
        );
        assert!(no_bytes.validate().is_err());

        let no_call_id = NewMessage::assistant(
            conversation,
            vec![ContentPart::ToolCall {
                call_id: "  ".into(),
                name: "search".into(),
                arguments: serde_json::json!({}),
            }],
        );
        assert!(no_call_id.validate().is_err());
    }

    #[test]
    fn content_parts_serialise_with_a_discriminant_the_renderer_can_switch_on() {
        let json = serde_json::to_value(ContentPart::reasoning("think")).unwrap();
        assert_eq!(json["kind"], "reasoning");
        assert_eq!(json["text"], "think");
        assert_eq!(json["redacted"], false);

        let call = serde_json::to_value(ContentPart::ToolCall {
            call_id: "c1".into(),
            name: "search".into(),
            arguments: serde_json::json!({ "q": "vela" }),
        })
        .unwrap();
        assert_eq!(call["kind"], "toolCall");
        assert_eq!(call["callId"], "c1");
    }

    #[test]
    fn a_secret_reference_is_a_name_and_carries_no_value() {
        let reference = vela_core::secret::SecretRef::primary("ollama").unwrap();
        let name = SecretRefName::from_secret_ref(&reference);
        assert_eq!(name.as_str(), "ollama/primary");

        assert!(SecretRefName::new("").is_err());
        assert!(
            SecretRefName::new("sk-live-abc123").is_err(),
            "a bare token is not a keychain entry name and must be refused"
        );
    }

    #[test]
    fn blank_identifiers_are_rejected() {
        assert!(ConversationId::new("   ").is_err());
        assert!(MessageId::new("").is_err());
        assert!(ProjectId::new("p").is_ok());
    }
}
