//! Normalising a Gemini `GenerateContentResponse` — streamed or not — into the
//! one event stream.
//!
//! # The shape this file consumes
//!
//! ```text
//! data: {"candidates":[{"content":{"role":"model","parts":[
//!          {"text":"Let me think.","thought":true},
//!          {"text":"","thought":true,"thoughtSignature":"CtcBAd…"},
//!          {"text":"Hello"},
//!          {"functionCall":{"name":"get_weather","args":{"city":"Berlin"}}}]},
//!        "finishReason":"STOP","safetyRatings":[…]}],
//!        "usageMetadata":{"promptTokenCount":25,"candidatesTokenCount":15,
//!                         "thoughtsTokenCount":57,"cachedContentTokenCount":0}}
//! ```
//!
//! …or, with nothing in it at all:
//!
//! ```text
//! data: {"promptFeedback":{"blockReason":"SAFETY","safetyRatings":[…]}}
//! ```
//!
//! # THE LOAD-BEARING RULES OF THIS FILE
//!
//! * **A block is never an empty answer.** Both a `promptFeedback.blockReason`
//!   and a filtering `finishReason` end the turn as a
//!   [`ProviderError`](crate::error::ProviderError) whose detail says, in
//!   English, what was refused and how much had already been generated. See
//!   [`blocked_error`]. A consumer that renders `candidates[0].content.parts`
//!   and shrugs shows the user a blank bubble and no reason for it.
//! * **MEASURED-1 — end-of-body terminates.** This API sends *no* terminator at
//!   all: no `[DONE]`, no stop event, nothing. The body simply ends. Its only
//!   completeness signal is a `finishReason`, so a stream that ends without one
//!   produces a [`Degradation::NoTerminationSentinel`], never a hang. The stall
//!   timeout lives one level up, in the provider's read loop.
//! * **MEASURED-2 — a bad frame costs one frame.** Unparseable JSON, a frame
//!   that is not an object, a part whose inline bytes will not decode: each is
//!   skipped and counted, and everything already accumulated survives.
//! * **MEASURED-3 — reasoning is separated across the whole stream.** This API
//!   marks its own reasoning with `"thought": true`, which is kept as a distinct
//!   [`ContentPart::Reasoning`] carrying its `thoughtSignature`. Ordinary text
//!   is *still* routed through [`ReasoningSplitter`], because a reasoning model
//!   with thoughts suppressed leaks `<think>` markup into visible output and no
//!   single frame contains the closing tag.
//! * **MEASURED-4 — tool calls accumulate defensively**, through the shared
//!   [`ToolCallAccumulator`]. This API delivers a whole `functionCall` per part,
//!   which is exactly the situation in which it is tempting to skip the
//!   accumulator and trust the payload — and `finishReason:
//!   MALFORMED_FUNCTION_CALL` is the endpoint saying it produced one that
//!   cannot be trusted.

use serde_json::Value;

use crate::answer::AnswerChannel;
use crate::diagnostic::{Cause, EndpointIdentity};
use crate::error::{ProviderError, ProviderResult};
use crate::event::{EventSink, StreamEvent};
use crate::model::{
    ChatResponse, Degradation, MalformedToolCall, StopReason, TokenUsage, ToolCallOutcome,
};
use crate::reasoning::{ReasoningPiece, ReasoningSplitter};
use crate::redact::Scrubber;
use crate::sse::SseDecoder;
use crate::tool_accum::{ToolCallAccumulator, ToolCallShape};

use super::wire::base64_decode;
use super::{blocked_error, map_error_object, Blocked};

/// Longest evidence string kept for a call the endpoint itself declared
/// malformed. Shown to the user, so bounded like any other detail string.
const MAX_MALFORMED_EVIDENCE: usize = 400;

/// The finished turn, plus the two things the provider needs that
/// [`ChatResponse`] deliberately has no field for.
#[derive(Debug, Clone, PartialEq)]
pub struct AssembledCandidate {
    pub response: ChatResponse,
    /// The endpoint reported cached-input accounting in `usageMetadata`. The
    /// only honest evidence that prompt caching happened at all.
    pub cache_accounting_reported: bool,
    /// The endpoint reported a thinking-token count, which is evidence the
    /// model reasons even when the thoughts themselves were not returned.
    pub thinking_accounting_reported: bool,
}

pub struct CandidateAssembler {
    sse: SseDecoder,
    splitter: ReasoningSplitter,
    tools: ToolCallAccumulator,
    /// Everything the user is shown, and the only text a tool parser may see.
    /// Not a `Vec<ContentPart>`: see [`crate::answer`].
    answer: AnswerChannel,
    usage: TokenUsage,
    stop_reason: Option<StopReason>,
    /// Frames — and parts — that could not be read and were skipped.
    malformed_frames: usize,
    saw_usage: bool,
    saw_finish_reason: bool,
    cache_accounting: bool,
    thinking_accounting: bool,
    streamed: bool,
    /// An `error` object inside an otherwise-200 body.
    stream_error: Option<ProviderError>,
    /// The endpoint this stream answers, for errors that arrive inside a 200.
    endpoint: Option<EndpointIdentity>,
    /// The request was refused before the model ran.
    prompt_block: Option<Blocked>,
    /// The answer was cut off by a filter: `(reason, categories)`.
    answer_block: Option<(String, Vec<String>)>,
    /// The endpoint said it produced a function call it could not encode.
    malformed_function_call: bool,
    /// Vela's own tool-call slot counter. This API sends whole calls in
    /// separate parts with no index of their own, so consecutive calls would
    /// otherwise merge into one slot.
    next_call_slot: u32,
    emulated_calls: Vec<ToolCallOutcome>,
    /// The credential material of the request this stream answers.
    ///
    /// The bytes arriving here have already been scrubbed by
    /// `BodyStream::next_chunk` — but that removes only the spelling it was
    /// shown, and this is the point where the bytes stop being bytes. Frames
    /// are decoded through this, so whatever encoding the endpoint used, the
    /// strings read out of a frame are clean. Attached by the drive loop,
    /// which is where the body is.
    scrubber: Scrubber,
}

impl CandidateAssembler {
    pub fn new(streamed: bool) -> Self {
        Self {
            sse: SseDecoder::new(),
            splitter: ReasoningSplitter::new(),
            tools: ToolCallAccumulator::new(),
            answer: AnswerChannel::new(),
            usage: TokenUsage::default(),
            stop_reason: None,
            malformed_frames: 0,
            saw_usage: false,
            saw_finish_reason: false,
            cache_accounting: false,
            thinking_accounting: false,
            streamed,
            stream_error: None,
            prompt_block: None,
            answer_block: None,
            malformed_function_call: false,
            next_call_slot: 0,
            emulated_calls: Vec::new(),
            scrubber: Scrubber::none(),
            endpoint: None,
        }
    }

    /// Attach the credential material of the request this stream answers, so
    /// the decode of every frame can scrub what the decoder reconstitutes.
    pub fn with_scrubber(mut self, scrubber: Scrubber) -> Self {
        self.scrubber = scrubber;
        self
    }

    /// Attach the endpoint this stream answers, so an error frame inside an
    /// otherwise-200 body still names the candidate that produced it.
    pub fn with_endpoint(mut self, endpoint: Option<EndpointIdentity>) -> Self {
        self.endpoint = endpoint;
        self
    }

    /// Name the endpoint on an error that arrived inside a 200 body, and file
    /// the frame that produced it in the local debug log.
    ///
    /// The frame is the *decoded and scrubbed* value, which is what the debug
    /// log is for: the endpoint's own words, kept on the user's machine, never
    /// carried into the error.
    fn record(&self, error: ProviderError, frame: &Value) -> ProviderError {
        let error = error.at(self.endpoint.clone());
        crate::debuglog::record_for(&error, || frame.to_string().into_bytes());
        error
    }

    /// Parse tool calls out of the answer text as well.
    ///
    /// Set only when the catalogue was rendered into the prompt because the
    /// model has no native function calling — see `emulation::emulate`. The
    /// channel is fed only answer text — never a thought — because a model's
    /// deliberation routinely describes a call it then does not make
    /// (`model::ChatMessage::tool_parse_text`).
    pub fn with_tool_emulation(mut self) -> Self {
        self.answer = std::mem::take(&mut self.answer).with_tool_emulation();
        self
    }

    /// Feed raw SSE bytes.
    pub fn push_bytes(&mut self, bytes: &[u8], sink: &mut dyn EventSink) {
        for frame in self.sse.push(bytes) {
            let data = frame.data.clone();
            self.apply_frame(&data, sink);
        }
    }

    fn apply_frame(&mut self, data: &str, sink: &mut dyn EventSink) {
        // This API sends no sentinel, but a proxy in the middle might add one.
        // Treated as the hint it is, never as a terminator (MEASURED-1).
        if data.trim() == "[DONE]" {
            return;
        }
        let Ok(value) = self.scrubber.decode_json_str(data) else {
            self.malformed_frames += 1;
            return;
        };
        self.apply_body(&value, sink);
    }

    /// Apply one decoded body: an object, or the JSON array the non-SSE
    /// streaming form produces. Both reach the same handler so a gateway that
    /// serves one shape cannot behave differently from one that serves the other.
    pub fn apply_body(&mut self, value: &Value, sink: &mut dyn EventSink) {
        match value {
            Value::Array(items) => {
                for item in items {
                    self.apply_body(item, sink);
                }
            }
            Value::Object(_) => self.apply_response(value, sink),
            _ => self.malformed_frames += 1,
        }
    }

    fn apply_response(&mut self, value: &Value, sink: &mut dyn EventSink) {
        if let Some(error) = value.get("error") {
            self.stream_error = Some(self.record(map_error_object(None, error), error));
            return;
        }

        if let Some(feedback) = value.get("promptFeedback") {
            if let Some(reason) = feedback.get("blockReason").and_then(Value::as_str) {
                self.prompt_block = Some(Blocked::prompt(
                    reason,
                    blocked_categories(feedback.get("safetyRatings")),
                ));
            }
        }

        self.read_usage(value.get("usageMetadata"), sink);

        // MEASURED-7 recorded `n: 3` silently yielding one choice; this API
        // behaves the same way unless `candidateCount` is set, which Vela does
        // not set. The first candidate is the answer; extras are ignored rather
        // than concatenated into one incoherent reply.
        let Some(candidate) =
            value
                .get("candidates")
                .and_then(Value::as_array)
                .and_then(|candidates| {
                    candidates
                        .iter()
                        .find(|candidate| {
                            candidate.get("index").and_then(Value::as_u64).unwrap_or(0) == 0
                        })
                        .or_else(|| candidates.first())
                })
        else {
            return;
        };

        if let Some(Value::Array(parts)) = candidate
            .get("content")
            .and_then(|content| content.get("parts"))
        {
            for part in parts {
                self.apply_part(part, sink);
            }
        }

        if let Some(reason) = candidate.get("finishReason").and_then(Value::as_str) {
            let categories = blocked_categories(candidate.get("safetyRatings"));
            self.apply_finish_reason(reason, categories);
        }
    }

    fn apply_part(&mut self, part: &Value, sink: &mut dyn EventSink) {
        let Some(object) = part.as_object() else {
            self.malformed_frames += 1;
            return;
        };

        if let Some(call) = object.get("functionCall") {
            self.apply_function_call(call, sink);
            return;
        }

        if let Some(text) = object.get("text").and_then(Value::as_str) {
            let is_thought = object
                .get("thought")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if is_thought {
                self.push_thought(
                    text,
                    object.get("thoughtSignature").and_then(Value::as_str),
                    sink,
                );
            } else {
                self.push_answer_text(text, sink);
            }
            return;
        }

        if let Some(inline) = object
            .get("inlineData")
            .or_else(|| object.get("inline_data"))
        {
            self.apply_inline_data(inline);
        }

        // `executableCode`, `codeExecutionResult`, `fileData`, and whatever a
        // later API version adds: not damage, just not something Vela's content
        // model has a place for. Skipped without being counted as breakage.
    }

    fn apply_function_call(&mut self, call: &Value, sink: &mut dyn EventSink) {
        let slot = self.next_call_slot;
        self.next_call_slot += 1;

        let name = call.get("name").and_then(Value::as_str).unwrap_or_default();
        // Sent as the accumulator's wire shape rather than parsed here, so this
        // adapter's calls go through exactly the defences MEASURED-4 demanded:
        // arguments that are not an object, or not JSON at all, become a
        // reported `Malformed` rather than something runnable.
        let arguments = match call.get("args") {
            Some(args) => args.to_string(),
            None => "{}".to_owned(),
        };
        let mut delta = serde_json::json!({
            "index": slot,
            "type": "function",
            "function": {"name": name, "arguments": arguments},
        });
        if let Some(id) = call
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            delta["id"] = Value::String(id.to_owned());
        }
        // A whole call: this API sends every `functionCall` complete, with no
        // index and nothing further to append. The slot number above is Vela's
        // own, assigned so a malformed call can still be reported by position.
        if let Some(emitted) = self.tools.push(&delta, ToolCallShape::WholeCall) {
            sink.emit(StreamEvent::ToolCallDelta { delta: emitted });
        }
    }

    fn apply_inline_data(&mut self, inline: &Value) {
        let mime_type = inline
            .get("mimeType")
            .or_else(|| inline.get("mime_type"))
            .and_then(Value::as_str)
            .unwrap_or("application/octet-stream");
        let encoded = inline
            .get("data")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match base64_decode(encoded) {
            Some(data) if !data.is_empty() => self.answer.push_image(mime_type.to_owned(), data),
            // Bytes that will not decode are damage. Counted rather than
            // dropped in silence, so the turn reports that something was lost.
            _ => self.malformed_frames += 1,
        }
    }

    fn apply_finish_reason(&mut self, reason: &str, categories: Vec<String>) {
        self.saw_finish_reason = true;
        match reason {
            "STOP" => self.stop_reason = Some(StopReason::EndTurn),
            "MAX_TOKENS" => self.stop_reason = Some(StopReason::MaxTokens),
            "SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII"
            | "IMAGE_SAFETY" | "LANGUAGE" => {
                self.answer_block = Some((reason.to_owned(), categories));
            }
            // The endpoint is telling us it emitted a call it could not encode.
            // Believed, and reported as a malformed call rather than quietly
            // dropped — this is MEASURED-4 arriving as a header instead of as a
            // broken payload.
            "MALFORMED_FUNCTION_CALL" | "UNEXPECTED_TOOL_CALL" => {
                self.malformed_function_call = true;
                self.stop_reason = Some(StopReason::ToolUse);
            }
            // `OTHER`, `FINISH_REASON_UNSPECIFIED`, and anything newer. Not
            // guessed into a content block: inventing a diagnosis is worse than
            // admitting there is none.
            _ => self.stop_reason = Some(StopReason::Unspecified),
        }
    }

    /// A `"thought": true` part: reasoning the endpoint separated for us.
    fn push_thought(&mut self, text: &str, signature: Option<&str>, sink: &mut dyn EventSink) {
        self.answer.push_reasoning(text, sink);
        // The signature usually arrives on its own trailing part, after the
        // text. Round-tripping it is not optional: a later turn that replays
        // the thought without it is rejected.
        if let Some(signature) = signature.filter(|signature| !signature.is_empty()) {
            self.answer.sign_last_reasoning(signature);
        }
    }

    /// Answer text, routed through the splitter so leaked reasoning markup
    /// never reaches the user even when a tag straddles two frames.
    fn push_answer_text(&mut self, text: &str, sink: &mut dyn EventSink) {
        for piece in self.splitter.push(text) {
            match piece {
                ReasoningPiece::Answer(text) => self.answer.push_answer(&text, sink),
                ReasoningPiece::Reasoning(text) => self.answer.push_reasoning(&text, sink),
            }
        }
    }

    fn read_usage(&mut self, value: Option<&Value>, sink: &mut dyn EventSink) {
        let Some(usage) = value.filter(|usage| usage.is_object()) else {
            return;
        };
        let field = |name: &str| {
            usage
                .get(name)
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok())
        };
        let mut changed = false;
        let mut set = |slot: &mut Option<u32>, value: Option<u32>| {
            if let Some(value) = value {
                *slot = Some(value);
                changed = true;
            }
        };
        set(&mut self.usage.input_tokens, field("promptTokenCount"));
        set(&mut self.usage.output_tokens, field("candidatesTokenCount"));
        set(
            &mut self.usage.reasoning_tokens,
            field("thoughtsTokenCount"),
        );
        set(
            &mut self.usage.cached_input_tokens,
            field("cachedContentTokenCount"),
        );

        // Presence, not magnitude: a zero still proves the endpoint understands
        // the field, which an endpoint that does neither would not report.
        if not_null(usage, "cachedContentTokenCount") {
            self.cache_accounting = true;
        }
        if not_null(usage, "thoughtsTokenCount") {
            self.thinking_accounting = true;
        }
        if changed {
            self.saw_usage = true;
            sink.emit(StreamEvent::Usage { usage: self.usage });
        }
    }

    /// End of body. Flushes held-back text, reports every degradation observed
    /// along the way, and turns a content block into a truthful error.
    pub fn finish(mut self, sink: &mut dyn EventSink) -> ProviderResult<AssembledCandidate> {
        for frame in self.sse.finish() {
            let data = frame.data.clone();
            self.apply_frame(&data, sink);
        }
        if let Some(error) = self.stream_error {
            return Err(error);
        }
        // A refused prompt cannot have an answer behind it, so nothing else in
        // this function could change what the user is told.
        if let Some(blocked) = &self.prompt_block {
            return Err(blocked_error(blocked).at(self.endpoint.clone()));
        }

        let mut degradations = Vec::new();

        let finish = self.splitter.finish();
        for piece in finish.pieces {
            match piece {
                ReasoningPiece::Answer(text) => self.answer.push_answer(&text, sink),
                ReasoningPiece::Reasoning(text) => self.answer.push_reasoning(&text, sink),
            }
        }
        // MEASURED-3: leaked markup that never closed must not swallow the
        // answer — and MEASURED-3b: what is rescued out of it is shown, never
        // run. The recovered text goes IN to the channel; it is never appended
        // behind its back. See `crate::answer`.
        let unterminated = finish.recovered_answer.is_some();
        let closed = self.answer.close(finish.recovered_answer.as_deref(), sink);
        if unterminated {
            degradations.push(Degradation::UnterminatedReasoning {
                recovered_answer_chars: closed.recovered_chars,
            });
        }
        self.emulated_calls = closed.calls;
        // Reported, never run. See `answer::Provenance::Salvaged`.
        self.emulated_calls.extend(closed.quarantined);

        // Now that every held-back character has been flushed, the count in the
        // block message is the number the user actually saw.
        if let Some((reason, categories)) = &self.answer_block {
            return Err(blocked_error(&Blocked::answer(
                reason.clone(),
                categories.clone(),
                self.answer.answer_chars(),
            )));
        }

        let mut tool_calls = self.tools.finish();
        tool_calls.append(&mut self.emulated_calls);
        if self.malformed_function_call && tool_calls.iter().all(ToolCallOutcome::is_ok) {
            // The endpoint declared a malformed call and sent no broken payload
            // to go with it. Reported anyway, with whatever text came back as
            // the evidence, because a silent no-op is the outcome MEASURED-4
            // forbids.
            tool_calls.push(ToolCallOutcome::Malformed {
                index: None,
                call_id: None,
                name: None,
                raw_arguments: truncate(&self.answer.visible_answer()),
                reason: MalformedToolCall::MissingName,
            });
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
        // This API has no terminator at all — the body just ends — so its only
        // statement of completeness is a `finishReason`. Its absence is the same
        // fact `[DONE]`'s absence was on the matrix endpoints (MEASURED-1).
        if self.streamed && !self.saw_finish_reason {
            degradations.push(Degradation::NoTerminationSentinel);
        }
        // Usage rides on every response from this API, so its absence is a real
        // reduction rather than a configuration Vela failed to ask for.
        if !self.saw_usage {
            degradations.push(Degradation::UsageNotReported);
        }

        let has_calls = tool_calls.iter().any(ToolCallOutcome::is_ok);
        let stop_reason = match self.stop_reason {
            // This API reports `STOP` for a turn that ended in a function call
            // — there is no `tool_use` reason in its vocabulary. Left as-is, a
            // consumer branching on the normalised `ToolUse` would never run
            // the tools it was just handed, so the presence of a well-formed
            // call is treated as the stronger fact.
            Some(StopReason::EndTurn) | None if has_calls => StopReason::ToolUse,
            Some(reason) => reason,
            None => StopReason::Unspecified,
        };

        // Nothing came back and nothing said why. That is not an answer.
        if self.answer.is_empty() && tool_calls.is_empty() && self.malformed_frames > 0 {
            return Err(ProviderError::malformed(Cause::StreamEndedWithoutAnswer));
        }

        // The parts AND the provenance boundary inside them: the salvaged
        // tail is shown to the user and subtracted before any machine consumer
        // reads the answer. See `answer::AnswerChannel::into_answer`.
        let content = self.answer.into_answer();
        Ok(AssembledCandidate {
            response: ChatResponse {
                parts: content.parts,
                tool_calls,
                stop_reason,
                usage: self.usage,
                structured: None,
                degradations,
                salvaged_answer: content.salvaged,
            },
            cache_accounting_reported: self.cache_accounting,
            thinking_accounting_reported: self.thinking_accounting,
        })
    }
}

/// The categories a `safetyRatings` array actually flagged.
///
/// Every rating is reported on every turn, blocked or not, so the array is
/// filtered by `blocked` rather than listed wholesale — otherwise a refusal for
/// hate speech would be described as flagging all five categories.
fn blocked_categories(ratings: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(ratings)) = ratings else {
        return Vec::new();
    };
    ratings
        .iter()
        .filter(|rating| {
            rating
                .get("blocked")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|rating| rating.get("category").and_then(Value::as_str))
        .map(str::to_owned)
        .collect()
}

fn not_null(usage: &Value, name: &str) -> bool {
    usage.get(name).is_some_and(|value| !value.is_null())
}

fn truncate(raw: &str) -> String {
    if raw.chars().count() <= MAX_MALFORMED_EVIDENCE {
        return raw.to_owned();
    }
    let mut out: String = raw.chars().take(MAX_MALFORMED_EVIDENCE).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::CollectingSink;
    use crate::model::ContentPart;
    use serde_json::json;

    fn frame(data: Value) -> String {
        format!("data: {data}\n\n")
    }

    fn assemble(body: &str) -> (CollectingSink, ProviderResult<AssembledCandidate>) {
        let mut sink = CollectingSink::new();
        let mut assembler = CandidateAssembler::new(true);
        // One byte at a time: the worst boundary a socket can hand us, and the
        // one that catches a frame-local parser.
        for byte in body.as_bytes() {
            assembler.push_bytes(&[*byte], &mut sink);
        }
        let assembled = assembler.finish(&mut sink);
        (sink, assembled)
    }

    fn text_chunk(text: &str) -> Value {
        json!({"candidates": [{"content": {"role": "model", "parts": [{"text": text}]}, "index": 0}]})
    }

    fn finish_chunk(reason: &str) -> Value {
        json!({
            "candidates": [{"content": {"role": "model", "parts": []},
                            "finishReason": reason, "index": 0}],
            "usageMetadata": {"promptTokenCount": 25, "candidatesTokenCount": 15,
                              "totalTokenCount": 40},
        })
    }

    fn plain_stream() -> String {
        format!(
            "{}{}{}",
            frame(text_chunk("Hello")),
            frame(text_chunk(", world")),
            frame(finish_chunk("STOP")),
        )
    }

    #[test]
    fn a_plain_turn_assembles_its_text_stop_reason_and_usage() {
        let (sink, assembled) = assemble(&plain_stream());
        let assembled = assembled.unwrap();
        assert_eq!(sink.text(), "Hello, world");
        assert_eq!(assembled.response.answer_text(), "Hello, world");
        assert_eq!(assembled.response.stop_reason, StopReason::EndTurn);
        assert_eq!(assembled.response.usage.input_tokens, Some(25));
        assert_eq!(assembled.response.usage.output_tokens, Some(15));
        assert!(
            assembled.response.degradations.is_empty(),
            "a healthy turn reports nothing: {:?}",
            assembled.response.degradations
        );
    }

    #[test]
    fn a_stream_that_ends_without_a_finish_reason_terminates_and_says_so() {
        // MEASURED-1. This API sends no sentinel of any kind, so the body
        // ending is the terminator and `finishReason` is the completeness claim.
        let truncated = format!(
            "{}{}",
            frame(text_chunk("Hello")),
            frame(text_chunk(", wor"))
        );
        let (sink, assembled) = assemble(&truncated);
        let assembled = assembled.unwrap();
        assert_eq!(sink.text(), "Hello, wor");
        assert!(assembled
            .response
            .degradations
            .contains(&Degradation::NoTerminationSentinel));
        assert!(assembled
            .response
            .degradations
            .contains(&Degradation::UsageNotReported));
    }

    #[test]
    fn unparseable_frames_cost_one_frame_each_and_nothing_else() {
        // MEASURED-2: the recorded naive consumer lost 318 of 349 characters
        // here. Everything that already arrived must survive.
        let body = format!(
            "{}{}{}{}{}",
            frame(text_chunk("one ")),
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\n\n",
            ": keepalive\n\ndata: not-json-at-all\n\n",
            frame(text_chunk("two")),
            frame(finish_chunk("STOP")),
        );
        let (sink, assembled) = assemble(&body);
        let assembled = assembled.unwrap();
        assert_eq!(sink.text(), "one two");
        assert!(
            assembled
                .response
                .degradations
                .contains(&Degradation::MalformedFramesSkipped { count: 2 }),
            "got {:?}",
            assembled.response.degradations
        );
    }

    #[test]
    fn a_response_of_nothing_but_garbage_is_an_error_not_an_empty_answer() {
        let (_, assembled) = assemble("data: not-json\n\ndata: also-not-json\n\n");
        assert!(matches!(
            assembled,
            Err(ProviderError::MalformedResponse { .. })
        ));
    }

    #[test]
    fn thought_parts_become_reasoning_and_keep_their_signature() {
        let body = format!(
            "{}{}{}{}{}",
            frame(json!({"candidates": [{"content": {"parts": [
                {"text": "Let me break", "thought": true}]}, "index": 0}]})),
            frame(json!({"candidates": [{"content": {"parts": [
                {"text": " this down", "thought": true}]}, "index": 0}]})),
            frame(json!({"candidates": [{"content": {"parts": [
                {"text": "", "thought": true, "thoughtSignature": "CtcBAdHtim"}]}, "index": 0}]})),
            frame(text_chunk("Based on my analysis")),
            frame(finish_chunk("STOP")),
        );
        let (sink, assembled) = assemble(&body);
        let assembled = assembled.unwrap();
        assert_eq!(sink.text(), "Based on my analysis");
        assert_eq!(sink.reasoning(), "Let me break this down");
        assert_eq!(assembled.response.answer_text(), "Based on my analysis");
        assert_eq!(
            assembled.response.parts[0],
            ContentPart::Reasoning {
                text: "Let me break this down".into(),
                signature: Some("CtcBAdHtim".into()),
                redacted: false,
            },
            "the signature must survive: a later turn has to send it back"
        );
    }

    #[test]
    fn leaked_think_markup_split_across_frames_never_reaches_the_answer() {
        // MEASURED-3: no single frame contains the closing tag, so a per-frame
        // stripper leaks it into the user's answer.
        let body = format!(
            "{}{}{}{}",
            frame(text_chunk("<thi")),
            frame(text_chunk("nk>leaked</thi")),
            frame(text_chunk("nk>the answer")),
            frame(finish_chunk("STOP")),
        );
        let (sink, assembled) = assemble(&body);
        let assembled = assembled.unwrap();
        assert_eq!(assembled.response.answer_text(), "the answer");
        assert_eq!(assembled.response.reasoning_text(), "leaked");
        assert!(!sink.text().contains("think"));
    }

    #[test]
    fn unterminated_leaked_markup_does_not_swallow_the_answer() {
        let body = format!(
            "{}{}",
            frame(text_chunk("<think>never closed but here is the answer")),
            frame(finish_chunk("STOP")),
        );
        let (_, assembled) = assemble(&body);
        let assembled = assembled.unwrap();
        assert!(
            assembled
                .response
                .degradations
                .iter()
                .any(|d| matches!(d, Degradation::UnterminatedReasoning { .. })),
            "got {:?}",
            assembled.response.degradations
        );
        assert!(
            !assembled.response.answer_text().is_empty(),
            "MEASURED-3: an unterminated block must not eat the whole turn"
        );
    }

    #[test]
    fn two_function_calls_in_one_turn_do_not_collapse_into_one() {
        // This API sends no index with a call, so a slot keyed on "the last one
        // touched" would merge them and produce a single corrupt call.
        let body = format!(
            "{}{}",
            frame(json!({"candidates": [{"content": {"parts": [
                {"functionCall": {"name": "get_weather", "args": {"city": "Berlin"}}},
                {"functionCall": {"name": "get_time", "args": {"zone": "CET"}}}]},
                "index": 0}]})),
            frame(finish_chunk("STOP")),
        );
        let (sink, assembled) = assemble(&body);
        let calls = assembled.unwrap().response.tool_calls;
        assert_eq!(calls.len(), 2, "got {calls:?}");
        assert_eq!(
            calls[0],
            ToolCallOutcome::Ok {
                call_id: "call_slot_0".into(),
                name: "get_weather".into(),
                arguments: json!({"city": "Berlin"}),
                emulated: false,
            }
        );
        assert_eq!(
            calls[1],
            ToolCallOutcome::Ok {
                call_id: "call_slot_1".into(),
                name: "get_time".into(),
                arguments: json!({"zone": "CET"}),
                emulated: false,
            }
        );
        assert!(sink
            .events
            .iter()
            .any(|event| matches!(event, StreamEvent::ToolCallDelta { .. })));
    }

    #[test]
    fn a_call_whose_arguments_are_not_an_object_is_reported_not_executed() {
        let body = format!(
            "{}{}",
            frame(json!({"candidates": [{"content": {"parts": [
                {"functionCall": {"name": "get_weather", "args": "berlin"}}]}, "index": 0}]})),
            frame(finish_chunk("STOP")),
        );
        let (_, assembled) = assemble(&body);
        let assembled = assembled.unwrap();
        assert!(matches!(
            &assembled.response.tool_calls[0],
            ToolCallOutcome::Malformed {
                reason: MalformedToolCall::ArgumentsNotAnObject,
                ..
            }
        ));
        assert_eq!(assembled.response.executable_tool_calls().count(), 0);
        assert!(assembled
            .response
            .degradations
            .contains(&Degradation::MalformedToolCalls { count: 1 }));
    }

    #[test]
    fn a_call_with_no_arguments_at_all_is_legitimate() {
        let body = format!(
            "{}{}",
            frame(json!({"candidates": [{"content": {"parts": [
                {"functionCall": {"name": "get_time"}}]}, "index": 0}]})),
            frame(finish_chunk("STOP")),
        );
        let (_, assembled) = assemble(&body);
        assert_eq!(
            assembled.unwrap().response.tool_calls[0],
            ToolCallOutcome::Ok {
                call_id: "call_slot_0".into(),
                name: "get_time".into(),
                arguments: json!({}),
                emulated: false,
            }
        );
    }

    #[test]
    fn a_malformed_function_call_finish_reason_is_reported_even_with_no_payload() {
        let body = format!(
            "{}{}",
            frame(text_chunk("get_weather(city=")),
            frame(json!({"candidates": [{"content": {"parts": []},
                                          "finishReason": "MALFORMED_FUNCTION_CALL", "index": 0}]})),
        );
        let (_, assembled) = assemble(&body);
        let assembled = assembled.unwrap();
        match &assembled.response.tool_calls[0] {
            ToolCallOutcome::Malformed { raw_arguments, .. } => {
                assert_eq!(raw_arguments, "get_weather(city=", "evidence is kept")
            }
            other => panic!("expected a reported malformed call, got {other:?}"),
        }
        assert!(assembled
            .response
            .degradations
            .contains(&Degradation::MalformedToolCalls { count: 1 }));
    }

    // -- content blocks ----------------------------------------------------

    #[test]
    fn a_blocked_prompt_is_an_error_that_says_why_not_an_empty_answer() {
        let body = frame(json!({"promptFeedback": {
            "blockReason": "SAFETY",
            "safetyRatings": [
                {"category": "HARM_CATEGORY_HATE_SPEECH", "probability": "HIGH", "blocked": true},
                {"category": "HARM_CATEGORY_HARASSMENT", "probability": "NEGLIGIBLE"},
            ],
        }}));
        let (_, assembled) = assemble(&body);
        let error = assembled.expect_err("a refused prompt is not a successful empty turn");
        let rendered = format!("{error}");
        assert!(rendered.contains("safety filter"), "{rendered}");
        assert!(rendered.contains("before the model saw it"), "{rendered}");
        assert!(
            rendered.contains("hate speech") && !rendered.contains("harassment"),
            "only the categories that actually blocked are named: {rendered}"
        );
    }

    #[test]
    fn an_answer_cut_off_by_a_filter_reports_how_much_the_user_saw() {
        let body = format!(
            "{}{}",
            frame(text_chunk("Here is how to")),
            frame(json!({"candidates": [{"content": {"parts": []},
                "finishReason": "SAFETY", "index": 0,
                "safetyRatings": [{"category": "HARM_CATEGORY_DANGEROUS_CONTENT",
                                   "probability": "HIGH", "blocked": true}]}]})),
        );
        let (sink, assembled) = assemble(&body);
        assert_eq!(
            sink.text(),
            "Here is how to",
            "what already streamed still streamed"
        );
        let error = assembled.expect_err("a filtered answer must not look complete");
        let rendered = format!("{error}");
        assert!(rendered.contains("after 14 characters"), "{rendered}");
        assert!(rendered.contains("dangerous content"), "{rendered}");
    }

    #[test]
    fn a_recitation_stop_is_explained_rather_than_passed_off_as_a_normal_end() {
        let body = format!(
            "{}{}",
            frame(text_chunk("Four score and seven years ago")),
            frame(json!({"candidates": [{"content": {"parts": []},
                                          "finishReason": "RECITATION", "index": 0}]})),
        );
        let (_, assembled) = assemble(&body);
        let rendered = format!("{}", assembled.unwrap_err());
        assert!(rendered.contains("memorised text"), "{rendered}");
    }

    #[test]
    fn a_prompt_block_wins_over_everything_else_in_the_body() {
        let body = format!(
            "{}{}",
            frame(json!({"promptFeedback": {"blockReason": "PROHIBITED_CONTENT"}})),
            frame(finish_chunk("STOP")),
        );
        let (_, assembled) = assemble(&body);
        let rendered = format!("{}", assembled.unwrap_err());
        assert!(rendered.contains("prohibited-content filter"), "{rendered}");
    }

    #[test]
    fn an_error_object_inside_a_200_body_becomes_a_provider_error() {
        let body = frame(json!({"error": {
            "code": 503, "message": "The model is overloaded.", "status": "UNAVAILABLE"}}));
        let (_, assembled) = assemble(&body);
        assert!(matches!(assembled, Err(ProviderError::Transport { .. })));
    }

    // -- other -------------------------------------------------------------

    #[test]
    fn cache_and_thinking_accounting_are_noticed_even_when_the_counts_are_zero() {
        let body = format!(
            "{}{}",
            frame(text_chunk("hi")),
            frame(json!({
                "candidates": [{"content": {"parts": []}, "finishReason": "STOP", "index": 0}],
                "usageMetadata": {"promptTokenCount": 4, "candidatesTokenCount": 2,
                                  "cachedContentTokenCount": 0, "thoughtsTokenCount": 0},
            })),
        );
        let (_, assembled) = assemble(&body);
        let assembled = assembled.unwrap();
        assert!(assembled.cache_accounting_reported);
        assert!(assembled.thinking_accounting_reported);
        assert_eq!(assembled.response.usage.cached_input_tokens, Some(0));
    }

    #[test]
    fn an_image_part_in_the_answer_is_decoded_into_bytes() {
        let body = format!(
            "{}{}",
            frame(json!({"candidates": [{"content": {"parts": [
                {"inlineData": {"mimeType": "image/png", "data": "iVBO"}}]}, "index": 0}]})),
            frame(finish_chunk("STOP")),
        );
        let (_, assembled) = assemble(&body);
        assert_eq!(
            assembled.unwrap().response.parts[0],
            ContentPart::Image {
                mime_type: "image/png".into(),
                data: vec![0x89, 0x50, 0x4e],
            }
        );
    }

    #[test]
    fn inline_bytes_that_will_not_decode_are_counted_rather_than_dropped_in_silence() {
        let body = format!(
            "{}{}{}",
            frame(text_chunk("here")),
            frame(json!({"candidates": [{"content": {"parts": [
                {"inlineData": {"mimeType": "image/png", "data": "not*base64"}}]}, "index": 0}]})),
            frame(finish_chunk("STOP")),
        );
        let (_, assembled) = assemble(&body);
        assert!(assembled
            .unwrap()
            .response
            .degradations
            .contains(&Degradation::MalformedFramesSkipped { count: 1 }));
    }

    #[test]
    fn a_part_type_from_a_later_api_version_is_ignored_rather_than_treated_as_damage() {
        let body = format!(
            "{}{}",
            frame(json!({"candidates": [{"content": {"parts": [
                {"executableCode": {"language": "PYTHON", "code": "print(1)"}}]}, "index": 0}]})),
            frame(finish_chunk("STOP")),
        );
        let (_, assembled) = assemble(&body);
        let assembled = assembled.unwrap();
        assert_eq!(assembled.response.answer_text(), "");
        assert!(
            !assembled
                .response
                .degradations
                .iter()
                .any(|d| matches!(d, Degradation::MalformedFramesSkipped { .. })),
            "a newer API version is not a broken endpoint"
        );
    }

    #[test]
    fn the_non_streamed_body_produces_the_same_shape_as_the_stream() {
        let mut sink = CollectingSink::new();
        let mut assembler = CandidateAssembler::new(false);
        assembler.apply_body(
            &json!({
                "candidates": [{
                    "content": {"role": "model", "parts": [
                        {"text": "deliberating", "thought": true, "thoughtSignature": "sig"},
                        {"text": "Hello, world"},
                        {"functionCall": {"name": "get_weather", "args": {"city": "Berlin"}}},
                    ]},
                    "finishReason": "STOP",
                    "index": 0,
                }],
                "usageMetadata": {"promptTokenCount": 25, "candidatesTokenCount": 15},
            }),
            &mut sink,
        );
        let assembled = assembler.finish(&mut sink).unwrap();
        assert_eq!(assembled.response.answer_text(), "Hello, world");
        assert_eq!(assembled.response.reasoning_text(), "deliberating");
        assert_eq!(assembled.response.stop_reason, StopReason::ToolUse);
        assert_eq!(
            assembled.response.tool_calls,
            vec![ToolCallOutcome::Ok {
                call_id: "call_slot_0".into(),
                name: "get_weather".into(),
                arguments: json!({"city": "Berlin"}),
                emulated: false,
            }]
        );
        assert!(
            !assembled
                .response
                .degradations
                .contains(&Degradation::NoTerminationSentinel),
            "a non-streamed body has no sentinel to miss"
        );
    }

    #[test]
    fn a_second_candidate_is_ignored_rather_than_spliced_into_the_first() {
        let mut sink = CollectingSink::new();
        let mut assembler = CandidateAssembler::new(false);
        assembler.apply_body(
            &json!({"candidates": [
                {"content": {"parts": [{"text": "chosen"}]}, "finishReason": "STOP", "index": 0},
                {"content": {"parts": [{"text": "alternative"}]}, "finishReason": "STOP",
                 "index": 1},
            ]}),
            &mut sink,
        );
        let assembled = assembler.finish(&mut sink).unwrap();
        assert_eq!(assembled.response.answer_text(), "chosen");
    }

    #[test]
    fn a_stop_that_carried_a_function_call_is_normalised_to_tool_use() {
        let mut sink = CollectingSink::new();
        let mut assembler = CandidateAssembler::new(false);
        assembler.apply_body(
            &json!({"candidates": [{"content": {"parts": [
                {"functionCall": {"name": "get_time", "args": {}}}]},
                "finishReason": "STOP", "index": 0}]}),
            &mut sink,
        );
        assert_eq!(
            assembler.finish(&mut sink).unwrap().response.stop_reason,
            StopReason::ToolUse,
            "this API has no tool-use finish reason, and a consumer that waits \
             for one would never run the call"
        );
    }

    #[test]
    fn stop_reasons_map_onto_the_normalised_vocabulary() {
        for (wire, expected) in [
            ("STOP", StopReason::EndTurn),
            ("MAX_TOKENS", StopReason::MaxTokens),
            ("OTHER", StopReason::Unspecified),
            ("SOMETHING_NEW", StopReason::Unspecified),
        ] {
            let mut sink = CollectingSink::new();
            let mut assembler = CandidateAssembler::new(false);
            assembler.apply_body(
                &json!({"candidates": [{"content": {"parts": [{"text": "x"}]},
                                        "finishReason": wire, "index": 0}]}),
                &mut sink,
            );
            assert_eq!(
                assembler.finish(&mut sink).unwrap().response.stop_reason,
                expected,
                "{wire}"
            );
        }
    }
}
