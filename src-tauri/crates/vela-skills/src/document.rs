//! Parsing one skill document.
//!
//! A skill is a **directory** containing at minimum a file named SKILL.md: YAML
//! frontmatter between two `---` lines, then a Markdown body. That is the
//! public Agent Skills format (`agentskills.io`), not a Vela invention and not
//! the reference's invention either — `docs/references/mindshub-cowork.md` §6
//! establishes that the reference builds on the public spec, so Vela reads the
//! same files rather than a proprietary dialect.
//!
//! ## Progressive disclosure is a property of this module, not a promise about it
//!
//! The spec's loading model has three levels: `name` + `description` for every
//! installed skill, the body only when a skill activates, and the contents of
//! `scripts/`, `references/` and `assets/` only as needed. The way that is made
//! real here is that [`parse_header`] **never constructs the body**. It returns
//! a [`SkillHeader`] and the byte offset the body starts at, and the caller
//! that wants only a listing keeps the header and drops the source. There is no
//! field on [`SkillHeader`] that a body could hide in, so a listing cannot
//! accidentally carry one. [`body_of`] is the second level and is a separate
//! call; the third level is [`crate::store::SkillStore::resources`], which
//! lists names and reads no bytes.
//!
//! ## The YAML subset, and why it is a subset
//!
//! Frontmatter here is a flat map of scalars plus **one** level of nesting for
//! `metadata`. That covers every field the spec defines — `name`,
//! `description`, `license`, `compatibility`, `allowed-tools`, `metadata` — and
//! nothing else.
//!
//! Anything outside the subset is [`SkillProblem::UnsupportedFrontmatterSyntax`]
//! rather than ignored. That direction matters: a sequence, a block scalar or a
//! second level of nesting parsed by a lenient reader yields *some* value, and a
//! skill whose description silently became the first line of a folded block is a
//! skill the user cannot debug. Refusing is a sentence the UI can show; guessing
//! is not.
//!
//! A tab in the indentation is refused for the same reason: YAML forbids tabs
//! there, so a file using them means something different to every other reader
//! of this format, and agreeing with a real YAML parser about which files are
//! valid is worth more than accepting one extra file.

use serde::Serialize;

/// The one file that makes a directory a skill.
pub const SKILL_FILE_NAME: &str = "SKILL.md";

/// Longest `name`, in Unicode scalar values, from the public spec.
///
/// Scalar values rather than bytes for the reason
/// `src/platform/contract-project.ts` gives for `PROJECT_NAME_MAX_CHARS`: the
/// renderer counts UTF-16 code units, Rust counts scalars, and a limit measured
/// in bytes would reject a name neither side can explain. The name grammar is
/// ASCII-only anyway, so the three counts agree on every *valid* name — this
/// bound is what decides the message an *invalid* one gets.
pub const NAME_MAX_CHARS: usize = 64;

/// Longest `description`, in Unicode scalar values, from the public spec.
pub const DESCRIPTION_MAX_CHARS: usize = 1024;

/// Why a skill directory could not be read as a skill.
///
/// A closed vocabulary, and deliberately one without payloads. The renderer
/// owns every sentence a user reads — that is the same rule
/// `src/platform/contract-project.ts` states for `WorkingDirectoryProblem` and
/// `SkillMountProblem` — and a variant carrying "line 4, key `name`" would put
/// half of that sentence here, in a language this crate cannot localise and a
/// place the renderer cannot re-word.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillProblem {
    /// The directory exists and holds no SKILL.md.
    NoSkillFile,
    /// The file is there and could not be read: permissions, an unreadable
    /// device, or bytes that are not UTF-8.
    Unreadable,
    /// The file does not begin with a `---` line, so it has no frontmatter at
    /// all. Distinct from [`Self::UnterminatedFrontmatter`] because the repair
    /// differs: add a header, versus close the one you started.
    NoFrontmatter,
    /// A `---` opened the frontmatter and no line closed it.
    UnterminatedFrontmatter,
    /// A construct outside the supported subset — a sequence, a block scalar, a
    /// second level of nesting, a tab in the indentation. See the module header
    /// for why this is refused rather than guessed at.
    UnsupportedFrontmatterSyntax,
    /// The same key twice. Not "last one wins": two spellings of `name` in one
    /// file mean the author believes something this parser would have to pick
    /// between, and the pick is invisible.
    DuplicateFrontmatterKey,
    MissingName,
    MissingDescription,
    /// The name is not `lowercase-alphanumeric-with-single-hyphens`. Covers a
    /// leading hyphen, a trailing hyphen, a doubled hyphen, any uppercase and
    /// any character outside `a`–`z`, `0`–`9` and `-` in one variant, because
    /// they are one rule and the repair is the same.
    NameIsNotWellFormed,
    NameTooLong,
    /// The `name` in the frontmatter is not the directory's own name.
    ///
    /// The spec requires them to match. It matters more here than it does in a
    /// cloud product: the mount at `<skillsMount>/<name>` is keyed by the
    /// **directory** name, so a skill whose frontmatter disagrees is a skill
    /// that mounts under one name and introduces itself as another.
    NameDoesNotMatchDirectory,
    /// Present but empty. The spec wants a description that says what the skill
    /// does *and* when to use it; an empty one makes the first level of
    /// progressive disclosure carry nothing.
    DescriptionIsEmpty,
    DescriptionTooLong,
    /// The name handed to a lookup is not a single path segment.
    ///
    /// Refused **before** it is joined onto anything. A name carrying a
    /// separator, a drive letter or a parent reference is a directory-traversal
    /// attempt wearing a skill's clothes, and the join is the moment the
    /// traversal happens. `src/platform/contract-project.ts` states the same
    /// rule for the mount at `SkillMountProblem`, including why the resolved
    /// path is then not reported: producing it would perform the join.
    NameIsNotASinglePathSegment,
}

/// The first level of disclosure: what every installed skill costs to know.
///
/// **This type cannot hold a body.** That is the whole of the enforcement —
/// there is no field for one, so no listing path can leak one by forgetting to
/// clear it. Roughly a hundred tokens per skill, which is the budget the public
/// spec's loading model assumes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillHeader {
    pub name: String,
    pub description: String,
}

/// One `key: value` pair of frontmatter, in file order.
///
/// A `Vec` rather than a map because order is how duplicates are detected and
/// because nothing here needs random access. Nested entries under `metadata`
/// are flattened to `metadata.display-name`, which keeps the pair list one
/// shape while still recording that the nesting was there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontmatterEntry {
    pub key: String,
    pub value: String,
}

/// A parsed document, minus its body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedFrontmatter {
    pub entries: Vec<FrontmatterEntry>,
    /// Byte offset into the source where the body begins — the first byte after
    /// the closing `---` line. Returned instead of the body itself so that the
    /// listing path can drop the source without ever having built one.
    pub body_offset: usize,
}

impl ParsedFrontmatter {
    /// The first value for a key, or `None`. Duplicates are already refused by
    /// [`parse_frontmatter`], so "first" is "only".
    pub fn get(&self, key: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|entry| entry.key == key)
            .map(|entry| entry.value.as_str())
    }
}

/// Whether a string is one path segment this host is willing to join.
///
/// The character set refused is Windows's, on every platform. `:` and `"` are
/// legal in a POSIX filename and illegal in a Windows one, and Vela ships to
/// Windows: a skill store that accepts a name on Linux which cannot exist on
/// the machine the product runs on is a store that fails at mount time on the
/// only platform that matters, with a problem code about the mount rather than
/// about the name. One rule, both platforms, refused early.
///
/// This is also what keeps the junction call in `crate::mount` safe. That call
/// hands two paths to `mklink /J` through a command line, and a name carrying a
/// quote would be an argument-injection hole; a quote is refused here, three
/// layers before it could reach a command line.
pub fn is_single_path_segment(name: &str) -> bool {
    if name.is_empty() || name == "." || name == ".." {
        return false;
    }
    !name.chars().any(|c| {
        c.is_control() || matches!(c, '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*')
    })
}

/// Whether a name satisfies the public spec's grammar.
///
/// `lowercase alphanumeric and hyphens, no leading, trailing or doubled
/// hyphen`, expressed as "one or more `[a-z0-9]` runs joined by single
/// hyphens". Written as a scan rather than a regular expression because this
/// crate carries no regex dependency and the rule is four lines either way.
pub fn is_well_formed_name(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    let mut previous_was_hyphen = true; // a leading hyphen is a leading empty run
    for c in name.chars() {
        if c == '-' {
            if previous_was_hyphen {
                return false;
            }
            previous_was_hyphen = true;
        } else if c.is_ascii_lowercase() || c.is_ascii_digit() {
            previous_was_hyphen = false;
        } else {
            return false;
        }
    }
    !previous_was_hyphen
}

/// Split the frontmatter off the front of a document.
///
/// Reads no further than the closing `---`, and returns where the body starts
/// rather than the body.
pub fn parse_frontmatter(source: &str) -> Result<ParsedFrontmatter, SkillProblem> {
    // A UTF-8 byte-order mark is what a Windows editor leaves in front of a
    // file it saved as UTF-8. Skipping it here rather than at every call site
    // is the difference between "this skill is broken" and "this skill works",
    // for a difference the author cannot see in their editor.
    let bom: usize = if source.starts_with('\u{feff}') { 3 } else { 0 };
    let text = &source[bom..];

    let mut offset = bom;
    let mut lines = LineReader::new(text, bom);

    let Some(first) = lines.next() else {
        return Err(SkillProblem::NoFrontmatter);
    };
    if first.content.trim_end() != "---" {
        return Err(SkillProblem::NoFrontmatter);
    }
    offset = offset.max(first.end);

    let mut entries: Vec<FrontmatterEntry> = Vec::new();
    let mut nesting_parent: Option<String> = None;
    let mut closed = false;

    for line in lines {
        offset = line.end;
        let raw = line.content;
        let trimmed_end = raw.trim_end();

        if trimmed_end == "---" || trimmed_end == "..." {
            closed = true;
            break;
        }
        if trimmed_end.trim_start().is_empty() {
            continue;
        }
        // A `#` comment, only when it starts the line. Mid-line `#` is left
        // alone: a description saying "use for C# questions" is ordinary, and
        // stripping from the first `#` would silently truncate it.
        if trimmed_end.trim_start().starts_with('#') {
            continue;
        }
        if raw.starts_with('\t') || raw.starts_with(" \t") {
            return Err(SkillProblem::UnsupportedFrontmatterSyntax);
        }

        let indent = trimmed_end.len() - trimmed_end.trim_start().len();
        let content = trimmed_end.trim_start();

        if content.starts_with("- ") || content == "-" {
            return Err(SkillProblem::UnsupportedFrontmatterSyntax);
        }

        let Some((key, written_value)) = split_key_value(content) else {
            return Err(SkillProblem::UnsupportedFrontmatterSyntax);
        };
        // "nothing was written after the colon" is tested on the source text,
        // before quotes are stripped. `metadata:` opens a nested map; `key: ""`
        // is a scalar whose value happens to be empty, and reading emptiness
        // after `unquote` would make those two the same line.
        let written_value = written_value.trim();
        let opens_a_nested_map = written_value.is_empty();
        let value = unquote(written_value);

        match indent {
            0 => {
                if opens_a_nested_map {
                    nesting_parent = Some(key.to_owned());
                } else {
                    nesting_parent = None;
                }
                push_unique(&mut entries, key.to_owned(), value)?;
            }
            _ => {
                let Some(parent) = nesting_parent.as_deref() else {
                    return Err(SkillProblem::UnsupportedFrontmatterSyntax);
                };
                if opens_a_nested_map {
                    // A second level of nesting. Out of subset — see the header.
                    return Err(SkillProblem::UnsupportedFrontmatterSyntax);
                }
                push_unique(&mut entries, format!("{parent}.{key}"), value)?;
            }
        }
    }

    if !closed {
        return Err(SkillProblem::UnterminatedFrontmatter);
    }
    Ok(ParsedFrontmatter {
        entries,
        body_offset: offset,
    })
}

/// The first level of disclosure for one document, validated against the
/// directory it was found in.
pub fn parse_header(source: &str, directory_name: &str) -> Result<SkillHeader, SkillProblem> {
    let frontmatter = parse_frontmatter(source)?;

    let name = frontmatter.get("name").ok_or(SkillProblem::MissingName)?;
    let description = frontmatter
        .get("description")
        .ok_or(SkillProblem::MissingDescription)?;

    if name.is_empty() {
        return Err(SkillProblem::MissingName);
    }
    if name.chars().count() > NAME_MAX_CHARS {
        return Err(SkillProblem::NameTooLong);
    }
    if !is_well_formed_name(name) {
        return Err(SkillProblem::NameIsNotWellFormed);
    }
    if name != directory_name {
        return Err(SkillProblem::NameDoesNotMatchDirectory);
    }
    if description.trim().is_empty() {
        return Err(SkillProblem::DescriptionIsEmpty);
    }
    if description.chars().count() > DESCRIPTION_MAX_CHARS {
        return Err(SkillProblem::DescriptionTooLong);
    }

    Ok(SkillHeader {
        name: name.to_owned(),
        description: description.to_owned(),
    })
}

/// The second level of disclosure: the instruction text, with the blank lines
/// between the frontmatter and the first heading removed.
pub fn body_of(source: &str, frontmatter: &ParsedFrontmatter) -> String {
    source[frontmatter.body_offset..]
        .trim_start_matches(['\r', '\n'])
        .to_owned()
}

/* -------------------------------------------------------------------------- */

/// One line of the source plus the offset just past its terminator, so the
/// body offset is exact whether the file uses `\n` or `\r\n`.
struct Line<'a> {
    content: &'a str,
    end: usize,
}

struct LineReader<'a> {
    text: &'a str,
    cursor: usize,
    base: usize,
}

impl<'a> LineReader<'a> {
    fn new(text: &'a str, base: usize) -> Self {
        Self {
            text,
            cursor: 0,
            base,
        }
    }
}

impl<'a> Iterator for LineReader<'a> {
    type Item = Line<'a>;

    fn next(&mut self) -> Option<Line<'a>> {
        if self.cursor >= self.text.len() {
            return None;
        }
        let rest = &self.text[self.cursor..];
        let (content, consumed) = match rest.find('\n') {
            Some(index) => (&rest[..index], index + 1),
            None => (rest, rest.len()),
        };
        let start = self.cursor;
        self.cursor += consumed;
        Some(Line {
            content: content.strip_suffix('\r').unwrap_or(content),
            end: self.base + start + consumed,
        })
    }
}

/// `key: value`, where the key is a plain scalar key. Returns `None` for a line
/// with no `:` at all, which is what makes a stray word out of subset rather
/// than a key with an empty value.
fn split_key_value(content: &str) -> Option<(&str, &str)> {
    let colon = content.find(':')?;
    let key = content[..colon].trim_end();
    if key.is_empty()
        || !key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    Some((key, &content[colon + 1..]))
}

/// Strip one matching pair of surrounding quotes, and refuse a block scalar.
///
/// Escape sequences inside a double-quoted YAML scalar are **not** processed.
/// Doing half of that — `\n` but not `A`, say — is worse than doing none,
/// because a skill that renders one escape and prints another is a skill whose
/// author cannot tell which they got. Nothing in the spec's field set needs
/// escapes.
fn unquote(value: &str) -> String {
    if value == "|" || value == ">" || value.starts_with("|-") || value.starts_with(">-") {
        // A block scalar opener. Returning the marker as the value would make
        // a skill whose description is literally "|", so the caller checks for
        // it: see `parse_frontmatter`, which treats an empty top-level value as
        // a nested map and would otherwise accept this.
        return value.to_owned();
    }
    let bytes = value.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return value[1..value.len() - 1].to_owned();
        }
    }
    value.to_owned()
}

fn push_unique(
    entries: &mut Vec<FrontmatterEntry>,
    key: String,
    value: String,
) -> Result<(), SkillProblem> {
    if value == "|" || value == ">" || value.starts_with("|-") || value.starts_with(">-") {
        return Err(SkillProblem::UnsupportedFrontmatterSyntax);
    }
    if entries.iter().any(|entry| entry.key == key) {
        return Err(SkillProblem::DuplicateFrontmatterKey);
    }
    entries.push(FrontmatterEntry { key, value });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = "---\nname: hello-vela\ndescription: Says hello. Use when greeting.\n---\n\n# Hello\n\nBody text.\n";

    #[test]
    fn a_minimal_document_yields_a_header_and_a_body() {
        let header = parse_header(MINIMAL, "hello-vela").unwrap();
        assert_eq!(header.name, "hello-vela");
        assert_eq!(header.description, "Says hello. Use when greeting.");

        let frontmatter = parse_frontmatter(MINIMAL).unwrap();
        assert_eq!(body_of(MINIMAL, &frontmatter), "# Hello\n\nBody text.\n");
    }

    #[test]
    fn the_first_level_of_disclosure_cannot_carry_the_body() {
        // The enforcement is structural — `SkillHeader` has no field a body
        // could sit in — so this asserts the observable half: nothing that
        // comes back from a header parse contains any of the body's words.
        let header = parse_header(MINIMAL, "hello-vela").unwrap();
        let rendered = format!("{header:?}");
        assert!(!rendered.contains("Body text"), "{rendered}");
        assert!(!rendered.contains("# Hello"), "{rendered}");
    }

    #[test]
    fn windows_line_endings_and_a_byte_order_mark_are_ordinary() {
        let source =
            "\u{feff}---\r\nname: hello-vela\r\ndescription: Greets.\r\n---\r\n\r\nBody.\r\n";
        let header = parse_header(source, "hello-vela").unwrap();
        assert_eq!(header.description, "Greets.");
        let frontmatter = parse_frontmatter(source).unwrap();
        assert_eq!(body_of(source, &frontmatter), "Body.\r\n");
    }

    #[test]
    fn a_nested_metadata_map_is_read_one_level_deep() {
        let source = "---\nname: a\ndescription: d\nmetadata:\n  display-name: A Skill\n  version: 2\n---\nbody\n";
        let frontmatter = parse_frontmatter(source).unwrap();
        assert_eq!(frontmatter.get("metadata.display-name"), Some("A Skill"));
        assert_eq!(frontmatter.get("metadata.version"), Some("2"));
    }

    #[test]
    fn quotes_are_stripped_and_a_mid_line_hash_is_not_a_comment() {
        let source = "---\nname: \"a\"\ndescription: 'Answers C# questions. Use for C#.'\n---\n";
        let header = parse_header(source, "a").unwrap();
        assert_eq!(header.description, "Answers C# questions. Use for C#.");
    }

    #[test]
    fn every_refusal_has_its_own_problem() {
        let cases: &[(&str, &str, SkillProblem)] = &[
            ("body only\n", "a", SkillProblem::NoFrontmatter),
            ("---\nname: a\n", "a", SkillProblem::UnterminatedFrontmatter),
            ("---\ndescription: d\n---\n", "a", SkillProblem::MissingName),
            ("---\nname: a\n---\n", "a", SkillProblem::MissingDescription),
            (
                "---\nname: a\nname: b\ndescription: d\n---\n",
                "a",
                SkillProblem::DuplicateFrontmatterKey,
            ),
            (
                "---\nname: A\ndescription: d\n---\n",
                "A",
                SkillProblem::NameIsNotWellFormed,
            ),
            (
                "---\nname: a--b\ndescription: d\n---\n",
                "a--b",
                SkillProblem::NameIsNotWellFormed,
            ),
            (
                "---\nname: -a\ndescription: d\n---\n",
                "-a",
                SkillProblem::NameIsNotWellFormed,
            ),
            (
                "---\nname: a\ndescription: d\n---\n",
                "elsewhere",
                SkillProblem::NameDoesNotMatchDirectory,
            ),
            (
                "---\nname: a\ndescription: '   '\n---\n",
                "a",
                SkillProblem::DescriptionIsEmpty,
            ),
            (
                "---\nname: a\ndescription: |\n  folded\n---\n",
                "a",
                SkillProblem::UnsupportedFrontmatterSyntax,
            ),
            (
                "---\nname: a\ntools:\n  - read\n---\n",
                "a",
                SkillProblem::UnsupportedFrontmatterSyntax,
            ),
            (
                "---\nname: a\nmetadata:\n\tdisplay: x\n---\n",
                "a",
                SkillProblem::UnsupportedFrontmatterSyntax,
            ),
            (
                "---\nname: a\nmetadata:\n  inner:\n    deeper: x\n---\n",
                "a",
                SkillProblem::UnsupportedFrontmatterSyntax,
            ),
        ];
        for (source, directory, expected) in cases {
            assert_eq!(
                parse_header(source, directory).unwrap_err(),
                *expected,
                "source: {source:?}"
            );
        }
    }

    #[test]
    fn the_length_bounds_are_the_public_specs() {
        let long_name = "a".repeat(NAME_MAX_CHARS + 1);
        let source = format!("---\nname: {long_name}\ndescription: d\n---\n");
        assert_eq!(
            parse_header(&source, &long_name).unwrap_err(),
            SkillProblem::NameTooLong
        );

        let long_description = "d".repeat(DESCRIPTION_MAX_CHARS + 1);
        let source = format!("---\nname: a\ndescription: {long_description}\n---\n");
        assert_eq!(
            parse_header(&source, "a").unwrap_err(),
            SkillProblem::DescriptionTooLong
        );
    }

    #[test]
    fn a_traversal_attempt_is_not_a_single_path_segment() {
        for name in ["..", ".", "", "../escape", "a/b", "a\\b", "C:x", "a\"b"] {
            assert!(!is_single_path_segment(name), "{name:?} was accepted");
        }
        for name in ["hello-vela", "a", "Mixed-Case", "with space"] {
            assert!(is_single_path_segment(name), "{name:?} was refused");
        }
    }
}
