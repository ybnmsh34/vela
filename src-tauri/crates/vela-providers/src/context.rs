//! Making a conversation fit a short context window — visibly.
//!
//! # THE LOAD-BEARING RULE OF THIS FILE
//!
//! **Nothing is ever dropped silently.** Every reduction produces a
//! [`Degradation::ContextReduced`] *and* leaves a visible note in the prompt
//! where the dropped turns were, so the model is not fed a conversation that
//! pretends to be complete. If the conversation cannot be made to fit without
//! cutting into the parts that must survive — the system prompt and the user's
//! current message — Vela refuses with
//! [`ProviderError::ContextLengthExceeded`], because answering half of
//! someone's question as though it were the whole of it is worse than saying
//! no.
//!
//! # About the token estimate
//!
//! Vela does not have the model's tokeniser and will not pretend to. The
//! estimate here is deliberately crude and deliberately *conservative*; the
//! endpoint's own `400 context_length_exceeded` remains the authority, and all
//! four matrix profiles return one cleanly. This planner exists to avoid the
//! round trip in the common case, not to replace the endpoint's judgement.

use crate::error::{detail, ProviderError, ProviderResult};
use crate::model::{ChatMessage, ChatRequest, ContentPart, ContextStrategy, Degradation, MessageRole};

/// Bytes per token, assumed. Roughly right for English text on byte-pair
/// tokenisers, and wrong for everything else — which is why it is conservative
/// and why the endpoint's own limit still wins.
const CHARS_PER_TOKEN: usize = 4;

/// Flat per-message cost for role markers and chat-template scaffolding.
const MESSAGE_OVERHEAD_TOKENS: u32 = 4;

/// What an image costs when the endpoint does not tell us. Deliberately large:
/// underestimating an image is how a request that "fits" comes back as a 400.
const IMAGE_TOKENS_ESTIMATE: u32 = 1_024;

/// How much of the window to leave for the answer, when the caller has not said.
const DEFAULT_OUTPUT_RESERVE_TOKENS: u32 = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContextBudget {
    pub window_tokens: u32,
    pub reserve_output_tokens: u32,
}

impl ContextBudget {
    pub fn new(window_tokens: u32) -> Self {
        Self {
            window_tokens,
            reserve_output_tokens: DEFAULT_OUTPUT_RESERVE_TOKENS,
        }
    }

    /// Derive the budget from a request and a known window. Returns `None`
    /// when the window is unknown — in which case no planning happens at all
    /// and the endpoint decides, which is the honest fallback.
    pub fn for_request(request: &ChatRequest, window_tokens: Option<u32>) -> Option<Self> {
        let window = window_tokens.or(request.max_context_tokens)?;
        Some(Self {
            window_tokens: window,
            reserve_output_tokens: request
                .max_output_tokens
                .unwrap_or(DEFAULT_OUTPUT_RESERVE_TOKENS),
        })
    }

    pub fn prompt_allowance(&self) -> u32 {
        self.window_tokens.saturating_sub(self.reserve_output_tokens)
    }
}

/// Replaces dropped turns with something the model can read.
///
/// The default ([`ElisionNote`]) states plainly that turns were removed. A
/// caller that can afford a summarisation pass — typically by asking a model —
/// supplies its own and gets [`ContextStrategy::Summarise`] instead.
pub trait ConversationSummariser: Send + Sync {
    fn summarise(&self, dropped: &[ChatMessage]) -> Option<String>;

    fn strategy(&self) -> ContextStrategy {
        ContextStrategy::Summarise
    }
}

/// The default: no summary, but an explicit, visible statement of what is gone.
#[derive(Debug, Default, Clone, Copy)]
pub struct ElisionNote;

impl ConversationSummariser for ElisionNote {
    fn summarise(&self, dropped: &[ChatMessage]) -> Option<String> {
        if dropped.is_empty() {
            return None;
        }
        Some(format!(
            "[{} earlier turn(s) in this conversation were omitted because they \
             did not fit the model's context window.]",
            dropped.len()
        ))
    }

    fn strategy(&self) -> ContextStrategy {
        ContextStrategy::ElideOldest
    }
}

/// Estimated prompt cost of one message.
pub fn estimate_message_tokens(message: &ChatMessage) -> u32 {
    let mut tokens = MESSAGE_OVERHEAD_TOKENS;
    for part in &message.parts {
        tokens += match part {
            ContentPart::Text { text } | ContentPart::Reasoning { text, .. } => {
                text.chars().count().div_ceil(CHARS_PER_TOKEN) as u32
            }
            ContentPart::Image { .. } => IMAGE_TOKENS_ESTIMATE,
            ContentPart::ToolCall {
                name, arguments, ..
            } => (name.len() + arguments.to_string().len()).div_ceil(CHARS_PER_TOKEN) as u32,
            ContentPart::ToolResult { content, .. } => {
                content.chars().count().div_ceil(CHARS_PER_TOKEN) as u32
            }
        };
    }
    tokens
}

pub fn estimate_prompt_tokens(messages: &[ChatMessage]) -> u32 {
    messages.iter().map(estimate_message_tokens).sum()
}

/// Fit `request` into `budget`, reporting whatever it took.
///
/// Messages that are never dropped: every `System` message, and the trailing
/// run of messages from the last `User` turn onward (the user's question and
/// any tool traffic answering it).
pub fn fit_request(
    request: ChatRequest,
    budget: ContextBudget,
    summariser: &dyn ConversationSummariser,
) -> ProviderResult<(ChatRequest, Vec<Degradation>)> {
    let allowance = budget.prompt_allowance();
    let total = estimate_prompt_tokens(&request.messages);
    if total <= allowance {
        return Ok((request, Vec::new()));
    }

    let pinned_from = last_user_turn_start(&request.messages);
    let mut kept: Vec<ChatMessage> = Vec::new();
    let mut droppable: Vec<(usize, ChatMessage)> = Vec::new();
    for (index, message) in request.messages.iter().enumerate() {
        if message.role == MessageRole::System || index >= pinned_from {
            kept.push(message.clone());
        } else {
            droppable.push((index, message.clone()));
        }
    }

    let pinned_tokens = estimate_prompt_tokens(&kept);
    if pinned_tokens > allowance {
        // Even the system prompt plus the current question does not fit. There
        // is nothing left to remove that would not change what the user asked.
        return Err(ProviderError::ContextLengthExceeded {
            limit_tokens: Some(budget.window_tokens),
            requested_tokens: Some(pinned_tokens + budget.reserve_output_tokens),
            detail: detail(
                "the system prompt and your message alone exceed this model's context window",
            ),
        });
    }

    // Keep the newest droppable turns that still fit, oldest dropped first.
    let mut running = pinned_tokens;
    let mut survivors: Vec<(usize, ChatMessage)> = Vec::new();
    for (index, message) in droppable.iter().rev() {
        let cost = estimate_message_tokens(message);
        // The elision note itself costs something; leave room for it.
        if running + cost + MESSAGE_OVERHEAD_TOKENS * 8 > allowance {
            break;
        }
        running += cost;
        survivors.push((*index, message.clone()));
    }
    survivors.reverse();

    let survivor_indices: std::collections::BTreeSet<usize> =
        survivors.iter().map(|(index, _)| *index).collect();
    let dropped: Vec<ChatMessage> = droppable
        .into_iter()
        .filter(|(index, _)| !survivor_indices.contains(index))
        .map(|(_, message)| message)
        .collect();

    let dropped_tokens = estimate_prompt_tokens(&dropped);
    let note = summariser.summarise(&dropped);

    // Rebuild in original order: system messages, the note, then survivors and
    // pinned messages by index.
    let mut rebuilt: Vec<ChatMessage> = Vec::new();
    let mut inserted_note = false;
    for (index, message) in request.messages.iter().enumerate() {
        let is_system = message.role == MessageRole::System;
        let is_pinned = index >= pinned_from;
        let is_survivor = survivor_indices.contains(&index);
        if is_system {
            rebuilt.push(message.clone());
            continue;
        }
        if !inserted_note {
            if let Some(note) = &note {
                rebuilt.push(ChatMessage::system(note.clone()));
            }
            inserted_note = true;
        }
        if is_pinned || is_survivor {
            rebuilt.push(message.clone());
        }
    }
    if !inserted_note {
        if let Some(note) = &note {
            rebuilt.push(ChatMessage::system(note.clone()));
        }
    }

    let degradation = Degradation::ContextReduced {
        dropped_messages: dropped.len(),
        approx_dropped_tokens: dropped_tokens,
        strategy: summariser.strategy(),
    };
    let mut reduced = request;
    reduced.messages = rebuilt;
    Ok((reduced, vec![degradation]))
}

/// Index of the first message of the last user turn.
fn last_user_turn_start(messages: &[ChatMessage]) -> usize {
    messages
        .iter()
        .rposition(|message| message.role == MessageRole::User)
        .unwrap_or(messages.len().saturating_sub(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn long_message(role: MessageRole, marker: &str, chars: usize) -> ChatMessage {
        ChatMessage::new(
            role,
            vec![ContentPart::text(format!("{marker}{}", "x".repeat(chars)))],
        )
    }

    #[test]
    fn a_conversation_that_fits_is_returned_untouched() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::system("be brief"))
            .with_message(ChatMessage::user("hello"));
        let (fitted, degradations) =
            fit_request(request.clone(), ContextBudget::new(8_192), &ElisionNote).unwrap();
        assert_eq!(fitted.messages, request.messages);
        assert!(degradations.is_empty(), "no degradation without a reduction");
    }

    #[test]
    fn oldest_turns_are_dropped_and_the_drop_is_visible_in_the_prompt() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::system("system prompt"))
            .with_message(long_message(MessageRole::User, "oldest ", 4_000))
            .with_message(long_message(MessageRole::Assistant, "reply ", 4_000))
            .with_message(ChatMessage::user("the current question"));

        let budget = ContextBudget {
            window_tokens: 1_000,
            reserve_output_tokens: 100,
        };
        let (fitted, degradations) = fit_request(request, budget, &ElisionNote).unwrap();

        let texts: Vec<String> = fitted.messages.iter().map(ChatMessage::answer_text).collect();
        assert!(texts[0].contains("system prompt"), "system is never dropped");
        assert!(
            texts.iter().any(|text| text.contains("were omitted")),
            "the model must be told the history is incomplete: {texts:?}"
        );
        assert!(
            texts.last().unwrap().contains("the current question"),
            "the user's own message is never dropped"
        );
        assert!(!texts.iter().any(|text| text.contains("oldest")));
        assert!(matches!(
            degradations.as_slice(),
            [Degradation::ContextReduced {
                dropped_messages: 2,
                strategy: ContextStrategy::ElideOldest,
                ..
            }]
        ), "got {degradations:?}");
    }

    #[test]
    fn a_single_message_that_cannot_fit_is_refused_not_truncated() {
        let request = ChatRequest::new("m")
            .with_message(long_message(MessageRole::User, "huge ", 100_000));
        let error = fit_request(request, ContextBudget::new(4_096), &ElisionNote).unwrap_err();
        match error {
            ProviderError::ContextLengthExceeded {
                limit_tokens,
                requested_tokens,
                ..
            } => {
                assert_eq!(limit_tokens, Some(4_096));
                assert!(requested_tokens.unwrap() > 4_096);
            }
            other => panic!("silent truncation is the one forbidden outcome; got {other:?}"),
        }
    }

    #[test]
    fn a_supplied_summariser_replaces_the_history_with_its_summary() {
        struct Fixed;
        impl ConversationSummariser for Fixed {
            fn summarise(&self, dropped: &[ChatMessage]) -> Option<String> {
                Some(format!("summary of {} turns: they discussed sails", dropped.len()))
            }
        }

        let request = ChatRequest::new("m")
            .with_message(long_message(MessageRole::User, "old ", 8_000))
            .with_message(ChatMessage::user("now what?"));
        let budget = ContextBudget {
            window_tokens: 500,
            reserve_output_tokens: 50,
        };
        let (fitted, degradations) = fit_request(request, budget, &Fixed).unwrap();
        assert!(fitted.messages[0].answer_text().contains("summary of 1 turns"));
        assert!(matches!(
            degradations.as_slice(),
            [Degradation::ContextReduced {
                strategy: ContextStrategy::Summarise,
                ..
            }]
        ));
    }

    #[test]
    fn an_image_is_costed_generously_rather_than_ignored() {
        let with_image = ChatMessage::new(
            MessageRole::User,
            vec![ContentPart::Image {
                mime_type: "image/png".into(),
                data: vec![0; 16],
            }],
        );
        assert!(
            estimate_message_tokens(&with_image) >= IMAGE_TOKENS_ESTIMATE,
            "an image must not be costed as its byte length"
        );
    }

    #[test]
    fn an_unknown_window_means_no_planning_at_all() {
        let request = ChatRequest::new("m");
        assert!(
            ContextBudget::for_request(&request, None).is_none(),
            "with no known window the endpoint decides — Vela does not guess one"
        );
    }
}
