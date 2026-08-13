//! **A redirect never carries a request — or a credential — off the authority
//! the user configured. Proved on the wire.**
//!
//! # The defect this file exists to close
//!
//! `ReqwestTransport` used to build its client with `connect_timeout`,
//! `no_proxy` and `user_agent`, and nothing else. That leaves `reqwest`'s
//! redirect defaults in force — `Policy::limited(10)` with `referer: true` —
//! and `reqwest`'s cross-host protection strips exactly five headers:
//! `authorization`, `cookie`, `cookie2`, `proxy-authorization`,
//! `www-authenticate`. It does **not** strip `x-api-key`. It does not strip
//! `x-goog-api-key`. It does not strip whatever header an `Auth::ApiKeyHeader`
//! binding names. Those are exactly the two non-`Bearer` bindings Vela ships.
//! And `make_referer` clears username, password and fragment while **keeping
//! the query string**, so an `Auth::ApiKeyQuery` credential travelled to the
//! next hop inside a `Referer` header.
//!
//! So a `3xx` from the configured endpoint handed the user's API key to a host
//! the user never named — on the first request of a perfectly healthy turn,
//! with no error involved anywhere. That is not a redaction bug; nothing was
//! being rendered. It is implicit egress, and it defeats the rule stated on
//! `ReqwestTransport::with_connect_timeout` itself: *Vela talks to the endpoint
//! the user configured and to nothing else.*
//!
//! # What is actually measured here
//!
//! Real loopback listeners and no mocking of the client:
//!
//! * a **redirector** — the endpoint the user configured, which answers `3xx`
//!   with a `Location` pointing somewhere else;
//! * a **third party** — a recorder on a different port, standing in for the
//!   host the user never configured, which records every byte it is sent;
//! * a **same-authority** listener, which redirects to *itself* on a different
//!   path: the reverse-proxy-normalising-a-path case, which is real and which
//!   the fix deliberately still allows.
//!
//! The providers are real, the transport is the real [`ReqwestTransport`], and
//! the assertions are made against the **literal bytes** the third party
//! received — request line, header lines and raw transcript — so a credential
//! smuggled in a `Referer`, in a query string, or in a header nobody thought to
//! enumerate is caught the same way.
//!
//! # The control, without which this file proves nothing
//!
//! [`PreFixTransport`] is this transport as it was *before* the fix: the same
//! `reqwest` client with `no_proxy` and a user agent, and `reqwest`'s untouched
//! defaults for redirect and referer. It drives the identical providers through
//! identical sockets, and the canary **does** arrive at the third party — for
//! exactly the three bindings `reqwest` does not protect, and not for `Bearer`,
//! which it does. That last part is asserted too, so the control also pins the
//! upstream behaviour this fix is compensating for.
//!
//! # Honesty (conventions.md §10)
//!
//! **VERIFIED-BY-FAKE.** The listeners are canned responders and the credential
//! store is `MemoryStore`. This proves what Vela puts on a socket, and nothing
//! about any real vendor endpoint or the OS keychain.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use vela_core::credential::Auth;
use vela_core::provider::{ProviderDescriptor, ProviderKind};
use vela_core::secret::{SecretRef, SecretValue};
use vela_providers::anthropic::AnthropicProvider;
use vela_providers::event::CollectingSink;
use vela_providers::google::GoogleProvider;
use vela_providers::http::{
    BodyStream, ByteStream, HttpMethod, HttpRequest, HttpResponse, HttpTransport, ReqwestTransport,
    TransportError,
};
use vela_providers::openai_compatible::OpenAiCompatibleProvider;
use vela_providers::redact::percent_encode;
use vela_providers::{
    ChatMessage, ChatRequest, Provider, ProviderError, RequestContext, Timeouts, TransportFailure,
};
use vela_secrets::{MemoryStore, SecretStore};

/// Chosen to be hostile to a naive search: it contains `/`, `+` and `=`, so the
/// percent-encoded form differs from the raw one and both have to be looked for.
const CANARY: &str = "kRt/8Wq+Zm=Xj4pV6bN2sD7gH1c-BUILDER4";
/// The stretch of the canary made only of unreserved characters, so a
/// percent-encoded, re-encoded or otherwise transformed copy still trips the
/// assertion.
const CANARY_CORE: &str = "Xj4pV6bN2sD7gH1c-BUILDER4";

// ---------------------------------------------------------------------------
// The listeners
// ---------------------------------------------------------------------------

/// What a [`Recorder`] does once it has captured a request.
#[derive(Clone)]
enum Reply {
    /// Answer verbatim. Used for the third party, which only has to exist.
    Fixed(Arc<Vec<u8>>),
    /// Answer `status` with an absolute `Location` on **another** authority —
    /// the configured endpoint pointing somewhere the user never named.
    RedirectAway { status: u16, target: Arc<String> },
    /// Answer `status` with a `Location` under `/relocated` on **this same**
    /// authority, until the request already carries that prefix — then serve
    /// `body`. A reverse proxy normalising a path, in one variant.
    RelocateOnce { status: u16, body: Arc<Vec<u8>> },
    /// Redirect to this same authority, forever. A loop that only a hop cap
    /// terminates.
    RelocateForever { status: u16 },
}

/// A loopback listener that records every byte it is sent.
///
/// Recording at the socket is the only vantage point from which "the third
/// party received nothing" is a statement about the wire rather than about a
/// struct Vela built before handing it to a client.
struct Recorder {
    /// `scheme://host:port` — also exactly the spelling the transport's refusal
    /// message uses, so the two can be compared literally.
    url: String,
    seen: Arc<Mutex<Vec<Vec<u8>>>>,
}

impl Recorder {
    async fn start(reply: Reply) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a loopback port is available");
        let port = listener.local_addr().expect("bound").port();
        // Learned after binding, never by guessing a free port and rebinding
        // it: that race is exactly the kind of flake a security test cannot
        // afford.
        let url = format!("http://127.0.0.1:{port}");
        let seen: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));

        let sink = Arc::clone(&seen);
        let authority = url.clone();
        tokio::spawn(async move {
            while let Ok((client, _)) = listener.accept().await {
                tokio::spawn(serve(
                    client,
                    reply.clone(),
                    Arc::clone(&sink),
                    authority.clone(),
                ));
            }
        });

        Self { url, seen }
    }

    /// The third party: it answers, and that is all it has to do.
    async fn third_party() -> Self {
        Self::start(Reply::Fixed(Arc::new(ok_response(ANTHROPIC_ANSWER)))).await
    }

    fn requests(&self) -> Vec<Vec<u8>> {
        self.seen.lock().expect("recorder poisoned").clone()
    }

    /// Everything this listener was sent, lossily decoded. Headers are ASCII; a
    /// body that is not valid UTF-8 must not break an assertion, hence lossy.
    fn transcript(&self) -> String {
        self.requests()
            .iter()
            .map(|raw| String::from_utf8_lossy(raw).into_owned())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn targets(&self) -> Vec<String> {
        self.requests().iter().map(|raw| target_of(raw)).collect()
    }

    fn saw_traffic(&self) -> bool {
        !self.requests().is_empty()
    }
}

/// Read one whole HTTP request — head *and* declared body.
///
/// Replying before the body has arrived resets the connection, and a reset is
/// indistinguishable from a redirect that was refused. Draining first is what
/// keeps a red test unambiguous.
async fn read_request(stream: &mut TcpStream) -> Option<Vec<u8>> {
    let mut raw: Vec<u8> = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        if let Some(head_end) = find(&raw, b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&raw[..head_end]).to_ascii_lowercase();
            let declared = head
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .and_then(|value| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            if raw.len() >= head_end + 4 + declared {
                return Some(raw);
            }
        }
        match stream.read(&mut buffer).await {
            Ok(0) | Err(_) => return (!raw.is_empty()).then_some(raw),
            Ok(read) => raw.extend_from_slice(&buffer[..read]),
        }
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// The request target — the middle field of the request line.
fn target_of(raw: &[u8]) -> String {
    String::from_utf8_lossy(raw)
        .lines()
        .next()
        .and_then(|line| line.split(' ').nth(1).map(str::to_owned))
        .unwrap_or_default()
}

async fn serve(
    mut client: TcpStream,
    reply: Reply,
    sink: Arc<Mutex<Vec<Vec<u8>>>>,
    authority: String,
) {
    let Some(raw) = read_request(&mut client).await else {
        return;
    };
    let target = target_of(&raw);
    sink.lock().expect("recorder poisoned").push(raw);

    let response = match reply {
        Reply::Fixed(bytes) => bytes.as_ref().clone(),
        Reply::RedirectAway { status, target } => redirect_response(status, &target),
        Reply::RelocateOnce { status, body } => {
            if target.starts_with("/relocated") {
                body.as_ref().clone()
            } else {
                redirect_response(status, &format!("{authority}/relocated{target}"))
            }
        }
        Reply::RelocateForever { status } => {
            redirect_response(status, &format!("{authority}/round-and-round"))
        }
    };
    let _ = client.write_all(&response).await;
    let _ = client.shutdown().await;
}

fn ok_response(body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

fn redirect_response(status: u16, location: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {status} Found\r\nlocation: {location}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
    )
    .into_bytes()
}

const ANTHROPIC_ANSWER: &str = r#"{"id":"msg_1","type":"message","role":"assistant","model":"claude-x","content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}"#;

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

/// Which credential shape is configured. All four `Auth` variants appear;
/// `ApiKeyHeader` appears twice because the two headers it names in practice —
/// Anthropic's and Google's — are both absent from `reqwest`'s strip list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Binding {
    None,
    Bearer,
    /// `x-api-key` — Anthropic's auth header.
    ApiKeyHeader,
    /// `x-goog-api-key` — Google's.
    GoogleApiKeyHeader,
    /// `?key=` — in the URL, so it also leaks through `Referer`.
    ApiKeyQuery,
}

impl Binding {
    const ALL: [Binding; 5] = [
        Binding::None,
        Binding::Bearer,
        Binding::ApiKeyHeader,
        Binding::GoogleApiKeyHeader,
        Binding::ApiKeyQuery,
    ];

    fn label(self) -> &'static str {
        match self {
            Binding::None => "Auth::None",
            Binding::Bearer => "Auth::Bearer",
            Binding::ApiKeyHeader => "Auth::ApiKeyHeader{x-api-key}",
            Binding::GoogleApiKeyHeader => "Auth::ApiKeyHeader{x-goog-api-key}",
            Binding::ApiKeyQuery => "Auth::ApiKeyQuery{key}",
        }
    }

    /// The adapter whose real-world binding this is, so the wire shape under
    /// test is one Vela actually ships rather than a synthetic pairing.
    fn adapter(self) -> Adapter {
        match self {
            Binding::None | Binding::Bearer => Adapter::OpenAiCompatible,
            Binding::ApiKeyHeader => Adapter::Anthropic,
            Binding::GoogleApiKeyHeader | Binding::ApiKeyQuery => Adapter::Google,
        }
    }

    fn auth(self, secret: SecretRef) -> Auth {
        match self {
            Binding::None => Auth::None,
            Binding::Bearer => Auth::Bearer { secret },
            Binding::ApiKeyHeader => Auth::ApiKeyHeader {
                header: "x-api-key".into(),
                secret,
            },
            Binding::GoogleApiKeyHeader => Auth::ApiKeyHeader {
                header: "x-goog-api-key".into(),
                secret,
            },
            Binding::ApiKeyQuery => Auth::ApiKeyQuery {
                param: "key".into(),
                secret,
            },
        }
    }

    /// What `reqwest`'s own defaults do with this binding across a cross-host
    /// hop — asserted by the control, so the claim is measured rather than read
    /// off a changelog.
    ///
    /// `remove_sensitive_headers` strips `authorization`, so `Bearer` survives
    /// upstream's protection. Nothing strips `x-api-key` or `x-goog-api-key`,
    /// and `make_referer` keeps the query string that carries `?key=`.
    fn leaks_without_a_policy(self) -> bool {
        match self {
            Binding::None | Binding::Bearer => false,
            Binding::ApiKeyHeader | Binding::GoogleApiKeyHeader | Binding::ApiKeyQuery => true,
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum Adapter {
    OpenAiCompatible,
    Anthropic,
    Google,
}

impl Adapter {
    fn model_id(self) -> &'static str {
        match self {
            Adapter::OpenAiCompatible => "m",
            Adapter::Anthropic => "claude-x",
            Adapter::Google => "gemini-x",
        }
    }
}

fn context() -> RequestContext {
    RequestContext::new().with_timeouts(Timeouts {
        connect: Duration::from_secs(5),
        first_byte: Duration::from_secs(15),
        stall: Duration::from_secs(15),
    })
}

fn turn(adapter: Adapter) -> ChatRequest {
    ChatRequest::new(adapter.model_id()).with_message(ChatMessage::user("hi"))
}

fn build(binding: Binding, base_url: &str, transport: Arc<dyn HttpTransport>) -> Box<dyn Provider> {
    let id = "redirect-probe";
    let descriptor =
        ProviderDescriptor::new(id, "Redirect egress probe", ProviderKind::Local).unwrap();
    let secrets = Arc::new(MemoryStore::new());
    let secret = SecretRef::primary(id).expect("a valid provider id");
    secrets
        .set(&secret, &SecretValue::new(CANARY))
        .expect("MemoryStore accepts a non-empty value");
    let auth = binding.auth(secret);

    match binding.adapter() {
        Adapter::OpenAiCompatible => Box::new(OpenAiCompatibleProvider::new(
            descriptor,
            format!("{base_url}/v1"),
            auth,
            secrets,
            transport,
        )),
        Adapter::Anthropic => Box::new(AnthropicProvider::new(
            descriptor,
            base_url.to_owned(),
            auth,
            secrets,
            transport,
        )),
        Adapter::Google => Box::new(GoogleProvider::new(
            descriptor,
            base_url.to_owned(),
            auth,
            secrets,
            transport,
        )),
    }
}

/// `complete()` and `stream()` are separate wire paths — a different URL for
/// Google, different headers and a different request body for all three — so
/// "no egress" has to be asserted on each.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Call {
    Complete,
    Stream,
}

impl Call {
    const BOTH: [Call; 2] = [Call::Complete, Call::Stream];

    fn label(self) -> &'static str {
        match self {
            Call::Complete => "complete()",
            Call::Stream => "stream()",
        }
    }
}

async fn drive(provider: &dyn Provider, adapter: Adapter, call: Call) -> Result<(), ProviderError> {
    match call {
        Call::Complete => provider.complete(turn(adapter), &context()).await.map(drop),
        Call::Stream => {
            let mut sink = CollectingSink::new();
            provider
                .stream(turn(adapter), &mut sink, &context())
                .await
                .map(drop)
        }
    }
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/// Every literal form of the canary a third party could receive.
fn needles() -> Vec<String> {
    vec![
        CANARY.to_owned(),
        percent_encode(CANARY),
        CANARY_CORE.to_owned(),
    ]
}

fn carries_canary(text: &str) -> bool {
    let lowered = text.to_ascii_lowercase();
    needles()
        .iter()
        .any(|needle| text.contains(needle.as_str()) || lowered.contains(&needle.to_lowercase()))
}

#[track_caller]
fn assert_no_canary_anywhere(label: &str, transcript: &str) {
    assert!(
        !carries_canary(transcript),
        "{label}: the canary escaped, in:\n{transcript}"
    );
}

/// The point of the file: the third party gets **zero bytes**.
///
/// Stated as "no request at all", not "no credential in the request", because
/// the rule being enforced is that Vela talks to the endpoint the user
/// configured and to nothing else. The prompt is the user's data too.
#[track_caller]
fn assert_third_party_untouched(label: &str, third_party: &Recorder, redirector: &Recorder) {
    assert!(
        redirector.saw_traffic(),
        "{label}: the configured endpoint was never contacted — every assertion \
         below would pass vacuously"
    );
    let transcript = third_party.transcript();
    assert!(
        !third_party.saw_traffic(),
        "{label}: a request reached a host the user never configured:\n{transcript}"
    );
    assert_no_canary_anywhere(label, &transcript);
}

#[track_caller]
fn assert_error_names_both_authorities(
    label: &str,
    error: &ProviderError,
    redirector: &Recorder,
    third_party: &Recorder,
) {
    for (surface, text) in [
        ("Display", error.to_string()),
        ("Debug", format!("{error:?}")),
        ("serde JSON", serde_json::to_string(error).unwrap()),
    ] {
        assert!(
            text.contains(&redirector.url),
            "{label}: {surface} does not say which endpoint redirected: {text}"
        );
        assert!(
            text.contains(&third_party.url),
            "{label}: {surface} does not say where it was pointed: {text}"
        );
        assert_no_canary_anywhere(&format!("{label}/{surface}"), &text);
    }
    assert!(
        matches!(
            error,
            ProviderError::Transport {
                failure: TransportFailure::Request { .. },
                ..
            }
        ),
        "{label}: a refused redirect is a response about this request, not a \
         sick network: {error:?}"
    );
    assert!(
        !error.allows_retry(),
        "{label}: the same request earns the same Location back"
    );
}

// ---------------------------------------------------------------------------
// THE TEST
// ---------------------------------------------------------------------------

/// Every binding, both calls, against the real transport: a `302` off the
/// configured authority reaches the third party with nothing at all.
#[tokio::test]
async fn no_redirect_carries_a_request_or_a_credential_off_the_configured_authority() {
    for binding in Binding::ALL {
        for call in Call::BOTH {
            let label = format!("{} · {}", binding.label(), call.label());
            let third_party = Recorder::third_party().await;
            let redirector = Recorder::start(Reply::RedirectAway {
                status: 302,
                target: Arc::new(format!("{}/v1/messages", third_party.url)),
            })
            .await;

            let transport = Arc::new(ReqwestTransport::new().expect("http client builds"));
            let provider = build(binding, &redirector.url, transport);
            let error = drive(provider.as_ref(), binding.adapter(), call)
                .await
                .expect_err("a redirect off the configured authority is refused");

            assert_third_party_untouched(&label, &third_party, &redirector);
            assert_error_names_both_authorities(&label, &error, &redirector, &third_party);
        }
    }
}

/// **The control.** The same providers, the same sockets, the same canary — and
/// the transport as it was before the fix. The canary arrives, for exactly the
/// bindings `reqwest` does not protect. Without this, the test above would pass
/// even if the recorder were blind or the providers never sent anything.
#[tokio::test]
async fn the_control_watches_the_canary_arrive_when_the_policy_is_removed() {
    let mut observed: Vec<String> = Vec::new();

    for binding in Binding::ALL {
        for call in Call::BOTH {
            let label = format!("{} · {}", binding.label(), call.label());
            let third_party = Recorder::third_party().await;
            let redirector = Recorder::start(Reply::RedirectAway {
                status: 302,
                target: Arc::new(format!("{}/v1/messages", third_party.url)),
            })
            .await;

            let transport = Arc::new(PreFixTransport::new());
            let provider = build(binding, &redirector.url, transport);
            let _ = drive(provider.as_ref(), binding.adapter(), call).await;

            let transcript = third_party.transcript();
            assert!(
                third_party.saw_traffic(),
                "{label}: without a policy the redirect is followed — if it is not, \
                 this control proves nothing"
            );
            assert_eq!(
                carries_canary(&transcript),
                binding.leaks_without_a_policy(),
                "{label}: upstream's own behaviour is not what this fix was built \
                 against; transcript:\n{transcript}"
            );
            if binding.leaks_without_a_policy() {
                observed.push(label);
            }
        }
    }

    assert_eq!(
        observed.len(),
        6,
        "three bindings × two calls must be seen leaking: {observed:#?}"
    );
}

/// The legitimate case the fix deliberately keeps: a reverse proxy normalising
/// a path, on the very authority the user typed. The hop is followed, the turn
/// completes, and the request never leaves that authority.
#[tokio::test]
async fn a_same_authority_redirect_is_still_followed() {
    let endpoint = Recorder::start(Reply::RelocateOnce {
        status: 307,
        body: Arc::new(ok_response(ANTHROPIC_ANSWER)),
    })
    .await;

    let transport = Arc::new(ReqwestTransport::new().expect("http client builds"));
    let provider = build(Binding::ApiKeyHeader, &endpoint.url, transport);
    provider
        .complete(turn(Adapter::Anthropic), &context())
        .await
        .expect("a hop back to the authority the user configured is not egress");

    let targets = endpoint.targets();
    assert_eq!(
        targets.len(),
        2,
        "the redirect must actually have been followed: {targets:?}"
    );
    assert!(
        targets[1].starts_with("/relocated"),
        "the second request must be the relocated one: {targets:?}"
    );
    assert!(
        endpoint.transcript().contains(CANARY),
        "the credential rides to the authority the user configured, as it must"
    );
}

/// A same-authority redirect that never stops is a loop, and `Policy::custom`
/// does no loop detection of its own — its own docs say so. The cap is Vela's.
#[tokio::test]
async fn a_same_authority_redirect_loop_is_refused_rather_than_followed_forever() {
    let endpoint = Recorder::start(Reply::RelocateForever { status: 302 }).await;

    let transport = Arc::new(ReqwestTransport::new().expect("http client builds"));
    let provider = build(Binding::ApiKeyHeader, &endpoint.url, transport);
    let error = provider
        .complete(turn(Adapter::Anthropic), &context())
        .await
        .expect_err("a redirect loop terminates");

    let rendered = error.to_string();
    assert!(
        rendered.contains("loop") && rendered.contains(&endpoint.url),
        "the loop must be named, and so must the authority it is in: {rendered}"
    );
    assert!(
        !error.allows_retry(),
        "the same request earns the same Location back"
    );
    assert!(
        endpoint.requests().len() <= 8,
        "the hop cap must bound the loop; got {} requests",
        endpoint.requests().len()
    );
    assert_no_canary_anywhere("loop/error", &rendered);
}

// ---------------------------------------------------------------------------
// The control transport — this file's only copy of the defect
// ---------------------------------------------------------------------------

/// [`ReqwestTransport`] as it was **before** the fix.
///
/// `connect_timeout`, `no_proxy`, `user_agent` — and `reqwest`'s untouched
/// defaults for everything else, which is to say `Policy::limited(10)` and
/// `referer: true`. It lives here, in a test, rather than behind a flag on the
/// shipping transport, because a constructor that disables a security control is
/// a footgun wherever it is reachable from.
struct PreFixTransport {
    client: reqwest::Client,
}

impl PreFixTransport {
    fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(5))
                .no_proxy()
                .user_agent("vela/pre-fix-control")
                .build()
                .expect("the control client builds"),
        }
    }
}

#[async_trait::async_trait]
impl HttpTransport for PreFixTransport {
    async fn send(
        &self,
        request: HttpRequest,
        _timeouts: &Timeouts,
    ) -> Result<HttpResponse, TransportError> {
        let origin = request.origin();
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
        let response = builder.send().await.map_err(|error| {
            TransportError::new(
                TransportFailure::Reset,
                origin.scrubber().scrub(error.without_url().to_string()),
            )
        })?;
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
            body: BodyStream::new(ControlBody { response }, origin),
        })
    }
}

struct ControlBody {
    response: reqwest::Response,
}

#[async_trait::async_trait]
impl ByteStream for ControlBody {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
        match self.response.chunk().await {
            Ok(Some(bytes)) => Ok(Some(bytes.to_vec())),
            Ok(None) => Ok(None),
            Err(error) => Err(TransportError::new(
                TransportFailure::Reset,
                error.without_url().to_string(),
            )),
        }
    }
}
