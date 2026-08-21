//! A real HTTP server and a real HTTP client, both on a real loopback socket.
//!
//! # Why this exists rather than a fake `HttpExchange`
//!
//! `tests/stdio_end_to_end.rs` opens with the argument and it holds here: *a
//! mocked transport can pass while the app hangs*. A fake exchange that returns
//! a `HttpReply` struct proves the code above it branches correctly and proves
//! nothing about framing, headers on the wire, a connection that closes, or an
//! endpoint that is not listening. So this module writes HTTP/1.1 bytes into a
//! socket and reads them back out.
//!
//! # This is not "a second HTTP client in the workspace"
//!
//! `vela-settings/tests/capability_matrix_endpoints.rs` asserts that exactly one
//! **crate manifest** declares an HTTP client crate, and `vela-mcp`'s declares
//! none. What that guard is about is the declared dependency, not a byte count:
//! this file adds nothing to any manifest — it is `std::net` and `std::io` in a
//! test target, it talks to `127.0.0.1` and to nothing else, and it is
//! test-only by living here. Same shape and same argument as
//! `vela-providers/tests/wire_auth_headers.rs`, which opens a loopback socket to
//! record the literal bytes Vela puts on the wire.
//!
//! It is not small, and the version of this paragraph before this one called it
//! "fifty lines" while arguing from that it was too small to count. The file is
//! 331 lines, 246 of them neither blank nor comment, and the socket machinery
//! proper — `MockServer` with its `start` and its `Drop`, `read_request`,
//! `write_reply`, `LoopbackExchange::send` and `parse_reply` — is 171 of those
//! 246. Size was never what made it allowed; carrying no dependency of its own
//! is.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use vela_mcp::exchange::{ExchangeError, HttpCall, HttpExchange, HttpReply, MAX_RESPONSE_BYTES};

/// One request as it arrived on the socket.
#[derive(Debug, Clone)]
pub struct Received {
    pub method: String,
    pub path: String,
    /// Lowercased names.
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

impl Received {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }

    /// The JSON-RPC method this request carries, if it carries one.
    pub fn rpc_method(&self) -> Option<String> {
        serde_json::from_str::<serde_json::Value>(&self.body)
            .ok()?
            .get("method")?
            .as_str()
            .map(str::to_owned)
    }

    pub fn rpc_id(&self) -> Option<u64> {
        serde_json::from_str::<serde_json::Value>(&self.body)
            .ok()?
            .get("id")?
            .as_u64()
    }
}

/// What the scripted server writes back.
#[derive(Debug, Clone)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Reply {
    pub fn json(body: impl Into<String>) -> Self {
        Self {
            status: 200,
            headers: vec![("content-type".into(), "application/json".into())],
            body: body.into(),
        }
    }

    /// A `text/event-stream` carrying the given JSON-RPC messages in order.
    pub fn sse(messages: &[String]) -> Self {
        let mut body = String::new();
        for message in messages {
            body.push_str("event: message\ndata: ");
            body.push_str(message);
            body.push_str("\n\n");
        }
        Self {
            status: 200,
            headers: vec![("content-type".into(), "text/event-stream".into())],
            body,
        }
    }

    pub fn status(status: u16) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: String::new(),
        }
    }

    pub fn with_header(mut self, name: &str, value: impl Into<String>) -> Self {
        self.headers.push((name.to_owned(), value.into()));
        self
    }

    pub fn with_body(mut self, body: impl Into<String>) -> Self {
        self.body = body.into();
        self
    }
}

/// A scripted HTTP/1.1 server on a loopback port.
pub struct MockServer {
    port: u16,
    log: Arc<Mutex<Vec<Received>>>,
    stop: Arc<AtomicBool>,
}

impl MockServer {
    pub fn start<F>(responder: F) -> Self
    where
        F: Fn(&Received) -> Reply + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let port = listener.local_addr().unwrap().port();
        let log = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));

        let thread_log = Arc::clone(&log);
        let thread_stop = Arc::clone(&stop);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if thread_stop.load(Ordering::SeqCst) {
                    return;
                }
                let Ok(mut stream) = stream else { return };
                let Some(request) = read_request(&mut stream) else {
                    continue;
                };
                thread_log
                    .lock()
                    .expect("mock server log")
                    .push(request.clone());
                let reply = responder(&request);
                write_reply(&mut stream, &reply);
            }
        });

        Self { port, log, stop }
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    pub fn received(&self) -> Vec<Received> {
        self.log.lock().expect("mock server log").clone()
    }

    /// Every request whose body carries the given JSON-RPC method.
    pub fn rpc(&self, method: &str) -> Vec<Received> {
        self.received()
            .into_iter()
            .filter(|request| request.rpc_method().as_deref() == Some(method))
            .collect()
    }

    pub fn hits(&self, path: &str) -> usize {
        self.received()
            .iter()
            .filter(|request| request.path == path)
            .count()
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Unblock the accept loop so the thread can see the flag.
        let _ = TcpStream::connect(("127.0.0.1", self.port));
    }
}

fn read_request(stream: &mut TcpStream) -> Option<Received> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);

    let mut start = String::new();
    reader.read_line(&mut start).ok()?;
    let mut parts = start.split_whitespace();
    let method = parts.next()?.to_owned();
    let path = parts.next()?.to_owned();

    let mut headers = BTreeMap::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 {
            break;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
        }
    }

    let length: usize = headers
        .get("content-length")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    if length > 0 {
        reader.read_exact(&mut body).ok()?;
    }

    Some(Received {
        method,
        path,
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}

fn write_reply(stream: &mut TcpStream, reply: &Reply) {
    let mut out = format!("HTTP/1.1 {} X\r\n", reply.status);
    for (name, value) in &reply.headers {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str(&format!("content-length: {}\r\n", reply.body.len()));
    // The exchange below reads to end-of-stream, which is the simplest reader
    // that is also correct; `close` is what makes that terminate.
    out.push_str("connection: close\r\n\r\n");
    out.push_str(&reply.body);
    let _ = stream.write_all(out.as_bytes());
    let _ = stream.flush();
}

/// An [`HttpExchange`] that really opens a socket.
///
/// Plaintext only, and only to loopback — which is exactly what
/// `config::validate_remote_url` permits for `http://`, so a test that reached
/// anything else would have had to write a configuration the product refuses.
#[derive(Default)]
pub struct LoopbackExchange {
    /// Every call handed to this exchange, so a test can assert what the
    /// transport built without unpicking bytes off the wire.
    pub calls: Mutex<Vec<HttpCall>>,
}

impl LoopbackExchange {
    pub fn calls(&self) -> Vec<HttpCall> {
        self.calls.lock().expect("exchange log").clone()
    }
}

impl HttpExchange for LoopbackExchange {
    fn send(&self, call: HttpCall, timeout: Duration) -> Result<HttpReply, ExchangeError> {
        self.calls.lock().expect("exchange log").push(call.clone());

        let rest = call
            .url
            .strip_prefix("http://")
            .ok_or_else(|| ExchangeError::Unreachable("only plaintext loopback here".into()))?;
        let (authority, path) = match rest.find('/') {
            Some(index) => rest.split_at(index),
            None => (rest, "/"),
        };

        let mut stream = TcpStream::connect(authority)
            .map_err(|error| ExchangeError::Unreachable(error.to_string()))?;
        stream.set_read_timeout(Some(timeout)).ok();

        let body = call.body.clone().unwrap_or_default();
        let mut request = format!(
            "{} {path} HTTP/1.1\r\nhost: {authority}\r\ncontent-length: {}\r\nconnection: close\r\n",
            call.method.as_str(),
            body.len()
        );
        for (name, value) in &call.headers {
            request.push_str(&format!("{name}: {value}\r\n"));
        }
        request.push_str("\r\n");

        stream
            .write_all(request.as_bytes())
            .and_then(|()| stream.write_all(&body))
            .and_then(|()| stream.flush())
            .map_err(|error| ExchangeError::Unreachable(error.to_string()))?;

        let mut raw = Vec::new();
        // The cap this seam's contract requires. Read one byte past it so
        // "exactly at the limit" is not reported as too large.
        stream
            .take((MAX_RESPONSE_BYTES + 1) as u64)
            .read_to_end(&mut raw)
            .map_err(|error| ExchangeError::Unreachable(error.to_string()))?;
        if raw.len() > MAX_RESPONSE_BYTES {
            return Err(ExchangeError::TooLarge);
        }

        parse_reply(&raw).ok_or_else(|| ExchangeError::Unreachable("truncated response".into()))
    }
}

fn parse_reply(raw: &[u8]) -> Option<HttpReply> {
    let text = String::from_utf8_lossy(raw);
    let (head, body) = text.split_once("\r\n\r\n")?;
    let mut lines = head.split("\r\n");
    let status: u16 = lines.next()?.split_whitespace().nth(1)?.parse().ok()?;
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    Some(HttpReply {
        status,
        headers,
        body: body.as_bytes().to_vec(),
    })
}
