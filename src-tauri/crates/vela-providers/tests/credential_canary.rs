//! **A credential must not survive into any error Vela produces.** The canary
//! test for `vela-providers`, alongside the `CANARY` tests in `vela-secrets`.
//!
//! # What this file is for
//!
//! Phase B's security review found a real leak. `Auth::ApiKeyQuery` builds the
//! credential into the request URL as a query parameter — Google's documented
//! alternative to the key header, and available to any OpenAI-compatible or
//! discovery configuration. Every `reqwest`-level failure funnelled through
//! `map_reqwest_error`, which called `error.to_string()`; `reqwest`'s `Display`
//! ends with `" for url ({url})"`, query string included; and `detail()`, which
//! truncates at 200 characters and strips control characters, **does not
//! redact**. The key arrived intact in `ProviderError::Transport`, and from
//! there in its `Display`, its `Debug` and its serde JSON.
//!
//! The serde JSON is the part that matters most: it is the shape
//! `ProviderError` is derived to serialise **across the IPC bridge to the
//! low-trust WebView**, and the failures that produce it are the commonest
//! there are — connection refused, TLS handshake failure, an unreachable
//! address, a body that dies mid-stream.
//!
//! Before this file, `vela-providers` had **no credential test at all**.
//!
//! # How it is measured
//!
//! Real providers, the real [`ReqwestTransport`], real loopback sockets, real
//! failures — a closed port, a TLS handshake against a server that speaks no
//! TLS, an unroutable address, a server that never answers, and a body that
//! stops halfway with bytes still promised. Each resulting `ProviderError` is
//! rendered three ways and searched for the canary, in the raw form, in the
//! percent-encoded form the URL would carry, and by the distinctive core that
//! both share — so a *partially* truncated key fails too.
//!
//! Two controls keep the assertions from passing vacuously:
//!
//! * every case asserts that a failure actually happened and that its `detail`
//!   is non-empty, so "no leak" can never mean "no error";
//! * [`the_detector_catches_the_leak_this_file_exists_for`] is the **positive
//!   control**: it rebuilds, by hand, the exact error the tree produced before
//!   the fix — `detail()` over `format!("error sending request for url ({url})")`
//!   with the live URL — and asserts the detector finds the canary in all three
//!   renderings. If that test ever passes silently, every assertion here is
//!   worthless.
//!
//! # Honesty (conventions.md §10)
//!
//! **VERIFIED-BY-FAKE.** The credential store is `MemoryStore` and the
//! endpoints are deliberately broken loopback sockets. This proves what Vela's
//! own error type carries. It says nothing about any real vendor endpoint and
//! nothing about the OS keychain.

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use vela_core::credential::Auth;
use vela_core::provider::{ProviderDescriptor, ProviderKind};
use vela_core::secret::{SecretRef, SecretValue};
use vela_providers::diagnostic::{Cause, Diagnosis, EndpointIdentity};
use vela_providers::error::TransportFailure;
use vela_providers::event::CollectingSink;
use vela_providers::google::GoogleProvider;
use vela_providers::http::ReqwestTransport;
use vela_providers::openai_compatible::OpenAiCompatibleProvider;
use vela_providers::redact::{percent_encode, RequestUrl};
use vela_providers::{ChatMessage, ChatRequest, Provider, ProviderError, RequestContext, Timeouts};
use vela_secrets::{MemoryStore, SecretStore};

/// The planted credential. Deliberately contains a `/`, so that its raw form
/// and its percent-encoded form differ and both have to be looked for.
const CANARY: &str = "canary/AIza-9f3a7d1c5e2b4806-DO-NOT-LEAK";

/// The part of the canary that survives percent-encoding untouched. Searching
/// for this as well is what makes a *partial* leak — a key cut in half by
/// `detail()`'s 200-character truncation — a failure rather than a pass.
const CANARY_CORE: &str = "9f3a7d1c5e2b4806";

fn needles() -> Vec<String> {
    vec![
        CANARY.to_owned(),
        percent_encode(CANARY),
        CANARY_CORE.to_owned(),
    ]
}

// ---------------------------------------------------------------------------
// The assertion
// ---------------------------------------------------------------------------

/// Every surface a `ProviderError` is rendered through: the message a log line
/// or a fallback string gets, the diagnostic a `{:?}` produces, and the JSON
/// that crosses the IPC bridge.
fn renderings(error: &ProviderError) -> Vec<(&'static str, String)> {
    vec![
        ("Display", error.to_string()),
        ("Debug", format!("{error:?}")),
        (
            "serde JSON",
            serde_json::to_string(error).expect("ProviderError serialises"),
        ),
    ]
}

fn found_canary(error: &ProviderError) -> Option<(&'static str, String, String)> {
    for (surface, text) in renderings(error) {
        for needle in needles() {
            if text.contains(&needle) {
                return Some((surface, needle, text));
            }
        }
    }
    None
}

/// The assertion this whole file exists to make.
#[track_caller]
fn assert_no_credential_in_the_error(label: &str, error: &ProviderError) {
    if let Some((surface, needle, text)) = found_canary(error) {
        panic!("{label}: the credential reached {surface} (matched {needle:?}):\n  {text}");
    }
}

/// Guards against the failure mode that would make every negative assertion
/// pass for the wrong reason: an error that says nothing at all.
#[track_caller]
fn assert_the_failure_is_real(label: &str, error: &ProviderError) {
    match error {
        ProviderError::Transport { failure, .. } => assert!(
            matches!(
                failure,
                TransportFailure::Connect | TransportFailure::Timeout | TransportFailure::Reset
            ),
            "{label}: expected a transport-level failure, got {failure:?}"
        ),
        ProviderError::MalformedResponse { .. } => {}
        other => panic!("{label}: expected a transport failure, got {other:?}"),
    }
    let diagnosis = error.diagnosis().expect("a transport failure has a diagnosis");
    assert!(
        !diagnosis.cause().message().is_empty(),
        "{label}: an error with nothing to say would pass every leak assertion vacuously"
    );
    // Round 1's file, strengthened by the redesign rather than retired: the
    // question is no longer "did the credential get through" but "did anything
    // the endpoint chose get through".
    let unexplained = vela_providers::diagnostic::unexplained_in_error(error);
    assert!(
        unexplained.is_empty(),
        "{label}: the error surface carries text the closed vocabulary does not \
         explain — {unexplained:?}\n  {error}"
    );
}

// ---------------------------------------------------------------------------
// Deliberately broken endpoints
// ---------------------------------------------------------------------------

/// A port nothing is listening on: bound to learn a free one, then released.
async fn refused_port() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a free port");
    let port = listener.local_addr().expect("bound").port();
    drop(listener);
    format!("http://127.0.0.1:{port}")
}

/// A listener that speaks plain TCP, addressed as `https://`. The TLS handshake
/// cannot complete, which is the third failure the review named.
async fn tls_handshake_failure() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a free port");
    let port = listener.local_addr().expect("bound").port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut scratch = [0u8; 1024];
            let _ = socket.read(&mut scratch).await;
            // Not a TLS record in sight.
            let _ = socket.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
        }
    });
    format!("https://127.0.0.1:{port}")
}

/// A listener that accepts and then says nothing, ever. Vela's own first-byte
/// deadline is what ends this one.
async fn silent_server() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a free port");
    let port = listener.local_addr().expect("bound").port();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((socket, _)) = listener.accept().await {
            held.push(socket); // hold it open; answer nothing
        }
    });
    format!("http://127.0.0.1:{port}")
}

/// A 200 that promises 4096 bytes, sends a few, and drops the connection —
/// the mid-stream death that hits `ReqwestBody::next_chunk` rather than `send`.
async fn dies_mid_body() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a free port");
    let port = listener.local_addr().expect("bound").port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut scratch = [0u8; 4096];
            let _ = socket.read(&mut scratch).await;
            let _ = socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\n\
                      content-type: text/event-stream\r\n\
                      content-length: 4096\r\n\r\n\
                      data: {\"candidates\":[",
                )
                .await;
            let _ = socket.flush().await;
            drop(socket);
        }
    });
    format!("http://127.0.0.1:{port}")
}

/// `192.0.2.1` is TEST-NET-1 (RFC 5737): reserved for documentation and routed
/// nowhere. Whether the container answers "no route" or nothing at all, the
/// result is a `reqwest` error on the send path — the one path that carries the
/// URL, and therefore the credential.
fn unroutable() -> String {
    "http://192.0.2.1:9/".to_owned()
}

// ---------------------------------------------------------------------------
// Providers with a credential planted
// ---------------------------------------------------------------------------

fn store(provider_id: &str) -> (Arc<MemoryStore>, SecretRef) {
    let secrets = Arc::new(MemoryStore::new());
    let reference = SecretRef::primary(provider_id).expect("a valid provider id");
    secrets
        .set(&reference, &SecretValue::new(CANARY))
        .expect("MemoryStore accepts a non-empty value");
    (secrets, reference)
}

fn descriptor(id: &str) -> ProviderDescriptor {
    ProviderDescriptor::new(id, "Canary", ProviderKind::RemoteApi).expect("a valid descriptor")
}

/// The reported shape: Google, credential in the query string.
fn google_with_key_in_the_url(base_url: &str) -> Arc<dyn Provider> {
    let (secrets, secret) = store("canary-google");
    Arc::new(GoogleProvider::new(
        descriptor("canary-google"),
        base_url,
        Auth::ApiKeyQuery {
            param: "key".into(),
            secret,
        },
        secrets,
        Arc::new(ReqwestTransport::with_connect_timeout(Duration::from_millis(400)).unwrap()),
    ))
}

/// The same binding on an OpenAI-compatible endpoint — a user-configurable
/// shape, not a Google-only one.
fn openai_compatible_with_key_in_the_url(base_url: &str) -> Arc<dyn Provider> {
    let (secrets, secret) = store("canary-compat-query");
    Arc::new(OpenAiCompatibleProvider::new(
        descriptor("canary-compat-query"),
        base_url,
        Auth::ApiKeyQuery {
            param: "api_key".into(),
            secret,
        },
        secrets,
        Arc::new(ReqwestTransport::with_connect_timeout(Duration::from_millis(400)).unwrap()),
    ))
}

/// The header shape. It never went through the URL, but a credential is a
/// credential: the same three renderings must be clean.
fn openai_compatible_with_a_bearer_token(base_url: &str) -> Arc<dyn Provider> {
    let (secrets, secret) = store("canary-compat-bearer");
    Arc::new(OpenAiCompatibleProvider::new(
        descriptor("canary-compat-bearer"),
        base_url,
        Auth::Bearer { secret },
        secrets,
        Arc::new(ReqwestTransport::with_connect_timeout(Duration::from_millis(400)).unwrap()),
    ))
}

fn context() -> RequestContext {
    RequestContext::new().with_timeouts(Timeouts {
        connect: Duration::from_millis(400),
        first_byte: Duration::from_millis(400),
        stall: Duration::from_millis(400),
    })
}

fn turn() -> ChatRequest {
    ChatRequest::new("canary-model").with_message(ChatMessage::user("hi"))
}

/// Both paths, because both funnel through the transport and only one of them
/// reads the body incrementally.
async fn errors_from_both_paths(
    provider: &Arc<dyn Provider>,
) -> Vec<(&'static str, ProviderError)> {
    let mut out = Vec::new();

    let completed = provider.complete(turn(), &context()).await;
    out.push((
        "complete()",
        completed.expect_err("the endpoint is broken on purpose"),
    ));

    let mut sink = CollectingSink::new();
    let streamed = provider.stream(turn(), &mut sink, &context()).await;
    out.push((
        "stream()",
        streamed.expect_err("the endpoint is broken on purpose"),
    ));

    out
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

async fn assert_every_endpoint_is_clean(
    provider_label: &str,
    build: fn(&str) -> Arc<dyn Provider>,
) {
    let endpoints = [
        ("connection refused", refused_port().await),
        ("TLS handshake failure", tls_handshake_failure().await),
        ("no route to host", unroutable()),
        ("no response headers", silent_server().await),
        ("body dies mid-stream", dies_mid_body().await),
    ];

    for (endpoint_label, base_url) in endpoints {
        let provider = build(&base_url);
        for (path, error) in errors_from_both_paths(&provider).await {
            let label = format!("{provider_label} / {endpoint_label} / {path}");
            assert_the_failure_is_real(&label, &error);
            assert_no_credential_in_the_error(&label, &error);
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn no_transport_failure_leaks_a_query_string_credential_google() {
    assert_every_endpoint_is_clean("google, key in the URL", google_with_key_in_the_url).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn no_transport_failure_leaks_a_query_string_credential_openai_compatible() {
    assert_every_endpoint_is_clean(
        "openai-compatible, key in the URL",
        openai_compatible_with_key_in_the_url,
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn no_transport_failure_leaks_a_header_credential() {
    assert_every_endpoint_is_clean(
        "openai-compatible, bearer token",
        openai_compatible_with_a_bearer_token,
    )
    .await;
}

/// The credential still has to *work*. A redaction that redacted the wire form
/// would pass every assertion above and break every request.
#[tokio::test(flavor = "multi_thread")]
async fn the_credential_is_still_on_the_url_that_goes_to_the_socket() {
    let url = RequestUrl::new("https://example.invalid/v1beta/models/m:generateContent")
        .with_query_credential("key", &SecretValue::new(CANARY));

    assert!(
        url.expose().contains(&percent_encode(CANARY)),
        "the wire form must still carry the credential, or nothing authenticates"
    );
    assert!(url.carries_credential());
}

/// **POSITIVE CONTROL.** The detector must be able to fail.
///
/// # This control changed shape, and the reason is the whole point
///
/// It used to build the pre-fix error by hand — `reqwest`'s `Display` for a
/// send failure is `"error sending request for url ({url})"`, and the old
/// `map_reqwest_error` passed exactly that through `detail()` into
/// `ProviderError::Transport` — and then assert the canary was found on every
/// rendering.
///
/// **That error can no longer be constructed.** `ProviderError::transport` no
/// longer accepts a string of any kind, and `error::detail` no longer exists;
/// the old call does not compile, which `diagnostic::Diagnosis`'s `compile_fail`
/// doctests pin. So the control does the next most useful thing: it proves the
/// *detector* still works, by pointing it at the leaking text itself. If the
/// needles ever stop matching that string, every negative assertion in this
/// file is looking for the wrong thing.
#[test]
fn the_detector_catches_the_leak_this_file_exists_for() {
    let url = RequestUrl::new(
        "https://generativelanguage.googleapis.com/v1beta/models/m:generateContent?alt=sse",
    )
    .with_query_credential("key", &SecretValue::new(CANARY));

    // Verbatim the shape reqwest 0.12.28 produces, with the live URL — the text
    // that used to become a `detail`.
    let leaking_text = format!("error sending request for url ({})", url.expose());
    let matched: Vec<String> = needles()
        .into_iter()
        .filter(|needle| leaking_text.contains(needle))
        .collect();
    assert!(
        !matched.is_empty(),
        "the detector no longer recognises the leak it exists for: {leaking_text}"
    );
    assert!(
        leaking_text.contains(CANARY_CORE),
        "and it recognises the partial form too"
    );
}

/// The other half of the control: the same failure, built the way the fixed
/// code builds it. Same URL, same failure, same error type.
#[test]
fn the_same_failure_built_through_the_choke_point_is_clean() {
    let url = RequestUrl::new(
        "https://generativelanguage.googleapis.com/v1beta/models/m:generateContent?alt=sse",
    )
    .with_query_credential("key", &SecretValue::new(CANARY));

    let error = ProviderError::transport(
        TransportFailure::Connect,
        Diagnosis::new(Cause::ConnectionFailed).at(EndpointIdentity::of(&url)),
    );

    assert_no_credential_in_the_error("a transport failure through the chokepoint", &error);
    // Rounds 1–4 asserted `<redacted>` was visible here, because the endpoint
    // was a redacted URL string and a URL that had lost its query would have
    // been a deletion. `EndpointIdentity` drops the query whole, so there is
    // nothing to redact — and the two parts that distinguish one configured
    // candidate from another are both still present.
    let endpoint = error.endpoint().expect("the endpoint is still named");
    assert_eq!(
        endpoint.authority(),
        "https://generativelanguage.googleapis.com"
    );
    assert_eq!(endpoint.path(), "/v1beta/models/m:generateContent");
    assert!(!error.to_string().contains("<redacted>"));
}

/// **The structural guarantee, enforced against the tree rather than narrated.**
///
/// The fix is not "remember to redact in `map_reqwest_error`" — it is that a
/// credential can only leave its wrapper at a choke point. Before this round,
/// four adapters each did `format!("{url}{sep}{name}={}", urlencode(v.expose()))`
/// with their own private percent-encoder, producing a `String` that had
/// forgotten what was in it; now they all call `HttpRequest::with_auth`.
///
/// So: `expose()` may appear only in the seam that hands bytes to the socket
/// (`http.rs`) and in the type that owns the redaction (`redact.rs`). A fifth
/// adapter that reintroduces the old pattern fails here, before it can fail in
/// production.
#[test]
fn a_credential_leaves_its_wrapper_only_at_the_choke_point() {
    const ALLOWED: [&str; 2] = ["http.rs", "redact.rs"];

    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    assert!(src.is_dir(), "provider sources missing at {src:?}");

    let mut offenders: Vec<String> = Vec::new();
    let mut scanned = 0usize;
    let mut stack = vec![src];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)
            .expect("readable directory")
            .flatten()
        {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().is_none_or(|extension| extension != "rs") {
                continue;
            }
            scanned += 1;
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            if ALLOWED.contains(&name.as_str()) {
                continue;
            }
            let text = std::fs::read_to_string(&path).expect("readable source");
            for (number, line) in text.lines().enumerate() {
                let code = line.split("//").next().unwrap_or_default();
                if code.contains(".expose()") {
                    offenders.push(format!("{name}:{}: {}", number + 1, line.trim()));
                }
            }
        }
    }

    assert!(
        scanned > 10,
        "the scan found only {scanned} files — it is not looking at the crate"
    );
    assert!(
        offenders.is_empty(),
        "credential material may only leave its wrapper in {ALLOWED:?}; found:\n  {}",
        offenders.join("\n  ")
    );
}

/// An endpoint that echoes the key back at us is the other direction of the
/// same leak: `read_to_end` feeds error bodies straight into
/// `map_error_response`, which builds a `detail`.
#[tokio::test(flavor = "multi_thread")]
async fn an_endpoint_that_echoes_the_key_back_does_not_get_it_into_an_error() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a free port");
    let port = listener.local_addr().expect("bound").port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut scratch = [0u8; 8192];
            let _ = socket.read(&mut scratch).await;
            // A real shape: several vendors quote the offending request back.
            let body = format!(
                r#"{{"error":{{"code":400,"status":"INVALID_ARGUMENT","message":"API key not valid: key={} (request: /v1beta/models/m:generateContent?key={})"}}}}"#,
                percent_encode(CANARY),
                percent_encode(CANARY)
            );
            let _ = socket
                .write_all(
                    format!(
                        "HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await;
            let _ = socket.flush().await;
        }
    });

    let provider = google_with_key_in_the_url(&format!("http://127.0.0.1:{port}"));
    let error = provider
        .complete(turn(), &context())
        .await
        .expect_err("a 400 is an error");

    assert!(
        !matches!(error, ProviderError::Cancelled),
        "expected the endpoint's own rejection, got {error:?}"
    );
    assert_no_credential_in_the_error("an endpoint echoing the key back", &error);
}
