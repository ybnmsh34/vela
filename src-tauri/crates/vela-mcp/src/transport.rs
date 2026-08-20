//! The one thing `client` and `pool` are allowed to know about how a server is
//! reached.
//!
//! An enum rather than a trait object, and the reason is that the set is closed:
//! MCP defines two transports, this crate implements both, and a third would be
//! a specification change rather than a plug-in. What an enum buys over `dyn` is
//! that adding a third arm **will not compile** until every method here has a
//! case for it — which is the property that keeps two transports behaving the
//! same, and the property the shipped-behaviour defect in this area would have
//! needed.

use serde_json::Value;

use crate::config::ServerSpec;
use crate::error::McpResult;
use crate::http::{HttpTransport, RemoteDeps};
use crate::stdio::{NotificationSink, StdioTransport};

/// One reachable server, however it is reached.
pub enum Transport {
    Stdio(StdioTransport),
    Http(HttpTransport),
}

impl Transport {
    /// Open a transport for whatever the configuration resolved to.
    ///
    /// `remote` is `None` in a build with no HTTP backend wired. A `url` entry
    /// then reports [`crate::McpError::TransportNotSupported`] — the same arm,
    /// with the same argument, that every `url` entry used to get: the user's
    /// file is correct and this build cannot do it. What changed is that the
    /// arm is now reachable only when it is true.
    pub fn open(
        server_id: &str,
        spec: &ServerSpec,
        remote: Option<&RemoteDeps>,
        on_notification: NotificationSink,
    ) -> McpResult<Self> {
        match spec {
            ServerSpec::Stdio(server) => Ok(Transport::Stdio(StdioTransport::spawn(
                server,
                on_notification,
            )?)),
            ServerSpec::Http(server) => match remote {
                Some(deps) => Ok(Transport::Http(HttpTransport::connect(
                    server_id,
                    server,
                    deps,
                    on_notification,
                ))),
                None => Err(crate::error::McpError::TransportNotSupported {
                    server: server_id.to_owned(),
                    detail: "this build has no HTTP backend wired into the MCP host".to_owned(),
                }),
            },
        }
    }

    pub fn request(&self, method: &str, params: Value) -> McpResult<Value> {
        match self {
            Transport::Stdio(transport) => transport.request(method, params),
            Transport::Http(transport) => transport.request(method, params),
        }
    }

    pub fn notify(&self, method: &str, params: Value) -> McpResult<()> {
        match self {
            Transport::Stdio(transport) => transport.notify(method, params),
            Transport::Http(transport) => transport.notify(method, params),
        }
    }

    pub fn is_alive(&self) -> bool {
        match self {
            Transport::Stdio(transport) => transport.is_alive(),
            Transport::Http(transport) => transport.is_alive(),
        }
    }

    /// The last few lines worth knowing about this server. **Never evidence of
    /// failure** — for stdio it is the server's own stderr, which the spec says
    /// a client SHOULD NOT read as an error, and for HTTP it is status lines.
    ///
    /// Named for what it is rather than `recent_stderr`, because a remote server
    /// has no stderr and a name that lies about the substrate is the kind of
    /// difference between two transports that becomes a defect later.
    pub fn recent_diagnostics(&self) -> Vec<String> {
        match self {
            Transport::Stdio(transport) => transport.recent_stderr(),
            Transport::Http(transport) => transport.recent_diagnostics(),
        }
    }

    pub fn shutdown(&self) {
        match self {
            Transport::Stdio(transport) => transport.shutdown(),
            Transport::Http(transport) => transport.shutdown(),
        }
    }
}
