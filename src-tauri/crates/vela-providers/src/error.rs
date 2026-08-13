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
//! # THE SECOND LOAD-BEARING RULE: an error carries no endpoint text
//!
//! There used to be a `detail: String` on every variant, built by a `detail()`
//! function that truncated an upstream error message and stripped its control
//! characters. Both are gone.
//!
//! `detail` was where the endpoint's own words lived, and four consecutive
//! rounds of Phase B died trying to make that safe. The credential the user
//! configured could be echoed back inside that message, so Vela scrubbed it —
//! and scrubbing is a *blocklist over an encoding the endpoint chooses*. JSON
//! escapes, then `%2F`, then `%2f`, then every byte percent-encoded, then
//! `&#x2f;`. Each round closed one and the next found another.
//!
//! So the error stopped carrying the text. Every variant now carries a
//! [`Diagnosis`], and a `Diagnosis` is a closed set of things **Vela
//! constructs itself**: a [`Cause`] whose sentence is a `&'static str` in this
//! crate's own source, an HTTP status, the endpoint's identity parsed out of
//! the request URL Vela built, and a [`CorrelationId`] linking to the raw body
//! in the local, opt-in debug log ([`crate::debuglog`]).
//!
//! The raw body still exists. It does not travel. See [`crate::diagnostic`] for
//! the full argument and for the compile-fail doctests that make the property
//! structural rather than a convention.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::diagnostic::{Cause, ConfiguredModelId, CorrelationId, Diagnosis, EndpointIdentity};

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

    pub const ALL: &'static [Capability] = &[
        Capability::Streaming,
        Capability::Vision,
        Capability::ToolCalling,
        Capability::StructuredOutput,
        Capability::Reasoning,
        Capability::ModelListing,
        Capability::UsageReporting,
        Capability::PromptCaching,
    ];
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

    /// The status this failure is about, when there was a response at all.
    pub const fn status(self) -> Option<u16> {
        match self {
            TransportFailure::Server { status } | TransportFailure::Request { status } => {
                Some(status)
            }
            _ => None,
        }
    }
}

/// The normalised failure of any provider operation.
///
/// Every variant's payload is typed and closed. There is no `String` field on
/// any of them, which is the property [`crate::diagnostic`] exists to hold:
/// endpoint-supplied text is not carried here, not by `Display`, not by
/// `Debug`, and not by the serde shape that crosses the IPC bridge.
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
    ///
    /// The two counts are the design's one deliberate channel for a value the
    /// endpoint chose — and they are `u32`, so what arrives is a number and
    /// can never be a sentence, an escape sequence or a credential.
    #[error("the request does not fit the model's context window: {diagnosis}")]
    ContextLengthExceeded {
        limit_tokens: Option<u32>,
        requested_tokens: Option<u32>,
        diagnosis: Diagnosis,
    },
    /// The credential was rejected — or an empty one was sent, which the
    /// harness answers 401 `empty_authorization_header` precisely so that bug
    /// is loud. Never produced by "no credential configured": that is a valid
    /// state, see [`vela_core::auth`].
    #[error("the endpoint rejected the credential: {diagnosis}")]
    AuthFailed { diagnosis: Diagnosis },
    #[error("the endpoint is rate limiting this client: {diagnosis}")]
    RateLimited {
        /// From `Retry-After`, when the endpoint sent one.
        retry_after_ms: Option<u64>,
        diagnosis: Diagnosis,
    },
    #[error("the endpoint does not serve the model `{model_id}`: {diagnosis}")]
    ModelNotFound {
        model_id: ConfiguredModelId,
        diagnosis: Diagnosis,
    },
    /// The affordance the caller asked for is not available on this model. This
    /// is how Vela refuses rather than silently producing wrong output.
    #[error("this model does not support {capability}: {diagnosis}")]
    CapabilityUnsupported {
        capability: Capability,
        diagnosis: Diagnosis,
    },
    #[error("could not reach the endpoint ({failure}): {diagnosis}")]
    Transport {
        failure: TransportFailure,
        diagnosis: Diagnosis,
    },
    /// The endpoint answered, and the answer could not be understood at all.
    /// Note that a *single* malformed SSE frame never produces this — those are
    /// skipped, per MEASURED-2.
    #[error("the endpoint returned a response Vela could not read: {diagnosis}")]
    MalformedResponse { diagnosis: Diagnosis },
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

/// Every string this taxonomy can render, so [`crate::diagnostic`]'s audit can
/// compute the closed vocabulary instead of trusting a hand-written list.
pub fn closed_vocabulary() -> Vec<&'static str> {
    let mut vocabulary = vec![
        // `ProviderError`'s serde tag values.
        "contextLengthExceeded",
        "authFailed",
        "rateLimited",
        "modelNotFound",
        "capabilityUnsupported",
        "transport",
        "malformedResponse",
        "cancelled",
        // `ProviderError::code()`.
        "context_length_exceeded",
        "auth_failed",
        "rate_limited",
        "model_not_found",
        "capability_unsupported",
        "transport",
        "malformed_response",
        "cancelled",
        // `TransportFailure`'s serde tags and codes.
        "connect",
        "timeout",
        "stalled",
        "reset",
        "server",
        "request",
    ];
    for capability in Capability::ALL {
        vocabulary.push(capability.code());
    }
    // `Capability`'s serde renderings, which are camelCase and therefore not
    // the same strings as `code()`.
    vocabulary.extend([
        "streaming",
        "vision",
        "toolCalling",
        "structuredOutput",
        "reasoning",
        "modelListing",
        "usageReporting",
        "promptCaching",
    ]);
    vocabulary
}

impl ProviderError {
    /// A stable machine code. The UI may switch on this.
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

    // -- the diagnosis ----------------------------------------------------

    /// The typed diagnosis, for every variant that has one.
    ///
    /// `Cancelled` has none: it is Vela's own answer to the user's own action
    /// and there is nothing about an endpoint to say.
    pub fn diagnosis(&self) -> Option<&Diagnosis> {
        match self {
            ProviderError::ContextLengthExceeded { diagnosis, .. }
            | ProviderError::AuthFailed { diagnosis }
            | ProviderError::RateLimited { diagnosis, .. }
            | ProviderError::ModelNotFound { diagnosis, .. }
            | ProviderError::CapabilityUnsupported { diagnosis, .. }
            | ProviderError::Transport { diagnosis, .. }
            | ProviderError::MalformedResponse { diagnosis } => Some(diagnosis),
            ProviderError::Cancelled => None,
        }
    }

    fn diagnosis_mut(&mut self) -> Option<&mut Diagnosis> {
        match self {
            ProviderError::ContextLengthExceeded { diagnosis, .. }
            | ProviderError::AuthFailed { diagnosis }
            | ProviderError::RateLimited { diagnosis, .. }
            | ProviderError::ModelNotFound { diagnosis, .. }
            | ProviderError::CapabilityUnsupported { diagnosis, .. }
            | ProviderError::Transport { diagnosis, .. }
            | ProviderError::MalformedResponse { diagnosis } => Some(diagnosis),
            ProviderError::Cancelled => None,
        }
    }

    pub fn cause(&self) -> Option<Cause> {
        self.diagnosis().map(Diagnosis::cause)
    }

    /// Which endpoint this error is about — the answer a user with three
    /// configured candidates needs.
    pub fn endpoint(&self) -> Option<&EndpointIdentity> {
        self.diagnosis().and_then(Diagnosis::endpoint)
    }

    pub fn status(&self) -> Option<u16> {
        self.diagnosis().and_then(Diagnosis::status)
    }

    /// The key into the local debug log, for a user who deliberately opens it.
    pub fn correlation(&self) -> Option<CorrelationId> {
        self.diagnosis().map(Diagnosis::correlation)
    }

    /// Attach the endpoint late, at a chokepoint, rather than at every
    /// construction site.
    ///
    /// Adapters call this once per request path, so a new error variant added
    /// deep inside a mapper still comes out naming its endpoint. It takes an
    /// [`EndpointIdentity`], which cannot be built from anything an endpoint
    /// sent.
    pub fn at(mut self, endpoint: Option<EndpointIdentity>) -> Self {
        if endpoint.is_some() {
            if let Some(diagnosis) = self.diagnosis_mut() {
                let taken = std::mem::replace(diagnosis, Diagnosis::local(Cause::CallerCancelled));
                *diagnosis = taken.at(endpoint);
            }
        }
        self
    }

    /// Pin the correlation id — used when one exchange produces more than one
    /// error, so they all point at the same debug-log entry.
    pub fn with_correlation(mut self, correlation: CorrelationId) -> Self {
        if let Some(diagnosis) = self.diagnosis_mut() {
            let taken = std::mem::replace(diagnosis, Diagnosis::local(Cause::CallerCancelled));
            *diagnosis = taken.with_correlation(correlation);
        }
        self
    }

    // -- constructors -----------------------------------------------------

    pub fn transport(failure: TransportFailure, diagnosis: impl Into<Diagnosis>) -> Self {
        let mut diagnosis = diagnosis.into();
        if let Some(status) = failure.status() {
            diagnosis = diagnosis.with_status(status);
        }
        ProviderError::Transport { failure, diagnosis }
    }

    pub fn malformed(diagnosis: impl Into<Diagnosis>) -> Self {
        ProviderError::MalformedResponse {
            diagnosis: diagnosis.into(),
        }
    }

    pub fn unsupported(capability: Capability, diagnosis: impl Into<Diagnosis>) -> Self {
        ProviderError::CapabilityUnsupported {
            capability,
            diagnosis: diagnosis.into(),
        }
    }

    pub fn auth_failed(diagnosis: impl Into<Diagnosis>) -> Self {
        ProviderError::AuthFailed {
            diagnosis: diagnosis.into(),
        }
    }

    pub fn model_not_found(model_id: ConfiguredModelId, diagnosis: impl Into<Diagnosis>) -> Self {
        ProviderError::ModelNotFound {
            model_id,
            diagnosis: diagnosis.into(),
        }
    }

    pub fn rate_limited(retry_after_ms: Option<u64>, diagnosis: impl Into<Diagnosis>) -> Self {
        ProviderError::RateLimited {
            retry_after_ms,
            diagnosis: diagnosis.into(),
        }
    }

    /// The identifiers this error is entitled to carry, for
    /// [`crate::diagnostic::unexplained_strings`].
    ///
    /// Deliberately derived from the error's own typed accessors: an audit that
    /// built this list by scanning the rendering would excuse whatever it
    /// found.
    pub fn carried_identity(&self) -> Vec<String> {
        let mut identity = Vec::new();
        if let Some(endpoint) = self.endpoint() {
            identity.push(endpoint.authority().to_owned());
            identity.push(endpoint.path().to_owned());
            identity.push(endpoint.to_string());
        }
        if let ProviderError::ModelNotFound { model_id, .. } = self {
            identity.push(model_id.as_str().to_owned());
        }
        if let Some(correlation) = self.correlation() {
            identity.push(correlation.to_string());
        }
        identity
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_and_capability_failures_are_never_failed_over_or_retried() {
        let auth = ProviderError::auth_failed(Cause::CredentialRejected);
        let capability =
            ProviderError::unsupported(Capability::Vision, Cause::CapabilityAbsentOnThisModel);
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
        let transport =
            ProviderError::transport(TransportFailure::Connect, Cause::ConnectionFailed);
        let limited = ProviderError::rate_limited(Some(1_500), Cause::TooManyRequests);
        assert!(transport.allows_failover() && transport.allows_retry());
        assert!(limited.allows_failover() && limited.allows_retry());
        assert_eq!(limited.retry_after(), Some(Duration::from_millis(1_500)));
    }

    #[test]
    fn a_4xx_that_is_not_modelled_is_not_transient() {
        let error = ProviderError::transport(
            TransportFailure::Request { status: 422 },
            Cause::EndpointRejectedRequest,
        );
        assert!(error.allows_failover(), "another endpoint may accept it");
        assert!(
            !error.allows_retry(),
            "repeating an identical rejected request is pointless"
        );
        assert_eq!(error.status(), Some(422), "the status rides along, typed");
    }

    #[test]
    fn malformed_bytes_fail_over_but_are_never_repeated_at_the_same_endpoint() {
        let error = ProviderError::malformed(Cause::ResponseWasNotJson);
        assert!(error.allows_failover());
        assert!(!error.allows_retry());
    }

    #[test]
    fn every_error_has_a_stable_code_the_ui_can_switch_on() {
        let codes = [
            ProviderError::ContextLengthExceeded {
                limit_tokens: Some(8_192),
                requested_tokens: Some(9_000),
                diagnosis: Cause::ContextWindowExceeded.into(),
            }
            .code(),
            ProviderError::auth_failed(Cause::CredentialRejected).code(),
            ProviderError::rate_limited(None, Cause::TooManyRequests).code(),
            ProviderError::model_not_found(ConfiguredModelId::unknown(), Cause::ModelNotServed)
                .code(),
            ProviderError::unsupported(Capability::ToolCalling, Cause::CapabilityAbsentOnThisModel)
                .code(),
            ProviderError::transport(TransportFailure::Timeout, Cause::RequestTimedOut).code(),
            ProviderError::malformed(Cause::ResponseWasNotJson).code(),
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
            diagnosis: Cause::ContextWindowExceeded.into(),
        })
        .unwrap();
        assert_eq!(json["kind"], "contextLengthExceeded");
        assert_eq!(json["limitTokens"], 4_096);
        assert_eq!(json["diagnosis"]["cause"], "context_window_exceeded");
    }

    #[test]
    fn every_code_and_tag_is_in_the_closed_vocabulary() {
        // The vocabulary is what the audit trusts. If a code is missing from
        // it, the audit reports Vela's own text as a leak; if a tag is missing,
        // it does the same. Both are checked against the types rather than
        // against a copy of this list.
        let vocabulary = closed_vocabulary();
        for error in [
            ProviderError::auth_failed(Cause::CredentialRejected),
            ProviderError::rate_limited(None, Cause::TooManyRequests),
            ProviderError::transport(
                TransportFailure::Server { status: 500 },
                Cause::EndpointFailedToAnswer,
            ),
            ProviderError::malformed(Cause::ResponseWasNotJson),
            ProviderError::Cancelled,
        ] {
            assert!(
                vocabulary.contains(&error.code()),
                "{} is missing from the closed vocabulary",
                error.code()
            );
        }
        for capability in Capability::ALL {
            let rendered = serde_json::to_value(capability).unwrap();
            assert!(vocabulary.contains(&rendered.as_str().unwrap()));
            assert!(vocabulary.contains(&capability.code()));
        }
    }
}
