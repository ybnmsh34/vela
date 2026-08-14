//! **The end-to-end gate for the dual local endpoint.**
//!
//! Every test here opens a real loopback socket, writes real HTTP/1.1 bytes at
//! it, and reads the real bytes back. Nothing is stubbed between the request
//! line and the brain: the router, the bearer check, both decoders, the tool
//! policy and both SSE encoders are the shipped ones.
//!
//! That distinction matters in this repository. `cargo test -p vela-endpoint`'s
//! unit tests are **VERIFIED-BY-FAKE** — they call functions with values. These
//! are not: the port is real, the framing is real, and the SSE bytes are parsed
//! back with `vela_providers::sse::SseDecoder`, which is the same decoder Vela
//! uses on responses from other people's servers. If the frames this endpoint
//! writes were malformed, that decoder would not reassemble them.
//!
//! What is still a fake: the **brain**. No model is contacted and no llama.cpp
//! server is touched. What each test asserts about a model's behaviour is
//! whatever the closure it installed was told to do.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use vela_endpoint::brain::FnBrain;
use vela_endpoint::policy::ToolRequest;
use vela_endpoint::server::{serve, EndpointConfig, ServerHandle};
use vela_endpoint::Brain;
use vela_providers::model::{ChatRequest, ChatResponse, ContentPart, StopReason, ToolChoice};
use vela_providers::sse::{SseDecoder, SseFrame};
use vela_providers::{EventSink, StreamEvent};

const KEY: &str = "sk-vela-test-key";

/// Every turn the brain was asked to run, in order. The one place a test can
/// check what actually reached the model side of the translation.
type Seen = Arc<Mutex<Vec<ChatRequest>>>;

/// A brain that streams `text` in two deltas and then finishes, recording what
/// it was asked.
fn recording_brain(text: &'static str) -> (Arc<dyn Brain>, Seen) {
    let seen: Seen = Arc::new(Mutex::new(Vec::new()));
    let recorder = Arc::clone(&seen);
    let brain = FnBrain::new(
        vec!["vela-local".to_string()],
        move |request: ChatRequest, sink: &mut dyn EventSink| {
            recorder
                .lock()
                .expect("the recorder mutex must not be poisoned")
                .push(request);

            let (head, tail) = text.split_at(text.len() / 2);
            sink.emit(StreamEvent::TextDelta {
                text: head.to_string(),
            });
            sink.emit(StreamEvent::TextDelta {
                text: tail.to_string(),
            });

            let mut response = ChatResponse::empty();
            response.parts.push(ContentPart::text(text));
            response.stop_reason = StopReason::EndTurn;
            sink.emit(StreamEvent::Done {
                response: Box::new(response.clone()),
            });
            Ok(response)
        },
    );
    (Arc::new(brain), seen)
}

fn start(bind: &str, tools: ToolRequest, brain: Arc<dyn Brain>) -> ServerHandle {
    serve(
        EndpointConfig {
            bind: bind.parse().expect("test bind address must parse"),
            api_key: KEY.to_string(),
            tools,
        },
        brain,
    )
    .expect("the endpoint must come up")
}

struct Response {
    status: u16,
    body: String,
}

impl Response {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body)
            .unwrap_or_else(|e| panic!("body was not JSON ({e}): {}", self.body))
    }
}

/// One real HTTP/1.1 exchange. Writes the bytes by hand so that nothing about
/// the framing is taken on trust from a client library.
fn call(
    address: SocketAddr,
    method: &str,
    path: &str,
    bearer: Option<&str>,
    body: Option<&str>,
) -> Response {
    let mut stream = TcpStream::connect(address).expect("the endpoint must accept a connection");
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .expect("a test must not hang forever");

    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: {address}\r\n");
    if let Some(bearer) = bearer {
        request.push_str(&format!("Authorization: Bearer {bearer}\r\n"));
    }
    match body {
        Some(body) => {
            request.push_str(&format!(
                "Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            ));
        }
        None => request.push_str("\r\n"),
    }
    stream
        .write_all(request.as_bytes())
        .expect("the request must reach the endpoint");
    stream.flush().expect("the request must flush");

    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .expect("the endpoint must answer and close");
    let raw = String::from_utf8_lossy(&raw).into_owned();

    let (head, body) = raw
        .split_once("\r\n\r\n")
        .unwrap_or_else(|| panic!("no header terminator in: {raw}"));
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split(' ').nth(1))
        .and_then(|code| code.parse().ok())
        .unwrap_or_else(|| panic!("no status in: {head}"));

    Response {
        status,
        body: body.to_string(),
    }
}

/// The SSE bytes of a response, parsed back with Vela's own decoder.
fn frames(body: &str) -> Vec<SseFrame> {
    let mut decoder = SseDecoder::new();
    let mut frames = decoder.push(body.as_bytes());
    frames.extend(decoder.finish());
    frames
}

fn event_names(frames: &[SseFrame]) -> Vec<String> {
    frames
        .iter()
        .map(|frame| frame.event.clone().unwrap_or_default())
        .collect()
}

/* -------------------------------------------------------------------------- */

#[test]
fn both_dialects_answer_on_one_port_with_one_key() {
    // The whole track's premise, on a real socket: two clients that share
    // nothing but a port and a bearer token, both served.
    let (brain, seen) = recording_brain("hello there");
    let handle = start("127.0.0.1:0", ToolRequest::Default, brain);

    let anthropic = call(
        handle.address(),
        "POST",
        "/v1/messages",
        Some(KEY),
        Some(
            &json!({
                "model": "vela-local",
                "max_tokens": 64,
                "messages": [{"role": "user", "content": "hi"}]
            })
            .to_string(),
        ),
    );
    assert_eq!(anthropic.status, 200);
    let body = anthropic.json();
    assert_eq!(body["type"], "message");
    assert_eq!(body["content"][0]["text"], "hello there");

    let openai = call(
        handle.address(),
        "POST",
        "/v1/chat/completions",
        Some(KEY),
        Some(
            &json!({
                "model": "vela-local",
                "messages": [{"role": "user", "content": "hi"}]
            })
            .to_string(),
        ),
    );
    assert_eq!(openai.status, 200);
    let body = openai.json();
    assert_eq!(body["object"], "chat.completion");
    assert_eq!(body["choices"][0]["message"]["content"], "hello there");

    let seen = seen.lock().expect("recorder");
    assert_eq!(seen.len(), 2, "both dialects must have reached the brain");
    assert_eq!(
        seen[0].messages, seen[1].messages,
        "the same conversation through either door must reach the model identically"
    );
}

#[test]
fn a_streamed_anthropic_turn_arrives_as_the_documented_event_sequence() {
    let (brain, _) = recording_brain("hello");
    let handle = start("127.0.0.1:0", ToolRequest::Default, brain);

    let response = call(
        handle.address(),
        "POST",
        "/v1/messages",
        Some(KEY),
        Some(
            &json!({
                "model": "vela-local",
                "max_tokens": 64,
                "stream": true,
                "messages": [{"role": "user", "content": "hi"}]
            })
            .to_string(),
        ),
    );
    assert_eq!(response.status, 200);

    let frames = frames(&response.body);
    assert_eq!(
        event_names(&frames),
        vec![
            "message_start",
            "content_block_start",
            "content_block_delta",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop",
        ],
        "the SSE event names the study confirms, on the wire"
    );

    let text: String = frames
        .iter()
        .filter(|frame| frame.event.as_deref() == Some("content_block_delta"))
        .map(|frame| {
            let data: Value = serde_json::from_str(&frame.data).expect("frame data must be JSON");
            data["delta"]["text"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        })
        .collect();
    assert_eq!(text, "hello", "the deltas must reassemble into the answer");
}

#[test]
fn a_streamed_openai_turn_is_chunks_and_a_done_sentinel() {
    let (brain, _) = recording_brain("hello");
    let handle = start("127.0.0.1:0", ToolRequest::Default, brain);

    let response = call(
        handle.address(),
        "POST",
        "/v1/chat/completions",
        Some(KEY),
        Some(
            &json!({
                "model": "vela-local",
                "stream": true,
                "messages": [{"role": "user", "content": "hi"}]
            })
            .to_string(),
        ),
    );
    assert_eq!(response.status, 200);

    let frames = frames(&response.body);
    assert!(
        frames.iter().all(|frame| frame.event.is_none()),
        "this dialect names no SSE events"
    );
    let last = frames.last().expect("there must be frames");
    assert!(last.is_done_hint(), "an OpenAI client waits for [DONE]");

    let text: String = frames
        .iter()
        .filter(|frame| !frame.is_done_hint())
        .filter_map(|frame| serde_json::from_str::<Value>(&frame.data).ok())
        .filter_map(|chunk| {
            chunk["choices"][0]["delta"]["content"]
                .as_str()
                .map(str::to_string)
        })
        .collect();
    assert_eq!(text, "hello");
}

/* ------------------------------------------------------------ the security */

#[test]
fn a_policy_with_tools_off_strips_them_however_the_request_body_asks() {
    // **The process-level hard override, on the wire.** The body offers a tool,
    // demands one with `tool_choice`, and asks for tools explicitly with an
    // `enable_tools` flag. None of it reaches the model.
    let (brain, seen) = recording_brain("ok");
    let handle = start("127.0.0.1:0", ToolRequest::Disable, brain);
    assert!(!handle.policy().tools_enabled());

    let body = json!({
        "model": "vela-local",
        "max_tokens": 64,
        "enable_tools": true,
        "messages": [{"role": "user", "content": "run ls"}],
        "tools": [{"name": "bash", "description": "run", "input_schema": {"type": "object"}}],
        "tool_choice": {"type": "any"}
    })
    .to_string();

    let response = call(
        handle.address(),
        "POST",
        "/v1/messages",
        Some(KEY),
        Some(&body),
    );
    assert_eq!(
        response.status, 200,
        "the turn is served, just without tools"
    );

    let seen = seen.lock().expect("recorder");
    assert_eq!(seen.len(), 1);
    assert!(
        seen[0].tools.is_empty(),
        "a request body must not be able to put a tool in front of the model"
    );
    assert_eq!(
        seen[0].tool_choice,
        ToolChoice::None,
        "the choice must be stripped with the catalogue, not left demanding one"
    );
}

#[test]
fn the_same_request_does_carry_its_tools_when_the_policy_allows_them() {
    // Non-vacuity for the test above: the tools it asserts absent are tools
    // this endpoint really does forward when the policy says it may. Without
    // this, a decoder that silently dropped every tool would pass that test.
    let (brain, seen) = recording_brain("ok");
    let handle = start("127.0.0.1:0", ToolRequest::Default, brain);
    assert!(
        handle.policy().tools_enabled(),
        "loopback defaults tools on"
    );

    let body = json!({
        "model": "vela-local",
        "max_tokens": 64,
        "messages": [{"role": "user", "content": "run ls"}],
        "tools": [{"name": "bash", "description": "run", "input_schema": {"type": "object"}}],
        "tool_choice": {"type": "any"}
    })
    .to_string();

    let response = call(
        handle.address(),
        "POST",
        "/v1/messages",
        Some(KEY),
        Some(&body),
    );
    assert_eq!(response.status, 200);

    let seen = seen.lock().expect("recorder");
    assert_eq!(seen[0].tools.len(), 1);
    assert_eq!(seen[0].tools[0].name, "bash");
    assert_eq!(
        seen[0].tool_choice,
        ToolChoice::Required,
        "Anthropic's `any` is Vela's `Required` — the confirmed mapping row"
    );
}

#[test]
fn binding_the_wildcard_address_turns_tools_off_by_itself() {
    // The rule the reference states and the study confirms verbatim: a leaked
    // key on a network-exposed port is remote code execution, so `0.0.0.0`
    // means tools off with no flag involved.
    //
    // This binds the wildcard for the duration of one assertion and stops. It
    // is the only test in the workspace that binds anything but loopback, and
    // it is here because the alternative — asserting the rule against a
    // constructed policy and never against `serve` — would leave "does the
    // server derive its policy from what it actually bound" untested, which is
    // exactly where this class of defect lives.
    let (brain, _) = recording_brain("ok");
    let handle = start("0.0.0.0:0", ToolRequest::Default, brain);
    assert!(
        !handle.policy().tools_enabled(),
        "a server that binds 0.0.0.0 with tools enabled is a defect"
    );
    handle.stop();
}

/* ------------------------------------------------------------------- auth */

#[test]
fn neither_dialect_answers_without_the_key() {
    let (brain, seen) = recording_brain("ok");
    let handle = start("127.0.0.1:0", ToolRequest::Default, brain);

    for (path, body) in [
        (
            "/v1/messages",
            json!({"model": "m", "max_tokens": 8, "messages": []}).to_string(),
        ),
        (
            "/v1/chat/completions",
            json!({"model": "m", "messages": []}).to_string(),
        ),
    ] {
        let missing = call(handle.address(), "POST", path, None, Some(&body));
        assert_eq!(missing.status, 401, "{path} answered without a key");

        let wrong = call(
            handle.address(),
            "POST",
            path,
            Some("sk-not-the-key"),
            Some(&body),
        );
        assert_eq!(wrong.status, 401, "{path} accepted the wrong key");
    }

    assert!(
        seen.lock().expect("recorder").is_empty(),
        "an unauthenticated request must never reach the brain"
    );
}

#[test]
fn the_model_list_answers_before_any_turn_is_sent() {
    let (brain, _) = recording_brain("ok");
    let handle = start("127.0.0.1:0", ToolRequest::Default, brain);

    let response = call(handle.address(), "GET", "/v1/models", Some(KEY), None);
    assert_eq!(response.status, 200);
    assert_eq!(response.json()["data"][0]["id"], "vela-local");

    assert_eq!(
        call(handle.address(), "GET", "/v1/models", None, None).status,
        401
    );
}

#[test]
fn an_unbuilt_path_says_so_rather_than_looking_like_a_wrong_base_url() {
    let (brain, _) = recording_brain("ok");
    let handle = start("127.0.0.1:0", ToolRequest::Default, brain);

    let responses = call(
        handle.address(),
        "POST",
        "/v1/responses",
        Some(KEY),
        Some("{}"),
    );
    assert_eq!(
        responses.status, 501,
        "/v1/responses is routed and not built; a 404 would read as a base-URL mistake"
    );

    let missing = call(handle.address(), "POST", "/v1/nope", Some(KEY), Some("{}"));
    assert_eq!(missing.status, 404);

    let wrong_method = call(handle.address(), "GET", "/v1/messages", Some(KEY), None);
    assert_eq!(wrong_method.status, 405);
}

#[test]
fn a_body_this_endpoint_cannot_read_is_refused_in_the_callers_own_dialect() {
    let (brain, seen) = recording_brain("ok");
    let handle = start("127.0.0.1:0", ToolRequest::Default, brain);

    let anthropic = call(
        handle.address(),
        "POST",
        "/v1/messages",
        Some(KEY),
        Some(
            r#"{"model":"m","messages":[{"role":"user","content":"hi"}],
                "tool_choice":{"type":"whatever"}}"#,
        ),
    );
    assert_eq!(anthropic.status, 400);
    assert_eq!(
        anthropic.json()["error"]["message"],
        "invalid_request_tool_choice",
        "an Anthropic client must get an Anthropic-shaped error object"
    );

    let openai = call(
        handle.address(),
        "POST",
        "/v1/chat/completions",
        Some(KEY),
        Some(r#"{"messages":[]}"#),
    );
    assert_eq!(openai.status, 400);
    assert_eq!(
        openai.json()["error"]["code"],
        "invalid_request_missing_model"
    );

    assert!(seen.lock().expect("recorder").is_empty());
}

#[test]
fn the_base_urls_this_endpoint_hands_out_are_the_ones_that_actually_work() {
    // The base_url asymmetry, checked against the running server rather than
    // against a string. The Anthropic base URL plus the SDK's own path, and the
    // OpenAI base URL plus the SDK's own path, must both be served.
    let (brain, _) = recording_brain("ok");
    let handle = start("127.0.0.1:0", ToolRequest::Default, brain);

    let origin = format!("http://{}", handle.address());
    let anthropic_base = handle.client_base_url(vela_endpoint::Dialect::Anthropic);
    let openai_base = handle.client_base_url(vela_endpoint::Dialect::OpenAi);
    assert_eq!(
        anthropic_base, origin,
        "the Anthropic SDK takes a bare origin"
    );
    assert_eq!(
        openai_base,
        format!("{origin}/v1"),
        "the OpenAI SDK's base_url must carry /v1 — see route::client_base_url for what is assumed"
    );

    let anthropic_path = format!("{anthropic_base}/v1/messages")
        .strip_prefix(&origin)
        .expect("the base URL is built from the origin")
        .to_string();
    let openai_path = format!("{openai_base}/chat/completions")
        .strip_prefix(&origin)
        .expect("the base URL is built from the origin")
        .to_string();

    for path in [anthropic_path, openai_path] {
        let response = call(
            handle.address(),
            "POST",
            &path,
            Some(KEY),
            Some(
                &json!({"model": "m", "max_tokens": 8,
                         "messages": [{"role": "user", "content": "hi"}]})
                .to_string(),
            ),
        );
        assert_eq!(
            response.status, 200,
            "{path} must be served by the base URL this endpoint advertises"
        );
    }
}

#[test]
fn a_provider_failure_becomes_a_code_and_never_the_diagnosis() {
    // The `Diagnosis` carries the URL Vela addressed and the endpoint's own
    // words. Neither may cross this port.
    let brain: Arc<dyn Brain> = Arc::new(FnBrain::new(vec![], |_, _| {
        Err(vela_providers::ProviderError::Transport {
            failure: vela_providers::TransportFailure::Connect,
            diagnosis: vela_providers::diagnostic::Diagnosis::local(
                vela_providers::diagnostic::Cause::ConnectionFailed,
            ),
        })
    }));
    let handle = start("127.0.0.1:0", ToolRequest::Default, brain);

    let response = call(
        handle.address(),
        "POST",
        "/v1/chat/completions",
        Some(KEY),
        Some(&json!({"model": "m", "messages": [{"role": "user", "content": "hi"}]}).to_string()),
    );
    assert_eq!(response.status, 502);
    assert_eq!(response.json()["error"]["code"], "upstream_unreachable");
    assert!(
        !response.body.contains("correlation"),
        "no diagnosis field may reach a foreign client: {}",
        response.body
    );
}
