//! INDEPENDENT CRITIC PROBE — not part of the tree under review.
//!
//! Question: does the "structural" credential redaction hold on the STREAMING
//! path, where the body is read chunk-by-chunk via `next_chunk()` and never
//! passes through `HttpResponse::read_to_end` (the only place the body scrubber
//! is applied)?

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use vela_core::credential::Auth;
use vela_core::provider::{ProviderDescriptor, ProviderKind};
use vela_core::secret::{SecretRef, SecretValue};
use vela_providers::event::CollectingSink;
use vela_providers::google::GoogleProvider;
use vela_providers::http::ReqwestTransport;
use vela_providers::openai_compatible::OpenAiCompatibleProvider;
use vela_providers::redact::percent_encode;
use vela_providers::{ChatMessage, ChatRequest, Provider, ProviderError, RequestContext, Timeouts};
use vela_secrets::{MemoryStore, SecretStore};

const CANARY: &str = "canary/AIza-9f3a7d1c5e2b4806-DO-NOT-LEAK";
const CANARY_CORE: &str = "9f3a7d1c5e2b4806";

fn renderings(error: &ProviderError) -> Vec<(&'static str, String)> {
    vec![
        ("Display", error.to_string()),
        ("Debug", format!("{error:?}")),
        ("serde JSON", serde_json::to_string(error).unwrap()),
    ]
}

#[track_caller]
fn assert_clean(label: &str, error: &ProviderError) {
    for (surface, text) in renderings(error) {
        for needle in [
            CANARY.to_owned(),
            percent_encode(CANARY),
            CANARY_CORE.to_owned(),
        ] {
            assert!(
                !text.contains(&needle),
                "{label}: credential reached {surface} (matched {needle:?}):\n  {text}"
            );
        }
    }
}

/// A 200 `text/event-stream` whose *error frame* quotes the request back —
/// exactly the shape `credential_canary.rs` calls realistic ("several vendors
/// quote the offending request back"), but delivered mid-stream instead of as a
/// non-2xx body.
async fn sse_error_echoing_the_key(frame_builder: fn(&str) -> String) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut scratch = [0u8; 8192];
            let _ = socket.read(&mut scratch).await;
            let body = frame_builder(&percent_encode(CANARY));
            let _ = socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
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

fn openai_frame(key: &str) -> String {
    format!(
        "data: {{\"error\":{{\"code\":\"invalid_api_key\",\"message\":\"Incorrect API key provided: {key} (request: /v1/chat/completions?api_key={key})\"}}}}\n\n"
    )
}

fn google_frame(key: &str) -> String {
    format!(
        "data: {{\"error\":{{\"code\":400,\"status\":\"INVALID_ARGUMENT\",\"message\":\"API key not valid: key={key} (request: /v1beta/models/m:streamGenerateContent?key={key})\"}}}}\n\n"
    )
}

fn context() -> RequestContext {
    RequestContext::new().with_timeouts(Timeouts {
        connect: Duration::from_millis(600),
        first_byte: Duration::from_millis(600),
        stall: Duration::from_millis(600),
    })
}

fn turn() -> ChatRequest {
    ChatRequest::new("canary-model").with_message(ChatMessage::user("hi"))
}

fn store(id: &str) -> (Arc<MemoryStore>, SecretRef) {
    let secrets = Arc::new(MemoryStore::new());
    let reference = SecretRef::primary(id).unwrap();
    secrets.set(&reference, &SecretValue::new(CANARY)).unwrap();
    (secrets, reference)
}

fn descriptor(id: &str) -> ProviderDescriptor {
    ProviderDescriptor::new(id, "Canary", ProviderKind::RemoteApi).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn openai_compatible_stream_error_frame_does_not_leak_the_query_credential() {
    let base = sse_error_echoing_the_key(openai_frame).await;
    let (secrets, secret) = store("probe-compat");
    let provider = OpenAiCompatibleProvider::new(
        descriptor("probe-compat"),
        &base,
        Auth::ApiKeyQuery {
            param: "api_key".into(),
            secret,
        },
        secrets,
        Arc::new(ReqwestTransport::with_connect_timeout(Duration::from_millis(600)).unwrap()),
    );

    let mut sink = CollectingSink::new();
    let error = provider
        .stream(turn(), &mut sink, &context())
        .await
        .expect_err("the stream carries an error frame");
    println!("openai-compatible stream error => {error:?}");
    assert_clean("openai-compatible / mid-stream error frame", &error);
}

#[tokio::test(flavor = "multi_thread")]
async fn google_stream_error_frame_does_not_leak_the_query_credential() {
    let base = sse_error_echoing_the_key(google_frame).await;
    let (secrets, secret) = store("probe-google");
    let provider = GoogleProvider::new(
        descriptor("probe-google"),
        &base,
        Auth::ApiKeyQuery {
            param: "key".into(),
            secret,
        },
        secrets,
        Arc::new(ReqwestTransport::with_connect_timeout(Duration::from_millis(600)).unwrap()),
    );

    let mut sink = CollectingSink::new();
    let error = provider
        .stream(turn(), &mut sink, &context())
        .await
        .expect_err("the stream carries an error frame");
    println!("google stream error => {error:?}");
    assert_clean("google / mid-stream error frame", &error);
}

/// Control: the same echo on the NON-streaming path, which the tree's own test
/// already covers. If this passes and the two above fail, the gap is exactly
/// "read_to_end scrubs, next_chunk does not".
#[tokio::test(flavor = "multi_thread")]
async fn control_non_streaming_400_echo_is_clean() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut scratch = [0u8; 8192];
            let _ = socket.read(&mut scratch).await;
            let body = format!(
                r#"{{"error":{{"code":400,"message":"API key not valid: key={}"}}}}"#,
                percent_encode(CANARY)
            );
            let _ = socket
                .write_all(
                    format!(
                        "HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await;
            let _ = socket.flush().await;
        }
    });
    let (secrets, secret) = store("probe-google-control");
    let provider = GoogleProvider::new(
        descriptor("probe-google-control"),
        format!("http://127.0.0.1:{port}"),
        Auth::ApiKeyQuery {
            param: "key".into(),
            secret,
        },
        secrets,
        Arc::new(ReqwestTransport::with_connect_timeout(Duration::from_millis(600)).unwrap()),
    );
    let error = provider.complete(turn(), &context()).await.unwrap_err();
    println!("control non-streaming => {error:?}");
    assert_clean("control / non-streaming 400 echo", &error);
}

/// DNS failure — the one failure mode the tree's canary file does not exercise
/// (it uses an unroutable IP, not an unresolvable name).
#[tokio::test(flavor = "multi_thread")]
async fn dns_failure_does_not_leak_the_query_credential() {
    let (secrets, secret) = store("probe-dns");
    let provider = GoogleProvider::new(
        descriptor("probe-dns"),
        "https://vela-canary-does-not-resolve-9f3a7d.invalid",
        Auth::ApiKeyQuery {
            param: "key".into(),
            secret,
        },
        secrets,
        Arc::new(ReqwestTransport::with_connect_timeout(Duration::from_millis(600)).unwrap()),
    );
    let error = provider.complete(turn(), &context()).await.unwrap_err();
    println!("dns failure => {error:?}");
    assert_clean("dns failure", &error);

    let mut sink = CollectingSink::new();
    let streamed = provider
        .stream(turn(), &mut sink, &context())
        .await
        .unwrap_err();
    println!("dns failure (stream) => {streamed:?}");
    assert_clean("dns failure / stream", &streamed);
}
