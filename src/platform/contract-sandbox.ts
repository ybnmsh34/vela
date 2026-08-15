/**
 * THE SANDBOX CONTRACT — what runs model-produced code, and what that code may reach.
 *
 * Two surfaces execute through this file and they are less alike than they look:
 *
 *  - **Canvas/Artifacts** renders HTML, React, SVG and Mermaid the model wrote. Three of
 *    those four are documents; one of them (HTML/React) is a *program* that happens to be
 *    drawn. Rendering it is execution, and pretending otherwise is how a renderer ends up
 *    running attacker-authored script in the same origin as the app.
 *  - **The agentic runtime** executes Bash and Python on the user's machine, with a working
 *    directory, an environment, and an exit code.
 *
 * One contract covers both because the *decisions* are the same decisions — what may be
 * read, what may be written, what may be reached over the network, how long it may run, and
 * who said yes. What differs is which mechanism enforces them, and that difference is
 * carried in the types ({@link SandboxBackendReport}) rather than left to a builder's
 * assumption.
 *
 * **The two families are separated in the types, not only in the prose**, and the first
 * draft of this file was not: it described a document as a first-class consumer and then
 * gave it a `minimumIsolation` vocabulary made entirely of process mechanisms, an event
 * stream with no producer, and a `scripts` field an SVG could legally set. Each of those is
 * closed below, at {@link Isolation}, at {@link SandboxReportDocumentReq}, and at
 * {@link DocumentProgram}. A contract that serves one consumer and describes two is worse
 * than one that admits it serves one.
 *
 * ## This contract is a boundary, not a filter
 *
 * The reference study (`docs/references/unsloth-studio.md`) records what happens when a
 * product treats "sandbox" as a synonym for "we check the command string first". Its issue
 * #4818 is a privilege-escalation escape from a command filter; the reporter verified it
 * against the file on disk rather than against what the model said it had done, which is the
 * only part of the report that needed no interpretation. The study's secondary read of the
 * fix attributes the escape to `str.split()` tokenisation losing to full binary paths, shell
 * quoting, nested shells and a pivot through Python's own process-spawning calls, and
 * describes the fix as six layered defences — tokenisation, environment scrubbing,
 * kernel-level privilege denial, resource limits, AST-based static analysis, an expanded
 * blocklist. Two facts about that fix matter more than its contents: it was closed the same
 * day as "completed", and the reporter's own follow-up the next day was that it was still
 * reachable. Both the study and the fix's own review call the result layered mitigation
 * rather than closure of the vulnerability class.
 *
 * The sibling study (`docs/references/mindshub-cowork.md`) is weaker still: its execution
 * environment is a virtualenv subprocess whose installer adds a firewall rule to *permit*
 * outbound traffic. That is dependency isolation, not a security boundary.
 *
 * So this contract takes the opposite starting point. **Nothing here describes what a
 * program is allowed to say.** There is no blocklist type, no allowed-commands list, no
 * place to hang a static analysis verdict, and adding one would be an amendment that has to
 * argue for itself. What a run may do is decided by what the run is *given* — a set of
 * mounts, a network policy, a limit set — before its first byte is interpreted, by a
 * component that never reads its source. A boundary you can describe without reading the
 * program is a boundary; anything else is a filter with good intentions.
 *
 * ## What this contract does not yet promise
 *
 * Vela targets container/microVM-class isolation for the process family. It does not have it
 * today. Every type here can express it, and {@link SandboxBackendReport} exists so that a
 * host which can only offer an ordinary child process has to **say so, per guarantee**,
 * instead of letting the word "sandbox" imply the rest. A caller that requires real
 * isolation states the floor it needs in {@link SandboxSubmitReq.minimumIsolation} and is
 * refused when the host cannot reach it — never quietly served something weaker.
 *
 * Two honesty notes, stated here because a reader will otherwise infer their opposites. They
 * said the opposite until 2026-08-15 — see amendment 4 — and a reader who trusts a stale
 * "nothing is wired up" will change a rule believing nothing is watching:
 *
 *  1. **The process half of this file is wired up; the document half is not.** All six
 *     command names are in `COMMAND_ALLOWLIST` in `src/platform/contract.ts` and in the Rust
 *     allowlist, which `cargo test` pins to each other; the Rust module behind them is
 *     `src-tauri/src/ipc/sandbox.rs` over the `vela-sandbox` crate, whose backend is a WSL2
 *     namespace that runs Bash and nothing else; `BrowserAdapter` implements all six as a
 *     fake that runs nothing and refuses every submit `languageUnsupported`, which is what
 *     the real host also answers on a machine with no WSL distribution. Still unbuilt:
 *     every document command path, `python`, both copying materialisations, and any surface
 *     that renders an approval prompt — {@link SandboxEvent} `awaitingApproval` reaches
 *     `src/data/sandbox-repository.ts` and stops there.
 *  2. **Some rules below are enforced by tests now, and which ones is not obvious.** As of
 *     2026-08-15 the `vela-sandbox` crate carries 47 tests: `tests/sandbox_boundary.rs` is an
 *     escape battery that executes real programs inside the boundary and checks the
 *     filesystem, network, privilege and lifecycle claims from outside them, and the module
 *     tests pin the refusal order, the path rules and the wire shape. `cargo test` fails if
 *     the two allowlists disagree, and `src/data/sandbox-repository.test.ts` covers the
 *     renderer seam. What no machine watches: the entire document family (no producer
 *     exists), the four {@link RefusalReason} members no host emits —
 *     `skillsMountMustBeReadOnly`, `guestPathRemapUnsupported`, `limitAboveHostCeiling`,
 *     `documentGrantInvalid` — the copy-out semantics of {@link MountMaterialisation}, and
 *     every network policy other than `denied`. `src/platform/claimed-guards.test.ts` exists
 *     precisely because a comment claiming an enforcement that does not exist is worse than
 *     an unguarded invariant, so: where this file states a rule in that list, read "the
 *     implementation must, and no machine is watching yet".
 *
 * ## The seam with the other two frozen contracts
 *
 * A run belongs to a project and is usually driven by an agent run, and both of those are
 * frozen elsewhere. This file does not restate either:
 *
 *  - `src/platform/contract-project.ts` owns {@link ProjectId} and {@link AbsolutePath},
 *    which are imported here rather than respelled. Every `hostPath` below is the same kind
 *    of string a project's working directory is, resolved by the same rules, and
 *    {@link SandboxSubmitReq.projectId} is what decides which paths a run may be handed at
 *    all — see {@link SANDBOX_PROTECTED_ROOTS}.
 *  - `src/platform/contract-harness.ts` owns the agent loop. A Bash or Python tool call
 *    inside a run is executed by that file's `ToolExecutor`, and the executor is where a
 *    submit is built: it is the one component that holds both the run's project and the
 *    tool's arguments. Nothing in this file knows a harness exists, and nothing in that file
 *    imports this one — the join is made at the composition root, deliberately, so that a
 *    surface which only renders documents does not drag the agent loop in behind it.
 *
 * ## House rules this file follows
 *
 * Field names are camelCase on the wire. Every field is `readonly`; every array is
 * `readonly T[]`. Reasons that a user will read as a sentence are closed unions the renderer
 * words — the same rule `Concern` and `Cause` follow in `src/platform/contract.ts` — so that
 * no string chosen by a program under execution can ever be rendered as Vela's own prose.
 */

import type { Ack, EmptyPayload } from './contract';
import type { AbsolutePath, ProjectId, ProjectLayout } from './contract-project';

/**
 * Bump on any change to the shapes below, together with the host-side constant, once a host
 * side exists. Separate from `IPC_CONTRACT_VERSION` on purpose: this surface will move for
 * several phases after the chat contract has stopped moving, and one version number for two
 * cadences means every sandbox change looks like a chat-protocol break.
 */
export const SANDBOX_CONTRACT_VERSION = 3;

/**
 * A run's identity, minted by the caller. See {@link SandboxSubmitReq}.
 *
 * Distinct from `RunId` in `src/platform/contract-harness.ts` and deliberately not the same
 * value: one agent run submits many sandbox runs, and a type that made them interchangeable
 * would invite a builder to reuse the agent run's id for the first tool call and then
 * discover the second one collides. Aliased rather than branded for the reason
 * {@link ProjectId} gives.
 */
export type SandboxRunId = string;

/* -------------------------------------------------------------------------- */
/* isolation — the only claim that matters, and the one most easily faked      */
/* -------------------------------------------------------------------------- */

/**
 * Process-family confinement, weakest to strongest, **and the ranking itself**.
 *
 * The union is derived from this tuple rather than written out beside it. A hand-maintained
 * parallel pair is this project's central defect in miniature — it agrees on the day it is
 * written and stops agreeing on the day a class is added — and the earlier draft of this
 * file had exactly that pair, with a comment claiming "a new class has exactly one place to
 * be ranked" over two places. Derived, the claim is true: add a member here and it is both a
 * legal value and a ranked one, or it is neither.
 *
 * These are *mechanism* classes, not adjectives. Each names what stands between the program
 * and the user's machine:
 *
 *  - `none` — the program runs in a process with the user's own privileges and ambient
 *    access to their home directory. Legal to express, so a host that has nothing better can
 *    describe itself truthfully, and so a caller can refuse it. It is not a sandbox and no
 *    doc comment in this repo may call it one.
 *  - `process` — a child process with the OS's own per-process controls applied: a dropped
 *    privilege set, resource limits, a job object or process group for teardown. This is the
 *    class both studies describe, in both products. It contains mistakes; it does not contain
 *    an adversary, because the filesystem it sees is still the user's.
 *  - `container` — a separate mount, PID and network namespace (or the platform equivalent):
 *    the program's filesystem is constructed rather than inherited, so "what it can read" is
 *    a property of what was mounted rather than of what it thought to open.
 *  - `microVm` — a separate kernel. The escape surface is the hypervisor rather than the
 *    host kernel's syscall table.
 *
 * There is no `strict`/`relaxed` pair and no boolean `sandboxed`. A boolean can say that
 * somebody switched something on; it cannot say what that something was, which is exactly the
 * question a user of either reference product could not answer about theirs.
 */
export const PROCESS_ISOLATION_STRENGTH = ['none', 'process', 'container', 'microVm'] as const;

export type ProcessIsolation = (typeof PROCESS_ISOLATION_STRENGTH)[number];

/**
 * Document-family confinement, weakest to strongest, ranked the same way and for the same
 * reason.
 *
 * **A drawn document is not confined by any of the process classes and never will be**, so
 * it gets its own vocabulary rather than being made to assert a floor that misdescribes what
 * it receives. The previous draft made every Canvas submit name a process class; there was
 * no value that meant "the browser boundary", which is the only boundary a frame actually
 * has, and so a caller who wanted to *require* that boundary had no way to say so.
 *
 *  - `sameOrigin` — the document is drawn in Vela's own origin. It can read Vela's DOM, its
 *    storage, and can issue same-origin requests. This is not a boundary at all; it is here
 *    so a host that does this has to say it, and so a caller can refuse it. No submit in
 *    Vela should ever be served this, and a host that serves it while the caller asked for
 *    more must refuse instead.
 *  - `opaqueOriginFrame` — script runs in a frame with an opaque origin: no access to Vela's
 *    DOM, no cookies, no storage, no same-origin request back into the app. That is a
 *    browser-enforced boundary and a real one. It bounds *reach*, not *cost*: the frame
 *    shares a renderer process with the surface hosting it, so CPU and memory limits are
 *    reported `unenforced` against it and a spinning script degrades the app.
 *  - `ownRendererProcess` — as above, and in a process of its own, so the cost limits become
 *    enforceable and a crashed frame does not take the window. Nothing in Vela does this
 *    today; the value exists so that the day it does, the field it needs is already here and
 *    a caller can already demand it.
 */
export const DOCUMENT_ISOLATION_STRENGTH = [
  'sameOrigin',
  'opaqueOriginFrame',
  'ownRendererProcess',
] as const;

export type DocumentIsolation = (typeof DOCUMENT_ISOLATION_STRENGTH)[number];

/**
 * One isolation claim: which family, and how strong within it.
 *
 * Tagged by family rather than flattened into one union of seven names, because the two
 * scales are not comparable and a flat union invites exactly that comparison. There is no
 * answer to "is `opaqueOriginFrame` stronger than `process`" — they confine different things
 * against different adversaries — and a builder who had to sort them would produce one.
 */
export type Isolation =
  | { readonly family: 'process'; readonly level: ProcessIsolation }
  | { readonly family: 'document'; readonly level: DocumentIsolation };

/**
 * Position on the family's own scale, or `-1` for a level this build has never heard of.
 *
 * **The `-1` is the whole reason this is a shipped function rather than a note telling each
 * builder to call `indexOf`.** A host newer than this renderer can send a level that is not
 * in the tuple; `indexOf` answers `-1`; and `-1` compared with `>=` silently ranks the
 * unknown value *below the weakest one there is*. Ten builders writing that comparison
 * privately will write it ten ways and at least one will get that case wrong, in the
 * direction that accepts a run it should have refused.
 */
export function isolationRank(isolation: Isolation): number {
  const scale: readonly string[] =
    isolation.family === 'process' ? PROCESS_ISOLATION_STRENGTH : DOCUMENT_ISOLATION_STRENGTH;
  return scale.indexOf(isolation.level);
}

/**
 * Does `offered` satisfy the floor `required` asks for?
 *
 * `false` for a family mismatch, and `false` for either side being a level this build cannot
 * rank. **Both of those are refusals, not fallbacks** — the host answers
 * `isolationUnavailable` or `isolationFamilyMismatch` and serves nothing, because the one
 * behaviour this contract will not have is a run served under confinement weaker than the
 * caller demanded.
 */
export function isolationMeets(offered: Isolation, required: Isolation): boolean {
  if (offered.family !== required.family) return false;
  const offeredRank = isolationRank(offered);
  const requiredRank = isolationRank(required);
  if (offeredRank < 0 || requiredRank < 0) return false;
  return offeredRank >= requiredRank;
}

/**
 * How a guarantee is actually held.
 *
 * `kernel` — the OS, the hypervisor or the browser refuses the operation; the program cannot
 * proceed past it.
 * `supervisor` — Vela observes and reacts: a watchdog notices and kills. Real, and racy. A
 * memory limit enforced this way is exceeded before it is enforced.
 * `unenforced` — the value was accepted, recorded, and does nothing. The number still
 * travels so that the UI can show what was asked for, and this level is why it must never be
 * shown without qualification.
 */
export type EnforcementLevel = 'kernel' | 'supervisor' | 'unenforced';

/**
 * How the host came to believe its own report.
 *
 * Mirrors `CapabilityEvidence` in `src/platform/contract.ts`, and for the same reason: a UI
 * that cannot tell a probe from a default will eventually assert a probe happened. Today
 * every backend will answer `declared` — nothing self-tests, and a sandbox that has never
 * been attacked in its own test suite has demonstrated nothing. `probed` is reserved for a
 * host that ran an escape battery against itself at startup and is not to be returned before
 * that battery exists.
 */
export type IsolationEvidence = 'declared' | 'probed';

/**
 * What the host can actually deliver, per guarantee, for **one family**.
 *
 * **Read this before rendering the word "sandbox" anywhere in the UI.** A backend at
 * `{ family: 'process', level: 'process' }` will typically report `network: 'unenforced'`
 * and `filesystem: 'unenforced'`, which means the run can open any file the user can open
 * and can reach the internet — and a surface that drew a shield icon off "not `none`" would
 * be telling the user the opposite of what is true.
 *
 * `processTree` deserves its own field because it is the guarantee most often assumed and
 * least often held: at `container`/`microVm` the whole confinement is destroyed, so a
 * descendant cannot outlive it; at `process` a double-forked, detached grandchild can and
 * does survive, and only a job object or a cgroup makes teardown total. For the document
 * family it describes tearing down the frame and anything it spawned (a worker, a nested
 * frame), which the browser does hold.
 *
 * `maximumIsolation` is separate from `isolation` because they answer different questions —
 * what the next run gets, versus the strongest thing this host could be asked for. They
 * differ on a machine where a container runtime is installed but not running. Both are in
 * the same family as the report they sit on; a report never crosses families.
 */
export interface SandboxBackendReport {
  readonly isolation: Isolation;
  readonly maximumIsolation: Isolation;
  readonly evidence: IsolationEvidence;
  /** Whether the network policy is imposed on the program or merely requested of it. */
  readonly network: EnforcementLevel;
  /** Whether {@link FilesystemScope} describes the run's whole filesystem or only its intent. */
  readonly filesystem: EnforcementLevel;
  /** Whether cancellation reaches descendants. See {@link SandboxCancelReq}. */
  readonly processTree: EnforcementLevel;
  readonly limits: LimitEnforcement;
}

/**
 * One report per family, because one machine has two answers.
 *
 * A single report would have to describe a child process and a browser frame at once, and
 * whichever one it described the other surface would read as its own.
 */
export interface SandboxBackends {
  readonly process: SandboxBackendReport;
  readonly document: SandboxBackendReport;
}

/* -------------------------------------------------------------------------- */
/* the program                                                                */
/* -------------------------------------------------------------------------- */

/** Interpreters the agentic runtime submits. The host chooses the binary; the caller never names one. */
export type ProcessLanguage = 'bash' | 'python';

/**
 * Which platform a **process run's program** finds itself on.
 *
 * Two values rather than an OS name, because everything in this contract that depends on it
 * depends on the split and not on the distribution: which base-environment list applies
 * ({@link SANDBOX_BASE_ENVIRONMENT_POSIX} against
 * {@link SANDBOX_BASE_ENVIRONMENT_WINDOWS}), whether environment names collide under case
 * folding ({@link EnvironmentEntry}), whether a killed process has a signal number
 * ({@link CrashedOutcome}), and what a path separator is.
 *
 * **It is a property of the guest, not of the host, and the two are not the same question.**
 * At `none` and `process` the program is an ordinary child of the Vela process and they
 * agree. At `container` and `microVm` they need not: a Linux container on a Windows host is
 * the ordinary shape of the ambition this file states, and a host that answered this from its
 * own OS would describe a guest that does not exist.
 *
 * The document family has no environment, no signals and no filesystem, so it has no guest
 * platform to report and this appears on nothing that describes one.
 */
export type GuestPlatform = 'posix' | 'windows';

/**
 * What Canvas renders.
 *
 * `html` and `react` execute script. `svg` and `mermaid` do not and must not: Mermaid is
 * compiled to SVG by a bundled renderer, and SVG is drawn. That split used to be prose plus
 * a runtime refusal, on a single interface where `{ language: 'svg', scripts:
 * 'sandboxedNullOrigin' }` compiled — which made "the safest of the four languages is an XSS
 * vector with a reassuring name" a mistake ten builders could each make privately. It is now
 * unrepresentable: see {@link DocumentProgram}.
 */
export type DocumentLanguage = 'html' | 'react' | 'svg' | 'mermaid';

/** Everything either family can be asked to run. Used where a set of languages is stated. */
export type SandboxLanguage = ProcessLanguage | DocumentLanguage;

/**
 * One environment variable.
 *
 * A list of pairs rather than `Record<string, string>`, for two reasons a map cannot express.
 * Windows environment names are case-insensitive and everywhere else they are not, so
 * `PATH` and `Path` in one map are one entry on one OS and two on another — an ordered list
 * makes the collision visible and lets the rule be stated: **later entries win, and the host
 * must reject a submit whose entries collide under the casing rules of the platform the
 * program will run on** rather than pick a winner silently. That is the guest's platform, and
 * a caller reads it from {@link SandboxPolicySnapshot.guestPlatform}: a Linux guest on a
 * Windows host takes `PATH` and `Path` as two variables, and refusing them there would refuse
 * a submit that is correct. Second, a map's iteration order is not part of its meaning, and
 * this one's is.
 */
export interface EnvironmentEntry {
  readonly name: string;
  readonly value: string;
}

/**
 * The keys the host may add to a run's environment on its own when the **guest** is POSIX,
 * and the complete list of them for that platform. Which list applies is
 * {@link SandboxPolicySnapshot.guestPlatform}, not the OS Vela is running on.
 *
 * **There is no "inherit the parent environment" option, and its absence is the design.**
 * The study's fix PR sanitises the child environment by *removing* named secrets
 * (`HF_TOKEN`, `WANDB_API_KEY`, `AWS_*` are the ones it names). That is a blocklist, and a
 * blocklist over an inherited environment fails the same way a blocklist over a command
 * string fails: it enumerates what somebody thought of. Vela inverts it. The child's
 * environment is exactly {@link ProcessProgram.environment} plus the list for the guest
 * platform in {@link SandboxPolicySnapshot.guestPlatform}, and a variable that is not in one of those two places does
 * not exist inside the run — including every token the user happened to export into the
 * shell that launched Vela.
 *
 * Values for these keys are chosen by the host and point inside the run's own filesystem
 * scope; the caller cannot set them.
 */
export const SANDBOX_BASE_ENVIRONMENT_POSIX = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'PWD'] as const;

/**
 * The same list for Windows, and it is longer because Windows needs it to be.
 *
 * **This is the correction that mattered most in this file.** A single POSIX list, declared
 * complete, on the platform Vela actually ships to, produces a process family that cannot
 * run its own default language: a `python.exe` started without `SYSTEMROOT` fails during
 * interpreter start-up when it initialises sockets and the random source; `HOME` and
 * `TMPDIR` are not what Windows calls those things; `PATHEXT` is how a Windows process finds
 * an executable at all; and `COMSPEC` is what a shell-spawning call reaches for. A host that
 * added `SYSTEMROOT` anyway would have been violating a frozen contract to make the product
 * work, which is the worst of the available outcomes.
 *
 * These are the keys, and no others. Neither list inherits: they are two closed sets, and the
 * host uses the one for the platform **the program will run on**.
 *
 * **That is the guest's platform, not the host's, and an earlier draft said "the platform it
 * is on".** The two agree at `none` and `process`, where the child is an ordinary host
 * process — and they stop agreeing at exactly the classes this file states as the ambition.
 * A Linux container on a Windows host is the ordinary shape of `container` here, and the
 * earlier rule injects `PATHEXT`, `COMSPEC` and `SYSTEMROOT` into a Linux guest while omitting
 * `HOME` and `TMPDIR` — which is the same failure, with the platforms swapped, that the
 * single POSIX list produced and that this pair was written to close. A `python` that cannot
 * find a home directory and a shell that cannot find a temporary one is the worst of the
 * available outcomes twice over.
 *
 * The host knows which it is about to start, because it chose the image; the caller learns it
 * from {@link SandboxPolicySnapshot.guestPlatform} without having to submit and be refused.
 */
export const SANDBOX_BASE_ENVIRONMENT_WINDOWS = [
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
] as const;

/**
 * A run of Bash or Python.
 *
 * `source` is handed to the interpreter as a script, never assembled into a shell command
 * line by Vela. There is no `command`/`args` pair and no `shell: true`: the moment Vela
 * builds a string for a shell to re-parse, the quoting rules of that shell become part of
 * this contract, and the study's escape lived exactly in the gap between two parsers'
 * opinions about the same bytes.
 *
 * **`bash` is not available on every platform Vela ships to**, and a caller learns that from
 * {@link SandboxPolicySnapshot.languages} rather than by submitting and being refused. The
 * refusal (`languageUnsupported`) still exists, because a policy snapshot read a minute ago
 * is a fact about a minute ago.
 */
export interface ProcessProgram {
  readonly kind: 'process';
  readonly language: ProcessLanguage;
  readonly source: string;
  /** See {@link ProcessWorkingDirectory}. `{ kind: 'scratch' }` is the ordinary answer. */
  readonly workingDirectory: ProcessWorkingDirectory;
  /**
   * The complete environment. See {@link SANDBOX_BASE_ENVIRONMENT_POSIX} and
   * {@link SANDBOX_BASE_ENVIRONMENT_WINDOWS} for what the host adds.
   */
  readonly environment: readonly EnvironmentEntry[];
  /** Written to the program's stdin, then stdin is closed. `null` closes it immediately. */
  readonly stdin: string | null;
}

/**
 * Where the process starts.
 *
 * **A union rather than a bare string, because the bare string had no legal value for the
 * commonest run there is.** The previous draft required an absolute guest path inside the
 * run's scope, and then documented the empty mount set as "valid and common" — a run whose
 * only directory is a scratch directory whose path the host picks and does not tell the
 * caller until after acceptance. There was no correct thing to send. Ten builders would have
 * sent ten things: a hardcoded `/tmp`, an empty string, a dummy mount, or the home directory
 * this file calls the whole problem.
 *
 *  - `scratch` — start in the run's own scratch directory, wherever the host put it. This is
 *    the default answer, it is always legal, and it needs no knowledge the caller does not
 *    have. A run with no mounts at all can only say this.
 *  - `guestPath` — start at a named absolute path in **guest** coordinates
 *    ({@link Mount.guestPath}), for a caller that mounted a directory and means to work
 *    inside it. It must resolve inside a mount or inside the scratch directory; anywhere
 *    else is `workingDirectoryOutsideScope`, a refusal and not a fallback to somewhere
 *    convenient — the convenient fallback is the user's home directory, which is the whole
 *    problem.
 *
 * Whichever is chosen, {@link EffectiveGrant.workingDirectory} reports the path the run will
 * actually start in, so a caller that said `scratch` still learns where that was.
 */
export type ProcessWorkingDirectory =
  | { readonly kind: 'scratch' }
  | { readonly kind: 'guestPath'; readonly path: string };

/**
 * How script is treated in a drawn document. Only the two script-capable languages have it.
 *
 * `denied` runs the document with script execution disabled — the honest choice for
 * previewing untrusted HTML.
 *
 * `sandboxedNullOrigin` executes script in a frame with an opaque origin: no access to
 * Vela's own DOM, no cookies, no storage, no same-origin request back into the app. That is
 * a browser-enforced boundary and a real one, and it is exactly what
 * `{ family: 'document', level: 'opaqueOriginFrame' }` names. It bounds reach and not cost —
 * {@link SandboxBackendReport.limits} will say so.
 */
export type DocumentScripts = 'denied' | 'sandboxedNullOrigin';

/**
 * A document Canvas will draw.
 *
 * **Two variants, because the field that makes an SVG dangerous only exists on the two
 * languages that can use it.** `{ language: 'svg', scripts: 'sandboxedNullOrigin' }` does
 * not compile. This is the same move `NetworkPolicy` makes below and the same move
 * `AuthMode`/`ProviderAuth` make in `src/platform/contract.ts`: put the field on the variant
 * that can carry it, rather than on the shared shape with a rule beside it. The host-side
 * check the previous shape needed is gone with it, along with the ten private re-derivations
 * of that check and the one builder who would have forgotten.
 *
 * Both variants share `kind: 'document'`, so a consumer switching on family sees one
 * document arm; a consumer that needs to know about script switches on `language` inside it.
 *
 * The lifetime rule is the one thing here a builder must not guess at, so it is stated in
 * two places: a document run **settles when it has first rendered and stays live after
 * that**, unlike a process run which settles when it exits. See {@link SandboxEvent} for
 * what may still arrive afterwards, and {@link SandboxReleaseReq} for what ends it.
 *
 * Three parts of a document submit are fixed, and a request that says otherwise is refused
 * with `documentGrantInvalid` rather than quietly corrected: `processes` is 1, because a
 * frame is one frame; `fileWriteBytes` is 0; and `mounts` is empty. {@link NO_FILESYSTEM} is
 * the whole of the filesystem a document gets.
 */
export type DocumentProgram =
  | {
      readonly kind: 'document';
      readonly language: 'html' | 'react';
      /**
       * **What `source` is, per language, and who turns it into a frame.**
       * Amendment 4 records why this had to be said; this is the rule.
       *
       *  - `html` — a fragment or a whole page. Either is legal, because the
       *    surface owns the document skeleton regardless (it has to: a
       *    `Content-Security-Policy` meta is honoured only until the first
       *    element that is not one, so a page whose skeleton came from the model
       *    could put anything ahead of the policy).
       *  - `react` — **a complete ES module, authored in JSX, whose default
       *    export is a component taking no props.** Not a bare expression: a
       *    model writing anything past a paragraph declares a constant or a
       *    second component, and an expression has nowhere to put either, nor an
       *    import the day a bundled library is offered. Not a whole HTML
       *    document either — that is what the `html` arm is, and two arms meaning
       *    "a document" is what made this question askable. No props, because
       *    the thing that renders it is Vela and Vela has nothing to pass.
       *
       * **The surface transpiles, never the host.** This file's central rule is
       * that what a run may do is decided by what it is given, by a component
       * that never reads its source; a host that transpiled JSX would be parsing
       * model-authored source, which is the filter this contract refuses to be.
       * The transpiled module also has to end up *inside* the frame, and the
       * only thing that can put it there is the thing that builds the frame.
       *
       * A `react` source that does not parse is `sourceRejectedByParser` on a
       * {@link DocumentFailedOutcome} — it could not be turned into a frame at
       * all — and is reported after `accepted`, like any other render failure.
       *
       * One consequence a caller must not be surprised by: `{ language:
       * 'react', scripts: 'denied' }` is legal, submittable, and draws an empty
       * frame. It is not refused, because refusing it would mean the host had an
       * opinion about what the source does; a surface offering that combination
       * should say what it will produce.
       */
      readonly source: string;
      readonly scripts: DocumentScripts;
    }
  | {
      /** Drawn, never executed. There is no `scripts` field to set, which is the point. */
      readonly kind: 'document';
      readonly language: 'svg' | 'mermaid';
      readonly source: string;
    };

export type SandboxProgram = ProcessProgram | DocumentProgram;

/* -------------------------------------------------------------------------- */
/* filesystem scope — deny by default, and the whole of it stated here         */
/* -------------------------------------------------------------------------- */

export type MountMode = 'readOnly' | 'readWrite';

/**
 * How the bytes get to the program, and — the part that matters — what happens to the user's
 * copy of them when the run dies halfway through.
 *
 * `bind` — the host directory itself is exposed. Writes land on the user's disk as they
 * happen. Fast, and unwindable by nothing: a cancelled run leaves whatever it had written,
 * including a file truncated to zero bytes on its way to being rewritten.
 * `copyIn` — a snapshot is copied into the run's own storage. Writes are visible to the
 * program and to nobody else, ever; they are discarded with the run.
 * `copyInCopyOut` — as `copyIn`, and on a **settled, successful** run the modified tree is
 * copied back over the host path. A cancelled, failed or limit-killed run copies nothing
 * back, which is the only rollback this contract offers and the reason the mode exists.
 *
 * Choosing between them is a caller's decision and there is no default. An agentic runtime
 * editing a user's repository wants `bind` and its risk; a "run this and show me what it
 * produced" flow wants `copyInCopyOut`.
 */
export type MountMaterialisation = 'bind' | 'copyIn' | 'copyInCopyOut';

/**
 * One grant of filesystem access. The run has exactly the union of these and nothing else.
 *
 * Path rules, all of which the host performs and none of which the caller may be trusted to
 * have performed:
 *
 *  - `hostPath` is an {@link AbsolutePath} in the sense
 *    `src/platform/contract-project.ts` defines: absolute, and resolved — symlinks, `..`,
 *    `~`, Windows short names, the lot — *before* it is checked against
 *    {@link SANDBOX_PROTECTED_ROOTS}. Checking the unresolved string is the classic bypass
 *    and it is one line of code away at all times.
 *  - The grant covers the resolved directory subtree. A symlink *inside* the tree that
 *    points outside it does not extend the grant: at `container` class the target is simply
 *    not in the namespace, and at `process` class the host must refuse to follow it. If the
 *    host cannot promise that, {@link SandboxBackendReport.filesystem} is `unenforced` and
 *    the caller was told.
 *  - **A reparse point inside the tree is the same problem wearing Windows clothes**, and it
 *    is not hypothetical here: a project's skills mount is a directory of junctions into the
 *    machine-wide skill store (`src/platform/contract-project.ts`, `LinkStrategy`), and
 *    every file API follows one transparently. That is why a mount whose resolved path is a
 *    project's skills mount may only be `readOnly` — `skillsMountMustBeReadOnly` — and why
 *    the resolution above has to happen before the mode is honoured rather than after.
 *  - Two mounts may not nest. Overlapping grants make "which mode applies here" a question
 *    with two answers, and the answer a builder picks under time pressure is the permissive
 *    one.
 *
 * The window between resolving a path and using it is a real TOCTOU gap that this contract
 * cannot close by describing it; only a namespace can, which is one more reason
 * {@link ProcessIsolation} exists.
 */
export interface Mount {
  readonly hostPath: AbsolutePath;
  /**
   * Where it appears inside the run. At `container`/`microVm` this is a genuine remap. At
   * `process` and `none` there is no namespace to remap in, so the host must **refuse** a
   * submit whose `guestPath` differs from its resolved `hostPath`, rather than ignore the
   * field and hand back paths the program was not expecting. A silently ignored field is a
   * lie told in the shape of a success.
   */
  readonly guestPath: string;
  readonly mode: MountMode;
  readonly materialisation: MountMaterialisation;
}

/**
 * Categories of location that may never be mounted, in any mode, at any permission level.
 *
 * Categories rather than paths because the paths are per-OS and per-install, and a literal
 * path list is a list somebody forgets to extend on the third platform. The host resolves
 * each category for the running system.
 *
 * This is a deny-list, which this file otherwise argues against — the difference is what it
 * is protecting and from whom. It is not a substitute for a boundary and it is not what keeps
 * a run away from the user's files; the empty default mount set does that. It exists so that
 * a *user* clicking through an approval prompt cannot grant, and an agentic runtime cannot
 * request, the four things that would make every other guarantee in Vela retroactively false:
 *
 *  - `credentialStore` — whatever the OS keychain is backed by on this platform. Conventions
 *    §0 rule 4 says a secret value moves in one direction only; a readable mount here routes
 *    around that rule without touching a line of the code that implements it.
 *  - `velaStore` — `vela.db` and the settings, which is where the endpoint list and its auth
 *    bindings live. **The category is the store, not the whole application-data directory**,
 *    and that distinction is load-bearing rather than pedantic: a project's private agent
 *    workspace lives at `<app data dir>/projects/<id>/workspace`
 *    (`src/platform/contract-project.ts`, `ProjectPaths`), so a category drawn one level up
 *    would make the agent's own workspace unmountable by the agent it exists for. That is
 *    the kind of contradiction a builder discovers at implementation time and resolves by
 *    widening whichever side is easier to widen.
 *  - `velaInstall` — the application itself. A run that can rewrite Vela can rewrite this
 *    boundary, and would only have to do it once.
 *  - `userKeyMaterial` — SSH and GPG private keys and the like: the credentials that are not
 *    in the keychain, and the ones an exfiltration is actually after.
 *
 * **What a run may be handed, given the above and {@link SandboxSubmitReq.projectId}:** its
 * own project's workspace, its own project's skills mount (`readOnly` only), its own
 * project's working directory if it has one, and any path the user granted through an
 * approval prompt that cleared every rule here. Another project's root is
 * `mountOutsideProjectScope`. Nothing else under the application-data directory is
 * mountable at all.
 *
 * The first three of those are built by {@link projectFilesystemScope} rather than by each
 * caller from this paragraph. A rule stated in prose in two contracts and constructed by
 * nobody is a rule ten builders implement ten ways, and the way that gets the skills mount
 * wrong is the destructive one.
 */
export const SANDBOX_PROTECTED_ROOTS = [
  'credentialStore',
  'velaStore',
  'velaInstall',
  'userKeyMaterial',
] as const;

export type ProtectedRoot = (typeof SANDBOX_PROTECTED_ROOTS)[number];

/**
 * The one directory a run may always write to, created empty by the host for that run, as
 * the caller asks for it.
 *
 * A run with no writable mount is still useful — most are — and a run that must invent a
 * temporary directory somewhere the user can see is how `/tmp`-shaped debris ends up in a
 * project folder. `retainAfterSettled` is the flag that decides whether the artefact of a
 * failed run survives long enough to be looked at; see {@link SandboxReleaseReq}, which is
 * what deletes it either way.
 *
 * **The scratch directory is host-owned and lives outside every project root.** It is
 * per-run and disposable, it is deleted on release, and putting it inside a project would
 * make "delete this project" and "a run is writing" race over the same tree.
 */
export interface ScratchRequest {
  /**
   * `null` — the normal case — means the host picks the location, and the program finds it
   * through `TMPDIR` or `TEMP` depending on {@link SandboxPolicySnapshot.guestPlatform} — the
   * platform the program runs on, which is not always Vela's. A non-null value is a request for
   * a specific guest path, honourable only where there is a namespace to place it in, so at
   * `process` and `none` it is refused with `guestPathRemapUnsupported` rather than ignored.
   */
  readonly guestPath: string | null;
  /**
   * Keep the directory after the run settles, so a caller can copy out what a failed or
   * cancelled run produced. Released on {@link SandboxReleaseReq}, and on app exit.
   */
  readonly retainAfterSettled: boolean;
}

/**
 * The same policy, answered.
 *
 * **A separate type rather than the request type with a prose invariant.** The request's
 * `guestPath` is nullable and the grant's never is, and saying so only in a comment meant
 * every consumer of the resolved path had to write a fallback branch for a state the
 * contract said could not occur — with non-null assertions banned repo-wide, ten builders
 * would have chosen ten fallbacks. Two types, and the branch does not exist. This file
 * already solves the identical problem twice with distinct shapes, at
 * {@link FilesystemScope.outsideMounts} and at {@link NO_FILESYSTEM}.
 */
export interface ResolvedScratch {
  /** Where the run will actually find it, in guest coordinates. Never absent. */
  readonly guestPath: string;
  readonly retainAfterSettled: boolean;
}

/**
 * Everything the run can see of the filesystem, as requested.
 *
 * `outsideMounts` is a one-member union rather than a boolean or an omitted field. A boolean
 * invites a `false`; an omitted field invites a default nobody stated. A one-member union
 * means the day somebody needs a second mode, every consumer's `switch` stops compiling and
 * the change arrives as an amendment instead of as a flag.
 */
export interface FilesystemScope {
  /** Empty is a valid and common scope: the run sees only its scratch directory. */
  readonly mounts: readonly Mount[];
  readonly scratch: ScratchRequest;
  readonly outsideMounts: 'denied';
}

/** The same scope with the scratch directory resolved. See {@link ResolvedScratch}. */
export interface EffectiveFilesystemScope {
  readonly mounts: readonly Mount[];
  readonly scratch: ResolvedScratch;
  readonly outsideMounts: 'denied';
}

/**
 * The filesystem scope for a Canvas document: nothing at all.
 *
 * A rendered document has no filesystem in v1: no mounts, and a scratch directory it cannot
 * write to, because {@link DEFAULT_DOCUMENT_LIMITS} gives it a write budget of zero. "Save
 * this chart" is a user action performed by the app through a file dialog the user sees, not
 * a write performed by the artefact on the user's behalf while they watch it animate.
 *
 * The scratch field is still populated rather than made optional. An optional field is one
 * two hosts default differently; a stated one with nothing behind it is a decision that was
 * made.
 */
export const NO_FILESYSTEM: FilesystemScope = {
  mounts: [],
  scratch: { guestPath: null, retainAfterSettled: false },
  outsideMounts: 'denied',
};

/**
 * What a caller decides about the **user's own** directory, when it mounts it at all.
 *
 * The other two mounts a project run gets are host-owned and have exactly one correct form,
 * so {@link projectFilesystemScope} fixes them. This one is a judgement: whether the run may
 * write to the user's files, and what happens to them if it dies halfway through. There is no
 * default for {@link MountMaterialisation} anywhere in this file and there is not one here —
 * an agent editing a repository wants `bind` and its risk, and a "run this and show me what
 * it made" flow wants `copyInCopyOut`.
 */
export interface WorkingDirectoryGrant {
  readonly mode: MountMode;
  readonly materialisation: MountMaterialisation;
}

/** What {@link projectFilesystemScope} needs that it cannot read off a {@link ProjectLayout}. */
export interface ProjectScopeRequest {
  /**
   * From `project_layout` in `src/platform/contract-project.ts`, read for this run. Not
   * cached from an earlier one: it carries the resolved working directory, and "resolved"
   * means "as of the moment it was read".
   */
  readonly layout: ProjectLayout;
  /**
   * `null` mounts no working directory even when the project has one — the right answer for a
   * run that has no business in the user's files. A grant mounts it **only** when the layout
   * says `bound`; a `none` or `unavailable` working directory produces no mount either way,
   * because mounting a path that is not there is how a run gets an empty directory where the
   * user's files should be and writes into it.
   */
  readonly workingDirectory: WorkingDirectoryGrant | null;
  /** No default: see {@link ScratchRequest.retainAfterSettled}. */
  readonly scratch: ScratchRequest;
}

/**
 * The filesystem scope for a run inside one project — **shipped rather than described**.
 *
 * Three paths, and both sibling contracts state the rule in prose: this project's workspace
 * read-write, its skills mount read-only, its working directory if it has one
 * (`src/platform/contract-project.ts` at the private-workspace boundary, and
 * {@link SANDBOX_PROTECTED_ROOTS} here). Prose in two files and a constructor in none is how
 * ten builders write ten versions of a rule that must not vary — the argument
 * `mergeRunCapabilities` in `src/platform/contract-harness.ts` is shipped for, and it is
 * sharper here, because the version that gets it wrong grants model-authored code a
 * read-write mount of every skill on the machine through a directory of junctions.
 *
 * What is fixed, and not a caller's to pass:
 *
 *  - **The workspace is `readWrite` and `bind`.** It is Vela's own disposable directory, it is
 *    what "the agent may write in its workspace" means, and a `copyIn` of it would discard
 *    the run's work at the moment it settled — the one place in this contract where a copy
 *    mode would silently undo the point of the mount.
 *  - **The skills mount is `readOnly`, always, and `bind`.** {@link Mount} gives the reason
 *    and `skillsMountMustBeReadOnly` is the refusal; passing `readWrite` here is not
 *    expressible rather than refused. `copyIn` is not offered either: copying a tree of
 *    junctions duplicates the machine-wide store per run.
 *
 * `guestPath` equals the resolved `hostPath` on every mount. That is not a default standing in
 * for a remap: at `none` and `process` there is no namespace, so a differing guest path is
 * `guestPathRemapUnsupported` — a refusal — and those are the only classes any backend can
 * serve today. When a namespace backend lands, remapping becomes meaningful and this function
 * is the one place it has to change, which is the reason it exists.
 *
 * **It validates nothing, and cannot.** Overlap, protected roots, resolution of the working
 * directory's path — every one of those is decided host-side against paths the host resolved,
 * and a renderer-side re-check would be theatre on the side of the boundary already assumed
 * compromised, exactly as {@link ApprovalRequest} says of `requestDigest`. Two consequences a
 * caller keeps: a `bound` working directory whose `writable` is `false` combined with a
 * `readWrite` grant is a run that fails when it writes, so **read `WorkingDirectory.writable`
 * and decide** rather than expecting this to quietly downgrade — a silent reduction is the one
 * forbidden outcome — and the mounts come back in a fixed order, workspace then skills mount
 * then working directory, so that `mountIndex` on a {@link RefusedOutcome} points at a row a
 * surface can name.
 */
export function projectFilesystemScope(request: ProjectScopeRequest): FilesystemScope {
  const { layout } = request;
  const hostOwned: readonly Mount[] = [
    {
      hostPath: layout.paths.workspace,
      guestPath: layout.paths.workspace,
      mode: 'readWrite',
      materialisation: 'bind',
    },
    {
      hostPath: layout.paths.skillsMount,
      guestPath: layout.paths.skillsMount,
      mode: 'readOnly',
      materialisation: 'bind',
    },
  ];
  const grant = request.workingDirectory;
  const working: readonly Mount[] =
    grant !== null && layout.workingDirectory.kind === 'bound'
      ? [
          {
            hostPath: layout.workingDirectory.path,
            guestPath: layout.workingDirectory.path,
            mode: grant.mode,
            materialisation: grant.materialisation,
          },
        ]
      : [];
  return {
    mounts: [...hostOwned, ...working],
    scratch: request.scratch,
    outsideMounts: 'denied',
  };
}

/* -------------------------------------------------------------------------- */
/* network                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What the run may reach over the network.
 *
 * `denied` is the default and the only one an automatic approval can ever produce — see
 * {@link AutoApprovalProfile}, which has no field capable of expressing anything else.
 *
 * `loopbackOnly` exists for the case Vela actually has: a script that talks to the user's own
 * model endpoint on 127.0.0.1. It is narrower than it looks and still not safe by itself,
 * because loopback is where an unauthenticated local inference server lives — the study
 * records a vendor defaulting *tools* on for loopback binds and off for everything else, with
 * the stated reasoning that a leaked key on an exposed port is remote code execution.
 *
 * `allowed` is unrestricted egress. It cannot be reached by any automatic path: a human
 * approves it per run, at permission level `ask`, having been shown it.
 *
 * `ports` is exhaustive rather than a starting point, and an empty list is refused: a policy
 * that reaches nothing is `denied`, and letting it be spelled two ways means one of the two
 * spellings eventually gets a different implementation.
 */
export type NetworkPolicy =
  | { readonly kind: 'denied' }
  | { readonly kind: 'loopbackOnly'; readonly ports: readonly number[] }
  | { readonly kind: 'allowed' };

/* -------------------------------------------------------------------------- */
/* limits                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Every limit, all required.
 *
 * **Not one of these is optional, and that is the enforcement.** An optional limit is one a
 * caller forgets, one two call sites default differently, and one a host fills in from a
 * constant nobody can find. Making the caller state all six means the numbers are visible at
 * the call site and in the approval prompt, where a user can see that this script may write
 * a hundred megabytes.
 *
 * Ceilings: the host may lower any of these and must report the lowered value in
 * {@link SandboxAccepted.grant}. It may never raise one, and never lowers silently.
 */
export interface SandboxLimits {
  /**
   * For a process run: total wall-clock time before the run is killed. For a document run:
   * the budget to **first render only** — a document that has rendered is not killed at the
   * deadline, because a Canvas artefact is meant to be looked at, and the thing that ends its
   * life is {@link SandboxReleaseReq}.
   */
  readonly wallClockMs: number;
  /** Resident bytes. `unenforced` on any backend without a cgroup or a job object. */
  readonly memoryBytes: number;
  /** Thousandths of one core: 1000 is one core, 2500 is two and a half. */
  readonly cpuMillicores: number;
  /**
   * Combined stdout and stderr bytes for the whole run. **Exceeding it does not kill the
   * run.** One {@link SandboxTruncated} event is emitted, further output is dropped, and the
   * program runs to completion — a build that emitted eight megabytes of warnings and then
   * succeeded is more useful than a build killed for being verbose. Runaway output that
   * never terminates is a wall-clock problem, and wall clock catches it.
   */
  readonly outputBytes: number;
  /** Live processes, the run's own included. Bounds fork bombs; must be 1 for a document. */
  readonly processes: number;
  /** Bytes written across every writable mount and the scratch directory. */
  readonly fileWriteBytes: number;
}

/**
 * The name of a limit, derived from the limit set rather than written out beside it.
 *
 * A hand-maintained parallel union is this project's central defect in miniature: it agrees
 * with the interface on the day it is written and silently stops agreeing on the day a limit
 * is added. Derived, it cannot.
 */
export type LimitName = keyof SandboxLimits;

/** How each limit is held on this backend. Mapped for the same reason {@link LimitName} is. */
export type LimitEnforcement = { readonly [K in LimitName]: EnforcementLevel };

/**
 * Defaults for Bash and Python.
 *
 * Numbers with reasons, because a default nobody can argue with is a default nobody revises.
 * Thirty seconds is longer than a script that is working and shorter than a user's patience.
 * Half a gigabyte runs an interpreter and a data frame, and does not run a model. One core
 * leaves the machine responsive while the run happens. A megabyte of output is more than any
 * human reads and less than any log ships. A hundred and twenty-eight processes is a build
 * with parallel jobs and is not a fork bomb — the study reports the escaped product's fix
 * landing on 256 for the same limit, and a hundred megabytes for the write cap, which is
 * where the write number below comes from.
 */
export const DEFAULT_PROCESS_LIMITS: SandboxLimits = {
  wallClockMs: 30_000,
  memoryBytes: 512 * 1024 * 1024,
  cpuMillicores: 1000,
  outputBytes: 1024 * 1024,
  processes: 128,
  fileWriteBytes: 100 * 1024 * 1024,
};

/**
 * Defaults for a Canvas document.
 *
 * Two of these are zero and one is one, which is the point: a document is a frame, so
 * `processes` is 1 by definition, and it writes nothing, so its write budget is not a
 * generous number but an absent capability. Ten seconds to first render is the boundary
 * between "loading" and "broken". The output budget is console noise, which is diagnostic
 * volume and not a program's output.
 *
 * `memoryBytes` and `cpuMillicores` are stated and will be reported `unenforced` by every
 * backend at `{ family: 'document', level: 'opaqueOriginFrame' }`, because a frame sharing
 * the app's renderer process has nothing to enforce them with. The numbers are carried
 * anyway so that the day a document is drawn at `ownRendererProcess`, the fields it needs
 * already exist and already have values.
 */
export const DEFAULT_DOCUMENT_LIMITS: SandboxLimits = {
  wallClockMs: 10_000,
  memoryBytes: 256 * 1024 * 1024,
  cpuMillicores: 1000,
  outputBytes: 256 * 1024,
  processes: 1,
  fileWriteBytes: 0,
};

/* -------------------------------------------------------------------------- */
/* permission — and what, exactly, a person is agreeing to                    */
/* -------------------------------------------------------------------------- */

/**
 * The four-level selector.
 *
 * The vocabulary is taken from the reference study, which records it verbatim from a
 * shipped product: Ask, Approve for me, Off, Full access. Two of the four mean something
 * different here, and both departures are deliberate.
 *
 *  - `ask` — **default.** Every run stops for a human before anything executes. The person
 *    is shown the source that will run and the grant it will run under, and their answer
 *    covers that one run.
 *  - `approve` — a run whose grant is inside {@link AutoApprovalProfile} proceeds without a
 *    prompt; every other run behaves as `ask`. **The reference classifies the action; Vela
 *    classifies the grant.** "Automatically run read-only actions" requires deciding whether
 *    a command is read-only, which requires reading the command, which is the filter this
 *    contract refuses to be. Whether a run can write, reach the network, or exceed a limit
 *    is decidable from the request alone, without the source being parsed by anything.
 *  - `off` — **every** submit is refused with `permissionIsOff`, and the surface offers no
 *    execute affordance. That includes `svg` and `mermaid`, which run no script of their own:
 *    exempting the languages that "don't really execute" is a judgement about what a program
 *    will do, made from its language tag, and a Mermaid renderer is a parser with a parser's
 *    history. Canvas shows source for all four.
 *
 *    **What `off` is and is not enforced against.** It is host-held, so no *request* can
 *    raise it — that is the property worth having and it is real. It is not a defence
 *    against Vela's own renderer, which for a document holds the source already and could
 *    mount a frame without submitting anything (see {@link SandboxReportDocumentReq}). An
 *    earlier draft said a renderer that submits anyway "is refused rather than obeyed",
 *    which reads as a claim about the renderer and is not one. The adversary this contract
 *    has is model-authored content; Vela's own surfaces are the thing enforcing the
 *    boundary, not the thing it is enforced against, and a Canvas surface that drew a frame
 *    without an `accepted` grant would be a defect in Vela rather than an attack on it.
 *  - `full` — every run is auto-approved. **It does not disable the sandbox**, and this is
 *    the sharpest departure from the reference, whose own description of its fourth level is
 *    "allow all calls and disable the sandbox". Those are two different powers and joining
 *    them means a user who wanted to stop being asked has also, in the same click, removed
 *    the boundary. In Vela, approval and isolation are orthogonal: `full` answers "is a human
 *    asked", and {@link SandboxSubmitReq.minimumIsolation} answers "what confines it". A run
 *    that wants no confinement must ask for `none` explicitly and can be refused by the host
 *    for it.
 *
 * The level is **not a field on a submit.** It is host-held configuration, read through
 * {@link SandboxPolicySnapshot}, and a request cannot raise it. This mirrors the one piece of
 * the reference's design that is unambiguously right: its tool policy is resolved at the
 * process level and, in its own words, individual requests cannot bypass it via a flag in the
 * request body. A permission level a caller can send is a permission level that model output
 * can eventually talk a caller into sending.
 */
export type PermissionLevel = 'ask' | 'approve' | 'off' | 'full';

/**
 * ## The unit of approval
 *
 * **One submitted run, approved whole, before it starts.** Not a command, not a syscall
 * class, not a session.
 *
 * A *command* cannot be the unit, because commands are not visible without interpreting the
 * program: to prompt per command you must decide what the commands are, and the study's
 * escape is a catalogue of ways two parsers disagree about that — full binary paths, quoting,
 * `bash -c`, a pivot from Python into process spawning. A prompt built on that analysis
 * inherits every one of its blind spots, and it inherits them at the moment the user is
 * being asked to trust it.
 *
 * A *syscall class* cannot be the unit either, though for the opposite reason: it is a fine
 * thing for a boundary to police and an impossible thing to ask a person about, at the rate
 * a running program generates them. Syscall policy belongs to {@link ProcessIsolation},
 * decided once, by an engineer, in the mechanism.
 *
 * So the unit is the run, and this type is what the person sees. The grant is the whole of
 * what they are agreeing to, which is why {@link EffectiveGrant} rather than a summary
 * sentence: a prompt that says "this script wants to run" and hides the fact that it also
 * has the user's home directory mounted read-write is worse than no prompt, because it
 * manufactures consent.
 *
 * The approval is bound to `requestDigest`, computed host-side over the canonical form of the
 * submit. Approving covers exactly those bytes and that grant. **The renderer must treat the
 * digest as opaque and must never recompute or compare it** — a renderer-side check is
 * theatre performed on the side of the boundary that is already assumed compromised.
 *
 * **An unanswered request does not time out.** There is no timer, because a prompt that
 * answers itself after sixty seconds answers *no* at the moment the user has walked back to
 * their desk, and a user who learns that prompts expire learns to click through them. A
 * pending approval ends when it is answered, when the run is cancelled, or when the caller
 * releases the run — and that last one is what `approvalAbandoned` reports.
 */
export interface ApprovalRequest {
  readonly runId: SandboxRunId;
  /** Opaque, host-computed, host-checked. Echoed back with the decision. */
  readonly requestDigest: string;
  /** The exact program text that will run. Shown to the user, in full, never elided by the host. */
  readonly program: SandboxProgram;
  readonly grant: EffectiveGrant;
}

/**
 * A person's answer to one {@link ApprovalRequest}.
 *
 * **There is no `alwaysAllow`.** Standing consent is a settings change — moving
 * {@link PermissionLevel} to `approve` and widening {@link AutoApprovalProfile} — and it
 * belongs in the settings surface where it can be reviewed and revoked, not on a modal the
 * user is trying to dismiss so their script will run. Every product that puts "don't ask
 * again" next to "allow" is measuring how fast people click, not what they consented to.
 */
export type ApprovalDecision = 'allowOnce' | 'deny';

/**
 * The isolation floor an automatic approval requires, one level per family.
 *
 * Two fields rather than one {@link Isolation}, because a profile has to answer for both
 * families and a single tagged value could only answer for one — which would leave the other
 * family's automatic behaviour undefined, and "undefined" in an auto-approval rule means
 * "whatever the first implementation did".
 */
export interface AutoApprovalIsolationFloor {
  readonly process: ProcessIsolation;
  readonly document: DocumentIsolation;
}

/**
 * The grant set that may run without asking, at {@link PermissionLevel} `approve`.
 *
 * Note what has no field here: **the network**. There is no way to spell "auto-approve a run
 * with network access", so the strongest thing an automatic decision can produce is a run
 * that is confined, silent, and writes only where the profile says. Egress is a human
 * decision, per run, always. That absence is the enforcement — a boolean set to `false` by
 * default is a boolean somebody sets to `true`.
 *
 * A submit auto-approves only if *every* clause holds: **the isolation floor the submit
 * itself demanded** is at least `minimumIsolation` for its family, its network policy is
 * `denied`, every mount is inside a profile root with a mode the profile permits, and every
 * limit is at or under `maximumLimits`. Anything else prompts.
 *
 * **The comparison is over the request, never over the backend**, and the distinction is not
 * academic. What the backend can reach decides whether a submit is *served at all*
 * (`isolationUnavailable`); what the submit *asked for* decides whether a human is asked.
 * Reading this clause against the backend would auto-approve a run on a container-capable
 * machine whose caller never demanded containment — a caller that named a floor of `none`
 * would sail through on the strength of a guarantee it did not request and cannot rely on.
 * The source is never consulted by either reading.
 */
export interface AutoApprovalProfile {
  readonly minimumIsolation: AutoApprovalIsolationFloor;
  /** Host paths under which mounts may be auto-approved. Empty means scratch only. */
  readonly readableRoots: readonly AbsolutePath[];
  /**
   * The two lists are checked independently and neither implies the other: a `readWrite`
   * mount must appear here, and appearing here does not make a path readable. Spelling write
   * access as a flag on the read list is how a widened read root silently becomes a widened
   * write root.
   */
  readonly writableRoots: readonly AbsolutePath[];
  readonly maximumLimits: SandboxLimits;
  /** Languages the profile covers. A language absent here always prompts. */
  readonly languages: readonly SandboxLanguage[];
}

/**
 * The profile Vela ships with, and it auto-approves nothing at all.
 *
 * Not because every clause is empty — the languages are all six and the limits are the
 * ordinary process defaults — but because of one clause: `minimumIsolation` demands
 * `container` of a process run and `ownRendererProcess` of a document, and **no submit that
 * Vela can serve today truthfully asks for either**. A caller that demanded them would be
 * refused with `isolationUnavailable` before approval was reached; a caller that asked for
 * less fails this clause and prompts. Either way a user who selects `approve` on this
 * machine is prompted for every run, exactly as if they had selected `ask`, until the
 * isolation exists to make the automatic answer defensible.
 *
 * **That is the intended behaviour and not a placeholder.** The alternative — shipping a
 * profile tuned to what the current backend can do — is how "approve" comes to mean "approve
 * on a child process with the user's own filesystem", which is the setting the reference
 * products effectively shipped. The floor moves down only when a mechanism moves up.
 */
export const DEFAULT_AUTO_APPROVAL_PROFILE: AutoApprovalProfile = {
  minimumIsolation: { process: 'container', document: 'ownRendererProcess' },
  readableRoots: [],
  writableRoots: [],
  maximumLimits: DEFAULT_PROCESS_LIMITS,
  languages: ['bash', 'python', 'html', 'react', 'svg', 'mermaid'],
};

/**
 * The live policy, read from the host.
 *
 * `permission` and `profile` are the user's settings. `backends` is what this machine can
 * actually do, per family, and the two together are what a surface needs before it offers an
 * execute button: a build reporting `{ family: 'process', level: 'process' }` and
 * `filesystem: 'unenforced'` should say what that means, not draw a padlock.
 *
 * `languages` is here because the alternative is discovery by refusal. `bash` does not exist
 * on a stock Windows machine, and a surface that cannot find that out without submitting
 * will find it out in front of the user.
 */
export interface SandboxPolicySnapshot {
  readonly permission: PermissionLevel;
  readonly profile: AutoApprovalProfile;
  readonly backends: SandboxBackends;
  /** What this host can actually run, right now. Empty for a family is a legal answer. */
  readonly languages: readonly SandboxLanguage[];
  /**
   * The platform a process run's program will find itself on — which base-environment list
   * the host will add, which casing rules `environmentNamesCollide` is decided under, and
   * whether {@link CrashedOutcome} can carry a signal number. See {@link GuestPlatform}.
   *
   * Here rather than on {@link SandboxBackendReport} because that type is shared by both
   * families and a document has no guest platform at all; a field that were meaningless on
   * one arm is a field somebody fills in with a plausible-looking lie. Here for the same
   * reason `languages` is here: the alternative is discovery by refusal, in front of the
   * user, after they clicked run.
   */
  readonly guestPlatform: GuestPlatform;
  /** Runs already admitted and not yet released. Bounds what a caller can start. */
  readonly activeRuns: number;
  readonly maximumConcurrentRuns: number;
}

/* -------------------------------------------------------------------------- */
/* submitting a run                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Hand a run over.
 *
 * The **caller** mints `runId`, exactly as the renderer mints `turnId` for `chat_send` in
 * `src/platform/contract.ts`, and for the same reason: events for a run can arrive before the
 * invoke promise settles, so a subscriber that waited for a host-assigned id would miss the
 * first line of output. Subscribe first, then submit.
 *
 * `runId` is opaque to the host and must stay that way: it is a key, and it may never be
 * used to build a path. A scratch directory named after a caller-supplied string is a
 * traversal that arrives through the one field nobody thought of as input.
 *
 * Note what is *not* here: no permission level, no "skip approval", no "trusted" flag, no
 * blocklist, no analysis result. The request says what the run needs; it has no vocabulary
 * for what the run should be excused.
 */
export interface SandboxSubmitReq {
  readonly runId: SandboxRunId;
  /**
   * The project this run belongs to, from `src/platform/contract-project.ts`.
   *
   * Required, with no null arm, because that contract guarantees a project always exists —
   * `DEFAULT_PROJECT_ID` is seeded so that "no project" is never a state. It is what decides
   * which of the user's directories this run may be handed at all
   * ({@link SANDBOX_PROTECTED_ROOTS}), so a run without one would be a run whose mount rules
   * have no subject. An id no project has is `unknownProject`.
   */
  readonly projectId: ProjectId;
  readonly program: SandboxProgram;
  readonly filesystem: FilesystemScope;
  readonly network: NetworkPolicy;
  readonly limits: SandboxLimits;
  /**
   * The weakest confinement the caller will accept, compared with {@link isolationMeets}. A
   * host that cannot reach it refuses with `isolationUnavailable`. **It never serves
   * something weaker**, and a caller that would genuinely rather have a weak run than no run
   * says so by naming a weaker floor — in code, where a reviewer can see it.
   *
   * Its family must match the program's: a `process` program takes a `process` floor, a
   * `document` program takes a `document` floor. The mismatch is `isolationFamilyMismatch`
   * rather than a coercion, because the coercion would have to invent an opinion about which
   * process class a browser frame is worth.
   */
  readonly minimumIsolation: Isolation;
}

/**
 * The run was admitted for consideration. Always `true`.
 *
 * Admission is not approval and not execution: at {@link PermissionLevel} `ask` the very next
 * event is {@link SandboxAwaitingApproval}, which may sit there for as long as the person
 * takes. Blocking the invoke on a human would hold an IPC call open for minutes, so it does
 * not.
 *
 * ## Where a refusal arrives, decided here rather than left to be discovered
 *
 * Two channels existed in the first draft and nothing said which refusal took which. One of
 * them cannot carry a reason at all: the host error shape is `{ code, message }` over a
 * closed seven-code set (`src/platform/errors.ts`), conventions §3.2 forbids the renderer
 * parsing `message`, and so a {@link RefusalReason} delivered that way arrives unreadable,
 * with `mountIndex` and `protectedRoot` gone. The rule is therefore:
 *
 *  - **Every refusal in {@link RefusalReason} arrives as an event** — one
 *    {@link SandboxSettled} carrying a {@link RefusedOutcome} — and the invoke resolves with
 *    `admitted: true` first. That includes the ones the host decides instantly, such as
 *    `permissionIsOff` and `tooManyConcurrentRuns`: the host mints the run, settles it
 *    refused, and the caller has exactly one place to clean up. A caller that renders a
 *    refusal has the closed reason, the mount index and the protected category, every time.
 *  - **Exactly one failure rejects the invoke, and it is deliberately not in that union**: a
 *    `runId` already in flight, which fails with `INVALID_PAYLOAD`. It cannot be an event,
 *    because the only stream that id names belongs to the run already using it, and pushing
 *    a refusal onto that stream would tell a different caller their healthy run had failed.
 *    A caller that mints duplicate ids has a bug rather than a state to render.
 *
 * Anything else that rejects the invoke — a serialisation failure, a host that is not there
 * — is an ordinary `PlatformError` and means the run does not exist. It will not settle,
 * because it was never admitted.
 */
export interface SandboxSubmitRes {
  readonly runId: SandboxRunId;
  readonly admitted: boolean;
}

/**
 * Why a run was refused, from a closed set.
 *
 * Closed, and carrying no free text, for the reason the whole error taxonomy in
 * `src/platform/contract.ts` is: the renderer writes every sentence a user reads. Here it
 * matters more than anywhere else in Vela, because the thing being refused was written by a
 * model, and a refusal that echoed the program's own bytes into Vela's UI would let the
 * program choose what the user is told about it.
 *
 * `mountIndex` on {@link RefusedOutcome} says which mount, by position, so a UI can point at
 * one row without a path being quoted back.
 *
 * Two members an earlier draft had are gone rather than renamed, and both absences are the
 * result of a shape change rather than a decision to care less. There is no
 * "scriptsNotPermittedForLanguage" — spelled here without backticks because this repo
 * reserves those for names that exist — because {@link DocumentProgram} makes that request
 * unrepresentable; a payload that spells it anyway is malformed JSON for this contract and
 * is `INVALID_PAYLOAD`. And there is no "runIdAlreadyInFlight", because it is the one
 * refusal that rejects the invoke instead; see {@link SandboxSubmitRes}.
 */
export type RefusalReason =
  | 'isolationUnavailable'
  | 'isolationFamilyMismatch'
  | 'permissionIsOff'
  | 'approvalDenied'
  /** The caller released a run that was still waiting for a person. See {@link SandboxReleaseReq}. */
  | 'approvalAbandoned'
  | 'languageUnsupported'
  | 'unknownProject'
  | 'mountIsProtectedRoot'
  /** A mount resolved inside another project's root, or elsewhere under the app data dir. */
  | 'mountOutsideProjectScope'
  /** A project's skills mount was requested `readWrite`. See {@link Mount}. */
  | 'skillsMountMustBeReadOnly'
  | 'mountsOverlap'
  | 'guestPathRemapUnsupported'
  | 'workingDirectoryOutsideScope'
  | 'environmentNamesCollide'
  | 'limitAboveHostCeiling'
  | 'networkPolicyUnavailable'
  | 'documentGrantInvalid'
  | 'tooManyConcurrentRuns';

/** A host-side failure that is nobody's request being wrong. Also closed, also worded by the UI. */
export type HostFailureReason =
  | 'backendUnavailable'
  | 'backendStartFailed'
  | 'scratchUnavailable'
  | 'copyOutFailed'
  | 'internal';

/**
 * What the run is actually running under, reported at acceptance.
 *
 * This is the request, **narrowed**: identical to what was asked for except where a host
 * ceiling lowered a limit, plus the two things the request could not name because only the
 * host knows them — the resolved scratch path and the resolved working directory. Nothing
 * here may be wider than the request — not a mode, not a mount, not a network policy, not a
 * number. A caller that cares should diff it against what it sent and show the difference; a
 * caller that does not can ignore it safely, because every possible difference is more
 * restrictive than what it asked for.
 */
export interface EffectiveGrant {
  readonly backend: SandboxBackendReport;
  readonly filesystem: EffectiveFilesystemScope;
  readonly network: NetworkPolicy;
  readonly limits: SandboxLimits;
  /**
   * The guest path the process will actually start in — the answer to "where did `scratch`
   * put me". `null` for a document run, which has no working directory rather than an
   * uninteresting one.
   */
  readonly workingDirectory: string | null;
}

/* -------------------------------------------------------------------------- */
/* cancelling, and what cancellation is worth                                 */
/* -------------------------------------------------------------------------- */

/**
 * Why the caller is cancelling. Recorded on the outcome; no reason is treated specially.
 *
 * `superseded` is the one an agent loop uses: when a run in
 * `src/platform/contract-harness.ts` is cancelled, its `ToolExecutor` aborts on the signal it
 * was handed and cancels whatever sandbox runs it had started. Nothing here enforces that —
 * this contract does not know a harness exists — but the vocabulary is here so the two
 * halves agree on what the reason means.
 */
export type CancelReason = 'user' | 'surfaceClosed' | 'superseded';

/**
 * Stop a run.
 *
 * **What is promised.** The host stops delivering output events for this run, terminates
 * the program, and settles the run with a `cancelled` outcome. Where
 * {@link SandboxBackendReport.processTree} is `kernel`, termination reaches every descendant,
 * because at `container`/`microVm` the thing destroyed is the confinement itself and a
 * descendant has nowhere to survive. Where it is `supervisor`, teardown is a job object or a
 * process-group kill and is best-effort: a process that double-forked and detached, or one
 * blocked in an uninterruptible syscall, can outlive the run it belonged to. The report says
 * which one you have. **Do not tell the user "stopped" on a backend that reports
 * `supervisor` without meaning "asked to stop".**
 *
 * **What is not promised, at all.** Nothing is rolled back. A `bind` mount has already
 * written what it wrote — including a file the program truncated and had not finished
 * rewriting, which on the user's disk is now empty and is not recoverable by anything in this
 * contract. `copyIn` and `copyInCopyOut` discard their work, and for `copyInCopyOut` that
 * discard *is* the rollback: the copy-out step only runs for a run that settled successfully,
 * so the user's tree is byte-for-byte what it was. This is the whole of Vela's transactional
 * story and it is a property of {@link MountMaterialisation}, chosen per mount, at submit
 * time, by the caller. There is no undo afterwards.
 *
 * **Ordering.** Cancelling does not truncate the stream. Output already produced and buffered
 * still arrives, in sequence, before the terminal event. A caller that stops rendering at the
 * moment it calls cancel will drop the last thing the program said, which is often the
 * interesting thing.
 *
 * Cancelling a run that is still waiting for a person settles it `cancelled`, not `refused` —
 * the person did not deny it, the caller withdrew it.
 *
 * On a document run that has already settled, cancel means {@link SandboxReleaseReq}: the
 * frame is torn down. Spelling it as two calls that do the same thing to a live document is
 * better than a caller holding a frame open because it used the wrong verb.
 */
export interface SandboxCancelReq {
  readonly runId: SandboxRunId;
  readonly reason: CancelReason;
}

export interface SandboxCancelRes {
  /** `false` when the run had already settled — a race, not an error. */
  readonly cancelled: boolean;
}

/**
 * Let go of a run: tear down a live document, delete a retained scratch directory, forget
 * the id.
 *
 * Required, not optional, and the reason is the retention flag. A scratch directory kept so
 * the user could look at what a failed run produced is a directory nothing else will ever
 * delete, and "the host cleans up at exit" is how a crash becomes a disk leak. After release
 * the id is free and any event still in flight for it must be dropped by the caller —
 * releasing and receiving race, and the loser is the event.
 *
 * **Releasing an unsettled run is legal**, and saying so is what gives `approvalAbandoned` a
 * trigger. An earlier draft described this as "let go of a *settled* run" and then listed
 * release as the only cause of that refusal, which left the reason unreachable and a builder
 * guessing whether release-before-settle was allowed at all. It is:
 *
 *  - waiting for a person → settles `refused` with `approvalAbandoned`;
 *  - running → equivalent to {@link SandboxCancelReq} with `surfaceClosed`, then released;
 *  - already settled → the ordinary case, nothing to stop.
 *
 * In every case the terminal event is emitted before the id is forgotten, so the "exactly one
 * settled per admitted run" rule holds through a release as well.
 */
export interface SandboxReleaseReq {
  readonly runId: SandboxRunId;
}

/** Answer one {@link ApprovalRequest}. The digest must be the one that was handed out. */
export interface SandboxApproveReq {
  readonly runId: SandboxRunId;
  readonly requestDigest: string;
  readonly decision: ApprovalDecision;
}

/* -------------------------------------------------------------------------- */
/* documents: who draws the frame, and how the host hears about it            */
/* -------------------------------------------------------------------------- */

/**
 * What a document surface can tell the host about a frame it is drawing.
 *
 * ## Why this command exists at all
 *
 * The document family's events — first render, a console call, a CSP violation, a truncation
 * — describe things only something watching a live frame can see. In Vela that watcher is
 * the renderer: an opaque-origin iframe is drawn by the surface hosting it, in the renderer
 * process, because that is what a browser boundary *is*. The first draft of this file
 * defined all of those events, named the host as their producer, and gave the host no way to
 * observe any of them. Half the document event stream had no source.
 *
 * So the fork is decided here rather than left open: **the renderer draws the frame; the
 * host owns the run.** The host decides policy (permission level, approval, the grant), owns
 * the wall-clock budget to first render, assigns every `seq`, counts active runs and reaps
 * scratch directories. The surface reports what it saw, and the host turns each report into
 * exactly one event on the run's stream:
 *
 *  - `rendered` → {@link SandboxSettled} with a {@link RenderedOutcome};
 *  - `diagnostic` → one {@link SandboxDiagnostic};
 *  - `truncated` → the one {@link SandboxTruncated} that run will get;
 *  - `failed` → {@link SandboxSettled} with a {@link DocumentFailedOutcome}.
 *
 * A report for a run the host has already settled is dropped, silently, because it is a race
 * the host is entitled to win: the wall-clock timer and a slow first render can both be
 * right.
 *
 * ## What this command is not
 *
 * It is not a trust boundary and must never be described as one. The report comes from Vela's
 * own renderer, and the host cannot check it; a renderer that lied about a render would be
 * lying to itself. The adversary is the document, which has no way to reach this command at
 * all — an opaque-origin frame cannot invoke, and the surface that can is the one thing
 * standing between them. This command exists so that *sequencing and lifetime* stay in one
 * place instead of two, which is the same argument `RunHandle` makes in
 * `src/platform/contract-harness.ts` for keeping numbering above the seam.
 *
 * A process run never sends one of these. Its observer is the host, which owns the child.
 */
export type DocumentObservation =
  | { readonly kind: 'rendered'; readonly renderMs: number }
  | {
      readonly kind: 'diagnostic';
      readonly severity: DiagnosticSeverity;
      /** Program-supplied. See {@link SandboxDiagnostic} for how it must be rendered. */
      readonly text: string;
    }
  | { readonly kind: 'truncated'; readonly droppedBytes: number }
  | { readonly kind: 'failed'; readonly reason: DocumentFailureReason };

/**
 * Why a frame never reached first render, from a closed set the surface chooses among.
 *
 * Deliberately short. "The deadline passed" is not here: the host owns that timer and reports
 * it as `limitExceeded` on `wallClockMs`, and a second party able to report the same fact is
 * a second answer to disagree with. "The user closed the surface" is not here either: that is
 * a cancel, with reason `surfaceClosed`, which is a different verb because it produces a
 * different outcome.
 */
export type DocumentFailureReason =
  /** The frame died — an out-of-memory kill, a renderer crash, a navigation away. */
  | 'frameCrashed'
  /**
   * The source could not be turned into a frame at all: unparseable SVG, a Mermaid diagram
   * the bundled compiler rejected. Distinct from a script that threw *after* rendering,
   * which is a `diagnostic` on a run that settled `rendered`.
   */
  | 'sourceRejectedByParser';

export interface SandboxReportDocumentReq {
  readonly runId: SandboxRunId;
  readonly observation: DocumentObservation;
}

/* -------------------------------------------------------------------------- */
/* the event stream                                                           */
/* -------------------------------------------------------------------------- */

/** Which pipe a chunk came out of. */
export type OutputStream = 'stdout' | 'stderr';

/**
 * A chunk of program output.
 *
 * **Text, not bytes, and the decoding is stateful.** The host decodes UTF-8 across chunk
 * boundaries and never splits a code point between two events; bytes that are not valid UTF-8
 * become U+FFFD and are counted in `bytes`, so a caller can tell "the program printed a
 * replacement character" from "the program is not emitting text at all". A run whose real
 * output is binary must write a file into its scratch directory — this channel will mangle
 * it, by design, because the alternative is base64 on every line of every log.
 *
 * `bytes` is the length of the decoded source bytes, not of `text`, and it is what counts
 * against {@link SandboxLimits.outputBytes}.
 *
 * **Process runs only.** A drawn document has no stdout; what its script writes to the
 * console is a {@link SandboxDiagnostic}, because it is Vela's observation of a frame rather
 * than a pipe the program owns.
 */
export interface SandboxOutput {
  readonly type: 'output';
  readonly stream: OutputStream;
  readonly text: string;
  readonly bytes: number;
}

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

/**
 * Something the host observed about a **document** run that is not program output: an
 * uncaught error, a console call, a rejected fetch, a CSP violation.
 *
 * **Document runs only, and that is now a rule rather than an implication.** The earlier
 * draft introduced this as document-specific and then listed it in the ordering block
 * alongside `output` for any run, which left every host builder to decide privately whether a
 * Python stack trace belongs here or in stderr. It belongs in stderr. A process run emits
 * `output` and nothing else; a document run emits `diagnostic` and never `output`. Consumers
 * still handle both arms of the union — the switch is exhaustive over the event type, not
 * over the family — but a host that produced the wrong one would be producing an event that
 * cannot happen.
 *
 * Reaches the stream through {@link SandboxReportDocumentReq}. `text` is program-supplied and
 * must be rendered as quoted, attributed foreign text — never as Vela's own words, and never
 * parsed for meaning.
 */
export interface SandboxDiagnostic {
  readonly type: 'diagnostic';
  readonly severity: DiagnosticSeverity;
  readonly text: string;
}

/**
 * The output budget is spent. Emitted **once** per run. Everything after it is dropped and
 * the program keeps running — see {@link SandboxLimits.outputBytes} for why that is not a
 * kill.
 *
 * `droppedBytes` is what had been dropped at the moment the budget was hit, so it is usually
 * small; the run's total is `droppedOutputBytes` on {@link RunUsage}. A caller that missed
 * this event still learns from the terminal event that the output was incomplete, which is
 * the point of carrying it in both places.
 */
export interface SandboxTruncated {
  readonly type: 'truncated';
  readonly droppedBytes: number;
}

/** A person is being asked. Nothing has executed. May be followed by acceptance or refusal. */
export interface SandboxAwaitingApproval {
  readonly type: 'awaitingApproval';
  readonly request: ApprovalRequest;
}

/**
 * Admitted, approved, and about to run. Carries the whole {@link EffectiveGrant} rather than
 * an acknowledgement, because this is the last moment at which a surface can show the user
 * what is about to happen under the terms it is actually happening under.
 *
 * For a document run this is also the signal a Canvas surface waits for: it draws no frame
 * until this event arrives, and it draws it under the grant this event carries.
 */
export interface SandboxAccepted {
  readonly type: 'accepted';
  readonly grant: EffectiveGrant;
}

/**
 * The program is now executing.
 *
 * Separate from {@link SandboxAccepted} because the gap between them is startup: a container
 * pull, a microVM boot, an interpreter warming, a frame being attached. That gap is the
 * honest answer to "why did my one-line script take nine hundred milliseconds", and folding
 * the two events together would bill it to the program.
 */
export interface SandboxStarted {
  readonly type: 'started';
  readonly startupMs: number;
}

/** What the run cost. `null` is **not reported**; never substitute a zero, which is a claim. */
export interface RunUsage {
  readonly wallClockMs: number;
  readonly cpuMs: number | null;
  readonly peakMemoryBytes: number | null;
  readonly outputBytes: number;
  readonly droppedOutputBytes: number;
}

export interface ExitedOutcome {
  readonly kind: 'exited';
  readonly exitCode: number;
}

/**
 * Killed by something outside itself. `signal` is the POSIX signal number where the **guest**
 * has signals, and `null` where it does not — not `0`, which is a signal.
 *
 * **The question is `SandboxPolicySnapshot.guestPlatform`, not what Vela is running on**, and
 * an earlier draft said "`null` on Windows". A Linux guest on a Windows host is the ordinary
 * shape of `container` here and its processes are killed by `SIGKILL` like any other; a
 * renderer that read the host OS would drop the one number that says whether a run was killed
 * for memory or ended by a person. Windows *guests* have no equivalent — a termination code
 * is not a signal, and reporting one here would put an unrelated integer in a field every
 * consumer will read as a signal.
 */
export interface CrashedOutcome {
  readonly kind: 'crashed';
  readonly signal: number | null;
}

/** A document reached first render. The frame stays live until released. */
export interface RenderedOutcome {
  readonly kind: 'rendered';
  readonly renderMs: number;
}

/** A document never reached first render. See {@link DocumentFailureReason}. */
export interface DocumentFailedOutcome {
  readonly kind: 'documentFailed';
  readonly reason: DocumentFailureReason;
}

export interface LimitExceededOutcome {
  readonly kind: 'limitExceeded';
  readonly limit: LimitName;
}

export interface CancelledOutcome {
  readonly kind: 'cancelled';
  readonly reason: CancelReason;
}

export interface RefusedOutcome {
  readonly kind: 'refused';
  readonly reason: RefusalReason;
  /** Position in the submitted mount list, when the refusal is about one. */
  readonly mountIndex: number | null;
  /**
   * Which protected category was hit, for `mountIsProtectedRoot` and nothing else. Carried as
   * a category rather than the path it resolved to: naming the path would put the location of
   * the user's keychain into an error a surface may log.
   */
  readonly protectedRoot: ProtectedRoot | null;
}

export interface HostFailedOutcome {
  readonly kind: 'hostFailed';
  readonly reason: HostFailureReason;
}

/**
 * How a sandbox run ended. Exactly one of these reaches the caller, on exactly
 * one {@link SandboxSettled} event.
 *
 * `refused` is here rather than only being an `IpcError` on submit, and
 * {@link SandboxSubmitRes} states the whole rule: every reason in
 * {@link RefusalReason} arrives this way, without exception, so a caller has one
 * place to clean up whatever happened and the closed vocabulary always survives
 * the trip.
 *
 * ## Why the name carries the prefix
 *
 * This type was `RunOutcome`, and so is the agent loop's terminal state in
 * `src/platform/contract-harness.ts` — three members there, eight here, and the
 * two mean unrelated things. Across `src/platform/contract.ts` and all three
 * frozen contracts it was the only exported name that collided, and it collided
 * at exactly the join both files name: a `ToolExecutor` implementation imports
 * from both, and would have got a duplicate identifier at the one place this
 * wave most wanted a builder to have an easy time.
 *
 * Renaming the sandbox side rather than the harness side follows the decision
 * already taken for {@link SandboxRunId} against that file's `RunId`: where two
 * contracts need the same word, the sandbox takes the prefix, because a run
 * there is the outer thing and one of them submits many of these. The harness
 * side's `Run*` family — its events, its status, its failures — stays whole.
 */
export type SandboxOutcome =
  | ExitedOutcome
  | CrashedOutcome
  | RenderedOutcome
  | DocumentFailedOutcome
  | LimitExceededOutcome
  | CancelledOutcome
  | RefusedOutcome
  | HostFailedOutcome;

/**
 * The run settled.
 *
 * For a process run this is the end of everything: no event of any kind follows it. For a
 * document run it is the end of *starting*, not of living — see {@link SandboxEvent} for the
 * two event types that may still arrive.
 */
export interface SandboxSettled {
  readonly type: 'settled';
  readonly outcome: SandboxOutcome;
  readonly usage: RunUsage;
}

/**
 * Everything a run can say, and the order it may say it in.
 *
 * ## Ordering
 *
 * 1. `awaitingApproval` — at most one, and only at {@link PermissionLevel} `ask` or when a
 *    run falls outside the auto-approval profile.
 * 2. `accepted` — at most one; never after `settled`.
 * 3. `started` — at most one, always after `accepted`.
 * 4. `output` (process runs), `diagnostic` (document runs), `truncated` (either) — zero or
 *    more, only between `started` and `settled`, except as noted below.
 * 5. `settled` — **exactly one, always**, for every run the host admitted, including one
 *    refused after admission and one released before it ever ran. A run that produced no
 *    output and was denied still settles.
 *
 * After `settled`: nothing at all for a process run. For a document run, `diagnostic` and
 * `truncated` may continue to arrive — a canvas artefact throws at minute three — until
 * {@link SandboxReleaseReq}. Nothing arrives after release; an event that crosses a release
 * in flight is dropped by the caller, which is why `runId` is on the envelope.
 *
 * ## Interleaving, and the claim this contract will not make
 *
 * `seq` on {@link SandboxEventEnvelope} is dense, 0-based, per run, assigned by the host, and
 * is the total order of *delivery*. Within one stream — all of stdout, or all of stderr —
 * that order is also the program's write order, exactly, with nothing lost except at an
 * explicit `truncated`.
 *
 * **Between the two streams it is not.** stdout and stderr are separate pipes with separate
 * buffers, and the kernel does not order a write to one against a write to the other; stdout
 * is typically block-buffered when it is not a terminal while stderr is not buffered at all,
 * so a program's own interleaving is routinely destroyed before Vela sees a byte of it. A UI
 * that renders the two merged by `seq` is rendering Vela's observation order and must not
 * present it as the program's. A caller that needs true interleaving has exactly one correct
 * option and it is not in this contract: have the program merge them at the source.
 *
 * This is the kind of thing every implementation gets right by accident on a fast machine and
 * wrong under load, which is why it is stated rather than left to be discovered.
 */
export type SandboxEvent =
  | SandboxAwaitingApproval
  | SandboxAccepted
  | SandboxStarted
  | SandboxOutput
  | SandboxDiagnostic
  | SandboxTruncated
  | SandboxSettled;

/**
 * The payload of the host's sandbox event.
 *
 * `seq` is on the envelope rather than on the event because it is a property of delivery, not
 * of meaning: the same `settled` event replayed to a reattaching subscriber is the same
 * event at the same position. It is the same shape and the same rule `RunEventEnvelope` uses
 * in `src/platform/contract-harness.ts`, deliberately — three streams in this repo now carry
 * `{ id, seq, event }`, and a fourth spelling of it would be a fourth thing to learn.
 *
 * It exists now, unused, so that reattachment can be added by amendment without renumbering a
 * stream every existing caller already reads. **Reattachment is not implemented and nothing
 * replays anything today.**
 */
export interface SandboxEventEnvelope {
  readonly runId: SandboxRunId;
  readonly seq: number;
  readonly event: SandboxEvent;
}

/**
 * The host event this stream is delivered on.
 *
 * Not yet a key in `EventContract` in `src/platform/adapter.ts`. That interface carries an
 * index signature, so subscribing to this name would compile today and would hand the
 * handler an `unknown` — adding the typed entry is part of wiring this contract up, not a
 * separate nicety.
 */
export const SANDBOX_EVENT_NAME = 'sandbox:event';

/* -------------------------------------------------------------------------- */
/* the contract                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The command surface, in the shape `IpcContract` uses: one payload object in, one object
 * out, never `void` and never a bare scalar.
 *
 * **These names are not on any allowlist.** They are declared here so ten builders can stub
 * against one shape; they are not invocable, and `isAllowedCommand` in
 * `src/platform/contract.ts` returns `false` for every one of them until somebody follows the
 * five-step checklist in `docs/architecture/conventions.md` §3.3 for each — which includes
 * adding the name to the Rust allowlist and to the dispatch macro, and implementing it in
 * `src/platform/browser-adapter.ts` so the UI still runs headlessly.
 *
 * Six commands, and the count is deliberate. There is no status poll — written here as
 * "sandbox_status" rather than in backticks, because this repo reserves backticks for names
 * that exist: the stream is the state, and a second way to learn the same fact is a second
 * answer to disagree with. There is no "sandbox_write_stdin" either — stdin is submitted with
 * the program and then closed. An interactive REPL is a different contract with a different
 * threat model, and adding one command is how it would arrive without anyone having decided
 * it should.
 *
 * The sixth is the one a reader should stop at: `sandbox_report_document` runs
 * renderer-to-host rather than host-to-renderer, which nothing else in this repo does. It is
 * there because a browser boundary is enforced where the browser is, and the alternative was
 * an event stream with no producer. Its whole justification is at
 * {@link SandboxReportDocumentReq}.
 */
export interface SandboxContract {
  sandbox_approve: { req: SandboxApproveReq; res: Ack };
  sandbox_cancel: { req: SandboxCancelReq; res: SandboxCancelRes };
  sandbox_policy: { req: EmptyPayload; res: SandboxPolicySnapshot };
  sandbox_release: { req: SandboxReleaseReq; res: Ack };
  sandbox_report_document: { req: SandboxReportDocumentReq; res: Ack };
  sandbox_submit: { req: SandboxSubmitReq; res: SandboxSubmitRes };
}

export type SandboxCommandName = keyof SandboxContract & string;
export type SandboxCommandReq<C extends SandboxCommandName> = SandboxContract[C]['req'];
export type SandboxCommandRes<C extends SandboxCommandName> = SandboxContract[C]['res'];

/**
 * The names, sorted, as plain string literals — the same form `COMMAND_ALLOWLIST` takes in
 * `src/platform/contract.ts`, so that whatever reads that one can read this one when these
 * commands are wired up. No spreads, no computation.
 */
export const SANDBOX_COMMAND_NAMES = [
  'sandbox_approve',
  'sandbox_cancel',
  'sandbox_policy',
  'sandbox_release',
  'sandbox_report_document',
  'sandbox_submit',
] as const;

/** Compile-time proof that the list above names only commands that exist. */
const _sandboxNamesAreWellTyped: readonly SandboxCommandName[] = SANDBOX_COMMAND_NAMES;
void _sandboxNamesAreWellTyped;

/* -------------------------------------------------------------------------- */
/* AMENDMENTS                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * This contract is frozen. Once builders are coding against it, a shape changes only by an
 * amendment recorded below — never by a quiet edit, and never by widening a union in place
 * because one consumer needed it.
 *
 * To add one: append a numbered entry to this block giving the date, the type or field
 * touched, what changed, and what a builder who wrote code against the previous shape has to
 * do about it. Bump {@link SANDBOX_CONTRACT_VERSION} in the same change. An amendment that
 * removes or narrows something states what the consumers of the old shape are expected to do
 * instead; "nothing used it" is an acceptable answer and must be written down rather than
 * assumed.
 *
 * The file was reconciled against its two sibling contracts before the freeze, so the changes
 * that produced version 1 are not amendments — nothing was ever coding against the earlier
 * shape. Everything below is after the freeze.
 *
 * 1. 2026-08-14 — `RunOutcome` is renamed {@link SandboxOutcome}. It was the only exported
 *    name colliding across `src/platform/contract.ts` and the three frozen contracts, and it
 *    collided with the agent loop's own terminal state in
 *    `src/platform/contract-harness.ts` — an unrelated three-member union — at the one place
 *    both files say a builder joins them, a `ToolExecutor` importing from both. A consumer
 *    that spelled `RunOutcome` for a sandbox run renames it; the members and
 *    {@link SandboxSettled} are otherwise unchanged. The reasoning, including why this side
 *    took the prefix, is at the type.
 *
 * 2. 2026-08-14 — {@link SandboxPolicySnapshot} gains a required `guestPlatform` field, and
 *    {@link GuestPlatform} is new. Three rules named the wrong machine: the base-environment
 *    list was chosen by "the platform the host is on", `CrashedOutcome.signal` was "`null` on
 *    Windows", and the scratch directory's variable was picked "depending on the platform".
 *    A Linux container on a Windows host — the ordinary shape of the ambition this file
 *    states — makes every one of those wrong in the direction that breaks the guest. A host
 *    must now report which platform the program will run on; a caller that branched on its
 *    own OS reads this instead. No other shape changed.
 *
 * 3. 2026-08-14 — {@link projectFilesystemScope}, {@link ProjectScopeRequest} and
 *    {@link WorkingDirectoryGrant} are new, and `ProjectLayout` is now imported from
 *    `src/platform/contract-project.ts`. The three-mount rule for a run inside a project was
 *    prose in two contracts and code in neither. Nothing is removed and no existing caller
 *    breaks; a caller that built that scope by hand should delete it, because the two
 *    host-owned mounts were never its to choose.
 *
 * 4. 2026-08-15 — {@link DocumentProgram}'s `source` gains a stated meaning per
 *    language, and the JSX transpilation step gains an owner. No shape changed:
 *    the field is the same `readonly source: string` it was, and no existing
 *    caller breaks. What changed is that it now says something.
 *
 *    It had to. `readonly source: string` on the `react` arm admitted three
 *    readings — a whole HTML document, an ES module with a default export, or a
 *    bare component expression — and said nothing about who turns JSX into
 *    something a frame can run. Every one of those readings produces a working
 *    Canvas on its own and none of them interoperates with the others, so the
 *    first host and the first surface would each have picked one privately and
 *    the mismatch would have surfaced as a blank frame with no error. That is
 *    this project's central defect class in its purest form: two halves that
 *    each work.
 *
 *    The decision, with the reasoning at the field: a `react` source is a
 *    complete ES module in JSX with a default export taking no props, and the
 *    **surface** transpiles it, because this contract's whole architecture is
 *    that the component deciding what a run may do never reads the program.
 *    A caller that had assumed "bare expression" wraps it in `export default
 *    () => (…)`; a caller that had assumed "whole document" was using the wrong
 *    arm and wants `html`.
 *
 *    Recorded by the Canvas builder, who needed the answer and could not find
 *    it. **Nothing implements the `react` arm yet** — the Canvas host's
 *    `languages` omits `react` and refuses one with `languageUnsupported` —
 *    because React 19 ships no build that can be inlined into an opaque-origin
 *    document and no transpiler is bundled. The rule is written now so that
 *    whoever bundles one is not deciding this again.
 *
 * 5. 2026-08-15 — **No shape changed. The two honesty notes at the top of this file did,
 *    because all four of their claims had become false.** They said nothing here was wired
 *    up — not in `COMMAND_ALLOWLIST`, no Rust module, not implemented by `BrowserAdapter` —
 *    and that no test enforced a single rule stated below. A host had since shipped: all
 *    three wiring clauses were untrue, and 43 Rust tests were enforcing rules from this
 *    file. Nothing is owed to a builder who coded against the old shapes, because no shape
 *    moved; the entry is here because the notes are load-bearing in the other direction. A
 *    reader who believes note 2 reads it as licence to change a rule with no machine
 *    watching, discovers a red test, and concludes the test is wrong. Understating what
 *    exists is a false claim like any other. The rewritten notes name what is enforced, what
 *    is not, and the date they were true — so the next reader can check them rather than
 *    trust them. {@link SANDBOX_CONTRACT_VERSION} is deliberately **not** bumped: it
 *    versions the shapes, and a consumer pinned to 2 is still right about every one of them.
 *
 *    Integrator's note, recorded when track 1 and track 2 were merged: these two entries
 *    were both written as `4` on branches that could not see each other, and the sandbox
 *    track's became `5` here. Neither changed a shape, so no consumer is affected by the
 *    ordering. {@link SANDBOX_CONTRACT_VERSION} reads 3 because amendment 4 bumped it;
 *    amendment 5 still does not bump it, and the sentence above should be read as "this
 *    entry does not bump it" rather than as a claim about the constant's current value.
 */
