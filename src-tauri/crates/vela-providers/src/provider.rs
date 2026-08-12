//! The provider trait, and the context every call carries.
//!
//! # For the adapter builders
//!
//! Implement [`Provider`]. Four methods, and only [`Provider::stream`] is
//! mandatory — the non-streaming path has a default implementation that drives
//! the streaming one into a collector, so a backend cannot end up with two
//! implementations that disagree.
//!
//! Rules that are not negotiable, because a test enforces each one:
//!
//! * Start at [`ModelCapabilities::unknown`](crate::capability::ModelCapabilities::unknown)
//!   and raise a flag only on evidence from a probe.
//! * Every error you return is a [`ProviderError`]; never invent a second
//!   taxonomy and never let an HTTP status escape.
//! * Honour `context.cancel` between reads, and honour
//!   `context.timeouts.stall` on every read.
//! * Never touch the OS keychain. Take a `&dyn SecretStore` and let
//!   `vela_secrets::resolve_auth` turn an `Auth` binding into request material:
//!   it is the function that guarantees `Auth::None` sends **no**
//!   `Authorization` header rather than an empty one.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;
use vela_core::provider::ProviderDescriptor;

use crate::capability::ModelCapabilities;
use crate::error::{ProviderError, ProviderResult};
use crate::event::{CollectingSink, EventSink, StreamEvent};
use crate::model::{ChatRequest, ChatResponse};

/// A model the endpoint says it has.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub display_name: String,
    /// `None` when the endpoint does not report it. Never guess a number.
    pub context_window: Option<u32>,
}

/// Cooperative cancellation.
///
/// Checked between stream reads and before every retry, so a cancelled turn
/// stops promptly without the provider having to unwind a runtime task.
#[derive(Debug, Clone, Default)]
pub struct CancelToken {
    inner: Arc<CancelInner>,
}

#[derive(Debug, Default)]
struct CancelInner {
    cancelled: AtomicBool,
    notify: Notify,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.inner.cancelled.store(true, Ordering::SeqCst);
        self.inner.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    /// Resolves when cancelled. Used with `tokio::select!` so a read in flight
    /// is abandoned rather than awaited to completion.
    pub async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        let notified = self.inner.notify.notified();
        if self.is_cancelled() {
            return;
        }
        notified.await;
    }

    pub fn err_if_cancelled(&self) -> ProviderResult<()> {
        if self.is_cancelled() {
            return Err(ProviderError::Cancelled);
        }
        Ok(())
    }
}

/// Deadlines.
///
/// `stall` is the one MEASURED-1 makes mandatory: it bounds the gap *between
/// body reads*, so a socket that goes quiet mid-stream cannot wedge the app
/// even though the endpoint never sends a terminator. It is deliberately not a
/// total deadline — a long generation is not a hung one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timeouts {
    pub connect: Duration,
    /// Time allowed for the response *headers* to arrive.
    pub first_byte: Duration,
    /// Maximum gap between two body reads.
    pub stall: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            connect: Duration::from_secs(10),
            first_byte: Duration::from_secs(60),
            stall: Duration::from_secs(60),
        }
    }
}

impl Timeouts {
    /// Short deadlines for capability probing, which must never make the
    /// settings screen feel hung.
    pub fn probing() -> Self {
        Self {
            connect: Duration::from_secs(5),
            first_byte: Duration::from_secs(15),
            stall: Duration::from_secs(15),
        }
    }
}

/// Everything a call needs that is not the request itself.
#[derive(Debug, Clone, Default)]
pub struct RequestContext {
    pub cancel: CancelToken,
    pub timeouts: Timeouts,
}

impl RequestContext {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_timeouts(mut self, timeouts: Timeouts) -> Self {
        self.timeouts = timeouts;
        self
    }

    pub fn with_cancel(mut self, cancel: CancelToken) -> Self {
        self.cancel = cancel;
        self
    }
}

/// The one interface every backend implements.
#[async_trait]
pub trait Provider: Send + Sync {
    /// The UI-facing identity. Capabilities on the descriptor are the
    /// *declared* floor; the probed truth is [`Provider::probe_capabilities`].
    fn descriptor(&self) -> &ProviderDescriptor;

    /// Models the endpoint reports. A backend that cannot enumerate returns
    /// `CapabilityUnsupported { capability: ModelListing }` so the UI offers
    /// free-text entry — a normal state, not an error.
    async fn list_models(&self, context: &RequestContext) -> ProviderResult<Vec<ModelInfo>>;

    /// Find out what this model can actually do, by asking it.
    ///
    /// MEASURED-5 is why this cannot be a lookup table: three of four profiles
    /// accept `response_format: json_schema`, answer 200, and return prose. The
    /// only way to know is to send a probe and check the answer.
    async fn probe_capabilities(
        &self,
        model_id: &str,
        context: &RequestContext,
    ) -> ProviderResult<ModelCapabilities>;

    /// Stream a completion. The mandatory method.
    async fn stream(
        &self,
        request: ChatRequest,
        sink: &mut dyn EventSink,
        context: &RequestContext,
    ) -> ProviderResult<ChatResponse>;

    /// Complete without streaming.
    ///
    /// Defaulted on purpose: one implementation, so the streamed and
    /// non-streamed results of the same request cannot diverge.
    async fn complete(
        &self,
        request: ChatRequest,
        context: &RequestContext,
    ) -> ProviderResult<ChatResponse> {
        let mut sink = CollectingSink::new();
        let response = self.stream(request, &mut sink, context).await?;
        debug_assert!(
            sink.events.iter().any(StreamEvent::is_terminal),
            "a provider must always terminate its event stream"
        );
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_cancelled_token_resolves_immediately_and_stays_cancelled() {
        let token = CancelToken::new();
        assert!(!token.is_cancelled());
        token.cancel();
        assert!(token.is_cancelled());
        // Must not hang: already-cancelled tokens resolve without a waiter.
        tokio::time::timeout(Duration::from_millis(100), token.cancelled())
            .await
            .expect("an already-cancelled token must resolve immediately");
        assert_eq!(token.err_if_cancelled(), Err(ProviderError::Cancelled));
    }

    #[tokio::test]
    async fn cancelling_wakes_a_waiter() {
        let token = CancelToken::new();
        let waiter = token.clone();
        let handle = tokio::spawn(async move { waiter.cancelled().await });
        tokio::task::yield_now().await;
        token.cancel();
        tokio::time::timeout(Duration::from_millis(500), handle)
            .await
            .expect("cancel must wake the waiter")
            .expect("task must not panic");
    }

    #[test]
    fn probing_timeouts_are_shorter_than_the_defaults() {
        assert!(Timeouts::probing().first_byte < Timeouts::default().first_byte);
    }
}
