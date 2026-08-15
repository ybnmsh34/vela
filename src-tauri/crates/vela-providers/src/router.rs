//! Ordered candidates, bounded retries, and failover that cannot lie.
//!
//! # THE THREE RULES OF THIS FILE
//!
//! 1. **Fail over only on failures that are about the endpoint.** Transport
//!    problems and rate limits may resolve elsewhere. Auth failures, capability
//!    refusals, context overflows and model-not-found are about the *request*
//!    or the user's configuration: retrying them elsewhere turns one true error
//!    into several false ones, and in the auth case sprays a credential-shaped
//!    failure across every backend the user owns.
//! 2. **Never fail over after the user has seen output.** Once a character has
//!    reached the screen, moving to another candidate would restart the answer
//!    in front of them. After first visible output the error is surfaced.
//! 3. **Bounded, backed-off retries.** Attempts are capped, the delay grows,
//!    and the endpoint's own `Retry-After` wins over Vela's guess.
//! 4. **One turn, one terminal event.** A candidate that fails emits its own
//!    `Error` and a candidate that succeeds emits its own `Done`; forwarding
//!    both would hand the renderer two endings for one turn. Every candidate's
//!    terminal event is withheld by [`RoutedTurnSink`] and this file emits
//!    exactly one — which is also the only place [`Degradation::FailedOver`]
//!    can be attached, because nothing below the router knows an earlier
//!    candidate was tried.

use std::sync::Arc;
use std::time::Duration;

use crate::diagnostic::{Cause, Diagnosis};
use crate::error::{ProviderError, ProviderResult};
use crate::event::{EventSink, RoutedTurnSink, StreamEvent};
use crate::model::{ChatRequest, ChatResponse, Degradation};
use crate::provider::{Provider, RequestContext};

/// One place a request can go: a provider plus the model to ask for.
#[derive(Clone)]
pub struct Candidate {
    pub provider: Arc<dyn Provider>,
    pub model_id: String,
}

impl Candidate {
    pub fn new(provider: Arc<dyn Provider>, model_id: impl Into<String>) -> Self {
        Self {
            provider,
            model_id: model_id.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    /// Total attempts against a single candidate, including the first.
    pub max_attempts_per_candidate: u32,
    pub initial_backoff: Duration,
    pub max_backoff: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts_per_candidate: 3,
            initial_backoff: Duration::from_millis(250),
            max_backoff: Duration::from_secs(8),
        }
    }
}

impl RetryPolicy {
    /// No retries at all. Used by probing, where a slow settings screen is
    /// worse than an unprobed capability.
    pub fn none() -> Self {
        Self {
            max_attempts_per_candidate: 1,
            ..Self::default()
        }
    }

    fn backoff(&self, attempt: u32) -> Duration {
        let factor = 2u32.saturating_pow(attempt.saturating_sub(1));
        self.initial_backoff
            .saturating_mul(factor)
            .min(self.max_backoff)
    }
}

/// Routes one request across an ordered list of candidates.
#[derive(Clone)]
pub struct Router {
    candidates: Vec<Candidate>,
    policy: RetryPolicy,
}

/// Hand-written because a [`Candidate`] holds an `Arc<dyn Provider>`, which
/// cannot be `Debug`. What a reader of a panic or a log actually wants is the
/// *order* anyway: which endpoints, in which sequence, for which models.
impl std::fmt::Debug for Router {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Router")
            .field("candidates", &self.candidate_ids())
            .field("models", &self.candidate_models())
            .field("policy", &self.policy)
            .finish()
    }
}

impl Router {
    pub fn new(candidates: Vec<Candidate>) -> Self {
        Self {
            candidates,
            policy: RetryPolicy::default(),
        }
    }

    pub fn with_policy(mut self, policy: RetryPolicy) -> Self {
        self.policy = policy;
        self
    }

    pub fn is_empty(&self) -> bool {
        self.candidates.is_empty()
    }

    /// The endpoints this router will try, in order, by the id they are
    /// configured under.
    ///
    /// Present so that a candidate list can be **asserted on** rather than
    /// inferred from which sockets happened to receive traffic. The ordering is
    /// decided one layer up, in the composition root, and a decision no test
    /// can read is a decision nothing pins.
    pub fn candidate_ids(&self) -> Vec<String> {
        self.candidates
            .iter()
            .map(|candidate| candidate.provider.descriptor().id.clone())
            .collect()
    }

    /// The model each candidate will be asked for, in the same order. Not the
    /// same list twice: a fallback answers about its own model, not the one the
    /// user picked on the endpoint they chose.
    pub fn candidate_models(&self) -> Vec<String> {
        self.candidates
            .iter()
            .map(|candidate| candidate.model_id.clone())
            .collect()
    }

    /// Run `request` against the candidates in order.
    ///
    /// The request's `model_id` is replaced by each candidate's, so one
    /// conversation can fail over between backends that name their models
    /// differently.
    ///
    /// `sink` sees exactly one terminal event — the router's own — whatever
    /// happens below. See rule 4 in the module docs.
    pub async fn stream(
        &self,
        request: ChatRequest,
        sink: &mut dyn EventSink,
        context: &RequestContext,
    ) -> ProviderResult<ChatResponse> {
        let mut routed = RoutedTurnSink::new(sink);
        let outcome = self.route(request, &mut routed, context).await;
        match &outcome {
            // The response the *router* assembled, not the one a candidate
            // emitted: only this one carries `FailedOver`.
            Ok(response) => routed.finish(StreamEvent::Done {
                response: Box::new(response.clone()),
            }),
            Err(error) => routed.finish(StreamEvent::Error {
                error: error.clone(),
            }),
        }
        outcome
    }

    async fn route(
        &self,
        request: ChatRequest,
        sink: &mut RoutedTurnSink<'_>,
        context: &RequestContext,
    ) -> ProviderResult<ChatResponse> {
        if self.candidates.is_empty() {
            return Err(ProviderError::malformed(Diagnosis::local(
                Cause::NoProviderConfigured,
            )));
        }

        let mut attempts_used = 0u32;
        let mut last_error: Option<ProviderError> = None;

        for candidate in &self.candidates {
            let mut attempt = 1u32;
            loop {
                context.cancel.err_if_cancelled()?;
                attempts_used += 1;

                let mut attempt_request = request.clone();
                attempt_request.model_id = candidate.model_id.clone();

                match candidate
                    .provider
                    .stream(attempt_request, &mut *sink, context)
                    .await
                {
                    Ok(mut response) => {
                        if attempts_used > 1 {
                            response.degradations.push(Degradation::FailedOver {
                                attempts: attempts_used,
                            });
                        }
                        return Ok(response);
                    }
                    Err(error) => {
                        // Rule 2. Anything else would replay the answer in
                        // front of the user.
                        if sink.committed() {
                            return Err(error);
                        }
                        let retryable = error.allows_retry()
                            && attempt < self.policy.max_attempts_per_candidate;
                        let can_failover = error.allows_failover();
                        last_error = Some(error);

                        if retryable {
                            let error = last_error.as_ref().expect("just set");
                            let delay = error
                                .retry_after()
                                .unwrap_or_else(|| self.policy.backoff(attempt))
                                .min(self.policy.max_backoff);
                            tokio::select! {
                                biased;
                                () = context.cancel.cancelled() => {
                                    return Err(ProviderError::Cancelled)
                                }
                                () = tokio::time::sleep(delay) => {}
                            }
                            attempt += 1;
                            continue;
                        }
                        if can_failover {
                            break; // next candidate
                        }
                        // Rule 1: this error is about the request, not the
                        // endpoint. Surface it now.
                        return Err(last_error.expect("just set"));
                    }
                }
            }
        }

        Err(last_error.unwrap_or_else(|| {
            ProviderError::malformed(Diagnosis::local(Cause::NoCandidateAnswered))
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::{Capability, TransportFailure};
    use crate::event::{CollectingSink, StreamEvent};
    use crate::model::ChatMessage;
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicU32, Ordering};
    use vela_core::provider::{ProviderDescriptor, ProviderKind};

    /// A provider that answers from a script. Each call takes the next entry.
    ///
    /// It emits its own terminal event on both paths — `Done` on success,
    /// `Error` on failure — because that is what every real adapter in this
    /// crate does, and the router's whole terminal-event discipline is about
    /// what happens to those.
    struct Scripted {
        descriptor: ProviderDescriptor,
        outcomes: Vec<Result<&'static str, ProviderError>>,
        calls: AtomicU32,
        /// Emit a text delta before failing — the "user already saw it" case.
        emit_before_failing: bool,
    }

    impl Scripted {
        fn new(id: &str, outcomes: Vec<Result<&'static str, ProviderError>>) -> Arc<Self> {
            Arc::new(Self {
                descriptor: ProviderDescriptor::new(id, id, ProviderKind::Local).unwrap(),
                outcomes,
                calls: AtomicU32::new(0),
                emit_before_failing: false,
            })
        }

        fn emitting(id: &str, outcomes: Vec<Result<&'static str, ProviderError>>) -> Arc<Self> {
            Arc::new(Self {
                descriptor: ProviderDescriptor::new(id, id, ProviderKind::Local).unwrap(),
                outcomes,
                calls: AtomicU32::new(0),
                emit_before_failing: true,
            })
        }

        fn calls(&self) -> u32 {
            self.calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl Provider for Scripted {
        fn descriptor(&self) -> &ProviderDescriptor {
            &self.descriptor
        }

        async fn list_models(
            &self,
            _: &RequestContext,
        ) -> ProviderResult<Vec<crate::provider::ModelInfo>> {
            Err(ProviderError::unsupported(
                Capability::ModelListing,
                Cause::CapabilityNotOfferedByBackend,
            ))
        }

        async fn probe_capabilities(
            &self,
            model_id: &str,
            _: &RequestContext,
        ) -> ProviderResult<crate::capability::ModelCapabilities> {
            Ok(crate::capability::ModelCapabilities::unknown(model_id))
        }

        async fn stream(
            &self,
            _request: ChatRequest,
            sink: &mut dyn EventSink,
            _context: &RequestContext,
        ) -> ProviderResult<ChatResponse> {
            let index = self.calls.fetch_add(1, Ordering::SeqCst) as usize;
            match self.outcomes.get(index).cloned() {
                Some(Ok(text)) => {
                    sink.emit(StreamEvent::TextDelta { text: text.into() });
                    let mut response = ChatResponse::empty();
                    response.parts = vec![crate::model::ContentPart::text(text)];
                    sink.emit(StreamEvent::Done {
                        response: Box::new(response.clone()),
                    });
                    Ok(response)
                }
                Some(Err(error)) => {
                    if self.emit_before_failing {
                        sink.emit(StreamEvent::TextDelta {
                            text: "partial ".into(),
                        });
                    }
                    sink.emit(StreamEvent::Error {
                        error: error.clone(),
                    });
                    Err(error)
                }
                None => Err(ProviderError::malformed(Cause::SyntheticTestFailure)),
            }
        }
    }

    fn request() -> ChatRequest {
        ChatRequest::new("ignored").with_message(ChatMessage::user("hi"))
    }

    fn transport_error() -> ProviderError {
        ProviderError::transport(TransportFailure::Connect, Cause::ConnectionFailed)
    }

    fn fast_policy() -> RetryPolicy {
        RetryPolicy {
            max_attempts_per_candidate: 2,
            initial_backoff: Duration::from_millis(1),
            max_backoff: Duration::from_millis(2),
        }
    }

    #[tokio::test]
    async fn a_transport_failure_is_retried_then_failed_over() {
        let first = Scripted::new("a", vec![Err(transport_error()), Err(transport_error())]);
        let second = Scripted::new("b", vec![Ok("answer from the second")]);
        let router = Router::new(vec![
            Candidate::new(first.clone(), "model-a"),
            Candidate::new(second.clone(), "model-b"),
        ])
        .with_policy(fast_policy());

        let mut sink = CollectingSink::new();
        let response = router
            .stream(request(), &mut sink, &RequestContext::new())
            .await
            .unwrap();

        assert_eq!(
            first.calls(),
            2,
            "retried within the candidate, then moved on"
        );
        assert_eq!(second.calls(), 1);
        assert_eq!(response.answer_text(), "answer from the second");
        assert!(response
            .degradations
            .iter()
            .any(|d| matches!(d, Degradation::FailedOver { .. })));
    }

    /// **The event a whole renderer surface was written for.**
    ///
    /// `src/features/conversation/notices.ts` renders "Retried before it worked
    /// — this answer took N attempts" off `Degradation::FailedOver`, and the
    /// renderer reads degradations off the `Done` event and nowhere else. The
    /// router used to push `FailedOver` onto its *return value* only — after
    /// the winning candidate had already emitted a `Done` that could not know
    /// about it — so the sentence was unreachable no matter how many candidates
    /// failed first.
    #[tokio::test]
    async fn the_attempt_count_reaches_the_screen_and_not_only_the_return_value() {
        let first = Scripted::new("a", vec![Err(transport_error())]);
        let second = Scripted::new("b", vec![Ok("answer from the second")]);
        let router = Router::new(vec![
            Candidate::new(first, "model-a"),
            Candidate::new(second, "model-b"),
        ])
        .with_policy(RetryPolicy {
            max_attempts_per_candidate: 1,
            ..fast_policy()
        });

        let mut sink = CollectingSink::new();
        router
            .stream(request(), &mut sink, &RequestContext::new())
            .await
            .unwrap();

        let emitted = sink.response().expect("a turn ends with a Done");
        assert_eq!(
            emitted.degradations,
            vec![Degradation::FailedOver { attempts: 2 }],
            "the Done the renderer reads must carry the attempt count"
        );
        assert_eq!(emitted.answer_text(), "answer from the second");
    }

    /// One turn, one ending. Rule 4.
    #[tokio::test]
    async fn a_failed_candidate_never_puts_its_own_ending_in_front_of_the_user() {
        let first = Scripted::new("a", vec![Err(transport_error())]);
        let second = Scripted::new("b", vec![Ok("the real answer")]);
        let router = Router::new(vec![
            Candidate::new(first, "model-a"),
            Candidate::new(second, "model-b"),
        ])
        .with_policy(RetryPolicy {
            max_attempts_per_candidate: 1,
            ..fast_policy()
        });

        let mut sink = CollectingSink::new();
        router
            .stream(request(), &mut sink, &RequestContext::new())
            .await
            .unwrap();

        let terminals: Vec<&StreamEvent> = sink.events.iter().filter(|e| e.is_terminal()).collect();
        assert_eq!(
            terminals.len(),
            1,
            "the failed candidate's Error must not reach the renderer: {:?}",
            sink.events
        );
        assert!(matches!(terminals[0], StreamEvent::Done { .. }));
        assert_eq!(sink.text(), "the real answer");
    }

    /// The failing half of the same rule: a turn that ends badly still ends
    /// exactly once, and the sink's last event is the error the caller gets.
    #[tokio::test]
    async fn a_turn_that_no_candidate_answers_still_terminates_exactly_once() {
        let only = Scripted::new("a", vec![Err(transport_error())]);
        let router = Router::new(vec![Candidate::new(only, "m")]).with_policy(RetryPolicy {
            max_attempts_per_candidate: 1,
            ..fast_policy()
        });

        let mut sink = CollectingSink::new();
        let error = router
            .stream(request(), &mut sink, &RequestContext::new())
            .await
            .unwrap_err();

        assert_eq!(sink.events.iter().filter(|e| e.is_terminal()).count(), 1);
        assert!(matches!(
            sink.events.last(),
            Some(StreamEvent::Error { .. })
        ));
        assert_eq!(
            sink.error(),
            Some(&error),
            "the same error, not a second one"
        );
    }

    #[tokio::test]
    async fn an_auth_failure_is_never_retried_and_never_sprayed_at_other_candidates() {
        let first = Scripted::new(
            "a",
            vec![Err(ProviderError::AuthFailed {
                diagnosis: Cause::CredentialRejected.into(),
            })],
        );
        let second = Scripted::new("b", vec![Ok("should never run")]);
        let router = Router::new(vec![
            Candidate::new(first.clone(), "model-a"),
            Candidate::new(second.clone(), "model-b"),
        ])
        .with_policy(fast_policy());

        let error = router
            .stream(
                request(),
                &mut CollectingSink::new(),
                &RequestContext::new(),
            )
            .await
            .unwrap_err();

        assert!(matches!(error, ProviderError::AuthFailed { .. }));
        assert_eq!(first.calls(), 1);
        assert_eq!(second.calls(), 0, "the second backend never sees it");
    }

    #[tokio::test]
    async fn a_capability_refusal_is_surfaced_rather_than_shopped_around() {
        let first = Scripted::new(
            "a",
            vec![Err(ProviderError::unsupported(
                Capability::Vision,
                Cause::CapabilityAbsentOnThisModel,
            ))],
        );
        let second = Scripted::new("b", vec![Ok("should never run")]);
        let router = Router::new(vec![
            Candidate::new(first, "model-a"),
            Candidate::new(second.clone(), "model-b"),
        ])
        .with_policy(fast_policy());

        let error = router
            .stream(
                request(),
                &mut CollectingSink::new(),
                &RequestContext::new(),
            )
            .await
            .unwrap_err();
        assert!(matches!(error, ProviderError::CapabilityUnsupported { .. }));
        assert_eq!(second.calls(), 0);
    }

    #[tokio::test]
    async fn once_the_user_has_seen_output_the_turn_is_never_restarted_elsewhere() {
        let first = Scripted::emitting("a", vec![Err(transport_error())]);
        let second = Scripted::new("b", vec![Ok("a whole second answer")]);
        let router = Router::new(vec![
            Candidate::new(first, "model-a"),
            Candidate::new(second.clone(), "model-b"),
        ])
        .with_policy(fast_policy());

        let mut sink = CollectingSink::new();
        let error = router
            .stream(request(), &mut sink, &RequestContext::new())
            .await
            .unwrap_err();

        assert!(matches!(error, ProviderError::Transport { .. }));
        assert_eq!(
            second.calls(),
            0,
            "failing over here would replay the answer in front of the user"
        );
        assert_eq!(sink.text(), "partial ");
    }

    #[tokio::test]
    async fn a_rate_limit_waits_the_endpoints_own_advice_before_retrying() {
        let provider = Scripted::new(
            "a",
            vec![
                Err(ProviderError::RateLimited {
                    retry_after_ms: Some(1),
                    diagnosis: Cause::TooManyRequests.into(),
                }),
                Ok("after the wait"),
            ],
        );
        let router =
            Router::new(vec![Candidate::new(provider.clone(), "m")]).with_policy(fast_policy());

        let response = router
            .stream(
                request(),
                &mut CollectingSink::new(),
                &RequestContext::new(),
            )
            .await
            .unwrap();
        assert_eq!(response.answer_text(), "after the wait");
        assert_eq!(provider.calls(), 2);
    }

    #[tokio::test]
    async fn retries_are_bounded_and_the_last_error_is_the_one_reported() {
        let provider = Scripted::new(
            "a",
            vec![
                Err(transport_error()),
                Err(transport_error()),
                Err(transport_error()),
            ],
        );
        let router =
            Router::new(vec![Candidate::new(provider.clone(), "m")]).with_policy(fast_policy());

        let error = router
            .stream(
                request(),
                &mut CollectingSink::new(),
                &RequestContext::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(
            provider.calls(),
            2,
            "max_attempts_per_candidate is honoured"
        );
        assert!(matches!(error, ProviderError::Transport { .. }));
    }

    #[tokio::test]
    async fn cancelling_stops_the_router_between_attempts() {
        let provider = Scripted::new("a", vec![Err(transport_error()), Ok("never")]);
        let router =
            Router::new(vec![Candidate::new(provider.clone(), "m")]).with_policy(RetryPolicy {
                max_attempts_per_candidate: 3,
                initial_backoff: Duration::from_secs(30),
                max_backoff: Duration::from_secs(30),
            });
        let context = RequestContext::new();
        let cancel = context.cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            cancel.cancel();
        });
        let error = tokio::time::timeout(
            Duration::from_secs(2),
            router.stream(request(), &mut CollectingSink::new(), &context),
        )
        .await
        .expect("cancelling must not wait out the backoff")
        .unwrap_err();
        assert_eq!(error, ProviderError::Cancelled);
    }
}
