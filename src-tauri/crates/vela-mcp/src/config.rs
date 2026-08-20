//! The JSON file that says which servers exist.
//!
//! ## Shape, and why it is somebody else's shape
//!
//! ```ignore
//! {
//!   "mcpServers": {
//!     "files": {
//!       "command": "node",
//!       "args": ["C:/tools/fs-server.mjs"],
//!       "env": { "ROOT": "C:/work" },
//!       "cwd": "C:/work",
//!       "enabled": true
//!     },
//!     "team": {
//!       "url": "https://mcp.example.com/mcp",
//!       "headers": { "X-Tenant": "acme" },
//!       "auth": {
//!         "type": "oauth",
//!         "clientId": "vela-desktop",
//!         "tokenEndpoint": "https://auth.example.com/oauth/token",
//!         "scopes": ["mcp:tools"]
//!       }
//!     }
//!   }
//! }
//! ```
//!
//! This is the layout every other MCP client already uses, and copying it is
//! worth more than improving it: a user who has a working server has a working
//! entry for it somewhere on disk, and the whole value of the feature is that
//! they can paste it in. An id-keyed map rather than an array for the same
//! reason — that is what the entries they will paste are wrapped in.
//!
//! ## One bad entry may not take the others down
//!
//! Parsing produces a [`McpConfig`] whose entries are each `Result`. A file
//! naming four servers, one of which is malformed, yields three usable ones and
//! one that reports why — the same rule the MCP spec states for a tool whose
//! schema is invalid ("the client MUST exclude the invalid tool", not the
//! server). A whole-file failure is reserved for a file that is not JSON at all,
//! because then there is nothing left to be partially right.
//!
//! ## NO CREDENTIAL IS EVER READ OUT OF THIS FILE
//!
//! This is the security rule of the module, and it is enforced rather than
//! narrated.
//!
//! * `auth` names **which** credential to use and where to renew it. It has no
//!   field that can hold a token, and there is no arm of [`RemoteAuth`] that
//!   carries one. The material itself lives in the OS credential store, reached
//!   through `vela_secrets::SecretStore`, under the reference
//!   [`credential_ref`] builds.
//! * `headers` is refused outright if it names a header that carries credential
//!   material by convention — see [`FORBIDDEN_HEADERS`]. A user who pastes
//!   `"Authorization": "Bearer sk-…"` gets [`McpError::ConfigInvalid`] telling
//!   them where it belongs, rather than a working server and a token sitting in
//!   a JSON file that every process running as them can read.
//! * `url` is refused if it carries userinfo (`https://user:pass@host`) or a
//!   query parameter whose name is a credential by convention. **An OAuth token
//!   in a query string is a finding, not a shortcut** — it lands in proxy logs,
//!   in server access logs and in `Referer` headers.
//! * `url` is refused if it is plaintext `http://` to anywhere but loopback.
//!   Every request this transport makes carries an `Authorization` header once
//!   auth is configured, and a plaintext hop hands it to the network.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;
use vela_core::secret::{SecretField, SecretRef};

use crate::error::{McpError, McpResult};

/// Environment variables a spawned server inherits when the entry does not name
/// its own.
///
/// **The child does not get the parent's environment.** A desktop app's
/// environment holds whatever the user's shell put there, and an MCP server is
/// third-party code the user pasted a command line for; handing it the whole set
/// is how a token exported for something else ends up in a subprocess nobody
/// audited. What is left is the set a program needs to *run* on Windows — the
/// loader's search paths and the temp directory — plus `PATH`, without which
/// `node` and `npx` are not findable at all.
///
/// Names are matched case-insensitively, because Windows environment variables
/// are.
pub const INHERITED_ENV: &[&str] = &[
    "APPDATA",
    "COMSPEC",
    "HOME",
    "LOCALAPPDATA",
    "PATH",
    "PATHEXT",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR",
];

/// Header names a configuration file may not set, and why each is on the list.
///
/// The first group carries credential material by convention. Vela's answer to
/// "where does the token go" is the OS credential store and nowhere else, and a
/// config file that could set `Authorization` would be a second answer.
///
/// The second group is the transport's own framing. A file that could pin
/// `Mcp-Session-Id` could bind this client to a session it did not open, and one
/// that could rewrite `Accept` could make a server's streaming reply undecodable
/// by the code that is about to read it.
///
/// Read by [`validate_headers`], which is called from [`resolve`].
pub const FORBIDDEN_HEADERS: &[&str] = &[
    // credential material
    "authorization",
    "proxy-authorization",
    "x-api-key",
    "api-key",
    "x-goog-api-key",
    "cookie",
    // this transport's own framing
    "accept",
    "content-type",
    "content-length",
    "mcp-session-id",
    "mcp-protocol-version",
];

/// Query-parameter names that mean a credential is in the URL. Read by
/// [`validate_remote_url`].
///
/// The list is the *convention*, not an exhaustive grammar: a server that names
/// its token parameter `q` will not be caught, and cannot be. What it does catch
/// is the shortcut a user reaches for when OAuth looks like work, which is the
/// case worth refusing.
pub const CREDENTIAL_QUERY_PARAMS: &[&str] = &[
    "access_token",
    "accesstoken",
    "api_key",
    "apikey",
    "auth",
    "authorization",
    "key",
    "password",
    "secret",
    "token",
];

/// A launchable stdio server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StdioServer {
    pub command: String,
    pub args: Vec<String>,
    /// Extra variables, on top of [`INHERITED_ENV`]. These win on a collision:
    /// an entry that sets `PATH` means it.
    pub env: BTreeMap<String, String>,
    pub cwd: Option<PathBuf>,
}

/// A reachable remote server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpServer {
    /// The MCP endpoint, verbatim. Read by `crate::http::HttpTransport::request`
    /// as the POST target and by `HttpTransport::shutdown` as the DELETE target.
    pub url: String,
    /// Extra headers on every outbound request. Read by
    /// `crate::http::HttpTransport::headers_for`. Names are lowercased here so
    /// the transport's own headers can be merged without duplicating one under
    /// a different case.
    pub headers: BTreeMap<String, String>,
    /// Which credential to present, and how to renew it. Read by
    /// `crate::http::HttpTransport::authorization`.
    pub auth: RemoteAuth,
}

/// How a remote server is authenticated. **No arm carries a secret.**
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteAuth {
    /// Send no credential. Not an empty `Authorization` header — see
    /// `vela_secrets::resolve_auth` for why that distinction is load-bearing.
    None,
    /// A long-lived token the user provisioned, stored under
    /// [`credential_ref`]. Read, never written, by this crate: the write is
    /// `secrets_set` from the settings surface.
    Bearer,
    /// An OAuth 2 token set that this client keeps current.
    OAuth(OAuthConfig),
}

/// What renewing an OAuth token takes. Every field has a reader in
/// `crate::oauth`; see each one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OAuthConfig {
    /// Sent as `client_id` in the refresh request body. Read by
    /// `crate::oauth::refresh_request`.
    pub client_id: String,
    /// Where the refresh is POSTed. Read by `crate::oauth::refresh_request`.
    pub token_endpoint: String,
    /// Sent as a space-joined `scope` when non-empty, which is how a refresh
    /// asks for the grant it already had rather than whatever the server
    /// defaults to. Read by `crate::oauth::refresh_request`.
    pub scopes: Vec<String>,
}

/// What a configured id resolves to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerSpec {
    Stdio(StdioServer),
    Http(HttpServer),
}

/// The credential-store field holding a remote server's token material.
///
/// `Bearer` stores the token itself here. `OAuth` stores a small JSON object —
/// access token, refresh token, expiry — under the same reference, because the
/// three are one credential that has to rotate together. See `crate::oauth`.
pub const TOKEN_FIELD: &str = "token";

/// The credential-store reference for one MCP server.
///
/// The `mcp:` prefix keeps the id space of MCP servers from colliding with the
/// id space of model providers, which share the store: a user with a provider
/// called `team` and an MCP server called `team` must not share one entry.
///
/// The resulting key is `mcp:<id>/token`. Changing this format orphans stored
/// credentials, so treat it as a storage migration.
pub fn credential_ref(server_id: &str) -> McpResult<SecretRef> {
    SecretRef::new(
        format!("mcp:{server_id}"),
        SecretField::Named(TOKEN_FIELD.to_owned()),
    )
    .map_err(|error| McpError::ConfigInvalid {
        server: server_id.to_owned(),
        detail: error.to_string(),
    })
}

/// One entry as it appeared in the file, before any judgement about whether it
/// can be launched or reached.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawEntry {
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    cwd: Option<String>,
    /// Absent means enabled. A user who has not said anything has not said no.
    enabled: Option<bool>,
    url: Option<String>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    /// Deliberately untyped here and parsed in [`resolve`]. A misspelled `type`
    /// has to fail *this entry*, and a typed field would fail the whole file —
    /// which is the rule this module exists to keep.
    auth: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum RawAuth {
    None,
    Bearer,
    /// Spelled out, because `rename_all = "camelCase"` turns `OAuth` into
    /// `oAuth` and nobody writes that. A test asserts the spelling a user types.
    #[serde(rename = "oauth", rename_all = "camelCase")]
    OAuth {
        client_id: String,
        token_endpoint: String,
        #[serde(default)]
        scopes: Vec<String>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawConfig {
    #[serde(default)]
    mcp_servers: BTreeMap<String, RawEntry>,
}

/// Every configured server id, each either usable or explained.
#[derive(Debug, Default)]
pub struct McpConfig {
    entries: BTreeMap<String, McpResult<ServerSpec>>,
}

impl McpConfig {
    /// Ids in a stable order. Sorted, so a settings list does not reshuffle
    /// itself between reads of the same file.
    pub fn ids(&self) -> impl Iterator<Item = &str> {
        self.entries.keys().map(String::as_str)
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// What one id resolves to, or why there is nothing.
    pub fn server(&self, id: &str) -> McpResult<&ServerSpec> {
        match self.entries.get(id) {
            None => Err(McpError::NotConfigured(id.to_owned())),
            Some(Ok(spec)) => Ok(spec),
            Some(Err(error)) => Err(clone_error(error)),
        }
    }

    /// Parse from text. The path is carried only so a read failure can name it.
    pub fn parse(source: &str) -> McpResult<Self> {
        let raw: RawConfig =
            serde_json::from_str(source).map_err(|e| McpError::ConfigUnreadable {
                path: "<memory>".to_owned(),
                detail: e.to_string(),
            })?;
        Ok(Self {
            entries: raw
                .mcp_servers
                .into_iter()
                .filter(|(_, entry)| entry.enabled.unwrap_or(true))
                .map(|(id, entry)| {
                    let resolved = resolve(&id, entry);
                    (id, resolved)
                })
                .collect(),
        })
    }

    /// Read from disk. **A missing file is an empty configuration, not an
    /// error**: no MCP servers configured is the state every user starts in, and
    /// a first launch that reported a failure would be reporting the ordinary
    /// case as a fault.
    pub fn read(path: &Path) -> McpResult<Self> {
        match std::fs::read_to_string(path) {
            Ok(source) => Self::parse(&source).map_err(|error| match error {
                McpError::ConfigUnreadable { detail, .. } => McpError::ConfigUnreadable {
                    path: path.display().to_string(),
                    detail,
                },
                other => other,
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(McpError::ConfigUnreadable {
                path: path.display().to_string(),
                detail: e.to_string(),
            }),
        }
    }
}

fn invalid(server: &str, detail: impl Into<String>) -> McpError {
    McpError::ConfigInvalid {
        server: server.to_owned(),
        detail: detail.into(),
    }
}

fn resolve(id: &str, entry: RawEntry) -> McpResult<ServerSpec> {
    // `command` first, and the order is deliberate: an entry carrying both is a
    // user who edited a stdio entry into a remote one and left the old key
    // behind. Preferring the launchable one keeps a server that used to work
    // working; refusing would turn a stale key into an outage.
    if let Some(command) = entry.command.as_deref() {
        if !command.trim().is_empty() {
            return Ok(ServerSpec::Stdio(StdioServer {
                command: command.to_owned(),
                args: entry.args,
                env: entry.env,
                cwd: entry.cwd.map(PathBuf::from),
            }));
        }
    }

    let Some(url) = entry.url.as_deref() else {
        return Err(invalid(id, "an entry needs a non-empty command or url"));
    };

    validate_remote_url(id, url)?;
    let headers = validate_headers(id, entry.headers)?;
    let auth = match entry.auth {
        None => RemoteAuth::None,
        Some(value) => match serde_json::from_value::<RawAuth>(value) {
            Ok(RawAuth::None) => RemoteAuth::None,
            Ok(RawAuth::Bearer) => RemoteAuth::Bearer,
            Ok(RawAuth::OAuth {
                client_id,
                token_endpoint,
                scopes,
            }) => {
                validate_remote_url(id, &token_endpoint)?;
                if client_id.trim().is_empty() {
                    return Err(invalid(id, "`auth.clientId` must not be empty"));
                }
                RemoteAuth::OAuth(OAuthConfig {
                    client_id,
                    token_endpoint,
                    scopes,
                })
            }
            Err(error) => return Err(invalid(id, format!("`auth` is not usable: {error}"))),
        },
    };

    Ok(ServerSpec::Http(HttpServer {
        url: url.to_owned(),
        headers,
        auth,
    }))
}

/// Lowercase the names, and refuse the ones that are not the file's to set.
fn validate_headers(
    id: &str,
    headers: BTreeMap<String, String>,
) -> McpResult<BTreeMap<String, String>> {
    let mut checked = BTreeMap::new();
    for (name, value) in headers {
        let lower = name.to_ascii_lowercase();
        if FORBIDDEN_HEADERS.contains(&lower.as_str()) {
            return Err(invalid(
                id,
                format!(
                    "`headers` may not set `{name}`: a credential belongs in the OS \
                     credential store (set `auth`), and this transport owns its own framing"
                ),
            ));
        }
        if value.contains(['\r', '\n']) {
            // Header splitting. The value reaches an HTTP client as text, and a
            // client that concatenates rather than validates would let a config
            // file inject a second header — or a whole second request.
            return Err(invalid(
                id,
                format!("`headers.{name}` contains a line break"),
            ));
        }
        checked.insert(lower, value);
    }
    Ok(checked)
}

/// The pieces of a URL this module needs in order to judge it.
///
/// Hand-split rather than parsed with a URL crate: what is needed is four
/// questions, each of which has a definite answer on the byte string, and a
/// dependency whose grammar is richer than the questions would still have to be
/// trusted to answer them the same way the HTTP client that receives the string
/// later does.
struct UrlParts<'a> {
    scheme: &'a str,
    userinfo: Option<&'a str>,
    host: &'a str,
    query: Option<&'a str>,
}

fn split_url(url: &str) -> Option<UrlParts<'_>> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme.is_empty() || rest.is_empty() {
        return None;
    }
    // The authority ends at the first `/`, `?` or `#`.
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(authority_end);
    let (userinfo, hostport) = match authority.rsplit_once('@') {
        Some((user, host)) => (Some(user), host),
        None => (None, authority),
    };
    if hostport.is_empty() {
        return None;
    }
    // Strip the port. IPv6 literals are bracketed, so look after the bracket.
    let host = match hostport.strip_prefix('[') {
        Some(inner) => inner.split(']').next().unwrap_or(inner),
        None => hostport.split(':').next().unwrap_or(hostport),
    };
    let query = tail
        .split_once('?')
        .map(|(_, q)| q.split('#').next().unwrap_or(q));
    Some(UrlParts {
        scheme,
        userinfo,
        host,
        query,
    })
}

/// True for a host that cannot leave the machine.
///
/// `127.0.0.0/8` in full, not just `127.0.0.1`: the whole block is loopback, and
/// a rule that only knew the one address would call `http://127.0.0.2:9000`
/// remote plaintext and refuse a server that never touches a wire.
///
/// A name is loopback only if it *is* `localhost`. `127.0.0.1.evil.example.com`
/// resolves wherever its owner says, which is why the numeric branch parses
/// every octet rather than matching a prefix.
fn is_loopback(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") || host == "::1" {
        return true;
    }
    let octets: Vec<&str> = host.split('.').collect();
    octets.len() == 4
        && octets[0] == "127"
        && octets
            .iter()
            .all(|octet| !octet.is_empty() && octet.parse::<u8>().is_ok())
}

fn validate_remote_url(id: &str, url: &str) -> McpResult<()> {
    let Some(parts) = split_url(url) else {
        return Err(invalid(id, "`url` is not an absolute http(s) URL"));
    };

    let scheme = parts.scheme.to_ascii_lowercase();
    match scheme.as_str() {
        "https" => {}
        "http" if is_loopback(parts.host) => {}
        "http" => {
            return Err(invalid(
                id,
                "plaintext `http://` is refused for anything but loopback: every request \
                 to an authenticated server carries a credential header, and a plaintext \
                 hop hands it to the network",
            ))
        }
        other => {
            return Err(invalid(
                id,
                format!("`{other}://` is not a transport this client speaks"),
            ))
        }
    }

    if parts.userinfo.is_some() {
        return Err(invalid(
            id,
            "`url` carries userinfo (`https://user:pass@host`). A credential belongs in \
             the OS credential store, not in a file and not in a URL",
        ));
    }

    if let Some(query) = parts.query {
        for pair in query.split('&') {
            let name = pair.split('=').next().unwrap_or(pair).to_ascii_lowercase();
            if CREDENTIAL_QUERY_PARAMS.contains(&name.as_str()) {
                return Err(invalid(
                    id,
                    format!(
                        "`url` carries a credential in the query string (`{name}`). Query \
                         strings reach proxy logs, server access logs and `Referer` headers; \
                         set `auth` instead"
                    ),
                ));
            }
        }
    }

    Ok(())
}

/// [`McpError`] is not `Clone` — it holds `io::Error`-derived strings and one
/// day may hold more — so a stored failure is rebuilt rather than cloned. Only
/// the arms `resolve` can produce need a case.
fn clone_error(error: &McpError) -> McpError {
    match error {
        McpError::TransportNotSupported { server, detail } => McpError::TransportNotSupported {
            server: server.clone(),
            detail: detail.clone(),
        },
        McpError::ConfigInvalid { server, detail } => McpError::ConfigInvalid {
            server: server.clone(),
            detail: detail.clone(),
        },
        other => McpError::ConfigInvalid {
            server: String::new(),
            detail: other.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FOUR_SERVERS: &str = r#"{
      "mcpServers": {
        "good":     { "command": "node", "args": ["s.mjs"], "env": { "A": "1" } },
        "remote":   { "url": "https://mcp.example.com/mcp" },
        "broken":   { "args": ["nothing-to-run"] },
        "disabled": { "command": "node", "enabled": false }
      }
    }"#;

    fn parse_one(entry: &str) -> McpResult<ServerSpec> {
        let source = format!(r#"{{ "mcpServers": {{ "s": {entry} }} }}"#);
        let config = McpConfig::parse(&source).expect("the file itself is valid JSON");
        config.server("s").cloned()
    }

    fn http_of(entry: &str) -> HttpServer {
        match parse_one(entry).expect("entry resolves") {
            ServerSpec::Http(http) => http,
            other => panic!("expected a remote server, got {other:?}"),
        }
    }

    #[test]
    fn one_broken_entry_does_not_take_the_working_ones_down() {
        let config = McpConfig::parse(FOUR_SERVERS).unwrap();
        let ServerSpec::Stdio(good) = config.server("good").unwrap() else {
            panic!("`good` is a stdio entry");
        };
        assert_eq!(good.command, "node");
        assert_eq!(good.args, vec!["s.mjs".to_owned()]);
        assert_eq!(good.env.get("A").map(String::as_str), Some("1"));

        assert!(matches!(
            config.server("broken"),
            Err(McpError::ConfigInvalid { .. })
        ));
    }

    #[test]
    fn a_remote_entry_resolves_to_a_reachable_server_rather_than_an_error() {
        // THE DEFECT THIS TRACK EXISTS FOR. `resolve` used to answer every
        // `url` entry with `TransportNotSupported`, whatever the entry said.
        let config = McpConfig::parse(FOUR_SERVERS).unwrap();
        let ServerSpec::Http(remote) = config.server("remote").unwrap() else {
            panic!("a url entry must resolve to a remote server");
        };
        assert_eq!(remote.url, "https://mcp.example.com/mcp");
        assert_eq!(remote.auth, RemoteAuth::None);
        assert!(remote.headers.is_empty());
        assert!(config.ids().any(|id| id == "remote"));
    }

    #[test]
    fn a_disabled_entry_is_not_listed_at_all() {
        let config = McpConfig::parse(FOUR_SERVERS).unwrap();
        assert!(!config.ids().any(|id| id == "disabled"));
        assert!(matches!(
            config.server("disabled"),
            Err(McpError::NotConfigured(_))
        ));
    }

    #[test]
    fn ids_come_back_in_a_stable_order() {
        let config = McpConfig::parse(FOUR_SERVERS).unwrap();
        let ids: Vec<&str> = config.ids().collect();
        assert_eq!(ids, vec!["broken", "good", "remote"]);
    }

    #[test]
    fn a_file_that_is_not_json_fails_as_a_whole() {
        assert!(matches!(
            McpConfig::parse("not json at all"),
            Err(McpError::ConfigUnreadable { .. })
        ));
    }

    #[test]
    fn a_missing_file_is_an_empty_configuration() {
        let config = McpConfig::read(Path::new("no-such-directory/no-such-file.json")).unwrap();
        assert!(config.is_empty());
    }

    #[test]
    fn the_inherited_environment_is_a_short_allowlist_and_holds_no_credentials() {
        // The guard on the rule, not on the list: a name arriving here that
        // looks like a secret means somebody widened it without reading why it
        // was narrow.
        for name in INHERITED_ENV {
            let lower = name.to_lowercase();
            assert!(
                !lower.contains("token") && !lower.contains("key") && !lower.contains("secret"),
                "`{name}` would hand credential material to third-party code"
            );
        }
    }

    // -----------------------------------------------------------------
    // Remote entries: the security rules, each with its own case
    // -----------------------------------------------------------------

    #[test]
    fn oauth_names_a_credential_and_cannot_carry_one() {
        let http = http_of(
            r#"{
              "url": "https://mcp.example.com/mcp",
              "auth": {
                "type": "oauth",
                "clientId": "vela-desktop",
                "tokenEndpoint": "https://auth.example.com/token",
                "scopes": ["mcp:tools", "profile"]
              }
            }"#,
        );
        let RemoteAuth::OAuth(oauth) = &http.auth else {
            panic!("expected oauth, got {:?}", http.auth);
        };
        assert_eq!(oauth.client_id, "vela-desktop");
        assert_eq!(oauth.token_endpoint, "https://auth.example.com/token");
        assert_eq!(oauth.scopes, vec!["mcp:tools", "profile"]);

        // The whole point: there is nowhere in the parsed value for a token to
        // be, so a file cannot hold one however it is written.
        let rendered = format!("{http:?}");
        assert!(!rendered.contains("Bearer"), "{rendered}");
    }

    #[test]
    fn a_credential_header_in_the_file_is_refused_rather_than_sent() {
        for name in ["Authorization", "authorization", "X-Api-Key", "Cookie"] {
            let entry = format!(
                r#"{{ "url": "https://mcp.example.com/mcp",
                       "headers": {{ "{name}": "sk-live-1" }} }}"#
            );
            let error = parse_one(&entry).expect_err("a credential header must be refused");
            assert!(
                matches!(&error, McpError::ConfigInvalid { detail, .. }
                    if detail.contains("credential store")),
                "{name}: got {error:?}"
            );
        }
    }

    #[test]
    fn a_file_may_not_set_the_headers_this_transport_frames_with() {
        for name in ["Accept", "Content-Type", "Mcp-Session-Id"] {
            let entry = format!(
                r#"{{ "url": "https://mcp.example.com/mcp", "headers": {{ "{name}": "x" }} }}"#
            );
            assert!(
                matches!(parse_one(&entry), Err(McpError::ConfigInvalid { .. })),
                "`{name}` must not be settable from a file"
            );
        }
    }

    #[test]
    fn a_custom_header_survives_with_its_name_lowercased() {
        let http = http_of(
            r#"{ "url": "https://mcp.example.com/mcp", "headers": { "X-Tenant": "acme" } }"#,
        );
        assert_eq!(
            http.headers.get("x-tenant").map(String::as_str),
            Some("acme")
        );
    }

    #[test]
    fn a_header_value_may_not_smuggle_a_second_header() {
        let entry = r#"{ "url": "https://mcp.example.com/mcp",
                         "headers": { "X-Tenant": "acme\r\nAuthorization: Bearer sk" } }"#;
        assert!(matches!(
            parse_one(entry),
            Err(McpError::ConfigInvalid { .. })
        ));
    }

    #[test]
    fn a_token_in_the_query_string_is_refused() {
        for url in [
            "https://mcp.example.com/mcp?access_token=sk-live-1",
            "https://mcp.example.com/mcp?a=1&api_key=sk",
            "https://mcp.example.com/mcp?TOKEN=sk#frag",
        ] {
            let entry = format!(r#"{{ "url": "{url}" }}"#);
            let error = parse_one(&entry).expect_err("a query credential must be refused");
            assert!(
                matches!(&error, McpError::ConfigInvalid { detail, .. }
                    if detail.contains("query string")),
                "{url}: got {error:?}"
            );
        }
    }

    #[test]
    fn a_harmless_query_string_still_works() {
        let http = http_of(r#"{ "url": "https://mcp.example.com/mcp?tenant=acme" }"#);
        assert_eq!(http.url, "https://mcp.example.com/mcp?tenant=acme");
    }

    #[test]
    fn userinfo_in_the_url_is_refused() {
        let entry = r#"{ "url": "https://user:hunter2@mcp.example.com/mcp" }"#;
        let error = parse_one(entry).expect_err("userinfo must be refused");
        assert!(
            matches!(&error, McpError::ConfigInvalid { detail, .. } if detail.contains("userinfo")),
            "got {error:?}"
        );
    }

    #[test]
    fn plaintext_http_is_refused_off_the_machine_and_allowed_on_it() {
        for allowed in [
            "http://127.0.0.1:8080/mcp",
            "http://127.0.0.5:8080/mcp",
            "http://localhost:8080/mcp",
            "http://[::1]:8080/mcp",
        ] {
            let entry = format!(r#"{{ "url": "{allowed}" }}"#);
            assert!(
                parse_one(&entry).is_ok(),
                "{allowed} never leaves the machine and must be usable"
            );
        }
        for refused in [
            "http://mcp.example.com/mcp",
            "http://127.0.0.1.evil.example.com/mcp",
            "http://10.0.0.4/mcp",
        ] {
            let entry = format!(r#"{{ "url": "{refused}" }}"#);
            let error = parse_one(&entry).expect_err("plaintext off the machine must be refused");
            assert!(
                matches!(&error, McpError::ConfigInvalid { detail, .. }
                    if detail.contains("plaintext")),
                "{refused}: got {error:?}"
            );
        }
    }

    #[test]
    fn a_scheme_this_client_does_not_speak_is_refused_by_name() {
        for url in ["ws://mcp.example.com", "file:///c:/x", "ftp://x.example"] {
            let entry = format!(r#"{{ "url": "{url}" }}"#);
            assert!(
                matches!(parse_one(&entry), Err(McpError::ConfigInvalid { .. })),
                "{url} must not resolve"
            );
        }
    }

    #[test]
    fn the_auth_type_a_user_types_is_the_one_that_parses() {
        // `#[serde(rename_all = "camelCase")]` renders the `OAuth` variant as
        // `oAuth`, which nobody writes and which two tests above only caught
        // because they assert on the *parsed value* rather than on "it parsed".
        for spelling in ["none", "bearer"] {
            let entry = format!(
                r#"{{ "url": "https://mcp.example.com/mcp", "auth": {{ "type": "{spelling}" }} }}"#
            );
            assert!(parse_one(&entry).is_ok(), "`{spelling}` must parse");
        }
        let oauth = r#"{ "url": "https://mcp.example.com/mcp",
                         "auth": { "type": "oauth", "clientId": "c",
                                   "tokenEndpoint": "https://auth.example.com/t" } }"#;
        assert!(parse_one(oauth).is_ok(), "`oauth` must parse");
        let camel = r#"{ "url": "https://mcp.example.com/mcp",
                         "auth": { "type": "oAuth", "clientId": "c",
                                   "tokenEndpoint": "https://auth.example.com/t" } }"#;
        assert!(
            parse_one(camel).is_err(),
            "`oAuth` is a spelling nobody types and must not be a second name for it"
        );
    }

    #[test]
    fn a_misspelled_auth_type_fails_its_own_entry_and_not_the_file() {
        let source = r#"{
          "mcpServers": {
            "good":   { "command": "node" },
            "typo":   { "url": "https://mcp.example.com/mcp", "auth": { "type": "oauth2" } }
          }
        }"#;
        let config = McpConfig::parse(source).expect("the file is still readable");
        assert!(config.server("good").is_ok());
        assert!(matches!(
            config.server("typo"),
            Err(McpError::ConfigInvalid { .. })
        ));
    }

    #[test]
    fn an_oauth_token_endpoint_is_held_to_the_same_url_rules() {
        let entry = r#"{
          "url": "https://mcp.example.com/mcp",
          "auth": { "type": "oauth", "clientId": "c",
                    "tokenEndpoint": "http://auth.example.com/token" }
        }"#;
        let error = parse_one(entry).expect_err("a plaintext token endpoint must be refused");
        assert!(
            matches!(&error, McpError::ConfigInvalid { detail, .. }
                if detail.contains("plaintext")),
            "got {error:?}"
        );
    }

    #[test]
    fn an_entry_with_both_a_command_and_a_url_launches_the_command() {
        let spec = parse_one(
            r#"{ "command": "node", "args": ["s.mjs"], "url": "https://mcp.example.com/mcp" }"#,
        )
        .unwrap();
        assert!(matches!(spec, ServerSpec::Stdio(_)), "got {spec:?}");
    }

    #[test]
    fn the_credential_reference_is_namespaced_away_from_model_providers() {
        let reference = credential_ref("team").unwrap();
        assert_eq!(reference.storage_key(), "mcp:team/token");
        assert_ne!(
            reference.storage_key(),
            SecretRef::primary("team").unwrap().storage_key(),
            "an MCP server and a model provider with the same id must not share an entry"
        );
    }
}
