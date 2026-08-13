//! The one error taxonomy.
//!
//! # THE LOAD-BEARING RULE OF THIS FILE
//!
//! Every failure of every backend — a refused connection, a 401, a 400 with an
//! OpenAI error body, a stream that stalls, a frame that will not parse —
//! normalises into exactly one of these variants **before** it leaves this
//! crate. Nothing above this layer may switch on an HTTP status, a provider id,
//! or an upstream error string, because doing so would put provider-specific
//! knowledge in code that is supposed to be provider-agnostic.
//!
//! Two consequences the router depends on:
//!
//! * [`ProviderError::allows_failover`] — a transport failure or a rate limit
//!   may be worth trying on the next candidate. An auth failure or a missing
//!   capability never is: the next candidate has different credentials and
//!   different capabilities, so "try again elsewhere" turns one honest error
//!   into a burst of dishonest ones.
//! * [`ProviderError::allows_retry`] — only failures that are plausibly
//!   transient on the *same* endpoint.
//!
//! ## Detail strings
//!
//! `detail` is a short, sanitised diagnostic, never a raw upstream body:
//! `conventions.md` §3.2 forbids raw response bodies reaching the renderer, and
//! an unbounded body is also a fine place for a leaked credential to hide.
//! Build every one with [`detail`], which truncates and strips control
//! characters.

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// The capability vocabulary shared by errors, degradations and probes.
///
/// The UI renders these; it never renders a provider name. Adding a backend
/// must not add a variant here unless it adds a genuinely new *user-visible
/// affordance*.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Capability {
    Streaming,
    Vision,
    ToolCalling,
    StructuredOutput,
    Reasoning,
    ModelListing,
    UsageReporting,
    PromptCaching,
}

impl Capability {
    /// A stable, provider-neutral identifier for logs and UI strings.
    pub const fn code(self) -> &'static str {
        match self {
            Capability::Streaming => "streaming",
            Capability::Vision => "vision",
            Capability::ToolCalling => "tool_calling",
            Capability::StructuredOutput => "structured_output",
            Capability::Reasoning => "reasoning",
            Capability::ModelListing => "model_listing",
            Capability::UsageReporting => "usage_reporting",
            Capability::PromptCaching => "prompt_caching",
        }
    }
}

impl std::fmt::Display for Capability {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

/// How the transport failed. Kept separate from the HTTP status: a status is a
/// *response*, and most of these mean no usable response ever arrived.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransportFailure {
    /// DNS, connection refused, TLS handshake — never reached the application.
    Connect,
    /// The request as a whole exceeded its deadline.
    Timeout,
    /// Bytes stopped arriving mid-body for longer than the stall timeout.
    /// MEASURED-1: every stream read carries one of these so a wedged socket
    /// cannot wedge the app.
    Stalled,
    /// The connection died mid-exchange. GATE M FINDING 1: a reset on a large
    /// POST may be a size-limit rejection, not a dead endpoint — so this is
    /// never reported as "the endpoint is down".
    Reset,
    /// A 5xx, or a response Vela could not use at the HTTP level.
    Server { status: u16 },
    /// A 4xx that is not one of the modelled cases — or a **3xx the transport
    /// refused to follow**, which is likewise a response about this request
    /// rather than a sick network: the same request earns the same `Location`
    /// back, so it must never be retried. See `http::redirect_policy`.
    Request { status: u16 },
}

impl TransportFailure {
    pub const fn code(self) -> &'static str {
        match self {
            TransportFailure::Connect => "connect",
            TransportFailure::Timeout => "timeout",
            TransportFailure::Stalled => "stalled",
            TransportFailure::Reset => "reset",
            TransportFailure::Server { .. } => "server",
            TransportFailure::Request { .. } => "request",
        }
    }

    /// Whether hitting the same endpoint again could plausibly work.
    pub const fn is_transient(self) -> bool {
        match self {
            TransportFailure::Connect
            | TransportFailure::Timeout
            | TransportFailure::Stalled
            | TransportFailure::Reset
            | TransportFailure::Server { .. } => true,
            TransportFailure::Request { .. } => false,
        }
    }
}

/// The normalised failure of any provider operation.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProviderError {
    /// The prompt (plus requested completion) does not fit. All four matrix
    /// profiles answer this cleanly, so it is modelled precisely: the UI can
    /// say "this conversation is N tokens over the model's M-token window".
    #[error("the request does not fit the model's context window: {detail}")]
    ContextLengthExceeded {
        limit_tokens: Option<u32>,
        requested_tokens: Option<u32>,
        detail: String,
    },
    /// The credential was rejected — or an empty one was sent, which the
    /// harness answers 401 `empty_authorization_header` precisely so that bug
    /// is loud. Never produced by "no credential configured": that is a valid
    /// state, see [`vela_core::auth`].
    #[error("the endpoint rejected the credential: {detail}")]
    AuthFailed { detail: String },
    #[error("the endpoint is rate limiting this client: {detail}")]
    RateLimited {
        /// From `Retry-After`, when the endpoint sent one.
        retry_after_ms: Option<u64>,
        detail: String,
    },
    #[error("the endpoint does not serve the model `{model_id}`: {detail}")]
    ModelNotFound { model_id: String, detail: String },
    /// The affordance the caller asked for is not available on this model. This
    /// is how Vela refuses rather than silently producing wrong output.
    #[error("this model does not support {capability}: {detail}")]
    CapabilityUnsupported {
        capability: Capability,
        detail: String,
    },
    #[error("could not reach the endpoint ({failure}): {detail}")]
    Transport {
        failure: TransportFailure,
        detail: String,
    },
    /// The endpoint answered, and the answer could not be understood at all.
    /// Note that a *single* malformed SSE frame never produces this — those are
    /// skipped, per MEASURED-2.
    #[error("the endpoint returned a response Vela could not read: {detail}")]
    MalformedResponse { detail: String },
    /// The caller cancelled. Not a failure of the endpoint; never retried,
    /// never failed over.
    #[error("cancelled")]
    Cancelled,
}

impl std::fmt::Display for TransportFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

pub type ProviderResult<T> = Result<T, ProviderError>;

/// Longest `detail` this crate will ever construct.
///
/// Long enough for an endpoint's own error message, short enough that a raw
/// body, a stack trace or a pasted credential cannot ride along.
pub const MAX_DETAIL_CHARS: usize = 200;

/// Build a `detail` string: single-line, control-free, bounded.
///
/// Every construction site in this crate goes through here, so no path exists
/// that copies an upstream body verbatim into an error the renderer will see.
pub fn detail(raw: impl AsRef<str>) -> String {
    let mut out = String::with_capacity(MAX_DETAIL_CHARS);
    let mut last_was_space = false;
    for ch in raw.as_ref().chars() {
        let ch = if ch.is_control() { ' ' } else { ch };
        if ch == ' ' {
            if last_was_space || out.is_empty() {
                continue;
            }
            last_was_space = true;
        } else {
            last_was_space = false;
        }
        if out.chars().count() >= MAX_DETAIL_CHARS {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    let trimmed = out.trim_end();
    if trimmed.len() == out.len() {
        out
    } else {
        trimmed.to_owned()
    }
}

impl ProviderError {
    /// A stable machine code. The UI may switch on this; it may not parse
    /// `detail`.
    pub const fn code(&self) -> &'static str {
        match self {
            ProviderError::ContextLengthExceeded { .. } => "context_length_exceeded",
            ProviderError::AuthFailed { .. } => "auth_failed",
            ProviderError::RateLimited { .. } => "rate_limited",
            ProviderError::ModelNotFound { .. } => "model_not_found",
            ProviderError::CapabilityUnsupported { .. } => "capability_unsupported",
            ProviderError::Transport { .. } => "transport",
            ProviderError::MalformedResponse { .. } => "malformed_response",
            ProviderError::Cancelled => "cancelled",
        }
    }

    /// May the router try the *next* candidate?
    ///
    /// Transport and rate-limit failures say something about this endpoint;
    /// another endpoint may be fine. Auth, capability, context and
    /// model-not-found say something about the *request* or the user's
    /// configuration — re-sending it elsewhere is wrong, and in the auth case
    /// it sprays a credential-shaped failure across every configured backend.
    pub const fn allows_failover(&self) -> bool {
        match self {
            ProviderError::Transport { .. } | ProviderError::RateLimited { .. } => true,
            // A backend that emits unreadable bytes is broken in a way another
            // backend may not be, so failover is allowed — but see
            // `allows_retry`: repeating it against the same endpoint is not.
            ProviderError::MalformedResponse { .. } => true,
            ProviderError::ContextLengthExceeded { .. }
            | ProviderError::AuthFailed { .. }
            | ProviderError::ModelNotFound { .. }
            | ProviderError::CapabilityUnsupported { .. }
            | ProviderError::Cancelled => false,
        }
    }

    /// May the router retry the *same* candidate after a backoff?
    pub const fn allows_retry(&self) -> bool {
        match self {
            ProviderError::Transport { failure, .. } => failure.is_transient(),
            ProviderError::RateLimited { .. } => true,
            _ => false,
        }
    }

    /// The endpoint's own advice about when to come back, if it gave any.
    pub fn retry_after(&self) -> Option<Duration> {
        match self {
            ProviderError::RateLimited { retry_after_ms, .. } => {
                retry_after_ms.map(Duration::from_millis)
            }
            _ => None,
        }
    }

    pub fn transport(failure: TransportFailure, raw: impl AsRef<str>) -> Self {
        ProviderError::Transport {
            failure,
            detail: detail(raw),
        }
    }

    pub fn malformed(raw: impl AsRef<str>) -> Self {
        ProviderError::MalformedResponse {
            detail: detail(raw),
        }
    }

    pub fn unsupported(capability: Capability, raw: impl AsRef<str>) -> Self {
        ProviderError::CapabilityUnsupported {
            capability,
            detail: detail(raw),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_and_capability_failures_are_never_failed_over_or_retried() {
        let auth = ProviderError::AuthFailed {
            detail: detail("401"),
        };
        let capability = ProviderError::unsupported(Capability::Vision, "no image input");
        for error in [&auth, &capability] {
            assert!(
                !error.allows_failover(),
                "{error:?} must not be sprayed at other candidates"
            );
            assert!(!error.allows_retry(), "{error:?} must not be retried");
        }
    }

    #[test]
    fn transport_and_rate_limit_failures_are_the_failover_cases() {
        let transport = ProviderError::transport(TransportFailure::Connect, "refused");
        let limited = ProviderError::RateLimited {
            retry_after_ms: Some(1_500),
            detail: detail("slow down"),
        };
        assert!(transport.allows_failover() && transport.allows_retry());
        assert!(limited.allows_failover() && limited.allows_retry());
        assert_eq!(limited.retry_after(), Some(Duration::from_millis(1_500)));
    }

    #[test]
    fn a_4xx_that_is_not_modelled_is_not_transient() {
        let error = ProviderError::transport(TransportFailure::Request { status: 422 }, "no");
        assert!(error.allows_failover(), "another endpoint may accept it");
        assert!(
            !error.allows_retry(),
            "repeating an identical rejected request is pointless"
        );
    }

    #[test]
    fn malformed_bytes_fail_over_but_are_never_repeated_at_the_same_endpoint() {
        let error = ProviderError::malformed("not json");
        assert!(error.allows_failover());
        assert!(!error.allows_retry());
    }

    #[test]
    fn detail_is_bounded_single_line_and_control_free() {
        let raw = format!("line one\nline\ttwo {}", "x".repeat(500));
        let out = detail(&raw);
        assert!(!out.contains('\n') && !out.contains('\t'));
        assert!(
            out.chars().count() <= MAX_DETAIL_CHARS + 1,
            "got {} chars",
            out.chars().count()
        );
        assert!(out.ends_with('…'), "truncation must be visible: {out}");
    }

    #[test]
    fn every_error_has_a_stable_code_the_ui_can_switch_on() {
        let codes = [
            ProviderError::ContextLengthExceeded {
                limit_tokens: Some(8_192),
                requested_tokens: Some(9_000),
                detail: String::new(),
            }
            .code(),
            ProviderError::AuthFailed {
                detail: String::new(),
            }
            .code(),
            ProviderError::RateLimited {
                retry_after_ms: None,
                detail: String::new(),
            }
            .code(),
            ProviderError::ModelNotFound {
                model_id: "m".into(),
                detail: String::new(),
            }
            .code(),
            ProviderError::unsupported(Capability::ToolCalling, "").code(),
            ProviderError::transport(TransportFailure::Timeout, "").code(),
            ProviderError::malformed("").code(),
            ProviderError::Cancelled.code(),
        ];
        let unique: std::collections::BTreeSet<_> = codes.iter().collect();
        assert_eq!(unique.len(), codes.len(), "codes must be distinct");
        assert!(codes.contains(&"context_length_exceeded"));
    }

    #[test]
    fn errors_serialise_camel_case_for_the_ipc_layer() {
        let json = serde_json::to_value(ProviderError::ContextLengthExceeded {
            limit_tokens: Some(4_096),
            requested_tokens: Some(5_000),
            detail: detail("too long"),
        })
        .unwrap();
        assert_eq!(json["kind"], "contextLengthExceeded");
        assert_eq!(json["limitTokens"], 4_096);
    }
}
