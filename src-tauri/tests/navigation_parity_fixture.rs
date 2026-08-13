//! The Rust half of `tests/parity/navigation.json`.
//!
//! The TypeScript half is `src/lib/navigation-text.test.ts`. Neither owns the
//! truth — the file does. Both read every row, so a row added here is picked up
//! there automatically, and a rule that drifts in one language fails by name in
//! the other.
//!
//! See `tests/parity/README.md` for why this shape exists at all.

use serde::Deserialize;
use vela_lib::ipc::store::{derive_title, fts_query, is_placeholder_title, MAX_TITLE_CHARS};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    max_title_chars: usize,
    untitled_title: String,
    title_derivation: Vec<Case>,
    search_query: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Case {
    name: String,
    input: String,
    expect: Option<String>,
}

fn fixture() -> Fixture {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../tests/parity/navigation.json"
    );
    let source = std::fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("cannot read the parity fixture at {path}: {error}"));
    serde_json::from_str(&source).expect("the parity fixture is valid JSON in the expected shape")
}

#[test]
fn the_fixture_agrees_with_this_build_about_its_own_constants() {
    let fixture = fixture();
    assert_eq!(fixture.max_title_chars, MAX_TITLE_CHARS);
    assert!(is_placeholder_title(&fixture.untitled_title));
}

#[test]
fn every_title_derivation_row_holds() {
    let fixture = fixture();
    assert!(
        fixture.title_derivation.len() >= 15,
        "the fixture lost rows; it is the specification, not a sample"
    );

    let mut failures = Vec::new();
    for case in &fixture.title_derivation {
        let actual = derive_title(&case.input);
        if actual != case.expect {
            failures.push(format!(
                "{}: derive_title({:?}) = {:?}, fixture says {:?}",
                case.name, case.input, actual, case.expect
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn a_derived_title_never_exceeds_the_limit_or_comes_back_blank() {
    // The rows assert specific answers; this asserts the property they are all
    // instances of, so a new row cannot quietly relax it.
    for case in fixture().title_derivation {
        let Some(title) = derive_title(&case.input) else {
            continue;
        };
        assert!(
            !title.trim().is_empty(),
            "{}: derived a blank title, which would erase the placeholder",
            case.name
        );
        assert!(
            title.chars().count() <= MAX_TITLE_CHARS + 1,
            "{}: derived {} characters, over the limit",
            case.name,
            title.chars().count()
        );
        assert!(
            !title.contains('\n'),
            "{}: a title with a newline in it breaks a single-line list row",
            case.name
        );
    }
}

#[test]
fn every_search_query_row_holds() {
    let fixture = fixture();
    let mut failures = Vec::new();
    for case in &fixture.search_query {
        let actual = fts_query(&case.input);
        if actual != case.expect {
            failures.push(format!(
                "{}: fts_query({:?}) = {:?}, fixture says {:?}",
                case.name, case.input, actual, case.expect
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn every_rewritten_query_is_one_fts5_actually_accepts() {
    // The rows pin the string. This proves the string is not merely agreed on
    // but valid — the whole reason the rewrite exists is that raw user text is
    // not.
    use vela_store::{DatabaseLocation, MessageRepository, SqliteStore};

    let store = SqliteStore::open(DatabaseLocation::InMemory).unwrap();
    for case in fixture().search_query {
        let Some(expression) = fts_query(&case.input) else {
            continue;
        };
        assert!(
            store.search_messages(&expression, 10).is_ok(),
            "{}: FTS5 rejected `{expression}`, rewritten from {:?}",
            case.name,
            case.input
        );
    }
}
