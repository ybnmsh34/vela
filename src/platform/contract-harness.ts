/**
 * THE RUNTIME SEAM — the interface behind which a chat/agent runtime is chosen
 * and driven.
 *
 * `src/platform/contract.ts` describes **one model turn**: `chat_send` opens it,
 * `chat:event` streams it, `chat_cancel` stops it. That is the whole of what the
 * host offers, and it is deliberately not enough to run an agent: a turn that
 * ends in a tool call has to be executed and fed back, and the decision to do
 * that — how many times, with which model, against which instructions — is a
 * *loop*, not a command. This file is that loop's contract. One trip round it is
 * a **turn**; the whole loop is a **run**.
 *
 * ## Where it lives, and why it is TypeScript
 *
 * A harness performs no I/O of its own. It calls `chat_send` through the seam
 * and consumes `chat:event`, so conventions §1's "anything that talks HTTP to a
 * model goes in Rust" is untouched — the HTTP is still in `vela-providers`,
 * behind the same bridge every other renderer call uses. What lives here is
 * orchestration, which is the part that has to be substitutable in a test, and
 * `src/platform/` is where this repo keeps things that are selected at runtime
 * and swapped in tests.
 *
 * ## What this is modelled on, and where it departs
 *
 * The reference is MindsHub Cowork's harness seam, studied in
 * `docs/references/mindshub-cowork.md`. **The study is the authority here, not
 * the product's README**: the README describes the seam as carrying "streaming
 * responses, skill sync, and memory operations", and the source — quoted
 * verbatim in the study, from "cowork/harnesses/base.py" — is a Protocol with
 * exactly one method, "stream_response", plus four attributes. Skill sync and
 * memory are **not on that interface**, which is the confirmed part and the part
 * this design rests on.
 *
 * Where they *are* instead is a weaker claim and is marked as one here, because
 * the study marks it as one. A sibling package exists at that path — the study
 * lists its six filenames — and the study's own words are that harness
 * implementations calling into it is "the straightforward reading", with the
 * contents of those files explicitly UNVERIFIED. So: the interface has one
 * method (verbatim, quoted); the sibling package's role is inferred. This file
 * follows the verbatim half. {@link RuntimeHarness} has one method for that
 * reason, and the reasoning for leaving skills and memory off is written out at
 * {@link ContextResolver} rather than left implicit — and it does not depend on
 * where the reference actually put them.
 *
 * Three deliberate departures, each argued where it happens:
 *  - sequence numbers, buffering and replay are **above** the harness, not in it
 *    ({@link RunHandle});
 *  - registration is an explicit table rather than a decorator writing into a
 *    module-level dict ({@link HarnessRegistry});
 *  - the shared helper package the reference relies on by convention is an
 *    injected service here, so a test can substitute it ({@link HarnessServices}).
 *
 * ## What is guarded, and what is only written down
 *
 * `pnpm typecheck` holds every shape in this file, and that is the whole of the
 * automatic enforcement. In particular: the rule below that no surface may
 * branch on a harness id has **no test behind it**.
 * `src/platform/no-provider-leak.test.ts` scans the renderer for *backend*
 * identities and their wire tells; it has never heard of a harness id and will
 * not fail a build for one. The rule is stated, and unenforced, and saying so is
 * the point — a comment claiming a guard that does not exist is the defect this
 * repo keeps finding in itself.
 *
 * ## The rule that shapes every type below
 *
 * Conventions §0 rule 3: the UI branches on capability flags, never on an
 * identity. So a *harness* id appears in exactly two places in this file — on
 * {@link HarnessDescriptor}, which the settings picker renders, and on
 * {@link RunRequest}, which transports it to the registry. It is on no event, no
 * snapshot and no capability type. A field the renderer can read is a field the
 * renderer will eventually switch on.
 *
 * A `ProjectId` is a different kind of id and is not covered by that rule: it
 * names the user's own container, not an implementation, and branching on it is
 * ordinary. It appears on {@link RunRequest} for the reason given there.
 *
 * ## The seam with the other two frozen contracts
 *
 * A run happens inside a project and executes through the sandbox, and this file
 * restates neither:
 *
 *  - `src/platform/contract-project.ts` owns {@link ProjectId}, imported here.
 *    {@link RunRequest} carries one; `ContextSource`'s `projectInstructions`
 *    resolves to that project's `ProjectView.instructions`; and the project is
 *    what decides which directories a tool call may reach.
 *  - `src/platform/contract-sandbox.ts` owns execution. A Bash or Python tool
 *    call is a `sandbox_submit`, built by {@link ToolExecutor} — see there for
 *    the whole of what this contract says about it, which is deliberately not
 *    much. No type in this file mentions the sandbox and no type there mentions
 *    a harness; the join is made once, at the composition root.
 */

import type { Unsubscribe } from './adapter';
import type {
  ChatCancelReq,
  ChatCancelRes,
  ChatCapabilities,
  ChatError,
  ChatEventEnvelope,
  ChatMessageInput,
  ChatResponseBody,
  ChatSendReq,
  ChatSendRes,
  ChatStreamEvent,
  ContentPart,
  ContentPartInput,
  StopReason,
  StoreAppendMessageReq,
  StoreUpdateMessageReq,
  StoredMessage,
  ToolCallOutcome,
  ToolChoiceInput,
  ToolDefinitionInput,
} from './contract';
import type { ProjectId } from './contract-project';

/**
 * The number an amendment increments. **Nothing compares this to anything** —
 * there is no Rust twin and no parity test, unlike `IPC_CONTRACT_VERSION`. It
 * exists so the AMENDMENTS block at the foot of this file has something to cite
 * and so a builder can tell at a glance whether the file they read is the file
 * they were handed.
 */
export const HARNESS_CONTRACT_VERSION = 1;

/**
 * Identifies a harness implementation. Stable across releases, because it is
 * persisted as a user setting.
 *
 * A plain string alias rather than a branded type: it round-trips through
 * settings storage as a string, and a brand would only add casts at the boundary
 * without stopping the thing worth stopping — a comparison against a literal.
 * Nothing but the registry may do that. See the header.
 */
export type HarnessId = string;

/** Identifies one run. Minted by the caller — see {@link RunRequest}. */
export type RunId = string;

/* -------------------------------------------------------------------------- */
/* capabilities — the entire vocabulary a caller has for what a runtime can do */
/* -------------------------------------------------------------------------- */

/**
 * What a harness implementation can do **in principle**, independent of which
 * model it is pointed at.
 *
 * Three flags, and the shortness is deliberate: every flag here has to gate a
 * visible affordance, or it is a fact about the implementation that the UI has
 * no business knowing. A flag nobody branches on is an identity in disguise.
 *
 * Note what is **absent**: nothing about late join. Replay is implemented above
 * the harness ({@link RunHandle}), so it cannot vary between implementations and
 * a flag for it could only ever be `true`.
 */
export interface HarnessCapabilities {
  /**
   * The run may take more than one model turn. `false` means one turn and done:
   * the caller can render an answer, not a step list, and must not offer to let
   * the model continue.
   */
  readonly multiStep: boolean;
  /**
   * The harness executes tool calls and feeds results back. `false` with a
   * tool-calling model is a real combination — the model's requested calls
   * arrive on the stream as evidence and nothing runs them.
   */
  readonly toolExecution: boolean;
  /**
   * The harness can use a second model for internal steps (a summary, a title, a
   * compaction) instead of spending the primary model on them. Gates the second
   * model slot in settings; see {@link ModelAssignment}.
   */
  readonly auxiliaryModel: boolean;
}

/** The pessimistic floor, matching `NO_CAPABILITIES`'s reason for existing. */
export const NO_HARNESS_CAPABILITIES: HarnessCapabilities = {
  multiStep: false,
  toolExecution: false,
  auxiliaryModel: false,
};

/**
 * What a run can do **right now**, once the harness has been reduced by the
 * model in front of it.
 *
 * Same three field names as {@link HarnessCapabilities} and a different claim:
 * that one says "this implementation supports it", this one says "this run may
 * offer it". The pair mirrors `ChatCapabilities` (offerable) against
 * `CapabilityFinding` (how the belief was reached) — one type covering both
 * would have to lie about one of them.
 *
 * **The merge is AND, never OR**, and the caller computes it once and puts it on
 * {@link RunRequest} so the harness cannot re-derive it differently. An unprobed
 * model is `NO_CAPABILITIES` — every flag `false` — so a tool-executing harness
 * correctly offers nothing before a probe. That is the floor working, not a case
 * to special-case around.
 */
export interface RunCapabilities {
  /** `harness.multiStep`. The model has no say in this one. */
  readonly multiStep: boolean;
  /** `harness.toolExecution` and `model.toolCalls`. */
  readonly toolExecution: boolean;
  /** `harness.auxiliaryModel` and an auxiliary target was actually assigned. */
  readonly auxiliaryModel: boolean;
}

/** The floor a caller starts from before merging. */
export const NO_RUN_CAPABILITIES: RunCapabilities = {
  multiStep: false,
  toolExecution: false,
  auxiliaryModel: false,
};

/**
 * The merge, shipped rather than described.
 *
 * The rule above says the caller computes this **once**, so that two harnesses
 * cannot disagree about what the same model can do. An earlier draft stated the
 * rule and exported nothing, which left ten builders to re-derive the one thing
 * the file says must not vary — in a file that already exports
 * {@link NO_RUN_CAPABILITIES} and {@link DEFAULT_RUN_LIMITS}, so the objection
 * cannot be that a contract holds no runtime values.
 *
 * Three lines, and each one is a decision rather than an obvious `&&`:
 * `multiStep` is the harness's alone, because no model flag speaks to whether a
 * loop is allowed to go round twice; `toolExecution` needs both, because a
 * harness that runs tools against a model that cannot request them offers
 * nothing; `auxiliaryModel` needs the harness flag *and* a target actually
 * assigned, which is a fact about {@link ModelAssignment} rather than about
 * either capability set — omitting the auxiliary model is the ordinary case, not
 * a misconfiguration.
 */
export function mergeRunCapabilities(
  harness: HarnessCapabilities,
  model: ChatCapabilities,
  hasAuxiliaryTarget: boolean,
): RunCapabilities {
  return {
    multiStep: harness.multiStep,
    toolExecution: harness.toolExecution && model.toolCalls,
    auxiliaryModel: harness.auxiliaryModel && hasAuxiliaryTarget,
  };
}

/* -------------------------------------------------------------------------- */
/* registration and selection                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A harness as the settings surface sees it.
 *
 * `displayName` is rendered as-is and never parsed or matched — the same
 * contract `ModelOption.displayName` carries. `requiresModelCapabilities` is
 * spelled in `keyof ChatCapabilities` rather than in a private enum so a harness
 * cannot state a requirement the UI has no way to observe: that key set is
 * exactly what `models_capabilities` reports.
 */
export interface HarnessDescriptor {
  readonly id: HarnessId;
  readonly displayName: string;
  readonly capabilities: HarnessCapabilities;
  /**
   * Model flags that must all be `true` for this harness to be selectable. Empty
   * is the normal case for a plain chat harness, which needs nothing beyond a
   * model that answers.
   */
  readonly requiresModelCapabilities: readonly (keyof ChatCapabilities)[];
}

/**
 * A registered implementation: what it claims, and how to get one.
 *
 * `create` is a factory rather than a shared instance, and the reference does
 * the same thing — its lookup ends in `cls()`, a fresh object per call. Two runs
 * can be live at once (different conversations), so an implementation that held
 * per-run state on itself would corrupt one of them. A harness instance is
 * expected to be cheap and to outlive nothing.
 */
export interface HarnessDefinition {
  readonly descriptor: HarnessDescriptor;
  create(services: HarnessServices): RuntimeHarness;
}

/**
 * The table of registered harnesses.
 *
 * ## Why this is a table and not a decorator
 *
 * The reference registers with a class decorator that writes into a
 * module-level dict, so importing a module is what makes a harness exist. That
 * would not be a good idea here, and the reasons are about this repo rather
 * than about the language: a bundler is entitled to drop a module nobody
 * references, so the set of available harnesses would depend on the optimiser;
 * and in tests the registry would be process-global, so what one test
 * registered another would inherit. Conventions §4 already settled the shape of
 * this problem for the platform adapter — "never a module singleton, tests need
 * to substitute it" — and the answer is the same one: an explicit table, built
 * at the composition root and passed down.
 *
 * An earlier draft added a third reason — that decorators are unavailable in
 * this build — and it was **false**. `experimentalDecorators` is absent from
 * `tsconfig.app.json`, which disables the *legacy* form only; the standard form
 * has needed no flag since TypeScript 5. The reason is struck rather than
 * softened, because a contract that tells ten builders something untrue about
 * their own build configuration is doing the exact thing this repo's guards
 * exist to catch. The two reasons above stand on their own and were always the
 * load-bearing ones.
 *
 * **Order is meaningful.** `definitions` is the fallback order used by
 * selection; the first entry whose requirements the model meets is the default.
 * No id is hardcoded in this file, because a contract that names an
 * implementation has to be amended every time implementations change.
 */
export interface HarnessRegistry {
  readonly definitions: readonly HarnessDefinition[];
  /** `null` for an id this build does not have — see {@link HarnessSelection}. */
  find(id: HarnessId): HarnessDefinition | null;
}

/**
 * Builds a registry from an explicit list.
 *
 * **Duplicate ids must be rejected, loudly, by throwing.** The reference assigns
 * into a dict, so a second registration of the same id silently replaces the
 * first and the winner is whichever module imported last. This runs once at the
 * composition root, where a defect in the build's own wiring is not a state to
 * render — it is a bug that should stop the app before a user sees a harness
 * they did not choose.
 *
 * **An empty list does not throw, and the difference is not inconsistency.**
 * `noneRegistered` is a {@link SelectionReason} a caller renders. A duplicate is
 * detectable exactly once, here, at a call that happens once, and there is no
 * correct behaviour to fall back to — which of the two implementations did the
 * user want? An empty registry has one correct behaviour, and
 * {@link HarnessRuntime.select} is called on every render, so a throw there
 * would take the window down repeatedly while a user looked at a settings pane
 * that could have explained the problem. The principle is "throw when there is
 * no defensible next state", not "throw at every build defect"; both cases obey
 * it and the earlier draft stated only the first half.
 */
export type CreateHarnessRegistry = (
  definitions: readonly HarnessDefinition[],
) => HarnessRegistry;

/**
 * Why the selection is not simply the harness the user asked for.
 *
 * Enumerable and provider-neutral, like `Concern`: the UI owns every sentence.
 * `noneChosen` is a **success state** — a first-run user has never picked one —
 * and rendering it as a warning would train the user to ignore the two that
 * matter.
 */
export type SelectionReason =
  | 'noneChosen'
  /** The stored setting names a harness this build does not have. */
  | 'unknownHarnessId'
  /** The chosen harness needs a model flag this model has not established. */
  | 'modelCapabilityUnmet'
  /** The registry is empty, which is a build defect rather than a user state. */
  | 'noneRegistered';

/**
 * The outcome of picking a harness.
 *
 * A union rather than a lookup that throws, which is what the reference does
 * (`ValueError`, listing the available ids). Every one of these arms is reachable
 * from ordinary use: a settings row written by a newer build, a harness removed
 * in an update, a model that has not been probed yet. A throw at that point takes
 * the window down at launch; a union makes the caller render something.
 *
 * `substituted` is the interesting arm and the only place a *requested* id
 * travels — carried so the UI can say which choice could not be honoured. It is
 * a record of what happened, exactly as `StoredMessage.providerId` is, not a
 * switch to branch on.
 *
 * ## The commonest case, stated rather than left derivable
 *
 * First run: `requestedId` is `null`, the registry is non-empty, the first
 * entry's requirements are met. **The answer is `substituted`, with reason
 * `noneChosen` and `requestedId: null`** — not `selected`. A caller may not
 * infer otherwise from the fact that nothing went wrong.
 *
 * The rule underneath it: `selected` means *the user's stored choice was
 * honoured*, and on first run there is no stored choice to honour. Every arm
 * that is not that one carries a reason, which is why the reason lives on the
 * other two arms and not on `selected`. The UI consequence is the point —
 * `noneChosen` is a **success state**, a first-run user has never picked a
 * harness, and a surface that rendered every `substituted` as a warning would
 * warn every new user about nothing and train them past the two reasons that
 * matter.
 */
export type HarnessSelection =
  | { readonly outcome: 'selected'; readonly definition: HarnessDefinition }
  | {
      readonly outcome: 'substituted';
      readonly definition: HarnessDefinition;
      readonly requestedId: HarnessId | null;
      readonly reason: SelectionReason;
    }
  | {
      readonly outcome: 'unavailable';
      readonly requestedId: HarnessId | null;
      readonly reason: SelectionReason;
    };

/**
 * What selection is given: the user's stored choice, and what the model in front
 * of it has actually demonstrated.
 *
 * `model` is the established flag set, not the configured provider. Selection
 * never sees an endpoint, a provider id or a credential — the harness it picks
 * is a function of capability alone, which is the same rule the rest of the UI
 * lives under.
 */
export interface HarnessSelectionRequest {
  /** `null` when the user has never chosen — not an error. */
  readonly requestedId: HarnessId | null;
  readonly model: ChatCapabilities;
}

/* -------------------------------------------------------------------------- */
/* what a harness is handed                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The three chat commands, and nothing else.
 *
 * A harness is not given a `PlatformAdapter`. It would then be able to write
 * settings, delete conversations and ask about credentials, none of which
 * driving a turn requires. Conventions §3.4 makes the same argument about Tauri
 * capabilities — prefer a narrow command over a blanket grant — and the second
 * benefit is the cheap one: a harness test needs three functions, not a whole
 * fake host.
 *
 * `listen` delivers **every** turn's events, including turns this harness did
 * not start. Filter on `turnId`. The alternative — a per-turn subscription —
 * would have to be opened after the id exists, and `contract.ts` already records
 * why that loses tokens: events for a turn can arrive before the invoke promise
 * settles.
 */
export interface TurnDriver {
  send(request: ChatSendReq): Promise<ChatSendRes>;
  cancel(request: ChatCancelReq): Promise<ChatCancelRes>;
  listen(handler: (envelope: ChatEventEnvelope) => void): Promise<Unsubscribe>;
}

/**
 * A tool call the host accepted, ready to execute.
 *
 * Derived from `ToolCallOutcome` rather than restated, so the `malformed` arm
 * cannot reach an executor by construction: the host refuses to reconstruct a
 * bad call and hands the evidence to the UI instead, and a harness that could
 * take a `malformed` outcome as input would be free to undo that.
 */
export type ExecutableToolCall = Extract<ToolCallOutcome, { readonly status: 'ok' }>;

/**
 * The result of running one tool, in the vocabulary that already crosses the
 * bridge — so a harness can hand it straight to `store_append_message` or back
 * into the next turn's `parts` without a second shape in between.
 */
export type ToolResultPart = Extract<ContentPartInput, { readonly kind: 'toolResult' }>;

/**
 * ## How turn N+1's `messages` is built — the loop's one rule, decided here
 *
 * This file opens by saying the decision to execute a tool call and feed it back
 * is a loop rather than a command, and that this file is that loop's contract.
 * The accumulation rule *is* that loop, and an earlier draft left every part of
 * it to be guessed. It is not per-harness policy: the caller rebuilds
 * {@link RunRequest.input} from the store on the next run, so two harnesses that
 * accumulate differently produce two transcripts that cannot be swapped between
 * engines — losing the one property the study recommends taking whole.
 *
 * Given turn N's assembled `ChatResponseBody`, turn N+1's `messages` is turn N's
 * `messages`, then:
 *
 * 1. **The assistant's own turn, always appended**, as one `ChatMessageInput`
 *    with `role: 'assistant'`, `text: ''` and `parts` from
 *    {@link ContentPartCodec.turnToInput}. Dropping it is not an option a
 *    tool-calling loop has: the `toolCall` parts are what the tool results
 *    answer, and a backend that receives results for calls it cannot see in the
 *    history rejects the request or hallucinates around it.
 * 2. **Reasoning parts are re-sent verbatim, including `signature`.**
 *    `src/platform/contract.ts` records why: some backends require a signed
 *    reasoning block returned exactly as issued, and re-sending is therefore not
 *    free but is the only universally safe choice. The projection that leaves
 *    reasoning out belongs to the *rebuild-the-prompt-from-the-store* path
 *    (`StoreListMessagesReq.includeReasoning`), not to the live loop, which
 *    still holds the signatures it was given.
 * 3. **One message per tool result, `role: 'tool'`**, carrying exactly one
 *    {@link ToolResultPart} whose `callId` is the call it answers, in the order
 *    the calls appeared. Not `'user'`, and not several results folded into one
 *    message: `MessageRole` has a `tool` member for this, and a folded message
 *    makes a per-call `callId` ambiguous the moment two tools return.
 * 4. **Nothing else is inserted.** No synthetic "continue" turn, no system
 *    message per step. {@link RunContextRequest.systemPrompt} is composed once,
 *    by the caller, before the run.
 *
 * The same four rules decide what {@link TranscriptWriter} persists, in the same
 * order, so that a transcript read back from the store and a transcript
 * accumulated in memory are the same sequence. Where they would differ, the
 * store is right — it is the one that survives.
 */

/**
 * Runs a tool call on the caller's behalf.
 *
 * **It does not reject for a tool that failed.** A failure is a result with
 * `isError: true`, because a rejected promise carries an unbounded string that
 * would land in the transcript, and the whole error surface of this project is
 * built on that not happening. Whether the executor gates the call on user
 * approval first is its own business and invisible here; from the run's point of
 * view the tool is simply still running.
 *
 * If it rejects anyway, that is a defect in the executor and the harness must
 * fail the run with `toolExecutorFailed` — never invent a result, and never
 * quietly continue as though the tool returned nothing.
 *
 * `signal` aborts when the run is cancelled. A tool that ignores it delays the
 * run's terminal event; it cannot prevent one.
 *
 * ## Where code execution actually happens, and why it is not visible here
 *
 * A Bash or Python tool is a `sandbox_submit` in
 * `src/platform/contract-sandbox.ts`. The executor is the component that builds
 * it, because it is the only one holding both halves: the tool's arguments, and
 * — through the composition root — {@link RunRequest.projectId}, which is what
 * decides which of the user's directories the run may be handed at all. Three
 * consequences a builder needs and this interface does not show:
 *
 *  - **The approval prompt lives there, not here.** That contract's unit of
 *    approval is one submitted run, and a person may sit in front of it for
 *    minutes. From this seam the tool is simply still running.
 *  - **`signal` must reach it.** A cancelled agent run has to cancel the sandbox
 *    runs it started, with `CancelReason` `superseded`, or the frame or child
 *    process outlives the loop that asked for it.
 *  - **A sandbox refusal is a tool result, not a rejection.** It arrives as a
 *    closed `RefusalReason` on a settled event; the executor words it and
 *    returns `isError: true`. Rejecting instead would fail the whole run for a
 *    denied permission prompt, which is a thing the user did on purpose.
 *
 * None of that is enforced by anything in either file, and neither file imports
 * the other. It is written here because the alternative is ten builders each
 * discovering it while holding a half-built executor.
 */
export interface ToolExecutor {
  execute(call: ExecutableToolCall, signal: AbortSignal): Promise<ToolResultPart>;
}

/**
 * Where prompt material a run did not compose itself comes from.
 *
 * A closed set, so a run can be *reported* honestly ("this answer read two
 * skills and one memory entry") without this seam knowing what a skill or a
 * memory entry is.
 */
export type ContextSource = 'projectInstructions' | 'skill' | 'memory';

/**
 * A pointer to loadable prompt material. Carries no body.
 *
 * `title` is the user's own text — the name of their file or their rule — in the
 * same sense `ConversationSummary.title` is. The closed-vocabulary rule this
 * repo enforces everywhere is about *endpoint*-supplied strings, which this is
 * not.
 *
 * `estimatedTokens` is `null` when nothing has counted them. Never substitute a
 * zero: a budget computed from a guessed zero silently overruns the context
 * window, which is the failure `TokenUsage` writes the same warning about.
 */
export interface ContextRef {
  readonly source: ContextSource;
  /** Opaque to this seam. Whatever owns that source decides what it means. */
  readonly id: string;
  readonly title: string;
  readonly estimatedTokens: number | null;
}

/** A loaded body, paired with the ref it came from. */
export interface ContextChunk {
  readonly ref: ContextRef;
  readonly text: string;
}

/**
 * Reads skills, memory and instructions on a run's behalf.
 *
 * ## Why skill sync and memory ops are not methods on {@link RuntimeHarness}
 *
 * The specification this contract comes from lists them as part of this seam,
 * because MindsHub's README lists them. The study read the source: the Protocol
 * has one method, quoted verbatim. A sibling package exists at
 * "cowork/harnesses/memory/" and the study's reading is that implementations
 * call into it — a reading the study marks UNVERIFIED, having listed the six
 * filenames without fetching them, and it is repeated here with that mark
 * because nothing below depends on it. Three reasons to follow the source
 * rather than the README, in increasing order of how much they matter:
 *
 *  1. **The evidence.** The README's claim is the only support for putting them
 *     here, and it is contradicted by the file it describes.
 *  2. **A method on the seam cannot hold two implementations to one behaviour.**
 *     If every harness must implement `syncSkills`, the only thing keeping two
 *     of them consistent is that both call the same helper — at which point the
 *     method is a pass-through whose divergence nothing detects. That is this
 *     project's central defect class wearing an interface: the shared contract
 *     everyone believed in, that was never connected. The same argument is why
 *     sequence numbers live above the harness rather than in it.
 *  3. **Sync is not a read.** Making the on-disk set match — installing,
 *     enabling, symlinking per project — is filesystem ownership, and
 *     `docs/vela-feature-spec.md` §1.6 already settles that: the filesystem is
 *     the source of truth and every user-facing artefact is plain text on disk.
 *     A run reads that; it does not maintain it.
 *
 * ## What carries them instead
 *
 * The host. Skills and memory are files, reached through `<domain>_<verb>`
 * commands owned by whatever contract owns those surfaces. **Today there are
 * none**: `COMMAND_ALLOWLIST` has nothing for skills or memory, so a builder
 * wiring this up will be implementing a resolver over something that does not
 * exist yet, and the honest first implementation is one backed by the run's own
 * project instructions and nothing else.
 *
 * That first implementation is buildable now and the seam for it is frozen:
 * `projectInstructions` resolves to `ProjectView.instructions` for
 * {@link RunRequest.projectId}, through `project_get` in
 * `src/platform/contract-project.ts`. Those instructions are a database column
 * rather than a file, so `index()` returns at most one ref for that source and
 * `estimatedTokens` is `null` until something counts it. The `skill` source has
 * a shape waiting for it there too — `ProjectView.enabledSkills` names them and
 * `ProjectLayout.mounts` says which ones actually mounted — but no command
 * reads a skill's *body*, so a resolver cannot serve that source yet and must
 * not pretend to by returning refs it cannot load.
 *
 * ## Read-only, deliberately
 *
 * There is no `write`. The reference's memory is written automatically by a
 * background consolidator that decides what to remember without the user asking,
 * and the study's explicit recommendation is that Vela not take that. If memory
 * writing is ever added it is an action the user takes, through a command, in a
 * surface that shows them what was written — not something a run does on its way
 * past.
 *
 * ## Failure
 *
 * `load` resolves to `null` for material that has gone — a skill file deleted
 * between the index and the load. The run continues without it and **must** emit
 * a `contextUnavailable` degradation; a run that quietly ran with less than it
 * was asked to is the silent reduction conventions §9 forbids.
 */
export interface ContextResolver {
  /**
   * What is available, cheaply, without bodies. The reference's skill format
   * loads name and description for everything and the body only on activation;
   * an index that returned bodies would make that impossible.
   */
  index(): Promise<readonly ContextRef[]>;
  load(ref: ContextRef): Promise<ContextChunk | null>;
}

/**
 * Writes the run's messages into the store as it goes.
 *
 * ## Why this is on the seam rather than in a sentence
 *
 * {@link RunHandle} states the durability rule: a run dies with the renderer
 * process, so a harness **must** write the transcript incrementally rather than
 * at the end, or a reload leaves nothing where a partial answer should be. An
 * earlier draft stated that rule and then handed a harness
 * `{ turns, tools, context, now }` — no store surface anywhere, and an explicit
 * note that a harness is not given a `PlatformAdapter`. The one rule the whole
 * durability story rests on had no way to be obeyed and no assigned owner.
 *
 * The repair is this interface, not a widening of what a harness may reach. Its
 * two methods are `store_append_message` and `store_update_message` and nothing
 * else: not `list`, not `remove`, both of which exist on the repository that
 * backs it (`src/data/transcript-repository.ts`) and neither of which driving a
 * run requires. Conventions §3.4 makes the argument in the Tauri capability
 * vocabulary and it is the same argument — prefer a narrow surface over a
 * blanket grant — and conventions §1 keeps the host call itself in `src/data/`,
 * which is where the implementation of this comes from.
 *
 * **Who constructs it:** the composition root, from
 * `createTranscriptRepository(adapter)`, adapted to these two methods. A harness
 * never sees an adapter and never closure-captures one, which was the other way
 * ten builders would have resolved the gap and the way the file's own security
 * intent forbids.
 *
 * **What must be written, and when.** One `append` with status `streaming` when
 * a turn opens; one `update` closing it out — `complete`, `cancelled` or
 * `failed` — when it ends. A tool result is its own appended message; see the
 * accumulation rule below {@link ToolResultPart}. A run that is killed mid-turn
 * therefore leaves a row marked `streaming`, which is exactly the state
 * `StoredMessageStatus` has for it and is readable rather than absent.
 */
export interface TranscriptWriter {
  append(request: StoreAppendMessageReq): Promise<StoredMessage>;
  update(request: StoreUpdateMessageReq): Promise<StoredMessage>;
}

/**
 * Converts one assembled turn's content into the vocabulary that goes back over
 * the bridge.
 *
 * ## The conversion nobody would have expected to need
 *
 * `ChatResponseBody.parts` is `ContentPart`; `ChatMessageInput.parts` is
 * `ContentPartInput`. `src/platform/contract.ts` documents the difference and it
 * is exactly one field: an image's `data` is `readonly number[]` coming out and
 * a base64 `string` going in. Every other kind is identical, which is precisely
 * what makes it dangerous — a builder who checks two or three kinds concludes
 * the two types are the same and writes a cast.
 *
 * That conversion is needed twice on every loop: to persist a turn through
 * {@link TranscriptWriter}, and to put the assistant's own turn back into the
 * next request's `messages`. One implementation, at the composition root, is the
 * same argument this file makes for {@link RunCapabilities} — a rule that must
 * not vary should not be re-derived ten times — and it keeps the base64 encoding
 * in one place rather than in ten, where the encodings would differ.
 */
export interface ContentPartCodec {
  toInput(part: ContentPart): ContentPartInput;
  /** Every part of an assembled turn, in order. Convenience over the above. */
  turnToInput(response: ChatResponseBody): readonly ContentPartInput[];
}

/**
 * Everything a harness is allowed to reach, handed to it at construction.
 *
 * This is the injected form of the reference's shared helper package. There, a
 * harness reaches for the same module by importing it, which makes "every
 * harness behaves the same" a convention nobody can check; here it is a
 * parameter, which makes it substitutable in a test and impossible to acquire by
 * accident.
 *
 * Five members, and the list is closed. Each one is something driving a run
 * genuinely requires and none of them is a general capability: there is no
 * settings access, no conversation management, no credential question, and — the
 * one worth naming because its absence used to be a hole rather than a
 * decision — no adapter behind any of them.
 */
export interface HarnessServices {
  readonly turns: TurnDriver;
  readonly tools: ToolExecutor;
  readonly context: ContextResolver;
  /** See {@link TranscriptWriter}. The durability rule at {@link RunHandle} is unmeetable without it. */
  readonly transcript: TranscriptWriter;
  /** See {@link ContentPartCodec}. */
  readonly parts: ContentPartCodec;
  /**
   * Milliseconds since the epoch. Injected because {@link RunLimits} is enforced
   * against it and conventions §8 requires that a test can drive the clock
   * instead of sleeping.
   */
  now(): number;
}

/* -------------------------------------------------------------------------- */
/* the request                                                                */
/* -------------------------------------------------------------------------- */

/** Which slot a model fills in a run. */
export type ModelRole = 'primary' | 'auxiliary';

/**
 * One endpoint-and-model pair, in the same two fields `chat_send` takes.
 *
 * Transported, never inspected. A harness passes these through to `chat_send`
 * and must not read either string for anything else — the moment one is compared
 * against a literal, adding a backend stops being a zero-change operation under
 * `src/`.
 */
export interface ModelTarget {
  readonly providerId: string;
  readonly modelId: string;
}

/**
 * The models a run may use.
 *
 * The reference exposes three slots (planning, routing, coding), and the study
 * does establish that they exist — from the homepage, the download page and a
 * recorded walkthrough — describing them as a product-level Model Router set
 * "separately, and orthogonally" to the harness. So the reduction to two is not
 * a doubt about whether those three are real, and an earlier draft that said
 * "nothing here can verify them" was overclaiming in the direction of its own
 * conclusion.
 *
 * What the study does not establish is what each slot *does* — which steps route
 * to which model, and whether that mapping is stable across the two harnesses it
 * documents. Three names whose semantics are unverified would arrive here as
 * three fields a builder has to guess the meaning of. Two is what this contract
 * freezes because the distinction that survives translation without a guess is
 * "the model the user is talking to" against "a cheap model for bookkeeping" —
 * titles, summaries, compaction.
 *
 * `auxiliary` omitted is the ordinary case, not a misconfiguration: the spec's
 * degradation Axis F is precisely "no second model available". The harness then
 * uses `primary` for everything and emits `auxiliaryModelUnavailable`, because a
 * reduction the user cannot see is the one forbidden outcome.
 */
export interface ModelAssignment {
  readonly primary: ModelTarget;
  readonly auxiliary?: ModelTarget | undefined;
}

/**
 * The ceilings a run stops at.
 *
 * These are a guard against a loop that will not end, not a tuning surface.
 * Hitting one is not a failure: the run finishes, and says it was capped.
 */
export interface RunLimits {
  /** Model turns. A single-turn harness is capped at 1 regardless of this. */
  readonly maxSteps: number;
  /** Tool executions across the whole run, not per turn. */
  readonly maxToolCalls: number;
  /** Wall clock from the first event to the terminal one, measured on `now()`. */
  readonly wallClockMs: number;
}

/**
 * The defaults every caller starts from.
 *
 * **The numbers are a convention, not a measurement.** No benchmark supports
 * them; they exist so that ten builders share one set of ceilings instead of
 * inventing ten, and so a runaway loop against a local endpoint stops on its own
 * within a coffee break. Change them by amendment, not in a caller.
 */
export const DEFAULT_RUN_LIMITS: RunLimits = {
  maxSteps: 12,
  maxToolCalls: 32,
  wallClockMs: 10 * 60 * 1000,
};

/**
 * The floor on how much of a run stays replayable. See
 * {@link RunSnapshot.retainedFrom}.
 *
 * A count of events rather than of bytes, because an event is what a `seq`
 * addresses and a byte budget would make `retainedFrom` depend on how chatty the
 * model happened to be. Four thousand is roughly a long answer's worth of
 * `textDelta`s plus its tool traffic — enough that an ordinary run replays whole
 * and a ten-minute runaway does not grow without bound.
 *
 * Like {@link DEFAULT_RUN_LIMITS}, this is a convention rather than a
 * measurement, and it is a **floor**: an implementation may retain more, and
 * one that retains everything is conforming. What it may not do is retain less
 * and stay silent about it — that is what `replayedFrom` is for.
 */
export const RUN_BUFFER_MIN_EVENTS = 4096;

/**
 * What the run must read before its first turn.
 *
 * Refs, not text: everything a run loads goes through {@link ContextResolver},
 * so every load produces a `contextLoaded` event and the UI can report what the
 * answer was actually built from. A request that carried bodies would let
 * material reach the model with no record that it did.
 *
 * `systemPrompt` is the only free text here and it is the caller's own
 * composition. A harness may add to it; what it may not do is replace it, since
 * the user's instructions came through it.
 */
export interface RunContextRequest {
  readonly systemPrompt: string | null;
  /**
   * Loaded up front, in this order. Anything else the harness finds through
   * {@link ContextResolver.index} it loads only when the work calls for it —
   * that is the point of an index that carries no bodies.
   *
   * **Where a caller gets these**: {@link HarnessRuntime.context}, which is the
   * same resolver instance the harness will be handed. The caller indexes,
   * picks, and passes refs; the harness loads them. An earlier draft exposed the
   * resolver only *inside* {@link HarnessServices}, which left the only source
   * of the values this field requires unreachable from the only place that can
   * fill it in.
   *
   * Empty is the ordinary answer for a plain chat run and is not a degradation.
   */
  readonly preload: readonly ContextRef[];
}

/**
 * Start a run.
 *
 * The **caller** mints `runId`, for the reason `contract.ts` gives for minting
 * `turnId` in the renderer: a subscriber that had to wait for the id would miss
 * the first events. The directory rejects an id already live.
 */
export interface RunRequest {
  readonly runId: RunId;
  /**
   * The conversation this run belongs to. At most one run may be live per
   * conversation ({@link LiveRuns}), which is the same key the reference cancels
   * and tails on.
   */
  readonly conversationId: string;
  /**
   * The project this run belongs to, from `src/platform/contract-project.ts`.
   *
   * Required, with no null arm: that contract seeds `DEFAULT_PROJECT_ID` so that
   * "no project" is never a state, and a nullable field here would recreate the
   * two code paths it exists to collapse.
   *
   * It is here rather than derived from `conversationId` because the derivation
   * does not exist yet — `ConversationSummary` in `src/platform/contract.ts`
   * carries no project id, and that contract's own header says so. Carrying it
   * on the request means this file needs no amendment when the column lands; it
   * means the caller resolves the project once, before the run, instead of the
   * harness resolving it per turn; and it is what lets a tool call be scoped —
   * see {@link ToolExecutor}.
   *
   * Nothing the run emits carries it. It is an input, not a fact about the
   * answer.
   */
  readonly projectId: ProjectId;
  /**
   * The harness the caller selected. Present so the directory can resolve it;
   * it appears on nothing the run emits.
   */
  readonly harnessId: HarnessId;
  readonly models: ModelAssignment;
  /** The conversation so far, in the shape `chat_send` already takes. */
  readonly input: readonly ChatMessageInput[];
  /**
   * Tools offered for this run. Per-run for the same reason `chat_send` takes
   * them per-turn: which tools are available is a property of what the user is
   * doing. Omit for a run with no tool use.
   */
  readonly tools?: readonly ToolDefinitionInput[] | undefined;
  readonly toolChoice?: ToolChoiceInput | undefined;
  readonly context: RunContextRequest;
  readonly limits: RunLimits;
  /**
   * Computed by the caller per {@link RunCapabilities}. Handed in rather than
   * derived by the harness so that two harnesses cannot disagree about what the
   * same model can do.
   */
  readonly capabilities: RunCapabilities;
}

/* -------------------------------------------------------------------------- */
/* the event stream                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Every reduction a run made against what was asked.
 *
 * A separate union from `Degradation` rather than an extension of it, because
 * that type mirrors a Rust enum in `vela-providers` and a renderer-side variant
 * would break the parity test that keeps the two honest. The two are reported
 * side by side and never merged: provider degradations arrive inside `done`,
 * these arrive as their own event.
 *
 * Nothing here restates a provider degradation. Malformed tool calls, emulated
 * tool calling and context reduction are already reported by the host, and a
 * second copy would let a UI show one and not the other.
 */
export type RunDegradation =
  | {
      /** No auxiliary model was assigned; internal steps ran on the primary. */
      readonly kind: 'auxiliaryModelUnavailable';
    }
  | { readonly kind: 'stepLimitReached'; readonly steps: number }
  | { readonly kind: 'toolCallLimitReached'; readonly calls: number }
  | { readonly kind: 'wallClockLimitReached'; readonly elapsedMs: number }
  | {
      /** Named material was gone by the time the run tried to load it. */
      readonly kind: 'contextUnavailable';
      readonly ref: ContextRef;
    };

/**
 * Why a run failed, when it was not the model's doing.
 *
 * **There is no free-text field here, and that is the same design decision
 * `ChatError` documents.** A harness fault is one of a closed set; the detail
 * belongs in the user's own opt-in local debug log, not in a string that ends up
 * rendered.
 */
export type RunFailureCause =
  /** {@link ToolExecutor.execute} rejected instead of returning a result. */
  | 'toolExecutorFailed'
  /** {@link ContextResolver} rejected. A missing ref is a degradation, not this. */
  | 'contextResolverFailed'
  /** The harness itself threw. Reported rather than swallowed. */
  | 'harnessFault';

/**
 * A provider failure travels as `ChatError`, unchanged — it is the one error
 * taxonomy and re-wrapping it would strip the `Diagnosis` a user needs to tell
 * which of three configured endpoints failed.
 *
 * A harness failure does not travel that way, deliberately. Forcing it into
 * `ChatError` would mean fabricating a `Diagnosis`: inventing a `cause` from a
 * vocabulary that describes endpoints, and a correlation id for an exchange that
 * never happened.
 */
export type RunFailure =
  | { readonly kind: 'provider'; readonly error: ChatError }
  | { readonly kind: 'harness'; readonly cause: RunFailureCause };

/**
 * How a run ended. Exactly one of these is emitted, exactly once, as the last
 * event of every run.
 *
 * `completed.stopReason` is the **last turn's** stop reason, carried so a caller
 * does not have to remember it. When a run ended at a limit the stop reason
 * still describes the model's last turn; the degradation is what says the run
 * was capped.
 */
export type RunOutcome =
  | { readonly type: 'completed'; readonly stopReason: StopReason }
  | { readonly type: 'cancelled' }
  | { readonly type: 'failed'; readonly failure: RunFailure };

/** A run that has not ended yet, plus the three that have. */
export type RunStatus =
  | { readonly type: 'running'; readonly step: number }
  | RunOutcome;

/**
 * The run stream.
 *
 * Tagged `type` rather than `kind` to sit beside `ChatStreamEvent`, which is the
 * vocabulary this one wraps. **`chat` carries those six events verbatim** — this
 * is not a second streaming vocabulary and must never become one. A renderer
 * that can already draw a `textDelta` needs no new code to draw a run.
 *
 * What is added is only what one turn cannot say:
 *  - which turn, and which model slot is running it, because a run has many;
 *  - tool execution, which happens between turns and is Vela's own work — the
 *    spec's first architectural fact is that every tool is a client tool;
 *  - what the run read before it started;
 *  - the run's own terminal state, which is not any turn's.
 *
 * There is deliberately **no `turnFinished`**: a turn ends with `chat.done` or
 * `chat.error`. A second way to know the same thing is a second thing that can
 * disagree.
 *
 * There is also no per-run usage total. `TokenUsage` fields are `null` for "not
 * reported", and summing them would mean treating an unreported turn as zero,
 * which is a claim. Usage is per turn, on the events that already carry it.
 */
export type RunEvent =
  | {
      /** Always seq 0, so a late joiner replaying from 0 learns the shape first. */
      readonly type: 'runStarted';
      readonly capabilities: RunCapabilities;
    }
  | { readonly type: 'contextLoaded'; readonly ref: ContextRef }
  | {
      readonly type: 'turnStarted';
      readonly turnId: string;
      /** 1-based. `step` 1 is the first model turn of the run. */
      readonly step: number;
      readonly model: ModelRole;
    }
  | { readonly type: 'chat'; readonly turnId: string; readonly event: ChatStreamEvent }
  | { readonly type: 'toolCallStarted'; readonly call: ExecutableToolCall }
  | { readonly type: 'toolCallFinished'; readonly result: ToolResultPart }
  | { readonly type: 'degraded'; readonly degradation: RunDegradation }
  | { readonly type: 'runFinished'; readonly outcome: RunOutcome };

/**
 * One event, positioned in its run.
 *
 * Mirrors `ChatEventEnvelope`, with `seq` added — the whole of what late join
 * needs. `seq` is dense and 0-based within a run and is assigned by
 * {@link RunHandle}, never by the harness: an implementation that numbered its
 * own events would be one that could number them differently, and the replay
 * contract below is only as good as the two numbering schemes agreeing.
 */
export interface RunEventEnvelope {
  readonly runId: RunId;
  readonly seq: number;
  readonly event: RunEvent;
}

/* -------------------------------------------------------------------------- */
/* the seam itself                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Emits one event into the run. Synchronous and returning nothing, because
 * {@link RunHandle} has to be able to number, buffer and fan it out before the
 * next one arrives; an emitter that could be awaited would let two events race
 * into the same seq.
 */
export type RunEmit = (event: RunEvent) => void;

/**
 * The only thing a caller can do to a run in flight.
 *
 * `cancel()` resolving is **not** the end of the run. The run is over when
 * `runFinished` reaches the stream, and a caller that treats the promise as the
 * end will race the last tokens — the same shape as `ChatCancelRes.cancelled`
 * being `false` for a turn that had already finished, which is a race and not an
 * error. Cancelling twice is legal and does nothing the second time.
 */
export interface RunController {
  cancel(): Promise<void>;
}

/**
 * **The seam. One method, on purpose.**
 *
 * The reference's Protocol has exactly one abstract method, and everything the
 * README additionally claimed for it turned out to live elsewhere. This file
 * keeps that shape and states the rule that produces it: a method belongs here
 * only if two implementations could honestly answer it differently. Numbering
 * events, buffering them for replay, tracking which runs are live, resolving a
 * skill from disk — none of those could, so none of them are here.
 *
 * An implementation must, without exception:
 *  - emit `runStarted` first and exactly one {@link RunOutcome} last, even when
 *    it fails immediately, because everything downstream keys off that pair;
 *  - stop within its {@link RunLimits} and report the cap it hit;
 *  - report every reduction as a {@link RunDegradation} rather than degrading
 *    quietly (conventions §9.6 — silently wrong output is the one forbidden
 *    outcome);
 *  - hold no state that outlives one call to `start`.
 */
export interface RuntimeHarness {
  start(request: RunRequest, emit: RunEmit): RunController;
}

/* -------------------------------------------------------------------------- */
/* live runs, and late join                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Whether an event is being replayed or is arriving live.
 *
 * Given to every listener because the two want different rendering: a replayed
 * token should appear at once, a live one may animate. Without this a late
 * joiner replays a thousand deltas through a typing animation and looks broken.
 */
export type RunDelivery = 'replay' | 'live';

export type RunListener = (envelope: RunEventEnvelope, delivery: RunDelivery) => void;

/** Where to start. Omit `fromSeq` for "everything retained", which is the default. */
export interface SubscribeOptions {
  readonly fromSeq?: number | undefined;
}

/**
 * A live subscription, and what it managed to replay.
 *
 * **The replay is delivered before `subscribe` returns.** It is synchronous
 * against an in-memory buffer, and making it so removes a whole class of race:
 * a caller that awaited a replay would have to reason about events emitted while
 * it waited. That is also what lets these two numbers be honest by the time the
 * caller reads them.
 *
 * `replayedFrom` greater than the `fromSeq` that was asked for is the truncation
 * signal — the buffer no longer holds that far back. The caller has lost events
 * and must say so or refetch the transcript; it must not render the remainder as
 * though it were the whole answer.
 */
export interface RunSubscription {
  /** First seq actually replayed. Equal to `nextSeq` when nothing was replayed. */
  readonly replayedFrom: number;
  /** The seq live delivery will begin at: one past the last replayed event. */
  readonly liveFrom: number;
  unsubscribe(): void;
}

/**
 * A run's state at a glance, for a caller that has not subscribed — the
 * navigation surface, a background-task list, a component deciding on mount
 * whether to attach at all.
 *
 * This is the equivalent of the reference's in-flight check, which exists for
 * exactly that reason: so a renderer can decide whether to open a tail before
 * opening one.
 *
 * Note what is **absent**: no harness id, no provider id, no model id. Which
 * runtime is answering is not something a background-task row should be able to
 * branch on, and the run's own events do not carry it either.
 */
export interface RunSnapshot {
  readonly runId: RunId;
  readonly conversationId: string;
  readonly status: RunStatus;
  readonly capabilities: RunCapabilities;
  /** The seq the next event will carry; `0` before anything has been emitted. */
  readonly nextSeq: number;
  /**
   * Oldest seq still replayable.
   *
   * **This moves, including while the run is live**, and an earlier draft pinned
   * it at `0` for a run's whole life. That version bought "a caller returning to
   * a live run is guaranteed the whole run" with an unbounded buffer in renderer
   * memory for up to `wallClockMs` — ten minutes by default, of every token of
   * every turn — with no permitted mitigation, and it made the truncation signal
   * on {@link RunSubscription} unreachable for exactly the case its own doc used
   * to motivate it. A guarantee that costs an unbounded allocation is not one a
   * contract should extract from ten builders.
   *
   * The rule instead: an implementation retains at least
   * {@link RUN_BUFFER_MIN_EVENTS} events and may drop older ones, oldest first.
   * `retainedFrom` is what it actually still holds, and a late joiner learns from
   * `replayedFrom` that it lost some. `0` remains the common case, because most
   * runs never reach the floor.
   */
  readonly retainedFrom: number;
  readonly startedAtMs: number;
  readonly degradations: readonly RunDegradation[];
}

/**
 * A run, addressable after the thing that started it is gone.
 *
 * ## Late join, and how far it actually goes
 *
 * The reference's producer is detached **server-side**: closing the connection
 * does not stop the run, and a client reattaches on a "from_seq" cursor that
 * replays the buffer and then tails live. That sequencing is worth taking whole
 * and is what {@link RunHandle.subscribe} implements.
 *
 * What does not transfer is the durability, and this is the sentence a builder
 * needs: **a run here dies with the renderer process.** The buffer is in
 * JavaScript memory, so a run survives navigating away, unmounting the
 * conversation, and any number of subscribers coming and going — but not a
 * reload, not a window close, and not a crash. Nothing in `COMMAND_ALLOWLIST`
 * starts a host-owned producer; `chat_send` streams one turn to the renderer
 * that asked for it and stops when nobody is listening.
 *
 * The consequence is a rule, not a caveat: **a harness must write the transcript
 * as the run goes**, not at the end, through {@link TranscriptWriter} on
 * {@link HarnessServices} — which is on the seam precisely so that this sentence
 * names something a harness can actually reach. A run killed by a reload then
 * leaves a readable partial answer marked `streaming` rather than nothing at
 * all. What gets written and in what order is the accumulation rule stated below
 * {@link ToolResultPart}; the two are the same list, deliberately.
 *
 * Genuinely resumable background work needs a host command that owns the
 * producer, which is an amendment to this file and a new entry in the allowlist
 * — not something a builder can add from the renderer side.
 */
export interface RunHandle {
  readonly runId: RunId;
  snapshot(): RunSnapshot;
  /**
   * Replay from `fromSeq`, then live, with no gap and no duplicate. Multiple
   * subscribers are ordinary — the transcript and a background-task pane can
   * both watch one run, which is exactly what the reference's in-flight check is
   * for — and each gets its own replay.
   */
  subscribe(listener: RunListener, options?: SubscribeOptions): RunSubscription;
  /** See {@link RunController.cancel}: the run ends at `runFinished`, not here. */
  cancel(): Promise<void>;
}

/** Why a run could not be started. Each is a state to render, not a throw. */
export type RunRejection =
  /** A run is already live for this conversation. */
  | 'conversationBusy'
  /** That `runId` is already live. The caller minted a duplicate. */
  | 'duplicateRunId'
  /** `harnessId` is not in the registry. Selection should have caught this. */
  | 'unknownHarnessId';

export type RunStart =
  | { readonly outcome: 'started'; readonly handle: RunHandle }
  | { readonly outcome: 'rejected'; readonly reason: RunRejection };

/**
 * The live-run directory: the layer that owns sequencing, buffering and lookup,
 * so no harness has to.
 *
 * The reference splits the same way — a Protocol with one method, and a separate
 * registry of run handles in the endpoint layer that owns the buffer and the
 * cancel/tail routes. Keeping it split is what makes replay a property of the
 * seam instead of a promise each implementation makes separately.
 *
 * **At most one live run per conversation.** That is the key the reference
 * cancels and tails on, and it is what makes {@link forConversation} answerable
 * at all. Two runs against two different conversations are fine as far as this
 * contract is concerned; whether two at once against one local endpoint is
 * *wise* is the spec's Axis G concurrency question and is not decided here.
 */
export interface LiveRuns {
  start(request: RunRequest): RunStart;
  /** `null` once a finished run has been dropped. Not an error — ask the store. */
  get(runId: RunId): RunHandle | null;
  /** The in-flight check a conversation view makes on mount, before subscribing. */
  forConversation(conversationId: string): RunHandle | null;
  /** Every run the directory still holds, finished ones included until dropped. */
  list(): readonly RunSnapshot[];
}

/**
 * The composed runtime: what registers, what picks, and what is running.
 *
 * Built once at the composition root and passed down. Not a module singleton —
 * conventions §4, and the same reason: a test has to be able to substitute one.
 */
export interface HarnessRuntime {
  readonly registry: HarnessRegistry;
  readonly runs: LiveRuns;
  /**
   * The same {@link ContextResolver} instance every harness this runtime builds
   * will be handed.
   *
   * Exposed because a caller has to index before it can fill
   * {@link RunContextRequest.preload}, and the only other place the resolver
   * appears is inside {@link HarnessServices}, which a caller never holds. One
   * instance rather than two: a caller that indexed against a different resolver
   * than the run loads from would produce refs that resolve to `null` and a
   * `contextUnavailable` degradation for material that was never missing.
   */
  readonly context: ContextResolver;
  /**
   * Pure and synchronous: it reads the registry and the model's established
   * flags and returns an outcome. It performs no I/O, so the settings surface
   * can call it on every render to show what would happen without starting
   * anything.
   */
  select(request: HarnessSelectionRequest): HarnessSelection;
}

/* ==========================================================================
 * AMENDMENTS
 * --------------------------------------------------------------------------
 * (none)
 *
 * This file is frozen: builders code against it without being able to ask, so a
 * silent edit is worse than a wrong shape. To change it, append a numbered entry
 * here — the date, what changed, and which callers have to be revisited — in the
 * same commit as the change, and bump HARNESS_CONTRACT_VERSION.
 * ==========================================================================
 */
