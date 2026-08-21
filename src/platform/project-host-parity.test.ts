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
 * ## Which crate this reads, and why this file is now the only one
 *
 * `src-tauri/crates/vela-skills/` used to carry a second, complete `mount`
 * module spelling this same vocabulary, and a guard named
 * skill-mount-parity.test.ts pinned the contract to *that* copy. No command
 * ever called it. The implementation behind `project_layout` and
 * `project_reconcile_skills` is `src-tauri/crates/vela-projects/`, and until
 * this file nothing pinned its wire names and nothing read its Windows branch —
 * a rename in the live crate went green through the guard whose name said
 * "skill mount".
 *
 * The duplicate is deleted and its guard is now
 * `src/platform/skill-store-parity.test.ts`, holding the part of `vela-skills`
 * that is live: the store vocabulary `skills_list` and `skills_read` really
 * answer with. **This file is the sole pin on the mount vocabulary**, which is
 * the reason to be exact about what it does and does not cover.
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

import { readCapabilitySurface } from './capability-surface';
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
import { declaredCommandsIn } from './declared-commands';
import {
  conditionalWireKeys,
  parseRustItem,
  payloadRecord,
  payloadWireKeys,
  qualified,
  filePathsNamedIn,
  moduleDeclarationsIn,
  moduleFileCandidates,
  scanDeserialiseOnly,
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
 * The same device `src/platform/chat-contract-parity.test.ts` and
 * `src/platform/skill-store-parity.test.ts` each carry, restated here for the
 * reason the second of those gives: exporting it would make one file's
 * type-level helper part of another file's public surface, and it is eight lines.
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

/**
 * The key serde puts each internally-tagged enum's discriminant under.
 *
 * Named rather than spelled inline so the same literal closes the TypeScript
 * union and is compared against the Rust container attribute. `TagsOf` stops
 * compiling if the union does not discriminate on this key; `expectMembers`
 * fails if the crate stops emitting it.
 */
const LINK_STRATEGY_TAG = 'kind';

const LINK_STRATEGY = everyVariantOf<TagsOf<LinkStrategy, typeof LINK_STRATEGY_TAG>>()([
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

const SKILL_MOUNT_STATUS_TAG = 'kind';

const SKILL_MOUNT_STATUS = everyVariantOf<TagsOf<SkillMountStatus, typeof SKILL_MOUNT_STATUS_TAG>>()([
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

const WORKING_DIRECTORY_TAG = 'kind';

const WORKING_DIRECTORY = everyVariantOf<TagsOf<WorkingDirectory, typeof WORKING_DIRECTORY_TAG>>()([
  'none',
  'bound',
  'unavailable',
]);

const WORKING_DIRECTORY_BINDING_TAG = 'kind';

const WORKING_DIRECTORY_BINDING = everyVariantOf<
  TagsOf<WorkingDirectoryBinding, typeof WORKING_DIRECTORY_BINDING_TAG>
>()([
  'none',
  'path',
]);

/* -- the fields inside struct-bodied variants ---------------------------- */

/**
 * **Keys that are members of nothing, and were therefore in no comparison.**
 *
 * `SkillMountStatus::Copied { path, copied_at_ms, stale }` puts three keys on
 * the wire; none of them is a variant of the enum and none is a field of a
 * struct this file pairs, so every assertion above walks past all three. It is
 * the same blindness the discriminant key had before {@link Pairing.tag}
 * existed, and it has the same consequence — a mount row rendering as though
 * it had never been copied.
 *
 * Four of the enums below carry `rename_all_fields`, which is a *different*
 * attribute from the `rename_all` that renames the variants. Flipping one from
 * `camelCase` to `PascalCase` changes no identifier and no variant name, and
 * until these lists existed nothing in this file could see it.
 *
 * Each list is closed by the compiler against the TypeScript union — every key
 * of every arm, minus the tag — and compared against what the crate spells.
 */
/** The keys of one arm of an internally tagged union, without the tag itself. */
type ArmFieldsOf<U, T extends PropertyKey, V> = Exclude<
  keyof Extract<U, Record<T, V>> & string,
  T
>;

/**
 * Accepts a record only when it names every arm of `U` and, for each, every
 * field of that arm exactly once.
 *
 * A flat list of *every key of every arm* is not a weaker version of this; it
 * is a different question, and one a probe walked through. Both
 * `SkillMountStatus::Linked` and `::Copied` declare `path`, so a `path` that
 * stops crossing on one of them leaves the pooled union exactly as it was.
 * Keyed by arm, the diff names the arm that lost it.
 *
 * Same device as {@link everyVariantOf} and restated for the same reason: a
 * type-level check with an identity function under it is the same check in
 * every copy of it.
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
    // ones that carry fields are *compared*, because a unit arm puts no key on
    // the wire and the Rust side has no entry for it.
    payloadRecord(record as Record<string, readonly string[]>);
}

const LINK_STRATEGY_PAYLOAD = everyFieldOfEveryArm<LinkStrategy, typeof LINK_STRATEGY_TAG>()({
  symlink: [],
  junction: [],
  copy: ['reason'],
});

const SKILL_MOUNT_STATUS_PAYLOAD = everyFieldOfEveryArm<
  SkillMountStatus,
  typeof SKILL_MOUNT_STATUS_TAG
>()({
  linked: ['link', 'path'],
  copied: ['path', 'copiedAtMs', 'stale'],
  unavailable: ['problem'],
});

const WORKING_DIRECTORY_PAYLOAD = everyFieldOfEveryArm<
  WorkingDirectory,
  typeof WORKING_DIRECTORY_TAG
>()({
  none: [],
  bound: ['path', 'writable'],
  unavailable: ['path', 'problem'],
});

const WORKING_DIRECTORY_BINDING_PAYLOAD = everyFieldOfEveryArm<
  WorkingDirectoryBinding,
  typeof WORKING_DIRECTORY_BINDING_TAG
>()({
  none: [],
  path: ['path'],
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
 * every union, unconditionally, for any edit. Four of the seven entries this
 * guard used to list named unions — `LinkStrategy`, `SkillMountStatus`,
 * `WorkingDirectory` and `WorkingDirectoryBinding` — so more than half of the
 * device was inert while three sentences in the repository said it was
 * load-bearing.
 *
 * `T extends object ? … : never` makes the mapped type run once per arm, so
 * the answer is the union of every arm's optional keys. `object` rather than
 * `unknown` because a distributed `keyof` over an arm that is a *string
 * literal* asks about `String`'s own members, several of which the TypeScript
 * lib declares optional — measured, not supposed. Arms that are not objects
 * have no contract keys at all, so they contribute none.
 * {@link OPTIONAL_KEY_ON_ONE_ARM_OF_A_UNION} is the control that says the
 * distribution is really there. It is checked by `pnpm typecheck` and not by
 * vitest, because a type-level property has no runtime in which to assert it.
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
 * subset whose membership nothing could check. {@link OptionalKeysOf} answers
 * `never` for them now, so the carve-out costs nothing and the list can be an
 * equality against the pairing table.
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
 * removed, `HasNoOptionalKey` of this becomes `true`, the two-element tuple
 * written below is not assignable to `true`, and `tsc --build --force` exits
 * 2 on this construct. Measured rather than asserted, twice per guard, by
 * reverting `OptionalKeysOf` to the non-distributing form: the message is
 * `error TS2322: Type 'string[]' is not assignable to type 'true'`, reported
 * at the arm this type declares `reason` on.
 *
 * **The previous shape of this control could not fail, and its docblock said
 * it could.** Both arms declared `body`, so `keyof T` — which for a union is
 * the keys common to every arm — kept it, `Pick` preserved the `?` on the arm
 * that had one, and the answer was `'body'` with the distribution and without
 * it. Measured twice in each guard by reverting `OptionalKeysOf` to the exact
 * non-distributing form named above: **zero** errors at this constant, in
 * either guard, in either run, and the vitest test named for it 2/2 green. The
 * loss was caught only incidentally, by the string-literal-union entries in
 * `NO_OPTIONAL_KEYS` — so a `CONTRACT_TYPES` table of interfaces would have
 * caught nothing at all. That is round 3's shape at the type level: a check
 * named for a property it does not check.
 *
 * The key is on **one** arm now and named on neither other. `keyof T` without
 * the distribution is `'kind'` alone, `OptionalKeysOf` is `never`,
 * `HasNoOptionalKey` is `true`, and `true` is not a two-element tuple. Read by
 * `the optional-key detector sees one arm of a union` below, which pins the
 * value; the annotation is what pins the type.
 */
type OneArmSpellsAKeyOptional =
  | { readonly kind: 'present'; readonly body: string }
  | { readonly kind: 'absent'; readonly reason?: string };

const OPTIONAL_KEY_ON_ONE_ARM_OF_A_UNION: HasNoOptionalKey<OneArmSpellsAKeyOptional> = [
  'this contract type now spells a key optional',
  'reason',
];

/**
 * One value per paired contract type, carrying the type under the name the
 * pairing uses for it.
 *
 * **This exists because the list it replaces was pinned by its length.** The
 * old `NO_OPTIONAL_KEYS` was a seven-element tuple of `HasNoOptionalKey<…>`
 * written out by hand, and the only runtime statement about it was
 * `toHaveLength(7)`. Replacing one element with a duplicate of another kept
 * the length, kept `tsc` at exit 0, kept every test green — and silently
 * stopped covering a contract type on this boundary. That is round 5's *three
 * fields and no fourth* one level up: a docblock naming a key set where the
 * test checks a number.
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
 * nothing.
 */
const CONTRACT_TYPES = {
  SkillLinkKind: undefined as unknown as SkillLinkKind,
  LinkFallbackReason: undefined as unknown as LinkFallbackReason,
  LinkStrategy: undefined as unknown as LinkStrategy,
  SkillMountProblem: undefined as unknown as SkillMountProblem,
  SkillMountStatus: undefined as unknown as SkillMountStatus,
  SkillMount: undefined as unknown as SkillMount,
  ProjectDirectory: undefined as unknown as ProjectDirectory,
  ProjectPaths: undefined as unknown as ProjectPaths,
  ProjectLayout: undefined as unknown as ProjectLayout,
  WorkingDirectoryProblem: undefined as unknown as WorkingDirectoryProblem,
  WorkingDirectory: undefined as unknown as WorkingDirectory,
  WorkingDirectoryBinding: undefined as unknown as WorkingDirectoryBinding,
};

const NO_OPTIONAL_KEYS: {
  readonly [K in keyof typeof CONTRACT_TYPES]: HasNoOptionalKey<(typeof CONTRACT_TYPES)[K]>;
} = {
  SkillLinkKind: true,
  LinkFallbackReason: true,
  LinkStrategy: true,
  SkillMountProblem: true,
  SkillMountStatus: true,
  SkillMount: true,
  ProjectDirectory: true,
  ProjectPaths: true,
  ProjectLayout: true,
  WorkingDirectoryProblem: true,
  WorkingDirectory: true,
  WorkingDirectoryBinding: true,
};

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

function readRustItem(file: string, keyword: 'enum' | 'struct', name: string): RustItem {
  const source = SOURCES[file];
  if (source === undefined) throw new Error(`project-host-parity: ${file} is not loaded`);
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
   * added to this list without a decision about its tag does not compile. Four
   * of the enums below are internally tagged, the tag key is a member of
   * nothing, and until this field existed nothing compared it — so
   * `tag = "kind"` could become `tag = "type"` on any of them, every
   * `strategy.kind` / `status.kind` / `workingDirectory.kind` test in the
   * renderer go false, and this file stay green.
   */
  readonly tag: string | null;
  /**
   * The wire keys of the fields inside each struct-bodied variant, keyed by
   * that variant's own wire name — `{}` for an item that has none.
   *
   * Required for the same reason {@link tag} is, and against the same class of
   * failure. These keys are members of nothing, so a comparison over members
   * cannot reach them; an enum that grows a struct-bodied variant, or whose
   * `rename_all_fields` changes, fails here instead of passing silently.
   *
   * Keyed rather than pooled. A flat union over every arm is blind to a key
   * moving between arms and to a key leaving one arm while a sibling still
   * declares it — `SkillMountStatus::Linked` and `::Copied` both declare
   * `path`, so under a pooled set `Copied` could stop sending it and the set
   * would not move.
   */
  readonly payload: Readonly<Record<string, readonly string[]>>;
}

const PAIRINGS: readonly Pairing[] = [
  {
    rust: 'SkillLinkKind',
    file: 'link.rs',
    keyword: 'enum',
    ts: 'SkillLinkKind',
    payload: {},
    tag: null,
    listed: SKILL_LINK_KIND,
  },
  {
    rust: 'LinkFallbackReason',
    file: 'link.rs',
    keyword: 'enum',
    ts: 'LinkFallbackReason',
    payload: {},
    tag: null,
    listed: LINK_FALLBACK_REASON,
  },
  {
    rust: 'LinkStrategy',
    file: 'link.rs',
    keyword: 'enum',
    ts: 'LinkStrategy',
    payload: LINK_STRATEGY_PAYLOAD,
    tag: LINK_STRATEGY_TAG,
    listed: LINK_STRATEGY,
  },
  {
    rust: 'SkillMountProblem',
    file: 'mount.rs',
    keyword: 'enum',
    ts: 'SkillMountProblem',
    payload: {},
    tag: null,
    listed: SKILL_MOUNT_PROBLEM,
  },
  {
    rust: 'SkillMountStatus',
    file: 'mount.rs',
    keyword: 'enum',
    ts: 'SkillMountStatus',
    payload: SKILL_MOUNT_STATUS_PAYLOAD,
    tag: SKILL_MOUNT_STATUS_TAG,
    listed: SKILL_MOUNT_STATUS,
  },
  {
    rust: 'SkillMount',
    file: 'mount.rs',
    keyword: 'struct',
    ts: 'SkillMount',
    payload: {},
    tag: null,
    listed: SKILL_MOUNT_FIELDS,
  },
  {
    rust: 'ProjectDirectory',
    file: 'layout.rs',
    keyword: 'enum',
    ts: 'ProjectDirectory',
    payload: {},
    tag: null,
    listed: PROJECT_DIRECTORY,
  },
  {
    rust: 'ProjectPaths',
    file: 'layout.rs',
    keyword: 'struct',
    ts: 'ProjectPaths',
    payload: {},
    tag: null,
    listed: PROJECT_PATHS_FIELDS,
  },
  {
    rust: 'ProjectLayout',
    file: 'layout.rs',
    keyword: 'struct',
    ts: 'ProjectLayout',
    payload: {},
    tag: null,
    listed: PROJECT_LAYOUT_FIELDS,
  },
  {
    rust: 'WorkingDirectoryProblem',
    file: 'workdir.rs',
    keyword: 'enum',
    ts: 'WorkingDirectoryProblem',
    payload: {},
    tag: null,
    listed: WORKING_DIRECTORY_PROBLEM,
  },
  {
    rust: 'WorkingDirectory',
    file: 'workdir.rs',
    keyword: 'enum',
    ts: 'WorkingDirectory',
    payload: WORKING_DIRECTORY_PAYLOAD,
    tag: WORKING_DIRECTORY_TAG,
    listed: WORKING_DIRECTORY,
  },
  {
    rust: 'WorkingDirectoryBinding',
    file: 'workdir.rs',
    keyword: 'enum',
    ts: 'WorkingDirectoryBinding',
    payload: WORKING_DIRECTORY_BINDING_PAYLOAD,
    tag: WORKING_DIRECTORY_BINDING_TAG,
    listed: WORKING_DIRECTORY_BINDING,
  },
];

/**
 * The serialisable types in this crate that the renderer boundary deliberately
 * does not pair, each with the reason.
 *
 * Empty, and that is a statement rather than an oversight: every type in this
 * crate deriving `Serialize` is paired above. `CaseFolding`, `MountOccupant`
 * and `WorkingDirectoryRefusal` derive no `Serialize` and put no keys on the
 * wire, so the scanner does not offer them here.
 *
 * A register, not a suppression list: its purpose is to make the count of
 * *unaccounted* types exactly zero, so the assertion below can be an equality
 * rather than a threshold.
 */
interface Registered extends SerialisableItem {
  readonly because: string;
  /**
   * The type this one's contract is discharged by, qualified as
   * `file.rs::Type`, or `null` when nothing takes it over.
   *
   * Empty register or not, the field is here because the sibling guard's
   * register was caught doing the thing it forbids: discharging a type with a
   * sentence that pointed at a Rust file no inventory read, so the hand-off was
   * a claim and not an edge. `every hand-off on the register lands on a type
   * this guard pairs` is what turns the sentence into something checkable, and
   * it has to exist before the first entry does, not after.
   */
  readonly handedTo: string | null;
}

/** A file that attaches two modules from elsewhere and opens one inline. */
const MODULE_DECLARATION_FIXTURE = [
  'pub mod wire;',
  'pub(crate) mod r#gen;',
  'mod tests { }',
  '',
].join('\n');

/** A type whose wire keys are written by an impl body rather than derived. */
const HAND_WRITTEN_SERIALIZE_FIXTURE = [
  'pub struct Wired { pub scripts: Vec<String> }',
  '',
  'impl Serialize for Wired {',
  '    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {',
  '        use serde::ser::SerializeStruct;',
  '        let mut row = s.serialize_struct("Wired", 1)?;',
  '        row.serialize_field("Scripts", &self.scripts)?;',
  '        row.end()',
  '    }',
  '}',
  '',
].join('\n');

/**
 * A type that can be built from the wire and cannot be put on it — the shape
 * an inventory keyed on the token `Serialize` cannot see.
 */
const DESERIALISE_ONLY_FIXTURE = [
  '#[derive(Debug, Clone, Deserialize)]',
  '#[serde(rename_all = "camelCase")]',
  'pub struct Request {',
  '    pub skill_name: String,',
  '}',
  '',
].join('\n');

const NOT_ON_THIS_BOUNDARY: readonly Registered[] = [];

/** Sets, not sequences: declaration order is not part of the wire contract. */
function expectMembers(pairing: Pairing): void {
  const item = readRustItem(pairing.file, pairing.keyword, pairing.rust);
  const rust = wireNames(item);
  expect([...rust].sort(), `${pairing.file}::${pairing.rust} vs ${pairing.ts}`).toEqual(
    [...pairing.listed].sort(),
  );
  // The discriminant key. Not a member of anything, so it needs its own
  // comparison or it has none: the TypeScript side is closed by
  // `TagsOf<…, typeof X_TAG>`, which stops compiling if the union does not
  // carry that key, and this is the other half.
  expect(item.tag, `${pairing.file}::${pairing.rust} discriminant key`).toBe(pairing.tag);
  // The fields inside struct-bodied variants, arm by arm. Members of nothing,
  // so the comparison above cannot reach them; serde renames them under
  // `rename_all_fields`, which is not the attribute that renames the variants;
  // and pooling them into one set hides a key that leaves one arm while a
  // sibling still declares it.
  expect(
    payloadWireKeys(item),
    `${pairing.file}::${pairing.rust} struct-variant payload keys, by variant`,
  ).toEqual(pairing.payload);
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
  it('names every key serde may leave off the wire, and there are none', () => {
    // The runtime half of `NO_OPTIONAL_KEYS`. Nothing on this boundary is
    // conditional today and nothing on it is spelled `?`; the pair is what
    // keeps those two facts the same fact.
    //
    // Membership, not length. `toHaveLength(7)` was the whole of what this
    // used to say about the list, and a list checked by its size is a list an
    // entry can be quietly unpointed inside.
    expect(Object.keys(NO_OPTIONAL_KEYS).sort()).toEqual(
      [...PAIRINGS.map((pairing) => pairing.ts)].sort(),
    );
    // And the carrier table the mapped type is built over, read at runtime as
    // well as by the compiler: the two have to name the same set, or the
    // witnesses are being taken over types nobody paired.
    expect(Object.keys(CONTRACT_TYPES).sort()).toEqual(Object.keys(NO_OPTIONAL_KEYS).sort());
    // The control for the detector itself. Its named check is `pnpm
    // typecheck`: without the distribution in `OptionalKeysOf`,
    // `HasNoOptionalKey` of a union is `true` and this constant stops
    // compiling.
    expect(OPTIONAL_KEY_ON_ONE_ARM_OF_A_UNION).toEqual([
      'this contract type now spells a key optional',
      'reason',
    ]);
    expect(NO_OPTIONAL_KEYS.WorkingDirectory).toBe(true);
    for (const pairing of PAIRINGS) {
      expect(
        conditionalWireKeys(readRustItem(pairing.file, pairing.keyword, pairing.rust)),
        `${qualified(pairing)} gained a conditional key and nothing decided what it means`,
      ).toEqual([]);
    }
  });

  // This comment used to read "the renderer words every one of these, and its
  // switches are exhaustive". That is true of the sibling guard's
  // `SkillProblem`, whose fourteen spellings are the keys of `PROBLEM_LABELS`
  // in `src/features/skills/SkillsPanel.tsx`; it was transplanted onto a
  // boundary the renderer does not read. Nothing under `src/features/` or
  // `src/app/` names `SkillMountProblem` or `SkillMountStatus` at all, and five
  // of the six problem spellings appear nowhere there either. The sixth,
  // `nameIsNotASinglePathSegment`, does appear — as a key of `PROBLEM_LABELS`
  // in `src/features/skills/SkillsPanel.tsx`, which is typed
  // `Record<SkillProblem, string>` over the *document* union from
  // `contract.ts`. The two unions share that one spelling and nothing else; the
  // label is not wording this type.
  //
  // So the stake here is one step earlier and it is still a stake: this is the
  // vocabulary the host will send, closed by `everyVariantOf` on the TypeScript
  // side and by the crate on the Rust side. Nothing renders it yet, which means
  // nothing would go red on the day the two drifted — this loop is the only
  // thing that would. The first renderer to word these is entitled to a list
  // that is the crate's list, and a boundary nobody reads is exactly where
  // drift accumulates unobserved.
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
   * **equality**, not a threshold: `expect(PAIRINGS.length).toBeGreaterThan(11)`
   * would be a measurement wearing a bound, passing for any list long enough
   * and unable to name which pairing vanished. An equality against what is
   * really in the crate fails on a deleted pairing *and* on a serialisable type
   * nobody remembered to list, and its diff names both. It needs no anti-vacuity
   * floor of its own: a scanner that read nothing would put an empty list
   * against twelve accounted names, which is the loudest failure in the file.
   *
   * `CRATE_FILES` is a directory read, not a literal, so a type added in a
   * module nobody enumerated is inside this question too.
   */
  it('accounts for every serialisable type in the crate', () => {
    const scanned = CRATE_FILES.flatMap((file) => scanSerialisable(SOURCES[file] ?? '', file))
      .map(qualified)
      .sort();
    const accounted = [...PAIRINGS.map(qualified), ...NOT_ON_THIS_BOUNDARY.map(qualified)].sort();
    expect(scanned, 'a serialisable type is neither paired nor on the register').toEqual(accounted);
  });

  /**
   * **The premise a directory walk gets for free, and a named file list does
   * not.**
   *
   * Both adversaries landed the same construction against both of the guards
   * that name their files: `pub mod wire;` at the head of
   * `vela-providers/src/model.rs` with a `#[derive(Serialize)]` struct in a new
   * wire module beside it, and `pub mod extra;` at the head of
   * `src-tauri/src/ipc/skills.rs` with one in an extra module beside that. Live wire
   * keys crossed with every assertion here green and no entry on any register,
   * because the inventory equality compares a scan of a list against a
   * register, and both sides move together when the list is short.
   *
   * The two crate-walking guards were never open to it — without `#[path]` a
   * `mod x;` always resolves under the walked directory — so this is the
   * premise they have, written down and asserted for the guards that do not.
   * It is the same sentence `#[path]` is refused for: *the source read is not
   * the source rustc compiles*.
   */
  /**
   * **The other direction of the bridge, which an inventory built on the token
   * `Serialize` cannot see at all.**
   *
   * An adversary renamed one field of a live `Deserialize`-only request type in
   * a file one of these guards opens by name, and every assertion in the
   * repository stayed green: `Deserialize` does not contain the token
   * `Serialize`, so the type was on no inventory, on no pairing and on no
   * register, and the equality named *"accounts for every serialisable type in
   * the files it reads"* was satisfied without it. The renderer would keep
   * sending the old key, the host would demand the new one, and every call on
   * that command would be an invalid payload.
   *
   * This guard's files declare none today, so the equality is against an empty
   * list — which is exactly the shape that has to be controlled, and is.
   */
  it('accounts for every deserialisation-only type in the files it reads', () => {
    const scanned = CRATE_FILES.flatMap((file) => scanDeserialiseOnly(SOURCES[file] ?? '', file)).map(qualified).sort();
    expect(scanned, 'a deserialisation-only type is on no list here').toEqual(
      [],
    );
    // The control, and it carries the whole weight when the list above is
    // empty: the scan has to be able to find one.
    expect(
      scanDeserialiseOnly(DESERIALISE_ONLY_FIXTURE, 'fixture.rs').map(qualified),
    ).toEqual(['fixture.rs::Request']);
    // And it must not double-count: a type that crosses both ways is already
    // on the serialisable inventory under the same name.
    const both = DESERIALISE_ONLY_FIXTURE.replace('Deserialize)', 'Serialize, Deserialize)');
    expect(scanDeserialiseOnly(both, 'fixture.rs')).toEqual([]);
    expect(scanSerialisable(both, 'fixture.rs').map(qualified)).toEqual(['fixture.rs::Request']);
  });

  it('reads every module the files it scans attach', () => {
    for (const file of CRATE_FILES) {
      for (const module of moduleDeclarationsIn(SOURCES[file] ?? '')) {
        const candidates = moduleFileCandidates(file, module);
        expect(
          candidates.some((candidate) => (CRATE_FILES as readonly string[]).includes(candidate)),
          `${file} attaches \`mod ${module};\` and this guard reads neither ` +
            candidates.join(' nor '),
        ).toBe(true);
      }
    }
    // The controls, because a reader that found no module would satisfy the
    // loop above without reading anything, and on this guard's files it may
    // legitimately find none. Both halves are fabricated so that either one
    // going blind is a named failure here rather than silence up there.
    expect(moduleDeclarationsIn(MODULE_DECLARATION_FIXTURE)).toEqual(['wire', 'gen']);
    expect(moduleFileCandidates('model.rs', 'wire')).toEqual([
      'model/wire.rs',
      'model/wire/mod.rs',
    ]);
    expect(moduleFileCandidates('lib.rs', 'store')).toEqual(['store.rs', 'store/mod.rs']);
    expect(moduleFileCandidates('ipc/skills.rs', 'extra')).toEqual([
      'ipc/skills/extra.rs',
      'ipc/skills/extra/mod.rs',
    ]);
  });

  /**
   * **A hand-written `Serialize` impl puts whatever keys its body writes on
   * the wire, and nothing in this repository reads an impl body.**
   *
   * That sentence is `serializeImplTarget`'s stated reason for existing and it
   * is written three times in `serde-wire.ts`. Until this round it had no
   * reader: an adversary dropped `Serialize` from `store.rs::SkillResources`'s
   * derive list, hand-wrote an impl calling `serialize_field("Scripts", …)`,
   * and every guard stayed green — the impl scan found the type, which is what
   * kept it on the inventory, and the comparison then read the *declared*
   * field identifiers. The keys crossing were `Scripts`/`References`/`Assets`,
   * verbatim the edit `serde-wire.ts`'s header cites as its founding
   * measurement.
   *
   * So a paired type has to be derive-serialised. There is no hand-written
   * impl in any file these guards read today, so this costs nothing and the
   * door is shut; a type that grows one has to go on the register, or the impl
   * body has to be read.
   */
  it('pairs no type whose Serialize impl is hand-written', () => {
    const paired = new Set(PAIRINGS.map(qualified));
    const seen = (CRATE_FILES.flatMap((file) => scanSerialisable(SOURCES[file] ?? '', file))).filter((item) => paired.has(qualified(item)));
    for (const item of seen) {
      expect(
        item.serialisedBy,
        `${qualified(item)} is paired against its declared members and its \`Serialize\` ` +
          `impl is hand-written, so the keys on the wire are whatever that body writes`,
      ).toBe('derive');
    }
    // The floor that says the loop looked at every pairing rather than none.
    expect(seen.map(qualified).sort()).toEqual([...paired].sort());
    // And the control: the assertion has to be able to fail.
    expect(
      scanSerialisable(HAND_WRITTEN_SERIALIZE_FIXTURE, 'fixture.rs').map(
        (item) => item.serialisedBy,
      ),
    ).toEqual(['manual']);
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
  // The register here is empty, so the loop runs zero times today; it is the
  // shape of the next entry that is being fixed, and `the register check can
  // fail` below shows the loop is able to.
  it('every hand-off on the register lands on a type this guard pairs', () => {
    const paired = new Set(PAIRINGS.map(qualified));
    const SCAN = (): readonly SerialisableItem[] => CRATE_FILES.flatMap((file) => scanSerialisable(SOURCES[file] ?? '', file));
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
        expect(paired, `${name} is handed to ${entry.handedTo}, which is not paired`).toContain(
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
  });

  it('the register check can fail', () => {
    // The control the empty register would otherwise leave missing. Both
    // failure modes, on fabricated entries: a hand-off to a type that is not
    // paired, and a reason naming a file this guard does not open.
    const paired = new Set(PAIRINGS.map(qualified));
    expect(paired.has('layout.rs::ProjectLayout')).toBe(true);
    expect(paired.has('ipc/project.rs::ProjectLayoutRes')).toBe(false);
    expect(filePathsNamedIn('handed to `src-tauri/src/ipc/project.rs`, which converts')).toEqual([
      'project.rs',
      'src-tauri/src/ipc/project.rs',
    ]);
    // The spelling that used to slip through: a module named without its
    // extension. Both are refused now, because neither is an edge.
    expect(filePathsNamedIn('handed to the ipc/project module, which converts')).toEqual([
      'ipc/project',
    ]);
    expect(filePathsNamedIn('crosses as a bitset, not as names')).toEqual([]);
  });

  it('pairs each type at most once, and none vacuously', () => {
    expect(new Set(PAIRINGS.map(qualified)).size).toBe(PAIRINGS.length);
    expect(new Set(PAIRINGS.map((pairing) => pairing.ts)).size).toBe(PAIRINGS.length);
    // The anti-vacuity floor, at the table rather than per read. A pairing
    // with an empty list would compare nothing against nothing however good the
    // parser is; with a non-empty list, an empty read fails the equality inside
    // `expectMembers` on its own.
    expect(PAIRINGS.filter((pairing) => pairing.listed.length === 0)).toEqual([]);
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
    //
    // **Over the union, not over one filename.** This read
    // `src-tauri/capabilities/main.json` by name. The build reads all of
    // `src-tauri/capabilities/` and selects from it with
    // `app.security.capabilities`, so a second capability file was invisible
    // here — and a plugin permission in that second file would have been too.
    // `src/platform/capability-surface.ts` derives what the build would load.
    // What this loop asserts has not changed; what it asserts it over has.
    //
    // Every loaded capability, not only the ones aimed at the main window:
    // `src-tauri/tauri.conf.json` declares exactly one window, so a capability
    // carrying an `fs:` permission is a finding whatever label it names — either
    // it reaches the renderer or it is a filesystem grant sitting in the tree
    // waiting for a label to be renamed onto it.
    //
    // **This stays a prefix check** and does not become a second copy of the
    // exact set in `src/app/shell/window-controls.test.tsx`. The two catch
    // different mutations. That one catches a widening *inside* the `core:`
    // namespace, which this loop waves through; this one catches a permission
    // from a plugin nobody here has heard of, with no list for anyone to forget
    // to update, so it still fails in the same commit that edits that list.
    const permissions = readCapabilitySurface(process.cwd()).loaded.flatMap(
      (capability) => capability.permissions,
    );

    expect(permissions.length).toBeGreaterThan(0);
    for (const permission of permissions) {
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
