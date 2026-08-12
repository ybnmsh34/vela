//! Settings-layer errors.
//!
//! Small and closed. The IPC layer maps variants onto wire codes; nothing here
//! is meant to be parsed, and nothing here ever quotes a credential — the
//! `field` of an [`SettingsError::Invalid`] is a field *name*.

use vela_core::CoreError;
use vela_secrets::SecretError;
use vela_store::StoreError;

pub type SettingsResult<T> = Result<T, SettingsError>;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SettingsError {
    #[error("invalid {field}: {reason}")]
    Invalid { field: String, reason: String },

    #[error("no provider configured with id `{provider_id}`")]
    UnknownProvider { provider_id: String },

    /// A stored row could not be read back into the typed model. Means the file
    /// was edited by something other than Vela.
    #[error("stored settings are not readable: {reason}")]
    Corrupt { reason: String },

    #[error(transparent)]
    Store(#[from] StoreError),

    /// The keychain refused us. Distinct from "no credential stored", which is
    /// never an error in this layer.
    #[error("credential store unavailable: {reason}")]
    CredentialStoreUnavailable { reason: String },
}

impl SettingsError {
    pub fn invalid(field: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::Invalid {
            field: field.into(),
            reason: reason.into(),
        }
    }

    pub fn corrupt(reason: impl Into<String>) -> Self {
        Self::Corrupt {
            reason: reason.into(),
        }
    }
}

impl From<CoreError> for SettingsError {
    fn from(error: CoreError) -> Self {
        match error {
            CoreError::Invalid { field, reason } => Self::Invalid { field, reason },
            CoreError::UnknownProvider { provider_id } => Self::UnknownProvider { provider_id },
            CoreError::MissingRequiredCredential { provider_id } => Self::Invalid {
                field: "auth".into(),
                reason: format!("provider `{provider_id}` requires a credential"),
            },
        }
    }
}

impl From<SecretError> for SettingsError {
    /// Note what is *absent*: [`SecretError::NotFound`] does not become an
    /// error condition anywhere in this crate. A provider with no stored
    /// credential is a normal configuration, so the settings layer only ever
    /// converts a genuinely broken backend.
    fn from(error: SecretError) -> Self {
        match error {
            SecretError::NotFound { key } => Self::Invalid {
                field: "credential".into(),
                reason: format!("no credential stored for `{key}`"),
            },
            SecretError::EmptyValue { key } => Self::Invalid {
                field: "credential".into(),
                reason: format!("refusing to store an empty credential for `{key}`"),
            },
            SecretError::Unavailable { reason } => Self::CredentialStoreUnavailable { reason },
            SecretError::EnumerationUnsupported { backend } => {
                Self::CredentialStoreUnavailable {
                    reason: format!("`{backend}` cannot enumerate stored credentials"),
                }
            }
        }
    }
}
