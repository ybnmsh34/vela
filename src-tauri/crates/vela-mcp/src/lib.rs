//! # vela-mcp — an MCP client for local servers
//!
//! Vela talks to Model Context Protocol servers so that a user's own tools are
//! available to whatever model they are running. This crate is the client half:
//! it launches servers, speaks JSON-RPC to them, keeps their tool lists, and
//! notices when they die.
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
//! **The HTTP/SSE transport is not built.** A configuration entry naming a
//! `url` parses, is listed, and reports [`McpError::TransportNotSupported`]. It
//! is not silently dropped, and it is not called invalid, because neither of
//! those tells the user the truth: their file is fine and this client is not
//! finished. OAuth and custom headers belong to that transport and are likewise
//! absent.
//!
//! **Era negotiation is not built.** This client opens with `initialize`, the
//! handshake of the revisions deployed servers actually speak. Revision
//! `2026-07-28` replaced it with a `server/discover` probe; the fallback ladder
//! for a client that supports both is described at
//! [`crate::client::McpConnection`] and is the next thing to build.
//!
//! ## Why stdio first
//!
//! Because it is the half that is hard and the half that is missing elsewhere.
//! `docs/references/unsloth-studio.md` §10 records the reference product
//! shipping remote MCP with OAuth and custom headers while local, command-based
//! servers were a filed gap — later closed, behind an environment variable, and
//! still absent from its own documentation. Remote MCP is an HTTP client
//! somebody already wrote. Local MCP is process lifecycle: spawning, framing,
//! isolation, death, restart. That is where a client is right or wrong.
//!
//! ## Layout
//!
//! - [`config`] — the JSON file that says which servers exist.
//! - [`protocol`] — JSON-RPC framing and message classification.
//! - [`stdio`] — the child process, its pipes, and its death.
//! - [`client`] — the handshake, the tool list, and its cache.
//! - [`pool`] — one connection per server, reused and restarted.

pub mod client;
pub mod config;
pub mod error;
pub mod pool;
pub mod protocol;
pub mod stdio;

pub use client::{namespaced_tool_name, McpConnection, McpTool};
pub use config::{McpConfig, StdioServer, INHERITED_ENV};
pub use error::{McpError, McpFailureCode, McpResult};
pub use pool::{McpPool, ServerTools};
