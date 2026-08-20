//! **VERIFIED AGAINST A REAL PROCESS.** Every test in this file launches an
//! actual OS process, hands it actual pipes, and reads actual bytes back. The
//! server on the other end is a fixture — `tests/fixtures/mock-mcp-server.mjs`,
//! a node script — but nothing about the transport is simulated: the framing,
//! the buffering, the handshake, the process teardown and the death are all
//! real, and they are the parts that are hard.
//!
//! The distinction matters because a mocked transport can pass while the app
//! hangs. A client that never notices end-of-file, or that buffers a line
//! forever, or that hands the child its parent's environment, looks identical
//! from behind a fake.
//!
//! `node` must be on PATH. It is: this repository's frontend is built with it.
//! If it is missing these tests fail rather than skipping, because a suite that
//! quietly tests nothing is the defect this project keeps finding in itself.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::json;
use vela_mcp::client::McpConnection;
use vela_mcp::config::{McpConfig, ServerSpec, StdioServer};
use vela_mcp::error::McpError;
use vela_mcp::pool::McpPool;

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mock-mcp-server.mjs")
}

fn stdio_server() -> StdioServer {
    StdioServer {
        command: "node".to_owned(),
        args: vec![fixture().display().to_string()],
        env: BTreeMap::new(),
        cwd: None,
    }
}

fn server() -> ServerSpec {
    ServerSpec::Stdio(stdio_server())
}

/// Every test here drives a local process, so no build of this crate needs an
/// HTTP backend to run them — which is also the state a build without one is in,
/// and `listing_every_server_reports_the_unwired_one_without_losing_the_working_one`
/// is what holds that down.
fn connect(id: &str, spec: &ServerSpec) -> vela_mcp::error::McpResult<McpConnection> {
    McpConnection::connect(id, spec, None)
}

/// A configuration naming the fixture, as a user's own file would.
fn config_naming_the_fixture() -> McpConfig {
    let source = json!({
        "mcpServers": {
            "fixture": { "command": "node", "args": [fixture().display().to_string()] },
            "remote": { "url": "https://mcp.example.com" }
        }
    })
    .to_string();
    McpConfig::parse(&source).expect("the fixture configuration must parse")
}

fn text_of(result: &serde_json::Value) -> String {
    result
        .get("content")
        .and_then(|content| content.get(0))
        .and_then(|first| first.get("text"))
        .and_then(|text| text.as_str())
        .unwrap_or_default()
        .to_owned()
}

#[test]
fn a_real_server_process_answers_a_real_tool_list_over_a_real_pipe() {
    let connection = connect("fixture", &server()).expect("handshake");
    let tools = connection.list_tools().expect("tools/list");

    let names: Vec<&str> = tools.iter().map(|tool| tool.name.as_str()).collect();
    assert!(names.contains(&"add"), "got {names:?}");
    assert!(names.contains(&"echo_env"), "got {names:?}");

    let add = tools.iter().find(|tool| tool.name == "add").unwrap();
    assert_eq!(add.title.as_deref(), Some("Add two numbers"));
    assert_eq!(
        add.input_schema.get("type").and_then(|t| t.as_str()),
        Some("object"),
        "the schema a model needs to call the tool must survive the pipe intact"
    );
}

#[test]
fn a_tool_call_round_trips_arguments_and_a_result() {
    let connection = connect("fixture", &server()).expect("handshake");
    let result = connection
        .call_tool("add", json!({ "a": 2, "b": 40 }))
        .expect("tools/call");
    assert_eq!(text_of(&result), "42");
}

#[test]
fn the_server_does_not_inherit_the_parent_environment() {
    // The rule INHERITED_ENV exists for. A desktop app's environment holds
    // whatever the user's shell put there; an MCP server is third-party code
    // launched from a pasted command line.
    std::env::set_var("VELA_MCP_SECRET_CANARY", "must-not-reach-the-child");

    let mut with_own_env = stdio_server();
    with_own_env
        .env
        .insert("VELA_MCP_DECLARED".to_owned(), "declared".to_owned());
    let connection = connect("fixture", &ServerSpec::Stdio(with_own_env)).expect("handshake");

    let leaked = connection
        .call_tool("echo_env", json!({ "name": "VELA_MCP_SECRET_CANARY" }))
        .expect("tools/call");
    assert_eq!(
        text_of(&leaked),
        "<unset>",
        "an undeclared variable of the parent process reached the child"
    );

    let declared = connection
        .call_tool("echo_env", json!({ "name": "VELA_MCP_DECLARED" }))
        .expect("tools/call");
    assert_eq!(text_of(&declared), "declared");

    // PATH is on the allowlist because a server that cannot find its own
    // interpreter cannot run at all.
    let path = connection
        .call_tool("echo_env", json!({ "name": "PATH" }))
        .expect("tools/call");
    assert_ne!(text_of(&path), "<unset>");
}

#[test]
fn a_second_read_of_the_tool_list_is_served_from_cache() {
    let connection = connect("fixture", &server()).expect("handshake");
    connection.list_tools().expect("first");
    connection.list_tools().expect("second");
    connection.list_tools().expect("third");

    // The server counts what it served. Three reads, one request on the wire.
    let served = connection
        .call_tool("list_calls", json!({}))
        .expect("tools/call");
    assert_eq!(
        text_of(&served),
        "1",
        "the tool list was refetched; the cache is not connected"
    );
}

#[test]
fn a_list_changed_notification_invalidates_the_cached_tool_list() {
    let connection = connect("fixture", &server()).expect("handshake");
    let before = connection.list_tools().expect("first");
    assert!(!before.iter().any(|tool| tool.name == "grown_tool"));

    // `grow` mutates the server's tool set and announces it with
    // `notifications/tools/list_changed` on the shared channel.
    connection.call_tool("grow", json!({})).expect("tools/call");

    let after = connection.list_tools().expect("after the notification");
    assert!(
        after.iter().any(|tool| tool.name == "grown_tool"),
        "the cache served a list the server had already announced as stale"
    );

    let served = connection
        .call_tool("list_calls", json!({}))
        .expect("tools/call");
    assert_eq!(
        text_of(&served),
        "2",
        "the invalidation should cost exactly one refetch"
    );
}

#[test]
fn a_server_that_dies_mid_request_fails_that_request_rather_than_hanging() {
    let connection = connect("fixture", &server()).expect("handshake");

    let started = std::time::Instant::now();
    let outcome = connection.call_tool("die", json!({}));
    let elapsed = started.elapsed();

    assert!(
        matches!(outcome, Err(McpError::ServerExited)),
        "expected the request to fail with the server's death, got {outcome:?}"
    );
    assert!(
        elapsed < Duration::from_secs(5),
        "the request waited {elapsed:?}; a dead server must fail its callers at once, \
         not after the request timeout"
    );
    assert!(!connection.is_alive());

    // And every later request fails the same way rather than blocking.
    assert!(matches!(
        connection.list_tools(),
        Err(McpError::ServerExited)
    ));
}

#[test]
fn stderr_output_is_captured_and_is_not_treated_as_a_failure() {
    // The fixture logs a line to stderr at startup, as many real servers do.
    // A client that read stderr as an error would refuse a working server.
    let connection = connect("fixture", &server()).expect("handshake");
    connection
        .list_tools()
        .expect("a chatty server still works");

    // The log line is read on another thread; give it a moment to arrive.
    for _ in 0..50 {
        if !connection.recent_diagnostics().is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let logged = connection.recent_diagnostics();
    assert!(
        logged.iter().any(|line| line.contains("ready")),
        "stderr should be captured for diagnostics, got {logged:?}"
    );
}

#[test]
fn the_pool_reuses_one_process_per_server() {
    let pool = McpPool::new(config_naming_the_fixture());

    let first = pool.connect("fixture").expect("first connect");
    let second = pool.connect("fixture").expect("second connect");
    assert!(
        std::sync::Arc::ptr_eq(&first, &second),
        "the pool handed out two connections for one server"
    );

    let pid_a = text_of(&first.call_tool("whoami", json!({})).unwrap());
    let pid_b = text_of(&second.call_tool("whoami", json!({})).unwrap());
    assert_eq!(pid_a, pid_b, "two processes were spawned for one server");
    assert!(!pid_a.is_empty());
}

#[test]
fn the_pool_replaces_a_server_that_died() {
    let pool = McpPool::new(config_naming_the_fixture());

    let first = pool.connect("fixture").expect("first connect");
    let original = text_of(&first.call_tool("whoami", json!({})).unwrap());
    assert!(matches!(
        first.call_tool("die", json!({})),
        Err(McpError::ServerExited)
    ));

    let replacement = pool.connect("fixture").expect("the pool must restart it");
    let restarted = text_of(&replacement.call_tool("whoami", json!({})).unwrap());
    assert_ne!(
        original, restarted,
        "the pool handed back the dead process instead of replacing it"
    );
    assert!(!replacement.list_tools().unwrap().is_empty());
}

#[test]
fn listing_every_server_reports_the_unwired_one_without_losing_the_working_one() {
    let pool = McpPool::new(config_naming_the_fixture());
    let rows = pool.list_all_tools();

    let fixture_row = rows
        .iter()
        .find(|row| row.server_id == "fixture")
        .expect("the working server must be listed");
    assert!(fixture_row
        .outcome
        .as_ref()
        .expect("the working server must have tools")
        .iter()
        .any(|tool| tool.name == "add"));

    // `McpPool::new` builds a pool with no HTTP backend, which is what a build
    // that did not wire one has. `TransportNotSupported` is still the answer —
    // but it is now the answer to "this *build* cannot", not to "this client
    // never can", and `tests/http_end_to_end.rs` drives the same entry through a
    // pool that does have one.
    let remote_row = rows
        .iter()
        .find(|row| row.server_id == "remote")
        .expect("a server this build cannot reach must still be listed");
    assert!(matches!(
        remote_row.outcome,
        Err(McpError::TransportNotSupported { .. })
    ));
}

#[test]
fn a_command_that_does_not_exist_fails_to_spawn_rather_than_hanging() {
    let missing = StdioServer {
        command: "vela-no-such-mcp-server-binary".to_owned(),
        args: Vec::new(),
        env: BTreeMap::new(),
        cwd: None,
    };
    assert!(matches!(
        connect("missing", &ServerSpec::Stdio(missing)),
        Err(McpError::SpawnFailed { .. })
    ));
}
