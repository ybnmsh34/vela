/**
 * **Is `COMMAND_DURABILITY` still true of the host it describes?**
 *
 * `src/platform/incognito-adapter.ts` decides what incognito refuses from a
 * renderer-side table of claims about Rust bodies in `src-tauri/`. That table is
 * the whole of the boundary, and until this file existed nothing checked it.
 * `incognito-adapter.test.ts` proves the wrapper obeys the table; the Rust
 * `rust_and_typescript_allowlists_are_identical` proves the two allowlists hold
 * the same *names*. Neither looks at what a command does.
 *
 * The cost of that gap was measured rather than imagined. **Before this file
 * existed**, reclassifying `schedules_create` from `writes` to `no-write` — and,
 * in a second edit, `secrets_set`, `ui_set_layout` and `sandbox_submit` together
 * — left the entire suite green, twice each. Four durable writers, one of them a
 * credential going into the platform keychain, would have been forwarded to the
 * host by a window telling the user nothing was being kept, and no test could
 * see it. Both mutations redden here now.
 *
 * ## What this file does
 *
 * Every command carries an {@link Evidence} row citing a **chain of Rust
 * symbols**, ending in the bytes that do the durable thing (or that prove there
 * is none). The test then holds all three parties to each other:
 *
 * 1. **The citation is real.** Each link's file is read, the named `fn` is found
 *    (uniquely, with `#[cfg(test)]` cut off first), its body is brace-matched,
 *    and the quoted `contains` string has to be in it. A citation that has gone
 *    stale fails here rather than being believed.
 * 2. **The chain is connected.** Link *k*'s `contains` has to name link *k+1*'s
 *    symbol, so the rows are one path through the host rather than three
 *    unrelated true facts about it.
 * 3. **The durability is derived, not restated.** The row names an
 *    {@link EffectKind}; the kind decides `no-write` / `erases` / `writes`, and
 *    for the kinds with a primitive vocabulary the terminal `contains` must be
 *    one of that kind's markers. Only then is the result compared with
 *    `COMMAND_DURABILITY`.
 *
 * So flipping a row in `COMMAND_DURABILITY` fails, and flipping a row here fails
 * too unless the Rust actually says what the new row claims.
 *
 * ## What this file does NOT do, said plainly
 *
 * It does not prove that a `no-write` command writes nothing anywhere in its
 * transitive call graph. That was tried first and it is not sound here: Rust
 * function names collide across the workspace, and a walk that unions the
 * candidates goes to the wrong place.
 *
 * The counts, with the counting rule stated, because the first version of this
 * paragraph said "definitions" and left two different numbers both defensible.
 * Scanning `src-tauri/src` together with the `src` directory of every crate
 * under `src-tauri/crates` — 12 such roots, 124 `.rs` files below them,
 * recursively — and cutting each file at its first `\n#[cfg(test)]` as
 * {@link hostSource} does, the occurrences of `fn <name>` as a whole word are:
 * `fn get` 16, `fn delete` 8, `fn list` 8, `fn set` 6, `fn status` 6,
 * `fn create` 3. Some of those are trait declarations, which end in `;` and have
 * no body for {@link bodyOf} to brace-match; counting only the ones with a body,
 * the same six are 14, 7, 7, 5, 6, 3. Both sets are re-measured on the tree this
 * sentence is committed in. The argument needs neither exact set — only that
 * each is greater than one.
 *
 * A prototype walk that resolved by name resolved `schedules_create` into
 * `ipc::project::create`, `secrets_set` into `ipc::ui::set`, and
 * `sandbox_submit` — through `spawn`, which has two definitions, and `take`,
 * which has one in the wrong module — into `vela-store`'s `delete_project`.
 * Every one of those is wrong, and each looked like an answer. A guard built on
 * that would be confidently wrong, which is worse than a guard that says what
 * it covers.
 *
 * What the `in-process` and `off-machine` kinds do instead is bounded:
 * **none of the cited bodies may contain any marker in
 * {@link DURABLE_MARKERS}**, and the chain must be at least two links long.
 *
 * **What the two-link rule does and does not stop, measured rather than
 * asserted.** It stops a row satisfying the absence check by citing a thin
 * `#[tauri::command]` adapter and stopping — a one-link chain fails outright.
 * It does **not** stop the same trick one shim deeper, and the earlier wording
 * here claimed it did.
 *
 * Measured, twice, on this tree: declare `secrets_set` `in-process` over
 * `secrets_set` → `ipc::secrets::set`, and `sandbox_submit` `in-process` over
 * `sandbox_submit` → `host::submit`, flip both rows of `COMMAND_DURABILITY` to
 * `no-write` to match, and **every check in this section passes on both rows** —
 * both citations are truthful, both chains are two links, and neither cited body
 * holds a marker in {@link DURABLE_MARKERS}. Meanwhile a credential still
 * reaches the platform keychain through `store.set(`, one call past the last
 * body this file reads.
 *
 * What reddened instead was the size pin below: `× pins the two numbers the
 * header quotes for its own open hole — update the header: rows resting on
 * absence: expected 19 to be 17`, by that name in both runs (whole suite
 * `2683 passed | 1 failed (2684)` on the second; on the first, one further
 * unrelated app test timed out at 5000ms and passed again on the rerun, so that
 * run read `2682 passed | 2 failed`). That is worth exactly what it is. The pin
 * does not follow
 * the call graph and cannot; it makes *growing the set of claims resting on
 * absence* a thing that has to be admitted in this paragraph, so the mutation
 * costs a second edit in a second place rather than none. A mutant willing to
 * edit this file can edit the number too.
 *
 * Two things follow. First, the honest name for this guard's coverage is a
 * **reviewed path**, not a call graph — which is what the rest of this header
 * already said and what the sentence above now stops contradicting. Second, the
 * hole is only reachable by editing this file at all: the mutation is a rewrite
 * of the evidence rows, not a change to shipped code, and every reclassification
 * of `COMMAND_DURABILITY` alone reddens here by name. Closing it properly needs
 * the terminal link forced out of the `src-tauri/src/ipc` adapter layer and into
 * the implementing crate, which today would demand a new citation for 12 of the
 * 17 rows resting on absence; it is written down as open rather than half-done.
 *
 * Two kinds — `guest-process` and `fail-closed` — are conservative by
 * construction: they may only ever produce `writes`, and each must say why in
 * `why`. They exist because `sandbox_submit`'s durable effect is a command
 * running in the user's workspace rather than a marker in Rust, and because
 * `sandbox_report_document`'s host body is empty today and must not become
 * silently writable in incognito if that changes.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { COMMAND_ALLOWLIST, type CommandName } from './contract';
import { COMMAND_DURABILITY, type CommandDurability } from './incognito-adapter';

/* -------------------------------------------------------------------------- */
/* reading the host                                                           */
/* -------------------------------------------------------------------------- */

// From the repo root, as `adapter-parity.test.ts` and `case-collision.test.ts`
// do: under jsdom `import.meta.url` is an http: URL served by Vite, not a file:
// one.
const REPO_ROOT = process.cwd();

const WORD_CHARACTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_';

function isWordCharacter(character: string): boolean {
  return character !== '' && WORD_CHARACTERS.includes(character);
}

/**
 * One Rust file, with its `#[cfg(test)]` module cut off.
 *
 * Not tidiness: `project.rs` defines `layout_of` twice — once for real and once
 * on a test double — and a citation that could land on either would be a
 * citation of nothing in particular.
 */
function hostSource(relativePath: string): string {
  const text = readFileSync(join(REPO_ROOT, ...relativePath.split('/')), 'utf8');
  const tests = text.indexOf('\n#[cfg(test)]');
  return tests === -1 ? text : text.slice(0, tests);
}

/**
 * The brace-matched body of `fn <symbol>` in a Rust file.
 *
 * Skips string literals, char literals and comments while matching, because a
 * `format!("{}")` inside a body would otherwise close it early. Throws — rather
 * than answering an empty string — when the symbol is missing or ambiguous, so
 * a stale citation cannot pass a `contains` check by having nothing to check.
 */
function bodyOf(relativePath: string, symbol: string): string {
  const source = hostSource(relativePath);
  const needle = `fn ${symbol}`;
  const found: string[] = [];

  for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + 1)) {
    if (isWordCharacter(source.charAt(at + needle.length))) continue;
    if (isWordCharacter(source.charAt(at - 1))) continue;

    const open = source.indexOf('{', at);
    const semicolon = source.indexOf(';', at);
    // A trait declaration (`fn thing(..) -> T;`) has no body to cite.
    if (open === -1 || (semicolon !== -1 && semicolon < open)) continue;

    found.push(source.slice(open, closingBrace(source, open) + 1));
  }

  if (found.length === 0) {
    throw new Error(`${relativePath} has no \`fn ${symbol}\` outside its test module`);
  }
  if (found.length > 1) {
    throw new Error(
      `${relativePath} defines \`fn ${symbol}\` ${found.length} times; cite a file where it is unique`,
    );
  }
  return found[0] as string;
}

function closingBrace(source: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < source.length) {
    const character = source.charAt(index);
    if (character === '"') {
      index = endOfStringLiteral(source, index);
      continue;
    }
    if (character === "'") {
      // A lifetime (`'a`) is not a literal; a char literal closes within four.
      const close = source.indexOf("'", index + 1);
      if (close !== -1 && close - index <= 3) index = close;
    } else if (character === '/' && source.charAt(index + 1) === '/') {
      const line = source.indexOf('\n', index);
      index = line === -1 ? source.length : line;
      continue;
    } else if (character === '/' && source.charAt(index + 1) === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 1;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  throw new Error('unbalanced braces while reading a Rust body');
}

function endOfStringLiteral(source: string, quote: number): number {
  let index = quote + 1;
  while (index < source.length) {
    const character = source.charAt(index);
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '"') return index + 1;
    index += 1;
  }
  return source.length;
}

/* -------------------------------------------------------------------------- */
/* the vocabulary                                                             */
/* -------------------------------------------------------------------------- */

/**
 * How a command's terminal link leaves the machine changed, and what that makes
 * it in `COMMAND_DURABILITY`.
 *
 * `markers` is the closed vocabulary a terminal `contains` may be drawn from, so
 * a row cannot declare `sqlite-select` over a body that says `INSERT INTO`. The
 * two kinds with an empty `markers` list are the ones checked by absence
 * instead; the two `conservative` kinds are checked by review, and may only ever
 * mean `writes`.
 */
interface Effect {
  readonly durability: CommandDurability;
  readonly markers: readonly string[];
  /** Absence of every {@link DURABLE_MARKERS} entry across the whole chain. */
  readonly provenByAbsence?: true;
  /** Cannot be derived from bytes; requires `why` and may only mean `writes`. */
  readonly conservative?: true;
}

const EFFECTS = {
  'sqlite-insert': { durability: 'writes', markers: ['INSERT INTO', 'INSERT OR'] },
  'sqlite-update': { durability: 'writes', markers: ['UPDATE '] },
  'sqlite-delete': { durability: 'erases', markers: ['DELETE FROM'] },
  'sqlite-select': { durability: 'no-write', markers: ['SELECT '] },
  'fs-create': {
    durability: 'writes',
    markers: ['fs::create_dir_all', 'create_dir_all(', 'File::create', 'fs::write'],
  },
  'keychain-write': { durability: 'writes', markers: ['set_password('] },
  'keychain-delete': { durability: 'erases', markers: ['delete_credential('] },
  'keychain-read': { durability: 'no-write', markers: ['get_password('] },
  'debug-log-sink': { durability: 'writes', markers: ['debuglog::enable('] },
  'in-process': { durability: 'no-write', markers: [], provenByAbsence: true },
  'off-machine': { durability: 'no-write', markers: [], provenByAbsence: true },
  'guest-process': { durability: 'writes', markers: [], conservative: true },
  'fail-closed': { durability: 'writes', markers: [], conservative: true },
} as const satisfies Readonly<Record<string, Effect>>;

type EffectKind = keyof typeof EFFECTS;

/**
 * Widened to {@link Effect} on the way out.
 *
 * `as const satisfies` above is what gives {@link EffectKind} its exact key
 * union, and it also narrows each value to its own literal type — so indexing
 * `EFFECTS` directly puts `conservative` out of reach on the rows that do not
 * carry it, and turns an empty `markers` list into `never[]`.
 */
function effectOf(kind: EffectKind): Effect {
  return EFFECTS[kind];
}

/**
 * What a body doing any of these to **this machine** is doing durably.
 *
 * Used only for the absence check on `in-process` and `off-machine` rows. It is
 * a list of primitives observed in this tree, not a closed account of every way
 * a Rust program can write to a disk — see the header.
 */
const DURABLE_MARKERS: readonly string[] = [
  'INSERT INTO',
  'INSERT OR',
  'UPDATE ',
  'DELETE FROM',
  'fs::create_dir_all',
  'create_dir_all(',
  'File::create',
  'fs::write',
  'set_password(',
  'delete_credential(',
  'debuglog::enable(',
];

interface Link {
  /** Repo-relative path of a Rust file. */
  readonly file: string;
  /** A `fn` in it, which must be unique there once tests are cut off. */
  readonly symbol: string;
  /** A string that must appear in that function's body. */
  readonly contains: string;
}

interface Evidence {
  readonly command: CommandName;
  readonly effect: EffectKind;
  readonly chain: readonly Link[];
  /** Required by the conservative kinds; allowed as a note on any row. */
  readonly why?: string;
}

const IPC = 'src-tauri/src/ipc';
const SQLITE = 'src-tauri/crates/vela-store/src/sqlite.rs';
const KEYRING = 'src-tauri/crates/vela-secrets/src/keyring_store.rs';
const SETTINGS_SERVICE = 'src-tauri/crates/vela-settings/src/service.rs';
const SANDBOX_HOST = 'src-tauri/crates/vela-sandbox/src/host.rs';

/* -------------------------------------------------------------------------- */
/* the evidence                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One row per command in the contract, each citing the host bytes its
 * classification was read off.
 *
 * Ordered as `COMMAND_ALLOWLIST` is, so the two can be diffed by eye.
 */
const EVIDENCE: readonly Evidence[] = [
  {
    command: 'app_info',
    effect: 'in-process',
    chain: [
      { file: `${IPC}/app.rs`, symbol: 'app_info', contains: 'app_info_of(' },
      { file: `${IPC}/app.rs`, symbol: 'app_info_of', contains: 'state.secrets.backend()' },
    ],
  },
  {
    command: 'chat_cancel',
    effect: 'in-process',
    chain: [
      { file: `${IPC}/chat.rs`, symbol: 'chat_cancel', contains: 'turns.cancel(' },
      { file: `${IPC}/chat.rs`, symbol: 'cancel', contains: 'token.cancel()' },
    ],
  },
  {
    command: 'chat_send',
    effect: 'off-machine',
    chain: [
      { file: `${IPC}/chat.rs`, symbol: 'chat_send', contains: 'run_turn(' },
      { file: `${IPC}/chat.rs`, symbol: 'run_turn', contains: 'router.stream(' },
    ],
    why: 'The turn leaves the machine and nothing on the reviewed path records it here. What the endpoint keeps is limit 1 of the four the adapter header states.',
  },
  {
    command: 'diagnostics_debug_log_get',
    effect: 'in-process',
    chain: [
      {
        file: `${IPC}/diagnostics.rs`,
        symbol: 'diagnostics_debug_log_get',
        contains: 'debug_log_get(',
      },
      { file: `${IPC}/diagnostics.rs`, symbol: 'debug_log_get', contains: 'status_of(' },
      { file: `${IPC}/diagnostics.rs`, symbol: 'status_of', contains: 'debuglog::is_enabled()' },
    ],
  },
  {
    command: 'diagnostics_debug_log_set',
    effect: 'debug-log-sink',
    chain: [
      {
        file: `${IPC}/diagnostics.rs`,
        symbol: 'diagnostics_debug_log_set',
        contains: 'debug_log_set(',
      },
      { file: `${IPC}/diagnostics.rs`, symbol: 'debug_log_set', contains: 'debug_log_set_with(' },
      {
        file: `${IPC}/diagnostics.rs`,
        symbol: 'debug_log_set_with',
        contains: 'debuglog::enable(',
      },
    ],
    why: 'The sink this arms records the raw upstream request and response bodies to a file. It is the one command whose misclassification would make the whole mode a lie.',
  },
  {
    command: 'diagnostics_echo',
    effect: 'in-process',
    chain: [
      { file: `${IPC}/diagnostics.rs`, symbol: 'diagnostics_echo', contains: 'echo(' },
      { file: `${IPC}/diagnostics.rs`, symbol: 'echo', contains: 'received_at_ms' },
    ],
  },
  {
    command: 'endpoint_disable',
    effect: 'in-process',
    chain: [
      { file: `${IPC}/endpoint.rs`, symbol: 'endpoint_disable', contains: 'disable(' },
      { file: `${IPC}/endpoint.rs`, symbol: 'disable', contains: 'control.disable()' },
      { file: 'src-tauri/src/endpoint_host.rs', symbol: 'disable', contains: 'EndpointState::Off' },
    ],
  },
  {
    command: 'endpoint_enable',
    effect: 'in-process',
    chain: [
      { file: `${IPC}/endpoint.rs`, symbol: 'endpoint_enable', contains: 'enable(' },
      { file: `${IPC}/endpoint.rs`, symbol: 'enable', contains: 'control.enable(' },
      {
        file: 'src-tauri/src/endpoint_host.rs',
        symbol: 'enable',
        contains: 'bind(&self.providers, wanted)',
      },
    ],
  },
  {
    command: 'endpoint_status',
    effect: 'in-process',
    chain: [
      { file: `${IPC}/endpoint.rs`, symbol: 'endpoint_status', contains: 'status(' },
      { file: `${IPC}/endpoint.rs`, symbol: 'status', contains: 'control.report()' },
    ],
  },
  {
    command: 'mcp_list_tools',
    effect: 'in-process',
    chain: [
      { file: `${IPC}/mcp.rs`, symbol: 'mcp_list_tools', contains: 'list_tools(' },
      { file: `${IPC}/mcp.rs`, symbol: 'list_tools', contains: 'list_all_tools()' },
    ],
    why: 'Nothing on the reviewed path writes here, but the pool it reads starts the user’s own configured programs, and what those write is limit 2 of the four the adapter header states.',
  },
  {
    command: 'memory_add',
    effect: 'sqlite-insert',
    chain: [
      { file: `${IPC}/memory.rs`, symbol: 'memory_add', contains: 'add(' },
      { file: `${IPC}/memory.rs`, symbol: 'add', contains: 'create_memory_entry(' },
      { file: SQLITE, symbol: 'create_memory_entry', contains: 'INSERT INTO' },
    ],
  },
  {
    command: 'memory_clear_scope',
    effect: 'sqlite-delete',
    chain: [
      { file: `${IPC}/memory.rs`, symbol: 'memory_clear_scope', contains: 'clear(' },
      { file: `${IPC}/memory.rs`, symbol: 'clear', contains: 'clear_memory_scope(' },
      { file: SQLITE, symbol: 'clear_memory_scope', contains: 'DELETE FROM' },
    ],
  },
  {
    command: 'memory_delete',
    effect: 'sqlite-delete',
    chain: [
      { file: `${IPC}/memory.rs`, symbol: 'memory_delete', contains: 'delete(' },
      { file: `${IPC}/memory.rs`, symbol: 'delete', contains: 'delete_memory_entry(' },
      { file: SQLITE, symbol: 'delete_memory_entry', contains: 'DELETE FROM' },
    ],
  },
  {
    command: 'memory_list',
    effect: 'sqlite-select',
    chain: [
      { file: `${IPC}/memory.rs`, symbol: 'memory_list', contains: 'list(' },
      { file: `${IPC}/memory.rs`, symbol: 'list', contains: 'list_memory_entries(' },
      { file: SQLITE, symbol: 'list_memory_entries', contains: 'SELECT ' },
    ],
  },
  {
    command: 'memory_update',
    effect: 'sqlite-update',
    chain: [
      { file: `${IPC}/memory.rs`, symbol: 'memory_update', contains: 'update(' },
      { file: `${IPC}/memory.rs`, symbol: 'update', contains: 'update_memory_entry(' },
      { file: SQLITE, symbol: 'update_memory_entry', contains: 'UPDATE ' },
    ],
  },
  {
    command: 'models_capabilities',
    effect: 'in-process',
    chain: [
      { file: `${IPC}/models.rs`, symbol: 'models_capabilities', contains: 'capabilities(' },
      {
        file: `${IPC}/models.rs`,
        symbol: 'capabilities',
        contains: '.get(provider_id, model_id)',
      },
    ],
  },
  {
    command: 'models_list',
    effect: 'off-machine',
    chain: [
      { file: `${IPC}/models.rs`, symbol: 'models_list', contains: 'listing_result(' },
      { file: `${IPC}/models.rs`, symbol: 'listing_result', contains: 'enumerated' },
    ],
  },
  {
    command: 'models_probe',
    effect: 'in-process',
    chain: [
      { file: `${IPC}/models.rs`, symbol: 'models_probe', contains: 'cache.put(' },
      { file: `${IPC}/models.rs`, symbol: 'put', contains: 'self.lock().insert(' },
    ],
    why: 'The mirror image of the three that read like reads: this one reads like a write and is not. `CapabilityCache` is Tauri `State` over a `Mutex<HashMap>` and dies with the process.',
  },
  {
    command: 'project_create',
    effect: 'sqlite-insert',
    chain: [
      { file: `${IPC}/project.rs`, symbol: 'project_create', contains: 'create(' },
      { file: `${IPC}/project.rs`, symbol: 'create', contains: 'create_project(' },
      { file: SQLITE, symbol: 'create_project', contains: 'INSERT INTO' },
    ],
  },
  {
    command: 'project_delete',
    effect: 'sqlite-delete',
    chain: [
      { file: `${IPC}/project.rs`, symbol: 'project_delete', contains: 'delete(' },
      { file: `${IPC}/project.rs`, symbol: 'delete', contains: 'delete_project_reassigning(' },
      { file: SQLITE, symbol: 'delete_project_reassigning', contains: 'DELETE FROM' },
    ],
    why: 'The terminal body also runs `UPDATE conversations SET project_id`, which the erase-may-not-write check below reports. It is disclosed rather than hidden: the reassignment re-files rows that already existed onto the sentinel default project, so the command still leaves less behind than it found and records nothing about the session. Deleting is allowed in incognito because a mode that stopped you removing things would be a strange kind of privacy.',
  },
  {
    command: 'project_get',
    effect: 'sqlite-select',
    chain: [
      { file: `${IPC}/project.rs`, symbol: 'project_get', contains: 'get(' },
      { file: `${IPC}/project.rs`, symbol: 'get', contains: 'get_project(' },
      { file: SQLITE, symbol: 'get_project', contains: 'fetch_project(' },
      { file: SQLITE, symbol: 'fetch_project', contains: 'SELECT ' },
    ],
  },
  {
    command: 'project_layout',
    effect: 'fs-create',
    chain: [
      { file: `${IPC}/project.rs`, symbol: 'project_layout', contains: 'layout(' },
      { file: `${IPC}/project.rs`, symbol: 'layout', contains: 'layout_of(' },
      { file: `${IPC}/project.rs`, symbol: 'layout_of', contains: 'resolve_layout(' },
      {
        file: 'src-tauri/crates/vela-projects/src/layout.rs',
        symbol: 'resolve_layout',
        contains: 'fs::create_dir_all',
      },
    ],
    why: 'A name that reads as a query. Its host body materialises the workspace and the skills mount, so classifying it from the name would have let incognito create directories.',
  },
  {
    command: 'project_list',
    effect: 'sqlite-select',
    chain: [
      { file: `${IPC}/project.rs`, symbol: 'project_list', contains: 'list(' },
      { file: `${IPC}/project.rs`, symbol: 'list', contains: 'list_projects(' },
      { file: SQLITE, symbol: 'list_projects', contains: 'SELECT ' },
    ],
  },
  {
    command: 'project_move_conversation',
    effect: 'sqlite-update',
    chain: [
      {
        file: `${IPC}/project.rs`,
        symbol: 'project_move_conversation',
        contains: 'move_conversation(',
      },
      { file: `${IPC}/project.rs`, symbol: 'move_conversation', contains: 'update_conversation(' },
      { file: SQLITE, symbol: 'update_conversation', contains: 'UPDATE ' },
    ],
  },
  {
    command: 'project_reconcile_skills',
    effect: 'fs-create',
    chain: [
      { file: `${IPC}/project.rs`, symbol: 'project_reconcile_skills', contains: 'layout(' },
      { file: `${IPC}/project.rs`, symbol: 'layout', contains: 'layout_of(' },
      { file: `${IPC}/project.rs`, symbol: 'layout_of', contains: 'resolve_layout(' },
      {
        file: 'src-tauri/crates/vela-projects/src/layout.rs',
        symbol: 'resolve_layout',
        contains: 'fs::create_dir_all',
      },
    ],
    why: 'The same host body as `project_layout`, under a second name. Both create.',
  },
  {
    command: 'project_update',
    effect: 'sqlite-update',
    chain: [
      { file: `${IPC}/project.rs`, symbol: 'project_update', contains: 'update(' },
      { file: `${IPC}/project.rs`, symbol: 'update', contains: 'update_project(' },
      { file: SQLITE, symbol: 'update_project', contains: 'UPDATE ' },
    ],
  },
  {
    command: 'sandbox_approve',
    effect: 'guest-process',
    chain: [
      { file: `${IPC}/sandbox.rs`, symbol: 'sandbox_approve', contains: '.approve(' },
      { file: SANDBOX_HOST, symbol: 'approve', contains: 'control.decision = Some(' },
    ],
    why: 'An approval is not itself a write; it is what releases an already-submitted command to run in the project workspace, and that command writes whatever it writes. Classified `writes` so incognito cannot be the thing that lets one through.',
  },
  {
    command: 'sandbox_cancel',
    effect: 'in-process',
    chain: [
      { file: `${IPC}/sandbox.rs`, symbol: 'sandbox_cancel', contains: '.cancel(' },
      { file: SANDBOX_HOST, symbol: 'cancel', contains: 'kill_child(' },
    ],
  },
  {
    command: 'sandbox_policy',
    effect: 'in-process',
    chain: [
      { file: `${IPC}/sandbox.rs`, symbol: 'sandbox_policy', contains: '.policy()' },
      { file: SANDBOX_HOST, symbol: 'policy', contains: 'SandboxPolicySnapshot {' },
    ],
  },
  {
    command: 'sandbox_release',
    effect: 'in-process',
    chain: [
      { file: `${IPC}/sandbox.rs`, symbol: 'sandbox_release', contains: '.release(' },
      { file: SANDBOX_HOST, symbol: 'release', contains: 'control.released = true' },
    ],
  },
  {
    command: 'sandbox_report_document',
    effect: 'fail-closed',
    chain: [
      {
        file: `${IPC}/sandbox.rs`,
        symbol: 'sandbox_report_document',
        contains: '.report_document(',
      },
      { file: SANDBOX_HOST, symbol: 'report_document', contains: '' },
    ],
    why: 'The host body is empty: this build accepts no document run, so every report is about a run that does not exist and is dropped. There is therefore no durable effect to cite, and the row is `writes` by decision — a renderer-to-host report about a sandbox run must not become quietly forwardable in incognito the day the host starts keeping them.',
  },
  {
    command: 'sandbox_submit',
    effect: 'guest-process',
    chain: [
      { file: `${IPC}/sandbox.rs`, symbol: 'sandbox_submit', contains: '.submit(' },
      { file: SANDBOX_HOST, symbol: 'submit', contains: 'host.drive(' },
      { file: SANDBOX_HOST, symbol: 'drive', contains: 'self.execute(' },
      { file: SANDBOX_HOST, symbol: 'execute', contains: 'command.spawn()' },
    ],
    why: 'The durable effect is not a marker in Rust: it is the submitted program running with the project workspace as its working directory, free to write there. The chain ends at the spawn so the claim is about bytes rather than about a memory of the design.',
  },
  {
    command: 'schedules_create',
    effect: 'sqlite-insert',
    chain: [
      { file: `${IPC}/schedules.rs`, symbol: 'schedules_create', contains: 'create(' },
      { file: `${IPC}/schedules.rs`, symbol: 'create', contains: 'create_schedule(' },
      { file: SQLITE, symbol: 'create_schedule', contains: 'INSERT INTO' },
    ],
  },
  {
    command: 'schedules_delete',
    effect: 'sqlite-delete',
    chain: [
      { file: `${IPC}/schedules.rs`, symbol: 'schedules_delete', contains: 'delete(' },
      { file: `${IPC}/schedules.rs`, symbol: 'delete', contains: 'delete_schedule(' },
      { file: SQLITE, symbol: 'delete_schedule', contains: 'DELETE FROM' },
    ],
  },
  {
    command: 'schedules_list',
    effect: 'sqlite-select',
    chain: [
      { file: `${IPC}/schedules.rs`, symbol: 'schedules_list', contains: 'list(' },
      { file: `${IPC}/schedules.rs`, symbol: 'list', contains: 'list_schedules(' },
      { file: SQLITE, symbol: 'list_schedules', contains: 'SELECT ' },
    ],
  },
  {
    command: 'schedules_list_runs',
    effect: 'sqlite-select',
    chain: [
      { file: `${IPC}/schedules.rs`, symbol: 'schedules_list_runs', contains: 'list_runs(' },
      { file: `${IPC}/schedules.rs`, symbol: 'list_runs', contains: 'list_schedule_runs(' },
      { file: SQLITE, symbol: 'list_schedule_runs', contains: 'SELECT ' },
    ],
  },
  {
    command: 'schedules_set_enabled',
    effect: 'sqlite-update',
    chain: [
      { file: `${IPC}/schedules.rs`, symbol: 'schedules_set_enabled', contains: 'set_enabled(' },
      { file: `${IPC}/schedules.rs`, symbol: 'set_enabled', contains: 'update_schedule(' },
      { file: SQLITE, symbol: 'update_schedule', contains: 'UPDATE ' },
    ],
  },
  {
    command: 'secrets_delete',
    effect: 'keychain-delete',
    chain: [
      { file: `${IPC}/secrets.rs`, symbol: 'secrets_delete', contains: 'delete(' },
      { file: `${IPC}/secrets.rs`, symbol: 'delete', contains: 'store.delete(' },
      { file: KEYRING, symbol: 'delete', contains: 'delete_credential(' },
    ],
  },
  {
    command: 'secrets_set',
    effect: 'keychain-write',
    chain: [
      { file: `${IPC}/secrets.rs`, symbol: 'secrets_set', contains: 'set(' },
      { file: `${IPC}/secrets.rs`, symbol: 'set', contains: 'store.set(' },
      { file: KEYRING, symbol: 'set', contains: 'set_password(' },
    ],
    why: 'A credential going into the platform keychain — Credential Manager on this machine. One of the four the mutation pass reclassified with the whole suite green.',
  },
  {
    command: 'secrets_status',
    effect: 'keychain-read',
    chain: [
      { file: `${IPC}/secrets.rs`, symbol: 'secrets_status', contains: 'status(' },
      { file: `${IPC}/secrets.rs`, symbol: 'status', contains: 'store.contains(' },
      { file: KEYRING, symbol: 'contains', contains: 'self.get(reference)' },
      { file: KEYRING, symbol: 'get', contains: 'get_password()' },
    ],
  },
  {
    command: 'settings_delete_provider',
    effect: 'sqlite-delete',
    chain: [
      {
        file: `${IPC}/settings.rs`,
        symbol: 'settings_delete_provider',
        contains: 'delete_provider(',
      },
      { file: `${IPC}/settings.rs`, symbol: 'delete_provider', contains: '.delete_provider(' },
      { file: SETTINGS_SERVICE, symbol: 'delete_provider', contains: 'delete_setting(' },
      { file: SQLITE, symbol: 'delete_setting', contains: 'DELETE FROM' },
    ],
  },
  {
    command: 'settings_get',
    effect: 'sqlite-select',
    chain: [
      { file: `${IPC}/settings.rs`, symbol: 'settings_get', contains: 'get(' },
      { file: `${IPC}/settings.rs`, symbol: 'get', contains: '.snapshot()' },
      { file: SETTINGS_SERVICE, symbol: 'snapshot', contains: '.providers()' },
      { file: SETTINGS_SERVICE, symbol: 'providers', contains: 'list_settings(' },
      { file: SQLITE, symbol: 'list_settings', contains: 'SELECT ' },
    ],
  },
  {
    command: 'settings_put_provider',
    effect: 'sqlite-insert',
    chain: [
      { file: `${IPC}/settings.rs`, symbol: 'settings_put_provider', contains: 'put_provider(' },
      { file: `${IPC}/settings.rs`, symbol: 'put_provider', contains: 'service.put_provider(' },
      { file: SETTINGS_SERVICE, symbol: 'put_provider', contains: 'put_setting(' },
      { file: SQLITE, symbol: 'put_setting', contains: 'INSERT INTO' },
    ],
  },
  {
    command: 'settings_set_theme',
    effect: 'sqlite-insert',
    chain: [
      { file: `${IPC}/settings.rs`, symbol: 'settings_set_theme', contains: 'set_theme(' },
      { file: `${IPC}/settings.rs`, symbol: 'set_theme', contains: '.set_theme(' },
      { file: SETTINGS_SERVICE, symbol: 'set_theme', contains: 'put_setting(' },
      { file: SQLITE, symbol: 'put_setting', contains: 'INSERT INTO' },
    ],
    why: 'The one refusal a user meets by accident. `use-theme.ts` treats `INCOGNITO_REFUSED` as "not kept, as promised" rather than reverting.',
  },
  {
    command: 'skills_list',
    effect: 'in-process',
    chain: [
      { file: `${IPC}/skills.rs`, symbol: 'skills_list', contains: 'list_skills(' },
      { file: `${IPC}/skills.rs`, symbol: 'list_skills', contains: 'store.list()' },
    ],
  },
  {
    command: 'skills_read',
    effect: 'in-process',
    chain: [
      { file: `${IPC}/skills.rs`, symbol: 'skills_read', contains: 'read_skill(' },
      { file: `${IPC}/skills.rs`, symbol: 'read_skill', contains: 'store.header(' },
    ],
  },
  {
    command: 'store_append_message',
    effect: 'sqlite-insert',
    chain: [
      {
        file: `${IPC}/transcript.rs`,
        symbol: 'store_append_message',
        contains: 'append_message(',
      },
      { file: `${IPC}/transcript.rs`, symbol: 'append_message', contains: 'store.append_message(' },
      { file: SQLITE, symbol: 'append_message', contains: 'INSERT INTO' },
    ],
  },
  {
    command: 'store_autotitle_conversation',
    effect: 'sqlite-update',
    chain: [
      { file: `${IPC}/store.rs`, symbol: 'store_autotitle_conversation', contains: 'autotitle(' },
      { file: `${IPC}/store.rs`, symbol: 'autotitle', contains: 'update_conversation(' },
      { file: SQLITE, symbol: 'update_conversation', contains: 'UPDATE ' },
    ],
    why: 'Called by `conversations-repository.ts` on its own, without any surface asking. The writer a call-site flag would miss.',
  },
  {
    command: 'store_create_conversation',
    effect: 'sqlite-insert',
    chain: [
      { file: `${IPC}/store.rs`, symbol: 'store_create_conversation', contains: 'create(' },
      { file: `${IPC}/store.rs`, symbol: 'create', contains: 'create_conversation(' },
      { file: SQLITE, symbol: 'create_conversation', contains: 'INSERT INTO' },
    ],
  },
  {
    command: 'store_delete_conversation',
    effect: 'sqlite-delete',
    chain: [
      { file: `${IPC}/store.rs`, symbol: 'store_delete_conversation', contains: 'delete(' },
      { file: `${IPC}/store.rs`, symbol: 'delete', contains: 'delete_conversation(' },
      { file: SQLITE, symbol: 'delete_conversation', contains: 'DELETE FROM' },
    ],
  },
  {
    command: 'store_delete_message',
    effect: 'sqlite-delete',
    chain: [
      { file: `${IPC}/transcript.rs`, symbol: 'store_delete_message', contains: 'delete_message(' },
      { file: `${IPC}/transcript.rs`, symbol: 'delete_message', contains: 'store.delete_message(' },
      { file: SQLITE, symbol: 'delete_message', contains: 'DELETE FROM' },
    ],
  },
  {
    command: 'store_list_conversations',
    effect: 'sqlite-select',
    chain: [
      { file: `${IPC}/store.rs`, symbol: 'store_list_conversations', contains: 'list(' },
      { file: `${IPC}/store.rs`, symbol: 'list', contains: 'list_conversations(' },
      { file: SQLITE, symbol: 'list_conversations', contains: 'SELECT ' },
    ],
  },
  {
    command: 'store_list_messages',
    effect: 'sqlite-select',
    chain: [
      { file: `${IPC}/transcript.rs`, symbol: 'store_list_messages', contains: 'list_messages(' },
      { file: `${IPC}/transcript.rs`, symbol: 'list_messages', contains: '.list_messages(' },
      { file: SQLITE, symbol: 'list_messages', contains: 'SELECT ' },
    ],
  },
  {
    command: 'store_rename_conversation',
    effect: 'sqlite-update',
    chain: [
      { file: `${IPC}/store.rs`, symbol: 'store_rename_conversation', contains: 'rename(' },
      { file: `${IPC}/store.rs`, symbol: 'rename', contains: 'update_conversation(' },
      { file: SQLITE, symbol: 'update_conversation', contains: 'UPDATE ' },
    ],
  },
  {
    command: 'store_search',
    effect: 'sqlite-select',
    chain: [
      { file: `${IPC}/store.rs`, symbol: 'store_search', contains: 'search(' },
      { file: `${IPC}/store.rs`, symbol: 'search', contains: 'search_conversations(' },
      { file: SQLITE, symbol: 'search_conversations', contains: 'SELECT ' },
    ],
  },
  {
    command: 'store_update_message',
    effect: 'sqlite-update',
    chain: [
      { file: `${IPC}/transcript.rs`, symbol: 'store_update_message', contains: 'update_message(' },
      { file: `${IPC}/transcript.rs`, symbol: 'update_message', contains: 'store.update_message(' },
      { file: SQLITE, symbol: 'update_message', contains: 'UPDATE ' },
    ],
  },
  {
    command: 'ui_get_layout',
    effect: 'sqlite-select',
    chain: [
      { file: `${IPC}/ui.rs`, symbol: 'ui_get_layout', contains: 'get(' },
      { file: `${IPC}/ui.rs`, symbol: 'get', contains: 'store.get_setting(' },
      { file: SQLITE, symbol: 'get_setting', contains: 'fetch_setting(' },
      { file: SQLITE, symbol: 'fetch_setting', contains: 'SELECT ' },
    ],
  },
  {
    command: 'ui_set_layout',
    effect: 'sqlite-insert',
    chain: [
      { file: `${IPC}/ui.rs`, symbol: 'ui_set_layout', contains: 'set(' },
      { file: `${IPC}/ui.rs`, symbol: 'set', contains: 'store.put_setting(' },
      { file: SQLITE, symbol: 'put_setting', contains: 'INSERT INTO' },
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* the checks                                                                 */
/* -------------------------------------------------------------------------- */

const BY_COMMAND = new Map(EVIDENCE.map((row) => [row.command, row]));

describe('every command carries evidence, and the evidence is complete', () => {
  it('reads the allowlist it is quantifying over, so two empty lists cannot agree', () => {
    // `declared-commands.ts` states the rule. Without this the sweeps below
    // would pass over nothing.
    expect(COMMAND_ALLOWLIST.length).toBeGreaterThan(50);
    expect(COMMAND_ALLOWLIST).toContain('secrets_set');
  });

  it('cites a host body for every command in the contract', () => {
    const uncited = COMMAND_ALLOWLIST.filter((command) => !BY_COMMAND.has(command));
    expect(
      uncited,
      'a new command needs a row here naming the Rust body its classification was read off',
    ).toEqual([]);
  });

  it('cites nothing that is not a command, and cites nothing twice', () => {
    const allowed = new Set<string>(COMMAND_ALLOWLIST);
    expect(EVIDENCE.filter((row) => !allowed.has(row.command)).map((row) => row.command)).toEqual(
      [],
    );
    expect(BY_COMMAND.size).toBe(EVIDENCE.length);
  });
});

describe('each citation is a claim about bytes in src-tauri, and the bytes are checked', () => {
  it.each(EVIDENCE.map((row) => [row.command, row] as const))(
    '%s cites host bodies that say what it says',
    (_command, row) => {
      row.chain.forEach((link, index) => {
        const body = bodyOf(link.file, link.symbol);
        expect(
          body.includes(link.contains),
          `${link.file} \`fn ${link.symbol}\` no longer contains ${JSON.stringify(link.contains)}`,
        ).toBe(true);

        const next = row.chain[index + 1];
        if (next !== undefined) {
          expect(
            link.contains.includes(next.symbol),
            `the chain breaks: \`${link.symbol}\` is not shown calling \`${next.symbol}\``,
          ).toBe(true);
        }
      });
    },
  );

  it.each(EVIDENCE.map((row) => [row.command, row] as const))(
    '%s draws its terminal evidence from its effect kind’s vocabulary',
    (_command, row) => {
      const effect: Effect = effectOf(row.effect);
      const terminal = row.chain[row.chain.length - 1];
      expect(terminal, 'a row with no links cites nothing').toBeDefined();
      if (effect.markers.length === 0) return;
      expect(
        effect.markers.some((marker) => (terminal as Link).contains.includes(marker)),
        `\`${row.effect}\` may only be claimed over one of ${effect.markers.join(', ')}`,
      ).toBe(true);
    },
  );
});

describe('the classification is derived from the evidence, not restated beside it', () => {
  it.each(EVIDENCE.map((row) => [row.command, row] as const))(
    'COMMAND_DURABILITY agrees with what %s’s host body does',
    (command, row) => {
      expect(
        COMMAND_DURABILITY[command],
        `the host evidence for \`${command}\` says ${effectOf(row.effect).durability}`,
      ).toBe(effectOf(row.effect).durability);
    },
  );

  it('leaves no command in the table without a derived twin', () => {
    // The whole-table form of the row-by-row check above, so a row deleted from
    // EVIDENCE cannot take its assertion with it.
    const derived = Object.fromEntries(
      EVIDENCE.map((row) => [row.command, effectOf(row.effect).durability]),
    );
    expect(derived).toEqual(
      Object.fromEntries(COMMAND_ALLOWLIST.map((command) => [command, COMMAND_DURABILITY[command]])),
    );
  });
});

describe('the claims that would leak are the ones checked hardest', () => {
  const notWritten = EVIDENCE.filter((row) => effectOf(row.effect).provenByAbsence === true);

  it('has some rows resting on absence, so the sweep below is not empty', () => {
    expect(notWritten.length).toBeGreaterThan(5);
  });

  it('pins the two numbers the header quotes for its own open hole', () => {
    // The header says the absence sweep would need a new citation for 12 of the
    // 17 rows before a terminal link could be forced out of the `ipc` adapter
    // layer. Numbers in prose rot; this is the same two numbers, derived, so a
    // new `no-write` command cannot move them without someone re-reading the
    // paragraph that quotes them.
    const insideIpc = notWritten.filter((row) =>
      (row.chain[row.chain.length - 1] as Link).file.startsWith(`${IPC}/`),
    );
    expect(notWritten.length, 'update the header: rows resting on absence').toBe(17);
    expect(insideIpc.length, 'update the header: of those, terminating inside ipc').toBe(12);
  });

  it.each(notWritten.map((row) => [row.command, row] as const))(
    '%s: no cited body on the reviewed path touches durable state',
    (_command, row) => {
      // The direction that leaks. A command wrongly called `no-write` is
      // forwarded to the host by a window promising nothing is being kept, so
      // this asks the harder question of exactly those rows.
      const offenders: string[] = [];
      for (const link of row.chain) {
        const body = bodyOf(link.file, link.symbol);
        for (const marker of DURABLE_MARKERS) {
          if (body.includes(marker)) offenders.push(`${link.symbol} does ${marker.trim()}`);
        }
      }
      expect(offenders, 'this cannot be `no-write`; reclassify it from the host body').toEqual([]);
    },
  );

  it.each(notWritten.map((row) => [row.command, row] as const))(
    '%s cites more than the thin command adapter',
    (_command, row) => {
      // A one-link chain would satisfy the absence check by citing the
      // `#[tauri::command]` wrapper, which delegates and therefore says nothing.
      expect(row.chain.length).toBeGreaterThanOrEqual(2);
    },
  );

  it.each(
    EVIDENCE.filter((row) => effectOf(row.effect).conservative === true).map(
      (row) => [row.command, row] as const,
    ),
  )('%s is conservative by construction and says why', (_command, row) => {
    expect(effectOf(row.effect).durability).toBe('writes');
    expect((row.why ?? '').length, 'a kind that cannot be derived must be argued').toBeGreaterThan(
      40,
    );
  });

  it('reports every `erases` row whose host body also writes', () => {
    // `erases` is allowed through incognito, so a row that also modifies rows is
    // an edge somebody has to have looked at. It is not automatically wrong —
    // `project_delete` re-files its conversations onto the default project on
    // the way out — but it has to be argued in `why` rather than passed over.
    const writesToo = EVIDENCE.filter((row) => effectOf(row.effect).durability === 'erases').filter(
      (row) => {
        const terminal = row.chain[row.chain.length - 1] as Link;
        const body = bodyOf(terminal.file, terminal.symbol);
        const own = effectOf(row.effect).markers;
        return DURABLE_MARKERS.filter((marker) => !own.includes(marker)).some((marker) =>
          body.includes(marker),
        );
      },
    );
    // The floor, and it names the row rather than counting. Without it this
    // check goes silent the day its detector stops detecting — an empty
    // `writesToo` runs no assertion at all and reports success. `project_delete`
    // is the row that exists to be found: its terminal link is
    // `delete_project_reassigning`, whose body holds `UPDATE ` — a marker that
    // is not one of `sqlite-delete`'s own.
    expect(
      writesToo.map((row) => row.command),
      'the erase-and-also-writes check found nothing, so its `why` demand asserted nothing',
    ).toContain('project_delete');

    for (const row of writesToo) {
      expect(
        (row.why ?? '').length,
        `\`${row.command}\` erases and also writes; say why that is still an erase`,
      ).toBeGreaterThan(40);
    }
  });
});
