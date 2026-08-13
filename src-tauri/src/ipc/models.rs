//! `models_*` — which models an endpoint holds, and what each one can do.
//!
//! # Why this domain exists at all
//!
//! Every affordance the conversation surface offers is gated on a capability
//! flag, and there was no command that could produce one. `settings_*` describes
//! what the user *configured*; this module describes what the endpoint
//! *demonstrated*. They are different facts and must not share a response type:
//! a configured endpoint with an unreachable box has a perfectly valid
//! configuration and no established capabilities at all.
//!
//! # The three rules
//!
//! 1. **Unprobed is not "supported".** [`models_capabilities`] answers from a
//!    cache, and a miss is [`ModelCapabilities::unknown`] — every flag `false`.
//!    Offering an affordance the endpoint cannot serve is a gate failure, so the
//!    floor is "offer nothing" and evidence is the only thing that raises it.
//! 2. **A probe that fails is not an error to swallow.** [`models_probe`]
//!    returns the report it *does* have plus the normalised
//!    [`ProviderError`] — the same taxonomy the chat surface already renders.
//!    The renderer therefore has one error vocabulary, not two.
//! 3. **Nothing endpoint-authored crosses.** A [`CapabilityFinding`] carries a
//!    free-text `note` written by an adapter; it is deliberately dropped here.
//!    What crosses is the capability, the support level and the evidence class —
//!    three closed enums. The renderer owns every sentence a user reads, exactly
//!    as it does for `Concern` and `Cause`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::State;
use vela_core::provider::ProviderCapabilities;
use vela_providers::capability::{Evidence, ModelCapabilities, Support};
use vela_providers::error::{Capability, ProviderError};
use vela_providers::provider::{ModelInfo, RequestContext, Timeouts};

use super::{IpcError, IpcResult};
use crate::state::AppState;

/// Longest model id Vela will accept from the renderer. Model ids are short
/// names, not documents; a bound here keeps a runaway caller from asking the
/// host to key a cache on a megabyte.
const MAX_MODEL_ID_LEN: usize = 200;

/* -------------------------------------------------------------------------- */
/* wire types                                                                 */
/* -------------------------------------------------------------------------- */

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsProviderRefReq {
    pub provider_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsRefReq {
    pub provider_id: String,
    pub model_id: String,
}

/// One model the endpoint says it has.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub model_id: String,
    /// How the endpoint names it. Rendered as-is; never parsed, never matched.
    pub display_name: String,
    /// `None` when the endpoint does not report one. Never a guessed default —
    /// a context meter drawn from an invented number is worse than no meter.
    pub context_window_tokens: Option<u32>,
}

impl From<ModelInfo> for ModelOption {
    fn from(info: ModelInfo) -> Self {
        Self {
            model_id: info.id,
            display_name: info.display_name,
            context_window_tokens: info.context_window,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsListRes {
    pub models: Vec<ModelOption>,
    /// The endpoint enumerated its own models. `false` means the renderer must
    /// fall back to the model the user configured and offer free-text entry —
    /// a normal state for a runtime with no listing route, **not** a failure.
    pub enumerated: bool,
    /// Present only when the attempt failed for a reason that is not "this
    /// endpoint does not do listing". Same taxonomy as a failed turn.
    pub failure: Option<ProviderError>,
}

/// One belief about one capability, and how it was arrived at.
///
/// The adapter's `note` is not here on purpose — see rule 3 in the module docs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityFindingView {
    pub capability: Capability,
    pub support: Support,
    pub evidence: Evidence,
}

/// What the UI is allowed to know about one model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapabilityReport {
    pub provider_id: String,
    pub model_id: String,
    /// The offerable flag set. `Unknown` reads as `false`, and degraded
    /// structured output is withdrawn — both decided in
    /// [`ModelCapabilities::to_descriptor`], never here.
    pub capabilities: ProviderCapabilities,
    /// May a structured-output request be *sent*? Deliberately separate from
    /// `capabilities`, because its failure mode is silent wrong output.
    pub structured_output: bool,
    /// The endpoint has no native tool calling, so the core will emulate it in
    /// the prompt. The UI must say so rather than implying native support.
    pub tool_calls_emulated: bool,
    pub context_window_tokens: Option<u32>,
    pub max_output_tokens: Option<u32>,
    /// Anything at all was established. `false` means every flag above is the
    /// pessimistic floor because nobody has asked the endpoint yet.
    pub probed: bool,
    pub findings: Vec<CapabilityFindingView>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsProbeRes {
    /// The report as it stands after the attempt. On failure this is whatever
    /// was already known — usually the unknown floor — never an optimistic guess.
    pub report: ModelCapabilityReport,
    pub failure: Option<ProviderError>,
}

impl ModelCapabilityReport {
    pub fn of(provider_id: &str, capabilities: &ModelCapabilities) -> Self {
        Self {
            provider_id: provider_id.to_owned(),
            model_id: capabilities.model_id.clone(),
            capabilities: capabilities.to_descriptor(),
            structured_output: capabilities.honours_structured_output(),
            tool_calls_emulated: capabilities.needs_tool_emulation(),
            context_window_tokens: capabilities.context_window_tokens,
            max_output_tokens: capabilities.max_output_tokens,
            probed: capabilities
                .findings
                .iter()
                .any(|finding| finding.evidence != Evidence::Unprobed),
            findings: capabilities
                .findings
                .iter()
                .map(|finding| CapabilityFindingView {
                    capability: finding.capability,
                    support: finding.support,
                    evidence: finding.evidence,
                })
                .collect(),
        }
    }
}

/* -------------------------------------------------------------------------- */
/* the cache                                                                  */
/* -------------------------------------------------------------------------- */

/// Probe results, keyed by (provider, model).
///
/// Held as host-process state rather than in `AppState` for the same reason
/// `ChatTurns` is: nothing in `crates/` needs to know a probe has happened.
///
/// It is a cache and not a store: it is not persisted, so a restart returns
/// every model to "nothing established". That is the conservative direction —
/// a stale `vision: true` survived across a model swap would offer an
/// affordance the endpoint cannot serve, which is the one outcome the
/// capability system exists to prevent.
#[derive(Default, Clone)]
pub struct CapabilityCache {
    inner: Arc<Mutex<HashMap<(String, String), ModelCapabilities>>>,
}

impl CapabilityCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, provider_id: &str, model_id: &str) -> Option<ModelCapabilities> {
        self.lock()
            .get(&(provider_id.to_owned(), model_id.to_owned()))
            .cloned()
    }

    pub fn put(&self, provider_id: &str, capabilities: ModelCapabilities) {
        self.lock().insert(
            (provider_id.to_owned(), capabilities.model_id.clone()),
            capabilities,
        );
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    /// Recovering from a poisoned lock is correct here: the map is a plain
    /// index with no invariant a panic could half-break, and refusing every
    /// later probe would be worse than continuing.
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<(String, String), ModelCapabilities>> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/* -------------------------------------------------------------------------- */
/* logic — plain functions, no Tauri types                                    */
/* -------------------------------------------------------------------------- */

fn validated_provider_id(raw: &str) -> IpcResult<&str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(IpcError::invalid("invalid providerId: must not be blank"));
    }
    Ok(trimmed)
}

fn validated_model_id(raw: &str) -> IpcResult<&str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(IpcError::invalid("invalid modelId: must not be blank"));
    }
    if trimmed.len() > MAX_MODEL_ID_LEN {
        return Err(IpcError::invalid(format!(
            "invalid modelId: must be at most {MAX_MODEL_ID_LEN} characters"
        )));
    }
    Ok(trimmed)
}

/// What is known right now. **Never contacts the endpoint.**
///
/// A cache miss is not `NOT_FOUND`: "nothing has been established about this
/// model" is a fact the UI must render, and turning it into an error would
/// leave the switcher unable to say anything about a model the user just added.
pub fn capabilities(cache: &CapabilityCache, req: ModelsRefReq) -> IpcResult<ModelCapabilityReport> {
    let provider_id = validated_provider_id(&req.provider_id)?;
    let model_id = validated_model_id(&req.model_id)?;
    let known = cache
        .get(provider_id, model_id)
        .unwrap_or_else(|| ModelCapabilities::unknown(model_id));
    Ok(ModelCapabilityReport::of(provider_id, &known))
}

/// Is this error the endpoint saying "I do not enumerate models"?
///
/// That is a supported configuration, not a fault: the renderer offers free-text
/// model entry instead. Every other error is a real failure and travels.
fn is_listing_unsupported(error: &ProviderError) -> bool {
    matches!(
        error,
        ProviderError::CapabilityUnsupported {
            capability: Capability::ModelListing,
            ..
        }
    )
}

/// Folds a listing attempt into the response shape. Split out from the command
/// so the classification is unit-testable with no runtime.
pub fn listing_result(outcome: Result<Vec<ModelInfo>, ProviderError>) -> ModelsListRes {
    match outcome {
        Ok(models) => ModelsListRes {
            models: models.into_iter().map(ModelOption::from).collect(),
            enumerated: true,
            failure: None,
        },
        Err(error) if is_listing_unsupported(&error) => ModelsListRes {
            models: Vec::new(),
            enumerated: false,
            failure: None,
        },
        Err(error) => ModelsListRes {
            models: Vec::new(),
            enumerated: false,
            failure: Some(error),
        },
    }
}

/* -------------------------------------------------------------------------- */
/* commands                                                                   */
/* -------------------------------------------------------------------------- */

#[tauri::command]
pub fn models_capabilities(
    cache: State<'_, CapabilityCache>,
    payload: ModelsRefReq,
) -> IpcResult<ModelCapabilityReport> {
    capabilities(cache.inner(), payload)
}

#[tauri::command]
pub async fn models_list(
    state: State<'_, AppState>,
    payload: ModelsProviderRefReq,
) -> IpcResult<ModelsListRes> {
    let provider_id = validated_provider_id(&payload.provider_id)?;
    let provider = super::chat::resolve_provider(state.providers.as_ref(), provider_id)?;
    let context = RequestContext::new().with_timeouts(Timeouts::probing());
    Ok(listing_result(provider.list_models(&context).await))
}

#[tauri::command]
pub async fn models_probe(
    state: State<'_, AppState>,
    cache: State<'_, CapabilityCache>,
    payload: ModelsRefReq,
) -> IpcResult<ModelsProbeRes> {
    let provider_id = validated_provider_id(&payload.provider_id)?.to_owned();
    let model_id = validated_model_id(&payload.model_id)?.to_owned();
    let provider = super::chat::resolve_provider(state.providers.as_ref(), &provider_id)?;

    let context = RequestContext::new().with_timeouts(Timeouts::probing());
    match provider.probe_capabilities(&model_id, &context).await {
        Ok(found) => {
            cache.put(&provider_id, found.clone());
            Ok(ModelsProbeRes {
                report: ModelCapabilityReport::of(&provider_id, &found),
                failure: None,
            })
        }
        Err(error) => {
            // Deliberately does NOT clear or downgrade the cache. A probe that
            // could not reach the box says nothing about the model; discarding
            // what a previous successful probe established would make a flaky
            // network look like a capability regression.
            let known = cache
                .get(&provider_id, &model_id)
                .unwrap_or_else(|| ModelCapabilities::unknown(&model_id));
            Ok(ModelsProbeRes {
                report: ModelCapabilityReport::of(&provider_id, &known),
                failure: Some(error),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vela_providers::diagnostic::{Cause, Diagnosis};

    fn probed(model: &str) -> ModelCapabilities {
        let mut capabilities = ModelCapabilities::unknown(model);
        capabilities
            .set(
                Capability::Streaming,
                Support::Supported,
                Evidence::Probed,
                "frames arrived",
            )
            .set(
                Capability::Vision,
                Support::Unsupported,
                Evidence::Probed,
                "refused an image part",
            )
            .set(
                Capability::ToolCalling,
                Support::Unsupported,
                Evidence::Probed,
                "no tools route",
            )
            .set(
                Capability::StructuredOutput,
                Support::Degraded,
                Evidence::Probed,
                "200 OK with prose",
            );
        capabilities.context_window_tokens = Some(4096);
        capabilities
    }

    #[test]
    fn a_model_nobody_has_probed_offers_nothing_at_all() {
        // The load-bearing default. If this ever starts returning `true` for
        // anything, the UI begins offering affordances no endpoint agreed to.
        let cache = CapabilityCache::new();
        let report = capabilities(
            &cache,
            ModelsRefReq {
                provider_id: "endpoint-a".into(),
                model_id: "some-model".into(),
            },
        )
        .unwrap();

        assert_eq!(report.capabilities, ProviderCapabilities::minimal());
        assert!(!report.capabilities.vision);
        assert!(!report.structured_output);
        assert!(!report.probed);
        assert_eq!(report.context_window_tokens, None);
        assert!(report.findings.is_empty());
    }

    #[test]
    fn a_cache_miss_is_a_report_and_never_a_not_found() {
        let cache = CapabilityCache::new();
        assert!(capabilities(
            &cache,
            ModelsRefReq {
                provider_id: "never-seen".into(),
                model_id: "never-seen-either".into(),
            },
        )
        .is_ok());
    }

    #[test]
    fn a_probed_model_reports_its_window_and_its_refusals() {
        let cache = CapabilityCache::new();
        cache.put("endpoint-a", probed("small-local"));

        let report = capabilities(
            &cache,
            ModelsRefReq {
                provider_id: "endpoint-a".into(),
                model_id: "small-local".into(),
            },
        )
        .unwrap();

        assert!(report.probed);
        assert!(report.capabilities.streaming);
        assert!(!report.capabilities.vision, "vision was refused");
        assert!(
            !report.structured_output,
            "degraded structured output is withdrawn, not offered"
        );
        assert!(
            report.tool_calls_emulated,
            "no native tools means the core will emulate them, and the UI must say so"
        );
        assert_eq!(report.context_window_tokens, Some(4096));
        assert_eq!(report.findings.len(), 4);
    }

    #[test]
    fn the_cache_is_keyed_on_provider_and_model_together() {
        // Two endpoints serving a same-named model are not the same model: one
        // may be a quantisation with a quarter of the window.
        let cache = CapabilityCache::new();
        cache.put("endpoint-a", probed("shared-name"));
        assert_eq!(cache.len(), 1);

        let other = capabilities(
            &cache,
            ModelsRefReq {
                provider_id: "endpoint-b".into(),
                model_id: "shared-name".into(),
            },
        )
        .unwrap();
        assert!(!other.probed, "endpoint-b was never probed");
    }

    #[test]
    fn blank_identifiers_are_rejected_and_name_the_field_they_blame() {
        let cache = CapabilityCache::new();
        let blank_provider = capabilities(
            &cache,
            ModelsRefReq {
                provider_id: "  ".into(),
                model_id: "m".into(),
            },
        )
        .unwrap_err();
        assert!(blank_provider.message.contains("providerId"));

        let blank_model = capabilities(
            &cache,
            ModelsRefReq {
                provider_id: "p".into(),
                model_id: "".into(),
            },
        )
        .unwrap_err();
        assert!(blank_model.message.contains("modelId"));

        let long_model = capabilities(
            &cache,
            ModelsRefReq {
                provider_id: "p".into(),
                model_id: "m".repeat(MAX_MODEL_ID_LEN + 1),
            },
        )
        .unwrap_err();
        assert_eq!(long_model.code, super::super::IpcErrorCode::InvalidPayload);
    }

    #[test]
    fn an_endpoint_that_cannot_list_models_is_not_reported_as_a_failure() {
        // The llama.cpp-shaped case: no listing route at all. The renderer must
        // fall back to free-text entry, not show the user an error.
        let result = listing_result(Err(ProviderError::unsupported(
            Capability::ModelListing,
            Diagnosis::local(Cause::CapabilityNotOfferedByBackend),
        )));
        assert!(!result.enumerated);
        assert!(result.failure.is_none());
        assert!(result.models.is_empty());
    }

    #[test]
    fn a_listing_that_failed_for_any_other_reason_travels_as_a_failure() {
        let result = listing_result(Err(ProviderError::unsupported(
            Capability::Vision,
            Diagnosis::local(Cause::ConnectionFailed),
        )));
        assert!(!result.enumerated);
        assert!(result.failure.is_some());
    }

    #[test]
    fn a_listed_model_carries_the_window_the_endpoint_reported_and_no_other() {
        let result = listing_result(Ok(vec![
            ModelInfo {
                id: "with-window".into(),
                display_name: "With window".into(),
                context_window: Some(8192),
            },
            ModelInfo {
                id: "without".into(),
                display_name: "Without".into(),
                context_window: None,
            },
        ]));
        assert!(result.enumerated);
        assert_eq!(result.models[0].context_window_tokens, Some(8192));
        assert_eq!(
            result.models[1].context_window_tokens, None,
            "an unreported window must stay unreported, never a default"
        );
    }

    #[test]
    fn the_report_json_is_camel_case_and_names_no_backend() {
        let cache = CapabilityCache::new();
        cache.put("endpoint-a", probed("small-local"));
        let json = serde_json::to_value(
            capabilities(
                &cache,
                ModelsRefReq {
                    provider_id: "endpoint-a".into(),
                    model_id: "small-local".into(),
                },
            )
            .unwrap(),
        )
        .unwrap();

        assert_eq!(json["contextWindowTokens"], 4096);
        assert_eq!(json["toolCallsEmulated"], true);
        assert_eq!(json["structuredOutput"], false);
        assert_eq!(json["capabilities"]["toolCalls"], false);
        assert_eq!(json["findings"][1]["capability"], "vision");
        assert_eq!(json["findings"][1]["support"], "unsupported");
        assert_eq!(json["findings"][1]["evidence"], "probed");
    }

    #[test]
    fn no_adapter_authored_text_crosses_the_boundary() {
        // `note` is written by adapters and can say anything at all. The wire
        // form must carry three closed enums and nothing else.
        let cache = CapabilityCache::new();
        let mut capabilities_with_note = ModelCapabilities::unknown("m");
        capabilities_with_note.set(
            Capability::Vision,
            Support::Unsupported,
            Evidence::Probed,
            "ENDPOINT-AUTHORED-CANARY",
        );
        cache.put("endpoint-a", capabilities_with_note);

        let json = serde_json::to_string(
            &capabilities(
                &cache,
                ModelsRefReq {
                    provider_id: "endpoint-a".into(),
                    model_id: "m".into(),
                },
            )
            .unwrap(),
        )
        .unwrap();
        assert!(
            !json.contains("ENDPOINT-AUTHORED-CANARY"),
            "an adapter's note reached the renderer: {json}"
        );
    }
}
