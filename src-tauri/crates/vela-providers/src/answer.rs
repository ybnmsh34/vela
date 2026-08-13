//! The answer channel — **the one place model text becomes something the user
//! sees, and the one place it becomes something a tool parser may read**.
//!
//! # Why this module exists
//!
//! Two rules were already written down in this crate, twice each:
//!
//! * [`emulation`](crate::emulation) — *"a model that **thinks** about calling
//!   `delete_everything` must not thereby call it"*;
//! * [`reasoning`](crate::reasoning) — reasoning is excluded from tool parsing,
//!   because deliberating about a call *"must not cause one to be executed"*.
//!
//! Both were enforced by *convention*: every adapter was expected to funnel
//! answer text through its own private `emit_answer`. Two of the three did.
//! The OpenAI-compatible assembler — the path every local runtime uses — had
//! exactly one line that did not, in [`CompletionAssembler::finish`], for the
//! text recovered out of a reasoning block that never closed. That one line
//! turned an unterminated `<think>` into an **executed tool call** and streamed
//! raw `<tool_call>` markup to the UI (Phase B, round-4 panel, FINDING 3).
//!
//! A rule enforced by every adapter remembering to call the right private
//! method is not a rule; it is a coincidence with good documentation. So the
//! state that rule protects — the accumulated content parts, and the text a
//! tool parser is allowed to see — lives here, behind private fields, and the
//! only ways in are [`AnswerChannel::push_answer`] and
//! [`AnswerChannel::close`]. This is the same move the response body got in
//! round 2 ([`BodyStream`](crate::http::BodyStream)) and response headers got
//! in round 4 ([`ResponseHeaders`](crate::http::ResponseHeaders)): make the
//! wrong thing inexpressible rather than discouraged.
//!
//! # Appending text without the stripper does not compile
//!
//! `parts` is private and there is no method that appends a
//! [`ContentPart::Text`] other than through the stripper:
//!
//! ```compile_fail,E0616
//! use vela_providers::answer::AnswerChannel;
//! use vela_providers::model::ContentPart;
//!
//! let mut channel = AnswerChannel::new().with_tool_emulation();
//! // error[E0616]: field `parts` of struct `AnswerChannel` is private
//! channel.parts.push(ContentPart::text("<tool_call>{\"name\":\"rm\"}</tool_call>"));
//! ```
//!
//! Nor is there a back door that takes text and a provenance of the caller's
//! choosing — salvaged text can only enter through [`AnswerChannel::close`],
//! which is also the only place that can produce quarantined calls:
//!
//! ```compile_fail,E0599
//! use vela_providers::answer::AnswerChannel;
//!
//! let mut channel = AnswerChannel::new();
//! // error[E0599]: no method named `push_salvaged` found for struct `AnswerChannel`
//! channel.push_salvaged("recovered", &mut vela_providers::event::CollectingSink::new());
//! ```
//!
//! # The decision this module encodes
//!
//! **A tool call recovered out of a reasoning block that never closed is not
//! executable.** See [`Provenance::Salvaged`] for the argument.

use crate::emulation::ToolCallStripper;
use crate::event::{EventSink, StreamEvent};
use crate::model::{ContentPart, MalformedToolCall, ToolCallOutcome};

/// Where a piece of answer text came from, and therefore what it is allowed to
/// do.
///
/// This type is never stored on a [`ContentPart`] — the wire shape crossing the
/// IPC boundary is unchanged. It exists so the distinction has a name, and so
/// the two paths through [`AnswerChannel`] cannot be confused for each other.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provenance {
    /// The model produced this text outside any reasoning block, or inside one
    /// it closed. It is a committed output: the model finished saying it.
    Committed,
    /// Rescued from a reasoning block the stream ended **inside**.
    ///
    /// # Why this text is shown but is never executable
    ///
    /// MEASURED-3 rescues it for one reason only: a turn whose every character
    /// landed inside an unterminated `<think>` would otherwise render as an
    /// empty message, and showing the user nothing is the worse failure. That
    /// is a *salvage heuristic*, not a claim that the model meant to say it.
    /// The model was cut off mid-deliberation — on a small local model at a
    /// token limit, which is the routine case, it never emitted the token that
    /// would have ended the thought, let alone committed to anything inside it.
    ///
    /// Showing salvaged text is reversible: the user reads it, sees the
    /// `unterminatedReasoning` degradation next to it, and knows the turn was
    /// cut. Running a tool is not reversible. The asymmetry of consequence is
    /// the whole argument: the same uncertainty that makes salvaged text worth
    /// showing makes it unfit to authorise an effect outside the conversation.
    ///
    /// The alternative — dropping the call silently — is the outcome MEASURED-4
    /// forbids, so a call found in salvaged text is reported as
    /// [`MalformedToolCall::RecoveredFromUnterminatedReasoning`]: the same
    /// visible, non-executable state a call with unparseable arguments gets,
    /// carrying the text as evidence so the user can see what the model was
    /// contemplating and ask for it deliberately.
    Salvaged,
}

/// Everything [`AnswerChannel::close`] concluded.
#[derive(Debug, Default)]
pub struct AnswerClose {
    /// Tool calls found in **committed** answer text. Executable.
    pub calls: Vec<ToolCallOutcome>,
    /// Calls found in **salvaged** text, downgraded to
    /// [`ToolCallOutcome::Malformed`]. Never executable, always reported.
    pub quarantined: Vec<ToolCallOutcome>,
    /// Whether a `<tool_call>` block was found in committed text — the signal
    /// the OpenAI-compatible assembler uses to decide whether to look for the
    /// untagged call shapes as well.
    pub found_tagged: bool,
    /// Characters rescued out of an unterminated reasoning block, as the user
    /// finally saw them: after stripping, not before. Feeds
    /// [`Degradation::UnterminatedReasoning`](crate::model::Degradation).
    pub recovered_chars: usize,
}

/// The accumulated content of one answer, and the only route text takes into
/// it.
///
/// Shared by all three adapters so the rule cannot hold on two of them and lapse
/// on the third, which is exactly what happened.
#[derive(Debug)]
pub struct AnswerChannel {
    /// Committed parts, in order. **Private**: appending a `Text` part directly
    /// is how the stripper got bypassed, so there is no way to do it.
    parts: Vec<ContentPart>,
    /// Present when tool calling is emulated. Answer text is routed through it
    /// so `<tool_call>` markup never reaches the user, even split across frames.
    stripper: Option<ToolCallStripper>,
    /// Committed answer text, verbatim as the user saw it. **This is the only
    /// text a tool parser may see** — [`AnswerChannel::executable_text`].
    committed: String,
    /// Text salvaged at close, held out of `parts` until [`Self::into_parts`]
    /// so a retraction over committed text cannot touch it.
    salvaged: Option<String>,
    /// Whether this turn is emulating tool calls. `stripper` is taken during
    /// [`Self::close`], so the fact has to survive it.
    emulated: bool,
    closed: bool,
}

impl Default for AnswerChannel {
    fn default() -> Self {
        Self::new()
    }
}

impl AnswerChannel {
    pub fn new() -> Self {
        Self {
            parts: Vec::new(),
            stripper: None,
            committed: String::new(),
            salvaged: None,
            emulated: false,
            closed: false,
        }
    }

    /// Route answer text through the emulated-tool-call stripper.
    pub fn with_tool_emulation(mut self) -> Self {
        self.stripper = Some(ToolCallStripper::new());
        self.emulated = true;
        self
    }

    /// Whether tool calling is being emulated on this turn.
    pub fn emulating(&self) -> bool {
        self.stripper.is_some()
    }

    /// Committed answer text on its way to the user, after emulation stripping.
    ///
    /// The only entry point for text with [`Provenance::Committed`], and the
    /// only place a [`StreamEvent::TextDelta`] is emitted during a turn.
    pub fn push_answer(&mut self, text: &str, sink: &mut dyn EventSink) {
        debug_assert!(!self.closed, "answer text after close");
        let visible = match self.stripper.as_mut() {
            Some(stripper) => stripper.push(text),
            None => text.to_owned(),
        };
        self.emit_committed(&visible, sink);
    }

    /// Reasoning on its way to the user. Never reaches [`Self::executable_text`].
    pub fn push_reasoning(&mut self, text: &str, sink: &mut dyn EventSink) {
        if text.is_empty() {
            return;
        }
        self.append_reasoning(text);
        sink.emit(StreamEvent::ReasoningDelta {
            text: text.to_owned(),
        });
    }

    /// A whole reasoning block the endpoint separated for us, with its
    /// signature. No sink event: the deltas were emitted as the block streamed.
    pub fn push_reasoning_block(
        &mut self,
        text: String,
        signature: Option<String>,
        redacted: bool,
    ) {
        if text.is_empty() && signature.is_none() && !redacted {
            return;
        }
        self.parts.push(ContentPart::Reasoning {
            text,
            signature,
            redacted,
        });
    }

    /// Attach a signature to the reasoning block just accumulated, or keep it
    /// as an empty signed block. Losing it breaks the next turn.
    pub fn sign_last_reasoning(&mut self, value: &str) {
        match self.parts.last_mut() {
            Some(ContentPart::Reasoning { signature, .. }) => {
                signature.get_or_insert_with(|| value.to_owned());
            }
            _ => self.parts.push(ContentPart::Reasoning {
                text: String::new(),
                signature: Some(value.to_owned()),
                redacted: false,
            }),
        }
    }

    /// Inline image bytes. Not text, so it bypasses nothing.
    pub fn push_image(&mut self, mime_type: String, data: Vec<u8>) {
        self.parts.push(ContentPart::Image { mime_type, data });
    }

    /// **The only text a tool parser may see**: committed answer text, with
    /// reasoning excluded by construction and salvaged text excluded by
    /// [`Provenance::Salvaged`]'s argument.
    pub fn executable_text(&self) -> &str {
        &self.committed
    }

    /// Every character of answer the user was shown, committed and salvaged.
    /// For diagnostics and for block messages — never for tool parsing.
    pub fn visible_answer(&self) -> String {
        let mut out = self.committed.clone();
        if let Some(salvaged) = &self.salvaged {
            out.push_str(salvaged);
        }
        out
    }

    /// How many characters of answer the user was shown.
    pub fn answer_chars(&self) -> usize {
        self.committed.chars().count()
            + self
                .salvaged
                .as_ref()
                .map_or(0, |text| text.chars().count())
    }

    /// Whether anything at all — text, reasoning, an image — was accumulated.
    pub fn is_empty(&self) -> bool {
        self.parts.is_empty() && self.salvaged.as_ref().is_none_or(String::is_empty)
    }

    /// Replace the committed answer text with `text`, keeping its position
    /// relative to the reasoning parts around it.
    ///
    /// Used when a call shape that can only be recognised whole — a fenced JSON
    /// object, a `TOOL_CALL name {…}` line — is retracted out of an answer that
    /// has already streamed. Salvaged text is untouched: it is not in `parts`
    /// yet, and it was never eligible to be parsed in the first place.
    pub fn retract_committed_text(&mut self, text: &str) {
        let first_text = self
            .parts
            .iter()
            .position(|part| matches!(part, ContentPart::Text { .. }));
        self.parts
            .retain(|part| !matches!(part, ContentPart::Text { .. }));
        self.committed = text.to_owned();
        if text.is_empty() {
            return;
        }
        let at = first_text.unwrap_or(self.parts.len()).min(self.parts.len());
        self.parts.insert(at, ContentPart::text(text));
    }

    /// End of stream.
    ///
    /// Flushes whatever the stripper is holding back, then absorbs `recovered`
    /// — the text [`ReasoningSplitter::finish`](crate::reasoning::ReasoningSplitter::finish)
    /// rescued out of a block that never closed — through the **same** stripper
    /// discipline, into the **quarantined** bucket.
    ///
    /// This function is the fix for FINDING 3. Before it, the recovered text
    /// went straight to `parts` and to a `TextDelta`, so the stripper never saw
    /// it, its raw `<tool_call>` markup reached the UI, and the untagged-shape
    /// fallback then parsed it into an executable call.
    pub fn close(&mut self, recovered: Option<&str>, sink: &mut dyn EventSink) -> AnswerClose {
        debug_assert!(!self.closed, "close called twice");
        self.closed = true;
        let mut out = AnswerClose::default();

        // 1. Committed: flush the stripper's tail and collect the calls it
        //    found. These are real: the model closed every structure it opened
        //    around them.
        if let Some(stripper) = self.stripper.take() {
            let (tail, calls) = stripper.finish();
            self.emit_committed(&tail, sink);
            out.found_tagged = !calls.is_empty();
            out.calls = calls;
        }

        // 2. Salvaged. Processed in one shot — it has not streamed yet, so
        //    nothing has to be retracted — and every call found in it is
        //    quarantined rather than executed.
        let Some(recovered) = recovered.filter(|text| !text.is_empty()) else {
            return out;
        };
        // Without emulation there is no path from text to an executed call at
        // all: `<tool_call>` markup is inert text the model happened to write,
        // and hiding it would be a lie about what came back. So the quarantine
        // runs exactly where the danger is.
        let (visible, quarantined) = if self.emulated {
            quarantine(recovered)
        } else {
            (recovered.to_owned(), Vec::new())
        };
        out.quarantined = quarantined;
        out.recovered_chars = visible.chars().count();
        if !visible.is_empty() {
            sink.emit(StreamEvent::TextDelta {
                text: visible.clone(),
            });
            self.salvaged = Some(visible);
        }
        out
    }

    /// The accumulated parts, salvaged text last.
    pub fn into_parts(mut self) -> Vec<ContentPart> {
        if let Some(salvaged) = self.salvaged.take().filter(|text| !text.is_empty()) {
            match self.parts.last_mut() {
                Some(ContentPart::Text { text }) => text.push_str(&salvaged),
                _ => self.parts.push(ContentPart::text(salvaged)),
            }
        }
        self.parts
    }

    fn emit_committed(&mut self, visible: &str, sink: &mut dyn EventSink) {
        if visible.is_empty() {
            return;
        }
        self.committed.push_str(visible);
        match self.parts.last_mut() {
            Some(ContentPart::Text { text }) => text.push_str(visible),
            _ => self.parts.push(ContentPart::text(visible)),
        }
        sink.emit(StreamEvent::TextDelta {
            text: visible.to_owned(),
        });
    }

    fn append_reasoning(&mut self, text: &str) {
        match self.parts.last_mut() {
            Some(ContentPart::Reasoning {
                text: existing,
                redacted: false,
                ..
            }) => existing.push_str(text),
            _ => self.parts.push(ContentPart::reasoning(text)),
        }
    }
}

/// Strip every call shape out of salvaged text and downgrade what it finds.
///
/// Returns the text the user may see and the quarantined calls. Both shapes are
/// covered — the `<tool_call>` block Vela asks for, and the untagged shapes
/// [`parse_calls`](crate::emulation::parse_calls) recognises — because the point
/// is that *no* call-shaped markup reaches the user and *no* call recovered here
/// is executable, not that one particular spelling is handled.
fn quarantine(recovered: &str) -> (String, Vec<ToolCallOutcome>) {
    let mut stripper = ToolCallStripper::new();
    let visible = stripper.push(recovered);
    let (tail, tagged) = stripper.finish();
    let mut text = format!("{visible}{tail}");
    let mut found: Vec<ToolCallOutcome> = tagged;
    if found.is_empty() {
        let parsed = crate::emulation::parse_calls(&text);
        if !parsed.is_empty() {
            text = parsed.remaining_text;
            found = parsed.calls;
        }
    }
    let quarantined = found.into_iter().map(downgrade).collect();
    (text.trim().to_owned(), quarantined)
}

/// Turn a well-formed call into the reported, non-executable state.
///
/// A call that was *already* malformed keeps its own reason: it says something
/// truer about what happened than "recovered from deliberation" does, and both
/// outcomes are equally non-executable.
fn downgrade(call: ToolCallOutcome) -> ToolCallOutcome {
    match call {
        ToolCallOutcome::Ok {
            call_id,
            name,
            arguments,
            ..
        } => ToolCallOutcome::Malformed {
            index: None,
            call_id: Some(call_id),
            name: Some(name),
            // The evidence, so the UI can show the user what the model was
            // contemplating and let them ask for it deliberately.
            raw_arguments: bounded(&serde_json::to_string(&arguments).unwrap_or_default()),
            reason: MalformedToolCall::RecoveredFromUnterminatedReasoning,
        },
        already_malformed => already_malformed,
    }
}

fn bounded(raw: &str) -> String {
    let mut out: String = raw.chars().take(400).collect();
    if raw.chars().count() > 400 {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::CollectingSink;

    const DESTRUCTIVE: &str =
        "I could call <tool_call>{\"name\":\"delete_everything\",\"arguments\":{\"path\":\"/\"}}\
         </tool_call> but that would be destructive, so I will not.";

    #[test]
    fn committed_text_is_the_only_text_a_tool_parser_sees() {
        let mut sink = CollectingSink::new();
        let mut channel = AnswerChannel::new().with_tool_emulation();
        channel.push_answer("visible ", &mut sink);
        channel.push_reasoning("private", &mut sink);
        let close = channel.close(Some("salvaged"), &mut sink);
        assert_eq!(channel.executable_text(), "visible ");
        assert_eq!(close.recovered_chars, "salvaged".len());
        assert_eq!(channel.visible_answer(), "visible salvaged");
    }

    #[test]
    fn a_call_recovered_from_an_unterminated_block_is_not_executable() {
        let mut sink = CollectingSink::new();
        let mut channel = AnswerChannel::new().with_tool_emulation();
        let close = channel.close(Some(DESTRUCTIVE), &mut sink);
        assert!(close.calls.is_empty(), "nothing committed, nothing to run");
        assert_eq!(close.quarantined.len(), 1);
        assert!(
            matches!(
                &close.quarantined[0],
                ToolCallOutcome::Malformed {
                    name: Some(name),
                    reason: MalformedToolCall::RecoveredFromUnterminatedReasoning,
                    ..
                } if name == "delete_everything"
            ),
            "got {:?}",
            close.quarantined[0]
        );
        let visible = channel.visible_answer();
        assert!(
            !visible.contains("tool_call") && !visible.contains("delete_everything"),
            "raw markup reached the user: {visible:?}"
        );
        assert!(visible.contains("but that would be destructive"));
        for event in &sink.events {
            if let StreamEvent::TextDelta { text } = event {
                assert!(!text.contains("<tool_call>"), "markup streamed: {text:?}");
            }
        }
    }

    #[test]
    fn an_untagged_call_shape_in_salvaged_text_is_quarantined_too() {
        let mut sink = CollectingSink::new();
        let mut channel = AnswerChannel::new().with_tool_emulation();
        let close = channel.close(
            Some("maybe TOOL_CALL: delete_everything {\"path\": \"/\"} would work"),
            &mut sink,
        );
        assert_eq!(close.quarantined.len(), 1);
        assert!(close.quarantined.iter().all(|call| !call.is_ok()));
    }

    #[test]
    fn a_committed_call_is_still_executable() {
        let mut sink = CollectingSink::new();
        let mut channel = AnswerChannel::new().with_tool_emulation();
        channel.push_answer(
            "<tool_call>{\"name\":\"get_weather\",\"arguments\":{\"city\":\"berlin\"}}</tool_call>",
            &mut sink,
        );
        let close = channel.close(None, &mut sink);
        assert!(close.found_tagged);
        assert_eq!(close.calls.len(), 1);
        assert!(close.calls[0].is_ok(), "the fix must not disarm emulation");
    }

    #[test]
    fn without_emulation_salvaged_text_is_shown_verbatim() {
        let mut sink = CollectingSink::new();
        let mut channel = AnswerChannel::new();
        let close = channel.close(Some(DESTRUCTIVE), &mut sink);
        assert!(close.quarantined.is_empty());
        assert_eq!(channel.visible_answer(), DESTRUCTIVE);
    }

    #[test]
    fn retraction_replaces_committed_text_and_leaves_salvage_alone() {
        let mut sink = CollectingSink::new();
        let mut channel = AnswerChannel::new().with_tool_emulation();
        channel.push_answer("keep this", &mut sink);
        channel.close(Some("rescued"), &mut sink);
        channel.retract_committed_text("kept");
        assert_eq!(channel.executable_text(), "kept");
        assert_eq!(
            channel.into_parts(),
            vec![ContentPart::text("kept"), ContentPart::text("rescued")]
                .into_iter()
                .fold(Vec::new(), |mut acc: Vec<ContentPart>, part| {
                    match (acc.last_mut(), &part) {
                        (Some(ContentPart::Text { text }), ContentPart::Text { text: adding }) => {
                            text.push_str(adding)
                        }
                        _ => acc.push(part),
                    }
                    acc
                })
        );
    }
}
