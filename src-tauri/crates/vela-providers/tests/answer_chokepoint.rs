//! **The audit FINDING 3 asks for: is the same asymmetry anywhere else?**
//!
//! The defect existed because one adapter routed the answer rescued out of an
//! unterminated reasoning block through its stripper and another did not. That
//! is not a bug in a line; it is what happens when an invariant is carried by
//! *private methods each adapter has to remember to call*. Round 2 learned this
//! about response bodies —
//!
//! > "A security property carried by an overridable method that defaults to no
//! > protection is not a security property."
//!
//! — and round 4 learned it again about response headers. This file applies the
//! same conclusion to answer text.
//!
//! # Why the property is stated over the source
//!
//! [`AnswerChannel`](vela_providers::answer::AnswerChannel) holds the
//! accumulated `Vec<ContentPart>` behind a private field, and the compile-fail
//! doctests on that module prove an adapter cannot append to it directly. A
//! private field cannot, however, stop an adapter from keeping a *second*
//! accumulator of its own, or from emitting a `TextDelta` it built itself —
//! and that is exactly the shape of the defect. It was not a violation of a
//! type. It was a duplicate path around one.
//!
//! So the property is checked against the tree, the way
//! `vela-settings/tests/capability_matrix_endpoints.rs` checks "an HTTP client
//! exists in exactly one crate".
//!
//! # The exceptions are named, not swept up
//!
//! Three files outside `answer.rs` legitimately build a `TextDelta`, and each
//! is listed in [`PERMITTED`] with the reason. None of them is a wire
//! assembler; none of them ever sees endpoint text that has not already left
//! the channel. A fourth has to be added on purpose, with a reason, by someone
//! who read this — which is the whole point.
//!
//! A test over source text is a blunt instrument and does not pretend
//! otherwise. It cannot stop a determined contributor. What it stops is what
//! actually happened: a branch quietly growing its own path to the user because
//! the shared one was a convention rather than a wall. It fails in CI, naming
//! the file.
//!
//! This test reads files. It makes no claim about any endpoint.

use std::path::{Path, PathBuf};

use vela_providers::MalformedToolCall;

/// The one builder of user-visible answer text, and the files allowed to build
/// a `TextDelta` for a reason that is not "assembling a response".
const PERMITTED: [(&str, &str); 4] = [
    (
        "src/answer.rs",
        "THE chokepoint: every character of answer the user reads is emitted \
         here, after the emulated-tool-call stripper has seen it",
    ),
    (
        "src/event.rs",
        "`emit_whole_response` replays the parts of an ALREADY-ASSEMBLED \
         `ChatResponse` for providers that cannot stream. Those parts left the \
         channel before it was built; nothing endpoint-supplied enters here",
    ),
    (
        "src/lib.rs",
        "`EchoProvider` — a built-in fake with no endpoint behind it at all. \
         Its text is the user's own message",
    ),
    (
        "src/router.rs",
        "the router's own scripted test provider; no wire, no model text",
    ),
];

/// The files that turn endpoint bytes into user-visible text. **Zero** of these
/// may build a `TextDelta`: that is what the channel is for.
const ASSEMBLERS: [&str; 3] = [
    "src/stream.rs",
    "src/google/stream.rs",
    "src/anthropic/stream.rs",
];

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn sources() -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir)
            .expect("readable source directory")
            .flatten()
        {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push(path);
            }
        }
    }
    let mut out = Vec::new();
    walk(&crate_dir().join("src"), &mut out);
    out.sort();
    out
}

fn relative(path: &Path) -> String {
    path.strip_prefix(crate_dir())
        .unwrap_or(path)
        .display()
        .to_string()
        .replace('\\', "/")
}

/// Shipping code only: `//` comments stripped so a doc comment *about* the
/// chokepoint does not read as a second one, and everything from the first
/// `#[cfg(test)]` onwards dropped so a module's own tests do not count.
fn shipping_code(text: &str) -> String {
    let text = match text.find("#[cfg(test)]") {
        Some(at) => &text[..at],
        None => text,
    };
    text.lines()
        .map(|line| match line.find("//") {
            Some(at) => &line[..at],
            None => line,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A construction, not a pattern match: every one of these reaches the user
/// through `EventSink::emit`, so the call is the signature.
const BUILD: &str = "emit(StreamEvent::TextDelta";

#[test]
fn answer_text_reaches_the_user_from_one_place_and_three_named_exceptions() {
    let permitted: Vec<&str> = PERMITTED.iter().map(|(file, _)| *file).collect();
    let mut unexpected: Vec<String> = Vec::new();
    for path in sources() {
        if !shipping_code(&std::fs::read_to_string(&path).expect("readable source")).contains(BUILD)
        {
            continue;
        }
        let name = relative(&path);
        if !permitted.contains(&name.as_str()) {
            unexpected.push(name);
        }
    }
    assert!(
        unexpected.is_empty(),
        "{unexpected:?} build a TextDelta and are not in this test's PERMITTED \
         list. That is the shape of FINDING 3: the OpenAI-compatible assembler \
         emitted a TextDelta of its own for text rescued out of an \
         unterminated <think> block, so the tool-call stripper never saw it, \
         its raw <tool_call> markup streamed to the UI, and the untagged-shape \
         fallback then parsed it into an EXECUTABLE call. Route the text \
         through `AnswerChannel::push_answer` / `AnswerChannel::close` — or, if \
         this really is a fourth exception, add it to PERMITTED with the reason \
         it can never carry unstripped model text."
    );
}

/// The chokepoint has to actually be in the chokepoint.
#[test]
fn the_channel_is_where_the_text_is_emitted() {
    let text = std::fs::read_to_string(crate_dir().join("src/answer.rs")).expect("readable");
    assert!(
        shipping_code(&text).contains(BUILD),
        "src/answer.rs no longer emits the answer; the PERMITTED list would \
         then be measuring nothing"
    );
}

/// No wire assembler emits answer text itself, and none keeps its own parts
/// vector — a second accumulator would need the same discipline, and FINDING 3
/// is what happens when only one of two gets it.
#[test]
fn no_wire_assembler_owns_a_path_to_the_user() {
    for name in ASSEMBLERS {
        let text = shipping_code(
            &std::fs::read_to_string(crate_dir().join(name)).expect("readable assembler"),
        );
        assert!(
            !text.contains(BUILD),
            "{name} emits answer text directly instead of through AnswerChannel"
        );
        assert!(
            !text.contains("parts: Vec<ContentPart>"),
            "{name} keeps its own content parts; hold an `AnswerChannel` instead"
        );
        assert!(
            text.contains("answer: AnswerChannel"),
            "{name} should accumulate through `AnswerChannel`"
        );
    }
}

/// The untagged call shapes are recognised only over
/// `AnswerChannel::executable_text` — never over "every text part", which is
/// what let salvaged text be parsed into a runnable call.
#[test]
fn the_untagged_fallback_parses_only_executable_text() {
    let text = shipping_code(
        &std::fs::read_to_string(crate_dir().join("src/stream.rs")).expect("readable"),
    );
    let at = text
        .find("parse_calls(")
        .expect("the OpenAI-compatible assembler still recognises untagged calls");
    let end = text[at..].find(';').map_or(text.len(), |end| at + end);
    let call = &text[at..end];
    assert!(
        call.contains("executable_text()"),
        "the untagged-shape fallback is being fed something other than \
         `executable_text()`, so salvaged deliberation could become a call \
         again: {call:?}"
    );
}
/// The refusal has to be legible on the other side of the IPC bridge, or it is
/// a silent drop with extra steps. `src/platform/contract.ts` declares
/// `'recoveredFromUnterminatedReasoning'` as a member of
/// `MalformedToolCallReason`; this is the Rust half of that agreement.
#[test]
fn the_new_reason_serialises_as_the_typescript_contract_declares() {
    let json = serde_json::to_string(&MalformedToolCall::RecoveredFromUnterminatedReasoning)
        .expect("a fieldless variant serialises");
    assert_eq!(json, "\"recoveredFromUnterminatedReasoning\"");

    let contract = std::fs::read_to_string(
        crate_dir()
            .ancestors()
            .nth(3)
            .expect("crates/<name> sits three levels below the repo root")
            .join("src/platform/contract.ts"),
    )
    .expect("readable contract");
    assert!(
        contract.contains("'recoveredFromUnterminatedReasoning'"),
        "the TypeScript mirror of MalformedToolCallReason is missing the variant"
    );
}
