//! # vela-secrets
//!
//! The credential-storage seam.
//!
//! Credentials live in the **OS keychain** and never in plaintext on disk. That
//! is not testable in CI or on a headless host, so storage is expressed as a
//! trait with two implementations:
//!
//! | Impl | Backing store | Where it runs |
//! |---|---|---|
//! | [`KeyringStore`] | macOS Keychain / Windows Credential Manager / Secret Service | real desktops, `--features os-keychain` |
//! | [`MemoryStore`] | process memory, zeroed on drop of the process | tests, headless CI |
//!
//! **Honesty rule:** anything exercised only against [`MemoryStore`] is
//! `VERIFIED-BY-FAKE`. Do not describe it as verified against a real keychain.

use std::collections::HashMap;
use std::sync::Mutex;

use vela_core::secret::SecretRef;

#[cfg(feature = "os-keychain")]
mod keyring_store;
#[cfg(feature = "os-keychain")]
pub use keyring_store::KeyringStore;

/// Service name registered with the OS keychain. Namespacing all entries under
/// one service keeps Vela's credentials separable and revocable as a unit.
pub const KEYCHAIN_SERVICE: &str = "dev.vela.desktop";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SecretError {
    #[error("no credential stored for `{key}`")]
    NotFound { key: String },
    /// The platform keychain is present but refused the operation (locked,
    /// permission denied, daemon unavailable). Distinct from `NotFound` so the
    /// UI can tell "you have no key" from "we could not read your keychain".
    #[error("keychain unavailable: {reason}")]
    Unavailable { reason: String },
    #[error("refusing to store an empty credential for `{key}`")]
    EmptyValue { key: String },
}

pub type SecretResult<T> = Result<T, SecretError>;

/// Credential storage.
///
/// Note the asymmetry: `get` exists for the **Rust core only** (it needs the
/// value to sign an outbound request). It is never wired to an IPC command. The
/// renderer-facing surface is `set` / `delete` / `contains`.
pub trait SecretStore: Send + Sync {
    fn set(&self, reference: &SecretRef, value: &str) -> SecretResult<()>;
    /// Rust-core use only. Never expose through IPC.
    fn get(&self, reference: &SecretRef) -> SecretResult<String>;
    fn delete(&self, reference: &SecretRef) -> SecretResult<()>;
    fn contains(&self, reference: &SecretRef) -> bool;
    /// Human-readable backend name, surfaced in diagnostics so a report can
    /// state truthfully whether a real keychain was used.
    fn backend(&self) -> &'static str;
}

/// In-memory fake. **VERIFIED-BY-FAKE** — proves protocol shape, proves nothing
/// about real OS keychain behaviour.
#[derive(Debug, Default)]
pub struct MemoryStore {
    entries: Mutex<HashMap<String, String>>,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Test-only introspection. Not part of [`SecretStore`], so production code
    /// cannot reach it through the trait object.
    pub fn len(&self) -> usize {
        self.entries.lock().expect("secret store poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl SecretStore for MemoryStore {
    fn set(&self, reference: &SecretRef, value: &str) -> SecretResult<()> {
        let key = reference.storage_key();
        if value.is_empty() {
            return Err(SecretError::EmptyValue { key });
        }
        self.entries
            .lock()
            .expect("secret store poisoned")
            .insert(key, value.to_owned());
        Ok(())
    }

    fn get(&self, reference: &SecretRef) -> SecretResult<String> {
        let key = reference.storage_key();
        self.entries
            .lock()
            .expect("secret store poisoned")
            .get(&key)
            .cloned()
            .ok_or(SecretError::NotFound { key })
    }

    fn delete(&self, reference: &SecretRef) -> SecretResult<()> {
        let key = reference.storage_key();
        self.entries
            .lock()
            .expect("secret store poisoned")
            .remove(&key)
            .map(|_| ())
            .ok_or(SecretError::NotFound { key })
    }

    fn contains(&self, reference: &SecretRef) -> bool {
        self.entries
            .lock()
            .expect("secret store poisoned")
            .contains_key(&reference.storage_key())
    }

    fn backend(&self) -> &'static str {
        "memory-fake"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vela_core::secret::SecretField;

    fn r(id: &str) -> SecretRef {
        SecretRef::primary(id).unwrap()
    }

    #[test]
    fn set_then_contains_then_delete_round_trip() {
        let store = MemoryStore::new();
        let reference = r("local-llamacpp");

        assert!(!store.contains(&reference));
        store.set(&reference, "sk-test-value").unwrap();
        assert!(store.contains(&reference));
        assert_eq!(store.get(&reference).unwrap(), "sk-test-value");

        store.delete(&reference).unwrap();
        assert!(!store.contains(&reference));
        assert_eq!(
            store.delete(&reference).unwrap_err(),
            SecretError::NotFound {
                key: "local-llamacpp/primary".into()
            }
        );
    }

    #[test]
    fn absent_credential_is_reported_as_absence_not_as_a_backend_failure() {
        // The distinction the UI depends on: "you have no key" must never be
        // rendered as "your keychain is broken".
        let store = MemoryStore::new();
        match store.get(&r("no-auth-endpoint")) {
            Err(SecretError::NotFound { .. }) => {}
            other => panic!("expected NotFound, got {other:?}"),
        }
        assert!(!store.contains(&r("no-auth-endpoint")));
    }

    #[test]
    fn fields_are_namespaced_per_provider() {
        let store = MemoryStore::new();
        let a = SecretRef::new("p", SecretField::Primary).unwrap();
        let b = SecretRef::new("p", SecretField::Named("orgId".into())).unwrap();
        store.set(&a, "one").unwrap();
        store.set(&b, "two").unwrap();
        assert_eq!(store.get(&a).unwrap(), "one");
        assert_eq!(store.get(&b).unwrap(), "two");
        assert_eq!(store.len(), 2);
    }

    #[test]
    fn empty_values_are_rejected_rather_than_silently_stored() {
        let store = MemoryStore::new();
        assert!(matches!(
            store.set(&r("p"), ""),
            Err(SecretError::EmptyValue { .. })
        ));
        assert!(store.is_empty());
    }

    #[test]
    fn backend_name_is_honest_about_being_a_fake() {
        assert_eq!(MemoryStore::new().backend(), "memory-fake");
    }
}
