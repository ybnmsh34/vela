//! The settings service — the one place that joins the two stores.
//!
//! Vela keeps user configuration in **two** places, on purpose:
//!
//! | What | Where | Why |
//! |---|---|---|
//! | Everything describable | SQLite, via [`SettingsRepository`] | queryable, backup-able, user-inspectable |
//! | Credential values | OS keychain, via [`SecretStore`] | encrypted at rest, revocable, never in a backup of the database |
//!
//! This service owns the join so no caller has to remember it: writing a
//! provider writes the row *and* records which keychain entry it uses; deleting
//! a provider deletes the row *and* the credential, so no orphan key is left
//! behind in the user's keychain.
//!
//! It borrows both stores rather than owning them, and is generic over the
//! settings repository, so a test can pass an in-memory SQLite database and a
//! [`vela_secrets::MemoryStore`] with no Tauri, no filesystem and no keychain.

use vela_core::secret::{SecretRef, SecretValue};
use vela_secrets::SecretStore;
use vela_store::{SecretRefName, Setting, SettingEntry, SettingsRepository};

use crate::appearance::ThemePreference;
use crate::error::{SettingsError, SettingsResult};
use crate::keys;
use crate::provider_config::ProviderConfig;
use crate::telemetry::Telemetry;
use crate::view::{ProviderView, SettingsSnapshot};

pub struct SettingsService<'a, S: SettingsRepository + ?Sized> {
    settings: &'a S,
    credentials: &'a dyn SecretStore,
}

impl<'a, S: SettingsRepository + ?Sized> SettingsService<'a, S> {
    pub fn new(settings: &'a S, credentials: &'a dyn SecretStore) -> Self {
        Self {
            settings,
            credentials,
        }
    }

    /// Which credential backend is really in use (`os-keychain` or
    /// `memory-fake`). Surfaced so a report can never imply a real keychain was
    /// exercised when it was not.
    pub fn credential_backend(&self) -> &'static str {
        self.credentials.backend()
    }

    // -- appearance --------------------------------------------------------

    /// The stored theme, or the default when nothing is stored.
    ///
    /// An unreadable row degrades to the default rather than failing: a
    /// corrupted colour preference must not stop the app from opening.
    pub fn theme(&self) -> SettingsResult<ThemePreference> {
        Ok(self
            .settings
            .get_setting(keys::THEME)?
            .and_then(|setting| serde_json::from_value(setting.value).ok())
            .unwrap_or_default())
    }

    pub fn set_theme(&self, preference: ThemePreference) -> SettingsResult<ThemePreference> {
        let value = serde_json::to_value(preference)
            .map_err(|error| SettingsError::corrupt(error.to_string()))?;
        self.settings
            .put_setting(SettingEntry::new(keys::THEME, value))?;
        Ok(preference)
    }

    // -- privacy -----------------------------------------------------------

    /// Always [`Telemetry::Disabled`] in this build. Reads the row anyway, so
    /// that a tampered row is *observed* to be disabled rather than assumed to
    /// be — see [`crate::telemetry`].
    pub fn telemetry(&self) -> SettingsResult<Telemetry> {
        Ok(self
            .settings
            .get_setting(keys::TELEMETRY)?
            .and_then(|setting| serde_json::from_value(setting.value).ok())
            .unwrap_or_default())
    }

    // -- providers ---------------------------------------------------------

    /// Every configured provider, ordered by key.
    pub fn providers(&self) -> SettingsResult<Vec<ProviderConfig>> {
        self.settings
            .list_settings(keys::PROVIDER_PREFIX)?
            .into_iter()
            .map(|setting| decode_provider(&setting))
            .collect()
    }

    pub fn provider(&self, id: &str) -> SettingsResult<Option<ProviderConfig>> {
        match self.settings.get_setting(&keys::provider(id))? {
            None => Ok(None),
            Some(setting) => decode_provider(&setting).map(Some),
        }
    }

    /// Create or replace a provider configuration.
    ///
    /// The row records the *name* of the keychain entry the provider uses (or
    /// `None` for a no-auth provider), never a credential.
    pub fn put_provider(&self, config: ProviderConfig) -> SettingsResult<ProviderConfig> {
        let config = config.validated()?;
        let value = serde_json::to_value(&config)
            .map_err(|error| SettingsError::corrupt(error.to_string()))?;

        let mut entry = SettingEntry::new(keys::provider(&config.id), value);
        if let Some(reference) = config.secret_ref() {
            entry = entry.referencing_secret(SecretRefName::from_secret_ref(reference));
        }
        self.settings.put_setting(entry)?;
        Ok(config)
    }

    /// Remove a provider and any credential it owned.
    ///
    /// The credential goes first: if the row were deleted first and the
    /// keychain delete then failed, the entry would be unreachable *and*
    /// undeletable through the UI.
    pub fn delete_provider(&self, id: &str) -> SettingsResult<()> {
        let Some(config) = self.provider(id)? else {
            return Err(SettingsError::UnknownProvider {
                provider_id: id.to_owned(),
            });
        };
        self.clear_credential_at(config.secret_ref())?;
        self.settings.delete_setting(&keys::provider(id))?;
        Ok(())
    }

    // -- credentials -------------------------------------------------------

    /// Store a credential for a configured provider.
    ///
    /// Refuses when the provider is configured to send nothing: silently
    /// storing a key that will never be used leaves the user believing they are
    /// authenticated when they are not.
    pub fn set_credential(&self, id: &str, value: &SecretValue) -> SettingsResult<()> {
        let config = self.require_provider(id)?;
        let Some(reference) = config.secret_ref() else {
            return Err(SettingsError::invalid(
                "auth",
                "this provider is configured to send no credential; \
                 change its auth mode before storing one",
            ));
        };
        self.credentials.set(reference, value)?;
        Ok(())
    }

    /// Remove a provider's credential. Idempotent: clearing a credential that
    /// is not there is the desired end state, not an error.
    pub fn clear_credential(&self, id: &str) -> SettingsResult<()> {
        let config = self.require_provider(id)?;
        self.clear_credential_at(config.secret_ref())
    }

    /// Whether a credential is stored for this provider. `false` is not an
    /// error and, for a no-auth provider, is not even a deficiency.
    pub fn credential_present(&self, config: &ProviderConfig) -> bool {
        config
            .secret_ref()
            .is_some_and(|reference| self.credentials.contains(reference))
    }

    fn clear_credential_at(&self, reference: Option<&SecretRef>) -> SettingsResult<()> {
        let Some(reference) = reference else {
            return Ok(());
        };
        match self.credentials.delete(reference) {
            Ok(()) => Ok(()),
            Err(vela_secrets::SecretError::NotFound { .. }) => Ok(()),
            Err(other) => Err(other.into()),
        }
    }

    fn require_provider(&self, id: &str) -> SettingsResult<ProviderConfig> {
        self.provider(id)?.ok_or(SettingsError::UnknownProvider {
            provider_id: id.to_owned(),
        })
    }

    // -- views -------------------------------------------------------------

    /// One provider plus everything derived from it: credential presence,
    /// usability, and the security posture. This is the shape the UI consumes.
    pub fn view(&self, config: ProviderConfig) -> ProviderView {
        let present = self.credential_present(&config);
        ProviderView::of(config, present)
    }

    /// Everything a settings screen needs, in one read.
    pub fn snapshot(&self) -> SettingsResult<SettingsSnapshot> {
        let providers = self
            .providers()?
            .into_iter()
            .map(|config| self.view(config))
            .collect();

        Ok(SettingsSnapshot {
            theme: self.theme()?,
            telemetry_enabled: self.telemetry()?.is_enabled(),
            credential_backend: self.credential_backend().to_owned(),
            providers,
            // Not stored and not configurable: it is what this build can
            // construct, which is a property of the binary rather than of the
            // user's database.
            protocols: vela_core::protocol::catalogue(),
        })
    }
}

fn decode_provider(setting: &Setting) -> SettingsResult<ProviderConfig> {
    serde_json::from_value::<ProviderConfig>(setting.value.clone()).map_err(|error| {
        SettingsError::corrupt(format!(
            "provider row `{}` is not readable: {error}",
            setting.key
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use vela_core::auth::{AuthMode, AuthRequirement};
    use vela_core::credential::Auth;
    use vela_secrets::MemoryStore;
    use vela_store::{DatabaseLocation, SqliteStore};

    const CANARY: &str = "sk-live-canary-9f2b7c41-DO-NOT-LOG";

    struct Fixture {
        store: SqliteStore,
        credentials: MemoryStore,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                store: SqliteStore::open(DatabaseLocation::InMemory).unwrap(),
                credentials: MemoryStore::new(),
            }
        }

        fn service(&self) -> SettingsService<'_, SqliteStore> {
            SettingsService::new(&self.store, &self.credentials)
        }
    }

    fn local_provider() -> ProviderConfig {
        ProviderConfig::local("llamacpp", "llama.cpp", "http://127.0.0.1:8080/v1").unwrap()
    }

    fn remote_provider() -> ProviderConfig {
        ProviderConfig::local("acme", "Acme", "https://api.example.test/v1")
            .unwrap()
            .with_auth(&AuthMode::BearerToken, AuthRequirement::Required)
            .unwrap()
    }

    #[test]
    fn theme_defaults_to_system_and_survives_a_write() {
        let fixture = Fixture::new();
        let service = fixture.service();

        assert_eq!(service.theme().unwrap(), ThemePreference::System);
        service.set_theme(ThemePreference::Dark).unwrap();
        assert_eq!(service.theme().unwrap(), ThemePreference::Dark);
        service.set_theme(ThemePreference::Light).unwrap();
        assert_eq!(service.theme().unwrap(), ThemePreference::Light);
    }

    #[test]
    fn an_unreadable_theme_row_degrades_to_the_default_rather_than_failing() {
        let fixture = Fixture::new();
        fixture
            .store
            .put_setting(SettingEntry::new(
                keys::THEME,
                serde_json::json!("chartreuse"),
            ))
            .unwrap();
        assert_eq!(fixture.service().theme().unwrap(), ThemePreference::System);
    }

    #[test]
    fn telemetry_is_disabled_with_no_row_and_stays_disabled_with_a_tampered_one() {
        let fixture = Fixture::new();
        assert!(!fixture.service().telemetry().unwrap().is_enabled());

        // Someone edits the database by hand.
        fixture
            .store
            .put_setting(SettingEntry::new(
                keys::TELEMETRY,
                serde_json::json!({ "enabled": true }),
            ))
            .unwrap();
        assert!(!fixture.service().telemetry().unwrap().is_enabled());
        assert!(!fixture.service().snapshot().unwrap().telemetry_enabled);
    }

    #[test]
    fn a_local_provider_round_trips_with_an_empty_keychain() {
        let fixture = Fixture::new();
        let service = fixture.service();

        service.put_provider(local_provider()).unwrap();

        let loaded = service.provider("llamacpp").unwrap().unwrap();
        assert_eq!(loaded, local_provider());
        assert_eq!(loaded.auth, Auth::None);
        assert!(!service.credential_present(&loaded));
        assert!(loaded.is_usable(false));

        // And no keychain entry was created for it.
        assert!(fixture.credentials.is_empty());
        assert_eq!(service.providers().unwrap().len(), 1);
    }

    #[test]
    fn a_provider_row_records_the_keychain_entry_name_and_nothing_more() {
        let fixture = Fixture::new();
        fixture.service().put_provider(remote_provider()).unwrap();

        let row = fixture
            .store
            .get_setting(&keys::provider("acme"))
            .unwrap()
            .unwrap();
        assert_eq!(
            row.secret_ref.as_ref().map(SecretRefName::as_str),
            Some("acme/primary")
        );
        assert!(!row.value.to_string().contains(CANARY));
    }

    #[test]
    fn a_no_auth_provider_row_names_no_keychain_entry() {
        let fixture = Fixture::new();
        fixture.service().put_provider(local_provider()).unwrap();

        let row = fixture
            .store
            .get_setting(&keys::provider("llamacpp"))
            .unwrap()
            .unwrap();
        assert_eq!(row.secret_ref, None);
    }

    #[test]
    fn credentials_are_stored_in_the_credential_store_not_in_the_row() {
        let fixture = Fixture::new();
        let service = fixture.service();
        service.put_provider(remote_provider()).unwrap();

        service
            .set_credential("acme", &SecretValue::new(CANARY))
            .unwrap();

        let config = service.provider("acme").unwrap().unwrap();
        assert!(service.credential_present(&config));
        assert!(config.is_usable(true));

        // The value is in the credential store, addressed by the bound ref…
        assert_eq!(
            fixture
                .credentials
                .get(config.secret_ref().unwrap())
                .unwrap()
                .expose(),
            CANARY
        );
        // …and nowhere in the settings row.
        let row = fixture
            .store
            .get_setting(&keys::provider("acme"))
            .unwrap()
            .unwrap();
        assert!(!serde_json::to_string(&row).unwrap().contains(CANARY));
    }

    #[test]
    fn storing_a_credential_for_a_no_auth_provider_is_refused_not_silently_ignored() {
        // Silently accepting it would leave the user believing the endpoint is
        // authenticated when nothing is ever sent.
        let fixture = Fixture::new();
        let service = fixture.service();
        service.put_provider(local_provider()).unwrap();

        let error = service
            .set_credential("llamacpp", &SecretValue::new(CANARY))
            .unwrap_err();
        assert!(matches!(error, SettingsError::Invalid { .. }), "{error:?}");
        assert!(fixture.credentials.is_empty());
    }

    #[test]
    fn clearing_an_absent_credential_succeeds() {
        let fixture = Fixture::new();
        let service = fixture.service();
        service.put_provider(remote_provider()).unwrap();
        assert!(service.clear_credential("acme").is_ok());
        assert!(service.clear_credential("acme").is_ok());
    }

    #[test]
    fn deleting_a_provider_takes_its_credential_with_it() {
        // Otherwise the keychain accumulates entries no UI can ever reach.
        let fixture = Fixture::new();
        let service = fixture.service();
        service.put_provider(remote_provider()).unwrap();
        service
            .set_credential("acme", &SecretValue::new(CANARY))
            .unwrap();
        assert_eq!(fixture.credentials.len(), 1);

        service.delete_provider("acme").unwrap();

        assert_eq!(service.provider("acme").unwrap(), None);
        assert!(
            fixture.credentials.is_empty(),
            "the credential outlived the provider that owned it"
        );
    }

    #[test]
    fn operations_on_an_unknown_provider_report_it_as_unknown() {
        let fixture = Fixture::new();
        let service = fixture.service();
        assert!(matches!(
            service.delete_provider("ghost"),
            Err(SettingsError::UnknownProvider { .. })
        ));
        assert!(matches!(
            service.set_credential("ghost", &SecretValue::new("x")),
            Err(SettingsError::UnknownProvider { .. })
        ));
        assert_eq!(service.provider("ghost").unwrap(), None);
    }

    #[test]
    fn a_corrupt_provider_row_is_reported_rather_than_silently_dropped() {
        let fixture = Fixture::new();
        fixture
            .store
            .put_setting(SettingEntry::new(
                keys::provider("mangled"),
                serde_json::json!({ "id": "mangled" }),
            ))
            .unwrap();
        assert!(matches!(
            fixture.service().providers(),
            Err(SettingsError::Corrupt { .. })
        ));
    }

    #[test]
    fn a_snapshot_carries_the_derived_state_the_ui_needs() {
        let fixture = Fixture::new();
        let service = fixture.service();
        service.put_provider(local_provider()).unwrap();
        service.put_provider(remote_provider()).unwrap();
        service.set_theme(ThemePreference::Dark).unwrap();

        let snapshot = service.snapshot().unwrap();
        assert_eq!(snapshot.theme, ThemePreference::Dark);
        assert!(!snapshot.telemetry_enabled);
        assert_eq!(snapshot.credential_backend, "memory-fake");
        assert_eq!(snapshot.providers.len(), 2);

        let acme = snapshot
            .providers
            .iter()
            .find(|view| view.config.id == "acme")
            .unwrap();
        assert!(!acme.credential_present);
        assert!(
            !acme.usable,
            "a Required provider with no key is not usable"
        );

        let local = snapshot
            .providers
            .iter()
            .find(|view| view.config.id == "llamacpp")
            .unwrap();
        assert!(!local.credential_present);
        assert!(local.usable, "a local no-auth provider is always usable");
        assert!(!local.security.level.is_noteworthy());
    }

    #[test]
    fn replacing_a_provider_keeps_its_credential_addressable() {
        // Renaming the display name or changing the model must not orphan the
        // key: the binding is derived from the id, which did not change.
        let fixture = Fixture::new();
        let service = fixture.service();
        service.put_provider(remote_provider()).unwrap();
        service
            .set_credential("acme", &SecretValue::new(CANARY))
            .unwrap();

        let renamed = remote_provider().with_model("some-model");
        service.put_provider(renamed).unwrap();

        let config = service.provider("acme").unwrap().unwrap();
        assert_eq!(config.model_id.as_deref(), Some("some-model"));
        assert!(service.credential_present(&config));
    }
}
