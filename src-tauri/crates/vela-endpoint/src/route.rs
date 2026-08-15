//! One port, two dialects, routed by path — and one shared bearer key.
//!
//! `docs/references/unsloth-studio.md` §1 records the shape verbatim: "You
//! don't need to run different servers for the two formats. Unsloth handles
//! both on the same port," and "Authenticate with an `Authorization: Bearer
//! sk-unsloth-…` header on every request." Both dialects, one key, one
//! listener.
//!
//! Nothing above this module knows there are two dialects. The server reads a
//! path, gets an [`Endpoint`], and asks that endpoint to decode and to encode.
//! That is what keeps "add a third dialect" a change to this file plus one
//! wire module, rather than a change everywhere.

use vela_providers::model::StopReason;

/// Which wire vocabulary a request and its response speak.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    /// `/v1/messages` — Claude Code, the Anthropic SDK, anything speaking the
    /// Messages API.
    Anthropic,
    /// `/v1/chat/completions` — the OpenAI SDK and the long tail of tools that
    /// speak it.
    OpenAi,
}

/// A path this endpoint answers.
///
/// `Option<Endpoint>` from [`resolve`] rather than a `NotFound` arm: "this path
/// is not ours" is the absence of a route, and giving it an arm invites a
/// `match` somewhere to treat it as a kind of route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Endpoint {
    AnthropicMessages,
    OpenAiChatCompletions,
    /// **Routed and not implemented.** The track names `/v1/responses` and this
    /// crate does not serve it: the Responses API is a different request and
    /// response shape, not a rename of chat completions, and shipping a
    /// half-translation of it would be worse than shipping none.
    ///
    /// It is routed anyway, to `501`, because the alternative is `404` — and a
    /// `404` from a base URL is exactly what a client shows when the operator
    /// got the `/v1` suffix wrong. Answering `501` says "your base URL is
    /// right, this path is not built", which is the true statement.
    OpenAiResponses,
    /// `GET /v1/models`. The first call almost every OpenAI-compatible client
    /// makes; without it a client reports the endpoint as broken before it ever
    /// sends a turn.
    Models,
}

impl Endpoint {
    /// The one method this path answers. A mismatch is `405`, not `404`: the
    /// path exists.
    pub fn method(self) -> &'static str {
        match self {
            Self::Models => "GET",
            Self::AnthropicMessages | Self::OpenAiChatCompletions | Self::OpenAiResponses => "POST",
        }
    }

    /// Which vocabulary an error body must be written in, so a client's own
    /// error parser can read it. `Models` is served in the OpenAI shape because
    /// the path is OpenAI's.
    pub fn dialect(self) -> Dialect {
        match self {
            Self::AnthropicMessages => Dialect::Anthropic,
            Self::OpenAiChatCompletions | Self::OpenAiResponses | Self::Models => Dialect::OpenAi,
        }
    }
}

/// Path → endpoint. Query string and trailing slash tolerated; nothing else is.
///
/// Deliberately not a prefix match. A prefix match would route
/// `/v1/messages/anything` here and answer it, which turns a client's typo into
/// a successful turn against a path that does not exist.
pub fn resolve(path: &str) -> Option<Endpoint> {
    let path = path.split('?').next().unwrap_or(path);
    let path = path.strip_suffix('/').unwrap_or(path);
    match path {
        "/v1/messages" => Some(Endpoint::AnthropicMessages),
        "/v1/chat/completions" => Some(Endpoint::OpenAiChatCompletions),
        "/v1/responses" => Some(Endpoint::OpenAiResponses),
        "/v1/models" => Some(Endpoint::Models),
        _ => None,
    }
}

/// Whether the caller presented the one key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthOutcome {
    Ok,
    /// No `Authorization` header, or one that is not a `Bearer`, or a bearer
    /// value that is not the key. **One arm for all three**, because the reply
    /// is `401` either way and a caller that could tell "wrong key" from "no
    /// key" apart has been handed an oracle.
    Rejected,
}

/// Compares the presented bearer against the configured key.
///
/// The comparison is fixed-time in the length-equal case and does not
/// short-circuit on the first differing byte. This is a loopback endpoint and
/// the threat is not realistic — but a `==` here would be the kind of thing
/// that stays after the endpoint stops being loopback-only, and the constant
/// form costs four lines.
///
/// Only `Authorization: Bearer <key>` is accepted, for both dialects. The study
/// confirms that header literally for both, and it is what the reference's own
/// Claude Code setup produces (`ANTHROPIC_AUTH_TOKEN` set, `ANTHROPIC_API_KEY`
/// empty). `x-api-key` — what the Anthropic SDK sends when it has an API key
/// rather than an auth token — is **not** accepted, because accepting a second
/// credential header is a second way in and the study documents only one.
pub fn authenticate(authorization: Option<&str>, key: &str) -> AuthOutcome {
    let Some(header) = authorization else {
        return AuthOutcome::Rejected;
    };
    let Some(presented) = strip_bearer(header) else {
        return AuthOutcome::Rejected;
    };
    if constant_time_eq(presented.as_bytes(), key.as_bytes()) {
        AuthOutcome::Ok
    } else {
        AuthOutcome::Rejected
    }
}

fn strip_bearer(header: &str) -> Option<&str> {
    let header = header.trim();
    let (scheme, rest) = header.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("Bearer") {
        return None;
    }
    let token = rest.trim();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        difference |= a ^ b;
    }
    difference == 0
}

/// **The base_url asymmetry, shipped as a function rather than as documentation
/// prose.**
///
/// The rule, from `docs/references/unsloth-studio.md` §4:
///
///  - **Anthropic: bare origin, no `/v1`.** The study confirms this literally:
///    the reference's own Claude Code guide sets
///    `ANTHROPIC_BASE_URL="http://localhost:8888"`, with no suffix, because the
///    Anthropic SDK appends the whole path itself.
///  - **OpenAI: the origin plus `/v1`.** The study marks this half
///    **UNVERIFIED** for a multiplexed port. What it confirms is the same rule
///    against a *different* tutorial's standalone server on port 8001
///    (`base_url = "http://127.0.0.1:8001/v1"`), and reasons that the same
///    convention must apply because the OpenAI SDK does not append `/v1`
///    itself. **This crate assumes that reasoning holds**, and the assumption
///    is testable rather than merely stated: the OpenAI paths this crate
///    actually serves ([`Endpoint`]) all begin `/v1/`, so an OpenAI SDK given a
///    bare origin would request `/chat/completions` and get a `404`. The test
///    below is what ties the two together, so the day a path here stops
///    starting with `/v1` the assumption fails loudly instead of silently.
///
/// `origin` is `scheme://host:port` with no trailing slash.
pub fn client_base_url(dialect: Dialect, origin: &str) -> String {
    let origin = origin.trim_end_matches('/');
    match dialect {
        Dialect::Anthropic => origin.to_string(),
        Dialect::OpenAi => format!("{origin}/v1"),
    }
}

/// Vela's stop reason in OpenAI's `finish_reason` vocabulary.
///
/// `Unspecified` becomes `"stop"`, and that is a **substitution**: the endpoint
/// told Vela nothing and this tells the client "end of turn". It is recorded
/// here rather than hidden because the alternative — `null` — is legal in a
/// streamed chunk and is not what clients accept on the terminal one, and
/// because a caller reading this function deserves to know one of its five arms
/// is a guess. `Cancelled` maps the same way and for the same reason.
pub fn openai_finish_reason(stop: StopReason) -> &'static str {
    match stop {
        StopReason::EndTurn => "stop",
        StopReason::MaxTokens => "length",
        StopReason::ToolUse => "tool_calls",
        StopReason::Cancelled | StopReason::Unspecified => "stop",
    }
}

/// Vela's stop reason in Anthropic's `stop_reason` vocabulary.
pub fn anthropic_stop_reason(stop: StopReason) -> &'static str {
    match stop {
        StopReason::EndTurn => "end_turn",
        StopReason::MaxTokens => "max_tokens",
        StopReason::ToolUse => "tool_use",
        StopReason::Cancelled | StopReason::Unspecified => "end_turn",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_dialects_are_reachable_on_the_same_port_by_path_alone() {
        assert_eq!(resolve("/v1/messages"), Some(Endpoint::AnthropicMessages));
        assert_eq!(
            resolve("/v1/chat/completions"),
            Some(Endpoint::OpenAiChatCompletions)
        );
        assert_eq!(
            resolve("/v1/messages").map(Endpoint::dialect),
            Some(Dialect::Anthropic)
        );
        assert_eq!(
            resolve("/v1/chat/completions").map(Endpoint::dialect),
            Some(Dialect::OpenAi)
        );
    }

    #[test]
    fn a_query_string_or_a_trailing_slash_does_not_hide_a_route() {
        assert_eq!(resolve("/v1/models?x=1"), Some(Endpoint::Models));
        assert_eq!(resolve("/v1/messages/"), Some(Endpoint::AnthropicMessages));
    }

    #[test]
    fn nothing_below_a_known_path_is_routed_to_it() {
        assert_eq!(resolve("/v1/messages/extra"), None);
        assert_eq!(resolve("/messages"), None);
        assert_eq!(resolve("/"), None);
    }

    #[test]
    fn only_the_configured_bearer_is_accepted() {
        assert_eq!(
            authenticate(Some("Bearer sk-vela-1"), "sk-vela-1"),
            AuthOutcome::Ok
        );
        assert_eq!(
            authenticate(Some("bearer sk-vela-1"), "sk-vela-1"),
            AuthOutcome::Ok
        );
        assert_eq!(
            authenticate(Some("Bearer sk-vela-2"), "sk-vela-1"),
            AuthOutcome::Rejected
        );
        assert_eq!(authenticate(None, "sk-vela-1"), AuthOutcome::Rejected);
        assert_eq!(
            authenticate(Some("Bearer "), "sk-vela-1"),
            AuthOutcome::Rejected
        );
        assert_eq!(
            authenticate(Some("sk-vela-1"), "sk-vela-1"),
            AuthOutcome::Rejected
        );
        assert_eq!(
            authenticate(Some("Basic sk-vela-1"), "sk-vela-1"),
            AuthOutcome::Rejected
        );
    }

    #[test]
    fn the_anthropic_sdk_key_header_is_not_a_second_way_in() {
        // `x-api-key` is what the Anthropic SDK sends when configured with an
        // API key. This endpoint documents one credential header; a request
        // that presents only the other one is rejected.
        assert_eq!(authenticate(None, "sk-vela-1"), AuthOutcome::Rejected);
    }

    #[test]
    fn the_base_url_a_client_is_given_is_asymmetric_between_the_dialects() {
        assert_eq!(
            client_base_url(Dialect::Anthropic, "http://127.0.0.1:8033"),
            "http://127.0.0.1:8033"
        );
        assert_eq!(
            client_base_url(Dialect::OpenAi, "http://127.0.0.1:8033"),
            "http://127.0.0.1:8033/v1"
        );
        assert_eq!(
            client_base_url(Dialect::Anthropic, "http://127.0.0.1:8033/"),
            "http://127.0.0.1:8033",
            "a trailing slash must not become part of the Anthropic base URL"
        );
    }

    #[test]
    fn the_openai_base_url_suffix_matches_the_paths_this_crate_actually_serves() {
        // The assumption named in `client_base_url`'s doc, made falsifiable.
        // Every OpenAI-dialect path here begins `/v1/`, so the `/v1` this
        // function appends is exactly what turns the SDK's relative path into a
        // path this server routes.
        let base = client_base_url(Dialect::OpenAi, "http://host:1");
        for (endpoint, sdk_relative_path) in [
            (Endpoint::OpenAiChatCompletions, "/chat/completions"),
            (Endpoint::Models, "/models"),
        ] {
            let requested = format!("{base}{sdk_relative_path}");
            let path = requested
                .strip_prefix("http://host:1")
                .expect("test constructed the origin");
            assert_eq!(
                resolve(path),
                Some(endpoint),
                "an OpenAI SDK pointed at {base} must reach {endpoint:?}"
            );
        }
        // And the other half: a bare origin does not reach them, which is the
        // failure the asymmetry exists to warn about.
        assert_eq!(resolve("/chat/completions"), None);
    }

    #[test]
    fn responses_is_routed_rather_than_missing_so_a_404_still_means_a_wrong_base_url() {
        assert_eq!(resolve("/v1/responses"), Some(Endpoint::OpenAiResponses));
    }

    #[test]
    fn stop_reasons_translate_into_each_dialects_own_vocabulary() {
        assert_eq!(openai_finish_reason(StopReason::ToolUse), "tool_calls");
        assert_eq!(openai_finish_reason(StopReason::MaxTokens), "length");
        assert_eq!(anthropic_stop_reason(StopReason::ToolUse), "tool_use");
        assert_eq!(anthropic_stop_reason(StopReason::MaxTokens), "max_tokens");
    }
}
