//! The HTTP seam.
//!
//! # Why HTTP lives here and nowhere else (MEASURED-6)
//!
//! The mock matrix recorded no CORS headers on any response and a `405` for an
//! `OPTIONS` preflight. A browser-hosted renderer therefore *cannot* call a
//! model endpoint, no matter how the code is written. Every byte Vela sends to
//! a model leaves from the Rust core and every byte it reads comes back over
//! the IPC bridge — which is also the correct security posture, and is asserted
//! mechanically by `vela-settings/tests/capability_matrix_endpoints.rs`.
//!
//! # Why the trait exists
//!
//! [`HttpTransport`] lets the whole normalisation stack — the SSE decoder, the
//! reasoning splitter, the tool accumulator, the router — be tested with byte
//! sequences instead of sockets, and lets an adapter builder script a
//! pathological endpoint that no live harness happens to implement. The real
//! implementation is [`ReqwestTransport`]; anything exercised only against the
//! fakes in [`testing`] is **VERIFIED-BY-FAKE**.

use async_trait::async_trait;
use vela_core::secret::{SecretValue, REDACTED};
use vela_secrets::AppliedAuth;

use crate::error::{detail, ProviderError, TransportFailure};
use crate::provider::Timeouts;
use crate::redact::{RequestUrl, Scrubber};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpMethod {
    Get,
    Post,
}

impl HttpMethod {
    pub const fn as_str(self) -> &'static str {
        match self {
            HttpMethod::Get => "GET",
            HttpMethod::Post => "POST",
        }
    }
}

/// Header names whose value is credential material by convention, whoever set
/// them. [`HttpRequest::with_auth`] records the credential it applied, so this
/// list is redundant for anything Vela builds through the seam — it is here so
/// that a `with_header("authorization", …)` written in a hurry, in a future
/// adapter, is still redacted by `Debug`.
const CREDENTIAL_HEADERS: &[&str] = &[
    "authorization",
    "proxy-authorization",
    "x-api-key",
    "api-key",
    "x-goog-api-key",
    "cookie",
];

fn is_credential_header(name: &str) -> bool {
    CREDENTIAL_HEADERS
        .iter()
        .any(|known| name.eq_ignore_ascii_case(known))
}

#[derive(Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: HttpMethod,
    /// Not a `String`: a URL may carry a credential (`Auth::ApiKeyQuery`), and
    /// [`RequestUrl`] is the type that cannot be printed into showing it. See
    /// [`crate::redact`].
    pub url: RequestUrl,
    /// Header names are lowercase. **An `authorization` header is present only
    /// when a credential exists** — never empty. See `vela_secrets::resolve_auth`.
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    /// Lowercased names of headers this request was given as credentials, so
    /// `Debug` and [`HttpRequest::scrubber`] know what not to let out. Private:
    /// it is set by [`HttpRequest::with_auth`] and nowhere else.
    secret_headers: Vec<String>,
}

impl HttpRequest {
    pub fn get(url: impl Into<RequestUrl>) -> Self {
        Self {
            method: HttpMethod::Get,
            url: url.into(),
            headers: Vec::new(),
            body: None,
            secret_headers: Vec::new(),
        }
    }

    pub fn post_json(url: impl Into<RequestUrl>, body: Vec<u8>) -> Self {
        Self {
            method: HttpMethod::Post,
            url: url.into(),
            headers: vec![("content-type".into(), "application/json".into())],
            body: Some(body),
            secret_headers: Vec::new(),
        }
    }

    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers
            .push((name.into().to_ascii_lowercase(), value.into()));
        self
    }

    /// **The one place a credential is attached to a request.**
    ///
    /// All four adapters resolve an `Auth` binding into an [`AppliedAuth`] and
    /// then had their own copy of this `match`, each with its own `format!` and
    /// its own private percent-encoder. Three lines of duplication is cheap;
    /// three chances to forget that the result is credential material is not.
    ///
    /// [`AppliedAuth::None`] adds nothing — not an empty header, not an empty
    /// query parameter. "No credential" is a supported state (conventions §0
    /// rule 2), and it must be indistinguishable on the wire from a provider
    /// that has no auth at all.
    pub fn with_auth(self, applied: &AppliedAuth) -> Self {
        match applied {
            AppliedAuth::None => self,
            AppliedAuth::Header { name, value } => self.with_credential_header(name, value),
            AppliedAuth::QueryParam { name, value } => self.with_query_credential(name, value),
        }
    }

    fn with_credential_header(mut self, name: &str, value: &SecretValue) -> Self {
        let name = name.to_ascii_lowercase();
        self.headers.push((name.clone(), value.expose().to_owned()));
        self.secret_headers.push(name);
        self
    }

    fn with_query_credential(mut self, name: &str, value: &SecretValue) -> Self {
        self.url = std::mem::take(&mut self.url).with_query_credential(name, value);
        self
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    /// Every literal this request's credentials consist of, so that text
    /// derived from it — a client's error string, a body an endpoint echoed
    /// back — can be cleaned before it becomes a `detail`.
    pub fn scrubber(&self) -> Scrubber {
        let mut needles: Vec<String> = Vec::new();
        for (name, value) in &self.headers {
            if !self.secret_headers.iter().any(|secret| secret == name) {
                continue;
            }
            needles.push(value.clone());
            // A `Bearer <token>` header is one needle; the bare token is
            // another, because that is the form that would turn up in a query
            // string or a vendor error body.
            if let Some((_, token)) = value.split_once(' ') {
                needles.push(token.to_owned());
            }
        }
        Scrubber::new(needles).merged(&self.url.scrubber())
    }

    /// Headers with credential values replaced. What `Debug` prints, and what
    /// any recorder or transcript should print.
    pub fn redacted_headers(&self) -> Vec<(String, String)> {
        self.headers
            .iter()
            .map(|(name, value)| {
                let secret = is_credential_header(name)
                    || self.secret_headers.iter().any(|known| known == name);
                let value = if secret {
                    format!("{REDACTED} ({} bytes)", value.len())
                } else {
                    value.clone()
                };
                (name.clone(), value)
            })
            .collect()
    }
}

impl std::fmt::Debug for HttpRequest {
    /// Derived `Debug` would print the credential header verbatim and the URL
    /// query string with it. This one prints neither, and prints the body's
    /// length rather than the body: a prompt is not a secret, but it is not
    /// something a diagnostic should splatter either.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpRequest")
            .field("method", &self.method)
            .field("url", &self.url)
            .field("headers", &self.redacted_headers())
            .field("body_bytes", &self.body.as_ref().map(Vec::len))
            .finish()
    }
}

/// A response whose body has **not** been read.
///
/// The body is a stream on purpose: a completion may run for minutes, and
/// buffering it would defeat streaming entirely.
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: BodyStream,
}

impl HttpResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    /// Read the whole body. Used for non-streaming calls and error bodies.
    ///
    /// `limit` bounds what a hostile or broken endpoint can make Vela allocate.
    ///
    /// The body is scrubbed of this request's own credential material before it
    /// is returned. An endpoint that echoes the key it was sent — into an error
    /// message, into a `"detail"` field — otherwise hands it straight back into
    /// `map_error_response`, which is a `detail` on a `ProviderError` and from
    /// there the IPC bridge. Scrubbing is a no-op, and skipped entirely, for
    /// the ordinary case of a request that carried no credential in its URL.
    pub async fn read_to_end(&mut self, limit: usize) -> Result<Vec<u8>, TransportError> {
        let mut out = Vec::new();
        while let Some(chunk) = self.body.next_chunk().await? {
            out.extend_from_slice(&chunk);
            if out.len() > limit {
                out.truncate(limit);
                break;
            }
        }
        Ok(self.body.scrubber().scrub_bytes(out))
    }
}

pub type BodyStream = Box<dyn ByteStream>;

/// An incrementally readable body.
///
/// `Ok(None)` means **end of body**, which is the only reliable end-of-stream
/// signal there is (MEASURED-1). A `Stream` impl was rejected deliberately:
/// this shape needs no futures dependency and a fake is four lines.
#[async_trait]
pub trait ByteStream: Send {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, TransportError>;

    /// The credential material of the request this body answers.
    ///
    /// Defaulted to "nothing", so a fake body is four lines as before; the real
    /// one overrides it with the scrubber built from the request it sent. It
    /// lives on the body rather than on [`HttpResponse`] because the body is
    /// what outlives the request.
    fn scrubber(&self) -> Scrubber {
        Scrubber::none()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportError {
    pub failure: TransportFailure,
    pub detail: String,
}

impl TransportError {
    pub fn new(failure: TransportFailure, raw: impl AsRef<str>) -> Self {
        Self {
            failure,
            detail: detail(raw),
        }
    }
}

impl From<TransportError> for ProviderError {
    fn from(error: TransportError) -> Self {
        ProviderError::Transport {
            failure: error.failure,
            detail: error.detail,
        }
    }
}

/// Send a request, get headers back. The body is read separately.
#[async_trait]
pub trait HttpTransport: Send + Sync {
    async fn send(
        &self,
        request: HttpRequest,
        timeouts: &Timeouts,
    ) -> Result<HttpResponse, TransportError>;
}

// ---------------------------------------------------------------------------
// The real one
// ---------------------------------------------------------------------------

/// `reqwest`, configured for this application's constraints.
pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl ReqwestTransport {
    pub fn new() -> Result<Self, ProviderError> {
        Self::with_connect_timeout(Timeouts::default().connect)
    }

    pub fn with_connect_timeout(connect: std::time::Duration) -> Result<Self, ProviderError> {
        let client = reqwest::Client::builder()
            .connect_timeout(connect)
            // No implicit egress. Vela talks to the endpoint the user
            // configured and to nothing else — an ambient `HTTPS_PROXY` in the
            // environment must not silently redirect a local model request
            // through a third party.
            // TODO(phase-D, providers): explicit, user-configured proxy support.
            .no_proxy()
            .user_agent(concat!("vela/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| ProviderError::from(map_reqwest_error(error, &Scrubber::none())))?;
        Ok(Self { client })
    }
}

#[async_trait]
impl HttpTransport for ReqwestTransport {
    async fn send(
        &self,
        request: HttpRequest,
        timeouts: &Timeouts,
    ) -> Result<HttpResponse, TransportError> {
        // Built before the request is consumed, and carried into the body: a
        // mid-stream failure arrives long after `request` is gone, and it is
        // just as capable of quoting the URL back at us.
        let scrubber = request.scrubber();

        // THE ONE PLACE the wire form of a URL is taken. It goes to the socket,
        // never to a string that could become a message.
        let mut builder = match request.method {
            HttpMethod::Get => self.client.get(request.url.expose()),
            HttpMethod::Post => self.client.post(request.url.expose()),
        };
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        if let Some(body) = request.body {
            builder = builder.body(body);
        }

        let response = tokio::time::timeout(timeouts.first_byte, builder.send())
            .await
            .map_err(|_| {
                TransportError::new(
                    TransportFailure::Timeout,
                    format!(
                        "no response headers within {} ms",
                        timeouts.first_byte.as_millis()
                    ),
                )
            })?
            .map_err(|error| map_reqwest_error(error, &scrubber))?;

        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_ascii_lowercase(),
                    value.to_str().unwrap_or_default().to_owned(),
                )
            })
            .collect();

        Ok(HttpResponse {
            status,
            headers,
            body: Box::new(ReqwestBody { response, scrubber }),
        })
    }
}

struct ReqwestBody {
    response: reqwest::Response,
    scrubber: Scrubber,
}

#[async_trait]
impl ByteStream for ReqwestBody {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
        match self.response.chunk().await {
            Ok(Some(bytes)) => Ok(Some(bytes.to_vec())),
            Ok(None) => Ok(None),
            Err(error) => Err(map_reqwest_error(error, &self.scrubber)),
        }
    }

    fn scrubber(&self) -> Scrubber {
        self.scrubber.clone()
    }
}

/// Every `reqwest` failure in this workspace becomes a `TransportError` here
/// and nowhere else.
///
/// # Why this function takes a scrubber
///
/// `reqwest`'s `Display` ends with `" for url ({url})"` — the whole URL, query
/// string included. With `Auth::ApiKeyQuery` that string *is* the credential,
/// and `detail()` sanitises but does not redact, so before this fix a refused
/// connection put the user's API key into `ProviderError::Transport`'s
/// `Display`, `Debug` and serde JSON — the last of which is the shape that
/// crosses the IPC bridge to the WebView.
///
/// Two independent guards, because one is a promise about someone else's crate:
///
/// * [`reqwest::Error::without_url`] drops the URL before it is ever formatted.
/// * The scrubber removes the credential from whatever is left — the source
///   chain, a future `reqwest` release that formats more, an error whose text
///   came from somewhere else entirely.
///
/// Scrubbing happens **before** `detail()` truncates, because truncating first
/// can cut a credential in half and keep the half.
fn map_reqwest_error(error: reqwest::Error, scrubber: &Scrubber) -> TransportError {
    let failure = if error.is_connect() {
        TransportFailure::Connect
    } else if error.is_timeout() {
        TransportFailure::Timeout
    } else {
        // Includes the mid-upload reset GATE M FINDING 1 warns about: a reset
        // on a large POST may be a size-limit rejection, so this must never be
        // reported to the user as "the endpoint is down".
        TransportFailure::Reset
    };
    TransportError::new(failure, scrubber.scrub(error.without_url().to_string()))
}

// ---------------------------------------------------------------------------
// Fakes — for this crate's tests and for adapter builders'
// ---------------------------------------------------------------------------

/// Scriptable transports. **Anything proved with these is VERIFIED-BY-FAKE**
/// (`conventions.md` §10): they prove parsing, normalisation and control flow,
/// and nothing whatsoever about a real endpoint.
pub mod testing {
    use std::sync::{Arc, Mutex};

    use super::*;

    /// A body handed out in pre-set chunks — the way to reproduce a specific
    /// frame fragmentation exactly.
    pub struct ScriptedBody {
        chunks: std::vec::IntoIter<Vec<u8>>,
        /// Returned instead of end-of-body once the chunks run out.
        fail_at_end: Option<TransportError>,
    }

    impl ScriptedBody {
        pub fn new(chunks: Vec<Vec<u8>>) -> Self {
            Self {
                chunks: chunks.into_iter(),
                fail_at_end: None,
            }
        }

        pub fn from_text(text: &str) -> Self {
            Self::new(vec![text.as_bytes().to_vec()])
        }

        /// Split `text` into `size`-byte chunks: frames, tags and UTF-8
        /// sequences all land across boundaries, which is the point.
        pub fn fragmented(text: &str, size: usize) -> Self {
            let bytes = text.as_bytes();
            Self::new(
                bytes
                    .chunks(size.max(1))
                    .map(<[u8]>::to_vec)
                    .collect::<Vec<_>>(),
            )
        }

        pub fn failing_at_end(mut self, error: TransportError) -> Self {
            self.fail_at_end = Some(error);
            self
        }
    }

    #[async_trait]
    impl ByteStream for ScriptedBody {
        async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
            match self.chunks.next() {
                Some(chunk) => Ok(Some(chunk)),
                None => match self.fail_at_end.take() {
                    Some(error) => Err(error),
                    None => Ok(None),
                },
            }
        }
    }

    /// A body that never yields anything and never ends. Used to prove the
    /// stall timeout is real rather than documented.
    pub struct StalledBody;

    #[async_trait]
    impl ByteStream for StalledBody {
        async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
            std::future::pending().await
        }
    }

    /// A canned response.
    pub struct CannedResponse {
        pub status: u16,
        pub headers: Vec<(String, String)>,
        pub body: Vec<Vec<u8>>,
    }

    impl CannedResponse {
        pub fn ok(body: &str) -> Self {
            Self {
                status: 200,
                headers: vec![("content-type".into(), "application/json".into())],
                body: vec![body.as_bytes().to_vec()],
            }
        }

        pub fn sse(chunks: Vec<&str>) -> Self {
            Self {
                status: 200,
                headers: vec![("content-type".into(), "text/event-stream".into())],
                body: chunks.into_iter().map(|c| c.as_bytes().to_vec()).collect(),
            }
        }

        pub fn error(status: u16, body: &str) -> Self {
            Self {
                status,
                headers: vec![("content-type".into(), "application/json".into())],
                body: vec![body.as_bytes().to_vec()],
            }
        }

        pub fn with_header(mut self, name: &str, value: &str) -> Self {
            self.headers
                .push((name.to_ascii_lowercase(), value.to_owned()));
            self
        }
    }

    /// Serves canned responses in order and records every request it saw.
    pub struct ScriptedTransport {
        responses: Mutex<std::vec::IntoIter<Result<CannedResponse, TransportError>>>,
        pub requests: Arc<Mutex<Vec<HttpRequest>>>,
    }

    impl ScriptedTransport {
        pub fn new(responses: Vec<Result<CannedResponse, TransportError>>) -> Self {
            Self {
                responses: Mutex::new(responses.into_iter()),
                requests: Arc::new(Mutex::new(Vec::new())),
            }
        }

        pub fn ok(body: &str) -> Self {
            Self::new(vec![Ok(CannedResponse::ok(body))])
        }

        pub fn recorded(&self) -> Vec<HttpRequest> {
            self.requests.lock().expect("not poisoned").clone()
        }
    }

    #[async_trait]
    impl HttpTransport for ScriptedTransport {
        async fn send(
            &self,
            request: HttpRequest,
            _timeouts: &Timeouts,
        ) -> Result<HttpResponse, TransportError> {
            self.requests
                .lock()
                .expect("not poisoned")
                .push(request.clone());
            let next = self.responses.lock().expect("not poisoned").next();
            match next {
                Some(Ok(canned)) => Ok(HttpResponse {
                    status: canned.status,
                    headers: canned.headers,
                    body: Box::new(ScriptedBody::new(canned.body)),
                }),
                Some(Err(error)) => Err(error),
                None => Err(TransportError::new(
                    TransportFailure::Connect,
                    "the script ran out of responses",
                )),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;

    #[tokio::test]
    async fn a_scripted_body_hands_back_exactly_the_chunks_it_was_given() {
        let mut body = ScriptedBody::fragmented("abcdefg", 3);
        let mut seen = Vec::new();
        while let Some(chunk) = body.next_chunk().await.unwrap() {
            seen.push(String::from_utf8(chunk).unwrap());
        }
        assert_eq!(seen, vec!["abc", "def", "g"]);
    }

    #[tokio::test]
    async fn the_transport_records_requests_so_the_wire_shape_can_be_asserted() {
        let transport = ScriptedTransport::ok("{}");
        let request =
            HttpRequest::post_json("http://127.0.0.1:1/v1/chat/completions", b"{}".to_vec())
                .with_header("Authorization", "Bearer x");
        transport.send(request, &Timeouts::default()).await.unwrap();
        let recorded = transport.recorded();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].header("authorization"), Some("Bearer x"));
        assert_eq!(recorded[0].header("content-type"), Some("application/json"));
    }

    #[tokio::test]
    async fn reading_a_body_to_end_respects_the_limit() {
        let mut response = HttpResponse {
            status: 200,
            headers: Vec::new(),
            body: Box::new(ScriptedBody::fragmented(&"x".repeat(100), 7)),
        };
        let body = response.read_to_end(10).await.unwrap();
        assert_eq!(body.len(), 10, "a hostile body cannot make Vela allocate");
    }

    #[test]
    fn a_transport_error_normalises_into_the_one_taxonomy() {
        let error: ProviderError =
            TransportError::new(TransportFailure::Reset, "connection reset").into();
        assert_eq!(error.code(), "transport");
        assert!(error.allows_failover());
    }
}
