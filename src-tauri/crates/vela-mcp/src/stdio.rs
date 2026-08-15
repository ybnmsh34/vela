//! The stdio transport: a child process, two pipes, and the rules for what
//! happens when it dies.
//!
//! ## Why this is the transport that matters
//!
//! Remote MCP servers are reachable with an HTTP client anybody already has.
//! Local ones are a process you have to launch, feed, read, and outlive — and
//! the difference is not the JSON, it is the lifecycle. `docs/spec-parts/mcp.md`
//! §2.1 lists what a client owes the process: an explicit argv rather than a
//! shell string, a bounded line length, stderr that is *not* read as failure,
//! stdin closed as the graceful shutdown signal, and a kill for the process that
//! ignores it. Each of those is one of the ways a naive implementation hangs the
//! app that hosts it.
//!
//! ## The one rule the whole design turns on
//!
//! **A dead server must fail every request that is waiting on it.** One thread
//! reads stdout; when that read returns end-of-file, that thread — and nothing
//! else — is what knows the process is gone. So the reader owns the failure
//! path: on the way out it takes every pending request and completes it with
//! [`McpError::ServerExited`]. Without that, a server that dies mid-request
//! leaves its caller blocked on a channel with no sender, which in a desktop app
//! is a spinner that never stops.
//!
//! It is tested by killing a server mid-request from the server's own side —
//! `a_server_that_dies_mid_request_fails_that_request_rather_than_hanging` in
//! `tests/stdio_end_to_end.rs`.
//!
//! ## What is not implemented
//!
//! No process group or Job Object, so a server that spawns its own children
//! (`npx` launching `node`) can leave grandchildren behind when it is killed.
//! Doing it properly needs Win32 job objects and is not in this slice; it is
//! written here because a reader who assumes otherwise will be wrong.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde_json::Value;

use crate::config::{StdioServer, INHERITED_ENV};
use crate::error::{McpError, McpResult};
use crate::protocol::{self, Incoming};

/// The longest single message this client will accumulate before declaring the
/// stream unusable.
///
/// A line is read into memory before it can be parsed, so an unbounded reader
/// hands a hostile — or merely broken — server the ability to exhaust the app's
/// memory by never sending a newline. Eight megabytes is far above any real tool
/// result and far below a problem.
pub const MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;

/// How long a request waits before the caller is told the server is not
/// answering. A ceiling on a hang, not a tuning surface.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a server gets to exit after its stdin is closed, before it is
/// killed.
const SHUTDOWN_GRACE: Duration = Duration::from_millis(500);

/// Lines of the server's stderr kept for diagnostics. Bounded because a chatty
/// server would otherwise be a slow memory leak.
const STDERR_RING: usize = 32;

/// Called on the reader thread for every notification the server sends.
pub type NotificationSink = Arc<dyn Fn(&str, &Value) + Send + Sync>;

/// Why the transport stopped working. Kept separate from [`McpError`] because it
/// is recorded once and read many times, and [`McpError`] is not `Clone`.
#[derive(Debug, Clone)]
enum Dead {
    Exited,
    Oversized,
    Protocol(String),
}

impl Dead {
    fn as_error(&self) -> McpError {
        match self {
            Dead::Exited => McpError::ServerExited,
            Dead::Oversized => McpError::Protocol(format!(
                "the server sent a message longer than {MAX_MESSAGE_BYTES} bytes"
            )),
            Dead::Protocol(detail) => McpError::Protocol(detail.clone()),
        }
    }
}

struct Shared {
    pending: Mutex<HashMap<u64, SyncSender<McpResult<Value>>>>,
    dead: Mutex<Option<Dead>>,
    stderr: Mutex<VecDeque<String>>,
    on_notification: NotificationSink,
}

impl Shared {
    /// The reader thread's exit path. Every waiting caller learns at once.
    fn bury(&self, reason: Dead) {
        let mut dead = self.dead.lock().expect("mcp dead flag");
        if dead.is_none() {
            *dead = Some(reason.clone());
        }
        drop(dead);
        let waiting: Vec<SyncSender<McpResult<Value>>> = {
            let mut pending = self.pending.lock().expect("mcp pending map");
            pending.drain().map(|(_, sender)| sender).collect()
        };
        for sender in waiting {
            // The receiver may already be gone (its caller timed out); that is
            // not a failure, it is the race this send is racing.
            let _ = sender.send(Err(reason.as_error()));
        }
    }
}

/// One running server process.
pub struct StdioTransport {
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    next_id: AtomicU64,
    shared: Arc<Shared>,
    readers: Mutex<Vec<JoinHandle<()>>>,
    timeout: Duration,
}

impl StdioTransport {
    /// Launch a server.
    ///
    /// `argv` is passed as a program and a list of arguments — never a shell
    /// string. A shell would mean a user's `args` entry containing a quote or an
    /// ampersand becomes a second command, and the entries this reads are
    /// pasted from the internet.
    pub fn spawn(server: &StdioServer, on_notification: NotificationSink) -> McpResult<Self> {
        let mut command = Command::new(&server.command);
        command.args(&server.args);

        // See INHERITED_ENV: the child starts from nothing and is given back
        // only what a program needs to run, plus what the entry asked for.
        command.env_clear();
        for (key, value) in std::env::vars() {
            if INHERITED_ENV
                .iter()
                .any(|allowed| allowed.eq_ignore_ascii_case(&key))
            {
                command.env(key, value);
            }
        }
        for (key, value) in &server.env {
            command.env(key, value);
        }
        if let Some(cwd) = &server.cwd {
            command.current_dir(cwd);
        }

        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command.spawn().map_err(|e| McpError::SpawnFailed {
            command: server.command.clone(),
            detail: e.to_string(),
        })?;

        let stdin = child.stdin.take().ok_or_else(|| McpError::SpawnFailed {
            command: server.command.clone(),
            detail: "the child has no stdin pipe".to_owned(),
        })?;
        let stdout = child.stdout.take().ok_or_else(|| McpError::SpawnFailed {
            command: server.command.clone(),
            detail: "the child has no stdout pipe".to_owned(),
        })?;
        let stderr = child.stderr.take().ok_or_else(|| McpError::SpawnFailed {
            command: server.command.clone(),
            detail: "the child has no stderr pipe".to_owned(),
        })?;

        let shared = Arc::new(Shared {
            pending: Mutex::new(HashMap::new()),
            dead: Mutex::new(None),
            stderr: Mutex::new(VecDeque::new()),
            on_notification,
        });

        let out_shared = Arc::clone(&shared);
        let out_reader =
            std::thread::spawn(move || read_stdout(BufReader::new(stdout), out_shared));

        let err_shared = Arc::clone(&shared);
        let err_reader = std::thread::spawn(move || {
            // A server logging to stderr is normal — the spec says a client
            // SHOULD NOT read stderr output as an error — so this thread stores
            // and never signals.
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut ring = err_shared.stderr.lock().expect("mcp stderr ring");
                if ring.len() == STDERR_RING {
                    ring.pop_front();
                }
                ring.push_back(line);
            }
        });

        Ok(Self {
            child: Mutex::new(child),
            stdin: Mutex::new(Some(stdin)),
            next_id: AtomicU64::new(1),
            shared,
            readers: Mutex::new(vec![out_reader, err_reader]),
            timeout: DEFAULT_REQUEST_TIMEOUT,
        })
    }

    /// Send a request and wait for its answer.
    pub fn request(&self, method: &str, params: Value) -> McpResult<Value> {
        self.request_within(method, params, self.timeout)
    }

    pub fn request_within(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> McpResult<Value> {
        self.check_alive()?;

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = sync_channel::<McpResult<Value>>(1);
        self.shared
            .pending
            .lock()
            .expect("mcp pending map")
            .insert(id, sender);

        if let Err(error) = self.write_line(&protocol::encode_request(id, method, params)) {
            self.shared
                .pending
                .lock()
                .expect("mcp pending map")
                .remove(&id);
            return Err(error);
        }

        match receiver.recv_timeout(timeout) {
            Ok(outcome) => outcome,
            Err(RecvTimeoutError::Timeout) => {
                self.shared
                    .pending
                    .lock()
                    .expect("mcp pending map")
                    .remove(&id);
                // The spec's stdio cancellation: tell the server to stop, and
                // stop waiting. Best-effort — if the write fails the server is
                // already gone, which is the caller's answer anyway.
                let _ = self.write_line(&protocol::encode_notification(
                    protocol::NOTIFY_CANCELLED,
                    serde_json::json!({ "requestId": id }),
                ));
                Err(McpError::TimedOut(timeout))
            }
            // The sender is dropped only by the reader thread's burial path,
            // which sends before dropping; reaching here means the process died
            // between the two.
            Err(RecvTimeoutError::Disconnected) => Err(self.death_reason()),
        }
    }

    pub fn notify(&self, method: &str, params: Value) -> McpResult<()> {
        self.check_alive()?;
        self.write_line(&protocol::encode_notification(method, params))
    }

    /// Whether the process is still usable. Used by the pool to decide between
    /// handing back a connection and replacing it.
    pub fn is_alive(&self) -> bool {
        self.shared.dead.lock().expect("mcp dead flag").is_none()
    }

    /// The last few lines the server wrote to stderr. Diagnostics only — this is
    /// never evidence of failure.
    pub fn recent_stderr(&self) -> Vec<String> {
        self.shared
            .stderr
            .lock()
            .expect("mcp stderr ring")
            .iter()
            .cloned()
            .collect()
    }

    /// Close stdin, give the server a moment to exit on its own, then kill it.
    ///
    /// The order is the spec's and the reason is portability: closing stdin is
    /// the only shutdown signal every stdio server understands, and a kill
    /// without it denies a well-behaved server the chance to flush.
    pub fn shutdown(&self) {
        drop(self.stdin.lock().expect("mcp stdin").take());

        let deadline = std::time::Instant::now() + SHUTDOWN_GRACE;
        loop {
            let exited = {
                let mut child = self.child.lock().expect("mcp child");
                matches!(child.try_wait(), Ok(Some(_)))
            };
            if exited {
                break;
            }
            if std::time::Instant::now() >= deadline {
                let mut child = self.child.lock().expect("mcp child");
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }

        self.shared.bury(Dead::Exited);
        for reader in self.readers.lock().expect("mcp readers").drain(..) {
            let _ = reader.join();
        }
    }

    fn check_alive(&self) -> McpResult<()> {
        match self.shared.dead.lock().expect("mcp dead flag").as_ref() {
            None => Ok(()),
            Some(reason) => Err(reason.as_error()),
        }
    }

    fn death_reason(&self) -> McpError {
        self.shared
            .dead
            .lock()
            .expect("mcp dead flag")
            .as_ref()
            .map_or(McpError::ServerExited, Dead::as_error)
    }

    fn write_line(&self, line: &str) -> McpResult<()> {
        let mut guard = self.stdin.lock().expect("mcp stdin");
        let stdin = guard.as_mut().ok_or(McpError::ServerExited)?;
        // A broken pipe here means the process is gone and the reader thread has
        // not noticed yet; reporting it as anything else would send the caller
        // looking for a bug in their arguments.
        stdin
            .write_all(line.as_bytes())
            .and_then(|()| stdin.flush())
            .map_err(|_| McpError::ServerExited)
    }
}

impl Drop for StdioTransport {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// The reader thread. Owns the only path by which anything learns the server is
/// gone.
fn read_stdout(mut reader: impl BufRead, shared: Arc<Shared>) {
    loop {
        match read_capped_line(&mut reader, MAX_MESSAGE_BYTES) {
            Ok(None) => {
                shared.bury(Dead::Exited);
                return;
            }
            Ok(Some(line)) => {
                if line.trim().is_empty() {
                    continue;
                }
                match protocol::decode(&line) {
                    Ok(Incoming::Response { id, outcome }) => {
                        let sender = shared.pending.lock().expect("mcp pending map").remove(&id);
                        if let Some(sender) = sender {
                            let _ = sender.send(outcome.map_err(McpError::from));
                        }
                        // A response to an id nobody is waiting for is dropped:
                        // it is a request that already timed out, and the
                        // cancellation for it has been sent.
                    }
                    Ok(Incoming::Notification { method, params }) => {
                        (shared.on_notification)(&method, &params);
                    }
                    Err(error) => {
                        // One unreadable line is not a reason to tear down a
                        // working server, and the spec's own posture on junk is
                        // to keep the stream. It is recorded on stderr's ring so
                        // it is visible, and reading continues.
                        let mut ring = shared.stderr.lock().expect("mcp stderr ring");
                        if ring.len() == STDERR_RING {
                            ring.pop_front();
                        }
                        ring.push_back(format!("undecodable message: {error}"));
                    }
                }
            }
            Err(reason) => {
                shared.bury(reason);
                return;
            }
        }
    }
}

/// Read one newline-terminated line, refusing to grow past `max`.
///
/// The standard library's own line reader would do this in one call, and would
/// also let a server that never sends a newline allocate until the process
/// dies. The cap is the entire reason this function exists.
fn read_capped_line(reader: &mut impl BufRead, max: usize) -> Result<Option<String>, Dead> {
    let mut line: Vec<u8> = Vec::new();
    loop {
        let (consumed, complete) = {
            let available = match reader.fill_buf() {
                Ok(bytes) => bytes,
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                // A pipe closing under a read is the same event as end-of-file:
                // the process is gone, and a fragment is not a message.
                Err(_) => return Ok(None),
            };
            if available.is_empty() {
                // End of file. A trailing fragment with no newline is not a
                // message — the framing rule is one message per *line*.
                return Ok(None);
            }
            match available.iter().position(|byte| *byte == b'\n') {
                Some(index) => {
                    line.extend_from_slice(&available[..index]);
                    (index + 1, true)
                }
                None => {
                    line.extend_from_slice(available);
                    (available.len(), false)
                }
            }
        };
        reader.consume(consumed);
        if line.len() > max {
            return Err(Dead::Oversized);
        }
        if complete {
            break;
        }
    }

    match String::from_utf8(line) {
        Ok(text) => Ok(Some(text.trim_end_matches('\r').to_owned())),
        Err(_) => Err(Dead::Protocol("stdout is not UTF-8".to_owned())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn lines_are_split_on_newlines_and_carriage_returns_are_stripped() {
        let mut reader = Cursor::new(b"{\"a\":1}\r\n{\"b\":2}\n".to_vec());
        assert_eq!(
            read_capped_line(&mut reader, MAX_MESSAGE_BYTES).unwrap(),
            Some("{\"a\":1}".to_owned())
        );
        assert_eq!(
            read_capped_line(&mut reader, MAX_MESSAGE_BYTES).unwrap(),
            Some("{\"b\":2}".to_owned())
        );
        assert_eq!(
            read_capped_line(&mut reader, MAX_MESSAGE_BYTES).unwrap(),
            None
        );
    }

    #[test]
    fn a_line_that_never_ends_is_refused_instead_of_being_buffered_forever() {
        let flood = vec![b'x'; 1024];
        let mut reader = Cursor::new(flood);
        assert!(matches!(
            read_capped_line(&mut reader, 64),
            Err(Dead::Oversized)
        ));
    }

    #[test]
    fn a_trailing_fragment_without_a_newline_is_not_a_message() {
        let mut reader = Cursor::new(b"{\"partial\":".to_vec());
        assert_eq!(
            read_capped_line(&mut reader, MAX_MESSAGE_BYTES).unwrap(),
            None
        );
    }
}
