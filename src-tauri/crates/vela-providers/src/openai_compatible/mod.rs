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

use crate::diagnostic::{Cause, ConfiguredModelId, Diagnosis};
use crate::error::{Capability, ProviderError, TransportFailure};
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
    model_id: &ConfiguredModelId,
    retry_after_header: Option<&str>,
) -> ProviderError {
    // The body is read for its machine-readable `code` and for the two integers
    // in its context-length phrasing. The `message` is never carried: it is
    // shown to the capability allowlist and to the number extractor, and both
    // of those return types, not text.
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

    let diagnose = |cause: Cause| Diagnosis::new(cause).with_status(status);
    let error = match (!code.is_empty())
        .then(|| map_known_code(code, &message, model_id, Some(status)))
        .flatten()
    {
        Some(error) => error,
        None => match status {
            401 | 403 => ProviderError::auth_failed(diagnose(Cause::CredentialRejected)),
            404 => {
                ProviderError::model_not_found(model_id.clone(), diagnose(Cause::ModelNotServed))
            }
            429 => ProviderError::rate_limited(
                retry_after_header.and_then(parse_retry_after_ms),
                diagnose(Cause::TooManyRequests),
            ),
            413 => ProviderError::ContextLengthExceeded {
                limit_tokens: None,
                requested_tokens: None,
                diagnosis: diagnose(Cause::RequestTooLarge),
            },
            500..=599 => ProviderError::transport(
                TransportFailure::Server { status },
                Diagnosis::new(Cause::EndpointFailedToAnswer),
            ),
            _ => ProviderError::transport(
                TransportFailure::Request { status },
                Diagnosis::new(Cause::EndpointRejectedRequest),
            ),
        },
    };
    let error = error.at(body.endpoint().cloned());
    if let (Some(correlation), Some(cause)) = (error.correlation(), error.cause()) {
        body.record_for_debugging(correlation, cause, Some(status));
    }
    error
}

/// Map a `code` string, wherever it came from — an error response or an error
/// object embedded in a 200 stream.
pub fn map_error_code(
    code: &str,
    message: &str,
    model_id: Option<&ConfiguredModelId>,
) -> ProviderError {
    let unknown = ConfiguredModelId::unknown();
    map_known_code(code, message, model_id.unwrap_or(&unknown), None)
        .unwrap_or_else(|| ProviderError::malformed(Cause::EndpointReportedAnError))
}

fn map_known_code(
    code: &str,
    message: &str,
    model_id: &ConfiguredModelId,
    status: Option<u16>,
) -> Option<ProviderError> {
    let diagnose = |cause: Cause| match status {
        Some(status) => Diagnosis::new(cause).with_status(status),
        None => Diagnosis::new(cause),
    };
    Some(match code {
        "context_length_exceeded" => {
            let (limit, requested) = context_numbers(message);
            ProviderError::ContextLengthExceeded {
                limit_tokens: limit,
                requested_tokens: requested,
                diagnosis: diagnose(Cause::ContextWindowExceeded),
            }
        }
        "invalid_api_key" | "empty_authorization_header" | "invalid_authentication" => {
            ProviderError::auth_failed(diagnose(Cause::CredentialRejected))
        }
        "model_not_found" => {
            ProviderError::model_not_found(model_id.clone(), diagnose(Cause::ModelNotServed))
        }
        "rate_limit_exceeded" | "rate_limited" => {
            ProviderError::rate_limited(None, diagnose(Cause::TooManyRequests))
        }
        "vision_not_supported" => ProviderError::unsupported(
            Capability::Vision,
            diagnose(Cause::CapabilityRefusedByEndpoint),
        ),
        "tools_not_supported" => ProviderError::unsupported(
            Capability::ToolCalling,
            diagnose(Cause::CapabilityRefusedByEndpoint),
        ),
        "response_format_not_supported" => ProviderError::unsupported(
            Capability::StructuredOutput,
            diagnose(Cause::CapabilityRefusedByEndpoint),
        ),
        "model_listing_not_supported" => ProviderError::unsupported(
            Capability::ModelListing,
            diagnose(Cause::CapabilityRefusedByEndpoint),
        ),
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

// `fallback(message, default)` — "use the endpoint's own words if it sent any,
// otherwise use ours" — used to live here. Deleted rather than left unused: it
// was the exact expression of the strategy four rounds of Phase B failed on.

#[cfg(test)]
mod tests {
    use super::*;

    /// The model id these tests pretend Vela asked for. Built the only way one
    /// can be built — out of a request — which is the point.
    fn model(id: &str) -> ConfiguredModelId {
        ConfiguredModelId::of(&crate::model::ChatRequest::new(id))
    }

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
        let error = map_error_response(400, &fake(OVERFLOW_BODY), &model("mock-small-local"), None);
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
            let error = map_error_response(400, &fake(&body), &model("m"), None);
            assert_eq!(
                error,
                ProviderError::unsupported(
                    capability,
                    Diagnosis::new(Cause::CapabilityRefusedByEndpoint).with_status(400)
                ),
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
        let error = map_error_response(401, &fake(body), &model("m"), None);
        assert!(matches!(error, ProviderError::AuthFailed { .. }));
        assert!(!error.allows_failover(), "never spray a credential failure");
    }

    #[test]
    fn a_429_carries_the_endpoints_own_retry_advice() {
        let error = map_error_response(429, &fake("{}"), &model("m"), Some("2.5"));
        assert_eq!(
            error.retry_after(),
            Some(std::time::Duration::from_millis(2_500))
        );
    }

    #[test]
    fn a_body_with_no_error_object_still_maps_by_status() {
        assert!(matches!(
            map_error_response(503, &fake("<html>gateway</html>"), &model("m"), None),
            ProviderError::Transport {
                failure: TransportFailure::Server { status: 503 },
                ..
            }
        ));
        assert!(matches!(
            map_error_response(422, &fake(""), &model("m"), None),
            ProviderError::Transport {
                failure: TransportFailure::Request { status: 422 },
                ..
            }
        ));
    }

    #[test]
    fn an_unknown_code_falls_back_to_the_status_rather_than_being_invented() {
        let body = r#"{"error":{"message":"something new","code":"never_seen_before"}}"#;
        let error = map_error_response(400, &fake(body), &model("m"), None);
        assert!(matches!(error, ProviderError::Transport { .. }));
        // This assertion is inverted from what it used to be, deliberately.
        //
        // It used to demand that the endpoint's own words — "something new" —
        // reach `Display`. That demand is the whole defect: whatever the
        // endpoint chooses to put in `message`, in whatever spelling, reaching
        // a surface Vela renders. Four rounds of Phase B died on it.
        //
        // What replaces it is a claim about *classification*, which is the part
        // that was ever worth having: an unmodelled `code` does not get
        // invented into a diagnosis, it falls through to the status, and the
        // status rides along typed.
        assert!(
            !format!("{error}").contains("something new"),
            "the endpoint's own words must not reach any surface: {error}"
        );
        assert_eq!(error.status(), Some(400));
        assert_eq!(error.cause(), Some(Cause::EndpointRejectedRequest));
    }
}
