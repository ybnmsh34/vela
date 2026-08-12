//! Authentication policy.
//!
//! # THE LOAD-BEARING RULE OF THIS FILE
//!
//! Many local inference servers expose an OpenAI-compatible endpoint with **no
//! authentication whatsoever**. Vela treats that as a *normal, supported,
//! fully-valid* configuration — not a warning, not a "degraded" mode, not a
//! validation failure.
//!
//! Therefore: [`AuthPolicy::check`] returns a [`CredentialCheck`], and the
//! *only* variant that is an error condition is
//! [`CredentialCheck::MissingRequired`], which can only be produced when
//! [`AuthRequirement::Required`] was explicitly declared by the provider.
//! Anything else — including a provider with no credential at all — is
//! `Satisfied*`.

use serde::{Deserialize, Serialize};

/// How a credential, *if present*, is presented on the wire.
///
/// This is transport shape only. It is never shown to the UI as free text; the
/// UI renders a field label from [`AuthMode::field_label`] instead, so no
/// provider-specific string ever needs to exist in UI code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AuthMode {
    /// No credential is sent. First-class state.
    None,
    /// `Authorization: Bearer <secret>`
    BearerToken,
    /// A provider-named header, e.g. `x-api-key: <secret>`.
    ApiKeyHeader { header: String },
    /// A query parameter, e.g. `?key=<secret>`.
    ApiKeyQuery { param: String },
}

impl AuthMode {
    /// A UI-safe, provider-neutral label for the input field, if any.
    pub fn field_label(&self) -> Option<&'static str> {
        match self {
            AuthMode::None => None,
            AuthMode::BearerToken => Some("Access token"),
            AuthMode::ApiKeyHeader { .. } | AuthMode::ApiKeyQuery { .. } => Some("API key"),
        }
    }

    pub fn is_none(&self) -> bool {
        matches!(self, AuthMode::None)
    }
}

/// Whether a credential is needed at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthRequirement {
    /// The endpoint has no auth. Supplying a credential is meaningless.
    /// This is the default for local runtimes.
    NotRequired,
    /// The endpoint may or may not have auth (e.g. a llama.cpp server started
    /// with `--api-key`, or one started without). Both states are valid.
    Optional,
    /// The endpoint rejects unauthenticated requests.
    Required,
}

impl Default for AuthRequirement {
    fn default() -> Self {
        AuthRequirement::NotRequired
    }
}

/// The outcome of checking a configuration. Note there is no `Err` here for the
/// no-credential case — see the module docs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CredentialCheck {
    /// A credential is configured and will be sent.
    Satisfied,
    /// No credential is configured, and that is correct for this provider.
    /// **This is a success state.**
    SatisfiedWithoutCredential,
    /// The provider declared `Required` and nothing is configured. The only
    /// failure state.
    MissingRequired,
}

impl CredentialCheck {
    /// True for both satisfied variants. Call sites must use this rather than
    /// `== Satisfied`, or the no-auth case will be wrongly rejected.
    pub fn is_ok(self) -> bool {
        matches!(
            self,
            CredentialCheck::Satisfied | CredentialCheck::SatisfiedWithoutCredential
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthPolicy {
    pub requirement: AuthRequirement,
    pub mode: AuthMode,
}

impl AuthPolicy {
    /// The policy for an endpoint with no authentication at all.
    pub fn none() -> Self {
        Self {
            requirement: AuthRequirement::NotRequired,
            mode: AuthMode::None,
        }
    }

    /// The policy for an endpoint that *may* be protected — the common case for
    /// local runtimes that support an optional `--api-key` flag.
    pub fn optional(mode: AuthMode) -> Self {
        Self {
            requirement: AuthRequirement::Optional,
            mode,
        }
    }

    /// The policy for a hosted endpoint that always requires a credential.
    pub fn required(mode: AuthMode) -> Self {
        Self {
            requirement: AuthRequirement::Required,
            mode,
        }
    }

    /// Check a configuration. `credential_present` is a *presence boolean*, not
    /// a value: secret material is never passed through the domain layer.
    pub fn check(&self, credential_present: bool) -> CredentialCheck {
        match (self.requirement, credential_present) {
            (_, true) if !self.mode.is_none() => CredentialCheck::Satisfied,
            // A credential was stored but the mode says nothing is sent. Still
            // fine — the credential is simply unused, not an error.
            (_, true) => CredentialCheck::SatisfiedWithoutCredential,
            (AuthRequirement::Required, false) => CredentialCheck::MissingRequired,
            (AuthRequirement::NotRequired, false) | (AuthRequirement::Optional, false) => {
                CredentialCheck::SatisfiedWithoutCredential
            }
        }
    }
}

impl Default for AuthPolicy {
    fn default() -> Self {
        Self::none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_auth_endpoint_with_no_credential_is_a_success_state() {
        let policy = AuthPolicy::none();
        let check = policy.check(false);
        assert_eq!(check, CredentialCheck::SatisfiedWithoutCredential);
        assert!(check.is_ok(), "a no-auth local endpoint must be usable");
    }

    #[test]
    fn optional_auth_is_valid_both_with_and_without_a_credential() {
        let policy = AuthPolicy::optional(AuthMode::BearerToken);
        assert!(policy.check(false).is_ok());
        assert!(policy.check(true).is_ok());
        assert_eq!(policy.check(true), CredentialCheck::Satisfied);
        assert_eq!(
            policy.check(false),
            CredentialCheck::SatisfiedWithoutCredential
        );
    }

    #[test]
    fn only_an_explicitly_required_credential_can_fail() {
        let required = AuthPolicy::required(AuthMode::ApiKeyHeader {
            header: "x-api-key".into(),
        });
        assert_eq!(required.check(false), CredentialCheck::MissingRequired);
        assert!(!required.check(false).is_ok());
        assert!(required.check(true).is_ok());
    }

    #[test]
    fn default_policy_is_no_auth() {
        assert_eq!(AuthPolicy::default(), AuthPolicy::none());
        assert_eq!(AuthRequirement::default(), AuthRequirement::NotRequired);
        assert!(AuthPolicy::default().check(false).is_ok());
    }

    #[test]
    fn auth_mode_labels_are_provider_neutral() {
        assert_eq!(AuthMode::None.field_label(), None);
        assert_eq!(
            AuthMode::ApiKeyHeader {
                header: "anything".into()
            }
            .field_label(),
            Some("API key")
        );
    }
}
