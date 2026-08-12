//! # vela-providers — the provider core
//!
//! Every backend Vela can use — llama.cpp, Ollama, LM Studio, vLLM, a hosted
//! API, a subscription endpoint — reaches the rest of the application through
//! this crate and through nothing else. Above it, no code knows what an SSE
//! frame is, what `finish_reason` means, or which vendor is answering.
//!
//! ## The map
//!
//! | Module | What it owns |
//! |---|---|
//! | [`model`] | The **one** internal request/response model: messages, typed content parts, tools, cache hints, reasoning settings, vision, max context |
//! | [`error`] | The **one** error taxonomy, and the retry/failover rules derived from it |
//! | [`event`] | The normalised event stream: `TextDelta` / `ReasoningDelta` / `ToolCallDelta` / `Usage` / `Done` / `Error` |
//! | [`provider`] | The [`Provider`] trait, cancellation, timeouts |
//! | [`capability`] | Probed capabilities, and the flag set the UI branches on |
//! | [`sse`] · [`stream`] | Tolerant SSE decoding and stream normalisation |
//! | [`reasoning`] | Separating `<think>` blocks and `reasoning_content` from the answer |
//! | [`tool_accum`] | Defensive tool-call accumulation |
//! | [`emulation`] | Tool calling for models that have none |
//! | [`context`] | Fitting a conversation into a short window, visibly |
//! | [`structured`] | Validating structured output that an endpoint may have ignored |
//! | [`router`] | Ordered candidates, bounded retries, honest failover |
//! | [`http`] | The HTTP seam — the only place in Vela that opens a socket |
//! | [`openai_compatible`] | The OpenAI-shaped backend all four matrix profiles speak |
//! | [`compat`] | The adapter over it: server discovery, the four `/v1/models` shapes, the four error dialects |
//!
//! ## The evidence this crate is written against
//!
//! `docs/regression-baseline/mock-matrix/` records what four deliberately
//! broken endpoints actually did, measured over real TCP. The requirements
//! referenced throughout this crate as **MEASURED-n** are:
//!
//! 1. **End-of-body is the only reliable stream terminator.** `[DONE]` may
//!    never come; a requested usage frame may never come. Both were recorded
//!    hanging a naive consumer for 5 seconds. Every read also carries a stall
//!    timeout.
//! 2. **Malformed frames are skipped, never fatal.** A consumer that
//!    `JSON.parse`d every frame lost 318 of 349 characters.
//! 3. **Reasoning markup splits across frames.** No single frame contained
//!    `</think>`; a per-frame stripper leaks. And an unterminated block must
//!    not swallow the answer.
//! 4. **Tool-call deltas are lossy if keyed naively by `index`.** Names arrive
//!    with no index; indices jump; discriminators are misspelled.
//! 5. **Structured output is silently ignored by three of four profiles** —
//!    200 OK, prose, no indication. The most dangerous degradation there is.
//! 6. **No CORS, `OPTIONS` → 405.** All provider HTTP originates in the Rust
//!    core.
//!
//! Everything in this crate that has been exercised has been exercised against
//! mocks. Per `docs/architecture/conventions.md` §10 that makes every result
//! **VERIFIED-BY-FAKE**: it says what the code does when an endpoint behaves
//! like the recorded transcripts, and nothing about a real model.
//!
//! ## Implementing a backend
//!
//! ```ignore
//! use std::sync::Arc;
//! use vela_providers::{ChatRequest, ChatMessage, Provider, RequestContext};
//! use vela_providers::openai_compatible::OpenAiCompatibleProvider;
//!
//! let provider = OpenAiCompatibleProvider::new(
//!     descriptor,                 // vela_core::provider::ProviderDescriptor
//!     "http://127.0.0.1:8033/v1", // the user's endpoint
//!     auth,                       // vela_core::credential::Auth — `None` is first-class
//!     secrets,                    // Arc<dyn vela_secrets::SecretStore>
//!     transport,                  // Arc<dyn HttpTransport>
//! );
//!
//! let capabilities = provider.probe_capabilities("my-model", &RequestContext::new()).await?;
//! let ui_flags = capabilities.to_descriptor();   // what the renderer is allowed to see
//!
//! let request = ChatRequest::new("my-model").with_message(ChatMessage::user("hello"));
//! let response = provider.stream(request, &mut sink, &RequestContext::new()).await?;
//! ```
//!
//! Five rules for anyone adding one:
//!
//! 1. One module per backend under `src/`.
//! 2. Start at [`ModelCapabilities::unknown`](capability::ModelCapabilities::unknown);
//!    raise a flag only on probe evidence.
//! 3. Return only [`ProviderError`]s. No HTTP status, no vendor error, ever
//!    escapes.
//! 4. Never touch the OS keychain: take a `&dyn SecretStore` and go through
//!    `vela_secrets::resolve_auth`, which guarantees `Auth::None` sends **no**
//!    `Authorization` header rather than an empty one.
//! 5. Export nothing backend-specific. If the UI needs to know something, it
//!    becomes a capability flag.

pub mod anthropic;
pub mod capability;
pub mod compat;
pub mod context;
pub mod emulation;
pub mod error;
pub mod event;
pub mod http;
pub mod lenient_json;
pub mod model;
pub mod openai_compatible;
pub mod provider;
pub mod reasoning;
pub mod router;
pub mod sse;
pub mod stream;
pub mod structured;
mod textscan;
pub mod tool_accum;

use std::collections::BTreeMap;
use std::sync::Arc;

pub use capability::{CapabilityFinding, Evidence, ModelCapabilities, Support};
pub use error::{Capability, ProviderError, ProviderResult, TransportFailure};
pub use event::{EventSink, StreamEvent, ToolCallDelta};
pub use http::{HttpTransport, ReqwestTransport};
pub use model::{
    CacheHints, ChatMessage, ChatRequest, ChatResponse, ContentPart, ContextStrategy, Degradation,
    MalformedToolCall, MessageRole, ReasoningRequest, ResponseFormat, Sampling, SchemaMismatch,
    StopReason, TokenUsage, ToolCallOutcome, ToolChoice, ToolDefinition,
};
pub use openai_compatible::{OpenAiCompatibleProvider, ProviderOptions};
pub use provider::{CancelToken, ModelInfo, Provider, RequestContext, Timeouts};
pub use router::{Candidate, RetryPolicy, Router};
pub use structured::StructuredOutputPolicy;

use vela_core::provider::ProviderDescriptor;

/// Ordered registry of configured providers. `BTreeMap` so enumeration order is
/// deterministic, which keeps UI lists and snapshot tests stable.
#[derive(Default, Clone)]
pub struct ProviderRegistry {
    providers: BTreeMap<String, Arc<dyn Provider>>,
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, provider: Arc<dyn Provider>) {
        self.providers
            .insert(provider.descriptor().id.clone(), provider);
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn Provider>> {
        self.providers.get(id).cloned()
    }

    /// The descriptor list handed to the renderer. Note it returns descriptors,
    /// never providers — the renderer cannot reach provider internals.
    pub fn descriptors(&self) -> Vec<ProviderDescriptor> {
        self.providers
            .values()
            .map(|provider| provider.descriptor().clone())
            .collect()
    }

    /// Build a router over the named providers, in the order given. Unknown ids
    /// are skipped rather than erroring: a candidate list is a preference, and
    /// a provider the user deleted must not break the ones they kept.
    pub fn route(&self, candidates: &[(String, String)]) -> Router {
        Router::new(
            candidates
                .iter()
                .filter_map(|(provider_id, model_id)| {
                    self.get(provider_id)
                        .map(|provider| Candidate::new(provider, model_id.clone()))
                })
                .collect(),
        )
    }

    pub fn len(&self) -> usize {
        self.providers.len()
    }

    pub fn is_empty(&self) -> bool {
        self.providers.is_empty()
    }
}

/// A deterministic in-process provider for tests and for the frontend's browser
/// fake. It echoes the last user message and advertises nothing.
///
/// **VERIFIED-BY-FAKE by construction**: it proves protocol shape and nothing
/// about any endpoint.
pub struct EchoProvider {
    descriptor: ProviderDescriptor,
}

impl EchoProvider {
    pub fn new(id: &str) -> Self {
        use vela_core::provider::{ProviderCapabilities, ProviderKind};
        Self {
            descriptor: ProviderDescriptor::new(id, "Echo (test)", ProviderKind::Local)
                .expect("static id is valid")
                .with_capabilities(ProviderCapabilities::minimal()),
        }
    }
}

#[async_trait::async_trait]
impl Provider for EchoProvider {
    fn descriptor(&self) -> &ProviderDescriptor {
        &self.descriptor
    }

    async fn list_models(&self, _context: &RequestContext) -> ProviderResult<Vec<ModelInfo>> {
        // Not an error state: the UI offers free-text model entry instead.
        Err(ProviderError::unsupported(
            Capability::ModelListing,
            "this provider cannot enumerate models",
        ))
    }

    async fn probe_capabilities(
        &self,
        model_id: &str,
        _context: &RequestContext,
    ) -> ProviderResult<ModelCapabilities> {
        Ok(ModelCapabilities::unknown(model_id))
    }

    async fn stream(
        &self,
        request: ChatRequest,
        sink: &mut dyn EventSink,
        _context: &RequestContext,
    ) -> ProviderResult<ChatResponse> {
        let text = request
            .messages
            .iter()
            .rev()
            .find(|message| message.role == MessageRole::User)
            .map(ChatMessage::answer_text)
            .unwrap_or_default();

        let mut response = ChatResponse::empty();
        response.parts = vec![ContentPart::text(text.clone())];
        response.stop_reason = StopReason::EndTurn;
        sink.emit(StreamEvent::TextDelta { text });
        sink.emit(StreamEvent::Done {
            response: Box::new(response.clone()),
        });
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use event::CollectingSink;

    #[tokio::test]
    async fn a_non_streaming_provider_is_indistinguishable_from_a_streaming_one() {
        let provider = EchoProvider::new("echo");
        let mut sink = CollectingSink::new();
        let response = provider
            .stream(
                ChatRequest::new("any").with_message(ChatMessage::user("hello")),
                &mut sink,
                &RequestContext::new(),
            )
            .await
            .unwrap();
        assert_eq!(sink.text(), "hello");
        assert_eq!(response.answer_text(), "hello");
        assert!(matches!(sink.events.last(), Some(StreamEvent::Done { .. })));
    }

    #[tokio::test]
    async fn missing_model_listing_is_unsupported_not_a_failure() {
        let provider = EchoProvider::new("echo");
        assert!(!provider.descriptor().capabilities.model_listing);
        assert!(matches!(
            provider.list_models(&RequestContext::new()).await,
            Err(ProviderError::CapabilityUnsupported {
                capability: Capability::ModelListing,
                ..
            })
        ));
    }

    #[test]
    fn the_registry_exposes_descriptors_only_and_is_deterministic() {
        let mut registry = ProviderRegistry::new();
        registry.register(Arc::new(EchoProvider::new("zeta")));
        registry.register(Arc::new(EchoProvider::new("alpha")));
        let ids: Vec<String> = registry.descriptors().into_iter().map(|d| d.id).collect();
        assert_eq!(ids, vec!["alpha".to_string(), "zeta".to_string()]);
        assert!(registry.get("missing").is_none());
    }

    #[test]
    fn routing_skips_candidates_that_no_longer_exist() {
        let mut registry = ProviderRegistry::new();
        registry.register(Arc::new(EchoProvider::new("alpha")));
        let router =
            registry.route(&[("deleted".into(), "m".into()), ("alpha".into(), "m".into())]);
        assert!(
            !router.is_empty(),
            "a deleted provider must not break the rest"
        );
    }
}
