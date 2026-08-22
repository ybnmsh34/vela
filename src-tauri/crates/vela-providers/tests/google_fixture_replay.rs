//! **Recorded-fixture replay for the Google Gemini adapter.**
//!
//! Each fixture under `tests/fixtures/google/` is a byte-exact SSE body in the
//! shape `:streamGenerateContent?alt=sse` produces — `candidates[].content.parts`
//! with `thought` parts and `thoughtSignature`, whole `functionCall` parts,
//! `promptFeedback.blockReason`, `finishReason`, `usageMetadata` — plus the
//! damage a real network inflicts. Every test feeds one of them through the real
//! `GoogleProvider` over the scriptable transport, **at five different chunk
//! sizes including one byte at a time**, because a frame boundary, a tag and a
//! JSON token all land wherever TCP decides.
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
//! Five tests below implement the *naive* consumer alongside Vela's and assert
//! that the naive one fails: it never terminates (this API sends no sentinel at
//! all), it loses characters to one bad frame, it leaks reasoning markup a
//! frame-local stripper cannot see, it merges two function calls into one — and,
//! the one specific to this backend, **it renders a refused prompt as a blank
//! answer with no error**. Without those, a passing suite would only show that
//! these fixtures are easy.

use std::sync::Arc;

use serde_json::{json, Value};
use vela_core::credential::Auth;
use vela_core::provider::{ProviderDescriptor, ProviderKind};
use vela_providers::event::CollectingSink;
use vela_providers::google::GoogleProvider;
use vela_providers::http::testing::{CannedResponse, ScriptedTransport};
use vela_providers::tool_accum::{ToolCallAccumulator, ToolCallShape};
use vela_providers::{
    ChatMessage, ChatRequest, ChatResponse, ContentPart, Degradation, MalformedToolCall, Provider,
    ProviderResult, RequestContext, ResponseFormat, StopReason, StreamEvent, ToolCallOutcome,
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
        .join("tests/fixtures/google")
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

fn provider(body: &str, chunk: usize) -> (GoogleProvider, Arc<ScriptedTransport>) {
    let pieces = chunked(body, chunk);
    let transport = Arc::new(ScriptedTransport::new(vec![Ok(CannedResponse::sse(
        pieces.iter().map(String::as_str).collect(),
    ))]));
    let provider = GoogleProvider::new(
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
    ChatRequest::new("gemini-fixture").with_message(ChatMessage::user(text))
}

fn weather_tool() -> ToolDefinition {
    ToolDefinition::new(
        "get_weather",
        "Current weather",
        json!({"type": "object", "properties": {"city": {"type": "string"}}}),
    )
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

/// The obvious consumer: every frame's `candidates[0].content.parts[].text`,
/// concatenated. Used by the controls, never by Vela.
fn naive_text(payload: &str) -> String {
    let Ok(value) = serde_json::from_str::<Value>(payload) else {
        return String::new();
    };
    value
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|candidates| candidates.first())
        .and_then(|candidate| candidate.get("content"))
        .and_then(|content| content.get("parts"))
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<String>()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// 01 — thinking, then text, then a function call
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_thinking_function_call_turn_survives_every_chunk_boundary() {
    for chunk in CHUNK_SIZES {
        let (sink, response) = replay(
            &fixture("01-thinking-function-call.sse"),
            chunk,
            ask("What is the weather in Berlin?").with_tools([weather_tool()]),
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
                signature: Some("CtcBAdHtim9kQ2hJVGxvY2s0M2VkaXRvcg==".into()),
                redacted: false,
            },
            "chunk {chunk}: the signature must survive, or a later turn is rejected"
        );
        assert_eq!(
            response.tool_calls,
            vec![ToolCallOutcome::Ok {
                call_id: "call_slot_0".into(),
                name: "get_weather".into(),
                arguments: json!({"city": "Berlin"}),
                emulated: false,
            }],
            "chunk {chunk}"
        );
        assert_eq!(
            response.stop_reason,
            StopReason::ToolUse,
            "chunk {chunk}: the wire said STOP, but the turn ended in a call"
        );
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
            "chunk {chunk}: the call must not also arrive as visible text"
        );
        assert!(
            sink.events
                .iter()
                .any(|event| matches!(event, StreamEvent::ToolCallDelta { .. })),
            "chunk {chunk}: the UI is told a call is being assembled"
        );
        assert!(
            matches!(sink.events.last(), Some(StreamEvent::Done { .. })),
            "chunk {chunk}"
        );
    }
}

/// CONTROL — this API sends no `[DONE]`, no stop event, nothing. A consumer
/// that waits for any sentinel waits forever; Vela terminates on end-of-body
/// (MEASURED-1).
#[test]
fn control_the_sentinel_a_naive_consumer_would_wait_for_is_never_sent() {
    for name in [
        "01-thinking-function-call.sse",
        "03-answer-safety-block.sse",
        "06-structured-json.sse",
    ] {
        let body = fixture(name);
        assert!(
            !body.contains("[DONE]"),
            "{name}: a consumer keyed on [DONE] would hang"
        );
        assert!(
            !body.contains("message_stop") && !body.contains("\"done\""),
            "{name}: there is no stop event of any kind in this protocol"
        );
    }
}

// ---------------------------------------------------------------------------
// 02 — the prompt was refused before the model ran
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_refused_prompt_is_an_error_that_names_the_filter_and_the_category() {
    for chunk in CHUNK_SIZES {
        let (sink, response) = replay(
            &fixture("02-prompt-safety-block.sse"),
            chunk,
            ask("something the filter refuses"),
        )
        .await;
        let error =
            response.expect_err("a refused prompt is not a successful turn with an empty answer");
        let rendered = format!("{error}");

        assert!(
            rendered.contains("safety filter"),
            "chunk {chunk}: {rendered}"
        );
        assert!(
            rendered.contains("before the model saw it"),
            "chunk {chunk}: the user must be told nothing was generated: {rendered}"
        );
        assert!(
            rendered.contains("hate speech"),
            "chunk {chunk}: the blocked category is named: {rendered}"
        );
        assert!(
            !rendered.contains("sexually explicit") && !rendered.contains("harassment"),
            "chunk {chunk}: only categories that actually blocked are named: {rendered}"
        );
        assert!(
            !rendered.contains("HARM_CATEGORY") && !rendered.contains("SAFETY"),
            "chunk {chunk}: backend vocabulary must not reach the UI: {rendered}"
        );
        assert!(
            !error.allows_retry(),
            "chunk {chunk}: an identical request is refused identically"
        );

        assert!(
            sink.error().is_some(),
            "chunk {chunk}: the sink is told the turn failed"
        );
        assert!(
            sink.response().is_none(),
            "chunk {chunk}: no empty response may be handed over as if it were an answer"
        );
        assert!(sink.text().is_empty(), "chunk {chunk}");
    }
}

/// CONTROL — the whole point of this adapter's block handling.
///
/// The obvious consumer reads `candidates[0].content.parts` and finds nothing.
/// It has no error, no reason and no candidates: the user gets a blank bubble
/// and no explanation. Vela's answer to the same bytes is asserted above.
#[test]
fn control_a_naive_consumer_renders_a_refused_prompt_as_a_blank_answer() {
    let body = fixture("02-prompt-safety-block.sse");
    let payloads = data_payloads(&body);
    assert_eq!(payloads.len(), 1);

    let naive: String = payloads.iter().map(|payload| naive_text(payload)).collect();
    assert_eq!(
        naive, "",
        "the naive consumer produces the empty string — and, crucially, no error"
    );

    let value: Value = serde_json::from_str(&payloads[0]).unwrap();
    assert!(
        value.get("candidates").is_none(),
        "there is no candidate to inspect at all"
    );
    assert!(
        value.get("error").is_none(),
        "and nothing that looks like an error either: the HTTP status was 200"
    );
    assert_eq!(
        value["promptFeedback"]["blockReason"], "SAFETY",
        "the only statement of what happened is in a field a naive consumer never reads"
    );
}

// ---------------------------------------------------------------------------
// 03 — the answer was cut off partway through
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_answer_cut_off_by_the_filter_reports_how_much_the_user_already_saw() {
    for chunk in CHUNK_SIZES {
        let (sink, response) = replay(
            &fixture("03-answer-safety-block.sse"),
            chunk,
            ask("how do I ..."),
        )
        .await;
        let error = response.unwrap_err();
        let rendered = format!("{error}");

        assert_eq!(
            sink.text(),
            "Sure. The first step is to gather",
            "chunk {chunk}: what already streamed still streamed"
        );
        assert!(
            rendered.contains("after 33 characters"),
            "chunk {chunk}: {rendered}"
        );
        assert!(
            rendered.contains("dangerous content"),
            "chunk {chunk}: {rendered}"
        );
        assert!(
            sink.response().is_none(),
            "chunk {chunk}: a truncated answer must never be handed over as a finished one"
        );
    }
}

// ---------------------------------------------------------------------------
// 04 — malformed frames (MEASURED-2)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn one_bad_frame_costs_one_frame_and_never_the_answer() {
    for chunk in CHUNK_SIZES {
        let (sink, response) = replay(
            &fixture("04-malformed-frames.sse"),
            chunk,
            ask("name the primary colours"),
        )
        .await;
        let response = response.unwrap_or_else(|error| panic!("chunk {chunk}: {error}"));
        assert_eq!(
            response.answer_text(),
            "The three primary colours blue and yellow.",
            "chunk {chunk}"
        );
        assert_eq!(sink.text(), response.answer_text(), "chunk {chunk}");
        assert!(
            response
                .degradations
                .contains(&Degradation::MalformedFramesSkipped { count: 2 }),
            "chunk {chunk}: the loss is reported, got {:?}",
            response.degradations
        );
        assert_eq!(response.stop_reason, StopReason::EndTurn, "chunk {chunk}");
    }
}

/// CONTROL — `JSON.parse` every frame and abort on the first failure. The
/// recorded loss on the `hostile` profile was 318 of 349 characters; here it is
/// the same shape of loss.
#[test]
fn control_a_consumer_that_treats_a_bad_frame_as_fatal_loses_the_rest_of_the_answer() {
    let body = fixture("04-malformed-frames.sse");
    let mut naive = String::new();
    for payload in data_payloads(&body) {
        match serde_json::from_str::<Value>(&payload) {
            Ok(_) => naive.push_str(&naive_text(&payload)),
            Err(_) => break,
        }
    }
    assert_eq!(
        naive, "The three primary colours ",
        "the naive consumer stops at the first bad frame"
    );
    assert!(
        naive.len() < "The three primary colours blue and yellow.".len(),
        "and loses everything after it"
    );
}

// ---------------------------------------------------------------------------
// 05 — the body ended with nothing saying it was finished (MEASURED-1)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_stream_that_ends_without_a_finish_reason_terminates_and_says_so() {
    for chunk in CHUNK_SIZES {
        let (sink, response) = replay(
            &fixture("05-truncated-no-finish-reason.sse"),
            chunk,
            ask("tell me a story"),
        )
        .await;
        let response = response.unwrap_or_else(|error| panic!("chunk {chunk}: {error}"));
        assert_eq!(
            response.answer_text(),
            "Once upon a time there was a lighthouse keeper who",
            "chunk {chunk}: everything that arrived is kept"
        );
        assert!(
            response
                .degradations
                .contains(&Degradation::NoTerminationSentinel),
            "chunk {chunk}: the turn is not claimed to be complete, got {:?}",
            response.degradations
        );
        assert!(
            response
                .degradations
                .contains(&Degradation::UsageNotReported),
            "chunk {chunk}"
        );
        assert_eq!(
            response.stop_reason,
            StopReason::Unspecified,
            "chunk {chunk}: no reason was given, and none is invented"
        );
        assert!(
            matches!(sink.events.last(), Some(StreamEvent::Done { .. })),
            "chunk {chunk}: end-of-body terminates; nothing waits for a sentinel"
        );
    }
}

// ---------------------------------------------------------------------------
// 06 — structured output (MEASURED-5)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_conforming_structured_answer_is_returned_as_validated_data() {
    let schema = json!({
        "type": "object",
        "properties": {"city": {"type": "string"}, "celsius": {"type": "number"}},
        "required": ["city", "celsius"],
    });
    for chunk in CHUNK_SIZES {
        let (_, response) = replay(
            &fixture("06-structured-json.sse"),
            chunk,
            ask("weather in Berlin as JSON").with_response_format(ResponseFormat::JsonSchema {
                name: "weather".into(),
                schema: schema.clone(),
            }),
        )
        .await;
        let response = response.unwrap_or_else(|error| panic!("chunk {chunk}: {error}"));
        match response.structured.as_ref().expect("structured requested") {
            Ok(value) => {
                assert_eq!(value["city"], "Berlin", "chunk {chunk}");
                assert_eq!(value["celsius"], 21, "chunk {chunk}");
            }
            Err(mismatch) => {
                panic!("chunk {chunk}: a conforming answer must validate: {mismatch:?}")
            }
        }
    }
}

#[tokio::test]
async fn a_schema_the_endpoint_ignored_is_reported_rather_than_passed_through() {
    // MEASURED-5's exact shape: 200 OK, prose, and nothing anywhere in the
    // response saying the schema was ignored. Replayed against a fixture whose
    // text is not JSON at all.
    for chunk in CHUNK_SIZES {
        let (_, response) = replay(
            &fixture("04-malformed-frames.sse"),
            chunk,
            ask("weather as JSON").with_response_format(ResponseFormat::JsonSchema {
                name: "weather".into(),
                schema: json!({"type": "object", "required": ["city"]}),
            }),
        )
        .await;
        let response = response.unwrap_or_else(|error| panic!("chunk {chunk}: {error}"));
        match response.structured.as_ref().expect("structured requested") {
            Ok(value) => panic!("chunk {chunk}: prose presented as conforming JSON: {value}"),
            Err(mismatch) => assert!(
                mismatch.detail.contains("prose"),
                "chunk {chunk}: {mismatch:?}"
            ),
        }
        assert!(
            response
                .degradations
                .iter()
                .any(|d| matches!(d, Degradation::StructuredOutputMismatch { .. })),
            "chunk {chunk}"
        );
    }
}

// ---------------------------------------------------------------------------
// 07 — leaked reasoning markup (MEASURED-3)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn leaked_think_markup_never_reaches_the_user_at_any_chunk_boundary() {
    for chunk in CHUNK_SIZES {
        let (sink, response) = replay(
            &fixture("07-leaked-think-markup.sse"),
            chunk,
            ask("write me a haiku"),
        )
        .await;
        let response = response.unwrap_or_else(|error| panic!("chunk {chunk}: {error}"));
        assert_eq!(
            response.answer_text(),
            "Rain on the rooftop",
            "chunk {chunk}"
        );
        assert_eq!(
            response.reasoning_text(),
            "The user asked for a haiku. Five, seven, five.",
            "chunk {chunk}"
        );
        assert!(
            !sink.text().contains("think"),
            "chunk {chunk}: got {:?}",
            sink.text()
        );
    }
}

/// CONTROL — a per-frame regex. No single frame in the fixture contains the
/// closing tag, so a frame-local stripper leaks it into the visible answer.
#[test]
fn control_a_frame_local_stripper_leaks_markup_because_no_frame_holds_a_whole_tag() {
    let body = fixture("07-leaked-think-markup.sse");
    let payloads = data_payloads(&body);
    assert!(
        !payloads
            .iter()
            .any(|payload| payload.contains("<think>") && payload.contains("</think>")),
        "the premise: no frame contains a complete block"
    );

    let naive: String = payloads
        .iter()
        .map(|payload| {
            let text = naive_text(payload);
            // The frame-local strip: remove any complete block in this frame.
            match (text.find("<think>"), text.find("</think>")) {
                (Some(open), Some(close)) if close > open => {
                    format!("{}{}", &text[..open], &text[close + "</think>".len()..])
                }
                _ => text,
            }
        })
        .collect();
    assert!(
        naive.contains("<think>") && naive.contains("Five, seven, five"),
        "the naive consumer shows the user Vela's private reasoning and the tags: {naive:?}"
    );
}

// ---------------------------------------------------------------------------
// 08 — the endpoint says it produced a call it could not encode (MEASURED-4)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_malformed_function_call_is_reported_as_an_error_the_ui_can_show() {
    for chunk in CHUNK_SIZES {
        let (_, response) = replay(
            &fixture("08-malformed-function-call.sse"),
            chunk,
            ask("weather in Berlin?").with_tools([weather_tool()]),
        )
        .await;
        let response = response.unwrap_or_else(|error| panic!("chunk {chunk}: {error}"));
        assert_eq!(response.tool_calls.len(), 1, "chunk {chunk}");
        match &response.tool_calls[0] {
            ToolCallOutcome::Malformed {
                raw_arguments,
                reason,
                ..
            } => {
                assert_eq!(*reason, MalformedToolCall::MissingName, "chunk {chunk}");
                assert_eq!(raw_arguments, "get_weather(city=", "chunk {chunk}");
            }
            other => panic!("chunk {chunk}: expected a reported malformed call, got {other:?}"),
        }
        assert_eq!(
            response.executable_tool_calls().count(),
            0,
            "chunk {chunk}: a call the endpoint disowned is never run"
        );
        assert!(
            response
                .degradations
                .contains(&Degradation::MalformedToolCalls { count: 1 }),
            "chunk {chunk}: got {:?}",
            response.degradations
        );
    }
}

// ---------------------------------------------------------------------------
// 09 — several calls in one turn (MEASURED-4)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn parallel_function_calls_stay_separate_calls() {
    for chunk in CHUNK_SIZES {
        let (_, response) = replay(
            &fixture("09-parallel-function-calls.sse"),
            chunk,
            ask("weather in Berlin and Paris, and the time?").with_tools([weather_tool()]),
        )
        .await;
        let response = response.unwrap_or_else(|error| panic!("chunk {chunk}: {error}"));
        assert_eq!(
            response.tool_calls,
            vec![
                ToolCallOutcome::Ok {
                    call_id: "call_slot_0".into(),
                    name: "get_weather".into(),
                    arguments: json!({"city": "Berlin"}),
                    emulated: false,
                },
                ToolCallOutcome::Ok {
                    call_id: "call_slot_1".into(),
                    name: "get_weather".into(),
                    arguments: json!({"city": "Paris"}),
                    emulated: false,
                },
                ToolCallOutcome::Ok {
                    call_id: "call_slot_2".into(),
                    name: "get_time".into(),
                    arguments: json!({"zone": "CET"}),
                    emulated: false,
                },
            ],
            "chunk {chunk}"
        );
        assert_eq!(response.stop_reason, StopReason::ToolUse, "chunk {chunk}");
    }
}

/// CONTROL — this API sends no `index` with a function call, so an accumulator
/// fed the calls without Vela's own slot allocation folds all three into one and
/// produces a single corrupt call.
#[test]
fn control_calls_with_no_index_of_their_own_collapse_into_one_slot() {
    let body = fixture("09-parallel-function-calls.sse");
    let mut accumulator = ToolCallAccumulator::new();
    for payload in data_payloads(&body) {
        let value: Value = serde_json::from_str(&payload).unwrap();
        let Some(parts) = value["candidates"][0]["content"]["parts"].as_array() else {
            continue;
        };
        for call in parts.iter().filter_map(|part| part.get("functionCall")) {
            // The wire carries no index, so the naive delta carries none
            // either — and forwarding it as a streaming fragment, which is what
            // skipping this adapter's own slot allocation amounts to, folds
            // every call into the one the accumulator last touched.
            accumulator.push(
                &json!({
                    "type": "function",
                    "function": {
                        "name": call["name"],
                        "arguments": call["args"].to_string(),
                    },
                }),
                ToolCallShape::Fragment,
            );
        }
    }
    let outcomes = accumulator.finish();
    assert_eq!(outcomes.len(), 1, "three calls became one: {outcomes:?}");
    assert!(
        matches!(
            &outcomes[0],
            ToolCallOutcome::Malformed {
                reason: MalformedToolCall::UnparseableArguments,
                ..
            }
        ),
        "and its arguments are three concatenated objects: {outcomes:?}"
    );
}

// ---------------------------------------------------------------------------
// Cross-cutting
// ---------------------------------------------------------------------------

#[tokio::test]
async fn no_fixture_ever_leaks_backend_vocabulary_into_an_error_or_a_degradation() {
    // conventions.md §0.3: the UI branches on capability flags and reads
    // provider-neutral text. None of this API's own vocabulary may reach it.
    const FORBIDDEN: [&str; 8] = [
        "candidates",
        "promptFeedback",
        "finishReason",
        "HARM_CATEGORY",
        "usageMetadata",
        "functionCall",
        "gemini",
        "generativelanguage",
    ];
    for name in [
        "01-thinking-function-call.sse",
        "02-prompt-safety-block.sse",
        "03-answer-safety-block.sse",
        "04-malformed-frames.sse",
        "05-truncated-no-finish-reason.sse",
        "07-leaked-think-markup.sse",
        "08-malformed-function-call.sse",
    ] {
        let (_, response) =
            replay(&fixture(name), 7, ask("hello").with_tools([weather_tool()])).await;
        let rendered = match &response {
            Ok(response) => serde_json::to_string(&response.degradations).unwrap(),
            Err(error) => {
                // The endpoint *identity* is excluded from this scan, and only
                // it. It is the URL the user typed into their own settings —
                // `…/models/gemini-fixture` here — so it necessarily contains
                // whatever vendor and model name they configured, and hiding it
                // from them would defeat the one diagnostic a user with three
                // candidates actually needs. §0.3 is about this API's *wire*
                // vocabulary reaching the UI, which is what everything else in
                // the rendering is checked for.
                let rendered = format!("{error}");
                match error.endpoint() {
                    Some(endpoint) => rendered.replace(&endpoint.to_string(), "<endpoint>"),
                    None => rendered,
                }
            }
        };
        for token in FORBIDDEN {
            assert!(
                !rendered.contains(token),
                "{name}: `{token}` reached the UI surface: {rendered}"
            );
        }
    }
}

#[tokio::test]
async fn every_fixture_terminates_the_event_stream_exactly_once() {
    for name in [
        "01-thinking-function-call.sse",
        "02-prompt-safety-block.sse",
        "03-answer-safety-block.sse",
        "04-malformed-frames.sse",
        "05-truncated-no-finish-reason.sse",
        "06-structured-json.sse",
        "07-leaked-think-markup.sse",
        "08-malformed-function-call.sse",
        "09-parallel-function-calls.sse",
    ] {
        for chunk in CHUNK_SIZES {
            let (sink, _) = replay(
                &fixture(name),
                chunk,
                ask("hi").with_tools([weather_tool()]),
            )
            .await;
            let terminal = sink
                .events
                .iter()
                .filter(|event| event.is_terminal())
                .count();
            assert_eq!(
                terminal, 1,
                "{name} at chunk {chunk}: a consumer waiting on the terminal event must get \
                 exactly one, on every path"
            );
            assert!(
                sink.events.last().is_some_and(StreamEvent::is_terminal),
                "{name} at chunk {chunk}: and it must be last"
            );
        }
    }
}
