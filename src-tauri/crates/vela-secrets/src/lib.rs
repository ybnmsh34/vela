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
//!
//! ## Values, not strings
//!
//! Every credential in this crate is a [`SecretValue`], never a `String`, so a
//! stray `{:?}` cannot print one. See [`vela_core::secret`].
//!
//! ## Enumeration
//!
//! [`SecretStore::list`] is honest about a real constraint: the platform
//! keychains have no portable "list everything under my service" API, so
//! [`KeyringStore::list`] returns [`SecretError::EnumerationUnsupported`]
//! rather than an empty list — an empty list would read as "the user has no
//! credentials", which is a different and dangerous claim. Callers that need to
//! know which credentials exist ask the settings layer for the configured
//! providers and call [`SecretStore::contains`] per reference; that path works
//! identically on every platform.

use std::collections::HashMap;
use std::sync::Mutex;

use vela_core::auth::AuthPolicy;
use vela_core::credential::{Auth, AUTHORIZATION_HEADER};
use vela_core::secret::{SecretRef, SecretValue};

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
    /// This backend cannot enumerate its contents. Not a failure of the user's
    /// machine — a property of every real platform keychain.
    #[error("`{backend}` cannot enumerate stored credentials")]
    EnumerationUnsupported { backend: &'static str },
}

pub type SecretResult<T> = Result<T, SecretError>;

/// Credential storage — the `CredentialStore` of the architecture brief.
///
/// Note the asymmetry: `get` exists for the **Rust core only** (it needs the
/// value to sign an outbound request). It is never wired to an IPC command. The
/// renderer-facing surface is `set` / `delete` / `contains`.
pub trait SecretStore: Send + Sync {
    fn set(&self, reference: &SecretRef, value: &SecretValue) -> SecretResult<()>;
    /// Rust-core use only. Never expose through IPC.
    fn get(&self, reference: &SecretRef) -> SecretResult<SecretValue>;
    fn delete(&self, reference: &SecretRef) -> SecretResult<()>;
    fn contains(&self, reference: &SecretRef) -> bool;
    /// Every stored reference, where the backend can tell us. Returns
    /// [`SecretError::EnumerationUnsupported`] on backends that cannot — see
    /// the crate docs. **Never returns credential values.**
    fn list(&self) -> SecretResult<Vec<SecretRef>>;
    /// Human-readable backend name, surfaced in diagnostics so a report can
    /// state truthfully whether a real keychain was used.
    fn backend(&self) -> &'static str;
}

/// A credential resolved and shaped for an outbound request.
///
/// Constructed only by [`resolve_auth`]. `Debug` is derived, which is safe
/// because [`SecretValue`] redacts itself; a test in this module holds that
/// property down.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppliedAuth {
    /// Send nothing. **Not** an empty header — see [`resolve_auth`].
    None,
    Header { name: String, value: SecretValue },
    QueryParam { name: String, value: SecretValue },
}

impl AppliedAuth {
    /// The header to add to an outbound request, if any.
    pub fn header(&self) -> Option<(&str, &SecretValue)> {
        match self {
            AppliedAuth::Header { name, value } => Some((name.as_str(), value)),
            _ => Option::None,
        }
    }

    /// The query parameter to append, if any.
    pub fn query_param(&self) -> Option<(&str, &SecretValue)> {
        match self {
            AppliedAuth::QueryParam { name, value } => Some((name.as_str(), value)),
            _ => Option::None,
        }
    }

    pub fn is_none(&self) -> bool {
        matches!(self, AppliedAuth::None)
    }
}

/// Turn a configured [`Auth`] binding into concrete request material.
///
/// # THE RULE THIS FUNCTION ENFORCES
///
/// * [`Auth::None`] returns [`AppliedAuth::None`] **without touching the
///   keychain**. No lookup, no miss, no error — and critically, no
///   `Authorization: ` header with an empty value, which is what a naive
///   `format!("Bearer {}", key.unwrap_or_default())` produces and which many
///   servers reject with a 401 that is then misreported as "bad API key".
/// * A binding whose credential is *missing* is an error
///   ([`SecretError::NotFound`]), never a silently empty header. Whether that
///   error matters is a policy question — see [`AuthPolicy::check`] — but it is
///   never resolved by sending an empty credential.
pub fn resolve_auth(store: &dyn SecretStore, auth: &Auth) -> SecretResult<AppliedAuth> {
    let Some(reference) = auth.secret_ref() else {
        return Ok(AppliedAuth::None);
    };
    let value = store.get(reference)?;
    if value.is_empty() {
        // Unreachable through `set`, which rejects empty values; guarded anyway
        // because an empty credential must never become an empty header.
        return Err(SecretError::EmptyValue {
            key: reference.storage_key(),
        });
    }
    Ok(match auth {
        Auth::None => AppliedAuth::None,
        Auth::Bearer { .. } => AppliedAuth::Header {
            name: AUTHORIZATION_HEADER.to_owned(),
            value: value.map(|token| format!("Bearer {token}")),
        },
        Auth::ApiKeyHeader { header, .. } => AppliedAuth::Header {
            name: header.clone(),
            value,
        },
        Auth::ApiKeyQuery { param, .. } => AppliedAuth::QueryParam {
            name: param.clone(),
            value,
        },
    })
}

/// Whether the credential a binding points at is stored right now.
/// `Auth::None` is always "satisfied" — there is nothing to store.
pub fn credential_present(store: &dyn SecretStore, auth: &Auth) -> bool {
    match auth.secret_ref() {
        Option::None => false,
        Some(reference) => store.contains(reference),
    }
}

/// Check a provider's configuration against its declared policy, consulting the
/// keychain only when a binding actually exists.
pub fn check_credential(
    store: &dyn SecretStore,
    auth: &Auth,
    policy: &AuthPolicy,
) -> vela_core::auth::CredentialCheck {
    policy.check(credential_present(store, auth))
}

/// In-memory fake. **VERIFIED-BY-FAKE** — proves protocol shape, proves nothing
/// about real OS keychain behaviour.
#[derive(Debug, Default)]
pub struct MemoryStore {
    entries: Mutex<HashMap<String, (SecretRef, SecretValue)>>,
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
    fn set(&self, reference: &SecretRef, value: &SecretValue) -> SecretResult<()> {
        let key = reference.storage_key();
        if value.is_empty() {
            return Err(SecretError::EmptyValue { key });
        }
        self.entries
            .lock()
            .expect("secret store poisoned")
            .insert(key, (reference.clone(), value.clone()));
        Ok(())
    }

    fn get(&self, reference: &SecretRef) -> SecretResult<SecretValue> {
        let key = reference.storage_key();
        self.entries
            .lock()
            .expect("secret store poisoned")
            .get(&key)
            .map(|(_, value)| value.clone())
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

    fn list(&self) -> SecretResult<Vec<SecretRef>> {
        let entries = self.entries.lock().expect("secret store poisoned");
        let mut refs: Vec<SecretRef> = entries.values().map(|(r, _)| r.clone()).collect();
        refs.sort_by_key(SecretRef::storage_key);
        Ok(refs)
    }

    fn backend(&self) -> &'static str {
        "memory-fake"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vela_core::auth::{AuthMode, AuthRequirement, CredentialCheck};
    use vela_core::secret::SecretField;

    const CANARY: &str = "sk-live-canary-9f2b7c41-DO-NOT-LOG";

    fn r(id: &str) -> SecretRef {
        SecretRef::primary(id).unwrap()
    }

    fn v(value: &str) -> SecretValue {
        SecretValue::new(value)
    }

    #[test]
    fn set_then_contains_then_delete_round_trip() {
        let store = MemoryStore::new();
        let reference = r("local-llamacpp");

        assert!(!store.contains(&reference));
        store.set(&reference, &v("sk-test-value")).unwrap();
        assert!(store.contains(&reference));
        assert_eq!(store.get(&reference).unwrap().expose(), "sk-test-value");

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
        store.set(&a, &v("one")).unwrap();
        store.set(&b, &v("two")).unwrap();
        assert_eq!(store.get(&a).unwrap().expose(), "one");
        assert_eq!(store.get(&b).unwrap().expose(), "two");
        assert_eq!(store.len(), 2);
    }

    #[test]
    fn empty_values_are_rejected_rather_than_silently_stored() {
        let store = MemoryStore::new();
        assert!(matches!(
            store.set(&r("p"), &v("")),
            Err(SecretError::EmptyValue { .. })
        ));
        assert!(store.is_empty());
    }

    #[test]
    fn backend_name_is_honest_about_being_a_fake() {
        assert_eq!(MemoryStore::new().backend(), "memory-fake");
    }

    #[test]
    fn listing_returns_references_sorted_and_never_values() {
        let store = MemoryStore::new();
        store.set(&r("zeta"), &v(CANARY)).unwrap();
        store.set(&r("alpha"), &v("another")).unwrap();

        let listed = store.list().unwrap();
        let keys: Vec<String> = listed.iter().map(SecretRef::storage_key).collect();
        assert_eq!(keys, vec!["alpha/primary", "zeta/primary"]);

        // The listing is a set of *pointers*. Rendering it must be safe.
        let rendered = format!("{listed:?}");
        assert!(!rendered.contains(CANARY), "listing leaked a value: {rendered}");
    }

    // ---------------------------------------------------------------------
    // Auth::None — the rule the whole product depends on
    // ---------------------------------------------------------------------

    #[test]
    fn auth_none_sends_nothing_and_never_touches_the_keychain() {
        /// A store that panics on any access, to prove the no-auth path does
        /// not consult the keychain at all.
        struct ExplodingStore;
        impl SecretStore for ExplodingStore {
            fn set(&self, _: &SecretRef, _: &SecretValue) -> SecretResult<()> {
                panic!("a no-auth provider must never write to the keychain")
            }
            fn get(&self, _: &SecretRef) -> SecretResult<SecretValue> {
                panic!("a no-auth provider must never read the keychain")
            }
            fn delete(&self, _: &SecretRef) -> SecretResult<()> {
                panic!("a no-auth provider must never delete from the keychain")
            }
            fn contains(&self, _: &SecretRef) -> bool {
                panic!("a no-auth provider must never query the keychain")
            }
            fn list(&self) -> SecretResult<Vec<SecretRef>> {
                panic!("unused")
            }
            fn backend(&self) -> &'static str {
                "exploding"
            }
        }

        let applied = resolve_auth(&ExplodingStore, &Auth::None).unwrap();
        assert_eq!(applied, AppliedAuth::None);
        assert!(applied.is_none());
        assert_eq!(applied.header(), None);
        assert_eq!(applied.query_param(), None);
    }

    #[test]
    fn a_no_auth_provider_is_usable_end_to_end_with_an_empty_keychain() {
        let store = MemoryStore::new();
        let auth = Auth::None;
        let policy = auth.policy(AuthRequirement::NotRequired);

        assert!(!credential_present(&store, &auth));
        assert_eq!(
            check_credential(&store, &auth, &policy),
            CredentialCheck::SatisfiedWithoutCredential
        );
        assert!(check_credential(&store, &auth, &policy).is_ok());
        assert!(resolve_auth(&store, &auth).unwrap().is_none());
        assert!(store.is_empty());
    }

    #[test]
    fn a_bound_but_missing_credential_is_an_error_not_an_empty_header() {
        // The bug this prevents: `Authorization: Bearer ` (empty), which servers
        // reject with a confusing 401 instead of behaving like no header at all.
        let store = MemoryStore::new();
        let auth = Auth::for_provider("acme", &AuthMode::BearerToken).unwrap();

        match resolve_auth(&store, &auth) {
            Err(SecretError::NotFound { key }) => assert_eq!(key, "acme/primary"),
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn an_optional_credential_that_is_absent_leaves_the_provider_usable() {
        // llama.cpp started without `--api-key`: the policy says optional, the
        // keychain is empty, and the request goes out unauthenticated.
        let store = MemoryStore::new();
        let auth = Auth::None;
        let policy = auth.policy(AuthRequirement::Optional);
        assert!(check_credential(&store, &auth, &policy).is_ok());
        assert!(resolve_auth(&store, &auth).unwrap().is_none());
    }

    #[test]
    fn bearer_and_api_key_bindings_produce_the_expected_request_material() {
        let store = MemoryStore::new();
        store.set(&r("acme"), &v(CANARY)).unwrap();

        let bearer = resolve_auth(&store, &Auth::for_provider("acme", &AuthMode::BearerToken).unwrap())
            .unwrap();
        let (name, value) = bearer.header().unwrap();
        assert_eq!(name, "authorization");
        assert_eq!(value.expose(), format!("Bearer {CANARY}"));

        let header_auth = Auth::for_provider(
            "acme",
            &AuthMode::ApiKeyHeader {
                header: "X-Api-Key".into(),
            },
        )
        .unwrap();
        let applied = resolve_auth(&store, &header_auth).unwrap();
        let (name, value) = applied.header().unwrap();
        assert_eq!(name, "x-api-key");
        assert_eq!(value.expose(), CANARY);

        let query_auth =
            Auth::for_provider("acme", &AuthMode::ApiKeyQuery { param: "key".into() }).unwrap();
        let applied = resolve_auth(&store, &query_auth).unwrap();
        let (name, value) = applied.query_param().unwrap();
        assert_eq!(name, "key");
        assert_eq!(value.expose(), CANARY);
        assert_eq!(applied.header(), None);
    }

    #[test]
    fn resolved_request_material_is_redacted_when_logged() {
        let store = MemoryStore::new();
        store.set(&r("acme"), &v(CANARY)).unwrap();
        let applied =
            resolve_auth(&store, &Auth::for_provider("acme", &AuthMode::BearerToken).unwrap())
                .unwrap();

        let printed = format!("{applied:?}");
        assert!(printed.contains("authorization"), "{printed}");
        assert!(!printed.contains(CANARY), "resolved auth leaked in Debug: {printed}");
        assert!(!printed.contains("Bearer sk-"), "{printed}");
    }

    #[test]
    fn a_store_error_never_quotes_the_credential_it_failed_on() {
        let store = MemoryStore::new();
        let error = store.set(&r("acme"), &v("")).unwrap_err();
        let rendered = format!("{error} / {error:?}");
        assert!(rendered.contains("acme/primary"));
        assert!(!rendered.contains(CANARY));
    }
}
