/**
 * A `ContextResolver` over one project's instructions, and nothing else.
 *
 * It indexes exactly one source — `projectInstructions` — and returns nothing
 * for `skill` or `memory`. That is a statement about this file and not about the
 * allowlist, and the difference matters because the previous version of this
 * paragraph got it wrong in both directions. `skills_read` in
 * `src/platform/contract.ts` answers a skill's `body`, and `memory_list` answers
 * a scope's entries, so both of the other arms are buildable; they are simply
 * not built here, and a resolver that returned refs for them would be returning
 * refs it cannot load.
 *
 * The instructions themselves are read through an injected function rather than
 * an adapter, which keeps this file testable without a host. **It is not
 * because there is no host call to make**: `project_get` is on
 * `COMMAND_ALLOWLIST`, `src/runtime/app-runtime.ts` supplies a reader over it,
 * and the sentence that used to stand here saying otherwise is why every run in
 * the product went without its project's instructions.
 *
 * ## A read that fails is not a project with nothing to say
 *
 * The two must not collapse into one answer, and the whole of the failure
 * behaviour below follows from that.
 *
 * If a failed read produced an empty index, a broken `project_get` would look
 * exactly like a project the user has written no instructions for: the run
 * starts, carries none of the material the user typed, and says nothing about
 * it. That is the silent reduction conventions §9 forbids, and it is worse here
 * than elsewhere because the user's own words are what went missing.
 *
 * So a failed read is carried forward instead of being answered: {@link index}
 * still mints this project's one ref, and {@link load} answers `null` for it.
 * `null` is the path `contract-harness.ts` defines — the harness emits a
 * `contextUnavailable` degradation and the run continues — which is exactly the
 * report wanted, and it is reached without this file rejecting (a rejecting
 * resolver fails the whole run with `contextResolverFailed`, which is a chat the
 * user cannot have for a reason they cannot see).
 *
 * **The cost, stated rather than hidden.** A read that fails at `index` and then
 * succeeds-and-is-empty at `load` reports `contextUnavailable` for material that
 * was never there. That is an over-report, it is reachable only after a genuine
 * host failure, and it is the side to be wrong on: the alternative is under-
 * reporting a user's instructions as though they had never written them.
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
 * Reads a project's instructions. `null` for a project that has none.
 *
 * **A reader that cannot read must reject, not answer `null`.** The two are
 * different facts and this resolver treats them differently — see the header —
 * so a reader with its own `catch` returning `null` would silently disarm the
 * degradation path. `app-runtime.ts` supplies one that rejects.
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
      let instructions: string | null;
      try {
        instructions = await read(projectId);
      } catch {
        // Not `[]`, and not a rethrow. See the header: an empty index would
        // make a broken read look like a project with nothing written in it,
        // and a rethrow would fail the run rather than degrade it. The ref goes
        // out, `load` answers `null` for it, and the run says so.
        return [instructionsRef(projectId)];
      }
      // An empty column is not a ref: an index entry the caller preloads and
      // that loads to an empty string is prompt material that says nothing,
      // reported as though it said something.
      if (instructions === null || instructions === '') return [];
      return [instructionsRef(projectId)];
    },
    async load(ref: ContextRef): Promise<ContextChunk | null> {
      if (ref.source !== 'projectInstructions') return null;
      if (ref.id !== instructionsRefId(projectId)) return null;
      let instructions: string | null;
      try {
        instructions = await read(projectId);
      } catch {
        // The `contextUnavailable` path, deliberately. `load` is documented to
        // answer `null` for material that has gone, and material that cannot be
        // read is material this resolver cannot supply; the harness reports it
        // either way, which is the outcome that matters.
        return null;
      }
      if (instructions === null || instructions === '') return null;
      return { ref, text: instructions };
    },
  };
}
