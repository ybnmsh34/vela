//! How a configured provider is authenticated — or deliberately isn't.
//!
//! # THE LOAD-BEARING RULE OF THIS FILE
//!
//! [`Auth::None`] is a **structurally valid** configuration, not a missing
//! value. A llama.cpp or Ollama server started with no flags has no auth at
//! all, and Vela must be fully usable against it. Concretely:
//!
//! * `Auth::None` is [`Default`], so a half-filled form is a *no-auth* provider
//!   rather than an invalid one;
//! * `Auth::None` carries no [`SecretRef`], so there is nothing to look up, no
//!   keychain miss to report and **no empty `Authorization:` header to send**
//!   (an empty header is worse than none — many servers reject it outright);
//! * validation of a provider never consults the keychain unless the provider
//!   explicitly declared [`AuthRequirement::Required`].
//!
//! The other half of the rule: this enum holds *references* to credentials, never
//! credentials. [`SecretValue`](crate::secret::SecretValue) lives only in the
//! Rust core, between the keychain and an outbound request.

use serde::{Deserialize, Serialize};

use crate::auth::{AuthMode, AuthPolicy, AuthRequirement};
use crate::error::{CoreError, CoreResult};
use crate::secret::SecretRef;

/// The canonical header used for bearer-token auth. Lowercased because HTTP/2
/// requires lowercase field names and HTTP/1.1 is case-insensitive.
pub const AUTHORIZATION_HEADER: &str = "authorization";

/// A provider's configured credential binding.
///
/// Serialisable, and safe to persist: every variant contains at most a
/// [`SecretRef`], which is a lookup key (`<providerId>/<field>`), not a secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Auth {
    /// Nothing is sent. The normal state for a local runtime.
    None,
    /// `Authorization: Bearer <secret>`.
    Bearer { secret: SecretRef },
    /// A provider-named header, e.g. `x-api-key: <secret>`.
    ApiKeyHeader { header: String, secret: SecretRef },
    /// A query parameter, e.g. `?key=<secret>`. Discouraged — query strings end
    /// up in server logs — but some endpoints support nothing else.
    ApiKeyQuery { param: String, secret: SecretRef },
}

impl Default for Auth {
    /// No auth. Chosen so that *forgetting* to configure authentication yields
    /// the configuration that works with local models, not a broken one.
    fn default() -> Self {
        Auth::None
    }
}

impl Auth {
    /// Build a binding for `provider_id`'s primary credential from the
    /// transport shape the UI selected.
    ///
    /// The renderer never names keychain entries: it picks a mode, and the ref
    /// is derived here. That keeps the keychain namespace a Rust-side concern.
    pub fn for_provider(provider_id: &str, mode: &AuthMode) -> CoreResult<Self> {
        Ok(match mode {
            AuthMode::None => Auth::None,
            AuthMode::BearerToken => Auth::Bearer {
                secret: SecretRef::primary(provider_id)?,
            },
            AuthMode::ApiKeyHeader { header } => {
                let header = header.trim();
                if header.is_empty() {
                    return Err(CoreError::Invalid {
                        field: "header".into(),
                        reason: "an API-key header must be named".into(),
                    });
                }
                Auth::ApiKeyHeader {
                    header: header.to_ascii_lowercase(),
                    secret: SecretRef::primary(provider_id)?,
                }
            }
            AuthMode::ApiKeyQuery { param } => {
                let param = param.trim();
                if param.is_empty() {
                    return Err(CoreError::Invalid {
                        field: "param".into(),
                        reason: "an API-key query parameter must be named".into(),
                    });
                }
                Auth::ApiKeyQuery {
                    param: param.to_owned(),
                    secret: SecretRef::primary(provider_id)?,
                }
            }
        })
    }

    /// The transport shape, for the UI's field label and for policy checks.
    pub fn mode(&self) -> AuthMode {
        match self {
            Auth::None => AuthMode::None,
            Auth::Bearer { .. } => AuthMode::BearerToken,
            Auth::ApiKeyHeader { header, .. } => AuthMode::ApiKeyHeader {
                header: header.clone(),
            },
            Auth::ApiKeyQuery { param, .. } => AuthMode::ApiKeyQuery {
                param: param.clone(),
            },
        }
    }

    /// The keychain entry this binding points at, if any. `None` for
    /// [`Auth::None`] — there is nothing to look up, which is exactly why a
    /// no-auth provider never produces a keychain miss.
    pub fn secret_ref(&self) -> Option<&SecretRef> {
        match self {
            Auth::None => Option::None,
            Auth::Bearer { secret }
            | Auth::ApiKeyHeader { secret, .. }
            | Auth::ApiKeyQuery { secret, .. } => Some(secret),
        }
    }

    pub fn is_none(&self) -> bool {
        matches!(self, Auth::None)
    }

    /// Combine this binding with a declared requirement into a policy.
    pub fn policy(&self, requirement: AuthRequirement) -> AuthPolicy {
        AuthPolicy {
            requirement,
            mode: self.mode(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::CredentialCheck;

    #[test]
    fn no_auth_is_the_default_and_binds_no_keychain_entry() {
        let auth = Auth::default();
        assert_eq!(auth, Auth::None);
        assert!(auth.is_none());
        assert_eq!(auth.secret_ref(), None);
        assert_eq!(auth.mode(), AuthMode::None);
    }

    #[test]
    fn auth_none_round_trips_through_serialisation_as_a_valid_value() {
        // The failure this guards: a serde representation where "no auth" is
        // encoded as a null/absent field, which then deserialises into an error
        // or an Option nobody checks.
        let json = serde_json::to_string(&Auth::None).unwrap();
        assert_eq!(json, r#"{"type":"none"}"#);

        let parsed: Auth = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, Auth::None);
        assert!(parsed.policy(AuthRequirement::NotRequired).check(false).is_ok());
    }

    #[test]
    fn a_no_auth_provider_passes_its_check_with_no_credential_stored() {
        let policy = Auth::None.policy(AuthRequirement::NotRequired);
        assert_eq!(
            policy.check(false),
            CredentialCheck::SatisfiedWithoutCredential
        );
        assert!(policy.check(false).is_ok());
    }

    #[test]
    fn an_optional_credential_is_valid_whether_or_not_it_is_present() {
        let auth = Auth::for_provider("local-llamacpp", &AuthMode::BearerToken).unwrap();
        let policy = auth.policy(AuthRequirement::Optional);
        assert!(policy.check(false).is_ok(), "--api-key not set is normal");
        assert!(policy.check(true).is_ok());
    }

    #[test]
    fn bindings_are_derived_from_the_provider_id_not_supplied_by_the_caller() {
        let auth = Auth::for_provider("acme", &AuthMode::BearerToken).unwrap();
        assert_eq!(
            auth.secret_ref().map(SecretRef::storage_key),
            Some("acme/primary".to_string())
        );
    }

    #[test]
    fn header_names_are_normalised_and_must_not_be_blank() {
        let auth = Auth::for_provider(
            "acme",
            &AuthMode::ApiKeyHeader {
                header: "  X-Api-Key ".into(),
            },
        )
        .unwrap();
        match auth {
            Auth::ApiKeyHeader { ref header, .. } => assert_eq!(header, "x-api-key"),
            other => panic!("expected an api-key header binding, got {other:?}"),
        }

        assert!(Auth::for_provider(
            "acme",
            &AuthMode::ApiKeyHeader {
                header: "   ".into()
            }
        )
        .is_err());
        assert!(
            Auth::for_provider("acme", &AuthMode::ApiKeyQuery { param: "".into() }).is_err()
        );
    }

    #[test]
    fn a_serialised_binding_contains_a_reference_and_never_a_value() {
        let auth = Auth::for_provider("acme", &AuthMode::BearerToken).unwrap();
        let json = serde_json::to_string(&auth).unwrap();
        assert_eq!(
            json,
            r#"{"type":"bearer","secret":{"providerId":"acme","field":"primary"}}"#
        );
        assert!(!json.contains("value"));
    }

    #[test]
    fn debug_of_a_binding_shows_the_reference_only() {
        let printed = format!(
            "{:?}",
            Auth::for_provider("acme", &AuthMode::BearerToken).unwrap()
        );
        assert!(printed.contains("acme"));
        // There is no field that could hold one, and this asserts it stays so.
        assert!(!printed.to_lowercase().contains("sk-"));
    }
}
