//! **GATE M Part 1, from Vela's side.**
//!
//! Every test in this file starts one of the four capability-matrix profiles as
//! a real OS process, listening on a real loopback port, and drives it with
//! Vela's real HTTP client through Vela's real provider layer. Nothing is
//! stubbed between `ChatRequest` and the socket.
//!
//! # Honesty (conventions.md §10)
//!
//! **Every result here is VERIFIED-BY-FAKE.** The four servers are
//! deterministic mocks; not one byte comes from a language model. These tests
//! prove that Vela survives *the recorded behaviour of endpoints that break in
//! the ways the matrix documents*. They prove nothing about a real llama.cpp
//! model — GATE M Part 2, which is unreachable from this container.
//!
//! # What each test is for
//!
//! The gate criterion is: a piece FAILS if, under any profile, it crashes,
//! hangs, silently produces wrong output, or offers an affordance the profile
//! cannot support. Each test below attacks one of those four.

use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use vela_core::credential::Auth;
use vela_core::provider::{ProviderDescriptor, ProviderKind};
use vela_providers::capability::{ModelCapabilities, Support};
use vela_providers::event::CollectingSink;
use vela_providers::http::ReqwestTransport;
use vela_providers::openai_compatible::{OpenAiCompatibleProvider, ProviderOptions};
use vela_providers::{
    Candidate, ChatMessage, ChatRequest, ContentPart, Degradation, MalformedToolCall, MessageRole,
    Provider, ProviderError, RequestContext, ResponseFormat, RetryPolicy, Router, StopReason,
    StructuredOutputPolicy, Timeouts, ToolCallOutcome, ToolChoice, ToolDefinition,
};
use vela_secrets::MemoryStore;

// ---------------------------------------------------------------------------
// Harness control
// ---------------------------------------------------------------------------

/// A live mock-provider process. Killed on drop, so a failing assertion never
/// leaves a listener behind.
struct MockServer {
    child: Child,
    url: String,
}

impl MockServer {
    async fn start(profile: &str, extra: &[&str]) -> Self {
        let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(3)
            .expect("crates/<name> sits three levels below the repo root")
            .to_path_buf();
        let cli = repo_root.join("tests/harness/mock-provider/src/cli.ts");
        assert!(cli.exists(), "mock harness missing at {}", cli.display());

        let mut command = Command::new("node");
        command
            .arg(&cli)
            .arg("--profile")
            .arg(profile)
            // Port 0: the OS picks a free one and the CLI prints the URL, so
            // parallel tests cannot collide on a hard-coded port.
            .arg("--port")
            .arg("0")
            .args(extra)
            .current_dir(&repo_root)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = command.spawn().unwrap_or_else(|error| {
            panic!(
                "could not start the mock harness ({error}). \
                 These tests need Node 22+ on PATH; see docs/regression-baseline/mock-matrix/README.md"
            )
        });

        let stdout = child.stdout.take().expect("piped");
        let mut lines = BufReader::new(stdout).lines();
        let url = tokio::time::timeout(Duration::from_secs(30), async {
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(at) = line.find("listening on ") {
                    return line[at + "listening on ".len()..].trim().to_owned();
                }
            }
            panic!("the mock harness exited before it reported a URL");
        })
        .await
        .expect("the mock harness did not start within 30 s");

        Self { child, url }
    }

    async fn stop(mut self) {
        let _ = self.child.kill().await;
    }
}

fn provider_for(url: &str) -> OpenAiCompatibleProvider {
    OpenAiCompatibleProvider::new(
        ProviderDescriptor::new("matrix", "Capability matrix", ProviderKind::Local).unwrap(),
        format!("{url}/v1"),
        // No credential at all — the state most local runtimes are in, and a
        // first-class one in Vela.
        Auth::None,
        Arc::new(MemoryStore::new()),
        Arc::new(ReqwestTransport::new().expect("http client builds")),
    )
}

/// Deadlines used by every test here. Short on purpose: the recorded naive
/// consumers hung for 5003 ms and 5006 ms, so a test that would hang must fail
/// *faster* than that to be worth anything.
fn context() -> RequestContext {
    RequestContext::new().with_timeouts(Timeouts {
        connect: Duration::from_secs(5),
        first_byte: Duration::from_secs(10),
        stall: Duration::from_secs(3),
    })
}

fn user(text: &str) -> ChatRequest {
    ChatRequest::new("").with_message(ChatMessage::user(text))
}

fn weather_tool() -> ToolDefinition {
    ToolDefinition::new(
        "get_weather",
        "Current weather for a city",
        serde_json::json!({
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"]
        }),
    )
}

// ---------------------------------------------------------------------------
// MEASURED-1 — end-of-body is the only terminator
// ---------------------------------------------------------------------------

/// `hostile` never sends `[DONE]`. A consumer that waits for it timed out at
/// 5003 ms. Vela must finish on end-of-body, and say that the sentinel was
/// missing rather than pretending it arrived.
#[tokio::test]
async fn a_stream_with_no_done_sentinel_finishes_on_end_of_body() {
    let server = MockServer::start("hostile", &[]).await;
    let provider = provider_for(&server.url);
    let mut sink = CollectingSink::new();

    let started = Instant::now();
    let response = tokio::time::timeout(
        Duration::from_secs(10),
        provider.stream(
            user("what is the weather in Berlin").with_max_output_tokens(256),
            &mut sink,
            &context(),
        ),
    )
    .await
    .expect("HANG: the stream never terminated")
    .expect("the turn must complete");
    let elapsed = started.elapsed();

    assert!(
        elapsed < Duration::from_secs(3),
        "finished in {elapsed:?}; the recorded naive consumer hung for 5003 ms and \
         anything near that means Vela is waiting for something too"
    );
    assert!(
        response
            .degradations
            .contains(&Degradation::NoTerminationSentinel),
        "the missing sentinel must be reported, not silently absorbed: {:?}",
        response.degradations
    );
    assert!(
        response
            .degradations
            .contains(&Degradation::UsageNotReported),
        "include_usage was accepted and never honoured; that is a degradation: {:?}",
        response.degradations
    );
    assert!(response.usage.is_unreported(), "no usage may be invented");
    server.stop().await;
}

/// `small-local` accepts `stream_options.include_usage` and never sends the
/// frame. Asking for usage must never become a reason to wait.
#[tokio::test]
async fn requested_usage_that_never_arrives_does_not_hang_the_turn() {
    let server = MockServer::start("small-local", &[]).await;
    let provider = provider_for(&server.url);
    let mut sink = CollectingSink::new();

    let response = tokio::time::timeout(
        Duration::from_secs(8),
        provider.stream(user("hello there"), &mut sink, &context()),
    )
    .await
    .expect("HANG: waiting for a usage frame that never comes")
    .unwrap();

    assert!(response
        .degradations
        .contains(&Degradation::UsageNotReported));
    assert!(!sink.text().is_empty(), "the answer still arrived");
    server.stop().await;
}

// ---------------------------------------------------------------------------
// MEASURED-2 — malformed frames cost one frame
// ---------------------------------------------------------------------------

/// The recorded naive consumer threw on `hostile`'s fourth frame and delivered
/// 31 of 349 characters. Vela must deliver everything that arrived.
#[tokio::test]
async fn unparseable_frames_do_not_cost_the_answer() {
    let server = MockServer::start("hostile", &[]).await;
    let provider = provider_for(&server.url);

    // The same question, streamed and not streamed. The non-streamed body is
    // the ground truth for what the endpoint meant to say.
    let mut sink = CollectingSink::new();
    let streamed = provider
        .stream(user("what is the weather in Berlin"), &mut sink, &context())
        .await
        .unwrap();
    let whole = provider
        .complete(user("what is the weather in Berlin"), &context())
        .await
        .unwrap();

    let skipped = streamed
        .degradations
        .iter()
        .find_map(|degradation| match degradation {
            Degradation::MalformedFramesSkipped { count } => Some(*count),
            _ => None,
        })
        .expect("hostile emits frames that are not JSON; skipping them must be reported");
    assert!(skipped >= 3, "expected several bad frames, saw {skipped}");

    let streamed_text = streamed.answer_text();
    let whole_text = whole.answer_text();
    assert!(
        !streamed_text.is_empty(),
        "DATA LOSS: nothing survived the malformed frames"
    );
    // The tail of the answer arrives *after* the bad frames, so its presence is
    // the proof that one bad frame did not end the stream.
    let tail: String = whole_text.chars().rev().take(20).collect();
    let tail: String = tail.chars().rev().collect();
    assert!(
        streamed_text.contains(tail.trim()),
        "content after the malformed frames was lost.\n streamed: {streamed_text:?}\n whole:    {whole_text:?}"
    );
    server.stop().await;
}

// ---------------------------------------------------------------------------
// MEASURED-3 — reasoning separation across frame boundaries
// ---------------------------------------------------------------------------

/// `mid-local` splits `</think>` across two frames. A per-frame stripper leaked
/// all of it; the gate recorded the leak verbatim.
#[tokio::test]
async fn reasoning_split_across_frames_never_reaches_the_answer() {
    let server = MockServer::start("mid-local", &[]).await;
    let provider = provider_for(&server.url);
    let mut sink = CollectingSink::new();

    let response = provider
        .stream(user("what is the weather in Berlin"), &mut sink, &context())
        .await
        .unwrap();

    let answer = response.answer_text();
    assert!(
        !answer.contains("think") && !answer.contains('<'),
        "LEAK: reasoning markup reached the user: {answer:?}"
    );
    assert!(
        answer.contains("Mock mid-local reply to:"),
        "the actual answer must survive: {answer:?}"
    );
    assert!(
        response
            .reasoning_text()
            .contains("Considering the request"),
        "the reasoning must be kept, separately: {:?}",
        response.reasoning_text()
    );
    // Reasoning is a distinct content part, not a prefix of the text.
    assert!(
        response
            .parts
            .iter()
            .any(|part| matches!(part, ContentPart::Reasoning { .. })),
        "reasoning must be stored as its own part: {:?}",
        response.parts
    );
    assert_eq!(sink.text(), answer, "the deltas and the result agree");
    server.stop().await;
}

/// `hostile` opens `<think>` twice, never closes it, and puts junk inside. The
/// answer is inside that unterminated block; it must not be swallowed.
#[tokio::test]
async fn an_unterminated_reasoning_block_does_not_swallow_the_answer() {
    let server = MockServer::start("hostile", &[]).await;
    let provider = provider_for(&server.url);
    let mut sink = CollectingSink::new();

    let response = provider
        .stream(user("what is the weather in Berlin"), &mut sink, &context())
        .await
        .unwrap();

    let answer = response.answer_text();
    assert!(
        answer.contains("Mock hostile reply to:"),
        "the answer was swallowed by an unterminated <think>: {answer:?}"
    );
    assert!(
        !answer.contains("<think>"),
        "markup leaked into the answer: {answer:?}"
    );
    assert!(
        response
            .degradations
            .iter()
            .any(|d| matches!(d, Degradation::UnterminatedReasoning { .. })),
        "the recovery must be declared, not silent: {:?}",
        response.degradations
    );
    server.stop().await;
}

/// `frontier` puts reasoning in a separate `reasoning_content` field. Both
/// transports must land in the same place.
#[tokio::test]
async fn reasoning_from_a_dedicated_field_is_separated_the_same_way() {
    let server = MockServer::start("frontier", &[]).await;
    let provider = provider_for(&server.url);
    let mut sink = CollectingSink::new();

    let response = provider
        .stream(user("what is the weather in Berlin"), &mut sink, &context())
        .await
        .unwrap();

    assert!(!response.reasoning_text().is_empty());
    assert!(response.answer_text().contains("Mock frontier reply to:"));
    assert!(
        !response.answer_text().contains("Considering the request"),
        "reasoning must never appear in the answer channel"
    );
    assert!(
        !sink.reasoning().is_empty(),
        "and it streams as its own event"
    );
    server.stop().await;
}

// ---------------------------------------------------------------------------
// MEASURED-4 — defensive tool-call accumulation
// ---------------------------------------------------------------------------

/// `hostile` emits a call whose name has no index, whose arguments are cut off
/// mid-JSON, and a second with no id, index 7 and `type: "funktion"`. Neither
/// may crash Vela, be silently dropped, or be executed.
#[tokio::test]
async fn malformed_tool_calls_are_surfaced_as_failed_calls() {
    let server = MockServer::start("hostile", &[]).await;
    let provider = provider_for(&server.url);
    let mut sink = CollectingSink::new();

    let response = provider
        .stream(
            user("what is the weather in Berlin")
                .with_tools([weather_tool()])
                .with_tool_choice(ToolChoice::Required),
            &mut sink,
            &context(),
        )
        .await
        .expect("broken tool calls must not fail the turn");

    assert_eq!(
        response.tool_calls.len(),
        2,
        "both calls must be reported: {:#?}",
        response.tool_calls
    );
    assert_eq!(
        response.executable_tool_calls().count(),
        0,
        "NOTHING here is safe to execute: {:#?}",
        response.tool_calls
    );
    let reasons: Vec<MalformedToolCall> = response
        .tool_calls
        .iter()
        .filter_map(|call| match call {
            ToolCallOutcome::Malformed { reason, .. } => Some(*reason),
            _ => None,
        })
        .collect();
    assert!(
        reasons.contains(&MalformedToolCall::UnparseableArguments),
        "the truncated-arguments call must be reported as such: {reasons:?}"
    );
    assert!(
        reasons.contains(&MalformedToolCall::UnknownDiscriminator),
        "`funktion` must be reported as such: {reasons:?}"
    );
    // The name that arrived with no index at all must not have been lost.
    assert!(
        response.tool_calls.iter().any(|call| matches!(
            call,
            ToolCallOutcome::Malformed { name: Some(name), .. } if name == "get_weather"
        )),
        "the unindexed name was dropped: {:#?}",
        response.tool_calls
    );
    assert!(response
        .degradations
        .iter()
        .any(|d| matches!(d, Degradation::MalformedToolCalls { .. })));
    server.stop().await;
}

/// `frontier` and `mid-local` do it properly, and Vela must not treat a working
/// endpoint as a suspicious one.
#[tokio::test]
async fn a_well_formed_native_tool_call_is_executable() {
    for profile in ["frontier", "mid-local"] {
        let server = MockServer::start(profile, &[]).await;
        let provider = provider_for(&server.url);
        let response = provider
            .complete(
                user("what is the weather in Berlin")
                    .with_tools([weather_tool()])
                    .with_tool_choice(ToolChoice::Required),
                &context(),
            )
            .await
            .unwrap();

        let calls: Vec<&ToolCallOutcome> = response.executable_tool_calls().collect();
        assert_eq!(calls.len(), 1, "{profile}: {:#?}", response.tool_calls);
        match calls[0] {
            ToolCallOutcome::Ok {
                name,
                arguments,
                emulated,
                ..
            } => {
                assert_eq!(name, "get_weather", "{profile}");
                assert!(arguments.is_object(), "{profile}");
                assert!(
                    !emulated,
                    "{profile}: this endpoint has native tool calling"
                );
            }
            other => panic!("{profile}: {other:?}"),
        }
        assert_eq!(response.stop_reason, StopReason::ToolUse, "{profile}");
        server.stop().await;
    }
}

// ---------------------------------------------------------------------------
// Parallel tool calls, live, on both transports (GATE M Part 1 Phase B FINDING 1)
// ---------------------------------------------------------------------------

/// The second offered tool. Deliberately a different name and a different
/// parameter shape from `weather_tool`: if a batch collapses into one slot, the
/// survivor is missing a name an assertion can point at. Two calls to the *same*
/// tool would collapse into something that still looks plausible, which is how
/// FINDING 1 stayed hidden through a green suite.
fn time_tool() -> ToolDefinition {
    ToolDefinition::new(
        "get_local_time",
        "Current local time for a timezone",
        serde_json::json!({
            "type": "object",
            "properties": {"timezone": {"type": "string"}},
            "required": ["timezone"]
        }),
    )
}

/// Everything about a reported call **except** the wire index: id, name, and
/// the arguments (or, for a malformed call, its reason and the raw evidence
/// string). The index is excluded on purpose — it is a streaming-only field, so
/// the two transports legitimately differ there and nowhere else.
fn without_wire_index(calls: &[ToolCallOutcome]) -> Vec<String> {
    calls
        .iter()
        .map(|call| match call {
            ToolCallOutcome::Ok {
                call_id,
                name,
                arguments,
                emulated,
            } => format!("ok id={call_id} name={name} args={arguments} emulated={emulated}"),
            ToolCallOutcome::Malformed {
                call_id,
                name,
                raw_arguments,
                reason,
                ..
            } => format!(
                "malformed id={} name={} reason={reason:?} raw={raw_arguments}",
                call_id.as_deref().unwrap_or("-"),
                name.as_deref().unwrap_or("-")
            ),
        })
        .collect()
}

/// Two tools offered, so the endpoint answers with a *batch* — the commonest
/// tool-calling shape in the wild, and the one no profile could emit until the
/// harness grew case 13/14.
///
/// This is the test that joins the two halves of the FINDING 1 fix: the harness
/// emits the batch in both wire shapes (`message.tool_calls[]` with no `index`
/// anywhere, `delta.tool_calls[]` keyed by one), and the accumulator has to tell
/// them apart. Before the fix the non-streamed side came back as a single
/// `Malformed` call whose evidence string was two calls' arguments spliced
/// together.
#[tokio::test]
async fn parallel_tool_calls_survive_both_transports_on_a_live_endpoint() {
    for profile in ["frontier", "mid-local"] {
        let server = MockServer::start(profile, &[]).await;
        let provider = provider_for(&server.url);
        let ask = || {
            user("what is the weather in Berlin and what time is it there")
                .with_tools([weather_tool(), time_tool()])
                .with_tool_choice(ToolChoice::Required)
        };

        let whole = provider.complete(ask(), &context()).await.unwrap();
        let mut sink = CollectingSink::new();
        let streamed = provider.stream(ask(), &mut sink, &context()).await.unwrap();

        for (transport, response) in [("non-streamed", &whole), ("streamed", &streamed)] {
            let executable: Vec<&ToolCallOutcome> = response.executable_tool_calls().collect();
            assert_eq!(
                executable.len(),
                2,
                "{profile}/{transport}: two offered tools must yield two executable calls, \
                 not a batch collapsed into one: {:#?}",
                response.tool_calls
            );
            let names: Vec<&str> = executable
                .iter()
                .filter_map(|call| match call {
                    ToolCallOutcome::Ok { name, .. } => Some(name.as_str()),
                    _ => None,
                })
                .collect();
            assert_eq!(
                names,
                vec!["get_weather", "get_local_time"],
                "{profile}/{transport}: both calls keep their own name"
            );
            let ids: Vec<&str> = executable
                .iter()
                .filter_map(|call| match call {
                    ToolCallOutcome::Ok { call_id, .. } => Some(call_id.as_str()),
                    _ => None,
                })
                .collect();
            assert_ne!(ids[0], ids[1], "{profile}/{transport}: ids must stay apart");
            assert!(
                !response
                    .degradations
                    .iter()
                    .any(|d| matches!(d, Degradation::MalformedToolCalls { .. })),
                "{profile}/{transport}: a well-formed batch is not a degradation: {:#?}",
                response.degradations
            );
            assert_eq!(
                response.stop_reason,
                StopReason::ToolUse,
                "{profile}/{transport}"
            );
        }

        assert_eq!(
            without_wire_index(&whole.tool_calls),
            without_wire_index(&streamed.tool_calls),
            "{profile}: one endpoint answer, two transports, two different reports"
        );
        server.stop().await;
    }
}

/// `hostile` answers a two-tool request with *three* calls of which only the
/// middle one is broken. That mixture is what makes a lost call detectable: a
/// consumer that merges the batch reports one malformed call and the two good
/// ones have visibly vanished, rather than never having existed.
#[tokio::test]
async fn a_partly_broken_parallel_batch_loses_neither_the_good_calls_nor_the_bad_one() {
    let server = MockServer::start("hostile", &[]).await;
    let provider = provider_for(&server.url);
    let ask = || {
        user("what is the weather in Berlin and what time is it there")
            .with_tools([weather_tool(), time_tool()])
            .with_tool_choice(ToolChoice::Required)
    };

    let whole = provider.complete(ask(), &context()).await.unwrap();
    let mut sink = CollectingSink::new();
    let streamed = provider.stream(ask(), &mut sink, &context()).await.unwrap();

    for (transport, response) in [("non-streamed", &whole), ("streamed", &streamed)] {
        assert_eq!(
            response.tool_calls.len(),
            3,
            "{profile}/{transport}: the socket carried three calls: {:#?}",
            response.tool_calls,
            profile = "hostile"
        );
        assert_eq!(
            response.executable_tool_calls().count(),
            2,
            "hostile/{transport}: the two well-formed calls stay executable: {:#?}",
            response.tool_calls
        );
        let broken: Vec<&ToolCallOutcome> = response
            .tool_calls
            .iter()
            .filter(|call| matches!(call, ToolCallOutcome::Malformed { .. }))
            .collect();
        assert_eq!(broken.len(), 1, "hostile/{transport}: {broken:#?}");
        match broken[0] {
            ToolCallOutcome::Malformed {
                reason,
                raw_arguments,
                name,
                ..
            } => {
                assert_eq!(
                    *reason,
                    MalformedToolCall::UnknownDiscriminator,
                    "hostile/{transport}: `funktion` is the reported reason"
                );
                assert_eq!(
                    name.as_deref(),
                    Some("get_local_time"),
                    "hostile/{transport}"
                );
                // The evidence string is this call's own bytes and nothing
                // else. The exact text is a function of the request (the mock
                // samples arguments from the schema and truncates them), so it
                // is characterised rather than hard-coded: a truncated prefix of
                // *this* call's arguments, carrying nothing from either
                // neighbour. `city`/`unit` belong to `get_weather`, and their
                // presence here would be the splice FINDING 1 reported.
                assert!(
                    raw_arguments.starts_with("{\"timezone\":"),
                    "hostile/{transport}: raw evidence is this call's own prefix: {raw_arguments:?}"
                );
                assert!(
                    !raw_arguments.contains("city") && !raw_arguments.contains("unit"),
                    "hostile/{transport}: a neighbour's arguments were spliced in: {raw_arguments:?}"
                );
                assert!(
                    serde_json::from_str::<serde_json::Value>(raw_arguments).is_err(),
                    "hostile/{transport}: this call really is truncated: {raw_arguments:?}"
                );
            }
            other => panic!("hostile/{transport}: {other:?}"),
        }
    }

    assert_eq!(
        without_wire_index(&whole.tool_calls),
        without_wire_index(&streamed.tool_calls),
        "hostile: one endpoint answer, two transports, two different reports"
    );
    server.stop().await;
}

// ---------------------------------------------------------------------------
// Degradation: tool-call emulation, end to end against small-local
// ---------------------------------------------------------------------------

/// `small-local` has no tool calling at all and answers `400
/// tools_not_supported` — even with `tool_choice: "none"` (FINDING 6).
///
/// This is the whole emulation path, live: the refusal is learned, the
/// catalogue moves into the prompt, the request goes back without a `tools`
/// array, and the textual call in the answer is parsed back into an executable
/// call — with the markup stripped out of what the user sees.
///
/// The endpoint echoes part of the prompt back, which is what lets a *mock*
/// produce a tool call at all. That is the honest limit of this test: it proves
/// the request rewriting, the round trip and the parser, not that any model
/// would choose to emit a call.
#[tokio::test]
async fn tool_calling_is_emulated_end_to_end_on_an_endpoint_that_has_none() {
    let server = MockServer::start("small-local", &[]).await;
    let provider = provider_for(&server.url);

    // Control: this endpoint really does refuse a native tools request.
    let native_only = provider_for(&server.url).with_options(ProviderOptions {
        emulate_tools: false,
        ..ProviderOptions::default()
    });
    let refusal = native_only
        .complete(
            user("weather?")
                .with_tools([weather_tool()])
                .with_tool_choice(ToolChoice::Required),
            &context(),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(
            refusal,
            ProviderError::CapabilityUnsupported {
                capability: vela_providers::Capability::ToolCalling,
                ..
            }
        ),
        "control failed — the endpoint accepted tools: {refusal:?}"
    );

    // The real path. The prompt carries a call in the shape a small model
    // writes it (no quotes at all), and the endpoint echoes it back.
    let response = provider
        .complete(
            user("<tool_call>{name: echo_tool, arguments: {text: ok}}</tool_call>")
                .with_tools([ToolDefinition::new(
                    "echo_tool",
                    "Echo some text",
                    serde_json::json!({"type": "object", "properties": {"text": {"type": "string"}}}),
                )])
                .with_tool_choice(ToolChoice::Auto),
            &context(),
        )
        .await
        .expect("emulation must degrade the turn, not fail it");

    let calls: Vec<&ToolCallOutcome> = response.executable_tool_calls().collect();
    assert_eq!(
        calls.len(),
        1,
        "the textual call was not recovered: {:#?} / answer {:?}",
        response.tool_calls,
        response.answer_text()
    );
    match calls[0] {
        ToolCallOutcome::Ok {
            name,
            arguments,
            emulated,
            ..
        } => {
            assert_eq!(name, "echo_tool");
            assert_eq!(arguments["text"], "ok");
            assert!(*emulated, "the UI must be able to say this was emulated");
        }
        other => panic!("{other:?}"),
    }
    assert!(
        !response.answer_text().contains("tool_call"),
        "call markup must never reach the user: {:?}",
        response.answer_text()
    );
    assert!(response
        .degradations
        .iter()
        .any(|d| matches!(d, Degradation::ToolCallingEmulated { .. })));
    assert_eq!(response.stop_reason, StopReason::ToolUse);
    server.stop().await;
}

// ---------------------------------------------------------------------------
// MEASURED-5 — structured output, the silent one
// ---------------------------------------------------------------------------

/// Three of four profiles answer 200 with prose and say nothing about it. Vela
/// must never hand that back as if it conformed.
#[tokio::test]
async fn structured_output_that_is_silently_ignored_is_reported_explicitly() {
    let schema = serde_json::json!({
        "type": "object",
        "properties": {"city": {"type": "string"}, "celsius": {"type": "number"}},
        "required": ["city", "celsius"]
    });

    for profile in ["mid-local", "small-local", "hostile"] {
        let server = MockServer::start(profile, &[]).await;
        let provider = provider_for(&server.url);
        let model_id = format!("mock-{profile}");
        let response = provider
            .complete(
                ChatRequest::new(&model_id)
                    .with_message(ChatMessage::user("give me the weather as JSON"))
                    .with_response_format(ResponseFormat::JsonSchema {
                        name: "weather".into(),
                        schema: schema.clone(),
                    }),
                &context(),
            )
            .await
            .unwrap();

        match response
            .structured
            .as_ref()
            .expect("structured output was requested, so a verdict is mandatory")
        {
            Ok(value) => panic!("{profile}: prose was presented as conforming JSON: {value}"),
            Err(mismatch) => assert!(
                !mismatch.detail.is_empty(),
                "{profile}: the mismatch must say something true"
            ),
        }
        assert!(
            response
                .degradations
                .iter()
                .any(|d| matches!(d, Degradation::StructuredOutputMismatch { .. })),
            "{profile}: the failure must be a reported degradation: {:?}",
            response.degradations
        );

        // And having learned it, the affordance is withdrawn: the same request
        // is now refused before it is sent, rather than silently mis-answered.
        assert_eq!(
            provider.known_capabilities(&model_id).structured_output,
            Support::Degraded,
            "{profile}: the endpoint's behaviour must be remembered"
        );
        server.stop().await;
    }
}

/// `frontier` honours the schema, so the same request must succeed — otherwise
/// "we refuse structured output" would be a blanket refusal rather than a
/// capability decision.
#[tokio::test]
async fn structured_output_that_is_honoured_comes_back_validated() {
    let server = MockServer::start("frontier", &[]).await;
    let provider = provider_for(&server.url);
    let schema = serde_json::json!({
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"]
    });
    let response = provider
        .complete(
            user("give me the weather as JSON").with_response_format(ResponseFormat::JsonSchema {
                name: "weather".into(),
                schema,
            }),
            &context(),
        )
        .await
        .unwrap();

    let value = response
        .structured
        .as_ref()
        .expect("requested")
        .as_ref()
        .expect("frontier honours the schema");
    assert!(value.get("city").is_some(), "{value}");
    server.stop().await;
}

/// With the refusing policy and a probed-bad model, the affordance is not
/// offered at all: the request never leaves the machine.
#[tokio::test]
async fn a_probed_model_that_ignores_schemas_can_refuse_the_affordance_outright() {
    let server = MockServer::start("small-local", &[]).await;
    let provider = provider_for(&server.url).with_options(ProviderOptions {
        structured_output: StructuredOutputPolicy::Refuse,
        ..ProviderOptions::default()
    });

    let capabilities = provider
        .probe_capabilities("mock-small-local", &context())
        .await
        .unwrap();
    assert_eq!(
        capabilities.structured_output,
        Support::Degraded,
        "probing is the only way to learn this: {:#?}",
        capabilities.findings
    );
    assert!(
        !capabilities.honours_structured_output(),
        "and a degraded schema capability must not be offered"
    );

    let error = provider
        .complete(
            ChatRequest::new("mock-small-local")
                .with_message(ChatMessage::user("json please"))
                .with_response_format(ResponseFormat::JsonSchema {
                    name: "x".into(),
                    schema: serde_json::json!({"type": "object"}),
                }),
            &context(),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        ProviderError::CapabilityUnsupported {
            capability: vela_providers::Capability::StructuredOutput,
            ..
        }
    ));
    server.stop().await;
}

// ---------------------------------------------------------------------------
// Capability probing across the whole matrix
// ---------------------------------------------------------------------------

/// One probe per profile, and the answers must differ in exactly the ways the
/// matrix documents. This is the test that would fail if capabilities were
/// assumed from a provider name instead of measured.
#[tokio::test]
async fn probing_recovers_the_matrix_row_for_every_profile() {
    let expectations: [(&str, &str, u32, Support, Support, Support); 4] = [
        // profile, model id, window, tools, vision, structured
        (
            "frontier",
            "mock-frontier",
            200_000,
            Support::Supported,
            Support::Supported,
            Support::Supported,
        ),
        (
            "mid-local",
            "mock-mid-local",
            32_768,
            Support::Supported,
            Support::Unsupported,
            Support::Degraded,
        ),
        (
            "small-local",
            "mock-small-local",
            8_192,
            Support::Unsupported,
            Support::Unsupported,
            Support::Degraded,
        ),
        (
            "hostile",
            "mock-hostile",
            4_096,
            Support::Degraded,
            Support::Unsupported,
            Support::Degraded,
        ),
    ];

    for (profile, model_id, window, tools, vision, structured) in expectations {
        let server = MockServer::start(profile, &[]).await;
        let provider = provider_for(&server.url);
        let capabilities = provider
            .probe_capabilities(model_id, &context())
            .await
            .unwrap_or_else(|error| panic!("{profile}: probing failed: {error}"));

        assert_eq!(
            capabilities.context_window_tokens,
            Some(window),
            "{profile}: the declared context window"
        );
        assert_eq!(capabilities.tool_calling, tools, "{profile}: tool calling");
        assert_eq!(capabilities.vision, vision, "{profile}: vision");
        assert_eq!(
            capabilities.structured_output, structured,
            "{profile}: structured output — findings {:#?}",
            capabilities.findings
        );
        assert_eq!(
            capabilities.model_listing,
            Support::Supported,
            "{profile}: all four list their model"
        );

        // The flag set the UI reads carries no backend identity at all.
        let descriptor = capabilities.to_descriptor();
        assert_eq!(
            descriptor.vision,
            vision == Support::Supported,
            "{profile}: the image affordance follows the probe"
        );
        assert!(
            !serde_json::to_string(&descriptor)
                .unwrap()
                .contains(profile),
            "{profile}: a provider name must never reach the UI flag set"
        );
        server.stop().await;
    }
}

// ---------------------------------------------------------------------------
// Explicit refusals
// ---------------------------------------------------------------------------

/// An image to a profile with no vision. The first attempt learns it from the
/// endpoint's 400; the second is refused locally, without a request.
#[tokio::test]
async fn an_image_sent_to_a_model_with_no_vision_is_refused_explicitly() {
    let server = MockServer::start("mid-local", &[]).await;
    let provider = provider_for(&server.url);

    let with_image = || {
        ChatRequest::new("mock-mid-local").with_message(ChatMessage::new(
            MessageRole::User,
            vec![
                ContentPart::text("what is in this image?"),
                ContentPart::Image {
                    mime_type: "image/png".into(),
                    data: vec![0x89, 0x50, 0x4e, 0x47],
                },
            ],
        ))
    };

    let error = provider
        .complete(with_image(), &context())
        .await
        .unwrap_err();
    assert!(
        matches!(
            error,
            ProviderError::CapabilityUnsupported {
                capability: vela_providers::Capability::Vision,
                ..
            }
        ),
        "a vision refusal must not surface as a generic 400: {error:?}"
    );
    assert!(
        !error.allows_failover(),
        "and it must not be shopped around to other backends"
    );
    server.stop().await;
}

/// Context overflow is the one thing all four profiles do cleanly. Vela must
/// carry the numbers through so the UI can say something true.
#[tokio::test]
async fn a_context_overflow_carries_the_endpoints_own_numbers() {
    let server = MockServer::start("small-local", &[]).await;
    let provider = provider_for(&server.url);

    // No local planning: `max_context_tokens` is unset, so the endpoint decides.
    let error = provider
        .complete(user(&"x".repeat(40_000)), &context())
        .await
        .unwrap_err();

    match error {
        ProviderError::ContextLengthExceeded {
            limit_tokens,
            requested_tokens,
            ..
        } => {
            assert_eq!(limit_tokens, Some(8_192), "small-local's real window");
            assert!(requested_tokens.unwrap() > 8_192);
        }
        other => panic!("expected a clean context error, got {other:?}"),
    }
    server.stop().await;
}

/// When the window *is* known, the same conversation is reduced before it is
/// sent — visibly — instead of being refused by the endpoint.
#[tokio::test]
async fn a_conversation_that_will_not_fit_is_reduced_visibly_rather_than_refused() {
    let server = MockServer::start("small-local", &[]).await;
    let provider = provider_for(&server.url);

    let mut request = ChatRequest::new("mock-small-local").with_max_context_tokens(8_192);
    for turn in 0..12 {
        request = request
            .with_message(ChatMessage::user(format!(
                "turn {turn}: {}",
                "y".repeat(3_000)
            )))
            .with_message(ChatMessage::assistant("understood"));
    }
    request = request.with_message(ChatMessage::user("finally: what did I ask first?"));

    let response = provider
        .complete(request, &context())
        .await
        .expect("a too-long conversation must be reduced, not refused");

    let reduced = response
        .degradations
        .iter()
        .find_map(|degradation| match degradation {
            Degradation::ContextReduced {
                dropped_messages, ..
            } => Some(*dropped_messages),
            _ => None,
        })
        .expect("the reduction must be reported");
    assert!(reduced > 0, "something was dropped and said so");
    assert!(
        response
            .answer_text()
            .contains("Mock small-local reply to:"),
        "and the turn still produced an answer"
    );
    server.stop().await;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/// No credential configured: no `Authorization` header at all, and every
/// profile answers 200. An empty `Bearer` would be answered 401
/// `empty_authorization_header`, so a green result here is the proof.
#[tokio::test]
async fn every_profile_answers_a_request_that_carries_no_credential() {
    for profile in ["frontier", "mid-local", "small-local", "hostile"] {
        let server = MockServer::start(profile, &[]).await;
        let provider = provider_for(&server.url);
        let response = provider
            .complete(user("hello"), &context())
            .await
            .unwrap_or_else(|error| panic!("{profile}: a no-auth request failed: {error}"));
        assert!(!response.answer_text().is_empty(), "{profile}");
        server.stop().await;
    }
}

/// The same client against an endpoint that *does* require a key. The 401 must
/// arrive as `AuthFailed`, and must never be retried or failed over.
#[tokio::test]
async fn a_missing_required_credential_is_an_auth_failure_that_is_never_retried() {
    let server = MockServer::start("frontier", &["--api-key", "expected-key"]).await;
    let provider = provider_for(&server.url);

    let error = provider
        .complete(user("hello"), &context())
        .await
        .unwrap_err();
    assert!(
        matches!(error, ProviderError::AuthFailed { .. }),
        "got {error:?}"
    );
    assert!(!error.allows_retry() && !error.allows_failover());
    server.stop().await;
}

// ---------------------------------------------------------------------------
// Routing, failover, cancellation
// ---------------------------------------------------------------------------

/// A dead endpoint first, a live one second. The transport failure fails over;
/// the answer comes from the second candidate and says a failover happened.
#[tokio::test]
async fn a_dead_candidate_fails_over_to_a_live_one() {
    let server = MockServer::start("small-local", &[]).await;

    // Port 1 is reserved and nothing listens on it: a real connection refusal.
    let dead = Arc::new(provider_for("http://127.0.0.1:1"));
    let live = Arc::new(provider_for(&server.url));
    let router = Router::new(vec![
        Candidate::new(dead, "mock-small-local"),
        Candidate::new(live, "mock-small-local"),
    ])
    .with_policy(RetryPolicy {
        max_attempts_per_candidate: 1,
        ..RetryPolicy::default()
    });

    let mut sink = CollectingSink::new();
    let response = tokio::time::timeout(
        Duration::from_secs(15),
        router.stream(user("hello"), &mut sink, &context()),
    )
    .await
    .expect("failover must not hang")
    .expect("the live candidate must answer");

    assert!(response
        .answer_text()
        .contains("Mock small-local reply to:"));
    assert!(response
        .degradations
        .iter()
        .any(|d| matches!(d, Degradation::FailedOver { .. })));
    server.stop().await;
}

/// Cancelling a live stream stops it promptly, and reports cancellation rather
/// than inventing a finished answer.
#[tokio::test]
async fn cancelling_a_live_stream_stops_it_promptly() {
    // 40 ms between frames, so the turn is still running when we cancel.
    let server = MockServer::start("frontier", &["--chunk-delay", "40"]).await;
    let provider = provider_for(&server.url);
    let context = context();
    let cancel = context.cancel.clone();

    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(120)).await;
        cancel.cancel();
    });

    let mut sink = CollectingSink::new();
    let started = Instant::now();
    let error = tokio::time::timeout(
        Duration::from_secs(10),
        provider.stream(user("write me something long"), &mut sink, &context),
    )
    .await
    .expect("cancellation must not hang")
    .unwrap_err();

    assert_eq!(error, ProviderError::Cancelled);
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "cancellation took {:?}",
        started.elapsed()
    );
    assert!(
        sink.error().is_some(),
        "the consumer is told the turn ended, and how"
    );
    server.stop().await;
}

// ---------------------------------------------------------------------------
// Equivalence
// ---------------------------------------------------------------------------

/// The same question, streamed and not. A consumer must not be able to tell
/// which path produced the answer — that property is what lets the rest of the
/// app ignore streaming entirely.
#[tokio::test]
async fn the_streamed_and_non_streamed_answers_agree_on_every_profile() {
    for profile in ["frontier", "mid-local", "small-local"] {
        let server = MockServer::start(profile, &[]).await;
        let provider = provider_for(&server.url);

        let mut sink = CollectingSink::new();
        let streamed = provider
            .stream(user("what is the weather in Berlin"), &mut sink, &context())
            .await
            .unwrap();
        let whole = provider
            .complete(user("what is the weather in Berlin"), &context())
            .await
            .unwrap();

        assert_eq!(
            streamed.answer_text(),
            whole.answer_text(),
            "{profile}: streamed and non-streamed answers differ"
        );
        assert_eq!(
            streamed.reasoning_text(),
            whole.reasoning_text(),
            "{profile}: reasoning differs between the two paths"
        );
        assert_eq!(
            sink.text(),
            streamed.answer_text(),
            "{profile}: the deltas do not add up to the answer"
        );
        server.stop().await;
    }
}

/// Model listing works on all four, and the id it reports is the one the
/// endpoint actually serves.
#[tokio::test]
async fn model_listing_returns_the_model_each_endpoint_serves() {
    for (profile, model_id) in [
        ("frontier", "mock-frontier"),
        ("mid-local", "mock-mid-local"),
        ("small-local", "mock-small-local"),
        ("hostile", "mock-hostile"),
    ] {
        let server = MockServer::start(profile, &[]).await;
        let provider = provider_for(&server.url);
        let models = provider.list_models(&context()).await.unwrap();
        assert_eq!(models.len(), 1, "{profile}");
        assert_eq!(models[0].id, model_id, "{profile}");
        server.stop().await;
    }
}

/// Asking for a model the endpoint does not serve is `model_not_found`, not a
/// generic failure — and is never failed over, because another backend having
/// the same model would be a coincidence, not a plan.
#[tokio::test]
async fn an_unknown_model_id_is_reported_as_model_not_found() {
    let server = MockServer::start("frontier", &[]).await;
    let provider = provider_for(&server.url);
    let error = provider
        .complete(
            ChatRequest::new("a-model-this-endpoint-does-not-have")
                .with_message(ChatMessage::user("hello")),
            &context(),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(error, ProviderError::ModelNotFound { .. }),
        "{error:?}"
    );
    assert!(!error.allows_failover());
    server.stop().await;
}

/// The capability probe never fabricates: a model that was never probed reports
/// `Unknown` for everything, and `Unknown` is not offerable.
#[tokio::test]
async fn an_unprobed_model_offers_nothing() {
    let server = MockServer::start("frontier", &[]).await;
    let provider = provider_for(&server.url);
    let capabilities: ModelCapabilities = provider.known_capabilities("never-probed");
    assert_eq!(capabilities.tool_calling, Support::Unknown);
    assert_eq!(
        capabilities.to_descriptor(),
        vela_core::provider::ProviderCapabilities::minimal(),
        "an unprobed model must not advertise anything"
    );
    server.stop().await;
}
