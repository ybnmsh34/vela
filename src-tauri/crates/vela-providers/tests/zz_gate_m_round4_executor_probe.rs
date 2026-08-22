//! **The GATE M Part 1 executor's own probe — Phase B, round 4.**
//!
//! Written by the gate executor, who wrote none of round 4's fixes and ran none
//! of rounds 1–3. Its job is not to re-run what is green. It is to drive the
//! spellings and the wire behaviours **nobody briefed**, because every round of
//! this piece so far has died on a surface the previous round's tests did not
//! cover.
//!
//! # What is briefed, and therefore not here
//!
//! `tests/encoded_credential_canary.rs` drives three spellings — verbatim, PHP
//! `"json_encode"`'s `\/`, and every character as `\uXXXX` — and the percent-encoded
//! form of the credential is a needle in its own right, so an endpoint echoing
//! `%2F` is caught by the literal pass. Those are the round-4 brief's three
//! encodings. This file starts where that list ends.
//!
//! # What is here
//!
//! | spelling | who writes it | what it tests |
//! |---|---|---|
//! | [`Spelling::PercentLower`] | any encoder using lowercase hex — Go's `url.QueryEscape` does not, Python's `quote` does not, but plenty of hand-rolled gateway code does | the needle is built with **uppercase** `%2F`; a lowercase echo matches no needle and no JSON escape |
//! | [`Spelling::DoubleSolidus`] | a gateway that JSON-encodes a string that was **already** JSON-encoded — an upstream error body embedded verbatim in an outer one | one decode pass leaves `\/`, which is still not the credential; only a second pass reassembles it |
//! | [`Spelling::PercentEveryByte`] | `%76%65%6c%61…` — a paranoid encoder, or an attacker choosing the spelling | neither needle, and no JSON escape at all |
//! | [`Spelling::HtmlEntity`] | anything that HTML-escapes before it JSON-encodes — a gateway rendering the same message to a web console | a spelling with no decoder anywhere in Vela |
//!
//! And one wire behaviour rather than a spelling:
//!
//! * [`a_credential_fragmented_across_two_real_tcp_writes_is_still_removed`]
//!   splits the escaped credential **mid-escape** across two `write_all` calls
//!   with a delay between them, so the client genuinely reads it in two chunks.
//!   `RESULTS.md` §8 of round 3 records this as *not* proved on a real socket:
//!   `Scrubber::hold_back_len` was exercised only by a scripted
//!   one-byte-at-a-time body. This closes that hole with a peer that actually
//!   fragments.
//!
//! # What a FAIL here means
//!
//! Not every spelling in the table above *should* be removed. A spelling is only
//! a leak if something in Vela turns it back into the credential — that is the
//! difference between `\/` (which `serde_json` decodes, and which was round 4's
//! real defect) and `&#x2f;` (which nothing decodes). This file therefore
//! asserts two different things, and says which is which at every call site:
//!
//! * **the credential must not be readable** — no surface may contain a literal
//!   or percent-encoded canary, ever;
//! * **the credential must not be RECONSTRUCTIBLE by a decoder Vela itself
//!   runs** — asserted by decoding each surface the way Vela's own code would
//!   and looking again.
//!
//! [`what_each_spelling_actually_does`] records the raw outcome of every
//! spelling with no assertion attached at all, so a reader can see the ones that
//! survive as text and judge them, rather than being shown only the verdict.
//!
//! # Honesty (conventions.md §10)
//!
//! **VERIFIED-BY-FAKE.** Loopback peers and `MemoryStore`. Not one byte came
//! from a language model; nothing here is evidence about the OS keychain or a
//! real vendor endpoint.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use vela_core::credential::Auth;
use vela_core::provider::{ProviderDescriptor, ProviderKind};
use vela_core::secret::{SecretRef, SecretValue};
use vela_providers::event::{CollectingSink, StreamEvent};
use vela_providers::redact::percent_encode;
use vela_providers::{
    AnthropicProvider, ChatMessage, ChatRequest, GoogleProvider, OpenAiCompatibleProvider,
    Provider, ProviderError, RequestContext, Timeouts,
};
use vela_secrets::{MemoryStore, SecretStore};

/// The executor's own canary — deliberately **not** the one any builder's test
/// uses, so a fix that special-cased a literal in a test file would not pass
/// this one. It contains `/` (what PHP escapes, what percent-encoding rewrites)
/// and `+` (what percent-encoding rewrites and nothing else does).
const CANARY: &str = "sk/exec4+Rk9mQ2/8xTn41-DO-NOT-LEAK";

/// The stretch with no `/` and no `+` in it: it survives every spelling below
/// unchanged, so a leak that lost its punctuation is still caught.
const CANARY_CORE: &str = "8xTn41";

/// Planted in every echoed message, carries no secret, and must therefore
/// **survive**. It is how this file tells redaction apart from deletion.
const MARKER: &str = "VELA-EXEC4-MARKER";

// ---------------------------------------------------------------------------
// The spellings
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Spelling {
    /// The control: the credential as-is, minimally JSON-escaped. If this ever
    /// stops being caught, every other case in this file is vacuous.
    Verbatim,
    /// `%2F`, `%2B` — the form `RequestUrl::with_query_credential` writes, and a
    /// needle in its own right. Briefed; here as the second control.
    PercentUpper,
    /// The same, lowercase: `%2f`, `%2b`. **Nobody briefed this.** The needle is
    /// built by `percent_encode`, which emits `{:02X}`.
    PercentLower,
    /// Every byte percent-encoded, including the ones that need no encoding.
    /// **Nobody briefed this.**
    PercentEveryByte,
    /// JSON-escaped twice: `/` → `\/` → `\\/`. **Nobody briefed this.** One
    /// decode pass yields `\/`, which is not the credential; only a second pass
    /// does.
    DoubleSolidus,
    /// `&#x2f;` for `/`, `&#x2b;` for `+`. **Nobody briefed this**, and nothing
    /// in Vela decodes it — which is the answer this case is here to record
    /// rather than the leak it is here to catch.
    HtmlEntity,
}

impl Spelling {
    const ALL: [Spelling; 6] = [
        Spelling::Verbatim,
        Spelling::PercentUpper,
        Spelling::PercentLower,
        Spelling::PercentEveryByte,
        Spelling::DoubleSolidus,
        Spelling::HtmlEntity,
    ];

    const fn label(self) -> &'static str {
        match self {
            Spelling::Verbatim => "verbatim (control)",
            Spelling::PercentUpper => "percent-encoded, UPPERCASE hex (control)",
            Spelling::PercentLower => "percent-encoded, lowercase hex  [UNBRIEFED]",
            Spelling::PercentEveryByte => "percent-encoded, every byte     [UNBRIEFED]",
            Spelling::DoubleSolidus => "JSON-escaped TWICE (\\\\/)        [UNBRIEFED]",
            Spelling::HtmlEntity => "HTML entities (&#x2f;)          [UNBRIEFED]",
        }
    }

    /// Rewrite just the credential. The surrounding message is left alone, so
    /// the marker always arrives readable and a missing marker means the peer's
    /// message never reached the error at all.
    fn spell(self, credential: &str) -> String {
        match self {
            Spelling::Verbatim => credential.to_owned(),
            Spelling::PercentUpper => percent_encode(credential),
            // Lowercase the HEX DIGITS ONLY. An earlier draft of this file
            // lowercased the whole string, which also folded the credential's
            // own letters — a spelling no encoder produces, and one that made
            // the probe report a leak that was an artefact of its own
            // instrumentation. `%2f` is what a lowercase-hex encoder writes;
            // `rk9mq2` is what nothing writes.
            Spelling::PercentLower => lowercase_percent_hex(&percent_encode(credential)),
            Spelling::PercentEveryByte => credential
                .bytes()
                .map(|byte| format!("%{byte:02X}"))
                .collect(),
            // Escaped once by the gateway that produced the inner message, then
            // again by the one that embedded it.
            Spelling::DoubleSolidus => credential.replace('/', "\\\\/"),
            Spelling::HtmlEntity => credential
                .replace('&', "&amp;")
                .replace('/', "&#x2f;")
                .replace('+', "&#x2b;"),
        }
    }

    /// Whether this spelling leaves a literal or percent-uppercase copy — i.e.
    /// whether the byte scrub's *literal* pass has anything to match.
    const fn leaves_a_matchable_literal(self) -> bool {
        matches!(self, Spelling::Verbatim | Spelling::PercentUpper)
    }
}

// ---------------------------------------------------------------------------
// What must never be readable
// ---------------------------------------------------------------------------

/// Lowercase the two hex digits of every `%XX`, and nothing else.
fn lowercase_percent_hex(text: &str) -> String {
    let bytes: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == '%' && index + 2 < bytes.len() {
            out.push('%');
            out.push(bytes[index + 1].to_ascii_lowercase());
            out.push(bytes[index + 2].to_ascii_lowercase());
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    out
}

fn html_entity_decode(text: &str) -> String {
    let mut out = text.to_owned();
    for (entity, ch) in [("&#x2f;", "/"), ("&#x2b;", "+"), ("&amp;", "&")] {
        out = out.replace(entity, ch);
    }
    out
}

/// Spellings a *reader* of a surface gets the credential from with no work at
/// all — the literal key, the percent form Vela itself wrote on the wire, and
/// the stretch of the key that no spelling below changes.
///
/// Note what is NOT here: the unbriefed spellings. This file never searches for
/// what it planted; it searches for what must never survive, and separately
/// asks whether a decoder can get back to it.
fn readable_needles() -> Vec<String> {
    vec![
        CANARY.to_owned(),
        percent_encode(CANARY),
        lowercase_percent_hex(&percent_encode(CANARY)),
        CANARY_CORE.to_owned(),
    ]
}

/// Resolve the escapes a JSON decoder resolves, repeatedly, and percent-decode —
/// i.e. everything a downstream consumer of one of these surfaces might do to
/// the text. If the credential appears after that, it was reconstructible.
fn fully_decoded(text: &str) -> String {
    let mut current = text.to_owned();
    for _ in 0..4 {
        let decoded = html_entity_decode(&percent_decode(&json_unescape(&current)));
        if decoded == current {
            break;
        }
        current = decoded;
    }
    current
}

/// Undo JSON string escapes in `text`, leaving anything that is not one alone.
fn json_unescape(text: &str) -> String {
    let bytes: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != '\\' || index + 1 >= bytes.len() {
            out.push(bytes[index]);
            index += 1;
            continue;
        }
        match bytes[index + 1] {
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
            'n' => {
                out.push('\n');
                index += 2;
            }
            't' => {
                out.push('\t');
                index += 2;
            }
            'u' if index + 5 < bytes.len() => {
                let hex: String = bytes[index + 2..index + 6].iter().collect();
                match u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                    Some(ch) => {
                        out.push(ch);
                        index += 6;
                    }
                    None => {
                        out.push(bytes[index]);
                        index += 1;
                    }
                }
            }
            _ => {
                out.push(bytes[index]);
                index += 1;
            }
        }
    }
    out
}

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

fn surfaces(error: &ProviderError, sink: &CollectingSink) -> Vec<(String, String)> {
    let mut out = vec![
        ("Display".to_owned(), error.to_string()),
        ("Debug".to_owned(), format!("{error:?}")),
        (
            "serde JSON (the IPC wire shape)".to_owned(),
            serde_json::to_string(error).expect("ProviderError serialises"),
        ),
    ];
    for (index, event) in sink.events.iter().enumerate() {
        out.push((
            format!("StreamEvent[{index}] (the sink the UI reads)"),
            serde_json::to_string(event as &StreamEvent).expect("StreamEvent serialises"),
        ));
    }
    out
}

/// One way one surface failed.
struct Breach {
    label: String,
    surface: String,
    /// `READABLE` — the key, or the percent form Vela itself wrote, is in the
    /// text as it stands. `RECONSTRUCTIBLE` — it is not, but one pass of
    /// ordinary decoding gets back to it.
    kind: &'static str,
    text: String,
}

/// Every way this outcome leaked, rather than the first. Returning the first is
/// how a probe reports one defect and hides three.
fn inspect(label: &str, error: &ProviderError, sink: &CollectingSink) -> Vec<Breach> {
    let mut breaches = Vec::new();
    for (surface, text) in surfaces(error, sink) {
        if readable_needles()
            .iter()
            .any(|needle| text.contains(needle.as_str()))
        {
            breaches.push(Breach {
                label: label.to_owned(),
                surface: surface.clone(),
                kind: "READABLE",
                text: text.clone(),
            });
            continue;
        }
        if fully_decoded(&text).contains(CANARY) {
            breaches.push(Breach {
                label: label.to_owned(),
                surface,
                kind: "RECONSTRUCTIBLE",
                text,
            });
        }
    }
    breaches
}

/// Guards against every leak assertion passing because nothing arrived.
#[track_caller]
fn assert_the_peers_message_arrived(label: &str, error: &ProviderError) {
    // This guard inverted with the redesign, and the inversion is the fix.
    //
    // It used to look for the peer's marker **in the error**, because that was
    // the only evidence available that the echoed message had reached Vela at
    // all — and an absent message would have made every leak assertion in this
    // file pass for the wrong reason.
    //
    // The error no longer carries the peer's words, so the guard reads the
    // local debug log instead: the message arrived, it was kept, and it did not
    // travel. That is three claims where there used to be one, and the middle
    // one is what makes the first two more than a deletion.
    let text = error.to_string();
    assert!(
        !text.contains(MARKER),
        "{label}: the peer's echoed message reached the error surface: {text}"
    );
    let correlation = error
        .correlation()
        .unwrap_or_else(|| panic!("{label}: no correlation id, so nothing is recoverable"));
    let filed = debug_log()
        .body_for(correlation)
        .unwrap_or_else(|| panic!("{label}: nothing was filed under {correlation}"));
    let decoded = serde_json::from_str::<serde_json::Value>(&filed)
        .map(|value| value.to_string())
        .unwrap_or_else(|_| filed.clone());
    assert!(
        filed.contains(MARKER) || decoded.contains(MARKER),
        "{label}: the peer's echoed message never reached Vela at all, so \
         nothing above was tested — the debug log holds {filed:?}"
    );
    // And the strongest form of what this whole file was written to check:
    // nothing on the error's surface is endpoint-derived in ANY spelling,
    // because there is no field for endpoint text to occupy.
    let unexplained = vela_providers::diagnostic::unexplained_in_error(error);
    assert!(
        unexplained.is_empty(),
        "{label}: the error surface carries text the closed vocabulary does not \
         explain — {unexplained:?}\n  {text}"
    );
}

/// The process-wide debug log this probe reads back through. Installed once.
fn debug_log() -> &'static Arc<vela_providers::debuglog::MemorySink> {
    static LOG: std::sync::OnceLock<Arc<vela_providers::debuglog::MemorySink>> =
        std::sync::OnceLock::new();
    LOG.get_or_init(|| {
        let sink = Arc::new(vela_providers::debuglog::MemorySink::new());
        vela_providers::debuglog::enable(sink.clone());
        sink
    })
}

// ---------------------------------------------------------------------------
// The peer
// ---------------------------------------------------------------------------

struct Echo {
    url: String,
    /// Every byte this peer wrote, upstream of everything Vela does. The
    /// premise of each case is established here, never from inside Vela.
    sent: Arc<Mutex<Vec<u8>>>,
}

/// `fragment_at` splits the response body into two `write_all` calls with a
/// delay between them, so the client really does read it in two chunks.
async fn echo_server(status: u16, spelling: Spelling, fragment_at: Option<usize>) -> Echo {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a free port");
    let port = listener.local_addr().expect("bound").port();
    let sent: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let sent_by_task = Arc::clone(&sent);
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut scratch = vec![0u8; 16384];
            let read = socket.read(&mut scratch).await.unwrap_or(0);
            let raw = String::from_utf8_lossy(&scratch[..read]).into_owned();
            let seen = parse_request(&raw);

            // The credential as the gateway parsed it out — raw `/` and all —
            // then spelled the way this peer spells things.
            let credential = seen.credential.clone().unwrap_or_else(|| "none".to_owned());
            let message = format!(
                "{MARKER}: rejected credential [{}] for {}",
                spelling.spell(&credential),
                seen.path
            );

            // The 200 case is FINDING 2's shape and only exists for a request
            // that asked to stream: a 200 whose *body* carries the error. A
            // non-streamed request gets the same error object as a plain JSON
            // body, which is the shape `read_to_end` sees.
            let object = if seen.anthropic {
                format!(
                    "{{\"type\":\"error\",\"error\":{{\"type\":\"authentication_error\",\
                     \"message\":\"{message}\"}}}}"
                )
            } else if seen.google {
                format!(
                    "{{\"error\":{{\"code\":400,\"status\":\"INVALID_ARGUMENT\",\
                     \"message\":\"{message}\"}}}}"
                )
            } else {
                format!(
                    "{{\"error\":{{\"code\":\"invalid_api_key\",\
                     \"type\":\"invalid_request_error\",\"message\":\"{message}\"}}}}"
                )
            };
            // A 400 is an error the *status line* already declares, and every
            // adapter reads its body whole. Only the 200 case — an entirely
            // successful HTTP exchange whose body carries the error — is
            // delivered as SSE. That is FINDING 2's shape.
            let (content_type, body) = if seen.streaming && status == 200 {
                let frame = if seen.anthropic {
                    format!("event: error\ndata: {object}\n\n")
                } else {
                    format!("data: {object}\n\ndata: [DONE]\n\n")
                };
                ("text/event-stream", frame)
            } else {
                ("application/json", object)
            };
            let reason = if status == 200 { "OK" } else { "Bad Request" };
            let head = format!(
                "HTTP/1.1 {status} {reason}\r\ncontent-type: {content_type}\r\n\
                 content-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );

            let whole = format!("{head}{body}");
            sent_by_task
                .lock()
                .expect("send log poisoned")
                .extend_from_slice(whole.as_bytes());

            match fragment_at {
                None => {
                    let _ = socket.write_all(whole.as_bytes()).await;
                    let _ = socket.flush().await;
                }
                Some(offset) => {
                    // Split the BODY, not the head — the head must arrive whole
                    // or the client never gets past the response line.
                    let split = head.len() + offset.min(body.len());
                    let bytes = whole.as_bytes();
                    let _ = socket.write_all(&bytes[..split]).await;
                    let _ = socket.flush().await;
                    tokio::time::sleep(Duration::from_millis(60)).await;
                    let _ = socket.write_all(&bytes[split..]).await;
                    let _ = socket.flush().await;
                }
            }
            let _ = socket.flush().await;
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    });
    Echo {
        url: format!("http://127.0.0.1:{port}"),
        sent,
    }
}

struct Seen {
    path: String,
    credential: Option<String>,
    streaming: bool,
    anthropic: bool,
    google: bool,
}

fn parse_request(raw: &str) -> Seen {
    let mut lines = raw.split("\r\n");
    let target = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/")
        .to_owned();
    let path = target.split('?').next().unwrap_or("/").to_owned();
    let streaming = target.contains("alt=sse")
        || target.contains("streamGenerateContent")
        || raw.contains("\"stream\":true");
    let anthropic = target.contains("/v1/messages");
    let google = target.contains("generateContent");

    let mut credential = None;
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
            credential = Some(value.trim().trim_start_matches("Bearer ").to_owned());
        }
    }
    if credential.is_none() {
        credential = target.split_once('?').and_then(|(_, query)| {
            query
                .split('&')
                .filter_map(|pair| pair.split_once('='))
                .find(|(name, _)| matches!(*name, "key" | "api_key"))
                // The gateway parses and DECODES the parameter before deciding
                // it is invalid. That is where the raw `/` comes back.
                .map(|(_, value)| percent_decode(value))
        });
    }
    Seen {
        path,
        credential,
        streaming,
        anthropic,
        google,
    }
}

// ---------------------------------------------------------------------------
// Adapters and bindings
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Adapter {
    OpenAiCompatible,
    Anthropic,
    Google,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Binding {
    Query,
    Header,
}

fn build(adapter: Adapter, binding: Binding, base_url: &str) -> Arc<dyn Provider> {
    let id = format!("exec4-{adapter:?}-{binding:?}").to_ascii_lowercase();
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

    let descriptor = ProviderDescriptor::new(&id, "Executor probe", ProviderKind::RemoteApi)
        .expect("a valid descriptor");
    let transport = Arc::new(
        vela_providers::http::ReqwestTransport::with_connect_timeout(Duration::from_millis(300))
            .expect("the client builds"),
    );
    match adapter {
        Adapter::OpenAiCompatible => Arc::new(OpenAiCompatibleProvider::new(
            descriptor, base_url, auth, secrets, transport,
        )),
        Adapter::Anthropic => Arc::new(AnthropicProvider::new(
            descriptor, base_url, auth, secrets, transport,
        )),
        Adapter::Google => Arc::new(GoogleProvider::new(
            descriptor, base_url, auth, secrets, transport,
        )),
    }
}

fn context() -> RequestContext {
    RequestContext::new().with_timeouts(Timeouts {
        connect: Duration::from_millis(500),
        first_byte: Duration::from_millis(2_000),
        stall: Duration::from_millis(2_000),
    })
}

fn turn() -> ChatRequest {
    ChatRequest::new("exec4-model").with_message(ChatMessage::user("hi"))
}

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

/// Every unbriefed spelling, both response shapes, both calls, all three
/// adapters, both bindings.
///
/// # This test was RED, and the `#[ignore]` is gone
///
/// It carried **round 4's open finding** (GATE M Part 1 Phase B `RESULTS.md`
/// §5): three spellings of a credential — percent-encoded with lowercase hex,
/// percent-encoded byte for byte, and HTML-entity-escaped — reached `Display`,
/// `Debug`, the serde JSON that crosses the IPC bridge and the `StreamEvent`
/// the UI is handed. It was marked `#[ignore]` so that `cargo test` kept
/// meaning "nothing NEW is broken", with the note that **deleting the
/// `#[ignore]` is the acceptance test for the fix.**
///
/// That attribute is deleted. This test now runs in the ordinary suite.
///
/// # And it is *not* the interesting assertion any more
///
/// Every leak search below is now vacuous by construction, and that is worth
/// saying out loud rather than letting a green tick imply something it does
/// not. There is no endpoint text on the error surface for a needle to match,
/// so a needle search cannot fail — which is exactly why the searches alone
/// would be a bad test.
///
/// [`assert_the_peers_message_arrived`] is what carries the weight. It asserts
/// the strictly stronger property: that **nothing** on the surface is
/// endpoint-derived, checked by enumerating the closed vocabulary rather than
/// by enumerating spellings. A fifth encoding cannot defeat an allowlist of
/// what is permitted, which is the whole reason the strategy changed.
#[tokio::test]
async fn no_spelling_of_the_credential_survives_into_any_surface() {
    debug_log();
    let mut cases = 0usize;
    let mut premise_checked = 0usize;
    let mut breaches: Vec<Breach> = Vec::new();
    // Which spellings leaked at all, so the summary names them rather than
    // making a reader count rows.
    let mut leaking: std::collections::BTreeSet<&'static str> = Default::default();

    for adapter in [
        Adapter::OpenAiCompatible,
        Adapter::Anthropic,
        Adapter::Google,
    ] {
        for binding in [Binding::Query, Binding::Header] {
            for spelling in Spelling::ALL {
                // 400 read whole, and 200-with-an-error-frame — FINDING 2's
                // shape, which the round-4 brief names explicitly.
                for status in [400u16, 200u16] {
                    let peer = echo_server(status, spelling, None).await;
                    let provider = build(adapter, binding, &peer.url);
                    for (call, error, sink) in drive(&provider).await {
                        let label = format!(
                            "{adapter:?}/{binding:?} · {} · HTTP {status} · {call}",
                            spelling.label()
                        );
                        assert_the_peers_message_arrived(&label, &error);
                        let found = inspect(&label, &error, &sink);
                        if !found.is_empty() {
                            leaking.insert(spelling.label());
                        }
                        breaches.extend(found);
                        cases += 1;
                    }
                    // The premise: for the unbriefed spellings the peer must
                    // have put NO matchable literal on the wire, or the literal
                    // pass caught it and the spelling was never tested.
                    let wire =
                        String::from_utf8_lossy(&peer.sent.lock().expect("send log poisoned"))
                            .into_owned();
                    if !spelling.leaves_a_matchable_literal() && wire.contains(MARKER) {
                        assert!(
                            !wire.contains(CANARY) && !wire.contains(&percent_encode(CANARY)),
                            "{spelling:?}: the peer left a matchable literal on the wire, \
                             so the literal pass caught it and this spelling was never \
                             actually exercised:\n{wire}"
                        );
                        premise_checked += 1;
                    }
                }
            }
        }
    }

    assert_eq!(
        cases,
        3 * 2 * Spelling::ALL.len() * 2 * 2,
        "the matrix did not run to completion"
    );
    assert!(
        premise_checked >= 3 * 2 * 4,
        "the unbriefed spellings were not observed on the wire often enough to \
         believe the premise: {premise_checked}"
    );

    if !breaches.is_empty() {
        let mut report = format!(
            "\n{} of {cases} driven outcomes leaked the credential.\n\
             Spellings that leaked: {}\n\n",
            breaches.len(),
            leaking.into_iter().collect::<Vec<_>>().join(" | ")
        );
        // One example per (spelling, kind, surface), because 200 identical rows
        // are not 200 findings.
        let mut seen: std::collections::BTreeSet<String> = Default::default();
        for breach in &breaches {
            let key = format!("{}|{}|{}", breach.label, breach.kind, breach.surface);
            if !seen.insert(key) {
                continue;
            }
            report.push_str(&format!(
                "  [{}] {}\n      surface: {}\n      text:    {}\n",
                breach.kind, breach.label, breach.surface, breach.text
            ));
        }
        panic!("{report}");
    }
}

/// The one the round-3 evidence base explicitly says it cannot prove.
///
/// RESULTS.md round 3 §8: *"Nothing about a credential split across a chunk
/// boundary on a real socket. `Scrubber::hold_back_len` is proved by a scripted
/// one-byte-at-a-time body, not by a peer that actually fragments that way."*
///
/// This peer fragments that way. The split offset is swept across the whole
/// body, so it lands **inside** the credential, **inside** a `\/` escape
/// sequence, and on every other boundary there is.
#[tokio::test]
async fn a_credential_fragmented_across_two_real_tcp_writes_is_still_removed() {
    debug_log();
    let mut splits_inside_the_credential = 0usize;

    for spelling in [Spelling::Verbatim, Spelling::DoubleSolidus] {
        // A sweep rather than one guess: the interesting offsets are wherever
        // the credential happens to land in the frame, which depends on the
        // request target's length.
        for offset in (40..160).step_by(7) {
            let peer = echo_server(200, spelling, Some(offset)).await;
            let provider = build(Adapter::OpenAiCompatible, Binding::Query, &peer.url);
            let mut sink = CollectingSink::new();
            let error = provider
                .stream(turn(), &mut sink, &context())
                .await
                .expect_err("the peer rejects the credential on purpose");
            let label = format!("fragmented at +{offset} · {}", spelling.label());
            assert_the_peers_message_arrived(&label, &error);
            let breaches = inspect(&label, &error, &sink);
            assert!(
                breaches.is_empty(),
                "{label}: {} — the credential survived a fragmented write in {}:\n  {}",
                breaches[0].kind,
                breaches[0].surface,
                breaches[0].text
            );

            // Did this offset actually cut the credential in half? Only the
            // peer's own send buffer can say.
            let wire =
                String::from_utf8_lossy(&peer.sent.lock().expect("send log poisoned")).into_owned();
            if let Some(at) = wire.find(&spelling.spell(CANARY)) {
                let split = wire.find("\r\n\r\n").map(|at| at + 4).unwrap_or(0) + offset;
                if split > at && split < at + spelling.spell(CANARY).len() {
                    splits_inside_the_credential += 1;
                }
            }
        }
    }

    assert!(
        splits_inside_the_credential >= 4,
        "no sampled offset actually split the credential across two TCP writes, \
         so this test proved nothing about `hold_back_len`: \
         {splits_inside_the_credential} of the sweep landed inside it"
    );
}

/// **A record, not a verdict.**
///
/// Prints what each spelling actually leaves in the error, with no assertion
/// attached. Some of these survive as text — that is the honest answer for a
/// spelling nothing decodes, and a reader should be shown it rather than told
/// "clean".
#[tokio::test]
async fn what_each_spelling_actually_does() {
    println!("\n  spelling                                   what reaches Display");
    println!("  ---------------------------------------------------------------");
    for spelling in Spelling::ALL {
        let peer = echo_server(200, spelling, None).await;
        let provider = build(Adapter::OpenAiCompatible, Binding::Query, &peer.url);
        let mut sink = CollectingSink::new();
        let error = provider
            .stream(turn(), &mut sink, &context())
            .await
            .expect_err("the peer rejects the credential on purpose");
        let text = error.to_string();
        let bracketed = text
            .split_once('[')
            .and_then(|(_, rest)| rest.split_once(']'))
            .map(|(inside, _)| inside.to_owned())
            .unwrap_or_else(|| text.clone());
        println!("  {:<42} {bracketed}", spelling.label());
        println!(
            "  {:<42} readable={}  reconstructible={}",
            "",
            readable_needles()
                .iter()
                .any(|needle| text.contains(needle)),
            fully_decoded(&text).contains(CANARY)
        );
    }
    println!();
}

/// The control without which none of the above means anything: a scrubber that
/// only knows the literal spelling **does** leak, in this file's own harness,
/// against this file's own peer.
#[tokio::test]
async fn positive_control_a_literal_only_scrub_leaks_every_unbriefed_spelling() {
    let literal_only = |text: &str| text.replace(CANARY, "<redacted>");
    let mut leaked = 0usize;

    for spelling in Spelling::ALL {
        let peer = echo_server(200, spelling, None).await;
        let provider = build(Adapter::OpenAiCompatible, Binding::Query, &peer.url);
        let mut sink = CollectingSink::new();
        let _ = provider.stream(turn(), &mut sink, &context()).await;

        // The endpoint's own bytes, through a scrub that knows one spelling.
        let wire =
            String::from_utf8_lossy(&peer.sent.lock().expect("send log poisoned")).into_owned();
        let scrubbed = literal_only(&wire);
        if fully_decoded(&scrubbed).contains(CANARY) {
            leaked += 1;
        }
    }

    assert!(
        leaked >= 3,
        "a literal-only scrub should be defeated by most of these spellings; if it \
         is not, the spellings are not doing what this file claims: {leaked} leaked"
    );
}
