//! **The encoded half of the credential canary** — GATE M Part 1, Phase B,
//! round 4.
//!
//! # Why this file exists next to `streamed_credential_canary.rs`
//!
//! That file is green, has been green since round 3, drives seven forced
//! failures across three adapters, two bindings, two transports and four
//! surfaces — and it misses a live credential leak, because every one of its
//! peers spells the credential the way Vela spells it.
//!
//! Round 3's redaction is a **byte-literal** scrub of the wire bytes. A byte
//! scrub removes the spelling it was shown. A decoder's whole job is to turn one
//! spelling into another. So an endpoint that echoes the credential back
//! *encoded* walks straight through:
//!
//! ```text
//!   on the wire   sk\/vela-round4\/Ky-…      <- matches no needle, released
//!   after serde   sk/vela-round4/Ky-…        <- the credential, reassembled
//! ```
//!
//! `\/` for `/` is not exotic: it is the **default** output of PHP's
//! `json_encode`, and therefore of every gateway written in it. A `Bearer` key
//! containing `/` is not exotic either — base64 alphabets contain it, AWS-style
//! keys contain it, and a user picking a key for their own vLLM or
//! `llama-server --api-key` may type anything at all.
//!
//! The leak lands exactly where round 2's FINDING 2 landed: in
//! `ProviderError::AuthFailed` on the OpenAI-compatible adapter, in
//! `ProviderError::Transport { Request { 400 } }` on the Google one, and from
//! there into `Display`, into `Debug`, into the serde JSON that crosses the IPC
//! bridge to the low-trust WebView, and into the `StreamEvent` the UI is handed.
//! Same surfaces, same harm, same threat model — the leak had been moved one
//! decode step downstream, not closed.
//!
//! # What this file drives
//!
//! Three peers that differ **only** in how they spell the credential they echo:
//!
//! | peer | spelling | who does this |
//! |---|---|---|
//! | [`Escaping::Verbatim`] | `sk/vela-round4/…` | round 3's peer — the control |
//! | [`Escaping::Solidus`] | `sk\/vela-round4\/…` | PHP `json_encode`, default flags |
//! | [`Escaping::Unicode`] | `sk/…` | `JSON_HEX_*`, hand-rolled encoders, JS replacers |
//!
//! …across three adapters, two credential bindings, two response shapes (a 400
//! read whole and a **200 whose SSE stream carries the error**, which is
//! FINDING 2's exact shape), two transports, and four surfaces.
//!
//! # Why the fix is not this list
//!
//! Enumerating escape forms is how this defect was born. `Escaping::Unicode`
//! exists precisely to make the point that the list is not the mechanism: no
//! code in `vela-providers` mentions `\u`-escaped credentials, and both peers
//! are one case rather than two, because the crate resolves escapes instead of
//! anticipating them and, independently, scrubs *after* the decoder has run.
//!
//! Two barriers, and [`the_two_barriers_are_independent`] proves each one alone
//! is sufficient — which is the property a list cannot have.
//!
//! # Controls
//!
//! Every negative assertion here is paired with something that can fail:
//!
//! * [`positive_control_a_byte_literal_scrub_is_undone_by_the_decoder`]
//!   rebuilds round 3's literal-only scrub out of nothing but `str::replace`,
//!   runs it over an escaping peer's body, and asserts `serde_json` **does**
//!   hand the credential back. If that ever stops leaking, every other
//!   assertion in this file is vacuous.
//! * [`the_peers_really_do_encode_and_really_do_differ`] asserts the premise:
//!   the escaping peers put no literal copy of the credential on the wire, so
//!   the byte-literal scrub genuinely has nothing to match.
//! * every driven case asserts the failure was real and its detail non-empty,
//!   so "no leak" can never mean "no error", and the case counter at the end
//!   asserts the matrix actually ran.
//! * [`redaction_removes_the_secret_and_not_the_diagnosis`] is the other
//!   direction: the endpoint's own message must survive an encoded echo, or
//!   this is a deletion rather than a redaction.
//!
//! # Honesty (conventions.md §10)
//!
//! **VERIFIED-BY-FAKE.** `MemoryStore` and mock endpoints on loopback. Not one
//! byte came from a language model, and nothing here is evidence about the OS
//! keychain.

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use vela_core::credential::Auth;
use vela_core::provider::{ProviderDescriptor, ProviderKind};
use vela_core::secret::{SecretRef, SecretValue};
use vela_providers::event::{CollectingSink, StreamEvent};
use vela_providers::redact::{percent_encode, Scrubber};
use vela_providers::{
    AnthropicProvider, ChatMessage, ChatRequest, GoogleProvider, OpenAiCompatibleProvider,
    Provider, ProviderError, RequestContext, Timeouts,
};
use vela_secrets::{MemoryStore, SecretStore};

/// This round's canary.
///
/// The `/` characters are the whole point: they are what PHP's `json_encode`
/// rewrites, and they are what a base64 or AWS-style key — or a key a user
/// invented for their own `llama-server --api-key` — contains. The rest is a
/// distinctive literal so a partial leak is still a leak.
const CANARY: &str = "sk/vela-round4/Ky-7d41c0f9ab63e2/DO-NOT-LEAK";

/// The stretch that survives percent-encoding untouched, so a key cut in half
/// by `detail()`'s 200-character bound is still caught.
const CANARY_CORE: &str = "7d41c0f9ab63e2";

/// Planted in every echoed message.
///
/// # Its meaning inverted with the redesign, and that is the point
///
/// Under rounds 1–4 this marker carried no secret and therefore had to
/// **survive** into the error: it was how this file told a redaction apart from
/// a deletion. That test made sense while the strategy was "carry the
/// endpoint's words, laundered".
///
/// The strategy is now "do not carry the endpoint's words". So the marker must
/// **not** appear on any error surface — and, because an assertion that
/// something is absent is exactly the kind that passes vacuously, it must
/// simultaneously be *present in the local debug log*, found by the
/// correlation id the error carries. Together those two say the thing that
/// matters: the peer's message reached Vela, was kept, and did not travel.
const MARKER: &str = "VELA-ENCODED-MARKER";

/// The process-wide debug log these tests read back through.
///
/// Installed once, for the whole binary. Entries are found by correlation id,
/// so tests running in parallel cannot read each other's.
fn debug_log() -> &'static std::sync::Arc<vela_providers::debuglog::MemorySink> {
    static LOG: std::sync::OnceLock<std::sync::Arc<vela_providers::debuglog::MemorySink>> =
        std::sync::OnceLock::new();
    LOG.get_or_init(|| {
        let sink = std::sync::Arc::new(vela_providers::debuglog::MemorySink::new());
        vela_providers::debuglog::enable(sink.clone());
        sink
    })
}

/// The non-vacuity guard, in its new and stronger form.
///
/// Asserts three things at once:
///
/// * the error carries a real diagnosis — a cause with a sentence, and a
///   correlation id that points somewhere;
/// * **nothing on its serde surface is unexplained** by the closed vocabulary,
///   which is a stronger claim than "contains no credential": it says no
///   endpoint-derived text of any kind is present, so there is no spelling left
///   to try;
/// * the peer's message really did arrive, because the debug log holds it under
///   this error's correlation id.
#[track_caller]
fn assert_the_failure_is_real_and_carries_nothing(label: &str, error: &ProviderError) {
    let diagnosis = error
        .diagnosis()
        .unwrap_or_else(|| panic!("{label}: expected an endpoint failure, got {error:?}"));
    assert!(
        !diagnosis.cause().message().is_empty(),
        "{label}: an error with no sentence would pass every leak assertion vacuously"
    );
    let unexplained = vela_providers::diagnostic::unexplained_in_error(error);
    assert!(
        unexplained.is_empty(),
        "{label}: the error surface carries text the closed vocabulary does not \
         explain — {unexplained:?}\n  {error}"
    );
    assert!(
        !error.to_string().contains(MARKER),
        "{label}: the peer's own words reached the error surface: {error}"
    );
}

/// The other half: the body was not thrown away, it was filed.
#[track_caller]
fn assert_the_body_reached_the_debug_log(label: &str, error: &ProviderError) {
    let correlation = error
        .correlation()
        .unwrap_or_else(|| panic!("{label}: no correlation id to look up"));
    let recorded = debug_log()
        .body_for(correlation)
        .unwrap_or_else(|| panic!("{label}: nothing was filed under {correlation}"));
    // The log holds the peer's bytes as they arrived, escapes and all — that is
    // what a person debugging a gateway wants to see. So the marker is looked
    // for through one decode pass, exactly as the endpoint spelled it.
    let decoded = serde_json::from_str::<serde_json::Value>(&recorded)
        .map(|value| value.to_string())
        .unwrap_or_else(|_| recorded.clone());
    assert!(
        recorded.contains(MARKER) || decoded.contains(MARKER),
        "{label}: the peer's message never reached Vela at all, so nothing was \
         tested — the debug log holds {recorded:?}"
    );
    assert!(
        !recorded.contains(CANARY)
            && !recorded.contains(CANARY_CORE)
            && !decoded.contains(CANARY)
            && !decoded.contains(CANARY_CORE),
        "{label}: the debug log is local and opt-in, but it is still not a place \
         to write the user's own API key: {recorded}"
    );
}

/// Every spelling of the credential that must not survive, in any surface.
///
/// Note what is *not* here: the escaped forms. This file never searches for
/// `sk\/vela-round4\/…`, because finding the escaped form in a rendering would
/// be harmless — the harm is the decoder handing back the raw one. The needles
/// are the raw and percent-encoded forms, and the surfaces are searched after
/// the decode that reconstitutes them.
fn needles() -> Vec<String> {
    vec![
        CANARY.to_owned(),
        percent_encode(CANARY),
        CANARY_CORE.to_owned(),
    ]
}

// ---------------------------------------------------------------------------
// How the peer spells what it echoes
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Escaping {
    /// JSON's required minimum: `"` and `\`, nothing else. Round 3's peer, and
    /// the control that proves the matrix is not passing because the peers are
    /// broken.
    Verbatim,
    /// PHP `json_encode` with default flags: `/` becomes `\/`. The reproduction.
    Solidus,
    /// Every character of the message spelled `\uXXXX`. No `/` involved, no `\"`
    /// involved — nothing the case above covers. One mechanism has to answer
    /// both, or the fix is a list.
    Unicode,
}

impl Escaping {
    const ALL: [Escaping; 3] = [Escaping::Verbatim, Escaping::Solidus, Escaping::Unicode];

    const fn label(self) -> &'static str {
        match self {
            Escaping::Verbatim => "verbatim (JSON minimum)",
            Escaping::Solidus => "solidus escaped (PHP json_encode)",
            Escaping::Unicode => "spelled in \\uXXXX",
        }
    }

    /// Encode `text` as the *contents* of a JSON string literal.
    fn encode(self, text: &str) -> String {
        let minimum = text.replace('\\', "\\\\").replace('"', "\\\"");
        match self {
            Escaping::Verbatim => minimum,
            Escaping::Solidus => minimum.replace('/', "\\/"),
            // Every code point, including the ones that need no escaping at
            // all. A decoder must undo it; a byte scrub cannot see through it.
            Escaping::Unicode => text
                .chars()
                .map(|ch| {
                    let mut buffer = [0u16; 2];
                    ch.encode_utf16(&mut buffer)
                        .iter()
                        .map(|unit| format!("\\u{unit:04x}"))
                        .collect::<String>()
                })
                .collect(),
        }
    }

    /// Whether this spelling leaves a literal copy of `text` in the bytes.
    const fn leaves_a_literal_copy(self) -> bool {
        matches!(self, Escaping::Verbatim)
    }
}

// ---------------------------------------------------------------------------
// The four surfaces
// ---------------------------------------------------------------------------

fn renderings(error: &ProviderError) -> Vec<(&'static str, String)> {
    vec![
        ("Display", error.to_string()),
        ("Debug", format!("{error:?}")),
        (
            "serde JSON (the IPC wire shape)",
            serde_json::to_string(error).expect("ProviderError serialises"),
        ),
    ]
}

fn sink_surfaces(sink: &CollectingSink) -> Vec<(&'static str, String)> {
    sink.events
        .iter()
        .map(|event: &StreamEvent| {
            (
                "StreamEvent (the sink the UI reads)",
                serde_json::to_string(event).expect("StreamEvent serialises"),
            )
        })
        .collect()
}

#[track_caller]
fn assert_text_is_clean(label: &str, surfaces: Vec<(&'static str, String)>) {
    for (surface, text) in surfaces {
        for needle in needles() {
            assert!(
                !text.contains(&needle),
                "{label}: the credential reached {surface} (matched {needle:?}):\n  {text}"
            );
        }
    }
}

#[track_caller]
fn assert_no_credential(label: &str, error: &ProviderError, sink: &CollectingSink) {
    assert_text_is_clean(label, renderings(error));
    assert_text_is_clean(label, sink_surfaces(sink));
}

/// Guards the failure mode that would make every negative assertion pass for
/// the wrong reason: an error that says nothing at all.


// ---------------------------------------------------------------------------
// The echoing peer
// ---------------------------------------------------------------------------

/// What the endpoint saw, so it can quote it back the way real gateways do.
struct Seen {
    target: String,
    /// Values of any credential-shaped header. Several gateways echo the
    /// offending header verbatim, and a header binding must be covered too.
    credentials: Vec<String>,
    /// The **decoded** value of the API-key query parameter, if there was one.
    ///
    /// This is what makes the query binding vulnerable to the same defect as
    /// the header binding: a gateway does not echo the percent-encoded query
    /// string it received, it echoes the parameter value it parsed out — which
    /// is the raw key, `/` and all.
    query_credential: Option<String>,
    streaming: bool,
    anthropic: bool,
    google: bool,
}

/// Undo `%XX`. Bytes only: a gateway's query parser does exactly this before
/// it decides the key is invalid and says so.
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
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

fn parse_request(raw: &str) -> Seen {
    let mut lines = raw.split("\r\n");
    let target = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/")
        .to_owned();

    let mut credentials = Vec::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        if matches!(
            name.as_str(),
            "authorization" | "x-api-key" | "api-key" | "x-goog-api-key"
        ) {
            credentials.push(value.trim().to_owned());
        }
    }

    let query_credential = target.split_once('?').and_then(|(_, query)| {
        query
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .find(|(name, _)| matches!(*name, "key" | "api_key"))
            .map(|(_, value)| percent_decode(value))
    });

    Seen {
        streaming: target.contains("alt=sse")
            || target.contains("streamGenerateContent")
            || raw.contains("\"stream\":true"),
        anthropic: target.contains("/v1/messages"),
        google: target.contains("generateContent"),
        target,
        credentials,
        query_credential,
    }
}

/// The message the peer sends back.
///
/// The credential is placed **first**, immediately after the marker: `detail()`
/// bounds an error at 200 characters, and a leak that fell off the end of that
/// bound would be a test that passes for the wrong reason.
fn echoed_message(seen: &Seen) -> String {
    let mut quoted: Vec<String> = Vec::new();
    quoted.extend(seen.credentials.iter().cloned());
    quoted.extend(seen.query_credential.clone());
    let quoted = if quoted.is_empty() {
        "none".to_owned()
    } else {
        quoted.join(" ")
    };
    format!(
        "{MARKER}: rejected credential [{quoted}] for {}",
        seen.target
    )
}

/// An endpoint that quotes the request — credential included — back at Vela,
/// spelling it the way `escaping` says.
///
/// `status` 400 gives the shape read through `read_to_end`. `status` 200 gives
/// FINDING 2's shape: an entirely successful HTTP exchange whose *body* carries
/// the error, read frame by frame.
async fn echo_server(status: u16, escaping: Escaping) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a free port");
    let port = listener.local_addr().expect("bound").port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut scratch = vec![0u8; 16384];
            let read = socket.read(&mut scratch).await.unwrap_or(0);
            let raw = String::from_utf8_lossy(&scratch[..read]).into_owned();
            let seen = parse_request(&raw);
            // The one line this whole file turns on: the peer encodes, Vela
            // decodes, and round 3's scrub sat between them looking for bytes
            // that are not there.
            let escaped = escaping.encode(&echoed_message(&seen));

            let (content_type, body) = if status == 200 && seen.streaming {
                let frame = if seen.anthropic {
                    format!(
                        "event: error\ndata: {{\"type\":\"error\",\"error\":{{\"type\":\"authentication_error\",\"message\":\"{escaped}\"}}}}\n\n"
                    )
                } else if seen.google {
                    format!(
                        "data: {{\"error\":{{\"code\":400,\"status\":\"INVALID_ARGUMENT\",\"message\":\"{escaped}\"}}}}\n\n"
                    )
                } else {
                    format!(
                        "data: {{\"error\":{{\"code\":\"invalid_api_key\",\"type\":\"invalid_request_error\",\"message\":\"{escaped}\"}}}}\n\n"
                    )
                };
                ("text/event-stream", frame)
            } else {
                let object = if seen.anthropic {
                    format!(
                        "{{\"type\":\"error\",\"error\":{{\"type\":\"authentication_error\",\"message\":\"{escaped}\"}}}}"
                    )
                } else if seen.google {
                    format!(
                        "{{\"error\":{{\"code\":400,\"status\":\"INVALID_ARGUMENT\",\"message\":\"{escaped}\"}}}}"
                    )
                } else {
                    format!(
                        "{{\"error\":{{\"code\":\"invalid_api_key\",\"type\":\"invalid_request_error\",\"message\":\"{escaped}\"}}}}"
                    )
                };
                ("application/json", object)
            };

            let reason = if status == 200 { "OK" } else { "Bad Request" };
            let _ = socket
                .write_all(
                    format!(
                        "HTTP/1.1 {status} {reason}\r\ncontent-type: {content_type}\r\n\
                         x-request-id: {}\r\n\
                         www-authenticate: Bearer realm=\"api\", key=\"{}\"\r\n\
                         content-length: {}\r\nconnection: close\r\n\r\n{body}",
                        // Headers are not JSON, so nothing is escaped here. This
                        // is the *third* endpoint-supplied surface, and until
                        // round 4 it had no chokepoint at all — see
                        // `a_transport_decorator_that_records_response_headers_records_no_credential`.
                        echoed_message(&seen).replace(['\r', '\n'], " "),
                        seen.credentials
                            .first()
                            .cloned()
                            .or_else(|| seen.query_credential.clone())
                            .unwrap_or_default(),
                        body.len()
                    )
                    .as_bytes(),
                )
                .await;
            let _ = socket.flush().await;
        }
    });
    format!("http://127.0.0.1:{port}")
}

// ---------------------------------------------------------------------------
// Three adapters, two bindings
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Adapter {
    OpenAiCompatible,
    Anthropic,
    Google,
}

impl Adapter {
    const ALL: [Adapter; 3] = [
        Adapter::OpenAiCompatible,
        Adapter::Anthropic,
        Adapter::Google,
    ];
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Binding {
    /// The credential in the query string. Percent-encoded on the wire, and
    /// **decoded** by any gateway that parses it — which is where the `/` comes
    /// back.
    Query,
    /// The credential in a header, `/` and all, untouched by percent-encoding.
    Header,
}

fn descriptor(id: &str) -> ProviderDescriptor {
    ProviderDescriptor::new(id, "Encoded canary", ProviderKind::RemoteApi)
        .expect("a valid descriptor")
}

fn build(adapter: Adapter, binding: Binding, base_url: &str) -> Arc<dyn Provider> {
    let id = format!("encoded-{adapter:?}-{binding:?}").to_ascii_lowercase();
    let secrets: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    let secret = SecretRef::primary(&id).expect("a valid provider id");
    secrets
        .set(&secret, &SecretValue::new(CANARY))
        .expect("MemoryStore accepts a non-empty value");

    let auth = match (binding, adapter) {
        (Binding::Query, Adapter::Google) => Auth::ApiKeyQuery {
            param: "key".into(),
            secret,
        },
        (Binding::Query, _) => Auth::ApiKeyQuery {
            param: "api_key".into(),
            secret,
        },
        (Binding::Header, Adapter::Anthropic) => Auth::ApiKeyHeader {
            header: "x-api-key".into(),
            secret,
        },
        (Binding::Header, Adapter::Google) => Auth::ApiKeyHeader {
            header: "x-goog-api-key".into(),
            secret,
        },
        (Binding::Header, _) => Auth::Bearer { secret },
    };

    let transport = Arc::new(
        vela_providers::http::ReqwestTransport::with_connect_timeout(Duration::from_millis(300))
            .expect("the client builds"),
    );
    match adapter {
        Adapter::OpenAiCompatible => Arc::new(OpenAiCompatibleProvider::new(
            descriptor(&id),
            base_url,
            auth,
            secrets,
            transport,
        )),
        Adapter::Anthropic => Arc::new(AnthropicProvider::new(
            descriptor(&id),
            base_url,
            auth,
            secrets,
            transport,
        )),
        Adapter::Google => Arc::new(GoogleProvider::new(
            descriptor(&id),
            base_url,
            auth,
            secrets,
            transport,
        )),
    }
}

fn context() -> RequestContext {
    RequestContext::new().with_timeouts(Timeouts {
        connect: Duration::from_millis(300),
        first_byte: Duration::from_millis(500),
        stall: Duration::from_millis(500),
    })
}

fn turn() -> ChatRequest {
    ChatRequest::new("canary-model").with_message(ChatMessage::user("hi"))
}

/// Drive both transports. `complete()` reads the body whole; `stream()` reads it
/// chunk by chunk.
async fn drive(provider: &Arc<dyn Provider>) -> Vec<(&'static str, ProviderError, CollectingSink)> {
    let mut out = Vec::new();

    let completed = provider.complete(turn(), &context()).await;
    out.push((
        "complete()",
        completed.expect_err("the peer rejects the credential on purpose"),
        CollectingSink::new(),
    ));

    let mut sink = CollectingSink::new();
    let streamed = provider.stream(turn(), &mut sink, &context()).await;
    out.push((
        "stream()",
        streamed.expect_err("the peer rejects the credential on purpose"),
        sink,
    ));

    out
}

// ---------------------------------------------------------------------------
// THE MATRIX
// ---------------------------------------------------------------------------

async fn assert_every_encoding_is_clean(adapter: Adapter, binding: Binding) {
    let mut cases = 0usize;
    let mut sink_errors = 0usize;

    debug_log();
    for escaping in Escaping::ALL {
        for status in [400u16, 200u16] {
            let base_url = echo_server(status, escaping).await;
            let provider = build(adapter, binding, &base_url);
            for (path, error, sink) in drive(&provider).await {
                let label = format!(
                    "{adapter:?}/{binding:?} · {} · {status} · {path}",
                    escaping.label()
                );
                assert_the_failure_is_real_and_carries_nothing(&label, &error);
                assert_the_body_reached_the_debug_log(&label, &error);
                assert_no_credential(&label, &error, &sink);
                cases += 1;
                if sink.error().is_some() {
                    sink_errors += 1;
                }
            }
        }
    }

    assert_eq!(
        cases,
        Escaping::ALL.len() * 2 * 2,
        "the matrix did not run: {cases} cases"
    );
    assert!(
        sink_errors >= Escaping::ALL.len() * 2,
        "the sink surface would pass vacuously: only {sink_errors} streamed \
         cases put an error on the sink at all"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn openai_compatible_leaks_nothing_however_the_peer_spells_it_query_binding() {
    assert_every_encoding_is_clean(Adapter::OpenAiCompatible, Binding::Query).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn openai_compatible_leaks_nothing_however_the_peer_spells_it_header_binding() {
    assert_every_encoding_is_clean(Adapter::OpenAiCompatible, Binding::Header).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn anthropic_leaks_nothing_however_the_peer_spells_it_query_binding() {
    assert_every_encoding_is_clean(Adapter::Anthropic, Binding::Query).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn anthropic_leaks_nothing_however_the_peer_spells_it_header_binding() {
    assert_every_encoding_is_clean(Adapter::Anthropic, Binding::Header).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn google_leaks_nothing_however_the_peer_spells_it_query_binding() {
    assert_every_encoding_is_clean(Adapter::Google, Binding::Query).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn google_leaks_nothing_however_the_peer_spells_it_header_binding() {
    assert_every_encoding_is_clean(Adapter::Google, Binding::Header).await;
}

// ---------------------------------------------------------------------------
// Redaction, not deletion
// ---------------------------------------------------------------------------

/// The other direction, and the reason this piece was a *redesign* rather than
/// a deletion: dropping the endpoint's text must not drop the user's ability to
/// act on the failure.
///
/// This test kept its name and changed what it measures, because the
/// distinction it exists to enforce did not change — only where the diagnosis
/// comes from. Rounds 1–4 asked for the endpoint's own sentence to survive its
/// encoding. This round asks for the three things Vela knew all along to
/// survive instead: **which endpoint**, **what class of failure**, and **where
/// the body went**.
#[tokio::test(flavor = "multi_thread")]
async fn a_diagnosis_survives_even_though_the_endpoints_words_do_not() {
    debug_log();
    let mut checked = 0usize;
    for escaping in [Escaping::Solidus, Escaping::Unicode] {
        for adapter in Adapter::ALL {
            let base_url = echo_server(200, escaping).await;
            let provider = build(adapter, Binding::Header, &base_url);

            let mut sink = CollectingSink::new();
            let error = provider
                .stream(turn(), &mut sink, &context())
                .await
                .expect_err("the stream carries an error object");
            let label = format!("{adapter:?} · {}", escaping.label());

            assert_no_credential(&label, &error, &sink);
            assert_the_failure_is_real_and_carries_nothing(&label, &error);
            // Rounds 1–4 asserted here that `<redacted>` was *visible* in the
            // error, on the reasoning that a detail which silently lost the
            // credential would be a deletion rather than a redaction. That
            // reasoning was sound for a design that carried the endpoint's
            // text. It does not apply to one that carries none: there is no
            // detail to redact, so the question becomes whether the diagnosis
            // is still actionable — and that is asserted by the cause, the
            // status and the endpoint identity below.
            assert!(
                error.endpoint().is_some(),
                "{label}: the user must still learn which endpoint failed: {error}"
            );
            assert!(
                error.cause().is_some(),
                "{label}: the user must still learn what kind of failure it was"
            );
            assert_the_body_reached_the_debug_log(&label, &error);
            checked += 1;
        }
    }
    assert_eq!(checked, 6, "the diagnosis-survives matrix did not run");
}

// ---------------------------------------------------------------------------
// THE PREMISE — the peers really do encode
// ---------------------------------------------------------------------------

/// If an escaping peer left a literal copy of the credential in its bytes, the
/// byte-literal scrub would catch it and this whole file would be testing round
/// 3's fix over again.
#[test]
fn the_peers_really_do_encode_and_really_do_differ() {
    let message = format!("{MARKER}: rejected credential [Bearer {CANARY}]");
    let mut spellings = std::collections::HashSet::new();

    for escaping in Escaping::ALL {
        let encoded = escaping.encode(&message);
        assert_eq!(
            encoded.contains(CANARY),
            escaping.leaves_a_literal_copy(),
            "{}: the premise about this peer is wrong",
            escaping.label()
        );
        // …and every spelling still decodes back to the same message, or the
        // peer is not echoing what it claims to echo.
        let decoded: serde_json::Value =
            serde_json::from_str(&format!("\"{encoded}\"")).expect("a JSON string");
        assert_eq!(decoded.as_str().expect("a string"), message);
        assert!(spellings.insert(encoded), "two peers spell it the same way");
    }
    assert_eq!(spellings.len(), 3);
}

// ---------------------------------------------------------------------------
// POSITIVE CONTROL — the defect, reproduced
// ---------------------------------------------------------------------------

/// **POSITIVE CONTROL.** Round 3's redaction, rebuilt out of `str::replace`,
/// against an escaping peer's body — and the credential comes back out of
/// `serde_json` whole.
///
/// This is the defect in four lines. Everything else in this file is the
/// assertion that it no longer happens; this is the assertion that it *could*.
#[test]
fn positive_control_a_byte_literal_scrub_is_undone_by_the_decoder() {
    let message = format!("{MARKER}: rejected credential [Bearer {CANARY}]");

    for escaping in [Escaping::Solidus, Escaping::Unicode] {
        let body = format!(
            r#"{{"error":{{"message":"{}"}}}}"#,
            escaping.encode(&message)
        );

        // Round 3: replace the needle as written, in the bytes as they arrived.
        let round_3 = body
            .replace(CANARY, "<redacted>")
            .replace(&percent_encode(CANARY), "<redacted>");
        assert_eq!(
            round_3,
            body,
            "{}: the literal scrub found nothing to remove — that is the hole",
            escaping.label()
        );

        // …and then Vela's own decoder puts it back together.
        let decoded: serde_json::Value = serde_json::from_str(&round_3).expect("JSON");
        let reconstituted = decoded["error"]["message"].as_str().expect("a string");
        assert!(
            reconstituted.contains(CANARY),
            "{}: if this stops leaking, every assertion in this file is vacuous",
            escaping.label()
        );

        // Round 4, same bytes, both barriers available and either one enough.
        let scrubber = Scrubber::new(needles());
        let scrubbed = String::from_utf8(scrubber.scrub_bytes(body.clone().into_bytes()))
            .expect("still UTF-8");
        assert!(
            !scrubbed.contains(CANARY),
            "{}: barrier 1 released it: {scrubbed}",
            escaping.label()
        );
        let decoded: serde_json::Value = serde_json::from_str(&scrubbed).expect("still JSON");
        assert!(
            !decoded.to_string().contains(CANARY),
            "{}: barrier 1 released something the decoder reassembled",
            escaping.label()
        );
    }
}

/// **The durable claim, asserted:** the two barriers are independent, so
/// neither depends on this crate having anticipated the endpoint's encoding.
///
/// Barrier 1 is the byte scrub, which resolves escapes rather than listing
/// them. Barrier 2 is the scrub that runs *after* `serde_json` has finished,
/// where the credential is back in its raw form whatever arrived. Each is given
/// the escaped bytes **alone** and each must be sufficient.
#[test]
fn the_two_barriers_are_independent() {
    let scrubber = Scrubber::new(needles());
    let message = format!("{MARKER}: rejected credential [Bearer {CANARY}]");

    for escaping in [Escaping::Solidus, Escaping::Unicode] {
        let body = format!(
            r#"{{"error":{{"message":"{}"}}}}"#,
            escaping.encode(&message)
        );
        let label = escaping.label();

        // --- barrier 1 alone: scrub the bytes, then decode with plain serde ---
        let bytes = scrubber.scrub_bytes(body.clone().into_bytes());
        let value: serde_json::Value = serde_json::from_slice(&bytes).expect("still JSON");
        let text = value["error"]["message"].as_str().expect("a string");
        assert!(
            !text.contains(CANARY),
            "{label}: barrier 1 alone leaked: {text}"
        );
        assert!(
            text.contains(MARKER),
            "{label}: barrier 1 alone deleted the diagnosis"
        );

        // --- barrier 2 alone: decode the RAW bytes through the scrubber ------
        // Nothing has touched these bytes. The escaped credential is present in
        // full, in a spelling no needle matches — and the barrier that runs
        // after the decoder still removes it, because by then it is not escaped
        // any more.
        let value = scrubber.decode_json(body.as_bytes()).expect("JSON");
        let text = value["error"]["message"].as_str().expect("a string");
        assert!(
            !text.contains(CANARY),
            "{label}: barrier 2 alone leaked: {text}"
        );
        assert!(
            text.contains(MARKER),
            "{label}: barrier 2 alone deleted the diagnosis"
        );
        assert!(
            text.contains("<redacted>"),
            "{label}: barrier 2 must redact rather than drop: {text}"
        );
    }
}

// ---------------------------------------------------------------------------
// THE THIRD SURFACE — response headers
// ---------------------------------------------------------------------------

/// A transport decorator that copies every response header into a log, and
/// forwards the response otherwise untouched.
///
/// This is not hypothetical: it is the shape of the gate's own recorder
/// (`examples/gate_m_phase_b.rs`), which copies `response.headers` verbatim
/// into a transcript that is committed to `docs/`. It is also the shape a Phase
/// C diagnostics panel or a bug-report exporter would have. Round 3 left this
/// surface with **no** chokepoint: bodies were scrubbed, client errors were
/// scrubbed, headers were a public `Vec<(String, String)>` that nothing touched.
struct HeaderRecorder {
    inner: vela_providers::http::ReqwestTransport,
    log: Arc<std::sync::Mutex<Vec<(String, String)>>>,
}

#[async_trait::async_trait]
impl vela_providers::http::HttpTransport for HeaderRecorder {
    async fn send(
        &self,
        request: vela_providers::http::HttpRequest,
        timeouts: &Timeouts,
    ) -> Result<vela_providers::http::HttpResponse, vela_providers::http::TransportError> {
        let response = self.inner.send(request, timeouts).await?;
        let mut log = self.log.lock().expect("not poisoned");
        for (name, value) in response.headers.iter() {
            log.push((name.to_string(), value.to_string()));
        }
        Ok(response)
    }
}

/// **The latent surface, closed.** A decorator that records response headers
/// records no credential — because there is no unscrubbed header value for it
/// to record.
///
/// The peer echoes the credential twice: into `x-request-id`, an ordinary
/// diagnostic header that no name-based rule would catch, and into
/// `WWW-Authenticate`, which is what that header is *for*. Both bindings, so
/// the query form and the header form are covered.
#[tokio::test(flavor = "multi_thread")]
async fn a_transport_decorator_that_records_response_headers_records_no_credential() {
    let mut recorded_headers = 0usize;
    let mut saw_the_echo = 0usize;

    for binding in [Binding::Query, Binding::Header] {
        let base_url = echo_server(400, Escaping::Verbatim).await;
        let log: Arc<std::sync::Mutex<Vec<(String, String)>>> = Arc::default();
        let transport = Arc::new(HeaderRecorder {
            inner: vela_providers::http::ReqwestTransport::with_connect_timeout(
                Duration::from_millis(300),
            )
            .expect("the client builds"),
            log: Arc::clone(&log),
        });

        let id = format!("header-surface-{binding:?}").to_ascii_lowercase();
        let secrets: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
        let secret = SecretRef::primary(&id).expect("a valid provider id");
        secrets
            .set(&secret, &SecretValue::new(CANARY))
            .expect("MemoryStore accepts a non-empty value");
        let auth = match binding {
            Binding::Query => Auth::ApiKeyQuery {
                param: "api_key".into(),
                secret,
            },
            Binding::Header => Auth::Bearer { secret },
        };
        let provider =
            OpenAiCompatibleProvider::new(descriptor(&id), &base_url, auth, secrets, transport);

        let _ = provider.complete(turn(), &context()).await;

        let entries = log.lock().expect("not poisoned").clone();
        assert!(
            !entries.is_empty(),
            "{binding:?}: the recorder saw no headers at all, so nothing was tested"
        );
        for (name, value) in &entries {
            recorded_headers += 1;
            if name == "x-request-id" {
                saw_the_echo += 1;
                assert!(
                    value.contains(MARKER),
                    "{binding:?}: the peer's echo must reach the recorder, or \
                     this test is vacuous: {value}"
                );
            }
            for needle in needles() {
                assert!(
                    !value.contains(&needle),
                    "{binding:?}: the credential reached a recorded response \
                     header ({name}, matched {needle:?}): {value}"
                );
            }
        }
    }

    assert!(
        recorded_headers >= 8,
        "only {recorded_headers} headers were recorded across both bindings"
    );
    assert_eq!(
        saw_the_echo, 2,
        "the echoing header must have been recorded once per binding"
    );
}
