//! `diagnostics_*` commands.
//!
//! `diagnostics_echo` is the canonical example of the command pattern and the
//! liveness probe the renderer uses to prove the bridge is up. It is also the
//! reference for how a command reports a rejected payload.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::{IpcError, IpcResult};

/// Guard against a runaway renderer pushing unbounded strings across the
/// bridge. Every command that accepts free text must impose a bound.
pub const MAX_ECHO_BYTES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EchoReq {
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EchoRes {
    pub message: String,
    /// Host wall clock in milliseconds since the Unix epoch.
    pub received_at_ms: u64,
}

pub fn echo(req: EchoReq, now_ms: u64) -> IpcResult<EchoRes> {
    if req.message.is_empty() {
        return Err(IpcError::invalid("message must not be empty"));
    }
    if req.message.len() > MAX_ECHO_BYTES {
        return Err(IpcError::invalid(format!(
            "message exceeds {MAX_ECHO_BYTES} bytes"
        )));
    }
    Ok(EchoRes {
        message: req.message,
        received_at_ms: now_ms,
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn diagnostics_echo(payload: EchoReq) -> IpcResult<EchoRes> {
    echo(payload, now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::IpcErrorCode;

    #[test]
    fn echoes_the_message_and_stamps_it() {
        let res = echo(
            EchoReq {
                message: "bridge up".into(),
            },
            1_700_000_000_000,
        )
        .unwrap();
        assert_eq!(res.message, "bridge up");
        assert_eq!(res.received_at_ms, 1_700_000_000_000);
    }

    #[test]
    fn rejects_empty_and_oversized_payloads_with_invalid_payload() {
        let empty = echo(EchoReq { message: String::new() }, 0).unwrap_err();
        assert_eq!(empty.code, IpcErrorCode::InvalidPayload);

        let huge = echo(
            EchoReq {
                message: "x".repeat(MAX_ECHO_BYTES + 1),
            },
            0,
        )
        .unwrap_err();
        assert_eq!(huge.code, IpcErrorCode::InvalidPayload);
    }
}
