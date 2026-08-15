/**
 * The composition root of the runtime seam: what registers, what picks, and what
 * is running.
 *
 * `HarnessRuntime` is built once and passed down. Not a module singleton —
 * conventions §4, and the same reason as the platform adapter: a test has to be
 * able to substitute one. Nothing in this file is exported as a live instance.
 *
 * ## The knot this file exists to tie
 *
 * `CreateLiveRuns` takes a `HarnessServicesFactory`, and a services bundle
 * contains a `ToolExecutor`. When the executor is one that starts subagent runs,
 * it needs the very directory whose construction takes the factory that builds
 * it. That is a genuine cycle, and there is exactly one honest place to break
 * it: here, where both halves are visible. `toolsFor` therefore receives the
 * directory as an argument rather than closing over one, so no caller has to
 * discover the cycle for itself and no caller can break it a second, different
 * way.
 *
 * ## What is per run and what is shared, made explicit
 *
 * `HarnessServices` is per run — the factory type says so — but not every member
 * varies. `tools` is rebuilt for each run, because it is scoped by that run's
 * project and must cancel the sandbox runs *that* run started. `context` **is**
 * `contextFor(request.projectId)`, the same resolver the caller indexed
 * `RunContextRequest.preload` against, which is what makes those refs load at
 * all. `turns`, `transcript`, `parts` and `now` are one object each for the
 * application and are closed over: they take no project, `parts` is pure, and a
 * second clock is a second answer to what time it is.
 */

import type { ContentPartCodec, ContextResolver } from '@/platform/contract-harness';
import type {
  HarnessDefinition,
  HarnessRuntime,
  HarnessSelection,
  HarnessSelectionRequest,
  HarnessServices,
  HarnessServicesFactory,
  LiveRuns,
  RunRequest,
  ToolExecutor,
  TranscriptWriter,
  TurnDriver,
} from '@/platform/contract-harness';
import type { ProjectId } from '@/platform/contract-project';

import { agentLoopHarness, singleTurnHarness } from './agent-loop-harness';
import { contentPartCodec } from './content-part-codec';
import { createHarnessRegistry, selectHarness } from './harness-registry';
import { createLiveRuns } from './live-runs';
import { createProjectContextResolver, type ProjectInstructionsReader } from './project-context';

/**
 * The build's harnesses, in fallback order.
 *
 * Order is meaningful: selection takes the first entry whose requirements the
 * model meets, so the multi-step loop is the default and the single-turn one is
 * a choice a user makes. No id is compared against a literal anywhere outside
 * the registry — see the no-branching rule in `contract-harness.ts`.
 */
export const DEFAULT_HARNESS_DEFINITIONS: readonly HarnessDefinition[] = [
  agentLoopHarness,
  singleTurnHarness,
];

export interface HarnessRuntimeOptions {
  /** The three chat commands. One instance for the application. */
  readonly turns: TurnDriver;
  /**
   * `store_append_message` and `store_update_message`, and nothing else. The
   * repository at `src/data/transcript-repository.ts` satisfies this as it
   * stands; a harness never sees the adapter behind it.
   */
  readonly transcript: TranscriptWriter;
  /** How a run's tools are built. Receives the directory to break the cycle. */
  readonly toolsFor: (request: RunRequest, runs: LiveRuns) => ToolExecutor;
  /** Backs the `projectInstructions` context source. */
  readonly readProjectInstructions: ProjectInstructionsReader;
  readonly definitions?: readonly HarnessDefinition[] | undefined;
  readonly parts?: ContentPartCodec | undefined;
  /** Milliseconds since the epoch. Injected so a test can drive the clock. */
  readonly now?: (() => number) | undefined;
}

export function createHarnessRuntime(options: HarnessRuntimeOptions): HarnessRuntime {
  const registry = createHarnessRegistry(options.definitions ?? DEFAULT_HARNESS_DEFINITIONS);
  const parts = options.parts ?? contentPartCodec;
  const now = options.now ?? ((): number => Date.now());

  // Memoised per project, which the contract names as one of the two conforming
  // choices. The property that matters is not identity but interchangeability —
  // the same refs out, the same bodies out — and `createProjectContextResolver`
  // holds no state, so this cache is an allocation saving and nothing more.
  const resolvers = new Map<ProjectId, ContextResolver>();
  const contextFor = (projectId: ProjectId): ContextResolver => {
    const existing = resolvers.get(projectId);
    if (existing !== undefined) return existing;
    const made = createProjectContextResolver(projectId, options.readProjectInstructions);
    resolvers.set(projectId, made);
    return made;
  };

  let runs: LiveRuns | null = null;
  const services: HarnessServicesFactory = (request: RunRequest): HarnessServices => {
    const directory = runs;
    if (directory === null) {
      // Unreachable: the only caller of this factory is `LiveRuns.start`, and
      // `runs` is assigned before anything holds the directory to call it on.
      // Thrown rather than asserted away, because a non-null assertion here
      // would be a claim about a cycle instead of a check on one.
      throw new Error('harness services requested before the run directory was built');
    }
    return {
      turns: options.turns,
      tools: options.toolsFor(request, directory),
      context: contextFor(request.projectId),
      transcript: options.transcript,
      parts,
      now,
    };
  };

  runs = createLiveRuns(registry, services);

  return {
    registry,
    runs,
    contextFor,
    select: (request: HarnessSelectionRequest): HarnessSelection => selectHarness(registry, request),
  };
}
