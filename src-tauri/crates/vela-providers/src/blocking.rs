//! A synchronous HTTP round-trip, for the parts of Vela that are not a model
//! turn.
//!
//! # Why this is in the provider crate
//!
//! Because `vela-settings/tests/capability_matrix_endpoints.rs` says so:
//! **exactly one crate in this workspace may declare an HTTP client, and it is
//! this one.** That gate is what makes "all of Vela's egress leaves from one
//! auditable place" a checkable claim rather than a sentence in a document. A
//! second caller needing HTTP is therefore not a reason to add a second client
//! — it is a reason for a second door on this one.
//!
//! The first such caller is the MCP client: `vela-mcp` implements MCP's HTTP
//! transport against `vela_mcp::exchange::HttpExchange`, a trait, and the
//! composition root implements that trait in terms of this module. `vela-mcp`
//! declares no client of its own and this crate does not depend on it, so the
//! gate stays green and the dependency arrow stays pointed the way the layering
//! wants it.
//!
//! # Why not `HttpTransport`
//!
//! The seam beside this one — [`crate::http::HttpTransport`] — is the right
//! shape for a model turn and the wrong shape for anything else, deliberately.
//! Its response body is an [`crate::http::UpstreamBytes`], **which has no
//! accessor that returns the bytes to a caller**: an upstream body in this crate
//! is prompt-and-answer material that may only be scrubbed, decoded or written
//! to the opt-in debug log. Bolting a `.bytes()` on it so that MCP could read a
//! `tools/list` response would tear down that invariant for every existing
//! caller, to serve one that has nothing to do with it.
//!
//! So this is a separate, narrow door: bytes in, bytes out, no redaction
//! machinery, and the caller owns whatever the far end sent. `vela-mcp` does its
//! own redaction — a body never reaches one of its errors, and a credential
//! header never reaches one of its `Debug`s.
//!
//! # What it shares with the model path, and why that is the point
//!
//! The **client configuration**, which is where this crate's hard-won posture
//! lives:
//!
//! * `no_proxy` — an ambient `HTTPS_PROXY` must not silently route a request
//!   through a third party.
//! * [`crate::http::redirect_policy`] — a redirect off the authority the user
//!   configured is refused outright, rather than followed with the credential
//!   stripped. This is what stops a compromised MCP server moving an
//!   `Authorization` header to a host the user never named with a `302`.
//! * `referer(false)` — `reqwest` keeps the query string in a generated
//!   `Referer`.
//!
//! Reimplementing those three lines beside them is exactly how the second copy
//! drifts, so the client is built by the same function shape and the policy is
//! literally the same function.
//!
//! # The runtime
//!
//! Callers here are synchronous — `mcp_list_tools` is a synchronous Tauri
//! command that ends in a blocking `McpPool::connect` — so the async work runs
//! on a runtime this module owns, on its own thread, and the caller blocks on a
//! channel.
//!
//! It is a *separate* runtime rather than the host's for one reason:
//! `Runtime::block_on` panics when it is called from inside another runtime, and
//! whether a given Tauri command handler is on a runtime worker thread is not a
//! property this module can assert. Submitting to a handle and waiting on a
//! `std::sync::mpsc` channel is correct from any thread, including a runtime
//! worker's, and costs a couple of threads that spend their lives parked.
//!
//! **The runtime starts on the first request, not on construction**, and that is
//! not an optimisation. Most users configure no remote server at all, and for
//! them this object is never used; starting three threads at launch to serve a
//! feature nobody asked for is a cost paid by everybody. It also keeps
//! application startup free of a thread-creation burst — which matters on a
//! machine under load, where `tests/endpoint_runtime_control.rs` polls a fixture
//! on a 10 ms sleep against a network timeout and is measurably sensitive to
//! scheduling pressure at exactly that moment.

use std::sync::mpsc::{sync_channel, RecvTimeoutError};
use std::sync::OnceLock;
use std::time::Duration;

use crate::http::redirect_policy;
use crate::provider::Timeouts;

/// The ceiling on one response body. The caller passes its own; this is the
/// ceiling on the ceiling, so a caller that forgets cannot ask for unbounded.
pub const MAX_BLOCKING_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

/// How much longer than its own deadline this waits on the channel before
/// declaring the worker lost. Not a second timeout on the request — the request
/// already has one — but a guard against a caller blocking forever if the
/// runtime is gone.
const CHANNEL_SLACK: Duration = Duration::from_secs(5);

/// One request. Plain data on purpose: this module knows nothing about what a
/// credential is, and the caller that does keeps that knowledge.
#[derive(Debug, Clone)]
pub struct BlockingRequest {
    /// `GET`, `POST` or `DELETE`. A method this does not recognise is a
    /// [`BlockingError::Unreachable`] rather than a panic, because the string
    /// comes from another crate.
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    pub timeout: Duration,
    /// Reading stops here and the call fails with [`BlockingError::TooLarge`].
    /// Clamped to [`MAX_BLOCKING_RESPONSE_BYTES`].
    pub max_response_bytes: usize,
}

#[derive(Debug, Clone)]
pub struct BlockingResponse {
    pub status: u16,
    /// Lowercased names, verbatim values. **Not scrubbed** — see the module
    /// docs; the caller owns what the far end sent.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// Why nothing came back. A response with a bad status is not one of these.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlockingError {
    /// DNS, TLS, connect, a refused redirect, or a connection that dropped.
    Unreachable(String),
    TimedOut,
    TooLarge,
}

impl std::fmt::Display for BlockingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BlockingError::Unreachable(detail) => f.write_str(detail),
            BlockingError::TimedOut => f.write_str("no response within the deadline"),
            BlockingError::TooLarge => f.write_str("the response exceeded the size limit"),
        }
    }
}

/// A client and the runtime that drives it.
///
/// Build one per process and share it. Building one starts a thread.
pub struct BlockingHttp {
    client: reqwest::Client,
    /// Built on the first [`BlockingHttp::send`]. See the module docs.
    handle: OnceLock<Result<tokio::runtime::Handle, String>>,
}

impl BlockingHttp {
    pub fn start() -> Result<Self, BlockingError> {
        Self::with_connect_timeout(Timeouts::default().connect)
    }

    /// The failure type is this module's own rather than [`ProviderError`],
    /// which every arm of requires a `Diagnosis` about a model endpoint. There
    /// is no endpoint here yet — the client has not been pointed at one — and
    /// inventing a diagnosis to satisfy a type is how an error stops meaning
    /// what it says.
    pub fn with_connect_timeout(connect: Duration) -> Result<Self, BlockingError> {
        // The same three lines as `ReqwestTransport::with_connect_timeout`, and
        // the same `redirect_policy`. See the module docs on why they are not
        // paraphrased.
        let client = reqwest::Client::builder()
            .connect_timeout(connect)
            .no_proxy()
            .redirect(redirect_policy())
            .referer(false)
            .user_agent(concat!("vela/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| BlockingError::Unreachable(error.to_string()))?;

        Ok(Self {
            client,
            handle: OnceLock::new(),
        })
    }

    /// The runtime, started on first use and never again.
    ///
    /// The runtime lives on a thread that parks forever. A `Runtime` dropped
    /// from inside an async context panics, and Tauri decides for itself which
    /// thread drops its managed state; a runtime that is never dropped cannot be
    /// dropped from the wrong place. The threads go away when the process does.
    ///
    /// A failure is cached with the handle. Building a runtime fails when the OS
    /// will not give the process a thread, and retrying that once per request
    /// would turn one refusal into a loop.
    fn runtime(&self) -> Result<&tokio::runtime::Handle, BlockingError> {
        self.handle
            .get_or_init(|| {
                let (ready, started) = sync_channel(1);
                std::thread::Builder::new()
                    .name("vela-blocking-http".to_owned())
                    .spawn(move || {
                        let runtime = match tokio::runtime::Builder::new_multi_thread()
                            .worker_threads(2)
                            .enable_all()
                            .build()
                        {
                            Ok(runtime) => runtime,
                            Err(error) => {
                                let _ = ready.send(Err(error.to_string()));
                                return;
                            }
                        };
                        if ready.send(Ok(runtime.handle().clone())).is_err() {
                            return;
                        }
                        runtime.block_on(std::future::pending::<()>());
                    })
                    .map_err(|error| error.to_string())
                    .and_then(|_| {
                        started
                            .recv()
                            .unwrap_or_else(|_| Err("the HTTP runtime thread did not start".into()))
                    })
            })
            .as_ref()
            .map_err(|detail| BlockingError::Unreachable(detail.clone()))
    }

    /// Send, and block until an answer or the deadline.
    pub fn send(&self, request: BlockingRequest) -> Result<BlockingResponse, BlockingError> {
        let method = match request.method.to_ascii_uppercase().as_str() {
            "GET" => reqwest::Method::GET,
            "POST" => reqwest::Method::POST,
            "DELETE" => reqwest::Method::DELETE,
            other => {
                return Err(BlockingError::Unreachable(format!(
                    "`{other}` is not a method this client sends"
                )))
            }
        };

        let mut builder = self.client.request(method, &request.url);
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        if let Some(body) = request.body {
            builder = builder.body(body);
        }

        let timeout = request.timeout;
        let cap = request.max_response_bytes.min(MAX_BLOCKING_RESPONSE_BYTES);
        let (answer, wait) = sync_channel(1);

        self.runtime()?.spawn(async move {
            let outcome = tokio::time::timeout(timeout, round_trip(builder, cap))
                .await
                .unwrap_or(Err(BlockingError::TimedOut));
            let _ = answer.send(outcome);
        });

        match wait.recv_timeout(timeout + CHANNEL_SLACK) {
            Ok(outcome) => outcome,
            Err(RecvTimeoutError::Timeout) => Err(BlockingError::TimedOut),
            Err(RecvTimeoutError::Disconnected) => Err(BlockingError::Unreachable(
                "the HTTP runtime dropped the request".to_owned(),
            )),
        }
    }
}

async fn round_trip(
    builder: reqwest::RequestBuilder,
    cap: usize,
) -> Result<BlockingResponse, BlockingError> {
    // `reqwest`'s own message is used verbatim. It is built from the URL and the
    // OS error, both of which the *user* supplied or the OS produced — not the
    // far end. `vela-mcp` still never puts one in front of a renderer.
    let mut response = builder
        .send()
        .await
        .map_err(|error| BlockingError::Unreachable(error.to_string()))?;

    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_ascii_lowercase(),
                value.to_str().unwrap_or_default().to_owned(),
            )
        })
        .collect();

    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| BlockingError::Unreachable(error.to_string()))?
    {
        body.extend_from_slice(&chunk);
        if body.len() > cap {
            return Err(BlockingError::TooLarge);
        }
    }

    Ok(BlockingResponse {
        status,
        headers,
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    /// One request, one canned answer, on a real loopback port.
    fn one_shot(reply: &'static str) -> (u16, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut lines = Vec::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap() == 0 {
                    break;
                }
                let trimmed = line.trim_end().to_owned();
                if trimmed.is_empty() {
                    break;
                }
                lines.push(trimmed);
            }
            let length: usize = lines
                .iter()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .and_then(|value| value.trim().parse().ok())
                })
                .unwrap_or(0);
            let mut body = vec![0u8; length];
            if length > 0 {
                reader.read_exact(&mut body).unwrap();
            }
            lines.push(String::from_utf8_lossy(&body).into_owned());
            stream.write_all(reply.as_bytes()).unwrap();
            stream.flush().unwrap();
            lines
        });
        (port, handle)
    }

    #[test]
    fn a_real_round_trip_carries_the_method_the_headers_and_the_body() {
        let (port, server) = one_shot(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 9\r\n\
             connection: close\r\n\r\n{\"ok\":1}\n",
        );
        let http = BlockingHttp::start().unwrap();

        let response = http
            .send(BlockingRequest {
                method: "POST".to_owned(),
                url: format!("http://127.0.0.1:{port}/mcp"),
                headers: vec![("x-tenant".to_owned(), "acme".to_owned())],
                body: Some(b"{\"jsonrpc\":\"2.0\"}".to_vec()),
                timeout: Duration::from_secs(10),
                max_response_bytes: MAX_BLOCKING_RESPONSE_BYTES,
            })
            .expect("a live loopback server answers");

        assert_eq!(response.status, 200);
        assert_eq!(
            response
                .headers
                .iter()
                .find(|(name, _)| name == "content-type")
                .map(|(_, value)| value.as_str()),
            Some("application/json")
        );
        assert_eq!(String::from_utf8(response.body).unwrap(), "{\"ok\":1}\n");

        let seen = server.join().unwrap();
        assert!(seen[0].starts_with("POST /mcp"), "{seen:?}");
        assert!(
            seen.iter()
                .any(|line| line.eq_ignore_ascii_case("x-tenant: acme")),
            "{seen:?}"
        );
        assert!(
            seen.iter().any(|line| line.contains("\"jsonrpc\":\"2.0\"")),
            "the body did not reach the socket: {seen:?}"
        );
    }

    #[test]
    fn constructing_one_starts_no_threads_and_the_first_request_starts_them_once() {
        // Most users configure no remote MCP server, and for them this object is
        // built at launch and never used. Starting a runtime for it would be
        // three threads created during application startup to serve a feature
        // nobody asked for — and on a loaded machine, a thread-creation burst at
        // exactly the moment the rest of startup is racing.
        let http = BlockingHttp::start().unwrap();
        assert!(
            http.handle.get().is_none(),
            "the runtime was started before anybody asked for a request"
        );

        let (port, _server) = one_shot(
            "HTTP/1.1 204 No Content
content-length: 0
connection: close

",
        );
        let request = |port: u16| BlockingRequest {
            method: "GET".to_owned(),
            url: format!("http://127.0.0.1:{port}/"),
            headers: Vec::new(),
            body: None,
            timeout: Duration::from_secs(10),
            max_response_bytes: 1024,
        };
        assert_eq!(http.send(request(port)).unwrap().status, 204);
        assert!(http.handle.get().is_some(), "the runtime never started");

        // And a second request reuses it rather than starting another.
        let before = http.handle.get().map(|handle| handle.is_ok());
        let _ = http.send(request(port));
        assert_eq!(before, http.handle.get().map(|handle| handle.is_ok()));
    }

    #[test]
    fn nothing_listening_is_unreachable_rather_than_a_hang() {
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let http = BlockingHttp::start().unwrap();
        let outcome = http.send(BlockingRequest {
            method: "GET".to_owned(),
            url: format!("http://127.0.0.1:{port}/"),
            headers: Vec::new(),
            body: None,
            timeout: Duration::from_secs(10),
            max_response_bytes: 1024,
        });
        assert!(
            matches!(outcome, Err(BlockingError::Unreachable(_))),
            "got {outcome:?}"
        );
    }

    #[test]
    fn a_body_past_the_cap_is_refused_rather_than_allocated() {
        let (port, _server) = one_shot(
            "HTTP/1.1 200 OK\r\ncontent-length: 64\r\nconnection: close\r\n\r\n\
             0123456789012345678901234567890123456789012345678901234567890123",
        );
        let http = BlockingHttp::start().unwrap();
        let outcome = http.send(BlockingRequest {
            method: "GET".to_owned(),
            url: format!("http://127.0.0.1:{port}/"),
            headers: Vec::new(),
            body: None,
            timeout: Duration::from_secs(10),
            max_response_bytes: 16,
        });
        assert_eq!(outcome.err(), Some(BlockingError::TooLarge));
    }

    #[test]
    fn a_method_this_client_does_not_send_is_refused_by_name() {
        let http = BlockingHttp::start().unwrap();
        let outcome = http.send(BlockingRequest {
            method: "TRACE".to_owned(),
            url: "http://127.0.0.1:1/".to_owned(),
            headers: Vec::new(),
            body: None,
            timeout: Duration::from_secs(1),
            max_response_bytes: 16,
        });
        assert!(
            matches!(&outcome, Err(BlockingError::Unreachable(detail)) if detail.contains("TRACE")),
            "got {outcome:?}"
        );
    }
}
