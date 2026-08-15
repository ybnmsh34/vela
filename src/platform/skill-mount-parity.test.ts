/**
 * The guard `src/platform/contract-project.ts` says it cannot have yet.
 *
 * That file's header states it plainly: `contract.ts`'s chat shapes are pinned
 * to Rust by `src/platform/chat-contract-parity.test.ts`, "this file has no
 * counterpart, and cannot have one until there is Rust to compare it against".
 * There is now Rust to compare it against — `src-tauri/crates/vela-skills/` —
 * and this is the counterpart, for the part of that contract the skills crate
 * implements: the mount vocabulary.
 *
 * ## Which crate this is, and which one answers the commands
 *
 * **This file reads `src-tauri/crates/vela-skills/` and nothing else, and that
 * is not the crate behind `project_layout`.** `src-tauri/src/ipc/skills.rs` says
 * no command calls `vela_skills::mount`; the implementation the user's machine
 * runs is `src-tauri/crates/vela-projects/`, which has its own copy of this
 * vocabulary. So a variant renamed there is invisible here, and every assertion
 * below stays green while the renderer's closed union stops matching the wire.
 * `src/platform/project-host-parity.test.ts` is the file that reads that crate,
 * and it exists because this one alone was read as covering both. Neither
 * replaces the other while two crates spell one vocabulary.
 *
 * ## What is pinned, and in which direction each way fails
 *
 * A **Rust** variant added without its TypeScript twin fails here, at
 * `pnpm test`: this file reads the crate's sources off disk, applies each
 * enum's own `#[serde(rename_all = …)]`, and compares the resulting wire names
 * against the lists below.
 *
 * A **TypeScript** variant added without its Rust twin fails at
 * `pnpm typecheck`: every list is passed through {@link everyVariantOf}, which
 * is only assignable when the list covers its union exactly. There is no order
 * in which a one-sided change is green.
 *
 * ## And one rule that is not a shape
 *
 * `contract-project.ts` is emphatic that the link is a junction on Windows and
 * **never** a symbolic link, because creating a symlink there needs a privilege
 * ordinary accounts do not hold — so a symlink design works on the developer's
 * machine and fails on the user's. That is a sentence about code, not about a
 * type, so {@link windowsLinkCallsIn} reads the crate's Windows branch and this
 * suite fails if it reaches for `std::os::windows::fs::symlink_dir`. Without
 * it, the contract's most load-bearing platform rule would have been guarded by
 * nothing but the comment claiming it — the exact shape
 * `src/platform/claimed-guards.test.ts` exists to catch.
 *
 * **Name parity, not semantic parity.** That both sides have a `copied` arm,
 * not that both compute `stale` the same way. What the crate does with these
 * values is tested in the crate, against real directories.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { SkillListing, SkillProblem, SkillResources } from './contract';
import type {
  LinkFallbackReason,
  LinkStrategy,
  SkillLinkKind,
  SkillMount,
  SkillMountProblem,
  SkillMountStatus,
} from './contract-project';

/* -------------------------------------------------------------------------- */
/* the TypeScript half — closed by the compiler                               */
/* -------------------------------------------------------------------------- */

/**
 * Accepts a list only when it names every member of `U` exactly once.
 *
 * Same device as `chat-contract-parity.test.ts`, restated rather than shared:
 * exporting it would make one file's type-level helper part of another file's
 * public surface, and it is nine lines.
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

const SKILL_PROBLEM = everyVariantOf<SkillProblem>()([
  'noSkillFile',
  'unreadable',
  'noFrontmatter',
  'unterminatedFrontmatter',
  'unsupportedFrontmatterSyntax',
  'duplicateFrontmatterKey',
  'missingName',
  'missingDescription',
  'nameIsNotWellFormed',
  'nameTooLong',
  'nameDoesNotMatchDirectory',
  'descriptionIsEmpty',
  'descriptionTooLong',
  'nameIsNotASinglePathSegment',
]);

const SKILL_LISTING = everyVariantOf<TagsOf<SkillListing, 'kind'>>()(['skill', 'invalid']);

const SKILL_RESOURCE_FIELDS = everyVariantOf<keyof SkillResources & string>()([
  'scripts',
  'references',
  'assets',
]);

/* -------------------------------------------------------------------------- */
/* the Rust half — read off disk                                              */
/* -------------------------------------------------------------------------- */

const CRATE = join(process.cwd(), 'src-tauri', 'crates', 'vela-skills', 'src');

const SOURCES: Readonly<Record<string, string>> = Object.fromEntries(
  ['document.rs', 'mount.rs', 'store.rs'].map((file) => [
    file,
    readFileSync(join(CRATE, file), 'utf8'),
  ]),
);

type RenameRule = 'camelCase' | 'snake_case' | 'none';

interface RustItem {
  /** Variant names for an enum, field names for a struct — Rust spelling. */
  readonly members: readonly string[];
  readonly renameAll: RenameRule;
}

/**
 * Reads one `pub enum` / `pub struct` body.
 *
 * Line-oriented, which is sound because `cargo fmt --check` runs in
 * `pnpm verify`: every item is rustfmt's shape, one member per line with the
 * closing brace in column 0. A struct-bodied enum variant closes on `    },`,
 * which is not column 0, so the search for the item's own end is not confused
 * by one.
 *
 * Splitting on `/\r?\n/` rather than `'\n'` is not defensive tidiness. Windows
 * checkouts of this repository have CRLF line endings, and the sibling parity
 * test recorded what splitting on `'\n'` alone did there: a trailing `'\r'` on
 * every line, the column-0 brace never found, and the guarantee the contract
 * advertised not executing on the only machine that builds the product.
 */
function parseRustItem(source: string, keyword: 'enum' | 'struct', name: string): RustItem {
  const declaration = new RegExp(`^pub ${keyword} ${name}\\b[^{\\r\\n]*\\{$`, 'm');
  const at = source.search(declaration);
  if (at < 0) throw new Error(`skill-mount-parity: no \`pub ${keyword} ${name}\``);

  const head = source.slice(0, at);
  const derive = head.lastIndexOf('#[derive');
  const attributes = derive < 0 ? '' : head.slice(derive);
  const rename = /rename_all\s*=\s*"(camelCase|snake_case)"/.exec(attributes);
  const renameAll: RenameRule = rename ? (rename[1] as RenameRule) : 'none';

  const lines = source.slice(at).split(/\r?\n/).slice(1);
  const end = lines.indexOf('}');
  if (end < 0) throw new Error(`skill-mount-parity: unterminated ${name}`);

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
  return { members, renameAll };
}

function readRustItem(file: string, keyword: 'enum' | 'struct', name: string): RustItem {
  const source = SOURCES[file];
  if (source === undefined) throw new Error(`skill-mount-parity: ${file} is not loaded`);
  return parseRustItem(source, keyword, name);
}

/**
 * Applies the item's own `rename_all`, exactly as serde does.
 *
 * **"Exactly" is the whole point, and the first draft of this function was not
 * exact.** It word-split on the lowercase-to-uppercase boundary, which is the
 * intuitive reading and is not serde's: serde's camelCase rule lowercases the
 * **first character** of the Rust name and touches nothing else. The two agree
 * on every name whose capitals are separated by lowercase letters and disagree
 * the moment two capitals meet — `NameIsNotASinglePathSegment` becomes
 * `nameIsNotASinglePathSegment` under serde and `nameIsNotAsinglePathSegment`
 * under the word split. The contract spells it serde's way, so the word split
 * reported the contract as wrong about a name the host really sends. This test
 * failing on its first run, for that reason, is the reason to write it.
 */
function wireName(rustName: string, rule: RenameRule): string {
  if (rule === 'none') return rustName;
  if (rule === 'camelCase') {
    return rustName.charAt(0).toLowerCase() + rustName.slice(1);
  }
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
  return item.members.map((member) => wireName(member, item.renameAll));
}

function expectMembers(actual: readonly string[], expected: readonly string[]): void {
  expect(actual.length).toBeGreaterThan(0);
  expect([...actual].sort()).toEqual([...expected].sort());
}

/**
 * Every call to a link-creating API inside a `#[cfg(windows)]` item.
 *
 * Comment lines are dropped first, so the module header may discuss
 * `std::os::windows::fs::symlink_dir` — and does — without the discussion
 * counting as a call. A `#[cfg(windows)]` attribute puts the item that follows
 * it into the Windows branch; the branch ends at the next column-0 `}`.
 */
export function windowsLinkCallsIn(source: string): readonly string[] {
  const lines = source.split(/\r?\n/);
  const found: string[] = [];
  let inWindowsItem = false;
  for (const line of lines) {
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

describe('the skills crate and the project contract spell the same vocabulary', () => {
  it('agrees on how a skill is linked', () => {
    expectMembers(wireNames(readRustItem('mount.rs', 'enum', 'SkillLinkKind')), SKILL_LINK_KIND);
  });

  it('agrees on why linking fell back to copying', () => {
    expectMembers(
      wireNames(readRustItem('mount.rs', 'enum', 'LinkFallbackReason')),
      LINK_FALLBACK_REASON,
    );
  });

  it('agrees on the strategies a machine can have', () => {
    expectMembers(wireNames(readRustItem('mount.rs', 'enum', 'LinkStrategy')), LINK_STRATEGY);
  });

  it('agrees on why one skill could not be mounted', () => {
    expectMembers(
      wireNames(readRustItem('mount.rs', 'enum', 'SkillMountProblem')),
      SKILL_MOUNT_PROBLEM,
    );
  });

  it('agrees that a copy is not a link', () => {
    // The contract's own reason for this union's shape: a copy is a snapshot,
    // so it cannot be a third `SkillLinkKind` that consumers treat like the
    // other two.
    expectMembers(
      wireNames(readRustItem('mount.rs', 'enum', 'SkillMountStatus')),
      SKILL_MOUNT_STATUS,
    );
  });

  it('agrees on what one mount entry carries', () => {
    expectMembers(wireNames(readRustItem('mount.rs', 'struct', 'SkillMount')), SKILL_MOUNT_FIELDS);
  });

  it('agrees on why a directory is not a skill', () => {
    expectMembers(wireNames(readRustItem('document.rs', 'enum', 'SkillProblem')), SKILL_PROBLEM);
  });

  it('agrees on the shape of a listing and of a skill’s resources', () => {
    expectMembers(wireNames(readRustItem('store.rs', 'enum', 'SkillListing')), SKILL_LISTING);
    expectMembers(
      wireNames(readRustItem('store.rs', 'struct', 'SkillResources')),
      SKILL_RESOURCE_FIELDS,
    );
  });
});

describe('the Windows branch never reaches for a symbolic link', () => {
  it('creates its link with something other than symlink_dir', () => {
    const source = SOURCES['mount.rs'] ?? '';
    expect(windowsLinkCallsIn(source)).toEqual([]);
    // And it does make a link, so the emptiness above is not emptiness for want
    // of any Windows branch at all.
    expect(source).toContain('mklink /J');
    expect(source).toContain('#[cfg(windows)]');
  });
});

describe('this guard is not vacuous', () => {
  it('read real items, not empty ones', () => {
    expect(readRustItem('mount.rs', 'enum', 'SkillMountProblem').members).toHaveLength(6);
    expect(readRustItem('mount.rs', 'enum', 'SkillMountProblem').renameAll).toBe('camelCase');
    expect(readRustItem('document.rs', 'enum', 'SkillProblem').members.length).toBeGreaterThan(10);
  });

  it('reads a struct-bodied variant as one member and not as its fields', () => {
    const status = readRustItem('mount.rs', 'enum', 'SkillMountStatus');
    expect(status.members).toEqual(['Linked', 'Copied', 'Unavailable']);
  });

  it('throws rather than comparing nothing when an item is missing', () => {
    expect(() => readRustItem('mount.rs', 'enum', 'NoSuchEnumExists')).toThrow();
  });

  it('reports a Windows branch that does reach for a symlink', () => {
    // The control. Same detector, a fabricated source — so a later edit that
    // widened the detector into a no-op fails here rather than quietly
    // excusing the thing it was written to catch.
    const fabricated = [
      '//! A comment may name std::os::windows::fs::symlink_dir freely.',
      '#[cfg(windows)]',
      'fn create_link(link: &Path, target: &Path) -> io::Result<SkillLinkKind> {',
      '    std::os::windows::fs::symlink_dir(target, link)?;',
      '    Ok(SkillLinkKind::Symlink)',
      '}',
      '#[cfg(not(windows))]',
      'fn elsewhere() {',
      '    std::os::unix::fs::symlink(target, link)?;',
      '}',
    ].join('\n');
    expect(windowsLinkCallsIn(fabricated)).toEqual(['symlink_dir']);
  });

  it('renames the way serde renames, including where two capitals meet', () => {
    expect(wireName('NameCollidesWithAnotherEnabledSkill', 'camelCase')).toBe(
      'nameCollidesWithAnotherEnabledSkill',
    );
    // The case that caught this file's own first draft. A word-splitting
    // implementation answers `nameIsNotAsinglePathSegment` here and then
    // reports the contract as wrong about a name the host really sends.
    expect(wireName('NameIsNotASinglePathSegment', 'camelCase')).toBe(
      'nameIsNotASinglePathSegment',
    );
    expect(wireName('SkillNotFound', 'none')).toBe('SkillNotFound');
    expect(wireName('CopiedAtMs', 'snake_case')).toBe('copied_at_ms');
  });
});
