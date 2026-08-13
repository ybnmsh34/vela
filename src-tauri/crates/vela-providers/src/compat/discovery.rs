//! Finding out what is actually listening.
//!
//! Discovery answers three questions, in this order of usefulness:
//!
//! 1. **Is anything there at all?** If every probe fails at the transport level
//!    the endpoint is unreachable, and saying so is far better than reporting a
//!    model that "supports nothing" — which is what a capability table built
//!    from failed probes would say.
//! 2. **What is the context window?** Every family reports it somewhere
//!    different and three of the five do not report it on `/v1/models` at all.
//!    A window is a number, not an affordance, so it is safe to take from a
//!    declaration — and when two sources disagree, the smaller wins, because
//!    the loaded window is what will actually reject the request.
//! 3. **What does the server say it cannot do?** Used only to *withdraw*
//!    affordances — see the module docs on [`super`].

use std::sync::Arc;

use serde_json::{json, Value};
use vela_core::credential::Auth;
use vela_secrets::{resolve_auth, SecretError, SecretStore};

use crate::capability::{Evidence, ModelCapabilities, Support};
use crate::error::{detail, Capability, ProviderError, ProviderResult, TransportFailure};
use crate::http::{HttpRequest, HttpTransport};
use crate::provider::{ModelInfo, RequestContext};

use super::flavour::{
    hint_from_models, is_llama_cpp_props, is_lm_studio_models, is_ollama_tags, ServerFlavour,
};

/// Cap on any discovery body. These are metadata documents; a megabyte of them
/// is a broken server, not a big model list.
const MAX_DISCOVERY_BYTES: usize = 1024 * 1024;

/// Every field of a `/v1/models`-style entry that has ever meant "context
/// window", across the five families. Read together, smallest wins.
const WINDOW_KEYS: [&str; 7] = [
    "context_length",
    "max_model_len",
    "max_context_length",
    "loaded_context_length",
    "context_window",
    "context_size",
    "n_ctx",
];

/// What the endpoint told us about itself, before any behavioural probe.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ServerFacts {
    pub flavour: ServerFlavour,
    /// The window the server declares for this model, when it declares one.
    /// `None` is "not declared" — never a default.
    pub context_window_tokens: Option<u32>,
    pub models: Vec<ModelInfo>,
    /// Did a model-listing endpoint answer with a usable list?
    pub listing_answered: bool,
    /// Capabilities the server states it does **not** have. Nothing else is
    /// ever taken from a declaration; see [`ServerFacts::apply_to`].
    pub withheld: Vec<DeclaredFacts>,
    /// Provider-neutral diagnostics. Never rendered, never parsed.
    pub notes: Vec<String>,
}

/// One withdrawal, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeclaredFacts {
    pub capability: Capability,
    pub note: String,
}

impl ServerFacts {
    /// Fold declarations into a capability set.
    ///
    /// **The invariant:** a declaration fills a gap and never overrules a
    /// probe. It can move an [`Unknown`](Support::Unknown) capability to
    /// [`Unsupported`](Support::Unsupported) and it can narrow a context
    /// window. It can never produce [`Supported`](Support::Supported), and it
    /// never touches `structured_output`, whose failure mode is silent
    /// (MEASURED-5) and which therefore only a validated answer may decide.
    pub fn apply_to(&self, capabilities: &mut ModelCapabilities) {
        if let Some(declared) = self.context_window_tokens {
            let window = match capabilities.context_window_tokens {
                // Two sources, both plausible: the smaller is the one that will
                // actually refuse the request.
                Some(known) => known.min(declared),
                None => declared,
            };
            capabilities.context_window_tokens = Some(window);
        }
        for withheld in &self.withheld {
            debug_assert_ne!(
                withheld.capability,
                Capability::StructuredOutput,
                "MEASURED-5: structured output is never decided by a declaration"
            );
            if capabilities.get(withheld.capability).is_known() {
                // Something was probed. A claim does not outrank an observation
                // — in either direction.
                continue;
            }
            capabilities.set(
                withheld.capability,
                Support::Unsupported,
                Evidence::Declared,
                withheld.note.clone(),
            );
        }
    }
}

/// The HTTP details discovery needs. A near-duplicate of the core provider's
/// private helpers — see the note in `PROVIDER-CORE` follow-ups.
pub(super) struct Endpoint {
    pub base_url: String,
    pub auth: Auth,
    pub secrets: Arc<dyn SecretStore>,
    pub transport: Arc<dyn HttpTransport>,
}

impl Endpoint {
    /// `<base>/<path>`, inserting `/v1` only when the base lacks it.
    pub fn api_url(&self, path: &str) -> String {
        if self.base_url.ends_with("/v1") {
            format!("{}/{path}", self.base_url)
        } else {
            format!("{}/v1/{path}", self.base_url)
        }
    }

    /// Scheme and authority only: `/props`, `/api/tags` and `/api/v0/models`
    /// all live at the root, not under the API prefix.
    pub fn origin(&self) -> String {
        match self.base_url.find("://") {
            Some(at) => match self.base_url[at + 3..].find('/') {
                Some(slash) => self.base_url[..at + 3 + slash].to_owned(),
                None => self.base_url.clone(),
            },
            None => self.base_url.clone(),
        }
    }

    /// Apply the credential — or, for `Auth::None`, apply nothing at all. An
    /// empty `Authorization` header is a 401 on every profile the matrix
    /// recorded, so "no credential" must mean "no header".
    fn authenticate(&self, request: HttpRequest) -> ProviderResult<HttpRequest> {
        let applied = resolve_auth(self.secrets.as_ref(), &self.auth).map_err(|error| {
            ProviderError::AuthFailed {
                detail: detail(match error {
                    SecretError::NotFound { .. } => {
                        "this provider is configured to send a credential, but none is stored"
                            .to_owned()
                    }
                    SecretError::Unavailable { .. } => {
                        "the credential store could not be read".to_owned()
                    }
                    other => other.to_string(),
                }),
            }
        })?;
        Ok(request.with_auth(&applied))
    }

    async fn json(&self, request: HttpRequest, context: &RequestContext) -> ProviderResult<Value> {
        context.cancel.err_if_cancelled()?;
        let request = self.authenticate(request)?;
        let mut response = self.transport.send(request, &context.timeouts).await?;
        let body = response.read_to_end(MAX_DISCOVERY_BYTES).await?;
        if response.status != 200 {
            return Err(crate::openai_compatible::map_error_response(
                response.status,
                &body,
                "",
                response.header("retry-after"),
            ));
        }
        body.json()
            .map_err(|error| ProviderError::malformed(format!("response was not JSON: {error}")))
    }

    pub async fn get_json(&self, url: String, context: &RequestContext) -> ProviderResult<Value> {
        self.json(HttpRequest::get(url), context).await
    }

    pub async fn post_json(
        &self,
        url: String,
        body: &Value,
        context: &RequestContext,
    ) -> ProviderResult<Value> {
        let bytes = serde_json::to_vec(body)
            .map_err(|error| ProviderError::malformed(format!("could not encode: {error}")))?;
        self.json(HttpRequest::post_json(url, bytes), context).await
    }
}

/// Did this error come back *from the server*, or did we never reach one?
///
/// The distinction is the difference between "this model cannot do anything"
/// and "nothing is listening", and only one of those should ever be shown to
/// someone who has just typed in an endpoint.
fn reached_the_server(error: &ProviderError) -> bool {
    !matches!(
        error,
        ProviderError::Transport {
            failure: TransportFailure::Connect
                | TransportFailure::Timeout
                | TransportFailure::Stalled
                | TransportFailure::Reset,
            ..
        }
    )
}

/// Interrogate the endpoint. At most four small GETs and one POST.
///
/// Returns `Err` only when nothing answered at all; every other failure is a
/// fact that simply was not learned, and discovery continues.
pub(super) async fn discover(
    endpoint: &Endpoint,
    model_id: &str,
    context: &RequestContext,
) -> ProviderResult<ServerFacts> {
    let mut facts = ServerFacts::default();
    let mut reached = false;
    let mut unreachable: Option<ProviderError> = None;

    // 1. The one endpoint nearly everything serves. It is also the cheapest
    //    hint about which family this is.
    let mut hint = None;
    match endpoint.get_json(endpoint.api_url("models"), context).await {
        Ok(value) => {
            reached = true;
            hint = hint_from_models(&value);
            facts.models = parse_openai_models(&value);
            facts.listing_answered = !facts.models.is_empty();
            if let Some(flavour) = hint {
                facts.notes.push(format!(
                    "the model listing carries a field characteristic of {flavour}"
                ));
            }
        }
        Err(error) => {
            reached |= reached_the_server(&error);
            if !reached {
                unreachable = Some(error);
            }
        }
    }

    // 2. The family-specific endpoints, cheapest-first, with the hint moved to
    //    the front so a correctly-hinted server costs one request instead of
    //    three. Each is served by exactly one family, so the first 200 decides.
    for candidate in probe_order(hint) {
        if facts.flavour.is_known() {
            break;
        }
        context.cancel.err_if_cancelled()?;
        let (url, matches): (String, fn(&Value) -> bool) = match candidate {
            ServerFlavour::LlamaCpp => (format!("{}/props", endpoint.origin()), is_llama_cpp_props),
            ServerFlavour::Ollama => (format!("{}/api/tags", endpoint.origin()), is_ollama_tags),
            ServerFlavour::LmStudio => (
                format!("{}/api/v0/models", endpoint.origin()),
                is_lm_studio_models,
            ),
            // vLLM and Generic are decided by the listing alone; they have no
            // extra endpoint to ask.
            ServerFlavour::VLlm | ServerFlavour::Generic => continue,
        };
        match endpoint.get_json(url, context).await {
            Ok(value) if matches(&value) => {
                reached = true;
                facts.flavour = candidate;
                absorb_family_body(&mut facts, candidate, &value);
            }
            Ok(_) => {
                reached = true;
                facts.notes.push(format!(
                    "{candidate} probe answered, but not in its own shape"
                ));
            }
            Err(error) => reached |= reached_the_server(&error),
        }
    }

    if !reached {
        return Err(unreachable.unwrap_or_else(|| {
            ProviderError::transport(TransportFailure::Connect, "no endpoint answered")
        }));
    }

    if facts.flavour == ServerFlavour::Generic {
        if let Some(ServerFlavour::VLlm) = hint {
            facts.flavour = ServerFlavour::VLlm;
        }
    }

    // 3. Per-model detail, for the families that have somewhere to get it.
    if facts.flavour == ServerFlavour::Ollama && !model_id.is_empty() {
        if let Ok(show) = endpoint
            .post_json(
                format!("{}/api/show", endpoint.origin()),
                &json!({ "model": model_id }),
                context,
            )
            .await
        {
            absorb_ollama_show(&mut facts, &show);
        }
    }

    // The listing is the last word on this specific model's window, because it
    // is the only source that is per-model on every family that has one.
    if let Some(window) = facts
        .models
        .iter()
        .find(|model| model.id == model_id)
        .and_then(|model| model.context_window)
    {
        facts.context_window_tokens = Some(match facts.context_window_tokens {
            Some(known) => known.min(window),
            None => window,
        });
    }

    Ok(facts)
}

/// Enumerate models, whatever shape this server enumerates them in.
///
/// Three listings are tried in order of universality. A server that serves none
/// of them is not broken — it is the free-text-model-entry case, which the UI
/// handles as a normal state (`CapabilityUnsupported { ModelListing }`). An
/// endpoint nothing could be reached on reports *that* instead, because the two
/// are completely different problems for the person typing in a URL.
pub(super) async fn list_models(
    endpoint: &Endpoint,
    context: &RequestContext,
) -> ProviderResult<Vec<ModelInfo>> {
    type ModelParser = fn(&Value) -> Vec<ModelInfo>;
    let attempts: [(String, ModelParser); 3] = [
        (endpoint.api_url("models"), parse_openai_models),
        (format!("{}/api/tags", endpoint.origin()), parse_ollama_tags),
        (
            format!("{}/api/v0/models", endpoint.origin()),
            parse_openai_models,
        ),
    ];

    let mut reached = false;
    let mut transport_error: Option<ProviderError> = None;
    for (url, parse) in attempts {
        context.cancel.err_if_cancelled()?;
        match endpoint.get_json(url, context).await {
            Ok(value) => {
                reached = true;
                let models = parse(&value);
                if !models.is_empty() {
                    return Ok(models);
                }
            }
            Err(error) if reached_the_server(&error) => reached = true,
            Err(error) => {
                transport_error.get_or_insert(error);
            }
        }
    }

    match transport_error.filter(|_| !reached) {
        Some(error) => Err(error),
        None => Err(ProviderError::unsupported(
            Capability::ModelListing,
            "this endpoint does not enumerate models",
        )),
    }
}

fn probe_order(hint: Option<ServerFlavour>) -> Vec<ServerFlavour> {
    let mut order = vec![
        ServerFlavour::LlamaCpp,
        ServerFlavour::Ollama,
        ServerFlavour::LmStudio,
    ];
    if let Some(hint) = hint {
        order.retain(|flavour| *flavour != hint);
        order.insert(0, hint);
    }
    order
}

fn absorb_family_body(facts: &mut ServerFacts, flavour: ServerFlavour, value: &Value) {
    match flavour {
        ServerFlavour::LlamaCpp => {
            if let Some(n_ctx) = value
                .get("default_generation_settings")
                .and_then(|settings| settings.get("n_ctx"))
                .and_then(as_window)
            {
                facts.context_window_tokens = Some(n_ctx);
                facts
                    .notes
                    .push(format!("the loaded slot declares an {n_ctx}-token window"));
            }
        }
        ServerFlavour::Ollama => {
            // `/api/tags` names every model the daemon has pulled. It reports no
            // window — that needs `/api/show`, one model at a time.
            let listed = parse_ollama_tags(value);
            if !listed.is_empty() {
                facts.listing_answered = true;
                if facts.models.is_empty() {
                    facts.models = listed;
                }
            }
        }
        ServerFlavour::LmStudio => {
            let listed = parse_openai_models(value);
            if !listed.is_empty() {
                facts.listing_answered = true;
                // This listing is strictly richer than the OpenAI one: it is the
                // only place the *loaded* window appears.
                facts.models = merge_models(std::mem::take(&mut facts.models), listed);
            }
        }
        ServerFlavour::VLlm | ServerFlavour::Generic => {}
    }
}

fn absorb_ollama_show(facts: &mut ServerFacts, show: &Value) {
    if let Some(window) = ollama_context_length(show) {
        facts.context_window_tokens = Some(match facts.context_window_tokens {
            Some(known) => known.min(window),
            None => window,
        });
    }
    // The `capabilities` array is only evidence when it is present: an older
    // daemon omits it entirely, and "absent" must never read as "absent
    // capability".
    let Some(listed) = show.get("capabilities").and_then(Value::as_array) else {
        return;
    };
    let has = |name: &str| {
        listed
            .iter()
            .filter_map(Value::as_str)
            .any(|entry| entry.eq_ignore_ascii_case(name))
    };
    for (name, capability) in [
        ("tools", Capability::ToolCalling),
        ("vision", Capability::Vision),
        ("thinking", Capability::Reasoning),
    ] {
        if !has(name) {
            facts.withheld.push(DeclaredFacts {
                capability,
                note: format!(
                    "the server lists this model's capabilities and `{name}` is not among them"
                ),
            });
        }
    }
}

/// `model_info` is keyed by architecture — `llama.context_length`,
/// `qwen2.context_length`, and so on — so the architecture is read first and
/// any `*.context_length` is accepted as a fallback.
fn ollama_context_length(show: &Value) -> Option<u32> {
    let info = show.get("model_info")?.as_object()?;
    if let Some(architecture) = info.get("general.architecture").and_then(Value::as_str) {
        if let Some(window) = info
            .get(&format!("{architecture}.context_length"))
            .and_then(as_window)
        {
            return Some(window);
        }
    }
    info.iter()
        .filter(|(key, _)| key.ends_with(".context_length"))
        .filter_map(|(_, value)| as_window(value))
        .min()
}

/// Parse any `{"data": [...]}` model listing — OpenAI's, vLLM's, LM Studio's
/// REST one, and llama.cpp's.
fn parse_openai_models(value: &Value) -> Vec<ModelInfo> {
    let Some(entries) = value.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };
    entries.iter().filter_map(parse_model_entry).collect()
}

fn parse_model_entry(entry: &Value) -> Option<ModelInfo> {
    let id = ["id", "model", "name"]
        .iter()
        .find_map(|key| entry.get(*key).and_then(Value::as_str))?
        .to_owned();
    let display_name = entry
        .get("display_name")
        .or_else(|| entry.get("name"))
        .and_then(Value::as_str)
        .unwrap_or(&id)
        .to_owned();
    Some(ModelInfo {
        id,
        display_name,
        context_window: smallest_window(entry),
    })
}

/// The smallest window any field claims. A model whose file supports 128k but
/// which was loaded with 4k will refuse at 4k, so the smallest declared number
/// is the only safe one to plan against.
fn smallest_window(entry: &Value) -> Option<u32> {
    WINDOW_KEYS
        .iter()
        .filter_map(|key| entry.get(*key).and_then(as_window))
        .min()
}

fn as_window(value: &Value) -> Option<u32> {
    let number = value.as_u64()?;
    u32::try_from(number).ok().filter(|window| *window > 0)
}

fn parse_ollama_tags(value: &Value) -> Vec<ModelInfo> {
    let Some(entries) = value.get("models").and_then(Value::as_array) else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| {
            let id = ["model", "name"]
                .iter()
                .find_map(|key| entry.get(*key).and_then(Value::as_str))?
                .to_owned();
            let display_name = entry
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(&id)
                .to_owned();
            Some(ModelInfo {
                id,
                display_name,
                context_window: smallest_window(entry),
            })
        })
        .collect()
}

/// Prefer the richer entry per id, keeping the smaller window when both have
/// one, and keeping models that appear in only one of the two listings.
fn merge_models(base: Vec<ModelInfo>, richer: Vec<ModelInfo>) -> Vec<ModelInfo> {
    let mut merged = richer;
    for model in base {
        match merged.iter_mut().find(|entry| entry.id == model.id) {
            Some(entry) => {
                entry.context_window = match (entry.context_window, model.context_window) {
                    (Some(a), Some(b)) => Some(a.min(b)),
                    (a, b) => a.or(b),
                };
            }
            None => merged.push(model),
        }
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_vllm_listing_yields_the_window_that_no_other_field_reports() {
        let listing = json!({"object": "list", "data": [
            {"id": "meta-llama/Llama-3.1-8B", "object": "model", "owned_by": "vllm",
             "max_model_len": 131072, "permission": []}
        ]});
        let models = parse_openai_models(&listing);
        assert_eq!(models[0].context_window, Some(131_072));
        assert_eq!(hint_from_models(&listing), Some(ServerFlavour::VLlm));
    }

    #[test]
    fn lm_studios_loaded_window_beats_the_models_declared_maximum() {
        // The file supports 32k; it was loaded with 4k. Planning against 32k
        // would produce a request the server refuses.
        let listing = json!({"data": [
            {"id": "qwen2.5-7b", "type": "llm", "publisher": "qwen", "quantization": "Q4_K_M",
             "max_context_length": 32768, "loaded_context_length": 4096, "state": "loaded"}
        ]});
        assert!(is_lm_studio_models(&listing));
        assert_eq!(parse_openai_models(&listing)[0].context_window, Some(4_096));
    }

    #[test]
    fn ollamas_architecture_keyed_context_length_is_found_without_knowing_the_architecture() {
        let show = json!({
            "capabilities": ["completion", "tools"],
            "model_info": {"general.architecture": "qwen2", "qwen2.context_length": 32768,
                           "qwen2.embedding_length": 3584}
        });
        assert_eq!(ollama_context_length(&show), Some(32_768));
        assert_eq!(
            ollama_context_length(&json!({"model_info": {"phi3.context_length": 4096}})),
            Some(4_096)
        );
        assert_eq!(ollama_context_length(&json!({"model_info": {}})), None);
    }

    #[test]
    fn a_capability_the_server_omits_is_withdrawn_and_one_it_claims_is_not_granted() {
        let mut facts = ServerFacts::default();
        absorb_ollama_show(
            &mut facts,
            &json!({"capabilities": ["completion", "tools"], "model_info": {}}),
        );
        let withheld: Vec<Capability> = facts.withheld.iter().map(|w| w.capability).collect();
        assert_eq!(withheld, vec![Capability::Vision, Capability::Reasoning]);

        let mut capabilities = ModelCapabilities::unknown("m");
        facts.apply_to(&mut capabilities);
        assert_eq!(capabilities.vision, Support::Unsupported);
        assert_eq!(
            capabilities.tool_calling,
            Support::Unknown,
            "a claim of support is not evidence of support"
        );
        assert_eq!(
            capabilities.structured_output,
            Support::Unknown,
            "MEASURED-5: no declaration may ever speak for structured output"
        );
    }

    #[test]
    fn an_older_daemon_that_lists_no_capabilities_withdraws_nothing() {
        let mut facts = ServerFacts::default();
        absorb_ollama_show(
            &mut facts,
            &json!({"model_info": {"llama.context_length": 8192}}),
        );
        assert!(
            facts.withheld.is_empty(),
            "absent metadata is not an absent capability"
        );
        assert_eq!(facts.context_window_tokens, Some(8_192));
    }

    #[test]
    fn a_probe_that_watched_a_capability_work_outranks_a_declaration_that_denies_it() {
        let facts = ServerFacts {
            withheld: vec![DeclaredFacts {
                capability: Capability::ToolCalling,
                note: "not listed".into(),
            }],
            ..Default::default()
        };
        let mut capabilities = ModelCapabilities::unknown("m");
        capabilities.set(
            Capability::ToolCalling,
            Support::Supported,
            Evidence::Probed,
            "returned a well-formed tool call",
        );
        facts.apply_to(&mut capabilities);
        assert_eq!(capabilities.tool_calling, Support::Supported);
    }

    #[test]
    fn two_disagreeing_windows_resolve_to_the_smaller_one() {
        let facts = ServerFacts {
            context_window_tokens: Some(32_768),
            ..Default::default()
        };
        let mut capabilities = ModelCapabilities::unknown("m");
        capabilities.context_window_tokens = Some(4_096);
        facts.apply_to(&mut capabilities);
        assert_eq!(capabilities.context_window_tokens, Some(4_096));
    }

    #[test]
    fn a_hint_moves_its_own_probe_to_the_front_without_dropping_the_others() {
        assert_eq!(
            probe_order(Some(ServerFlavour::LmStudio)),
            vec![
                ServerFlavour::LmStudio,
                ServerFlavour::LlamaCpp,
                ServerFlavour::Ollama
            ]
        );
        assert_eq!(probe_order(None).len(), 3);
    }

    #[test]
    fn only_a_transport_level_failure_counts_as_never_having_reached_a_server() {
        assert!(!reached_the_server(&ProviderError::transport(
            TransportFailure::Connect,
            "refused"
        )));
        assert!(reached_the_server(&ProviderError::transport(
            TransportFailure::Request { status: 404 },
            "not found"
        )));
        assert!(reached_the_server(&ProviderError::AuthFailed {
            detail: detail("nope")
        }));
    }

    #[test]
    fn the_origin_is_used_for_root_endpoints_and_the_api_prefix_for_the_rest() {
        let endpoint = Endpoint {
            base_url: "http://127.0.0.1:11434/v1".into(),
            auth: Auth::None,
            secrets: Arc::new(vela_secrets::MemoryStore::new()),
            transport: Arc::new(crate::http::testing::ScriptedTransport::new(vec![])),
        };
        assert_eq!(endpoint.origin(), "http://127.0.0.1:11434");
        assert_eq!(
            endpoint.api_url("models"),
            "http://127.0.0.1:11434/v1/models"
        );
        let bare = Endpoint {
            base_url: "http://h:8080".into(),
            ..endpoint
        };
        assert_eq!(bare.api_url("models"), "http://h:8080/v1/models");
        assert_eq!(bare.origin(), "http://h:8080");
    }
}
