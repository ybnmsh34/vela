//! The Google Gemini backend.
//!
//! One `POST /v1beta/models/{model}:generateContent`, its streaming twin
//! `:streamGenerateContent?alt=sse`, an `x-goog-api-key` credential, a
//! `contents`/`parts` message shape of its own, `inlineData` for images,
//! `functionDeclarations` / `functionCall` / `functionResponse` for tools,
//! `systemInstruction`, `safetySettings`, `thinkingConfig`, and a `google.rpc`
//! error envelope. **None of that leaves this module.** Above the adapter
//! boundary there is a [`ChatRequest`](crate::model::ChatRequest), a
//! [`ChatResponse`](crate::model::ChatResponse), six
//! [`StreamEvent`](crate::event::StreamEvent)s and eight
//! [`ProviderError`]s — the same set every other backend produces.
//!
//! | Wire concept | Where it is translated |
//! |---|---|
//! | `contents`, `parts`, `inlineData`, `systemInstruction`, `tools`, `toolConfig`, `generationConfig`, `safetySettings` | [`wire`] |
//! | `candidates`, `finishReason`, `promptFeedback`, `usageMetadata`, thought parts | [`stream`] |
//! | `x-goog-api-key`, the URL shape, retries, capability probing | [`provider`] |
//! | the `google.rpc` status vocabulary | this file |
//!
//! # The one thing this backend does that no other does: it refuses content
//!
//! A Gemini endpoint can answer **200 OK with no answer in it**: either
//! `promptFeedback.blockReason` (the request never reached the model) or a
//! candidate whose `finishReason` is `SAFETY` / `PROHIBITED_CONTENT` /
//! `BLOCKLIST` / `SPII` / `RECITATION`. A consumer that reads `candidates[0]`
//! and shrugs shows the user an empty bubble and no reason for it — the same
//! class of silent failure MEASURED-5 is about.
//!
//! So a block is never an empty response here. [`blocked_error`] turns it into
//! a [`ProviderError`] carrying a plain-English, provider-neutral sentence that
//! says what was blocked, at which stage, and how much had already been
//! generated. See that function for the one place the shared taxonomy does not
//! have a variant that fits.
//!
//! # Honesty
//!
//! No live credential and no live endpoint exist in this environment, so
//! **every result this module has produced is VERIFIED-BY-FAKE**
//! (`conventions.md` §10): the tests replay recorded event shapes through the
//! scriptable transport, byte for byte, and say what the adapter does when an
//! endpoint behaves like those transcripts. They say nothing about a live
//! endpoint or a live model.

mod provider;
pub mod stream;
pub mod wire;

pub use provider::{GoogleOptions, GoogleProvider, DEFAULT_BASE_URL};
pub use wire::{Concessions, HarmCategory, SafetySetting, SafetyThreshold};

use serde_json::Value;

use crate::error::{detail, Capability, ProviderError, TransportFailure};
use crate::http::UpstreamBytes;

/// Longest error body this adapter will read. `conventions.md` §3.2 forbids raw
/// upstream bodies reaching the renderer, and this bounds what a broken
/// endpoint can make Vela allocate.
pub const MAX_ERROR_BODY_BYTES: usize = 16 * 1024;

/// A reduction the endpoint's own refusal justifies.
///
/// Each one corresponds to a documented 400 from this API. They are applied on
/// evidence and one at a time — never pre-emptively, because guessing which
/// features a model lacks is exactly the lookup-table mistake MEASURED-5
/// forbids.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Concession {
    /// The model rejects `generationConfig.thinkingConfig`.
    ThinkingConfig,
    /// The model rejects a top-level `systemInstruction`; fold it into the
    /// first user turn instead.
    SystemInstruction,
    /// The endpoint rejects one of the `safetySettings` categories.
    SafetySettings,
}

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

/// Where in the exchange the content filter intervened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockStage {
    /// `promptFeedback.blockReason`: the request was refused; the model never
    /// ran.
    Prompt,
    /// A candidate's `finishReason`: generation started and was cut off.
    Answer,
}

/// A refusal by the endpoint's content filter, normalised.
///
/// Deliberately holds no wire vocabulary that the UI would see: `reason` and
/// `categories` are translated to neutral English by [`blocked_error`] before
/// they reach a [`ProviderError`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Blocked {
    pub stage: BlockStage,
    /// The wire token, e.g. `SAFETY`. Used only to pick an English phrase.
    pub reason: String,
    /// The wire category tokens the endpoint flagged, e.g.
    /// `HARM_CATEGORY_HATE_SPEECH`.
    pub categories: Vec<String>,
    /// How many characters of answer had already reached the user when the
    /// filter stopped the turn. Zero for a prompt block.
    pub generated_chars: usize,
}

impl Blocked {
    pub fn prompt(reason: impl Into<String>, categories: Vec<String>) -> Self {
        Self {
            stage: BlockStage::Prompt,
            reason: reason.into(),
            categories,
            generated_chars: 0,
        }
    }

    pub fn answer(
        reason: impl Into<String>,
        categories: Vec<String>,
        generated_chars: usize,
    ) -> Self {
        Self {
            stage: BlockStage::Answer,
            reason: reason.into(),
            categories,
            generated_chars,
        }
    }
}

/// Turn a content block into the one error taxonomy, truthfully.
///
/// # Why this variant
///
/// [`ProviderError`] has no `ContentFiltered` case, and this adapter may not add
/// one — the taxonomy is shared and adding to it is the provider core's call,
/// not an adapter's. Of the eight variants, `Transport { failure: Request { .. } }`
/// is the only one whose *behaviour* is right:
///
/// * `allows_retry() == false` — an identical request gets blocked identically,
///   so retrying would burn the user's quota to reproduce the same refusal.
/// * `allows_failover() == true` — another candidate, with another model or a
///   local runtime, may well answer. Unlike an auth failure, trying elsewhere
///   is neither dishonest nor dangerous.
///
/// The status is `400` because that is what the refusal *means* — the endpoint
/// rejected this request — even though it happened to say so inside a 200 body.
///
/// What carries the truth is `detail`: a complete, provider-neutral sentence,
/// so the user is told a filter refused the content rather than being shown an
/// empty bubble or a connection error. `ProviderError`'s own `Display` prefix
/// ("could not reach the endpoint") is wrong for this case and is the reason
/// the gap is reported rather than papered over.
pub fn blocked_error(blocked: &Blocked) -> ProviderError {
    ProviderError::Transport {
        failure: TransportFailure::Request { status: 400 },
        detail: detail(describe_block(blocked)),
    }
}

/// The user-facing sentence for a block. Public so a test can assert on the
/// words rather than on a formatting accident.
pub fn describe_block(blocked: &Blocked) -> String {
    let filter = describe_reason(&blocked.reason);
    let flagged = describe_categories(&blocked.categories);
    match (blocked.stage, blocked.generated_chars) {
        (BlockStage::Prompt, _) => format!(
            "the endpoint's {filter} blocked this request before the model saw it, \
             so no answer was generated{flagged}"
        ),
        (BlockStage::Answer, 0) => {
            format!("the endpoint's {filter} blocked the answer, so nothing was returned{flagged}")
        }
        (BlockStage::Answer, generated) => format!(
            "the endpoint's {filter} stopped the answer after {generated} characters; \
             the rest was withheld{flagged}"
        ),
    }
}

/// Translate a wire block reason into English. Unknown tokens become the
/// generic phrase rather than being passed through: a raw enum name is backend
/// vocabulary, and `conventions.md` §0.3 keeps that out of anything the UI can
/// render.
fn describe_reason(reason: &str) -> &'static str {
    match reason {
        "SAFETY" => "safety filter",
        "PROHIBITED_CONTENT" => "prohibited-content filter",
        "BLOCKLIST" => "blocked-terms list",
        "SPII" => "personal-information filter",
        "RECITATION" => "recitation filter (the answer was reproducing memorised text)",
        "IMAGE_SAFETY" => "image safety filter",
        "LANGUAGE" => "unsupported-language filter",
        _ => "content filter",
    }
}

fn describe_categories(categories: &[String]) -> String {
    let named: Vec<&str> = categories
        .iter()
        .filter_map(|category| describe_category(category))
        .collect();
    if named.is_empty() {
        return String::new();
    }
    format!(" (flagged: {})", named.join(", "))
}

fn describe_category(category: &str) -> Option<&'static str> {
    match category {
        "HARM_CATEGORY_HARASSMENT" => Some("harassment"),
        "HARM_CATEGORY_HATE_SPEECH" => Some("hate speech"),
        "HARM_CATEGORY_SEXUALLY_EXPLICIT" => Some("sexually explicit content"),
        "HARM_CATEGORY_DANGEROUS_CONTENT" => Some("dangerous content"),
        "HARM_CATEGORY_CIVIC_INTEGRITY" => Some("civic integrity"),
        // An unmodelled category is dropped rather than printed: the sentence
        // is still true without it, and printing a raw token is not.
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Error responses
// ---------------------------------------------------------------------------

/// Map a non-2xx response onto the one taxonomy.
///
/// Keyed on the `google.rpc` `status` token first and the numeric code second:
/// this API always sends a machine-readable status, and matching on prose would
/// make Vela's behaviour depend on an endpoint's copywriting.
pub fn map_error_response(
    status: u16,
    body: &UpstreamBytes,
    model_id: &str,
    retry_after_header: Option<&str>,
) -> ProviderError {
    match error_object(body) {
        Some(error) => {
            let mapped = map_error_object(Some(status), &error);
            match (mapped, retry_after_header.and_then(parse_retry_after_ms)) {
                // The endpoint's own advice beats ours; the body's `RetryInfo`
                // already won inside `map_error_object`, so only fill a gap.
                (
                    ProviderError::RateLimited {
                        retry_after_ms,
                        detail,
                    },
                    header,
                ) => ProviderError::RateLimited {
                    retry_after_ms: retry_after_ms.or(header),
                    detail,
                },
                (ProviderError::ModelNotFound { detail, .. }, _) => ProviderError::ModelNotFound {
                    model_id: model_id.to_owned(),
                    detail,
                },
                (other, _) => other,
            }
        }
        None => map_status(status, "", retry_after_header, model_id),
    }
}

/// Pull the `error` object out of a body.
///
/// This API answers a batch endpoint with a **JSON array** whose first element
/// carries the error, and the single-shot endpoints with a bare object. Both
/// are read, because a caller pointing at a gateway can get either.
fn error_object(body: &UpstreamBytes) -> Option<Value> {
    // Decoded through the body's scrubber: whatever encoding the endpoint used
    // for the credential, it has been undone by now and the needles match.
    let parsed: Value = body.json_or_none()?;
    let candidate = match &parsed {
        Value::Array(items) => items.first()?,
        other => other,
    };
    candidate.get("error").cloned()
}

/// Map one `{"code":…, "message":…, "status":…}` object, wherever it came from:
/// an error response, or an error frame inside an otherwise-200 stream.
pub fn map_error_object(http_status: Option<u16>, error: &Value) -> ProviderError {
    let status_token = error
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let code = error
        .get("code")
        .and_then(Value::as_u64)
        .and_then(|code| u16::try_from(code).ok())
        .or(http_status)
        .unwrap_or(400);

    // A capability refusal is worth more than the status it arrived with: it
    // tells the UI to withdraw an affordance rather than to retry.
    if let Some(capability) = refused_capability(message) {
        return ProviderError::unsupported(capability, message);
    }
    if is_too_long(message) {
        let (limit, requested) = context_numbers(message);
        return ProviderError::ContextLengthExceeded {
            limit_tokens: limit,
            requested_tokens: requested,
            detail: detail(message),
        };
    }

    match status_token {
        "UNAUTHENTICATED" | "PERMISSION_DENIED" => ProviderError::AuthFailed {
            detail: detail(fallback(message, "the endpoint rejected the credential")),
        },
        "NOT_FOUND" => ProviderError::ModelNotFound {
            model_id: String::new(),
            detail: detail(fallback(message, "not found")),
        },
        "RESOURCE_EXHAUSTED" => ProviderError::RateLimited {
            retry_after_ms: retry_info_ms(error),
            detail: detail(fallback(message, "too many requests")),
        },
        "DEADLINE_EXCEEDED" => ProviderError::transport(
            TransportFailure::Timeout,
            fallback(message, "the endpoint timed out"),
        ),
        "UNAVAILABLE" => ProviderError::transport(
            TransportFailure::Server { status: 503 },
            fallback(message, "the endpoint is unavailable"),
        ),
        "INTERNAL" | "UNKNOWN" | "DATA_LOSS" => ProviderError::transport(
            TransportFailure::Server {
                status: if (500..=599).contains(&code) {
                    code
                } else {
                    500
                },
            },
            fallback(message, "the endpoint failed to answer"),
        ),
        // The server hung up on itself. Not a 5xx, and not something the user
        // configured wrongly, so it is reported as the transient failure it is.
        "CANCELLED" | "ABORTED" => ProviderError::transport(
            TransportFailure::Reset,
            fallback(message, "the endpoint abandoned the request"),
        ),
        // `INVALID_ARGUMENT`, `FAILED_PRECONDITION`, `OUT_OF_RANGE` and
        // anything a later API version adds fall through to the code, so an
        // unmodelled status is never invented into a diagnosis.
        _ => map_status(code, message, None, ""),
    }
}

fn map_status(
    status: u16,
    message: &str,
    retry_after_header: Option<&str>,
    model_id: &str,
) -> ProviderError {
    match status {
        401 | 403 => ProviderError::AuthFailed {
            detail: detail(fallback(message, "the endpoint rejected the credential")),
        },
        404 => ProviderError::ModelNotFound {
            model_id: model_id.to_owned(),
            detail: detail(fallback(message, "not found")),
        },
        413 => ProviderError::ContextLengthExceeded {
            limit_tokens: None,
            requested_tokens: None,
            detail: detail(fallback(
                message,
                "the endpoint refused the request as too large",
            )),
        },
        429 => ProviderError::RateLimited {
            retry_after_ms: retry_after_header.and_then(parse_retry_after_ms),
            detail: detail(fallback(message, "too many requests")),
        },
        500..=599 => ProviderError::transport(
            TransportFailure::Server { status },
            fallback(message, "the endpoint failed to answer"),
        ),
        _ => ProviderError::transport(
            TransportFailure::Request { status },
            fallback(message, "the endpoint rejected the request"),
        ),
    }
}

/// Which reduction, if any, this refusal justifies.
///
/// Read from the body directly rather than from the mapped error: the mapping
/// deliberately throws wire detail away, and this is the one decision that
/// needs it.
pub fn concession_for(body: &UpstreamBytes) -> Option<Concession> {
    let message = error_object(body)?
        .get("message")?
        .as_str()?
        .to_ascii_lowercase();
    if !is_refusal(&message) {
        return None;
    }
    if mentions_thinking(&message) {
        return Some(Concession::ThinkingConfig);
    }
    if message.contains("system_instruction") || message.contains("systeminstruction") {
        return Some(Concession::SystemInstruction);
    }
    if message.contains("safety_settings")
        || message.contains("safetysettings")
        || message.contains("harm_category")
    {
        return Some(Concession::SafetySettings);
    }
    None
}

/// Does this message say a feature is missing, rather than that Vela got
/// something wrong? Checked before every keyword test so an ordinary
/// "field X is required" never withdraws an affordance.
fn is_refusal(lowercase_message: &str) -> bool {
    lowercase_message.contains("not supported")
        || lowercase_message.contains("not enabled")
        || lowercase_message.contains("does not support")
        || lowercase_message.contains("is not available")
        || lowercase_message.contains("unsupported")
}

fn mentions_thinking(lowercase_message: &str) -> bool {
    lowercase_message.contains("thinking") || lowercase_message.contains("thought")
}

/// A refusal that names an affordance rather than a mistake.
///
/// Order matters: a message can mention two features ("function calling with a
/// JSON response mime type is not supported"), and the more specific reading is
/// checked first so the withdrawn affordance is the one that actually failed.
fn refused_capability(message: &str) -> Option<Capability> {
    let lowered = message.to_ascii_lowercase();
    if !is_refusal(&lowered) {
        return None;
    }
    if mentions_thinking(&lowered) {
        return Some(Capability::Reasoning);
    }
    if lowered.contains("response_schema")
        || lowered.contains("responseschema")
        || lowered.contains("response_mime_type")
        || lowered.contains("responsemimetype")
        || lowered.contains("json mode")
        || lowered.contains("structured output")
    {
        return Some(Capability::StructuredOutput);
    }
    if lowered.contains("image")
        || lowered.contains("inline_data")
        || lowered.contains("inlinedata")
        || lowered.contains("multi-modal")
        || lowered.contains("multimodal")
    {
        return Some(Capability::Vision);
    }
    if lowered.contains("function calling")
        || lowered.contains("function_declarations")
        || lowered.contains("functiondeclarations")
        || lowered.contains("tool")
    {
        return Some(Capability::ToolCalling);
    }
    None
}

/// Does this 400 mean "the conversation does not fit"?
///
/// Deliberately narrow. `Request payload size exceeds the limit: N bytes` is
/// *also* a size refusal and is matched here, but see [`context_numbers`]: its
/// number is bytes, and reporting bytes as tokens would put a wrong figure in
/// front of the user.
fn is_too_long(message: &str) -> bool {
    let lowered = message.to_ascii_lowercase();
    (lowered.contains("token count") && lowered.contains("exceed"))
        || lowered.contains("exceeds the maximum number of tokens")
        || lowered.contains("input is too long")
        || lowered.contains("request payload size exceeds")
        || lowered.contains("context length")
}

/// Pull `(limit, requested)` out of this API's phrasing:
///
/// `The input token count (1189440) exceeds the maximum number of tokens
/// allowed (1048575).`
///
/// The request comes first and the limit second. Both are `Option`, and both
/// are `None` unless the message is explicitly about *tokens*: a payload-size
/// refusal counts bytes, and presenting a byte count as a token count would be
/// a confidently wrong number.
fn context_numbers(message: &str) -> (Option<u32>, Option<u32>) {
    if !message.to_ascii_lowercase().contains("token") {
        return (None, None);
    }
    let mut numbers = Vec::new();
    let mut rest = message;
    while let Some(open) = rest.find('(') {
        let after = &rest[open + 1..];
        let Some(close) = after.find(')') else { break };
        if let Ok(value) = after[..close].trim().parse::<u32>() {
            numbers.push(value);
        }
        rest = &after[close + 1..];
    }
    let mut numbers = numbers.into_iter();
    let requested = numbers.next();
    let limit = numbers.next();
    // One number alone is ambiguous — it could be either side — so neither is
    // claimed.
    match (requested, limit) {
        (Some(requested), Some(limit)) => (Some(limit), Some(requested)),
        _ => (None, None),
    }
}

/// `error.details[] { "@type": ".../google.rpc.RetryInfo", "retryDelay": "27s" }`
fn retry_info_ms(error: &Value) -> Option<u64> {
    error
        .get("details")?
        .as_array()?
        .iter()
        .find_map(|entry| {
            let kind = entry.get("@type").and_then(Value::as_str)?;
            kind.ends_with("RetryInfo")
                .then(|| entry.get("retryDelay").and_then(Value::as_str))
                .flatten()
        })
        .and_then(parse_duration_ms)
}

/// A `google.protobuf.Duration` in JSON form: seconds with an `s` suffix.
fn parse_duration_ms(raw: &str) -> Option<u64> {
    let seconds: f64 = raw.trim().trim_end_matches('s').trim().parse().ok()?;
    (seconds.is_finite() && seconds >= 0.0).then_some((seconds * 1000.0) as u64)
}

fn parse_retry_after_ms(header: &str) -> Option<u64> {
    // Seconds form only. The HTTP-date form is deliberately not parsed: a
    // wrong-by-hours backoff is worse than none, and callers fall back to their
    // own policy when this is `None`.
    header
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
        .map(|seconds| (seconds * 1000.0) as u64)
}

fn fallback<'a>(message: &'a str, default: &'a str) -> &'a str {
    if message.trim().is_empty() {
        default
    } else {
        message
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// An error body that answers no request of ours, so there is no credential
    /// in it to remove. The credentialed path — where the decode has needles to
    /// apply — is driven end to end in `tests/encoded_credential_canary.rs`.
    fn body(code: u16, status: &str, message: &str) -> UpstreamBytes {
        UpstreamBytes::carries_no_credential(
            json!({"error": {"code": code, "message": message, "status": status}}).to_string(),
        )
    }

    fn upstream(body: &str) -> UpstreamBytes {
        UpstreamBytes::carries_no_credential(body)
    }

    #[test]
    fn the_documented_overflow_message_yields_both_token_counts() {
        let error = map_error_response(
            400,
            &body(
                400,
                "INVALID_ARGUMENT",
                "The input token count (1189440) exceeds the maximum number of tokens allowed \
                 (1048575).",
            ),
            "gemini-test",
            None,
        );
        match error {
            ProviderError::ContextLengthExceeded {
                limit_tokens,
                requested_tokens,
                ..
            } => {
                assert_eq!(limit_tokens, Some(1_048_575));
                assert_eq!(requested_tokens, Some(1_189_440));
            }
            other => panic!("expected a context error, got {other:?}"),
        }
    }

    #[test]
    fn a_payload_size_refusal_is_a_context_error_that_claims_no_token_numbers() {
        let error = map_error_response(
            400,
            &body(
                400,
                "INVALID_ARGUMENT",
                "Request payload size exceeds the limit: 20971520 bytes.",
            ),
            "gemini-test",
            None,
        );
        assert_eq!(
            error,
            ProviderError::ContextLengthExceeded {
                limit_tokens: None,
                requested_tokens: None,
                detail: detail("Request payload size exceeds the limit: 20971520 bytes."),
            },
            "bytes are not tokens, and a wrong number is worse than none"
        );
    }

    #[test]
    fn an_unauthenticated_status_is_never_failed_over_or_retried() {
        let error = map_error_response(
            401,
            &body(
                401,
                "UNAUTHENTICATED",
                "API key not valid. Please pass a valid API key.",
            ),
            "m",
            None,
        );
        assert!(matches!(error, ProviderError::AuthFailed { .. }));
        assert!(!error.allows_failover(), "never spray a credential failure");
        assert!(!error.allows_retry());
    }

    #[test]
    fn a_quota_refusal_carries_the_endpoints_own_retry_advice_from_the_body() {
        let raw = json!({"error": {
            "code": 429,
            "message": "You exceeded your current quota.",
            "status": "RESOURCE_EXHAUSTED",
            "details": [
                {"@type": "type.googleapis.com/google.rpc.QuotaFailure", "violations": []},
                {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "27s"},
            ],
        }})
        .to_string();
        let error = map_error_response(429, &upstream(&raw), "m", None);
        assert_eq!(
            error.retry_after(),
            Some(std::time::Duration::from_millis(27_000))
        );
        assert!(error.allows_retry() && error.allows_failover());
    }

    #[test]
    fn a_retry_after_header_fills_the_gap_when_the_body_gave_no_advice() {
        let error = map_error_response(
            429,
            &body(429, "RESOURCE_EXHAUSTED", "slow down"),
            "m",
            Some("2.5"),
        );
        assert_eq!(
            error.retry_after(),
            Some(std::time::Duration::from_millis(2_500))
        );
    }

    #[test]
    fn a_not_found_names_the_model_the_caller_asked_for() {
        let error = map_error_response(
            404,
            &body(
                404,
                "NOT_FOUND",
                "models/gemini-does-not-exist is not found for API version v1beta",
            ),
            "gemini-does-not-exist",
            None,
        );
        match error {
            ProviderError::ModelNotFound { model_id, .. } => {
                assert_eq!(model_id, "gemini-does-not-exist")
            }
            other => panic!("expected model_not_found, got {other:?}"),
        }
    }

    #[test]
    fn an_unavailable_status_is_a_transient_server_failure() {
        let error = map_error_response(
            503,
            &body(503, "UNAVAILABLE", "The model is overloaded."),
            "m",
            None,
        );
        assert!(matches!(
            error,
            ProviderError::Transport {
                failure: TransportFailure::Server { status: 503 },
                ..
            }
        ));
        assert!(error.allows_retry() && error.allows_failover());
    }

    #[test]
    fn a_thinking_refusal_is_a_capability_error_and_a_concession() {
        let raw = body(
            400,
            "INVALID_ARGUMENT",
            "Thinking config is not supported for models/gemini-1.0-pro",
        );
        assert!(matches!(
            map_error_response(400, &raw, "m", None),
            ProviderError::CapabilityUnsupported {
                capability: Capability::Reasoning,
                ..
            }
        ));
        assert_eq!(concession_for(&raw), Some(Concession::ThinkingConfig));
    }

    #[test]
    fn a_system_instruction_refusal_asks_for_the_field_to_be_folded_away() {
        let raw = body(
            400,
            "INVALID_ARGUMENT",
            "Developer instruction is not enabled for models/gemini-1.0-pro-vision",
        );
        assert_eq!(concession_for(&raw), None, "the wire field must be named");
        let named = body(
            400,
            "INVALID_ARGUMENT",
            "system_instruction is not supported for this model",
        );
        assert_eq!(concession_for(&named), Some(Concession::SystemInstruction));
    }

    #[test]
    fn a_rejected_safety_category_asks_for_the_settings_to_be_dropped() {
        let raw = body(
            400,
            "INVALID_ARGUMENT",
            "HARM_CATEGORY_CIVIC_INTEGRITY is not supported for this model",
        );
        assert_eq!(concession_for(&raw), Some(Concession::SafetySettings));
    }

    #[test]
    fn an_ordinary_bad_request_asks_for_no_concession_at_all() {
        assert_eq!(
            concession_for(&body(
                400,
                "INVALID_ARGUMENT",
                "contents: at least one part is required"
            )),
            None
        );
        assert_eq!(concession_for(&upstream("<html>gateway</html>")), None);
    }

    #[test]
    fn a_location_refusal_is_not_mistaken_for_a_missing_capability() {
        let error = map_error_response(
            400,
            &body(
                400,
                "FAILED_PRECONDITION",
                "User location is not supported for the API use.",
            ),
            "m",
            None,
        );
        assert!(
            matches!(
                error,
                ProviderError::Transport {
                    failure: TransportFailure::Request { status: 400 },
                    ..
                }
            ),
            "a geography problem is not a capability the model lacks: {error:?}"
        );
    }

    #[test]
    fn a_function_calling_refusal_withdraws_tool_calling() {
        let error = map_error_response(
            400,
            &body(
                400,
                "INVALID_ARGUMENT",
                "Function calling is not enabled for models/gemini-test",
            ),
            "m",
            None,
        );
        assert!(matches!(
            error,
            ProviderError::CapabilityUnsupported {
                capability: Capability::ToolCalling,
                ..
            }
        ));
    }

    #[test]
    fn a_json_mode_refusal_withdraws_structured_output_not_tool_calling() {
        let error = map_error_response(
            400,
            &body(
                400,
                "INVALID_ARGUMENT",
                "Json mode is not enabled for models/gemini-test",
            ),
            "m",
            None,
        );
        assert!(matches!(
            error,
            ProviderError::CapabilityUnsupported {
                capability: Capability::StructuredOutput,
                ..
            }
        ));
    }

    #[test]
    fn an_error_arriving_inside_a_json_array_body_is_still_read() {
        let raw = json!([{"error": {"code": 400, "message": "bad", "status": "INVALID_ARGUMENT"}}])
            .to_string();
        assert!(matches!(
            map_error_response(400, &upstream(&raw), "m", None),
            ProviderError::Transport {
                failure: TransportFailure::Request { status: 400 },
                ..
            }
        ));
    }

    #[test]
    fn a_body_with_no_error_object_still_maps_by_status() {
        assert!(matches!(
            map_error_response(503, &upstream("<html>gateway</html>"), "m", None),
            ProviderError::Transport {
                failure: TransportFailure::Server { status: 503 },
                ..
            }
        ));
        assert!(matches!(
            map_error_response(422, &upstream(""), "m", None),
            ProviderError::Transport {
                failure: TransportFailure::Request { status: 422 },
                ..
            }
        ));
    }

    #[test]
    fn no_upstream_body_is_ever_copied_whole_into_an_error() {
        let huge = "x".repeat(4_000);
        let error = map_error_response(400, &body(400, "INVALID_ARGUMENT", &huge), "m", None);
        let rendered = format!("{error}");
        assert!(
            rendered.chars().count() < 300,
            "detail must be bounded: {} chars",
            rendered.chars().count()
        );
    }

    // -- content blocks ----------------------------------------------------

    #[test]
    fn a_blocked_prompt_says_so_in_words_rather_than_returning_nothing() {
        let error = blocked_error(&Blocked::prompt(
            "SAFETY",
            vec!["HARM_CATEGORY_HATE_SPEECH".into()],
        ));
        let ProviderError::Transport { detail, .. } = &error else {
            panic!("expected a transport-shaped refusal, got {error:?}");
        };
        assert!(
            detail.contains("safety filter")
                && detail.contains("before the model saw it")
                && detail.contains("hate speech"),
            "the user must be told what happened: {detail}"
        );
        assert!(
            !error.allows_retry(),
            "an identical request is blocked identically"
        );
        assert!(
            error.allows_failover(),
            "another model may well answer this"
        );
    }

    #[test]
    fn a_block_partway_through_an_answer_says_how_much_was_generated() {
        let detail = describe_block(&Blocked::answer(
            "PROHIBITED_CONTENT",
            vec!["HARM_CATEGORY_DANGEROUS_CONTENT".into()],
            412,
        ));
        assert!(detail.contains("after 412 characters"), "{detail}");
        assert!(detail.contains("prohibited-content filter"), "{detail}");
    }

    #[test]
    fn an_unmodelled_block_reason_never_leaks_its_wire_token() {
        let detail = describe_block(&Blocked::prompt(
            "SOME_FUTURE_REASON",
            vec!["HARM_CATEGORY_FROM_THE_FUTURE".into()],
        ));
        assert!(
            !detail.contains("SOME_FUTURE_REASON") && !detail.contains("FROM_THE_FUTURE"),
            "backend vocabulary must not reach the UI: {detail}"
        );
        assert!(detail.contains("content filter"), "{detail}");
    }

    #[test]
    fn a_recitation_stop_explains_itself_rather_than_naming_an_enum() {
        let detail = describe_block(&Blocked::answer("RECITATION", Vec::new(), 0));
        assert!(detail.contains("memorised text"), "{detail}");
    }

    #[test]
    fn duration_advice_is_parsed_only_when_it_is_a_number_of_seconds() {
        assert_eq!(parse_duration_ms("27s"), Some(27_000));
        assert_eq!(parse_duration_ms("1.5s"), Some(1_500));
        assert_eq!(parse_duration_ms("later"), None);
        assert_eq!(parse_retry_after_ms("Wed, 21 Oct 2015 07:28:00 GMT"), None);
    }
}
