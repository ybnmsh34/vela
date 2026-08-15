//! The single error shape crossing the IPC boundary.
//!
//! Every command returns `Result<T, IpcError>`. Tauri serialises `Err` into a
//! rejected promise, so the renderer receives exactly this JSON object and
//! nothing else. In particular the renderer never sees a Rust panic message, a
//! file path, or a provider's raw response body.

use serde::Serialize;

/// Machine-readable failure classes. The renderer switches on `code`; `message`
/// is for logs and for a fallback English string, never for control flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum IpcErrorCode {
    /// Payload failed to deserialise or violated a domain invariant.
    InvalidPayload,
    /// The addressed entity does not exist.
    NotFound,
    /// The OS keychain is present but refused the operation.
    SecretStoreUnavailable,
    /// The command exists but the current build/platform cannot serve it.
    Unsupported,
    /// Anything unexpected. Details are logged host-side, not returned.
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{code:?}: {message}")]
pub struct IpcError {
    pub code: IpcErrorCode,
    pub message: String,
}

pub type IpcResult<T> = Result<T, IpcError>;

impl IpcError {
    pub fn new(code: IpcErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(IpcErrorCode::InvalidPayload, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(IpcErrorCode::NotFound, message)
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(IpcErrorCode::Unsupported, message)
    }
}

impl From<vela_core::CoreError> for IpcError {
    fn from(error: vela_core::CoreError) -> Self {
        use vela_core::CoreError;
        match error {
            CoreError::Invalid { .. } | CoreError::MissingRequiredCredential { .. } => {
                IpcError::invalid(error.to_string())
            }
            CoreError::UnknownProvider { .. } => IpcError::not_found(error.to_string()),
        }
    }
}

impl From<vela_secrets::SecretError> for IpcError {
    fn from(error: vela_secrets::SecretError) -> Self {
        use vela_secrets::SecretError;
        match error {
            SecretError::NotFound { .. } => IpcError::not_found(error.to_string()),
            SecretError::EmptyValue { .. } => IpcError::invalid(error.to_string()),
            SecretError::Unavailable { .. } => {
                IpcError::new(IpcErrorCode::SecretStoreUnavailable, error.to_string())
            }
            // A real platform keychain cannot enumerate its contents. That is a
            // property of the backend, not a fault on this machine, so it is
            // `UNSUPPORTED` rather than "your keychain is broken". No command
            // enumerates credentials today; this keeps the mapping honest if
            // one ever tries.
            SecretError::EnumerationUnsupported { .. } => IpcError::unsupported(error.to_string()),
        }
    }
}

impl From<vela_store::StoreError> for IpcError {
    fn from(error: vela_store::StoreError) -> Self {
        use vela_store::StoreError;
        match error {
            StoreError::NotFound { .. } => IpcError::not_found(error.to_string()),
            StoreError::Invalid { .. } | StoreError::Constraint { .. } => {
                IpcError::invalid(error.to_string())
            }
            // Schema, I/O and backend failures are host-side facts. The
            // renderer gets the class, never the path or the SQLite message.
            StoreError::SchemaAhead { .. }
            | StoreError::MigrationChanged { .. }
            | StoreError::Corrupt { .. }
            | StoreError::Io { .. }
            // A privacy refusal names a host-side path and the local accounts
            // that can reach it. It is the single most useful thing to put in
            // front of the *user*, and the single worst thing to hand the
            // *renderer*, which is a web view. It reaches the user through
            // startup failing loudly, not through this seam.
            | StoreError::NotPrivate { .. }
            | StoreError::Backend { .. } => IpcError::new(
                IpcErrorCode::Internal,
                "the local database could not be read",
            ),
        }
    }
}

impl From<vela_settings::SettingsError> for IpcError {
    fn from(error: vela_settings::SettingsError) -> Self {
        use vela_settings::SettingsError;
        match error {
            SettingsError::Invalid { .. } => IpcError::invalid(error.to_string()),
            SettingsError::UnknownProvider { .. } => IpcError::not_found(error.to_string()),
            SettingsError::CredentialStoreUnavailable { .. } => {
                IpcError::new(IpcErrorCode::SecretStoreUnavailable, error.to_string())
            }
            SettingsError::Corrupt { reason } => IpcError::new(
                IpcErrorCode::Internal,
                format!("stored settings are not readable: {reason}"),
            ),
            SettingsError::Store(inner) => inner.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vela_secrets::SecretError;

    #[test]
    fn error_serialises_to_the_documented_wire_shape() {
        let json = serde_json::to_value(IpcError::invalid("bad")).unwrap();
        assert_eq!(json["code"], "INVALID_PAYLOAD");
        assert_eq!(json["message"], "bad");
        assert_eq!(json.as_object().unwrap().len(), 2);
    }

    #[test]
    fn a_missing_credential_is_not_reported_as_a_broken_keychain() {
        // These two must stay distinguishable: "you have no key stored" is a
        // normal state, "your keychain refused us" is a real problem.
        let missing: IpcError = SecretError::NotFound {
            key: "p/primary".into(),
        }
        .into();
        let broken: IpcError = SecretError::Unavailable {
            reason: "locked".into(),
        }
        .into();
        assert_eq!(missing.code, IpcErrorCode::NotFound);
        assert_eq!(broken.code, IpcErrorCode::SecretStoreUnavailable);
    }

    #[test]
    fn a_database_failure_never_leaks_a_path_or_a_sqlite_message_to_the_renderer() {
        let error: IpcError = vela_store::StoreError::Io {
            path: "/home/someone/.local/share/dev.vela.desktop/vela.db".into(),
            reason: "permission denied".into(),
        }
        .into();
        assert_eq!(error.code, IpcErrorCode::Internal);
        assert!(!error.message.contains("/home/someone"));
        assert!(!error.message.contains("permission denied"));
    }

    #[test]
    fn a_settings_validation_failure_is_reported_as_an_invalid_payload() {
        let error: IpcError =
            vela_settings::SettingsError::invalid("baseUrl", "must not be blank").into();
        assert_eq!(error.code, IpcErrorCode::InvalidPayload);

        let unknown: IpcError = vela_settings::SettingsError::UnknownProvider {
            provider_id: "ghost".into(),
        }
        .into();
        assert_eq!(unknown.code, IpcErrorCode::NotFound);
    }
}
