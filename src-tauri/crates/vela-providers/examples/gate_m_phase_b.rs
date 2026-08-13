//! **GATE M Part 1, Phase B — the evidence recorder.**
//!
//! Runs Vela's own provider stack against all four capability-matrix profiles,
//! started as real OS processes and driven over real TCP, and writes verbatim
//! evidence to `docs/regression-baseline/phase-b-matrix/<profile>/`.
//!
//! This binary is deliberately *not* a test. It is an executor: it records what
//! happened — request bytes, response bytes, normalised outcome, wall-clock
//! time — and prints a PASS/FAIL verdict for every assertion. A critic reads the
//! transcripts, not this source.
//!
//! # Honesty (conventions.md §10)
//!
//! Every profile is a deterministic mock. **Not one byte here comes from a
//! language model.** Everything this binary produces is **VERIFIED-BY-FAKE**.
//! GATE M Part 2 — a real llama.cpp at :8033 on the operator's Windows host —
//! is unreachable from this container and is not attempted.
//!
//! ```text
//! cargo run -p vela-providers --example gate_m_phase_b
//! ```
//!
//! Exits non-zero if any assertion fails.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::PathBuf;
use std::process::{ExitCode, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};

use vela_core::credential::Auth;
use vela_core::provider::{ProviderDescriptor, ProviderKind};
use vela_core::secret::{SecretRef, SecretValue};
use vela_providers::capability::{ModelCapabilities, Support};
use vela_providers::event::CollectingSink;
use vela_providers::http::{
    BodyStream, ByteStream, HttpRequest, HttpResponse, HttpTransport, ReqwestTransport,
    TransportError,
};
use vela_providers::openai_compatible::{OpenAiCompatibleProvider, ProviderOptions};
use vela_providers::redact::RequestUrl;
use vela_providers::tool_accum::{ToolCallAccumulator, ToolCallShape};
use vela_providers::{
    Candidate, ChatMessage, ChatRequest, ContentPart, Degradation, MalformedToolCall, MessageRole,
    Provider, ProviderError, RequestContext, ResponseFormat, RetryPolicy, Router, StopReason,
    StructuredOutputPolicy, Timeouts, ToolCallOutcome, ToolChoice, ToolDefinition,
};
use vela_secrets::{MemoryStore, SecretStore};

const PROFILES: [&str; 4] = ["frontier", "mid-local", "small-local", "hostile"];

/// The model id each profile serves, and the context window it declares.
fn model_of(profile: &str) -> String {
    format!("mock-{profile}")
}

// ===========================================================================
// Harness control
// ===========================================================================

struct MockServer {
    child: Child,
    url: String,
}

impl MockServer {
    async fn start(profile: &str, extra: &[&str]) -> Self {
        let cli = repo_root().join("tests/harness/mock-provider/src/cli.ts");
        assert!(cli.exists(), "mock harness missing at {}", cli.display());

        let mut child = Command::new("node")
            .arg(&cli)
            .arg("--profile")
            .arg(profile)
            .arg("--port")
            .arg("0")
            .args(extra)
            .current_dir(repo_root())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("the recorder needs Node 22+ on PATH to start the mock harness");

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

    /// SIGKILL. Used to take an endpoint away *mid-request* (case 10).
    async fn kill(&mut self) {
        let _ = self.child.kill().await;
    }

    async fn stop(mut self) {
        self.kill().await;
    }
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("crates/<name> sits three levels below the repo root")
        .to_path_buf()
}

fn out_dir() -> PathBuf {
    repo_root().join("docs/regression-baseline/phase-b-matrix")
}

// ===========================================================================
// The wire recorder — a transport that tees every byte in both directions
// ===========================================================================

struct WireEntry {
    method: &'static str,
    /// Not a `String`: with `Auth::ApiKeyQuery` the credential is *in* the URL,
    /// and these transcripts are committed. `RequestUrl` prints redacted, so
    /// the recorder cannot write a key into `docs/` even by accident.
    url: RequestUrl,
    request_headers: Vec<(String, String)>,
    request_body: Option<Vec<u8>>,
    outcome: WireOutcome,
}

enum WireOutcome {
    Response {
        status: u16,
        headers: Vec<(String, String)>,
        body: Arc<Mutex<Vec<u8>>>,
    },
    Failed(String),
}

#[derive(Clone, Default)]
struct WireLog(Arc<Mutex<Vec<WireEntry>>>);

impl WireLog {
    fn drain(&self) -> Vec<WireEntry> {
        std::mem::take(&mut *self.0.lock().expect("wire log poisoned"))
    }
}

struct RecordingTransport {
    inner: ReqwestTransport,
    log: WireLog,
}

impl RecordingTransport {
    fn new(log: WireLog) -> Self {
        Self {
            inner: ReqwestTransport::new().expect("http client builds"),
            log,
        }
    }
}

#[async_trait]
impl HttpTransport for RecordingTransport {
    async fn send(
        &self,
        request: HttpRequest,
        timeouts: &Timeouts,
    ) -> Result<HttpResponse, TransportError> {
        let method = request.method.as_str();
        let url = request.url.clone();
        let request_headers = request.headers.clone();
        let request_body = request.body.clone();

        match self.inner.send(request, timeouts).await {
            Ok(response) => {
                let sink: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
                self.log.0.lock().expect("poisoned").push(WireEntry {
                    method,
                    url,
                    request_headers,
                    request_body,
                    outcome: WireOutcome::Response {
                        status: response.status,
                        headers: response.headers.clone(),
                        body: Arc::clone(&sink),
                    },
                });
                // The recorder wraps a `BodyStream` and reads *through* it,
                // so every byte it tees has already been scrubbed. Forwarding
                // the origin keeps the endpoint identity on the rewrapped body;
                // it is no longer load-bearing for redaction, and that is the
                // round-3 fix — see the comment on `Tee`.
                let origin = response.body.origin().clone();
                Ok(HttpResponse {
                    status: response.status,
                    headers: response.headers,
                    body: BodyStream::new(
                        Tee {
                            inner: response.body,
                            sink,
                        },
                        origin,
                    ),
                })
            }
            Err(error) => {
                self.log.0.lock().expect("poisoned").push(WireEntry {
                    method,
                    url,
                    request_headers,
                    request_body,
                    outcome: WireOutcome::Failed(format!("{:?}: {}", error.failure, error.detail)),
                });
                Err(error)
            }
        }
    }
}

/// The recorder's body decorator.
///
/// **It used to be able to disable Vela's credential redaction by omission**,
/// and briefly did: `ByteStream::scrubber()` was an overridable method
/// defaulting to `Scrubber::none()`, so wrapping the real body with a `Tee`
/// that did not forward it made the round-2 gate run report a leak Vela did
/// not have. That was the finding that produced the round-3 fix.
///
/// It cannot happen now. `inner` is a [`BodyStream`], whose `next_chunk` is the
/// only door bytes leave a body by and scrubs on the way out, so this decorator
/// sees cleaned bytes and has nothing to forward. The property no longer
/// depends on this file being careful.
struct Tee {
    inner: BodyStream,
    sink: Arc<Mutex<Vec<u8>>>,
}

#[async_trait]
impl ByteStream for Tee {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
        let out = self.inner.next_chunk().await;
        match &out {
            Ok(Some(chunk)) => self.sink.lock().expect("poisoned").extend_from_slice(chunk),
            Err(error) => self.sink.lock().expect("poisoned").extend_from_slice(
                format!(
                    "\n<<< body read failed: {:?} {} >>>\n",
                    error.failure, error.detail
                )
                .as_bytes(),
            ),
            Ok(None) => {}
        }
        out
    }
}

// ===========================================================================
// Verdict ledger and transcript building
// ===========================================================================

#[derive(Clone)]
struct Verdict {
    profile: String,
    case: String,
    name: String,
    pass: bool,
    detail: String,
}

struct Doc {
    profile: String,
    case: String,
    body: String,
    verdicts: Vec<Verdict>,
}

impl Doc {
    fn new(profile: &str, case: &str, title: &str, purpose: &str) -> Self {
        let mut body = String::new();
        let _ = writeln!(
            body,
            "================================================================================"
        );
        let _ = writeln!(
            body,
            "GATE M Part 1 (Phase B) — profile: {profile} — case {case}: {title}"
        );
        let _ = writeln!(
            body,
            "================================================================================"
        );
        let _ = writeln!(body);
        let _ = writeln!(body, "PURPOSE   {purpose}");
        let _ = writeln!(
            body,
            "SUBJECT   Vela's own provider stack (vela-providers::OpenAiCompatibleProvider)"
        );
        let _ = writeln!(
            body,
            "ENDPOINT  tests/harness/mock-provider, profile `{profile}`, a real OS process on loopback"
        );
        let _ = writeln!(
            body,
            "HONESTY   VERIFIED-BY-FAKE. The endpoint is a deterministic mock; no model produced"
        );
        let _ = writeln!(
            body,
            "          any byte below. Nothing here is evidence about a real model."
        );
        let _ = writeln!(body);
        Self {
            profile: profile.to_owned(),
            case: case.to_owned(),
            body,
            verdicts: Vec::new(),
        }
    }

    fn h(&mut self, title: &str) {
        let _ = writeln!(
            self.body,
            "\n---- {title} {}",
            "-".repeat(72_usize.saturating_sub(title.len()))
        );
    }

    fn p(&mut self, text: impl AsRef<str>) {
        let _ = writeln!(self.body, "{}", text.as_ref());
    }

    fn kv(&mut self, key: &str, value: impl std::fmt::Display) {
        let _ = writeln!(self.body, "  {key:<38} {value}");
    }

    /// Dump every HTTP exchange the turn produced, verbatim (bounded).
    fn wire(&mut self, entries: &[WireEntry]) {
        if entries.is_empty() {
            self.p("  (no HTTP request was made)");
            return;
        }
        for (index, entry) in entries.iter().enumerate() {
            let _ = writeln!(
                self.body,
                "\n  >>> exchange {} — {} {}",
                index + 1,
                entry.method,
                entry.url
            );
            for (name, value) in &entry.request_headers {
                // The VALUE is redacted even though every credential in this run
                // is a fake. These transcripts are committed, and a recorder that
                // prints credentials is one accidental re-run against a real
                // endpoint away from writing a real key into `docs/`. What the
                // gate needs is whether a header is there, not what is in it.
                let shown = if is_credential_header(name) {
                    format!(
                        "<redacted, {} bytes>   <-- CREDENTIAL HEADER ON THE WIRE",
                        value.len()
                    )
                } else {
                    value.clone()
                };
                let _ = writeln!(self.body, "      {name}: {shown}");
            }
            if !entry
                .request_headers
                .iter()
                .any(|(name, _)| name == "authorization")
            {
                let _ = writeln!(self.body, "      (no authorization header)");
            }
            if let Some(body) = &entry.request_body {
                let _ = writeln!(
                    self.body,
                    "      --- request body ({} bytes) ---",
                    body.len()
                );
                self.p(indent(&elide(&String::from_utf8_lossy(body), 2_400), 6));
            }
            match &entry.outcome {
                WireOutcome::Failed(detail) => {
                    let _ = writeln!(self.body, "      <<< NO RESPONSE — {detail}");
                }
                WireOutcome::Response {
                    status,
                    headers,
                    body,
                } => {
                    let _ = writeln!(self.body, "      <<< HTTP {status}");
                    for (name, value) in headers {
                        if matches!(name.as_str(), "content-type" | "transfer-encoding") {
                            let _ = writeln!(self.body, "      {name}: {value}");
                        }
                    }
                    let bytes = body.lock().expect("poisoned").clone();
                    let _ = writeln!(
                        self.body,
                        "      --- response body ({} bytes, read to end) ---",
                        bytes.len()
                    );
                    self.p(indent(&elide(&String::from_utf8_lossy(&bytes), 6_000), 6));
                }
            }
        }
    }

    fn check(&mut self, name: &str, pass: bool, detail: impl std::fmt::Display) {
        let detail = detail.to_string();
        let _ = writeln!(
            self.body,
            "  [{}] {name}\n        {detail}",
            if pass { "PASS" } else { "FAIL" }
        );
        self.verdicts.push(Verdict {
            profile: self.profile.clone(),
            case: self.case.clone(),
            name: name.to_owned(),
            pass,
            detail,
        });
    }

    fn write(self, ledger: &mut Vec<Verdict>) {
        let failures = self.verdicts.iter().filter(|v| !v.pass).count();
        let mut body = self.body;
        let _ = writeln!(
            body,
            "\n================================================================================\n\
             VERDICT  {} assertion(s), {failures} failure(s)\n\
             ================================================================================",
            self.verdicts.len()
        );
        let dir = out_dir().join(&self.profile);
        std::fs::create_dir_all(&dir).expect("evidence directory");
        let name = format!("{}.txt", self.case);
        std::fs::write(dir.join(&name), body).expect("write transcript");
        eprintln!(
            "  {:<12} {:<34} {} assertions, {} failures",
            self.profile,
            name,
            self.verdicts.len(),
            failures
        );
        ledger.extend(self.verdicts);
    }
}

/// Header names whose *value* must never be written into a committed transcript.
fn is_credential_header(name: &str) -> bool {
    name == "authorization"
        || name.contains("api-key")
        || name.contains("apikey")
        || name.contains("token")
        || name == "x-goog-api-key"
}

fn indent(text: &str, spaces: usize) -> String {
    let pad = " ".repeat(spaces);
    text.lines()
        .map(|line| format!("{pad}{line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn elide(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let head: String = text.chars().take(limit).collect();
    format!(
        "{head}\n… [elided: {} characters total]",
        text.chars().count()
    )
}

// ===========================================================================
// Vela-side helpers
// ===========================================================================

fn provider_for(url: &str, log: &WireLog) -> OpenAiCompatibleProvider {
    OpenAiCompatibleProvider::new(
        ProviderDescriptor::new("matrix", "Capability matrix", ProviderKind::Local)
            .expect("static id is valid"),
        format!("{url}/v1"),
        // The state most local runtimes are in, and a first-class one in Vela.
        Auth::None,
        Arc::new(MemoryStore::new()),
        Arc::new(RecordingTransport::new(log.clone())),
    )
}

/// Short deadlines on purpose: the recorded naive consumers hung for 5003 ms and
/// 5006 ms, so anything that would hang must be *caught* well inside that.
fn context() -> RequestContext {
    RequestContext::new().with_timeouts(Timeouts {
        connect: Duration::from_secs(5),
        first_byte: Duration::from_secs(10),
        stall: Duration::from_secs(3),
    })
}

fn user(profile: &str, text: &str) -> ChatRequest {
    ChatRequest::new(model_of(profile)).with_message(ChatMessage::user(text))
}

fn weather_tool() -> ToolDefinition {
    ToolDefinition::new(
        "get_weather",
        "Current weather for a city",
        json!({
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"]
        }),
    )
}

fn describe_degradations(degradations: &[Degradation]) -> String {
    if degradations.is_empty() {
        return "(none)".to_owned();
    }
    degradations
        .iter()
        .map(|d| format!("{d:?}"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn describe_calls(calls: &[ToolCallOutcome]) -> String {
    if calls.is_empty() {
        return "(none)".to_owned();
    }
    calls
        .iter()
        .map(|call| match call {
            ToolCallOutcome::Ok {
                call_id,
                name,
                arguments,
                emulated,
            } => format!("OK id={call_id} name={name} emulated={emulated} args={arguments}"),
            ToolCallOutcome::Malformed {
                index,
                call_id,
                name,
                raw_arguments,
                reason,
            } => format!(
                "MALFORMED index={index:?} id={} name={} reason={reason:?} raw={raw_arguments:?}",
                call_id.as_deref().unwrap_or("MISSING"),
                name.as_deref().unwrap_or("MISSING")
            ),
        })
        .collect::<Vec<_>>()
        .join("\n                                    ")
}

// ===========================================================================
// Case 00 — capability probe
// ===========================================================================

async fn case_00(profile: &str, url: &str, ledger: &mut Vec<Verdict>) -> ModelCapabilities {
    let log = WireLog::default();
    let provider = provider_for(url, &log);
    let mut doc = Doc::new(
        profile,
        "00-capability-probe",
        "capability probe",
        "Establish what this endpoint can do by asking it. Nothing may be assumed from a name.",
    );

    let model = model_of(profile);
    let started = Instant::now();
    let probed = provider.probe_capabilities(&model, &context()).await;
    let elapsed = started.elapsed();
    let entries = log.drain();

    doc.h("the probe on the wire");
    doc.wire(&entries);

    doc.h("what Vela concluded");
    let capabilities = match probed {
        Ok(capabilities) => capabilities,
        Err(error) => {
            doc.p(format!("  PROBE FAILED: {error:?}"));
            doc.check(
                "the capability probe completes",
                false,
                format!("{error:?}"),
            );
            doc.write(ledger);
            return ModelCapabilities::unknown(&model);
        }
    };
    doc.kv("model", &capabilities.model_id);
    doc.kv(
        "context window (tokens)",
        format!("{:?}", capabilities.context_window_tokens),
    );
    doc.kv("streaming", format!("{:?}", capabilities.streaming));
    doc.kv("tool calling", format!("{:?}", capabilities.tool_calling));
    doc.kv("vision", format!("{:?}", capabilities.vision));
    doc.kv(
        "structured output",
        format!("{:?}", capabilities.structured_output),
    );
    doc.kv("reasoning", format!("{:?}", capabilities.reasoning));
    doc.kv("model listing", format!("{:?}", capabilities.model_listing));
    doc.kv(
        "usage reporting",
        format!("{:?}", capabilities.usage_reporting),
    );
    doc.kv(
        "prompt caching",
        format!("{:?}", capabilities.prompt_caching),
    );
    doc.kv("probe wall clock", format!("{elapsed:?}"));
    doc.p("\n  findings (how each belief was reached):");
    for finding in &capabilities.findings {
        doc.p(format!(
            "    {:?} = {:?} ({:?}) — {}",
            finding.capability, finding.support, finding.evidence, finding.note
        ));
    }

    doc.h("the flag set the renderer is allowed to see");
    let descriptor = capabilities.to_descriptor();
    doc.p(format!(
        "  {}",
        serde_json::to_string(&descriptor).expect("serialises")
    ));

    doc.h("assertions");
    let expected_window = match profile {
        "frontier" => 200_000,
        "mid-local" => 32_768,
        "small-local" => 8_192,
        _ => 4_096,
    };
    doc.check(
        "the declared context window is read from the endpoint, not guessed",
        capabilities.context_window_tokens == Some(expected_window),
        format!(
            "expected {expected_window}, probe reported {:?}",
            capabilities.context_window_tokens
        ),
    );
    let (expected_tools, expected_vision, expected_structured) = match profile {
        "frontier" => (Support::Supported, Support::Supported, Support::Supported),
        "mid-local" => (Support::Supported, Support::Unsupported, Support::Degraded),
        "small-local" => (
            Support::Unsupported,
            Support::Unsupported,
            Support::Degraded,
        ),
        _ => (Support::Degraded, Support::Unsupported, Support::Degraded),
    };
    doc.check(
        "tool calling matches the recorded matrix row",
        capabilities.tool_calling == expected_tools,
        format!(
            "expected {expected_tools:?}, probed {:?}",
            capabilities.tool_calling
        ),
    );
    doc.check(
        "vision matches the recorded matrix row",
        capabilities.vision == expected_vision,
        format!(
            "expected {expected_vision:?}, probed {:?}",
            capabilities.vision
        ),
    );
    doc.check(
        "structured output matches the recorded matrix row",
        capabilities.structured_output == expected_structured,
        format!(
            "expected {expected_structured:?}, probed {:?}",
            capabilities.structured_output
        ),
    );
    doc.check(
        "every belief carries probe evidence, none is a default",
        capabilities
            .findings
            .iter()
            .all(|f| f.evidence != vela_providers::Evidence::Unprobed),
        format!("{} findings recorded", capabilities.findings.len()),
    );
    let flags = serde_json::to_string(&descriptor).expect("serialises");
    doc.check(
        "no backend identity reaches the UI flag set",
        !flags.contains(profile) && !flags.contains("mock"),
        format!("flag set = {flags}"),
    );
    doc.check(
        "the vision affordance follows the probe exactly",
        descriptor.vision == (expected_vision == Support::Supported),
        format!(
            "descriptor.vision = {}, probe = {expected_vision:?}",
            descriptor.vision
        ),
    );
    doc.check(
        "structured output is never advertised unless honoured (MEASURED-5)",
        capabilities.honours_structured_output() == (expected_structured == Support::Supported),
        format!(
            "honours_structured_output() = {}",
            capabilities.honours_structured_output()
        ),
    );

    doc.write(ledger);
    capabilities
}

// ===========================================================================
// Case 01 — plain chat, streaming and non-streaming
// ===========================================================================

async fn case_01(profile: &str, url: &str, ledger: &mut Vec<Verdict>) {
    let log = WireLog::default();
    let provider = provider_for(url, &log);
    let mut doc = Doc::new(
        profile,
        "01-plain-chat",
        "plain chat, streamed and not",
        "The same question down both paths. A consumer must not be able to tell them apart.",
    );
    let question = "what is the weather in Berlin";

    let mut sink = CollectingSink::new();
    let started = Instant::now();
    let streamed = provider
        .stream(user(profile, question), &mut sink, &context())
        .await;
    let stream_elapsed = started.elapsed();
    let stream_wire = log.drain();

    let started = Instant::now();
    let whole = provider.complete(user(profile, question), &context()).await;
    let whole_elapsed = started.elapsed();
    let whole_wire = log.drain();

    doc.h("streamed turn — on the wire");
    doc.wire(&stream_wire);
    doc.h("non-streamed turn — on the wire");
    doc.wire(&whole_wire);

    doc.h("what Vela produced");
    let (streamed, whole) = match (streamed, whole) {
        (Ok(a), Ok(b)) => (a, b),
        (a, b) => {
            doc.p(format!("  streamed:     {a:?}"));
            doc.p(format!("  non-streamed: {b:?}"));
            doc.check(
                "a plain chat turn completes on both paths",
                false,
                "see above",
            );
            doc.write(ledger);
            return;
        }
    };
    doc.kv("streamed answer", format!("{:?}", streamed.answer_text()));
    doc.kv("non-streamed answer", format!("{:?}", whole.answer_text()));
    doc.kv(
        "streamed reasoning",
        format!("{:?}", streamed.reasoning_text()),
    );
    doc.kv(
        "non-streamed reasoning",
        format!("{:?}", whole.reasoning_text()),
    );
    doc.kv("sum of TextDelta events", format!("{:?}", sink.text()));
    doc.kv("stop reason", format!("{:?}", streamed.stop_reason));
    doc.kv("usage", format!("{:?}", streamed.usage));
    doc.kv(
        "degradations (streamed)",
        describe_degradations(&streamed.degradations),
    );
    doc.kv(
        "degradations (non-streamed)",
        describe_degradations(&whole.degradations),
    );
    doc.kv("streamed wall clock", format!("{stream_elapsed:?}"));
    doc.kv("non-streamed wall clock", format!("{whole_elapsed:?}"));

    doc.h("assertions");
    doc.check(
        "the turn produces an answer",
        !streamed.answer_text().is_empty(),
        format!("{} characters", streamed.answer_text().chars().count()),
    );
    doc.check(
        "streamed and non-streamed answers are identical",
        streamed.answer_text() == whole.answer_text(),
        format!(
            "streamed {} chars / whole {} chars",
            streamed.answer_text().chars().count(),
            whole.answer_text().chars().count()
        ),
    );
    doc.check(
        "the deltas add up to the answer",
        sink.text() == streamed.answer_text(),
        format!("delta sum {} chars", sink.text().chars().count()),
    );
    doc.check(
        "no wire-format remnant reaches the answer",
        !streamed.answer_text().contains("data:")
            && !streamed.answer_text().contains("[DONE]")
            && !streamed.answer_text().contains("<think"),
        format!("{:?}", streamed.answer_text()),
    );
    doc.check(
        "the turn does not hang (well inside the recorded 5003 ms consumer hang)",
        stream_elapsed < Duration::from_secs(3),
        format!("{stream_elapsed:?}"),
    );
    doc.write(ledger);
}

// ===========================================================================
// Case 02 — tool calling
// ===========================================================================

async fn case_02(profile: &str, url: &str, ledger: &mut Vec<Verdict>) {
    let log = WireLog::default();
    let provider = provider_for(url, &log);
    let mut doc = Doc::new(
        profile,
        "02-tool-calling",
        "tool calling",
        "Native where the endpoint has it; prompt emulation end to end where it does not.",
    );

    // --- native attempt -----------------------------------------------------
    doc.h("a native tools request");
    let request = user(profile, "what is the weather in Berlin")
        .with_tools([weather_tool()])
        .with_tool_choice(ToolChoice::Required);
    let started = Instant::now();
    let outcome = provider.complete(request, &context()).await;
    let elapsed = started.elapsed();
    doc.wire(&log.drain());

    doc.h("what Vela produced");
    match &outcome {
        Ok(response) => {
            doc.kv("answer", format!("{:?}", response.answer_text()));
            doc.kv("stop reason", format!("{:?}", response.stop_reason));
            doc.kv("tool calls", describe_calls(&response.tool_calls));
            doc.kv("executable calls", response.executable_tool_calls().count());
            doc.kv(
                "degradations",
                describe_degradations(&response.degradations),
            );
        }
        Err(error) => doc.kv("error", format!("{error:?}")),
    }
    doc.kv("wall clock", format!("{elapsed:?}"));

    doc.h("assertions");
    match profile {
        "frontier" | "mid-local" => {
            let response = match &outcome {
                Ok(response) => response,
                Err(error) => {
                    doc.check(
                        "a native tool call succeeds on an endpoint that has tools",
                        false,
                        format!("{error:?}"),
                    );
                    doc.write(ledger);
                    return;
                }
            };
            let calls: Vec<&ToolCallOutcome> = response.executable_tool_calls().collect();
            doc.check(
                "exactly one executable native call comes back",
                calls.len() == 1,
                describe_calls(&response.tool_calls),
            );
            let native_and_parsed = matches!(
                calls.first(),
                Some(ToolCallOutcome::Ok { name, arguments, emulated, .. })
                    if name == "get_weather" && arguments.is_object() && !*emulated
            );
            doc.check(
                "the call is named, parsed into an object, and not marked emulated",
                native_and_parsed,
                describe_calls(&response.tool_calls),
            );
            doc.check(
                "the stop reason says a tool was requested",
                response.stop_reason == StopReason::ToolUse,
                format!("{:?}", response.stop_reason),
            );
        }
        "hostile" => {
            let response = match &outcome {
                Ok(response) => response,
                Err(error) => {
                    doc.check(
                        "broken tool calls do not fail the turn",
                        false,
                        format!("{error:?}"),
                    );
                    doc.write(ledger);
                    return;
                }
            };
            doc.check(
                "both broken calls are reported, neither is dropped",
                response.tool_calls.len() == 2,
                describe_calls(&response.tool_calls),
            );
            doc.check(
                "NOTHING from a broken stream is executable",
                response.executable_tool_calls().count() == 0,
                format!("{} executable", response.executable_tool_calls().count()),
            );
            let reasons: Vec<MalformedToolCall> = response
                .tool_calls
                .iter()
                .filter_map(|call| match call {
                    ToolCallOutcome::Malformed { reason, .. } => Some(*reason),
                    ToolCallOutcome::Ok { .. } => None,
                })
                .collect();
            doc.check(
                "truncated arguments are reported as unparseable, not guessed at",
                reasons.contains(&MalformedToolCall::UnparseableArguments),
                format!("{reasons:?}"),
            );
            doc.check(
                "the misspelled discriminator `funktion` is reported as such",
                reasons.contains(&MalformedToolCall::UnknownDiscriminator),
                format!("{reasons:?}"),
            );
            doc.check(
                "the name that arrived with no `index` was not lost (MEASURED-4)",
                response.tool_calls.iter().any(|call| {
                    matches!(
                        call,
                        ToolCallOutcome::Malformed { name: Some(name), .. } if name == "get_weather"
                    )
                }),
                describe_calls(&response.tool_calls),
            );
            doc.check(
                "the failure is a declared degradation, not silence",
                response
                    .degradations
                    .iter()
                    .any(|d| matches!(d, Degradation::MalformedToolCalls { .. })),
                describe_degradations(&response.degradations),
            );

            // The same endpoint, the same tools, the other transport. The two
            // paths must not disagree about what the endpoint said.
            doc.h("the SAME request, STREAMED — do the two paths agree?");
            let mut sink = CollectingSink::new();
            let streamed = provider
                .stream(
                    user(profile, "what is the weather in Berlin")
                        .with_tools([weather_tool()])
                        .with_tool_choice(ToolChoice::Required),
                    &mut sink,
                    &context(),
                )
                .await;
            doc.wire(&log.drain());
            let streamed_calls = streamed
                .as_ref()
                .map(|r| r.tool_calls.clone())
                .unwrap_or_default();
            doc.kv("streamed tool calls", describe_calls(&streamed_calls));
            doc.kv(
                "non-streamed tool calls",
                describe_calls(&response.tool_calls),
            );
            doc.check(
                "streamed and non-streamed report the same number of calls",
                streamed_calls.len() == response.tool_calls.len(),
                format!(
                    "streamed {} call(s), non-streamed {} call(s)",
                    streamed_calls.len(),
                    response.tool_calls.len()
                ),
            );
        }
        _ => {
            // small-local: no native tools at all, and it 400s even with
            // tool_choice: "none" (FINDING 6).
            doc.check(
                "an endpoint with no tools is refused explicitly, never silently",
                matches!(
                    &outcome,
                    Err(ProviderError::CapabilityUnsupported { .. }) | Ok(_)
                ),
                format!("{outcome:?}"),
            );
            // The default provider emulates, so the request above should have
            // *succeeded* through the emulation path.
            match &outcome {
                Ok(response) => doc.check(
                    "the turn is degraded into emulation rather than failed",
                    response
                        .degradations
                        .iter()
                        .any(|d| matches!(d, Degradation::ToolCallingEmulated { .. })),
                    describe_degradations(&response.degradations),
                ),
                Err(error) => doc.check(
                    "the turn is degraded into emulation rather than failed",
                    false,
                    format!("{error:?}"),
                ),
            }
        }
    }

    // --- emulation, end to end, on the endpoint that has no tools -----------
    if profile == "small-local" {
        doc.h("control: the same request with emulation switched OFF");
        let native_only = provider_for(url, &log).with_options(ProviderOptions {
            emulate_tools: false,
            ..ProviderOptions::default()
        });
        let refusal = native_only
            .complete(
                user(profile, "weather?")
                    .with_tools([weather_tool()])
                    .with_tool_choice(ToolChoice::Required),
                &context(),
            )
            .await;
        doc.wire(&log.drain());
        doc.kv("outcome", format!("{refusal:?}"));
        doc.check(
            "control — this endpoint really does refuse a native tools request",
            matches!(
                refusal,
                Err(ProviderError::CapabilityUnsupported {
                    capability: vela_providers::Capability::ToolCalling,
                    ..
                })
            ),
            "if this passes, the emulation result below is not an artefact",
        );

        doc.h("the emulation path, end to end");
        doc.p(
            "  The prompt carries a call in the shape a small model writes one (no quotes at\n  \
             all) and the endpoint echoes it back. That is the honest limit of a mock: it\n  \
             proves the request rewriting, the round trip and the parser — not that any model\n  \
             would choose to emit a call.",
        );
        let started = Instant::now();
        let emulated = provider
            .complete(
                user(
                    profile,
                    "<tool_call>{name: echo_tool, arguments: {text: ok}}</tool_call>",
                )
                .with_tools([ToolDefinition::new(
                    "echo_tool",
                    "Echo some text",
                    json!({"type": "object", "properties": {"text": {"type": "string"}}}),
                )])
                .with_tool_choice(ToolChoice::Auto),
                &context(),
            )
            .await;
        let elapsed = started.elapsed();
        doc.wire(&log.drain());
        match &emulated {
            Ok(response) => {
                doc.kv(
                    "answer shown to the user",
                    format!("{:?}", response.answer_text()),
                );
                doc.kv("tool calls", describe_calls(&response.tool_calls));
                doc.kv("stop reason", format!("{:?}", response.stop_reason));
                doc.kv(
                    "degradations",
                    describe_degradations(&response.degradations),
                );
            }
            Err(error) => doc.kv("error", format!("{error:?}")),
        }
        doc.kv("wall clock", format!("{elapsed:?}"));

        let response = emulated.ok();
        let calls: Vec<ToolCallOutcome> = response
            .as_ref()
            .map(|r| r.executable_tool_calls().cloned().collect())
            .unwrap_or_default();
        doc.check(
            "the textual call is recovered into an executable call",
            calls.len() == 1,
            describe_calls(&calls),
        );
        doc.check(
            "arguments survive the round trip and the call is marked emulated",
            matches!(
                calls.first(),
                Some(ToolCallOutcome::Ok { name, arguments, emulated, .. })
                    if name == "echo_tool" && arguments["text"] == "ok" && *emulated
            ),
            describe_calls(&calls),
        );
        doc.check(
            "call markup never reaches the user-visible answer",
            response
                .as_ref()
                .is_some_and(|r| !r.answer_text().contains("tool_call")),
            format!("{:?}", response.as_ref().map(|r| r.answer_text())),
        );
        doc.check(
            "the emulation is declared as a degradation",
            response.as_ref().is_some_and(|r| {
                r.degradations
                    .iter()
                    .any(|d| matches!(d, Degradation::ToolCallingEmulated { .. }))
            }),
            describe_degradations(
                &response
                    .as_ref()
                    .map(|r| r.degradations.clone())
                    .unwrap_or_default(),
            ),
        );
        doc.check(
            "the emulated turn ends in ToolUse, like a native one",
            response
                .as_ref()
                .is_some_and(|r| r.stop_reason == StopReason::ToolUse),
            format!("{:?}", response.as_ref().map(|r| r.stop_reason)),
        );
    }

    // --- the shape the live matrix cannot produce: parallel tool calls -------
    //
    // No matrix profile ever returns more than one WELL-FORMED call, so the
    // ordinary case of a model asking for two tools at once is invisible to the
    // live harness. It is the commonest tool-calling shape there is, so it is
    // scripted here instead: the bytes below are the OpenAI parallel-tool-calls
    // response, verbatim in shape. SCRIPTED BYTES, not the live endpoint — but
    // they go through exactly the same accumulator.
    if profile == "frontier" {
        use vela_providers::http::testing::{CannedResponse, ScriptedTransport};

        doc.h("SCRIPTED: two well-formed calls in one answer (parallel tool calls)");
        doc.p(
            "  Not from the live harness — no matrix profile emits two good calls. These are\n  \
             scripted bytes in the shape every OpenAI-compatible endpoint uses for parallel\n  \
             tool calls. Note what the two shapes differ in: streamed elements carry `index`\n  \
             and are FRAGMENTS; non-streamed elements carry NO `index` and are WHOLE CALLS.",
        );

        let non_streamed = r#"{"id":"chatcmpl-parallel","object":"chat.completion","created":1700000000,"model":"mock-frontier","choices":[{"index":0,"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_a","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"berlin\"}"}},{"id":"call_b","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"paris\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":9,"completion_tokens":9,"total_tokens":18}}"#;
        let streamed_frames = vec![
            "data: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\"arguments\":\"{\\\"city\\\":\\\"berlin\\\"}\"}}]}}]}\n\n",
            "data: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"call_b\",\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\"arguments\":\"{\\\"city\\\":\\\"paris\\\"}\"}}]}}]}\n\n",
            "data: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n",
        ];
        doc.p(format!(
            "\n  --- scripted non-streaming body ---\n{}",
            indent(non_streamed, 6)
        ));
        doc.p(format!(
            "\n  --- scripted streaming body ---\n{}",
            indent(&streamed_frames.join(""), 6)
        ));

        let scripted_provider = |transport: ScriptedTransport| {
            OpenAiCompatibleProvider::new(
                ProviderDescriptor::new("scripted", "Scripted", ProviderKind::Local)
                    .expect("valid"),
                "http://127.0.0.1:1/v1",
                Auth::None,
                Arc::new(MemoryStore::new()),
                Arc::new(transport),
            )
        };

        let whole = scripted_provider(ScriptedTransport::ok(non_streamed))
            .complete(
                user(profile, "weather in Berlin and Paris").with_tools([weather_tool()]),
                &context(),
            )
            .await;
        let mut sink = CollectingSink::new();
        let streamed = scripted_provider(ScriptedTransport::new(vec![Ok(CannedResponse::sse(
            streamed_frames,
        ))]))
        .stream(
            user(profile, "weather in Berlin and Paris").with_tools([weather_tool()]),
            &mut sink,
            &context(),
        )
        .await;

        doc.h("what Vela produced from each");
        let whole_calls = whole
            .as_ref()
            .map(|r| r.tool_calls.clone())
            .unwrap_or_default();
        let streamed_calls = streamed
            .as_ref()
            .map(|r| r.tool_calls.clone())
            .unwrap_or_default();
        doc.kv("non-streamed calls", describe_calls(&whole_calls));
        doc.kv("streamed calls", describe_calls(&streamed_calls));
        doc.kv(
            "non-streamed executable",
            whole
                .as_ref()
                .map_or(0, |r| r.executable_tool_calls().count()),
        );
        doc.kv(
            "streamed executable",
            streamed
                .as_ref()
                .map_or(0, |r| r.executable_tool_calls().count()),
        );

        doc.h("assertions");
        doc.check(
            "streamed: two parallel calls come back as two executable calls",
            streamed
                .as_ref()
                .is_ok_and(|r| r.executable_tool_calls().count() == 2),
            describe_calls(&streamed_calls),
        );
        doc.check(
            "non-streamed: two parallel calls come back as two executable calls",
            whole
                .as_ref()
                .is_ok_and(|r| r.executable_tool_calls().count() == 2),
            describe_calls(&whole_calls),
        );
        doc.check(
            "the streamed and non-streamed paths agree on the same answer",
            whole_calls.len() == streamed_calls.len(),
            format!(
                "non-streamed {} call(s), streamed {} call(s)",
                whole_calls.len(),
                streamed_calls.len()
            ),
        );
    }

    doc.write(ledger);
}

// ===========================================================================
// Case 03 — vision
// ===========================================================================

async fn case_03(
    profile: &str,
    url: &str,
    capabilities: &ModelCapabilities,
    ledger: &mut Vec<Verdict>,
) {
    let log = WireLog::default();
    let mut doc = Doc::new(
        profile,
        "03-vision",
        "image input",
        "Vision where the endpoint has it. Where it does not: the affordance must be absent, \
         and an image must be refused explicitly.",
    );

    let image_request = || {
        ChatRequest::new(model_of(profile)).with_message(ChatMessage::new(
            MessageRole::User,
            vec![
                ContentPart::text("what is in this image?"),
                ContentPart::Image {
                    mime_type: "image/png".into(),
                    data: vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
                },
            ],
        ))
    };

    // A provider that has *already* been probed — the state the app is in after
    // the settings screen has run once.
    let probed = provider_for(url, &log).with_capabilities(capabilities.clone());
    let started = Instant::now();
    let outcome = probed.complete(image_request(), &context()).await;
    let elapsed = started.elapsed();
    let entries = log.drain();

    doc.h("an image sent to a provider whose capabilities are known");
    doc.wire(&entries);
    doc.h("what Vela produced");
    match &outcome {
        Ok(response) => doc.kv("answer", format!("{:?}", response.answer_text())),
        Err(error) => doc.kv("error", format!("{error:?}")),
    }
    doc.kv(
        "probed vision support",
        format!("{:?}", capabilities.vision),
    );
    doc.kv("UI vision affordance", capabilities.to_descriptor().vision);
    doc.kv("requests actually sent", entries.len());
    doc.kv("wall clock", format!("{elapsed:?}"));

    doc.h("assertions");
    if profile == "frontier" {
        doc.check(
            "vision is offered and an image is answered",
            outcome.is_ok() && capabilities.to_descriptor().vision,
            format!("{:?}", outcome.as_ref().map(|r| r.answer_text())),
        );
    } else {
        doc.check(
            "the vision affordance is NOT offered to the UI",
            !capabilities.to_descriptor().vision,
            format!(
                "descriptor.vision = {}",
                capabilities.to_descriptor().vision
            ),
        );
        doc.check(
            "an image is refused as a capability error, not a generic 400",
            matches!(
                &outcome,
                Err(ProviderError::CapabilityUnsupported {
                    capability: vela_providers::Capability::Vision,
                    ..
                })
            ),
            format!("{outcome:?}"),
        );
        doc.check(
            "the refusal is local — the image never leaves the machine",
            entries.is_empty(),
            format!("{} HTTP request(s) were made", entries.len()),
        );
        doc.check(
            "a vision refusal is never shopped around to other backends",
            outcome.as_ref().err().is_some_and(|e| !e.allows_failover()),
            format!("{outcome:?}"),
        );
    }

    // The unprobed case: Vela has no reason to believe anything yet.
    doc.h("the same image before any probe has run");
    let fresh = provider_for(url, &log);
    let unprobed = fresh.complete(image_request(), &context()).await;
    let fresh_wire = log.drain();
    doc.wire(&fresh_wire);
    doc.kv("outcome", format!("{unprobed:?}"));
    doc.check(
        if profile == "frontier" {
            "an unprobed vision endpoint answers"
        } else {
            "an unprobed endpoint's refusal is learned from the endpoint itself"
        },
        if profile == "frontier" {
            unprobed.is_ok()
        } else {
            matches!(
                &unprobed,
                Err(ProviderError::CapabilityUnsupported {
                    capability: vela_providers::Capability::Vision,
                    ..
                })
            )
        },
        format!("{unprobed:?}"),
    );

    doc.write(ledger);
}

// ===========================================================================
// Case 04 — structured output (the silent one)
// ===========================================================================

async fn case_04(profile: &str, url: &str, ledger: &mut Vec<Verdict>) {
    let log = WireLog::default();
    let provider = provider_for(url, &log);
    let mut doc = Doc::new(
        profile,
        "04-structured-output",
        "structured output",
        "MEASURED-5: three of four profiles answer 200 with prose and say nothing. Vela must \
         never hand that back as if it conformed.",
    );

    let schema = json!({
        "type": "object",
        "properties": {"city": {"type": "string"}, "celsius": {"type": "number"}},
        "required": ["city", "celsius"]
    });
    let request = || {
        ChatRequest::new(model_of(profile))
            .with_message(ChatMessage::user("give me the weather in Berlin as JSON"))
            .with_response_format(ResponseFormat::JsonSchema {
                name: "weather".into(),
                schema: schema.clone(),
            })
    };

    doc.h("a json_schema request, non-streaming");
    let started = Instant::now();
    let outcome = provider.complete(request(), &context()).await;
    let elapsed = started.elapsed();
    doc.wire(&log.drain());

    doc.h("what Vela produced");
    let response = match outcome {
        Ok(response) => response,
        Err(error) => {
            doc.kv("error", format!("{error:?}"));
            doc.check(
                "a structured request produces a verdict",
                false,
                format!("{error:?}"),
            );
            doc.write(ledger);
            return;
        }
    };
    doc.kv("answer text", format!("{:?}", response.answer_text()));
    doc.kv("structured verdict", format!("{:?}", response.structured));
    doc.kv(
        "degradations",
        describe_degradations(&response.degradations),
    );
    doc.kv("wall clock", format!("{elapsed:?}"));

    doc.h("assertions");
    doc.check(
        "a structured request always comes back with an explicit verdict",
        response.structured.is_some(),
        format!("{:?}", response.structured),
    );
    if profile == "frontier" {
        let conformed =
            matches!(&response.structured, Some(Ok(value)) if value.get("city").is_some());
        doc.check(
            "an endpoint that honours the schema returns validated JSON",
            conformed,
            format!("{:?}", response.structured),
        );
    } else {
        doc.check(
            "prose is NEVER presented as conforming JSON (the gate's most dangerous case)",
            matches!(&response.structured, Some(Err(_))),
            format!("{:?}", response.structured),
        );
        doc.check(
            "the mismatch is a reported degradation, not a silent one",
            response
                .degradations
                .iter()
                .any(|d| matches!(d, Degradation::StructuredOutputMismatch { .. })),
            describe_degradations(&response.degradations),
        );
        doc.check(
            "the endpoint's behaviour is remembered, so the affordance is withdrawn",
            provider
                .known_capabilities(&model_of(profile))
                .structured_output
                == Support::Degraded,
            format!(
                "{:?}",
                provider
                    .known_capabilities(&model_of(profile))
                    .structured_output
            ),
        );
    }

    // Streaming is a separate code path; MEASURED-5 applies to it too. A FRESH
    // provider, because the one above has already learned this endpoint ignores
    // schemas and would now refuse the request before sending it.
    doc.h("the same request, STREAMED, on a provider that has learned nothing yet");
    let fresh = provider_for(url, &log);
    let mut sink = CollectingSink::new();
    let streamed = fresh.stream(request(), &mut sink, &context()).await;
    doc.wire(&log.drain());
    match &streamed {
        Ok(response) => {
            doc.kv("answer text", format!("{:?}", response.answer_text()));
            doc.kv("structured verdict", format!("{:?}", response.structured));
            doc.kv(
                "degradations",
                describe_degradations(&response.degradations),
            );
        }
        Err(error) => doc.kv("error", format!("{error:?}")),
    }
    doc.check(
        "the streaming path validates structured output as well",
        match (&streamed, profile) {
            (Ok(response), "frontier") => matches!(&response.structured, Some(Ok(_))),
            (Ok(response), _) => matches!(&response.structured, Some(Err(_))),
            (Err(_), _) => false,
        },
        format!("{:?}", streamed.as_ref().map(|r| r.structured.clone())),
    );

    // And with the refusing policy, the affordance is withdrawn before the wire.
    doc.h("the same request under StructuredOutputPolicy::Refuse, after probing");
    let refusing = provider_for(url, &log).with_options(ProviderOptions {
        structured_output: StructuredOutputPolicy::Refuse,
        ..ProviderOptions::default()
    });
    let probed = refusing
        .probe_capabilities(&model_of(profile), &context())
        .await;
    let _ = log.drain();
    let refused = refusing.complete(request(), &context()).await;
    let refuse_wire = log.drain();
    doc.wire(&refuse_wire);
    doc.kv(
        "probe verdict",
        format!("{:?}", probed.map(|c| c.structured_output)),
    );
    doc.kv("outcome", format!("{refused:?}"));
    if profile == "frontier" {
        doc.check(
            "refusal is a capability decision, not a blanket ban",
            refused.is_ok(),
            format!("{refused:?}"),
        );
    } else {
        doc.check(
            "a probed-bad endpoint is refused locally, with no request sent",
            matches!(
                &refused,
                Err(ProviderError::CapabilityUnsupported {
                    capability: vela_providers::Capability::StructuredOutput,
                    ..
                })
            ) && refuse_wire.is_empty(),
            format!("{refused:?}; {} request(s) sent", refuse_wire.len()),
        );
    }

    doc.write(ledger);
}

// ===========================================================================
// Case 05 — context overflow
// ===========================================================================

async fn case_05(profile: &str, url: &str, ledger: &mut Vec<Verdict>) {
    let log = WireLog::default();
    let provider = provider_for(url, &log);
    let mut doc = Doc::new(
        profile,
        "05-context-overflow",
        "context overflow",
        "A prompt that cannot fit. A clean, surfaced error carrying the endpoint's own numbers — \
         never a crash and never a silent truncation.",
    );

    let window: usize = match profile {
        "frontier" => 200_000,
        "mid-local" => 32_768,
        "small-local" => 8_192,
        _ => 4_096,
    };
    // Four characters per token in the harness's arithmetic, plus a margin.
    let filler = "x".repeat(window * 5);

    doc.h("an oversized prompt, with no local planning (max_context_tokens unset)");
    doc.p(format!("  prompt length: {} characters", filler.len()));
    let started = Instant::now();
    let outcome = provider.complete(user(profile, &filler), &context()).await;
    let elapsed = started.elapsed();
    doc.wire(&log.drain());

    doc.h("what Vela produced");
    doc.kv("outcome", format!("{outcome:?}"));
    doc.kv("wall clock", format!("{elapsed:?}"));

    doc.h("assertions");
    let matched = match &outcome {
        Err(ProviderError::ContextLengthExceeded {
            limit_tokens,
            requested_tokens,
            ..
        }) => {
            doc.kv(
                "limit reported by the endpoint",
                format!("{limit_tokens:?}"),
            );
            doc.kv(
                "requested, per the endpoint",
                format!("{requested_tokens:?}"),
            );
            (
                *limit_tokens == Some(window as u32),
                requested_tokens.is_some_and(|n| n as usize > window),
            )
        }
        _ => (false, false),
    };
    doc.check(
        "an overflow is a clean ContextLengthExceeded, not a generic transport error",
        matches!(&outcome, Err(ProviderError::ContextLengthExceeded { .. })),
        format!("{outcome:?}"),
    );
    doc.check(
        "the endpoint's own window is carried through so the UI can say something true",
        matched.0,
        format!("expected limit {window}"),
    );
    doc.check(
        "the requested size is carried through too",
        matched.1,
        format!("{outcome:?}"),
    );
    doc.check(
        "an overflow is never retried elsewhere — it is about the request",
        outcome.as_ref().err().is_some_and(|e| !e.allows_failover()),
        format!("{outcome:?}"),
    );

    // The other half: when the window IS known, reduce visibly rather than be refused.
    doc.h("the same conversation when the window is known — reduce, visibly");
    let mut long = ChatRequest::new(model_of(profile)).with_max_context_tokens(window as u32);
    // Each turn is one window's worth of characters, i.e. a quarter of a window
    // in the harness's four-characters-per-token arithmetic. Twelve of them is
    // three windows: the conversation cannot fit and something has to go.
    let turn_size = window;
    for turn in 0..12 {
        long = long
            .with_message(ChatMessage::user(format!(
                "turn {turn}: {}",
                "y".repeat(turn_size)
            )))
            .with_message(ChatMessage::assistant("understood"));
    }
    long = long.with_message(ChatMessage::user("finally: what did I ask first?"));
    let reduced = provider.complete(long, &context()).await;
    doc.wire(&log.drain());
    match &reduced {
        Ok(response) => {
            doc.kv(
                "answer",
                format!("{:?}", elide(&response.answer_text(), 200)),
            );
            doc.kv(
                "degradations",
                describe_degradations(&response.degradations),
            );
        }
        Err(error) => doc.kv("error", format!("{error:?}")),
    }
    let dropped = reduced.as_ref().ok().and_then(|response| {
        response.degradations.iter().find_map(|d| match d {
            Degradation::ContextReduced {
                dropped_messages, ..
            } => Some(*dropped_messages),
            _ => None,
        })
    });
    doc.check(
        "a conversation that will not fit is reduced and answered, not refused",
        reduced.is_ok(),
        format!("{reduced:?}"),
    );
    doc.check(
        "the reduction is reported explicitly — never a silent truncation",
        dropped.is_some_and(|n| n > 0),
        format!("dropped messages = {dropped:?}"),
    );

    doc.write(ledger);
}

// ===========================================================================
// Case 06 — reasoning
// ===========================================================================

async fn case_06(profile: &str, url: &str, ledger: &mut Vec<Verdict>) {
    let log = WireLog::default();
    let provider = provider_for(url, &log);
    let mut doc = Doc::new(
        profile,
        "06-reasoning",
        "reasoning separation",
        "MEASURED-3: `</think>` splits across frames, hostile never closes its block, frontier \
         uses a separate field. No markup may leak, and reasoning must never reach tool parsing.",
    );

    let mut sink = CollectingSink::new();
    let started = Instant::now();
    let outcome = provider
        .stream(
            user(profile, "what is the weather in Berlin"),
            &mut sink,
            &context(),
        )
        .await;
    let elapsed = started.elapsed();
    let entries = log.drain();

    doc.h("the raw stream");
    doc.wire(&entries);

    doc.h("what Vela produced");
    let response = match outcome {
        Ok(response) => response,
        Err(error) => {
            doc.kv("error", format!("{error:?}"));
            doc.check("a reasoning turn completes", false, format!("{error:?}"));
            doc.write(ledger);
            return;
        }
    };
    doc.kv(
        "user-visible answer",
        format!("{:?}", response.answer_text()),
    );
    doc.kv(
        "reasoning channel",
        format!("{:?}", response.reasoning_text()),
    );
    doc.kv("ReasoningDelta events", format!("{:?}", sink.reasoning()));
    doc.kv(
        "content parts",
        format!(
            "{:?}",
            response.parts.iter().map(part_kind).collect::<Vec<_>>()
        ),
    );
    doc.kv(
        "degradations",
        describe_degradations(&response.degradations),
    );
    doc.kv("wall clock", format!("{elapsed:?}"));

    // The naive baseline: what a frame-local stripper would have shown.
    let raw = raw_content_of(&entries);
    doc.h("baseline — every `content` delta concatenated, no state machine");
    doc.p(indent(&elide(&format!("{raw:?}"), 1_200), 4));

    doc.h("assertions");
    doc.check(
        "no reasoning markup reaches the user-visible answer",
        !response.answer_text().contains("<think")
            && !response.answer_text().contains("</thi")
            && !response.answer_text().contains("think>"),
        format!("{:?}", response.answer_text()),
    );
    doc.check(
        "the answer itself survives",
        response
            .answer_text()
            .contains(&format!("Mock {profile} reply to:")),
        format!("{:?}", elide(&response.answer_text(), 200)),
    );
    doc.check(
        "the deltas the consumer saw equal the final answer",
        sink.text() == response.answer_text(),
        format!(
            "{} vs {} chars",
            sink.text().chars().count(),
            response.answer_text().chars().count()
        ),
    );

    match profile {
        "mid-local" => {
            doc.check(
                "reasoning is captured, not discarded",
                response
                    .reasoning_text()
                    .contains("Considering the request"),
                format!("{:?}", response.reasoning_text()),
            );
            doc.check(
                "reasoning is stored as its own content part (vela-store models it separately)",
                response
                    .parts
                    .iter()
                    .any(|part| matches!(part, ContentPart::Reasoning { .. })),
                format!(
                    "{:?}",
                    response.parts.iter().map(part_kind).collect::<Vec<_>>()
                ),
            );
            doc.check(
                "the closing tag is in NO single frame — a frame-local stripper cannot work",
                !frame_datas(&entries)
                    .iter()
                    .any(|frame| frame.contains("</think>")),
                "confirmed against the recorded frames",
            );
        }
        "hostile" => {
            doc.check(
                "an unterminated <think> does not swallow the answer",
                response
                    .answer_text()
                    .contains(&format!("Mock {profile} reply to:")),
                format!("{:?}", response.answer_text()),
            );
            doc.check(
                "the recovery is declared, not silent",
                response
                    .degradations
                    .iter()
                    .any(|d| matches!(d, Degradation::UnterminatedReasoning { .. })),
                describe_degradations(&response.degradations),
            );
        }
        "frontier" => {
            doc.check(
                "reasoning from a dedicated field lands in the reasoning channel",
                !response.reasoning_text().is_empty() && !sink.reasoning().is_empty(),
                format!("{:?}", response.reasoning_text()),
            );
            doc.check(
                "and never in the answer channel",
                !response.answer_text().contains("Considering the request"),
                format!("{:?}", response.answer_text()),
            );
        }
        _ => {
            doc.check(
                "an endpoint that emits no reasoning produces no reasoning part",
                response.reasoning_text().is_empty(),
                format!("{:?}", response.reasoning_text()),
            );
        }
    }

    // ---- reasoning must never reach tool-call parsing ----------------------
    // Only meaningful where reasoning exists AND emulation is in play, so the
    // textual tool-call parser is running at all. Emulation is switched on by
    // seeding what a previous probe would have learned.
    if profile == "mid-local" {
        doc.h("reasoning is excluded from tool-call parsing — NOT CONSTRUCTIBLE HERE");
        doc.p(
            "  This profile carries reasoning INLINE, inside the same `content` channel the\n  \
             answer uses, and the harness budgets that channel as one string. There is\n  \
             therefore no `max_output_tokens` that leaves tool-call markup in the reasoning\n  \
             half while removing it from the answer half: the budget cuts both together. The\n  \
             probe is run on `frontier`, whose reasoning arrives in a separate, unbudgeted\n  \
             field. Recorded rather than quietly omitted.",
        );
    }
    if profile == "frontier" {
        doc.h("reasoning is excluded from tool-call parsing");
        doc.p(
            "  Emulation is active (seeded as if a previous probe had found no native tools), so\n  \
             the textual <tool_call> parser IS running. The prompt puts a complete tool_call\n  \
             block where the endpoint echoes it into BOTH channels, then `max_output_tokens` is\n  \
             squeezed until the answer channel is cut short of the markup while the reasoning\n  \
             channel — which is not budgeted by the harness — still carries all of it.",
        );
        let mut seeded = ModelCapabilities::unknown(model_of(profile));
        seeded.tool_calling = Support::Unsupported;
        let emulating = provider_for(url, &log).with_capabilities(seeded);
        let poison = "<tool_call>{name: echo_tool, arguments: {text: ok}}</tool_call>";
        let echo_tool = ToolDefinition::new(
            "echo_tool",
            "Echo some text",
            json!({"type": "object", "properties": {"text": {"type": "string"}}}),
        );

        let squeezed = emulating
            .complete(
                user(profile, poison)
                    .with_tools([echo_tool.clone()])
                    .with_tool_choice(ToolChoice::Auto)
                    .with_max_output_tokens(4),
                &context(),
            )
            .await;
        let squeezed_wire = log.drain();
        doc.wire(&squeezed_wire);
        let squeezed_raw = raw_content_of(&squeezed_wire);
        let squeezed_reasoning = raw_reasoning_of(&squeezed_wire);
        doc.kv("answer channel on the wire", format!("{squeezed_raw:?}"));
        doc.kv(
            "reasoning channel on the wire",
            format!("{squeezed_reasoning:?}"),
        );
        match &squeezed {
            Ok(response) => {
                doc.kv("answer", format!("{:?}", response.answer_text()));
                doc.kv("tool calls", describe_calls(&response.tool_calls));
            }
            Err(error) => doc.kv("error", format!("{error:?}")),
        }

        let markup_only_in_reasoning = !squeezed_raw.contains("<tool_call>")
            && (squeezed_reasoning.contains("<tool_call>")
                || raw_full_reasoning_contains(&squeezed_wire, "tool_call"));
        doc.check(
            "precondition — the markup is in the reasoning channel and not in the answer channel",
            markup_only_in_reasoning,
            format!("answer={squeezed_raw:?} reasoning={squeezed_reasoning:?}"),
        );
        doc.check(
            "NO tool call is recovered from reasoning text",
            squeezed
                .as_ref()
                .is_ok_and(|response| response.tool_calls.is_empty()),
            format!(
                "{:?}",
                squeezed.as_ref().map(|r| describe_calls(&r.tool_calls))
            ),
        );

        // Positive control: hand the same parser the same markup in the ANSWER
        // channel and it must find the call. Otherwise the check above passes
        // for the trivial reason that nothing is parsing anything.
        let unsqueezed = emulating
            .complete(
                user(profile, poison)
                    .with_tools([echo_tool])
                    .with_tool_choice(ToolChoice::Auto),
                &context(),
            )
            .await;
        let unsqueezed_wire = log.drain();
        doc.h("positive control — the same markup, in the answer channel");
        doc.kv(
            "answer channel on the wire",
            format!("{:?}", elide(&raw_content_of(&unsqueezed_wire), 400)),
        );
        doc.kv(
            "tool calls",
            match &unsqueezed {
                Ok(response) => describe_calls(&response.tool_calls),
                Err(error) => format!("{error:?}"),
            },
        );
        doc.check(
            "control — the parser DOES recover a call when the markup is in the answer",
            unsqueezed
                .as_ref()
                .is_ok_and(|response| response.executable_tool_calls().count() == 1),
            "if this fails, the assertion above proves nothing",
        );
    }

    doc.write(ledger);
}

fn part_kind(part: &ContentPart) -> &'static str {
    match part {
        ContentPart::Text { .. } => "text",
        ContentPart::Reasoning { .. } => "reasoning",
        ContentPart::Image { .. } => "image",
        _ => "other",
    }
}

// ===========================================================================
// Case 07 — stream termination
// ===========================================================================

async fn case_07(profile: &str, url: &str, ledger: &mut Vec<Verdict>) {
    let log = WireLog::default();
    let provider = provider_for(url, &log);
    let mut doc = Doc::new(
        profile,
        "07-stream-termination",
        "stream termination",
        "MEASURED-1: hostile never sends [DONE]; small-local accepts include_usage and never \
         sends usage. Both hung a recorded consumer for over 5 s. Vela must terminate on \
         end-of-body.",
    );

    let mut sink = CollectingSink::new();
    let started = Instant::now();
    let outcome = tokio::time::timeout(
        Duration::from_secs(20),
        provider.stream(
            user(profile, "what is the weather in Berlin").with_max_output_tokens(256),
            &mut sink,
            &context(),
        ),
    )
    .await;
    let elapsed = started.elapsed();
    let entries = log.drain();

    doc.h("the stream");
    doc.wire(&entries);

    doc.h("timing — the number this case exists for");
    doc.kv("WALL CLOCK for the whole turn", format!("{elapsed:?}"));
    doc.kv("recorded naive [DONE] consumer", "5003 ms (TIMED OUT)");
    doc.kv("recorded naive usage consumer", "5006 ms (TIMED OUT)");
    let body = joined_bodies(&entries);
    doc.kv(
        "`data: [DONE]` present in the body",
        body.contains("data: [DONE]"),
    );
    doc.kv(
        "a usage frame present in the body",
        body.contains("\"usage\""),
    );

    doc.h("what Vela produced");
    let response = match outcome {
        Err(_) => {
            doc.p("  HUNG: the turn did not finish within a 20 s outer deadline.");
            doc.check(
                "the turn terminates at all",
                false,
                "20 s outer deadline hit",
            );
            doc.write(ledger);
            return;
        }
        Ok(Err(error)) => {
            doc.kv("error", format!("{error:?}"));
            doc.check(
                "the turn terminates without error",
                false,
                format!("{error:?}"),
            );
            doc.write(ledger);
            return;
        }
        Ok(Ok(response)) => response,
    };
    doc.kv(
        "answer",
        format!("{:?}", elide(&response.answer_text(), 400)),
    );
    doc.kv("usage", format!("{:?}", response.usage));
    doc.kv(
        "degradations",
        describe_degradations(&response.degradations),
    );

    doc.h("assertions");
    doc.check(
        "VELA DOES NOT HANG — the turn finishes far inside the recorded 5003 ms hang",
        elapsed < Duration::from_secs(2),
        format!("wall clock {elapsed:?}"),
    );
    doc.check(
        "the answer arrives whole regardless of how the stream ended",
        !response.answer_text().is_empty(),
        format!("{} characters", response.answer_text().chars().count()),
    );
    if !body.contains("data: [DONE]") {
        doc.check(
            "a missing [DONE] sentinel is reported, not silently absorbed",
            response
                .degradations
                .contains(&Degradation::NoTerminationSentinel),
            describe_degradations(&response.degradations),
        );
    } else {
        doc.check(
            "a stream that does send [DONE] reports no missing-sentinel degradation",
            !response
                .degradations
                .contains(&Degradation::NoTerminationSentinel),
            describe_degradations(&response.degradations),
        );
    }
    let usage_arrived = !response.usage.is_unreported();
    doc.check(
        "usage is reported only when it actually arrived — never invented",
        usage_arrived == body.contains("\"completion_tokens\""),
        format!("usage = {:?}", response.usage),
    );
    if !usage_arrived {
        doc.check(
            "requested-but-absent usage is declared as a degradation",
            response
                .degradations
                .contains(&Degradation::UsageNotReported),
            describe_degradations(&response.degradations),
        );
    }

    doc.write(ledger);
}

/// A stalled socket: frames arrive slower than the stall budget allows.
async fn case_07b(profile: &str, ledger: &mut Vec<Verdict>) {
    let mut doc = Doc::new(
        profile,
        "07b-stalled-socket",
        "a socket that stops producing",
        "Every read carries a stall timeout, so a wedged endpoint cannot wedge the app.",
    );
    let server = MockServer::start(profile, &["--chunk-delay", "4000"]).await;
    let log = WireLog::default();
    let provider = provider_for(&server.url, &log);
    let stalling = RequestContext::new().with_timeouts(Timeouts {
        connect: Duration::from_secs(5),
        first_byte: Duration::from_secs(10),
        // Deliberately shorter than the endpoint's 4 s inter-frame delay.
        stall: Duration::from_millis(800),
    });

    let mut sink = CollectingSink::new();
    let started = Instant::now();
    let outcome = tokio::time::timeout(
        Duration::from_secs(30),
        provider.stream(user(profile, "hello"), &mut sink, &stalling),
    )
    .await;
    let elapsed = started.elapsed();
    doc.h("the stream (endpoint configured with --chunk-delay 4000, stall budget 800 ms)");
    doc.wire(&log.drain());
    doc.h("what Vela produced");
    doc.kv(
        "outcome",
        format!("{:?}", outcome.as_ref().map(|r| r.as_ref().map(|_| "Ok"))),
    );
    doc.kv(
        "error",
        format!("{:?}", outcome.as_ref().ok().and_then(|r| r.as_ref().err())),
    );
    doc.kv("WALL CLOCK", format!("{elapsed:?}"));

    doc.h("assertions");
    doc.check(
        "a stalled socket is abandoned rather than awaited forever",
        outcome.is_ok() && elapsed < Duration::from_secs(10),
        format!("{elapsed:?}"),
    );
    doc.check(
        "and the abandonment is an explicit error, not an empty success",
        matches!(&outcome, Ok(Err(_))),
        format!("{:?}", outcome.as_ref().ok().map(|r| r.is_err())),
    );
    doc.write(ledger);
    server.stop().await;
}

// ===========================================================================
// Case 08 — malformed frames
// ===========================================================================

async fn case_08(profile: &str, url: &str, ledger: &mut Vec<Verdict>) {
    let log = WireLog::default();
    let provider = provider_for(url, &log);
    let mut doc = Doc::new(
        profile,
        "08-malformed-frames",
        "malformed SSE frames",
        "MEASURED-2: a consumer that JSON.parse'd every frame threw after 4 frames and lost 318 \
         of 349 characters. One bad frame must cost one frame.",
    );

    let question = "what is the weather in Berlin";
    let mut sink = CollectingSink::new();
    let streamed = provider
        .stream(user(profile, question), &mut sink, &context())
        .await;
    let stream_wire = log.drain();
    let whole = provider.complete(user(profile, question), &context()).await;
    let _ = log.drain();

    doc.h("the stream");
    doc.wire(&stream_wire);

    let frames = frame_datas(&stream_wire);
    let bad: Vec<&String> = frames
        .iter()
        .filter(|frame| *frame != "[DONE]" && serde_json::from_str::<Value>(frame).is_err())
        .collect();

    doc.h("frame census");
    doc.kv("frames in the body", frames.len());
    doc.kv("frames that are not valid JSON", bad.len());
    for frame in &bad {
        doc.p(format!("    unparseable: {}", elide(frame, 160)));
    }

    doc.h("what Vela produced, against the non-streamed ground truth");
    let (streamed, whole) = match (streamed, whole) {
        (Ok(a), Ok(b)) => (a, b),
        (a, b) => {
            doc.p(format!("  streamed: {a:?}\n  whole: {b:?}"));
            doc.check(
                "a stream with malformed frames still completes",
                false,
                "see above",
            );
            doc.write(ledger);
            return;
        }
    };
    let streamed_text = streamed.answer_text();
    let whole_text = whole.answer_text();
    doc.kv(
        "streamed answer",
        format!("{:?}", elide(&streamed_text, 400)),
    );
    doc.kv(
        "non-streamed answer",
        format!("{:?}", elide(&whole_text, 400)),
    );
    doc.kv("streamed characters", streamed_text.chars().count());
    doc.kv("ground-truth characters", whole_text.chars().count());
    doc.kv(
        "degradations",
        describe_degradations(&streamed.degradations),
    );

    // The recorded naive consumer, reproduced over the same recorded bytes.
    let naive = naive_strict_json_text(&frames);
    doc.kv(
        "a strict-JSON consumer would have delivered",
        naive.chars().count(),
    );

    doc.h("assertions");
    let skipped = streamed
        .degradations
        .iter()
        .find_map(|d| match d {
            Degradation::MalformedFramesSkipped { count } => Some(*count),
            _ => None,
        })
        .unwrap_or(0);
    if bad.is_empty() {
        doc.check(
            "an endpoint that emits no bad frames produces no skip degradation",
            skipped == 0,
            describe_degradations(&streamed.degradations),
        );
    } else {
        doc.check(
            "skipping bad frames is reported, not silent",
            skipped >= bad.len(),
            format!(
                "reported {skipped} skipped, body contains {} bad frames",
                bad.len()
            ),
        );
        doc.check(
            "NO DATA LOSS — the stream delivers what a strict consumer would have lost",
            streamed_text.chars().count() > naive.chars().count(),
            format!(
                "Vela {} chars vs strict-JSON consumer {} chars",
                streamed_text.chars().count(),
                naive.chars().count()
            ),
        );
    }
    doc.check(
        "content that arrives AFTER the bad frames still reaches the user",
        {
            let tail: String = whole_text.chars().rev().take(20).collect();
            let tail: String = tail.chars().rev().collect();
            streamed_text.contains(tail.trim())
        },
        "the tail of the ground truth is present in the streamed answer",
    );
    doc.check(
        "one bad frame never aborts the turn",
        !streamed_text.is_empty(),
        format!("{} characters delivered", streamed_text.chars().count()),
    );

    doc.write(ledger);
}

// ===========================================================================
// Case 09 — no credential
// ===========================================================================

async fn case_09(profile: &str, url: &str, ledger: &mut Vec<Verdict>) {
    let log = WireLog::default();
    let mut doc = Doc::new(
        profile,
        "09-no-credential",
        "no credential",
        "`Auth::None` must put NOTHING on the wire — not even an empty Bearer, which this \
         endpoint answers 401 precisely to make the bug loud.",
    );

    let provider = provider_for(url, &log);
    let outcome = provider.complete(user(profile, "hello"), &context()).await;
    let entries = log.drain();

    doc.h("the request bytes");
    doc.wire(&entries);
    doc.h("what Vela produced");
    doc.kv(
        "outcome",
        format!(
            "{:?}",
            outcome.as_ref().map(|r| elide(&r.answer_text(), 120))
        ),
    );

    doc.h("assertions");
    doc.check(
        "a no-credential request is answered — absence of a key is a supported state",
        outcome.is_ok(),
        format!("{:?}", outcome.as_ref().err()),
    );
    let any_auth = entries.iter().any(|entry| {
        entry
            .request_headers
            .iter()
            .any(|(n, _)| n == "authorization")
    });
    doc.check(
        "NO `authorization` header appears on the wire at all",
        !any_auth,
        format!("{} exchange(s) inspected", entries.len()),
    );
    doc.check(
        "and no credential-shaped header of any other name appears either",
        !entries.iter().any(|entry| {
            entry.request_headers.iter().any(|(name, _)| {
                name.contains("api-key") || name.contains("token") || name == "x-goog-api-key"
            })
        }),
        "checked every recorded request header",
    );
    doc.check(
        "no credential is smuggled into the query string",
        !entries
            .iter()
            .any(|entry| entry.url.contains("key=") || entry.url.contains("token=")),
        entries
            .iter()
            .map(|e| e.url.to_string())
            .collect::<Vec<_>>()
            .join(" "),
    );

    // Positive control: the same code path WITH a credential must produce one.
    doc.h("positive control — the same provider configured with a bearer token");
    let store = Arc::new(MemoryStore::new());
    let secret = SecretRef::primary("matrix").expect("valid");
    store
        .set(&secret, &SecretValue::new("expected-key"))
        .expect("stored");
    let keyed = OpenAiCompatibleProvider::new(
        ProviderDescriptor::new("matrix", "Capability matrix", ProviderKind::Local).expect("valid"),
        format!("{url}/v1"),
        Auth::Bearer { secret },
        store,
        Arc::new(RecordingTransport::new(log.clone())),
    );
    let keyed_outcome = keyed.complete(user(profile, "hello"), &context()).await;
    let keyed_wire = log.drain();
    doc.wire(&keyed_wire);
    doc.kv("outcome", format!("{:?}", keyed_outcome.is_ok()));
    doc.check(
        "control — a configured credential DOES appear, so the assertion above can fail",
        keyed_wire.iter().any(|entry| {
            entry
                .request_headers
                .iter()
                .any(|(n, _)| n == "authorization")
        }),
        "if this fails, 'no authorization header' proves nothing",
    );

    // A binding that points at an empty keychain: never an empty header.
    doc.h("a credential binding with nothing stored");
    let empty_store = Arc::new(MemoryStore::new());
    let missing = OpenAiCompatibleProvider::new(
        ProviderDescriptor::new("matrix", "Capability matrix", ProviderKind::Local).expect("valid"),
        format!("{url}/v1"),
        Auth::Bearer {
            secret: SecretRef::primary("matrix").expect("valid"),
        },
        empty_store,
        Arc::new(RecordingTransport::new(log.clone())),
    );
    let missing_outcome = missing.complete(user(profile, "hello"), &context()).await;
    let missing_wire = log.drain();
    doc.kv("outcome", format!("{missing_outcome:?}"));
    doc.kv("requests sent", missing_wire.len());
    doc.check(
        "a missing credential is an auth failure, and NOTHING is sent",
        matches!(&missing_outcome, Err(ProviderError::AuthFailed { .. }))
            && missing_wire.is_empty(),
        format!("{} request(s) sent", missing_wire.len()),
    );
    doc.check(
        "an auth failure is never retried and never failed over",
        missing_outcome
            .as_ref()
            .err()
            .is_some_and(|e| !e.allows_retry() && !e.allows_failover()),
        format!("{missing_outcome:?}"),
    );

    doc.write(ledger);
}

/// The endpoint requires a key and Vela has none: a real 401 off the wire.
async fn case_09b(profile: &str, ledger: &mut Vec<Verdict>) {
    let mut doc = Doc::new(
        profile,
        "09b-endpoint-requires-a-key",
        "an endpoint that demands a credential",
        "The 401 must arrive as an auth failure and must never be sprayed at other backends.",
    );
    let server = MockServer::start(profile, &["--api-key", "expected-key"]).await;
    let log = WireLog::default();
    let provider = provider_for(&server.url, &log);
    let outcome = provider.complete(user(profile, "hello"), &context()).await;
    let entries = log.drain();
    doc.h("the exchange");
    doc.wire(&entries);
    doc.h("what Vela produced");
    doc.kv("outcome", format!("{outcome:?}"));
    doc.h("assertions");
    doc.check(
        "a 401 is normalised to AuthFailed, not a generic transport error",
        matches!(&outcome, Err(ProviderError::AuthFailed { .. })),
        format!("{outcome:?}"),
    );
    doc.check(
        "an auth failure is never retried and never failed over",
        outcome
            .as_ref()
            .err()
            .is_some_and(|e| !e.allows_retry() && !e.allows_failover()),
        format!("{outcome:?}"),
    );
    doc.check(
        "no upstream body or HTTP status escapes into the error",
        outcome.as_ref().err().is_some_and(|e| {
            !format!("{e}").contains("401") && !format!("{e}").contains("{\"error\"")
        }),
        format!("{outcome:?}"),
    );
    doc.write(ledger);
    server.stop().await;
}

// ===========================================================================
// Case 10 — failover, including an endpoint killed mid-request
// ===========================================================================

async fn case_10(profile: &str, ledger: &mut Vec<Verdict>) {
    let mut doc = Doc::new(
        profile,
        "10-failover",
        "routing and failover",
        "A dead candidate must be routed past. An endpoint that dies MID-STREAM, after the user \
         has already seen output, must NOT be replayed from another candidate.",
    );

    // --- a candidate that was never alive -----------------------------------
    let server = MockServer::start(profile, &[]).await;
    let log = WireLog::default();
    doc.h("candidate 1 refuses the connection; candidate 2 is live");
    let dead = Arc::new(provider_for("http://127.0.0.1:1", &log));
    let live = Arc::new(provider_for(&server.url, &log));
    let router = Router::new(vec![
        Candidate::new(dead, model_of(profile)),
        Candidate::new(live, model_of(profile)),
    ])
    .with_policy(RetryPolicy {
        max_attempts_per_candidate: 1,
        ..RetryPolicy::default()
    });
    let mut sink = CollectingSink::new();
    let started = Instant::now();
    let routed = tokio::time::timeout(
        Duration::from_secs(20),
        router.stream(user(profile, "hello"), &mut sink, &context()),
    )
    .await;
    let elapsed = started.elapsed();
    doc.wire(&log.drain());
    doc.kv(
        "outcome",
        format!("{:?}", routed.as_ref().map(|r| r.is_ok())),
    );
    doc.kv("wall clock", format!("{elapsed:?}"));
    let routed_ok = routed.as_ref().ok().and_then(|r| r.as_ref().ok());
    doc.kv(
        "answer",
        format!("{:?}", routed_ok.map(|r| elide(&r.answer_text(), 160))),
    );
    doc.kv(
        "degradations",
        routed_ok
            .map(|r| describe_degradations(&r.degradations))
            .unwrap_or_else(|| "(no response)".to_owned()),
    );
    doc.h("assertions");
    doc.check(
        "a dead candidate is routed past, not surfaced as a failure",
        routed_ok.is_some(),
        format!("{routed:?}"),
    );
    doc.check(
        "the failover is declared to the caller",
        routed_ok.is_some_and(|r| {
            r.degradations
                .iter()
                .any(|d| matches!(d, Degradation::FailedOver { .. }))
        }),
        routed_ok
            .map(|r| describe_degradations(&r.degradations))
            .unwrap_or_default(),
    );
    doc.check(
        "failover does not hang",
        elapsed < Duration::from_secs(15),
        format!("{elapsed:?}"),
    );
    server.stop().await;

    // --- an endpoint killed while it is answering ---------------------------
    doc.h("the endpoint is KILLED mid-stream, after output has already been shown");
    doc.p(
        "  The primary is started with a 40 ms inter-frame delay so the turn is still running\n  \
         when its process is SIGKILLed. A second, healthy candidate is configured behind it.\n  \
         Rule 2 of the router: once a character has reached the user, moving to another\n  \
         candidate would restart the answer in front of them.",
    );
    let mut primary = MockServer::start(profile, &["--chunk-delay", "40"]).await;
    let backup = MockServer::start(profile, &[]).await;
    let log = WireLog::default();
    let primary_provider = Arc::new(provider_for(&primary.url, &log));
    let backup_provider = Arc::new(provider_for(&backup.url, &log));
    let router = Router::new(vec![
        Candidate::new(primary_provider, model_of(profile)),
        Candidate::new(backup_provider, model_of(profile)),
    ])
    .with_policy(RetryPolicy {
        max_attempts_per_candidate: 1,
        ..RetryPolicy::default()
    });

    let mut sink = CollectingSink::new();
    let started = Instant::now();
    let killer = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        primary.kill().await;
        primary
    });
    let killed = tokio::time::timeout(
        Duration::from_secs(20),
        router.stream(
            user(profile, "write me something reasonably long").with_max_output_tokens(256),
            &mut sink,
            &context(),
        ),
    )
    .await;
    let elapsed = started.elapsed();
    let killed_server = killer.await.expect("killer task");
    drop(killed_server);
    let wire = log.drain();
    doc.wire(&wire);

    doc.h("what Vela produced");
    // "Committed" is whatever the user has already been shown. Reasoning counts:
    // it is rendered, so replaying the turn would restart it on screen.
    let committed = sink.events.iter().any(|event| {
        matches!(
            event,
            vela_providers::StreamEvent::TextDelta { text }
                | vela_providers::StreamEvent::ReasoningDelta { text } if !text.is_empty()
        ) || matches!(event, vela_providers::StreamEvent::ToolCallDelta { .. })
    });
    doc.kv("wall clock", format!("{elapsed:?}"));
    doc.kv(
        "answer text the user saw",
        format!("{:?}", elide(&sink.text(), 400)),
    );
    doc.kv(
        "reasoning text the user saw",
        format!("{:?}", elide(&sink.reasoning(), 400)),
    );
    doc.kv(
        "TextDelta events",
        sink.events
            .iter()
            .filter(|e| matches!(e, vela_providers::StreamEvent::TextDelta { .. }))
            .count(),
    );
    doc.kv(
        "ReasoningDelta events",
        sink.events
            .iter()
            .filter(|e| matches!(e, vela_providers::StreamEvent::ReasoningDelta { .. }))
            .count(),
    );
    match &killed {
        Err(_) => doc.kv("outcome", "HUNG — 20 s outer deadline"),
        Ok(Err(error)) => doc.kv("outcome", format!("Err({error:?})")),
        Ok(Ok(response)) => {
            doc.kv("outcome", "Ok");
            doc.kv(
                "answer",
                format!("{:?}", elide(&response.answer_text(), 400)),
            );
            doc.kv("stop reason", format!("{:?}", response.stop_reason));
            doc.kv(
                "degradations",
                describe_degradations(&response.degradations),
            );
        }
    }
    let exchanges_to_backup = wire
        .iter()
        .filter(|entry| entry.url.starts_with(&backup.url))
        .count();
    doc.kv("requests sent to the backup candidate", exchanges_to_backup);

    doc.h("assertions");
    doc.check(
        "killing the endpoint mid-stream does not hang the app",
        killed.is_ok() && elapsed < Duration::from_secs(15),
        format!("{elapsed:?}"),
    );
    doc.kv("output had already been committed", committed);
    if committed {
        doc.check(
            "after visible output, the turn is NOT replayed from another candidate",
            exchanges_to_backup == 0,
            format!("{exchanges_to_backup} request(s) reached the backup"),
        );
        let claims_clean_finish = matches!(
            &killed,
            Ok(Ok(response)) if response.stop_reason == StopReason::EndTurn
        );
        doc.check(
            "a killed stream is never reported as a normally finished turn",
            !claims_clean_finish,
            match &killed {
                Ok(Ok(response)) => format!(
                    "returned Ok with stop_reason {:?} and degradations {}",
                    response.stop_reason,
                    describe_degradations(&response.degradations)
                ),
                other => format!("{other:?}"),
            },
        );
    } else {
        doc.check(
            "with nothing yet shown, the healthy candidate answers",
            matches!(&killed, Ok(Ok(_))),
            format!("{killed:?}"),
        );
    }

    doc.write(ledger);
    backup.stop().await;
}

// ===========================================================================
// Recorded-bytes helpers (used to compute naive baselines from the transcripts)
// ===========================================================================

fn joined_bodies(entries: &[WireEntry]) -> String {
    entries
        .iter()
        .filter_map(|entry| match &entry.outcome {
            WireOutcome::Response { body, .. } => {
                Some(String::from_utf8_lossy(&body.lock().expect("poisoned")).into_owned())
            }
            WireOutcome::Failed(_) => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Every `data:` payload in every recorded SSE body.
///
/// A non-streamed body carries no `data:` lines at all; it is returned whole as
/// a single "frame" so the same helpers work on both paths.
fn frame_datas(entries: &[WireEntry]) -> Vec<String> {
    let bodies = joined_bodies(entries);
    let frames: Vec<String> = bodies
        .lines()
        .filter_map(|line| line.strip_prefix("data: ").map(str::to_owned))
        .collect();
    if frames.is_empty() && !bodies.trim().is_empty() {
        return bodies
            .split("\n{")
            .enumerate()
            .map(|(index, piece)| {
                if index == 0 {
                    piece.to_owned()
                } else {
                    format!("{{{piece}")
                }
            })
            .collect();
    }
    frames
}

/// The answer channel exactly as the endpoint sent it, with no separation done.
fn raw_content_of(entries: &[WireEntry]) -> String {
    let mut out = String::new();
    for frame in frame_datas(entries) {
        let Ok(value) = serde_json::from_str::<Value>(&frame) else {
            continue;
        };
        collect_field(&value, "content", &mut out);
    }
    out
}

fn raw_reasoning_of(entries: &[WireEntry]) -> String {
    let mut out = String::new();
    for frame in frame_datas(entries) {
        let Ok(value) = serde_json::from_str::<Value>(&frame) else {
            continue;
        };
        collect_field(&value, "reasoning_content", &mut out);
    }
    out
}

fn raw_full_reasoning_contains(entries: &[WireEntry], needle: &str) -> bool {
    raw_reasoning_of(entries).contains(needle)
}

fn collect_field(value: &Value, field: &str, out: &mut String) {
    if let Some(choices) = value.get("choices").and_then(Value::as_array) {
        for choice in choices {
            let payload = choice
                .get("delta")
                .or_else(|| choice.get("message"))
                .and_then(Value::as_object);
            if let Some(text) = payload
                .and_then(|payload| payload.get(field))
                .and_then(Value::as_str)
            {
                out.push_str(text);
            }
        }
    }
}

/// What the recorded naive consumer did: `JSON.parse` every frame, stop at the
/// first throw.
fn naive_strict_json_text(frames: &[String]) -> String {
    let mut out = String::new();
    for frame in frames {
        if frame == "[DONE]" {
            break;
        }
        let Ok(value) = serde_json::from_str::<Value>(frame) else {
            break; // the throw
        };
        collect_field(&value, "content", &mut out);
    }
    out
}

// ===========================================================================
// Case 02p — parallel tool calls, both transports (GATE M Part 1, round 2)
// ===========================================================================
//
// Round 1's only defect was FINDING 1: N parallel tool calls collapsing into
// one on the non-streamed path. Round 1 could only script that shape, because
// the live harness answered every tool request with exactly one call, and one
// call cannot collide with itself — the executor said so at the time, and that
// blindness is why the defect survived the builders' own suite.
//
// The harness can now answer a multi-tool request with a BATCH, so this case is
// driven **live, over real TCP, on all four profiles**, and the two transports
// are compared call by call rather than by count.

fn time_tool() -> ToolDefinition {
    ToolDefinition::new(
        "get_time",
        "Current time in a timezone",
        json!({
            "type": "object",
            "properties": {"timezone": {"type": "string"}},
            "required": ["timezone"]
        }),
    )
}

fn quote_tool() -> ToolDefinition {
    ToolDefinition::new(
        "get_quote",
        "Latest quote for a ticker",
        json!({
            "type": "object",
            "properties": {"ticker": {"type": "string"}},
            "required": ["ticker"]
        }),
    )
}

/// Everything the two transports owe each other about one tool call.
///
/// `index` is deliberately **not** in here. It is a field of the streamed wire
/// shape only — the non-streamed shape has none — so requiring it to match
/// would be requiring the two shapes to be the same shape, which is the
/// mistake FINDING 1 was. Identity, name, arguments, executability and the
/// failure reason are what a caller acts on, and those must be identical.
fn call_fingerprint(call: &ToolCallOutcome) -> String {
    match call {
        ToolCallOutcome::Ok {
            call_id,
            name,
            arguments,
            emulated,
        } => format!("OK|id={call_id}|name={name}|emulated={emulated}|args={arguments}"),
        ToolCallOutcome::Malformed {
            call_id,
            name,
            raw_arguments,
            reason,
            index: _,
        } => format!(
            "MALFORMED|id={}|name={}|reason={reason:?}|raw={raw_arguments:?}",
            call_id.as_deref().unwrap_or("MISSING"),
            name.as_deref().unwrap_or("MISSING")
        ),
    }
}

fn fingerprints(calls: &[ToolCallOutcome]) -> Vec<String> {
    calls.iter().map(call_fingerprint).collect()
}

/// The `arguments` text of every call Vela reported, whether it parsed or not.
/// This is the anti-splice probe: every one of these must be a string the
/// endpoint actually sent, not a concatenation of two of them.
fn reported_argument_texts(calls: &[ToolCallOutcome]) -> Vec<String> {
    calls
        .iter()
        .map(|call| match call {
            ToolCallOutcome::Ok { arguments, .. } => arguments.to_string(),
            ToolCallOutcome::Malformed { raw_arguments, .. } => raw_arguments.clone(),
        })
        .collect()
}

/// The `arguments` strings in a non-streamed `message.tool_calls` array, and
/// whether ANY element carried an `index`.
fn whole_shape_of(body: &str) -> Option<(Vec<String>, bool)> {
    let value: Value = serde_json::from_str(body.trim()).ok()?;
    let calls = value
        .get("choices")?
        .as_array()?
        .first()?
        .get("message")?
        .get("tool_calls")?
        .as_array()?;
    let mut arguments = Vec::new();
    let mut any_index = false;
    for call in calls {
        any_index |= call.get("index").is_some();
        arguments.push(
            call.get("function")
                .and_then(|function| function.get("arguments"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        );
    }
    Some((arguments, any_index))
}

/// The `arguments` fragments in the streamed `delta.tool_calls` frames, keyed
/// by the wire index that joins them, and whether every element carried one.
fn fragment_shape_of(frames: &[String]) -> (Vec<String>, bool, usize) {
    let mut joined: BTreeMap<i64, String> = BTreeMap::new();
    let mut elements = 0usize;
    let mut all_indexed = true;
    for frame in frames {
        let Ok(value) = serde_json::from_str::<Value>(frame) else {
            continue;
        };
        let Some(choices) = value.get("choices").and_then(Value::as_array) else {
            continue;
        };
        for choice in choices {
            let Some(calls) = choice
                .get("delta")
                .and_then(|delta| delta.get("tool_calls"))
                .and_then(Value::as_array)
            else {
                continue;
            };
            for call in calls {
                elements += 1;
                let index = match call.get("index").and_then(Value::as_i64) {
                    Some(index) => index,
                    None => {
                        all_indexed = false;
                        -1
                    }
                };
                let fragment = call
                    .get("function")
                    .and_then(|function| function.get("arguments"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                joined.entry(index).or_default().push_str(fragment);
            }
        }
    }
    (joined.into_values().collect(), all_indexed, elements)
}

/// The last recorded response body — the non-streamed JSON document.
fn last_response_body(entries: &[WireEntry]) -> String {
    entries
        .iter()
        .rev()
        .find_map(|entry| match &entry.outcome {
            WireOutcome::Response { body, .. } => {
                Some(String::from_utf8_lossy(&body.lock().expect("poisoned")).into_owned())
            }
            WireOutcome::Failed(_) => None,
        })
        .unwrap_or_default()
}

async fn case_02p(profile: &str, url: &str, ledger: &mut Vec<Verdict>) {
    let log = WireLog::default();
    let provider = provider_for(url, &log);
    let mut doc = Doc::new(
        profile,
        "02p-parallel-tool-calls",
        "parallel tool calls, both transports",
        "GATE M FINDING 1 (round 1): N parallel calls collapsed into one on the non-streamed \
         path. Driven LIVE here, on every profile, and compared call by call — not by count.",
    );

    doc.p("  WHY THIS CASE EXISTS\n  \
         Round 1 could only SCRIPT this shape: the harness answered every tool request with\n  \
         exactly one call, and one call cannot collide with itself. That blindness is why the\n  \
         defect reached a gate. Three tools are offered below, so the endpoint answers with a\n  \
         BATCH — native profiles well-formed, hostile with the middle call broken — and every\n  \
         byte below came off a real socket from the profile's own OS process.\n\n  \
         The two shapes are NOT the same shape, and that is the whole point:\n  \
           streamed      `delta.tool_calls[]`   — FRAGMENTS, joined by `index`\n  \
           non-streamed  `message.tool_calls[]` — WHOLE CALLS, and no `index` exists\n  \
         The assertions below therefore compare identity/name/arguments/reason, and record\n  \
         the `index` difference as the legitimate wire difference it is.");

    let build = || {
        user(
            profile,
            "the weather in Berlin, the time in Berlin, and the ACME quote",
        )
        .with_tools([weather_tool(), time_tool(), quote_tool()])
        .with_tool_choice(ToolChoice::Auto)
    };

    // ---- the non-streamed transport ---------------------------------------
    doc.h("transport A — complete(): one whole body");
    let whole = provider.complete(build(), &context()).await;
    let whole_wire = log.drain();
    doc.wire(&whole_wire);
    let whole_body = last_response_body(&whole_wire);

    // ---- the streamed transport -------------------------------------------
    doc.h("transport B — stream(): the identical request, frame by frame");
    let mut sink = CollectingSink::new();
    let streamed = provider.stream(build(), &mut sink, &context()).await;
    let streamed_wire = log.drain();
    doc.wire(&streamed_wire);
    let streamed_frames = frame_datas(&streamed_wire);

    // ---- what each produced ------------------------------------------------
    doc.h("what Vela produced from each");
    let whole_calls = whole
        .as_ref()
        .map(|response| response.tool_calls.clone())
        .unwrap_or_default();
    let streamed_calls = streamed
        .as_ref()
        .map(|response| response.tool_calls.clone())
        .unwrap_or_default();
    if let Err(error) = &whole {
        doc.kv("non-streamed ERROR", format!("{error:?}"));
    }
    if let Err(error) = &streamed {
        doc.kv("streamed ERROR", format!("{error:?}"));
    }
    doc.kv("non-streamed calls", describe_calls(&whole_calls));
    doc.kv("streamed calls", describe_calls(&streamed_calls));
    doc.kv(
        "non-streamed executable",
        whole
            .as_ref()
            .map_or(0, |r| r.executable_tool_calls().count()),
    );
    doc.kv(
        "streamed executable",
        streamed
            .as_ref()
            .map_or(0, |r| r.executable_tool_calls().count()),
    );
    doc.kv(
        "non-streamed degradations",
        describe_degradations(
            &whole
                .as_ref()
                .map(|r| r.degradations.clone())
                .unwrap_or_default(),
        ),
    );
    doc.kv(
        "streamed degradations",
        describe_degradations(
            &streamed
                .as_ref()
                .map(|r| r.degradations.clone())
                .unwrap_or_default(),
        ),
    );

    // ---- the wire shapes, side by side -------------------------------------
    doc.h("the two wire shapes, as recorded");
    let whole_shape = whole_shape_of(&whole_body);
    let (fragment_joined, all_indexed, fragment_elements) = fragment_shape_of(&streamed_frames);
    match &whole_shape {
        Some((arguments, any_index)) => {
            doc.kv("non-streamed elements", arguments.len());
            doc.kv("any element carried `index`", any_index);
            for (position, argument) in arguments.iter().enumerate() {
                doc.kv(
                    &format!("  element {position} arguments"),
                    format!("{argument:?}"),
                );
            }
        }
        None => doc.kv(
            "non-streamed elements",
            "(no message.tool_calls array in the body — see the transcript above)",
        ),
    }
    doc.kv("streamed tool-call elements", fragment_elements);
    doc.kv("every streamed element carried `index`", all_indexed);
    for (position, argument) in fragment_joined.iter().enumerate() {
        doc.kv(
            &format!("  wire index slot {position} arguments"),
            format!("{argument:?}"),
        );
    }

    // ---- assertions --------------------------------------------------------
    doc.h("assertions");

    // The profile's own expectation. Anything else is a harness change, and a
    // harness change that silently reduced the batch to one would make every
    // assertion below vacuous — so the count is asserted against a literal.
    let expected: usize = match profile {
        // three tools offered, one call per tool
        "frontier" | "mid-local" | "hostile" => 3,
        // no native tools: the emulation path, exercised separately below
        _ => 0,
    };

    if profile == "small-local" {
        doc.p(
            "  small-local has no native tool calling at all, so a batch cannot come from the\n  \
             endpoint. Its parallel case is the EMULATED one, below.",
        );
    } else {
        doc.check(
            "the endpoint really did answer with a BATCH — otherwise nothing below discriminates",
            whole_shape
                .as_ref()
                .is_some_and(|(arguments, _)| arguments.len() == expected),
            format!(
                "expected {expected} elements on the wire, saw {:?}",
                whole_shape.as_ref().map(|(arguments, _)| arguments.len())
            ),
        );
        doc.check(
            "the non-streamed body carries NO `index` on any element (the FINDING 1 shape)",
            whole_shape.as_ref().is_some_and(|(_, any)| !*any),
            format!("any_index={:?}", whole_shape.as_ref().map(|(_, any)| *any)),
        );
        doc.check(
            "the streamed frames DO carry `index` — the two shapes genuinely differ",
            all_indexed && fragment_elements > 0,
            format!("{fragment_elements} element(s), all indexed={all_indexed}"),
        );
        doc.check(
            "non-streamed: every call in the batch is reported, none collapsed",
            whole_calls.len() == expected,
            format!("{} reported, {expected} expected", whole_calls.len()),
        );
        doc.check(
            "streamed: every call in the batch is reported",
            streamed_calls.len() == expected,
            format!("{} reported, {expected} expected", streamed_calls.len()),
        );
        doc.check(
            "THE TWO TRANSPORTS AGREE, call by call — id, name, arguments, reason",
            fingerprints(&whole_calls) == fingerprints(&streamed_calls),
            format!(
                "non-streamed {:#?}\n        streamed     {:#?}",
                fingerprints(&whole_calls),
                fingerprints(&streamed_calls)
            ),
        );
        doc.check(
            "the two transports agree on how many calls are EXECUTABLE",
            whole
                .as_ref()
                .map_or(usize::MAX, |r| r.executable_tool_calls().count())
                == streamed
                    .as_ref()
                    .map_or(usize::MIN, |r| r.executable_tool_calls().count()),
            format!(
                "non-streamed {:?}, streamed {:?}",
                whole.as_ref().map(|r| r.executable_tool_calls().count()),
                streamed.as_ref().map(|r| r.executable_tool_calls().count())
            ),
        );

        // The anti-splice assertion. FINDING 1's signature was an arguments
        // string that never existed on the wire — `{"city":"berlin"}{"city":
        // "paris"}` — shown to the user as evidence. Every arguments text Vela
        // reports must be one the endpoint actually sent.
        let sent: Vec<String> = whole_shape
            .as_ref()
            .map(|(arguments, _)| arguments.clone())
            .unwrap_or_default();
        let reported = reported_argument_texts(&whole_calls);
        let spliced: Vec<&String> = reported
            .iter()
            .filter(|text| {
                // An OK call's arguments are re-serialised from parsed JSON, so
                // compare semantically where they parsed and literally where
                // they did not.
                !sent.iter().any(|wire| {
                    wire == *text
                        || serde_json::from_str::<Value>(wire).ok()
                            == serde_json::from_str::<Value>(text).ok()
                            && serde_json::from_str::<Value>(wire).is_ok()
                })
            })
            .collect();
        doc.check(
            "NO SPLICING — every arguments string reported is one the endpoint sent",
            spliced.is_empty(),
            format!(
                "sent {sent:?}\n        reported {reported:?}\n        not-on-the-wire {spliced:?}"
            ),
        );

        let ids: Vec<String> = whole_calls
            .iter()
            .filter_map(|call| match call {
                ToolCallOutcome::Ok { call_id, .. } => Some(call_id.clone()),
                ToolCallOutcome::Malformed { call_id, .. } => call_id.clone(),
            })
            .collect();
        let mut unique = ids.clone();
        unique.sort();
        unique.dedup();
        doc.check(
            "the correlation ids in the batch are distinct — a result cannot be misrouted",
            unique.len() == ids.len(),
            format!("{ids:?}"),
        );

        let names: Vec<String> = whole_calls
            .iter()
            .filter_map(|call| match call {
                ToolCallOutcome::Ok { name, .. } => Some(name.clone()),
                ToolCallOutcome::Malformed { name, .. } => name.clone(),
            })
            .collect();
        doc.check(
            "each offered tool appears in the batch — no call was replaced by its neighbour",
            ["get_weather", "get_time", "get_quote"]
                .iter()
                .all(|tool| names.iter().any(|name| name == tool)),
            format!("{names:?}"),
        );

        if profile == "hostile" {
            // The partially-malformed batch: the harness breaks the MIDDLE call
            // and leaves the outer two well-formed. That is what makes a lost
            // call visible — a merge produces one malformed call and the two
            // good ones have visibly vanished.
            doc.check(
                "partially broken batch: the two good calls survive and are executable",
                whole
                    .as_ref()
                    .is_ok_and(|r| r.executable_tool_calls().count() == 2),
                describe_calls(&whole_calls),
            );
            doc.check(
                "partially broken batch: the broken call is reported, not dropped or repaired",
                whole_calls
                    .iter()
                    .filter(|call| matches!(call, ToolCallOutcome::Malformed { .. }))
                    .count()
                    == 1,
                describe_calls(&whole_calls),
            );
            doc.check(
                "the malformed call is declared as a degradation on BOTH transports",
                [&whole, &streamed].iter().all(|outcome| {
                    outcome.as_ref().is_ok_and(|r| {
                        r.degradations
                            .iter()
                            .any(|d| matches!(d, Degradation::MalformedToolCalls { count: 1 }))
                    })
                }),
                format!(
                    "non-streamed {:?}, streamed {:?}",
                    whole.as_ref().map(|r| r.degradations.clone()),
                    streamed.as_ref().map(|r| r.degradations.clone())
                ),
            );
        } else {
            doc.check(
                "a well-formed batch is fully executable on both transports",
                whole
                    .as_ref()
                    .is_ok_and(|r| r.executable_tool_calls().count() == expected)
                    && streamed
                        .as_ref()
                        .is_ok_and(|r| r.executable_tool_calls().count() == expected),
                format!(
                    "non-streamed {:?}, streamed {:?}",
                    whole.as_ref().map(|r| r.executable_tool_calls().count()),
                    streamed.as_ref().map(|r| r.executable_tool_calls().count())
                ),
            );
            doc.check(
                "a well-formed batch raises no malformed-tool-call degradation",
                whole.as_ref().is_ok_and(|r| {
                    !r.degradations
                        .iter()
                        .any(|d| matches!(d, Degradation::MalformedToolCalls { .. }))
                }),
                describe_degradations(
                    &whole
                        .as_ref()
                        .map(|r| r.degradations.clone())
                        .unwrap_or_default(),
                ),
            );
        }
    }

    // ---- the emulated batch, on the endpoint that has no tools -------------
    if profile == "small-local" {
        doc.h("the EMULATED parallel batch, end to end, both transports");
        doc.p(
            "  Two calls in one answer, in the shape a small model writes them (unquoted keys),\n  \
             echoed back by the endpoint. This proves the request rewriting, the round trip and\n  \
             the multi-call parser — NOT that any model would choose to emit two calls.",
        );
        // Short names, no internal spaces, and both blocks inside 120
        // characters — because this profile's mock echoes back only the first
        // eight whitespace-delimited words of the prompt, hard-capped at 120
        // characters (`reply-plan.ts::firstWords`). The ordinary spelling of
        // this prompt is cut off mid-way through the SECOND call, which is a
        // limit of the harness and is recorded as one below rather than being
        // written up as a Vela defect.
        let emulated_prompt =
            "<tool_call>{name:wx,arguments:{c:b}}</tool_call> <tool_call>{name:tz,arguments:{t:c}}</tool_call>";
        let short_tools = [
            ToolDefinition::new(
                "wx",
                "Weather",
                json!({"type": "object",
                "properties": {"c": {"type": "string"}}}),
            ),
            ToolDefinition::new(
                "tz",
                "Time",
                json!({"type": "object",
                "properties": {"t": {"type": "string"}}}),
            ),
        ];
        let build_emulated = || {
            user(profile, emulated_prompt)
                .with_tools(short_tools.clone())
                .with_tool_choice(ToolChoice::Auto)
        };
        let whole_emulated = provider.complete(build_emulated(), &context()).await;
        doc.wire(&log.drain());
        let mut sink = CollectingSink::new();
        let streamed_emulated = provider
            .stream(build_emulated(), &mut sink, &context())
            .await;
        doc.wire(&log.drain());

        let whole_emulated_calls = whole_emulated
            .as_ref()
            .map(|r| r.tool_calls.clone())
            .unwrap_or_default();
        let streamed_emulated_calls = streamed_emulated
            .as_ref()
            .map(|r| r.tool_calls.clone())
            .unwrap_or_default();
        doc.kv(
            "non-streamed emulated calls",
            describe_calls(&whole_emulated_calls),
        );
        doc.kv(
            "streamed emulated calls",
            describe_calls(&streamed_emulated_calls),
        );
        doc.kv(
            "answer shown to the user (non-streamed)",
            format!(
                "{:?}",
                whole_emulated
                    .as_ref()
                    .map(|r| elide(&r.answer_text(), 160))
            ),
        );

        doc.check(
            "emulation recovers BOTH calls, not one — non-streamed",
            whole_emulated
                .as_ref()
                .is_ok_and(|r| r.executable_tool_calls().count() == 2),
            describe_calls(&whole_emulated_calls),
        );
        doc.check(
            "emulation recovers BOTH calls, not one — streamed",
            streamed_emulated
                .as_ref()
                .is_ok_and(|r| r.executable_tool_calls().count() == 2),
            describe_calls(&streamed_emulated_calls),
        );
        doc.check(
            "THE TWO TRANSPORTS AGREE on the emulated batch, call by call",
            fingerprints(&whole_emulated_calls) == fingerprints(&streamed_emulated_calls),
            format!(
                "non-streamed {:#?}\n        streamed     {:#?}",
                fingerprints(&whole_emulated_calls),
                fingerprints(&streamed_emulated_calls)
            ),
        );
        doc.check(
            "both emulated calls keep their OWN arguments — no splice across calls",
            whole_emulated_calls.iter().any(|call| {
                matches!(call,
                ToolCallOutcome::Ok { name, arguments, emulated, .. }
                    if name == "wx" && arguments["c"] == "b" && *emulated)
            }) && whole_emulated_calls.iter().any(|call| {
                matches!(call,
                ToolCallOutcome::Ok { name, arguments, emulated, .. }
                    if name == "tz" && arguments["t"] == "c" && *emulated)
            }),
            describe_calls(&whole_emulated_calls),
        );
        doc.check(
            "call markup never reaches the user-visible answer on either transport",
            whole_emulated
                .as_ref()
                .is_ok_and(|r| !r.answer_text().contains("tool_call"))
                && streamed_emulated
                    .as_ref()
                    .is_ok_and(|r| !r.answer_text().contains("tool_call")),
            format!(
                "{:?} / {:?}",
                whole_emulated.as_ref().map(|r| elide(&r.answer_text(), 80)),
                streamed_emulated
                    .as_ref()
                    .map(|r| elide(&r.answer_text(), 80))
            ),
        );
        doc.check(
            "the emulated batch ends in ToolUse and declares its emulation, both transports",
            [&whole_emulated, &streamed_emulated].iter().all(|outcome| {
                outcome.as_ref().is_ok_and(|r| {
                    r.stop_reason == StopReason::ToolUse
                        && r.degradations
                            .iter()
                            .any(|d| matches!(d, Degradation::ToolCallingEmulated { .. }))
                })
            }),
            format!(
                "{:?} / {:?}",
                whole_emulated
                    .as_ref()
                    .map(|r| (r.stop_reason, r.degradations.clone())),
                streamed_emulated
                    .as_ref()
                    .map(|r| (r.stop_reason, r.degradations.clone()))
            ),
        );
    }

    doc.write(ledger);
}

// ===========================================================================
// Case 07c — stream termination, measured five times (round 2)
// ===========================================================================
//
// Case 07 asserts the turn finishes far inside the 5003 ms hang the Phase A
// gate recorded. Round 2 is asked for something sharper: single-digit
// milliseconds on all four profiles. A single sample of a 3 ms number on a
// shared container is noise, so five are taken and the MEDIAN is asserted —
// with every sample printed, so a reader can see the spread rather than trust
// the summary.

async fn case_07c(profile: &str, url: &str, ledger: &mut Vec<Verdict>) {
    let log = WireLog::default();
    let provider = provider_for(url, &log);
    let mut doc = Doc::new(
        profile,
        "07c-termination-latency",
        "stream termination latency, five samples",
        "MEASURED-1 sharpened: the turn must end in single-digit milliseconds, not merely \
         inside the 5 s a naive [DONE]-driven consumer hung for.",
    );

    doc.p(
        "  Five identical streamed turns. The endpoint is the same OS process throughout, so\n  \
         the spread below is this container's scheduling noise and nothing else. `hostile`\n  \
         never sends [DONE] and `small-local` never sends usage though it accepted\n  \
         `include_usage`: both are the shapes that hung the recorded consumers for 5 s.",
    );

    let mut samples: Vec<Duration> = Vec::new();
    let mut answers: Vec<usize> = Vec::new();
    let mut failed: Option<String> = None;
    for _ in 0..5 {
        let mut sink = CollectingSink::new();
        let started = Instant::now();
        let outcome = tokio::time::timeout(
            Duration::from_secs(20),
            provider.stream(
                user(profile, "what is the weather in Berlin").with_max_output_tokens(256),
                &mut sink,
                &context(),
            ),
        )
        .await;
        let elapsed = started.elapsed();
        let _ = log.drain();
        match outcome {
            Ok(Ok(response)) => {
                samples.push(elapsed);
                answers.push(response.answer_text().chars().count());
            }
            Ok(Err(error)) => {
                failed = Some(format!("{error:?}"));
                break;
            }
            Err(_) => {
                failed = Some("HUNG: 20 s outer deadline".into());
                break;
            }
        }
    }

    doc.h("the samples");
    for (run, sample) in samples.iter().enumerate() {
        doc.kv(
            &format!("run {}", run + 1),
            format!("{sample:?}   ({} answer characters)", answers[run]),
        );
    }
    let mut sorted = samples.clone();
    sorted.sort();
    let median = sorted
        .get(sorted.len() / 2)
        .copied()
        .unwrap_or(Duration::MAX);
    let worst = sorted.last().copied().unwrap_or(Duration::MAX);
    doc.kv("MEDIAN", format!("{median:?}"));
    doc.kv("worst sample", format!("{worst:?}"));
    doc.kv("recorded naive [DONE] consumer", "5003 ms (TIMED OUT)");

    doc.h("assertions");
    doc.check(
        "every sampled turn completed without error",
        failed.is_none() && samples.len() == 5,
        failed
            .clone()
            .unwrap_or_else(|| format!("{} samples", samples.len())),
    );
    doc.check(
        "TERMINATION IS SINGLE-DIGIT MILLISECONDS — median under 10 ms",
        median < Duration::from_millis(10),
        format!("median {median:?}, samples {samples:?}"),
    );
    doc.check(
        "no sample came anywhere near the recorded 5003 ms hang",
        worst < Duration::from_millis(500),
        format!("worst {worst:?}"),
    );
    doc.check(
        "every sample returned the same answer length — timing did not truncate anything",
        answers.windows(2).all(|pair| pair[0] == pair[1])
            && answers.first().is_some_and(|n| *n > 0),
        format!("{answers:?}"),
    );

    doc.write(ledger);
}

// ===========================================================================
// Case 11 — the credential canary (round 2)
// ===========================================================================
//
// Phase B's security review found `Auth::ApiKeyQuery` putting a live API key
// into `ProviderError`: `reqwest`'s `Display` appends " for url (…)" with the
// query string, `detail()` sanitises but does not redact, and the result went
// into the error's `Display`, its `Debug` and its serde JSON — the last being
// the shape that crosses the IPC bridge into the low-trust WebView. Round 2
// claims to have closed it. This case does not take that on trust: it
// configures a distinctive canary, forces the real failure paths, and greps
// every rendering of everything that comes back.

/// The needle. Chosen to contain characters that percent-encoding changes
/// (`+`, `/`), so a leak that goes through URL encoding is still caught, and a
/// stable core that survives encoding, truncation at either end, and case
/// folding.
const CANARY: &str = "vela+gate/m1-7Q2Xz9f3a-DO-NOT-LEAK";
const CANARY_CORE: &str = "7Q2Xz9f3a";

fn canary_needles() -> Vec<String> {
    vec![
        CANARY.to_owned(),
        // What `RequestUrl::with_query_credential` writes on the wire.
        CANARY
            .replace('+', "%2B")
            .replace('/', "%2F")
            .replace('=', "%3D"),
        CANARY_CORE.to_owned(),
        CANARY_CORE.to_lowercase(),
        // A leak truncated by `detail()`'s length cap still shows this much.
        "7Q2Xz".to_owned(),
    ]
}

/// Every rendering of a `ProviderError` a caller, a log or the IPC bridge can
/// produce. If the credential is in ANY of them, the gate fails.
fn renderings_of(error: &ProviderError) -> Vec<(&'static str, String)> {
    vec![
        ("Display", error.to_string()),
        ("Debug", format!("{error:?}")),
        ("Debug (alternate)", format!("{error:#?}")),
        (
            "serde_json (THE IPC WIRE SHAPE)",
            serde_json::to_string(error).unwrap_or_else(|e| format!("<unserialisable: {e}>")),
        ),
        (
            "serde_json (pretty)",
            serde_json::to_string_pretty(error).unwrap_or_default(),
        ),
    ]
}

/// EVERY rendering the needle appears in — not the first.
///
/// Returning only the first is how an earlier draft of this case reported the
/// serde assertion PASSing while the serde JSON in the very same transcript
/// carried the credential: `Display` matched first and nothing looked further.
fn canary_in(renderings: &[(&'static str, String)]) -> Vec<(&'static str, String, String)> {
    let mut found = Vec::new();
    for (label, text) in renderings {
        if let Some(needle) = canary_needles()
            .into_iter()
            .find(|needle| text.contains(needle))
        {
            found.push((*label, needle, text.clone()));
        }
    }
    found
}

fn canary_in_text(text: &str) -> Option<String> {
    canary_needles()
        .into_iter()
        .find(|needle| text.contains(needle))
}

/// A raw TCP peer that misbehaves in a specific way. Not an HTTP server: the
/// point is to produce transport failures a well-behaved server cannot.
#[derive(Clone, Copy)]
enum Misbehaviour {
    /// Accepts the connection and never writes a byte: forces a first-byte
    /// timeout.
    Silent,
    /// Answers with headers and a partial body, then drops the connection with
    /// far less written than the declared `content-length` — a message that
    /// ends mid-body, which is what a killed peer looks like to the client.
    ResetMidBody,
    /// Echoes the request target — the full path INCLUDING the query string —
    /// back inside a 400 error body, the way a proxy or a strict gateway does.
    /// This is the leak path that has nothing to do with `reqwest`: the
    /// credential comes back from the endpoint in an error body.
    EchoesTheUrlBack,
    /// The same echo, but delivered as an `{"error": {...}}` object inside an
    /// otherwise-200 SSE stream — the shape llama.cpp and vLLM use to report a
    /// failure that only became apparent after the headers went out. A
    /// different code path from the one above: `stream.rs::error_from_body`,
    /// reading frames through `next_chunk` rather than `read_to_end`.
    EchoesTheUrlInAStreamFrame,
}

struct RawPeer {
    url: String,
    task: tokio::task::JoinHandle<()>,
    /// **Every byte this peer wrote to the socket**, upstream of Vela entirely.
    ///
    /// This is where the *premise* of an echo case is established, and it moved
    /// here in round 3 for a reason worth writing down. It used to be read off
    /// the recorder's `Tee`, which sat inside the response body — and round 3's
    /// fix makes `BodyStream::next_chunk` scrub before any decorator can see the
    /// bytes, so the tee stopped being able to observe the endpoint's echo at
    /// all and the premise check went red against a tree that was in fact
    /// clean. A false positive from the instrumentation, not a finding.
    ///
    /// The peer's own send buffer cannot be affected by anything Vela does, so
    /// it is the honest place to ask "did the endpoint really echo the key?".
    sent: Arc<Mutex<Vec<u8>>>,
}

impl RawPeer {
    async fn start(mode: Misbehaviour) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("loopback bind");
        let address = listener.local_addr().expect("bound");
        let sent: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let sent_by_task = Arc::clone(&sent);
        let task = tokio::spawn(async move {
            let record = |bytes: &[u8]| {
                sent_by_task
                    .lock()
                    .expect("peer send log poisoned")
                    .extend_from_slice(bytes)
            };
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                match mode {
                    Misbehaviour::Silent => {
                        // Hold it open, say nothing. The client's first-byte
                        // deadline is what ends this.
                        tokio::time::sleep(Duration::from_secs(60)).await;
                    }
                    Misbehaviour::ResetMidBody => {
                        let mut scratch = [0u8; 8192];
                        let _ = socket.read(&mut scratch).await;
                        let payload: &[u8] = b"HTTP/1.1 200 OK\r\n\
                                  content-type: text/event-stream\r\n\
                                  content-length: 65536\r\n\r\n\
                                  data: {\"choices\":[{\"delta\":{\"content\":\"partial \"}}]}\n\n";
                        record(payload);
                        let _ = socket.write_all(payload).await;
                        let _ = socket.flush().await;
                        tokio::time::sleep(Duration::from_millis(40)).await;
                        // The declared content-length is 64 KiB and far less
                        // than that was written, so closing here is a body that
                        // ends mid-message — what a killed peer looks like to
                        // the client.
                        drop(socket);
                    }
                    Misbehaviour::EchoesTheUrlInAStreamFrame => {
                        let mut scratch = vec![0u8; 16384];
                        let read = socket.read(&mut scratch).await.unwrap_or(0);
                        let text = String::from_utf8_lossy(&scratch[..read]).into_owned();
                        let target = text
                            .lines()
                            .next()
                            .and_then(|line| line.split_whitespace().nth(1))
                            .unwrap_or("/")
                            .to_owned();
                        let frame = format!(
                            "data: {}\n\ndata: [DONE]\n\n",
                            serde_json::to_string(&json!({
                                "error": {
                                    "message": format!("upstream request failed: POST {target}"),
                                    "code": "server_error",
                                }
                            }))
                            .expect("encodes")
                        );
                        let payload = format!(
                            "HTTP/1.1 200 OK\r\n\
                             content-type: text/event-stream\r\n\
                             content-length: {}\r\n\r\n{frame}",
                            frame.len()
                        );
                        record(payload.as_bytes());
                        let _ = socket.write_all(payload.as_bytes()).await;
                        let _ = socket.flush().await;
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                    Misbehaviour::EchoesTheUrlBack => {
                        let mut scratch = vec![0u8; 16384];
                        let read = socket.read(&mut scratch).await.unwrap_or(0);
                        let text = String::from_utf8_lossy(&scratch[..read]).into_owned();
                        let target = text
                            .lines()
                            .next()
                            .and_then(|line| line.split_whitespace().nth(1))
                            .unwrap_or("/")
                            .to_owned();
                        let body = serde_json::to_string(&json!({
                            "error": {
                                "message": format!("no route for {target}"),
                                "type": "invalid_request_error",
                            }
                        }))
                        .expect("encodes");
                        let payload = format!(
                            "HTTP/1.1 400 Bad Request\r\n\
                             content-type: application/json\r\n\
                             content-length: {}\r\n\r\n{body}",
                            body.len()
                        );
                        record(payload.as_bytes());
                        let _ = socket.write_all(payload.as_bytes()).await;
                        let _ = socket.flush().await;
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                }
            }
        });
        Self {
            url: format!("http://{address}"),
            task,
            sent,
        }
    }

    fn https_url(&self) -> String {
        self.url.replacen("http://", "https://", 1)
    }

    /// What this peer put on the wire, as text. Not what Vela read.
    fn sent_text(&self) -> String {
        String::from_utf8_lossy(&self.sent.lock().expect("peer send log poisoned")).into_owned()
    }

    fn stop(self) {
        self.task.abort();
    }
}

/// A port nothing is listening on: bound, then released.
async fn refused_port_url() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("loopback bind");
    let address = listener.local_addr().expect("bound");
    drop(listener);
    format!("http://{address}")
}

fn keyed_provider(base_url: &str, log: &WireLog) -> OpenAiCompatibleProvider {
    let store = Arc::new(MemoryStore::new());
    let secret = SecretRef::primary("canary").expect("valid");
    store
        .set(&secret, &SecretValue::new(CANARY))
        .expect("stored in the fake");
    OpenAiCompatibleProvider::new(
        ProviderDescriptor::new("canary", "Credential canary", ProviderKind::Local)
            .expect("static id is valid"),
        format!("{base_url}/v1"),
        // The binding that puts the credential INSIDE the URL — the one shape
        // a header-only redaction is blind to by construction.
        Auth::ApiKeyQuery {
            param: "key".into(),
            secret,
        },
        store,
        Arc::new(RecordingTransport::new(log.clone())),
    )
}

async fn case_11(profile: &str, ledger: &mut Vec<Verdict>) {
    let mut doc = Doc::new(
        profile,
        "11-credential-leak",
        "credential leak — Auth::ApiKeyQuery through the real failure paths",
        "A credential in the query string must not reach ANY rendering of ANY error: not \
         Display, not Debug, not the serde JSON that crosses the IPC bridge, not the wire log.",
    );

    doc.p(format!(
        "  THE NEEDLE   {CANARY}\n  \
         This is the ONLY line in this directory where that string is permitted to appear.\n  \
         The recorder asserts that at the end of the run, across every file it writes, so a\n  \
         transcript that leaked it would fail the gate rather than sit here unnoticed.\n\n  \
         The binding is `Auth::ApiKeyQuery {{ param: \"key\" }}`, so the credential is IN THE\n  \
         URL. Timeouts are cut to 400 ms first-byte / 300 ms connect so the failures below\n  \
         happen quickly; nothing else about the stack is changed."
    ));

    let short = RequestContext::new().with_timeouts(Timeouts {
        connect: Duration::from_millis(300),
        first_byte: Duration::from_millis(400),
        stall: Duration::from_millis(400),
    });

    // Every failure this case forces, as (label, how it is produced).
    let refused = refused_port_url().await;
    let silent = RawPeer::start(Misbehaviour::Silent).await;
    let reset = RawPeer::start(Misbehaviour::ResetMidBody).await;
    let echo = RawPeer::start(Misbehaviour::EchoesTheUrlBack).await;
    let stream_echo = RawPeer::start(Misbehaviour::EchoesTheUrlInAStreamFrame).await;
    let stream_echo_bare = RawPeer::start(Misbehaviour::EchoesTheUrlInAStreamFrame).await;
    // TLS to a plain-text peer: the handshake cannot complete.
    let tls_url = silent.https_url();

    struct Forced {
        label: &'static str,
        why: &'static str,
        url: String,
        streamed: bool,
    }

    let forced = vec![
        Forced {
            label: "connection refused",
            why: "a loopback port that was bound and then released — nothing is listening",
            url: refused.clone(),
            streamed: false,
        },
        Forced {
            label: "connection refused (streamed)",
            why: "the same, through stream() rather than complete()",
            url: refused.clone(),
            streamed: true,
        },
        Forced {
            label: "first-byte timeout",
            why: "a peer that accepts the connection and never writes a byte",
            url: silent.url.clone(),
            streamed: false,
        },
        Forced {
            label: "TLS handshake failure",
            why: "https:// to a peer speaking no TLS at all",
            url: tls_url.clone(),
            streamed: false,
        },
        Forced {
            label: "mid-stream reset",
            why: "headers, a partial SSE body, then RST via SO_LINGER 0",
            url: reset.url.clone(),
            streamed: true,
        },
        Forced {
            label: "mid-stream reset (non-streamed)",
            why: "the same peer, read through complete()",
            url: reset.url.clone(),
            streamed: false,
        },
        Forced {
            label: "the endpoint echoes the URL back (error body)",
            why: "a 400 whose error body quotes the request target, query string included — \
                  the leak path that has nothing to do with reqwest",
            url: echo.url.clone(),
            streamed: false,
        },
        Forced {
            label: "the endpoint echoes the URL back (200 + error frame)",
            why: "a 200 SSE stream whose only frame is an {error:{message}} quoting the \
                  request target — read through next_chunk, not read_to_end",
            url: stream_echo.url.clone(),
            streamed: true,
        },
        Forced {
            label: "the endpoint echoes the URL back (error frame, non-streamed)",
            why: "the same peer read through complete()",
            url: stream_echo.url.clone(),
            streamed: false,
        },
    ];

    // One bucket per surface, because a single `Vec<String>` searched with
    // `contains("serde")` is how a leak hides behind another leak.
    let mut rendering_leaks: Vec<String> = Vec::new();
    let mut serde_leaks: Vec<String> = Vec::new();
    let mut sink_leaks: Vec<String> = Vec::new();
    let mut transport_detail_leaks: Vec<String> = Vec::new();
    let mut real_failures = 0usize;
    // The bytes the recorder's `Tee` saw — which, since round 3, are the bytes
    // *after* `BodyStream::next_chunk` and therefore exactly the bytes Vela's
    // SSE parser consumes. A canary here would be a leak into Vela's internals;
    // a `<redacted>` here is byte-level proof that the streamed path scrubbed.
    let mut body_vela_read: Vec<(&'static str, String)> = Vec::new();

    for case in &forced {
        doc.h(&format!("forced failure — {}", case.label));
        doc.p(format!("  {}", case.why));
        let log = WireLog::default();
        let provider = keyed_provider(&case.url, &log);
        let started = Instant::now();
        let outcome = if case.streamed {
            let mut sink = CollectingSink::new();
            let result = provider
                .stream(user(profile, "hello"), &mut sink, &short)
                .await;
            // The sink is a rendering surface too: a partial answer, an error
            // event, anything the UI would have been handed.
            let rendered = format!("{:?}", sink.events);
            if let Some(needle) = canary_in_text(&rendered) {
                sink_leaks.push(format!("{}: event sink contains {needle:?}", case.label));
            }
            result.map(|_| ())
        } else {
            provider
                .complete(user(profile, "hello"), &short)
                .await
                .map(|_| ())
        };
        let elapsed = started.elapsed();
        let entries = log.drain();

        // Two different things live in the wire log and they must not be
        // conflated. `Failed(detail)` is VELA's text — the transport's own
        // normalised failure string, and a leak there is a leak. A response
        // body is the ENDPOINT's bytes as they came off the socket, upstream of
        // every redaction Vela performs, so the credential appearing there is
        // the premise of the test rather than its failure.
        let vela_text = entries
            .iter()
            .filter_map(|entry| match &entry.outcome {
                WireOutcome::Failed(detail) => Some(format!("{} {detail}", entry.url)),
                WireOutcome::Response { .. } => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        if let Some(needle) = canary_in_text(&vela_text) {
            transport_detail_leaks.push(format!(
                "{}: the transport's own failure detail contains {needle:?}",
                case.label
            ));
        }
        let read_text = entries
            .iter()
            .filter_map(|entry| match &entry.outcome {
                WireOutcome::Response { body, .. } => {
                    Some(String::from_utf8_lossy(&body.lock().expect("poisoned")).into_owned())
                }
                WireOutcome::Failed(_) => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        body_vela_read.push((case.label, read_text));

        match &outcome {
            Ok(()) => {
                doc.kv("outcome", "NO ERROR — this failure did not actually happen");
                doc.kv("wall clock", format!("{elapsed:?}"));
            }
            Err(error) => {
                real_failures += 1;
                let renderings = renderings_of(error);
                doc.kv("wall clock", format!("{elapsed:?}"));
                doc.kv("variant", error.code());
                for (label, text) in &renderings {
                    doc.kv(label, format!("{:?}", elide(text, 400)));
                }
                doc.kv(
                    "URL as the recorder prints it",
                    entries
                        .first()
                        .map(|entry| entry.url.to_string())
                        .unwrap_or_else(|| "(no exchange recorded)".into()),
                );
                for (label, needle, text) in canary_in(&renderings) {
                    rendering_leaks.push(format!(
                        "{}: the `{label}` rendering contains {needle:?} — {}",
                        case.label,
                        elide(&text, 300)
                    ));
                    if label.starts_with("serde_json") {
                        serde_leaks.push(format!("{}: {label}", case.label));
                    }
                }
            }
        }
    }

    // Read off the peers themselves BEFORE they are stopped: this is the
    // premise of the echo cases, taken upstream of every byte Vela touches.
    let echo_sent = echo.sent_text();
    let stream_echo_sent = stream_echo.sent_text();

    silent.stop();
    reset.stop();
    echo.stop();
    stream_echo.stop();

    // The IPC boundary. `ProviderError` is the shape that would cross it; today
    // nothing carries it across, and that is worth recording rather than
    // assuming, because the day a `provider_*` command lands, this serde JSON
    // becomes WebView-visible.
    // Every case above ran through `RecordingTransport`, which decorates the
    // real one. A decorator is exactly the sort of thing that can invent or
    // hide a leak — an earlier draft of this recorder did precisely that, by
    // not forwarding `ByteStream::scrubber()`. So the streamed echo is repeated
    // here on a BARE `ReqwestTransport`, nothing wrapping it, nothing teeing.
    doc.h("the same streamed echo on a BARE ReqwestTransport (no recorder in the path)");
    {
        let store = Arc::new(MemoryStore::new());
        let secret = SecretRef::primary("canary").expect("valid");
        store
            .set(&secret, &SecretValue::new(CANARY))
            .expect("stored in the fake");
        let bare = OpenAiCompatibleProvider::new(
            ProviderDescriptor::new("canary", "Credential canary", ProviderKind::Local)
                .expect("static id is valid"),
            format!("{}/v1", stream_echo_bare.url),
            Auth::ApiKeyQuery {
                param: "key".into(),
                secret,
            },
            store,
            Arc::new(ReqwestTransport::new().expect("http client builds")),
        );
        let mut sink = CollectingSink::new();
        let outcome = bare.stream(user(profile, "hello"), &mut sink, &short).await;
        match &outcome {
            Ok(_) => doc.kv("outcome", "NO ERROR — the probe did not fire"),
            Err(error) => {
                for (label, text) in renderings_of(error) {
                    doc.kv(&format!("bare {label}"), format!("{:?}", elide(&text, 300)));
                }
            }
        }
        let bare_leaks = outcome
            .as_ref()
            .err()
            .map(|error| canary_in(&renderings_of(error)))
            .unwrap_or_default();
        doc.check(
            "NO CREDENTIAL in an error produced with no recorder anywhere in the path",
            bare_leaks.is_empty() && outcome.is_err(),
            if outcome.is_err() {
                format!(
                    "{} leaking rendering(s): {:?}",
                    bare_leaks.len(),
                    bare_leaks
                        .iter()
                        .map(|(label, _, _)| *label)
                        .collect::<Vec<_>>()
                )
            } else {
                "the probe did not produce an error at all".to_owned()
            },
        );
    }
    let bare_sent = stream_echo_bare.sent_text();
    stream_echo_bare.stop();

    doc.h("what the ENDPOINT sent back (the premise, not the verdict)");
    doc.p(
        "  Taken from each peer's OWN send buffer, not from anything inside Vela. Round 2\n  \
         read this off the recorder's body tee; round 3 scrubs before any decorator can\n  \
         see a byte, so the tee stopped being able to observe the endpoint's echo and the\n  \
         premise check went red against a clean tree. That was the instrumentation, not a\n  \
         finding, and the fix is to ask the peer.",
    );
    let echoing_peers: Vec<(&str, &String)> = [
        ("400 error body", &echo_sent),
        ("200 + error frame", &stream_echo_sent),
        ("200 + error frame (bare transport)", &bare_sent),
    ]
    .into_iter()
    .filter(|(_, sent)| canary_in_text(sent).is_some())
    .collect();
    for (label, sent) in &[
        ("400 error body", &echo_sent),
        ("200 + error frame", &stream_echo_sent),
        ("200 + error frame (bare transport)", &bare_sent),
    ] {
        doc.kv(
            &format!("peer `{label}` put the credential on the wire"),
            canary_in_text(sent).is_some(),
        );
        doc.kv(
            &format!("  bytes peer `{label}` wrote"),
            format!("{} bytes", sent.len()),
        );
    }
    doc.check(
        "at least one peer really did echo the credential back — the echo cases are real",
        !echoing_peers.is_empty(),
        format!(
            "{:?}",
            echoing_peers.iter().map(|(l, _)| *l).collect::<Vec<_>>()
        ),
    );
    doc.check(
        "ALL THREE echo peers echoed it — no echo case is vacuous",
        echoing_peers.len() == 3,
        format!("{} of 3 peers echoed the credential", echoing_peers.len()),
    );

    doc.h("what VELA read (the same bytes, one layer further in)");
    doc.p(
        "  The recorder's `Tee` now sits OUTSIDE `BodyStream`, so what it records is what\n  \
         the SSE parser consumes. The credential must be gone by here, and the redaction\n  \
         marker must be present — a body that arrived empty would be clean vacuously.",
    );
    let echo_bodies: Vec<&(&'static str, String)> = body_vela_read
        .iter()
        .filter(|(label, _)| label.starts_with("the endpoint echoes"))
        .collect();
    for (label, text) in &echo_bodies {
        doc.kv(
            &format!("`{label}` as the parser saw it"),
            format!("{:?}", elide(text, 200)),
        );
    }
    doc.check(
        "the credential is ALREADY GONE from the bytes Vela's parser reads",
        echo_bodies
            .iter()
            .all(|(_, text)| canary_in_text(text).is_none()),
        format!("{} echo body/bodies checked", echo_bodies.len()),
    );
    doc.check(
        "and the redaction marker IS there — the body was not merely empty",
        !echo_bodies.is_empty()
            && echo_bodies
                .iter()
                .all(|(_, text)| text.contains("<redacted>")),
        format!(
            "{} of {} echo bodies carry `<redacted>`",
            echo_bodies
                .iter()
                .filter(|(_, text)| text.contains("<redacted>"))
                .count(),
            echo_bodies.len()
        ),
    );

    doc.h("the IPC boundary");
    let allowlist =
        std::fs::read_to_string(repo_root().join("src-tauri/src/ipc/mod.rs")).unwrap_or_default();
    let contract =
        std::fs::read_to_string(repo_root().join("src/platform/contract.ts")).unwrap_or_default();
    let provider_command_in_rust = allowlist.contains("\"provider_");
    let provider_command_in_ts = contract.contains("provider_");
    doc.kv(
        "a provider_* command on the Rust allowlist",
        provider_command_in_rust,
    );
    doc.kv(
        "a provider_* command in contract.ts",
        provider_command_in_ts,
    );
    doc.p(
        "  No command carries a ProviderError across the bridge yet, so today the leak surface\n  \
         is latent rather than live. Its serde rendering is asserted clean regardless — that is\n  \
         the shape a future `provider_stream` command would serialise.",
    );

    doc.h("assertions");
    doc.check(
        "the forced failures ARE failures — otherwise every assertion below is vacuous",
        real_failures == forced.len(),
        format!("{real_failures} of {} produced an error", forced.len()),
    );
    doc.check(
        "NO CREDENTIAL in any Display, Debug or serde rendering of any error",
        rendering_leaks.is_empty(),
        if rendering_leaks.is_empty() {
            format!("{real_failures} error(s) rendered 5 ways each, all clean")
        } else {
            format!(
                "{} leaking rendering(s):\n        {}",
                rendering_leaks.len(),
                rendering_leaks.join("\n        ")
            )
        },
    );
    doc.check(
        "NO CREDENTIAL in the serde JSON specifically — the IPC wire shape",
        serde_leaks.is_empty(),
        if serde_leaks.is_empty() {
            format!("{} serialisation(s) checked", real_failures * 2)
        } else {
            serde_leaks.join("\n        ")
        },
    );
    doc.check(
        "NO CREDENTIAL in the transport's own normalised failure detail",
        transport_detail_leaks.is_empty(),
        if transport_detail_leaks.is_empty() {
            format!("{} exchange log(s) checked", forced.len())
        } else {
            transport_detail_leaks.join("\n        ")
        },
    );
    doc.check(
        "NO CREDENTIAL in the streamed event sink the UI is handed",
        sink_leaks.is_empty(),
        if sink_leaks.is_empty() {
            "checked on every streamed case".to_owned()
        } else {
            sink_leaks.join("\n        ")
        },
    );
    doc.check(
        "the URL the recorder prints is the redacted form",
        !format!(
            "{}",
            RequestUrl::new("http://127.0.0.1/v1")
                .with_query_credential("key", &SecretValue::new(CANARY))
        )
        .contains(CANARY_CORE),
        format!(
            "{}",
            RequestUrl::new("http://127.0.0.1/v1")
                .with_query_credential("key", &SecretValue::new(CANARY))
        ),
    );
    doc.check(
        "no ProviderError crosses the IPC bridge today (recorded, not assumed)",
        !provider_command_in_rust && !provider_command_in_ts,
        format!("rust={provider_command_in_rust}, ts={provider_command_in_ts}"),
    );

    doc.write(ledger);
}

// ===========================================================================
// Assertion controls — prove a FAIL is reachable
// ===========================================================================

/// A consumer that finalises on `[DONE]` and on nothing else. This is the
/// implementation the gate recorded hanging for 5003 ms; it is reproduced here,
/// live, so "Vela does not hang" is measured against something that does.
async fn naive_done_driven_consumer(
    url: &str,
    profile: &str,
    budget: Duration,
) -> (bool, Duration, usize) {
    let transport = ReqwestTransport::new().expect("http client builds");
    let body = json!({
        "model": model_of(profile),
        "messages": [{"role": "user", "content": "what is the weather in Berlin"}],
        "stream": true,
        "stream_options": {"include_usage": true},
    });
    let request = HttpRequest::post_json(
        format!("{url}/v1/chat/completions"),
        serde_json::to_vec(&body).expect("encodes"),
    )
    .with_header("accept", "text/event-stream");

    let started = Instant::now();
    let outcome = tokio::time::timeout(budget, async {
        let mut response = transport
            .send(request, &Timeouts::default())
            .await
            .expect("the endpoint answers");
        let mut buffer = String::new();
        let mut chars = 0usize;
        loop {
            let chunk = response.body.next_chunk().await.expect("body reads");
            match chunk {
                Some(bytes) => buffer.push_str(&String::from_utf8_lossy(&bytes)),
                // END OF BODY — which this consumer, by construction, ignores.
                None => {
                    // Wait for a [DONE] that will never come.
                    std::future::pending::<()>().await;
                }
            }
            for line in buffer.clone().lines() {
                if let Some(data) = line.strip_prefix("data: ") {
                    if data == "[DONE]" {
                        return chars;
                    }
                    if let Ok(value) = serde_json::from_str::<Value>(data) {
                        let mut text = String::new();
                        collect_field(&value, "content", &mut text);
                        chars = chars.max(text.chars().count());
                    }
                }
            }
        }
    })
    .await;
    let elapsed = started.elapsed();
    match outcome {
        Ok(chars) => (true, elapsed, chars),
        Err(_) => (false, elapsed, 0),
    }
}

async fn controls(ledger: &mut Vec<Verdict>) -> String {
    let mut out = String::new();
    let _ = writeln!(
        out,
        "GATE M Part 1 (Phase B) — ASSERTION CONTROLS\n\
         ================================================================================\n\n\
         A green ledger is worthless if red is unreachable. Every control below applies one\n\
         of the gate's assertions where it should NOT hold, and records the FAIL, then\n\
         applies it where it should hold and records the PASS.\n\n\
         VERIFIED-BY-FAKE: every endpoint is a deterministic mock.\n"
    );

    // C1 — the hang. A [DONE]-driven consumer against an endpoint that sends none.
    let _ = writeln!(
        out,
        "\n--------------------------------------------------------------------------------\n\
         CONTROL 1 — \"the turn finishes inside 2 s\" applied to a [DONE]-driven consumer\n\
         --------------------------------------------------------------------------------\n\
         The consumer from the Phase A gate, rebuilt on Vela's own transport: it finalises on\n\
         `data: [DONE]` and treats end-of-body as nothing at all. Budget: 5 s."
    );
    for profile in ["hostile", "frontier"] {
        let server = MockServer::start(profile, &[]).await;
        let (finished, elapsed, chars) =
            naive_done_driven_consumer(&server.url, profile, Duration::from_secs(5)).await;
        let _ = writeln!(
            out,
            "  {profile:<12} finished={finished:<5} wall clock={elapsed:?} chars={chars}   → {}",
            if finished { "PASS" } else { "FAIL (HUNG)" }
        );
        ledger.push(Verdict {
            profile: profile.to_owned(),
            case: "control-1-done-driven-consumer".into(),
            name: "a [DONE]-driven consumer terminates".into(),
            pass: finished,
            detail: format!("{elapsed:?}, {chars} chars"),
        });
        server.stop().await;
    }
    let _ = writeln!(
        out,
        "  EXPECTED: hostile FAILS (it never sends [DONE]); frontier PASSES.\n  \
         Vela's own consumer finishes both in single-digit milliseconds — see each profile's\n  \
         07-stream-termination.txt. The assertion discriminates."
    );

    // C2 — reasoning separation.
    let _ = writeln!(
        out,
        "\n--------------------------------------------------------------------------------\n\
         CONTROL 2 — \"no <think> markup in the answer\" applied to the raw content channel\n\
         --------------------------------------------------------------------------------\n\
         The frame-local stripper's output is the concatenation of every `content` delta. The\n\
         assertion is applied to THAT instead of to Vela's answer."
    );
    for profile in ["mid-local", "hostile", "frontier"] {
        let server = MockServer::start(profile, &[]).await;
        let log = WireLog::default();
        let provider = provider_for(&server.url, &log);
        let mut sink = CollectingSink::new();
        let response = provider
            .stream(
                user(profile, "what is the weather in Berlin"),
                &mut sink,
                &context(),
            )
            .await
            .expect("the turn completes");
        let entries = log.drain();
        let raw = raw_content_of(&entries);
        let raw_clean = !raw.contains("think");
        let vela_clean = !response.answer_text().contains("think");
        let _ = writeln!(
            out,
            "  {profile:<12} raw channel clean={raw_clean:<5} → {}      Vela's answer clean={vela_clean:<5} → {}",
            if raw_clean { "PASS" } else { "FAIL" },
            if vela_clean { "PASS" } else { "FAIL" }
        );
        ledger.push(Verdict {
            profile: profile.to_owned(),
            case: "control-2-raw-content-channel".into(),
            name: "the raw content channel is free of reasoning markup".into(),
            pass: raw_clean,
            detail: elide(&raw, 200),
        });
        server.stop().await;
    }
    let _ = writeln!(
        out,
        "  EXPECTED: mid-local and hostile FAIL on the raw channel and PASS on Vela's answer;\n  \
         frontier passes both, because it carries reasoning in a separate field and never\n  \
         touches the <think> state machine. That difference is the discrimination."
    );

    // C3 — structured output.
    let _ = writeln!(
        out,
        "\n--------------------------------------------------------------------------------\n\
         CONTROL 3 — \"the answer conforms to the requested schema\" applied to each profile\n\
         --------------------------------------------------------------------------------\n\
         The assertion Vela's structured verdict is built on, applied directly to the answer\n\
         text each endpoint returned for a `json_schema` request."
    );
    for profile in PROFILES {
        let server = MockServer::start(profile, &[]).await;
        let log = WireLog::default();
        let provider = provider_for(&server.url, &log);
        let schema = json!({
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"]
        });
        let response = provider
            .complete(
                ChatRequest::new(model_of(profile))
                    .with_message(ChatMessage::user("give me the weather as JSON"))
                    .with_response_format(ResponseFormat::JsonSchema {
                        name: "weather".into(),
                        schema,
                    }),
                &context(),
            )
            .await
            .expect("200 on every profile — that is the danger");
        let conformed = matches!(&response.structured, Some(Ok(_)));
        let _ = writeln!(
            out,
            "  {profile:<12} HTTP 200, answer={:<44} conforms={conformed:<5} → {}",
            format!("{:?}", elide(&response.answer_text(), 38)),
            if conformed { "PASS" } else { "FAIL" }
        );
        ledger.push(Verdict {
            profile: profile.to_owned(),
            case: "control-3-schema-conformance".into(),
            name: "the answer conforms to the requested schema".into(),
            pass: conformed,
            detail: elide(&response.answer_text(), 200),
        });
        server.stop().await;
    }
    let _ = writeln!(
        out,
        "  EXPECTED: frontier PASSES, the other three FAIL — all four answered 200 OK and\n  \
         none of them said anything was wrong. That is MEASURED-5, and it is why Vela's\n  \
         verdict is a Result the caller has to destructure."
    );

    // C4 — the credential.
    let _ = writeln!(
        out,
        "\n--------------------------------------------------------------------------------\n\
         CONTROL 4 — \"no authorization header on the wire\" applied to a configured credential\n\
         --------------------------------------------------------------------------------"
    );
    {
        let server = MockServer::start("frontier", &[]).await;
        let log = WireLog::default();
        let store = Arc::new(MemoryStore::new());
        let secret = SecretRef::primary("matrix").expect("valid");
        store
            .set(&secret, &SecretValue::new("expected-key"))
            .expect("stored");
        let keyed = OpenAiCompatibleProvider::new(
            ProviderDescriptor::new("matrix", "Capability matrix", ProviderKind::Local)
                .expect("valid"),
            format!("{}/v1", server.url),
            Auth::Bearer { secret },
            store,
            Arc::new(RecordingTransport::new(log.clone())),
        );
        let _ = keyed.complete(user("frontier", "hello"), &context()).await;
        let keyed_wire = log.drain();
        let none = provider_for(&server.url, &log);
        let _ = none.complete(user("frontier", "hello"), &context()).await;
        let none_wire = log.drain();
        let keyed_clean = !keyed_wire
            .iter()
            .any(|e| e.request_headers.iter().any(|(n, _)| n == "authorization"));
        let none_clean = !none_wire
            .iter()
            .any(|e| e.request_headers.iter().any(|(n, _)| n == "authorization"));
        let _ = writeln!(
            out,
            "  Auth::Bearer   no auth header on the wire={keyed_clean:<5} → {}\n  \
             Auth::None     no auth header on the wire={none_clean:<5} → {}",
            if keyed_clean { "PASS" } else { "FAIL" },
            if none_clean { "PASS" } else { "FAIL" }
        );
        ledger.push(Verdict {
            profile: "frontier".into(),
            case: "control-4-credential-on-the-wire".into(),
            name: "no authorization header on the wire".into(),
            pass: keyed_clean,
            detail: "provider configured WITH a bearer token".into(),
        });
        let _ = writeln!(
            out,
            "  EXPECTED: the bearer case FAILS (the header is there, which is correct\n  \
             behaviour) and the Auth::None case PASSES. The header check is not vacuous."
        );
        server.stop().await;
    }

    // C5 — the vision affordance.
    let _ = writeln!(
        out,
        "\n--------------------------------------------------------------------------------\n\
         CONTROL 5 — \"the vision affordance is absent\" applied to the profile that has vision\n\
         --------------------------------------------------------------------------------"
    );
    for profile in ["frontier", "mid-local"] {
        let server = MockServer::start(profile, &[]).await;
        let log = WireLog::default();
        let provider = provider_for(&server.url, &log);
        let capabilities = provider
            .probe_capabilities(&model_of(profile), &context())
            .await
            .expect("probe");
        let absent = !capabilities.to_descriptor().vision;
        let _ = writeln!(
            out,
            "  {profile:<12} vision affordance absent={absent:<5} → {}",
            if absent { "PASS" } else { "FAIL" }
        );
        ledger.push(Verdict {
            profile: profile.to_owned(),
            case: "control-5-vision-affordance".into(),
            name: "the vision affordance is absent".into(),
            pass: absent,
            detail: format!("{:?}", capabilities.vision),
        });
        server.stop().await;
    }
    let _ = writeln!(
        out,
        "  EXPECTED: frontier FAILS (it has vision, so the affordance is correctly offered),\n  \
         mid-local PASSES. The capability check tracks the endpoint, not a hard-coded table."
    );

    // C6 — tool-call execution safety.
    let _ = writeln!(
        out,
        "\n--------------------------------------------------------------------------------\n\
         CONTROL 6 — \"the tool call is executable\" applied to the profile that breaks them\n\
         --------------------------------------------------------------------------------"
    );
    for profile in ["frontier", "hostile"] {
        let server = MockServer::start(profile, &[]).await;
        let log = WireLog::default();
        let provider = provider_for(&server.url, &log);
        let response = provider
            .complete(
                user(profile, "what is the weather in Berlin")
                    .with_tools([weather_tool()])
                    .with_tool_choice(ToolChoice::Required),
                &context(),
            )
            .await
            .expect("the turn completes");
        let executable = response.executable_tool_calls().count() == 1;
        let _ = writeln!(
            out,
            "  {profile:<12} exactly one executable call={executable:<5} → {}   ({} call(s) reported)",
            if executable { "PASS" } else { "FAIL" },
            response.tool_calls.len()
        );
        ledger.push(Verdict {
            profile: profile.to_owned(),
            case: "control-6-executable-tool-call".into(),
            name: "exactly one executable tool call comes back".into(),
            pass: executable,
            detail: describe_calls(&response.tool_calls),
        });
        server.stop().await;
    }
    let _ = writeln!(
        out,
        "  EXPECTED: frontier PASSES, hostile FAILS — and hostile failing is the desired\n  \
         behaviour: what comes back is surfaced and nothing is executable.\n  \
         NOTE: hostile sends TWO broken calls and this non-streamed path now reports BOTH.\n  \
         Round 1 reported one spliced call here — that was FINDING 1 in RESULTS.md, fixed in\n  \
         round 2. The control itself is unchanged: neither call is executable either way."
    );

    // C7 — the overflow assertion.
    let _ = writeln!(
        out,
        "\n--------------------------------------------------------------------------------\n\
         CONTROL 7 — \"the turn overflows the context window\" applied to a prompt that fits\n\
         --------------------------------------------------------------------------------"
    );
    {
        let server = MockServer::start("small-local", &[]).await;
        let log = WireLog::default();
        let provider = provider_for(&server.url, &log);
        let small = provider
            .complete(user("small-local", "hello"), &context())
            .await;
        let overflowed = matches!(&small, Err(ProviderError::ContextLengthExceeded { .. }));
        let _ = writeln!(
            out,
            "  a 5-character prompt   overflow reported={overflowed:<5} → {}",
            if overflowed { "PASS" } else { "FAIL" }
        );
        ledger.push(Verdict {
            profile: "small-local".into(),
            case: "control-7-overflow".into(),
            name: "the turn overflows the context window".into(),
            pass: overflowed,
            detail: format!("{small:?}"),
        });
        let _ = writeln!(
            out,
            "  EXPECTED: FAIL. The overflow assertion in case 05 is not something every turn\n  \
             satisfies by accident."
        );
        server.stop().await;
    }

    // C8 — the round-1 defect, reproduced on demand.
    let _ = writeln!(
        out,
        "\n--------------------------------------------------------------------------------\n\
         CONTROL 8 — \"every parallel call comes back\" applied with the round-1 rule restored\n\
         --------------------------------------------------------------------------------\n\
         Case 02p's assertions are only worth something if the defect they were written for is\n\
         still detectable. The three whole calls below are the non-streamed OpenAI shape: an\n\
         `id`, a `type`, a name and complete arguments on each, and NO `index` on any of them.\n\
         They are fed to the SAME accumulator twice — once with the shape the boundary states\n\
         today (`WholeCall`), and once with the shape round 1 assumed for everything\n\
         (`Fragment`, whose rule is \"no index continues the last-touched slot\")."
    );
    {
        let batch = [
            json!({"id": "call_a", "type": "function",
                   "function": {"name": "get_weather", "arguments": "{\"city\":\"berlin\"}"}}),
            json!({"id": "call_b", "type": "function",
                   "function": {"name": "get_weather", "arguments": "{\"city\":\"paris\"}"}}),
            json!({"id": "call_c", "type": "function",
                   "function": {"name": "get_weather", "arguments": "{\"city\":\"rome\"}"}}),
        ];
        for (label, shape) in [
            ("WholeCall (today)", ToolCallShape::WholeCall),
            ("Fragment  (round 1)", ToolCallShape::Fragment),
        ] {
            let mut accumulator = ToolCallAccumulator::new();
            for element in &batch {
                accumulator.push(element, shape);
            }
            let outcomes = accumulator.finish();
            let three = outcomes.len() == 3;
            let _ = writeln!(
                out,
                "  {label:<20} calls reported={:<2} → {}\n{}",
                outcomes.len(),
                if three { "PASS" } else { "FAIL" },
                indent(&describe_calls(&outcomes), 8)
            );
            ledger.push(Verdict {
                profile: "scripted".into(),
                case: "control-8-parallel-collapse".into(),
                name: "all three parallel calls come back".into(),
                pass: three,
                detail: describe_calls(&outcomes).replace('\n', " "),
            });
        }
    }
    let _ = writeln!(
        out,
        "  EXPECTED: WholeCall PASSES with three calls; Fragment FAILS with ONE call whose\n  \
         arguments are the three spliced together — `{{\"city\":\"berlin\"}}{{\"city\":\"paris\"}}\n  \
         {{\"city\":\"rome\"}}`, a string that never existed on any wire. That is GATE M\n  \
         FINDING 1 reproduced verbatim, and it is why case 02p is not measuring nothing."
    );

    // C9 — the credential grep.
    let _ = writeln!(
        out,
        "\n--------------------------------------------------------------------------------\n\
         CONTROL 9 — \"the credential is not in this text\" applied to text that has not been\n\
         redacted\n\
         --------------------------------------------------------------------------------\n\
         Case 11's grep is worthless if it cannot see a credential that is right there. It is\n\
         applied here to the wire form of the same URL, and to the pre-fix error string that\n\
         Phase B's security review actually found."
    );
    {
        let url = RequestUrl::new("http://127.0.0.1:8080/v1/chat/completions")
            .with_query_credential("key", &SecretValue::new(CANARY));
        // The pre-fix path, rebuilt: reqwest's Display appends the URL, and
        // `detail()` sanitises without redacting.
        let pre_fix = vela_providers::error::detail(format!(
            "error sending request for url ({})",
            url.expose()
        ));
        for (label, text) in [
            (
                "RequestUrl::expose() — the socket form",
                url.expose().to_owned(),
            ),
            ("the pre-fix detail string", pre_fix),
            ("RequestUrl Display — the redacted form", format!("{url}")),
            ("RequestUrl Debug — the redacted form", format!("{url:?}")),
        ] {
            let clean = canary_in_text(&text).is_none();
            let _ = writeln!(
                out,
                "  {label:<40} clean={clean:<5} → {}\n        {}",
                if clean { "PASS" } else { "FAIL" },
                // The needle is redacted OUT of this control's own output: the
                // whole point of the file is that the string does not spread.
                text.replace(CANARY_CORE, "<CANARY>")
                    .replace(&CANARY.replace('+', "%2B").replace('/', "%2F"), "<CANARY>")
            );
            ledger.push(Verdict {
                profile: "scripted".into(),
                case: "control-9-credential-grep".into(),
                name: format!("the credential is absent from: {label}"),
                pass: clean,
                detail: label.to_owned(),
            });
        }
    }
    let _ = writeln!(
        out,
        "  EXPECTED: the two unredacted renderings FAIL and the two redacted ones PASS. The\n  \
         `expose()` failure is correct behaviour — that string goes to a socket, never to a\n  \
         message. The pre-fix failure is the bug itself, still reproducible on demand."
    );

    // C10 — cross-transport agreement.
    let _ = writeln!(
        out,
        "\n--------------------------------------------------------------------------------\n\
         CONTROL 10 — \"the two transports agree\" applied to two answers that differ\n\
         --------------------------------------------------------------------------------\n\
         Case 02p's central assertion compares the two transports call by call. Here it is\n\
         given a matching pair and a deliberately mismatched one."
    );
    {
        let whole = [
            json!({"id": "call_a", "type": "function",
                   "function": {"name": "get_weather", "arguments": "{\"city\":\"berlin\"}"}}),
            json!({"id": "call_b", "type": "function",
                   "function": {"name": "get_time", "arguments": "{\"timezone\":\"CET\"}"}}),
        ];
        let matching = [
            json!({"index": 0, "id": "call_a", "type": "function",
                   "function": {"name": "get_weather", "arguments": "{\"city\":\"berlin\"}"}}),
            json!({"index": 1, "id": "call_b", "type": "function",
                   "function": {"name": "get_time", "arguments": "{\"timezone\":\"CET\"}"}}),
        ];
        let mismatched = [json!({"index": 0, "id": "call_a", "type": "function",
                   "function": {"name": "get_weather", "arguments": "{\"city\":\"berlin\"}"}})];

        let accumulate = |elements: &[Value], shape| {
            let mut accumulator = ToolCallAccumulator::new();
            for element in elements {
                accumulator.push(element, shape);
            }
            accumulator.finish()
        };
        let reference = accumulate(&whole, ToolCallShape::WholeCall);
        for (label, streamed) in [
            (
                "the same two calls, streamed",
                accumulate(&matching, ToolCallShape::Fragment),
            ),
            (
                "only the first call, streamed",
                accumulate(&mismatched, ToolCallShape::Fragment),
            ),
        ] {
            let agree = fingerprints(&reference) == fingerprints(&streamed);
            let _ = writeln!(
                out,
                "  {label:<32} agree={agree:<5} → {}   (non-streamed {} call(s), streamed {})",
                if agree { "PASS" } else { "FAIL" },
                reference.len(),
                streamed.len()
            );
            ledger.push(Verdict {
                profile: "scripted".into(),
                case: "control-10-transport-agreement".into(),
                name: format!("the two transports agree: {label}"),
                pass: agree,
                detail: format!("{:?}", fingerprints(&streamed)),
            });
        }
    }
    let _ = writeln!(
        out,
        "  EXPECTED: the matching pair PASSES, the truncated one FAILS. A comparison that\n  \
         passed both would be comparing nothing — which is precisely what round 1's\n  \
         count-only check did on the profiles that only ever sent one call."
    );

    // C11 — the termination budget.
    let _ = writeln!(
        out,
        "\n--------------------------------------------------------------------------------\n\
         CONTROL 11 — \"the turn ends in single-digit milliseconds\" applied to a stalled socket\n\
         --------------------------------------------------------------------------------\n\
         Case 07c asserts a median under 10 ms. Applied to the endpoint of case 07b — 4 s\n\
         between frames, 800 ms stall budget — the same assertion must fail."
    );
    {
        let server = MockServer::start("hostile", &["--chunk-delay", "4000"]).await;
        let log = WireLog::default();
        let provider = provider_for(&server.url, &log);
        let stalling = RequestContext::new().with_timeouts(Timeouts {
            connect: Duration::from_secs(5),
            first_byte: Duration::from_secs(10),
            stall: Duration::from_millis(800),
        });
        let mut sink = CollectingSink::new();
        let started = Instant::now();
        let outcome = tokio::time::timeout(
            Duration::from_secs(30),
            provider.stream(user("hostile", "hello"), &mut sink, &stalling),
        )
        .await;
        let elapsed = started.elapsed();
        let quick = elapsed < Duration::from_millis(10);
        let _ = writeln!(
            out,
            "  stalled socket        wall clock={elapsed:?} outcome={} → {}",
            match &outcome {
                Ok(Ok(_)) => "Ok".to_owned(),
                Ok(Err(error)) => error.code().to_string(),
                Err(_) => "OUTER DEADLINE".to_owned(),
            },
            if quick { "PASS" } else { "FAIL" }
        );
        ledger.push(Verdict {
            profile: "hostile".into(),
            case: "control-11-termination-budget".into(),
            name: "the turn ends in single-digit milliseconds".into(),
            pass: quick,
            detail: format!("{elapsed:?} against a 4 s inter-frame delay"),
        });
        server.stop().await;
    }
    let _ = writeln!(
        out,
        "  EXPECTED: FAIL, at roughly the 800 ms stall budget. The single-digit-millisecond\n  \
         claim in case 07c is a measurement of Vela ending a stream promptly, not an artefact\n  \
         of every code path in this recorder being fast."
    );

    let _ = writeln!(
        out,
        "\n================================================================================\n\
         Controls are recorded in verdicts.tsv under case names beginning `control-`. Their\n\
         FAILs are EXPECTED and are excluded from the gate ledger totals in RESULTS.md.\n\
         ================================================================================"
    );
    out
}

// ===========================================================================
// main
// ===========================================================================

#[tokio::main]
async fn main() -> ExitCode {
    let started = Instant::now();
    let dir = out_dir();
    std::fs::create_dir_all(&dir).expect("evidence directory");

    let mut ledger: Vec<Verdict> = Vec::new();

    for profile in PROFILES {
        eprintln!("\n=== {profile} ===");
        let server = MockServer::start(profile, &[]).await;
        let url = server.url.clone();

        let capabilities = case_00(profile, &url, &mut ledger).await;
        case_01(profile, &url, &mut ledger).await;
        case_02(profile, &url, &mut ledger).await;
        case_02p(profile, &url, &mut ledger).await;
        case_03(profile, &url, &capabilities, &mut ledger).await;
        case_04(profile, &url, &mut ledger).await;
        case_05(profile, &url, &mut ledger).await;
        case_06(profile, &url, &mut ledger).await;
        case_07(profile, &url, &mut ledger).await;
        case_07c(profile, &url, &mut ledger).await;
        case_08(profile, &url, &mut ledger).await;
        case_09(profile, &url, &mut ledger).await;
        server.stop().await;

        case_07b(profile, &mut ledger).await;
        case_11(profile, &mut ledger).await;
        case_09b(profile, &mut ledger).await;
        case_10(profile, &mut ledger).await;
    }

    eprintln!("\n=== assertion controls ===");
    let control_text = controls(&mut ledger).await;
    std::fs::write(dir.join("ASSERTION-CONTROL.txt"), control_text).expect("write controls");

    // The canary must not have spread. It is a fake string, but this directory
    // is committed, and a recorder that scattered a credential across evidence
    // files would be teaching exactly the wrong habit. Case 11's own transcript
    // is the one place it belongs: the NEEDLE line that declares it, and the
    // recorded leak evidence underneath.
    {
        let mut elsewhere: Vec<String> = Vec::new();
        let mut inside = 0usize;
        // Only the per-profile case transcripts. The top-level ledger files —
        // verdicts.tsv, SUMMARY.txt, RESULTS.md — aggregate case 11's evidence
        // by design and are written after this scan anyway.
        for profile in PROFILES {
            let Ok(entries) = std::fs::read_dir(dir.join(profile)) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let Ok(text) = std::fs::read_to_string(&path) else {
                    continue;
                };
                if !canary_needles()
                    .iter()
                    .any(|needle| text.contains(needle.as_str()))
                {
                    continue;
                }
                let name = path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default();
                if name == "11-credential-leak.txt" {
                    inside += 1;
                } else {
                    elsewhere.push(path.display().to_string());
                }
            }
        }
        ledger.push(Verdict {
            profile: "all".into(),
            case: "11-credential-leak".into(),
            name: "the canary appears in no evidence file but case 11's own transcript".into(),
            pass: elsewhere.is_empty(),
            detail: if elsewhere.is_empty() {
                format!("{inside} case-11 transcript(s) carry it, nothing else does")
            } else {
                elsewhere.join(" ")
            },
        });
    }

    // verdicts.tsv — every assertion, machine-readable.
    let mut tsv = String::from("profile\tcase\tverdict\tassertion\tdetail\n");
    for verdict in &ledger {
        let _ = writeln!(
            tsv,
            "{}\t{}\t{}\t{}\t{}",
            verdict.profile,
            verdict.case,
            if verdict.pass { "PASS" } else { "FAIL" },
            verdict.name,
            verdict.detail.replace(['\t', '\n'], " ")
        );
    }
    std::fs::write(dir.join("verdicts.tsv"), tsv).expect("write verdicts");

    let gate: Vec<&Verdict> = ledger
        .iter()
        .filter(|v| !v.case.starts_with("control-"))
        .collect();
    let failures: Vec<&&Verdict> = gate.iter().filter(|v| !v.pass).collect();

    let mut summary = String::new();
    let _ = writeln!(
        summary,
        "GATE M Part 1 (Phase B) — run summary\n\
         =====================================\n\n\
         gate assertions   {}\n\
         failures          {}\n\
         controls          {} (their FAILs are expected)\n\
         wall clock        {:?}\n",
        gate.len(),
        failures.len(),
        ledger.len() - gate.len(),
        started.elapsed()
    );
    if failures.is_empty() {
        let _ = writeln!(summary, "No gate assertion failed.");
    } else {
        let _ = writeln!(summary, "FAILURES:");
        for verdict in &failures {
            let _ = writeln!(
                summary,
                "  {} / {} / {}\n      {}",
                verdict.profile, verdict.case, verdict.name, verdict.detail
            );
        }
    }
    std::fs::write(dir.join("SUMMARY.txt"), &summary).expect("write summary");
    print!("{summary}");

    if failures.is_empty() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
