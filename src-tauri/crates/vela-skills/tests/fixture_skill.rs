//! The worked example, parsed from disk by the code that will parse the user's.
//!
//! `crates/vela-skills/tests/fixtures/hello-vela/` is a real skill directory
//! committed to this repository, and this test reads it through the ordinary
//! store API — no inline string, no fixture builder. It is here for two
//! reasons.
//!
//! The first is that every other test in this crate writes its own skill into a
//! temporary directory, which means every one of them agrees with the parser by
//! construction. A file that a human wrote, in an editor, and that nothing
//! generated, is the only case where the format and the reader can actually
//! disagree.
//!
//! The second is the defect `docs/references/mindshub-cowork.md` records at the
//! end of its skills section: the reference repository names a skills document
//! in its own README and does not contain it. A format whose only description is
//! prose, with no committed example, is a format each reader implements slightly
//! differently. This one is executable.

use std::path::PathBuf;

use vela_skills::{SkillListing, SkillStore};

fn fixture_store() -> SkillStore {
    SkillStore::new(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures"))
}

#[test]
fn the_committed_example_is_a_valid_skill() {
    let listed = fixture_store().list();
    assert_eq!(
        listed,
        vec![SkillListing::Skill {
            directory: "hello-vela".to_owned(),
            name: "hello-vela".to_owned(),
            description:
                "A worked example of the skill format Vela reads. Use when checking what a valid \
                 skill directory looks like, or as the starting point for writing one."
                    .to_owned(),
        }],
        "the committed example must parse with the reader that parses the user's skills"
    );
}

#[test]
fn its_body_is_the_second_level_and_arrives_only_when_asked_for() {
    let store = fixture_store();

    let listing = format!("{:?}", store.list());
    assert!(
        !listing.contains("What the three levels cost"),
        "the listing carried the body: {listing}"
    );

    let body = store.body("hello-vela").expect("the example has a body");
    assert!(body.starts_with("# Hello, Vela"));
    assert!(body.contains("What the three levels cost"));
}

#[test]
fn its_optional_frontmatter_is_read_without_being_required() {
    let source = std::fs::read_to_string(
        fixture_store().root().join("hello-vela").join("SKILL.md"),
    )
    .expect("the example file");
    let frontmatter = vela_skills::parse_frontmatter(&source).expect("valid frontmatter");

    assert_eq!(frontmatter.get("license"), Some("Apache-2.0"));
    assert_eq!(frontmatter.get("metadata.display-name"), Some("Hello, Vela"));
    // And the required pair is still what validation is built on.
    assert_eq!(frontmatter.get("name"), Some("hello-vela"));
}
