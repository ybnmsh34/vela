//! # vela-core
//!
//! The Vela domain model. This crate has **no dependency on Tauri, on any HTTP
//! client, or on any concrete model provider**. It is pure data + pure logic, so
//! every rule in it is unit-testable headlessly with `cargo test`.
//!
//! Invariants this crate exists to protect:
//!
//! 1. **"No credential" is a first-class, valid provider state.** Many local
//!    inference endpoints (llama.cpp, Ollama, LM Studio, vLLM) have no auth at
//!    all. Absence of a credential must never surface as an error or a failed
//!    validation. See [`auth`].
//! 2. **No provider-specific detail may leak toward the UI.** The UI only ever
//!    sees a [`provider::ProviderDescriptor`] and a
//!    [`provider::ProviderCapabilities`] flag set. See [`provider`].
//! 3. **Secret *values* never travel toward the renderer.** Only opaque
//!    [`secret::SecretRef`] handles and presence booleans do. See [`secret`].

pub mod auth;
pub mod error;
pub mod provider;
pub mod secret;

pub use error::{CoreError, CoreResult};
