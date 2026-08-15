//! # The Vela IPC bridge
//!
//! This module is the **entire** surface the renderer can reach. There is no
//! ambient filesystem, shell, network, or process access in the webview: Tauri
//! capabilities grant only window chrome and events (see
//! `src-tauri/capabilities/main.json`), and every other affordance must be an
//! explicit command registered here.
//!
//! ## The pattern — follow it exactly
//!
//! ```ignore
//! // 1. One request struct and one response struct per command, both
//! //    `#[serde(rename_all = "camelCase")]` so the TS types are natural.
//! #[derive(Deserialize)] #[serde(rename_all = "camelCase")]
//! pub struct ThingDoReq { pub thing_id: String }
//!
//! #[derive(Serialize)] #[serde(rename_all = "camelCase")]
//! pub struct ThingDoRes { pub done: bool }
//!
//! // 2. The logic lives in a plain function with no Tauri types, so it is
//! //    unit-testable headlessly.
//! pub fn do_thing(deps: &Deps, req: ThingDoReq) -> IpcResult<ThingDoRes> { .. }
//!
//! // 3. The `#[tauri::command]` is a THIN adapter. It takes exactly one
//! //    argument named `payload`. No other argument name is permitted.
//! #[tauri::command]
//! pub fn thing_do(state: State<'_, AppState>, payload: ThingDoReq)
//!     -> IpcResult<ThingDoRes> { do_thing(&state.deps, payload) }
//! ```
//!
//! ## Non-negotiable rules
//!
//! * **Naming:** `<domain>_<verb>`, snake_case, e.g. `secrets_set`. The domain
//!   prefix is mandatory so the allowlist stays readable as it grows.
//! * **One argument, always named `payload`.** The TS adapter wraps every call
//!   as `invoke(name, { payload })`, so a differently-named argument silently
//!   arrives as `undefined`. There is no exception to this rule, and
//!   `tests/handler_binding.rs::every_command_takes_exactly_one_argument_and_it_is_named_payload`
//!   is what makes that sentence true rather than aspirational.
//! * **Commands with no input still take a payload** (`EmptyPayload`) and
//!   commands with no output still return one ([`Ack`]). Never `()`.
//! * **Register in [`COMMAND_ALLOWLIST`] and in `generate_handler!`.** Those
//!   are two different things: the allowlist is the declaration, and
//!   `generate_handler!` in `lib.rs` is the dispatch table the packaged binary
//!   actually consults. `tests/handler_binding.rs` drives the assembled app and
//!   fails if either list has an entry the other lacks;
//!   [`tests::rust_and_typescript_allowlists_are_identical`] below covers the
//!   TypeScript `COMMAND_ALLOWLIST` in `src/platform/contract.ts`. Adding a
//!   command in one place only will fail `cargo test` — which was not true
//!   before `tests/handler_binding.rs`, though this file said it was.
//! * **Secret values move in one direction only.** There is no command that
//!   returns secret material, and adding one is a review-blocking change. The
//!   part of that a machine holds is
//!   [`tests::a_secret_value_cannot_be_serialised_into_any_response`]:
//!   `vela_core::secret::SecretValue` has no `Serialize` impl, so a command
//!   returning one does not compile. The part a machine cannot hold is a
//!   command that calls `expose` and returns a `String`; the name check in
//!   [`tests::no_command_returns_secret_material`] is the second line there,
//!   and review is the first.

pub mod app;
pub mod chat;
pub mod content;
pub mod diagnostics;
pub mod endpoint;
pub mod error;
pub mod mcp;
pub mod memory;
pub mod models;
pub mod project;
pub mod sandbox;
pub mod schedules;
pub mod secrets;
pub mod settings;
pub mod skills;
pub mod store;
pub mod transcript;
pub mod ui;

use serde::{Deserialize, Serialize};

pub use error::{IpcError, IpcErrorCode, IpcResult};

/// Version of the request/response contract. Bump on any breaking change and
/// mirror it in `src/platform/contract.ts`; the renderer refuses to talk to a
/// host advertising a different major version.
pub const IPC_CONTRACT_VERSION: u32 = 1;

/// The explicit allowlist. **This is the security boundary** — the reviewed,
/// declared statement of what the renderer may reach.
///
/// It is not, on its own, what makes a command reachable: `generate_handler!`
/// in `lib.rs` is. `tests/handler_binding.rs` binds the two together by
/// invoking every name here against the real assembled `invoke_handler`, so an
/// entry added here and nowhere else fails as loudly as it deserves instead of
/// shipping as a command that answers `not found`.
///
/// Keep alphabetically sorted; the parity test depends on set equality, not
/// order, but sorted order keeps diffs honest.
pub const COMMAND_ALLOWLIST: &[&str] = &[
    "app_info",
    "chat_cancel",
    "chat_send",
    "diagnostics_debug_log_get",
    "diagnostics_debug_log_set",
    "diagnostics_echo",
    "endpoint_disable",
    "endpoint_enable",
    "endpoint_status",
    "mcp_list_tools",
    "memory_add",
    "memory_clear_scope",
    "memory_delete",
    "memory_list",
    "memory_update",
    "models_capabilities",
    "models_list",
    "models_probe",
    "project_create",
    "project_delete",
    "project_get",
    "project_layout",
    "project_list",
    "project_move_conversation",
    "project_reconcile_skills",
    "project_update",
    "sandbox_approve",
    "sandbox_cancel",
    "sandbox_policy",
    "sandbox_release",
    "sandbox_report_document",
    "sandbox_submit",
    "schedules_create",
    "schedules_delete",
    "schedules_list",
    "schedules_list_runs",
    "schedules_set_enabled",
    "secrets_delete",
    "secrets_set",
    "secrets_status",
    "settings_delete_provider",
    "settings_get",
    "settings_put_provider",
    "settings_set_theme",
    "skills_list",
    "skills_read",
    "store_append_message",
    "store_autotitle_conversation",
    "store_create_conversation",
    "store_delete_conversation",
    "store_delete_message",
    "store_list_conversations",
    "store_list_messages",
    "store_rename_conversation",
    "store_search",
    "store_update_message",
    "ui_get_layout",
    "ui_set_layout",
];

/// Payload type for commands that take no input. Present so that *every*
/// command has the same call shape.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct EmptyPayload {}

/// Response type for commands that return no data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ack {
    pub ok: bool,
}

impl Ack {
    pub fn ok() -> Self {
        Self { ok: true }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// Reads the TypeScript contract and extracts its `COMMAND_ALLOWLIST`.
    /// A dumb string scan on purpose: no TS toolchain is available inside
    /// `cargo test`, and a parser here would be more code than the thing it
    /// checks.
    fn typescript_allowlist() -> BTreeSet<String> {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/platform/contract.ts");
        let source = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("cannot read the TS contract at {path}: {e}"));

        let marker = "export const COMMAND_ALLOWLIST";
        let start = source
            .find(marker)
            .expect("src/platform/contract.ts must export COMMAND_ALLOWLIST");
        let open = source[start..]
            .find('[')
            .expect("COMMAND_ALLOWLIST must be an array literal")
            + start;
        let close = source[open..]
            .find(']')
            .expect("COMMAND_ALLOWLIST array is unterminated")
            + open;

        source[open + 1..close]
            .split(',')
            .map(|entry| entry.trim().trim_matches(['\'', '"', '\n', ' ']).to_owned())
            .filter(|entry| !entry.is_empty())
            .collect()
    }

    #[test]
    fn rust_and_typescript_allowlists_are_identical() {
        let rust: BTreeSet<String> = COMMAND_ALLOWLIST.iter().map(|s| s.to_string()).collect();
        let typescript = typescript_allowlist();
        assert_eq!(
            rust, typescript,
            "the Rust COMMAND_ALLOWLIST and src/platform/contract.ts have drifted apart; \
             a command must be added to both or it is either unreachable or untyped"
        );
    }

    #[test]
    fn allowlist_is_sorted_and_has_no_duplicates() {
        let mut sorted = COMMAND_ALLOWLIST.to_vec();
        sorted.sort_unstable();
        assert_eq!(COMMAND_ALLOWLIST, sorted.as_slice());
        let unique: BTreeSet<_> = COMMAND_ALLOWLIST.iter().collect();
        assert_eq!(unique.len(), COMMAND_ALLOWLIST.len());
    }

    /// Verbs that would make a `secrets_*` command a **read**.
    ///
    /// Written down rather than derived, because the rule is about intent and a
    /// reviewer has to be able to check it by reading. Absent on purpose:
    /// "set", "delete" and "status", which are the three commands that exist,
    /// and which the control in [`no_command_returns_secret_material`] pins so
    /// this list cannot pass by forbidding the whole domain.
    const SECRET_READ_VERBS: &[&str] =
        &["get", "read", "reveal", "export", "show", "fetch", "dump"];

    /// Whether a type implements [`Serialize`], answered by the compiler.
    ///
    /// Rust has no negative trait bounds, so this is the ordinary
    /// inherent-beats-trait method resolution: the inherent `is_serialize` on
    /// `Probe<T>` exists only where `T: Serialize`, and where that bound does
    /// not hold the inherent candidate is rejected and lookup finds the blanket
    /// trait method, which answers `false`.
    mod serialize_probe {
        use std::marker::PhantomData;

        pub struct Probe<T>(pub PhantomData<T>);

        pub trait NotSerialize {
            fn is_serialize(&self) -> bool {
                false
            }
        }

        impl<T> NotSerialize for Probe<T> {}

        impl<T: serde::Serialize> Probe<T> {
            pub fn is_serialize(&self) -> bool {
                true
            }
        }
    }

    #[test]
    fn a_secret_value_cannot_be_serialised_into_any_response() {
        // **This is the real guard behind the one-way rule**, and it is a type
        // rather than a list. `vela_core::secret::SecretValue` derives
        // `Deserialize` — a credential has to arrive from somewhere — and
        // deliberately not `Serialize`. Every `#[tauri::command]` return type
        // must be serialisable, so a command answering with a `SecretValue`, or
        // with any struct holding one, does not compile. No allowlist edit can
        // reach past that.
        use serialize_probe::{NotSerialize as _, Probe};
        use std::marker::PhantomData;
        use vela_core::secret::SecretValue;

        // The control, and the only reason the line below means anything: a
        // probe that could not see `Serialize` at all would answer `false` for
        // every type on earth. `SecretsStatusRes` is a real command response and
        // must come back `true`.
        assert!(
            Probe::<secrets::SecretsStatusRes>(PhantomData).is_serialize(),
            "the probe cannot detect a `Serialize` impl, so its verdict below is worthless"
        );

        assert!(
            !Probe::<SecretValue>(PhantomData).is_serialize(),
            "`SecretValue` has gained a `Serialize` impl; a credential can now be \
             returned from a command, and nothing else in this file would notice"
        );
    }

    #[test]
    fn no_command_returns_secret_material() {
        // The **second** line, not the first. The comment here used to call a
        // single `contains(&"secrets_get")` a structural guard for the one-way
        // rule; it was one string, and a name like "secrets_reveal" walked past
        // it. What actually forbids a credential-carrying response is the type,
        // in [`a_secret_value_cannot_be_serialised_into_any_response`] above.
        //
        // This still earns its place, because that type is not the whole rule.
        // `SecretValue::expose` hands out a `&str`, so a command that copied the
        // credential into a `String` and returned that would compile perfectly
        // well. Nothing here can see that. What it can see is the name such a
        // command would have to be given, and a name is what a reviewer reads
        // first.
        assert!(
            !COMMAND_ALLOWLIST.contains(&"secrets_get"),
            "secret values must never cross the IPC boundary toward the renderer"
        );

        for name in COMMAND_ALLOWLIST {
            let Some(verb) = name.strip_prefix("secrets_") else {
                continue;
            };
            let head = verb.split('_').next().unwrap_or(verb);
            assert!(
                !SECRET_READ_VERBS.contains(&head),
                "`{name}` reads secret material; the renderer may write, delete \
                 and ask whether one exists, never read"
            );
        }

        // The control. The loop above is also satisfied by a `secrets_` domain
        // with nothing in it, which is a different and much weaker claim.
        for name in ["secrets_set", "secrets_delete", "secrets_status"] {
            assert!(
                COMMAND_ALLOWLIST.contains(&name),
                "`{name}` is gone, so the loop above ranged over nothing"
            );
        }
    }

    #[test]
    fn every_command_is_domain_prefixed() {
        for name in COMMAND_ALLOWLIST {
            assert!(name.contains('_'), "`{name}` must be named <domain>_<verb>");
            assert_eq!(name.to_lowercase(), **name, "`{name}` must be snake_case");
        }
    }
}
