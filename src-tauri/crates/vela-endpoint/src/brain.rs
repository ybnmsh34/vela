//! What sits behind the port.
//!
//! ## Why this is a trait and not `Arc<dyn Provider>`
//!
//! `vela_providers::Provider` has four methods, two of which (`list_models`,
//! `probe_capabilities`) are network calls this endpoint never makes, and all
//! of which are `async` — which would drag an async runtime into a crate whose
//! listener is three `std::net` types and a thread. The host has a runtime
//! (`tauri::async_runtime`) and is the right place to bridge to it.
//!
//! So the seam is narrow and blocking: give me the models you can name, and
//! stream me one turn. An implementation over a real `Provider` is a dozen
//! lines in the host; an implementation for a test is a closure
//! ([`FnBrain`]). That is the same argument `contract-harness.ts` makes for
//! `TurnDriver` being three functions rather than a `PlatformAdapter` — a
//! narrow surface is testable and cannot be misused.
//!
//! **Blocking is correct here, not a compromise.** One connection is one
//! thread; the thread has nothing else to do while the model answers, and the
//! `EventSink` it passes writes each frame to the socket as it arrives. There
//! is no concurrency for an async runtime to buy.

use vela_providers::model::{ChatRequest, ChatResponse};
use vela_providers::{EventSink, ProviderError};

/// The configured brain, as this crate needs to see it.
pub trait Brain: Send + Sync {
    /// What `GET /v1/models` answers. May be empty — a client that gets an
    /// empty list and sends a turn anyway is served normally, because the model
    /// id that matters is the one on the request.
    fn models(&self) -> Vec<String>;

    /// Drive one turn, emitting into `sink` as it goes.
    ///
    /// Blocking. Returns the assembled response, or the provider's own error
    /// unchanged — this crate reduces it to a code at the wire
    /// ([`crate::error_code`]) and not before, so a host that wants the full
    /// `Diagnosis` for its own log still has it.
    fn stream(
        &self,
        request: ChatRequest,
        sink: &mut dyn EventSink,
    ) -> Result<ChatResponse, ProviderError>;
}

/// A brain built from a closure. For tests, and for a host that wants to serve
/// something other than a `Provider`.
pub struct FnBrain<F> {
    models: Vec<String>,
    turn: F,
}

impl<F> FnBrain<F>
where
    F: Fn(ChatRequest, &mut dyn EventSink) -> Result<ChatResponse, ProviderError> + Send + Sync,
{
    pub fn new(models: Vec<String>, turn: F) -> Self {
        Self { models, turn }
    }
}

impl<F> Brain for FnBrain<F>
where
    F: Fn(ChatRequest, &mut dyn EventSink) -> Result<ChatResponse, ProviderError> + Send + Sync,
{
    fn models(&self) -> Vec<String> {
        self.models.clone()
    }

    fn stream(
        &self,
        request: ChatRequest,
        sink: &mut dyn EventSink,
    ) -> Result<ChatResponse, ProviderError> {
        (self.turn)(request, sink)
    }
}
