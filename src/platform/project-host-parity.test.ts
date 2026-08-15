/**
 * **The project host that actually answers, pinned to the contract that
 * describes it.**
 *
 * `src/platform/contract-project.ts` says of itself that `pnpm typecheck` holds
 * every shape in it and that this is the whole of the automatic enforcement.
 * Across the bridge that is not enough by half: the host serialises its own
 * enums, so a variant renamed in Rust reaches a renderer whose closed union
 * never heard of it, the exhaustive `switch` falls through, and the user is
 * shown the wrong sentence — or none — about a skill they switched on.
 *
 * ## Which crate this reads, and why that is the point
 *
 * `src/platform/skill-mount-parity.test.ts` pins the same vocabulary against
 * `src-tauri/crates/vela-skills/`. That crate's `mount` module is not what runs:
 * `src-tauri/src/ipc/skills.rs` says no command calls it. The implementation
 * behind `project_layout` and `project_reconcile_skills` is
 * `src-tauri/crates/vela-projects/`, and until this file nothing pinned its wire
 * names and nothing read its Windows branch. Two crates spelling one vocabulary
 * is the seam, so **both** are pinned rather than one, and this file is the one
 * that reads the code the user's machine runs.
 *
 * ## Three things are held here, and they fail differently
 *
 * 1. **Wire names.** A Rust variant added or renamed without its TypeScript twin
 *    fails at `pnpm test`; a TypeScript variant added without its Rust twin
 *    fails at `pnpm typecheck`, because every list below goes through
 *    {@link everyVariantOf}, which is assignable only when it covers its union
 *    exactly. There is no order in which a one-sided change is green.
 * 2. **The Windows link branch.** "Vela does not use symlinks on Windows at all,
 *    ever, even when they would succeed" is a sentence about code, not a type.
 *    {@link windowsLinkCallsIn} reads the live crate's Windows branch, and the
 *    behavioural half — asking the volume what tag it actually stored — is in
 *    that crate, in `link.rs`.
 * 3. **The removal ledger.** Every removal of anything a *project* owns goes
 *    through `vela_projects::remove_tree`, which asks `is_reparse_point` before
 *    it descends. AMENDMENT 8 pins the exceptions at exactly six and says where
 *    they are, precisely because "every removal goes through it" is the claim a
 *    seventh gets written under. {@link REMOVAL_LEDGER} is that count, and a
 *    seventh direct removal anywhere in the crate fails here on arrival —
 *    "anywhere" meaning every `.rs` file {@link rustFilesUnder} finds under the
 *    crate's `src/`, including ones added after this file was written, because
 *    the sentence was first written over a hand-kept list of five and was false
 *    for exactly the file a new removal would arrive in.
 *
 * Plus two one-line facts with nowhere else to live: that the two length limits
 * carry the same **value** on both sides — the unit is argued in the contract
 * and held by both suites, the number was held by neither — and that the
 * renderer really has no filesystem capability, which is the fact the whole
 * private-workspace Writes/Reads boundary is argued from.
 *
 * **Name parity, not semantic parity.** That both sides have a `copied` arm, not
 * that both compute staleness the same way. What the crate does with these
 * values is tested in the crate, against real directories.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type {
  LinkFallbackReason,
  LinkStrategy,
  ProjectDirectory,
  ProjectLayout,
  ProjectPaths,
  SkillLinkKind,
  SkillMount,
  SkillMountProblem,
  SkillMountStatus,
  WorkingDirectory,
  WorkingDirectoryBinding,
  WorkingDirectoryProblem,
} from './contract-project';
import type { ProjectCommandName } from './contract-project';
import {
  PROJECT_COMMAND_NAMES,
  PROJECT_INSTRUCTIONS_MAX_CHARS,
  PROJECT_NAME_MAX_CHARS,
} from './contract-project';

/* -------------------------------------------------------------------------- */
/* the TypeScript half — closed by the compiler                               */
/* -------------------------------------------------------------------------- */

/**
 * Accepts a list only when it names every member of `U` exactly once.
 *
 * The same device `src/platform/chat-contract-parity.test.ts` and
 * `src/platform/skill-mount-parity.test.ts` each carry, restated here for the
 * reason the second of those gives: exporting it would make one file's
 * type-level helper part of another file's public surface, and it is nine lines.
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

const SKILL_LINK_KIND = everyVariantOf<SkillLinkKind>()(['symlink', 'junction']);

const LINK_FALLBACK_REASON = everyVariantOf<LinkFallbackReason>()([
  'filesystemDoesNotSupportLinks',
  'junctionRefused',
  'probeFailed',
]);

const LINK_STRATEGY = everyVariantOf<TagsOf<LinkStrategy, 'kind'>>()([
  'symlink',
  'junction',
  'copy',
]);

const SKILL_MOUNT_PROBLEM = everyVariantOf<SkillMountProblem>()([
  'skillNotFound',
  'nameIsNotASinglePathSegment',
  'pathTooLong',
  'occupiedByUnrelatedEntry',
  'nameCollidesWithAnotherEnabledSkill',
  'permissionDenied',
]);

const SKILL_MOUNT_STATUS = everyVariantOf<TagsOf<SkillMountStatus, 'kind'>>()([
  'linked',
  'copied',
  'unavailable',
]);

const SKILL_MOUNT_FIELDS = everyVariantOf<keyof SkillMount & string>()([
  'name',
  'source',
  'status',
]);

const PROJECT_DIRECTORY = everyVariantOf<ProjectDirectory>()(['root', 'workspace', 'skillsMount']);

const PROJECT_PATHS_FIELDS = everyVariantOf<keyof ProjectPaths & string>()([
  'root',
  'workspace',
  'skillsMount',
  'skillStore',
]);

const PROJECT_LAYOUT_FIELDS = everyVariantOf<keyof ProjectLayout & string>()([
  'projectId',
  'paths',
  'linkStrategy',
  'workingDirectory',
  'mounts',
  'repaired',
]);

const WORKING_DIRECTORY_PROBLEM = everyVariantOf<WorkingDirectoryProblem>()([
  'notFound',
  'notADirectory',
  'permissionDenied',
  'volumeUnavailable',
]);

const WORKING_DIRECTORY = everyVariantOf<TagsOf<WorkingDirectory, 'kind'>>()([
  'none',
  'bound',
  'unavailable',
]);

const WORKING_DIRECTORY_BINDING = everyVariantOf<TagsOf<WorkingDirectoryBinding, 'kind'>>()([
  'none',
  'path',
]);

/* -------------------------------------------------------------------------- */
/* the Rust half — read off disk                                              */
/* -------------------------------------------------------------------------- */

const CRATE = join(process.cwd(), 'src-tauri', 'crates', 'vela-projects', 'src');

/**
 * Every `.rs` file in the crate, **found on disk rather than listed here**.
 *
 * This was a hand-written list of the five files that existed when the file was
 * written, and {@link REMOVAL_LEDGER} said of itself that a seventh removal
 * "anywhere in the crate" failed here. It did not: a removal in a file nobody
 * had added to the list — `lib.rs`, or a module written next week — was
 * invisible to the scan, and the ledger stayed green. The doc claimed the reach
 * of a directory read while the code had the reach of a literal, which is the
 * shape this repository keeps finding, so the code is given the reach instead.
 *
 * Recursive, because a crate that grows a `src/windows/` module should not
 * quietly leave the ledger behind, and sorted so a failure lists files in an
 * order that does not depend on the filesystem. Names are relative to `src/`
 * with `/` separators, so `readRustItem('link.rs', …)` still names a file the
 * way a reader would.
 *
 * The crate has no `tests/` directory. If one is added it is deliberately still
 * out of scope, for the reason {@link removalsIn} gives for cutting `mod tests`.
 */
function rustFilesUnder(directory: string, prefix: string, found: string[]): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) rustFilesUnder(join(directory, entry.name), name, found);
    else if (entry.isFile() && entry.name.endsWith('.rs')) found.push(name);
  }
  return found;
}

const CRATE_FILES: readonly string[] = rustFilesUnder(CRATE, '', []).sort();

const SOURCES: Readonly<Record<string, string>> = Object.fromEntries(
  CRATE_FILES.map((file) => [file, readFileSync(join(CRATE, ...file.split('/')), 'utf8')]),
);

type RenameRule = 'camelCase' | 'snake_case' | 'none';

interface RustItem {
  /** Variant names for an enum, field names for a struct — Rust spelling. */
  readonly members: readonly string[];
  readonly renameAll: RenameRule;
  /**
   * Which of serde's two spellings of the same rule applies. Not decoration:
   * see {@link wireName}.
   */
  readonly kind: 'variant' | 'field';
}

/**
 * Reads one `pub enum` / `pub struct` body.
 *
 * Line-oriented, which is sound because `cargo fmt --check` runs in
 * `pnpm verify`: every item is rustfmt's shape, one member per line with the
 * closing brace in column 0. A struct-bodied enum variant closes on `    },`,
 * which is not column 0, so the search for the item's own end is not confused by
 * one.
 *
 * Splitting on `/\r?\n/` rather than `'\n'` is not tidiness. Windows checkouts
 * of this repository have CRLF endings, and the two sibling parity tests both
 * record what splitting on `'\n'` alone did there: a trailing `'\r'` on every
 * line, the column-0 brace never found, and the guarantee advertised here not
 * executing on the only machine that builds the product.
 */
function parseRustItem(source: string, keyword: 'enum' | 'struct', name: string): RustItem {
  const declaration = new RegExp(`^pub ${keyword} ${name}\\b[^{\\r\\n]*\\{$`, 'm');
  const at = source.search(declaration);
  if (at < 0) throw new Error(`project-host-parity: no \`pub ${keyword} ${name}\``);

  const head = source.slice(0, at);
  const derive = head.lastIndexOf('#[derive');
  const attributes = derive < 0 ? '' : head.slice(derive);
  const rename = /rename_all\s*=\s*"(camelCase|snake_case)"/.exec(attributes);
  const renameAll: RenameRule = rename ? (rename[1] as RenameRule) : 'none';

  const lines = source.slice(at).split(/\r?\n/).slice(1);
  const end = lines.indexOf('}');
  if (end < 0) throw new Error(`project-host-parity: unterminated ${name}`);

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
  if (source === undefined) throw new Error(`project-host-parity: ${file} is not loaded`);
  return parseRustItem(source, keyword, name);
}

/**
 * Applies the item's own `rename_all`, exactly as serde does — **which is two
 * different transformations under one attribute name**, and that is the trap.
 *
 * Serde reads a variant as PascalCase and a field as snake_case, so one
 * `rename_all = "camelCase"` means "lowercase the first character" on an enum
 * and "fold each underscore into the letter after it" on a struct. A single
 * implementation is wrong for one of the two, silently: this file's first draft
 * used the variant rule for everything and reported `ProjectPaths.skills_mount`
 * as the name the host sends, which would have made a real disagreement
 * unnoticeable behind a fake one. The sibling
 * `src/platform/skill-mount-parity.test.ts` has the one-rule version and gets
 * away with it only because every struct field it reads is a single word.
 *
 * Within the variant rule there is a second trap the sibling file records
 * failing on: the intuitive reading — split on the lowercase-to-uppercase
 * boundary — is not serde's, and the two disagree the moment two capitals meet.
 * Serde sends `nameIsNotASinglePathSegment`; the word split answers
 * `nameIsNotAsinglePathSegment` and reports this contract as wrong about a name
 * the host really sends.
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

/**
 * Every call to a link-creating API in a region of the source that a
 * `#[cfg(windows)]` line opens — **which is a superset of the Windows branches,
 * deliberately, and the doc used to claim it was exactly them.**
 *
 * A line that is exactly `#[cfg(windows)]` after trimming opens the region; the
 * region closes at the next column-0 `}`. That is not the same as "the item the
 * attribute is on", and the difference is visible in the very file this reads:
 * the `#[cfg(windows)]` above `const NATIVE_LINK_STRATEGY` is on a `const`,
 * which ends at a semicolon and never at a column-0 brace, so the region runs on
 * through the `#[cfg(not(windows))]` twin below it and through all of
 * `create_link` — including that function's non-Windows arm — before closing.
 *
 * That is left as it is rather than tightened, because the direction it errs in
 * is the safe one for the only thing asked of it. The assertion is that the
 * result is **empty**; scanning more source than advertised can add a call to
 * that list and can never remove one, so an over-wide region fails loudly on
 * code that was innocent and cannot pass code that was not. A region narrowed to
 * the true item span would need a Rust parser, and getting *that* subtly wrong
 * fails in the direction where a symlink call is not seen at all.
 *
 * Two more things it does, said rather than implied. Comment lines are dropped
 * first, so a module header may discuss `std::os::windows::fs::symlink_dir` —
 * and this crate's does — without the discussion counting as a call. And only
 * the literal `#[cfg(windows)]` spelling opens a region: `#[cfg(all(test,
 * windows))]` and `#[cfg(target_os = "windows")]` do not, which is why the
 * vacuity block asserts the crate has no code hidden behind the second spelling.
 */
function windowsLinkCallsIn(source: string): readonly string[] {
  const found: string[] = [];
  let inWindowsItem = false;
  for (const line of source.split(/\r?\n/)) {
    const text = line.trim();
    if (text.startsWith('//')) continue;
    if (/^#\[cfg\(windows\)\]$/.test(text)) {
      inWindowsItem = true;
      continue;
    }
    if (inWindowsItem) {
      for (const call of ['symlink_dir', 'symlink_file', 'soft_link']) {
        if (new RegExp(`\\b${call}\\s*\\(`).test(text)) found.push(call);
      }
      if (line === '}') inWindowsItem = false;
    }
  }
  return found;
}

/* -------------------------------------------------------------------------- */
/* the removal ledger                                                         */
/* -------------------------------------------------------------------------- */

/**
 * **Every direct filesystem removal in the crate, and the function it is in.**
 *
 * Three are `remove_tree`'s own body — the guard itself, which unlinks a reparse
 * point and descends only where there is none. The other six are the exceptions
 * AMENDMENT 8 counts: four in the case-folding probe, taking out the probe
 * directory it made two lines earlier, and two unwinding a half-made junction
 * when the reparse write is refused. Every one of them removes a directory the
 * same function created moments before and knows the whole contents of, and none
 * of them can be pointed at a mount.
 *
 * The contract writes the last two as being in `create_link`; in the source they
 * are in the Windows helper `create_link` delegates to on Windows, which is the
 * same two removals under a name one level down.
 *
 * A seventh entry here is the thing the contract's paragraph is addressed to: a
 * fresh recursive delete on a project root takes every skill on the machine
 * rather than one project's view of them, and it is green on arrival because the
 * two tests that hold the rule bind the one call site that exists.
 */
const REMOVAL_LEDGER: readonly string[] = [
  'casefold.rs::probe',
  'casefold.rs::probe',
  'casefold.rs::probe',
  'casefold.rs::probe',
  'link.rs::create',
  'link.rs::create',
  'link.rs::remove_tree',
  'link.rs::remove_tree',
  'link.rs::remove_tree',
];

const FUNCTION_DECLARATION =
  /^\s*(?:pub(?:\([a-z()]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([a-z_][a-z0-9_]*)/;

const REMOVAL_CALL = /\bfs::remove_(?:dir_all|dir|file)\s*\(/;

/**
 * The crate's removals, as `file::function`, with the test modules excluded.
 *
 * Test modules are cut because a test that arranges a directory and takes it
 * apart again is not a removal of anything a project owns — and including them
 * would make this ledger churn every time somebody writes a test, which is how a
 * guard comes to be edited without being read.
 */
function removalsIn(file: string): readonly string[] {
  const source = SOURCES[file] ?? '';
  const testModule = source.search(/^\s*mod tests \{$/m);
  const body = testModule < 0 ? source : source.slice(0, testModule);

  const found: string[] = [];
  let enclosing = '<none>';
  for (const line of body.split(/\r?\n/)) {
    if (line.trim().startsWith('//')) continue;
    const declared = FUNCTION_DECLARATION.exec(line);
    if (declared?.[1] !== undefined) enclosing = declared[1];
    if (REMOVAL_CALL.test(line)) found.push(`${file}::${enclosing}`);
  }
  return found;
}

/* -------------------------------------------------------------------------- */

describe('the project crate and the project contract spell the same vocabulary', () => {
  it('agrees on how a skill is linked and on what a machine can do', () => {
    expectMembers(wireNames(readRustItem('link.rs', 'enum', 'SkillLinkKind')), SKILL_LINK_KIND);
    expectMembers(wireNames(readRustItem('link.rs', 'enum', 'LinkStrategy')), LINK_STRATEGY);
    expectMembers(
      wireNames(readRustItem('link.rs', 'enum', 'LinkFallbackReason')),
      LINK_FALLBACK_REASON,
    );
  });

  it('agrees on why one skill could not be mounted', () => {
    // The renderer words every one of these, and its switch is exhaustive: a
    // seventh problem, or a sixth renamed, is a skill the user switched on that
    // the UI can say nothing true about.
    expectMembers(
      wireNames(readRustItem('mount.rs', 'enum', 'SkillMountProblem')),
      SKILL_MOUNT_PROBLEM,
    );
  });

  it('agrees that a copy is not a link, and on what one mount entry carries', () => {
    expectMembers(
      wireNames(readRustItem('mount.rs', 'enum', 'SkillMountStatus')),
      SKILL_MOUNT_STATUS,
    );
    expectMembers(wireNames(readRustItem('mount.rs', 'struct', 'SkillMount')), SKILL_MOUNT_FIELDS);
  });

  it('agrees on the layout, its paths, and which of them a read may repair', () => {
    expectMembers(
      wireNames(readRustItem('layout.rs', 'enum', 'ProjectDirectory')),
      PROJECT_DIRECTORY,
    );
    expectMembers(
      wireNames(readRustItem('layout.rs', 'struct', 'ProjectPaths')),
      PROJECT_PATHS_FIELDS,
    );
    expectMembers(
      wireNames(readRustItem('layout.rs', 'struct', 'ProjectLayout')),
      PROJECT_LAYOUT_FIELDS,
    );
  });

  it('agrees on the working directory, resolved and as a request', () => {
    expectMembers(
      wireNames(readRustItem('workdir.rs', 'enum', 'WorkingDirectoryProblem')),
      WORKING_DIRECTORY_PROBLEM,
    );
    expectMembers(
      wireNames(readRustItem('workdir.rs', 'enum', 'WorkingDirectory')),
      WORKING_DIRECTORY,
    );
    expectMembers(
      wireNames(readRustItem('workdir.rs', 'enum', 'WorkingDirectoryBinding')),
      WORKING_DIRECTORY_BINDING,
    );
  });
});

describe('the live crate never reaches for a symbolic link on Windows', () => {
  it('makes its link with something other than symlink_dir', () => {
    const source = SOURCES['link.rs'] ?? '';
    expect(windowsLinkCallsIn(source)).toEqual([]);
    // And it does make a link there, so the emptiness above is not emptiness for
    // want of a Windows branch at all.
    expect(source).toContain('IO_REPARSE_TAG_MOUNT_POINT');
    expect(source).toContain('#[cfg(windows)]');
  });

  it('reports the reported strategy as junction, never symlink', () => {
    // The constant, read from the source rather than from a value this side of
    // the bridge could not have. What the crate actually writes to the disk is a
    // separate question and is asked of the volume, in that crate's own tests.
    const source = SOURCES['link.rs'] ?? '';
    expect(source).toMatch(
      /#\[cfg\(windows\)\]\r?\nconst NATIVE_LINK_STRATEGY: LinkStrategy = LinkStrategy::Junction;/,
    );
  });
});

describe('every removal in the project crate is accounted for', () => {
  it('has exactly the removals AMENDMENT 8 counts, and no seventh', () => {
    const found = CRATE_FILES.flatMap((file) => removalsIn(file));
    expect([...found].sort()).toEqual([...REMOVAL_LEDGER].sort());
  });

  it('leaves nothing outside remove_tree that could reach a mount', () => {
    // Said as its own assertion because it is the sentence that matters: the
    // exceptions are two functions, both of which remove a directory they made
    // themselves, and neither of which can be handed a project root.
    const outsideTheGuard = CRATE_FILES.flatMap((file) => removalsIn(file)).filter(
      (site) => !site.endsWith('::remove_tree'),
    );
    expect(new Set(outsideTheGuard)).toEqual(new Set(['casefold.rs::probe', 'link.rs::create']));
    expect(outsideTheGuard).toHaveLength(6);
  });
});

/**
 * **The half-guard the contract names as dangerous, closed.**
 *
 * `contract-project.ts` proves that `PROJECT_COMMAND_NAMES` contains only names
 * `ProjectCommands` declares, and says plainly that the reverse — every declared
 * command appears in the list — is checked by nothing. `contract.test.ts` does
 * not close it either: `IpcContract` restates the eight project commands with
 * imported payload types rather than extending `ProjectCommands`, so its runtime
 * exhaustiveness check never sees that interface.
 *
 * A ninth command declared and forgotten here is therefore not walked by
 * `src/platform/browser-adapter-projects.test.ts`'s allowlist check, so it can
 * reach main without being allowlisted anywhere, and the first call from a UI
 * written against the contract answers `UNKNOWN_COMMAND`. Loud at runtime,
 * silent in review.
 *
 * It is closed twice, in the two places it can be closed, and neither is
 * decoration.
 *
 * **At `pnpm typecheck`.** The annotation below is `true` only while nothing is
 * missing and resolves to a tuple naming the absent command otherwise, so
 * declaring a ninth command without listing it stops the repository compiling.
 * Adding `project_archive` to {@link ProjectCommands} and nothing else produces,
 * at the annotated line below, `error TS2322: Type 'boolean' is not assignable
 * to type '["this command is declared but not listed", "project_archive"]'`.
 *
 * **At `pnpm test`.** An interface has no value to enumerate, which is why this
 * cannot be `Object.keys` of anything — so {@link declaredCommandsIn} reads the
 * declaration out of the contract's own source, the same way everything above
 * reads the crate's. That is what the test below compares, and it is a
 * comparison of two sets that were written down separately.
 *
 * The first draft asserted `expect(everyDeclaredProjectCommandIsListed).toBe(
 * true)` against a `const … = true`, which is unconditionally true at runtime —
 * a green test named after a rule nothing checked at runtime, which is worse
 * than no test because it reads as coverage. The type is still here and still
 * the primary guard; it is `void`ed like the contract's own compile-time proof
 * rather than dressed up as an assertion.
 */
type CommandsMissingFromTheList = Exclude<
  ProjectCommandName,
  (typeof PROJECT_COMMAND_NAMES)[number]
>;

const everyDeclaredProjectCommandIsListed: [CommandsMissingFromTheList] extends [never]
  ? true
  : ['this command is declared but not listed', CommandsMissingFromTheList] = true;
void everyDeclaredProjectCommandIsListed;

/**
 * The member names of one `export interface` in a TypeScript source, in
 * declaration order.
 *
 * Line-oriented like {@link parseRustItem}, but **without that function's
 * safety net**: `pnpm verify` runs `cargo fmt --all --check` over the crate, so
 * the Rust shape is machine-enforced, and this repository has no formatter or
 * linter for TypeScript at all — `package.json` has neither, and `pnpm verify`
 * is typecheck, `cargo` and tests. So this assumes only what it must and catches
 * itself when the assumption breaks: the interface's closing `}` is in column 0
 * and each member begins its own line. Brace depth is tracked, so a member whose
 * payload type is written across several lines is read as one member and its
 * inner field names are not read as commands; doc-comment lines are dropped,
 * because `project_reconcile_skills` carries one.
 *
 * If the shape ever stops holding, this throws or returns fewer members, and the
 * control below — which asserts a known member is present and that the parser
 * finds a multi-line member in a fabricated interface — fails rather than
 * letting the comparison degrade into two empty lists agreeing.
 */
function declaredCommandsIn(source: string, name: string): readonly string[] {
  const at = source.search(new RegExp(`^export interface ${name} \\{$`, 'm'));
  if (at < 0) throw new Error(`project-host-parity: no \`export interface ${name}\``);

  const lines = source.slice(at).split(/\r?\n/).slice(1);
  const end = lines.indexOf('}');
  if (end < 0) throw new Error(`project-host-parity: unterminated ${name}`);

  const members: string[] = [];
  let depth = 0;
  for (const line of lines.slice(0, end)) {
    const text = line.trim();
    if (text.startsWith('//') || text.startsWith('/*') || text.startsWith('*')) continue;
    if (depth === 0) {
      const member = /^([A-Za-z_][A-Za-z0-9_]*)\s*[?]?:/.exec(text);
      if (member?.[1] !== undefined) members.push(member[1]);
    }
    depth += (text.match(/\{/g) ?? []).length - (text.match(/\}/g) ?? []).length;
  }
  return members;
}

const CONTRACT_PROJECT = readFileSync(
  join(process.cwd(), 'src', 'platform', 'contract-project.ts'),
  'utf8',
);

describe('the declared project commands and the listed ones are one set', () => {
  it('lists every command the payload map declares', () => {
    // Two lists written down separately in one file, compared: the interface's
    // members, read out of the source because an interface has no runtime value,
    // and the exported array. `contract-project.ts` proves one direction of this
    // at compile time and says in as many words that the other direction is
    // checked by nothing; this is that other direction, and the type above holds
    // it a second time at `pnpm typecheck`.
    const declared = declaredCommandsIn(CONTRACT_PROJECT, 'ProjectCommands');

    expect(declared.length).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual([...PROJECT_COMMAND_NAMES].sort());
  });

  it('read the declaration rather than an empty body', () => {
    // The control for the reader above. A regex that matched nothing would make
    // the comparison a comparison of two empty lists on the day somebody
    // reformatted the contract, so the shape of what it read is asserted too,
    // and a fabricated interface proves it finds a member the list would lack.
    const declared = declaredCommandsIn(CONTRACT_PROJECT, 'ProjectCommands');
    expect(declared).toContain('project_reconcile_skills');
    for (const command of declared) expect(command).toMatch(/^project_[a-z_]+$/);

    const fabricated = [
      'export interface ProjectCommands {',
      '  /** A doc comment, and a nested payload written across lines. */',
      '  project_create: { req: ProjectCreateReq; res: ProjectRes };',
      '  project_archive: {',
      '    req: ProjectArchiveReq;',
      '    res: Ack;',
      '  };',
      '}',
    ].join('\n');
    expect(declaredCommandsIn(fabricated, 'ProjectCommands')).toEqual([
      'project_create',
      'project_archive',
    ]);
    expect(() => declaredCommandsIn(fabricated, 'NoSuchInterface')).toThrow();
  });

  it('keeps the list sorted and free of repeats, as the allowlist is', () => {
    expect([...PROJECT_COMMAND_NAMES]).toEqual([...PROJECT_COMMAND_NAMES].sort());
    expect(new Set(PROJECT_COMMAND_NAMES).size).toBe(PROJECT_COMMAND_NAMES.length);
  });
});

describe('both sides count the same limit and the same number', () => {
  it('carries the same maximum name and instruction length as the host', () => {
    // The unit — Unicode scalar values — is argued in the contract and held by a
    // test on each side. Neither of those tests reads the other side's number,
    // so lowering the Rust constant alone left both suites green and made the
    // renderer accept a name the host then refuses, with a validation error the
    // field it came from cannot explain.
    const host = readFileSync(join(process.cwd(), 'src-tauri', 'src', 'ipc', 'project.rs'), 'utf8');
    const name = /pub const PROJECT_NAME_MAX_CHARS: usize = ([0-9_]+);/.exec(host);
    const instructions = /pub const PROJECT_INSTRUCTIONS_MAX_CHARS: usize = ([0-9_]+);/.exec(host);

    expect(Number(name?.[1]?.replaceAll('_', ''))).toBe(PROJECT_NAME_MAX_CHARS);
    expect(Number(instructions?.[1]?.replaceAll('_', ''))).toBe(PROJECT_INSTRUCTIONS_MAX_CHARS);
  });
});

describe('the renderer has no filesystem of its own', () => {
  it('grants no fs, dialog or shell capability to the main window', () => {
    // The private-workspace boundary in `src/platform/contract-project.ts` names
    // this file as its reason: nothing under `src/` writes in the workspace
    // "because the renderer has no filesystem access at all". The same file is
    // why there is no folder picker and no reveal-in-explorer button. Adding one
    // line here makes all three sentences false and nothing else notices.
    const capabilities = JSON.parse(
      readFileSync(join(process.cwd(), 'src-tauri', 'capabilities', 'main.json'), 'utf8'),
    ) as { readonly permissions: readonly string[] };

    expect(capabilities.permissions.length).toBeGreaterThan(0);
    for (const permission of capabilities.permissions) {
      expect(permission).not.toMatch(/^(?:fs|dialog|shell|http):/);
      // Every grant is a core window or event permission, so a capability from
      // any plugin at all shows up here rather than only the four named above.
      expect(permission).toMatch(/^core:(?:event|window):/);
    }
  });
});

describe('this guard is not vacuous', () => {
  it('read real items, not empty ones', () => {
    expect(readRustItem('mount.rs', 'enum', 'SkillMountProblem').members).toHaveLength(6);
    expect(readRustItem('mount.rs', 'enum', 'SkillMountProblem').renameAll).toBe('camelCase');
    expect(readRustItem('layout.rs', 'struct', 'ProjectPaths').members).toEqual([
      'root',
      'workspace',
      'skills_mount',
      'skill_store',
    ]);
  });

  it('reads a struct-bodied variant as one member and not as its fields', () => {
    expect(readRustItem('workdir.rs', 'enum', 'WorkingDirectory').members).toEqual([
      'None',
      'Bound',
      'Unavailable',
    ]);
  });

  it('throws rather than comparing nothing when an item is missing', () => {
    expect(() => readRustItem('link.rs', 'enum', 'NoSuchEnumExists')).toThrow();
  });

  it('found the crate on disk, and found more of it than a list would have', () => {
    // The reader that makes "anywhere in the crate" true. Asserted as a superset
    // of the five files the hand-written list named plus `lib.rs`, which that
    // list omitted and which is therefore the cheapest available proof that this
    // sees files nobody enumerated. Not an equality: a new module must not fail
    // here, it must be *scanned* here, which is the whole point.
    for (const file of ['casefold.rs', 'layout.rs', 'lib.rs', 'link.rs', 'mount.rs', 'workdir.rs']) {
      expect(CRATE_FILES).toContain(file);
      expect(SOURCES[file]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('scans past the item a #[cfg(windows)] line is attached to', () => {
    // The documented over-scan, pinned so the comment on `windowsLinkCallsIn` is
    // a statement about this code rather than about an idea of it. The attribute
    // is on a `const`, which closes at a semicolon; the region runs on to the
    // next column-0 `}` and so takes in a function that is not Windows-only.
    const fabricated = [
      '#[cfg(windows)]',
      'const NATIVE_LINK_STRATEGY: LinkStrategy = LinkStrategy::Junction;',
      '#[cfg(not(windows))]',
      'const NATIVE_LINK_STRATEGY: LinkStrategy = LinkStrategy::Symlink;',
      'fn not_windows_only_at_all() {',
      '    std::os::windows::fs::symlink_dir(target, link)',
      '}',
      'fn after_the_region_closed() {',
      '    std::os::windows::fs::symlink_file(target, link)',
      '}',
    ].join('\n');
    // The first call is inside the region and is reported; the second is past
    // the column-0 `}` that closed it and is not. Erring wide, never narrow.
    expect(windowsLinkCallsIn(fabricated)).toEqual(['symlink_dir']);
  });

  it('has no Windows code behind a spelling the scanner does not open on', () => {
    // `windowsLinkCallsIn` opens only on the literal `#[cfg(windows)]`. A branch
    // written `#[cfg(target_os = "windows")]` would be Windows code the scan
    // never enters, which is the one way its safe direction reverses.
    for (const file of CRATE_FILES) {
      expect(SOURCES[file]).not.toMatch(/#\[cfg\(target_os\s*=\s*"windows"\)\]/);
    }
  });

  it('reports a Windows branch that does reach for a symlink', () => {
    // The control. Same detector, a fabricated source, so a later edit that
    // widened the detector into a no-op fails here rather than quietly excusing
    // the thing it was written to catch.
    const fabricated = [
      '//! A comment may name std::os::windows::fs::symlink_dir freely.',
      '#[cfg(windows)]',
      'pub fn create_link(link: &Path, target: &Path) -> io::Result<()> {',
      '    std::os::windows::fs::symlink_dir(target, link)',
      '}',
      '#[cfg(not(windows))]',
      'fn elsewhere() {',
      '    std::os::unix::fs::symlink(target, link)',
      '}',
    ].join('\n');
    expect(windowsLinkCallsIn(fabricated)).toEqual(['symlink_dir']);
  });

  it('finds a seventh removal written somewhere else', () => {
    // The control for the ledger, and the case it exists for: a new cleanup
    // path, in a function of its own, not going through the guard.
    const fabricated = [
      'pub fn tidy_up_orphaned_projects(root: &Path) -> io::Result<()> {',
      '    fs::remove_dir_all(root)',
      '}',
      '#[cfg(test)]',
      'mod tests {',
      '    fn a_test_that_cleans_up_after_itself() {',
      '        fs::remove_dir_all(scratch);',
      '    }',
      '}',
    ].join('\n');
    const sources = SOURCES as Record<string, string>;
    const previous = sources['link.rs'];
    try {
      sources['link.rs'] = fabricated;
      // One entry, not two: the removal inside the test module is excluded.
      expect(removalsIn('link.rs')).toEqual(['link.rs::tidy_up_orphaned_projects']);
    } finally {
      if (previous !== undefined) sources['link.rs'] = previous;
    }
  });

  it('renames the way serde renames, both of the ways it renames', () => {
    // Variants: PascalCase in, first character lowered, nothing else touched —
    // including where two capitals meet, which is where a word-splitting
    // implementation answers `nameIsNotAsinglePathSegment` and reports the
    // contract as wrong about a name the host really sends.
    expect(wireName('NameCollidesWithAnotherEnabledSkill', 'camelCase', 'variant')).toBe(
      'nameCollidesWithAnotherEnabledSkill',
    );
    expect(wireName('NameIsNotASinglePathSegment', 'camelCase', 'variant')).toBe(
      'nameIsNotASinglePathSegment',
    );
    expect(wireName('CopiedAtMs', 'snake_case', 'variant')).toBe('copied_at_ms');

    // Fields: snake_case in, underscores folded away. The variant rule applied
    // here answers `skills_mount`, which is this file's own first-draft defect.
    expect(wireName('skills_mount', 'camelCase', 'field')).toBe('skillsMount');
    expect(wireName('last_active_at_ms', 'camelCase', 'field')).toBe('lastActiveAtMs');
    expect(wireName('project_id', 'none', 'field')).toBe('project_id');
  });
});
