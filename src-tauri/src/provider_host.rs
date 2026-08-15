//! **The provider composition root.**
//!
//! # The defect this module exists to close
//!
//! `AppState::for_runtime()` used to build a `ProviderRegistry::new()` and
//! nothing under `src-tauri/src/` ever called `ProviderRegistry::register`.
//! `settings_put_provider` wrote a row into SQLite, the renderer drew the
//! endpoint as configured, and `chat::resolve_provider` answered `NOT_FOUND`
//! for it — so the shipping application could not reach *any* model endpoint.
//! The provider core was complete and unreachable from the product it was
//! built for.
//!
//! Nothing in `crates/` was wrong. What was missing was the **host's own job**:
//! turning stored configuration into live objects. That job lives here and
//! nowhere else.
//!
//! # The rule
//!
//! **A configured provider is a registered provider.** There is exactly one
//! function that writes a provider row ([`crate::ipc::settings::put_provider`])
//! and it takes a `&ProviderHost`, so the write and the registration cannot
//! drift apart the way they did before. Deletion is the same door in reverse.
//! Startup calls [`ProviderHost::sync_from_settings`] once, which reconciles
//! the live set against what is stored.
//!
//! # Reconciliation, not rebuild
//!
//! [`ProviderHost::sync`] compares stored configuration against what is
//! installed and touches only the difference. That matters because a
//! [`CompatProvider`] accumulates *learned* facts — probed capabilities, the
//! server's discovered flavour — and throwing those away on every unrelated
//! settings write would send the UI back to "nothing established" and make the
//! endpoint pay for another round of discovery probes.
//!
//! # What this host can build, and what it deliberately cannot
//!
//! Every configured provider is built as a [`CompatProvider`] — the
//! OpenAI-shaped backend that llama.cpp, Ollama, LM Studio, vLLM and most
//! hosted APIs answer, and the one all four mock-matrix profiles speak.
//!
//! `AnthropicProvider` and `GoogleProvider` exist in the provider core and are
//! **not** reachable from here. That is a stated limitation, not an oversight:
//! selecting them would require the host to decide which wire dialect an
//! endpoint speaks, and the only honest way to decide that is to let the user
//! say so. `ProviderConfig` has no field for it — by design, per its own
//! load-bearing rule that nothing in it is provider-specific — and inventing
//! one from the URL would be exactly the "branch on backend identity" that
//! `docs/architecture/conventions.md` §0.3 forbids. Adding a user-visible
//! protocol choice is a settings-surface change; when it lands, it becomes one
//! more arm of the `match` in [`ProviderHost::build`].
//!
//! # Honesty
//!
//! Nothing here contacts an endpoint. The tests in this module and in
//! `tests/composition_root.rs` are **VERIFIED-BY-FAKE** except where they name
//! a real loopback socket they opened themselves.

use std::collections::BTreeMap;
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};

use vela_core::provider::ProviderDescriptor;
use vela_providers::http::{HttpTransport, ReqwestTransport};
use vela_providers::{CompatProvider, Provider, ProviderRegistry, Router};
use vela_secrets::SecretStore;
use vela_settings::{ProviderConfig, SettingsService};
use vela_store::SettingsRepository;

use crate::ipc::{IpcError, IpcErrorCode, IpcResult};

/// What one reconciliation did. Returned rather than logged so a caller — and a
/// test — can assert that the right thing happened instead of inferring it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncReport {
    /// Newly built, or rebuilt because their configuration changed.
    pub installed: Vec<String>,
    /// Registered before, no longer configured.
    pub removed: Vec<String>,
    /// Configuration unchanged; the live object — and everything it has learned
    /// — was kept.
    pub unchanged: Vec<String>,
    /// Configured, but no client could be built for it. The row stands; the
    /// endpoint is simply not reachable, and the reason travels with the id.
    pub failed: Vec<(String, IpcError)>,
}

impl SyncReport {
    pub fn changed(&self) -> bool {
        !self.installed.is_empty() || !self.removed.is_empty()
    }
}

/// The live set of provider objects, plus the configuration each was built
/// from.
///
/// Held behind one `RwLock` rather than two so the registry and the
/// configuration index cannot disagree about what is installed.
pub struct ProviderHost {
    secrets: Arc<dyn SecretStore>,
    /// The shared HTTP client, or the reason there is none.
    ///
    /// Kept as a `Result` instead of being unwrapped at construction because a
    /// client that cannot be built is a real failure the user must be *told*
    /// about on the turn that needs it — not a panic that takes the window down
    /// before anything can be rendered.
    transport: Result<Arc<dyn HttpTransport>, IpcError>,
    inner: RwLock<Live>,
}

#[derive(Default)]
struct Live {
    registry: ProviderRegistry,
    installed: BTreeMap<String, ProviderConfig>,
}

impl ProviderHost {
    /// Build against a caller-supplied transport. Tests use this with a
    /// scripted or recording transport; production uses [`Self::for_runtime`].
    pub fn new(secrets: Arc<dyn SecretStore>, transport: Arc<dyn HttpTransport>) -> Self {
        Self {
            secrets,
            transport: Ok(transport),
            inner: RwLock::new(Live::default()),
        }
    }

    /// Production constructor: the real `reqwest` client, which is the only
    /// thing in Vela that opens a socket.
    pub fn for_runtime(secrets: Arc<dyn SecretStore>) -> Self {
        let transport = ReqwestTransport::new()
            .map(|client| Arc::new(client) as Arc<dyn HttpTransport>)
            .map_err(|error| {
                IpcError::new(
                    IpcErrorCode::Internal,
                    format!("no HTTP client could be built: {error}"),
                )
            });
        Self {
            secrets,
            transport,
            inner: RwLock::new(Live::default()),
        }
    }

    /* ---------------------------------------------------------------- read */

    /// The live provider for `id`, or `None` when nothing is registered under
    /// it. Callers turn `None` into `NOT_FOUND`; this type never substitutes a
    /// different backend.
    pub fn get(&self, id: &str) -> Option<Arc<dyn Provider>> {
        self.read().registry.get(id)
    }

    pub fn descriptors(&self) -> Vec<ProviderDescriptor> {
        self.read().registry.descriptors()
    }

    pub fn ids(&self) -> Vec<String> {
        self.read().registry.ids()
    }

    pub fn len(&self) -> usize {
        self.read().registry.len()
    }

    pub fn is_empty(&self) -> bool {
        self.read().registry.is_empty()
    }

    /* --------------------------------------------------------------- write */

    /// Builds `config` and registers it, replacing any provider already under
    /// that id.
    ///
    /// Called on every accepted `settings_put_provider`, which is what makes an
    /// **edit** take effect: a changed base URL or auth binding produces a new
    /// object rather than leaving the old one answering.
    pub fn install(&self, config: &ProviderConfig) -> IpcResult<()> {
        let provider = self.build(config)?;
        let mut live = self.write();
        live.registry.register(provider);
        live.installed.insert(config.id.clone(), config.clone());
        Ok(())
    }

    /// Unregisters `id`. `false` when nothing was registered under it — a
    /// delete of a provider that never built is not an error.
    pub fn forget(&self, id: &str) -> bool {
        let mut live = self.write();
        live.installed.remove(id);
        live.registry.remove(id).is_some()
    }

    /// Reconciles the live set against `configs`.
    ///
    /// Never returns `Err` for a single bad provider: one endpoint that cannot
    /// be built must not stop the others from working, so the failure is
    /// recorded per-id in the report and the run continues.
    pub fn sync(&self, configs: Vec<ProviderConfig>) -> SyncReport {
        let mut report = SyncReport::default();

        let wanted: BTreeMap<String, ProviderConfig> = configs
            .into_iter()
            .map(|config| (config.id.clone(), config))
            .collect();

        let stale: Vec<String> = self
            .read()
            .installed
            .keys()
            .filter(|id| !wanted.contains_key(*id))
            .cloned()
            .collect();
        for id in stale {
            self.forget(&id);
            report.removed.push(id);
        }

        for (id, config) in wanted {
            if self.read().installed.get(&id) == Some(&config) {
                report.unchanged.push(id);
                continue;
            }
            match self.install(&config) {
                Ok(()) => report.installed.push(id),
                Err(error) => report.failed.push((id, error)),
            }
        }
        report
    }

    /// Reconciles against what is stored. This is the call startup makes, and
    /// it is the reason a provider configured in a previous session is
    /// reachable in this one.
    ///
    /// A failure to *read* settings does propagate: that is a broken database,
    /// not a broken endpoint.
    pub fn sync_from_settings<S: SettingsRepository + ?Sized>(
        &self,
        settings: &S,
    ) -> IpcResult<SyncReport> {
        let configs = SettingsService::new(settings, self.secrets.as_ref()).providers()?;
        Ok(self.sync(configs))
    }

    /* ---------------------------------------------------------- candidates */

    /// The [`Router`] one turn addressed to `provider_id` runs against.
    ///
    /// # The ordering, and why it is this and not something cleverer
    ///
    /// 1. **The endpoint the user chose is always first, with the model they
    ///    chose.** Nothing reorders it, ranks it or scores it. A turn goes
    ///    where the user pointed it.
    /// 2. **Every other configured endpoint follows, in id order**, so the
    ///    fallback set is the same on every turn and in every session. There is
    ///    no learned preference, no latency ranking and no health memory — all
    ///    three would make "where did my prompt go" unanswerable.
    /// 3. **A fallback uses its own configured `modelId`, or it is not a
    ///    fallback.** `model-a` is not a model name on backend B, and inventing
    ///    one from the user's selection would be Vela guessing. An endpoint
    ///    with no model recorded is skipped — visibly nothing, rather than a
    ///    request that is wrong in a way only the endpoint can see.
    /// 4. **A fallback whose required credential is missing is skipped.** It
    ///    could only answer `AuthFailed`, which by the router's first rule is
    ///    never failed over — so leaving it in would turn "the box you chose is
    ///    down" into "your key was rejected", about an endpoint the user did
    ///    not pick.
    ///
    /// The *selected* endpoint is deliberately not filtered by (3) or (4): if
    /// the endpoint a user pointed at cannot authenticate, that is the error
    /// they need to see, not a reason to quietly ask somebody else.
    ///
    /// `ProviderKind` is not consulted anywhere here. It exists "for
    /// grouping/iconography only — never for behaviour"
    /// ([`vela_core::provider::ProviderKind`]), and a failover policy that read
    /// it would be behaviour derived from backend identity.
    pub fn router_for(&self, provider_id: &str, model_id: &str) -> IpcResult<Router> {
        let live = self.read();
        if live.registry.get(provider_id).is_none() {
            return Err(IpcError::not_found(format!(
                "no provider configured with id `{provider_id}`"
            )));
        }

        let mut order = vec![(provider_id.to_owned(), model_id.to_owned())];
        for (id, config) in &live.installed {
            if id == provider_id {
                continue;
            }
            let Some(fallback_model) = config.model_id.as_deref() else {
                continue;
            };
            if !config.is_usable(self.credential_present(config)) {
                continue;
            }
            order.push((id.clone(), fallback_model.to_owned()));
        }
        Ok(live.registry.route(&order))
    }

    /// Whether the credential store holds an entry for this configuration.
    /// A *presence* question, never a read of the value — same shape as
    /// [`vela_settings::SettingsService::credential_present`].
    fn credential_present(&self, config: &ProviderConfig) -> bool {
        config
            .secret_ref()
            .is_some_and(|reference| self.secrets.contains(reference))
    }

    /* --------------------------------------------------------------- build */

    /// Turns one stored configuration into one live provider.
    ///
    /// The single `match`-shaped decision in the host. See the module docs for
    /// why every arm is the OpenAI-compatible one today.
    fn build(&self, config: &ProviderConfig) -> IpcResult<Arc<dyn Provider>> {
        let transport = self.transport.clone()?;
        let descriptor = ProviderDescriptor::new(&config.id, &config.display_name, config.kind)?
            .with_auth(config.auth_policy());

        Ok(Arc::new(CompatProvider::new(
            descriptor,
            config.base_url.as_str(),
            config.auth.clone(),
            Arc::clone(&self.secrets),
            transport,
        )))
    }

    /* ---------------------------------------------------------------- lock */

    /// Recovering from a poisoned lock is correct here for the same reason it
    /// is in `ChatTurns`: the contents are an id-keyed index with no invariant
    /// a panic could have half-broken, and refusing every later turn would be a
    /// worse outcome than continuing.
    fn read(&self) -> RwLockReadGuard<'_, Live> {
        self.inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn write(&self) -> RwLockWriteGuard<'_, Live> {
        self.inner
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vela_core::auth::{AuthMode, AuthRequirement};
    use vela_providers::http::testing::ScriptedTransport;
    use vela_secrets::MemoryStore;

    fn host() -> ProviderHost {
        ProviderHost::new(
            Arc::new(MemoryStore::new()),
            Arc::new(ScriptedTransport::new(Vec::new())),
        )
    }

    /// **The guard against this whole module becoming the defect it fixes.**
    ///
    /// Every test in this file could pass while `run()` never calls any of it —
    /// which is exactly the shape of what went wrong: a correct component that
    /// the real builder does not reach. `run()` itself needs a windowing system
    /// and cannot be executed here, so the call site is asserted structurally,
    /// the same way `settings.rs` asserts that no command constructs an enabled
    /// telemetry setting.
    #[test]
    fn the_real_app_builder_fills_the_provider_set_at_startup() {
        let source = include_str!("lib.rs");
        assert!(
            source.contains("sync_from_settings"),
            "run() must fill the live provider set from the database, or every \
             endpoint the user configured in an earlier session is unreachable"
        );
        assert!(
            source.contains("AppState::for_runtime()"),
            "the state the sync fills must be the one the commands resolve against"
        );
    }

    fn config(id: &str, url: &str) -> ProviderConfig {
        ProviderConfig::local(id, "A backend", url).unwrap()
    }

    #[test]
    fn a_configured_provider_becomes_a_live_one() {
        let host = host();
        assert!(host.is_empty(), "nothing is registered before anything is");
        host.install(&config("llamacpp", "http://127.0.0.1:8080/v1"))
            .unwrap();
        assert!(host.get("llamacpp").is_some());
        assert_eq!(host.get("llamacpp").unwrap().descriptor().id, "llamacpp");
    }

    #[test]
    fn an_id_that_was_never_configured_resolves_to_nothing_rather_than_a_substitute() {
        let host = host();
        host.install(&config("llamacpp", "http://127.0.0.1:8080/v1"))
            .unwrap();
        assert!(host.get("some-other-endpoint").is_none());
    }

    #[test]
    fn a_deleted_provider_stops_answering() {
        let host = host();
        host.install(&config("gone", "http://127.0.0.1:8080/v1"))
            .unwrap();
        assert!(host.forget("gone"));
        assert!(host.get("gone").is_none());
        assert!(
            !host.forget("gone"),
            "a second delete is not a second event"
        );
    }

    #[test]
    fn an_edit_replaces_the_live_object_rather_than_leaving_the_old_one_answering() {
        // The failure this pins: a user fixes a typo in the base URL and the
        // turn still goes to the old address because the registry kept the
        // object it built at boot.
        let host = host();
        host.install(&config("box", "http://127.0.0.1:8080/v1"))
            .unwrap();
        let first = host.get("box").unwrap();
        host.install(&config("box", "http://127.0.0.1:9090/v1"))
            .unwrap();
        let second = host.get("box").unwrap();
        assert!(
            !Arc::ptr_eq(&first, &second),
            "a changed configuration must produce a new provider"
        );
        assert_eq!(host.len(), 1, "an edit is not a second provider");
    }

    #[test]
    fn reconciliation_keeps_what_did_not_change_and_replaces_what_did() {
        let host = host();
        let report = host.sync(vec![
            config("a", "http://127.0.0.1:8080/v1"),
            config("b", "http://127.0.0.1:8081/v1"),
        ]);
        assert_eq!(report.installed, vec!["a".to_string(), "b".to_string()]);
        assert!(report.removed.is_empty());
        let kept = host.get("a").unwrap();

        let report = host.sync(vec![
            config("a", "http://127.0.0.1:8080/v1"),
            config("b", "http://127.0.0.1:9999/v1"),
            config("c", "http://127.0.0.1:8082/v1"),
        ]);
        assert_eq!(report.unchanged, vec!["a".to_string()]);
        assert_eq!(report.installed, vec!["b".to_string(), "c".to_string()]);
        assert!(
            Arc::ptr_eq(&kept, &host.get("a").unwrap()),
            "an untouched provider must keep everything it has learned"
        );

        let report = host.sync(vec![config("a", "http://127.0.0.1:8080/v1")]);
        assert_eq!(report.removed, vec!["b".to_string(), "c".to_string()]);
        assert_eq!(host.len(), 1);
    }

    #[test]
    fn a_host_with_no_http_client_reports_it_instead_of_registering_a_dead_provider() {
        // The `Result` transport, exercised. A host that cannot build a client
        // must fail loudly on the write, not register something that will
        // silently never work.
        let host = ProviderHost {
            secrets: Arc::new(MemoryStore::new()),
            transport: Err(IpcError::new(IpcErrorCode::Internal, "no client")),
            inner: RwLock::new(Live::default()),
        };
        let error = host
            .install(&config("x", "http://127.0.0.1:8080/v1"))
            .unwrap_err();
        assert_eq!(error.code, IpcErrorCode::Internal);
        assert!(host.is_empty());

        let report = host.sync(vec![config("x", "http://127.0.0.1:8080/v1")]);
        assert!(report.installed.is_empty());
        assert_eq!(report.failed.len(), 1, "the reason travels with the id");
        assert_eq!(report.failed[0].0, "x");
    }

    #[test]
    fn the_descriptor_carries_the_auth_policy_the_user_configured() {
        let host = host();
        let config = ProviderConfig::local("acme", "Acme", "https://api.example.test/v1")
            .unwrap()
            .with_auth(&AuthMode::BearerToken, AuthRequirement::Required)
            .unwrap();
        host.install(&config).unwrap();
        let descriptor = host.get("acme").unwrap().descriptor().clone();
        assert!(
            !descriptor.is_usable(false),
            "a required credential that is absent must make the provider unusable"
        );
        assert!(descriptor.is_usable(true));
    }

    #[test]
    fn a_provider_built_here_addresses_the_url_the_user_configured() {
        // Non-vacuity for every other test in this file: it proves the object
        // the host builds is wired to the transport it was handed and to the
        // endpoint the user typed — so a later absence of traffic is a real
        // absence, not a fake that never talks to anything.
        let transport = Arc::new(ScriptedTransport::new(Vec::new()));
        let host = ProviderHost::new(Arc::new(MemoryStore::new()), transport.clone());
        host.install(&config("x", "http://127.0.0.1:8080/v1"))
            .unwrap();
        let provider = host.get("x").unwrap();

        let mut sink: Vec<vela_providers::StreamEvent> = Vec::new();
        let _ = tauri::async_runtime::block_on(
            provider.stream(
                vela_providers::ChatRequest::new("m")
                    .with_message(vela_providers::ChatMessage::user("hi")),
                &mut sink,
                &vela_providers::RequestContext::new(),
            ),
        );

        let addressed = transport.recorded();
        assert!(
            !addressed.is_empty(),
            "the provider must have reached for the transport the host handed it"
        );
        for request in &addressed {
            assert!(
                request.url.starts_with("http://127.0.0.1:8080/"),
                "every request must go to the configured endpoint, got {}",
                request.url.redacted()
            );
        }
    }
}
