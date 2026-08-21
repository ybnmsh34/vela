/**
 * **The MCP host's vocabulary, pinned to the contract that describes it.**
 *
 * `mcp_list_tools` is the only MCP command in the allowlist and the only one the
 * renderer calls. What it answers with is the vocabulary of two Rust files:
 * `McpFailureCode` from `src-tauri/crates/vela-mcp/src/error.rs`, and
 * `McpToolView`, `McpServerStatus`, `McpServerToolsView` and `McpListToolsRes`
 * from `src-tauri/src/ipc/mcp.rs`. The host serialises those itself, so a
 * variant renamed in Rust reaches a renderer whose closed union never heard of
 * it. This file is the only thing in the tree that compares the two lists.
 *
 * ## The hole this was written to close, named
 *
 * `src/features/mcp/McpPanel.tsx` words every failure reason through a total
 * `Record<McpFailureReason, string>`, and its own header claims the map is
 * total. That claim is only half true without this file, and the half it is
 * missing is the one that matters on a user's screen.
 *
 * A reason added on the **TypeScript** side with no sentence fails
 * `pnpm typecheck`, naming that file. A reason added in **Rust** does not widen
 * the union, so the map stays total, `pnpm typecheck` exits 0, and at runtime the
 * lookup answers `undefined` — the row draws a server id and a blank sentence,
 * which is precisely the silent-reduction failure conventions §9 forbids. Only
 * reading the crate catches that direction, so the crate is read.
 *
 * The same argument covers the three structs, one level cruder: rename a field
 * in Rust and the renderer reads `undefined` off the wire object with no
 * compiler anywhere objecting, because the shape it was cast to is a
 * `declare`d contract and not a measurement.
 *
 * ## The first draft of this file read the Rust spelling and called it the wire
 *
 * It discarded every line beginning `#[` inside an item body, a member's own
 * serde attributes included. Two ordinary one-line edits therefore drifted the
 * wire while this guard stayed green — both measured on this tree against the
 * old parser, and both measured again against the one below:
 *
 *  - `#[serde(rename = "gone")]` on `McpFailureCode::ServerExited`. The host
 *    sends `"gone"`, `REASON_LABELS` in `McpPanel.tsx` has never heard of it,
 *    the lookup answers `undefined`, and the row draws a server id and a blank
 *    sentence — verbatim the failure the section above says this file catches.
 *  - `#[serde(skip)]` on `McpToolView::tool_name`. The field leaves the wire
 *    with the struct's field list unchanged.
 *
 * So the parser no longer discards those lines. It reads the clauses it models
 * and **throws on a clause it does not**, because the defect was not a missing
 * feature — it was a parser that treated what it could not read as nothing to
 * read. What is modelled is written out at {@link memberAttributes} and
 * {@link itemAttributes}; anything else stops this file rather than being
 * stepped over by it.
 *
 * ## What is pinned, and what is not
 *
 * **Name parity, not semantic parity.** That both sides spell `serverExited`,
 * not that both decide when a server has exited. What the crate does with these
 * values is tested in the crate — `a_dead_server_and_a_slow_server_are_different_codes`
 * in `error.rs`, and `the_command_returns_tools_from_a_real_server_process` and
 * `the_response_serialises_in_the_shape_the_typescript_contract_declares` in
 * `mcp.rs` — the last of which is the closest thing that existed to this file
 * before it. Counted in the tree this commit ships, it names six keys of one
 * real `serde_json` serialisation: `configFailure`, `servers`, `serverId`,
 * `status`, `kind` and `reason` — and every one of those six is also pinned
 * below. The overlap is worth being exact about rather than glossed: that test
 * names them against the crate's own expectation and not against
 * `src/platform/contract.ts`, and it runs under `cargo test`, which is not one
 * of the gates the renderer's tests run in.
 *
 * Pinned, each against the reader that would break: the ten failure reasons;
 * the two `McpServerStatus` tags **and the `kind` key they arrive under**,
 * which `toolCatalogueOf` and `unavailableServersOf` both branch on; the fields
 * of `McpToolView`, `McpServerToolsView` and `McpListToolsRes`; and the fields
 * of the struct-bodied variant `McpServerStatus::Unavailable`, which the enum's
 * member list cannot see because a variant's fields are not members of it.
 *
 * Not pinned: `McpToolView.parameters` is `unknown` on this side and `Value` on
 * the other, which is the whole point of it — a JSON Schema written by somebody
 * else's process is not a shape this repo gets to declare. Not pinned either:
 * the *type* of any field, and anything in either Rust file that is not one of
 * the five items named above.
 *
 * ## Why the reader below is a copy
 *
 * `src/platform/skill-store-parity.test.ts` and
 * `src/platform/project-host-parity.test.ts` each carry their own, and say why:
 * exporting one file's test-level helper makes it part of another file's public
 * surface. Both copies still carry the line this one used to —
 * `if (text.startsWith('#[')) continue;`, in `skill-store-parity.test.ts` and
 * in `project-host-parity.test.ts` — and it costs them the same two drifts.
 * Measured here, twice, then reverted by hash: `#[serde(rename = "gone")]` on
 * `SkillProblem::NoSkillFile` in `vela-skills/src/document.rs` and
 * `#[serde(skip)]` on `ProjectPaths::root` in `vela-projects/src/layout.rs`
 * leave those two files passing 29 of 29. That is recorded and not fixed: they
 * are two other contracts with two other owners, and a third rewrite of a
 * parser during a run with seventeen agents live is a merge, not a fix.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type {
  McpFailureReason,
  McpListToolsRes,
  McpServerStatus,
  McpServerTools,
  McpToolView,
} from './contract';

/* -------------------------------------------------------------------------- */
/* the TypeScript half — closed by the compiler                               */
/* -------------------------------------------------------------------------- */

/**
 * Accepts a list only when it names every member of `U` exactly once.
 *
 * Same device as the two sibling parity files, restated rather than shared for
 * the reason the header gives.
 */
function everyVariantOf<U extends string>() {
  return <L extends readonly U[]>(
    list: L &
      ([Exclude<U, L[number]>] extends [never]
        ? unknown
        : ['this list is missing a variant', Exclude<U, L[number]>]),
  ): readonly string[] => list as readonly string[];
}

/** The discriminant values of a tagged union, as the wire spells them. */
type TagsOf<U, T extends PropertyKey> =
  U extends Record<T, infer V> ? (V extends string ? V : never) : never;

const FAILURE_REASON = everyVariantOf<McpFailureReason>()([
  'notConfigured',
  'configUnreadable',
  'configInvalid',
  'transportNotSupported',
  'spawnFailed',
  'handshakeFailed',
  'serverExited',
  'protocolError',
  'timedOut',
  'serverError',
]);

const SERVER_STATUS = everyVariantOf<TagsOf<McpServerStatus, 'kind'>>()([
  'connected',
  'unavailable',
]);

/**
 * What the unavailable arm carries beyond its own tag.
 *
 * `kind` is excluded because it is not a field of the Rust variant at all: it
 * is the key serde adds from `#[serde(tag = "kind")]`, which is pinned on its
 * own a few tests down.
 */
const UNAVAILABLE_FIELDS = everyVariantOf<
  Exclude<keyof Extract<McpServerStatus, { kind: 'unavailable' }>, 'kind'> & string
>()(['reason']);

const TOOL_FIELDS = everyVariantOf<keyof McpToolView & string>()([
  'name',
  'toolName',
  'description',
  'parameters',
]);

const SERVER_FIELDS = everyVariantOf<keyof McpServerTools & string>()([
  'serverId',
  'status',
  'tools',
]);

const RESPONSE_FIELDS = everyVariantOf<keyof McpListToolsRes & string>()([
  'configFailure',
  'servers',
]);

/* -------------------------------------------------------------------------- */
/* the Rust half — read off disk                                              */
/* -------------------------------------------------------------------------- */

const REPO_ROOT = process.cwd();

const SOURCES: Readonly<Record<string, string>> = {
  'error.rs': readFileSync(
    join(REPO_ROOT, 'src-tauri', 'crates', 'vela-mcp', 'src', 'error.rs'),
    'utf8',
  ),
  'mcp.rs': readFileSync(join(REPO_ROOT, 'src-tauri', 'src', 'ipc', 'mcp.rs'), 'utf8'),
};

type RenameRule = 'camelCase' | 'snake_case' | 'none';

interface RustItem {
  /**
   * The members serde actually puts on the wire, in Rust spelling.
   *
   * A member carrying `#[serde(skip)]` or `#[serde(skip_serializing)]` is
   * absent here, because it is absent from the answer the renderer parses.
   */
  readonly members: readonly string[];
  /** Rust spelling to the explicit `#[serde(rename = "…")]` name, where one is given. */
  readonly renames: ReadonlyMap<string, string>;
  readonly renameAll: RenameRule;
  /** The `#[serde(tag = "…")]` key an internally tagged enum arrives under. */
  readonly tag: string | null;
  /** Which of serde's two spellings of the same rule applies. See {@link wireName}. */
  readonly kind: 'variant' | 'field';
}

/**
 * Splits an attribute's argument list on its own top-level commas.
 *
 * `rename = "a", skip` becomes two clauses. Depth and quote state are tracked
 * so that a comma nested inside a clause — `rename(serialize = "a",
 * deserialize = "b")` — or sitting inside a string does not cut one clause into
 * two unreadable halves. That nested form is refused by
 * {@link memberAttributes} either way; tracking depth is what makes it refused
 * with the whole clause in the message instead of half of one.
 */
function clausesOf(inner: string): readonly string[] {
  const found: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (quoted) {
      if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (character === ',' && depth === 0) {
      found.push(inner.slice(start, index).trim());
      start = index + 1;
    }
  }
  found.push(inner.slice(start).trim());
  return found.filter((clause) => clause.length > 0);
}

/**
 * The `#[serde(…)]` clauses on one attribute line, or `null` when it is not one.
 *
 * `#[derive(…)]`, `#[allow(…)]` and a doc attribute cannot change what the host
 * sends, so they answer `null` and are stepped over. `#[cfg(…)]` and
 * `#[cfg_attr(…)]` can add a member, remove one, or attach a serde attribute
 * under a feature, so they throw: this file has no way to know which build the
 * user is running.
 */
function serdeClausesOf(attribute: string, where: string): readonly string[] | null {
  if (/^#\[cfg(_attr)?\b/.test(attribute)) {
    throw new Error(
      `mcp-host-parity: ${where} carries \`${attribute}\`, and a conditional attribute ` +
        'can add, remove or rename a member in a build this file cannot see',
    );
  }
  const serde = /^#\[serde\((.*)\)\]$/.exec(attribute);
  if (serde === null) return null;
  return clausesOf(serde[1] ?? '');
}

/** What a member's own serde attributes do to it. */
interface MemberAttributes {
  /** The name given by `#[serde(rename = "…")]`, which beats the item's rule. */
  readonly rename: string | null;
  /** `#[serde(skip)]` or `#[serde(skip_serializing)]`: it never reaches the wire. */
  readonly skipped: boolean;
}

const NO_MEMBER_ATTRIBUTES: MemberAttributes = { rename: null, skipped: false };

/**
 * Folds one member-level attribute line onto what is already pending.
 *
 * **Modelled: `rename = "…"`, `skip`, `skip_serializing`. Nothing else.** A
 * clause outside that set throws, and that is the correction this file carries:
 * the version that discarded `#[` lines wholesale reported a clean tree for
 * `#[serde(rename = "gone")]` on `McpFailureCode::ServerExited`, which is the
 * exact drift the header says this file exists to catch.
 *
 * `#[serde(alias = "…")]` is left out on purpose rather than by omission. An
 * alias widens what the host will *accept* and changes nothing it sends, so it
 * is arguably harmless here — but "arguably harmless" is a judgement, and a
 * parser that makes one silently is the thing being fixed. Whoever adds one
 * teaches this function and says which direction they measured.
 */
function memberAttributes(
  attribute: string,
  pending: MemberAttributes,
  where: string,
): MemberAttributes {
  const clauses = serdeClausesOf(attribute, where);
  if (clauses === null) return pending;
  let next = pending;
  for (const clause of clauses) {
    const renamed = /^rename\s*=\s*"(.*)"$/.exec(clause);
    if (renamed !== null) {
      next = { rename: renamed[1] ?? '', skipped: next.skipped };
      continue;
    }
    if (clause === 'skip' || clause === 'skip_serializing') {
      next = { rename: next.rename, skipped: true };
      continue;
    }
    throw new Error(
      `mcp-host-parity: a member of ${where} carries \`#[serde(${clause})]\`, which this ` +
        'file does not model — teach it, or the wire is not what this test says it is',
    );
  }
  return next;
}

/**
 * The attribute lines immediately above a declaration.
 *
 * Contiguous upwards from the declaration rather than "everything after the
 * last `#[derive`": the doc comment between the two is prose, and prose that
 * happened to contain the word `serde` would otherwise be read as an attribute.
 * An attribute broken across lines throws rather than being half-read.
 */
function attributeLinesAbove(head: string, where: string): readonly string[] {
  const lines = head.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  const found: string[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const text = (lines[index] ?? '').trim();
    if (!text.startsWith('#[')) break;
    if (!text.endsWith(']')) {
      throw new Error(`mcp-host-parity: ${where} carries a multi-line attribute: ${text}`);
    }
    found.push(text);
  }
  return found;
}

/**
 * The item's own serde attributes.
 *
 * **Modelled: `rename_all = "camelCase" | "snake_case"` and `tag = "…"`.**
 * Anything else throws — `rename_all_fields`, `untagged` and `content` among
 * them, each of which moves names or nesting on the wire. A `rename_all` spelling
 * this file does not implement throws too, rather than falling back to `none`
 * and comparing Rust spellings against wire spellings.
 */
function itemAttributes(head: string, name: string): { renameAll: RenameRule; tag: string | null } {
  let renameAll: RenameRule = 'none';
  let tag: string | null = null;
  for (const attribute of attributeLinesAbove(head, name)) {
    const clauses = serdeClausesOf(attribute, name);
    if (clauses === null) continue;
    for (const clause of clauses) {
      const renamed = /^rename_all\s*=\s*"(.*)"$/.exec(clause);
      if (renamed !== null) {
        const rule = renamed[1];
        if (rule !== 'camelCase' && rule !== 'snake_case') {
          throw new Error(
            `mcp-host-parity: ${name} renames with "${rule ?? ''}", ` +
              'which this file does not implement',
          );
        }
        renameAll = rule;
        continue;
      }
      const tagged = /^tag\s*=\s*"(.*)"$/.exec(clause);
      if (tagged !== null) {
        tag = tagged[1] ?? '';
        continue;
      }
      throw new Error(
        `mcp-host-parity: ${name} carries \`#[serde(${clause})]\`, which this file does not model`,
      );
    }
  }
  return { renameAll, tag };
}

/**
 * Locates one item: the source above it, and the lines of its body.
 *
 * Line-oriented, which is sound because `pnpm verify` chains `pnpm lint:rust`,
 * which runs `cargo fmt --all --check`: every item is rustfmt's shape, one
 * member per line with the closing brace in column 0. The item's own end is
 * found by looking for a line that is exactly `}`, so a nested brace has to be
 * indented for that search to be safe. Measured on this tree: neither Rust file
 * this reads contains a line that is exactly `    },` — `McpServerStatus`'s one
 * struct-bodied variant is written whole on a single line,
 * `Unavailable { reason: McpFailureCode },`, so it opens and closes without ever
 * reaching column 0. The brace-depth counter below and
 * {@link parseVariantFields} both handle the block form as well, because
 * rustfmt would produce it the moment that variant gained a second field.
 *
 * Splitting on `/\r?\n/` rather than `'\n'` is not defensive tidiness: this
 * repository's checkouts on the machine that builds the product have CRLF line
 * endings, and both Rust files this reads are CRLF on disk right now. Splitting
 * on `'\n'` alone leaves a trailing `'\r'` on every line, the column-0 brace is
 * never found, and the guarantee advertised above does not execute.
 */
function itemBody(
  source: string,
  keyword: 'enum' | 'struct',
  name: string,
): { head: string; body: readonly string[] } {
  const declaration = new RegExp(`^pub ${keyword} ${name}\\b[^{\\r\\n]*\\{$`, 'm');
  const at = source.search(declaration);
  if (at < 0) throw new Error(`mcp-host-parity: no \`pub ${keyword} ${name}\``);

  const lines = source.slice(at).split(/\r?\n/).slice(1);
  const end = lines.indexOf('}');
  if (end < 0) throw new Error(`mcp-host-parity: unterminated ${name}`);
  return { head: source.slice(0, at), body: lines.slice(0, end) };
}

/**
 * Reads one `pub enum` / `pub struct` body into the names it puts on the wire.
 *
 * Member attributes are read, not discarded — see {@link memberAttributes} for
 * what is modelled and for the two drifts that got past the version which
 * discarded them. An attribute *inside* a struct-bodied variant is refused
 * outright: those fields are read by {@link parseVariantFields}, which does not
 * model attributes either, and refusing is the difference between this file
 * failing and this file lying.
 */
function parseRustItem(source: string, keyword: 'enum' | 'struct', name: string): RustItem {
  const { head, body } = itemBody(source, keyword, name);
  const { renameAll, tag } = itemAttributes(head, name);

  const members: string[] = [];
  const renames = new Map<string, string>();
  let pending = NO_MEMBER_ATTRIBUTES;
  let depth = 0;
  for (const line of body) {
    const text = line.trim();
    if (text.length === 0) continue;
    if (text.startsWith('//')) continue;
    if (text.startsWith('#[')) {
      if (!text.endsWith(']')) {
        throw new Error(`mcp-host-parity: ${name} carries a multi-line attribute: ${text}`);
      }
      if (depth > 0) {
        throw new Error(
          `mcp-host-parity: \`${text}\` sits inside a struct-bodied variant of ${name}; ` +
            "this file reads a variant's own attributes, not its fields'",
        );
      }
      pending = memberAttributes(text, pending, name);
      continue;
    }
    // Inside a struct-bodied variant the lines are fields, not members. Tracked
    // by brace depth so a field named like a variant cannot be read as one.
    if (depth > 0) {
      depth += (text.match(/\{/g) ?? []).length - (text.match(/\}/g) ?? []).length;
      continue;
    }
    const member =
      keyword === 'enum'
        ? /^([A-Z][A-Za-z0-9]*)\s*(?:[,{(]|$)/.exec(text)
        : /^(?:pub(?:\([a-z]+\))?\s+)?([a-z_][a-z0-9_]*)\s*:/.exec(text);
    const captured = member?.[1];
    if (captured === undefined) {
      pending = NO_MEMBER_ATTRIBUTES;
      continue;
    }
    if (!pending.skipped) {
      members.push(captured);
      if (pending.rename !== null) renames.set(captured, pending.rename);
    }
    depth += (text.match(/\{/g) ?? []).length - (text.match(/\}/g) ?? []).length;
    pending = NO_MEMBER_ATTRIBUTES;
  }
  return { members, renames, renameAll, tag, kind: keyword === 'enum' ? 'variant' : 'field' };
}

/**
 * The field names of one struct-bodied enum variant, in Rust spelling.
 *
 * `unavailableServersOf` in `src/data/mcp-repository.ts` reads
 * `server.status.reason`, so renaming that field in Rust is the same defect as
 * renaming the variant, one level in: `REASON_LABELS[undefined]` and a blank
 * sentence. {@link parseRustItem} cannot see it, because a variant's fields are
 * not members of the enum.
 *
 * The names are compared verbatim, because a container's `rename_all` renames
 * its **variants** and not the fields inside them. Renaming those needs serde's
 * `rename_all_fields` on the enum or a `rename_all` on the variant itself, and
 * {@link itemAttributes} and {@link memberAttributes} respectively throw on
 * each — so this function is never quietly reading the wrong spelling.
 *
 * Reads both shapes rustfmt produces: the whole variant on one line, which is
 * what `Unavailable { reason: McpFailureCode },` is today, and a block with one
 * field per line.
 */
function parseVariantFields(
  source: string,
  enumName: string,
  variant: string,
): readonly string[] {
  const { body } = itemBody(source, 'enum', enumName);

  const at = body.findIndex((line) => new RegExp(`^${variant}\\s*\\{`).test(line.trim()));
  if (at < 0) {
    throw new Error(`mcp-host-parity: ${enumName} has no struct-bodied variant ${variant}`);
  }

  const opening = body[at] ?? '';
  const declarations: string[] = [];
  if (opening.includes('}')) {
    declarations.push(...clausesOf(opening.slice(opening.indexOf('{') + 1, opening.lastIndexOf('}'))));
  } else {
    for (const line of body.slice(at + 1)) {
      const text = line.trim();
      if (text === '},' || text === '}') break;
      if (text.length === 0 || text.startsWith('//')) continue;
      if (text.startsWith('#[')) {
        throw new Error(
          `mcp-host-parity: \`${text}\` sits on a field of ${enumName}::${variant}, ` +
            'which this file does not model',
        );
      }
      declarations.push(text);
    }
  }

  const fields: string[] = [];
  for (const declaration of declarations) {
    const field = /^([a-z_][a-z0-9_]*)\s*:/.exec(declaration);
    const captured = field?.[1];
    if (captured !== undefined) fields.push(captured);
  }
  return fields;
}

function sourceOf(file: string): string {
  const source = SOURCES[file];
  if (source === undefined) throw new Error(`mcp-host-parity: ${file} is not loaded`);
  return source;
}

function readRustItem(file: string, keyword: 'enum' | 'struct', name: string): RustItem {
  return parseRustItem(sourceOf(file), keyword, name);
}

function readVariantFields(file: string, enumName: string, variant: string): readonly string[] {
  return parseVariantFields(sourceOf(file), enumName, variant);
}

/**
 * Applies the item's own serde rename rule, exactly as serde does — **which is
 * two different transformations under one attribute name**, and that is the
 * trap.
 *
 * Serde reads a variant as PascalCase and a field as snake_case, so one
 * `rename_all = "camelCase"` means "lowercase the first character" on an enum
 * and "fold each underscore into the letter after it" on a struct. A single
 * implementation is wrong for one of the two, silently — and this file needs
 * both: `McpFailureCode` is variants, `McpToolView` is fields, and `tool_name`
 * is a multi-word field, which is exactly the case where the two rules disagree.
 * `src/platform/project-host-parity.test.ts` records, in its own header above
 * the same function, that its first draft used the variant rule for everything
 * and reported `ProjectPaths.skills_mount` as the name the host sends.
 */
function wireName(rustName: string, rule: RenameRule, kind: 'variant' | 'field'): string {
  if (rule === 'none') return rustName;
  if (rule === 'camelCase') {
    return kind === 'variant'
      ? rustName.charAt(0).toLowerCase() + rustName.slice(1)
      : rustName.replace(/_([a-z0-9])/g, (_, after: string) => after.toUpperCase());
  }
  if (kind === 'field') return rustName;
  return rustName
    .split('')
    .map((character, index) =>
      character >= 'A' && character <= 'Z'
        ? `${index === 0 ? '' : '_'}${character.toLowerCase()}`
        : character,
    )
    .join('');
}

/** The item's rule, with a member's own `rename` taking precedence, as serde does. */
function wireNames(item: RustItem): readonly string[] {
  return item.members.map(
    (member) => item.renames.get(member) ?? wireName(member, item.renameAll, item.kind),
  );
}

function expectMembers(actual: readonly string[], expected: readonly string[]): void {
  expect(actual.length).toBeGreaterThan(0);
  expect([...actual].sort()).toEqual([...expected].sort());
}

/* -------------------------------------------------------------------------- */

describe('the MCP host and the MCP contract spell the same vocabulary', () => {
  it('agrees on why a server is not serving', () => {
    // The renderer words every one of these, in `src/features/mcp/McpPanel.tsx`.
    // An eleventh reason, or a tenth renamed, is a server the user configured
    // that the pane can say nothing true about — it draws the id and a blank.
    expectMembers(wireNames(readRustItem('error.rs', 'enum', 'McpFailureCode')), FAILURE_REASON);
  });

  it('agrees on whether a server is serving at all', () => {
    // The discriminant `toolCatalogueOf` filters on. Rename `Connected` in Rust
    // and every tool silently leaves the catalogue: the filter matches nothing,
    // a turn is offered no tools, and nothing anywhere is red.
    const status = readRustItem('mcp.rs', 'enum', 'McpServerStatus');
    expectMembers(wireNames(status), SERVER_STATUS);

    // And the key those two values arrive under. `toolCatalogueOf` and
    // `unavailableServersOf` in `src/data/mcp-repository.ts` both branch on
    // `server.status.kind`; retag the enum `#[serde(tag = "type")]` and every
    // status in the answer reads `undefined`, with no compiler objecting,
    // because the shape was declared and not measured. Not the only guard on
    // this one: `the_response_serialises_in_the_shape_the_typescript_contract_declares`
    // in `mcp.rs` asserts on `status["kind"]` too — but it runs under
    // `cargo test` and against the crate's own expectation, not against
    // `src/platform/contract.ts`.
    expect(status.tag).toBe('kind');
  });

  it('agrees on what the unavailable arm carries', () => {
    // `unavailableServersOf` reads `server.status.reason`, and `McpPanel.tsx`
    // draws `REASON_LABELS[server.reason]` from what it finds there. The variant
    // list in the test above cannot see this field: it is inside `Unavailable`,
    // and a variant's fields are not members of the enum.
    expectMembers(
      readVariantFields('mcp.rs', 'McpServerStatus', 'Unavailable'),
      UNAVAILABLE_FIELDS,
    );
  });

  it('agrees on the shape of a tool, a server row and the answer', () => {
    expectMembers(wireNames(readRustItem('mcp.rs', 'struct', 'McpToolView')), TOOL_FIELDS);
    expectMembers(
      wireNames(readRustItem('mcp.rs', 'struct', 'McpServerToolsView')),
      SERVER_FIELDS,
    );
    expectMembers(wireNames(readRustItem('mcp.rs', 'struct', 'McpListToolsRes')), RESPONSE_FIELDS);
  });
});

describe('this guard is not vacuous', () => {
  it('read real items, not empty ones', () => {
    const reason = readRustItem('error.rs', 'enum', 'McpFailureCode');
    // Written out rather than compared against FAILURE_REASON, which would make
    // this control say the same thing as the assertion it is controlling. Ten is
    // what the enum holds at this commit; a parser that read nothing, or read
    // the doc comments between the variants, fails here rather than reporting a
    // clean tree. Changing the enum is meant to send you to both lists.
    expect(reason.members).toHaveLength(10);
    expect(reason.renameAll).toBe('camelCase');
    expect(reason.kind).toBe('variant');
    // No member of it carries a rename or a skip today, which is what makes the
    // list above a plain `rename_all` transformation of the Rust spellings.
    expect(reason.renames.size).toBe(0);
    expect(reason.tag).toBeNull();
    expect(readRustItem('mcp.rs', 'struct', 'McpToolView').kind).toBe('field');
  });

  it('reads a struct-bodied variant as one member and not as its fields', () => {
    // `McpServerStatus::Unavailable` carries a `reason` field. Read as a member
    // that would be a third variant the contract has never heard of, and the
    // comparison would fail for a reason that has nothing to do with drift.
    expect(readRustItem('mcp.rs', 'enum', 'McpServerStatus').members).toEqual([
      'Connected',
      'Unavailable',
    ]);
  });

  it('throws rather than comparing nothing when an item is missing', () => {
    expect(() => readRustItem('error.rs', 'enum', 'NoSuchEnumExists')).toThrow();
    expect(() => readRustItem('client.rs', 'struct', 'McpTool')).toThrow();
    // `Connected` is a unit variant, so asking it for fields is a question with
    // no answer rather than an empty one.
    expect(() => readVariantFields('mcp.rs', 'McpServerStatus', 'Connected')).toThrow();
  });

  it('renames the way serde renames, both of the ways it renames', () => {
    // Variants: PascalCase in, first character lowered, nothing else touched.
    expect(wireName('TransportNotSupported', 'camelCase', 'variant')).toBe(
      'transportNotSupported',
    );
    expect(wireName('ServerExited', 'camelCase', 'variant')).toBe('serverExited');

    // Fields: snake_case in, underscores folded away. The variant rule applied
    // here answers `tool_name`, which is a name the host does not send and is
    // the sibling file's own first-draft defect.
    expect(wireName('tool_name', 'camelCase', 'field')).toBe('toolName');
    expect(wireName('config_failure', 'camelCase', 'field')).toBe('configFailure');
    expect(wireName('servers', 'camelCase', 'field')).toBe('servers');
    expect(wireName('server_id', 'none', 'field')).toBe('server_id');
  });
});

/* -------------------------------------------------------------------------- */
/* controls for the correction: the parser reads a member's own attributes     */
/* -------------------------------------------------------------------------- */

/**
 * A stand-in carrying every attribute the parser models and several it refuses.
 *
 * Synthetic rather than a mutated copy of `error.rs`, because what these tests
 * control is the *parser*, and a control cut from the real file goes stale the
 * moment the real file changes. That the assertions further up then catch the
 * drift on the real files was measured the only way it can be — by editing
 * `error.rs` and `mcp.rs` on disk, watching those `describe` blocks go red, and
 * restoring the bytes. No test can assert that about itself.
 */
const PROBE = `
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProbeReason {
    /// A doc comment, which is not an attribute.
    PlainVariant,
    #[serde(rename = "gone")]
    RenamedVariant,
    #[serde(skip)]
    SkippedVariant,
    #[serde(skip_serializing)]
    UnsentVariant,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeView {
    #[allow(dead_code)]
    pub plain_field: String,
    #[serde(rename = "wire_name")]
    pub renamed_field: String,
    #[serde(skip)]
    pub skipped_field: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProbeStatus {
    Connected,
    Unavailable { reason: ProbeReason, at: String },
}

#[derive(Debug, Serialize)]
pub enum ProbeBlockVariant {
    Unavailable {
        reason: ProbeReason,
        at: String,
    },
}

#[derive(Debug, Serialize)]
pub struct ProbeAliased {
    #[serde(alias = "old")]
    pub current: String,
}

#[derive(Debug, Serialize)]
pub struct ProbeGated {
    #[cfg(feature = "extra")]
    pub sometimes: String,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum ProbeUntagged {
    One,
}
`;

describe('the parser reads what a member says about itself', () => {
  it("takes a member's own rename as the name the host sends", () => {
    // The drift the first draft missed, at parser level: with
    // `#[serde(rename = "gone")]` on `McpFailureCode::ServerExited` the old
    // parser reported `serverExited` — the Rust spelling put through
    // `rename_all` — while the host sent `gone` and `REASON_LABELS['gone']` was
    // `undefined`.
    const item = parseRustItem(PROBE, 'enum', 'ProbeReason');
    expect(item.renames.get('RenamedVariant')).toBe('gone');
    expect(wireNames(item)).toContain('gone');
    expect(wireNames(item)).not.toContain('renamedVariant');

    // And on a struct, where the item's rule is serde's other transformation.
    const view = parseRustItem(PROBE, 'struct', 'ProbeView');
    expect(wireNames(view)).toContain('wire_name');
    expect(wireNames(view)).toContain('plainField');
    expect(wireNames(view)).not.toContain('renamedField');
  });

  it('drops a member serde does not serialise', () => {
    // The second drift: `#[serde(skip)]` on `McpToolView::tool_name` took the
    // field off the wire with the struct's own field list unchanged.
    expect(parseRustItem(PROBE, 'enum', 'ProbeReason').members).toEqual([
      'PlainVariant',
      'RenamedVariant',
    ]);
    expect(parseRustItem(PROBE, 'struct', 'ProbeView').members).toEqual([
      'plain_field',
      'renamed_field',
    ]);
  });

  it('steps over the attributes that cannot change the wire', () => {
    // `#[derive(…)]` above the item and `#[allow(dead_code)]` on a member. If
    // these threw, nothing above could run at all: all five real items carry a
    // derive.
    expect(parseRustItem(PROBE, 'struct', 'ProbeView').members).toContain('plain_field');
    expect(parseRustItem(PROBE, 'enum', 'ProbeStatus').renameAll).toBe('camelCase');
  });

  it('reads the key an internally tagged enum arrives under', () => {
    expect(parseRustItem(PROBE, 'enum', 'ProbeStatus').tag).toBe('kind');
    expect(parseRustItem(PROBE, 'enum', 'ProbeReason').tag).toBeNull();
  });

  it('throws on an attribute it does not model rather than stepping over it', () => {
    // This is the whole correction. The old parser answered "clean" for every
    // one of these; what it produced was not a wrong name, it was a green test.
    expect(() => parseRustItem(PROBE, 'struct', 'ProbeAliased')).toThrow(/does not model/);
    expect(() => parseRustItem(PROBE, 'struct', 'ProbeGated')).toThrow(/conditional attribute/);
    expect(() => parseRustItem(PROBE, 'enum', 'ProbeUntagged')).toThrow(/does not model/);
  });

  it('reads a struct-bodied variant written on one line and written as a block', () => {
    // `McpServerStatus::Unavailable` is the one-line shape today. Both are read,
    // so reformatting the enum does not silently empty the field assertion.
    expect(parseVariantFields(PROBE, 'ProbeStatus', 'Unavailable')).toEqual(['reason', 'at']);
    expect(parseVariantFields(PROBE, 'ProbeBlockVariant', 'Unavailable')).toEqual([
      'reason',
      'at',
    ]);
  });
});
