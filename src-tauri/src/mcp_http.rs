//! The composition root's answer to "how does `vela-mcp` reach the network".
//!
//! # The seam, and why the join is here
//!
//! `vela-mcp` implements MCP's HTTP transport against
//! [`vela_mcp::HttpExchange`], one synchronous round-trip, and declares no HTTP
//! client of its own — because `vela-settings/tests/capability_matrix_endpoints.rs`
//! asserts against the tree that exactly one crate may, and that it is
//! `vela-providers`. `vela-providers` in turn knows nothing about MCP.
//!
//! So the two halves meet in the one crate that is allowed to know about both,
//! which is this one. `endpoint_host.rs` is the same shape for the same reason:
//! it is the only place outside `vela-endpoint` itself that calls
//! `vela_endpoint::server::serve`, and a join between two domain crates is
//! composition, not domain logic.
//!
//! That is a grep and not a quotation — `endpoint_host.rs` does not describe
//! itself in those words, the claim is this file's, and here is what backs it,
//! stated so it can be redone. Searching `src/` and `crates/*/src/` for
//! `vela_endpoint::server` returns four lines and only four: the `use` in
//! `endpoint_host.rs`, one line of that file's own module docs, and two of this
//! paragraph. The call that `use` feeds is the one `serve(` in `endpoint_host.rs`.
//! `vela-endpoint` also calls `serve` inside its own `mod tests`, which is why
//! the claim is scoped to outside that crate rather than to the workspace; and
//! the application crate is the only crate whose manifest depends on
//! `vela-endpoint` at all, so there is nowhere else the call could come from.
//!
//! # What an MCP server therefore inherits
//!
//! Everything `vela_providers::blocking` builds its client with, which is the
//! posture the provider path was hardened into and which nothing here re-argues:
//! no ambient proxy, no cross-authority redirect, no `Referer`. A compromised
//! MCP server answering `302` does **not** get Vela to carry its
//! `Authorization` header to another host.
//!
//! # What is deliberately not translated
//!
//! Nothing about a response is interpreted here — not the status, not the media
//! type, not the body. This is a wire, and the judgement lives in
//! `vela_mcp::http`, which is where the rules about what a body may reach are
//! written and tested. A translation layer that started making decisions would
//! be a second place those rules live.

use std::time::Duration;

use vela_mcp::exchange::{ExchangeError, HttpCall, HttpExchange, HttpReply, MAX_RESPONSE_BYTES};
use vela_providers::blocking::{BlockingError, BlockingHttp, BlockingRequest};

/// [`HttpExchange`] over the workspace's one HTTP client.
pub struct ProviderBackedExchange {
    http: BlockingHttp,
}

impl ProviderBackedExchange {
    /// Start the client and its runtime.
    ///
    /// The failure is returned rather than swallowed: the caller turns "there is
    /// no HTTP backend" into a pool that reports `transportNotSupported` for
    /// every `url` entry, which is the truth about that process and is a state
    /// the settings surface already renders. A backend that failed to start and
    /// pretended otherwise would produce a different, worse sentence — a server
    /// that is unreachable for a reason nobody can name.
    pub fn start() -> Result<Self, BlockingError> {
        Ok(Self {
            http: BlockingHttp::start()?,
        })
    }
}

impl HttpExchange for ProviderBackedExchange {
    fn send(&self, call: HttpCall, timeout: Duration) -> Result<HttpReply, ExchangeError> {
        let response = self
            .http
            .send(BlockingRequest {
                method: call.method.as_str().to_owned(),
                url: call.url,
                headers: call.headers,
                body: call.body,
                timeout,
                // The seam's own ceiling, not this crate's opinion of one.
                max_response_bytes: MAX_RESPONSE_BYTES,
            })
            .map_err(|error| match error {
                BlockingError::TimedOut => ExchangeError::TimedOut,
                BlockingError::TooLarge => ExchangeError::TooLarge,
                BlockingError::Unreachable(detail) => ExchangeError::Unreachable(detail),
            })?;

        Ok(HttpReply {
            status: response.status,
            headers: response.headers,
            body: response.body,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// The translation is total in both directions, driven over a real socket.
    ///
    /// Not a fake `BlockingHttp`: the thing worth checking is that a `HttpCall`
    /// built by `vela-mcp` arrives at a server as the request it describes, and
    /// that is a claim about two crates agreeing, which a fake in the middle
    /// would decide by construction.
    #[test]
    fn a_call_built_by_vela_mcp_reaches_a_server_and_its_answer_comes_back() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut seen = vec![0u8; 2048];
            let read = stream.read(&mut seen).unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\
                      mcp-session-id: s-1\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}",
                )
                .unwrap();
            stream.flush().unwrap();
            String::from_utf8_lossy(&seen[..read]).into_owned()
        });

        let exchange = ProviderBackedExchange::start().expect("the client starts");
        let reply = exchange
            .send(
                HttpCall::post(format!("http://127.0.0.1:{port}/mcp"))
                    .with_header("x-tenant", "acme")
                    .with_json_body(b"{\"jsonrpc\":\"2.0\"}".to_vec()),
                Duration::from_secs(10),
            )
            .expect("a live loopback server answers");

        assert_eq!(reply.status, 200);
        assert_eq!(reply.media_type(), "application/json");
        assert_eq!(reply.header("mcp-session-id"), Some("s-1"));
        assert_eq!(reply.body, b"{}");

        let request = server.join().unwrap();
        assert!(request.starts_with("POST /mcp"), "{request}");
        assert!(
            request.to_lowercase().contains("x-tenant: acme"),
            "{request}"
        );
        assert!(request.contains("\"jsonrpc\":\"2.0\""), "{request}");
    }

    #[test]
    fn an_endpoint_nothing_is_listening_on_is_unreachable_and_not_a_panic() {
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let exchange = ProviderBackedExchange::start().unwrap();
        let outcome = exchange.send(
            HttpCall::get(format!("http://127.0.0.1:{port}/mcp")),
            Duration::from_secs(10),
        );
        assert!(
            matches!(outcome, Err(ExchangeError::Unreachable(_))),
            "got {outcome:?}"
        );
    }
}
