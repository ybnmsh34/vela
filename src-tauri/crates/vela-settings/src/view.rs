//! What the renderer sees.
//!
//! A [`ProviderView`] is a [`ProviderConfig`] plus everything that has to be
//! *derived* — credential presence, usability, security posture. Deriving it
//! here rather than in the UI is what keeps rule 3 of the conventions true: the
//! renderer branches on booleans and enum variants that exist for every
//! provider, and never on which provider it is looking at.
//!
//! Nothing here can carry secret material: the only credential-shaped field is
//! [`ProviderView::credential_present`], a boolean.

use serde::{Deserialize, Serialize};
use vela_core::auth::{AuthMode, CredentialCheck};
use vela_core::protocol::WireProtocolOption;

use crate::appearance::ThemePreference;
use crate::provider_config::ProviderConfig;
use crate::security::SecurityPosture;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    #[serde(flatten)]
    pub config: ProviderConfig,
    /// A credential is stored for this provider right now.
    ///
    /// **`false` is not a problem on its own.** Read it together with
    /// `usable`: a local endpoint has no credential and is perfectly usable.
    pub credential_present: bool,
    /// The provider can be used as configured. This is the flag the UI should
    /// gate on — never `credential_present`.
    pub usable: bool,
    /// The outcome of the auth check, for a UI that wants to distinguish
    /// "authenticated" from "no auth needed".
    pub credential_check: CredentialCheck,
    /// The transport shape, so the UI can label its credential field without
    /// knowing anything about the provider.
    pub auth_mode: AuthMode,
    /// The label for that field, or `None` when the provider takes no
    /// credential and the field should not be rendered at all.
    pub credential_field_label: Option<String>,
    pub security: SecurityPosture,
}

impl ProviderView {
    pub fn of(config: ProviderConfig, credential_present: bool) -> Self {
        let auth_mode = config.auth.mode();
        Self {
            credential_present,
            usable: config.is_usable(credential_present),
            credential_check: config.credential_check(credential_present),
            credential_field_label: auth_mode.field_label().map(str::to_owned),
            security: config.security_posture(credential_present),
            auth_mode,
            config,
        }
    }
}

/// Everything a settings screen needs, in one read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    pub theme: ThemePreference,
    /// Always `false` in this build. Present so the UI can *show* that it is
    /// off rather than the user having to take it on faith.
    pub telemetry_enabled: bool,
    /// `os-keychain` or `memory-fake`. Displayed verbatim in diagnostics so a
    /// screenshot can never be mistaken for evidence about a real keychain.
    pub credential_backend: String,
    pub providers: Vec<ProviderView>,
    /// The wire protocols a user may choose from, with the words to show them.
    ///
    /// **This is what keeps conventions §0.3 true for the protocol chooser.**
    /// The renderer holds a protocol id exactly as it holds a provider id — an
    /// opaque token it forwards and never spells — so it cannot branch on one,
    /// and adding a fourth protocol is zero lines under `src/`. It draws this
    /// list; it does not know one.
    ///
    /// On the snapshot rather than behind a command of its own because this is
    /// already "everything a settings screen needs, in one read", and a second
    /// round trip for a fixed list would be a second thing to fall out of step.
    pub protocols: Vec<WireProtocolOption>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use vela_core::auth::AuthRequirement;
    use vela_core::provider::ProviderKind;

    #[test]
    fn a_local_view_tells_the_ui_to_render_no_credential_field_at_all() {
        let view = ProviderView::of(
            ProviderConfig::local("llamacpp", "llama.cpp", "http://127.0.0.1:8080").unwrap(),
            false,
        );
        assert!(view.usable);
        assert!(!view.credential_present);
        assert_eq!(view.credential_field_label, None);
        assert_eq!(view.auth_mode, AuthMode::None);
        assert_eq!(
            view.credential_check,
            CredentialCheck::SatisfiedWithoutCredential
        );
        assert!(!view.security.level.is_noteworthy());
    }

    #[test]
    fn a_remote_view_labels_its_field_without_naming_the_provider() {
        let view = ProviderView::of(
            ProviderConfig::local("acme", "Acme", "https://api.example.test")
                .unwrap()
                .with_auth(&AuthMode::BearerToken, AuthRequirement::Required)
                .unwrap(),
            false,
        );
        assert_eq!(view.credential_field_label.as_deref(), Some("Access token"));
        assert!(!view.usable);
        assert_eq!(view.credential_check, CredentialCheck::MissingRequired);
    }

    #[test]
    fn the_serialised_view_is_flat_camel_case_with_no_secret_field() {
        let view = ProviderView::of(
            ProviderConfig::local("acme", "Acme", "https://api.example.test")
                .unwrap()
                .with_auth(&AuthMode::BearerToken, AuthRequirement::Required)
                .unwrap(),
            true,
        );
        let json = serde_json::to_value(&view).unwrap();

        assert_eq!(json["id"], "acme");
        assert_eq!(json["displayName"], "Acme");
        assert_eq!(json["baseUrl"], "https://api.example.test/");
        assert_eq!(json["credentialPresent"], true);
        assert_eq!(json["usable"], true);
        assert_eq!(json["credentialCheck"], "satisfied");
        assert_eq!(json["authMode"]["type"], "bearerToken");
        assert_eq!(json["credentialFieldLabel"], "Access token");
        assert_eq!(json["security"]["level"], "none");

        // The binding names a keychain entry; it can never carry a value.
        assert_eq!(json["auth"]["secret"]["providerId"], "acme");
        assert!(json["auth"].get("value").is_none());
    }

    #[test]
    fn the_ui_can_tell_kinds_apart_without_special_casing_a_provider() {
        let view = ProviderView::of(
            ProviderConfig::local("x", "X", "http://127.0.0.1:1").unwrap(),
            false,
        );
        assert_eq!(view.config.kind, ProviderKind::Local);
        assert_eq!(
            serde_json::to_value(&view).unwrap()["kind"],
            serde_json::json!("local")
        );
    }
}
