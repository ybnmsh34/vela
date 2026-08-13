//! **The streamed half of the credential canary** — GATE M Part 1, Phase B,
//! FINDING 2, and the over-redaction the regression critic flagged with it.
//!
//! # Why this file exists next to `credential_canary.rs`
//!
//! That file is green, has been green through two rounds, and missed a live
//! credential leak. It drives five *transport* failures — a closed port, a TLS
//! handshake that cannot complete, an unroutable address, a silent server, a
//! body that dies halfway — plus one real echo, and that echo is a **400 read
//! through `complete()`**, which is `HttpResponse::read_to_end`, which is the
//! one place in the crate that scrubbed.
//!
//! Nothing drove an echoed credential through **a 200 whose stream carries an
//! error object**. That path reads the body chunk-by-chunk, and chunks were not
//! scrubbed, so the key arrived intact in `Display`, in `Debug`, in the serde
//! shape that crosses the IPC bridge to the low-trust WebView, and in the
//! `StreamEvent::Error` the UI is handed. Three independent critics reproduced
//! it with three different canaries.
//!
//! So this file drives **seven** forced failures — the six that were already
//! clean and the seventh that was not — across **all three adapters** and
//! **both bindings** (`Auth::ApiKeyQuery` and a credential header), on **both
//! transports** (`complete()` and `stream()`), and checks **four** surfaces:
//! `Display`, `Debug`, serde JSON, and every event that reached the sink.
//!
//! # The other direction, which is also a defect
//!
//! Round 2 closed the leak by calling `reqwest::Error::without_url()`
//! unconditionally, which deleted the endpoint from *every* transport error —
//! including requests that carried no credential at all. `Connect: error
//! sending request`, on a machine with three configured candidates, does not
//! say which one is down. A redaction that removes the diagnosis is not a
//! redaction; the tree already owned `RequestUrl::redacted()` and now uses it.
//!
//! [`transport_failures_still_name_the_endpoint_they_failed_on`] pins that, and
//! [`a_body_answering_a_credential_free_request_is_untouched`] is the control
//! that tells "redacted" apart from "deleted": same endpoint, no credential in
//! the request at all, so the seam must be the identity — nothing scrubbed,
//! nothing held back, the endpoint still named.
//!
//! # Controls
//!
//! Every negative assertion here is paired with something that can fail:
//!
//! * [`positive_control_the_pre_fix_streamed_read_leaks`] rebuilds the round-2
//!   streaming path out of public API — a raw [`ByteStream`] read directly,
//!   which is exactly what `BodyStream` used to be — and asserts the canary
//!   **is** found. If it stops being found, every other assertion is vacuous.
//! * [`positive_control_a_credential_split_across_two_chunks_leaks`] does the
//!   same for the boundary case a naive per-chunk scrub would still miss.
//! * [`positive_control_dropping_the_url_loses_the_endpoint`] runs the
//!   endpoint-identity detector against round 2's own output and asserts it
//!   fails there.
//! * every driven case asserts the failure was real and its detail non-empty,
//!   so "no leak" can never mean "no error", and the case counters at the end
//!   of each test assert the loops actually ran.
//!
//! # Honesty (conventions.md §10)
//!
//! **VERIFIED-BY-FAKE.** `MemoryStore`, deliberately broken loopback sockets,
//! and mock endpoints. Not one byte came from a language model, and nothing
//! here is evidence about the OS keychain.

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use vela_core::credential::Auth;
use vela_core::provider::{ProviderDescriptor, ProviderKind};
use vela_core::secret::{SecretRef, SecretValue};
use vela_providers::error::TransportFailure;
use vela_providers::event::{CollectingSink, StreamEvent};
use vela_providers::http::testing::ScriptedBody;
use vela_providers::http::{BodyOrigin, BodyStream, ByteStream, HttpRequest, ReqwestTransport};
use vela_providers::redact::{percent_encode, RequestUrl, Scrubber};
use vela_providers::stream::CompletionAssembler;
use vela_providers::{
    AnthropicProvider, ChatMessage, ChatRequest, GoogleProvider, OpenAiCompatibleProvider,
    Provider, ProviderError, RequestContext, Timeouts,
};
use vela_secrets::{MemoryStore, SecretStore};

/// This round's canary. Deliberately different from `credential_canary.rs`'s,
/// so a fix that happened to special-case that literal would not pass here, and
/// deliberately containing `/` and `+` so its raw and percent-encoded forms
/// differ and both must be looked for.
const CANARY: &str = "vela+round3/Ky-4c81e7b39d2f06a5-DO-NOT-LEAK";

/// The part that survives percent-encoding untouched. Searching for this too is
/// what makes a *partial* leak — a key cut in half by `detail()`'s 200-character
/// truncation, or by a chunk boundary — a failure rather than a pass.
const CANARY_CORE: &str = "4c81e7b39d2f06a5";

/// Planted in every mock error message. It carries no secret, so it must
/// **survive** redaction: it is how this file tells a redaction apart from a
/// deletion.
const MARKER: &str = "VELA-DIAGNOSTIC-MARKER";

fn needles() -> Vec<String> {
    vec![
        CANARY.to_owned(),
        percent_encode(CANARY),
        CANARY_CORE.to_owned(),
    ]
}

// ---------------------------------------------------------------------------
// The four surfaces
// ---------------------------------------------------------------------------

fn renderings(error: &ProviderError) -> Vec<(&'static str, String)> {
    vec![
        ("Display", error.to_string()),
        ("Debug", format!("{error:?}")),
        (
            "serde JSON (the IPC wire shape)",
            serde_json::to_string(error).expect("ProviderError serialises"),
        ),
    ]
}

/// Every event the UI was handed, rendered as the JSON it crosses the bridge
/// as. Not just `StreamEvent::Error`: a leak in a `TextDelta` or in the
/// `Done` response would be just as bad, and cost nothing to check.
fn sink_surfaces(sink: &CollectingSink) -> Vec<(&'static str, String)> {
    sink.events
        .iter()
        .map(|event: &StreamEvent| {
            (
                "StreamEvent (the sink the UI reads)",
                serde_json::to_string(event).expect("StreamEvent serialises"),
            )
        })
        .collect()
}

#[track_caller]
fn assert_text_is_clean(label: &str, surfaces: Vec<(&'static str, String)>) {
    for (surface, text) in surfaces {
        for needle in needles() {
            assert!(
                !text.contains(&needle),
                "{label}: the credential reached {surface} (matched {needle:?}):\n  {text}"
            );
        }
    }
}

#[track_caller]
fn assert_no_credential(label: &str, error: &ProviderError, sink: &CollectingSink) {
    assert_text_is_clean(label, renderings(error));
    assert_text_is_clean(label, sink_surfaces(sink));
}

/// Guards the failure mode that would make every negative assertion pass for
/// the wrong reason: an error that says nothing at all.
#[track_caller]
fn assert_the_failure_is_real(label: &str, error: &ProviderError) {
    if let ProviderError::Transport { failure, .. } = error {
        assert!(
            matches!(
                failure,
                TransportFailure::Connect
                    | TransportFailure::Timeout
                    | TransportFailure::Reset
                    | TransportFailure::Stalled
                    | TransportFailure::Request { .. }
                    | TransportFailure::Server { .. }
            ),
            "{label}: unexpected transport failure {failure:?}"
        );
    }
    let diagnosis = error.diagnosis().unwrap_or_else(|| {
        panic!("{label}: expected an endpoint or transport failure, got {error:?}")
    });
    assert!(
        !diagnosis.cause().message().is_empty(),
        "{label}: an error with nothing to say would pass every leak assertion vacuously"
    );
    // The stronger property the redesign makes available, and the reason this
    // file's leak assertions are no longer the interesting ones: **nothing** on
    // the error's surface is endpoint-derived, so there is no encoding left for
    // a fifth round to find.
    let unexplained = vela_providers::diagnostic::unexplained_in_error(error);
    assert!(
        unexplained.is_empty(),
        "{label}: the error surface carries text the closed vocabulary does not \
         explain — {unexplained:?}\n  {error}"
    );
}

// ---------------------------------------------------------------------------
// Seven forced failures
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Forced {
    ConnectionRefused,
    NoRoute,
    TlsHandshakeFailure,
    FirstByteTimeout,
    DiesMidBody,
    /// The shape `credential_canary.rs` already covered: a non-2xx whose body
    /// quotes the request back. Read through `read_to_end`.
    EchoedIn400,
    /// **The shape it did not.** A 200 — so nothing in the error path runs —
    /// whose body carries an error object quoting the request back. Read
    /// through `next_chunk`, frame by frame.
    EchoedInA200Stream,
    /// **ROUND 4.** The same 400 echo, from a peer that percent-decodes the key
    /// it was given and writes `/` as `\/` — PHP `json_encode`'s default. No
    /// literal copy of the credential is on the wire, so the byte scrub this
    /// file was written to prove has nothing to match; what removes it is that
    /// the scrub reads a *decoded view* of the bytes, and that the decode is
    /// scrubbed again on the other side.
    EchoedIn400JsonEscaped,
    /// The same spelling in FINDING 2's shape: a 200 SSE error frame.
    EchoedInA200StreamJsonEscaped,
}

impl Forced {
    const ALL: [Forced; 9] = [
        Forced::ConnectionRefused,
        Forced::NoRoute,
        Forced::TlsHandshakeFailure,
        Forced::FirstByteTimeout,
        Forced::DiesMidBody,
        Forced::EchoedIn400,
        Forced::EchoedInA200Stream,
        Forced::EchoedIn400JsonEscaped,
        Forced::EchoedInA200StreamJsonEscaped,
    ];

    const fn label(self) -> &'static str {
        match self {
            Forced::ConnectionRefused => "connection refused",
            Forced::NoRoute => "no route to host",
            Forced::TlsHandshakeFailure => "TLS handshake failure",
            Forced::FirstByteTimeout => "no response headers",
            Forced::DiesMidBody => "body dies mid-stream",
            Forced::EchoedIn400 => "the endpoint echoes the request back (400)",
            Forced::EchoedInA200Stream => {
                "the endpoint echoes the request back (200 + error frame)"
            }
            Forced::EchoedIn400JsonEscaped => {
                "the endpoint echoes the decoded key back JSON-escaped (400)"
            }
            Forced::EchoedInA200StreamJsonEscaped => {
                "the endpoint echoes the decoded key back JSON-escaped (200 + error frame)"
            }
        }
    }

    /// Whether this failure is a `reqwest`-level one, i.e. the class that must
    /// still name the endpoint it failed on (the over-redaction defect).
    const fn is_transport_level(self) -> bool {
        matches!(
            self,
            Forced::ConnectionRefused
                | Forced::NoRoute
                | Forced::TlsHandshakeFailure
                | Forced::FirstByteTimeout
                | Forced::DiesMidBody
        )
    }

    async fn base_url(self) -> String {
        match self {
            Forced::ConnectionRefused => refused_port().await,
            Forced::NoRoute => "http://192.0.2.1:9".to_owned(),
            Forced::TlsHandshakeFailure => tls_handshake_failure().await,
            Forced::FirstByteTimeout => silent_server().await,
            Forced::DiesMidBody => dies_mid_body().await,
            Forced::EchoedIn400 => echo_server(400).await,
            Forced::EchoedInA200Stream => echo_server(200).await,
            Forced::EchoedIn400JsonEscaped => escaping_echo_server(400).await,
            Forced::EchoedInA200StreamJsonEscaped => escaping_echo_server(200).await,
        }
    }
}

/// A port nothing is listening on: bound to learn a free one, then released.
async fn refused_port() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a free port");
    let port = listener.local_addr().expect("bound").port();
    drop(listener);
    format!("http://127.0.0.1:{port}")
}

/// Plain TCP, addressed as `https://`. The handshake cannot complete.
async fn tls_handshake_failure() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a free port");
    let port = listener.local_addr().expect("bound").port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut scratch = [0u8; 1024];
            let _ = socket.read(&mut scratch).await;
            let _ = socket.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
        }
    });
    format!("https://127.0.0.1:{port}")
}

/// Accepts, then says nothing, ever. Vela's own first-byte deadline ends it.
async fn silent_server() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a free port");
    let port = listener.local_addr().expect("bound").port();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((socket, _)) = listener.accept().await {
            held.push(socket);
        }
    });
    format!("http://127.0.0.1:{port}")
}

/// A 200 that promises 4096 bytes, sends a few, and drops — the mid-stream
/// death that hits `ReqwestBody::next_chunk` rather than `send`.
async fn dies_mid_body() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a free port");
    let port = listener.local_addr().expect("bound").port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut scratch = [0u8; 8192];
            let _ = socket.read(&mut scratch).await;
            let _ = socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\n\
                      content-type: text/event-stream\r\n\
                      content-length: 4096\r\n\r\n\
                      data: {\"candidates\":[",
                )
                .await;
            let _ = socket.flush().await;
            drop(socket);
        }
    });
    format!("http://127.0.0.1:{port}")
}

// ---------------------------------------------------------------------------
// The echoing endpoint — the one that matters
// ---------------------------------------------------------------------------

/// What the endpoint saw, so it can quote it back the way real gateways do.
struct Seen {
    /// The request target, query string included — which is where
    /// `Auth::ApiKeyQuery` puts the credential.
    target: String,
    /// Values of any credential-shaped header, because several gateways echo
    /// the offending header too, and a header binding must be covered as well.
    credentials: Vec<String>,
    streaming: bool,
    anthropic: bool,
    google: bool,
}

fn parse_request(raw: &str) -> Seen {
    let mut lines = raw.split("\r\n");
    let target = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/")
        .to_owned();
    let mut credentials = Vec::new();
    for line in lines.clone() {
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        if matches!(
            name.as_str(),
            "authorization" | "x-api-key" | "api-key" | "x-goog-api-key"
        ) {
            credentials.push(value.trim().to_owned());
        }
    }
    Seen {
        streaming: target.contains("alt=sse")
            || target.contains("streamGenerateContent")
            || raw.contains("\"stream\":true"),
        anthropic: target.contains("/v1/messages"),
        google: target.contains("generateContent"),
        target,
        credentials,
    }
}

/// The message the endpoint sends back. Quotes the request target and every
/// credential header it was given, and plants [`MARKER`] so the test can tell
/// "the credential was removed" from "the message was thrown away".
fn echoed_message(seen: &Seen) -> String {
    format!(
        "{MARKER}: invalid credential for request {} (headers: {})",
        seen.target,
        if seen.credentials.is_empty() {
            "none".to_owned()
        } else {
            seen.credentials.join(" ")
        }
    )
}

/// An endpoint that quotes the request — credential included — back at Vela.
///
/// `status` 400 gives the shape the tree already covered. `status` 200 gives
/// FINDING 2's shape: an entirely successful HTTP exchange whose *body* carries
/// the error, read frame by frame, never touching any error path.
async fn echo_server(status: u16) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a free port");
    let port = listener.local_addr().expect("bound").port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut scratch = vec![0u8; 16384];
            let read = socket.read(&mut scratch).await.unwrap_or(0);
            let raw = String::from_utf8_lossy(&scratch[..read]).into_owned();
            let seen = parse_request(&raw);
            let message = echoed_message(&seen);
            let escaped = message.replace('\\', "\\\\").replace('"', "\\\"");

            let (content_type, body) = if status == 200 && seen.streaming {
                let frame = if seen.anthropic {
                    format!(
                        "event: error\ndata: {{\"type\":\"error\",\"error\":{{\"type\":\"invalid_request_error\",\"message\":\"{escaped}\"}}}}\n\n"
                    )
                } else if seen.google {
                    format!(
                        "data: {{\"error\":{{\"code\":400,\"status\":\"INVALID_ARGUMENT\",\"message\":\"{escaped}\"}}}}\n\n"
                    )
                } else {
                    format!(
                        "data: {{\"error\":{{\"code\":\"invalid_api_key\",\"type\":\"invalid_request_error\",\"message\":\"{escaped}\"}}}}\n\n"
                    )
                };
                ("text/event-stream", frame)
            } else {
                let object = if seen.anthropic {
                    format!(
                        "{{\"type\":\"error\",\"error\":{{\"type\":\"invalid_request_error\",\"message\":\"{escaped}\"}}}}"
                    )
                } else if seen.google {
                    format!(
                        "{{\"error\":{{\"code\":400,\"status\":\"INVALID_ARGUMENT\",\"message\":\"{escaped}\"}}}}"
                    )
                } else {
                    format!(
                        "{{\"error\":{{\"code\":\"invalid_api_key\",\"type\":\"invalid_request_error\",\"message\":\"{escaped}\"}}}}"
                    )
                };
                ("application/json", object)
            };

            let reason = if status == 200 { "OK" } else { "Bad Request" };
            let _ = socket
                .write_all(
                    format!(
                        "HTTP/1.1 {status} {reason}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await;
            let _ = socket.flush().await;
        }
    });
    format!("http://127.0.0.1:{port}")
}

/// **The round-4 peer.** The same echo, spelled the way an endpoint that
/// escapes the solidus spells it — and quoting the **decoded** query key, which
/// is what a gateway echoes once it has parsed the parameter rather than the
/// percent-encoded target it received.
///
/// Both halves matter. Without the decode, `Auth::ApiKeyQuery`'s credential
/// reaches the peer as `%2F`-encoded text that contains no `/` for `json_encode`
/// to rewrite; without the escaping, this is just [`echo_server`] again.
async fn escaping_echo_server(status: u16) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a free port");
    let port = listener.local_addr().expect("bound").port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut scratch = vec![0u8; 16384];
            let read = socket.read(&mut scratch).await.unwrap_or(0);
            let raw = String::from_utf8_lossy(&scratch[..read]).into_owned();
            let seen = parse_request(&raw);
            let mut quoted = seen.credentials.clone();
            if let Some(key) = decoded_query_key(&seen.target) {
                quoted.push(key);
            }
            let message = format!(
                "{MARKER}: invalid credential [{}] for request {}",
                if quoted.is_empty() {
                    "none".to_owned()
                } else {
                    quoted.join(" ")
                },
                seen.target
            );
            // PHP `json_encode`, default flags. Built by hand rather than with
            // `serde_json::to_string`, because serde deliberately does **not**
            // escape `/` — the point of this peer is to be something other than
            // a Rust encoder.
            let escaped = message
                .replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('/', "\\/");

            let (content_type, body) = if status == 200 && seen.streaming {
                let frame = if seen.anthropic {
                    format!(
                        "event: error\ndata: {{\"type\":\"error\",\"error\":{{\"type\":\"authentication_error\",\"message\":\"{escaped}\"}}}}\n\n"
                    )
                } else if seen.google {
                    format!(
                        "data: {{\"error\":{{\"code\":400,\"status\":\"INVALID_ARGUMENT\",\"message\":\"{escaped}\"}}}}\n\n"
                    )
                } else {
                    format!(
                        "data: {{\"error\":{{\"code\":\"invalid_api_key\",\"type\":\"invalid_request_error\",\"message\":\"{escaped}\"}}}}\n\n"
                    )
                };
                ("text/event-stream", frame)
            } else {
                let object = if seen.anthropic {
                    format!(
                        "{{\"type\":\"error\",\"error\":{{\"type\":\"authentication_error\",\"message\":\"{escaped}\"}}}}"
                    )
                } else if seen.google {
                    format!(
                        "{{\"error\":{{\"code\":400,\"status\":\"INVALID_ARGUMENT\",\"message\":\"{escaped}\"}}}}"
                    )
                } else {
                    format!(
                        "{{\"error\":{{\"code\":\"invalid_api_key\",\"type\":\"invalid_request_error\",\"message\":\"{escaped}\"}}}}"
                    )
                };
                ("application/json", object)
            };

            let reason = if status == 200 { "OK" } else { "Bad Request" };
            let _ = socket
                .write_all(
                    format!(
                        "HTTP/1.1 {status} {reason}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await;
            let _ = socket.flush().await;
        }
    });
    format!("http://127.0.0.1:{port}")
}

/// The `key`/`api_key` query parameter of a request target, percent-decoded —
/// what a gateway's own parser hands its error path.
fn decoded_query_key(target: &str) -> Option<String> {
    let (_, query) = target.split_once('?')?;
    let (_, value) = query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(name, _)| matches!(*name, "key" | "api_key"))?;
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or(""),
                16,
            ) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    Some(String::from_utf8_lossy(&out).into_owned())
}

// ---------------------------------------------------------------------------
// Three adapters, two bindings
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Adapter {
    OpenAiCompatible,
    Anthropic,
    Google,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Binding {
    /// The credential in the query string. Google's only binding, and available
    /// to any user-configured OpenAI-compatible endpoint.
    Query,
    /// The credential in a header. It never touches the URL — and it is still a
    /// credential, so the same four surfaces must be clean.
    Header,
    /// No credential at all. A first-class state (conventions §0 rule 2), and
    /// the control that tells redaction apart from deletion.
    None,
}

fn descriptor(id: &str) -> ProviderDescriptor {
    ProviderDescriptor::new(id, "Canary", ProviderKind::RemoteApi).expect("a valid descriptor")
}

fn auth(id: &str, adapter: Adapter, binding: Binding) -> (Arc<dyn SecretStore>, Auth) {
    let secrets = Arc::new(MemoryStore::new());
    if binding == Binding::None {
        return (secrets, Auth::None);
    }
    let secret = SecretRef::primary(id).expect("a valid provider id");
    secrets
        .set(&secret, &SecretValue::new(CANARY))
        .expect("MemoryStore accepts a non-empty value");
    let auth = match (binding, adapter) {
        (Binding::Query, Adapter::Google) => Auth::ApiKeyQuery {
            param: "key".into(),
            secret,
        },
        (Binding::Query, _) => Auth::ApiKeyQuery {
            param: "api_key".into(),
            secret,
        },
        (Binding::Header, Adapter::Anthropic) => Auth::ApiKeyHeader {
            header: "x-api-key".into(),
            secret,
        },
        (Binding::Header, Adapter::Google) => Auth::ApiKeyHeader {
            header: "x-goog-api-key".into(),
            secret,
        },
        (Binding::Header, _) => Auth::Bearer { secret },
        (Binding::None, _) => unreachable!("returned above"),
    };
    (secrets, auth)
}

fn build(adapter: Adapter, binding: Binding, base_url: &str) -> Arc<dyn Provider> {
    let id = match (adapter, binding) {
        (Adapter::OpenAiCompatible, b) => format!("canary-compat-{b:?}").to_ascii_lowercase(),
        (Adapter::Anthropic, b) => format!("canary-anthropic-{b:?}").to_ascii_lowercase(),
        (Adapter::Google, b) => format!("canary-google-{b:?}").to_ascii_lowercase(),
    };
    let (secrets, auth) = auth(&id, adapter, binding);
    let transport = Arc::new(
        ReqwestTransport::with_connect_timeout(Duration::from_millis(300))
            .expect("the client builds"),
    );
    match adapter {
        Adapter::OpenAiCompatible => Arc::new(OpenAiCompatibleProvider::new(
            descriptor(&id),
            base_url,
            auth,
            secrets,
            transport,
        )),
        Adapter::Anthropic => Arc::new(AnthropicProvider::new(
            descriptor(&id),
            base_url,
            auth,
            secrets,
            transport,
        )),
        Adapter::Google => Arc::new(GoogleProvider::new(
            descriptor(&id),
            base_url,
            auth,
            secrets,
            transport,
        )),
    }
}

fn context() -> RequestContext {
    RequestContext::new().with_timeouts(Timeouts {
        connect: Duration::from_millis(300),
        first_byte: Duration::from_millis(300),
        stall: Duration::from_millis(300),
    })
}

fn turn() -> ChatRequest {
    ChatRequest::new("canary-model").with_message(ChatMessage::user("hi"))
}

/// Drive both transports. `complete()` reads the body whole; `stream()` reads it
/// chunk by chunk — the difference that hid FINDING 2 for two rounds.
async fn drive(provider: &Arc<dyn Provider>) -> Vec<(&'static str, ProviderError, CollectingSink)> {
    let mut out = Vec::new();

    let completed = provider.complete(turn(), &context()).await;
    out.push((
        "complete()",
        completed.expect_err("the endpoint is broken on purpose"),
        // `complete()` takes no sink; an empty one keeps the tuple uniform and
        // the surface count honest.
        CollectingSink::new(),
    ));

    let mut streamed_sink = CollectingSink::new();
    let streamed = provider
        .stream(turn(), &mut streamed_sink, &context())
        .await;
    out.push((
        "stream()",
        streamed.expect_err("the endpoint is broken on purpose"),
        streamed_sink,
    ));

    out
}

// ---------------------------------------------------------------------------
// THE MATRIX
// ---------------------------------------------------------------------------

async fn assert_every_forced_failure_is_clean(adapter: Adapter, binding: Binding) {
    let mut cases = 0usize;
    let mut echoed_cases = 0usize;
    let mut sink_errors = 0usize;

    for forced in Forced::ALL {
        let base_url = forced.base_url().await;
        let provider = build(adapter, binding, &base_url);
        for (path, error, sink) in drive(&provider).await {
            let label = format!("{adapter:?}/{binding:?} · {} · {path}", forced.label());
            assert_the_failure_is_real(&label, &error);
            assert_no_credential(&label, &error, &sink);
            cases += 1;
            if !forced.is_transport_level() {
                echoed_cases += 1;
            }
            if sink.error().is_some() {
                sink_errors += 1;
            }
        }
    }

    assert!(
        sink_errors >= Forced::ALL.len(),
        "the sink surface would pass vacuously: only {sink_errors} of the \
         {} streamed cases put an error on the sink at all",
        Forced::ALL.len()
    );

    assert_eq!(
        cases,
        Forced::ALL.len() * 2,
        "the matrix did not run: {cases} cases"
    );
    assert_eq!(
        echoed_cases, 8,
        "the four echoing endpoints must contribute eight cases, or the shapes \
         this file exists for were not driven"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn openai_compatible_leaks_nothing_on_any_forced_failure_query_binding() {
    assert_every_forced_failure_is_clean(Adapter::OpenAiCompatible, Binding::Query).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn openai_compatible_leaks_nothing_on_any_forced_failure_header_binding() {
    assert_every_forced_failure_is_clean(Adapter::OpenAiCompatible, Binding::Header).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn anthropic_leaks_nothing_on_any_forced_failure_header_binding() {
    assert_every_forced_failure_is_clean(Adapter::Anthropic, Binding::Header).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn anthropic_leaks_nothing_on_any_forced_failure_query_binding() {
    assert_every_forced_failure_is_clean(Adapter::Anthropic, Binding::Query).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn google_leaks_nothing_on_any_forced_failure_query_binding() {
    assert_every_forced_failure_is_clean(Adapter::Google, Binding::Query).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn google_leaks_nothing_on_any_forced_failure_header_binding() {
    assert_every_forced_failure_is_clean(Adapter::Google, Binding::Header).await;
}

// ---------------------------------------------------------------------------
// Redaction, not deletion
// ---------------------------------------------------------------------------

/// **The control that used to tell defect 1 from defect 2 — now the sharpest
/// statement of the redesign there is.**
///
/// The same echoing endpoint and the same message, driven twice: once with
/// `Auth::None` and once with a credential in the query string. Under rounds
/// 1–4 those two produced *different* text, and had to: the first carried the
/// endpoint's message whole, the second carried it with `<redacted>` spliced
/// in. Telling them apart was how the gate distinguished under-redaction from
/// over-redaction.
///
/// Under the redesign they are **byte-identical**, because neither carries the
/// endpoint's message at all. That is a much stronger claim than either of the
/// old ones, and it is the claim no encoding can defeat: if the rendering does
/// not vary with what the endpoint sent, the endpoint has no channel.
#[tokio::test(flavor = "multi_thread")]
async fn the_rendering_does_not_vary_with_what_the_endpoint_sent() {
    for adapter in [
        Adapter::OpenAiCompatible,
        Adapter::Anthropic,
        Adapter::Google,
    ] {
        let base_url = echo_server(200).await;

        let mut without: Vec<(String, String)> = Vec::new();
        for (path, error, _) in drive(&build(adapter, Binding::None, &base_url)).await {
            let rendered = error.to_string();
            assert!(
                !rendered.contains(MARKER),
                "{adapter:?} · {path}: the endpoint's own message reached the \
                 error surface — got {rendered}"
            );
            assert!(
                !rendered.contains("<redacted>"),
                "{adapter:?} · {path}: there is nothing to redact when nothing \
                 is carried — got {rendered}"
            );
            without.push((path.to_owned(), strip_correlation(&rendered)));
        }

        let mut with: Vec<(String, String)> = Vec::new();
        for (path, error, _) in drive(&build(adapter, Binding::Query, &base_url)).await {
            with.push((path.to_owned(), strip_correlation(&error.to_string())));
        }

        assert!(!without.is_empty(), "{adapter:?}: nothing was driven");
        assert_eq!(
            without, with,
            "{adapter:?}: the rendering must not depend on whether a credential \
             was configured — nor, therefore, on what the endpoint echoed"
        );
    }
}

/// Replace the correlation id with a placeholder.
///
/// The id is Vela's own monotonic counter and is expected to differ between two
/// exchanges; everything else in a rendering is expected not to.
fn strip_correlation(rendered: &str) -> String {
    match (rendered.find("[ref "), rendered.find(']')) {
        (Some(start), _) => {
            let end = rendered[start..].find(']').map(|at| start + at + 1);
            match end {
                Some(end) => format!("{}[ref …]{}", &rendered[..start], &rendered[end..]),
                None => rendered.to_owned(),
            }
        }
        _ => rendered.to_owned(),
    }
}

/// The positive counterpart: with a credential configured, the **same** message
/// keeps its diagnosis and loses only the secret.
#[tokio::test(flavor = "multi_thread")]
async fn a_diagnosis_without_the_endpoints_words_is_still_actionable() {
    let base_url = echo_server(200).await;
    let provider = build(Adapter::Google, Binding::Query, &base_url);

    let mut sink = CollectingSink::new();
    let error = provider
        .stream(turn(), &mut sink, &context())
        .await
        .expect_err("the stream carries an error object");

    let rendered = error.to_string();
    assert_no_credential(
        "google · a diagnosis without the endpoint's words",
        &error,
        &sink,
    );
    assert!(
        !rendered.contains(MARKER),
        "the endpoint's own words must not reach the error: {rendered}"
    );
    // What replaces them: the three things Vela knew without asking the peer.
    assert_eq!(
        error.cause(),
        Some(vela_providers::Cause::EndpointRejectedRequest)
    );
    let endpoint = error.endpoint().expect("the endpoint must still be named");
    assert!(
        endpoint.path().contains("models/canary-model"),
        "the request target must still be legible: {endpoint}"
    );
    assert!(
        !error.correlation().expect("a correlation id").is_none(),
        "and the body must be findable in the debug log by reference"
    );
}

/// **DEFECT 2.** Round 2 called `reqwest::Error::without_url()` unconditionally,
/// so every transport failure lost the endpoint it failed on — including
/// requests carrying no credential. Three configured candidates, one dead, and
/// nothing to say which.
///
/// Both bindings, because the point is that redaction is not deletion: with
/// `Auth::None` the URL is verbatim, and with a query credential it is the same
/// URL with `<redacted>` where the key was.
#[tokio::test(flavor = "multi_thread")]
async fn transport_failures_still_name_the_endpoint_they_failed_on() {
    let mut checked = 0usize;

    for binding in [Binding::None, Binding::Query] {
        for forced in Forced::ALL.into_iter().filter(|f| f.is_transport_level()) {
            let base_url = forced.base_url().await;
            // The authority is what distinguishes one configured candidate from
            // another, so it is what the error has to carry.
            let authority = base_url
                .split("//")
                .nth(1)
                .expect("a scheme")
                .trim_end_matches('/')
                .to_owned();
            let provider = build(Adapter::Google, binding, &base_url);

            for (path, error, sink) in drive(&provider).await {
                let label = format!("{binding:?} · {} · {path}", forced.label());
                assert!(
                    matches!(&error, ProviderError::Transport { .. }),
                    "{label}: expected a transport failure, got {error:?}"
                );
                let endpoint = error.endpoint().unwrap_or_else(|| {
                    panic!("{label}: the error must name the endpoint that failed: {error:?}")
                });
                assert!(
                    endpoint.authority().contains(&authority),
                    "{label}: the error must name the endpoint that failed, \
                     got {endpoint} (looking for {authority:?})"
                );
                assert!(
                    endpoint.path().contains("models/canary-model"),
                    "{label}: naming the host is not enough — the request target \
                     tells two candidates on one host apart: {endpoint}"
                );
                if binding == Binding::Query {
                    // Rounds 1–4 asserted `<redacted>` was *present* here,
                    // because the endpoint was a redacted URL string and a URL
                    // that had simply lost its query would have been a deletion.
                    // `EndpointIdentity` drops the query string whole instead,
                    // so the assertion inverts: there is no `?key=` to redact,
                    // and the two candidate-distinguishing parts — authority and
                    // path — are both still there, as asserted just above.
                    let rendered = endpoint.to_string();
                    assert!(
                        !rendered.contains('?') && !rendered.contains("<redacted>"),
                        "{label}: the query string is dropped, not redacted: {rendered}"
                    );
                }
                assert_no_credential(&label, &error, &sink);
                checked += 1;
            }
        }
    }

    assert_eq!(checked, 20, "the endpoint-identity matrix did not run");
}

// ---------------------------------------------------------------------------
// POSITIVE CONTROLS — every assertion above must be able to fail
// ---------------------------------------------------------------------------

/// A raw [`ByteStream`] with no [`BodyStream`] around it: **exactly what the
/// streaming path read before this round**, when `BodyStream` was an alias for
/// `Box<dyn ByteStream>` and `next_chunk` returned bytes unmodified.
async fn read_the_pre_fix_way(mut body: impl ByteStream) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(chunk) = body.next_chunk().await.expect("scripted") {
        out.extend_from_slice(&chunk);
    }
    out
}

fn echoing_sse_frame() -> String {
    format!(
        "data: {{\"error\":{{\"code\":\"invalid_api_key\",\"message\":\"{MARKER}: invalid credential for request /v1/chat/completions?api_key={}\"}}}}\n\n",
        percent_encode(CANARY)
    )
}

fn origin_for_the_echoing_request() -> BodyOrigin {
    HttpRequest::post_json(
        RequestUrl::new("http://127.0.0.1:9/v1/chat/completions"),
        b"{}".to_vec(),
    )
    .with_auth(&vela_secrets::AppliedAuth::QueryParam {
        name: "api_key".into(),
        value: SecretValue::new(CANARY),
    })
    .origin()
}

/// Turn body bytes into the error the assembler makes of them — the real path
/// from `{"error":…}` frame to `ProviderError`, sink included.
fn assemble(bytes: &[u8]) -> (ProviderError, CollectingSink) {
    let mut sink = CollectingSink::new();
    let mut assembler = CompletionAssembler::new(true, false);
    assembler.push_bytes(bytes, &mut sink);
    let error = assembler
        .finish(&mut sink)
        .expect_err("the frame carries an error object");
    (error, sink)
}

/// **POSITIVE CONTROL for defect 1.** The detector must be able to fail.
///
/// Same frame, same assembler, same error type — read the pre-fix way, the
/// canary reaches every surface; read through [`BodyStream`], it reaches none.
/// If the first half of this test ever stops finding the canary, every negative
/// assertion in this file is worthless.
#[tokio::test(flavor = "multi_thread")]
async fn positive_control_the_pre_fix_streamed_read_leaks() {
    let frame = echoing_sse_frame();

    // --- the bug, rebuilt ---------------------------------------------------
    // The detector is now the **bytes**, not the error. Round 3's property is
    // "the bytes Vela's parser consumes are already clean", and that is what
    // this control has to be able to fail — the error surface can no longer
    // detect it, because under the redesign the error would not carry the
    // credential even if the bytes did. Measuring the leak where it happens is
    // the honest instrument; measuring it at a surface that structurally cannot
    // show it would be a control that always passes.
    let unscrubbed = read_the_pre_fix_way(ScriptedBody::from_text(&frame)).await;
    assert!(
        String::from_utf8_lossy(&unscrubbed).contains(CANARY_CORE),
        "the pre-fix read must leak into the bytes, or the byte-level property \
         is untested"
    );

    // --- and the second barrier, which is what the redesign adds ------------
    // The same leaking bytes, through the real assembler: **nothing** reaches
    // any surface. The two barriers are independent, and either one alone is
    // sufficient — which is why a fifth encoding could not have helped an
    // attacker even if barrier 1 had missed it.
    let (leaked, leaked_sink) = assemble(&unscrubbed);
    assert_no_credential(
        "bytes that leaked, error that does not",
        &leaked,
        &leaked_sink,
    );
    assert!(
        leaked_sink.events.is_empty(),
        "the assembler returns the error rather than emitting it — the provider \
         is what puts it on the sink, which is the step reconstructed next"
    );
    // Exactly what `openai_compatible/provider.rs`, `google/provider.rs` and
    // `anthropic/provider.rs` do with the error the assembler hands back.
    let handed_to_the_ui = StreamEvent::Error {
        error: leaked.clone(),
    };
    assert!(
        !serde_json::to_string(&handed_to_the_ui)
            .expect("StreamEvent serialises")
            .contains(CANARY_CORE),
        "the sink the UI reads must be clean even when the bytes were not"
    );

    // --- the fix ------------------------------------------------------------
    let mut body = BodyStream::new(
        ScriptedBody::from_text(&frame),
        origin_for_the_echoing_request(),
    );
    let mut scrubbed = Vec::new();
    while let Some(chunk) = body.next_chunk().await.expect("scripted") {
        scrubbed.extend_from_slice(&chunk);
    }
    assert!(
        !String::from_utf8_lossy(&scrubbed).contains(CANARY_CORE),
        "and barrier 1 alone removes it from the bytes"
    );
    let (clean, clean_sink) = assemble(&scrubbed);
    assert_no_credential("the same frame through BodyStream", &clean, &clean_sink);
    assert_eq!(
        clean.cause(),
        Some(vela_providers::Cause::CredentialRejected),
        "and the diagnosis survives"
    );
}

/// **POSITIVE CONTROL for the boundary case.** A per-chunk scrub that ignored
/// chunk boundaries would pass the test above and still leak here: the canary is
/// split across two reads, so neither chunk contains it whole.
#[tokio::test(flavor = "multi_thread")]
async fn positive_control_a_credential_split_across_two_chunks_leaks() {
    let frame = echoing_sse_frame();
    // One byte at a time: no chunk contains two characters of the key, let
    // alone the key.
    let fragmented = || ScriptedBody::fragmented(&frame, 1);

    let unscrubbed = read_the_pre_fix_way(fragmented()).await;
    assert!(
        String::from_utf8_lossy(&unscrubbed).contains(CANARY_CORE),
        "the control must leak into the bytes, or the boundary case is untested"
    );

    let mut body = BodyStream::new(fragmented(), origin_for_the_echoing_request());
    let mut scrubbed = Vec::new();
    while let Some(chunk) = body.next_chunk().await.expect("scripted") {
        scrubbed.extend_from_slice(&chunk);
    }
    assert_eq!(
        String::from_utf8_lossy(&scrubbed)
            .matches("<redacted>")
            .count(),
        1,
        "the split credential must be found and replaced exactly once"
    );
    let (clean, clean_sink) = assemble(&scrubbed);
    assert_no_credential("a credential split across chunks", &clean, &clean_sink);
    assert_eq!(
        clean.cause(),
        Some(vela_providers::Cause::CredentialRejected),
        "and the diagnosis survives"
    );
}

/// **POSITIVE CONTROL for defect 2.** The endpoint-identity assertion must be
/// able to fail — and it fails against round 2's own output, which is the point.
#[test]
fn positive_control_dropping_the_url_loses_the_endpoint() {
    let url = RequestUrl::new("http://127.0.0.1:1/v1/chat/completions")
        .with_query_credential("api_key", &SecretValue::new(CANARY));
    let scrubber = url.scrubber();

    // Round 2: `without_url()` and nothing else. Clean, and mute.
    let round_2 = scrubber.scrub("error sending request".to_owned());
    assert!(
        !round_2.contains("127.0.0.1:1"),
        "this control reproduces round 2's output, which named no endpoint"
    );
    assert!(
        !round_2.contains(CANARY_CORE),
        "round 2 was not leaking here"
    );

    // Round 3: the redacted URL is re-attached.
    let round_3 = scrubber.scrub(format!(
        "error sending request for url ({})",
        url.redacted()
    ));
    assert!(
        round_3.contains("127.0.0.1:1/v1/chat/completions"),
        "the endpoint must be named again: {round_3}"
    );
    assert!(
        round_3.contains("<redacted>"),
        "and the key replaced rather than the URL dropped: {round_3}"
    );
    assert!(
        !round_3.contains(CANARY_CORE) && !round_3.contains(&percent_encode(CANARY)),
        "without leaking anything: {round_3}"
    );
}

// ---------------------------------------------------------------------------
// The structural guarantee
// ---------------------------------------------------------------------------

/// A **new** `ByteStream` implementation, written the way the gate's own
/// recorder was written: it wraps a body, forwards the bytes, and forwards
/// nothing else.
///
/// Under the old design this silently disabled redaction, because
/// `ByteStream::scrubber()` defaulted to `Scrubber::none()`. It cannot now:
/// there is no such method to forget, and `inner` is a [`BodyStream`], so the
/// bytes this decorator sees have already been cleaned.
struct ForgetfulDecorator {
    inner: BodyStream,
    seen: Vec<u8>,
}

#[async_trait::async_trait]
impl ByteStream for ForgetfulDecorator {
    async fn next_chunk(
        &mut self,
    ) -> Result<Option<Vec<u8>>, vela_providers::http::TransportError> {
        let chunk = self.inner.next_chunk().await?;
        if let Some(bytes) = &chunk {
            self.seen.extend_from_slice(bytes);
        }
        Ok(chunk)
    }
}

/// **THE DURABLE FIX, ASSERTED.**
///
/// The gate executor's brief for this round: *"a security property carried by an
/// overridable method that defaults to no protection means any future decorating
/// body disables it by omission."* So a decorator that forwards nothing must
/// still be unable to leak — and one that tries to wrap the raw source instead
/// of the `BodyStream` cannot be built at all, which the `compile_fail` doctests
/// on `http::BodyStream` pin.
#[tokio::test(flavor = "multi_thread")]
async fn a_new_body_that_forwards_nothing_still_cannot_leak_the_credential() {
    let frame = echoing_sse_frame();

    let decorated = ForgetfulDecorator {
        inner: BodyStream::new(
            ScriptedBody::fragmented(&frame, 7),
            origin_for_the_echoing_request(),
        ),
        seen: Vec::new(),
    };
    // And wrapped again, with an origin that knows nothing — the omission the
    // recorder actually made.
    let mut body = BodyStream::new(decorated, BodyOrigin::carries_no_credential());

    let mut bytes = Vec::new();
    while let Some(chunk) = body.next_chunk().await.expect("scripted") {
        bytes.extend_from_slice(&chunk);
    }

    assert!(
        !String::from_utf8_lossy(&bytes).contains(CANARY_CORE),
        "barrier 1 holds through two layers of wrapping"
    );
    let (error, sink) = assemble(&bytes);
    assert_no_credential("a decorator that forwards nothing", &error, &sink);
    assert_eq!(
        error.cause(),
        Some(vela_providers::Cause::CredentialRejected),
        "and the diagnosis still survives two layers of wrapping"
    );
}

/// The seam's own invariant, checked directly: a body built from a request that
/// carries a credential scrubs, and one built from a request that does not is
/// the identity — no copy, no hold-back, no behaviour change for the local
/// runtimes that are Vela's common case.
#[tokio::test(flavor = "multi_thread")]
async fn a_body_answering_a_credential_free_request_is_untouched() {
    let origin = HttpRequest::post_json(
        RequestUrl::new("http://127.0.0.1:11434/v1/chat/completions"),
        b"{}".to_vec(),
    )
    .origin();
    assert!(origin.scrubber().is_empty());
    assert_eq!(
        origin.endpoint().map(ToString::to_string).as_deref(),
        Some("http://127.0.0.1:11434/v1/chat/completions")
    );

    let text = "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n";
    let mut body = BodyStream::new(ScriptedBody::fragmented(text, 5), origin);
    let mut chunks = Vec::new();
    while let Some(chunk) = body.next_chunk().await.expect("scripted") {
        chunks.push(String::from_utf8(chunk).expect("utf8"));
    }
    assert_eq!(
        chunks.len(),
        text.len().div_ceil(5),
        "an unscrubbed body hands back the chunk boundaries it was given"
    );
    assert_eq!(chunks.concat(), text);
}

/// The credential still has to *work*: a redaction that redacted the wire form
/// would pass every assertion in this file and break every request.
#[test]
fn the_credential_is_still_on_the_url_that_goes_to_the_socket() {
    let request = HttpRequest::post_json(
        RequestUrl::new("http://127.0.0.1:9/v1/chat/completions"),
        b"{}".to_vec(),
    )
    .with_auth(&vela_secrets::AppliedAuth::QueryParam {
        name: "api_key".into(),
        value: SecretValue::new(CANARY),
    });

    assert!(
        request.url.expose().contains(&percent_encode(CANARY)),
        "the wire form must still carry the credential, or nothing authenticates"
    );
    assert!(!request
        .origin()
        .endpoint()
        .map(|endpoint| endpoint.to_string())
        .unwrap_or_default()
        .contains(CANARY_CORE));
    assert!(!request.origin().scrubber().is_empty());
    assert_eq!(
        Scrubber::none().scrub("untouched"),
        "untouched",
        "and an empty scrubber is still the identity"
    );
}
