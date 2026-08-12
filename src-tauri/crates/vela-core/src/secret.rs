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
use zeroize::Zeroize;

use crate::error::{CoreError, CoreResult};

/// Placeholder printed instead of a credential. Grepping the codebase for this
/// string finds every place a secret is deliberately not shown.
pub const REDACTED: &str = "<redacted>";

/// A credential **value**.
///
/// # THE RULE THIS TYPE ENFORCES
///
/// `String` is the wrong type for a credential: every `{:?}` in a log line, an
/// `anyhow` chain, or a `#[derive(Debug)]` on some struct three layers up will
/// happily print it. `SecretValue` cannot be printed: both [`Debug`] and
/// [`Display`] emit [`REDACTED`], and reading the value requires the
/// deliberately awkward [`SecretValue::expose`], which is easy to grep for in
/// review.
///
/// It is [`Deserialize`] (a credential has to arrive from somewhere) but
/// **deliberately not [`Serialize`]** — serialising one is how a secret ends up
/// in a settings row, a JSON log, or an IPC response.
#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(transparent)]
pub struct SecretValue(String);

impl SecretValue {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Reach the raw credential. Named to be conspicuous: every call site is a
    /// place where a secret leaves its wrapper, and should be reviewed as one.
    pub fn expose(&self) -> &str {
        &self.0
    }

    /// Length in bytes. Safe to log — it is metadata, not material.
    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Build a derived secret (e.g. `Bearer <token>`) without the intermediate
    /// value ever existing as a printable `String` at a call site.
    pub fn map(&self, f: impl FnOnce(&str) -> String) -> Self {
        Self(f(&self.0))
    }
}

impl std::fmt::Debug for SecretValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Not `debug_struct`: a struct-like rendering invites someone to add
        // the value "just for debugging". There is nothing here to print.
        write!(f, "SecretValue({REDACTED})")
    }
}

impl std::fmt::Display for SecretValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(REDACTED)
    }
}

impl From<String> for SecretValue {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for SecretValue {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl Drop for SecretValue {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

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

    /// The credential a test would most regret leaking.
    const CANARY: &str = "sk-live-canary-9f2b7c41-DO-NOT-LOG";

    #[test]
    fn debug_and_display_of_a_secret_value_never_contain_the_credential() {
        let secret = SecretValue::new(CANARY);

        assert_eq!(format!("{secret:?}"), "SecretValue(<redacted>)");
        assert_eq!(format!("{secret}"), REDACTED);
        assert!(!format!("{secret:?}").contains(CANARY));
        assert!(!format!("{secret}").contains(CANARY));
        assert!(!format!("{secret:#?}").contains(CANARY));

        // The value is still reachable where it is genuinely needed.
        assert_eq!(secret.expose(), CANARY);
    }

    #[test]
    fn a_secret_nested_inside_a_derived_debug_struct_is_still_redacted() {
        // The realistic leak: nobody logs the credential directly, they log the
        // request struct that happens to hold one.
        #[derive(Debug)]
        struct OutboundRequest {
            // Read only through `Debug` — that is the whole point of the test.
            #[allow(dead_code)]
            url: &'static str,
            credential: SecretValue,
        }

        let printed = format!(
            "{:?}",
            OutboundRequest {
                url: "https://api.example.test/v1/chat",
                credential: SecretValue::new(CANARY),
            }
        );
        assert!(printed.contains("api.example.test"), "{printed}");
        assert!(!printed.contains(CANARY), "leaked through a derived Debug: {printed}");
    }

    #[test]
    fn a_secret_value_carries_length_metadata_without_carrying_the_value() {
        let secret = SecretValue::new(CANARY);
        assert_eq!(secret.len(), CANARY.len());
        assert!(!secret.is_empty());
        assert!(SecretValue::new("").is_empty());
    }

    #[test]
    fn a_derived_secret_stays_wrapped() {
        // Building `Bearer <token>` must not produce a bare printable String.
        let derived = SecretValue::new(CANARY).map(|value| format!("Bearer {value}"));
        assert_eq!(derived.expose(), format!("Bearer {CANARY}"));
        assert!(!format!("{derived:?}").contains(CANARY));
    }
}
