//! **GATE M Part 1, Phase B2 — the evidence recorder.**
//!
//! Runs Vela's own provider stack against all four capability-matrix profiles,
//! started as real OS processes and driven over real TCP, and writes verbatim
//! evidence to `docs/regression-baseline/phase-b2-matrix/<profile>/`.
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
//! cargo run -p vela-providers --example gate_m_phase_b2
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
    ResponseHeaders, TransportError,
};
use vela_providers::openai_compatible::{OpenAiCompatibleProvider, ProviderOptions};
use vela_providers::redact::RequestUrl;
use vela_providers::tool_accum::{ToolCallAccumulator, ToolCallShape};
use vela_providers::{
    Candidate, Capability, ChatMessage, ChatRequest, ContentPart, Degradation, MalformedToolCall,
    MessageRole, Provider, ProviderError, RequestContext, ResponseFormat, RetryPolicy, Router,
    StopReason, StructuredOutputPolicy, Timeouts, ToolCallOutcome, ToolChoice, ToolDefinition,
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

/// Where the evidence lands.
///
/// **This moved in B2, deliberately.** `phase-b-matrix/` is round 4's record —
/// a run that exits 1 and names FINDING 3 open. That is history worth keeping
/// verbatim, not something to overwrite with a run that closes it. B2 writes
/// beside it, and `phase-b-matrix/` is frozen; see its README.
fn out_dir() -> PathBuf {
    repo_root().join("docs/regression-baseline/phase-b2-matrix")
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
        /// The response headers **as the type hands them out**: values already
        /// scrubbed. This field used to be a bare `Vec<(String, String)>`
        /// copied verbatim out of the response, which made this recorder the
        /// worked example of the one endpoint-supplied surface with no
        /// chokepoint. See `http::ResponseHeaders`.
        headers: ResponseHeaders,
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
                    outcome: WireOutcome::Failed(format!(
                        "{:?}: {}",
                        error.failure, error.diagnosis
                    )),
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
                    error.failure, error.diagnosis
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
        Doc::new_with(
            profile,
            case,
            title,
            purpose,
            "Vela's own provider stack (vela-providers::OpenAiCompatibleProvider)",
            &format!(
                "tests/harness/mock-provider, profile `{profile}`, a real OS process on loopback"
            ),
        )
    }

    /// [`Doc::new`] with the SUBJECT and ENDPOINT lines supplied.
    ///
    /// B2's cross-product cases drive the Anthropic and Gemini adapters against
    /// purpose-built loopback peers rather than the four matrix profiles, and a
    /// transcript that claimed otherwise in its own header would be the exact
    /// kind of quiet lie this gate exists to catch.
    fn new_with(
        profile: &str,
        case: &str,
        title: &str,
        purpose: &str,
        subject: &str,
        endpoint: &str,
    ) -> Self {
        let mut body = String::new();
        let _ = writeln!(
            body,
            "================================================================================"
        );
        let _ = writeln!(
            body,
            "GATE M Part 1 (Phase B2) — profile: {profile} — case {case}: {title}"
        );
        let _ = writeln!(
            body,
            "================================================================================"
        );
        let _ = writeln!(body);
        let _ = writeln!(body, "PURPOSE   {purpose}");
        let _ = writeln!(body, "SUBJECT   {subject}");
        let _ = writeln!(body, "ENDPOINT  {endpoint}");
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
                    for (name, value) in headers.iter() {
                        if matches!(name, "content-type" | "transfer-encoding") {
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

/// The credential the latency case measures the shipped path with.
///
/// It contains `/` on purpose: percent-encoded it becomes `%2F`, so the
/// scrubber carries **two** needles of different lengths for one key, which is
/// the shape `Scrubber::hold_back_len` has the most work to do with.
const LATENCY_KEY: &str = "sk/matrix-latency/Ky-0f19c7/probe";

/// The same provider, with the credential **in the query string**.
///
/// # Why this exists (round 4)
///
/// Case 07c used to build its provider with [`Auth::None`], which means an
/// empty [`Scrubber`], which means `BodyStream::next_chunk` takes its
/// short-circuit and returns the endpoint's bytes with no copy, no buffering
/// and no scan. The medians it recorded were therefore medians of a path that
/// does not run when a user has configured a key — offered as evidence for
/// redaction that they never exercised.
///
/// `Auth::ApiKeyQuery` is the binding that makes the scrubber non-empty for
/// *every* chunk of *every* response, so the numbers below are numbers about
/// `scrub_bytes` and `hold_back_len` actually running.
fn credentialed_provider_for(url: &str, log: &WireLog) -> OpenAiCompatibleProvider {
    let store = Arc::new(MemoryStore::new());
    let secret = SecretRef::primary("matrix").expect("static id is valid");
    store
        .set(&secret, &SecretValue::new(LATENCY_KEY))
        .expect("MemoryStore accepts a non-empty value");
    OpenAiCompatibleProvider::new(
        ProviderDescriptor::new("matrix", "Capability matrix", ProviderKind::Local)
            .expect("static id is valid"),
        format!("{url}/v1"),
        Auth::ApiKeyQuery {
            param: "api_key".into(),
            secret,
        },
        store,
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
    // INVERTED IN B2, and argued here rather than deleted.
    //
    // The round-4 wording was "no upstream body **or HTTP status** escapes into
    // the error", and it now FAILS: `Display` prints `HTTP 401`. That is not a
    // regression, it is the redesign. B2 carries the status **deliberately** —
    // it is one of the five typed fields `Diagnosis` is allowed to hold, it is
    // Vela's own parse of the status line, and it is the single most useful
    // thing a user can be told about a failed turn.
    //
    // Keeping the old wording would have been the dishonest move twice over:
    // it would have failed a gate for doing the thing the gate asked for, and
    // it would have blurred "a three-digit code from RFC 9110's registry" into
    // "text the endpoint wrote". So the assertion splits in two, and the second
    // half is strictly stronger than what it replaces.
    doc.check(
        "no upstream BODY text escapes into the error",
        outcome.as_ref().err().is_some_and(|e| {
            let rendered = format!("{e}\n{e:?}");
            !rendered.contains("{\"error\"") && !rendered.contains("expected-key")
        }),
        format!("{outcome:?}"),
    );
    doc.check(
        "STRONGER: every string in the error's serde shape is drawn from Vela's own \
         closed vocabulary — nothing on the wire reached it in any spelling",
        outcome
            .as_ref()
            .err()
            .is_some_and(|e| vela_providers::diagnostic::unexplained_in_error(e).is_empty()),
        outcome.as_ref().err().map_or_else(
            || "no error".to_owned(),
            |e| {
                let unexplained = vela_providers::diagnostic::unexplained_in_error(e);
                if unexplained.is_empty() {
                    "0 unexplained strings".to_owned()
                } else {
                    format!("unexplained: {unexplained:?}")
                }
            },
        ),
    );
    doc.check(
        "the HTTP status IS carried, as a typed u16 — the diagnostic B2 chose to keep",
        outcome
            .as_ref()
            .err()
            .and_then(|e| e.diagnosis().map(|d| d.status()))
            == Some(Some(401)),
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

/// One arm of the latency case: five identical streamed turns through one
/// provider.
struct LatencyArm {
    samples: Vec<Duration>,
    answers: Vec<usize>,
    failed: Option<String>,
    /// Whether the requests this arm sent actually carried a credential. The
    /// vacuity guard for the whole round-4 point of this case.
    credential_on_the_wire: bool,
}

impl LatencyArm {
    fn median(&self) -> Duration {
        let mut sorted = self.samples.clone();
        sorted.sort();
        sorted
            .get(sorted.len() / 2)
            .copied()
            .unwrap_or(Duration::MAX)
    }

    fn worst(&self) -> Duration {
        self.samples.iter().copied().max().unwrap_or(Duration::MAX)
    }

    fn complete(&self) -> bool {
        self.failed.is_none() && self.samples.len() == 5
    }

    fn answers_agree(&self) -> bool {
        self.answers.windows(2).all(|pair| pair[0] == pair[1])
            && self.answers.first().is_some_and(|n| *n > 0)
    }
}

async fn latency_arm(
    profile: &str,
    provider: &OpenAiCompatibleProvider,
    log: &WireLog,
) -> LatencyArm {
    let mut arm = LatencyArm {
        samples: Vec::new(),
        answers: Vec::new(),
        failed: None,
        credential_on_the_wire: false,
    };
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
        // Read the wire before draining it: whether a credential was attached
        // is the fact this case now turns on.
        for entry in log.drain() {
            if entry.url.carries_credential()
                || entry
                    .request_headers
                    .iter()
                    .any(|(name, _)| name == "authorization")
            {
                arm.credential_on_the_wire = true;
            }
        }
        match outcome {
            Ok(Ok(response)) => {
                arm.samples.push(elapsed);
                arm.answers.push(response.answer_text().chars().count());
            }
            Ok(Err(error)) => {
                arm.failed = Some(format!("{error:?}"));
                break;
            }
            Err(_) => {
                arm.failed = Some("HUNG: 20 s outer deadline".into());
                break;
            }
        }
    }
    arm
}

fn record_arm(doc: &mut Doc, title: &str, arm: &LatencyArm) {
    doc.h(title);
    for (run, sample) in arm.samples.iter().enumerate() {
        doc.kv(
            &format!("run {}", run + 1),
            format!("{sample:?}   ({} answer characters)", arm.answers[run]),
        );
    }
    doc.kv("MEDIAN", format!("{:?}", arm.median()));
    doc.kv("worst sample", format!("{:?}", arm.worst()));
    doc.kv(
        "credential on the wire",
        format!("{}", arm.credential_on_the_wire),
    );
}

async fn case_07c(profile: &str, url: &str, ledger: &mut Vec<Verdict>) {
    let log = WireLog::default();
    let mut doc = Doc::new(
        profile,
        "07c-termination-latency",
        "stream termination latency, five samples per arm, credentialed and not",
        "MEASURED-1 sharpened: the turn must end in single-digit milliseconds, not merely \
         inside the 5 s a naive [DONE]-driven consumer hung for — and it must do so on the \
         path a configured user actually runs.",
    );

    doc.p(
        "  Five identical streamed turns per arm. The endpoint is the same OS process\n  \
         throughout, so the spread below is this container's scheduling noise and nothing\n  \
         else. `hostile` never sends [DONE] and `small-local` never sends usage though it\n  \
         accepted `include_usage`: both are the shapes that hung the recorded consumers\n  \
         for 5 s.",
    );
    doc.p(
        "  ROUND 4. This case used to have one arm, built with `Auth::None`. An empty\n  \
         credential set means an empty `Scrubber`, and `BodyStream::next_chunk` takes a\n  \
         short-circuit when the scrubber is empty: no copy, no carry buffer, no scan. The\n  \
         medians it published were therefore medians of a path that does not run once a\n  \
         user configures a key — offered, implicitly, as the latency evidence for the\n  \
         redaction they never touched. The CREDENTIALED arm below is the one the\n  \
         single-digit claim is now made about; the uncredentialed arm is kept beside it so\n  \
         the cost of redaction is visible rather than asserted.",
    );

    let uncredentialed = latency_arm(profile, &provider_for(url, &log), &log).await;
    let credentialed = latency_arm(profile, &credentialed_provider_for(url, &log), &log).await;

    record_arm(
        &mut doc,
        "arm A — Auth::None (empty scrubber, fast path)",
        &uncredentialed,
    );
    record_arm(
        &mut doc,
        "arm B — Auth::ApiKeyQuery (every chunk through scrub_bytes + hold_back_len)",
        &credentialed,
    );

    doc.h("the comparison");
    doc.kv(
        "median, uncredentialed",
        format!("{:?}", uncredentialed.median()),
    );
    doc.kv(
        "MEDIAN, CREDENTIALED",
        format!("{:?}", credentialed.median()),
    );
    doc.kv(
        "cost of redaction (median delta)",
        format!(
            "{:?}",
            credentialed
                .median()
                .checked_sub(uncredentialed.median())
                .unwrap_or_default()
        ),
    );
    doc.kv("recorded naive [DONE] consumer", "5003 ms (TIMED OUT)");

    doc.h("assertions");
    doc.check(
        "the credentialed arm really did put a credential on the wire",
        credentialed.credential_on_the_wire,
        format!(
            "credentialed arm: {}, uncredentialed arm: {}",
            credentialed.credential_on_the_wire, uncredentialed.credential_on_the_wire
        ),
    );
    doc.check(
        "the uncredentialed arm really did not — the two arms are different paths",
        !uncredentialed.credential_on_the_wire,
        format!("{}", uncredentialed.credential_on_the_wire),
    );
    doc.check(
        "every sampled turn completed without error, both arms",
        uncredentialed.complete() && credentialed.complete(),
        format!(
            "uncredentialed: {}, credentialed: {}",
            uncredentialed
                .failed
                .clone()
                .unwrap_or_else(|| format!("{} samples", uncredentialed.samples.len())),
            credentialed
                .failed
                .clone()
                .unwrap_or_else(|| format!("{} samples", credentialed.samples.len()))
        ),
    );
    doc.check(
        "TERMINATION IS SINGLE-DIGIT MILLISECONDS ON THE CREDENTIALED PATH — median under 10 ms",
        credentialed.median() < Duration::from_millis(10),
        format!(
            "median {:?}, samples {:?}",
            credentialed.median(),
            credentialed.samples
        ),
    );
    doc.check(
        "…and on the uncredentialed one, so redaction is not what makes or breaks it",
        uncredentialed.median() < Duration::from_millis(10),
        format!("median {:?}", uncredentialed.median()),
    );
    doc.check(
        "no sample came anywhere near the recorded 5003 ms hang, either arm",
        uncredentialed.worst() < Duration::from_millis(500)
            && credentialed.worst() < Duration::from_millis(500),
        format!(
            "worst uncredentialed {:?}, worst credentialed {:?}",
            uncredentialed.worst(),
            credentialed.worst()
        ),
    );
    doc.check(
        "every sample returned the same answer length — timing did not truncate anything",
        uncredentialed.answers_agree() && credentialed.answers_agree(),
        format!(
            "uncredentialed {:?}, credentialed {:?}",
            uncredentialed.answers, credentialed.answers
        ),
    );
    doc.check(
        "redaction did not change the answer — both arms delivered the same text length",
        uncredentialed.answers.first() == credentialed.answers.first(),
        format!(
            "uncredentialed {:?}, credentialed {:?}",
            uncredentialed.answers.first(),
            credentialed.answers.first()
        ),
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
    /// **ROUND 4.** Parses the `key` query parameter, percent-**decodes** it —
    /// which is what any gateway does before deciding the key is invalid — and
    /// echoes the raw credential back inside a 400, with the JSON string
    /// escaped the way PHP's `json_encode` escapes it: `/` becomes `\/`.
    ///
    /// The canary contains `/`, so the bytes on the wire contain **no literal
    /// copy** of it. A byte-literal scrub matches nothing, releases the frame
    /// verbatim, and `serde_json` reassembles the credential downstream of every
    /// scrub point. That is the whole of the round-4 defect, on the wire.
    EchoesTheDecodedKeyEscaped,
    /// The same, delivered in a 200 SSE error frame — FINDING 2's shape carrying
    /// round 4's spelling, which is the intersection the gate had never driven.
    EchoesTheDecodedKeyEscapedInAStreamFrame,
}

/// Undo `%XX`, the way a gateway's query parser does before it looks at the
/// value it was given.
fn percent_decode_bytes(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or(""),
                16,
            ) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// PHP's `json_encode` with default flags, for the contents of a JSON string.
fn php_json_escape(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('/', "\\/")
}

/// The `key` query parameter of a request target, decoded. Empty when absent.
fn decoded_key_of(target: &str) -> String {
    target
        .split_once('?')
        .map(|(_, query)| query)
        .unwrap_or("")
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(name, _)| *name == "key" || *name == "api_key")
        .map(|(_, value)| percent_decode_bytes(value))
        .unwrap_or_default()
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
                    Misbehaviour::EchoesTheDecodedKeyEscaped
                    | Misbehaviour::EchoesTheDecodedKeyEscapedInAStreamFrame => {
                        let streamed =
                            matches!(mode, Misbehaviour::EchoesTheDecodedKeyEscapedInAStreamFrame);
                        let mut scratch = vec![0u8; 16384];
                        let read = socket.read(&mut scratch).await.unwrap_or(0);
                        let text = String::from_utf8_lossy(&scratch[..read]).into_owned();
                        let target = text
                            .lines()
                            .next()
                            .and_then(|line| line.split_whitespace().nth(1))
                            .unwrap_or("/")
                            .to_owned();
                        // The credential, percent-decoded — raw `/` and all —
                        // and then JSON-escaped by an encoder that escapes `/`.
                        // Built by hand rather than with `serde_json::to_string`
                        // precisely because serde does *not* escape the solidus:
                        // this peer is imitating PHP, not Rust.
                        // The PATH only, deliberately: the query string carries
                        // the *percent-encoded* credential, which `json_encode`
                        // does not touch and a byte-literal scrub therefore does
                        // catch. Quoting it here would leave a matchable form on
                        // the wire and blunt the premise this peer exists to
                        // establish — that the ONLY spelling present is one no
                        // needle matches and only a decoder can resolve.
                        let path = target.split('?').next().unwrap_or("/");
                        let message = php_json_escape(&format!(
                            "invalid api key {} for POST {path}",
                            decoded_key_of(&target)
                        ));
                        let (content_type, body) = if streamed {
                            (
                                "text/event-stream",
                                format!(
                                    "data: {{\"error\":{{\"message\":\"{message}\",\
                                     \"code\":\"invalid_api_key\"}}}}\n\ndata: [DONE]\n\n"
                                ),
                            )
                        } else {
                            (
                                "application/json",
                                format!(
                                    "{{\"error\":{{\"message\":\"{message}\",\
                                     \"code\":\"invalid_api_key\"}}}}"
                                ),
                            )
                        };
                        let status = if streamed {
                            "200 OK"
                        } else {
                            "400 Bad Request"
                        };
                        let payload = format!(
                            "HTTP/1.1 {status}\r\n\
                             content-type: {content_type}\r\n\
                             content-length: {}\r\n\r\n{body}",
                            body.len()
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
    // ROUND 4: the same two echoes, spelled the way an endpoint that JSON-
    // escapes `/` spells them. No literal copy of the canary reaches the wire,
    // so a byte-literal scrub has nothing to match — and Vela's own decoder is
    // what would put the credential back together.
    let escaped_echo = RawPeer::start(Misbehaviour::EchoesTheDecodedKeyEscaped).await;
    let escaped_stream_echo =
        RawPeer::start(Misbehaviour::EchoesTheDecodedKeyEscapedInAStreamFrame).await;
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
        Forced {
            label: "the endpoint echoes the key back JSON-ESCAPED (400 body)",
            why: "a 400 whose error body quotes the DECODED key with `/` written `\\/` — \
                  PHP json_encode's default. No literal copy of the canary is on the wire, \
                  so a byte-literal scrub matches nothing and serde_json reassembles it",
            url: escaped_echo.url.clone(),
            streamed: false,
        },
        Forced {
            label: "the endpoint echoes the key back JSON-ESCAPED (200 + error frame)",
            why: "the same spelling in FINDING 2's shape — a 200 SSE error frame read \
                  through next_chunk, which is the intersection this gate had never driven",
            url: escaped_stream_echo.url.clone(),
            streamed: true,
        },
        Forced {
            label: "the endpoint echoes the key back JSON-ESCAPED (error frame, non-streamed)",
            why: "the same escaping peer read through complete()",
            url: escaped_stream_echo.url.clone(),
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
    let escaped_echo_sent = escaped_echo.sent_text();
    let escaped_stream_echo_sent = escaped_stream_echo.sent_text();

    silent.stop();
    reset.stop();
    echo.stop();
    stream_echo.stop();
    escaped_echo.stop();
    escaped_stream_echo.stop();

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

    doc.h("ROUND 4 — the ESCAPING peers, whose bytes contain no literal canary at all");
    doc.p(
        "  These two peers percent-decode the `key` parameter and echo the raw credential\n  \
         back with `/` written `\\/`, which is what PHP's `json_encode` does by default.\n  \
         The assertion below is the PREMISE of the round-4 cases and it is the opposite of\n  \
         the one above: the canary must NOT appear literally in what these peers wrote, or\n  \
         a byte-literal scrub would have caught it and the cases would prove nothing. What\n  \
         must appear is the ESCAPED spelling — the one Vela's own decoder turns back into\n  \
         a credential.",
    );
    let escaped_needle = CANARY.replace('/', "\\/");
    // What the *scrubber* carries — the credential as configured and as written
    // into the query string. Deliberately NOT `canary_needles()`, which also
    // holds a short core fragment for leak *detection*: the question here is
    // what a byte-literal scrub had to match on, and it only ever had these two.
    let scrubber_needles = |text: &str| -> bool {
        text.contains(CANARY)
            || text.contains(
                &CANARY
                    .replace('+', "%2B")
                    .replace('/', "%2F")
                    .replace('=', "%3D"),
            )
    };
    for (label, sent) in &[
        ("400 body, JSON-escaped", &escaped_echo_sent),
        ("200 + error frame, JSON-escaped", &escaped_stream_echo_sent),
    ] {
        doc.kv(
            &format!("peer `{label}` wrote the ESCAPED credential"),
            sent.contains(&escaped_needle),
        );
        doc.kv(
            &format!("peer `{label}` wrote a form a byte-literal scrub could match"),
            scrubber_needles(sent),
        );
        doc.kv(
            &format!("  bytes peer `{label}` wrote"),
            format!("{} bytes", sent.len()),
        );
    }
    doc.check(
        "both escaping peers put the ESCAPED credential on the wire — the cases are real",
        escaped_echo_sent.contains(&escaped_needle)
            && escaped_stream_echo_sent.contains(&escaped_needle),
        format!(
            "400 body: {}, error frame: {}",
            escaped_echo_sent.contains(&escaped_needle),
            escaped_stream_echo_sent.contains(&escaped_needle)
        ),
    );
    doc.check(
        "…and NEITHER wrote a form the byte-literal scrub could match — that is the hole",
        !scrubber_needles(&escaped_echo_sent) && !scrubber_needles(&escaped_stream_echo_sent),
        format!(
            "400 body: {}, error frame: {}",
            scrubber_needles(&escaped_echo_sent),
            scrubber_needles(&escaped_stream_echo_sent)
        ),
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
    // THE PROBE WAS LYING, AND IS FIXED HERE RATHER THAN FILED.
    //
    // Round 4 asked `contract.ts.contains("provider_")`. In B2 that matches the
    // string `'no_provider_configured'` — a `Cause` **code**, not a command
    // name — so the probe reported a provider command on the bridge that does
    // not exist, and the gate went red for a fact that was not true. A tooling
    // lie that makes a gate red is still a tooling lie; it would have made a
    // real red indistinguishable from noise.
    //
    // The fix is to ask the question the assertion is actually about: is there
    // a Tauri *command* named `provider_…`, invoked from the frontend? Command
    // names appear as `invoke('provider_x'` in TS and as a `provider_x` handler
    // registered in the Rust allowlist.
    let provider_command_in_rust = allowlist.contains("\"provider_")
        || allowlist.contains("fn provider_")
        || allowlist.contains("::provider_");
    let provider_command_in_ts =
        contract.contains("'provider_") || contract.contains("\"provider_");
    doc.kv(
        "a provider_* command on the Rust allowlist",
        provider_command_in_rust,
    );
    doc.kv(
        "a provider_* command invoked from contract.ts",
        provider_command_in_ts,
    );
    doc.kv(
        "(round 4's substring probe would have said, of contract.ts)",
        contract.contains("provider_"),
    );
    doc.p(
        "  The third line is why this probe changed. `contract.ts` contains `provider_`, but\n  \
         inside `'no_provider_configured'` — a Cause CODE, one of the 35 strings B2's own\n  \
         closed vocabulary defines. Round 4's probe read that as a live IPC command and failed\n  \
         the gate on it. The probe was fixed and re-run rather than reported as a finding.",
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
// Case 12 — redirect egress (round 4)
// ===========================================================================
//
// The round-3 panel's security FAIL, driven as gate evidence rather than read
// off a fix. `reqwest`'s defaults are `Policy::limited(10)` with
// `referer: true`, and its cross-host protection strips exactly five headers:
// `authorization`, `cookie`, `cookie2`, `proxy-authorization`,
// `www-authenticate`. `x-api-key` is not among them; neither is
// `x-goog-api-key`; neither is any header an `Auth::ApiKeyHeader` binding
// names. And `make_referer` keeps the query string, so an `Auth::ApiKeyQuery`
// credential rode to the next hop inside a `Referer`.
//
// So a `3xx` from the configured endpoint handed the user's key to a host they
// never named, on the first request of a healthy turn, with no error anywhere.
// This case asserts the third party receives **zero bytes** — not "no
// credential", zero bytes — because the rule is that Vela talks to the endpoint
// the user configured and to nothing else, and a prompt is user data too.

/// Case 12's canary. Distinct from case 11's, so a transcript that carries one
/// cannot be mistaken for a transcript that carries the other, and so the
/// spread tripwire can name the file each belongs in.
const REDIRECT_CANARY: &str = "vela+gate/m4-redirect-Rk2p9Wq-DO-NOT-LEAK";
const REDIRECT_CANARY_CORE: &str = "Rk2p9Wq";

fn redirect_canary_needles() -> Vec<String> {
    vec![
        REDIRECT_CANARY.to_owned(),
        vela_providers::redact::percent_encode(REDIRECT_CANARY),
        vela_providers::redact::percent_encode(REDIRECT_CANARY).to_lowercase(),
        REDIRECT_CANARY_CORE.to_owned(),
    ]
}

/// A listener that records everything it is sent and answers however it is
/// told to. Stands in for both halves of the redirect: the endpoint the user
/// configured, and the third party they did not.
struct EgressRecorder {
    url: String,
    task: tokio::task::JoinHandle<()>,
    /// Raw request bytes, one entry per accepted connection.
    received: Arc<Mutex<Vec<Vec<u8>>>>,
    /// Accepted TCP connections, whether or not a byte followed. A client that
    /// opened a socket and thought better of it still told the third party the
    /// user exists.
    connections: Arc<Mutex<usize>>,
}

/// What an [`EgressRecorder`] answers with.
#[derive(Clone)]
enum Answer {
    /// A `3xx` pointing somewhere else.
    Redirect { status: u16, location: String },
    /// A `3xx` pointing at this same listener, on a different path — the
    /// reverse-proxy-normalising-a-path case, which is real and harmless.
    RedirectToSelfPath { status: u16, path: String },
    /// An ordinary successful chat completion.
    Chat,
}

impl EgressRecorder {
    async fn start(answer: Answer) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("loopback bind");
        let address = listener.local_addr().expect("bound");
        let url = format!("http://{address}");
        let received: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
        let connections = Arc::new(Mutex::new(0usize));
        let received_by_task = Arc::clone(&received);
        let connections_by_task = Arc::clone(&connections);
        let self_url = url.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                *connections_by_task.lock().expect("poisoned") += 1;
                let mut scratch = vec![0u8; 32768];
                let read = socket.read(&mut scratch).await.unwrap_or(0);
                let raw = scratch[..read].to_vec();
                let target = String::from_utf8_lossy(&raw)
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/")
                    .to_owned();
                received_by_task.lock().expect("poisoned").push(raw);

                let body = json!({
                    "id": "redirect-probe",
                    "object": "chat.completion",
                    "choices": [{
                        "index": 0,
                        "message": {"role": "assistant", "content": "followed"},
                        "finish_reason": "stop"
                    }]
                })
                .to_string();
                let response = match &answer {
                    Answer::Redirect { status, location } => format!(
                        "HTTP/1.1 {status} Found\r\nlocation: {location}\r\n\
                         content-length: 0\r\nconnection: close\r\n\r\n"
                    ),
                    // Only the FIRST path redirects; the destination serves a
                    // normal answer, or this would loop forever.
                    Answer::RedirectToSelfPath { status, path }
                        if !target.starts_with(path.as_str()) =>
                    {
                        format!(
                            "HTTP/1.1 {status} Moved Permanently\r\nlocation: {self_url}{path}\r\n\
                             content-length: 0\r\nconnection: close\r\n\r\n"
                        )
                    }
                    _ => format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\
                         content-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    ),
                };
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.flush().await;
            }
        });
        Self {
            url,
            task,
            received,
            connections,
        }
    }

    fn connections(&self) -> usize {
        *self.connections.lock().expect("poisoned")
    }

    fn transcript(&self) -> String {
        self.received
            .lock()
            .expect("poisoned")
            .iter()
            .map(|raw| String::from_utf8_lossy(raw).into_owned())
            .collect::<Vec<_>>()
            .join("\n----\n")
    }

    fn bytes_received(&self) -> usize {
        self.received
            .lock()
            .expect("poisoned")
            .iter()
            .map(Vec::len)
            .sum()
    }

    fn stop(self) {
        self.task.abort();
    }
}

/// Which credential binding is configured. All four `Auth` variants, plus the
/// second header name Vela actually ships, because `x-api-key` and
/// `x-goog-api-key` are Anthropic's and Google's and both are absent from
/// `reqwest`'s strip list.
#[derive(Clone, Copy, PartialEq, Eq)]
enum RedirectBinding {
    None,
    Bearer,
    AnthropicHeader,
    GoogleHeader,
    Query,
}

impl RedirectBinding {
    const ALL: [RedirectBinding; 5] = [
        RedirectBinding::None,
        RedirectBinding::Bearer,
        RedirectBinding::AnthropicHeader,
        RedirectBinding::GoogleHeader,
        RedirectBinding::Query,
    ];

    fn label(self) -> &'static str {
        match self {
            RedirectBinding::None => "Auth::None",
            RedirectBinding::Bearer => "Auth::Bearer",
            RedirectBinding::AnthropicHeader => "Auth::ApiKeyHeader{x-api-key}",
            RedirectBinding::GoogleHeader => "Auth::ApiKeyHeader{x-goog-api-key}",
            RedirectBinding::Query => "Auth::ApiKeyQuery{key}",
        }
    }

    /// What `reqwest`'s own defaults do with this binding across a cross-host
    /// hop. Asserted by the positive control, not read off a changelog.
    fn leaks_without_a_policy(self) -> bool {
        !matches!(self, RedirectBinding::None | RedirectBinding::Bearer)
    }

    fn auth(self, secret: SecretRef) -> Auth {
        match self {
            RedirectBinding::None => Auth::None,
            RedirectBinding::Bearer => Auth::Bearer { secret },
            RedirectBinding::AnthropicHeader => Auth::ApiKeyHeader {
                header: "x-api-key".into(),
                secret,
            },
            RedirectBinding::GoogleHeader => Auth::ApiKeyHeader {
                header: "x-goog-api-key".into(),
                secret,
            },
            RedirectBinding::Query => Auth::ApiKeyQuery {
                param: "key".into(),
                secret,
            },
        }
    }
}

fn redirect_provider(
    binding: RedirectBinding,
    base_url: &str,
    transport: Arc<dyn HttpTransport>,
) -> OpenAiCompatibleProvider {
    let store = Arc::new(MemoryStore::new());
    let secret = SecretRef::primary("redirect").expect("static id is valid");
    store
        .set(&secret, &SecretValue::new(REDIRECT_CANARY))
        .expect("MemoryStore accepts a non-empty value");
    OpenAiCompatibleProvider::new(
        ProviderDescriptor::new("redirect", "Redirect egress", ProviderKind::Local)
            .expect("static id is valid"),
        format!("{base_url}/v1"),
        binding.auth(secret),
        store,
        transport,
    )
}

/// `ReqwestTransport` as it was **before** the fix: the same client with
/// `no_proxy` and a user agent, and `reqwest`'s untouched redirect and referer
/// defaults. The positive control, without which "no egress" proves nothing.
struct PreFixTransport {
    client: reqwest::Client,
}

impl PreFixTransport {
    fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(5))
                .no_proxy()
                .user_agent("vela/pre-fix-control")
                .build()
                .expect("the control client builds"),
        }
    }
}

#[async_trait]
impl HttpTransport for PreFixTransport {
    async fn send(
        &self,
        request: HttpRequest,
        _timeouts: &Timeouts,
    ) -> Result<HttpResponse, TransportError> {
        let origin = request.origin();
        let mut builder = match request.method {
            vela_providers::http::HttpMethod::Get => self.client.get(request.url.expose()),
            vela_providers::http::HttpMethod::Post => self.client.post(request.url.expose()),
        };
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        if let Some(body) = request.body {
            builder = builder.body(body);
        }
        let response = builder.send().await.map_err(|_error| {
            TransportError::new(
                vela_providers::TransportFailure::Reset,
                origin.diagnose(vela_providers::Cause::ConnectionReset),
            )
        })?;
        let status = response.status().as_u16();
        let headers = ResponseHeaders::new(
            response.headers().iter().map(|(name, value)| {
                (
                    name.as_str().to_ascii_lowercase(),
                    value.to_str().unwrap_or_default().to_owned(),
                )
            }),
            &origin,
        );
        Ok(HttpResponse {
            status,
            headers,
            body: BodyStream::new(PreFixBody { response }, origin),
        })
    }
}

struct PreFixBody {
    response: reqwest::Response,
}

#[async_trait]
impl ByteStream for PreFixBody {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
        match self.response.chunk().await {
            Ok(Some(bytes)) => Ok(Some(bytes.to_vec())),
            Ok(None) => Ok(None),
            Err(_) => Err(TransportError::new(
                vela_providers::TransportFailure::Reset,
                vela_providers::Cause::ConnectionReset,
            )),
        }
    }
}

/// Drive one turn, either transport, and return whatever came back.
async fn drive_redirect(
    provider: &OpenAiCompatibleProvider,
    streamed: bool,
) -> Result<String, ProviderError> {
    let request = ChatRequest::new("redirect-model").with_message(ChatMessage::user("hi"));
    if streamed {
        let mut sink = CollectingSink::new();
        provider
            .stream(request, &mut sink, &context())
            .await
            .map(|response| response.answer_text())
    } else {
        provider
            .complete(request, &context())
            .await
            .map(|response| response.answer_text())
    }
}

/// Replace every spelling of the canary with a marker, so a transcript can be
/// committed without a credential — even a fake one — in it.
fn mask_redirect_canary(text: &str) -> String {
    let mut out = text.to_owned();
    for needle in redirect_canary_needles() {
        out = out.replace(&needle, "<CANARY — MASKED BY THE RECORDER>");
    }
    out
}

async fn case_12(profile: &str, ledger: &mut Vec<Verdict>) {
    let mut doc = Doc::new(
        profile,
        "12-redirect-egress",
        "a 3xx must not carry the request — or the credential — off the configured authority",
        "The round-3 panel's security FAIL. `reqwest`'s cross-host protection strips five \
         headers and none of them is `x-api-key`, `x-goog-api-key` or anything an \
         `Auth::ApiKeyHeader` binding names; `make_referer` keeps the query string. So a \
         redirect from the configured endpoint handed the user's key to a host they never \
         configured, on the first request of a healthy turn.",
    );
    doc.p(
        "  THE SUBJECT IS THE THIRD PARTY, not Vela. Every assertion below is made against\n  \
         what a recording listener on a port the user never configured actually received:\n  \
         accepted connections, raw bytes, and the literal request the client wrote. A\n  \
         credential smuggled in a `Referer`, in a query string, or in a header nobody\n  \
         thought to enumerate is caught the same way, because nothing is enumerated.",
    );
    doc.p(
        "  The canary is masked wherever this file prints received bytes. It is a fake that\n  \
         was never a credential for anything, and the transcript is still committed.",
    );

    // ---- the fixed transport, every binding, both transports ----------------
    doc.h("Vela's shipping transport — every binding, complete() and stream()");
    let mut refused = 0usize;
    let mut third_party_connections = 0usize;
    let mut third_party_bytes = 0usize;
    let mut redirector_hits = 0usize;
    let mut leaked_bindings: Vec<&'static str> = Vec::new();
    let mut error_named_configured_only = 0usize;
    let mut retryable = 0usize;
    let mut canary_in_error: Vec<String> = Vec::new();

    for binding in RedirectBinding::ALL {
        for streamed in [false, true] {
            let third_party = EgressRecorder::start(Answer::Chat).await;
            let redirector = EgressRecorder::start(Answer::Redirect {
                status: 302,
                location: format!("{}/v1/chat/completions", third_party.url),
            })
            .await;

            let provider = redirect_provider(
                binding,
                &redirector.url,
                Arc::new(ReqwestTransport::new().expect("http client builds")),
            );
            let outcome = drive_redirect(&provider, streamed).await;

            redirector_hits += redirector.connections();
            third_party_connections += third_party.connections();
            third_party_bytes += third_party.bytes_received();

            let transcript = third_party.transcript();
            if redirect_canary_needles()
                .iter()
                .any(|needle| transcript.contains(needle.as_str()))
            {
                leaked_bindings.push(binding.label());
            }

            match &outcome {
                Err(error) => {
                    refused += 1;
                    let renderings = renderings_of(error);
                    // B2 INVERTED THIS, on purpose, and the inversion is the
                    // assertion now. See the argument at the check below.
                    let names_configured_only = renderings
                        .iter()
                        .all(|(_, text)| text.contains(&redirector.url))
                        && renderings
                            .iter()
                            .all(|(_, text)| !text.contains(&third_party.url));
                    if names_configured_only {
                        error_named_configured_only += 1;
                    }
                    if error.allows_retry() {
                        retryable += 1;
                    }
                    for (label, text) in &renderings {
                        if redirect_canary_needles()
                            .iter()
                            .any(|needle| text.contains(needle.as_str()))
                        {
                            canary_in_error.push(format!("{} / {label}", binding.label()));
                        }
                    }
                    if binding == RedirectBinding::Query && !streamed {
                        doc.kv(
                            "example error (Display)",
                            mask_redirect_canary(&error.to_string()),
                        );
                    }
                }
                Ok(answer) => {
                    doc.kv(
                        &format!("{} / {}", binding.label(), transport_label(streamed)),
                        format!("FOLLOWED — the turn succeeded with {answer:?}"),
                    );
                }
            }

            doc.kv(
                &format!("{} / {}", binding.label(), transport_label(streamed)),
                format!(
                    "third party: {} connections, {} bytes · redirector: {} connections · {}",
                    third_party.connections(),
                    third_party.bytes_received(),
                    redirector.connections(),
                    match &outcome {
                        Ok(_) => "turn SUCCEEDED".to_owned(),
                        Err(error) =>
                            format!("refused: {}", mask_redirect_canary(&error.to_string())),
                    }
                ),
            );

            third_party.stop();
            redirector.stop();
        }
    }

    let arms = RedirectBinding::ALL.len() * 2;
    doc.h("assertions — the shipping transport");
    doc.check(
        "the configured endpoint really was contacted on every arm — nothing is vacuous",
        redirector_hits >= arms,
        format!("{redirector_hits} connections across {arms} arms"),
    );
    doc.check(
        "THE THIRD PARTY ACCEPTED ZERO CONNECTIONS",
        third_party_connections == 0,
        format!("{third_party_connections} connections"),
    );
    doc.check(
        "THE THIRD PARTY RECEIVED ZERO BYTES — not 'no credential', zero bytes",
        third_party_bytes == 0,
        format!("{third_party_bytes} bytes"),
    );
    doc.check(
        "no spelling of the canary reached the third party, on any binding",
        leaked_bindings.is_empty(),
        if leaked_bindings.is_empty() {
            "none".to_owned()
        } else {
            leaked_bindings.join(", ")
        },
    );
    doc.check(
        "every arm ended in an error rather than a silently-followed hop",
        refused == arms,
        format!("{refused} refused of {arms} arms"),
    );
    // INVERTED IN B2. Round 4 asserted the error named BOTH authorities; B2
    // asserts it names ONE, and never the other. Argued here, not buried:
    //
    // The redirect target is a host **the endpoint chose**. Printing it into
    // an error is the exact shape of the defect four rounds died on — carrying
    // endpoint-controlled text and hoping to launder it — with the extra sting
    // that a hostile endpoint could pick a "hostname" that is really a message
    // to the user. So B2 drops it from the error and keeps it in the local
    // debug log under the correlation id, which is where a user who wants it
    // can deliberately go.
    //
    // This is a diagnostics degradation, and it is recorded as one in
    // docs/regression-baseline/phase-b/TYPED-CLOSED-ERROR-SURFACE.md rather
    // than presented as a pure win.
    doc.check(
        "the error names the CONFIGURED authority and NOT the redirect target, in every \
         rendering — the target is a host the endpoint chose",
        error_named_configured_only == arms,
        format!("{error_named_configured_only} of {arms}"),
    );
    doc.check(
        "a refused redirect is never retried — the same request earns the same Location",
        retryable == 0,
        format!("{retryable} arms reported the failure as retryable"),
    );
    doc.check(
        "no rendering of any refusal carries the credential",
        canary_in_error.is_empty(),
        if canary_in_error.is_empty() {
            "5 renderings × 10 arms clean".to_owned()
        } else {
            canary_in_error.join(", ")
        },
    );

    // ---- the status sweep: nobody had driven anything but 302 ---------------
    doc.h("every redirect status, not just 302 — a sweep nobody had run");
    let mut sweep: Vec<String> = Vec::new();
    let mut sweep_refused = 0usize;
    let mut sweep_third_party_bytes = 0usize;
    for status in [301u16, 302, 303, 307, 308] {
        let third_party = EgressRecorder::start(Answer::Chat).await;
        let redirector = EgressRecorder::start(Answer::Redirect {
            status,
            location: format!("{}/v1/chat/completions", third_party.url),
        })
        .await;
        let provider = redirect_provider(
            RedirectBinding::AnthropicHeader,
            &redirector.url,
            Arc::new(ReqwestTransport::new().expect("http client builds")),
        );
        let outcome = drive_redirect(&provider, false).await;
        sweep_third_party_bytes += third_party.bytes_received();
        if outcome.is_err() {
            sweep_refused += 1;
        }
        sweep.push(format!(
            "{status}: third party {} bytes, {}",
            third_party.bytes_received(),
            if outcome.is_err() {
                "refused"
            } else {
                "FOLLOWED"
            }
        ));
        third_party.stop();
        redirector.stop();
    }
    doc.kv("statuses driven", sweep.join(" · "));
    doc.check(
        "301, 302, 303, 307 and 308 are all refused — 303 rewrites the method, and that \
         changes nothing",
        sweep_refused == 5 && sweep_third_party_bytes == 0,
        format!("{sweep_refused} of 5 refused, third party got {sweep_third_party_bytes} bytes"),
    );

    // ---- same authority: the case the fix deliberately still allows ---------
    doc.h("a same-authority hop — what the implementation chose to do");
    let normaliser = EgressRecorder::start(Answer::RedirectToSelfPath {
        status: 301,
        path: "/v2/chat/completions".into(),
    })
    .await;
    let provider = redirect_provider(
        RedirectBinding::Query,
        &normaliser.url,
        Arc::new(ReqwestTransport::new().expect("http client builds")),
    );
    let same_authority = drive_redirect(&provider, false).await;
    let hops = normaliser.connections();
    let normaliser_transcript = normaliser.transcript();
    let second_hop_path = normaliser_transcript.contains("/v2/chat/completions");
    doc.kv(
        "outcome",
        match &same_authority {
            Ok(answer) => format!("FOLLOWED, answer {answer:?}"),
            Err(error) => format!("refused: {error}"),
        },
    );
    doc.kv("connections to the one authority", hops);
    doc.kv("the second hop's path was requested", second_hop_path);
    doc.check(
        "a redirect to the SAME scheme, host and port is followed — a reverse proxy \
         normalising a path is real and egresses nowhere new",
        same_authority.is_ok() && hops >= 2 && second_hop_path,
        format!(
            "{} hops, second path seen: {second_hop_path}, outcome ok: {}",
            hops,
            same_authority.is_ok()
        ),
    );
    normaliser.stop();

    // ---- the positive control ----------------------------------------------
    doc.h("POSITIVE CONTROL — the same sockets with the policy removed");
    doc.p(
        "  `PreFixTransport` is this transport as it was before the fix: the same client\n  \
         with `no_proxy` and a user agent, and `reqwest`'s untouched redirect and referer\n  \
         defaults. If the canary does not arrive here, the assertions above are vacuous.",
    );
    let mut control_rows: Vec<String> = Vec::new();
    let mut control_leaks = 0usize;
    let mut control_expected = 0usize;
    let mut control_bytes = 0usize;
    let mut control_example = String::new();
    for binding in RedirectBinding::ALL {
        let third_party = EgressRecorder::start(Answer::Chat).await;
        let redirector = EgressRecorder::start(Answer::Redirect {
            status: 302,
            location: format!("{}/v1/chat/completions", third_party.url),
        })
        .await;
        let provider =
            redirect_provider(binding, &redirector.url, Arc::new(PreFixTransport::new()));
        let _ = drive_redirect(&provider, false).await;
        let transcript = third_party.transcript();
        let leaked = redirect_canary_needles()
            .iter()
            .any(|needle| transcript.contains(needle.as_str()));
        if leaked {
            control_leaks += 1;
        }
        if leaked == binding.leaks_without_a_policy() {
            control_expected += 1;
        }
        if leaked && control_example.is_empty() {
            control_example = mask_redirect_canary(&transcript);
        }
        control_bytes += third_party.bytes_received();
        control_rows.push(format!(
            "{}: third party got {} bytes, canary {}",
            binding.label(),
            third_party.bytes_received(),
            if leaked { "ARRIVED" } else { "absent" }
        ));
        third_party.stop();
        redirector.stop();
    }
    for row in &control_rows {
        doc.p(format!("    {row}"));
    }
    doc.h("what the third party received under the control (canary masked)");
    doc.p(indent(&elide(&control_example, 1_400), 4));
    doc.check(
        "CONTROL: with the policy removed the canary DOES reach the third party — so the \
         assertions above are about a real channel",
        control_leaks >= 3,
        format!("{control_leaks} of 5 bindings leaked"),
    );
    doc.check(
        "CONTROL: it leaks for exactly the bindings `reqwest` does not protect — \
         x-api-key, x-goog-api-key and the query string — and not for Bearer",
        control_expected == RedirectBinding::ALL.len(),
        format!("{control_expected} of 5 bindings matched the predicted upstream behaviour"),
    );
    doc.check(
        "CONTROL, AND THE REASON THE FIX REFUSES RATHER THAN STRIPS: even on the bindings \
         upstream DOES protect, the third party still received the request — the prompt, \
         the model id, the tool catalogue. Stripping the credential would have left that.",
        control_bytes > 0,
        format!(
            "{control_bytes} bytes reached the unconfigured host across 5 bindings under the \
             control; {} under the shipping transport",
            third_party_bytes
        ),
    );

    doc.write(ledger);
}

fn transport_label(streamed: bool) -> &'static str {
    if streamed {
        "stream()"
    } else {
        "complete()"
    }
}

// ===========================================================================
// Case 13 — encoding-defeated redaction (round 4)
// ===========================================================================
//
// The round-3 panel's functionality FAIL, and then the ground past it. Round 3
// made the byte scrub structural, and it is byte-LITERAL: it removes the
// spelling it was shown. Round 4's builders made it resolve JSON escapes, so
// `\/`, `\uXXXX`, a surrogate pair and any mixture are one case rather than a
// list. This case drives that, and then drives the spellings **nobody
// briefed**, because every round of this piece has died on a surface the
// previous round's tests did not cover.

const ENCODING_CANARY: &str = "vela+gate/m4-encode-Zx7Tn2q-DO-NOT-LEAK";
const ENCODING_CANARY_CORE: &str = "Zx7Tn2q";
/// Planted in every echoed message, carries no secret, and must therefore
/// survive: it is how this case tells redaction apart from deletion.
const ENCODING_MARKER: &str = "VELA-M4-ENCODING-MARKER";

/// Every spelling of a credential this case drives.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Encoding {
    /// The control. If this is ever not removed, nothing else here means
    /// anything.
    Verbatim,
    /// PHP `json_encode` with default flags. Round 4's reported defect.
    Solidus,
    /// Every character as `\uXXXX`. Briefed.
    UnicodeEscape,
    /// The percent form Vela itself writes into a query string. Briefed.
    PercentUpper,
    /// The same with lowercase hex digits. **Nobody briefed this.**
    PercentLower,
    /// Every byte percent-encoded. **Nobody briefed this.**
    PercentEveryByte,
    /// JSON-escaped twice — an upstream error body embedded in an outer one.
    /// **Nobody briefed this.**
    DoubleSolidus,
    /// `&#x2f;`. **Nobody briefed this**, and nothing in Vela decodes it.
    HtmlEntity,
}

impl Encoding {
    const ALL: [Encoding; 8] = [
        Encoding::Verbatim,
        Encoding::Solidus,
        Encoding::UnicodeEscape,
        Encoding::PercentUpper,
        Encoding::PercentLower,
        Encoding::PercentEveryByte,
        Encoding::DoubleSolidus,
        Encoding::HtmlEntity,
    ];

    fn label(self) -> &'static str {
        match self {
            Encoding::Verbatim => "verbatim (control)",
            Encoding::Solidus => "PHP json_encode: \\/",
            Encoding::UnicodeEscape => "every char as \\uXXXX",
            Encoding::PercentUpper => "percent-encoded, UPPERCASE hex",
            Encoding::PercentLower => "percent-encoded, lowercase hex   [UNBRIEFED]",
            Encoding::PercentEveryByte => "percent-encoded, every byte      [UNBRIEFED]",
            Encoding::DoubleSolidus => "JSON-escaped twice: \\\\/          [UNBRIEFED]",
            Encoding::HtmlEntity => "HTML entities: &#x2f;            [UNBRIEFED]",
        }
    }

    fn briefed(self) -> bool {
        matches!(
            self,
            Encoding::Verbatim
                | Encoding::Solidus
                | Encoding::UnicodeEscape
                | Encoding::PercentUpper
        )
    }

    /// Spell `credential`. The surrounding message is left alone, so the marker
    /// always arrives readable.
    fn spell(self, credential: &str) -> String {
        match self {
            Encoding::Verbatim => credential.to_owned(),
            Encoding::Solidus => credential.replace('/', "\\/"),
            Encoding::UnicodeEscape => credential
                .chars()
                .map(|ch| {
                    let mut buffer = [0u16; 2];
                    ch.encode_utf16(&mut buffer)
                        .iter()
                        .map(|unit| format!("\\u{unit:04x}"))
                        .collect::<String>()
                })
                .collect(),
            Encoding::PercentUpper => vela_providers::redact::percent_encode(credential),
            Encoding::PercentLower => {
                lowercase_percent_hex(&vela_providers::redact::percent_encode(credential))
            }
            Encoding::PercentEveryByte => credential
                .bytes()
                .map(|byte| format!("%{byte:02X}"))
                .collect(),
            Encoding::DoubleSolidus => credential.replace('/', "\\\\/"),
            Encoding::HtmlEntity => credential
                .replace('&', "&amp;")
                .replace('/', "&#x2f;")
                .replace('+', "&#x2b;"),
        }
    }
}

fn lowercase_percent_hex(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '%' && index + 2 < chars.len() {
            out.push('%');
            out.push(chars[index + 1].to_ascii_lowercase());
            out.push(chars[index + 2].to_ascii_lowercase());
            index += 3;
        } else {
            out.push(chars[index]);
            index += 1;
        }
    }
    out
}

fn html_entity_decode(text: &str) -> String {
    text.replace("&#x2f;", "/")
        .replace("&#x2b;", "+")
        .replace("&amp;", "&")
}

/// Every spelling a *reader* of a surface gets the credential from with no work
/// at all: the key itself, the percent form Vela writes on the wire, its
/// lowercase-hex twin, and the stretch of the key no spelling here changes.
fn encoding_readable_needles() -> Vec<String> {
    let percent = vela_providers::redact::percent_encode(ENCODING_CANARY);
    vec![
        ENCODING_CANARY.to_owned(),
        percent.clone(),
        lowercase_percent_hex(&percent),
        ENCODING_CANARY_CORE.to_owned(),
    ]
}

/// Resolve the escapes a JSON decoder resolves, undo percent-encoding, undo
/// HTML entities — repeatedly. If the credential appears after that, whatever
/// reached the surface was the credential in a costume.
fn fully_decoded(text: &str) -> String {
    let mut current = text.to_owned();
    for _ in 0..4 {
        let decoded = html_entity_decode(&percent_decode_bytes(&json_unescape(&current)));
        if decoded == current {
            break;
        }
        current = decoded;
    }
    current
}

fn json_unescape(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < chars.len() {
        if chars[index] != '\\' || index + 1 >= chars.len() {
            out.push(chars[index]);
            index += 1;
            continue;
        }
        match chars[index + 1] {
            '/' => {
                out.push('/');
                index += 2;
            }
            '\\' => {
                out.push('\\');
                index += 2;
            }
            '"' => {
                out.push('"');
                index += 2;
            }
            'u' if index + 5 < chars.len() => {
                let hex: String = chars[index + 2..index + 6].iter().collect();
                match u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                    Some(ch) => {
                        out.push(ch);
                        index += 6;
                    }
                    None => {
                        out.push(chars[index]);
                        index += 1;
                    }
                }
            }
            _ => {
                out.push(chars[index]);
                index += 1;
            }
        }
    }
    out
}

/// A peer that echoes the credential it was sent, spelled a given way, inside a
/// 200 whose SSE stream carries an error object. FINDING 2's exact shape.
struct EncodingPeer {
    url: String,
    task: tokio::task::JoinHandle<()>,
    sent: Arc<Mutex<Vec<u8>>>,
}

impl EncodingPeer {
    async fn start(encoding: Encoding, status: u16) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("loopback bind");
        let address = listener.local_addr().expect("bound");
        let sent: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let sent_by_task = Arc::clone(&sent);
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let mut scratch = vec![0u8; 32768];
                let read = socket.read(&mut scratch).await.unwrap_or(0);
                let raw = String::from_utf8_lossy(&scratch[..read]).into_owned();
                let target = raw
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/")
                    .to_owned();
                let path = target.split('?').next().unwrap_or("/").to_owned();
                let streaming = raw.contains("\"stream\":true");

                // The gateway parses the credential out of wherever it is and
                // DECODES it — raw `/` and all — before deciding it is invalid.
                let credential = header_credential(&raw)
                    .unwrap_or_else(|| decoded_key_of(&target))
                    .to_owned();
                let message = format!(
                    "{ENCODING_MARKER}: rejected credential [{}] for {path}",
                    encoding.spell(&credential)
                );
                let object = format!(
                    "{{\"error\":{{\"code\":\"invalid_api_key\",\
                     \"type\":\"invalid_request_error\",\"message\":\"{message}\"}}}}"
                );
                let (content_type, body) = if streaming && status == 200 {
                    (
                        "text/event-stream",
                        format!("data: {object}\n\ndata: [DONE]\n\n"),
                    )
                } else {
                    ("application/json", object)
                };
                let reason = if status == 200 { "OK" } else { "Bad Request" };
                let payload = format!(
                    "HTTP/1.1 {status} {reason}\r\ncontent-type: {content_type}\r\n\
                     content-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                sent_by_task
                    .lock()
                    .expect("poisoned")
                    .extend_from_slice(payload.as_bytes());
                let _ = socket.write_all(payload.as_bytes()).await;
                let _ = socket.flush().await;
            }
        });
        Self {
            url: format!("http://{address}"),
            task,
            sent,
        }
    }

    fn sent_text(&self) -> String {
        String::from_utf8_lossy(&self.sent.lock().expect("poisoned")).into_owned()
    }

    fn stop(self) {
        self.task.abort();
    }
}

/// The value of any credential-shaped request header, if there is one.
fn header_credential(raw: &str) -> Option<String> {
    for line in raw.split("\r\n").skip(1) {
        if line.is_empty() {
            break;
        }
        let (name, value) = line.split_once(':')?;
        let name = name.trim().to_ascii_lowercase();
        if matches!(
            name.as_str(),
            "authorization" | "x-api-key" | "api-key" | "x-goog-api-key"
        ) {
            return Some(value.trim().trim_start_matches("Bearer ").to_owned());
        }
    }
    None
}

fn encoding_provider(base_url: &str, header_binding: bool) -> OpenAiCompatibleProvider {
    let store = Arc::new(MemoryStore::new());
    let secret = SecretRef::primary("encoding").expect("static id is valid");
    store
        .set(&secret, &SecretValue::new(ENCODING_CANARY))
        .expect("MemoryStore accepts a non-empty value");
    let auth = if header_binding {
        Auth::ApiKeyHeader {
            header: "x-api-key".into(),
            secret,
        }
    } else {
        Auth::ApiKeyQuery {
            param: "key".into(),
            secret,
        }
    };
    OpenAiCompatibleProvider::new(
        ProviderDescriptor::new("encoding", "Encoded canary", ProviderKind::Local)
            .expect("static id is valid"),
        format!("{base_url}/v1"),
        auth,
        store,
        Arc::new(ReqwestTransport::new().expect("http client builds")),
    )
}

/// How one driven arm came out.
struct EncodingOutcome {
    /// The endpoint's own message reached the error at all.
    arrived: bool,
    /// A spelling a reader gets the key from with no work.
    readable: Option<String>,
    /// Not readable, but one pass of ordinary decoding gets back to the key.
    reconstructible: bool,
    /// `<redacted>` is present, so this is redaction rather than deletion.
    redacted_marker: bool,
    /// B2's property, strictly stronger than any needle search: every string in
    /// the error's serde shape that is NOT drawn from Vela's own closed
    /// vocabulary. Empty means no endpoint byte reached the error in any
    /// spelling — so there is no spelling left to try.
    unexplained: Vec<String>,
    example: String,
}

async fn drive_encoding(peer_url: &str, header_binding: bool, streamed: bool) -> EncodingOutcome {
    let provider = encoding_provider(peer_url, header_binding);
    let request = ChatRequest::new("encoding-model").with_message(ChatMessage::user("hi"));
    let mut sink = CollectingSink::new();
    let error = if streamed {
        provider.stream(request, &mut sink, &context()).await.err()
    } else {
        provider.complete(request, &context()).await.err()
    };
    let Some(error) = error else {
        return EncodingOutcome {
            arrived: false,
            readable: None,
            reconstructible: false,
            redacted_marker: false,
            unexplained: Vec::new(),
            example: "the peer's rejection did not produce an error at all".into(),
        };
    };

    let mut surfaces = renderings_of(&error);
    for event in &sink.events {
        surfaces.push((
            "StreamEvent (the sink the UI reads)",
            serde_json::to_string(event).unwrap_or_default(),
        ));
    }

    let mut readable = None;
    let mut reconstructible = false;
    let mut example = String::new();
    for (label, text) in &surfaces {
        if let Some(needle) = encoding_readable_needles()
            .into_iter()
            .find(|needle| text.contains(needle))
        {
            if readable.is_none() {
                readable = Some(format!("{label}: matched {needle:?}"));
                example = text.clone();
            }
        } else if fully_decoded(text).contains(ENCODING_CANARY) {
            reconstructible = true;
            if example.is_empty() {
                example = text.clone();
            }
        }
    }
    if example.is_empty() {
        example = error.to_string();
    }

    EncodingOutcome {
        arrived: error.to_string().contains(ENCODING_MARKER),
        readable,
        reconstructible,
        redacted_marker: surfaces.iter().any(|(_, text)| text.contains("<redacted>")),
        unexplained: vela_providers::diagnostic::unexplained_in_error(&error),
        example,
    }
}

async fn case_13(profile: &str, ledger: &mut Vec<Verdict>) {
    let mut doc = Doc::new(
        profile,
        "13-encoded-credential-leak",
        "a credential the endpoint spells differently is still a credential",
        "Round 3's scrub removes the spelling it was shown. A decoder's whole job is to turn \
         one spelling into another. This case drives the three encodings the round-4 brief \
         names, and then four nobody named — because every round of this piece has died on a \
         surface the previous round's tests did not cover.",
    );
    doc.p(
        "  THE SHAPE DRIVEN IS FINDING 2's: a 200 whose SSE stream carries an\n  \
         `{\"error\":{...}}` object, read frame by frame through `BodyStream::next_chunk` —\n  \
         and, beside it, a 400 read whole. Both bindings: the credential in the query string\n  \
         (percent-encoded on the wire, DECODED by any gateway that parses it) and the\n  \
         credential in an `x-api-key` header (raw, `/` and all).",
    );
    doc.p(
        "  A spelling is judged two ways, and the transcript says which applies:\n  \
           READABLE          the key, or the percent form Vela itself wrote, is in the text\n  \
           RECONSTRUCTIBLE   it is not — but one pass of ordinary decoding gets back to it",
    );

    let mut rows: Vec<String> = Vec::new();
    let mut briefed_clean = 0usize;
    let mut briefed_arms = 0usize;
    let mut unbriefed_leaks: Vec<String> = Vec::new();
    let mut arrived_arms = 0usize;
    let mut total_arms = 0usize;
    let mut premise_ok = 0usize;
    let mut premise_arms = 0usize;
    let mut redaction_not_deletion = 0usize;
    let mut leak_example = String::new();
    let mut peer_sent_marker_arms = 0usize;
    let mut unexplained_arms: Vec<String> = Vec::new();

    for encoding in Encoding::ALL {
        for header_binding in [false, true] {
            for status in [200u16, 400] {
                let peer = EncodingPeer::start(encoding, status).await;
                for streamed in [true, false] {
                    let outcome = drive_encoding(&peer.url, header_binding, streamed).await;
                    total_arms += 1;
                    if outcome.arrived {
                        arrived_arms += 1;
                    }
                    if outcome.redacted_marker {
                        redaction_not_deletion += 1;
                    }
                    if !outcome.unexplained.is_empty() {
                        unexplained_arms.push(format!(
                            "{} · {} · HTTP {status} · {} → {:?}",
                            encoding.label(),
                            if header_binding { "x-api-key" } else { "?key=" },
                            transport_label(streamed),
                            outcome.unexplained
                        ));
                    }
                    let leaked = outcome.readable.is_some() || outcome.reconstructible;
                    if encoding.briefed() {
                        briefed_arms += 1;
                        if !leaked {
                            briefed_clean += 1;
                        }
                    }
                    if leaked {
                        let verdict = match &outcome.readable {
                            Some(where_) => format!("READABLE — {where_}"),
                            None => "RECONSTRUCTIBLE by one decode pass".to_owned(),
                        };
                        let row = format!(
                            "{} · {} · HTTP {status} · {} → {verdict}",
                            encoding.label(),
                            if header_binding { "x-api-key" } else { "?key=" },
                            transport_label(streamed)
                        );
                        if !encoding.briefed() || encoding == Encoding::PercentUpper {
                            unbriefed_leaks.push(row.clone());
                        }
                        rows.push(row);
                        if leak_example.is_empty() {
                            leak_example = outcome.example.clone();
                        }
                    } else {
                        rows.push(format!(
                            "{} · {} · HTTP {status} · {} → clean",
                            encoding.label(),
                            if header_binding { "x-api-key" } else { "?key=" },
                            transport_label(streamed)
                        ));
                    }
                }
                // The premise: for a spelling that is not the literal, the peer
                // must have put NO literal copy on the wire, or the literal pass
                // caught it and the spelling was never exercised.
                let wire = peer.sent_text();
                // B2's premise, which replaces round 4's. Round 4 proved the
                // canary search was not vacuous by showing the endpoint's
                // message REACHED the error. B2 removed that field, so that
                // premise can no longer hold — and the search really is
                // vacuous. The honest replacement is one step upstream: the
                // peer put its message on the SOCKET, and it did not survive
                // the boundary. Same job, asked where the answer still exists.
                if wire.contains(ENCODING_MARKER) {
                    peer_sent_marker_arms += 2; // both transports drove this peer
                }
                if !matches!(encoding, Encoding::Verbatim) && wire.contains(ENCODING_MARKER) {
                    premise_arms += 1;
                    if !wire.contains(ENCODING_CANARY) {
                        premise_ok += 1;
                    }
                }
                peer.stop();
            }
        }
    }

    doc.h("every spelling, both bindings, both response shapes, both transports");
    for row in &rows {
        doc.p(format!("    {row}"));
    }

    doc.h("what a leaking surface actually contains");
    doc.p(indent(&elide(&leak_example, 900), 4));

    doc.h("assertions");
    // INVERTED IN B2, and this is the single most important inversion in the
    // file, so it is argued at length rather than flipped quietly.
    //
    // Round 4 asserted `arrived_arms == total_arms`: the endpoint's message
    // reached the error on every arm, which is what made the canary search
    // below non-vacuous. B2 deleted the field that message arrived in. So the
    // round-4 assertion CANNOT hold any more, and the canary search below is
    // now VACUOUS — there is no endpoint text on the surface for a needle to
    // match, in any spelling.
    //
    // A vacuous test that reads green is a trap, so three things happen here
    // instead of one flip:
    //
    //   1. The vacuity is asserted DIRECTLY — `arrived_arms == 0` — so a
    //      regression that starts carrying endpoint text again turns this red
    //      immediately, before any needle question is asked.
    //   2. The non-vacuity premise moves upstream to a place where it is still
    //      answerable: the peer really did put its marker on the socket.
    //   3. The needle search is kept anyway (below) as regression coverage,
    //      and a strictly stronger assertion is added beside it.
    doc.check(
        "B2's inversion: the endpoint's message reaches the error on NO arm — the field it \
         used to arrive in is gone",
        arrived_arms == 0,
        format!("{arrived_arms} of {total_arms} arms carried the endpoint's own marker"),
    );
    doc.check(
        "and the peers really did send it — the premise moved upstream to the socket, where \
         it is still answerable",
        peer_sent_marker_arms >= total_arms,
        format!(
            "{peer_sent_marker_arms} arm-equivalents saw the marker on the wire, of {total_arms}"
        ),
    );
    doc.check(
        "STRONGEST: no string in any error's serde shape is unexplained by Vela's own closed \
         vocabulary — not 'no credential', NO ENDPOINT TEXT AT ALL",
        unexplained_arms.is_empty(),
        if unexplained_arms.is_empty() {
            format!("{total_arms} arms, 0 unexplained strings")
        } else {
            format!(
                "{} arm(s) carried endpoint-derived text:\n        {}",
                unexplained_arms.len(),
                unexplained_arms.join("\n        ")
            )
        },
    );
    doc.check(
        "the encoding peers put NO literal copy of the credential on the wire — the literal \
         pass genuinely had nothing to match",
        premise_arms > 0 && premise_ok == premise_arms,
        format!("{premise_ok} of {premise_arms} encoded peers"),
    );
    doc.check(
        "the BRIEFED encodings are all removed — verbatim, PHP's \\/, \\uXXXX, and the \
         percent form Vela writes",
        briefed_clean == briefed_arms,
        format!("{briefed_clean} of {briefed_arms} briefed arms clean"),
    );
    // INVERTED IN B2. Round 4 wanted `<redacted>` present, to prove the scrub
    // was masking rather than deleting — a reasonable thing to want when the
    // strategy was "carry the endpoint's text, laundered". B2's strategy is
    // "do not carry it", so a `<redacted>` marker on the ERROR surface would
    // now mean a laundering step had crept back in. The marker still belongs
    // on the URL Vela prints and in the debug log; it does not belong here.
    doc.check(
        "DELETION, not redaction — no `<redacted>` marker on the error surface either, \
         because there is nothing there to mask",
        redaction_not_deletion == 0,
        format!("{redaction_not_deletion} of {total_arms} arms carry the marker"),
    );
    doc.check(
        "NO SPELLING OF THE CREDENTIAL REACHES ANY SURFACE — Display, Debug, the serde JSON \
         that crosses the IPC bridge, or the StreamEvent the UI is handed",
        unbriefed_leaks.is_empty(),
        if unbriefed_leaks.is_empty() {
            format!("{total_arms} arms clean")
        } else {
            format!(
                "{} of {total_arms} arms leaked:\n        {}",
                unbriefed_leaks.len(),
                unbriefed_leaks.join("\n        ")
            )
        },
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
        "GATE M Part 1 (Phase B2) — ASSERTION CONTROLS\n\
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
        // the `detail()` that used to sanitise it did not redact.
        //
        // `detail()` no longer exists — the redesign deleted it — so the string
        // is built directly. That is not a weakening of the control: the string
        // is what the grep must be able to see, and the fact that it can no
        // longer be put *into* an error is asserted by the `compile_fail`
        // doctests on `diagnostic::Diagnosis`.
        let pre_fix = format!("error sending request for url ({})", url.expose());
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

// ===========================================================================
// Case 14 — the intersection of reasoning and tool calling
//
// Four gate rounds drove case 06 (reasoning) and case 02 (tool calling) and
// never drove them together. The round-4 panel's FINDING 3 lived exactly in
// the overlap, and was the highest-severity defect of the run:
//
//   an unterminated <think> block turned deliberation into an EXECUTED tool
//   call, and streamed raw <tool_call> markup to the UI.
//
// Both halves are routine, not exotic. An unterminated <think> is what a small
// local model does when it hits its token budget mid-thought — `hostile` does
// it in case 06. Emulated tool calling is the ONLY way tools work on an
// endpoint that answers `400 tools_not_supported` — `small-local` does that in
// case 02. Nothing put them in the same turn, so nothing saw what happened
// when they met. This case is that turn, permanently.
// ===========================================================================

/// The turn, verbatim from the finding: the model deliberates about a
/// destructive call, DECIDES AGAINST IT, and is cut off before closing the
/// block.
const DELIBERATION: &str = concat!(
    "<think>I could call ",
    "<tool_call>{\"name\":\"delete_everything\",\"arguments\":{\"path\":\"/\"}}</tool_call>",
    " but that would be destructive, so I will not."
);

/// A peer that behaves like `small-local`: it refuses any request carrying
/// `tools` with `400 tools_not_supported`, then answers the retry with
/// [`DELIBERATION`].
///
/// The refusal is load-bearing. Emulation has to be entered the way it is
/// entered in production — because the endpoint said so — or the scenario is a
/// fiction dressed as a gate case.
struct DeliberationPeer {
    url: String,
}

impl DeliberationPeer {
    async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a free port");
        let port = listener.local_addr().expect("bound").port();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut raw = Vec::new();
                    let mut scratch = vec![0u8; 16384];
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

                    let (status, kind, payload) = if body.contains("\"tools\":[{") {
                        (
                            "400 Bad Request",
                            "application/json",
                            "{\"error\":{\"message\":\"this model does not support tools\",\"code\":\"tools_not_supported\",\"type\":\"invalid_request_error\"}}".to_owned(),
                        )
                    } else if body.contains("\"stream\":true") {
                        ("200 OK", "text/event-stream", deliberation_sse())
                    } else {
                        ("200 OK", "application/json", deliberation_json())
                    };
                    let _ = socket
                        .write_all(
                            format!(
                                "HTTP/1.1 {status}\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
                                payload.len()
                            )
                            .as_bytes(),
                        )
                        .await;
                    let _ = socket.flush().await;
                });
            }
        });
        Self {
            url: format!("http://127.0.0.1:{port}"),
        }
    }
}

/// Fragmented eleven characters at a time, so no single frame contains
/// `<think>`, `<tool_call>` or `</tool_call>` whole — MEASURED-3's recorded
/// requirement, applied to the tool-call tag as well.
fn deliberation_sse() -> String {
    let mut out = String::new();
    let chars: Vec<char> = DELIBERATION.chars().collect();
    for piece in chars.chunks(11) {
        let text: String = piece.iter().collect();
        let escaped = serde_json::to_string(&text).expect("a string serialises");
        let _ = write!(
            out,
            "data: {{\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":{escaped}}},\"finish_reason\":null}}]}}\n\n"
        );
    }
    // `length`: the model hit its token budget mid-thought. That is WHY the
    // block never closed, and it is the commonest reason on a small model.
    out.push_str("data: {\"id\":\"c\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"length\"}]}\n\n");
    out.push_str("data: [DONE]\n\n");
    out
}

fn deliberation_json() -> String {
    json!({
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

fn destructive_tool() -> ToolDefinition {
    ToolDefinition::new(
        "delete_everything",
        "Irreversibly delete a directory tree",
        json!({
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"]
        }),
    )
}

async fn case_14(profile: &str, ledger: &mut Vec<Verdict>) {
    let mut doc = Doc::new(
        profile,
        "14-reasoning-meets-tool-calling",
        "deliberation about a call is not a call",
        "The intersection cases 06 and 02 never drove together. An unterminated <think> on a \
         token limit is routine; emulated tool calling is the only way tools work on a runtime \
         that refuses a `tools` array. Together they turned a model REFUSING to run \
         `delete_everything` into a turn that would have run it.",
    );
    doc.p("  THE TURN, verbatim from the round-4 panel:\n    \
         <think>I could call <tool_call>{\"name\":\"delete_everything\",\n    \
         \"arguments\":{\"path\":\"/\"}}</tool_call> but that would be destructive,\n    \
         so I will not.\n  \
         — and the stream ends there. The block never closes.");
    doc.p(
        "  THE PEER answers `400 tools_not_supported` to any request carrying `tools`,\n  \
         exactly as `small-local` does (FINDING 6), so emulation is entered the way it\n  \
         is entered in production rather than by a test flag.",
    );

    for streamed in [true, false] {
        let peer = DeliberationPeer::start().await;
        let log = WireLog::default();
        let provider = provider_for(&peer.url, &log);
        let request = ChatRequest::new(model_of(profile))
            .with_message(ChatMessage::user("tidy up the disk"))
            .with_tools([destructive_tool()])
            .with_tool_choice(ToolChoice::Auto);

        let mut sink = CollectingSink::new();
        let outcome = if streamed {
            provider.stream(request, &mut sink, &context()).await
        } else {
            provider.complete(request, &context()).await
        };
        let entries = log.drain();
        let transport = if streamed { "streamed" } else { "non-streamed" };

        doc.h(&format!("{transport} — the raw exchange"));
        doc.wire(&entries);

        let response = match outcome {
            Ok(response) => response,
            Err(error) => {
                doc.check(
                    &format!("{transport}: the turn completes"),
                    false,
                    format!("{error:?}"),
                );
                continue;
            }
        };

        doc.h(&format!("{transport} — what Vela produced"));
        doc.kv("answer", format!("{:?}", response.answer_text()));
        doc.kv("reasoning", format!("{:?}", response.reasoning_text()));
        doc.kv("tool calls", describe_calls(&response.tool_calls));
        doc.kv("stop reason", format!("{:?}", response.stop_reason));
        doc.kv(
            "degradations",
            describe_degradations(&response.degradations),
        );
        if streamed {
            doc.kv("TextDelta events", format!("{:?}", sink.text()));
        } else {
            doc.p("  (`complete` sinks its events into a NullSink by construction — there is no");
            doc.p("  user-visible delta stream on this transport to inspect.)");
        }

        doc.h(&format!("{transport} — assertions"));

        // The premise. Everything below is worthless without it.
        doc.check(
            &format!("{transport}: emulation was entered through the endpoint's own 400"),
            response
                .degradations
                .iter()
                .any(|degradation| matches!(degradation, Degradation::ToolCallingEmulated { .. })),
            describe_degradations(&response.degradations),
        );
        doc.check(
            &format!("{transport}: the reasoning block really never closed"),
            response.degradations.iter().any(|degradation| {
                matches!(degradation, Degradation::UnterminatedReasoning { .. })
            }),
            describe_degradations(&response.degradations),
        );

        // The claim.
        let executable: Vec<&ToolCallOutcome> = response
            .tool_calls
            .iter()
            .filter(|call| call.is_ok())
            .collect();
        doc.check(
            &format!("{transport}: a call recovered from a never-closed <think> is NOT executable"),
            executable.is_empty(),
            describe_calls(&response.tool_calls),
        );
        doc.check(
            &format!("{transport}: the turn does not end in ToolUse"),
            response.stop_reason != StopReason::ToolUse,
            format!("{:?}", response.stop_reason),
        );
        doc.check(
            &format!("{transport}: the refusal is REPORTED, not silently dropped"),
            response.tool_calls.iter().any(|call| {
                matches!(
                    call,
                    ToolCallOutcome::Malformed {
                        reason: MalformedToolCall::RecoveredFromUnterminatedReasoning,
                        ..
                    }
                )
            }) && response
                .degradations
                .iter()
                .any(|d| matches!(d, Degradation::MalformedToolCalls { .. })),
            describe_calls(&response.tool_calls),
        );
        doc.check(
            &format!("{transport}: no raw tool-call markup in the answer"),
            !response.answer_text().contains("<tool_call>")
                && !response.answer_text().contains("</tool_call>")
                && !response.answer_text().contains("delete_everything"),
            format!("{:?}", response.answer_text()),
        );
        if streamed {
            doc.check(
                "streamed: no raw tool-call markup on any TextDelta",
                !sink.text().contains("<tool_call>") && !sink.text().contains("delete_everything"),
                format!("{:?}", sink.text()),
            );
        }
        doc.check(
            &format!("{transport}: MEASURED-3 still holds — the answer is not swallowed"),
            response
                .answer_text()
                .contains("but that would be destructive, so I will not."),
            format!("{:?}", response.answer_text()),
        );
        doc.check(
            &format!("{transport}: the deliberation is kept as reasoning"),
            response.reasoning_text().contains("I could call"),
            format!("{:?}", elide(&response.reasoning_text(), 200)),
        );
    }

    doc.write(ledger);
}

// ===========================================================================
// PHASE B2 — CROSS PRODUCTS. Shared apparatus.
// ===========================================================================
//
// Four gate rounds drove the matrix CASE BY CASE. Every case was driven; every
// PAIR of cases was not. FINDING 3 — the highest-severity defect of the whole
// run — lived in the pair (06 reasoning, 02 tools), and survived four rounds
// because nothing ever put them in the same turn.
//
// The lesson is not "add case 14". It is that a matrix of independent cases has
// a blind spot the size of its own cross product, and the blind spot is where
// the next defect is. Everything from here down drives PAIRS.
//
// It also drives all THREE adapters. Cases 00–14 drive `OpenAiCompatible` and
// nothing else, so every property they establish is a property of one adapter.
// `Anthropic` and `Google` reach the same shared normalisation — `answer.rs`,
// `reasoning.rs`, `tool_accum.rs` — by three different routes, and a fix
// installed on one route is not evidence about the other two.

/// What a [`CrossPeer`] answers with.
struct Reply {
    status: u16,
    content_type: &'static str,
    body: String,
    /// Write this many bytes, then go quiet for this long. The shape a user
    /// meets when they press stop while the model is still emitting.
    stall: Option<(usize, Duration)>,
}

impl Reply {
    fn json(status: u16, body: impl Into<String>) -> Self {
        Self {
            status,
            content_type: "application/json",
            body: body.into(),
            stall: None,
        }
    }

    fn sse(body: impl Into<String>) -> Self {
        Self {
            status: 200,
            content_type: "text/event-stream",
            body: body.into(),
            stall: None,
        }
    }

    fn stalling_after(mut self, bytes: usize, quiet: Duration) -> Self {
        self.stall = Some((bytes, quiet));
        self
    }
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Status",
    }
}

type PeerScript = Arc<dyn Fn(&str, &str) -> Reply + Send + Sync>;

/// A loopback peer whose every answer is a pure function of the request it
/// received — real TCP, real HTTP, one OS socket per exchange.
///
/// The four matrix profiles are Node processes speaking one dialect. These
/// cases need three dialects and need to answer differently depending on what
/// the request carried (a tool catalogue, a schema, a particular user turn), so
/// they get a peer that is a closure.
struct CrossPeer {
    url: String,
    seen: Arc<Mutex<Vec<(String, String)>>>,
    task: tokio::task::JoinHandle<()>,
}

impl CrossPeer {
    async fn start(script: PeerScript) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a free port");
        let port = listener.local_addr().expect("bound").port();
        let seen: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let seen_task = Arc::clone(&seen);
        let task = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let script = Arc::clone(&script);
                let seen = Arc::clone(&seen_task);
                tokio::spawn(async move {
                    let mut raw = Vec::new();
                    let mut scratch = vec![0u8; 16384];
                    let (head_end, length, target) = loop {
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
                            let target = text
                                .lines()
                                .next()
                                .unwrap_or_default()
                                .split_whitespace()
                                .nth(1)
                                .unwrap_or("/")
                                .to_owned();
                            if raw.len() >= at + 4 + length {
                                break (at + 4, length, target);
                            }
                        }
                    };
                    let body =
                        String::from_utf8_lossy(&raw[head_end..head_end + length]).into_owned();
                    seen.lock()
                        .expect("peer log poisoned")
                        .push((target.clone(), body.clone()));
                    let reply = script(&target, &body);
                    let head = format!(
                        "HTTP/1.1 {} {}\r\ncontent-type: {}\r\ncontent-length: {}\r\n\
                         connection: close\r\n\r\n",
                        reply.status,
                        reason_phrase(reply.status),
                        reply.content_type,
                        reply.body.len()
                    );
                    let _ = socket.write_all(head.as_bytes()).await;
                    match reply.stall {
                        None => {
                            let _ = socket.write_all(reply.body.as_bytes()).await;
                            let _ = socket.flush().await;
                        }
                        Some((at, quiet)) => {
                            let bytes = reply.body.as_bytes();
                            let at = at.min(bytes.len());
                            let _ = socket.write_all(&bytes[..at]).await;
                            let _ = socket.flush().await;
                            tokio::time::sleep(quiet).await;
                            let _ = socket.write_all(&bytes[at..]).await;
                            let _ = socket.flush().await;
                        }
                    }
                });
            }
        });
        Self {
            url: format!("http://127.0.0.1:{port}"),
            seen,
            task,
        }
    }

    fn requests(&self) -> Vec<(String, String)> {
        self.seen.lock().expect("peer log poisoned").clone()
    }

    fn stop(self) {
        self.task.abort();
    }
}

/// The three adapters Vela ships. Every cross product below is driven through
/// all three unless the adapter makes the shape structurally unreachable — in
/// which case that fact is asserted instead of faked.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
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

    fn provider(self, base_url: &str, log: &WireLog) -> Arc<dyn Provider> {
        let transport: Arc<dyn HttpTransport> = Arc::new(RecordingTransport::new(log.clone()));
        let secrets = Arc::new(MemoryStore::new());
        let descriptor = ProviderDescriptor::new(
            format!("cross-{}", self.label()),
            format!("Cross-product peer ({})", self.label()),
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
            Adapter::Anthropic => Arc::new(vela_providers::AnthropicProvider::new(
                descriptor,
                base_url.to_owned(),
                Auth::None,
                secrets,
                transport,
            )),
            Adapter::Google => Arc::new(vela_providers::GoogleProvider::new(
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
    /// which is WHY a reasoning block never closed and is therefore part of the
    /// scenario, not decoration.
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
                "{{\"id\":\"msg_cross\",\"type\":\"message\",\"role\":\"assistant\",\
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

    /// An SSE body delivering `text` in `chunk`-character pieces.
    ///
    /// The chunking is load-bearing and is MEASURED-3's recorded requirement:
    /// no single frame may contain `<think>`, `<tool_call>` or `</tool_call>`
    /// whole, so a frame-local stripper cannot pass by accident.
    fn streamed(self, text: &str, chunk: usize) -> String {
        let pieces: Vec<String> = text
            .chars()
            .collect::<Vec<char>>()
            .chunks(chunk)
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

    /// This dialect's error envelope, carrying `message` verbatim.
    fn error_body(self, message: &str) -> String {
        let escaped = serde_json::to_string(message).expect("a string serialises");
        match self {
            Adapter::Compat => format!(
                "{{\"error\":{{\"message\":{escaped},\"type\":\"invalid_request_error\",\
                 \"code\":\"cross_probe\"}}}}"
            ),
            Adapter::Anthropic => format!(
                "{{\"type\":\"error\",\"error\":{{\"type\":\"invalid_request_error\",\
                 \"message\":{escaped}}}}}"
            ),
            Adapter::Google => format!(
                "{{\"error\":{{\"code\":400,\"message\":{escaped},\"status\":\"INVALID_ARGUMENT\"}}}}"
            ),
        }
    }

    /// Does this request body carry a NATIVE tool catalogue? The emulated one
    /// is prose in a system message and must not match.
    fn carries_tools(self, body: &str) -> bool {
        match self {
            Adapter::Compat | Adapter::Anthropic => body.contains("\"tools\":[{"),
            Adapter::Google => body.contains("functionDeclarations"),
        }
    }

    /// The refusal that means "this model has no tool calling" in this dialect,
    /// worded so the adapter's own recogniser classifies it as a capability
    /// refusal rather than a mistake. This is how emulation is entered in
    /// production; a test flag would make every assertion below a fiction.
    fn tools_refusal(self) -> Reply {
        match self {
            Adapter::Compat => Reply::json(
                400,
                "{\"error\":{\"message\":\"this model does not support tools\",\
                 \"code\":\"tools_not_supported\",\"type\":\"invalid_request_error\"}}",
            ),
            Adapter::Anthropic => Reply::json(
                400,
                self.error_body("tool use is not supported by this model"),
            ),
            Adapter::Google => Reply::json(
                400,
                self.error_body(
                    "Function calling is not supported for this model. \
                     functionDeclarations was rejected.",
                ),
            ),
        }
    }

    /// A minimal model listing, so `probe_capabilities` gets past step 1.
    fn model_list(self) -> String {
        match self {
            Adapter::Compat => format!(
                "{{\"object\":\"list\",\"data\":[{{\"id\":\"{}\",\"object\":\"model\"}}]}}",
                self.model()
            ),
            Adapter::Anthropic => format!(
                "{{\"data\":[{{\"id\":\"{}\",\"type\":\"model\",\
                 \"display_name\":\"Cross\"}}],\"has_more\":false}}",
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

    /// Did the caller ask for a stream? Each dialect says so differently, and
    /// the Gemini one says it in the URL rather than the body.
    fn wants_stream(self, path: &str, body: &str) -> bool {
        match self {
            Adapter::Compat | Adapter::Anthropic => body.contains("\"stream\":true"),
            Adapter::Google => path.contains("streamGenerateContent"),
        }
    }
}

// ===========================================================================
// Case 15 — REASONING x TOOLS, on every adapter, both transports
// ===========================================================================
//
// Case 14 drove FINDING 3's turn on ONE adapter. The finding was never a
// property of the OpenAI-compatible adapter: `<think>` handling lives in
// `reasoning.rs`, the answer channel in `answer.rs`, and all three adapters
// route text through both. A fix verified on one route is not evidence about
// the other two, and the three routes differ in ways that matter:
//
//   openai-compatible  emulation entered by RETRY after the endpoint's own 400
//   google             emulation entered because a PROBE learned the model has
//                      no function calling — a different code path, in a
//                      different file, reaching the same shared normaliser
//   anthropic          emulation is STRUCTURALLY UNREACHABLE, and this case
//                      asserts that rather than pretending otherwise
//
// The turn is FINDING 3's, verbatim, on all three.

/// The script every adapter's peer runs in this case. It refuses a native tool
/// catalogue the way a runtime without tool calling does, answers the
/// deliberation turn with the never-closed block, and answers everything else
/// (the probe's plain, vision and schema turns) blandly.
fn deliberation_script(adapter: Adapter) -> PeerScript {
    Arc::new(move |path: &str, body: &str| {
        if adapter.is_model_list(path) {
            return Reply::json(200, adapter.model_list());
        }
        if adapter.carries_tools(body) {
            return adapter.tools_refusal();
        }
        let streamed = adapter.wants_stream(path, body);
        // `delete_everything` reaches the body only through the EMULATED
        // catalogue — the native one was refused above — so this is also the
        // proof that emulation is what is being driven.
        let deliberating = body.contains("tidy up the disk");
        let text = if deliberating { DELIBERATION } else { "OK." };
        if streamed {
            Reply::sse(adapter.streamed(text, 11))
        } else {
            Reply::json(200, adapter.whole(text))
        }
    })
}

async fn case_15(profile: &str, ledger: &mut Vec<Verdict>) {
    let mut doc = Doc::new_with(
        profile,
        "15-reasoning-x-tools-every-adapter",
        "deliberation is not a call — on all three adapters, both transports",
        "FINDING 3 was closed and verified on ONE adapter. The defect lived in shared \
         normalisation that all three adapters reach by three different routes. This case \
         drives the identical turn down all three.",
        "all three shipping adapters — OpenAiCompatibleProvider, AnthropicProvider, GoogleProvider",
        "one purpose-built loopback peer per adapter, real TCP, speaking that adapter's dialect",
    );
    doc.p(
        "  THE TURN, verbatim from the round-4 panel and identical to case 14:\n    \
         <think>I could call <tool_call>{\"name\":\"delete_everything\",\n    \
         \"arguments\":{\"path\":\"/\"}}</tool_call> but that would be destructive,\n    \
         so I will not.\n  \
         — and the stream ends there, on `length`. The block never closes.",
    );
    doc.p(
        "  HOW EMULATION IS ENTERED, per adapter — this is the part a test flag would have\n  \
         faked, and the part that makes the case real:",
    );

    for adapter in Adapter::ALL {
        for streamed in [true, false] {
            let peer = CrossPeer::start(deliberation_script(adapter)).await;
            let log = WireLog::default();
            let provider = adapter.provider(&peer.url, &log);
            let transport = transport_label(streamed);
            let arm = format!("{} / {transport}", adapter.label());

            // The probe is the production route into emulation on Gemini, and
            // the production route into the documented REFUSAL on Messages. On
            // the OpenAI-compatible adapter the production route is the retry
            // after the endpoint's own 400, so that one is left unprobed — the
            // three arms deliberately differ, because the three code paths do.
            let probed = if adapter == Adapter::Compat {
                None
            } else {
                Some(
                    provider
                        .probe_capabilities(adapter.model(), &context())
                        .await,
                )
            };
            let probe_note = match &probed {
                None => {
                    "not probed — emulation is entered by retry after the endpoint's 400".to_owned()
                }
                Some(Ok(capabilities)) => {
                    format!("probed: tool_calling = {:?}", capabilities.tool_calling)
                }
                Some(Err(error)) => format!("probe failed: {}", error.code()),
            };
            let _ = log.drain();

            let request = ChatRequest::new(adapter.model())
                .with_message(ChatMessage::user("tidy up the disk"))
                .with_tools([destructive_tool()])
                .with_tool_choice(ToolChoice::Auto);
            let mut sink = CollectingSink::new();
            let outcome = if streamed {
                provider.stream(request, &mut sink, &context()).await
            } else {
                provider.complete(request, &context()).await
            };
            let entries = log.drain();

            doc.h(&format!("{arm} — the raw exchange"));
            doc.kv("route into emulation", &probe_note);
            doc.wire(&entries);

            // ---- the Anthropic arm: a refusal, and why that is the right
            //      answer rather than a gap in coverage ----------------------
            if adapter == Adapter::Anthropic {
                doc.h(&format!("{arm} — what Vela produced"));
                doc.kv("outcome", format!("{outcome:?}"));
                doc.p(
                    "  This adapter REFUSES rather than emulating, and says so in its own source:\n  \
                     \"This backend has native tool calling on every model that serves it, so a\n  \
                     probed refusal means the affordance genuinely is not there. Refusing is\n  \
                     truthful; rewriting the request into prompt emulation behind the user's\n  \
                     back would not be.\"\n  \
                     So the FINDING 3 shape is not merely untested here — it is UNREACHABLE, and\n  \
                     the honest thing to record is that, not a manufactured pass.",
                );
                doc.check(
                    &format!("{arm}: the turn is refused, not silently emulated"),
                    matches!(
                        &outcome,
                        Err(ProviderError::CapabilityUnsupported {
                            capability: Capability::ToolCalling,
                            ..
                        })
                    ),
                    format!("{outcome:?}"),
                );
                doc.check(
                    &format!(
                        "{arm}: NO UNSUPPORTED AFFORDANCE IS OFFERED — the refusal is not \
                         retried or failed over into one"
                    ),
                    outcome
                        .as_ref()
                        .err()
                        .is_some_and(|error| !error.allows_retry() && !error.allows_failover()),
                    format!("{outcome:?}"),
                );
                doc.check(
                    &format!("{arm}: no tool-call markup reached the UI on the way to refusing"),
                    !sink.text().contains("<tool_call>")
                        && !sink.text().contains("delete_everything"),
                    format!("{:?}", sink.text()),
                );
                doc.check(
                    &format!(
                        "{arm}: emulation is structurally unreachable here — no \
                         `with_tool_emulation` call site exists on this adapter"
                    ),
                    !std::fs::read_to_string(
                        repo_root().join("src-tauri/crates/vela-providers/src/anthropic/stream.rs"),
                    )
                    .unwrap_or_default()
                    .contains("with_tool_emulation")
                        && !std::fs::read_to_string(
                            repo_root()
                                .join("src-tauri/crates/vela-providers/src/anthropic/provider.rs"),
                        )
                        .unwrap_or_default()
                        .contains("with_tool_emulation"),
                    "grepped anthropic/stream.rs and anthropic/provider.rs".to_owned(),
                );
                peer.stop();
                continue;
            }

            // ---- the two adapters that DO emulate --------------------------
            let response = match outcome {
                Ok(response) => response,
                Err(error) => {
                    doc.check(
                        &format!("{arm}: the turn completes"),
                        false,
                        format!("{error:?}"),
                    );
                    peer.stop();
                    continue;
                }
            };

            doc.h(&format!("{arm} — what Vela produced"));
            doc.kv("answer", format!("{:?}", response.answer_text()));
            doc.kv(
                "reasoning",
                format!("{:?}", elide(&response.reasoning_text(), 240)),
            );
            doc.kv("tool calls", describe_calls(&response.tool_calls));
            doc.kv("stop reason", format!("{:?}", response.stop_reason));
            doc.kv(
                "degradations",
                describe_degradations(&response.degradations),
            );
            if streamed {
                doc.kv("TextDelta events", format!("{:?}", sink.text()));
            }

            doc.h(&format!("{arm} — assertions"));

            // The premises. Everything below is worthless without them.
            doc.check(
                &format!("{arm}: emulation was entered through the endpoint's own refusal"),
                response.degradations.iter().any(|degradation| {
                    matches!(degradation, Degradation::ToolCallingEmulated { .. })
                }),
                describe_degradations(&response.degradations),
            );
            doc.check(
                &format!("{arm}: the reasoning block really never closed"),
                response.degradations.iter().any(|degradation| {
                    matches!(degradation, Degradation::UnterminatedReasoning { .. })
                }),
                describe_degradations(&response.degradations),
            );
            doc.check(
                &format!(
                    "{arm}: the endpoint really was asked in the EMULATED shape — the \
                     catalogue was prose, not a `tools` array"
                ),
                peer.requests().iter().any(|(_, body)| {
                    body.contains("delete_everything") && !adapter.carries_tools(body)
                }),
                format!("{} request(s) recorded by the peer", peer.requests().len()),
            );

            // THE CLAIM.
            let executable: Vec<&ToolCallOutcome> = response
                .tool_calls
                .iter()
                .filter(|call| call.is_ok())
                .collect();
            doc.check(
                &format!("{arm}: A CALL RECOVERED FROM A NEVER-CLOSED <think> IS NOT EXECUTABLE"),
                executable.is_empty(),
                describe_calls(&response.tool_calls),
            );
            doc.check(
                &format!("{arm}: the turn does not end in ToolUse"),
                response.stop_reason != StopReason::ToolUse,
                format!("{:?}", response.stop_reason),
            );
            doc.check(
                &format!("{arm}: the refusal is REPORTED, not silently dropped"),
                response.tool_calls.iter().any(|call| {
                    matches!(
                        call,
                        ToolCallOutcome::Malformed {
                            reason: MalformedToolCall::RecoveredFromUnterminatedReasoning,
                            ..
                        }
                    )
                }),
                describe_calls(&response.tool_calls),
            );
            doc.check(
                &format!("{arm}: no raw tool-call markup in the answer"),
                !response.answer_text().contains("<tool_call>")
                    && !response.answer_text().contains("</tool_call>")
                    && !response.answer_text().contains("delete_everything"),
                format!("{:?}", response.answer_text()),
            );
            if streamed {
                doc.check(
                    &format!("{arm}: no raw tool-call markup on any TextDelta"),
                    !sink.text().contains("<tool_call>")
                        && !sink.text().contains("delete_everything"),
                    format!("{:?}", sink.text()),
                );
            }
            doc.check(
                &format!("{arm}: MEASURED-3 still holds — the answer is not swallowed"),
                response
                    .answer_text()
                    .contains("but that would be destructive, so I will not."),
                format!("{:?}", response.answer_text()),
            );
            doc.check(
                &format!("{arm}: the deliberation is kept as reasoning"),
                response.reasoning_text().contains("I could call"),
                format!("{:?}", elide(&response.reasoning_text(), 200)),
            );

            peer.stop();
        }
    }

    doc.write(ledger);
}

// ===========================================================================
// Case 16 — REASONING x STRUCTURED OUTPUT
// ===========================================================================
//
// The same intersection logic that found FINDING 3, pointed at a different
// pair. Case 06 drives an unterminated `<think>`. Case 04 drives a schema. Put
// them in one turn and a specific, nasty thing becomes possible:
//
//   MEASURED-3 says the salvaged text of a never-closed block is SHOWN, because
//   hiding it would be a lie about what came back. `structured::extract_json`
//   says "the first balanced object in the text" is the answer. A model that
//   deliberates in JSON — which is exactly what a model asked for JSON does —
//   therefore has a route by which a value it CONSIDERED AND REJECTED is
//   validated against the schema and handed to the caller as conforming.
//
// That is FINDING 3's shape in the data channel rather than the action channel:
// deliberation becoming an answer instead of deliberation becoming a call. It
// is the same severity, because a caller that receives `Ok(value)` from a
// schema-validated field has been told the model produced it.

/// The turn: the model deliberates *in JSON*, rejects the value it wrote, and
/// is cut off before closing the block. Both halves are what a model asked for
/// JSON actually does.
const DELIBERATED_JSON: &str = concat!(
    "<think>The user wants an object. My first guess is ",
    "{\"city\":\"Atlantis\",\"celsius\":-273.15}",
    " — no, that city does not exist and that temperature is below absolute zero, so I must"
);

fn weather_schema() -> Value {
    json!({
        "type": "object",
        "properties": {"city": {"type": "string"}, "celsius": {"type": "number"}},
        "required": ["city", "celsius"]
    })
}

/// The SAME deliberation with the block CLOSED, and one sentence of real answer
/// after it. This is the control arm, and it is the whole reason the case can
/// name its own cause: the two arms differ by four characters — `</think>` —
/// and by nothing else.
const TERMINATED_JSON: &str = concat!(
    "<think>The user wants an object. My first guess is ",
    "{\"city\":\"Atlantis\",\"celsius\":-273.15}",
    " — no, that city does not exist and that temperature is below absolute zero, so I must",
    "</think>",
    "I could not find a real value for that."
);

fn structured_script(adapter: Adapter, text: &'static str) -> PeerScript {
    Arc::new(move |path: &str, body: &str| {
        if adapter.is_model_list(path) {
            return Reply::json(200, adapter.model_list());
        }
        if adapter.wants_stream(path, body) {
            Reply::sse(adapter.streamed(text, 13))
        } else {
            Reply::json(200, adapter.whole(text))
        }
    })
}

async fn case_16(profile: &str, ledger: &mut Vec<Verdict>) {
    let mut doc = Doc::new_with(
        profile,
        "16-reasoning-x-structured-output",
        "a value the model rejected must not come back as a validated answer",
        "Case 06 and case 04 were never driven in one turn. In one turn, a model that \
         deliberates in JSON and is cut off mid-thought has a route by which the value it \
         REJECTED is extracted, validated against the schema, and returned as conforming.",
        "all three shipping adapters, with `ResponseFormat::JsonSchema` requested",
        "one purpose-built loopback peer per adapter, real TCP",
    );
    doc.p("  THE TURN:\n    \
         <think>The user wants an object. My first guess is\n    \
         {\"city\":\"Atlantis\",\"celsius\":-273.15} — no, that city does not exist and\n    \
         that temperature is below absolute zero, so I must\n  \
         — and the stream ends there. The block never closes.");
    doc.p(
        "  `{\"city\":\"Atlantis\",\"celsius\":-273.15}` VALIDATES against the requested schema.\n  \
         It is a well-formed object with both required properties of the right types. The\n  \
         only thing wrong with it is that the model said it was wrong — which is a fact\n  \
         that lives in the prose around it, not in the JSON.",
    );

    for adapter in Adapter::ALL {
        for streamed in [true, false] {
            let peer = CrossPeer::start(structured_script(adapter, DELIBERATED_JSON)).await;
            let log = WireLog::default();
            let provider = adapter.provider(&peer.url, &log);
            let transport = transport_label(streamed);
            let arm = format!("{} / {transport}", adapter.label());

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
            let entries = log.drain();

            doc.h(&format!("{arm} — the raw exchange"));
            doc.wire(&entries);

            let response = match outcome {
                Ok(response) => response,
                Err(error) => {
                    doc.check(
                        &format!("{arm}: the turn completes"),
                        false,
                        format!("{error:?}"),
                    );
                    peer.stop();
                    continue;
                }
            };

            doc.h(&format!("{arm} — what Vela produced"));
            doc.kv(
                "answer",
                format!("{:?}", elide(&response.answer_text(), 260)),
            );
            doc.kv(
                "reasoning",
                format!("{:?}", elide(&response.reasoning_text(), 260)),
            );
            doc.kv("STRUCTURED VERDICT", format!("{:?}", response.structured));
            doc.kv(
                "degradations",
                describe_degradations(&response.degradations),
            );

            doc.h(&format!("{arm} — assertions"));

            // The premises.
            doc.check(
                &format!("{arm}: the reasoning block really never closed"),
                response.degradations.iter().any(|degradation| {
                    matches!(degradation, Degradation::UnterminatedReasoning { .. })
                }),
                describe_degradations(&response.degradations),
            );
            doc.check(
                &format!("{arm}: a schema really was requested, so there is a verdict at all"),
                response.structured.is_some(),
                format!("{:?}", response.structured),
            );

            // THE CLAIM.
            let rejected = json!({"city": "Atlantis", "celsius": -273.15});
            let handed_back_as_conforming =
                matches!(&response.structured, Some(Ok(value)) if *value == rejected);
            doc.check(
                &format!(
                    "{arm}: THE REJECTED VALUE IS NOT HANDED BACK AS A CONFORMING \
                     STRUCTURED ANSWER"
                ),
                !handed_back_as_conforming,
                format!("{:?}", response.structured),
            );
            doc.check(
                &format!(
                    "{arm}: a caller cannot read the structured field without meeting the \
                     unterminated-reasoning fact — either the verdict is an Err, or the \
                     degradation is on the response"
                ),
                matches!(&response.structured, Some(Err(_)))
                    || response.degradations.iter().any(|degradation| {
                        matches!(degradation, Degradation::UnterminatedReasoning { .. })
                    }),
                format!(
                    "{:?} / {}",
                    response.structured,
                    describe_degradations(&response.degradations)
                ),
            );
            doc.check(
                &format!("{arm}: MEASURED-3 still holds — the salvaged prose is not swallowed"),
                response.answer_text().contains("does not exist"),
                format!("{:?}", elide(&response.answer_text(), 200)),
            );

            peer.stop();
        }
    }

    // ---- the in-case control -------------------------------------------
    //
    // The claim above is only worth something if the same peer, differing by
    // the eight characters `</think>` and nothing else, produces the RIGHT
    // answer. If both arms behaved identically the case would be measuring the
    // schema, or the model, or the adapter — not the intersection.
    doc.h("CONTROL — the identical deliberation with the block CLOSED");
    doc.p(
        "  Same peer, same schema, same transports, same three adapters. The only difference\n  \
         is `</think>` before the final sentence. If the verdict changes, the cause is the\n  \
         intersection and nothing else.",
    );
    for adapter in Adapter::ALL {
        for streamed in [true, false] {
            let peer = CrossPeer::start(structured_script(adapter, TERMINATED_JSON)).await;
            let log = WireLog::default();
            let provider = adapter.provider(&peer.url, &log);
            let arm = format!("{} / {}", adapter.label(), transport_label(streamed));
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
            let _ = log.drain();
            match outcome {
                Ok(response) => {
                    doc.kv(
                        &format!("{arm} verdict"),
                        format!("{:?}", response.structured),
                    );
                    doc.check(
                        &format!(
                            "{arm} CONTROL: with the block closed, the deliberated value does \
                             NOT come back — the cause is the intersection"
                        ),
                        !matches!(
                            &response.structured,
                            Some(Ok(value)) if *value == json!({"city": "Atlantis", "celsius": -273.15})
                        ),
                        format!("{:?}", response.structured),
                    );
                }
                Err(error) => doc.check(
                    &format!("{arm} CONTROL: the turn completes"),
                    false,
                    format!("{error:?}"),
                ),
            }
            peer.stop();
        }
    }

    doc.write(ledger);
}

// ===========================================================================
// Case 17 — TOOLS x MALFORMED FRAMES
// ===========================================================================
//
// Case 02p drives parallel tool calls down a clean stream. Case 08 drives junk
// frames down a stream carrying prose. Neither drives junk frames THROUGH a
// batch of parallel calls, and that pair is where two recorded requirements
// collide:
//
//   MEASURED-2  a malformed frame is SKIPPED, never fatal, and prior content is
//               kept.
//   MEASURED-4  tool-call deltas are lossy if keyed naively; `index` is the
//               only join key, and it is the thing a skipped frame removes.
//
// "Skip the frame and keep going" and "the join key lives in the frames" are
// individually right and jointly dangerous: a skipped frame can silently move a
// fragment into the wrong call, drop a call, or manufacture one out of a
// truncated frame that merely LOOKS like the start of a call. Round 1's
// FINDING 1 was a call-splicing defect that a green suite missed; this is the
// same failure mode reached through the malformed-frame door.
//
// The junk is deliberately of four kinds, because they fail differently:
//   * a frame that is not JSON at all
//   * an empty `data:` line
//   * a line that is not an SSE field at all
//   * A TRUNCATED FRAME THAT IS THE PREFIX OF A REAL CALL — the dangerous one

/// The three calls every arm of this case must produce, and nothing else.
const EXPECTED_CALLS: [(&str, &str); 3] = [
    ("get_weather", r#"{"city":"Berlin"}"#),
    ("get_weather", r#"{"city":"Paris"}"#),
    ("get_time", r#"{"zone":"CET"}"#),
];

impl Adapter {
    /// Three parallel calls, fragmented, with junk frames woven through them.
    fn parallel_with_junk(self) -> String {
        let mut out = String::new();
        match self {
            Adapter::Compat => {
                out.push_str(
                    "data: {\"id\":\"c\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":\
                     [{\"index\":0,\"id\":\"call_a\",\"type\":\"function\",\"function\":\
                     {\"name\":\"get_weather\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}\n\n",
                );
                out.push_str("data: {\"id\":\"c\",\"choices\":[{\"index\":0,\"delta\n\n");
                out.push_str(
                    "data: {\"id\":\"c\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":\
                     [{\"index\":0,\"function\":{\"arguments\":\"{\\\"city\\\":\\\"Ber\"}}]},\
                     \"finish_reason\":null}]}\n\n",
                );
                out.push_str("data:\n\n");
                out.push_str(
                    "data: {\"id\":\"c\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":\
                     [{\"index\":0,\"function\":{\"arguments\":\"lin\\\"}\"}}]},\
                     \"finish_reason\":null}]}\n\n",
                );
                out.push_str("this line is not an SSE field at all\n\n");
                out.push_str(
                    "data: {\"id\":\"c\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":\
                     [{\"index\":1,\"id\":\"call_b\",\"type\":\"function\",\"function\":\
                     {\"name\":\"get_weather\",\"arguments\":\"{\\\"city\\\":\\\"Paris\\\"}\"}}]},\
                     \"finish_reason\":null}]}\n\n",
                );
                // THE DANGEROUS ONE: the prefix of a real third call.
                out.push_str(
                    "data: {\"id\":\"c\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":\
                     [{\"index\":2,\"id\":\"call_c\",\"type\":\"functi\n\n",
                );
                out.push_str(
                    "data: {\"id\":\"c\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":\
                     [{\"index\":2,\"id\":\"call_c\",\"type\":\"function\",\"function\":\
                     {\"name\":\"get_time\",\"arguments\":\"{\\\"zone\\\":\\\"CET\\\"}\"}}]},\
                     \"finish_reason\":null}]}\n\n",
                );
                out.push_str(
                    "data: {\"id\":\"c\",\"choices\":[{\"index\":0,\"delta\":{},\
                     \"finish_reason\":\"tool_calls\"}]}\n\n",
                );
                out.push_str("data: [DONE]\n\n");
            }
            Adapter::Anthropic => {
                let block = |index: u64, id: &str, name: &str| {
                    format!(
                        "event: content_block_start\ndata: {{\"type\":\"content_block_start\",\
                         \"index\":{index},\"content_block\":{{\"type\":\"tool_use\",\
                         \"id\":\"{id}\",\"name\":\"{name}\",\"input\":{{}}}}}}\n\n"
                    )
                };
                let delta = |index: u64, json: &str| {
                    let escaped = serde_json::to_string(json).expect("serialises");
                    format!(
                        "event: content_block_delta\ndata: {{\"type\":\"content_block_delta\",\
                         \"index\":{index},\"delta\":{{\"type\":\"input_json_delta\",\
                         \"partial_json\":{escaped}}}}}\n\n"
                    )
                };
                let stop = |index: u64| {
                    format!(
                        "event: content_block_stop\ndata: {{\"type\":\"content_block_stop\",\
                         \"index\":{index}}}\n\n"
                    )
                };
                out.push_str(&block(0, "toolu_a", "get_weather"));
                out.push_str("event: content_block_delta\ndata: {\"type\":\"content_bl\n\n");
                out.push_str(&delta(0, "{\"city\": \"Ber"));
                out.push_str("data:\n\n");
                out.push_str(&delta(0, "lin\"}"));
                out.push_str(&stop(0));
                out.push_str("this line is not an SSE field at all\n\n");
                out.push_str(&block(1, "toolu_b", "get_weather"));
                out.push_str(&delta(1, "{\"city\": \"Paris\"}"));
                out.push_str(&stop(1));
                // THE DANGEROUS ONE: the prefix of a real third block.
                out.push_str(
                    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\
                     \"index\":2,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_c\
                     \n\n",
                );
                out.push_str(&block(2, "toolu_c", "get_time"));
                out.push_str(&delta(2, "{\"zone\": \"CET\"}"));
                out.push_str(&stop(2));
                out.push_str(
                    "event: message_delta\ndata: {\"type\":\"message_delta\",\
                     \"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":50}}\n\n",
                );
                out.push_str("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
            }
            Adapter::Google => {
                let call = |name: &str, args: &str| {
                    format!(
                        "data: {{\"candidates\":[{{\"content\":{{\"parts\":[{{\"functionCall\":\
                         {{\"name\":\"{name}\",\"args\":{args}}}}}],\"role\":\"model\"}},\
                         \"index\":0}}],\"modelVersion\":\"gemini-cross\"}}\n\n"
                    )
                };
                out.push_str(&call("get_weather", "{\"city\": \"Berlin\"}"));
                out.push_str("data: {\"candidates\": [{\"content\": {\"parts\n\n");
                out.push_str(&call("get_weather", "{\"city\": \"Paris\"}"));
                out.push_str("data:\n\n");
                out.push_str("this line is not an SSE field at all\n\n");
                // THE DANGEROUS ONE: the prefix of a real third call.
                out.push_str(
                    "data: {\"candidates\":[{\"content\":{\"parts\":[{\"functionCall\":\
                     {\"name\":\"get_ti\n\n",
                );
                out.push_str(&call("get_time", "{\"zone\": \"CET\"}"));
                out.push_str(
                    "data: {\"candidates\":[{\"content\":{\"parts\":[],\"role\":\"model\"},\
                     \"finishReason\":\"STOP\",\"index\":0}],\"usageMetadata\":\
                     {\"promptTokenCount\":96,\"candidatesTokenCount\":31,\
                     \"totalTokenCount\":127},\"modelVersion\":\"gemini-cross\"}\n\n",
                );
            }
        }
        out
    }

    /// The same three calls in the NON-STREAMED shape, with the middle one
    /// broken — `hostile`'s recorded batch, which is the shape that hid
    /// FINDING 1.
    fn parallel_whole_with_one_broken(self) -> String {
        match self {
            Adapter::Compat => "{\"id\":\"c\",\"object\":\"chat.completion\",\"choices\":\
                 [{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":null,\
                 \"tool_calls\":[\
                 {\"id\":\"call_a\",\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\
                 \"arguments\":\"{\\\"city\\\":\\\"Berlin\\\"}\"}},\
                 {\"id\":\"call_bad\",\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\
                 \"arguments\":\"{\\\"city\\\":\\\"Par\"}},\
                 {\"id\":\"call_c\",\"type\":\"function\",\"function\":{\"name\":\"get_time\",\
                 \"arguments\":\"{\\\"zone\\\":\\\"CET\\\"}\"}}]},\
                 \"finish_reason\":\"tool_calls\"}]}"
                .to_owned(),
            Adapter::Anthropic => "{\"id\":\"msg_cross\",\"type\":\"message\",\
                 \"role\":\"assistant\",\"model\":\"claude-cross\",\"content\":[\
                 {\"type\":\"tool_use\",\"id\":\"toolu_a\",\"name\":\"get_weather\",\
                 \"input\":{\"city\":\"Berlin\"}},\
                 {\"type\":\"tool_use\",\"id\":\"toolu_bad\",\"name\":\"\",\"input\":{}},\
                 {\"type\":\"tool_use\",\"id\":\"toolu_c\",\"name\":\"get_time\",\
                 \"input\":{\"zone\":\"CET\"}}],\"stop_reason\":\"tool_use\",\
                 \"usage\":{\"input_tokens\":9,\"output_tokens\":40}}"
                .to_owned(),
            Adapter::Google => "{\"candidates\":[{\"content\":{\"parts\":[\
                 {\"functionCall\":{\"name\":\"get_weather\",\"args\":{\"city\":\"Berlin\"}}},\
                 {\"functionCall\":{\"args\":{\"city\":\"Paris\"}}},\
                 {\"functionCall\":{\"name\":\"get_time\",\"args\":{\"zone\":\"CET\"}}}],\
                 \"role\":\"model\"},\"finishReason\":\"STOP\",\"index\":0}],\
                 \"usageMetadata\":{\"promptTokenCount\":96,\"candidatesTokenCount\":31,\
                 \"totalTokenCount\":127},\"modelVersion\":\"gemini-cross\"}"
                .to_owned(),
        }
    }
}

fn junk_parallel_script(adapter: Adapter) -> PeerScript {
    Arc::new(move |path: &str, body: &str| {
        if adapter.is_model_list(path) {
            return Reply::json(200, adapter.model_list());
        }
        if adapter.wants_stream(path, body) {
            Reply::sse(adapter.parallel_with_junk())
        } else {
            Reply::json(200, adapter.parallel_whole_with_one_broken())
        }
    })
}

/// `name(arguments)` for a well-formed call, so two calls that were spliced
/// into one are visibly different from two that were not.
fn ok_fingerprints(calls: &[ToolCallOutcome]) -> Vec<String> {
    calls
        .iter()
        .filter_map(|call| match call {
            ToolCallOutcome::Ok {
                name, arguments, ..
            } => Some(format!(
                "{name}({})",
                serde_json::to_string(arguments).unwrap_or_default()
            )),
            _ => None,
        })
        .collect()
}

async fn case_17(profile: &str, ledger: &mut Vec<Verdict>) {
    let mut doc = Doc::new_with(
        profile,
        "17-tools-x-malformed-frames",
        "junk frames woven through a batch of parallel calls",
        "MEASURED-2 says skip a bad frame and keep going. MEASURED-4 says `index` is the \
         only join key, and it lives in the frames. Individually right, jointly dangerous: \
         a skipped frame is exactly what moves a fragment into the wrong call.",
        "all three shipping adapters",
        "one purpose-built loopback peer per adapter, real TCP",
    );
    doc.p(
        "  FOUR KINDS OF JUNK, woven between the fragments of three real calls:\n    \
         1. a frame that is not JSON at all\n    \
         2. an empty `data:` line\n    \
         3. a line that is not an SSE field at all\n    \
         4. A TRUNCATED FRAME THAT IS THE PREFIX OF A REAL CALL\n  \
         The fourth is the one that matters. A consumer that recovers optimistically turns\n  \
         it into a phantom fourth call; one that resynchronises badly loses the real third.",
    );
    doc.p(
        "  THE NON-STREAMED ARM drives the other half of FINDING 1's shape: a whole batch of\n  \
         three in which only the MIDDLE one is broken. A consumer that loses calls reports\n  \
         one where the socket carried three.",
    );

    let expected: Vec<String> = EXPECTED_CALLS
        .iter()
        .map(|(name, args)| {
            let value: Value = serde_json::from_str(args).expect("fixture args parse");
            format!(
                "{name}({})",
                serde_json::to_string(&value).unwrap_or_default()
            )
        })
        .collect();

    for adapter in Adapter::ALL {
        for streamed in [true, false] {
            let peer = CrossPeer::start(junk_parallel_script(adapter)).await;
            let log = WireLog::default();
            let provider = adapter.provider(&peer.url, &log);
            let arm = format!("{} / {}", adapter.label(), transport_label(streamed));

            let request = ChatRequest::new(adapter.model())
                .with_message(ChatMessage::user(
                    "weather in Berlin and Paris, and the time in CET",
                ))
                .with_tools([weather_tool(), time_tool()])
                .with_tool_choice(ToolChoice::Auto);
            let mut sink = CollectingSink::new();
            let outcome = if streamed {
                provider.stream(request, &mut sink, &context()).await
            } else {
                provider.complete(request, &context()).await
            };
            let entries = log.drain();

            doc.h(&format!("{arm} — the raw exchange"));
            doc.wire(&entries);

            let response = match outcome {
                Ok(response) => response,
                Err(error) => {
                    doc.check(
                        &format!("{arm}: junk frames are NOT FATAL — the turn completes"),
                        false,
                        format!("{error:?}"),
                    );
                    peer.stop();
                    continue;
                }
            };

            let produced = ok_fingerprints(&response.tool_calls);
            doc.h(&format!("{arm} — what Vela produced"));
            doc.kv("tool calls", describe_calls(&response.tool_calls));
            doc.kv("well-formed fingerprints", format!("{produced:?}"));
            doc.kv("stop reason", format!("{:?}", response.stop_reason));
            doc.kv(
                "degradations",
                describe_degradations(&response.degradations),
            );

            doc.h(&format!("{arm} — assertions"));

            doc.check(
                &format!("{arm}: junk frames are NOT FATAL — the turn completes (MEASURED-2)"),
                true,
                "the turn returned Ok".to_owned(),
            );
            if streamed {
                // The premise. Without it the case is measuring a clean stream.
                doc.check(
                    &format!("{arm}: the stream really did carry junk — frames were skipped"),
                    response.degradations.iter().any(|degradation| {
                        matches!(degradation, Degradation::MalformedFramesSkipped { count } if *count > 0)
                    }),
                    describe_degradations(&response.degradations),
                );
                doc.check(
                    &format!(
                        "{arm}: ALL THREE CALLS SURVIVE THE JUNK, whole and unspliced — none \
                         lost, none merged"
                    ),
                    produced == expected,
                    format!("produced {produced:?}, expected {expected:?}"),
                );
                doc.check(
                    &format!(
                        "{arm}: THE TRUNCATED PREFIX DID NOT BECOME A PHANTOM CALL — exactly \
                         three well-formed calls, not four"
                    ),
                    produced.len() == 3,
                    format!("{} well-formed call(s): {produced:?}", produced.len()),
                );
            } else {
                doc.check(
                    &format!(
                        "{arm}: the two intact calls of a three-call batch both survive — a \
                         broken sibling does not take them with it"
                    ),
                    produced.len() == 2
                        && produced.contains(&expected[0])
                        && produced.contains(&expected[2]),
                    format!("produced {produced:?}"),
                );
                doc.check(
                    &format!("{arm}: the broken one is REPORTED rather than dropped (MEASURED-4)"),
                    response.tool_calls.iter().any(|call| !call.is_ok())
                        && response.degradations.iter().any(|degradation| {
                            matches!(degradation, Degradation::MalformedToolCalls { count } if *count > 0)
                        }),
                    describe_calls(&response.tool_calls),
                );
                doc.check(
                    &format!(
                        "{arm}: THE BATCH IS NOT SPLICED — no well-formed call carries \
                         another call's arguments"
                    ),
                    !produced.iter().any(|call| {
                        call.contains("Berlin") && call.contains("Paris")
                            || call.contains("Berlin") && call.contains("CET")
                    }),
                    format!("{produced:?}"),
                );
            }
            doc.check(
                &format!("{arm}: the turn ends in ToolUse — calls that survived are executable"),
                response.stop_reason == StopReason::ToolUse,
                format!("{:?}", response.stop_reason),
            );
            doc.check(
                &format!("{arm}: no junk-frame text reached the user as answer content"),
                !response.answer_text().contains("not an SSE field")
                    && !response.answer_text().contains("functionCall")
                    && !response.answer_text().contains("tool_calls"),
                format!("{:?}", elide(&response.answer_text(), 160)),
            );

            peer.stop();
        }
    }

    doc.write(ledger);
}

// ===========================================================================
// Case 18 — ERROR-ECHO x every adapter x both transports
// ===========================================================================
//
// Rounds 1–4 asked one question of the error surface, four times, in four
// spellings: *is the CREDENTIAL in there?* Each round found a spelling the last
// one missed, which is why B2 stopped answering that question and changed the
// surface instead.
//
// This case asks the STRONGER question the B2 brief names, and asks it of all
// three adapters rather than one:
//
//   does the error surface contain ANY endpoint-derived text at all?
//
// It is answered two independent ways, because either alone is weak:
//
//   1. AUDIT. `diagnostic::unexplained_strings` walks the error's serde shape
//      and reports every string leaf not drawn from the closed vocabulary —
//      which is COMPUTED FROM THE ENUMS, not hand-listed. Zero unexplained
//      strings is the property.
//   2. INVARIANCE. Four peers answer the identical request with the identical
//      status and code, differing ONLY in the bytes of `message`: empty, plain
//      prose, a marker in the clear, and the same marker spelled one `\uXXXX`
//      escape per byte. If the output does not vary with the input, the input
//      is not a channel — and no encoding anyone thinks of later can make it
//      one.
//
// The audit could in principle be fooled by a vocabulary that was widened to
// excuse a leak; the invariance test cannot, because it never asks what the
// bytes MEAN. Together they are hard to fool by accident.

const ECHO_MARKER: &str = "VELA-B2-ECHO-MARKER-Qp7Xn";

/// Every byte of `text` as its own `\uXXXX` escape — legal JSON, and a decoder
/// resolves it back to the marker.
fn unicode_escaped(text: &str) -> String {
    text.chars()
        .map(|ch| format!("\\u{:04x}", ch as u32))
        .collect()
}

/// The four bodies, differing only in `message`. Named in the request so all
/// four arms hit ONE peer on ONE port — otherwise the ephemeral port would
/// differ between arms and the invariance comparison would be comparing ports.
const ECHO_VARIANTS: [&str; 4] = ["empty", "prose", "marker", "escaped"];

fn echo_message(variant: &str) -> String {
    match variant {
        "empty" => String::new(),
        "prose" => "the model is currently overloaded".to_owned(),
        "marker" => format!("{ECHO_MARKER}: rejected because 127.0.0.1 said so"),
        _ => format!("{ECHO_MARKER}: rejected"),
    }
}

impl Adapter {
    /// This dialect's error envelope, with `message` written RAW rather than
    /// through `serde_json::to_string` — so the `escaped` variant really does
    /// travel as `\uXXXX` escapes on the wire rather than as backslash-u text.
    fn error_body_raw(self, message_json_inner: &str) -> String {
        match self {
            Adapter::Compat => format!(
                "{{\"error\":{{\"message\":\"{message_json_inner}\",\
                 \"type\":\"invalid_request_error\",\"code\":\"cross_probe\"}}}}"
            ),
            Adapter::Anthropic => format!(
                "{{\"type\":\"error\",\"error\":{{\"type\":\"invalid_request_error\",\
                 \"message\":\"{message_json_inner}\"}}}}"
            ),
            Adapter::Google => format!(
                "{{\"error\":{{\"code\":400,\"message\":\"{message_json_inner}\",\
                 \"status\":\"INVALID_ARGUMENT\"}}}}"
            ),
        }
    }

    /// FINDING 2's shape: a 200 whose stream carries an error object.
    fn stream_error_body(self, message_json_inner: &str) -> String {
        match self {
            Adapter::Compat => format!(
                "data: {{\"error\":{{\"message\":\"{message_json_inner}\",\
                 \"type\":\"server_error\",\"code\":\"upstream\"}}}}\n\n"
            ),
            Adapter::Anthropic => format!(
                "event: error\ndata: {{\"type\":\"error\",\"error\":\
                 {{\"type\":\"overloaded_error\",\"message\":\"{message_json_inner}\"}}}}\n\n"
            ),
            Adapter::Google => format!(
                "data: {{\"error\":{{\"code\":503,\"message\":\"{message_json_inner}\",\
                 \"status\":\"UNAVAILABLE\"}}}}\n\n"
            ),
        }
    }
}

fn echo_script(adapter: Adapter, in_stream: bool) -> PeerScript {
    Arc::new(move |path: &str, body: &str| {
        if adapter.is_model_list(path) {
            return Reply::json(200, adapter.model_list());
        }
        let variant = ECHO_VARIANTS
            .iter()
            .find(|variant| body.contains(&format!("variant:{variant}")))
            .copied()
            .unwrap_or("prose");
        let message = echo_message(variant);
        let inner = if variant == "escaped" {
            unicode_escaped(&message)
        } else {
            // Only the characters JSON requires. The marker has none of them,
            // so `marker` travels literally, which is the point.
            message.replace('\\', "\\\\").replace('"', "\\\"")
        };
        if in_stream {
            Reply::sse(adapter.stream_error_body(&inner))
        } else {
            Reply::json(400, adapter.error_body_raw(&inner))
        }
    })
}

/// Everything about an error that a UI, a log line or the IPC bridge could
/// ever see, with the two values that are Vela's OWN and expected to differ
/// between runs replaced by placeholders.
///
/// Normalising the correlation id is not a loophole: it is a monotonic counter
/// Vela mints, it carries no endpoint bytes, and leaving it in would make every
/// pair of errors differ for a reason that has nothing to do with the property.
/// It is called out here rather than done quietly.
fn normalised_renderings(error: &ProviderError, sink: &CollectingSink) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = renderings_of(error)
        .into_iter()
        .map(|(label, text)| (label.to_owned(), strip_correlation(&text)))
        .collect();
    for (index, event) in sink.events.iter().enumerate() {
        out.push((
            format!("StreamEvent[{index}]"),
            strip_correlation(&serde_json::to_string(event).unwrap_or_default()),
        ));
    }
    out
}

/// Blank the correlation id out of a rendering, in every shape it takes,
/// WITHOUT touching anything else.
///
/// # Why this is not a `replace(&id.to_string(), "<n>")`
///
/// It was, in the first draft, and that draft turned the gate red for a reason
/// that was not true: correlation id 127 rewrote `127.0.0.1` into `<n>.0.0.1`
/// and the two arms then "differed". A probe that manufactures a red is exactly
/// as dishonest as one that manufactures a green, so this is structural — three
/// named shapes, none of which can match an IP address, a port or a status.
fn strip_correlation(text: &str) -> String {
    let mut out = text.to_owned();

    // 1. `Display`: ` [ref 00000000000000ab]`. Built forwards rather than
    //    replaced in place — the first draft replaced `[ref …]` with a string
    //    that itself starts `[ref `, so the loop matched its own output and the
    //    recorder hung for ten minutes. Caught by the hang, fixed here, re-run.
    {
        let mut rebuilt = String::with_capacity(out.len());
        let mut rest = out.as_str();
        while let Some(at) = rest.find("[ref ") {
            rebuilt.push_str(&rest[..at]);
            rebuilt.push_str("[ref <n>]");
            match rest[at..].find(']') {
                Some(offset) => rest = &rest[at + offset + 1..],
                None => {
                    rest = "";
                    break;
                }
            }
        }
        rebuilt.push_str(rest);
        out = rebuilt;
    }

    // 2. `Debug`, in both the compact and the pretty spelling:
    //    `CorrelationId(105)` and `CorrelationId(\n    105,\n)`.
    loop {
        let Some(start) = out.find("CorrelationId(") else {
            break;
        };
        let open = start + "CorrelationId(".len();
        let mut depth = 1usize;
        let mut end = open;
        for (offset, ch) in out[open..].char_indices() {
            match ch {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        end = open + offset;
                        break;
                    }
                }
                _ => {}
            }
        }
        if end <= open {
            break;
        }
        out.replace_range(start..=end, "CorrelationRef");
    }
    out = out.replace("CorrelationRef", "CorrelationId(<n>)");

    // 3. The serde shape, compact and pretty: `"correlation":105` /
    //    `"correlation": 105`.
    let mut rebuilt = String::with_capacity(out.len());
    let mut rest = out.as_str();
    while let Some(at) = rest.find("\"correlation\"") {
        rebuilt.push_str(&rest[..at]);
        rebuilt.push_str("\"correlation\"");
        let after = &rest[at + "\"correlation\"".len()..];
        let mut cursor = 0usize;
        for ch in after.chars() {
            if ch == ':' || ch == ' ' || ch.is_ascii_digit() {
                cursor += ch.len_utf8();
            } else {
                break;
            }
        }
        rebuilt.push_str(":<n>");
        rest = &after[cursor..];
    }
    rebuilt.push_str(rest);
    rebuilt
}

async fn case_18(profile: &str, ledger: &mut Vec<Verdict>) {
    let mut doc = Doc::new_with(
        profile,
        "18-error-echo-every-adapter",
        "the error surface carries NO endpoint-derived text — not merely no credential",
        "Four rounds asked whether the CREDENTIAL was on the error surface, and four times \
         found a spelling the previous round missed. B2 changed the surface. This case \
         asserts the stronger property the change was made for, on all three adapters and \
         both transports.",
        "all three shipping adapters",
        "one purpose-built loopback peer per adapter/transport — ONE port per group, so the \
         invariance comparison is not comparing ephemeral ports",
    );
    doc.p(
        "  FOUR PEER ANSWERS, identical but for the bytes of `message`:\n    \
         empty     \"\"\n    \
         prose     \"the model is currently overloaded\"\n    \
         marker    \"VELA-B2-ECHO-MARKER-Qp7Xn: rejected because 127.0.0.1 said so\"\n    \
         escaped   the same marker, ONE \\uXXXX ESCAPE PER BYTE\n  \
         Same status, same `code`, same everything else. If any rendering of the resulting\n  \
         error differs between the four, the endpoint has a channel into it.",
    );
    doc.p(
        "  TWO TRANSPORT SHAPES: a 400 read whole, and FINDING 2's shape — a 200 whose\n  \
         stream carries an error object, read frame by frame through `BodyStream`.",
    );

    let mut total_arms = 0usize;
    let mut errored_arms = 0usize;
    let mut marker_on_the_wire = 0usize;
    let mut unexplained_arms: Vec<String> = Vec::new();
    let mut variant_arms: Vec<String> = Vec::new();

    for adapter in Adapter::ALL {
        for in_stream in [false, true] {
            let peer = CrossPeer::start(echo_script(adapter, in_stream)).await;
            let shape = if in_stream {
                "200 + in-stream error object"
            } else {
                "400 read whole"
            };
            let arm = format!("{} / {shape}", adapter.label());
            let mut fingerprints: Vec<(String, Vec<(String, String)>)> = Vec::new();

            for variant in ECHO_VARIANTS {
                let log = WireLog::default();
                let provider = adapter.provider(&peer.url, &log);
                let request = ChatRequest::new(adapter.model())
                    .with_message(ChatMessage::user(format!("variant:{variant}")));
                let mut sink = CollectingSink::new();
                let outcome = if in_stream {
                    provider.stream(request, &mut sink, &context()).await
                } else {
                    provider.complete(request, &context()).await
                };
                let entries = log.drain();
                total_arms += 1;

                // The premise, read off the wire rather than assumed: for the
                // two variants that carry it, the marker really did arrive.
                if matches!(variant, "marker" | "escaped") {
                    let wire = joined_bodies(&entries);
                    if wire.contains(ECHO_MARKER) || wire.contains(&unicode_escaped(ECHO_MARKER)) {
                        marker_on_the_wire += 1;
                    }
                }

                let Err(error) = outcome else {
                    doc.check(
                        &format!("{arm} / {variant}: the peer's rejection produces an error"),
                        false,
                        "the turn succeeded".to_owned(),
                    );
                    continue;
                };
                errored_arms += 1;

                if variant == "marker" && !in_stream {
                    doc.h(&format!("{arm} — the raw exchange (variant `marker`)"));
                    doc.wire(&entries);
                    doc.kv("Display", error.to_string());
                    doc.kv("Debug", format!("{error:?}"));
                    doc.kv(
                        "serde (the IPC wire shape)",
                        serde_json::to_string(&error).unwrap_or_default(),
                    );
                }

                let unexplained = vela_providers::diagnostic::unexplained_in_error(&error);
                if !unexplained.is_empty() {
                    unexplained_arms.push(format!("{arm} / {variant} → {unexplained:?}"));
                }
                fingerprints.push((variant.to_owned(), normalised_renderings(&error, &sink)));
            }

            // ---- the invariance comparison ------------------------------
            doc.h(&format!("{arm} — invariance across the four peer answers"));
            let mut differing: Vec<String> = Vec::new();
            if let Some((_, first)) = fingerprints.first() {
                for (variant, rendering) in fingerprints.iter().skip(1) {
                    for ((label, left), (_, right)) in first.iter().zip(rendering.iter()) {
                        if left != right {
                            differing.push(format!("{variant} / {label}: {left:?} vs {right:?}"));
                        }
                    }
                    if first.len() != rendering.len() {
                        differing.push(format!(
                            "{variant}: {} rendering(s) vs {}",
                            rendering.len(),
                            first.len()
                        ));
                    }
                }
            }
            for (variant, rendering) in &fingerprints {
                doc.kv(
                    &format!("`{variant}` Display"),
                    rendering
                        .iter()
                        .find(|(label, _)| label == "Display")
                        .map(|(_, text)| text.clone())
                        .unwrap_or_default(),
                );
            }
            if differing.is_empty() {
                variant_arms.push(arm.clone());
            }

            doc.h(&format!("{arm} — assertions"));
            doc.check(
                &format!(
                    "{arm}: THE FOUR ERRORS ARE BYTE-IDENTICAL on Display, Debug, the serde \
                     IPC shape and every StreamEvent — the endpoint's message is not a channel"
                ),
                differing.is_empty(),
                if differing.is_empty() {
                    format!("{} rendering(s) compared per variant", fingerprints.len())
                } else {
                    differing.join("\n        ")
                },
            );

            peer.stop();
        }
    }

    doc.h("assertions — across every adapter and both transport shapes");
    doc.check(
        "every arm really did produce an error — nothing above is vacuous",
        errored_arms == total_arms && total_arms > 0,
        format!("{errored_arms} of {total_arms} arms errored"),
    );
    doc.check(
        "the marker really did arrive on the wire, in both spellings, on every adapter",
        marker_on_the_wire == Adapter::ALL.len() * 2 * 2,
        format!(
            "{marker_on_the_wire} of {} marker-carrying arms saw it on the wire",
            Adapter::ALL.len() * 2 * 2
        ),
    );
    doc.check(
        "NO ENDPOINT-DERIVED TEXT ON ANY ERROR SURFACE — every string in every error's serde \
         shape is drawn from Vela's own closed vocabulary, on all three adapters",
        unexplained_arms.is_empty(),
        if unexplained_arms.is_empty() {
            format!("{total_arms} arms audited, 0 unexplained strings")
        } else {
            unexplained_arms.join("\n        ")
        },
    );
    doc.check(
        "invariance holds on every adapter and both transport shapes, not just one",
        variant_arms.len() == Adapter::ALL.len() * 2,
        format!(
            "{} of {} groups invariant",
            variant_arms.len(),
            Adapter::ALL.len() * 2
        ),
    );

    doc.write(ledger);
}

// ===========================================================================
// Case 19 — CANCELLATION x TOOL ACCUMULATION  (executor's pick #1)
// ===========================================================================
//
// WHY THIS PAIR. FINDING 3 was "a call the model never finished becomes
// executable". The model truncating itself is one way a call arrives half
// built. There is a second, and it is far more common in a desktop app: THE
// USER PRESSES STOP. Cancellation and tool accumulation have each been driven
// alone — `CancelToken` in case 07, the accumulator in 02/02p — and never
// together. That is precisely the shape of the gap FINDING 3 sat in for four
// rounds, so it is where I looked first.
//
// Two things must hold, and the second is the dangerous one:
//
//   1. A call that was half-streamed when the user cancelled must not come back
//      executable. (`Cancelled` returns `Err`, so the strong form is: no
//      `ChatResponse` is produced at all, and the sink is never told the turn
//      finished.)
//   2. A CANCELLED TURN MUST NOT BE FAILED OVER. A router that treats
//      cancellation as a transport hiccup re-sends the request to the next
//      candidate — so the user presses stop and Vela runs the action twice, on
//      a second endpoint. That is "deliberation becomes an executed action"
//      with the user's own decision as the deliberation.

fn cancellable_tool_script(adapter: Adapter) -> PeerScript {
    Arc::new(move |path: &str, body: &str| {
        if adapter.is_model_list(path) {
            return Reply::json(200, adapter.model_list());
        }
        if !adapter.wants_stream(path, body) {
            return Reply::json(200, adapter.parallel_whole_with_one_broken());
        }
        // The batch, but the socket goes quiet in the middle of it — the shape
        // a user meets when they hit stop while a model is still emitting
        // calls. Half the body, then a long silence.
        let full = adapter.parallel_with_junk();
        let split = full.len() / 3;
        Reply::sse(full).stalling_after(split, Duration::from_secs(30))
    })
}

async fn case_19(profile: &str, ledger: &mut Vec<Verdict>) {
    let mut doc = Doc::new_with(
        profile,
        "19-cancellation-x-tool-accumulation",
        "the user pressing stop must not leave half a call executable, or run it twice",
        "Executor's pick. Cancellation and tool accumulation were each driven alone and \
         never together — the same gap shape FINDING 3 sat in. A half-arrived call is a \
         half-arrived call whether the MODEL truncated it or the USER did.",
        "all three shipping adapters, plus the Router",
        "one purpose-built loopback peer per adapter that goes silent mid-batch, real TCP",
    );
    doc.p(
        "  THE TURN: a batch of parallel tool calls, streamed, with the socket falling silent\n  \
         one third of the way through. The cancel token is fired 120 ms in — while a call is\n  \
         demonstrably half accumulated.",
    );

    for adapter in Adapter::ALL {
        let peer = CrossPeer::start(cancellable_tool_script(adapter)).await;
        let log = WireLog::default();
        let provider = adapter.provider(&peer.url, &log);
        let arm = adapter.label().to_owned();

        let cancel = vela_providers::provider::CancelToken::new();
        let fired = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(120)).await;
            fired.cancel();
        });

        let request = ChatRequest::new(adapter.model())
            .with_message(ChatMessage::user(
                "weather in Berlin and Paris, and the time in CET",
            ))
            .with_tools([weather_tool(), time_tool()])
            .with_tool_choice(ToolChoice::Auto);
        let mut sink = CollectingSink::new();
        let started = Instant::now();
        let outcome = tokio::time::timeout(
            Duration::from_secs(10),
            provider.stream(request, &mut sink, &context().with_cancel(cancel)),
        )
        .await;
        let elapsed = started.elapsed();
        let _ = log.drain();

        doc.h(&format!("{arm} — what Vela produced"));
        doc.kv("wall clock", format!("{elapsed:?}"));
        doc.kv(
            "outcome",
            match &outcome {
                Err(_) => "HUNG — the 10 s outer deadline fired".to_owned(),
                Ok(Ok(response)) => format!("Ok, {} tool call(s)", response.tool_calls.len()),
                Ok(Err(error)) => format!("{error:?}"),
            },
        );
        doc.kv(
            "events the sink was handed",
            format!(
                "{:?}",
                sink.events
                    .iter()
                    .map(|event| serde_json::to_value(event)
                        .ok()
                        .and_then(|value| value
                            .get("type")
                            .and_then(|kind| kind.as_str())
                            .map(str::to_owned))
                        .unwrap_or_else(|| "?".into()))
                    .collect::<Vec<String>>()
            ),
        );

        doc.h(&format!("{arm} — assertions"));
        doc.check(
            &format!("{arm}: cancellation ends the turn promptly — no hang"),
            outcome.is_ok() && elapsed < Duration::from_secs(5),
            format!("{elapsed:?}"),
        );
        let error = outcome.ok().and_then(|result| result.err());
        doc.check(
            &format!(
                "{arm}: the turn ends in Cancelled — NOT in a ChatResponse carrying half a call"
            ),
            matches!(error, Some(ProviderError::Cancelled)),
            format!("{error:?}"),
        );
        doc.check(
            &format!(
                "{arm}: A CANCELLED TURN IS NOT FAILED OVER — the user's stop is not a reason \
                 to run the same tool call against a second endpoint"
            ),
            error
                .as_ref()
                .is_some_and(|error| !error.allows_failover() && !error.allows_retry()),
            format!("{error:?}"),
        );
        doc.check(
            &format!("{arm}: the sink is never told the turn finished normally"),
            !sink.events.iter().any(|event| {
                serde_json::to_value(event)
                    .ok()
                    .and_then(|value| {
                        value
                            .get("type")
                            .and_then(|kind| kind.as_str())
                            .map(|kind| kind == "done")
                    })
                    .unwrap_or(false)
            }),
            format!("{} event(s)", sink.events.len()),
        );

        peer.stop();
    }

    // ---- through the Router, which is where a wrong answer costs most ----
    doc.h("the same cancellation, driven through the Router with a second candidate waiting");
    doc.p(
        "  A provider-level answer is not enough: the Router is what decides whether a failed\n  \
         turn is re-sent. If cancellation reached the second candidate, the user's stop would\n  \
         have STARTED a turn rather than ended one.",
    );
    let first = CrossPeer::start(cancellable_tool_script(Adapter::Compat)).await;
    let second = CrossPeer::start(cancellable_tool_script(Adapter::Compat)).await;
    let log = WireLog::default();
    let router = Router::new(vec![
        Candidate::new(
            Adapter::Compat.provider(&first.url, &log),
            Adapter::Compat.model(),
        ),
        Candidate::new(
            Adapter::Compat.provider(&second.url, &log),
            Adapter::Compat.model(),
        ),
    ])
    .with_policy(RetryPolicy::default());
    let cancel = vela_providers::provider::CancelToken::new();
    let fired = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(120)).await;
        fired.cancel();
    });
    let mut sink = CollectingSink::new();
    let outcome = tokio::time::timeout(
        Duration::from_secs(10),
        router.stream(
            ChatRequest::new(Adapter::Compat.model())
                .with_message(ChatMessage::user(
                    "weather in Berlin and Paris, and the time in CET",
                ))
                .with_tools([weather_tool(), time_tool()]),
            &mut sink,
            &context().with_cancel(cancel),
        ),
    )
    .await;
    let second_hits = second.requests().len();
    doc.kv(
        "router outcome",
        match &outcome {
            Err(_) => "HUNG".to_owned(),
            Ok(Ok(_)) => "Ok".to_owned(),
            Ok(Err(error)) => format!("{error:?}"),
        },
    );
    doc.kv("requests the SECOND candidate received", second_hits);
    doc.check(
        "THE SECOND CANDIDATE WAS NEVER CONTACTED — a cancelled turn is not sprayed at the \
         next endpoint",
        second_hits == 0,
        format!("{second_hits} request(s)"),
    );
    doc.check(
        "the router reports the cancellation as a cancellation",
        matches!(&outcome, Ok(Err(ProviderError::Cancelled))),
        format!("{outcome:?}"),
    );
    first.stop();
    second.stop();

    doc.write(ledger);
}

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
        case_12(profile, &mut ledger).await;
        case_13(profile, &mut ledger).await;
        case_14(profile, &mut ledger).await;
        case_15(profile, &mut ledger).await;
        case_16(profile, &mut ledger).await;
        case_17(profile, &mut ledger).await;
        case_18(profile, &mut ledger).await;
        case_19(profile, &mut ledger).await;
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
    //
    // Round 4 adds two more canaries and two more homes. Case 12's is MASKED
    // wherever that transcript prints received bytes, so it should appear
    // nowhere at all — including in its own file. Case 13's must appear in its
    // own file, because there the spelling *is* the evidence and masking it
    // would destroy what a reader has to see.
    {
        let homes: [(&str, Vec<String>, Option<&str>); 3] = [
            ("case 11", canary_needles(), Some("11-credential-leak.txt")),
            ("case 12", redirect_canary_needles(), None),
            (
                "case 13",
                encoding_readable_needles(),
                Some("13-encoded-credential-leak.txt"),
            ),
        ];
        // Only the per-profile case transcripts. The top-level ledger files —
        // verdicts.tsv, SUMMARY.txt, RESULTS.md — aggregate this evidence by
        // design and are written after this scan anyway.
        for (which, needles, home) in homes {
            let mut elsewhere: Vec<String> = Vec::new();
            let mut inside = 0usize;
            for profile in PROFILES {
                let Ok(entries) = std::fs::read_dir(dir.join(profile)) else {
                    continue;
                };
                for entry in entries.flatten() {
                    let path = entry.path();
                    let Ok(text) = std::fs::read_to_string(&path) else {
                        continue;
                    };
                    if !needles.iter().any(|needle| text.contains(needle.as_str())) {
                        continue;
                    }
                    let name = path
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    if home == Some(name.as_str()) {
                        inside += 1;
                    } else {
                        elsewhere.push(path.display().to_string());
                    }
                }
            }
            ledger.push(Verdict {
                profile: "all".into(),
                case: "canary-containment".into(),
                name: format!(
                    "{which}'s canary appears in no evidence file but {}",
                    home.unwrap_or("— it is masked, so nowhere at all")
                ),
                pass: elsewhere.is_empty(),
                detail: if elsewhere.is_empty() {
                    format!("{inside} permitted transcript(s) carry it, nothing else does")
                } else {
                    elsewhere.join(" ")
                },
            });
        }
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
        "GATE M Part 1 (Phase B2) — run summary\n\
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
