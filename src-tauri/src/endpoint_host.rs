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
//! # Why environment variables and not a settings row
//!
//! Because a settings row needs a command, a command needs a renderer type, and
//! the renderer would then be holding the words "anthropic" and "openai" —
//! which `src/platform/no-provider-leak.test.ts` exists to keep out of it, and
//! rightly. The dialect vocabulary belongs in the host. A user-facing switch is
//! a real gap and is named as one in this module's own report; what is here is
//! the wiring underneath it, which a settings surface would call instead of the
//! environment.

use std::net::SocketAddr;
use std::sync::Arc;

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
/// Separated from [`start_if_configured`] so the rules above are testable
/// without opening a socket — the same split `ProviderHost::sync` uses, and for
/// the same reason.
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

/// What startup ended up doing. Held by the application so the listener lives
/// as long as the process — `ServerHandle`'s `Drop` stops it.
pub enum EndpointState {
    Off,
    Refused(Refusal),
    /// The bind itself failed — a port already in use, usually.
    BindFailed(String),
    Serving(ServerHandle),
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
            Self::Serving(handle) => format!(
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

/// **The call the composition root makes.**
///
/// Reads the environment, and opens a port only if it was asked to and could
/// do so safely. Every other outcome is a state, not a panic: a desktop app
/// that refused to launch because a port was busy would be trading a feature
/// nobody has enabled for the whole application.
pub fn start_if_configured(env: &dyn EnvSource, providers: Arc<ProviderHost>) -> EndpointState {
    match decide(env) {
        Decision::Off => EndpointState::Off,
        Decision::Refused(refusal) => EndpointState::Refused(refusal),
        Decision::Start(wanted) => {
            let brain: Arc<dyn Brain> = Arc::new(ProviderBrain {
                providers,
                provider_id: wanted.provider_id,
            });
            match serve(
                EndpointConfig {
                    bind: wanted.bind,
                    api_key: wanted.api_key,
                    tools: wanted.tools,
                },
                brain,
            ) {
                Ok(handle) => EndpointState::Serving(handle),
                Err(error) => EndpointState::BindFailed(error.to_string()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

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
            source.contains("endpoint_host::start_if_configured"),
            "configure() must decide about the local endpoint at startup, or this \
             whole module is unreachable from the shipped application"
        );
        assert!(
            source.contains("app.manage(endpoint)"),
            "the ServerHandle must be held by the app: dropping it stops the listener"
        );
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

    #[test]
    fn a_started_endpoint_serves_the_named_provider_and_reports_its_policy() {
        use std::sync::Arc;
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

        let state = start_if_configured(
            &env(&[
                (BIND_VAR, "127.0.0.1:0"),
                (KEY_VAR, "sk-1"),
                (PROVIDER_VAR, "llamacpp"),
            ]),
            providers,
        );
        let EndpointState::Serving(handle) = &state else {
            panic!(
                "a complete configuration must serve, got {}",
                state.summary()
            );
        };
        assert!(
            handle.policy().tools_enabled(),
            "loopback defaults tools on"
        );
        assert!(state.summary().contains("tools on"));
    }

    #[test]
    fn an_endpoint_nobody_asked_for_says_so_and_binds_nothing() {
        let providers = Arc::new(ProviderHost::for_runtime(Arc::new(
            vela_secrets::MemoryStore::new(),
        )));
        let state = start_if_configured(&env(&[]), providers);
        assert!(matches!(state, EndpointState::Off));
        assert_eq!(state.summary(), "vela: local endpoint off");
    }
}
