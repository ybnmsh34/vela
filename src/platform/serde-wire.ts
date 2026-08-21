/**
 * **One reader that turns a Rust identifier into the key serde puts on the
 * wire, for every guard in this repository that needs one.**
 *
 * Three parity guards read `.rs` sources off disk and compare what they find
 * against a hand-written TypeScript list. Each of them used to carry its own
 * parse. What each opens, exactly, because "over the crate" is the kind of
 * approximation this file exists to stop making:
 *
 * - `chat-contract-parity.test.ts` — five named files of
 *   `src-tauri/crates/vela-providers/src`, not the crate; the rest of that
 *   crate is adapter machinery that speaks to endpoints rather than to this
 *   contract.
 * - `skill-store-parity.test.ts` — the whole of
 *   `src-tauri/crates/vela-skills/src`, walked on disk, **plus**
 *   `src-tauri/src/ipc/skills.rs`, which is where the skills vocabulary
 *   actually crosses and which a register entry used to hand a type to without
 *   anything reading it.
 * - `project-host-parity.test.ts` — the whole of
 *   `src-tauri/crates/vela-projects/src`, walked on disk.
 *
 * `declared-commands.ts`, in this same directory, already wrote down why that is
 * not survivable, about its own much smaller reader: *"a second copy is the same
 * helper by construction, while this has a parse and two copies are two parses
 * — and the copy that is one refactor behind is the one that quietly reads
 * fewer members and turns its caller's comparison green."* That sentence was in
 * the tree while three copies of this parse were in the tree, and it described
 * what had already happened to two of them.
 *
 * ## What the copies that were left behind did
 *
 * Measured, not supposed. With `chat-contract-parity.test.ts` already hardened,
 * two one-token edits to `src-tauri/crates/vela-skills/src/store.rs` —
 * `SkillResources`'s `rename_all = "camelCase"` to `"PascalCase"`, and
 * `SkillListing`'s `tag = "kind"` to `tag = "type"` — left every assertion in
 * the guard that owns those two types passing. Re-measured rather than
 * remembered: restoring that guard from tag `run-start-2026-08-17` and running
 * it against both edits at once is 6 passed / exit 0, twice; the guard as it
 * stands now is 2 failed / exit 1 on the same two edits, twice. The
 * first sends `Scripts`/`References`/`Assets` where
 * `src/features/skills/SkillsPanel.tsx` reads `scripts`/`references`/`assets`
 * through its own `RESOURCE_GROUPS`; the
 * second makes every arm of `SkillsPanel.tsx`'s `entry.kind === 'skill'` test
 * false, so every skill the user installed renders as broken. Neither is
 * hypothetical and neither was red anywhere.
 *
 * Both had the same two causes, and both causes were fixed once, in one file:
 *
 * - A `rename_all` value outside `camelCase|snake_case` fell through to the
 *   literal `'none'` — *the same answer used for an item that genuinely has no
 *   rule*. The guard then compared raw identifiers and reported agreement serde
 *   never produced. {@link parseRustItem} **throws** instead.
 * - The internal tag key is a member of nothing, so a reader that enumerates
 *   members never sees it. {@link RustItem.tag} reads it, so a caller can
 *   compare it.
 *
 * ## The posture, and the second thing it had to learn
 *
 * **Refuse to compare what this cannot predict.** Where a serde attribute
 * severs the identifier from the key — a per-field `rename`, a `flatten`, an
 * `untagged` or `transparent` container — this throws rather than compare an
 * identifier it knows is not the key. A guard that reports agreement it never
 * checked is worse than an absent one, because the absent one does not get
 * believed.
 *
 * The first version of that refusal asked the wrong question, and a probe
 * against this tree proved it in one line. It searched the attribute text for
 * the literal `#[serde(` and refused what it found inside. So
 * `#[cfg_attr(all(), serde(rename = "Scripts"))]` — `all()` is the empty
 * conjunction, so the attribute expands unconditionally — carried a `rename`
 * past a refusal that never fired, and the guard stayed green while the field
 * crossed the bridge under a different key. Two more of the same shape: an
 * attribute written *above* the `#[derive(…)]` was outside the slice this file
 * took, and `#[rustfmt::skip]` exempts an item from the `cargo fmt --check`
 * layout the body reader depends on — one member per line — with the old parser
 * having no opinion about either.
 *
 * The question is not *"is there a `#[serde(` here I cannot model?"*. It is
 * *"can this identifier still be trusted as the wire key?"*, and the only
 * answer that survives a determined edit is **to account for every byte of
 * attribute text attached to the item, and refuse anything left over**. That is
 * what {@link parseRustItem} does: {@link readAttributeText} consumes the whole
 * region — comments, `cfg_attr` wrappers and all — reports the first stretch it
 * could not classify, and any attribute whose effect on the wire this file has
 * not written down is an error naming it. {@link INERT_ATTRIBUTES},
 * {@link CONTAINER_KEYS} and {@link FIELD_KEYS} are the whole of what it claims
 * to understand.
 *
 * ## The third thing it had to learn: everything on either side of the text
 *
 * Accounting for every byte of attribute text was the whole of the previous
 * round's fix, and a probe then went around it four times without touching an
 * attribute this file reads wrongly. Each of the four is a *recogniser standing
 * in for a question*, one layer out from the last one, and each is now answered
 * rather than recognised:
 *
 * - **Where the attributes are.** The region was whatever run of lines read as
 *   attribute text, so a block comment between the serde attribute and the
 *   derive truncated it and the attribute fell outside the refusal.
 *   {@link attributeRegionBefore} takes the region from the end of the previous
 *   item instead — a position, which nothing written inside it can move.
 * - **What a declaration is.** `^pub ` missed `pub(crate)`, missed anything
 *   indented inside a `mod`, and a `derive` naming `Serialize` missed a
 *   hand-written `impl serde::Serialize for X` — which satisfies the same trait
 *   and puts whatever keys its body writes on the wire. {@link declarationsIn}
 *   and {@link serializeImplTargetsIn} answer both.
 * - **What a member is.** The identifier alphabet could not spell `r#type`, the
 *   only legal name for a field whose wire key is `type`, and dropped it
 *   silently. {@link FIELD_DECLARATION} spells it, and a body line that is none
 *   of the shapes this file knows is now {@link refuseUnreadable} rather than a
 *   `continue`.
 * - **What the answer is compared against.** {@link RustItem.payloadFields} was
 *   one pooled set across every struct-bodied variant, so `#[serde(skip)]` on a
 *   field a sibling variant also declares left the comparison unmoved — a
 *   perfect read feeding a lossy comparison. It is keyed by variant now, and
 *   {@link payloadWireKeys} is what the guards compare.
 *
 * ## The fourth thing, which is the class and not another instance
 *
 * Each of the three rounds above closed the holes it was handed and each was
 * gone around again, one layer out. The reason is one sentence and it is worth
 * writing down rather than re-deriving: **every clause of the question this
 * file asks is a statement about text, and the contract is about a program.**
 * Where those two differ, a reader of text answers confidently and wrongly, and
 * a confident wrong answer is the failure this whole file exists to prevent.
 *
 * So the six places they were made to differ are each answered by making the
 * question the program's question, or — where that would mean writing a Rust
 * front end — by **refusing**. A refusal is not a shrug: it names the
 * construct, and it fails in the direction that cannot report a serialisable
 * type as absent.
 *
 * That section used to end by calling the class closed. It was not, and the
 * next section is why: six is the number of instances that round was handed,
 * not a property of the class. A list of constructs cannot be finished by
 * adding constructs to it.
 *
 * - **The reader was line-oriented and its refusal was line-oriented with it.**
 *   `pub assets: Vec<String>, #[serde(rename = "Scripts")] pub extra: Vec<String>,`
 *   is one line the reader *recognises and mis-answers*, so
 *   {@link refuseUnreadable} never fired and a live key crossed under `Scripts`
 *   past an assertion named *"…, and no other"*. {@link topLevelParts} makes the
 *   whole line accounted for.
 * - **The token `Serialize` is not the trait.** `use serde::Serialize as Wire;`
 *   → {@link scanSerialisable} refuses the file.
 * - **A name is not a type.** {@link parseRustItem} took the first textual
 *   declaration of a spelling; an ordinary `pub mod legacy` carrying a
 *   same-named type stood in for the type on the wire. Two declarations of one
 *   name in one file is now a refusal.
 * - **A directory is not a module tree.** `#[path = "…"]` →
 *   {@link scanSerialisable} refuses the file, which makes the directory walk's
 *   premise asserted instead of assumed.
 * - **A `where` clause is not a hazard, it is a case.** {@link itemForm} tracked
 *   only `<` and `>`, so `where [T; N]: Serialize,` read as a unit item and left
 *   the inventory silently — the exact failure that function's own doc comment
 *   describes. It tracks every bracket now, and a form it cannot decide is a
 *   throw rather than a `continue`.
 * - **An allow-list is only as good as what is written in it.**
 *   `skip_serializing_if` was recorded as leaving the key alone. It does not; it
 *   makes the key conditional. {@link RustItem.conditionalFields} is the answer
 *   and each guard compares it against the `?` keys of its own contract types,
 *   because a classification with no reader can be wrong without anything
 *   failing — which is how this one stayed wrong.
 *
 * And under all of them, {@link withoutCommentsOrStrings} is a **lexer** now
 * rather than a set of recognisers: char literals, nested block comments and
 * raw C string literals were the three Rust tokens it did not have a case for,
 * and any one of them erases arbitrary spans of live code from every
 * structural read in this file.
 *
 * ## The fifth thing: which bytes the reader is looking at
 *
 * The round after that one got past the whole list above without inventing a
 * single construct this file mis-spells. Each of the refusals named above —
 * `rename`, `flatten`, `untagged`, `transparent`, `skip_serializing_if`, a
 * `cfg_attr` wrapper, a nested block comment, a char literal, a raw string, a
 * `where` clause holding `[T; N]`, `r#type`, a duplicate name, a `Serialize`
 * alias, `#[path]` — carries a named fixture in
 * `src/platform/chat-contract-parity.test.ts`, and all of them still fire. The
 * lexer held too, in the one sense that matters: the prefix it was missing was
 * the raw C string, and the pre-fix blanker handed `cr"\\?\UNC\"` to escape
 * rules, ran off the end of the file and threw `unterminated string literal`
 * rather than blanking a declaration away. Measured, by running the pre-fix
 * blanking against that fixture.
 *
 * What got past was **one layer further out than the text, and it is about the
 * file**. Three premises were assumed rather than asked, and none of them is a
 * spelling, which is why no entry added to {@link INERT_ATTRIBUTES},
 * {@link CONTAINER_KEYS} or {@link FIELD_KEYS} could have reached any of them:
 *
 * - **The source read is not the source rustc compiles.** `#[path]` was the
 *   member of this family that had been closed; `macro_rules!` and `include!`
 *   are the two doors an attribute list has no entry for, and both put a type
 *   into the crate without putting a declaration into the text. Not
 *   hypothetical: `src-tauri/crates/vela-store/src/model.rs`'s `id_newtype!`
 *   emits a `Serialize` derive from inside a macro body and is invoked six
 *   times. {@link itemPositionMacroIn} refuses both, and it decides *item
 *   position* structurally so that the `vec!`, `matches!` and `cfg!` live in
 *   the scanned files are untouched.
 * - **A serialisable type is not the same thing as a braced item.** This scan
 *   dropped every tuple and unit item *before* asking whether it derived or
 *   implemented `Serialize`. Three `Serialize`-deriving tuple structs sit in
 *   `diagnostic.rs` today, which the chat guard reads, and the assertion that
 *   calls its inventory complete listed none of the three — so
 *   {@link scanSerialisable}'s own doctrine, *under-inclusion costs a miss*,
 *   was false about the tree it was scanning. The form is recorded on
 *   {@link SerialisableItem.form} now instead of being used to skip.
 * - **Whole-line accounting was a property of one reader, not of the file.**
 *   {@link topLevelParts} tracks `<` as a bracket on a premise its own doc
 *   comment stated as a universal — *"a struct or enum body holds no
 *   expressions"* — which a const array length falsifies. On a member line
 *   that under-split is {@link refuseSecondMember}; on the one-line
 *   struct-variant path inside {@link parseRustItem}, which iterates the same
 *   parts with no accounting of its own, it was a **silent field drop** on a
 *   live paired type. The member line is where that refusal lives, through
 *   {@link refuseUnpairedAngle}, and it covers the one-line struct-variant
 *   path because the variant's own line goes through it first — that round
 *   put a second copy of the test on the inner slice, and the second copy
 *   could not fire, which is why it is gone.
 *
 * ## The sixth thing: the alphabet, not the spelling
 *
 * Five rounds fixed how a construct is *spelled* and left alone the question
 * one level under it: **which sequences of characters this reader agrees to
 * call a name, a trait path, a macro path.** Three refusals were written
 * across three rounds and each brought a character class of its own, each
 * narrower than Rust's, each in a different place — and the sharpest evidence
 * that the narrowness was an oversight rather than a decision is that the
 * three disagreed with each other:
 *
 * - {@link declarationsIn}'s name class could not spell a leading underscore,
 *   so `#[derive(Serialize)] pub struct _StoreAuditRow { … }` produced no
 *   declaration and was on no inventory in the repository. The old
 *   `IMPL_SERIALIZE`'s *target* class **could** spell it, so
 *   `impl Serialize for _StoreAuditRow` was a loud refusal for the same name.
 *   One name, two doors, two answers. It also could not spell `r#Row`, which
 *   joined the inventory under the name `r`.
 * - `IMPL_SERIALIZE`'s generic parameter list was `<[^>]*>`, which cannot
 *   cross a nested `>`, so `impl<T: AsRef<[u8]>> Serialize for Row` matched
 *   nothing and the type was dropped by the `continue` below — a silent miss
 *   of a whole type by the one function written because a hand-written impl
 *   puts whatever keys its body writes on the wire. A leading `::serde::` was
 *   a second door through the same regex. It is a structural read now
 *   ({@link serializeImplTarget}): brackets matched, path split, last segment
 *   compared.
 * - {@link itemPositionMacroIn} tested item position from the start of the
 *   macro's *last* path segment, so every qualified invocation was measured
 *   from the `:` before it. It walks the whole path back now.
 *
 * There is one alphabet, {@link RUST_IDENTIFIER}, and the three readers share
 * it the way they share the parse.
 *
 * Two more of the same class, one layer in from the text and one layer out of
 * this file entirely:
 *
 * - **A structural read that ran on the source instead of the output.** The
 *   sentence this file states about itself — *every structural read runs on
 *   the blanked output, so a brace inside a comment cannot move it* — had
 *   exactly one exception, and it was the one-line struct-variant reader, the
 *   reader the previous round was about. `Image { mime_type: String, data:
 *   Vec<u8> /* } *\/, secret_path: String },` closed the variant at the
 *   comment's brace and dropped a live field in silence; `Text, // { ghost:
 *   String }` invented a payload key out of a comment. Every index in
 *   {@link parseRustItem} comes from `line.code` now.
 * - **A type-level check with no reach, under three sentences saying it
 *   worked.** Not in this file: `HasNoOptionalKey<T>` in the two guards that
 *   use it indexed its mapped type by `[keyof T]`, and for a union `keyof T`
 *   is only the keys common to every arm — so an optional key on any single
 *   arm was never looked at, and six of the eleven entries standing in the
 *   tree named unions and could not fail for any edit whatsoever. It
 *   distributes now, and the lists it is written in are keyed by the pairing
 *   rather than counted.
 *
 * ## What is knowingly left open
 *
 * A stated limit is honest; an unstated one is the defect. So:
 *
 * - **A macro defined elsewhere and invoked inside an inline `mod` this scan
 *   did not recognise as a module.** {@link itemPositionMacroIn}'s frame test
 *   is a two-word lookback, and where it guesses wrong it guesses towards
 *   silence.
 * - **A body line whose `<` and `>` pair with each other, stay inside one
 *   bracket group, and sit against an identifier is read as a generic argument
 *   list**, whether or not that is what it is. The three tests in
 *   {@link topLevelParts} are what that sentence is the complement of, and
 *   they are written out there. The cost in the other direction is stated too:
 *   `<T as Trait>::Output` is a legal type this reader refuses.
 * - **`#[serde(transparent)]` is still not read**, and neither is
 *   `#[serde(untagged)]` beyond refusing it.
 * - **A file named in a register's prose is not checked against anything.**
 *   That is deliberate and it is the point: {@link filePathsNamedIn} forbids
 *   prose from naming one, so the only thing a register row can point at is
 *   `handedTo`, which every guard checks. A path spelled in some way that
 *   function does not recognise is not an edge either.
 * - **`vela-providers` is inventoried for five of the thirty-seven `.rs` files
 *   under its `src`, and `src-tauri/src/ipc/` for one of its nineteen.**
 *   Inherited, and named in the file lists at the top of this comment rather
 *   than implied by them.
 * - **These guards depend on a gate they do not run.** The body reader assumes
 *   one member per line, which is rustfmt's output; `cargo fmt --all --check`
 *   runs in CI and in `pnpm lint:rust`, and nothing here asserts it. The
 *   declaration reader no longer depends on it — that was this round's fix —
 *   but the body reader still does, and the mitigation is that a line it
 *   cannot account for is a refusal rather than a mis-answer.
 * - **Whether a type is `#[serde(transparent)]` is not read.** A transparent
 *   newtype crosses as its inner value and adds no key; deleting the attribute
 *   changes what crosses and moves no assertion here. The register rows record
 *   the item's form, which is a weaker statement, and it is the one that is
 *   made.
 *
 * Nothing outside a test imports this, so it is not in the shipped bundle, and
 * `src/runtime/reachable.test.ts` asserts that rather than assuming it.
 */

/**
 * Accepts a list only when it names every member of `U` exactly once.
 *
 * Restated here rather than imported from a test, and deliberately: a
 * type-level helper has no behaviour, so a second copy is the same helper by
 * construction. That is the exact opposite of the parse below, which is why
 * this file exists and this eight-line helper does not need to.
 */
function everyVariantOf<U extends string>() {
  return <L extends readonly U[]>(
    list: L &
      ([Exclude<U, L[number]>] extends [never]
        ? unknown
        : ['this list is missing a variant', Exclude<U, L[number]>]),
  ): readonly string[] => list as readonly string[];
}

/**
 * Every `rename_all` spelling serde implements, plus the absence of one.
 *
 * The list is closed deliberately, and {@link parseRustItem} **throws** on a
 * value outside it rather than falling through to `none`. Those are not the
 * same answer. `none` says *serde applied no rule*; an unrecognised value says
 * *serde applied a rule I did not read*, and reporting the second as the first
 * is the guard asserting something it never checked.
 *
 * It is not hypothetical and it is not exotic. `Diagnosis`'s five fields are
 * all single lowercase words, so `rename_all = "camelCase"` is a no-op on it
 * and `rename_all = "PascalCase"` changes every key it puts on the wire while
 * changing no identifier in the file. Under the old two-literal regex
 * (`camelCase|snake_case`, anything else falls to `none`) that edit was green.
 * This tree already spells a third rule on a live IPC type —
 * `src-tauri/src/ipc/error.rs` carries `rename_all = "SCREAMING_SNAKE_CASE"` —
 * so the vocabulary being wider than two is demonstrated, not suspected.
 */
export type RenameRule =
  | 'lowercase'
  | 'UPPERCASE'
  | 'PascalCase'
  | 'camelCase'
  | 'snake_case'
  | 'SCREAMING_SNAKE_CASE'
  | 'kebab-case'
  | 'SCREAMING-KEBAB-CASE'
  | 'none';

/**
 * Closed by the compiler against {@link RenameRule}: a rule added to the type
 * and not to this list stops the file compiling, which is the same device
 * `everyVariantOf` performs for the wire lists above.
 */
export const RENAME_RULES = everyVariantOf<Exclude<RenameRule, 'none'>>()([
  'lowercase',
  'UPPERCASE',
  'PascalCase',
  'camelCase',
  'snake_case',
  'SCREAMING_SNAKE_CASE',
  'kebab-case',
  'SCREAMING-KEBAB-CASE',
]);

export interface RustItem {
  /** Variant names for an enum, field names for a struct — Rust spelling. */
  readonly members: readonly string[];
  readonly renameAll: RenameRule;
  /**
   * Which of serde's two `rename_all` transformations applies. One attribute
   * name, two different functions: serde reads a variant as PascalCase and a
   * field as snake_case. A single implementation is wrong for one of them,
   * silently.
   */
  readonly kind: 'variant' | 'field';
  /**
   * The internal tag key — serde's `tag = "…"` — or `null` when the item is
   * not internally tagged. A wire key that is a member of nothing, which is
   * exactly why nothing used to compare it.
   */
  readonly tag: string | null;
  /**
   * The fields inside an enum's struct-bodied variants, **keyed by the variant
   * they belong to**, each list sorted, in Rust spelling. One entry per
   * struct-bodied variant and no entry for a unit or tuple one; empty for a
   * struct, which has no variants at all.
   *
   * These are keys on the wire and they are members of nothing, so — exactly
   * like {@link tag} — they had no comparison at all until one was written for
   * them. {@link payloadWireKeys} applies {@link renameAllFields} to them.
   *
   * **Keyed rather than pooled**, and that is not a presentation choice. The
   * first version of this was one deduplicated `Set` across every struct-bodied
   * variant, compared as a flat sorted union. A probe put `#[serde(skip)]` on
   * `SkillListing::Invalid`'s `directory` — a field the sibling `Skill` variant
   * also declares — and the union did not move: the key stopped crossing on the
   * arm `src/features/skills/SkillsPanel.tsx` labels its non-skill rows with,
   * and every assertion stayed green. Which variant a key belongs to has to be
   * part of the question or a key can move between arms, or leave one, unseen.
   */
  readonly payloadFields: ReadonlyMap<string, readonly string[]>;
  /**
   * `rename_all_fields`: the rule serde applies to the fields *inside*
   * struct-bodied variants, which is a different rule from the one it applies
   * to the variant names.
   *
   * Read, rather than tolerated, because tolerating it was a hole a probe
   * walked straight through. The attribute is applied fourteen times in this
   * repository's Rust — twelve of them in the three crates these guards read —
   * so flipping one from `camelCase` to `PascalCase` is an edit that looks like
   * every other edit around it. It sends `MimeType`/`CallId`/`IsError` where
   * `src/runtime/content-part-codec.ts`'s `toInput` reads `part.mimeType` off
   * an image part, while changing no identifier and no variant name.
   * {@link payloadWireNames} is what turns that edit into a red.
   */
  readonly renameAllFields: RenameRule;
  /**
   * The members serde may leave off the wire entirely — the ones carrying
   * `#[serde(skip_serializing_if = "…")]` — in Rust spelling, sorted.
   *
   * A subset of {@link members}, not a removal from it: the key crosses
   * whenever the predicate is false, so the field is *optional* rather than
   * absent. That distinction had no reader at all until this list existed;
   * {@link FIELD_KEYS} classified the attribute as leaving the key alone, which
   * is a wrong answer written inside an allow-list, and an allow-list cannot
   * find those. {@link conditionalWireKeys} is what the guards compare against
   * the `?`-marked keys of the interface on the TypeScript side.
   */
  readonly conditionalFields: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* reading the attribute text                                                 */
/* -------------------------------------------------------------------------- */

/** One attribute as written, reduced to the path it names and its arguments. */
interface RustAttribute {
  /** `serde`, `derive`, `cfg_attr`, `rustfmt::skip` — as spelled. */
  readonly path: string;
  /**
   * The text inside `(…)`, or the right-hand side of `#[path = "…"]`, or
   * `null` for a bare `#[non_exhaustive]`.
   */
  readonly body: string | null;
}

interface AttributeRead {
  readonly attributes: readonly RustAttribute[];
  /**
   * The first stretch of text that was neither whitespace, comment, nor a
   * well-formed attribute — `null` when every byte was accounted for.
   *
   * This is the field that makes the refusal a refusal. A reader that returns
   * only what it recognised cannot tell "there was nothing else here" from "I
   * did not understand the rest", and those are the two answers the whole
   * posture of this file turns on.
   */
  readonly unaccounted: string | null;
}

const CLOSERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };

/**
 * Index just past the `*\/` that closes the block comment opening at `at`, or
 * `-1` if it never closes.
 *
 * **Rust block comments nest**, so the first terminator does not necessarily
 * close the one that opened. Both readers of comment text in this file —
 * {@link readAttributeText} over an attribute region, and
 * {@link withoutCommentsOrStrings} over a whole source — go through here, so
 * they cannot disagree about where a comment ends. They did disagree, briefly,
 * and the disagreement showed up as the blanker treating a nested comment
 * correctly while the attribute reader read its tail as unaccounted text.
 */
function blockCommentEnd(text: string, at: number): number {
  let nesting = 0;
  let index = at;
  while (index < text.length) {
    if (text.startsWith('/*', index)) {
      nesting += 1;
      index += 2;
      continue;
    }
    if (text.startsWith('*/', index)) {
      nesting -= 1;
      index += 2;
      if (nesting === 0) return index;
      continue;
    }
    index += 1;
  }
  return -1;
}

/**
 * Index of the bracket closing the one at `at`, or `-1`.
 *
 * String-aware, because attribute arguments carry string literals and a
 * `#[error("a ) in a message")]` is real Rust.
 */
function matchingBracket(text: string, at: number): number {
  const stack: string[] = [];
  let inString = false;
  for (let index = at; index < text.length; index += 1) {
    const character = text[index] as string;
    if (inString) {
      if (character === '\\') index += 1;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    const closer = CLOSERS[character];
    if (closer !== undefined) {
      stack.push(closer);
      continue;
    }
    if (character === ')' || character === ']' || character === '}') {
      if (stack.pop() !== character) return -1;
      if (stack.length === 0) return index;
    }
  }
  return -1;
}

/**
 * Splits the body of one attribute argument list on its top-level commas,
 * leaving quoted values and nested brackets alone. `skip_serializing_if =
 * "Option::is_none", default` is two arguments; a comma inside a string
 * literal is none of them, and the comma in `cfg_attr(all(), serde(…))` is one
 * of them.
 */
function splitArguments(body: string): readonly string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;
  for (const character of body) {
    if (inString) {
      current += character;
      if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '(' || character === '[' || character === '{') depth += 1;
    else if (character === ')' || character === ']' || character === '}') depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * One attribute written without its `#[…]` wrapper — `serde(rename = "x")`,
 * `derive(Serialize)`, `non_exhaustive`. `null` when the text is not that
 * shape, which the caller must treat as unaccounted rather than as absent.
 */
function parseAttributeSpec(spec: string): RustAttribute | null {
  const trimmed = spec.trim();
  const head = /^([A-Za-z_][A-Za-z0-9_]*(?:\s*::\s*[A-Za-z_][A-Za-z0-9_]*)*)/.exec(trimmed);
  if (head === null) return null;
  const path = (head[1] as string).replace(/\s+/g, '');
  const rest = trimmed.slice((head[0] as string).length).trim();
  if (rest === '') return { path, body: null };
  if (rest.startsWith('(')) {
    return matchingBracket(rest, 0) === rest.length - 1
      ? { path, body: rest.slice(1, -1) }
      : null;
  }
  if (rest.startsWith('=')) return { path, body: rest.slice(1).trim() };
  return null;
}

/**
 * Reads a block of text as attributes, and says what it could not read.
 *
 * Consumes whitespace, `//` line comments (which is how `///` doc comments
 * arrive), `/* *\/` block comments, and `#[…]` / `#![…]` attributes. The first
 * byte that is none of those ends the read and is reported through
 * {@link AttributeRead.unaccounted}.
 */
function readAttributeText(text: string): AttributeRead {
  const attributes: RustAttribute[] = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index] as string;
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (text.startsWith('//', index)) {
      const end = text.indexOf('\n', index);
      index = end < 0 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith('/*', index)) {
      const end = blockCommentEnd(text, index);
      if (end < 0) return { attributes, unaccounted: text.slice(index) };
      index = end;
      continue;
    }
    if (character === '#') {
      const open = text.startsWith('#![', index)
        ? index + 2
        : text.startsWith('#[', index)
          ? index + 1
          : -1;
      if (open < 0) return { attributes, unaccounted: text.slice(index) };
      const close = matchingBracket(text, open);
      if (close < 0) return { attributes, unaccounted: text.slice(index) };
      const parsed = parseAttributeSpec(text.slice(open + 1, close));
      if (parsed === null) return { attributes, unaccounted: text.slice(index, close + 1) };
      attributes.push(parsed);
      index = close + 1;
      continue;
    }
    return { attributes, unaccounted: text.slice(index) };
  }
  return { attributes, unaccounted: null };
}

/**
 * Replaces every `cfg_attr` with the attributes it applies, recursively.
 *
 * **The predicate is not evaluated, and that is the safe direction.** A
 * `cfg_attr` whose predicate is false emits nothing, so reading its contents
 * anyway can only make this parser refuse an item it could have compared —
 * never let one through. Reading the predicate instead would mean implementing
 * `all` / `any` / `not` / feature resolution, and the probe that motivated this
 * used `all()`, the empty conjunction, precisely because it is always true and
 * looks like a no-op.
 */
function withoutCfgAttr(attributes: readonly RustAttribute[]): AttributeRead {
  const expanded: RustAttribute[] = [];
  let unaccounted: string | null = null;
  for (const attribute of attributes) {
    if (attribute.path !== 'cfg_attr') {
      expanded.push(attribute);
      continue;
    }
    if (attribute.body === null) {
      unaccounted ??= '#[cfg_attr]';
      continue;
    }
    // The first argument is the predicate; every argument after it is an
    // attribute that is applied when the predicate holds.
    for (const argument of splitArguments(attribute.body).slice(1)) {
      const parsed = parseAttributeSpec(argument);
      if (parsed === null) {
        unaccounted ??= argument;
        continue;
      }
      const inner = withoutCfgAttr([parsed]);
      expanded.push(...inner.attributes);
      unaccounted ??= inner.unaccounted;
    }
  }
  return { attributes: expanded, unaccounted };
}

/**
 * Attributes that put no key on the wire and change nothing this file reads,
 * with the reason each is inert.
 *
 * An allow-list rather than a deny-list, and the direction is the point: a
 * deny-list answers *"is this one of the attributes I know is dangerous"*,
 * which is the question that let a `cfg_attr` wrapper through. This answers
 * *"have I written down what this does"*, and everything else is an error.
 *
 * Two absences are deliberate. `cfg` guards a field or a variant on a
 * compile-time condition, so it decides whether a key is on the wire at all —
 * this file has no way to evaluate that and refuses. `rustfmt::skip` unmakes
 * the one-member-per-line layout that {@link parseRustItem}'s body reader
 * depends on, so an item carrying it must not be read line by line.
 *
 * Why each is inert, so a later reader can check the claim rather than take it:
 * `derive` names traits and emits no key itself; `doc` is documentation, which
 * is also how `///` arrives; `allow`, `deny`, `warn` and `expect` are lint
 * levels; `must_use` and `deprecated` are call-site lints; `inline` is codegen;
 * `repr` is in-memory layout, which serde does not read; `non_exhaustive` is a
 * rule for downstream matching; `error` is thiserror's `Display` string and not
 * a serde attribute at all; `default` is std's Default-variant marker, which
 * emits no key of its own.
 *
 * A set rather than a map from name to reason: nothing would read the reasons,
 * and a column nothing reads is a column that can go wrong without failing.
 */
const INERT_ATTRIBUTES: ReadonlySet<string> = new Set([
  'derive',
  'doc',
  'allow',
  'deny',
  'warn',
  'expect',
  'must_use',
  'deprecated',
  'inline',
  'repr',
  'non_exhaustive',
  'error',
  'default',
]);

/**
 * Serde container keys this parser has read and can account for, with what
 * each does to the keys that cross the bridge.
 *
 * Anything outside this map makes {@link parseRustItem} throw. That posture —
 * *refuse to compare what I do not model* — is the point of the rewrite. The
 * failure being fixed is not "the parser got an answer wrong", it is "the
 * parser had no opinion and reported agreement anyway".
 */
const CONTAINER_KEYS: ReadonlySet<string> = new Set([
  // Read, and applied by `wireName`.
  'rename_all',
  // Read, and compared against the pairing's own `tag`.
  'tag',
  // Read, and applied by `payloadWireNames`. It used to be listed here as
  // tolerated — "no effect on the member names this parser reads", which was
  // true and was not the question. A probe flipped one of them and every
  // assertion stayed green.
  'rename_all_fields',
  // Deserialisation strictness only; emits no key.
  'deny_unknown_fields',
  // Deserialisation only; emits no key.
  'default',
]);

/**
 * Field keys this parser can account for, and what each does to the key.
 *
 * `skip` removes the member. `default`, `alias` and `borrow` are all
 * deserialisation-side and leave the key crossing under its own name.
 * `skip_serializing_if` does neither, and **saying that it did was a wrong
 * entry inside the allow-list rather than a gap in it** — which is the one
 * failure the *"have I written down what this does"* posture cannot detect by
 * itself, because it only ever asks whether the key is written down.
 *
 * What it actually does: the key crosses when the predicate is false and is
 * absent when it is true, so the field is *optional* on the wire and the
 * TypeScript side has to spell it with a `?` or dereference `undefined`. This
 * is live in the tree these guards read — `diagnostic.rs`'s `Diagnosis` carries
 * three of them — and the shape of the bug it hides is
 * `src/features/skills/SkillsPanel.tsx`'s
 * `RESOURCE_GROUPS.filter(([key]) => resources[key].length > 0)`, which throws
 * on `undefined.length` the moment a key it reads stops being unconditional.
 *
 * So it is its own outcome, {@link RustItem.conditionalFields} carries the
 * answer, and each guard compares that list against the keys its own contract
 * interface declares optional. A classification with no reader is a
 * classification that can be wrong without anything failing, which is how this
 * one stayed wrong.
 */
type FieldKeyEffect = 'drops-the-key' | 'keeps-the-key' | 'makes-the-key-conditional';

const FIELD_KEYS: ReadonlyMap<string, FieldKeyEffect> = new Map([
  ['skip', 'drops-the-key'],
  ['skip_serializing_if', 'makes-the-key-conditional'],
  ['default', 'keeps-the-key'],
  ['alias', 'keeps-the-key'],
  ['borrow', 'keeps-the-key'],
]);

/** The first line of a stretch of unaccounted text, for an error message. */
function firstLine(text: string): string {
  const line = (text.split(/\r?\n/)[0] ?? '').trim();
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

/**
 * Every `#[serde(…)]` argument in a block of attribute text, as `key` to
 * `value` (`null` for a bare word such as `skip` or `transparent`) — **or a
 * throw, if any byte of that block was something this file has not written
 * down**.
 *
 * Reads by balanced brackets rather than by line, because rustfmt breaks a long
 * attribute across lines — `ContentPart`'s is five — and a line-oriented reader
 * sees the first line only.
 */
function accountedSerdeArguments(
  text: string,
  refuse: (problem: string) => Error,
): ReadonlyMap<string, string | null> {
  const read = readAttributeText(text);
  if (read.unaccounted !== null) {
    throw refuse(
      `text this parser cannot account for as an attribute: \`${firstLine(read.unaccounted)}\``,
    );
  }
  const expanded = withoutCfgAttr(read.attributes);
  if (expanded.unaccounted !== null) {
    throw refuse(`a \`cfg_attr\` argument it cannot read: \`${firstLine(expanded.unaccounted)}\``);
  }
  const found = new Map<string, string | null>();
  for (const attribute of expanded.attributes) {
    if (attribute.path !== 'serde') {
      if (!INERT_ATTRIBUTES.has(attribute.path)) {
        throw refuse(`\`#[${attribute.path}]\`, which this parser does not model`);
      }
      continue;
    }
    if (attribute.body === null) throw refuse('a bare `#[serde]`, which this parser does not model');
    for (const argument of splitArguments(attribute.body)) {
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(argument);
      if (assignment) {
        const key = assignment[1] as string;
        const value = (assignment[2] as string).trim();
        found.set(key, value.startsWith('"') ? value.slice(1, -1) : value);
      } else {
        found.set(argument, null);
      }
    }
  }
  return found;
}

/* -------------------------------------------------------------------------- */
/* finding the item                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Source with comments and string literals blanked, byte-for-byte the same
 * length, so an index into the blanked text is an index into the source.
 *
 * Every structural read in this file — where an item's body opens, where the
 * previous item ended, how deep a line sits — runs on the output rather than on
 * the source, so that a brace inside a doc comment or a string literal cannot
 * move it.
 *
 * **This is a lexer, and every token Rust has that can contain a `"` or a
 * `{` has to be one of its cases.** Three rounds of this file have each shipped
 * a version that lexed all but one of them, and each time the missing one was
 * enough to erase a live declaration from the inventory without a single test
 * going red. The cases and what each cost:
 *
 * - **Raw strings.** `src-tauri/crates/vela-projects/src/workdir.rs` spells
 *   `r"\\?\UNC\"`, whose *contents* end in a backslash. A raw string has no
 *   escapes, so that backslash is content — but read with escape rules the
 *   `\"` is an escaped quote, the literal never closes, and the blanking runs
 *   on past it. Measured on the committed tree: `workdir.rs` holds 4 raw string
 *   literals and `link.rs` 2, and those two files hold every raw string literal
 *   in `vela-projects` and `vela-skills` — the two crates whose whole `src` a
 *   guard scans. (`vela-providers` holds 38, spread over six other files; the
 *   chat guard reads five named files of it and none of those five holds one.)
 *   The first of
 *   `workdir.rs`'s is inside `without_verbatim_prefix`. Running an escape-only
 *   blanking over `workdir.rs` leaves 25 of the file's 84 `{` standing where
 *   the raw-aware blanking leaves 79; the first of the 58 braces the
 *   escape-only version *loses* is the one opening that function's
 *   `if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {`.
 * - **Char literals.** A `'"'` is a two-token-long way to hand a bare `"` to a
 *   string scanner, and everything up to the next `"` in the file is then
 *   blanked as if it were string contents. This is not a construct that had to
 *   be invented for a probe: `src-tauri/crates/vela-skills/src/document.rs`
 *   spells one in `is_single_path_segment`'s `matches!` over the characters a
 *   filename may not hold, and its byte form twice in `unquote` — a file the
 *   skills guard scans, where the escape-only blanking already erased the two
 *   lines of live code closing `is_single_path_segment`. Weaponised, two ordinary `const` lines bracketing a
 *   `#[derive(…, Serialize)] pub struct` blanked the whole declaration and took
 *   the type out of the inventory with the entire suite green. A `'` that does
 *   *not* open a literal is a lifetime (`&'a str`, `Line<'_>`) and is left
 *   alone, which is decided by looking for the closing quote rather than by
 *   guessing from context.
 * - **Nested block comments.** Rust's block comments nest; a `/*` inside one
 *   opens a second, and the first `*\/` closes only the inner. Closing on the
 *   first `*\/` leaves the outer comment's tail as live text.
 * - **C string literals.** `c"…"` and `cr#"…"#` are string literals, stable
 *   since Rust 1.77, and the raw prefix test used to read `b?r` only. The
 *   plain `c"…"` form was already handled, because its `c` is an ordinary
 *   identifier byte and the `"` case takes it from there; `cr"…"` was not, and
 *   fell through to escape rules. Adding `c` to the prefixes is a one-character
 *   fix and it is made here rather than argued about, because the alternative
 *   is a token this file cannot read. Naming it also retires the closed-world
 *   sentence that used to end this doc: a case list is not provably the whole
 *   of Rust's token set, which is why the throw below matters.
 *
 * **Throws** if the text ends inside an unterminated literal or block comment.
 * A previous version of this sentence called that "the one outcome in which
 * every index this returns is wrong", which was false in exactly the way the
 * char-literal case shows: a missing token type produces a *terminated*
 * phantom literal whose indices are wrong and which nothing downstream can
 * tell. So the throw is not a decoration on a complete case list — it is what
 * an incomplete one lands on when the language gains a token this file has
 * never heard of, and the direction it lands in is *loud*: `cr"\\?\UNC\"` read
 * under escape rules runs off the end of the file and throws
 * `unterminated string literal`, rather than blanking a declaration away.
 * A case list is a claim about a language that keeps changing, and this file
 * makes it a refusable one rather than a true one.
 */
/**
 * A Rust char literal, anchored at its opening quote: one escape sequence or
 * one non-quote character, then the closing quote.
 *
 * The alternative spelling of this test — *"a `'` starts a literal unless it
 * looks like a lifetime"* — is a recogniser standing in for a question again,
 * and the question here has an exact answer: a char literal is the only thing
 * that puts a closing `'` two-to-ten bytes along. `b'x'`'s `b` is an ordinary
 * identifier byte to the scanner and needs no case of its own.
 */
const CHAR_LITERAL = /^'(?:\\u\{[0-9a-fA-F]{1,6}\}|\\x[0-9a-fA-F]{2}|\\.|[^\\'\r\n])'/u;

/**
 * The longest char literal Rust can spell, and the only reason this file
 * writes it out: {@link CHAR_LITERAL_WINDOW} is its length.
 *
 * The window used to be the number 12 with a comment saying where 12 came
 * from, which is an invariant stated in a comment rather than held by
 * anything. Narrowing it to 11 — one byte short of the literal the comment
 * names — moved no assertion in the repository, and neither did 4, and neither
 * did 3, at which point every escaped form (`'\\'`, `'\t'`, `'\u{feff}'`,
 * all of them live in `document.rs`) stops being lexed as a char literal and
 * starts being lexed as a lifetime. Deriving the bound from the literal makes
 * the comment's claim the code's claim, and
 * `blanks the longest char literal Rust can spell` in
 * `chat-contract-parity.test.ts` is the assertion that fails if either moves.
 */
const LONGEST_CHAR_LITERAL = "'\\u{10FFFF}'";

const CHAR_LITERAL_WINDOW = LONGEST_CHAR_LITERAL.length;

/**
 * Rust source with every comment and string literal replaced by spaces of the
 * same length, so that every structural read in this file runs on code.
 *
 * Exported for one reason, said plainly because the alternative is a bound
 * with a comment instead of a test: {@link CHAR_LITERAL_WINDOW}'s exact value
 * is **not observable through the rest of this module's API**. The only
 * twelve-byte char literal is `'\u{HHHHHH}'`, whose bytes are brace-balanced
 * and quote-free, so leaving it unblanked shifts no index any caller reads —
 * which is exactly why setting the window to 11 moved nothing. A caller that
 * can see the blanking itself can pin the bound, and
 * `blanks the longest char literal Rust can spell` does.
 */
export function withoutCommentsOrStrings(text: string): string {
  const blank = (from: number, to: number): string =>
    text.slice(from, to).replace(/[^\r\n]/g, ' ');
  let out = '';
  let index = 0;
  while (index < text.length) {
    const character = text[index] as string;
    if (text.startsWith('//', index)) {
      const end = text.indexOf('\n', index);
      const stop = end < 0 ? text.length : end;
      out += blank(index, stop);
      index = stop;
      continue;
    }
    if (text.startsWith('/*', index)) {
      const stop = blockCommentEnd(text, index);
      if (stop < 0) {
        throw new Error('serde-wire: unterminated block comment in a Rust source');
      }
      out += blank(index, stop);
      index = stop;
      continue;
    }
    if (character === "'") {
      // A char literal, or a lifetime. Told apart by whether the closing quote
      // is where a char literal's would be — `'a'` is a literal, `'a` in
      // `&'a str` is not, and `'_` in `Formatter<'_>` is not.
      const charLiteral = CHAR_LITERAL.exec(text.slice(index, index + CHAR_LITERAL_WINDOW));
      if (charLiteral === null) {
        out += character;
        index += 1;
        continue;
      }
      const stop = index + (charLiteral[0] as string).length;
      out += blank(index, stop);
      index = stop;
      continue;
    }
    const couldOpenRaw =
      (character === 'r' || character === 'b' || character === 'c') &&
      !/[A-Za-z0-9_]/.test(text[index - 1] ?? ' ');
    const raw = couldOpenRaw ? /^[bc]?r(#*)"/.exec(text.slice(index, index + 16)) : null;
    if (raw !== null) {
      const fence = `"${raw[1] as string}`;
      const opened = index + (raw[0] as string).length;
      const end = text.indexOf(fence, opened);
      if (end < 0) {
        throw new Error('serde-wire: unterminated raw string literal in a Rust source');
      }
      const stop = end + fence.length;
      out += blank(index, stop);
      index = stop;
      continue;
    }
    if (character === '"') {
      let cursor = index + 1;
      while (cursor < text.length) {
        const inner = text[cursor] as string;
        if (inner === '\\') {
          cursor += 2;
          continue;
        }
        if (inner === '"') break;
        cursor += 1;
      }
      if (cursor >= text.length) {
        throw new Error('serde-wire: unterminated string literal in a Rust source');
      }
      // The opening quote is blanked too. Leaving it in place would hand a
      // lone `"` to every reader of this text, and the first of them to be
      // string-aware would swallow the rest of the file.
      out += blank(index, cursor + 1);
      index = cursor + 1;
      continue;
    }
    out += character;
    index += 1;
  }
  return out;
}

/** Index of the bracket opening the one at `at`, in blanked text, or `-1`. */
function openingBracket(text: string, at: number): number {
  const openers: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };
  const stack: string[] = [];
  for (let index = at; index >= 0; index -= 1) {
    const character = text[index] as string;
    const opener = openers[character];
    if (opener !== undefined) {
      stack.push(opener);
      continue;
    }
    if (character === '(' || character === '[' || character === '{') {
      if (stack.pop() !== character) return -1;
      if (stack.length === 0) return index;
    }
  }
  return -1;
}

/**
 * The whole attribute region attached to the item declared at `at` — **bounded
 * by what precedes the item, not by what this function recognises**.
 *
 * Two earlier versions of this got the boundary from the text it was reading.
 * The first sliced from the last `#[derive` before the declaration, so an
 * attribute written *above* the derive was outside the slice and outside the
 * refusal with it. The second walked backwards by line and kept the longest run
 * that read as attributes, comments and blank lines — and a probe put a
 * two-line `/* … *\/` block comment between `#[serde(rename_all =
 * "PascalCase")]` and `#[derive(…, Serialize)]`. The walk broke at the
 * comment's closing line (`*\/` on its own is neither attribute text nor a
 * bracket-closer), the serde attribute fell outside the block the refusal
 * inspects, `renameAll` read as `none`, and the guard compared raw identifiers
 * and reported agreement serde never produced.
 *
 * Both are the same mistake: a *recogniser* deciding where the region ends. An
 * item's attributes begin where the previous item ended, and Rust says where
 * that is — the nearest `;`, `{` or `}` outside any bracket group. That is a
 * position, not a shape, so no comment, attribute or byte sequence written
 * inside the region can move it. Everything between that position and the
 * declaration is the region, and {@link accountedSerdeArguments} must account
 * for all of it or refuse.
 */
function attributeRegionBefore(source: string, at: number): string {
  const blanked = withoutCommentsOrStrings(source.slice(0, at));
  let index = blanked.length - 1;
  while (index >= 0) {
    const character = blanked[index] as string;
    if (character === ']' || character === ')') {
      // An attribute's own brackets, or a tuple item's. Step over the whole
      // group: a `;` or `{` inside one does not end the previous item.
      const open = openingBracket(blanked, index);
      if (open < 0) break;
      index = open - 1;
      continue;
    }
    if (character === '{' || character === '}' || character === ';') break;
    index -= 1;
  }
  return source.slice(index + 1, at);
}

/**
 * What follows the name in a `pub enum` / `pub struct` declaration.
 *
 * `undecided` is a fourth answer and it is not a form. It says the scan below
 * ran off the end of the file without meeting a `{`, `(` or `;` it could
 * believe, and every caller **throws** on it. The previous version had no such
 * answer: it returned `unit` when it fell off the end and when it could not
 * decide, and those are the same two answers this whole file exists to keep
 * apart.
 */
type ItemForm = 'braced' | 'tuple' | 'unit' | 'undecided';

/**
 * Reads forward from just after an item's name to decide its form, and where
 * its body opens.
 *
 * A regex anchored on `…{$` was the first answer and is the same class of
 * mistake as slicing from `#[derive`: it recognises one spelling of a braced
 * item rather than deciding the question. `pub struct X\nwhere\n    T: Copy,\n{`
 * is a braced item whose declaration line does not end in a brace, and a scan
 * that misses it drops the item from the inventory **silently** — which is the
 * one failure an inventory exists to prevent.
 *
 * The second answer — walk forward tracking only `<` and `>` — repeated that
 * failure on the very construct the sentence above names. A probe wrote the
 * idiomatic const-generic bound `pub struct FixedPage<T, const N: usize>\nwhere
 * [T; N]: Serialize,\n{ … }`: `[` and `]` were untracked, so the `;` inside
 * `[T; N]` was read at angle depth zero, the item came back `unit`, and
 * {@link scanSerialisable}'s `continue` dropped a live serialisable type. A
 * `where F: Fn(&str) -> bool` clause reached the same result through the
 * untracked `(`.
 *
 * So the `where` clause is now a case rather than a hazard. Up to it, the only
 * thing between the name and the body is a generic parameter list, and the only
 * word that can appear at angle depth zero is `where` itself. Inside it,
 * everything nests — `(`, `[`, `{` and `<` alike — and the clause ends at the
 * first `{` or `;` outside all of them.
 */
function itemForm(source: string, after: number): { form: ItemForm; openBrace: number } {
  const text = withoutCommentsOrStrings(source);
  let angle = 0;
  for (let index = after; index < text.length; index += 1) {
    const character = text[index] as string;
    if (character === '<') {
      angle += 1;
      continue;
    }
    if (character === '>') {
      if (text[index - 1] === '-' || text[index - 1] === '=') continue;
      if (angle > 0) angle -= 1;
      continue;
    }
    if (angle > 0) continue;
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(index, index + 8));
    if (word !== null) {
      if ((word[0] as string) === 'where') return whereClauseForm(text, index + 5);
      index += (word[0] as string).length - 1;
      continue;
    }
    if (character === '{') return { form: 'braced', openBrace: index };
    if (character === '(') return { form: 'tuple', openBrace: -1 };
    if (character === ';') return { form: 'unit', openBrace: -1 };
  }
  return { form: 'undecided', openBrace: -1 };
}

/**
 * The rest of {@link itemForm}, from just past the `where` keyword.
 *
 * Every bracket kind nests here, because a `where` clause is arbitrary type
 * syntax: `[T; N]: Serialize` puts a `;` inside square brackets and
 * `F: Fn(&str) -> bool` puts a parameter list inside round ones, and neither
 * ends the clause. `->` and `=>` are stepped over so their `>` does not close a
 * generic list that was never opened.
 */
function whereClauseForm(text: string, from: number): { form: ItemForm; openBrace: number } {
  let depth = 0;
  for (let index = from; index < text.length; index += 1) {
    const character = text[index] as string;
    if (character === '<' || character === '(' || character === '[') {
      depth += 1;
      continue;
    }
    if (character === '>') {
      if (text[index - 1] === '-' || text[index - 1] === '=') continue;
      if (depth > 0) depth -= 1;
      continue;
    }
    if (character === ')' || character === ']') {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth > 0) continue;
    if (character === '{') return { form: 'braced', openBrace: index };
    if (character === ';') return { form: 'unit', openBrace: -1 };
  }
  return { form: 'undecided', openBrace: -1 };
}

/**
 * **The one alphabet three readers used to spell three different ways.**
 *
 * Every round of this file has fixed how a construct is *spelled* and left
 * alone the question one level under it: which sequences of characters this
 * reader agrees to call a name. Three refusals were written across three
 * rounds and each brought its own character class, each narrower than Rust's,
 * and each narrower in a different place:
 *
 * - {@link declarationsIn}'s name class was `[A-Za-z][A-Za-z0-9_]*`, which
 *   cannot spell a leading underscore. `#[derive(Serialize)] pub struct
 *   _StoreAuditRow { … }` produced no {@link Declaration} at all, so nothing
 *   asked whether it derived `Serialize` and it was on no inventory in the
 *   repository. One character was the whole difference between caught and
 *   blind, and a leading `_` is not exotic: it is how Rust silences the
 *   dead-code lint for an item that exists to be constructed elsewhere, and this
 *   repository already reaches for the convention on the TypeScript side of
 *   the same bridge (`_allowlistIsWellTyped` in `contract.ts`).
 * - The old `IMPL_SERIALIZE` regex's *target* class was
 *   `[A-Za-z_][A-Za-z0-9_]*`, which **does** admit the underscore. So
 *   `impl Serialize for _StoreAuditRow` was a loud refusal while
 *   `#[derive(Serialize)] pub struct _StoreAuditRow` was silence — one name,
 *   two doors, two answers, and no sentence anywhere reconciling them. That
 *   disagreement is the evidence that the narrowness was an oversight rather
 *   than a decision.
 * - {@link itemPositionMacroIn} tested item position from the start of the
 *   macro's *last* path segment, so every qualified invocation was measured
 *   from the `:` before it.
 *
 * So there is one alphabet and the three readers share it, the same way they
 * share the parse. `r#` is part of it because a raw identifier is the only
 * legal spelling of a name that collides with a keyword — the same reason
 * {@link FIELD_DECLARATION} spells it — and the prefix is not part of the
 * name, so it is outside the capture. Non-ASCII is part of it because Rust
 * 2021 identifiers are XID, not ASCII; the range here is every non-ASCII
 * scalar rather than the XID tables, which over-includes and cannot miss.
 *
 * Group 1 of a match is the name with any `r#` removed.
 */
const IDENTIFIER_CONTINUE = 'A-Za-z0-9_\\u{80}-\\u{10FFFF}';

const RUST_IDENTIFIER = `(?:r#)?([A-Za-z_\\u{80}-\\u{10FFFF}][${IDENTIFIER_CONTINUE}]*)`;

/** One character that can appear inside a name — the runtime half of the above. */
const IDENTIFIER_CHARACTER = new RegExp(`[${IDENTIFIER_CONTINUE}]`, 'u');

/**
 * How an item declaration is spelled — **every way Rust lets it be spelled**,
 * not the one way the crates happen to spell it today.
 *
 * The visibility is optional and may be qualified (`pub(crate)`,
 * `pub(in crate::ipc)`), and the line may be indented, because an item declared
 * inside a `mod` is indented by rustfmt. A probe used exactly that: a
 * `pub(crate) struct` deriving `Serialize` was invisible to a scan anchored on
 * `^pub `, which is a spelling standing in for the question *"is this a
 * declaration?"*. A private item is included too — privacy is a Rust rule about
 * paths, not a statement about the wire, and a private struct is serialised
 * whenever a public type holds one.
 *
 * **It is no longer anchored to the start of a line, and that was the last
 * spelling standing in for this question.** `^[ \t]*` said *"a declaration
 * begins its own line"*, which is rustfmt's habit and not Rust's rule:
 * `#[derive(Debug, Clone, Serialize)] pub struct StoreAuditRow { pub taken_at:
 * String }` is one legal line, and under the anchor it was invisible to
 * {@link declarationsIn}, therefore to {@link scanSerialisable}, therefore to
 * every inventory equality and every register — with the whole suite green.
 * Two newlines were the whole difference between caught and blind. The anchor
 * is replaced by a boundary that is about identifiers rather than about
 * layout, so an identifier ending in the keyword, or one continuing past it,
 * is still not the keyword; and the separators are `\s+` so that a declaration
 * broken across lines between its keyword and its name — legal, and what a
 * `#[rustfmt::skip]` item may be spelled as — is read too.
 *
 * Dropping the anchor costs nothing in reach: measured over the fifteen `.rs`
 * files the three guards scan, the anchored and unanchored patterns select the
 * identical set of declarations, name for name, in every one of them. What it
 * buys is that {@link attributeRegionBefore} now runs from the declaration's
 * own position instead of from the start of its line, so an attribute sharing
 * that line is inside the region rather than outside it — which is what makes
 * the deliberate omission of `rustfmt::skip` from {@link INERT_ATTRIBUTES}
 * reachable in the one case it was written for.
 */
const DECLARATION = `(?<![${IDENTIFIER_CONTINUE}])(?:pub(?:\\s*\\([^)]*\\))?\\s+)?`;

/**
 * The end of the `impl … for …` header beginning at `from`, in blanked text.
 *
 * The header runs to the `{` that opens the impl body, or to the `;` that ends
 * a declaration that has no body, **at bracket depth zero**. Reading to the
 * first `{` in the text would stop inside a const-generic argument
 * (`impl Foo<{ N + 1 }> for X`), and reading to the end of the line would stop
 * in the middle of a header rustfmt broke over three of them.
 */
function implHeaderEnd(text: string, from: number): number {
  let depth = 0;
  for (let index = from; index < text.length; index += 1) {
    const character = text[index] as string;
    if (character === '(' || character === '[' || character === '<') {
      depth += 1;
    } else if (character === ')' || character === ']') {
      depth = Math.max(0, depth - 1);
    } else if (character === '>') {
      if (text[index - 1] !== '-' && text[index - 1] !== '=') depth = Math.max(0, depth - 1);
    } else if (character === '{') {
      if (depth === 0) return index;
      depth += 1;
    } else if (character === '}') {
      depth = Math.max(0, depth - 1);
    } else if (character === ';' && depth === 0) {
      return index;
    }
  }
  return text.length;
}

/**
 * Index of the `>` closing the `<` at `at`, or `-1`.
 *
 * Separate from {@link matchingBracket}, which is deliberately blind to angle
 * brackets: `<` is a bracket only where a type is expected, and everywhere
 * else in this file the reader's answer to a `<` it cannot place is a refusal
 * rather than a guess. Here the position *is* known to be a generic parameter
 * list, because it opens the header of an `impl`, so the nesting can be
 * matched. `->` and `=>` are stepped over so a function-pointer bound does not
 * close a list it never opened.
 */
function matchingAngle(text: string, at: number): number {
  let depth = 0;
  for (let index = at; index < text.length; index += 1) {
    const character = text[index] as string;
    if (character === '<') {
      depth += 1;
      continue;
    }
    if (character !== '>') continue;
    if (text[index - 1] === '-' || text[index - 1] === '=') continue;
    depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

/** Skips whitespace forward from `from`. */
function afterSpace(text: string, from: number): number {
  let index = from;
  while (index < text.length && /\s/u.test(text[index] as string)) index += 1;
  return index;
}

/**
 * The type an `impl … for …` header implements `Serialize` for, or `null`.
 *
 * `Serialize` is a **trait**, and `#[derive(Serialize)]` is one way to satisfy
 * it, not the definition of satisfying it. A scan that looks only for the
 * derive answers *"did someone write the word `derive` here?"* when the
 * question is *"can this type put keys on the wire?"*, and a hand-written
 * `impl serde::Serialize for X` with a `serialize_struct` body answers the
 * second yes and the first no.
 *
 * **This used to be one regular expression, and its generic parameter list was
 * `<[^>]*>`.** A character class cannot cross a nested `>`, so
 * `impl<T: AsRef<[u8]>> serde::Serialize for Row<T>` stopped at the `>` closing
 * `AsRef<[u8]`, left ` > serde::Serialize` where `Serialize` was required, and
 * did not match at all — the type was neither derived nor manual, and
 * {@link scanSerialisable}'s `continue` dropped it off every inventory in the
 * repository in silence. Six characters were the whole difference between
 * caught and blind, on the one function written because a hand-written impl
 * "puts whatever keys its body writes on the wire". The same regex needed an
 * identifier before every `::`, so a leading `::serde::Serialize` was a second
 * door through it.
 *
 * Both are the same mistake and it is the mistake this file keeps making: a
 * *spelling* deciding a structural question. The header is read structurally
 * instead — the generic parameter list is skipped by matching its brackets,
 * the trait path is split on `::` and its last segment compared, and the target
 * is the first identifier after `for`. `impl Serializer`, `impl Deserialize`
 * and a `Serialize` bound inside the parameter list are still not it, because
 * the segment compared is the one immediately before `for`.
 */
function serializeImplTarget(header: string): string | null {
  let index = afterSpace(header, 0);
  if (header[index] === '<') {
    const close = matchingAngle(header, index);
    if (close < 0) return null;
    index = close + 1;
  }
  let depth = 0;
  let forAt = -1;
  for (let cursor = index; cursor < header.length; cursor += 1) {
    const character = header[cursor] as string;
    if (character === '(' || character === '[' || character === '<' || character === '{') {
      depth += 1;
      continue;
    }
    if (character === ')' || character === ']' || character === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (character === '>') {
      if (header[cursor - 1] !== '-' && header[cursor - 1] !== '=') depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0 || !header.startsWith('for', cursor)) continue;
    if (IDENTIFIER_CHARACTER.test(header[cursor - 1] ?? ' ')) continue;
    if (IDENTIFIER_CHARACTER.test(header[cursor + 3] ?? ' ')) continue;
    // `for<'a> …` is a higher-ranked bound, not the `for` of the impl header.
    const next = afterSpace(header, cursor + 3);
    if (header[next] === '<') {
      cursor = next - 1;
      continue;
    }
    forAt = cursor;
    break;
  }
  if (forAt < 0) return null;
  const trait = header.slice(index, forAt);
  const generic = trait.indexOf('<');
  const path = (generic < 0 ? trait : trait.slice(0, generic)).trim();
  const segments = path.split('::');
  if ((segments[segments.length - 1] ?? '').trim() !== 'Serialize') return null;
  const target = new RegExp(
    `^(?:\\s|&|'[${IDENTIFIER_CONTINUE}]+)*${RUST_IDENTIFIER}`,
    'u',
  ).exec(header.slice(forAt + 3));
  return target?.[1] ?? null;
}

/** Every type this file hand-writes a `Serialize` impl for, in blanked text. */
function serializeImplTargetsIn(blanked: string): readonly string[] {
  const targets: string[] = [];
  for (const match of blanked.matchAll(/\bimpl\b/gu)) {
    const start = (match.index ?? 0) + 'impl'.length;
    const target = serializeImplTarget(blanked.slice(start, implHeaderEnd(blanked, start)));
    if (target !== null) targets.push(target);
  }
  return targets;
}

interface Declaration {
  readonly name: string;
  readonly keyword: 'enum' | 'struct';
  /**
   * Index of the first byte of the declaration itself — its visibility token
   * when it has one, otherwise its `enum` / `struct` keyword — in the source.
   *
   * Not the start of its line. {@link attributeRegionBefore} walks back from
   * here to the end of the previous item, so anything written between the two
   * is in the region whether or not a newline separates it from the
   * declaration.
   */
  readonly at: number;
  /** Index just past the item's name, where {@link itemForm} reads on from. */
  readonly after: number;
}

/**
 * Every `enum` / `struct` declaration in a file, whatever its visibility.
 *
 * Matched against the source with comments and string literals blanked, and
 * the indices are indices into the source because the blanking is
 * length-preserving. The blanking is what lets the pattern be unanchored at
 * all: `/// pub struct Example {` in a doc comment, or the same text inside a
 * string literal, would otherwise join the inventory as a type that does not
 * exist, and that risk grows — not shrinks — once the pattern stops requiring
 * the declaration to begin its line.
 */
function declarationsIn(source: string): readonly Declaration[] {
  const found: Declaration[] = [];
  const pattern = new RegExp(`${DECLARATION}(enum|struct)\\s+${RUST_IDENTIFIER}`, 'gu');
  for (const match of withoutCommentsOrStrings(source).matchAll(pattern)) {
    if (match.index === undefined) continue;
    found.push({
      name: match[2] as string,
      keyword: match[1] as 'enum' | 'struct',
      at: match.index,
      after: match.index + (match[0] as string).length,
    });
  }
  return found;
}

/* -------------------------------------------------------------------------- */
/* reading the item                                                           */
/* -------------------------------------------------------------------------- */

interface BodyLine {
  readonly text: string;
  /**
   * The same line with comments and string literals blanked. Empty once
   * trimmed exactly when the line carries no code — which is how a line inside
   * a multi-line block comment is told from a line of members, without the
   * reader needing to recognise the comment's shape.
   */
  readonly code: string;
  /** Brace depth at the start of the line, relative to the item's own body. */
  readonly depth: number;
  /**
   * Whether the line starts inside an unclosed `(` or `[` — a tuple variant or
   * an attribute broken across lines. Such a line is a continuation, never a
   * member of its own, and reading it as one invents members: `Foo(\n
   * Bar,\n),` would otherwise contribute `Bar` to an enum that has no such
   * variant. Angle brackets are deliberately *not* tracked here, because `<`
   * and `>` are also comparison operators and a type-position-only reading of
   * them is a second parser. They are still accounted for, one layer in: a
   * generic argument list broken across lines leaves its first line with an
   * unpaired `<`, and {@link topLevelParts} reports that to
   * {@link refuseUnpairedAngle}. So the construct reaches a named refusal
   * rather than being silently skipped, which is the safe direction.
   */
  readonly continuation: boolean;
}

/** The item body split into lines, each tagged with where it sits. */
function bodyLines(body: string): readonly BodyLine[] {
  const blanked = withoutCommentsOrStrings(body);
  const raw = body.split(/\r?\n/);
  const code = blanked.split(/\r?\n/);
  const lines: BodyLine[] = [];
  let depth = 0;
  let group = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const source = code[index] ?? '';
    lines.push({
      text: (raw[index] ?? '').trim(),
      code: source.trim(),
      depth,
      continuation: group > 0,
    });
    for (const character of source) {
      if (character === '{') depth += 1;
      else if (character === '}') depth -= 1;
      else if (character === '(' || character === '[') group += 1;
      else if (character === ')' || character === ']') group = Math.max(0, group - 1);
    }
  }
  return lines;
}

/**
 * A line that carries nothing but the punctuation closing a member — `}`,
 * `},`, `)`, `),`, `};`. Legal at any position a member could be and never a
 * member itself, so the reader must be told about it explicitly rather than
 * silently walking past it with everything else it cannot spell.
 */
const CLOSING_PUNCTUATION = /^[)\]},;]*$/;

/**
 * A field declaration — `pub name: String`, `name: String`, `pub r#type: T`.
 *
 * The `r#` prefix is not an exotic spelling. It is the **only** legal way to
 * name a field whose wire key is `type`, `match`, `move` or any other Rust
 * keyword, which is exactly the situation a serde-facing struct runs into; serde
 * puts `type` on the wire for `r#type`, with no rename attribute in sight. An
 * alphabet of `[a-z_][a-z0-9_]*` captures `r`, then demands a `:` where the `#`
 * stands, and the line falls through — so the field leaves the read with no
 * error and an assertion named *"…, and no other"* passes over a live extra
 * key. The prefix is stripped, because it is not part of the identifier.
 */
const FIELD_DECLARATION = /^(?:pub(?:\s*\([^)]*\))?\s+)?(?:r#)?([a-z_][a-z0-9_]*)\s*:/;

/** A variant declaration — `Named`, `Named {`, `Named(`, `r#Type,`. */
const VARIANT_DECLARATION = /^(?:r#)?([A-Z][A-Za-z0-9]*)\s*(?:[,{(]|$)/;

/** What one body line splits into — see {@link topLevelParts}. */
interface LineParts {
  /** The comma-separated parts at bracket depth zero, trimmed, blanks dropped. */
  readonly parts: readonly string[];
  /**
   * Whether every `<` on the line met a `>` and no `>` arrived without one.
   *
   * False is not "this line has no members". It is *this reader cannot say
   * where this line's members end*, and the caller turns it into a refusal.
   */
  readonly angleBalanced: boolean;
}

/**
 * The comma-separated parts of one body line, at bracket depth zero, **plus
 * whether the line accounted for its own angle brackets**.
 *
 * `(`, `[`, `{` **and** `<` are all tracked, because the commas that are not
 * separators live inside all four: `pub index: HashMap<String, u32>,` is one
 * member and `pub a: u8, pub b: u8,` is two. `->` and `=>` are stepped over so
 * a function-pointer field does not close a generic list that was never
 * opened.
 *
 * **`<` is not always a bracket, and the previous version of this comment said
 * it was.** It claimed that "a struct or enum body holds no expressions — every
 * `<` on one of these lines is type syntax, never a comparison", and a const
 * array length is an expression: `pub flags: [bool; { 1 < 2 } as usize],
 * #[serde(rename = "Sneak")] pub b: String,` left depth at 1 across the
 * separating comma and read as one member, with the second field's rename read
 * by nothing. `Image { mime_type: String, data: [u8; 1 << 5], secret_path:
 * String },` did the same thing to a live paired type, and there the loss was
 * worse than a mis-answer one layer out: the one-line struct-variant reader
 * below iterates these parts with no accounting of its own, so the dropped
 * field was **silent** where the identical under-split on a member line is a
 * named refusal.
 *
 * So the answer is the one this file gives everywhere else: the reader says
 * what it could not account for, and the caller refuses. **Three things have
 * to hold for this reader to claim it can place a line's commas**, and the
 * round that wrote the first one asserted, in a universal, that it was the
 * whole of the question. It was not, and both remaining shapes were landed
 * against it by both adversaries:
 *
 * - the `<` and `>` counts pair up — which catches `[u8; 1 << 5]`;
 * - no angle group **straddles** a bracket group — which is what catches
 *   `[u8; A < B as usize], secret_path: String, [u8; C > D as usize]`, whose
 *   counts cancel because two comparisons cancel, and whose separator commas
 *   therefore sat at a depth that never returned to zero. That was a silent
 *   field drop on the live paired `ContentPart`;
 * - every `<` is written **against** what it qualifies — `Vec<u8>`,
 *   `HashMap<String, u32>`, `Box<dyn Fn() -> T>` — which catches the same
 *   shape with no bracket in it at all (`pub a: A < B, pub secret: String,
 *   pub c: D > E,`), where the first two tests have nothing to look at.
 *
 * What that costs, said rather than implied: `<T as Trait>::Output` is a legal
 * type this reader now refuses, because its `<` opens no argument list. It is
 * in none of the fifteen files these guards scan, and a refusal is the
 * direction that cannot report a key as absent.
 *
 * Measured, on the tree this is committed in rather than remembered from the
 * round before: over the fifteen `.rs` files these guards scan there are
 * seventy-two declarations, and reading every one of them through
 * {@link parseRustItem} gives byte-identical answers before and after all
 * three tests were in place — same members, same tags, same per-variant
 * payloads, same five refusals. So the tests cost nothing on the tree today.
 * That is a statement about this tree and not a universal: what they catch is
 * the three shapes above, and a line whose `<` and `>` pair with each other,
 * stay inside one bracket group, and sit against an identifier is read as a
 * generic argument list whether or not that is what it is.
 *
 * This exists because the member reader was line-oriented and its **refusal was
 * line-oriented with it**. `FIELD_DECLARATION.exec(text)` keeps the first match
 * on the line and says nothing about the rest of it, so
 * `pub assets: Vec<String>, #[serde(rename = "Scripts")] pub extra: Vec<String>,`
 * read as one field: the second never joined `members`, its `rename` never
 * reached the field-attribute branch (the line does not start with `#`), and
 * {@link refuseUnreadable} never fired (the line *was* readable — it was
 * mis-answered). A live key crossed under `Scripts` and the assertion named
 * *"…, and no other"* passed over it. Reflowed onto the three lines rustfmt
 * would produce, the identical bytes are refused. Two newlines were the whole
 * difference between caught and blind, so the reader now has to account for the
 * **whole line**, the way {@link accountedSerdeArguments} accounts for the whole
 * attribute region.
 */
function topLevelParts(code: string): LineParts {
  const parts: string[] = [];
  const opened: number[] = [];
  let current = '';
  let depth = 0;
  let angle = 0;
  let angleBalanced = true;
  for (let index = 0; index < code.length; index += 1) {
    const character = code[index] as string;
    if (character === '<') {
      // A `<` that opens a generic argument list is written **against** what it
      // qualifies — `Vec<u8>`, `HashMap<String, u32>`, `Box<dyn Fn() -> T>`,
      // `PhantomData<*const u8>`. One that is not is either a comparison or a
      // qualified path (`<T as Trait>::Output`), and this reader can place
      // neither. Without this the straddle test below still misses one shape,
      // because it only inspects brackets: `pub a: A < B, pub secret: String,
      // pub c: D > E,` has no bracket at all, its counts cancel, and the two
      // commas between the operators sit at a depth that never returns to
      // zero. The line is not legal Rust — a field type is not a comparison —
      // but this reader does not know that, and it answered `members: ['a']`
      // rather than refusing.
      if (!/[A-Za-z0-9_>)\]]/u.test(code[index - 1] ?? ' ')) angleBalanced = false;
      depth += 1;
      angle += 1;
    } else if (character === '(' || character === '[' || character === '{') {
      opened.push(angle);
      depth += 1;
    } else if (character === '>') {
      if (code[index - 1] !== '-' && code[index - 1] !== '=') {
        if (angle === 0) angleBalanced = false;
        else angle -= 1;
        if (depth > 0) depth -= 1;
      }
    } else if (character === ')' || character === ']' || character === '}') {
      // An angle group may not straddle a bracket group. `Vec<[u8; 4]>` opens
      // its `[` with the angle count already at one and closes it there too;
      // `[u8; A < B as usize]` opens at zero and closes at one, which says the
      // `<` inside it was a comparison rather than the start of a type. This
      // is the half of the pairing test the arithmetic could not see: two
      // comparisons on one line **cancel**, so `data: [u8; A < B as usize],
      // secret_path: String, tail: [u8; C > D as usize]` balanced its counts
      // while its separator commas sat at a depth that was never zero, and the
      // fields between them were dropped without a word.
      const openedAt = opened.pop();
      if (openedAt !== undefined && openedAt !== angle) angleBalanced = false;
      if (depth > 0) depth -= 1;
    } else if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  if (angle !== 0) angleBalanced = false;
  return { parts: parts.map((part) => part.trim()).filter(Boolean), angleBalanced };
}

/** More than one member written on one line — see {@link topLevelParts}. */
function refuseSecondMember(name: string, file: string, line: string, extra: string): Error {
  const shown = line.length > 60 ? `${line.slice(0, 57)}...` : line;
  return new Error(
    `serde-wire: in ${name} in ${file}, \`${shown}\` puts more than one member on one line ` +
      `and this parser reads one. The second (\`${extra.slice(0, 40)}\`) and any serde ` +
      `attribute on it would be read by nothing while its key crossed the bridge.`,
  );
}

/**
 * A line whose `<` and `>` do not pair up — see {@link topLevelParts}.
 *
 * The same posture as {@link refuseSecondMember}, one construct further out.
 * There the reader mis-answered a line it could read; here it cannot tell
 * whether a comma separates two members or sits inside a generic argument
 * list, and answering either way invents or drops a key.
 */
function refuseUnpairedAngle(name: string, file: string, line: string): Error {
  const shown = line.length > 60 ? `${line.slice(0, 57)}...` : line;
  return new Error(
    `serde-wire: in ${name} in ${file}, \`${shown}\` does not pair its \`<\` with a \`>\`. ` +
      `This parser tracks angle brackets to tell a generic argument list's commas from the ` +
      `commas between members, and on this line they are something else — a comparison in a ` +
      `const array length, or a generic list broken across lines. Either way it cannot say ` +
      `where the members on this line end, and guessing drops one.`,
  );
}

/**
 * A line in an item body that is none of the shapes above — **an error, not a
 * skip**.
 *
 * This is the same posture {@link accountedSerdeArguments} takes over attribute
 * text, moved one layer in, and for the same reason. A `continue` here answers
 * *"I did not recognise that, so there was nothing there"*, and those are two
 * different answers: `pub r#type: String,` is a live field whose wire key is
 * `type`, and under a silent `continue` it left the read with no error while
 * the assertion named *"…, and no other"* went on passing. The member reader's
 * alphabet is now written down in one place and everything outside it is
 * named out loud.
 */
function refuseUnreadable(name: string, file: string, line: string, expected: string): Error {
  const shown = line.length > 60 ? `${line.slice(0, 57)}...` : line;
  return new Error(
    `serde-wire: in ${name} in ${file}, \`${shown}\` is where ${expected} should be and this ` +
      `parser cannot read it as one. Skipping it would drop a key that is on the wire and ` +
      `report the remaining ones as the whole set.`,
  );
}

/**
 * Reads one `pub enum` / `pub struct` out of source text.
 *
 * Against source text rather than a filename so the line-ending and attribute
 * cases can be exercised on a fixture instead of on whatever `git` happens to
 * have checked out.
 *
 * **The declaration is resolved through {@link declarationsIn}, and an
 * ambiguous name is refused.** The previous version ran its own
 * `^…struct <Name>\b` over the file and took the *first* textual match, with no
 * notion of a module path and no requirement that the thing it read be the
 * thing {@link scanSerialisable} had counted. A probe used exactly that gap: it
 * broke the live `SkillResources` by flipping its `rename_all` to
 * `"PascalCase"`, then wrote an ordinary migration module *above* it —
 * `pub mod legacy { #[derive(Debug, Clone, Default)] pub struct SkillResources
 * { … } }` — deriving nothing. The pairing labelled `store.rs::SkillResources`
 * read the decoy, reported agreement, and the inventory equality never moved
 * because the decoy is not serialisable and the live type was still counted
 * once. Every other assertion about that type is downstream of this
 * resolution, so all of them inherited it.
 *
 * Resolving a Rust *path* is not something this file can do without becoming a
 * name resolver, so it does the thing a guard is allowed to do instead: it
 * refuses. Two declarations of one name in one file is the case where a
 * textual reader and the compiler can disagree, and disagreeing quietly is the
 * failure. Splitting the module into its own file, or giving the two types
 * different names, is what makes the guard readable again.
 */
export function parseRustItem(
  source: string,
  keyword: 'enum' | 'struct',
  name: string,
  file = '<fixture>',
): RustItem {
  const spelled = declarationsIn(source).filter((candidate) => candidate.name === name);
  if (spelled.length === 0) {
    throw new Error(`serde-wire: no \`pub ${keyword} ${name}\` in ${file}`);
  }
  if (spelled.length > 1) {
    throw new Error(
      `serde-wire: ${file} declares \`${name}\` ${spelled.length} times, and this parser ` +
        `resolves a name rather than a path. It cannot tell which one is the type on the ` +
        `wire, and reading the wrong one reports agreement about a type nobody serialises.`,
    );
  }
  const declaration = spelled[0] as Declaration;
  if (declaration.keyword !== keyword) {
    throw new Error(
      `serde-wire: \`${name}\` in ${file} is a ${declaration.keyword}, not a ${keyword}.`,
    );
  }
  const at = declaration.at;
  const { form, openBrace } = itemForm(source, declaration.after);
  if (form === 'undecided') {
    throw new Error(
      `serde-wire: this parser could not decide whether \`${keyword} ${name}\` in ${file} is ` +
        `braced, a tuple or a unit item — it ran off the end of the file looking for the ` +
        `token that says so.`,
    );
  }
  if (form !== 'braced') {
    throw new Error(
      `serde-wire: \`pub ${keyword} ${name}\` in ${file} is a ${form} item, which has no ` +
        `member names to compare against a wire key.`,
    );
  }
  const close = matchingBracket(withoutCommentsOrStrings(source), openBrace);
  if (close < 0) throw new Error(`serde-wire: unterminated ${name} in ${file}`);

  const refuseContainer = (problem: string): Error =>
    new Error(
      `serde-wire: ${name} in ${file} carries ${problem}. Refusing to compare identifiers ` +
        `against wire keys it cannot predict — teach this parser what that does to the wire, ` +
        `or exclude the type.`,
    );
  const container = accountedSerdeArguments(attributeRegionBefore(source, at), refuseContainer);
  for (const [key] of container) {
    if (!CONTAINER_KEYS.has(key)) {
      throw refuseContainer(`\`#[serde(${key})]\`, which this parser does not model`);
    }
  }

  const rule = (key: string): RenameRule => {
    const spelled = container.get(key) ?? null;
    if (spelled !== null && !(RENAME_RULES as readonly string[]).includes(spelled)) {
      throw new Error(
        `serde-wire: ${name} in ${file} carries \`${key} = "${spelled}"\`, a rule ` +
          `this parser does not implement. Reading it as "no rename" would compare the Rust ` +
          `identifiers against the TypeScript list and report agreement serde never produced.`,
      );
    }
    return (spelled ?? 'none') as RenameRule;
  };
  const renameAll = rule('rename_all');
  const renameAllFields = rule('rename_all_fields');
  const kind: 'variant' | 'field' = keyword === 'enum' ? 'variant' : 'field';
  const tag = container.get('tag') ?? null;

  // Line endings are pinned in both directions rather than assumed. `git
  // config core.autocrlf` is `true` on Windows and `.gitattributes` carries no
  // `* text=auto`, so a Windows checkout of these sources ends every line
  // `\r\n`: measured on the checkout this was written in,
  // `vela-providers/src/model.rs` holds 931 lines, all 931 ending CRLF and none
  // ending a bare LF. The ratio is the durable part, not the count. Splitting
  // on `'\n'` alone used to leave a `'\r'` on the end of every line, so the
  // column-0 `}` the reader then looked for was never found, and the guarantee
  // `contract.ts` advertises did not execute on the only machine that builds
  // the product. (The body is now delimited by matching the item's own braces,
  // so column 0 is no longer part of the question.) The symptom pointed at the
  // wrong place because JavaScript counts `\r` as a line terminator for `$`
  // under `m`, so the old `\{$` declaration regex was satisfied by `{\r`. The
  // control that keeps this honest is `reads the same members from a source and
  // its opposite-ending twin`, which converts a real source both ways and
  // compares the reads — a count in a comment could go stale, and that
  // assertion cannot.
  const lines = bodyLines(source.slice(openBrace + 1, close));

  const members: string[] = [];
  // Keyed by the variant the fields belong to, **not** pooled. A single
  // deduplicated set across every struct-bodied variant is what a probe walked
  // through: `#[serde(skip)]` on `SkillListing::Invalid::directory`, where the
  // sibling `Skill` variant also declares `directory`, left the pooled union
  // unchanged and the equality green while a key the renderer reads stopped
  // crossing on one arm. The attribute was read perfectly — the loss was
  // entirely in pooling the answer before comparing it.
  const payload = new Map<string, Set<string>>();
  const conditional: string[] = [];
  let current: Set<string> | null = null;
  let pending = '';
  let skipNextMember = false;
  let skipNextPayload = false;
  let conditionalNextMember = false;

  const refuseField = (problem: string): Error =>
    new Error(
      `serde-wire: a field of ${name} in ${file} carries ${problem}. The identifier is no ` +
        `longer evidence of the wire key; assert the bytes on the Rust side instead.`,
    );

  const readFieldAttribute = (text: string, onto: 'member' | 'payload'): void => {
    for (const [key] of accountedSerdeArguments(text, refuseField)) {
      const known = FIELD_KEYS.get(key);
      if (known === undefined) {
        throw refuseField(`\`#[serde(${key})]\`, which this parser does not model`);
      }
      if (known === 'drops-the-key') {
        if (onto === 'member') skipNextMember = true;
        else skipNextPayload = true;
        continue;
      }
      if (known !== 'makes-the-key-conditional') continue;
      if (onto === 'payload') {
        // No live instance in any file these guards read, and no reader for the
        // answer if there were one: {@link conditionalFields} is a flat list of
        // members and a payload field is a member of nothing. Refusing is the
        // direction that cannot report a key as unconditional when it is not.
        throw refuseField(
          '`#[serde(skip_serializing_if)]` inside a struct-bodied variant, which this parser ' +
            'does not model',
        );
      }
      conditionalNextMember = true;
    }
  };

  for (const line of lines) {
    if (line.depth > 1 || (line.depth === 1 && keyword !== 'enum')) continue;
    const onto = line.depth === 0 ? 'member' : 'payload';
    const text = line.text;
    if (pending !== '') {
      pending += `\n${text}`;
      if (matchingBracket(pending, pending.indexOf('[')) >= 0) {
        readFieldAttribute(pending, onto);
        pending = '';
      }
      continue;
    }
    // Blank, or nothing but a comment: `line.code` is what is left after
    // comments and string literals are blanked, so a line in the middle of a
    // `/* … */` block is empty here without the reader having to recognise it.
    if (line.code === '') continue;
    if (line.continuation) continue;
    // The whole line, structurally, is `line.code`; `line.text` is what a
    // person has to go and find. Both are trimmed independently, so their
    // indices are **not** interchangeable and every index below comes from
    // `code`. The one reader that took them from `text` was the one-line
    // struct-variant reader, and it was the single exception to the sentence
    // this file states about itself — *every structural read runs on the
    // output rather than on the source, so that a brace inside a doc comment
    // or a string literal cannot move it*. It could: `Image { mime_type:
    // String, data: Vec<u8> /* } */, secret_path: String },` closed the
    // variant at the comment's brace and dropped the field after the comment
    // in silence,
    // and `Text, // { ghost: String }` on a unit variant invented a payload
    // key out of a comment.
    if (line.code.startsWith('#')) {
      const open = text.indexOf('[');
      if (open < 0 || matchingBracket(text, open) < 0) {
        pending = text;
        continue;
      }
      readFieldAttribute(text, onto);
      continue;
    }
    if (CLOSING_PUNCTUATION.test(line.code)) continue;
    // Every member line is accounted for as a whole. A line that spells two
    // members is a line this reader mis-answers rather than fails to read, so
    // `refuseUnreadable` below never sees it — and the second member's serde
    // attribute is read by nothing while its key crosses the bridge.
    const split = topLevelParts(line.code);
    // Before the count, because a line whose angle brackets do not pair up has
    // no trustworthy count: the comma that would have made it two parts was
    // read as sitting inside a generic list that never opened.
    if (!split.angleBalanced) throw refuseUnpairedAngle(name, file, text);
    const parts = split.parts;
    if (parts.length > 1) {
      // Decided on `line.code`, where a comma inside a string literal has been
      // blanked away and cannot be mistaken for a separator; quoted from
      // `line.text`, which is what somebody reading the error has to go and find.
      throw refuseSecondMember(
        name,
        file,
        text,
        topLevelParts(text).parts[1] ?? (parts[1] as string),
      );
    }
    if (line.depth === 1) {
      // A field inside a struct-bodied variant. Its key is on the wire under
      // `rename_all_fields`, and it is a member of nothing.
      const field = FIELD_DECLARATION.exec(line.code);
      if (field === null) {
        throw refuseUnreadable(name, file, text, 'a field of a struct-bodied variant');
      }
      if (skipNextPayload) {
        skipNextPayload = false;
        continue;
      }
      current?.add(field[1] as string);
      continue;
    }
    const member =
      keyword === 'enum' ? VARIANT_DECLARATION.exec(line.code) : FIELD_DECLARATION.exec(line.code);
    const captured = member?.[1];
    if (captured === undefined) {
      throw refuseUnreadable(name, file, text, keyword === 'enum' ? 'a variant' : 'a field');
    }
    if (skipNextMember) {
      skipNextMember = false;
      conditionalNextMember = false;
      current = null;
      continue;
    }
    members.push(captured);
    if (conditionalNextMember) {
      conditionalNextMember = false;
      conditional.push(captured);
    }
    if (keyword !== 'enum') continue;
    // Struct-bodied variants only. A unit or tuple variant contributes no key
    // of its own, so an entry for it would be an empty list in every record
    // this is compared against; a variant that *gains* or *loses* a struct body
    // moves an entry into or out of the map, which is the change worth seeing.
    current = null;
    if (!line.code.includes('{')) continue;
    current = new Set<string>();
    payload.set(captured, current);
    // A struct-bodied variant that rustfmt kept on one line —
    // `Image { mime_type: String, data: Vec<u8> },`. Its fields never appear on
    // a line of their own, so the depth-1 branch above never sees them. Reading
    // only the multi-line spelling would have made the payload comparison a
    // measurement of how long a variant happened to be.
    const brace = line.code.indexOf('{');
    if (brace < 0) continue;
    const closeBrace = matchingBracket(line.code, brace);
    if (closeBrace < 0) continue; // opens here, closes below: the depth-1 branch has it
    // The whole-line accounting this reader needs has already happened, and
    // that is worth stating rather than repeating. The round before this one
    // added a second `if (!inner.angleBalanced) throw` here, on the slice
    // between the braces — and it could never fire: `split.angleBalanced`
    // above is computed over the whole of `line.code`, the braces included, so
    // any angle this slice fails to pair is an angle that line failed to pair.
    // Measured, not argued: commenting the second copy out failed nothing,
    // including the fixture named for it, because the outer check catches that
    // fixture one branch earlier. Two places deciding one condition where
    // deleting either changes no answer is the shape this round was told to
    // stop producing, so there is one place. The fixture
    // `refuses a one-line struct variant whose angle brackets do not pair up`
    // is red when that one place is removed — which is the whole of what a
    // second copy was buying.
    const inner = topLevelParts(line.code.slice(brace + 1, closeBrace));
    for (const part of inner.parts) {
      if (part.includes('#[')) {
        throw refuseField('an attribute inside a one-line struct variant');
      }
      const field = FIELD_DECLARATION.exec(part);
      if (field === null) {
        throw refuseUnreadable(name, file, part, 'a field of a one-line struct variant');
      }
      current.add(field[1] as string);
    }
  }
  if (pending !== '') {
    throw new Error(`serde-wire: unterminated attribute in ${name} in ${file}`);
  }
  return {
    members,
    renameAll,
    kind,
    tag,
    payloadFields: new Map([...payload].map(([variant, fields]) => [variant, [...fields].sort()])),
    renameAllFields,
    conditionalFields: [...conditional].sort(),
  };
}

/**
 * Applies the item's own `rename_all`, exactly as serde does — **which is two
 * different transformations under one attribute name**, and that is the trap.
 *
 * Serde reads a variant as PascalCase and a field as snake_case, so a single
 * `rename_all = "camelCase"` means *lowercase the first character* on an enum
 * and *fold each underscore into the letter after it* on a struct. A single
 * implementation for both — a word split on the lowercase-to-uppercase
 * boundary — gets away with it because the two answers agree on every member
 * currently in the tree. They stop agreeing the moment two capitals meet: serde
 * renames `HTTPError` to `hTTPError` under camelCase and to `h_t_t_p_error`
 * under snake_case, where the word split answers `httperror` for both and
 * reports the contract wrong about a name the host really sends. That the two
 * rules really are two is not asserted here in prose: `applies serde’s two
 * different rules under the one attribute name` in
 * `src/platform/chat-contract-parity.test.ts` runs both against `HTTPError` and
 * pins both answers, and `implements every rule it claims to recognise` walks
 * {@link RENAME_RULES} and pins each of its eight rules twice, once as a
 * variant and once as a field.
 *
 * Ported arm for arm from serde_derive's own case conversion, which is where
 * that split lives: one function for a variant, a different one for a field.
 */
export function wireName(rustName: string, rule: RenameRule, kind: 'variant' | 'field'): string {
  if (rule === 'none') return rustName;
  if (kind === 'variant') {
    // Input is PascalCase.
    const snake = rustName
      .split('')
      .map((character, index) =>
        character >= 'A' && character <= 'Z'
          ? `${index === 0 ? '' : '_'}${character.toLowerCase()}`
          : character,
      )
      .join('');
    switch (rule) {
      case 'lowercase':
        return rustName.toLowerCase();
      case 'UPPERCASE':
        return rustName.toUpperCase();
      case 'PascalCase':
        return rustName;
      case 'camelCase':
        return rustName.charAt(0).toLowerCase() + rustName.slice(1);
      case 'snake_case':
        return snake;
      case 'SCREAMING_SNAKE_CASE':
        return snake.toUpperCase();
      case 'kebab-case':
        return snake.replace(/_/g, '-');
      case 'SCREAMING-KEBAB-CASE':
        return snake.toUpperCase().replace(/_/g, '-');
    }
  }
  // Input is snake_case.
  const pascal = rustName.replace(/(^|_)([a-z0-9])/g, (_, __, after: string) =>
    after.toUpperCase(),
  );
  switch (rule) {
    case 'lowercase':
    case 'snake_case':
      return rustName;
    case 'UPPERCASE':
    case 'SCREAMING_SNAKE_CASE':
      return rustName.toUpperCase();
    case 'PascalCase':
      return pascal;
    case 'camelCase':
      return pascal.charAt(0).toLowerCase() + pascal.slice(1);
    case 'kebab-case':
      return rustName.replace(/_/g, '-');
    case 'SCREAMING-KEBAB-CASE':
      return rustName.toUpperCase().replace(/_/g, '-');
  }
}

export function wireNames(item: RustItem): readonly string[] {
  return item.members.map((member) => wireName(member, item.renameAll, item.kind));
}

/**
 * The wire keys serde may omit — {@link RustItem.conditionalFields} renamed the
 * way the item's own rule renames them, sorted.
 *
 * The other side of this comparison is not a hand-written list: each guard
 * derives it from the contract interface with a type-level `OptionalKeysOf`, so
 * the two sentences being held together are *"serde may omit this key"* and
 * *"the renderer's type says this key may be missing"*. Those are the same
 * sentence, and until this pair existed neither side asserted it.
 */
export function conditionalWireKeys(item: RustItem): readonly string[] {
  return item.conditionalFields
    .map((field) => wireName(field, item.renameAll, item.kind))
    .sort();
}

/**
 * The keys the fields inside each struct-bodied variant cross under — **the
 * variant's own wire name to its own sorted keys**, one entry per
 * struct-bodied variant.
 *
 * Two different rename rules meet here and neither may be used for the other's
 * job. The *variant* name is renamed by the item's `rename_all` under the
 * variant rule; the fields inside it are renamed by `rename_all_fields` under
 * the *field* rule, which is the one that folds underscores. Reading the fields
 * with the variant rule would answer `mime_type` for `mime_type` and report
 * agreement where there is none.
 *
 * A plain object rather than a `Map` because callers compare it with
 * `toEqual`, and a diff that names the arm is the whole value of keying it.
 */
export function payloadWireKeys(item: RustItem): Readonly<Record<string, readonly string[]>> {
  const keys: Record<string, readonly string[]> = {};
  for (const [variant, fields] of item.payloadFields) {
    keys[wireName(variant, item.renameAll, item.kind)] = fields
      .map((field) => wireName(field, item.renameAllFields, 'field'))
      .sort();
  }
  return keys;
}

/**
 * The other side of {@link payloadWireKeys}: a hand-written per-arm record,
 * normalised so the two can be compared.
 *
 * Arms with no fields are dropped, because a unit or tuple variant puts no key
 * on the wire and the Rust side has no entry for one; the fields of each
 * remaining arm are sorted, because declaration order is not part of the wire
 * contract. Every arm still has to be *written* on the TypeScript side — that
 * is what the per-guard type-level check enforces, and it is why an arm can be
 * dropped here without a new arm being able to go unnoticed.
 *
 * Here rather than in each guard, and the distinction is the one this whole
 * file exists over: `everyVariantOf` is copied into all three guards because a
 * type-level helper has no behaviour and a second copy is the same helper by
 * construction. This has behaviour. Three copies would be three behaviours, and
 * the copy that is one refactor behind is the one that quietly compares less.
 */
export function payloadRecord(
  record: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(
    Object.entries(record)
      .filter(([, fields]) => fields.length > 0)
      .map(([arm, fields]) => [arm, [...fields].sort()]),
  );
}

export interface SerialisableItem {
  readonly file: string;
  readonly keyword: 'enum' | 'struct';
  readonly rust: string;
  /**
   * Whether the item has a braced body, a tuple body, or no body at all.
   *
   * On the inventory rather than filtered out of it, and that is this round's
   * correction. A tuple or unit item has no member names, so
   * {@link parseRustItem} cannot pair it — but "cannot be paired" and "cannot
   * put keys on the wire" are two different sentences, and this scan used to
   * answer the second by testing the first. Three `Serialize`-deriving tuple
   * structs sit in `diagnostic.rs`, a file the chat guard reads, and the
   * assertion that calls its inventory complete listed none of them.
   *
   * The register rows carry this field too, so a newtype that grows a braced
   * body — which is a type that starts putting its own keys on the wire —
   * fails its row instead of passing quietly under the same name.
   */
  readonly form: 'braced' | 'tuple' | 'unit';
}

export function qualified(item: { readonly file: string; readonly rust: string }): string {
  return `${item.file}::${item.rust}`;
}

/**
 * Every token in a piece of prose that is shaped like a path to a file.
 *
 * Each parity guard carries a register of serialisable types it deliberately
 * does not pair, and each entry carries a sentence saying why. A probe read
 * one of those sentences and used it: the skills register discharged
 * `SkillHeader` with *"`src-tauri/src/ipc/skills.rs` takes it apart and builds
 * `SkillsReadRes`, whose fields are what the renderer reads"* — and no
 * inventory in the repository read that file. Changing `tag = "kind"` to
 * `tag = "type"` there is the exact edit `Pairing.tag`'s own documentation
 * cites as its founding motivation, and it was green across the whole suite.
 *
 * **The first answer to that was itself a spelling, and it was wrong in both
 * directions.** It collected `\S+\.rs` out of the sentence and required each
 * hit to be a file the guard opened. So spelling the path the way the
 * repository spells it — `src-tauri/src/ipc/skills.rs` — turned the guard
 * **red**, because the guard's own key for that file is `ipc/skills.rs`; and
 * writing *"the ipc/skills module"*, which is how prose usually reads, made
 * the check vanish, leaving `keyword` and `form` as the whole content of the
 * row. A register entry could then discharge a type into a module nobody
 * opens and stay green — which is verbatim the probe the check was written to
 * close.
 *
 * RULE T says prose neither creates nor proves an edge, so the answer is not a
 * better path matcher. It is that **the prose may not name a file at all**:
 * the only place a register entry may point at something is a field a reader
 * checks — `handedTo`, whose target must be a type the same guard pairs. This
 * function exists to make that enforceable, and it is deliberately
 * over-inclusive: anything with a `/` in it, and anything ending in a short
 * extension, is a path as far as this is concerned. Over-inclusion costs a
 * reworded sentence. Under-inclusion would cost nothing at all, because a file
 * named in prose is not an edge whether or not this function sees it — which
 * is the whole point, and the reason the residual hole here is not one.
 */
export function filePathsNamedIn(prose: string): readonly string[] {
  const found = new Set<string>();
  for (const match of prose.matchAll(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+/gu)) {
    found.add(match[0] as string);
  }
  for (const match of prose.matchAll(/[A-Za-z0-9_-]+\.[A-Za-z0-9]+\b/gu)) {
    found.add(match[0] as string);
  }
  return [...found].sort();
}

/**
 * The name `Serialize` is imported under in this file, if it is renamed — or
 * `null` when no `use` item renames it in either direction.
 *
 * Both directions matter and for different reasons. `Serialize as Wire` makes
 * the trait invisible to a token test, which loses a live serialisable type.
 * `Something as Serialize` makes an unrelated trait look like it, which puts a
 * type on the inventory that is not on the wire. Neither is followed; both are
 * reported, and {@link scanSerialisable} turns either into a refusal.
 *
 * Run over blanked source, so a `use` written inside a string or a doc comment
 * is not one.
 */
function renamedSerializeImportIn(blanked: string): string | null {
  for (const item of blanked.matchAll(/\buse\b[^;]*;/g)) {
    for (const rename of (item[0] as string).matchAll(
      /\b([A-Za-z_][A-Za-z0-9_]*)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\b/g,
    )) {
      if (rename[1] === 'Serialize' || rename[2] === 'Serialize') {
        return (rename[0] as string).replace(/\s+/g, ' ');
      }
    }
  }
  return null;
}

/**
 * The first `#[path = "…"]` attribute in a file, as written, or `null`.
 *
 * Read through {@link parseAttributeSpec} and {@link withoutCfgAttr} rather
 * than by a regex over the raw bytes, so that a `cfg_attr`-wrapped one is found
 * too — the same wrapper that carried a `rename` past the first version of this
 * file's refusal.
 *
 * The indices come from the blanked text and the quotation from the source,
 * which is sound because the blanking is length-preserving.
 */
function modulePathAttributesIn(source: string, blanked: string): string | null {
  for (let index = blanked.indexOf('#['); index >= 0; index = blanked.indexOf('#[', index + 2)) {
    const close = matchingBracket(blanked, index + 1);
    if (close < 0) continue;
    const parsed = parseAttributeSpec(blanked.slice(index + 2, close));
    if (parsed === null) continue;
    for (const attribute of withoutCfgAttr([parsed]).attributes) {
      if (attribute.path === 'path') return source.slice(index, close + 1).trim();
    }
  }
  return null;
}

/**
 * The first macro invocation written where an **item** can be declared, as
 * written, or `null`.
 *
 * `declarationsIn` reads the file as written. rustc reads it expanded, and
 * between the two sits every construct that puts a declaration into the crate
 * without putting one into the text. `#[path]` is one such construct and is
 * refused above; a macro is the other two.
 *
 * - **A macro body can declare the type.** This repository already does it:
 *   `src-tauri/crates/vela-store/src/model.rs` declares `macro_rules!
 *   id_newtype` whose body carries `#[derive(…, Serialize, Deserialize)]
 *   #[serde(transparent)] pub struct $name(String);`, and invokes it six
 *   times. Six serialisable types in Vela are declared this way today. The
 *   name alphabet here is `[A-Za-z][A-Za-z0-9_]*`, so `pub struct $name`
 *   matches nothing and the invocation's argument is not a declaration either:
 *   the type is in the crate and on no inventory. `vela-store` is not one of
 *   the three directories these guards walk, so this is a shape one crate away
 *   rather than a live miss — and folding the three hand-written newtypes in
 *   the scanned `diagnostic.rs` into that same macro is ordinary tidying.
 * - **`include!` splices a file.** It does what `#[path]` does — puts source
 *   from an arbitrary relative path into the crate — without being an
 *   attribute, so the `#[path]` refusal never sees it. The build-script form,
 *   `include!(concat!(env!("OUT_DIR"), "/wire.rs"))`, is what every codegen
 *   crate in the ecosystem ships, and `src-tauri/build.rs` already exists.
 *
 * Both are macro invocations at item position, so both are one refusal. Item
 * position is decided structurally, not by a name list: the braces enclosing
 * the invocation must all have been opened by `mod`, and the nearest thing
 * before the invocation's **whole path** — skipping whitespace and whole
 * attribute groups — must be `;`, `{`, `}` or the start of the file. That is
 * what keeps `let mut vocabulary = vec![…]`, `if matches!(…)` and
 * `if cfg!(windows) { … }` out of it, all three of which are live in the
 * scanned files: they sit in expression position, in a function body, or both.
 *
 * **"The whole path" is this round's fix and the previous round's defect.**
 * Item position was decided structurally and then the structure was read from
 * the character before the macro's *last* path segment, which for
 * `crate::id_newtype!(Foo);` is `:` — none of `;` `{` `}` or the start of the
 * file, so the function returned `null` and the file was accepted. Seven
 * characters between caught and blind, on a spelling this repository already
 * writes sixty-four times (`serde_json::json!` fifty of them), and the
 * ordinary item-position spellings of the constructs this refusal names are
 * `bitflags::bitflags! { … }`, `paste::paste! { … }` and
 * `std::include!(…)`. A leading path is walked back over now — repeated
 * `identifier ::`, plus a bare leading `::` — and so is whitespace between the
 * name and its `!`, which was a second door through the same test.
 *
 * Measured on the tree this is committed in: over the fifteen `.rs` files
 * these guards scan this returns `null` for every one of them, so the refusal
 * costs nothing today. What it fires on is a macro invoked where an item can
 * be declared, under any path spelling, in a file whose enclosing braces this
 * scan recognises — **not** every way a wire type can be put behind a macro.
 * The round before this one wrote that second sentence as a universal and it
 * was falsified by the first construction thrown at it, so what is left open
 * is written down instead: a macro *defined* elsewhere and invoked inside an
 * inline `mod` whose opening this scan failed to recognise as a module. The
 * frame test is a two-word lookback (`mod NAME {`), and where it guesses wrong
 * it guesses towards silence.
 */
function itemPositionMacroIn(source: string, blanked: string): string | null {
  const modules: boolean[] = [];
  let word = '';
  let wordAt = -1;
  let wordEnd = -1;
  let previous = '';
  let beforePrevious = '';
  const atItemStart = (from: number): boolean => {
    let index = from - 1;
    while (index >= 0) {
      const character = blanked[index] as string;
      if (/\s/u.test(character) || character === '#') {
        index -= 1;
        continue;
      }
      if (character === ']' || character === ')') {
        const open = openingBracket(blanked, index);
        if (open < 0) return false;
        index = open - 1;
        continue;
      }
      return character === ';' || character === '{' || character === '}';
    }
    return true;
  };
  // Where the macro's **path** begins, given where its last segment begins.
  //
  // This is the round-5 fix's own defect, and it is the one that has moved
  // down a level every round: item position was decided structurally, and then
  // the structure was read from the character before the last path segment.
  // For `crate::id_newtype!(Foo);` that character is `:`, which is none of `;`
  // `{` `}` or the start of the file, so the refusal returned null and the
  // file was accepted — seven characters between caught and blind, on a
  // spelling this repository already uses sixty-four times (`serde_json::json!`
  // fifty of them). `bitflags::bitflags! { … }`, `paste::paste! { … }` and
  // `std::include!("gen.rs")` are the same shape at item position. So the path
  // is walked back over — repeated `identifier ::`, and a leading `::` — and
  // item position is tested from its first byte.
  const pathStartAt = (from: number): number => {
    let start = from;
    for (;;) {
      let index = start - 1;
      while (index >= 0 && /\s/u.test(blanked[index] as string)) index -= 1;
      if (index < 1 || blanked[index] !== ':' || blanked[index - 1] !== ':') return start;
      const colons = index - 1;
      index = colons - 1;
      while (index >= 0 && /\s/u.test(blanked[index] as string)) index -= 1;
      if (index < 0 || !IDENTIFIER_CHARACTER.test(blanked[index] as string)) return colons;
      while (index >= 0 && IDENTIFIER_CHARACTER.test(blanked[index] as string)) index -= 1;
      start = index + 1;
    }
  };
  // Whether `!` at `at` belongs to the identifier that ended at `wordEnd` —
  // that is, whether nothing but whitespace stands between them. `id_newtype
  // !(Foo);` is legal Rust that rustfmt would reflow, and the previous version
  // decided the question by adjacency: the space flushed the word and the `!`
  // arrived with nothing to attach to. `!=` is excluded because that `!` is an
  // operator; a prefix `!` cannot reach here, since negation is never written
  // after a bare identifier and every enclosing brace has to have been opened
  // by `mod` for the test below to run at all.
  const bangBelongsToWord = (at: number): boolean => {
    if (blanked[at + 1] === '=') return false;
    if (word !== '') return true;
    if (wordEnd < 0) return false;
    for (let index = wordEnd; index < at; index += 1) {
      if (!/\s/u.test(blanked[index] as string)) return false;
    }
    return true;
  };
  for (let index = 0; index < blanked.length; index += 1) {
    const character = blanked[index] as string;
    if (IDENTIFIER_CHARACTER.test(character)) {
      if (word === '') wordAt = index;
      word += character;
      wordEnd = index + 1;
      continue;
    }
    if (
      character === '!' &&
      bangBelongsToWord(index) &&
      modules.every(Boolean) &&
      atItemStart(pathStartAt(wordAt))
    ) {
      return source
        .slice(pathStartAt(wordAt), Math.min(index + 24, source.length))
        .replace(/\s+/gu, ' ')
        .trim();
    }
    if (word !== '') {
      beforePrevious = previous;
      previous = word;
      word = '';
    }
    if (character === '{') modules.push(beforePrevious === 'mod');
    else if (character === '}') modules.pop();
    // A `!` reached across whitespace, so the identifier's position has to
    // survive the characters between it and the `!` that may follow.
    if (!/\s/u.test(character)) {
      wordAt = -1;
      wordEnd = -1;
    }
  }
  return null;
}

/**
 * Every `enum` / `struct` in one file that can put keys on the wire.
 *
 * **Over-inclusion costs an entry on a register; under-inclusion costs a miss,
 * and a miss is what this scan exists to prevent.** Four earlier versions each
 * substituted a spelling for the question and each lost a live type to it:
 *
 * - `pub struct X … {` at the end of one line missed a `where` clause, whose
 *   opening brace is on a line of its own. The form is now decided by reading
 *   forward to the first `{`, `(` or `;` ({@link itemForm}).
 * - `^pub ` missed `pub(crate)` and anything indented inside a `mod`.
 *   {@link DECLARATION} now spells every visibility Rust allows, and no
 *   visibility at all.
 * - `^[ \t]*` — the remainder of that anchor — missed a declaration sharing a
 *   line with its own attributes, which is legal Rust that rustfmt happens not
 *   to produce. {@link DECLARATION} no longer says where on a line a
 *   declaration may start.
 * - a `derive` naming `Serialize` missed a hand-written
 *   `impl serde::Serialize for X`, which satisfies the same trait and puts
 *   whatever keys its body writes on the wire. {@link serializeImplTarget} finds
 *   those, and a manual impl for a type this file does not declare is an
 *   **error** rather than a shrug, because the alternative is a serialisable
 *   type that no inventory in the repository can name.
 *
 * Two more of exactly that shape were found against this version and are
 * refused here rather than recognised past:
 *
 * - **The token `Serialize` is not the trait.** `use serde::Serialize as Wire;`
 *   is ordinary Rust, `#[derive(Debug, Clone, Wire)]` derives the same trait,
 *   and a body test of `/\bSerialize\b/` answers no. Following the alias would
 *   mean resolving Rust imports; **{@link renamedSerializeImportIn} refuses the
 *   file instead**, in the direction that cannot report a serialisable type as
 *   absent.
 * - **The set of files is not the set of modules.** Each guard finds its files
 *   by walking `<crate>/src`, and `#[path = "…"]` says where a module's source
 *   is without that source having to be under that directory. A probe put a
 *   live internally-tagged `Serialize` enum in `<crate>/audit.rs` — one level
 *   *above* `src` — attached it with `#[path = "../audit.rs"] pub mod audit;`,
 *   and it was outside every inventory in the repository while the assertion
 *   named `reads the whole crate` stayed green, because that assertion compares
 *   two values the walk moves together. {@link modulePathAttributesIn} makes
 *   the walk's premise an asserted one: with no `#[path]` anywhere in the files
 *   scanned, rustc's default mapping puts every module of the crate under the
 *   directory of its parent, and the crate root is in `src`.
 *
 * And three more, which are what this round is about. The first two are the
 * same sentence as `#[path]` — *the source read is not the source rustc
 * compiles* — reached through doors an attribute list cannot have an entry
 * for, and {@link itemPositionMacroIn} refuses both. The third is the one that
 * was **already false about the tree being scanned**:
 *
 * - **A serialisable type need not be a braced item.** This scan used to
 *   `continue` past every tuple and unit item before it asked whether the
 *   thing derived or implemented `Serialize`, on the reasoning that an item
 *   with no member names cannot be paired. True, and beside the point: the
 *   sentence two paragraphs up says under-inclusion costs a *miss*, and
 *   `diagnostic.rs` — one of the chat guard's five files — declares
 *   `ConfiguredModelId(String)`, `CorrelationId(u64)` and `HarmCategories(u8)`,
 *   each under a derive list containing `Serialize`, each absent from the
 *   inventory that assertion calls complete. Worse, the `continue` sat *above*
 *   the `manual.has(name)` test, so {@link serializeImplTarget} — written because a
 *   hand-written impl "puts whatever keys its body writes on the wire" — could
 *   not fire on the one item shape most likely to carry one: a newtype whose
 *   whole reason to exist is a wire form other than its inner value's.
 *   Non-braced items now join the inventory carrying their
 *   {@link SerialisableItem.form}, which puts them on a register rather than
 *   out of sight, exactly as the doctrine above says it should.
 */
export function scanSerialisable(source: string, file: string): readonly SerialisableItem[] {
  const declarations = declarationsIn(source);
  const blanked = withoutCommentsOrStrings(source);
  const alias = renamedSerializeImportIn(blanked);
  if (alias !== null) {
    throw new Error(
      `serde-wire: ${file} imports \`Serialize\` under another name (\`${alias}\`). This scan ` +
        `asks whether a derive list contains the token \`Serialize\`, which is a question ` +
        `about text; under an alias the answer is no and the type is still on the wire.`,
    );
  }
  const offTree = modulePathAttributesIn(source, blanked);
  if (offTree !== null) {
    throw new Error(
      `serde-wire: ${file} carries \`${offTree}\`. A \`#[path]\` attribute puts a module's ` +
        `source somewhere other than where the module tree says it is, so a guard that walks ` +
        `a directory for \`.rs\` files is no longer walking the crate's modules.`,
    );
  }
  const spliced = itemPositionMacroIn(source, blanked);
  if (spliced !== null) {
    throw new Error(
      `serde-wire: ${file} invokes \`${spliced}\` where an item can be declared. A macro at ` +
        `item position declares whatever its expansion declares — this repository's own ` +
        `\`id_newtype!\` emits a \`#[derive(…, Serialize)] pub struct\` from inside a ` +
        `\`macro_rules!\` body — and \`include!\` splices a file from an arbitrary path, ` +
        `which is what \`#[path]\` does without being an attribute. This scan reads the ` +
        `source as written, not as expanded, so either one puts a type in the crate that no ` +
        `inventory here can name.`,
    );
  }
  const manual = new Set<string>(serializeImplTargetsIn(blanked));
  const found: SerialisableItem[] = [];
  const declared = new Set(declarations.map((declaration) => declaration.name));
  for (const target of manual) {
    if (declared.has(target)) continue;
    throw new Error(
      `serde-wire: ${file} implements \`Serialize\` for \`${target}\`, which it does not ` +
        `declare. This scan can only put a type on an inventory it can also read; move the ` +
        `impl next to the declaration, or the type is serialisable and unaccounted.`,
    );
  }
  for (const { name, keyword, at, after } of declarations) {
    const form = itemForm(source, after).form;
    if (form === 'undecided') {
      throw new Error(
        `serde-wire: this scan could not decide whether \`${keyword} ${name}\` in ${file} is ` +
          `braced, a tuple or a unit item. A form it cannot decide used to read as \`unit\` ` +
          `and leave the inventory silently, which is the one failure an inventory prevents.`,
      );
    }
    // The form is *recorded*, not used to skip. It used to `continue` here —
    // above the `manual.has(name)` test below, which is why a hand-written
    // `Serialize` impl on a tuple struct was unreachable — and the three
    // `Serialize`-deriving tuple structs in `diagnostic.rs` were the price.
    const region = attributeRegionBefore(source, at);
    const read = readAttributeText(region);
    if (read.unaccounted !== null) {
      throw new Error(
        `serde-wire: the attribute region above \`${keyword} ${name}\` in ${file} holds text ` +
          `this parser cannot account for: \`${firstLine(read.unaccounted)}\`. A derive hidden ` +
          `in it would make the type invisible to this inventory.`,
      );
    }
    const derives = withoutCfgAttr(read.attributes).attributes.filter(
      (attribute) => attribute.path === 'derive',
    );
    const derived = derives.some((attribute) => /\bSerialize\b/.test(attribute.body ?? ''));
    if (!derived && !manual.has(name)) continue;
    found.push({ file, keyword, rust: name, form });
  }
  return found;
}
