//! What a model can actually do — established by asking it.
//!
//! # THE LOAD-BEARING RULE OF THIS FILE (MEASURED-5)
//!
//! `mid-local`, `small-local` and `hostile` all accept `response_format:
//! json_schema`, answer **200 OK**, and return prose. Nothing in the response
//! says the schema was ignored: no field, no warning, no code. A capability
//! table keyed on a provider name would therefore be wrong in the most
//! dangerous possible way — silently. So capabilities are *probed*, and a
//! capability that has not been probed is [`Support::Unknown`], never `true`.
//!
//! # Reading this from the UI
//!
//! The UI reads [`ModelCapabilities::to_descriptor`] — a plain flag set with no
//! provider identity in it at all. `if (capabilities.vision)` is the only kind
//! of branch allowed; `if (provider.id === …)` is a review-blocking change
//! (`conventions.md` §0.3).

use serde::{Deserialize, Serialize};
use vela_core::provider::ProviderCapabilities;

use crate::error::Capability;

/// Three-valued, plus a fourth for "works, but not reliably".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Support {
    /// Not established. **The starting value for everything.**
    #[default]
    Unknown,
    Unsupported,
    Supported,
    /// The endpoint answers, but wrongly or unreliably — `hostile`'s tool calls
    /// arrive malformed. The affordance may still be offered *if* every failure
    /// is explicit; it must never be offered when the failure would be silent.
    Degraded,
}

impl Support {
    /// May the UI offer this affordance?
    ///
    /// `Degraded` is `true` only where breakage is loud: a malformed tool call
    /// becomes a visible error. Structured output is the opposite case, and
    /// [`ModelCapabilities::to_descriptor`] handles it explicitly.
    pub const fn is_offerable(self) -> bool {
        matches!(self, Support::Supported | Support::Degraded)
    }

    pub const fn is_known(self) -> bool {
        !matches!(self, Support::Unknown)
    }
}

/// How a capability came to be believed. Recorded so a report can never claim a
/// probe happened when a default was used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Evidence {
    /// A request was sent and the answer was examined.
    Probed,
    /// The endpoint declared it (e.g. `/props` reporting `n_ctx`).
    Declared,
    /// Carried over from a previous probe of the same model.
    Cached,
    /// Nothing was established.
    Unprobed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityFinding {
    pub capability: Capability,
    pub support: Support,
    pub evidence: Evidence,
    /// Provider-neutral note for diagnostics, e.g. "returned prose for a
    /// json_schema request".
    pub note: String,
}

/// The probed truth about one model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapabilities {
    pub model_id: String,
    pub streaming: Support,
    pub tool_calling: Support,
    pub vision: Support,
    pub structured_output: Support,
    pub reasoning: Support,
    pub model_listing: Support,
    pub usage_reporting: Support,
    pub prompt_caching: Support,
    /// The model's context window in tokens, when the endpoint reports one.
    /// `None` means unknown — never a guessed default.
    pub context_window_tokens: Option<u32>,
    pub max_output_tokens: Option<u32>,
    pub findings: Vec<CapabilityFinding>,
}

impl ModelCapabilities {
    /// The honest starting point: nothing is known.
    pub fn unknown(model_id: impl Into<String>) -> Self {
        Self {
            model_id: model_id.into(),
            streaming: Support::Unknown,
            tool_calling: Support::Unknown,
            vision: Support::Unknown,
            structured_output: Support::Unknown,
            reasoning: Support::Unknown,
            model_listing: Support::Unknown,
            usage_reporting: Support::Unknown,
            prompt_caching: Support::Unknown,
            context_window_tokens: None,
            max_output_tokens: None,
            findings: Vec::new(),
        }
    }

    pub fn get(&self, capability: Capability) -> Support {
        match capability {
            Capability::Streaming => self.streaming,
            Capability::ToolCalling => self.tool_calling,
            Capability::Vision => self.vision,
            Capability::StructuredOutput => self.structured_output,
            Capability::Reasoning => self.reasoning,
            Capability::ModelListing => self.model_listing,
            Capability::UsageReporting => self.usage_reporting,
            Capability::PromptCaching => self.prompt_caching,
        }
    }

    pub fn set(
        &mut self,
        capability: Capability,
        support: Support,
        evidence: Evidence,
        note: impl Into<String>,
    ) -> &mut Self {
        match capability {
            Capability::Streaming => self.streaming = support,
            Capability::ToolCalling => self.tool_calling = support,
            Capability::Vision => self.vision = support,
            Capability::StructuredOutput => self.structured_output = support,
            Capability::Reasoning => self.reasoning = support,
            Capability::ModelListing => self.model_listing = support,
            Capability::UsageReporting => self.usage_reporting = support,
            Capability::PromptCaching => self.prompt_caching = support,
        }
        self.findings.push(CapabilityFinding {
            capability,
            support,
            evidence,
            note: note.into(),
        });
        self
    }

    /// The flag set the UI branches on.
    ///
    /// Two rules are encoded here and nowhere else:
    ///
    /// * `Unknown` is `false`. An unprobed capability must not be offered — the
    ///   gate criterion counts "offers an affordance the profile cannot
    ///   support" as a failure.
    /// * `Degraded` structured output is `false`, unlike every other degraded
    ///   capability. MEASURED-5: its failure mode is *silent wrong output*, so
    ///   the affordance is withdrawn rather than offered with a warning.
    pub fn to_descriptor(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            streaming: self.streaming.is_offerable(),
            vision: self.vision.is_offerable(),
            tool_calls: self.tool_calling.is_offerable(),
            reasoning: self.reasoning.is_offerable(),
            model_listing: self.model_listing.is_offerable(),
            usage_reporting: self.usage_reporting.is_offerable(),
            prompt_caching: self.prompt_caching.is_offerable(),
        }
    }

    /// May a structured-output request be *sent* to this model?
    pub fn honours_structured_output(&self) -> bool {
        self.structured_output == Support::Supported
    }

    /// Does this model need tool-call emulation to be offered tools at all?
    pub fn needs_tool_emulation(&self) -> bool {
        matches!(self.tool_calling, Support::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_is_believed_until_it_is_probed() {
        let capabilities = ModelCapabilities::unknown("m");
        let descriptor = capabilities.to_descriptor();
        assert_eq!(descriptor, ProviderCapabilities::minimal());
        assert!(
            !descriptor.tool_calls && !descriptor.vision,
            "an unprobed capability must never be offered"
        );
    }

    #[test]
    fn degraded_tool_calling_is_offered_because_its_failures_are_loud() {
        let mut capabilities = ModelCapabilities::unknown("m");
        capabilities.set(
            Capability::ToolCalling,
            Support::Degraded,
            Evidence::Probed,
            "calls arrive malformed",
        );
        assert!(
            capabilities.to_descriptor().tool_calls,
            "a malformed call is surfaced as an explicit error, so the affordance stays"
        );
    }

    #[test]
    fn degraded_structured_output_is_withdrawn_because_its_failure_is_silent() {
        let mut capabilities = ModelCapabilities::unknown("m");
        capabilities.set(
            Capability::StructuredOutput,
            Support::Degraded,
            Evidence::Probed,
            "returned prose for a json_schema request",
        );
        assert!(
            !capabilities.honours_structured_output(),
            "MEASURED-5: 200 OK with prose is the dangerous case"
        );
    }

    #[test]
    fn findings_record_how_each_belief_was_reached() {
        let mut capabilities = ModelCapabilities::unknown("m");
        capabilities.set(
            Capability::Vision,
            Support::Unsupported,
            Evidence::Probed,
            "400 vision_not_supported",
        );
        assert_eq!(capabilities.findings.len(), 1);
        assert_eq!(capabilities.findings[0].evidence, Evidence::Probed);
        assert_eq!(capabilities.get(Capability::Vision), Support::Unsupported);
    }

    #[test]
    fn the_descriptor_carries_no_provider_identity_at_all() {
        let json =
            serde_json::to_value(ModelCapabilities::unknown("secret-model-name").to_descriptor())
                .unwrap();
        let text = json.to_string();
        assert!(
            !text.contains("secret-model-name"),
            "the UI flag set must not carry backend identity: {text}"
        );
    }
}
