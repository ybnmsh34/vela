//! # vela-endpoint
//!
//! **Vela's configured brain, served to other tools.** One port, two dialects
//! routed by path, one shared bearer key:
//!
//! | path | dialect | status |
//! |---|---|---|
//! | `POST /v1/messages` | Anthropic Messages | served |
//! | `POST /v1/chat/completions` | OpenAI chat completions | served |
//! | `GET /v1/models` | OpenAI | served |
//! | `POST /v1/responses` | OpenAI Responses | routed, `501` |
//!
//! The shape comes from `docs/references/unsloth-studio.md` §1, which records
//! it verbatim: "Unsloth speaks two dialects on the same port… You don't need
//! to run different servers for the two formats."
//!
//! ## What this crate is, structurally
//!
//! A translator with a listener attached. Requests in either dialect become
//! `vela_providers::ChatRequest`; the six `StreamEvent`s that come back become
//! SSE frames in the dialect the request arrived in. Vela's own vocabulary is
//! the pivot, so neither dialect is privileged and neither is translated
//! directly into the other — see [`tool_choice`] for the one place that
//! distinction is load-bearing and tested.
//!
//! What sits behind it is a [`Brain`](brain::Brain): three methods, no HTTP, no
//! provider registry, no settings. The production implementation wraps
//! whichever `vela_providers::Provider` the user configured; a test's
//! implementation is a closure. That seam is why every test in this crate can
//! drive the real translation without a model.
//!
//! ## The security rule
//!
//! [`policy`] holds the bind-address tool policy, which is the one thing in
//! this crate that is a security boundary rather than a format. Read that
//! module before changing anything about how a request's tools are handled.
//!
//! ## What is not built
//!
//! Stated here rather than left for a reader to discover:
//!
//!  - **`/v1/responses`** is routed and answered `501`. It is a different
//!    request and response shape, not a rename.
//!  - **Reasoning is not forwarded** in either dialect. Vela separates it into
//!    its own content part and this crate drops it.
//!  - **No TLS.** The listener is plain HTTP, which is correct for loopback and
//!    is a stated limitation anywhere else.
//!  - **No `/v1/models` per-model capability detail**, no embeddings, no
//!    completions-legacy path, no batching.

pub mod anthropic;
pub mod brain;
pub mod openai;
pub mod policy;
pub mod route;
pub mod server;
pub mod tool_choice;

pub use brain::{Brain, FnBrain};
pub use policy::{BindScope, ToolPolicy, ToolPolicyReason, ToolRequest};
pub use route::{Dialect, Endpoint};
pub use server::{EndpointConfig, ServerHandle};

use vela_providers::model::ChatRequest;
use vela_providers::ProviderError;

/// A request in either dialect, translated.
///
/// `stream` is carried separately rather than on the `ChatRequest` because it
/// is a fact about the *transport* the client asked for, not about the turn:
/// the same `ChatRequest` is sent to the brain either way, and only the
/// encoding of the answer differs.
#[derive(Debug, Clone, PartialEq)]
pub struct Decoded {
    pub chat: ChatRequest,
    pub stream: bool,
}

/// Why a body could not be read.
///
/// **A closed set with no free-text arm**, for the reason `ChatError` in
/// `src/platform/contract.ts` gives for the same decision: the detail belongs
/// in a local debug log, not in a string that a foreign client renders. Each
/// arm has a stable [`code`](DecodeError::code) that goes on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeError {
    NotJson,
    MissingModel,
    MissingMessages,
    BadRole,
    BadContentBlock,
    BadToolChoice,
    BadTool,
    BadImage,
}

impl DecodeError {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotJson => "invalid_request_not_json",
            Self::MissingModel => "invalid_request_missing_model",
            Self::MissingMessages => "invalid_request_missing_messages",
            Self::BadRole => "invalid_request_unknown_role",
            Self::BadContentBlock => "invalid_request_content_block",
            Self::BadToolChoice => "invalid_request_tool_choice",
            Self::BadTool => "invalid_request_tool",
            Self::BadImage => "invalid_request_image",
        }
    }
}

/// A provider failure as a stable code.
///
/// **The `Diagnosis` is deliberately not forwarded.** It carries the endpoint's
/// own words and the URL Vela addressed, which is Vela's operator's business
/// and not the business of whatever tool happens to be pointed at this port.
/// What crosses is one of eight words.
pub fn error_code(error: &ProviderError) -> &'static str {
    match error {
        ProviderError::ContextLengthExceeded { .. } => "context_length_exceeded",
        ProviderError::AuthFailed { .. } => "upstream_auth_failed",
        ProviderError::RateLimited { .. } => "rate_limited",
        ProviderError::ModelNotFound { .. } => "model_not_found",
        ProviderError::CapabilityUnsupported { .. } => "capability_unsupported",
        ProviderError::Transport { .. } => "upstream_unreachable",
        ProviderError::MalformedResponse { .. } => "upstream_malformed_response",
        ProviderError::Cancelled => "cancelled",
    }
}

/// The HTTP status a provider failure becomes.
///
/// `429` for rate limiting and `400` for a context overrun are the two a client
/// can act on; everything else is `502`, because from the client's side of this
/// port the failure happened somewhere upstream of the server it called.
pub fn error_status(error: &ProviderError) -> u16 {
    match error {
        ProviderError::ContextLengthExceeded { .. } => 400,
        ProviderError::RateLimited { .. } => 429,
        ProviderError::ModelNotFound { .. } => 404,
        ProviderError::CapabilityUnsupported { .. } => 400,
        ProviderError::Cancelled => 499,
        ProviderError::AuthFailed { .. }
        | ProviderError::Transport { .. }
        | ProviderError::MalformedResponse { .. } => 502,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vela_providers::diagnostic::{Cause, Diagnosis};

    #[test]
    fn every_decode_error_has_a_distinct_stable_code() {
        let codes = [
            DecodeError::NotJson,
            DecodeError::MissingModel,
            DecodeError::MissingMessages,
            DecodeError::BadRole,
            DecodeError::BadContentBlock,
            DecodeError::BadToolChoice,
            DecodeError::BadTool,
            DecodeError::BadImage,
        ]
        .map(DecodeError::code);
        let unique: std::collections::BTreeSet<&str> = codes.iter().copied().collect();
        assert_eq!(unique.len(), codes.len());
    }

    #[test]
    fn an_upstream_credential_failure_does_not_become_a_401_on_this_port() {
        // A `401` here would tell the caller *their* key was rejected, and
        // their key was fine — Vela's key for the model endpoint was not.
        let error = ProviderError::AuthFailed {
            diagnosis: Diagnosis::local(Cause::CredentialRejected),
        };
        assert_eq!(error_status(&error), 502);
        assert_eq!(error_code(&error), "upstream_auth_failed");
    }
}
