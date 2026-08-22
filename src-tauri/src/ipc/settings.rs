//! `settings_*` commands — appearance, privacy, and provider configuration.
//!
//! ## What is deliberately absent
//!
//! * **No command writes telemetry.** There is no `settings_set_telemetry`,
//!   and [`tests::no_command_in_this_module_can_enable_telemetry`] asserts it.
//!   `settings_get` reports `telemetryEnabled: false` so the UI can *show* the
//!   user it is off; nothing can change it. See [`vela_settings::telemetry`].
//! * **No command carries a credential.** Provider configuration and credential
//!   storage are separate surfaces on purpose: a provider row travels through
//!   these commands, and the value travels through `secrets_set` to the OS
//!   keychain. A provider's credential lives at the reference
//!   `{ providerId: <id> }` — the same id used here — so the renderer never has
//!   to know how keychain entries are named.
//!
//! ## The two stores
//!
//! These commands are the one place in the host that touches both the SQLite
//! system of record and the credential store. The join lives in
//! [`vela_settings::SettingsService`]; the commands below are the usual thin
//! adapters over it.
//!
//! ## …and the live provider set
//!
//! [`put_provider`] and [`delete_provider`] take a [`ProviderHost`] as well.
//! **That is deliberate and it is not optional.** Before this parameter
//! existed, `settings_put_provider` wrote a row and stopped: the registry that
//! `chat_send` resolves against was never touched, so the renderer displayed a
//! configured endpoint that every turn answered `NOT_FOUND` for. Writing the
//! row and building the client are one operation, so they take one function —
//! there is no second door through which a provider can be configured without
//! becoming reachable.

use serde::{Deserialize, Serialize};
use tauri::State;
use vela_core::auth::{AuthMode, AuthRequirement};
use vela_core::credential::Auth;
use vela_core::protocol::WireProtocol;
use vela_core::provider::ProviderKind;
use vela_secrets::SecretStore;
use vela_settings::endpoint::EndpointUrl;
use vela_settings::{
    ProviderConfig, ProviderView, SettingsService, SettingsSnapshot, ThemePreference,
};
use vela_store::SettingsRepository;

use super::{Ack, EmptyPayload, IpcError, IpcResult};
use crate::provider_host::ProviderHost;
use crate::state::AppState;
use crate::store_host::StoreHandle;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSetThemeReq {
    pub theme: ThemePreference,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSetThemeRes {
    pub theme: ThemePreference,
}

/// A provider configuration as the renderer supplies it.
///
/// Note what the renderer does *not* supply: the keychain entry name (derived
/// from `id` in the core) and the credential itself (never on this path).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPutProviderReq {
    pub id: String,
    pub display_name: String,
    pub kind: ProviderKind,
    /// Which wire protocol the user says this endpoint speaks, chosen from the
    /// list `settings_get` hands the form. Omitting it means the shape most
    /// local runtimes serve, which is what every row written before this field
    /// existed already was.
    ///
    /// This command **passes the value through**. It does not read it, does not
    /// compare it to anything, and — the part that matters — does not derive it
    /// from `base_url`. The one place it is read is the composition root, which
    /// is not the boundary and is not the UI.
    #[serde(default)]
    pub protocol: WireProtocol,
    pub base_url: String,
    #[serde(default)]
    pub model_id: Option<String>,
    /// Omit for an endpoint with no authentication — the common local case.
    #[serde(default)]
    pub auth: AuthMode,
    /// Omit for "no credential needed". Only `required` can ever make a
    /// configuration invalid.
    #[serde(default)]
    pub auth_requirement: AuthRequirement,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsProviderRefReq {
    pub provider_id: String,
}

impl TryFrom<SettingsPutProviderReq> for ProviderConfig {
    type Error = IpcError;

    fn try_from(req: SettingsPutProviderReq) -> Result<Self, Self::Error> {
        let id = req.id.trim().to_owned();
        let config = ProviderConfig {
            auth: Auth::for_provider(&id, &req.auth)?,
            id,
            display_name: req.display_name,
            kind: req.kind,
            protocol: req.protocol,
            base_url: EndpointUrl::parse(&req.base_url)?,
            auth_requirement: req.auth_requirement,
            model_id: req.model_id.map(|model| model.trim().to_owned()),
        };
        Ok(config.validated()?)
    }
}

// ---------------------------------------------------------------------------
// Logic — plain functions over the two stores, unit-testable with no Tauri.
// ---------------------------------------------------------------------------

pub fn get<S: SettingsRepository + ?Sized>(
    settings: &S,
    credentials: &dyn SecretStore,
    _req: EmptyPayload,
) -> IpcResult<SettingsSnapshot> {
    Ok(SettingsService::new(settings, credentials).snapshot()?)
}

pub fn set_theme<S: SettingsRepository + ?Sized>(
    settings: &S,
    credentials: &dyn SecretStore,
    req: SettingsSetThemeReq,
) -> IpcResult<SettingsSetThemeRes> {
    let theme = SettingsService::new(settings, credentials).set_theme(req.theme)?;
    Ok(SettingsSetThemeRes { theme })
}

/// Writes the provider row **and** makes the endpoint reachable.
///
/// Order matters: the row is written first, so a client that cannot be built
/// leaves the user's configuration intact rather than silently discarding what
/// they typed. The build failure then propagates, because a configuration that
/// produced no client is exactly the state the renderer must not draw as ready.
///
/// This also covers *edit*: re-putting an id rebuilds its provider, so changing
/// a base URL or an auth binding takes effect on the next turn instead of the
/// next restart.
pub fn put_provider<S: SettingsRepository + ?Sized>(
    settings: &S,
    credentials: &dyn SecretStore,
    providers: &ProviderHost,
    req: SettingsPutProviderReq,
) -> IpcResult<ProviderView> {
    let service = SettingsService::new(settings, credentials);
    let config = service.put_provider(ProviderConfig::try_from(req)?)?;
    providers.install(&config)?;
    Ok(service.view(config))
}

/// Removes the provider row, its credential, **and** the live client.
///
/// The unregistration happens after the delete succeeds: a `NOT_FOUND` for an
/// id that was never configured must not tear down a provider that is.
pub fn delete_provider<S: SettingsRepository + ?Sized>(
    settings: &S,
    credentials: &dyn SecretStore,
    providers: &ProviderHost,
    req: SettingsProviderRefReq,
) -> IpcResult<Ack> {
    SettingsService::new(settings, credentials).delete_provider(&req.provider_id)?;
    providers.forget(&req.provider_id);
    Ok(Ack::ok())
}

// ---------------------------------------------------------------------------
// Commands — thin adapters. Nothing but extraction and delegation.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn settings_get(
    state: State<'_, AppState>,
    store: State<'_, StoreHandle>,
    payload: EmptyPayload,
) -> IpcResult<SettingsSnapshot> {
    get(store.store(), state.secrets.as_ref(), payload)
}

#[tauri::command]
pub fn settings_set_theme(
    state: State<'_, AppState>,
    store: State<'_, StoreHandle>,
    payload: SettingsSetThemeReq,
) -> IpcResult<SettingsSetThemeRes> {
    set_theme(store.store(), state.secrets.as_ref(), payload)
}

#[tauri::command]
pub fn settings_put_provider(
    state: State<'_, AppState>,
    store: State<'_, StoreHandle>,
    payload: SettingsPutProviderReq,
) -> IpcResult<ProviderView> {
    put_provider(
        store.store(),
        state.secrets.as_ref(),
        state.providers.as_ref(),
        payload,
    )
}

#[tauri::command]
pub fn settings_delete_provider(
    state: State<'_, AppState>,
    store: State<'_, StoreHandle>,
    payload: SettingsProviderRefReq,
) -> IpcResult<Ack> {
    delete_provider(
        store.store(),
        state.secrets.as_ref(),
        state.providers.as_ref(),
        payload,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::secrets::{self, SecretRefDto, SecretsSetReq};
    use crate::ipc::{IpcErrorCode, COMMAND_ALLOWLIST};
    use vela_secrets::MemoryStore;
    use vela_settings::{Concern, RiskLevel};
    use vela_store::{DatabaseLocation, SqliteStore};

    struct Host {
        store: SqliteStore,
        credentials: MemoryStore,
        providers: ProviderHost,
    }

    impl Host {
        /// VERIFIED-BY-FAKE: an in-memory database, an in-memory credential
        /// store and a transport with no script behind it. No file, no
        /// keychain, no socket.
        fn new() -> Self {
            Self {
                store: SqliteStore::open(DatabaseLocation::InMemory).unwrap(),
                credentials: MemoryStore::new(),
                providers: ProviderHost::new(
                    std::sync::Arc::new(MemoryStore::new()),
                    std::sync::Arc::new(vela_providers::http::testing::ScriptedTransport::new(
                        Vec::new(),
                    )),
                ),
            }
        }

        fn get(&self) -> IpcResult<SettingsSnapshot> {
            get(&self.store, &self.credentials, EmptyPayload {})
        }

        fn put(&self, req: SettingsPutProviderReq) -> IpcResult<ProviderView> {
            put_provider(&self.store, &self.credentials, &self.providers, req)
        }
    }

    fn local_request() -> SettingsPutProviderReq {
        SettingsPutProviderReq {
            id: "llamacpp".into(),
            display_name: "llama.cpp".into(),
            kind: ProviderKind::Local,
            protocol: WireProtocol::default(),
            base_url: "http://127.0.0.1:8080/v1".into(),
            model_id: None,
            auth: AuthMode::None,
            auth_requirement: AuthRequirement::NotRequired,
        }
    }

    #[test]
    fn a_provider_payload_with_no_auth_fields_at_all_is_accepted() {
        // The minimum a user can type for a local runtime. If this ever starts
        // failing, Vela has stopped working with local models.
        let req: SettingsPutProviderReq = serde_json::from_str(
            r#"{"id":"ollama","displayName":"Ollama","kind":"local",
                "baseUrl":"http://127.0.0.1:11434"}"#,
        )
        .unwrap();
        assert_eq!(req.auth, AuthMode::None);
        assert_eq!(req.auth_requirement, AuthRequirement::NotRequired);

        let host = Host::new();
        let view = host.put(req).unwrap();
        assert!(view.usable);
        assert!(!view.credential_present);
        assert_eq!(view.credential_field_label, None);
        assert_eq!(view.security.level, RiskLevel::None);
    }

    #[test]
    fn settings_start_at_their_defaults_with_an_empty_database() {
        let snapshot = Host::new().get().unwrap();
        assert_eq!(snapshot.theme, ThemePreference::System);
        assert!(!snapshot.telemetry_enabled);
        assert!(snapshot.providers.is_empty());
        assert_eq!(snapshot.credential_backend, "memory-fake");
    }

    #[test]
    fn the_theme_round_trips_through_the_command_pair() {
        let host = Host::new();
        let res = set_theme(
            &host.store,
            &host.credentials,
            SettingsSetThemeReq {
                theme: ThemePreference::Dark,
            },
        )
        .unwrap();
        assert_eq!(res.theme, ThemePreference::Dark);
        assert_eq!(host.get().unwrap().theme, ThemePreference::Dark);
    }

    #[test]
    fn a_credential_stored_through_the_secrets_command_shows_up_as_present() {
        // The two surfaces meet here: `settings_put_provider` describes the
        // provider, `secrets_set` stores the value, and `settings_get` reports
        // presence without ever returning it.
        let host = Host::new();
        host.put(SettingsPutProviderReq {
            id: "acme".into(),
            display_name: "Acme".into(),
            kind: ProviderKind::RemoteApi,
            protocol: WireProtocol::default(),
            base_url: "https://api.example.test/v1".into(),
            model_id: Some("some-model".into()),
            auth: AuthMode::BearerToken,
            auth_requirement: AuthRequirement::Required,
        })
        .unwrap();

        let before = &host.get().unwrap().providers[0];
        assert!(!before.credential_present);
        assert!(!before.usable);
        assert_eq!(
            before.security.concerns,
            vec![Concern::RequiredCredentialMissing]
        );

        secrets::set(
            &host.credentials,
            SecretsSetReq {
                reference: SecretRefDto {
                    provider_id: "acme".into(),
                    field: None,
                },
                value: "sk-live-canary-DO-NOT-LOG".into(),
            },
        )
        .unwrap();

        let after = &host.get().unwrap().providers[0];
        assert!(after.credential_present);
        assert!(after.usable);
        assert!(after.security.concerns.is_empty());

        // And the snapshot still carries no credential material.
        let json = serde_json::to_string(&host.get().unwrap()).unwrap();
        assert!(!json.contains("sk-live-canary"));
    }

    #[test]
    fn deleting_a_provider_also_removes_its_credential_from_the_store() {
        let host = Host::new();
        host.put(SettingsPutProviderReq {
            id: "acme".into(),
            display_name: "Acme".into(),
            kind: ProviderKind::RemoteApi,
            protocol: WireProtocol::default(),
            base_url: "https://api.example.test/v1".into(),
            model_id: None,
            auth: AuthMode::BearerToken,
            auth_requirement: AuthRequirement::Required,
        })
        .unwrap();
        secrets::set(
            &host.credentials,
            SecretsSetReq {
                reference: SecretRefDto {
                    provider_id: "acme".into(),
                    field: None,
                },
                value: "sk-live-canary-DO-NOT-LOG".into(),
            },
        )
        .unwrap();
        assert_eq!(host.credentials.len(), 1);

        delete_provider(
            &host.store,
            &host.credentials,
            &host.providers,
            SettingsProviderRefReq {
                provider_id: "acme".into(),
            },
        )
        .unwrap();

        assert!(host.get().unwrap().providers.is_empty());
        assert!(
            host.credentials.is_empty(),
            "the keychain entry was orphaned"
        );
    }

    #[test]
    fn deleting_a_provider_that_does_not_exist_is_reported_as_not_found() {
        let host = Host::new();
        let error = delete_provider(
            &host.store,
            &host.credentials,
            &host.providers,
            SettingsProviderRefReq {
                provider_id: "ghost".into(),
            },
        )
        .unwrap_err();
        assert_eq!(error.code, IpcErrorCode::NotFound);
    }

    /// **The regression this whole module was rewritten for.** A row in the
    /// database with nothing behind it is what made the shipping application
    /// answer `NOT_FOUND` for an endpoint the UI drew as configured.
    #[test]
    fn configuring_a_provider_makes_it_reachable_and_deleting_it_makes_it_unreachable() {
        let host = Host::new();
        assert!(
            host.providers.get("llamacpp").is_none(),
            "nothing is registered before anything is configured"
        );

        host.put(local_request()).unwrap();
        let provider = host
            .providers
            .get("llamacpp")
            .expect("a configured provider must be resolvable by the chat surface");
        assert_eq!(provider.descriptor().id, "llamacpp");

        delete_provider(
            &host.store,
            &host.credentials,
            &host.providers,
            SettingsProviderRefReq {
                provider_id: "llamacpp".into(),
            },
        )
        .unwrap();
        assert!(
            host.providers.get("llamacpp").is_none(),
            "a deleted provider must stop answering turns"
        );
    }

    #[test]
    fn editing_a_provider_rebuilds_it_rather_than_leaving_the_old_endpoint_live() {
        let host = Host::new();
        host.put(local_request()).unwrap();
        let before = host.providers.get("llamacpp").unwrap();

        let mut edited = local_request();
        edited.base_url = "http://127.0.0.1:9999/v1".into();
        host.put(edited).unwrap();

        let after = host.providers.get("llamacpp").unwrap();
        assert!(
            !std::sync::Arc::ptr_eq(&before, &after),
            "a corrected base URL must not keep sending turns to the old address"
        );
        assert_eq!(host.providers.len(), 1, "an edit is not a second provider");
    }

    #[test]
    fn a_rejected_configuration_registers_nothing() {
        let host = Host::new();
        let mut bad = local_request();
        bad.base_url = "file:///etc/passwd".into();
        host.put(bad).unwrap_err();
        assert!(
            host.providers.is_empty(),
            "an invalid configuration must not leave a live client behind"
        );
    }

    #[test]
    fn malformed_provider_payloads_are_rejected_as_invalid_payload() {
        let host = Host::new();
        for (label, mutate) in [
            (
                "blank id",
                Box::new(|req: &mut SettingsPutProviderReq| req.id = "  ".into())
                    as Box<dyn Fn(&mut SettingsPutProviderReq)>,
            ),
            (
                "a file url",
                Box::new(|req: &mut SettingsPutProviderReq| {
                    req.base_url = "file:///etc/passwd".into()
                }),
            ),
            (
                "no url",
                Box::new(|req: &mut SettingsPutProviderReq| req.base_url = String::new()),
            ),
            (
                "blank display name",
                Box::new(|req: &mut SettingsPutProviderReq| req.display_name = " ".into()),
            ),
            (
                "an unnamed api-key header",
                Box::new(|req: &mut SettingsPutProviderReq| {
                    req.auth = AuthMode::ApiKeyHeader { header: "".into() }
                }),
            ),
        ] {
            let mut req = local_request();
            mutate(&mut req);
            let error = host.put(req).unwrap_err();
            assert_eq!(
                error.code,
                IpcErrorCode::InvalidPayload,
                "`{label}` should be rejected as an invalid payload"
            );
        }
    }

    #[test]
    fn a_remote_plaintext_endpoint_reports_a_risk_the_ui_can_render() {
        // The signal exists so the UI can warn. It must be present in the
        // response, and it must be provider-neutral.
        let host = Host::new();
        let view = host
            .put(SettingsPutProviderReq {
                id: "lab".into(),
                display_name: "Lab box".into(),
                kind: ProviderKind::Local,
                protocol: WireProtocol::default(),
                base_url: "http://192.168.1.50:8080/v1".into(),
                model_id: None,
                auth: AuthMode::None,
                auth_requirement: AuthRequirement::NotRequired,
            })
            .unwrap();

        assert_eq!(view.security.level, RiskLevel::Elevated);
        assert!(view.security.leaves_device);
        assert!(view
            .security
            .concerns
            .contains(&Concern::PlaintextTrafficLeavesDevice));
        // Still usable — a risk is a thing to tell the user, not a veto.
        assert!(view.usable);
    }

    #[test]
    fn the_snapshot_json_is_camel_case_and_carries_no_provider_specific_shape() {
        let host = Host::new();
        host.put(local_request()).unwrap();
        let json = serde_json::to_value(host.get().unwrap()).unwrap();

        assert_eq!(json["telemetryEnabled"], false);
        assert_eq!(json["credentialBackend"], "memory-fake");
        let provider = &json["providers"][0];
        assert_eq!(provider["id"], "llamacpp");
        assert_eq!(provider["baseUrl"], "http://127.0.0.1:8080/v1");
        assert_eq!(provider["credentialPresent"], false);
        assert_eq!(provider["usable"], true);
        assert_eq!(provider["security"]["level"], "none");
        assert_eq!(provider["authMode"]["type"], "none");
        assert!(provider["credentialFieldLabel"].is_null());
    }

    #[test]
    fn no_command_in_this_module_can_enable_telemetry() {
        // Structural: telemetry is not writable over IPC at all, so there is no
        // command a compromised or buggy renderer could call to switch it on.
        for name in COMMAND_ALLOWLIST {
            assert!(
                !name.contains("telemetry"),
                "`{name}` would make telemetry renderer-writable"
            );
        }
        let source = include_str!("settings.rs");
        let production = source.split("#[cfg(test)]").next().unwrap();
        assert!(
            !production.contains("Telemetry::Enabled"),
            "no command may construct an enabled telemetry setting"
        );
    }

    #[test]
    fn no_settings_response_type_can_carry_a_credential() {
        // Every response this module can produce, serialised with a credential
        // in the store, and checked for the value.
        let host = Host::new();
        host.put(SettingsPutProviderReq {
            id: "acme".into(),
            display_name: "Acme".into(),
            kind: ProviderKind::RemoteApi,
            protocol: WireProtocol::default(),
            base_url: "https://api.example.test/v1".into(),
            model_id: None,
            auth: AuthMode::BearerToken,
            auth_requirement: AuthRequirement::Required,
        })
        .unwrap();
        secrets::set(
            &host.credentials,
            SecretsSetReq {
                reference: SecretRefDto {
                    provider_id: "acme".into(),
                    field: None,
                },
                value: "sk-live-canary-DO-NOT-LOG".into(),
            },
        )
        .unwrap();

        let responses = [
            serde_json::to_string(&host.get().unwrap()).unwrap(),
            serde_json::to_string(&host.put(local_request()).unwrap()).unwrap(),
            serde_json::to_string(
                &set_theme(
                    &host.store,
                    &host.credentials,
                    SettingsSetThemeReq {
                        theme: ThemePreference::Light,
                    },
                )
                .unwrap(),
            )
            .unwrap(),
        ];
        for response in responses {
            assert!(
                !response.contains("sk-live-canary"),
                "a settings response carried credential material: {response}"
            );
        }
    }
}
