//! **The bind-address tool policy. This is a security rule, not a preference.**
//!
//! `docs/references/unsloth-studio.md` §5 records the rule and its rationale
//! verbatim from the reference's own documentation:
//!
//! > `127.0.0.1` (localhost) — tools on by default. Only your machine can reach
//! > the server.
//! > `0.0.0.0` or any non-loopback address — tools off by default. **A leaked
//! > API key on a network-exposed server means arbitrary code execution on the
//! > host.**
//! >
//! > The resolved policy is a **process-level hard override** — individual
//! > requests cannot bypass it via `enable_tools=true` in the request body.
//!
//! Two things follow, and both are implemented here rather than described:
//!
//! 1. **The scope of the bind address decides the default.** A server that
//!    binds `0.0.0.0` with tools enabled is a defect. `resolve` cannot produce
//!    that state from a default request, and cannot produce it from an explicit
//!    one either unless the operator confirmed it out of band — which is the
//!    reference's `--enable-tools` y/N prompt, modelled as
//!    [`ToolRequest::Enable`]'s `confirmed` field rather than as a terminal
//!    read this crate has no business doing.
//!
//! 2. **The override is process-level, so it must have exactly one choke
//!    point.** That is [`ToolPolicy::enforce`], which every decoded request
//!    passes through in `server.rs` before a brain ever sees it. Nothing else
//!    in this crate reads a request's tools. A request body field asking for
//!    tools is not consulted anywhere, which is why an `enable_tools: true` in
//!    the body cannot flip anything: there is no code path from that byte to
//!    this decision.
//!
//! What "tools off" means concretely is the second half of `enforce`, and it is
//! not just an empty catalogue: `ToolChoice` is forced to `None` as well.
//! `vela_providers::model::ToolChoice::None` records GATE M FINDING 6 — one of
//! the matrix profiles rejects a request that carries `tools` even with
//! `tool_choice: "none"` — so a stripped catalogue paired with a surviving
//! `Required` would be a request that asks a model to call a tool it was not
//! given. Off means off in both fields.

use std::net::{IpAddr, SocketAddr};

use vela_providers::model::{ChatRequest, ToolChoice};

/// Whether the address the listener bound is reachable only from this machine.
///
/// Derived from the address, never configured: an operator who could *declare*
/// a bind "loopback" independently of what it actually bound would be able to
/// declare their way past the rule this module exists to enforce.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindScope {
    /// `127.0.0.0/8` or `::1`. Only this machine can reach the port.
    Loopback,
    /// Anything else, `0.0.0.0` and `::` included. **`0.0.0.0` is not
    /// loopback** — it is the wildcard, which binds every interface the host
    /// has, and `IpAddr::is_loopback` correctly answers `false` for it. That
    /// one line is the whole of why this enum can be derived rather than
    /// guessed.
    Exposed,
}

impl BindScope {
    pub fn of(address: &SocketAddr) -> Self {
        Self::of_ip(&address.ip())
    }

    pub fn of_ip(ip: &IpAddr) -> Self {
        if ip.is_loopback() {
            Self::Loopback
        } else {
            Self::Exposed
        }
    }

    pub fn is_loopback(self) -> bool {
        matches!(self, Self::Loopback)
    }
}

/// What the operator asked for, before the bind address has its say.
///
/// A three-armed enum rather than an `Option<bool>` because the interesting
/// arm carries a second fact: whether the operator confirmed an exposed bind.
/// An `Option<bool>` would have had to smuggle that in somewhere else, and
/// somewhere else is where a security rule goes to die.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ToolRequest {
    /// No flag given. The bind address decides — this is the arm that carries
    /// the whole policy, and the one every ordinary launch takes.
    #[default]
    Default,
    /// `--enable-tools`. On an exposed bind this is not enough on its own:
    /// `confirmed` is the reference's y/N prompt, and an unconfirmed force on
    /// an exposed bind resolves **off**, because failing closed is the only
    /// defensible answer to a question nobody answered.
    Enable { confirmed: bool },
    /// `--disable-tools`. Wins everywhere, including on loopback: a request to
    /// reduce authority is never second-guessed.
    Disable,
}

/// Why the policy resolved the way it did.
///
/// A closed set, carried so the host can *say* what happened at startup rather
/// than leaving an operator to infer from behaviour why their agent's tool
/// calls vanished. Enumerable and free of free text for the same reason
/// `ChatError` is: this string is written to a log the user may read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolPolicyReason {
    /// Loopback, no flag. Tools on.
    LoopbackDefault,
    /// Exposed, no flag. Tools off. The rule, doing its job.
    ExposedDefault,
    /// `--enable-tools` on loopback, or on an exposed bind with confirmation.
    Forced,
    /// `--enable-tools` on an exposed bind with no confirmation. Tools off.
    ExposedEnableUnconfirmed,
    /// `--disable-tools`.
    ForcedOff,
}

impl ToolPolicyReason {
    /// A stable, lowercase code. Not a sentence: the surface that shows this
    /// owns the wording, exactly as `Concern` and `RefusalReason` are handled.
    pub fn code(self) -> &'static str {
        match self {
            Self::LoopbackDefault => "loopback-default",
            Self::ExposedDefault => "exposed-default",
            Self::Forced => "forced-on",
            Self::ExposedEnableUnconfirmed => "exposed-enable-unconfirmed",
            Self::ForcedOff => "forced-off",
        }
    }
}

/// The resolved, process-level policy.
///
/// Constructed once, at bind time, from the address that was actually bound.
/// It is `Copy` and holds no interior mutability on purpose: a policy that
/// could be reassigned after the listener came up is a policy a later bug can
/// widen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolPolicy {
    scope: BindScope,
    tools: bool,
    reason: ToolPolicyReason,
}

impl ToolPolicy {
    /// **The rule.** Total over both inputs; no other constructor exists, so
    /// there is no way to reach a `ToolPolicy` that did not come through here.
    pub fn resolve(scope: BindScope, request: ToolRequest) -> Self {
        let (tools, reason) = match (scope, request) {
            (_, ToolRequest::Disable) => (false, ToolPolicyReason::ForcedOff),
            (BindScope::Loopback, ToolRequest::Default) => {
                (true, ToolPolicyReason::LoopbackDefault)
            }
            (BindScope::Exposed, ToolRequest::Default) => (false, ToolPolicyReason::ExposedDefault),
            (BindScope::Loopback, ToolRequest::Enable { .. }) => (true, ToolPolicyReason::Forced),
            (BindScope::Exposed, ToolRequest::Enable { confirmed: true }) => {
                (true, ToolPolicyReason::Forced)
            }
            (BindScope::Exposed, ToolRequest::Enable { confirmed: false }) => {
                (false, ToolPolicyReason::ExposedEnableUnconfirmed)
            }
        };
        Self {
            scope,
            tools,
            reason,
        }
    }

    /// Convenience for the ordinary case: resolve straight from the address the
    /// listener bound, so a caller cannot pass a scope that disagrees with it.
    pub fn for_address(address: &SocketAddr, request: ToolRequest) -> Self {
        Self::resolve(BindScope::of(address), request)
    }

    pub fn scope(&self) -> BindScope {
        self.scope
    }

    pub fn tools_enabled(&self) -> bool {
        self.tools
    }

    pub fn reason(&self) -> ToolPolicyReason {
        self.reason
    }

    /// **The choke point.** Every decoded request passes through this before a
    /// brain sees it, and this is the only place in the crate that reads or
    /// writes a request's tool fields.
    ///
    /// When tools are off it strips the catalogue *and* forces
    /// [`ToolChoice::None`] — see the module docs for why leaving `Required`
    /// standing would be worse than either half alone.
    ///
    /// When tools are on this is the identity function. It is still called, so
    /// that "did this request pass the policy" has one answer rather than two.
    pub fn enforce(&self, mut request: ChatRequest) -> ChatRequest {
        if !self.tools {
            request.tools.clear();
            request.tool_choice = ToolChoice::None;
        }
        request
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use vela_providers::model::ToolDefinition;

    fn addr(text: &str) -> SocketAddr {
        text.parse().expect("test address must parse")
    }

    #[test]
    fn loopback_addresses_are_loopback_and_the_wildcard_is_not() {
        assert_eq!(BindScope::of(&addr("127.0.0.1:8080")), BindScope::Loopback);
        assert_eq!(BindScope::of(&addr("127.0.0.53:8080")), BindScope::Loopback);
        assert_eq!(BindScope::of(&addr("[::1]:8080")), BindScope::Loopback);
        // The one that matters. `0.0.0.0` binds every interface the host has.
        assert_eq!(BindScope::of(&addr("0.0.0.0:8080")), BindScope::Exposed);
        assert_eq!(BindScope::of(&addr("[::]:8080")), BindScope::Exposed);
        assert_eq!(
            BindScope::of(&addr("192.168.1.10:8080")),
            BindScope::Exposed
        );
    }

    #[test]
    fn loopback_defaults_tools_on_and_an_exposed_bind_defaults_them_off() {
        let loopback = ToolPolicy::for_address(&addr("127.0.0.1:0"), ToolRequest::Default);
        assert!(loopback.tools_enabled());
        assert_eq!(loopback.reason(), ToolPolicyReason::LoopbackDefault);

        let exposed = ToolPolicy::for_address(&addr("0.0.0.0:0"), ToolRequest::Default);
        assert!(
            !exposed.tools_enabled(),
            "binding 0.0.0.0 with tools on is the defect this rule exists to stop"
        );
        assert_eq!(exposed.reason(), ToolPolicyReason::ExposedDefault);
    }

    #[test]
    fn forcing_tools_on_an_exposed_bind_fails_closed_until_it_is_confirmed() {
        let unconfirmed =
            ToolPolicy::for_address(&addr("0.0.0.0:0"), ToolRequest::Enable { confirmed: false });
        assert!(!unconfirmed.tools_enabled());
        assert_eq!(
            unconfirmed.reason(),
            ToolPolicyReason::ExposedEnableUnconfirmed
        );

        let confirmed =
            ToolPolicy::for_address(&addr("0.0.0.0:0"), ToolRequest::Enable { confirmed: true });
        assert!(confirmed.tools_enabled());
        assert_eq!(confirmed.reason(), ToolPolicyReason::Forced);
    }

    #[test]
    fn disabling_wins_everywhere_including_loopback() {
        for address in ["127.0.0.1:0", "0.0.0.0:0"] {
            let policy = ToolPolicy::for_address(&addr(address), ToolRequest::Disable);
            assert!(
                !policy.tools_enabled(),
                "{address} must honour --disable-tools"
            );
            assert_eq!(policy.reason(), ToolPolicyReason::ForcedOff);
        }
    }

    #[test]
    fn enforcement_strips_the_catalogue_and_the_choice_together() {
        let policy = ToolPolicy::for_address(&addr("0.0.0.0:0"), ToolRequest::Default);
        let request = ChatRequest::new("m")
            .with_tools([ToolDefinition::new("bash", "run a command", json!({}))])
            .with_tool_choice(ToolChoice::Required);

        let enforced = policy.enforce(request);
        assert!(enforced.tools.is_empty());
        assert_eq!(
            enforced.tool_choice,
            ToolChoice::None,
            "a stripped catalogue with a surviving Required asks for a tool that is not there"
        );
    }

    #[test]
    fn enforcement_is_the_identity_when_tools_are_on() {
        let policy = ToolPolicy::for_address(&addr("127.0.0.1:0"), ToolRequest::Default);
        let request = ChatRequest::new("m")
            .with_tools([ToolDefinition::new("bash", "run a command", json!({}))])
            .with_tool_choice(ToolChoice::Required);

        let enforced = policy.enforce(request.clone());
        assert_eq!(enforced, request);
    }
}
