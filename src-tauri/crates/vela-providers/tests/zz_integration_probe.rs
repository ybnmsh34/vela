//! Integration probe: the fourth adapter, and the decode nobody drove.
//!
//! `encoded_credential_canary.rs` drives OpenAiCompatible, Anthropic and
//! Google. `CompatProvider` is a **fourth** shipping adapter — the one that
//! serves llama.cpp, Ollama, LM Studio and vLLM, i.e. the configuration Vela
//! exists for — and it is the only one that puts a `serde_json` **decode and
//! re-encode** (`normalise_error_body`) between the byte scrub and the
//! `UpstreamBytes` decode chokepoint.

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use vela_core::credential::Auth;
use vela_core::provider::{ProviderDescriptor, ProviderKind};
use vela_core::secret::{SecretRef, SecretValue};
use vela_providers::event::CollectingSink;
use vela_providers::{
    ChatMessage, ChatRequest, CompatOptions, CompatProvider, Provider, ProviderError,
    RequestContext, Timeouts,
};
use vela_secrets::{MemoryStore, SecretStore};

const CANARY: &str = "sk/vela-probe4/Ky-7d41c0f9ab63e2/DO-NOT-LEAK";
const CANARY_CORE: &str = "7d41c0f9ab63e2";
const MARKER: &str = "VELA-PROBE-MARKER";

/// PHP `json_encode` default flags: `/` becomes `\/`.
fn solidus(text: &str) -> String {
    text.replace('\\', "\\\\").replace('"', "\\\"").replace('/', "\\/")
}

/// vLLM's error shape — deliberately NOT the canonical one, so
/// `normalise_error_body` actually rewrites it rather than returning `None`.
/// That rewrite is the decode/re-encode step under test.
async fn vllm_style_echo_server() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a free port");
    let port = listener.local_addr().expect("bound").port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut scratch = vec![0u8; 16384];
            let read = socket.read(&mut scratch).await.unwrap_or(0);
            let raw = String::from_utf8_lossy(&scratch[..read]).into_owned();

            let mut credential = String::from("none");
            for line in raw.split("\r\n").skip(1) {
                if line.is_empty() {
                    break;
                }
                if let Some((name, value)) = line.split_once(':') {
                    if name.trim().eq_ignore_ascii_case("authorization") {
                        credential = value.trim().to_owned();
                    }
                }
            }
            let message = format!("{MARKER}: rejected credential [{credential}]");
            // vLLM/FastAPI shape: no `error` object, message at the top level.
            let body = format!(
                "{{\"object\":\"error\",\"message\":\"{}\",\"type\":\"BadRequestError\",\"code\":400}}",
                solidus(&message)
            );
            let _ = socket
                .write_all(
                    format!(
                        "HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\n\
                         content-length: {}\r\nconnection: close\r\n\r\n{body}",
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

fn build(base_url: &str) -> CompatProvider {
    let id = "compat-encoded-probe";
    let secrets: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    let secret = SecretRef::primary(id).expect("a valid provider id");
    secrets
        .set(&secret, &SecretValue::new(CANARY))
        .expect("MemoryStore accepts a non-empty value");
    let transport = Arc::new(
        vela_providers::http::ReqwestTransport::with_connect_timeout(Duration::from_millis(300))
            .expect("the client builds"),
    );
    CompatProvider::new(
        ProviderDescriptor::new(id, "Compat encoded probe", ProviderKind::Local)
            .expect("a valid descriptor"),
        base_url,
        Auth::Bearer { secret },
        secrets,
        transport,
    )
    .with_options(CompatOptions {
        discover_before_first_turn: false,
        ..CompatOptions::default()
    })
}

fn context() -> RequestContext {
    RequestContext::new().with_timeouts(Timeouts {
        connect: Duration::from_millis(300),
        first_byte: Duration::from_millis(500),
        stall: Duration::from_millis(500),
    })
}

fn turn() -> ChatRequest {
    ChatRequest::new("canary-model").with_message(ChatMessage::user("hi"))
}

#[track_caller]
fn assert_clean(label: &str, error: &ProviderError, sink: &CollectingSink) {
    let mut surfaces = vec![
        ("Display", error.to_string()),
        ("Debug", format!("{error:?}")),
        (
            "serde JSON (IPC wire shape)",
            serde_json::to_string(error).expect("serialises"),
        ),
    ];
    for event in &sink.events {
        surfaces.push((
            "StreamEvent",
            serde_json::to_string(event).expect("serialises"),
        ));
    }
    for (surface, text) in surfaces {
        for needle in [CANARY, CANARY_CORE] {
            assert!(
                !text.contains(needle),
                "{label}: the credential reached {surface} (matched {needle:?}):\n  {text}"
            );
        }
    }
}

#[tokio::test]
async fn the_compat_adapter_normalise_and_reencode_step_does_not_reconstitute_the_credential() {
    let base_url = vllm_style_echo_server().await;
    let provider = build(&base_url);

    let error = provider
        .complete(turn(), &context())
        .await
        .expect_err("the peer rejects the credential on purpose");
    println!("complete() -> {error:?}");
    assert_clean("compat/complete", &error, &CollectingSink::new());

    let mut sink = CollectingSink::new();
    let streamed = provider.stream(turn(), &mut sink, &context()).await;
    let error = streamed.expect_err("the peer rejects the credential on purpose");
    println!("stream()   -> {error:?}");
    assert_clean("compat/stream", &error, &sink);
}

/// The vacuity guard: the peer's own diagnosis must survive, or the test above
/// would pass on an empty error.
#[tokio::test]
async fn the_peers_message_really_did_reach_the_error() {
    let base_url = vllm_style_echo_server().await;
    let provider = build(&base_url);
    let error = provider
        .complete(turn(), &context())
        .await
        .expect_err("the peer rejects");
    let rendered = error.to_string();
    assert!(
        rendered.contains(MARKER),
        "the endpoint's own diagnosis was deleted rather than redacted: {rendered}"
    );
}

/// The premise: the escaping peer leaves **no literal copy** of the credential
/// on the wire, so a byte-literal scrub genuinely has nothing to match and the
/// test above is about the decode rather than about the bytes.
#[test]
fn the_peer_really_does_encode() {
    let escaped = solidus(&format!("rejected credential [Bearer {CANARY}]"));
    assert!(
        !escaped.contains(CANARY),
        "the peer left a literal copy; the probe would prove nothing: {escaped}"
    );
    assert!(escaped.contains("sk\\/vela-probe4"), "escaped: {escaped}");
}
