//! The normalised event stream, and where it goes.
//!
//! Six events, no more: `TextDelta`, `ReasoningDelta`, `ToolCallDelta`,
//! `Usage`, `Done`, `Error`. A consumer that handles these six handles every
//! backend Vela will ever have, including ones that cannot stream at all (they
//! emit one `TextDelta` and a `Done`, and the consumer cannot tell).
//!
//! # What `Done` guarantees
//!
//! `Done` is emitted **exactly once**, at end-of-body, on every path that does
//! not end in `Error` — including the paths where the endpoint never sent
//! `[DONE]` and never sent usage. That is MEASURED-1 turned into a type: a
//! consumer waiting on this event cannot hang for a sentinel that is never
//! coming, because the sentinel is not what produces it.

use serde::{Deserialize, Serialize};

use crate::error::ProviderError;
use crate::model::{ChatResponse, Degradation, StopReason, TokenUsage, ToolCallOutcome};

/// A fragment of a tool call, as it is being accumulated.
///
/// Emitted for UI progress only. It is deliberately *not* enough to execute a
/// call: execution reads [`ToolCallOutcome`] off the final [`ChatResponse`],
/// which is the only place a call is ever declared well-formed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallDelta {
    /// Vela's own slot key. Stable across the stream even when the endpoint
    /// omits `index`, reuses it, or jumps from 0 to 7 (MEASURED-4).
    pub slot: u32,
    pub call_id: Option<String>,
    pub name: Option<String>,
    /// The argument fragment that just arrived, verbatim.
    pub arguments_fragment: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StreamEvent {
    /// Answer text. Never contains reasoning markup — the splitter has already
    /// run, across frame boundaries (MEASURED-3).
    TextDelta {
        text: String,
    },
    /// Reasoning text, from `<think>` blocks or from a `reasoning_content`
    /// field. Stored as a distinct content part, never shown as the answer.
    ReasoningDelta {
        text: String,
    },
    ToolCallDelta {
        delta: ToolCallDelta,
    },
    /// Usage, if the endpoint ever reports it. May never arrive; nothing waits
    /// for it.
    Usage {
        usage: TokenUsage,
    },
    /// The turn finished. Carries the assembled response so a consumer that
    /// only cares about the end state can ignore the deltas entirely.
    Done {
        response: Box<ChatResponse>,
    },
    /// The turn failed. Terminal: no `Done` follows.
    Error {
        error: ProviderError,
    },
}

impl StreamEvent {
    pub fn is_terminal(&self) -> bool {
        matches!(self, StreamEvent::Done { .. } | StreamEvent::Error { .. })
    }
}

/// Where events go.
///
/// A plain trait rather than a `Stream` so that providers need no async-runtime
/// dependency, tests can collect into a `Vec`, and the IPC layer can forward
/// straight to a Tauri channel.
///
/// `emit` is infallible on purpose: a sink that has gone away must not be able
/// to turn into a provider error halfway through a turn. To stop early, cancel
/// the request through its [`CancelToken`](crate::provider::CancelToken).
pub trait EventSink: Send {
    fn emit(&mut self, event: StreamEvent);
}

impl EventSink for Vec<StreamEvent> {
    fn emit(&mut self, event: StreamEvent) {
        self.push(event);
    }
}

/// A sink that drops everything. For non-streaming callers.
#[derive(Debug, Default, Clone, Copy)]
pub struct NullSink;

impl EventSink for NullSink {
    fn emit(&mut self, _event: StreamEvent) {}
}

/// Adapts a closure into a sink. A blanket `impl EventSink for F: FnMut(..)`
/// would collide with the concrete impls above under coherence, so the wrapper
/// is explicit.
pub struct FnSink<F>(pub F);

impl<F> EventSink for FnSink<F>
where
    F: FnMut(StreamEvent) + Send,
{
    fn emit(&mut self, event: StreamEvent) {
        (self.0)(event)
    }
}

/// Wraps the caller's sink for the duration of one **routed** turn.
///
/// Two jobs, both about not lying to the user:
///
/// 1. **It remembers whether anything the user can *see* has been emitted.**
///    This is the one failover rule that cannot be derived from the error
///    taxonomy: once a single character has reached the screen, moving to
///    another candidate would replay the turn and the user would watch the
///    answer restart. After first visible output, an error is surfaced instead.
/// 2. **It withholds every terminal event a candidate produces** and hands the
///    router [`finish`](Self::finish) to emit exactly one of its own. Both
///    halves of that are load-bearing:
///
///    * A candidate that failed emits `Error` before the router has decided
///      anything — [`CompatProvider`](crate::compat::CompatProvider) does
///      exactly this. Forwarded, the renderer would draw a failed turn and
///      then receive the `Done` of the candidate that actually worked. Two
///      terminal events for one turn is a state its reducer has no meaning for.
///    * The router's own [`Degradation`]s — `FailedOver` above all — are known
///      only *after* the last candidate returns. The `Done` a provider emits
///      cannot carry them, so a re-emitted `Done` is the only way "this answer
///      took N attempts" ever reaches the screen.
///
/// The same shape as `compat`'s private `SuppressingSink`, one layer up, and
/// for the same reason: whoever may retry owns the terminal event.
pub struct RoutedTurnSink<'a> {
    inner: &'a mut dyn EventSink,
    committed: bool,
    finished: bool,
}

impl<'a> RoutedTurnSink<'a> {
    pub fn new(inner: &'a mut dyn EventSink) -> Self {
        Self {
            inner,
            committed: false,
            finished: false,
        }
    }

    /// Has visible content been emitted? Reasoning counts: it is rendered.
    pub fn committed(&self) -> bool {
        self.committed
    }

    /// Emit the one terminal event of this turn.
    pub fn finish(&mut self, event: StreamEvent) {
        debug_assert!(event.is_terminal(), "finish takes a terminal event");
        debug_assert!(!self.finished, "a turn terminates exactly once");
        self.finished = true;
        self.inner.emit(event);
    }
}

impl EventSink for RoutedTurnSink<'_> {
    fn emit(&mut self, event: StreamEvent) {
        match &event {
            // Withheld — see the type docs. `finish` is the only door.
            StreamEvent::Done { .. } | StreamEvent::Error { .. } => return,
            StreamEvent::TextDelta { text } | StreamEvent::ReasoningDelta { text } => {
                if !text.is_empty() {
                    self.committed = true;
                }
            }
            StreamEvent::ToolCallDelta { .. } => self.committed = true,
            StreamEvent::Usage { .. } => {}
        }
        self.inner.emit(event);
    }
}

/// Collects a stream back into the finished response. Used by the default
/// non-streaming path, and by tests.
#[derive(Debug, Default)]
pub struct CollectingSink {
    pub events: Vec<StreamEvent>,
}

impl CollectingSink {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn text(&self) -> String {
        self.events
            .iter()
            .filter_map(|event| match event {
                StreamEvent::TextDelta { text } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    pub fn reasoning(&self) -> String {
        self.events
            .iter()
            .filter_map(|event| match event {
                StreamEvent::ReasoningDelta { text } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    pub fn response(&self) -> Option<&ChatResponse> {
        self.events.iter().find_map(|event| match event {
            StreamEvent::Done { response } => Some(response.as_ref()),
            _ => None,
        })
    }

    pub fn error(&self) -> Option<&ProviderError> {
        self.events.iter().find_map(|event| match event {
            StreamEvent::Error { error } => Some(error),
            _ => None,
        })
    }
}

impl EventSink for CollectingSink {
    fn emit(&mut self, event: StreamEvent) {
        self.events.push(event);
    }
}

/// Convenience for providers that cannot stream: one text chunk, then `Done`.
pub fn emit_whole_response(sink: &mut dyn EventSink, response: ChatResponse) {
    for part in &response.parts {
        match part {
            crate::model::ContentPart::Text { text } => {
                sink.emit(StreamEvent::TextDelta { text: text.clone() })
            }
            crate::model::ContentPart::Reasoning { text, .. } => {
                sink.emit(StreamEvent::ReasoningDelta { text: text.clone() })
            }
            _ => {}
        }
    }
    if !response.usage.is_unreported() {
        sink.emit(StreamEvent::Usage {
            usage: response.usage,
        });
    }
    sink.emit(StreamEvent::Done {
        response: Box::new(response),
    });
}

/// Build the terminal `Done` payload. Kept here so every producer assembles it
/// the same way.
pub fn finished(
    parts: Vec<crate::model::ContentPart>,
    tool_calls: Vec<ToolCallOutcome>,
    stop_reason: StopReason,
    usage: TokenUsage,
    degradations: Vec<Degradation>,
) -> ChatResponse {
    ChatResponse {
        parts,
        tool_calls,
        stop_reason,
        usage,
        structured: None,
        degradations,
        // Unattributed on purpose. This builder is handed parts and never
        // learns which endpoint produced them; the router does, and stamps it
        // on the way out. `None` here is "nobody in this frame knew", which is
        // true, rather than a guess that would read as a claim.
        answered_by: None,
        // This builder takes parts that are already assembled and says nothing
        // about where they came from. `None` is the truthful value: a producer
        // that rescued text out of an unterminated reasoning block does not
        // reach the user through here — it holds an `AnswerChannel` and hands
        // its `AnswerContent` straight to a `ChatResponse`.
        salvaged_answer: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ContentPart;

    #[test]
    fn a_non_streaming_provider_is_indistinguishable_from_a_streaming_one() {
        let mut sink = CollectingSink::new();
        let mut response = ChatResponse::empty();
        response.parts = vec![ContentPart::text("hello")];
        response.stop_reason = StopReason::EndTurn;
        emit_whole_response(&mut sink, response);

        assert_eq!(sink.text(), "hello");
        assert!(matches!(sink.events.last(), Some(StreamEvent::Done { .. })));
    }

    #[test]
    fn the_commit_tracker_only_trips_on_visible_output() {
        let mut inner = CollectingSink::new();
        let mut sink = RoutedTurnSink::new(&mut inner);
        sink.emit(StreamEvent::Usage {
            usage: TokenUsage::default(),
        });
        assert!(!sink.committed(), "usage is not visible output");
        sink.emit(StreamEvent::TextDelta {
            text: String::new(),
        });
        assert!(!sink.committed(), "an empty delta shows the user nothing");
        sink.emit(StreamEvent::TextDelta { text: "a".into() });
        assert!(sink.committed(), "a character reached the screen");
    }

    #[test]
    fn a_candidates_own_terminal_event_never_reaches_the_caller() {
        // The defect this prevents: candidate one fails and emits `Error`,
        // candidate two answers and emits `Done`, and the renderer is handed
        // two terminal events for one turn.
        let mut inner = CollectingSink::new();
        {
            let mut sink = RoutedTurnSink::new(&mut inner);
            sink.emit(StreamEvent::Error {
                error: ProviderError::malformed(crate::diagnostic::Cause::SyntheticTestFailure),
            });
            sink.emit(StreamEvent::TextDelta { text: "hi".into() });
            sink.emit(StreamEvent::Done {
                response: Box::new(ChatResponse::empty()),
            });
            sink.finish(StreamEvent::Done {
                response: Box::new(ChatResponse::empty()),
            });
        }
        assert_eq!(
            inner.events.iter().filter(|e| e.is_terminal()).count(),
            1,
            "exactly one terminal event, and it is the router's own: {:?}",
            inner.events
        );
        assert_eq!(inner.text(), "hi", "ordinary output still passes through");
        assert!(matches!(
            inner.events.last(),
            Some(StreamEvent::Done { .. })
        ));
    }

    #[test]
    fn events_serialise_camel_case_and_tagged() {
        let json = serde_json::to_value(StreamEvent::ToolCallDelta {
            delta: ToolCallDelta {
                slot: 0,
                call_id: Some("call_1".into()),
                name: None,
                arguments_fragment: "{\"ci".into(),
            },
        })
        .unwrap();
        assert_eq!(json["type"], "toolCallDelta");
        assert_eq!(json["delta"]["argumentsFragment"], "{\"ci");
    }
}
