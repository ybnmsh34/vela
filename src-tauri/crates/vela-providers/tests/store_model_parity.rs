//! The provider content model and `vela-store`'s content model are **one
//! model**, held together mechanically.
//!
//! # Why they are declared twice
//!
//! The dependency must not exist in either direction. `vela-store`'s own docs
//! say the system of record must not depend on the provider seam; equally, the
//! provider seam has no business linking SQLite. So the shapes are declared in
//! both crates and this test — the only place that depends on both — proves
//! they are interchangeable by round-tripping every variant through JSON in
//! both directions.
//!
//! If this test fails, one side has drifted. **`vela-store` is the
//! specification**: it is the system of record, and a transcript that cannot be
//! stored is worse than a provider that cannot express something.
//!
//! The conversion itself lives at the one call site that owns both crates — the
//! Tauri host — exactly as `vela_store::model::StopReason`'s comment prescribes.

use serde_json::json;

use vela_providers::model as p;
use vela_store::model as s;

/// One of every content-part variant, with every optional field populated, so
/// a renamed or dropped field cannot slip through.
fn provider_parts() -> Vec<p::ContentPart> {
    vec![
        p::ContentPart::Text {
            text: "answer".into(),
        },
        p::ContentPart::Reasoning {
            text: "deliberation".into(),
            signature: Some("sig".into()),
            redacted: true,
        },
        p::ContentPart::Image {
            mime_type: "image/png".into(),
            data: vec![1, 2, 3, 4],
        },
        p::ContentPart::ToolCall {
            call_id: "call_1".into(),
            name: "get_weather".into(),
            arguments: json!({"city": "berlin", "days": 3}),
        },
        p::ContentPart::ToolResult {
            call_id: "call_1".into(),
            content: "21C".into(),
            is_error: true,
        },
    ]
}

fn store_parts() -> Vec<s::ContentPart> {
    vec![
        s::ContentPart::Text {
            text: "answer".into(),
        },
        s::ContentPart::Reasoning {
            text: "deliberation".into(),
            signature: Some("sig".into()),
            redacted: true,
        },
        s::ContentPart::Image {
            mime_type: "image/png".into(),
            data: vec![1, 2, 3, 4],
        },
        s::ContentPart::ToolCall {
            call_id: "call_1".into(),
            name: "get_weather".into(),
            arguments: json!({"city": "berlin", "days": 3}),
        },
        s::ContentPart::ToolResult {
            call_id: "call_1".into(),
            content: "21C".into(),
            is_error: true,
        },
    ]
}

#[test]
fn every_content_part_crosses_between_the_two_crates_unchanged() {
    for (provider_part, store_part) in provider_parts().into_iter().zip(store_parts()) {
        let provider_json = serde_json::to_value(&provider_part).expect("serialisable");
        let store_json = serde_json::to_value(&store_part).expect("serialisable");
        assert_eq!(
            provider_json, store_json,
            "the two crates disagree about this part's wire shape"
        );

        // And the bytes of one deserialise as the other, both ways round.
        let as_store: s::ContentPart = serde_json::from_value(provider_json.clone())
            .expect("provider part reads as a store part");
        let as_provider: p::ContentPart =
            serde_json::from_value(store_json).expect("store part reads as a provider part");
        assert_eq!(as_store, store_part);
        assert_eq!(as_provider, provider_part);
    }
}

#[test]
fn reasoning_is_a_distinct_part_kind_on_both_sides() {
    // The separation this whole design exists for: an assistant turn's answer
    // never contains its reasoning, in either crate.
    let provider_message = p::ChatMessage::new(
        p::MessageRole::Assistant,
        vec![
            p::ContentPart::reasoning("private"),
            p::ContentPart::text("public"),
        ],
    );
    assert_eq!(provider_message.answer_text(), "public");
    assert_eq!(
        provider_message.reasoning_text().as_deref(),
        Some("private")
    );

    let kinds: Vec<String> = serde_json::to_value(&provider_message).unwrap()["parts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|part| part["kind"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(kinds, vec!["reasoning", "text"]);
}

#[test]
fn every_role_crosses_unchanged() {
    let pairs = [
        (p::MessageRole::System, s::MessageRole::System),
        (p::MessageRole::User, s::MessageRole::User),
        (p::MessageRole::Assistant, s::MessageRole::Assistant),
        (p::MessageRole::Tool, s::MessageRole::Tool),
    ];
    for (provider_role, store_role) in pairs {
        assert_eq!(
            serde_json::to_value(provider_role).unwrap(),
            serde_json::to_value(store_role).unwrap()
        );
    }
}

#[test]
fn every_stop_reason_crosses_unchanged() {
    let pairs = [
        (p::StopReason::EndTurn, s::StopReason::EndTurn),
        (p::StopReason::MaxTokens, s::StopReason::MaxTokens),
        (p::StopReason::Cancelled, s::StopReason::Cancelled),
        (p::StopReason::ToolUse, s::StopReason::ToolUse),
        (p::StopReason::Unspecified, s::StopReason::Unspecified),
    ];
    for (provider_reason, store_reason) in pairs {
        assert_eq!(
            serde_json::to_value(provider_reason).unwrap(),
            serde_json::to_value(store_reason).unwrap(),
            "a stop reason that cannot be stored cannot be produced"
        );
    }
}

#[test]
fn token_usage_crosses_unchanged_including_its_absences() {
    let provider_usage = p::TokenUsage {
        input_tokens: Some(12),
        output_tokens: None,
        reasoning_tokens: Some(3),
        cached_input_tokens: None,
    };
    let store_usage: s::TokenUsage =
        serde_json::from_value(serde_json::to_value(provider_usage).unwrap()).unwrap();
    assert_eq!(store_usage.input_tokens, Some(12));
    assert_eq!(
        store_usage.output_tokens, None,
        "`None` means not reported, and must survive as `None` rather than becoming 0"
    );
    assert_eq!(store_usage.reasoning_tokens, Some(3));
}

/// The control: this test can fail. A part that exists on one side only would
/// be caught, so the equality above is a real constraint rather than a
/// coincidence of two empty sets.
#[test]
fn a_part_the_store_cannot_represent_would_be_caught() {
    let invented = json!({"kind": "hologram", "text": "not a real part"});
    assert!(
        serde_json::from_value::<s::ContentPart>(invented.clone()).is_err(),
        "the store must reject a part kind it does not model"
    );
    assert!(
        serde_json::from_value::<p::ContentPart>(invented).is_err(),
        "and so must the provider seam"
    );
}
