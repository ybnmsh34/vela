//! Normalising an OpenAI-compatible response — streamed or not — into the one
//! event stream.
//!
//! # THE LOAD-BEARING RULES OF THIS FILE
//!
//! * **MEASURED-1 — end-of-body terminates.** [`drive_stream`] finishes when
//!   the body ends. `[DONE]` sets a flag and nothing else; a missing `[DONE]`
//!   produces a [`Degradation::NoTerminationSentinel`], not a hang. Requested
//!   usage that never arrives produces [`Degradation::UsageNotReported`], not a
//!   hang. Every read is bounded by `timeouts.stall`.
//! * **MEASURED-2 — a bad frame costs one frame.** Unparseable frames, frames
//!   whose `choices` is a string, frames that are not objects: each increments
//!   a counter and the stream continues with everything already accumulated
//!   intact. The recorded naive consumer lost 318 of 349 characters here.
//! * **MEASURED-3 — reasoning is separated across the whole stream**, by
//!   [`ReasoningSplitter`], never per frame.
//! * **MEASURED-4 — tool calls accumulate defensively**, by
//!   [`ToolCallAccumulator`] — and the two wire shapes it can be fed are told
//!   apart *here*, in [`CompletionAssembler::apply_choice`], because this is the
//!   only place that still knows which one arrived. See [`ToolCallShape`].

use serde_json::Value;

use crate::emulation::ToolCallStripper;
use crate::error::{ProviderError, ProviderResult, TransportFailure};
use crate::event::{EventSink, StreamEvent};
use crate::http::BodyStream;
use crate::model::{
    ChatResponse, ContentPart, Degradation, StopReason, TokenUsage, ToolCallOutcome,
};
use crate::provider::RequestContext;
use crate::reasoning::{ReasoningPiece, ReasoningSplitter};
use crate::sse::SseDecoder;
use crate::tool_accum::{ToolCallAccumulator, ToolCallShape};

/// Assembles one completion out of wire fragments.
///
/// Shared by the streaming and non-streaming paths so the two cannot drift:
/// the same reasoning splitter, the same tool accumulator, the same usage
/// handling, the same degradation reporting.
///
/// Sharing the machinery is not the same as pretending the two wire shapes are
/// one. Where they genuinely differ — `choices[].delta` carries *fragments*,
/// `choices[].message` carries *whole values* — the difference is read off the
/// body and passed down as a [`ToolCallShape`] rather than averaged away. That
/// distinction, missing, is what let the same endpoint answer differently
/// depending on how it was asked (GATE M Part 1, Phase B, FINDING 1).
pub struct CompletionAssembler {
    sse: SseDecoder,
    splitter: ReasoningSplitter,
    tools: ToolCallAccumulator,
    parts: Vec<ContentPart>,
    usage: TokenUsage,
    stop_reason: Option<StopReason>,
    malformed_frames: usize,
    saw_done_hint: bool,
    saw_usage: bool,
    requested_usage: bool,
    streamed: bool,
    /// An error body that arrived *inside* a 200 stream. Some runtimes do this.
    stream_error: Option<ProviderError>,
    /// Present when tool calling is being emulated: answer text is routed
    /// through it so `<tool_call>` markup never reaches the user, even when the
    /// tag is split across frames.
    stripper: Option<ToolCallStripper>,
}

impl CompletionAssembler {
    /// `requested_usage`: whether `stream_options.include_usage` was sent.
    /// `small-local` accepts it and never sends usage — asking is not evidence
    /// that it will arrive, so this only controls whether its absence is worth
    /// reporting.
    pub fn new(streamed: bool, requested_usage: bool) -> Self {
        Self {
            sse: SseDecoder::new(),
            splitter: ReasoningSplitter::new(),
            tools: ToolCallAccumulator::new(),
            parts: Vec::new(),
            usage: TokenUsage::default(),
            stop_reason: None,
            malformed_frames: 0,
            saw_done_hint: false,
            saw_usage: false,
            requested_usage,
            streamed,
            stream_error: None,
            stripper: None,
        }
    }

    /// Route answer text through the emulated-tool-call stripper.
    pub fn with_tool_emulation(mut self) -> Self {
        self.stripper = Some(ToolCallStripper::new());
        self
    }

    /// Feed raw SSE bytes.
    pub fn push_bytes(&mut self, bytes: &[u8], sink: &mut dyn EventSink) {
        for frame in self.sse.push(bytes) {
            self.apply_frame(frame.is_done_hint(), &frame.data, sink);
        }
    }

    fn apply_frame(&mut self, done_hint: bool, data: &str, sink: &mut dyn EventSink) {
        if done_hint {
            // A hint, nothing more. The stream still ends where the body ends.
            self.saw_done_hint = true;
            return;
        }
        match serde_json::from_str::<Value>(data) {
            Ok(value) => self.apply_chunk(&value, sink),
            Err(_) => self.malformed_frames += 1,
        }
    }

    /// Apply one decoded chunk object (streaming `chat.completion.chunk`).
    pub fn apply_chunk(&mut self, chunk: &Value, sink: &mut dyn EventSink) {
        let Some(object) = chunk.as_object() else {
            self.malformed_frames += 1;
            return;
        };

        if let Some(error) = object.get("error") {
            self.stream_error = Some(error_from_body(error));
            return;
        }

        if let Some(usage) = object.get("usage").filter(|value| value.is_object()) {
            let parsed = parse_usage(usage);
            if !parsed.is_unreported() {
                self.usage = parsed;
                self.saw_usage = true;
                sink.emit(StreamEvent::Usage { usage: parsed });
            }
        }

        match object.get("choices") {
            None => {}
            Some(Value::Array(choices)) => {
                for choice in choices {
                    self.apply_choice(choice, sink);
                }
            }
            // `hostile` sends `"choices": "not-an-array"`. One bad frame.
            Some(_) => self.malformed_frames += 1,
        }
    }

    fn apply_choice(&mut self, choice: &Value, sink: &mut dyn EventSink) {
        let Some(object) = choice.as_object() else {
            self.malformed_frames += 1;
            return;
        };
        // Streaming puts the payload in `delta`; non-streaming in `message`.
        //
        // Which of the two it was is load-bearing and is not recoverable later:
        // an element of `delta.tool_calls` is a FRAGMENT keyed by `index`, while
        // an element of `message.tool_calls` is a WHOLE CALL that carries no
        // `index` — that field is a streaming-only concept. Reading both into
        // one shape is what made parallel tool calls collapse into one on the
        // non-streamed path (GATE M Part 1, Phase B, FINDING 1), so the shape is
        // decided here, at the only place that knows it, and passed on.
        let (payload, shape) = match object.get("delta") {
            Some(delta) => (delta.as_object(), ToolCallShape::Fragment),
            None => (
                object.get("message").and_then(Value::as_object),
                ToolCallShape::WholeCall,
            ),
        };

        if let Some(payload) = payload {
            if let Some(reasoning) = payload
                .get("reasoning_content")
                .or_else(|| payload.get("reasoning"))
                .and_then(Value::as_str)
            {
                // The other reasoning transport: a dedicated field. No tags to
                // strip, and it must never reach the answer channel.
                if !reasoning.is_empty() {
                    self.append_reasoning(reasoning);
                    sink.emit(StreamEvent::ReasoningDelta {
                        text: reasoning.to_owned(),
                    });
                }
            }
            if let Some(content) = payload.get("content") {
                for text in content_texts(content) {
                    for piece in self.splitter.push(&text) {
                        match piece {
                            ReasoningPiece::Answer(text) => self.emit_answer(&text, sink),
                            ReasoningPiece::Reasoning(text) => {
                                self.append_reasoning(&text);
                                sink.emit(StreamEvent::ReasoningDelta { text });
                            }
                        }
                    }
                }
            }
            if let Some(Value::Array(calls)) = payload.get("tool_calls") {
                for call in calls {
                    if let Some(delta) = self.tools.push(call, shape) {
                        sink.emit(StreamEvent::ToolCallDelta { delta });
                    }
                }
            }
        }

        if let Some(reason) = object.get("finish_reason").and_then(Value::as_str) {
            self.stop_reason = Some(map_stop_reason(reason));
        }
    }

    /// Answer text on its way to the user, after emulation stripping.
    fn emit_answer(&mut self, text: &str, sink: &mut dyn EventSink) {
        let visible = match &mut self.stripper {
            Some(stripper) => stripper.push(text),
            None => text.to_owned(),
        };
        if visible.is_empty() {
            return;
        }
        self.append_text(&visible);
        sink.emit(StreamEvent::TextDelta { text: visible });
    }

    fn append_text(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        match self.parts.last_mut() {
            Some(ContentPart::Text { text: existing }) => existing.push_str(text),
            _ => self.parts.push(ContentPart::text(text)),
        }
    }

    fn append_reasoning(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        match self.parts.last_mut() {
            Some(ContentPart::Reasoning { text: existing, .. }) => existing.push_str(text),
            _ => self.parts.push(ContentPart::reasoning(text)),
        }
    }

    /// End of body. Flushes held-back text, resolves tool calls, and reports
    /// every degradation observed along the way.
    pub fn finish(mut self, sink: &mut dyn EventSink) -> ProviderResult<ChatResponse> {
        for frame in self.sse.finish() {
            self.apply_frame(frame.is_done_hint(), &frame.data, sink);
        }
        if let Some(error) = self.stream_error {
            return Err(error);
        }

        let mut degradations = Vec::new();
        let finish = self.splitter.finish();
        for piece in finish.pieces {
            match piece {
                ReasoningPiece::Answer(text) => self.emit_answer(&text, sink),
                ReasoningPiece::Reasoning(text) => {
                    self.append_reasoning(&text);
                    sink.emit(StreamEvent::ReasoningDelta { text });
                }
            }
        }
        if let Some(recovered) = finish.recovered_answer {
            // MEASURED-3: the block never closed, so everything was filed as
            // reasoning and the user would otherwise see an empty answer.
            degradations.push(Degradation::UnterminatedReasoning {
                recovered_answer_chars: recovered.chars().count(),
            });
            self.append_text(&recovered);
            sink.emit(StreamEvent::TextDelta { text: recovered });
        }

        let mut tool_calls: Vec<ToolCallOutcome> = std::mem::take(&mut self.tools).finish();

        if let Some(stripper) = self.stripper.take() {
            let (tail, emulated) = stripper.finish();
            if !tail.is_empty() {
                self.append_text(&tail);
                sink.emit(StreamEvent::TextDelta { text: tail });
            }
            let found_tagged = !emulated.is_empty();
            tool_calls.extend(emulated);
            if !found_tagged {
                // No `<tool_call>` block. The other shapes models use — a
                // fenced JSON object, a `TOOL_CALL name {…}` line — can only be
                // recognised once the whole answer is in hand, so their text may
                // have streamed before being retracted here. Documented, and
                // preferred over not recognising the call at all.
                let answer: String = self
                    .parts
                    .iter()
                    .filter_map(|part| match part {
                        ContentPart::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect();
                let parsed = crate::emulation::parse_calls(&answer);
                if !parsed.is_empty() {
                    rewrite_answer_text(&mut self.parts, &parsed.remaining_text);
                    tool_calls.extend(parsed.calls);
                }
            }
            if tool_calls.iter().any(ToolCallOutcome::is_ok) && self.stop_reason.is_none() {
                self.stop_reason = Some(StopReason::ToolUse);
            }
        }
        let malformed = tool_calls.iter().filter(|call| !call.is_ok()).count();
        if malformed > 0 {
            degradations.push(Degradation::MalformedToolCalls { count: malformed });
        }
        if self.malformed_frames > 0 {
            degradations.push(Degradation::MalformedFramesSkipped {
                count: self.malformed_frames,
            });
        }
        if self.streamed && !self.saw_done_hint {
            degradations.push(Degradation::NoTerminationSentinel);
        }
        if self.requested_usage && !self.saw_usage {
            degradations.push(Degradation::UsageNotReported);
        }

        let stop_reason = self.stop_reason.unwrap_or_else(|| {
            if tool_calls.iter().any(ToolCallOutcome::is_ok) {
                StopReason::ToolUse
            } else {
                StopReason::Unspecified
            }
        });

        // Nothing at all came back and nothing said why. That is not an answer.
        if self.parts.is_empty() && tool_calls.is_empty() && self.malformed_frames > 0 {
            return Err(ProviderError::malformed(format!(
                "every frame in the response was unreadable ({} skipped)",
                self.malformed_frames
            )));
        }

        Ok(ChatResponse {
            parts: self.parts,
            tool_calls,
            stop_reason,
            usage: self.usage,
            structured: None,
            degradations,
        })
    }
}

/// Replace every text part with one carrying `text`, keeping its position
/// relative to the reasoning parts around it.
fn rewrite_answer_text(parts: &mut Vec<ContentPart>, text: &str) {
    let first_text = parts
        .iter()
        .position(|part| matches!(part, ContentPart::Text { .. }));
    parts.retain(|part| !matches!(part, ContentPart::Text { .. }));
    if text.is_empty() {
        return;
    }
    let at = first_text.unwrap_or(parts.len()).min(parts.len());
    parts.insert(at, ContentPart::text(text));
}

/// `content` is a string on every endpoint Vela has met, but the OpenAI schema
/// also allows an array of parts. Both are read; anything else is ignored
/// rather than fatal.
fn content_texts(content: &Value) -> Vec<String> {
    match content {
        Value::String(text) => vec![text.clone()],
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| {
                part.as_object()
                    .and_then(|object| object.get("text"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn parse_usage(value: &Value) -> TokenUsage {
    let field = |name: &str| {
        value
            .get(name)
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
    };
    TokenUsage {
        input_tokens: field("prompt_tokens").or_else(|| field("input_tokens")),
        output_tokens: field("completion_tokens").or_else(|| field("output_tokens")),
        reasoning_tokens: value
            .get("completion_tokens_details")
            .and_then(|details| details.get("reasoning_tokens"))
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok()),
        cached_input_tokens: value
            .get("prompt_tokens_details")
            .and_then(|details| details.get("cached_tokens"))
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok()),
    }
}

fn map_stop_reason(reason: &str) -> StopReason {
    match reason {
        "stop" | "end_turn" => StopReason::EndTurn,
        "length" | "max_tokens" => StopReason::MaxTokens,
        "tool_calls" | "function_call" | "tool_use" => StopReason::ToolUse,
        _ => StopReason::Unspecified,
    }
}

/// An `{"error": {...}}` object that arrived inside an otherwise-200 response.
fn error_from_body(error: &Value) -> ProviderError {
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("the endpoint reported an error mid-stream");
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    crate::openai_compatible::map_error_code(code, message, None)
}

/// Read a body to its end, feeding the assembler, honouring the stall timeout
/// and cancellation.
///
/// This function is where "the stream ends when the body ends" actually lives.
pub async fn drive_stream(
    mut body: BodyStream,
    mut assembler: CompletionAssembler,
    sink: &mut dyn EventSink,
    context: &RequestContext,
) -> ProviderResult<ChatResponse> {
    // Grabbed before the loop borrows the body: a stall must still say which
    // endpoint went quiet, and the redacted form is safe to say it with.
    let endpoint = body.endpoint().to_owned();
    loop {
        context.cancel.err_if_cancelled()?;
        let read = tokio::select! {
            biased;
            () = context.cancel.cancelled() => return Err(ProviderError::Cancelled),
            read = tokio::time::timeout(context.timeouts.stall, body.next_chunk()) => read,
        };
        match read {
            // The gap between two reads exceeded the budget. This is the guard
            // MEASURED-1 requires: a socket that goes quiet can never wedge the
            // app, whatever the endpoint promised about sentinels.
            Err(_elapsed) => {
                return Err(ProviderError::transport(
                    TransportFailure::Stalled,
                    format!(
                        "no data for {} ms for url ({endpoint})",
                        context.timeouts.stall.as_millis()
                    ),
                ))
            }
            Ok(Err(error)) => return Err(ProviderError::from(error)),
            // End of body. The one reliable terminator.
            Ok(Ok(None)) => break,
            Ok(Ok(Some(chunk))) => assembler.push_bytes(&chunk, sink),
        }
    }
    assembler.finish(sink)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::CollectingSink;
    use crate::model::MalformedToolCall;

    fn assemble(
        body: &str,
        requested_usage: bool,
    ) -> (CollectingSink, ProviderResult<ChatResponse>) {
        let mut sink = CollectingSink::new();
        let mut assembler = CompletionAssembler::new(true, requested_usage);
        assembler.push_bytes(body.as_bytes(), &mut sink);
        let response = assembler.finish(&mut sink);
        (sink, response)
    }

    fn chunk(delta: &str) -> String {
        format!(
            "data: {{\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"choices\":[{{\"index\":0,\"delta\":{delta},\"finish_reason\":null}}]}}\n\n"
        )
    }

    #[test]
    fn a_stream_with_no_done_sentinel_still_terminates_and_says_so() {
        let body = format!("{}{}", chunk("{\"content\":\"hi\"}"), chunk("{}"));
        let (sink, response) = assemble(&body, false);
        let response = response.expect("end of body is the terminator");
        assert_eq!(sink.text(), "hi");
        assert!(response
            .degradations
            .contains(&Degradation::NoTerminationSentinel));
    }

    #[test]
    fn requested_usage_that_never_arrives_is_reported_not_awaited() {
        let (_, response) = assemble(&chunk("{\"content\":\"hi\"}"), true);
        let response = response.unwrap();
        assert!(response.usage.is_unreported());
        assert!(response
            .degradations
            .contains(&Degradation::UsageNotReported));
    }

    #[test]
    fn unparseable_frames_cost_one_frame_each_and_nothing_else() {
        // The hostile shape: a frame cut off mid-string, a comment, a frame
        // whose `choices` is a string, and a frame that is not JSON at all.
        let body = format!(
            "{}{}{}{}{}{}",
            chunk("{\"content\":\"one \"}"),
            "data: {\"id\":\"c\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"\n\n",
            ": keepalive\n\n",
            chunk("{\"content\":\"two \"}"),
            "data: {\"id\":\"c\",\"choices\":\"not-an-array\"}\n\ndata: not-json-at-all\n\n",
            chunk("{\"content\":\"three\"}"),
        );
        let (sink, response) = assemble(&body, false);
        let response = response.unwrap();
        assert_eq!(
            sink.text(),
            "one two three",
            "MEASURED-2: content that already arrived is never discarded"
        );
        assert!(
            matches!(
                response
                    .degradations
                    .iter()
                    .find(|d| matches!(d, Degradation::MalformedFramesSkipped { .. })),
                Some(Degradation::MalformedFramesSkipped { count: 3 })
            ),
            "got {:?}",
            response.degradations
        );
    }

    #[test]
    fn a_response_of_nothing_but_garbage_is_an_error_not_an_empty_answer() {
        let (_, response) = assemble("data: not-json\n\ndata: also-not-json\n\n", false);
        assert!(matches!(
            response,
            Err(ProviderError::MalformedResponse { .. })
        ));
    }

    #[test]
    fn reasoning_from_a_dedicated_field_never_reaches_the_answer() {
        let body = format!(
            "{}{}",
            chunk("{\"reasoning_content\":\"deliberating\"}"),
            chunk("{\"content\":\"the answer\"}")
        );
        let (sink, response) = assemble(&body, false);
        let response = response.unwrap();
        assert_eq!(sink.text(), "the answer");
        assert_eq!(sink.reasoning(), "deliberating");
        assert_eq!(response.answer_text(), "the answer");
        assert_eq!(response.reasoning_text(), "deliberating");
    }

    #[test]
    fn think_tags_split_across_frames_are_separated_and_ordered() {
        let body = format!(
            "{}{}{}{}",
            chunk("{\"content\":\"<thi\"}"),
            chunk("{\"content\":\"nk>thoughts</thi\"}"),
            chunk("{\"content\":\"nk>\"}"),
            chunk("{\"content\":\"answer\"}")
        );
        let (_, response) = assemble(&body, false);
        let response = response.unwrap();
        assert_eq!(response.answer_text(), "answer");
        assert_eq!(response.reasoning_text(), "thoughts");
        assert!(
            matches!(response.parts.first(), Some(ContentPart::Reasoning { .. })),
            "reasoning keeps its position ahead of the text it preceded"
        );
    }

    #[test]
    fn a_malformed_tool_call_reaches_the_response_as_a_reported_failure() {
        let body = format!(
            "{}{}",
            chunk("{\"tool_calls\":[{\"function\":{\"name\":\"get_weather\"}}]}"),
            chunk(
                "{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"arguments\":\"{oops\"}}]}"
            ),
        );
        let (sink, response) = assemble(&body, false);
        let response = response.unwrap();
        assert_eq!(response.tool_calls.len(), 1);
        assert!(matches!(
            &response.tool_calls[0],
            ToolCallOutcome::Malformed {
                reason: MalformedToolCall::UnparseableArguments,
                ..
            }
        ));
        assert!(response
            .degradations
            .contains(&Degradation::MalformedToolCalls { count: 1 }));
        assert!(
            sink.events
                .iter()
                .any(|event| matches!(event, StreamEvent::ToolCallDelta { .. })),
            "the UI still sees the call being built"
        );
    }

    #[test]
    fn usage_is_read_from_a_frame_with_no_choices() {
        let body = "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":34}}\n\ndata: [DONE]\n\n";
        let (sink, response) = assemble(body, true);
        let response = response.unwrap();
        assert_eq!(response.usage.input_tokens, Some(12));
        assert_eq!(response.usage.output_tokens, Some(34));
        assert!(!response
            .degradations
            .contains(&Degradation::UsageNotReported));
        assert!(sink
            .events
            .iter()
            .any(|event| matches!(event, StreamEvent::Usage { .. })));
    }

    #[test]
    fn an_error_object_inside_a_200_stream_becomes_a_provider_error() {
        let body = "data: {\"error\":{\"message\":\"out of room\",\"code\":\"context_length_exceeded\"}}\n\n";
        let (_, response) = assemble(body, false);
        assert!(matches!(
            response,
            Err(ProviderError::ContextLengthExceeded { .. })
        ));
    }

    #[test]
    fn finish_reasons_map_onto_the_normalised_vocabulary() {
        assert_eq!(map_stop_reason("stop"), StopReason::EndTurn);
        assert_eq!(map_stop_reason("length"), StopReason::MaxTokens);
        assert_eq!(map_stop_reason("tool_calls"), StopReason::ToolUse);
        assert_eq!(map_stop_reason("something-new"), StopReason::Unspecified);
    }
}
