//! Process-wide state handed to commands via `tauri::State`.
//!
//! Everything here is behind a trait object so tests can construct an
//! `AppState` with fakes and call the plain service functions directly, with no
//! Tauri runtime and no window.

use std::sync::Arc;

use vela_providers::ProviderRegistry;
use vela_secrets::{MemoryStore, SecretStore};

#[derive(Clone)]
pub struct AppState {
    pub secrets: Arc<dyn SecretStore>,
    pub providers: Arc<ProviderRegistry>,
}

impl AppState {
    pub fn new(secrets: Arc<dyn SecretStore>, providers: ProviderRegistry) -> Self {
        Self {
            secrets,
            providers: Arc::new(providers),
        }
    }

    /// Test/headless constructor. Anything verified through this is
    /// **VERIFIED-BY-FAKE** — no OS keychain is touched.
    pub fn with_memory_store() -> Self {
        Self::new(Arc::new(MemoryStore::new()), ProviderRegistry::new())
    }

    /// Production constructor. Uses the OS keychain when the `os-keychain`
    /// feature is on, and falls back to the in-memory fake otherwise so a
    /// headless build still runs — while reporting `memory-fake` through
    /// `app_info.secretBackend` so the substitution is never silent.
    pub fn for_runtime() -> Self {
        #[cfg(feature = "os-keychain")]
        let secrets: Arc<dyn SecretStore> = Arc::new(vela_secrets::KeyringStore::new());
        #[cfg(not(feature = "os-keychain"))]
        let secrets: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());

        Self::new(secrets, ProviderRegistry::new())
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
}
