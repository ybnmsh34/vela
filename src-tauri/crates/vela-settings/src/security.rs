//! The computed security posture of a configured provider.
//!
//! # Why this exists
//!
//! Vela lets the user point at any endpoint, which means it lets the user point
//! at a *bad* endpoint. Two configurations deserve very different treatment and
//! look identical in a form:
//!
//! * `http://127.0.0.1:11434` with no auth — **completely normal**. The bytes
//!   never leave the machine. Warning about this would train the user to ignore
//!   warnings, and would make the product feel hostile to local models, which
//!   is the opposite of the point.
//! * `http://gpu.example.test:8080` with no auth — **a real risk**. Every
//!   prompt and every reply crosses the network in the clear, and anyone who
//!   can route to that host can use the model as the user.
//!
//! The rule: **risk comes from the endpoint being remote, not from auth being
//! absent.** `Auth::None` on loopback contributes nothing. This module computes
//! the difference and hands the UI a small, provider-neutral set of facts —
//! never a provider id, never a message string. The UI owns the wording.

use serde::{Deserialize, Serialize};
use vela_core::credential::Auth;

use crate::endpoint::{EndpointUrl, NetworkScope};

/// How loudly the UI should speak, if at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RiskLevel {
    /// Nothing to say. Includes the whole local-model case.
    None,
    /// Worth a quiet, non-blocking note.
    Notice,
    /// Something the user did not intend to expose is exposed: conversation
    /// content on the wire, or a credential written into records that outlive
    /// the request (access logs). Show it plainly.
    Elevated,
    /// The user's credential is readable by anyone on the network path. Show it
    /// loudly.
    High,
}

impl RiskLevel {
    /// True when the UI should surface anything at all.
    pub fn is_noteworthy(self) -> bool {
        self != RiskLevel::None
    }
}

/// A single, enumerable reason. The UI maps these to copy; adding a provider
/// never adds a variant, so no provider-specific string can arrive this way.
///
/// # Variant order is the wire order
///
/// [`SecurityPosture::assess`] sorts `concerns` before returning them, so the
/// array is stable and directly comparable. Rust sorts by the derived [`Ord`]
/// (declaration order) and the TypeScript fake sorts its string array with
/// `Array.prototype.sort()` (lexicographic over the camelCase names). Those two
/// only agree if the variants are declared in camelCase-alphabetical order, so
/// they are — and `derived_order_matches_the_wire_name_order` fails if a future
/// variant is inserted anywhere else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Concern {
    /// The credential itself crosses a network unencrypted. Worse than
    /// plaintext traffic alone: an observer does not just read this
    /// conversation, they get the key.
    CredentialSentInPlaintext,
    /// Prompts and replies cross a network unencrypted.
    PlaintextTrafficLeavesDevice,
    /// The credential is carried in the URL's query string, and the endpoint is
    /// not this machine.
    ///
    /// This is not a transport-encryption problem and **HTTPS does not fix
    /// it**: TLS protects the URL from observers on the path, then the server
    /// writes the whole request line — query string included — into its access
    /// log. So does every reverse proxy, CDN and load balancer that terminates
    /// TLS in front of it. Those logs are long-lived, routinely shipped to
    /// third-party aggregators, and read by people who were never meant to hold
    /// the key.
    ///
    /// Fires on the *shape* the user chose, not on whether a credential happens
    /// to be stored yet — the point is to say it before they paste the key in.
    /// It is deliberately silent on loopback: a key logged by the user's own
    /// llama.cpp, on the user's own machine, has not gone anywhere.
    QueryParamCredentialIsLogged,
    /// A remote endpoint that accepts unauthenticated requests: anyone who can
    /// reach it can spend the user's compute or read its logs.
    RemoteEndpointIsUnauthenticated,
    /// A credential is configured but nothing is stored for it, and the
    /// provider says one is required. Distinct from "no auth configured",
    /// which is not a concern at all.
    RequiredCredentialMissing,
}

impl Concern {
    /// How loudly this one reason, on its own, deserves to be spoken.
    ///
    /// [`SecurityPosture::assess`] takes the maximum over the concerns it
    /// raised. Deriving the level this way rather than from an `if/else if`
    /// chain means a newly added variant cannot be silently left out of the
    /// level: the match below stops compiling until it is given a severity.
    pub fn severity(self) -> RiskLevel {
        match self {
            Concern::CredentialSentInPlaintext => RiskLevel::High,
            Concern::PlaintextTrafficLeavesDevice => RiskLevel::Elevated,
            // Not `High`: the key is exposed to the endpoint's operator and the
            // proxies in front of it — parties the user already hands the key
            // to — rather than to every passive observer on the path. Not
            // `Notice` either: log files persist and travel, and the user
            // cannot revoke a line in someone else's log.
            Concern::QueryParamCredentialIsLogged => RiskLevel::Elevated,
            Concern::RemoteEndpointIsUnauthenticated => RiskLevel::Notice,
            Concern::RequiredCredentialMissing => RiskLevel::Notice,
        }
    }

    /// The camelCase name this variant serialises to. Used by the parity
    /// fixture and by the ordering test; kept next to the enum so the two
    /// cannot drift.
    pub fn wire_name(self) -> &'static str {
        match self {
            Concern::CredentialSentInPlaintext => "credentialSentInPlaintext",
            Concern::PlaintextTrafficLeavesDevice => "plaintextTrafficLeavesDevice",
            Concern::QueryParamCredentialIsLogged => "queryParamCredentialIsLogged",
            Concern::RemoteEndpointIsUnauthenticated => "remoteEndpointIsUnauthenticated",
            Concern::RequiredCredentialMissing => "requiredCredentialMissing",
        }
    }

    /// Every variant, in declaration order. Exhaustiveness is enforced by
    /// `every_variant_is_listed_in_all` below.
    pub const ALL: [Concern; 5] = [
        Concern::CredentialSentInPlaintext,
        Concern::PlaintextTrafficLeavesDevice,
        Concern::QueryParamCredentialIsLogged,
        Concern::RemoteEndpointIsUnauthenticated,
        Concern::RequiredCredentialMissing,
    ];
}

/// The full signal for one provider configuration.
///
/// Every field is a fact, not a judgement, except `level` — which is derived
/// from the facts so that the UI and the tests agree on the ordering.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityPosture {
    pub level: RiskLevel,
    pub scope: NetworkScope,
    /// The traffic leaves this machine.
    pub leaves_device: bool,
    /// The traffic is unencrypted (`http:`).
    pub traffic_is_plaintext: bool,
    /// A credential is configured, present, and will cross an unencrypted
    /// network.
    pub credential_sent_in_plaintext: bool,
    /// The credential is bound to a query parameter and the endpoint is not
    /// this machine, so the key will be written into request logs. True
    /// independently of `traffic_is_plaintext` — TLS does not stop logging.
    pub credential_in_query_string: bool,
    /// No credential is sent to this endpoint at all.
    pub endpoint_is_unauthenticated: bool,
    /// Sorted, de-duplicated; empty for a healthy configuration.
    pub concerns: Vec<Concern>,
}

impl SecurityPosture {
    /// Assess a configuration.
    ///
    /// `credential_present` is a presence boolean read from the credential
    /// store — no secret material reaches this function, and none is needed.
    pub fn assess(
        endpoint: &EndpointUrl,
        auth: &Auth,
        credential_present: bool,
        credential_required: bool,
    ) -> Self {
        let scope = endpoint.scope();
        let leaves_device = scope.leaves_device();
        let plaintext = endpoint.is_plaintext();
        let unauthenticated = auth.is_none();

        let credential_sent_in_plaintext =
            plaintext && leaves_device && !unauthenticated && credential_present;

        // Deliberately not gated on `credential_present`: this is a property of
        // the transport shape the user selected, and the warning is most useful
        // *before* the key is stored. Deliberately not gated on `plaintext`
        // either — see `Concern::QueryParamCredentialIsLogged`.
        let credential_in_query_string = leaves_device && matches!(auth, Auth::ApiKeyQuery { .. });

        let mut concerns = Vec::new();
        if plaintext && leaves_device {
            concerns.push(Concern::PlaintextTrafficLeavesDevice);
        }
        if credential_sent_in_plaintext {
            concerns.push(Concern::CredentialSentInPlaintext);
        }
        if credential_in_query_string {
            concerns.push(Concern::QueryParamCredentialIsLogged);
        }
        if leaves_device && unauthenticated {
            concerns.push(Concern::RemoteEndpointIsUnauthenticated);
        }
        if credential_required && !credential_present {
            concerns.push(Concern::RequiredCredentialMissing);
        }
        concerns.sort_unstable();
        concerns.dedup();

        let level = concerns
            .iter()
            .map(|concern| concern.severity())
            .max()
            .unwrap_or(RiskLevel::None);

        Self {
            level,
            scope,
            leaves_device,
            traffic_is_plaintext: plaintext,
            credential_sent_in_plaintext,
            credential_in_query_string,
            endpoint_is_unauthenticated: unauthenticated,
            concerns,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vela_core::auth::AuthMode;

    fn endpoint(raw: &str) -> EndpointUrl {
        EndpointUrl::parse(raw).unwrap()
    }

    fn bearer() -> Auth {
        Auth::for_provider("acme", &AuthMode::BearerToken).unwrap()
    }

    fn query_key() -> Auth {
        Auth::for_provider(
            "acme",
            &AuthMode::ApiKeyQuery {
                param: "key".into(),
            },
        )
        .unwrap()
    }

    #[test]
    fn a_local_endpoint_with_no_auth_over_http_raises_nothing() {
        // THE case the product exists to support. If this test ever goes red,
        // Vela has started nagging people for using llama.cpp correctly.
        let posture = SecurityPosture::assess(
            &endpoint("http://127.0.0.1:11434/v1"),
            &Auth::None,
            false,
            false,
        );
        assert_eq!(posture.level, RiskLevel::None);
        assert!(!posture.level.is_noteworthy());
        assert!(posture.concerns.is_empty());
        assert!(posture.endpoint_is_unauthenticated);
        assert!(posture.traffic_is_plaintext);
        assert!(!posture.leaves_device);
    }

    #[test]
    fn a_credential_on_a_loopback_endpoint_over_http_is_still_not_a_concern() {
        // llama.cpp started with `--api-key`: the key never leaves the machine.
        let posture = SecurityPosture::assess(
            &endpoint("http://localhost:8080/v1"),
            &bearer(),
            true,
            false,
        );
        assert_eq!(posture.level, RiskLevel::None);
        assert!(!posture.credential_sent_in_plaintext);
        assert!(posture.concerns.is_empty());
    }

    #[test]
    fn plaintext_to_another_machine_exposes_the_conversation() {
        let posture = SecurityPosture::assess(
            &endpoint("http://gpu-box.local:8080/v1"),
            &Auth::None,
            false,
            false,
        );
        assert_eq!(posture.level, RiskLevel::Elevated);
        assert_eq!(posture.scope, NetworkScope::PrivateNetwork);
        assert!(posture.leaves_device);
        assert!(posture
            .concerns
            .contains(&Concern::PlaintextTrafficLeavesDevice));
        assert!(posture
            .concerns
            .contains(&Concern::RemoteEndpointIsUnauthenticated));
    }

    #[test]
    fn plaintext_to_another_machine_with_a_credential_exposes_the_credential() {
        let posture = SecurityPosture::assess(
            &endpoint("http://api.example.test/v1"),
            &bearer(),
            true,
            true,
        );
        assert_eq!(posture.level, RiskLevel::High);
        assert!(posture.credential_sent_in_plaintext);
        assert!(posture
            .concerns
            .contains(&Concern::CredentialSentInPlaintext));
    }

    #[test]
    fn a_configured_credential_that_is_not_yet_stored_is_not_sent_in_plaintext() {
        // Nothing is transmitted, so the *credential* exposure is absent even
        // though the traffic exposure remains.
        let posture = SecurityPosture::assess(
            &endpoint("http://api.example.test/v1"),
            &bearer(),
            false,
            false,
        );
        assert!(!posture.credential_sent_in_plaintext);
        assert_eq!(posture.level, RiskLevel::Elevated);
    }

    #[test]
    fn an_encrypted_remote_endpoint_with_a_credential_is_clean() {
        let posture = SecurityPosture::assess(
            &endpoint("https://api.example.test/v1"),
            &bearer(),
            true,
            true,
        );
        assert_eq!(posture.level, RiskLevel::None);
        assert!(posture.concerns.is_empty());
        assert!(posture.leaves_device);
    }

    #[test]
    fn an_encrypted_remote_endpoint_with_no_auth_is_only_a_notice() {
        // Encrypted in transit, but open to anyone who can route to it.
        let posture = SecurityPosture::assess(
            &endpoint("https://gpu.example.test/v1"),
            &Auth::None,
            false,
            false,
        );
        assert_eq!(posture.level, RiskLevel::Notice);
        assert_eq!(
            posture.concerns,
            vec![Concern::RemoteEndpointIsUnauthenticated]
        );
    }

    #[test]
    fn a_required_but_missing_credential_is_a_notice_not_a_traffic_risk() {
        let posture = SecurityPosture::assess(
            &endpoint("https://api.example.test/v1"),
            &bearer(),
            false,
            true,
        );
        assert_eq!(posture.level, RiskLevel::Notice);
        assert_eq!(posture.concerns, vec![Concern::RequiredCredentialMissing]);
    }

    // ---------------------------------------------------------------------
    // Query-string credentials. Phase A security critic, finding 1.
    // ---------------------------------------------------------------------

    #[test]
    fn a_query_param_credential_on_an_https_endpoint_is_still_a_concern() {
        // THE regression this exists for. Before the fix this configuration
        // reported RiskLevel::None with an empty concern list, because every
        // rule in `assess` was keyed on plaintext transport — and TLS is
        // exactly what does *not* help here. The key is in the request line,
        // and the request line is what gets logged.
        let posture = SecurityPosture::assess(
            &endpoint("https://api.example.test/v1"),
            &query_key(),
            true,
            true,
        );
        assert_eq!(posture.level, RiskLevel::Elevated);
        assert!(posture.credential_in_query_string);
        assert_eq!(
            posture.concerns,
            vec![Concern::QueryParamCredentialIsLogged],
            "https must not silence this"
        );
        assert!(
            !posture.traffic_is_plaintext,
            "the transport really is encrypted; that is the point"
        );
        assert!(!posture.credential_sent_in_plaintext);
    }

    #[test]
    fn the_query_param_concern_fires_before_a_credential_has_been_stored() {
        // The warning has to reach the user while the form is still open,
        // otherwise it only ever appears after the key has already been pasted
        // into a shape that logs it.
        let posture = SecurityPosture::assess(
            &endpoint("https://api.example.test/v1"),
            &query_key(),
            false,
            false,
        );
        assert!(posture.credential_in_query_string);
        assert!(posture
            .concerns
            .contains(&Concern::QueryParamCredentialIsLogged));
        assert_eq!(posture.level, RiskLevel::Elevated);
    }

    #[test]
    fn a_query_param_credential_on_loopback_is_not_a_concern() {
        // Same rule as the rest of this module: risk comes from the endpoint
        // being remote. A key logged by the user's own server, on the user's
        // own machine, has not left anywhere.
        let posture = SecurityPosture::assess(
            &endpoint("http://127.0.0.1:8080/v1"),
            &query_key(),
            true,
            false,
        );
        assert_eq!(posture.level, RiskLevel::None);
        assert!(!posture.credential_in_query_string);
        assert!(posture.concerns.is_empty());
    }

    #[test]
    fn a_header_credential_never_raises_the_query_param_concern() {
        for auth in [
            bearer(),
            Auth::for_provider(
                "acme",
                &AuthMode::ApiKeyHeader {
                    header: "x-api-key".into(),
                },
            )
            .unwrap(),
            Auth::None,
        ] {
            let posture = SecurityPosture::assess(
                &endpoint("https://api.example.test/v1"),
                &auth,
                true,
                true,
            );
            assert!(
                !posture.credential_in_query_string,
                "{auth:?} does not put anything in the URL"
            );
            assert!(!posture
                .concerns
                .contains(&Concern::QueryParamCredentialIsLogged));
        }
    }

    #[test]
    fn plaintext_still_outranks_logging_when_both_apply() {
        // http + query param: the key is both sniffable and logged. The louder
        // reason wins the level, and both reasons are still listed.
        let posture = SecurityPosture::assess(
            &endpoint("http://api.example.test/v1"),
            &query_key(),
            true,
            true,
        );
        assert_eq!(posture.level, RiskLevel::High);
        assert_eq!(
            posture.concerns,
            vec![
                Concern::CredentialSentInPlaintext,
                Concern::PlaintextTrafficLeavesDevice,
                Concern::QueryParamCredentialIsLogged,
            ]
        );
    }

    #[test]
    fn the_query_param_concern_is_serialised_as_a_flag_and_a_name() {
        let posture = SecurityPosture::assess(
            &endpoint("https://api.example.test/v1"),
            &query_key(),
            true,
            true,
        );
        let json = serde_json::to_value(&posture).unwrap();
        assert_eq!(json["level"], "elevated");
        assert_eq!(json["credentialInQueryString"], true);
        assert_eq!(json["concerns"][0], "queryParamCredentialIsLogged");
        // Still no provider-shaped detail: the param name is not exported.
        assert!(!json.to_string().contains("param"));
    }

    // ---------------------------------------------------------------------
    // Invariants that keep the two languages in step.
    // ---------------------------------------------------------------------

    #[test]
    fn every_variant_is_listed_in_all() {
        // Exhaustive match: adding a variant without extending ALL stops the
        // compile here rather than silently shrinking the parity fixture.
        for concern in Concern::ALL {
            match concern {
                Concern::CredentialSentInPlaintext
                | Concern::PlaintextTrafficLeavesDevice
                | Concern::QueryParamCredentialIsLogged
                | Concern::RemoteEndpointIsUnauthenticated
                | Concern::RequiredCredentialMissing => {}
            }
        }
        let mut names: Vec<&str> = Concern::ALL.iter().map(|c| c.wire_name()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), Concern::ALL.len(), "ALL has a duplicate");
    }

    #[test]
    fn derived_order_matches_the_wire_name_order() {
        // `assess` sorts by derived Ord; the BrowserAdapter sorts the same
        // array lexicographically by camelCase name. If these two orderings
        // ever disagree, the two implementations emit the same set in a
        // different order and every array-equality parity assertion breaks.
        let mut by_variant = Concern::ALL;
        by_variant.sort_unstable();

        let mut by_name = Concern::ALL;
        by_name.sort_unstable_by_key(|concern| concern.wire_name());

        assert_eq!(by_variant, by_name);
        assert_eq!(
            by_variant,
            Concern::ALL,
            "declare variants in camelCase-alphabetical order"
        );
    }

    #[test]
    fn wire_names_are_exactly_what_serde_emits() {
        for concern in Concern::ALL {
            let json = serde_json::to_string(&concern).unwrap();
            assert_eq!(json, format!("\"{}\"", concern.wire_name()));
        }
    }

    #[test]
    fn the_level_is_the_loudest_concern_and_nothing_is_left_out_of_the_ladder() {
        for concern in Concern::ALL {
            assert!(
                concern.severity().is_noteworthy(),
                "{concern:?} would be raised and then say nothing"
            );
        }
    }

    #[test]
    fn risk_levels_are_ordered_so_the_ui_can_sort_by_severity() {
        assert!(RiskLevel::High > RiskLevel::Elevated);
        assert!(RiskLevel::Elevated > RiskLevel::Notice);
        assert!(RiskLevel::Notice > RiskLevel::None);
    }

    #[test]
    fn the_posture_serialises_as_flags_the_ui_can_branch_on_without_knowing_a_provider() {
        let posture = SecurityPosture::assess(
            &endpoint("http://api.example.test/v1"),
            &bearer(),
            true,
            true,
        );
        let json = serde_json::to_value(&posture).unwrap();
        assert_eq!(json["level"], "high");
        assert_eq!(json["scope"], "publicNetwork");
        assert_eq!(json["trafficIsPlaintext"], true);
        assert_eq!(json["credentialSentInPlaintext"], true);
        let concerns: Vec<&str> = json["concerns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect();
        assert!(
            concerns.contains(&"credentialSentInPlaintext"),
            "{concerns:?}"
        );
        assert!(
            concerns.contains(&"plaintextTrafficLeavesDevice"),
            "{concerns:?}"
        );
        // No endpoint, no id, no provider name: nothing to special-case on.
        assert!(json.get("providerId").is_none());
        assert!(!json.to_string().contains("example.test"));
    }
}
