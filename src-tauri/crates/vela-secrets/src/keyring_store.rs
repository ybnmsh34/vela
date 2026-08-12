//! Real OS-keychain backend.
//!
//! **This file cannot be exercised in the headless build container.** It is
//! compiled (so it cannot rot) but its behaviour is only verifiable on a real
//! desktop with a keychain daemon. Every claim about it in a report must say so.

use keyring::Entry;
use vela_core::secret::SecretRef;

use crate::{SecretError, SecretResult, SecretStore, KEYCHAIN_SERVICE};

/// Stores credentials in the platform keychain:
/// macOS Keychain, Windows Credential Manager, or freedesktop Secret Service.
#[derive(Debug, Default)]
pub struct KeyringStore {
    service: String,
}

impl KeyringStore {
    pub fn new() -> Self {
        Self {
            service: KEYCHAIN_SERVICE.to_owned(),
        }
    }

    /// Use a distinct service namespace (dev builds, profile isolation).
    pub fn with_service(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    fn entry(&self, reference: &SecretRef) -> SecretResult<Entry> {
        Entry::new(&self.service, &reference.storage_key()).map_err(|error| {
            SecretError::Unavailable {
                reason: error.to_string(),
            }
        })
    }
}

fn map_error(key: String, error: keyring::Error) -> SecretError {
    match error {
        keyring::Error::NoEntry => SecretError::NotFound { key },
        other => SecretError::Unavailable {
            reason: other.to_string(),
        },
    }
}

impl SecretStore for KeyringStore {
    fn set(&self, reference: &SecretRef, value: &str) -> SecretResult<()> {
        let key = reference.storage_key();
        if value.is_empty() {
            return Err(SecretError::EmptyValue { key });
        }
        self.entry(reference)?
            .set_password(value)
            .map_err(|error| map_error(key, error))
    }

    fn get(&self, reference: &SecretRef) -> SecretResult<String> {
        let key = reference.storage_key();
        self.entry(reference)?
            .get_password()
            .map_err(|error| map_error(key, error))
    }

    fn delete(&self, reference: &SecretRef) -> SecretResult<()> {
        let key = reference.storage_key();
        self.entry(reference)?
            .delete_credential()
            .map_err(|error| map_error(key, error))
    }

    fn contains(&self, reference: &SecretRef) -> bool {
        matches!(self.get(reference), Ok(_))
    }

    fn backend(&self) -> &'static str {
        "os-keychain"
    }
}
