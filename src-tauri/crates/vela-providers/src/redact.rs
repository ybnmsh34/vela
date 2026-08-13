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
//!
//! # Why a byte-literal scrub is not enough (round 4)
//!
//! Round 3 made the byte stream the place redaction happens, and that held —
//! but a byte scrub only removes the spelling it was given. An endpoint that
//! echoes the credential back **encoded** defeats it, and Vela's own decoder
//! then puts the secret back together downstream of every scrub point. The
//! reproduction was a `Bearer` key containing `/` and an endpoint whose JSON
//! encoder escapes `/` as `\/` — the default behaviour of PHP's `json_encode`,
//! and therefore of every gateway written in it. `sk\/x\/KEY` matches no
//! needle, is released verbatim, and `serde_json` hands back `sk/x/KEY`.
//!
//! Enumerating escape forms is how that defect was born, so this file does not
//! enumerate them. Two mechanisms, and neither is a list:
//!
//! * [`Scrubber::scrub_bytes`] matches against a **decoded view** of the bytes
//!   (see [`DecodedView`]): JSON string escapes are resolved left to right and
//!   the needle is looked for in the result, so `\/`, `\\`, `\"`, `\n` and
//!   `\uXXXX` — in any mixture, including a credential spelled entirely in
//!   `\u00XX` — are all one case rather than five. The span that is replaced is
//!   the *source* span, so the surrounding bytes are untouched.
//! * [`Scrubber::scrub_value`] runs **after** a decode, on the decoded strings,
//!   where every encoding the decoder understands has already been undone. This
//!   is the barrier that does not depend on this file having anticipated the
//!   encoding at all: whatever spelling arrived, `serde_json` normalised it,
//!   and the raw needle matches what it produced.
//!
//! The two are independent on purpose. The first keeps round 3's property that
//! *the bytes Vela's parser reads are already clean* — which is what protects a
//! recorder, a cache, or a Phase C diagnostics panel that never decodes
//! anything. The second protects the error path, which sits after a decode.

use std::fmt;
use std::ops::Range;
use std::sync::Arc;

use serde_json::Value;
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

    /// Replace every occurrence of every needle with [`REDACTED`] — in the text
    /// as written, and in the text as a JSON decoder would read it.
    pub fn scrub(&self, text: impl Into<String>) -> String {
        let text = text.into();
        if self.needles.is_empty() {
            return text;
        }
        let mut literal = text;
        for needle in self.needles.iter() {
            if literal.contains(needle.as_str()) {
                literal = literal.replace(needle.as_str(), REDACTED);
            }
        }
        if !literal.as_bytes().contains(&b'\\') {
            return literal;
        }
        // Every span this replaces is a whole decoded character, and [`REDACTED`]
        // is ASCII, so the result is still UTF-8 — but a scrub that could
        // corrupt text is worse than one that misses an exotic spelling, so the
        // literal form is kept if it somehow is not.
        match String::from_utf8(self.replace_encoded(literal.clone().into_bytes())) {
            Ok(scrubbed) => scrubbed,
            Err(_) => literal,
        }
    }

    /// Remove credential material from every string in a **decoded** JSON value
    /// — the second barrier, and the one that does not depend on this file
    /// having anticipated the endpoint's encoding.
    ///
    /// By the time a `Value` exists, `serde_json` has already undone whatever
    /// escaping the endpoint applied, so the credential is back in its raw form
    /// and the raw needle finds it. Run this at the decode, not at the point the
    /// string becomes a message: a decode has many consumers and only one site.
    ///
    /// Object *keys* are scrubbed too. A credential is a poor key, but a key is
    /// a string an endpoint chose, and none of Vela's parsers look for a key
    /// that contains one.
    pub fn scrub_value(&self, value: &mut Value) {
        if self.needles.is_empty() {
            return;
        }
        match value {
            Value::String(text) => {
                if self.touches(text) {
                    *text = self.scrub(std::mem::take(text));
                }
            }
            Value::Array(items) => {
                for item in items {
                    self.scrub_value(item);
                }
            }
            Value::Object(map) => {
                let rename: Vec<String> = map
                    .keys()
                    .filter(|key| self.touches(key))
                    .cloned()
                    .collect();
                for key in rename {
                    if let Some(entry) = map.remove(&key) {
                        map.insert(self.scrub(key), entry);
                    }
                }
                for (_, entry) in map.iter_mut() {
                    self.scrub_value(entry);
                }
            }
            _ => {}
        }
    }

    /// Decode JSON that came from an endpoint, scrubbed.
    ///
    /// **This is how this crate decodes an upstream body, and the reason is the
    /// round-4 defect:** a byte scrub removes the spelling it was shown, and a
    /// decoder's whole job is to turn one spelling into another. Decoding
    /// through here means every string the rest of the code reads out of the
    /// result — an error message, an answer fragment, a tool-call argument —
    /// has been through the needles *after* the decoder finished with it.
    pub fn decode_json(&self, bytes: &[u8]) -> Result<Value, serde_json::Error> {
        let mut value: Value = serde_json::from_slice(bytes)?;
        self.scrub_value(&mut value);
        Ok(value)
    }

    /// The same, for a frame that has already been split out of a stream.
    pub fn decode_json_str(&self, text: &str) -> Result<Value, serde_json::Error> {
        let mut value: Value = serde_json::from_str(text)?;
        self.scrub_value(&mut value);
        Ok(value)
    }

    /// Whether `text` contains anything this scrubber would remove — literally
    /// or in any spelling a JSON decoder would resolve to a needle.
    fn touches(&self, text: &str) -> bool {
        if self
            .needles
            .iter()
            .any(|needle| text.contains(needle.as_str()))
        {
            return true;
        }
        text.as_bytes().contains(&b'\\') && !self.encoded_spans(text.as_bytes()).is_empty()
    }

    /// How many bytes at the end of `bytes` must be held back before the rest
    /// can be released, because they may be the front half of a needle.
    ///
    /// # Why a streamed body needs this and a buffered one does not
    ///
    /// [`Scrubber::scrub_bytes`] can only remove a needle it can see whole. A
    /// body read in chunks hands out `…"message":"bad key vela-can` and then
    /// `ary-9f3a…` — two chunks, neither containing the credential, the
    /// credential nonetheless delivered. Scrubbing per chunk without this would
    /// be a redaction that a TCP segment boundary defeats.
    ///
    /// Returns the longest suffix of `bytes` that is a *proper prefix* of some
    /// needle — normally 0, so the ordinary chunk is released whole and
    /// streaming latency is unchanged.
    pub fn hold_back_len(&self, bytes: &[u8]) -> usize {
        let mut hold = 0usize;
        for needle in self.needles.iter() {
            let needle = needle.as_bytes();
            // A *proper* prefix: a whole needle would already have been
            // replaced by `scrub_bytes`, so it is not a reason to wait.
            let longest = (needle.len() - 1).min(bytes.len());
            for length in (hold + 1..=longest).rev() {
                if bytes[bytes.len() - length..] == needle[..length] {
                    hold = length;
                    break;
                }
            }
        }
        // …and the same question asked of the decoded view, because an escaped
        // credential straddling a chunk boundary is still a credential. The
        // suffix that must wait is longer here: `/` is six source bytes
        // for one decoded one.
        hold.max(self.encoded_hold_back_len(bytes))
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
        self.replace_encoded(out)
    }

    /// Replace every span of `bytes` that a JSON decoder would read as a needle.
    ///
    /// The literal pass has already run, so what is left here is only material
    /// that is spelled differently from how it will be read.
    fn replace_encoded(&self, bytes: Vec<u8>) -> Vec<u8> {
        if !bytes.contains(&b'\\') {
            // No escape means the decoded view is the source view, and the
            // literal pass has already covered it. This is the ordinary chunk.
            return bytes;
        }
        let spans = self.encoded_spans(&bytes);
        if spans.is_empty() {
            return bytes;
        }
        let mut out = Vec::with_capacity(bytes.len());
        let mut cursor = 0usize;
        for (start, end) in spans {
            if start < cursor {
                continue;
            }
            out.extend_from_slice(&bytes[cursor..start]);
            out.extend_from_slice(REDACTED.as_bytes());
            cursor = end;
        }
        out.extend_from_slice(&bytes[cursor..]);
        out
    }

    /// Source-byte spans of `bytes` that decode to a needle. Ascending, and
    /// non-overlapping.
    fn encoded_spans(&self, bytes: &[u8]) -> Vec<(usize, usize)> {
        let view = DecodedView::build(bytes);
        if !view.saw_escape {
            return Vec::new();
        }
        let mut spans: Vec<(usize, usize)> = Vec::new();
        for needle in self.needles.iter() {
            let needle = needle.as_bytes();
            let mut at = 0usize;
            while at + needle.len() <= view.decoded.len() {
                if &view.decoded[at..at + needle.len()] == needle {
                    spans.push(view.source_span(at, at + needle.len()));
                    at += needle.len();
                } else {
                    at += 1;
                }
            }
        }
        spans.sort_unstable();
        spans.dedup();
        spans
    }

    /// How many trailing bytes could still turn out to be the front half of an
    /// *encoded* needle once more bytes arrive.
    fn encoded_hold_back_len(&self, bytes: &[u8]) -> usize {
        if !bytes.contains(&b'\\') {
            return 0;
        }
        let view = DecodedView::build(bytes);
        if !view.saw_escape && view.incomplete_escape_at.is_none() {
            return 0;
        }
        // A source suffix that ends inside an escape sequence cannot be
        // interpreted until the rest of it arrives.
        let mut earliest = view.incomplete_escape_at.unwrap_or(bytes.len());
        for needle in self.needles.iter() {
            let needle = needle.as_bytes();
            let longest = (needle.len() - 1).min(view.decoded.len());
            for length in (1..=longest).rev() {
                let from = view.decoded.len() - length;
                if view.decoded[from..] == needle[..length] {
                    earliest = earliest.min(view.source_span(from, view.decoded.len()).0);
                    break;
                }
            }
        }
        bytes.len() - earliest
    }
}

/// `bytes` as a JSON decoder would read them, with every decoded byte
/// remembering the source it came from.
///
/// This is what makes escape-awareness one mechanism instead of a list of
/// spellings: the escapes are *resolved* rather than anticipated, so `\/`,
/// `\uXXXX`, a surrogate pair and any mixture of them are the same case. Bytes
/// that are not part of a valid escape are carried through unchanged, so a body
/// that is not JSON at all decodes to itself.
struct DecodedView {
    decoded: Vec<u8>,
    /// Per decoded byte, the source span that produced it. Several decoded
    /// bytes share a span when one escape decodes to a multi-byte character.
    spans: Vec<(usize, usize)>,
    /// Set when the source ends part-way through an escape sequence: those
    /// bytes cannot be read until the rest arrives.
    incomplete_escape_at: Option<usize>,
    /// Whether any escape was resolved at all. When false the decoded view is
    /// the source view and there is nothing here the literal pass missed.
    saw_escape: bool,
}

impl DecodedView {
    fn build(bytes: &[u8]) -> Self {
        let mut view = Self {
            decoded: Vec::with_capacity(bytes.len()),
            spans: Vec::with_capacity(bytes.len()),
            incomplete_escape_at: None,
            saw_escape: false,
        };
        let mut index = 0usize;
        while index < bytes.len() {
            if bytes[index] == b'\\' {
                match decode_escape(bytes, index) {
                    Escape::Decoded(decoded, consumed) => {
                        view.saw_escape = true;
                        for byte in decoded {
                            view.decoded.push(byte);
                            view.spans.push((index, index + consumed));
                        }
                        index += consumed;
                        continue;
                    }
                    Escape::Incomplete => {
                        view.incomplete_escape_at = Some(index);
                        break;
                    }
                    // Not an escape at all — a lone backslash in prose. It is
                    // its own decoded byte.
                    Escape::Invalid => {}
                }
            }
            view.decoded.push(bytes[index]);
            view.spans.push((index, index + 1));
            index += 1;
        }
        view
    }

    /// The source span covering decoded bytes `[from, to)`.
    fn source_span(&self, from: usize, to: usize) -> (usize, usize) {
        let start = self.spans[from].0;
        let end = self.spans[to - 1].1;
        (start, end)
    }
}

enum Escape {
    /// The decoded bytes, and how many source bytes they consumed.
    Decoded(Vec<u8>, usize),
    /// A backslash that begins no escape sequence.
    Invalid,
    /// An escape sequence the source ends in the middle of.
    Incomplete,
}

/// Resolve the JSON escape starting at `at`, where `bytes[at]` is `\`.
fn decode_escape(bytes: &[u8], at: usize) -> Escape {
    let Some(&marker) = bytes.get(at + 1) else {
        return Escape::Incomplete;
    };
    let simple = |byte: u8| Escape::Decoded(vec![byte], 2);
    match marker {
        b'"' => simple(b'"'),
        b'\\' => simple(b'\\'),
        b'/' => simple(b'/'),
        b'b' => simple(0x08),
        b'f' => simple(0x0C),
        b'n' => simple(b'\n'),
        b'r' => simple(b'\r'),
        b't' => simple(b'\t'),
        b'u' => decode_unicode_escape(bytes, at),
        _ => Escape::Invalid,
    }
}

fn decode_unicode_escape(bytes: &[u8], at: usize) -> Escape {
    let unit = match hex_quad(bytes, at + 2) {
        Hex::Value(unit) => unit,
        Hex::Short => return Escape::Incomplete,
        Hex::NotHex => return Escape::Invalid,
    };
    // A lone high surrogate is only half a character: the low half follows as a
    // second `\uXXXX`, and without it there is nothing to decode.
    if (0xD800..0xDC00).contains(&unit) {
        if bytes.get(at + 6) != Some(&b'\\') || bytes.get(at + 7) != Some(&b'u') {
            return if at + 8 > bytes.len() {
                Escape::Incomplete
            } else {
                Escape::Invalid
            };
        }
        let low = match hex_quad(bytes, at + 8) {
            Hex::Value(low) => low,
            Hex::Short => return Escape::Incomplete,
            Hex::NotHex => return Escape::Invalid,
        };
        if !(0xDC00..0xE000).contains(&low) {
            return Escape::Invalid;
        }
        let code = 0x1_0000 + ((u32::from(unit) - 0xD800) << 10) + (u32::from(low) - 0xDC00);
        return match char::from_u32(code) {
            Some(ch) => Escape::Decoded(ch.to_string().into_bytes(), 12),
            None => Escape::Invalid,
        };
    }
    match char::from_u32(u32::from(unit)) {
        Some(ch) => Escape::Decoded(ch.to_string().into_bytes(), 6),
        None => Escape::Invalid,
    }
}

enum Hex {
    Value(u16),
    /// The source ends before the four digits do.
    Short,
    NotHex,
}

fn hex_quad(bytes: &[u8], at: usize) -> Hex {
    let mut value = 0u16;
    for offset in 0..4 {
        let Some(&byte) = bytes.get(at + offset) else {
            return Hex::Short;
        };
        let digit = match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            b'A'..=b'F' => byte - b'A' + 10,
            _ => return Hex::NotHex,
        };
        value = value * 16 + u16::from(digit);
    }
    Hex::Value(value)
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

    // -----------------------------------------------------------------
    // Round 4: the encoding the endpoint chose is not the encoding we
    // remembered
    // -----------------------------------------------------------------

    /// The reproduction, verbatim: a key with `/` in it and an endpoint whose
    /// JSON encoder escapes `/` — PHP's `json_encode` default.
    const SLASHED: &str = "sk/critic/ESCAPE-PROBE-9f3a2b1c";

    fn php_escaped(text: &str) -> String {
        text.replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('/', "\\/")
    }

    #[test]
    fn an_endpoint_that_escapes_the_solidus_does_not_get_the_credential_past_the_byte_scrub() {
        let scrubber = Scrubber::new(vec![SLASHED.to_owned()]);
        let body = format!(
            r#"{{"error":{{"message":"invalid credential: Bearer {}"}}}}"#,
            php_escaped(SLASHED)
        );
        assert!(
            !body.contains(SLASHED),
            "the premise: no needle appears literally in these bytes"
        );

        let scrubbed = scrubber.scrub_bytes(body.into_bytes());
        let text = String::from_utf8(scrubbed).expect("still UTF-8");

        assert!(text.contains(REDACTED), "got {text}");
        assert!(
            text.contains("invalid credential: Bearer") && text.contains("\"error\""),
            "redaction removes the secret, not the diagnosis: {text}"
        );
        // The decoder is the adversary here: what matters is what it produces.
        let decoded: Value = serde_json::from_str(&text).expect("still valid JSON");
        assert!(
            !decoded.to_string().contains(SLASHED),
            "the decoder reconstituted it: {decoded}"
        );
    }

    #[test]
    fn a_credential_spelled_entirely_in_unicode_escapes_is_still_removed() {
        // No `/`, no `\"`, nothing the escaping test above covers — every byte
        // spelled `\u00XX`. One mechanism has to answer both.
        let needle = "AKIA-abc123";
        let spelled: String = needle.chars().map(|ch| format!("\\u{:04x}", ch as u32)).collect();
        let scrubber = Scrubber::new(vec![needle.to_owned()]);
        let scrubbed = scrubber.scrub(format!("rejected key {spelled} at gateway"));
        assert_eq!(scrubbed, format!("rejected key {REDACTED} at gateway"));
    }

    #[test]
    fn a_mixture_of_spellings_inside_one_credential_is_one_case_not_three() {
        let needle = "a/b\"c";
        // `/` escaped as `\/`, `"` escaped as `\"`, `b` spelled `\u0062`.
        let spelled = "a\\/\\u0062\\\"c";
        let scrubber = Scrubber::new(vec![needle.to_owned()]);
        assert_eq!(scrubber.scrub(format!("<{spelled}>")), format!("<{REDACTED}>"));
    }

    #[test]
    fn a_surrogate_pair_spelling_of_a_non_ascii_credential_is_removed() {
        let needle = "key-\u{1F510}-tail";
        let spelled = "key-\\ud83d\\udd10-tail";
        let scrubber = Scrubber::new(vec![needle.to_owned()]);
        assert_eq!(scrubber.scrub(spelled.to_owned()), REDACTED);
    }

    #[test]
    fn an_escaped_credential_split_across_two_chunks_is_still_removed() {
        let scrubber = Scrubber::new(vec![SLASHED.to_owned()]);
        let whole = format!("prefix {} suffix", php_escaped(SLASHED));
        let bytes = whole.as_bytes();

        // Every split point, because a TCP segment lands wherever it lands —
        // including in the middle of a `\u`-style escape.
        for split in 0..bytes.len() {
            let mut carry: Vec<u8> = Vec::new();
            let mut released: Vec<u8> = Vec::new();
            for piece in [&bytes[..split], &bytes[split..]] {
                carry.extend_from_slice(piece);
                let scrubbed = scrubber.scrub_bytes(std::mem::take(&mut carry));
                let hold = scrubber.hold_back_len(&scrubbed);
                let mut scrubbed = scrubbed;
                carry = scrubbed.split_off(scrubbed.len() - hold);
                released.extend_from_slice(&scrubbed);
            }
            released.extend_from_slice(&scrubber.scrub_bytes(carry));

            let text = String::from_utf8(released).expect("UTF-8");
            assert_eq!(
                text,
                format!("prefix {REDACTED} suffix"),
                "split at {split} let an encoded credential through"
            );
        }
    }

    #[test]
    fn the_second_barrier_runs_after_the_decoder_has_undone_the_encoding() {
        // `scrub_value` is not given the endpoint's spelling — it is given what
        // the decoder made of it. That is why it needs no list of encodings.
        let scrubber = Scrubber::new(vec![SLASHED.to_owned()]);
        let body = format!(
            r#"{{"error":{{"message":"bad key {}","code":"invalid_api_key"}}}}"#,
            php_escaped(SLASHED)
        );
        let value = scrubber
            .decode_json(body.as_bytes())
            .expect("the body is JSON");
        assert_eq!(value["error"]["code"], "invalid_api_key", "diagnosis kept");
        assert_eq!(
            value["error"]["message"].as_str().expect("a string"),
            format!("bad key {REDACTED}")
        );
    }

    #[test]
    fn positive_control_a_scrubber_blind_to_encoding_leaks_through_the_decoder() {
        // Every assertion above is a negative. This one asserts the hole is
        // real: the literal-only scrub round 3 shipped releases the escaped
        // form verbatim, and `serde_json` puts the credential back together.
        let literal_only = |bytes: Vec<u8>| replace_bytes(&bytes, SLASHED.as_bytes(), REDACTED.as_bytes());
        let body = format!(r#"{{"m":"bad key {}"}}"#, php_escaped(SLASHED));

        let released = literal_only(body.into_bytes());
        let decoded: Value = serde_json::from_slice(&released).expect("JSON");
        assert_eq!(
            decoded["m"].as_str().expect("a string"),
            format!("bad key {SLASHED}"),
            "if this stops leaking, the tests above are vacuous"
        );
    }

    #[test]
    fn scrub_value_reaches_every_string_in_a_decoded_body_including_keys() {
        let scrubber = Scrubber::new(vec![CANARY.to_owned()]);
        let mut value = serde_json::json!({
            "choices": [{"message": {"content": format!("your key is {CANARY}")}}],
            CANARY: "a key can carry one too",
            "nested": {"deep": [[format!("{CANARY}")]]},
            "count": 7
        });
        scrubber.scrub_value(&mut value);
        let rendered = value.to_string();
        assert!(!rendered.contains(CANARY), "got {rendered}");
        assert!(rendered.contains("your key is <redacted>"));
        assert_eq!(value["count"], 7, "non-strings are untouched");
    }

    #[test]
    fn text_that_is_not_json_survives_the_decoded_view_unchanged() {
        // A body that is not JSON must decode to itself: an escape-aware scrub
        // that mangled prose would be a worse bug than the one it fixes.
        let scrubber = Scrubber::new(vec![CANARY.to_owned()]);
        for text in [
            r"C:\Users\model\weights.gguf",
            r"a lone \ backslash",
            r"\q is not an escape",
            r"trailing backslash \",
            r"\u00zz is not a code point",
        ] {
            assert_eq!(scrubber.scrub(text.to_owned()), text, "mangled {text:?}");
        }
    }

    #[test]
    fn an_ordinary_chunk_with_no_escapes_is_released_whole() {
        // The latency property: hold-back is for credentials, not for punctuation.
        let scrubber = Scrubber::new(vec![CANARY.to_owned()]);
        let chunk = br#"data: {"choices":[{"delta":{"content":"hello there"}}]}"#;
        assert_eq!(scrubber.hold_back_len(chunk), 0);
        assert_eq!(scrubber.scrub_bytes(chunk.to_vec()), chunk.to_vec());
    }

    #[test]
    fn a_url_with_no_credential_renders_verbatim() {
        let url = RequestUrl::new("http://127.0.0.1:11434/v1/models");
        assert!(!url.carries_credential());
        assert_eq!(url.to_string(), "http://127.0.0.1:11434/v1/models");
        assert!(url.scrubber().is_empty());
    }
}
