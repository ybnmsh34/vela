//! Making four error dialects into one.
//!
//! The core maps a failure onto the taxonomy by reading `error.code` as a
//! string, and every mock-matrix profile emits exactly that. Real servers in
//! this family do not agree:
//!
//! | Server | Body |
//! |---|---|
//! | OpenAI-shaped (and all four matrix profiles) | `{"error":{"message":…,"code":"context_length_exceeded"}}` |
//! | llama.cpp | `{"error":{"code":400,"message":…,"type":"exceed_context_size_error"}}` — `code` is a **number** |
//! | vLLM | `{"object":"error","message":…,"type":"BadRequestError","code":400}` — no `error` object at all |
//! | Ollama | `{"error":"model 'x' not found, try pulling it first"}` — `error` is a **string** |
//!
//! Read literally by the core's mapper, three of those four degrade to "some
//! 4xx", and the message — the only part that says *what went wrong* — is
//! discarded. That is not cosmetic: a context overflow that arrives as a
//! generic 400 cannot be recovered from, whereas
//! `ContextLengthExceeded { limit_tokens }` is exactly what
//! [`CompatProvider`](super::CompatProvider) needs to refit the conversation
//! and retry. So this module rewrites the divergent shapes into the canonical
//! one *before* the core sees them, at the transport seam, with no change to
//! the core at all.
//!
//! # Why a little prose matching is allowed here, and only here
//!
//! The core deliberately refuses to key on message text: "matching on prose
//! would make Vela's behaviour depend on an endpoint's copywriting". That
//! judgement is right when a machine-readable code exists. These servers emit
//! **no** usable code, so the alternatives are prose or nothing. The rules
//! below therefore run only when no usable `code` was found, they map onto two
//! outcomes only, and a miss is always safe: an unrecognised message falls
//! through to the status-based mapping, which is what would have happened
//! anyway.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::http::{
    BodyStream, ByteStream, HttpRequest, HttpResponse, HttpTransport, TransportError,
};
use crate::provider::Timeouts;

/// Largest error body this adapter will buffer, matching the core's own cap.
const MAX_ERROR_BODY_BYTES: usize = 16 * 1024;

/// A transport decorator that rewrites divergent error bodies into the one
/// shape the core's mapper understands.
///
/// It touches **only** responses with a 4xx/5xx status. A 200 — including every
/// streamed completion — is passed through with its body untouched and
/// unbuffered, because buffering it would defeat streaming entirely. That is
/// asserted by [`tests::a_streamed_success_is_never_buffered_or_touched`].
pub struct NormalisingTransport {
    inner: Arc<dyn HttpTransport>,
}

impl NormalisingTransport {
    pub fn new(inner: Arc<dyn HttpTransport>) -> Self {
        Self { inner }
    }
}

#[async_trait]
impl HttpTransport for NormalisingTransport {
    async fn send(
        &self,
        request: HttpRequest,
        timeouts: &Timeouts,
    ) -> Result<HttpResponse, TransportError> {
        let mut response = self.inner.send(request, timeouts).await?;
        if response.status < 400 {
            return Ok(response);
        }

        // MEASURED-1 applies to error bodies too: an endpoint that sends
        // response headers and then goes quiet must not wedge the app. The
        // core's `read_to_end` is unbounded in time, so the read is bounded
        // here instead — and a body that stalls yields what arrived rather than
        // discarding the status, which is still enough to map the failure.
        let raw = read_bounded(&mut response.body, MAX_ERROR_BODY_BYTES, timeouts.stall).await;
        let body = normalise_error_body(response.status, &raw).unwrap_or(raw);
        Ok(HttpResponse {
            status: response.status,
            headers: response.headers,
            body: Box::new(BufferedBody::new(body)),
        })
    }
}

/// Rewrite a non-OpenAI error body into the canonical shape.
///
/// `None` means "leave it alone": either it is already canonical, or nothing
/// useful could be recovered and the status is a better guide than a guess.
pub fn normalise_error_body(status: u16, body: &[u8]) -> Option<Vec<u8>> {
    let value: Value = serde_json::from_slice(body).ok()?;

    let (message, declared_type) = match value.get("error") {
        // Canonical: `error.code` is a string. Nothing to do.
        Some(Value::Object(error)) if error.get("code").and_then(Value::as_str).is_some() => {
            return None
        }
        Some(Value::Object(error)) => (
            error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            error.get("type").and_then(Value::as_str),
        ),
        // Ollama: the whole error is a bare string.
        Some(Value::String(message)) => (message.clone(), None),
        _ => {
            // vLLM and FastAPI-shaped servers put the message at the top level.
            let message = value
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| value.get("detail").and_then(Value::as_str))
                .unwrap_or_default()
                .to_owned();
            if message.is_empty() {
                return None;
            }
            (message, value.get("type").and_then(Value::as_str))
        }
    };

    let code = declared_type
        .and_then(code_for_declared_type)
        .or_else(|| sniff_code(status, &message));

    // A message with no recoverable code is still worth lifting into the
    // canonical shape: the core keeps it as the error's `detail`, and losing it
    // would make a real failure read as "the endpoint rejected the request".
    if message.is_empty() && code.is_none() {
        return None;
    }

    let mut error = serde_json::Map::new();
    error.insert("message".into(), json!(message));
    if let Some(code) = code {
        error.insert("code".into(), json!(code));
    }
    serde_json::to_vec(&json!({ "error": Value::Object(error) })).ok()
}

/// The `type` values that are genuinely machine-readable. Deliberately short:
/// vLLM's `type` is a Python exception class name and OpenAI's
/// `invalid_request_error` covers a dozen unrelated failures, so neither is
/// mapped.
fn code_for_declared_type(declared: &str) -> Option<&'static str> {
    Some(match declared {
        // llama.cpp, when the prompt does not fit the loaded slot.
        "exceed_context_size_error" => "context_length_exceeded",
        "authentication_error" => "invalid_api_key",
        _ => return None,
    })
}

/// The last resort, for servers that emit no code at all.
///
/// Two outcomes only, both chosen because the core can *act* on them: a context
/// overflow becomes a refit-and-retry, and a missing model becomes a clear
/// "that model is not loaded" instead of an anonymous 404.
fn sniff_code(status: u16, message: &str) -> Option<&'static str> {
    let text = message.to_ascii_lowercase();
    let mentions_context = text.contains("context length")
        || text.contains("context size")
        || text.contains("context window");
    if mentions_context && (text.contains("exceed") || text.contains("maximum")) {
        return Some("context_length_exceeded");
    }
    if status == 404 && text.contains("model") && text.contains("not found") {
        return Some("model_not_found");
    }
    None
}

/// A body that is already in memory. Used to hand the rewritten bytes back to
/// the core as if they had just come off the socket.
struct BufferedBody(Option<Vec<u8>>);

impl BufferedBody {
    fn new(bytes: Vec<u8>) -> Self {
        Self(Some(bytes))
    }
}

#[async_trait]
impl ByteStream for BufferedBody {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
        Ok(self.0.take().filter(|bytes| !bytes.is_empty()))
    }
}

/// Read up to `limit` bytes, giving up after `stall` of silence.
///
/// Never fails: whatever arrived before the stall or the read error is returned,
/// because the status alone already maps onto a usable error and a partial body
/// can only improve on it.
async fn read_bounded(body: &mut BodyStream, limit: usize, stall: std::time::Duration) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        match tokio::time::timeout(stall, body.next_chunk()).await {
            Ok(Ok(Some(chunk))) => {
                out.extend_from_slice(&chunk);
                if out.len() >= limit {
                    out.truncate(limit);
                    return out;
                }
            }
            Ok(Ok(None)) | Ok(Err(_)) | Err(_) => return out,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::{Capability, ProviderError};
    use crate::http::testing::{CannedResponse, ScriptedTransport};
    use crate::openai_compatible::map_error_response;

    fn mapped(status: u16, body: &str) -> ProviderError {
        let normalised = normalise_error_body(status, body.as_bytes());
        let bytes = normalised.unwrap_or_else(|| body.as_bytes().to_vec());
        map_error_response(status, &bytes, "m", None)
    }

    #[test]
    fn an_already_canonical_body_is_left_exactly_as_it_was() {
        // Every mock-matrix profile emits this shape; rewriting it would be a
        // regression risk for zero gain.
        let body = r#"{"error":{"message":"nope","type":"invalid_request_error","code":"context_length_exceeded"}}"#;
        assert_eq!(normalise_error_body(400, body.as_bytes()), None);
    }

    #[test]
    fn llama_cpp_reports_a_numeric_code_and_would_otherwise_be_an_anonymous_400() {
        let body = r#"{"error":{"code":400,"message":"the request exceeds the available context size. try increasing the context size or enable context shift","type":"exceed_context_size_error"}}"#;
        // What the core does on its own: `code` is not a string, so it falls
        // through to the status.
        assert!(matches!(
            map_error_response(400, body.as_bytes(), "m", None),
            ProviderError::Transport { .. }
        ));
        // What it does once the shape is normalised.
        assert!(matches!(
            mapped(400, body),
            ProviderError::ContextLengthExceeded {
                limit_tokens: None,
                ..
            }
        ));
    }

    #[test]
    fn vllm_puts_the_message_at_the_top_level_and_still_yields_both_token_counts() {
        let body = r#"{"object":"error","message":"This model's maximum context length is 8192 tokens. However, you requested 10000 tokens.","type":"BadRequestError","param":null,"code":400}"#;
        match mapped(400, body) {
            ProviderError::ContextLengthExceeded {
                limit_tokens,
                requested_tokens,
                ..
            } => {
                assert_eq!(limit_tokens, Some(8_192));
                assert_eq!(requested_tokens, Some(10_000));
            }
            other => panic!("a recoverable overflow must not become an opaque 400: {other:?}"),
        }
    }

    #[test]
    fn ollamas_bare_string_error_survives_as_a_model_not_found() {
        let body = r#"{"error":"model 'llama3.1:8b' not found, try pulling it first"}"#;
        assert!(matches!(
            mapped(404, body),
            ProviderError::ModelNotFound { .. }
        ));
        // And the message is not thrown away.
        assert!(format!("{}", mapped(404, body)).contains("try pulling it first"));
    }

    #[test]
    fn an_authentication_type_maps_onto_the_auth_failure_that_never_fails_over() {
        let body =
            r#"{"error":{"code":401,"message":"invalid api key","type":"authentication_error"}}"#;
        let error = mapped(401, body);
        assert!(matches!(error, ProviderError::AuthFailed { .. }));
        assert!(
            !error.allows_failover(),
            "a credential failure must never be sprayed at other candidates"
        );
    }

    #[test]
    fn an_unrecognised_message_falls_through_to_the_status_rather_than_being_guessed() {
        let body = r#"{"error":"something entirely new happened"}"#;
        assert!(matches!(mapped(418, body), ProviderError::Transport { .. }));
        // A capability refusal is never invented out of prose.
        assert!(!matches!(
            mapped(400, r#"{"error":"tools are weird here"}"#),
            ProviderError::CapabilityUnsupported {
                capability: Capability::ToolCalling,
                ..
            }
        ));
    }

    #[test]
    fn html_and_empty_bodies_are_passed_through_untouched() {
        assert_eq!(normalise_error_body(502, b"<html>bad gateway</html>"), None);
        assert_eq!(normalise_error_body(500, b""), None);
        assert_eq!(normalise_error_body(400, b"{}"), None);
    }

    #[tokio::test]
    async fn a_streamed_success_is_never_buffered_or_touched() {
        let inner = Arc::new(ScriptedTransport::new(vec![Ok(CannedResponse::sse(vec![
            "data: {\"a\":1}\n\n",
            "data: {\"b\":2}\n\n",
        ]))]));
        let transport = NormalisingTransport::new(inner);
        let mut response = transport
            .send(HttpRequest::get("http://x/v1/models"), &Timeouts::default())
            .await
            .unwrap();
        let mut chunks = Vec::new();
        while let Some(chunk) = response.body.next_chunk().await.unwrap() {
            chunks.push(String::from_utf8(chunk).unwrap());
        }
        assert_eq!(
            chunks.len(),
            2,
            "the frames must arrive as they were sent, one read at a time"
        );
    }

    #[tokio::test]
    async fn an_error_body_that_stalls_yields_the_status_instead_of_hanging() {
        struct Stalling;
        #[async_trait]
        impl HttpTransport for Stalling {
            async fn send(
                &self,
                _request: HttpRequest,
                _timeouts: &Timeouts,
            ) -> Result<HttpResponse, TransportError> {
                Ok(HttpResponse {
                    status: 503,
                    headers: Vec::new(),
                    body: Box::new(crate::http::testing::StalledBody),
                })
            }
        }
        let transport = NormalisingTransport::new(Arc::new(Stalling));
        let timeouts = Timeouts {
            stall: std::time::Duration::from_millis(50),
            ..Timeouts::default()
        };
        let mut response = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            transport.send(HttpRequest::get("http://x/v1/chat/completions"), &timeouts),
        )
        .await
        .expect("MEASURED-1: a quiet error body must not wedge the app")
        .unwrap();
        assert_eq!(response.status, 503);
        assert_eq!(response.body.next_chunk().await.unwrap(), None);
    }
}
