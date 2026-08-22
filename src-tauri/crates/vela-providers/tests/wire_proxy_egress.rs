//! **An ambient proxy in the environment never sees a Vela request — proved on
//! the wire.**
//!
//! # Why this file exists
//!
//! `ReqwestTransport::with_connect_timeout` calls `.no_proxy()` and states the
//! rule it is there for: *Vela talks to the endpoint the user configured and to
//! nothing else — an ambient `HTTPS_PROXY` in the environment must not silently
//! redirect a local model request through a third party.* That call has been in
//! the tree since the transport was written and had **no test at all**. A rule
//! whose only evidence is the line that claims it is a comment, not a control:
//! the sibling defect this round closes — redirects — was hiding behind exactly
//! that shape, a comment on the same function asserting no implicit egress while
//! `reqwest`'s redirect defaults handed the credential away.
//!
//! An environment proxy is not hypothetical. `hyper-util`'s matcher reads
//! `ALL_PROXY`/`all_proxy`, `HTTP_PROXY`/`http_proxy` and
//! `HTTPS_PROXY`/`https_proxy` (`hyper_util::…::Matcher::from_env`, via
//! `reqwest::proxy::Matcher::system`, which `ClientBuilder` installs unless
//! `no_proxy()` was called), and it applies them to **loopback destinations
//! too**: `intercept` bypasses only hosts named in `NO_PROXY`. There is no
//! built-in localhost exemption. So on a corporate laptop with `HTTP_PROXY`
//! exported — the machine most likely to be running a local model for exactly
//! that reason — an un-`no_proxy`'d client would route the user's prompt and
//! their credential through the corporate MITM on the way to `127.0.0.1`.
//!
//! # What is actually measured here
//!
//! Two real loopback listeners — a **recording proxy** and the **configured
//! endpoint** — with the proxy environment variables pointed at the former and
//! `NO_PROXY` cleared, so nothing but `no_proxy()` itself stands between the
//! client and the proxy. The provider is a real `AnthropicProvider`, the
//! transport is the real `ReqwestTransport`, and both `complete()` and
//! `stream()` are driven. The assertion is that the proxy received **zero
//! bytes**.
//!
//! # The control, without which this file proves nothing
//!
//! The same client minus `.no_proxy()`, through the same sockets, with the same
//! canary: the proxy receives the request in absolute form, `x-api-key` and all.
//! That control is what makes the ambient environment of *this* run visible —
//! if a future container stopped honouring proxy variables, the control goes red
//! rather than the negative assertion going quietly vacuous.
//!
//! # Why this file holds exactly one test
//!
//! `std::env::set_var` is process-global and `reqwest` reads the variables when
//! the client is **built**, so two tests mutating them in parallel threads would
//! race. Cargo gives each integration-test file its own process; keeping this
//! one test alone in this one file is what makes the mutation safe, and is
//! cheaper and more honest than a lock every future reader would have to notice.
//!
//! # Honesty (conventions.md §10)
//!
//! **VERIFIED-BY-FAKE.** Both listeners are canned responders and the credential
//! store is `MemoryStore`. This proves what Vela puts on a socket, and nothing
//! about any real vendor endpoint, any real proxy, or the OS keychain.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use vela_core::credential::Auth;
use vela_core::provider::{ProviderDescriptor, ProviderKind};
use vela_core::secret::{SecretRef, SecretValue};
use vela_providers::anthropic::AnthropicProvider;
use vela_providers::event::CollectingSink;
use vela_providers::http::{
    BodyStream, ByteStream, HttpMethod, HttpRequest, HttpResponse, HttpTransport, ReqwestTransport,
    ResponseHeaders, TransportError,
};
use vela_providers::{
    ChatMessage, ChatRequest, Provider, RequestContext, Timeouts, TransportFailure,
};
use vela_secrets::{MemoryStore, SecretStore};

/// Contains `/`, `+` and `=` so a percent-encoded copy differs from the raw one
/// and a naive substring search cannot be the only thing looked for.
const CANARY: &str = "kRt/8Wq+Zm=Xj4pV6bN2sD7gH1c-PROXY4";
/// The unreserved stretch, which survives any re-encoding a hop might apply.
const CANARY_CORE: &str = "Xj4pV6bN2sD7gH1c-PROXY4";

/// Every variable `hyper_util::client::proxy::matcher::Matcher::from_env` reads.
/// All of them are set, so "we only pointed the one it does not consult" is not
/// an available explanation for a green negative assertion.
const PROXY_VARS: [&str; 6] = [
    "ALL_PROXY",
    "all_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
];

// ---------------------------------------------------------------------------
// The listeners
// ---------------------------------------------------------------------------

/// A loopback listener that records every byte it is sent and answers with a
/// canned response.
///
/// Recording at the socket is the only vantage point from which "the proxy
/// received nothing" is a statement about the wire rather than about a struct
/// Vela built before handing it to a client.
struct Recorder {
    url: String,
    seen: Arc<Mutex<Vec<Vec<u8>>>>,
}

impl Recorder {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a loopback port is available");
        let port = listener.local_addr().expect("bound").port();
        // Learned after binding, never by guessing a free port and rebinding it:
        // that race is exactly the kind of flake a security test cannot afford.
        let url = format!("http://127.0.0.1:{port}");
        let seen: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));

        let sink = Arc::clone(&seen);
        tokio::spawn(async move {
            while let Ok((client, _)) = listener.accept().await {
                tokio::spawn(serve(client, Arc::clone(&sink)));
            }
        });

        Self { url, seen }
    }

    fn requests(&self) -> Vec<Vec<u8>> {
        self.seen.lock().expect("recorder poisoned").clone()
    }

    /// Everything recorded **after** the first `already` requests.
    ///
    /// The proxy recorder has to be the same object across both halves of the
    /// test — the environment variables name its port and were set before any
    /// client was built, so a second recorder on a second port would be a
    /// listener nothing is pointed at, and the shipping half would measure
    /// silence that proves nothing. Measuring the delta on the one live proxy
    /// is what keeps the negative assertion attached to the real destination.
    fn requests_since(&self, already: usize) -> Vec<Vec<u8>> {
        self.requests().into_iter().skip(already).collect()
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

    fn saw_traffic(&self) -> bool {
        !self.requests().is_empty()
    }
}

/// Read one whole HTTP request — head *and* declared body.
///
/// Replying before the body has arrived resets the connection, and a reset is
/// indistinguishable from "the request was never sent". Draining first is what
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

/// Answer both shapes from one responder: an SSE stream when the request asked
/// for one, a JSON message otherwise. Which one is decided from the request body
/// rather than the path, because `complete()` and `stream()` hit the same
/// Anthropic URL and differ only by `"stream":true`.
async fn serve(mut client: TcpStream, sink: Arc<Mutex<Vec<Vec<u8>>>>) {
    let Some(raw) = read_request(&mut client).await else {
        return;
    };
    let streaming = find(&raw, br#""stream":true"#).is_some();
    sink.lock().expect("recorder poisoned").push(raw);

    let response = if streaming {
        sse_response(ANTHROPIC_SSE)
    } else {
        json_response(ANTHROPIC_ANSWER)
    };
    let _ = client.write_all(&response).await;
    let _ = client.shutdown().await;
}

fn json_response(body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

fn sse_response(body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

const ANTHROPIC_ANSWER: &str = r#"{"id":"msg_1","type":"message","role":"assistant","model":"claude-x","content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}"#;

const ANTHROPIC_SSE: &str = concat!(
    "event: message_start\n",
    r#"data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-x","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}"#,
    "\n\nevent: content_block_start\n",
    r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
    "\n\nevent: content_block_delta\n",
    r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}"#,
    "\n\nevent: content_block_stop\n",
    r#"data: {"type":"content_block_stop","index":0}"#,
    "\n\nevent: message_delta\n",
    r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}"#,
    "\n\nevent: message_stop\n",
    r#"data: {"type":"message_stop"}"#,
    "\n\n",
);

// ---------------------------------------------------------------------------
// The provider under test
// ---------------------------------------------------------------------------

/// `x-api-key` — Anthropic's binding, and one of the two Vela ships that
/// `reqwest` does not treat as sensitive anywhere.
fn anthropic_at(base_url: &str, transport: Arc<dyn HttpTransport>) -> AnthropicProvider {
    let id = "proxy-probe";
    let descriptor =
        ProviderDescriptor::new(id, "Proxy egress probe", ProviderKind::Local).unwrap();
    let secrets = Arc::new(MemoryStore::new());
    let secret = SecretRef::primary(id).expect("a valid provider id");
    secrets
        .set(&secret, &SecretValue::new(CANARY))
        .expect("MemoryStore accepts a non-empty value");
    AnthropicProvider::new(
        descriptor,
        base_url.to_owned(),
        Auth::ApiKeyHeader {
            header: "x-api-key".into(),
            secret,
        },
        secrets,
        transport,
    )
}

fn context() -> RequestContext {
    RequestContext::new().with_timeouts(Timeouts {
        connect: Duration::from_secs(5),
        first_byte: Duration::from_secs(15),
        stall: Duration::from_secs(15),
    })
}

fn turn() -> ChatRequest {
    ChatRequest::new("claude-x").with_message(ChatMessage::user("hi"))
}

/// `complete()` and `stream()` are separate wire paths — a different request
/// body and a different response decoder — so "no egress" has to be asserted on
/// each. The result is deliberately discarded: this file asserts on bytes at a
/// socket, and a turn that failed for an unrelated reason must not be able to
/// make the negative assertion pass vacuously. `assert_endpoint_was_reached`
/// is what rules that out.
async fn drive_both_calls(provider: &AnthropicProvider) {
    let _ = provider.complete(turn(), &context()).await;
    let mut sink = CollectingSink::new();
    let _ = provider.stream(turn(), &mut sink, &context()).await;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

fn carries_canary(text: &str) -> bool {
    text.contains(CANARY) || text.contains(CANARY_CORE)
}

#[track_caller]
fn assert_endpoint_was_reached(label: &str, endpoint: &Recorder) {
    assert!(
        endpoint.saw_traffic(),
        "{label}: the configured endpoint was never contacted — every negative \
         assertion would pass vacuously"
    );
}

// ---------------------------------------------------------------------------
// THE TEST
// ---------------------------------------------------------------------------

/// The control and the shipping transport, in one process, against the same
/// environment: the ambient proxy receives the request when `no_proxy()` is
/// absent and **zero bytes** when it is there.
#[tokio::test]
async fn an_ambient_proxy_in_the_environment_never_receives_a_request_or_a_credential() {
    let proxy = Recorder::start().await;
    let endpoint = Recorder::start().await;

    // Set before any client is built: `reqwest` reads these at build time, not
    // at send time. `NO_PROXY` is cleared because this container ships one that
    // exempts loopback — leaving it in place would make the negative assertion
    // pass for a reason that has nothing to do with Vela's code.
    //
    // SAFETY: `set_var`/`remove_var` are sound while no other thread reads the
    // environment. This test binary contains exactly one test (see the module
    // docs) and the mutation happens before the first client is built, so there
    // is no concurrent reader.
    for name in PROXY_VARS {
        std::env::set_var(name, &proxy.url);
    }
    std::env::remove_var("NO_PROXY");
    std::env::remove_var("no_proxy");

    // ---- The control: this client, minus the one call under test ----------
    let control = Arc::new(NoNoProxyTransport::new());
    drive_both_calls(&anthropic_at(&endpoint.url, control)).await;

    let control_transcript = proxy.transcript();
    assert!(
        proxy.saw_traffic(),
        "the control never reached the proxy, so this run cannot tell a working \
         `no_proxy()` from an environment that ignores proxy variables — every \
         assertion below would be vacuous"
    );
    assert!(
        carries_canary(&control_transcript),
        "the control reached the proxy without the credential, so the assertion \
         below is not measuring what it claims:\n{control_transcript}"
    );
    assert!(
        control_transcript.contains(&format!("{}/v1/messages", endpoint.url)),
        "a proxied request is sent in absolute form naming the real target; if it \
         is not, this is not a proxy hop:\n{control_transcript}"
    );

    // ---- The shipping transport, same environment, same proxy -------------
    // The *same* proxy recorder, because it is the one the environment names.
    // Only the endpoint is fresh, so the two halves cannot be confused.
    let already = proxy.requests().len();
    let endpoint = Recorder::start().await;
    let shipping = Arc::new(ReqwestTransport::new().expect("http client builds"));
    drive_both_calls(&anthropic_at(&endpoint.url, shipping)).await;

    // The egress assertion comes **first**, before the vacuity guard, because a
    // hijacked request is absent from the endpoint precisely *because* it went
    // to the proxy: guard-first would fail with "the endpoint was never
    // contacted", which reads like a broken test rather than like the leak it
    // is. A red test has to name what actually happened.
    let leaked = proxy.requests_since(already);
    let transcript = leaked
        .iter()
        .map(|raw| String::from_utf8_lossy(raw).into_owned())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        leaked.is_empty(),
        "a request reached a proxy the user never configured:\n{transcript}"
    );
    assert!(
        !carries_canary(&transcript),
        "the canary reached the ambient proxy:\n{transcript}"
    );
    assert_endpoint_was_reached("no_proxy", &endpoint);
    assert!(
        endpoint.transcript().contains(CANARY),
        "the credential must still reach the endpoint the user *did* configure — \
         a transport that sends nothing anywhere would pass every assertion above"
    );
}

// ---------------------------------------------------------------------------
// The control transport — this file's only copy of the defect
// ---------------------------------------------------------------------------

/// [`ReqwestTransport`] with one line removed: `.no_proxy()`.
///
/// Everything else is the shipping configuration, redirect policy included, so
/// the only difference between the two halves of the test above is the call
/// under test. It lives here, in a test, rather than behind a flag on the
/// shipping transport, because a constructor that disables a security control is
/// a footgun wherever it is reachable from.
struct NoNoProxyTransport {
    client: reqwest::Client,
}

impl NoNoProxyTransport {
    fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(5))
                .referer(false)
                .user_agent("vela/no-no-proxy-control")
                .build()
                .expect("the control client builds"),
        }
    }
}

#[async_trait::async_trait]
impl HttpTransport for NoNoProxyTransport {
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
        let response = builder.send().await.map_err(|_| {
            TransportError::new(
                TransportFailure::Reset,
                origin.diagnose(vela_providers::Cause::ConnectionReset),
            )
        })?;
        let status = response.status().as_u16();
        // Through `ResponseHeaders`, as the real transport does: this control
        // deliberately drops `no_proxy` and nothing else — least of all the
        // redaction the type carries.
        let headers = ResponseHeaders::new(
            response.headers().iter().map(|(name, value)| {
                (
                    name.as_str().to_ascii_lowercase(),
                    value.to_str().unwrap_or_default().to_owned(),
                )
            }),
            &origin,
        );
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
            Err(_) => Err(TransportError::new(
                TransportFailure::Reset,
                vela_providers::Cause::ConnectionReset,
            )),
        }
    }
}
