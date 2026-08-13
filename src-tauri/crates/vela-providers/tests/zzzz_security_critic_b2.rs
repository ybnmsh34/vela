//! Independent SECURITY-critic probe for GATE M Part 1, Phase B2. Deleted after the run.
//!
//! Drives the REAL OpenAiCompatibleProvider over a REAL loopback socket with a
//! REAL reqwest transport, with **default** ProviderOptions (policy = Refuse),
//! so nothing here depends on an opt-in setting.

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use vela_core::credential::Auth;
use vela_core::provider::{ProviderDescriptor, ProviderKind};
use vela_providers::event::CollectingSink;
use vela_providers::http::ReqwestTransport;
use vela_providers::openai_compatible::OpenAiCompatibleProvider;
use vela_providers::{ChatMessage, ChatRequest, Provider, RequestContext, ResponseFormat, Timeouts};
use vela_secrets::MemoryStore;

const DELIBERATION: &str = concat!(
    "<think>The user wants an object. My first guess is ",
    "{\"city\":\"Atlantis\",\"celsius\":-273.15} — no, that city does not exist and ",
    "that temperature is below absolute zero, so I must"
);

/// The capability probe's own schema and prompt, deliberated and cut off.
const PROBE_DELIBERATION: &str = concat!(
    "<think>They want {\"answer\":\"42\"} but I am not sure that is right, ",
    "let me reconsider before I commit to"
);

async fn peer(text: &'static str, streaming: bool) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("free port");
    let port = listener.local_addr().expect("bound").port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut scratch = vec![0u8; 32 * 1024];
            let _ = socket.read(&mut scratch).await;
            let body = if streaming {
                let mut out = String::new();
                for piece in text.chars().collect::<Vec<_>>().chunks(13) {
                    let chunk: String = piece.iter().collect();
                    let escaped = serde_json::to_string(&chunk).unwrap();
                    out.push_str(&format!(
                        "data: {{\"choices\":[{{\"index\":0,\"delta\":{{\"content\":{escaped}}}}}]}}\n\n"
                    ));
                }
                out.push_str(
                    "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"length\"}]}\n\n",
                );
                out.push_str("data: [DONE]\n\n");
                format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{out}",
                    out.len()
                )
            } else {
                let escaped = serde_json::to_string(text).unwrap();
                let json = format!(
                    "{{\"choices\":[{{\"index\":0,\"message\":{{\"role\":\"assistant\",\"content\":{escaped}}},\"finish_reason\":\"length\"}}]}}"
                );
                format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{json}",
                    json.len()
                )
            };
            let _ = socket.write_all(body.as_bytes()).await;
            let _ = socket.flush().await;
        }
    });
    format!("http://127.0.0.1:{port}")
}

fn build(base: &str) -> OpenAiCompatibleProvider {
    // DEFAULT options. No `.with_options(...)`, so structured_output = Refuse.
    OpenAiCompatibleProvider::new(
        ProviderDescriptor::new("critic", "Critic", ProviderKind::Local).expect("descriptor"),
        base,
        Auth::None,
        Arc::new(MemoryStore::new()),
        Arc::new(ReqwestTransport::with_connect_timeout(Duration::from_secs(5)).unwrap()),
    )
}

fn context() -> RequestContext {
    RequestContext::new().with_timeouts(Timeouts {
        connect: Duration::from_secs(5),
        first_byte: Duration::from_secs(5),
        stall: Duration::from_secs(5),
    })
}

fn schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {"city": {"type": "string"}, "celsius": {"type": "number"}},
        "required": ["city", "celsius"]
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn rejected_deliberation_becomes_a_validated_structured_answer_on_default_options() {
    for streaming in [false, true] {
        let base = peer(DELIBERATION, streaming).await;
        let provider = build(&base);
        let request = ChatRequest::new("critic-model")
            .with_message(ChatMessage::user("give me the weather as JSON"))
            .with_response_format(ResponseFormat::JsonSchema {
                name: "weather".into(),
                schema: schema(),
            });
        let mut sink = CollectingSink::new();
        let response = if streaming {
            provider.stream(request, &mut sink, &context()).await
        } else {
            provider.complete(request, &context()).await
        }
        .expect("200");
        println!("=== DEFAULT OPTIONS, streaming={streaming}");
        println!("  answer       = {:?}", response.answer_text());
        println!("  reasoning    = {:?}", response.reasoning_text());
        println!("  STRUCTURED   = {:?}", response.structured);
        println!("  degradations = {:?}", response.degradations);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_capability_probe_learns_supported_from_a_cut_off_deliberation() {
    let base = peer(PROBE_DELIBERATION, false).await;
    let provider = build(&base);
    let report = provider
        .probe_capabilities("critic-model", &context())
        .await;
    match report {
        Ok(caps) => {
            println!("=== CAPABILITY PROBE ===");
            println!("  structured_output = {:?}", caps.structured_output);
            println!("  full report       = {caps:#?}");
        }
        Err(error) => println!("=== CAPABILITY PROBE errored: {error}"),
    }
}
