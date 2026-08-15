//! **The local endpoint, switched from the renderer's own IPC call, against a
//! real socket.**
//!
//! Every other test of this feature is about a decision: which configurations
//! are refused, what a policy resolves to, what a report says. This file is
//! about whether a port opens and closes, and it answers that by asking the
//! operating system rather than the object under test — a `TcpStream` connect,
//! and a hand-written HTTP request whose bytes are on the wire.
//!
//! # What this file settles, and what it does not
//!
//! `src-tauri/src/endpoint_host.rs` used to explain the absence of a settings
//! surface by saying a command would drag dialect vocabulary into the renderer.
//! It would not, and the one reason that could have survived — that the
//! endpoint has to be decided before a window exists — is refuted **here**,
//! measurably: `vela_lib::configure` is built on the mock runtime, `setup` runs
//! (which is where the environment path decides), the main window from
//! `tauri.conf.json` is up, and `endpoint_enable` is then invoked *from that
//! window's own origin*, in the renderer's own envelope, through the assembled
//! `invoke_handler`. Nothing about the endpoint needs to precede a window.
//!
//! What it does **not** settle is the click. Nothing here presses a button in a
//! real window; that is the browser-driven harness's job, and until it lands
//! the renderer half of this feature is unverified by anything except jsdom.
//!
//! # Honesty (`docs/architecture/conventions.md` §10)
//!
//! The credential store is `MemoryStore`, and the endpoint Vela is configured
//! to serve is [`Upstream`] — twenty lines of `TcpListener` that answer one
//! path with one name. So `GET /v1/models` really does cross two sockets and
//! come back with what the upstream said, which is what makes the transcript
//! evidence about routing, the bearer check and the JSON shape. **It is not
//! evidence about a model**: nothing here generates anything, and a turn's
//! content comes back empty because the fixture never answers `/chat/completions`.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{mock_builder, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{Manager, WebviewWindow};

/* ========================================================================== */
/* the assembled app, driven the way the renderer drives it                   */
/* ========================================================================== */

/// `setup` resolves the app-data directory through `XDG_DATA_HOME`, which is
/// process-global. Same reason `tests/handler_binding.rs` has one.
fn build_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct App {
    _app: tauri::App<tauri::test::MockRuntime>,
    webview: WebviewWindow<tauri::test::MockRuntime>,
    _home: tempfile::TempDir,
}

impl App {
    fn start() -> Self {
        let home = tempfile::tempdir().expect("a temporary data home");
        let app = {
            let _guard = build_lock();
            std::env::set_var("XDG_DATA_HOME", home.path());
            // Nothing must turn the endpoint on behind this test's back: the
            // startup path reads the process environment, and a developer with
            // `VELA_LOCAL_ENDPOINT` set would otherwise be measuring their own
            // shell. Cleared rather than trusted.
            for name in [
                "VELA_LOCAL_ENDPOINT",
                "VELA_LOCAL_ENDPOINT_KEY",
                "VELA_LOCAL_ENDPOINT_PROVIDER",
                "VELA_LOCAL_ENDPOINT_TOOLS",
                "VELA_LOCAL_ENDPOINT_TOOLS_CONFIRM",
            ] {
                std::env::remove_var(name);
            }
            // See `handler_binding::Probe::start`: `$XDG_DATA_HOME` only moves
            // half of `app_data_dir()`, and on Windows the other half is a
            // known folder no variable redirects. An absolute identifier
            // replaces the base outright.
            let mut context = tauri::generate_context!();
            context.config_mut().identifier =
                home.path().join("app-data").to_string_lossy().into_owned();
            let mut app = vela_lib::configure(mock_builder())
                .build(context)
                .expect("the shipping composition root must assemble");
            // `build` does not run `setup`; one event-loop iteration does.
            #[allow(deprecated)]
            app.run_iteration(|_, _| {});
            app
        };
        let webview = app
            .get_webview_window("main")
            .expect("the main window from tauri.conf.json");
        Self {
            _app: app,
            webview,
            _home: home,
        }
    }

    /// Invokes one command exactly as the renderer would: the app's own origin,
    /// one argument named `payload`.
    fn invoke(&self, command: &str, payload: Value) -> Result<Value, String> {
        let response = tauri::test::get_ipc_response(
            &self.webview,
            InvokeRequest {
                cmd: command.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: self
                    .webview
                    .url()
                    .expect("the assembled app's webview must report its own URL"),
                body: InvokeBody::Json(json!({ "payload": payload })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        );
        match response {
            Ok(InvokeResponseBody::Json(body)) => {
                Ok(serde_json::from_str(&body).expect("a command answers JSON"))
            }
            Ok(InvokeResponseBody::Raw(_)) => panic!("{command} answered raw bytes"),
            Err(error) => Err(serde_json::to_value(&error)
                .map(|value| value.to_string())
                .unwrap_or_else(|_| "unserialisable rejection".to_owned())),
        }
    }

    fn ok(&self, command: &str, payload: Value) -> Value {
        self.invoke(command, payload)
            .unwrap_or_else(|error| panic!("`{command}` was refused: {error}"))
    }
}

/* ========================================================================== */
/* the socket probe — the operating system's answer, not the app's            */
/* ========================================================================== */

/// A loopback address for `host:port`, so a wildcard bind is probed at an
/// address a client can actually connect to.
fn probe_address(bound: &str) -> SocketAddr {
    let port = bound
        .rsplit(':')
        .next()
        .and_then(|port| port.parse::<u16>().ok())
        .unwrap_or_else(|| panic!("`{bound}` is not host:port"));
    SocketAddr::from(([127, 0, 0, 1], port))
}

/// Is anything listening? Not "does the app think so".
///
/// The `println!` is captured unless `cargo test -- --nocapture`, and it is
/// there so that a run can be read as a transcript rather than as a verdict: a
/// green test says the assertions held, and the transcript says what the
/// operating system answered at each step.
fn port_answers(bound: &str) -> bool {
    let open =
        TcpStream::connect_timeout(&probe_address(bound), Duration::from_millis(500)).is_ok();
    println!(
        "  probe {bound} -> {}",
        if open { "OPEN" } else { "closed" }
    );
    open
}

/// One HTTP/1.1 request, written by hand and read back as `(status line, body)`.
///
/// A real client, not a mock: the endpoint's own connection handling — the
/// request line, the header block, `Connection: close` — is on the wire here.
fn http(bound: &str, request: &str) -> (String, String) {
    let mut stream = TcpStream::connect_timeout(&probe_address(bound), Duration::from_secs(2))
        .unwrap_or_else(|error| panic!("nothing is listening on {bound}: {error}"));
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("a read timeout");
    stream
        .write_all(request.as_bytes())
        .expect("the request must be writable");
    stream.flush().expect("the request must flush");

    let mut raw = String::new();
    if let Err(error) = stream.read_to_string(&mut raw) {
        panic!("the endpoint must answer ({error}); read so far: {raw:?}; sent: {request:?}");
    }
    let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((raw.as_str(), ""));
    let status = head.lines().next().unwrap_or("").to_owned();
    println!(
        "  > {}\n  < {status}  {body}",
        request.lines().nth(2).unwrap_or("").trim()
    );
    (status, body.to_owned())
}

fn get_models(bound: &str, authorization: &str) -> (String, String) {
    http(
        bound,
        &format!(
            "GET /v1/models HTTP/1.1\r\nHost: {bound}\r\n{authorization}\r\nConnection: close\r\n\r\n"
        ),
    )
}

const KEY: &str = "sk-vela-gate-key";

/* ========================================================================== */
/* the upstream the endpoint passes turns to                                  */
/* ========================================================================== */

/// A loopback server standing in for the model runtime the user configured.
///
/// It exists so `GET /v1/models` has a real round trip behind it: the request
/// arrives at Vela's endpoint, Vela asks the configured provider over a second
/// real socket, and the name below comes back out the front. Pointing the
/// provider at a dead port instead would prove only that Vela handles a
/// failure, and on this machine a closed port is not even reliably fast — the
/// first draft of this file used `127.0.0.1:9` and the connect did not refuse
/// inside five seconds.
///
/// **This is a fixture, not a model.** It answers one path with one name.
struct Upstream {
    address: SocketAddr,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl Upstream {
    fn start() -> Self {
        let listener =
            std::net::TcpListener::bind("127.0.0.1:0").expect("the fixture must bind loopback");
        let address = listener
            .local_addr()
            .expect("a bound fixture has an address");
        listener
            .set_nonblocking(true)
            .expect("the fixture polls so it can be stopped");
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

        let flag = std::sync::Arc::clone(&stop);
        std::thread::spawn(move || {
            while !flag.load(std::sync::atomic::Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let mut head = [0u8; 2048];
                        let _ = stream.read(&mut head);
                        let body = r#"{"data":[{"id":"fixture-model"}]}"#;
                        let _ = stream.write_all(
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                                 Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                                body.len()
                            )
                            .as_bytes(),
                        );
                        let _ = stream.flush();
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => break,
                }
            }
        });
        Self { address, stop }
    }
}

impl Drop for Upstream {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Configures one endpoint through the real `settings_put_provider`, so the id
/// the local endpoint serves is one the application actually knows and the
/// address behind it actually answers.
fn configure_provider(app: &App, upstream: &Upstream) {
    app.ok(
        "settings_put_provider",
        json!({
            "id": "study-box",
            "displayName": "The workstation in the study",
            "kind": "local",
            "baseUrl": format!("http://{}/v1", upstream.address),
        }),
    );
}

fn enable(app: &App, bind: &str) -> Value {
    app.ok(
        "endpoint_enable",
        json!({ "bind": bind, "key": KEY, "providerId": "study-box" }),
    )
}

/* ========================================================================== */
/* 1 — off, on, off, on, off: twice, with no restart                          */
/* ========================================================================== */

/// **The acceptance, measured.**
///
/// The renderer's own command turns the port on and off twice, and every claim
/// is checked with a socket connect rather than with the report. The second
/// cycle is the one that matters: the *first* bind of a fresh port always
/// succeeds, and it is rebinding the address the previous listener held that
/// fails if stopping is only a signal.
#[test]
fn the_endpoint_toggles_off_and_on_twice_from_the_renderers_own_ipc_call() {
    let upstream = Upstream::start();
    let app = App::start();
    configure_provider(&app, &upstream);

    let start = app.ok("endpoint_status", json!({}));
    assert_eq!(start["state"], "off", "the endpoint must be off at launch");
    assert!(start["address"].is_null());

    let first = enable(&app, "127.0.0.1:0");
    assert_eq!(first["state"], "serving", "{first}");
    assert_eq!(first["providerId"], "study-box");
    assert_eq!(first["toolsEnabled"], true);
    assert_eq!(first["toolPolicy"], "loopback-default");
    let bound = first["address"]
        .as_str()
        .expect("a serving endpoint reports its address")
        .to_owned();
    assert!(
        !bound.ends_with(":0"),
        "the report must carry the port the OS chose, got {bound}"
    );
    assert!(port_answers(&bound), "the port must be open after enable");

    for cycle in 1..=2 {
        println!("cycle {cycle}: endpoint_disable");
        let off = app.ok("endpoint_disable", json!({}));
        assert_eq!(off["state"], "off", "cycle {cycle}");
        assert!(
            !port_answers(&bound),
            "cycle {cycle}: {bound} must stop answering after disable"
        );

        println!("cycle {cycle}: endpoint_enable {bound}");
        let on = enable(&app, &bound);
        assert_eq!(on["state"], "serving", "cycle {cycle}: {on}");
        assert_eq!(
            on["address"], bound,
            "cycle {cycle}: the same address must be rebindable"
        );
        assert!(
            port_answers(&bound),
            "cycle {cycle}: {bound} must answer again"
        );
    }

    // Left serving on purpose, so the transcript below is taken against a port
    // that survived two full cycles.
    //
    // **The undocumented gotcha, pinned where a reader will meet it.** Only
    // `Authorization: Bearer` is accepted. A stock client configured with an
    // API key sends `x-api-key` and gets a 401 with no hint as to why, which is
    // why `docs/local-endpoint.md` states it as a numbered gotcha rather than
    // leaving it in a Rust test name.
    let (status, _) = get_models(&bound, &format!("x-api-key: {KEY}"));
    assert!(
        status.starts_with("HTTP/1.1 401"),
        "x-api-key must not be a second way in, got {status}"
    );
    let (status, _) = get_models(&bound, "Authorization: Bearer wrong");
    assert!(status.starts_with("HTTP/1.1 401"), "{status}");
    let (status, _) = get_models(&bound, "Connection: close");
    assert!(status.starts_with("HTTP/1.1 401"), "{status}");

    let (status, body) = get_models(&bound, &format!("Authorization: Bearer {KEY}"));
    assert!(status.starts_with("HTTP/1.1 200"), "{status}");
    let listed: Value = serde_json::from_str(&body).expect("the model list must be JSON");
    assert_eq!(listed["object"], "list");
    assert_eq!(
        listed["data"][0]["id"], "fixture-model",
        "the name must have come from the configured upstream, through Vela, and back out: {body}"
    );

    app.ok("endpoint_disable", json!({}));
    assert!(!port_answers(&bound));
}

/* ========================================================================== */
/* 2 — the security rule, across a rebind                                     */
/* ========================================================================== */

/// **A rebind re-resolves the tool policy from the new listener.**
///
/// Loopback with tools on, then the wildcard in the same session. Tools must go
/// off, the reason must change, and the address the loopback listener held must
/// stop answering — a rebind that widened exposure while leaving the old
/// listener and its policy standing would be the exact defect
/// `vela_endpoint::policy` exists to prevent.
#[test]
fn a_rebind_to_the_wildcard_re_resolves_the_tool_policy_from_the_new_listener() {
    let upstream = Upstream::start();
    let app = App::start();
    configure_provider(&app, &upstream);

    let loopback = enable(&app, "127.0.0.1:0");
    assert_eq!(loopback["toolsEnabled"], true);
    assert_eq!(loopback["toolPolicy"], "loopback-default");
    assert_eq!(loopback["loopback"], true);
    let first = loopback["address"].as_str().expect("an address").to_owned();
    assert!(port_answers(&first));

    let exposed = enable(&app, "0.0.0.0:0");
    assert_eq!(exposed["state"], "serving", "{exposed}");
    assert_eq!(
        exposed["toolsEnabled"], false,
        "a wildcard bind must not inherit the previous bind's tool policy"
    );
    assert_eq!(exposed["toolPolicy"], "exposed-default");
    assert_eq!(exposed["loopback"], false);

    let second = exposed["address"].as_str().expect("an address").to_owned();
    assert_ne!(
        second, first,
        "the report must describe the listener that is up"
    );
    assert!(
        !port_answers(&first),
        "the listener that was replaced must be gone, not merely unreported"
    );
    assert!(
        port_answers(&second),
        "the wildcard listener must be reachable on loopback too"
    );
    let (status, _) = get_models(&second, &format!("Authorization: Bearer {KEY}"));
    assert!(status.starts_with("HTTP/1.1 200"), "{status}");

    // The control, and the reason the assertions above are not satisfied by an
    // `enable` that simply always answers "exposed": going back narrows it.
    let back = enable(&app, "127.0.0.1:0");
    assert_eq!(back["toolsEnabled"], true);
    assert_eq!(back["toolPolicy"], "loopback-default");
    assert!(!port_answers(&second));

    app.ok("endpoint_disable", json!({}));
}
