//! INTEGRATION PROBE — Phase B round 4, written by the integration agent while
//! reconciling the redirect/egress builder's work with the encoding-aware
//! redaction builder's.
//!
//! # The gap this closes
//!
//! `encoded_credential_canary.rs` drives three adapters: `OpenAiCompatible`,
//! `Anthropic`, `Google`. Vela ships a **fourth** — [`CompatProvider`] — and it
//! is the one that serves llama.cpp, Ollama, LM Studio and vLLM, i.e. the
//! configuration the whole product exists for. Neither builder drove it,
//! because neither builder's defect lived there.
//!
//! It matters here for a reason specific to the *assembly*. `CompatProvider` is
//! the only adapter that wraps its transport in a [`NormalisingTransport`], and
//! that decorator does something no other path does: it takes bytes that have
//! already left `BodyStream::next_chunk`, hands them to `serde_json` for a
//! **decode**, rewrites the message, and `serde_json::to_vec`s the result back
//! into a new body. A decode-and-re-encode sitting between the two barriers is
//! exactly the shape round 4's defect had — a credential spelled one way on the
//! wire and another way after a decoder ran — so "the two builders' fixes hold
//! at once" is not a claim that can be made about this tree without driving it.
//!
//! # What is measured
//!
//! A real loopback peer answering in **vLLM's** error shape — deliberately not
//! the canonical one, so `normalise_error_body` actually rewrites it rather
//! than returning `None` and leaving the bytes alone — with the echoed
//! credential spelled the way PHP's `json_encode` spells it (`sk\/x\/KEY`).
//! Real `ReqwestTransport`, real provider, `complete()` and `stream()`, across
//! `Display`, `Debug`, the serde JSON that crosses the IPC bridge, and the
//! `StreamEvent` sink the UI reads.
//!
//! # The result, and why it is structural rather than lucky
//!
//! It holds, and it holds at the first barrier: `Scrubber::scrub_bytes` is
//! itself encoding-aware (`replace_encoded` resolves JSON escape spans), so the
//! credential is already `<redacted>` in the bytes `NormalisingTransport`
//! decodes. The decorator never sees a credential in any spelling, and the
//! re-encoded body it produces is re-wrapped in a `BodyStream` carrying the
//! same origin, so it passes the same door a second time on the way out.
//!
//! # Controls
//!
//! Every negative assertion is paired with something that can fail:
//! [`the_peers_own_diagnosis_survives`] proves this is redaction and not
//! deletion, and [`the_peer_really_does_encode`] proves the peer leaves no
//! literal copy on the wire — without which the byte-literal pass would be
//! doing the work and the probe would say nothing about the decode.
//!
//! # Honesty (conventions.md §10)
//!
//! **VERIFIED-BY-FAKE.** `MemoryStore` and a mock peer on loopback. Not one
//! byte came from a language model.

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

/// The `/` characters are the point: they are what `json_encode` rewrites.
const CANARY: &str = "sk/vela-probe4/Ky-7d41c0f9ab63e2/DO-NOT-LEAK";
/// The stretch that survives `detail()`'s 200-character bound cutting the key
/// in half, so a partial leak is still a leak.
const CANARY_CORE: &str = "7d41c0f9ab63e2";
/// Carries no secret, so it must **survive**: this is how the probe tells a
/// redaction apart from a deletion.
const MARKER: &str = "VELA-PROBE-MARKER";

/// Encode as the contents of a JSON string literal, PHP `json_encode` style:
/// the required minimum, plus `/` → `\/`.
fn solidus(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('/', "\\/")
}

/// A peer that answers in **vLLM's** shape — `{"object":"error","message":…}`,
/// no `error` object at all — quoting the credential it was sent, escaped.
///
/// The shape is load-bearing: the canonical OpenAI shape makes
/// `normalise_error_body` return `None`, which leaves the bytes untouched and
/// skips the decode/re-encode this probe exists to exercise.
async fn vllm_style_echo_peer() -> String {
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
            // The credential goes first, right after the marker: a leak that
            // fell off the end of `detail()`'s bound would be a pass for the
            // wrong reason.
            let message = format!("{MARKER}: rejected credential [{credential}]");
            let body = format!(
                "{{\"object\":\"error\",\"message\":\"{}\",\
                 \"type\":\"BadRequestError\",\"code\":400}}",
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
        // Off so the probe measures the chat path rather than four discovery
        // GETs against the same peer. Discovery's own body read is covered by
        // `compat_live_matrix.rs`.
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
            "serde JSON (the IPC wire shape)",
            serde_json::to_string(error).expect("ProviderError serialises"),
        ),
    ];
    for event in &sink.events {
        surfaces.push((
            "StreamEvent (the sink the UI reads)",
            serde_json::to_string(event).expect("StreamEvent serialises"),
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

/// Guards the failure mode that would make every assertion above pass for the
/// wrong reason: an error that says nothing at all.
#[track_caller]
fn assert_the_failure_is_real(label: &str, error: &ProviderError) {
    let detail = match error {
        ProviderError::Transport { detail, .. }
        | ProviderError::MalformedResponse { detail }
        | ProviderError::AuthFailed { detail }
        | ProviderError::RateLimited { detail, .. }
        | ProviderError::ContextLengthExceeded { detail, .. }
        | ProviderError::ModelNotFound { detail, .. } => detail,
        other => panic!("{label}: expected an endpoint failure, got {other:?}"),
    };
    assert!(
        !detail.is_empty(),
        "{label}: an empty detail would pass every leak assertion vacuously"
    );
}

/// The probe. Both transports, four surfaces.
#[tokio::test]
async fn the_compat_adapters_decode_and_reencode_step_does_not_reconstitute_the_credential() {
    let base_url = vllm_style_echo_peer().await;
    let provider = build(&base_url);

    let error = provider
        .complete(turn(), &context())
        .await
        .expect_err("the peer rejects the credential on purpose");
    assert_the_failure_is_real("compat/complete()", &error);
    assert_clean("compat/complete()", &error, &CollectingSink::new());

    let mut sink = CollectingSink::new();
    let error = provider
        .stream(turn(), &mut sink, &context())
        .await
        .expect_err("the peer rejects the credential on purpose");
    assert_the_failure_is_real("compat/stream()", &error);
    assert_clean("compat/stream()", &error, &sink);
}

/// The other direction: removing the secret must not remove the diagnosis.
/// `normalise_error_body` is the step that could quietly drop the whole
/// message, and a silent drop would satisfy every assertion above.
#[tokio::test]
async fn the_peers_own_diagnosis_survives() {
    let base_url = vllm_style_echo_peer().await;
    let provider = build(&base_url);
    let error = provider
        .complete(turn(), &context())
        .await
        .expect_err("the peer rejects the credential on purpose");
    let rendered = error.to_string();
    assert!(
        rendered.contains(MARKER),
        "the endpoint's own diagnosis was deleted rather than redacted: {rendered}"
    );
    assert!(
        rendered.contains("<redacted>"),
        "the redaction marker must be there, or the body was merely empty: {rendered}"
    );
}

/// The premise. If the peer left a literal copy of the credential on the wire,
/// the byte-literal pass would be doing all the work and this file would say
/// nothing whatsoever about the decode.
#[test]
fn the_peer_really_does_encode() {
    let escaped = solidus(&format!("{MARKER}: rejected credential [Bearer {CANARY}]"));
    assert!(
        !escaped.contains(CANARY),
        "the peer left a literal copy; the probe would prove nothing: {escaped}"
    );
    assert!(
        escaped.contains("sk\\/vela-probe4"),
        "the peer must escape the solidus: {escaped}"
    );
}
