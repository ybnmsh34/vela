//! **GATE M Part 1, Phase B — FINDING 2's regression recipe, verbatim.**
//!
//! `docs/regression-baseline/phase-b-matrix/RESULTS.md` §4 states the recipe in
//! three parts and records that *"each part fails against the tree as it
//! stands"*. This file is those three parts and nothing else, deliberately
//! written against **only the API the round-2 tree already had**, so it
//! compiles unchanged on either side of the fix and the red-then-green can be
//! demonstrated rather than described.
//!
//! > 1. A 200 SSE body whose only frame is `{"error":{"message":"… ?key=<canary> …"}}`,
//! >    through `provider.stream(…)`, on `OpenAiCompatibleProvider` with
//! >    `Auth::ApiKeyQuery` → the canary must appear in **none** of `Display`,
//! >    `Debug`, `serde_json`, or any `StreamEvent` reaching the sink.
//! > 2. The same, on `GoogleProvider` (whose only binding is `?key=`) and on
//! >    `AnthropicProvider` with `Auth::ApiKeyHeader` — the header binding puts
//! >    needles in the scrubber too, so it should be covered by the same fix.
//! > 3. A positive control on the identical path with `Auth::None`, asserting
//! >    the error still carries the endpoint's message, so the fix is a
//! >    redaction and not a blanket "drop the detail".
//!
//! The broader matrix — seven forced failures, three adapters, two bindings,
//! two transports, with its own positive controls — lives in
//! `streamed_credential_canary.rs`. This file is kept small and separate
//! precisely so it stays runnable against an older tree.
//!
//! **VERIFIED-BY-FAKE** (conventions §10): `MemoryStore` and a loopback mock.

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use vela_core::credential::Auth;
use vela_core::provider::{ProviderDescriptor, ProviderKind};
use vela_core::secret::{SecretRef, SecretValue};
use vela_providers::event::CollectingSink;
use vela_providers::http::ReqwestTransport;
use vela_providers::redact::percent_encode;
use vela_providers::{
    AnthropicProvider, ChatMessage, ChatRequest, GoogleProvider, OpenAiCompatibleProvider,
    Provider, ProviderError, RequestContext, Timeouts,
};
use vela_secrets::{MemoryStore, SecretStore};

const CANARY: &str = "vela+recipe/Kx-1d4f90ac7e35b28c-DO-NOT-LEAK";
const CANARY_CORE: &str = "1d4f90ac7e35b28c";
/// Carries no secret, so it must survive: part 3 is about telling a redaction
/// apart from a deletion.
const MARKER: &str = "VELA-RECIPE-MARKER";

fn needles() -> Vec<String> {
    vec![
        CANARY.to_owned(),
        percent_encode(CANARY),
        CANARY_CORE.to_owned(),
    ]
}

/// All four surfaces the recipe names.
fn surfaces(error: &ProviderError, sink: &CollectingSink) -> Vec<(String, String)> {
    let mut out = vec![
        ("Display".to_owned(), error.to_string()),
        ("Debug".to_owned(), format!("{error:?}")),
        (
            "serde_json".to_owned(),
            serde_json::to_string(error).expect("serialises"),
        ),
    ];
    for (index, event) in sink.events.iter().enumerate() {
        out.push((
            format!("StreamEvent[{index}]"),
            serde_json::to_string(event).expect("serialises"),
        ));
    }
    out
}

#[track_caller]
fn assert_no_canary(label: &str, error: &ProviderError, sink: &CollectingSink) {
    for (surface, text) in surfaces(error, sink) {
        for needle in needles() {
            assert!(
                !text.contains(&needle),
                "{label}: the credential reached {surface} (matched {needle:?}):\n  {text}"
            );
        }
    }
}

/// A 200 `text/event-stream` whose only frame is an error object quoting the
/// request target — and, for the header binding, the credential header — back.
async fn echoing_stream() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a free port");
    let port = listener.local_addr().expect("bound").port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut scratch = vec![0u8; 16384];
            let read = socket.read(&mut scratch).await.unwrap_or(0);
            let raw = String::from_utf8_lossy(&scratch[..read]).into_owned();

            let mut lines = raw.split("\r\n");
            let target = lines
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or("/")
                .to_owned();
            let mut credentials = Vec::new();
            for line in lines {
                if line.is_empty() {
                    break;
                }
                if let Some((name, value)) = line.split_once(':') {
                    if matches!(
                        name.trim().to_ascii_lowercase().as_str(),
                        "authorization" | "x-api-key" | "api-key" | "x-goog-api-key"
                    ) {
                        credentials.push(value.trim().to_owned());
                    }
                }
            }

            let message = format!(
                "{MARKER}: API key not valid for request {target} (headers: {})",
                if credentials.is_empty() {
                    "none".to_owned()
                } else {
                    credentials.join(" ")
                }
            );
            let escaped = message.replace('\\', "\\\\").replace('"', "\\\"");

            let body = if target.contains("/v1/messages") {
                format!("event: error\ndata: {{\"type\":\"error\",\"error\":{{\"type\":\"invalid_request_error\",\"message\":\"{escaped}\"}}}}\n\n")
            } else {
                format!("data: {{\"error\":{{\"code\":400,\"status\":\"INVALID_ARGUMENT\",\"message\":\"{escaped}\"}}}}\n\n")
            };

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

fn descriptor(id: &str) -> ProviderDescriptor {
    ProviderDescriptor::new(id, "Recipe", ProviderKind::RemoteApi).expect("a valid descriptor")
}

fn planted(id: &str) -> (Arc<dyn SecretStore>, SecretRef) {
    let secrets: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    let secret = SecretRef::primary(id).expect("a valid provider id");
    secrets
        .set(&secret, &SecretValue::new(CANARY))
        .expect("MemoryStore accepts a non-empty value");
    (secrets, secret)
}

fn transport() -> Arc<ReqwestTransport> {
    Arc::new(
        ReqwestTransport::with_connect_timeout(Duration::from_millis(500)).expect("client builds"),
    )
}

fn context() -> RequestContext {
    RequestContext::new().with_timeouts(Timeouts {
        connect: Duration::from_millis(500),
        first_byte: Duration::from_millis(500),
        stall: Duration::from_millis(500),
    })
}

fn turn() -> ChatRequest {
    ChatRequest::new("recipe-model").with_message(ChatMessage::user("hi"))
}

async fn stream_it(provider: Arc<dyn Provider>) -> (ProviderError, CollectingSink) {
    let mut sink = CollectingSink::new();
    let error = provider
        .stream(turn(), &mut sink, &context())
        .await
        .expect_err("the 200 stream carries an error object");
    (error, sink)
}

/// **Part 1.** OpenAI-compatible, `Auth::ApiKeyQuery`, a 200 whose only frame is
/// an error object quoting the request target.
#[tokio::test(flavor = "multi_thread")]
async fn part_1_openai_compatible_with_a_query_key() {
    let base = echoing_stream().await;
    let (secrets, secret) = planted("recipe-compat");
    let provider: Arc<dyn Provider> = Arc::new(OpenAiCompatibleProvider::new(
        descriptor("recipe-compat"),
        &base,
        Auth::ApiKeyQuery {
            param: "api_key".into(),
            secret,
        },
        secrets,
        transport(),
    ));

    let (error, sink) = stream_it(provider).await;
    println!("part 1 (openai-compatible, ?api_key=) => {error:?}");
    assert_no_canary("part 1", &error, &sink);
}

/// **Part 2a.** Google, whose only binding is `?key=`.
#[tokio::test(flavor = "multi_thread")]
async fn part_2a_google_with_its_only_binding() {
    let base = echoing_stream().await;
    let (secrets, secret) = planted("recipe-google");
    let provider: Arc<dyn Provider> = Arc::new(GoogleProvider::new(
        descriptor("recipe-google"),
        &base,
        Auth::ApiKeyQuery {
            param: "key".into(),
            secret,
        },
        secrets,
        transport(),
    ));

    let (error, sink) = stream_it(provider).await;
    println!("part 2a (google, ?key=) => {error:?}");
    assert_no_canary("part 2a", &error, &sink);
}

/// **Part 2b.** Anthropic with `Auth::ApiKeyHeader` — the header binding puts
/// needles in the scrubber too, and the endpoint echoes the header back.
#[tokio::test(flavor = "multi_thread")]
async fn part_2b_anthropic_with_a_header_key() {
    let base = echoing_stream().await;
    let (secrets, secret) = planted("recipe-anthropic");
    let provider: Arc<dyn Provider> = Arc::new(AnthropicProvider::new(
        descriptor("recipe-anthropic"),
        &base,
        Auth::ApiKeyHeader {
            header: "x-api-key".into(),
            secret,
        },
        secrets,
        transport(),
    ));

    let (error, sink) = stream_it(provider).await;
    println!("part 2b (anthropic, x-api-key) => {error:?}");
    assert_no_canary("part 2b", &error, &sink);
}

/// **Part 3 — the positive control.** The identical path with `Auth::None`. The
/// error must still carry the endpoint's own message, so the fix is a redaction
/// and not a blanket "drop the detail".
#[tokio::test(flavor = "multi_thread")]
async fn part_3_auth_none_keeps_the_endpoints_message() {
    let base = echoing_stream().await;
    let secrets: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    let provider: Arc<dyn Provider> = Arc::new(OpenAiCompatibleProvider::new(
        descriptor("recipe-none"),
        &base,
        Auth::None,
        secrets,
        transport(),
    ));

    let (error, _sink) = stream_it(provider).await;
    println!("part 3 (Auth::None) => {error:?}");

    let rendered = error.to_string();
    assert!(
        rendered.contains(MARKER),
        "the endpoint's own message must survive when nothing is secret: {rendered}"
    );
    assert!(
        rendered.contains("/v1/chat/completions"),
        "and so must the request target it quoted: {rendered}"
    );
    assert!(
        !rendered.contains("<redacted>"),
        "nothing was secret, so nothing may be redacted: {rendered}"
    );
}
