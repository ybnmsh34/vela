//! The connection pool: one process per configured server, reused, and replaced
//! when it dies.
//!
//! ## What pooling actually buys here
//!
//! Not throughput — a desktop app talks to a handful of servers. It buys two
//! things that are correctness rather than speed. First, **one process per
//! server**: spawning a fresh `node` for every tool call would cost a hundred
//! milliseconds of startup per call and would lose whatever state the server
//! keeps between them. Second, **a place for the tool cache to live**: a cache
//! attached to a connection that is discarded after every call is not a cache.
//!
//! ## Restart is the pool's job, and it is why this is not a plain map
//!
//! The stdio spec says a client SHOULD restart a server that terminates
//! unexpectedly, and that in-flight requests are simply lost. That decision
//! cannot sit inside a connection — the connection is the thing that is dead —
//! so it sits here: [`McpPool::connect`] hands back a live connection or makes a
//! new one, and a caller that got an error last time does not have to know
//! whether it needs to reconnect. It is tested by killing a server through its
//! own `die` tool and asking the pool for it again.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use crate::client::{McpConnection, McpTool};
use crate::config::McpConfig;
use crate::error::McpResult;
use crate::http::RemoteDeps;

/// Every configured server's tools, or the reason there are none.
pub struct ServerTools {
    pub server_id: String,
    pub outcome: McpResult<Vec<McpTool>>,
}

/// Live connections, keyed by server id.
///
/// The configuration is read once, when the pool is built, and there is no way
/// to replace it: a user who edits their file gets the change on the next
/// launch. Nothing watches the file and nothing reloads it, because a reload
/// that respawned servers under a running agent loop is a bigger decision than
/// this slice makes — and an unused `reload` method would be a claim that it had
/// been made.
pub struct McpPool {
    config: Mutex<McpConfig>,
    connections: Mutex<BTreeMap<String, Arc<McpConnection>>>,
    /// The network and the credential store, or `None` in a build with no HTTP
    /// backend wired. A `url` entry then reports `TransportNotSupported`, which
    /// is the truth about that build and was the truth about every build before
    /// this one. See [`crate::transport::Transport::open`].
    remote: Option<RemoteDeps>,
}

impl McpPool {
    /// A pool that can launch stdio servers and nothing else.
    pub fn new(config: McpConfig) -> Self {
        Self {
            config: Mutex::new(config),
            connections: Mutex::new(BTreeMap::new()),
            remote: None,
        }
    }

    /// A pool that can also reach remote servers.
    pub fn with_remote(config: McpConfig, remote: RemoteDeps) -> Self {
        Self {
            config: Mutex::new(config),
            connections: Mutex::new(BTreeMap::new()),
            remote: Some(remote),
        }
    }

    pub fn configured_ids(&self) -> Vec<String> {
        self.config
            .lock()
            .expect("mcp config")
            .ids()
            .map(str::to_owned)
            .collect()
    }

    /// A live connection to one server, spawning or respawning as needed.
    ///
    /// **A dead connection is replaced, not returned.** That is the restart rule
    /// above, and it is the reason this returns a fresh `Arc` rather than
    /// whatever is in the map.
    pub fn connect(&self, server_id: &str) -> McpResult<Arc<McpConnection>> {
        {
            let mut connections = self.connections.lock().expect("mcp pool");
            match connections.get(server_id) {
                Some(existing) if existing.is_alive() => return Ok(Arc::clone(existing)),
                Some(_) => {
                    connections.remove(server_id);
                }
                None => {}
            }
        }

        // The spawn is outside the pool lock: it launches a process and waits
        // for a handshake, and holding the map across that would serialise every
        // other server behind one slow one.
        let connection = {
            let config = self.config.lock().expect("mcp config");
            let spec = config.server(server_id)?;
            Arc::new(McpConnection::connect(
                server_id,
                spec,
                self.remote.as_ref(),
            )?)
        };

        let mut connections = self.connections.lock().expect("mcp pool");
        // Another caller may have won the race. Theirs is as good as ours, and
        // keeping both would leave a process nobody holds.
        if let Some(existing) = connections.get(server_id) {
            if existing.is_alive() {
                return Ok(Arc::clone(existing));
            }
        }
        connections.insert(server_id.to_owned(), Arc::clone(&connection));
        Ok(connection)
    }

    /// Tools from every configured server, connecting to each in turn.
    ///
    /// One server failing does not stop the others: the failure is reported in
    /// that server's row. A settings list that showed nothing because one entry
    /// was broken would hide four working servers behind one typo.
    pub fn list_all_tools(&self) -> Vec<ServerTools> {
        self.configured_ids()
            .into_iter()
            .map(|server_id| {
                let outcome = self
                    .connect(&server_id)
                    .and_then(|connection| connection.list_tools());
                ServerTools { server_id, outcome }
            })
            .collect()
    }

    /// Shut every server down. Called when the app closes; a server left running
    /// is a process the user cannot see and did not start twice.
    pub fn shutdown(&self) {
        let connections = std::mem::take(&mut *self.connections.lock().expect("mcp pool"));
        drop(connections);
    }
}

impl Drop for McpPool {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::McpError;

    #[test]
    fn a_pool_with_no_configuration_lists_nothing_and_does_not_fail() {
        let pool = McpPool::new(McpConfig::default());
        assert!(pool.configured_ids().is_empty());
        assert!(pool.list_all_tools().is_empty());
    }

    #[test]
    fn connecting_to_an_unconfigured_server_is_an_error_not_a_spawn() {
        let pool = McpPool::new(McpConfig::default());
        assert!(matches!(
            pool.connect("nothing"),
            Err(McpError::NotConfigured(_))
        ));
    }
}
