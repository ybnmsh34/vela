//! The persisted description of one configured model backend.
//!
//! # THE LOAD-BEARING RULE OF THIS FILE
//!
//! A [`ProviderConfig`] is a row in the user's SQLite database, and **there is
//! no field in it that can hold a credential**. Auth is a
//! [`Auth`] binding: at most a `<providerId>/<field>` pointer into the OS
//! keychain. The type is the guarantee — a reviewer only has to check that no
//! new field appears here, and `tests/no_plaintext_on_disk.rs` checks the file
//! itself.
//!
//! The second rule: nothing in this struct is provider-specific. There is no
//! "is_ollama", no per-vendor sub-struct, no enum of known vendors. A backend
//! Vela has never heard of is described exactly as well as one it ships with —
//! which is the whole premise of a model-agnostic client.
//!
//! [`ProviderConfig::protocol`] is the one field that has to be argued for
//! against that rule rather than assumed compatible with it, and the argument
//! is in [`vela_core::protocol`]: a wire protocol is a *format* many parties
//! serve, not an identity, and — decisively — **the user declares it**. Nothing
//! in this crate or above it infers it from a URL, a model name, a header or a
//! response shape. A field Vela reads is not a branch Vela took.

use serde::{Deserialize, Serialize};
use vela_core::auth::{AuthMode, AuthPolicy, AuthRequirement, CredentialCheck};
use vela_core::credential::Auth;
use vela_core::protocol::WireProtocol;
use vela_core::provider::ProviderKind;
use vela_core::secret::SecretRef;

use crate::endpoint::EndpointUrl;
use crate::error::{SettingsError, SettingsResult};
use crate::security::SecurityPosture;

/// Maximum length of a user-supplied identifier or label. Generous, but the
/// database is not a text editor.
const MAX_LABEL_LEN: usize = 200;

/// One configured model backend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    /// Stable machine id, unique per user. Also the keychain namespace.
    pub id: String,
    /// What the user calls it. Free text; never parsed.
    pub display_name: String,
    pub kind: ProviderKind,
    /// Which wire protocol this endpoint speaks — **the user's declaration**,
    /// not Vela's guess. See [`vela_core::protocol`] for why an explicit field
    /// is the only shape §0.3 permits, and why the URL may not be consulted.
    ///
    /// `#[serde(default)]` so every row written before this field existed still
    /// loads, as the OpenAI-compatible client it was already built as.
    #[serde(default)]
    pub protocol: WireProtocol,
    pub base_url: EndpointUrl,
    /// The credential binding. [`Auth::None`] is valid and is the default.
    #[serde(default)]
    pub auth: Auth,
    /// Whether this endpoint needs a credential at all. Defaults to
    /// [`AuthRequirement::NotRequired`], so an incompletely filled form
    /// describes a *local, unauthenticated* backend rather than a broken one.
    #[serde(default)]
    pub auth_requirement: AuthRequirement,
    /// The model to use. `None` is normal: many servers hold exactly one model
    /// and ignore the field, and some cannot enumerate what they hold.
    #[serde(default)]
    pub model_id: Option<String>,
}

impl ProviderConfig {
    /// A local, unauthenticated backend — the configuration that must always
    /// work, expressed as the shortest constructor in the file.
    pub fn local(
        id: impl Into<String>,
        display_name: impl Into<String>,
        base_url: &str,
    ) -> SettingsResult<Self> {
        Self {
            id: id.into(),
            display_name: display_name.into(),
            kind: ProviderKind::Local,
            protocol: WireProtocol::default(),
            base_url: EndpointUrl::parse(base_url)?,
            auth: Auth::None,
            auth_requirement: AuthRequirement::NotRequired,
            model_id: None,
        }
        .validated()
    }

    /// Attach a credential binding derived from the transport shape.
    /// The keychain reference is derived from `self.id`; callers never name
    /// keychain entries themselves.
    pub fn with_auth(
        mut self,
        mode: &AuthMode,
        requirement: AuthRequirement,
    ) -> SettingsResult<Self> {
        self.auth = Auth::for_provider(&self.id, mode)?;
        self.auth_requirement = requirement;
        self.validated()
    }

    pub fn with_model(mut self, model_id: impl Into<String>) -> Self {
        self.model_id = Some(model_id.into());
        self
    }

    /// Record which wire protocol the user says this endpoint speaks.
    pub fn with_protocol(mut self, protocol: WireProtocol) -> Self {
        self.protocol = protocol;
        self
    }

    /// Enforce every invariant. Called on construction and on every write, so a
    /// row that reached the database has passed it.
    pub fn validated(self) -> SettingsResult<Self> {
        let id = self.id.trim();
        if id.is_empty() {
            return Err(SettingsError::invalid("id", "must not be blank"));
        }
        if id.len() > MAX_LABEL_LEN {
            return Err(SettingsError::invalid(
                "id",
                format!("must be at most {MAX_LABEL_LEN} characters"),
            ));
        }
        // The id becomes part of a setting key and of a keychain entry name, so
        // it must not contain the separators either of those use.
        if id.contains('/') || id.contains(char::is_whitespace) {
            return Err(SettingsError::invalid(
                "id",
                "must not contain whitespace or `/`",
            ));
        }
        if self.display_name.trim().is_empty() {
            return Err(SettingsError::invalid("displayName", "must not be blank"));
        }
        if self.display_name.len() > MAX_LABEL_LEN {
            return Err(SettingsError::invalid(
                "displayName",
                format!("must be at most {MAX_LABEL_LEN} characters"),
            ));
        }
        if let Some(model) = &self.model_id {
            if model.trim().is_empty() {
                return Err(SettingsError::invalid(
                    "modelId",
                    "must be omitted rather than blank",
                ));
            }
        }
        // A binding that points at some *other* provider's credential would let
        // one configuration read another's key.
        if let Some(reference) = self.auth.secret_ref() {
            if reference.provider_id != id {
                return Err(SettingsError::invalid(
                    "auth",
                    "credential binding must reference this provider",
                ));
            }
        }
        Ok(self)
    }

    /// The policy for this configuration: declared requirement + bound mode.
    pub fn auth_policy(&self) -> AuthPolicy {
        self.auth.policy(self.auth_requirement)
    }

    /// The keychain entry this provider uses, if any.
    pub fn secret_ref(&self) -> Option<&SecretRef> {
        self.auth.secret_ref()
    }

    /// Does this provider need a credential to work at all?
    pub fn requires_credential(&self) -> bool {
        self.auth_requirement == AuthRequirement::Required
    }

    /// Check the configuration against a *presence boolean* — never a value.
    pub fn credential_check(&self, credential_present: bool) -> CredentialCheck {
        self.auth_policy().check(credential_present)
    }

    /// Usable right now? For a local no-auth backend this is `true` with an
    /// empty keychain, which is the entire point.
    pub fn is_usable(&self, credential_present: bool) -> bool {
        self.credential_check(credential_present).is_ok()
    }

    /// The risk signal for this configuration. See [`crate::security`].
    pub fn security_posture(&self, credential_present: bool) -> SecurityPosture {
        SecurityPosture::assess(
            &self.base_url,
            &self.auth,
            credential_present,
            self.requires_credential(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::RiskLevel;

    #[test]
    fn a_local_backend_needs_nothing_but_a_url() {
        let config =
            ProviderConfig::local("llamacpp", "llama.cpp", "http://127.0.0.1:8080/v1").unwrap();

        assert_eq!(config.auth, Auth::None);
        assert_eq!(config.auth_requirement, AuthRequirement::NotRequired);
        assert_eq!(config.secret_ref(), None);
        assert!(!config.requires_credential());
        assert!(
            config.is_usable(false),
            "a local backend with an empty keychain must be usable"
        );
        assert_eq!(
            config.credential_check(false),
            CredentialCheck::SatisfiedWithoutCredential
        );
        assert_eq!(config.security_posture(false).level, RiskLevel::None);
    }

    #[test]
    fn a_config_row_has_no_field_that_can_hold_a_credential() {
        // Structural: if someone adds `api_key: String` to the struct, the key
        // set below changes and this test fails.
        let config = ProviderConfig::local("p", "P", "http://127.0.0.1:1/v1")
            .unwrap()
            .with_auth(&AuthMode::BearerToken, AuthRequirement::Required)
            .unwrap()
            .with_model("some-model");

        let json = serde_json::to_value(&config).unwrap();
        let mut keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "auth",
                "authRequirement",
                "baseUrl",
                "displayName",
                "id",
                "kind",
                "modelId",
                "protocol",
            ]
        );

        assert_eq!(json["auth"]["secret"]["providerId"], "p");
        assert_eq!(json["auth"]["secret"]["field"], "primary");

        let encoded = json.to_string();
        for forbidden in ["value", "apiKey", "token", "password", "secretValue"] {
            assert!(
                !encoded.contains(&format!(r#""{forbidden}":"#)),
                "a provider row must not carry `{forbidden}`: {encoded}"
            );
        }
    }

    #[test]
    fn auth_bindings_are_derived_from_the_provider_id() {
        let config = ProviderConfig::local("acme", "Acme", "https://api.example.test/v1")
            .unwrap()
            .with_auth(&AuthMode::BearerToken, AuthRequirement::Required)
            .unwrap();
        assert_eq!(
            config.secret_ref().map(SecretRef::storage_key),
            Some("acme/primary".to_string())
        );
        assert!(config.requires_credential());
        assert!(!config.is_usable(false));
        assert!(config.is_usable(true));
    }

    #[test]
    fn a_binding_may_not_point_at_another_providers_credential() {
        let mut config = ProviderConfig::local("mine", "Mine", "https://api.example.test").unwrap();
        config.auth = Auth::for_provider("someone-else", &AuthMode::BearerToken).unwrap();
        assert!(config.validated().is_err());
    }

    #[test]
    fn identifiers_that_would_corrupt_a_key_namespace_are_rejected() {
        assert!(ProviderConfig::local("", "X", "http://127.0.0.1:1").is_err());
        assert!(ProviderConfig::local("a/b", "X", "http://127.0.0.1:1").is_err());
        assert!(ProviderConfig::local("a b", "X", "http://127.0.0.1:1").is_err());
        assert!(ProviderConfig::local("ok", "  ", "http://127.0.0.1:1").is_err());
        assert!(ProviderConfig::local("ok", "X", "").is_err());
        assert!(ProviderConfig::local("ok", "X", "file:///etc/shadow").is_err());
    }

    #[test]
    fn a_blank_model_id_is_rejected_but_an_absent_one_is_normal() {
        let config = ProviderConfig::local("p", "P", "http://127.0.0.1:1").unwrap();
        assert_eq!(config.model_id, None);
        assert!(config.clone().validated().is_ok());

        let mut blank = config;
        blank.model_id = Some("   ".into());
        assert!(blank.validated().is_err());
    }

    #[test]
    fn a_stored_row_with_no_auth_fields_loads_as_a_no_auth_provider() {
        // Forward compatibility with the shortest possible hand-written row —
        // and proof that "no auth" is what *absence* means.
        let config: ProviderConfig = serde_json::from_str(
            r#"{"id":"p","displayName":"P","kind":"local","baseUrl":"http://127.0.0.1:11434"}"#,
        )
        .unwrap();
        assert_eq!(config.auth, Auth::None);
        assert_eq!(config.auth_requirement, AuthRequirement::NotRequired);
        assert!(config.is_usable(false));
    }

    #[test]
    fn a_stored_row_from_before_the_protocol_field_still_means_what_it_meant() {
        // The upgrade path. Every row in an existing database was built as an
        // OpenAI-compatible client; a row that loaded as anything else would
        // repoint an endpoint the user had already configured, silently, on the
        // first turn after an update.
        let config: ProviderConfig = serde_json::from_str(
            r#"{"id":"box","displayName":"Box","kind":"local","baseUrl":"http://127.0.0.1:8080/v1"}"#,
        )
        .unwrap();
        assert_eq!(config.protocol, WireProtocol::OpenAiCompatible);
    }

    #[test]
    fn the_protocol_is_carried_verbatim_and_is_never_derived_from_the_address() {
        // The §0.3 property, as an assertion rather than a promise: two
        // endpoints whose URLs point at the *same* place, differing only in what
        // the user said they speak — and the difference survives a round trip.
        // Nothing anywhere reads `baseUrl` to decide this.
        let url = "https://gateway.example.test/v1";
        let compat = ProviderConfig::local("a", "A", url).unwrap();
        let messages = ProviderConfig::local("b", "B", url)
            .unwrap()
            .with_protocol(WireProtocol::AnthropicMessages);

        assert_eq!(compat.base_url, messages.base_url);
        assert_ne!(compat.protocol, messages.protocol);

        for original in [compat, messages] {
            let encoded = serde_json::to_string(&original).unwrap();
            let decoded: ProviderConfig = serde_json::from_str(&encoded).unwrap();
            assert_eq!(decoded.protocol, original.protocol);
        }
    }

    #[test]
    fn every_protocol_produces_a_configuration_that_validates() {
        // A protocol that could be chosen and then refused would be a chooser
        // entry that cannot be saved.
        for protocol in WireProtocol::ALL {
            let config = ProviderConfig::local("p", "P", "http://127.0.0.1:8080/v1")
                .unwrap()
                .with_protocol(*protocol);
            assert_eq!(config.clone().validated().unwrap().protocol, *protocol);
        }
    }
}
