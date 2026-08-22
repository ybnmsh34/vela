//! **Parallel tool calls: the streamed and the non-streamed path must agree.**
//!
//! This file is the regression recipe GATE M Part 1 (Phase B) FINDING 1 asked
//! for, verbatim (`docs/regression-baseline/phase-b-matrix/RESULTS.md` §3):
//!
//! * two elements, each with `id`, `type: "function"`, a `name` and complete
//!   `arguments`, **no `index` on either**, through `complete(…)` → two
//!   `ToolCallOutcome::Ok`;
//! * the streamed equivalent → the same two calls;
//! * `hostile` non-streamed → two `Malformed`, one `UnparseableArguments` and
//!   one `UnknownDiscriminator`, arguments **not** concatenated.
//!
//! The defect it pins: a streaming `delta.tool_calls[]` element is a FRAGMENT
//! keyed by `index`, while a non-streamed `message.tool_calls[]` element is a
//! WHOLE CALL that carries no `index` at all, because `index` is a
//! streaming-only concept. Feeding both to the one "no index means continue the
//! last slot" rule collapsed N parallel calls into slot 0: the first `id` and
//! `name` won, the `arguments` strings were concatenated into a string that
//! never existed on the wire, and N-1 calls vanished with nothing saying so.
//!
//! # Honesty (conventions.md §10)
//!
//! **Every result in this file is VERIFIED-BY-FAKE.** The bodies below are
//! scripted bytes in the published OpenAI-compatible shape, played through the
//! real provider over the scriptable transport. The `hostile` body is copied
//! byte-for-byte out of the recorded gate transcript
//! (`docs/regression-baseline/phase-b-matrix/hostile/02-tool-calling.txt`), which
//! a deterministic mock produced. **Not one byte here came from a language
//! model**, and nothing here is evidence about a real endpoint.

use std::sync::Arc;

use serde_json::{json, Value};

use vela_core::credential::Auth;
use vela_core::provider::{ProviderDescriptor, ProviderKind};
use vela_providers::event::CollectingSink;
use vela_providers::http::testing::{CannedResponse, ScriptedTransport};
use vela_providers::openai_compatible::OpenAiCompatibleProvider;
use vela_providers::{
    ChatMessage, ChatRequest, ChatResponse, Degradation, MalformedToolCall, Provider,
    ProviderResult, RequestContext, ToolCallOutcome, ToolDefinition,
};
use vela_secrets::MemoryStore;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

fn provider(transport: ScriptedTransport) -> OpenAiCompatibleProvider {
    OpenAiCompatibleProvider::new(
        ProviderDescriptor::new("scripted", "Scripted", ProviderKind::Local).expect("valid"),
        // Never dialled: the transport is scripted.
        "http://127.0.0.1:1/v1",
        Auth::None,
        Arc::new(MemoryStore::new()),
        Arc::new(transport),
    )
}

fn request() -> ChatRequest {
    ChatRequest::new("mock-model")
        .with_message(ChatMessage::user("weather in Berlin and Paris"))
        .with_tools([ToolDefinition::new(
            "get_weather",
            "Current weather for a city",
            json!({
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"]
            }),
        )])
}

/// One whole non-streamed body through `complete(…)` — the path FINDING 1 broke.
async fn complete_body(body: &str) -> ProviderResult<ChatResponse> {
    provider(ScriptedTransport::ok(body))
        .complete(request(), &RequestContext::new())
        .await
}

/// The same request streamed, through `stream(…)`.
async fn stream_frames(frames: Vec<&str>) -> ProviderResult<ChatResponse> {
    let mut sink = CollectingSink::new();
    provider(ScriptedTransport::new(vec![Ok(CannedResponse::sse(
        frames,
    ))]))
    .stream(request(), &mut sink, &RequestContext::new())
    .await
}

/// `(name, arguments)` for every call, executable or not — the shape the two
/// transports have to agree on.
fn describe(calls: &[ToolCallOutcome]) -> Vec<String> {
    calls
        .iter()
        .map(|call| match call {
            ToolCallOutcome::Ok {
                call_id,
                name,
                arguments,
                ..
            } => format!("OK id={call_id} name={name} args={arguments}"),
            ToolCallOutcome::Malformed {
                call_id,
                name,
                raw_arguments,
                reason,
                ..
            } => format!(
                "MALFORMED id={} name={} reason={reason:?} raw={raw_arguments:?}",
                call_id.as_deref().unwrap_or("MISSING"),
                name.as_deref().unwrap_or("MISSING"),
            ),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// The wire bodies
// ---------------------------------------------------------------------------

/// Two well-formed parallel calls, non-streamed. Note what is *absent*: neither
/// element carries `index`, because the non-streamed shape has no such field.
fn parallel_whole_body() -> String {
    json!({
        "id": "chatcmpl-parallel",
        "object": "chat.completion",
        "created": 1_700_000_000_u64,
        "model": "mock-model",
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": Value::Null,
                "tool_calls": [
                    {"id": "call_a", "type": "function", "function": {
                        "name": "get_weather", "arguments": "{\"city\":\"berlin\"}"}},
                    {"id": "call_b", "type": "function", "function": {
                        "name": "get_weather", "arguments": "{\"city\":\"paris\"}"}}
                ]
            },
            "finish_reason": "tool_calls"
        }],
        "usage": {"prompt_tokens": 9, "completion_tokens": 9, "total_tokens": 18}
    })
    .to_string()
}

/// The same two calls streamed: fragments, keyed by `index`.
const PARALLEL_STREAM: [&str; 4] = [
    "data: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\"arguments\":\"{\\\"city\\\":\\\"berlin\\\"}\"}}]}}]}\n\n",
    "data: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"call_b\",\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\"arguments\":\"{\\\"city\\\":\\\"paris\\\"}\"}}]}}]}\n\n",
    "data: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
    "data: [DONE]\n\n",
];

/// Copied out of the recorded `hostile` transcript: two *broken* calls in one
/// non-streamed body — the first with truncated arguments, the second with a
/// misspelled discriminator and no id.
fn hostile_whole_body() -> String {
    json!({
        "id": "chatcmpl-mock-c16f5968",
        "object": "chat.completion",
        "created": 1_700_000_000_u64,
        "model": "mock-hostile",
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "Mock hostile reply.",
                "tool_calls": [
                    {"type": "function", "function": {
                        "name": "get_weather", "arguments": "{\"city\":\"del"},
                     "id": "call_c16f5968"},
                    {"type": "funktion", "function": {
                        "name": "get_weather", "arguments": "not-json-at-all"}}
                ]
            },
            "finish_reason": "tool_calls"
        }],
        "usage": {"prompt_tokens": 12, "completion_tokens": 98, "total_tokens": 110}
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Part 1 — two whole calls with no `index` are two calls
// ---------------------------------------------------------------------------

#[tokio::test]
async fn two_parallel_calls_with_no_index_come_back_as_two_executable_calls() {
    let response = complete_body(&parallel_whole_body())
        .await
        .expect("a 200 body");
    let calls = &response.tool_calls;
    assert_eq!(
        calls.len(),
        2,
        "each element of `message.tool_calls` is a whole call: {:#?}",
        describe(calls)
    );
    assert_eq!(
        calls,
        &[
            ToolCallOutcome::Ok {
                call_id: "call_a".into(),
                name: "get_weather".into(),
                arguments: json!({"city": "berlin"}),
                emulated: false,
            },
            ToolCallOutcome::Ok {
                call_id: "call_b".into(),
                name: "get_weather".into(),
                arguments: json!({"city": "paris"}),
                emulated: false,
            }
        ]
    );
    assert_eq!(response.executable_tool_calls().count(), 2);
    assert!(
        !response
            .degradations
            .iter()
            .any(|d| matches!(d, Degradation::MalformedToolCalls { .. })),
        "nothing was malformed: {:?}",
        response.degradations
    );
}

// ---------------------------------------------------------------------------
// Part 2 — the streamed equivalent, and the invariant that joins them
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_streamed_equivalent_reports_the_same_two_calls() {
    let response = stream_frames(PARALLEL_STREAM.to_vec())
        .await
        .expect("a 200 stream");
    assert_eq!(
        response.tool_calls.len(),
        2,
        "{:#?}",
        describe(&response.tool_calls)
    );
    assert_eq!(response.executable_tool_calls().count(), 2);
}

#[tokio::test]
async fn streamed_and_non_streamed_agree_on_the_same_endpoint_answer() {
    // The invariant `CompletionAssembler`'s doc comment claims: one endpoint,
    // one answer, whichever transport asked for it. Same count, same ids, same
    // names, same arguments.
    let whole = complete_body(&parallel_whole_body())
        .await
        .expect("a 200 body");
    let streamed = stream_frames(PARALLEL_STREAM.to_vec())
        .await
        .expect("a 200 stream");
    assert_eq!(
        describe(&whole.tool_calls),
        describe(&streamed.tool_calls),
        "the two paths must not diverge"
    );
    assert_eq!(whole.stop_reason, streamed.stop_reason);
}

// ---------------------------------------------------------------------------
// Part 3 — hostile, non-streamed: two broken calls stay two broken calls
// ---------------------------------------------------------------------------

#[tokio::test]
async fn two_broken_calls_in_one_body_are_both_reported_and_neither_is_spliced() {
    let response = complete_body(&hostile_whole_body())
        .await
        .expect("a 200 body");
    let calls = &response.tool_calls;
    assert_eq!(
        calls.len(),
        2,
        "neither broken call is dropped: {:#?}",
        describe(calls)
    );

    match &calls[0] {
        ToolCallOutcome::Malformed {
            call_id,
            name,
            raw_arguments,
            reason,
            ..
        } => {
            assert_eq!(call_id.as_deref(), Some("call_c16f5968"));
            assert_eq!(name.as_deref(), Some("get_weather"));
            assert_eq!(
                *reason,
                MalformedToolCall::UnparseableArguments,
                "truncated arguments are unparseable — not the *other* call's bad `type`"
            );
            assert_eq!(
                raw_arguments, "{\"city\":\"del",
                "the evidence shown to the user is what arrived, not a splice of two calls"
            );
        }
        other => panic!("expected the truncated call to be malformed: {other:?}"),
    }

    match &calls[1] {
        ToolCallOutcome::Malformed {
            call_id,
            raw_arguments,
            reason,
            ..
        } => {
            assert_eq!(call_id.as_deref(), None, "this one carried no id");
            assert_eq!(*reason, MalformedToolCall::UnknownDiscriminator);
            assert_eq!(raw_arguments, "not-json-at-all");
        }
        other => panic!("expected the `funktion` call to be malformed: {other:?}"),
    }

    // KEEP: nothing executes on a bad reconstruction, and the loss is declared.
    assert_eq!(response.executable_tool_calls().count(), 0);
    assert!(
        response
            .degradations
            .contains(&Degradation::MalformedToolCalls { count: 2 }),
        "both failures are counted: {:?}",
        response.degradations
    );
}

// ---------------------------------------------------------------------------
// Control — the streaming rule this fix must NOT have broken
// ---------------------------------------------------------------------------

#[tokio::test]
async fn control_an_unindexed_streaming_fragment_still_continues_its_call() {
    // MEASURED-4, verbatim from `hostile`: the name arrives in a delta with no
    // `index` at all and belongs to the call whose `index` arrives next. If
    // "no index opens a new slot" had been applied to the streaming path too,
    // this would be two calls and the name would be orphaned.
    let response = stream_frames(vec![
        "data: {\"id\":\"c\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"function\":{\"name\":\"get_weather\"}}]}}]}\n\n",
        "data: {\"id\":\"c\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"arguments\":\"{\\\"city\\\":\\\"berlin\\\"}\"}}]}}]}\n\n",
        "data: [DONE]\n\n",
    ])
    .await
    .expect("a 200 stream");
    assert_eq!(
        response.tool_calls,
        vec![ToolCallOutcome::Ok {
            call_id: "call_1".into(),
            name: "get_weather".into(),
            arguments: json!({"city": "berlin"}),
            emulated: false,
        }],
        "one call, with the name that arrived unindexed"
    );
}
