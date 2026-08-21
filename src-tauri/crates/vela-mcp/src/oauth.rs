//! The OAuth token a remote MCP server is presented with, and how it is kept
//! current.
//!
//! ## Where the token lives
//!
//! In the **OS credential store**, under `mcp:<server id>/token`, reached
//! through `vela_secrets::SecretStore` — on Windows that is Credential Manager.
//! Not in "mcp-servers.json", not in a sidecar file, not in an environment
//! variable, and not in a URL. `config::validate_headers` and
//! `config::validate_remote_url` refuse the three ways a user might try to put
//! one somewhere else.
//!
//! One entry per server holds all three parts — access token, refresh token and
//! expiry — because they rotate together. Storing the refresh token separately
//! would make a torn write possible: a new access token beside a refresh token
//! that has already been spent is a state OAuth 2.1's rotation requirement makes
//! unrecoverable without a fresh authorization.
//!
//! ## WHAT IS BUILT, AND WHAT IS NOT
//!
//! **Built:** reading the stored token set, deciding whether it is still good,
//! exchanging a refresh token for a new one against the configured token
//! endpoint, rotating the stored set, and presenting the access token as an
//! `Authorization: Bearer` header. That is the part that runs on every request
//! and the part a compromised server interacts with.
//!
//! **Not built: the interactive authorization-code leg.** There is no browser
//! launch, no PKCE challenge, no loopback redirect listener and no
//! authorization-code grant here. The initial token set has to be provisioned
//! out of band — written to `mcp:<id>/token` through `secrets_set`. It is
//! written here rather than left for a reader to infer from a missing function,
//! because a reader who assumes Vela can sign a user in will be wrong. Wiring it
//! would mean an IPC command, a renderer surface to open a URL with, and a
//! cryptographic dependency this crate does not have; none of those could have
//! been driven in this slice, and shipping an untested authorization flow is
//! worse than shipping none.
//!
//! ## The refresh token never reaches a URL
//!
//! [`refresh_call`] puts every parameter in a form-encoded **body**. A query
//! string reaches the authorization server's access log, every proxy on the
//! path, and the `Referer` header of anything the response links to.
//! `tests::a_refresh_puts_nothing_in_the_url` is the guard.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use vela_core::secret::SecretValue;
use vela_secrets::{SecretError, SecretStore};
use zeroize::Zeroize;

use crate::config::{credential_ref, OAuthConfig};
use crate::error::{McpError, McpResult};
use crate::exchange::HttpCall;

/// How long before its stated expiry a token is treated as spent.
///
/// A token that expires while a request is in flight fails that request, and
/// the caller sees a `401` rather than an answer. Sixty seconds is a margin, not
/// a measurement: it is chosen to be larger than any plausible round trip to a
/// token endpoint plus the request that follows it.
pub const EXPIRY_SKEW: Duration = Duration::from_secs(60);

/// The scheme this client presents a token under. MCP's HTTP transport says
/// `Authorization: Bearer <token>`, and a server that wanted another scheme
/// would need a different code path, not a configurable string.
pub const BEARER_SCHEME: &str = "Bearer";

/// One server's stored token material.
///
/// `Debug` is derived and that is safe: every credential field is a
/// [`SecretValue`], which redacts itself. `expires_at` is metadata.
#[derive(Debug, Clone)]
pub struct TokenSet {
    access: SecretValue,
    refresh: Option<SecretValue>,
    /// Unix seconds. `None` means the issuer stated no expiry, which is a token
    /// that is used until it is refused — not one that is refreshed on a guess.
    expires_at: Option<u64>,
}

impl TokenSet {
    pub fn new(access: SecretValue, refresh: Option<SecretValue>, expires_at: Option<u64>) -> Self {
        Self {
            access,
            refresh,
            expires_at,
        }
    }

    /// The `Authorization` header value. Built through [`SecretValue::map`] so
    /// `"Bearer …"` never exists as a printable `String` at a call site.
    pub fn authorization(&self) -> SecretValue {
        self.access.map(|token| format!("{BEARER_SCHEME} {token}"))
    }

    pub fn refresh_token(&self) -> Option<&SecretValue> {
        self.refresh.as_ref()
    }

    /// Whether this token should be renewed before it is used.
    ///
    /// `now` is passed in rather than read, so the decision is a function and
    /// not a clock reading. [`now_unix`] is what production supplies.
    pub fn is_stale(&self, now: u64) -> bool {
        match self.expires_at {
            None => false,
            Some(at) => now.saturating_add(EXPIRY_SKEW.as_secs()) >= at,
        }
    }

    /// Restore from what the credential store holds.
    ///
    /// Two accepted shapes, and the second one is deliberate. A JSON object is
    /// what [`TokenSet::to_secret`] writes. **Anything else is taken as a bare
    /// access token** with no refresh token and no stated expiry — which is
    /// exactly what a user has after pasting a token into the settings surface,
    /// and it works until the server refuses it. Rejecting that shape would
    /// leave a user with a valid token and an unusable server.
    pub fn parse(stored: &SecretValue) -> Self {
        Self::parse_scrubbing(stored).0
    }

    /// [`TokenSet::parse`], handing back the intermediate document once it has
    /// been scrubbed.
    ///
    /// # Why the sibling exists
    ///
    /// A zeroized buffer that has already been dropped cannot be looked at.
    /// `parse` scrubs a local [`Value`] and drops it, so "it is scrubbed" was a
    /// claim no test could turn into an assertion — and before the three tests
    /// this shape exists for, deleting all three production `scrub` calls left
    /// the crate green. It is still true that nothing else catches that
    /// deletion: the measurement on the tree as committed is that removing the
    /// three calls fails exactly the three tests below, and no others. Handing
    /// the document back is what makes the call site itself testable.
    ///
    /// The production path is unchanged: `parse` takes the [`TokenSet`] and
    /// drops the returned [`Value`], whose strings are already empty. The
    /// reader of the returned document is
    /// `parse_scrubs_the_document_it_read_the_credential_out_of`, in this
    /// module's tests, and nothing else.
    fn parse_scrubbing(stored: &SecretValue) -> (Self, Value) {
        let Ok(mut document) = serde_json::from_str::<Value>(stored.expose()) else {
            return (Self::new(stored.clone(), None, None), Value::Null);
        };
        let parsed = match document.as_object() {
            None => Self::new(stored.clone(), None, None),
            Some(object) => {
                let string = |key: &str| {
                    object
                        .get(key)
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .map(SecretValue::new)
                };
                Self {
                    access: string("accessToken").unwrap_or_else(|| stored.clone()),
                    refresh: string("refreshToken"),
                    expires_at: object.get("expiresAt").and_then(Value::as_u64),
                }
            }
        };
        // The parsed document holds its own plain-text copy of both tokens,
        // whichever branch was taken. See [`scrub`].
        scrub(&mut document);
        (parsed, document)
    }

    /// The value to hand the credential store.
    ///
    /// # Both intermediates are scrubbed, and there are two
    ///
    /// Serialising a credential allocates plain text twice, and a `String`
    /// dropped normally leaves its bytes in freed heap for the life of the
    /// process. [`SecretValue`] scrubs itself on drop; nothing else here does,
    /// so both are scrubbed by hand:
    ///
    /// 1. the `String` `to_string` builds, holding the whole object;
    /// 2. the [`Value`] `json!` builds *before* that, which holds a `String`
    ///    copy of each token in its own right.
    ///
    /// The second is the one an earlier version of this comment missed while
    /// calling this "the one place in the crate where the material exists
    /// outside a `SecretValue`". It was not one place and it is not one now.
    /// The claim made here is only about this function — **every plain-text copy
    /// it makes is scrubbed before it is dropped** — and [`scrub`] carries the
    /// ledger of all the others, including the two nothing scrubs.
    pub fn to_secret(&self) -> SecretValue {
        self.to_secret_scrubbing().0
    }

    /// [`TokenSet::to_secret`], handing back both intermediates once they have
    /// been scrubbed. See [`TokenSet::parse_scrubbing`] for why the sibling
    /// exists at all; the reader of the two returned values is
    /// `to_secret_scrubs_both_of_the_intermediates_it_serialises_through`, in
    /// this module's tests, and nothing else.
    ///
    /// The order matters and the test does not prove it: `SecretValue::new`
    /// copies the JSON *before* `json.zeroize()` empties it, so the returned
    /// [`SecretValue`] is the credential and the returned `String` is the
    /// emptied husk.
    fn to_secret_scrubbing(&self) -> (SecretValue, Value, String) {
        let mut document = serde_json::json!({
            "accessToken": self.access.expose(),
            "refreshToken": self.refresh.as_ref().map(SecretValue::expose),
            "expiresAt": self.expires_at,
        });
        let mut json = document.to_string();
        let value = SecretValue::new(json.as_str());
        json.zeroize();
        scrub(&mut document);
        (value, document, json)
    }
}

/// Zeroize every string a parsed JSON document holds, in place.
///
/// Called on any [`Value`] built from or holding credential material. A
/// `Value::String` owns an ordinary `String`: dropping the document frees those
/// bytes without clearing them, which is the same hazard
/// [`SecretValue::drop`](SecretValue) exists to close for the wrapped case.
///
/// Keys are left alone deliberately — they are `accessToken`, `access_token`,
/// `expiresAt`: the schema, not the secret. `serde_json::Map` does not hand out
/// `&mut` keys anyway.
///
/// # The ledger: every plain-text copy of a token this crate makes
///
/// Counted **eight**: six scrubbed and two that are not. The number counts
/// *copies*, not bullets — the version of this ledger before this one said
/// "six", and it reached six by counting its own bullets. That folded the two
/// copies [`TokenSet::to_secret`] makes into one entry and left the
/// `Authorization` header out altogether. Counting a list against itself is how
/// this comment has now been wrong twice; the count below is against the crate.
///
/// How the eight were counted, written out so the next reader redoes the count
/// instead of trusting it. **Four** come from `grep -rn '\.expose()' src/ |
/// grep -v '///'`, discarding the hits below each file's `mod tests`. Both
/// filters are load-bearing and the version of this recipe before this one had
/// neither: without the second grep the search also returns this very
/// paragraph, which writes `.expose()` as prose rather than calling it, so the
/// recipe printed six lines while the ledger beneath it said four; and it is
/// *each* file's `mod tests`, not this file's, because `exchange.rs` has one
/// too. Those four are every point
/// where material leaves a [`SecretValue`] into something that is not one —
/// `with_credential_header`, `with_form_body`, the point where
/// [`TokenSet::parse`] deserialises the stored credential, and the `json!` in
/// [`TokenSet::to_secret`]. **Four more are invisible to that
/// grep** and have to be added by reading, because their material either never
/// sat in a [`SecretValue`] or was copied out of something the grep already
/// found:
///
/// * [`TokenSet::to_secret`]'s `to_string`, a second allocation off the `json!`
///   document — the copy the previous "six" folded into its neighbour's bullet;
/// * the `String` `form_encode` builds inside the closure `SecretValue::map`
///   runs for [`refresh_call`];
/// * [`parse_token_response`]'s document, parsed from the bytes off the wire;
/// * `renew`'s `reply.body`, the `Vec<u8>` those bytes arrive in.
///
/// Two things that look like copies and are not: [`TokenSet::authorization`] and
/// the `format!` inside [`refresh_call`] both hand their `String` straight to
/// `SecretValue::map`, which takes ownership, so the material is inside a
/// self-scrubbing wrapper from the moment it exists. Neither is a `.expose()`
/// hit either, which is why the grep does not raise them and why the grep alone
/// is not the count.
///
/// **Scrubbed — six copies at five sites:**
///
/// * [`TokenSet::to_secret`] — the `json!` [`Value`] (`scrub`) **and** the
///   `String` from `to_string` (`String::zeroize`). Two copies, one site.
/// * [`TokenSet::parse`] — the [`Value`] parsed out of the stored credential.
/// * [`parse_token_response`] — the [`Value`] parsed out of the token
///   endpoint's answer, on all five ways out.
/// * [`refresh_call`] — the `String` `form_encode` returns, holding the refresh
///   token percent-encoded.
/// * `crate::http::HttpTransport::renew` — the token endpoint's response body,
///   the only response body in this crate that is credential material.
///
/// **NOT scrubbed, and known — two copies, both fields of one [`HttpCall`]:**
///
/// * `HttpCall::headers` — the `String` `HttpCall::with_credential_header`
///   pushes, holding `Bearer ` and the whole access token. Minted by
///   `crate::http::HttpTransport::request_call` on every request that carries a
///   credential — not on every request: the header is attached under an `if let
///   Some(..)`, so an entry with no stored token makes no copy — and again by
///   `crate::http::HttpTransport::shutdown` for the session `DELETE`, which is
///   conditional in the same way and for a second reason: shutdown attaches a
///   credential only if one is still readable, and gives up rather than
///   demanding one. Those two are its only production callers. This is the entry the previous ledger
///   omitted while calling itself the complete list, which made the omission the
///   one thing the comment existed to prevent.
/// * `HttpCall::body` — the `Vec<u8>` `HttpCall::with_form_body` pushes, holding
///   the form-encoded refresh token. [`refresh_call`] is its only production
///   caller.
///
/// One reason covers both, which is why the argument is written once:
/// `vela_app::mcp_http::ProviderBackedExchange::send` moves `headers:
/// call.headers` and `body: call.body` out of the call by field, so `HttpCall`
/// cannot be given a `Drop` without both of those becoming partial-move errors.
/// From there they are the HTTP client's buffers and outside this crate
/// entirely. Closing either means changing the seam, not adding a call here.
///
/// This is hygiene and not a boundary in any case. It shortens how long plain
/// text sits in freed heap; it does nothing about a copy the allocator or the
/// OS made while the value was alive, and it is not a defence against a process
/// that can read this process's memory.
pub(crate) fn scrub(document: &mut Value) {
    match document {
        Value::String(text) => text.zeroize(),
        Value::Array(items) => items.iter_mut().for_each(scrub),
        Value::Object(fields) => fields.iter_mut().for_each(|(_, value)| scrub(value)),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

/// Wall-clock seconds since the epoch. The only clock reading in this module.
pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0)
}

/// Read the stored token set for one server, if there is one.
///
/// A missing credential is `Ok(None)`, not an error: a server the user has not
/// signed into yet is an ordinary state, and the caller turns it into
/// [`McpError::AuthorizationRequired`] with a sentence about that server.
pub fn load(store: &dyn SecretStore, server_id: &str) -> McpResult<Option<TokenSet>> {
    let reference = credential_ref(server_id)?;
    match store.get(&reference) {
        Ok(value) => Ok(Some(TokenSet::parse(&value))),
        Err(SecretError::NotFound { .. }) => Ok(None),
        Err(error) => Err(McpError::AuthorizationRequired {
            server: server_id.to_owned(),
            detail: error.to_string(),
        }),
    }
}

/// Replace the stored token set for one server.
pub fn save(store: &dyn SecretStore, server_id: &str, tokens: &TokenSet) -> McpResult<()> {
    let reference = credential_ref(server_id)?;
    store
        .set(&reference, &tokens.to_secret())
        .map_err(|error| McpError::AuthorizationRequired {
            server: server_id.to_owned(),
            detail: error.to_string(),
        })
}

/// The request that trades a refresh token for a new token set.
///
/// Everything is in the body. See the module docs.
pub fn refresh_call(config: &OAuthConfig, refresh_token: &SecretValue) -> HttpCall {
    let scope = if config.scopes.is_empty() {
        String::new()
    } else {
        format!("&scope={}", form_encode(&config.scopes.join(" ")))
    };
    let client_id = form_encode(&config.client_id);
    let body = refresh_token.map(|token| {
        // `form_encode` returns an ordinary `String` holding the refresh token
        // percent-encoded — a plain-text copy that `SecretValue::map` does not
        // know about, because it only owns what the closure returns. Zeroized
        // here for the reason `TokenSet::to_secret` zeroizes its own.
        let mut encoded = form_encode(token);
        let line = format!(
            "grant_type=refresh_token&refresh_token={encoded}&client_id={client_id}{scope}"
        );
        encoded.zeroize();
        line
    });
    HttpCall::post(&config.token_endpoint)
        .with_header("accept", "application/json")
        .with_form_body(&body)
}

/// Read a token endpoint's answer.
///
/// `previous_refresh` is carried forward when the response omits one. OAuth 2.1
/// requires a public client's refresh token to rotate, so a response that
/// carries a new one replaces the old; a server that does not rotate leaves the
/// old one usable, and discarding it would sign the user out on the first
/// refresh.
///
/// The split with [`read_token_document`] is not decomposition for its own sake:
/// the read leaves by four early refusals and one success, and
/// [`parse_token_response_scrubbing`] beneath this is what scrubs the parsed
/// document down all five without that having to be remembered at each one. See
/// [`scrub`].
pub fn parse_token_response(
    server_id: &str,
    body: &[u8],
    now: u64,
    previous_refresh: Option<&SecretValue>,
) -> McpResult<TokenSet> {
    parse_token_response_scrubbing(server_id, body, now, previous_refresh).0
}

/// [`parse_token_response`], handing back the parsed document once it has been
/// scrubbed. See [`TokenSet::parse_scrubbing`] for why the sibling exists; the
/// reader of the returned document is
/// `a_refused_token_response_is_scrubbed_on_the_way_out_as_well_as_a_good_one`,
/// in this module's tests, and nothing else.
///
/// A body that is not JSON never becomes a document, so that path returns
/// a null `Value` — there is nothing holding a token to scrub.
fn parse_token_response_scrubbing(
    server_id: &str,
    body: &[u8],
    now: u64,
    previous_refresh: Option<&SecretValue>,
) -> (McpResult<TokenSet>, Value) {
    let mut document: Value = match serde_json::from_slice(body) {
        Ok(document) => document,
        Err(e) => {
            return (
                Err(McpError::AuthorizationRequired {
                    server: server_id.to_owned(),
                    detail: format!("the token endpoint did not answer with JSON: {e}"),
                }),
                Value::Null,
            )
        }
    };
    let outcome = read_token_document(server_id, &document, now, previous_refresh);
    scrub(&mut document);
    (outcome, document)
}

fn read_token_document(
    server_id: &str,
    document: &Value,
    now: u64,
    previous_refresh: Option<&SecretValue>,
) -> McpResult<TokenSet> {
    let refused = |detail: String| McpError::AuthorizationRequired {
        server: server_id.to_owned(),
        detail,
    };

    let object = document
        .as_object()
        .ok_or_else(|| refused("the token endpoint did not answer with an object".to_owned()))?;

    // An OAuth error response is a 400 with a machine-readable `error`. It is
    // read here rather than left to the status code because `invalid_grant` —
    // the refresh token is spent — is the one a user acts on, and it is only
    // ever in the body.
    if let Some(code) = object.get("error").and_then(Value::as_str) {
        return Err(refused(format!("the authorization server said `{code}`")));
    }

    let access = object
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| refused("the token response carried no access_token".to_owned()))?;

    // A token type this client would present wrongly is refused rather than
    // sent as a bearer token, which is how a `DPoP` token ends up in a header
    // that cannot carry it and the failure surfaces three layers away.
    if let Some(kind) = object.get("token_type").and_then(Value::as_str) {
        if !kind.eq_ignore_ascii_case("bearer") {
            return Err(refused(format!(
                "the authorization server issued a `{kind}` token; this client presents \
                 `{BEARER_SCHEME}` only"
            )));
        }
    }

    let expires_at = object
        .get("expires_in")
        .and_then(Value::as_u64)
        .map(|seconds| now.saturating_add(seconds));

    let refresh = object
        .get("refresh_token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(SecretValue::new)
        .or_else(|| previous_refresh.cloned());

    Ok(TokenSet::new(SecretValue::new(access), refresh, expires_at))
}

/// `application/x-www-form-urlencoded`, the whole of it.
///
/// Hand-written for the same reason `config::split_url` is: the rule is small
/// and total — unreserved characters pass, a space becomes `+`, everything else
/// becomes `%XX` — and it is applied to credential material, where "close
/// enough" means a token that arrives corrupted and a failure that looks like a
/// revoked grant.
fn form_encode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for byte in raw.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use vela_core::secret::REDACTED;
    use vela_secrets::MemoryStore;

    const ACCESS: &str = "at-canary-9f2b7c41-DO-NOT-LOG";
    const REFRESH: &str = "rt-canary-1a2b3c4d-DO-NOT-LOG";

    fn config() -> OAuthConfig {
        OAuthConfig {
            client_id: "vela desktop".to_owned(),
            token_endpoint: "https://auth.example.com/oauth/token".to_owned(),
            scopes: vec!["mcp:tools".to_owned(), "profile".to_owned()],
        }
    }

    #[test]
    fn scrubbing_a_parsed_document_leaves_no_token_anywhere_in_it() {
        // `scrub` is called from three places that parse or build credential
        // material into a `Value` — `TokenSet::parse`, `TokenSet::to_secret` and
        // `parse_token_response`. What it has to be is total over the shapes a
        // token endpoint can nest one in, so it is asserted over a nested one
        // rather than the flat object those three actually pass.
        let mut document = serde_json::json!({
            "access_token": ACCESS,
            "extra": { "refresh_token": REFRESH, "keep": 7 },
            "list": [ACCESS, REFRESH],
            "nothing": null,
            "flag": true,
        });
        scrub(&mut document);

        let printed = document.to_string();
        assert!(!printed.contains(ACCESS), "{printed}");
        assert!(!printed.contains(REFRESH), "{printed}");
        // Structure and non-string data survive: this scrubs, it does not empty.
        assert_eq!(document["extra"]["keep"], serde_json::json!(7));
        assert_eq!(document["flag"], serde_json::json!(true));
        assert!(document["list"].is_array());
        // And the keys, which are the schema rather than the secret.
        assert!(printed.contains("access_token"), "{printed}");
    }

    // -----------------------------------------------------------------
    // The three production `scrub` call sites, each pinned by name
    // -----------------------------------------------------------------
    //
    // The test above proves `scrub` scrubs. It does not prove anybody calls it,
    // and that gap was measured rather than suspected: deleting all three
    // production `scrub(&mut document)` calls used to leave the whole crate
    // green, so five of the ledger's six scrubbed copies could regress in
    // silence. On the tree as committed the same deletion fails exactly these
    // three and nothing else — one test per call site, and still nothing else
    // watching. Each reads the document the function scrubbed rather than the
    // one it dropped; see `TokenSet::parse_scrubbing` for why it has to be
    // handed back at all.

    #[test]
    fn parse_scrubs_the_document_it_read_the_credential_out_of() {
        let stored = SecretValue::new(
            serde_json::json!({ "accessToken": ACCESS, "refreshToken": REFRESH }).to_string(),
        );
        let (tokens, document) = TokenSet::parse_scrubbing(&stored);

        // The credential really was read: this is not an empty document that
        // was empty all along.
        assert_eq!(tokens.authorization().expose(), format!("Bearer {ACCESS}"));
        assert_eq!(tokens.refresh_token().unwrap().expose(), REFRESH);

        let printed = document.to_string();
        assert!(
            !printed.contains(ACCESS),
            "the parsed document kept the access token: {printed}"
        );
        assert!(
            !printed.contains(REFRESH),
            "the parsed document kept the refresh token: {printed}"
        );
        // The keys survive, so the document is scrubbed and not replaced.
        assert!(printed.contains("accessToken"), "{printed}");
    }

    #[test]
    fn to_secret_scrubs_both_of_the_intermediates_it_serialises_through() {
        let tokens = TokenSet::new(
            SecretValue::new(ACCESS),
            Some(SecretValue::new(REFRESH)),
            Some(4_000_000_000),
        );
        let (secret, document, json) = tokens.to_secret_scrubbing();

        // The returned credential is the real one, so the two intermediates
        // below were carrying the material when they were scrubbed.
        assert!(
            secret.expose().contains(ACCESS),
            "the stored value lost the token"
        );

        let printed = document.to_string();
        assert!(
            !printed.contains(ACCESS),
            "the `json!` document kept the access token: {printed}"
        );
        assert!(
            !printed.contains(REFRESH),
            "the `json!` document kept the refresh token: {printed}"
        );
        assert!(
            !json.contains(ACCESS),
            "the serialised `String` kept the access token: {json}"
        );
        assert!(
            !json.contains(REFRESH),
            "the serialised `String` kept the refresh token: {json}"
        );
    }

    #[test]
    fn a_refused_token_response_is_scrubbed_on_the_way_out_as_well_as_a_good_one() {
        // Both directions through `read_token_document`, because the refusal
        // paths are the ones a `?` would have carried past the scrub.
        let good = serde_json::json!({
            "access_token": ACCESS, "refresh_token": REFRESH, "token_type": "Bearer",
        })
        .to_string();
        let (outcome, document) = parse_token_response_scrubbing("team", good.as_bytes(), 0, None);
        assert!(outcome.is_ok(), "{outcome:?}");
        let printed = document.to_string();
        assert!(!printed.contains(ACCESS), "{printed}");
        assert!(!printed.contains(REFRESH), "{printed}");

        // A non-Bearer `token_type` is one of the four refusals, and it refuses
        // *after* the tokens have been read into the document.
        let refused = serde_json::json!({
            "access_token": ACCESS, "refresh_token": REFRESH, "token_type": "mac",
        })
        .to_string();
        let (outcome, document) =
            parse_token_response_scrubbing("team", refused.as_bytes(), 0, None);
        assert!(outcome.is_err(), "a non-Bearer token_type must be refused");
        let printed = document.to_string();
        assert!(
            !printed.contains(ACCESS),
            "a refused response kept the access token: {printed}"
        );
        assert!(
            !printed.contains(REFRESH),
            "a refused response kept the refresh token: {printed}"
        );
    }

    #[test]
    fn a_refresh_puts_nothing_in_the_url() {
        // THE RULE. A token in a query string is a finding.
        let call = refresh_call(&config(), &SecretValue::new(REFRESH));
        assert_eq!(call.url, "https://auth.example.com/oauth/token");
        assert!(!call.url.contains('?'), "{}", call.url);
        assert!(!call.url.contains(REFRESH), "{}", call.url);

        let body = String::from_utf8(call.body.clone().unwrap()).unwrap();
        assert!(body.contains(&format!("refresh_token={REFRESH}")), "{body}");
        assert!(body.contains("grant_type=refresh_token"), "{body}");
        // A space in a client id or a colon in a scope has to survive.
        assert!(body.contains("client_id=vela+desktop"), "{body}");
        assert!(body.contains("scope=mcp%3Atools+profile"), "{body}");
        assert_eq!(
            call.header("content-type"),
            Some("application/x-www-form-urlencoded")
        );

        let printed = format!("{call:?}");
        assert!(!printed.contains(REFRESH), "{printed}");
    }

    #[test]
    fn an_empty_scope_list_sends_no_scope_at_all() {
        // Sending `scope=` is not the same as sending nothing: some servers read
        // it as "no scopes" and downgrade the grant.
        let mut config = config();
        config.scopes.clear();
        let call = refresh_call(&config, &SecretValue::new(REFRESH));
        let body = String::from_utf8(call.body.unwrap()).unwrap();
        assert!(!body.contains("scope"), "{body}");
    }

    #[test]
    fn a_rotated_refresh_token_replaces_the_old_one_and_an_absent_one_does_not() {
        let previous = SecretValue::new(REFRESH);

        let rotated = parse_token_response(
            "s",
            br#"{"access_token":"new-at","refresh_token":"new-rt","expires_in":3600}"#,
            1_000,
            Some(&previous),
        )
        .unwrap();
        assert_eq!(rotated.refresh_token().unwrap().expose(), "new-rt");
        assert_eq!(rotated.expires_at, Some(4_600));

        let unrotated = parse_token_response(
            "s",
            br#"{"access_token":"new-at","expires_in":3600}"#,
            1_000,
            Some(&previous),
        )
        .unwrap();
        assert_eq!(
            unrotated.refresh_token().unwrap().expose(),
            REFRESH,
            "discarding a refresh token the server did not rotate signs the user out"
        );
    }

    #[test]
    fn an_oauth_error_body_is_reported_by_its_machine_readable_code() {
        let error = parse_token_response(
            "team",
            br#"{"error":"invalid_grant","error_description":"expired"}"#,
            0,
            None,
        )
        .expect_err("an error body is not a token");
        assert!(
            matches!(&error, McpError::AuthorizationRequired { server, detail }
                if server == "team" && detail.contains("invalid_grant")),
            "got {error:?}"
        );
    }

    #[test]
    fn a_token_type_this_client_cannot_present_is_refused_rather_than_sent() {
        let error =
            parse_token_response("s", br#"{"access_token":"a","token_type":"DPoP"}"#, 0, None)
                .expect_err("a DPoP token must not be sent as a bearer token");
        assert!(
            matches!(&error, McpError::AuthorizationRequired { detail, .. }
                if detail.contains("DPoP")),
            "got {error:?}"
        );

        // The ordinary spelling, in whatever case the server chose, is fine.
        for spelling in ["Bearer", "bearer", "BEARER"] {
            let body = format!(r#"{{"access_token":"a","token_type":"{spelling}"}}"#);
            assert!(parse_token_response("s", body.as_bytes(), 0, None).is_ok());
        }
    }

    #[test]
    fn a_response_without_an_access_token_is_not_a_token_set() {
        for body in [
            &br#"{"expires_in":3600}"#[..],
            &br#"{"access_token":""}"#[..],
            &br#"[]"#[..],
            &b"not json"[..],
        ] {
            assert!(
                parse_token_response("s", body, 0, None).is_err(),
                "{}",
                String::from_utf8_lossy(body)
            );
        }
    }

    #[test]
    fn staleness_is_decided_against_a_given_clock_with_a_margin() {
        let expiring = TokenSet::new(SecretValue::new(ACCESS), None, Some(1_000));
        assert!(!expiring.is_stale(1_000 - EXPIRY_SKEW.as_secs() - 1));
        assert!(expiring.is_stale(1_000 - EXPIRY_SKEW.as_secs()));
        assert!(expiring.is_stale(2_000));

        // A token the issuer put no expiry on is used until it is refused.
        let forever = TokenSet::new(SecretValue::new(ACCESS), None, None);
        assert!(!forever.is_stale(u64::MAX));
    }

    #[test]
    fn a_token_set_round_trips_through_the_credential_store() {
        // VERIFIED-BY-FAKE: `MemoryStore`, not a real Credential Manager.
        let store = MemoryStore::new();
        let tokens = TokenSet::new(
            SecretValue::new(ACCESS),
            Some(SecretValue::new(REFRESH)),
            Some(4_600),
        );
        assert!(load(&store, "team").unwrap().is_none());

        save(&store, "team", &tokens).unwrap();
        let read = load(&store, "team").unwrap().expect("stored");
        assert_eq!(read.authorization().expose(), format!("Bearer {ACCESS}"));
        assert_eq!(read.refresh_token().unwrap().expose(), REFRESH);
        assert!(read.is_stale(4_600));
        assert!(!read.is_stale(1_000));

        // And it went in under the namespaced reference, not the provider one.
        assert!(store.contains(&credential_ref("team").unwrap()));
    }

    #[test]
    fn a_bare_token_pasted_by_a_user_is_usable_rather_than_rejected() {
        let parsed = TokenSet::parse(&SecretValue::new(ACCESS));
        assert_eq!(parsed.authorization().expose(), format!("Bearer {ACCESS}"));
        assert!(parsed.refresh_token().is_none());
        assert!(!parsed.is_stale(u64::MAX));
    }

    #[test]
    fn nothing_in_this_module_prints_a_token() {
        let tokens = TokenSet::new(
            SecretValue::new(ACCESS),
            Some(SecretValue::new(REFRESH)),
            Some(4_600),
        );
        let printed = format!(
            "{tokens:?} {} {}",
            tokens.authorization(),
            tokens.to_secret()
        );
        assert!(!printed.contains(ACCESS), "{printed}");
        assert!(!printed.contains(REFRESH), "{printed}");
        assert!(printed.contains(REDACTED), "{printed}");
        // The metadata is not a secret and is worth having in a diagnostic.
        assert!(printed.contains("4600"), "{printed}");
    }

    #[test]
    fn form_encoding_is_total_over_the_bytes_a_token_can_hold() {
        assert_eq!(form_encode("abc-_.~09"), "abc-_.~09");
        assert_eq!(form_encode("a b"), "a+b");
        assert_eq!(form_encode("a&b=c"), "a%26b%3Dc");
        assert_eq!(form_encode("+"), "%2B");
        assert_eq!(form_encode("é"), "%C3%A9");
    }
}
