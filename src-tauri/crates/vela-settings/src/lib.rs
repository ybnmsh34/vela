//! # vela-settings
//!
//! Typed user configuration: appearance, privacy, and the list of model
//! backends the user has set up.
//!
//! ## The split this crate exists to enforce
//!
//! ```text
//!            ┌──────────────────────────── SettingsService ───────────────────────────┐
//!            │                                                                        │
//!  describable configuration                                        credential values
//!            │                                                                        │
//!            ▼                                                                        ▼
//!   vela-store (SQLite on disk)                                vela-secrets (OS keychain)
//!   provider.config.<id> → { id, baseUrl, auth: {…ref…} }        <providerId>/<field> → value
//! ```
//!
//! The database holds a *pointer* — `<providerId>/<field>` — and the keychain
//! holds the value. No column, and no field of any type in this crate, can hold
//! a credential. `tests/no_plaintext_on_disk.rs` proves it against a real
//! SQLite file by searching its bytes.
//!
//! ## Invariants
//!
//! 1. **A backend with no authentication is a first-class configuration.**
//!    [`Auth::None`](vela_core::credential::Auth::None) is the default,
//!    [`ProviderConfig::local`] is the shortest constructor here, and a local
//!    provider is `usable` with a completely empty keychain. Nothing in this
//!    crate treats an absent credential as an error unless the provider itself
//!    declared [`AuthRequirement::Required`](vela_core::auth::AuthRequirement).
//! 2. **Risk is surfaced, not hidden.** [`SecurityPosture`] computes what an
//!    endpoint choice actually exposes — and says nothing at all about the
//!    normal loopback case, so that when it does speak the user listens.
//! 3. **Telemetry is off and cannot be switched on.** See [`telemetry`].
//! 4. **Nothing here is provider-specific.** No vendor names, no per-provider
//!    branches. Adding a backend is data, not code.

pub mod appearance;
pub mod endpoint;
pub mod error;
pub mod keys;
pub mod provider_config;
pub mod security;
pub mod service;
pub mod telemetry;
pub mod view;

pub use appearance::ThemePreference;
pub use endpoint::{EndpointUrl, NetworkScope};
pub use error::{SettingsError, SettingsResult};
pub use provider_config::ProviderConfig;
pub use security::{Concern, RiskLevel, SecurityPosture};
pub use service::SettingsService;
pub use telemetry::{ExplicitConsent, Telemetry, CONSENT_STATEMENT};
pub use view::{ProviderView, SettingsSnapshot};
