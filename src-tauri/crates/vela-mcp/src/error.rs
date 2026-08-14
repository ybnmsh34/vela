//! What can go wrong, and the closed vocabulary the renderer is allowed to see.
//!
//! Two types, deliberately. [`McpError`] carries detail — the command that could
//! not be spawned, the OS error, the JSON-RPC message — and belongs in a log the
//! user opted into. [`McpFailureCode`] is the closed set that crosses the IPC
//! boundary, for the reason `ChatError` in `src/platform/contract.ts` gives for
//! its own: a free-text field on a wire type is a string of unbounded length,
//! written by somebody else's process, that ends up rendered in a user's window.

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Why an MCP server is not serving tools right now.
///
/// Every arm is something a settings surface can word for itself. Adding an arm
/// is a contract change; adding a `detail: String` is not permitted at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpFailureCode {
    /// No entry with that id in the configuration file.
    NotConfigured,
    /// The configuration file itself could not be read or parsed.
    ConfigUnreadable,
    /// The entry exists but does not describe a launchable server.
    ConfigInvalid,
    /// The entry names a transport this build does not implement.
    TransportNotSupported,
    /// The child process could not be started at all.
    SpawnFailed,
    /// The process started and then refused, or bungled, the handshake.
    HandshakeFailed,
    /// The process is gone. In-flight requests fail with this rather than hang.
    ServerExited,
    /// The server answered, and what it said was not a legal MCP message.
    ProtocolError,
    /// The server is alive and did not answer in time.
    TimedOut,
    /// The server answered the request with a JSON-RPC error.
    ServerError,
}

#[derive(Debug, thiserror::Error)]
pub enum McpError {
    #[error("no MCP server named `{0}` is configured")]
    NotConfigured(String),

    #[error("the MCP configuration at `{path}` could not be read: {detail}")]
    ConfigUnreadable { path: String, detail: String },

    #[error("the configuration for `{server}` is not usable: {detail}")]
    ConfigInvalid { server: String, detail: String },

    /// Raised for an entry that names a transport this build does not have —
    /// today, every `url` entry. It is its own arm rather than a flavour of
    /// [`McpError::ConfigInvalid`] because the configuration is *correct*: it is
    /// this client that is incomplete, and a user told "invalid" would go and
    /// edit a file that has nothing wrong with it.
    #[error("`{server}` uses a transport this build does not implement: {detail}")]
    TransportNotSupported { server: String, detail: String },

    #[error("could not spawn `{command}`: {detail}")]
    SpawnFailed { command: String, detail: String },

    #[error("the handshake with the server failed: {0}")]
    HandshakeFailed(String),

    /// The child is gone: it exited, was killed, or closed its stdout. Every
    /// request still waiting when that is discovered fails with this.
    #[error("the MCP server process is no longer running")]
    ServerExited,

    #[error("the server sent something that is not a legal MCP message: {0}")]
    Protocol(String),

    #[error("the server did not answer within {0:?}")]
    TimedOut(Duration),

    #[error("the server answered with error {code}: {message}")]
    Rpc { code: i64, message: String },
}

impl McpError {
    /// The renderer-facing projection. Total by construction: a new arm above
    /// will not compile until it is given a code here.
    pub fn code(&self) -> McpFailureCode {
        match self {
            McpError::NotConfigured(_) => McpFailureCode::NotConfigured,
            McpError::ConfigUnreadable { .. } => McpFailureCode::ConfigUnreadable,
            McpError::ConfigInvalid { .. } => McpFailureCode::ConfigInvalid,
            McpError::TransportNotSupported { .. } => McpFailureCode::TransportNotSupported,
            McpError::SpawnFailed { .. } => McpFailureCode::SpawnFailed,
            McpError::HandshakeFailed(_) => McpFailureCode::HandshakeFailed,
            McpError::ServerExited => McpFailureCode::ServerExited,
            McpError::Protocol(_) => McpFailureCode::ProtocolError,
            McpError::TimedOut(_) => McpFailureCode::TimedOut,
            McpError::Rpc { .. } => McpFailureCode::ServerError,
        }
    }
}

pub type McpResult<T> = Result<T, McpError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dead_server_and_a_slow_server_are_different_codes() {
        // The distinction the whole "surviving a server that dies" story rests
        // on: a caller must be able to tell "gone, restart it" from "busy, wait".
        assert_eq!(McpError::ServerExited.code(), McpFailureCode::ServerExited);
        assert_eq!(
            McpError::TimedOut(Duration::from_secs(1)).code(),
            McpFailureCode::TimedOut
        );
    }

    #[test]
    fn failure_codes_serialise_as_camel_case_strings() {
        let json = serde_json::to_string(&McpFailureCode::TransportNotSupported).unwrap();
        assert_eq!(json, "\"transportNotSupported\"");
    }

    #[test]
    fn an_unimplemented_transport_is_not_reported_as_a_broken_config() {
        let error = McpError::TransportNotSupported {
            server: "remote".to_owned(),
            detail: "url entries need the HTTP transport".to_owned(),
        };
        assert_eq!(error.code(), McpFailureCode::TransportNotSupported);
    }
}
