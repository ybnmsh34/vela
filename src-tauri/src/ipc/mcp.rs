//! `mcp_*` commands — the tools a user's own MCP servers offer.
//!
//! ## What crosses this boundary, and what does not
//!
//! A tool as the renderer sees it is a name, a description and a JSON Schema —
//! deliberately the three fields `ToolDefinitionInput` in
//! `src/platform/contract.ts` already carries, so a tool that came from an MCP
//! server reaches `chat_send` as a projection rather than a translation. Nothing
//! about *how* the server was reached crosses: no command line, no argv, no
//! environment, no process id. A renderer that could read the command line would
//! eventually render it, and it is a path into the user's machine.
//!
//! Failures cross as [`vela_mcp::McpFailureCode`], a closed set, for the reason
//! `ChatError` gives for its own: an error string produced by a third-party
//! process is unbounded text that would end up in a window.
//!
//! ## Why the tool list is a command and not an event
//!
//! Connecting to a server means spawning it and waiting for a handshake, which
//! is a request with an answer. The push half — a server announcing that its
//! tools changed — is handled inside `vela-mcp`, by invalidating the cache, so
//! the next call to this command tells the truth without the renderer having to
//! subscribe to anything.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use vela_mcp::client::namespaced_tool_name;
use vela_mcp::config::McpConfig;
use vela_mcp::error::McpFailureCode;
use vela_mcp::http::RemoteDeps;
use vela_mcp::pool::McpPool;

use super::{EmptyPayload, IpcResult};

/// The file the user writes their servers into, inside the app's own data
/// directory. Named for what it holds rather than for the app, because a user
/// looking at a directory of files should be able to tell which one this is.
pub const CONFIG_FILE_NAME: &str = "mcp-servers.json";

/// The host's MCP state: one pool for the process, and whatever went wrong
/// reading the configuration.
///
/// **An unreadable configuration does not stop startup.** MCP is optional; a
/// JSON typo in it is not a reason to refuse to open a window. The failure is
/// carried here and reported on every list, which is a state a settings surface
/// can render and a user can act on.
pub struct McpHost {
    pool: McpPool,
    config_failure: Option<McpFailureCode>,
}

impl McpHost {
    /// Read the "mcp-servers.json" file from the application data directory.
    /// The name is in straight quotes because it is a file on the user's
    /// machine, not one in this repository, and this tree's path guard is
    /// entitled to read a backticked path as a claim about itself.
    ///
    /// # The file's ACL is the application-data root's ACL
    ///
    /// `directory` is `app_data_dir()`, the same directory `store_host::open`
    /// hands `DatabaseLocation::in_directory`, and "mcp-servers.json" is a
    /// **direct child** of it. That is not incidental. `DatabaseLocation::prepare`
    /// hardens that root through `vela-privatefs` — an explicit DACL with
    /// inheritance disabled — and then walks it with
    /// `vela_privatefs::repair_entries`, which re-reads every entry's ACL and
    /// hardens any that a foreign principal can still reach. So this file is
    /// covered by the same pass that covers `vela.db`, on every launch, because
    /// it sits beside it. Two tests in this module's `tests` are what keep that
    /// true if either path moves:
    /// `the_configuration_file_is_read_from_the_root_and_not_from_below_it`
    /// pins the "direct child" half, and
    /// `a_widened_configuration_file_is_hardened_by_the_same_pass_that_hardens_the_database`
    /// pins the hardening half against real Windows ACLs.
    ///
    /// **Nothing here creates or writes the file**, and no credential is ever in
    /// it — `vela_mcp::config` refuses an entry that tries. The tokens live in
    /// the OS credential store.
    ///
    /// `remote` is what lets a `url` entry be reached. `None` produces a pool
    /// that reports `transportNotSupported` for one, which is the truth about a
    /// process whose HTTP backend did not start.
    pub fn under_data_dir(directory: PathBuf, remote: Option<RemoteDeps>) -> Self {
        Self::from_path(directory.join(CONFIG_FILE_NAME), remote)
    }

    fn from_path(path: PathBuf, remote: Option<RemoteDeps>) -> Self {
        let pool = |config| match remote {
            Some(remote) => McpPool::with_remote(config, remote),
            None => McpPool::new(config),
        };
        match McpConfig::read(&path) {
            Ok(config) => Self {
                pool: pool(config),
                config_failure: None,
            },
            Err(error) => Self {
                pool: pool(McpConfig::default()),
                config_failure: Some(error.code()),
            },
        }
    }
}

/// One tool, in the shape a turn already takes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolView {
    /// `mcp__<server>__<tool>`. Unique across servers, which the server's own
    /// name is not.
    pub name: String,
    /// The server's own name for it — what a call has to be sent as. Carried so
    /// the renderer never has to take the namespaced name apart.
    pub tool_name: String,
    /// Empty rather than absent when the server described nothing: a missing
    /// description is a tool with no explanation, not a tool that is absent.
    pub description: String,
    /// The JSON Schema for the arguments object, verbatim from the server.
    pub parameters: Value,
}

/// Whether a server is serving, and if not, why not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum McpServerStatus {
    Connected,
    Unavailable { reason: McpFailureCode },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerToolsView {
    pub server_id: String,
    pub status: McpServerStatus,
    /// Empty for an unavailable server. The row is still present, because a
    /// server the user configured that silently vanished from the list is the
    /// reduction conventions §9 forbids.
    pub tools: Vec<McpToolView>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpListToolsRes {
    /// `null` when the configuration file read cleanly — including when there is
    /// no file at all, which is where every user starts.
    pub config_failure: Option<McpFailureCode>,
    pub servers: Vec<McpServerToolsView>,
}

/// Pure logic — no Tauri types, so it is testable headlessly.
pub fn list_tools(host: &McpHost) -> McpListToolsRes {
    let servers = host
        .pool
        .list_all_tools()
        .into_iter()
        .map(|row| match row.outcome {
            Ok(tools) => McpServerToolsView {
                status: McpServerStatus::Connected,
                tools: tools
                    .into_iter()
                    .map(|tool| McpToolView {
                        name: namespaced_tool_name(&row.server_id, &tool.name),
                        tool_name: tool.name,
                        description: tool.description.unwrap_or_default(),
                        parameters: tool.input_schema,
                    })
                    .collect(),
                server_id: row.server_id,
            },
            Err(error) => McpServerToolsView {
                server_id: row.server_id,
                status: McpServerStatus::Unavailable {
                    reason: error.code(),
                },
                tools: Vec::new(),
            },
        })
        .collect();

    McpListToolsRes {
        config_failure: host.config_failure,
        servers,
    }
}

#[tauri::command]
pub fn mcp_list_tools(
    host: State<'_, McpHost>,
    payload: EmptyPayload,
) -> IpcResult<McpListToolsRes> {
    let _ = payload;
    Ok(list_tools(&host))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same node server `vela-mcp`'s own end-to-end suite drives, reached
    /// from this crate so that the command — not just the library — is proven
    /// against a real process.
    fn fixture_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("crates/vela-mcp/tests/fixtures/mock-mcp-server.mjs")
    }

    fn host_with(config: &str) -> (tempfile::TempDir, McpHost) {
        host_with_remote(config, None)
    }

    fn host_with_remote(config: &str, remote: Option<RemoteDeps>) -> (tempfile::TempDir, McpHost) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(CONFIG_FILE_NAME), config).unwrap();
        let host = McpHost::under_data_dir(dir.path().to_path_buf(), remote);
        (dir, host)
    }

    #[test]
    fn no_configuration_file_is_an_empty_answer_and_not_a_failure() {
        let dir = tempfile::tempdir().unwrap();
        let host = McpHost::under_data_dir(dir.path().to_path_buf(), None);
        let response = list_tools(&host);
        assert_eq!(response.config_failure, None);
        assert!(response.servers.is_empty());
    }

    #[test]
    fn an_unreadable_configuration_is_reported_rather_than_thrown() {
        let (_dir, host) = host_with("{ this is not json");
        let response = list_tools(&host);
        assert_eq!(
            response.config_failure,
            Some(McpFailureCode::ConfigUnreadable)
        );
        assert!(response.servers.is_empty());
    }

    #[test]
    fn the_command_returns_tools_from_a_real_server_process() {
        let config = serde_json::json!({
            "mcpServers": {
                "fixture": {
                    "command": "node",
                    "args": [fixture_path().display().to_string()]
                }
            }
        })
        .to_string();
        let (_dir, host) = host_with(&config);

        let response = list_tools(&host);
        assert_eq!(response.config_failure, None);
        assert_eq!(response.servers.len(), 1);

        let server = &response.servers[0];
        assert_eq!(server.server_id, "fixture");
        assert_eq!(server.status, McpServerStatus::Connected);

        let add = server
            .tools
            .iter()
            .find(|tool| tool.tool_name == "add")
            .expect("the fixture exposes add");
        assert_eq!(
            add.name, "mcp__fixture__add",
            "the catalogue name must be namespaced, or two servers collide"
        );
        assert_eq!(add.description, "Adds a and b.");
        assert_eq!(
            add.parameters.get("type").and_then(Value::as_str),
            Some("object"),
            "a model cannot call a tool whose schema did not survive the boundary"
        );
    }

    #[test]
    fn a_server_that_cannot_be_launched_is_listed_with_its_reason() {
        let config = r#"{ "mcpServers": { "broken": { "command": "vela-no-such-binary" } } }"#;
        let (_dir, host) = host_with(config);

        let response = list_tools(&host);
        let server = &response.servers[0];
        assert_eq!(server.server_id, "broken");
        assert_eq!(
            server.status,
            McpServerStatus::Unavailable {
                reason: McpFailureCode::SpawnFailed
            }
        );
        assert!(server.tools.is_empty());
    }

    #[test]
    fn a_remote_entry_is_unsupported_only_when_this_process_has_no_http_backend() {
        // `transportNotSupported` used to be the answer to every `url` entry.
        // It is now the answer to one thing only — a process whose HTTP client
        // did not start — and this asserts the *narrowness*, because a build
        // that quietly kept the old behaviour would pass a test that only
        // checked the `None` case.
        let config = r#"{ "mcpServers": { "remote": { "url": "https://example.com/mcp" } } }"#;
        let (_dir, host) = host_with(config);

        let response = list_tools(&host);
        assert_eq!(
            response.servers[0].status,
            McpServerStatus::Unavailable {
                reason: McpFailureCode::TransportNotSupported
            }
        );
    }

    /// A remote MCP server on a loopback port, answering the two methods this
    /// command's path sends. Small on purpose: what is under test here is the
    /// **command**, not the transport — `vela-mcp/tests/http_end_to_end.rs`
    /// tests the transport, in twenty-two tests scripting twenty-eight mock
    /// servers between them. Recount rather than trust: over that file,
    /// `grep -c '^#\[test\]'` gives twenty-two and
    /// `grep 'MockServer::start' … | grep -v '//'` gives twenty-eight — the
    /// second filter matters, because that file's own module docs name the
    /// symbol in prose. `cargo test -p vela-mcp --test http_end_to_end` prints
    /// the test count back.
    fn remote_mcp_server() -> (u16, std::sync::Arc<std::sync::atomic::AtomicBool>) {
        use std::io::{BufRead, BufReader, Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let served = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = std::sync::Arc::clone(&served);

        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let Ok(clone) = stream.try_clone() else {
                    continue;
                };
                let mut reader = BufReader::new(clone);
                let mut length = 0usize;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        break;
                    }
                    let line = line.trim_end().to_ascii_lowercase();
                    if line.is_empty() {
                        break;
                    }
                    if let Some(value) = line.strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0u8; length];
                if length > 0 && reader.read_exact(&mut body).is_err() {
                    continue;
                }
                let request: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                let id = request.get("id").and_then(Value::as_u64).unwrap_or(0);
                let payload = match request.get("method").and_then(Value::as_str) {
                    Some("initialize") => serde_json::json!({
                        "jsonrpc": "2.0", "id": id,
                        "result": { "protocolVersion": "2025-06-18" }
                    })
                    .to_string(),
                    Some("tools/list") => {
                        flag.store(true, std::sync::atomic::Ordering::SeqCst);
                        serde_json::json!({
                            "jsonrpc": "2.0", "id": id,
                            "result": { "tools": [{
                                "name": "search",
                                "description": "Searches the team wiki.",
                                "inputSchema": { "type": "object" }
                            }]}
                        })
                        .to_string()
                    }
                    _ => String::new(),
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
                    payload.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        (port, served)
    }

    fn live_remote_deps() -> RemoteDeps {
        RemoteDeps {
            credentials: std::sync::Arc::new(vela_secrets::MemoryStore::new()),
            http: std::sync::Arc::new(
                crate::mcp_http::ProviderBackedExchange::start().expect("the client starts"),
            ),
        }
    }

    #[test]
    fn the_command_returns_tools_from_a_real_remote_server_over_a_real_socket() {
        // THE DEFECT, AT THE BOUNDARY THE RENDERER SEES. `mcp_list_tools` could
        // not answer anything but `transportNotSupported` for a `url` entry,
        // whatever was behind it.
        let (port, served) = remote_mcp_server();
        let config = format!(
            r#"{{ "mcpServers": {{ "team": {{ "url": "http://127.0.0.1:{port}/mcp" }} }} }}"#
        );
        let (_dir, host) = host_with_remote(&config, Some(live_remote_deps()));

        let response = list_tools(&host);
        assert_eq!(response.config_failure, None);
        assert_eq!(response.servers.len(), 1);

        let server = &response.servers[0];
        assert_eq!(server.status, McpServerStatus::Connected);
        let search = server
            .tools
            .iter()
            .find(|tool| tool.tool_name == "search")
            .unwrap_or_else(|| panic!("the remote server exposes search; got {:?}", server.tools));
        assert_eq!(search.name, "mcp__team__search");
        assert_eq!(search.description, "Searches the team wiki.");
        assert_eq!(
            search.parameters.get("type").and_then(Value::as_str),
            Some("object")
        );
        assert!(
            served.load(std::sync::atomic::Ordering::SeqCst),
            "the tools came from somewhere other than the server"
        );
    }

    #[test]
    fn a_remote_server_that_is_not_answering_is_unreachable_and_not_unsupported() {
        // The control for the test above and the sharp edge of the fix: with a
        // backend present, `transportNotSupported` must never be the answer to
        // a `url` entry again — even when the entry does not work.
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let config = format!(
            r#"{{ "mcpServers": {{ "team": {{ "url": "http://127.0.0.1:{port}/mcp" }} }} }}"#
        );
        let (_dir, host) = host_with_remote(&config, Some(live_remote_deps()));

        assert_eq!(
            list_tools(&host).servers[0].status,
            McpServerStatus::Unavailable {
                reason: McpFailureCode::EndpointUnreachable
            }
        );
    }

    #[test]
    fn a_remote_entry_needing_a_credential_it_does_not_have_says_so() {
        let (port, _served) = remote_mcp_server();
        let config = format!(
            r#"{{ "mcpServers": {{ "team": {{ "url": "http://127.0.0.1:{port}/mcp", "auth": {{ "type": "bearer" }} }} }} }}"#
        );
        let (_dir, host) = host_with_remote(&config, Some(live_remote_deps()));

        assert_eq!(
            list_tools(&host).servers[0].status,
            McpServerStatus::Unavailable {
                reason: McpFailureCode::AuthorizationRequired
            },
            "an empty keychain is `sign in`, not `your file is broken`"
        );
    }

    #[test]
    fn the_configuration_file_is_read_from_the_root_and_not_from_below_it() {
        // The structural half of the ACL claim. `vela_privatefs::repair_entries`
        // walks the application-data root's own entries; a configuration file
        // one directory down would be outside that pass unless the directory
        // above it happened to need repairing. It is a direct child, and this is
        // what says so.
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("mcp")).unwrap();
        std::fs::write(
            dir.path().join("mcp").join(CONFIG_FILE_NAME),
            r#"{ "mcpServers": { "buried": { "command": "node" } } }"#,
        )
        .unwrap();
        let host = McpHost::under_data_dir(dir.path().to_path_buf(), None);
        assert!(
            list_tools(&host).servers.is_empty(),
            "the host read a file from somewhere other than the root it was given"
        );

        std::fs::write(
            dir.path().join(CONFIG_FILE_NAME),
            r#"{ "mcpServers": { "at-the-root": { "command": "node" } } }"#,
        )
        .unwrap();
        let host = McpHost::under_data_dir(dir.path().to_path_buf(), None);
        assert_eq!(list_tools(&host).servers[0].server_id, "at-the-root");
    }

    /// The measured half. Windows only, because widening an ACL is the thing
    /// being undone and `icacls` is how a widened one is produced — the same
    /// grant `docs/desktop-gate/VERDICTS.md` found inherited on a real
    /// `%APPDATA%` directory, applied here explicitly so the repair has
    /// something to repair.
    #[cfg(windows)]
    #[test]
    fn a_widened_configuration_file_is_hardened_by_the_same_pass_that_hardens_the_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CONFIG_FILE_NAME);
        std::fs::write(&path, r#"{ "mcpServers": {} }"#).unwrap();

        // `*S-1-1-0` is Everyone, by SID rather than by name, because the name
        // is localised and this machine's language is not a test input.
        let granted = std::process::Command::new("icacls")
            .arg(&path)
            .args(["/grant", "*S-1-1-0:(R)"])
            .output()
            .expect("icacls runs on Windows");
        assert!(
            granted.status.success(),
            "could not widen the fixture: {}",
            String::from_utf8_lossy(&granted.stderr)
        );
        assert!(
            !vela_privatefs::describe(&path).unwrap().is_private(),
            "the fixture was not actually widened, so this test proves nothing"
        );

        // What `DatabaseLocation::prepare` does to the application-data root,
        // in the order it does it.
        vela_privatefs::create_private_dir(dir.path()).expect("the root hardens");
        let repaired = vela_privatefs::repair_entries(dir.path()).expect("the walk succeeds");

        assert!(
            repaired.iter().any(|entry| entry == &path),
            "the configuration file was not among the entries the walk repaired: {repaired:?}"
        );
        assert!(
            vela_privatefs::describe(&path).unwrap().is_private(),
            "the configuration file is still reachable by another principal: {}",
            vela_privatefs::describe(&path).unwrap().reach_summary()
        );
    }

    #[test]
    fn the_response_serialises_in_the_shape_the_typescript_contract_declares() {
        let config = r#"{ "mcpServers": { "broken": { "command": "vela-no-such-binary" } } }"#;
        let (_dir, host) = host_with(config);

        let value = serde_json::to_value(list_tools(&host)).unwrap();
        assert!(value.get("configFailure").is_some());
        let server = &value["servers"][0];
        assert_eq!(server["serverId"], "broken");
        assert_eq!(server["status"]["kind"], "unavailable");
        assert_eq!(server["status"]["reason"], "spawnFailed");
    }
}
