/**
 * THE PROJECT CONTRACT — the durable container a conversation belongs to, and
 * the three places on disk that belong to it.
 *
 * A project is a name, some instructions, a set of enabled skills, and up to
 * three directories: the user's **working directory**, Vela's **private agent
 * workspace**, and the **skills mount** the workspace reads skills through.
 * This file declares all of it and implements none of it.
 *
 * ## What this file is not
 *
 * **It is not wired to anything, and no comment below may imply otherwise.**
 * `src/platform/contract.ts` is the live IPC contract: a name becomes a real
 * command by appearing in its `COMMAND_ALLOWLIST` *and* in `generate_handler!`
 * in `src-tauri/src/lib.rs`, and two tests hold that pairing
 * (`rust_and_typescript_allowlists_are_identical` and
 * `src-tauri/tests/handler_binding.rs`). Nothing here is on either list. The
 * shapes in {@link ProjectCommands} are the agreed payloads for commands that
 * do not exist yet; calling one today fails with `UNKNOWN_COMMAND` at the
 * renderer, before it reaches the host.
 *
 * There is likewise no parity test for this file. `contract.ts`'s chat shapes
 * are pinned to Rust by `src/platform/chat-contract-parity.test.ts`; this file
 * has no counterpart, and cannot have one until there is Rust to compare it
 * against. Every rule stated below is therefore **unenforced** unless the
 * sentence naming it also names the thing that enforces it. That phrasing is
 * deliberate and `src/platform/claimed-guards.test.ts` is why: a comment naming
 * a guard that does not exist is worse than no guard at all, because every
 * later builder reads the claim and builds on it.
 *
 * ## One dependency this contract does not have yet
 *
 * `ConversationSummary` in `src/platform/contract.ts` carries **no project
 * id**. Everything below that relates a conversation to a project —
 * {@link ProjectSummary.conversationCount}, {@link ProjectSummary.lastActiveAtMs},
 * `project_move_conversation`, and the reassignment rule in
 * {@link ProjectDeleteReq} — presupposes an amendment to that file adding one.
 * Until that amendment lands, those fields describe an empty relation: a host
 * that reports `conversationCount: 0` for every project is not lying, it is
 * reporting the truth about a link nobody has built.
 *
 * ## Grounding
 *
 * Designed against `docs/references/mindshub-cowork.md`. It departs from that
 * reference in **seven** places, not the four an earlier draft of this header
 * claimed, and a reader who trusted the smaller count would have stopped
 * looking three departures early. Each is argued at the type it affects rather
 * than here: the default project may be renamed; the private workspace lives
 * under the application-data directory rather than inside the user's own
 * folder; skills mount into a sibling of the workspace rather than into the
 * user's tree; the link is a junction on Windows and never a symlink; the
 * workspace boundary is redrawn around durability and secrecy rather than
 * visibility; no subdirectory inside the workspace is named at all; and Vela
 * never creates or scaffolds the working directory.
 *
 * Two of that study's honest findings are treated as warnings rather than
 * models: the reference's own project-creation path has its workspace scaffold
 * commented out, so the directory it documents may never be created; and its
 * own README points at a skills document that does not exist in its repository.
 * Both are this project's central defect class — the thing everyone believed
 * was connected, was not — so every path this contract names says who creates
 * it and when, and {@link ProjectLayout} makes "it was not there" a value the
 * host has to report rather than a state it can assume away.
 *
 * ## What this contract does not cover, said out loud rather than omitted
 *
 * `docs/vela-feature-spec.md` PRJ-1 makes project **knowledge** — uploaded
 * files, deduped blobs, an extracted-text tree — part of what a project is, and
 * PRJ-2 builds dual-mode retrieval on top of it; CWK-15 adds a Context list (a
 * local folder, a linked project, a URL). None of that is here, and
 * {@link ProjectPaths} is frozen at four fields, so a `knowledge` directory
 * arrives by amendment or not at all. That is a decision, not an oversight:
 * knowledge is an ingestion pipeline and a retrieval index before it is a
 * directory, and naming a directory here would oblige somebody to create a tree
 * that nothing yet fills — the precise defect the paragraph above describes.
 * PRJ-1's `description` field is absent for a smaller reason: a second
 * free-text field with no defined consumer is a field two surfaces word
 * differently.
 *
 * PRJ-1 also calls plain markdown on disk a hard design rule for everything
 * user-facing. {@link ProjectView.instructions} departs from it deliberately,
 * and the argument — including what PRJ-1 wanted from it — is at that field.
 *
 * ## Shared vocabulary, and where it lives
 *
 * This file is the home of two names the other two frozen contracts import
 * rather than restate: {@link ProjectId} and {@link AbsolutePath}.
 * `src/platform/contract-sandbox.ts` builds a run's filesystem scope out of
 * `AbsolutePath`s and scopes a run to a `ProjectId`;
 * `src/platform/contract-harness.ts` carries a `ProjectId` on every run. Two
 * contracts spelling the same concept two ways is a seam a builder falls
 * through, so the concept has one home and it is this one. What this file does
 * **not** own is the wire vocabulary — `Ack`, the content parts, the error
 * taxonomy — which stays in `src/platform/contract.ts`.
 *
 * ## House rules this file follows
 *
 * Every field is `readonly` and every array is `readonly T[]`. Optional
 * properties are spelled `?: T | undefined` because `exactOptionalPropertyTypes`
 * is on in `tsconfig.app.json` — which is also where `verbatimModuleSyntax`
 * makes the `import type` that conventions §2 requires non-negotiable. States
 * are discriminated unions rather than boolean pairs. Reasons the UI must word
 * are closed enums so the renderer writes every sentence a user reads: that is
 * conventions §3.2 for what may cross as an error, and §9 rule 6 for why a
 * reduction the user cannot see is the one forbidden outcome. Conventions §0
 * rule 3 — branch on a flag, never on an id — is why
 * {@link ProjectSummary.isDefault} exists at all.
 */

import type { Ack } from './contract';

/**
 * Bump when a shape here changes in a way a stubbed builder would notice.
 * Independent of `IPC_CONTRACT_VERSION`, which versions the wire: this file has
 * no wire yet, and coupling the two would force a wire bump for a change no
 * command can carry.
 */
export const PROJECT_CONTRACT_VERSION = 2;

/* -------------------------------------------------------------------------- */
/* the two names the other frozen contracts import from here                  */
/* -------------------------------------------------------------------------- */

/**
 * A project's identity.
 *
 * A plain alias rather than a branded type, for the reason `HarnessId` in
 * `src/platform/contract-harness.ts` gives for the same choice: it round-trips
 * through the store and across the bridge as a string, and a brand would buy
 * casts at every boundary without stopping the thing worth stopping — a
 * comparison against a literal, which conventions §0 rule 3 already forbids and
 * {@link ProjectSummary.isDefault} already makes unnecessary.
 *
 * The value of the alias is not type safety, it is **vocabulary**. Three frozen
 * contracts now pass this id around; a run in `src/platform/contract-harness.ts`
 * carries one, and a sandbox submit in `src/platform/contract-sandbox.ts` is
 * scoped by one. Spelled `projectId: string` in three files it is three
 * conventions that agree today; spelled `ProjectId` and imported, it is one.
 */
export type ProjectId = string;

/**
 * An absolute path on the host's own filesystem, in the platform's own form.
 *
 * `C:\Users\me\notes` on Windows, `/home/me/notes` elsewhere. Never relative,
 * never `~`-prefixed, never a URL, never percent-encoded, and never a guest
 * path inside a sandbox namespace — that last one is a different coordinate
 * system and `Mount.guestPath` in `src/platform/contract-sandbox.ts` is where it
 * is named.
 *
 * **This alias exists so the seam between this contract and the sandbox is one
 * type rather than two conventions.** A project's working directory is exactly
 * the string a sandbox run mounts, so it has to mean the same thing in both
 * files: resolved by the host — symlinks, `..`, short names, drive-relative
 * forms, all of it — before it is compared against anything or handed to a
 * mount. A caller may not assume the string it sent back is the string it sent;
 * the host answers with what it resolved.
 *
 * Not branded, for the same reason {@link ProjectId} is not. Nothing in
 * TypeScript can hold a string to being absolute; the host is what enforces it,
 * with `INVALID_PAYLOAD`, and the rules are on {@link WorkingDirectoryBinding}.
 */
export type AbsolutePath = string;

/* -------------------------------------------------------------------------- */
/* identity, and the one project that always exists                           */
/* -------------------------------------------------------------------------- */

/**
 * The default project's id, fixed and seeded rather than discovered.
 *
 * The reference does the same thing — a hardcoded `GENERAL_PROJECT_ID` for a
 * project named "general", seeded by its first migration, refusing both rename
 * and delete. Vela takes the fixed id and takes only half of the rest, and both
 * halves were decisions.
 *
 * **Taken: a sentinel row, so "no project" is not a state.** The alternative is
 * a nullable project id on every conversation, and it is expensive in a way
 * that does not show up until later: "in a project" and "loose" become two code
 * paths at every call site that reads one, they drift, and the loose path is
 * the one nobody writes a test for. One row that always exists collapses them.
 * The cost is that the row must really exist — see the seeding rule below.
 *
 * **Not taken: refusing to rename it.** What the study establishes is the
 * refusal itself — `update_project` raises on a rename of the General project —
 * and, separately, that the reference's project directory is a name-sanitised
 * child of its projects root. It records **no reason** for the refusal
 * anywhere, so the connection between those two facts is this contract's
 * inference and is marked as one rather than attributed to the source: a
 * name-derived path makes rename a directory move under running work, which is
 * a reason to refuse, and it is the only reason visible from outside.
 *
 * Vela keys every directory by id ({@link ProjectPaths}), so that inferred
 * reason cannot transfer even if it is right. If the reference had some other
 * motive it is not one this file can see or copy. What is left is a judgement
 * made here on its own merits: this is one person's machine, and telling them
 * they may not rename their own default workspace buys nothing. Renaming it is
 * ordinary. Deleting it is refused for a reason that is Vela's own and does not
 * depend on the reference at all — it is the reassignment target when any other
 * project is deleted ({@link ProjectDeleteReq}).
 *
 * **The literal is version-4 shaped on purpose.** The reference's constant ends
 * `...0001` with a zero version nibble, which is not a valid v4 UUID and will
 * be rejected by any store that validates one. This one carries the `4` and the
 * `8` variant nibble, so it survives a strict parser.
 *
 * **Do not compare against this in the renderer.** Conventions §0 rule 3 —
 * branch on a flag, never on an id. {@link ProjectSummary.isDefault} is the
 * flag, and it is carried precisely so this constant never appears in a
 * condition under `src/features/`. It is exported so the host, the store's
 * seed, and `src/platform/browser-adapter.ts`'s fake all name the same row.
 *
 * ## Who creates the row, and when
 *
 * **The store migration that introduces the projects table**, in the same
 * transaction, before any other row can reference it.
 *
 * Not lazily on first read. Two readers racing to create the fallback target
 * produce two fallback targets, and the loser's conversations are attached to a
 * project the UI never lists. Not on first launch either, for the same reason
 * plus a worse one: a launch path that creates data is a launch path that can
 * half-create it.
 *
 * **No test enforces this today** — there is no projects table yet. This rule
 * used to be a doc comment attached to no declaration, sitting between two
 * constants, which meant a builder hovering this id in an editor was told the
 * row must really exist and not who makes it.
 */
export const DEFAULT_PROJECT_ID: ProjectId = '00000000-0000-4000-8000-000000000001';

/**
 * The default project's name at seed time, and only at seed time.
 *
 * After the seed this string is worthless: the user may rename the project and
 * the record's own `name` is the only truth. Nothing may re-derive a label from
 * this constant, or a renamed default project would show one name in the list
 * and another in whatever surface re-derived it.
 */
export const DEFAULT_PROJECT_NAME = 'General';

/**
 * Longest project name the host accepts, measured in Unicode scalar values.
 *
 * Scalar values, not JavaScript's `.length`, because the renderer counts UTF-16
 * code units and Rust counts scalars: a name of emoji passes one check and
 * fails the other, and the user sees a validation error the field it came from
 * cannot explain. Both sides count the same thing or neither does.
 *
 * A name is a label, not a document — the value is generous rather than
 * meaningful, and it exists so that no list cell has to defend itself against
 * an unbounded string.
 */
export const PROJECT_NAME_MAX_CHARS = 120;

/**
 * Longest instruction text the host accepts, in Unicode scalar values.
 *
 * A guard rail, not a budget. The real limit is the model's context window and
 * that belongs to whatever assembles the prompt; this bound only stops a
 * pasted-in novel from becoming a row nobody can load. Unbounded was the
 * alternative and it fails silently — the prompt gets built, the window is
 * consumed, and the conversation degrades with no visible cause.
 */
export const PROJECT_INSTRUCTIONS_MAX_CHARS = 65_536;

/* -------------------------------------------------------------------------- */
/* the metadata record                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A project as a list surface sees it. Cheap: **no filesystem access at all**.
 *
 * That is the reason this type and {@link ProjectView} are separate rather than
 * one type with optional halves. Listing forty projects must not stat forty
 * directory trees, probe forty skill mounts, or block on a working directory
 * that lives on a network share that is currently down. Anything that needs the
 * disk is in {@link ProjectLayout} and is fetched per project, deliberately.
 *
 * Note what is **absent**: no path to the private workspace, and no mount
 * state. A field the renderer can read is a field the renderer will eventually
 * branch on, and the workspace's location is not the renderer's business.
 */
export interface ProjectSummary {
  readonly id: ProjectId;
  readonly name: string;
  /**
   * This is the seeded default. Carried rather than derived so no code under
   * `src/` ever compares against {@link DEFAULT_PROJECT_ID}, and so the one
   * place that decides what "default" means is the host.
   */
  readonly isDefault: boolean;
  /**
   * The **stored binding**, not a checked path. It may name a directory that
   * has been deleted, renamed, or is on a drive that is not plugged in.
   * Rendering it therefore says "this is where the user pointed", never "this
   * exists" — for that, ask for a {@link ProjectLayout}. `null` means the
   * project has no working directory, which is an ordinary, complete state.
   */
  readonly workingDirectoryPath: AbsolutePath | null;
  readonly createdAtMs: number;
  /**
   * When the **record** last changed: name, instructions, enabled skills, or
   * the working-directory binding. It does **not** move when a conversation
   * inside the project is added or answered. Two different questions —
   * "when did I last edit this project" and "when was this project last used" —
   * were one field in an earlier draft, and the sort order it produced could
   * not be explained to a user. {@link lastActiveAtMs} answers the second.
   */
  readonly updatedAtMs: number;
  /**
   * The most recent activity in any conversation belonging to this project, or
   * `null` when nothing has happened in it yet. Derived, never stored — a
   * stored copy is a cache with no invalidation story.
   */
  readonly lastActiveAtMs: number | null;
  /**
   * Conversations whose project id is this project's, archived or not. There is
   * no archived-conversation concept to exclude.
   */
  readonly conversationCount: number;
  /**
   * Archiving hides a project from the list and excludes it from search. It
   * touches **nothing on disk** — that is what makes "restored exactly as it
   * was" trivially true rather than a promise someone has to keep. `null` means
   * not archived; the timestamp is carried instead of a boolean so an "archived
   * 3 months ago" surface never needs a second field added later.
   */
  readonly archivedAtMs: number | null;
}

/**
 * One project in full: the summary plus the two fields a list must not carry.
 *
 * Still no filesystem access — `instructions` and `enabledSkills` are columns,
 * not files. See {@link ProjectLayout} for anything that requires the disk.
 */
export interface ProjectView {
  readonly summary: ProjectSummary;
  /**
   * The project's instructions, as the user typed them. Empty string is the
   * only spelling of "none": a nullable string would give this field two empty
   * values and every consumer a choice about which one to check.
   *
   * **Stored in the database, not as a file on disk, and this is a departure
   * from the repo's own spec rather than a gap in it.** `docs/vela-feature-spec.md`
   * PRJ-1 states it as a hard design rule: everything user-facing is plain
   * markdown on disk, *so that* it is auditable, editable in any editor,
   * diffable, and syncable by the user's own git or Syncthing, with SQLite
   * holding only derived data. That purpose is real and this field does not
   * serve it.
   *
   * What it is traded for: instructions have exactly one writer, this pane, and
   * a file mirror adds a second — the user's own editor — with no merge story,
   * so a user editing the file while the pane is open loses one of the two
   * edits silently. For *memory*, which an agent writes without being asked,
   * PRJ-1's argument is decisive and this file does not contradict it; memory
   * is not defined here at all. For a single-writer text box it is not.
   *
   * A file mirror is therefore an amendment rather than a refusal, and the
   * amendment has exactly one thing to settle: which side wins when the two
   * disagree. Until it is written, a user who wants their instructions in git
   * does not have them there, and no surface may imply otherwise.
   */
  readonly instructions: string;
  /**
   * The skills the user has enabled for this project — **intent**, not what is
   * mounted. What actually exists on disk is {@link ProjectLayout.mounts}, and
   * the two can differ: a skill can be enabled here and unmountable there.
   * Keeping intent and reality in one field would mean a failed mount silently
   * disables the skill, which is the failure mode this split exists to prevent.
   *
   * Each entry is a single path segment naming a directory in the canonical
   * skill store. This contract does not define the grammar of a skill name or
   * anything inside a skill directory; that belongs to the skills contract, and
   * restating it here would create a second source of truth that drifts.
   *
   * ## Two names that are one directory — decided here, because of Windows
   *
   * Each entry mounts at `<skillsMount>/<name>`. On the platform Vela actually
   * ships to, `['Foo', 'foo']` is two enabled skills and one directory:
   * {@link SkillMount} promises exactly one entry per enabled skill, and
   * {@link ProjectPaths.skillsMount} can hold one of those two names. An earlier
   * draft said neither which gave way nor that anything had to, so a builder
   * writing the reconcile chose privately between silently deduping — a skill
   * the user switched on that never mounts and never says so, which is the
   * silently-wrong outcome conventions §9 rule 6 forbids — reporting
   * `occupiedByUnrelatedEntry`, which misdescribes it because the occupant is
   * ours, and two mounts racing for one path.
   *
   * The sibling contract settled this class for environment variable names —
   * `src/platform/contract-sandbox.ts`, at `EnvironmentEntry`, with the refusal
   * `environmentNamesCollide` — and the answer here has the same two halves:
   *
   *  1. **The write is refused.** `project_create` and `project_update` fail
   *     with `INVALID_PAYLOAD` when two entries in this list collide under the
   *     casing rules of the volume the skills mount lives on, byte-identical
   *     duplicates included. Not deduplicated and not reordered: the user
   *     enabled two things, one of them cannot exist, and the host has no way to
   *     know which they meant. A refused write leaves the record as it was.
   *  2. **A record that already holds a colliding pair is reported, not
   *     repaired.** The first entry in this list's order mounts; every later
   *     entry that collides with an earlier one is reported `unavailable` with
   *     `nameCollidesWithAnotherEnabledSkill`. That state is reachable without
   *     any write having been accepted, which is why it is a mount problem and
   *     not only a payload rule: `%APPDATA%` is redirectable by policy and by
   *     sync clients, so a project written while the application-data directory
   *     sat on a case-sensitive volume can be read after it has moved to a
   *     case-insensitive one.
   *
   * The two halves look inconsistent — refuse in one place, pick a winner in the
   * other — and the difference is what is available to do instead. A write has a
   * user in front of it and can be refused with nothing lost. A read has no
   * user, no write to refuse, and a list whose whole promise is one entry per
   * enabled skill; dropping the loser would break that promise silently, which
   * is the outcome rule 1 exists to avoid.
   *
   * **The folding is the host's to decide and never the renderer's.**
   * JavaScript's `toLowerCase` is Unicode's locale-independent case mapping;
   * NTFS compares through an upcase table fixed when the volume was formatted;
   * a directory flagged case-sensitive on Windows, or an APFS volume formatted
   * case-sensitive, does not fold at all. Those answers differ on real names,
   * and the only one that decides whether two mounts land on one path is the
   * filesystem's. A renderer may warn about a pair it thinks looks alike; it may
   * not conclude, and it may not pre-filter the list it sends.
   */
  readonly enabledSkills: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* the working directory — the user's own files                               */
/* -------------------------------------------------------------------------- */

/**
 * Why a working directory could not be used. Closed vocabulary; the renderer
 * owns the wording, exactly as it does for the error causes in
 * `src/platform/contract.ts`.
 */
export type WorkingDirectoryProblem =
  /** Nothing at that path. Deleted, renamed, or never there. */
  | 'notFound'
  /** Something is there and it is not a directory. */
  | 'notADirectory'
  /** It exists and this process may not read it. */
  | 'permissionDenied'
  /**
   * The path resolved to a volume that is not currently attached — an unplugged
   * external drive, a disconnected network share, a cloud-sync placeholder that
   * would need a download. Distinct from `notFound` because it is expected to
   * come back, and the UI must not offer to re-pick a folder that is merely
   * asleep.
   */
  | 'volumeUnavailable';

/**
 * The working directory, resolved against the disk at the moment it was read.
 *
 * A union rather than a path plus an `exists` boolean, because the three states
 * carry different fields and a flat shape would make two of them optional and
 * let a caller read a path that means nothing.
 *
 * **Vela never creates this directory and never scaffolds into it.** The user
 * picks a folder they already have. Nothing in the project machinery — not
 * creation, not skill mounting, not deletion — writes a byte inside it. The
 * agent writes there when the user's task says to, and that is the only writer
 * this contract acknowledges. The reference is the counter-example worth naming:
 * it *creates* the project directory itself under its own data root, which
 * makes "the user's files" and "the app's files" the same tree and leaves no
 * honest answer to "what does deleting a project delete".
 */
export type WorkingDirectory =
  /** The project has no working directory. Complete and ordinary, not an error. */
  | { readonly kind: 'none' }
  | {
      readonly kind: 'bound';
      readonly path: AbsolutePath;
      /**
       * The process can write here. `false` is not a failure — a read-only
       * reference folder is a legitimate thing to point a project at — but any
       * surface offering to save into it must be disabled rather than allowed
       * to fail at the end.
       */
      readonly writable: boolean;
    }
  | {
      readonly kind: 'unavailable';
      /** The stored binding, carried so the UI can say which path is missing. */
      readonly path: AbsolutePath;
      readonly problem: WorkingDirectoryProblem;
    };

/**
 * A request to point a project at a directory, or at none.
 *
 * A union rather than `string | null`, because "leave it alone" and "clear it"
 * are different intents and a nullable field in a patch payload can only spell
 * one of them. Compare `StoreUpdateMessageReq` in `src/platform/contract.ts`,
 * which deliberately has no way to spell "set this back to nothing"; here that
 * spelling is required, so it gets a variant of its own.
 *
 * ## Paths the host must refuse, with `INVALID_PAYLOAD` (conventions §3.2)
 *
 *  1. Anything not absolute. A relative path is resolved against a working
 *     directory that differs between the host process, the agent, and whatever
 *     shell a user copied the path out of.
 *  2. Any path inside Vela's application-data directory. That directory holds
 *     `vela.db` and every project's private workspace; a working directory
 *     bound inside it would put agent file writes next to the database.
 *  3. Any path inside another project's root, for the same reason one level
 *     down.
 *
 * These three used to be a doc comment attached to nothing, immediately below
 * this type, so a builder hovering the type they were about was shown one
 * sentence and none of the rules. For a contract whose only delivery mechanism
 * is doc comments, a rule that is not attached to a declaration is a rule with
 * no reader.
 *
 * **How the user produces the string is not settled by this contract, and the
 * payload is the same either way.** A native folder picker needs the `dialog`
 * capability, which `src-tauri/capabilities/main.json` does not currently
 * grant; typing or pasting a path needs nothing. Whichever wins, it lands here
 * as an absolute path. There is also no command to reveal a folder in the OS
 * file manager, and adding one would mean granting a shell capability — do not
 * assume a "reveal" button exists to be wired up.
 *
 * ## The seam with execution
 *
 * This path is exactly what `src/platform/contract-sandbox.ts` mounts when the
 * agentic runtime runs code for this project: its `Mount.hostPath` is an
 * {@link AbsolutePath}, this is an {@link AbsolutePath}, and they are the same
 * string with the same resolution rules. A run that is meant to see the user's
 * files gets one mount built from this value and no others; a run against a
 * project whose working directory is `none` gets no mount at all and sees only
 * its own scratch directory. That mount, and the two host-owned ones beside it,
 * are built by `projectFilesystemScope` in that file — from a
 * {@link ProjectLayout}, whose {@link ProjectLayout.workingDirectory} is this
 * binding *resolved*, so a binding that currently points at nothing produces no
 * mount rather than an empty directory where the user's files should be.
 * Nothing in this contract performs that mount, and nothing here may assume it
 * happened.
 */
export type WorkingDirectoryBinding =
  | { readonly kind: 'none' }
  | { readonly kind: 'path'; readonly path: AbsolutePath };

/* -------------------------------------------------------------------------- */
/* the layout on disk                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Where a project's host-owned directories are, all absolute.
 *
 * The layout under the application-data directory Tauri resolves
 * (`app_data_dir()`, see `src-tauri/crates/vela-store/src/location.rs`, which
 * on Windows is `%APPDATA%\dev.vela.desktop`):
 *
 * ```
 * <app data dir>/
 * ├── vela.db                        the store. NOT inside any project root.
 * ├── skills/<skill-name>/           the canonical skill store, host-wide
 * └── projects/<project-id>/         one per project — the root
 *     ├── workspace/                 the private agent workspace
 *     └── skills/<skill-name>        the mount: a link back to the store
 * ```
 *
 * **Directories are keyed by id, never by name.** The reference keys by a
 * sanitised name and pays for it with a sanitiser: characters stripped, hyphen
 * runs collapsed, a 48-character cap, a table of Windows reserved device names
 * (`con`, `aux`, `com1`) to suffix around, and a containment re-check so a
 * project cannot escape the projects root. A UUID needs none of that — it is
 * already a legal filename everywhere, already unique, already collision-free
 * under case folding, and it makes rename a metadata update that moves nothing.
 * That single choice is what lets {@link DEFAULT_PROJECT_ID}'s project be
 * renamed at all.
 *
 * **Who creates the three per-project directories, and when:** the host, inside
 * `project_create`, before that command returns. All three or none — a
 * partially created project is an `IpcError`, never a success with a hole in
 * it. They are removed by `project_delete` and by nothing else. The working
 * directory appears in this list only as a *resolved* value
 * ({@link ProjectLayout.workingDirectory}); it is not a path Vela owns.
 *
 * **Who creates the fourth, and when:** {@link ProjectPaths.skillStore} is not
 * per-project and is not created by `project_create`. The host creates
 * `<app data dir>/skills` **empty, at launch, before it serves any command that
 * reads it** — which is `project_create`, `project_update` and
 * `project_reconcile_skills`, all three of which reconcile mounts. Empty is the
 * correct and expected state on a machine with no skills installed, and it has
 * exactly one observable consequence, stated here so ten builders produce the
 * same behaviour rather than two: **every enabled skill then mounts
 * `unavailable` with `skillNotFound`.** Not an error, not a refused command,
 * not a silently shortened mount list. A host that instead treats a missing
 * store as a failure, or that creates it lazily inside whichever command
 * happens to run first, produces a different UI sentence for the same disk.
 *
 * This one is deliberately outside {@link ProjectDirectory} and therefore
 * cannot appear in {@link ProjectLayout.repaired}. `repaired` answers "what did
 * reading *this project* have to fix", and a machine-wide directory is not this
 * project's to report; a per-project field that could name it would let forty
 * projects report the same repair forty times. Recreating it at launch, before
 * anything reads it, is what makes that omission safe rather than a hole.
 */
export interface ProjectPaths {
  /** `<app data dir>/projects/<project-id>`. */
  readonly root: AbsolutePath;
  /**
   * `<root>/workspace` — **the private agent workspace**, and the rules that
   * govern it.
   *
   * They were a doc comment attached to no declaration, in a section of their
   * own between {@link ProjectLayout} and the payloads. Everything below is what
   * a builder needs while looking at this path, so it is attached to this path:
   * a rule nothing declares is a rule an editor cannot show anybody.
   *
   * The reference calls its equivalent the "private agent workspace" and then
   * documents an access boundary that is not one: the agent has read/write to
   * the private directory *and* to the user's working directory, identically.
   * There, "private" only ever meant "not somewhere the user is expected to
   * look", which is not a boundary anyone can implement against.
   *
   * Vela draws the boundary around **durability and secrecy** instead, because
   * those are the two a builder can act on:
   *
   *  - **Creates:** the host, and only the host, inside `project_create` and on
   *    every {@link ProjectLayout} read that finds it missing.
   *  - **Writes:** the agent, freely, anywhere inside it. Also the host. Nothing
   *    else — no feature under `src/` writes here, because the renderer has no
   *    filesystem access at all (`src-tauri/capabilities/main.json` grants no
   *    `fs`) and getting one to write scratch files would be the wrong fix.
   *  - **Reads:** the agent and the host. The user may read it — it is an
   *    ordinary directory on their own disk and nothing hides it — but no Vela
   *    surface asks them to manage it, and no feature may require them to.
   *  - **Never contains:** any credential, token, key, or keychain material.
   *    Secret values live in the OS keychain and travel in one direction
   *    (conventions §0 rule 4; there is no `secrets_get` and there never will
   *    be). A secret written into a workspace file is a secret in a plaintext
   *    file inside a directory the agent can read back into a prompt.
   *  - **Never contains:** the only copy of anything. The workspace is
   *    **disposable**: deleting the entire directory must lose nothing the user
   *    authored and break nothing another surface depends on. Anything that
   *    fails that test belongs in the store or in the user's working directory.
   *
   * And one hazard specific to this layout: the workspace sits two levels below
   * the application-data directory, which also holds `vela.db`. "The agent may
   * write in its workspace" must never be implemented as "the agent may write
   * under the application-data directory". The containment check is on this
   * path, not on its ancestors.
   *
   * ## How a sandboxed run reaches this directory — the seam, stated once
   *
   * The agent does not write here with an ambient filesystem handle. It writes
   * through `src/platform/contract-sandbox.ts`, which is deny-by-default: a run
   * sees the union of its mounts and nothing else. So "the agent may write in
   * its workspace" is implemented as *the caller mounts this one path*, and the
   * two contracts have to agree about three things or a builder guesses at all
   * three:
   *
   *  - **What may be mounted for a run scoped to this project.** Exactly three
   *    paths, and it is the sandbox contract's `SANDBOX_PROTECTED_ROOTS` that
   *    makes the rest unreachable: this project's workspace (read-write), this
   *    project's {@link ProjectPaths.skillsMount} (**read-only, always** — see
   *    below), and the project's working directory if it has one. Another
   *    project's root is not mountable. `vela.db`, the settings, the keychain
   *    and the install are not mountable by anything, at any permission level.
   *    Those three mounts are built by `projectFilesystemScope` in that file,
   *    from a {@link ProjectLayout}, rather than by each caller from this
   *    paragraph.
   *  - **Why the workspace is mountable at all when it lives inside the
   *    application-data directory.** Because the sandbox's protected category is
   *    the *store* — the database and settings — not the whole directory that
   *    happens to contain it. A protected category drawn one level up would make
   *    the private agent workspace unreachable by the agent it exists for, which
   *    would have been discovered by a builder rather than decided by a
   *    contract.
   *  - **Why the skills mount is read-only through the sandbox.** The entries
   *    under it are junctions into the machine-wide
   *    {@link ProjectPaths.skillStore} ({@link LinkStrategy}), and every file
   *    API follows a junction transparently. A read-write mount of that
   *    directory is therefore a read-write mount of every skill on the machine,
   *    granted to model-authored code, through a path that does not look like it
   *    leads there. The sandbox contract refuses it rather than trusting each
   *    caller to remember.
   *
   * None of this is wired. Both contracts say so in their own headers, and the
   * value of writing the rule down before either exists is that the two halves
   * cannot be built to disagree.
   *
   * **This contract defines no structure inside the workspace.** Not a memory
   * directory, not an artifacts directory, not a context directory — the
   * reference names all three and this file deliberately names none, because
   * naming a path obliges someone to create it, and a path named by a contract
   * and created by nobody is precisely the defect this project exists to
   * eliminate. Whatever feature first needs a subdirectory declares it in its
   * own contract, and says who creates it and when.
   */
  readonly workspace: AbsolutePath;
  /**
   * `<root>/skills`. The mount root, a **sibling** of the workspace rather than
   * a directory inside it, and the sibling relationship is load-bearing: this
   * directory is full of links pointing at the canonical store, so anything
   * that clears the workspace — the one operation this design calls safe,
   * because the workspace is disposable — must never walk through it. Keeping
   * them siblings means "empty the workspace" cannot reach a link at all.
   */
  readonly skillsMount: AbsolutePath;
  /**
   * `<app data dir>/skills`, the canonical store the mounts point into. One
   * copy per machine, shared by every project; carried here so a UI explaining
   * a mount can name the real target instead of implying each project holds its
   * own copy of a skill.
   *
   * Created by the host at launch, not by `project_create` — see the block
   * above for why, and for what an empty store means.
   */
  readonly skillStore: AbsolutePath;
}

/**
 * The host-owned **per-project** directories, addressable one at a time.
 *
 * Three of the four fields on {@link ProjectPaths}, and `skillStore` is the
 * missing one on purpose: it is machine-wide, so it is not a thing reading one
 * project can repair or report. See the block above {@link ProjectPaths}.
 */
export type ProjectDirectory = 'root' | 'workspace' | 'skillsMount';

/**
 * How a skill directory is made visible inside a project.
 *
 * `symlink` and `junction` are both links: one target, edits to the canonical
 * skill are live everywhere. `copy` is not a link and must never be described
 * as one — see {@link SkillMountStatus}.
 */
export type SkillLinkKind = 'symlink' | 'junction';

/** Why the host fell back to copying instead of linking. */
export type LinkFallbackReason =
  /**
   * The filesystem under the application-data directory does not implement
   * directory links at all: a FAT or exFAT volume on any platform, some
   * container overlays, some network filesystems. **Not POSIX-only** — an
   * earlier draft labelled it that and then justified it with FAT/exFAT, which
   * is squarely the Windows case, and a Windows builder reading that label
   * would have reached for `junctionRefused` instead. Reparse points are an
   * NTFS feature; a `%APPDATA%` on exFAT belongs here.
   */
  | 'filesystemDoesNotSupportLinks'
  /**
   * Windows. A junction was attempted and refused. The realistic cause is a
   * redirected application-data directory: `%APPDATA%` pointed at a network
   * share by group policy, or held by a sync client that virtualises it.
   * Junctions cannot target a remote volume.
   */
  | 'junctionRefused'
  /**
   * The probe itself could not be run, so the host does not know what this
   * machine supports and took the option that always works. Distinct from the
   * refusals above because it is a statement about missing knowledge, not about
   * the filesystem — do not word it as though linking had failed.
   */
  | 'probeFailed';

/**
 * What the host will use to mount skills on this machine.
 *
 * **This is where a POSIX design fails on the platform Vela ships to, so it is
 * decided here rather than discovered per project.** Creating a symbolic link
 * on Windows needs `SeCreateSymbolicLinkPrivilege`, which ordinary user
 * accounts do not hold; the only way around it is Developer Mode plus
 * `SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE`, or running elevated. A design
 * that mounts skills with symlinks therefore works on the developer's machine
 * and fails on the user's, which is the worst available failure distribution.
 *
 * So Vela does not use symlinks on Windows **at all, ever, even when they would
 * succeed**. It uses a directory junction (`IO_REPARSE_TAG_MOUNT_POINT`, what
 * `mklink /J` makes), which any unprivileged user can create, and which every
 * file API follows transparently. Two consequences worth stating plainly:
 *
 *  - **There is no "enable Developer Mode" prompt to build.** Behaviour must not
 *    depend on a machine-wide developer setting, because then two users of the
 *    same build get different products and neither can reproduce the other's
 *    bug. This is also why {@link LinkStrategy} carries no "symlinks are
 *    available" flag: nothing may act on it.
 *  - **A junction is a reparse point, and a naive recursive delete walks
 *    through it into the canonical skill store.** Anything that removes a
 *    project root must detect reparse points and unlink rather than descend.
 *    Nothing enforces this today, and it is the single most destructive way
 *    this layout can be got wrong: one wrong delete takes every skill on the
 *    machine, not one project's copy of them.
 *
 * The strategy is established by **attempting the real operation** in a scratch
 * directory under the application-data directory once per launch, then removing
 * it — not by reading a policy key. Developer Mode being on does not guarantee
 * the process token carries the privilege, and a registry read that disagrees
 * with the filesystem is a guess dressed as a fact. That is the same lesson
 * `src-tauri/crates/vela-providers/src/private_fs.rs` was written to record: its
 * Windows branch assumed the application-data directory was already per-user,
 * the desktop gate measured it and found another installer's inherited ACE
 * granting a second local group read access, and the repair was to stop
 * assuming and start reading the result back.
 */
export type LinkStrategy =
  | { readonly kind: 'symlink' }
  | { readonly kind: 'junction' }
  | { readonly kind: 'copy'; readonly reason: LinkFallbackReason };

/** Why one skill could not be mounted, when the machine can mount others. */
export type SkillMountProblem =
  /** Enabled on the project, absent from the canonical store. */
  | 'skillNotFound'
  /**
   * The name is not a single path segment. It must be rejected **before** it
   * is joined onto a path, not after: a name containing a separator or a parent
   * reference is a directory-traversal attempt wearing a skill's clothes.
   */
  | 'nameIsNotASinglePathSegment'
  /**
   * The resulting path exceeded what the platform accepts. Real on Windows,
   * where the classic limit is 260 characters unless long paths are enabled and
   * the call opts in — and a project root is already deep before a skill name
   * is appended to it.
   */
  | 'pathTooLong'
  /** Something already occupies the mount path and is not ours to replace. */
  | 'occupiedByUnrelatedEntry'
  /**
   * An earlier entry in {@link ProjectView.enabledSkills} already mounted at
   * this path: two enabled names that are one directory under the mount
   * volume's casing rules. **Distinct from `occupiedByUnrelatedEntry`, and the
   * distinction is the whole reason this member exists** — there the occupant is
   * a stranger and the repair is the user's, here the occupant is this project's
   * own other skill and the repair is to disable one of the two. A UI told the
   * wrong one of those tells the user to go and look at a directory that is
   * exactly as Vela made it.
   *
   * The first entry in record order mounts and is not affected. See
   * {@link ProjectView.enabledSkills} for why a write cannot normally produce
   * this and how a record comes to hold one anyway.
   */
  | 'nameCollidesWithAnotherEnabledSkill'
  | 'permissionDenied';

/**
 * The state of one mounted skill.
 *
 * `copied` is a separate variant rather than a third {@link SkillLinkKind},
 * and that is the whole point of this union: a copy is a **snapshot**. Edit the
 * canonical skill and the project keeps running the old one until something
 * re-copies it. Folding it in beside the link kinds would let every consumer
 * treat all three identically, which is exactly the mistake — the UI must be
 * unable to render a copy without also being handed `copiedAtMs` and
 * {@link stale}.
 */
export type SkillMountStatus =
  | { readonly kind: 'linked'; readonly link: SkillLinkKind; readonly path: AbsolutePath }
  | {
      readonly kind: 'copied';
      readonly path: AbsolutePath;
      readonly copiedAtMs: number;
      /**
       * The canonical skill has changed since the copy was taken. Compared by
       * content, not by timestamp: a file synced onto this machine can arrive
       * with an older modification time than the copy it invalidates.
       */
      readonly stale: boolean;
    }
  | { readonly kind: 'unavailable'; readonly problem: SkillMountProblem };

/**
 * One entry in the skills mount, reported as it actually is.
 *
 * There is exactly one of these per **enabled** skill. A skill that failed to
 * mount still appears, with an `unavailable` status — dropping it from the list
 * would let a project silently run without a skill the user switched on, and
 * silently-wrong is the one forbidden outcome (conventions §9 rule 6).
 *
 * That count holds even where two enabled names are one directory: the later one
 * is an entry with `nameCollidesWithAnotherEnabledSkill`, not a missing entry
 * and not a second entry on the same path. See {@link ProjectView.enabledSkills}.
 */
export interface SkillMount {
  readonly name: string;
  /**
   * The canonical skill directory this entry points at:
   * `<skillStore>/<name>`, joined by the host.
   *
   * **`null` in exactly one case, and it is not an omission.** The
   * `nameIsNotASinglePathSegment` problem says the name must be rejected
   * *before* it is joined onto a path — a name carrying a separator or a parent
   * reference is a traversal attempt wearing a skill's clothes, and producing
   * its resolved path in order to report it would perform the very join the
   * rule forbids. So that one status has no source, and the field says so in
   * the type rather than leaving each host to pick a placeholder: an empty
   * string, the store root, and the raw name were the three a builder would
   * otherwise choose between, and all three are a path that looks real.
   *
   * Every other status — including `skillNotFound`, where the name is a legal
   * segment and the join is safe — carries the path. A UI explaining why a
   * skill is missing can name where it looked.
   */
  readonly source: AbsolutePath | null;
  readonly status: SkillMountStatus;
}

/**
 * A project's on-disk reality, as of the moment it was read.
 *
 * **Reading this repairs.** If a host-owned directory is missing — the user
 * cleaned out their application-data folder, a sync client removed it, an
 * installer moved it — the host recreates it and lists it in {@link repaired}.
 * That is safe because the workspace is disposable by construction, and it is
 * the direct answer to the reference's defect: its project-creation path has
 * the workspace scaffold **commented out**, so the directory its own
 * documentation describes may never be created, and every later reader assumes
 * it. A layout that is only correct if one function ran once, months ago, is a
 * layout that will be wrong. This one is checked on every read and says what it
 * had to fix.
 *
 * The working directory is emphatically **not** repaired. It is the user's, and
 * a missing one is reported ({@link WorkingDirectory}), never recreated —
 * conjuring an empty folder where their files used to be would look exactly
 * like data loss.
 */
export interface ProjectLayout {
  readonly projectId: ProjectId;
  readonly paths: ProjectPaths;
  readonly linkStrategy: LinkStrategy;
  readonly workingDirectory: WorkingDirectory;
  /** One per enabled skill, in the order the record lists them. */
  readonly mounts: readonly SkillMount[];
  /**
   * Host-owned directories that were missing on this read and were recreated.
   * Empty is the normal case. Non-empty is not an error and must not be
   * rendered as one, but it is worth surfacing once: a project that repairs
   * itself on every read is a project whose root something else is deleting.
   */
  readonly repaired: readonly ProjectDirectory[];
}

/* -------------------------------------------------------------------------- */
/* payloads                                                                   */
/* -------------------------------------------------------------------------- */

export interface ProjectRefReq {
  readonly projectId: ProjectId;
}

export interface ProjectRes {
  readonly project: ProjectView;
}

export interface ProjectLayoutRes {
  readonly layout: ProjectLayout;
}

export interface ProjectListReq {
  /** Defaults to `false`: archived projects are hidden unless asked for. */
  readonly includeArchived?: boolean | undefined;
}

export interface ProjectListRes {
  readonly projects: readonly ProjectSummary[];
}

/**
 * Create a project.
 *
 * Names are **not unique and are not checked for uniqueness**. Identity is the
 * id; enforcing unique names would mean rename can fail, and there is no reason
 * one person may not have two projects called "Notes". Nothing anywhere may
 * look a project up by name, and nothing may case-fold two names to compare
 * them.
 *
 * On success the three host-owned directories exist ({@link ProjectPaths}) and
 * skills are reconciled. On failure nothing was created — including no row.
 */
export interface ProjectCreateReq {
  readonly name: string;
  /** Omit for a project with no instructions, which is the normal case. */
  readonly instructions?: string | undefined;
  /** Omit to create a project with no working directory. */
  readonly workingDirectory?: WorkingDirectoryBinding | undefined;
  /**
   * Omit for none. Order is preserved and is the order mounts are reported in.
   *
   * Two entries that collide under the skills-mount volume's casing rules are
   * `INVALID_PAYLOAD`, and nothing was created — see
   * {@link ProjectView.enabledSkills} for why the refusal is not a dedupe.
   */
  readonly enabledSkills?: readonly string[] | undefined;
}

/**
 * Amend a project. An omitted field means "leave it alone".
 *
 * `enabledSkills` replaces the whole set rather than adding to it, matching
 * `StoreUpdateMessageReq`'s treatment of a message's parts in
 * `src/platform/contract.ts`: a patch that could only add would need a second
 * command to remove, and the two would race. A replacement whose entries collide
 * under the skills-mount volume's casing rules is `INVALID_PAYLOAD` and changes
 * nothing, including the fields alongside it — see
 * {@link ProjectView.enabledSkills}.
 *
 * Applying this re-reconciles the skills mount before returning, so a caller
 * that changes `enabledSkills` and then reads a {@link ProjectLayout} cannot
 * observe the old mount.
 */
export interface ProjectUpdateReq {
  readonly projectId: ProjectId;
  readonly name?: string | undefined;
  readonly instructions?: string | undefined;
  readonly workingDirectory?: WorkingDirectoryBinding | undefined;
  readonly enabledSkills?: readonly string[] | undefined;
  /**
   * `true` archives, `false` restores. A boolean rather than two commands
   * because it is one bit with no asymmetry — restoring is exactly undoing.
   * The host stamps {@link ProjectSummary.archivedAtMs} from it.
   */
  readonly archived?: boolean | undefined;
}

/**
 * Delete a project.
 *
 * Deliberately **one behaviour, with no options**:
 *
 *  - Conversations belonging to it are reassigned to {@link DEFAULT_PROJECT_ID}.
 *    They are never deleted. A user who wants them gone deletes them, with
 *    `store_delete_conversation`, having been asked.
 *  - The project root is removed — it is host-owned and disposable. **Read
 *    {@link LinkStrategy} before writing that removal.** The root contains
 *    {@link ProjectPaths.skillsMount}, which is full of reparse points into the
 *    machine-wide {@link ProjectPaths.skillStore}; a recursive delete that
 *    descends through one of them takes every skill on the machine rather than
 *    one project's view of them. The removal must detect a reparse point and
 *    unlink it rather than walk it. Nothing enforces this — there is no host
 *    code to enforce it in — and this cross-reference exists because the
 *    warning was previously written only on the type that *creates* the link,
 *    which is not the type the builder writing the delete will be reading.
 *  - The working directory is **not touched**, and no option exists to touch
 *    it. An `alsoDeleteFiles` flag is the kind of parameter that is right
 *    ninety-nine times and unrecoverable the hundredth.
 *  - A run may be executing inside this project's workspace at the moment the
 *    delete lands. This contract does not settle that race and no host exists to
 *    lose it yet; whoever wires `src/platform/contract-sandbox.ts` to a project
 *    decides whether delete refuses while a run is live or cancels it first.
 *  - Deleting {@link DEFAULT_PROJECT_ID} is refused with `INVALID_PAYLOAD`. It
 *    is the reassignment target above; there is nowhere for its conversations
 *    to go.
 *
 * Whether the UI requires unarchiving before deleting is a UI decision and is
 * not encoded here.
 */
export type ProjectDeleteReq = ProjectRefReq;

/**
 * Move one conversation into a project.
 *
 * Presupposes the project-id column on conversations that
 * `src/platform/contract.ts` does not have yet — see the header. Listed so that
 * ten builders reach for the same name and the same shape rather than inventing
 * five, not because it can be called today.
 */
export interface ProjectMoveConversationReq {
  readonly conversationId: string;
  /** The destination. Use {@link DEFAULT_PROJECT_ID} to move a conversation out. */
  readonly projectId: ProjectId;
}

/* -------------------------------------------------------------------------- */
/* the command surface — declared, not registered                             */
/* -------------------------------------------------------------------------- */

/**
 * The payload map for the project commands, in the shape `IpcContract` uses in
 * `src/platform/contract.ts`, so that merging this in later is mechanical.
 *
 * **None of these are registered and none of them work.** A command becomes
 * real by being added to `IpcContract` and `COMMAND_ALLOWLIST` in
 * `src/platform/contract.ts`, implemented in `src-tauri/src/ipc/`, listed in
 * the Rust allowlist, registered in `generate_handler!`, and implemented in
 * `src/platform/browser-adapter.ts` — the five steps in conventions §3.3. This
 * file performs none of them. Until it does, `isAllowedCommand` returns `false`
 * for every name below and the renderer refuses the call locally.
 *
 * The reason to freeze the shapes anyway is the only reason to freeze anything:
 * ten builders stubbing against `project_create` all mean the same payload.
 */
export interface ProjectCommands {
  project_create: { req: ProjectCreateReq; res: ProjectRes };
  project_delete: { req: ProjectDeleteReq; res: Ack };
  project_get: { req: ProjectRefReq; res: ProjectRes };
  project_layout: { req: ProjectRefReq; res: ProjectLayoutRes };
  project_list: { req: ProjectListReq; res: ProjectListRes };
  project_move_conversation: { req: ProjectMoveConversationReq; res: Ack };
  /**
   * Re-mount the enabled skills and report what happened. Idempotent, and
   * needed as its own command because a mount can break without the project
   * record changing — a skill deleted from the canonical store, or an
   * application-data directory moved onto a share that refuses junctions.
   */
  project_reconcile_skills: { req: ProjectRefReq; res: ProjectLayoutRes };
  project_update: { req: ProjectUpdateReq; res: ProjectRes };
}

export type ProjectCommandName = keyof ProjectCommands & string;
export type ProjectCommandReq<C extends ProjectCommandName> = ProjectCommands[C]['req'];
export type ProjectCommandRes<C extends ProjectCommandName> = ProjectCommands[C]['res'];

/**
 * The names, sorted, as plain string literals — the same discipline
 * `COMMAND_ALLOWLIST` keeps in `src/platform/contract.ts`, so that whatever
 * parses that list can parse this one when these commands are promoted.
 *
 * This is a list of names to *use consistently*, not a list of names that
 * resolve. See {@link ProjectCommands}.
 */
export const PROJECT_COMMAND_NAMES = [
  'project_create',
  'project_delete',
  'project_get',
  'project_layout',
  'project_list',
  'project_move_conversation',
  'project_reconcile_skills',
  'project_update',
] as const;

/**
 * Compile-time proof that the list above contains only names the map declares.
 *
 * The reverse direction — every declared command appears in the list — is
 * **not** checked. `src/platform/contract.test.ts` checks it at runtime for the
 * real allowlist, and this file has no test of its own; a name added to
 * {@link ProjectCommands} and forgotten here would go unnoticed. Said plainly
 * rather than implied, because the half-guard is the dangerous kind.
 */
const _projectCommandNamesAreWellTyped: readonly ProjectCommandName[] = PROJECT_COMMAND_NAMES;
void _projectCommandNamesAreWellTyped;

/* -------------------------------------------------------------------------- */
/* AMENDMENTS                                                                 */
/* -------------------------------------------------------------------------- */

/*
 * This contract is frozen. It changes only by an entry in this block, never
 * silently.
 *
 * To add one: append a dated row below giving the date, the type or constant
 * touched, what changed, and what a builder already coding against the old
 * shape has to do about it; bump PROJECT_CONTRACT_VERSION in the same edit if
 * the change is one a stub would notice. An edit above this line without a row
 * here is the change this block exists to make impossible to miss in review.
 *
 * 1. 2026-08-14 — SkillMountProblem gains
 *    'nameCollidesWithAnotherEnabledSkill', and ProjectView.enabledSkills states
 *    the rule that produces it: two enabled names that are one directory under
 *    the mount volume's casing rules. On Windows ['Foo', 'foo'] is two enabled
 *    skills and one path, and nothing said which gave way — so a reconcile could
 *    silently dedupe, misreport 'occupiedByUnrelatedEntry', or write two mounts
 *    to one path. project_create and project_update now refuse a colliding list
 *    with INVALID_PAYLOAD; a record that already holds a pair mounts the first
 *    entry and reports the rest. Revisit: any consumer switching exhaustively on
 *    SkillMountProblem, and any renderer that was case-folding this list itself
 *    — it must not.
 *
 * 2. 2026-08-14 — no shape changed: three rule blocks that were doc comments
 *    attached to no declaration are now attached to the declarations they are
 *    about. The default project's seeding rule is on DEFAULT_PROJECT_ID; the
 *    three INVALID_PAYLOAD path refusals and the execution seam are on
 *    WorkingDirectoryBinding; the whole private-workspace boundary is on
 *    ProjectPaths.workspace, and the section that held it is gone. A builder
 *    hovering WorkingDirectoryBinding was previously shown one sentence and none
 *    of its three refusal rules. Revisit: nothing in code; a reader who
 *    bookmarked line numbers.
 *
 * 3. 2026-08-14 — no shape changed: WorkingDirectoryBinding and
 *    ProjectPaths.workspace now name projectFilesystemScope in
 *    src/platform/contract-sandbox.ts as the one place a run's three mounts are
 *    built. The rule was prose in both contracts and code in neither.
 */
