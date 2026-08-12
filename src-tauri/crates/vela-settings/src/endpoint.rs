//! The model endpoint's address, and what it implies about who can read the
//! user's conversations.

use std::net::{IpAddr, Ipv4Addr};

use serde::{Deserialize, Serialize};
use url::{Host, Url};

use crate::error::{SettingsError, SettingsResult};

/// A validated model endpoint.
///
/// Serialises as a plain string, so a stored provider row stays readable, but
/// can only be *constructed* through [`EndpointUrl::parse`] — nothing
/// downstream has to re-validate, and the scheme/host facts the security
/// posture depends on are computed once, here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct EndpointUrl {
    url: Url,
}

impl EndpointUrl {
    pub fn parse(raw: &str) -> SettingsResult<Self> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(SettingsError::invalid("baseUrl", "must not be blank"));
        }
        let url = Url::parse(trimmed)
            .map_err(|error| SettingsError::invalid("baseUrl", error.to_string()))?;

        match url.scheme() {
            // Only these two. `file:`, `data:` and friends would turn a
            // settings row into a local-file read primitive.
            "http" | "https" => {}
            other => {
                return Err(SettingsError::invalid(
                    "baseUrl",
                    format!("unsupported scheme `{other}`: expected http or https"),
                ))
            }
        }
        if url.host().is_none() {
            return Err(SettingsError::invalid("baseUrl", "must include a host"));
        }
        Ok(Self { url })
    }

    pub fn as_str(&self) -> &str {
        self.url.as_str()
    }

    pub fn scheme(&self) -> &str {
        self.url.scheme()
    }

    pub fn host(&self) -> &str {
        self.url.host_str().unwrap_or_default()
    }

    pub fn port(&self) -> Option<u16> {
        self.url.port()
    }

    /// True when traffic to this endpoint is unencrypted on the wire.
    pub fn is_plaintext(&self) -> bool {
        self.url.scheme() == "http"
    }

    /// Where the bytes go. This is the fact the whole risk model rests on:
    /// plaintext to `127.0.0.1` never leaves the machine, plaintext to anywhere
    /// else is readable by every hop in between.
    pub fn scope(&self) -> NetworkScope {
        match self.url.host() {
            Some(Host::Domain(name)) => {
                let name = name.trim_end_matches('.').to_ascii_lowercase();
                if name == "localhost" || name.ends_with(".localhost") {
                    NetworkScope::Loopback
                } else if name.ends_with(".local") || name.ends_with(".internal") {
                    // mDNS / internal suffixes: on the user's LAN, not the
                    // public internet.
                    NetworkScope::PrivateNetwork
                } else {
                    NetworkScope::PublicNetwork
                }
            }
            Some(Host::Ipv4(address)) => scope_of_ip(IpAddr::V4(address)),
            Some(Host::Ipv6(address)) => scope_of_ip(IpAddr::V6(address)),
            // Unreachable: `parse` rejects a host-less URL.
            None => NetworkScope::PublicNetwork,
        }
    }

    pub fn is_loopback(&self) -> bool {
        self.scope() == NetworkScope::Loopback
    }
}

fn scope_of_ip(address: IpAddr) -> NetworkScope {
    if address.is_loopback() {
        return NetworkScope::Loopback;
    }
    match address {
        IpAddr::V4(v4) => {
            if v4.is_private() || v4.is_link_local() || v4 == Ipv4Addr::UNSPECIFIED {
                NetworkScope::PrivateNetwork
            } else {
                NetworkScope::PublicNetwork
            }
        }
        IpAddr::V6(v6) => {
            let segments = v6.segments();
            // fc00::/7 unique-local, fe80::/10 link-local. `Ipv6Addr::is_unique_local`
            // is still unstable, so the check is written out.
            let unique_local = (segments[0] & 0xfe00) == 0xfc00;
            let link_local = (segments[0] & 0xffc0) == 0xfe80;
            if unique_local || link_local || v6.is_unspecified() {
                NetworkScope::PrivateNetwork
            } else {
                NetworkScope::PublicNetwork
            }
        }
    }
}

impl std::fmt::Display for EndpointUrl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.url.as_str())
    }
}

impl TryFrom<String> for EndpointUrl {
    type Error = SettingsError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl From<EndpointUrl> for String {
    fn from(value: EndpointUrl) -> Self {
        value.url.into()
    }
}

/// How far the user's prompts travel to reach the model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NetworkScope {
    /// Never leaves this machine.
    Loopback,
    /// Leaves the machine but stays on the local network.
    PrivateNetwork,
    /// Crosses the internet.
    PublicNetwork,
}

impl NetworkScope {
    /// True when the traffic leaves the user's computer.
    pub fn leaves_device(self) -> bool {
        !matches!(self, NetworkScope::Loopback)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_endpoints_are_recognised_by_name_and_by_address() {
        for raw in [
            "http://localhost:8080/v1",
            "http://127.0.0.1:11434",
            "http://127.0.0.2:1234/v1",
            "http://[::1]:8000/v1",
            "https://LocalHost./v1",
        ] {
            let endpoint = EndpointUrl::parse(raw).unwrap();
            assert_eq!(
                endpoint.scope(),
                NetworkScope::Loopback,
                "`{raw}` must be recognised as loopback"
            );
            assert!(endpoint.is_loopback());
        }
    }

    #[test]
    fn lan_addresses_are_private_and_public_addresses_are_public() {
        for raw in [
            "http://192.168.1.50:8080",
            "http://10.0.0.7:11434",
            "http://172.16.4.4:8000",
            "http://gpu-box.local:8080",
            "http://[fd00::1]:8080",
        ] {
            assert_eq!(
                EndpointUrl::parse(raw).unwrap().scope(),
                NetworkScope::PrivateNetwork,
                "`{raw}`"
            );
        }

        for raw in ["https://api.example.test/v1", "http://203.0.113.9:8080"] {
            assert_eq!(
                EndpointUrl::parse(raw).unwrap().scope(),
                NetworkScope::PublicNetwork,
                "`{raw}`"
            );
        }
    }

    #[test]
    fn only_http_and_https_endpoints_are_accepted() {
        assert!(EndpointUrl::parse("file:///etc/passwd").is_err());
        assert!(EndpointUrl::parse("data:text/plain,hello").is_err());
        assert!(EndpointUrl::parse("ftp://example.test/").is_err());
        assert!(EndpointUrl::parse("not a url").is_err());
        assert!(EndpointUrl::parse("   ").is_err());
        assert!(EndpointUrl::parse("http://").is_err());
    }

    #[test]
    fn plaintext_is_a_property_of_the_scheme_alone() {
        assert!(EndpointUrl::parse("http://127.0.0.1:8080")
            .unwrap()
            .is_plaintext());
        assert!(!EndpointUrl::parse("https://127.0.0.1:8080")
            .unwrap()
            .is_plaintext());
    }

    #[test]
    fn an_endpoint_round_trips_through_json_as_a_plain_string() {
        let endpoint = EndpointUrl::parse("http://127.0.0.1:11434/v1").unwrap();
        let json = serde_json::to_string(&endpoint).unwrap();
        assert_eq!(json, r#""http://127.0.0.1:11434/v1""#);
        assert_eq!(
            serde_json::from_str::<EndpointUrl>(&json).unwrap(),
            endpoint
        );
        assert_eq!(endpoint.host(), "127.0.0.1");
        assert_eq!(endpoint.port(), Some(11434));
    }

    #[test]
    fn a_stored_endpoint_that_is_not_a_url_fails_to_load_rather_than_being_trusted() {
        assert!(serde_json::from_str::<EndpointUrl>(r#""javascript:alert(1)""#).is_err());
    }
}
