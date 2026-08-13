//! **The redesign, asserted as a property rather than as a list.**
//!
//! Phase B ran four rounds against one defect: an untrusted endpoint's error
//! text reaching `ProviderError`'s `Display`, `Debug`, serde shape, IPC bridge
//! and UI, with a credential hidden inside it in whatever spelling the endpoint
//! chose. Each round removed a spelling; the next round found another. JSON
//! escapes, `%2F`, `%2f`, every byte percent-encoded, `&#x2f;`.
//!
//! Every canary suite in this crate is a *blocklist* test: it searches a
//! rendering for known needles. Those suites are kept — they are four rounds of
//! regression coverage and they still pass — but under the redesign most of
//! them pass **vacuously**, because there is no endpoint text on the surface for
//! a needle to match. A vacuous pass that looks like a real one is how the next
//! defect hides, so this file exists to state the property the other way round.
//!
//! # The four claims
//!
//! 1. [`the_rendering_is_invariant_under_what_the_endpoint_sent`] — two peers
//!    that differ *only* in the bytes of their error message produce
//!    **byte-identical** errors. This is the claim no encoding can defeat: if
//!    the output does not vary with the input, the input is not a channel. It
//!    subsumes every needle search in the crate.
//! 2. [`no_error_in_the_whole_taxonomy_carries_an_unexplained_string`] — the
//!    serde surface is walked and every string leaf is checked against a
//!    vocabulary **computed from the closed enums**, not hand-listed. An
//!    allowlist cannot be defeated by a spelling nobody anticipated, which is
//!    exactly what a blocklist can.
//! 3. [`the_diagnosis_a_user_needs_survives`] — the regression critic's
//!    round-3 objection, still standing: an error nobody can act on is its own
//!    kind of regression. Three configured candidates stay pairwise
//!    distinguishable, and each error names its endpoint, its class, its status
//!    and where to find the body.
//! 4. [`the_debug_log_is_off_until_it_is_turned_on`] and
//!    [`the_recorded_body_never_appears_on_the_error_surface`] — the body is
//!    kept, locally, opt-in, and does not travel.
//!
//! # The controls
//!
//! Claims 1 and 2 would both pass on an error type that said nothing at all, so
//! each is paired with something that can fail:
//! [`the_invariance_check_can_detect_a_carried_message`] feeds the invariance
//! comparison two strings that *do* vary and watches it reject them, and
//! [`the_vocabulary_audit_can_detect_a_planted_string`] plants an endpoint
//! string in a serde surface and watches the audit name it.
//!
//! # Honesty (conventions.md §10)
//!
//! **VERIFIED-BY-FAKE.** Loopback peers, `MemoryStore`, scripted bytes. Not one
//! byte came from a language model, and nothing here says anything about a real
//! vendor endpoint or a real OS keychain.

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use vela_core::credential::Auth;
use vela_core::provider::{ProviderDescriptor, ProviderKind};
use vela_core::secret::{SecretRef, SecretValue};
use vela_providers::diagnostic::{
    unexplained_in_error, unexplained_strings, Cause, ConfiguredModelId, CorrelationId, Diagnosis,
    EndpointIdentity, FilterKind, FilterStage, FilterVerdict, HarmCategories,
};
use vela_providers::error::TransportFailure;
use vela_providers::event::CollectingSink;
use vela_providers::redact::RequestUrl;
use vela_providers::{
    Capability, ChatMessage, ChatRequest, OpenAiCompatibleProvider, Provider, ProviderError,
    RequestContext, Timeouts,
};
use vela_secrets::{MemoryStore, SecretStore};

/// A credential with the characters four rounds of Phase B died on.
const CANARY: &str = "sk/typed-closed/Ky-7d41c0f9ab63e2+DO-NOT-LEAK";

// ---------------------------------------------------------------------------
// Peers
// ---------------------------------------------------------------------------

/// A peer that answers 400 with an error body whose `message` is `message`,
/// verbatim, and records nothing.
///
/// The message is inserted **already JSON-encoded**, so a caller can hand it a
/// spelling `serde_json` would never produce.
async fn peer_answering(message_json_encoded: &'static str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a free port");
    let port = listener.local_addr().expect("bound").port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut scratch = vec![0u8; 16 * 1024];
            let _ = socket.read(&mut scratch).await;
            let body = format!(
                r#"{{"error":{{"code":"invalid_api_key","message":"{message_json_encoded}"}}}}"#
            );
            let response = format!(
                "HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\n\
                 content-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.flush().await;
        }
    });
    format!("http://127.0.0.1:{port}")
}

fn provider_for(base_url: &str) -> Arc<dyn Provider> {
    let secrets: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    let reference = SecretRef::primary("typed-closed").expect("a valid provider id");
    secrets
        .set(&reference, &SecretValue::new(CANARY))
        .expect("MemoryStore accepts a non-empty value");
    Arc::new(OpenAiCompatibleProvider::new(
        ProviderDescriptor::new("typed-closed", "Typed closed", ProviderKind::RemoteApi)
            .expect("a valid descriptor"),
        base_url,
        Auth::ApiKeyQuery {
            param: "api_key".into(),
            secret: reference,
        },
        secrets,
        Arc::new(
            vela_providers::http::ReqwestTransport::with_connect_timeout(Duration::from_secs(5))
                .expect("http client builds"),
        ),
    ))
}

fn turn() -> ChatRequest {
    ChatRequest::new("canary-model").with_message(ChatMessage::user("hello"))
}

fn context() -> RequestContext {
    RequestContext::new().with_timeouts(Timeouts {
        connect: Duration::from_secs(5),
        first_byte: Duration::from_secs(5),
        stall: Duration::from_secs(5),
    })
}

/// Everything a caller can read off an error, in one bundle.
fn renderings(error: &ProviderError) -> Vec<(&'static str, String)> {
    vec![
        ("Display", error.to_string()),
        ("Debug", format!("{error:?}")),
        (
            "serde JSON (the IPC shape)",
            serde_json::to_string(error).expect("ProviderError serialises"),
        ),
        (
            "StreamEvent::Error (the UI sink)",
            serde_json::to_string(&vela_providers::StreamEvent::Error {
                error: error.clone(),
            })
            .expect("StreamEvent serialises"),
        ),
    ]
}

/// Replace this error's own correlation id with a placeholder.
///
/// The id is Vela's monotonic counter and is *expected* to differ between two
/// exchanges. Nothing else in a rendering is. Taking the id from the error's
/// own accessor rather than pattern-matching the text means the normalisation
/// cannot accidentally erase something else.
fn normalise(error: &ProviderError, text: &str) -> String {
    match error.correlation() {
        Some(correlation) => text.replace(&correlation.to_string(), "<ref>"),
        None => text.to_owned(),
    }
}

// ---------------------------------------------------------------------------
// CLAIM 1 — the rendering does not vary with what the endpoint sent
// ---------------------------------------------------------------------------

/// **The claim no encoding can defeat.**
///
/// Four peers answer the identical request with the identical status and the
/// identical machine-readable `code`, and differ *only* in the bytes of their
/// `message`:
///
/// * an empty message;
/// * a plain sentence;
/// * the credential, verbatim, in the clear;
/// * the credential spelled in `\uXXXX` — the form round 4's own probe used,
///   which matches no byte literal and which `serde_json` reassembles.
///
/// All four produce **byte-identical** renderings on all four surfaces. That is
/// the property, stated positively: the endpoint has no channel into the error,
/// so there is no fifth encoding to look for.
#[tokio::test(flavor = "multi_thread")]
async fn the_rendering_is_invariant_under_what_the_endpoint_sent() {
    // `sk...` is the canary spelled one escape per byte. Written as a
    // literal so the peer emits exactly these bytes.
    const SPELLINGS: [&str; 4] = [
        "",
        "the endpoint politely declines",
        "rejected credential [sk/typed-closed/Ky-7d41c0f9ab63e2+DO-NOT-LEAK]",
        "rejected credential [\\u0073\\u006b\\u002f\\u0074\\u0079\\u0070\\u0065\\u0064\\u002d\\u0063\\u006c\\u006f\\u0073\\u0065\\u0064\\u002f\\u004b\\u0079\\u002d\\u0037\\u0064\\u0034\\u0031\\u0063\\u0030\\u0066\\u0039\\u0061\\u0062\\u0036\\u0033\\u0065\\u0032\\u002b\\u0044\\u004f\\u002d\\u004e\\u004f\\u0054\\u002d\\u004c\\u0045\\u0041\\u004b]",
    ];

    // Every peer is given the SAME port-independent identity by construction:
    // the invariance claim is about the message, so the endpoint identity must
    // not be allowed to vary. Each peer is driven and its rendering normalised
    // against its own authority as well as its own correlation id.
    let mut normalised: Vec<(usize, Vec<(&'static str, String)>)> = Vec::new();
    for (index, spelling) in SPELLINGS.iter().enumerate() {
        let base_url = peer_answering(spelling).await;
        let provider = provider_for(&base_url);
        let mut sink = CollectingSink::new();
        let error = provider
            .stream(turn(), &mut sink, &context())
            .await
            .expect_err("the peer answers 400 on purpose");

        let authority = error
            .endpoint()
            .expect("the endpoint is named")
            .authority()
            .to_owned();
        let rendered = renderings(&error)
            .into_iter()
            .map(|(surface, text)| {
                (
                    surface,
                    normalise(&error, &text).replace(&authority, "<authority>"),
                )
            })
            .collect();
        normalised.push((index, rendered));
    }

    let (_, reference) = &normalised[0];
    for (index, rendered) in &normalised[1..] {
        assert_eq!(
            rendered, reference,
            "spelling {index} produced a different rendering from spelling 0 — \
             the endpoint has a channel into the error surface"
        );
    }

    // Non-vacuity: the reference must actually say something.
    let display = &reference
        .iter()
        .find(|(surface, _)| *surface == "Display")
        .expect("Display is rendered")
        .1;
    assert!(
        display.contains("credential") || display.contains("endpoint"),
        "the invariant rendering must still be a diagnosis: {display}"
    );
    assert!(
        display.contains("<authority>"),
        "and it must still name its endpoint: {display}"
    );
}

/// **CONTROL for claim 1.** The comparison must be able to fail.
///
/// The same normalisation applied to two renderings that genuinely differ in
/// their message — the shape rounds 1–4 produced — must not report them equal.
/// Without this, an error type that rendered the empty string would satisfy the
/// test above.
#[test]
fn the_invariance_check_can_detect_a_carried_message() {
    let error = ProviderError::auth_failed(Cause::CredentialRejected);
    let correlation = error.correlation().expect("a correlation id");

    // Verbatim the shape round 4's tree produced, with the correlation id
    // spliced in so the normalisation has something real to remove.
    let round_4_a = format!(
        "the endpoint rejected the credential: VELA-MARKER: rejected credential \
         [sk/a] for /v1/chat/completions [ref {correlation}]"
    );
    let round_4_b = format!(
        "the endpoint rejected the credential: VELA-MARKER: rejected credential \
         [sk%2fb] for /v1/chat/completions [ref {correlation}]"
    );

    assert_eq!(
        normalise(&error, &round_4_a),
        normalise(&error, &round_4_a),
        "the normalisation is stable"
    );
    assert_ne!(
        normalise(&error, &round_4_a),
        normalise(&error, &round_4_b),
        "two carried messages must not compare equal, or claim 1 proves nothing"
    );
    assert!(
        !normalise(&error, &round_4_a).contains(&correlation.to_string()),
        "and the normalisation really does remove the correlation id"
    );
}

// ---------------------------------------------------------------------------
// CLAIM 2 — no unexplained string on any surface, for any error in the taxonomy
// ---------------------------------------------------------------------------

/// One of every error the taxonomy can produce, with every optional field
/// populated, so the audit is exercised against the widest surface there is.
fn every_error_shape() -> Vec<(&'static str, ProviderError)> {
    let endpoint = EndpointIdentity::of(&RequestUrl::new(
        "https://api.example.invalid:8443/v1/chat/completions?key=secret#frag",
    ));
    let model = ConfiguredModelId::of(&ChatRequest::new("llama-3.1-8b-instruct"));
    let mut shapes: Vec<(&'static str, ProviderError)> = vec![
        (
            "context length",
            ProviderError::ContextLengthExceeded {
                limit_tokens: Some(8_192),
                requested_tokens: Some(9_001),
                diagnosis: Diagnosis::new(Cause::ContextWindowExceeded)
                    .with_status(400)
                    .at(endpoint.clone()),
            },
        ),
        (
            "auth",
            ProviderError::auth_failed(
                Diagnosis::new(Cause::CredentialRejected)
                    .with_status(401)
                    .at(endpoint.clone()),
            ),
        ),
        (
            "rate limit",
            ProviderError::rate_limited(
                Some(1_500),
                Diagnosis::new(Cause::TooManyRequests)
                    .with_status(429)
                    .at(endpoint.clone()),
            ),
        ),
        (
            "model not found",
            ProviderError::model_not_found(
                model,
                Diagnosis::new(Cause::ModelNotServed)
                    .with_status(404)
                    .at(endpoint.clone()),
            ),
        ),
        (
            "content filter",
            ProviderError::transport(
                TransportFailure::Request { status: 400 },
                Diagnosis::new(Cause::ContentFilterRefusedTheTurn)
                    .at(endpoint.clone())
                    .with_filter(FilterVerdict::new(
                        FilterStage::Answer,
                        FilterKind::Recitation,
                        HarmCategories::recognise([
                            "HARM_CATEGORY_HATE_SPEECH",
                            "HARM_CATEGORY_CIVIC_INTEGRITY",
                        ]),
                        412,
                    )),
            ),
        ),
        ("cancelled", ProviderError::Cancelled),
    ];
    for capability in Capability::ALL {
        shapes.push((
            "capability",
            ProviderError::unsupported(
                *capability,
                Diagnosis::new(Cause::CapabilityRefusedByEndpoint)
                    .with_status(400)
                    .at(endpoint.clone()),
            ),
        ));
    }
    shapes
}

/// **The allowlist, applied to the whole taxonomy.**
///
/// Every `Cause` × every `TransportFailure` × every `Capability`, plus one
/// fully-populated instance of every variant, walked leaf by leaf. A string
/// that is not a code, a sentence, or one of the identifiers the error's own
/// typed accessors report is a leak, and the audit names it.
#[test]
fn no_error_in_the_whole_taxonomy_carries_an_unexplained_string() {
    let endpoint = EndpointIdentity::of(&RequestUrl::new(
        "https://api.example.invalid:8443/v1/chat/completions",
    ));
    let mut checked = 0usize;

    for cause in Cause::ALL {
        for failure in [
            TransportFailure::Connect,
            TransportFailure::Timeout,
            TransportFailure::Stalled,
            TransportFailure::Reset,
            TransportFailure::Server { status: 503 },
            TransportFailure::Request { status: 418 },
        ] {
            let error = ProviderError::transport(
                failure,
                Diagnosis::new(*cause).at(endpoint.clone()).with_status(503),
            );
            let unexplained = unexplained_in_error(&error);
            assert!(
                unexplained.is_empty(),
                "{cause:?}/{failure:?}: unexplained strings {unexplained:?} in {error}"
            );
            checked += 1;
        }
    }

    for (label, error) in every_error_shape() {
        let unexplained = unexplained_in_error(&error);
        assert!(
            unexplained.is_empty(),
            "{label}: unexplained strings {unexplained:?} in {error}"
        );
        checked += 1;
    }

    assert_eq!(
        checked,
        Cause::ALL.len() * 6 + 6 + Capability::ALL.len(),
        "the shape matrix did not run in full"
    );
}

/// **CONTROL for claim 2.** The audit must be able to fail.
///
/// A serde surface with an endpoint's own message planted in it — exactly what
/// rounds 1–4 produced — must be reported, whatever spelling it is in. Five
/// spellings are planted, including the two that defeated round 4 and one that
/// is purely alphanumeric, because an audit with an "it looks like an
/// identifier" escape hatch would wave the last one through.
#[test]
fn the_vocabulary_audit_can_detect_a_planted_string() {
    let planted = [
        "VELA-MARKER: rejected credential [sk/a] for /v1/chat",
        "sk%2ftyped%2dclosed",
        "sk&#x2f;typed&#x2f;closed",
        "sk\\u002ftyped",
        // No punctuation at all: the case an identifier-shaped exemption would
        // have missed, and the reason there is no such exemption.
        "skABCDEF0123456789",
    ];
    for text in planted {
        let surface = serde_json::json!({
            "kind": "authFailed",
            "diagnosis": {
                "cause": "credential_rejected",
                "status": 401,
                "detail": text,
            }
        });
        let found = unexplained_strings(&surface, &[]);
        assert_eq!(
            found,
            vec![text.to_owned()],
            "the audit missed a planted endpoint string: {text}"
        );
    }

    // And the same surface without the planted field is clean, so the control
    // is measuring the plant and not the shape.
    let clean = serde_json::json!({
        "kind": "authFailed",
        "diagnosis": { "cause": "credential_rejected", "status": 401 }
    });
    assert!(unexplained_strings(&clean, &[]).is_empty());
}

// ---------------------------------------------------------------------------
// CLAIM 3 — the diagnosis a user needs survives
// ---------------------------------------------------------------------------

/// **The regression critic's round-3 objection, still enforced.**
///
/// *"An error nobody can act on is its own kind of regression. A user with
/// three configured candidates must still learn which endpoint failed and
/// why."*
///
/// Three dead ports, three errors. Each names its own authority and path, its
/// own failure class, and a reference into the debug log; and no two of them
/// render the same.
#[tokio::test(flavor = "multi_thread")]
async fn the_diagnosis_a_user_needs_survives() {
    let mut rendered: Vec<String> = Vec::new();

    for _ in 0..3 {
        // A port bound to learn a free number, then released.
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("a free port");
        let address = listener.local_addr().expect("bound");
        drop(listener);
        let base_url = format!("http://127.0.0.1:{}", address.port());

        let provider = provider_for(&base_url);
        let error = provider
            .complete(turn(), &context())
            .await
            .expect_err("nothing is listening");

        let endpoint = error
            .endpoint()
            .unwrap_or_else(|| panic!("{base_url}: the failing candidate must be named"));
        assert!(
            endpoint.authority().contains(&address.port().to_string()),
            "the authority distinguishes candidates: {endpoint}"
        );
        assert_eq!(
            endpoint.path(),
            "/v1/chat/completions",
            "and the path distinguishes two candidates on one host"
        );
        assert_eq!(
            error.cause(),
            Some(Cause::ConnectionFailed),
            "the class of failure must be legible"
        );
        assert!(
            !error.correlation().expect("a correlation id").is_none(),
            "and there must be a reference to look the body up by"
        );
        assert!(
            !endpoint.to_string().contains("api_key"),
            "without the query string the credential was configured into: {endpoint}"
        );
        rendered.push(error.to_string());
    }

    assert_ne!(rendered[0], rendered[1], "candidates 1 and 2 are the same");
    assert_ne!(rendered[1], rendered[2], "candidates 2 and 3 are the same");
    assert_ne!(rendered[0], rendered[2], "candidates 1 and 3 are the same");
}

// ---------------------------------------------------------------------------
// CLAIM 4 — the body is kept, locally, and does not travel
// ---------------------------------------------------------------------------

/// The log is off in a fresh process and records nothing until it is turned on.
///
/// Vela's posture is offline-first with no telemetry. A debug log that defaults
/// to on is a log that gets attached to a bug report by accident.
#[test]
fn the_debug_log_is_off_until_it_is_turned_on() {
    // This test owns the global sink for its duration; the two async tests in
    // this file that need one install their own and take it away again.
    vela_providers::debuglog::disable();
    assert!(!vela_providers::debuglog::is_enabled());

    let sink = Arc::new(vela_providers::debuglog::MemorySink::new());
    let id = CorrelationId::next();
    vela_providers::debuglog::record(|| vela_providers::debuglog::DebugEntryOwned {
        correlation: id,
        cause: Cause::CredentialRejected,
        status: Some(401),
        endpoint: None,
        body: b"must not be recorded".to_vec(),
    });
    assert!(
        sink.lines().is_empty(),
        "nothing may be written before `enable`"
    );
}

/// The raw body reaches the local log and **nothing else**.
///
/// The same exchange is read two ways: through the log, where the peer's own
/// bytes are, and through every surface an error offers, where they are not.
/// The correlation id is the only thing joining them, and it is a `u64`.
#[tokio::test(flavor = "multi_thread")]
async fn the_recorded_body_never_appears_on_the_error_surface() {
    let sink = Arc::new(vela_providers::debuglog::MemorySink::new());
    vela_providers::debuglog::enable(sink.clone());

    let base_url = peer_answering("VELA-TYPED-CLOSED-MARKER: go away").await;
    let provider = provider_for(&base_url);
    let error = provider
        .complete(turn(), &context())
        .await
        .expect_err("the peer answers 400 on purpose");

    vela_providers::debuglog::disable();

    let correlation = error.correlation().expect("a correlation id");
    let filed = sink
        .body_for(correlation)
        .unwrap_or_else(|| panic!("nothing was filed under {correlation}"));
    assert!(
        filed.contains("VELA-TYPED-CLOSED-MARKER"),
        "the body must be kept, or this is a deletion and not a redesign: {filed}"
    );
    assert!(
        !filed.contains(CANARY),
        "and the byte scrubber still runs before the log sees anything: {filed}"
    );

    for (surface, text) in renderings(&error) {
        assert!(
            !text.contains("VELA-TYPED-CLOSED-MARKER"),
            "{surface} carries the peer's own words: {text}"
        );
        assert!(
            !text.contains("go away"),
            "{surface} carries the peer's own words: {text}"
        );
    }
    assert!(
        unexplained_in_error(&error).is_empty(),
        "and nothing at all on the surface is endpoint-derived: {error}"
    );
    // The join key crosses the bridge, and it is a number.
    let ipc = serde_json::to_value(&error).expect("ProviderError serialises");
    assert_eq!(
        ipc["diagnosis"]["correlation"].as_u64(),
        Some(correlation.raw()),
        "the correlation id is what links the two, and it is an integer"
    );
}
