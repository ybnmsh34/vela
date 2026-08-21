//! One connected server: the handshake, the tool list, and the cache that
//! stops the tool list being refetched on every keystroke.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::ServerSpec;
use crate::error::{McpError, McpResult};
use crate::http::RemoteDeps;
use crate::protocol::{self, ttl_ms_of};
use crate::transport::Transport;

/// How long a tool list is trusted when the server sends no freshness hint.
///
/// **This is a departure from the specification, and it is deliberate.** The
/// caching rules say an absent `ttlMs` must be treated as zero — immediately
/// stale — which is right for a modern server that is required to send one. The
/// servers that exist today are legacy servers and send none, so obeying that
/// rule literally means walking the pipe again for every access, and the tool
/// list is read once per model turn. Sixty seconds is what a legacy server buys
/// instead. It costs nothing in correctness for the case the whole cache exists
/// to serve, because a server that changes its tool set is *required* to say so,
/// and that notification invalidates this cache immediately regardless of age.
pub const LEGACY_TOOL_LIST_TTL: Duration = Duration::from_secs(60);

/// One tool as the server describes it.
///
/// `input_schema` is carried as a raw JSON value rather than a parsed schema:
/// this client does not validate arguments — the server does, and it is the only
/// party that can — and a parsed representation would have to be lowered back to
/// JSON before it could be sent anywhere.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub name: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub input_schema: Value,
}

/// The name a tool is offered to a model under.
///
/// Tool names are unique **within one server and nowhere else**, so two servers
/// exposing `search` collide the moment their tools are put in one catalogue.
/// The prefix is what stops that, and the sanitisation is what keeps the result
/// legal for backends that restrict the character set. Both halves match what
/// other MCP clients do, which matters: a user who has seen a namespaced tool
/// name elsewhere should recognise this one.
pub fn namespaced_tool_name(server_id: &str, tool: &str) -> String {
    fn sanitise(part: &str) -> String {
        part.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect()
    }
    format!("mcp__{}__{}", sanitise(server_id), sanitise(tool))
}

struct ToolCache {
    entry: Mutex<Option<CachedTools>>,
    /// Bumped by every invalidating notification. A fetch that started before a
    /// bump and finished after it must not install its result — the list it is
    /// holding is already known to be out of date.
    epoch: AtomicU64,
}

struct CachedTools {
    tools: Vec<McpTool>,
    fetched_at: Instant,
    ttl: Duration,
    epoch: u64,
}

/// A live connection to one MCP server.
///
/// ## The handshake, and what this build does not do
///
/// It opens with `initialize` and follows with `notifications/initialized` —
/// the handshake of revisions `2025-06-18` and `2025-11-25`, which is what
/// deployed servers speak. Revision `2026-07-28` replaced it with a
/// `server/discover` probe, and a complete client tries the modern probe first
/// and falls back on any error or timeout. **This one does not probe.** A
/// modern-only server that rejects `initialize` is therefore reported as
/// [`McpError::HandshakeFailed`] rather than being spoken to correctly. That is
/// a real gap, it is the next thing to build, and it is written here rather than
/// in a commit message because the alternative is a reader assuming era
/// negotiation happens.
pub struct McpConnection {
    server_id: String,
    transport: Transport,
    tools: Arc<ToolCache>,
}

impl McpConnection {
    /// Spawn a server and complete the handshake.
    ///
    /// The two are one operation on purpose: a process that is running but has
    /// not been initialised is a state no caller has a use for, and making it
    /// reachable would mean every later method had to check for it.
    pub fn connect(
        server_id: &str,
        spec: &ServerSpec,
        remote: Option<&RemoteDeps>,
    ) -> McpResult<Self> {
        let tools = Arc::new(ToolCache {
            entry: Mutex::new(None),
            epoch: AtomicU64::new(0),
        });

        // The sink runs on the transport's reader thread. It takes no lock that
        // a request could be holding — bumping a counter is the whole of it —
        // because a sink that blocked would block the thread that delivers the
        // response the blocked caller is waiting for.
        let sink_tools = Arc::clone(&tools);
        let transport = Transport::open(
            server_id,
            spec,
            remote,
            Arc::new(move |method: &str, _params: &Value| {
                if method == protocol::NOTIFY_TOOLS_LIST_CHANGED {
                    sink_tools.epoch.fetch_add(1, Ordering::SeqCst);
                }
            }),
        )?;

        let connection = Self {
            server_id: server_id.to_owned(),
            transport,
            tools,
        };
        connection.handshake()?;
        Ok(connection)
    }

    pub fn server_id(&self) -> &str {
        &self.server_id
    }

    pub fn is_alive(&self) -> bool {
        self.transport.is_alive()
    }

    /// The last few lines worth knowing about this server. Diagnostics only,
    /// never evidence of failure. See [`Transport::recent_diagnostics`] for why
    /// it is not called `recent_stderr` any more.
    pub fn recent_diagnostics(&self) -> Vec<String> {
        self.transport.recent_diagnostics()
    }

    fn handshake(&self) -> McpResult<()> {
        let params = json!({
            "protocolVersion": protocol::PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "vela", "version": env!("CARGO_PKG_VERSION") },
        });
        let result = self
            .transport
            .request(protocol::METHOD_INITIALIZE, params)
            .map_err(|error| match error {
                // A server that is simply gone is gone; only an answer that was
                // wrong is a handshake failure. Each arm below is here for the
                // reason `ServerExited` already was: an endpoint that was never
                // reached did not bungle a handshake, and a user told "handshake
                // failed" when the answer is "sign in" goes looking in the wrong
                // place.
                //
                // TWO of these three additions are remote-only — `Unreachable`
                // and `AuthorizationRequired` have no stdio producer. `TimedOut`
                // is NOT: `StdioTransport::request` raises it when a child does
                // not answer within `DEFAULT_REQUEST_TIMEOUT`. So this arm
                // changed the stdio path too — a local server whose `initialize`
                // is slow now reports `timedOut` where it reported
                // `handshakeFailed`. That is the better answer for both
                // substrates (the server is alive and did not bungle anything),
                // it is a valid renderer arm already, and it is written here
                // rather than left for a reader to discover from the enum.
                McpError::ServerExited => McpError::ServerExited,
                unreachable @ McpError::Unreachable { .. } => unreachable,
                unauthorized @ McpError::AuthorizationRequired { .. } => unauthorized,
                timed_out @ McpError::TimedOut { .. } => timed_out,
                other => McpError::HandshakeFailed(other.to_string()),
            })?;

        if !result.is_object() {
            return Err(McpError::HandshakeFailed(
                "initialize did not answer with an object".to_owned(),
            ));
        }

        // A notification, so there is nothing to wait for. Servers that require
        // it refuse everything until it arrives; servers that do not, ignore it.
        self.transport
            .notify(protocol::NOTIFY_INITIALIZED, json!({}))?;
        Ok(())
    }

    /// The server's tools, from cache when the cache is still good.
    ///
    /// ## The lock is not held across the request, and that is load-bearing
    ///
    /// The response to `tools/list` is delivered by the transport's reader
    /// thread, and that same thread runs the notification sink. Holding the
    /// cache lock while waiting for the response would let a
    /// `notifications/tools/list_changed` arriving first block the reader on a
    /// lock held by the caller waiting for the reader. The cost is that two
    /// concurrent callers can both fetch; the benefit is that one caller cannot
    /// deadlock the connection.
    pub fn list_tools(&self) -> McpResult<Vec<McpTool>> {
        let epoch_before = self.tools.epoch.load(Ordering::SeqCst);
        if let Some(fresh) = self.cached(epoch_before) {
            return Ok(fresh);
        }

        let result = self
            .transport
            .request(protocol::METHOD_TOOLS_LIST, json!({}))?;
        let tools = parse_tool_list(&result)?;
        let ttl = ttl_ms_of(&result).map_or(LEGACY_TOOL_LIST_TTL, Duration::from_millis);

        // Only install the result if nothing invalidated it while it was in
        // flight. Otherwise it is returned to this caller — it is a real answer,
        // just a superseded one — and the next access refetches.
        if self.tools.epoch.load(Ordering::SeqCst) == epoch_before {
            *self.tools.entry.lock().expect("mcp tool cache") = Some(CachedTools {
                tools: tools.clone(),
                fetched_at: Instant::now(),
                ttl,
                epoch: epoch_before,
            });
        }
        Ok(tools)
    }

    /// Call one tool. `name` is the server's own name for it, not the
    /// namespaced one — the namespace belongs to the catalogue, not the wire.
    pub fn call_tool(&self, name: &str, arguments: Value) -> McpResult<Value> {
        self.transport.request(
            protocol::METHOD_TOOLS_CALL,
            json!({ "name": name, "arguments": arguments }),
        )
    }

    fn cached(&self, epoch_now: u64) -> Option<Vec<McpTool>> {
        let entry = self.tools.entry.lock().expect("mcp tool cache");
        let cached = entry.as_ref()?;
        if cached.epoch != epoch_now {
            return None;
        }
        if cached.fetched_at.elapsed() >= cached.ttl {
            return None;
        }
        Some(cached.tools.clone())
    }
}

/// `tools` is required and must be an array. A server answering with anything
/// else has not answered, and treating the absence as an empty list would show
/// the user a working server with no tools.
fn parse_tool_list(result: &Value) -> McpResult<Vec<McpTool>> {
    let raw = result
        .get("tools")
        .and_then(Value::as_array)
        .ok_or_else(|| McpError::Protocol("tools/list has no tools array".to_owned()))?;

    let mut tools = Vec::with_capacity(raw.len());
    for entry in raw {
        // One unreadable tool does not discard the rest — the same rule the
        // spec states for a tool whose schema violates a constraint.
        if let Ok(tool) = serde_json::from_value::<McpTool>(entry.clone()) {
            tools.push(tool);
        }
    }
    Ok(tools)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespacing_separates_two_servers_that_expose_the_same_tool() {
        assert_eq!(
            namespaced_tool_name("files", "search"),
            "mcp__files__search"
        );
        assert_ne!(
            namespaced_tool_name("files", "search"),
            namespaced_tool_name("web", "search")
        );
    }

    #[test]
    fn namespacing_replaces_characters_a_backend_may_refuse() {
        assert_eq!(
            namespaced_tool_name("my server.v2", "read/file"),
            "mcp__my_server_v2__read_file"
        );
    }

    #[test]
    fn a_tool_list_answer_without_a_tools_array_is_a_protocol_error() {
        assert!(matches!(
            parse_tool_list(&json!({ "result": "ok" })),
            Err(McpError::Protocol(_))
        ));
    }

    #[test]
    fn one_unreadable_tool_does_not_discard_the_rest() {
        let result = json!({ "tools": [
            { "name": "good", "inputSchema": { "type": "object" } },
            { "description": "no name, so not a tool" },
            { "name": "also-good" }
        ]});
        let tools = parse_tool_list(&result).unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["good", "also-good"]);
    }
}
