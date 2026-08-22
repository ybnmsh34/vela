//! Domain error type. Deliberately small; the IPC layer maps these onto wire
//! error codes rather than leaking `Display` strings as protocol.

use serde::Serialize;

pub type CoreResult<T> = Result<T, CoreError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CoreError {
    /// A required credential was not supplied. Only ever produced when the
    /// provider's [`crate::auth::AuthRequirement`] is `Required`.
    #[error("provider `{provider_id}` requires a credential but none is configured")]
    MissingRequiredCredential { provider_id: String },

    /// Caller supplied a value that cannot be part of a well-formed domain
    /// object (empty id, blank endpoint, and so on).
    #[error("invalid {field}: {reason}")]
    Invalid { field: String, reason: String },

    /// Referenced entity is not registered.
    #[error("unknown provider `{provider_id}`")]
    UnknownProvider { provider_id: String },
}
