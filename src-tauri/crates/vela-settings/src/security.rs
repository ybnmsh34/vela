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
    /// The user's conversation content is exposed. Show it plainly.
    Elevated,
    /// The user's credential is exposed. Show it loudly.
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Concern {
    /// Prompts and replies cross a network unencrypted.
    PlaintextTrafficLeavesDevice,
    /// The credential itself crosses a network unencrypted. Worse than the
    /// above: an observer does not just read this conversation, they get the key.
    CredentialSentInPlaintext,
    /// A remote endpoint that accepts unauthenticated requests: anyone who can
    /// reach it can spend the user's compute or read its logs.
    RemoteEndpointIsUnauthenticated,
    /// A credential is configured but nothing is stored for it, and the
    /// provider says one is required. Distinct from "no auth configured",
    /// which is not a concern at all.
    RequiredCredentialMissing,
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

        let mut concerns = Vec::new();
        if plaintext && leaves_device {
            concerns.push(Concern::PlaintextTrafficLeavesDevice);
        }
        if credential_sent_in_plaintext {
            concerns.push(Concern::CredentialSentInPlaintext);
        }
        if leaves_device && unauthenticated {
            concerns.push(Concern::RemoteEndpointIsUnauthenticated);
        }
        if credential_required && !credential_present {
            concerns.push(Concern::RequiredCredentialMissing);
        }
        concerns.sort_unstable();
        concerns.dedup();

        let level = if concerns.contains(&Concern::CredentialSentInPlaintext) {
            RiskLevel::High
        } else if concerns.contains(&Concern::PlaintextTrafficLeavesDevice) {
            RiskLevel::Elevated
        } else if concerns.is_empty() {
            RiskLevel::None
        } else {
            RiskLevel::Notice
        };

        Self {
            level,
            scope,
            leaves_device,
            traffic_is_plaintext: plaintext,
            credential_sent_in_plaintext,
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
