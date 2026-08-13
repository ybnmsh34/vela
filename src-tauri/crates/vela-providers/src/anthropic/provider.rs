//! The Anthropic provider: `POST /v1/messages`, and every degradation path
//! made explicit.
//!
//! # The order of operations in a turn, and why
//!
//! 1. **Refuse what cannot work** — an image to a model probed as vision-less,
//!    tools to one that has refused them, structured output to one probed as
//!    ignoring it. Refusing costs nothing and is truthful; sending it produces
//!    a 400 at best and silent prose at worst.
//! 2. **Fit the context** — explicitly, with a note in the prompt
//!    (`crate::context`). Never a silent truncation. This API reports no
//!    context window, so this only happens when the caller supplied one.
//! 3. **Send, and learn from the refusal.** A model that rejects a thinking
//!    mode, a beta header, or the reasoning blocks in the history has just told
//!    Vela something true. Each is recorded as a [`Concession`], the turn is
//!    retried in the shape the endpoint will accept, and the retry is reported.
//! 4. **Normalise the answer** — end-of-body terminates, bad frames are
//!    skipped, thinking blocks keep their signatures, tool calls accumulate
//!    defensively. See [`super::stream`].
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
    SchemaMismatch, ToolChoice, ToolDefinition,
};
use crate::provider::{ModelInfo, Provider, RequestContext};
use crate::structured::{self, StructuredOutputPolicy};

use super::stream::{AssembledMessage, MessageAssembler};
use super::wire::{self, Concessions};
use super::{concession_for, map_error_response, Concession, MAX_ERROR_BODY_BYTES};

/// The public endpoint. A user may point the adapter anywhere — a proxy, a
/// gateway, a self-hosted relay — so this is a default, never a constraint.
pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";

/// Cap on a non-streaming response body. Bounds what a broken endpoint can make
/// Vela allocate; far above any real completion.
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// One original attempt plus at most two concessions. Bounded so a refusal that
/// keeps arriving cannot become a retry loop against someone's paid endpoint.
const MAX_ATTEMPTS: u32 = 3;

/// Behaviour knobs an adapter builder sets once, at construction.
pub struct AnthropicOptions {
    pub structured_output: StructuredOutputPolicy,
    /// Send the interleaved-thinking beta header when manual thinking is
    /// combined with tools (spec THK-6). Withdrawn automatically if refused.
    pub interleaved_thinking: bool,
    /// The `anthropic-version` this adapter pins. Configurable because a
    /// self-hosted relay may serve an older one; defaulted so no caller has to
    /// know the value exists.
    pub api_version: String,
    /// How dropped history is replaced when the window is too small.
    pub summariser: Arc<dyn ConversationSummariser>,
}

impl Default for AnthropicOptions {
    fn default() -> Self {
        Self {
            structured_output: StructuredOutputPolicy::default(),
            interleaved_thinking: true,
            api_version: wire::ANTHROPIC_VERSION.to_owned(),
            summariser: Arc::new(ElisionNote),
        }
    }
}

impl std::fmt::Debug for AnthropicOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AnthropicOptions")
            .field("structured_output", &self.structured_output)
            .field("interleaved_thinking", &self.interleaved_thinking)
            .field("api_version", &self.api_version)
            .finish_non_exhaustive()
    }
}

pub struct AnthropicProvider {
    descriptor: ProviderDescriptor,
    base_url: String,
    auth: Auth,
    secrets: Arc<dyn SecretStore>,
    transport: Arc<dyn HttpTransport>,
    options: AnthropicOptions,
    /// What probing (or a refusal) has taught us, per model id.
    learned: Mutex<HashMap<String, ModelCapabilities>>,
    /// Request-shape reductions a model has already demanded, per model id, so
    /// the wasted first attempt happens once rather than every turn.
    concessions: Mutex<HashMap<String, Concessions>>,
}

impl AnthropicProvider {
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
            options: AnthropicOptions::default(),
            learned: Mutex::new(HashMap::new()),
            concessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn with_options(mut self, options: AnthropicOptions) -> Self {
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

    /// Reductions this model has already demanded.
    ///
    /// Only the two that are properties of the *model* are remembered.
    /// `prior_reasoning` is a property of one conversation's history and is
    /// deliberately not sticky: carrying it forward would silently stop sending
    /// reasoning that a later, valid history could have carried.
    pub fn known_concessions(&self, model_id: &str) -> Concessions {
        self.concessions
            .lock()
            .expect("concession cache poisoned")
            .get(model_id)
            .copied()
            .unwrap_or_default()
    }

    fn remember(&self, model_id: &str, concession: Concession) {
        if matches!(concession, Concession::PriorReasoning) {
            return;
        }
        let mut cache = self.concessions.lock().expect("concession cache poisoned");
        let entry = cache.entry(model_id.to_owned()).or_default();
        apply_concession(entry, concession);
    }

    /// `<base>/v1/<path>`, inserting `/v1` only when the user's base URL does
    /// not already have it. Both forms are common when a gateway sits in front.
    fn api_url(&self, path: &str) -> String {
        if self.base_url.ends_with("/v1") {
            format!("{}/{path}", self.base_url)
        } else {
            format!("{}/v1/{path}", self.base_url)
        }
    }

    /// Everything every request carries, credential included.
    ///
    /// **The whole point of the credential half is what it does with no
    /// credential: nothing.** `Auth::None` never reaches the keychain and never
    /// produces a header — not even an empty one, which endpoints answer with a
    /// 401 that then gets misreported as "bad API key".
    fn prepare_http(
        &self,
        mut request: HttpRequest,
        betas: &[&str],
    ) -> ProviderResult<HttpRequest> {
        request = request.with_header("anthropic-version", self.options.api_version.clone());
        if !betas.is_empty() {
            request = request.with_header("anthropic-beta", betas.join(","));
        }
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
        // The query-parameter shape is not one this API uses, but the binding is
        // the user's to configure and dropping it silently would be worse than
        // honouring it. `with_auth` handles all three shapes.
        Ok(request.with_auth(&applied))
    }

    async fn get_json(&self, url: String, context: &RequestContext) -> ProviderResult<Value> {
        let request = self.prepare_http(HttpRequest::get(url), &[])?;
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
        if request.offers_tools() && capabilities.tool_calling == Support::Unsupported {
            // This backend has native tool calling on every model that serves
            // it, so a probed refusal means the affordance genuinely is not
            // there. Refusing is truthful; rewriting the request into prompt
            // emulation behind the user's back would not be.
            return Err(ProviderError::unsupported(
                Capability::ToolCalling,
                "this model was probed and does not accept a tool catalogue",
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

        if !request.tools.is_empty() && request.tool_choice == ToolChoice::None {
            // The catalogue is withheld rather than sent alongside a "no tools"
            // hint — the same rule GATE M FINDING 6 forced on the other adapter,
            // kept identical here so one behaviour holds across backends.
            let (rewritten, tool_degradations) = emulation::emulate(request);
            request = rewritten;
            degradations.extend(tool_degradations);
        }

        Ok(Prepared {
            request,
            schema,
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
    ) -> Result<AssembledMessage, Refusal> {
        let encoded = wire::encode_request(
            &prepared.request,
            streaming,
            concessions,
            self.options.interleaved_thinking,
        );
        let bytes = serde_json::to_vec(&encoded.body).map_err(|error| {
            ProviderError::malformed(format!("could not encode request: {error}"))
        })?;
        let request = self.prepare_http(
            HttpRequest::post_json(self.api_url("messages"), bytes).with_header(
                "accept",
                if streaming {
                    "text/event-stream"
                } else {
                    "application/json"
                },
            ),
            &encoded.betas,
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

        let mut assembler = MessageAssembler::new(streaming);
        if encoded.schema_tool {
            assembler = assembler.with_schema_tool(wire::SCHEMA_TOOL_NAME);
        }

        if streaming {
            // Mirrors `crate::stream::drive_stream`, which is typed to the
            // OpenAI-shaped assembler and so cannot be called with this one:
            // end-of-body is the terminator, every read is bounded by the stall
            // timeout, and cancellation abandons a read in flight (MEASURED-1).
            let mut body = response.body;
            // The body knows what request it answers; the assembler is what
            // decodes. Joining them here is what stops the second redaction
            // barrier being something an adapter has to remember.
            let mut assembler = assembler.with_scrubber(body.origin().scrubber().clone());
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
                    // End of body. The one reliable terminator.
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
            assembler.apply_message(&value, sink);
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

        let AssembledMessage {
            mut response,
            schema_tool_input,
            schema_tool_raw,
            cache_accounting_reported,
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
                "the endpoint reported cache accounting in usage",
            );
        }

        if let Some(schema) = &prepared.schema {
            // MEASURED-5: the endpoint will not tell us the schema was ignored,
            // so the answer is checked against what was asked for — whichever
            // channel it came back through.
            let checked = match (schema_tool_input, schema_tool_raw) {
                (Some(value), _) => structured::validate(schema, &value).map(|()| value),
                (None, Some(raw)) => Err(SchemaMismatch {
                    path: String::new(),
                    detail: detail(format!(
                        "the model's structured answer was not usable JSON: {raw}"
                    )),
                }),
                (None, None) => structured::check_answer(schema, &response.answer_text()),
            };
            match checked {
                Ok(value) => {
                    if response.answer_text().is_empty() {
                        // The answer came back through the tool channel. Putting
                        // it in the transcript keeps the turn readable and keeps
                        // `answer_text()` honest about what the model produced.
                        response.parts.push(ContentPart::text(compact(&value)));
                    }
                    response.structured = Some(Ok(value));
                }
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
    ) -> ProviderResult<AssembledMessage> {
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
        Concession::PriorReasoning => concessions.prior_reasoning = true,
        Concession::InterleavedBeta => concessions.interleaved_beta = true,
    }
}

fn already_applied(concessions: Concessions, concession: Concession) -> bool {
    match concession {
        Concession::ThinkingConfig => concessions.thinking_config,
        Concession::PriorReasoning => concessions.prior_reasoning,
        Concession::InterleavedBeta => concessions.interleaved_beta,
    }
}

fn compact(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

#[async_trait]
impl Provider for AnthropicProvider {
    fn descriptor(&self) -> &ProviderDescriptor {
        &self.descriptor
    }

    async fn list_models(&self, context: &RequestContext) -> ProviderResult<Vec<ModelInfo>> {
        let value = self.get_json(self.api_url("models"), context).await?;
        let data = value
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::malformed("model list had no `data` array"))?;
        Ok(data
            .iter()
            .filter_map(|entry| {
                let id = entry.get("id").and_then(Value::as_str)?;
                Some(ModelInfo {
                    id: id.to_owned(),
                    display_name: entry
                        .get("display_name")
                        .and_then(Value::as_str)
                        .unwrap_or(id)
                        .to_owned(),
                    // This API does not report a context window. `None` is the
                    // honest answer; a guess here would drive context planning
                    // against a number nobody supplied.
                    context_window: None,
                })
            })
            .collect())
    }

    /// Establish what this model can do by asking it — five small requests.
    ///
    /// Each probe is `max_tokens`-bounded and every conclusion records how it
    /// was reached ([`Evidence`]), so a capability report can never claim a
    /// probe happened when a default was used.
    async fn probe_capabilities(
        &self,
        model_id: &str,
        context: &RequestContext,
    ) -> ProviderResult<ModelCapabilities> {
        let mut capabilities = ModelCapabilities::unknown(model_id);

        // 1. Model listing.
        match self.list_models(context).await {
            Ok(models) => capabilities.set(
                Capability::ModelListing,
                Support::Supported,
                Evidence::Probed,
                format!("{} model(s) listed", models.len()),
            ),
            Err(error) => capabilities.set(
                Capability::ModelListing,
                Support::Unsupported,
                Evidence::Probed,
                error.code(),
            ),
        };

        // 2. A plain streamed turn: streaming, usage, reasoning, and — because
        //    the request carries a cache breakpoint — prompt caching.
        let plain = ChatRequest::new(model_id)
            .with_message(ChatMessage::system(
                "You are a helpful assistant answering a connection test.",
            ))
            .with_message(ChatMessage::user("Say OK."))
            .with_cache_hints(crate::model::CacheHints {
                cache_system_prompt: true,
                cache_conversation_prefix: false,
            })
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
                    "cache accounting in the usage of a turn carrying a breakpoint",
                );
                if !assembled.response.reasoning_text().is_empty() {
                    capabilities.set(
                        Capability::Reasoning,
                        Support::Supported,
                        Evidence::Probed,
                        "emitted a reasoning block",
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
                    "returned a well-formed tool call".to_owned(),
                )
            }
            // Calls arrive, but broken. The affordance survives because every
            // failure is surfaced explicitly (MEASURED-4).
            Ok(assembled) if !assembled.response.tool_calls.is_empty() => (
                Support::Degraded,
                "returned tool calls that could not be parsed".to_owned(),
            ),
            Ok(_) => (
                Support::Unsupported,
                "accepted a forced tool call and produced none".to_owned(),
            ),
            Err(ProviderError::CapabilityUnsupported { .. }) => (
                Support::Unsupported,
                "refused a request carrying a tool catalogue".to_owned(),
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
            Ok(_) => (Support::Supported, "accepted an image block".to_owned()),
            Err(ProviderError::CapabilityUnsupported { .. }) => {
                (Support::Unsupported, "refused an image block".to_owned())
            }
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
        let (structured_support, structured_note) = match self
            .probe_send(structured_probe, context)
            .await
        {
            Ok(assembled) => {
                let checked = match assembled.schema_tool_input {
                    Some(value) => structured::validate(&schema, &value).map(|()| value),
                    None => structured::check_answer(&schema, &assembled.response.answer_text()),
                };
                match checked {
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
        ProviderDescriptor::new("test-anthropic", "Test", ProviderKind::RemoteApi).unwrap()
    }

    fn provider(transport: ScriptedTransport) -> (AnthropicProvider, Arc<ScriptedTransport>) {
        let transport = Arc::new(transport);
        let provider = AnthropicProvider::new(
            descriptor(),
            "https://example.invalid",
            Auth::None,
            Arc::new(MemoryStore::new()),
            transport.clone(),
        );
        (provider, transport)
    }

    fn message(content: Value, stop_reason: &str) -> String {
        json!({
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "model": "claude-test",
            "content": content,
            "stop_reason": stop_reason,
            "usage": {"input_tokens": 10, "output_tokens": 4},
        })
        .to_string()
    }

    fn text_message(text: &str) -> String {
        message(json!([{"type": "text", "text": text}]), "end_turn")
    }

    fn error_body(kind: &str, text: &str) -> String {
        json!({"type": "error", "error": {"type": kind, "message": text}}).to_string()
    }

    fn sent_body(transport: &ScriptedTransport, index: usize) -> Value {
        serde_json::from_slice(transport.recorded()[index].body.as_ref().unwrap()).unwrap()
    }

    #[tokio::test]
    async fn no_credential_means_no_auth_header_at_all_but_still_a_version_header() {
        let (provider, transport) = provider(ScriptedTransport::ok(&text_message("hi")));
        provider
            .complete(
                ChatRequest::new("claude-test").with_message(ChatMessage::user("hi")),
                &RequestContext::new(),
            )
            .await
            .unwrap();
        let sent = &transport.recorded()[0];
        assert_eq!(sent.header("x-api-key"), None);
        assert_eq!(
            sent.header("authorization"),
            None,
            "an empty credential header is a 401 everywhere; no header is the correct wire"
        );
        assert_eq!(
            sent.header("anthropic-version"),
            Some(wire::ANTHROPIC_VERSION)
        );
        assert_eq!(sent.url, "https://example.invalid/v1/messages");
    }

    #[tokio::test]
    async fn a_configured_credential_is_sent_as_the_api_key_header() {
        let secrets = MemoryStore::new();
        let mode = AuthMode::ApiKeyHeader {
            header: "x-api-key".into(),
        };
        let reference = SecretRef::primary("test-anthropic").unwrap();
        secrets
            .set(&reference, &SecretValue::new("sk-ant-secret"))
            .unwrap();
        let transport = Arc::new(ScriptedTransport::ok(&text_message("hi")));
        let provider = AnthropicProvider::new(
            descriptor().with_auth(AuthPolicy::required(mode.clone())),
            "https://example.invalid",
            Auth::for_provider("test-anthropic", &mode).unwrap(),
            Arc::new(secrets),
            transport.clone(),
        );
        provider
            .complete(
                ChatRequest::new("claude-test").with_message(ChatMessage::user("hi")),
                &RequestContext::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            transport.recorded()[0].header("x-api-key"),
            Some("sk-ant-secret")
        );
    }

    #[tokio::test]
    async fn the_url_gains_a_v1_prefix_only_when_the_base_lacks_one() {
        for (base, expected) in [
            ("https://h/v1", "https://h/v1/messages"),
            ("https://h", "https://h/v1/messages"),
            ("https://h/", "https://h/v1/messages"),
        ] {
            let transport = Arc::new(ScriptedTransport::ok(&text_message("hi")));
            let provider = AnthropicProvider::new(
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
            assert_eq!(transport.recorded()[0].url, expected);
        }
    }

    #[tokio::test]
    async fn a_refused_thinking_mode_is_learned_and_the_turn_retried_without_it() {
        let transport = Arc::new(ScriptedTransport::new(vec![
            Ok(CannedResponse::error(
                400,
                &error_body(
                    "invalid_request_error",
                    "\"thinking.type.enabled\" is not supported for this model. Use \
                     \"thinking.type.adaptive\" and \"output_config.effort\" instead.",
                ),
            )),
            Ok(CannedResponse::ok(&text_message("answered anyway"))),
        ]));
        let provider = AnthropicProvider::new(
            descriptor(),
            "https://example.invalid",
            Auth::None,
            Arc::new(MemoryStore::new()),
            transport.clone(),
        );

        let response = provider
            .complete(
                ChatRequest::new("claude-test")
                    .with_message(ChatMessage::user("hi"))
                    .with_reasoning(ReasoningRequest::Enabled {
                        budget_tokens: Some(2_048),
                    }),
                &RequestContext::new(),
            )
            .await
            .expect("a refused thinking mode must degrade, not fail the turn");

        assert_eq!(response.answer_text(), "answered anyway");
        assert!(sent_body(&transport, 0).get("thinking").is_some());
        assert!(
            sent_body(&transport, 1).get("thinking").is_none(),
            "the retry must not carry what the endpoint just refused"
        );
        assert!(response
            .degradations
            .contains(&Degradation::FailedOver { attempts: 2 }));
        assert!(
            provider.known_concessions("claude-test").thinking_config,
            "the refusal is remembered, so the next turn skips the wasted attempt"
        );
    }

    #[tokio::test]
    async fn a_refused_thinking_history_is_retried_without_the_prior_reasoning() {
        let transport = Arc::new(ScriptedTransport::new(vec![
            Ok(CannedResponse::error(
                400,
                &error_body(
                    "invalid_request_error",
                    "`thinking` or `redacted_thinking` blocks in the latest assistant message \
                     cannot be modified",
                ),
            )),
            Ok(CannedResponse::ok(&text_message("second time lucky"))),
        ]));
        let provider = AnthropicProvider::new(
            descriptor(),
            "https://example.invalid",
            Auth::None,
            Arc::new(MemoryStore::new()),
            transport.clone(),
        );

        let response = provider
            .complete(
                ChatRequest::new("claude-test")
                    .with_message(ChatMessage::user("hi"))
                    .with_message(ChatMessage::new(
                        MessageRole::Assistant,
                        vec![
                            ContentPart::Reasoning {
                                text: "prior deliberation".into(),
                                signature: Some("sig".into()),
                                redacted: false,
                            },
                            ContentPart::text("earlier answer"),
                        ],
                    ))
                    .with_message(ChatMessage::user("and again")),
                &RequestContext::new(),
            )
            .await
            .expect("an incompatible history must degrade, not error");

        assert_eq!(response.answer_text(), "second time lucky");
        assert!(sent_body(&transport, 0)
            .to_string()
            .contains("prior deliberation"));
        assert!(
            !sent_body(&transport, 1)
                .to_string()
                .contains("prior deliberation"),
            "the reasoning the endpoint refused must not be replayed"
        );
        assert!(
            !provider.known_concessions("claude-test").prior_reasoning,
            "a history problem is not a property of the model, so it is not remembered"
        );
    }

    #[tokio::test]
    async fn a_refusal_with_no_concession_behind_it_is_surfaced_immediately() {
        let (provider, transport) =
            provider(ScriptedTransport::new(vec![Ok(CannedResponse::error(
                400,
                &error_body(
                    "invalid_request_error",
                    "messages: at least one is required",
                ),
            ))]));
        let error = provider
            .complete(
                ChatRequest::new("claude-test").with_message(ChatMessage::user("hi")),
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
    async fn a_structured_answer_that_conforms_is_returned_as_data() {
        let (provider, transport) = provider(ScriptedTransport::ok(&message(
            json!([{"type": "tool_use", "id": "toolu_1", "name": "vela_structured_output",
                    "input": {"city": "berlin", "celsius": 21}}]),
            "tool_use",
        )));
        let response = provider
            .complete(
                ChatRequest::new("claude-test")
                    .with_message(ChatMessage::user("weather as json"))
                    .with_response_format(ResponseFormat::JsonSchema {
                        name: "weather".into(),
                        schema: json!({
                            "type": "object",
                            "properties": {"city": {"type": "string"}, "celsius": {"type": "number"}},
                            "required": ["city", "celsius"]
                        }),
                    }),
                &RequestContext::new(),
            )
            .await
            .unwrap();

        assert_eq!(
            sent_body(&transport, 0)["tool_choice"]["name"],
            "vela_structured_output"
        );
        match response.structured.as_ref().expect("structured requested") {
            Ok(value) => assert_eq!(value["city"], "berlin"),
            Err(mismatch) => panic!("a conforming answer must validate: {mismatch:?}"),
        }
        assert!(
            response.tool_calls.is_empty(),
            "Vela's internal tool must never reach the caller as a tool call"
        );
        assert_eq!(
            response.answer_text(),
            "{\"celsius\":21,\"city\":\"berlin\"}",
            "the answer is put in the transcript so the turn is not blank"
        );
    }

    #[tokio::test]
    async fn structured_output_that_comes_back_as_prose_is_reported_as_a_mismatch() {
        // The MEASURED-5 shape: 200 OK, prose, nothing saying the schema lost.
        let (provider, _) = provider(ScriptedTransport::ok(&text_message(
            "Berlin is about 21 degrees today.",
        )));
        let response = provider
            .complete(
                ChatRequest::new("claude-test")
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
            provider.known_capabilities("claude-test").structured_output,
            Support::Degraded,
            "and it is remembered, so the affordance can be withdrawn"
        );
    }

    #[tokio::test]
    async fn a_structured_request_is_refused_outright_on_a_model_probed_as_ignoring_schemas() {
        let transport = Arc::new(ScriptedTransport::new(vec![]));
        let mut capabilities = ModelCapabilities::unknown("claude-test");
        capabilities.set(
            Capability::StructuredOutput,
            Support::Degraded,
            Evidence::Probed,
            "returned prose for a schema request",
        );
        let provider = AnthropicProvider::new(
            descriptor(),
            "https://example.invalid",
            Auth::None,
            Arc::new(MemoryStore::new()),
            transport.clone(),
        )
        .with_capabilities(capabilities);

        let error = provider
            .complete(
                ChatRequest::new("claude-test")
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
        let mut capabilities = ModelCapabilities::unknown("claude-test");
        capabilities.set(
            Capability::Vision,
            Support::Unsupported,
            Evidence::Probed,
            "refused an image block",
        );
        let provider = AnthropicProvider::new(
            descriptor(),
            "https://example.invalid",
            Auth::None,
            Arc::new(MemoryStore::new()),
            transport.clone(),
        )
        .with_capabilities(capabilities);

        let error = provider
            .complete(
                ChatRequest::new("claude-test").with_message(ChatMessage::new(
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
    async fn a_tool_catalogue_is_withheld_when_the_caller_asked_for_no_tools() {
        let (provider, transport) = provider(ScriptedTransport::ok(&text_message("hi")));
        let response = provider
            .complete(
                ChatRequest::new("claude-test")
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
                "id": "msg_1", "role": "assistant",
                "content": [{"type": "text", "text": "hi"}],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 10, "output_tokens": 2,
                          "cache_creation_input_tokens": 1024, "cache_read_input_tokens": 0},
            })
            .to_string(),
        ));
        assert_eq!(
            provider.known_capabilities("claude-test").prompt_caching,
            Support::Unknown
        );
        provider
            .complete(
                ChatRequest::new("claude-test")
                    .with_message(ChatMessage::user("hi"))
                    .with_cache_hints(crate::model::CacheHints {
                        cache_system_prompt: true,
                        cache_conversation_prefix: false,
                    }),
                &RequestContext::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            provider.known_capabilities("claude-test").prompt_caching,
            Support::Supported,
            "presence of the accounting is the evidence, not a provider name"
        );
    }

    #[tokio::test]
    async fn a_context_overflow_carries_both_token_counts_to_the_ui() {
        let (provider, _) = provider(ScriptedTransport::new(vec![Ok(CannedResponse::error(
            400,
            &error_body(
                "invalid_request_error",
                "prompt is too long: 205809 tokens > 200000 maximum",
            ),
        ))]));
        let error = provider
            .complete(
                ChatRequest::new("claude-test").with_message(ChatMessage::user("war and peace")),
                &RequestContext::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(
            error,
            ProviderError::ContextLengthExceeded {
                limit_tokens: Some(200_000),
                requested_tokens: Some(205_809),
                detail: detail("prompt is too long: 205809 tokens > 200000 maximum"),
            }
        );
    }

    #[tokio::test]
    async fn a_cancelled_context_stops_before_the_request_is_sent() {
        let (provider, transport) = provider(ScriptedTransport::ok(&text_message("hi")));
        let context = RequestContext::new();
        context.cancel.cancel();
        let error = provider
            .complete(
                ChatRequest::new("claude-test").with_message(ChatMessage::user("hi")),
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
        let provider = AnthropicProvider::new(
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
                ChatRequest::new("claude-test").with_message(ChatMessage::user("hi")),
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
    async fn the_model_list_reports_no_context_window_because_the_api_does_not() {
        let (provider, _) = provider(ScriptedTransport::ok(
            &json!({"data": [{"type": "model", "id": "claude-test",
                              "display_name": "Claude Test"}]})
            .to_string(),
        ));
        let models = provider.list_models(&RequestContext::new()).await.unwrap();
        assert_eq!(models[0].id, "claude-test");
        assert_eq!(models[0].display_name, "Claude Test");
        assert_eq!(
            models[0].context_window, None,
            "a number nobody sent must never be invented"
        );
    }

    #[tokio::test]
    async fn a_streamed_and_a_non_streamed_turn_agree_on_the_same_answer() {
        let stream_body = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":1}}}\n\n\
             event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n\
             event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"same \"}}\n\n\
             event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"answer\"}}\n\n\
             event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n\
             event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":4}}\n\n\
             event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
        let streaming = Arc::new(ScriptedTransport::new(vec![Ok(CannedResponse::sse(vec![
            stream_body,
        ]))]));
        let provider = AnthropicProvider::new(
            descriptor(),
            "https://example.invalid",
            Auth::None,
            Arc::new(MemoryStore::new()),
            streaming.clone(),
        );
        let mut sink = CollectingSink::new();
        let streamed = provider
            .stream(
                ChatRequest::new("claude-test").with_message(ChatMessage::user("hi")),
                &mut sink,
                &RequestContext::new(),
            )
            .await
            .unwrap();

        let plain_transport = Arc::new(ScriptedTransport::ok(&text_message("same answer")));
        let plain_provider = AnthropicProvider::new(
            descriptor(),
            "https://example.invalid",
            Auth::None,
            Arc::new(MemoryStore::new()),
            plain_transport,
        );
        let plain = plain_provider
            .complete(
                ChatRequest::new("claude-test").with_message(ChatMessage::user("hi")),
                &RequestContext::new(),
            )
            .await
            .unwrap();

        assert_eq!(streamed.answer_text(), plain.answer_text());
        assert_eq!(streamed.stop_reason, StopReason::EndTurn);
        assert_eq!(streamed.stop_reason, plain.stop_reason);
        assert_eq!(sink.text(), "same answer");
        assert!(matches!(sink.events.last(), Some(StreamEvent::Done { .. })));
        assert_eq!(
            sent_body(&streaming, 0)["stream"],
            true,
            "the streamed attempt asked for a stream"
        );
    }
}
