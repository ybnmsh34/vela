//! Which **wire protocol** an endpoint speaks — declared by the user, never
//! inferred by Vela.
//!
//! # Why this type exists, and why it is not the thing the conventions forbid
//!
//! `ProviderHost::build` had one arm. Every configured endpoint became an
//! OpenAI-compatible client, so the Messages adapter and the Gemini adapter —
//! thousands of lines, guarded, fixture-replayed — were reachable only from
//! their own tests. The blocker was stated honestly in that module's docs:
//! there was nowhere for a user to say what their endpoint speaks, and deriving
//! it from the URL would be exactly the "branch on backend identity" that
//! `docs/architecture/conventions.md` §0.3 forbids.
//!
//! This is the other way to answer the question, and it is the only one Vela is
//! allowed: **the user says.** Nothing here is inferred from a hostname, a path,
//! a model name, a response shape or a header. There is no sniffing, no
//! probing-to-decide, and no default that is "clever" — the default is the
//! shape most local runtimes serve, and it is a default only in the sense that
//! a row written before this field existed still loads.
//!
//! ## A protocol is not a vendor
//!
//! `ProviderConfig` carries a load-bearing rule: *nothing in it is
//! provider-specific; there is no "is_ollama", no per-vendor sub-struct, no
//! enum of known vendors.* (Quoted in prose rather than in backticks on
//! purpose: `src/platform/claimed-guards.test.ts` resolves every backticked
//! identifier against the tree, and a phrase naming a field that deliberately
//! does not exist would read to it as a claim with nothing behind it.) This
//! type does not break that rule, and the distinction is not a lawyer's one:
//!
//! * A **vendor** is who is answering. Vela must never know or care.
//! * A **wire protocol** is the shape of the bytes. It is a *format*, spoken by
//!   many parties: the OpenAI-compatible shape is what llama.cpp, Ollama, LM
//!   Studio, vLLM and a long tail of gateways serve; the Messages shape and the
//!   `generateContent` shape are each served by their originator *and* by every
//!   proxy, gateway and self-hosted bridge that implements them.
//!
//! The test is whether adding a fourth arm here would tell Vela anything about
//! *who* is on the other end. It would not. A user pointing this at a
//! self-hosted gateway is exactly as well served as one pointing it at the
//! company that invented the format — which is the premise of a model-agnostic
//! client, not a departure from it.
//!
//! ## How the renderer sees it — the §0.3 half
//!
//! §0.3 is a rule about **UI code**: the UI branches on capability flags, never
//! on a backend identity, and adding a backend must require zero changes under
//! `src/`. So the names below must never appear in the renderer. They do not:
//!
//! * [`catalogue`] is data the host sends, carried on the settings snapshot.
//!   The endpoints form renders whatever list it is given.
//! * The renderer's type for the field is an **opaque string**, exactly as it
//!   treats a provider id. It cannot spell a protocol, so it cannot branch on
//!   one.
//! * Adding a fourth protocol is one variant here, one arm in
//!   `ProviderHost::build`, and **zero lines under `src/`**.
//!
//! The host supplying the user-facing label has a precedent in this tree that
//! was added for the same reason: `ProviderView::credential_field_label`, which
//! exists "so the UI can label its credential field without knowing anything
//! about the provider". Vela's own words for Vela's own choice; nothing here is
//! endpoint-supplied text.

use serde::{Deserialize, Serialize};

/// The wire protocol a configured endpoint speaks.
///
/// Deliberately **not** `#[non_exhaustive]`: the composition root's `match` must
/// stay exhaustive so that adding a protocol without wiring an adapter for it is
/// a compile error rather than a silent fall-through to the default.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize,
)]
#[serde(rename_all = "camelCase")]
pub enum WireProtocol {
    /// The `/chat/completions` shape. The default — not because it is anyone's
    /// preferred backend, but because it is what every provider row written
    /// before this field existed was built as, and a stored configuration must
    /// not change meaning when the software is upgraded.
    #[default]
    OpenAiCompatible,
    /// The `/messages` shape: typed content blocks, a separate thinking block,
    /// a version header.
    AnthropicMessages,
    /// The `generateContent` shape: `contents` and `parts`, safety verdicts,
    /// thought signatures.
    GoogleGenerativeLanguage,
}

impl WireProtocol {
    /// Every protocol, in the order a chooser should offer them.
    ///
    /// A `const` list rather than a derived one because [`catalogue`] and the
    /// composition root's `match` must agree about what exists, and a test can
    /// only check that if both can be enumerated.
    pub const ALL: &'static [WireProtocol] = &[
        WireProtocol::OpenAiCompatible,
        WireProtocol::AnthropicMessages,
        WireProtocol::GoogleGenerativeLanguage,
    ];

    /// What a person choosing this would call it. Vela's own words.
    pub fn label(self) -> &'static str {
        match self {
            WireProtocol::OpenAiCompatible => "OpenAI-compatible",
            WireProtocol::AnthropicMessages => "Anthropic Messages",
            WireProtocol::GoogleGenerativeLanguage => "Google Generative Language",
        }
    }

    /// One sentence of help, aimed at somebody who knows what they installed
    /// and not at somebody who knows what Vela calls it.
    pub fn summary(self) -> &'static str {
        match self {
            WireProtocol::OpenAiCompatible => {
                "What llama.cpp, Ollama, LM Studio, vLLM and most gateways serve. \
                 Choose this if you are not sure."
            }
            WireProtocol::AnthropicMessages => {
                "The Messages API shape, at /v1/messages. Also spoken by proxies \
                 and gateways that implement it."
            }
            WireProtocol::GoogleGenerativeLanguage => {
                "The Generative Language API shape, at /v1beta/models/…:generateContent."
            }
        }
    }
}

/// One entry in the chooser the endpoints form draws.
///
/// The renderer never constructs these and never spells an `id`: it renders the
/// list it is handed and sends back whichever `id` the user picked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireProtocolOption {
    pub id: WireProtocol,
    pub label: String,
    pub summary: String,
}

/// Every protocol a user may choose, as the settings surface receives it.
pub fn catalogue() -> Vec<WireProtocolOption> {
    WireProtocol::ALL
        .iter()
        .map(|protocol| WireProtocolOption {
            id: *protocol,
            label: protocol.label().to_owned(),
            summary: protocol.summary().to_owned(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_row_written_before_this_field_existed_still_means_what_it_meant() {
        // The upgrade path, asserted rather than assumed. Every provider row in
        // an existing database was built as an OpenAI-compatible client; if the
        // default were anything else, upgrading Vela would silently repoint
        // every endpoint a user had configured.
        assert_eq!(WireProtocol::default(), WireProtocol::OpenAiCompatible);
        let decoded: WireProtocol = serde_json::from_str("\"openAiCompatible\"").unwrap();
        assert_eq!(decoded, WireProtocol::OpenAiCompatible);
    }

    #[test]
    fn the_catalogue_offers_every_protocol_the_host_can_build() {
        // The failure this pins: a variant added here and left out of `ALL`,
        // which the user could then never choose — the exact "field that nothing
        // selects" this whole change exists to avoid.
        let ids: Vec<WireProtocol> = catalogue().into_iter().map(|option| option.id).collect();
        assert_eq!(ids, WireProtocol::ALL.to_vec());

        // Every entry is offerable: a blank label is a chooser with an empty row
        // in it, which is worse than one fewer option.
        for option in catalogue() {
            assert!(!option.label.trim().is_empty(), "{option:?}");
            assert!(!option.summary.trim().is_empty(), "{option:?}");
        }
    }

    #[test]
    fn no_two_protocols_share_a_label_or_a_wire_name() {
        // Two identical labels make the chooser unusable; two identical wire
        // names make a stored row ambiguous.
        let mut labels: Vec<&str> = WireProtocol::ALL.iter().map(|p| p.label()).collect();
        labels.sort_unstable();
        let count = labels.len();
        labels.dedup();
        assert_eq!(labels.len(), count, "duplicate label");

        let mut wire: Vec<String> = WireProtocol::ALL
            .iter()
            .map(|p| serde_json::to_string(p).unwrap())
            .collect();
        wire.sort();
        let count = wire.len();
        wire.dedup();
        assert_eq!(wire.len(), count, "duplicate wire name");
    }

    #[test]
    fn a_protocol_round_trips_through_json_as_the_renderer_will_send_it_back() {
        for protocol in WireProtocol::ALL {
            let encoded = serde_json::to_string(protocol).unwrap();
            let decoded: WireProtocol = serde_json::from_str(&encoded).unwrap();
            assert_eq!(decoded, *protocol);
            assert!(
                encoded.starts_with('"'),
                "a protocol must be one JSON string, so the renderer can treat \
                 it as the opaque token it is: {encoded}"
            );
        }
    }

    #[test]
    fn an_unknown_protocol_is_refused_rather_than_quietly_defaulted() {
        // A row naming a protocol this build does not have is a configuration
        // this build cannot honour. Falling back to the default would send the
        // user's turn to an endpoint in a dialect they did not choose.
        let decoded: Result<WireProtocol, _> = serde_json::from_str("\"somethingElse\"");
        assert!(decoded.is_err());
    }
}
