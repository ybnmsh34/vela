//! Opaque handles to secret material.
//!
//! # THE LOAD-BEARING RULE OF THIS FILE
//!
//! A secret **value** must never cross the IPC boundary toward the renderer.
//! The renderer may:
//!   * write a secret (`secrets_set`),
//!   * delete a secret (`secrets_delete`),
//!   * ask whether one exists (`secrets_status` → `{ present: bool }`).
//!
//! There is deliberately **no `secrets_get` command**, and there never will be.
//! Requests that need the secret are made by the Rust core, which reads it from
//! the OS keychain itself. If you find yourself wanting to read a secret in the
//! renderer, the feature belongs in Rust instead.

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreResult};

/// Which credential slot on a provider is being addressed.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SecretField {
    /// The provider's primary credential (API key / bearer token).
    Primary,
    /// A named extra credential (e.g. an org id, a proxy password).
    Named(String),
}

impl SecretField {
    fn slug(&self) -> &str {
        match self {
            SecretField::Primary => "primary",
            SecretField::Named(name) => name.as_str(),
        }
    }
}

/// An opaque, serialisable pointer to one secret. Safe to send to the renderer:
/// it contains no secret material.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretRef {
    pub provider_id: String,
    pub field: SecretField,
}

impl SecretRef {
    pub fn primary(provider_id: impl Into<String>) -> CoreResult<Self> {
        Self::new(provider_id, SecretField::Primary)
    }

    pub fn new(provider_id: impl Into<String>, field: SecretField) -> CoreResult<Self> {
        let provider_id = provider_id.into();
        if provider_id.trim().is_empty() {
            return Err(CoreError::Invalid {
                field: "providerId".into(),
                reason: "must not be empty".into(),
            });
        }
        if let SecretField::Named(name) = &field {
            if name.trim().is_empty() {
                return Err(CoreError::Invalid {
                    field: "field".into(),
                    reason: "named field must not be empty".into(),
                });
            }
        }
        Ok(Self { provider_id, field })
    }

    /// The stable key used inside the OS keychain / the in-memory fake.
    /// Format: `<providerId>/<field>`. Changing this format orphans existing
    /// keychain entries, so treat it as a storage migration.
    pub fn storage_key(&self) -> String {
        format!("{}/{}", self.provider_id, self.field.slug())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_key_is_stable_and_namespaced() {
        let r = SecretRef::primary("local-llamacpp").unwrap();
        assert_eq!(r.storage_key(), "local-llamacpp/primary");

        let named = SecretRef::new("acme", SecretField::Named("orgId".into())).unwrap();
        assert_eq!(named.storage_key(), "acme/orgId");
    }

    #[test]
    fn blank_identifiers_are_rejected() {
        assert!(SecretRef::primary("  ").is_err());
        assert!(SecretRef::new("acme", SecretField::Named("".into())).is_err());
    }

    #[test]
    fn secret_ref_serialises_without_any_value_field() {
        let json = serde_json::to_string(&SecretRef::primary("p").unwrap()).unwrap();
        assert_eq!(json, r#"{"providerId":"p","field":"primary"}"#);
        assert!(!json.contains("value"));
    }
}
