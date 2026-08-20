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
 * `declared-commands.ts`, two files over, already wrote down why that is not
 * survivable, about its own much smaller reader: *"a second copy is the same
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
 * `SkillListing`'s `tag = "kind"` to `tag = "type"` — left the full suite at
 * **2404 passed, exit 0**. The first sends `Scripts`/`References`/`Assets`
 * where `src/data/skills-repository.ts` reads `scripts`/`references`/`assets`;
 * the second makes every arm of `SkillsPanel.tsx`'s `entry.kind === 'skill'`
 * test false, so every skill the user installed renders as broken. Neither is
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
 * ## The posture
 *
 * **Refuse to compare what this cannot predict.** Where a serde attribute
 * severs the identifier from the key — a per-field `rename`, a `flatten`, an
 * `untagged` or `transparent` container — this throws rather than compare an
 * identifier it knows is not the key. A guard that reports agreement it never
 * checked is worse than an absent one, because the absent one does not get
 * believed. {@link CONTAINER_KEYS} and {@link FIELD_KEYS} are the whole of what
 * it claims to understand; anything else is an error naming the attribute.
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
 * this file exists and this nine-line helper does not need to.
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
   * silently, and this file carried the single implementation.
   */
  readonly kind: 'variant' | 'field';
  /**
   * The internal tag key — serde's `tag = "…"` — or `null` when the item is
   * not internally tagged. A wire key that is a member of nothing, which is
   * exactly why nothing used to compare it.
   */
  readonly tag: string | null;
}

/**
 * Serde container keys this parser has read and can account for, with what
 * each does to the keys that cross the bridge.
 *
 * Anything outside this map makes {@link parseRustItem} throw. That posture —
 * *refuse to compare what I do not model* — is the point of the rewrite. The
 * failure being fixed is not "the parser got an answer wrong", it is "the
 * parser had no opinion and reported agreement anyway".
 */
export const CONTAINER_KEYS: ReadonlyMap<string, string> = new Map([
  ['rename_all', 'read, and applied by wireName'],
  ['tag', 'read, and compared against the pairing'],
  [
    'rename_all_fields',
    // Renames the *payload* fields of struct variants (`mime_type` becomes
    // `mimeType` inside `ContentPart::Image`). Those names are not members of
    // the enum, so this parser never reads them and this guard never compares
    // them. Recorded here rather than silently tolerated: the gap is real, and
    // it is reported rather than papered over.
    'no effect on the member names this parser reads',
  ],
  ['deny_unknown_fields', 'deserialisation strictness only, emits no key'],
  ['default', 'deserialisation only, emits no key'],
]);

/**
 * Field keys this parser can account for. `skip` removes the member; the rest
 * leave the key on the wire under its own name. Anything else throws — most
 * pointedly `rename` and `flatten`, each of which makes the identifier a lie
 * about the key.
 */
export const FIELD_KEYS: ReadonlyMap<string, 'drops-the-key' | 'keeps-the-key'> = new Map([
  ['skip', 'drops-the-key'],
  ['skip_serializing_if', 'keeps-the-key'],
  ['default', 'keeps-the-key'],
  ['alias', 'keeps-the-key'],
  ['borrow', 'keeps-the-key'],
]);

/**
 * Splits the body of one attribute argument list on its top-level commas,
 * leaving quoted values and nested parens alone. `skip_serializing_if =
 * "Option::is_none", default` is two arguments; a comma inside a string
 * literal is none of them.
 */
export function splitArguments(body: string): readonly string[] {
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
    else if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
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
 * Every `#[serde(…)]` argument in a block of attribute text, as `key` to
 * `value` (`null` for a bare word such as `skip` or `transparent`).
 *
 * Reads by balanced parentheses rather than by line, because rustfmt breaks a
 * long attribute across lines — `ContentPart`'s is four — and a line-oriented
 * reader sees the first line only.
 */
export function serdeArguments(attributes: string): ReadonlyMap<string, string | null> {
  const found = new Map<string, string | null>();
  const opener = '#[serde(';
  let index = attributes.indexOf(opener);
  while (index >= 0) {
    const start = index + opener.length;
    let depth = 1;
    let inString = false;
    let cursor = start;
    for (; cursor < attributes.length && depth > 0; cursor += 1) {
      const character = attributes[cursor];
      if (inString) {
        if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '(') depth += 1;
      else if (character === ')') depth -= 1;
    }
    if (depth !== 0) throw new Error('serde-wire: unterminated `#[serde(`');
    for (const argument of splitArguments(attributes.slice(start, cursor - 1))) {
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(argument);
      if (assignment) {
        const key = assignment[1] as string;
        const value = (assignment[2] as string).trim();
        found.set(key, value.startsWith('"') ? value.slice(1, -1) : value);
      } else {
        found.set(argument, null);
      }
    }
    index = attributes.indexOf(opener, cursor);
  }
  return found;
}


/**
 * The same read, against source text rather than a filename, so the line-ending
 * cases below can be exercised on a fixture instead of on whatever `git` happens
 * to have checked out.
 */
export function parseRustItem(
  source: string,
  keyword: 'enum' | 'struct',
  name: string,
  file = '<fixture>',
): RustItem {
  const declaration = new RegExp(`^pub ${keyword} ${name}\\b[^{\\r\\n]*\\{$`, 'm');
  const at = source.search(declaration);
  if (at < 0) {
    throw new Error(`serde-wire: no \`pub ${keyword} ${name}\` in ${file}`);
  }

  // The attribute block sits between this item's `#[derive(…)]` and its
  // declaration, so slicing back to the last `#[derive` cannot pick up the
  // previous item's serde attribute.
  const head = source.slice(0, at);
  const derive = head.lastIndexOf('#[derive');
  const attributes = derive < 0 ? '' : head.slice(derive);
  const container = serdeArguments(attributes);
  for (const [key] of container) {
    if (!CONTAINER_KEYS.has(key)) {
      throw new Error(
        `serde-wire: ${name} in ${file} carries \`#[serde(${key})]\`, which this ` +
          `parser does not model. Refusing to compare identifiers against wire keys it cannot ` +
          `predict — teach ${'CONTAINER_KEYS'} what it does to the wire, or exclude the type.`,
      );
    }
  }
  const spelled = container.get('rename_all') ?? null;
  if (spelled !== null && !(RENAME_RULES as readonly string[]).includes(spelled)) {
    throw new Error(
      `serde-wire: ${name} in ${file} carries \`rename_all = "${spelled}"\`, a rule ` +
        `this parser does not implement. Reading it as "no rename" would compare the Rust ` +
        `identifiers against the TypeScript list and report agreement serde never produced.`,
    );
  }
  const renameAll: RenameRule = (spelled ?? 'none') as RenameRule;
  const kind: 'variant' | 'field' = keyword === 'enum' ? 'variant' : 'field';
  const tag = container.get('tag') ?? null;

  // Split on either terminator. `git config core.autocrlf` is `true` on Windows
  // and there is no `.gitattributes`, so every line of these files ends `\r\n`
  // in a Windows checkout — `model.rs` measures 798 CRLF and 0 bare LF. Splitting
  // on `'\n'` alone left a `'\r'` on the end of every line, so the column-0 `}`
  // was never found and 28 of this file's 31 cases threw `unterminated`. The
  // declaration regex above matched anyway, which is why the symptom pointed
  // here rather than at the search: JavaScript counts `\r` as a line terminator
  // for `$` under `m`, so `\{$` was satisfied by `{\r`. The guarantee
  // `contract.ts` advertises therefore did not execute on the only machine that
  // builds the product. `the parity parser itself` now pins both endings.
  const lines = source.slice(at).split(/\r?\n/).slice(1);
  const end = lines.indexOf('}');
  if (end < 0) throw new Error(`serde-wire: unterminated ${name} in ${file}`);

  const members: string[] = [];
  let skipNext = false;
  for (const line of lines.slice(0, end)) {
    const text = line.trim();
    if (text.startsWith('//')) continue;
    if (text.startsWith('#[')) {
      // `#[serde(skip)]` — off the wire entirely, so the renderer must not
      // carry it. `skip_serializing_if` is a different attribute: still a
      // field, merely optional, so it must not drop anything.
      //
      // Anything outside `FIELD_KEYS` throws. `rename` and `flatten` are the
      // reason: both sever the identifier from the key, so a parser that reads
      // the identifier and skips the attribute reports a key that provably is
      // not on the wire. Refusing is not a second serde implementation — it is
      // this file declining to answer a question it cannot answer.
      for (const [key] of serdeArguments(text)) {
        const known = FIELD_KEYS.get(key);
        if (known === undefined) {
          throw new Error(
            `serde-wire: a field of ${name} in ${file} carries ` +
              `\`#[serde(${key})]\`, which this parser does not model. The identifier is no ` +
              `longer evidence of the wire key; assert the bytes on the Rust side instead.`,
          );
        }
        if (known === 'drops-the-key') skipNext = true;
      }
      continue;
    }
    const member =
      keyword === 'enum'
        ? /^([A-Z][A-Za-z0-9]*)\s*(?:[,{(]|$)/.exec(text)
        : /^(?:pub(?:\([a-z]+\))?\s+)?([a-z_][a-z0-9_]*)\s*:/.exec(text);
    const captured = member?.[1];
    if (captured === undefined) continue;
    if (skipNext) {
      skipNext = false;
      continue;
    }
    members.push(captured);
  }
  return { members, renameAll, kind, tag };
}

/**
 * Applies the item's own `rename_all`, exactly as serde does — **which is two
 * different transformations under one attribute name**, and that is the trap.
 *
 * Serde reads a variant as PascalCase and a field as snake_case, so a single
 * `rename_all = "camelCase"` means *lowercase the first character* on an enum
 * and *fold each underscore into the letter after it* on a struct. This file
 * carried one implementation for both — a word split on the lowercase-to-
 * uppercase boundary — and got away with it because the two answers agree on
 * every member currently in the tree. They stop agreeing the moment two
 * capitals meet: serde renames `HTTPError` to `hTTPError` under camelCase and
 * to `h_t_t_p_error` under snake_case, where the word split answers
 * `httperror` for both and reports this contract wrong about a name the host
 * really sends. `src/platform/skill-store-parity.test.ts` and
 * `src/platform/project-host-parity.test.ts` already carry the two-rule
 * version — their own first drafts failed on exactly this — and this file was
 * the one left behind.
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
 * names for `parseRustItem` to read, so they cannot be paired by this file at
 * all. `#[serde(transparent)]` newtypes such as `CorrelationId(u64)` and
 * `HarmCategories(u8)` are all of that shape here.
 */
export function scanSerialisable(source: string, file: string): readonly SerialisableItem[] {
  const found: SerialisableItem[] = [];
  for (const match of source.matchAll(/^pub (enum|struct) ([A-Za-z][A-Za-z0-9_]*)\b[^{\r\n]*\{$/gm)) {
    const at = match.index;
    if (at === undefined) continue;
    const head = source.slice(0, at);
    const derive = head.lastIndexOf('#[derive');
    if (derive < 0) continue;
    const attributes = head.slice(derive);
    // The slice reaches back to the *nearest preceding* `#[derive`, which
    // belongs to the previous item when this one has none. Everything between
    // a derive and its own declaration is attribute text, so a line that is
    // neither an attribute, an attribute continuation nor a comment proves the
    // derive belongs to something else.
    const own = attributes
      .split(/\r?\n/)
      .slice(0, -1)
      .every((line) => line.trim() === '' || /^(#\[|\)\]|\s|\/\/)/.test(line));
    if (!own) continue;
    if (!/\bSerialize\b/.test(attributes)) continue;
    found.push({ file, keyword: match[1] as 'enum' | 'struct', rust: match[2] as string });
  }
  return found;
}
