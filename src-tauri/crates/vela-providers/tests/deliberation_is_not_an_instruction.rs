//! **Phase B, round-4 panel FINDING 3 — the highest-severity defect of the run.**
//!
//! > On the OpenAI-compatible adapter — the path every local runtime
//! > (llama.cpp, Ollama, LM Studio, vLLM) uses — an unterminated `<think>`
//! > block turns deliberation into an executed tool call, and streams raw
//! > tool-call markup to the UI.
//!
//! # What this file drives
//!
//! The intersection four gate rounds missed. GATE M case 06 drives reasoning.
//! Case 02 drives tool calling. **Nothing drove them together**, and the defect
//! lived exactly in the overlap:
//!
//! * emulated tool calling is the standard path on a small local model — it is
//!   entered here *legitimately*, by a peer that answers `400
//!   tools_not_supported` to a request carrying `tools`, exactly as the
//!   `small-local` matrix profile does (GATE M FINDING 6);
//! * an unterminated `<think>` on a token limit is routine on the same models;
//! * so a model that *thought about* `delete_everything` and was cut off
//!   mid-sentence produced `tool_calls = [Ok { name: "delete_everything",
//!   arguments: {"path": "/"} }]`, `stop_reason = ToolUse`, and a `TextDelta`
//!   stream carrying the literal `<tool_call>{…}</tool_call>` markup.
//!
//! Both transports are driven, through the real
//! [`OpenAiCompatibleProvider`] over a real loopback socket with the real
//! `reqwest` transport. Nothing between `ChatRequest` and the wire is stubbed.
//!
//! # The three claims, and the control that proves they are not free
//!
//! 1. **No executable call.** Deliberation the model never finished cannot
//!    authorise an effect outside the conversation.
//! 2. **No raw markup on any `TextDelta`**, and none in the finished answer.
//! 3. **The refusal is visible.** A dropped call is the outcome MEASURED-4
//!    forbids, so it arrives as
//!    [`MalformedToolCall::RecoveredFromUnterminatedReasoning`] carrying the
//!    arguments as evidence — the same treatment a call with unparseable
//!    arguments gets.
//!
//! [`the_pre_fix_pipeline_really_did_execute_it`] is the positive control. It
//! rebuilds the removed code path out of the crate's *public* API —
//! `ReasoningSplitter::finish().recovered_answer` appended as answer text
//! without passing the stripper, then `emulation::parse_calls` over it — and
//! asserts that this really does yield an executable `delete_everything`. No
//! defect is injected into the tree to prove it (a concurrent session snapshots
//! this repo; that mistake has been made once already in this run).
//!
//! # Honesty (conventions.md §10)
//!
//! **VERIFIED-BY-FAKE.** The peer is a scripted loopback socket and the
//! `<think>` block is a fixture. Not one byte came from a language model. What
//! is proved is that Vela survives *the recorded shape* of an unterminated
//! reasoning block on an emulating endpoint. GATE M Part 2 — a real llama.cpp
//! that really runs out of tokens mid-thought — is unreachable from this
//! container and is not attempted.

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use vela_core::credential::Auth;
use vela_core::provider::{ProviderDescriptor, ProviderKind};
use vela_providers::emulation::parse_calls;
use vela_providers::event::{CollectingSink, StreamEvent};
use vela_providers::http::ReqwestTransport;
use vela_providers::openai_compatible::{OpenAiCompatibleProvider, ProviderOptions};
use vela_providers::reasoning::{ReasoningPiece, ReasoningSplitter};
use vela_providers::stream::CompletionAssembler;
use vela_providers::{
    ChatMessage, ChatRequest, ChatResponse, ContentPart, Degradation, MalformedToolCall, Provider,
    RequestContext, StopReason, Timeouts, ToolCallOutcome, ToolChoice, ToolDefinition,
};
use vela_secrets::MemoryStore;

/// The turn, verbatim from the finding. The model deliberates about a
/// destructive call, **decides against it**, and is cut off before it can close
/// the block.
const DELIBERATION: &str = concat!(
    "<think>I could call ",
    "<tool_call>{\"name\":\"delete_everything\",\"arguments\":{\"path\":\"/\"}}</tool_call>",
    " but that would be destructive, so I will not."
);

/// The prose the user must still be shown — MEASURED-3 exists so a turn whose
/// every character landed inside an unterminated block does not render empty.
const PROSE: &str = "but that would be destructive, so I will not.";

// ---------------------------------------------------------------------------
// The peer
// ---------------------------------------------------------------------------

/// A loopback endpoint that behaves like `small-local`: it refuses any request
/// carrying `tools` with `400 tools_not_supported`, and answers the retry with
/// [`DELIBERATION`].
///
/// The refusal is the point. Emulation must be entered the way it is entered in
/// production — because the endpoint said so — not by a test flag, or the whole
/// scenario is a fiction.
struct SmallLocalPeer {
    url: String,
}

impl SmallLocalPeer {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("a free port");
        let port = listener.local_addr().expect("bound").port();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut raw = Vec::new();
                    let mut scratch = vec![0u8; 16384];
                    // Read until the body is in hand. `content-length` is
                    // always present: Vela posts JSON.
                    let (head_end, length) = loop {
                        let read = match socket.read(&mut scratch).await {
                            Ok(0) | Err(_) => return,
                            Ok(read) => read,
                        };
                        raw.extend_from_slice(&scratch[..read]);
                        let text = String::from_utf8_lossy(&raw).into_owned();
                        if let Some(at) = text.find("\r\n\r\n") {
                            let length = text
                                .to_ascii_lowercase()
                                .split("\r\n")
                                .find_map(|line| {
                                    line.strip_prefix("content-length:")
                                        .and_then(|value| value.trim().parse::<usize>().ok())
                                })
                                .unwrap_or(0);
                            if raw.len() >= at + 4 + length {
                                break (at + 4, length);
                            }
                        }
                    };
                    let body =
                        String::from_utf8_lossy(&raw[head_end..head_end + length]).into_owned();

                    let response = if body.contains("\"tools\":[{") {
                        // FINDING 6's shape: a request carrying tools is
                        // refused outright, whatever `tool_choice` says.
                        let payload = "{\"error\":{\"message\":\"this model does not support tools\",\"code\":\"tools_not_supported\",\"type\":\"invalid_request_error\"}}";
                        format!(
                            "HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
                            payload.len()
                        )
                    } else if body.contains("\"stream\":true") {
                        let payload = streamed_body();
                        format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
                            payload.len()
                        )
                    } else {
                        let payload = whole_body();
                        format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
                            payload.len()
                        )
                    };
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.flush().await;
                });
            }
        });
        Self {
            url: format!("http://127.0.0.1:{port}/v1"),
        }
    }
}

/// The deliberation as SSE, fragmented **eleven characters at a time** so that
/// no single frame contains `<think>`, `<tool_call>`, or `</tool_call>` whole.
/// A per-frame stripper cannot pass this; that is MEASURED-3's recorded
/// requirement applied to the tool-call tag as well.
fn streamed_body() -> String {
    let mut out = String::new();
    let chars: Vec<char> = DELIBERATION.chars().collect();
    for piece in chars.chunks(11) {
        let text: String = piece.iter().collect();
        let escaped = serde_json::to_string(&text).expect("a string serialises");
        out.push_str(&format!(
            "data: {{\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":{escaped}}},\"finish_reason\":null}}]}}\n\n"
        ));
    }
    // `length`: the model hit its token budget mid-thought. This is the routine
    // case on a small local model, and it is why the block never closed.
    out.push_str("data: {\"id\":\"c\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"length\"}]}\n\n");
    out.push_str("data: [DONE]\n\n");
    out
}

/// The same turn as a whole `chat.completion` body — the non-streamed twin the
/// finding says "produces the same executable call".
fn whole_body() -> String {
    serde_json::json!({
        "id": "c",
        "object": "chat.completion",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": DELIBERATION},
            "finish_reason": "length",
        }],
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Driving it
// ---------------------------------------------------------------------------

fn provider(url: &str) -> OpenAiCompatibleProvider {
    OpenAiCompatibleProvider::new(
        ProviderDescriptor::new(
            "small-local",
            "Emulating local runtime",
            ProviderKind::Local,
        )
        .expect("a valid descriptor"),
        url.to_owned(),
        // No credential: the state most local runtimes are in.
        Auth::None,
        Arc::new(MemoryStore::new()),
        Arc::new(
            ReqwestTransport::with_connect_timeout(Duration::from_millis(500))
                .expect("client builds"),
        ),
    )
    .with_options(ProviderOptions {
        // The default, stated out loud: this is what makes a textual call
        // executable at all, and therefore what makes the defect reachable.
        emulate_tools: true,
        ..ProviderOptions::default()
    })
}

fn destructive_tool() -> ToolDefinition {
    ToolDefinition::new(
        "delete_everything",
        "Irreversibly delete a directory tree.",
        serde_json::json!({
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        }),
    )
}

fn turn() -> ChatRequest {
    ChatRequest::new("mock-small-local")
        .with_message(ChatMessage::user("tidy up the disk"))
        .with_tools([destructive_tool()])
        .with_tool_choice(ToolChoice::Auto)
}

fn context() -> RequestContext {
    RequestContext::new().with_timeouts(Timeouts {
        connect: Duration::from_millis(500),
        first_byte: Duration::from_secs(2),
        stall: Duration::from_secs(2),
    })
}

/// One turn through the real provider, over a real socket, on the transport
/// asked for. `complete` sinks its events into a `NullSink` by construction, so
/// only the streamed arm can return one — see [`events_of`] for how the
/// non-streamed arm's events are observed.
async fn drive(streamed: bool) -> ChatResponse {
    let peer = SmallLocalPeer::start().await;
    let provider = provider(&peer.url);
    let mut sink = CollectingSink::new();
    if streamed {
        provider.stream(turn(), &mut sink, &context()).await
    } else {
        provider.complete(turn(), &context()).await
    }
    .expect("the endpoint answered 200 after the tools refusal")
}

/// The events the UI would see, per transport.
///
/// Streamed: the real provider's own sink. Non-streamed: the *same*
/// [`CompletionAssembler`] the provider builds, fed the exact bytes the peer
/// answers a non-streamed request with. Stated plainly rather than blurred —
/// `Provider::complete` discards its events into a `NullSink`, so there is no
/// user-visible delta stream on that transport to inspect, and pretending the
/// streamed sink was it would be a lie about which path was measured.
async fn events_of(streamed: bool) -> CollectingSink {
    let mut sink = CollectingSink::new();
    if streamed {
        let peer = SmallLocalPeer::start().await;
        let provider = provider(&peer.url);
        provider
            .stream(turn(), &mut sink, &context())
            .await
            .expect("200");
    } else {
        let mut assembler = CompletionAssembler::new(false, false).with_tool_emulation();
        let body: serde_json::Value =
            serde_json::from_str(&whole_body()).expect("the peer sends JSON");
        assembler.apply_chunk(&body, &mut sink);
        assembler.finish(&mut sink).expect("a readable body");
    }
    sink
}

// ---------------------------------------------------------------------------
// The premise
// ---------------------------------------------------------------------------

/// Everything below is worthless if emulation was not actually entered, or if
/// the block actually closed. Both are asserted before anything else is.
#[tokio::test(flavor = "multi_thread")]
async fn the_scenario_is_the_one_the_finding_describes() {
    for streamed in [true, false] {
        let response = drive(streamed).await;
        assert!(
            response.degradations.iter().any(|degradation| matches!(
                degradation,
                Degradation::ToolCallingEmulated { tool_count: 1 }
            )),
            "streamed={streamed}: emulation was not entered through the endpoint's \
             own 400, so nothing this file asserts is about the real path: {:?}",
            response.degradations
        );
        assert!(
            response.degradations.iter().any(|degradation| matches!(
                degradation,
                Degradation::UnterminatedReasoning { .. }
            )),
            "streamed={streamed}: the reasoning block closed, so the defect's \
             precondition never held: {:?}",
            response.degradations
        );
    }
}

// ---------------------------------------------------------------------------
// The three claims
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_call_the_model_never_committed_to_is_not_executable_on_either_transport() {
    for streamed in [true, false] {
        let response = drive(streamed).await;
        let executable: Vec<&ToolCallOutcome> = response
            .tool_calls
            .iter()
            .filter(|call| call.is_ok())
            .collect();
        assert!(
            executable.is_empty(),
            "streamed={streamed}: deliberation became an EXECUTABLE call: {executable:?}"
        );
        assert_ne!(
            response.stop_reason,
            StopReason::ToolUse,
            "streamed={streamed}: the turn ended in `ToolUse`, so a consumer \
             branching on it would run what the model refused to ask for"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_refusal_is_visible_and_carries_its_evidence() {
    for streamed in [true, false] {
        let response = drive(streamed).await;
        assert_eq!(
            response.tool_calls.len(),
            1,
            "streamed={streamed}: a silently dropped call is the outcome \
             MEASURED-4 forbids: {:?}",
            response.tool_calls
        );
        match &response.tool_calls[0] {
            ToolCallOutcome::Malformed {
                name,
                reason,
                raw_arguments,
                ..
            } => {
                assert_eq!(name.as_deref(), Some("delete_everything"));
                assert_eq!(
                    *reason,
                    MalformedToolCall::RecoveredFromUnterminatedReasoning,
                    "streamed={streamed}: the reason must say what actually \
                     happened, not borrow a parse failure that did not occur"
                );
                assert!(
                    raw_arguments.contains("\"path\""),
                    "streamed={streamed}: the user cannot ask for the call \
                     deliberately without seeing its arguments: {raw_arguments:?}"
                );
            }
            other => panic!("streamed={streamed}: expected a reported refusal, got {other:?}"),
        }
        assert!(
            response
                .degradations
                .contains(&Degradation::MalformedToolCalls { count: 1 }),
            "streamed={streamed}: the refusal must reach the degradation ledger \
             the UI renders: {:?}",
            response.degradations
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn no_raw_tool_call_markup_reaches_the_user_on_either_transport() {
    for streamed in [true, false] {
        let response = drive(streamed).await;
        let sink = events_of(streamed).await;

        for (index, event) in sink.events.iter().enumerate() {
            if let StreamEvent::TextDelta { text } = event {
                for needle in ["<tool_call>", "</tool_call>", "delete_everything"] {
                    assert!(
                        !text.contains(needle),
                        "streamed={streamed}: TextDelta[{index}] streamed raw \
                         tool-call markup to the UI ({needle}): {text:?}"
                    );
                }
            }
        }

        let answer = response.answer_text();
        for needle in [
            "<tool_call>",
            "</tool_call>",
            "<think>",
            "delete_everything",
        ] {
            assert!(
                !answer.contains(needle),
                "streamed={streamed}: the finished answer carries {needle}: {answer:?}"
            );
        }
        assert!(
            answer.contains(PROSE),
            "streamed={streamed}: MEASURED-3 still has to hold — the user must \
             see what the model actually said: {answer:?}"
        );
        // And the answer the UI renders is the answer the events built.
        let streamed_text: String = sink
            .events
            .iter()
            .filter_map(|event| match event {
                StreamEvent::TextDelta { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            streamed_text.trim(),
            answer.trim(),
            "streamed={streamed}: the stream and the finished answer disagree"
        );
    }
}

/// The reasoning itself is kept — quarantining the call is not an excuse to
/// throw away what the model thought.
#[tokio::test(flavor = "multi_thread")]
async fn the_deliberation_is_still_reported_as_reasoning() {
    for streamed in [true, false] {
        let response = drive(streamed).await;
        let reasoning = response.reasoning_text();
        assert!(
            reasoning.contains("I could call"),
            "streamed={streamed}: the deliberation was discarded: {reasoning:?}"
        );
        assert!(
            response
                .parts
                .iter()
                .any(|part| matches!(part, ContentPart::Reasoning { .. })),
            "streamed={streamed}: reasoning must stay a distinct part"
        );
    }
}

/// The two transports must not disagree. FINDING 1 was exactly this class of
/// divergence, and the finding says the non-streamed twin produced the same
/// executable call.
#[tokio::test(flavor = "multi_thread")]
async fn the_two_transports_agree() {
    let streamed = drive(true).await;
    let whole = drive(false).await;
    assert_eq!(streamed.answer_text(), whole.answer_text());
    assert_eq!(streamed.tool_calls, whole.tool_calls);
    assert_eq!(streamed.stop_reason, whole.stop_reason);
}

// ---------------------------------------------------------------------------
// Positive control
// ---------------------------------------------------------------------------

/// **The control.** The assertions above are only worth something if the thing
/// they forbid was ever possible. This rebuilds the deleted code path out of
/// the crate's public API — the recovered answer appended as answer text
/// *without* passing the stripper, then parsed for calls, which is line for
/// line what `CompletionAssembler::finish` used to do — and asserts it really
/// does hand back an executable `delete_everything`.
///
/// Written this way on purpose: injecting the defect into the tree to watch the
/// tests go red is how a HEAD with redaction disabled got committed earlier in
/// this run. This control is permanent, runs in CI, and cannot be left switched
/// on by accident.
#[test]
fn the_pre_fix_pipeline_really_did_execute_it() {
    // 1. The splitter, driven exactly as the assembler drives it.
    let mut splitter = ReasoningSplitter::new();
    let mut answer = String::new();
    let chars: Vec<char> = DELIBERATION.chars().collect();
    for piece in chars.chunks(11) {
        let text: String = piece.iter().collect();
        for piece in splitter.push(&text) {
            if let ReasoningPiece::Answer(text) = piece {
                answer.push_str(&text);
            }
        }
    }
    let finish = splitter.finish();
    let recovered = finish
        .recovered_answer
        .expect("the premise: an unterminated block recovers an answer");

    // 2. THE BYPASS. `self.append_text(&recovered)` — straight into the answer,
    //    never through the stripper.
    answer.push_str(&recovered);
    assert!(
        answer.contains("<tool_call>"),
        "the bypass is what put raw markup in front of the user; if this no \
         longer holds the control is measuring nothing"
    );

    // 3. The `found_tagged == false` fallback, over an answer that now contains
    //    a tool call the stripper never got to see.
    let parsed = parse_calls(&answer);
    let executed: Vec<&ToolCallOutcome> = parsed.calls.iter().filter(|call| call.is_ok()).collect();
    assert_eq!(
        executed.len(),
        1,
        "the pre-fix path produced no executable call, so every assertion in \
         this file is vacuous: {:?}",
        parsed.calls
    );
    assert!(
        matches!(
            executed[0],
            ToolCallOutcome::Ok { name, emulated: true, .. } if name == "delete_everything"
        ),
        "got {:?}",
        executed[0]
    );
}
