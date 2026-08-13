//! The typed, closed diagnosis an error carries — and the reason it carries
//! nothing else.
//!
//! # THE LOAD-BEARING RULE OF THIS FILE
//!
//! **Vela does not carry endpoint-supplied text.** Not "carries it redacted",
//! not "carries it scrubbed" — does not carry it.
//!
//! Four rounds of Phase B tried the other thing. Redaction was a *blocklist*
//! over text an untrusted endpoint chose the spelling of: Vela received an
//! error body written by a server it does not trust, searched it for spellings
//! of the user's credential, and forwarded the rest to [`std::fmt::Display`],
//! [`std::fmt::Debug`], the serde shape that crosses the IPC bridge, and the
//! UI. Each round closed the spelling the previous round found and the next
//! round found another: JSON string escapes, then percent-encoding with
//! uppercase hex, then percent-encoding with lowercase hex, then a credential
//! percent-encoded byte for byte, then HTML entities. Base64, `\uXXXX` mixtures
//! and case-folding were never even reached.
//!
//! A blocklist over an adversary-chosen encoding cannot be completed. So the
//! property changed:
//!
//! | | old | new |
//! |---|---|---|
//! | claim | untrusted bytes are carried but laundered | untrusted bytes are **not carried** |
//! | checked by | enumerating spellings | reading the type |
//! | defeated by | a spelling nobody thought of | nothing: there is no field to put text in |
//!
//! # What an error is allowed to contain
//!
//! Exactly four kinds of thing, and every one of them is Vela's own:
//!
//! 1. **A [`Cause`]** — one of a closed set of unit variants this file
//!    declares. Its user-facing sentence is a `&'static str` in a `match` arm
//!    *in this file*. An endpoint chooses which arm is taken; it never chooses
//!    what the arm says.
//! 2. **Integers** — an HTTP status, a token count, a `Retry-After` in
//!    milliseconds. Deliberately the one channel through which a *value* an
//!    endpoint chose reaches the user, because `u16`/`u32`/`u64` cannot spell a
//!    credential, an escape sequence, or a sentence.
//! 3. **An [`EndpointIdentity`]** — scheme, host, port and path of the endpoint
//!    *the user configured*, parsed out of a [`RequestUrl`]. Round 3 earned
//!    this and it stays: an error nobody can act on is its own kind of
//!    regression, and a user with three candidates configured has to be able to
//!    tell which one failed. Query string and userinfo are dropped entirely.
//! 4. **A [`CorrelationId`]** — a counter this process owns, which links the
//!    error to the raw body in the local, opt-in debug log
//!    ([`crate::debuglog`]). The body still exists; it does not travel.
//!
//! # Why this cannot be violated by accident
//!
//! * [`Cause`] has no variant with a `String` in it and no `From<&str>`. There
//!   is no `Cause::Other(text)`.
//! * [`EndpointIdentity`]'s fields are private and its only constructor takes a
//!   [`RequestUrl`] — the type a request is built from, which no response body
//!   can produce.
//! * [`ConfiguredModelId`]'s fields are private and its only non-empty
//!   constructor takes a [`ChatRequest`] — the request Vela sent, not the
//!   answer it got.
//! * [`Diagnosis`] has no constructor, setter or `From` impl that accepts a
//!   string of any kind.
//! * `error::detail()` — the function that used to sanitise upstream text into
//!   an error — **no longer exists**. The old shape does not compile.
//!
//! Six `compile_fail` doctests on this module pin each of those, and
//! `tests/typed_closed_error_surface.rs`'s
//! `no_error_in_the_whole_taxonomy_carries_an_unexplained_string` checks the
//! property from the other end at runtime: it walks an error's entire serde
//! rendering and fails on any string that is not either a field name, a code
//! drawn from one of the closed enums, or one of the two Vela-constructed
//! identifiers. Its own control is `the_vocabulary_audit_can_detect_a_planted_string`.
//!
//! # Honesty (conventions.md §10)
//!
//! **VERIFIED-BY-FAKE.** Everything asserted about this module was measured
//! against loopback peers, scripted byte sequences and `MemoryStore`. No real
//! model, no real keychain.

use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::model::ChatRequest;
use crate::redact::RequestUrl;

// ---------------------------------------------------------------------------
// Cause — the closed vocabulary
// ---------------------------------------------------------------------------

/// Why an operation failed, in Vela's words.
///
/// Every variant is a unit variant on purpose: a variant with a payload is a
/// place a future contributor could put a `String`, and this enum is the thing
/// that must not have one. The endpoint picks the arm. This file writes the
/// sentence.
///
/// Adding a variant is cheap and expected. Adding a *field* to one is the
/// change that needs an argument.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum Cause {
    // -- credentials -------------------------------------------------------
    /// The endpoint answered 401/403, or said so in a machine-readable code.
    CredentialRejected,
    /// The binding says to send a credential and the store has none.
    CredentialMissing,
    /// The OS credential store could not be read at all.
    CredentialStoreUnreadable,
    /// The credential store failed in a way Vela does not model.
    CredentialStoreFailed,

    // -- the model ---------------------------------------------------------
    /// The endpoint does not serve the requested model.
    ModelNotServed,
    /// A model-listing response arrived without the array it must have.
    ModelListMalformed,

    // -- size and rate -----------------------------------------------------
    /// The prompt plus the requested completion does not fit the window.
    ContextWindowExceeded,
    /// Even the pinned turns alone exceed the window; there is nothing safe to
    /// drop.
    PinnedTurnsExceedWindow,
    /// The endpoint refused the request as too large (a 413).
    RequestTooLarge,
    /// The endpoint is rate limiting this client.
    TooManyRequests,

    // -- the endpoint's own state -----------------------------------------
    /// A documented "overloaded" refusal.
    EndpointOverloaded,
    /// A 5xx, or an `INTERNAL`/`UNKNOWN`/`DATA_LOSS` status.
    EndpointFailedToAnswer,
    /// A 4xx that is not one of the modelled cases.
    EndpointRejectedRequest,
    /// The endpoint said *it* timed out.
    EndpointTimedOut,
    /// The endpoint cancelled or aborted the exchange from its side.
    EndpointCancelledRequest,
    /// An error object arrived that Vela could classify no further.
    EndpointReportedAnError,

    // -- content filtering -------------------------------------------------
    /// A safety filter refused the turn. The specifics live in
    /// [`Diagnosis::filter`], which is likewise a closed vocabulary.
    ContentFilterRefusedTheTurn,

    // -- capabilities ------------------------------------------------------
    /// The endpoint refused the affordance in a machine-readable way.
    CapabilityRefusedByEndpoint,
    /// A capability probe established the affordance is not there.
    CapabilityAbsentOnThisModel,
    /// The affordance is not offered by this backend at all.
    CapabilityNotOfferedByBackend,

    // -- transport ---------------------------------------------------------
    /// DNS, connection refused, TLS handshake — the request never landed.
    ConnectionFailed,
    /// The request as a whole exceeded its deadline.
    RequestTimedOut,
    /// Bytes stopped arriving mid-body for longer than the stall timeout.
    StreamStalled,
    /// The connection died mid-exchange.
    ConnectionReset,
    /// The endpoint answered 3xx pointing at a *different* authority, and the
    /// transport refused to follow it. Where it pointed is endpoint-chosen
    /// text: it goes to the debug log, not into this error.
    RedirectRefusedCrossAuthority,
    /// Too many same-authority hops.
    RedirectLoop,
    /// Discovery tried every candidate endpoint and none answered.
    NoEndpointAnswered,

    // -- answers Vela could not read ---------------------------------------
    /// The body was not JSON.
    ResponseWasNotJson,
    /// The body was JSON of a shape this adapter does not recognise.
    ResponseShapeUnrecognised,
    /// The stream ended without producing an answer.
    StreamEndedWithoutAnswer,

    // -- Vela's own side ---------------------------------------------------
    /// The request could not be serialised. A bug here, not there.
    RequestCouldNotBeEncoded,
    /// The router was asked to run with nothing configured.
    NoProviderConfigured,
    /// Every candidate was tried and none produced an answer.
    NoCandidateAnswered,
    /// The caller cancelled.
    CallerCancelled,

    /// Used only by this workspace's own fakes and fixtures, so that a test
    /// endpoint never needs a `Cause` that means something in production.
    SyntheticTestFailure,
}

impl Cause {
    /// Every variant, so a test can enumerate the vocabulary rather than
    /// trusting a hand-written list to stay in step with the enum.
    pub const ALL: &'static [Cause] = &[
        Cause::CredentialRejected,
        Cause::CredentialMissing,
        Cause::CredentialStoreUnreadable,
        Cause::CredentialStoreFailed,
        Cause::ModelNotServed,
        Cause::ModelListMalformed,
        Cause::ContextWindowExceeded,
        Cause::PinnedTurnsExceedWindow,
        Cause::RequestTooLarge,
        Cause::TooManyRequests,
        Cause::EndpointOverloaded,
        Cause::EndpointFailedToAnswer,
        Cause::EndpointRejectedRequest,
        Cause::EndpointTimedOut,
        Cause::EndpointCancelledRequest,
        Cause::EndpointReportedAnError,
        Cause::ContentFilterRefusedTheTurn,
        Cause::CapabilityRefusedByEndpoint,
        Cause::CapabilityAbsentOnThisModel,
        Cause::CapabilityNotOfferedByBackend,
        Cause::ConnectionFailed,
        Cause::RequestTimedOut,
        Cause::StreamStalled,
        Cause::ConnectionReset,
        Cause::RedirectRefusedCrossAuthority,
        Cause::RedirectLoop,
        Cause::NoEndpointAnswered,
        Cause::ResponseWasNotJson,
        Cause::ResponseShapeUnrecognised,
        Cause::StreamEndedWithoutAnswer,
        Cause::RequestCouldNotBeEncoded,
        Cause::NoProviderConfigured,
        Cause::NoCandidateAnswered,
        Cause::CallerCancelled,
        Cause::SyntheticTestFailure,
    ];

    /// The stable machine code. The UI may switch on this.
    pub const fn code(self) -> &'static str {
        match self {
            Cause::CredentialRejected => "credential_rejected",
            Cause::CredentialMissing => "credential_missing",
            Cause::CredentialStoreUnreadable => "credential_store_unreadable",
            Cause::CredentialStoreFailed => "credential_store_failed",
            Cause::ModelNotServed => "model_not_served",
            Cause::ModelListMalformed => "model_list_malformed",
            Cause::ContextWindowExceeded => "context_window_exceeded",
            Cause::PinnedTurnsExceedWindow => "pinned_turns_exceed_window",
            Cause::RequestTooLarge => "request_too_large",
            Cause::TooManyRequests => "too_many_requests",
            Cause::EndpointOverloaded => "endpoint_overloaded",
            Cause::EndpointFailedToAnswer => "endpoint_failed_to_answer",
            Cause::EndpointRejectedRequest => "endpoint_rejected_request",
            Cause::EndpointTimedOut => "endpoint_timed_out",
            Cause::EndpointCancelledRequest => "endpoint_cancelled_request",
            Cause::EndpointReportedAnError => "endpoint_reported_an_error",
            Cause::ContentFilterRefusedTheTurn => "content_filter_refused_the_turn",
            Cause::CapabilityRefusedByEndpoint => "capability_refused_by_endpoint",
            Cause::CapabilityAbsentOnThisModel => "capability_absent_on_this_model",
            Cause::CapabilityNotOfferedByBackend => "capability_not_offered_by_backend",
            Cause::ConnectionFailed => "connection_failed",
            Cause::RequestTimedOut => "request_timed_out",
            Cause::StreamStalled => "stream_stalled",
            Cause::ConnectionReset => "connection_reset",
            Cause::RedirectRefusedCrossAuthority => "redirect_refused_cross_authority",
            Cause::RedirectLoop => "redirect_loop",
            Cause::NoEndpointAnswered => "no_endpoint_answered",
            Cause::ResponseWasNotJson => "response_was_not_json",
            Cause::ResponseShapeUnrecognised => "response_shape_unrecognised",
            Cause::StreamEndedWithoutAnswer => "stream_ended_without_answer",
            Cause::RequestCouldNotBeEncoded => "request_could_not_be_encoded",
            Cause::NoProviderConfigured => "no_provider_configured",
            Cause::NoCandidateAnswered => "no_candidate_answered",
            Cause::CallerCancelled => "caller_cancelled",
            Cause::SyntheticTestFailure => "synthetic_test_failure",
        }
    }

    /// The sentence a user reads. **Written here, in Vela's source.**
    ///
    /// This is the whole redesign in one method: the endpoint decides which
    /// `match` arm is taken and has no say whatsoever in what the arm returns.
    pub const fn message(self) -> &'static str {
        match self {
            Cause::CredentialRejected => "the endpoint rejected the credential",
            Cause::CredentialMissing => {
                "this provider is configured to send a credential, but none is stored"
            }
            Cause::CredentialStoreUnreadable => "the credential store could not be read",
            Cause::CredentialStoreFailed => "the credential could not be resolved",
            Cause::ModelNotServed => "the endpoint does not serve this model",
            Cause::ModelListMalformed => "the endpoint's model list was not in the expected shape",
            Cause::ContextWindowExceeded => "the request does not fit the model's context window",
            Cause::PinnedTurnsExceedWindow => {
                "the system prompt and your message alone exceed this model's context window"
            }
            Cause::RequestTooLarge => "the endpoint refused the request as too large",
            Cause::TooManyRequests => "the endpoint is rate limiting this client",
            Cause::EndpointOverloaded => "the endpoint is overloaded",
            Cause::EndpointFailedToAnswer => "the endpoint failed to answer",
            Cause::EndpointRejectedRequest => "the endpoint rejected the request",
            Cause::EndpointTimedOut => "the endpoint timed out",
            Cause::EndpointCancelledRequest => "the endpoint cancelled the request",
            Cause::EndpointReportedAnError => "the endpoint reported an error",
            Cause::ContentFilterRefusedTheTurn => "a content filter refused this turn",
            Cause::CapabilityRefusedByEndpoint => "the endpoint refused this capability",
            Cause::CapabilityAbsentOnThisModel => {
                "this model was probed and does not offer this capability"
            }
            Cause::CapabilityNotOfferedByBackend => "this backend does not offer this capability",
            Cause::ConnectionFailed => "the connection could not be established",
            Cause::RequestTimedOut => "the request exceeded its deadline",
            Cause::StreamStalled => "no data arrived before the stall timeout",
            Cause::ConnectionReset => "the connection was lost mid-exchange",
            Cause::RedirectRefusedCrossAuthority => {
                "the endpoint redirected to a different host, which Vela refuses to follow"
            }
            Cause::RedirectLoop => "the endpoint redirected in a loop",
            Cause::NoEndpointAnswered => "no candidate endpoint answered",
            Cause::ResponseWasNotJson => "the response was not JSON",
            Cause::ResponseShapeUnrecognised => "the response was not in a shape Vela could read",
            Cause::StreamEndedWithoutAnswer => "the stream ended without an answer",
            Cause::RequestCouldNotBeEncoded => "the request could not be encoded",
            Cause::NoProviderConfigured => "no provider is configured",
            Cause::NoCandidateAnswered => "no candidate answered",
            Cause::CallerCancelled => "cancelled",
            Cause::SyntheticTestFailure => "a synthetic failure from Vela's own test harness",
        }
    }
}

impl fmt::Display for Cause {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

// ---------------------------------------------------------------------------
// EndpointIdentity — the diagnosis that survives
// ---------------------------------------------------------------------------

/// Which endpoint an error is about: scheme, host, port and path.
///
/// The regression critic's round-3 objection is what keeps this type alive.
/// Deleting the endpoint from an error takes the credential out by taking the
/// diagnosis out with it: `Connect: error sending request`, on a machine with
/// three configured candidates, does not say which one is down.
///
/// It carries **less** than the redacted URL it replaces:
///
/// * the query string is dropped whole, so `?key=<redacted>` never appears —
///   and neither does any other query parameter, which is where a credential
///   ends up when a user configures `Auth::ApiKeyQuery`;
/// * userinfo (`user:password@host`) is dropped, which is the *other* place
///   RFC 3986 lets a secret live in a URL;
/// * the fragment is dropped.
///
/// # It cannot be built out of a response
///
/// The fields are private and the only constructor takes a [`RequestUrl`] —
/// the type a request is assembled from. There is no `From<String>`, no
/// `new(&str)`, and no way for endpoint-supplied text to become one:
///
/// ```compile_fail,E0599
/// use vela_providers::diagnostic::EndpointIdentity;
/// // error[E0599]: no function or associated item named `new` found
/// let _ = EndpointIdentity::new("https://evil.invalid/echoed-by-the-peer");
/// ```
///
/// ```compile_fail,E0277
/// use vela_providers::diagnostic::EndpointIdentity;
/// // error[E0277]: the trait bound `EndpointIdentity: From<String>` is not satisfied
/// let _: EndpointIdentity = String::from("https://evil.invalid/").into();
/// ```
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct EndpointIdentity {
    /// `scheme://host[:port]`, never with userinfo.
    authority: String,
    /// The path, never with a query or fragment. Empty means "/".
    path: String,
}

impl EndpointIdentity {
    /// The only constructor.
    ///
    /// `None` when the URL is empty or is not absolute — a relative or
    /// unparseable target names no endpoint, and inventing one would be worse
    /// than saying nothing.
    pub fn of(url: &RequestUrl) -> Option<Self> {
        Self::parse(&url.redacted())
    }

    /// Split a URL into the two pieces this type keeps, dropping everything
    /// else. Private: the *only* caller is [`EndpointIdentity::of`], so the
    /// input is always a [`RequestUrl`].
    fn parse(url: &str) -> Option<Self> {
        let scheme_end = url.find("://")?;
        let scheme = &url[..scheme_end];
        if scheme.is_empty()
            || !scheme
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'-' || b == b'.')
        {
            return None;
        }
        let rest = &url[scheme_end + 3..];
        // Query and fragment are cut before anything else is looked at, so no
        // later step can accidentally keep a piece of one.
        let rest = rest.split(['?', '#']).next().unwrap_or("");
        let (hostport, path) = match rest.find('/') {
            Some(slash) => (&rest[..slash], &rest[slash..]),
            None => (rest, ""),
        };
        // Userinfo is the other RFC 3986 hiding place for a secret. Dropped,
        // not redacted: nothing downstream needs it.
        let hostport = match hostport.rfind('@') {
            Some(at) => &hostport[at + 1..],
            None => hostport,
        };
        if hostport.is_empty() {
            return None;
        }
        Some(Self {
            authority: format!("{scheme}://{hostport}"),
            path: path.to_owned(),
        })
    }

    /// `scheme://host[:port]` — what distinguishes one configured candidate
    /// from another.
    pub fn authority(&self) -> &str {
        &self.authority
    }

    /// The request path, or `""`.
    pub fn path(&self) -> &str {
        &self.path
    }
}

impl fmt::Display for EndpointIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.authority)?;
        f.write_str(&self.path)
    }
}

// ---------------------------------------------------------------------------
// ConfiguredModelId — the model *Vela asked for*
// ---------------------------------------------------------------------------

/// The model id Vela put in the request, read back out of the request.
///
/// It looks like it could be a `String` and it deliberately is not. `404` on a
/// model id is the commonest configuration mistake there is, and the useful
/// error names the model — but the *only* honest source for that name is the
/// request Vela sent. Taking it from the response would be taking it from the
/// endpoint.
///
/// ```compile_fail,E0277
/// use vela_providers::diagnostic::ConfiguredModelId;
/// // error[E0277]: `ConfiguredModelId: From<&str>` is not satisfied
/// let _: ConfiguredModelId = "whatever-the-peer-said".into();
/// ```
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ConfiguredModelId(String);

impl ConfiguredModelId {
    /// The only constructor that produces a non-empty id, and it reads the
    /// request rather than the response.
    pub fn of(request: &ChatRequest) -> Self {
        Self(request.model_id.clone())
    }

    /// For the operations that name no model — model listing, discovery, a
    /// capability probe against the base URL.
    pub fn unknown() -> Self {
        Self(String::new())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_unknown(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Display for ConfiguredModelId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

// ---------------------------------------------------------------------------
// CorrelationId — the link to the body that did not travel
// ---------------------------------------------------------------------------

/// Process-unique id linking an error to the raw exchange in the local debug
/// log ([`crate::debuglog`]).
///
/// This is what makes "do not carry the body" survivable rather than merely
/// safe: the body still exists, on the user's own disk, if and only if the user
/// turned the log on. The id is the join key. It is a counter, so it says
/// nothing about the machine it was generated on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CorrelationId(u64);

static NEXT_CORRELATION: AtomicU64 = AtomicU64::new(1);

impl CorrelationId {
    /// The next id this process will hand out.
    pub fn next() -> Self {
        Self(NEXT_CORRELATION.fetch_add(1, Ordering::Relaxed))
    }

    /// The id of an error that was never correlated with an exchange — one
    /// Vela raised without talking to anybody.
    pub const fn none() -> Self {
        Self(0)
    }

    pub const fn is_none(self) -> bool {
        self.0 == 0
    }

    pub const fn raw(self) -> u64 {
        self.0
    }
}

impl fmt::Display for CorrelationId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:016x}", self.0)
    }
}

// ---------------------------------------------------------------------------
// FilterVerdict — content filtering, as a closed vocabulary
// ---------------------------------------------------------------------------

/// Where in the turn a content filter intervened.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterStage {
    /// Refused before the model saw the prompt.
    Prompt,
    /// Refused what the model produced.
    Answer,
}

/// Which filter refused. An unmodelled wire token becomes [`FilterKind::Other`]
/// rather than being quoted — quoting it is exactly the mistake this redesign
/// exists to remove.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterKind {
    Safety,
    ProhibitedContent,
    Blocklist,
    PersonalInformation,
    Recitation,
    ImageSafety,
    UnsupportedLanguage,
    Other,
}

impl FilterKind {
    /// Recognise a wire token. The allowlist is the point: a token that is not
    /// on it maps to [`FilterKind::Other`] and is never echoed.
    pub fn recognise(token: &str) -> Self {
        match token {
            "SAFETY" => FilterKind::Safety,
            "PROHIBITED_CONTENT" => FilterKind::ProhibitedContent,
            "BLOCKLIST" => FilterKind::Blocklist,
            "SPII" => FilterKind::PersonalInformation,
            "RECITATION" => FilterKind::Recitation,
            "IMAGE_SAFETY" => FilterKind::ImageSafety,
            "LANGUAGE" => FilterKind::UnsupportedLanguage,
            _ => FilterKind::Other,
        }
    }

    pub const fn message(self) -> &'static str {
        match self {
            FilterKind::Safety => "safety filter",
            FilterKind::ProhibitedContent => "prohibited-content filter",
            FilterKind::Blocklist => "blocked-terms list",
            FilterKind::PersonalInformation => "personal-information filter",
            FilterKind::Recitation => {
                "recitation filter (the answer was reproducing memorised text)"
            }
            FilterKind::ImageSafety => "image safety filter",
            FilterKind::UnsupportedLanguage => "unsupported-language filter",
            FilterKind::Other => "content filter",
        }
    }
}

/// Which harm categories were flagged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarmCategory {
    Harassment,
    HateSpeech,
    SexuallyExplicit,
    DangerousContent,
    CivicIntegrity,
}

impl HarmCategory {
    pub const ALL: &'static [HarmCategory] = &[
        HarmCategory::Harassment,
        HarmCategory::HateSpeech,
        HarmCategory::SexuallyExplicit,
        HarmCategory::DangerousContent,
        HarmCategory::CivicIntegrity,
    ];

    /// Recognise a wire token, or `None`. An unmodelled category is **dropped**
    /// rather than printed: the sentence is still true without it, and printing
    /// a raw token is not.
    pub fn recognise(token: &str) -> Option<Self> {
        match token {
            "HARM_CATEGORY_HARASSMENT" => Some(HarmCategory::Harassment),
            "HARM_CATEGORY_HATE_SPEECH" => Some(HarmCategory::HateSpeech),
            "HARM_CATEGORY_SEXUALLY_EXPLICIT" => Some(HarmCategory::SexuallyExplicit),
            "HARM_CATEGORY_DANGEROUS_CONTENT" => Some(HarmCategory::DangerousContent),
            "HARM_CATEGORY_CIVIC_INTEGRITY" => Some(HarmCategory::CivicIntegrity),
            _ => None,
        }
    }

    pub const fn message(self) -> &'static str {
        match self {
            HarmCategory::Harassment => "harassment",
            HarmCategory::HateSpeech => "hate speech",
            HarmCategory::SexuallyExplicit => "sexually explicit content",
            HarmCategory::DangerousContent => "dangerous content",
            HarmCategory::CivicIntegrity => "civic integrity",
        }
    }

    const fn bit(self) -> u8 {
        match self {
            HarmCategory::Harassment => 1,
            HarmCategory::HateSpeech => 2,
            HarmCategory::SexuallyExplicit => 4,
            HarmCategory::DangerousContent => 8,
            HarmCategory::CivicIntegrity => 16,
        }
    }
}

/// A set of [`HarmCategory`], stored as a bitset.
///
/// A `Vec<String>` here would be a hole the width of the enum. Five bits
/// cannot hold a credential.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,
)]
#[serde(transparent)]
pub struct HarmCategories(u8);

impl HarmCategories {
    pub const fn empty() -> Self {
        Self(0)
    }

    /// Build from whatever tokens the endpoint sent, keeping only the ones on
    /// the allowlist.
    pub fn recognise<S: AsRef<str>>(tokens: impl IntoIterator<Item = S>) -> Self {
        let mut bits = 0;
        for token in tokens {
            if let Some(category) = HarmCategory::recognise(token.as_ref()) {
                bits |= category.bit();
            }
        }
        Self(bits)
    }

    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }

    pub fn contains(self, category: HarmCategory) -> bool {
        self.0 & category.bit() != 0
    }

    pub fn iter(self) -> impl Iterator<Item = HarmCategory> {
        HarmCategory::ALL
            .iter()
            .copied()
            .filter(move |category| self.contains(*category))
    }
}

/// The specifics of a content-filter refusal, all of it closed vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterVerdict {
    stage: FilterStage,
    kind: FilterKind,
    categories: HarmCategories,
    /// How many characters of answer had already reached the user. An integer,
    /// which is the only kind of endpoint-influenced value this design carries.
    generated_chars: u32,
}

impl FilterVerdict {
    pub fn new(
        stage: FilterStage,
        kind: FilterKind,
        categories: HarmCategories,
        generated_chars: u32,
    ) -> Self {
        Self {
            stage,
            kind,
            categories,
            generated_chars,
        }
    }

    pub fn stage(&self) -> FilterStage {
        self.stage
    }

    pub fn kind(&self) -> FilterKind {
        self.kind
    }

    pub fn categories(&self) -> HarmCategories {
        self.categories
    }

    pub fn generated_chars(&self) -> u32 {
        self.generated_chars
    }
}

impl fmt::Display for FilterVerdict {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let filter = self.kind.message();
        match (self.stage, self.generated_chars) {
            (FilterStage::Prompt, _) => write!(
                f,
                "the endpoint's {filter} blocked this request before the model saw it, \
                 so no answer was generated"
            )?,
            (FilterStage::Answer, 0) => write!(
                f,
                "the endpoint's {filter} blocked the model's answer, \
                 so nothing was delivered"
            )?,
            (FilterStage::Answer, chars) => write!(
                f,
                "the endpoint's {filter} stopped the model's answer after \
                 {chars} characters"
            )?,
        }
        if !self.categories.is_empty() {
            f.write_str(" (flagged: ")?;
            for (index, category) in self.categories.iter().enumerate() {
                if index > 0 {
                    f.write_str(", ")?;
                }
                f.write_str(category.message())?;
            }
            f.write_str(")")?;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Diagnosis — the envelope
// ---------------------------------------------------------------------------

/// Everything an error says, and the boundary that stops it saying anything
/// else.
///
/// # There is no way to put text in one
///
/// ```compile_fail,E0308
/// use vela_providers::diagnostic::Diagnosis;
/// // error[E0308]: expected `Cause`, found `&str`
/// let _ = Diagnosis::new("the endpoint said: <whatever it liked>");
/// ```
///
/// ```compile_fail,E0277
/// use vela_providers::diagnostic::Diagnosis;
/// // error[E0277]: `Diagnosis: From<String>` is not satisfied
/// let _: Diagnosis = String::from("upstream body").into();
/// ```
///
/// And the function that used to launder upstream text into an error is gone,
/// so the round-1-to-4 shape does not compile either:
///
/// ```compile_fail,E0425
/// // error[E0425]: cannot find function `detail` in module `error`
/// let _ = vela_providers::error::detail("whatever the endpoint sent");
/// ```
#[derive(Debug, Clone, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnosis {
    cause: Cause,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    endpoint: Option<EndpointIdentity>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    filter: Option<FilterVerdict>,
    correlation: CorrelationId,
}

impl Diagnosis {
    /// A diagnosis of `cause`, with a fresh correlation id and nothing else
    /// known yet.
    pub fn new(cause: Cause) -> Self {
        Self {
            cause,
            status: None,
            endpoint: None,
            filter: None,
            correlation: CorrelationId::next(),
        }
    }

    /// The same, for a failure Vela raised without an exchange to correlate
    /// with — a request it refused to send, a router with nothing configured.
    pub fn local(cause: Cause) -> Self {
        Self {
            cause,
            status: None,
            endpoint: None,
            filter: None,
            correlation: CorrelationId::none(),
        }
    }

    pub fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }

    /// Attach the endpoint this error is about. Takes an [`EndpointIdentity`],
    /// which can only have come from a [`RequestUrl`].
    pub fn at(mut self, endpoint: Option<EndpointIdentity>) -> Self {
        if endpoint.is_some() {
            self.endpoint = endpoint;
        }
        self
    }

    pub fn with_filter(mut self, verdict: FilterVerdict) -> Self {
        self.filter = Some(verdict);
        self
    }

    pub fn with_correlation(mut self, correlation: CorrelationId) -> Self {
        self.correlation = correlation;
        self
    }

    pub fn cause(&self) -> Cause {
        self.cause
    }

    pub fn status(&self) -> Option<u16> {
        self.status
    }

    pub fn endpoint(&self) -> Option<&EndpointIdentity> {
        self.endpoint.as_ref()
    }

    pub fn filter(&self) -> Option<&FilterVerdict> {
        self.filter.as_ref()
    }

    pub fn correlation(&self) -> CorrelationId {
        self.correlation
    }
}

/// Two diagnoses are equal when they *say the same thing*.
///
/// The correlation id is deliberately excluded. It is an identity — a pointer
/// into the debug log — not a property of the failure, and two errors that
/// describe the same refusal by the same endpoint are the same error even
/// though each points at its own log line. Deriving `PartialEq` would have
/// made every equality assertion in this workspace a test of a counter.
impl PartialEq for Diagnosis {
    fn eq(&self, other: &Self) -> bool {
        self.cause == other.cause
            && self.status == other.status
            && self.endpoint == other.endpoint
            && self.filter == other.filter
    }
}

impl From<Cause> for Diagnosis {
    fn from(cause: Cause) -> Self {
        Diagnosis::new(cause)
    }
}

impl fmt::Display for Diagnosis {
    /// The user-facing sentence: what happened, where, what the endpoint
    /// answered, and where to look for the body.
    ///
    /// Every fragment is either a `&'static str` from this file, an integer, or
    /// an endpoint identity Vela parsed out of its own request URL.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.filter {
            // A filter verdict is a complete sentence of its own and says more
            // than the generic cause would.
            Some(verdict) => write!(f, "{verdict}")?,
            None => f.write_str(self.cause.message())?,
        }
        if let Some(endpoint) = &self.endpoint {
            write!(f, " [endpoint {endpoint}]")?;
        }
        if let Some(status) = self.status {
            write!(f, " [http {status}]")?;
        }
        if !self.correlation.is_none() {
            write!(f, " [ref {}]", self.correlation)?;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// The audit — the property, checked from the other end
// ---------------------------------------------------------------------------

/// Every string a correctly built error is allowed to render, given the
/// identifiers it legitimately carries.
///
/// This is the closed vocabulary, computed from the enums themselves rather
/// than from a hand-written list, so adding a `Cause` cannot silently widen it
/// and adding a `String` field cannot silently slip through.
fn permitted_strings(identity: &[String]) -> Vec<String> {
    let mut allowed: Vec<String> = Vec::new();
    for cause in Cause::ALL {
        allowed.push(cause.code().to_owned());
        allowed.push(cause.message().to_owned());
    }
    for kind in FILTER_KINDS {
        allowed.push(
            serde_json::to_value(kind)
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned(),
        );
        allowed.push(kind.message().to_owned());
    }
    for stage in [FilterStage::Prompt, FilterStage::Answer] {
        allowed.push(
            serde_json::to_value(stage)
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    for category in HarmCategory::ALL {
        allowed.push(
            serde_json::to_value(category)
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned(),
        );
        allowed.push(category.message().to_owned());
    }
    // The taxonomy's own tags and codes, taken from `crate::error` rather than
    // re-listed here, so the two cannot drift.
    allowed.extend(
        crate::error::closed_vocabulary()
            .iter()
            .map(|s| (*s).to_owned()),
    );
    allowed.extend(identity.iter().cloned());
    allowed
}

const FILTER_KINDS: [FilterKind; 8] = [
    FilterKind::Safety,
    FilterKind::ProhibitedContent,
    FilterKind::Blocklist,
    FilterKind::PersonalInformation,
    FilterKind::Recitation,
    FilterKind::ImageSafety,
    FilterKind::UnsupportedLanguage,
    FilterKind::Other,
];

/// Walk an error's serde rendering and return every string leaf that is **not**
/// drawn from the closed vocabulary.
///
/// An empty result is the property this whole redesign exists to establish:
/// *nothing in this error came from the endpoint.* A non-empty result names
/// exactly what leaked.
///
/// `identity` is the Vela-constructed identifiers this particular error is
/// entitled to carry — its endpoint authority and path, its model id, its
/// correlation id. They are passed in rather than inferred so a caller cannot
/// accidentally excuse a leak by widening the allowlist.
pub fn unexplained_strings(value: &serde_json::Value, identity: &[String]) -> Vec<String> {
    let allowed = permitted_strings(identity);
    let mut found = Vec::new();
    collect_unexplained(value, &allowed, &mut found);
    found
}

/// [`unexplained_strings`] applied to a whole [`ProviderError`], with the
/// identity list taken from the error's own typed accessors.
///
/// **An empty result is the property this redesign exists to establish.** It is
/// stronger than "contains no credential": it says nothing on the wire, in any
/// spelling, reached the error at all — so there is no encoding left to try.
pub fn unexplained_in_error(error: &crate::error::ProviderError) -> Vec<String> {
    let value = serde_json::to_value(error).expect("ProviderError serialises");
    unexplained_strings(&value, &error.carried_identity())
}

fn collect_unexplained(value: &serde_json::Value, allowed: &[String], found: &mut Vec<String>) {
    match value {
        serde_json::Value::String(text) => {
            if text.is_empty() {
                return;
            }
            // A serde field name never reaches here: `Value::Object` keys are
            // walked as keys, below, and are Vela's own by definition.
            // No heuristic escape hatch. A string is either on the closed
            // vocabulary — which is *computed from the enums*, not hand-listed
            // — or it is a leak. An "it looks like an identifier" exemption
            // would have let a purely alphanumeric credential straight through,
            // which is the class of mistake this file exists to end.
            if allowed.iter().any(|candidate| candidate == text) {
                return;
            }
            found.push(text.clone());
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_unexplained(item, allowed, found);
            }
        }
        serde_json::Value::Object(fields) => {
            for item in fields.values() {
                collect_unexplained(item, allowed, found);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_endpoint_identity_drops_the_query_string_whole() {
        let url = RequestUrl::new("https://api.example.com:8443/v1/chat?key=abc&x=1#frag");
        let identity = EndpointIdentity::of(&url).expect("absolute url");
        assert_eq!(identity.authority(), "https://api.example.com:8443");
        assert_eq!(identity.path(), "/v1/chat");
        assert_eq!(
            identity.to_string(),
            "https://api.example.com:8443/v1/chat",
            "no query, no fragment"
        );
    }

    #[test]
    fn an_endpoint_identity_drops_userinfo() {
        let url = RequestUrl::new("https://user:hunter2@api.example.com/v1");
        let identity = EndpointIdentity::of(&url).expect("absolute url");
        assert_eq!(identity.authority(), "https://api.example.com");
        assert!(
            !identity.to_string().contains("hunter2"),
            "userinfo is a credential hiding place and is dropped"
        );
    }

    #[test]
    fn a_relative_or_empty_target_names_no_endpoint() {
        assert!(EndpointIdentity::of(&RequestUrl::new("")).is_none());
        assert!(EndpointIdentity::of(&RequestUrl::new("/v1/chat")).is_none());
        assert!(EndpointIdentity::of(&RequestUrl::new("https://")).is_none());
    }

    #[test]
    fn three_dead_candidates_are_pairwise_distinguishable() {
        let identities: Vec<String> = [
            "http://127.0.0.1:1/v1",
            "http://127.0.0.1:2/v1",
            "http://127.0.0.1:3/v1",
        ]
        .iter()
        .map(|url| {
            Diagnosis::new(Cause::ConnectionFailed)
                .at(EndpointIdentity::of(&RequestUrl::new(*url)))
                .to_string()
        })
        .collect();
        for (a, b) in [(0, 1), (0, 2), (1, 2)] {
            assert_ne!(
                identities[a], identities[b],
                "a user with three candidates must be able to tell them apart"
            );
        }
    }

    #[test]
    fn every_cause_has_a_distinct_code_and_a_sentence() {
        let mut codes: Vec<&str> = Cause::ALL.iter().map(|cause| cause.code()).collect();
        let total = codes.len();
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), total, "codes must be distinct");
        for cause in Cause::ALL {
            assert!(
                !cause.message().is_empty(),
                "{cause:?} must have a sentence"
            );
        }
    }

    #[test]
    fn cause_all_is_complete() {
        // A new variant added without extending `ALL` would make every
        // vocabulary check in the workspace quietly narrower. Serde round-trips
        // the whole list, and the count is asserted so the list cannot shrink
        // unnoticed either.
        assert_eq!(Cause::ALL.len(), 35);
        for cause in Cause::ALL {
            let json = serde_json::to_value(cause).unwrap();
            assert_eq!(json.as_str().unwrap(), cause.code());
        }
    }

    #[test]
    fn an_unmodelled_filter_token_is_not_echoed() {
        let kind = FilterKind::recognise("SOME_NEW_FILTER_THE_ENDPOINT_INVENTED");
        assert_eq!(kind, FilterKind::Other);
        assert_eq!(kind.message(), "content filter");
        let categories =
            HarmCategories::recognise(["HARM_CATEGORY_INVENTED", "HARM_CATEGORY_HATE_SPEECH"]);
        let rendered = FilterVerdict::new(FilterStage::Answer, kind, categories, 12).to_string();
        assert!(!rendered.contains("INVENTED"));
        assert!(rendered.contains("hate speech"));
    }

    #[test]
    fn correlation_ids_are_unique_and_render_as_fixed_width_hex() {
        let a = CorrelationId::next();
        let b = CorrelationId::next();
        assert_ne!(a, b);
        assert_eq!(a.to_string().len(), 16);
        assert!(CorrelationId::none().is_none());
        assert!(!Diagnosis::new(Cause::ConnectionFailed)
            .correlation()
            .is_none());
        assert!(Diagnosis::local(Cause::NoProviderConfigured)
            .correlation()
            .is_none());
    }

    #[test]
    fn a_configured_model_id_comes_from_the_request() {
        let request = ChatRequest::new("llama-3.1-8b-instruct");
        let model = ConfiguredModelId::of(&request);
        assert_eq!(model.as_str(), "llama-3.1-8b-instruct");
        assert!(ConfiguredModelId::unknown().is_unknown());
    }
}
