//! JSON-RPC 2.0 as MCP uses it, and nothing more.
//!
//! ## Why this is hand-rolled rather than a crate
//!
//! MCP's use of JSON-RPC is small and peculiar in exactly one way that matters:
//! **the client never sends a response and the server never sends a request.**
//! That single rule collapses the whole peer state machine into "outgoing
//! requests waiting for a reply, plus incoming notifications", which is what
//! [`Incoming`] is. A general JSON-RPC library would carry the other half —
//! dispatching inbound calls, building outbound responses — and that half is
//! forbidden here, so it would be surface with no caller and no test.
//!
//! ## The one framing rule
//!
//! One message per line, and no message may contain an embedded newline. A
//! serialised JSON value never contains a raw newline (the encoder escapes it),
//! so writing `serde_json::to_string` followed by `\n` satisfies the rule by
//! construction rather than by remembering to.

use serde_json::{json, Map, Value};

use crate::error::{McpError, McpResult};

/// The protocol version this client announces in `initialize`.
///
/// **Legacy on purpose, and this is the honest statement of what is built.**
/// Revision `2026-07-28` removed the handshake in favour of a `server/discover`
/// probe, and a complete client probes for it and falls back. This one does not
/// probe: it opens with `initialize`, which is what the servers deployed today
/// answer. What that costs is written down at [`crate::client::McpConnection`]
/// rather than left for a reader to infer from a constant.
pub const PROTOCOL_VERSION: &str = "2025-06-18";

pub const METHOD_INITIALIZE: &str = "initialize";
pub const METHOD_TOOLS_LIST: &str = "tools/list";
pub const METHOD_TOOLS_CALL: &str = "tools/call";
pub const NOTIFY_INITIALIZED: &str = "notifications/initialized";
pub const NOTIFY_CANCELLED: &str = "notifications/cancelled";
pub const NOTIFY_TOOLS_LIST_CHANGED: &str = "notifications/tools/list_changed";

/// Where a modern server puts its caching hints. Read off the result object's
/// `_meta`; see [`ttl_ms_of`].
pub const META_TTL_MS: &str = "io.modelcontextprotocol/ttlMs";

/// One line off the server's stdout, classified.
///
/// A message with an `id` and a `result` or `error` answers something this
/// client asked. A message with a `method` and no `id` is a notification. There
/// is no third case that is legal — a `method` *with* an `id` would be a
/// server-initiated request, which MCP forbids — so an unclassifiable line is
/// reported rather than ignored.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    Response {
        id: u64,
        outcome: Result<Value, RpcError>,
    },
    Notification {
        method: String,
        params: Value,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl From<RpcError> for McpError {
    fn from(error: RpcError) -> Self {
        McpError::Rpc {
            code: error.code,
            message: error.message,
        }
    }
}

/// One outgoing request as a value, before any framing.
///
/// Split from [`encode_request`] because the two transports frame differently
/// and the *message* is the part they share: stdio appends a newline, HTTP puts
/// the same object in a POST body with no newline at all. Two `json!` literals
/// would be two chances for the wire shapes to drift apart.
pub fn request_message(id: u64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

/// One outgoing notification as a value. No `id`: a notification is by
/// definition the message nothing is owed for.
pub fn notification_message(method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "method": method, "params": params })
}

/// Serialise one outgoing request, framed for stdio.
pub fn encode_request(id: u64, method: &str, params: Value) -> String {
    format!("{}\n", request_message(id, method, params))
}

/// Serialise one outgoing notification, framed for stdio.
pub fn encode_notification(method: &str, params: Value) -> String {
    format!("{}\n", notification_message(method, params))
}

/// Classify one inbound line.
///
/// Ids are read as `u64` because that is what this client mints. A response
/// carrying a string id — legal JSON-RPC, but an answer to a request nobody
/// here sent — is a protocol error rather than a silently dropped line: it means
/// the pipe is carrying somebody else's traffic, and continuing to trust it is
/// how a tool result ends up attributed to the wrong call.
pub fn decode(line: &str) -> McpResult<Incoming> {
    let value: Value = serde_json::from_str(line)
        .map_err(|e| McpError::Protocol(format!("line is not JSON: {e}")))?;
    let object = value
        .as_object()
        .ok_or_else(|| McpError::Protocol("message is not a JSON object".to_owned()))?;

    if let Some(id) = object.get("id") {
        if object.contains_key("method") {
            return Err(McpError::Protocol(
                "server sent a request; MCP servers may not initiate requests".to_owned(),
            ));
        }
        let id = id
            .as_u64()
            .ok_or_else(|| McpError::Protocol(format!("response id is not one of ours: {id}")))?;
        if let Some(error) = object.get("error") {
            let code = error.get("code").and_then(Value::as_i64).unwrap_or(0);
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("(no message)")
                .to_owned();
            return Ok(Incoming::Response {
                id,
                outcome: Err(RpcError { code, message }),
            });
        }
        let result = object.get("result").cloned().ok_or_else(|| {
            McpError::Protocol("response has neither result nor error".to_owned())
        })?;
        return Ok(Incoming::Response {
            id,
            outcome: Ok(result),
        });
    }

    let method = object
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| McpError::Protocol("message has neither id nor method".to_owned()))?;
    Ok(Incoming::Notification {
        method: method.to_owned(),
        params: object.get("params").cloned().unwrap_or(Value::Null),
    })
}

/// The freshness hint on a result, in milliseconds, if the server sent one.
///
/// Read from `_meta` first, which is where the current revision puts it, then
/// from a top-level field, which is where some servers put it instead. A
/// negative value is discarded rather than clamped: the spec says treat it as
/// zero, and zero is what "absent" already means.
pub fn ttl_ms_of(result: &Value) -> Option<u64> {
    let from_meta = result
        .get("_meta")
        .and_then(Value::as_object)
        .and_then(|meta: &Map<String, Value>| meta.get(META_TTL_MS));
    let raw = from_meta.or_else(|| result.get("ttlMs"))?;
    raw.as_i64().filter(|ms| *ms >= 0).map(|ms| ms as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_framed_message_is_exactly_one_line() {
        let framed = encode_request(1, METHOD_TOOLS_CALL, json!({ "text": "a\nb" }));
        assert!(framed.ends_with('\n'));
        assert_eq!(
            framed.trim_end().matches('\n').count(),
            0,
            "an embedded newline would split one message into two"
        );
    }

    #[test]
    fn a_result_and_an_error_are_both_responses() {
        let ok = decode(r#"{"jsonrpc":"2.0","id":7,"result":{"tools":[]}}"#).unwrap();
        assert_eq!(
            ok,
            Incoming::Response {
                id: 7,
                outcome: Ok(json!({ "tools": [] })),
            }
        );
        let failed =
            decode(r#"{"jsonrpc":"2.0","id":8,"error":{"code":-32601,"message":"nope"}}"#).unwrap();
        assert_eq!(
            failed,
            Incoming::Response {
                id: 8,
                outcome: Err(RpcError {
                    code: -32601,
                    message: "nope".to_owned(),
                }),
            }
        );
    }

    #[test]
    fn a_notification_carries_no_id() {
        let incoming =
            decode(r#"{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}"#).unwrap();
        assert_eq!(
            incoming,
            Incoming::Notification {
                method: NOTIFY_TOOLS_LIST_CHANGED.to_owned(),
                params: Value::Null,
            }
        );
    }

    #[test]
    fn a_server_initiated_request_is_refused() {
        // MCP servers do not send requests. Accepting one would mean this client
        // owes a response it has no code to build.
        let error = decode(r#"{"jsonrpc":"2.0","id":1,"method":"sampling/createMessage"}"#)
            .expect_err("a server request must not decode as anything");
        assert!(matches!(error, McpError::Protocol(_)));
    }

    #[test]
    fn a_response_to_an_id_this_client_never_minted_is_a_protocol_error() {
        let error = decode(r#"{"jsonrpc":"2.0","id":"abc","result":{}}"#)
            .expect_err("a string id cannot address a pending request");
        assert!(matches!(error, McpError::Protocol(_)));
    }

    #[test]
    fn caching_hints_are_read_from_meta_and_absent_hints_stay_absent() {
        let with_meta =
            json!({ "tools": [], "_meta": { "io.modelcontextprotocol/ttlMs": 60_000 } });
        assert_eq!(ttl_ms_of(&with_meta), Some(60_000));
        assert_eq!(ttl_ms_of(&json!({ "ttlMs": 5 })), Some(5));
        assert_eq!(ttl_ms_of(&json!({ "tools": [] })), None);
        assert_eq!(
            ttl_ms_of(&json!({ "ttlMs": -1 })),
            None,
            "a negative freshness window is not a freshness window"
        );
    }
}
