//! `app_*` commands — host identity and contract negotiation.

use serde::{Deserialize, Serialize};
use tauri::State;

use super::{EmptyPayload, IpcResult, IPC_CONTRACT_VERSION};
use crate::state::AppState;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    /// The renderer compares this with its own constant and refuses to run
    /// against a mismatched host rather than failing later in odd ways.
    pub contract_version: u32,
    pub os: String,
    pub arch: String,
    /// Which credential backend is actually in use. Reported so a diagnostics
    /// screen (and any report generated from it) can state truthfully whether a
    /// real OS keychain or the in-memory fake was exercised.
    pub secret_backend: String,
}

/// Pure logic — no Tauri types, so it is testable headlessly.
pub fn app_info_of(state: &AppState) -> AppInfo {
    AppInfo {
        name: "Vela".to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
        contract_version: IPC_CONTRACT_VERSION,
        os: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
        secret_backend: state.secrets.backend().to_owned(),
    }
}

#[tauri::command]
pub fn app_info(state: State<'_, AppState>, payload: EmptyPayload) -> IpcResult<AppInfo> {
    let _ = payload;
    Ok(app_info_of(&state))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_the_contract_version_and_the_real_secret_backend() {
        let state = AppState::with_memory_store();
        let info = app_info_of(&state);
        assert_eq!(info.name, "Vela");
        assert_eq!(info.contract_version, IPC_CONTRACT_VERSION);
        assert_eq!(
            info.secret_backend, "memory-fake",
            "a fake backend must identify itself as one"
        );
        assert!(!info.os.is_empty());
    }

    #[test]
    fn app_info_serialises_camel_case() {
        let value = serde_json::to_value(app_info_of(&AppState::with_memory_store())).unwrap();
        assert!(value.get("contractVersion").is_some());
        assert!(value.get("secretBackend").is_some());
    }
}
