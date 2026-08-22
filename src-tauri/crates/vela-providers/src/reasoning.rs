//! Separating reasoning from the answer, as a streaming state machine.
//!
//! # THE LOAD-BEARING RULE OF THIS FILE (MEASURED-3)
//!
//! `mid-local` splits its closing tag across two SSE frames — `</thi` then
//! `nk>` — so **no single frame contains it**. Any per-frame regex therefore
//! leaks `<think>` markup into the user's answer; the gate recorded exactly
//! that happening. Separation must run over the *accumulated* stream, holding
//! back only the few characters that could still turn out to be a tag.
//!
//! `hostile` is the other half of the requirement: it opens `<think>` twice,
//! never closes it, and interleaves control-token junk. A machine that simply
//! "stays inside until closed" would classify the entire answer as reasoning
//! and show the user nothing. So an unterminated block ends in **recovery**:
//! the text after the last unmatched open tag is handed back as the answer, and
//! a [`Degradation::UnterminatedReasoning`](crate::model::Degradation) says so.
//!
//! The second consumer of this rule is tool-call parsing: reasoning is excluded
//! from it, because a model deliberating about a call it never makes must not
//! cause one to be executed.

use crate::textscan::{first_match, held_back};

/// One classified fragment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReasoningPiece {
    Answer(String),
    Reasoning(String),
}

/// Tag pairs understood inline. `<think>` is what llama.cpp emits by default;
/// `<thinking>` is the other spelling in the wild. Backends with a dedicated
/// `reasoning_content` field never reach this machine.
const TAG_PAIRS: [(&str, &str); 2] = [("<think>", "</think>"), ("<thinking>", "</thinking>")];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Answer,
    /// Inside the block opened by `TAG_PAIRS[pair]`.
    Reasoning {
        pair: usize,
    },
}

/// What [`ReasoningSplitter::finish`] concluded.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ReasoningFinish {
    pub pieces: Vec<ReasoningPiece>,
    /// Present when the stream ended inside an unterminated block **and** no
    /// answer text was ever produced. The answer, rescued.
    pub recovered_answer: Option<String>,
}

/// Splits a text stream into answer and reasoning across arbitrary boundaries.
#[derive(Debug)]
pub struct ReasoningSplitter {
    state: State,
    /// Text received but not yet classifiable (a possible partial tag).
    pending: String,
    saw_answer: bool,
    /// Reasoning accumulated in the currently open block, for recovery.
    current_block: String,
    /// Offset in `current_block` just after the last *nested* open tag we
    /// stripped. Recovery starts there: on a stream that opened twice, the last
    /// open is where the answer actually began.
    last_nested_open: Option<usize>,
}

impl Default for ReasoningSplitter {
    fn default() -> Self {
        Self::new()
    }
}

impl ReasoningSplitter {
    pub fn new() -> Self {
        Self {
            state: State::Answer,
            pending: String::new(),
            saw_answer: false,
            current_block: String::new(),
            last_nested_open: None,
        }
    }

    /// Whether any answer text has been emitted so far.
    pub fn saw_answer(&self) -> bool {
        self.saw_answer
    }

    /// Feed the next fragment of model text.
    pub fn push(&mut self, text: &str) -> Vec<ReasoningPiece> {
        self.pending.push_str(text);
        let mut out = Vec::new();
        loop {
            match self.state {
                State::Answer => {
                    match first_match(&self.pending, &TAG_PAIRS.map(|(open, _)| open)) {
                        Some((at, pair, tag_len)) => {
                            self.emit_answer(&mut out, at);
                            self.pending.drain(..tag_len);
                            self.state = State::Reasoning { pair };
                            self.current_block.clear();
                            self.last_nested_open = None;
                        }
                        None => {
                            let safe = self.pending.len()
                                - held_back(&self.pending, &TAG_PAIRS.map(|(open, _)| open));
                            self.emit_answer(&mut out, safe);
                            break;
                        }
                    }
                }
                State::Reasoning { pair } => {
                    let close = TAG_PAIRS[pair].1;
                    let opens = TAG_PAIRS.map(|(open, _)| open);
                    let close_at = self.pending.find(close);
                    let open_at = first_match(&self.pending, &opens);
                    match (close_at, open_at) {
                        // The close comes first (or there is no stray open):
                        // the block ends here.
                        (Some(at), open) if open.is_none_or(|(o, _, _)| at <= o) => {
                            self.emit_reasoning(&mut out, at);
                            self.pending.drain(..close.len());
                            self.state = State::Answer;
                            self.current_block.clear();
                            self.last_nested_open = None;
                        }
                        // A second open tag inside an open block: junk. Strip
                        // it, stay inside, and remember where it was — that is
                        // where recovery will start if this block never closes.
                        (_, Some((at, _, tag_len))) => {
                            self.emit_reasoning(&mut out, at);
                            self.pending.drain(..tag_len);
                            self.last_nested_open = Some(self.current_block.len());
                        }
                        // Neither tag is in view. Hold back only what could
                        // still become one, and emit the rest as reasoning.
                        _ => {
                            let mut candidates: Vec<&str> = opens.to_vec();
                            candidates.push(close);
                            let safe = self.pending.len() - held_back(&self.pending, &candidates);
                            self.emit_reasoning(&mut out, safe);
                            break;
                        }
                    }
                }
            }
            if self.pending.is_empty() {
                break;
            }
        }
        out
    }

    /// End of stream. Flushes whatever is held back and decides recovery.
    pub fn finish(&mut self) -> ReasoningFinish {
        let mut pieces = Vec::new();
        let rest = std::mem::take(&mut self.pending);
        let mut recovered_answer = None;
        match self.state {
            State::Answer => {
                if !rest.is_empty() {
                    self.saw_answer = true;
                    pieces.push(ReasoningPiece::Answer(rest));
                }
            }
            State::Reasoning { .. } => {
                if !rest.is_empty() {
                    self.current_block.push_str(&rest);
                    pieces.push(ReasoningPiece::Reasoning(rest));
                }
                // The block never closed. Everything since the last unmatched
                // open tag is the best available answer; without this the whole
                // turn would be filed as reasoning and the user would see an
                // empty message.
                if !self.saw_answer {
                    let start = self.last_nested_open.unwrap_or(0);
                    let candidate = self.current_block[start..].trim();
                    if !candidate.is_empty() {
                        recovered_answer = Some(candidate.to_owned());
                    }
                }
            }
        }
        ReasoningFinish {
            pieces,
            recovered_answer,
        }
    }

    fn emit_answer(&mut self, out: &mut Vec<ReasoningPiece>, upto: usize) {
        if upto == 0 {
            return;
        }
        let text: String = self.pending.drain(..upto).collect();
        self.saw_answer = true;
        out.push(ReasoningPiece::Answer(text));
    }

    fn emit_reasoning(&mut self, out: &mut Vec<ReasoningPiece>, upto: usize) {
        if upto == 0 {
            return;
        }
        let text: String = self.pending.drain(..upto).collect();
        self.current_block.push_str(&text);
        out.push(ReasoningPiece::Reasoning(text));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(pieces: &[ReasoningPiece]) -> String {
        pieces
            .iter()
            .filter_map(|piece| match piece {
                ReasoningPiece::Answer(text) => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    fn reasoning(pieces: &[ReasoningPiece]) -> String {
        pieces
            .iter()
            .filter_map(|piece| match piece {
                ReasoningPiece::Reasoning(text) => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    /// Drives the splitter with the exact fragmentation recorded from a live
    /// endpoint and returns (answer, reasoning, finish).
    fn run(fragments: &[&str]) -> (String, String, ReasoningFinish) {
        let mut splitter = ReasoningSplitter::new();
        let mut pieces = Vec::new();
        for fragment in fragments {
            pieces.extend(splitter.push(fragment));
        }
        let finish = splitter.finish();
        pieces.extend(finish.pieces.clone());
        (answer(&pieces), reasoning(&pieces), finish)
    }

    #[test]
    fn a_closing_tag_split_across_frames_never_leaks() {
        // Verbatim from docs/regression-baseline/mock-matrix/mid-local/
        // 07-reasoning-think-blocks.txt — no frame contains `</think>`.
        let (answer, reasoning, finish) = run(&[
            "<thi",
            "nk>",
            "Considering the request ",
            "about what is the weathe",
            "r in Berlin. Profile mid",
            "-local has a 32768-token",
            " window. Answering direc",
            "tly.",
            "</thi",
            "nk>",
            "\n",
            "Mock mid-local r",
            "eply to: what is",
            " the weather in ",
            "Berlin.",
        ]);
        assert!(
            !answer.contains("think"),
            "reasoning markup reached the user: {answer:?}"
        );
        assert_eq!(
            answer.trim(),
            "Mock mid-local reply to: what is the weather in Berlin."
        );
        assert!(reasoning.starts_with("Considering the request about"));
        assert!(reasoning.ends_with("Answering directly."));
        assert_eq!(finish.recovered_answer, None, "the block closed cleanly");
    }

    #[test]
    fn an_unterminated_block_opened_twice_does_not_swallow_the_answer() {
        // Verbatim fragmentation from the `hostile` profile: `<think>` opens,
        // junk, `<think>` opens again, and nothing ever closes.
        let (answer, reasoning, finish) = run(&[
            "<think>",
            " ▒▒ <|channel|>analysis ",
            "Considering the req",
            "uest about what is ",
            "the weather in Berl",
            "in. Profile hostile",
            " has a 4096-token w",
            "indow. Answering di",
            "rectly.",
            " <|channel|>analysis ",
            "<think>",
            " nested ",
            "Mock hostil",
            "e reply to:",
            " what is th",
            "e weather i",
            "n Berlin.",
            " <|im_start|> <|im_start|>",
        ]);
        assert_eq!(answer, "", "nothing was ever outside a block");
        assert!(
            !reasoning.contains("<think>"),
            "the stray open tag must be stripped, not shown: {reasoning:?}"
        );
        let recovered = finish
            .recovered_answer
            .expect("MEASURED-3: an unterminated block must not swallow the answer");
        assert!(
            recovered.contains("Mock hostile reply to: what is the weather in Berlin."),
            "recovered answer was {recovered:?}"
        );
        assert!(
            !recovered.contains("Profile hostile has a 4096-token window"),
            "recovery starts at the last unmatched open tag, not at the top"
        );
    }

    #[test]
    fn recovery_does_not_fire_when_a_real_answer_was_produced() {
        let (answer, _, finish) = run(&["answer first.", "<think>then thinking forever"]);
        assert_eq!(answer, "answer first.");
        assert_eq!(
            finish.recovered_answer, None,
            "duplicating an answer that already reached the user would be worse"
        );
    }

    #[test]
    fn text_with_no_reasoning_at_all_passes_straight_through() {
        let (answer, reasoning, finish) = run(&["plain ", "answer"]);
        assert_eq!(answer, "plain answer");
        assert_eq!(reasoning, "");
        assert_eq!(finish.recovered_answer, None);
    }

    #[test]
    fn a_lone_less_than_is_not_held_back_forever() {
        let mut splitter = ReasoningSplitter::new();
        let pieces = splitter.push("3 < 4 and 5 > 2");
        assert_eq!(answer(&pieces), "3 < 4 and 5 > 2");
    }

    #[test]
    fn one_character_at_a_time_gives_the_same_result_as_one_chunk() {
        let whole = "<think>abc</think>def";
        let (a1, r1, _) = run(&[whole]);
        let per_char: Vec<String> = whole.chars().map(|c| c.to_string()).collect();
        let refs: Vec<&str> = per_char.iter().map(String::as_str).collect();
        let (a2, r2, _) = run(&refs);
        assert_eq!((a1.as_str(), r1.as_str()), ("def", "abc"));
        assert_eq!((a1, r1), (a2, r2));
    }

    #[test]
    fn multiple_complete_blocks_alternate_correctly() {
        let (answer, reasoning, _) = run(&["a<think>x</think>b<think>y</think>c"]);
        assert_eq!(answer, "abc");
        assert_eq!(reasoning, "xy");
    }
}
