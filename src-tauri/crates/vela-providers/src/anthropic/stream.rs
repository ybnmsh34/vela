//! Normalising an Anthropic Messages response — streamed or not — into the one
//! event stream.
//!
//! # The event shape this file consumes
//!
//! ```text
//! message_start        {"message":{"usage":{"input_tokens":25,…}}}
//! content_block_start  {"index":0,"content_block":{"type":"thinking",…}}
//! content_block_delta  {"index":0,"delta":{"type":"thinking_delta","thinking":"…"}}
//! content_block_delta  {"index":0,"delta":{"type":"signature_delta","signature":"…"}}
//! content_block_stop   {"index":0}
//! content_block_start  {"index":1,"content_block":{"type":"text","text":""}}
//! content_block_delta  {"index":1,"delta":{"type":"text_delta","text":"Hi"}}
//! content_block_stop   {"index":1}
//! message_delta        {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}
//! message_stop         {}
//! ```
//!
//! # THE LOAD-BEARING RULES OF THIS FILE
//!
//! Every one of them is a MEASURED requirement from
//! `docs/regression-baseline/mock-matrix/`, applied here even though this wire
//! format has its own terminator. The measured behaviour is about what *broken
//! endpoints do*, and nothing makes this endpoint immune to being broken, or
//! proxied, or truncated by a network.
//!
//! * **MEASURED-1 — end-of-body terminates.** `message_stop` sets a flag and
//!   nothing else. A stream that never sends one produces a
//!   [`Degradation::NoTerminationSentinel`], not a hang; usage that never
//!   arrives produces [`Degradation::UsageNotReported`], not a hang. The stall
//!   timeout lives one level up, in [`drive_stream`](crate::stream::drive_stream),
//!   which this assembler is driven by.
//! * **MEASURED-2 — a bad frame costs one frame.** Unparseable JSON, a frame
//!   that is not an object, an event type from a future API version: each is
//!   skipped, counted where it is genuinely malformed, and everything already
//!   accumulated survives.
//! * **MEASURED-3 — reasoning is separated across the whole stream.** This API
//!   separates it for us with `thinking` blocks, which are kept as distinct
//!   [`ContentPart::Reasoning`] parts carrying their signature. Text blocks are
//!   *still* routed through [`ReasoningSplitter`], because a reasoning model
//!   with thinking suppressed is documented to leak `<think>` markup into
//!   visible output (spec THK-10) and a frame-local stripper would leak it to
//!   the user.
//! * **MEASURED-4 — tool calls accumulate defensively**, through the shared
//!   [`ToolCallAccumulator`]: block indices are mapped to Vela's own slots and
//!   never used as array offsets, and a call that will not parse becomes a
//!   reported [`ToolCallOutcome::Malformed`] rather than a silent no-op.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::answer::AnswerChannel;
use crate::diagnostic::{Cause, EndpointIdentity};
use crate::error::{ProviderError, ProviderResult};
use crate::event::{EventSink, StreamEvent};
use crate::model::{ChatResponse, Degradation, StopReason, TokenUsage, ToolCallOutcome};
use crate::reasoning::{ReasoningPiece, ReasoningSplitter};
use crate::redact::Scrubber;
use crate::sse::SseDecoder;
use crate::tool_accum::{ToolCallAccumulator, ToolCallShape};

use super::map_error_object;

/// The finished turn, plus the two things the provider needs that
/// [`ChatResponse`] deliberately has no field for.
#[derive(Debug, Clone, PartialEq)]
pub struct AssembledMessage {
    pub response: ChatResponse,
    /// Input of the internal structured-output tool, when the model called it.
    /// Never reported as a tool call: it is Vela's own affordance, not the
    /// user's.
    pub schema_tool_input: Option<Value>,
    /// The same call, when it could not be reconstructed. Kept so the reported
    /// mismatch can show what actually arrived.
    pub schema_tool_raw: Option<String>,
    /// The endpoint reported cache accounting in `usage`. The only honest
    /// evidence that prompt caching is understood at all.
    pub cache_accounting_reported: bool,
}

/// What is currently open at a given content-block index.
#[derive(Debug)]
enum OpenBlock {
    Text,
    Thinking {
        text: String,
        signature: Option<String>,
    },
    ToolUse,
    /// A block type from a newer API version. Its deltas are ignored rather
    /// than counted as damage.
    Ignored,
}

pub struct MessageAssembler {
    sse: SseDecoder,
    splitter: ReasoningSplitter,
    tools: ToolCallAccumulator,
    blocks: BTreeMap<u64, OpenBlock>,
    /// Everything the user is shown, and the only text a tool parser may see.
    /// Not a `Vec<ContentPart>`: see [`crate::answer`]. This API has no
    /// emulated tool calling, so nothing here is stripped — but the channel is
    /// what makes that a property of the *turn* rather than of whether this
    /// file remembered to call the right private method, which is precisely
    /// what the OpenAI-compatible assembler stopped doing.
    answer: AnswerChannel,
    usage: TokenUsage,
    stop_reason: Option<StopReason>,
    malformed_frames: usize,
    saw_message_stop: bool,
    saw_usage: bool,
    cache_accounting: bool,
    streamed: bool,
    /// An `error` event inside an otherwise-200 stream.
    stream_error: Option<ProviderError>,
    /// The endpoint this stream answers, for errors that arrive inside a 200.
    endpoint: Option<EndpointIdentity>,
    /// The internal structured-output tool, when one was injected.
    schema_tool: Option<&'static str>,
    /// A thinking block that never got its `content_block_stop`.
    unterminated_reasoning: bool,
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

impl MessageAssembler {
    pub fn new(streamed: bool) -> Self {
        Self {
            sse: SseDecoder::new(),
            splitter: ReasoningSplitter::new(),
            tools: ToolCallAccumulator::new(),
            blocks: BTreeMap::new(),
            answer: AnswerChannel::new(),
            usage: TokenUsage::default(),
            stop_reason: None,
            malformed_frames: 0,
            saw_message_stop: false,
            saw_usage: false,
            cache_accounting: false,
            streamed,
            stream_error: None,
            schema_tool: None,
            unterminated_reasoning: false,
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

    /// Consume a call to the named tool as structured output instead of
    /// reporting it as a tool call.
    pub fn with_schema_tool(mut self, name: &'static str) -> Self {
        self.schema_tool = Some(name);
        self
    }

    /// Feed raw SSE bytes.
    pub fn push_bytes(&mut self, bytes: &[u8], sink: &mut dyn EventSink) {
        for frame in self.sse.push(bytes) {
            let (event, data) = (frame.event.clone(), frame.data.clone());
            self.apply_frame(event.as_deref(), &data, sink);
        }
    }

    fn apply_frame(&mut self, event: Option<&str>, data: &str, sink: &mut dyn EventSink) {
        // This API does not use `[DONE]`, but a proxy in the middle might add
        // one. Treated as the hint it is, never as a terminator.
        if data.trim() == "[DONE]" {
            self.saw_message_stop = true;
            return;
        }
        let Ok(value) = self.scrubber.decode_json_str(data) else {
            self.malformed_frames += 1;
            return;
        };
        let Some(object) = value.as_object() else {
            self.malformed_frames += 1;
            return;
        };
        // The payload's own `type` is authoritative; the SSE `event:` name is
        // the fallback, because the two are documented to agree and a frame
        // that lost one still carries the other.
        let kind = object
            .get("type")
            .and_then(Value::as_str)
            .or(event)
            .unwrap_or_default()
            .to_owned();
        self.apply_event(&kind, &value, sink);
    }

    /// Apply one decoded event object.
    pub fn apply_event(&mut self, kind: &str, value: &Value, sink: &mut dyn EventSink) {
        match kind {
            "message_start" => {
                if let Some(message) = value.get("message") {
                    self.read_usage(message.get("usage"), sink);
                    self.read_stop_reason(message.get("stop_reason"));
                }
            }
            "content_block_start" => {
                let index = block_index(value);
                if let Some(block) = value.get("content_block") {
                    self.start_block(index, block, sink);
                }
            }
            "content_block_delta" => {
                let index = block_index(value);
                if let Some(delta) = value.get("delta") {
                    self.apply_delta(index, delta, sink);
                }
            }
            "content_block_stop" => self.stop_block(block_index(value)),
            "message_delta" => {
                if let Some(delta) = value.get("delta") {
                    self.read_stop_reason(delta.get("stop_reason"));
                }
                self.read_usage(value.get("usage"), sink);
            }
            "message_stop" => self.saw_message_stop = true,
            "error" => {
                if let Some(error) = value.get("error") {
                    self.stream_error = Some(self.record(map_error_object(None, error), error));
                }
            }
            // `ping`, and anything a later API version adds. Not damage.
            _ => {}
        }
    }

    /// Apply a complete non-streaming message body. The same block handlers as
    /// the streaming path, so the two cannot drift.
    pub fn apply_message(&mut self, message: &Value, sink: &mut dyn EventSink) {
        if let Some(error) = message.get("error") {
            self.stream_error = Some(self.record(map_error_object(None, error), error));
            return;
        }
        self.read_usage(message.get("usage"), sink);
        self.read_stop_reason(message.get("stop_reason"));
        match message.get("content") {
            Some(Value::Array(blocks)) => {
                for (index, block) in blocks.iter().enumerate() {
                    let index = index as u64;
                    self.start_block(index, block, sink);
                    self.stop_block(index);
                }
            }
            // A body with no content array at all is not a message.
            _ => self.malformed_frames += 1,
        }
    }

    fn start_block(&mut self, index: u64, block: &Value, sink: &mut dyn EventSink) {
        let kind = block
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            "text" => {
                self.blocks.insert(index, OpenBlock::Text);
                // Non-streaming carries the whole text here.
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    self.push_answer_text(text, sink);
                }
            }
            "thinking" => {
                let text = block
                    .get("thinking")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !text.is_empty() {
                    sink.emit(StreamEvent::ReasoningDelta {
                        text: text.to_owned(),
                    });
                }
                self.blocks.insert(
                    index,
                    OpenBlock::Thinking {
                        text: text.to_owned(),
                        signature: block
                            .get("signature")
                            .and_then(Value::as_str)
                            .filter(|signature| !signature.is_empty())
                            .map(str::to_owned),
                    },
                );
            }
            "redacted_thinking" => {
                // Opaque encrypted bytes. Stored so the next turn can send them
                // back unchanged (THK-8), never emitted as reasoning text: it
                // is not text, and showing it would be showing the user noise.
                let data = block
                    .get("data")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                self.answer
                    .push_reasoning_block(data.to_owned(), None, true);
                self.blocks.insert(index, OpenBlock::Ignored);
            }
            "tool_use" => {
                self.blocks.insert(index, OpenBlock::ToolUse);
                let mut delta = serde_json::json!({
                    "index": index,
                    "type": "function",
                    "function": {"name": block.get("name").and_then(Value::as_str).unwrap_or_default()},
                });
                if let Some(id) = block.get("id").and_then(Value::as_str) {
                    delta["id"] = Value::String(id.to_owned());
                }
                // Non-streaming carries the whole input here; streaming sends
                // `{}` and then `input_json_delta` fragments.
                if let Some(input) = block
                    .get("input")
                    .filter(|input| input.as_object().is_some_and(|object| !object.is_empty()))
                {
                    delta["function"]["arguments"] = Value::String(input.to_string());
                }
                // A fragment even when it arrives complete: on the streaming
                // path the `input_json_delta`s that finish this call are still
                // to come, and the content-block index is what joins them to it.
                if let Some(emitted) = self.tools.push(&delta, ToolCallShape::Fragment) {
                    sink.emit(StreamEvent::ToolCallDelta { delta: emitted });
                }
            }
            _ => {
                self.blocks.insert(index, OpenBlock::Ignored);
            }
        }
    }

    fn apply_delta(&mut self, index: u64, delta: &Value, sink: &mut dyn EventSink) {
        let kind = delta
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            "text_delta" => {
                if matches!(self.blocks.get(&index), Some(OpenBlock::Ignored)) {
                    return;
                }
                if let Some(text) = delta.get("text").and_then(Value::as_str) {
                    self.push_answer_text(text, sink);
                }
            }
            "thinking_delta" => {
                let Some(text) = delta.get("thinking").and_then(Value::as_str) else {
                    return;
                };
                if text.is_empty() {
                    return;
                }
                match self.blocks.get_mut(&index) {
                    Some(OpenBlock::Thinking { text: existing, .. }) => existing.push_str(text),
                    // A delta for a block whose start never arrived. Keep the
                    // content rather than discarding it (MEASURED-2).
                    _ => {
                        self.blocks.insert(
                            index,
                            OpenBlock::Thinking {
                                text: text.to_owned(),
                                signature: None,
                            },
                        );
                    }
                }
                sink.emit(StreamEvent::ReasoningDelta {
                    text: text.to_owned(),
                });
            }
            "signature_delta" => {
                let Some(value) = delta.get("signature").and_then(Value::as_str) else {
                    return;
                };
                if value.is_empty() {
                    return;
                }
                match self.blocks.get_mut(&index) {
                    Some(OpenBlock::Thinking { signature, .. }) => {
                        signature.get_or_insert_with(|| value.to_owned());
                    }
                    _ => {
                        self.blocks.insert(
                            index,
                            OpenBlock::Thinking {
                                text: String::new(),
                                signature: Some(value.to_owned()),
                            },
                        );
                    }
                }
            }
            "input_json_delta" => {
                let partial = delta
                    .get("partial_json")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let fragment = serde_json::json!({
                    "index": index,
                    "function": {"arguments": partial},
                });
                if let Some(emitted) = self.tools.push(&fragment, ToolCallShape::Fragment) {
                    sink.emit(StreamEvent::ToolCallDelta { delta: emitted });
                }
            }
            // A delta type from a later API version.
            _ => {}
        }
    }

    fn stop_block(&mut self, index: u64) {
        if let Some(OpenBlock::Thinking { text, signature }) = self.blocks.remove(&index) {
            self.answer.push_reasoning_block(text, signature, false);
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

    fn read_stop_reason(&mut self, value: Option<&Value>) {
        if let Some(reason) = value.and_then(Value::as_str) {
            self.stop_reason = Some(map_stop_reason(reason));
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
        set(&mut self.usage.input_tokens, field("input_tokens"));
        set(&mut self.usage.output_tokens, field("output_tokens"));
        set(
            &mut self.usage.cached_input_tokens,
            field("cache_read_input_tokens"),
        );
        set(
            &mut self.usage.reasoning_tokens,
            usage
                .get("output_tokens_details")
                .and_then(|details| details.get("thinking_tokens"))
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok()),
        );
        // Presence, not magnitude: a zero cache read still proves the endpoint
        // understands the field, which a model that ignores `cache_control`
        // would not report at all.
        if usage
            .get("cache_read_input_tokens")
            .is_some_and(|v| !v.is_null())
            || usage
                .get("cache_creation_input_tokens")
                .is_some_and(|v| !v.is_null())
        {
            self.cache_accounting = true;
        }
        if changed {
            self.saw_usage = true;
            sink.emit(StreamEvent::Usage { usage: self.usage });
        }
    }

    /// End of body. Flushes held-back text, closes anything still open, and
    /// reports every degradation observed along the way.
    pub fn finish(mut self, sink: &mut dyn EventSink) -> ProviderResult<AssembledMessage> {
        for frame in self.sse.finish() {
            let (event, data) = (frame.event.clone(), frame.data.clone());
            self.apply_frame(event.as_deref(), &data, sink);
        }
        if let Some(error) = self.stream_error {
            return Err(error);
        }

        let mut degradations = Vec::new();

        // Any block still open when the body ended. Its content is kept — the
        // stream was cut, which is not a reason to discard what arrived.
        let open: Vec<u64> = self.blocks.keys().copied().collect();
        for index in open {
            if matches!(self.blocks.get(&index), Some(OpenBlock::Thinking { .. })) {
                self.unterminated_reasoning = true;
            }
            self.stop_block(index);
        }

        let finish = self.splitter.finish();
        for piece in finish.pieces {
            match piece {
                ReasoningPiece::Answer(text) => self.answer.push_answer(&text, sink),
                ReasoningPiece::Reasoning(text) => self.answer.push_reasoning(&text, sink),
            }
        }
        // MEASURED-3: leaked markup that never closed must not swallow the
        // answer — and MEASURED-3b: the recovered text goes IN to the channel,
        // never appended behind its back. See `crate::answer`.
        let unterminated = finish.recovered_answer.is_some();
        let closed = self.answer.close(finish.recovered_answer.as_deref(), sink);
        // This API has native tool calling, so the channel is never given a
        // stripper and these are always empty. Asserted rather than assumed:
        // if emulation is ever attached here, the calls must not vanish.
        debug_assert!(closed.calls.is_empty() && closed.quarantined.is_empty());
        let mut text_calls = closed.calls;
        text_calls.extend(closed.quarantined);
        if unterminated {
            degradations.push(Degradation::UnterminatedReasoning {
                recovered_answer_chars: closed.recovered_chars,
            });
        } else if self.unterminated_reasoning {
            degradations.push(Degradation::UnterminatedReasoning {
                recovered_answer_chars: 0,
            });
        }

        let mut tool_calls = self.tools.finish();
        tool_calls.extend(text_calls);
        let mut schema_tool_input = None;
        let mut schema_tool_raw = None;
        if let Some(name) = self.schema_tool {
            tool_calls.retain(|call| match call {
                ToolCallOutcome::Ok {
                    name: called,
                    arguments,
                    ..
                } if called == name => {
                    schema_tool_input = Some(arguments.clone());
                    false
                }
                ToolCallOutcome::Malformed {
                    name: Some(called),
                    raw_arguments,
                    ..
                } if called == name => {
                    schema_tool_raw = Some(raw_arguments.clone());
                    false
                }
                _ => true,
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
        if self.streamed && !self.saw_message_stop {
            degradations.push(Degradation::NoTerminationSentinel);
        }
        // This API reports usage on every turn, so its absence is a real
        // reduction rather than a configuration Vela failed to ask for.
        if !self.saw_usage {
            degradations.push(Degradation::UsageNotReported);
        }

        let stop_reason = self.stop_reason.unwrap_or_else(|| {
            if tool_calls.iter().any(ToolCallOutcome::is_ok) {
                StopReason::ToolUse
            } else {
                StopReason::Unspecified
            }
        });

        // Nothing came back and nothing said why. That is not an answer.
        if self.answer.is_empty()
            && tool_calls.is_empty()
            && schema_tool_input.is_none()
            && schema_tool_raw.is_none()
            && self.malformed_frames > 0
        {
            return Err(ProviderError::malformed(Cause::StreamEndedWithoutAnswer));
        }

        Ok(AssembledMessage {
            response: ChatResponse {
                parts: self.answer.into_parts(),
                tool_calls,
                stop_reason,
                usage: self.usage,
                structured: None,
                degradations,
            },
            schema_tool_input,
            schema_tool_raw,
            cache_accounting_reported: self.cache_accounting,
        })
    }
}

fn block_index(value: &Value) -> u64 {
    value.get("index").and_then(Value::as_u64).unwrap_or(0)
}

fn map_stop_reason(reason: &str) -> StopReason {
    match reason {
        "end_turn" | "stop_sequence" => StopReason::EndTurn,
        // `model_context_window_exceeded` is generation stopping because the
        // window filled, which is the same user-visible fact as running out of
        // output budget: the answer is cut short.
        "max_tokens" | "model_context_window_exceeded" => StopReason::MaxTokens,
        "tool_use" | "pause_turn" => StopReason::ToolUse,
        _ => StopReason::Unspecified,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::CollectingSink;
    use crate::model::{ContentPart, MalformedToolCall};
    use serde_json::json;

    fn frame(event: &str, data: Value) -> String {
        format!("event: {event}\ndata: {data}\n\n")
    }

    fn assemble(body: &str) -> (CollectingSink, ProviderResult<AssembledMessage>) {
        assemble_with(body, None)
    }

    fn assemble_with(
        body: &str,
        schema_tool: Option<&'static str>,
    ) -> (CollectingSink, ProviderResult<AssembledMessage>) {
        let mut sink = CollectingSink::new();
        let mut assembler = MessageAssembler::new(true);
        if let Some(name) = schema_tool {
            assembler = assembler.with_schema_tool(name);
        }
        // One byte at a time: the worst boundary a socket can hand us, and the
        // one that catches a frame-local parser.
        for byte in body.as_bytes() {
            assembler.push_bytes(&[*byte], &mut sink);
        }
        let assembled = assembler.finish(&mut sink);
        (sink, assembled)
    }

    fn text_stream() -> String {
        [
            frame(
                "message_start",
                json!({"type": "message_start", "message": {"id": "msg_1", "role": "assistant",
                       "content": [], "usage": {"input_tokens": 25, "output_tokens": 1}}}),
            ),
            frame(
                "content_block_start",
                json!({"type": "content_block_start", "index": 0,
                       "content_block": {"type": "text", "text": ""}}),
            ),
            frame(
                "content_block_delta",
                json!({"type": "content_block_delta", "index": 0,
                       "delta": {"type": "text_delta", "text": "Hello"}}),
            ),
            frame(
                "content_block_delta",
                json!({"type": "content_block_delta", "index": 0,
                       "delta": {"type": "text_delta", "text": ", world"}}),
            ),
            frame(
                "content_block_stop",
                json!({"type": "content_block_stop", "index": 0}),
            ),
            frame(
                "message_delta",
                json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"},
                       "usage": {"output_tokens": 15}}),
            ),
            frame("message_stop", json!({"type": "message_stop"})),
        ]
        .concat()
    }

    #[test]
    fn a_plain_turn_assembles_its_text_stop_reason_and_usage() {
        let (sink, assembled) = assemble(&text_stream());
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
    fn a_stream_that_never_sends_message_stop_still_terminates_and_says_so() {
        // MEASURED-1. The body simply ends; nothing waits for a terminator.
        let truncated =
            text_stream().replace(&frame("message_stop", json!({"type": "message_stop"})), "");
        let (sink, assembled) = assemble(&truncated);
        let assembled = assembled.unwrap();
        assert_eq!(sink.text(), "Hello, world");
        assert!(assembled
            .response
            .degradations
            .contains(&Degradation::NoTerminationSentinel));
    }

    #[test]
    fn usage_that_never_arrives_is_reported_not_awaited() {
        let body = format!(
            "{}{}{}",
            frame(
                "content_block_start",
                json!({"type": "content_block_start", "index": 0,
                       "content_block": {"type": "text", "text": ""}})
            ),
            frame(
                "content_block_delta",
                json!({"type": "content_block_delta", "index": 0,
                       "delta": {"type": "text_delta", "text": "hi"}})
            ),
            frame("message_stop", json!({"type": "message_stop"})),
        );
        let (_, assembled) = assemble(&body);
        let assembled = assembled.unwrap();
        assert!(assembled.response.usage.is_unreported());
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
            "{}{}{}{}{}{}",
            frame(
                "content_block_start",
                json!({"type": "content_block_start", "index": 0,
                       "content_block": {"type": "text", "text": ""}})
            ),
            frame(
                "content_block_delta",
                json!({"type": "content_block_delta", "index": 0,
                       "delta": {"type": "text_delta", "text": "one "}})
            ),
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"\n\n",
            ": keepalive\n\ndata: not-json-at-all\n\n",
            frame(
                "content_block_delta",
                json!({"type": "content_block_delta", "index": 0,
                       "delta": {"type": "text_delta", "text": "two"}})
            ),
            frame("message_stop", json!({"type": "message_stop"})),
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
    fn a_thinking_block_becomes_a_reasoning_part_with_its_signature() {
        let body = format!(
            "{}{}{}{}{}{}{}{}",
            frame(
                "content_block_start",
                json!({"type": "content_block_start", "index": 0,
                       "content_block": {"type": "thinking", "thinking": "", "signature": ""}})
            ),
            frame(
                "content_block_delta",
                json!({"type": "content_block_delta", "index": 0,
                       "delta": {"type": "thinking_delta", "thinking": "Let me break"}})
            ),
            frame(
                "content_block_delta",
                json!({"type": "content_block_delta", "index": 0,
                       "delta": {"type": "thinking_delta", "thinking": " this down"}})
            ),
            frame(
                "content_block_delta",
                json!({"type": "content_block_delta", "index": 0,
                       "delta": {"type": "signature_delta", "signature": "WaUjzkypQ2mUEVM36O2Txu"}})
            ),
            frame(
                "content_block_stop",
                json!({"type": "content_block_stop", "index": 0})
            ),
            frame(
                "content_block_start",
                json!({"type": "content_block_start", "index": 1,
                       "content_block": {"type": "text", "text": ""}})
            ),
            frame(
                "content_block_delta",
                json!({"type": "content_block_delta", "index": 1,
                       "delta": {"type": "text_delta", "text": "Based on my analysis"}})
            ),
            frame("message_stop", json!({"type": "message_stop"})),
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
                signature: Some("WaUjzkypQ2mUEVM36O2Txu".into()),
                redacted: false,
            },
            "the signature must survive: the next turn has to send it back"
        );
    }

    #[test]
    fn a_redacted_thinking_block_is_stored_but_never_shown_as_reasoning_text() {
        let body = format!(
            "{}{}",
            frame(
                "content_block_start",
                json!({"type": "content_block_start", "index": 0,
                       "content_block": {"type": "redacted_thinking", "data": "EncryptedPayload=="}})
            ),
            frame("message_stop", json!({"type": "message_stop"})),
        );
        let (sink, assembled) = assemble(&body);
        let assembled = assembled.unwrap();
        assert_eq!(
            sink.reasoning(),
            "",
            "opaque ciphertext is not reasoning the user can read"
        );
        assert_eq!(
            assembled.response.parts[0],
            ContentPart::Reasoning {
                text: "EncryptedPayload==".into(),
                signature: None,
                redacted: true,
            }
        );
    }

    #[test]
    fn a_thinking_block_the_stream_cut_short_is_kept_and_reported() {
        let body = format!(
            "{}{}",
            frame(
                "content_block_start",
                json!({"type": "content_block_start", "index": 0,
                       "content_block": {"type": "thinking", "thinking": "half a thou"}})
            ),
            frame(
                "content_block_delta",
                json!({"type": "content_block_delta", "index": 0,
                       "delta": {"type": "thinking_delta", "thinking": "ght"}})
            ),
        );
        let (_, assembled) = assemble(&body);
        let assembled = assembled.unwrap();
        assert_eq!(assembled.response.reasoning_text(), "half a thought");
        assert!(assembled
            .response
            .degradations
            .contains(&Degradation::UnterminatedReasoning {
                recovered_answer_chars: 0
            }));
    }

    #[test]
    fn leaked_think_markup_split_across_frames_never_reaches_the_answer() {
        // Spec THK-10: a reasoning model with thinking suppressed is documented
        // to leak internal XML into visible output. MEASURED-3 says a
        // frame-local stripper cannot catch it, because no single frame
        // contains the closing tag.
        let body = format!(
            "{}{}{}{}{}{}",
            frame(
                "content_block_start",
                json!({"type": "content_block_start", "index": 0,
                       "content_block": {"type": "text", "text": ""}})
            ),
            frame(
                "content_block_delta",
                json!({"type": "content_block_delta", "index": 0,
                       "delta": {"type": "text_delta", "text": "<thi"}})
            ),
            frame(
                "content_block_delta",
                json!({"type": "content_block_delta", "index": 0,
                       "delta": {"type": "text_delta", "text": "nk>leaked</thi"}})
            ),
            frame(
                "content_block_delta",
                json!({"type": "content_block_delta", "index": 0,
                       "delta": {"type": "text_delta", "text": "nk>the answer"}})
            ),
            frame(
                "content_block_stop",
                json!({"type": "content_block_stop", "index": 0})
            ),
            frame("message_stop", json!({"type": "message_stop"})),
        );
        let (sink, assembled) = assemble(&body);
        let assembled = assembled.unwrap();
        assert_eq!(assembled.response.answer_text(), "the answer");
        assert_eq!(assembled.response.reasoning_text(), "leaked");
        assert!(!sink.text().contains("think"));
    }

    #[test]
    fn a_streamed_tool_call_reassembles_from_its_partial_json() {
        let body = format!(
            "{}{}{}{}{}",
            frame(
                "content_block_start",
                json!({"type": "content_block_start", "index": 0,
                       "content_block": {"type": "tool_use", "id": "toolu_01A",
                                          "name": "get_weather", "input": {}}})
            ),
            frame(
                "content_block_delta",
                json!({"type": "content_block_delta", "index": 0,
                       "delta": {"type": "input_json_delta", "partial_json": "{\"city\":"}})
            ),
            frame(
                "content_block_delta",
                json!({"type": "content_block_delta", "index": 0,
                       "delta": {"type": "input_json_delta", "partial_json": "\"berlin\"}"}})
            ),
            frame(
                "content_block_stop",
                json!({"type": "content_block_stop", "index": 0})
            ),
            frame(
                "message_delta",
                json!({"type": "message_delta", "delta": {"stop_reason": "tool_use"},
                       "usage": {"output_tokens": 9}})
            ),
        );
        let (sink, assembled) = assemble(&body);
        let assembled = assembled.unwrap();
        assert_eq!(
            assembled.response.tool_calls,
            vec![ToolCallOutcome::Ok {
                call_id: "toolu_01A".into(),
                name: "get_weather".into(),
                arguments: json!({"city": "berlin"}),
                emulated: false,
            }]
        );
        assert_eq!(assembled.response.stop_reason, StopReason::ToolUse);
        assert!(sink
            .events
            .iter()
            .any(|event| matches!(event, StreamEvent::ToolCallDelta { .. })));
    }

    #[test]
    fn a_tool_call_whose_json_never_completes_is_reported_not_executed() {
        // MEASURED-4: a truncated argument stream must never be repaired into
        // something runnable.
        let body = format!(
            "{}{}",
            frame(
                "content_block_start",
                json!({"type": "content_block_start", "index": 0,
                       "content_block": {"type": "tool_use", "id": "toolu_01B",
                                          "name": "get_weather", "input": {}}})
            ),
            frame(
                "content_block_delta",
                json!({"type": "content_block_delta", "index": 0,
                       "delta": {"type": "input_json_delta", "partial_json": "{\"city\":\"ber"}})
            ),
        );
        let (_, assembled) = assemble(&body);
        let assembled = assembled.unwrap();
        assert!(matches!(
            &assembled.response.tool_calls[0],
            ToolCallOutcome::Malformed {
                reason: MalformedToolCall::UnparseableArguments,
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
    fn two_tool_blocks_at_different_indices_do_not_collide() {
        let body = format!(
            "{}{}{}{}",
            frame(
                "content_block_start",
                json!({"type": "content_block_start", "index": 1,
                       "content_block": {"type": "tool_use", "id": "toolu_1", "name": "one", "input": {}}})
            ),
            frame(
                "content_block_delta",
                json!({"type": "content_block_delta", "index": 1,
                       "delta": {"type": "input_json_delta", "partial_json": "{\"a\":1}"}})
            ),
            frame(
                "content_block_start",
                json!({"type": "content_block_start", "index": 7,
                       "content_block": {"type": "tool_use", "id": "toolu_2", "name": "two", "input": {}}})
            ),
            frame(
                "content_block_delta",
                json!({"type": "content_block_delta", "index": 7,
                       "delta": {"type": "input_json_delta", "partial_json": "{\"b\":2}"}})
            ),
        );
        let (_, assembled) = assemble(&body);
        let calls = assembled.unwrap().response.tool_calls;
        assert_eq!(calls.len(), 2, "index 7 must not allocate eight slots");
        assert!(calls.iter().all(ToolCallOutcome::is_ok));
    }

    #[test]
    fn the_internal_schema_tool_is_consumed_and_never_reported_as_a_tool_call() {
        let body = format!(
            "{}{}{}",
            frame(
                "content_block_start",
                json!({"type": "content_block_start", "index": 0,
                       "content_block": {"type": "tool_use", "id": "toolu_s",
                                          "name": "vela_structured_output", "input": {}}})
            ),
            frame(
                "content_block_delta",
                json!({"type": "content_block_delta", "index": 0,
                       "delta": {"type": "input_json_delta", "partial_json": "{\"answer\":\"42\"}"}})
            ),
            frame("message_stop", json!({"type": "message_stop"})),
        );
        let (_, assembled) = assemble_with(&body, Some("vela_structured_output"));
        let assembled = assembled.unwrap();
        assert_eq!(assembled.schema_tool_input, Some(json!({"answer": "42"})));
        assert!(
            assembled.response.tool_calls.is_empty(),
            "Vela's own tool must not appear in the user's transcript"
        );
    }

    #[test]
    fn an_error_event_inside_a_200_stream_becomes_a_provider_error() {
        let body = frame(
            "error",
            json!({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}),
        );
        let (_, assembled) = assemble(&body);
        assert!(matches!(assembled, Err(ProviderError::Transport { .. })));
    }

    #[test]
    fn an_unknown_block_type_is_ignored_rather_than_treated_as_damage() {
        let body = format!(
            "{}{}{}{}",
            frame(
                "content_block_start",
                json!({"type": "content_block_start", "index": 0,
                       "content_block": {"type": "server_tool_use_from_the_future", "id": "x"}})
            ),
            frame(
                "content_block_delta",
                json!({"type": "content_block_delta", "index": 0,
                       "delta": {"type": "text_delta", "text": "invisible"}})
            ),
            frame(
                "content_block_stop",
                json!({"type": "content_block_stop", "index": 0})
            ),
            frame("message_stop", json!({"type": "message_stop"})),
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
    fn cache_accounting_is_noticed_even_when_the_read_count_is_zero() {
        let mut sink = CollectingSink::new();
        let mut assembler = MessageAssembler::new(false);
        assembler.apply_message(
            &json!({
                "content": [{"type": "text", "text": "hi"}],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 4, "output_tokens": 2,
                          "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
            }),
            &mut sink,
        );
        let assembled = assembler.finish(&mut sink).unwrap();
        assert!(assembled.cache_accounting_reported);
        assert_eq!(assembled.response.usage.cached_input_tokens, Some(0));
    }

    #[test]
    fn the_non_streaming_body_produces_the_same_shape_as_the_stream() {
        let mut sink = CollectingSink::new();
        let mut assembler = MessageAssembler::new(false);
        assembler.apply_message(
            &json!({
                "id": "msg_1",
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "deliberating", "signature": "sig"},
                    {"type": "text", "text": "Hello, world"},
                    {"type": "tool_use", "id": "toolu_1", "name": "get_weather",
                     "input": {"city": "berlin"}},
                ],
                "stop_reason": "tool_use",
                "usage": {"input_tokens": 25, "output_tokens": 15},
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
                call_id: "toolu_1".into(),
                name: "get_weather".into(),
                arguments: json!({"city": "berlin"}),
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
    fn stop_reasons_map_onto_the_normalised_vocabulary() {
        assert_eq!(map_stop_reason("end_turn"), StopReason::EndTurn);
        assert_eq!(map_stop_reason("stop_sequence"), StopReason::EndTurn);
        assert_eq!(map_stop_reason("max_tokens"), StopReason::MaxTokens);
        assert_eq!(
            map_stop_reason("model_context_window_exceeded"),
            StopReason::MaxTokens
        );
        assert_eq!(map_stop_reason("tool_use"), StopReason::ToolUse);
        assert_eq!(map_stop_reason("something-new"), StopReason::Unspecified);
    }
}
