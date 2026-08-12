//! Tool calling for models that have none.
//!
//! # This is a feature, not a fallback stub
//!
//! `small-local` answers `400 tools_not_supported` to any request carrying a
//! `tools` array — even one with `tool_choice: "none"` (GATE M FINDING 6). A
//! provider layer that only knows how to send native `tools` therefore cannot
//! offer tools on that endpoint at all, which is most local runtimes.
//!
//! Emulation closes that gap in three parts, all of them real:
//!
//! 1. [`render_catalogue`] formats the tool definitions into the prompt.
//! 2. [`parse_calls`] reads a textual call back out of the model's answer, in
//!    any of the four shapes models actually emit, and strips it from what the
//!    user sees.
//! 3. [`render_results`] feeds tool results back in as an ordinary turn, so a
//!    multi-step tool conversation works on an endpoint with no tool role.
//!
//! # What it refuses to do
//!
//! A block that looks like a call but does not parse becomes a
//! [`ToolCallOutcome::Malformed`] — the same explicit failure a native
//! malformed call gets. Emulation never guesses at a half-written call, and
//! never runs one.
//!
//! Reasoning is excluded from the text this parser sees (see
//! [`ChatMessage::tool_parse_text`](crate::model::ChatMessage::tool_parse_text)):
//! a model that *thinks* about calling `delete_everything` must not thereby
//! call it.

use crate::lenient_json::parse_relaxed;
use crate::model::{
    ChatMessage, ChatRequest, ContentPart, Degradation, MalformedToolCall, MessageRole,
    ToolCallOutcome, ToolChoice, ToolDefinition,
};

const OPEN: &str = "<tool_call>";
const CLOSE: &str = "</tool_call>";

/// The instruction block placed in the system prompt.
pub fn render_catalogue(tools: &[ToolDefinition], choice: &ToolChoice) -> String {
    let mut out = String::new();
    out.push_str(
        "You have access to the following tools. To use one, reply with a single\n\
         block in exactly this form and nothing else:\n\n\
         <tool_call>{\"name\": \"<tool name>\", \"arguments\": {<arguments object>}}</tool_call>\n\n\
         Use a tool only when it is needed. If no tool is needed, answer normally\n\
         and do not emit a tool_call block.\n\n\
         Tools:\n",
    );
    for tool in tools {
        out.push_str(&format!(
            "- {}: {}\n  arguments schema: {}\n",
            tool.name,
            tool.description,
            compact(&tool.parameters)
        ));
    }
    match choice {
        ToolChoice::Required => out.push_str("\nYou must call one of these tools this turn.\n"),
        ToolChoice::Named { name } => {
            out.push_str(&format!("\nYou must call the tool `{name}` this turn.\n"))
        }
        ToolChoice::Auto | ToolChoice::None => {}
    }
    out
}

/// Rewrite a request so a model with no tool support can still be given tools.
///
/// Returns the rewritten request and the degradation to report. The `tools`
/// array is emptied — that is the point: it is what stops the 400.
pub fn emulate(request: ChatRequest) -> (ChatRequest, Vec<Degradation>) {
    if !request.offers_tools() {
        // Nothing to emulate. The catalogue is still withheld, and that is
        // itself worth reporting when the caller had tools available.
        let mut degradations = Vec::new();
        if !request.tools.is_empty() {
            degradations.push(Degradation::ToolCatalogueWithheld);
        }
        let mut stripped = request;
        stripped.tools.clear();
        return (stripped, degradations);
    }

    let catalogue = render_catalogue(&request.tools, &request.tool_choice);
    let tool_count = request.tools.len();
    let mut rewritten = request;
    rewritten.tools.clear();
    rewritten.tool_choice = ToolChoice::Auto;

    // Any tool traffic already in the history has to be flattened too: an
    // endpoint with no tool support will not accept `tool_call` parts either.
    rewritten.messages = rewritten
        .messages
        .into_iter()
        .map(flatten_tool_parts)
        .collect();

    // The catalogue goes in as its own system message, after any existing one,
    // so a user's system prompt keeps its position and its priority.
    let insert_at = rewritten
        .messages
        .iter()
        .position(|message| message.role != MessageRole::System)
        .unwrap_or(rewritten.messages.len());
    rewritten
        .messages
        .insert(insert_at, ChatMessage::system(catalogue));

    (
        rewritten,
        vec![Degradation::ToolCallingEmulated { tool_count }],
    )
}

/// Turn `ToolCall` / `ToolResult` parts into the same text form the model is
/// asked to produce, so the transcript it sees is self-consistent.
fn flatten_tool_parts(message: ChatMessage) -> ChatMessage {
    if !message
        .parts
        .iter()
        .any(|part| matches!(part, ContentPart::ToolCall { .. } | ContentPart::ToolResult { .. }))
    {
        return message;
    }
    let mut role = message.role;
    let parts = message
        .parts
        .into_iter()
        .map(|part| match part {
            ContentPart::ToolCall {
                name, arguments, ..
            } => ContentPart::text(format!(
                "{OPEN}{{\"name\": \"{name}\", \"arguments\": {}}}{CLOSE}",
                compact(&arguments)
            )),
            ContentPart::ToolResult {
                call_id,
                content,
                is_error,
            } => ContentPart::text(format!(
                "<tool_result id=\"{call_id}\"{}>{content}</tool_result>",
                if is_error { " error=\"true\"" } else { "" }
            )),
            other => other,
        })
        .collect();
    // A `tool` role message becomes an ordinary user turn: endpoints without
    // tool support reject the role outright.
    if role == MessageRole::Tool {
        role = MessageRole::User;
    }
    ChatMessage::new(role, parts)
}

/// Feed tool results back to a model that has no tool role.
pub fn render_results(results: &[(String, String, bool)]) -> ChatMessage {
    let mut text = String::from("Tool results:\n");
    for (call_id, content, is_error) in results {
        text.push_str(&format!(
            "<tool_result id=\"{call_id}\"{}>{content}</tool_result>\n",
            if *is_error { " error=\"true\"" } else { "" }
        ));
    }
    text.push_str("\nContinue, using these results.");
    ChatMessage::new(MessageRole::User, vec![ContentPart::text(text)])
}

/// The streaming half of emulation: strips `<tool_call>` blocks out of the
/// answer *as it arrives*, so the user never watches raw call markup appear.
///
/// Same problem, and the same solution, as the reasoning splitter: the tag can
/// be split across frames, so only text that cannot become a tag is released.
#[derive(Debug, Default)]
pub struct ToolCallStripper {
    pending: String,
    inside: bool,
    body: String,
    calls: Vec<ToolCallOutcome>,
}

impl ToolCallStripper {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed answer text; returns the part of it the user may see.
    pub fn push(&mut self, text: &str) -> String {
        self.pending.push_str(text);
        let mut visible = String::new();
        loop {
            if self.inside {
                match self.pending.find(CLOSE) {
                    Some(at) => {
                        let body: String = self.pending.drain(..at).collect();
                        self.body.push_str(&body);
                        self.pending.drain(..CLOSE.len());
                        let call = build_call(self.calls.len(), self.body.trim());
                        self.calls.push(call);
                        self.body.clear();
                        self.inside = false;
                    }
                    None => {
                        let safe =
                            self.pending.len() - crate::textscan::held_back(&self.pending, &[CLOSE]);
                        let body: String = self.pending.drain(..safe).collect();
                        self.body.push_str(&body);
                        break;
                    }
                }
            } else {
                match self.pending.find(OPEN) {
                    Some(at) => {
                        visible.extend(self.pending.drain(..at));
                        self.pending.drain(..OPEN.len());
                        self.inside = true;
                    }
                    None => {
                        let safe =
                            self.pending.len() - crate::textscan::held_back(&self.pending, &[OPEN]);
                        visible.extend(self.pending.drain(..safe));
                        break;
                    }
                }
            }
            if self.pending.is_empty() {
                break;
            }
        }
        visible
    }

    /// End of stream: any trailing visible text, plus every call found.
    ///
    /// A block that was opened and never closed still becomes a reported call
    /// attempt rather than leaking its markup into the answer.
    pub fn finish(mut self) -> (String, Vec<ToolCallOutcome>) {
        let rest = std::mem::take(&mut self.pending);
        if self.inside {
            self.body.push_str(&rest);
            let call = build_call(self.calls.len(), self.body.trim());
            self.calls.push(call);
            (String::new(), self.calls)
        } else {
            (rest, self.calls)
        }
    }
}

/// What [`parse_calls`] found.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedCalls {
    pub calls: Vec<ToolCallOutcome>,
    /// The answer with every call block removed — what the user should see.
    pub remaining_text: String,
}

impl ParsedCalls {
    pub fn is_empty(&self) -> bool {
        self.calls.is_empty()
    }
}

/// Read tool calls out of a model's text.
///
/// Four shapes are accepted, because models emit all four: the `<tool_call>`
/// block Vela asks for, a fenced ```json block, a `TOOL_CALL name {…}` line,
/// and a bare JSON object with `name` and `arguments`. The arguments are read
/// with the relaxed reader — small models write `{city: berlin}` — but a block
/// that still does not parse is reported, not repaired.
pub fn parse_calls(text: &str) -> ParsedCalls {
    let mut calls = Vec::new();
    let mut remaining = String::new();
    let mut rest = text;
    let mut slot = 0usize;

    while let Some(start) = rest.find(OPEN) {
        remaining.push_str(&rest[..start]);
        let after_open = &rest[start + OPEN.len()..];
        let (body, consumed) = match after_open.find(CLOSE) {
            Some(end) => (&after_open[..end], start + OPEN.len() + end + CLOSE.len()),
            // An unterminated block: take the remainder. A model that opened a
            // call and never closed it still made an attempt, and reporting the
            // attempt is better than showing the user raw markup.
            None => (after_open, rest.len()),
        };
        calls.push(build_call(slot, body.trim()));
        slot += 1;
        rest = &rest[consumed..];
    }
    remaining.push_str(rest);

    if calls.is_empty() {
        if let Some((call, cleaned)) = parse_fenced_or_bare(&remaining, slot) {
            calls.push(call);
            remaining = cleaned;
        }
    }
    if calls.is_empty() {
        if let Some((call, cleaned)) = parse_line_form(&remaining, slot) {
            calls.push(call);
            remaining = cleaned;
        }
    }

    ParsedCalls {
        calls,
        remaining_text: remaining.trim().to_owned(),
    }
}

fn build_call(slot: usize, body: &str) -> ToolCallOutcome {
    let malformed = |reason, name: Option<String>| ToolCallOutcome::Malformed {
        index: None,
        call_id: None,
        name,
        raw_arguments: bounded(body),
        reason,
    };
    let Ok(value) = parse_relaxed(body) else {
        return malformed(MalformedToolCall::UnparseableArguments, None);
    };
    let name = value
        .get("name")
        .and_then(|name| name.as_str())
        .filter(|name| !name.is_empty())
        .map(str::to_owned);
    let Some(name) = name else {
        return malformed(MalformedToolCall::MissingName, None);
    };
    let arguments = match value.get("arguments").or_else(|| value.get("parameters")) {
        None => serde_json::Value::Object(serde_json::Map::new()),
        Some(serde_json::Value::String(text)) => match parse_relaxed(text) {
            Ok(parsed) => parsed,
            Err(_) => {
                return malformed(MalformedToolCall::UnparseableArguments, Some(name));
            }
        },
        Some(other) => other.clone(),
    };
    if !arguments.is_object() {
        return malformed(MalformedToolCall::ArgumentsNotAnObject, Some(name));
    }
    ToolCallOutcome::Ok {
        call_id: format!("call_emulated_{slot}"),
        name,
        arguments,
        emulated: true,
    }
}

/// ```json { "name": …, "arguments": … } ``` or the same object bare.
fn parse_fenced_or_bare(text: &str, slot: usize) -> Option<(ToolCallOutcome, String)> {
    let candidate = crate::structured::extract_json(text)?;
    let object = candidate.as_object()?;
    if !object.contains_key("name") || !(object.contains_key("arguments") || object.contains_key("parameters")) {
        return None;
    }
    let call = build_call(slot, &candidate.to_string());
    // Remove the JSON (and any fence around it) from the visible answer.
    let cleaned = remove_json_block(text);
    Some((call, cleaned))
}

/// `TOOL_CALL: get_weather {"city":"berlin"}` — the shape instruct-tuned small
/// models fall back to when they cannot manage tags.
fn parse_line_form(text: &str, slot: usize) -> Option<(ToolCallOutcome, String)> {
    let upper = text.to_uppercase();
    let at = upper.find("TOOL_CALL")?;
    let after = &text[at + "TOOL_CALL".len()..];
    let after = after.trim_start_matches([':', ' ', '\t']);
    let brace = after.find('{')?;
    let name = after[..brace].trim().trim_matches(['"', '`', '(']);
    if name.is_empty() {
        return None;
    }
    let arguments = &after[brace..];
    let end = matching_brace(arguments)?;
    let body = format!(
        "{{\"name\": \"{name}\", \"arguments\": {}}}",
        &arguments[..=end]
    );
    let call = build_call(slot, &body);
    let mut cleaned = String::from(&text[..at]);
    cleaned.push_str(&arguments[end + 1..]);
    Some((call, cleaned))
}

fn matching_brace(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (index, byte) in bytes.iter().enumerate() {
        match byte {
            _ if escaped => escaped = false,
            b'\\' if in_string => escaped = true,
            b'"' => in_string = !in_string,
            b'{' if !in_string => depth += 1,
            b'}' if !in_string => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

fn remove_json_block(text: &str) -> String {
    let mut out = text.to_owned();
    if let Some(start) = out.find('{') {
        if let Some(end) = matching_brace(&out[start..]) {
            out.replace_range(start..=start + end, "");
        }
    }
    out.replace("```json", "").replace("```", "")
}

fn compact(value: &serde_json::Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "{}".to_owned())
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
    use serde_json::json;

    fn tools() -> Vec<ToolDefinition> {
        vec![ToolDefinition::new(
            "get_weather",
            "Current weather for a city",
            json!({"type": "object", "properties": {"city": {"type": "string"}}}),
        )]
    }

    #[test]
    fn emulation_removes_the_tools_array_and_puts_the_catalogue_in_the_prompt() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::system("be brief"))
            .with_message(ChatMessage::user("weather in berlin?"))
            .with_tools(tools());

        let (rewritten, degradations) = emulate(request);

        assert!(
            rewritten.tools.is_empty(),
            "FINDING 6: a `tools` array is a 400 on an endpoint with no tool support"
        );
        let system: String = rewritten
            .messages
            .iter()
            .filter(|message| message.role == MessageRole::System)
            .map(ChatMessage::answer_text)
            .collect();
        assert!(system.contains("be brief"), "the user's system prompt survives");
        assert!(system.contains("get_weather"), "the catalogue is in the prompt");
        assert!(system.contains("<tool_call>"));
        assert_eq!(
            degradations,
            vec![Degradation::ToolCallingEmulated { tool_count: 1 }]
        );
    }

    #[test]
    fn tool_choice_none_withholds_the_catalogue_entirely() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::user("hi"))
            .with_tools(tools())
            .with_tool_choice(ToolChoice::None);
        let (rewritten, degradations) = emulate(request);
        assert!(rewritten.tools.is_empty());
        assert_eq!(rewritten.messages.len(), 1, "no catalogue was injected");
        assert_eq!(degradations, vec![Degradation::ToolCatalogueWithheld]);
    }

    #[test]
    fn the_tagged_form_is_parsed_and_stripped_from_the_answer() {
        let parsed = parse_calls(
            "Sure, let me look.\n<tool_call>{\"name\": \"get_weather\", \"arguments\": {\"city\": \"berlin\"}}</tool_call>\nOne moment.",
        );
        assert_eq!(
            parsed.calls,
            vec![ToolCallOutcome::Ok {
                call_id: "call_emulated_0".into(),
                name: "get_weather".into(),
                arguments: json!({"city": "berlin"}),
                emulated: true,
            }]
        );
        assert_eq!(parsed.remaining_text, "Sure, let me look.\n\nOne moment.");
    }

    #[test]
    fn the_relaxed_form_small_models_emit_is_still_a_call() {
        // No quotes anywhere — exactly what a 3B model writes, and exactly what
        // survives the mock harness's quote-stripping echo.
        let parsed = parse_calls("<tool_call>{name: get_weather, arguments: {city: berlin}}</tool_call>");
        assert_eq!(
            parsed.calls,
            vec![ToolCallOutcome::Ok {
                call_id: "call_emulated_0".into(),
                name: "get_weather".into(),
                arguments: json!({"city": "berlin"}),
                emulated: true,
            }]
        );
    }

    #[test]
    fn a_fenced_json_call_is_recognised() {
        let parsed = parse_calls(
            "I'll call it:\n```json\n{\"name\": \"get_weather\", \"arguments\": {\"city\": \"oslo\"}}\n```",
        );
        assert!(parsed.calls[0].is_ok());
        assert!(!parsed.remaining_text.contains('{'));
    }

    #[test]
    fn the_line_form_is_recognised() {
        let parsed = parse_calls("TOOL_CALL: get_weather {\"city\": \"kyiv\"}");
        assert_eq!(
            parsed.calls,
            vec![ToolCallOutcome::Ok {
                call_id: "call_emulated_0".into(),
                name: "get_weather".into(),
                arguments: json!({"city": "kyiv"}),
                emulated: true,
            }]
        );
    }

    #[test]
    fn a_block_that_will_not_parse_is_reported_never_guessed() {
        let parsed = parse_calls("<tool_call>{\"name\": \"get_weather\", \"argum</tool_call>");
        assert!(matches!(
            &parsed.calls[0],
            ToolCallOutcome::Malformed {
                reason: MalformedToolCall::UnparseableArguments,
                ..
            }
        ));
    }

    #[test]
    fn ordinary_prose_produces_no_calls_and_is_left_alone() {
        let answer = "The weather in Berlin is sunny. No tools were needed.";
        let parsed = parse_calls(answer);
        assert!(parsed.is_empty());
        assert_eq!(parsed.remaining_text, answer);
    }

    #[test]
    fn prose_containing_a_plain_json_object_is_not_mistaken_for_a_call() {
        let parsed = parse_calls("Here is some data: {\"city\": \"berlin\"} — that is all.");
        assert!(
            parsed.is_empty(),
            "only an object with name+arguments is a call: {parsed:?}"
        );
    }

    #[test]
    fn multiple_tagged_calls_are_all_returned() {
        let parsed = parse_calls(
            "<tool_call>{\"name\":\"a\",\"arguments\":{}}</tool_call><tool_call>{\"name\":\"b\",\"arguments\":{}}</tool_call>",
        );
        assert_eq!(parsed.calls.len(), 2);
        assert!(parsed.calls.iter().all(ToolCallOutcome::is_ok));
    }

    #[test]
    fn history_containing_tool_traffic_is_flattened_for_an_endpoint_with_no_tool_role() {
        let request = ChatRequest::new("m")
            .with_message(ChatMessage::user("weather?"))
            .with_message(ChatMessage::new(
                MessageRole::Assistant,
                vec![ContentPart::ToolCall {
                    call_id: "c1".into(),
                    name: "get_weather".into(),
                    arguments: json!({"city": "berlin"}),
                }],
            ))
            .with_message(ChatMessage::new(
                MessageRole::Tool,
                vec![ContentPart::ToolResult {
                    call_id: "c1".into(),
                    content: "21C".into(),
                    is_error: false,
                }],
            ))
            .with_message(ChatMessage::user("and tomorrow?"))
            .with_tools(tools());

        let (rewritten, _) = emulate(request);
        assert!(
            !rewritten
                .messages
                .iter()
                .any(|message| message.role == MessageRole::Tool),
            "the tool role would be rejected outright"
        );
        let flattened: String = rewritten.messages.iter().map(ChatMessage::answer_text).collect();
        assert!(flattened.contains("<tool_call>{\"name\": \"get_weather\""));
        assert!(flattened.contains("<tool_result id=\"c1\">21C</tool_result>"));
    }

    #[test]
    fn the_stripper_never_lets_call_markup_reach_the_user_even_split_across_frames() {
        let mut stripper = ToolCallStripper::new();
        let mut visible = String::new();
        // The tag arrives in pieces, exactly as a real stream delivers it.
        for fragment in [
            "Let me check. <tool",
            "_call>{\"name\": \"get_wea",
            "ther\", \"arguments\": {\"city\": \"berlin\"}}</tool",
            "_call> Done.",
        ] {
            visible.push_str(&stripper.push(fragment));
        }
        let (tail, calls) = stripper.finish();
        visible.push_str(&tail);
        assert_eq!(visible, "Let me check.  Done.");
        assert!(!visible.contains("tool_call"), "markup leaked: {visible:?}");
        assert_eq!(calls.len(), 1);
        assert!(calls[0].is_ok());
    }

    #[test]
    fn an_unclosed_block_is_reported_rather_than_leaked() {
        let mut stripper = ToolCallStripper::new();
        let visible = stripper.push("thinking... <tool_call>{\"name\": \"a\", \"argum");
        let (_, calls) = stripper.finish();
        assert_eq!(visible, "thinking... ");
        assert_eq!(calls.len(), 1);
        assert!(!calls[0].is_ok(), "a truncated call must not be executable");
    }

    #[test]
    fn results_are_fed_back_as_an_ordinary_turn() {
        let message = render_results(&[("c1".into(), "21C".into(), false)]);
        assert_eq!(message.role, MessageRole::User);
        assert!(message.answer_text().contains("<tool_result id=\"c1\">21C"));
    }
}
