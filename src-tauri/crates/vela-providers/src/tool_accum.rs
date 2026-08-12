//! Accumulating streamed tool calls, defensively.
//!
//! # THE LOAD-BEARING RULE OF THIS FILE (MEASURED-4)
//!
//! The obvious implementation — key deltas by `index`, append `arguments` —
//! was run against the `hostile` profile and produced, verbatim:
//!
//! ```text
//! index=0 id=call_de2c67dd type=function  name=MISSING  argumentsParse=FAILED
//! index=7 id=MISSING       type=funktion  name=get_weather argumentsParse=FAILED
//! ```
//!
//! The name arrived in a delta carrying **no `index` at all** and was dropped;
//! the second call has no id, a misspelled discriminator, and an index that
//! jumps from 0 to 7. Code treating `index` as an array offset either writes
//! into the wrong slot or allocates seven empty calls.
//!
//! So: slots are Vela's own, allocated in arrival order and *mapped* from the
//! wire index. An unindexed delta opens a slot; the first indexed delta claims
//! that slot rather than starting a second one — in every stream observed, both
//! belong to the same call. And nothing that fails to parse is ever repaired
//! into something executable: it becomes a
//! [`ToolCallOutcome::Malformed`](crate::model::ToolCallOutcome) the UI shows.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::event::ToolCallDelta;
use crate::model::{MalformedToolCall, ToolCallOutcome};

/// Longest raw argument text kept for a malformed call. It is shown to the
/// user as evidence, so it is bounded like any other detail string.
const MAX_RAW_ARGUMENTS: usize = 400;

#[derive(Debug, Default)]
struct Slot {
    wire_index: Option<u32>,
    id: Option<String>,
    name: Option<String>,
    arguments: String,
    /// `type` was present and was not `function`.
    bad_discriminator: bool,
}

#[derive(Debug, Default)]
pub struct ToolCallAccumulator {
    slots: Vec<Slot>,
    by_wire_index: BTreeMap<u32, usize>,
    /// The slot the last delta touched — where an unindexed continuation goes.
    last_touched: Option<usize>,
}

impl ToolCallAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.slots.is_empty()
    }

    /// Merge one wire delta. Returns a UI-facing delta when anything changed.
    ///
    /// `raw` is one element of `delta.tool_calls` (streaming) or of
    /// `message.tool_calls` (non-streaming) — the same shape, deliberately
    /// handled by the same code so the two paths cannot diverge.
    pub fn push(&mut self, raw: &Value) -> Option<ToolCallDelta> {
        let object = raw.as_object()?;
        let wire_index = object.get("index").and_then(Value::as_u64).map(|i| i as u32);
        let slot_index = self.slot_for(wire_index);

        let id = object.get("id").and_then(Value::as_str);
        let type_field = object.get("type").and_then(Value::as_str);
        let function = object.get("function").and_then(Value::as_object);
        let name = function
            .and_then(|f| f.get("name"))
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty());
        let arguments = function
            .and_then(|f| f.get("arguments"))
            .and_then(Value::as_str)
            .unwrap_or_default();

        let slot = &mut self.slots[slot_index];
        if let Some(id) = id.filter(|id| !id.is_empty()) {
            slot.id.get_or_insert_with(|| id.to_owned());
        }
        if let Some(name) = name {
            slot.name.get_or_insert_with(|| name.to_owned());
        }
        if let Some(type_field) = type_field {
            if type_field != "function" {
                slot.bad_discriminator = true;
            }
        }
        slot.arguments.push_str(arguments);

        Some(ToolCallDelta {
            slot: slot_index as u32,
            call_id: slot.id.clone(),
            name: slot.name.clone(),
            arguments_fragment: arguments.to_owned(),
        })
    }

    /// Which slot does a delta with this wire index belong to?
    fn slot_for(&mut self, wire_index: Option<u32>) -> usize {
        match wire_index {
            Some(index) => {
                if let Some(existing) = self.by_wire_index.get(&index) {
                    self.last_touched = Some(*existing);
                    return *existing;
                }
                // Adopt an open, still-unindexed slot rather than starting a
                // second one — this is the `hostile` case where `{function:
                // {name}}` arrives before `{index, id, type}`.
                if let Some(orphan) = self
                    .slots
                    .iter()
                    .position(|slot| slot.wire_index.is_none() && !slot.is_empty())
                {
                    self.slots[orphan].wire_index = Some(index);
                    self.by_wire_index.insert(index, orphan);
                    self.last_touched = Some(orphan);
                    return orphan;
                }
                self.slots.push(Slot {
                    wire_index: Some(index),
                    ..Slot::default()
                });
                let slot = self.slots.len() - 1;
                self.by_wire_index.insert(index, slot);
                self.last_touched = Some(slot);
                slot
            }
            // No index: continue the slot we were last working on, or open one.
            None => match self.last_touched {
                Some(slot) => slot,
                None => {
                    self.slots.push(Slot::default());
                    let slot = self.slots.len() - 1;
                    self.last_touched = Some(slot);
                    slot
                }
            },
        }
    }

    /// Resolve every slot into an outcome.
    ///
    /// Failure precedence is fixed so the reported reason is reproducible:
    /// missing name → bad discriminator → unparseable arguments → arguments
    /// that are not an object.
    pub fn finish(self) -> Vec<ToolCallOutcome> {
        self.slots
            .into_iter()
            .enumerate()
            .filter(|(_, slot)| !slot.is_empty())
            .map(|(position, slot)| slot.into_outcome(position))
            .collect()
    }
}

impl Slot {
    fn is_empty(&self) -> bool {
        self.id.is_none()
            && self.name.is_none()
            && self.arguments.is_empty()
            && !self.bad_discriminator
    }

    fn into_outcome(self, position: usize) -> ToolCallOutcome {
        let raw_arguments = truncate(&self.arguments);
        let malformed = |reason| ToolCallOutcome::Malformed {
            index: self.wire_index,
            call_id: self.id.clone(),
            name: self.name.clone(),
            raw_arguments: raw_arguments.clone(),
            reason,
        };

        let Some(name) = self.name.clone() else {
            return malformed(MalformedToolCall::MissingName);
        };
        if self.bad_discriminator {
            return malformed(MalformedToolCall::UnknownDiscriminator);
        }

        let trimmed = self.arguments.trim();
        // A call with no arguments at all is legitimate (`get_time()`), and is
        // the one absence that is not an error.
        let arguments = if trimmed.is_empty() {
            Value::Object(serde_json::Map::new())
        } else {
            match serde_json::from_str::<Value>(trimmed) {
                Ok(value) => value,
                Err(_) => return malformed(MalformedToolCall::UnparseableArguments),
            }
        };
        if !arguments.is_object() {
            return malformed(MalformedToolCall::ArgumentsNotAnObject);
        }

        ToolCallOutcome::Ok {
            // A missing id is Vela's bookkeeping problem, not the model's: the
            // id only has to correlate a result with a call within this turn.
            // Synthesised deterministically so a retry produces the same one.
            call_id: self
                .id
                .unwrap_or_else(|| format!("call_slot_{position}")),
            name,
            arguments,
            emulated: false,
        }
    }
}

fn truncate(raw: &str) -> String {
    if raw.chars().count() <= MAX_RAW_ARGUMENTS {
        return raw.to_owned();
    }
    let mut out: String = raw.chars().take(MAX_RAW_ARGUMENTS).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn accumulate(deltas: &[Value]) -> Vec<ToolCallOutcome> {
        let mut accumulator = ToolCallAccumulator::new();
        for delta in deltas {
            accumulator.push(delta);
        }
        accumulator.finish()
    }

    #[test]
    fn a_well_formed_streamed_call_reassembles() {
        let outcomes = accumulate(&[
            json!({"index": 0, "id": "call_1", "type": "function",
                   "function": {"name": "get_weather", "arguments": ""}}),
            json!({"index": 0, "function": {"arguments": "{\"cit"}}),
            json!({"index": 0, "function": {"arguments": "y\":\"berlin\"}"}}),
        ]);
        assert_eq!(
            outcomes,
            vec![ToolCallOutcome::Ok {
                call_id: "call_1".into(),
                name: "get_weather".into(),
                arguments: json!({"city": "berlin"}),
                emulated: false,
            }]
        );
    }

    #[test]
    fn a_name_that_arrives_with_no_index_is_not_lost() {
        // Verbatim from the hostile stream: name first with no index at all,
        // then id and type two frames later, then the arguments.
        let outcomes = accumulate(&[
            json!({"function": {"name": "get_weather"}}),
            json!({"index": 0, "id": "call_de2c67dd", "type": "function"}),
            json!({"index": 0, "function": {"arguments": "{\"city\":\"berlin\",\"un"}}),
        ]);
        assert_eq!(outcomes.len(), 1, "one call, not two: {outcomes:#?}");
        match &outcomes[0] {
            ToolCallOutcome::Malformed {
                name,
                call_id,
                reason,
                raw_arguments,
                ..
            } => {
                assert_eq!(name.as_deref(), Some("get_weather"), "the name survived");
                assert_eq!(call_id.as_deref(), Some("call_de2c67dd"));
                assert_eq!(*reason, MalformedToolCall::UnparseableArguments);
                assert_eq!(raw_arguments, "{\"city\":\"berlin\",\"un");
            }
            other => panic!("truncated arguments must not be executable: {other:?}"),
        }
    }

    #[test]
    fn an_index_jump_does_not_allocate_empty_calls() {
        let outcomes = accumulate(&[
            json!({"index": 0, "id": "a", "type": "function",
                   "function": {"name": "one", "arguments": "{}"}}),
            json!({"index": 7, "type": "funktion",
                   "function": {"name": "get_weather", "arguments": "not-json-at-all"}}),
        ]);
        assert_eq!(
            outcomes.len(),
            2,
            "index 7 must not become eight slots: {outcomes:#?}"
        );
        assert!(outcomes[0].is_ok());
        match &outcomes[1] {
            ToolCallOutcome::Malformed { index, reason, .. } => {
                assert_eq!(*index, Some(7), "the wire index is reported, not obeyed");
                assert_eq!(
                    *reason,
                    MalformedToolCall::UnknownDiscriminator,
                    "`funktion` is reported before the argument problem"
                );
            }
            other => panic!("expected malformed, got {other:?}"),
        }
    }

    #[test]
    fn an_empty_function_object_adds_nothing_and_breaks_nothing() {
        let outcomes = accumulate(&[
            json!({"index": 0, "id": "a", "type": "function",
                   "function": {"name": "one", "arguments": "{}"}}),
            json!({"index": 0, "function": {}}),
        ]);
        assert_eq!(outcomes.len(), 1);
        assert!(outcomes[0].is_ok());
    }

    #[test]
    fn a_call_with_no_id_is_still_executable_with_a_synthesised_one() {
        let outcomes = accumulate(&[json!({
            "index": 0, "type": "function",
            "function": {"name": "get_time", "arguments": ""}
        })]);
        match &outcomes[0] {
            ToolCallOutcome::Ok {
                call_id,
                arguments,
                name,
                ..
            } => {
                assert_eq!(name, "get_time");
                assert_eq!(arguments, &json!({}), "no arguments is a valid call");
                assert!(!call_id.is_empty(), "a correlation id is always present");
            }
            other => panic!("expected an executable call, got {other:?}"),
        }
    }

    #[test]
    fn a_call_with_no_name_is_reported_not_dropped() {
        let outcomes = accumulate(&[json!({
            "index": 0, "id": "call_x", "type": "function",
            "function": {"arguments": "{\"a\":1}"}
        })]);
        assert!(matches!(
            &outcomes[0],
            ToolCallOutcome::Malformed {
                reason: MalformedToolCall::MissingName,
                ..
            }
        ));
    }

    #[test]
    fn arguments_that_parse_to_a_non_object_are_refused() {
        let outcomes = accumulate(&[json!({
            "index": 0, "id": "c", "type": "function",
            "function": {"name": "n", "arguments": "[1,2,3]"}
        })]);
        assert!(matches!(
            &outcomes[0],
            ToolCallOutcome::Malformed {
                reason: MalformedToolCall::ArgumentsNotAnObject,
                ..
            }
        ));
    }

    #[test]
    fn a_delta_that_is_not_an_object_is_ignored_rather_than_fatal() {
        let mut accumulator = ToolCallAccumulator::new();
        assert!(accumulator.push(&json!("nonsense")).is_none());
        assert!(accumulator.is_empty());
    }
}
