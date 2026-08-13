//! The Gemini provider: `:generateContent` / `:streamGenerateContent`, and
//! every degradation path made explicit.
//!
//! # The order of operations in a turn, and why
//!
//! 1. **Refuse or reshape what cannot work** — an image to a model probed as
//!    vision-less is refused; tools offered to a model probed as having no
//!    `functionDeclarations` support are rendered into the prompt instead
//!    (`crate::emulation`), because on this API that genuinely is a per-model
//!    property and prompt emulation still works; a structured request to a
//!    model probed as ignoring schemas is refused or validated, per policy.
//! 2. **Fit the context** — explicitly, with a note in the prompt
//!    (`crate::context`), using the window this endpoint *declares* in its
//!    model list. Never a silent truncation, and never a guessed window.
//! 3. **Send, and learn from the refusal.** A model that rejects
//!    `thinkingConfig`, `systemInstruction` or a `safetySettings` category has
//!    just told Vela something true. Each is recorded as a [`Concession`], the
//!    turn is retried in the shape the endpoint will accept, and the retry is
//!    reported as a [`Degradation::FailedOver`].
//! 4. **Normalise the answer** — end-of-body terminates, bad frames are
//!    skipped, thoughts keep their signatures, tool calls accumulate
//!    defensively, and a content block becomes a truthful error rather than a
//!    blank turn. See [`super::stream`].
//! 5. **Check what was promised** — a structured answer is validated against
//!    the schema Vela asked for, because MEASURED-5 says nothing else will.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{json, Value};
use vela_core::credential::Auth;
use vela_core::provider::ProviderDescriptor;
use vela_secrets::{resolve_auth, SecretError, SecretStore};

use crate::capability::{Evidence, ModelCapabilities, Support};
use crate::context::{fit_request, ContextBudget, ConversationSummariser, ElisionNote};
use crate::emulation;
use crate::error::{detail, Capability, ProviderError, ProviderResult, TransportFailure};
use crate::event::{CollectingSink, EventSink, NullSink, StreamEvent};
use crate::http::{HttpRequest, HttpTransport, TransportError};
use crate::model::{
    ChatMessage, ChatRequest, ChatResponse, ContentPart, Degradation, MessageRole, ResponseFormat,
    ToolChoice, ToolDefinition,
};
use crate::provider::{ModelInfo, Provider, RequestContext};
use crate::structured::{self, StructuredOutputPolicy};

use super::stream::{AssembledCandidate, CandidateAssembler};
use super::wire::{self, Concessions, SafetySetting};
use super::{concession_for, map_error_response, Concession, MAX_ERROR_BODY_BYTES};

/// The public endpoint. A user may point the adapter anywhere — a proxy, a
/// gateway, a self-hosted relay — so this is a default, never a constraint.
pub const DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com";

/// Cap on a non-streaming response body. Bounds what a broken endpoint can make
/// Vela allocate; far above any real completion.
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// One original attempt plus at most three concessions. Bounded so a refusal
/// that keeps arriving cannot become a retry loop against someone's paid
/// endpoint.
const MAX_ATTEMPTS: u32 = 4;

/// The largest page this API's model list will serve.
const MODEL_PAGE_SIZE: u32 = 1_000;

/// Behaviour knobs an adapter builder sets once, at construction.
pub struct GoogleOptions {
    pub structured_output: StructuredOutputPolicy,
    /// The API version segment. Configurable because a gateway may pin an older
    /// one; defaulted so no caller has to know the value exists.
    pub api_version: String,
    /// Content-filter thresholds to send.
    ///
    /// **Empty by default, and that is a decision, not an omission.** Sending
    /// nothing leaves the endpoint's own defaults in place. Quietly loosening
    /// someone's content filtering is not a choice a model-agnostic client gets
    /// to make on their behalf; a caller who wants different thresholds sets
    /// them here explicitly.
    pub safety: Vec<SafetySetting>,
    /// How dropped history is replaced when the window is too small.
    pub summariser: Arc<dyn ConversationSummariser>,
}

impl Default for GoogleOptions {
    fn default() -> Self {
        Self {
            structured_output: StructuredOutputPolicy::default(),
            api_version: wire::DEFAULT_API_VERSION.to_owned(),
            safety: Vec::new(),
            summariser: Arc::new(ElisionNote),
        }
    }
}

impl std::fmt::Debug for GoogleOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GoogleOptions")
            .field("structured_output", &self.structured_output)
            .field("api_version", &self.api_version)
            .field("safety", &self.safety)
            .finish_non_exhaustive()
    }
}

pub struct GoogleProvider {
    descriptor: ProviderDescriptor,
    base_url: String,
    auth: Auth,
    secrets: Arc<dyn SecretStore>,
    transport: Arc<dyn HttpTransport>,
    options: GoogleOptions,
    /// What probing (or a refusal) has taught us, per model id.
    learned: Mutex<HashMap<String, ModelCapabilities>>,
    /// Request-shape reductions a model has already demanded, per model id, so
    /// the wasted first attempt happens once rather than every turn.
    concessions: Mutex<HashMap<String, Concessions>>,
}

impl GoogleProvider {
    pub fn new(
        descriptor: ProviderDescriptor,
        base_url: impl Into<String>,
        auth: Auth,
        secrets: Arc<dyn SecretStore>,
        transport: Arc<dyn HttpTransport>,
    ) -> Self {
        Self {
            descriptor,
            base_url: base_url.into().trim_end_matches('/').to_owned(),
            auth,
            secrets,
            transport,
            options: GoogleOptions::default(),
            learned: Mutex::new(HashMap::new()),
            concessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn with_options(mut self, options: GoogleOptions) -> Self {
        self.options = options;
        self
    }

    /// Seed known capabilities — from a previous probe, persisted in settings.
    pub fn with_capabilities(self, capabilities: ModelCapabilities) -> Self {
        self.learned
            .lock()
            .expect("capability cache poisoned")
            .insert(capabilities.model_id.clone(), capabilities);
        self
    }

    /// What Vela currently believes about a model. Never fabricates: a model
    /// that has not been probed comes back [`ModelCapabilities::unknown`].
    pub fn known_capabilities(&self, model_id: &str) -> ModelCapabilities {
        self.learned
            .lock()
            .expect("capability cache poisoned")
            .get(model_id)
            .cloned()
            .unwrap_or_else(|| ModelCapabilities::unknown(model_id))
    }

    fn learn(&self, capabilities: ModelCapabilities) {
        self.learned
            .lock()
            .expect("capability cache poisoned")
            .insert(capabilities.model_id.clone(), capabilities);
    }

    fn learn_one(&self, model_id: &str, capability: Capability, support: Support, note: &str) {
        let mut capabilities = self.known_capabilities(model_id);
        capabilities.set(capability, support, Evidence::Probed, note);
        self.learn(capabilities);
    }

    /// Reductions this model has already demanded. All three are properties of
    /// the *model*, so all three are remembered.
    pub fn known_concessions(&self, model_id: &str) -> Concessions {
        self.concessions
            .lock()
            .expect("concession cache poisoned")
            .get(model_id)
            .copied()
            .unwrap_or_default()
    }

    fn remember(&self, model_id: &str, concession: Concession) {
        let mut cache = self.concessions.lock().expect("concession cache poisoned");
        let entry = cache.entry(model_id.to_owned()).or_default();
        apply_concession(entry, concession);
    }

    /// `<base>/<version>`, inserting the version only when the user's base URL
    /// does not already carry one. Both forms are common when a gateway sits in
    /// front.
    fn api_root(&self) -> String {
        if has_version_segment(&self.base_url) {
            self.base_url.clone()
        } else {
            format!("{}/{}", self.base_url, self.options.api_version)
        }
    }

    /// `<root>/models/<id>:<method>`. Streaming adds `alt=sse`, without which
    /// this API answers a streaming call with a JSON *array* rather than an
    /// event stream.
    fn generate_url(&self, model_id: &str, streaming: bool) -> String {
        let resource = wire::model_resource(model_id);
        let method = if streaming {
            "streamGenerateContent"
        } else {
            "generateContent"
        };
        let url = format!("{}/{resource}:{method}", self.api_root());
        if streaming {
            format!("{url}?alt=sse")
        } else {
            url
        }
    }

    /// Everything every request carries, credential included.
    ///
    /// **The whole point of the credential half is what it does with no
    /// credential: nothing.** `Auth::None` never reaches the keychain and never
    /// produces a header — not even an empty one, which endpoints answer with a
    /// 401 that then gets misreported as "bad API key".
    fn prepare_http(&self, request: HttpRequest) -> ProviderResult<HttpRequest> {
        let applied = match resolve_auth(self.secrets.as_ref(), &self.auth) {
            Ok(applied) => applied,
            Err(SecretError::NotFound { .. }) => {
                return Err(ProviderError::AuthFailed {
                    detail: detail(
                        "this provider is configured to send a credential, but none is stored",
                    ),
                })
            }
            Err(SecretError::Unavailable { .. }) => {
                return Err(ProviderError::AuthFailed {
                    detail: detail("the credential store could not be read"),
                })
            }
            Err(error) => {
                return Err(ProviderError::AuthFailed {
                    detail: detail(error.to_string()),
                })
            }
        };
        // The query-parameter form is this API's documented alternative to the
        // key header, and `with_auth` is what makes it safe: the credential
        // goes into a `RequestUrl`, which cannot be printed into showing it.
        Ok(request.with_auth(&applied))
    }

    async fn get_json(&self, url: String, context: &RequestContext) -> ProviderResult<Value> {
        let request = self.prepare_http(HttpRequest::get(url))?;
        let mut response = self.transport.send(request, &context.timeouts).await?;
        let body = response.read_to_end(MAX_ERROR_BODY_BYTES).await?;
        if response.status != 200 {
            return Err(map_error_response(
                response.status,
                &body,
                "",
                response.header("retry-after"),
            ));
        }
        body.json()
            .map_err(|error| ProviderError::malformed(format!("response was not JSON: {error}")))
    }

    /// Everything that happens before a byte is sent.
    fn prepare(
        &self,
        request: ChatRequest,
        capabilities: &ModelCapabilities,
    ) -> ProviderResult<Prepared> {
        let mut degradations = Vec::new();

        if request.needs_vision() && capabilities.vision == Support::Unsupported {
            return Err(ProviderError::unsupported(
                Capability::Vision,
                "this model does not accept image input",
            ));
        }

        let schema = match &request.response_format {
            ResponseFormat::Text => None,
            ResponseFormat::JsonSchema { schema, .. } => {
                match capabilities.structured_output {
                    Support::Supported => {}
                    Support::Unsupported | Support::Degraded => {
                        if self.options.structured_output == StructuredOutputPolicy::Refuse {
                            return Err(ProviderError::unsupported(
                                Capability::StructuredOutput,
                                "this model was probed and does not honour a response schema",
                            ));
                        }
                        degradations.push(Degradation::StructuredOutputUnsupported);
                    }
                    // Never probed: send it, and validate what comes back. The
                    // validation is what makes this safe — MEASURED-5's failure
                    // is a 200 with prose, which validation catches.
                    Support::Unknown => {}
                }
                Some(schema.clone())
            }
        };

        let mut request = request;
        if let Some(budget) =
            ContextBudget::for_request(&request, capabilities.context_window_tokens)
        {
            let (fitted, context_degradations) =
                fit_request(request, budget, self.options.summariser.as_ref())?;
            request = fitted;
            degradations.extend(context_degradations);
        }

        // Unlike the Messages API, function calling here is a per-model
        // property: several published models serve `generateContent` and reject
        // `functionDeclarations` outright. Refusing the turn would withdraw an
        // affordance that prompt emulation can still serve, so the catalogue is
        // rendered into the prompt instead — and reported.
        let emulate_tools = request.offers_tools() && capabilities.needs_tool_emulation();
        if emulate_tools || (!request.tools.is_empty() && request.tool_choice == ToolChoice::None) {
            let (rewritten, tool_degradations) = emulation::emulate(request);
            request = rewritten;
            degradations.extend(tool_degradations);
        }

        Ok(Prepared {
            request,
            schema,
            emulate_tools,
            degradations,
        })
    }

    /// One HTTP exchange. Returns the refusal *and* what it justifies, so the
    /// caller can decide whether the turn is retriable in a different shape.
    async fn attempt(
        &self,
        prepared: &Prepared,
        concessions: Concessions,
        streaming: bool,
        sink: &mut dyn EventSink,
        context: &RequestContext,
    ) -> Result<AssembledCandidate, Refusal> {
        let encoded = wire::encode_request(&prepared.request, concessions, &self.options.safety);
        let bytes = serde_json::to_vec(&encoded.body).map_err(|error| {
            ProviderError::malformed(format!("could not encode request: {error}"))
        })?;
        let request = self.prepare_http(
            HttpRequest::post_json(
                self.generate_url(&prepared.request.model_id, streaming),
                bytes,
            )
            .with_header(
                "accept",
                if streaming {
                    "text/event-stream"
                } else {
                    "application/json"
                },
            ),
        )?;

        context.cancel.err_if_cancelled()?;
        let mut response = self.transport.send(request, &context.timeouts).await?;

        if response.status != 200 {
            let body = response.read_to_end(MAX_ERROR_BODY_BYTES).await?;
            return Err(Refusal {
                error: map_error_response(
                    response.status,
                    &body,
                    &prepared.request.model_id,
                    response.header("retry-after"),
                ),
                // Nothing has been emitted to the sink at this point, which is
                // what makes retrying the turn safe.
                concession: concession_for(&body),
            });
        }

        let mut assembler = CandidateAssembler::new(streaming);
        if prepared.emulate_tools {
            assembler = assembler.with_tool_emulation();
        }

        if streaming {
            // End-of-body is the terminator, every read is bounded by the stall
            // timeout, and cancellation abandons a read in flight (MEASURED-1).
            // Written here rather than reusing `crate::stream::drive_stream`,
            // which is typed to the OpenAI-shaped assembler.
            let mut body = response.body;
            // Grabbed before the loop borrows the body: a stall must still say
            // which endpoint went quiet, and the redacted form is safe to.
            let endpoint = body.endpoint().to_owned();
            loop {
                context.cancel.err_if_cancelled()?;
                let read = tokio::select! {
                    biased;
                    () = context.cancel.cancelled() => return Err(ProviderError::Cancelled.into()),
                    read = tokio::time::timeout(context.timeouts.stall, body.next_chunk()) => read,
                };
                match read {
                    Err(_elapsed) => {
                        return Err(ProviderError::transport(
                            TransportFailure::Stalled,
                            format!(
                                "no data for {} ms for url ({endpoint})",
                                context.timeouts.stall.as_millis()
                            ),
                        )
                        .into())
                    }
                    Ok(Err(error)) => return Err(ProviderError::from(error).into()),
                    // End of body. The one reliable terminator — and on this
                    // API the *only* one, because it sends no sentinel at all.
                    Ok(Ok(None)) => break,
                    Ok(Ok(Some(chunk))) => assembler.push_bytes(&chunk, sink),
                }
            }
            Ok(assembler.finish(sink)?)
        } else {
            let body = response.read_to_end(MAX_RESPONSE_BYTES).await?;
            // Decoded through the body's own scrubber: the non-streamed path
            // reconstitutes an escaped credential just as readily as the
            // streamed one.
            let value: Value = body.json().map_err(|error| {
                ProviderError::malformed(format!("response was not JSON: {error}"))
            })?;
            assembler.apply_body(&value, sink);
            Ok(assembler.finish(sink)?)
        }
    }

    async fn run(
        &self,
        request: ChatRequest,
        streaming: bool,
        sink: &mut dyn EventSink,
        context: &RequestContext,
    ) -> ProviderResult<ChatResponse> {
        let model_id = request.model_id.clone();
        let capabilities = self.known_capabilities(&model_id);
        let prepared = self.prepare(request, &capabilities)?;

        let mut concessions = self.known_concessions(&model_id);
        let mut attempts = 0;
        let assembled = loop {
            attempts += 1;
            match self
                .attempt(&prepared, concessions, streaming, sink, context)
                .await
            {
                Ok(assembled) => break assembled,
                Err(Refusal { error, concession }) => {
                    let retriable = concession.filter(|concession| {
                        attempts < MAX_ATTEMPTS && !already_applied(concessions, *concession)
                    });
                    match retriable {
                        Some(concession) => {
                            apply_concession(&mut concessions, concession);
                            self.remember(&model_id, concession);
                        }
                        None => return Err(error),
                    }
                }
            }
        };

        let AssembledCandidate {
            mut response,
            cache_accounting_reported,
            thinking_accounting_reported,
        } = assembled;

        response
            .degradations
            .splice(0..0, prepared.degradations.clone());
        if attempts > 1 {
            response
                .degradations
                .push(Degradation::FailedOver { attempts });
        }
        if cache_accounting_reported
            && self.known_capabilities(&model_id).prompt_caching != Support::Supported
        {
            self.learn_one(
                &model_id,
                Capability::PromptCaching,
                Support::Supported,
                "the endpoint reported cached-input accounting in usage",
            );
        }
        if (thinking_accounting_reported || !response.reasoning_text().is_empty())
            && self.known_capabilities(&model_id).reasoning != Support::Supported
        {
            self.learn_one(
                &model_id,
                Capability::Reasoning,
                Support::Supported,
                "the endpoint reported thinking output or thinking-token accounting",
            );
        }

        if let Some(schema) = &prepared.schema {
            // MEASURED-5: the endpoint will not tell us the schema was ignored,
            // so the answer is checked against what was asked for. This API has
            // no separate structured channel — the JSON arrives as the answer.
            match structured::check_answer(schema, &response.answer_text()) {
                Ok(value) => response.structured = Some(Ok(value)),
                Err(mismatch) => {
                    self.learn_one(
                        &model_id,
                        Capability::StructuredOutput,
                        Support::Degraded,
                        "answered 200 without honouring the requested schema",
                    );
                    response
                        .degradations
                        .push(Degradation::StructuredOutputMismatch {
                            detail: mismatch.detail.clone(),
                        });
                    response.structured = Some(Err(mismatch));
                }
            }
        }

        Ok(response)
    }

    /// One probe exchange, against a blank capability sheet so a previous
    /// probe's conclusion cannot decide the next one's.
    async fn probe_send(
        &self,
        request: ChatRequest,
        context: &RequestContext,
    ) -> ProviderResult<AssembledCandidate> {
        let model_id = request.model_id.clone();
        let prepared = self.prepare(request, &ModelCapabilities::unknown(&model_id))?;
        let mut sink = NullSink;
        self.attempt(
            &prepared,
            self.known_concessions(&model_id),
            false,
            &mut sink,
            context,
        )
        .await
        .map_err(|refusal| refusal.error)
    }
}

struct Prepared {
    request: ChatRequest,
    schema: Option<Value>,
    /// The catalogue was rendered into the prompt, so the answer must be parsed
    /// for a textual call.
    emulate_tools: bool,
    degradations: Vec<Degradation>,
}

/// A failed attempt, and the request-shape reduction it justifies.
struct Refusal {
    error: ProviderError,
    concession: Option<Concession>,
}

impl From<ProviderError> for Refusal {
    fn from(error: ProviderError) -> Self {
        Self {
            error,
            concession: None,
        }
    }
}

impl From<TransportError> for Refusal {
    fn from(error: TransportError) -> Self {
        ProviderError::from(error).into()
    }
}

fn apply_concession(concessions: &mut Concessions, concession: Concession) {
    match concession {
        Concession::ThinkingConfig => concessions.thinking_config = true,
        Concession::SystemInstruction => concessions.system_instruction = true,
        Concession::SafetySettings => concessions.safety_settings = true,
    }
}

fn already_applied(concessions: Concessions, concession: Concession) -> bool {
    match concession {
        Concession::ThinkingConfig => concessions.thinking_config,
        Concession::SystemInstruction => concessions.system_instruction,
        Concession::SafetySettings => concessions.safety_settings,
    }
}

/// Does this base URL already end in an API version segment (`v1`, `v1beta`,
/// `v1alpha`)? If so the user pinned one and the adapter must not add a second.
fn has_version_segment(base_url: &str) -> bool {
    let last = base_url.rsplit('/').next().unwrap_or_default();
    let Some(rest) = last.strip_prefix('v') else {
        return false;
    };
    rest.starts_with(|c: char| c.is_ascii_digit())
        && rest.chars().all(|c| c.is_ascii_alphanumeric())
}

#[async_trait]
impl Provider for GoogleProvider {
    fn descriptor(&self) -> &ProviderDescriptor {
        &self.descriptor
    }

    async fn list_models(&self, context: &RequestContext) -> ProviderResult<Vec<ModelInfo>> {
        let value = self
            .get_json(
                format!("{}/models?pageSize={MODEL_PAGE_SIZE}", self.api_root()),
                context,
            )
            .await?;
        let models = value
            .get("models")
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::malformed("model list had no `models` array"))?;
        Ok(models
            .iter()
            .filter(|entry| serves_completions(entry))
            .filter_map(|entry| {
                let name = entry.get("name").and_then(Value::as_str)?;
                let id = wire::model_id_of(name);
                Some(ModelInfo {
                    id: id.to_owned(),
                    display_name: entry
                        .get("displayName")
                        .and_then(Value::as_str)
                        .unwrap_or(id)
                        .to_owned(),
                    // Declared by the endpoint, so it is used. Absent means
                    // unknown — never a guess.
                    context_window: entry
                        .get("inputTokenLimit")
                        .and_then(Value::as_u64)
                        .and_then(|limit| u32::try_from(limit).ok()),
                })
            })
            .collect())
    }

    /// Establish what this model can do by asking it — five small requests.
    ///
    /// Each probe is output-token-bounded and every conclusion records how it
    /// was reached ([`Evidence`]), so a capability report can never claim a
    /// probe happened when a default was used.
    async fn probe_capabilities(
        &self,
        model_id: &str,
        context: &RequestContext,
    ) -> ProviderResult<ModelCapabilities> {
        let mut capabilities = ModelCapabilities::unknown(model_id);

        // 1. Model listing — and, for this endpoint, the declared window.
        match self.list_models(context).await {
            Ok(models) => {
                capabilities.set(
                    Capability::ModelListing,
                    Support::Supported,
                    Evidence::Probed,
                    format!("{} model(s) listed", models.len()),
                );
                if let Some(window) = models
                    .iter()
                    .find(|model| model.id == model_id)
                    .and_then(|model| model.context_window)
                {
                    capabilities.context_window_tokens = Some(window);
                    capabilities
                        .findings
                        .push(crate::capability::CapabilityFinding {
                            capability: Capability::ModelListing,
                            support: Support::Supported,
                            evidence: Evidence::Declared,
                            note: format!("the endpoint declares a {window}-token input limit"),
                        });
                }
            }
            Err(error) => {
                capabilities.set(
                    Capability::ModelListing,
                    Support::Unsupported,
                    Evidence::Probed,
                    error.code(),
                );
            }
        };

        // 2. A plain streamed turn: streaming, usage, reasoning, and — because
        //    the turn's usage carries the accounting — prompt caching.
        let plain = ChatRequest::new(model_id)
            .with_message(ChatMessage::system(
                "You are a helpful assistant answering a connection test.",
            ))
            .with_message(ChatMessage::user("Say OK."))
            .with_max_output_tokens(16);
        let prepared = self.prepare(plain, &ModelCapabilities::unknown(model_id))?;
        let mut sink = CollectingSink::new();
        match self
            .attempt(
                &prepared,
                self.known_concessions(model_id),
                true,
                &mut sink,
                context,
            )
            .await
        {
            Ok(assembled) => {
                capabilities.set(
                    Capability::Streaming,
                    Support::Supported,
                    Evidence::Probed,
                    "streamed a completion",
                );
                capabilities.set(
                    Capability::UsageReporting,
                    if assembled.response.usage.is_unreported() {
                        Support::Unsupported
                    } else {
                        Support::Supported
                    },
                    Evidence::Probed,
                    "usage on a streamed turn",
                );
                capabilities.set(
                    Capability::PromptCaching,
                    if assembled.cache_accounting_reported {
                        Support::Supported
                    } else {
                        Support::Unsupported
                    },
                    Evidence::Probed,
                    "cached-input accounting in the usage of an ordinary turn",
                );
                if assembled.thinking_accounting_reported
                    || !assembled.response.reasoning_text().is_empty()
                {
                    capabilities.set(
                        Capability::Reasoning,
                        Support::Supported,
                        Evidence::Probed,
                        "reported thinking output or thinking-token accounting",
                    );
                }
            }
            Err(refusal) => {
                capabilities.set(
                    Capability::Streaming,
                    Support::Unsupported,
                    Evidence::Probed,
                    refusal.error.code(),
                );
            }
        }

        // 3. Tool calling. A forced choice makes the answer unambiguous: an
        //    endpoint that accepts one and produces no call does not have the
        //    feature.
        let tool_probe = ChatRequest::new(model_id)
            .with_message(ChatMessage::user("What is the weather in Berlin?"))
            .with_tools([ToolDefinition::new(
                "get_weather",
                "Current weather for a city",
                json!({"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}),
            )])
            .with_tool_choice(ToolChoice::Required)
            .with_max_output_tokens(64);
        let (tool_support, tool_note) = match self.probe_send(tool_probe, context).await {
            Ok(assembled)
                if assembled
                    .response
                    .tool_calls
                    .iter()
                    .any(|call| call.is_ok()) =>
            {
                (
                    Support::Supported,
                    "returned a well-formed function call".to_owned(),
                )
            }
            // Calls arrive, but broken. The affordance survives because every
            // failure is surfaced explicitly (MEASURED-4).
            Ok(assembled) if !assembled.response.tool_calls.is_empty() => (
                Support::Degraded,
                "returned function calls that could not be parsed".to_owned(),
            ),
            Ok(_) => (
                Support::Unsupported,
                "accepted a forced function call and produced none".to_owned(),
            ),
            Err(ProviderError::CapabilityUnsupported { .. }) => (
                Support::Unsupported,
                "refused a request carrying a function catalogue".to_owned(),
            ),
            Err(error) => (Support::Unknown, error.code().to_owned()),
        };
        capabilities.set(
            Capability::ToolCalling,
            tool_support,
            Evidence::Probed,
            tool_note,
        );

        // 4. Vision: one 1x1 PNG.
        let vision_probe = ChatRequest::new(model_id)
            .with_message(ChatMessage::new(
                MessageRole::User,
                vec![
                    ContentPart::text("What colour is this?"),
                    ContentPart::Image {
                        mime_type: "image/png".into(),
                        data: ONE_PIXEL_PNG.to_vec(),
                    },
                ],
            ))
            .with_max_output_tokens(16);
        let (vision_support, vision_note) = match self.probe_send(vision_probe, context).await {
            Ok(_) => (Support::Supported, "accepted inline image bytes".to_owned()),
            Err(ProviderError::CapabilityUnsupported { .. }) => (
                Support::Unsupported,
                "refused inline image bytes".to_owned(),
            ),
            Err(error) => (Support::Unknown, error.code().to_owned()),
        };
        capabilities.set(
            Capability::Vision,
            vision_support,
            Evidence::Probed,
            vision_note,
        );

        // 5. Structured output — the one that cannot be taken on trust.
        let schema = json!({
            "type": "object",
            "properties": {"answer": {"type": "string"}},
            "required": ["answer"]
        });
        let structured_probe = ChatRequest::new(model_id)
            .with_message(ChatMessage::user(
                "Reply with a JSON object containing the key \"answer\".",
            ))
            .with_response_format(ResponseFormat::JsonSchema {
                name: "vela_probe".into(),
                schema: schema.clone(),
            })
            .with_max_output_tokens(64);
        let (structured_support, structured_note) =
            match self.probe_send(structured_probe, context).await {
                Ok(assembled) => {
                    match structured::check_answer(&schema, &assembled.response.answer_text()) {
                        Ok(_) => (
                            Support::Supported,
                            "returned JSON conforming to the requested schema".to_owned(),
                        ),
                        // MEASURED-5: 200 OK and prose. Only validation could
                        // tell; the endpoint said nothing was wrong.
                        Err(mismatch) => (
                            Support::Degraded,
                            format!(
                                "answered 200 without honouring the schema: {}",
                                mismatch.detail
                            ),
                        ),
                    }
                }
                Err(ProviderError::CapabilityUnsupported { .. }) => (
                    Support::Unsupported,
                    "refused a schema-shaped request".to_owned(),
                ),
                Err(error) => (Support::Unknown, error.code().to_owned()),
            };
        capabilities.set(
            Capability::StructuredOutput,
            structured_support,
            Evidence::Probed,
            structured_note,
        );

        self.learn(capabilities.clone());
        Ok(capabilities)
    }

    async fn stream(
        &self,
        request: ChatRequest,
        sink: &mut dyn EventSink,
        context: &RequestContext,
    ) -> ProviderResult<ChatResponse> {
        match self.run(request, true, sink, context).await {
            Ok(response) => {
                sink.emit(StreamEvent::Done {
                    response: Box::new(response.clone()),
                });
                Ok(response)
            }
            Err(error) => {
                sink.emit(StreamEvent::Error {
                    error: error.clone(),
                });
                Err(error)
            }
        }
    }

    async fn complete(
        &self,
        request: ChatRequest,
        context: &RequestContext,
    ) -> ProviderResult<ChatResponse> {
        let mut sink = NullSink;
        self.run(request, false, &mut sink, context).await
    }
}

/// Does this model-list entry serve completions at all? The list also carries
/// embedding and token-counting models, and offering one as a chat model would
/// be offering an affordance the endpoint cannot serve.
fn serves_completions(entry: &Value) -> bool {
    match entry
        .get("supportedGenerationMethods")
        .and_then(Value::as_array)
    {
        Some(methods) => methods
            .iter()
            .filter_map(Value::as_str)
            .any(|method| method == "generateContent" || method == "streamGenerateContent"),
        // The field is absent on some gateways. Absence is not evidence of
        // absence, so the model is kept.
        None => true,
    }
}

/// A 1×1 transparent PNG — the cheapest possible vision probe.
const ONE_PIXEL_PNG: [u8; 67] = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::testing::{CannedResponse, ScriptedTransport};
    use crate::model::{ReasoningRequest, StopReason};
    use crate::provider::Timeouts;
    use vela_core::auth::{AuthMode, AuthPolicy};
    use vela_core::provider::ProviderKind;
    use vela_core::secret::{SecretRef, SecretValue};
    use vela_secrets::MemoryStore;

    fn descriptor() -> ProviderDescriptor {
        ProviderDescriptor::new("test-google", "Test", ProviderKind::RemoteApi).unwrap()
    }

    fn provider(transport: ScriptedTransport) -> (GoogleProvider, Arc<ScriptedTransport>) {
        let transport = Arc::new(transport);
        let provider = GoogleProvider::new(
            descriptor(),
            "https://example.invalid",
            Auth::None,
            Arc::new(MemoryStore::new()),
            transport.clone(),
        );
        (provider, transport)
    }

    fn candidate(parts: Value, finish_reason: &str) -> String {
        json!({
            "candidates": [{
                "content": {"role": "model", "parts": parts},
                "finishReason": finish_reason,
                "index": 0,
            }],
            "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 4,
                              "totalTokenCount": 14},
        })
        .to_string()
    }

    fn text_message(text: &str) -> String {
        candidate(json!([{"text": text}]), "STOP")
    }

    fn error_body(code: u16, status: &str, message: &str) -> String {
        json!({"error": {"code": code, "message": message, "status": status}}).to_string()
    }

    fn sent_body(transport: &ScriptedTransport, index: usize) -> Value {
        serde_json::from_slice(transport.recorded()[index].body.as_ref().unwrap()).unwrap()
    }

    #[tokio::test]
    async fn no_credential_means_no_header_and_no_query_parameter_at_all() {
        let (provider, transport) = provider(ScriptedTransport::ok(&text_message("hi")));
        provider
            .complete(
                ChatRequest::new("gemini-test").with_message(ChatMessage::user("hi")),
                &RequestContext::new(),
            )
            .await
            .unwrap();
        let sent = &transport.recorded()[0];
        assert_eq!(sent.header("x-goog-api-key"), None);
        assert_eq!(
            sent.header("authorization"),
            None,
            "an empty credential header is a 401 everywhere; no header is the correct wire"
        );
        assert_eq!(
            sent.url,
            "https://example.invalid/v1beta/models/gemini-test:generateContent"
        );
        assert!(!sent.url.contains("key="));
    }

    #[tokio::test]
    async fn a_configured_credential_is_sent_as_this_apis_key_header() {
        let secrets = MemoryStore::new();
        let mode = AuthMode::ApiKeyHeader {
            header: "x-goog-api-key".into(),
        };
        let reference = SecretRef::primary("test-google").unwrap();
        secrets
            .set(&reference, &SecretValue::new("AIza-secret"))
            .unwrap();
        let transport = Arc::new(ScriptedTransport::ok(&text_message("hi")));
        let provider = GoogleProvider::new(
            descriptor().with_auth(AuthPolicy::required(mode.clone())),
            "https://example.invalid",
            Auth::for_provider("test-google", &mode).unwrap(),
            Arc::new(secrets),
            transport.clone(),
        );
        provider
            .complete(
                ChatRequest::new("gemini-test").with_message(ChatMessage::user("hi")),
                &RequestContext::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            transport.recorded()[0].header("x-goog-api-key"),
            Some("AIza-secret")
        );
    }

    #[tokio::test]
    async fn a_query_parameter_credential_merges_with_the_streaming_parameter() {
        let secrets = MemoryStore::new();
        let mode = AuthMode::ApiKeyQuery {
            param: "key".into(),
        };
        let reference = SecretRef::primary("test-google").unwrap();
        secrets
            .set(&reference, &SecretValue::new("AIza/secret"))
            .unwrap();
        let transport = Arc::new(ScriptedTransport::new(vec![Ok(CannedResponse::sse(vec![
            &format!("data: {}\n\n", text_message("hi")),
        ]))]));
        let provider = GoogleProvider::new(
            descriptor().with_auth(AuthPolicy::required(mode.clone())),
            "https://example.invalid",
            Auth::for_provider("test-google", &mode).unwrap(),
            Arc::new(secrets),
            transport.clone(),
        );
        let mut sink = CollectingSink::new();
        provider
            .stream(
                ChatRequest::new("gemini-test").with_message(ChatMessage::user("hi")),
                &mut sink,
                &RequestContext::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            transport.recorded()[0].url,
            "https://example.invalid/v1beta/models/gemini-test:streamGenerateContent\
             ?alt=sse&key=AIza%2Fsecret",
            "the key must not overwrite alt=sse, and must be percent-encoded"
        );
    }

    #[tokio::test]
    async fn the_url_gains_a_version_segment_only_when_the_base_lacks_one() {
        for (base, expected) in [
            (
                "https://h/v1beta",
                "https://h/v1beta/models/m:generateContent",
            ),
            ("https://h/v1", "https://h/v1/models/m:generateContent"),
            ("https://h", "https://h/v1beta/models/m:generateContent"),
            ("https://h/", "https://h/v1beta/models/m:generateContent"),
            (
                "https://h/gateway",
                "https://h/gateway/v1beta/models/m:generateContent",
            ),
        ] {
            let transport = Arc::new(ScriptedTransport::ok(&text_message("hi")));
            let provider = GoogleProvider::new(
                descriptor(),
                base,
                Auth::None,
                Arc::new(MemoryStore::new()),
                transport.clone(),
            );
            provider
                .complete(
                    ChatRequest::new("m").with_message(ChatMessage::user("hi")),
                    &RequestContext::new(),
                )
                .await
                .unwrap();
            assert_eq!(transport.recorded()[0].url, expected, "base {base}");
        }
    }

    #[tokio::test]
    async fn a_refused_thinking_config_is_learned_and_the_turn_retried_without_it() {
        let transport = Arc::new(ScriptedTransport::new(vec![
            Ok(CannedResponse::error(
                400,
                &error_body(
                    400,
                    "INVALID_ARGUMENT",
                    "Thinking config is not supported for models/gemini-legacy",
                ),
            )),
            Ok(CannedResponse::ok(&text_message("answered anyway"))),
        ]));
        let provider = GoogleProvider::new(
            descriptor(),
            "https://example.invalid",
            Auth::None,
            Arc::new(MemoryStore::new()),
            transport.clone(),
        );

        let response = provider
            .complete(
                ChatRequest::new("gemini-legacy")
                    .with_message(ChatMessage::user("hi"))
                    .with_reasoning(ReasoningRequest::Enabled {
                        budget_tokens: Some(2_048),
                    }),
                &RequestContext::new(),
            )
            .await
            .expect("a refused thinking config must degrade, not fail the turn");

        assert_eq!(response.answer_text(), "answered anyway");
        assert!(sent_body(&transport, 0)["generationConfig"]
            .get("thinkingConfig")
            .is_some());
        assert!(
            sent_body(&transport, 1)
                .get("generationConfig")
                .and_then(|config| config.get("thinkingConfig"))
                .is_none(),
            "the retry must not carry what the endpoint just refused"
        );
        assert!(response
            .degradations
            .contains(&Degradation::FailedOver { attempts: 2 }));
        assert!(
            provider.known_concessions("gemini-legacy").thinking_config,
            "the refusal is remembered, so the next turn skips the wasted attempt"
        );
    }

    #[tokio::test]
    async fn a_refused_system_instruction_is_retried_with_it_folded_into_the_prompt() {
        let transport = Arc::new(ScriptedTransport::new(vec![
            Ok(CannedResponse::error(
                400,
                &error_body(
                    400,
                    "INVALID_ARGUMENT",
                    "system_instruction is not supported for this model",
                ),
            )),
            Ok(CannedResponse::ok(&text_message("second time lucky"))),
        ]));
        let provider = GoogleProvider::new(
            descriptor(),
            "https://example.invalid",
            Auth::None,
            Arc::new(MemoryStore::new()),
            transport.clone(),
        );
        let response = provider
            .complete(
                ChatRequest::new("gemini-legacy")
                    .with_message(ChatMessage::system("answer in French"))
                    .with_message(ChatMessage::user("hi")),
                &RequestContext::new(),
            )
            .await
            .expect("a refused field must degrade, not fail the turn");

        assert_eq!(response.answer_text(), "second time lucky");
        assert!(sent_body(&transport, 0).get("systemInstruction").is_some());
        let retried = sent_body(&transport, 1);
        assert!(retried.get("systemInstruction").is_none());
        assert!(
            retried.to_string().contains("answer in French"),
            "the instruction must be moved, not dropped: {retried}"
        );
    }

    #[tokio::test]
    async fn a_refusal_with_no_concession_behind_it_is_surfaced_immediately() {
        let (provider, transport) =
            provider(ScriptedTransport::new(vec![Ok(CannedResponse::error(
                400,
                &error_body(
                    400,
                    "INVALID_ARGUMENT",
                    "contents: at least one part is required",
                ),
            ))]));
        let error = provider
            .complete(
                ChatRequest::new("gemini-test").with_message(ChatMessage::user("hi")),
                &RequestContext::new(),
            )
            .await
            .unwrap_err();
        assert!(matches!(error, ProviderError::Transport { .. }));
        assert_eq!(
            transport.recorded().len(),
            1,
            "an error nothing can be conceded to must not be retried"
        );
    }

    #[tokio::test]
    async fn a_blocked_prompt_is_an_error_the_user_can_read_not_a_blank_turn() {
        let (provider, _) = provider(ScriptedTransport::new(vec![Ok(CannedResponse::sse(vec![
            &format!(
                "data: {}\n\n",
                json!({"promptFeedback": {
                    "blockReason": "SAFETY",
                    "safetyRatings": [{"category": "HARM_CATEGORY_HARASSMENT",
                                       "probability": "HIGH", "blocked": true}],
                }})
            ),
        ]))]));
        let mut sink = CollectingSink::new();
        let error = provider
            .stream(
                ChatRequest::new("gemini-test").with_message(ChatMessage::user("...")),
                &mut sink,
                &RequestContext::new(),
            )
            .await
            .expect_err("a refused prompt must not look like an empty answer");
        let rendered = format!("{error}");
        assert!(rendered.contains("safety filter"), "{rendered}");
        assert!(rendered.contains("harassment"), "{rendered}");
        assert!(
            sink.error().is_some() && sink.response().is_none(),
            "the sink is told the turn failed, not handed an empty response"
        );
    }

    #[tokio::test]
    async fn a_structured_answer_that_conforms_is_returned_as_data() {
        let (provider, transport) = provider(ScriptedTransport::ok(&text_message(
            "{\"city\": \"berlin\", \"celsius\": 21}",
        )));
        let response = provider
            .complete(
                ChatRequest::new("gemini-test")
                    .with_message(ChatMessage::user("weather as json"))
                    .with_response_format(ResponseFormat::JsonSchema {
                        name: "weather".into(),
                        schema: json!({
                            "type": "object",
                            "properties": {"city": {"type": "string"},
                                           "celsius": {"type": "number"}},
                            "required": ["city", "celsius"]
                        }),
                    }),
                &RequestContext::new(),
            )
            .await
            .unwrap();

        let generation = sent_body(&transport, 0)["generationConfig"].clone();
        assert_eq!(generation["responseMimeType"], "application/json");
        assert_eq!(generation["responseSchema"]["type"], "OBJECT");
        match response.structured.as_ref().expect("structured requested") {
            Ok(value) => assert_eq!(value["city"], "berlin"),
            Err(mismatch) => panic!("a conforming answer must validate: {mismatch:?}"),
        }
    }

    #[tokio::test]
    async fn structured_output_that_comes_back_as_prose_is_reported_as_a_mismatch() {
        // The MEASURED-5 shape: 200 OK, prose, nothing saying the schema lost.
        let (provider, _) = provider(ScriptedTransport::ok(&text_message(
            "Berlin is about 21 degrees today.",
        )));
        let response = provider
            .complete(
                ChatRequest::new("gemini-test")
                    .with_message(ChatMessage::user("weather as json"))
                    .with_response_format(ResponseFormat::JsonSchema {
                        name: "weather".into(),
                        schema: json!({"type": "object", "required": ["city"]}),
                    }),
                &RequestContext::new(),
            )
            .await
            .unwrap();

        match response.structured.as_ref().expect("structured requested") {
            Ok(value) => panic!("prose must never be presented as conforming JSON: {value}"),
            Err(mismatch) => assert!(mismatch.detail.contains("prose"), "{mismatch:?}"),
        }
        assert!(response
            .degradations
            .iter()
            .any(|d| matches!(d, Degradation::StructuredOutputMismatch { .. })));
        assert_eq!(
            provider.known_capabilities("gemini-test").structured_output,
            Support::Degraded,
            "and it is remembered, so the affordance can be withdrawn"
        );
    }

    #[tokio::test]
    async fn a_structured_request_is_refused_outright_on_a_model_probed_as_ignoring_schemas() {
        let transport = Arc::new(ScriptedTransport::new(vec![]));
        let mut capabilities = ModelCapabilities::unknown("gemini-test");
        capabilities.set(
            Capability::StructuredOutput,
            Support::Degraded,
            Evidence::Probed,
            "returned prose for a schema request",
        );
        let provider = GoogleProvider::new(
            descriptor(),
            "https://example.invalid",
            Auth::None,
            Arc::new(MemoryStore::new()),
            transport.clone(),
        )
        .with_capabilities(capabilities);

        let error = provider
            .complete(
                ChatRequest::new("gemini-test")
                    .with_message(ChatMessage::user("json please"))
                    .with_response_format(ResponseFormat::JsonSchema {
                        name: "n".into(),
                        schema: json!({"type": "object"}),
                    }),
                &RequestContext::new(),
            )
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            ProviderError::CapabilityUnsupported {
                capability: Capability::StructuredOutput,
                ..
            }
        ));
        assert!(transport.recorded().is_empty());
    }

    #[tokio::test]
    async fn a_probed_vision_less_model_refuses_an_image_without_sending_anything() {
        let transport = Arc::new(ScriptedTransport::new(vec![]));
        let mut capabilities = ModelCapabilities::unknown("gemini-test");
        capabilities.set(
            Capability::Vision,
            Support::Unsupported,
            Evidence::Probed,
            "refused inline image bytes",
        );
        let provider = GoogleProvider::new(
            descriptor(),
            "https://example.invalid",
            Auth::None,
            Arc::new(MemoryStore::new()),
            transport.clone(),
        )
        .with_capabilities(capabilities);

        let error = provider
            .complete(
                ChatRequest::new("gemini-test").with_message(ChatMessage::new(
                    MessageRole::User,
                    vec![ContentPart::Image {
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
        assert!(
            transport.recorded().is_empty(),
            "a known-impossible request is refused before it is sent"
        );
    }

    #[tokio::test]
    async fn a_model_with_no_function_calling_gets_the_catalogue_in_the_prompt() {
        let mut capabilities = ModelCapabilities::unknown("gemini-legacy");
        capabilities.set(
            Capability::ToolCalling,
            Support::Unsupported,
            Evidence::Probed,
            "refused a function catalogue",
        );
        let transport = Arc::new(ScriptedTransport::ok(&text_message(
            "I will check.\n<tool_call>{\"name\": \"get_weather\", \
             \"arguments\": {\"city\": \"berlin\"}}</tool_call>",
        )));
        let provider = GoogleProvider::new(
            descriptor(),
            "https://example.invalid",
            Auth::None,
            Arc::new(MemoryStore::new()),
            transport.clone(),
        )
        .with_capabilities(capabilities);

        let response = provider
            .complete(
                ChatRequest::new("gemini-legacy")
                    .with_message(ChatMessage::user("weather in berlin?"))
                    .with_tools([ToolDefinition::new(
                        "get_weather",
                        "Current weather",
                        json!({"type": "object"}),
                    )]),
                &RequestContext::new(),
            )
            .await
            .unwrap();

        let sent = sent_body(&transport, 0);
        assert!(
            sent.get("tools").is_none(),
            "a model that refuses the catalogue must not be sent one: {sent}"
        );
        assert!(sent.to_string().contains("get_weather"), "{sent}");
        assert!(response
            .degradations
            .contains(&Degradation::ToolCallingEmulated { tool_count: 1 }));
        assert_eq!(
            response.tool_calls,
            vec![crate::model::ToolCallOutcome::Ok {
                call_id: "call_emulated_0".into(),
                name: "get_weather".into(),
                arguments: json!({"city": "berlin"}),
                emulated: true,
            }],
            "the call is recovered from the text, and says it was emulated"
        );
        assert!(
            !response.answer_text().contains("tool_call"),
            "the markup must not reach the user: {}",
            response.answer_text()
        );
    }

    #[tokio::test]
    async fn a_tool_catalogue_is_withheld_when_the_caller_asked_for_no_tools() {
        let (provider, transport) = provider(ScriptedTransport::ok(&text_message("hi")));
        let response = provider
            .complete(
                ChatRequest::new("gemini-test")
                    .with_message(ChatMessage::user("hi"))
                    .with_tools([ToolDefinition::new("t", "d", json!({"type": "object"}))])
                    .with_tool_choice(ToolChoice::None),
                &RequestContext::new(),
            )
            .await
            .unwrap();
        assert!(sent_body(&transport, 0).get("tools").is_none());
        assert!(response
            .degradations
            .contains(&Degradation::ToolCatalogueWithheld));
    }

    #[tokio::test]
    async fn prompt_caching_is_learned_from_the_endpoints_own_accounting() {
        let (provider, _) = provider(ScriptedTransport::ok(
            &json!({
                "candidates": [{"content": {"parts": [{"text": "hi"}]},
                                "finishReason": "STOP", "index": 0}],
                "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 2,
                                  "cachedContentTokenCount": 1024},
            })
            .to_string(),
        ));
        assert_eq!(
            provider.known_capabilities("gemini-test").prompt_caching,
            Support::Unknown
        );
        provider
            .complete(
                ChatRequest::new("gemini-test").with_message(ChatMessage::user("hi")),
                &RequestContext::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            provider.known_capabilities("gemini-test").prompt_caching,
            Support::Supported,
            "presence of the accounting is the evidence, not a provider name"
        );
    }

    #[tokio::test]
    async fn a_context_overflow_carries_both_token_counts_to_the_ui() {
        let (provider, _) = provider(ScriptedTransport::new(vec![Ok(CannedResponse::error(
            400,
            &error_body(
                400,
                "INVALID_ARGUMENT",
                "The input token count (1189440) exceeds the maximum number of tokens allowed \
                 (1048575).",
            ),
        ))]));
        let error = provider
            .complete(
                ChatRequest::new("gemini-test").with_message(ChatMessage::user("war and peace")),
                &RequestContext::new(),
            )
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            ProviderError::ContextLengthExceeded {
                limit_tokens: Some(1_048_575),
                requested_tokens: Some(1_189_440),
                ..
            }
        ));
    }

    #[tokio::test]
    async fn a_cancelled_context_stops_before_the_request_is_sent() {
        let (provider, transport) = provider(ScriptedTransport::ok(&text_message("hi")));
        let context = RequestContext::new();
        context.cancel.cancel();
        let error = provider
            .complete(
                ChatRequest::new("gemini-test").with_message(ChatMessage::user("hi")),
                &context,
            )
            .await
            .unwrap_err();
        assert_eq!(error, ProviderError::Cancelled);
        assert!(transport.recorded().is_empty());
    }

    #[tokio::test]
    async fn a_stalled_body_is_abandoned_rather_than_awaited_forever() {
        struct Stalling;
        #[async_trait]
        impl HttpTransport for Stalling {
            async fn send(
                &self,
                _request: HttpRequest,
                _timeouts: &Timeouts,
            ) -> Result<crate::http::HttpResponse, TransportError> {
                Ok(crate::http::HttpResponse {
                    status: 200,
                    headers: vec![("content-type".into(), "text/event-stream".into())],
                    body: crate::http::testing::fake_body(crate::http::testing::StalledBody),
                })
            }
        }
        let provider = GoogleProvider::new(
            descriptor(),
            "https://example.invalid",
            Auth::None,
            Arc::new(MemoryStore::new()),
            Arc::new(Stalling),
        );
        let context = RequestContext::new().with_timeouts(Timeouts {
            stall: std::time::Duration::from_millis(50),
            ..Timeouts::default()
        });
        let mut sink = CollectingSink::new();
        let error = provider
            .stream(
                ChatRequest::new("gemini-test").with_message(ChatMessage::user("hi")),
                &mut sink,
                &context,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(
                error,
                ProviderError::Transport {
                    failure: TransportFailure::Stalled,
                    ..
                }
            ),
            "MEASURED-1: a quiet socket must never wedge the app; got {error:?}"
        );
        assert!(sink.error().is_some(), "the sink is told, not left hanging");
    }

    #[tokio::test]
    async fn the_model_list_reports_the_window_the_endpoint_declares() {
        let (provider, transport) = provider(ScriptedTransport::ok(
            &json!({"models": [
                {"name": "models/gemini-2.5-flash", "displayName": "Gemini 2.5 Flash",
                 "inputTokenLimit": 1048576, "outputTokenLimit": 65536,
                 "supportedGenerationMethods": ["generateContent", "streamGenerateContent"]},
                {"name": "models/text-embedding-004", "displayName": "Embedding",
                 "inputTokenLimit": 2048, "supportedGenerationMethods": ["embedContent"]},
            ]})
            .to_string(),
        ));
        let models = provider.list_models(&RequestContext::new()).await.unwrap();
        assert_eq!(
            models.len(),
            1,
            "a model that cannot complete must not be offered as one"
        );
        assert_eq!(models[0].id, "gemini-2.5-flash");
        assert_eq!(models[0].display_name, "Gemini 2.5 Flash");
        assert_eq!(models[0].context_window, Some(1_048_576));
        assert!(transport.recorded()[0]
            .url
            .ends_with("/models?pageSize=1000"));
    }

    #[tokio::test]
    async fn a_streamed_and_a_non_streamed_turn_agree_on_the_same_answer() {
        let stream_body = format!(
            "data: {}\n\ndata: {}\n\ndata: {}\n\n",
            json!({"candidates": [{"content": {"parts": [{"text": "same "}]}, "index": 0}]}),
            json!({"candidates": [{"content": {"parts": [{"text": "answer"}]}, "index": 0}]}),
            json!({"candidates": [{"content": {"parts": []}, "finishReason": "STOP", "index": 0}],
                   "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 4}}),
        );
        let streaming = Arc::new(ScriptedTransport::new(vec![Ok(CannedResponse::sse(vec![
            &stream_body,
        ]))]));
        let provider = GoogleProvider::new(
            descriptor(),
            "https://example.invalid",
            Auth::None,
            Arc::new(MemoryStore::new()),
            streaming.clone(),
        );
        let mut sink = CollectingSink::new();
        let streamed = provider
            .stream(
                ChatRequest::new("gemini-test").with_message(ChatMessage::user("hi")),
                &mut sink,
                &RequestContext::new(),
            )
            .await
            .unwrap();

        let plain_transport = Arc::new(ScriptedTransport::ok(&text_message("same answer")));
        let plain_provider = GoogleProvider::new(
            descriptor(),
            "https://example.invalid",
            Auth::None,
            Arc::new(MemoryStore::new()),
            plain_transport,
        );
        let plain = plain_provider
            .complete(
                ChatRequest::new("gemini-test").with_message(ChatMessage::user("hi")),
                &RequestContext::new(),
            )
            .await
            .unwrap();

        assert_eq!(streamed.answer_text(), plain.answer_text());
        assert_eq!(streamed.stop_reason, StopReason::EndTurn);
        assert_eq!(streamed.stop_reason, plain.stop_reason);
        assert_eq!(sink.text(), "same answer");
        assert!(matches!(sink.events.last(), Some(StreamEvent::Done { .. })));
        assert!(
            streaming.recorded()[0].url.contains("alt=sse"),
            "without alt=sse this API answers a stream request with a JSON array"
        );
    }

    #[test]
    fn a_base_url_that_already_pins_a_version_is_left_alone() {
        assert!(has_version_segment("https://h/v1"));
        assert!(has_version_segment("https://h/v1beta"));
        assert!(has_version_segment("https://h/v1alpha"));
        assert!(!has_version_segment("https://h"));
        assert!(!has_version_segment("https://h/vertex"));
        assert!(!has_version_segment("https://h/gateway"));
    }
}
