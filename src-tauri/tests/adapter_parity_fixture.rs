//! Adapter parity — the Rust half.
//!
//! # Why this file exists
//!
//! `src/platform/browser-adapter.ts` hand-reimplements this host's derivation
//! logic in TypeScript: endpoint parsing, network-scope classification, the
//! security posture, and the `AuthMode -> Auth` binding. Every frontend test
//! and every headless screenshot runs against that fake, so a disagreement
//! between the two is invisible until it reaches a user — and it grows
//! monotonically, because nothing was checking.
//!
//! The command *names* have been pinned across the two languages since Phase A
//! (`ipc::tests::rust_and_typescript_allowlists_are_identical`). This file pins
//! the *semantics*, the same way: one shared JSON table, read by both
//! `cargo test` and `pnpm test`.
//!
//! * Fixture: `tests/parity/adapter-parity.json` (see `tests/parity/README.md`)
//! * TypeScript half: `src/platform/adapter-parity.test.ts`
//!
//! **This side is the specification.** The fixture records what the host does;
//! when the fake disagrees, the fake is wrong
//! (`docs/architecture/conventions.md` §8). Never edit an expectation to make a
//! suite go green.
//!
//! **VERIFIED-BY-FAKE:** the stores here are `SqliteStore::InMemory` and
//! `MemoryStore`. This file says nothing about a real keychain, and nothing
//! about a real endpoint — no request is ever sent to any of these URLs.

use std::collections::BTreeSet;

use serde_json::{json, Value};

use vela_core::auth::{AuthMode, AuthRequirement};
use vela_core::provider::ProviderKind;
use vela_lib::ipc::secrets::{SecretRefDto, SecretsSetReq};
use vela_lib::ipc::settings::SettingsPutProviderReq;
use vela_lib::ipc::{secrets as ipc_secrets, settings as ipc_settings, IpcErrorCode};
use vela_lib::provider_host::ProviderHost;
use vela_providers::http::testing::ScriptedTransport;
use vela_secrets::MemoryStore;
use vela_store::{DatabaseLocation, SqliteStore};

const FIXTURE_PATH: &str = "tests/parity/adapter-parity.json";
const TYPESCRIPT_HALF: &str = "src/platform/adapter-parity.test.ts";

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri always has a parent")
        .to_path_buf()
}

fn fixture() -> Value {
    let path = repo_root().join(FIXTURE_PATH);
    let source = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read the parity fixture at {path:?}: {error}"));
    serde_json::from_str(&source).expect("the parity fixture must be valid JSON")
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("fixture field `{key}` must be a string, got {}", value[key]))
}

/// `SettingsError`/`CoreError` render as `invalid <field>: <reason>`, and the
/// IPC layer passes that string through verbatim. The renderer never parses a
/// message — but a *test* may, and doing so is what lets both languages agree
/// on which field was at fault without inventing a new wire field.
fn invalid_field(message: &str) -> String {
    let rest = message
        .strip_prefix("invalid ")
        .unwrap_or_else(|| panic!("a rejection message must start with `invalid `: {message}"));
    let (field, _) = rest
        .split_once(':')
        .unwrap_or_else(|| panic!("a rejection message must name a field: {message}"));
    field.to_owned()
}

/// Run one fixture case against the real host command, and reduce the result to
/// exactly the shape the fixture's `expect` object describes.
fn observe(doc: &Value, case: &Value) -> Value {
    let input = &case["input"];
    let id = input
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_else(|| text(doc, "providerId"));
    let display_name = input
        .get("displayName")
        .and_then(Value::as_str)
        .unwrap_or_else(|| text(doc, "displayName"));

    // A fresh host per case: no state leaks from one row to the next.
    let store = SqliteStore::open(DatabaseLocation::InMemory).unwrap();
    let credentials = MemoryStore::new();

    if input["credentialStored"] == Value::Bool(true) {
        ipc_secrets::set(
            &credentials,
            SecretsSetReq {
                reference: SecretRefDto {
                    provider_id: id.to_owned(),
                    // `None` means the provider's primary credential — the same
                    // entry `Auth::for_provider` binds.
                    field: None,
                },
                value: text(doc, "credentialValue").into(),
            },
        )
        .expect("storing the fixture credential must succeed");
    }

    let kind: ProviderKind =
        serde_json::from_value(doc["kind"].clone()).expect("fixture `kind` must be a ProviderKind");
    let auth: AuthMode = serde_json::from_value(input["authMode"].clone())
        .expect("fixture `authMode` must be an AuthMode");
    let auth_requirement: AuthRequirement =
        serde_json::from_value(input["authRequirement"].clone())
            .expect("fixture `authRequirement` must be an AuthRequirement");

    let request = SettingsPutProviderReq {
        id: id.to_owned(),
        display_name: display_name.to_owned(),
        kind,
        base_url: text(input, "baseUrl").to_owned(),
        model_id: None,
        auth,
        auth_requirement,
    };

    // Driven through the fully assembled door: `put_provider` builds the live
    // provider as well as writing the row, so this fixture exercises the same
    // call the shipping command makes rather than a settings-only shortcut.
    let providers = ProviderHost::new(
        std::sync::Arc::new(MemoryStore::new()),
        std::sync::Arc::new(ScriptedTransport::new(Vec::new())),
    );
    match ipc_settings::put_provider(&store, &credentials, &providers, request) {
        Ok(view) => {
            let view = serde_json::to_value(&view).expect("a ProviderView always serialises");
            let security = &view["security"];
            json!({
                "accepted": true,
                "baseUrl": view["baseUrl"],
                "auth": view["auth"],
                "scope": security["scope"],
                "riskLevel": security["level"],
                "concerns": security["concerns"],
                "leavesDevice": security["leavesDevice"],
                "trafficIsPlaintext": security["trafficIsPlaintext"],
                "credentialSentInPlaintext": security["credentialSentInPlaintext"],
                "endpointIsUnauthenticated": security["endpointIsUnauthenticated"],
                "credentialPresent": view["credentialPresent"],
                "usable": view["usable"],
                "credentialCheck": view["credentialCheck"],
                "credentialFieldLabel": view["credentialFieldLabel"],
            })
        }
        Err(error) => {
            assert_eq!(
                error.code,
                IpcErrorCode::InvalidPayload,
                "case `{}`: a rejected configuration must be INVALID_PAYLOAD, not {:?}",
                text(case, "id"),
                error.code
            );
            json!({ "accepted": false, "invalidField": invalid_field(&error.message) })
        }
    }
}

#[test]
fn the_host_matches_the_shared_parity_fixture() {
    let doc = fixture();
    let cases = doc["cases"].as_array().expect("`cases` must be an array");
    assert!(
        cases.len() >= 60,
        "the fixture has shrunk to {} cases; coverage is the point of it",
        cases.len()
    );

    let mut failures: Vec<String> = Vec::new();
    for case in cases {
        let observed = observe(&doc, case);
        let expected = &case["expect"];
        if observed != *expected {
            failures.push(format!(
                "\n  case `{}`\n    why:      {}\n    input:    {}\n    expected: {}\n    host:     {}",
                text(case, "id"),
                text(case, "why"),
                case["input"],
                expected,
                observed,
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "the Rust host disagrees with {FIXTURE_PATH} in {} case(s).\n\
         The host is the specification: if the host's new behaviour is correct, re-derive the \
         fixture from it AND update src/platform/browser-adapter.ts to match. Never edit the \
         fixture to match one side alone.{}",
        failures.len(),
        failures.join("")
    );
}

#[test]
fn both_languages_read_the_same_fixture_file() {
    // The mirror of `rust_and_typescript_allowlists_are_identical`: a parity
    // test whose two halves quietly diverge onto two files proves nothing. A
    // dumb string scan on purpose — no TS toolchain runs inside `cargo test`.
    let path = repo_root().join(TYPESCRIPT_HALF);
    let source = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("the TypeScript half must exist at {path:?}: {error}"));
    assert!(
        source.contains("adapter-parity.json"),
        "{TYPESCRIPT_HALF} must load {FIXTURE_PATH}, or the two halves are testing different tables"
    );
    assert!(
        repo_root().join(FIXTURE_PATH).is_file(),
        "{FIXTURE_PATH} is missing"
    );
}

#[test]
fn the_fixture_covers_every_axis_it_claims_to() {
    // Guards against the other failure mode of a golden file: someone deletes
    // the inconvenient rows and the suite stays green.
    let doc = fixture();
    let cases = doc["cases"].as_array().unwrap();

    let ids: BTreeSet<&str> = cases.iter().map(|case| text(case, "id")).collect();
    assert_eq!(ids.len(), cases.len(), "duplicate case ids in the fixture");
    for case in cases {
        assert!(
            !text(case, "why").is_empty(),
            "case `{}` must say why it exists",
            text(case, "id")
        );
    }

    let accepted = || {
        cases
            .iter()
            .filter(|case| case["expect"]["accepted"] == true)
    };
    let collect =
        |f: &dyn Fn(&Value) -> String| -> BTreeSet<String> { cases.iter().map(f).collect() };

    let scopes: BTreeSet<String> = accepted()
        .map(|case| case["expect"]["scope"].to_string())
        .collect();
    for scope in ["\"loopback\"", "\"privateNetwork\"", "\"publicNetwork\""] {
        assert!(scopes.contains(scope), "no case covers scope {scope}");
    }

    let levels: BTreeSet<String> = accepted()
        .map(|case| case["expect"]["riskLevel"].to_string())
        .collect();
    for level in ["\"none\"", "\"notice\"", "\"elevated\"", "\"high\""] {
        assert!(levels.contains(level), "no case covers risk level {level}");
    }

    let checks: BTreeSet<String> = accepted()
        .map(|case| case["expect"]["credentialCheck"].to_string())
        .collect();
    for check in [
        "\"satisfied\"",
        "\"satisfiedWithoutCredential\"",
        "\"missingRequired\"",
    ] {
        assert!(
            checks.contains(check),
            "no case covers credential check {check}"
        );
    }

    let modes = collect(&|case| case["input"]["authMode"]["type"].to_string());
    for mode in [
        "\"none\"",
        "\"bearerToken\"",
        "\"apiKeyHeader\"",
        "\"apiKeyQuery\"",
    ] {
        assert!(modes.contains(mode), "no case covers auth mode {mode}");
    }

    let requirements = collect(&|case| case["input"]["authRequirement"].to_string());
    for requirement in ["\"notRequired\"", "\"optional\"", "\"required\""] {
        assert!(
            requirements.contains(requirement),
            "no case covers auth requirement {requirement}"
        );
    }

    let stored = collect(&|case| case["input"]["credentialStored"].to_string());
    assert!(stored.contains("true") && stored.contains("false"));

    let concerns: BTreeSet<String> = accepted()
        .flat_map(|case| case["expect"]["concerns"].as_array().unwrap())
        .map(Value::to_string)
        .collect();
    for concern in [
        "\"plaintextTrafficLeavesDevice\"",
        "\"credentialSentInPlaintext\"",
        // Added by fix:security-concerns. Phase A's security critic found this
        // one missing entirely, so the row that produces it is exactly the kind
        // of row that gets deleted to make a suite go green.
        "\"queryParamCredentialIsLogged\"",
        "\"remoteEndpointIsUnauthenticated\"",
        "\"requiredCredentialMissing\"",
    ] {
        assert!(
            concerns.contains(concern),
            "no case produces concern {concern}"
        );
    }

    let rejected_fields: BTreeSet<String> = cases
        .iter()
        .filter(|case| case["expect"]["accepted"] == false)
        .map(|case| case["expect"]["invalidField"].to_string())
        .collect();
    for field in [
        "\"baseUrl\"",
        "\"header\"",
        "\"param\"",
        "\"id\"",
        "\"displayName\"",
    ] {
        assert!(
            rejected_fields.contains(field),
            "no rejection case covers the field {field}"
        );
    }
}

#[test]
fn no_fixture_case_is_a_real_endpoint_or_a_real_credential() {
    // Honesty guard. Nothing here contacts anything, and a fixture that started
    // quoting a real host or a real key would be a lie about what was verified.
    let doc = fixture();
    let encoded = doc.to_string();
    for forbidden in [
        "sk-ant",
        "api.openai.com",
        "api.anthropic.com",
        "localhost:8033",
    ] {
        assert!(
            !encoded.contains(forbidden),
            "the parity fixture must stay synthetic; found `{forbidden}`"
        );
    }
    for case in doc["cases"].as_array().unwrap() {
        let raw = text(&case["input"], "baseUrl");
        let url = raw.trim().to_lowercase();
        // Everything after the scheme and before the path, minus any userinfo.
        let authority = url
            .split_once("//")
            .map(|(_, rest)| rest.split('/').next().unwrap_or_default())
            .unwrap_or_default();
        let host = authority.rsplit('@').next().unwrap_or_default();

        // Reserved-for-documentation and private-use names (RFC 2606/6761/8375),
        // or a bare address literal. Nothing that could be a registrable domain.
        let reserved = [".test", ".example", ".invalid", ".local", ".internal"]
            .iter()
            .any(|suffix| {
                host.split(':')
                    .next()
                    .unwrap_or_default()
                    .trim_end_matches('.')
                    .ends_with(suffix)
            });
        let literal_or_bare = !host.contains('.')
            || host
                .chars()
                .all(|c| c.is_ascii_hexdigit() || "x.:[]".contains(c));
        assert!(
            reserved || literal_or_bare || host.contains("localhost"),
            "case `{}` uses host `{host}`, which is not a reserved or synthetic name",
            text(case, "id")
        );
    }
}
