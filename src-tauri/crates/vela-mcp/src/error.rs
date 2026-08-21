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
    /// An endpoint this server's entry names could not be reached: no DNS, no
    /// route, no TLS, or the connection dropped before an answer arrived. Its
    /// own arm rather than a flavour of [`McpFailureCode::SpawnFailed`] because
    /// the user acts on it differently — a URL or a network, not a missing
    /// program.
    ///
    /// **Which** endpoint is in [`McpError::Unreachable`]'s `endpoint` field and
    /// not in this code, because an entry names two of them: `url`, and the
    /// `auth.tokenEndpoint` of an OAuth entry. This code alone does not say
    /// which one went quiet, and a settings surface that wants to say so must
    /// read the error, not the code.
    EndpointUnreachable,
    /// A remote server needs a credential this build does not have, or refused
    /// the one it has. The only arm whose remedy is "sign in", which is why it
    /// is not folded into [`McpFailureCode::HandshakeFailed`].
    AuthorizationRequired,
    /// The process started and then refused, or bungled, the handshake.
    HandshakeFailed,
    /// The process is gone. In-flight requests fail with this rather than hang.
    ServerExited,
    /// The server answered, and what it said was not a legal MCP message.
    ProtocolError,
    /// The server is alive and did not answer in time.
    ///
    /// **Which** peer held the line open is in [`McpError::TimedOut`]'s `peer`
    /// field and not in this code, for the reason
    /// [`McpFailureCode::EndpointUnreachable`] gives above: an entry can name
    /// two hosts and this code says nothing about which of them went quiet.
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

    /// The remote half of [`McpError::SpawnFailed`]: nothing came back at all.
    ///
    /// `endpoint` is the host the round-trip was actually addressed to, which
    /// for an OAuth entry may be its `auth.tokenEndpoint` rather than its `url`.
    /// `HttpTransport::exchange` is where that is taken from the call, and
    /// `an_unreachable_token_endpoint_names_itself_and_not_the_mcp_server`, in
    /// this crate's `tests/http_end_to_end.rs`, is what keeps it from drifting
    /// back to naming the wrong one.
    #[error("could not reach `{endpoint}`: {detail}")]
    Unreachable { endpoint: String, detail: String },

    /// The server is reachable and answered with a status this transport cannot
    /// use. `detail` carries the media type and **never the body** — a body is
    /// unbounded text written by the far end.
    #[error("`{endpoint}` answered {status} ({detail})")]
    HttpStatus {
        endpoint: String,
        status: u16,
        detail: String,
    },

    /// No usable credential for a remote server: none stored, none obtainable,
    /// or one the server refused.
    #[error("`{server}` needs authorization: {detail}")]
    AuthorizationRequired { server: String, detail: String },

    #[error("the handshake with the server failed: {0}")]
    HandshakeFailed(String),

    /// The child is gone: it exited, was killed, or closed its stdout. Every
    /// request still waiting when that is discovered fails with this.
    #[error("the MCP server process is no longer running")]
    ServerExited,

    #[error("the server sent something that is not a legal MCP message: {0}")]
    Protocol(String),

    /// Something on the other end held the connection or the pipe open and did
    /// not answer inside the deadline.
    ///
    /// `peer` names **what** did not answer, on the same rule as
    /// [`McpError::Unreachable`]'s `endpoint` and for exactly the same reason:
    /// an OAuth entry names two hosts on two different lines, and a failure
    /// attributed to the wrong one sends a user to go and fix a server that is
    /// answering. For the HTTP transport it is the `call.url` of the round trip
    /// that timed out, taken in `HttpTransport::exchange`; for the stdio
    /// transport there is no host at all and it is the configured `command`,
    /// which [`McpError::SpawnFailed`]'s own message already prints, so neither
    /// substrate discloses anything here it does not disclose elsewhere.
    ///
    /// This field is the second half of a rule the first half already obeyed.
    /// `exchange`'s doc claimed both arms named the host they called while only
    /// [`McpError::Unreachable`] carried one, so a token endpoint that hung —
    /// rather than refusing — still reported "the server did not answer" about
    /// a healthy MCP server that had received nothing.
    /// `a_token_endpoint_that_times_out_names_itself_and_not_the_mcp_server`,
    /// beside `an_unreachable_token_endpoint_names_itself_and_not_the_mcp_server`
    /// in this crate's `tests/http_end_to_end.rs`, is what holds the two arms
    /// together now.
    #[error("`{peer}` did not answer within {after:?}")]
    TimedOut { peer: String, after: Duration },

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
            McpError::Unreachable { .. } => McpFailureCode::EndpointUnreachable,
            // A status this transport cannot use is the server answering badly,
            // which is what `ServerError` already means for a JSON-RPC error.
            // Two error arms, one code: the renderer acts on both identically
            // and the distinction lives in the log, which is where the detail
            // that justifies it also lives.
            McpError::HttpStatus { .. } => McpFailureCode::ServerError,
            McpError::AuthorizationRequired { .. } => McpFailureCode::AuthorizationRequired,
            McpError::HandshakeFailed(_) => McpFailureCode::HandshakeFailed,
            McpError::ServerExited => McpFailureCode::ServerExited,
            McpError::Protocol(_) => McpFailureCode::ProtocolError,
            McpError::TimedOut { .. } => McpFailureCode::TimedOut,
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
            McpError::TimedOut {
                peer: "https://mcp.example.com/mcp".into(),
                after: Duration::from_secs(1),
            }
            .code(),
            McpFailureCode::TimedOut
        );
    }

    #[test]
    fn a_timeout_names_the_peer_that_did_not_answer() {
        // The arm that used to say "the server", singular and unnamed, while
        // its sibling `Unreachable` named the host it had actually called. An
        // OAuth entry names two hosts; a message that names neither is the same
        // misattribution as a message that names the wrong one, minus the
        // evidence that it is wrong.
        let rendered = McpError::TimedOut {
            peer: "https://auth.example.com/token".into(),
            after: Duration::from_secs(30),
        }
        .to_string();
        assert!(
            rendered.contains("https://auth.example.com/token"),
            "{rendered}"
        );
    }

    #[test]
    fn failure_codes_serialise_as_camel_case_strings() {
        let json = serde_json::to_string(&McpFailureCode::TransportNotSupported).unwrap();
        assert_eq!(json, "\"transportNotSupported\"");
    }

    #[test]
    fn an_unreachable_endpoint_and_a_refused_credential_are_different_codes() {
        // The two things a user of a remote server does differently: fix the
        // URL or the network, versus sign in.
        assert_eq!(
            McpError::Unreachable {
                endpoint: "https://mcp.example.com/mcp".into(),
                detail: "dns error".into(),
            }
            .code(),
            McpFailureCode::EndpointUnreachable
        );
        assert_eq!(
            McpError::AuthorizationRequired {
                server: "team".into(),
                detail: "no credential is stored".into(),
            }
            .code(),
            McpFailureCode::AuthorizationRequired
        );
    }

    #[test]
    fn a_status_this_transport_cannot_use_never_quotes_the_body() {
        // The body is unbounded text written by the far end. `detail` carries
        // the media type, which is metadata, and that is the whole of it.
        let error = McpError::HttpStatus {
            endpoint: "https://mcp.example.com/mcp".into(),
            status: 500,
            detail: "text/html".into(),
        };
        assert_eq!(error.code(), McpFailureCode::ServerError);
        let rendered = error.to_string();
        assert!(rendered.contains("500"), "{rendered}");
        assert!(rendered.contains("text/html"), "{rendered}");
    }

    #[test]
    fn the_new_codes_serialise_in_the_shape_the_typescript_union_declares() {
        assert_eq!(
            serde_json::to_string(&McpFailureCode::EndpointUnreachable).unwrap(),
            "\"endpointUnreachable\""
        );
        assert_eq!(
            serde_json::to_string(&McpFailureCode::AuthorizationRequired).unwrap(),
            "\"authorizationRequired\""
        );
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
