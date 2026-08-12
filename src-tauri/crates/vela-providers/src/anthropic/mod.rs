//! The Anthropic Messages backend.
//!
//! One `POST /v1/messages`, an `x-api-key` credential, an `anthropic-version`
//! header, an SSE vocabulary of its own (`message_start` →
//! `content_block_delta` → `message_delta` → `message_stop`), `tool_use` and
//! `tool_result` blocks, signed extended-thinking blocks, and `cache_control`
//! breakpoints. **None of that leaves this module.** Above the adapter boundary
//! there is a [`ChatRequest`](crate::model::ChatRequest), a
//! [`ChatResponse`](crate::model::ChatResponse), six
//! [`StreamEvent`](crate::event::StreamEvent)s and eight
//! [`ProviderError`]s — the same set every other backend produces.
//!
//! | Wire concept | Where it is translated |
//! |---|---|
//! | `system`, `messages`, content blocks, `cache_control`, `thinking`, `tools` | [`wire`] |
//! | the SSE event vocabulary, `usage`, `stop_reason` | [`stream`] |
//! | `x-api-key`, `anthropic-version`, retries, capability probing | [`provider`] |
//! | error `type` strings and HTTP statuses | this file |
//!
//! # Honesty
//!
//! No live credential exists in this environment, so **every result this module
//! has produced is VERIFIED-BY-FAKE** (`conventions.md` §10): the tests replay
//! recorded event shapes through the scriptable transport, byte for byte, and
//! say what the adapter does when an endpoint behaves like those transcripts.
//! They say nothing about a live endpoint or a live model.

mod provider;
pub mod stream;
pub mod wire;

pub use provider::{AnthropicOptions, AnthropicProvider, DEFAULT_BASE_URL};

use serde_json::Value;

use crate::error::{detail, Capability, ProviderError, TransportFailure};

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
    /// The model rejects the thinking mode that was asked for.
    ThinkingConfig,
    /// The history's reasoning blocks were refused; send the turn without them.
    PriorReasoning,
    /// The beta header was not accepted.
    InterleavedBeta,
}

/// Map a non-2xx response onto the one taxonomy.
///
/// Keyed on the error `type` first and the status second: this API always sends
/// a machine-readable type, and matching on prose would make Vela's behaviour
/// depend on an endpoint's copywriting.
pub fn map_error_response(
    status: u16,
    body: &[u8],
    model_id: &str,
    retry_after_header: Option<&str>,
) -> ProviderError {
    let parsed: Option<Value> = serde_json::from_slice(body).ok();
    match parsed.as_ref().and_then(|value| value.get("error")) {
        Some(error) => {
            let mapped = map_error_object(Some(status), error);
            // A rate limit is the one case where the endpoint's own advice
            // beats ours, and it arrives in a header rather than the body.
            match (mapped, retry_after_header.and_then(parse_retry_after_ms)) {
                (ProviderError::RateLimited { detail, .. }, retry) => ProviderError::RateLimited {
                    retry_after_ms: retry,
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

/// Map one `{"type": …, "message": …}` object, wherever it came from: an error
/// response, or an `error` event inside an otherwise-200 stream.
pub fn map_error_object(status: Option<u16>, error: &Value) -> ProviderError {
    let kind = error
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default();

    // A capability refusal is worth more than the status it arrived with: it
    // tells the UI to withdraw an affordance rather than to retry.
    if let Some(capability) = refused_capability(message) {
        return ProviderError::unsupported(capability, message);
    }
    if is_too_long(kind, message) {
        let (limit, requested) = context_numbers(message);
        return ProviderError::ContextLengthExceeded {
            limit_tokens: limit,
            requested_tokens: requested,
            detail: detail(message),
        };
    }

    match kind {
        "authentication_error" | "permission_error" => ProviderError::AuthFailed {
            detail: detail(fallback(message, "the endpoint rejected the credential")),
        },
        "not_found_error" => ProviderError::ModelNotFound {
            model_id: String::new(),
            detail: detail(fallback(message, "not found")),
        },
        "rate_limit_error" => ProviderError::RateLimited {
            retry_after_ms: None,
            detail: detail(fallback(message, "too many requests")),
        },
        "overloaded_error" => ProviderError::transport(
            TransportFailure::Server {
                status: status.unwrap_or(529),
            },
            fallback(message, "the endpoint is overloaded"),
        ),
        "api_error" => ProviderError::transport(
            TransportFailure::Server {
                status: status.unwrap_or(500),
            },
            fallback(message, "the endpoint failed to answer"),
        ),
        "timeout_error" => ProviderError::transport(
            TransportFailure::Timeout,
            fallback(message, "the endpoint timed out"),
        ),
        // `invalid_request_error` and anything newer fall through to the
        // status, so an unmodelled type is never invented into a diagnosis.
        _ => map_status(status.unwrap_or(400), message, None, ""),
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
pub fn concession_for(body: &[u8]) -> Option<Concession> {
    let parsed: Value = serde_json::from_slice(body).ok()?;
    let message = parsed
        .get("error")?
        .get("message")?
        .as_str()?
        .to_ascii_lowercase();
    if message.contains("cannot be modified")
        && (message.contains("thinking") || message.contains("redacted_thinking"))
    {
        // "`thinking` or `redacted_thinking` blocks in the latest assistant
        // message cannot be modified" — the history is incompatible. The spec's
        // instruction is explicit: degrade, do not error.
        return Some(Concession::PriorReasoning);
    }
    if message.contains("anthropic-beta") || message.contains("beta header") {
        return Some(Concession::InterleavedBeta);
    }
    if is_thinking_config_refusal(&message) {
        return Some(Concession::ThinkingConfig);
    }
    None
}

fn is_thinking_config_refusal(lowercase_message: &str) -> bool {
    (lowercase_message.contains("thinking.type") && lowercase_message.contains("not supported"))
        || lowercase_message.contains("adaptive thinking is not supported")
        || (lowercase_message.contains("budget_tokens")
            && lowercase_message.contains("not support"))
}

/// A refusal that names an affordance rather than a mistake.
fn refused_capability(message: &str) -> Option<Capability> {
    let lowered = message.to_ascii_lowercase();
    if !lowered.contains("not supported") && !lowered.contains("does not support") {
        return None;
    }
    if is_thinking_config_refusal(&lowered) {
        return Some(Capability::Reasoning);
    }
    if lowered.contains("image") {
        return Some(Capability::Vision);
    }
    if lowered.contains("tool") {
        return Some(Capability::ToolCalling);
    }
    None
}

fn is_too_long(kind: &str, message: &str) -> bool {
    let lowered = message.to_ascii_lowercase();
    kind == "request_too_large"
        || lowered.contains("prompt is too long")
        || lowered.contains("exceed context limit")
        || lowered.contains("context window")
}

/// Pull `(limit, requested)` out of this API's two documented phrasings:
///
/// * `prompt is too long: 205809 tokens > 200000 maximum`
/// * ``input length and `max_tokens` exceed context limit: 200000 + 8192 > 200000``
///
/// Both put the request on the left of `>` and the limit on the right, and both
/// are `Option`: a number that is not there is not guessed.
fn context_numbers(message: &str) -> (Option<u32>, Option<u32>) {
    let Some((left, right)) = message.split_once('>') else {
        return (None, None);
    };
    let numbers = |text: &str| -> Vec<u64> {
        text.split(|c: char| !c.is_ascii_digit())
            .filter_map(|piece| piece.parse::<u64>().ok())
            .collect()
    };
    let requested: u64 = numbers(left).iter().sum();
    let limit = numbers(right).first().copied();
    (
        limit.and_then(|n| u32::try_from(n).ok()),
        (requested > 0)
            .then_some(requested)
            .and_then(|n| u32::try_from(n).ok()),
    )
}

fn parse_retry_after_ms(header: &str) -> Option<u64> {
    // Seconds form only. The HTTP-date form is deliberately not parsed: a
    // wrong-by-hours backoff is worse than none, and callers fall back to their
    // own policy when this is `None`.
    header
        .trim()
        .parse::<f64>()
        .ok()
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

    fn body(kind: &str, message: &str) -> Vec<u8> {
        json!({"type": "error", "error": {"type": kind, "message": message}})
            .to_string()
            .into_bytes()
    }

    #[test]
    fn the_documented_overflow_message_yields_both_token_counts() {
        let error = map_error_response(
            400,
            &body(
                "invalid_request_error",
                "prompt is too long: 205809 tokens > 200000 maximum",
            ),
            "claude-test",
            None,
        );
        match error {
            ProviderError::ContextLengthExceeded {
                limit_tokens,
                requested_tokens,
                ..
            } => {
                assert_eq!(limit_tokens, Some(200_000));
                assert_eq!(requested_tokens, Some(205_809));
            }
            other => panic!("expected a context error, got {other:?}"),
        }
    }

    #[test]
    fn the_max_tokens_overflow_message_adds_the_two_halves_of_the_request() {
        let error = map_error_response(
            400,
            &body(
                "invalid_request_error",
                "input length and `max_tokens` exceed context limit: 200000 + 8192 > 200000, \
                 decrease input length or `max_tokens` and try again",
            ),
            "claude-test",
            None,
        );
        match error {
            ProviderError::ContextLengthExceeded {
                limit_tokens,
                requested_tokens,
                ..
            } => {
                assert_eq!(limit_tokens, Some(200_000));
                assert_eq!(requested_tokens, Some(208_192));
            }
            other => panic!("expected a context error, got {other:?}"),
        }
    }

    #[test]
    fn a_message_with_no_numbers_in_it_guesses_nothing() {
        assert_eq!(context_numbers("prompt is too long"), (None, None));
    }

    #[test]
    fn an_authentication_error_is_never_failed_over_or_retried() {
        let error = map_error_response(
            401,
            &body("authentication_error", "invalid x-api-key"),
            "m",
            None,
        );
        assert!(matches!(error, ProviderError::AuthFailed { .. }));
        assert!(!error.allows_failover(), "never spray a credential failure");
        assert!(!error.allows_retry());
    }

    #[test]
    fn an_overload_is_a_transient_server_failure_that_may_be_retried() {
        let error = map_error_response(529, &body("overloaded_error", "Overloaded"), "m", None);
        assert!(matches!(
            error,
            ProviderError::Transport {
                failure: TransportFailure::Server { status: 529 },
                ..
            }
        ));
        assert!(error.allows_retry() && error.allows_failover());
    }

    #[test]
    fn a_rate_limit_carries_the_endpoints_own_retry_advice() {
        let error = map_error_response(
            429,
            &body("rate_limit_error", "slow down"),
            "m",
            Some("2.5"),
        );
        assert_eq!(
            error.retry_after(),
            Some(std::time::Duration::from_millis(2_500))
        );
    }

    #[test]
    fn a_not_found_error_names_the_model_the_caller_asked_for() {
        let error = map_error_response(
            404,
            &body("not_found_error", "model: claude-does-not-exist"),
            "claude-does-not-exist",
            None,
        );
        match error {
            ProviderError::ModelNotFound { model_id, .. } => {
                assert_eq!(model_id, "claude-does-not-exist")
            }
            other => panic!("expected model_not_found, got {other:?}"),
        }
    }

    #[test]
    fn a_thinking_mode_refusal_is_a_capability_error_and_a_concession() {
        let raw = body(
            "invalid_request_error",
            "\"thinking.type.enabled\" is not supported for this model. Use \
             \"thinking.type.adaptive\" and \"output_config.effort\" to control thinking behavior.",
        );
        assert_eq!(
            map_error_response(400, &raw, "m", None),
            ProviderError::unsupported(
                Capability::Reasoning,
                "\"thinking.type.enabled\" is not supported for this model. Use \
                 \"thinking.type.adaptive\" and \"output_config.effort\" to control thinking behavior."
            )
        );
        assert_eq!(concession_for(&raw), Some(Concession::ThinkingConfig));
    }

    #[test]
    fn an_unmodifiable_thinking_history_asks_for_the_reasoning_to_be_dropped() {
        let raw = body(
            "invalid_request_error",
            "`thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified",
        );
        assert_eq!(concession_for(&raw), Some(Concession::PriorReasoning));
        assert!(
            matches!(
                map_error_response(400, &raw, "m", None),
                ProviderError::Transport {
                    failure: TransportFailure::Request { status: 400 },
                    ..
                }
            ),
            "a history Vela built wrong is not a capability the model lacks"
        );
    }

    #[test]
    fn a_rejected_beta_header_asks_for_the_header_to_be_dropped() {
        let raw = body(
            "invalid_request_error",
            "unexpected value(s) `interleaved-thinking-2025-05-14` for the `anthropic-beta` header",
        );
        assert_eq!(concession_for(&raw), Some(Concession::InterleavedBeta));
    }

    #[test]
    fn an_ordinary_bad_request_asks_for_no_concession_at_all() {
        assert_eq!(
            concession_for(&body(
                "invalid_request_error",
                "messages: at least one is required"
            )),
            None
        );
        assert_eq!(concession_for(b"<html>gateway</html>"), None);
    }

    #[test]
    fn an_image_refusal_withdraws_vision_rather_than_looking_like_a_bad_request() {
        let error = map_error_response(
            400,
            &body(
                "invalid_request_error",
                "messages.0.content.1.image: image input is not supported by this model",
            ),
            "m",
            None,
        );
        assert!(matches!(
            error,
            ProviderError::CapabilityUnsupported {
                capability: Capability::Vision,
                ..
            }
        ));
    }

    #[test]
    fn a_body_with_no_error_object_still_maps_by_status() {
        assert!(matches!(
            map_error_response(503, b"<html>gateway</html>", "m", None),
            ProviderError::Transport {
                failure: TransportFailure::Server { status: 503 },
                ..
            }
        ));
        assert!(matches!(
            map_error_response(422, b"", "m", None),
            ProviderError::Transport {
                failure: TransportFailure::Request { status: 422 },
                ..
            }
        ));
    }

    #[test]
    fn no_upstream_body_is_ever_copied_whole_into_an_error() {
        let huge = "x".repeat(4_000);
        let error = map_error_response(400, &body("invalid_request_error", &huge), "m", None);
        let rendered = format!("{error}");
        assert!(
            rendered.chars().count() < 300,
            "detail must be bounded: {} chars",
            rendered.chars().count()
        );
    }
}
