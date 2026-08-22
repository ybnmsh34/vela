//! **GATE M Part 1 — the Vela side of the capability matrix.**
//!
//! The four capability profiles run as real HTTP servers on loopback ports
//! 8101–8104 while the gate is being recorded. This test exercises the *only*
//! Vela code that can consume such an endpoint in Phase A: the configuration,
//! validation and security-posture layer.
//!
//! # The boundary, stated plainly
//!
//! Phase A shipped **no HTTP client at all**. Phase B is where Vela first
//! speaks to an endpoint, so that claim has been replaced — not dropped — by a
//! narrower one that is worth more:
//! `an_http_client_exists_in_exactly_one_crate` asserts that the workspace's
//! only HTTP client lives in `vela-providers`, and
//! `the_renderer_makes_no_network_calls_of_its_own` asserts the renderer makes
//! none at all. Both are checked against the tree, not taken on faith.
//!
//! That is the shape GATE M FINDING 8 forces: the matrix endpoints send no CORS
//! headers and answer an `OPTIONS` preflight with `405`, so a browser-hosted
//! renderer *cannot* call them however the code is written. All provider HTTP
//! originates in the Rust core and reaches the renderer over the IPC bridge,
//! which is also the correct security posture.
//!
//! * **Proved here:** Vela accepts each live endpoint's URL, treats an endpoint
//!   with **no credential** as fully usable, reports the correct security
//!   posture for it, and confines network access to one crate.
//! * **Proved elsewhere:** that Vela can talk to those endpoints and degrades
//!   correctly when they misbehave — `vela-providers/tests/mock_matrix_live.rs`
//!   starts all four profiles as real processes and drives them over real TCP.
//!   Everything it proves is VERIFIED-BY-FAKE.
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

/// The network boundary, machine-checked.
///
/// Phase A's version of this test asserted that **no** crate declared an HTTP
/// client. Phase B needs one, so the assertion became stricter rather than
/// weaker: exactly one crate may declare one, and it must be `vela-providers`.
///
/// If this test fails, either a second crate has gained the ability to open a
/// socket — which means "all provider HTTP originates in one auditable place"
/// has stopped being true — or the provider crate has lost its client.
#[test]
fn an_http_client_exists_in_exactly_one_crate() {
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

    let manifests = workspace_manifests();
    assert!(
        manifests.len() >= 6,
        "expected the host crate plus every domain crate; found {manifests:?}"
    );

    let mut declaring: Vec<String> = Vec::new();
    for manifest in &manifests {
        let text = std::fs::read_to_string(manifest).expect("readable manifest");
        let declares_client = text.lines().any(|line| {
            let line = line.trim();
            // Only dependency declarations, not prose in comments.
            !line.starts_with('#')
                && CLIENTS.iter().any(|client| {
                    line.starts_with(client)
                        && line[client.len()..].trim_start().starts_with(['=', '.'])
                })
        });
        if declares_client {
            declaring.push(
                manifest
                    .parent()
                    .and_then(|dir| dir.file_name())
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            );
        }
    }
    declaring.sort();

    assert_eq!(
        declaring,
        vec!["vela-providers".to_string()],
        "the workspace's only HTTP client must live in vela-providers"
    );
}

/// The credential boundary, machine-checked — the twin of the test above, and
/// added because it was missing.
///
/// `vela-providers/src/provider.rs` opens with *"Rules that are not negotiable,
/// because a test enforces each one"*, and the fourth of those rules is **never
/// touch the OS keychain**. Three of the four had tests. This one did not: it
/// was true only because nobody had yet written `keyring = "3"` into the
/// provider crate's manifest, and nothing would have objected if they had.
///
/// A provider adapter that reached the keychain directly would bypass
/// `vela_secrets::resolve_auth` — the single function that turns an `Auth`
/// binding into request material, and the one that guarantees `Auth::None`
/// sends no `Authorization` header rather than an empty one.
#[test]
fn a_keychain_binding_exists_in_exactly_one_crate() {
    // Crates that would let Rust code read an OS credential store directly.
    const KEYCHAINS: [&str; 5] = [
        "keyring",
        "security-framework",
        "secret-service",
        "windows-credentials",
        "keytar",
    ];

    let manifests = workspace_manifests();
    assert!(
        manifests.len() >= 6,
        "expected the host crate plus every domain crate; found {manifests:?}"
    );

    let mut declaring: Vec<String> = Vec::new();
    for manifest in &manifests {
        let text = std::fs::read_to_string(manifest).expect("readable manifest");
        let declares_keychain = text.lines().any(|line| {
            let line = line.trim();
            // Dependency declarations only — the prose in these manifests names
            // the keychain repeatedly, and a substring scan would flag itself.
            !line.starts_with('#')
                && KEYCHAINS.iter().any(|crate_name| {
                    line.starts_with(crate_name)
                        && line[crate_name.len()..]
                            .trim_start()
                            .starts_with(['=', '.'])
                })
        });
        if declares_keychain {
            declaring.push(
                manifest
                    .parent()
                    .and_then(|dir| dir.file_name())
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            );
        }
    }
    declaring.sort();

    assert_eq!(
        declaring,
        vec!["vela-secrets".to_string()],
        "the OS keychain must be reachable from vela-secrets and nowhere else; \
         a provider adapter that opened it directly would route around \
         `resolve_auth`, which is what keeps `Auth::None` from sending an empty \
         `Authorization` header"
    );
}

/// GATE M FINDING 8, enforced rather than narrated: the renderer never opens a
/// connection of its own. It could not usefully do so — there are no CORS
/// headers on any matrix endpoint and `OPTIONS` is answered `405` — and it must
/// not try, because that would route model traffic around the IPC bridge and
/// around the credential rules that live behind it.
#[test]
fn the_renderer_makes_no_network_calls_of_its_own() {
    const FORBIDDEN: [&str; 5] = [
        "fetch(",
        "XMLHttpRequest",
        "EventSource",
        "WebSocket",
        "navigator.sendBeacon",
    ];

    let renderer = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("crates/<name> sits three levels below the repo root")
        .join("src");
    assert!(
        renderer.is_dir(),
        "renderer sources missing at {renderer:?}"
    );

    let mut offenders = Vec::new();
    let mut stack = vec![renderer];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)
            .expect("readable directory")
            .flatten()
        {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let is_source = path
                .extension()
                .is_some_and(|extension| extension == "ts" || extension == "tsx");
            if !is_source {
                continue;
            }
            let text = std::fs::read_to_string(&path).expect("readable source");
            for (number, line) in text.lines().enumerate() {
                let code = line.split("//").next().unwrap_or("");
                for needle in FORBIDDEN {
                    if code.contains(needle) {
                        offenders.push(format!("{}:{}: {needle}", path.display(), number + 1));
                    }
                }
            }
        }
    }

    assert!(
        offenders.is_empty(),
        "the renderer must reach a model only through the IPC bridge; found {offenders:#?}"
    );
}

/// Shared walk: every `Cargo.toml` in the workspace.
fn workspace_manifests() -> Vec<std::path::PathBuf> {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("crates/<name> sits two levels below the workspace root")
        .to_path_buf();

    let mut manifests = Vec::new();
    let mut stack = vec![workspace];
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
    manifests
}
