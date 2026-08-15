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
 * ## What is honestly missing, named rather than faked
 *
 * `readProjectInstructions` answers `null` for every project. That is not a
 * placeholder standing in for something that exists: `COMMAND_ALLOWLIST` in
 * `src/platform/contract.ts` has no command that reads a project, so there is
 * nothing to call. `createProjectContextResolver` therefore indexes nothing, a
 * caller's `preload` comes back empty, and no run is degraded for material it
 * was never promised. The seam is a function precisely so that the day a project
 * command lands, this line changes and nothing else does.
 */

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
    readProjectInstructions: () => Promise.resolve(null),
  });
}
