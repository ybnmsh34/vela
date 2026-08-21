/**
 * **One reader that turns a Rust identifier into the key serde puts on the
 * wire, for every guard in this repository that needs one.**
 *
 * Three parity guards read `.rs` sources off disk and compare what they find
 * against a hand-written TypeScript list: `chat-contract-parity.test.ts` over
 * `src-tauri/crates/vela-providers/`, `skill-store-parity.test.ts` over
 * `src-tauri/crates/vela-skills/`, and `project-host-parity.test.ts` over
 * `src-tauri/crates/vela-projects/`. Each of them used to carry its own parse.
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
 *   and {@link IMPL_SERIALIZE} answer both.
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
   * walked straight through. The attribute is spelled fourteen times in this
   * repository's Rust — twelve of them in the three crates these guards read —
   * so flipping one from `camelCase` to `PascalCase` is an edit that looks like
   * every other edit around it. It sends `MimeType`/`CallId`/`IsError` where
   * `src/runtime/content-part-codec.ts`'s `toInput` reads `part.mimeType` off
   * an image part, while changing no identifier and no variant name.
   * {@link payloadWireNames} is what turns that edit into a red.
   */
  readonly renameAllFields: RenameRule;
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
      const end = text.indexOf('*/', index + 2);
      if (end < 0) return { attributes, unaccounted: text.slice(index) };
      index = end + 2;
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
 * Field keys this parser can account for. `skip` removes the member; the rest
 * leave the key on the wire under its own name. Anything else throws — most
 * pointedly `rename` and `flatten`, each of which makes the identifier a lie
 * about the key.
 */
const FIELD_KEYS: ReadonlyMap<string, 'drops-the-key' | 'keeps-the-key'> = new Map([
  ['skip', 'drops-the-key'],
  ['skip_serializing_if', 'keeps-the-key'],
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
 * Raw strings are handled explicitly rather than as ordinary strings, and the
 * reason is in this tree: `src-tauri/crates/vela-projects/src/workdir.rs`
 * spells `r"\\?\UNC\"`, whose *contents* end in a backslash. A raw string has
 * no escapes, so that backslash is content — but read with escape rules the
 * `\"` is taken as an escaped quote, the literal never closes, and the blanking
 * runs on past it. Measured on the committed tree: `workdir.rs` holds 4 such
 * literals and `link.rs` 2 — every one in either crate — and the first of
 * `workdir.rs`'s is inside `without_verbatim_prefix`. Running the previous
 * escape-only blanking over `workdir.rs` leaves 25 of the file's 84 braces
 * standing, starting with the `{` of that `if let`. It was not already a wrong
 * answer only because no `enum` or `struct` declaration in either file sits
 * after the first raw literal — measured, not assumed. **Throws** if the text
 * ends inside an unterminated literal, because that is the one outcome in which
 * every index this returns is wrong and nothing downstream could tell.
 */
function withoutCommentsOrStrings(text: string): string {
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
      const end = text.indexOf('*/', index + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += blank(index, stop);
      index = stop;
      continue;
    }
    const couldOpenRaw =
      (character === 'r' || character === 'b') && !/[A-Za-z0-9_]/.test(text[index - 1] ?? ' ');
    const raw = couldOpenRaw ? /^b?r(#*)"/.exec(text.slice(index, index + 16)) : null;
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

/** What follows the name in a `pub enum` / `pub struct` declaration. */
type ItemForm = 'braced' | 'tuple' | 'unit';

/**
 * Reads forward from just after an item's name to decide its form, and where
 * its body opens.
 *
 * A regex anchored on `…{$` was the previous answer and is the same class of
 * mistake as slicing from `#[derive`: it recognises one spelling of a braced
 * item rather than deciding the question. `pub struct X\nwhere\n    T: Copy,\n{`
 * is a braced item whose declaration line does not end in a brace, and a scan
 * that misses it drops the item from the inventory **silently** — which is the
 * one failure an inventory exists to prevent.
 */
function itemForm(source: string, after: number): { form: ItemForm; openBrace: number } {
  const text = withoutCommentsOrStrings(source);
  let angle = 0;
  for (let index = after; index < text.length; index += 1) {
    const character = text[index] as string;
    if (character === '<') angle += 1;
    else if (character === '>') {
      if (text[index - 1] === '-' || text[index - 1] === '=') continue;
      if (angle > 0) angle -= 1;
    } else if (angle === 0) {
      if (character === '{') return { form: 'braced', openBrace: index };
      if (character === '(') return { form: 'tuple', openBrace: -1 };
      if (character === ';') return { form: 'unit', openBrace: -1 };
    }
  }
  return { form: 'unit', openBrace: -1 };
}

/** Escapes a Rust identifier for use inside a `RegExp`. */
function literal(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
 */
const DECLARATION = '^[ \\t]*(?:pub(?:\\s*\\([^)]*\\))?[ \\t]+)?';

/**
 * A trait implementation of `Serialize`, whatever path it is written under.
 *
 * `Serialize` is a **trait**, and `#[derive(Serialize)]` is one way to satisfy
 * it, not the definition of satisfying it. A scan that looks only for the
 * derive answers *"did someone write the word `derive` here?"* when the
 * question is *"can this type put keys on the wire?"*, and a hand-written
 * `impl serde::Serialize for X` with a `serialize_struct` body answers the
 * second yes and the first no. The trait path is matched immediately before
 * `for` so that `impl Serializer`, `impl Deserialize` and a `Serialize` bound
 * in a generic parameter list are not it.
 */
const IMPL_SERIALIZE =
  /\bimpl\b(?:\s*<[^>]*>)?\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*::\s*)*Serialize\b(?:\s*<[^>]*>)?\s+for\s+([A-Za-z_][A-Za-z0-9_]*)/g;

interface Declaration {
  readonly name: string;
  readonly keyword: 'enum' | 'struct';
  /** Index of the start of the declaration's line, in the source. */
  readonly at: number;
  /** Index just past the item's name, where {@link itemForm} reads on from. */
  readonly after: number;
}

/**
 * Every `enum` / `struct` declaration in a file, whatever its visibility.
 *
 * Matched against the source with comments and string literals blanked, and
 * the indices are indices into the source because the blanking is
 * length-preserving. Widening the pattern to any indentation without blanking
 * first would let `/// pub struct Example {` in a doc comment, or the same text
 * inside a string, join the inventory as a type that does not exist.
 */
function declarationsIn(source: string): readonly Declaration[] {
  const found: Declaration[] = [];
  const pattern = new RegExp(`${DECLARATION}(enum|struct)[ \\t]+([A-Za-z][A-Za-z0-9_]*)`, 'gm');
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
   * variant. Angle brackets are deliberately *not* tracked, because `<` and `>`
   * are also comparison operators and a type-position-only reading of them is a
   * second parser; a generic argument list broken across lines therefore
   * reaches the refusal below rather than being silently skipped, which is the
   * safe direction.
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
 */
export function parseRustItem(
  source: string,
  keyword: 'enum' | 'struct',
  name: string,
  file = '<fixture>',
): RustItem {
  const declaration = new RegExp(`${DECLARATION}${keyword}[ \\t]+${literal(name)}\\b`, 'm');
  const found = declaration.exec(withoutCommentsOrStrings(source));
  if (found === null || found.index === undefined) {
    throw new Error(`serde-wire: no \`pub ${keyword} ${name}\` in ${file}`);
  }
  const at = found.index;
  const { form, openBrace } = itemForm(source, at + (found[0] as string).length);
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
  let current: Set<string> | null = null;
  let pending = '';
  let skipNextMember = false;
  let skipNextPayload = false;

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
      if (known !== 'drops-the-key') continue;
      if (onto === 'member') skipNextMember = true;
      else skipNextPayload = true;
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
    if (text.startsWith('#')) {
      const open = text.indexOf('[');
      if (open < 0 || matchingBracket(text, open) < 0) {
        pending = text;
        continue;
      }
      readFieldAttribute(text, onto);
      continue;
    }
    if (CLOSING_PUNCTUATION.test(line.code)) continue;
    if (line.depth === 1) {
      // A field inside a struct-bodied variant. Its key is on the wire under
      // `rename_all_fields`, and it is a member of nothing.
      const field = FIELD_DECLARATION.exec(text);
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
      keyword === 'enum' ? VARIANT_DECLARATION.exec(text) : FIELD_DECLARATION.exec(text);
    const captured = member?.[1];
    if (captured === undefined) {
      throw refuseUnreadable(name, file, text, keyword === 'enum' ? 'a variant' : 'a field');
    }
    if (skipNextMember) {
      skipNextMember = false;
      current = null;
      continue;
    }
    members.push(captured);
    if (keyword !== 'enum') continue;
    // Struct-bodied variants only. A unit or tuple variant contributes no key
    // of its own, so an entry for it would be an empty list in every record
    // this is compared against; a variant that *gains* or *loses* a struct body
    // moves an entry into or out of the map, which is the change worth seeing.
    current = null;
    if (!text.includes('{')) continue;
    current = new Set<string>();
    payload.set(captured, current);
    // A struct-bodied variant that rustfmt kept on one line —
    // `Image { mime_type: String, data: Vec<u8> },`. Its fields never appear on
    // a line of their own, so the depth-1 branch above never sees them. Reading
    // only the multi-line spelling would have made the payload comparison a
    // measurement of how long a variant happened to be.
    const brace = text.indexOf('{');
    if (brace < 0) continue;
    const closeBrace = matchingBracket(text, brace);
    if (closeBrace < 0) continue; // opens here, closes below: the depth-1 branch has it
    for (const part of splitArguments(text.slice(brace + 1, closeBrace))) {
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
}

export function qualified(item: { readonly file: string; readonly rust: string }): string {
  return `${item.file}::${item.rust}`;
}

/**
 * Every `.rs` path named in a piece of prose.
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
 * RULE T: prose neither creates nor proves an edge. So a register entry that
 * hands a type to another file must hand it somewhere the same guard reads,
 * and this is what lets each guard assert that rather than assume it. It is
 * deliberately literal — it finds the path, and the guard checks the path
 * against the files it actually opened; it does not try to judge the sentence.
 */
export function rustPathsNamedIn(prose: string): readonly string[] {
  return [...prose.matchAll(/[A-Za-z0-9_./-]+\.rs\b/g)].map((match) => match[0] as string);
}

/**
 * Every braced `enum` / `struct` in one file that can put keys on the wire.
 *
 * Tuple and unit structs are out of scope on purpose: they have no member
 * names for {@link parseRustItem} to read, so they cannot be paired at all.
 * `#[serde(transparent)]` newtypes such as `CorrelationId(u64)` and
 * `HarmCategories(u8)` are all of that shape here.
 *
 * **Over-inclusion costs an entry on a register; under-inclusion costs a miss,
 * and a miss is what this scan exists to prevent.** Three earlier versions each
 * substituted a spelling for the question and each lost a live type to it:
 *
 * - `pub struct X … {` at the end of one line missed a `where` clause, whose
 *   opening brace is on a line of its own. The form is now decided by reading
 *   forward to the first `{`, `(` or `;` ({@link itemForm}).
 * - `^pub ` missed `pub(crate)` and anything indented inside a `mod`.
 *   {@link DECLARATION} now spells every visibility Rust allows, and no
 *   visibility at all.
 * - a `derive` naming `Serialize` missed a hand-written
 *   `impl serde::Serialize for X`, which satisfies the same trait and puts
 *   whatever keys its body writes on the wire. {@link IMPL_SERIALIZE} finds
 *   those, and a manual impl for a type this file does not declare is an
 *   **error** rather than a shrug, because the alternative is a serialisable
 *   type that no inventory in the repository can name.
 */
export function scanSerialisable(source: string, file: string): readonly SerialisableItem[] {
  const declarations = declarationsIn(source);
  const blanked = withoutCommentsOrStrings(source);
  const manual = new Set<string>();
  for (const match of blanked.matchAll(IMPL_SERIALIZE)) manual.add(match[1] as string);
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
    if (itemForm(source, after).form !== 'braced') continue;
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
    found.push({ file, keyword, rust: name });
  }
  return found;
}
