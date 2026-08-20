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
 * ## What is pinned, and what is not
 *
 * **Name parity, not semantic parity.** That both sides spell `serverExited`,
 * not that both decide when a server has exited. What the crate does with these
 * values is tested in the crate — `a_dead_server_and_a_slow_server_are_different_codes`
 * in `error.rs`, and `the_command_returns_tools_from_a_real_server_process` and
 * `the_response_serialises_in_the_shape_the_typescript_contract_declares` in
 * `mcp.rs`, the last of which checks three field names against a real
 * serialisation and is the closest thing that existed to this file before it.
 *
 * Not pinned: `McpToolView.parameters` is `unknown` on this side and `Value` on
 * the other, which is the whole point of it — a JSON Schema written by somebody
 * else's process is not a shape this repo gets to declare.
 *
 * ## Why the reader below is a copy
 *
 * `src/platform/skill-store-parity.test.ts` and
 * `src/platform/project-host-parity.test.ts` each carry their own, and say why:
 * exporting one file's test-level helper makes it part of another file's public
 * surface. Every trap the copy has to survive is documented at
 * {@link wireName}, and every one of them was found by the two files above
 * getting it wrong first.
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
  /** Variant names for an enum, field names for a struct — Rust spelling. */
  readonly members: readonly string[];
  readonly renameAll: RenameRule;
  /** Which of serde's two spellings of the same rule applies. See {@link wireName}. */
  readonly kind: 'variant' | 'field';
}

/**
 * Reads one `pub enum` / `pub struct` body.
 *
 * Line-oriented, which is sound because `cargo fmt --check` runs in
 * `pnpm verify`: every item is rustfmt's shape, one member per line with the
 * closing brace in column 0. A struct-bodied enum variant closes on `    },`,
 * which is not column 0, so the search for the item's own end is not confused by
 * one — and `McpServerStatus` has exactly that shape, so it is not hypothetical
 * here.
 *
 * Splitting on `/\r?\n/` rather than `'\n'` is not defensive tidiness: this
 * repository's checkouts on the machine that builds the product have CRLF line
 * endings, and both Rust files this reads are CRLF on disk right now. Splitting
 * on `'\n'` alone leaves a trailing `'\r'` on every line, the column-0 brace is
 * never found, and the guarantee advertised above does not execute.
 */
function parseRustItem(source: string, keyword: 'enum' | 'struct', name: string): RustItem {
  const declaration = new RegExp(`^pub ${keyword} ${name}\\b[^{\\r\\n]*\\{$`, 'm');
  const at = source.search(declaration);
  if (at < 0) throw new Error(`mcp-host-parity: no \`pub ${keyword} ${name}\``);

  const head = source.slice(0, at);
  const derive = head.lastIndexOf('#[derive');
  const attributes = derive < 0 ? '' : head.slice(derive);
  const rename = /rename_all\s*=\s*"(camelCase|snake_case)"/.exec(attributes);
  const renameAll: RenameRule = rename ? (rename[1] as RenameRule) : 'none';

  const lines = source.slice(at).split(/\r?\n/).slice(1);
  const end = lines.indexOf('}');
  if (end < 0) throw new Error(`mcp-host-parity: unterminated ${name}`);

  const members: string[] = [];
  let depth = 0;
  for (const line of lines.slice(0, end)) {
    const text = line.trim();
    if (text.startsWith('//')) continue;
    if (text.startsWith('#[')) continue;
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
    if (captured === undefined) continue;
    members.push(captured);
    depth += (text.match(/\{/g) ?? []).length - (text.match(/\}/g) ?? []).length;
  }
  return { members, renameAll, kind: keyword === 'enum' ? 'variant' : 'field' };
}

function readRustItem(file: string, keyword: 'enum' | 'struct', name: string): RustItem {
  const source = SOURCES[file];
  if (source === undefined) throw new Error(`mcp-host-parity: ${file} is not loaded`);
  return parseRustItem(source, keyword, name);
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
 * `src/platform/project-host-parity.test.ts` really did ship the one-rule
 * version and reported a field name the host does not send.
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

function wireNames(item: RustItem): readonly string[] {
  return item.members.map((member) => wireName(member, item.renameAll, item.kind));
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
    expectMembers(wireNames(readRustItem('mcp.rs', 'enum', 'McpServerStatus')), SERVER_STATUS);
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
