/**
 * **The canonical skill store, pinned to the contract that describes it.**
 *
 * `skills_list` and `skills_read` are the two commands the renderer really
 * calls, and what they answer with is the vocabulary of
 * `src-tauri/crates/vela-skills/`:
 * `SkillProblem` from `src-tauri/crates/vela-skills/src/document.rs`, and
 * `SkillListing` and `SkillResources` from
 * `src-tauri/crates/vela-skills/src/store.rs`. The host serialises those enums
 * itself, so a variant renamed in Rust reaches a renderer whose closed union
 * never heard of it, the exhaustive `switch` falls through, and the user is
 * shown the wrong sentence — or none — about a skill they installed. This file
 * is the only thing in the tree that compares the two lists.
 *
 * ## What this file used to be, and why it is not that any more
 *
 * It was called skill-mount-parity.test.ts — spelled without backticks here
 * because there is no such file any more, and this repository's own
 * `src/platform/claimed-guards.test.ts` resolves every backticked path against
 * the tree. It also read a
 * `mount.rs` in this same crate: a second, complete implementation of the mount
 * vocabulary — `SkillLinkKind`, `LinkStrategy`, `SkillMountProblem`,
 * `SkillMountStatus`, `SkillMount` — plus the Windows junction rule. **No
 * command ever called any of it.** The mount that runs is
 * `src-tauri/crates/vela-projects/`, reached from
 * `src-tauri/src/ipc/project.rs`; the duplicate was deleted, so the six
 * assertions that read it are gone with it. They are not lost coverage:
 * `src/platform/project-host-parity.test.ts` already pinned every one of those
 * five types, and the Windows rule, against the crate the user's machine runs.
 *
 * That is worth stating rather than leaving as a diff, because the failure it
 * closes is the one this repository keeps finding. A guard named after the mount
 * was reading a copy of the mount that nothing executed. It was green, it stayed
 * green through a real rename in the live crate, and it read as coverage. The
 * remaining assertions here were always the live half of the file — the store —
 * and the file is named for them now.
 *
 * ## What is pinned, and in which direction each way fails
 *
 * A **Rust** variant added without its TypeScript twin fails here, at
 * `pnpm test`: this file reads the crate's sources off disk, applies each item's
 * own `#[serde(rename_all = …)]`, and compares the resulting wire names against
 * the lists below.
 *
 * A **TypeScript** variant added without its Rust twin fails at
 * `pnpm typecheck`: every list is passed through {@link everyVariantOf}, which
 * is only assignable when the list covers its union exactly. There is no order
 * in which a one-sided change is green.
 *
 * **Name parity, not semantic parity.** That both sides have an `invalid` arm,
 * not that both decide invalidity the same way. What the crate does with these
 * values is tested in the crate, against real directories.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { SkillListing, SkillProblem, SkillResources } from './contract';

/* -------------------------------------------------------------------------- */
/* the TypeScript half — closed by the compiler                               */
/* -------------------------------------------------------------------------- */

/**
 * Accepts a list only when it names every member of `U` exactly once.
 *
 * Same device as `src/platform/chat-contract-parity.test.ts` and
 * `src/platform/project-host-parity.test.ts`, restated rather than shared:
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
  ['document.rs', 'store.rs'].map((file) => [file, readFileSync(join(CRATE, file), 'utf8')]),
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
  if (at < 0) throw new Error(`skill-store-parity: no \`pub ${keyword} ${name}\``);

  const head = source.slice(0, at);
  const derive = head.lastIndexOf('#[derive');
  const attributes = derive < 0 ? '' : head.slice(derive);
  const rename = /rename_all\s*=\s*"(camelCase|snake_case)"/.exec(attributes);
  const renameAll: RenameRule = rename ? (rename[1] as RenameRule) : 'none';

  const lines = source.slice(at).split(/\r?\n/).slice(1);
  const end = lines.indexOf('}');
  if (end < 0) throw new Error(`skill-store-parity: unterminated ${name}`);

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
  if (source === undefined) throw new Error(`skill-store-parity: ${file} is not loaded`);
  return parseRustItem(source, keyword, name);
}

/**
 * Applies the item's own `rename_all`, exactly as serde does — **which is two
 * different transformations under one attribute name**, and that is the trap.
 *
 * Serde reads a variant as PascalCase and a field as snake_case, so one
 * `rename_all = "camelCase"` means "lowercase the first character" on an enum
 * and "fold each underscore into the letter after it" on a struct. A single
 * implementation is wrong for one of the two, silently.
 *
 * **This file carried the single implementation until the mount half was
 * deleted, and got away with it only because every struct field it reads is a
 * single word** — `scripts`, `references`, `assets`, on which the two rules
 * agree. That is a defect waiting for the first multi-word field, of exactly
 * the kind `src/platform/project-host-parity.test.ts` really did hit: its own
 * first draft used the variant rule for everything and reported
 * `ProjectPaths.skills_mount` as the name the host sends, which would have made
 * a real disagreement unnoticeable behind a fake one. Both files now carry the
 * two-rule version, and the field cases below are what keeps this one honest.
 *
 * Within the variant rule there is a second trap, and this file's own first
 * draft failed on it: the intuitive reading — split on the lowercase-to-
 * uppercase boundary — is not serde's, and the two disagree the moment two
 * capitals meet. Serde sends `nameIsNotASinglePathSegment`; the word split
 * answers `nameIsNotAsinglePathSegment` and reports this contract as wrong
 * about a name the host really sends. That variant is in {@link SKILL_PROBLEM},
 * so this is not a hypothetical here.
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

describe('the skills crate and the skills contract spell the same vocabulary', () => {
  it('agrees on why a directory is not a skill', () => {
    // The renderer words every one of these. A fifteenth problem, or a
    // fourteenth renamed, is a skill the user installed that the UI can say
    // nothing true about.
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

describe('this guard is not vacuous', () => {
  it('read real items, not empty ones', () => {
    const problem = readRustItem('document.rs', 'enum', 'SkillProblem');
    expect(problem.members).toHaveLength(14);
    expect(problem.renameAll).toBe('camelCase');
    expect(problem.kind).toBe('variant');
    expect(readRustItem('store.rs', 'struct', 'SkillResources').kind).toBe('field');
  });

  it('reads a struct-bodied variant as one member and not as its fields', () => {
    // Both of `SkillListing`'s variants carry a `directory` field. Read as
    // members those would be two more variants the contract has never heard of,
    // and the comparison would fail for a reason that has nothing to do with
    // drift.
    const listing = readRustItem('store.rs', 'enum', 'SkillListing');
    expect(listing.members).toEqual(['Skill', 'Invalid']);
  });

  it('throws rather than comparing nothing when an item is missing', () => {
    expect(() => readRustItem('document.rs', 'enum', 'NoSuchEnumExists')).toThrow();
    expect(() => readRustItem('mount.rs', 'enum', 'SkillMountProblem')).toThrow();
  });

  it('renames the way serde renames, both of the ways it renames', () => {
    // Variants: PascalCase in, first character lowered, nothing else touched —
    // including where two capitals meet, which is where a word-splitting
    // implementation answers `nameIsNotAsinglePathSegment` and reports the
    // contract as wrong about a name the host really sends.
    expect(wireName('NameIsNotASinglePathSegment', 'camelCase', 'variant')).toBe(
      'nameIsNotASinglePathSegment',
    );
    expect(wireName('NameDoesNotMatchDirectory', 'camelCase', 'variant')).toBe(
      'nameDoesNotMatchDirectory',
    );
    expect(wireName('CopiedAtMs', 'snake_case', 'variant')).toBe('copied_at_ms');

    // Fields: snake_case in, underscores folded away. The variant rule applied
    // here answers `skills_mount`, which is the sibling file's own first-draft
    // defect and the reason this file no longer carries the one-rule version.
    expect(wireName('scripts', 'camelCase', 'field')).toBe('scripts');
    expect(wireName('skills_mount', 'camelCase', 'field')).toBe('skillsMount');
    expect(wireName('last_active_at_ms', 'camelCase', 'field')).toBe('lastActiveAtMs');
    expect(wireName('project_id', 'none', 'field')).toBe('project_id');
  });
});
