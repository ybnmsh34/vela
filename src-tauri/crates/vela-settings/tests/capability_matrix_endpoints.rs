//! **GATE M Part 1 — the Vela side of the capability matrix.**
//!
//! The four capability profiles run as real HTTP servers on loopback ports
//! 8101–8104 while the gate is being recorded. This test exercises the *only*
//! Vela code that can consume such an endpoint in Phase A: the configuration,
//! validation and security-posture layer.
//!
//! # The boundary, stated plainly
//!
//! Phase A ships **no HTTP client at all** — not in this crate, not in
//! `vela-providers`, not in the renderer. `no_http_client_exists_anywhere_in_the_workspace`
//! below asserts that against every `Cargo.toml` in the workspace rather than
//! asking anyone to take it on faith. So:
//!
//! * **Proved here:** Vela accepts each live endpoint's URL, treats an endpoint
//!   with **no credential** as fully usable, and reports the correct security
//!   posture for it.
//! * **Not proved here, and not provable in Phase A:** that Vela can talk to
//!   those endpoints, parse their responses, or degrade gracefully when they
//!   misbehave. Nothing in this workspace can open a socket to them yet. That
//!   is Phase B's obligation, and the transcripts under
//!   `docs/regression-baseline/mock-matrix/` are the specification it has to
//!   satisfy.
//!
//! This test needs no server running: it is about configuration, and it is
//! deterministic and offline by construction.

use std::path::Path;

use vela_core::auth::{AuthMode, AuthRequirement, CredentialCheck};
use vela_secrets::MemoryStore;
use vela_settings::{
    Concern, NetworkScope, ProviderConfig, ProviderView, RiskLevel, SettingsService,
};
use vela_store::{DatabaseLocation, SqliteStore};

/// The four live endpoints of the capability matrix, in gate order. These are
/// addresses, not capabilities: Vela deliberately cannot tell from a URL what
/// the thing behind it can do, which is why the matrix has to be recorded by
/// talking to it.
const MATRIX_ENDPOINTS: [(&str, &str); 4] = [
    ("frontier", "http://127.0.0.1:8101/v1"),
    ("mid-local", "http://127.0.0.1:8102/v1"),
    ("small-local", "http://127.0.0.1:8103/v1"),
    ("hostile", "http://127.0.0.1:8104/v1"),
];

#[test]
fn every_matrix_endpoint_is_configurable_and_usable_with_no_credential_at_all() {
    let dir = tempfile::tempdir().unwrap();
    let store = SqliteStore::open(DatabaseLocation::in_directory(dir.path())).unwrap();
    let credentials = MemoryStore::new();
    let service = SettingsService::new(&store, &credentials);

    for (profile, url) in MATRIX_ENDPOINTS {
        let config = ProviderConfig::local(profile, format!("Matrix: {profile}"), url)
            .unwrap_or_else(|error| panic!("{profile}: {url} was rejected: {error}"));
        let stored = service.put_provider(config).expect("provider is storable");

        // The keychain is completely empty. That must not make the provider
        // unusable, because most local runtimes take no credential at all.
        let view = ProviderView::of(stored, false);

        assert!(
            view.usable,
            "{profile}: an endpoint with no auth must be usable with an empty keychain"
        );
        assert_eq!(
            view.credential_check,
            CredentialCheck::SatisfiedWithoutCredential,
            "{profile}: no credential is a success state, not a failure"
        );
        assert_eq!(
            view.credential_field_label, None,
            "{profile}: the UI must render no credential field at all"
        );
        assert_eq!(view.auth_mode, AuthMode::None, "{profile}");
        assert_eq!(
            view.security.scope,
            NetworkScope::Loopback,
            "{profile}: 127.0.0.1 never leaves the machine"
        );
        assert_eq!(
            view.security.level,
            RiskLevel::None,
            "{profile}: plaintext HTTP to loopback with no credential is normal, not a risk"
        );
        assert!(
            view.security.concerns.is_empty(),
            "{profile}: nothing to warn about; observed {:?}",
            view.security.concerns
        );
    }

    // All four coexist: the matrix is four separate configured backends, and
    // nothing about one leaks into another.
    let providers = service.providers().expect("providers are listable");
    assert_eq!(providers.len(), 4);
}

#[test]
fn the_same_endpoint_moved_off_the_machine_is_reported_as_a_risk() {
    // The control for the test above: the posture is not simply always silent.
    // Identical configuration, non-loopback host.
    let config = ProviderConfig::local(
        "remote",
        "Someone else's GPU",
        "http://gpu.example.test:8101/v1",
    )
    .unwrap();
    let view = ProviderView::of(config, false);

    assert!(
        view.usable,
        "still usable — it is a risk, not a validation error"
    );
    assert_eq!(view.security.level, RiskLevel::Elevated);
    assert!(view
        .security
        .concerns
        .contains(&Concern::PlaintextTrafficLeavesDevice));
    assert!(view
        .security
        .concerns
        .contains(&Concern::RemoteEndpointIsUnauthenticated));
}

#[test]
fn a_required_credential_that_is_missing_is_the_only_unusable_configuration() {
    let config = ProviderConfig::local("needs-key", "Needs a key", "https://api.example.test/v1")
        .unwrap()
        .with_auth(&AuthMode::BearerToken, AuthRequirement::Required)
        .unwrap();

    let without = ProviderView::of(config.clone(), false);
    assert!(!without.usable);
    assert_eq!(without.credential_check, CredentialCheck::MissingRequired);

    let with = ProviderView::of(config, true);
    assert!(with.usable);
    assert_eq!(with.credential_check, CredentialCheck::Satisfied);
}

/// The Phase A boundary, machine-checked.
///
/// If this test ever fails, an HTTP client has entered the workspace — which
/// means the claim "Phase A could not dial the matrix endpoints" has stopped
/// being true and the gate evidence must be re-read in that light.
#[test]
fn no_http_client_exists_anywhere_in_the_workspace() {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("crates/<name> sits two levels below the workspace root")
        .to_path_buf();

    // Crates that would let Rust code open an HTTP connection.
    const CLIENTS: [&str; 8] = [
        "reqwest",
        "hyper",
        "ureq",
        "isahc",
        "surf",
        "attohttpc",
        "curl",
        "http-client",
    ];

    let mut manifests = Vec::new();
    let mut stack = vec![workspace.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)
            .expect("readable directory")
            .flatten()
        {
            let path = entry.path();
            let name = entry.file_name();
            if path.is_dir() {
                if name != "target" && name != "gen" && name != "node_modules" {
                    stack.push(path);
                }
            } else if name == "Cargo.toml" {
                manifests.push(path);
            }
        }
    }
    assert!(
        manifests.len() >= 6,
        "expected the host crate plus every domain crate; found {manifests:?}"
    );

    let mut offenders = Vec::new();
    for manifest in &manifests {
        let text = std::fs::read_to_string(manifest).expect("readable manifest");
        for line in text.lines() {
            let line = line.trim();
            // Only dependency declarations, not prose in comments.
            if line.starts_with('#') {
                continue;
            }
            for client in CLIENTS {
                let declares = line.starts_with(client)
                    && line[client.len()..].trim_start().starts_with(['=', '.']);
                if declares {
                    offenders.push(format!("{}: {line}", manifest.display()));
                }
            }
        }
    }

    assert!(
        offenders.is_empty(),
        "Phase A is supposed to have no HTTP client; found {offenders:#?}"
    );
}
