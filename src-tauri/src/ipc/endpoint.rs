//! `endpoint_*` commands — the switch for the dual local endpoint.
//!
//! Three commands: ask what it is doing, turn it on (or move it), turn it off.
//! They are the runtime half of `crate::endpoint_host`, whose module docs carry
//! the reasoning; what belongs here is what crosses the boundary.
//!
//! ## What this surface deliberately cannot say
//!
//! The endpoint serves two wire dialects on one port. **Neither is nameable
//! here**, and that is not an accident of drafting: `src/platform/no-provider-leak.test.ts`
//! scans this directory for exactly those words, and the whole reason this
//! command did not exist for so long was a comment asserting the surface would
//! need them. It does not. The request is an address, a key, a provider id the
//! *user* configured, and a tool flag; the response is what the listener
//! resolved from those. A renderer built on this cannot learn that there are
//! two dialects, let alone branch on one.
//!
//! ## The key goes one way
//!
//! [`EndpointEnableReq::key`] is a [`SecretValue`] for the same reason
//! `SecretsSetReq::value` is: the struct cannot be printed and cannot be
//! serialised, so a request carrying the endpoint's bearer key can neither be
//! logged nor echoed back. [`EndpointStatusRes`] has no field that could hold
//! it. Unlike `secrets_set`, this key is **not** written to the OS keychain —
//! it is handed to the listener and lives in this process only, which is the
//! same limitation as "nothing persists" in `endpoint_host`.

use serde::{Deserialize, Serialize};
use tauri::State;
use vela_core::secret::SecretValue;
use vela_endpoint::policy::ToolRequest;

use super::{EmptyPayload, IpcError, IpcResult};
use crate::endpoint_host::{EndpointControl, EndpointReport, RunState, Wanted};

/// What the caller wants done about tools, before the bound address has its
/// say. Mirrors [`ToolRequest`] without the confirmation flag, which is carried
/// beside it so that "I want tools" and "I accept what that means on an exposed
/// bind" stay two separate statements the user made.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolsRequest {
    /// Let the bound address decide. The ordinary case, and the safe one.
    #[default]
    Default,
    On,
    Off,
}

/// Which arm of the endpoint's state a status describes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EndpointRunState {
    Off,
    /// A configuration was supplied and rejected before anything bound.
    Refused,
    /// The bind itself failed — the port is taken, usually.
    BindFailed,
    Serving,
}

/// Note the type of `key`, and note that this struct derives `Deserialize` and
/// **not** `Serialize`: `SecretValue` has no `Serialize` impl at all, so adding
/// one here does not compile. A request carrying a credential cannot be echoed
/// back, and its `Debug` redacts.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointEnableReq {
    /// `host:port`. Its scope decides the tool policy; see [`EndpointStatusRes::loopback`].
    pub bind: String,
    pub key: SecretValue,
    /// One of the ids the user configured through `settings_put_provider`.
    /// Opaque here, exactly as it is everywhere else.
    pub provider_id: String,
    #[serde(default)]
    pub tools: ToolsRequest,
    /// The operator's answer to "tools on an address other machines can reach".
    /// Ignored unless `tools` is `on` **and** the bound address is not
    /// loopback; without it that combination resolves to tools off rather than
    /// to an error, because failing closed is the only defensible answer to a
    /// question nobody answered.
    #[serde(default)]
    pub confirm_exposed_tools: bool,
}

/// What the endpoint is doing, read back off the live listener.
///
/// Every field is a boolean, a closed enum, or a string the host computed from
/// what it actually bound. There is nothing here a renderer could use to
/// discover what the endpoint speaks.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointStatusRes {
    pub state: EndpointRunState,
    /// `host:port` as bound — including the port the operating system chose
    /// when `0` was asked for. `null` unless serving.
    pub address: Option<String>,
    /// The configured id that answers turns here. `null` unless serving.
    pub provider_id: Option<String>,
    /// Whether tool calls reach the model. `false` whenever not serving.
    pub tools_enabled: bool,
    /// A stable code for *why* — `loopback-default`, `exposed-default`,
    /// `forced-on`, `exposed-enable-unconfirmed`, `forced-off`. A code and not
    /// a sentence: the surface that shows this owns the wording, the same rule
    /// `Concern` and `RefusalReason` follow.
    pub tool_policy: Option<String>,
    /// Whether the bound address is reachable only from this machine.
    pub loopback: bool,
    /// The refusal code, or the operating system's reason the bind failed.
    /// `null` in the two states that have nothing to explain.
    pub detail: Option<String>,
}

impl From<EndpointReport> for EndpointStatusRes {
    fn from(report: EndpointReport) -> Self {
        Self {
            state: match report.state {
                RunState::Off => EndpointRunState::Off,
                RunState::Refused => EndpointRunState::Refused,
                RunState::BindFailed => EndpointRunState::BindFailed,
                RunState::Serving => EndpointRunState::Serving,
            },
            address: report.address,
            provider_id: report.provider_id,
            tools_enabled: report.tools_enabled,
            tool_policy: report.policy_reason.map(str::to_owned),
            loopback: report.loopback,
            detail: report.detail,
        }
    }
}

impl TryFrom<EndpointEnableReq> for Wanted {
    type Error = IpcError;

    /// Validates the two fields that have a wrong answer, and refuses rather
    /// than substituting one.
    ///
    /// An unparseable address is the same refusal `VELA_LOCAL_ENDPOINT` gets —
    /// defaulting it would open a port the user did not name. An empty key is
    /// refused here as well as inside `serve`, so the renderer gets
    /// `INVALID_PAYLOAD` and a sentence rather than a generic bind failure.
    fn try_from(req: EndpointEnableReq) -> Result<Self, Self::Error> {
        let bind = req
            .bind
            .trim()
            .parse()
            .map_err(|_| IpcError::invalid("the address must be written as host:port"))?;
        if req.key.expose().trim().is_empty() {
            return Err(IpcError::invalid(
                "the local endpoint needs a key: an endpoint anything on the network could \
                 use is not a configuration",
            ));
        }
        let provider_id = req.provider_id.trim().to_owned();
        if provider_id.is_empty() {
            return Err(IpcError::invalid(
                "name which configured endpoint should answer here",
            ));
        }
        Ok(Wanted {
            bind,
            api_key: req.key.expose().to_owned(),
            provider_id,
            tools: match req.tools {
                ToolsRequest::Default => ToolRequest::Default,
                ToolsRequest::On => ToolRequest::Enable {
                    confirmed: req.confirm_exposed_tools,
                },
                ToolsRequest::Off => ToolRequest::Disable,
            },
        })
    }
}

// ---------------------------------------------------------------------------
// Logic — plain functions over the control, unit-testable with no Tauri.
// ---------------------------------------------------------------------------

pub fn status(control: &EndpointControl, _req: EmptyPayload) -> IpcResult<EndpointStatusRes> {
    Ok(control.report().into())
}

pub fn enable(control: &EndpointControl, req: EndpointEnableReq) -> IpcResult<EndpointStatusRes> {
    Ok(control.enable(Wanted::try_from(req)?).into())
}

pub fn disable(control: &EndpointControl, _req: EmptyPayload) -> IpcResult<EndpointStatusRes> {
    Ok(control.disable().into())
}

// ---------------------------------------------------------------------------
// Commands — thin adapters. Nothing but extraction and delegation.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn endpoint_status(
    control: State<'_, EndpointControl>,
    payload: EmptyPayload,
) -> IpcResult<EndpointStatusRes> {
    status(&control, payload)
}

#[tauri::command]
pub fn endpoint_enable(
    control: State<'_, EndpointControl>,
    payload: EndpointEnableReq,
) -> IpcResult<EndpointStatusRes> {
    enable(&control, payload)
}

#[tauri::command]
pub fn endpoint_disable(
    control: State<'_, EndpointControl>,
    payload: EmptyPayload,
) -> IpcResult<EndpointStatusRes> {
    disable(&control, payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::IpcErrorCode;
    use crate::provider_host::ProviderHost;
    use std::sync::Arc;
    use vela_secrets::MemoryStore;

    /// VERIFIED-BY-FAKE: an in-memory credential store and a provider registry
    /// with nothing behind it. A real socket *is* opened — that half is not a
    /// fake — but nothing here is evidence about a model.
    fn control() -> EndpointControl {
        EndpointControl::off(Arc::new(ProviderHost::for_runtime(Arc::new(
            MemoryStore::new(),
        ))))
    }

    fn request(bind: &str) -> EndpointEnableReq {
        EndpointEnableReq {
            bind: bind.to_owned(),
            key: SecretValue::new("sk-vela-test"),
            provider_id: "llamacpp".to_owned(),
            tools: ToolsRequest::Default,
            confirm_exposed_tools: false,
        }
    }

    #[test]
    fn the_endpoint_is_off_until_something_asks_for_it() {
        let status = status(&control(), EmptyPayload {}).unwrap();
        assert_eq!(status.state, EndpointRunState::Off);
        assert_eq!(status.address, None);
        assert!(!status.tools_enabled);
        assert_eq!(status.tool_policy, None);
    }

    #[test]
    fn enable_then_disable_round_trips_through_the_command_pair() {
        let control = control();

        let on = enable(&control, request("127.0.0.1:0")).unwrap();
        assert_eq!(on.state, EndpointRunState::Serving);
        assert_eq!(on.provider_id.as_deref(), Some("llamacpp"));
        assert!(on.loopback);
        assert!(on.tools_enabled);
        assert_eq!(on.tool_policy.as_deref(), Some("loopback-default"));
        let address = on.address.clone().expect("a serving endpoint has one");
        assert!(
            !address.ends_with(":0"),
            "the report must carry the port the OS chose, not the one that was asked for"
        );

        let off = disable(&control, EmptyPayload {}).unwrap();
        assert_eq!(off.state, EndpointRunState::Off);
        assert_eq!(off.address, None);
        assert!(!off.tools_enabled);
    }

    /// The security rule as the renderer sees it. A wildcard bind must come
    /// back with tools off and a reason the UI can render, without the caller
    /// having asked for anything different.
    #[test]
    fn a_wildcard_bind_comes_back_with_tools_off_and_a_reason() {
        let control = control();
        enable(&control, request("127.0.0.1:0")).unwrap();

        let exposed = enable(&control, request("0.0.0.0:0")).unwrap();
        assert_eq!(exposed.state, EndpointRunState::Serving);
        assert!(!exposed.loopback);
        assert!(!exposed.tools_enabled);
        assert_eq!(exposed.tool_policy.as_deref(), Some("exposed-default"));

        let mut forced = request("0.0.0.0:0");
        forced.tools = ToolsRequest::On;
        let unconfirmed = enable(&control, forced.clone()).unwrap();
        assert!(!unconfirmed.tools_enabled);
        assert_eq!(
            unconfirmed.tool_policy.as_deref(),
            Some("exposed-enable-unconfirmed")
        );

        forced.confirm_exposed_tools = true;
        let confirmed = enable(&control, forced).unwrap();
        assert!(confirmed.tools_enabled);
        assert_eq!(confirmed.tool_policy.as_deref(), Some("forced-on"));
    }

    #[test]
    fn a_malformed_configuration_is_refused_before_anything_binds() {
        let control = control();
        for (label, req) in [
            ("not an address", request("nowhere")),
            (
                "no key",
                EndpointEnableReq {
                    key: SecretValue::new("   "),
                    ..request("127.0.0.1:0")
                },
            ),
            (
                "no provider",
                EndpointEnableReq {
                    provider_id: "  ".to_owned(),
                    ..request("127.0.0.1:0")
                },
            ),
        ] {
            let error = enable(&control, req).unwrap_err();
            assert_eq!(
                error.code,
                IpcErrorCode::InvalidPayload,
                "`{label}` should be an invalid payload"
            );
        }
        assert_eq!(
            status(&control, EmptyPayload {}).unwrap().state,
            EndpointRunState::Off,
            "a refused configuration must not have opened a port"
        );
    }

    #[test]
    fn no_response_or_logged_request_can_carry_the_key() {
        let request = EndpointEnableReq {
            key: SecretValue::new("sk-vela-canary-DO-NOT-LOG"),
            ..request("127.0.0.1:0")
        };
        let printed = format!("{request:?}");
        assert!(printed.contains("127.0.0.1:0"));
        assert!(
            !printed.contains("sk-vela-canary"),
            "the request leaked its key: {printed}"
        );

        let control = control();
        let json = serde_json::to_string(&enable(&control, request).unwrap()).unwrap();
        assert!(
            !json.contains("sk-vela-canary"),
            "a status response carried the endpoint key: {json}"
        );
    }

    /// The wire shape, pinned. `camelCase`, closed enums, and no field that
    /// could hold a dialect, a vendor name or a key.
    #[test]
    fn the_status_json_is_camel_case_and_names_no_backend() {
        let control = control();
        let json = serde_json::to_value(enable(&control, request("127.0.0.1:0")).unwrap()).unwrap();
        assert_eq!(json["state"], "serving");
        assert_eq!(json["providerId"], "llamacpp");
        assert_eq!(json["toolsEnabled"], true);
        assert_eq!(json["toolPolicy"], "loopback-default");
        assert_eq!(json["loopback"], true);
        assert!(json["detail"].is_null());
        assert!(
            json.get("key").is_none() && json.get("apiKey").is_none(),
            "the status must have nowhere to put a credential"
        );
    }
}
