//! **The OpenAI-compatible adapter, against the four live matrix profiles.**
//!
//! Every test here starts a capability-matrix profile as a real OS process on a
//! real loopback port and drives it through [`CompatProvider`] over real TCP
//! with the real `reqwest` client. Nothing is stubbed between `ChatRequest` and
//! the socket.
//!
//! # Honesty (conventions.md §10)
//!
//! **Every result in this file is VERIFIED-BY-FAKE.** The four servers are
//! deterministic mocks and not one byte of their output came from a language
//! model. They prove that the adapter survives *the recorded behaviour of
//! endpoints that break in the ways the matrix documents*. They prove nothing
//! about a real llama.cpp, Ollama, vLLM or LM Studio server: GATE M Part 2 is
//! unreachable from this container, and the divergent shapes those servers
//! actually emit are covered by unit tests over scripted bytes, which are also
//! fakes.
//!
//! Note what the matrix profiles are, for this adapter's purposes: they serve
//! `/props` and `/v1/models`, so they present as a **llama.cpp-shaped** server.
//! That is the one family whose discovery path is exercised live here.

use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use vela_core::credential::Auth;
use vela_core::provider::{ProviderDescriptor, ProviderKind};
use vela_providers::capability::Support;
use vela_providers::compat::{CompatOptions, CompatProvider, ServerFlavour};
use vela_providers::event::CollectingSink;
use vela_providers::http::ReqwestTransport;
use vela_providers::{
    ChatMessage, ChatRequest, Degradation, Provider, ProviderError, RequestContext, StreamEvent,
    Timeouts,
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
    async fn start(profile: &str) -> Self {
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

/// The matrix, and what each column actually is. Used to assert that no
/// affordance is offered that the profile cannot serve.
struct Profile {
    name: &'static str,
    model_id: &'static str,
    window: u32,
    native_tools: bool,
    vision: bool,
    honours_schema: bool,
}

const MATRIX: [Profile; 4] = [
    Profile {
        name: "frontier",
        model_id: "mock-frontier",
        window: 200_000,
        native_tools: true,
        vision: true,
        honours_schema: true,
    },
    Profile {
        name: "mid-local",
        model_id: "mock-mid-local",
        window: 32_768,
        native_tools: true,
        vision: false,
        honours_schema: false,
    },
    Profile {
        name: "small-local",
        model_id: "mock-small-local",
        window: 8_192,
        native_tools: false,
        vision: false,
        honours_schema: false,
    },
    Profile {
        name: "hostile",
        model_id: "mock-hostile",
        window: 4_096,
        native_tools: false,
        vision: false,
        honours_schema: false,
    },
];

fn adapter(url: &str) -> CompatProvider {
    CompatProvider::new(
        ProviderDescriptor::new("matrix", "Capability matrix", ProviderKind::Local).unwrap(),
        format!("{url}/v1"),
        // No credential at all — the default state for this adapter, and the
        // state most local runtimes are in.
        Auth::None,
        Arc::new(MemoryStore::new()),
        Arc::new(ReqwestTransport::new().expect("http client builds")),
    )
}

/// Short deadlines on purpose: the recorded naive consumers hung for 5003 ms
/// and 5006 ms, so a test that would hang must fail *faster* than that.
fn context() -> RequestContext {
    RequestContext::new().with_timeouts(Timeouts {
        connect: Duration::from_secs(5),
        first_byte: Duration::from_secs(10),
        stall: Duration::from_secs(3),
    })
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

#[tokio::test]
async fn every_profile_is_identified_by_what_it_serves_and_declares_its_own_window() {
    for profile in &MATRIX {
        let server = MockServer::start(profile.name).await;
        let provider = adapter(&server.url);

        let models = provider
            .list_models(&context())
            .await
            .expect("all four profiles enumerate models");
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec![profile.model_id],
            "{}: the listing must survive the shape parser unchanged",
            profile.name
        );

        let capabilities = provider
            .probe_capabilities(profile.model_id, &context())
            .await
            .expect("a running endpoint is probeable");
        assert_eq!(
            provider.flavour(),
            ServerFlavour::LlamaCpp,
            "{}: the matrix profiles serve /props, so they present as llama.cpp-shaped",
            profile.name
        );
        assert_eq!(
            capabilities.context_window_tokens,
            Some(profile.window),
            "{}: the declared window must be read, not guessed",
            profile.name
        );
        server.stop().await;
    }
}

#[tokio::test]
async fn probing_never_offers_an_affordance_the_profile_cannot_serve() {
    for profile in &MATRIX {
        let server = MockServer::start(profile.name).await;
        let provider = adapter(&server.url);
        let capabilities = provider
            .probe_capabilities(profile.model_id, &context())
            .await
            .unwrap();
        let flags = capabilities.to_descriptor();

        assert!(flags.streaming, "{}: streaming", profile.name);
        assert!(flags.model_listing, "{}: model listing", profile.name);
        assert_eq!(
            flags.vision, profile.vision,
            "{}: vision offered={} but the profile has vision={}",
            profile.name, flags.vision, profile.vision
        );
        assert_eq!(
            capabilities.honours_structured_output(),
            profile.honours_schema,
            "{}: MEASURED-5 — a schema request must never be sent to an endpoint \
             that answers 200 with prose",
            profile.name
        );
        if profile.native_tools {
            assert!(
                matches!(
                    capabilities.tool_calling,
                    Support::Supported | Support::Degraded
                ),
                "{}: native tools were not seen",
                profile.name
            );
        } else {
            assert_ne!(
                capabilities.tool_calling,
                Support::Supported,
                "{}: this profile cannot serve native tool calls",
                profile.name
            );
        }
        server.stop().await;
    }
}

#[tokio::test]
async fn an_endpoint_that_is_not_running_is_unreachable_rather_than_incapable() {
    // Start and stop, so the port is one nothing is listening on — the exact
    // state of a user who has not launched their model server yet.
    let server = MockServer::start("small-local").await;
    let url = server.url.clone();
    server.stop().await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    let provider = adapter(&url);
    let error = provider
        .probe_capabilities("mock-small-local", &context())
        .await
        .expect_err("nothing is listening");
    assert!(
        matches!(error, ProviderError::Transport { .. }),
        "a capability table full of `Unsupported` would be a lie about a server \
         that is simply not running: {error:?}"
    );
    assert!(error.allows_failover(), "another candidate may well be up");
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_turn_terminates_exactly_once_on_every_profile() {
    for profile in &MATRIX {
        let server = MockServer::start(profile.name).await;
        let provider = adapter(&server.url);
        let mut sink = CollectingSink::new();

        let response = tokio::time::timeout(
            Duration::from_secs(10),
            provider.stream(
                ChatRequest::new(profile.model_id).with_message(ChatMessage::user("hello there")),
                &mut sink,
                &context(),
            ),
        )
        .await
        .unwrap_or_else(|_| panic!("{}: MEASURED-1 — the turn hung", profile.name))
        .unwrap_or_else(|error| panic!("{}: {error:?}", profile.name));

        let terminals: Vec<&StreamEvent> = sink
            .events
            .iter()
            .filter(|event| event.is_terminal())
            .collect();
        assert_eq!(
            terminals.len(),
            1,
            "{}: the adapter must emit exactly one terminal event",
            profile.name
        );
        assert!(matches!(terminals[0], StreamEvent::Done { .. }));
        assert!(
            !response.answer_text().trim().is_empty(),
            "{}: an empty answer means the stream was lost, not degraded",
            profile.name
        );
        assert!(
            !response.answer_text().contains("<think>"),
            "{}: reasoning markup leaked into the answer",
            profile.name
        );
        server.stop().await;
    }
}

#[tokio::test]
async fn the_hostile_profiles_degradations_still_arrive_through_the_adapter() {
    // The adapter must not swallow, reorder or duplicate what the core reports;
    // this is the regression test for wrapping the sink.
    let server = MockServer::start("hostile").await;
    let provider = adapter(&server.url);
    let mut sink = CollectingSink::new();
    let response = tokio::time::timeout(
        Duration::from_secs(10),
        provider.stream(
            ChatRequest::new("mock-hostile").with_message(ChatMessage::user("tell me something")),
            &mut sink,
            &context(),
        ),
    )
    .await
    .expect("hostile never sends [DONE]; end-of-body must terminate the read")
    .unwrap();

    assert!(
        response
            .degradations
            .iter()
            .any(|d| matches!(d, Degradation::NoTerminationSentinel)),
        "MEASURED-1: the missing sentinel is reported, not waited for: {:?}",
        response.degradations
    );
    assert!(
        response
            .degradations
            .iter()
            .any(|d| matches!(d, Degradation::MalformedFramesSkipped { .. })),
        "MEASURED-2: skipped frames are reported: {:?}",
        response.degradations
    );
    assert_eq!(
        sink.events
            .iter()
            .filter(|event| event.is_terminal())
            .count(),
        1
    );
    server.stop().await;
}

#[tokio::test]
async fn an_oversized_conversation_is_refitted_from_the_endpoints_own_refusal_and_retried() {
    // Discovery is switched off so the window is genuinely unknown: this is the
    // path for a server that declares nothing at all. MEASURED-7 says the
    // refusal is clean and carries both counts, and this proves that number is
    // used rather than merely reported.
    let server = MockServer::start("small-local").await;
    let provider = adapter(&server.url).with_options(CompatOptions {
        discover_before_first_turn: false,
        ..CompatOptions::default()
    });

    // Comfortably over the profile's 8192-token window (4 chars per token).
    let filler = "lorem ipsum dolor sit amet consectetur ".repeat(60);
    let request = ChatRequest::new("mock-small-local")
        .with_messages((0..40).map(|turn| ChatMessage::user(format!("turn {turn}: {filler}"))));

    let mut sink = CollectingSink::new();
    let response = tokio::time::timeout(
        Duration::from_secs(15),
        provider.stream(request, &mut sink, &context()),
    )
    .await
    .expect("the refit must not hang")
    .expect("a refusal that names the window is recoverable");

    assert!(
        response
            .degradations
            .iter()
            .any(|d| matches!(d, Degradation::ContextReduced { .. })),
        "a reduction the user cannot see is a silent truncation: {:?}",
        response.degradations
    );
    assert!(response
        .degradations
        .iter()
        .any(|d| matches!(d, Degradation::FailedOver { attempts: 2 })));
    assert_eq!(
        provider
            .known_capabilities("mock-small-local")
            .context_window_tokens,
        Some(8_192),
        "the window the endpoint refused at is remembered"
    );
    assert!(
        sink.error().is_none(),
        "the user must never see the suppressed first attempt"
    );
    assert_eq!(
        sink.events
            .iter()
            .filter(|event| event.is_terminal())
            .count(),
        1
    );
    server.stop().await;
}

/// **Mutation control** for the test above.
///
/// The same conversation, the same endpoint, the refit switched off. If this
/// passed, the recovery above would be the harness being lenient rather than
/// the adapter doing anything, and the test would be worthless.
#[tokio::test]
async fn control_the_same_conversation_is_refused_when_the_refit_is_switched_off() {
    let server = MockServer::start("small-local").await;
    let provider = adapter(&server.url).with_options(CompatOptions {
        discover_before_first_turn: false,
        refit_on_context_overflow: false,
        ..CompatOptions::default()
    });

    let filler = "lorem ipsum dolor sit amet consectetur ".repeat(60);
    let request = ChatRequest::new("mock-small-local")
        .with_messages((0..40).map(|turn| ChatMessage::user(format!("turn {turn}: {filler}"))));
    let mut sink = CollectingSink::new();
    let error = tokio::time::timeout(
        Duration::from_secs(15),
        provider.stream(request, &mut sink, &context()),
    )
    .await
    .expect("no hang")
    .expect_err("without the refit there is nothing to recover the turn");

    assert!(matches!(error, ProviderError::ContextLengthExceeded { .. }));
    assert!(
        sink.error().is_some(),
        "and the failure is surfaced, not swallowed"
    );
    server.stop().await;
}

#[tokio::test]
async fn once_the_window_is_known_the_next_turn_is_fitted_without_spending_a_refusal() {
    let server = MockServer::start("hostile").await;
    let provider = adapter(&server.url);

    // Discovery reads /props before the first turn, so nothing has to fail
    // first. hostile's window is 4096 tokens.
    let filler = "keel delta fathom sextant ".repeat(120);
    let request = ChatRequest::new("mock-hostile")
        .with_messages((0..20).map(|turn| ChatMessage::user(format!("turn {turn}: {filler}"))));

    let mut sink = CollectingSink::new();
    let response = tokio::time::timeout(
        Duration::from_secs(15),
        provider.stream(request, &mut sink, &context()),
    )
    .await
    .expect("no hang")
    .expect("the first attempt should already fit");

    assert!(
        response
            .degradations
            .iter()
            .any(|d| matches!(d, Degradation::ContextReduced { .. })),
        "{:?}",
        response.degradations
    );
    assert!(
        !response
            .degradations
            .iter()
            .any(|d| matches!(d, Degradation::FailedOver { .. })),
        "a window read from /props costs no wasted round trip: {:?}",
        response.degradations
    );
    server.stop().await;
}

#[tokio::test]
async fn no_credential_means_no_authorization_header_anywhere_including_discovery() {
    // The harness answers an *empty* Bearer with 401 precisely so this bug is
    // loud. Every request in this test — discovery, listing, probe, turn —
    // succeeding is the assertion.
    let server = MockServer::start("mid-local").await;
    let provider = adapter(&server.url);

    provider.list_models(&context()).await.unwrap();
    let capabilities = provider
        .probe_capabilities("mock-mid-local", &context())
        .await
        .unwrap();
    assert_ne!(capabilities.streaming, Support::Unknown);

    let response = provider
        .complete(
            ChatRequest::new("mock-mid-local").with_message(ChatMessage::user("hi")),
            &context(),
        )
        .await
        .expect("a no-auth endpoint is a first-class configuration, not an edge case");
    assert!(!response.answer_text().is_empty());
    server.stop().await;
}
