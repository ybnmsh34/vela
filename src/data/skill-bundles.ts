/**
 * **Bundles: a distribution format over the skill store, and nothing more.**
 *
 * A bundle groups skills that were written to be installed together. It is a
 * format, not a mechanism: everything below reads what is already on disk and
 * decides what it means. Nothing here installs, updates or removes anything,
 * and that is a fact about this commit rather than an omission — see
 * "What a bundle cannot do" below.
 *
 * ## A bundle is a skill
 *
 * The whole format rests on one decision. A bundle root is an ordinary skill
 * directory: a `SKILL.md` with the frontmatter the public Agent Skills format
 * requires, in the same store, read by the same two commands. It is not a new
 * kind of object beside skills.
 *
 * That buys every guarantee the store already proves, instead of a second
 * implementation of each:
 *
 * - It is listed by `skills_list` in name order like anything else, so a bundle
 *   is visible without a new host call and without a new pane.
 * - A bundle root whose `SKILL.md` does not parse is already listed with its
 *   `SkillProblem` rather than dropped — the precedent this format was told to
 *   follow — and that path is `src-tauri/crates/vela-skills/src/document.rs`'s,
 *   not this module's. There is no second parser to drift.
 * - Its manifest travels in the body, which `skills_read` already returns, so
 *   reading a bundle's contents costs the deliberate second call the store's
 *   progressive-disclosure model already charges for one skill's body, and
 *   **no third call**. {@link readBundle} takes a listing the caller already
 *   has; it issues nothing.
 *
 * The alternative was a manifest file of its own — a bundle.json at the store
 * root, or beside the `SKILL.md`. It was rejected on a measurement, not on
 * taste:
 * no command in `COMMAND_ALLOWLIST` (`src/platform/contract.ts`) returns the
 * bytes of any file except a skill's body. `SkillResources` carries resource
 * **names**, and `resources` in `src-tauri/crates/vela-skills/src/store.rs` says
 * of itself "Reads no file contents". So such a file would need a new Tauri
 * command, which this track was told not to build, and — more to the point — a
 * format whose manifest the application cannot read is not a format. The body is
 * not a workaround for the bridge; it is the only thing on the far side of it.
 *
 * Frontmatter was rejected for the same reason, and it is worth naming because
 * it is the obvious first idea: `parse_frontmatter` in `document.rs` does accept
 * unknown keys and one level of nesting, so a `bundle:` key with indented
 * children parses cleanly — but `parse_header` reads `name` and `description`
 * out of the entries and drops the rest, and `SkillHeader` is what becomes
 * `SkillListing` and `SkillsReadRes`. An unknown frontmatter key is accepted by
 * the host and never crosses the bridge. It would have looked like it worked.
 *
 * ## Why the directory name carries the claim
 *
 * A bundle root is named `bundle-<something>` ({@link BUNDLE_DIRECTORY_PREFIX}).
 * The prefix is what makes a directory *claim* to be a bundle, and the claim is
 * deliberately made in the one field that costs nothing to read: `skills_list`
 * gives the directory name, so a caller can tell which entries are bundles
 * without reading a single body.
 *
 * The rejected alternative was to let the manifest block itself be the claim and
 * leave naming free. It reads better and it is wrong here: finding bundles would
 * mean reading every body in the store, which is exactly the "convenience that
 * fetched every body" `src/data/skills-repository.ts` refuses in its header, and
 * it would undo the loading model the store is built on.
 *
 * Encoding membership in the name instead does not survive contact with the
 * bytes. `is_well_formed_name` in `document.rs` accepts `[a-z0-9]` runs joined by
 * **single** hyphens and nothing else, and the name must equal the directory, so
 * there is no separator left to reserve: a doubled underscore and a doubled
 * hyphen both make the directory `invalid`, and a single hyphen cannot be told
 * apart from an ordinary two-word skill name. `data-analysis` would be
 * undecidable.
 *
 * **What the prefix costs, stated here rather than discovered later.** It is a
 * reserved namespace. A user who names an ordinary skill `bundle-analyzer` has
 * named it into this format, and it is reported as a bundle with no manifest
 * ({@link BundleProblem} `manifestMissing`) rather than quietly ignored. It goes
 * on working as a skill — nothing about its row, its body or its resources
 * changes — and the cost is one honest sentence its author can act on. The
 * opposite trade, treating a missing manifest as "not really a bundle", is the
 * one that hurts: an author who mistypes the fence would watch their bundle
 * silently stop being one, with the list still rendering and nothing thrown.
 * That is the shape of defect `src/app/skills-reachable.test.tsx` calls
 * invisible from every other angle.
 *
 * ## What a bundle cannot do — the boundary, stated
 *
 * 1. **It cannot reach outside the skill store, structurally rather than by
 *    filtering.** A member name in a manifest is never joined to a path and
 *    never passed to a host command by this module. {@link readBundle} resolves
 *    a member by **string equality against the directories the host already
 *    listed**, and a name matching none of them is `missing` — the end of the
 *    road, not a lookup. A path-shaped member is not a traversal this rejects;
 *    it is a name that fails to equal any of a fixed set of strings. There is no
 *    blocklist here to be defeated by an encoding, a UNC path or an absolute
 *    one, because there is no path.
 * 2. **It cannot write.** Nothing in `COMMAND_ALLOWLIST` creates, edits or
 *    deletes anything in the skill store, so install, update and remove are not
 *    slow or unfinished here — they are unreachable from the renderer at this
 *    commit, and this module does not pretend otherwise by offering a method
 *    that would have to throw.
 * 3. **It carries no capability.** A manifest names skills. It cannot name a
 *    command, a URL, a file, a permission or an MCP server, because
 *    {@link parseBundleManifest} accepts exactly one key and refuses every other
 *    one **by name rather than by ignoring it**. A new field is a change to this
 *    file and to the reader named beside it, never something a manifest can
 *    introduce on its own.
 * 4. **It cannot change what a member skill is.** A bundle groups directories.
 *    It does not override a member's name, description, body or resources; those
 *    come from `skills_list` and `skills_read` exactly as they do for a skill
 *    nobody bundled.
 *
 * ## Every field, and what reads it (RULE U)
 *
 * The manifest has **one** key, and that is the result of asking this question
 * honestly rather than a first draft waiting to grow:
 *
 * | field | read by |
 * |---|---|
 * | `skills` | {@link readBundle}, which turns it into {@link BundleMember}s; rendered by `BundleContents` in `src/features/skills/SkillsPanel.tsx` |
 *
 * Four fields were drafted and cut, each because nothing read them:
 *
 * - `name` — the bundle root is a skill, so it already has one, and the host
 *   requires that name to equal the directory. A second name could disagree with
 *   the first, and the listing would still show the first.
 * - `description` — likewise already carried by the frontmatter and already
 *   rendered by `SkillRow`. A second one is a second place to edit and one place
 *   too many to trust.
 * - `version` — the honest reader would be an updater, and there is no write
 *   command for one to be built on (boundary 2). A version nothing compares is
 *   a column written and never read back.
 * - `homepage` / `author` — no surface renders them, and inventing the surface
 *   to justify the field is the wrong order.
 */

import type { SkillListing, SkillProblem } from '@/platform/contract';

/**
 * The reserved directory-name prefix that makes a directory claim to be a
 * bundle. Read by {@link isBundleDirectory}.
 *
 * A legal skill name under `is_well_formed_name`, deliberately: the bundle root
 * has to parse as an ordinary skill or none of the rest of this works.
 */
export const BUNDLE_DIRECTORY_PREFIX = 'bundle-';

/**
 * The info string of the fenced block that holds the manifest. Read by
 * {@link parseBundleManifest}.
 *
 * A fenced code block rather than a bare section, because the body is shown to
 * the user verbatim by `SkillsPanel` and handed to a model as instructions: a
 * fence is the one construct that reads as data in both places.
 */
export const BUNDLE_MANIFEST_FENCE = 'vela-bundle';

/**
 * The only key a manifest may carry. Read by {@link parseBundleManifest}, which
 * refuses any other key by name.
 */
export const BUNDLE_MANIFEST_KEY = 'skills';

/**
 * `NAME_MAX_CHARS` from `src-tauri/crates/vela-skills/src/document.rs`.
 *
 * Copied rather than imported — it lives in Rust — and pinned to the crate's
 * source text by `src/data/skill-bundles.test.ts`, so the copy cannot drift in
 * the silence a copied constant usually drifts in.
 */
export const SKILL_NAME_MAX_CHARS = 64;

/**
 * Why a directory that claims to be a bundle could not be read as one.
 *
 * A closed vocabulary, worded by `BUNDLE_PROBLEM_LABELS` in
 * `src/features/skills/SkillsPanel.tsx`, which is typed
 * `Record<BundleProblem, string>` so a variant added here without a sentence
 * there fails `pnpm typecheck`. That is the device `PROBLEM_LABELS` uses for
 * `SkillProblem`, and it buys the same one direction — and only that one.
 *
 * **What it does not buy, since the neighbouring vocabulary needs a parity test
 * for exactly this.** `SkillProblem` is transcribed from Rust, so a variant can
 * appear in the crate without widening the TypeScript union, and
 * `src/platform/skill-store-parity.test.ts` is what catches that. This
 * vocabulary has no Rust twin: it is defined here, produced here and worded in
 * one file. There is no second implementation that could add a variant out from
 * under the map, so the compiler is the whole guard rather than the first half
 * of one.
 *
 * Every one of these refuses the **whole manifest**. A manifest that is half
 * read is a bundle whose contents depend on which lines happened to parse, and
 * from the screen an author cannot tell "this member was dropped" from "this
 * member is not installed".
 */
export type BundleProblem =
  /** The body carries no manifest block at all. */
  | 'manifestMissing'
  /** The block is opened and the body ends before it is closed. */
  | 'manifestUnterminated'
  /** More than one block. Which one is the manifest is not a guess to make. */
  | 'manifestRepeated'
  /** A line in the block that is not `key: value`. */
  | 'manifestSyntax'
  /** A key other than {@link BUNDLE_MANIFEST_KEY} — refused, not ignored. */
  | 'manifestUnknownKey'
  /** The same key twice, as `duplicateFrontmatterKey` is for a skill. */
  | 'manifestDuplicateKey'
  /** The block parses and has no `skills` key. */
  | 'membersMissing'
  /** `skills:` with nothing after it. An empty bundle is a mistake, not a state. */
  | 'membersEmpty'
  /** A member that is not a legal skill name — which is every path-shaped one. */
  | 'memberNameNotWellFormed'
  /** The same member named twice. */
  | 'memberRepeated';

/**
 * One name from the manifest, resolved against the store.
 *
 * The three arms are the **total** partition of what a name from the manifest
 * can be: the listing either has an entry whose `directory` equals it or it does
 * not, and an entry is either the `skill` arm of {@link SkillListing} or its
 * `invalid` arm. `src/data/skill-bundles.test.ts` asserts that totality against
 * the union rather than trusting this sentence.
 *
 * `broken` is kept apart from `missing` on purpose. They look the same from a
 * distance — the member is not usable either way — and they are opposite
 * instructions: one says install it, the other says go and fix the `SKILL.md`
 * you already have. Collapsing them tells a user to install something that is
 * already sitting on their disk.
 */
export type BundleMember =
  | {
      readonly kind: 'installed';
      readonly directory: string;
      readonly name: string;
      readonly description: string;
    }
  | { readonly kind: 'broken'; readonly directory: string; readonly problem: SkillProblem }
  | { readonly kind: 'missing'; readonly directory: string };

/** What {@link readBundle} answers. `invalid` is a reading, not a throw. */
export type BundleReading =
  | {
      readonly kind: 'bundle';
      readonly directory: string;
      readonly members: readonly BundleMember[];
    }
  | { readonly kind: 'invalid'; readonly directory: string; readonly problem: BundleProblem };

/** What {@link parseBundleManifest} answers. */
export type BundleManifestReading =
  | { readonly kind: 'manifest'; readonly members: readonly string[] }
  | { readonly kind: 'invalid'; readonly problem: BundleProblem };

/**
 * Whether a directory name claims to be a bundle.
 *
 * The cheap test, and the reason the claim lives in the name: this answers from
 * a `skills_list` entry with no body read. Read by `SkillContents` in
 * `src/features/skills/SkillsPanel.tsx`.
 */
export function isBundleDirectory(directory: string): boolean {
  return directory.startsWith(BUNDLE_DIRECTORY_PREFIX);
}

/**
 * `is_well_formed_name` **and** the `NAME_MAX_CHARS` bound — the conjunction
 * `parse_header` applies, in that order, in `document.rs`.
 *
 * Folded into one predicate here because a member name is not being diagnosed,
 * only accepted or refused: this module has one problem for a name it will not
 * take where the host has two. Counting characters rather than UTF-16 units is
 * the host's rule too (`name.chars().count()`).
 */
function isUsableMemberName(name: string): boolean {
  if (name.length === 0) return false;
  if ([...name].length > SKILL_NAME_MAX_CHARS) return false;
  let previousWasHyphen = true; // a leading hyphen is a leading empty run
  for (const character of name) {
    if (character === '-') {
      if (previousWasHyphen) return false;
      previousWasHyphen = true;
    } else if ((character >= 'a' && character <= 'z') || (character >= '0' && character <= '9')) {
      previousWasHyphen = false;
    } else {
      return false;
    }
  }
  return !previousWasHyphen;
}

/** `key: value`, with the key charset `split_key_value` in `document.rs` uses. */
function splitKeyValue(line: string): readonly [string, string] | null {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const key = line.slice(0, colon).trimEnd();
  if (key.length === 0) return null;
  if (!/^[A-Za-z0-9_-]+$/u.test(key)) return null;
  return [key, line.slice(colon + 1)];
}

/**
 * The manifest, out of one skill's body.
 *
 * Pure text in, a reading out. It issues no call, touches no path and knows
 * nothing about the store — which is what lets boundary 1 in this file's header
 * be a property of the code rather than a promise: a member name has nowhere to
 * go from here except into a string comparison in {@link readBundle}.
 *
 * A `\r\n` body reads the same as a `\n` one. The store hands back whatever the
 * author's editor wrote and this project's tree has mixed line endings, so a
 * manifest that parsed on one machine and not on another would be one more
 * instance of a hazard this repo has already been bitten by three times.
 */
export function parseBundleManifest(body: string): BundleManifestReading {
  const lines = body.split(/\r?\n/u);
  const opener = '```' + BUNDLE_MANIFEST_FENCE;

  const openers: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim() === opener) openers.push(index);
  }
  if (openers.length === 0) return { kind: 'invalid', problem: 'manifestMissing' };
  if (openers.length > 1) return { kind: 'invalid', problem: 'manifestRepeated' };

  const start = openers[0];
  if (start === undefined) return { kind: 'invalid', problem: 'manifestMissing' };

  let end = -1;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === '```') {
      end = index;
      break;
    }
  }
  if (end < 0) return { kind: 'invalid', problem: 'manifestUnterminated' };

  let written: string | null = null;
  for (const raw of lines.slice(start + 1, end)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) continue;
    const pair = splitKeyValue(line);
    if (pair === null) return { kind: 'invalid', problem: 'manifestSyntax' };
    const [key, value] = pair;
    if (key !== BUNDLE_MANIFEST_KEY) return { kind: 'invalid', problem: 'manifestUnknownKey' };
    if (written !== null) return { kind: 'invalid', problem: 'manifestDuplicateKey' };
    written = value;
  }

  if (written === null) return { kind: 'invalid', problem: 'membersMissing' };
  if (written.trim().length === 0) return { kind: 'invalid', problem: 'membersEmpty' };

  const members = written.split(',').map((member) => member.trim());
  // An empty item — a doubled or trailing comma — arrives here as '' and is
  // refused by `isUsableMemberName` rather than dropped. Dropping it is how
  // `a, , b` becomes a two-skill bundle whose author believes it has three.
  for (const member of members) {
    if (!isUsableMemberName(member)) {
      return { kind: 'invalid', problem: 'memberNameNotWellFormed' };
    }
  }
  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member)) return { kind: 'invalid', problem: 'memberRepeated' };
    seen.add(member);
  }

  return { kind: 'manifest', members };
}

/**
 * One bundle: its manifest, resolved against a listing the caller already has.
 *
 * **Issues nothing.** `listing` is the `skills_list` answer the pane fetched
 * when it opened and `body` is the `skills_read` answer for this one directory,
 * so a bundle's contents appear for the price of the two calls the store already
 * makes for any skill the user clicks. A version of this that took a repository
 * and fetched what it needed would read more naturally and would put a host call
 * behind manifest text, which is the boundary this module exists to hold.
 *
 * Read by `SkillContents` in `src/features/skills/SkillsPanel.tsx`.
 */
export function readBundle(
  directory: string,
  body: string,
  listing: readonly SkillListing[],
): BundleReading {
  const manifest = parseBundleManifest(body);
  if (manifest.kind === 'invalid') {
    return { kind: 'invalid', directory, problem: manifest.problem };
  }

  const members = manifest.members.map((member): BundleMember => {
    // String equality against a fixed set of strings the host produced. Not a
    // sanitiser, not a lookup, not a path — see boundary 1 in the header.
    const found = listing.find((entry) => entry.directory === member);
    if (found === undefined) return { kind: 'missing', directory: member };
    if (found.kind === 'invalid') {
      return { kind: 'broken', directory: member, problem: found.problem };
    }
    return {
      kind: 'installed',
      directory: member,
      name: found.name,
      description: found.description,
    };
  });

  return { kind: 'bundle', directory, members };
}
