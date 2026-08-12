//! The Rust half of the `tests/parity/security-posture.json` fixture.
//!
//! Its TypeScript twin is `src/platform/security-posture-parity.test.ts`. Both
//! read the same file, iterate the same rows, and compare against the same
//! expected values, so the fake host and the real host cannot drift apart
//! without a red test naming the row that moved.
//!
//! See `tests/parity/README.md` for the format and for how to add a row.
//!
//! **VERIFIED-BY-FAKE.** Configuration and derivation only. Nothing here opens
//! a socket, and no row is evidence about a real model endpoint.

use std::path::PathBuf;

use serde::Deserialize;
use vela_core::auth::AuthMode;
use vela_core::credential::Auth;
use vela_settings::{Concern, EndpointUrl, NetworkScope, RiskLevel, SecurityPosture};

/// The fixture lives at the repository root so neither language owns it.
fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/parity/security-posture.json")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    /// Every `Concern` variant, in wire order.
    concerns: Vec<String>,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    /// Documentation for humans; deliberately unused by the assertions.
    #[allow(dead_code)]
    why: String,
    base_url: String,
    auth: FixtureAuthMode,
    credential_present: bool,
    credential_required: bool,
    expect: Expected,
}

/// The `AuthMode` the user picked, not the stored binding — each language
/// derives the binding itself, so the derivation is under test too.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum FixtureAuthMode {
    None,
    BearerToken,
    ApiKeyHeader { header: String },
    ApiKeyQuery { param: String },
}

impl From<&FixtureAuthMode> for AuthMode {
    fn from(mode: &FixtureAuthMode) -> Self {
        match mode {
            FixtureAuthMode::None => AuthMode::None,
            FixtureAuthMode::BearerToken => AuthMode::BearerToken,
            FixtureAuthMode::ApiKeyHeader { header } => AuthMode::ApiKeyHeader {
                header: header.clone(),
            },
            FixtureAuthMode::ApiKeyQuery { param } => AuthMode::ApiKeyQuery {
                param: param.clone(),
            },
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Expected {
    level: RiskLevel,
    scope: NetworkScope,
    leaves_device: bool,
    traffic_is_plaintext: bool,
    credential_sent_in_plaintext: bool,
    credential_in_query_string: bool,
    endpoint_is_unauthenticated: bool,
    concerns: Vec<Concern>,
}

fn load() -> Fixture {
    let path = fixture_path();
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
    serde_json::from_str(&raw)
        .unwrap_or_else(|error| panic!("{} is not a valid fixture: {error}", path.display()))
}

#[test]
fn the_fixture_lists_every_concern_variant_and_nothing_else() {
    // Runs before the cases matter: a variant added in one language and not the
    // other should fail here, with a clear message, rather than as a confusing
    // array mismatch three rows down.
    let fixture = load();
    let declared: Vec<String> = Concern::ALL
        .iter()
        .map(|concern| concern.wire_name().to_owned())
        .collect();
    assert_eq!(
        fixture.concerns, declared,
        "tests/parity/security-posture.json must list every Concern variant in wire order"
    );
}

#[test]
fn every_fixture_case_matches_the_host_assessment() {
    let fixture = load();
    assert!(
        fixture.cases.len() >= 10,
        "the fixture lost rows: {} left",
        fixture.cases.len()
    );

    let mut seen: Vec<&str> = Vec::new();
    for case in &fixture.cases {
        let name = case.name.as_str();
        assert!(!seen.contains(&name), "duplicate fixture case `{name}`");
        seen.push(name);

        let endpoint = EndpointUrl::parse(&case.base_url)
            .unwrap_or_else(|error| panic!("{name}: `{}` was rejected: {error}", case.base_url));
        let mode: AuthMode = (&case.auth).into();
        let auth = Auth::for_provider("fixture-provider", &mode)
            .unwrap_or_else(|error| panic!("{name}: {mode:?} was rejected: {error}"));

        let posture = SecurityPosture::assess(
            &endpoint,
            &auth,
            case.credential_present,
            case.credential_required,
        );

        assert_eq!(posture.level, case.expect.level, "{name}: level");
        assert_eq!(posture.scope, case.expect.scope, "{name}: scope");
        assert_eq!(
            posture.leaves_device, case.expect.leaves_device,
            "{name}: leavesDevice"
        );
        assert_eq!(
            posture.traffic_is_plaintext, case.expect.traffic_is_plaintext,
            "{name}: trafficIsPlaintext"
        );
        assert_eq!(
            posture.credential_sent_in_plaintext, case.expect.credential_sent_in_plaintext,
            "{name}: credentialSentInPlaintext"
        );
        assert_eq!(
            posture.credential_in_query_string, case.expect.credential_in_query_string,
            "{name}: credentialInQueryString"
        );
        assert_eq!(
            posture.endpoint_is_unauthenticated, case.expect.endpoint_is_unauthenticated,
            "{name}: endpointIsUnauthenticated"
        );
        // Ordered, not set-compared: see tests/parity/README.md. Rust sorts by
        // the derived Ord and TypeScript sorts strings, and this is where the
        // two orderings are pinned to each other.
        assert_eq!(
            posture.concerns, case.expect.concerns,
            "{name}: concerns (order matters)"
        );
    }
}

#[test]
fn the_fixture_covers_the_query_string_finding_from_both_sides() {
    // The row that closes Phase A security finding 1 has to keep existing, and
    // so does its header-bound control — without the control, the concern could
    // degenerate into "a credential exists" and still pass.
    let fixture = load();

    let https_query = fixture
        .cases
        .iter()
        .find(|case| {
            matches!(case.auth, FixtureAuthMode::ApiKeyQuery { .. })
                && case.base_url.starts_with("https://")
                && case.expect.scope != NetworkScope::Loopback
        })
        .expect("no https + query-param row: the finding is unguarded");
    assert!(
        https_query
            .expect
            .concerns
            .contains(&Concern::QueryParamCredentialIsLogged),
        "{}: https must not silence the query-string concern",
        https_query.name
    );
    assert!(
        !https_query.expect.traffic_is_plaintext,
        "{}: this row is only meaningful over TLS",
        https_query.name
    );
    assert!(https_query.expect.level.is_noteworthy());

    let https_header = fixture
        .cases
        .iter()
        .find(|case| {
            matches!(case.auth, FixtureAuthMode::ApiKeyHeader { .. })
                && case.base_url.starts_with("https://")
        })
        .expect("no https + header-key control row");
    assert_eq!(
        https_header.expect.level,
        RiskLevel::None,
        "{}: a header-bound key over TLS is the clean case",
        https_header.name
    );

    let loopback_query = fixture
        .cases
        .iter()
        .find(|case| {
            matches!(case.auth, FixtureAuthMode::ApiKeyQuery { .. })
                && case.expect.scope == NetworkScope::Loopback
        })
        .expect("no loopback + query-param row: nothing stops this becoming a false positive");
    assert_eq!(loopback_query.expect.level, RiskLevel::None);
    assert!(!loopback_query.expect.credential_in_query_string);
}
