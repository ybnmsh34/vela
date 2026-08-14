//! The local, opt-in place the raw exchange goes — and the only one.
//!
//! # Why this exists
//!
//! [`crate::diagnostic`] takes endpoint-supplied text out of every error Vela
//! renders. That is a security property, and on its own it would also be a
//! diagnostics regression: an error nobody can act on is its own kind of
//! failure, and "the endpoint rejected the request" with no further detail is
//! a worse answer for a user debugging a local llama.cpp than the raw body was.
//!
//! So the body is kept. It is just kept **here**:
//!
//! * **local** — a file on the user's own disk, in a directory they name;
//! * **opt-in** — nothing is written until [`enable`] is called, and the
//!   default state of the process is off. Vela's posture is offline-first with
//!   no telemetry; a debug log that defaults to on is a log that gets shipped
//!   somewhere by accident;
//! * **never across the IPC boundary** — nothing this module records has a
//!   serde surface the bridge carries, and nothing on [`ProviderError`] points
//!   at its contents. What crosses the bridge is a
//!   [`CorrelationId`](crate::diagnostic::CorrelationId), which is a `u64`.
//!
//!   The *switch* does cross it, and must: `vela-app`'s
//!   `ipc::diagnostics::diagnostics_debug_log_set` calls [`enable`] and
//!   [`disable`], and its sibling reports `{enabled, path}`. Nothing else about
//!   this module is reachable from the renderer, and there is deliberately no
//!   command that returns a recorded entry. Before that pair existed [`enable`]
//!   had no caller outside this workspace's own tests while the UI printed a
//!   correlation id on every failed turn — a pointer into a log the user had no
//!   way to switch on, which is worse than no pointer;
//! * **linked** — that id is the join key. A user who opens the log finds the
//!   entry whose `ref` matches the one the error showed them.
//!
//! # What is written
//!
//! The bytes as [`UpstreamBytes`](crate::http::UpstreamBytes) holds them, which
//! means **after** the byte scrubber has run. Round 3's structural property is
//! not weakened to feed this file: the credential is already gone from those
//! bytes before this module can see them, so an opt-in debug log is not a way
//! to opt into leaking your own API key into a file on disk.
//!
//! # Honesty (conventions.md §10)
//!
//! **VERIFIED-BY-FAKE.** The tests write to `MemorySink` and to temporary
//! files, and drive them from scripted bytes. Nothing here has been exercised
//! by a real vendor endpoint.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use crate::diagnostic::{Cause, CorrelationId, EndpointIdentity};

/// One recorded exchange.
///
/// Borrowed rather than owned: a sink that is not installed must cost nothing,
/// and an entry that is never written must not allocate.
pub struct DebugEntry<'a> {
    pub correlation: CorrelationId,
    pub cause: Cause,
    pub status: Option<u16>,
    pub endpoint: Option<&'a EndpointIdentity>,
    /// The raw upstream bytes — already through the credential scrubber.
    pub body: &'a [u8],
}

impl DebugEntry<'_> {
    /// The line a file sink writes. One JSON object per exchange, so the log is
    /// greppable by correlation id and readable by eye.
    pub fn to_line(&self) -> String {
        let value = serde_json::json!({
            "ref": self.correlation.to_string(),
            "cause": self.cause.code(),
            "status": self.status,
            "endpoint": self.endpoint.map(ToString::to_string),
            "body": String::from_utf8_lossy(self.body),
        });
        format!("{value}\n")
    }
}

/// Where recorded exchanges go.
pub trait DebugSink: Send + Sync {
    fn record(&self, entry: &DebugEntry<'_>);
}

/// Appends one JSON object per line to a file the user named.
pub struct FileSink {
    path: PathBuf,
    handle: Mutex<Option<std::fs::File>>,
}

impl FileSink {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            handle: Mutex::new(None),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Open the log for appending, readable and writable by its owner and nobody
/// else.
///
/// # Why this is not `OpenOptions::new().create(true).append(true)`
///
/// Because that produces `0644` under the ordinary `0022` umask, and this file
/// holds **raw upstream bodies** — the endpoint text `diagnostic.rs` exists to
/// keep out of every error Vela renders. A world-readable copy of exactly that
/// is the property inverted: every account on the machine can read what the
/// user's model said to them, and when they were talking to it. Measured, not
/// assumed: [`tests::the_log_is_created_readable_only_by_its_owner`] reads the
/// mode off a real file.
///
/// `mode` applies only when the file is created, so an existing log — left by
/// an earlier run, or by a build from before this rule — is tightened after the
/// open. A user who upgrades should not have to know a stale file is there.
#[cfg(unix)]
fn open_private(path: &Path) -> Option<std::fs::File> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)
        .ok()?;
    if let Ok(metadata) = file.metadata() {
        let mut permissions = metadata.permissions();
        if permissions.mode() & 0o077 != 0 {
            permissions.set_mode(0o600);
            // Through the handle, so this cannot be redirected between the
            // open and the chmod by anything swapping the path.
            let _ = file.set_permissions(permissions);
        }
    }
    Some(file)
}

/// Windows and anything else: [`crate::private_fs::open_private_append`].
///
/// # What this used to say, and why it was wrong
///
/// > *"Windows has no mode bits to set here. The log lives under the per-user
/// > application-data directory, which the OS already ACLs to that user, and
/// > nothing in this file widens it."*
///
/// The second clause was true. The first was an assumption, and on a real
/// Windows machine it was already false before Vela ever ran:
/// `%APPDATA%\dev.vela.desktop\diagnostics` was measured carrying an inherited
/// `CodexSandboxUsers  ReadAndExecute` ACE. Windows has no mode bits, but it
/// does have a DACL, and "the OS already did the equivalent" is a statement
/// about some other installer's ACLs rather than a property of this file.
///
/// [`open_private_append`](crate::private_fs::open_private_append) applies an
/// owner-and-`SYSTEM` DACL with inheritance disabled and then **re-reads the
/// result off the filesystem**, so a log this returns is one the OS has been
/// asked about. `None` on failure, which the sink treats as "record nothing" —
/// a debug log that silently stays readable by another account is worse than no
/// debug log.
///
/// The `unix` sibling is left as it is deliberately: it tightens through the
/// open handle rather than by path, which is strictly stronger, and it is the
/// arm this workspace's mode tests already measure.
#[cfg(not(unix))]
fn open_private(path: &Path) -> Option<std::fs::File> {
    crate::private_fs::open_private_append(path).ok()
}

impl DebugSink for FileSink {
    fn record(&self, entry: &DebugEntry<'_>) {
        let Ok(mut slot) = self.handle.lock() else {
            return;
        };
        if slot.is_none() {
            // Opened lazily and kept open: a debug log that reopens the file
            // per line is a debug log that changes the timing of the thing it
            // is meant to be observing.
            *slot = open_private(&self.path);
        }
        if let Some(file) = slot.as_mut() {
            // A failed write is dropped. This is a diagnostic aid, and a full
            // disk must not turn a 429 into a panic.
            let _ = file.write_all(entry.to_line().as_bytes());
        }
    }
}

/// Keeps every entry in memory. For this workspace's own tests, and for a
/// future in-app diagnostics panel that shows the last N exchanges without
/// touching the disk.
#[derive(Default)]
pub struct MemorySink {
    entries: Mutex<Vec<String>>,
}

impl MemorySink {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn lines(&self) -> Vec<String> {
        self.entries.lock().map(|e| e.clone()).unwrap_or_default()
    }

    /// The recorded body for one correlation id, if it was recorded.
    pub fn body_for(&self, correlation: CorrelationId) -> Option<String> {
        let needle = correlation.to_string();
        self.lines().into_iter().find_map(|line| {
            let value: serde_json::Value = serde_json::from_str(&line).ok()?;
            (value["ref"].as_str()? == needle)
                .then(|| value["body"].as_str().unwrap_or("").to_owned())
        })
    }
}

impl DebugSink for MemorySink {
    fn record(&self, entry: &DebugEntry<'_>) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.push(entry.to_line().trim_end().to_owned());
        }
    }
}

fn slot() -> &'static RwLock<Option<Arc<dyn DebugSink>>> {
    static SLOT: OnceLock<RwLock<Option<Arc<dyn DebugSink>>>> = OnceLock::new();
    SLOT.get_or_init(|| RwLock::new(None))
}

/// Start recording raw exchanges to `sink`.
///
/// **Nothing is recorded until this is called.** The name is deliberately not
/// `set_sink`: turning this on is a decision the user makes, and the call site
/// should read like one.
pub fn enable(sink: Arc<dyn DebugSink>) {
    if let Ok(mut current) = slot().write() {
        *current = Some(sink);
    }
}

/// Stop recording and drop the sink.
pub fn disable() {
    if let Ok(mut current) = slot().write() {
        *current = None;
    }
}

pub fn is_enabled() -> bool {
    slot().read().map(|s| s.is_some()).unwrap_or(false)
}

/// Record one exchange, if the log is on.
///
/// The closure is only called when a sink is installed, so building the entry
/// costs nothing in the default configuration.
pub fn record(build: impl FnOnce() -> DebugEntryOwned) {
    let Ok(current) = slot().read() else {
        return;
    };
    let Some(sink) = current.as_ref() else {
        return;
    };
    let owned = build();
    sink.record(&DebugEntry {
        correlation: owned.correlation,
        cause: owned.cause,
        status: owned.status,
        endpoint: owned.endpoint.as_ref(),
        body: &owned.body,
    });
}

/// Record the raw exchange behind an error that has already been built,
/// keyed by that error's own correlation id.
///
/// This is the shape every call site wants: the error knows its `Cause`, its
/// status and its endpoint, so passing them separately is four chances to pass
/// the wrong one. `body` is only called when the log is on.
pub fn record_for(error: &crate::error::ProviderError, body: impl FnOnce() -> Vec<u8>) {
    let (Some(correlation), Some(cause)) = (error.correlation(), error.cause()) else {
        return;
    };
    let status = error.status();
    let endpoint = error.endpoint().cloned();
    record(move || DebugEntryOwned {
        correlation,
        cause,
        status,
        endpoint,
        body: body(),
    });
}

/// The owned form [`record`]'s closure returns. Owned because the closure
/// builds it on demand and the borrowed form cannot outlive the call.
pub struct DebugEntryOwned {
    pub correlation: CorrelationId,
    pub cause: Cause,
    pub status: Option<u16>,
    pub endpoint: Option<EndpointIdentity>,
    pub body: Vec<u8>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::redact::RequestUrl;

    fn entry(correlation: CorrelationId, body: &str) -> DebugEntryOwned {
        DebugEntryOwned {
            correlation,
            cause: Cause::CredentialRejected,
            status: Some(401),
            endpoint: EndpointIdentity::of(&RequestUrl::new("http://127.0.0.1:8033/v1/chat")),
            body: body.as_bytes().to_vec(),
        }
    }

    #[test]
    fn nothing_is_recorded_until_the_log_is_turned_on() {
        // Serialised against the other test in this module by the lock the
        // sink slot already has: both install and remove their own sink.
        disable();
        assert!(!is_enabled());
        let sink = Arc::new(MemorySink::new());
        record(|| entry(CorrelationId::next(), "must not be recorded"));
        assert!(sink.lines().is_empty(), "no sink was installed");

        enable(sink.clone());
        let id = CorrelationId::next();
        record(|| entry(id, "the endpoint's own words"));
        disable();

        assert_eq!(
            sink.body_for(id).as_deref(),
            Some("the endpoint's own words"),
            "the body is kept, locally, and found by correlation id"
        );
        assert!(!is_enabled());
    }

    /// Records one entry through `sink`, which is what opens the file.
    ///
    /// `cfg(unix)` because only the mode assertions below reach for it; on
    /// Windows the equivalent measurement is an ACL one and lives in
    /// `crate::private_fs`, so leaving this ungated makes `-D warnings` fail on
    /// the platform the ACL work was for.
    #[cfg(unix)]
    fn record_one(sink: &FileSink, body: &str) {
        let owned = entry(CorrelationId::next(), body);
        sink.record(&DebugEntry {
            correlation: owned.correlation,
            cause: owned.cause,
            status: owned.status,
            endpoint: owned.endpoint.as_ref(),
            body: &owned.body,
        });
    }

    #[cfg(unix)]
    fn mode_of(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    /// **The file this log exists to hold is the one that must not be shared.**
    ///
    /// `diagnostic.rs` takes endpoint-supplied bytes out of every error Vela
    /// renders, and this file is where they go instead. A log created under the
    /// default umask is `0644` — every account on the machine can read the raw
    /// bodies of the user's exchanges with their own model. That is the whole
    /// point of the file inverted.
    #[cfg(unix)]
    #[test]
    fn the_log_is_created_readable_only_by_its_owner() {
        let dir = std::env::temp_dir().join(format!("vela-debuglog-mode-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("exchanges.jsonl");
        let _ = std::fs::remove_file(&path);

        let sink = FileSink::new(&path);
        record_one(&sink, "the endpoint's own words");

        assert_eq!(
            mode_of(&path),
            0o600,
            "the debug log is world-readable; it holds raw endpoint bodies"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// The switch is off at every launch, so a log on disk is one an earlier
    /// run left behind — created before this rule existed, or by a build that
    /// did not have it. Opening it must tighten it, not inherit it: a user who
    /// upgrades does not get a fixed permission bit by deleting a file they do
    /// not know is there.
    #[cfg(unix)]
    #[test]
    fn an_existing_loose_log_is_tightened_rather_than_inherited() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("vela-debuglog-old-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("exchanges.jsonl");
        std::fs::write(&path, "{\"ref\":\"0000000000000001\"}\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        let sink = FileSink::new(&path);
        record_one(&sink, "appended to a log from an earlier run");

        assert_eq!(
            mode_of(&path),
            0o600,
            "a pre-existing log kept its loose mode"
        );
        // Tightened, not truncated: the earlier run's entries are still there.
        let written = std::fs::read_to_string(&path).unwrap();
        assert!(written.contains("0000000000000001"));
        assert!(written.contains("appended to a log from an earlier run"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_file_sink_writes_one_json_object_per_line() {
        let dir = std::env::temp_dir().join(format!("vela-debuglog-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("exchanges.jsonl");
        let _ = std::fs::remove_file(&path);
        let sink = FileSink::new(&path);
        let id = CorrelationId::next();
        let owned = entry(id, "line one");
        sink.record(&DebugEntry {
            correlation: owned.correlation,
            cause: owned.cause,
            status: owned.status,
            endpoint: owned.endpoint.as_ref(),
            body: &owned.body,
        });
        let written = std::fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(written.trim()).unwrap();
        assert_eq!(parsed["ref"], id.to_string());
        assert_eq!(parsed["body"], "line one");
        assert_eq!(parsed["endpoint"], "http://127.0.0.1:8033/v1/chat");
        let _ = std::fs::remove_file(&path);
    }
}
