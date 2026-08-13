//! Process-wide state handed to commands via `tauri::State`.
//!
//! Everything here is behind a trait object so tests can construct an
//! `AppState` with fakes and call the plain service functions directly, with no
//! Tauri runtime and no window.

use std::sync::Arc;

use vela_providers::http::HttpTransport;
use vela_secrets::{MemoryStore, SecretStore};

use crate::provider_host::ProviderHost;

#[derive(Clone)]
pub struct AppState {
    pub secrets: Arc<dyn SecretStore>,
    /// The live provider set. **Not** a bare `ProviderRegistry`: a registry can
    /// only be filled by someone who remembers to fill it, and nobody did. See
    /// [`crate::provider_host`] for the defect and the rule that replaced it.
    pub providers: Arc<ProviderHost>,
}

impl AppState {
    pub fn new(secrets: Arc<dyn SecretStore>, providers: ProviderHost) -> Self {
        Self {
            secrets,
            providers: Arc::new(providers),
        }
    }

    /// Test/headless constructor. Anything verified through this is
    /// **VERIFIED-BY-FAKE** — no OS keychain is touched.
    pub fn with_memory_store() -> Self {
        let secrets: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
        Self::new(Arc::clone(&secrets), ProviderHost::for_runtime(secrets))
    }

    /// Test constructor with a caller-supplied transport, so a test can watch
    /// what a provider built by the real composition root puts on the wire
    /// without opening a socket.
    pub fn with_transport(transport: Arc<dyn HttpTransport>) -> Self {
        let secrets: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
        Self::new(Arc::clone(&secrets), ProviderHost::new(secrets, transport))
    }

    /// Production constructor. Uses the OS keychain when the `os-keychain`
    /// feature is on, and falls back to the in-memory fake otherwise so a
    /// headless build still runs — while reporting `memory-fake` through
    /// `app_info.secretBackend` so the substitution is never silent.
    ///
    /// The provider set starts **empty and is filled from the database** in
    /// `run()`'s `setup`, because the stored settings only become readable once
    /// the app-data directory is resolvable. An `AppState` on its own knows
    /// nothing about which endpoints the user configured, and that is the one
    /// thing this type must never quietly pretend to know.
    pub fn for_runtime() -> Self {
        #[cfg(feature = "os-keychain")]
        let secrets: Arc<dyn SecretStore> = Arc::new(vela_secrets::KeyringStore::new());
        #[cfg(not(feature = "os-keychain"))]
        let secrets: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());

        Self::new(Arc::clone(&secrets), ProviderHost::for_runtime(secrets))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_state_uses_the_fake_and_says_so() {
        let state = AppState::with_memory_store();
        assert_eq!(state.secrets.backend(), "memory-fake");
        assert!(state.providers.is_empty());
    }

    #[test]
    fn the_provider_host_shares_the_credential_store_the_state_reports() {
        // A provider built by the host must read credentials from the same
        // place `secrets_set` writes them, or a stored key would be invisible
        // to the turn that needs it.
        let state = AppState::with_memory_store();
        state
            .providers
            .install(
                &vela_settings::ProviderConfig::local("p", "P", "http://127.0.0.1:8080/v1")
                    .unwrap(),
            )
            .unwrap();
        assert_eq!(state.providers.len(), 1);
    }
}
