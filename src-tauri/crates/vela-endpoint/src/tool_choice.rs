//! `tool_choice`, in three vocabularies.
//!
//! `docs/references/unsloth-studio.md` §2 records the mapping **verbatim**, and
//! the study's own note is that it needed no correction — it is one of the very
//! few things in that document confirmed to the letter:
//!
//! > Anthropic `auto` → OpenAI `auto`, Anthropic `any` → OpenAI `required`,
//! > Anthropic `{type: "tool", name: "x"}` → OpenAI
//! > `{type: "function", function: {name: "x"}}`, Anthropic `none` → OpenAI
//! > `none`.
//!
//! ## Why this crate does not implement that table directly
//!
//! Vela already has a `tool_choice`: `vela_providers::model::ToolChoice`, with
//! four arms that happen to be exactly the four the table distinguishes. So the
//! translation here is A → Vela → B, not A → B. Two reasons, and the second is
//! the one that matters:
//!
//!  1. A direct A → B table would have to be written twice, once per direction,
//!     and the two copies would be free to disagree.
//!  2. **The brain behind this endpoint is not an OpenAI endpoint.** It is
//!     whatever Vela is configured with, reached through `Provider`, which
//!     takes a `ToolChoice`. A crate that translated Anthropic straight to
//!     OpenAI JSON would be producing a document nothing here consumes — the
//!     defect this repository keeps finding in itself, in miniature.
//!
//! The study's table is still *asserted*, in the test at the foot of this file:
//! it composes [`from_anthropic`] with [`to_openai_json`] and checks the result
//! against the four literal rows. So the pivot cannot quietly stop reproducing
//! the confirmed mapping, and the row that would break — `any` → `required`,
//! the one where the two vocabularies disagree about the word — is the one a
//! reimplementation gets wrong.

use serde_json::{json, Value};
use vela_providers::model::ToolChoice;

/// Anthropic's `tool_choice` object → Vela's.
///
/// `None` for anything unrecognised, which the caller turns into a `400`
/// rather than a silent `auto`: a client that asked for a *named* tool and
/// silently got `auto` produces an answer that looks fine and did the wrong
/// thing, which is the one forbidden outcome.
///
/// Anthropic's object also carries a "disable_parallel_tool_use" flag. Vela's
/// `ToolChoice` has nowhere to put it and this crate drops it rather than
/// pretending: parallel tool use is a property of the model behind the
/// endpoint, not of the request Vela forwards.
pub fn from_anthropic(value: &Value) -> Option<ToolChoice> {
    match value.get("type")?.as_str()? {
        "auto" => Some(ToolChoice::Auto),
        // The row the two vocabularies disagree about. Anthropic's `any` means
        // "some tool, you pick"; OpenAI spells the same thing `required`.
        "any" => Some(ToolChoice::Required),
        "tool" => Some(ToolChoice::Named {
            name: value.get("name")?.as_str()?.to_string(),
        }),
        "none" => Some(ToolChoice::None),
        _ => None,
    }
}

/// OpenAI's `tool_choice` (a string or an object) → Vela's.
pub fn from_openai(value: &Value) -> Option<ToolChoice> {
    if let Some(text) = value.as_str() {
        return match text {
            "auto" => Some(ToolChoice::Auto),
            "required" => Some(ToolChoice::Required),
            "none" => Some(ToolChoice::None),
            _ => None,
        };
    }
    if value.get("type")?.as_str()? != "function" {
        return None;
    }
    let name = value
        .get("function")
        .and_then(|function| function.get("name"))
        .and_then(Value::as_str)?;
    Some(ToolChoice::Named {
        name: name.to_string(),
    })
}

/// Vela's → OpenAI's wire form.
///
/// The three closed choices are bare strings, which is what the OpenAI schema
/// takes; only the named case is an object.
pub fn to_openai_json(choice: &ToolChoice) -> Value {
    match choice {
        ToolChoice::Auto => json!("auto"),
        ToolChoice::Required => json!("required"),
        ToolChoice::None => json!("none"),
        ToolChoice::Named { name } => json!({
            "type": "function",
            "function": { "name": name }
        }),
    }
}

/// Vela's → Anthropic's wire form. The inverse of [`from_anthropic`].
pub fn to_anthropic_json(choice: &ToolChoice) -> Value {
    match choice {
        ToolChoice::Auto => json!({ "type": "auto" }),
        ToolChoice::Required => json!({ "type": "any" }),
        ToolChoice::None => json!({ "type": "none" }),
        ToolChoice::Named { name } => json!({ "type": "tool", "name": name }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **The study's table, asserted literally.**
    ///
    /// Left column: the Anthropic `tool_choice` as the study writes it. Right
    /// column: the OpenAI form the study says it maps to, character for
    /// character. The composition through Vela's own enum must reproduce it.
    #[test]
    fn the_confirmed_anthropic_to_openai_mapping_survives_the_pivot() {
        let rows: [(Value, Value); 4] = [
            (json!({"type": "auto"}), json!("auto")),
            (json!({"type": "any"}), json!("required")),
            (
                json!({"type": "tool", "name": "x"}),
                json!({"type": "function", "function": {"name": "x"}}),
            ),
            (json!({"type": "none"}), json!("none")),
        ];

        for (anthropic, openai) in rows {
            let pivot = from_anthropic(&anthropic)
                .unwrap_or_else(|| panic!("{anthropic} must map into Vela's ToolChoice"));
            assert_eq!(
                to_openai_json(&pivot),
                openai,
                "the confirmed mapping for {anthropic} is {openai}"
            );
        }
    }

    #[test]
    fn every_row_round_trips_back_to_the_dialect_it_came_from() {
        for anthropic in [
            json!({"type": "auto"}),
            json!({"type": "any"}),
            json!({"type": "tool", "name": "x"}),
            json!({"type": "none"}),
        ] {
            let pivot = from_anthropic(&anthropic).expect("a documented row must map");
            assert_eq!(to_anthropic_json(&pivot), anthropic);
        }
    }

    #[test]
    fn the_openai_dialect_maps_into_the_same_four_arms() {
        assert_eq!(from_openai(&json!("auto")), Some(ToolChoice::Auto));
        assert_eq!(from_openai(&json!("required")), Some(ToolChoice::Required));
        assert_eq!(from_openai(&json!("none")), Some(ToolChoice::None));
        assert_eq!(
            from_openai(&json!({"type": "function", "function": {"name": "x"}})),
            Some(ToolChoice::Named {
                name: "x".to_string()
            })
        );
    }

    #[test]
    fn an_unrecognised_choice_is_refused_rather_than_softened_to_auto() {
        assert_eq!(from_anthropic(&json!({"type": "whatever"})), None);
        assert_eq!(from_anthropic(&json!({"type": "tool"})), None, "no name");
        assert_eq!(from_anthropic(&json!("auto")), None, "not an object");
        assert_eq!(
            from_openai(&json!("any")),
            None,
            "`any` is not OpenAI's word"
        );
        assert_eq!(from_openai(&json!({"type": "tool", "name": "x"})), None);
    }
}
