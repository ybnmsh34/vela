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

use serde_json::Value;

use crate::model::SchemaMismatch;

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

fn mismatch(path: &str, detail: impl Into<String>) -> SchemaMismatch {
    SchemaMismatch {
        path: path.to_owned(),
        detail: crate::error::detail(detail.into()),
    }
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
/// produces.
pub fn check_answer(schema: &Value, answer: &str) -> Result<Value, SchemaMismatch> {
    let Some(value) = extract_json(answer) else {
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
    use serde_json::json;

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
        let value = check_answer(&schema(), r#"{"city":"berlin","celsius":21.5}"#).unwrap();
        assert_eq!(value["city"], "berlin");
    }

    #[test]
    fn prose_where_json_was_promised_is_a_reported_mismatch() {
        // Verbatim in shape from mid-local / small-local / hostile: 200 OK,
        // prose, and nothing anywhere saying the schema was ignored.
        let answer = "Mock small-local reply to: give me the weather. north quartz beacon umber.";
        let error = check_answer(&schema(), answer).unwrap_err();
        assert_eq!(error.path, "");
        assert!(
            error.detail.contains("prose"),
            "the mismatch must name the actual failure: {error:?}"
        );
    }

    #[test]
    fn a_missing_required_property_names_the_property() {
        let error = check_answer(&schema(), r#"{"city":"berlin"}"#).unwrap_err();
        assert_eq!(error.path, "/celsius");
    }

    #[test]
    fn a_wrong_type_names_the_path_and_both_types() {
        let error = check_answer(&schema(), r#"{"city":42,"celsius":1}"#).unwrap_err();
        assert_eq!(error.path, "/city");
        assert!(error.detail.contains("expected string"), "{error:?}");
    }

    #[test]
    fn nested_arrays_are_validated_elementwise() {
        let error =
            check_answer(&schema(), r#"{"city":"b","celsius":1,"tags":["a",2]}"#).unwrap_err();
        assert_eq!(error.path, "/tags/1");
    }

    #[test]
    fn json_wrapped_in_a_fence_or_a_sentence_is_still_found() {
        let fenced = "Here you go:\n```json\n{\"city\":\"berlin\",\"celsius\":3}\n```\n";
        assert!(check_answer(&schema(), fenced).is_ok());
        let inline = "The answer is {\"city\":\"berlin\",\"celsius\":3} — hope that helps.";
        assert!(check_answer(&schema(), inline).is_ok());
    }

    #[test]
    fn an_enum_outside_its_allowed_set_is_rejected() {
        let schema = json!({"type": "object", "properties": {"unit": {"enum": ["c", "f"]}}});
        assert!(check_answer(&schema, r#"{"unit":"k"}"#).is_err());
        assert!(check_answer(&schema, r#"{"unit":"c"}"#).is_ok());
    }

    #[test]
    fn unknown_schema_keywords_do_not_fail_a_valid_answer() {
        let schema = json!({"type": "object", "additionalProperties": false, "$comment": "hi"});
        assert!(check_answer(&schema, r#"{"anything":1}"#).is_ok());
    }
}
