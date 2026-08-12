//! `secrets_*` commands — the credential surface exposed to the renderer.
//!
//! Three commands, deliberately: **write, delete, ask-if-present**. There is no
//! read. See [`vela_core::secret`] for why.

use serde::{Deserialize, Serialize};
use tauri::State;
use vela_core::secret::{SecretField, SecretRef};
use vela_secrets::{SecretError, SecretStore};

use super::{Ack, IpcError, IpcResult};
use crate::state::AppState;

/// Upper bound on a stored credential. Long enough for any realistic token,
/// short enough that the keychain is never used as general-purpose storage.
pub const MAX_SECRET_BYTES: usize = 8192;

/// The renderer-facing form of a [`SecretRef`]. Carries no secret material.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretRefDto {
    pub provider_id: String,
    /// `None` addresses the provider's primary credential.
    #[serde(default)]
    pub field: Option<String>,
}

impl TryFrom<SecretRefDto> for SecretRef {
    type Error = IpcError;

    fn try_from(dto: SecretRefDto) -> Result<Self, Self::Error> {
        let field = match dto.field {
            None => SecretField::Primary,
            Some(name) if name == "primary" => SecretField::Primary,
            Some(name) => SecretField::Named(name),
        };
        SecretRef::new(dto.provider_id, field).map_err(IpcError::from)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsSetReq {
    #[serde(flatten)]
    pub reference: SecretRefDto,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsRefReq {
    #[serde(flatten)]
    pub reference: SecretRefDto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsStatusRes {
    /// True when a credential is stored. **False is not an error.** A provider
    /// with no credential may still be perfectly usable — the UI must consult
    /// the provider's auth policy, not this flag alone, before complaining.
    pub present: bool,
}

pub fn set(store: &dyn SecretStore, req: SecretsSetReq) -> IpcResult<Ack> {
    let reference: SecretRef = req.reference.try_into()?;
    if req.value.len() > MAX_SECRET_BYTES {
        return Err(IpcError::invalid(format!(
            "credential exceeds {MAX_SECRET_BYTES} bytes"
        )));
    }
    store.set(&reference, &req.value)?;
    Ok(Ack::ok())
}

pub fn delete(store: &dyn SecretStore, req: SecretsRefReq) -> IpcResult<Ack> {
    let reference: SecretRef = req.reference.try_into()?;
    match store.delete(&reference) {
        Ok(()) => Ok(Ack::ok()),
        // Deleting something that is not there is the desired end state, so it
        // succeeds. Only a genuinely broken backend is an error.
        Err(SecretError::NotFound { .. }) => Ok(Ack::ok()),
        Err(other) => Err(other.into()),
    }
}

pub fn status(store: &dyn SecretStore, req: SecretsRefReq) -> IpcResult<SecretsStatusRes> {
    let reference: SecretRef = req.reference.try_into()?;
    Ok(SecretsStatusRes {
        present: store.contains(&reference),
    })
}

#[tauri::command]
pub fn secrets_set(state: State<'_, AppState>, payload: SecretsSetReq) -> IpcResult<Ack> {
    set(state.secrets.as_ref(), payload)
}

#[tauri::command]
pub fn secrets_delete(state: State<'_, AppState>, payload: SecretsRefReq) -> IpcResult<Ack> {
    delete(state.secrets.as_ref(), payload)
}

#[tauri::command]
pub fn secrets_status(
    state: State<'_, AppState>,
    payload: SecretsRefReq,
) -> IpcResult<SecretsStatusRes> {
    status(state.secrets.as_ref(), payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::IpcErrorCode;
    use vela_secrets::MemoryStore;

    fn dto(provider: &str) -> SecretRefDto {
        SecretRefDto {
            provider_id: provider.into(),
            field: None,
        }
    }

    /// VERIFIED-BY-FAKE: exercised against `MemoryStore`, not a real keychain.
    #[test]
    fn set_status_delete_round_trip() {
        let store = MemoryStore::new();

        assert!(!status(&store, SecretsRefReq { reference: dto("acme") })
            .unwrap()
            .present);

        set(
            &store,
            SecretsSetReq {
                reference: dto("acme"),
                value: "sk-live-xyz".into(),
            },
        )
        .unwrap();

        assert!(status(&store, SecretsRefReq { reference: dto("acme") })
            .unwrap()
            .present);

        delete(&store, SecretsRefReq { reference: dto("acme") }).unwrap();
        assert!(!status(&store, SecretsRefReq { reference: dto("acme") })
            .unwrap()
            .present);
    }

    #[test]
    fn absent_credential_reports_present_false_and_never_errors() {
        // The rule: "no API key" is a first-class state. Asking about a
        // provider that has never had a key must succeed.
        let store = MemoryStore::new();
        let res = status(
            &store,
            SecretsRefReq {
                reference: dto("local-llamacpp"),
            },
        );
        assert_eq!(res.unwrap(), SecretsStatusRes { present: false });
    }

    #[test]
    fn deleting_an_absent_credential_succeeds_idempotently() {
        let store = MemoryStore::new();
        assert!(delete(&store, SecretsRefReq { reference: dto("nobody") }).is_ok());
    }

    #[test]
    fn oversized_and_malformed_references_are_rejected() {
        let store = MemoryStore::new();
        let too_big = set(
            &store,
            SecretsSetReq {
                reference: dto("acme"),
                value: "x".repeat(MAX_SECRET_BYTES + 1),
            },
        )
        .unwrap_err();
        assert_eq!(too_big.code, IpcErrorCode::InvalidPayload);

        let blank = set(
            &store,
            SecretsSetReq {
                reference: SecretRefDto {
                    provider_id: "  ".into(),
                    field: None,
                },
                value: "v".into(),
            },
        )
        .unwrap_err();
        assert_eq!(blank.code, IpcErrorCode::InvalidPayload);
    }

    #[test]
    fn no_response_type_in_this_module_can_carry_a_secret_value() {
        // A structural reminder rather than a clever check: if you are adding a
        // field to a `secrets_*` response, it must not be the credential.
        let json = serde_json::to_string(&SecretsStatusRes { present: true }).unwrap();
        assert_eq!(json, r#"{"present":true}"#);
    }
}
