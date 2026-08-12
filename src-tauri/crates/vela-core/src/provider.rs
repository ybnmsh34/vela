//! The provider *descriptor* — the only shape of a provider the UI is ever
//! allowed to see.
//!
//! # THE LOAD-BEARING RULE OF THIS FILE
//!
//! No provider-specific detail may leak into UI code. The UI must never branch
//! on `if (provider.id === "ollama")`. It branches on **capability flags**
//! instead:
//!
//! ```ignore
//! if (provider.capabilities.vision) { showImageAttachButton() }
//! ```
//!
//! Adding a new provider must require **zero** changes under `src/` in the
//! frontend. If a new provider forces a UI change, the missing thing is a
//! capability flag, not a special case.

use serde::{Deserialize, Serialize};

use crate::auth::AuthPolicy;
use crate::error::{CoreError, CoreResult};

/// What kind of thing is on the other end. Used for grouping/iconography only —
/// never for behaviour. Behaviour comes from [`ProviderCapabilities`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderKind {
    /// Runs on the user's machine. No account, usually no auth.
    Local,
    /// A remote API addressed with the user's own key.
    RemoteApi,
    /// A remote account/subscription-backed endpoint.
    RemoteSubscription,
}

/// Feature flags. **This is the entire vocabulary the UI has for talking about
/// what a model can do.** Extend this enum-of-bools rather than special-casing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    /// Token-by-token streaming responses.
    pub streaming: bool,
    /// Image input.
    pub vision: bool,
    /// Native structured tool/function calling.
    pub tool_calls: bool,
    /// Emits a separate reasoning/thinking channel.
    pub reasoning: bool,
    /// Server can enumerate the models it holds.
    pub model_listing: bool,
    /// Reports token usage per response.
    pub usage_reporting: bool,
    /// Server-side prompt caching.
    pub prompt_caching: bool,
}

impl ProviderCapabilities {
    /// The pessimistic floor. Unknown endpoints start here and are upgraded by
    /// probing, never assumed. A provider that supports nothing but plain
    /// non-streaming completion must still be fully usable.
    pub fn minimal() -> Self {
        Self::default()
    }
}

/// Everything the UI knows about a provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDescriptor {
    /// Stable machine id, e.g. `local-llamacpp`. Never rendered to the user.
    pub id: String,
    /// User-facing name. Rendered as-is; may be user-edited.
    pub display_name: String,
    pub kind: ProviderKind,
    pub auth: AuthPolicy,
    pub capabilities: ProviderCapabilities,
}

impl ProviderDescriptor {
    pub fn new(
        id: impl Into<String>,
        display_name: impl Into<String>,
        kind: ProviderKind,
    ) -> CoreResult<Self> {
        let id = id.into();
        if id.trim().is_empty() {
            return Err(CoreError::Invalid {
                field: "id".into(),
                reason: "provider id must not be empty".into(),
            });
        }
        Ok(Self {
            id,
            display_name: display_name.into(),
            kind,
            auth: AuthPolicy::none(),
            capabilities: ProviderCapabilities::minimal(),
        })
    }

    pub fn with_auth(mut self, auth: AuthPolicy) -> Self {
        self.auth = auth;
        self
    }

    pub fn with_capabilities(mut self, capabilities: ProviderCapabilities) -> Self {
        self.capabilities = capabilities;
        self
    }

    /// Is this provider usable right now, given whether a credential is stored?
    /// Delegates to [`AuthPolicy::check`] so the no-auth rule holds everywhere.
    pub fn is_usable(&self, credential_present: bool) -> bool {
        self.auth.check(credential_present).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::{AuthMode, CredentialCheck};

    #[test]
    fn a_local_provider_with_no_key_is_usable() {
        let p = ProviderDescriptor::new("local-llamacpp", "llama.cpp (local)", ProviderKind::Local)
            .unwrap();
        assert!(
            p.is_usable(false),
            "an unauthenticated local endpoint must be usable with no credential"
        );
        assert_eq!(
            p.auth.check(false),
            CredentialCheck::SatisfiedWithoutCredential
        );
    }

    #[test]
    fn a_remote_provider_requiring_a_key_is_not_usable_without_one() {
        let p = ProviderDescriptor::new("remote", "Remote API", ProviderKind::RemoteApi)
            .unwrap()
            .with_auth(AuthPolicy::required(AuthMode::BearerToken));
        assert!(!p.is_usable(false));
        assert!(p.is_usable(true));
    }

    #[test]
    fn descriptors_default_to_the_pessimistic_capability_floor() {
        let p = ProviderDescriptor::new("x", "X", ProviderKind::Local).unwrap();
        assert_eq!(p.capabilities, ProviderCapabilities::minimal());
        assert!(!p.capabilities.streaming);
        assert!(!p.capabilities.tool_calls);
    }

    #[test]
    fn descriptor_json_is_camel_case_for_the_renderer() {
        let p = ProviderDescriptor::new("x", "X", ProviderKind::Local).unwrap();
        let json = serde_json::to_value(&p).unwrap();
        assert!(json.get("displayName").is_some());
        assert!(json["capabilities"].get("toolCalls").is_some());
    }
}
