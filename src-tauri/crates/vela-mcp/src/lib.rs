//! # vela-mcp — an MCP client for a user's own servers
//!
//! Vela talks to Model Context Protocol servers so that a user's own tools are
//! available to whatever model they are running. This crate is the client half:
//! it launches or reaches servers, speaks JSON-RPC to them, keeps their tool
//! lists, and notices when they go away.
//!
//! ## What is built, stated plainly
//!
//! **The stdio transport, end to end.** A child process launched from an
//! explicit argv, newline-delimited JSON-RPC over its pipes, the `initialize`
//! handshake, `tools/list`, `tools/call`, a tool cache invalidated by
//! `notifications/tools/list_changed`, and a pool that reuses one process per
//! server and replaces it when it dies. It is exercised against a real server
//! process over a real pipe in `tests/stdio_end_to_end.rs`, not against a fake
//! transport.
//!
//! **The HTTP transport, request/response and SSE.** One POST per client
//! message, answered with a JSON object or a `text/event-stream`; the session
//! the server mints echoed on everything after it; custom headers from the
//! configuration; `Authorization: Bearer` from the OS credential store; an
//! OAuth token set kept current, refreshed under a lock so a rotating refresh
//! token cannot be spent twice, and retried exactly once on a `401`. It is
//! exercised against a real HTTP server on a real loopback socket in
//! `tests/http_end_to_end.rs`.
//!
//! **What the HTTP transport does not do**, because a reader who assumes
//! otherwise will be wrong:
//!
//! * **No standalone `GET` channel.** Server-initiated messages sent outside a
//!   request/response exchange never arrive. See [`crate::http`].
//! * **No interactive authorization.** There is no browser launch, no PKCE and
//!   no authorization-code grant; the first token set is provisioned out of
//!   band into `mcp:<id>/token`. See [`crate::oauth`].
//! * **No client registration**, static or dynamic, and no discovery of an
//!   authorization server: the token endpoint is named in the configuration.
//!
//! **Era negotiation is not built.** This client opens with `initialize`, the
//! handshake of the revisions deployed servers actually speak. Revision
//! `2026-07-28` replaced it with a `server/discover` probe; the fallback ladder
//! for a client that supports both is described at
//! [`crate::client::McpConnection`] and is the next thing to build.
//!
//! ## The two transports are one shape
//!
//! [`crate::transport::Transport`] is a closed enum with an arm each, and every
//! method on it has a case for both. Nothing above it can tell them apart:
//! [`McpConnection`] handshakes, lists and calls identically, and [`McpPool`]
//! replaces a dead connection identically. An MCP client whose remote servers
//! behave differently from its local ones is a maintenance defect even when both
//! work, so the difference is confined to the two files that own a substrate.
//!
//! ## No HTTP client, still
//!
//! This crate declares none. It declares [`crate::exchange::HttpExchange`], one
//! round-trip, and the composition root supplies it — because
//! `vela-settings/tests/capability_matrix_endpoints.rs` asserts against the tree
//! that exactly one crate in this workspace may own an HTTP client, and that is
//! `vela-providers`. The same argument applies to the OS keychain, which is why
//! credentials here move through `vela_secrets::SecretStore` and never through
//! `keyring`.
//!
//! ## Layout
//!
//! - [`config`] — the JSON file that says which servers exist, and the security
//!   rules about what it may not contain.
//! - [`protocol`] — JSON-RPC framing and message classification.
//! - [`stdio`] — the child process, its pipes, and its death.
//! - [`exchange`] — the HTTP seam, and what an implementation owes.
//! - [`oauth`] — the token, where it lives, and how it is renewed.
//! - [`http`] — the endpoint, the session, and what a hostile server can reach.
//! - [`transport`] — the closed set of the two.
//! - [`client`] — the handshake, the tool list, and its cache.
//! - [`pool`] — one connection per server, reused and restarted.

pub mod client;
pub mod config;
pub mod error;
pub mod exchange;
pub mod http;
pub mod oauth;
pub mod pool;
pub mod protocol;
pub mod stdio;
pub mod transport;

pub use client::{namespaced_tool_name, McpConnection, McpTool};
pub use config::{
    credential_ref, HttpServer, McpConfig, OAuthConfig, RemoteAuth, ServerSpec, StdioServer,
    INHERITED_ENV,
};
pub use error::{McpError, McpFailureCode, McpResult};
pub use exchange::{ExchangeError, HttpCall, HttpExchange, HttpMethod, HttpReply};
pub use http::RemoteDeps;
pub use pool::{McpPool, ServerTools};
pub use transport::Transport;
