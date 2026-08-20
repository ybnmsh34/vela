//! The HTTP seam this crate reaches the network through — and does not own.
//!
//! ## Why a trait and not a client
//!
//! `vela-settings/tests/capability_matrix_endpoints.rs` asserts, against the
//! tree, that **exactly one crate in this workspace declares an HTTP client**
//! and that it is `vela-providers`. That is not a formality: it is what makes
//! "every byte Vela sends leaves from one auditable place" checkable rather than
//! narrated, and it is what stops a second crate from quietly acquiring its own
//! redirect policy, its own proxy behaviour and its own idea of what a
//! credential header is.
//!
//! So `vela-mcp` declares no client. It declares [`HttpExchange`], one
//! round-trip, and the composition root supplies an implementation. The stdio
//! transport beside it owns a process because a process is not something a
//! seam can hand you; a socket is.
//!
//! ## Synchronous on purpose
//!
//! Everything in this crate is. `StdioTransport::request` blocks the caller and
//! wakes on a channel, `McpPool::connect` blocks while a server starts, and
//! `mcp_list_tools` is a synchronous Tauri command. An async seam here would put
//! a runtime boundary in the middle of one crate for the sake of one of its two
//! transports, and every caller would pay for it.
//!
//! ## What is redacted, and where
//!
//! [`HttpCall`] records which of its headers were given credential material, and
//! its `Debug` prints [`REDACTED`] for those values. It also redacts the query
//! string of its URL unconditionally — `config::validate_remote_url` refuses a
//! credential-named query parameter, but "no parameter we recognise" is not
//! "no credential", and a `Debug` that prints a URL is the cheapest possible
//! leak.

use std::fmt;
use std::time::Duration;

use vela_core::secret::{SecretValue, REDACTED};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpMethod {
    Get,
    Post,
    Delete,
}

impl HttpMethod {
    pub const fn as_str(self) -> &'static str {
        match self {
            HttpMethod::Get => "GET",
            HttpMethod::Post => "POST",
            HttpMethod::Delete => "DELETE",
        }
    }
}

/// One outbound request.
#[derive(Clone, PartialEq, Eq)]
pub struct HttpCall {
    pub method: HttpMethod,
    pub url: String,
    /// Header names are lowercase, always. The transport merges its own headers
    /// with the user's configured ones and a case difference would send two.
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    /// Lowercased names of the headers this call was given as credentials.
    /// Private: set by [`HttpCall::with_credential_header`] and nowhere else.
    secret_headers: Vec<String>,
    /// True when [`HttpCall::with_form_body`] built the body from credential
    /// material. Private, for the same reason.
    secret_body: bool,
}

impl HttpCall {
    pub fn get(url: impl Into<String>) -> Self {
        Self::new(HttpMethod::Get, url)
    }

    pub fn post(url: impl Into<String>) -> Self {
        Self::new(HttpMethod::Post, url)
    }

    pub fn delete(url: impl Into<String>) -> Self {
        Self::new(HttpMethod::Delete, url)
    }

    fn new(method: HttpMethod, url: impl Into<String>) -> Self {
        Self {
            method,
            url: url.into(),
            headers: Vec::new(),
            body: None,
            secret_headers: Vec::new(),
            secret_body: false,
        }
    }

    pub fn with_header(mut self, name: impl AsRef<str>, value: impl Into<String>) -> Self {
        self.headers
            .push((name.as_ref().to_ascii_lowercase(), value.into()));
        self
    }

    /// **The one place a credential is attached to an MCP request.**
    ///
    /// Attaching one anywhere else would mean a second copy of the rule that a
    /// credential header is a thing `Debug` must not print, and the second copy
    /// is the one that gets forgotten.
    pub fn with_credential_header(mut self, name: impl AsRef<str>, value: &SecretValue) -> Self {
        let name = name.as_ref().to_ascii_lowercase();
        self.headers.push((name.clone(), value.expose().to_owned()));
        self.secret_headers.push(name);
        self
    }

    pub fn with_json_body(mut self, body: Vec<u8>) -> Self {
        self.headers
            .push(("content-type".to_owned(), "application/json".to_owned()));
        self.body = Some(body);
        self
    }

    /// A form-encoded body built from credential material — an OAuth refresh.
    ///
    /// **The body, never the URL.** A refresh token in a query string reaches
    /// the authorization server's access log, every proxy on the path and the
    /// `Referer` of whatever the response links to. `crate::oauth` is the only
    /// caller and `oauth::tests` holds the URL down.
    pub fn with_form_body(mut self, body: &SecretValue) -> Self {
        self.headers.push((
            "content-type".to_owned(),
            "application/x-www-form-urlencoded".to_owned(),
        ));
        self.body = Some(body.expose().as_bytes().to_vec());
        self.secret_body = true;
        self
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    /// Whether this call was told the named header is credential material.
    /// Exposed so a test can assert the transport marked one, rather than
    /// inferring it from a `Debug` string.
    pub fn is_credential_header(&self, name: &str) -> bool {
        let lower = name.to_ascii_lowercase();
        self.secret_headers.contains(&lower)
    }

    /// The URL with its query string replaced. See the module docs.
    fn redacted_url(&self) -> String {
        match self.url.split_once('?') {
            Some((head, _)) => format!("{head}?{REDACTED}"),
            None => self.url.clone(),
        }
    }
}

impl fmt::Debug for HttpCall {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let headers: Vec<(&str, &str)> = self
            .headers
            .iter()
            .map(|(name, value)| {
                if self.secret_headers.contains(name) {
                    (name.as_str(), REDACTED)
                } else {
                    (name.as_str(), value.as_str())
                }
            })
            .collect();
        f.debug_struct("HttpCall")
            .field("method", &self.method)
            .field("url", &self.redacted_url())
            .field("headers", &headers)
            .field(
                "body",
                &match (&self.body, self.secret_body) {
                    (None, _) => "none".to_owned(),
                    (Some(_), true) => REDACTED.to_owned(),
                    (Some(bytes), false) => format!("{} bytes", bytes.len()),
                },
            )
            .finish()
    }
}

/// One inbound response, read to the end.
///
/// Read to the end, and not a stream, because of what this seam is for: MCP's
/// Streamable HTTP transport answers a POST with either one JSON object or a
/// short `text/event-stream` the server closes when the request it answers is
/// done. What a stream would buy — a long-lived server-to-client channel opened
/// with `GET` — is **not implemented**, and is stated as missing on
/// `crate::http::HttpTransport` rather than implied by a type that could carry
/// it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpReply {
    pub status: u16,
    /// Lowercased names.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpReply {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    /// The media type, lowercased, without parameters.
    pub fn media_type(&self) -> String {
        self.header("content-type")
            .unwrap_or_default()
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
    }
}

/// Why a round-trip did not produce a response at all.
///
/// A response with a bad status is **not** one of these: that is an answer, and
/// the transport judges it. These are the cases where nothing came back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExchangeError {
    /// DNS, TLS, connect, or the connection dropped mid-body.
    Unreachable(String),
    /// Nothing arrived inside the deadline the caller gave.
    TimedOut,
    /// The response was larger than the caller allowed. Its own arm because a
    /// hostile server that answers with an endless body is not the same event
    /// as one that is down.
    TooLarge,
}

impl std::fmt::Display for ExchangeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ExchangeError::Unreachable(detail) => write!(f, "{detail}"),
            ExchangeError::TimedOut => f.write_str("no response within the deadline"),
            ExchangeError::TooLarge => f.write_str("the response exceeded the size limit"),
        }
    }
}

/// The ceiling on one response body.
///
/// The same number and the same argument as `stdio::MAX_MESSAGE_BYTES`: a body
/// is accumulated before it can be parsed, so an unbounded reader hands a
/// hostile — or merely broken — server the ability to exhaust the app's memory.
/// An implementation of [`HttpExchange`] is responsible for enforcing it and
/// returning [`ExchangeError::TooLarge`]; `crate::http` cannot, because by the
/// time it holds the bytes they are already allocated.
pub const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// One HTTP round-trip. Supplied by the composition root.
pub trait HttpExchange: Send + Sync {
    /// Send `call` and read the whole response, or fail.
    ///
    /// The implementation must:
    /// * follow **no** redirects — a redirect is how an endpoint sends a
    ///   credential header to a host the user never named;
    /// * use **no** ambient proxy;
    /// * stop reading at [`MAX_RESPONSE_BYTES`];
    /// * give up after `timeout`.
    ///
    /// The first two are `vela-providers`' existing posture, proved on the wire
    /// by its `wire_redirect_egress.rs` and `wire_proxy_egress.rs`.
    fn send(&self, call: HttpCall, timeout: Duration) -> Result<HttpReply, ExchangeError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    const CANARY: &str = "sk-live-canary-DO-NOT-LOG";

    #[test]
    fn a_credential_header_is_sent_and_never_printed() {
        let call = HttpCall::post("https://mcp.example.com/mcp")
            .with_header("x-tenant", "acme")
            .with_credential_header(
                "Authorization",
                &SecretValue::new(format!("Bearer {CANARY}")),
            );

        // It really is on the request.
        assert_eq!(
            call.header("authorization"),
            Some(format!("Bearer {CANARY}").as_str())
        );
        assert!(call.is_credential_header("authorization"));

        let printed = format!("{call:?}");
        assert!(!printed.contains(CANARY), "{printed}");
        assert!(printed.contains("x-tenant"), "{printed}");
        assert!(printed.contains(REDACTED), "{printed}");
    }

    #[test]
    fn a_query_string_is_redacted_even_though_one_may_not_hold_a_credential() {
        let call = HttpCall::get("https://mcp.example.com/mcp?tenant=acme");
        let printed = format!("{call:?}");
        assert!(!printed.contains("tenant=acme"), "{printed}");
        assert!(printed.contains("https://mcp.example.com/mcp"), "{printed}");

        // A URL with no query is printed whole: it is the one thing a reader of
        // a diagnostic ring needs in order to know which server failed.
        let plain = HttpCall::get("https://mcp.example.com/mcp");
        assert!(format!("{plain:?}").contains("https://mcp.example.com/mcp"));
    }

    #[test]
    fn a_form_body_built_from_a_credential_prints_as_redacted() {
        let call = HttpCall::post("https://auth.example.com/token")
            .with_form_body(&SecretValue::new(format!("refresh_token={CANARY}")));
        let printed = format!("{call:?}");
        assert!(!printed.contains(CANARY), "{printed}");
        assert!(printed.contains(REDACTED), "{printed}");

        // A body that is not credential material prints its size, which is what
        // a diagnostic actually wants.
        let json = HttpCall::post("https://mcp.example.com/mcp").with_json_body(b"{}".to_vec());
        assert!(format!("{json:?}").contains("2 bytes"));
    }

    #[test]
    fn header_names_are_lowercased_on_the_way_in() {
        let call = HttpCall::get("https://x.example").with_header("X-Tenant", "acme");
        assert_eq!(call.headers[0].0, "x-tenant");
        assert_eq!(call.header("X-TENANT"), Some("acme"));
    }

    #[test]
    fn the_media_type_drops_parameters_and_case() {
        let reply = HttpReply {
            status: 200,
            headers: vec![(
                "Content-Type".into(),
                "TEXT/Event-Stream; charset=utf-8".into(),
            )],
            body: Vec::new(),
        };
        assert_eq!(reply.media_type(), "text/event-stream");

        let none = HttpReply {
            status: 202,
            headers: Vec::new(),
            body: Vec::new(),
        };
        assert_eq!(none.media_type(), "");
    }
}
