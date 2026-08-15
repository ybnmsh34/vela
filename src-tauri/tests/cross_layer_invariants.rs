//! Cross-layer invariants: the seams where the three Phase A layers meet.
//!
//! Every other integration test lives inside one crate. This one deliberately
//! spans all three — the IPC surface (`vela-app`), the system of record
//! (`vela-store` via `vela-settings`) and the credential store
//! (`vela-secrets`) — because the invariants below are properties of the
//! *assembled* application, and each layer can satisfy them alone while the
//! composition does not.
//!
//! **VERIFIED-BY-FAKE:** the credential store here is `MemoryStore`. Nothing in
//! this file says anything about a real OS keychain.

use std::sync::Arc;

use vela_core::auth::{AuthMode, AuthRequirement};
use vela_core::credential::Auth;
use vela_core::secret::SecretValue;
use vela_secrets::{resolve_auth, AppliedAuth, MemoryStore, SecretStore};
use vela_settings::{ProviderConfig, SettingsService};
use vela_store::{DatabaseLocation, SqliteStore};

use vela_lib::ipc::settings::{self as ipc_settings, SettingsPutProviderReq};
use vela_lib::ipc::EmptyPayload;
use vela_lib::provider_host::ProviderHost;
use vela_providers::http::testing::ScriptedTransport;

const CANARY: &str = "sk-live-PROBE-CANARY-abc123def456-MUST-NOT-LEAK";

/// The full integrated path for a no-auth local provider:
/// IPC request (auth field OMITTED) -> ProviderConfig -> SQLite -> read back
/// -> resolve_auth -> outbound request material.
#[test]
fn a_no_auth_provider_travels_the_whole_stack_without_producing_an_authorization_header() {
    let dir = tempfile::tempdir().unwrap();
    let store = SqliteStore::open(DatabaseLocation::in_directory(dir.path())).unwrap();
    let credentials: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());

    // The renderer omits `auth` and `authRequirement` entirely — the shape a
    // half-filled local-endpoint form actually produces.
    let json = r#"{
        "id": "llamacpp",
        "displayName": "llama.cpp",
        "kind": "local",
        "baseUrl": "http://127.0.0.1:8080/v1"
    }"#;
    let req: SettingsPutProviderReq = serde_json::from_str(json).unwrap();
    assert_eq!(
        req.auth,
        AuthMode::None,
        "omitted auth must default to None"
    );
    assert_eq!(req.auth_requirement, AuthRequirement::NotRequired);

    let providers = ProviderHost::new(
        Arc::clone(&credentials),
        Arc::new(ScriptedTransport::new(Vec::new())),
    );
    let view = ipc_settings::put_provider(&store, credentials.as_ref(), &providers, req).unwrap();
    assert!(
        providers.get("llamacpp").is_some(),
        "configuring an endpoint must make it reachable from the chat surface"
    );
    assert!(view.usable, "a no-auth local provider must be usable");
    assert!(!view.credential_present);
    assert_eq!(view.credential_field_label, None);

    // Reload from SQLite in a fresh service — proves it survived persistence.
    let service = SettingsService::new(&store, credentials.as_ref());
    let config = service.provider("llamacpp").unwrap().unwrap();
    assert_eq!(config.auth, Auth::None);
    assert_eq!(config.secret_ref(), None);

    // The header-material seam.
    let applied = resolve_auth(credentials.as_ref(), &config.auth).unwrap();
    assert_eq!(applied, AppliedAuth::None);
    assert!(applied.header().is_none(), "NO Authorization header");
    assert!(applied.query_param().is_none());

    // And the snapshot the renderer receives carries no auth header material.
    let snapshot = ipc_settings::get(&store, credentials.as_ref(), EmptyPayload {}).unwrap();
    let serialised = serde_json::to_string(&snapshot).unwrap();
    assert!(!serialised.to_lowercase().contains("authorization"));
}

/// A credential written through the IPC path must not reach SQLite, and must
/// not appear in a Debug rendering of the applied auth material.
#[test]
fn a_credential_reaches_the_keychain_and_never_sqlite_a_debug_line_or_the_renderer() {
    let dir = tempfile::tempdir().unwrap();
    let store = SqliteStore::open(DatabaseLocation::in_directory(dir.path())).unwrap();
    let credentials: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());

    let config = ProviderConfig::local("acme", "Acme", "https://api.example.test/v1")
        .unwrap()
        .with_auth(&AuthMode::BearerToken, AuthRequirement::Required)
        .unwrap();
    let service = SettingsService::new(&store, credentials.as_ref());
    service.put_provider(config).unwrap();
    service
        .set_credential("acme", &SecretValue::new(CANARY))
        .unwrap();

    let config = service.provider("acme").unwrap().unwrap();
    let applied = resolve_auth(credentials.as_ref(), &config.auth).unwrap();

    // The material is correct...
    let (name, value) = applied.header().unwrap();
    assert_eq!(name, "authorization");
    assert_eq!(value.expose(), format!("Bearer {CANARY}"));

    // ...but printing it leaks nothing.
    let printed = format!("{applied:?}");
    assert!(!printed.contains(CANARY), "leaked via Debug: {printed}");
    assert!(printed.contains("<redacted>"));

    // ...and neither does the renderer-facing snapshot.
    let snapshot = ipc_settings::get(&store, credentials.as_ref(), EmptyPayload {}).unwrap();
    let serialised = serde_json::to_string(&snapshot).unwrap();
    assert!(!serialised.contains(CANARY));
    assert!(!serialised.contains("sk-live-PROBE"));

    drop(store);

    // ...and the bytes on disk do not contain it.
    let mut checked = 0;
    for entry in std::fs::read_dir(dir.path()).unwrap().flatten() {
        let path = entry.path();
        if path.is_file() {
            let bytes = std::fs::read(&path).unwrap();
            let hit = bytes.windows(CANARY.len()).any(|w| w == CANARY.as_bytes());
            assert!(!hit, "canary found in {}", path.display());
            checked += 1;
        }
    }
    assert!(checked > 0, "vacuous: no files scanned");
}

/// **The canonical skill store has one location, and two crates now name it.**
///
/// `vela-skills` owns reading the store; `vela-projects` owns mounting from it
/// into a project. Both resolve it themselves and they do not share a constant:
/// `vela_skills::SkillStore::under_data_dir` joins `SKILL_STORE_DIRECTORY_NAME`,
/// `vela_projects::skill_store` joins a bare `"skills"` literal. They agree
/// today, and nothing but this test says they have to.
///
/// The two were developed on separate branches and only met when Phase 3 was
/// integrated, so the agreement is a coincidence of the merge rather than a
/// property either crate enforces. If either spelling moves, the host creates
/// one directory at launch and mounts from another, and the symptom is every
/// enabled skill reporting `skillNotFound` on a machine where the skill is
/// plainly installed — a failure with no error anywhere near its cause.
#[test]
fn the_skill_store_directory_is_the_same_one_in_both_crates_that_resolve_it() {
    let data_dir = std::path::Path::new("/anywhere/dev.vela.desktop");

    let mounted_from = vela_projects::skill_store(data_dir);
    let read_by = vela_skills::SkillStore::under_data_dir(data_dir)
        .root()
        .to_path_buf();

    assert_eq!(
        mounted_from, read_by,
        "the directory projects mount from and the one the skill store reads \
         have diverged; the host would create one and mount the other"
    );
    assert_eq!(mounted_from.parent().unwrap(), data_dir);
}
