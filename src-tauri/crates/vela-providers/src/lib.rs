//! # vela-providers
//!
//! The model-provider seam. **Every** backend — llama.cpp, Ollama, LM Studio,
//! vLLM, a hosted API, a subscription endpoint — implements [`ModelProvider`]
//! and nothing else in Vela knows the difference.
//!
//! ## Rules for anyone adding a provider
//!
//! 1. One module per provider under `src/`, e.g. `src/openai_compatible.rs`.
//! 2. The provider declares its own [`ProviderDescriptor`] including its
//!    [`AuthPolicy`](vela_core::auth::AuthPolicy). If the endpoint has no auth,
//!    say so with `AuthPolicy::none()` — that is a supported state, not a gap.
//! 3. Capabilities start at [`ProviderCapabilities::minimal`] and are raised
//!    only by evidence (a successful probe), never by assumption.
//! 4. Nothing provider-specific may be exported past this crate. If the UI
//!    needs to know something, it becomes a capability flag on the descriptor.
//! 5. Degrade, never fail: a provider that cannot stream must still answer via
//!    a single non-streaming chunk rather than erroring.

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use vela_core::provider::{ProviderCapabilities, ProviderDescriptor};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProviderError {
    #[error("cannot reach `{provider_id}`: {reason}")]
    Unreachable { provider_id: String, reason: String },
    #[error("`{provider_id}` rejected the credential")]
    Unauthorized { provider_id: String },
    #[error("`{provider_id}` returned a malformed response: {reason}")]
    Malformed { provider_id: String, reason: String },
    #[error("`{provider_id}` does not support {capability}")]
    Unsupported {
        provider_id: String,
        capability: String,
    },
    #[error("cancelled")]
    Cancelled,
}

pub type ProviderResult<T> = Result<T, ProviderError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub display_name: String,
    /// `None` when the endpoint does not report it. Never guess a number.
    pub context_window: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    System,
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub role: Role,
    pub content: String,
}

// No `Eq`: `temperature` is an `f32`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub model_id: String,
    pub messages: Vec<Message>,
    pub max_output_tokens: Option<u32>,
    pub temperature: Option<f32>,
}

/// One increment of a response. Providers that cannot stream emit exactly one
/// `Text` chunk followed by `Done` — the consumer cannot tell the difference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ChatChunk {
    Text { text: String },
    /// Separate reasoning channel, when `capabilities.reasoning` is set.
    Reasoning { text: String },
    Done { stop_reason: StopReason },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    EndTurn,
    MaxTokens,
    Cancelled,
    /// The endpoint gave no reason. Recorded honestly rather than assumed.
    Unspecified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSummary {
    pub stop_reason: StopReason,
    pub usage: Usage,
}

/// Where chunks go. Kept as a plain trait (not a `Stream`) so providers need no
/// async-runtime dependency and tests can collect into a `Vec`.
pub trait ChunkSink: Send {
    fn push(&mut self, chunk: ChatChunk) -> ProviderResult<()>;
}

impl ChunkSink for Vec<ChatChunk> {
    fn push(&mut self, chunk: ChatChunk) -> ProviderResult<()> {
        Vec::push(self, chunk);
        Ok(())
    }
}

/// The one interface every backend implements.
#[async_trait]
pub trait ModelProvider: Send + Sync {
    fn descriptor(&self) -> &ProviderDescriptor;

    /// Providers whose `capabilities.model_listing` is false return
    /// `Unsupported` — the UI then offers free-text model entry instead of a
    /// picker. Not an error state for the user.
    async fn list_models(&self) -> ProviderResult<Vec<ModelInfo>>;

    async fn complete(
        &self,
        request: ChatRequest,
        sink: &mut dyn ChunkSink,
    ) -> ProviderResult<ChatSummary>;
}

/// Ordered registry of configured providers. `BTreeMap` so enumeration order is
/// deterministic, which keeps UI lists and snapshot tests stable.
#[derive(Default, Clone)]
pub struct ProviderRegistry {
    providers: BTreeMap<String, Arc<dyn ModelProvider>>,
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, provider: Arc<dyn ModelProvider>) {
        self.providers
            .insert(provider.descriptor().id.clone(), provider);
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn ModelProvider>> {
        self.providers.get(id).cloned()
    }

    /// The descriptor list handed to the renderer. Note it returns descriptors,
    /// never providers — the renderer cannot reach provider internals.
    pub fn descriptors(&self) -> Vec<ProviderDescriptor> {
        self.providers
            .values()
            .map(|p| p.descriptor().clone())
            .collect()
    }

    pub fn len(&self) -> usize {
        self.providers.len()
    }

    pub fn is_empty(&self) -> bool {
        self.providers.is_empty()
    }
}

/// A deterministic provider used by tests and by the frontend's browser fake.
/// It echoes the last user message. It advertises the minimal capability floor,
/// which makes it a useful stand-in for "the dumbest possible endpoint".
pub struct EchoProvider {
    descriptor: ProviderDescriptor,
}

impl EchoProvider {
    pub fn new(id: &str) -> Self {
        use vela_core::provider::ProviderKind;
        Self {
            descriptor: ProviderDescriptor::new(id, "Echo (test)", ProviderKind::Local)
                .expect("static id is valid")
                .with_capabilities(ProviderCapabilities::minimal()),
        }
    }
}

#[async_trait]
impl ModelProvider for EchoProvider {
    fn descriptor(&self) -> &ProviderDescriptor {
        &self.descriptor
    }

    async fn list_models(&self) -> ProviderResult<Vec<ModelInfo>> {
        Err(ProviderError::Unsupported {
            provider_id: self.descriptor.id.clone(),
            capability: "model listing".into(),
        })
    }

    async fn complete(
        &self,
        request: ChatRequest,
        sink: &mut dyn ChunkSink,
    ) -> ProviderResult<ChatSummary> {
        let last = request
            .messages
            .iter()
            .rev()
            .find(|m| m.role == Role::User)
            .map(|m| m.content.clone())
            .unwrap_or_default();
        sink.push(ChatChunk::Text { text: last })?;
        sink.push(ChatChunk::Done {
            stop_reason: StopReason::EndTurn,
        })?;
        Ok(ChatSummary {
            stop_reason: StopReason::EndTurn,
            usage: Usage::default(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(text: &str) -> ChatRequest {
        ChatRequest {
            model_id: "any".into(),
            messages: vec![Message {
                role: Role::User,
                content: text.into(),
            }],
            max_output_tokens: None,
            temperature: None,
        }
    }

    #[tokio::test]
    async fn a_non_streaming_provider_still_emits_a_chunk_then_done() {
        let provider = EchoProvider::new("echo");
        let mut chunks: Vec<ChatChunk> = Vec::new();
        let summary = provider
            .complete(request("hello"), &mut chunks)
            .await
            .unwrap();

        assert_eq!(
            chunks,
            vec![
                ChatChunk::Text {
                    text: "hello".into()
                },
                ChatChunk::Done {
                    stop_reason: StopReason::EndTurn
                },
            ]
        );
        assert_eq!(summary.stop_reason, StopReason::EndTurn);
    }

    #[tokio::test]
    async fn missing_model_listing_is_reported_as_unsupported_not_as_a_failure() {
        let provider = EchoProvider::new("echo");
        assert!(!provider.descriptor().capabilities.model_listing);
        assert!(matches!(
            provider.list_models().await,
            Err(ProviderError::Unsupported { .. })
        ));
    }

    #[test]
    fn registry_exposes_descriptors_only_and_is_deterministic() {
        let mut registry = ProviderRegistry::new();
        registry.register(Arc::new(EchoProvider::new("zeta")));
        registry.register(Arc::new(EchoProvider::new("alpha")));

        let ids: Vec<String> = registry.descriptors().into_iter().map(|d| d.id).collect();
        assert_eq!(ids, vec!["alpha".to_string(), "zeta".to_string()]);
        assert_eq!(registry.len(), 2);
        assert!(registry.get("missing").is_none());
    }
}
