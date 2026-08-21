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
 * It also reads `src-tauri/src/ipc/skills.rs`, which is the crate's other half
 * of the same sentence: `SkillsListRes` and `SkillsReadRes` are the shapes the
 * two commands actually answer with, and `SkillsReadRes` is what the register
 * below hands `SkillHeader`'s contract to. That hand-off used to be a sentence
 * pointing at a file no inventory in this repository read, and a probe used it:
 * `tag = "kind"` → `tag = "type"` there made every arm of
 * `src/features/skills/SkillsPanel.tsx`'s `read.kind === 'invalid'` test false,
 * with the whole suite green. It is red here now, and
 * `every hand-off on the register lands on a type this guard pairs` is what
 * stops the next such sentence being written.
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
 * `pnpm test`: this file reads the sources off disk, applies each item's own
 * `#[serde(rename_all = …)]`, and compares the resulting wire names against the
 * lists below.
 *
 * A **TypeScript** variant added without its Rust twin fails at
 * `pnpm typecheck`: every list is passed through {@link everyVariantOf} and
 * every payload record through {@link everyFieldOfEveryArm}, each of which is
 * only assignable when it covers its union exactly — the second arm by arm.
 * There is no order in which a one-sided change is green.
 *
 * The **fields inside** a struct-bodied variant are compared per arm rather
 * than pooled, and that is not a presentation choice: both arms of
 * `SkillListing` declare `directory`, so a `#[serde(skip)]` on one of them
 * leaves a pooled union of every arm's fields exactly as it was.
 *
 * **Name parity, not semantic parity.** That both sides have an `invalid` arm,
 * not that both decide invalidity the same way. What the crate does with these
 * values is tested in the crate, against real directories.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type {
  SkillListing,
  SkillProblem,
  SkillResources,
  SkillsListRes,
  SkillsReadRes,
} from './contract';
import {
  conditionalWireKeys,
  parseRustItem,
  payloadRecord,
  payloadWireKeys,
  qualified,
  filePathsNamedIn,
  scanSerialisable,
  wireName,
  wireNames,
} from './serde-wire';
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
 * public surface, and it is eight lines.
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

/** The keys of one arm of an internally tagged union, without the tag itself. */
type ArmFieldsOf<U, T extends PropertyKey, V> = Exclude<
  keyof Extract<U, Record<T, V>> & string,
  T
>;

/**
 * Accepts a record only when it names every arm of `U` and, for each, every
 * field of that arm exactly once.
 *
 * The per-arm shape is the enforcement, and a flat list is not a weaker version
 * of it — it is a different question. A probe put `#[serde(skip)]` on
 * `SkillListing::Invalid`'s `directory`, which the sibling `Skill` arm also
 * declares: the deduplicated union of every arm's fields did not move, so a
 * comparison over that union reported agreement while the key stopped crossing
 * on the arm `src/features/skills/SkillsPanel.tsx` uses for its row label, its
 * list key and the argument to `skills.select(...)`. Keyed by arm, the same
 * edit has nowhere to hide.
 *
 * Same device as {@link everyVariantOf} and restated for the same reason: it is
 * a type-level check with an identity function under it, so a second copy is
 * the same check by construction.
 */
function everyFieldOfEveryArm<U, T extends PropertyKey>() {
  return <R extends { readonly [V in TagsOf<U, T> & string]: readonly ArmFieldsOf<U, T, V>[] }>(
    record: R & {
      readonly [V in TagsOf<U, T> & string]: [
        Exclude<ArmFieldsOf<U, T, V>, R[V & keyof R][number]>,
      ] extends [never]
        ? unknown
        : ['this arm is missing a field', Exclude<ArmFieldsOf<U, T, V>, R[V & keyof R][number]>];
    },
  ): Readonly<Record<string, readonly string[]>> =>
    // Every arm must be *written*, so a new one cannot be forgotten; only the
    // ones that carry fields are *compared*, because a unit arm has no keys and
    // the Rust side has no entry for it. An arm that gains or loses its fields
    // therefore moves an entry into or out of this record, and the diff names
    // the arm.
    payloadRecord(record as Record<string, readonly string[]>);
}

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

/**
 * The keys the fields *inside* `SkillListing`'s struct-bodied variants cross
 * under, **arm by arm**.
 *
 * `directory`, `name`, `description` and `problem` are not members of the enum
 * — they are fields of its two arms — so the variant comparison above walks
 * straight past them, exactly as it used to walk past the tag key. They are
 * also every field of every skill row the user sees:
 * `src/features/skills/SkillsPanel.tsx` reads `entry.directory`, `entry.name`,
 * `entry.description` and `entry.problem`, and each of those four is one of
 * these keys.
 *
 * Both arms declare `directory`, and that is exactly why this is a record and
 * not a list: pooled into one set, a `directory` that stops crossing on the
 * `invalid` arm is a set that has not changed.
 */
const SKILL_LISTING_PAYLOAD = everyFieldOfEveryArm<SkillListing, typeof SKILL_LISTING_TAG>()({
  skill: ['directory', 'name', 'description'],
  invalid: ['directory', 'problem'],
});

const SKILL_RESOURCE_FIELDS = everyVariantOf<keyof SkillResources & string>()([
  'scripts',
  'references',
  'assets',
]);

/* -- the ipc boundary the register used to hand a type to in prose -------- */

const SKILLS_LIST_RES_FIELDS = everyVariantOf<keyof SkillsListRes & string>()(['skills']);

const SKILLS_READ_RES_TAG = 'kind';

const SKILLS_READ_RES = everyVariantOf<TagsOf<SkillsReadRes, typeof SKILLS_READ_RES_TAG>>()([
  'skill',
  'invalid',
]);

const SKILLS_READ_RES_PAYLOAD = everyFieldOfEveryArm<
  SkillsReadRes,
  typeof SKILLS_READ_RES_TAG
>()({
  skill: ['name', 'description', 'body', 'resources'],
  invalid: ['problem'],
});

/* -------------------------------------------------------------------------- */
/* the Rust half — read off disk                                              */
/* -------------------------------------------------------------------------- */


/**
 * The keys of `T` the renderer's own type says may be absent — the ones
 * spelled with a `?`.
 *
 * **It distributes over a union, and the version that did not was a check with
 * no reach.** The mapped type is indexed by `[keyof T]`, and for a union
 * `keyof T` is only the keys *common to every arm* — for a discriminated
 * contract union, the discriminant alone. An optional key on any single arm
 * was therefore never looked at, and `HasNoOptionalKey<U>` was `true` for
 * every union, unconditionally, for any edit. Measured on the byte-unmodified
 * guard: spelling `SkillsReadRes`'s `body` optional in `contract.ts` left
 * `tsc --build --force` at exit 0 and the whole suite green, against the
 * docblock below saying of that precise edit *"Adding a `?` on the TypeScript
 * side stops this file compiling"*. Six of the eleven `HasNoOptionalKey<…>`
 * entries standing in this guard and its project sibling named union types and
 * could not fail whatever anybody wrote.
 *
 * `T extends object ? … : never` makes the mapped type run once per arm, so
 * the answer is the union of every arm's optional keys. `object` rather than
 * `unknown` because a distributed `keyof` over an arm that is a *string
 * literal* asks about `String`'s own members, several of which the TypeScript
 * lib declares optional — measured, not supposed: distributing over `unknown`
 * makes `HasNoOptionalKey<SkillProblem>` report `replace` as an optional key
 * of the contract, which is an answer about `String` and not about this
 * boundary. Arms that are not objects have no contract keys at all, so they
 * contribute none.
 * {@link OPTIONAL_KEY_ON_ONE_ARM_OF_A_UNION} is the control that says so. It
 * is checked by `pnpm typecheck` and not by vitest, because a type-level
 * property has no runtime in which to assert it — stated here rather than
 * left to be discovered, since a check nobody can name is the shape this file
 * keeps finding.
 */
type OptionalKeysOf<T> = T extends object
  ? {
      [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never;
    }[keyof T]
  : never;

/**
 * `true` only for a type with no optional key at all.
 *
 * Half of a pair, and the half the compiler owns. serde's
 * `#[serde(skip_serializing_if = "…")]` does not drop a key and does not
 * leave it alone: it makes the key **conditional**, so the field is optional
 * on the wire and the TypeScript side has to spell it `?` or dereference
 * `undefined`. The parser's allow-list used to record that attribute as
 * leaving the key alone — a wrong answer written *inside* an allow-list,
 * which is the one thing a have-I-written-this-down posture cannot find,
 * because it only ever asks whether the key is listed.
 *
 * So both sides are asserted. This tuple says no contract type on this
 * boundary declares an optional key; the runtime assertion below says no Rust
 * type on this boundary carries a conditional one. Adding a `?` on the
 * TypeScript side stops this file compiling, and adding the attribute on the
 * Rust side turns the assertion red — either way somebody has to decide what
 * the pair means rather than inherit an answer.
 *
 * **Every paired type is listed, not only the object ones.** The previous
 * version carved out the string-literal unions on the grounds that they have
 * no keys to spell optional — true, and it made the list a hand-maintained
 * subset whose membership nothing could check. `HasNoOptionalKey` of a union
 * of string literals is `true`, because every member `String` declares is
 * required, so the carve-out bought nothing and cost the equality below.
 */
type HasNoOptionalKey<T> = [OptionalKeysOf<T>] extends [never]
  ? true
  : ['this contract type now spells a key optional', OptionalKeysOf<T>];

/**
 * The control for {@link OptionalKeysOf}, and the only thing standing between
 * that detector and vacuity.
 *
 * A two-arm union with an optional key on one arm — the shape a contract type
 * takes the day a backend field becomes nullable, and the shape the
 * non-distributing detector could not see. If the distribution is ever
 * removed, `HasNoOptionalKey` of this becomes `true`, `true` is not assignable
 * to the annotation, and `pnpm typecheck` fails naming this constant. Read by
 * `the optional-key detector sees one arm of a union` below, which pins the
 * value; the annotation is what pins the type.
 */
type OneArmSpellsAKeyOptional =
  | { readonly kind: 'present'; readonly body: string }
  | { readonly kind: 'absent'; readonly body?: string };

const OPTIONAL_KEY_ON_ONE_ARM_OF_A_UNION: HasNoOptionalKey<OneArmSpellsAKeyOptional> = [
  'this contract type now spells a key optional',
  'body',
];

/**
 * One value per paired contract type, carrying the type under the name the
 * pairing uses for it.
 *
 * **This exists because the list it replaces was pinned by its length.** The
 * old `NO_OPTIONAL_KEYS` was a four-element tuple of `HasNoOptionalKey<…>`
 * written out by hand, and the only runtime statement about it was
 * `toHaveLength(4)`. Replacing `HasNoOptionalKey<SkillsReadRes>` with a second
 * `HasNoOptionalKey<SkillListing>` kept the length, kept `tsc` at exit 0, kept
 * every test green — and silently stopped covering a contract type on this
 * boundary. That is round 5's *three fields and no fourth* one level up: a
 * docblock naming a key set where the test checks a number.
 *
 * So the type is not restated beside the name; it is stored under the name
 * once, and {@link NO_OPTIONAL_KEYS} is a **mapped type** over these keys, so
 * the check under each key is over the type filed under that key by
 * construction rather than by a second spelling. The key set is then compared
 * against `PAIRINGS` at runtime, which is what makes a pairing added without a
 * witness — or a witness left behind by a deleted pairing — a failure with a
 * name in its diff.
 *
 * What that leaves unpinned, said rather than implied: the association between
 * the string key and the type stored under it is written once and asserted by
 * nothing. Writing it wrong now means filing one contract type under another's
 * name in a table whose only purpose is that mapping, which is a different and
 * much smaller mistake than the duplicated tuple element it replaces.
 */
const CONTRACT_TYPES = {
  SkillProblem: undefined as unknown as SkillProblem,
  SkillListing: undefined as unknown as SkillListing,
  SkillResources: undefined as unknown as SkillResources,
  SkillsListRes: undefined as unknown as SkillsListRes,
  SkillsReadRes: undefined as unknown as SkillsReadRes,
};

const NO_OPTIONAL_KEYS: {
  readonly [K in keyof typeof CONTRACT_TYPES]: HasNoOptionalKey<(typeof CONTRACT_TYPES)[K]>;
} = {
  SkillProblem: true,
  SkillListing: true,
  SkillResources: true,
  SkillsListRes: true,
  SkillsReadRes: true,
};

const CRATE = join(process.cwd(), 'src-tauri', 'crates', 'vela-skills', 'src');

/**
 * The command layer that turns the crate's types into what the renderer reads.
 *
 * Read here, and not left to "a different boundary with its own tests", because
 * that sentence was measured and it was false for this file. The register below
 * discharged `SkillHeader` by handing its contract to `SkillsReadRes` in
 * `src-tauri/src/ipc/skills.rs`, and no inventory in this repository read that
 * file: `tag = "kind"` → `tag = "type"` there — the exact edit
 * {@link Pairing.tag}'s own documentation cites as its founding motivation —
 * made every arm of `SkillsPanel.tsx`'s `read.kind === 'invalid'` test false
 * with nothing anywhere going red. Measured on the committed tree while closing
 * it: `grep -c serde_json src-tauri/src/ipc/skills.rs` is 0, so nothing on the
 * Rust side pins those keys either, and the same byte edit is red here twice
 * now — `ipc/skills.rs::SkillsReadRes discriminant key: expected 'type' to be
 * 'kind'`.
 *
 * One file, named, rather than the whole of `src-tauri/src/ipc/`: this guard
 * owns the skills vocabulary and this is where the skills vocabulary crosses.
 * The other ipc modules belong to other boundaries, and claiming them here
 * would be the same unbacked reach in the opposite direction.
 */
const IPC_SKILLS = join(process.cwd(), 'src-tauri', 'src', 'ipc', 'skills.rs');

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

/** The name this file knows the ipc module by, in every message and register. */
const IPC_SKILLS_KEY = 'ipc/skills.rs';

const CRATE_FILES: readonly string[] = rustFilesUnder(CRATE, '', []).sort();

/** Every Rust file this guard opens: the crate as walked, plus the ipc module. */
const SCANNED_FILES: readonly string[] = [...CRATE_FILES, IPC_SKILLS_KEY];

const SOURCES: Readonly<Record<string, string>> = Object.fromEntries([
  ...CRATE_FILES.map((file) => [file, readFileSync(join(CRATE, ...file.split('/')), 'utf8')]),
  [IPC_SKILLS_KEY, readFileSync(IPC_SKILLS, 'utf8')],
]);

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
  /**
   * The wire keys of the fields inside each struct-bodied variant, keyed by the
   * variant's own wire name — `{}` for a struct, which has no variants.
   *
   * Required for the same reason {@link tag} is, and against the same class of
   * failure: these keys are members of nothing, so a comparison over members
   * cannot see them. An enum that grows a struct-bodied variant, or one whose
   * `rename_all_fields` changes, fails here rather than passing silently.
   *
   * Keyed rather than pooled, and the difference is a probe: `#[serde(skip)]`
   * on `SkillListing::Invalid`'s `directory` left a flat union unchanged,
   * because `Skill` declares `directory` too. Under a per-arm comparison the
   * arm that lost the key is named in the diff.
   */
  readonly payload: Readonly<Record<string, readonly string[]>>;
}

const PAIRINGS: readonly Pairing[] = [
  {
    rust: 'SkillProblem',
    file: 'document.rs',
    keyword: 'enum',
    ts: 'SkillProblem',
    tag: null,
    payload: {},
    listed: SKILL_PROBLEM,
  },
  {
    rust: 'SkillListing',
    file: 'store.rs',
    keyword: 'enum',
    ts: 'SkillListing',
    tag: SKILL_LISTING_TAG,
    payload: SKILL_LISTING_PAYLOAD,
    listed: SKILL_LISTING,
  },
  {
    rust: 'SkillResources',
    file: 'store.rs',
    keyword: 'struct',
    ts: 'SkillResources',
    tag: null,
    payload: {},
    listed: SKILL_RESOURCE_FIELDS,
  },
  {
    rust: 'SkillsListRes',
    file: IPC_SKILLS_KEY,
    keyword: 'struct',
    ts: 'SkillsListRes',
    tag: null,
    payload: {},
    listed: SKILLS_LIST_RES_FIELDS,
  },
  {
    rust: 'SkillsReadRes',
    file: IPC_SKILLS_KEY,
    keyword: 'enum',
    ts: 'SkillsReadRes',
    tag: SKILLS_READ_RES_TAG,
    payload: SKILLS_READ_RES_PAYLOAD,
    listed: SKILLS_READ_RES,
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
interface Registered extends SerialisableItem {
  readonly because: string;
  /**
   * The type this one's contract is discharged by, qualified as
   * `file.rs::Type`, or `null` when nothing takes it over.
   *
   * **The field exists because the sentence was not enough.** This register's
   * one entry used to say, in prose, that `src-tauri/src/ipc/skills.rs` takes
   * `SkillHeader` apart and builds `SkillsReadRes` — and nothing in this
   * repository read that file, so the hand-off was a claim rather than an edge.
   * A probe changed `tag = "kind"` to `tag = "type"` there and the whole suite
   * stayed green. Now the target has to be a type this guard really pairs, and
   * `every hand-off on the register lands on a type this guard pairs` is the
   * assertion that says so.
   */
  readonly handedTo: string | null;
}

const NOT_ON_THIS_BOUNDARY: readonly Registered[] = [
  {
    file: 'document.rs',
    keyword: 'struct',
    form: 'braced',
    rust: 'SkillHeader',
    handedTo: `${IPC_SKILLS_KEY}::SkillsReadRes`,
    because:
      'never crosses under its own name. The command layer `handedTo` names takes its two ' +
      'fields apart in `read_skill` and builds `SkillsReadRes::Skill`, whose keys are what ' +
      'the renderer reads; the contract declares no `SkillHeader` to pair it with',
  },
];

/** Sets, not sequences: declaration order is not part of the wire contract. */
function expectMembers(pairing: Pairing): void {
  const item = readRustItem(pairing.file, pairing.keyword, pairing.rust);
  const rust = wireNames(item);
  expect([...rust].sort(), `${pairing.file}::${pairing.rust} vs ${pairing.ts}`).toEqual(
    [...pairing.listed].sort(),
  );
  // The discriminant key. Not a member of anything, so it needs its own
  // comparison or it has none: the TypeScript side is closed by
  // `TagsOf<…, typeof SKILL_LISTING_TAG>`, which stops compiling if the union
  // does not carry that key, and this is the other half.
  expect(item.tag, `${pairing.file}::${pairing.rust} discriminant key`).toBe(pairing.tag);
  // The fields inside struct-bodied variants, arm by arm. Members of nothing,
  // so the comparison above cannot reach them; `rename_all_fields` renames them
  // under a rule of its own; and pooling them into one set hides a key that
  // leaves one arm while a sibling still declares it.
  expect(
    payloadWireKeys(item),
    `${pairing.file}::${pairing.rust} struct-variant payload keys, by variant`,
  ).toEqual(pairing.payload);
}

/* -------------------------------------------------------------------------- */

describe('the skills crate and the skills contract spell the same vocabulary', () => {
  it('names every key serde may leave off the wire, and there are none', () => {
    // The runtime half of `NO_OPTIONAL_KEYS`. Nothing on this boundary is
    // conditional today and nothing on it is spelled `?`; the pair is what
    // keeps those two facts the same fact.
    //
    // Membership, not length. `toHaveLength(4)` was the whole of what this
    // used to say about the list, and a list checked by its size is a list an
    // entry can be quietly unpointed inside.
    expect(Object.keys(NO_OPTIONAL_KEYS).sort()).toEqual(
      [...PAIRINGS.map((pairing) => pairing.ts)].sort(),
    );
    // And the carrier table the mapped type is built over, read at runtime as
    // well as by the compiler: the two have to name the same set, or the
    // witnesses are being taken over types nobody paired.
    expect(Object.keys(CONTRACT_TYPES).sort()).toEqual(Object.keys(NO_OPTIONAL_KEYS).sort());
    for (const pairing of PAIRINGS) {
      expect(
        conditionalWireKeys(readRustItem(pairing.file, pairing.keyword, pairing.rust)),
        `${qualified(pairing)} gained a conditional key and nothing decided what it means`,
      ).toEqual([]);
    }
  });

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
  it('accounts for every serialisable type in the files it reads', () => {
    const scanned = SCANNED_FILES.flatMap((file) => scanSerialisable(SOURCES[file] ?? '', file))
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

  /**
   * The reach of the equality above, said out loud.
   *
   * `SCANNED_FILES` is a directory walk plus one named file, and the named file
   * is the part worth asserting: it was added because the register's own
   * hand-off pointed at it and nothing read it. A refactor that drops it would
   * otherwise reopen exactly that hole with the inventory equality still green.
   */
  it('reads the whole crate and the ipc module the register hands types to', () => {
    expect(SCANNED_FILES).toEqual([...CRATE_FILES, IPC_SKILLS_KEY]);
    expect(CRATE_FILES).toContain('store.rs');
    expect(CRATE_FILES).toContain('document.rs');
    for (const file of SCANNED_FILES) {
      expect((SOURCES[file] ?? '').length, `${file} was not loaded`).not.toBe(0);
    }
  });

  /**
   * **RULE T, made checkable: the register may not discharge a type into prose.**
   *
   * An entry may point at exactly one thing, and only through a field a reader
   * checks: `handedTo`, whose target has to be a type this guard really pairs
   * and therefore carries its own assertions. Everything else on the row is a
   * statement about this type alone, and `because` is prose — read by people,
   * asserted by nothing, and forbidden from naming a file so that it cannot
   * look like the edge it is not.
   *
   * That prohibition replaces a check that was a spelling test and failed in
   * both directions: it collected `\S+\.rs` out of the sentence and demanded
   * each hit be a file this guard opened, so writing the path the way the
   * repository writes it turned the guard **red**, while writing "the
   * ipc/skills module" made the check vanish entirely and let a row discharge
   * a type into a module nothing here opens.
   */
  it('every hand-off on the register lands on a type this guard pairs', () => {
    const paired = new Set(PAIRINGS.map(qualified));
    const SCAN = (): readonly SerialisableItem[] => SCANNED_FILES.flatMap((file) => scanSerialisable(SOURCES[file] ?? '', file));
    for (const entry of NOT_ON_THIS_BOUNDARY) {
      const name = qualified(entry);
      // Reads the entry's own `keyword`, which nothing else does: a register
      // row that says `struct` for what the crate declares as an `enum` is a
      // row that was written about a different type from the one it now names.
      const scanned = SCAN().find((item) => qualified(item) === name);
      expect(scanned?.keyword, `${name} is registered as a ${entry.keyword}`).toBe(entry.keyword);
      // And its form, for the same reason: a newtype that grows a braced body
      // stops crossing as its inner value and starts putting keys of its own
      // on the wire, under a name this guard has agreed not to pair.
      expect(scanned?.form, `${name} is registered as a ${entry.form} item`).toBe(entry.form);
      if (entry.handedTo !== null) {
        expect(paired, `${name} is handed to ${entry.handedTo}, which is not paired here`).toContain(
          entry.handedTo,
        );
      }
      // RULE T, and the whole of it: a register row may point at something
      // only through a field a reader checks. Prose that names a file is
      // prose that looks like an edge and is not one, and the previous
      // version of this check — collect the `.rs` paths out of the sentence
      // and require each to be a file this guard opened — was wrong in both
      // directions at once. Spelling the path the way the repository spells
      // it turned this red; writing "the ipc/skills module" made the check
      // disappear and left a row that could discharge a type into a file
      // nobody opens. So the sentence explains, `handedTo` points, and this
      // asserts the division.
      expect(
        filePathsNamedIn(entry.because),
        `${name}'s reason names a file; a register row points through \`handedTo\`, not prose`,
      ).toEqual([]);
    }
    // The controls, so the loop above is known to be able to fail on each of
    // its three counts. The register holds one entry, and a loop over one
    // entry that happens to pass says nothing about the next one.
    expect(paired.has(`${IPC_SKILLS_KEY}::SkillsReadRes`)).toBe(true);
    expect(paired.has('document.rs::SkillHeader')).toBe(false);
    expect(filePathsNamedIn('`ipc/skills.rs` takes its two fields apart')).toEqual([
      'ipc/skills.rs',
      'skills.rs',
    ]);
    // Both spellings the old check got wrong: the repository-relative path it
    // reddened on, and the extensionless module reference it could not see.
    expect(filePathsNamedIn('src-tauri/src/ipc/skills.rs takes it apart')).toContain(
      'src-tauri/src/ipc/skills.rs',
    );
    expect(filePathsNamedIn('the ipc/no_such_module bridge takes it apart')).toEqual([
      'ipc/no_such_module',
    ]);
    expect(filePathsNamedIn('never crosses under its own name')).toEqual([]);
  });

  it('pairs each type at most once, and none vacuously', () => {
    expect(new Set(PAIRINGS.map(qualified)).size).toBe(PAIRINGS.length);
    expect(new Set(PAIRINGS.map((pairing) => pairing.ts)).size).toBe(PAIRINGS.length);
    // The anti-vacuity floor, at the table rather than per read. A pairing with
    // an empty list would compare nothing against nothing however good the
    // parser is; with a non-empty list, an empty read fails the equality in
    // `expectMembers` on its own, so no threshold is needed there.
    expect(PAIRINGS.filter((pairing) => pairing.listed.length === 0)).toEqual([]);
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

  it('the optional-key detector sees one arm of a union', () => {
    // The runtime half of {@link OPTIONAL_KEY_ON_ONE_ARM_OF_A_UNION}, and this
    // is the whole of what a runtime half can be: the value is a literal, so
    // this assertion pins what the constant says, and the **annotation** on
    // the constant is what pins that the detector still says it. The named
    // check for that half is `pnpm typecheck` — removing the distribution
    // from `OptionalKeysOf` makes `HasNoOptionalKey` of a union `true`, and
    // `true` is not assignable here, so `tsc --build --force` exits non-zero
    // naming this constant. Written down because a check that only exists in
    // another tool is exactly the kind of check this repository has twice
    // found asserted in a comment and nowhere else.
    expect(OPTIONAL_KEY_ON_ONE_ARM_OF_A_UNION).toEqual([
      'this contract type now spells a key optional',
      'body',
    ]);
    // And the other direction: a union with no optional key anywhere is still
    // `true`, so the detector is not simply answering "union".
    expect(NO_OPTIONAL_KEYS.SkillsReadRes).toBe(true);
    expect(NO_OPTIONAL_KEYS.SkillProblem).toBe(true);
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
