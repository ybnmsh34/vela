//! **Recorded-fixture replay for the Anthropic adapter.**
//!
//! Each fixture under `tests/fixtures/anthropic/` is a byte-exact SSE body in
//! the Anthropic Messages event shape — `message_start` → `content_block_*` →
//! `message_delta` → `message_stop`, with thinking blocks, signature deltas,
//! redacted thinking, `input_json_delta` tool calls, and the damage a real
//! network inflicts. Every test feeds one of them through the real
//! `AnthropicProvider` over the scriptable transport, **at five different chunk
//! sizes including one byte at a time**, because a frame boundary, a tag and a
//! multi-byte sequence all land wherever TCP decides.
//!
//! # HONESTY (conventions.md §10)
//!
//! **Every result in this file is VERIFIED-BY-FAKE.** No live credential and no
//! live endpoint exists in this container. The fixtures are event sequences
//! transcribed from the published protocol shape — they are *not* captured
//! traffic, and not one byte of them came from a language model. These tests
//! prove that the adapter survives streams shaped like this. They prove nothing
//! whatsoever about what a real endpoint or a real model does.
//!
//! # The controls
//!
//! Four tests below implement the *naive* consumer alongside Vela's and assert
//! that the naive one fails: it hangs on the missing terminator, loses
//! characters to one bad frame, allocates slots from content-block indices, and
//! leaks reasoning markup a frame-local stripper cannot see. Without those, a
//! passing suite would only show that these fixtures are easy.

use std::sync::Arc;

use vela_core::credential::Auth;
use vela_core::provider::{ProviderDescriptor, ProviderKind};
use vela_providers::anthropic::AnthropicProvider;
use vela_providers::event::CollectingSink;
use vela_providers::http::testing::{CannedResponse, ScriptedTransport};
use vela_providers::{
    ChatMessage, ChatRequest, ChatResponse, ContentPart, Degradation, MessageRole, Provider,
    ProviderError, ProviderResult, RequestContext, ResponseFormat, StopReason, ToolCallOutcome,
    ToolDefinition,
};
use vela_secrets::MemoryStore;

// ---------------------------------------------------------------------------
// Replay harness
// ---------------------------------------------------------------------------

/// Every chunk size a body is replayed at. `1` is the important one: it puts a
/// boundary inside every frame, every tag and every JSON token.
const CHUNK_SIZES: [usize; 5] = [1, 3, 17, 512, usize::MAX];

fn fixture(name: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/anthropic")
        .join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("fixture {}: {error}", path.display()));
    assert!(
        text.is_ascii(),
        "fixtures are chunked bytewise, so they are kept ASCII on purpose"
    );
    text
}

fn chunked(text: &str, size: usize) -> Vec<String> {
    let size = size.min(text.len()).max(1);
    text.as_bytes()
        .chunks(size)
        .map(|chunk| String::from_utf8(chunk.to_vec()).expect("ASCII fixture"))
        .collect()
}

fn provider(body: &str, chunk: usize) -> (AnthropicProvider, Arc<ScriptedTransport>) {
    let pieces = chunked(body, chunk);
    let transport = Arc::new(ScriptedTransport::new(vec![Ok(CannedResponse::sse(
        pieces.iter().map(String::as_str).collect(),
    ))]));
    let provider = AnthropicProvider::new(
        ProviderDescriptor::new("fixture", "Fixture", ProviderKind::RemoteApi).unwrap(),
        "https://example.invalid",
        Auth::None,
        Arc::new(MemoryStore::new()),
        transport.clone(),
    );
    (provider, transport)
}

async fn replay(
    body: &str,
    chunk: usize,
    request: ChatRequest,
) -> (CollectingSink, ProviderResult<ChatResponse>) {
    let (provider, _) = provider(body, chunk);
    let mut sink = CollectingSink::new();
    let response = provider
        .stream(request, &mut sink, &RequestContext::new())
        .await;
    (sink, response)
}

fn ask(text: &str) -> ChatRequest {
    ChatRequest::new("claude-fixture").with_message(ChatMessage::user(text))
}

/// Every `data:` payload in a body, in order. Used only by the controls.
fn data_payloads(body: &str) -> Vec<String> {
    body.split("\n\n")
        .filter(|frame| !frame.trim().is_empty())
        .filter_map(|frame| {
            frame
                .lines()
                .find_map(|line| line.strip_prefix("data: "))
                .map(str::to_owned)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 01 — thinking, then text, then a tool call
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_thinking_tool_use_turn_survives_every_chunk_boundary() {
    for chunk in CHUNK_SIZES {
        let (sink, response) = replay(
            &fixture("01-thinking-tool-use.sse"),
            chunk,
            ask("What is the weather in Berlin?").with_tools([ToolDefinition::new(
                "get_weather",
                "Current weather",
                serde_json::json!({"type": "object"}),
            )]),
        )
        .await;
        let response = response.unwrap_or_else(|error| panic!("chunk {chunk}: {error}"));

        assert_eq!(
            response.answer_text(),
            "Let me look that up.",
            "chunk {chunk}"
        );
        assert_eq!(
            response.reasoning_text(),
            "The user wants the weather in Berlin. I should call get_weather with city=Berlin.",
            "chunk {chunk}"
        );
        assert_eq!(
            response.parts[0],
            ContentPart::Reasoning {
                text: "The user wants the weather in Berlin. I should call get_weather with \
                       city=Berlin."
                    .into(),
                signature: Some("EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds".into()),
                redacted: false,
            },
            "chunk {chunk}: the signature must survive, or the next turn is rejected"
        );
        assert_eq!(
            response.tool_calls,
            vec![ToolCallOutcome::Ok {
                call_id: "toolu_01T1x1fJ34qAmk2tNTrN7Up6".into(),
                name: "get_weather".into(),
                arguments: serde_json::json!({"city": "Berlin"}),
                emulated: false,
            }],
            "chunk {chunk}"
        );
        assert_eq!(response.stop_reason, StopReason::ToolUse, "chunk {chunk}");
        assert_eq!(response.usage.input_tokens, Some(472), "chunk {chunk}");
        assert_eq!(response.usage.output_tokens, Some(89), "chunk {chunk}");
        assert_eq!(response.usage.reasoning_tokens, Some(57), "chunk {chunk}");
        assert_eq!(response.usage.cached_input_tokens, Some(0), "chunk {chunk}");
        assert!(
            response.degradations.is_empty(),
            "chunk {chunk}: a healthy turn reports nothing, got {:?}",
            response.degradations
        );

        assert_eq!(sink.text(), "Let me look that up.", "chunk {chunk}");
        assert!(
            !sink.text().contains("get_weather"),
            "chunk {chunk}: reasoning must never reach the answer channel"
        );
        assert!(
            matches!(
                sink.events.last(),
                Some(vela_providers::StreamEvent::Done { .. })
            ),
            "chunk {chunk}: Done is emitted exactly once, at end of body"
        );
    }
}

#[tokio::test]
async fn the_next_turn_replays_the_thinking_block_byte_for_byte() {
    // THK-7: within a tool-use turn the reasoning must go back complete and
    // unmodified, or the endpoint rejects the turn. This is the round trip.
    let (sink, response) = replay(
        &fixture("01-thinking-tool-use.sse"),
        7,
        ask("What is the weather in Berlin?"),
    )
    .await;
    let first = response.unwrap();
    drop(sink);

    let ToolCallOutcome::Ok { call_id, .. } = &first.tool_calls[0] else {
        panic!("fixture 01 produces one well-formed call");
    };
    let mut assistant_parts = first.parts.clone();
    assistant_parts.push(ContentPart::ToolCall {
        call_id: call_id.clone(),
        name: "get_weather".into(),
        arguments: serde_json::json!({"city": "Berlin"}),
    });

    let (provider, transport) = provider(&fixture("02-redacted-thinking.sse"), 64);
    let mut sink = CollectingSink::new();
    provider
        .stream(
            ask("What is the weather in Berlin?")
                .with_message(ChatMessage::new(MessageRole::Assistant, assistant_parts))
                .with_message(ChatMessage::new(
                    MessageRole::Tool,
                    vec![ContentPart::ToolResult {
                        call_id: call_id.clone(),
                        content: "21C, clear".into(),
                        is_error: false,
                    }],
                )),
            &mut sink,
            &RequestContext::new(),
        )
        .await
        .unwrap();

    let body: serde_json::Value =
        serde_json::from_slice(transport.recorded()[0].body.as_ref().unwrap()).unwrap();
    let assistant = &body["messages"][1];
    assert_eq!(assistant["role"], "assistant");
    assert_eq!(assistant["content"][0]["type"], "thinking");
    assert_eq!(
        assistant["content"][0]["signature"],
        "EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds",
        "the signature goes back exactly as it arrived"
    );
    assert_eq!(assistant["content"][1]["type"], "text");
    assert_eq!(assistant["content"][2]["type"], "tool_use");
    assert_eq!(assistant["content"][2]["id"], call_id.as_str());
    assert_eq!(body["messages"][2]["role"], "user");
    assert_eq!(body["messages"][2]["content"][0]["type"], "tool_result");
    assert_eq!(
        body["messages"][2]["content"][0]["tool_use_id"],
        call_id.as_str()
    );
}

// ---------------------------------------------------------------------------
// 02 — redacted thinking
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_redacted_thinking_block_is_kept_for_the_round_trip_and_never_displayed() {
    for chunk in CHUNK_SIZES {
        let (sink, response) = replay(&fixture("02-redacted-thinking.sse"), chunk, ask("hi")).await;
        let response = response.unwrap();
        assert_eq!(
            response.answer_text(),
            "I cannot help with that request.",
            "chunk {chunk}"
        );
        assert_eq!(
            response.parts[0],
            ContentPart::Reasoning {
                text: "EvwBCoYBGAIiQEbS4M8mMOAxRoK1z0Rr8XoQoLwZ0nH0RedactedCiphertextAAA==".into(),
                signature: None,
                redacted: true,
            },
            "chunk {chunk}: THK-8 — dropping these breaks the protocol on the next turn"
        );
        assert_eq!(
            sink.reasoning(),
            "",
            "chunk {chunk}: opaque ciphertext is not reasoning a user can read"
        );
    }
}

// ---------------------------------------------------------------------------
// 03 — MEASURED-1: no terminator
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_stream_that_stops_without_a_terminator_still_delivers_its_answer() {
    for chunk in CHUNK_SIZES {
        let (sink, response) = replay(
            &fixture("03-truncated-no-terminator.sse"),
            chunk,
            ask("largest moons of jupiter?"),
        )
        .await;
        let response = response.unwrap_or_else(|error| panic!("chunk {chunk}: {error}"));
        assert_eq!(
            response.answer_text(),
            "The three largest moons of Jupiter are Ganymede, Callisto and Io, in that order.",
            "chunk {chunk}: end of body is the terminator"
        );
        assert!(
            response
                .degradations
                .contains(&Degradation::NoTerminationSentinel),
            "chunk {chunk}: the missing terminator is reported, not waited for"
        );
        assert_eq!(sink.text(), response.answer_text(), "chunk {chunk}");
    }
}

#[tokio::test]
async fn control_a_sentinel_driven_consumer_delivers_nothing_from_that_same_body() {
    // The recorded failure: a consumer that waits for the terminator timed out
    // at 5003 ms. Here it simply never commits, which is the same bug without
    // the wall clock.
    let body = fixture("03-truncated-no-terminator.sse");
    let mut naive = String::new();
    let mut committed = String::new();
    for payload in data_payloads(&body) {
        let value: serde_json::Value = serde_json::from_str(&payload).unwrap();
        if value["delta"]["type"] == "text_delta" {
            naive.push_str(value["delta"]["text"].as_str().unwrap());
        }
        if value["type"] == "message_stop" {
            committed = naive.clone();
        }
    }
    assert!(
        committed.is_empty(),
        "control must fail: a sentinel-driven consumer never delivers this body"
    );

    let (_, response) = replay(&body, 1, ask("largest moons of jupiter?")).await;
    assert_eq!(
        response.unwrap().answer_text().chars().count(),
        naive.chars().count(),
        "Vela delivers every character the sentinel-driven consumer withheld"
    );
}

// ---------------------------------------------------------------------------
// 04 — MEASURED-2: malformed frames
// ---------------------------------------------------------------------------

#[tokio::test]
async fn malformed_frames_cost_one_frame_each_and_never_the_stream() {
    for chunk in CHUNK_SIZES {
        let (sink, response) =
            replay(&fixture("04-malformed-frames.sse"), chunk, ask("vela?")).await;
        let response = response.unwrap_or_else(|error| panic!("chunk {chunk}: {error}"));
        assert_eq!(
            response.answer_text(),
            "Vela is the constellation of the sails. It was split from Argo Navis in 1763. \
             Its brightest star is Gamma Velorum.",
            "chunk {chunk}: content that already arrived is never discarded"
        );
        assert!(
            response
                .degradations
                .contains(&Degradation::MalformedFramesSkipped { count: 3 }),
            "chunk {chunk}: got {:?}",
            response.degradations
        );
        assert_eq!(response.stop_reason, StopReason::EndTurn, "chunk {chunk}");
        assert_eq!(sink.text(), response.answer_text(), "chunk {chunk}");
    }
}

#[tokio::test]
async fn control_b_a_fatal_json_parser_loses_most_of_that_same_answer() {
    // The recorded failure: a consumer that JSON.parse'd every frame threw
    // after 4 frames and lost 318 of 349 characters.
    let body = fixture("04-malformed-frames.sse");
    let mut naive = String::new();
    for payload in data_payloads(&body) {
        match serde_json::from_str::<serde_json::Value>(&payload) {
            Ok(value) => {
                if value["delta"]["type"] == "text_delta" {
                    naive.push_str(value["delta"]["text"].as_str().unwrap_or_default());
                }
            }
            // The naive consumer treats one bad frame as fatal.
            Err(_) => break,
        }
    }

    let (_, response) = replay(&body, 1, ask("vela?")).await;
    let ours = response.unwrap().answer_text();
    let lost = ours.chars().count() - naive.chars().count();
    assert!(
        lost > 70,
        "control must fail: the fatal parser should lose most of the answer, lost {lost}"
    );
    assert!(
        ours.starts_with(&naive),
        "and what it did get is a prefix of what Vela got"
    );
}

// ---------------------------------------------------------------------------
// 05 — an error inside a 200 stream
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_overload_reported_inside_a_200_stream_becomes_a_retriable_error() {
    for chunk in CHUNK_SIZES {
        let (sink, response) =
            replay(&fixture("05-overloaded-mid-stream.sse"), chunk, ask("hi")).await;
        let error = response.expect_err("an error event must not be reported as an answer");
        assert_eq!(error.code(), "transport", "chunk {chunk}");
        assert!(
            error.allows_retry() && error.allows_failover(),
            "chunk {chunk}: an overload is transient"
        );
        assert!(
            sink.error().is_some(),
            "chunk {chunk}: the sink is told, not left hanging"
        );
        assert!(
            !sink
                .events
                .iter()
                .any(|event| matches!(event, vela_providers::StreamEvent::Done { .. })),
            "chunk {chunk}: Error is terminal — no Done follows it"
        );
    }
}

// ---------------------------------------------------------------------------
// 06 — MEASURED-5: structured output
// ---------------------------------------------------------------------------

fn weather_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {"city": {"type": "string"}, "celsius": {"type": "number"}},
        "required": ["city", "celsius"]
    })
}

#[tokio::test]
async fn a_structured_answer_is_validated_before_it_can_be_read() {
    for chunk in CHUNK_SIZES {
        let request =
            ask("weather in berlin as json").with_response_format(ResponseFormat::JsonSchema {
                name: "weather".into(),
                schema: weather_schema(),
            });
        let (_, response) = replay(&fixture("06-structured-tool-call.sse"), chunk, request).await;
        let response = response.unwrap_or_else(|error| panic!("chunk {chunk}: {error}"));
        match response.structured.as_ref().expect("structured requested") {
            Ok(value) => {
                assert_eq!(value["city"], "Berlin", "chunk {chunk}");
                assert_eq!(value["celsius"], 21.5, "chunk {chunk}");
            }
            Err(mismatch) => {
                panic!("chunk {chunk}: a conforming answer must validate: {mismatch:?}")
            }
        }
        assert!(
            response.tool_calls.is_empty(),
            "chunk {chunk}: Vela's internal schema tool must never reach the caller"
        );
    }
}

#[tokio::test]
async fn control_c_trusting_the_same_stream_against_a_schema_it_violates_is_caught() {
    // The same 200, the same tool call — but against a schema it does not
    // satisfy. Nothing in the response says so; only validation can tell.
    let request = ask("weather as json").with_response_format(ResponseFormat::JsonSchema {
        name: "weather".into(),
        schema: serde_json::json!({
            "type": "object",
            "properties": {"city": {"type": "string"}, "celsius": {"type": "number"}},
            "required": ["city", "celsius", "humidity"]
        }),
    });
    let (_, response) = replay(&fixture("06-structured-tool-call.sse"), 1, request).await;
    let response = response.unwrap();
    match response.structured.as_ref().expect("structured requested") {
        Ok(value) => {
            panic!("control must fail: a non-conforming answer must not read as data: {value}")
        }
        Err(mismatch) => assert_eq!(mismatch.path, "/humidity"),
    }
    assert!(response
        .degradations
        .iter()
        .any(|degradation| matches!(degradation, Degradation::StructuredOutputMismatch { .. })));
}

// ---------------------------------------------------------------------------
// 07 — MEASURED-3: leaked reasoning markup
// ---------------------------------------------------------------------------

#[tokio::test]
async fn leaked_reasoning_markup_is_separated_across_frame_boundaries() {
    for chunk in CHUNK_SIZES {
        let (sink, response) = replay(
            &fixture("07-leaked-think-markup.sse"),
            chunk,
            ask("a number?"),
        )
        .await;
        let response = response.unwrap_or_else(|error| panic!("chunk {chunk}: {error}"));
        assert_eq!(response.answer_text(), "The answer is 42.", "chunk {chunk}");
        assert_eq!(
            response.reasoning_text(),
            "The user asked for a number. I will answer 42.",
            "chunk {chunk}"
        );
        assert!(
            !sink.text().contains("think"),
            "chunk {chunk}: no markup may reach the user, got {:?}",
            sink.text()
        );
    }
}

#[tokio::test]
async fn control_d_a_frame_local_stripper_leaks_that_markup_to_the_user() {
    // No single frame contains the closing tag, so a per-frame stripper cannot
    // possibly remove it — the exact failure the mock matrix recorded.
    let body = fixture("07-leaked-think-markup.sse");
    let mut naive = String::new();
    for payload in data_payloads(&body) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&payload) else {
            continue;
        };
        if value["delta"]["type"] == "text_delta" {
            let text = value["delta"]["text"].as_str().unwrap_or_default();
            // A frame-local stripper: remove any complete block it can see.
            let stripped = match (text.find("<think>"), text.find("</think>")) {
                (Some(open), Some(close)) if close > open => {
                    format!("{}{}", &text[..open], &text[close + "</think>".len()..])
                }
                _ => text.to_owned(),
            };
            naive.push_str(&stripped);
        }
    }
    assert!(
        naive.contains("<think") || naive.contains("think>"),
        "control must fail: the frame-local stripper should leak markup, got {naive:?}"
    );

    let (sink, response) = replay(&body, 1, ask("a number?")).await;
    assert!(!sink.text().contains("think"));
    assert_eq!(response.unwrap().answer_text(), "The answer is 42.");
}

#[tokio::test]
async fn control_e_keying_tool_slots_by_content_block_index_allocates_empty_calls() {
    // Content-block indices count *every* block: on fixture 01 the tool call is
    // at index 2 behind a thinking block and a text block. A consumer that
    // allocated a slot per index would report three calls, two of them empty.
    let body = fixture("01-thinking-tool-use.sse");
    let mut highest = 0usize;
    for payload in data_payloads(&body) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&payload) else {
            continue;
        };
        if let Some(index) = value.get("index").and_then(serde_json::Value::as_u64) {
            highest = highest.max(index as usize);
        }
    }
    let naive_slots = highest + 1;
    assert_eq!(
        naive_slots, 3,
        "control must fail: index-keyed slots over-allocate on this body"
    );

    let (_, response) = replay(&body, 1, ask("weather?")).await;
    assert_eq!(
        response.unwrap().tool_calls.len(),
        1,
        "Vela's slots are its own, mapped from the wire index rather than indexed by it"
    );
}

// ---------------------------------------------------------------------------
// The wire Vela sends
// ---------------------------------------------------------------------------

#[tokio::test]
async fn every_replay_sends_the_version_header_and_no_credential_header() {
    let (provider, transport) = provider(&fixture("02-redacted-thinking.sse"), 64);
    let mut sink = CollectingSink::new();
    provider
        .stream(ask("hi"), &mut sink, &RequestContext::new())
        .await
        .unwrap();
    let sent = &transport.recorded()[0];
    assert_eq!(sent.header("anthropic-version"), Some("2023-06-01"));
    assert_eq!(
        sent.header("x-api-key"),
        None,
        "no credential configured means no credential header — never an empty one"
    );
    assert_eq!(sent.header("authorization"), None);
    assert_eq!(sent.header("accept"), Some("text/event-stream"));
}

#[tokio::test]
async fn no_wire_detail_from_this_backend_reaches_the_caller() {
    // The adapter boundary: what comes back out is the shared model and the
    // shared error taxonomy, with no vendor vocabulary anywhere in it.
    let (sink, response) = replay(&fixture("01-thinking-tool-use.sse"), 5, ask("weather?")).await;
    let response = response.unwrap();
    let rendered = format!(
        "{}{}",
        serde_json::to_string(&response).unwrap(),
        serde_json::to_string(&sink.events).unwrap()
    );
    for leaked in [
        "content_block",
        "message_delta",
        "thinking_delta",
        "input_json_delta",
        "anthropic",
        "cache_control",
        "tool_use",
        "x-api-key",
    ] {
        assert!(
            !rendered.contains(leaked),
            "`{leaked}` escaped the adapter: {rendered}"
        );
    }

    let error = replay(&fixture("05-overloaded-mid-stream.sse"), 5, ask("hi"))
        .await
        .1
        .unwrap_err();
    let rendered = serde_json::to_string(&error).unwrap();
    assert!(
        !rendered.contains("overloaded_error") && !rendered.contains("anthropic"),
        "the error taxonomy carries no vendor vocabulary: {rendered}"
    );
    assert!(matches!(error, ProviderError::Transport { .. }));
}
