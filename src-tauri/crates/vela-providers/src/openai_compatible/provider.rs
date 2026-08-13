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
use crate::emulation;
use crate::error::{detail, Capability, ProviderError, ProviderResult};
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
        force_emulation: bool,
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
        let bytes = serde_json::to_vec(&body).map_err(|error| {
            ProviderError::malformed(format!("could not encode request: {error}"))
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
                &prepared.request.model_id,
                response.header("retry-after"),
            ));
        }

        let mut assembler =
            CompletionAssembler::new(streaming, streaming && self.options.request_usage);
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
            let value: Value = body.json().map_err(|error| {
                ProviderError::malformed(format!("response was not JSON: {error}"))
            })?;
            assembler.apply_chunk(&value, sink);
            assembler.finish(sink)
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

        if prepared.emulated && response.tool_calls.iter().any(|call| call.is_ok()) {
            response.stop_reason = StopReason::ToolUse;
        }
        Ok(response)
    }
}

/// Cap on a non-streaming response body. Bounds what a broken endpoint can
/// make Vela allocate; far above any real completion.
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

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
            .ok_or_else(|| ProviderError::malformed("model list had no `data` array"))?;
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

        // 4. Tool calling. `Required` forces the issue: an endpoint that
        //    accepts a forced call and produces none does not have the feature.
        let tool_probe = ChatRequest::new(model_id)
            .with_message(ChatMessage::user("What is the weather in Berlin?"))
            .with_tools([crate::model::ToolDefinition::new(
                "get_weather",
                "Current weather for a city",
                json!({"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}),
            )])
            .with_tool_choice(ToolChoice::Required)
            .with_max_output_tokens(64);
        let prepared = self.prepare(tool_probe, &ModelCapabilities::unknown(model_id), false)?;
        let mut sink = crate::event::CollectingSink::new();
        let (tool_support, tool_note) =
            match self.send_chat(&prepared, false, &mut sink, context).await {
                Ok(response) if response.tool_calls.iter().any(|call| call.is_ok()) => (
                    Support::Supported,
                    "returned a well-formed tool call".to_owned(),
                ),
                // Calls arrive, but broken. The affordance survives because every
                // failure is surfaced explicitly (MEASURED-4).
                Ok(response) if !response.tool_calls.is_empty() => (
                    Support::Degraded,
                    "returned tool calls that could not be parsed".to_owned(),
                ),
                Ok(_) => (
                    Support::Unsupported,
                    "accepted a forced tool call and produced none".to_owned(),
                ),
                Err(ProviderError::CapabilityUnsupported { .. }) => (
                    Support::Unsupported,
                    "refused a request carrying `tools`".to_owned(),
                ),
                Err(error) => (Support::Unknown, error.code().to_owned()),
            };
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
        let (structured_support, structured_note) =
            match self.send_chat(&prepared, false, &mut sink, context).await {
                Ok(response) => match structured::check_answer(&schema, &response.answer_text()) {
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
                    headers: vec![("content-type".into(), "text/event-stream".into())],
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
