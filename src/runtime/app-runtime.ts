/**
 * The runtime the application actually runs on, composed over one adapter.
 *
 * `harness-runtime.ts` ties the knot between the directory and the services a
 * run is handed; it takes those services as arguments and holds no adapter. This
 * file is the one place that supplies them from the host, and it exists because
 * the alternative — every caller assembling its own — is how two surfaces end up
 * with two directories and a run that only one of them can see.
 *
 * **Built once, at `src/app/App.tsx`, and passed down.** Conventions §4 and the
 * contract's own note on `HarnessRuntime` both say the same thing and for the
 * same reason: not a module singleton, because a test has to be able to
 * substitute one. A component that is handed no runtime offers no agent run —
 * which is the state a surface mounted on its own in a test is in.
 *
 * ## What `readProjectInstructions` reads, and what it does not
 *
 * It reads `project_get`, which is on `COMMAND_ALLOWLIST` in
 * `src/platform/contract.ts` and answers a `ProjectView` whose `instructions` is
 * the text the user typed — the exact route `src/platform/contract-harness.ts`
 * names for the `projectInstructions` source. Both hosts answer it:
 * `src-tauri/src/ipc/project.rs` and `BrowserAdapter`.
 *
 * **The paragraph that stood here said the opposite**, and was false when it was
 * written or shortly after: it claimed the allowlist had no command that reads a
 * project, and on that basis returned `null` for every project. One line
 * therefore emptied the whole layer below it — `createProjectContextResolver`
 * indexed nothing, a caller's `preload` came back empty, and no run ever carried
 * a user's project instructions. It is corrected rather than deleted because the
 * shape of the mistake is the thing worth keeping: a comment that justified the
 * stub outlived the reason for it, and nothing re-read it.
 *
 * What is still not served is the other two `ContextSource` arms. That is a
 * statement about this runtime, **not** about the allowlist: `skills_read`
 * answers a skill's `body` and `memory_list` answers a scope's entries, so both
 * arms are buildable. `createProjectContextResolver` serves neither, and says so
 * itself; whoever builds them extends that resolver rather than this line.
 *
 * **This implementation never answers `null`, and a failed read rejects.**
 * `ProjectView.instructions` is a `string` whose empty value is `''`, so there
 * is no project the read succeeds for and answers nothing about. The rejection
 * is the load-bearing half: a reader that swallowed its own failure into `null`
 * would make `index()` return no ref at all, and the run would then proceed with
 * no project material and *nothing said about it* — the silent reduction
 * conventions §9 forbids. Rejecting hands the decision to
 * `createProjectContextResolver`, which turns it into a `contextUnavailable`
 * degradation the user can see. `ProjectInstructionsReader` in
 * `project-context.ts` is where that is written down.
 */

import { createProjectsRepository } from '@/data/projects-repository';
import { createTranscriptRepository } from '@/data/transcript-repository';
import { createTurnDriver } from '@/data/turn-driver';
import type { PlatformAdapter } from '@/platform/adapter';
import type { HarnessRuntime, LiveRuns, RunRequest, ToolExecutor } from '@/platform/contract-harness';

import { createHarnessRuntime } from './harness-runtime';
import { createSubagentToolkit } from './subagent-toolkit';

/**
 * A top-level run may spawn subagents; those subagents may not.
 *
 * One level is what the shipped tool catalogue can be reasoned about: a user who
 * asked one question gets at most one fan-out, and the transcript they are shown
 * is the one they asked for plus the work it delegated. Deeper nesting is a
 * budget question — every level multiplies the runs a single turn can start —
 * and this is the number to raise once there is a surface that shows the tree.
 */
export const MAX_SUBAGENT_DEPTH = 1;

/**
 * Where a subagent's transcript goes.
 *
 * `SubagentToolkitOptions.newConversationId` leaves this to the composition
 * root, and there are only two candidates: a real conversation, or a synthetic
 * id. A synthetic id does not work — `store_append_message` resolves the
 * conversation before it writes, in the host and in `BrowserAdapter` alike, so
 * the child's first turn would fail its append and take the child down as a
 * `harnessFault` before its first token. So it is a real conversation, and the
 * user can open it and read what their subagent actually did.
 */
function subagentConversationTitle(index: number): string {
  return `Subagent ${String(index)}`;
}

export function createAgentRuntime(adapter: PlatformAdapter): HarnessRuntime {
  const projects = createProjectsRepository(adapter);
  const toolkit = createSubagentToolkit({
    maxDepth: MAX_SUBAGENT_DEPTH,
    // Derived from the parent so a child run id says where it came from, and
    // unique because the counter the toolkit keeps is per toolkit and this
    // toolkit is per runtime.
    newRunId: (parentRunId, index) => `${parentRunId}.${String(index)}`,
    newConversationId: async (_parentConversationId, index) => {
      const created = await adapter.invoke('store_create_conversation', {
        title: subagentConversationTitle(index),
      });
      return created.conversation.id;
    },
  });

  return createHarnessRuntime({
    turns: createTurnDriver(adapter),
    // Two methods of it, narrowed by the parameter type: a harness gets `append`
    // and `update` and never `list` or `remove`.
    transcript: createTranscriptRepository(adapter),
    toolsFor: (request: RunRequest, runs: LiveRuns): ToolExecutor =>
      toolkit.toolsFor(request, runs),
    // Deliberately unguarded by a `catch`: see the header. A rejection here is
    // the resolver's to turn into a degradation, and swallowing it would make
    // an unreadable project indistinguishable from an empty one.
    readProjectInstructions: async (projectId) => (await projects.get(projectId)).instructions,
  });
}
