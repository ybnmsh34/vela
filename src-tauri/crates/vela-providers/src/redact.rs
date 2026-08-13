//! Credential-safe request URLs, and the scrubber that backs them up.
//!
//! # THE LOAD-BEARING RULE OF THIS FILE
//!
//! `Auth::ApiKeyQuery` puts a credential **inside the URL**. A `String` is the
//! wrong type to hold that, for exactly the reason `String` is the wrong type
//! to hold a credential (`vela_core::secret::SecretValue`): every `{}` in an
//! error message, every `{:?}` in a derived `Debug`, and every library whose
//! own `Display` appends " for url (…)" will happily print it.
//!
//! Phase B shipped that bug. `map_reqwest_error` called `error.to_string()`,
//! `reqwest`'s `Display` appended the request URL query string included, and
//! `detail()` — which truncates and strips control characters but does **not**
//! redact — carried the key intact into `ProviderError::Transport`, and from
//! there into its `Display`, its `Debug` and its serde JSON. That JSON is the
//! shape `ProviderError` serialises across the IPC bridge to the low-trust
//! WebView, and it fires on the commonest failures there are: connection
//! refused, timeout, TLS handshake failure, mid-stream reset.
//!
//! Two mechanisms close it, and the first is the one that matters:
//!
//! 1. **[`RequestUrl`] is not formattable in a way that exposes the
//!    credential.** `Display` and `Debug` both render the redacted form. The
//!    wire form requires [`RequestUrl::expose`], which is deliberately awkward
//!    and easy to grep for — and there is exactly one production call site, in
//!    the transport, where the bytes go to the socket rather than to a string.
//!    Credential material can only *enter* a URL through
//!    [`RequestUrl::with_query_credential`], which takes a [`SecretValue`], so
//!    a URL that carries a credential always knows it does.
//! 2. **[`Scrubber`] is the belt to that pair of braces.** Any text derived
//!    from a request — a `reqwest` error string, an error body an endpoint
//!    echoed back at us — is passed through the needles the request itself
//!    carries before it becomes a `detail`. It runs *before* truncation on
//!    purpose: truncating first can cut a key in half and leave the prefix.
//!
//! Neither mechanism relies on anyone remembering to redact at a call site.

use std::fmt;
use std::ops::Range;
use std::sync::Arc;

use vela_core::secret::{SecretValue, REDACTED};

/// A request URL that may carry credential material in its query string.
///
/// Cheap to clone, compares by wire value, and prints redacted. See the module
/// docs for why it exists.
#[derive(Clone, Default)]
pub struct RequestUrl {
    wire: String,
    /// Byte ranges within `wire` holding credential material, as written.
    secret_spans: Vec<Range<usize>>,
    /// Every literal that must not survive into text derived from this URL:
    /// the credential as it appears on the wire and, when percent-encoding
    /// changed it, its raw form.
    needles: Vec<String>,
}

impl RequestUrl {
    /// A URL with no credential in it. The only other constructor is
    /// [`RequestUrl::with_query_credential`].
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            wire: url.into(),
            secret_spans: Vec::new(),
            needles: Vec::new(),
        }
    }

    /// Append `?<name>=<credential>` (or `&…`), remembering where the
    /// credential landed.
    ///
    /// **This is the only way a credential enters a URL in this workspace.**
    /// Four adapters used to hand-roll this with `format!` and four private
    /// copies of a percent-encoder; each one produced a `String` that had
    /// forgotten what was in it.
    pub fn with_query_credential(mut self, name: &str, value: &SecretValue) -> Self {
        let separator = if self.wire.contains('?') { '&' } else { '?' };
        self.wire.push(separator);
        self.wire.push_str(&percent_encode(name));
        self.wire.push('=');

        let encoded = percent_encode(value.expose());
        let start = self.wire.len();
        self.wire.push_str(&encoded);
        self.secret_spans.push(start..self.wire.len());

        if encoded != value.expose() {
            self.needles.push(value.expose().to_owned());
        }
        self.needles.push(encoded);
        self
    }

    /// The URL as it goes on the wire, credential included.
    ///
    /// Named to be conspicuous, like [`SecretValue::expose`]: every call site
    /// is a place where a credential leaves its wrapper. In shipping code there
    /// is exactly one, and it hands the bytes to the HTTP client.
    pub fn expose(&self) -> &str {
        &self.wire
    }

    /// The URL with every credential replaced by [`REDACTED`]. What `Display`
    /// and `Debug` render, and the only form safe to put in a message.
    pub fn redacted(&self) -> String {
        if self.secret_spans.is_empty() {
            return self.wire.clone();
        }
        let mut out = String::with_capacity(self.wire.len());
        let mut cursor = 0;
        for span in &self.secret_spans {
            out.push_str(&self.wire[cursor..span.start]);
            out.push_str(REDACTED);
            cursor = span.end;
        }
        out.push_str(&self.wire[cursor..]);
        out
    }

    pub fn carries_credential(&self) -> bool {
        !self.secret_spans.is_empty()
    }

    /// Substring test against the wire form. Returns a `bool`, so it can answer
    /// "is the key in there?" without ever producing a string that contains it.
    pub fn contains(&self, needle: &str) -> bool {
        self.wire.contains(needle)
    }

    pub fn starts_with(&self, prefix: &str) -> bool {
        self.wire.starts_with(prefix)
    }

    pub fn ends_with(&self, suffix: &str) -> bool {
        self.wire.ends_with(suffix)
    }

    pub fn is_empty(&self) -> bool {
        self.wire.is_empty()
    }

    /// The needles any text derived from this URL must be scrubbed of.
    pub fn scrubber(&self) -> Scrubber {
        Scrubber::new(self.needles.clone())
    }
}

impl fmt::Display for RequestUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.redacted())
    }
}

impl fmt::Debug for RequestUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Quoted, so it reads like the `String` it replaced in a derived
        // `Debug` — but redacted, which is the whole point of the type.
        write!(f, "{:?}", self.redacted())
    }
}

impl From<String> for RequestUrl {
    fn from(url: String) -> Self {
        Self::new(url)
    }
}

impl From<&str> for RequestUrl {
    fn from(url: &str) -> Self {
        Self::new(url)
    }
}

impl PartialEq for RequestUrl {
    fn eq(&self, other: &Self) -> bool {
        self.wire == other.wire
    }
}

impl Eq for RequestUrl {}

impl PartialEq<str> for RequestUrl {
    fn eq(&self, other: &str) -> bool {
        self.wire == other
    }
}

impl PartialEq<&str> for RequestUrl {
    fn eq(&self, other: &&str) -> bool {
        self.wire == *other
    }
}

impl PartialEq<String> for RequestUrl {
    fn eq(&self, other: &String) -> bool {
        &self.wire == other
    }
}

/// Percent-encode one query-string component.
///
/// Was four private copies, one per adapter. Unreserved characters only, per
/// RFC 3986 — everything else is escaped, including `&`, `=` and `#`, so a
/// credential can never restructure the query string it is being put into.
pub fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

/// Removes known credential material from text before it becomes an error.
///
/// Cheap to clone and cheap when empty — the overwhelmingly common case, since
/// most providers authenticate with a header and most requests carry no
/// credential at all.
#[derive(Clone, Default)]
pub struct Scrubber {
    needles: Arc<Vec<String>>,
}

impl Scrubber {
    pub fn new(needles: Vec<String>) -> Self {
        Self {
            needles: Arc::new(needles.into_iter().filter(|n| !n.is_empty()).collect()),
        }
    }

    /// A scrubber with nothing to remove.
    pub fn none() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.needles.is_empty()
    }

    /// Merge two scrubbers — a request's URL credential and its header
    /// credential are both material the same errors must not carry.
    pub fn merged(self, other: &Scrubber) -> Self {
        if other.is_empty() {
            return self;
        }
        if self.is_empty() {
            return other.clone();
        }
        let mut needles = self.needles.as_ref().clone();
        for needle in other.needles.iter() {
            if !needles.contains(needle) {
                needles.push(needle.clone());
            }
        }
        Self::new(needles)
    }

    /// Replace every occurrence of every needle with [`REDACTED`].
    pub fn scrub(&self, text: impl Into<String>) -> String {
        let mut text = text.into();
        for needle in self.needles.iter() {
            if text.contains(needle.as_str()) {
                text = text.replace(needle.as_str(), REDACTED);
            }
        }
        text
    }

    /// The same, over bytes — an error body an endpoint echoed back at us is
    /// not necessarily UTF-8, and must not be mangled into being.
    pub fn scrub_bytes(&self, bytes: Vec<u8>) -> Vec<u8> {
        if self.needles.is_empty() {
            return bytes;
        }
        let mut out = bytes;
        for needle in self.needles.iter() {
            out = replace_bytes(&out, needle.as_bytes(), REDACTED.as_bytes());
        }
        out
    }
}

impl fmt::Debug for Scrubber {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The needles ARE the credentials. Count only.
        write!(f, "Scrubber({} needles)", self.needles.len())
    }
}

fn replace_bytes(haystack: &[u8], needle: &[u8], with: &[u8]) -> Vec<u8> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return haystack.to_vec();
    }
    let mut out = Vec::with_capacity(haystack.len());
    let mut index = 0;
    while index <= haystack.len() - needle.len() {
        if &haystack[index..index + needle.len()] == needle {
            out.extend_from_slice(with);
            index += needle.len();
        } else {
            out.push(haystack[index]);
            index += 1;
        }
    }
    out.extend_from_slice(&haystack[index..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const CANARY: &str = "vela-canary-KEY-9f3a7d";

    #[test]
    fn a_url_carrying_a_credential_cannot_be_displayed_or_debugged_into_showing_it() {
        let url = RequestUrl::new("https://example.invalid/v1beta/models/m:generateContent")
            .with_query_credential("key", &SecretValue::new(CANARY));

        assert!(url.carries_credential());
        assert!(url.expose().contains(CANARY), "it is still on the wire");
        for rendering in [format!("{url}"), format!("{url:?}"), url.redacted()] {
            assert!(
                !rendering.contains(CANARY),
                "credential survived a rendering: {rendering}"
            );
            assert!(rendering.contains(REDACTED), "got {rendering}");
        }
    }

    #[test]
    fn the_separator_follows_whatever_query_string_the_url_already_has() {
        let plain =
            RequestUrl::new("https://e.invalid/x").with_query_credential("key", &"k".into());
        assert_eq!(plain.expose(), "https://e.invalid/x?key=k");
        let existing = RequestUrl::new("https://e.invalid/x?alt=sse")
            .with_query_credential("key", &"k".into());
        assert_eq!(existing.expose(), "https://e.invalid/x?alt=sse&key=k");
    }

    #[test]
    fn a_credential_cannot_restructure_the_query_string_it_is_put_into() {
        let url = RequestUrl::new("https://e.invalid/x")
            .with_query_credential("key", &"a&admin=1#".into());
        assert_eq!(url.expose(), "https://e.invalid/x?key=a%26admin%3D1%23");
        assert!(!url.redacted().contains("admin"));
    }

    #[test]
    fn both_the_encoded_and_the_raw_form_of_a_credential_are_scrubbed() {
        let raw = "key with spaces/and+slashes";
        let url = RequestUrl::new("https://e.invalid/x").with_query_credential("key", &raw.into());
        let scrubber = url.scrubber();
        let encoded = percent_encode(raw);

        assert!(!scrubber
            .scrub(format!("boom for url (…?key={encoded})"))
            .contains(&encoded));
        assert!(!scrubber.scrub(format!("boom: {raw}")).contains(raw));
    }

    #[test]
    fn scrubbing_runs_over_bytes_without_assuming_utf8() {
        let scrubber = Scrubber::new(vec![CANARY.to_owned()]);
        let mut body = vec![0xff, 0xfe];
        body.extend_from_slice(format!(r#"{{"error":"bad key {CANARY}"}}"#).as_bytes());
        let scrubbed = scrubber.scrub_bytes(body);
        assert_eq!(
            &scrubbed[..2],
            &[0xff, 0xfe],
            "the non-UTF-8 prefix survives"
        );
        assert!(!String::from_utf8_lossy(&scrubbed).contains(CANARY));
    }

    #[test]
    fn an_empty_scrubber_is_the_identity_and_says_so() {
        let scrubber = Scrubber::none();
        assert!(scrubber.is_empty());
        assert_eq!(scrubber.scrub("untouched"), "untouched");
        assert_eq!(scrubber.scrub_bytes(b"untouched".to_vec()), b"untouched");
    }

    #[test]
    fn a_scrubber_never_prints_its_needles() {
        let scrubber = Scrubber::new(vec![CANARY.to_owned()]);
        assert!(!format!("{scrubber:?}").contains(CANARY));
    }

    #[test]
    fn merging_keeps_both_sets_and_deduplicates() {
        let a = Scrubber::new(vec!["one".into(), "two".into()]);
        let b = Scrubber::new(vec!["two".into(), "three".into()]);
        let merged = a.merged(&b);
        assert_eq!(
            merged.scrub("one two three"),
            "<redacted> <redacted> <redacted>"
        );
    }

    #[test]
    fn a_url_with_no_credential_renders_verbatim() {
        let url = RequestUrl::new("http://127.0.0.1:11434/v1/models");
        assert!(!url.carries_credential());
        assert_eq!(url.to_string(), "http://127.0.0.1:11434/v1/models");
        assert!(url.scrubber().is_empty());
    }
}
