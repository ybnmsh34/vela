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

    /// What a body answering this request needs to know: the credential
    /// material that must never survive into an error, and the redacted
    /// endpoint that must.
    ///
    /// Built before the request is consumed, because a mid-stream failure
    /// arrives long after `request` is gone and is just as capable of quoting
    /// the URL back at us.
    pub fn origin(&self) -> BodyOrigin {
        BodyOrigin::new(self.scrubber(), self.url.redacted())
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
    /// No scrubbing happens here, and that is the point: every byte already
    /// came out of [`BodyStream::next_chunk`], which is the one door bytes can
    /// leave a body by, and it scrubs. This function used to be the *only*
    /// scrubbed read, which is precisely how the streaming path went unredacted
    /// (GATE M Part 1, Phase B, FINDING 2).
    pub async fn read_to_end(&mut self, limit: usize) -> Result<Vec<u8>, TransportError> {
        let mut out = Vec::new();
        while let Some(chunk) = self.body.next_chunk().await? {
            out.extend_from_slice(&chunk);
            if out.len() > limit {
                out.truncate(limit);
                break;
            }
        }
        Ok(out)
    }
}

/// What a body knows about the request it answers.
///
/// Two things, and both exist because a failure can arrive long after the
/// request struct is gone:
///
/// * the [`Scrubber`] — the credential material that must not survive into any
///   text derived from this exchange;
/// * the **redacted** endpoint — which must survive, because a user with three
///   configured candidates has to be able to tell which one failed. Redaction
///   removes the secret, not the diagnosis.
#[derive(Clone, Debug, Default)]
pub struct BodyOrigin {
    scrubber: Scrubber,
    /// Already redacted: [`RequestUrl::redacted`], never `expose`.
    endpoint: String,
}

impl BodyOrigin {
    pub fn new(scrubber: Scrubber, redacted_endpoint: impl Into<String>) -> Self {
        Self {
            scrubber,
            endpoint: redacted_endpoint.into(),
        }
    }

    /// For a body that answers no request Vela sent — a fake, a replayer, a
    /// buffer built in memory. Named rather than defaulted: "this carries no
    /// credential" is a claim, and a claim should be typed out.
    pub fn carries_no_credential() -> Self {
        Self::default()
    }

    pub fn scrubber(&self) -> &Scrubber {
        &self.scrubber
    }

    /// Safe to print. Empty when the body answers no request of ours.
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }
}

/// A response body, and **the only way to read one**.
///
/// # Why this is a struct and not `Box<dyn ByteStream>`
///
/// It used to be the alias, and redaction hung off an *overridable trait
/// method* — `ByteStream::scrubber()`, defaulting to [`Scrubber::none`]. That
/// shape failed twice over:
///
/// * the streaming path never called it at all, so a credential echoed back
///   inside a 200 SSE error frame reached `Display`, `Debug`, the serde shape
///   that crosses the IPC bridge, and the `StreamEvent` handed to the UI;
/// * and any decorating body — a recorder, a cache, a rate limiter — silently
///   disabled the redaction of the body it wrapped just by not forwarding the
///   method. That happened, to the gate's own recorder, during the run that
///   found the first bug.
///
/// A security property carried by an overridable method that defaults to no
/// protection is not a security property. So: the raw [`ByteStream`] is sealed
/// inside this type, the trait has no scrubber to forget, and
/// [`BodyStream::next_chunk`] — the single exit for bytes — scrubs. A decorator
/// now wraps a `BodyStream` and reads through it, so the bytes it sees have
/// *already* been cleaned; omission cannot re-expose anything.
///
/// # A body that forgets the scrubber does not compile
///
/// The old shape — a boxed [`ByteStream`] used *as* a body — no longer
/// type-checks, so an unscrubbed read is not expressible:
///
/// ```compile_fail,E0308
/// use vela_providers::http::{BodyStream, ByteStream, TransportError};
///
/// struct Forgetful;
/// #[async_trait::async_trait]
/// impl ByteStream for Forgetful {
///     async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
///         Ok(None)
///     }
/// }
///
/// // error[E0308]: `BodyStream` is not an alias for `Box<dyn ByteStream>`.
/// let _body: BodyStream = Box::new(Forgetful);
/// ```
///
/// Neither does *declaring* the method that used to default to no protection —
/// the exact line the gate's recorder omitted:
///
/// ```compile_fail,E0407
/// use vela_providers::http::{ByteStream, TransportError};
/// use vela_providers::redact::Scrubber;
///
/// struct Forgetful;
/// #[async_trait::async_trait]
/// impl ByteStream for Forgetful {
///     async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
///         Ok(None)
///     }
///     // error[E0407]: method `scrubber` is not a member of trait `ByteStream`
///     fn scrubber(&self) -> Scrubber {
///         Scrubber::none()
///     }
/// }
/// ```
///
/// The one way through states what the body answers, and it is the redacted
/// endpoint that survives — not the key, and not the diagnosis:
///
/// ```
/// use vela_core::secret::SecretValue;
/// use vela_providers::http::testing::ScriptedBody;
/// use vela_providers::http::{BodyStream, HttpRequest};
/// use vela_secrets::AppliedAuth;
///
/// let request = HttpRequest::post_json("https://api.invalid/v1/chat", b"{}".to_vec())
///     .with_auth(&AppliedAuth::QueryParam {
///         name: "key".into(),
///         value: SecretValue::new("s3cret-do-not-leak"),
///     });
///
/// let body = BodyStream::new(ScriptedBody::from_text("hi"), request.origin());
/// assert_eq!(body.endpoint(), "https://api.invalid/v1/chat?key=<redacted>");
/// ```
pub struct BodyStream {
    inner: Box<dyn ByteStream>,
    origin: BodyOrigin,
    /// Bytes withheld because they may be the front half of a credential split
    /// across two chunks. See [`Scrubber::hold_back_len`].
    carry: Vec<u8>,
}

impl BodyStream {
    /// The one constructor. A body cannot exist without stating what it
    /// answers, so "forgot to attach the scrubber" is not expressible.
    pub fn new(inner: impl ByteStream + 'static, origin: BodyOrigin) -> Self {
        Self {
            inner: Box::new(inner),
            origin,
            carry: Vec::new(),
        }
    }

    /// The redacted endpoint this body came from, for diagnostics that must
    /// name it — a stall, a reset — without naming the credential.
    pub fn endpoint(&self) -> &str {
        self.origin.endpoint()
    }

    pub fn origin(&self) -> &BodyOrigin {
        &self.origin
    }

    /// The next chunk of body, **scrubbed**.
    ///
    /// `Ok(None)` means end of body, which is the only reliable end-of-stream
    /// signal there is (MEASURED-1).
    ///
    /// Chunk boundaries are handled rather than ignored: a needle straddling
    /// two reads is still removed, because the tail that could be its first
    /// half is held back until the next read resolves it. In the ordinary case
    /// nothing is held and the chunk is released whole, so streaming latency is
    /// unchanged.
    pub async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
        if self.origin.scrubber().is_empty() {
            // Nothing to remove: the overwhelmingly common case, since most
            // providers authenticate with a header and most local ones not at
            // all. No copy, no buffering.
            return self.inner.next_chunk().await;
        }
        loop {
            match self.inner.next_chunk().await? {
                Some(chunk) => {
                    self.carry.extend_from_slice(&chunk);
                    let scrubbed = self
                        .origin
                        .scrubber()
                        .scrub_bytes(std::mem::take(&mut self.carry));
                    let hold = self.origin.scrubber().hold_back_len(&scrubbed);
                    let mut scrubbed = scrubbed;
                    self.carry = scrubbed.split_off(scrubbed.len() - hold);
                    if !scrubbed.is_empty() {
                        return Ok(Some(scrubbed));
                    }
                    // Everything we hold could still be the first half of a
                    // credential. Read again rather than release it.
                }
                None => {
                    if self.carry.is_empty() {
                        return Ok(None);
                    }
                    // End of body resolves every partial needle: what is left
                    // cannot become one, so it is released.
                    let rest = std::mem::take(&mut self.carry);
                    return Ok(Some(self.origin.scrubber().scrub_bytes(rest)));
                }
            }
        }
    }
}

/// An incrementally readable source of bytes.
///
/// **Implementing this does not give anyone a readable body** — only
/// [`BodyStream::new`] does, and it demands a [`BodyOrigin`]. There is
/// deliberately no `scrubber()` on this trait: redaction is not something an
/// implementor can supply, forward, or forget.
///
/// A `Stream` impl was rejected deliberately: this shape needs no futures
/// dependency and a fake is four lines.
#[async_trait]
pub trait ByteStream: Send {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, TransportError>;
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
            // No request exists yet, so there is no endpoint to name and no
            // credential to remove.
            .map_err(|error| {
                ProviderError::from(map_reqwest_error(
                    error,
                    &BodyOrigin::carries_no_credential(),
                ))
            })?;
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
        let origin = request.origin();

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
                        "no response headers within {} ms for url ({})",
                        timeouts.first_byte.as_millis(),
                        origin.endpoint()
                    ),
                )
            })?
            .map_err(|error| map_reqwest_error(error, &origin))?;

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
            // The origin goes on the body, which is what outlives the request.
            body: BodyStream::new(
                ReqwestBody {
                    response,
                    origin: origin.clone(),
                },
                origin,
            ),
        })
    }
}

struct ReqwestBody {
    response: reqwest::Response,
    /// Not for scrubbing the bytes — [`BodyStream`] does that, and it cannot be
    /// bypassed. This copy exists for the *error* path: a mid-stream `reqwest`
    /// failure is text of `reqwest`'s making, not body bytes, and it needs both
    /// halves of the origin — the needles to remove and the endpoint to name.
    origin: BodyOrigin,
}

#[async_trait]
impl ByteStream for ReqwestBody {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
        match self.response.chunk().await {
            Ok(Some(bytes)) => Ok(Some(bytes.to_vec())),
            Ok(None) => Ok(None),
            Err(error) => Err(map_reqwest_error(error, &self.origin)),
        }
    }
}

/// Every `reqwest` failure in this workspace becomes a `TransportError` here
/// and nowhere else.
///
/// # Why this function takes the body's origin
///
/// `reqwest`'s `Display` ends with `" for url ({url})"` — the whole URL, query
/// string included. With `Auth::ApiKeyQuery` that string *is* the credential,
/// and `detail()` sanitises but does not redact, so a refused connection put
/// the user's API key into `ProviderError::Transport`'s `Display`, `Debug` and
/// serde JSON — the last of which is the shape that crosses the IPC bridge to
/// the WebView.
///
/// Three guards, because one of them is a promise about someone else's crate:
///
/// * [`reqwest::Error::without_url`] drops `reqwest`'s own copy of the URL
///   before it is ever formatted.
/// * **Vela re-attaches its own, redacted.** Dropping the URL outright — which
///   is what this function did for one round — takes the credential out by
///   taking the diagnosis out with it: `Connect: error sending request`, on a
///   machine with three configured candidates, does not say which one is down.
///   [`RequestUrl::redacted`] was already the tree's answer to that and is used
///   here now. Redaction removes the secret, not the diagnosis.
/// * The scrubber removes credential material from whatever is left — the
///   source chain, a future `reqwest` release that formats more, an error whose
///   text came from somewhere else entirely — and from the endpoint string too,
///   belt to `redacted()`'s braces.
///
/// Scrubbing happens **before** `detail()` truncates, because truncating first
/// can cut a credential in half and keep the half.
fn map_reqwest_error(error: reqwest::Error, origin: &BodyOrigin) -> TransportError {
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
    let reason = error.without_url().to_string();
    let raw = if origin.endpoint().is_empty() {
        reason
    } else {
        format!("{reason} for url ({})", origin.endpoint())
    };
    TransportError::new(failure, origin.scrubber().scrub(raw))
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

    /// Wrap a fake source of bytes as a readable body.
    ///
    /// The bytes are the test's own and answer no request of the user's, so
    /// there is no credential to remove and no endpoint to name. That is a
    /// claim this function makes out loud, in `testing`, where it is true —
    /// which is the whole difference from the trait default it replaced.
    pub fn fake_body(inner: impl ByteStream + 'static) -> BodyStream {
        BodyStream::new(inner, BodyOrigin::carries_no_credential())
    }

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
            // The fake derives the origin from the request exactly as
            // `ReqwestTransport` does, so a scripted endpoint that echoes a
            // credential back is redacted here too. A fake that only mirrors
            // the happy path teaches the tests nothing (conventions §4).
            let origin = request.origin();
            self.requests
                .lock()
                .expect("not poisoned")
                .push(request.clone());
            let next = self.responses.lock().expect("not poisoned").next();
            match next {
                Some(Ok(canned)) => Ok(HttpResponse {
                    status: canned.status,
                    headers: canned.headers,
                    body: BodyStream::new(ScriptedBody::new(canned.body), origin),
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
            body: fake_body(ScriptedBody::fragmented(&"x".repeat(100), 7)),
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
