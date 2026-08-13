//! **GATE M Part 1, Phase B, round 3 — the executor's own probe.**
//!
//! Written by the gate executor, who wrote neither the round-2 nor the round-3
//! fix. It exists to attack three claims rather than to restate them, and it
//! uses its **own canary literal**, so a fix that happened to special-case the
//! string in `streamed_credential_canary.rs` would not pass here.
//!
//! # 1. The structural claim: "an unscrubbed read is not expressible"
//!
//! The round-3 change removed `ByteStream::scrubber()` and made [`BodyStream`] a
//! struct that seals the raw stream. The compile-time half of that claim is
//! pinned by two `compile_fail` doctests on `BodyStream` and, independently, by
//! the executor's own five probes in
//! `docs/regression-baseline/phase-b-matrix/structural/`, compiled against the
//! real crate by `probe.sh` there.
//!
//! The **runtime** half is here: [`LaunderingTransport`] is the worst decorator
//! this executor could write against the current API. It wraps the real
//! transport, wraps the real body in a `ByteStream` that forwards *nothing*, and
//! then re-wraps that with `BodyOrigin::carries_no_credential()` — an origin
//! that actively asserts there is no secret to remove. Under round 2's shape
//! this was enough to disable redaction completely; it is exactly what happened
//! to the gate's own recorder mid-run. Here it must change nothing, because the
//! sealed body has already scrubbed before the decorator can observe a byte —
//! and [`what_the_decorator_itself_saw`] asserts precisely that, on the
//! decorator's own tee rather than on the error at the end of the pipeline.
//!
//! # 2. The premise, per adapter
//!
//! `streamed_credential_canary.rs` proves the endpoint really echoed the
//! credential for **Google/Query** only
//! (`a_redacted_message_keeps_its_diagnosis_and_loses_only_the_secret`). Its
//! wide matrix counts cases, not echoes, so for the other five adapter/binding
//! pairs "no leak" and "the endpoint never sent one" are not distinguished.
//! [`every_adapter_really_was_echoed_a_credential_and_really_redacted_it`]
//! closes that: for each of the three adapters it asserts the marker survived
//! (a diagnosis) *and* `<redacted>` is present (there was a secret to remove)
//! *and* the canary is gone (it was removed).
//!
//! # 3. Over-redaction: three candidates must be tellable apart
//!
//! [`three_configured_candidates_produce_three_distinguishable_errors`] is the
//! user-facing form of the regression critic's complaint: it is not enough that
//! *an* endpoint is named, the three errors must differ from each other.
//!
//! # Honesty (conventions.md §10)
//!
//! **VERIFIED-BY-FAKE.** `MemoryStore` and deliberately broken loopback
//! sockets. No model produced any byte here, and nothing here is evidence about
//! the OS keychain or a real endpoint.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use vela_core::credential::Auth;
use vela_core::provider::{ProviderDescriptor, ProviderKind};
use vela_core::secret::{SecretRef, SecretValue};
use vela_providers::event::{CollectingSink, StreamEvent};
use vela_providers::http::{
    BodyOrigin, BodyStream, ByteStream, HttpRequest, HttpResponse, HttpTransport, ReqwestTransport,
    TransportError,
};
use vela_providers::redact::percent_encode;
use vela_providers::{
    AnthropicProvider, ChatMessage, ChatRequest, GoogleProvider, OpenAiCompatibleProvider,
    Provider, ProviderError, RequestContext, Timeouts,
};
use vela_secrets::{MemoryStore, SecretStore};

/// The executor's own literal, deliberately unlike the two already in the tree.
/// Contains `/` and `+` so its raw and percent-encoded forms differ.
const CANARY: &str = "vela+exec3/Zq-8b17d0e5c4a93f26-DO-NOT-LEAK";
/// The half that percent-encoding leaves alone, so a *partial* leak — a key cut
/// by `detail()`'s truncation or by a chunk boundary — fails too.
const CANARY_CORE: &str = "8b17d0e5c4a93f26";
/// Carries no secret, so it must SURVIVE. This is how the file tells a
/// redaction apart from a deletion.
const MARKER: &str = "VELA-EXECUTOR-MARKER";

fn needles() -> Vec<String> {
    vec![
        CANARY.to_owned(),
        percent_encode(CANARY),
        CANARY_CORE.to_owned(),
    ]
}

#[track_caller]
fn assert_clean(label: &str, surface: &str, text: &str) {
    for needle in needles() {
        assert!(
            !text.contains(&needle),
            "{label}: the credential reached {surface} (matched {needle:?}):\n  {text}"
        );
    }
}

/// All four surfaces the gate cares about: `Display`, `Debug`, the serde JSON
/// that would cross the IPC bridge, and every event handed to the sink.
#[track_caller]
fn assert_every_surface_is_clean(label: &str, error: &ProviderError, sink: &CollectingSink) {
    assert_clean(label, "Display", &error.to_string());
    assert_clean(label, "Debug", &format!("{error:?}"));
    assert_clean(label, "Debug (alternate)", &format!("{error:#?}"));
    assert_clean(
        label,
        "serde JSON (the IPC wire shape)",
        &serde_json::to_string(error).expect("ProviderError serialises"),
    );
    // Both serde renderings: a pretty-printer that inserted a newline inside a
    // credential would defeat a compact-only check.
    assert_clean(
        label,
        "serde JSON (pretty)",
        &serde_json::to_string_pretty(error).expect("ProviderError serialises"),
    );
    for event in &sink.events {
        assert_clean(
            label,
            "StreamEvent (the sink the UI reads)",
            &serde_json::to_string(event).expect("StreamEvent serialises"),
        );
        assert_clean(label, "StreamEvent (Debug)", &format!("{event:?}"));
    }
}

// ---------------------------------------------------------------------------
// The hostile decorator
// ---------------------------------------------------------------------------

/// A decorating body that forwards **nothing** — no scrubber, no origin, no
/// knowledge of any kind — and tees every byte it manages to see.
///
/// This is the round-2 recorder bug written on purpose. Under that API it
/// disabled the redaction of the body it wrapped; under this one it cannot,
/// because `inner` is a [`BodyStream`] and `BodyStream::next_chunk` is the only
/// door bytes leave by.
struct ForwardsNothing {
    inner: BodyStream,
    saw: Arc<Mutex<Vec<u8>>>,
}

#[async_trait]
impl ByteStream for ForwardsNothing {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
        let out = self.inner.next_chunk().await;
        if let Ok(Some(chunk)) = &out {
            self.saw
                .lock()
                .expect("not poisoned")
                .extend_from_slice(chunk);
        }
        out
    }
}

/// Wraps the real transport and launders every response body through
/// [`ForwardsNothing`], re-wrapping it with an origin that **claims there is no
/// credential**. The strongest bypass the current API permits.
struct LaunderingTransport {
    inner: ReqwestTransport,
    saw: Arc<Mutex<Vec<u8>>>,
}

impl LaunderingTransport {
    fn new(saw: Arc<Mutex<Vec<u8>>>) -> Self {
        Self {
            inner: ReqwestTransport::with_connect_timeout(Duration::from_millis(300))
                .expect("the client builds"),
            saw,
        }
    }
}

#[async_trait]
impl HttpTransport for LaunderingTransport {
    async fn send(
        &self,
        request: HttpRequest,
        timeouts: &Timeouts,
    ) -> Result<HttpResponse, TransportError> {
        let response = self.inner.send(request, timeouts).await?;
        Ok(HttpResponse {
            status: response.status,
            headers: response.headers,
            body: BodyStream::new(
                ForwardsNothing {
                    inner: response.body,
                    saw: Arc::clone(&self.saw),
                },
                // The lie: this body answers a request that carried a
                // credential in its query string, and this origin says it did
                // not. It must not matter.
                BodyOrigin::carries_no_credential(),
            ),
        })
    }
}

// ---------------------------------------------------------------------------
// An endpoint that quotes the request — credential included — back at Vela
// ---------------------------------------------------------------------------

/// A 200 whose SSE body is an `{"error": …}` object naming the request target.
/// Nothing in any error path runs: the exchange succeeded, and the failure is
/// inside bytes read through `next_chunk`. That is FINDING 2's shape.
async fn echoing_endpoint() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a free port");
    let port = listener.local_addr().expect("bound").port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut scratch = vec![0u8; 16384];
            let read = socket.read(&mut scratch).await.unwrap_or(0);
            let raw = String::from_utf8_lossy(&scratch[..read]).into_owned();
            let target = raw
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or("/")
                .to_owned();
            // Header credentials get quoted back too — the header binding is a
            // leak path of its own, and round 2 never drove it.
            let headers: Vec<String> = raw
                .lines()
                .skip(1)
                .filter(|line| {
                    let lower = line.to_ascii_lowercase();
                    lower.starts_with("authorization:")
                        || lower.starts_with("x-api-key:")
                        || lower.starts_with("x-goog-api-key:")
                })
                .map(|line| {
                    line.split_once(':')
                        .map(|(_, value)| value.trim().to_owned())
                        .unwrap_or_default()
                })
                .collect();
            let message = format!(
                "{MARKER}: invalid credential for request {target} (headers: {})",
                if headers.is_empty() {
                    "none".to_owned()
                } else {
                    headers.join(" ")
                }
            );
            let escaped = message.replace('\\', "\\\\").replace('"', "\\\"");
            let anthropic = target.contains("/messages");
            // Answer in the shape the request asked for. Serving SSE to a
            // non-streaming call makes `complete()` fail on "not JSON" before
            // it ever reads the endpoint's message — which is the mock lying,
            // not Vela losing a diagnosis. (The first draft of this file did
            // exactly that and failed itself.)
            let streaming = raw.contains("\"stream\":true")
                || raw.contains("alt=sse")
                || target.contains("streamGenerateContent");
            let object = if anthropic {
                format!(
                    "{{\"type\":\"error\",\"error\":{{\"type\":\"invalid_request_error\",\"message\":\"{escaped}\"}}}}"
                )
            } else {
                format!(
                    "{{\"error\":{{\"code\":\"invalid_api_key\",\"status\":\"INVALID_ARGUMENT\",\"message\":\"{escaped}\"}}}}"
                )
            };
            let (content_type, body) = if streaming {
                let frame = if anthropic {
                    format!("event: error\ndata: {object}\n\n")
                } else {
                    format!("data: {object}\n\n")
                };
                ("text/event-stream", frame)
            } else {
                ("application/json", object)
            };
            let _ = socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
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

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Adapter {
    OpenAiCompatible,
    Anthropic,
    Google,
}

impl Adapter {
    const ALL: [Adapter; 3] = [
        Adapter::OpenAiCompatible,
        Adapter::Anthropic,
        Adapter::Google,
    ];
}

fn keyed(adapter: Adapter, base_url: &str, transport: Arc<dyn HttpTransport>) -> Arc<dyn Provider> {
    let id = format!("exec-probe-{adapter:?}").to_ascii_lowercase();
    let secrets: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    let secret = SecretRef::primary(&id).expect("a valid provider id");
    secrets
        .set(&secret, &SecretValue::new(CANARY))
        .expect("MemoryStore accepts a non-empty value");
    // The query binding on every adapter: it is the one that puts the
    // credential inside the URL, which is the shape a header-only redaction is
    // blind to by construction.
    let auth = Auth::ApiKeyQuery {
        param: if adapter == Adapter::Google {
            "key".into()
        } else {
            "api_key".into()
        },
        secret,
    };
    let descriptor = ProviderDescriptor::new(&id, "Executor probe", ProviderKind::RemoteApi)
        .expect("a valid descriptor");
    match adapter {
        Adapter::OpenAiCompatible => Arc::new(OpenAiCompatibleProvider::new(
            descriptor, base_url, auth, secrets, transport,
        )),
        Adapter::Anthropic => Arc::new(AnthropicProvider::new(
            descriptor, base_url, auth, secrets, transport,
        )),
        Adapter::Google => Arc::new(GoogleProvider::new(
            descriptor, base_url, auth, secrets, transport,
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
    ChatRequest::new("exec-probe-model").with_message(ChatMessage::user("hi"))
}

fn real_transport() -> Arc<dyn HttpTransport> {
    Arc::new(
        ReqwestTransport::with_connect_timeout(Duration::from_millis(300))
            .expect("the client builds"),
    )
}

// ---------------------------------------------------------------------------
// 1. THE STRUCTURAL CLAIM, at runtime
// ---------------------------------------------------------------------------

/// The decorator's own tee, which is the only place this can be observed
/// honestly: not "the error came out clean", but "the bytes were **already**
/// clean when the most hostile decorator this API permits first touched them".
#[tokio::test(flavor = "multi_thread")]
async fn what_the_decorator_itself_saw() {
    let base_url = echoing_endpoint().await;
    let saw: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let provider = keyed(
        Adapter::OpenAiCompatible,
        &base_url,
        Arc::new(LaunderingTransport::new(Arc::clone(&saw))),
    );

    let mut sink = CollectingSink::new();
    let error = provider
        .stream(turn(), &mut sink, &context())
        .await
        .expect_err("the stream carries an error object");

    let observed = String::from_utf8_lossy(&saw.lock().expect("not poisoned")).into_owned();

    assert!(
        !observed.is_empty(),
        "the decorator saw no bytes at all, so it proves nothing"
    );
    assert!(
        observed.contains(MARKER),
        "the decorator must have seen the endpoint's message, or the wrong \
         bytes are being inspected: {observed}"
    );
    assert!(
        observed.contains("<redacted>"),
        "THE PREMISE: the endpoint echoed a credential and it was replaced \
         before the decorator could see it. Without this marker the body might \
         simply never have carried one: {observed}"
    );
    assert_clean(
        "laundering decorator",
        "the bytes the decorator itself read",
        &observed,
    );
    assert_every_surface_is_clean("laundering decorator", &error, &sink);
}

/// The same laundering transport, on all three adapters, end to end.
///
/// A decorator that forwards nothing and claims `carries_no_credential()` must
/// produce byte-identical safety to no decorator at all.
#[tokio::test(flavor = "multi_thread")]
async fn a_decorator_that_forwards_nothing_and_lies_about_its_origin_changes_nothing() {
    let mut checked = 0usize;
    for adapter in Adapter::ALL {
        let base_url = echoing_endpoint().await;
        let saw = Arc::new(Mutex::new(Vec::new()));

        let laundered = keyed(
            adapter,
            &base_url,
            Arc::new(LaunderingTransport::new(Arc::clone(&saw))),
        );
        let mut laundered_sink = CollectingSink::new();
        let laundered_error = laundered
            .stream(turn(), &mut laundered_sink, &context())
            .await
            .expect_err("the stream carries an error object");

        let plain = keyed(adapter, &base_url, real_transport());
        let mut plain_sink = CollectingSink::new();
        let plain_error = plain
            .stream(turn(), &mut plain_sink, &context())
            .await
            .expect_err("the stream carries an error object");

        let label = format!("{adapter:?} · laundered");
        assert_every_surface_is_clean(&label, &laundered_error, &laundered_sink);
        assert_every_surface_is_clean(&format!("{adapter:?} · plain"), &plain_error, &plain_sink);
        assert_eq!(
            laundered_error.to_string(),
            plain_error.to_string(),
            "{label}: the decorator changed the outcome, which means it \
             changed what was readable"
        );
        assert!(
            laundered_error.to_string().contains("<redacted>"),
            "{label}: THE PREMISE — a credential was echoed and removed: {laundered_error}"
        );
        checked += 1;
    }
    assert_eq!(checked, 3, "the adapter loop did not run");
}

// ---------------------------------------------------------------------------
// 2. THE PREMISE, PER ADAPTER
// ---------------------------------------------------------------------------

/// Closes the vacuity gap in the wide matrix: for each adapter, assert the echo
/// was **real** (the redaction marker is present, so there was a secret in the
/// text) and the diagnosis **survived** (the marker the endpoint planted is
/// still there), as well as that the canary is gone.
#[tokio::test(flavor = "multi_thread")]
async fn every_adapter_really_was_echoed_a_credential_and_really_redacted_it() {
    let mut checked = 0usize;
    for adapter in Adapter::ALL {
        let base_url = echoing_endpoint().await;
        let provider = keyed(adapter, &base_url, real_transport());

        // Both transports: `complete()` reads the body whole, `stream()` reads
        // it chunk by chunk. The difference is what hid FINDING 2 twice.
        let mut sink = CollectingSink::new();
        let streamed = provider
            .stream(turn(), &mut sink, &context())
            .await
            .expect_err("the stream carries an error object");
        let completed = provider
            .complete(turn(), &context())
            .await
            .expect_err("the same endpoint through the non-streamed path");

        for (path, error, sink) in [
            ("stream()", &streamed, Some(&sink)),
            ("complete()", &completed, None),
        ] {
            let label = format!("{adapter:?} · {path}");
            let rendered = error.to_string();
            let empty = CollectingSink::new();
            assert_every_surface_is_clean(&label, error, sink.unwrap_or(&empty));
            assert!(
                rendered.contains(MARKER),
                "{label}: the endpoint's diagnosis must survive redaction: {rendered}"
            );
            assert!(
                rendered.contains("<redacted>"),
                "{label}: THE PREMISE — without this the endpoint may simply \
                 never have been sent a credential: {rendered}"
            );
            checked += 1;
        }

        // The sink is a surface of its own and must have carried the failure,
        // or the sink assertions above pass on an empty list.
        assert!(
            sink.events
                .iter()
                .any(|event| matches!(event, StreamEvent::Error { .. })),
            "{adapter:?}: no error reached the sink, so the sink surface is vacuous"
        );
    }
    assert_eq!(checked, 6, "the adapter × transport loop did not run");
}

// ---------------------------------------------------------------------------
// 3. OVER-REDACTION: three candidates must be tellable apart
// ---------------------------------------------------------------------------

/// The user-facing form of the round-2 regression: a machine with three
/// configured candidates, one of them down. Naming *an* endpoint is not enough
/// — the three errors have to differ from each other, or the user still cannot
/// tell which candidate failed.
#[tokio::test(flavor = "multi_thread")]
async fn three_configured_candidates_produce_three_distinguishable_errors() {
    let mut messages = Vec::new();
    let mut authorities = Vec::new();

    for _ in 0..3 {
        // A port that was bound to learn a free number, then released.
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("a free port");
        let address = listener.local_addr().expect("bound");
        drop(listener);
        let base_url = format!("http://{address}");
        authorities.push(address.to_string());

        let provider = keyed(Adapter::OpenAiCompatible, &base_url, real_transport());
        let error = provider
            .complete(turn(), &context())
            .await
            .expect_err("nothing is listening");
        messages.push(error.to_string());
    }

    for (message, authority) in messages.iter().zip(&authorities) {
        assert!(
            message.contains(authority),
            "the error must name the candidate that failed: {message:?} \
             (looking for {authority:?})"
        );
        assert!(
            message.contains("<redacted>"),
            "the key must be redacted IN the named URL, not absent from it: {message}"
        );
        assert_clean("three candidates", "Display", message);
    }
    assert_ne!(
        messages[0], messages[1],
        "candidates 1 and 2 are the same message"
    );
    assert_ne!(
        messages[1], messages[2],
        "candidates 2 and 3 are the same message"
    );
    assert_ne!(
        messages[0], messages[2],
        "candidates 1 and 3 are the same message"
    );
}

/// **The control for the test above.** Round 2's behaviour, reconstructed: an
/// endpoint-free message. Three candidates, three identical strings, nothing to
/// choose between them. If the assertions above ever stop being able to fail,
/// this is what they would be failing to detect.
#[test]
fn control_round_two_shaped_messages_are_indistinguishable() {
    let round_two = ["error sending request"; 3];
    assert_eq!(
        round_two[0], round_two[1],
        "the control must reproduce the defect"
    );
    assert!(
        !round_two[0].contains("127.0.0.1"),
        "round 2's message named no endpoint — that is the defect"
    );
}
