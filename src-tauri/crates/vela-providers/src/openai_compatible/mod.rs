//! The OpenAI-compatible backend — llama.cpp, Ollama, LM Studio, vLLM, and
//! every hosted API that speaks the same surface.
//!
//! One implementation covers all of them because the *shape* is shared; what
//! differs is which parts of it actually work, and that is established by
//! probing (see [`capability`](crate::capability)), never by the provider's
//! name.

mod provider;
pub mod wire;

pub use provider::{OpenAiCompatibleProvider, ProviderOptions};

use serde_json::Value;

use crate::error::{detail, Capability, ProviderError, TransportFailure};
use crate::http::UpstreamBytes;

/// Longest error body Vela will read. `conventions.md` §3.2 forbids raw
/// upstream bodies reaching the renderer, and this bounds what a broken
/// endpoint can make it allocate.
pub const MAX_ERROR_BODY_BYTES: usize = 16 * 1024;

/// Map a non-2xx response onto the one taxonomy.
///
/// Keying on `code` first and status second is deliberate: all four matrix
/// profiles emit a machine-readable `code`, and matching on prose would make
/// Vela's behaviour depend on an endpoint's copywriting.
pub fn map_error_response(
    status: u16,
    body: &UpstreamBytes,
    model_id: &str,
    retry_after_header: Option<&str>,
) -> ProviderError {
    // `UpstreamBytes::json` scrubs the decoded strings, so everything read out
    // of `parsed` below is already clean however the endpoint spelled it. The
    // byte scrub upstream of here removes what it can see; this removes what a
    // decoder would have put back. See `crate::redact`.
    let parsed: Option<Value> = body.json_or_none();
    let error_object = parsed.as_ref().and_then(|value| value.get("error"));
    let code = error_object
        .and_then(|error| error.get("code"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message = error_object
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();

    if !code.is_empty() {
        if let Some(error) = map_known_code(code, &message, model_id) {
            return error;
        }
    }

    match status {
        401 | 403 => ProviderError::AuthFailed {
            detail: detail(fallback(&message, "the endpoint rejected the credential")),
        },
        404 => ProviderError::ModelNotFound {
            model_id: model_id.to_owned(),
            detail: detail(fallback(&message, "not found")),
        },
        429 => ProviderError::RateLimited {
            retry_after_ms: retry_after_header.and_then(parse_retry_after_ms),
            detail: detail(fallback(&message, "too many requests")),
        },
        413 => ProviderError::ContextLengthExceeded {
            limit_tokens: None,
            requested_tokens: None,
            detail: detail(fallback(
                &message,
                "the endpoint refused the request as too large",
            )),
        },
        500..=599 => ProviderError::transport(
            TransportFailure::Server { status },
            fallback(&message, "the endpoint failed to answer"),
        ),
        _ => ProviderError::transport(
            TransportFailure::Request { status },
            fallback(&message, "the endpoint rejected the request"),
        ),
    }
}

/// Map a `code` string, wherever it came from — an error response or an error
/// object embedded in a 200 stream.
pub fn map_error_code(code: &str, message: &str, model_id: Option<&str>) -> ProviderError {
    map_known_code(code, message, model_id.unwrap_or_default()).unwrap_or_else(|| {
        ProviderError::malformed(fallback(message, "the endpoint reported an error"))
    })
}

fn map_known_code(code: &str, message: &str, model_id: &str) -> Option<ProviderError> {
    Some(match code {
        "context_length_exceeded" => {
            let (limit, requested) = context_numbers(message);
            ProviderError::ContextLengthExceeded {
                limit_tokens: limit,
                requested_tokens: requested,
                detail: detail(message),
            }
        }
        "invalid_api_key" | "empty_authorization_header" | "invalid_authentication" => {
            ProviderError::AuthFailed {
                detail: detail(message),
            }
        }
        "model_not_found" => ProviderError::ModelNotFound {
            model_id: model_id.to_owned(),
            detail: detail(message),
        },
        "rate_limit_exceeded" | "rate_limited" => ProviderError::RateLimited {
            retry_after_ms: None,
            detail: detail(message),
        },
        "vision_not_supported" => ProviderError::unsupported(Capability::Vision, message),
        "tools_not_supported" => ProviderError::unsupported(Capability::ToolCalling, message),
        "response_format_not_supported" => {
            ProviderError::unsupported(Capability::StructuredOutput, message)
        }
        "model_listing_not_supported" => {
            ProviderError::unsupported(Capability::ModelListing, message)
        }
        _ => return None,
    })
}

/// Pull the two token counts out of the standard phrasing:
/// *"this model's maximum context length is 8192 tokens, however you requested
/// 8212 tokens"*. Both are `Option`: a number that is not there is not guessed.
fn context_numbers(message: &str) -> (Option<u32>, Option<u32>) {
    let mut numbers = message
        .split(|c: char| !c.is_ascii_digit())
        .filter(|piece| !piece.is_empty())
        .filter_map(|piece| piece.parse::<u32>().ok());
    (numbers.next(), numbers.next())
}

fn parse_retry_after_ms(header: &str) -> Option<u64> {
    // Seconds form only. The HTTP-date form is deliberately not parsed: a
    // wrong-by-hours backoff is worse than none, and callers fall back to
    // their own policy when this is `None`.
    header
        .trim()
        .parse::<f64>()
        .ok()
        .map(|s| (s * 1000.0) as u64)
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

    /// An error body that answers no request of ours, so there is no credential
    /// in it to remove. The credentialed path is driven end to end in
    /// `tests/encoded_credential_canary.rs`.
    fn fake(body: &str) -> UpstreamBytes {
        UpstreamBytes::carries_no_credential(body)
    }

    const OVERFLOW_BODY: &str = r#"{"error":{"message":"this model's maximum context length is 8192 tokens, however you requested 8212 tokens (8212 in the messages, 0 in the completion)","type":"invalid_request_error","param":"messages","code":"context_length_exceeded"}}"#;

    #[test]
    fn the_recorded_overflow_body_yields_both_token_counts() {
        // Verbatim from small-local/06-context-overflow.txt.
        let error = map_error_response(400, &fake(OVERFLOW_BODY), "mock-small-local", None);
        match error {
            ProviderError::ContextLengthExceeded {
                limit_tokens,
                requested_tokens,
                ..
            } => {
                assert_eq!(limit_tokens, Some(8_192));
                assert_eq!(requested_tokens, Some(8_212));
            }
            other => panic!("expected a context error, got {other:?}"),
        }
    }

    #[test]
    fn the_capability_refusals_the_matrix_emits_map_onto_capability_errors() {
        for (code, capability) in [
            ("vision_not_supported", Capability::Vision),
            ("tools_not_supported", Capability::ToolCalling),
            (
                "response_format_not_supported",
                Capability::StructuredOutput,
            ),
            ("model_listing_not_supported", Capability::ModelListing),
        ] {
            let body = format!(r#"{{"error":{{"message":"nope","code":"{code}"}}}}"#);
            let error = map_error_response(400, &fake(&body), "m", None);
            assert_eq!(
                error,
                ProviderError::unsupported(capability, "nope"),
                "code {code} must not be reported as a generic 400"
            );
            assert!(
                !error.allows_failover() && !error.allows_retry(),
                "a capability refusal is not a transport problem"
            );
        }
    }

    #[test]
    fn an_empty_authorization_header_is_an_auth_failure_not_a_transport_one() {
        // The harness answers this 401 precisely so the "empty Bearer" bug is
        // loud rather than silent.
        let body = r#"{"error":{"message":"an Authorization header was sent with no credential in it","type":"authentication_error","code":"empty_authorization_header"}}"#;
        let error = map_error_response(401, &fake(body), "m", None);
        assert!(matches!(error, ProviderError::AuthFailed { .. }));
        assert!(!error.allows_failover(), "never spray a credential failure");
    }

    #[test]
    fn a_429_carries_the_endpoints_own_retry_advice() {
        let error = map_error_response(429, &fake("{}"), "m", Some("2.5"));
        assert_eq!(
            error.retry_after(),
            Some(std::time::Duration::from_millis(2_500))
        );
    }

    #[test]
    fn a_body_with_no_error_object_still_maps_by_status() {
        assert!(matches!(
            map_error_response(503, &fake("<html>gateway</html>"), "m", None),
            ProviderError::Transport {
                failure: TransportFailure::Server { status: 503 },
                ..
            }
        ));
        assert!(matches!(
            map_error_response(422, &fake(""), "m", None),
            ProviderError::Transport {
                failure: TransportFailure::Request { status: 422 },
                ..
            }
        ));
    }

    #[test]
    fn an_unknown_code_falls_back_to_the_status_rather_than_being_invented() {
        let body = r#"{"error":{"message":"something new","code":"never_seen_before"}}"#;
        let error = map_error_response(400, &fake(&body), "m", None);
        assert!(matches!(error, ProviderError::Transport { .. }));
        assert!(format!("{error}").contains("something new"));
    }
}
