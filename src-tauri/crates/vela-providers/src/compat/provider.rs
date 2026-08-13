//! The adapter: the core backend, plus everything that differs between the
//! servers that speak to it.
//!
//! # What a turn does here that the core does not do on its own
//!
//! 1. **Discover, once.** Before the first turn (and on every explicit probe)
//!    the endpoint is interrogated for a context window and for anything it
//!    says it cannot do. A local runtime that was started with `-c 4096` is the
//!    common case, and knowing that number is the difference between a fitted
//!    conversation and a 400.
//! 2. **Delegate.** Everything about the protocol — SSE tolerance, reasoning
//!    separation, tool accumulation, emulation, structured-output validation —
//!    is the core's, unchanged. This adapter adds no second normalisation path.
//! 3. **Learn from a refusal that carries a number.** MEASURED-7 recorded a
//!    clean `400 context_length_exceeded` from all four profiles, and the
//!    canonical body names both the limit and what was requested. That is a
//!    *measurement of the window*, so it is recorded and the turn is refitted
//!    and retried — once, and only while nothing has reached the screen yet.
//!    An endpoint that reports no number teaches nothing, so nothing is retried.
//!
//! # Why the inner provider is rebuilt per turn
//!
//! [`OpenAiCompatibleProvider`] takes its capability cache at construction
//! (`with_capabilities`) and exposes it read-only afterwards
//! (`known_capabilities`). To hand it something learned *since* it was built —
//! a window measured from a refusal — it has to be rebuilt. That is a handful
//! of `Arc` clones, so it is done per turn, and whatever the inner learned on
//! its own (a `tools_not_supported` refusal, a structured-output mismatch) is
//! read back out and kept here. This adapter is the single owner of what Vela
//! believes about a model.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use vela_core::credential::Auth;
use vela_core::provider::ProviderDescriptor;
use vela_secrets::SecretStore;

use crate::capability::{Evidence, ModelCapabilities, Support};
use crate::context::{ConversationSummariser, ElisionNote};
use crate::error::{Capability, ProviderError, ProviderResult};
use crate::event::{EventSink, StreamEvent};
use crate::http::HttpTransport;
use crate::model::{ChatRequest, ChatResponse, Degradation};
use crate::openai_compatible::{OpenAiCompatibleProvider, ProviderOptions};
use crate::provider::{ModelInfo, Provider, RequestContext};
use crate::structured::StructuredOutputPolicy;

use super::discovery::{self, Endpoint, ServerFacts};
use super::error_shapes::NormalisingTransport;
use super::flavour::ServerFlavour;

/// Bound on the finding log kept per model. Findings accumulate across turns
/// (each refusal adds one); the log is a diagnostic, not a record, so the
/// oldest are dropped rather than allowed to grow without limit.
const MAX_FINDINGS: usize = 64;

/// Knobs set once, at construction.
pub struct CompatOptions {
    pub structured_output: StructuredOutputPolicy,
    /// Offer tools through the prompt when the endpoint has none. On by
    /// default: without it, most local runtimes cannot use tools at all.
    pub emulate_tools: bool,
    /// Ask for `stream_options.include_usage`. Asking is free and MEASURED-1
    /// says it is never evidence the frame will arrive.
    pub request_usage: bool,
    pub summariser: Arc<dyn ConversationSummariser>,
    /// Interrogate the endpoint before the first turn if it has not been
    /// probed. Costs at most four small GETs, once per provider instance.
    /// Turn it off for an endpoint known to be metered per request.
    pub discover_before_first_turn: bool,
    /// Refit and retry once when a refusal names the window (MEASURED-7).
    pub refit_on_context_overflow: bool,
}

impl Default for CompatOptions {
    fn default() -> Self {
        Self {
            structured_output: StructuredOutputPolicy::default(),
            emulate_tools: true,
            request_usage: true,
            summariser: Arc::new(ElisionNote),
            discover_before_first_turn: true,
            refit_on_context_overflow: true,
        }
    }
}

impl std::fmt::Debug for CompatOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CompatOptions")
            .field("structured_output", &self.structured_output)
            .field("emulate_tools", &self.emulate_tools)
            .field("request_usage", &self.request_usage)
            .field(
                "discover_before_first_turn",
                &self.discover_before_first_turn,
            )
            .field("refit_on_context_overflow", &self.refit_on_context_overflow)
            .finish_non_exhaustive()
    }
}

/// The OpenAI-compatible adapter.
pub struct CompatProvider {
    descriptor: ProviderDescriptor,
    endpoint: Endpoint,
    options: CompatOptions,
    learned: Mutex<HashMap<String, ModelCapabilities>>,
    facts: Mutex<Option<ServerFacts>>,
}

impl CompatProvider {
    /// `transport` is wrapped in a [`NormalisingTransport`] here, so a caller
    /// cannot forget it and end up with a llama.cpp context overflow arriving
    /// as an anonymous 400.
    pub fn new(
        descriptor: ProviderDescriptor,
        base_url: impl Into<String>,
        auth: Auth,
        secrets: Arc<dyn SecretStore>,
        transport: Arc<dyn HttpTransport>,
    ) -> Self {
        Self {
            descriptor,
            endpoint: Endpoint {
                base_url: base_url.into().trim_end_matches('/').to_owned(),
                auth,
                secrets,
                transport: Arc::new(NormalisingTransport::new(transport)),
            },
            options: CompatOptions::default(),
            learned: Mutex::new(HashMap::new()),
            facts: Mutex::new(None),
        }
    }

    pub fn with_options(mut self, options: CompatOptions) -> Self {
        self.options = options;
        self
    }

    /// Seed capabilities from a previous probe, persisted in settings.
    pub fn with_capabilities(self, capabilities: ModelCapabilities) -> Self {
        self.remember(capabilities);
        self
    }

    /// What Vela currently believes about a model. Never fabricates: an
    /// unprobed model comes back [`ModelCapabilities::unknown`].
    pub fn known_capabilities(&self, model_id: &str) -> ModelCapabilities {
        self.learned
            .lock()
            .expect("capability cache poisoned")
            .get(model_id)
            .cloned()
            .unwrap_or_else(|| ModelCapabilities::unknown(model_id))
    }

    /// What the endpoint said about itself, if it has been asked yet.
    /// Diagnostics only — nothing here reaches the renderer.
    pub fn server_facts(&self) -> Option<ServerFacts> {
        self.facts.lock().expect("facts poisoned").clone()
    }

    /// The detected server family. A diagnostic; never a branch the user feels.
    pub fn flavour(&self) -> ServerFlavour {
        self.server_facts()
            .map(|facts| facts.flavour)
            .unwrap_or_default()
    }

    fn remember(&self, mut capabilities: ModelCapabilities) {
        if capabilities.findings.len() > MAX_FINDINGS {
            let excess = capabilities.findings.len() - MAX_FINDINGS;
            capabilities.findings.drain(0..excess);
        }
        self.learned
            .lock()
            .expect("capability cache poisoned")
            .insert(capabilities.model_id.clone(), capabilities);
    }

    fn options(&self) -> ProviderOptions {
        ProviderOptions {
            structured_output: self.options.structured_output,
            emulate_tools: self.options.emulate_tools,
            request_usage: self.options.request_usage,
            summariser: self.options.summariser.clone(),
        }
    }

    /// Build the core backend, seeded with everything known so far.
    fn inner(&self, model_id: &str) -> OpenAiCompatibleProvider {
        OpenAiCompatibleProvider::new(
            self.descriptor.clone(),
            self.endpoint.base_url.clone(),
            self.endpoint.auth.clone(),
            self.endpoint.secrets.clone(),
            self.endpoint.transport.clone(),
        )
        .with_options(self.options())
        .with_capabilities(self.known_capabilities(model_id))
    }

    /// Take back what the core learned during a turn — a tools refusal, a
    /// structured-output mismatch — so the next turn starts from it.
    fn absorb(&self, inner: &OpenAiCompatibleProvider, model_id: &str) {
        self.remember(inner.known_capabilities(model_id));
    }

    /// Interrogate the endpoint once, before the first turn, unless a probe has
    /// already established something. Best effort: a turn is never blocked by
    /// discovery failing, because the turn itself reports that far better.
    async fn discover_once(&self, model_id: &str, context: &RequestContext) {
        if !self.options.discover_before_first_turn
            || self.facts.lock().expect("facts poisoned").is_some()
        {
            return;
        }
        let Ok(facts) = discovery::discover(&self.endpoint, model_id, context).await else {
            return;
        };
        let mut capabilities = self.known_capabilities(model_id);
        facts.apply_to(&mut capabilities);
        self.remember(capabilities);
        *self.facts.lock().expect("facts poisoned") = Some(facts);
    }

    /// Run one turn against the core backend, then absorb what it learned.
    async fn attempt(
        &self,
        request: ChatRequest,
        sink: Option<&mut SuppressingSink<'_>>,
        context: &RequestContext,
    ) -> ProviderResult<ChatResponse> {
        let model_id = request.model_id.clone();
        let inner = self.inner(&model_id);
        let outcome = match sink {
            Some(sink) => inner.stream(request, sink, context).await,
            // The core has a genuinely separate non-streaming path; using it
            // keeps `complete()` from silently becoming a streamed request.
            None => inner.complete(request, context).await,
        };
        self.absorb(&inner, &model_id);
        outcome
    }

    async fn run(
        &self,
        request: ChatRequest,
        sink: Option<&mut dyn EventSink>,
        context: &RequestContext,
    ) -> ProviderResult<ChatResponse> {
        self.discover_once(&request.model_id, context).await;

        let mut tracked = sink.map(SuppressingSink::new);
        let first = self
            .attempt(request.clone(), tracked.as_mut(), context)
            .await;

        let outcome = match first {
            Err(error) => match self.window_measured_by(&error, &request.model_id) {
                Some(limit) if self.may_retry(&tracked) => {
                    context.cancel.err_if_cancelled()?;
                    self.record_window(&request.model_id, limit);
                    self.attempt(request, tracked.as_mut(), context)
                        .await
                        .map(|mut response| {
                            response
                                .degradations
                                .push(Degradation::FailedOver { attempts: 2 });
                            response
                        })
                }
                _ => Err(error),
            },
            ok => ok,
        };

        // The terminal event is emitted here and exactly once, so a suppressed
        // first attempt can never show the user an error followed by an answer.
        if let Some(sink) = tracked.as_mut() {
            match &outcome {
                Ok(response) => sink.finish(StreamEvent::Done {
                    response: Box::new(response.clone()),
                }),
                Err(error) => sink.finish(StreamEvent::Error {
                    error: error.clone(),
                }),
            }
        }
        outcome
    }

    fn may_retry(&self, tracked: &Option<SuppressingSink<'_>>) -> bool {
        self.options.refit_on_context_overflow
            && tracked.as_ref().is_none_or(|sink| !sink.committed)
    }

    /// A refusal that names the window is a measurement of it. One that does
    /// not is just a refusal.
    fn window_measured_by(&self, error: &ProviderError, model_id: &str) -> Option<u32> {
        let ProviderError::ContextLengthExceeded {
            limit_tokens: Some(limit),
            ..
        } = error
        else {
            return None;
        };
        let already_known = self.known_capabilities(model_id).context_window_tokens;
        match already_known {
            // Nothing was learned, so retrying would repeat the same request.
            Some(known) if known <= *limit => None,
            _ => Some(*limit),
        }
    }

    fn record_window(&self, model_id: &str, limit: u32) {
        let mut capabilities = self.known_capabilities(model_id);
        capabilities.context_window_tokens = Some(limit);
        capabilities
            .findings
            .push(crate::capability::CapabilityFinding {
                capability: Capability::Streaming,
                support: capabilities.streaming,
                evidence: Evidence::Probed,
                note: format!("the endpoint refused a request over {limit} tokens"),
            });
        self.remember(capabilities);
    }
}

/// Wraps the caller's sink for the duration of a turn.
///
/// Two jobs, both about honesty: it withholds the core's terminal event so this
/// adapter can emit exactly one of its own after a possible retry, and it
/// records whether anything visible has reached the screen — because a retry
/// that restarts a half-written answer is worse than the error it was avoiding.
struct SuppressingSink<'a> {
    inner: &'a mut dyn EventSink,
    committed: bool,
}

impl<'a> SuppressingSink<'a> {
    fn new(inner: &'a mut dyn EventSink) -> Self {
        Self {
            inner,
            committed: false,
        }
    }

    /// Emit the one terminal event of this turn.
    fn finish(&mut self, event: StreamEvent) {
        debug_assert!(event.is_terminal());
        self.inner.emit(event);
    }
}

impl EventSink for SuppressingSink<'_> {
    fn emit(&mut self, event: StreamEvent) {
        match &event {
            StreamEvent::Done { .. } | StreamEvent::Error { .. } => return,
            StreamEvent::TextDelta { text } | StreamEvent::ReasoningDelta { text } => {
                self.committed |= !text.is_empty();
            }
            StreamEvent::ToolCallDelta { .. } => self.committed = true,
            StreamEvent::Usage { .. } => {}
        }
        self.inner.emit(event);
    }
}

#[async_trait]
impl Provider for CompatProvider {
    fn descriptor(&self) -> &ProviderDescriptor {
        &self.descriptor
    }

    async fn list_models(&self, context: &RequestContext) -> ProviderResult<Vec<ModelInfo>> {
        discovery::list_models(&self.endpoint, context).await
    }

    /// Declarations first, then the core's behavioural probes, then the
    /// declarations again to fill whatever the probes could not establish.
    ///
    /// The order matters. Discovery runs first because its result — a context
    /// window, a withdrawn capability — makes the behavioural probes cheaper
    /// and safer. It runs again at the end because a probe that failed leaves
    /// [`Support::Unknown`], and a conservative declaration is a better answer
    /// than nothing.
    async fn probe_capabilities(
        &self,
        model_id: &str,
        context: &RequestContext,
    ) -> ProviderResult<ModelCapabilities> {
        // An `Err` here means nothing answered at all. Reporting that beats
        // reporting a model that "supports nothing", which is what a table
        // built out of failed probes would say.
        let facts = discovery::discover(&self.endpoint, model_id, context).await?;

        let mut declared = ModelCapabilities::unknown(model_id);
        facts.apply_to(&mut declared);
        if facts.listing_answered {
            declared.set(
                Capability::ModelListing,
                Support::Supported,
                Evidence::Probed,
                format!("{} model(s) listed", facts.models.len()),
            );
        }
        self.remember(declared);

        let inner = self.inner(model_id);
        let probed = inner.probe_capabilities(model_id, context).await;
        self.absorb(&inner, model_id);

        let mut capabilities = match probed {
            Ok(probed) => probed,
            // The behavioural probes could not run. Everything discovery
            // established is still true, and is still better than nothing.
            Err(_) => self.known_capabilities(model_id),
        };
        facts.apply_to(&mut capabilities);
        if capabilities.model_listing == Support::Unknown && facts.listing_answered {
            capabilities.set(
                Capability::ModelListing,
                Support::Supported,
                Evidence::Probed,
                "a model listing endpoint answered",
            );
        }

        self.remember(capabilities.clone());
        *self.facts.lock().expect("facts poisoned") = Some(facts);
        Ok(capabilities)
    }

    async fn stream(
        &self,
        request: ChatRequest,
        sink: &mut dyn EventSink,
        context: &RequestContext,
    ) -> ProviderResult<ChatResponse> {
        self.run(request, Some(sink), context).await
    }

    async fn complete(
        &self,
        request: ChatRequest,
        context: &RequestContext,
    ) -> ProviderResult<ChatResponse> {
        self.run(request, None, context).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostic::Cause;
    use crate::capability::CapabilityFinding;
    use crate::error::TransportFailure;
    use crate::event::CollectingSink;
    use crate::http::testing::{CannedResponse, ScriptedTransport};
    use crate::http::ResponseHeaders;
    use crate::http::{HttpRequest, HttpResponse, TransportError};
    use crate::model::{ChatMessage, MessageRole};
    use crate::provider::Timeouts;
    use crate::redact::RequestUrl;
    use serde_json::{json, Value};
    use vela_core::provider::ProviderKind;
    use vela_secrets::MemoryStore;

    fn descriptor() -> ProviderDescriptor {
        ProviderDescriptor::new("compat", "Compatible", ProviderKind::Local).unwrap()
    }

    fn build(
        responses: Vec<Result<CannedResponse, TransportError>>,
    ) -> (CompatProvider, Arc<ScriptedTransport>) {
        let transport = Arc::new(ScriptedTransport::new(responses));
        let provider = CompatProvider::new(
            descriptor(),
            "http://127.0.0.1:9/v1",
            Auth::None,
            Arc::new(MemoryStore::new()),
            transport.clone(),
        );
        (provider, transport)
    }

    /// No discovery, so a test can script exactly the chat exchange it cares
    /// about without four leading GETs.
    fn build_bare(
        responses: Vec<Result<CannedResponse, TransportError>>,
    ) -> (CompatProvider, Arc<ScriptedTransport>) {
        let (provider, transport) = build(responses);
        (
            provider.with_options(CompatOptions {
                discover_before_first_turn: false,
                ..CompatOptions::default()
            }),
            transport,
        )
    }

    fn completion(content: &str) -> String {
        json!({
            "id": "c",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": content},
                         "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 2}
        })
        .to_string()
    }

    fn long_request() -> ChatRequest {
        ChatRequest::new("m").with_messages(
            (0..40).map(|n| ChatMessage::user(format!("turn {n} {}", "padding ".repeat(40)))),
        )
    }

    #[tokio::test]
    async fn a_vllm_style_overflow_teaches_the_window_and_the_turn_is_refitted_and_retried() {
        // MEASURED-7 plus the vLLM error dialect: the refusal is a number, and
        // a number is something to act on rather than something to report.
        let overflow = r#"{"object":"error","message":"This model's maximum context length is 2048 tokens. However, you requested 9000 tokens.","type":"BadRequestError","code":400}"#;
        let (provider, transport) = build_bare(vec![
            Ok(CannedResponse::error(400, overflow)),
            Ok(CannedResponse::ok(&completion("fitted"))),
        ]);

        let mut sink = CollectingSink::new();
        let response = provider
            .stream(long_request(), &mut sink, &RequestContext::new())
            .await
            .expect("a refusal that names the window is recoverable");

        assert_eq!(transport.recorded().len(), 2, "one refusal, one refit");
        let refitted: Value =
            serde_json::from_slice(transport.recorded()[1].body.as_ref().unwrap()).unwrap();
        let sent = refitted["messages"].as_array().unwrap().len();
        assert!(
            sent < 40,
            "the retry must actually be smaller, not the same request again"
        );
        assert!(
            response
                .degradations
                .iter()
                .any(|d| matches!(d, Degradation::ContextReduced { .. })),
            "a reduction the user cannot see is a silent truncation: {:?}",
            response.degradations
        );
        assert!(response
            .degradations
            .iter()
            .any(|d| matches!(d, Degradation::FailedOver { attempts: 2 })));
        assert_eq!(
            provider.known_capabilities("m").context_window_tokens,
            Some(2_048),
            "the window is remembered, so the next turn is fitted first time"
        );
    }

    #[tokio::test]
    async fn the_user_sees_one_terminal_event_and_never_an_error_before_the_answer() {
        let overflow = r#"{"error":{"code":400,"message":"maximum context length is 2048 tokens, however you requested 9000 tokens","type":"exceed_context_size_error"}}"#;
        let (provider, _) = build_bare(vec![
            Ok(CannedResponse::error(400, overflow)),
            Ok(CannedResponse::ok(&completion("fitted"))),
        ]);
        let mut sink = CollectingSink::new();
        provider
            .stream(long_request(), &mut sink, &RequestContext::new())
            .await
            .unwrap();
        let terminals: Vec<&StreamEvent> = sink
            .events
            .iter()
            .filter(|event| event.is_terminal())
            .collect();
        assert_eq!(
            terminals.len(),
            1,
            "exactly one terminal event: {terminals:?}"
        );
        assert!(matches!(terminals[0], StreamEvent::Done { .. }));
        assert!(
            sink.error().is_none(),
            "the suppressed attempt must not surface"
        );
    }

    #[tokio::test]
    async fn a_refusal_that_names_no_number_is_reported_rather_than_retried() {
        // llama.cpp's own phrasing carries no counts. There is nothing to learn,
        // so retrying would only repeat the identical request.
        let overflow = r#"{"error":{"code":400,"message":"the request exceeds the available context size. try increasing the context size or enable context shift","type":"exceed_context_size_error"}}"#;
        let (provider, transport) = build_bare(vec![Ok(CannedResponse::error(400, overflow))]);
        let error = provider
            .complete(long_request(), &RequestContext::new())
            .await
            .unwrap_err();
        assert!(matches!(error, ProviderError::ContextLengthExceeded { .. }));
        assert_eq!(
            transport.recorded().len(),
            1,
            "nothing was learned, so nothing is retried"
        );
    }

    #[tokio::test]
    async fn a_second_overflow_after_refitting_is_surfaced_instead_of_looping() {
        let overflow = r#"{"error":{"message":"maximum context length is 2048 tokens, however you requested 9000 tokens","code":"context_length_exceeded"}}"#;
        let (provider, transport) = build_bare(vec![
            Ok(CannedResponse::error(400, overflow)),
            Ok(CannedResponse::error(400, overflow)),
            Ok(CannedResponse::ok(&completion("never reached"))),
        ]);
        let error = provider
            .complete(long_request(), &RequestContext::new())
            .await
            .unwrap_err();
        assert!(matches!(error, ProviderError::ContextLengthExceeded { .. }));
        assert_eq!(transport.recorded().len(), 2, "at most one refit per turn");
    }

    #[tokio::test]
    async fn nothing_is_retried_once_a_character_has_reached_the_screen() {
        // A stream that commits output and then dies must not restart: the user
        // would watch the answer rewind.
        let sse = CannedResponse::sse(vec![
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"half an ans\"}}]}\n\n",
        ]);
        let (provider, transport) = build_bare(vec![
            Ok(sse),
            Ok(CannedResponse::ok(&completion("a whole new answer"))),
        ]);
        let mut sink = CollectingSink::new();
        let response = provider
            .stream(
                ChatRequest::new("m").with_message(ChatMessage::user("hi")),
                &mut sink,
                &RequestContext::new(),
            )
            .await
            .unwrap();
        assert_eq!(transport.recorded().len(), 1);
        assert_eq!(sink.text(), "half an ans");
        assert_eq!(response.answer_text(), "half an ans");
    }

    #[tokio::test]
    async fn discovery_finds_the_window_before_the_first_turn_so_it_is_fitted_first_time() {
        let (provider, transport) = build(vec![
            // /v1/models
            Ok(CannedResponse::ok(
                &json!({"object": "list", "data": [{"id": "m", "object": "model"}]}).to_string(),
            )),
            // /props — llama.cpp shaped
            Ok(CannedResponse::ok(
                &json!({"default_generation_settings": {"n_ctx": 2048},
                        "total_slots": 1, "model_path": "/m.gguf"})
                .to_string(),
            )),
            Ok(CannedResponse::ok(&completion("ok"))),
        ]);
        let response = provider
            .complete(long_request(), &RequestContext::new())
            .await
            .unwrap();
        assert_eq!(provider.flavour(), ServerFlavour::LlamaCpp);
        assert_eq!(
            provider.known_capabilities("m").context_window_tokens,
            Some(2_048)
        );
        assert!(
            response
                .degradations
                .iter()
                .any(|d| matches!(d, Degradation::ContextReduced { .. })),
            "the very first turn is fitted, without spending a refusal to learn the window"
        );
        let urls: Vec<RequestUrl> = transport
            .recorded()
            .iter()
            .map(|request| request.url.clone())
            .collect();
        assert_eq!(
            urls,
            vec![
                "http://127.0.0.1:9/v1/models",
                // `/props` is at the origin, not under the API prefix.
                "http://127.0.0.1:9/props",
                "http://127.0.0.1:9/v1/chat/completions"
            ]
        );
    }

    #[tokio::test]
    async fn discovery_runs_once_per_provider_not_once_per_turn() {
        let (provider, transport) = build(vec![
            Ok(CannedResponse::ok(&json!({"data": []}).to_string())),
            Ok(CannedResponse::ok(
                &json!({"total_slots": 1, "model_path": "/m"}).to_string(),
            )),
            Ok(CannedResponse::ok(&completion("one"))),
            Ok(CannedResponse::ok(&completion("two"))),
        ]);
        let request = ChatRequest::new("m").with_message(ChatMessage::user("hi"));
        provider
            .complete(request.clone(), &RequestContext::new())
            .await
            .unwrap();
        provider
            .complete(request, &RequestContext::new())
            .await
            .unwrap();
        assert_eq!(
            transport.recorded().len(),
            4,
            "two discovery GETs and two turns — not two rounds of discovery"
        );
    }

    #[tokio::test]
    async fn an_endpoint_nothing_answers_on_is_reported_as_unreachable_not_as_incapable() {
        let unreachable = || {
            Err(TransportError::new(
                TransportFailure::Connect,
                Cause::ConnectionFailed,
            ))
        };
        let (provider, _) = build(vec![
            unreachable(),
            unreachable(),
            unreachable(),
            unreachable(),
        ]);
        let error = provider
            .probe_capabilities("m", &RequestContext::new())
            .await
            .unwrap_err();
        assert!(
            matches!(
                error,
                ProviderError::Transport {
                    failure: TransportFailure::Connect,
                    ..
                }
            ),
            "a table of `Unsupported` would be a lie about a server that is simply not running: {error:?}"
        );
    }

    #[tokio::test]
    async fn a_server_that_enumerates_nothing_is_a_normal_state_not_a_failure() {
        let (provider, _) = build(vec![
            Ok(CannedResponse::error(
                404,
                r#"{"error":{"message":"unknown route /v1/models","code":"unknown_route"}}"#,
            )),
            Ok(CannedResponse::error(404, r#"{"error":"not found"}"#)),
            Ok(CannedResponse::error(404, r#"{"error":"not found"}"#)),
        ]);
        let error = provider
            .list_models(&RequestContext::new())
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            ProviderError::CapabilityUnsupported {
                capability: Capability::ModelListing,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn a_listing_is_read_from_whichever_shape_the_server_serves() {
        // The OpenAI route is absent; the native one answers. Same result.
        let (provider, _) = build(vec![
            Ok(CannedResponse::error(404, r#"{"error":"unknown route"}"#)),
            Ok(CannedResponse::ok(
                &json!({"models": [{"name": "llama3.1:8b", "model": "llama3.1:8b"},
                                   {"name": "qwen2.5:7b", "model": "qwen2.5:7b"}]})
                .to_string(),
            )),
        ]);
        let models = provider.list_models(&RequestContext::new()).await.unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "llama3.1:8b");
    }

    #[tokio::test]
    async fn no_credential_means_no_authorization_header_on_discovery_either() {
        // Auth::None is the default case for this adapter, and an empty Bearer
        // is a 401 on every profile the matrix recorded.
        let (provider, transport) = build(vec![
            Ok(CannedResponse::ok(&json!({"data": []}).to_string())),
            Ok(CannedResponse::ok(
                &json!({"total_slots": 1, "model_path": "/m"}).to_string(),
            )),
            Ok(CannedResponse::ok(&completion("hi"))),
        ]);
        provider
            .complete(
                ChatRequest::new("m").with_message(ChatMessage::user("hi")),
                &RequestContext::new(),
            )
            .await
            .unwrap();
        for request in transport.recorded() {
            assert_eq!(
                request.header("authorization"),
                None,
                "{} sent a credential header with no credential configured",
                request.url
            );
        }
    }

    #[tokio::test]
    async fn a_configured_credential_reaches_the_discovery_endpoints_too() {
        use vela_core::auth::AuthMode;
        use vela_core::secret::{SecretRef, SecretValue};
        let secrets = MemoryStore::new();
        secrets
            .set(
                &SecretRef::primary("compat").unwrap(),
                &SecretValue::new("k"),
            )
            .unwrap();
        let transport = Arc::new(ScriptedTransport::new(vec![
            Ok(CannedResponse::ok(&json!({"data": []}).to_string())),
            Ok(CannedResponse::error(404, "{}")),
            Ok(CannedResponse::error(404, "{}")),
            Ok(CannedResponse::error(404, "{}")),
        ]));
        let provider = CompatProvider::new(
            descriptor(),
            "http://h/v1",
            Auth::for_provider("compat", &AuthMode::BearerToken).unwrap(),
            Arc::new(secrets),
            transport.clone(),
        );
        let _ = provider.list_models(&RequestContext::new()).await;
        assert_eq!(
            transport.recorded()[0].header("authorization"),
            Some("Bearer k")
        );
    }

    #[tokio::test]
    async fn a_cancelled_turn_stops_before_anything_is_sent() {
        let (provider, transport) = build(vec![]);
        let context = RequestContext::new();
        context.cancel.cancel();
        let error = provider
            .complete(
                ChatRequest::new("m").with_message(ChatMessage::user("hi")),
                &context,
            )
            .await
            .unwrap_err();
        assert_eq!(error, ProviderError::Cancelled);
        assert!(transport.recorded().is_empty());
    }

    #[tokio::test]
    async fn a_stalled_stream_is_abandoned_rather_than_awaited_forever() {
        struct Stalling;
        #[async_trait]
        impl HttpTransport for Stalling {
            async fn send(
                &self,
                _request: HttpRequest,
                _timeouts: &Timeouts,
            ) -> Result<HttpResponse, TransportError> {
                Ok(HttpResponse {
                    status: 200,
                    headers: ResponseHeaders::carries_no_credential([(
                        "content-type".to_owned(),
                        "text/event-stream".to_owned(),
                    )]),
                    body: crate::http::testing::fake_body(crate::http::testing::StalledBody),
                })
            }
        }
        let provider = CompatProvider::new(
            descriptor(),
            "http://h/v1",
            Auth::None,
            Arc::new(MemoryStore::new()),
            Arc::new(Stalling),
        )
        .with_options(CompatOptions {
            discover_before_first_turn: false,
            ..CompatOptions::default()
        });
        let context = RequestContext::new().with_timeouts(Timeouts {
            stall: std::time::Duration::from_millis(50),
            ..Timeouts::default()
        });
        let mut sink = CollectingSink::new();
        let error = provider
            .stream(
                ChatRequest::new("m").with_message(ChatMessage::user("hi")),
                &mut sink,
                &context,
            )
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            ProviderError::Transport {
                failure: TransportFailure::Stalled,
                ..
            }
        ));
        assert!(sink.error().is_some(), "the sink is told, not left hanging");
    }

    #[test]
    fn no_server_identity_reaches_the_ui() {
        // conventions.md §0.3: the renderer branches on capability flags and
        // never on which server is answering.
        let mut capabilities = ModelCapabilities::unknown("m");
        capabilities.set(
            Capability::Vision,
            Support::Unsupported,
            Evidence::Declared,
            "the server lists this model's capabilities and `vision` is not among them",
        );
        let descriptor_json = serde_json::to_string(&capabilities.to_descriptor()).unwrap();
        for flavour in [
            ServerFlavour::LlamaCpp,
            ServerFlavour::Ollama,
            ServerFlavour::LmStudio,
            ServerFlavour::VLlm,
        ] {
            assert!(
                !descriptor_json.contains(flavour.code()),
                "{flavour} leaked into the UI flag set"
            );
        }
        // And no degradation this adapter produces names one either.
        let degradations = serde_json::to_string(&vec![
            Degradation::FailedOver { attempts: 2 },
            Degradation::StructuredOutputUnsupported,
        ])
        .unwrap();
        assert!(!degradations.contains("llama"));
        assert!(!degradations.contains("ollama"));
    }

    #[test]
    fn the_finding_log_is_bounded_so_a_long_session_cannot_grow_it_without_limit() {
        let (provider, _) = build(vec![]);
        let mut capabilities = ModelCapabilities::unknown("m");
        for n in 0..(MAX_FINDINGS + 20) {
            capabilities.findings.push(CapabilityFinding {
                capability: Capability::Streaming,
                support: Support::Unknown,
                evidence: Evidence::Probed,
                note: format!("{n}"),
            });
        }
        provider.remember(capabilities);
        let kept = provider.known_capabilities("m").findings;
        assert_eq!(kept.len(), MAX_FINDINGS);
        assert_eq!(
            kept.last().unwrap().note,
            format!("{}", MAX_FINDINGS + 19),
            "the newest findings are the ones worth keeping"
        );
    }

    #[tokio::test]
    async fn what_the_core_learns_during_a_turn_is_kept_for_the_next_one() {
        let refusal = json!({"error": {"message": "no tools here", "code": "tools_not_supported"}})
            .to_string();
        let (provider, transport) = build_bare(vec![
            Ok(CannedResponse::error(400, &refusal)),
            Ok(CannedResponse::ok(&completion("prose"))),
            Ok(CannedResponse::ok(&completion("prose"))),
        ]);
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::user("weather?"))
            .with_tools([crate::model::ToolDefinition::new(
                "get_weather",
                "d",
                json!({"type": "object"}),
            )]);
        provider
            .complete(request.clone(), &RequestContext::new())
            .await
            .unwrap();
        assert_eq!(
            provider.known_capabilities("m").tool_calling,
            Support::Unsupported
        );
        provider
            .complete(request, &RequestContext::new())
            .await
            .unwrap();
        assert_eq!(
            transport.recorded().len(),
            3,
            "the second turn must not repeat the attempt the endpoint already refused"
        );
        let last: Value =
            serde_json::from_slice(transport.recorded()[2].body.as_ref().unwrap()).unwrap();
        assert!(last.get("tools").is_none());
    }

    #[tokio::test]
    async fn a_message_with_an_image_is_still_refused_when_a_probe_said_so() {
        let mut capabilities = ModelCapabilities::unknown("m");
        capabilities.set(
            Capability::Vision,
            Support::Unsupported,
            Evidence::Probed,
            "400 vision_not_supported",
        );
        let (provider, transport) = build(vec![]);
        let provider = provider
            .with_options(CompatOptions {
                discover_before_first_turn: false,
                ..CompatOptions::default()
            })
            .with_capabilities(capabilities);
        let error = provider
            .complete(
                ChatRequest::new("m").with_message(ChatMessage::new(
                    MessageRole::User,
                    vec![crate::model::ContentPart::Image {
                        mime_type: "image/png".into(),
                        data: vec![1],
                    }],
                )),
                &RequestContext::new(),
            )
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            ProviderError::CapabilityUnsupported {
                capability: Capability::Vision,
                ..
            }
        ));
        assert!(transport.recorded().is_empty());
    }
}
