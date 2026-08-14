/**
 * A `ContextResolver` over one project's instructions, and nothing else.
 *
 * `contract-harness.ts` is explicit about how far a first implementation can
 * honestly go: `COMMAND_ALLOWLIST` has nothing for skills or memory, and no
 * command reads a skill's *body*, so a resolver "cannot serve that source yet
 * and must not pretend to by returning refs it cannot load". This one indexes
 * exactly one source — `projectInstructions` — and returns nothing for the
 * other two. When a skills command lands, the `skill` arm belongs here.
 *
 * The instructions themselves are read through an injected function rather than
 * an adapter. `src/platform/contract.ts` has no `project_get` in its allowlist
 * either, so there is no host call to make yet; the seam is a function so the
 * composition root can supply one the day there is, without this file changing.
 *
 * ## The interchangeability rule, and why this shape satisfies it
 *
 * `HarnessRuntime.contextFor` states it: two resolvers for the same `projectId`
 * must be interchangeable — the same refs out of `index`, the same bodies out of
 * `load` — and memoising one per project and returning a fresh object per call
 * are both conforming. Nothing here holds state: the ref id is derived from the
 * project id, and `load` re-reads. Two resolvers for one project cannot diverge
 * because there is nothing for them to diverge *in*. Material that genuinely
 * changed in between is the one difference allowed to show, and it shows as
 * `load` answering `null`, which is the `contextUnavailable` path.
 */

import type { ProjectId } from '@/platform/contract-project';
import type { ContextChunk, ContextRef, ContextResolver } from '@/platform/contract-harness';

/**
 * Reads a project's instructions. `null` for a project that has none, or that
 * has gone.
 */
export type ProjectInstructionsReader = (projectId: ProjectId) => Promise<string | null>;

/**
 * The id of the single ref this resolver can produce.
 *
 * `ContextRef.id` is opaque to the seam, so nothing outside this file may parse
 * it. It is derived from the project id for one reason: `load` has to be able to
 * refuse a ref that came from another project's resolver, and comparing against
 * what this resolver would itself have minted is the only check available to it.
 * A ref it does not recognise resolves `null` rather than being guessed at.
 */
function instructionsRefId(projectId: ProjectId): string {
  return `project:${projectId}:instructions`;
}

function instructionsRef(projectId: ProjectId): ContextRef {
  return {
    source: 'projectInstructions',
    id: instructionsRefId(projectId),
    // `ContextRef.title` is documented as the user's own text — the name of
    // their file or their rule. Project instructions are a database column with
    // no name of their own, so a fixed label is the honest answer rather than
    // inventing one out of the body's first line.
    title: 'Project instructions',
    // Nothing has counted them. Never substitute a zero: a budget computed from
    // a guessed zero silently overruns the context window.
    estimatedTokens: null,
  };
}

export function createProjectContextResolver(
  projectId: ProjectId,
  read: ProjectInstructionsReader,
): ContextResolver {
  return {
    async index(): Promise<readonly ContextRef[]> {
      const instructions = await read(projectId);
      // An empty column is not a ref: an index entry the caller preloads and
      // that loads to an empty string is prompt material that says nothing,
      // reported as though it said something.
      if (instructions === null || instructions === '') return [];
      return [instructionsRef(projectId)];
    },
    async load(ref: ContextRef): Promise<ContextChunk | null> {
      if (ref.source !== 'projectInstructions') return null;
      if (ref.id !== instructionsRefId(projectId)) return null;
      const instructions = await read(projectId);
      if (instructions === null || instructions === '') return null;
      return { ref, text: instructions };
    },
  };
}
