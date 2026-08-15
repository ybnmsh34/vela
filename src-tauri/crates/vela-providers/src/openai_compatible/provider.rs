//! The OpenAI-compatible provider: one implementation, four wildly different
//! endpoints, and every degradation path made explicit.
//!
//! # The order of operations in a turn, and why
//!
//! 1. **Refuse what cannot work** — an image to a model probed as vision-less,
//!    or structured output to one probed as ignoring it. Refusing costs nothing
//!    and is truthful; sending it produces a 400 at best and silent prose at
//!    worst.
//! 2. **Fit the context** — explicitly, with a note in the prompt
//!    (`crate::context`). Never a silent truncation.
//! 3. **Decide how tools are offered** — natively, emulated in the prompt, or
//!    withheld (`crate::emulation`).
//! 4. **Send, and learn from the refusal.** An endpoint that answers `400
//!    tools_not_supported` has just told Vela something true about itself: it
//!    is recorded, and the turn is retried with emulation rather than failed.
//! 5. **Normalise the answer** — end-of-body terminates, bad frames are
//!    skipped, reasoning is separated, tool calls are accumulated defensively.
//! 6. **Check what was promised** — a structured answer is validated against
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
use crate::diagnostic::{Cause, ConfiguredModelId, Diagnosis};
use crate::emulation;
use crate::error::{Capability, ProviderError, ProviderResult};
use crate::event::EventSink;
use crate::http::{HttpRequest, HttpTransport};
use crate::model::{
    ChatMessage, ChatRequest, ChatResponse, Degradation, ResponseFormat, StopReason, ToolChoice,
};
use crate::provider::{ModelInfo, Provider, RequestContext};
use crate::stream::{drive_stream, CompletionAssembler};
use crate::structured::{self, StructuredOutputPolicy};

use super::{map_error_response, wire, MAX_ERROR_BODY_BYTES};

/// Behaviour knobs an adapter builder sets once, at construction.
pub struct ProviderOptions {
    pub structured_output: StructuredOutputPolicy,
    /// Offer tools through the prompt when the endpoint has no native support.
    /// On by default: without it, most local runtimes cannot use tools at all.
    pub emulate_tools: bool,
    /// Send `stream_options.include_usage`. Asking is free; MEASURED-1 says it
    /// is never evidence that usage will arrive.
    pub request_usage: bool,
    /// How dropped history is replaced when the window is too small.
    pub summariser: Arc<dyn ConversationSummariser>,
}

impl Default for ProviderOptions {
    fn default() -> Self {
        Self {
            structured_output: StructuredOutputPolicy::default(),
            emulate_tools: true,
            request_usage: true,
            summariser: Arc::new(ElisionNote),
        }
    }
}

impl std::fmt::Debug for ProviderOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderOptions")
            .field("structured_output", &self.structured_output)
            .field("emulate_tools", &self.emulate_tools)
            .field("request_usage", &self.request_usage)
            .finish_non_exhaustive()
    }
}

pub struct OpenAiCompatibleProvider {
    descriptor: ProviderDescriptor,
    /// Base URL as the user configured it, e.g. `http://127.0.0.1:8033/v1`.
    base_url: String,
    auth: Auth,
    secrets: Arc<dyn SecretStore>,
    transport: Arc<dyn HttpTransport>,
    options: ProviderOptions,
    /// What probing (or a refusal) has taught us, per model id.
    learned: Mutex<HashMap<String, ModelCapabilities>>,
}

impl OpenAiCompatibleProvider {
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
            options: ProviderOptions::default(),
            learned: Mutex::new(HashMap::new()),
        }
    }

    pub fn with_options(mut self, options: ProviderOptions) -> Self {
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

    /// `<base>/chat/completions`, inserting `/v1` only when the user's base URL
    /// does not already have it. Both forms are common in the wild and llama.cpp
    /// serves both.
    fn api_url(&self, path: &str) -> String {
        if self.base_url.ends_with("/v1") {
            format!("{}/{path}", self.base_url)
        } else {
            format!("{}/v1/{path}", self.base_url)
        }
    }

    /// Scheme and authority only — llama.cpp serves `/props` and `/health` at
    /// the root, not under the API prefix.
    fn origin(&self) -> String {
        match self.base_url.find("://") {
            Some(at) => match self.base_url[at + 3..].find('/') {
                Some(slash) => self.base_url[..at + 3 + slash].to_owned(),
                None => self.base_url.clone(),
            },
            None => self.base_url.clone(),
        }
    }

    /// Apply the configured credential.
    ///
    /// **The whole point of this function is what it does with no credential:
    /// nothing.** `Auth::None` never reaches the keychain and never produces a
    /// header — not even an empty one, which the harness answers with a 401
    /// `empty_authorization_header` precisely to make that bug loud.
    fn authenticate(&self, request: HttpRequest) -> ProviderResult<HttpRequest> {
        let applied = match resolve_auth(self.secrets.as_ref(), &self.auth) {
            Ok(applied) => applied,
            // `SecretError`'s own `Display` is not carried: it is Vela's text
            // today, but it is text, and the whole point of the redesign is that
            // an error's contents are a closed set rather than whatever a
            // `Display` impl somewhere feels like producing.
            Err(SecretError::NotFound { .. }) => {
                return Err(ProviderError::auth_failed(Diagnosis::local(
                    Cause::CredentialMissing,
                )))
            }
            Err(SecretError::Unavailable { .. }) => {
                return Err(ProviderError::auth_failed(Diagnosis::local(
                    Cause::CredentialStoreUnreadable,
                )))
            }
            Err(_) => {
                return Err(ProviderError::auth_failed(Diagnosis::local(
                    Cause::CredentialStoreFailed,
                )))
            }
        };
        Ok(request.with_auth(&applied))
    }

    async fn get_json(&self, url: String, context: &RequestContext) -> ProviderResult<Value> {
        let request = self.authenticate(HttpRequest::get(url))?;
        let mut response = self.transport.send(request, &context.timeouts).await?;
        let body = response.read_to_end(MAX_ERROR_BODY_BYTES).await?;
        if response.status != 200 {
            return Err(map_error_response(
                response.status,
                &body,
                &ConfiguredModelId::unknown(),
                response.header("retry-after"),
            ));
        }
        body.decode_json()
    }

    /// Everything that happens before a byte is sent.
    fn prepare(
        &self,
        request: ChatRequest,
        capabilities: &ModelCapabilities,
        force_emulation: bool,
    ) -> ProviderResult<Prepared> {
        let mut degradations = Vec::new();

        if request.needs_vision() && capabilities.vision == Support::Unsupported {
            return Err(ProviderError::unsupported(
                Capability::Vision,
                Diagnosis::local(Cause::CapabilityAbsentOnThisModel),
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
                                Diagnosis::local(Cause::CapabilityAbsentOnThisModel),
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

        let wants_emulation =
            force_emulation || (self.options.emulate_tools && capabilities.needs_tool_emulation());
        let emulated = if request.offers_tools() && wants_emulation {
            let (rewritten, tool_degradations) = emulation::emulate(request);
            request = rewritten;
            degradations.extend(tool_degradations);
            true
        } else if !request.tools.is_empty() && request.tool_choice == ToolChoice::None {
            // FINDING 6: the catalogue is withheld rather than sent alongside
            // `tool_choice: "none"`, which some endpoints reject outright.
            let (rewritten, tool_degradations) = emulation::emulate(request);
            request = rewritten;
            degradations.extend(tool_degradations);
            false
        } else {
            false
        };

        Ok(Prepared {
            request,
            emulated,
            schema,
            degradations,
        })
    }

    async fn send_chat(
        &self,
        prepared: &Prepared,
        streaming: bool,
        sink: &mut dyn EventSink,
        context: &RequestContext,
    ) -> ProviderResult<ChatResponse> {
        let body = wire::encode_request(
            &prepared.request,
            streaming,
            streaming && self.options.request_usage,
        );
        let bytes = serde_json::to_vec(&body).map_err(|_| {
            ProviderError::malformed(Diagnosis::local(Cause::RequestCouldNotBeEncoded))
        })?;
        let request = self.authenticate(
            HttpRequest::post_json(self.api_url("chat/completions"), bytes).with_header(
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
            return Err(map_error_response(
                response.status,
                &body,
                &ConfiguredModelId::of(&prepared.request),
                response.header("retry-after"),
            ));
        }

        // The endpoint goes on before the branch: `drive_stream` would attach
        // it for the streaming path, but the non-streamed path reaches the same
        // assembler through `apply_chunk`, and an error object inside a 200
        // must name its candidate whichever transport carried it.
        let mut assembler =
            CompletionAssembler::new(streaming, streaming && self.options.request_usage)
                .with_endpoint(response.body.origin().endpoint().cloned());
        if prepared.emulated {
            assembler = assembler.with_tool_emulation();
        }

        if streaming {
            drive_stream(response.body, assembler, sink, context).await
        } else {
            let body = response.read_to_end(MAX_RESPONSE_BYTES).await?;
            // Decoded through the body's own scrubber: the non-streamed path
            // reconstitutes an escaped credential just as readily as the
            // streamed one, and `apply_chunk` feeds the sink the UI reads.
            let value: Value = body.decode_json()?;
            assembler.apply_chunk(&value, sink);
            assembler.finish(sink)
        }
    }

    /// One forced-tool-call turn, at a stated output budget.
    ///
    /// `ModelCapabilities::unknown` is passed to `prepare` deliberately: the
    /// probe must send `tools` natively, never the emulated prompt rewrite, or
    /// it would be measuring Vela instead of the endpoint.
    async fn tool_probe_attempt(
        &self,
        model_id: &str,
        budget: u32,
        streaming: bool,
        context: &RequestContext,
    ) -> ProviderResult<ToolProbe> {
        let request = ChatRequest::new(model_id)
            .with_message(ChatMessage::user("What is the weather in Berlin?"))
            .with_tools([crate::model::ToolDefinition::new(
                "get_weather",
                "Current weather for a city",
                json!({"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}),
            )])
            .with_tool_choice(ToolChoice::Required)
            .with_max_output_tokens(budget);
        let prepared = self.prepare(request, &ModelCapabilities::unknown(model_id), false)?;
        let mut sink = crate::event::CollectingSink::new();
        let response = self
            .send_chat(&prepared, streaming, &mut sink, context)
            .await?;
        Ok(classify_tool_probe(&response, budget))
    }

    /// Step 4 of the probe: does this endpoint call tools?
    ///
    /// `ToolChoice::Required` forces the issue — but only an endpoint that
    /// *finished* its answer can be said to have declined. An answer cut off by
    /// the output budget is asked again once, with a budget big enough that a
    /// second truncation is itself worth reporting.
    async fn probe_tool_calling(
        &self,
        model_id: &str,
        reasoning: Support,
        context: &RequestContext,
    ) -> (Support, String) {
        let first = if reasoning == Support::Supported {
            TOOL_PROBE_BUDGET_WHEN_REASONING
        } else {
            TOOL_PROBE_BUDGET
        };
        let attempt = self
            .tool_probe_attempt(model_id, first, false, context)
            .await;

        let (outcome, budget, retried) = match attempt {
            Ok(ToolProbe::Truncated) => (
                self.tool_probe_attempt(model_id, TOOL_PROBE_BUDGET_RETRY, true, context)
                    .await,
                TOOL_PROBE_BUDGET_RETRY,
                true,
            ),
            other => (other, first, false),
        };

        match outcome {
            Ok(outcome) => {
                let (support, note) = outcome.conclude(budget);
                if retried {
                    (
                        support,
                        format!("{note} (asked again after the first attempt stopped at its {first}-token budget)"),
                    )
                } else {
                    (support, note)
                }
            }
            Err(ProviderError::CapabilityUnsupported { .. }) => (
                Support::Unsupported,
                "refused a request carrying `tools`".to_owned(),
            ),
            // Including the retry's own failure: a probe that could not reach
            // the endpoint has established nothing either.
            Err(error) => (Support::Unknown, error.code().to_owned()),
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
        let offered_tools = request.offers_tools();

        let mut prepared = self.prepare(request.clone(), &capabilities, false)?;
        let mut outcome = self.send_chat(&prepared, streaming, sink, context).await;

        // The endpoint just told us something true about itself. Record it, and
        // retry the turn the way it will accept — this is what makes tools work
        // on a runtime that has never heard of them.
        if let Err(ProviderError::CapabilityUnsupported {
            capability: Capability::ToolCalling,
            ..
        }) = &outcome
        {
            if offered_tools && !prepared.emulated && self.options.emulate_tools {
                self.learn_one(
                    &model_id,
                    Capability::ToolCalling,
                    Support::Unsupported,
                    "the endpoint refused a request carrying `tools`",
                );
                prepared = self.prepare(request, &capabilities, true)?;
                outcome = self.send_chat(&prepared, streaming, sink, context).await;
            }
        }

        let mut response = outcome?;
        response
            .degradations
            .splice(0..0, prepared.degradations.clone());

        if let Some(schema) = &prepared.schema {
            // MEASURED-5: the endpoint will not tell us the schema was ignored,
            // so the answer is checked against what was asked for.
            match structured::check_answer(schema, &response.machine_text()) {
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

        if prepared.emulated && response.tool_calls.iter().any(|call| call.is_ok()) {
            response.stop_reason = StopReason::ToolUse;
        }
        Ok(response)
    }
}

/// Cap on a non-streaming response body. Bounds what a broken endpoint can
/// make Vela allocate; far above any real completion.
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// Output budget for the tool probe on a model with no known reasoning channel.
///
/// A forced call is a short thing to emit — a name and a small JSON object,
/// tens of tokens — and `max_tokens` is a **cap, not a spend**: a model that
/// emits its call and stops never reaches it. The number therefore only bounds
/// an endpoint that will not stop, which is why it stays small.
const TOOL_PROBE_BUDGET: u32 = 64;

/// …and the budget once step 3 has already established a reasoning channel.
///
/// A reasoning model spends its budget on the deliberation that comes *before*
/// the call, so the cap has to cover both. Measured against
/// `unsloth/Qwen3.6-27B-GGUF:Q5_K_M` on llama.cpp `b8833` at its default
/// sampling settings, six forced-call turns cost 88, 113, 125, 144, 157 and 171
/// completion tokens — the call itself about twenty of them, the rest
/// `reasoning_content`. At 64 every single one was cut off mid-deliberation,
/// one step short of the call it had already decided to make. 256 clears the
/// observed maximum with half again as much headroom and costs nothing extra on
/// a model that stops sooner.
///
/// The probe knows which of the two applies because it asked: step 3 runs
/// before this one and records [`Capability::Reasoning`].
const TOOL_PROBE_BUDGET_WHEN_REASONING: u32 = 256;

/// The one retry, taken only when the first attempt was cut off.
///
/// Bounded at exactly one. A probe that keeps doubling its budget against a
/// model that will not stop is a settings screen that hangs, and the second
/// truncation is itself an answer worth reporting ([`Support::Unknown`]).
///
/// **What it costs a user probing a slow local model:** one extra generation of
/// at most this many tokens, and nothing at all unless the first attempt
/// truncated. On the 27B model above — about 28 tokens/second — that is up to
/// roughly 37 seconds of generation.
///
/// That number is why the retry **streams** and the first attempt does not.
/// `Timeouts::probing()` gives a body 15 seconds; a non-streamed body arrives
/// only once generation has finished, so a 1024-token non-streamed retry would
/// reliably time out on hardware that slow. Streamed, the same deadline
/// measures the gap between two chunks — about 36 ms while a model is
/// generating — and the probe gets an answer instead. Measured end to end
/// against that endpoint under `Timeouts::probing()`: nine probe runs, eight
/// answered on the first attempt in 11–12 s, one truncated and took the retry,
/// finishing the whole probe in 22.1 s.
const TOOL_PROBE_BUDGET_RETRY: u32 = 1024;

/// What one tool-probe attempt established.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ToolProbe {
    /// A well-formed call came back. The endpoint has native tool calling.
    Native,
    /// Calls came back, broken (MEASURED-4).
    Malformed,
    /// The answer hit the output budget before the endpoint either produced a
    /// call or finished declining to. **Evidence of nothing.**
    Truncated,
    /// The endpoint finished its answer and produced no call.
    Declined,
}

impl ToolProbe {
    /// The capability this attempt supports, and the note the capability panel
    /// shows the user — which has to say *which* of the two failures happened,
    /// because "was asked and said no" and "was cut off before it could answer"
    /// are different facts about the endpoint.
    fn conclude(self, budget: u32) -> (Support, String) {
        match self {
            ToolProbe::Native => (
                Support::Supported,
                "returned a well-formed tool call".to_owned(),
            ),
            // The affordance survives because every failure is surfaced
            // explicitly (MEASURED-4).
            ToolProbe::Malformed => (
                Support::Degraded,
                "returned tool calls that could not be parsed".to_owned(),
            ),
            ToolProbe::Declined => (
                Support::Unsupported,
                "accepted a forced tool call, finished its answer, and produced none".to_owned(),
            ),
            // Not `Unsupported`. `Unsupported` would switch
            // `needs_tool_emulation` on and start describing tools in the prompt
            // to a model that can call them natively; `Unknown` withholds the
            // affordance without asserting the endpoint lacks it.
            ToolProbe::Truncated => (
                Support::Unknown,
                format!(
                    "ran out of its {budget}-token output budget before producing or refusing a \
                     tool call — a truncated answer is not evidence that the endpoint has none"
                ),
            ),
        }
    }
}

/// Read one tool-probe response.
///
/// The order is the whole point. A well-formed call is positive proof and wins
/// outright. Everything else is checked for truncation *first*, because a
/// half-emitted call is malformed for the same reason an empty answer is empty:
/// the budget ran out, not the endpoint's ability.
fn classify_tool_probe(response: &ChatResponse, budget: u32) -> ToolProbe {
    if response.tool_calls.iter().any(|call| call.is_ok()) {
        ToolProbe::Native
    } else if ran_out_of_budget(response, budget) {
        ToolProbe::Truncated
    } else if response.tool_calls.is_empty() {
        ToolProbe::Declined
    } else {
        ToolProbe::Malformed
    }
}

/// Did this answer stop because it hit the output budget?
///
/// Two signals, because an endpoint may send either, both or neither:
///
/// * the `finish_reason` it reported, already normalised to
///   [`StopReason::MaxTokens`] by `stream::map_stop_reason` (`"length"` and
///   `"max_tokens"` both land there);
/// * a completion count that reached the cap the request set. A model cannot
///   emit more output tokens than it was given, so spending all of them *is*
///   truncation — this is arithmetic, not a guess, and it covers the endpoints
///   that report usage but leave `finish_reason` null.
fn ran_out_of_budget(response: &ChatResponse, budget: u32) -> bool {
    response.stop_reason == StopReason::MaxTokens
        || response
            .usage
            .output_tokens
            .is_some_and(|spent| spent >= budget)
}

struct Prepared {
    request: ChatRequest,
    emulated: bool,
    schema: Option<Value>,
    degradations: Vec<Degradation>,
}

#[async_trait]
impl Provider for OpenAiCompatibleProvider {
    fn descriptor(&self) -> &ProviderDescriptor {
        &self.descriptor
    }

    async fn list_models(&self, context: &RequestContext) -> ProviderResult<Vec<ModelInfo>> {
        let value = self.get_json(self.api_url("models"), context).await?;
        let data = value
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::malformed(Cause::ModelListMalformed))?;
        Ok(data
            .iter()
            .filter_map(|entry| {
                let id = entry.get("id").and_then(Value::as_str)?;
                Some(ModelInfo {
                    id: id.to_owned(),
                    display_name: entry
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or(id)
                        .to_owned(),
                    context_window: entry
                        .get("context_length")
                        .and_then(Value::as_u64)
                        .and_then(|n| u32::try_from(n).ok()),
                })
            })
            .collect())
    }

    /// Establish what this model can do by asking it — five small requests,
    /// and at most one more if the tool question gets cut off mid-answer.
    ///
    /// Each probe is `max_tokens`-bounded and every conclusion records how it
    /// was reached ([`Evidence`]), so a capability report can never claim a
    /// probe happened when a default was used.
    ///
    /// **A bounded answer is not a complete one.** A probe that stops because
    /// it hit its own `max_tokens` has established nothing, and saying
    /// [`Support::Unsupported`] there is worse than saying
    /// [`Support::Unknown`]: `Unsupported` withdraws a working feature *and*
    /// turns on the prompt-level emulation that replaces it. Every step here
    /// therefore has to be able to tell "asked and told no" from "asked and cut
    /// off". Step 4 is where the difference stopped being hypothetical: a
    /// reasoning model spends its whole budget deliberating and is truncated
    /// one token short of the call it had already decided to make. Step 6 has
    /// the same shape and is not fixed here — see the note above its
    /// `send_chat`, which records the measurement and why.
    async fn probe_capabilities(
        &self,
        model_id: &str,
        context: &RequestContext,
    ) -> ProviderResult<ModelCapabilities> {
        let mut capabilities = ModelCapabilities::unknown(model_id);

        // 1. Declared context window, if the runtime exposes one.
        if let Ok(props) = self
            .get_json(format!("{}/props", self.origin()), context)
            .await
        {
            if let Some(n_ctx) = props
                .get("default_generation_settings")
                .and_then(|settings| settings.get("n_ctx"))
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok())
            {
                capabilities.context_window_tokens = Some(n_ctx);
                capabilities
                    .findings
                    .push(crate::capability::CapabilityFinding {
                        capability: Capability::Streaming,
                        support: Support::Unknown,
                        evidence: Evidence::Declared,
                        note: format!("endpoint declares a {n_ctx}-token context window"),
                    });
            }
        }

        // 2. Model listing.
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
                    capabilities.context_window_tokens.get_or_insert(window);
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
        }

        // 3. A plain streamed turn: streaming, reasoning, usage.
        let plain = ChatRequest::new(model_id)
            .with_message(ChatMessage::user("Say OK."))
            .with_max_output_tokens(16);
        let mut sink = crate::event::CollectingSink::new();
        match self.run(plain, true, &mut sink, context).await {
            Ok(response) => {
                capabilities.set(
                    Capability::Streaming,
                    Support::Supported,
                    Evidence::Probed,
                    "streamed a completion",
                );
                capabilities.set(
                    Capability::UsageReporting,
                    if response.usage.is_unreported() {
                        Support::Unsupported
                    } else {
                        Support::Supported
                    },
                    Evidence::Probed,
                    "usage frame on a streamed turn",
                );
                // Prompt caching, on the same evidence the Anthropic and Google
                // adapters use: whether the endpoint's usage carries
                // cached-input accounting at all. Before this it was the one
                // capability nothing asked about, so it reached the UI as
                // `false` — a default wearing the clothes of a measurement,
                // with no finding to say otherwise. A count of zero on a
                // first-of-its-kind prompt is expected and is not a "no": the
                // field being *there* is what says the endpoint accounts for
                // reuse. (Measuring reuse itself would mean sending the same
                // prompt twice and would report a false "no" whenever a
                // multi-slot runtime served the repeat from a cold slot.)
                let (caching_support, caching_note) = match response.usage.cached_input_tokens {
                    Some(cached) => (
                        Support::Supported,
                        format!(
                            "usage carried cached-input accounting ({cached} token(s) cached on \
                             this turn)"
                        ),
                    ),
                    None if response.usage.is_unreported() => (
                        Support::Unknown,
                        "the endpoint reported no usage at all, so nothing could be observed about \
                         caching"
                            .to_owned(),
                    ),
                    None => (
                        Support::Unsupported,
                        "usage was reported and carried no cached-input accounting".to_owned(),
                    ),
                };
                capabilities.set(
                    Capability::PromptCaching,
                    caching_support,
                    Evidence::Probed,
                    caching_note,
                );
                if !response.reasoning_text().is_empty() {
                    capabilities.set(
                        Capability::Reasoning,
                        Support::Supported,
                        Evidence::Probed,
                        "emitted a reasoning channel",
                    );
                }
            }
            Err(error) => {
                capabilities.set(
                    Capability::Streaming,
                    Support::Unsupported,
                    Evidence::Probed,
                    error.code(),
                );
            }
        }

        // 4. Tool calling — asked *after* step 3, because what step 3 learned
        //    about reasoning decides how much budget the question needs.
        let (tool_support, tool_note) = self
            .probe_tool_calling(model_id, capabilities.reasoning, context)
            .await;
        capabilities.set(
            Capability::ToolCalling,
            tool_support,
            Evidence::Probed,
            tool_note,
        );

        // 5. Vision: one 1x1 PNG.
        let vision_probe = ChatRequest::new(model_id)
            .with_message(ChatMessage::new(
                crate::model::MessageRole::User,
                vec![
                    crate::model::ContentPart::text("What colour is this?"),
                    crate::model::ContentPart::Image {
                        mime_type: "image/png".into(),
                        data: ONE_PIXEL_PNG.to_vec(),
                    },
                ],
            ))
            .with_max_output_tokens(16);
        let prepared = self.prepare(vision_probe, &ModelCapabilities::unknown(model_id), false)?;
        let mut sink = crate::event::CollectingSink::new();
        let (vision_support, vision_note) =
            match self.send_chat(&prepared, false, &mut sink, context).await {
                Ok(_) => (Support::Supported, "accepted an image part".to_owned()),
                Err(ProviderError::CapabilityUnsupported { .. }) => {
                    (Support::Unsupported, "refused an image part".to_owned())
                }
                Err(error) => (Support::Unknown, error.code().to_owned()),
            };
        capabilities.set(
            Capability::Vision,
            vision_support,
            Evidence::Probed,
            vision_note,
        );

        // 6. Structured output - the one that cannot be taken on trust.
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
        let prepared = self.prepare(
            structured_probe,
            &ModelCapabilities::unknown(model_id),
            false,
        )?;
        let mut sink = crate::event::CollectingSink::new();
        // KNOWN, MEASURED, DELIBERATELY NOT CHANGED HERE: this step reads a
        // truncated answer the same way step 4 used to. On
        // `unsloth/Qwen3.6-27B-GGUF:Q5_K_M` (llama.cpp b8833) it answered
        // `finish_reason: "length"` with empty content at 64 *and* at 256
        // tokens, spending the whole budget on `reasoning_content`; given 1024
        // the same endpoint returned `{"answer": "…"}` — conforming — after 847
        // completion tokens. So the `Degraded` below, and its note about prose,
        // describe an answer that was never produced.
        //
        // Two things make this a smaller problem than step 4's, and make
        // changing it a decision of its own rather than part of this fix:
        // `Unknown` and `Degraded` both leave `honours_structured_output`
        // false, so nothing the app *does* would change; and reading truncation
        // as `Unknown` here turns `mid-local`'s genuine schema violation —
        // which also truncates at 64 in the mock matrix — into "we don't know",
        // weakening a true negative the matrix row asserts
        // (`tests/mock_matrix_live.rs`). Getting a real answer instead needs a
        // budget in the high hundreds, which every user pays on every probe.
        let (structured_support, structured_note) =
            match self.send_chat(&prepared, false, &mut sink, context).await {
                Ok(response) => match structured::check_answer(&schema, &response.machine_text()) {
                    Ok(_) => (
                        Support::Supported,
                        "returned JSON conforming to the requested schema".to_owned(),
                    ),
                    // MEASURED-5: 200 OK and prose. The endpoint said nothing
                    // was wrong; only validation could tell.
                    Err(mismatch) => (
                        Support::Degraded,
                        format!(
                            "answered 200 without honouring the schema: {}",
                            mismatch.detail
                        ),
                    ),
                },
                Err(ProviderError::CapabilityUnsupported { .. }) => {
                    (Support::Unsupported, "refused `response_format`".to_owned())
                }
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
        let response = self.run(request, true, sink, context).await;
        match response {
            Ok(response) => {
                sink.emit(crate::event::StreamEvent::Done {
                    response: Box::new(response.clone()),
                });
                Ok(response)
            }
            Err(error) => {
                sink.emit(crate::event::StreamEvent::Error {
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
        let mut sink = crate::event::NullSink;
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
    use crate::http::ResponseHeaders;
    use crate::model::{ContentPart, MessageRole, ToolDefinition};
    use crate::provider::Timeouts;
    use vela_core::auth::AuthMode;
    use vela_core::provider::ProviderKind;
    use vela_core::secret::{SecretRef, SecretValue};
    use vela_secrets::MemoryStore;

    fn descriptor() -> ProviderDescriptor {
        ProviderDescriptor::new("test", "Test", ProviderKind::Local).unwrap()
    }

    fn provider(
        transport: ScriptedTransport,
    ) -> (OpenAiCompatibleProvider, Arc<ScriptedTransport>) {
        let transport = Arc::new(transport);
        let provider = OpenAiCompatibleProvider::new(
            descriptor(),
            "http://127.0.0.1:9/v1",
            Auth::None,
            Arc::new(MemoryStore::new()),
            transport.clone(),
        );
        (provider, transport)
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

    #[tokio::test]
    async fn no_credential_means_no_authorization_header_at_all() {
        let (provider, transport) = provider(ScriptedTransport::ok(&completion("hi")));
        provider
            .complete(
                ChatRequest::new("m").with_message(ChatMessage::user("hi")),
                &RequestContext::new(),
            )
            .await
            .unwrap();
        let sent = transport.recorded();
        assert_eq!(
            sent[0].header("authorization"),
            None,
            "an empty Bearer is a 401 on every profile; no header is the correct wire"
        );
    }

    #[tokio::test]
    async fn a_configured_credential_is_sent_as_a_bearer_token() {
        let secrets = MemoryStore::new();
        let reference = SecretRef::primary("test").unwrap();
        secrets
            .set(&reference, &SecretValue::new("s3cret"))
            .unwrap();
        let transport = Arc::new(ScriptedTransport::ok(&completion("hi")));
        let provider = OpenAiCompatibleProvider::new(
            descriptor().with_auth(vela_core::auth::AuthPolicy::required(AuthMode::BearerToken)),
            "http://127.0.0.1:9/v1",
            Auth::for_provider("test", &AuthMode::BearerToken).unwrap(),
            Arc::new(secrets),
            transport.clone(),
        );
        provider
            .complete(
                ChatRequest::new("m").with_message(ChatMessage::user("hi")),
                &RequestContext::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            transport.recorded()[0].header("authorization"),
            Some("Bearer s3cret")
        );
    }

    #[tokio::test]
    async fn a_tools_refusal_is_learned_and_the_turn_is_retried_with_emulation() {
        let refusal = json!({"error": {"message": "`m` does not support tools",
                                       "code": "tools_not_supported"}})
        .to_string();
        let transport = Arc::new(ScriptedTransport::new(vec![
            Ok(CannedResponse::error(400, &refusal)),
            Ok(CannedResponse::ok(&completion(
                "<tool_call>{\"name\": \"get_weather\", \"arguments\": {\"city\": \"berlin\"}}</tool_call>",
            ))),
        ]));
        let provider = OpenAiCompatibleProvider::new(
            descriptor(),
            "http://127.0.0.1:9/v1",
            Auth::None,
            Arc::new(MemoryStore::new()),
            transport.clone(),
        );

        let response = provider
            .complete(
                ChatRequest::new("m")
                    .with_message(ChatMessage::user("weather?"))
                    .with_tools([ToolDefinition::new(
                        "get_weather",
                        "d",
                        json!({"type": "object"}),
                    )]),
                &RequestContext::new(),
            )
            .await
            .expect("a tools refusal must degrade, not fail the turn");

        let sent = transport.recorded();
        assert_eq!(sent.len(), 2, "one native attempt, one emulated retry");
        let first: Value = serde_json::from_slice(sent[0].body.as_ref().unwrap()).unwrap();
        assert!(first.get("tools").is_some(), "the first attempt was native");
        let second: Value = serde_json::from_slice(sent[1].body.as_ref().unwrap()).unwrap();
        assert!(
            second.get("tools").is_none(),
            "the retry must not carry `tools` — that is what the endpoint refused"
        );
        assert!(second["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("get_weather"));

        assert!(response.executable_tool_calls().count() == 1);
        assert!(response
            .degradations
            .iter()
            .any(|d| matches!(d, Degradation::ToolCallingEmulated { .. })));
        assert_eq!(
            provider.known_capabilities("m").tool_calling,
            Support::Unsupported,
            "the refusal is remembered, so the next turn skips the wasted attempt"
        );
    }

    #[tokio::test]
    async fn structured_output_that_is_silently_ignored_is_reported_as_a_mismatch() {
        // The MEASURED-5 shape: 200 OK, prose, nothing saying the schema lost.
        let (provider, _) = provider(ScriptedTransport::ok(&completion(
            "Mock small-local reply to: give me json. keel delta fathom.",
        )));
        let response = provider
            .complete(
                ChatRequest::new("m")
                    .with_message(ChatMessage::user("give me json"))
                    .with_response_format(ResponseFormat::JsonSchema {
                        name: "answer".into(),
                        schema: json!({"type": "object", "required": ["answer"]}),
                    }),
                &RequestContext::new(),
            )
            .await
            .unwrap();

        match response
            .structured
            .as_ref()
            .expect("structured was requested")
        {
            Ok(value) => panic!("prose must never be presented as conforming JSON: {value}"),
            Err(mismatch) => assert!(mismatch.detail.contains("prose")),
        }
        assert!(response
            .degradations
            .iter()
            .any(|d| matches!(d, Degradation::StructuredOutputMismatch { .. })));
        assert_eq!(
            provider.known_capabilities("m").structured_output,
            Support::Degraded,
            "and it is remembered, so the affordance can be withdrawn"
        );
    }

    #[tokio::test]
    async fn a_probed_vision_less_model_refuses_an_image_without_sending_anything() {
        let transport = Arc::new(ScriptedTransport::new(vec![]));
        let mut capabilities = ModelCapabilities::unknown("m");
        capabilities.set(
            Capability::Vision,
            Support::Unsupported,
            Evidence::Probed,
            "400 vision_not_supported",
        );
        let provider = OpenAiCompatibleProvider::new(
            descriptor(),
            "http://127.0.0.1:9/v1",
            Auth::None,
            Arc::new(MemoryStore::new()),
            transport.clone(),
        )
        .with_capabilities(capabilities);

        let error = provider
            .complete(
                ChatRequest::new("m").with_message(ChatMessage::new(
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
    async fn the_url_gains_a_v1_prefix_only_when_the_base_lacks_one() {
        for (base, expected) in [
            ("http://h:1/v1", "http://h:1/v1/chat/completions"),
            ("http://h:1", "http://h:1/v1/chat/completions"),
            ("http://h:1/", "http://h:1/v1/chat/completions"),
        ] {
            let transport = Arc::new(ScriptedTransport::ok(&completion("hi")));
            let provider = OpenAiCompatibleProvider::new(
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
    async fn a_cancelled_context_stops_before_the_request_is_sent() {
        let (provider, transport) = provider(ScriptedTransport::ok(&completion("hi")));
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

    // ===================================================================
    // The tool probe, and the difference between "no" and "cut off"
    //
    // Measured against a real llama.cpp `b8833` serving
    // `unsloth/Qwen3.6-27B-GGUF:Q5_K_M`. The probe's forced tool call at
    // `max_tokens: 64` came back
    //
    //     200  finish_reason:"length"  content:""  completion_tokens:64
    //     reasoning_content:"…3. Extract the parameter: `city` = "Berlin"…"
    //
    // — the model had decided on the call and was truncated one step before
    // emitting it. The probe read that as `Unsupported`, which withdrew the
    // composer's agent toggle and turned on prompt-level tool emulation for a
    // model that tool-calls natively. The bodies below are that capture.
    // ===================================================================

    fn props(window: u32) -> CannedResponse {
        CannedResponse::ok(&json!({"default_generation_settings": {"n_ctx": window}}).to_string())
    }

    fn model_listing() -> CannedResponse {
        CannedResponse::ok(&json!({"object": "list", "data": [{"id": "m"}]}).to_string())
    }

    /// The plain streamed turn: a reasoning channel and a usage frame, so the
    /// probe reaches step 4 already knowing this model thinks before it answers.
    fn reasoning_turn() -> CannedResponse {
        CannedResponse::sse(vec![
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"The user wants \
             a greeting.\"}}]}\n\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"OK\"},\
             \"finish_reason\":\"stop\"}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":13,\"completion_tokens\":9,\
             \"prompt_tokens_details\":{\"cached_tokens\":0}}}\n\n",
            "data: [DONE]\n\n",
        ])
    }

    /// The wire capture: 200, empty content, no tool calls, the whole budget
    /// spent on `reasoning_content`, `finish_reason: "length"`.
    fn truncated_tool_probe(budget: u32) -> CannedResponse {
        CannedResponse::ok(
            &json!({
                "id": "c",
                "object": "chat.completion",
                "choices": [{
                    "index": 0,
                    "finish_reason": "length",
                    "message": {
                        "role": "assistant",
                        "content": "",
                        "reasoning_content":
                            "Thinking Process:\n1. Identify the user's request: the current \
                             weather in Berlin.\n2. Identify Required Tool: I have a \
                             `get_weather` function.\n3. Extract the parameter: `city` = \
                             \"Berlin\".\n4. Call the tool:",
                    },
                }],
                "usage": {"prompt_tokens": 274, "completion_tokens": budget,
                          "prompt_tokens_details": {"cached_tokens": 0}}
            })
            .to_string(),
        )
    }

    /// The same shape on the streamed transport the retry uses: deliberation,
    /// no answer, no call, `finish_reason: "length"`.
    fn truncated_tool_probe_streamed(budget: u32) -> CannedResponse {
        CannedResponse::sse(vec![
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"Thinking \
             Process:\\n1. The user wants the weather in Berlin.\"}}]}\n\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"length\"}]}\n\n",
            &format!(
                "data: {{\"choices\":[],\"usage\":{{\"prompt_tokens\":274,\
                 \"completion_tokens\":{budget}}}}}\n\n"
            ),
            "data: [DONE]\n\n",
        ])
    }

    /// The same model, given room to finish: the call it had already decided on.
    fn tool_call_turn() -> CannedResponse {
        CannedResponse::sse(vec![
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"Call \
             get_weather for Berlin.\"}}]}\n\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\
             \"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\
             \"arguments\":\"\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\
             \"function\":{\"arguments\":\"{\\\"city\\\":\\\"Berlin\\\"}\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":274,\"completion_tokens\":139,\
             \"prompt_tokens_details\":{\"cached_tokens\":270}}}\n\n",
            "data: [DONE]\n\n",
        ])
    }

    /// The true negative: an endpoint that was handed a forced call, wrote its
    /// whole answer, stopped of its own accord, and called nothing.
    fn declined_tool_probe() -> CannedResponse {
        CannedResponse::ok(&completion(
            "I'm afraid I can't look up live weather. Berlin is usually mild in spring.",
        ))
    }

    /// `max_tokens` on the nth recorded `chat/completions` request.
    fn budget_of(request: &HttpRequest) -> u64 {
        let body: Value = serde_json::from_slice(request.body.as_ref().unwrap()).unwrap();
        body["max_tokens"]
            .as_u64()
            .expect("the probe bounds itself")
    }

    fn chat_requests(transport: &ScriptedTransport) -> Vec<HttpRequest> {
        transport
            .recorded()
            .into_iter()
            .filter(|request| request.url.ends_with("chat/completions"))
            .collect()
    }

    fn tool_finding(capabilities: &ModelCapabilities) -> crate::capability::CapabilityFinding {
        capabilities
            .findings
            .iter()
            .rev()
            .find(|finding| finding.capability == Capability::ToolCalling)
            .expect("step 4 always records a finding")
            .clone()
    }

    /// **The regression.** A probe answer that ran out of budget establishes
    /// nothing — and `Unknown` is not a cosmetic difference from `Unsupported`:
    /// `Unsupported` is what switches `needs_tool_emulation` on and starts
    /// describing tools in the prompt to a model that can call them natively.
    #[tokio::test]
    async fn a_tool_probe_truncated_by_its_own_budget_is_never_read_as_no_tool_calling() {
        let transport = Arc::new(ScriptedTransport::new(vec![
            Ok(props(131_072)),
            Ok(model_listing()),
            Ok(reasoning_turn()),
            // Both attempts truncate, so nothing here can be mistaken for a
            // late success: the only thing under test is how truncation reads.
            Ok(truncated_tool_probe(TOOL_PROBE_BUDGET_WHEN_REASONING)),
            Ok(truncated_tool_probe_streamed(TOOL_PROBE_BUDGET_RETRY)),
            Ok(CannedResponse::ok(&completion("transparent"))),
            Ok(CannedResponse::ok(&completion("{\"answer\":\"ok\"}"))),
        ]));
        let provider = OpenAiCompatibleProvider::new(
            descriptor(),
            "http://127.0.0.1:9/v1",
            Auth::None,
            Arc::new(MemoryStore::new()),
            transport.clone(),
        );

        let capabilities = provider
            .probe_capabilities("m", &RequestContext::new())
            .await
            .unwrap();

        assert_ne!(
            capabilities.tool_calling,
            Support::Unsupported,
            "the endpoint never finished answering; concluding `Unsupported` withdraws a \
             feature on no evidence — findings {:#?}",
            capabilities.findings
        );
        assert_eq!(capabilities.tool_calling, Support::Unknown);
        assert!(
            !capabilities.needs_tool_emulation(),
            "an `Unsupported` here would start describing tools in the prompt to a model that \
             may well call them natively"
        );
        assert!(
            !capabilities.to_descriptor().tool_calls,
            "`Unknown` still withholds the affordance — it just stops asserting the endpoint \
             lacks it"
        );

        let finding = tool_finding(&capabilities);
        assert_eq!(finding.evidence, Evidence::Probed);
        assert!(
            finding.note.contains("budget") && finding.note.contains("truncated"),
            "the note is user-visible and has to say which failure this was: {}",
            finding.note
        );
    }

    /// One retry, and the budget it uses is the one the probe already knows it
    /// needs: step 3 established a reasoning channel, so step 4 does not ask a
    /// deliberating model to fit its answer in 64 tokens.
    #[tokio::test]
    async fn a_truncated_tool_probe_is_asked_once_more_with_room_to_finish() {
        let transport = Arc::new(ScriptedTransport::new(vec![
            Ok(props(131_072)),
            Ok(model_listing()),
            Ok(reasoning_turn()),
            Ok(truncated_tool_probe(TOOL_PROBE_BUDGET_WHEN_REASONING)),
            Ok(tool_call_turn()),
            Ok(CannedResponse::ok(&completion("transparent"))),
            Ok(CannedResponse::ok(&completion("{\"answer\":\"ok\"}"))),
        ]));
        let provider = OpenAiCompatibleProvider::new(
            descriptor(),
            "http://127.0.0.1:9/v1",
            Auth::None,
            Arc::new(MemoryStore::new()),
            transport.clone(),
        );

        let capabilities = provider
            .probe_capabilities("m", &RequestContext::new())
            .await
            .unwrap();

        assert_eq!(
            capabilities.tool_calling,
            Support::Supported,
            "findings {:#?}",
            capabilities.findings
        );
        assert!(capabilities.to_descriptor().tool_calls);

        let chats = chat_requests(&transport);
        assert_eq!(
            budget_of(&chats[1]),
            u64::from(TOOL_PROBE_BUDGET_WHEN_REASONING),
            "a probed reasoning channel is what makes the first budget the larger one"
        );
        assert_eq!(budget_of(&chats[2]), u64::from(TOOL_PROBE_BUDGET_RETRY));
        assert!(
            budget_of(&chats[2]) > budget_of(&chats[1]),
            "a retry at the same budget would only truncate again"
        );

        let retry: Value = serde_json::from_slice(chats[2].body.as_ref().unwrap()).unwrap();
        assert_eq!(
            retry["stream"], true,
            "the retry streams: `Timeouts::probing()` gives a non-streamed body 15 seconds to \
             arrive, and on a slow local model a 1024-token completion does not"
        );
        assert!(
            retry["tools"].is_array() && retry["tool_choice"] == "required",
            "the retry asks the same question, only with more room"
        );

        let note = tool_finding(&capabilities).note;
        assert!(
            note.contains("asked again"),
            "the note says the answer took a second attempt: {note}"
        );
    }

    /// **The other direction, which must keep working.** A fix that turns every
    /// negative into `Unknown` is worse than the defect: it would leave tool
    /// emulation switched off for endpoints that genuinely need it.
    #[tokio::test]
    async fn an_endpoint_that_finishes_and_calls_nothing_is_still_unsupported() {
        let transport = Arc::new(ScriptedTransport::new(vec![
            Ok(props(8_192)),
            Ok(model_listing()),
            Ok(reasoning_turn()),
            Ok(declined_tool_probe()),
            Ok(CannedResponse::ok(&completion("transparent"))),
            Ok(CannedResponse::ok(&completion("{\"answer\":\"ok\"}"))),
        ]));
        let provider = OpenAiCompatibleProvider::new(
            descriptor(),
            "http://127.0.0.1:9/v1",
            Auth::None,
            Arc::new(MemoryStore::new()),
            transport.clone(),
        );

        let capabilities = provider
            .probe_capabilities("m", &RequestContext::new())
            .await
            .unwrap();

        assert_eq!(
            capabilities.tool_calling,
            Support::Unsupported,
            "this endpoint was asked, answered in full, and called nothing — findings {:#?}",
            capabilities.findings
        );
        assert!(
            capabilities.needs_tool_emulation(),
            "and emulation is exactly what such an endpoint needs"
        );
        assert_eq!(
            chat_requests(&transport).len(),
            4,
            "plain, tool, vision, structured — a finished answer is not asked twice"
        );
        assert!(
            tool_finding(&capabilities).note.contains("finished"),
            "the note distinguishes this from a truncation: {}",
            tool_finding(&capabilities).note
        );
    }

    /// Truncation is read off two independent signals, because an endpoint may
    /// report either, both or neither.
    #[test]
    fn a_budget_that_was_spent_in_full_is_truncation_whether_or_not_the_endpoint_says_so() {
        let mut said_so = ChatResponse::empty();
        said_so.stop_reason = StopReason::MaxTokens;
        assert_eq!(classify_tool_probe(&said_so, 256), ToolProbe::Truncated);

        // `finish_reason: null` and a completion count that reached the cap. A
        // model cannot emit more tokens than it was given.
        let mut silent = ChatResponse::empty();
        silent.stop_reason = StopReason::Unspecified;
        silent.usage.output_tokens = Some(256);
        assert_eq!(classify_tool_probe(&silent, 256), ToolProbe::Truncated);

        let mut finished = ChatResponse::empty();
        finished.stop_reason = StopReason::EndTurn;
        finished.usage.output_tokens = Some(31);
        assert_eq!(classify_tool_probe(&finished, 256), ToolProbe::Declined);
    }

    /// A well-formed call is positive proof and outranks everything; a call cut
    /// in half is truncation, not a broken endpoint.
    #[test]
    fn a_half_emitted_call_is_read_as_truncation_rather_than_as_a_malformed_one() {
        let mut complete = ChatResponse::empty();
        complete.stop_reason = StopReason::MaxTokens;
        complete.tool_calls = vec![crate::model::ToolCallOutcome::Ok {
            call_id: "call_1".into(),
            name: "get_weather".into(),
            arguments: json!({"city": "Berlin"}),
            emulated: false,
        }];
        assert_eq!(
            classify_tool_probe(&complete, 256),
            ToolProbe::Native,
            "a usable call is proof, whatever stopped the turn afterwards"
        );

        let mut halved = ChatResponse::empty();
        halved.stop_reason = StopReason::MaxTokens;
        halved.tool_calls = vec![crate::model::ToolCallOutcome::Malformed {
            index: Some(0),
            call_id: Some("call_1".into()),
            name: Some("get_weather".into()),
            raw_arguments: "{\"city\": \"Ber".into(),
            reason: crate::model::MalformedToolCall::UnparseableArguments,
        }];
        assert_eq!(
            classify_tool_probe(&halved, 256),
            ToolProbe::Truncated,
            "the arguments are unparseable because the budget ran out, not because the \
             endpoint speaks the protocol badly"
        );
    }

    /// Prompt caching used to reach the UI as `false` with no finding behind it
    /// — an unprobed default that reads like a measurement.
    #[tokio::test]
    async fn prompt_caching_is_reported_from_the_usage_the_probe_already_asked_for() {
        let transport = Arc::new(ScriptedTransport::new(vec![
            Ok(props(131_072)),
            Ok(model_listing()),
            Ok(reasoning_turn()),
            Ok(truncated_tool_probe(TOOL_PROBE_BUDGET_WHEN_REASONING)),
            Ok(tool_call_turn()),
            Ok(CannedResponse::ok(&completion("transparent"))),
            Ok(CannedResponse::ok(&completion("{\"answer\":\"ok\"}"))),
        ]));
        let provider = OpenAiCompatibleProvider::new(
            descriptor(),
            "http://127.0.0.1:9/v1",
            Auth::None,
            Arc::new(MemoryStore::new()),
            transport.clone(),
        );

        let capabilities = provider
            .probe_capabilities("m", &RequestContext::new())
            .await
            .unwrap();

        let finding = capabilities
            .findings
            .iter()
            .find(|finding| finding.capability == Capability::PromptCaching)
            .expect("a capability the UI reports must have been asked about");
        assert_eq!(finding.evidence, Evidence::Probed);
        assert_eq!(capabilities.prompt_caching, Support::Supported);
        assert!(
            finding.note.contains("cached-input accounting"),
            "the note says what was seen: {}",
            finding.note
        );
    }

    /// …and an endpoint whose usage says nothing about caching still reports
    /// `Unsupported` — from evidence this time, not from the default.
    #[tokio::test]
    async fn usage_without_cache_accounting_reports_no_prompt_caching_on_evidence() {
        let plain = CannedResponse::sse(vec![
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"OK\"},\
             \"finish_reason\":\"stop\"}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":13,\"completion_tokens\":2}}\n\n",
            "data: [DONE]\n\n",
        ]);
        let transport = Arc::new(ScriptedTransport::new(vec![
            Ok(props(8_192)),
            Ok(model_listing()),
            Ok(plain),
            Ok(declined_tool_probe()),
            Ok(CannedResponse::ok(&completion("transparent"))),
            Ok(CannedResponse::ok(&completion("{\"answer\":\"ok\"}"))),
        ]));
        let provider = OpenAiCompatibleProvider::new(
            descriptor(),
            "http://127.0.0.1:9/v1",
            Auth::None,
            Arc::new(MemoryStore::new()),
            transport.clone(),
        );

        let capabilities = provider
            .probe_capabilities("m", &RequestContext::new())
            .await
            .unwrap();

        assert_eq!(capabilities.prompt_caching, Support::Unsupported);
        assert!(capabilities
            .findings
            .iter()
            .any(|finding| finding.capability == Capability::PromptCaching
                && finding.evidence == Evidence::Probed));
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
            ) -> Result<crate::http::HttpResponse, crate::http::TransportError> {
                Ok(crate::http::HttpResponse {
                    status: 200,
                    headers: ResponseHeaders::carries_no_credential([(
                        "content-type".to_owned(),
                        "text/event-stream".to_owned(),
                    )]),
                    body: crate::http::testing::fake_body(crate::http::testing::StalledBody),
                })
            }
        }
        let provider = OpenAiCompatibleProvider::new(
            descriptor(),
            "http://127.0.0.1:9/v1",
            Auth::None,
            Arc::new(MemoryStore::new()),
            Arc::new(Stalling),
        );
        let context = RequestContext::new().with_timeouts(Timeouts {
            stall: std::time::Duration::from_millis(50),
            ..Timeouts::default()
        });
        let mut sink = crate::event::CollectingSink::new();
        let error = provider
            .stream(
                ChatRequest::new("m").with_message(ChatMessage::user("hi")),
                &mut sink,
                &context,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(
                error,
                ProviderError::Transport {
                    failure: crate::error::TransportFailure::Stalled,
                    ..
                }
            ),
            "MEASURED-1: a quiet socket must never wedge the app; got {error:?}"
        );
        assert!(sink.error().is_some(), "the sink is told, not left hanging");
    }
}
