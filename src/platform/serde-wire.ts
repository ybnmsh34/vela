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
 * what {@link parseRustItem} does now: {@link readAttributeText} consumes the
 * whole block — comments, `cfg_attr` wrappers and all — reports the first
 * stretch it could not classify, and any attribute whose effect on the wire
 * this file has not written down is an error naming it. {@link INERT_ATTRIBUTES},
 * {@link CONTAINER_KEYS} and {@link FIELD_KEYS} are the whole of what it claims
 * to understand.
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
   * The fields inside an enum's struct-bodied variants, deduplicated and
   * sorted, in Rust spelling. Empty for a struct, and for an enum whose
   * variants are all unit or tuple.
   *
   * These are keys on the wire and they are members of nothing, so — exactly
   * like {@link tag} — they had no comparison at all until one was written for
   * them. {@link payloadWireNames} applies {@link renameAllFields} to them.
   */
  readonly payloadFields: readonly string[];
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

/** Source with `//` comments and string literals blanked, for bracket counting. */
function withoutCommentsOrStrings(text: string): string {
  let out = '';
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const character = text[index] as string;
    if (inString) {
      // Byte-for-byte the same length as the input, so an index into the
      // blanked text is an index into the source. An escape consumes two
      // characters and must therefore emit two.
      if (character === '\\') {
        out += '  ';
        index += 2;
        continue;
      }
      if (character === '"') inString = false;
      out += character === '\n' ? '\n' : ' ';
      index += 1;
      continue;
    }
    if (text.startsWith('//', index)) {
      const end = text.indexOf('\n', index);
      const stop = end < 0 ? text.length : end;
      out += ' '.repeat(stop - index);
      index = stop;
      continue;
    }
    if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(index, stop).replace(/[^\r\n]/g, ' ');
      index = stop;
      continue;
    }
    if (character === '"') {
      // The opening quote is blanked too. Leaving it in place would hand a
      // lone `"` to every reader of this text, and the first of them to be
      // string-aware would swallow the rest of the file.
      inString = true;
      out += ' ';
      index += 1;
      continue;
    }
    out += character;
    index += 1;
  }
  return out;
}

/**
 * Whether the text closes a bracket it never opened — which is how a line
 * inside a multi-line attribute is told apart from a line of code.
 */
function closesWhatItDidNotOpen(text: string): boolean {
  let depth = 0;
  for (const character of withoutCommentsOrStrings(text)) {
    if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') {
      if (depth === 0) return true;
      depth -= 1;
    }
  }
  return false;
}

/**
 * The whole attribute block attached to the item declared at `at`.
 *
 * Walks *backwards* by line and keeps the longest run that reads as nothing but
 * attributes, comments and blank lines. The previous version of this sliced
 * from the last `#[derive` before the declaration, which is a literal standing
 * in for a concept: an attribute written above the derive — `#[serde(rename_all
 * = "PascalCase")] #[derive(Serialize)] pub struct …` is legal Rust and serde
 * reads it — was outside the slice and therefore outside the refusal.
 */
function attributeBlockBefore(source: string, at: number): string {
  const head = source.slice(0, at);
  const lines = head.split(/\r?\n/);
  // The declaration starts a line, so the final element is the empty string
  // before it; walking starts from the line above.
  let start = lines.length;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines.slice(index).join('\n');
    if (readAttributeText(candidate).unaccounted === null) {
      start = index;
      continue;
    }
    // Not attribute text on its own — but a continuation line of a multi-line
    // attribute is not either, and it always closes a bracket it did not open.
    if (!closesWhatItDidNotOpen(candidate)) break;
  }
  return lines.slice(start).join('\n');
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

/* -------------------------------------------------------------------------- */
/* reading the item                                                           */
/* -------------------------------------------------------------------------- */

interface BodyLine {
  readonly text: string;
  /** Brace depth at the start of the line, relative to the item's own body. */
  readonly depth: number;
}

/** The item body split into lines, each tagged with the depth it starts at. */
function bodyLines(body: string): readonly BodyLine[] {
  const lines: BodyLine[] = [];
  let depth = 0;
  for (const raw of body.split(/\r?\n/)) {
    lines.push({ text: raw.trim(), depth });
    for (const character of withoutCommentsOrStrings(raw)) {
      if (character === '{') depth += 1;
      else if (character === '}') depth -= 1;
    }
  }
  return lines;
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
  const declaration = new RegExp(`^pub ${keyword} ${literal(name)}\\b`, 'm');
  const found = declaration.exec(source);
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
  const container = accountedSerdeArguments(attributeBlockBefore(source, at), refuseContainer);
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
  const payload = new Set<string>();
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
    if (text === '' || text.startsWith('//')) continue;
    if (text.startsWith('#')) {
      const open = text.indexOf('[');
      if (open < 0 || matchingBracket(text, open) < 0) {
        pending = text;
        continue;
      }
      readFieldAttribute(text, onto);
      continue;
    }
    if (line.depth === 1) {
      // A field inside a struct-bodied variant. Its key is on the wire under
      // `rename_all_fields`, and it is a member of nothing.
      const field = /^(?:pub(?:\([a-z]+\))?\s+)?([a-z_][a-z0-9_]*)\s*:/.exec(text);
      if (field === null) continue;
      if (skipNextPayload) {
        skipNextPayload = false;
        continue;
      }
      payload.add(field[1] as string);
      continue;
    }
    const member =
      keyword === 'enum'
        ? /^([A-Z][A-Za-z0-9]*)\s*(?:[,{(]|$)/.exec(text)
        : /^(?:pub(?:\([a-z]+\))?\s+)?([a-z_][a-z0-9_]*)\s*:/.exec(text);
    const captured = member?.[1];
    if (captured === undefined) continue;
    if (skipNextMember) {
      skipNextMember = false;
      continue;
    }
    members.push(captured);
    if (keyword !== 'enum') continue;
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
      const field = /^(?:pub(?:\([a-z]+\))?\s+)?([a-z_][a-z0-9_]*)\s*:/.exec(part);
      if (field !== null) payload.add(field[1] as string);
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
    payloadFields: [...payload].sort(),
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
 * The keys the fields inside struct-bodied variants cross under, sorted.
 *
 * Always a *field* rename, whatever the item's own kind: `rename_all_fields`
 * addresses fields, and serde's field rule is the one that folds underscores.
 * Reading it with the variant rule would answer `mime_type` for `mime_type`
 * and report agreement where there is none.
 */
export function payloadWireNames(item: RustItem): readonly string[] {
  return item.payloadFields
    .map((field) => wireName(field, item.renameAllFields, 'field'))
    .sort();
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
 * Every braced `pub enum` / `pub struct` in one file that derives `Serialize`
 * — that is, everything in it that can put keys on the wire.
 *
 * Tuple and unit structs are out of scope on purpose: they have no member
 * names for {@link parseRustItem} to read, so they cannot be paired at all.
 * `#[serde(transparent)]` newtypes such as `CorrelationId(u64)` and
 * `HarmCategories(u8)` are all of that shape here.
 *
 * **Over-inclusion costs an entry on a register; under-inclusion costs a miss,
 * and a miss is what this scan exists to prevent.** So the form of each
 * declaration is decided by reading forward to the first `{`, `(` or `;`
 * rather than by matching a declaration that ends in a brace, and the derive is
 * looked for in the whole attribute block rather than in a slice back to
 * `#[derive`.
 */
export function scanSerialisable(source: string, file: string): readonly SerialisableItem[] {
  const found: SerialisableItem[] = [];
  for (const match of source.matchAll(/^pub (enum|struct) ([A-Za-z][A-Za-z0-9_]*)\b/gm)) {
    const at = match.index;
    if (at === undefined) continue;
    if (itemForm(source, at + (match[0] as string).length).form !== 'braced') continue;
    const block = attributeBlockBefore(source, at);
    const read = readAttributeText(block);
    const derives = withoutCfgAttr(read.attributes).attributes.filter(
      (attribute) => attribute.path === 'derive',
    );
    if (!derives.some((attribute) => /\bSerialize\b/.test(attribute.body ?? ''))) continue;
    found.push({ file, keyword: match[1] as 'enum' | 'struct', rust: match[2] as string });
  }
  return found;
}
