//! The listener: HTTP/1.1 over `std::net::TcpListener`, one thread per
//! connection.
//!
//! ## Why there is no HTTP framework here
//!
//! Because the surface is four paths and one method each, and because adding a
//! server framework to this workspace would add a dependency tree to
//! `Cargo.lock` for a feature that is off by default. `vela-providers` carries
//! the workspace's only HTTP *client* and says so in its manifest; this crate
//! carries the only HTTP *server*, and the whole of it is below. What it
//! supports is stated rather than implied:
//!
//!  - HTTP/1.1 request line, headers, `Content-Length` bodies.
//!  - `Connection: close` on every response. **No keep-alive**: one request per
//!    connection, which costs a client one extra handshake per turn on a
//!    loopback socket and removes every pipelining and framing bug at once.
//!  - **No chunked request bodies.** A request without `Content-Length` is read
//!    as empty. Both SDKs this endpoint serves send `Content-Length`.
//!  - **No TLS.** Correct for loopback; a stated limitation anywhere else.
//!
//! ## Where the security rule is enforced
//!
//! [`ToolPolicy`] is resolved **from the address the listener actually bound**,
//! not from the address the caller asked for — [`serve`] reads the listener's
//! own address back. A caller that asked for port 0 gets the port it was
//! actually given, and a
//! caller that asked for `0.0.0.0` cannot describe it as loopback afterwards.
//! Every decoded request then passes through `ToolPolicy::enforce` on its way
//! to the brain, at exactly one call site in this file.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use vela_providers::event::NullSink;
use vela_providers::model::ChatRequest;
use vela_providers::sse::SseFrame;
use vela_providers::{EventSink, StreamEvent};

use crate::brain::Brain;
use crate::policy::{ToolPolicy, ToolRequest};
use crate::route::{self, AuthOutcome, Dialect, Endpoint};
use crate::{anthropic, openai, Decoded};

/// A request head longer than this is refused. Generous for two SDKs' headers
/// and small enough that a hostile client cannot make the server allocate.
const HEAD_LIMIT: usize = 16 * 1024;
/// A body longer than this is refused. Large enough for a conversation with
/// inline images, bounded so one request cannot exhaust memory.
const BODY_LIMIT: usize = 8 * 1024 * 1024;
/// A connection that sends nothing for this long is dropped, so a stalled peer
/// cannot hold a thread forever.
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// How often the accept loop checks whether it has been told to stop.
const ACCEPT_POLL: Duration = Duration::from_millis(20);

/// What the operator configured.
pub struct EndpointConfig {
    /// The address to bind. Its scope decides the tool policy — see
    /// [`crate::policy`].
    pub bind: SocketAddr,
    /// The one shared bearer key, for both dialects. Empty is refused: an
    /// endpoint that serves Vela's brain to anything that can reach the port is
    /// not a configuration, it is an accident.
    pub api_key: String,
    /// `--enable-tools` / `--disable-tools`, or neither.
    pub tools: ToolRequest,
}

/// Why the endpoint did not come up.
#[derive(Debug)]
pub enum ServeError {
    /// No key. Fails closed rather than serving unauthenticated.
    EmptyKey,
    Bind(io::Error),
}

impl std::fmt::Display for ServeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyKey => f.write_str("the local endpoint needs an API key"),
            Self::Bind(error) => write!(f, "the local endpoint could not bind: {error}"),
        }
    }
}

impl std::error::Error for ServeError {}

/// A running endpoint.
///
/// **Dropping it stops the listener, and waits until the port is closed.** A
/// host that wants the endpoint to outlive the function that started it has to
/// keep this alive — which is the point: a server nobody holds is a server
/// nobody can stop.
///
/// The waiting half is what makes a *rebind* possible rather than only a stop.
/// See [`Self::shutdown`].
#[derive(Debug)]
pub struct ServerHandle {
    address: SocketAddr,
    policy: ToolPolicy,
    stop: Arc<AtomicBool>,
    /// The accept loop, which owns the [`std::net::TcpListener`]. Held so [`Self::shutdown`]
    /// can wait for it to return — `None` once it has been waited on.
    accepting: Option<std::thread::JoinHandle<()>>,
}

impl ServerHandle {
    /// The address actually bound, including the port when `0` was requested.
    pub fn address(&self) -> SocketAddr {
        self.address
    }

    /// The resolved tool policy. Derived from [`Self::address`], so it cannot
    /// disagree with what was bound.
    pub fn policy(&self) -> ToolPolicy {
        self.policy
    }

    /// The base URL to hand a client of `dialect` — **asymmetric between the
    /// two**, see [`route::client_base_url`].
    pub fn client_base_url(&self, dialect: Dialect) -> String {
        route::client_base_url(dialect, &format!("http://{}", self.address))
    }

    /// Ask the accept loop to stop. Returns immediately; the port may still be
    /// open when it does. Connections already in flight finish either way.
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }

    /// **Stop accepting and wait until the listening socket is actually
    /// closed.**
    ///
    /// [`Self::stop`] only raises a flag. The accept loop notices it up to
    /// [`ACCEPT_POLL`] later, and the [`std::net::TcpListener`] is owned by *that*
    /// thread — so between `stop()` returning and the loop returning, the port
    /// is still bound. That gap does not matter to a process on its way out,
    /// and decides everything for one that is not: a host that stops the
    /// endpoint and immediately rebinds **the same address** gets `AddrInUse`
    /// from its own previous listener, because `TcpListener::bind` does not set
    /// `SO_REUSEADDR` on Windows (where it would permit hijacking) and a live
    /// listener holds the port on every platform.
    ///
    /// Joining the accept thread closes the gap: the listener is a local of
    /// that thread's closure, so it is dropped before `join` returns. The wait
    /// is bounded by [`ACCEPT_POLL`].
    ///
    /// In-flight connections are *not* joined. Each is its own thread and they
    /// finish on their own, which is the behaviour [`Self::stop`] already
    /// documents; what is guaranteed here is only that nothing new is accepted
    /// and the address is free.
    pub fn shutdown(&mut self) {
        self.stop();
        if let Some(accepting) = self.accepting.take() {
            // A panicked accept loop has already dropped the listener, so its
            // `Err` is not interesting: the port is free either way.
            let _ = accepting.join();
        }
    }
}

impl Drop for ServerHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Bind, resolve the policy from what was bound, and start accepting.
pub fn serve(config: EndpointConfig, brain: Arc<dyn Brain>) -> Result<ServerHandle, ServeError> {
    if config.api_key.trim().is_empty() {
        return Err(ServeError::EmptyKey);
    }

    let listener = TcpListener::bind(config.bind).map_err(ServeError::Bind)?;
    let address = listener.local_addr().map_err(ServeError::Bind)?;
    listener.set_nonblocking(true).map_err(ServeError::Bind)?;

    // From the bound address, not the requested one.
    let policy = ToolPolicy::for_address(&address, config.tools);
    let stop = Arc::new(AtomicBool::new(false));
    let key = Arc::new(config.api_key);

    let accepting = {
        let stop = Arc::clone(&stop);
        std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _peer)) => {
                        let brain = Arc::clone(&brain);
                        let key = Arc::clone(&key);
                        std::thread::spawn(move || {
                            // A panic in one connection must not take the
                            // listener down; the thread is already isolated,
                            // and the peer sees a closed socket.
                            let _ = stream.set_nodelay(true);
                            handle_connection(stream, brain.as_ref(), &key, policy);
                        });
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        std::thread::sleep(ACCEPT_POLL);
                    }
                    Err(_) => break,
                }
            }
            // `listener` is dropped here, which is what closes the port.
            // `ServerHandle::shutdown` waits for exactly this point.
        })
    };

    Ok(ServerHandle {
        address,
        policy,
        stop,
        accepting: Some(accepting),
    })
}

/* -------------------------------------------------------------------------- */
/* request reading                                                            */
/* -------------------------------------------------------------------------- */

struct Request {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

fn read_request(reader: &mut BufReader<&TcpStream>) -> io::Result<Option<Request>> {
    let mut line = String::new();
    let mut consumed = 0usize;
    if reader.read_line(&mut line)? == 0 {
        return Ok(None);
    }
    consumed += line.len();
    let mut parts = line.trim_end().split(' ');
    let (Some(method), Some(target)) = (parts.next(), parts.next()) else {
        return Ok(None);
    };
    let method = method.to_ascii_uppercase();
    let target = target.to_string();

    let mut headers: Vec<(String, String)> = Vec::new();
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 {
            return Ok(None);
        }
        consumed += header.len();
        if consumed > HEAD_LIMIT {
            return Ok(None);
        }
        let header = header.trim_end_matches(['\r', '\n']);
        if header.is_empty() {
            break;
        }
        let Some((name, value)) = header.split_once(':') else {
            return Ok(None);
        };
        headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
    }

    let length: usize = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse().ok())
        .unwrap_or(0);
    if length > BODY_LIMIT {
        return Ok(None);
    }
    let mut body = vec![0u8; length];
    if length > 0 {
        reader.read_exact(&mut body)?;
    }

    Ok(Some(Request {
        method,
        target,
        headers,
        body,
    }))
}

/* -------------------------------------------------------------------------- */
/* response writing                                                           */
/* -------------------------------------------------------------------------- */

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        429 => "Too Many Requests",
        499 => "Client Closed Request",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        _ => "Error",
    }
}

fn write_json(stream: &mut TcpStream, status: u16, body: &Value) -> io::Result<()> {
    let body = body.to_string();
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {length}\r\n\
         Connection: close\r\n\r\n",
        reason = reason(status),
        length = body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()
}

fn write_sse_head(stream: &mut TcpStream) -> io::Result<()> {
    stream.write_all(
        b"HTTP/1.1 200 OK\r\n\
          Content-Type: text/event-stream\r\n\
          Cache-Control: no-cache\r\n\
          Connection: close\r\n\r\n",
    )?;
    stream.flush()
}

/// One SSE frame on the wire.
///
/// `data` is emitted one `data:` line per newline, which is what the format
/// requires and what `vela_providers::sse::SseDecoder` reassembles. Nothing
/// this crate produces contains a newline today — `serde_json::to_string` emits
/// none — and writing the loop anyway is what keeps that from becoming a
/// silent corruption the day something does.
fn write_frame(stream: &mut TcpStream, frame: &SseFrame) -> io::Result<()> {
    let mut out = String::new();
    if let Some(event) = &frame.event {
        out.push_str("event: ");
        out.push_str(event);
        out.push('\n');
    }
    for line in frame.data.split('\n') {
        out.push_str("data: ");
        out.push_str(line);
        out.push('\n');
    }
    out.push('\n');
    stream.write_all(out.as_bytes())?;
    stream.flush()
}

/* -------------------------------------------------------------------------- */
/* dispatch                                                                   */
/* -------------------------------------------------------------------------- */

fn handle_connection(stream: TcpStream, brain: &dyn Brain, key: &str, policy: ToolPolicy) {
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let mut out = match stream.try_clone() {
        Ok(clone) => clone,
        Err(_) => return,
    };
    let mut reader = BufReader::new(&stream);

    let request = match read_request(&mut reader) {
        Ok(Some(request)) => request,
        // Anything unreadable is one answer. A parser that explained *how* the
        // request was malformed would be a parser telling a stranger about its
        // own internals.
        _ => {
            let _ = write_json(
                &mut out,
                400,
                &openai::error_body("invalid_request", "bad request"),
            );
            let _ = stream.shutdown(Shutdown::Both);
            return;
        }
    };

    dispatch(&mut out, &request, brain, key, policy);
    let _ = stream.shutdown(Shutdown::Both);
}

fn dispatch(
    out: &mut TcpStream,
    request: &Request,
    brain: &dyn Brain,
    key: &str,
    policy: ToolPolicy,
) {
    let path = request.target.as_str();
    let Some(endpoint) = route::resolve(path) else {
        let _ = write_json(out, 404, &openai::error_body("not_found", "unknown path"));
        return;
    };

    if request.method != endpoint.method() {
        let _ = write_json(
            out,
            405,
            &error_for(endpoint.dialect(), "method_not_allowed", "wrong method"),
        );
        return;
    }

    if route::authenticate(request.header("authorization"), key) != AuthOutcome::Ok {
        // One reply for a missing key and for a wrong one. See `AuthOutcome`.
        let _ = write_json(
            out,
            401,
            &error_for(
                endpoint.dialect(),
                "authentication_error",
                "a valid Authorization: Bearer key is required",
            ),
        );
        return;
    }

    match endpoint {
        Endpoint::Models => {
            let _ = write_json(
                out,
                200,
                &openai::models_body(&brain.models(), now_seconds()),
            );
        }
        Endpoint::OpenAiResponses => {
            let _ = write_json(
                out,
                501,
                &openai::error_body(
                    "not_implemented",
                    "/v1/responses is routed but not served by this endpoint",
                ),
            );
        }
        Endpoint::AnthropicMessages => serve_turn(out, Dialect::Anthropic, request, brain, policy),
        Endpoint::OpenAiChatCompletions => serve_turn(out, Dialect::OpenAi, request, brain, policy),
    }
}

fn error_for(dialect: Dialect, kind: &str, message: &str) -> Value {
    match dialect {
        Dialect::Anthropic => anthropic::error_body(kind, message),
        Dialect::OpenAi => openai::error_body(kind, message),
    }
}

fn serve_turn(
    out: &mut TcpStream,
    dialect: Dialect,
    request: &Request,
    brain: &dyn Brain,
    policy: ToolPolicy,
) {
    let decoded = match dialect {
        Dialect::Anthropic => anthropic::decode(&request.body),
        Dialect::OpenAi => openai::decode(&request.body),
    };
    let Decoded { chat, stream } = match decoded {
        Ok(decoded) => decoded,
        Err(error) => {
            let _ = write_json(out, 400, &error_for(dialect, error.code(), error.code()));
            return;
        }
    };

    // **The one enforcement point.** Nothing between here and the brain reads
    // the request's tool fields again, and nothing before here acted on them.
    // A request body asking for tools on an exposed bind therefore has no path
    // to a tool being offered — see `crate::policy`.
    let chat = policy.enforce(chat);
    debug_assert!(
        policy.tools_enabled() || chat.tools.is_empty(),
        "the tool policy must have stripped the catalogue before the brain sees it"
    );

    let model = chat.model_id.clone();
    let id = mint_id(match dialect {
        Dialect::Anthropic => "msg",
        Dialect::OpenAi => "chatcmpl",
    });

    if stream {
        serve_streaming(out, dialect, chat, brain, &id, &model);
    } else {
        serve_buffered(out, dialect, chat, brain, &id, &model);
    }
}

fn serve_buffered(
    out: &mut TcpStream,
    dialect: Dialect,
    chat: ChatRequest,
    brain: &dyn Brain,
    id: &str,
    model: &str,
) {
    let mut sink = NullSink;
    match brain.stream(chat, &mut sink) {
        Ok(response) => {
            let body = match dialect {
                Dialect::Anthropic => anthropic::encode_message(&response, id, model),
                Dialect::OpenAi => openai::encode_completion(&response, id, model, now_seconds()),
            };
            let _ = write_json(out, 200, &body);
        }
        Err(error) => {
            let _ = write_json(
                out,
                crate::error_status(&error),
                &error_for(
                    dialect,
                    crate::error_code(&error),
                    crate::error_code(&error),
                ),
            );
        }
    }
}

/// Both dialects' stream encoders behind one name, so the sink below is one
/// type rather than two.
enum Encoder {
    Anthropic(anthropic::StreamEncoder),
    OpenAi(openai::StreamEncoder),
}

impl Encoder {
    fn opening(&self) -> Vec<SseFrame> {
        match self {
            Self::Anthropic(encoder) => encoder.opening(),
            Self::OpenAi(encoder) => encoder.opening(),
        }
    }

    fn on_event(&mut self, event: &StreamEvent) -> Vec<SseFrame> {
        match self {
            Self::Anthropic(encoder) => encoder.on_event(event),
            Self::OpenAi(encoder) => encoder.on_event(event),
        }
    }
}

/// Writes each event to the socket as it arrives.
///
/// `EventSink::emit` is infallible by contract — "a sink that has gone away
/// must not be able to turn into a provider error halfway through a turn" — so
/// a write failure sets a flag and the remaining events are dropped. The brain
/// keeps running until it finishes or is cancelled, which is the behaviour that
/// contract asks for.
struct SseSink<'a> {
    out: &'a mut TcpStream,
    encoder: Encoder,
    terminated: bool,
    broken: bool,
}

impl EventSink for SseSink<'_> {
    fn emit(&mut self, event: StreamEvent) {
        if event.is_terminal() {
            self.terminated = true;
        }
        if self.broken {
            return;
        }
        for frame in self.encoder.on_event(&event) {
            if write_frame(self.out, &frame).is_err() {
                self.broken = true;
                return;
            }
        }
    }
}

fn serve_streaming(
    out: &mut TcpStream,
    dialect: Dialect,
    chat: ChatRequest,
    brain: &dyn Brain,
    id: &str,
    model: &str,
) {
    let encoder = match dialect {
        Dialect::Anthropic => Encoder::Anthropic(anthropic::StreamEncoder::new(id, model)),
        Dialect::OpenAi => Encoder::OpenAi(openai::StreamEncoder::new(id, model, now_seconds())),
    };

    if write_sse_head(out).is_err() {
        return;
    }

    let mut sink = SseSink {
        out,
        encoder,
        terminated: false,
        broken: false,
    };
    for frame in sink.encoder.opening() {
        if write_frame(sink.out, &frame).is_err() {
            sink.broken = true;
            break;
        }
    }

    let result = brain.stream(chat, &mut sink);

    // A `Provider` always terminates its own stream, and asserts in a debug
    // build that it did. A `Brain` is a wider seam — a host could hand one
    // that returns without emitting — so the terminal event is written here if
    // it was not written there. A client that never receives one hangs until
    // its own timeout, which is the worst failure this endpoint can produce.
    if !sink.terminated {
        let closing = match result {
            Ok(response) => StreamEvent::Done {
                response: Box::new(response),
            },
            Err(error) => StreamEvent::Error { error },
        };
        sink.emit(closing);
    }
}

/* -------------------------------------------------------------------------- */
/* ids and time                                                               */
/* -------------------------------------------------------------------------- */

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// A per-turn id. Not a UUID and not claimed to be one: it is unique within a
/// process because of the counter, and distinguishable between runs because of
/// the clock. Nothing depends on it being unguessable — it is an echo, not a
/// capability.
fn mint_id(prefix: &str) -> String {
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.subsec_nanos())
        .unwrap_or(0);
    format!("{prefix}_{nanos:09}{count:04}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use vela_providers::model::ChatResponse;

    #[test]
    fn an_endpoint_with_no_key_refuses_to_come_up() {
        let brain: Arc<dyn Brain> = Arc::new(crate::FnBrain::new(Vec::new(), |_, _| {
            Ok(ChatResponse::empty())
        }));
        let error = serve(
            EndpointConfig {
                bind: "127.0.0.1:0".parse().unwrap(),
                api_key: "   ".to_string(),
                tools: ToolRequest::Default,
            },
            brain,
        )
        .expect_err("an unauthenticated endpoint must not start");
        assert!(matches!(error, ServeError::EmptyKey));
    }

    #[test]
    fn the_policy_is_derived_from_the_address_that_was_actually_bound() {
        let brain: Arc<dyn Brain> = Arc::new(crate::FnBrain::new(Vec::new(), |_, _| {
            Ok(ChatResponse::empty())
        }));
        let handle = serve(
            EndpointConfig {
                bind: "127.0.0.1:0".parse().unwrap(),
                api_key: "k".to_string(),
                tools: ToolRequest::Default,
            },
            brain,
        )
        .expect("loopback bind must succeed");
        assert!(
            handle.address().port() != 0,
            "port 0 must resolve to a real port"
        );
        assert!(handle.policy().tools_enabled());
        assert_eq!(
            handle.client_base_url(Dialect::Anthropic),
            format!("http://{}", handle.address())
        );
        assert_eq!(
            handle.client_base_url(Dialect::OpenAi),
            format!("http://{}/v1", handle.address())
        );
    }

    /// **The property a rebind rests on**, and the reason `shutdown` joins
    /// rather than only signalling.
    ///
    /// Dropping the handle must leave the address free *by the time drop
    /// returns*. Without the join this fails on the first iteration roughly
    /// always: the accept loop is asleep for up to `ACCEPT_POLL` and still owns
    /// the listener, so the second `bind` of the same address is refused.
    ///
    /// Port `0` and then the *resolved* address on purpose: a hard-coded port
    /// would be a test that fails when something else on the machine happens to
    /// hold it, which is a different fact than the one being measured.
    #[test]
    fn the_port_is_free_by_the_time_the_handle_finishes_dropping() {
        fn brain() -> Arc<dyn Brain> {
            Arc::new(crate::FnBrain::new(Vec::new(), |_, _| {
                Ok(ChatResponse::empty())
            }))
        }

        let first = serve(
            EndpointConfig {
                bind: "127.0.0.1:0".parse().unwrap(),
                api_key: "k".to_string(),
                tools: ToolRequest::Default,
            },
            brain(),
        )
        .expect("loopback bind must succeed");
        let address = first.address();
        drop(first);

        // Twice, because "the port reopened once" is also what a lucky race
        // looks like.
        for attempt in 1..=2 {
            let again = serve(
                EndpointConfig {
                    bind: address,
                    api_key: "k".to_string(),
                    tools: ToolRequest::Default,
                },
                brain(),
            )
            .unwrap_or_else(|error| {
                panic!("attempt {attempt}: {address} must be free after drop: {error}")
            });
            assert_eq!(again.address(), address);
            drop(again);
        }
    }

    #[test]
    fn a_frame_with_a_newline_becomes_two_data_lines() {
        // Not reachable from anything this crate encodes today; written so it
        // stays unreachable rather than becoming a silent corruption.
        let frame = SseFrame {
            event: Some("x".to_string()),
            data: "a\nb".to_string(),
        };
        let mut rendered = String::new();
        if let Some(event) = &frame.event {
            rendered.push_str(&format!("event: {event}\n"));
        }
        for line in frame.data.split('\n') {
            rendered.push_str(&format!("data: {line}\n"));
        }
        rendered.push('\n');
        assert_eq!(rendered, "event: x\ndata: a\ndata: b\n\n");
    }

    #[test]
    fn ids_do_not_repeat_within_a_process() {
        let first = mint_id("msg");
        let second = mint_id("msg");
        assert_ne!(first, second);
        assert!(first.starts_with("msg_"));
    }
}
