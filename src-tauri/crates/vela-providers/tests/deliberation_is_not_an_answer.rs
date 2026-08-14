//! **FINDING 3's shape in the data channel: deliberation becoming an *answer*.**
//!
//! [`deliberation_is_not_an_instruction`](../deliberation_is_not_an_instruction.rs)
//! closed the action channel: a tool call recovered out of a reasoning block
//! the model never closed is not executable. It closed it by installing a
//! chokepoint — [`AnswerChannel::executable_text`] — and documenting it as
//! *"the only text a tool parser may see"*.
//!
//! The schema consumer is the same kind of consumer. It also turns model text
//! into a machine-actionable value, and a caller that receives `Some(Ok(v))`
//! from a schema-validated field has been told **the model produced `v`**. It
//! was left on the convention side of that chokepoint, and every schema-check
//! site validated over [`ChatResponse::answer_text`] — which, by way of the
//! method then called "AnswerChannel::into_parts", *includes* salvaged text.
//!
//! # The turn
//!
//! A model asked for JSON deliberates in JSON. That is not a contrived input;
//! it is what a model asked for JSON does. It writes a candidate object,
//! **rejects it in the prose around it**, and — on a small local model at a
//! token limit, the routine case — is cut off on `length` before it can close
//! the block:
//!
//! ```text
//! <think>The user wants an object. My first guess is
//! {"city":"Atlantis","celsius":-273.15} — no, that city does not exist and
//! that temperature is below absolute zero, so I must
//! ```
//!
//! `{"city":"Atlantis","celsius":-273.15}` **validates**. It is a well-formed
//! object with both required properties of the right types. The only thing
//! wrong with it is that the model said it was wrong, and that fact lives in
//! the prose, not in the JSON. So `structured::extract_json`'s "the first
//! balanced object in the text" finds it, `validate` passes it, and Vela
//! returns `Some(Ok({"celsius": -273.15, "city": "Atlantis"}))` — an assertion
//! that the model produced a value it explicitly refused to produce.
//!
//! # What is driven
//!
//! All three shipping adapters, both transports, through the real providers
//! over real loopback sockets speaking each dialect. Nothing between
//! `ChatRequest` and the wire is stubbed.
//!
//! # The controls
//!
//! * [`the_pre_fix_consumer_really_did_hand_back_the_rejected_value`] is the
//!   **positive control**. It rebuilds the removed consumer out of the crate's
//!   *public* API — `extract_json` over the whole visible answer, then
//!   `validate` — and asserts that this really does yield the rejected object
//!   as conforming. No defect is injected into the tree to prove it: five
//!   builders share this working tree and that mistake has been made once
//!   already in this run.
//! * [`a_committed_json_answer_still_validates`] and
//!   [`inline_json_in_a_committed_answer_is_still_found`] are the **negative
//!   controls** for the fix itself. The cheap way to make the failure go away
//!   is to stop `extract_json` scavenging; that also removes inline-JSON
//!   extraction, which real models rely on. Both are asserted to still work.
//! * [`the_schema_consumer_is_fed_from_the_chokepoint`] is the structural
//!   claim, checked over the tree the way `answer_chokepoint.rs` checks the
//!   tool consumer's.
//!
//! # Honesty (conventions.md §10)
//!
//! **VERIFIED-BY-FAKE.** The peers are scripted loopback sockets and the
//! `<think>` block is a fixture. Not one byte came from a language model. What
//! is proved is that Vela survives *the recorded shape*. GATE M Part 2 is
//! unreachable from this container and is not attempted.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use vela_core::credential::Auth;
use vela_core::provider::{ProviderDescriptor, ProviderKind};
use vela_providers::event::CollectingSink;
use vela_providers::http::ReqwestTransport;
use vela_providers::openai_compatible::OpenAiCompatibleProvider;
use vela_providers::structured;
use vela_providers::{
    AnthropicProvider, ChatMessage, ChatRequest, ChatResponse, Degradation, GoogleProvider,
    Provider, RequestContext, ResponseFormat, SchemaMismatch, Timeouts,
};
use vela_secrets::MemoryStore;

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

/// The model deliberates *in JSON*, rejects the value it wrote, and is cut off
/// before closing the block. Both halves are what a model asked for JSON does.
const DELIBERATED_JSON: &str = concat!(
    "<think>The user wants an object. My first guess is ",
    "{\"city\":\"Atlantis\",\"celsius\":-273.15}",
    " — no, that city does not exist and that temperature is below absolute zero, so I must"
);

/// The prose the user must still be shown. MEASURED-3 exists so a turn whose
/// every character landed inside an unterminated block does not render empty,
/// and quarantining the *value* is not a licence to swallow the *text*.
const SALVAGED_PROSE: &str = "does not exist";

/// The same deliberation with the block CLOSED and a real, conforming answer
/// after it. The control arm: the two turns differ by `</think>` plus an answer
/// the model actually committed to.
const COMMITTED_JSON: &str = concat!(
    "<think>The user wants an object. My first guess is ",
    "{\"city\":\"Atlantis\",\"celsius\":-273.15}",
    " — no, that city does not exist and that temperature is below absolute zero, so I must",
    "</think>",
    "{\"city\":\"Berlin\",\"celsius\":21.5}"
);

/// A committed answer that wraps its JSON in a sentence. Real models do this,
/// `extract_json` is documented to read it, and the naive way to close this
/// defect — stop scavenging — silently deletes the behaviour. Asserted so that
/// regression cannot be shipped as a fix.
const COMMITTED_INLINE_JSON: &str = concat!(
    "<think>Let me think about Berlin.</think>",
    "Here you go: {\"city\":\"Berlin\",\"celsius\":21.5} — hope that helps."
);

fn weather_schema() -> Value {
    json!({
        "type": "object",
        "properties": {"city": {"type": "string"}, "celsius": {"type": "number"}},
        "required": ["city", "celsius"]
    })
}

/// The object the model wrote down and then refused.
fn rejected() -> Value {
    json!({"city": "Atlantis", "celsius": -273.15})
}

// ---------------------------------------------------------------------------
// The peers
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Adapter {
    Compat,
    Anthropic,
    Google,
}

impl Adapter {
    const ALL: [Adapter; 3] = [Adapter::Compat, Adapter::Anthropic, Adapter::Google];

    fn label(self) -> &'static str {
        match self {
            Adapter::Compat => "openai-compatible",
            Adapter::Anthropic => "anthropic",
            Adapter::Google => "google",
        }
    }

    fn model(self) -> &'static str {
        match self {
            Adapter::Compat => "cross-compat",
            Adapter::Anthropic => "claude-cross",
            Adapter::Google => "gemini-cross",
        }
    }

    fn provider(self, base_url: &str) -> Arc<dyn Provider> {
        let transport = Arc::new(
            ReqwestTransport::with_connect_timeout(Duration::from_millis(500))
                .expect("client builds"),
        );
        let secrets = Arc::new(MemoryStore::new());
        let descriptor = ProviderDescriptor::new(
            format!("schema-{}", self.label()),
            format!("Schema-chokepoint peer ({})", self.label()),
            ProviderKind::Local,
        )
        .expect("a valid descriptor");
        match self {
            Adapter::Compat => Arc::new(OpenAiCompatibleProvider::new(
                descriptor,
                base_url.to_owned(),
                Auth::None,
                secrets,
                transport,
            )),
            Adapter::Anthropic => Arc::new(AnthropicProvider::new(
                descriptor,
                base_url.to_owned(),
                Auth::None,
                secrets,
                transport,
            )),
            Adapter::Google => Arc::new(GoogleProvider::new(
                descriptor,
                base_url.to_owned(),
                Auth::None,
                secrets,
                transport,
            )),
        }
    }

    /// A whole non-streamed answer whose assistant text is `text`.
    ///
    /// `finish` is this dialect's spelling of "the model hit its token budget",
    /// which is *why* the reasoning block never closed and is therefore part of
    /// the scenario rather than decoration.
    fn whole(self, text: &str) -> String {
        let escaped = serde_json::to_string(text).expect("a string serialises");
        match self {
            Adapter::Compat => format!(
                "{{\"id\":\"c\",\"object\":\"chat.completion\",\"choices\":[{{\"index\":0,\
                 \"message\":{{\"role\":\"assistant\",\"content\":{escaped}}},\
                 \"finish_reason\":\"length\"}}],\
                 \"usage\":{{\"prompt_tokens\":9,\"completion_tokens\":40,\"total_tokens\":49}}}}"
            ),
            Adapter::Anthropic => format!(
                "{{\"id\":\"msg_schema\",\"type\":\"message\",\"role\":\"assistant\",\
                 \"model\":\"claude-cross\",\"content\":[{{\"type\":\"text\",\"text\":{escaped}}}],\
                 \"stop_reason\":\"max_tokens\",\
                 \"usage\":{{\"input_tokens\":9,\"output_tokens\":40}}}}"
            ),
            Adapter::Google => format!(
                "{{\"candidates\":[{{\"content\":{{\"parts\":[{{\"text\":{escaped}}}],\
                 \"role\":\"model\"}},\"finishReason\":\"MAX_TOKENS\",\"index\":0}}],\
                 \"usageMetadata\":{{\"promptTokenCount\":9,\"candidatesTokenCount\":40,\
                 \"totalTokenCount\":49}},\"modelVersion\":\"gemini-cross\"}}"
            ),
        }
    }

    /// An SSE body delivering `text` in 13-character pieces, so that no single
    /// frame carries `<think>`, `</think>` or the candidate object whole.
    fn streamed(self, text: &str) -> String {
        use std::fmt::Write as _;
        let pieces: Vec<String> = text
            .chars()
            .collect::<Vec<char>>()
            .chunks(13)
            .map(|piece| piece.iter().collect())
            .collect();
        let mut out = String::new();
        match self {
            Adapter::Compat => {
                for piece in &pieces {
                    let escaped = serde_json::to_string(piece).expect("serialises");
                    let _ = write!(
                        out,
                        "data: {{\"id\":\"c\",\"object\":\"chat.completion.chunk\",\
                         \"choices\":[{{\"index\":0,\"delta\":{{\"content\":{escaped}}},\
                         \"finish_reason\":null}}]}}\n\n"
                    );
                }
                out.push_str(
                    "data: {\"id\":\"c\",\"choices\":[{\"index\":0,\"delta\":{},\
                     \"finish_reason\":\"length\"}]}\n\n",
                );
                out.push_str("data: [DONE]\n\n");
            }
            Adapter::Anthropic => {
                out.push_str(
                    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\
                     \"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
                );
                for piece in &pieces {
                    let escaped = serde_json::to_string(piece).expect("serialises");
                    let _ = write!(
                        out,
                        "event: content_block_delta\ndata: {{\"type\":\"content_block_delta\",\
                         \"index\":0,\"delta\":{{\"type\":\"text_delta\",\"text\":{escaped}}}}}\n\n"
                    );
                }
                out.push_str(
                    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\
                     \"index\":0}\n\n",
                );
                out.push_str(
                    "event: message_delta\ndata: {\"type\":\"message_delta\",\
                     \"delta\":{\"stop_reason\":\"max_tokens\"},\
                     \"usage\":{\"output_tokens\":40}}\n\n",
                );
                out.push_str("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
            }
            Adapter::Google => {
                for piece in &pieces {
                    let escaped = serde_json::to_string(piece).expect("serialises");
                    let _ = write!(
                        out,
                        "data: {{\"candidates\":[{{\"content\":{{\"parts\":[{{\"text\":{escaped}}}],\
                         \"role\":\"model\"}},\"index\":0}}],\"modelVersion\":\"gemini-cross\"}}\n\n"
                    );
                }
                out.push_str(
                    "data: {\"candidates\":[{\"content\":{\"parts\":[],\"role\":\"model\"},\
                     \"finishReason\":\"MAX_TOKENS\",\"index\":0}],\
                     \"usageMetadata\":{\"promptTokenCount\":9,\"candidatesTokenCount\":40,\
                     \"totalTokenCount\":49},\"modelVersion\":\"gemini-cross\"}\n\n",
                );
            }
        }
        out
    }

    fn model_list(self) -> String {
        match self {
            Adapter::Compat => format!(
                "{{\"object\":\"list\",\"data\":[{{\"id\":\"{}\",\"object\":\"model\"}}]}}",
                self.model()
            ),
            Adapter::Anthropic => format!(
                "{{\"data\":[{{\"id\":\"{}\",\"type\":\"model\",\
                 \"display_name\":\"Schema\"}}],\"has_more\":false}}",
                self.model()
            ),
            Adapter::Google => format!(
                "{{\"models\":[{{\"name\":\"models/{}\",\
                 \"supportedGenerationMethods\":[\"generateContent\",\"streamGenerateContent\"],\
                 \"inputTokenLimit\":32000}}]}}",
                self.model()
            ),
        }
    }

    fn is_model_list(self, path: &str) -> bool {
        match self {
            Adapter::Compat | Adapter::Anthropic => path.contains("/models"),
            Adapter::Google => path.contains("/models?"),
        }
    }

    fn wants_stream(self, path: &str, body: &str) -> bool {
        match self {
            Adapter::Compat | Adapter::Anthropic => body.contains("\"stream\":true"),
            Adapter::Google => path.contains("streamGenerateContent"),
        }
    }
}

/// A loopback endpoint speaking one dialect, answering every completion turn
/// with `text` on whichever transport was asked for.
struct Peer {
    url: String,
    shutdown: tokio::sync::oneshot::Sender<()>,
}

impl Peer {
    async fn start(adapter: Adapter, text: &'static str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("a free port");
        let port = listener.local_addr().expect("bound").port();
        let (shutdown, mut stop) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            loop {
                let accepted = tokio::select! {
                    _ = &mut stop => return,
                    accepted = listener.accept() => accepted,
                };
                let Ok((mut socket, _)) = accepted else {
                    return;
                };
                tokio::spawn(async move {
                    let mut raw = Vec::new();
                    let mut scratch = vec![0u8; 16384];
                    let (start_line, head_end, length) = loop {
                        let read = match socket.read(&mut scratch).await {
                            Ok(0) | Err(_) => return,
                            Ok(read) => read,
                        };
                        raw.extend_from_slice(&scratch[..read]);
                        let head = String::from_utf8_lossy(&raw).into_owned();
                        if let Some(at) = head.find("\r\n\r\n") {
                            let length = head
                                .to_ascii_lowercase()
                                .split("\r\n")
                                .find_map(|line| {
                                    line.strip_prefix("content-length:")
                                        .and_then(|value| value.trim().parse::<usize>().ok())
                                })
                                .unwrap_or(0);
                            if raw.len() >= at + 4 + length {
                                let start_line = head.lines().next().unwrap_or_default().to_owned();
                                break (start_line, at + 4, length);
                            }
                        }
                    };
                    let path = start_line.split(' ').nth(1).unwrap_or("/").to_owned();
                    let body =
                        String::from_utf8_lossy(&raw[head_end..head_end + length]).into_owned();

                    let (content_type, payload) = if adapter.is_model_list(&path) {
                        ("application/json", adapter.model_list())
                    } else if adapter.wants_stream(&path, &body) {
                        ("text/event-stream", adapter.streamed(text))
                    } else {
                        ("application/json", adapter.whole(text))
                    };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\n\
                         connection: close\r\n\r\n{payload}",
                        payload.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.flush().await;
                });
            }
        });
        Self {
            url: format!("http://127.0.0.1:{port}/v1"),
            shutdown,
        }
    }

    fn stop(self) {
        let _ = self.shutdown.send(());
    }
}

fn context() -> RequestContext {
    RequestContext::new().with_timeouts(Timeouts {
        connect: Duration::from_millis(500),
        first_byte: Duration::from_secs(5),
        stall: Duration::from_secs(5),
    })
}

/// One schema-shaped turn through the real provider, over a real socket.
async fn drive(adapter: Adapter, text: &'static str, streamed: bool) -> ChatResponse {
    let peer = Peer::start(adapter, text).await;
    let provider = adapter.provider(&peer.url);
    let request = ChatRequest::new(adapter.model())
        .with_message(ChatMessage::user("give me the weather in Berlin as JSON"))
        .with_response_format(ResponseFormat::JsonSchema {
            name: "weather".into(),
            schema: weather_schema(),
        });
    let mut sink = CollectingSink::new();
    let outcome = if streamed {
        provider.stream(request, &mut sink, &context()).await
    } else {
        provider.complete(request, &context()).await
    };
    peer.stop();
    outcome.expect("the endpoint answered 200")
}

// ---------------------------------------------------------------------------
// The premise
// ---------------------------------------------------------------------------

/// Everything below is worthless if the block actually closed, or if no schema
/// verdict was produced at all. Both are asserted before anything else is.
#[tokio::test(flavor = "multi_thread")]
async fn the_scenario_is_the_one_the_finding_describes() {
    for adapter in Adapter::ALL {
        for streamed in [true, false] {
            let arm = format!("{}/{streamed}", adapter.label());
            let response = drive(adapter, DELIBERATED_JSON, streamed).await;
            assert!(
                response.degradations.iter().any(|degradation| matches!(
                    degradation,
                    Degradation::UnterminatedReasoning { .. }
                )),
                "{arm}: the reasoning block closed, so the defect's precondition \
                 never held: {:?}",
                response.degradations
            );
            assert!(
                response.structured.is_some(),
                "{arm}: no schema verdict was produced, so this file measures nothing"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// THE CLAIM
// ---------------------------------------------------------------------------

/// `Some(Ok(v))` asserts the model produced `v`. It said the opposite.
#[tokio::test(flavor = "multi_thread")]
async fn a_value_the_model_rejected_is_never_handed_back_as_conforming() {
    for adapter in Adapter::ALL {
        for streamed in [true, false] {
            let arm = format!("{}/{streamed}", adapter.label());
            let response = drive(adapter, DELIBERATED_JSON, streamed).await;
            assert!(
                !matches!(&response.structured, Some(Ok(value)) if *value == rejected()),
                "{arm}: THE REJECTED VALUE CAME BACK AS A VALIDATED STRUCTURED \
                 ANSWER. `Some(Ok(v))` asserts the model produced `v`; the model \
                 wrote it down inside a `<think>` block it never closed and said \
                 in the same breath that it was wrong. Verdict: {:?}",
                response.structured
            );
        }
    }
}

/// Not merely "not that value": the only truthful verdict on this turn is a
/// mismatch. The model committed no answer at all, so there is no JSON to
/// validate — which is exactly the `MEASURED-5` shape the field exists to
/// report.
#[tokio::test(flavor = "multi_thread")]
async fn the_verdict_on_a_turn_with_no_committed_answer_is_a_reported_mismatch() {
    for adapter in Adapter::ALL {
        for streamed in [true, false] {
            let arm = format!("{}/{streamed}", adapter.label());
            let response = drive(adapter, DELIBERATED_JSON, streamed).await;
            assert!(
                matches!(&response.structured, Some(Err(_))),
                "{arm}: the model committed no answer, so the only honest verdict \
                 is a reported mismatch: {:?}",
                response.structured
            );
            assert!(
                response.degradations.iter().any(|degradation| matches!(
                    degradation,
                    Degradation::StructuredOutputMismatch { .. }
                )),
                "{arm}: the mismatch must reach the degradation ledger the UI \
                 renders: {:?}",
                response.degradations
            );
        }
    }
}

/// MEASURED-3 still holds. Refusing to *validate* the salvaged text is not a
/// licence to stop *showing* it: the user reads what the model was thinking,
/// sees the `unterminatedReasoning` degradation beside it, and knows the turn
/// was cut.
#[tokio::test(flavor = "multi_thread")]
async fn the_salvaged_prose_is_still_shown_to_the_user() {
    for adapter in Adapter::ALL {
        for streamed in [true, false] {
            let arm = format!("{}/{streamed}", adapter.label());
            let response = drive(adapter, DELIBERATED_JSON, streamed).await;
            assert!(
                response.answer_text().contains(SALVAGED_PROSE),
                "{arm}: the salvaged answer was swallowed: {:?}",
                response.answer_text()
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Negative controls — the fix must not disarm structured output
// ---------------------------------------------------------------------------

/// The same deliberation with the block CLOSED and a committed answer after
/// it. If this arm changed too, the fix would be "structured output no longer
/// works" wearing a costume.
#[tokio::test(flavor = "multi_thread")]
async fn a_committed_json_answer_still_validates() {
    for adapter in Adapter::ALL {
        for streamed in [true, false] {
            let arm = format!("{}/{streamed}", adapter.label());
            let response = drive(adapter, COMMITTED_JSON, streamed).await;
            assert!(
                matches!(
                    &response.structured,
                    Some(Ok(value)) if *value == json!({"city": "Berlin", "celsius": 21.5})
                ),
                "{arm}: a committed, conforming answer must still validate: {:?}",
                response.structured
            );
        }
    }
}

/// The naive way to close this defect is to stop `extract_json` scavenging.
/// That also deletes inline-JSON extraction, which `structured.rs` documents,
/// tests, and real models depend on. Asserted end to end so the shortcut
/// cannot be shipped as the fix.
#[tokio::test(flavor = "multi_thread")]
async fn inline_json_in_a_committed_answer_is_still_found() {
    for adapter in Adapter::ALL {
        for streamed in [true, false] {
            let arm = format!("{}/{streamed}", adapter.label());
            let response = drive(adapter, COMMITTED_INLINE_JSON, streamed).await;
            assert!(
                matches!(
                    &response.structured,
                    Some(Ok(value)) if *value == json!({"city": "Berlin", "celsius": 21.5})
                ),
                "{arm}: JSON wrapped in a committed sentence must still be read — \
                 removing that is a regression, not a fix: {:?}",
                response.structured
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Positive control
// ---------------------------------------------------------------------------

/// **The control.** Everything above is worth nothing if the thing it forbids
/// was never possible. This rebuilds the pre-fix consumer out of the crate's
/// *public* API — `extract_json` over the whole visible answer, exactly what
/// `check_answer(schema, &response.answer_text())` did — and asserts it really
/// does hand back the rejected object as conforming.
///
/// Written this way on purpose: injecting the defect into the shared tree to
/// watch the tests go red is how a broken HEAD got committed earlier in this
/// run. This control is permanent and runs in CI.
#[test]
fn the_pre_fix_consumer_really_did_hand_back_the_rejected_value() {
    // The answer text as the user saw it, salvaged tail included — which is
    // what `ChatResponse::answer_text()` returns and what all six schema-check
    // sites were fed.
    let visible = DELIBERATED_JSON
        .strip_prefix("<think>")
        .expect("the fixture opens a reasoning block and never closes it");

    let value = structured::extract_json(visible)
        .expect("the pre-fix consumer scavenged the first balanced object");
    assert_eq!(
        value,
        rejected(),
        "the object scavenged out of the deliberation is not the rejected one, \
         so this control is measuring something else"
    );
    assert!(
        structured::validate(&weather_schema(), &value).is_ok(),
        "the rejected object must actually VALIDATE, or the defect would have \
         been caught by the schema and there would be nothing to fix"
    );
}

/// And the committed half of that same turn contains no JSON at all — which is
/// why the honest verdict is a mismatch, and why the fix is a change of
/// *input*, not a change of validator.
#[test]
fn the_committed_half_of_the_turn_contains_no_json() {
    // Everything before the unterminated `<think>` — which, on this turn, is
    // nothing. The model never left the block.
    let committed = "";
    assert!(
        structured::extract_json(committed).is_none(),
        "there is no JSON in the committed answer; if there were, the two \
         candidate inputs would not differ and the localisation would be wrong"
    );
}

// ---------------------------------------------------------------------------
// The structural claim
// ---------------------------------------------------------------------------

/// The tool consumer's chokepoint is checked over the tree by
/// `answer_chokepoint.rs`, because a private field cannot stop an adapter from
/// growing a second path around it. The schema consumer is the same kind of
/// consumer and gets the same treatment: **no shipping file may feed
/// `answer_text()` to a schema check.**
///
/// This is belt to the type system's braces. `structured::check_answer` takes
/// a value that can only be minted from a `ChatResponse`, so the wrong call
/// does not compile — but a future "check_answer_str" would, and this names
/// the file if one appears.
#[test]
fn the_schema_consumer_is_fed_from_the_chokepoint() {
    let crate_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut offenders: Vec<String> = Vec::new();

    fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir)
            .expect("readable source directory")
            .flatten()
        {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push(path);
            }
        }
    }
    let mut sources = Vec::new();
    walk(&crate_dir.join("src"), &mut sources);
    sources.sort();

    // Shipping code only, the way `answer_chokepoint.rs` defines it: `//`
    // comments stripped, so prose *about* the rule does not read as a breach of
    // it, and everything from the first `#[cfg(test)]` dropped, so a module's
    // own tests may say anything.
    fn shipping_code(text: &str) -> String {
        let text = match text.find("#[cfg(test)]") {
            Some(at) => &text[..at],
            None => text,
        };
        text.lines()
            .map(|line| match line.find("//") {
                Some(at) => &line[..at],
                None => line,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    for path in sources {
        let text = std::fs::read_to_string(&path).expect("readable source");
        let shipping = shipping_code(&text);
        let shipping = shipping.as_str();
        let name = path
            .strip_prefix(&crate_dir)
            .unwrap_or(&path)
            .display()
            .to_string()
            .replace('\\', "/");
        let mut rest = shipping;
        while let Some(at) = rest.find("check_answer(") {
            let call = &rest[at..];
            let end = call.find(';').unwrap_or(call.len());
            let call = &call[..end];
            if call.contains("answer_text()") {
                offenders.push(format!("{name}: {}", call.replace('\n', " ")));
            }
            rest = &rest[at + "check_answer(".len()..];
        }
    }

    assert!(
        offenders.is_empty(),
        "a schema check is being fed `answer_text()`, which includes text \
         salvaged out of a reasoning block the model never closed. A value the \
         model REJECTED then comes back as `Some(Ok(v))`, and `Some(Ok(v))` \
         asserts the model produced it. Feed the check from the chokepoint — \
         `ChatResponse::machine_text()` — the way the tool parser is fed from \
         `AnswerChannel::executable_text()`. Offenders: {offenders:?}"
    );
}

/// A `SchemaMismatch` is still the shape a caller destructures. Guards against
/// a "fix" that quietly starts returning `None` — an unreported absence is the
/// silent degradation MEASURED-5 is about.
#[tokio::test(flavor = "multi_thread")]
async fn the_mismatch_is_reported_not_erased() {
    let response = drive(Adapter::Compat, DELIBERATED_JSON, true).await;
    let mismatch: &SchemaMismatch = match &response.structured {
        Some(Err(mismatch)) => mismatch,
        other => panic!("expected a reported mismatch, got {other:?}"),
    };
    assert!(
        !mismatch.detail.is_empty(),
        "the mismatch must say something a user can act on"
    );
    assert!(
        !mismatch.detail.contains("Atlantis"),
        "the mismatch detail must be Vela's own words, not the endpoint's: {mismatch:?}"
    );
}
