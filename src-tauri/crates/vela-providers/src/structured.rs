//! Structured output: the silent-degradation case.
//!
//! # THE LOAD-BEARING RULE OF THIS FILE (MEASURED-5)
//!
//! Three of the four profiles accept `response_format: json_schema`, answer
//! **200 OK**, and return prose. There is no field, no warning and no code in
//! the response indicating the schema was ignored — a caller that trusts the
//! request gets `JSON.parse` throwing on data it believed was validated.
//!
//! Vela therefore never *trusts* a structured request. One of two things
//! happens, chosen by [`StructuredOutputPolicy`]:
//!
//! * **Refuse** — the affordance is not offered on a model that has not been
//!   proved to honour it. The user gets an explicit
//!   `CapabilityUnsupported { capability: StructuredOutput }`.
//! * **Validate and report** — the request is sent, and the answer is validated
//!   against the schema Vela asked for. A mismatch is reported as data on the
//!   response ([`ChatResponse::structured`](crate::model::ChatResponse)), which
//!   is a `Result` precisely so it cannot be read without handling the failure.
//!
//! What must never happen is the third option: pass the prose through as if it
//! conformed. That is the gate failure.
//!
//! # THE SECOND LOAD-BEARING RULE (FINDING 4)
//!
//! There is a fourth option nobody wrote down, and it is worse than the third:
//! validate text the model **never committed to** and report the result as a
//! conforming answer.
//!
//! [`AnswerChannel`](crate::answer::AnswerChannel) already decided this for the
//! tool consumer — a call recovered out of a `<think>` block that never closed
//! is not executable — and documented `executable_text()` as *"the only text a
//! tool parser may see"*. The schema consumer is the same kind of consumer:
//! both turn model text into a machine-actionable value. It was left on the
//! convention side of that chokepoint, and the convention did not hold. A model
//! asked for JSON deliberates *in JSON*, writes
//! `{"city":"Atlantis","celsius":-273.15}`, **rejects it in the next clause**,
//! and is cut off on `length` before closing the block. That object validates.
//! [`extract_json`]'s "first balanced object in the text" finds it. The caller
//! gets `Some(Ok(v))`, which asserts the model produced `v`. It said the
//! opposite.
//!
//! ## Why the fix is a type and not six corrected call sites
//!
//! There were six: two per adapter, three adapters. A guarantee that depends on
//! six call sites remembering to pass the right string is not a guarantee — it
//! is the exact shape that produced FINDING 3, and this crate had already been
//! burned by it twice ([`BodyStream`](crate::http::BodyStream) in round 2,
//! [`ResponseHeaders`](crate::http::ResponseHeaders) in round 4).
//!
//! So [`check_answer`] no longer takes a `&str`. It takes a [`MachineText`],
//! which **cannot be built from text at all** — its only constructor takes a
//! [`ChatResponse`], and reads the committed answer off it. The wrong call does
//! not compile:
//!
//! ```compile_fail,E0308
//! use serde_json::json;
//! use vela_providers::structured::check_answer;
//! use vela_providers::ChatResponse;
//!
//! let response = ChatResponse::empty();
//! // error[E0308]: expected `&MachineText`, found `&String`
//! let _ = check_answer(&json!({"type": "object"}), &response.answer_text());
//! ```
//!
//! And there is no back door that takes a string and a provenance of the
//! caller's choosing:
//!
//! ```compile_fail,E0599
//! use vela_providers::structured::MachineText;
//!
//! // error[E0599]: no function or associated item named `committed` found
//! let _ = MachineText::committed("{\"city\":\"Atlantis\"}".to_owned());
//! ```
//!
//! [`extract_json`] and [`validate`] stay public and stay `&str`/`&Value`: they
//! are pure functions that make no provenance claim, `emulation` needs the
//! first one over text that is not an answer at all, and a control that wants
//! to rebuild the pre-fix consumer should be able to.

use serde_json::Value;

use crate::model::{ChatResponse, SchemaMismatch};

/// Answer text that a **machine consumer** may turn into a machine-actionable
/// value: the committed answer of a finished turn.
///
/// # What this type is for
///
/// It carries no data a `String` does not. What it carries is a *provenance
/// claim that cannot be forged*: the only way to obtain one is [`Self::of`],
/// which takes a [`ChatResponse`] and subtracts the tail rescued out of an
/// unterminated reasoning block. There is deliberately no `From<&str>`, no
/// `new`, and no `#[doc(hidden)]` escape hatch — including for code inside this
/// crate, which is where all six mistaken call sites lived.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MachineText(String);

impl MachineText {
    /// The committed answer of `response`: every character the user saw, minus
    /// the salvaged tail.
    ///
    /// # The conservative fallback
    ///
    /// The salvaged tail is recorded by the assembler as a suffix of the answer
    /// text and is asserted to be one. If it ever is not — a future edit that
    /// appends to `parts` after the channel has closed — the committed region
    /// cannot be located, and this returns **nothing** rather than the whole
    /// answer. An empty machine text yields a reported mismatch, which is a
    /// visible, recoverable failure; the other direction is this defect.
    pub fn of(response: &ChatResponse) -> Self {
        let visible = response.answer_text();
        let Some(salvaged) = response.salvaged_answer.as_deref() else {
            return Self(visible);
        };
        match visible.strip_suffix(salvaged) {
            Some(committed) => Self(committed.to_owned()),
            None => Self(String::new()),
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The private constructor, for this module's own tests only. It exists so
    /// the validator can be unit-tested against literals; it is `#[cfg(test)]`
    /// so it does not exist in a shipping build, and it is private so no other
    /// module — in this crate or outside it — can reach it.
    #[cfg(test)]
    fn for_test(text: &str) -> Self {
        Self(text.to_owned())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StructuredOutputPolicy {
    /// Do not send a structured request to a model that has not been proved to
    /// honour one. The default: refusing is always truthful.
    #[default]
    Refuse,
    /// Send it, then validate the answer and report any mismatch explicitly.
    ValidateAndReport,
}

/// Validate `value` against the subset of JSON Schema Vela sends.
///
/// Supported: `type` (including a list of types), `properties`, `required`,
/// `items`, `enum`. Anything else in the schema is *ignored* rather than
/// treated as a failure — an unenforced keyword is a weaker check, whereas
/// rejecting an unknown keyword would fail valid answers.
pub fn validate(schema: &Value, value: &Value) -> Result<(), SchemaMismatch> {
    validate_at("", schema, value)
}

fn validate_at(path: &str, schema: &Value, value: &Value) -> Result<(), SchemaMismatch> {
    let Some(schema) = schema.as_object() else {
        return Ok(());
    };

    if let Some(allowed) = schema.get("enum").and_then(Value::as_array) {
        if !allowed.contains(value) {
            return Err(mismatch(path, "value is not one of the allowed values"));
        }
    }

    if let Some(type_field) = schema.get("type") {
        let types: Vec<&str> = match type_field {
            Value::String(one) => vec![one.as_str()],
            Value::Array(many) => many.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        if !types.is_empty() && !types.iter().any(|name| matches_type(name, value)) {
            return Err(mismatch(
                path,
                format!("expected {}, got {}", types.join(" or "), type_name(value)),
            ));
        }
    }

    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        let object = value.as_object();
        for name in required.iter().filter_map(Value::as_str) {
            let present = object.is_some_and(|object| object.contains_key(name));
            if !present {
                return Err(mismatch(
                    &format!("{path}/{name}"),
                    "required property is missing",
                ));
            }
        }
    }

    if let (Some(properties), Some(object)) = (
        schema.get("properties").and_then(Value::as_object),
        value.as_object(),
    ) {
        for (name, child_schema) in properties {
            if let Some(child) = object.get(name) {
                validate_at(&format!("{path}/{name}"), child_schema, child)?;
            }
        }
    }

    if let (Some(items), Some(array)) = (schema.get("items"), value.as_array()) {
        for (index, child) in array.iter().enumerate() {
            validate_at(&format!("{path}/{index}"), items, child)?;
        }
    }

    Ok(())
}

fn matches_type(name: &str, value: &Value) -> bool {
    match name {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "number" => value.is_number(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        _ => true,
    }
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn mismatch(path: &str, detail: impl AsRef<str>) -> SchemaMismatch {
    SchemaMismatch::new(path, detail)
}

/// Pull the JSON value out of an answer.
///
/// Models that honour a schema return bare JSON; models that half-honour it
/// wrap the JSON in a fenced block or in a sentence. Both are read, because a
/// conforming object inside a fence is still a conforming object — but prose
/// with no JSON in it at all returns `None`, and that becomes a reported
/// mismatch rather than a silent empty result.
pub fn extract_json(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return Some(value);
    }
    // A fenced block, ```json or plain ```.
    if let Some(start) = trimmed.find("```") {
        let after = &trimmed[start + 3..];
        let after = after.strip_prefix("json").unwrap_or(after);
        if let Some(end) = after.find("```") {
            if let Ok(value) = serde_json::from_str::<Value>(after[..end].trim()) {
                return Some(value);
            }
        }
    }
    // The first balanced object in the text.
    let bytes = trimmed.as_bytes();
    let start = bytes.iter().position(|byte| *byte == b'{')?;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, byte) in bytes[start..].iter().enumerate() {
        match byte {
            _ if escaped => escaped = false,
            b'\\' if in_string => escaped = true,
            b'"' => in_string = !in_string,
            b'{' if !in_string => depth += 1,
            b'}' if !in_string => {
                depth -= 1;
                if depth == 0 {
                    return serde_json::from_str::<Value>(&trimmed[start..=start + offset]).ok();
                }
            }
            _ => {}
        }
    }
    None
}

/// Validate an answer against the schema that was requested.
///
/// Returns the parsed value on success, or the first mismatch. "There is no
/// JSON here at all" is itself a mismatch, and is the exact shape MEASURED-5
/// produces — as is "the model never committed to an answer", which arrives
/// here as an empty [`MachineText`].
///
/// `answer` is a [`MachineText`] and not a `&str` on purpose; see this module's
/// second rule.
pub fn check_answer(schema: &Value, answer: &MachineText) -> Result<Value, SchemaMismatch> {
    let Some(value) = extract_json(answer.as_str()) else {
        return Err(mismatch(
            "",
            "the model returned prose, not JSON — the schema was ignored",
        ));
    };
    validate(schema, &value)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ContentPart;
    use serde_json::json;

    /// The validator's own tests speak in literals. They go through the private
    /// test constructor rather than a public one, so nothing outside this
    /// module gains a way to assert provenance.
    fn check(schema: &Value, answer: &str) -> Result<Value, SchemaMismatch> {
        check_answer(schema, &MachineText::for_test(answer))
    }

    fn schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "city": {"type": "string"},
                "celsius": {"type": "number"},
                "tags": {"type": "array", "items": {"type": "string"}}
            },
            "required": ["city", "celsius"]
        })
    }

    #[test]
    fn a_conforming_answer_validates() {
        let value = check(&schema(), r#"{"city":"berlin","celsius":21.5}"#).unwrap();
        assert_eq!(value["city"], "berlin");
    }

    #[test]
    fn prose_where_json_was_promised_is_a_reported_mismatch() {
        // Verbatim in shape from mid-local / small-local / hostile: 200 OK,
        // prose, and nothing anywhere saying the schema was ignored.
        let answer = "Mock small-local reply to: give me the weather. north quartz beacon umber.";
        let error = check(&schema(), answer).unwrap_err();
        assert_eq!(error.path, "");
        assert!(
            error.detail.contains("prose"),
            "the mismatch must name the actual failure: {error:?}"
        );
    }

    #[test]
    fn a_missing_required_property_names_the_property() {
        let error = check(&schema(), r#"{"city":"berlin"}"#).unwrap_err();
        assert_eq!(error.path, "/celsius");
    }

    #[test]
    fn a_wrong_type_names_the_path_and_both_types() {
        let error = check(&schema(), r#"{"city":42,"celsius":1}"#).unwrap_err();
        assert_eq!(error.path, "/city");
        assert!(error.detail.contains("expected string"), "{error:?}");
    }

    #[test]
    fn nested_arrays_are_validated_elementwise() {
        let error = check(&schema(), r#"{"city":"b","celsius":1,"tags":["a",2]}"#).unwrap_err();
        assert_eq!(error.path, "/tags/1");
    }

    #[test]
    fn json_wrapped_in_a_fence_or_a_sentence_is_still_found() {
        let fenced = "Here you go:\n```json\n{\"city\":\"berlin\",\"celsius\":3}\n```\n";
        assert!(check(&schema(), fenced).is_ok());
        let inline = "The answer is {\"city\":\"berlin\",\"celsius\":3} — hope that helps.";
        assert!(check(&schema(), inline).is_ok());
    }

    #[test]
    fn an_enum_outside_its_allowed_set_is_rejected() {
        let schema = json!({"type": "object", "properties": {"unit": {"enum": ["c", "f"]}}});
        assert!(check(&schema, r#"{"unit":"k"}"#).is_err());
        assert!(check(&schema, r#"{"unit":"c"}"#).is_ok());
    }

    #[test]
    fn unknown_schema_keywords_do_not_fail_a_valid_answer() {
        let schema = json!({"type": "object", "additionalProperties": false, "$comment": "hi"});
        assert!(check(&schema, r#"{"anything":1}"#).is_ok());
    }

    // -- the second rule ------------------------------------------------

    /// The turn from FINDING 4, assembled by hand at the level `MachineText`
    /// works: the user saw the whole deliberation, and none of it was
    /// committed.
    fn deliberating_response() -> ChatResponse {
        let salvaged = "The user wants an object. My first guess is \
                        {\"city\":\"Atlantis\",\"celsius\":-273.15} — no, that city does \
                        not exist and that temperature is below absolute zero, so I must";
        let mut response = ChatResponse::empty();
        response.parts = vec![ContentPart::text(salvaged)];
        response.salvaged_answer = Some(salvaged.to_owned());
        response
    }

    #[test]
    fn a_value_only_deliberated_about_is_not_machine_text() {
        let response = deliberating_response();
        assert!(
            response.answer_text().contains("Atlantis"),
            "MEASURED-3: the user still sees what the model was thinking"
        );
        assert!(
            response.machine_text().is_empty(),
            "the model committed no answer, so there is nothing to validate: {:?}",
            response.machine_text()
        );
        let error = check_answer(&schema(), &response.machine_text()).unwrap_err();
        assert!(error.detail.contains("prose"), "{error:?}");
    }

    /// The committed half is unaffected: subtracting the salvaged tail is a
    /// change of *input*, not a weakening of the validator.
    #[test]
    fn a_committed_answer_after_a_salvaged_tail_still_validates() {
        let mut response = ChatResponse::empty();
        response.parts = vec![ContentPart::text(
            "{\"city\":\"berlin\",\"celsius\":21.5}salvaged tail",
        )];
        response.salvaged_answer = Some("salvaged tail".to_owned());
        assert_eq!(
            response.machine_text().as_str(),
            "{\"city\":\"berlin\",\"celsius\":21.5}"
        );
        let value = check_answer(&schema(), &response.machine_text()).unwrap();
        assert_eq!(value["city"], "berlin");
    }

    /// Nothing salvaged means everything is committed — the ordinary turn must
    /// not pay for the pathological one.
    #[test]
    fn a_turn_with_no_salvage_validates_its_whole_answer() {
        let mut response = ChatResponse::empty();
        response.parts = vec![ContentPart::text(
            "Here you go: {\"city\":\"berlin\",\"celsius\":3} — hope that helps.",
        )];
        assert!(check_answer(&schema(), &response.machine_text()).is_ok());
    }

    /// The fallback: a recorded tail that is not a suffix means the boundary is
    /// unlocatable, and an unlocatable boundary must fail closed.
    #[test]
    fn an_unlocatable_boundary_yields_no_machine_text_rather_than_all_of_it() {
        let mut response = ChatResponse::empty();
        response.parts = vec![ContentPart::text(r#"{"city":"berlin","celsius":1}"#)];
        response.salvaged_answer = Some("a tail that is not there".to_owned());
        assert!(
            response.machine_text().is_empty(),
            "failing open here is exactly the defect"
        );
        assert!(check_answer(&schema(), &response.machine_text()).is_err());
    }
}
