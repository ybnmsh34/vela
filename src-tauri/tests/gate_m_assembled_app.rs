//! **GATE M — the assembled application, driven through its own front door.**
//!
//! Every gate this project has run — including `tests/composition_root.rs`,
//! which is otherwise the closest thing to this file — drove *some* stand-in:
//! an example binary, an HTTP relay, or a hand-built `AppState` plus a
//! hand-written copy of what `chat_send` does. That is precisely how an
//! application which did not start on the operator's machine accumulated 1455
//! passing assertions.
//!
//! This file removes the last stand-in that a headless container can remove.
//! It calls [`vela_lib::configure`] — **the same function `run()` calls, the
//! only description of how Vela is assembled** — on `tauri::test`'s mock
//! runtime, lets its `setup` run for real, and then invokes commands **by the
//! string name the renderer uses**, through the real `invoke_handler`, with
//! `serde_json` payloads shaped exactly as `src/platform/contract.ts` sends
//! them. Nothing between the request and the answer is written by this file.
//!
//! What that buys, concretely, over every previous gate:
//!
//! | Layer | previously | here |
//! |---|---|---|
//! | `AppState::for_runtime()` | never constructed by a test | constructed by `configure` |
//! | `run()`'s `setup` — store open, `sync_from_settings`, debug-log handle | asserted by `include_str!` grep | **executed** |
//! | the command allowlist in `generate_handler!` | asserted by name comparison | **dispatched through** |
//! | `chat_send` itself | reimplemented by the test | **called** |
//! | the `chat:event` channel | a `Vec` the test owned | the real `Emitter` path |
//!
//! # What this still is NOT
//!
//! - **Not the Tauri webview.** `tauri::test::mock_runtime` implements the
//!   `Runtime` trait with no windowing system; no WebView2, no WebKitGTK, no
//!   renderer. Whether the *shipping window* paints is the desktop session's
//!   verdict and cannot be taken from here.
//! - **Not a model.** The endpoint is a fixture this file starts and whose
//!   bytes it wrote. **VERIFIED-BY-FAKE** (`docs/architecture/conventions.md`
//!   §10).
//! - **Not the OS keychain.** These tests run without the `os-keychain`
//!   feature, so `AppState::for_runtime()` resolves to `MemoryStore` — and
//!   [`the_runtime_state_reports_the_credential_backend_it_actually_built`]
//!   asserts the app *says so* rather than letting the substitution be silent.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::test::{mock_builder, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{Listener, Manager, WebviewWindow};

/* ========================================================================== */
/* the fixture endpoint — a socket that records what the host sent it         */
/* ========================================================================== */

#[derive(Debug, Clone)]
struct Recorded {
    method: String,
    path: String,
    body: String,
}

struct FixtureEndpoint {
    base_url: String,
    seen: Arc<Mutex<Vec<Recorded>>>,
    shutdown: Arc<Mutex<bool>>,
}

impl FixtureEndpoint {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let shutdown = Arc::new(Mutex::new(false));

        let thread_seen = Arc::clone(&seen);
        let thread_shutdown = Arc::clone(&shutdown);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if *thread_shutdown.lock().unwrap() {
                    return;
                }
                let Ok(stream) = stream else { continue };
                serve(stream, &thread_seen);
            }
        });

        Self {
            base_url: format!("http://127.0.0.1:{port}/v1"),
            seen,
            shutdown,
        }
    }

    fn requests(&self) -> Vec<Recorded> {
        self.seen.lock().unwrap().clone()
    }

    fn completion(&self) -> Option<Recorded> {
        self.requests()
            .into_iter()
            .find(|request| request.path.contains("chat/completions"))
    }
}

impl Drop for FixtureEndpoint {
    fn drop(&mut self) {
        *self.shutdown.lock().unwrap() = true;
    }
}

fn serve(mut stream: TcpStream, seen: &Arc<Mutex<Vec<Recorded>>>) {
    let mut reader = BufReader::new(stream.try_clone().expect("clone"));

    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() || request_line.trim().is_empty() {
        return;
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_owned();
    let path = parts.next().unwrap_or_default().to_owned();

    let mut content_length = 0usize;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).is_err() {
            return;
        }
        if header.trim().is_empty() {
            break;
        }
        if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or(0);
        }
    }

    let mut body = vec![0u8; content_length];
    if content_length > 0 && reader.read_exact(&mut body).is_err() {
        return;
    }
    seen.lock().unwrap().push(Recorded {
        method,
        path: path.clone(),
        body: String::from_utf8_lossy(&body).into_owned(),
    });

    let response = if path.contains("chat/completions") {
        let frames = concat!(
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"counting on my fingers\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"three hundred \"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"and ninety one\"}}]}\n\n",
            "data: [DONE]\n\n",
        );
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{frames}",
            frames.len()
        )
    } else if path.contains("/models") {
        let body = r#"{"data":[{"id":"fixture-model"}]}"#;
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    } else {
        "HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_owned()
    };
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

/* ========================================================================== */
/* the assembled application                                                  */
/* ========================================================================== */

/// Serialises application construction.
///
/// `setup` resolves the application-data directory through Tauri's path API,
/// which on Linux reads `XDG_DATA_HOME` at call time. Each app therefore gets
/// its own directory by setting that variable while it builds — and because the
/// variable is process-global, exactly one app may be under construction at a
/// time. Held only across `build`, never across a turn.
fn build_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// One running Vela, assembled by the shipping composition root.
struct RunningApp {
    #[allow(dead_code)]
    app: tauri::App<tauri::test::MockRuntime>,
    webview: WebviewWindow<tauri::test::MockRuntime>,
    events: Arc<Mutex<Vec<Value>>>,
    /// Captured while the build lock is held. Resolving it later would read a
    /// `XDG_DATA_HOME` another test may have moved.
    data_dir: std::path::PathBuf,
}

impl RunningApp {
    /// Builds the application the way `run()` does, with its data directory
    /// pointed at `data_home`.
    ///
    /// The only difference from `run()` is the runtime and the fact that this
    /// does not block the thread forever. `configure` — the state, the `setup`,
    /// the allowlist — is called, not copied.
    fn start(data_home: &std::path::Path) -> Self {
        let (app, data_dir) = {
            let _guard = build_lock();
            std::env::set_var("XDG_DATA_HOME", data_home);
            let mut app = vela_lib::configure(mock_builder())
                .build(tauri::generate_context!())
                .expect("the shipping composition root must assemble");
            // `build` does not run `setup`; `run`/`run_iteration` does, and
            // `run` never returns. One iteration is what the shipping process
            // does on its first turn round the event loop: it opens the
            // database, fills the provider set from settings, and installs the
            // debug-log handle. Still inside the lock, because that work
            // resolves the data directory.
            // Deprecated only because looping on it busy-waits; called once it
            // is exactly "run the startup the event loop would have run", which
            // is the whole point here. The alternative,
            // `tauri::App::run_return`, does not return until the app exits.
            #[allow(deprecated)]
            app.run_iteration(|_, _| {});
            let data_dir = app.path().app_data_dir().expect("an app data dir");
            (app, data_dir)
        };

        // The window `tauri.conf.json` declares, created by `setup` — not one
        // this test invented.
        let webview = app
            .get_webview_window("main")
            .expect("the main window from tauri.conf.json");

        // The renderer's end of the `chat:event` channel. `chat_send` emits
        // through `AppHandle::emit`; this is the same event name and the same
        // envelope `src/platform/adapter.ts` subscribes to.
        let events: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        app.listen("chat:event", move |event| {
            if let Ok(value) = serde_json::from_str::<Value>(event.payload()) {
                sink.lock().unwrap().push(value);
            }
        });

        Self {
            app,
            webview,
            events,
            data_dir,
        }
    }

    /// Invokes a command **by name**, exactly as the renderer does.
    ///
    /// Returns the command's `Ok` value, or the serialised `IpcError`.
    fn invoke(&self, command: &str, payload: Value) -> Result<Value, Value> {
        let response = tauri::test::get_ipc_response(
            &self.webview,
            InvokeRequest {
                cmd: command.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                // The app's own origin. On Linux the custom protocol is
                // `tauri://localhost`; anything else is a REMOTE origin, and
                // the host must — and does — refuse to dispatch a command for
                // it. See `a_remote_origin_cannot_reach_a_command`.
                url: "tauri://localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(json!({ "payload": payload })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        );
        match response {
            Ok(body) => Ok(body.deserialize::<Value>().unwrap_or(Value::Null)),
            Err(error) => Err(serde_json::to_value(error).unwrap_or(Value::Null)),
        }
    }

    /// The same invoke, from an origin that is not the app's own.
    fn invoke_from(&self, origin: &str, command: &str, payload: Value) -> Result<Value, Value> {
        let response = tauri::test::get_ipc_response(
            &self.webview,
            InvokeRequest {
                cmd: command.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: origin.parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(json!({ "payload": payload })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        );
        match response {
            Ok(body) => Ok(body.deserialize::<Value>().unwrap_or(Value::Null)),
            Err(error) => Err(serde_json::to_value(error).unwrap_or(Value::Null)),
        }
    }

    fn ok(&self, command: &str, payload: Value) -> Value {
        self.invoke(command, payload)
            .unwrap_or_else(|error| panic!("`{command}` was expected to succeed: {error}"))
    }

    fn err(&self, command: &str, payload: Value) -> Value {
        self.invoke(command, payload)
            .expect_err(&format!("`{command}` was expected to fail"))
    }

    /// Configures an endpoint through the settings command the settings screen
    /// calls. No test-only door: this is `settings_put_provider`.
    fn configure_endpoint(&self, id: &str, base_url: &str) -> Value {
        self.ok(
            "settings_put_provider",
            json!({
                "id": id,
                "displayName": "The user's endpoint",
                "kind": "local",
                "baseUrl": base_url,
                "modelId": "fixture-model",
                "auth": { "type": "none" },
                "authRequirement": "notRequired",
            }),
        )
    }

    /// Sends a turn and waits for the stream to terminate on the real event
    /// channel. Returns every event the renderer would have received.
    fn send_turn(&self, payload: Value) -> Vec<Value> {
        let accepted = self.ok("chat_send", payload);
        assert_eq!(
            accepted.get("accepted"),
            Some(&Value::Bool(true)),
            "chat_send must acknowledge before the stream starts"
        );
        self.drain_until_terminal()
    }

    fn drain_until_terminal(&self) -> Vec<Value> {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            {
                let seen = self.events.lock().unwrap();
                let terminal = seen.iter().any(|event| {
                    matches!(
                        event.pointer("/event/type").and_then(Value::as_str),
                        Some("done") | Some("error")
                    )
                });
                if terminal {
                    return seen.clone();
                }
            }
            if Instant::now() > deadline {
                panic!(
                    "the turn never terminated on `chat:event`; saw {:?}",
                    self.events.lock().unwrap()
                );
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn take_events(&self) -> Vec<Value> {
        std::mem::take(&mut *self.events.lock().unwrap())
    }

    fn data_dir(&self) -> std::path::PathBuf {
        self.data_dir.clone()
    }
}

/* -------------------------------------------------------------------------- */
/* helpers over the event stream                                              */
/* -------------------------------------------------------------------------- */

fn deltas(events: &[Value], kind: &str) -> String {
    events
        .iter()
        .filter(|event| event.pointer("/event/type").and_then(Value::as_str) == Some(kind))
        .filter_map(|event| event.pointer("/event/text").and_then(Value::as_str))
        .collect()
}

fn turn(provider_id: &str, text: &str) -> Value {
    json!({
        "turnId": "turn-1",
        "providerId": provider_id,
        "modelId": "fixture-model",
        "messages": [{ "role": "user", "text": text }],
    })
}

fn temp_home() -> tempfile::TempDir {
    tempfile::tempdir().expect("a temporary data home")
}

/* ========================================================================== */
/* 1 — a turn sent through the REAL command reaches the endpoint              */
/* ========================================================================== */

/// **The gate's central claim.** Configure a provider through the real settings
/// command, send a turn through the real chat command, and assert the bytes
/// arrive at the address the user typed.
///
/// Nothing here is reimplemented: `settings_put_provider` and `chat_send` are
/// reached by name through `generate_handler!`, and every layer between them
/// and the socket is the shipping one.
#[test]
fn a_turn_sent_through_the_real_chat_command_reaches_the_configured_endpoint() {
    let endpoint = FixtureEndpoint::start();
    let home = temp_home();
    let app = RunningApp::start(home.path());

    app.configure_endpoint("my-box", &endpoint.base_url);
    let events = app.send_turn(turn("my-box", "what is 17 times 23?"));

    let completion = endpoint
        .completion()
        .expect("the assembled app must open a connection to the configured address");
    assert_eq!(completion.method, "POST");
    assert!(
        completion.body.contains("what is 17 times 23?"),
        "the user's words must arrive at the endpoint: {}",
        completion.body
    );

    assert_eq!(deltas(&events, "textDelta"), "three hundred and ninety one");
    assert_eq!(deltas(&events, "reasoningDelta"), "counting on my fingers");
    assert!(
        !deltas(&events, "textDelta").contains("counting"),
        "reasoning must not leak into the answer channel"
    );
    assert_eq!(
        events.last().and_then(|e| e.pointer("/event/type")),
        Some(&json!("done")),
        "the stream must terminate"
    );
    assert!(
        events
            .iter()
            .all(|event| event.get("turnId") == Some(&json!("turn-1"))),
        "every event must carry the renderer's own turn id, or it cannot be routed"
    );
}

/// **THE NEGATIVE CONTROL for the whole wave.**
///
/// The pre-fix wiring, reproduced exactly: a settings row written, and the
/// provider set never filled. That was the shipping application — the user
/// configured an endpoint, the UI drew it as ready, and every turn came back
/// `NOT_FOUND`.
///
/// It is staged by writing the row directly into the same store the app opens,
/// **while the app is not looking**, which is behaviourally identical to the
/// old `AppState::for_runtime()` that had no `sync_from_settings` behind it:
/// configuration on disk, nothing live.
#[test]
fn the_pre_fix_wiring_still_reproduces_not_found_on_demand() {
    use vela_settings::{ProviderConfig, SettingsService};
    use vela_store::{DatabaseLocation, SqliteStore};

    let endpoint = FixtureEndpoint::start();
    let home = temp_home();
    let app = RunningApp::start(home.path());
    let data_dir = app.data_dir();

    // A row on disk that the live set has never been told about.
    {
        let store = SqliteStore::open(DatabaseLocation::in_directory(&data_dir))
            .expect("the same database the app opened");
        let secrets = vela_secrets::MemoryStore::new();
        let config = ProviderConfig::local("ghost", "Ghost", &endpoint.base_url).unwrap();
        SettingsService::new(&store, &secrets)
            .put_provider(config)
            .expect("a valid row");
    }

    let error = app.err("chat_send", turn("ghost", "anyone there?"));
    assert_eq!(
        error.get("code").and_then(Value::as_str),
        Some("NOT_FOUND"),
        "the control must reproduce the pre-fix symptom: {error}"
    );
    assert!(
        endpoint.requests().is_empty(),
        "the pre-fix wiring must not reach the endpoint at all"
    );

    // And the contrast, in the same process: going through the real settings
    // command instead makes the identical endpoint reachable.
    app.configure_endpoint("ghost", &endpoint.base_url);
    let events = app.send_turn(turn("ghost", "anyone there?"));
    assert_eq!(deltas(&events, "textDelta"), "three hundred and ninety one");
    assert!(endpoint.completion().is_some());
}

/// The other half of the same defect: a provider configured in an **earlier
/// session** must be live in this one. That is `setup`'s `sync_from_settings`,
/// and until this wave nothing executed it — it was asserted by grepping
/// `lib.rs` for the string.
#[test]
fn a_provider_configured_in_an_earlier_session_is_live_after_a_restart() {
    let endpoint = FixtureEndpoint::start();
    let home = temp_home();

    {
        let first = RunningApp::start(home.path());
        first.configure_endpoint("my-box", &endpoint.base_url);
    } // the process ends here: nothing in memory survives

    let second = RunningApp::start(home.path());
    let events = second.send_turn(turn("my-box", "still there?"));

    assert_eq!(deltas(&events, "textDelta"), "three hundred and ninety one");
    assert!(
        endpoint.completion().is_some(),
        "startup must turn stored configuration into live providers"
    );
}

/// Deleting an endpoint takes effect on the next turn, not the next restart.
#[test]
fn deleting_an_endpoint_makes_it_unreachable_immediately() {
    let endpoint = FixtureEndpoint::start();
    let home = temp_home();
    let app = RunningApp::start(home.path());

    app.configure_endpoint("my-box", &endpoint.base_url);
    app.send_turn(turn("my-box", "before"));
    app.take_events();

    app.ok(
        "settings_delete_provider",
        json!({ "providerId": "my-box" }),
    );

    let error = app.err("chat_send", turn("my-box", "after"));
    assert_eq!(error.get("code").and_then(Value::as_str), Some("NOT_FOUND"));
}

/* ========================================================================== */
/* 2 — the app tells the truth about what it is made of                       */
/* ========================================================================== */

/// The substitution must never be silent. These tests run without the
/// `os-keychain` feature, and the assembled app is required to say so through
/// the same command the UI status line reads.
#[test]
fn the_runtime_state_reports_the_credential_backend_it_actually_built() {
    let home = temp_home();
    let app = RunningApp::start(home.path());

    let info = app.ok("app_info", json!({}));
    let backend = info
        .get("secretBackend")
        .and_then(Value::as_str)
        .expect("app_info must name its credential backend");
    assert_eq!(
        backend,
        if cfg!(feature = "os-keychain") {
            "os-keychain"
        } else {
            "memory-fake"
        },
        "the assembled app must report the backend it was actually built with"
    );
    let settings = app.ok("settings_get", json!({}));
    assert_eq!(
        settings.get("telemetryEnabled"),
        Some(&json!(false)),
        "telemetry must be off in the assembled app: {settings}"
    );
}

/// The debug log the failed-turn `trace` id points at must be addressable from
/// the assembled app, and must start **off**.
#[test]
fn the_debug_log_switch_has_a_caller_in_the_assembled_app_and_starts_off() {
    let home = temp_home();
    let app = RunningApp::start(home.path());

    let before = app.ok("diagnostics_debug_log_get", json!({}));
    assert_eq!(
        before.get("enabled"),
        Some(&json!(false)),
        "the debug log must be off until the user turns it on"
    );

    let after = app.ok("diagnostics_debug_log_set", json!({ "enabled": true }));
    assert_eq!(after.get("enabled"), Some(&json!(true)));
    assert_eq!(
        app.ok("diagnostics_debug_log_get", json!({}))
            .get("enabled"),
        Some(&json!(true)),
        "the switch must be reachable through the shipping command, or the \
         trace id in the UI points at a log with no way to enable it"
    );
}

/// **An evidence driver, not an assertion.** Ignored by default; run by
/// `scripts/gate-m-debug-log-modes.sh`, which supplies `VELA_GATE_DEBUG_LOG_HOME`
/// and then reads the modes back **from a shell**.
///
/// # Why this exists when two unit tests already assert `0700` / `0600`
///
/// Those tests read the mode with the same `std::fs` the code under test used,
/// inside the process that created the file, under whatever umask the test
/// harness happened to be running with. That is a fine assertion and a poor
/// measurement: it cannot tell you what a *user's* shell would see, and it
/// cannot see a mode that is right at creation and widened afterwards.
///
/// So this drives the real `diagnostics_debug_log_set` command in the
/// assembled app, makes a turn fail so the log actually receives a line — the
/// sink opens its file lazily, so an enabled log with nothing written to it is
/// a directory and no file — and then gets out of the way and lets `stat`
/// answer the question.
///
/// It creates nothing itself: the shell chooses the data home, may pre-loosen
/// the directory and the log before this runs, and inspects both afterwards.
#[test]
#[ignore = "evidence driver: needs VELA_GATE_DEBUG_LOG_HOME; run by scripts/gate-m-debug-log-modes.sh"]
fn debug_log_evidence_driver() {
    let home = std::path::PathBuf::from(
        std::env::var("VELA_GATE_DEBUG_LOG_HOME")
            .expect("VELA_GATE_DEBUG_LOG_HOME must point at the data home to drive"),
    );
    let app = RunningApp::start(&home);

    let status = app.ok("diagnostics_debug_log_set", json!({ "enabled": true }));
    let path = status
        .get("path")
        .and_then(Value::as_str)
        .expect("the switch must report where it writes")
        .to_owned();

    // A turn that cannot connect. The failure is what puts a line in the log:
    // `http.rs` records the transport's own message there and hands the user
    // only a correlation id, which is the whole reason the log exists.
    //
    // Port 1 on loopback: nothing listens, and nothing in this process decides
    // that — the refusal comes from the kernel.
    app.configure_endpoint("dead-box", "http://127.0.0.1:1/v1");
    let _ = app.send_turn(turn("dead-box", "is anyone there?"));

    println!("VELA_DEBUG_LOG_PATH={path}");
    assert!(
        std::path::Path::new(&path).exists(),
        "a failed turn with the log enabled must leave a line on disk, or there \
         is nothing for the shell to measure"
    );
}

/// A command that is not in `generate_handler!` must not be dispatchable. This
/// is the allowlist asserted by **dispatch**, not by comparing two lists.
#[test]
fn a_command_outside_the_allowlist_is_not_dispatchable() {
    let home = temp_home();
    let app = RunningApp::start(home.path());

    let error = app.err("settings_set_telemetry", json!({ "enabled": true }));
    let text = error.to_string();
    assert!(
        text.contains("not found") || text.contains("not allowed"),
        "an unlisted command must be refused by the host: {text}"
    );
}

/// **The origin control.** Remote content must not be able to reach a Vela
/// command. This is the counterpart to the assertion that `tauri://localhost`
/// *can*: without it, the whole file could be passing because the host
/// dispatches for anyone who asks.
#[test]
fn a_remote_origin_cannot_reach_a_command() {
    let home = temp_home();
    let app = RunningApp::start(home.path());

    // The identical command, identical payload, identical invoke key — only
    // the origin differs.
    assert!(
        app.invoke_from("tauri://localhost", "app_info", json!({}))
            .is_ok(),
        "the app's own origin must be able to call its own commands"
    );
    let refused = app
        .invoke_from("https://evil.example", "app_info", json!({}))
        .expect_err("a remote origin must not reach a command");
    assert!(
        refused.to_string().contains("not allowed"),
        "the refusal must be an ACL refusal: {refused}"
    );
}

/* ========================================================================== */
/* 3 — the wider IPC contract, exercised through the shipping commands        */
/* ========================================================================== */

/// An image attached in the payload reaches the endpoint. Before this wave
/// `ChatMessageInput` was `{role, text}` and no shipping path could carry one.
#[test]
fn an_image_attached_in_the_payload_reaches_the_endpoint() {
    let endpoint = FixtureEndpoint::start();
    let home = temp_home();
    let app = RunningApp::start(home.path());
    app.configure_endpoint("my-box", &endpoint.base_url);

    app.send_turn(json!({
        "turnId": "turn-1",
        "providerId": "my-box",
        "modelId": "fixture-model",
        "messages": [{
            "role": "user",
            "text": "what is in this picture?",
            "parts": [{
                "kind": "image",
                "mimeType": "image/png",
                "data": "iVBORw0KGgo=",
            }],
        }],
    }));

    let body = endpoint.completion().expect("a request").body;
    assert!(
        body.contains("image_url") && body.contains("iVBORw0KGgo="),
        "the attached image must be on the wire: {body}"
    );
}

/// A tool catalogue offered in the payload reaches the endpoint.
#[test]
fn a_tool_catalogue_offered_in_the_payload_reaches_the_endpoint() {
    let endpoint = FixtureEndpoint::start();
    let home = temp_home();
    let app = RunningApp::start(home.path());
    app.configure_endpoint("my-box", &endpoint.base_url);

    app.send_turn(json!({
        "turnId": "turn-1",
        "providerId": "my-box",
        "modelId": "fixture-model",
        "messages": [{ "role": "user", "text": "what is the weather?" }],
        "tools": [{
            "name": "get_weather",
            "description": "look up the weather",
            "parameters": { "type": "object", "properties": {} },
        }],
        "toolChoice": { "type": "auto" },
    }));

    let body = endpoint.completion().expect("a request").body;
    assert!(
        body.contains("get_weather"),
        "the offered tool must be on the wire: {body}"
    );
}

/// **The control for the two above.** A turn that offers nothing must put no
/// `tools` key on the wire — GATE M FINDING 6 recorded a profile that rejects a
/// request carrying `tools` even with `toolChoice: none`, so an always-present
/// empty catalogue would be a real defect.
#[test]
fn a_turn_that_offers_nothing_puts_no_tools_and_no_image_on_the_wire() {
    let endpoint = FixtureEndpoint::start();
    let home = temp_home();
    let app = RunningApp::start(home.path());
    app.configure_endpoint("my-box", &endpoint.base_url);

    app.send_turn(turn("my-box", "just a sentence"));

    let body = endpoint.completion().expect("a request").body;
    assert!(
        !body.contains("\"tools\""),
        "an ordinary turn must not carry a tool catalogue: {body}"
    );
    assert!(
        !body.contains("image_url"),
        "an ordinary turn must not carry image content: {body}"
    );
}

/* ========================================================================== */
/* 4 — persistence: the transcript survives the process, not just the tree    */
/* ========================================================================== */

/// A turn is written through the shipping transcript commands and is still
/// there after the whole application is torn down and rebuilt — a **cold
/// start**, against a database file on disk.
///
/// In-memory state that survives a re-render but not a restart is not
/// persistence, so the restart is the assertion that matters.
#[test]
fn a_turn_written_through_the_shipping_commands_survives_a_cold_restart() {
    let endpoint = FixtureEndpoint::start();
    let home = temp_home();

    let conversation_id = {
        let app = RunningApp::start(home.path());
        app.configure_endpoint("my-box", &endpoint.base_url);

        let conversation = app.ok(
            "store_create_conversation",
            json!({ "title": "the one that must survive" }),
        );
        let id = conversation
            .pointer("/conversation/id")
            .and_then(Value::as_str)
            .expect("a conversation id")
            .to_owned();

        app.ok(
            "store_append_message",
            json!({
                "conversationId": id,
                "role": "user",
                "parts": [{ "kind": "text", "text": "what is 17 times 23?" }],
            }),
        );

        let events = app.send_turn(turn("my-box", "what is 17 times 23?"));
        let answer = deltas(&events, "textDelta");
        let reasoning = deltas(&events, "reasoningDelta");
        app.ok(
            "store_append_message",
            json!({
                "conversationId": id,
                "role": "assistant",
                "parts": [
                    { "kind": "reasoning", "text": reasoning },
                    { "kind": "text", "text": answer },
                ],
            }),
        );

        // Still there within the session — the weaker claim, asserted first so
        // the restart assertion below is a strictly stronger statement.
        let within = app.ok("store_list_messages", json!({ "conversationId": id }));
        assert_eq!(
            within
                .get("messages")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(2)
        );
        id
    };

    // Everything in memory is gone. A new application, a new `AppState`, a new
    // store handle — the same directory.
    let restarted = RunningApp::start(home.path());
    let after = restarted.ok(
        "store_list_messages",
        json!({ "conversationId": conversation_id }),
    );
    let messages = after
        .get("messages")
        .and_then(Value::as_array)
        .expect("a transcript")
        .clone();

    assert_eq!(messages.len(), 2, "both messages must survive the restart");
    assert_eq!(messages[0].get("role"), Some(&json!("user")));
    let text: String = messages[1]
        .get("parts")
        .and_then(Value::as_array)
        .expect("parts")
        .iter()
        .filter(|part| part.get("kind").and_then(Value::as_str) == Some("text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect();
    assert_eq!(text, "three hundred and ninety one");

    // And the conversation is findable from a cold start, not only by id.
    let listed = restarted.ok("store_list_conversations", json!({}));
    assert!(
        listed.to_string().contains("the one that must survive"),
        "the conversation must be listed after a restart: {listed}"
    );
}

/// **The control for persistence.** Nothing is readable before anything is
/// written — so the test above cannot be passing on a store that answers
/// every query with the same canned transcript.
#[test]
fn nothing_is_readable_before_anything_is_written() {
    let home = temp_home();
    let app = RunningApp::start(home.path());

    let conversation = app.ok("store_create_conversation", json!({ "title": "empty" }));
    let id = conversation
        .pointer("/conversation/id")
        .and_then(Value::as_str)
        .unwrap()
        .to_owned();

    let listed = app.ok("store_list_messages", json!({ "conversationId": id }));
    assert_eq!(
        listed
            .get("messages")
            .and_then(Value::as_array)
            .map(Vec::len),
        Some(0),
        "a fresh conversation must have an empty transcript"
    );
}

/// The database is a real file in the real application-data directory — not an
/// in-memory store that a restart would silently recreate.
#[test]
fn the_assembled_app_writes_a_database_file_to_the_application_data_directory() {
    let home = temp_home();
    let app = RunningApp::start(home.path());

    let database = app.data_dir().join(vela_store::DATABASE_FILE_NAME);
    assert!(
        database.is_file(),
        "the assembled app must open a database on disk at {}",
        database.display()
    );
    assert!(
        database.starts_with(home.path()),
        "the database must live under the application-data directory"
    );
}

/* ========================================================================== */
/* 5 — the skill store, through the real command                              */
/* ========================================================================== */

/// A skill file on the real disk, parsed by the real command, dispatched
/// through the real `invoke_handler`.
///
/// This is the whole of what `skills_list` and `skills_read` claim, driven end
/// to end: the store directory exists because `setup` made it, a skill file
/// written into it is parsed by `vela_skills::SkillStore`, the listing carries the
/// description and **not** the body, the body arrives only when a second
/// command asks for one skill by name, and a traversal is refused by the host
/// rather than by anything in the renderer.
///
/// The fixture skill is named after this process and removed at the end,
/// because on Windows `app_data_dir()` is the user's own `%APPDATA%` and this
/// test has no business leaving a skill in it.
#[test]
fn a_skill_on_disk_is_listed_and_read_through_the_assembled_app() {
    let home = temp_home();
    let app = RunningApp::start(home.path());

    let store = app.data_dir().join(vela_skills::SKILL_STORE_DIRECTORY_NAME);
    assert!(
        store.is_dir(),
        "the store must exist before any command reads it, and `setup` is what makes that true: {}",
        store.display()
    );

    let name = format!("gate-m-fixture-{}", std::process::id());
    let directory = store.join(&name);
    std::fs::create_dir_all(&directory).expect("a fixture skill directory");
    std::fs::write(
        directory.join(vela_skills::SKILL_FILE_NAME),
        format!(
            "---\nname: {name}\ndescription: A fixture skill. Use when proving the wiring.\n---\n\n# Fixture\n\nOnly a read returns this sentence.\n"
        ),
    )
    .expect("a fixture skill file");

    let listed = app.ok("skills_list", json!({}));
    let entries = listed
        .get("skills")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mine = entries
        .iter()
        .find(|entry| entry.get("directory").and_then(Value::as_str) == Some(name.as_str()))
        .unwrap_or_else(|| panic!("the fixture skill was not listed; saw {entries:?}"));

    assert_eq!(mine.get("kind").and_then(Value::as_str), Some("skill"));
    assert_eq!(
        mine.get("description").and_then(Value::as_str),
        Some("A fixture skill. Use when proving the wiring.")
    );
    assert!(
        !listed
            .to_string()
            .contains("Only a read returns this sentence"),
        "the first level of disclosure carried the body: {listed}"
    );

    let read = app.ok("skills_read", json!({ "name": name }));
    assert_eq!(read.get("kind").and_then(Value::as_str), Some("skill"));
    assert!(
        read.get("body")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains("Only a read returns this sentence"),
        "the second level did not carry the body: {read}"
    );

    let refused = app.err("skills_read", json!({ "name": "../escape" }));
    assert_eq!(
        refused.get("code").and_then(Value::as_str),
        Some("INVALID_PAYLOAD"),
        "a traversal must be refused by the host: {refused}"
    );

    std::fs::remove_dir_all(&directory).expect("the fixture skill is removed");
}
