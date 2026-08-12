//! **The guarantee: a credential never lands on disk.**
//!
//! Every other test in this workspace argues about types. This one argues about
//! bytes: it drives the real settings service against a real SQLite file on a
//! real filesystem, stores a credential through the real code path, closes the
//! database, and then reads every file the store produced — the database, its
//! write-ahead log, its shared-memory index — looking for the credential.
//!
//! What this proves and does not prove:
//!
//! * **Proves:** nothing in Vela's persistence path writes a credential to
//!   disk, and the settings row records only a keychain entry *name*.
//! * **Does not prove** anything about the OS keychain. The credential store
//!   here is `MemoryStore`, so the storage half is **VERIFIED-BY-FAKE**. On a
//!   real desktop the value goes to `KeyringStore`, which was never run in this
//!   environment. See `docs/architecture/conventions.md` §10.

use std::path::Path;

use vela_core::auth::{AuthMode, AuthRequirement};
use vela_core::secret::SecretValue;
use vela_secrets::{MemoryStore, SecretStore};
use vela_settings::{ProviderConfig, SettingsService, ThemePreference};
use vela_store::{DatabaseLocation, SqliteStore, DATABASE_FILE_NAME};

/// Distinctive enough that a match cannot be a coincidence, and shaped like a
/// real credential so that any encoding of it (raw, JSON-escaped) is greppable.
const CANARY: &str = "sk-live-CANARY-2f4e6a8c0b1d3f5a7e9c-MUST-NOT-BE-ON-DISK";

/// A second canary written through the *credential* path of a provider that
/// also carries a long, awkward display name — to catch a "we stored it in the
/// label by mistake" regression.
const SECOND_CANARY: &str = "Bearer-CANARY-91b7d3e5f7a9c1e3-MUST-NOT-BE-ON-DISK";

fn read_all_bytes(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir).expect("readable temp dir").flatten() {
        let path = entry.path();
        if path.is_file() {
            let bytes = std::fs::read(&path).expect("readable file");
            files.push((path.display().to_string(), bytes));
        }
    }
    files
}

fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle.as_bytes())
}

#[test]
fn a_stored_credential_never_appears_in_any_file_the_database_writes() {
    let dir = tempfile::tempdir().unwrap();

    {
        let store = SqliteStore::open(DatabaseLocation::in_directory(dir.path())).unwrap();
        let credentials = MemoryStore::new();
        let service = SettingsService::new(&store, &credentials);

        // A remote provider that genuinely needs a key…
        let remote = ProviderConfig::local("acme", "Acme Cloud", "https://api.example.test/v1")
            .unwrap()
            .with_auth(&AuthMode::BearerToken, AuthRequirement::Required)
            .unwrap()
            .with_model("some-model");
        service.put_provider(remote).unwrap();
        service
            .set_credential("acme", &SecretValue::new(CANARY))
            .unwrap();

        // …a second one, through the api-key-header path.
        let other = ProviderConfig::local("beta", "Beta Endpoint", "https://beta.example.test/v1")
            .unwrap()
            .with_auth(
                &AuthMode::ApiKeyHeader {
                    header: "x-api-key".into(),
                },
                AuthRequirement::Optional,
            )
            .unwrap();
        service.put_provider(other).unwrap();
        service
            .set_credential("beta", &SecretValue::new(SECOND_CANARY))
            .unwrap();

        // …and a local one that needs nothing, plus an unrelated write, so the
        // database has real content rather than one row.
        service
            .put_provider(
                ProviderConfig::local("llamacpp", "llama.cpp", "http://127.0.0.1:8080/v1").unwrap(),
            )
            .unwrap();
        service.set_theme(ThemePreference::Dark).unwrap();

        // Sanity: the credentials really were stored somewhere.
        assert_eq!(credentials.len(), 2);
        assert_eq!(
            credentials
                .get(
                    service
                        .provider("acme")
                        .unwrap()
                        .unwrap()
                        .secret_ref()
                        .unwrap()
                )
                .unwrap()
                .expose(),
            CANARY
        );
    } // the store is dropped here: connection closed, WAL checkpointed.

    let files = read_all_bytes(dir.path());
    assert!(
        files
            .iter()
            .any(|(name, _)| name.ends_with(DATABASE_FILE_NAME)),
        "the database file was never created — this test would pass vacuously"
    );

    // Non-vacuity: the reference *name* is on disk, so the scan is looking in
    // the right place and would have found a value stored alongside it.
    let found_reference = files
        .iter()
        .any(|(_, bytes)| contains(bytes, "acme/primary"));
    assert!(
        found_reference,
        "expected the keychain entry NAME to be on disk; the scan is not reading the right files"
    );

    for (name, bytes) in &files {
        for canary in [CANARY, SECOND_CANARY] {
            assert!(
                !contains(bytes, canary),
                "credential material found in `{name}` — the keychain-only guarantee is broken"
            );
        }
        // Also catch the obvious near-miss encodings.
        for fragment in ["sk-live-CANARY", "Bearer-CANARY"] {
            assert!(
                !contains(bytes, fragment),
                "a fragment of a credential (`{fragment}`) found in `{name}`"
            );
        }
    }
}

#[test]
fn reopening_the_database_restores_the_configuration_but_no_credential() {
    let dir = tempfile::tempdir().unwrap();

    {
        let store = SqliteStore::open(DatabaseLocation::in_directory(dir.path())).unwrap();
        let credentials = MemoryStore::new();
        let service = SettingsService::new(&store, &credentials);
        service
            .put_provider(
                ProviderConfig::local("acme", "Acme", "https://api.example.test/v1")
                    .unwrap()
                    .with_auth(&AuthMode::BearerToken, AuthRequirement::Required)
                    .unwrap(),
            )
            .unwrap();
        service
            .set_credential("acme", &SecretValue::new(CANARY))
            .unwrap();
        service.set_theme(ThemePreference::Light).unwrap();
    }

    // A new process: the database survives, the in-memory credential store does
    // not. This is exactly the shape of a real restart with a locked keychain.
    let store = SqliteStore::open(DatabaseLocation::in_directory(dir.path())).unwrap();
    let credentials = MemoryStore::new();
    let service = SettingsService::new(&store, &credentials);

    assert_eq!(service.theme().unwrap(), ThemePreference::Light);

    let snapshot = service.snapshot().unwrap();
    assert_eq!(snapshot.providers.len(), 1);
    let view = &snapshot.providers[0];

    assert_eq!(view.config.id, "acme");
    assert_eq!(view.config.base_url.as_str(), "https://api.example.test/v1");
    assert_eq!(
        view.config.secret_ref().map(|r| r.storage_key()),
        Some("acme/primary".to_string())
    );
    // The configuration came back; the credential did not, because it was never
    // in the database to begin with.
    assert!(!view.credential_present);
    assert!(
        !view.usable,
        "a Required provider with no credential is not usable"
    );
    assert!(!snapshot.telemetry_enabled);

    let serialised = serde_json::to_string(&snapshot).unwrap();
    assert!(!serialised.contains(CANARY));
}

#[test]
fn a_local_provider_survives_a_restart_and_is_usable_with_an_empty_keychain() {
    // The whole product premise, exercised across a process boundary: no key
    // was ever stored, nothing is missing, everything works.
    let dir = tempfile::tempdir().unwrap();

    {
        let store = SqliteStore::open(DatabaseLocation::in_directory(dir.path())).unwrap();
        let credentials = MemoryStore::new();
        let service = SettingsService::new(&store, &credentials);
        service
            .put_provider(
                ProviderConfig::local("llamacpp", "llama.cpp", "http://127.0.0.1:8080/v1").unwrap(),
            )
            .unwrap();
        assert!(credentials.is_empty());
    }

    let store = SqliteStore::open(DatabaseLocation::in_directory(dir.path())).unwrap();
    let credentials = MemoryStore::new();
    let service = SettingsService::new(&store, &credentials);

    let snapshot = service.snapshot().unwrap();
    let view = &snapshot.providers[0];
    assert!(view.usable);
    assert!(!view.credential_present);
    assert_eq!(view.credential_field_label, None);
    assert!(
        !view.security.level.is_noteworthy(),
        "a loopback endpoint must not produce a security warning"
    );
    assert_eq!(credentials.list().unwrap(), Vec::new());
}
