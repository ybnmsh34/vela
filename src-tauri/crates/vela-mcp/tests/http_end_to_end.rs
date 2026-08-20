//! **VERIFIED AGAINST A REAL SOCKET.** Every test in this file opens a real
//! TCP connection to a real HTTP server on loopback, writes real HTTP/1.1 bytes
//! and reads real bytes back. The server is a fixture — `support::MockServer`,
//! scripted per test — but nothing about the transport is simulated: the
//! framing, the headers, the session, the SSE parsing, the connection that
//! closes and the port that nothing is listening on are all real, and they are
//! the parts that are easy to get wrong behind a fake.
//!
//! The distinction is the one `stdio_end_to_end.rs` opens with, and it is the
//! same distinction: a fake exchange that hands back a `HttpReply` struct proves
//! the branches and proves nothing about the wire.
//!
//! # What is still VERIFIED-BY-FAKE here
//!
//! * **The credential store.** `vela_secrets::MemoryStore`, not Windows
//!   Credential Manager. What is proved is that a token moves through the
//!   `SecretStore` trait and reaches the wire; that the real backend works is
//!   `docs/desktop-gate/VERDICTS.md`'s claim about `KeyringStore`, not this
//!   file's.
//! * **TLS.** Every URL here is `http://127.0.0.1`, which is the only plaintext
//!   `config::validate_remote_url` permits. Nothing here exercises a `https://`
//!   handshake, a certificate, or a redirect — those belong to whichever
//!   `HttpExchange` the composition root supplies.

mod support;

use std::collections::BTreeMap;
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use support::{LoopbackExchange, MockServer, Reply};
use vela_core::secret::{SecretRef, SecretValue};
use vela_mcp::config::{credential_ref, McpConfig, ServerSpec};
use vela_mcp::error::{McpError, McpFailureCode};
use vela_mcp::http::{HttpTransport, RemoteDeps};
use vela_mcp::pool::McpPool;
use vela_secrets::{MemoryStore, SecretResult, SecretStore};

const ACCESS_ONE: &str = "at-one-CANARY";
const ACCESS_TWO: &str = "at-two-CANARY";
const REFRESH_ONE: &str = "rt-one-CANARY";
const SESSION: &str = "session-7f3c";

// ---------------------------------------------------------------------------
// Scripting
// ---------------------------------------------------------------------------

/// The answer a well-behaved server gives, for the three methods this client
/// sends. `grown` decides whether `tools/list` has picked up the extra tool.
fn mcp_answer(request: &support::Received, grown: bool) -> Reply {
    if request.method == "DELETE" {
        return Reply::status(204);
    }
    let id = request.rpc_id().unwrap_or(0);
    match request.rpc_method().as_deref() {
        Some("initialize") => Reply::json(
            json!({
                "jsonrpc": "2.0", "id": id,
                "result": { "protocolVersion": "2025-06-18", "capabilities": {},
                            "serverInfo": { "name": "fixture", "version": "0" } }
            })
            .to_string(),
        )
        .with_header("mcp-session-id", SESSION),
        Some("notifications/initialized") => Reply::status(202),
        Some("tools/list") => {
            let mut tools = vec![json!({
                "name": "add",
                "description": "Adds a and b.",
                "inputSchema": { "type": "object" }
            })];
            if grown {
                tools.push(json!({ "name": "grown_tool", "inputSchema": { "type": "object" } }));
            }
            Reply::json(
                json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tools } }).to_string(),
            )
        }
        Some("tools/call") => Reply::json(
            json!({ "jsonrpc": "2.0", "id": id,
                    "result": { "content": [{ "type": "text", "text": "42" }] } })
            .to_string(),
        ),
        _ => Reply::status(400).with_body("unscripted"),
    }
}

fn config_for(url: &str, extra: Value) -> McpConfig {
    let mut entry = json!({ "url": url });
    if let (Some(entry), Some(extra)) = (entry.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            entry.insert(key.clone(), value.clone());
        }
    }
    McpConfig::parse(&json!({ "mcpServers": { "team": entry } }).to_string())
        .expect("the configuration must parse")
}

struct Harness {
    pool: McpPool,
    exchange: Arc<LoopbackExchange>,
}

fn harness_with(url: &str, extra: Value, store: Arc<dyn SecretStore>) -> Harness {
    let exchange = Arc::new(LoopbackExchange::default());
    let deps = RemoteDeps {
        credentials: store,
        http: Arc::clone(&exchange) as Arc<dyn vela_mcp::exchange::HttpExchange>,
    };
    Harness {
        pool: McpPool::with_remote(config_for(url, extra), deps),
        exchange,
    }
}

fn harness(url: &str) -> Harness {
    harness_with(url, json!({}), Arc::new(MemoryStore::new()))
}

fn store_token(store: &dyn SecretStore, value: &str) {
    store
        .set(&credential_ref("team").unwrap(), &SecretValue::new(value))
        .expect("the fake store accepts a token");
}

fn tool_names(pool: &McpPool) -> Vec<String> {
    let rows = pool.list_all_tools();
    assert_eq!(rows.len(), 1, "one configured server");
    rows[0]
        .outcome
        .as_ref()
        .unwrap_or_else(|error| panic!("expected tools, got {error:?}"))
        .iter()
        .map(|tool| tool.name.clone())
        .collect()
}

fn failure(pool: &McpPool) -> McpError {
    let mut rows = pool.list_all_tools();
    assert_eq!(rows.len(), 1);
    rows.remove(0)
        .outcome
        .expect_err("this server must not serve tools")
}

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

#[test]
fn a_real_server_over_a_real_socket_answers_a_real_tool_list() {
    let server = MockServer::start(|request| mcp_answer(request, false));
    let harness = harness(&server.url("/mcp"));

    assert_eq!(tool_names(&harness.pool), vec!["add".to_owned()]);

    // The handshake really happened, in the order the spec states.
    let sent: Vec<String> = server
        .received()
        .iter()
        .filter_map(support::Received::rpc_method)
        .collect();
    assert_eq!(
        sent,
        vec![
            "initialize".to_owned(),
            "notifications/initialized".to_owned(),
            "tools/list".to_owned()
        ],
        "got {sent:?}"
    );
}

#[test]
fn the_session_the_server_minted_is_echoed_on_every_later_request() {
    let server = MockServer::start(|request| mcp_answer(request, false));
    let harness = harness(&server.url("/mcp"));
    tool_names(&harness.pool);

    let sent = server.received();
    assert_eq!(
        sent[0].header("mcp-session-id"),
        None,
        "the first request cannot know a session that has not been minted yet"
    );
    for request in &sent[1..] {
        assert_eq!(
            request.header("mcp-session-id"),
            Some(SESSION),
            "a request after the handshake dropped the session: {request:?}"
        );
    }
}

#[test]
fn every_request_carries_the_framing_headers_and_the_users_own() {
    let server = MockServer::start(|request| mcp_answer(request, false));
    let harness = harness_with(
        &server.url("/mcp"),
        json!({ "headers": { "X-Tenant": "acme" } }),
        Arc::new(MemoryStore::new()),
    );
    tool_names(&harness.pool);

    for request in server.received() {
        assert_eq!(request.method, "POST", "{request:?}");
        assert_eq!(request.header("x-tenant"), Some("acme"), "{request:?}");
        assert_eq!(
            request.header("content-type"),
            Some("application/json"),
            "{request:?}"
        );
        assert_eq!(
            request.header("mcp-protocol-version"),
            Some(vela_mcp::protocol::PROTOCOL_VERSION),
            "{request:?}"
        );
        let accept = request.header("accept").unwrap_or_default();
        assert!(accept.contains("application/json"), "{accept}");
        assert!(accept.contains("text/event-stream"), "{accept}");
    }
}

#[test]
fn a_configured_header_cannot_displace_one_the_transport_owns() {
    // The other half of `config::FORBIDDEN_HEADERS`: the file cannot set them,
    // and if it somehow could, the transport writes its own first. This asserts
    // the *outcome* on the wire rather than the list.
    let server = MockServer::start(|request| mcp_answer(request, false));
    let harness = harness_with(
        &server.url("/mcp"),
        json!({ "headers": { "X-Tenant": "acme" } }),
        Arc::new(MemoryStore::new()),
    );
    tool_names(&harness.pool);

    let posts: Vec<_> = harness
        .exchange
        .calls()
        .into_iter()
        .filter(|call| call.method == vela_mcp::HttpMethod::Post)
        .collect();
    // A negative asserted inside a loop passes for free over an empty one. This
    // is what stops that: the assertions below only mean something if there were
    // calls to make them about.
    assert!(
        !posts.is_empty(),
        "no POST was recorded, so the loop below would prove nothing"
    );

    for call in &posts {
        let framing: Vec<&(String, String)> = call
            .headers
            .iter()
            .filter(|(name, _)| name == "accept" || name == "mcp-protocol-version")
            .collect();
        assert_eq!(
            framing.len(),
            2,
            "the transport's own headers were duplicated or lost: {call:?}"
        );
    }
}

#[test]
fn an_sse_reply_delivers_the_answer_and_the_notification_interleaved_with_it() {
    // The HTTP twin of `a_list_changed_notification_invalidates_the_cached_tool_list`
    // in the stdio suite, and the only channel by which a notification reaches
    // this transport at all — see the "not implemented" note on `crate::http`.
    let grown = Arc::new(AtomicUsize::new(0));
    let server_grown = Arc::clone(&grown);
    let server = MockServer::start(move |request| {
        if request.rpc_method().as_deref() == Some("tools/call") {
            server_grown.store(1, Ordering::SeqCst);
            let id = request.rpc_id().unwrap_or(0);
            return Reply::sse(&[
                json!({ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" })
                    .to_string(),
                json!({ "jsonrpc": "2.0", "id": id,
                        "result": { "content": [{ "type": "text", "text": "grew" }] } })
                .to_string(),
            ]);
        }
        mcp_answer(request, server_grown.load(Ordering::SeqCst) == 1)
    });

    let harness = harness(&server.url("/mcp"));
    let connection = harness.pool.connect("team").expect("connect");

    let before: Vec<String> = connection
        .list_tools()
        .unwrap()
        .into_iter()
        .map(|tool| tool.name)
        .collect();
    assert_eq!(before, vec!["add".to_owned()]);

    // Two reads with nothing in between cost one request: the cache is real.
    connection.list_tools().unwrap();
    assert_eq!(server.rpc("tools/list").len(), 1);

    connection.call_tool("grow", json!({})).expect("tools/call");

    let after: Vec<String> = connection
        .list_tools()
        .unwrap()
        .into_iter()
        .map(|tool| tool.name)
        .collect();
    assert!(
        after.iter().any(|name| name == "grown_tool"),
        "the notification carried in the SSE stream did not invalidate the cache; got {after:?}"
    );
    assert_eq!(
        server.rpc("tools/list").len(),
        2,
        "the invalidation should cost exactly one refetch"
    );
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

#[test]
fn a_stored_bearer_token_reaches_the_wire_and_the_file_never_held_it() {
    let server = MockServer::start(|request| {
        if request.header("authorization") != Some(&format!("Bearer {ACCESS_ONE}")[..]) {
            return Reply::status(401);
        }
        mcp_answer(request, false)
    });

    let store: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    store_token(store.as_ref(), ACCESS_ONE);
    let harness = harness_with(
        &server.url("/mcp"),
        json!({ "auth": { "type": "bearer" } }),
        store,
    );

    assert_eq!(tool_names(&harness.pool), vec!["add".to_owned()]);

    // It was marked as credential material, so nothing prints it.
    for call in harness.exchange.calls() {
        assert!(call.is_credential_header("authorization"), "{call:?}");
        assert!(!format!("{call:?}").contains(ACCESS_ONE), "{call:?}");
    }
}

#[test]
fn a_server_with_no_stored_credential_is_refused_before_a_byte_goes_out() {
    // The bug this prevents is `Authorization: Bearer ` — an empty credential,
    // which servers answer with a confusing 401 rather than behaving as if no
    // header had been sent. `vela_secrets::resolve_auth` makes the same
    // argument for model providers.
    let server = MockServer::start(|request| mcp_answer(request, false));
    let harness = harness_with(
        &server.url("/mcp"),
        json!({ "auth": { "type": "bearer" } }),
        Arc::new(MemoryStore::new()),
    );

    let error = failure(&harness.pool);
    assert_eq!(error.code(), McpFailureCode::AuthorizationRequired);
    assert!(
        matches!(&error, McpError::AuthorizationRequired { detail, .. }
            if detail.contains("mcp:team/token")),
        "the error must name the credential that is missing; got {error:?}"
    );
    assert!(
        server.received().is_empty(),
        "a request went out without a credential: {:?}",
        server.received()
    );
}

#[test]
fn a_401_refreshes_the_token_once_and_retries_the_request() {
    let tokens = MockServer::start(|_| {
        Reply::json(
            json!({ "access_token": ACCESS_TWO, "refresh_token": "rt-two",
                    "expires_in": 3600, "token_type": "Bearer" })
            .to_string(),
        )
    });
    let server = MockServer::start(|request| {
        if request.header("authorization") != Some(&format!("Bearer {ACCESS_TWO}")[..]) {
            return Reply::status(401);
        }
        mcp_answer(request, false)
    });

    let store: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    store_token(
        store.as_ref(),
        &json!({ "accessToken": ACCESS_ONE, "refreshToken": REFRESH_ONE }).to_string(),
    );
    let harness = harness_with(
        &server.url("/mcp"),
        json!({ "auth": { "type": "oauth", "clientId": "vela-desktop",
                          "tokenEndpoint": tokens.url("/token") } }),
        Arc::clone(&store),
    );

    assert_eq!(tool_names(&harness.pool), vec!["add".to_owned()]);

    assert_eq!(
        tokens.hits("/token"),
        1,
        "exactly one refresh: a rotating refresh token may be spent once, and \
         re-refreshing per request would hammer the authorization server"
    );
    // The refused attempt, then the retry, then the rest of the handshake.
    assert!(server.received()[0].header("authorization").is_some());
    assert_eq!(
        server.received()[1].header("authorization"),
        Some(&format!("Bearer {ACCESS_TWO}")[..])
    );
    // And the rotated set was written back, so the next launch does not repeat
    // the 401.
    let stored = store.get(&credential_ref("team").unwrap()).unwrap();
    assert!(
        stored.expose().contains(ACCESS_TWO),
        "the rotation was lost"
    );
    assert!(stored.expose().contains("rt-two"), "the rotation was lost");
    assert!(
        !stored.expose().contains(REFRESH_ONE),
        "the spent refresh token is still stored"
    );
}

#[test]
fn a_second_401_after_a_refresh_is_a_refusal_rather_than_a_loop() {
    let tokens = MockServer::start(|_| {
        Reply::json(json!({ "access_token": ACCESS_TWO, "expires_in": 3600 }).to_string())
    });
    let server = MockServer::start(|_| Reply::status(401));

    let store: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    store_token(
        store.as_ref(),
        &json!({ "accessToken": ACCESS_ONE, "refreshToken": REFRESH_ONE }).to_string(),
    );
    let harness = harness_with(
        &server.url("/mcp"),
        json!({ "auth": { "type": "oauth", "clientId": "c",
                          "tokenEndpoint": tokens.url("/token") } }),
        store,
    );

    let error = failure(&harness.pool);
    assert_eq!(error.code(), McpFailureCode::AuthorizationRequired);
    assert_eq!(
        server.received().len(),
        2,
        "one attempt and exactly one retry; got {:?}",
        server
            .received()
            .iter()
            .map(|r| r.rpc_method())
            .collect::<Vec<_>>()
    );
    assert_eq!(tokens.hits("/token"), 1);
}

#[test]
fn a_stale_token_is_refreshed_before_the_request_rather_than_after_a_401() {
    let tokens = MockServer::start(|_| {
        Reply::json(
            json!({ "access_token": ACCESS_TWO, "refresh_token": "rt-two",
                    "expires_in": 3600 })
            .to_string(),
        )
    });
    let server = MockServer::start(|request| {
        if request.header("authorization") != Some(&format!("Bearer {ACCESS_TWO}")[..]) {
            return Reply::status(401);
        }
        mcp_answer(request, false)
    });

    let store: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    store_token(
        store.as_ref(),
        &json!({ "accessToken": ACCESS_ONE, "refreshToken": REFRESH_ONE,
                 "expiresAt": 1 })
        .to_string(),
    );
    let harness = harness_with(
        &server.url("/mcp"),
        json!({ "auth": { "type": "oauth", "clientId": "c",
                          "tokenEndpoint": tokens.url("/token") } }),
        store,
    );

    tool_names(&harness.pool);

    // Nothing was ever refused: the expiry the issuer stated was believed.
    for request in server.received() {
        assert_eq!(
            request.header("authorization"),
            Some(&format!("Bearer {ACCESS_TWO}")[..]),
            "a request went out on the expired token: {request:?}"
        );
    }
    assert_eq!(tokens.hits("/token"), 1);
}

#[test]
fn no_request_this_transport_makes_puts_a_token_in_a_url() {
    // THE RULE, asserted over every call the transport actually built rather
    // than over the one function that builds the refresh.
    let tokens = MockServer::start(|_| {
        Reply::json(
            json!({ "access_token": ACCESS_TWO, "refresh_token": "rt-two",
                    "expires_in": 3600 })
            .to_string(),
        )
    });
    let server = MockServer::start(|request| {
        if request.header("authorization") != Some(&format!("Bearer {ACCESS_TWO}")[..]) {
            return Reply::status(401);
        }
        mcp_answer(request, false)
    });

    let store: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    store_token(
        store.as_ref(),
        &json!({ "accessToken": ACCESS_ONE, "refreshToken": REFRESH_ONE }).to_string(),
    );
    let harness = harness_with(
        &server.url("/mcp"),
        json!({ "auth": { "type": "oauth", "clientId": "c",
                          "tokenEndpoint": tokens.url("/token") } }),
        store,
    );
    tool_names(&harness.pool);

    let calls = harness.exchange.calls();
    let wire: Vec<_> = server
        .received()
        .into_iter()
        .chain(tokens.received())
        .collect();
    // The same guard as `a_configured_header_cannot_displace_one_the_transport_owns`,
    // for the same reason: both loops below assert a *negative*, and a negative
    // over nothing is vacuously true. These two counts are what make the run
    // that follows evidence.
    assert!(!calls.is_empty(), "no call was recorded");
    assert!(
        wire.iter().any(|request| request.path.contains("/token")),
        "the refresh never reached the token endpoint, so the URLs below are \
         only the MCP server's: {wire:?}"
    );

    for call in &calls {
        for canary in [ACCESS_ONE, ACCESS_TWO, REFRESH_ONE, "rt-two"] {
            assert!(
                !call.url.contains(canary),
                "a credential reached a URL: {}",
                call.url
            );
        }
    }
    // And every request that was on the wire agrees.
    for request in &wire {
        for canary in [ACCESS_ONE, ACCESS_TWO, REFRESH_ONE, "rt-two"] {
            assert!(!request.path.contains(canary), "{}", request.path);
        }
    }
}

#[test]
fn the_authorization_server_may_not_set_this_clients_mcp_session_id() {
    // A different host, named by a different line of the configuration. A token
    // endpoint that could mint an `Mcp-Session-Id` could bind this client to a
    // session it did not open with the server it is talking to.
    let tokens = MockServer::start(|_| {
        Reply::json(json!({ "access_token": ACCESS_TWO, "expires_in": 3600 }).to_string())
            .with_header("mcp-session-id", "session-from-the-auth-server")
    });
    let server = MockServer::start(|request| {
        if request.header("authorization") != Some(&format!("Bearer {ACCESS_TWO}")[..]) {
            return Reply::status(401);
        }
        mcp_answer(request, false)
    });

    let store: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    store_token(
        store.as_ref(),
        &json!({ "accessToken": ACCESS_ONE, "refreshToken": REFRESH_ONE }).to_string(),
    );
    let harness = harness_with(
        &server.url("/mcp"),
        json!({ "auth": { "type": "oauth", "clientId": "c",
                          "tokenEndpoint": tokens.url("/token") } }),
        store,
    );
    tool_names(&harness.pool);

    for request in server.received() {
        assert_ne!(
            request.header("mcp-session-id"),
            Some("session-from-the-auth-server"),
            "the authorization server set the MCP session: {request:?}"
        );
    }
    assert!(
        server
            .received()
            .iter()
            .any(|request| request.header("mcp-session-id") == Some(SESSION)),
        "the MCP server's own session should still have been adopted"
    );
}

/// A store that installs a different value part-way through a run, so the
/// re-read inside the renewal lock is observable from a single thread.
struct RotatingStore {
    inner: MemoryStore,
    reads: AtomicUsize,
    install_at: usize,
    fresh: Mutex<String>,
}

impl SecretStore for RotatingStore {
    fn set(&self, reference: &SecretRef, value: &SecretValue) -> SecretResult<()> {
        self.inner.set(reference, value)
    }
    fn get(&self, reference: &SecretRef) -> SecretResult<SecretValue> {
        if self.reads.fetch_add(1, Ordering::SeqCst) == self.install_at {
            let fresh = self.fresh.lock().unwrap().clone();
            self.inner.set(reference, &SecretValue::new(fresh))?;
        }
        self.inner.get(reference)
    }
    fn delete(&self, reference: &SecretRef) -> SecretResult<()> {
        self.inner.delete(reference)
    }
    fn contains(&self, reference: &SecretRef) -> bool {
        self.inner.contains(reference)
    }
    fn list(&self) -> SecretResult<Vec<SecretRef>> {
        self.inner.list()
    }
    fn backend(&self) -> &'static str {
        "rotating-fake"
    }
}

#[test]
fn a_renewal_another_writer_already_did_is_not_done_a_second_time() {
    // OAuth 2.1 rotates a public client's refresh token, so spending one twice
    // signs the user out. `HttpTransport::renew` re-reads the store *after*
    // taking the renewal lock for exactly this reason. Two threads racing is not
    // a thing this box can be asked to reproduce reliably, so the re-read is
    // provoked instead: the store installs a fresh token between the staleness
    // check and the re-check, which is what a thread that won the lock would
    // have done.
    let tokens = MockServer::start(|_| {
        Reply::json(json!({ "access_token": "at-should-not-be-fetched" }).to_string())
    });
    let server = MockServer::start(|request| {
        if request.header("authorization") != Some(&format!("Bearer {ACCESS_TWO}")[..]) {
            return Reply::status(401);
        }
        mcp_answer(request, false)
    });

    let store = Arc::new(RotatingStore {
        inner: MemoryStore::new(),
        reads: AtomicUsize::new(0),
        // Read 0 is the staleness check; read 1 is the re-check under the lock.
        install_at: 1,
        fresh: Mutex::new(
            json!({ "accessToken": ACCESS_TWO, "refreshToken": "rt-two",
                    "expiresAt": 99_999_999_999u64 })
            .to_string(),
        ),
    });
    store_token(
        store.as_ref(),
        &json!({ "accessToken": ACCESS_ONE, "refreshToken": REFRESH_ONE, "expiresAt": 1 })
            .to_string(),
    );

    let harness = harness_with(
        &server.url("/mcp"),
        json!({ "auth": { "type": "oauth", "clientId": "c",
                          "tokenEndpoint": tokens.url("/token") } }),
        store,
    );
    tool_names(&harness.pool);

    assert_eq!(
        tokens.hits("/token"),
        0,
        "the refresh token was spent again even though the store already held a fresh set"
    );
}

// ---------------------------------------------------------------------------
// Death, and what the pool does about it
// ---------------------------------------------------------------------------

#[test]
fn a_404_on_an_open_session_kills_the_connection_and_the_pool_makes_a_new_one() {
    let sessions = Arc::new(AtomicUsize::new(0));
    let expire = Arc::new(AtomicUsize::new(0));
    let server_sessions = Arc::clone(&sessions);
    let server_expire = Arc::clone(&expire);
    let server = MockServer::start(move |request| {
        if request.method == "DELETE" {
            return Reply::status(204);
        }
        if request.rpc_method().as_deref() == Some("initialize") {
            let n = server_sessions.fetch_add(1, Ordering::SeqCst) + 1;
            let id = request.rpc_id().unwrap_or(0);
            return Reply::json(
                json!({ "jsonrpc": "2.0", "id": id, "result": { "protocolVersion": "2025-06-18" } })
                    .to_string(),
            )
            .with_header("mcp-session-id", format!("session-{n}"));
        }
        if server_expire.load(Ordering::SeqCst) == 1
            && request.rpc_method().as_deref() == Some("tools/call")
        {
            return Reply::status(404);
        }
        mcp_answer(request, false)
    });

    let harness = harness(&server.url("/mcp"));
    let first = harness.pool.connect("team").expect("connect");
    first.list_tools().expect("a working session");

    expire.store(1, Ordering::SeqCst);
    assert!(
        matches!(
            first.call_tool("add", json!({})),
            Err(McpError::ServerExited)
        ),
        "a 404 on an open session is the session ending"
    );
    assert!(!first.is_alive());

    expire.store(0, Ordering::SeqCst);
    let replacement = harness
        .pool
        .connect("team")
        .expect("the pool must replace it");
    assert!(
        !Arc::ptr_eq(&first, &replacement),
        "the pool handed back the dead connection"
    );
    assert!(!replacement.list_tools().unwrap().is_empty());
    assert_eq!(
        sessions.load(Ordering::SeqCst),
        2,
        "the replacement must open a new session, not reuse the ended one"
    );
}

#[test]
fn shutting_the_pool_down_ends_the_session_on_the_server() {
    let server = MockServer::start(|request| mcp_answer(request, false));
    let harness = harness(&server.url("/mcp"));
    tool_names(&harness.pool);
    harness.pool.shutdown();

    let deletes: Vec<support::Received> = server
        .received()
        .into_iter()
        .filter(|request| request.method == "DELETE")
        .collect();
    assert_eq!(
        deletes.len(),
        1,
        "a session left open is a session left open"
    );
    assert_eq!(deletes[0].header("mcp-session-id"), Some(SESSION));
}

/// A port that was bound and released: nothing is listening, and nothing else in
/// this test run has been handed it.
fn dead_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

#[test]
fn an_endpoint_nothing_is_listening_on_is_unreachable_rather_than_a_handshake_failure() {
    let harness = harness(&format!("http://127.0.0.1:{}/mcp", dead_port()));

    let error = failure(&harness.pool);
    assert_eq!(
        error.code(),
        McpFailureCode::EndpointUnreachable,
        "an endpoint that was never reached did not bungle a handshake; got {error:?}"
    );
}

#[test]
fn an_unreachable_token_endpoint_names_itself_and_not_the_mcp_server() {
    // THE ATTRIBUTION RULE. An OAuth entry names two hosts, on two different
    // lines: `url` and `auth.tokenEndpoint`. When the token endpoint is the one
    // that is down, an error built from `url` sends a user to go and fix a
    // server that is healthy — and, as the last assertion measures, was never
    // contacted at all. `HttpTransport::exchange` takes the endpoint off the
    // call it made, which is what makes that impossible rather than unlikely.
    let server = MockServer::start(|request| mcp_answer(request, false));
    let token_endpoint = format!("http://127.0.0.1:{}/token", dead_port());

    let store: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    store_token(
        store.as_ref(),
        // `expiresAt: 1` is 1970, so the refresh is attempted before the first
        // request rather than after a 401 — which is what puts the token
        // endpoint on the wire ahead of the MCP server.
        &json!({ "accessToken": ACCESS_ONE, "refreshToken": REFRESH_ONE, "expiresAt": 1 })
            .to_string(),
    );
    let harness = harness_with(
        &server.url("/mcp"),
        json!({ "auth": { "type": "oauth", "clientId": "c",
                          "tokenEndpoint": token_endpoint } }),
        store,
    );

    let error = failure(&harness.pool);
    assert_eq!(
        error.code(),
        McpFailureCode::EndpointUnreachable,
        "{error:?}"
    );

    let rendered = format!("{error} / {error:?}");
    assert!(
        rendered.contains(&token_endpoint),
        "the error should name the host that went quiet: {rendered}"
    );
    assert!(
        !rendered.contains(&server.url("/mcp")),
        "the error names the MCP server, which is answering: {rendered}"
    );
    assert!(
        server.received().is_empty(),
        "the MCP server was contacted after all: {:?}",
        server.received()
    );
}

#[test]
fn a_token_endpoint_that_refuses_a_connection_does_not_bury_the_transport() {
    // The other half of the same rule. Burying is `send`'s job because only
    // `send` knows the call went to this server's own endpoint; a token endpoint
    // refusing a connection says nothing about whether the MCP server is there.
    // Proved by using the *same transport instance* again once a credential it
    // does not have to refresh is in the store.
    let server = MockServer::start(|request| mcp_answer(request, false));
    let token_endpoint = format!("http://127.0.0.1:{}/token", dead_port());

    let store: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    store_token(
        store.as_ref(),
        &json!({ "accessToken": ACCESS_ONE, "refreshToken": REFRESH_ONE, "expiresAt": 1 })
            .to_string(),
    );
    let config = config_for(
        &server.url("/mcp"),
        json!({ "auth": { "type": "oauth", "clientId": "c",
                          "tokenEndpoint": token_endpoint } }),
    );
    let ServerSpec::Http(spec) = config.server("team").expect("the entry parses") else {
        panic!("a url entry must resolve to the HTTP transport");
    };
    let deps = RemoteDeps {
        credentials: Arc::clone(&store),
        http: Arc::new(LoopbackExchange::default()) as Arc<dyn vela_mcp::exchange::HttpExchange>,
    };
    let transport = HttpTransport::connect("team", spec, &deps, Arc::new(|_: &str, _: &Value| {}));

    let error = transport
        .request("tools/list", json!({}))
        .expect_err("the token endpoint is not listening");
    assert_eq!(
        error.code(),
        McpFailureCode::EndpointUnreachable,
        "{error:?}"
    );
    assert!(
        transport.is_alive(),
        "a token endpoint refusing a connection buried a transport whose own \
         server is answering"
    );

    // A token with no stated expiry needs no refresh, so the next request goes
    // straight to the MCP server — on the transport that the failure above did
    // not kill.
    store_token(store.as_ref(), ACCESS_ONE);
    let answer = transport
        .request("tools/list", json!({}))
        .expect("the same transport must still reach a server that is answering");
    assert!(
        answer["tools"].is_array(),
        "the MCP server answered: {answer}"
    );
    assert_eq!(server.rpc("tools/list").len(), 1);
}

#[test]
fn a_status_this_transport_cannot_use_never_carries_the_servers_body_into_the_error() {
    const LEAK: &str = "INTERNAL-STACK-TRACE-DO-NOT-RENDER";

    // Mid-session: the server is up, the handshake worked, and `tools/list`
    // answers 500 with a body full of its own internals.
    let server = MockServer::start(|request| {
        if request.rpc_method().as_deref() == Some("tools/list") {
            return Reply::status(500)
                .with_header("content-type", "text/html")
                .with_body(format!("<h1>{LEAK}</h1>"));
        }
        mcp_answer(request, false)
    });
    let mid_session = harness(&server.url("/mcp"));
    let error = failure(&mid_session.pool);
    assert_eq!(error.code(), McpFailureCode::ServerError);
    let rendered = format!("{error} / {error:?}");
    assert!(!rendered.contains(LEAK), "{rendered}");
    assert!(rendered.contains("500"), "{rendered}");

    // The same status during the handshake is a handshake failure — a different
    // code, because a server that never got as far as answering `initialize` is
    // a different thing for a user to act on. The body must not leak either way,
    // and the handshake path is the one that stringifies the inner error, which
    // is exactly where a body would have been carried along.
    let broken = MockServer::start(|_| {
        Reply::status(500)
            .with_header("content-type", "text/html")
            .with_body(format!("<h1>{LEAK}</h1>"))
    });
    let broken_harness = harness(&broken.url("/mcp"));
    let error = failure(&broken_harness.pool);
    assert_eq!(error.code(), McpFailureCode::HandshakeFailed);
    let rendered = format!("{error} / {error:?}");
    assert!(!rendered.contains(LEAK), "{rendered}");
    assert!(rendered.contains("500"), "{rendered}");
}

#[test]
fn diagnostics_are_kept_and_are_never_evidence_of_failure() {
    // The HTTP counterpart of `stderr_output_is_captured_and_is_not_treated_as_a_failure`.
    let server = MockServer::start(|request| mcp_answer(request, false));
    let harness = harness(&server.url("/mcp"));
    let connection = harness.pool.connect("team").expect("connect");
    connection.list_tools().expect("a working server");

    let logged = connection.recent_diagnostics();
    assert!(
        logged.iter().any(|line| line.starts_with("200 ")),
        "got {logged:?}"
    );
    assert!(connection.is_alive());
}

#[test]
fn two_servers_with_the_same_tool_name_do_not_collide() {
    // The namespacing rule, asserted across transports rather than within one.
    let server = MockServer::start(|request| mcp_answer(request, false));
    let exchange = Arc::new(LoopbackExchange::default());
    let config = McpConfig::parse(
        &json!({ "mcpServers": {
            "team": { "url": server.url("/mcp") },
            "other": { "url": server.url("/mcp") }
        }})
        .to_string(),
    )
    .unwrap();
    let pool = McpPool::with_remote(
        config,
        RemoteDeps {
            credentials: Arc::new(MemoryStore::new()),
            http: exchange as Arc<dyn vela_mcp::exchange::HttpExchange>,
        },
    );

    let names: BTreeMap<String, Vec<String>> = pool
        .list_all_tools()
        .into_iter()
        .map(|row| {
            (
                row.server_id,
                row.outcome
                    .expect("both serve")
                    .into_iter()
                    .map(|tool| tool.name)
                    .collect(),
            )
        })
        .collect();
    assert_eq!(names["team"], vec!["add".to_owned()]);
    assert_eq!(names["other"], vec!["add".to_owned()]);
    assert_ne!(
        vela_mcp::namespaced_tool_name("team", "add"),
        vela_mcp::namespaced_tool_name("other", "add")
    );
}
