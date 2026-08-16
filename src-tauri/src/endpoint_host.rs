//! **The host's half of the dual local endpoint.**
//!
//! `crates/vela-endpoint` knows how to speak two dialects on one port. It does
//! not know what Vela is configured with, and it has no runtime. This module is
//! the join: it turns one of the user's configured providers into a
//! [`Brain`](vela_endpoint::Brain), and it decides — from the process
//! environment — whether to open a port at all.
//!
//! # Off unless asked, and off if asked badly
//!
//! `docs/references/unsloth-studio.md`'s "what Vela should not take" is
//! explicit that a local HTTP server is not something a desktop chat client
//! should run by default, and that if one is added it "should adopt Unsloth's
//! bind-address-gated tool policy from day one rather than defaulting open".
//! So:
//!
//!  - **No `VELA_LOCAL_ENDPOINT` means no listener.** Not a degraded one, not
//!    one on a default port. [`Decision::Off`], and nothing binds.
//!  - **A bind address with no key is a refusal, not a fallback.** An endpoint
//!    that served Vela's brain to anything that could reach the port would be
//!    the whole hazard the tool policy exists to bound.
//!  - **The tool policy comes from the address that was bound**, inside
//!    `vela_endpoint::server::serve`. Nothing here can widen it; the only thing
//!    this module contributes is the operator's `--enable-tools` /
//!    `--disable-tools` equivalent, and the confirmation an exposed bind needs.
//!
//! # Two ways in, and a retracted reason for there having been one
//!
//! There are two: the five environment variables below, read once at startup by
//! [`EndpointControl::start_if_configured`]; and [`EndpointControl::enable`] /
//! [`EndpointControl::disable`], which `ipc::endpoint` calls at any time
//! afterwards. The second did not exist, and this module used to explain its
//! absence like this:
//!
//! > Because a settings row needs a command, a command needs a renderer type,
//! > and the renderer would then be holding the words "anthropic" and "openai"
//! > — which `src/platform/no-provider-leak.test.ts` exists to keep out of it.
//!
//! **That inference was false, and it cost the feature.** Three checks, each
//! re-derivable from this tree:
//!
//!  1. **The configuration has no dialect in it.** [`Wanted`] is a bind
//!     address, a key, a provider id and a [`ToolRequest`]. `ipc::endpoint`'s
//!     request and response types are those four fields and what the listener
//!     resolved from them; neither dialect is nameable in either.
//!  2. **The port serves both dialects at once.** `vela_endpoint::route`
//!     dispatches on path, on one listener, under one key — so there is no
//!     dialect for a settings row to *choose*, and nothing to name even if a
//!     row wanted to.
//!  3. **The renderer already does exactly this.** `EndpointsPanel.tsx`
//!     configures providers by opaque id and runs under
//!     `no-provider-leak.test.ts` unchanged; `src/features/models` is one of
//!     the directories that test scans most strictly.
//!
//! The one reason that *would* have survived inspection — that the endpoint has
//! to be decided before a window exists — does not hold either, and is measured
//! rather than asserted: `tests/endpoint_runtime_control.rs` drives
//! `endpoint_enable` and `endpoint_disable` through the assembled app's own
//! `invoke_handler`, from the renderer's origin, **after** the main window is
//! up, and probes the socket between calls. Nothing here needs a window and
//! nothing here needs to precede one; `serve` spawns plain OS threads and takes
//! its brain from [`ProviderHost`], which is already `manage`d.
//!
//! # What is still unbuilt, plainly
//!
//! **Nothing persists.** A configuration entered in the settings surface lives
//! in this process and is gone at the next launch, which is why the environment
//! path is still here and unchanged. Storing it would need a settings row in
//! `vela-settings`/`vela-store` for the address, the provider id and the tool
//! flag, and — the part that is a decision rather than a schema — a home for
//! the bearer key. `secrets_set` writes to the OS keychain under a *provider*
//! id, so either the endpoint gets its own `SecretRef` namespace or the key
//! goes in the database in plaintext, and the second is not an option. Until
//! that is decided, "off at every launch unless the environment says otherwise"
//! is the honest default and matches what the tool policy already assumes.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex, MutexGuard};

use vela_endpoint::brain::Brain;
use vela_endpoint::policy::ToolRequest;
use vela_endpoint::server::{serve, EndpointConfig, ServerHandle};
use vela_providers::model::{ChatRequest, ChatResponse};
use vela_providers::{EventSink, ProviderError, RequestContext};

use crate::provider_host::ProviderHost;

/// Where configuration is read from. A trait so the decision below is testable
/// without mutating the process environment, which is global state a parallel
/// test runner shares.
pub trait EnvSource {
    fn get(&self, name: &str) -> Option<String>;
}

/// The real process environment.
pub struct ProcessEnv;

impl EnvSource for ProcessEnv {
    fn get(&self, name: &str) -> Option<String> {
        std::env::var(name).ok()
    }
}

impl EnvSource for std::collections::BTreeMap<&str, &str> {
    fn get(&self, name: &str) -> Option<String> {
        std::collections::BTreeMap::get(self, name).map(|value| (*value).to_string())
    }
}

/// Why the endpoint is not serving.
///
/// A closed set. Each is printed at startup so an operator who set one variable
/// and forgot another is told which, rather than left with a port that never
/// opened and no reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// `VELA_LOCAL_ENDPOINT` was not a `host:port`.
    BindAddressUnparseable,
    /// No `VELA_LOCAL_ENDPOINT_KEY`. Fails closed.
    NoKey,
    /// No `VELA_LOCAL_ENDPOINT_PROVIDER`. There is no "the" provider to serve:
    /// a user may have several configured, and picking one for them would mean
    /// their agent silently talked to an endpoint they did not choose.
    NoProvider,
}

impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::BindAddressUnparseable => "bind-address-unparseable",
            Self::NoKey => "no-key",
            Self::NoProvider => "no-provider",
        }
    }
}

/// What the environment asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Wanted {
    pub bind: SocketAddr,
    pub api_key: String,
    pub provider_id: String,
    pub tools: ToolRequest,
}

/// The decision, before anything is bound.
///
/// Separated from [`EndpointControl::start_if_configured`] so the rules above
/// are testable without opening a socket — the same split `ProviderHost::sync`
/// uses, and for the same reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Nothing asked for an endpoint. The ordinary case.
    Off,
    Refused(Refusal),
    Start(Wanted),
}

pub const BIND_VAR: &str = "VELA_LOCAL_ENDPOINT";
pub const KEY_VAR: &str = "VELA_LOCAL_ENDPOINT_KEY";
pub const PROVIDER_VAR: &str = "VELA_LOCAL_ENDPOINT_PROVIDER";
pub const TOOLS_VAR: &str = "VELA_LOCAL_ENDPOINT_TOOLS";
/// The y/N prompt the reference shows before enabling tools on an exposed bind,
/// as a variable — a startup path has no terminal to prompt at.
pub const TOOLS_CONFIRM_VAR: &str = "VELA_LOCAL_ENDPOINT_TOOLS_CONFIRM";

pub fn decide(env: &dyn EnvSource) -> Decision {
    let Some(bind) = env.get(BIND_VAR).filter(|value| !value.trim().is_empty()) else {
        return Decision::Off;
    };
    let Ok(bind) = bind.trim().parse::<SocketAddr>() else {
        return Decision::Refused(Refusal::BindAddressUnparseable);
    };
    let Some(api_key) = env.get(KEY_VAR).filter(|value| !value.trim().is_empty()) else {
        return Decision::Refused(Refusal::NoKey);
    };
    let Some(provider_id) = env
        .get(PROVIDER_VAR)
        .filter(|value| !value.trim().is_empty())
    else {
        return Decision::Refused(Refusal::NoProvider);
    };

    let confirmed = env
        .get(TOOLS_CONFIRM_VAR)
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("yes"));
    let tools = match env.get(TOOLS_VAR).as_deref().map(str::trim) {
        Some("on") => ToolRequest::Enable { confirmed },
        Some("off") => ToolRequest::Disable,
        // Anything else — including a typo — is "no flag given", which lets the
        // bind address decide. A typo must not be able to turn tools on.
        _ => ToolRequest::Default,
    };

    Decision::Start(Wanted {
        bind,
        api_key,
        provider_id: provider_id.trim().to_string(),
        tools,
    })
}

/// One of the user's configured providers, as the endpoint crate needs to see
/// it.
///
/// Blocking on the async runtime is why this lives here and not in
/// `crates/vela-endpoint`:
/// `Provider` is async and the runtime belongs to the host process, exactly as
/// `vela-providers`' own manifest says of `tokio`'s `rt` feature. The endpoint
/// crate stays runtime-free and its connection threads block, which is what
/// they would be doing anyway.
struct ProviderBrain {
    providers: Arc<ProviderHost>,
    provider_id: String,
}

impl Brain for ProviderBrain {
    /// Answers `GET /v1/models` by asking the configured endpoint what it
    /// serves — the same question `models_list` asks.
    ///
    /// An endpoint that cannot enumerate answers `CapabilityUnsupported`, which
    /// is a normal state and not an error; the list is empty and a client may
    /// still send a turn naming whatever model it likes. An empty list is
    /// therefore never evidence that the provider is broken.
    fn models(&self) -> Vec<String> {
        let Some(provider) = self.providers.get(&self.provider_id) else {
            return Vec::new();
        };
        let context = RequestContext::new();
        match tauri::async_runtime::block_on(provider.list_models(&context)) {
            Ok(models) => models.into_iter().map(|model| model.id).collect(),
            Err(_) => Vec::new(),
        }
    }

    fn stream(
        &self,
        request: ChatRequest,
        sink: &mut dyn EventSink,
    ) -> Result<ChatResponse, ProviderError> {
        // Resolved per turn rather than held, so that a provider the user edits
        // or deletes while the endpoint is up takes effect on the next turn
        // instead of leaving a stale object answering — the same rule
        // `ProviderHost` documents for the UI's own path.
        let Some(provider) = self.providers.get(&self.provider_id) else {
            return Err(ProviderError::Transport {
                failure: vela_providers::TransportFailure::Connect,
                diagnosis: vela_providers::diagnostic::Diagnosis::local(
                    vela_providers::diagnostic::Cause::NoProviderConfigured,
                ),
            });
        };
        let context = RequestContext::new();
        tauri::async_runtime::block_on(provider.stream(request, sink, &context))
    }
}

/// What the endpoint is doing right now.
///
/// Held inside [`EndpointControl`] rather than `manage`d directly, because the
/// application needs to be able to *change* it: `ServerHandle`'s `Drop` is what
/// stops the listener, and a value nothing can replace can only be dropped when
/// the process ends.
pub enum EndpointState {
    Off,
    Refused(Refusal),
    /// The bind itself failed — a port already in use, usually.
    BindFailed(String),
    Serving {
        handle: ServerHandle,
        /// Which configured provider answers turns here. Carried beside the
        /// handle because the endpoint crate has no idea; it holds a `Brain`.
        provider_id: String,
    },
}

impl EndpointState {
    /// One line for stderr at startup. Says what happened and, when serving,
    /// what the tool policy resolved to — because "my agent's tool calls
    /// vanished" is otherwise an unexplainable symptom.
    pub fn summary(&self) -> String {
        match self {
            Self::Off => "vela: local endpoint off".to_string(),
            Self::Refused(refusal) => {
                format!("vela: local endpoint not started ({})", refusal.code())
            }
            Self::BindFailed(error) => format!("vela: local endpoint could not bind: {error}"),
            Self::Serving { handle, .. } => format!(
                "vela: local endpoint on {} (tools {}, {})",
                handle.address(),
                if handle.policy().tools_enabled() {
                    "on"
                } else {
                    "off"
                },
                handle.policy().reason().code()
            ),
        }
    }
}

/// Which arm of [`EndpointState`] a report describes. A closed set, so a caller
/// cannot invent a fifth state to render.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunState {
    Off,
    Refused,
    BindFailed,
    Serving,
}

/// **What a caller may learn about the endpoint.**
///
/// Everything here is read back off the *live* [`ServerHandle`] — the address
/// the listener actually bound and the policy that listener resolved — never
/// from what was asked for. That is not tidiness: [`ToolPolicy`] is derived
/// from `listener.local_addr()` inside `serve`, and a report assembled from the
/// request instead would be able to say "loopback, tools on" about a wildcard
/// bind. See [`EndpointControl::enable`].
///
/// [`ToolPolicy`]: vela_endpoint::ToolPolicy
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndpointReport {
    pub state: RunState,
    /// `host:port`, as bound. `None` unless serving.
    pub address: Option<String>,
    pub provider_id: Option<String>,
    /// Whether tools reach the brain. Meaningless unless serving, and `false`
    /// there, which is the safe reading of "not serving".
    pub tools_enabled: bool,
    /// `ToolPolicyReason::code`, so the surface that renders it owns the
    /// wording — the same rule `Concern` and `Refusal` follow.
    pub policy_reason: Option<&'static str>,
    /// Whether the bound address is reachable only from this machine.
    pub loopback: bool,
    /// The refusal code or the bind error, for the two states that have one.
    pub detail: Option<String>,
}

impl EndpointReport {
    fn of(state: &EndpointState) -> Self {
        let base = Self {
            state: RunState::Off,
            address: None,
            provider_id: None,
            tools_enabled: false,
            policy_reason: None,
            loopback: false,
            detail: None,
        };
        match state {
            EndpointState::Off => base,
            EndpointState::Refused(refusal) => Self {
                state: RunState::Refused,
                detail: Some(refusal.code().to_string()),
                ..base
            },
            EndpointState::BindFailed(error) => Self {
                state: RunState::BindFailed,
                detail: Some(error.clone()),
                ..base
            },
            EndpointState::Serving {
                handle,
                provider_id,
            } => {
                let policy = handle.policy();
                Self {
                    state: RunState::Serving,
                    address: Some(handle.address().to_string()),
                    provider_id: Some(provider_id.clone()),
                    tools_enabled: policy.tools_enabled(),
                    policy_reason: Some(policy.reason().code()),
                    loopback: policy.scope().is_loopback(),
                    ..base
                }
            }
        }
    }

    /// The reason code as a value rather than a string, for tests that would
    /// otherwise assert against a spelling.
    #[cfg(test)]
    fn reason_is(&self, reason: vela_endpoint::policy::ToolPolicyReason) -> bool {
        self.policy_reason == Some(reason.code())
    }
}

/// Binds, or records why it did not. The one place a listener is opened.
fn bind(providers: &Arc<ProviderHost>, wanted: Wanted) -> EndpointState {
    let provider_id = wanted.provider_id;
    let brain: Arc<dyn Brain> = Arc::new(ProviderBrain {
        providers: Arc::clone(providers),
        provider_id: provider_id.clone(),
    });
    match serve(
        EndpointConfig {
            bind: wanted.bind,
            api_key: wanted.api_key,
            tools: wanted.tools,
        },
        brain,
    ) {
        Ok(handle) => EndpointState::Serving {
            handle,
            provider_id,
        },
        Err(error) => EndpointState::BindFailed(error.to_string()),
    }
}

/// **The endpoint, as something that can be turned on and off.**
///
/// `manage`d by the composition root and reached by `ipc::endpoint`. One
/// `Mutex` around the whole state, because every operation here is "replace the
/// listener", which is not a thing two callers may interleave: the previous
/// socket has to be closed before the next one binds, and a second caller
/// arriving between those two steps would bind into the gap.
pub struct EndpointControl {
    providers: Arc<ProviderHost>,
    state: Mutex<EndpointState>,
}

impl EndpointControl {
    /// **The call the composition root makes.**
    ///
    /// Reads the environment, and opens a port only if it was asked to and
    /// could do so safely. Every other outcome is a state, not a panic: a
    /// desktop app that refused to launch because a port was busy would be
    /// trading a feature nobody has enabled for the whole application.
    pub fn start_if_configured(env: &dyn EnvSource, providers: Arc<ProviderHost>) -> Self {
        let state = match decide(env) {
            Decision::Off => EndpointState::Off,
            Decision::Refused(refusal) => EndpointState::Refused(refusal),
            Decision::Start(wanted) => bind(&providers, wanted),
        };
        Self {
            providers,
            state: Mutex::new(state),
        }
    }

    /// A control with no listener and no environment behind it. For tests and
    /// for any host that wants the endpoint reachable but off.
    pub fn off(providers: Arc<ProviderHost>) -> Self {
        Self {
            providers,
            state: Mutex::new(EndpointState::Off),
        }
    }

    fn lock(&self) -> MutexGuard<'_, EndpointState> {
        // A poisoned lock here means a previous caller panicked mid-replace.
        // The state is still a valid `EndpointState` — every path assigns a
        // complete one — so recovering is correct and refusing would leave the
        // endpoint permanently unswitchable.
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn summary(&self) -> String {
        self.lock().summary()
    }

    pub fn report(&self) -> EndpointReport {
        EndpointReport::of(&self.lock())
    }

    /// **Start, or rebind.** Idempotent in effect, not in mechanism: whatever
    /// was serving is stopped first, every time, and a fresh listener is
    /// opened.
    ///
    /// Two things about this function are load-bearing, and both are the
    /// security rule rather than housekeeping.
    ///
    /// **The old listener is closed before the new one binds.** The assignment
    /// to `Off` is a separate statement on purpose. Written as one
    /// (`*state = bind(...)`) the new bind is evaluated *first* and the old
    /// handle is dropped after it, so rebinding the same address fails with
    /// `AddrInUse` against the endpoint's own predecessor. `ServerHandle`'s
    /// `Drop` waits for the port to close, so by the time `bind` runs the
    /// address is free.
    ///
    /// **Nothing about the previous policy survives.** There is no early return
    /// for "already serving on a different address", and no cached
    /// `ToolPolicy`: the report is read back off the handle `serve` just
    /// returned, and `serve` resolves the policy from `listener.local_addr()`.
    /// A rebind from loopback to a wildcard therefore *cannot* keep tools on by
    /// inheritance — the widened exposure and the policy that answers for it
    /// are decided by the same call. `tests::a_rebind_resolves_the_policy_from_the_new_listener`
    /// is what makes that a measurement rather than a paragraph.
    pub fn enable(&self, wanted: Wanted) -> EndpointReport {
        let mut state = self.lock();
        *state = EndpointState::Off;
        *state = bind(&self.providers, wanted);
        EndpointReport::of(&state)
    }

    /// Stop serving. The port is closed by the time this returns — see
    /// `ServerHandle::shutdown`.
    pub fn disable(&self) -> EndpointReport {
        let mut state = self.lock();
        *state = EndpointState::Off;
        EndpointReport::of(&state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use vela_endpoint::policy::ToolPolicyReason;

    /// **The guard against this module becoming the defect it is modelled on.**
    ///
    /// Every other test here could pass while `configure()` never calls any of
    /// it — which is the exact shape of what `provider_host` was written to fix
    /// and which that module asserts the same way. `run()` needs a windowing
    /// system and cannot execute here, so the call site is asserted
    /// structurally against the real source of the composition root.
    #[test]
    fn the_real_app_builder_reaches_this_module_at_startup() {
        let source = include_str!("lib.rs");
        assert!(
            source.contains("EndpointControl::start_if_configured"),
            "configure() must decide about the local endpoint at startup, or this \
             whole module is unreachable from the shipped application"
        );
        assert!(
            source.contains("app.manage(endpoint)"),
            "the EndpointControl must be held by the app: it owns the ServerHandle, \
             whose Drop stops the listener, and it is what `ipc::endpoint` reaches"
        );
    }

    /// The second half of the same guard, for the half that is new. A control
    /// surface nothing registers is the defect this project keeps finding.
    #[test]
    fn the_three_endpoint_commands_are_registered_and_allowlisted() {
        let source = include_str!("lib.rs");
        for command in ["endpoint_disable", "endpoint_enable", "endpoint_status"] {
            assert!(
                source.contains(&format!("ipc::endpoint::{command}")),
                "`{command}` is not in generate_handler!, so the renderer cannot reach it"
            );
            assert!(
                crate::ipc::COMMAND_ALLOWLIST.contains(&command),
                "`{command}` is registered but not declared"
            );
        }
    }

    fn env(pairs: &[(&'static str, &'static str)]) -> BTreeMap<&'static str, &'static str> {
        pairs.iter().copied().collect()
    }

    #[test]
    fn nothing_configured_means_no_listener() {
        assert_eq!(decide(&env(&[])), Decision::Off);
        assert_eq!(decide(&env(&[(BIND_VAR, "   ")])), Decision::Off);
    }

    #[test]
    fn a_bind_address_without_a_key_fails_closed() {
        assert_eq!(
            decide(&env(&[(BIND_VAR, "127.0.0.1:8790")])),
            Decision::Refused(Refusal::NoKey)
        );
        assert_eq!(
            decide(&env(&[(BIND_VAR, "127.0.0.1:8790"), (KEY_VAR, "  ")])),
            Decision::Refused(Refusal::NoKey)
        );
    }

    #[test]
    fn no_provider_is_named_rather_than_one_being_picked() {
        assert_eq!(
            decide(&env(&[(BIND_VAR, "127.0.0.1:8790"), (KEY_VAR, "sk-1")])),
            Decision::Refused(Refusal::NoProvider)
        );
    }

    #[test]
    fn a_complete_configuration_starts_with_the_bind_address_deciding_tools() {
        let decision = decide(&env(&[
            (BIND_VAR, "127.0.0.1:8790"),
            (KEY_VAR, "sk-1"),
            (PROVIDER_VAR, "llamacpp"),
        ]));
        assert_eq!(
            decision,
            Decision::Start(Wanted {
                bind: "127.0.0.1:8790".parse().unwrap(),
                api_key: "sk-1".to_string(),
                provider_id: "llamacpp".to_string(),
                tools: ToolRequest::Default,
            })
        );
    }

    #[test]
    fn enabling_tools_on_an_exposed_bind_needs_the_confirmation_variable() {
        let base = [
            (BIND_VAR, "0.0.0.0:8790"),
            (KEY_VAR, "sk-1"),
            (PROVIDER_VAR, "llamacpp"),
            (TOOLS_VAR, "on"),
        ];
        let Decision::Start(wanted) = decide(&env(&base)) else {
            panic!("a complete configuration must start");
        };
        assert_eq!(wanted.tools, ToolRequest::Enable { confirmed: false });
        // …and the endpoint crate is what turns that into "tools off". Asserted
        // here so the two halves are known to compose.
        assert!(
            !vela_endpoint::ToolPolicy::for_address(&wanted.bind, wanted.tools).tools_enabled(),
            "an unconfirmed enable on an exposed bind must resolve off"
        );

        let mut confirmed = env(&base);
        confirmed.insert(TOOLS_CONFIRM_VAR, "yes");
        let Decision::Start(wanted) = decide(&confirmed) else {
            panic!("a complete configuration must start");
        };
        assert_eq!(wanted.tools, ToolRequest::Enable { confirmed: true });
    }

    #[test]
    fn a_typo_in_the_tools_variable_cannot_turn_tools_on() {
        // "no flag given" is the safe reading of an unrecognised value: the
        // bind address decides. `yes`/`true`/`ON` are not the vocabulary.
        for value in ["yes", "true", "enable", "1", ""] {
            let decision = decide(&env(&[
                (BIND_VAR, "0.0.0.0:8790"),
                (KEY_VAR, "sk-1"),
                (PROVIDER_VAR, "llamacpp"),
                (TOOLS_VAR, value),
            ]));
            let Decision::Start(wanted) = decision else {
                panic!("a complete configuration must start");
            };
            assert_eq!(wanted.tools, ToolRequest::Default, "for {value:?}");
            assert!(
                !vela_endpoint::ToolPolicy::for_address(&wanted.bind, wanted.tools).tools_enabled(),
                "an exposed bind with no recognised flag must leave tools off"
            );
        }
    }

    #[test]
    fn an_unparseable_bind_address_is_refused_rather_than_defaulted() {
        assert_eq!(
            decide(&env(&[
                (BIND_VAR, "not-an-address"),
                (KEY_VAR, "sk-1"),
                (PROVIDER_VAR, "p")
            ])),
            Decision::Refused(Refusal::BindAddressUnparseable)
        );
    }

    /// A `ProviderHost` with one configured local provider and no socket behind
    /// it. VERIFIED-BY-FAKE: `ScriptedTransport` answers nothing, so nothing
    /// below is evidence about a model.
    fn hosts() -> Arc<ProviderHost> {
        use vela_providers::http::testing::ScriptedTransport;
        use vela_secrets::MemoryStore;

        let providers = Arc::new(ProviderHost::new(
            Arc::new(MemoryStore::new()),
            Arc::new(ScriptedTransport::new(Vec::new())),
        ));
        providers
            .install(
                &vela_settings::ProviderConfig::local("llamacpp", "L", "http://127.0.0.1:9/v1")
                    .unwrap(),
            )
            .unwrap();
        providers
    }

    fn wanted(bind: &str, tools: ToolRequest) -> Wanted {
        Wanted {
            bind: bind.parse().expect("a test address must parse"),
            api_key: "sk-1".to_string(),
            provider_id: "llamacpp".to_string(),
            tools,
        }
    }

    /// Whether *anything* is listening on an address, asked of the operating
    /// system rather than of the object under test.
    ///
    /// This is the whole reason the tests below mean something: a report is
    /// what `EndpointControl` says about itself, and a successful `TcpStream`
    /// connect is what a client would find.
    fn port_answers(address: &str) -> bool {
        use std::net::TcpStream;
        use std::time::Duration;
        let address: SocketAddr = address.parse().expect("a probe address must parse");
        TcpStream::connect_timeout(&address, Duration::from_millis(500)).is_ok()
    }

    #[test]
    fn a_started_endpoint_serves_the_named_provider_and_reports_its_policy() {
        let control = EndpointControl::start_if_configured(
            &env(&[
                (BIND_VAR, "127.0.0.1:0"),
                (KEY_VAR, "sk-1"),
                (PROVIDER_VAR, "llamacpp"),
            ]),
            hosts(),
        );

        let report = control.report();
        assert_eq!(
            report.state,
            RunState::Serving,
            "a complete configuration must serve, got {}",
            control.summary()
        );
        assert_eq!(report.provider_id.as_deref(), Some("llamacpp"));
        assert!(report.tools_enabled, "loopback defaults tools on");
        assert!(report.loopback);
        assert!(report.reason_is(ToolPolicyReason::LoopbackDefault));
        assert!(control.summary().contains("tools on"));
    }

    #[test]
    fn an_endpoint_nobody_asked_for_says_so_and_binds_nothing() {
        let control = EndpointControl::start_if_configured(&env(&[]), hosts());
        assert_eq!(control.report().state, RunState::Off);
        assert_eq!(control.summary(), "vela: local endpoint off");
    }

    /// **Acceptance, in the host: off and on twice with no restart, confirmed
    /// by the operating system rather than by the report.**
    ///
    /// The second cycle is not decoration. One successful reopen is also what a
    /// handle that leaked its listener looks like, because the *first* bind of
    /// a fresh port always works; it is the second one, onto the address the
    /// previous listener held, that fails if `Drop` only signalled.
    #[test]
    fn the_endpoint_can_be_switched_off_and_on_twice_without_a_restart() {
        let control = EndpointControl::off(hosts());
        assert_eq!(control.report().state, RunState::Off);

        // Round one takes port 0 so the machine chooses; every round after that
        // reuses the address it chose, which is the property under test.
        let first = control.enable(wanted("127.0.0.1:0", ToolRequest::Default));
        let address = first.address.clone().expect("a serving endpoint has one");
        assert!(port_answers(&address), "cycle 1: the port must be open");

        for cycle in 2..=3 {
            let off = control.disable();
            assert_eq!(off.state, RunState::Off);
            assert!(
                !port_answers(&address),
                "cycle {cycle}: {address} must stop answering when disabled"
            );

            let on = control.enable(wanted(&address, ToolRequest::Default));
            assert_eq!(
                on.state,
                RunState::Serving,
                "cycle {cycle}: {address} must be rebindable, got {:?}",
                on.detail
            );
            assert_eq!(on.address.as_deref(), Some(address.as_str()));
            assert!(
                port_answers(&address),
                "cycle {cycle}: the port must reopen"
            );
        }

        drop(control);
        assert!(
            !port_answers(&address),
            "dropping the control must close the port"
        );
    }

    /// **Re-enabling the same address without disabling first.**
    ///
    /// The `Apply` path in the settings surface: the user changes the key, or
    /// the served endpoint, and leaves the address alone. `enable` is then
    /// called while a listener is already up **on the address it is about to
    /// bind**, which is the only shape in which the ordering inside `enable`
    /// is observable — `*state = bind(…)` written as one statement evaluates
    /// the new bind first and drops the old handle after it, so the endpoint
    /// collides with itself and answers `bind-failed` for an address it owns.
    ///
    /// No `disable` in between, deliberately: with one the old handle is
    /// already gone and this passes however `enable` is written.
    #[test]
    fn re_enabling_the_same_address_replaces_the_listener_rather_than_colliding_with_it() {
        let control = EndpointControl::off(hosts());
        let first = control.enable(wanted("127.0.0.1:0", ToolRequest::Default));
        let address = first.address.clone().expect("a serving endpoint has one");
        assert!(port_answers(&address));

        for attempt in 1..=2 {
            let again = control.enable(Wanted {
                api_key: format!("sk-{attempt}"),
                ..wanted(&address, ToolRequest::Default)
            });
            assert_eq!(
                again.state,
                RunState::Serving,
                "attempt {attempt}: re-enabling {address} must replace the listener, got {:?}",
                again.detail
            );
            assert_eq!(again.address.as_deref(), Some(address.as_str()));
            assert!(port_answers(&address), "attempt {attempt}");
        }
    }

    /// **The security rule, across a rebind.**
    ///
    /// Loopback with tools on, then a wildcard bind in the same session. The
    /// policy must be re-resolved from the *new* listener: tools off, reason
    /// `exposed-default`. Carrying the previous decision forward — an `enable`
    /// that returns early when something is already serving, or a report
    /// assembled from a remembered policy — would leave this reading "tools on,
    /// loopback-default" while the port is bound to every interface the host
    /// has, which is the exact failure `vela_endpoint::policy` exists to
    /// prevent.
    #[test]
    fn a_rebind_resolves_the_policy_from_the_new_listener() {
        let control = EndpointControl::off(hosts());

        let loopback = control.enable(wanted("127.0.0.1:0", ToolRequest::Default));
        assert!(loopback.tools_enabled, "loopback defaults tools on");
        assert!(loopback.loopback);
        assert!(loopback.reason_is(ToolPolicyReason::LoopbackDefault));

        let exposed = control.enable(wanted("0.0.0.0:0", ToolRequest::Default));
        assert_eq!(exposed.state, RunState::Serving, "{:?}", exposed.detail);
        assert!(
            !exposed.tools_enabled,
            "a wildcard bind must not inherit the previous bind's tool policy"
        );
        assert!(!exposed.loopback);
        assert!(exposed.reason_is(ToolPolicyReason::ExposedDefault));
        assert_ne!(
            exposed.address, loopback.address,
            "the report must describe the listener that is up now"
        );

        // …and the same in reverse, so the test is not satisfied by an `enable`
        // that simply always answers "exposed".
        let back = control.enable(wanted("127.0.0.1:0", ToolRequest::Default));
        assert!(back.tools_enabled);
        assert!(back.reason_is(ToolPolicyReason::LoopbackDefault));
    }

    /// The other half of the rule: an explicit enable on an exposed bind still
    /// needs the confirmation, and still needs it *after* a rebind rather than
    /// borrowing the loopback round's answer.
    #[test]
    fn forcing_tools_on_an_exposed_rebind_still_fails_closed_without_confirmation() {
        let control = EndpointControl::off(hosts());
        control.enable(wanted(
            "127.0.0.1:0",
            ToolRequest::Enable { confirmed: true },
        ));

        let unconfirmed = control.enable(wanted(
            "0.0.0.0:0",
            ToolRequest::Enable { confirmed: false },
        ));
        assert!(!unconfirmed.tools_enabled);
        assert!(unconfirmed.reason_is(ToolPolicyReason::ExposedEnableUnconfirmed));

        let confirmed =
            control.enable(wanted("0.0.0.0:0", ToolRequest::Enable { confirmed: true }));
        assert!(confirmed.tools_enabled);
        assert!(confirmed.reason_is(ToolPolicyReason::Forced));
    }

    /// A bind that cannot succeed is a state, not a panic — and it must leave
    /// nothing serving behind it, because a half-replaced endpoint is a port
    /// the user was told is closed.
    #[test]
    fn a_failed_rebind_leaves_nothing_listening_and_says_why() {
        let control = EndpointControl::off(hosts());
        let serving = control.enable(wanted("127.0.0.1:0", ToolRequest::Default));
        let address = serving.address.clone().expect("a serving endpoint has one");

        // An empty key is the one refusal `serve` itself owns, and it is the
        // cheapest way to make the *replacement* fail without depending on
        // which ports a particular machine happens to have taken.
        let failed = control.enable(Wanted {
            api_key: String::new(),
            ..wanted("127.0.0.1:0", ToolRequest::Default)
        });
        assert_eq!(failed.state, RunState::BindFailed);
        assert!(failed.detail.is_some(), "a failure must say something");
        assert!(failed.address.is_none());
        assert!(!failed.tools_enabled);
        assert!(
            !port_answers(&address),
            "the endpoint that was replaced must be gone even when its replacement failed"
        );
    }
}
