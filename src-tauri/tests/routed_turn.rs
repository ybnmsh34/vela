//! **A turn is routed, over real sockets.**
//!
//! `src-tauri/src/ipc/chat.rs` used to call `provider.stream` directly, so
//! `vela_providers::router` — bounded retries, growing backoff, `Retry-After`,
//! failover, and the rule that a turn is never restarted after the user has
//! seen output — had no caller anywhere outside its own crate. Every one of
//! those behaviours was correct and unreachable from the product.
//!
//! This file drives the wiring that closes that: `ProviderHost::router_for`
//! (the composition root's candidate list) into `chat::run_turn` (what
//! `chat_send` spawns), against loopback servers this file starts and stops
//! itself.
//!
//! # What is real here and what is not
//!
//! Real: the sockets, the `ReqwestTransport`, the `CompatProvider`, the
//! candidate ordering the shipping host computes, and — for the failover case —
//! a genuinely absent process, which is the same `ECONNREFUSED` a stopped
//! llama.cpp gives.
//!
//! Not real: the model. Each fixture emits scripted SSE frames. Per
//! `docs/architecture/conventions.md` §10 every claim here is **about the host**
//! — which candidate it addresses, in what order, and what it does with the
//! answer — and none of it is evidence about any model's behaviour. The
//! credential store is `MemoryStore`, so nothing here is evidence about an OS
//! keychain either.
//!
//! # The one that matters
//!
//! [`a_turn_is_never_failed_over_after_the_user_has_seen_a_token`] is the rule
//! whose violation is worst: splicing a second endpoint's answer onto a
//! half-drawn first one produces a paragraph no model wrote. It is proved here
//! by killing a live socket *after* a token has been delivered and asserting the
//! second endpoint never gets a connection at all.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use vela_lib::ipc::chat;
use vela_lib::provider_host::ProviderHost;
use vela_providers::model::Degradation;
use vela_providers::provider::RequestContext;
use vela_providers::{ChatMessage, ChatRequest, StreamEvent};
use vela_secrets::{MemoryStore, SecretStore};
use vela_settings::ProviderConfig;

/* -------------------------------------------------------------------------- */
/* fixture endpoints                                                          */
/* -------------------------------------------------------------------------- */

/// What a fixture does when it is asked for a completion.
#[derive(Clone, Copy)]
enum Behaviour {
    /// A whole SSE turn, terminated properly.
    Answers(&'static str),
    /// Headers promising a body, **one visible token**, then the socket dies.
    ///
    /// The `Content-Length` is deliberately a promise the server does not keep:
    /// with `Connection: close` and no length, end-of-socket would be a *clean*
    /// end of stream (MEASURED-1) and the turn would succeed. Under-delivering
    /// a declared length is what a process that was killed mid-answer looks
    /// like on the wire.
    DiesAfterFirstToken,
}

/// A loopback endpoint that counts the connections it accepts.
///
/// Connections rather than requests, because the interesting assertion is the
/// negative one — "this endpoint was never contacted" — and a candidate that is
/// skipped opens no socket at all, not even for discovery.
struct Fixture {
    base_url: String,
    connections: Arc<AtomicUsize>,
    completions: Arc<AtomicUsize>,
    shutdown: Arc<AtomicBool>,
}

impl Fixture {
    fn start(behaviour: Behaviour) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let port = listener.local_addr().unwrap().port();
        let connections = Arc::new(AtomicUsize::new(0));
        let completions = Arc::new(AtomicUsize::new(0));
        let shutdown = Arc::new(AtomicBool::new(false));

        let thread_connections = Arc::clone(&connections);
        let thread_completions = Arc::clone(&completions);
        let thread_shutdown = Arc::clone(&shutdown);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if thread_shutdown.load(Ordering::SeqCst) {
                    return;
                }
                let Ok(stream) = stream else { continue };
                thread_connections.fetch_add(1, Ordering::SeqCst);
                serve(stream, behaviour, &thread_completions);
            }
        });

        Self {
            base_url: format!("http://127.0.0.1:{port}/v1"),
            connections,
            completions,
            shutdown,
        }
    }

    /// A port nothing is listening on: bound to learn a free number, then
    /// released. This is what a stopped process looks like — `ECONNREFUSED` on
    /// connect, not a hang and not a 502 from something else.
    fn stopped_process() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        format!("http://127.0.0.1:{port}/v1")
    }

    fn connections(&self) -> usize {
        self.connections.load(Ordering::SeqCst)
    }

    fn completions(&self) -> usize {
        self.completions.load(Ordering::SeqCst)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
    }
}

fn serve(mut stream: TcpStream, behaviour: Behaviour, completions: &Arc<AtomicUsize>) {
    let mut reader = BufReader::new(stream.try_clone().expect("clone"));

    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() || request_line.trim().is_empty() {
        return;
    }
    let path = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or_default()
        .to_owned();

    let mut content_length = 0usize;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).is_err() {
            return;
        }
        if header.trim().is_empty() {
            break;
        }
        if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or(0);
        }
    }
    let mut body = vec![0u8; content_length];
    if content_length > 0 && reader.read_exact(&mut body).is_err() {
        return;
    }

    if !path.contains("chat/completions") {
        // Discovery — `/v1/models`, `/props`, `/api/tags`, `/api/v0/models`.
        // Honestly absent; a turn is never blocked by it.
        let _ = stream.write_all(
            b"HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
        );
        let _ = stream.flush();
        return;
    }
    completions.fetch_add(1, Ordering::SeqCst);

    match behaviour {
        Behaviour::Answers(text) => {
            let frames = format!(
                "data: {{\"choices\":[{{\"delta\":{{\"content\":{}}}}}]}}\n\n\
                 data: {{\"choices\":[{{\"delta\":{{}},\"finish_reason\":\"stop\"}}]}}\n\n\
                 data: [DONE]\n\n",
                serde_json::Value::String(text.to_owned())
            );
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n{frames}",
                frames.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        }
        Behaviour::DiesAfterFirstToken => {
            let frame = "data: {\"choices\":[{\"delta\":{\"content\":\"half an ans\"}}]}\n\n";
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\
                 Content-Length: 65536\r\nConnection: close\r\n\r\n{frame}"
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
            // …and the process dies. 65,536 bytes were promised and 57 arrived.
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
    }
}

/* -------------------------------------------------------------------------- */
/* the host                                                                   */
/* -------------------------------------------------------------------------- */

/// The real composition root's provider host, with the real HTTP client.
fn host() -> ProviderHost {
    let secrets: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    ProviderHost::for_runtime(secrets)
}

fn configure(host: &ProviderHost, id: &str, base_url: &str, model: Option<&str>) {
    let config = ProviderConfig::local(id, "An endpoint the user configured", base_url)
        .expect("a loopback URL is a valid configuration");
    let config = match model {
        Some(model) => config.with_model(model),
        None => config,
    };
    host.install(&config).expect("a client can be built");
}

/// What `chat_send` spawns, minus the window sink and the spawn.
fn send(host: &ProviderHost, provider_id: &str, model_id: &str) -> Vec<StreamEvent> {
    let router = host
        .router_for(provider_id, model_id)
        .expect("the chosen endpoint is configured");
    let request = ChatRequest::new(model_id).with_message(ChatMessage::user("hello"));
    let mut sink: Vec<StreamEvent> = Vec::new();
    tauri::async_runtime::block_on(chat::run_turn(
        router,
        request,
        RequestContext::new(),
        &mut sink,
    ));
    sink
}

fn answer_text(events: &[StreamEvent]) -> String {
    events
        .iter()
        .filter_map(|event| match event {
            StreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

fn terminals(events: &[StreamEvent]) -> Vec<&StreamEvent> {
    events.iter().filter(|event| event.is_terminal()).collect()
}

fn done(events: &[StreamEvent]) -> Option<&vela_providers::ChatResponse> {
    events.iter().find_map(|event| match event {
        StreamEvent::Done { response } => Some(response.as_ref()),
        _ => None,
    })
}

/* -------------------------------------------------------------------------- */
/* the tests                                                                  */
/* -------------------------------------------------------------------------- */

/// **The first half of the acceptance bar.** Two endpoints; the first one's
/// process is gone; the turn is answered by the second and says so.
#[test]
fn a_turn_whose_endpoint_is_gone_is_answered_by_the_next_one_and_reports_it() {
    let live = Fixture::start(Behaviour::Answers("answered by the second endpoint"));
    let dead_url = Fixture::stopped_process();

    let host = host();
    // `a-` and `b-` so the candidate order is the one under test rather than an
    // accident of how `BTreeMap` sorted two names.
    configure(&host, "a-stopped", &dead_url, Some("model-on-the-dead-box"));
    configure(
        &host,
        "b-live",
        &live.base_url,
        Some("model-on-the-live-box"),
    );

    let router = host
        .router_for("a-stopped", "model-on-the-dead-box")
        .unwrap();
    assert_eq!(
        router.candidate_ids(),
        vec!["a-stopped".to_string(), "b-live".to_string()]
    );

    let events = send(&host, "a-stopped", "model-on-the-dead-box");

    assert_eq!(
        answer_text(&events),
        "answered by the second endpoint",
        "the answer must come from the endpoint that was up: {events:?}"
    );
    assert_eq!(
        live.completions(),
        1,
        "the second endpoint answered exactly one turn"
    );

    let response = done(&events).expect("a completed turn ends in Done");
    let attempts = response
        .degradations
        .iter()
        .find_map(|degradation| match degradation {
            Degradation::FailedOver { attempts } => Some(*attempts),
            _ => None,
        })
        .expect("`Retried before it worked` needs a FailedOver on the Done event");
    assert_eq!(
        attempts, 4,
        "`RetryPolicy::default()` allows three attempts on the chosen endpoint \
         before moving on, and the fourth is the one that worked"
    );
}

/// **The rule that matters most.** The endpoint delivers a token and *then*
/// dies. Vela must surface the failure rather than restart the answer somewhere
/// else, because the user is already reading the first one.
///
/// # The mutation that proves this test bites
///
/// Delete the three lines in `crates/vela-providers/src/router.rs` that read
///
/// ```ignore
/// if sink.committed() {
///     return Err(error);
/// }
/// ```
///
/// and this test fails on `never_contacted`: the turn fails over, the second
/// endpoint answers, and the user watches half an answer be replaced by a whole
/// different one. The unit-level twin is
/// `router::tests::once_the_user_has_seen_output_the_turn_is_never_restarted_elsewhere`.
#[test]
fn a_turn_is_never_failed_over_after_the_user_has_seen_a_token() {
    let dying = Fixture::start(Behaviour::DiesAfterFirstToken);
    let never_contacted = Fixture::start(Behaviour::Answers("a whole second answer"));

    let host = host();
    configure(&host, "a-dying", &dying.base_url, Some("model-a"));
    configure(
        &host,
        "b-standby",
        &never_contacted.base_url,
        Some("model-b"),
    );

    // Non-vacuity: the standby really is a candidate. Without this the test
    // would pass just as well against a router that had never heard of it.
    assert_eq!(
        host.router_for("a-dying", "model-a")
            .unwrap()
            .candidate_ids(),
        vec!["a-dying".to_string(), "b-standby".to_string()],
    );

    let events = send(&host, "a-dying", "model-a");

    assert_eq!(
        answer_text(&events),
        "half an ans",
        "what the user already saw stays on the screen: {events:?}"
    );
    assert_eq!(
        never_contacted.connections(),
        0,
        "the standby endpoint must never be contacted once a token has landed — \
         doing so splices two answers into one paragraph no model wrote"
    );
    let terminals = terminals(&events);
    assert_eq!(terminals.len(), 1, "one turn, one ending: {events:?}");
    assert!(
        matches!(terminals[0], StreamEvent::Error { .. }),
        "the failure is surfaced, not swallowed: {:?}",
        terminals[0]
    );
    assert!(
        done(&events).is_none(),
        "a turn that failed must not also report success"
    );
}

/// The single-endpoint case, which is what almost every user actually has.
/// Wiring the router in must not cost them anything: one candidate, one
/// connection, no degradation invented.
#[test]
fn a_single_configured_endpoint_answers_exactly_as_it_did_before() {
    let only = Fixture::start(Behaviour::Answers("the only endpoint answered"));
    let host = host();
    configure(&host, "only", &only.base_url, None);

    let events = send(&host, "only", "some-model");

    assert_eq!(answer_text(&events), "the only endpoint answered");
    assert_eq!(only.completions(), 1, "no speculative second request");
    let response = done(&events).expect("a completed turn ends in Done");
    assert!(
        !response
            .degradations
            .iter()
            .any(|degradation| matches!(degradation, Degradation::FailedOver { .. })),
        "a turn that worked first time must not claim it was retried: {:?}",
        response.degradations
    );
}

/// A candidate list is not a licence to shop the prompt around. An endpoint
/// with no model of its own recorded is not a fallback, so the turn fails on
/// the endpoint the user chose — which is the honest outcome.
#[test]
fn an_endpoint_with_no_model_of_its_own_is_never_asked_to_stand_in() {
    let never_contacted = Fixture::start(Behaviour::Answers("should never be reached"));
    let dead_url = Fixture::stopped_process();

    let host = host();
    configure(&host, "a-stopped", &dead_url, Some("model-a"));
    // No model recorded: nothing says what to ask this box for.
    configure(&host, "b-nameless", &never_contacted.base_url, None);

    let events = send(&host, "a-stopped", "model-a");

    assert_eq!(
        never_contacted.connections(),
        0,
        "Vela does not invent a model name for a box that never named one"
    );
    let terminals = terminals(&events);
    assert_eq!(terminals.len(), 1);
    assert!(matches!(terminals[0], StreamEvent::Error { .. }));
}
