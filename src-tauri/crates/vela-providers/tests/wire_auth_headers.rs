//! **`Auth::None` sends no credential — proved on the wire.**
//!
//! # Why this file exists
//!
//! Conventions §0 rule 2 makes "no API key" a first-class provider state, and
//! `vela_secrets::resolve_auth` is written so that no credential means *no
//! header* rather than an empty one. Until Phase B that rule could only be
//! checked where it was written: the adapters' unit tests assert on the
//! [`HttpRequest`](vela_providers::http::HttpRequest) struct handed to a
//! `ScriptedTransport`, and the live matrix infers absence from the fact that
//! the mock answers a bare `Bearer` with `401 empty_authorization_header`.
//!
//! Both are indirect. Neither can see what `reqwest` itself puts on the socket,
//! and the second cannot distinguish "no header" from "a header carrying
//! something non-empty and wrong" — an endpoint with no key configured accepts
//! both. Phase A recorded that as an open gap, because Phase A shipped no HTTP
//! client to close it with. There is one now.
//!
//! # What is actually measured here
//!
//! A [`RecordingProxy`] listens on a real loopback port, tees every byte the
//! client sends into a buffer, and forwards it verbatim upstream. The provider
//! is a real provider, the transport is the real [`ReqwestTransport`], and for
//! the OpenAI-compatible case the upstream is the real mock-provider harness
//! running as a separate OS process. The assertions are made against the
//! **literal request bytes**, request line and headers included — not against a
//! struct, and not against an inference from a status code.
//!
//! Every test carries its own positive control: the same path with a credential
//! configured, asserting the header *is* on the wire. A recorder that saw
//! nothing either way would pass the negative assertions vacuously.
//!
//! # Honesty (conventions.md §10)
//!
//! **VERIFIED-BY-FAKE.** The upstreams are a deterministic mock and a canned
//! responder; the credential store is `MemoryStore`. This proves what Vela puts
//! on a socket. It proves nothing about any real vendor endpoint, and nothing
//! about the OS keychain.

use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command};

use vela_core::credential::Auth;
use vela_core::provider::{ProviderDescriptor, ProviderKind};
use vela_core::secret::{SecretRef, SecretValue};
use vela_providers::anthropic::AnthropicProvider;
use vela_providers::google::GoogleProvider;
use vela_providers::http::ReqwestTransport;
use vela_providers::openai_compatible::OpenAiCompatibleProvider;
use vela_providers::{ChatMessage, ChatRequest, Provider, RequestContext, Timeouts};
use vela_secrets::{MemoryStore, SecretStore};

// ---------------------------------------------------------------------------
// The wire recorder
// ---------------------------------------------------------------------------

/// What the proxy does with a connection once it has copied the client's bytes.
#[derive(Clone)]
enum Upstream {
    /// Forward verbatim to a real server and pipe the answer back, so the
    /// provider completes a genuine turn while being recorded.
    Forward(String),
    /// Answer with a canned response. Used for the adapters whose vendor wire
    /// format the OpenAI-shaped harness does not speak; the request bytes are
    /// still real, which is the only thing this file asserts on.
    Canned(Arc<Vec<u8>>),
}

/// A loopback listener that records every byte a client sends to it.
///
/// Recording at the socket means the capture includes whatever `reqwest` adds
/// on its own — this is the only vantage point from which "Vela sent no
/// `Authorization` header" is a statement about the wire rather than about a
/// struct Vela built before handing it to a client.
struct RecordingProxy {
    url: String,
    seen: Arc<Mutex<Vec<u8>>>,
}

impl RecordingProxy {
    async fn start(upstream: Upstream) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a loopback port is available");
        let port = listener.local_addr().expect("bound").port();
        let seen = Arc::new(Mutex::new(Vec::new()));

        let sink = Arc::clone(&seen);
        tokio::spawn(async move {
            while let Ok((client, _)) = listener.accept().await {
                tokio::spawn(serve(client, upstream.clone(), Arc::clone(&sink)));
            }
        });

        Self {
            url: format!("http://127.0.0.1:{port}"),
            seen,
        }
    }

    /// The captured bytes, lossily decoded. Headers are ASCII; a body that is
    /// not valid UTF-8 must not break the assertion, hence lossy.
    fn transcript(&self) -> String {
        String::from_utf8_lossy(&self.seen.lock().expect("recorder poisoned")).into_owned()
    }

    /// Every header line the client sent, lowercased, across every request on
    /// every connection. Stops at the blank line that ends each head, so a body
    /// that happens to contain the word `authorization` cannot be mistaken for
    /// a header — the false negative that would make this whole file worthless.
    fn header_lines(&self) -> Vec<String> {
        let transcript = self.transcript();
        let mut out = Vec::new();
        let mut in_head = false;
        for line in transcript.split("\r\n") {
            if is_request_line(line) {
                in_head = true;
                continue;
            }
            if line.is_empty() {
                in_head = false;
                continue;
            }
            if in_head {
                out.push(line.to_ascii_lowercase());
            }
        }
        out
    }

    /// Every request target (the middle field of a request line), so query
    /// strings can be inspected for a credential smuggled in as `?key=`.
    fn request_targets(&self) -> Vec<String> {
        self.transcript()
            .split("\r\n")
            .filter(|line| is_request_line(line))
            .filter_map(|line| line.split(' ').nth(1).map(str::to_owned))
            .collect()
    }

    fn saw_traffic(&self) -> bool {
        !self.request_targets().is_empty()
    }
}

fn is_request_line(line: &str) -> bool {
    let mut fields = line.split(' ');
    let method = fields.next().unwrap_or_default();
    let target = fields.next().unwrap_or_default();
    let version = fields.next().unwrap_or_default();
    matches!(
        method,
        "GET" | "POST" | "PUT" | "DELETE" | "HEAD" | "OPTIONS"
    ) && target.starts_with('/')
        && version.starts_with("HTTP/")
        && fields.next().is_none()
}

async fn serve(client: TcpStream, upstream: Upstream, sink: Arc<Mutex<Vec<u8>>>) {
    let (mut client_read, mut client_write) = client.into_split();
    match upstream {
        Upstream::Canned(response) => {
            let mut buffer = [0_u8; 8192];
            // One read is enough to capture the head; the provider's requests
            // here are small and arrive in a single segment on loopback. Answer
            // immediately so the provider is never left hanging.
            if let Ok(read) = client_read.read(&mut buffer).await {
                sink.lock()
                    .expect("recorder poisoned")
                    .extend_from_slice(&buffer[..read]);
            }
            let _ = client_write.write_all(&response).await;
            let _ = client_write.shutdown().await;
        }
        Upstream::Forward(address) => {
            let Ok(server) = TcpStream::connect(&address).await else {
                return;
            };
            let (mut server_read, mut server_write) = server.into_split();
            let outbound = tokio::spawn(async move {
                let mut buffer = vec![0_u8; 8192];
                loop {
                    match client_read.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => {
                            sink.lock()
                                .expect("recorder poisoned")
                                .extend_from_slice(&buffer[..read]);
                            if server_write.write_all(&buffer[..read]).await.is_err() {
                                break;
                            }
                        }
                    }
                }
                let _ = server_write.shutdown().await;
            });
            let _ = tokio::io::copy(&mut server_read, &mut client_write).await;
            let _ = client_write.shutdown().await;
            let _ = outbound.await;
        }
    }
}

/// A minimal, valid, non-streaming answer in each vendor's shape. The adapters
/// parse these; what they contain is irrelevant to the assertions, but a
/// well-formed answer keeps a failure here unambiguous — a red test means a
/// header appeared, not that the fixture was malformed.
fn canned(body: &str) -> Upstream {
    let response = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    Upstream::Canned(Arc::new(response.into_bytes()))
}

const ANTHROPIC_ANSWER: &str = r#"{"id":"msg_1","type":"message","role":"assistant","model":"claude-x","content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}"#;

const GOOGLE_ANSWER: &str = r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}"#;

// ---------------------------------------------------------------------------
// The mock harness (OpenAI-shaped upstream)
// ---------------------------------------------------------------------------

struct MockServer {
    child: Child,
    address: String,
}

impl MockServer {
    async fn start(profile: &str) -> Self {
        let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(3)
            .expect("crates/<name> sits three levels below the repo root")
            .to_path_buf();
        let cli = repo_root.join("tests/harness/mock-provider/src/cli.ts");
        assert!(cli.exists(), "mock harness missing at {}", cli.display());

        let mut child = Command::new("node")
            .arg(&cli)
            .arg("--profile")
            .arg(profile)
            .arg("--port")
            .arg("0")
            .current_dir(&repo_root)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap_or_else(|error| {
                panic!(
                    "could not start the mock harness ({error}). \
                     These tests need Node 22+ on PATH; see docs/regression-baseline/mock-matrix/README.md"
                )
            });

        let stdout = child.stdout.take().expect("piped");
        let mut lines = BufReader::new(stdout).lines();
        let url = tokio::time::timeout(Duration::from_secs(30), async {
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(at) = line.find("listening on ") {
                    return line[at + "listening on ".len()..].trim().to_owned();
                }
            }
            panic!("the mock harness exited before it reported a URL");
        })
        .await
        .expect("the mock harness did not start within 30 s");

        let address = url
            .trim_start_matches("http://")
            .trim_end_matches('/')
            .to_owned();
        Self { child, address }
    }

    async fn stop(mut self) {
        let _ = self.child.kill().await;
    }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn context() -> RequestContext {
    RequestContext::new().with_timeouts(Timeouts {
        connect: Duration::from_secs(5),
        first_byte: Duration::from_secs(15),
        stall: Duration::from_secs(15),
    })
}

fn descriptor(id: &str) -> ProviderDescriptor {
    ProviderDescriptor::new(id, "Wire capture", ProviderKind::Local).unwrap()
}

fn transport() -> Arc<ReqwestTransport> {
    Arc::new(ReqwestTransport::new().expect("http client builds"))
}

/// A store holding one credential, and the binding that points at it.
fn stored_credential(provider_id: &str, value: &str) -> (Arc<MemoryStore>, SecretRef) {
    let store = Arc::new(MemoryStore::new());
    let reference = SecretRef::primary(provider_id).expect("a valid provider id");
    store
        .set(&reference, &SecretValue::new(value))
        .expect("MemoryStore accepts a non-empty value");
    (store, reference)
}

/// The assertion this whole file is built to make.
fn assert_no_credential_on_the_wire(proxy: &RecordingProxy, label: &str) {
    assert!(
        proxy.saw_traffic(),
        "{label}: the recorder captured no request at all — the negative assertions below \
         would pass vacuously"
    );

    let offenders: Vec<String> = proxy
        .header_lines()
        .into_iter()
        .filter(|line| {
            line.starts_with("authorization:")
                || line.starts_with("x-api-key:")
                || line.starts_with("x-goog-api-key:")
                || line.starts_with("api-key:")
        })
        .collect();
    assert!(
        offenders.is_empty(),
        "{label}: Auth::None put a credential header on the wire: {offenders:?}"
    );

    let in_query: Vec<String> = proxy
        .request_targets()
        .into_iter()
        .filter(|target| target.contains("key=") || target.contains("token="))
        .collect();
    assert!(
        in_query.is_empty(),
        "{label}: Auth::None put a credential in the query string: {in_query:?}"
    );
}

// ---------------------------------------------------------------------------
// OpenAI-compatible — recorded against the live mock harness
// ---------------------------------------------------------------------------

/// The end-to-end case: a real provider, the real HTTP client, a real socket,
/// and the real mock-provider process on the far side. The turn must succeed
/// *and* the captured bytes must carry no credential.
#[tokio::test]
async fn no_credential_reaches_the_socket_when_auth_is_none() {
    let upstream = MockServer::start("mid-local").await;
    let proxy = RecordingProxy::start(Upstream::Forward(upstream.address.clone())).await;

    let provider = OpenAiCompatibleProvider::new(
        descriptor("wire-openai"),
        format!("{}/v1", proxy.url),
        Auth::None,
        Arc::new(MemoryStore::new()),
        transport(),
    );

    // Three different request shapes, so a header added on only one code path
    // cannot hide: discovery, capability probing, and a completed turn.
    provider.list_models(&context()).await.expect("listable");
    provider
        .probe_capabilities("mock-mid-local", &context())
        .await
        .expect("probeable");
    let response = provider
        .complete(
            ChatRequest::new("mock-mid-local").with_message(ChatMessage::user("hi")),
            &context(),
        )
        .await
        .expect("a no-auth endpoint is a first-class configuration");
    assert!(!response.answer_text().is_empty());

    assert_no_credential_on_the_wire(&proxy, "openai-compatible/live");
    upstream.stop().await;
}

/// The control. Identical path, one credential configured: the header must be
/// on the wire, carrying the token. Without this, the test above would pass
/// even if the recorder were blind.
#[tokio::test]
async fn a_configured_credential_does_reach_the_socket() {
    let upstream = MockServer::start("mid-local").await;
    let proxy = RecordingProxy::start(Upstream::Forward(upstream.address.clone())).await;
    let (secrets, secret) = stored_credential("wire-openai-keyed", "wire-token-value");

    let provider = OpenAiCompatibleProvider::new(
        descriptor("wire-openai-keyed"),
        format!("{}/v1", proxy.url),
        Auth::Bearer { secret },
        secrets,
        transport(),
    );
    provider
        .complete(
            ChatRequest::new("mock-mid-local").with_message(ChatMessage::user("hi")),
            &context(),
        )
        .await
        .expect("the harness accepts any non-empty bearer when it requires no key");

    assert!(
        proxy
            .header_lines()
            .iter()
            .any(|line| line == "authorization: bearer wire-token-value"),
        "the recorder must see a credential when there is one; saw {:?}",
        proxy.header_lines()
    );
    upstream.stop().await;
}

// ---------------------------------------------------------------------------
// Anthropic and Google — the header and query-string bindings
// ---------------------------------------------------------------------------

/// The Anthropic adapter binds its credential to `x-api-key`, not
/// `Authorization`, so its absence needs its own assertion.
#[tokio::test]
async fn the_anthropic_adapter_sends_no_api_key_header_when_auth_is_none() {
    let proxy = RecordingProxy::start(canned(ANTHROPIC_ANSWER)).await;
    let provider = AnthropicProvider::new(
        descriptor("wire-anthropic"),
        proxy.url.clone(),
        Auth::None,
        Arc::new(MemoryStore::new()),
        transport(),
    );

    let _ = provider
        .complete(
            ChatRequest::new("claude-x").with_message(ChatMessage::user("hi")),
            &context(),
        )
        .await;

    assert_no_credential_on_the_wire(&proxy, "anthropic");
    // The version header is unconditional; its presence proves the head was
    // captured in full rather than truncated before the credential would sit.
    assert!(
        proxy
            .header_lines()
            .iter()
            .any(|line| line.starts_with("anthropic-version:")),
        "captured {:?}",
        proxy.header_lines()
    );
}

#[tokio::test]
async fn the_anthropic_adapter_does_send_its_api_key_header_when_one_is_configured() {
    let proxy = RecordingProxy::start(canned(ANTHROPIC_ANSWER)).await;
    let (secrets, secret) = stored_credential("wire-anthropic-keyed", "sk-ant-wire");
    let provider = AnthropicProvider::new(
        descriptor("wire-anthropic-keyed"),
        proxy.url.clone(),
        Auth::ApiKeyHeader {
            header: "x-api-key".into(),
            secret,
        },
        secrets,
        transport(),
    );

    let _ = provider
        .complete(
            ChatRequest::new("claude-x").with_message(ChatMessage::user("hi")),
            &context(),
        )
        .await;

    assert!(
        proxy
            .header_lines()
            .iter()
            .any(|line| line == "x-api-key: sk-ant-wire"),
        "captured {:?}",
        proxy.header_lines()
    );
}

/// Google's binding is a query parameter, which is the one shape that would not
/// show up in a header assertion at all.
#[tokio::test]
async fn the_google_adapter_puts_no_key_in_the_query_string_when_auth_is_none() {
    let proxy = RecordingProxy::start(canned(GOOGLE_ANSWER)).await;
    let provider = GoogleProvider::new(
        descriptor("wire-google"),
        proxy.url.clone(),
        Auth::None,
        Arc::new(MemoryStore::new()),
        transport(),
    );

    let _ = provider
        .complete(
            ChatRequest::new("gemini-x").with_message(ChatMessage::user("hi")),
            &context(),
        )
        .await;

    assert_no_credential_on_the_wire(&proxy, "google");
}

#[tokio::test]
async fn the_google_adapter_does_send_its_key_when_one_is_configured() {
    let proxy = RecordingProxy::start(canned(GOOGLE_ANSWER)).await;
    let (secrets, secret) = stored_credential("wire-google-keyed", "AIza-wire");
    let provider = GoogleProvider::new(
        descriptor("wire-google-keyed"),
        proxy.url.clone(),
        Auth::ApiKeyQuery {
            param: "key".into(),
            secret,
        },
        secrets,
        transport(),
    );

    let _ = provider
        .complete(
            ChatRequest::new("gemini-x").with_message(ChatMessage::user("hi")),
            &context(),
        )
        .await;

    assert!(
        proxy
            .request_targets()
            .iter()
            .any(|target| target.contains("key=AIza-wire")),
        "captured {:?}",
        proxy.request_targets()
    );
}

// ---------------------------------------------------------------------------
// The recorder's own controls
// ---------------------------------------------------------------------------

/// The parser that makes every assertion above meaningful. If `header_lines`
/// leaked body content, a request whose *body* mentioned `authorization:` would
/// fail the negative tests for the wrong reason; if it stopped early, a real
/// header would slip past. Both directions are pinned here.
#[test]
fn the_recorder_reads_headers_and_never_reads_the_body_as_one() {
    let proxy = RecordingProxy {
        url: String::new(),
        seen: Arc::new(Mutex::new(
            concat!(
                "POST /v1/chat/completions?stream=1 HTTP/1.1\r\n",
                "host: 127.0.0.1\r\n",
                "content-type: application/json\r\n",
                "\r\n",
                "{\"messages\":[{\"role\":\"user\",\"content\":\"authorization: Bearer x\"}]}",
            )
            .as_bytes()
            .to_vec(),
        )),
    };

    assert_eq!(
        proxy.header_lines(),
        vec![
            "host: 127.0.0.1".to_string(),
            "content-type: application/json".to_string()
        ],
        "a body that quotes a header must not be read as one"
    );
    assert_eq!(
        proxy.request_targets(),
        vec!["/v1/chat/completions?stream=1".to_string()]
    );
    assert_no_credential_on_the_wire(&proxy, "recorder self-check");
}

#[test]
fn the_recorder_sees_a_header_on_a_second_keep_alive_request() {
    // Requests two and three of a keep-alive connection are where a per-retry
    // header would appear. The parser must resume at each request line.
    let proxy = RecordingProxy {
        url: String::new(),
        seen: Arc::new(Mutex::new(
            concat!(
                "GET /v1/models HTTP/1.1\r\nhost: h\r\n\r\n",
                "POST /v1/chat/completions HTTP/1.1\r\nhost: h\r\nauthorization: Bearer leaked\r\n\r\n{}",
            )
            .as_bytes()
            .to_vec(),
        )),
    };

    assert!(proxy
        .header_lines()
        .contains(&"authorization: bearer leaked".to_string()));
    assert_eq!(proxy.request_targets().len(), 2);
}
