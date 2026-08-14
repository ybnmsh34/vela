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
//!     }
//!   }
//! }
//! ```
//!
//! This is the layout every other MCP client already uses, and copying it is
//! worth more than improving it: a user who has a working stdio server has a
//! working entry for it somewhere on disk, and the whole value of the feature is
//! that they can paste it in. An id-keyed map rather than an array for the same
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
//! ## What is deliberately not here
//!
//! No `url` transport. An entry carrying one parses, and is kept, and reports
//! [`McpError::TransportNotSupported`] — it does not silently vanish and it is
//! not called invalid. See `docs/architecture/conventions.md` §9 on visible
//! reduction: a server the user configured that quietly does not appear is the
//! failure mode this project treats as the worst one.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

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

/// One entry as it appeared in the file, before any judgement about whether it
/// can be launched.
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
    /// Present on remote entries. Read only so the error can be specific.
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawConfig {
    #[serde(default)]
    mcp_servers: BTreeMap<String, RawEntry>,
}

/// Every configured server id, each either launchable or explained.
#[derive(Debug, Default)]
pub struct McpConfig {
    entries: BTreeMap<String, McpResult<StdioServer>>,
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

    /// The launch description for one id, or why there is not one.
    pub fn server(&self, id: &str) -> McpResult<&StdioServer> {
        match self.entries.get(id) {
            None => Err(McpError::NotConfigured(id.to_owned())),
            Some(Ok(server)) => Ok(server),
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

fn resolve(id: &str, entry: RawEntry) -> McpResult<StdioServer> {
    match (entry.command.as_deref(), entry.url.as_deref()) {
        (Some(command), _) if !command.trim().is_empty() => Ok(StdioServer {
            command: command.to_owned(),
            args: entry.args,
            env: entry.env,
            cwd: entry.cwd.map(PathBuf::from),
        }),
        (_, Some(_)) => Err(McpError::TransportNotSupported {
            server: id.to_owned(),
            detail: "this build implements the stdio transport only".to_owned(),
        }),
        _ => Err(McpError::ConfigInvalid {
            server: id.to_owned(),
            detail: "an entry needs a non-empty command".to_owned(),
        }),
    }
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
        "remote":   { "url": "https://mcp.example.com" },
        "broken":   { "args": ["nothing-to-run"] },
        "disabled": { "command": "node", "enabled": false }
      }
    }"#;

    #[test]
    fn one_broken_entry_does_not_take_the_working_ones_down() {
        let config = McpConfig::parse(FOUR_SERVERS).unwrap();
        let good = config.server("good").unwrap();
        assert_eq!(good.command, "node");
        assert_eq!(good.args, vec!["s.mjs".to_owned()]);
        assert_eq!(good.env.get("A").map(String::as_str), Some("1"));

        assert!(matches!(
            config.server("broken"),
            Err(McpError::ConfigInvalid { .. })
        ));
    }

    #[test]
    fn a_remote_entry_is_unsupported_rather_than_invalid_or_missing() {
        // The distinction the user acts on: "nothing is wrong with your file,
        // this client cannot do it yet" versus "go and fix your file".
        let config = McpConfig::parse(FOUR_SERVERS).unwrap();
        assert!(matches!(
            config.server("remote"),
            Err(McpError::TransportNotSupported { .. })
        ));
        assert!(
            config.ids().any(|id| id == "remote"),
            "an unsupported server must still be listed, or the user cannot see \
             that the client ignored something they configured"
        );
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
}
