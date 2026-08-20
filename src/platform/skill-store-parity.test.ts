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

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { SkillListing, SkillProblem, SkillResources } from './contract';
import { parseRustItem, qualified, scanSerialisable, wireName, wireNames } from './serde-wire';
import type { RustItem, SerialisableItem } from './serde-wire';

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

/**
 * The key serde puts `SkillListing`\u2019s discriminant under.
 *
 * Named rather than spelled inline so the same literal closes the TypeScript
 * union below and is compared against the Rust attribute above. `TagsOf` stops
 * compiling if the union does not discriminate on this key; `expectMembers`
 * fails if the crate stops emitting it.
 */
const SKILL_LISTING_TAG = 'kind';

const SKILL_LISTING = everyVariantOf<TagsOf<SkillListing, typeof SKILL_LISTING_TAG>>()([
  'skill',
  'invalid',
]);

const SKILL_RESOURCE_FIELDS = everyVariantOf<keyof SkillResources & string>()([
  'scripts',
  'references',
  'assets',
]);

/* -------------------------------------------------------------------------- */
/* the Rust half — read off disk                                              */
/* -------------------------------------------------------------------------- */

const CRATE = join(process.cwd(), 'src-tauri', 'crates', 'vela-skills', 'src');

/**
 * Every `.rs` file in the crate, **found on disk rather than listed here**.
 *
 * `src/platform/project-host-parity.test.ts` already recorded why, having been
 * caught by it: a hand-written list of the files that existed when the guard
 * was written gives the code the reach of a literal while the doc above it
 * claims the reach of a directory read, so a type added to a module nobody
 * added to the list is invisible. The inventory equality below is worth only as
 * much as the scan behind it reaches.
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

function readRustItem(file: string, keyword: 'enum' | 'struct', name: string): RustItem {
  const source = SOURCES[file];
  if (source === undefined) throw new Error(`skill-store-parity: ${file} is not loaded`);
  return parseRustItem(source, keyword, name, file);
}

interface Pairing {
  readonly rust: string;
  readonly file: string;
  readonly keyword: 'enum' | 'struct';
  readonly ts: string;
  readonly listed: readonly string[];
  /**
   * The key serde puts the discriminant under, or `null` for an item that is
   * not internally tagged.
   *
   * Required rather than optional, and that is the enforcement: a tagged enum
   * added to the list without a decision about its tag does not compile.
   * `SkillListing` carries `tag = "kind"`, the tag key is a member of nothing,
   * and until this field existed nothing here compared it — so `tag = "kind"`
   * could become `tag = "type"`, every `entry.kind === 'skill'` test in
   * `src/features/skills/SkillsPanel.tsx` go false, every installed skill
   * render as broken, and this file stay green. Measured, not supposed.
   */
  readonly tag: string | null;
}

const PAIRINGS: readonly Pairing[] = [
  {
    rust: 'SkillProblem',
    file: 'document.rs',
    keyword: 'enum',
    ts: 'SkillProblem',
    tag: null,
    listed: SKILL_PROBLEM,
  },
  {
    rust: 'SkillListing',
    file: 'store.rs',
    keyword: 'enum',
    ts: 'SkillListing',
    tag: SKILL_LISTING_TAG,
    listed: SKILL_LISTING,
  },
  {
    rust: 'SkillResources',
    file: 'store.rs',
    keyword: 'struct',
    ts: 'SkillResources',
    tag: null,
    listed: SKILL_RESOURCE_FIELDS,
  },
];

/**
 * The serialisable types in this crate that the renderer boundary deliberately
 * does not pair, each with the reason.
 *
 * A register, not a suppression list: its purpose is to make the count of
 * *unaccounted* types exactly zero, so the assertion below can be an equality
 * rather than a threshold. A threshold is a measurement wearing a bound — it
 * passes for any list long enough and cannot name which pairing vanished.
 */
const NOT_ON_THIS_BOUNDARY: readonly (SerialisableItem & { readonly because: string })[] = [
  {
    file: 'document.rs',
    keyword: 'struct',
    rust: 'SkillHeader',
    because:
      'never crosses under its own name. `src-tauri/src/ipc/skills.rs` takes it apart and ' +
      'builds `SkillsReadRes`, whose fields are what the renderer reads; there is no ' +
      '`SkillHeader` in `src/platform/contract.ts` to pair it with',
  },
];

/** Sets, not sequences: declaration order is not part of the wire contract. */
function expectMembers(pairing: Pairing): void {
  const item = readRustItem(pairing.file, pairing.keyword, pairing.rust);
  const rust = wireNames(item);
  expect(rust.length, `parser read nothing out of ${pairing.rust}`).toBeGreaterThan(1);
  expect([...rust].sort(), `${pairing.file}::${pairing.rust} vs ${pairing.ts}`).toEqual(
    [...pairing.listed].sort(),
  );
  // The discriminant key. Not a member of anything, so it needs its own
  // comparison or it has none: the TypeScript side is closed by
  // `TagsOf<…, typeof SKILL_LISTING_TAG>`, which stops compiling if the union
  // does not carry that key, and this is the other half.
  expect(item.tag, `${pairing.file}::${pairing.rust} discriminant key`).toBe(pairing.tag);
}

/* -------------------------------------------------------------------------- */

describe('the skills crate and the skills contract spell the same vocabulary', () => {
  // The renderer words every one of these. A fifteenth problem, or a fourteenth
  // renamed, is a skill the user installed that the UI can say nothing true
  // about.
  for (const pairing of PAIRINGS) {
    it(`${pairing.ts} carries every ${pairing.rust} member, and no other`, () => {
      expectMembers(pairing);
    });
  }

  /**
   * **The floor on the guard's own subject.**
   *
   * Everything above is of the form *for each pairing I happen to list, do the
   * two sides agree*, and nothing said how many pairings there are. Deleting
   * one deleted its runtime assertion and, with it, the compile-time half the
   * header calls load-bearing — `everyVariantOf` can only close a union for a
   * list that still exists. The whole visible trace was the vitest count moving
   * by one, and no assertion read that number.
   *
   * So the pairing list is not the inventory; the crate is. This is an
   * **equality**, not a threshold: `expect(PAIRINGS.length).toBeGreaterThan(2)`
   * would be a measurement wearing a bound, passing for any list long enough
   * and unable to name which pairing vanished. An equality against what is
   * really in the crate fails on a deleted pairing *and* on a serialisable type
   * nobody remembered to list, and its diff names both.
   */
  it('accounts for every serialisable type in the crate', () => {
    const scanned = CRATE_FILES.flatMap((file) =>
      scanSerialisable(SOURCES[file] ?? '', file),
    )
      .map(qualified)
      .sort();
    const accounted = [
      ...PAIRINGS.map(qualified),
      ...NOT_ON_THIS_BOUNDARY.map(qualified),
    ].sort();
    expect(scanned, 'a serialisable type is neither paired nor on the register').toEqual(
      accounted,
    );
  });

  it('pairs each type at most once', () => {
    expect(new Set(PAIRINGS.map(qualified)).size).toBe(PAIRINGS.length);
    expect(new Set(PAIRINGS.map((pairing) => pairing.ts)).size).toBe(PAIRINGS.length);
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
